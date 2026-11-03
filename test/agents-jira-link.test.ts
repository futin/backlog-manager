import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { JiraLiveReconciler } from '../server/src/agents/jira-live.service';
import { AppModule } from '../server/src/app.module';
import { JiraLiveService } from '../server/src/jira/live.service';
import { JiraPollerService } from '../server/src/jira/poller.service';
import type { JiraResult } from '../server/src/jira/poller.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import type { JiraIssue } from '../shared/types';
import { listenLoopback } from './helpers/app';
import { RUN_META } from './helpers/jira';
import { makeRegistry } from './helpers/store';

/**
 * `POST /api/agents/jira-link` and `/jira-unlink` (Jira sessions, Task 7; spec §5 `/jira link`, C9) — what the `jira` skill's two subcommands call. Link checks the
 * key with ONE poller read (`issueSummary`, spied here so no Jira is configured) and the session with the dashboard's `GET /api/sessions/:id/row`, which is the
 * only thing that may refuse an id: the capped list proves nothing about an absent session. Unlink removes a `branch`/`manual` link and suppresses the pair so
 * detection never re-adds it, and refuses a `run` link.
 *
 * The dashboard is `global.fetch`, answering by URL: a row per id (`rows`, 404 for an id it does not hold) and one list (`list`). The live map and the link store
 * are per process, so a fresh app per case.
 */

const REPO = '/work/pay';
const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE', 'BM_AGENTS', 'BM_AGENTS_URL', 'BM_AGENTS_TOKEN', 'BM_ORCH_HOME'] as const;

let saved: Record<string, string | undefined>;
let dir: string;
let app: INestApplication;
let live: JiraLiveService;
let poller: JiraPollerService;
let reads: string[];
let issueAnswer: JiraResult<JiraIssue>;
let rows: Record<string, Record<string, unknown>>;
let list: unknown[];
let urls: string[];
let auths: (string | undefined)[];
let spawns: { method: string | undefined; body: unknown }[];
/** What the dashboard answers to `POST /api/spawn`: a status and body, or `'down'` for a connection that never completes. */
let spawnAnswer: { status: number; body: unknown } | 'down';
const realFetch = global.fetch;

const post = (route: 'jira-link' | 'jira-unlink' | 'jira-open-desktop', body: unknown) =>
  request(app.getHttpServer()).post(`/api/agents/${route}`).set('content-type', 'application/json').send(JSON.stringify(body));

function issueFor(key: string): JiraIssue {
  const now = new Date().toISOString();
  return {
    key,
    id: '1',
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `Summary of ${key}`,
    project: { key: key.split('-')[0], name: 'P' },
    type: { name: 'Bug', level: 0, subtask: false },
    status: { name: 'In Progress', category: 'indeterminate' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: { key: 'PAY-1', summary: 'Epic' },
    subtasks: 0,
    labels: [],
    sprint: null,
    created: now,
    updated: now,
    resolved: null
  };
}

const failure = (status: number): JiraResult<JiraIssue> => ({ ok: false, response: { status, data: null, message: null, retryAfter: null } });

function stubDashboard(): void {
  urls = [];
  auths = [];
  spawns = [];
  spawnAnswer = { status: 200, body: { surface: 'desktop' } };
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    auths.push((init?.headers as Record<string, string> | undefined)?.authorization);
    if (url.endsWith('/api/spawn')) {
      spawns.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
      if (spawnAnswer === 'down') return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      const answer = spawnAnswer;
      return Promise.resolve({ ok: answer.status < 400, status: answer.status, json: () => Promise.resolve(answer.body) } as Response);
    }
    const row = /\/api\/sessions\/([^/?]+)\/row$/.exec(url);
    let answer: { status: number; body: unknown };
    if (row !== null) {
      const hit = rows[decodeURIComponent(row[1])];
      answer = hit === undefined ? { status: 404, body: { error: 'no such session' } } : { status: 200, body: hit };
    } else answer = { status: 200, body: { sessions: list } };
    return Promise.resolve({ ok: answer.status < 400, status: answer.status, json: () => Promise.resolve(answer.body) } as Response);
  }) as jest.Mock;
}

