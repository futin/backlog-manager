import { claimReading } from './tracker';
import type { BacklogItem } from '../../../shared/types';

/**
 * Whether an item is live work in progress right now.
 *
 * Two conditions, not one, and the second is the non-obvious one: `started`
 * outlives the work. `move` never rewrites an item's content, so an archived
 * file (done, or terminal after a groom rejects it) keeps the date it was
 * picked up as history — worth having, and exactly why the date alone cannot
 * mean "live", or every item ever shipped would read as in progress forever.
 * `status === 'open'` is what tells the two states apart.
 */
export function isInProgress(item: BacklogItem): boolean {
  return item.status === 'open' && item.started !== '';
}

/**
 * Whether somebody is on this item right now (#227): `isInProgress`, minus a tracker claim that has gone stale by `now`.
 *
 * Two predicates rather than one widened, because they answer different questions and both are still asked. `isInProgress` is "does a claim stand" — the
 * item modal's facts, `leavesBoard`/`isStale` (an item with ANY unreleased claim keeps its place on the board, where the release control is) and
 * `progressLabel` all want that. This is "is it being worked": the column rank, the Status filter's "In progress" and the card's live bar read it, since a
 * claim nobody has heartbeated for `CLAIM_STALE_MS` is litter the protocol retires at the next `start`, and drawing it as work in flight is what left #15
 * untouched for a day. A files item has no `holder`, so `claimReading` is `null` for it and this is `isInProgress` exactly — its "ANY stamp" rule stands.
 */
export function isLiveWork(item: BacklogItem, now: number): boolean {
  return isInProgress(item) && claimReading(item, now) !== 'stale';
}

/**
 * The live bar's words: which activity is actually happening, not just the
 * bare fact that something is. `phase` names the skill currently holding the
 * item — `backlog-groom` or `backlog-execute` — so the bar can say `grooming`
 * or `executing` instead of a generic `in progress` that leaves the reader to
 * go open the drawer to find out which.
 *
 * `''` is not an error case folded in as a default: it is the honest answer
 * for an item started before Task 4 added the `phase` key at all, and for a
 * malformed value on disk that BacklogItem already clamps to `''` on the way
 * in (see shared/types.ts). Either way there is nothing to name, so the old
 * generic wording is exactly right rather than a placeholder.
 *
 * Deliberately re-derives `isInProgress` rather than trusting a caller to
 * have already gated on it: every caller in this codebase renders the label
 * only behind that gate today, but this function's own answer for a done or
 * terminal item has to be the inert one regardless of that discipline. `move`
 * never rewrites an item's content, so a done item can still carry
 * `phase: 'groom'` on disk as history from whatever session last held it —
 * and claiming "grooming" for an archived item would be a lie no caller
 * should be able to trigger by forgetting to check first.
 */
export function progressLabel(item: BacklogItem): string {
  if (!isInProgress(item)) return 'in progress';
  if (item.phase === 'groom') return 'grooming';
  if (item.phase === 'execute') return 'executing';
  return 'in progress';
}

/**
 * Why dispatching this item is forbidden right now because a local skill
 * session already holds it, or null.
 *
 * The third per-item dispatch block, and the only one derived from the item
 * file itself. `dispatchGate` reads the `AgentsStatus` payload and
 * `runClaimBlock` reads the run payload — both answer questions the item file
 * cannot. This one is the opposite: `started:` is written by `backlog.mjs
 * start` and cleared by `stop`, so the claim is right there in the
 * frontmatter, and `isInProgress` has been deriving it for the card's amber
 * bar all along. Nothing ever wired that predicate into the dispatch path, so
 * the board rendered the bar and an enabled dispatch button on the same card:
 * one telling the reader a session holds this item, the other offering to
 * start a second one against it (bug-12).
 *
 * It lives here rather than in `shared/agent.ts` beside `runClaimBlock`, whose
 * shape it deliberately mirrors: the two predicates it is built from are
 * already in this module, `shared/` must not import from `client/`, and
 * hoisting the pair over there would be a move made for a block the server has
 * no use for — its dispatch route re-scans the item file itself and is
 * unchanged by this.
 *
 * No freshness window for a FILES item, matching `backlog.mjs start`'s own rule that ANY stamp
 * refuses, fresh or stale (a tracker claim does have one since #227 — see the branch below): a stamp nobody is behind is a lie the board should
 * not paper over, and `stop` is the one-command fix for it. What keeps an
 * ancient stamp from blocking forever is `isInProgress`'s status half — an
 * archived item's stamp is history, not a claim.
 *
 * The parenthetical is what varies, exactly as `runClaimBlock` varies its
 * stage, so one sentence stays grammatical across all three `progressLabel`
 * answers including the bare `in progress` fallback. The stamp goes in
 * verbatim rather than humanised: it is literally what is on disk, which is
 * what someone greps the item file for when they want to know whose marker
 * this is.
 */
export function progressBlock(item: BacklogItem, now: number): string | null {
  if (!isInProgress(item)) return null;
  /* #227 — a stale TRACKER claim is the one stamp that does not block, because the protocol already lets any `start`, on any machine, retire it with no
     confirm: the spawned session's own `start` does exactly that, and the dispatch sheet names the claim being taken over (`staleTakeover`). Two holders
     keep the block even stale. A run-held claim falls through to the sentence below — a stale run claim is a crashed run, which the watchdog and
     `--resume` own. A board-dispatched one gets its own sentence, because a `claude -p` waiting on a reply has no process and sends no heartbeat, so
     staleness alone says nothing about it; the way out is the modal's Stop & release. A files item has no `holder`, so none of this reaches it. */
  const holder = item.holder;
  if (holder !== undefined && holder.run === undefined && claimReading(item, now) === 'stale') {
    return holder.dispatched === true ? `the board's own session ${holder.session} holds this item — Stop & release it first` : null;
  }
  return `a session is already working this item (${progressLabel(item)} since ${item.started})`;
}
