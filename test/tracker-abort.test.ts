import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { parseClaim } from '../server/src/tracker/claim';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import { CLAIM_STALE_MS } from '../shared/types';
import type { BacklogItem, ClaimRecord, ItemsIndex } from '../shared/types';

/**
 * `POST /api/items/abort` (#225) — the board's release of a claim whose session was stopped and so never ran its own closing `stop`.
 *
 * Two fakes, kept apart for the reason `tracker-dispatch.test.ts` gives: GitHub is the in-memory `FakeGithub` behind a real `GithubClient`, and the
 * DASHBOARD is global `fetch`, because that is the one `AgentsService` and the abort path both call it through. `dash` below is what the dashboard answers
 * for the two calls an abort can make — the session stop (case A) and the session list (case B) — and `dashCalls` is every URL it was asked for, so a case
 * can say "the dashboard was never asked" as well as "it was asked once".
 *
 * Every case seeds the claim as comment 100 on issue #31 and asserts against the comment itself (`claimIn`), never only against the route's answer: the
 * release that matters is the one GitHub now holds.
 */

const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });
const TOKEN = 'ghp_bug225AbortSentinel';
const HOST = 'laptop';

const dirs: string[] = [];
const env = { ...process.env };
const realFetch = global.fetch;

let app: INestApplication;
let gh: FakeGithub;
let filesPath: string;
let trackerPath: string;

type Answer = { status: number; body: unknown } | 'throw';
let dash: { stop: Answer; sessions: Answer };
let dashCalls: { method: string; url: string }[];

function project(name: string, marker?: string): string {
  const root = makeProject(name, [], marker);
  dirs.push(root);
  return root;
}

function answer(a: Answer): Promise<Response> {
  if (a === 'throw') return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: () => Promise.resolve(a.body) } as Response);
}

function stubDashboard(): void {
  dashCalls = [];
  dash = { stop: { status: 200, body: { stopped: true } }, sessions: { status: 200, body: { sessions: [] } } };
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    dashCalls.push({ method: init?.method ?? 'GET', url });
    if (/\/api\/sessions\/[^/]+\/stop$/.test(url)) return answer(dash.stop);
    if (url.endsWith('/api/sessions')) return answer(dash.sessions);
    if (url.endsWith('/api/management')) {
      return answer({ status: 200, body: { projects: [{ dirName: '-abs-gamma', name: 'gamma', path: trackerPath, lastActiveMs: 1 }] } });
    }
    if (url.endsWith('/api/spawn')) return answer({ status: 200, body: { sessionId: 'sess-1' } });
    return answer({ status: 200, body: { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' } });
  }) as jest.Mock;
}

function record(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    v: 1,
    session: 'A',
    host: HOST,
    phase: 'groom',
    at: new Date(Date.now() - 60_000).toISOString(),
    heartbeat: new Date().toISOString(),
    counters: { groomElapsed: 11, executeElapsed: 22, groomTokens: 33, executeTokens: 44 },
    ...over
  };
}

function claimIn(id: number): ClaimRecord | null {
  const comment = gh.comments.get(id);
  return comment === undefined ? null : parseClaim(comment as never);
}

/** Seed #31 as claimed and in progress, then let the poller cache it — the state a stopped session leaves behind. */
async function seed(over: Partial<ClaimRecord> = {}): Promise<void> {
  gh.issue({ labels: [{ name: 'type:bug' }, { name: 'in-progress' }], assignees: [{ login: 'futin' }] });
  gh.claim(record(over), 31, 100);
  await sync();
}

async function sync(): Promise<void> {
  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
  gh.calls.length = 0;
  dashCalls.length = 0;
}

function abort(body: Record<string, unknown> = { project: trackerPath, id: '#31' }): request.Test {
  return request(app.getHttpServer()).post('/api/items/abort').send(body);
}

async function dispatch(): Promise<void> {
  const res = await request(app.getHttpServer())
    .post('/api/agents/dispatch')
    .send({ itemPath: `gh:${FAKE_REPO}#31`, action: 'execute', prompt: 'Use the backlog-execute skill on #31.', permissionMode: 'acceptEdits' })
    .expect(201);
  expect(res.body).toEqual({ sessionId: 'sess-1' });
  dashCalls.length = 0;
}

function stopCalls(): { method: string; url: string }[] {
  return dashCalls.filter((c) => c.url.includes('/stop'));
}

function commentPatches(): unknown[] {
  return gh.matching('/issues/comments/100', 'PATCH');
}

