import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { JiraClient } from '../server/src/jira/jira.client';
import { JiraPollerService } from '../server/src/jira/poller.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import type { JiraIssue, JiraStatusPayload } from '../shared/types';
import { listenLoopback } from './helpers/app';
import { FakeJira, makeRawIssue } from './helpers/jira';
import type { FakeTransition } from './helpers/jira';
import { makeRegistry } from './helpers/store';

/**
 * Jira phase 3 — the two issue-write routes, `POST /api/jira/issue/assign` and `/issue/transition`, over the real `AppModule` (plan Task 3; rulings R1–R3;
 * Review Focus 4 and 5). Built like `test/jira-write-routes.test.ts`: one app per describe, because the configuration and the fake's switches ARE the
 * describe and must be in place before `app.init()`, every app on a `JiraClient` over a fake `fetch` so nothing here reaches a real Jira.
 *
 * The board is the epic PAY-120 with the stories PAY-131 … PAY-135 under it, so a write's effect is read where a person reads it — `GET
 * /api/jira/boards/:id/issues` — and each case has an issue of its own (the fake's writes are real: an assign stays assigned for the next case).
 */

const EMAIL = 'ada@example.com';
const TOKEN = 't0k3n-SECRET';
const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE'] as const;
const B1 = 'b_0123abcd';
const START: FakeTransition = { id: '31', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } };
const ME = { accountId: 'acc-1', name: 'Ada Lovelace' };

let saved: Record<string, string | undefined>;
let dir: string;
let file: string;
let fake: FakeJira;
let app: INestApplication;
let poller: JiraPollerService;

function configure(on: boolean): void {
  process.env.BM_JIRA_SITE = on ? 'acme.atlassian.net' : '';
  process.env.BM_JIRA_EMAIL = on ? EMAIL : '';
  process.env.BM_JIRA_TOKEN = on ? TOKEN : '';
}

/** A fresh fake, seeded, and a fresh `jira.json` holding the one board, per describe. */
function prepare(name: string, opts: { on?: boolean } = {}): void {
  configure(opts.on ?? true);
  file = join(dir, `${name}.json`);
  process.env.BM_JIRA_FILE = file;
  writeFileSync(file, JSON.stringify({ boards: [{ id: B1, name: 'Payments', roots: ['PAY-120'], queries: [], interval: '1m' }] }));
  fake = new FakeJira();
  const parent = { key: 'PAY-120', fields: { summary: 'Summary of PAY-120' } };
  fake.issues.set('PAY-120', makeRawIssue({ key: 'PAY-120', fields: { issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false } } }));
  for (const key of ['PAY-131', 'PAY-132', 'PAY-133', 'PAY-134', 'PAY-135']) {
    fake.issues.set(key, makeRawIssue({ key, fields: { parent } }));
    fake.transitions.set(key, [START]);
  }
}

