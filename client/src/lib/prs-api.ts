import { errorOf, postJson } from './http';
import type { PrAutoMergeRequest, PrMergeRequest, PrUpdateBranchRequest, PrWriteOutcome, PrWriteResult, PullRequestsPayload } from '../../../shared/types';

/**
 * The GitHub › PRs page's four calls (`.claude/DESIGN.md` §8.11), one fetch helper each and nothing else: no state, no polling (`hooks/usePullRequests.ts`
 * owns when a read happens). Every failure is an `Error` whose message is the server's own `{ error }` sentence VERBATIM (`errorOf`), falling back to the
 * status only when the body carries none — the server already says "this PR was merged by someone else" or "sync is off for futin/x — …" in words a person
 * can act on, and a client that paraphrased them would be a second place deciding what a refusal means.
 *
 * `GET /api/prs` reads the server's on-demand cache, which is why a token-less or sync-off answer is a 200 payload and not an error: only a registry the
 * server cannot read (503) or a network failure lands here.
 */

async function readError(res: Response, fallback: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => null);
  return new Error(errorOf(body, fallback));
}

function isPayload(data: unknown): data is PullRequestsPayload {
  return (
    typeof data === 'object' && data !== null && typeof (data as { token?: unknown }).token === 'boolean' && Array.isArray((data as { repos?: unknown }).repos)
  );
}

export async function fetchPullRequests(): Promise<PullRequestsPayload> {
  const res = await fetch('/api/prs');
  if (!res.ok) throw await readError(res, `could not read pull requests (${res.status})`);
  const data: unknown = await res.json().catch(() => null);
  if (!isPayload(data)) throw new Error('unexpected /api/prs response');
  return data;
}

/** Every outcome the server answers. A `Record` over the union, so a new outcome in `shared/types.ts` fails the typecheck here until it is listed. */
const OUTCOMES: Record<PrWriteOutcome, true> = {
  merged: true,
  'already-merged': true,
  'auto-merge-enabled': true,
  'auto-merge-disabled': true,
  noop: true,
  'update-requested': true
};

/** A write's success body, checked as far as the page reads it: `outcome` is one it has a word for. A proxy's HTML page on a 200, or any body that is not
 *  ours, would otherwise reach `outcomeLine` as a garbage outcome and draw an empty line where a refusal belongs. */
function isWriteResult(body: unknown): body is PrWriteResult {
  if (typeof body !== 'object' || body === null) return false;
  const outcome = (body as { outcome?: unknown }).outcome;
  return typeof outcome === 'string' && Object.prototype.hasOwnProperty.call(OUTCOMES, outcome);
}

async function write(path: string, request: PrMergeRequest | PrAutoMergeRequest | PrUpdateBranchRequest, verb: string): Promise<PrWriteResult> {
  const res = await postJson(path, request);
  if (!res.ok || !isWriteResult(res.body)) throw new Error(errorOf(res.body, `${verb} failed (${res.status})`));
  return res.body;
}

export const mergePr = (body: PrMergeRequest): Promise<PrWriteResult> => write('/api/prs/merge', body, 'merge');
export const setAutoMerge = (body: PrAutoMergeRequest): Promise<PrWriteResult> => write('/api/prs/auto-merge', body, 'auto-merge');
export const updateBranch = (body: PrUpdateBranchRequest): Promise<PrWriteResult> => write('/api/prs/update-branch', body, 'update branch');
