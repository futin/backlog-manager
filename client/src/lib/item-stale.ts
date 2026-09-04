import { daysSince } from './item-age';
import { isInProgress } from './item-progress';
import { lastTouched } from './item-touched';
import { runHoldsItem } from '../../../shared/agent';
import type { BacklogItem, OrchestratorRunsPayload } from '../../../shared/types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * item-stale.ts — the one implementation of "has nobody touched this in a
 * while", which is what decides Board versus Archive.
 *
 * Its own module beside item-age.ts and item-progress.ts rather than a
 * predicate inlined into BoardView, because BoardView is only one of the two
 * readers: Archive (Task 6) asks the same question from the other side and
 * must get the same answer, or an item can fall out of both surfaces at once
 * — or show up in both — which is precisely the failure a derived split has
 * to rule out.
 *
 * The same-shape neighbours are deliberate: item-age.ts owns "how old is this
 * date", item-progress.ts owns "is anyone on it", and this file owns only the
 * comparison between an age and the window. It delegates both halves rather
 * than re-parsing dates or re-reading `started`.
 *
 * **Two sources, not one.** This module used to be a pure function of the item
 * file, and that framing was wrong rather than merely narrow (bug-11): a
 * `backlog-orchestrate` run works each item inside its own git worktree and
 * stamps `started:`/`phase:` on THAT copy, so the copy the registry points at
 * — the one `/api/items` scans and both surfaces render — is silent for the
 * whole run. An item a run had just picked up was therefore still "nobody has
 * touched this in ninety days" by the file's own reckoning, and the one card
 * the run strip and the column rank exist to point at was the one card not on
 * the Board. So both predicates here now take the run payload as well, and
 * `runHoldsItem` (shared/agent.ts) is the second half of the in-progress
 * exemption they already had. Neither surface pays anything for it: both
 * already hold that payload for their dispatch controls and their run strip.
 */

/**
 * The two shapes a frontmatter stamp can have on disk — the same permanent
 * fork item-age.ts documents on `started`, for the same reason: `start`/`stop`
 * write a second-precision UTC timestamp, every file stamped before they did
 * carries a bare date, and nothing rewrites an existing item's frontmatter.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole days since a stamp of either shape, or null when it is not a value
 * this can age at all (empty, or anything Date.parse rejects).
 *
 * A bare date is aged in WHOLE DAYS via `daysSince`, never by millisecond
 * difference. `2026-08-02` is not "30 days and 12 hours ago" — it is a day,
 * and the hours between UTC midnight and now belong to the clock, not to the
 * file. Comparing its midnight against a millisecond window would push an
 * item over the edge partway through the day it became exactly window-old,
 * on a value that never claimed that precision in the first place. A real
 * timestamp does carry the hour, so it is aged exactly and only floored at
 * the end — a stamp four hours past the window is a full window plus four
 * hours old, not `30d`, and it is the fractional part that makes "one second
 * outside the window" a state this predicate can actually see.
 */
function ageInDays(stamp: string, now: number): number | null {
  if (DATE_ONLY.test(stamp)) return daysSince(stamp, now);

  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return null;
  // Clamped at 0 for the reason daysSince clamps: a future stamp is a
  // hand-edited file, and "touched just now" is the closest true thing to say
  // about one. Nothing here should read a typo as six months of neglect.
  return Math.max(0, now - then) / MS_PER_DAY;
}

