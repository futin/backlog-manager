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
 * No freshness window, matching `backlog.mjs start`'s own rule that ANY stamp
 * refuses, fresh or stale: a stamp nobody is behind is a lie the board should
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
export function progressBlock(item: BacklogItem): string | null {
  if (!isInProgress(item)) return null;
  return `a session is already working this item (${progressLabel(item)} since ${item.started})`;
}
