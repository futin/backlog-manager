/**
 * jira.ts — an in-memory Jira Cloud over the dozen endpoints this app reads and the two it writes (Jira phases 1 and 3; spec §3, §6 and §8).
 *
 * ## Why a whole little server rather than a stub per case
 *
 * The walk is a SEQUENCE — roots, then their descendants round by round, then the saved queries, then the detail read — and its interesting cases are all
 * about what a later request returns relative to an earlier one: a root that fails while the next proceeds, a page that says `isLast: false` and carries no
 * token, a 429 that closes the window for every call after it. A per-call stub can express "answer this body" but not "the second search sees the issue the
 * first one did not"; keeping the issues in a map and resolving each JQL against it makes each of those a line of setup. Paging, the 429 window and the
 * unbounded-JQL refusal are likewise sequences or conversations, and one honest implementation of each here is cheaper than a copy per suite.
 *
 * It is faked at `fetch`, INSIDE a real `JiraClient`, exactly as `test/helpers/github.ts` is faked inside a real `GithubClient`: the client's own rules (the
 * gateway, no token outside one header, nothing thrown on a status, a deadline) stay under test rather than being stubbed away. Shared by every Jira suite
 * for the same reason `FakeGithub` is — two copies of a fake this size are two chances for two suites to disagree about what Jira does.
 *
 * ## What it resolves, and what it refuses
 *
 * `search/jql` understands exactly the JQL the SERVER writes — `key = "K"`, `key in (…)`, `parent in (…)`, whitespace-tolerant — against the issue map, and
 * answers any other JQL (a person's saved query) from `answers`, by exact text, or with the 400 Jira gives for a field it does not know. The empty JQL and
 * the `order by`-only JQL are the 400 Jira Cloud gives for an unbounded query, with its exact sentence: that refusal is the one a caller can hit by
 * accident, and a fake that answered it with "everything" would hide the bug. An unknown KEY, by contrast, is a 200 with no issues (P3), not an error.
 *
 * ## Failure switches
 *
 * In the order they are consulted, before any canned answer: `failNext` (a per-request hook — it sees each call, so one root can fail while the next
 * proceeds), `failWith` (every request, a status or a transport failure), `unauthorized` (the authenticated gateway calls answer 401; `tenant_info` is
 * unauthenticated and still answers), `rateLimit` (the authenticated gateway calls answer 429 with `retry-after` when it has one). `siteMyselfStatus` is the
 * boot probe's own answer (200 for a classic token, 401 for a scoped one) and is independent of `unauthorized`. `omitNextPageToken` makes a page claim
 * `isLast: false` with no token — a Jira that would loop a naive pager forever.
 */

export interface JiraCall {
  method: string;
  url: string;
  /** Header names lower-cased, as the client sends them. */
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeTransition {
  id: string;
  name: string;
  to: { name: string; statusCategory: { key: string } };
}

export interface RawIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

/**
 * What `failNext` may answer: a status (with an optional JSON body and headers — a `retry-after` on one 429 and not the next), a transport failure, or
 * `null` to let the request through.
 */
export type FailNext = (call: {
  method: string;
  url: string;
  body: unknown;
}) => { status: number; body?: unknown; headers?: Record<string, string> } | 'transport' | null;

const GATEWAY = /^https:\/\/api\.atlassian\.com\/ex\/jira\/([^/]+)\/rest\/api\/3(\/[^?]*)?(?:\?(.*))?$/;
const SITE = /^https:\/\/([^/]+)\/(.*?)(?:\?(.*))?$/;
const UNBOUNDED = 'Unbounded JQL queries are not allowed here. Please add a search restriction to your query.';
const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

const unquote = (s: string): string => s.replace(/\\(.)/g, '$1');

/**
 * A raw issue the way Jira sends one (P2/P4): `issuetype.hierarchyLevel`, `parent.fields.summary` when a case sets a parent, and the sprint field as an
 * array. `partial.fields` is merged over the defaults one key at a time, so a case overrides what it cares about and inherits the rest. The `id` follows the
 * key's number unless given.
 */
export function makeRawIssue(partial: { key?: string; id?: string; fields?: Record<string, unknown> } = {}): RawIssue {
  const key = partial.key ?? 'PAY-1';
  const [project] = key.split('-');
  const created = new Date(Date.now() - 2 * 86_400_000).toISOString();
  return {
    id: partial.id ?? `1${key.replace(/\D/g, '').padStart(4, '0')}`,
    key,
    fields: {
      summary: `Summary of ${key}`,
      issuetype: { name: 'Task', hierarchyLevel: 0, subtask: false },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      priority: { name: 'Medium' },
      assignee: null,
      reporter: { accountId: 'acc-1', displayName: 'Ada Lovelace' },
      subtasks: [],
      labels: [],
      created,
      updated: created,
      resolutiondate: null,
      project: { key: project, name: `${project} project` },
      customfield_10020: [],
      ...partial.fields
    }
  };
}

export class FakeJira {
  site = 'acme.atlassian.net';
  cloudId = 'c1';
  me = { accountId: 'acc-1', displayName: 'Ada Lovelace' };
  deploymentType = 'Cloud';
  fields: { id: string; name: string; schema?: { custom?: string } }[] = [
    { id: 'summary', name: 'Summary' },
    { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }
  ];
  issues = new Map<string, RawIssue>();
  transitions = new Map<string, FakeTransition[]>();
  projects: { key: string; name: string }[] = [];
  /** Canned search results by EXACT JQL, for a person's query; the server's own JQL is resolved against `issues` instead. Keys not seeded in `issues` are
   *  dropped, so a case seeds every key it names. */
  answers = new Map<string, string[]>();
  counts = new Map<string, number>();
  parseErrors = new Map<string, string[]>();
  readonly calls: JiraCall[] = [];

