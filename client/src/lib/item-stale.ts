import { daysSince } from './item-age';
import { isInProgress } from './item-progress';
import type { BacklogItem } from '../../../shared/types';

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
 * 1. **`updated` first, `created` as the fallback.** `updated` is stamped by
 *    every `start` and every `stop` (see the invariant in CLAUDE.md), so it is
 *    the honest "last touched". Every file written before that key existed has
 *    none, and for those the creation date is the only evidence there is. That
 *    fallback is why the first load after this ships moves genuinely old,
 *    never-touched items to Archive — the correct answer, and one the release
 *    note has to say out loud because it will look abrupt.
 * 2. **An unparseable or absent pair is FRESH, not stale.** A malformed file is
 *    a thing to go and fix, and the way anyone notices it is that it is still
 *    on the board. Vanishing it into Archive would hide the one item that most
 *    needs looking at, and the item would then be invisible in both surfaces
 *    until someone thought to go looking in a directory.
 * 3. **In progress outranks any date arithmetic.** `started` means someone is
 *    on it right now; whatever the stamp says, "nobody has touched this in six
 *    weeks" is then simply false. Sequenced BEFORE the parse rather than folded
 *    in afterwards so no arithmetic can override it.
 *
 * `status === 'open'` is the fourth condition, and the one that is easy to
 * miss: staleness is about work that is waiting and being neglected. A done
 * item is not neglected, it is finished, and a rejected one is closed —
 * neither belongs in Archive's stale half (Archive holds rejections in a
 * column of their own, on the strength of the rejection and not of any date),
 * and a done item still has to be reachable through the Board's own `Done`
 * status filter however old it is. Answering "stale" for either would remove
 * it from the only surface that shows it.
 */
export function isStale(item: BacklogItem, windowDays: number, now: number = Date.now()): boolean {
  if (item.status !== 'open') return false;
  if (isInProgress(item)) return false;

  const stamp = item.updated !== '' ? item.updated : item.created;
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
  item: BacklogItem, windowDays: number, now: number = Date.now()
): boolean {
  return item.section !== 'tasks' && isStale(item, windowDays, now);
}
