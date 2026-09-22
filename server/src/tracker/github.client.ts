/**
 * A thin client over `fetch` for the two dozen lines of GitHub's REST API this
 * app uses (task-45, spec §5.1). Its own file, no Nest decorators and no
 * injected dependencies, so a test can construct one with a fake `fetch` and
 * drive every branch without standing a module up — which matters because the
 * branches that are hard to reach are the failure ones (rate limits, secondary
 * limits, a 304), and those are exactly the ones a live-network test can never
 * schedule.
 *
 * Three rules this file holds and its callers therefore do not have to:
 *
 * 1. **One constant host.** `API` below is the only host any request here can
 *    reach; nothing in a request shape names a host, and `repo` is validated
 *    (`isRepo`) before it is interpolated into a path. Spec §11: the server
 *    now holds a credential, so "where can this call go" has to be answerable
 *    by reading one file.
 * 2. **Every response's rate-limit headers are recorded**, including a `304`'s
 *    and a failure's. A `304` costs no budget, but it still REPORTS the
 *    budget, and the Trackers card's "4,812 of 5,000 left" would otherwise
 *    freeze at whatever the last changed poll happened to see.
 * 3. **Nothing here throws on an HTTP status.** Every response comes back as a
 *    value the caller branches on, because every one of them is a state the
 *    board renders (`forbidden`, `not-found`, `rate-limited`) rather than an
 *    exception a request handler should turn into a 500. A transport failure —
 *    DNS, a dropped socket — is the one exception and it is caught here too,
 *    surfacing as `status: 0` with the message in `error`.
 */

/** The one host this client can reach. Not configurable on purpose (spec §11). */
export const API = 'https://api.github.com';

/** `owner/name`, each side GitHub's own allowed character set. Validated
 *  before interpolation, never after: a repo string reaches this process from
 *  a marker file someone committed, which is not a trusted input just because
 *  it is not a request body. */
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function isRepo(value: unknown): value is string {
  return typeof value === 'string' && REPO.test(value);
}

/** What the client saw in the last response's rate-limit headers. `null` for
 *  every field until the first response, and after one that carried none. */
export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds, as GitHub sends it. */
  reset: number | null;
}

/**
 * One response, normalised. `data` is `null` for a `304` (there is no body)
 * and for any status the caller is expected to branch on rather than read.
 */
