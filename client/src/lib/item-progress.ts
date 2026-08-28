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
