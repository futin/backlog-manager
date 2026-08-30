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
