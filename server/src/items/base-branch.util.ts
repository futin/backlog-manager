import { spawnSync } from 'node:child_process';
import { HttpException } from '@nestjs/common';

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
 * Uncoded 400s, messages pinned by test/base-branch.test.ts and
 * test/uncommitted.test.ts.
 */
export function resolveBaseBranch(base: unknown, projectPath: string | undefined): string {
  if (base === undefined || base === '' || base === 'main') return 'main';
  // Echoed back truncated and JSON-quoted, the convention resolveIds,
  // resolveMergeMode and resolveQuestionMode all share. JSON.stringify also
  // renders a non-string (a `42` a Partial-typed body cannot rule out) as
  // `42` rather than `"42"`, which a template interpolation would not.
  const shown = JSON.stringify(typeof base === 'string' ? base.slice(0, 40) : base);
  if (typeof base !== 'string' || base.startsWith('-')) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a valid branch name` }, 400);
  }
  if (spawnSync('git', ['check-ref-format', '--branch', base]).status !== 0) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a valid branch name` }, 400);
  }
  if (projectPath === undefined || spawnSync('git', ['-C', projectPath, 'show-ref', '--verify', '--quiet', `refs/heads/${base}`]).status !== 0) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a branch in this project` }, 400);
  }
  return base;
}
