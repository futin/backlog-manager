import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ItemHeld } from '../../../shared/types';
import { runGit } from '../git-run.util';

/**
 * held.util.ts — what THIS machine still holds for tracker issue `n` under the names an in-place execute leaves: a local `execute/<n>` branch and a
 * `.worktrees/execute-<n>` directory (the in-review-without-PR spec). `GET /api/items/held` is its one caller, and the board's Lift review confirmation is
 * that route's one reader: before a person removes `in-review` from an issue no open PR references, it says whether unpushed work may still sit here.
 *
 * It reports and never decides. `executeHeldBlock` (`agents/execute-held.util.ts`) reads the same two names for a FILES item and refuses a dispatch on them;
 * a tracker item's guard is its label, so here a leftover branch only changes the sentence the confirmation shows, and Lift stays enabled in every state.
 *
 * The branch probe is `for-each-ref` over the one exact ref, never `show-ref --verify --quiet`: that answers "absent" with exit 1, which `runGit` cannot tell
 * from a failure, and the two must not read the same here — `false` tells a person their work is gone, while `null` (a timeout, a project that is not a
 * repository, git missing) is "could not check", which the confirmation words differently. `for-each-ref` exits 0 either way: empty output is absent.
 * An exact ref also keeps `execute/2140` from holding item 214. The tree probe is a plain `existsSync`, which cannot fail in a way worth reporting.
 *
 * Per request and memoised nowhere, for `executeHeldBlock`'s reason: a branch deleted a second ago has to read as gone on the next open.
 */
export async function localHold(projectPath: string, n: number): Promise<ItemHeld> {
  const tree = existsSync(join(projectPath, '.worktrees', `execute-${n}`));
  const refs = await runGit(['-C', projectPath, 'for-each-ref', '--format=%(refname)', `refs/heads/execute/${n}`]);
  const branch = refs === null ? null : refs.trim() !== '';
  return { branch, tree };
}
