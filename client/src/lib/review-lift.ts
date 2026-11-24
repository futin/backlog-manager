import type { ItemHeld } from '../../../shared/types';

/**
 * review-lift.ts — the Lift review confirmation's sentence, from what `GET /api/items/held` answered (the in-review-without-PR spec). Its one home, so the
 * four readings cannot drift apart between the component and anything that later words the same fact.
 *
 * `held` is `'pending'` while the read is out and `'failed'` when it was refused or never answered. A present worktree wins over a branch git could not be
 * asked about: the tree is a plain directory check that cannot fail, so `{ branch: null, tree: true }` is a known hold, not an unknown. "Not found" says what
 * it cannot see — uncommitted work in some other checkout, or another machine's — because a person reading it is deciding whether work may be lost.
 */
export type HeldReading = ItemHeld | 'pending' | 'failed';

export function reviewLiftText(id: string, held: HeldReading): string {
  const n = id.replace(/^#/, '');
  if (held === 'pending') return `Checking this machine for execute/${n}…`;
  if (held !== 'failed' && (held.branch === true || held.tree)) {
    return `execute/${n} still holds work for ${id} on this machine — push it and open a PR instead. Lift anyway?`;
  }
  if (held !== 'failed' && held.branch === false) {
    return `No execute/${n} branch or worktree here. Work left uncommitted in a checkout, or on another machine, does not show up — lift only once you know it is gone or pushed.`;
  }
  return `Could not check this machine for execute/${n}. Lift only once you know the work is gone or pushed.`;
}