async function build(): Promise<void> {
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
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-issue-write-'));
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  request(app.getHttpServer()).post(`/api/jira${path}`).set('content-type', 'application/json').send(JSON.stringify(body));
const status = async (): Promise<JiraStatusPayload> => (await request(app.getHttpServer()).get('/api/jira').expect(200)).body;
const board = async (): Promise<JiraIssue[]> => (await request(app.getHttpServer()).get(`/api/jira/boards/${B1}/issues`).expect(200)).body.issues;
const card = async (key: string): Promise<JiraIssue> => (await board()).find((i) => i.key === key)!;
/** The calls that changed something in Jira: the assignee PUT and the transition POST (a transitions GET is a read). */
const writes = () => fake.calls.filter((c) => c.method === 'PUT' || (c.method === 'POST' && c.url.endsWith('/transitions')));
const puts = () => fake.calls.filter((c) => c.method === 'PUT');
const transitionCalls = () => fake.calls.filter((c) => c.url.endsWith('/transitions'));
const isIssueGet = (c: { method: string; url: string }) => c.method === 'GET' && /\/issue\/PAY-\d+(\?.*)?$/.test(c.url);

const ROUTES = [
  ['/issue/assign', { key: 'PAY-131' }],
  ['/issue/transition', { key: 'PAY-131', transitionId: '31' }]
] as const;

describe('the guard, on both routes', () => {
  beforeAll(async () => {
    prepare('guard');
    await build();
  });
  afterAll(() => app.close());

  it.each(ROUTES)('POST %s with no content type is 403, and Jira is not called', async (path) => {
    const before = fake.calls.length;
    await request(app.getHttpServer()).post(`/api/jira${path}`).send('{}').expect(403);
    expect(fake.calls).toHaveLength(before);
  });

  it.each(ROUTES)('POST %s from another origin is 403, and Jira is not called', async (path, body) => {
    const before = fake.calls.length;
    await post(path, body).set('origin', 'http://evil.test').expect(403);
    expect(fake.calls).toHaveLength(before);
  });

  it.each(ROUTES)('POST %s to a Host the allowlist does not know is 403', async (path, body) => {
    await post(path, body).set('host', 'evil.example:4322').expect(403);
  });
});

describe('unconfigured', () => {
  beforeAll(async () => {
    prepare('unconfigured', { on: false });
    await build();
  });
  afterAll(() => app.close());

  it.each(ROUTES)('POST %s is 503 Jira is not configured, and no Jira call is made', async (path, body) => {
    expect((await post(path, body).expect(503)).body).toEqual({ error: 'Jira is not configured' });
    expect(fake.calls).toEqual([]);
  });

  it('a malformed body is a 400 before the 503', async () => {
    expect((await post('/issue/assign', { key: 'pay-1' }).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await post('/issue/transition', { key: 'PAY-1', transitionId: '' }).expect(400)).body).toEqual({
      error: 'transitionId must be a non-empty string'
    });
  });
});

describe('validation', () => {
  beforeAll(async () => {
    prepare('validation');
    await build();
  });
  afterAll(() => app.close());

  it.each([[{ key: 'pay-1' }], [{}], [{ key: 7 }], [{ key: 'PAY-1; DROP' }], [[]]])('assign with %j is 400 invalid issue key, with no Jira call', async (body) => {
    const before = fake.calls.length;
    expect((await post('/issue/assign', body).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect(fake.calls).toHaveLength(before);
  });

  it.each([[{ key: 'pay-1', transitionId: '31' }], [{ transitionId: '31' }], [{ key: 7, transitionId: '31' }]])(
    'transition with %j is 400 invalid issue key, with no Jira call',
    async (body) => {
      const before = fake.calls.length;
      expect((await post('/issue/transition', body).expect(400)).body).toEqual({ error: 'invalid issue key' });
      expect(fake.calls).toHaveLength(before);
    }
  );

  it.each([[undefined], [''], [31], [null], ['x'.repeat(65)]])('transition with transitionId %j is 400, with no Jira call', async (transitionId) => {
    const before = fake.calls.length;
    const res = await post('/issue/transition', { key: 'PAY-131', transitionId }).expect(400);
    expect(res.body).toEqual({ error: 'transitionId must be a non-empty string' });
    expect(fake.calls).toHaveLength(before);
  });

  it('a transitionId of exactly 64 characters passes validation and meets the offered check', async () => {
    const res = await post('/issue/transition', { key: 'PAY-131', transitionId: 'x'.repeat(64) }).expect(400);
    expect(res.body).toEqual({ error: 'transition not offered' });
  });
});

describe('against a healthy Jira', () => {
  beforeAll(async () => {
    prepare('healthy');
    await build();
  });
  afterAll(() => app.close());

  it('assign: 200 { ok, reread: true }, and the board list shows the assignee with no sweep in between', async () => {
    expect((await card('PAY-131')).assignee).toBeNull();
    const sweeps = fake.calls.filter((c) => c.url.endsWith('/search/jql')).length;
    const res = await post('/issue/assign', { key: 'PAY-131' }).expect(200);
    expect(res.body).toEqual({ ok: true, reread: true });
    expect(puts().map((c) => c.body)).toEqual([{ accountId: 'acc-1' }]);
    expect((await card('PAY-131')).assignee).toEqual(ME);
    expect(fake.calls.filter((c) => c.url.endsWith('/search/jql'))).toHaveLength(sweeps);
  });

  it('assign ignores an accountId in the body: only the signed-in user can be assigned', async () => {
    await post('/issue/assign', { key: 'PAY-135', accountId: 'someone-else' }).expect(200);
    expect(puts().at(-1)!.body).toEqual({ accountId: 'acc-1' });
  });

  it('transition: 200, and the board list shows the new status', async () => {
    expect((await card('PAY-132')).status).toEqual({ name: 'To Do', category: 'new' });
    const res = await post('/issue/transition', { key: 'PAY-132', transitionId: '31' }).expect(200);
    expect(res.body).toEqual({ ok: true, reread: true });
    expect((await card('PAY-132')).status).toEqual({ name: 'In Progress', category: 'indeterminate' });
  });

  it('a transition the issue does not offer is 400 transition not offered, and nothing is posted', async () => {
    const before = writes().length;
    const res = await post('/issue/transition', { key: 'PAY-133', transitionId: '99' }).expect(400);
    expect(res.body).toEqual({ error: 'transition not offered' });
    expect(writes()).toHaveLength(before);
    expect((await card('PAY-133')).status).toEqual({ name: 'To Do', category: 'new' });
  });

  it('an issue Jira does not have is 404 issue not found', async () => {
    expect((await post('/issue/assign', { key: 'PAY-999' }).expect(404)).body).toEqual({ error: 'issue not found' });
    expect((await post('/issue/transition', { key: 'PAY-999', transitionId: '31' }).expect(404)).body).toEqual({ error: 'issue not found' });
  });

  it('Review Focus 5: a write that lands but whose re-read fails is 200 reread: false, and the card is untouched', async () => {
    fake.failNext = (c) => (isIssueGet(c) ? { status: 500, body: { errorMessages: ['boom'] } } : null);
    try {
      const res = await post('/issue/assign', { key: 'PAY-134' }).expect(200);
      expect(res.body).toEqual({ ok: true, reread: false });
    } finally {
      fake.failNext = null;
    }
    expect(puts().at(-1)!.url).toContain('/issue/PAY-134/assignee');
    expect((await card('PAY-134')).assignee).toBeNull();
    // A 5xx on a route's read says nothing about the site (§8): the state is as it was.
    expect((await status()).access).toBe('ok');
  });
});

describe('what Jira says to a write', () => {
  beforeAll(async () => {
    prepare('refusals');
    await build();
  });
  afterEach(() => {
    fake.failNext = null;
  });
  afterAll(() => app.close());

  const answerPut = (answer: { status: number; body?: unknown; headers?: Record<string, string> } | 'transport') => {
    fake.failNext = (c) => (c.method === 'PUT' ? answer : null);
  };

  it('400 User cannot be assigned → 409 Jira refused: <message>', async () => {
    answerPut({ status: 400, body: { errorMessages: ['User cannot be assigned'] } });
    const res = await post('/issue/assign', { key: 'PAY-131' }).expect(409);
    expect(res.body).toEqual({ error: 'Jira refused: User cannot be assigned' });
  });

  it('403 → 502 Jira refused: <message>, and the site is not marked forbidden by it', async () => {
    answerPut({ status: 403, body: { errorMessages: ['You cannot assign issues.'] } });
    const res = await post('/issue/assign', { key: 'PAY-131' }).expect(502);
    expect(res.body).toMatchObject({ error: 'Jira refused: You cannot assign issues.' });
    expect((await status()).access).toBe('ok');
  });

  it('404 on the PUT → 404 issue not found', async () => {
    answerPut({ status: 404, body: { errorMessages: ['Issue does not exist'] } });
    expect((await post('/issue/assign', { key: 'PAY-131' }).expect(404)).body).toEqual({ error: 'issue not found' });
  });

  it('a transport failure → 502 Jira unreachable: <message>', async () => {
    answerPut('transport');
    const res = await post('/issue/assign', { key: 'PAY-131' }).expect(502);
    expect(res.body.error).toMatch(/^Jira unreachable: /);
  });

  it('a 403 on the transition POST → 502, and a 400 → 409, through the same mapping', async () => {
    fake.failNext = (c) => (c.method === 'POST' && c.url.endsWith('/transitions') ? { status: 403, body: { errorMessages: ['Nope.'] } } : null);
    expect((await post('/issue/transition', { key: 'PAY-131', transitionId: '31' }).expect(502)).body).toMatchObject({ error: 'Jira refused: Nope.' });
    fake.failNext = (c) => (c.method === 'POST' && c.url.endsWith('/transitions') ? { status: 400, body: { errorMessages: ['Required field missing.'] } } : null);
    expect((await post('/issue/transition', { key: 'PAY-131', transitionId: '31' }).expect(409)).body).toEqual({ error: 'Jira refused: Required field missing.' });
  });
});

describe('inside a 429 window', () => {
  beforeAll(async () => {
    prepare('rate-limited');
    await build();
  });
  afterAll(() => app.close());

  it('a 429 on the PUT is 503 with retryAt; the next write is refused with the SAME retryAt and sends nothing', async () => {
    fake.failNext = (c) => (c.method === 'PUT' ? { status: 429, headers: { 'retry-after': '30' } } : null);
    const first = await post('/issue/assign', { key: 'PAY-131' }).expect(503);
    fake.failNext = null;
    expect(first.body).toMatchObject({ access: 'rate-limited', error: `Jira rate limit — retry after ${first.body.retryAt}` });
    expect(Date.parse(first.body.retryAt)).toBeGreaterThan(Date.now());
    expect(puts()).toHaveLength(1);

    const calls = fake.calls.length;
    const second = await post('/issue/assign', { key: 'PAY-131' }).expect(503);
    expect(second.body.retryAt).toBe(first.body.retryAt);
    const third = await post('/issue/transition', { key: 'PAY-131', transitionId: '31' }).expect(503);
    expect(third.body.retryAt).toBe(first.body.retryAt);
    expect(puts()).toHaveLength(1);
    expect(fake.calls).toHaveLength(calls);
    expect((await status()).access).toBe('rate-limited');
  });
});

describe('Review Focus 4: a 401 on the write itself', () => {
  beforeAll(async () => {
    prepare('unauthorized');
    await build();
  });
  afterAll(() => app.close());

  it('is 503, the site reads unauthorized, and every later issue write is refused with no Jira call — while a board save still works', async () => {
    expect((await card('PAY-131')).assignee).toBeNull();
    // Persistent, not a one-shot `failNext`: `routeFailed` wakes the boot retry, and a `myself` that recovered would restore `me` and let the next write through.
    fake.unauthorized = true;
    const first = await post('/issue/assign', { key: 'PAY-131' }).expect(503);
    expect(first.body).toEqual({ error: 'Jira rejected the credentials', access: 'unauthorized' });
    // The boot retry the 401 woke is allowed to run — and fails again, because the fake is still rejecting.
    await poller.tick();
    expect(await status()).toMatchObject({ access: 'unauthorized', me: null });

    const calls = fake.calls.length;
    const assign = await post('/issue/assign', { key: 'PAY-131' }).expect(503);
    const transition = await post('/issue/transition', { key: 'PAY-131', transitionId: '31' }).expect(503);
    // The fixed 401 body, never the boot's own `detail` (R2).
    for (const res of [assign, transition]) expect(res.body).toEqual({ error: 'Jira rejected the credentials', access: 'unauthorized' });
    expect(fake.calls.slice(calls).filter((c) => c.method === 'PUT' || c.url.endsWith('/transitions'))).toEqual([]);
    expect(fake.calls.slice(calls).filter((c) => !c.url.endsWith('/myself') && !c.url.endsWith('/tenant_info'))).toEqual([]);
    expect(puts()).toHaveLength(1);
    expect(transitionCalls()).toEqual([]);

    // Config writes stay open (§8): a person whose token expired can still fix their boards.
    await post('/boards', { name: 'Quiet', roots: ['PAY-120'], queries: [], interval: 'off' }).expect(200);
  });
});

describe('the credentials rejected on a boot call that leaves the identity set', () => {
  beforeAll(async () => {
    prepare('unauthorized-with-me');
    // The boot's sprint-field read is the one that answers 401 here, after `myself` has answered: `access` is unauthorized and `me` is still known.
    fake.failNext = (c) => (c.url.endsWith('/field') ? { status: 401, body: { message: 'Unauthorized' } } : null);
    await build();
    fake.failNext = null;
  });
  afterAll(() => app.close());

  it('assign is the 401 body, not a PUT carrying the stale identity', async () => {
    expect((await status()).access).toBe('unauthorized');
    // `GET /api/jira` hides `me` while the boot is unanswered, so the premise — the identity IS known and the PUT would have gone out — is read off the boot itself.
    expect((poller as unknown as { boot: { me: { accountId: string } | null } }).boot.me).toEqual({ accountId: 'acc-1', name: 'Ada Lovelace' });
    const calls = fake.calls.length;
    const res = await post('/issue/assign', { key: 'PAY-131' }).expect(503);
    expect(res.body).toEqual({ error: 'Jira rejected the credentials', access: 'unauthorized' });
    expect(fake.calls).toHaveLength(calls);
  });
});

describe('identity not yet known', () => {
  beforeAll(async () => {
    prepare('no-identity');
    fake.failNext = (c) => (c.url.startsWith('https://api.atlassian.com/') && c.url.endsWith('/myself') ? { status: 403, body: { errorMessages: ['No.'] } } : null);
    await build();
    fake.failNext = null;
  });
  afterAll(() => app.close());

  it('assign is 503 no identity with no PUT, and a transition still goes through (R2)', async () => {
    expect(await status()).toMatchObject({ access: 'forbidden', me: null });
    const res = await post('/issue/assign', { key: 'PAY-131' }).expect(503);
    expect(res.body).toEqual({ error: 'no identity' });
    expect(puts()).toEqual([]);
    await post('/issue/transition', { key: 'PAY-131', transitionId: '31' }).expect(200);
  });
});
