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
 * A third caller, `POST /api/agents/dispatch`'s execute `finish: 'pr'`, uses the stricter `proveBaseBranch` below (no `'main'` carve-out, for the reason its
 * doc comment gives); the checks themselves still live in that one function.
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
 * A third check since #343, ahead of git: the base must match `BASE_BRANCH_SHAPE` below. A base that passes here does not stay a git argument — it is composed
 * into a spawn prompt and pasted, unquoted, into the driver's shell templates (`pull --ff-only origin <base>`, `push origin <base>`, `gh pr create --base
 * <base>`). `check-ref-format --branch` is a statement about refs, not about shells: measured, it accepts `feat$(id)`, `a;b`, a backtick, both quotes, `&`,
 * `|`, `<`, `>`, `!`, `#` and `{}`. So the shape is an ALLOWLIST — the set `tick.mjs` already holds its own `--base` to — rather than a denylist of
 * metacharacters, which is wrong the first time it misses one.
 *
 * Uncoded 400s, messages pinned by test/base-branch.test.ts and
 * test/uncommitted.test.ts.
 */

/**
 * The characters a base may contain (#343): letters, digits, `.`, `_`, `/` and `-`, never leading with `-`. No shell expands or splits a string made of only
 * these, so every base that can reach a template is inert there. Byte-equal with two hand copies that must stay equal to it: `REF_SHAPE` in
 * `skills/backlog-tick/tools/tick.mjs` and `BASE_SHAPE` in `skills/backlog-orchestrate/tools/orchestrate.mjs` (a skill tool cannot import from the server).
 * Exported for `AgentsService.branches`, so the picker never offers a base the launch would refuse.
 */
export const BASE_BRANCH_SHAPE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;
export async function resolveBaseBranch(base: unknown, projectPath: string | undefined): Promise<string> {
  if (base === undefined || base === '' || base === 'main') return 'main';
  return proveBaseBranch(base, projectPath);
}

/**
 * The same proof as `resolveBaseBranch` — the same checks, in the same order, with the same 400 messages — minus its `'main'` carve-out and its
 * absent/empty default: every value, `'main'` included, is asked of git, and `undefined` or `''` is the "not a valid branch name" 400. `POST
 * /api/agents/dispatch`'s execute `finish: 'pr'` is the caller.
 *
 * The carve-out is right for orchestrate and wrong here for one reason: orchestrate appends NOTHING at `'main'`, so no caller text reaches the prompt and a
 * repo whose trunk is named something else keeps working. An execute under `pr` ALWAYS spells `--base <base>` out (`finishClause`), `main` included, so an
 * unproved `'main'` in a `master`-trunk repo would send a session off to open a PR into a branch that does not exist. Here the value is always appended, so
 * it is always proved.
 *
 * `resolveBaseBranch` delegates its post-carve-out half to this function rather than the two repeating the checks, so a branch one route accepts is never
 * one the other would refuse for a different reason.
 */
export async function proveBaseBranch(base: unknown, projectPath: string | undefined): Promise<string> {
  // Echoed back truncated and JSON-quoted, the convention resolveIds,
  // resolveMergeMode and resolveQuestionMode all share. JSON.stringify also
  // renders a non-string (a `42` a Partial-typed body cannot rule out) as
  // `42` rather than `"42"`, which a template interpolation would not.
  const shown = JSON.stringify(typeof base === 'string' ? base.slice(0, 40) : base);
  // `''` is refused here rather than by the shape check below, so it keeps the plain message it had when check-ref-format was the one refusing it.
  if (typeof base !== 'string' || base === '' || base.startsWith('-')) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a valid branch name` }, 400);
  }
  // Before check-ref-format, so git is never spawned with a string that would be refused anyway — see the header comment for why git's own check is not it.
  if (!BASE_BRANCH_SHAPE.test(base)) {
    throw new HttpException(
      { error: `base must be an existing local branch — ${shown} is not a valid branch name (only letters, digits, . _ / - are allowed)` },
      400
    );
  }
  if ((await runGit(['check-ref-format', '--branch', base])) === null) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a valid branch name` }, 400);
  }
  if (projectPath === undefined || (await runGit(['-C', projectPath, 'show-ref', '--verify', '--quiet', `refs/heads/${base}`])) === null) {
    throw new HttpException({ error: `base must be an existing local branch — ${shown} is not a branch in this project` }, 400);
  }
  return base;
}
