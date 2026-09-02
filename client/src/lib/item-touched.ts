import type { BacklogItem } from '../../../shared/types';

/**
 * item-touched.ts — which stamp answers "when was this last touched".
 *
 * Its own module because two derivations read it and must not disagree:
 * `isStale` decides Board versus Archive, `monthKey` groups Archive's columns,
 * and each held its own copy of the two-rung rule before this existed.
 *
 * Three rungs, `updated ?? lastCommit ?? created`:
 *
 * 1. `updated` — stamped by `start`/`stop`, the file's own account of itself.
 * 2. `lastCommit` — git's account. Exists because rung 1 has one writer while
 *    the file has several editors: a groom session that writes Cause and Fix
 *    through the editor without running `start --as groom` leaves `updated`
 *    absent, and an item groomed five days ago then aged off the Board on a
 *    `created` date five weeks old.
 * 3. `created` — all that's left for an uncommitted or non-git item, where it
 *    is also the honest answer.
 *
 * Precedence is on PRESENCE, not parseability: a present-but-malformed
 * `updated` still wins, and the caller then sees a stamp it can't age. That is
 * deliberate — both readers treat an unageable stamp as fresh, so a broken
 * file stays on the Board where someone will fix it.
 */
export function lastTouched(item: BacklogItem): string {
  if (item.updated !== '') return item.updated;
  if (item.lastCommit !== '') return item.lastCommit;
  return item.created;
}
