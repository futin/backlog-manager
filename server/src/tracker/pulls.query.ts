import { MERGE_METHODS, type MergeMethod, type PullRequestRow } from '../../../shared/types';
import { GithubClient, refuseRepo, type GithubResponse, type GraphqlError } from './github.client';

/**
 * The PRs page's GraphQL (spec 2026-10-29-source-sections-design.md, "PR list freshness"): the list query, the single-PR query, the two auto-merge
 * mutations, and `toRow`, the one mapping from a GraphQL PR node to `PullRequestRow`.
 *
 * GraphQL rather than REST because the list is ONE request per repo — REST needs a request per PR for its mergeable state, its checks and its review, and
 * the review decision is GraphQL-only anyway. The REST writes (merge, update-branch) are not here; they are `GithubClient` methods like every other REST
 * call. Everything in this file goes through `GithubClient.graphql`, so the one-host rule, the rate bookkeeping and "nothing throws" are the client's and
 * hold here without a second copy.
 *
 * `repo` is checked with `isRepo` BEFORE the owner/name split, as the REST writes check theirs: a malformed one answers `status: 0` and makes no request.
 * The split values travel as GraphQL variables, never interpolated into query text.
 *
 * One partial answer is an answer here, and only one: a FORBIDDEN on `statusCheckRollup`. A fine-grained token without `Checks: Read-only` and
 * `Commit statuses: Read-only` reads a private repo's PRs in full and is refused that one field, per PR, with the rest of the answer whole — so the reads
 * below keep the list, mark each refused PR's checks `unknown` (never `none`: the commit may well have checks) and carry GitHub's sentence as
 * `checksDetail`, for the Access card to show beside the permissions that fix it. Any other error, or that one beside any other, fails the read as before:
 * the tolerance is `checksRefusal`'s, one function, and it is an error's path and type that qualify it, never its sentence.
 */

/** The fields of one PR every query here selects, shared so the list and the single read can never disagree about what a row is. `commits(last: 1)` is
 *  the head commit — the one whose rollup is the PR's checks. */
const PR_FIELDS = `
  number
  title
  url
  isDraft
  headRefName
  headRefOid
  baseRefName
  isCrossRepository
  maintainerCanModify
  updatedAt
  mergeable
  mergeStateStatus
  reviewDecision
  viewerCanUpdateBranch
  author { login }
  autoMergeRequest { mergeMethod enabledAt }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

/**
 * Open PRs of one repo, newest update first, at most 100 — GitHub's page maximum, and one page on purpose: the page draws what fits and says how many it
 * left out (`totalCount`), rather than paginating a list nobody scrolls. The repo's merge settings ride along (one request, not two), because the page
 * offers only the methods the repo allows and disables auto-merge on a repo that has it off.
 */
export const PR_LIST_QUERY = `query PullRequests($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    squashMergeAllowed
    mergeCommitAllowed
    rebaseMergeAllowed
    autoMergeAllowed
    pullRequests(first: 100, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {${PR_FIELDS}}
    }
  }
}`;

/** One PR in ANY state — a write's re-read must see `MERGED` to tell "already merged" from a failure — plus its node `id`, which the auto-merge
 *  mutations take and which never leaves the server. */
export const PR_ONE_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      state${PR_FIELDS}
    }
  }
}`;

export const ENABLE_AUTO_MERGE = `mutation EnableAutoMerge($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) {
    pullRequest { id }
  }
}`;

export const DISABLE_AUTO_MERGE = `mutation DisableAutoMerge($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
    pullRequest { id }
  }
}`;

/** A PR node as the queries above select it. Every enum is a plain `string`: GitHub owns those lists, and `toRow` maps what it knows and falls back on
 *  what it does not, rather than a type pretending the list is closed. */
export interface GqlPullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  viewerCanUpdateBranch: boolean;
  author: { login: string } | null;
  autoMergeRequest: { mergeMethod: string; enabledAt: string | null } | null;
  commits: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] } | null;
}

interface GqlListData {
  repository: {
    squashMergeAllowed: boolean;
    mergeCommitAllowed: boolean;
    rebaseMergeAllowed: boolean;
    autoMergeAllowed: boolean;
    pullRequests: { totalCount: number; nodes: (GqlPullRequest | null)[] };
  } | null;
}

interface GqlOneData {
  repository: { pullRequest: (GqlPullRequest & { id: string; state: string }) | null } | null;
}

/** One repo's list read, parsed: the rows, how many open PRs the repo has in all (more than `rows.length` means the page was cut at 100), and the repo's
 *  merge settings, which Task 3's cache turns into the offered methods and the auto-merge switch. */
