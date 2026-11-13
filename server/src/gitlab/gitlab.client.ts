import { gitlabProjectId } from './remote.util';
import type { RawDiscussion } from './review.util';

/**
 * A thin, read-only client over `fetch` for the four GitLab REST endpoints this app reads: `GET /user`, `GET /projects/:id/merge_requests`,
 * `GET /projects/:id/merge_requests/:iid` (spec §4) and `GET /projects/:id/merge_requests/:iid/discussions` (CodeRabbit review spec §4.3). Its own file with no Nest decorators and no dependency beyond `fetch`, the shape of `JiraClient`, so a
 * test can drive every failure branch (a 3xx, a 429 window, a deadline) over `FakeGitlab.fetch` — branches a live GitLab can never be asked to schedule.
 * Nothing here throws on an HTTP status; every failure is a value the caller branches on.
 *
 * Rules this file holds so its callers do not have to:
 *
 * 1. **A redirect is never followed.** Every call passes `redirect: 'manual'`. `follow` would replay `PRIVATE-TOKEN` to wherever `Location` points, and
 *    the bare `gitlab.timify.io` answers 301 to exactly such a place; `error` would throw a TypeError that hides the code the board row needs. So a 3xx — or
 *    undici's `opaqueredirect` (status 0, type `opaqueredirect`), which `manual` can return instead — is `status: 0`, `redirect refused (<code>)`.
 * 2. **Pages are requested by number**, `page=N` on a URL this file built — never by following a `Link`/`next` header, which would be a server-chosen URL
 *    carrying the token.
 * 3. **The token sits in one header and nowhere else** — `PRIVATE-TOKEN`, built in `request`, never in a URL, a log or a message. A `message` here is GitLab's
 *    own sentence, the transport error's, or ours.
 * 4. **Every call carries a deadline** — a `setTimeout` plus an `AbortController`, raced against the call, not `AbortSignal.timeout` (which fires off a timer
 *    fake timers never advance and words the failure its own way).
 */

/** The bound on every call, the same ten seconds `runGit` and `JiraClient` use: a GitLab that does not answer in that time is `unreachable`. */
export const GITLAB_TIMEOUT_MS = 10_000;

/** GitLab's maximum page size; the sweep pages by number past it. */
export const GITLAB_PER_PAGE = 100;

/** What `fetch` is to this file. Exported so the test fake is typed by the same shape; `typeof fetch` would also demand `fetch`'s static members. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One response, normalised. `status` is `0` for no HTTP answer (transport failure, deadline) AND for a refused 3xx — in which case `message` is
 * `redirect refused (<code>)`. `message` for a non-2xx is GitLab's `message`/`error` field when it sent one, else `null`; `retryAfter` is seconds.
 */
export interface GitlabResponse<T> {
  status: number;
  data: T | null;
  message: string | null;
  retryAfter: number | null;
}

/** The subset of GitLab's merge-request JSON the state builder reads. */
export interface RawMr {
  iid: number;
  title: string;
  web_url: string;
  state: string;
  draft?: boolean;
  source_branch: string;
  target_branch: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  head_pipeline?: { status: string } | null;
}

export interface MrQuery {
  state: 'opened' | 'merged' | 'closed';
  updatedAfter?: string;
  page: number;
}

export class GitlabClient {
  /** `fetch` by default; a fake in tests, injected through the constructor so two suites can never share one. */
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  currentUser(site: string, token: string): Promise<GitlabResponse<{ username: string; name: string }>> {
    return this.request(site, token, '/user');
  }

  listMergeRequests(site: string, token: string, projectPath: string, q: MrQuery): Promise<GitlabResponse<RawMr[]>> {
    const params = new URLSearchParams({ state: q.state });
    if (q.updatedAfter !== undefined) params.set('updated_after', q.updatedAfter);
    params.set('order_by', 'updated_at');
    params.set('sort', 'desc');
    params.set('per_page', String(GITLAB_PER_PAGE));
    params.set('page', String(q.page));
    return this.request(site, token, `/projects/${gitlabProjectId(projectPath)}/merge_requests?${params.toString()}`);
  }