/**
 * Has this item gone quiet — nobody has touched it inside the window?
 *
 * Three rules, each of which exists to stop an item disappearing for a reason
 * that is not neglect:
 *
 * 1. **`updated ?? lastCommit ?? created`**, the precedence `lastTouched`
 *    owns (item-touched.ts). The git rung is there because `updated` has one
 *    writer and the item file has several editors — without it, an item
 *    groomed five days ago aged off the Board on a five-week-old `created`.
 * 2. **An unparseable or absent pair is FRESH, not stale.** A malformed file is
 *    a thing to go and fix, and the way anyone notices it is that it is still
 *    on the board. Vanishing it into Archive would hide the one item that most
 *    needs looking at, and the item would then be invisible in both surfaces
 *    until someone thought to go looking in a directory.
 * 3. **Live work outranks any date arithmetic** — where "live" is the file
 *    saying someone is on it, OR a fresh run saying so. `started` covers a
 *    hand-run session; `runHoldsItem` covers an orchestrator run, which cannot
 *    write to the file this predicate reads (see the module header). Whichever
 *    of the two answers yes, "nobody has touched this in six weeks" is simply
 *    false whatever the stamp says. Sequenced BEFORE the parse rather than
 *    folded in afterwards so no arithmetic can override either half.
 *
 *    A run holds the item at every stage but its five true exits — including
 *    `pending`, so starting a whole-queue run pulls every stale queued item
 *    back onto the Board at once, and including `parked`/`needs-answers`,
 *    where the run has stopped and is waiting for a person. Both are the
 *    correct answer to the question this predicate asks: a queued item is
 *    claimed work rather than neglected work, and an item asking a human a
 *    question is the last card that should leave the human's surface. They
 *    return to Archive when the run exits them at `failed`/`skipped`/
 *    `ungroomed`; a merged one is in `done/` and stale to nobody.
 *
 * `status === 'open'` is the fourth condition, and the one that is easy to
 * miss: staleness is about work that is waiting and being neglected. A done
 * item is not neglected, it is finished, and a rejected one is closed —
 * neither belongs in Archive's stale half (Archive holds rejections in a
 * column of their own, on the strength of the rejection and not of any date),
 * and a done item still has to be reachable through the Board's own `Done`
 * status filter however old it is. Answering "stale" for either would remove
 * it from the only surface that shows it.
 *
 * **`runs` is required and has no `[]` default, and that is the load-bearing
 * part of bug-11's fix rather than a style preference.** A default is exactly
 * what would let the next caller — a third surface, a future filter — read
 * this predicate the old one-source way and reintroduce the bug silently,
 * with nothing but a code review standing between it and an item that
 * vanishes off the board while a run works it. The compiler asking every
 * caller "which run payload?" is the whole value of the change; `[]` is
 * always available to a caller that genuinely has none, and writing it is a
 * decision rather than an omission. `now` lost its own `Date.now()` default
 * in the same edit, for the plain reason that a required parameter cannot
 * follow an optional one — no caller ever omitted it (both surfaces read a
 * `useNow`, every test pins a fixed instant), so nothing changed but the
 * signature.
 */
export function isStale(
  item: BacklogItem,
  windowDays: number,
  now: number,
  runs: OrchestratorRunsPayload['runs']
): boolean {
  if (item.status !== 'open') return false;
  if (isInProgress(item) || runHoldsItem(item, runs)) return false;

  const stamp = lastTouched(item);
  if (stamp === '') return false;

  const age = ageInDays(stamp, now);
  if (age === null) return false;
  // Strictly greater: an item exactly `windowDays` old is still inside a
  // window described as "touched within the last 30 days".
  return age > windowDays;
}

/**
 * Does this item leave the Board — the exact question BoardView's filter asks,
 * and the one Archive (Task 6) asks inverted for its stale half.
 *
 * Staleness plus the one exemption: **a task never leaves.** A task is
 * committed work — it was groomed, planned and accepted — so one rotting for
 * six weeks is a fact to be made to look at, not one to tidy away. It keeps
 * its column and gains a `stale` marker instead (ItemCard's own `stale` prop),
 * which is why this and `isStale` are two functions rather than one: the card
 * needs the plain staleness answer for a task that this function deliberately
 * keeps on the board.
 */
export function leavesBoard(
  item: BacklogItem,
  windowDays: number,
  now: number,
  runs: OrchestratorRunsPayload['runs']
): boolean {
  return item.section !== 'tasks' && isStale(item, windowDays, now, runs);
}