export interface PullList {
  rows: PullRequestRow[];
  totalCount: number;
  squashMergeAllowed: boolean;
  mergeCommitAllowed: boolean;
  rebaseMergeAllowed: boolean;
  autoMergeAllowed: boolean;
  /** GitHub's sentence for the `statusCheckRollup` this token may not read, when the read was answered that way (every such row's `checks` is `unknown`);
   *  `null` when every rollup was delivered. The one partial answer these reads keep — see the file comment. */
  checksDetail: string | null;
}

/** One PR's read, parsed. `id` (the node id) and `state` sit beside the row, not in it, because neither is something the page draws: `id` is the
 *  auto-merge mutation's argument and never leaves the server, and `state` is how a write tells a merged PR from an open one. */
export interface PullOne {
  id: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  row: PullRequestRow;
  /** As `PullList.checksDetail`, for this one PR: GitHub's sentence when its rollup was refused (and `row.checks` is `unknown`), else `null`. */
  checksDetail: string | null;
}

/** `owner/name` → the query's two variables. Only ever called after `refuseRepo` passed it, so the split is of a string `isRepo` already accepted. */
function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  return { owner, name };
}

/** The one field whose refusal these reads survive: the head commit's `statusCheckRollup`, the last step of every error path that is about it. */
const CHECKS_FIELD = 'statusCheckRollup';

/**
 * GitHub's sentence when `res` is the one partial answer these reads keep, else `null`: the client restated a FORBIDDEN (`status` 403), the repository
 * itself was delivered, and EVERY error is a FORBIDDEN whose path ends at `statusCheckRollup`. One error of any other kind, or on any other field, fails
 * the read as a whole — a repo the token cannot see arrives as a FORBIDDEN at `['repository']`, and that must stay the 403 it is. The first message is the
 * detail: GitHub repeats one sentence per refused PR.
 */
function checksRefusal(res: GithubResponse<{ repository: unknown }>): string | null {
  const errors = res.errors ?? [];
  if (res.status !== 403 || res.data?.repository == null || errors.length === 0) return null;
  const onChecks = errors.every((e) => e.type === 'FORBIDDEN' && Array.isArray(e.path) && e.path[e.path.length - 1] === CHECKS_FIELD);
  return onChecks ? (errors[0]?.message ?? 'checks not readable by this token') : null;
}

/** The list indices the refused paths name — `['repository', 'pullRequests', 'nodes', i, …]`'s fourth step. The nodes are read in GitHub's order, nulls
 *  kept in place, so an index is exactly the PR whose rollup was refused. */
function refusedIndices(errors: GraphqlError[] | undefined): Set<number> {
  const indices = new Set<number>();
  for (const e of errors ?? []) {
    const at = e.path?.[3];
    if (typeof at === 'number') indices.add(at);
  }
  return indices;
}

/** Read one repo's open PRs. Never throws; a malformed repo is `status: 0` with no request made. */
export async function readPullList(client: GithubClient, repo: string, opts: { token: string }): Promise<GithubResponse<PullList>> {
  const bad = refuseRepo<PullList>(repo, client.graphqlRate);
  if (bad !== null) return bad;
  const res = await client.graphql<GqlListData>(PR_LIST_QUERY, splitRepo(repo), opts);
  // Refused checks are the one error this read keeps (file comment): the answer is whole but for those fields, so it is read as the success it nearly is.
  const checksDetail = checksRefusal(res);
  if (checksDetail === null && (res.error !== null || res.status !== 200)) return { ...res, data: null };
  const r = res.data?.repository ?? null;
  // GitHub answers a repo it cannot see with a NOT_FOUND error (already a 404 above); a 200 with no repository is the same fact said less precisely.
  if (r === null) return { ...res, status: 404, data: null, error: `repository ${repo} not found` };
  const refused = checksDetail === null ? new Set<number>() : refusedIndices(res.errors);
  return {
    ...res,
    status: 200,
    error: null,
    data: {
      // Indexed before the null filter: the refused paths count GitHub's nodes, nulls included.
      rows: r.pullRequests.nodes.flatMap((n, i) => (n === null ? [] : [toRow(n, refused.has(i))])),
      totalCount: r.pullRequests.totalCount,
      squashMergeAllowed: r.squashMergeAllowed,
      mergeCommitAllowed: r.mergeCommitAllowed,
      rebaseMergeAllowed: r.rebaseMergeAllowed,
      autoMergeAllowed: r.autoMergeAllowed,
      checksDetail
    }
  };
}

