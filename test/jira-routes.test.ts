import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { renderTicketBlock } from '../server/src/jira/block';
import { JIRA_JQL_MAX_CHARS } from '../server/src/jira/config.util';
import { JiraClient } from '../server/src/jira/jira.client';
import { JiraPollerService } from '../server/src/jira/poller.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import type { JiraIssueDetail, JiraStatusPayload } from '../shared/types';
import { listenLoopback } from './helpers/app';
import { FakeJira, makeRawIssue } from './helpers/jira';
import { makeRegistry } from './helpers/store';

/**
 * Jira phase 1 — the six read routes under `/api/jira` over the real `AppModule` (spec §8 and §12; preflight rulings P3, P8, P9, P10, P11, P14, P18).
 *
 * One app per describe, because the configuration IS the describe: the keys and the fake's switches must be in place BEFORE `app.init()` (the poller's boot
 * tick runs at init), and a 429 window or a 401 opened by one case would turn every later case in the same app into that refusal. Every app is built on
 * a `JiraClient` over a fake `fetch`, so nothing here can reach a real Jira, and `REGISTRY_FILE` points at a temp registry so no real one is read.
 */

const EMAIL = 'ada@example.com';
const TOKEN = 't0k3n-SECRET';
const B1 = 'b_0123abcd';
const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE'] as const;

let saved: Record<string, string | undefined>;
let dir: string;
let fake: FakeJira;
let app: INestApplication;
let poller: JiraPollerService;

function configure(on: boolean): void {
  process.env.BM_JIRA_SITE = on ? 'acme.atlassian.net' : '';
  process.env.BM_JIRA_EMAIL = on ? EMAIL : '';
  process.env.BM_JIRA_TOKEN = on ? TOKEN : '';
}

/** The epic PAY-120 → story PAY-131 → subtask PAY-132, plus PAY-500, which no board's roots reach. */
function seed(f: FakeJira): void {
  const parent = (key: string) => ({ key, fields: { summary: `Summary of ${key}` } });
  f.issues.set('PAY-120', makeRawIssue({ key: 'PAY-120', fields: { issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false } } }));
  f.issues.set('PAY-131', makeRawIssue({ key: 'PAY-131', fields: { parent: parent('PAY-120') } }));
  f.issues.set(
    'PAY-132',
    makeRawIssue({ key: 'PAY-132', fields: { parent: parent('PAY-131'), issuetype: { name: 'Sub-task', hierarchyLevel: -1, subtask: true } } })
  );
  f.issues.set('PAY-500', makeRawIssue({ key: 'PAY-500' }));
  f.transitions.set('PAY-131', [{ id: '31', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }]);
}

