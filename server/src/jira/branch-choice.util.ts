import { branchCarriesKey, branchNameProblem, worktreePathFor } from '../../../shared/jira-branch';
import type { JiraAction, JiraRepoRefs, JiraWorkspace } from '../../../shared/types';

/**
 * branch-choice.util.ts — the branch choice `GET /api/jira/prompt` and `POST /api/agents/dispatch-jira` both take (Jira repo/branch, spec §5.3): what is
 * asked, validated once for both routes, and what the server re-checks against the repo's refs before the prompt is composed.
 *
 * Two halves, kept apart because they fail differently. `parseBranchChoice` is SHAPE — it reads no file and no repo, so it runs before the configured check
 * and its refusals are 400s, wrong whatever the environment. `resolveWorkspace` is STATE — it compares the choice with the refs one git read just produced, and
 * its refusals are 409s: the request was well formed and the repository disagrees (the sheet's own list can be minutes old, and `jira.mjs worktree` re-checks
 * the same two rules on the host, because the server cannot always read the repo).
 */

/**
 * The choice, with the fields that do not belong to a mode absent from its type rather than carried as `null`s. `target` is `null` for "the MR goes to the
 * base".
 */
export type JiraBranchChoice =
  | { mode: 'none' }
  | { mode: 'new'; branch: string; base: string; openMr: boolean }
  | { mode: 'continue'; branch: string; openMr: boolean; target: string | null };

/**
 * The five flat fields as a route hands them over. `unknown` throughout: the query gives strings (and an array for a repeated parameter), the body gives
 * whatever JSON held, and a field of the wrong type is a refusal here, not a cast at the call site. `null` counts as absent, so a client that serialises its
 * unused fields as `null` is not refused for them.
 */
export interface JiraBranchChoiceRaw {
  mode?: unknown;
  branch?: unknown;
  base?: unknown;
  openMr?: unknown;
  target?: unknown;
}

export type JiraBranchChoiceParse = { ok: true; value: JiraBranchChoice } | { ok: false; error: string };

const absent = (value: unknown): boolean => value === undefined || value === null;

/**
 * One name field's shape: a string that passes Table A, else the sentence `<field> <problem>`. A present value that is not a string is `<field> is required`
 * — nothing was supplied that could be a name — while an empty string is Table A's own `is empty`.
 */
function nameProblem(field: string, value: unknown, notAString: string): string | null {
  if (typeof value !== 'string') return notAString;
  const problem = branchNameProblem(value);
  return problem === null ? null : `${field} ${problem}`;
}

/**
 * `raw` validated for `key` and `action`, the refusals in the order the spec lists them and the first hit winning — so a request wrong in two ways always
 * says the same sentence. `execute` is the one action that needs a branch: `none` is the "work in the mapped checkout" mode, and an execute with no worktree
 * would commit on whatever the checkout holds. `openMr` rides the query as `'true'`/`'false'` and the body as a boolean; absent is `false`.
 */
export function parseBranchChoice(raw: JiraBranchChoiceRaw, key: string, action: JiraAction): JiraBranchChoiceParse {
  const fail = (error: string): JiraBranchChoiceParse => ({ ok: false, error });
  const mode = raw.mode;
  if (mode !== 'new' && mode !== 'continue' && mode !== 'none') return fail('mode must be new, continue or none');
  if (action === 'execute' && mode === 'none') return fail('execute needs a branch (mode new or continue)');
  if (mode === 'none' && !absent(raw.branch)) return fail('branch is not for mode none');

  let branch = '';
  if (mode !== 'none') {
    const problem = nameProblem('branch', raw.branch, 'branch is required');
    if (problem !== null) return fail(problem);
    branch = raw.branch as string;
  }

  let base = '';
  if (mode === 'new') {
    const problem = nameProblem('base', raw.base, 'base is required for a new branch');
    if (problem !== null) return fail(problem);
    base = raw.base as string;
  } else if (!absent(raw.base)) {
    return fail('base is only for a new branch');
  }

  if (mode === 'new' && !branchCarriesKey(branch, key)) return fail(`branch must carry ${key}`);

  let openMr = false;
  if (!absent(raw.openMr)) {
    if (raw.openMr === true || raw.openMr === 'true') openMr = true;
    else if (raw.openMr !== false && raw.openMr !== 'false') return fail('openMr must be true or false');
  }
  if (openMr && (action !== 'execute' || mode === 'none')) return fail('openMr is only for execute with a branch');

  let target: string | null = null;
  if (!absent(raw.target)) {
    if (!(openMr && mode === 'continue')) return fail('target is only for openMr with continue');
    const problem = nameProblem('target', raw.target, 'target is required');
    if (problem !== null) return fail(problem);
    target = raw.target as string;
  }

  if (mode === 'none') return { ok: true, value: { mode } };
  if (mode === 'new') return { ok: true, value: { mode, branch, base, openMr } };
  return { ok: true, value: { mode, branch, openMr, target } };
}

export type JiraWorkspaceResolution = { ok: true; workspace: JiraWorkspace | null } | { ok: false; status: 409; error: string };

/**
 * The workspace `choice` names in `repo`, or the 409 the repository's refs make of it (spec §5.3). The two refusals need refs the server could READ: with
 * `available: false` there is nothing to compare against, so none is made and the tool's own re-check on the host is the guard — and the expected worktree is
 * then the conventional path.
 *
 * A branch another worktree already holds is NOT a refusal: the session enters that tree, so the expected path is the one the refs found — any tree but the
 * mapped repo's own, which `continue` has already ruled out by name (`mainBranch`) and which the path compare guards a second time. The conventional path is
 * for a branch no tree holds. `key` is the ticket's, kept in the signature so a refusal can name it later without every caller changing; nothing reads it
 * today.
 */
export function resolveWorkspace(choice: JiraBranchChoice, _key: string, repo: string, refs: JiraRepoRefs): JiraWorkspaceResolution {
  if (choice.mode === 'none') return { ok: true, workspace: null };
  const { branch } = choice;
  if (refs.available) {
    if (choice.mode === 'new' && refs.branches.some((b) => b.name === branch)) {
      return { ok: false, status: 409, error: `${branch} exists — switch to Continue` };
    }
    if (choice.mode === 'continue' && refs.mainBranch === branch) {
      return { ok: false, status: 409, error: `${branch} is checked out in the mapped checkout ${repo}` };
    }
  }
  const held = refs.available ? (refs.branches.find((b) => b.name === branch)?.worktree ?? null) : null;
  const worktree = held !== null && held !== repo ? held : worktreePathFor(repo, branch);
  if (choice.mode === 'new') return { ok: true, workspace: { mode: 'new', branch, base: choice.base, worktree, openMr: choice.openMr, target: null } };
  return { ok: true, workspace: { mode: 'continue', branch, base: null, worktree, openMr: choice.openMr, target: choice.target } };
}
