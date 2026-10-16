/**
 * A thin client over `fetch` for the dozen endpoints of Jira Cloud's REST API this app reads (Jira phase 1, spec §3 and §6). Its own file, no Nest decorators
 * and no injected dependencies beyond `fetch`, so a test can construct one over `FakeJira.fetch` and drive every branch without standing a module up — the
 * branches that are hard to reach are the failure ones (a 429 window, a 401 mid-sweep, a deadline), and those are exactly the ones a live Jira can never
 * schedule. It is the shape of `tracker/github.client.ts`: nothing here throws on an HTTP status, and every failure is a value the caller branches on.
 *
 * Four rules this file holds and its callers therefore do not have to:
 *
 * 1. **Every call goes through the API gateway** — `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…` (P14) — because that is the one address a
 *    scoped API token (the kind Atlassian now issues by default) can reach; a classic token works there too, so the server never has to know which it holds
 *    to make a read. The two exceptions are `tenantInfo` and `myselfAtSite`, below, and both are asked on purpose.
 * 2. **`tenant_info` is unauthenticated.** `GET https://<site>/_edge/tenant_info` answers `{ cloudId }` to anyone who can name the site, which is exactly
 *    what lets the server turn a hostname into the gateway path without a credential in that first request. It is not a validation of the site — the
 *    operator's own configuration names it, and `myselfAtSite` later sends credentials to it by design. It carries no `authorization` header at all.
 * 3. **The token sits in one header and nowhere else.** `authorization: Basic base64(email:token)` is built in one place (`headers`), never logged, never in
 *    a URL, never in an error message — a `message` here is Jira's own sentence or the transport error's, neither of which can contain it. The call log a test
 *    reads (`FakeJira.calls`) is how the suite proves it (§10).
 * 4. **Calls are counted here**, at the one place every request passes, so the board chip's CALLS meter (§6) cannot disagree with what was actually sent:
 *    `tenantInfo` and the boot probe count like any other, and `takeCalls()` returns and resets so the poller can report a per-tick figure.
 *
 * Every call carries a `JIRA_TIMEOUT_MS` deadline — a `setTimeout` plus an `AbortController`, not `AbortSignal.timeout`. The signal form fires off a real
 * timer jest's fake timers never advance, and its message is `aborted due to timeout`; owning the timer makes the deadline testable and the message ours
 * (`timed out after 10000 ms`). It is also raced against the call rather than relying on the signal alone, so a `fetch` that ignores its signal still ends.
 */

/** The one gateway host (rule 1). Not configurable on purpose: "where can this call go" is answered by reading this file. */
const GATEWAY_HOST = 'https://api.atlassian.com';

/** The bound on every call, and the one `runGit` already uses: a Jira that does not answer in ten seconds is `unreachable`, not a hung poll. */
export const JIRA_TIMEOUT_MS = 10_000;

/** What every call needs but `tenantInfo`. `cloudId` is the gateway path segment, from `tenantInfo`; `site` is only used by the one site-URL probe. */
export interface JiraAuth {
  site: string;
  email: string;
  token: string;
  cloudId: string;
}

/**
 * One response, normalised. `data` is `null` for a 204, for any non-2xx, and for a body that is not JSON.
 */
