import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { renderTicketBlock } from '../server/src/jira/block';
import { JIRA_JQL_MAX_CHARS } from '../server/src/jira/config.util';
import { JiraClient } from '../server/src/jira/jira.client';
import { JiraLiveService } from '../server/src/jira/live.service';
import { JiraPollerService } from '../server/src/jira/poller.service';
import * as refsUtil from '../server/src/jira/refs.util';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import type { JiraIssueDetail, JiraRepoRefs, JiraStatusPayload, JiraWorktree } from '../shared/types';
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
    ['/jql/check?jql=assignee%20%3D%20currentUser()'],
    ['/prompt?key=PAY-131&action=execute&repo=%2Fwork%2Fpay'],
    ['/refs?repo=%2Fwork%2Fpay'],
    ['/worktrees']
  ])('GET /api/jira%s is 503 Jira is not configured', async (path) => {
    const res = await get(path).expect(503);
    expect(res.body).toEqual({ error: 'Jira is not configured' });
    expect(fake.calls).toEqual([]);
  });

  it('answers a malformed parameter with its 400 before the 503', async () => {
    expect((await get('/issue/pay-1').expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await get('/search').expect(400)).body).toEqual({ error: 'q is required' });
    expect((await get('/prompt?key=pay-1&action=execute&repo=%2Fwork%2Fpay').expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await get('/refs').expect(400)).body).toEqual({ error: 'repo is required' });
    expect((await get('/refs?repo=%2Fwork%2Fpay&key=pay-1').expect(400)).body).toEqual({ error: 'invalid issue key' });
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

    it('carries a reserved key in `live`, starting until confirmed, and is {} once nothing is held', async () => {
      expect((await get('').expect(200)).body.live).toEqual({});
      const live = app.get(JiraLiveService);
      live.reserve('PAY-131', '/work/pay');
      try {
        const starting = (await get('').expect(200)).body as JiraStatusPayload;
        expect(starting.live).toEqual({ 'PAY-131': { name: 'jira PAY-131', startedAt: expect.any(String), repo: '/work/pay', starting: true } });
        live.confirm('PAY-131', 'sess-1');
        expect(((await get('').expect(200)).body as JiraStatusPayload).live['PAY-131'].starting).toBe(false);
      } finally {
        live.clear('PAY-131');
      }
      expect((await get('').expect(200)).body.live).toEqual({});
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

    it('carries `session` for a live key and null for any other', async () => {
      const live = app.get(JiraLiveService);
      live.reserve('PAY-131', '/work/pay');
      try {
        const body = (await get('/issue/PAY-131').expect(200)).body as JiraIssueDetail;
        expect(body.session).toEqual({ name: 'jira PAY-131', startedAt: expect.any(String), repo: '/work/pay', starting: true });
        expect(((await get('/issue/PAY-500').expect(200)).body as JiraIssueDetail).session).toBeNull();
      } finally {
        live.clear('PAY-131');
      }
      expect(((await get('/issue/PAY-131').expect(200)).body as JiraIssueDetail).session).toBeNull();
    });

    it('?format=text is unchanged by a live session: the ticket block of the JSON answer minus the session', async () => {
      const live = app.get(JiraLiveService);
      const before = (await get('/issue/PAY-131?format=text').expect(200)).text;
      live.reserve('PAY-131', '/work/pay');
      try {
        expect((await get('/issue/PAY-131?format=text').expect(200)).text).toBe(before);
      } finally {
        live.clear('PAY-131');
      }
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

/**
 * `GET /api/jira/prompt` (Jira phase 5, Task 4; spec §5 and §8) — what the launch sheet previews and Copy prompt copies. Its own app, because the route reads
 * `repos` and `skills` from `jira.json` and the fixture the other describes use holds neither. The refusals are asserted in the order the route makes them
 * (key, action, repo, unconfigured, unreadable file, unknown skill, Jira's own answer, the mapping, the cap): each case sends a request that is wrong in
 * exactly that way AND in every later way, so a route that checked them in another order would answer a different sentence.
 */
describe('GET /api/jira/prompt', () => {
  const SKILL = { id: 's_0123abcd', name: 'Review it', prompt: 'Review {key} in {repo}, then stop.' };
  const REPO = '/work/pay';
  const q = (params: Record<string, string>) => `/prompt?${new URLSearchParams(params).toString()}`;
  const ok = { key: 'PAY-131', action: 'execute', repo: REPO };

  beforeAll(async () => {
    prepare('prompt');
    writeFileSync(process.env.BM_JIRA_FILE!, JSON.stringify({ repos: { PAY: [REPO] }, skills: [SKILL] }));
    await build(false);
  });
  afterAll(() => app.close());

  it('400 invalid issue key comes first, whatever else is wrong', async () => {
    expect((await get(q({ key: 'pay-1', action: 'nope' })).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await get('/prompt').expect(400)).body).toEqual({ error: 'invalid issue key' });
  });

  it.each([['absent', undefined], ['unknown', 'nope'], ['a skill: with no id', 'skill:'], ['a board id', 'skill:b_0123abcd']])(
    '400 on an action that is %s, before the repo is looked at',
    async (_label, action) => {
      const params: Record<string, string> = { key: 'PAY-131' };
      if (action !== undefined) params.action = action;
      expect((await get(q(params)).expect(400)).body).toEqual({ error: 'action must be execute, context or skill:<id>' });
    }
  );

  it.each([['absent', undefined], ['empty', ''], ['blank', '   ']])('400 repo is required when the repo is %s', async (_label, repo) => {
    const params: Record<string, string> = { key: 'PAY-131', action: 'execute' };
    if (repo !== undefined) params.repo = repo;
    expect((await get(q(params)).expect(400)).body).toEqual({ error: 'repo is required' });
  });

  it('503 while unconfigured comes after the three parameter checks and before any file or Jira read', async () => {
    configure(false);
    try {
      expect((await get(q(ok)).expect(503)).body).toEqual({ error: 'Jira is not configured' });
      expect((await get(q({ ...ok, repo: '' })).expect(400)).body).toEqual({ error: 'repo is required' });
    } finally {
      configure(true);
    }
  });

  it('409 when jira.json cannot be read, ahead of an unknown skill and of any Jira call', async () => {
    const file = process.env.BM_JIRA_FILE!;
    const good = JSON.stringify({ repos: { PAY: [REPO] }, skills: [SKILL] });
    writeFileSync(file, '{ not json');
    const calls = fake.calls.length;
    try {
      const res = await get(q({ ...ok, action: 'skill:s_ffffffff' })).expect(409);
      expect(res.body.error).toMatch(/jira\.json does not parse as JSON/);
      expect(fake.calls.length).toBe(calls);
    } finally {
      writeFileSync(file, good);
    }
  });

  it('400 unknown skill <id> for a well-formed id the file does not hold, before Jira is asked', async () => {
    const calls = fake.calls.length;
    const res = await get(q({ ...ok, key: 'PAY-999', action: 'skill:s_ffffffff' })).expect(400);
    expect(res.body).toEqual({ error: 'unknown skill s_ffffffff' });
    expect(fake.calls.length).toBe(calls);
  });

  it("404 issue not found passes through unwrapJira's mapping, ahead of the repo check", async () => {
    expect((await get(q({ ...ok, key: 'PAY-999', repo: '/elsewhere' })).expect(404)).body).toEqual({ error: 'issue not found' });
  });

  it("400 <repo> is not mapped to <PROJECT>, quoting the repo as sent and using the issue's own project key", async () => {
    expect((await get(q({ ...ok, repo: '/elsewhere' })).expect(400)).body).toEqual({ error: '/elsewhere is not mapped to PAY' });
    // A project with no `repos` entry at all is the same refusal.
    fake.issues.set('ZED-1', makeRawIssue({ key: 'ZED-1', fields: { project: { key: 'ZED', name: 'Zed' } } }));
    expect((await get(q({ ...ok, key: 'ZED-1' })).expect(400)).body).toEqual({ error: `${REPO} is not mapped to ZED` });
  });

  it('200 text/plain for a mapped repo: the execute text first, then the framed ticket block', async () => {
    const res = await get(q(ok)).expect(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text.startsWith('Work on Jira ticket PAY-131 in this repository, end to end')).toBe(true);
    expect(res.text).toContain('BEGIN TICKET');
    expect(res.text).toContain('END TICKET');
  });

  it('the context built-in answers its own text', async () => {
    const res = await get(q({ ...ok, action: 'context' })).expect(200);
    expect(res.text.startsWith('Read Jira ticket PAY-131 below, then wait')).toBe(true);
  });

  it("skill:<id> answers the template's text with its placeholders filled, and no ticket block", async () => {
    const res = await get(q({ ...ok, action: `skill:${SKILL.id}` })).expect(200);
    expect(res.text).toBe(`Review PAY-131 in ${REPO}, then stop.`);
  });

  it.each([
    ['a trailing slash', `${REPO}/`],
    ['surrounding whitespace', `  ${REPO} `]
  ])('matches the stored path after normalising %s', async (_label, repo) => {
    const res = await get(q({ ...ok, repo })).expect(200);
    expect(res.text).toContain('BEGIN TICKET');
  });

  it('matches a ~ spelling against the absolute path stored for it, and quotes the caller\'s spelling when it does not match', async () => {
    const stored = join(homedir(), 'proj');
    writeFileSync(process.env.BM_JIRA_FILE!, JSON.stringify({ repos: { PAY: [stored] }, skills: [SKILL] }));
    try {
      await get(q({ ...ok, repo: '~/proj' })).expect(200);
      await get(q({ ...ok, repo: stored })).expect(200);
      expect((await get(q({ ...ok, repo: '~/other' })).expect(400)).body).toEqual({ error: '~/other is not mapped to PAY' });
    } finally {
      writeFileSync(process.env.BM_JIRA_FILE!, JSON.stringify({ repos: { PAY: [REPO] }, skills: [SKILL] }));
    }
  });

  it('a repo that cannot be normalised (relative) matches nothing and is quoted as sent', async () => {
    expect((await get(q({ ...ok, repo: 'work/pay' })).expect(400)).body).toEqual({ error: 'work/pay is not mapped to PAY' });
  });

  it('400 prompt too long when the template and the facts alone are over the cap, with nothing left to trim', async () => {
    const file = process.env.BM_JIRA_FILE!;
    // A template whose every placeholder is the ticket's url: filled, it is far past 4 000, and a skill's prompt has nothing to trim.
    const tpl = { ...SKILL, prompt: '{url}'.repeat(300) };
    fake.issues.set('PAY-600', makeRawIssue({ key: 'PAY-600', fields: { summary: 'S'.repeat(300) } }));
    writeFileSync(file, JSON.stringify({ repos: { PAY: [REPO] }, skills: [tpl] }));
    try {
      const res = await get(q({ key: 'PAY-600', action: `skill:${SKILL.id}`, repo: REPO })).expect(400);
      expect(res.body).toEqual({ error: 'prompt too long' });
    } finally {
      writeFileSync(file, JSON.stringify({ repos: { PAY: [REPO] }, skills: [SKILL] }));
    }
  });
});

/**
 * `GET /api/jira/refs` and `GET /api/jira/worktrees` (Jira repo/branch, Task 3; spec §4 and §5.2) — the launch sheet's branch picker and Setup's warnings. The
 * git reads are stubbed here (`jira-refs.test.ts` runs them against real git): what this suite owns is the contract around them — the order of the refusals,
 * the mapping check, the distinct-path rule and the shape handed back. Its own app for the same reason the prompt's is: the routes read `repos` from `jira.json`.
 */
describe('GET /api/jira/refs and /api/jira/worktrees', () => {
  const PAY = '/work/pay';
  const SHARED = '/work/shared';
  const OTHER = '/work/other';
  const REFS: JiraRepoRefs = {
    repo: PAY,
    available: true,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    mainBranch: 'develop',
    defaultBase: 'develop',
    branches: [{ name: 'develop', local: true, remote: true, sync: 'same', committedAt: '2026-01-01T00:00:00.000Z', worktree: PAY, ticket: false }]
  };
  let refs: jest.SpyInstance;
  let trees: jest.SpyInstance;

  beforeAll(async () => {
    prepare('refs');
    writeFileSync(process.env.BM_JIRA_FILE!, JSON.stringify({ repos: { PAY: [PAY, SHARED], OPS: [SHARED, OTHER] }, repoDefaults: { [OTHER]: { base: 'release/9' } } }));
    await build(false);
  });
  afterAll(() => app.close());
  beforeEach(() => {
    refs = jest.spyOn(refsUtil, 'readRepoRefs').mockResolvedValue(REFS);
    trees = jest.spyOn(refsUtil, 'readWorktrees').mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  const q = (params: Record<string, string>) => `/refs?${new URLSearchParams(params).toString()}`;

  it.each([['absent', undefined], ['empty', ''], ['blank', '   ']])('400 repo is required when the repo is %s', async (_label, repo) => {
    expect((await get(repo === undefined ? '/refs' : q({ repo })).expect(400)).body).toEqual({ error: 'repo is required' });
    expect(refs).not.toHaveBeenCalled();
  });

  it.each([['lower case', 'pay-1'], ['no number', 'PAY'], ['empty', '']])('400 invalid issue key for a key that is %s, before the repo is looked at', async (_label, key) => {
    expect((await get(q({ repo: '/not/mapped', key })).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect(refs).not.toHaveBeenCalled();
  });

  it('400 <repo> is not mapped when the normalised path is in no project\'s list, quoting the repo as sent', async () => {
    expect((await get(q({ repo: '/work/elsewhere' })).expect(400)).body).toEqual({ error: '/work/elsewhere is not mapped' });
    expect((await get(q({ repo: 'work/pay' })).expect(400)).body).toEqual({ error: 'work/pay is not mapped' });
    expect(refs).not.toHaveBeenCalled();
  });

  it('200 hands the stubbed refs back unchanged, for a path in ANY project\'s list, with a trailing slash dropped', async () => {
    expect((await get(q({ repo: PAY })).expect(200)).body).toEqual(REFS);
    await get(q({ repo: `${OTHER}/` })).expect(200);
    expect(refs.mock.calls[1][0]).toBe(OTHER);
  });

  it('passes the repo\'s stored default base, found by the normalised path, and null for a repo with none', async () => {
    await get(q({ repo: `${OTHER}/`, key: 'PAY-1' })).expect(200);
    await get(q({ repo: SHARED })).expect(200);
    expect(refs.mock.calls.map((c) => [c[0], c[3]])).toEqual([[OTHER, 'release/9'], [SHARED, null]]);
  });

  it('passes the key (null without one), the roots from the environment and a null stored base', async () => {
    const saved = process.env.BM_REPO_ROOTS;
    process.env.BM_REPO_ROOTS = '/work:/more';
    try {
      await get(q({ repo: PAY, key: 'PAY-131' })).expect(200);
      await get(q({ repo: PAY })).expect(200);
    } finally {
      if (saved === undefined) delete process.env.BM_REPO_ROOTS;
      else process.env.BM_REPO_ROOTS = saved;
    }
    expect(refs.mock.calls).toEqual([
      [PAY, 'PAY-131', ['/work', '/more'], null],
      [PAY, null, ['/work', '/more'], null]
    ]);
  });

  it('answers an unavailable repo as a 200 with its reason — the sheet shows it, it is not an error', async () => {
    const down: JiraRepoRefs = { repo: PAY, available: false, reason: 'not mounted into the board' };
    refs.mockResolvedValue(down);
    expect((await get(q({ repo: PAY })).expect(200)).body).toEqual(down);
  });

  it('409 when jira.json cannot be read, on both routes', async () => {
    const file = process.env.BM_JIRA_FILE!;
    const good = JSON.stringify({ repos: { PAY: [PAY, SHARED], OPS: [SHARED, OTHER] } });
    writeFileSync(file, '{ not json');
    try {
      for (const path of [q({ repo: PAY }), '/worktrees']) {
        const res = await get(path).expect(409);
        expect(res.body.error).toMatch(/^settings\/jira\.json does not parse as JSON/);
      }
      expect(refs).not.toHaveBeenCalled();
      expect(trees).not.toHaveBeenCalled();
    } finally {
      writeFileSync(file, good);
    }
  });

  it('/worktrees reads every distinct mapped path once, even when two projects map it, and reports an unavailable one', async () => {
    const tree: JiraWorktree = { repo: PAY, path: PAY, branch: 'develop', main: true };
    trees.mockImplementation(async (repo: string) => (repo === OTHER ? 'does not exist' : repo === PAY ? [tree] : []));
    const res = await get('/worktrees').expect(200);
    expect(res.body).toEqual({ worktrees: [tree], unavailable: [{ repo: OTHER, reason: 'does not exist' }] });
    expect(trees.mock.calls.map((c) => c[0]).sort()).toEqual([OTHER, PAY, SHARED]);
  });

  it('/worktrees is an empty payload when nothing is mapped', async () => {
    const file = process.env.BM_JIRA_FILE!;
    const good = JSON.stringify({ repos: { PAY: [PAY, SHARED], OPS: [SHARED, OTHER] } });
    writeFileSync(file, '{}');
    try {
      expect((await get('/worktrees').expect(200)).body).toEqual({ worktrees: [], unavailable: [] });
      expect(trees).not.toHaveBeenCalled();
    } finally {
      writeFileSync(file, good);
    }
  });
});
