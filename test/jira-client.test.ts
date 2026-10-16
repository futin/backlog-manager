import { JIRA_TIMEOUT_MS, JiraClient, gatewayBase, jqlString, siteBase } from '../server/src/jira/jira.client';
import type { JiraAuth, JiraResponse } from '../server/src/jira/jira.client';
import { JIRA_RATE_LIMIT_DEFAULT_MS, accessOf, jiraHttpError } from '../server/src/jira/errors.util';
import { FakeJira, makeRawIssue } from './helpers/jira';

/**
 * The Jira client, the §8 error mapping, and the fake both are tested against (Jira phase 1, Task 3; spec §3 and §8).
 *
 * The client is driven over `FakeJira.fetch`, so what it puts on the wire is read off the fake's call log rather than asserted against a stub. The last
 * describe tests the fake itself: every later suite (the poller, the routes, the status payload) leans on its search resolution, its paging and its
 * failure switches, and a fake that is wrong in the green direction would let all of them pass for the wrong reason.
 */

const auth: JiraAuth = { site: 'acme.atlassian.net', email: 'ada@example.com', token: 't0k3n-SECRET', cloudId: 'c1' };
const BASIC = `Basic ${Buffer.from('ada@example.com:t0k3n-SECRET').toString('base64')}`;
const GATEWAY = 'https://api.atlassian.com/ex/jira/c1/rest/api/3';
const UNBOUNDED = 'Unbounded JQL queries are not allowed here. Please add a search restriction to your query.';

function build(): { fake: FakeJira; client: JiraClient } {
  const fake = new FakeJira();
  return { fake, client: new JiraClient(fake.fetch) };
}