export interface JiraResponse<T> {
  /** HTTP status, or `0` for a transport failure or a timeout. */
  status: number;
  data: T | null;
  /** Jira's own sentence for a failure (`errorMessages`, then `errors`), `Jira answered <status>` when it sent none, the transport error's text for `0`;
   *  `null` on a success. */
  message: string | null;
  /** `Retry-After` in seconds, when the response carried one. */
  retryAfter: number | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The gateway's REST root for one cloud id (rule 1). */
export function gatewayBase(cloudId: string): string {
  return `${GATEWAY_HOST}/ex/jira/${cloudId}/rest/api/3`;
}

/** The site's own REST root — used only by `myselfAtSite`, the boot probe that tells a classic token from a scoped one. */
export function siteBase(site: string): string {
  return `https://${site}/rest/api/3`;
}

/**
 * A value the SERVER puts into JQL, as a double-quoted string with `\` and `"` backslash-escaped (§10). `key = ${jqlString(key)}` is the only way this
 * codebase interpolates into a query; a person's own JQL is passed verbatim and never goes through here.
 */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class JiraClient {
  private callCount = 0;

  /** `fetch` by default; a fake in tests, injected through the constructor so two suites can never share one. */
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  /** Calls made since the last `takeCalls`, `tenantInfo` included (rule 4). */
  get calls(): number {
    return this.callCount;
  }

  /** The count, and zero — what the poller reads once per tick. */
  takeCalls(): number {
    const n = this.callCount;
    this.callCount = 0;
    return n;
  }

  /** `{ cloudId }` for a site, with no credential sent (rule 2). */
  async tenantInfo(site: string): Promise<JiraResponse<{ cloudId: string }>> {
    return this.request('GET', `https://${site}/_edge/tenant_info`, null);
  }

  /** The server's `deploymentType` — `Cloud` is the only thing this app supports (P13). */
  async serverInfo(auth: JiraAuth): Promise<JiraResponse<{ deploymentType?: string }>> {
    return this.request('GET', `${gatewayBase(auth.cloudId)}/serverInfo`, auth);
  }

  /** The identity the credentials resolve to, through the gateway. */
  async myself(auth: JiraAuth): Promise<JiraResponse<{ accountId: string; displayName: string }>> {
    return this.request('GET', `${gatewayBase(auth.cloudId)}/myself`, auth);
  }

  /** The same question asked of the SITE's own URL: a classic token answers 200 there and a scoped one 401, which is how `tokenKind` is decided (P14). */
  async myselfAtSite(auth: JiraAuth): Promise<JiraResponse<{ accountId: string; displayName: string }>> {
    return this.request('GET', `${siteBase(auth.site)}/myself`, auth);
  }

  /** Every field on the site, for the sprint field's discovery (P4). */
  async fields(auth: JiraAuth): Promise<JiraResponse<{ id: string; name: string; schema?: { custom?: string } }[]>> {
    return this.request('GET', `${gatewayBase(auth.cloudId)}/field`, auth);
  }

  /**
   * One page of the enhanced JQL search. `nextPageToken` is sent only when there is one — the first page has none, and a body that carried `undefined`
   * would be a different request to a fake that compares bodies.
   */
  async search(
    auth: JiraAuth,
    body: { jql: string; fields: string[]; maxResults: number; nextPageToken?: string }
  ): Promise<JiraResponse<{ issues: unknown[]; isLast: boolean; nextPageToken?: string }>> {
    const payload: Record<string, unknown> = { jql: body.jql, fields: body.fields, maxResults: body.maxResults };
    if (body.nextPageToken !== undefined) payload.nextPageToken = body.nextPageToken;
    return this.request('POST', `${gatewayBase(auth.cloudId)}/search/jql`, auth, payload);
  }

  /** One issue with the subset of fields asked for. */
  async issue(auth: JiraAuth, key: string, fields: string[]): Promise<JiraResponse<{ id: string; key: string; fields: Record<string, unknown> }>> {
    return this.request('GET', `${gatewayBase(auth.cloudId)}/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields.join(','))}`, auth);
  }

  /** The transitions an issue offers right now — read only in phase 1 (a transition is a later phase's write). */
  async transitions(auth: JiraAuth, key: string): Promise<JiraResponse<{ transitions: unknown[] }>> {
    return this.request('GET', `${gatewayBase(auth.cloudId)}/issue/${encodeURIComponent(key)}/transitions`, auth);
  }

  /** One page of projects, fifty at a time from `startAt`. */
  async projects(auth: JiraAuth, startAt: number): Promise<JiraResponse<{ values: { key: string; name: string }[]; isLast: boolean }>> {
    return this.request('GET', `${gatewayBase(auth.cloudId)}/project/search?startAt=${startAt}&maxResults=50`, auth);
  }

  /** Validates a person's JQL without running it: `strict` is what makes an unknown field an error rather than a silent empty result. */
  async parseJql(auth: JiraAuth, jql: string): Promise<JiraResponse<{ queries: { errors?: string[] }[] }>> {
    return this.request('POST', `${gatewayBase(auth.cloudId)}/jql/parse?validation=strict`, auth, { queries: [jql] });
  }

  /** How many issues a JQL would match — an estimate, which is all a "showing 200 of N" line needs. */
  async approximateCount(auth: JiraAuth, jql: string): Promise<JiraResponse<{ count: number }>> {
    return this.request('POST', `${gatewayBase(auth.cloudId)}/search/approximate-count`, auth, { jql });
  }

  /**
   * The one place a request is made: counts it, builds its headers (rule 3), puts a deadline on it, and turns whatever happened into a `JiraResponse`.
   * `auth: null` is `tenantInfo`'s — no `authorization` header at all.
   */
  private async request<T>(method: string, url: string, auth: JiraAuth | null, body?: unknown): Promise<JiraResponse<T>> {
    this.callCount += 1;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'backlog-manager' };
    if (auth !== null) headers.authorization = `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString('base64')}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline is a promise the call is RACED against, so a `fetch` that never looks at its signal still ends; aborting the signal as well is what
    // lets a real `fetch` release its socket.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${JIRA_TIMEOUT_MS} ms`));
      }, JIRA_TIMEOUT_MS);
    });
    const call = (async (): Promise<{ status: number; text: string; retryAfter: number | null }> => {
      const res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      return { status: res.status, text: await res.text(), retryAfter: numberHeader(res.headers.get('retry-after')) };
    })();
    // If the deadline wins, the call may still reject later (the abort); that rejection has no reader and must not surface as an unhandled one.
    call.catch(() => undefined);

    let got: { status: number; text: string; retryAfter: number | null };
    try {
      got = await Promise.race([call, deadline]);
    } catch (e) {
      // A transport failure or a timeout is a state, not an exception: the poller records `unreachable` with this message and tries again next tick.
      return { status: 0, data: null, message: transportMessage(e), retryAfter: null };
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    let parseable = true;
    if (got.text !== '') {
      try {
        parsed = JSON.parse(got.text);
      } catch {
        parseable = false;
      }
    }
    if (got.status >= 200 && got.status < 300) {
      return { status: got.status, data: parseable ? (parsed as T | null) : null, message: null, retryAfter: got.retryAfter };
    }
    return { status: got.status, data: null, message: errorMessage(got.status, parseable ? parsed : null), retryAfter: got.retryAfter };
  }
}