beforeEach(async () => {
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env.BM_MACHINE_NAME = HOST;
  process.env[GITHUB_TOKEN_ENV] = TOKEN;

  gh = new FakeGithub();
  filesPath = project('alpha');
  trackerPath = project('gamma', GITHUB_MARKER);
  stubDashboard();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(
      makeRegistry([
        { name: 'alpha', path: filesPath },
        { name: 'gamma', path: trackerPath }
      ])
    )
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  app.get(GithubSource).settleMs = 0;
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
  global.fetch = realFetch;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('case A — the board dispatched the holding session', () => {
  it('stops the session once, then releases the claim aborted, clearing in-progress and the assignee and keeping the counters', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();

    const res = await abort().expect(201);

    expect(res.body).toEqual({ id: '#31', released: true, stopped: true });
    expect(stopCalls()).toEqual([{ method: 'POST', url: 'http://dash.test:4173/api/sessions/sess-1/stop' }]);
    expect(claimIn(100)?.released).toMatchObject({ reason: 'aborted', by: 'board' });
    expect(claimIn(100)?.counters).toEqual({ groomElapsed: 11, executeElapsed: 22, groomTokens: 33, executeTokens: 44 });
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).not.toContain('in-progress');
    expect(gh.issues.get(31)?.assignees).toEqual([]);
  });

  /* Case A needs no host match and no session list: the board started this session itself, so the stop it just sent is the proof. */
  it('needs neither a host match nor the session list', async () => {
    delete process.env.BM_MACHINE_NAME;
    await seed({ session: 'sess-1', host: 'another-machine' });
    await dispatch();

    await abort().expect(201);
    expect(dashCalls.some((c) => c.url.endsWith('/api/sessions'))).toBe(false);
    expect(claimIn(100)?.released?.reason).toBe('aborted');
  });

  /* A 404 `no live session` is a session with no process right now — gone, or a board-dispatched `claude -p` between turns — and the person asked to
     stop it, so the claim goes. `stopped: false` because nothing was stopped by this request. */
  it('still releases when the dashboard answers 404 no live session, reporting stopped: false', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();
    dash.stop = { status: 404, body: { error: 'no live session' } };

    const res = await abort().expect(201);
    expect(res.body).toEqual({ id: '#31', released: true, stopped: false });
    expect(claimIn(100)?.released?.reason).toBe('aborted');
  });

  it('proceeds on a stopping answer too — the SIGTERM has been sent', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();
    dash.stop = { status: 200, body: { stopping: true } };

    const res = await abort().expect(201);
    expect(res.body.stopped).toBe(true);
  });

  /* The dashboard answers 404 for a second reason with nothing to do with the session: remote answers switched off. That 404 says nothing about
     whether the process is alive, so it must not read as "no live session". */
  it('502s on a 404 that is NOT no-live-session, and edits nothing', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();
    dash.stop = { status: 404, body: { error: 'remote answers disabled' } };

    await abort().expect(502);
    expect(commentPatches()).toEqual([]);
    expect(claimIn(100)?.released).toBeUndefined();
  });

  it('502s on a 500 from the stop, and edits nothing — the session may still be running', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();
    dash.stop = { status: 500, body: { error: 'boom' } };

    await abort().expect(502);
    expect(commentPatches()).toEqual([]);
    expect(claimIn(100)?.released).toBeUndefined();
  });

  it('502s when the stop never comes back, and edits nothing', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();
    dash.stop = 'throw';

    const res = await abort().expect(502);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
    expect(commentPatches()).toEqual([]);
  });

  /* A second abort after a GitHub failure must still work: the record is kept until the release lands. */
  it('keeps the dispatch record until the release has landed', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();
    gh.failNext = { fragment: '/issues/comments/100', status: 500 };

    await abort().expect(502);
    dash.stop = { status: 404, body: { error: 'no live session' } };
    await abort().expect(201);
    expect(stopCalls()).toHaveLength(2);
    expect(claimIn(100)?.released?.reason).toBe('aborted');
  });
});