/** Read one PR in any state. Never throws; a malformed repo or a non-positive number is `status: 0` with no request made. */
export async function readPull(client: GithubClient, repo: string, number: number, opts: { token: string }): Promise<GithubResponse<PullOne>> {
  const bad = refuseRepo<PullOne>(repo, client.graphqlRate);
  if (bad !== null) return bad;
  // The same refusal shape as a bad repo — a value, no request — with its own sentence.
  if (!Number.isInteger(number) || number < 1) {
    return { status: 0, data: null, etag: null, next: null, retryAfter: null, secondary: false, error: `not a pull request number: ${number}`, rate: client.graphqlRate };
  }
  const res = await client.graphql<GqlOneData>(PR_ONE_QUERY, { ...splitRepo(repo), number }, opts);
  // The same one tolerated error as the list's; here every refused path is this PR's.
  const checksDetail = checksRefusal(res);
  if (checksDetail === null && (res.error !== null || res.status !== 200)) return { ...res, data: null };
  const pr = res.data?.repository?.pullRequest ?? null;
  if (pr === null) return { ...res, status: 404, data: null, error: `pull request ${repo}#${number} not found` };
  const state = pr.state === 'MERGED' || pr.state === 'CLOSED' ? pr.state : 'OPEN';
  return { ...res, status: 200, error: null, data: { id: pr.id, state, row: toRow(pr, checksDetail !== null), checksDetail } };
}

/** Arm (`enable`) or disarm auto-merge on the PR whose node id `readPull` returned. `method` is required to arm and ignored to disarm. GitHub's refusal —
 *  auto-merge off on the repo, a PR already clean to merge — comes back as a 200 with `error` set, which the caller shows verbatim. */
export async function setAutoMerge(
  client: GithubClient,
  id: string,
  change: { enable: true; method: MergeMethod } | { enable: false },
  opts: { token: string }
): Promise<GithubResponse<unknown>> {
  return change.enable
    ? client.graphql<unknown>(ENABLE_AUTO_MERGE, { id, method: change.method.toUpperCase() }, opts)
    : client.graphql<unknown>(DISABLE_AUTO_MERGE, { id }, opts);
}

const MERGEABLE: Record<string, PullRequestRow['mergeable']> = { MERGEABLE: 'mergeable', CONFLICTING: 'conflicting', UNKNOWN: 'unknown' };
const REVIEW: Record<string, NonNullable<PullRequestRow['review']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required'
};
/** `StatusState`: `ERROR` is a check that could not run, which blocks a merge exactly as a failure does; `EXPECTED` is a required check that has not
 *  reported yet, which is waiting, not failed. */
const CHECKS: Record<string, PullRequestRow['checks']> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending'
};

/**
 * A GraphQL PR node → the row the page draws. Each field is one of GitHub's, renamed or narrowed — nothing combines two, so a row can always be read back
 * against GitHub's own view of the PR. An enum value this file does not know falls back to the reading that claims least: `unknown` mergeability, no review
 * decision, checks `pending` (present but not known to pass), and an armed auto-merge whose method is unrecognised reads as `merge`.
 *
 * `checksRefused` is the reader's knowledge, not the node's: a refused `statusCheckRollup` arrives as the same `null` a commit without checks has, and
 * only the error path beside the answer tells them apart. With it the row reads `unknown` — the commit may well have checks this token cannot see — and
 * never `none`, which the page would draw as "nothing to wait for". Passed explicitly by both reads; never `.map(toRow)`, whose index would land here.
 */
export function toRow(node: GqlPullRequest, checksRefused = false): PullRequestRow {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const auto = node.autoMergeRequest;
  const method = auto === null ? null : (MERGE_METHODS.find((m) => m === auto.mergeMethod.toLowerCase()) ?? 'merge');
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? null,
    draft: node.isDraft,
    head: node.headRefName,
    headSha: node.headRefOid,
    base: node.baseRefName,
    crossRepository: node.isCrossRepository,
    maintainerCanModify: node.maintainerCanModify,
    updatedAt: node.updatedAt,
    mergeable: MERGEABLE[node.mergeable] ?? 'unknown',
    mergeState: node.mergeStateStatus.toLowerCase(),
    review: node.reviewDecision === null ? null : (REVIEW[node.reviewDecision] ?? null),
    checks: rollup !== null ? (CHECKS[rollup.state] ?? 'pending') : checksRefused ? 'unknown' : 'none',
    autoMerge: auto === null || method === null ? null : { method, enabledAt: auto.enabledAt ?? '' },
    // GitHub's own answer (verified against the public schema, 2026-10-29): false when the head is already up to date OR this token cannot update it.
    canUpdateBranch: node.viewerCanUpdateBranch
  };
}