/**
 * Jira's own sentence for a failure: `errorMessages` first, then `errors` as `field: text`, joined by `; `, then a top-level `message` (the gateway's own shape). A body with none of them (an HTML gateway page, an
 * empty 502, both arrays empty) is `Jira answered <status>` — so a message is never empty and never raw HTML.
 */
function errorMessage(status: number, parsed: unknown): string {
  const body = (parsed ?? {}) as { errorMessages?: unknown; errors?: unknown; message?: unknown };
  const parts: string[] = [];
  if (Array.isArray(body.errorMessages)) for (const m of body.errorMessages) if (typeof m === 'string' && m !== '') parts.push(m);
  if (typeof body.errors === 'object' && body.errors !== null) {
    for (const [field, text] of Object.entries(body.errors)) if (typeof text === 'string' && text !== '') parts.push(`${field}: ${text}`);
  }
  // The gateway answers its own 401 and 403 as `{ code, message }` rather than Jira's shape; it is the only sentence those carry.
  if (parts.length === 0 && typeof body.message === 'string' && body.message !== '') parts.push(body.message);
  return parts.length > 0 ? parts.join('; ') : `Jira answered ${status}`;
}

/**
 * A rejected call's message, with its `cause` appended when it has one. undici rejects every network failure as a bare `TypeError('fetch failed')` and puts
 * the reason — `getaddrinfo ENOTFOUND <host>`, `connect ECONNREFUSED <addr>` — in `cause`, which is the one thing that tells a mistyped site from an outage.
 * Safe to show: the cause is the socket's or the resolver's error, built before any header is written, so it can hold a host but never the credentials.
 */
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