  unauthorized = false;
  siteMyselfStatus = 200;
  rateLimit: { retryAfter: number | null } | null = null;
  failWith: number | 'transport' | null = null;
  failNext: FailNext | null = null;
  omitNextPageToken = false;

  /** Keys a JQL matches, or the 400 message Jira would give. */
  private resolve(jql: string): { keys: string[] } | { error: string } {
    const text = jql.trim();
    if (text === '' || /^order\s+by\b/i.test(text)) return { error: UNBOUNDED };
    // A trailing ORDER BY changes the order, not the set, so the server's own JQL is matched without it.
    const bare = text.replace(/\s+order\s+by\s+.*$/i, '');

    const one = /^key\s*=\s*"((?:[^"\\]|\\.)*)"$/i.exec(bare);
    if (one) return { keys: this.issues.has(unquote(one[1])) ? [unquote(one[1])] : [] };

    const many = /^key\s+in\s*\((.*)\)$/i.exec(bare);
    if (many) {
      const wanted = [...many[1].matchAll(QUOTED)].map((m) => unquote(m[1]));
      return { keys: wanted.filter((k) => this.issues.has(k)) };
    }

    const children = /^parent\s+in\s*\((.*)\)$/i.exec(bare);
    if (children) {
      const parents = new Set([...children[1].matchAll(QUOTED)].map((m) => unquote(m[1])));
      const keys = [...this.issues.values()].filter((i) => parents.has((i.fields.parent as { key?: string } | undefined)?.key ?? '')).map((i) => i.key);
      return { keys };
    }

    const canned = this.answers.get(jql);
    if (canned !== undefined) return { keys: canned.filter((k) => this.issues.has(k)) };
    const field = /^\s*([A-Za-z_][\w.]*)/.exec(jql)?.[1] ?? 'x';
    return { error: `Field '${field}' does not exist or you do not have permission to view it.` };
  }

  private subset(issue: RawIssue, wanted: string[] | null): RawIssue {
    if (wanted === null) return issue;
    const fields: Record<string, unknown> = {};
    for (const name of wanted) if (name in issue.fields) fields[name] = issue.fields[name];
    return { id: issue.id, key: issue.key, fields };
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    const out: Record<string, string> = { 'x-ratelimit-remaining': '100', ...headers };
    if (status === 204 || body === undefined) return new Response(null, { status, headers: out });
    out['content-type'] = 'application/json';
    return new Response(JSON.stringify(body), { status, headers: out });
  }

  private refuse(status: number, message: string): Response {
    return this.json(status, { errorMessages: [message], errors: {} });
  }

  fetch: typeof fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    this.calls.push({ method, url, headers, body });

    const hook = this.failNext?.({ method, url, body });
    if (hook === 'transport') throw new TypeError('fetch failed');
    if (hook) return this.json(hook.status, hook.body, hook.headers);
    if (this.failWith === 'transport') throw new TypeError('fetch failed');
    if (this.failWith !== null) return this.json(this.failWith, undefined);

    const gw = GATEWAY.exec(url);
    if (gw) {
      if (gw[1] !== this.cloudId) return this.refuse(404, `FakeJira: no such cloud id ${gw[1]}`);
      if (this.unauthorized) return this.json(401, { code: 401, message: 'Unauthorized' });
      if (this.rateLimit !== null) {
        return this.json(429, undefined, this.rateLimit.retryAfter === null ? {} : { 'retry-after': String(this.rateLimit.retryAfter) });
      }
      return this.gateway(method, gw[2] ?? '', new URLSearchParams(gw[3] ?? ''), body);
    }

    const site = SITE.exec(url);
    if (site && site[1] === this.site) {
      if (method === 'GET' && site[2] === '_edge/tenant_info') return this.json(200, { cloudId: this.cloudId });
      if (method === 'GET' && site[2] === 'rest/api/3/myself') {
        return this.siteMyselfStatus === 200 ? this.json(200, this.me) : this.json(this.siteMyselfStatus, { message: 'site myself refused' });
      }
    }
    return this.refuse(404, `FakeJira: unrouted ${method} ${url}`);
  }) as unknown as typeof fetch;

  private gateway(method: string, path: string, query: URLSearchParams, body: unknown): Response {
    if (method === 'GET' && path === '/serverInfo') return this.json(200, { deploymentType: this.deploymentType, version: '1001.0.0' });
    if (method === 'GET' && path === '/myself') return this.json(200, this.me);
    if (method === 'GET' && path === '/field') return this.json(200, this.fields);

    if (method === 'POST' && path === '/search/jql') {
      const req = body as { jql: string; fields: string[]; maxResults: number; nextPageToken?: string };
      const found = this.resolve(req.jql);
      if ('error' in found) return this.refuse(400, found.error);
      // The token is a page INDEX (`p1` points at the second page, `p2` the third), not an offset: that is what the poller's paging cases assert.
      const page = req.nextPageToken ? Number(req.nextPageToken.replace(/^p/, '')) : 0;
      const start = page * req.maxResults;
      const end = Math.min(start + req.maxResults, found.keys.length);
      const issues = found.keys.slice(start, end).map((k) => this.subset(this.issues.get(k)!, req.fields));
      // A Jira that claims more pages and names none (`omitNextPageToken`) is answered on EVERY page, last included: the caller must stop on the absent token.
      if (this.omitNextPageToken) return this.json(200, { issues, isLast: false });
      return this.json(200, end >= found.keys.length ? { issues, isLast: true } : { issues, isLast: false, nextPageToken: `p${page + 1}` });
    }

    // The two writes (Jira phase 3). Each answers 204 and, like a real Jira, bumps the issue's `updated` — the poller's newest-wins cases compare it.
    const assignPath = /^\/issue\/([^/]+)\/assignee$/.exec(path);
    if (method === 'PUT' && assignPath) {
      const issue = this.issues.get(decodeURIComponent(assignPath[1]));
      if (issue === undefined) return this.refuse(404, 'Issue does not exist');
      const { accountId } = body as { accountId: string | null };
      // Only the signed-in user can be assigned: a fake that accepted any id would let a client that sent the wrong one pass.
      if (accountId !== this.me.accountId) return this.refuse(400, `User '${accountId}' cannot be assigned issues.`);
      issue.fields.assignee = { accountId: this.me.accountId, displayName: this.me.displayName };
      issue.fields.updated = new Date().toISOString();
      return this.json(204, undefined);
    }

    const transitionWrite = /^\/issue\/([^/]+)\/transitions$/.exec(path);
    if (method === 'POST' && transitionWrite) {
      const key = decodeURIComponent(transitionWrite[1]);
      const issue = this.issues.get(key);
      if (issue === undefined) return this.refuse(404, 'Issue does not exist');
      const { transition } = body as { transition: { id: string } };
      const offered = (this.transitions.get(key) ?? []).find((t) => t.id === transition.id);
      if (offered === undefined) return this.refuse(400, `Transition id '${transition.id}' is not valid for this issue.`);
      issue.fields.status = { name: offered.to.name, statusCategory: offered.to.statusCategory };
      if (offered.to.statusCategory.key === 'done') issue.fields.resolutiondate = new Date().toISOString();
      issue.fields.updated = new Date().toISOString();
      return this.json(204, undefined);
    }

    const issuePath = /^\/issue\/([^/]+)(\/transitions)?$/.exec(path);
    if (method === 'GET' && issuePath) {
      const key = decodeURIComponent(issuePath[1]);
      const issue = this.issues.get(key);
      if (issue === undefined) return this.refuse(404, 'Issue does not exist or you do not have permission to see it.');
      if (issuePath[2]) return this.json(200, { transitions: this.transitions.get(key) ?? [] });
      const asked = query.get('fields');
      return this.json(200, this.subset(issue, asked === null ? null : asked.split(',')));
    }

    if (method === 'GET' && path === '/project/search') {
      const startAt = Number(query.get('startAt') ?? 0);
      const max = Number(query.get('maxResults') ?? 50);
      const values = this.projects.slice(startAt, startAt + max);
      return this.json(200, { values, startAt, maxResults: max, total: this.projects.length, isLast: startAt + max >= this.projects.length });
    }

    if (method === 'POST' && path === '/jql/parse') {
      const { queries } = body as { queries: string[] };
      return this.json(200, {
        queries: queries.map((q) => {
          const errors = this.parseErrors.get(q);
          return errors === undefined ? { query: q } : { query: q, errors };
        })
      });
    }

    if (method === 'POST' && path === '/search/approximate-count') {
      const { jql } = body as { jql: string };
      const found = this.resolve(jql);
      // `counts` wins so a case can claim a figure far past what `issues` holds; an unbounded JQL is refused whatever it says.
      if ('error' in found)
        return this.counts.has(jql) && !found.error.startsWith('Unbounded') ? this.json(200, { count: this.counts.get(jql) }) : this.refuse(400, found.error);
      return this.json(200, { count: this.counts.get(jql) ?? found.keys.length });
    }

    return this.refuse(404, `FakeJira: unrouted gateway ${method} ${path}`);
  }
}