/** A hand-built response for the pure mapping functions, which take the client's normalised value and never touch a network. */
function res(status: number, over: Partial<JiraResponse<unknown>> = {}): JiraResponse<unknown> {
  return { status, data: null, message: null, retryAfter: null, ...over };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('jqlString, gatewayBase, siteBase', () => {
  it('double-quotes a value and backslash-escapes backslash and quote', () => {
    expect(jqlString('PAY-1')).toBe('"PAY-1"');
    expect(jqlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('builds the gateway and the site bases', () => {
    expect(gatewayBase('c1')).toBe('https://api.atlassian.com/ex/jira/c1/rest/api/3');
    expect(siteBase('acme.atlassian.net')).toBe('https://acme.atlassian.net/rest/api/3');
  });
});

describe('what each method puts on the wire', () => {
  it('tenantInfo GETs the unauthenticated edge endpoint and answers the cloud id', async () => {
    const { fake, client } = build();
    const out = await client.tenantInfo('acme.atlassian.net');
    expect(out).toEqual({ status: 200, data: { cloudId: 'c1' }, message: null, retryAfter: null });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].url).toBe('https://acme.atlassian.net/_edge/tenant_info');
    expect(fake.calls[0].headers).not.toHaveProperty('authorization');
  });

  it('myself GETs the gateway with Basic auth, accept and user-agent', async () => {
    const { fake, client } = build();
    const out = await client.myself(auth);
    expect(out.data).toEqual({ accountId: fake.me.accountId, displayName: fake.me.displayName });
    expect(fake.calls[0].url).toBe(`${GATEWAY}/myself`);
    expect(fake.calls[0].headers).toMatchObject({ authorization: BASIC, accept: 'application/json', 'user-agent': 'backlog-manager' });
  });

  it('myselfAtSite GETs the site base with the same headers', async () => {
    const { fake, client } = build();
    await client.myselfAtSite(auth);
    expect(fake.calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/myself');
    expect(fake.calls[0].headers).toMatchObject({ authorization: BASIC, accept: 'application/json', 'user-agent': 'backlog-manager' });
  });

  it('serverInfo and fields GET their gateway paths', async () => {
    const { fake, client } = build();
    const info = await client.serverInfo(auth);
    const fields = await client.fields(auth);
    expect(fake.calls.map((c) => c.url)).toEqual([`${GATEWAY}/serverInfo`, `${GATEWAY}/field`]);
    expect(info.data).toMatchObject({ deploymentType: 'Cloud' });
    expect(Array.isArray(fields.data)).toBe(true);
  });

  it('search POSTs the body exactly, with nextPageToken present only when given', async () => {
    const { fake, client } = build();
    await client.search(auth, { jql: 'project = PAY', fields: ['summary'], maxResults: 100 });
    await client.search(auth, { jql: 'project = PAY', fields: ['summary'], maxResults: 100, nextPageToken: 'p1' });
    expect(fake.calls[0]).toMatchObject({ method: 'POST', url: `${GATEWAY}/search/jql` });
    expect(fake.calls[0].headers['content-type']).toBe('application/json');
    expect(fake.calls[0].body).toEqual({ jql: 'project = PAY', fields: ['summary'], maxResults: 100 });
    expect(Object.keys(fake.calls[0].body as object)).toEqual(['jql', 'fields', 'maxResults']);
    expect(fake.calls[1].body).toEqual({ jql: 'project = PAY', fields: ['summary'], maxResults: 100, nextPageToken: 'p1' });
  });

  it('issue, transitions, projects, parseJql and approximateCount build their URLs and bodies', async () => {
    const { fake, client } = build();
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
    await client.issue(auth, 'PAY-1', ['summary', 'status']);
    await client.transitions(auth, 'PAY-1');
    await client.projects(auth, 50);
    await client.parseJql(auth, 'project = PAY');
    await client.approximateCount(auth, 'project = PAY');
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${GATEWAY}/issue/PAY-1?fields=summary%2Cstatus`,
      `GET ${GATEWAY}/issue/PAY-1/transitions`,
      `GET ${GATEWAY}/project/search?startAt=50&maxResults=50`,
      `POST ${GATEWAY}/jql/parse?validation=strict`,
      `POST ${GATEWAY}/search/approximate-count`
    ]);
    expect(fake.calls[3].body).toEqual({ queries: ['project = PAY'] });
    expect(fake.calls[4].body).toEqual({ jql: 'project = PAY' });
  });

  it('never leaks the token, its base64 or the email outside an authorization header', async () => {
    const { fake, client } = build();
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
    await client.tenantInfo(auth.site);
    await client.serverInfo(auth);
    await client.myself(auth);
    await client.myselfAtSite(auth);
    await client.fields(auth);
    await client.search(auth, { jql: 'key = "PAY-1"', fields: ['summary'], maxResults: 100 });
    await client.issue(auth, 'PAY-1', ['summary']);
    await client.transitions(auth, 'PAY-1');
    await client.projects(auth, 0);
    await client.parseJql(auth, 'project = PAY');
    await client.approximateCount(auth, 'project = PAY');

    const b64 = Buffer.from('ada@example.com:t0k3n-SECRET').toString('base64');
    const withoutAuthorization = fake.calls.map((c) => {
      const { authorization: _kept, ...rest } = c.headers;
      return { method: c.method, url: c.url, headers: rest, body: c.body };
    });
    const dump = JSON.stringify(withoutAuthorization);
    expect(dump).not.toContain('t0k3n-SECRET');
    expect(dump).not.toContain(b64);
    expect(dump).not.toContain('ada@example.com');
    // The authorization values themselves carry the base64 and nothing clearer.
    const authValues = fake.calls.map((c) => c.headers.authorization).filter((v): v is string => v !== undefined);
    expect(authValues).toHaveLength(fake.calls.length - 1);
    for (const v of authValues) {
      expect(v).toBe(BASIC);
      expect(v).not.toContain('ada@example.com');
      expect(v).not.toContain('t0k3n-SECRET');
    }
  });
});

describe('response normalisation', () => {
  it('a 200 JSON body is data, with no message and no retryAfter', async () => {
    const { client } = build();
    expect(await client.myself(auth)).toEqual({ status: 200, data: { accountId: 'acc-1', displayName: 'Ada Lovelace' }, message: null, retryAfter: null });
  });

  it('a 204 has data null', async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await new JiraClient(fetchImpl).myself(auth)).toEqual({ status: 204, data: null, message: null, retryAfter: null });
  });

  it('a 400 puts the first errorMessages sentence in message', async () => {
    const { client } = build();
    const out = await client.search(auth, { jql: '', fields: [], maxResults: 100 });
    expect(out).toEqual({ status: 400, data: null, message: UNBOUNDED, retryAfter: null });
  });

  it('a 400 with only field errors renders "field: text"', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errorMessages: [], errors: { assignee: 'User cannot be assigned' } }), { status: 400 })) as unknown as typeof fetch;
    expect((await new JiraClient(fetchImpl).myself(auth)).message).toBe('assignee: User cannot be assigned');
  });

  it('a gateway { code, message } body (its own 401/403) gives its message, after errorMessages and errors yield nothing', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ code: 403, message: 'scope does not match' }), { status: 403 })) as unknown as typeof fetch;
    expect((await new JiraClient(fetchImpl).myself(auth)).message).toBe('scope does not match');
    const { fake, client } = build();
    fake.unauthorized = true;
    expect((await client.myself(auth)).message).toBe('Unauthorized');
  });

  it('errorMessages still wins over a top-level message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errorMessages: ['first'], errors: {}, message: 'second' }), { status: 400 })) as unknown as typeof fetch;
    expect((await new JiraClient(fetchImpl).myself(auth)).message).toBe('first');
  });

  it('a 400 with both arrays empty says "Jira answered 400"', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ errorMessages: [], errors: {} }), { status: 400 })) as unknown as typeof fetch;
    expect((await new JiraClient(fetchImpl).myself(auth)).message).toBe('Jira answered 400');
  });

  it('a 502 with an HTML body says "Jira answered 502" and does not throw on the parse', async () => {
    const fetchImpl = (async () => new Response('<html>Bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    expect(await new JiraClient(fetchImpl).myself(auth)).toEqual({ status: 502, data: null, message: 'Jira answered 502', retryAfter: null });
  });

  // No `last429At` here: the poller stamps the one the status payload shows, from `Date.now()`, where it opens the window (final review minor 6).
  it('a 429 reads retry-after as seconds', async () => {
    const { fake, client } = build();
    fake.rateLimit = { retryAfter: 7 };
    const out = await client.myself(auth);
    expect(out.status).toBe(429);
    expect(out.retryAfter).toBe(7);
    expect('last429At' in client).toBe(false);
  });

  it('a 429 without the header has retryAfter null', async () => {
    const { fake, client } = build();
    fake.rateLimit = { retryAfter: null };
    const out = await client.myself(auth);
    expect(out.status).toBe(429);
    expect(out.retryAfter).toBeNull();
  });

  it('a rejected fetch is status 0 carrying the error message', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND acme.atlassian.net');
    }) as unknown as typeof fetch;
    expect(await new JiraClient(fetchImpl).myself(auth)).toEqual({
      status: 0,
      data: null,
      message: 'getaddrinfo ENOTFOUND acme.atlassian.net',
      retryAfter: null
    });
  });

  // undici's `fetch` rejects with a bare `TypeError('fetch failed')` and puts the reason in `cause`; without it a mistyped `BM_JIRA_SITE` reads as nothing
  // more than "fetch failed" (final review minor 3).
  it.each([
    ['its message', Object.assign(new Error('getaddrinfo ENOTFOUND acme.atlassian.nett'), { code: 'ENOTFOUND' }), 'fetch failed: getaddrinfo ENOTFOUND acme.atlassian.nett'],
    ['its code, when the message is empty', Object.assign(new Error(''), { code: 'ECONNREFUSED' }), 'fetch failed: ECONNREFUSED'],
    ['nothing, for a cause that is not an error', { detail: 'x' }, 'fetch failed']
  ])('a rejection with a cause appends %s', async (_, cause, message) => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause });
    }) as unknown as typeof fetch;
    expect(await new JiraClient(fetchImpl).myself(auth)).toEqual({ status: 0, data: null, message, retryAfter: null });
  });
});

describe('the deadline', () => {
  it('a fetch that never resolves ends as status 0 "timed out after 10000 ms", and the signal is aborted', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const never = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const pending = new JiraClient(never).myself(auth);
    await jest.advanceTimersByTimeAsync(JIRA_TIMEOUT_MS);
    expect(await pending).toEqual({ status: 0, data: null, message: 'timed out after 10000 ms', retryAfter: null });
    expect(signal?.aborted).toBe(true);
  });

  it('does not fire early', async () => {
    jest.useFakeTimers();
    const never = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    let settled = false;
    const pending = new JiraClient(never).myself(auth).then((r) => {
      settled = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(JIRA_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(0);
  });

  it('clears the timer when the response lands', async () => {
    jest.useFakeTimers();
    const { client } = build();
    await client.myself(auth);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('call counting', () => {
  it('counts every call including tenantInfo, and takeCalls returns and resets', async () => {
    const { client } = build();
    await client.tenantInfo(auth.site);
    await client.myself(auth);
    await client.fields(auth);
    expect(client.calls).toBe(3);
    expect(client.takeCalls()).toBe(3);
    expect(client.calls).toBe(0);
    expect(client.takeCalls()).toBe(0);
  });
});

describe('accessOf', () => {
  it.each([
    [200, 'ok'],
    [204, 'ok'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'unreachable'],
    [0, 'unreachable']
  ])('%i -> %s', (status, expected) => {
    expect(accessOf(res(status))).toBe(expected);
  });

  it('a 400 or a 404 says nothing about access', () => {
    expect(accessOf(res(400))).toBeNull();
    expect(accessOf(res(404))).toBeNull();
  });
});

describe('jiraHttpError — spec §8', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z');

  function body(status: number, over: Partial<JiraResponse<unknown>> = {}, opts?: { retryAt?: string }): { http: number; body: unknown } {
    const err = jiraHttpError(res(status, over), opts);
    return { http: err.getStatus(), body: err.getResponse() };
  }

  it('401 -> 503 with access unauthorized', () => {
    expect(body(401)).toEqual({ http: 503, body: { error: 'Jira rejected the credentials', access: 'unauthorized' } });
  });

  it('403 -> 502 "Jira refused: <message>" with access forbidden', () => {
    expect(body(403, { message: 'You do not have the project permission' })).toEqual({
      http: 502,
      body: { error: 'Jira refused: You do not have the project permission', access: 'forbidden' }
    });
  });

  it('429 -> 503 with retryAt now + retryAfter seconds', () => {
    jest.useFakeTimers({ now: NOW });
    const iso = new Date(NOW + 7_000).toISOString();
    expect(body(429, { retryAfter: 7 })).toEqual({ http: 503, body: { error: `Jira rate limit — retry after ${iso}`, access: 'rate-limited', retryAt: iso } });
  });

  it('429 without retryAfter -> now + JIRA_RATE_LIMIT_DEFAULT_MS', () => {
    jest.useFakeTimers({ now: NOW });
    expect(JIRA_RATE_LIMIT_DEFAULT_MS).toBe(60_000);
    const iso = new Date(NOW + 60_000).toISOString();
    expect(body(429)).toEqual({ http: 503, body: { error: `Jira rate limit — retry after ${iso}`, access: 'rate-limited', retryAt: iso } });
  });

  it('429 given opts.retryAt passes it through unchanged, whatever retryAfter and the clock say (P1)', () => {
    jest.useFakeTimers({ now: NOW });
    const stored = '2026-10-16T12:05:00.000Z';
    expect(body(429, { retryAfter: 7 }, { retryAt: stored })).toEqual({
      http: 503,
      body: { error: `Jira rate limit — retry after ${stored}`, access: 'rate-limited', retryAt: stored }
    });
  });

  it('a transport failure or timeout -> 502 "Jira unreachable: <message>" with access unreachable', () => {
    expect(body(0, { message: 'connect ECONNREFUSED' })).toEqual({
      http: 502,
      body: { error: 'Jira unreachable: connect ECONNREFUSED', access: 'unreachable' }
    });
    expect(body(0, { message: 'timed out after 10000 ms' }).body).toMatchObject({ error: 'Jira unreachable: timed out after 10000 ms' });
  });

  it('400 -> 409 "Jira refused: <message>" with no access', () => {
    const out = body(400, { message: UNBOUNDED });
    expect(out).toEqual({ http: 409, body: { error: `Jira refused: ${UNBOUNDED}` } });
    expect(out.body).not.toHaveProperty('access');
  });

  it('404 -> 404 "issue not found" with no access', () => {
    const out = body(404);
    expect(out).toEqual({ http: 404, body: { error: 'issue not found' } });
    expect(out.body).not.toHaveProperty('access');
  });

  it('any other 5xx -> 502 "Jira answered <status>" with access unreachable', () => {
    expect(body(500)).toEqual({ http: 502, body: { error: 'Jira answered 500', access: 'unreachable' } });
    expect(body(503)).toEqual({ http: 502, body: { error: 'Jira answered 503', access: 'unreachable' } });
  });

  it('carries access exactly when accessOf does, and retryAt only on a 429', () => {
    for (const status of [0, 400, 401, 403, 404, 429, 500, 502]) {
      const response = body(status, { message: 'm' }).body as Record<string, unknown>;
      expect('access' in response).toBe(accessOf(res(status)) !== null);
      expect('retryAt' in response).toBe(status === 429);
    }
  });
});

describe('FakeJira', () => {
  function seeded(): { fake: FakeJira; client: JiraClient } {
    const { fake, client } = build();
    for (const key of ['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5']) fake.issues.set(key, makeRawIssue({ key }));
    fake.issues.set('PAY-6', makeRawIssue({ key: 'PAY-6', fields: { parent: { key: 'PAY-1', fields: { summary: 'Epic' } } } }));
    fake.issues.set('PAY-7', makeRawIssue({ key: 'PAY-7', fields: { parent: { key: 'PAY-2', fields: { summary: 'Other' } } } }));
    return { fake, client };
  }
  const search = (client: JiraClient, jql: string, extra: { maxResults?: number; nextPageToken?: string } = {}) =>
    client.search(auth, {
      jql,
      fields: ['summary'],
      maxResults: extra.maxResults ?? 100,
      ...(extra.nextPageToken ? { nextPageToken: extra.nextPageToken } : {})
    });
  const keys = (r: JiraResponse<{ issues: unknown[] }>) => (r.data?.issues as { key: string }[]).map((i) => i.key);

  it('makeRawIssue builds the shapes the mapper reads, and lets a case override them', () => {
    const raw = makeRawIssue({ key: 'PAY-9', fields: { summary: 'Mine' } });
    expect(raw.key).toBe('PAY-9');
    expect(raw.fields.summary).toBe('Mine');
    expect(raw.fields.issuetype).toMatchObject({ hierarchyLevel: 0, subtask: false });
    expect(Array.isArray(raw.fields.customfield_10020)).toBe(true);
    expect(makeRawIssue({ key: 'PAY-9', fields: { parent: { key: 'PAY-1', fields: { summary: 'E' } } } }).fields.parent).toEqual({
      key: 'PAY-1',
      fields: { summary: 'E' }
    });
  });

  it('answers key = "K" from the map, and an unknown key as 200 with no issues (P3)', async () => {
    const { client } = seeded();
    expect(keys((await search(client, 'key = "PAY-3"')) as never)).toEqual(['PAY-3']);
    const none = await search(client, 'key = "ZZZ-9"');
    expect(none.status).toBe(200);
    expect(none.data).toMatchObject({ issues: [], isLast: true });
  });

  it('answers key in (...) in the order asked, skipping unknown keys', async () => {
    const { client } = seeded();
    expect(keys((await search(client, 'key in ("PAY-3", "ZZZ-9", "PAY-1")')) as never)).toEqual(['PAY-3', 'PAY-1']);
  });

  it('answers parent in (...) from fields.parent.key, whatever the spacing', async () => {
    const { client } = seeded();
    expect(keys((await search(client, 'parent in ("PAY-1", "PAY-2")')) as never)).toEqual(['PAY-6', 'PAY-7']);
    expect(keys((await search(client, 'parent   in("PAY-2")')) as never)).toEqual(['PAY-7']);
    expect(keys((await search(client, 'PARENT IN (  "PAY-1"  ,"PAY-9" )')) as never)).toEqual(['PAY-6']);
  });

  it('answers any other JQL from answers by exact text, else a 400 naming a missing field', async () => {
    const { fake, client } = seeded();
    fake.answers.set('project = PAY order by created', ['PAY-2', 'PAY-1']);
    expect(keys((await search(client, 'project = PAY order by created')) as never)).toEqual(['PAY-2', 'PAY-1']);
    const miss = await search(client, 'nonsense = 1');
    expect(miss.status).toBe(400);
    expect(miss.message).toMatch(/^Field 'nonsense' does not exist/);
  });

  it('refuses the empty and order-by-only JQL as unbounded, on search and on the count', async () => {
    const { client } = seeded();
    for (const jql of ['', '   ', 'order by created', 'ORDER BY created DESC']) {
      const out = await search(client, jql);
      expect(out).toMatchObject({ status: 400, message: UNBOUNDED });
      expect(await client.approximateCount(auth, jql)).toMatchObject({ status: 400, message: UNBOUNDED });
    }
  });

  it('pages by maxResults with pN tokens, and the last page says isLast with no token', async () => {
    const { fake, client } = seeded();
    fake.answers.set('all', ['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5']);
    const p1 = await search(client, 'all', { maxResults: 2 });
    expect(keys(p1 as never)).toEqual(['PAY-1', 'PAY-2']);
    expect(p1.data).toMatchObject({ isLast: false, nextPageToken: 'p1' });
    const p2 = await search(client, 'all', { maxResults: 2, nextPageToken: 'p1' });
    expect(keys(p2 as never)).toEqual(['PAY-3', 'PAY-4']);
    expect(p2.data).toMatchObject({ isLast: false, nextPageToken: 'p2' });
    const p3 = await search(client, 'all', { maxResults: 2, nextPageToken: 'p2' });
    expect(keys(p3 as never)).toEqual(['PAY-5']);
    expect(p3.data).toEqual({ issues: expect.any(Array), isLast: true });
  });

  it('omitNextPageToken makes a page say isLast false and carry no token', async () => {
    const { fake, client } = seeded();
    fake.answers.set('all', ['PAY-1', 'PAY-2', 'PAY-3']);
    fake.omitNextPageToken = true;
    const page = await search(client, 'all', { maxResults: 2 });
    expect(page.data).toEqual({ issues: expect.any(Array), isLast: false });
  });

  it('returns only the fields asked for, on search and on issue', async () => {
    const { client } = seeded();
    const s = await client.search(auth, { jql: 'key = "PAY-1"', fields: ['summary', 'status'], maxResults: 100 });
    expect(Object.keys((s.data?.issues[0] as { fields: object }).fields).sort()).toEqual(['status', 'summary']);
    const i = await client.issue(auth, 'PAY-1', ['labels']);
    expect(Object.keys((i.data as unknown as { fields: object }).fields)).toEqual(['labels']);
  });

  it('issue answers 404 for an unknown key; transitions answer the map entry', async () => {
    const { fake, client } = seeded();
    expect((await client.issue(auth, 'ZZZ-1', ['summary'])).status).toBe(404);
    expect((await client.transitions(auth, 'ZZZ-1')).status).toBe(404);
    fake.transitions.set('PAY-1', [{ id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }]);
    expect((await client.transitions(auth, 'PAY-1')).data).toEqual({
      transitions: [{ id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }]
    });
  });

  it('pages project/search by startAt', async () => {
    const { fake, client } = build();
    fake.projects = Array.from({ length: 120 }, (_, n) => ({ key: `P${n}`, name: `Project ${n}` }));
    const first = await client.projects(auth, 0);
    expect(first.data?.values).toHaveLength(50);
    expect(first.data?.isLast).toBe(false);
    const last = await client.projects(auth, 100);
    expect(last.data?.values).toHaveLength(20);
    expect(last.data?.isLast).toBe(true);
  });

  it('parses JQL against parseErrors, and counts from counts, else the matching size', async () => {
    const { fake, client } = seeded();
    fake.parseErrors.set('bad ?', ['Error in the JQL Query: unexpected character']);
    const bad = await client.parseJql(auth, 'bad ?');
    expect(bad.data?.queries[0].errors).toEqual(['Error in the JQL Query: unexpected character']);
    const good = await client.parseJql(auth, 'project = PAY');
    expect(good.data?.queries[0].errors ?? []).toEqual([]);
    fake.counts.set('project = PAY', 1234);
    fake.answers.set('project = OTHER', ['PAY-1', 'PAY-2']);
    expect((await client.approximateCount(auth, 'project = PAY')).data).toEqual({ count: 1234 });
    expect((await client.approximateCount(auth, 'project = OTHER')).data).toEqual({ count: 2 });
    expect((await client.approximateCount(auth, 'parent in ("PAY-1")')).data).toEqual({ count: 1 });
  });

  it('the switches: unauthorized, rateLimit, failWith, siteMyselfStatus', async () => {
    const { fake, client } = build();
    fake.unauthorized = true;
    expect((await client.myself(auth)).status).toBe(401);
    expect((await client.tenantInfo(auth.site)).status).toBe(200);
    fake.unauthorized = false;
    fake.siteMyselfStatus = 401;
    expect((await client.myselfAtSite(auth)).status).toBe(401);
    expect((await client.myself(auth)).status).toBe(200);
    fake.siteMyselfStatus = 200;
    fake.failWith = 503;
    expect((await client.myself(auth)).status).toBe(503);
    fake.failWith = 'transport';
    expect((await client.myself(auth)).status).toBe(0);
    fake.failWith = null;
    fake.rateLimit = { retryAfter: 30 };
    expect(await client.myself(auth)).toMatchObject({ status: 429, retryAfter: 30 });
  });

  it('failNext is consulted before every canned answer and sees each request, so one root can fail while the next proceeds', async () => {
    const { fake, client } = seeded();
    fake.failNext = (call) => (call.url.includes('/issue/PAY-1?') ? { status: 502, body: { errorMessages: ['boom'], errors: {} } } : null);
    expect(await client.issue(auth, 'PAY-1', ['summary'])).toMatchObject({ status: 502, message: 'boom' });
    expect((await client.issue(auth, 'PAY-2', ['summary'])).status).toBe(200);
    fake.failNext = () => 'transport';
    expect((await client.myself(auth)).status).toBe(0);
    fake.failNext = null;
    expect((await client.myself(auth)).status).toBe(200);
  });

  it('every answer carries x-ratelimit-remaining', async () => {
    const { fake } = build();
    const ok = await fake.fetch(`${GATEWAY}/myself`);
    expect(ok.headers.get('x-ratelimit-remaining')).not.toBeNull();
    fake.rateLimit = { retryAfter: 1 };
    const limited = await fake.fetch(`${GATEWAY}/myself`);
    expect(limited.headers.get('x-ratelimit-remaining')).not.toBeNull();
  });
});