/** Builds the app on `fake` and waits for the boot tick, so a case starts from a settled poller. */
async function build(boards: boolean): Promise<void> {
  if (boards) {
    writeFileSync(process.env.BM_JIRA_FILE!, JSON.stringify({ boards: [{ id: B1, name: 'Payments', roots: ['PAY-120'], queries: [], interval: '1m' }] }));
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry([]))
    .overrideProvider(JiraClient)
    .useValue(new JiraClient(fake.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  poller = app.get(JiraPollerService);
  await poller.tick();
}

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-routes-'));
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh fake and a fresh `jira.json` path per describe. */
function prepare(name: string, on = true): void {
  configure(on);
  process.env.BM_JIRA_FILE = join(dir, `${name}.json`);
  fake = new FakeJira();
  seed(fake);
}

const get = (path: string) => request(app.getHttpServer()).get(`/api/jira${path}`);
const searches = () => fake.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => (c.body as { jql: string }).jql);

describe('unconfigured', () => {
  beforeAll(async () => {
    prepare('unconfigured', false);
    await build(false);
  });
  afterAll(() => app.close());

  it('GET /api/jira is 200 with configured: false, and the poller is not armed', async () => {
    const res = await get('').expect(200);
    expect(res.body).toMatchObject({ configured: false, access: 'unconfigured', detail: 'BM_JIRA_SITE is not set', boards: [] });
    expect(poller.armed).toBe(false);
  });

  // Well-formed parameters throughout (P9): a malformed one is a 400 before the 503, so a case that sent one would not be asking about configuration.
  it.each([
    [`/boards/${B1}/issues`],
    ['/issue/PAY-131'],
    ['/issue/PAY-131?format=text'],
    ['/search?q=pay'],
    ['/search?q='],
    ['/projects'],
    ['/jql/check?jql=assignee%20%3D%20currentUser()']
  ])('GET /api/jira%s is 503 Jira is not configured', async (path) => {
    const res = await get(path).expect(503);
    expect(res.body).toEqual({ error: 'Jira is not configured' });
    expect(fake.calls).toEqual([]);
  });

  it('answers a malformed parameter with its 400 before the 503', async () => {
    expect((await get('/issue/pay-1').expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await get('/search').expect(400)).body).toEqual({ error: 'q is required' });
  });
});

describe('configured, against a healthy Jira', () => {
  beforeAll(async () => {
    prepare('healthy');
    fake.projects = [
      { key: 'ZED', name: 'Zed' },
      { key: 'PAY', name: 'Payments' }
    ];
    fake.counts.set('assignee = currentUser()', 875);
    fake.parseErrors.set('assignee = = x', ['Error in the JQL Query: unexpected token']);
    await build(true);
  });
  afterAll(() => app.close());
  afterEach(() => {
    fake.failNext = null;
    fake.failWith = null;
  });

  describe('GET /api/jira', () => {
    it('is 200 with the site, identity, token kind and board statuses, and never the credentials', async () => {
      const res = await get('').expect(200);
      const body = res.body as JiraStatusPayload;
      expect(body).toMatchObject({
        configured: true,
        site: 'acme.atlassian.net',
        me: { accountId: 'acc-1', name: 'Ada Lovelace' },
        tokenKind: 'classic',
        access: 'ok'
      });
      expect(body.boards).toEqual([expect.objectContaining({ id: B1, name: 'Payments', count: 3, truncated: false, failures: [] })]);
      expect(res.text).not.toContain(TOKEN);
      expect(res.text).not.toContain(EMAIL);
    });

    it('arms the poller for a 1m board', () => {
      // `armed` reads false mid-tick, so it is asked after `await poller.tick()`, which `build` did.
      expect(poller.armed).toBe(true);
    });

    it('is refused for a Host the allowlist does not know', async () => {
      await get('').set('host', 'evil.example:4322').expect(403);
    });
  });

  describe('GET /api/jira/boards/:id/issues', () => {
    it('is 200 { issues, polledAt } for a board the file holds', async () => {
      const res = await get(`/boards/${B1}/issues`).expect(200);
      expect(res.body.issues.map((i: { key: string }) => i.key).sort()).toEqual(['PAY-120', 'PAY-131', 'PAY-132']);
      expect(typeof res.body.polledAt).toBe('string');
    });

    it.each([
      ['a well-formed id the file does not hold', 'b_ffffffff'],
      ['an id that is not one', 'b_zz'],
      ['a query id (P10: the board form only)', 'q_0123abcd']
    ])('is 404 unknown board for %s', async (_label, id) => {
      expect((await get(`/boards/${id}/issues`).expect(404)).body).toEqual({ error: 'unknown board' });
    });
  });

  describe('GET /api/jira/issue/:key', () => {
    it('400 for a key that is not one, and for a format that is not text', async () => {
      expect((await get('/issue/pay-1').expect(400)).body).toEqual({ error: 'invalid issue key' });
      expect((await get('/issue/PAY-131?format=html').expect(400)).body).toEqual({ error: 'format must be text' });
    });

    it('404 issue not found for a key the fake does not hold', async () => {
      expect((await get('/issue/PAY-999').expect(404)).body).toEqual({ error: 'issue not found' });
    });

    it('200 with the JiraIssueDetail JSON', async () => {
      const res = await get('/issue/PAY-131').expect(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      const body = res.body as JiraIssueDetail;
      expect(body).toMatchObject({ key: 'PAY-131', boards: [B1], session: null });
      expect(body.children.map((c) => c.key)).toEqual(['PAY-132']);
      expect(body.transitions).toEqual([{ id: '31', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' } }]);
    });

    it('200 with boards: [] for a key on no board — the read is fresh, the caches have no say', async () => {
      const res = await get('/issue/PAY-500').expect(200);
      expect(res.body).toMatchObject({ key: 'PAY-500', boards: [] });
    });

    it('?format=text is text/plain with the ticket block of the JSON answer (P14, P18)', async () => {
      const json = (await get('/issue/PAY-131').expect(200)).body as JiraIssueDetail;
      const res = await get('/issue/PAY-131?format=text').expect(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.text).toBe(renderTicketBlock(json));
    });

    it('403 → 502 Jira refused, and the site state is left alone', async () => {
      fake.failNext = (c) =>
        c.url.includes('/issue/PAY-131') && !c.url.endsWith('/transitions') ? { status: 403, body: { errorMessages: ['No access'] } } : null;
      const res = await get('/issue/PAY-131').expect(502);
      expect(res.body).toEqual({ error: 'Jira refused: No access', access: 'forbidden' });
      expect((await get('').expect(200)).body.access).toBe('ok');
    });

    it('a transport failure → 502 Jira unreachable', async () => {
      fake.failWith = 'transport';
      const res = await get('/issue/PAY-131').expect(502);
      expect(res.body).toEqual({ error: 'Jira unreachable: fetch failed', access: 'unreachable' });
    });

    it('a 500 → 502 Jira answered 500', async () => {
      fake.failWith = 500;
      const res = await get('/issue/PAY-131').expect(502);
      expect(res.body).toEqual({ error: 'Jira answered 500', access: 'unreachable' });
    });
  });

  describe('GET /api/jira/search', () => {
    it('400 q is required without a q', async () => {
      expect((await get('/search').expect(400)).body).toEqual({ error: 'q is required' });
    });

    it.each([[''], ['%20%20']])('200 [] for a blank q (%j)', async (q) => {
      const before = fake.calls.length;
      expect((await get(`/search?q=${q}`).expect(200)).body).toEqual([]);
      expect(fake.calls.length).toBe(before);
    });

    it('?q=pay-131 finds the one issue, asked as an exact key', async () => {
      const res = await get('/search?q=pay-131').expect(200);
      expect(res.body.map((i: { key: string }) => i.key)).toEqual(['PAY-131']);
      expect(searches().at(-1)).toBe('key = "PAY-131"');
    });

    it('400 for a q of 101 characters, 200 for 100', async () => {
      expect((await get(`/search?q=${'a'.repeat(101)}`).expect(400)).body).toEqual({ error: 'q is too long (max 100)' });
      // The fake answers a summary search only from `answers`, by exact JQL; the one at the limit is seeded so it is a 200, not Jira's field error.
      fake.answers.set(`summary ~ "${'a'.repeat(100)}*"`, []);
      expect((await get(`/search?q=${'a'.repeat(100)}`).expect(200)).body).toEqual([]);
    });

    it('a Jira 400 → 409 Jira refused', async () => {
      fake.failNext = (c) => (c.url.endsWith('/search/jql') ? { status: 400, body: { errorMessages: ['bad query'] } } : null);
      expect((await get('/search?q=pay').expect(409)).body).toEqual({ error: 'Jira refused: bad query' });
    });
  });

  describe('GET /api/jira/projects', () => {
    it('is the list sorted by key', async () => {
      expect((await get('/projects').expect(200)).body).toEqual([
        { key: 'PAY', name: 'Payments' },
        { key: 'ZED', name: 'Zed' }
      ]);
    });
  });

  describe('GET /api/jira/jql/check', () => {
    it('400 jql is required without one, or with a blank one', async () => {
      expect((await get('/jql/check').expect(400)).body).toEqual({ error: 'jql is required' });
      expect((await get('/jql/check?jql=%20').expect(400)).body).toEqual({ error: 'jql is required' });
    });

    it('200 { ok: true, count } for a query Jira parses', async () => {
      expect((await get('/jql/check?jql=assignee%20%3D%20currentUser()').expect(200)).body).toEqual({ ok: true, count: 875 });
    });

    it('200 { ok: false, message } for a parse error — an answer, not a 4xx', async () => {
      const res = await get(`/jql/check?jql=${encodeURIComponent('assignee = = x')}`).expect(200);
      expect(res.body).toEqual({ ok: false, message: 'Error in the JQL Query: unexpected token' });
    });

    it(`400 over JIRA_JQL_MAX_CHARS characters (P11), and not at the limit`, async () => {
      expect(JIRA_JQL_MAX_CHARS).toBe(2000);
      const over = await get(`/jql/check?jql=${'a'.repeat(JIRA_JQL_MAX_CHARS + 1)}`).expect(400);
      expect(over.body).toEqual({ error: 'jql is too long (max 2000)' });
      await get(`/jql/check?jql=${'a'.repeat(JIRA_JQL_MAX_CHARS)}`).expect(200);
    });
  });

  describe('what this phase does not have', () => {
    it('GET /api/jira/prompt is 404', async () => {
      await get('/prompt').expect(404);
    });
  });
});

describe('configured, tenant_info unreachable at boot (P3, Review Focus 2)', () => {
  let callsAfterBoot: number;

  beforeAll(async () => {
    prepare('tenant-down');
    fake.failNext = (c) => (c.url.endsWith('/_edge/tenant_info') ? 'transport' : null);
    await build(true);
    callsAfterBoot = fake.calls.length;
  });
  afterAll(() => app.close());

  it('GET /api/jira is still 200: unreachable, with the error in detail', async () => {
    const res = await get('').expect(200);
    expect(res.body).toMatchObject({ configured: true, access: 'unreachable', detail: 'fetch failed', me: null });
  });

  it('a fresh read sends no call and answers 502 Jira unreachable: <detail>', async () => {
    const res = await get('/issue/PAY-1').expect(502);
    expect(res.body).toEqual({ error: 'Jira unreachable: fetch failed', access: 'unreachable' });
    expect(fake.calls.length).toBe(callsAfterBoot);
  });
});

describe('configured, an unsupported site (P5, final review minor 4)', () => {
  beforeAll(async () => {
    prepare('unsupported');
    fake.deploymentType = 'Server';
    await build(false);
  });
  afterAll(() => app.close());

  it('a fresh read answers 502 with access unsupported — what GET /api/jira says — and sends no call', async () => {
    expect((await get('').expect(200)).body.access).toBe('unsupported');
    const calls = fake.calls.length;
    const res = await get('/issue/PAY-131').expect(502);
    expect(res.body).toEqual({ error: 'Jira unreachable: Jira Server/DC is not supported', access: 'unsupported' });
    expect(fake.calls.length).toBe(calls);
  });
});

describe('configured, a route meets a 429 (P8)', () => {
  beforeAll(async () => {
    prepare('rate-limited');
    // Boot finishes normally: the window must be opened by the ROUTE's own 429, not by the boot's.
    await build(false);
  });
  afterAll(() => app.close());

  it('503 with retryAt, then the same 503 and the same retryAt for a read inside the window, with no call sent', async () => {
    fake.rateLimit = { retryAfter: 30 };
    const first = await get('/issue/PAY-131').expect(503);
    expect(first.body.error).toMatch(/^Jira rate limit — retry after /);
    expect(first.body).toMatchObject({ access: 'rate-limited', error: `Jira rate limit — retry after ${first.body.retryAt}` });
    expect(Date.parse(first.body.retryAt)).toBeGreaterThan(Date.now());

    const callsInWindow = fake.calls.length;
    const second = await get('/issue/PAY-131').expect(503);
    expect(second.body).toEqual(first.body);
    expect(fake.calls.length).toBe(callsInWindow);
    expect((await get('/projects').expect(503)).body.retryAt).toBe(first.body.retryAt);
    expect(fake.calls.length).toBe(callsInWindow);
    expect((await get('').expect(200)).body.access).toBe('rate-limited');
  });
});

describe('configured, the credentials are rejected', () => {
  beforeAll(async () => {
    prepare('unauthorized');
    await build(false);
  });
  afterAll(() => app.close());

  it('a 401 on a route is 503 Jira rejected the credentials, moves the site state, and holds for the next route', async () => {
    fake.unauthorized = true;
    const res = await get('/issue/PAY-131').expect(503);
    expect(res.body).toEqual({ error: 'Jira rejected the credentials', access: 'unauthorized' });
    expect((await get('/projects').expect(503)).body).toEqual({ error: 'Jira rejected the credentials', access: 'unauthorized' });
    expect((await get('').expect(200)).body).toMatchObject({ access: 'unauthorized', me: null });
  });
});