export interface GithubResponse<T> {
  /** HTTP status, or `0` for a transport failure. */
  status: number;
  data: T | null;
  etag: string | null;
  /** The `Link` header's `rel="next"` URL, or `null` — how this API paginates. */
  next: string | null;
  /** `Retry-After` in seconds, when the response carried one. */
  retryAfter: number | null;
  /** A secondary (abuse) rate limit rather than the hourly one; spec §5.1
   *  gives it its own 60-second backoff, so it needs its own bit. */
  secondary: boolean;
  /** The transport error's message, for `status: 0`. */
  error: string | null;
  rate: RateLimit;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GithubClient {
  /** The last rate-limit headers seen, from ANY response — see rule 2 above. */
  private lastRate: RateLimit = { limit: null, remaining: null, reset: null };

  /** `fetch` by default; a fake in tests. Injected through the constructor
   *  rather than monkey-patched globally so two suites can never share one. */
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  get rate(): RateLimit {
    return { ...this.lastRate };
  }

  /**
   * The authenticated user, for the Trackers card's platform row. `null` data
   * on any non-200, which the card renders as the access state it already has
   * — a login it cannot fetch is not a second kind of failure.
   */
  async viewer(token: string): Promise<GithubResponse<{ login: string }>> {
    return this.request<{ login: string }>('GET', `${API}/user`, { token });
  }

  /**
   * One page of issues, newest-last. `state=all` because a closed issue is a
   * `done` or `terminal` item rather than a gone one; `sort=updated` with
   * `direction=asc` so the last row of the last page carries the newest
   * `updated_at` — which is the high-water mark the next poll sends as
   * `since`. `per_page=100` is GitHub's maximum and the reason a poll of a
   * normal backlog is one request.
   */
  async issues(repo: string, opts: { token: string; since?: string | null; etag?: string | null }): Promise<GithubResponse<GithubIssue[]>> {
    const query = `state=all&per_page=100&sort=updated&direction=asc${opts.since ? `&since=${encodeURIComponent(opts.since)}` : ''}`;
    return this.request<GithubIssue[]>('GET', `${API}/repos/${repo}/issues?${query}`, opts);
  }

  /**
   * One page of the repo's issue comments — every comment in the repo, not one
   * issue's, which is what makes watching claims cheap on the board's read path
   * (task-46): one request covers every issue, and an EDIT moves `updated_at`
   * too, so a claim comment that is rewritten in place still comes back.
   *
   * Nothing read the result in phase 2. The call was made anyway, deliberately
   * (spec §5.1) — the alternative would have been changing the polling loop's
   * shape, its rate-limit budget and its tests all at once, in the phase that
   * also introduced the protocol they feed. That bet paid: task-46 added
   * `TrackerPollerService.comments()` over this cache and moved nothing here.
   *
   * The PROTOCOL does not read this. It reads `issueComments` below, per issue
   * and fresh, because a claim posted a second ago has to be visible to the
   * session deciding who won and no cache can promise that.
   */
  async comments(repo: string, opts: { token: string; since?: string | null; etag?: string | null }): Promise<GithubResponse<GithubComment[]>> {
    const query = `per_page=100&sort=updated&direction=asc${opts.since ? `&since=${encodeURIComponent(opts.since)}` : ''}`;
    return this.request<GithubComment[]>('GET', `${API}/repos/${repo}/issues/comments?${query}`, opts);
  }

  /** The repo's existing labels, for the bootstrap's "create only what is
   *  missing" (spec §5.2). */
  async labels(repo: string, opts: { token: string }): Promise<GithubResponse<{ name: string }[]>> {
    return this.request<{ name: string }[]>('GET', `${API}/repos/${repo}/labels?per_page=100`, opts);
  }

  /** Phase 2's ONE write to GitHub. A 422 means the label already exists —
   *  another machine's poller won the race — which is a success for a
   *  bootstrap whose whole contract is idempotence, and the poller treats it
   *  as one. */
  async createLabel(repo: string, label: { name: string; color: string; description: string }, opts: { token: string }): Promise<GithubResponse<unknown>> {
    return this.request<unknown>('POST', `${API}/repos/${repo}/labels`, { ...opts, body: label });
  }

  /** The next page of a paginated read, by the URL GitHub's own `Link` header
   *  gave — never a page number this client computed. Following the server's
   *  cursor is what keeps pagination correct while rows are being updated
   *  underneath it. */
  async page<T>(url: string, opts: { token: string }): Promise<GithubResponse<T>> {
    return this.request<T>('GET', url, opts);
  }

  /* ---------------------------------------------------------------------
   * The write half (task-46, spec §6.2).
   *
   * Nine methods, each one request, each keeping this file's three rules: the
   * one constant host, the rate headers recorded from every response, and
   * nothing thrown on a status. That last rule is what the writer seam above
   * this file depends on — every refusal it reports (`not-found`, `conflict`,
   * `rate-limited`) is a status this client handed back as a value.
   *
   * `repo` is checked by `isRepo` before it is interpolated, in EVERY one of
   * them. The reads above are called only from the poller and the adapter,
   * both of which validate first; these are called from a request handler with
   * a `project` a caller named, so the check moves into the one place it can
   * never be forgotten. A repo that fails it answers `status: 0` and makes no
   * request at all — a value, exactly like a transport failure, rather than a
   * throw that would be the one exception to rule 3.
   * ------------------------------------------------------------------- */

  /** A new issue. 201 with the created issue; the `labels` array is what
   *  carries the section (`type:*`), a refactor's `kind:*` and `runner-fix`. */
  async createIssue(repo: string, fields: { title: string; body: string; labels: string[] }, opts: { token: string }): Promise<GithubResponse<GithubIssue>> {
    const bad = refuseRepo<GithubIssue>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<GithubIssue>('POST', `${API}/repos/${repo}/issues`, { ...opts, body: fields });
  }

  /**
   * A partial update of one issue. Every field this app ever patches, in one
   * method rather than five: `state`/`state_reason` close it, `body` is
   * groom's rewrite, `assignees` is the claim protocol's, `labels` is a
   * wholesale replacement nothing currently uses (the label verbs below are
   * the additive ones). A caller sends only the keys it means.
   */
  async updateIssue(
    repo: string,
    number: number,
    patch: { state?: string; state_reason?: string | null; body?: string; assignees?: string[]; labels?: string[] },
    opts: { token: string }
  ): Promise<GithubResponse<GithubIssue>> {
    const bad = refuseRepo<GithubIssue>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<GithubIssue>('PATCH', `${API}/repos/${repo}/issues/${number}`, { ...opts, body: patch });
  }

  /** One issue, fresh off the network rather than out of the poller's cache —
   *  the `body` route's whole reason for existing. Optimistic concurrency needs
   *  the issue's `updated_at` AS IT IS NOW, and the cache is up to one poll
   *  interval old, so a cached read would compare against a stamp that may
   *  already have moved. */
  async issue(repo: string, number: number, opts: { token: string }): Promise<GithubResponse<GithubIssue>> {
    const bad = refuseRepo<GithubIssue>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<GithubIssue>('GET', `${API}/repos/${repo}/issues/${number}`, opts);
  }

  /** One page of ONE issue's comments — the claim protocol's read. Paginated
   *  the way `issues` is: this returns a page and its `next` link, and the
   *  caller follows the cursor with `page()`. A per-issue read rather than the
   *  repository-wide one the poller makes, because the protocol has to see the
   *  comments posted in the last second, which no cache can promise.
   *
   *  Also the poller's per-issue reconcile (bug-55), which is why it takes the
   *  optional `etag` its two repo-wide siblings take: the poller re-checks every
   *  claimed issue on every tick, and a conditional read makes a quiet one a
   *  `304`. The protocol never passes one — it must see a fresh list. */
  async issueComments(repo: string, number: number, opts: { token: string; etag?: string | null }): Promise<GithubResponse<GithubComment[]>> {
    const bad = refuseRepo<GithubComment[]>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<GithubComment[]>('GET', `${API}/repos/${repo}/issues/${number}/comments?per_page=100`, opts);
  }

  /** A new comment on an issue. 201 with the created comment — whose `id` is
   *  the claim protocol's ordering key, which is why the response body matters
   *  here and not only the status. */
  async createComment(repo: string, number: number, body: string, opts: { token: string }): Promise<GithubResponse<GithubComment>> {
    const bad = refuseRepo<GithubComment>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<GithubComment>('POST', `${API}/repos/${repo}/issues/${number}/comments`, { ...opts, body: { body } });
  }

  /** Rewrite one comment in place. The comment endpoint is repo-scoped and
   *  takes a COMMENT id, not an issue number — `/issues/comments/{id}`, which
   *  reads like a typo and is not. Editing rather than re-posting is what keeps
   *  one claim comment per session per issue, so an issue's timeline stays
   *  readable by a person. */
  async updateComment(repo: string, commentId: number, body: string, opts: { token: string }): Promise<GithubResponse<GithubComment>> {
    const bad = refuseRepo<GithubComment>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<GithubComment>('PATCH', `${API}/repos/${repo}/issues/comments/${commentId}`, { ...opts, body: { body } });
  }

  /** Remove one comment. 204, no body. The ONE thing the protocol ever deletes,
   *  and only ever a comment this same call chain posted seconds earlier — a
   *  claim that LOST the race. A claim that merely went stale is released, never
   *  deleted (spec §6.3 step 5). */
  async deleteComment(repo: string, commentId: number, opts: { token: string }): Promise<GithubResponse<unknown>> {
    const bad = refuseRepo<unknown>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<unknown>('DELETE', `${API}/repos/${repo}/issues/comments/${commentId}`, opts);
  }

  /** Add labels to an issue, leaving the ones already there alone — additive,
   *  unlike `updateIssue`'s `labels`, which replaces. The protocol wants the
   *  additive one: it sets `in-progress` on an issue whose `type:*` and `kind:*`
   *  labels are structure it must not touch. */
  async addLabels(repo: string, number: number, names: string[], opts: { token: string }): Promise<GithubResponse<unknown>> {
    const bad = refuseRepo<unknown>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<unknown>('POST', `${API}/repos/${repo}/issues/${number}/labels`, { ...opts, body: { labels: names } });
  }

  /**
   * Remove one label from an issue.
   *
   * A 404 here means the label was not on the issue, which is a SUCCESS for
   * every caller this has — each one's contract is "the label is not there",
   * and it is not there. The status is handed back honestly (404) rather than
   * rewritten to 200; the judgement belongs to the writer, which is where it is
   * made and tested. Two sessions releasing the same claim, or a release of a
   * claim whose `in-progress` a person already removed by hand, both land here.
   *
   * The name is URL-encoded: label names legitimately contain `:` and spaces,
   * and this one goes in a path segment.
   */
  async removeLabel(repo: string, number: number, name: string, opts: { token: string }): Promise<GithubResponse<unknown>> {
    const bad = refuseRepo<unknown>(repo, this.rate);
    if (bad !== null) return bad;
    return this.request<unknown>('DELETE', `${API}/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, opts);
  }

  private async request<T>(
    method: string,
    url: string,
    opts: { token: string; etag?: string | null; body?: unknown }
  ): Promise<GithubResponse<T>> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${opts.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'backlog-manager'
    };
    // The conditional request. A matching ETag answers `304` with no body and
    // costs nothing against the hourly limit, which is what makes a 15-second
    // poll affordable at all (spec §5.1's budget).
    if (opts.etag) headers['if-none-match'] = opts.etag;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      });
    } catch (e) {
      // A transport failure is a state, not an exception: the poller records
      // `access: 'error'` with this message and tries again on the next tick,
      // exactly as it would for a 500. Nothing above this needs a try/catch.
      return {
        status: 0,
        data: null,
        etag: null,
        next: null,
        retryAfter: null,
        secondary: false,
        error: e instanceof Error ? e.message : String(e),
        rate: this.rate
      };
    }

    // Recorded BEFORE any status branch, so a 304, a 403 and a 200 all keep
    // the card's numbers moving (rule 2).
    this.record(res.headers);

    const retryAfter = numberHeader(res.headers.get('retry-after'));
    const etag = res.headers.get('etag');
    const next = nextLink(res.headers.get('link'));

    if (res.status === 304) {
      return { status: 304, data: null, etag, next, retryAfter, secondary: false, error: null, rate: this.rate };
    }

    let data: T | null = null;
    let secondary = false;
    let error: string | null = null;
    // A body is read for every other status, including the failures: GitHub's
    // error bodies carry the sentence the Trackers card shows, and the
    // secondary-limit bit can only be read from the message.
    try {
      const text = await res.text();
      const parsed = text === '' ? null : (JSON.parse(text) as unknown);
      if (res.ok) {
        data = parsed as T;
      } else {
        const message = typeof (parsed as { message?: unknown })?.message === 'string' ? (parsed as { message: string }).message : `HTTP ${res.status}`;
        error = message;
        secondary = /secondary rate limit/i.test(message);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    return { status: res.status, data, etag, next, retryAfter, secondary, error, rate: this.rate };
  }

  private record(headers: Headers): void {
    const limit = numberHeader(headers.get('x-ratelimit-limit'));
    const remaining = numberHeader(headers.get('x-ratelimit-remaining'));
    const reset = numberHeader(headers.get('x-ratelimit-reset'));
    // Field by field rather than wholesale: a response that carries only some
    // of the three must not blank the others, since the card reads all three
    // together and a half-updated reading is worse than a slightly old one.
    this.lastRate = {
      limit: limit ?? this.lastRate.limit,
      remaining: remaining ?? this.lastRate.remaining,
      reset: reset ?? this.lastRate.reset
    };
  }
}

/**
 * The write methods' repo guard: `null` when the repo is fine, and otherwise
 * the response a caller gets INSTEAD of a request being made.
 *
 * `status: 0` rather than a throw, because rule 3 at the top of this file has
 * no exceptions: every outcome a caller has to branch on is a value, and a
 * transport failure already uses this exact shape. The message names the field
 * so a writer's `upstream` refusal reads as something an operator can fix (a
 * typo in a committed `backlog/source.json`) rather than as a network blip.
 */
function refuseRepo<T>(repo: string, rate: RateLimit): GithubResponse<T> | null {
  if (isRepo(repo)) return null;
  return {
    status: 0,
    data: null,
    etag: null,
    next: null,
    retryAfter: null,
    secondary: false,
    error: `not an owner/name repository: ${JSON.stringify(repo)}`,
    rate
  };
}

/** A header as a finite number, or `null` — an absent, empty or non-numeric
 *  header all read the same, because all three mean "this response did not say". */
function numberHeader(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `<https://api.github.com/...>; rel="next", <...>; rel="last"` → the next
 *  URL, or `null` on the last page. */
function nextLink(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * The fields of an issue this app reads, and nothing else. A narrow shape
 * rather than a generated client: every field here is one the mapping table in
 * spec §5.3 names, so a reader of `map-issue.ts` can see the whole input
 * without leaving these two files.
 *
 * `pull_request` is present exactly when the row is a PR, which the issues
 * endpoint returns alongside real issues; it is typed as `unknown` because
 * nothing reads its contents — only whether it is there.
 */
export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  state_reason?: string | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  labels: ({ name: string } | string)[];
  assignees?: { login: string }[] | null;
  pull_request?: unknown;
}

/**
 * The comment fields the claim protocol reads (task-46). Written by the poller
 * since phase 2 — see `comments()` above for why the call was made a phase
 * before anything read it.
 *
 * `id` carries more weight than the rest and is worth naming: it is the
 * protocol's ORDERING key. GitHub assigns comment ids monotonically, so the
 * lowest live claim's id is the one posted first, and that is what lets two
 * machines pick the same winner with no lock between them (see
 * `server/src/tracker/claim.ts`).
 */
export interface GithubComment {
  id: number;
  issue_url: string;
  body: string | null;
  /** Where a person opens this comment. Carried so a refusal can point at the
   *  claim that won, and so `comment`'s 201 can answer with a URL. */
  html_url: string;
  user?: { login: string } | null;
  created_at: string;
  updated_at: string;
}
