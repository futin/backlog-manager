import { HttpException } from '@nestjs/common';

import { runGit } from '../git-run.util';

/**
 * base-branch.util.ts — the one proof that a caller-supplied base names an
 * existing local branch of one project, shared by the two routes that take a
 * base: `POST /api/agents/orchestrate` (task-44, `AgentsService.resolveBase`,
 * whose doc comment carries the reasoning for both checks and their order)
 * and `GET /api/items/uncommitted` (#254, which has to ask its question at
 * the same ref the run will gate at, or the sheet's note flags the wrong rows).
 *
 * One copy rather than two because the two routes answer one question about
 * one value: the sheet sends the same `base` to both, so a branch one route
 * accepted and the other refused would be the sheet disagreeing with itself.
 *
 * `projectPath` is the REGISTRY entry's path, or `undefined` for a project the
 * registry does not hold — resolved by the caller, never here, so this module
 * never touches a caller-supplied path. An unregistered project has no
 * branches, so every non-default base then gets the same honest refusal.
 *
 * Absent, `''` and `'main'` short-circuit to `'main'` without asking git —
 * see `resolveBase` for why that is load-bearing rather than an optimisation
 * (the sheet sends `base` on every request, `'main'` included, and a repo
 * whose trunk is named something else must keep working).
 *
 * Async since #277: both git checks go through `runGit`, so a slow repository
 * delays this route instead of freezing the process. A TIMEOUT on either check
 * is a failed check — the same refusal a missing branch gets — because the
 * caller cannot prove the base exists, and an unproven base must never reach a
 * prompt. The `'main'` carve-out above still answers without asking git.
 *
 * Uncoded 400s, messages pinned by test/base-branch.test.ts and
 * test/uncommitted.test.ts.
 */
export async function resolveBaseBranch(base: unknown, projectPath: string | undefined): Promise<string> {
  if (base === undefined || base === '' || base === 'main') return 'main';
  // Echoed back truncated and JSON-quoted, the convention resolveIds,
  // resolveMergeMode and resolveQuestionMode all share. JSON.stringify also
  // renders a non-string (a `42` a Partial-typed body cannot rule out) as
  // `42` rather than `"42"`, which a template interpolation would not.
  const shown = JSON.stringify(typeof base === 'string' ? base.slice(0, 40) : base);
  if (typeof base !== 'string' || base.startsWith('-')) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a valid branch name` }, 400);
  }
  if ((await runGit(['check-ref-format', '--branch', base])) === null) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a valid branch name` }, 400);
  }
  if (projectPath === undefined || (await runGit(['-C', projectPath, 'show-ref', '--verify', '--quiet', `refs/heads/${base}`])) === null) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a branch in this project` }, 400);
  }
  return base;
}