/** `jira.json` mapping PAY to REPO, so the reconciler's detection has something to look at. */
function mapRepo(): void {
  const file = join(dir, 'jira.json');
  writeFileSync(file, JSON.stringify({ repos: { PAY: [REPO] } }));
  process.env.BM_JIRA_FILE = file;
}

const linkOf = (key: string, sessionId: string) => live.links().find((l) => l.key === key && l.sessionId === sessionId);

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-link-'));
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const k of ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE']) delete process.env[k];
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env.BM_AGENTS_TOKEN = 's3cret';
  process.env.BM_ORCH_HOME = join(dir, 'orchestrator');
  rows = { 'sess-1': { id: 'sess-1', status: 'working', surface: 'dashboard', sessionName: 'pay work', gitBranch: 'feat/x', projectPath: REPO, model: 'opus', effort: 'high' } };
  list = [];
  issueAnswer = { ok: true, value: issueFor('PAY-1') };
  reads = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(REGISTRY_FILE).useValue(makeRegistry([])).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  live = app.get(JiraLiveService);
  poller = app.get(JiraPollerService);
  jest.spyOn(poller, 'issueSummary').mockImplementation((key: string) => {
    reads.push(key);
    return Promise.resolve(issueAnswer.ok ? { ok: true, value: issueFor(key) } : issueAnswer);
  });
  stubDashboard();
});