  mergeRequest(site: string, token: string, projectPath: string, iid: number): Promise<GitlabResponse<RawMr>> {
    return this.request(site, token, `/projects/${gitlabProjectId(projectPath)}/merge_requests/${iid}`);
  }

  /** One page of an MR's discussions, `page=N` by number like every other read here; the poller stops at `GITLAB_REVIEW_PAGES` pages (review spec §4.3). */
  mergeRequestDiscussions(site: string, token: string, projectPath: string, iid: number, page: number): Promise<GitlabResponse<RawDiscussion[]>> {
    return this.request(site, token, `/projects/${gitlabProjectId(projectPath)}/merge_requests/${iid}/discussions?per_page=${GITLAB_PER_PAGE}&page=${page}`);
  }

  /** The one place a request is made: builds the URL (always `https://<site>/api/v4`), puts the token in its header and a deadline on the call. */
  private async request<T>(site: string, token: string, path: string): Promise<GitlabResponse<T>> {
    const url = `https://${site}/api/v4${path}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced, so a `fetch` that never looks at its signal still ends; aborting as well lets a real `fetch` release its socket.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${GITLAB_TIMEOUT_MS} ms`));
      }, GITLAB_TIMEOUT_MS);
    });
    type Got = { status: number; type: string; text: string; retryAfter: number | null };
    const call = (async (): Promise<Got> => {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'backlog-manager', 'PRIVATE-TOKEN': token },
        redirect: 'manual',
        signal: controller.signal
      });
      const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
      return {
        status: res.status,
        type: res.type,
        // A refused redirect's body is never read: it is not ours to interpret.
        text: redirected ? '' : await res.text(),
        retryAfter: numberHeader(res.headers.get('retry-after'))
      };
    })();
    // If the deadline wins, the call may still reject later (the abort); that rejection has no reader and must not surface as an unhandled one.
    call.catch(() => undefined);

    let got: Got;
    try {
      got = await Promise.race([call, deadline]);
    } catch (e) {
      return { status: 0, data: null, message: transportMessage(e), retryAfter: null };
    } finally {
      clearTimeout(timer);
    }

    if (got.type === 'opaqueredirect' || (got.status >= 300 && got.status < 400)) {
      // An opaque redirect hides its code (status 0); the text still has to name one, so it says `redirect` bare there.
      const code = got.status === 0 ? '' : ` (${got.status})`;
      return { status: 0, data: null, message: `redirect refused${code}`, retryAfter: null };
    }

    let parsed: unknown = null;
    if (got.text !== '') {
      try {
        parsed = JSON.parse(got.text);
      } catch {
        parsed = null;
      }
    }
    if (got.status >= 200 && got.status < 300) return { status: got.status, data: parsed as T | null, message: null, retryAfter: got.retryAfter };
    return { status: got.status, data: null, message: errorMessage(parsed), retryAfter: got.retryAfter };
  }
}

/** GitLab's own sentence: `{"message":"401 Unauthorized"}` or `{"error":"insufficient_scope"}`; `message` may be an object for a 400, which is no sentence. */
function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { message?: unknown; error?: unknown };
  if (typeof b.message === 'string' && b.message !== '') return b.message;
  if (typeof b.error === 'string' && b.error !== '') return b.error;
  return null;
}

function transportMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause: unknown = e.cause;
  if (!(cause instanceof Error)) return e.message;
  const code = (cause as { code?: unknown }).code;
  const reason = cause.message !== '' ? cause.message : typeof code === 'string' ? code : '';
  return reason === '' ? e.message : `${e.message}: ${reason}`;
}

function numberHeader(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  // Never negative: a `retry-after: -5` would otherwise put the 429 window in the past.
  return Number.isFinite(n) && n >= 0 ? n : null;
}