describe('case B — no dispatch record', () => {
  it('releases a same-host claim the dashboard reports idle, with stopped: false and no stop call', async () => {
    await seed();
    dash.sessions = { status: 200, body: { sessions: [{ id: 'A', status: 'idle' }] } };

    const res = await abort().expect(201);
    expect(res.body).toEqual({ id: '#31', released: true, stopped: false });
    expect(stopCalls()).toEqual([]);
    expect(claimIn(100)?.released).toMatchObject({ reason: 'aborted', by: 'board' });
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).not.toContain('in-progress');
  });

  it('releases a same-host claim the dashboard reports incomplete', async () => {
    await seed();
    dash.sessions = { status: 200, body: { sessions: [{ id: 'A', status: 'incomplete' }] } };
    await abort().expect(201);
  });

  for (const status of ['working', 'question']) {
    it(`refuses (409) a session the dashboard reports ${status}, and edits nothing`, async () => {
      await seed();
      dash.sessions = { status: 200, body: { sessions: [{ id: 'A', status }] } };

      const res = await abort().expect(409);
      expect(res.body.error).toMatch(new RegExp(status));
      expect(commentPatches()).toEqual([]);
    });
  }

  it('refuses (409) a session the dashboard does not know', async () => {
    await seed();
    dash.sessions = { status: 200, body: { sessions: [{ id: 'someone-else', status: 'idle' }] } };

    await abort().expect(409);
    expect(commentPatches()).toEqual([]);
  });

  it('502s when the dashboard cannot be reached, and edits nothing', async () => {
    await seed();
    dash.sessions = 'throw';

    await abort().expect(502);
    expect(commentPatches()).toEqual([]);
  });

  it('refuses (409) when agents are off on this machine — nothing to ask', async () => {
    process.env.BM_AGENTS = 'off';
    await seed();

    await abort().expect(409);
    expect(dashCalls).toEqual([]);
    expect(commentPatches()).toEqual([]);
  });

  it('refuses (409) a claim held on another machine, without asking the dashboard', async () => {
    await seed({ host: 'another-machine' });
    dash.sessions = { status: 200, body: { sessions: [{ id: 'A', status: 'idle' }] } };

    const res = await abort().expect(409);
    expect(res.body.error).toMatch(/another-machine/);
    expect(dashCalls).toEqual([]);
    expect(commentPatches()).toEqual([]);
  });

  /* The `sameHost` guard shape: absence never matches, on either side. */
  it('refuses (409) a claim that records no host', async () => {
    await seed({ host: undefined });
    dash.sessions = { status: 200, body: { sessions: [{ id: 'A', status: 'idle' }] } };

    await abort().expect(409);
    expect(commentPatches()).toEqual([]);
  });

  for (const blank of [undefined, '', '   ']) {
    it(`refuses (409) when this server has no machine name (${JSON.stringify(blank)})`, async () => {
      if (blank === undefined) delete process.env.BM_MACHINE_NAME;
      else process.env.BM_MACHINE_NAME = blank;
      await seed();
      dash.sessions = { status: 200, body: { sessions: [{ id: 'A', status: 'idle' }] } };

      const res = await abort().expect(409);
      expect(res.body.error).toMatch(/BM_MACHINE_NAME/);
      expect(commentPatches()).toEqual([]);
    });
  }
});

describe('refusals before any dashboard call', () => {
  it('refuses (409) a claim a run holds, naming the run', async () => {
    await seed({
      session: 'sess-1',
      run: { runId: 'run-9', startedAt: '2026-09-24T10:00:00Z', mergeMode: 'merge', questionMode: 'decide', maxItems: null, base: 'main' }
    });
    await dispatch();

    const res = await abort().expect(409);
    expect(res.body.error).toMatch(/run-9/);
    expect(dashCalls).toEqual([]);
    expect(commentPatches()).toEqual([]);
  });

  it('refuses (409) an item whose only claim is stale', async () => {
    await seed({ heartbeat: new Date(Date.now() - CLAIM_STALE_MS - 1).toISOString() });

    const res = await abort().expect(409);
    expect(res.body.error).toMatch(/not claimed/);
    expect(dashCalls).toEqual([]);
  });

  it('refuses (409) an item whose claim is already released', async () => {
    await seed({ released: { at: new Date().toISOString(), reason: 'stopped', by: 'A' } });
    await abort().expect(409);
  });

  it('refuses (409) an item nobody ever claimed', async () => {
    gh.issue();
    await sync();
    const res = await abort().expect(409);
    expect(res.body.error).toMatch(/not claimed/);
  });

  it('refuses a files project like every other write route (400), with no outbound call', async () => {
    await abort({ project: filesPath, id: 'bug-1' }).expect(400);
    expect(dashCalls).toEqual([]);
  });

  it('400s a missing id', async () => {
    await abort({ project: trackerPath }).expect(400);
  });
});

/* The authority an abort carries is decided server-side and must never be reachable from a request body: `release` rebuilds its request field by field,
   so a caller that sends the field is still a stranger to somebody else's live claim. */
it('POST /api/items/release ignores an authority field in the body — a non-holder is still refused', async () => {
  await seed();

  await request(app.getHttpServer())
    .post('/api/items/release')
    .send({ project: trackerPath, id: '#31', commentId: 100, session: 'B', reason: 'aborted', authority: 'board' })
    .expect(409);
  expect(claimIn(100)?.released).toBeUndefined();
});

describe('the item payload carries the holder', () => {
  async function item31(): Promise<BacklogItem | undefined> {
    const index = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as ItemsIndex;
    return index.items.find((i) => i.id === '#31');
  }

  it('names the holding session, its host and heartbeat, and nothing else for a hand claim', async () => {
    const heartbeat = new Date().toISOString();
    await seed({ heartbeat });
    expect((await item31())?.holder).toEqual({ session: 'A', host: HOST, heartbeat });
  });

  it('marks a holder the board dispatched', async () => {
    await seed({ session: 'sess-1' });
    await dispatch();
    expect((await item31())?.holder?.dispatched).toBe(true);
  });

  it('names the run of a run-owned claim', async () => {
    await seed({ run: { runId: 'run-9', startedAt: '2026-09-24T10:00:00Z', mergeMode: 'merge', questionMode: 'decide', maxItems: null, base: 'main' } });
    expect((await item31())?.holder?.run).toBe('run-9');
  });

  it('carries no holder key once the claim is released', async () => {
    await seed({ released: { at: new Date().toISOString(), reason: 'stopped', by: 'A' } });
    expect(await item31()).not.toHaveProperty('holder');
  });
});