afterEach(async () => {
  await app?.close();
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('jira-link', () => {
  it('links a session the dashboard knows as a `manual` link carrying the ticket snapshot and the row`s facts', async () => {
    const res = await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(res.body).toEqual({ ok: true, linked: 'added' });
    expect(reads).toEqual(['PAY-1']);
    expect(linkOf('PAY-1', 'sess-1')).toMatchObject({
      how: 'manual',
      action: null,
      name: 'pay work',
      repo: REPO,
      branch: 'feat/x',
      surface: 'dashboard',
      model: 'opus',
      effort: 'high',
      snapshot: { summary: 'Summary of PAY-1', type: 'Bug', parentKey: 'PAY-1' },
      endedAt: null
    });
  });

  it('asks the dashboard for the ONE row, URL-encoded, with the bearer token — and never for the capped list', async () => {
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(urls).toEqual(['http://dash.test:4173/api/sessions/sess-1/row']);
    expect(auths).toEqual(['Bearer s3cret']);
  });

  it('a row whose surface is not `dashboard` links with a null surface', async () => {
    rows['sess-1'].surface = 'local';
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(linkOf('PAY-1', 'sess-1')?.surface).toBeNull();
  });

  it('refuses a key Jira does not know, with the poller`s own status and sentence, and links nothing', async () => {
    issueAnswer = failure(404);
    const res = await post('jira-link', { key: 'PAY-9', sessionId: 'sess-1' }).expect(404);
    expect(res.body).toEqual({ error: 'issue not found' });
    expect(live.links()).toEqual([]);
  });

  it('passes a rate-limited Jira through as the poller words it', async () => {
    issueAnswer = failure(429);
    const res = await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(503);
    expect(res.body.error).toMatch(/^Jira rate limit — retry after /);
    expect(live.links()).toEqual([]);
  });

  it('refuses a session the dashboard answers 404 for', async () => {
    const res = await post('jira-link', { key: 'PAY-1', sessionId: 'sess-unknown' }).expect(409);
    expect(res.body).toEqual({ error: 'the dashboard does not know session sess-unk' });
    expect(live.links()).toEqual([]);
  });

  it('502s when the dashboard cannot answer the row, as the session list words it', async () => {
    global.fetch = jest.fn(() => Promise.reject(new TypeError('fetch failed'))) as jest.Mock;
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(502);
    expect(live.links()).toEqual([]);
  });

  /* The row route reads any transcript whatever its age, so a session the capped list left out — a full list proves nothing about an absent one — still links. */
  it('links a session that is absent from a full list but whose row answers 200', async () => {
    list = Array.from({ length: 50 }, (_, i) => ({ id: `other-${i}`, status: 'idle' }));
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(linkOf('PAY-1', 'sess-1')).toBeDefined();
  });

  it('linking the same pair twice answers `exists` and keeps one entry', async () => {
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    const again = await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(again.body).toEqual({ ok: true, linked: 'exists' });
    expect(live.links().filter((l) => l.key === 'PAY-1' && l.sessionId === 'sess-1')).toHaveLength(1);
  });

  it('one session can be linked to two tickets', async () => {
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    await post('jira-link', { key: 'PAY-2', sessionId: 'sess-1' }).expect(200);
    expect(live.links().map((l) => l.key).sort()).toEqual(['PAY-1', 'PAY-2']);
  });

  it('409s with the environment`s sentence when dispatch is off, before it asks Jira or the dashboard anything', async () => {
    process.env.BM_AGENTS = 'off';
    const res = await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(409);
    expect(res.body.error).toEqual(expect.any(String));
    expect(reads).toEqual([]);
    expect(urls).toEqual([]);
  });

  it.each([
    ['a lower-case key', { key: 'pay-1', sessionId: 'sess-1' }, 'invalid issue key'],
    ['no key', { sessionId: 'sess-1' }, 'invalid issue key'],
    ['no session id', { key: 'PAY-1' }, 'invalid session id'],
    ['a path-like session id', { key: 'PAY-1', sessionId: '../x' }, 'invalid session id'],
    ['a numeric session id', { key: 'PAY-1', sessionId: 5 }, 'invalid session id']
  ])('400 for %s, before anything is asked', async (_label, body, error) => {
    expect((await post('jira-link', body).expect(400)).body).toEqual({ error });
    expect(reads).toEqual([]);
    expect(urls).toEqual([]);
  });
});

describe('jira-unlink', () => {
  it('removes a manual link, 200', async () => {
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect((await post('jira-unlink', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200)).body).toEqual({ ok: true });
    expect(linkOf('PAY-1', 'sess-1')).toBeUndefined();
  });

  /* C9: the point of remembering — a branch named after the wrong ticket must not come straight back on the next tick. */
  it('removes a detected branch link, and the next detection tick does not re-add it', async () => {
    mapRepo();
    rows['sess-1'].gitBranch = 'PAY-1-currency';
    list = [rows['sess-1']];
    const reconciler = app.get(JiraLiveReconciler);
    await reconciler.tick();
    expect(linkOf('PAY-1', 'sess-1')).toMatchObject({ how: 'branch', endedAt: null });
    await post('jira-unlink', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(linkOf('PAY-1', 'sess-1')).toBeUndefined();
    await reconciler.tick();
    expect(linkOf('PAY-1', 'sess-1')).toBeUndefined();
    expect(reads).toEqual(['PAY-1']);
  });

  it('refuses a run link with the spec`s sentence, and the link stays', async () => {
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    live.confirm('PAY-1', 'sess-1', RUN_META);
    const res = await post('jira-unlink', { key: 'PAY-1', sessionId: 'sess-1' }).expect(409);
    expect(res.body).toEqual({ error: 'PAY-1 was started by Run ▾ — stop it from the board instead' });
    expect(linkOf('PAY-1', 'sess-1')).toMatchObject({ how: 'run', endedAt: null });
  });

  it('404s for a pair that is not linked, naming the first 8 characters of the session id', async () => {
    const res = await post('jira-unlink', { key: 'PAY-1', sessionId: 'sess-unknown' }).expect(404);
    expect(res.body).toEqual({ error: 'PAY-1 is not linked to session sess-unk' });
  });

  it('works with dispatch off — it makes no dashboard call', async () => {
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    process.env.BM_AGENTS = 'off';
    urls.length = 0;
    await post('jira-unlink', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(urls).toEqual([]);
  });

  it.each([
    ['a lower-case key', { key: 'pay-1', sessionId: 'sess-1' }, 'invalid issue key'],
    ['no session id', { key: 'PAY-1' }, 'invalid session id']
  ])('400 for %s', async (_label, body, error) => {
    expect((await post('jira-unlink', body).expect(400)).body).toEqual({ error });
  });
});

/* An explicit link is the person changing their mind: it lifts the suppression an earlier unlink left, so it never answers `suppressed`. */
describe('link after unlink', () => {
  it('an explicit link of an unlinked pair is added again', async () => {
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    await post('jira-unlink', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(live.isSuppressed('PAY-1', 'sess-1')).toBe(true);
    const res = await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    expect(res.body).toEqual({ ok: true, linked: 'added' });
    expect(live.isSuppressed('PAY-1', 'sess-1')).toBe(false);
    expect(linkOf('PAY-1', 'sess-1')).toMatchObject({ how: 'manual', endedAt: null });
  });

  it('a refused link (unknown session) leaves the suppression in place', async () => {
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    await post('jira-unlink', { key: 'PAY-1', sessionId: 'sess-1' }).expect(200);
    delete rows['sess-1'];
    await post('jira-link', { key: 'PAY-1', sessionId: 'sess-1' }).expect(409);
    expect(live.isSuppressed('PAY-1', 'sess-1')).toBe(true);
  });
});

describe('jira-open-desktop', () => {
  it('asks the dashboard to hand the session over: resume + the desktop surface, nothing else, with the bearer token', async () => {
    const res = await post('jira-open-desktop', { sessionId: 'sess-1' }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(urls).toEqual(['http://dash.test:4173/api/spawn']);
    expect(spawns).toEqual([{ method: 'POST', body: { resume: 'sess-1', surface: 'desktop' } }]);
    expect(auths).toEqual(['Bearer s3cret']);
  });

  it('passes the dashboard`s refusal through with its status and sentence unchanged', async () => {
    for (const [status, error] of [
      [409, 'session is still running'],
      [409, 'already resuming'],
      [409, 'session is open in the desktop app'],
      [501, 'desktop app unavailable'],
      [400, 'unknown session'],
      [429, 'too many launches in flight'],
      [500, 'open failed']
    ] as const) {
      spawnAnswer = { status, body: { error } };
      const res = await post('jira-open-desktop', { sessionId: 'sess-1' }).expect(status);
      expect(res.body.error).toBe(error);
    }
  });

  it('an answer with no sentence is named by its status', async () => {
    spawnAnswer = { status: 409, body: null };
    const res = await post('jira-open-desktop', { sessionId: 'sess-1' }).expect(409);
    expect(res.body.error).toBe('the dashboard answered 409');
  });

  it('a dashboard that is down is a 502 naming the cause', async () => {
    spawnAnswer = 'down';
    const res = await post('jira-open-desktop', { sessionId: 'sess-1' }).expect(502);
    expect(res.body.error).toContain('ECONNREFUSED');
  });

  it('a 200 that does not say desktop (a dashboard from before hand-overs) is a 502, not a success', async () => {
    spawnAnswer = { status: 200, body: { surface: 'dashboard', sessionId: 'sess-1' } };
    await post('jira-open-desktop', { sessionId: 'sess-1' }).expect(502);
  });

  it.each([undefined, '', '../x', 'a/b', 42, null])('refuses a bad session id %p with a 400 and no dashboard call', async (sessionId) => {
    const res = await post('jira-open-desktop', { sessionId }).expect(400);
    expect(res.body.error).toBe('invalid session id');
    expect(urls).toEqual([]);
  });

  it('with agents off is a 409 and no dashboard call', async () => {
    process.env.BM_AGENTS = 'off';
    await post('jira-open-desktop', { sessionId: 'sess-1' }).expect(409);
    expect(spawns).toEqual([]);
  });
});

describe('the origin guard', () => {
  it.each(['jira-link', 'jira-unlink', 'jira-open-desktop'] as const)('refuses a cross-origin POST to %s without a Jira or dashboard call', async (route) => {
    const res = await request(app.getHttpServer())
      .post(`/api/agents/${route}`)
      .set('origin', 'http://evil.example')
      .send({ key: 'PAY-1', sessionId: 'sess-1' })
      .expect(403);
    expect(res.body.error).toEqual(expect.any(String));
    expect(reads).toEqual([]);
    expect(urls).toEqual([]);
    expect(live.links()).toEqual([]);
  });
});
