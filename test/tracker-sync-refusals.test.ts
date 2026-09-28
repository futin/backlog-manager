import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { writeSyncInterval } from '../server/src/tracker/sync-config.util';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

/**
 * What `off` refuses (#17, spec §8 with plan amendment 2): the eight `/api/items/*` write routes, dispatch, orchestrate and resume — each a 409 carrying
 * `syncOffBlock`'s sentence verbatim, and each without a single request to GitHub or a spawn on the dashboard.
 *
 * Built the way `tracker-dispatch.test.ts` builds its app: the in-memory GitHub behind a real `GithubClient`, the dashboard on global `fetch`, the cache
 * seeded by one tick and the poller then stood down so no background tick lands in either call log.
 */

const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });
const TOKEN = 'ghp_issue17SyncOffSentinel';
const SENTENCE = `sync is off for ${FAKE_REPO} — turn it on in Settings › Shared › Trackers`;
const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');
const fixture = rawFixture as OrchestratorRun;

const dirs: string[] = [];
const env = { ...process.env };
const realFetch = global.fetch;

let app: INestApplication;
let gh: FakeGithub;
let filesPath: string;
let trackerPath: string;
let orchHome: string;
let spawned: string[];

function project(name: string, marker?: string, items: Parameters<typeof makeProject>[1] = []): string {
  const root = makeProject(name, items, marker);
  dirs.push(root);
  return root;
}

function stubDashboard(): void {
  spawned = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    spawned.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.endsWith('/api/management')
            ? {
                projects: [
                  { dirName: '-abs-alpha', name: 'alpha', path: filesPath, lastActiveMs: 1 },
                  { dirName: '-abs-gamma', name: 'gamma', path: trackerPath, lastActiveMs: 1 }
                ]
              }
            : url.endsWith('/api/spawn')
              ? { sessionId: 'sess-1' }
              : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' }
        )
    } as Response);
  }) as jest.Mock;
}

const didSpawn = (): boolean => spawned.some((u) => u.endsWith('/api/spawn'));

beforeEach(async () => {
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env[GITHUB_TOKEN_ENV] = TOKEN;
  const tmp = mkdtempSync(join(tmpdir(), 'bm-sync-refusals-'));
  dirs.push(tmp);
  orchHome = join(tmp, 'orchestrator');
  process.env.BM_ORCH_HOME = orchHome;
  process.env.BM_ORCH_CONTROL_HOME = join(tmp, 'settings', 'orchestrator-control');
  process.env.BM_TRACKER_SYNC_FILE = join(tmp, 'settings', 'tracker-sync.json');

  gh = new FakeGithub();
  gh.issue();
  filesPath = project('alpha', undefined, [{ leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG }]);
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

  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
  spawned = [];
  gh.calls.length = 0;
  // Switched off AFTER the seeding tick, so the cache holds #31 exactly as a repo turned off mid-session would.
  writeSyncInterval(FAKE_REPO, 'off');
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
  global.fetch = realFetch;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: Record<string, unknown>): request.Test => request(app.getHttpServer()).post(path).send(body);

describe('the item write routes', () => {
  // A minimal VALID body per route — the same shapes `tracker-write.test.ts` sends — so a 409 here can only be the setting, never a 400 in disguise.
  const ROUTES: [string, () => Record<string, unknown>][] = [
    ['create', () => ({ project: trackerPath, section: 'bugs', title: 't', body: 'b' })],
    ['state', () => ({ project: trackerPath, id: '#31', status: 'done', outcome: 'it worked' })],
    ['claim', () => ({ project: trackerPath, id: '#31', phase: 'groom', session: 'A' })],
    ['release', () => ({ project: trackerPath, id: '#31', commentId: 100, session: 'A', reason: 'stopped' })],
    ['heartbeat', () => ({ project: trackerPath, id: '#31', commentId: 100, session: 'A' })],
    ['body', () => ({ project: trackerPath, id: '#31', body: 'new text', ifUpdatedAt: '2026-09-02T10:00:00Z' })],
    ['comment', () => ({ project: trackerPath, id: '#31', body: 'hello' })],
    ['queue', () => ({ project: trackerPath, id: '#31', queued: true })]
  ];

  it.each(ROUTES)('%s answers 409 with the sentence and makes no request to GitHub', async (route, body) => {
    const res = await post(`/api/items/${route}`, body()).expect(409);
    expect(res.body).toEqual({ error: SENTENCE });
    expect(gh.calls).toEqual([]);
  });

  it('reads the value, not the file: the same repo at 1m creates', async () => {
    writeSyncInterval(FAKE_REPO, '1m');
    await post('/api/items/create', { project: trackerPath, section: 'bugs', title: 't', body: 'b' }).expect(201);
  });
});

describe('dispatch, orchestrate and resume', () => {
  it('dispatch refuses a tracker item and spawns nothing', async () => {
    const res = await post('/api/agents/dispatch', {
      itemPath: `gh:${FAKE_REPO}#31`,
      action: 'execute',
      prompt: 'Use the backlog-execute skill on #31.',
      permissionMode: 'acceptEdits'
    }).expect(409);
    expect(res.body.error).toBe(SENTENCE);
    expect(didSpawn()).toBe(false);
  });

  it('plan names the same refusal as its block, so the sheet offers nothing dispatch would refuse', async () => {
    const res = await post('/api/agents/plan', { itemPath: `gh:${FAKE_REPO}#31` }).expect(201);
    expect(res.body.blocked).toBe(SENTENCE);
  });

  it('orchestrate refuses the project and spawns nothing', async () => {
    const res = await post('/api/agents/orchestrate', { project: trackerPath }).expect(409);
    expect(res.body.error).toBe(SENTENCE);
    expect(res.body.code).toBeUndefined();
    expect(didSpawn()).toBe(false);
  });

  it('resume refuses a paused run of the project and spawns nothing (Review Focus 1)', async () => {
    const dir = join(orchHome, encodeURIComponent(trackerPath));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...fixture, project: trackerPath, status: 'paused', updatedAt: new Date().toISOString() }, null, 2));
    const res = await post('/api/agents/resume', { project: trackerPath }).expect(409);
    expect(res.body.error).toBe(SENTENCE);
    expect(didSpawn()).toBe(false);
  });

  it('leaves a files project untouched: its dispatch still spawns', async () => {
    await post('/api/agents/dispatch', {
      itemPath: join(filesPath, 'backlog', 'bugs/open', 'bug-2-a-known-bug.md'),
      action: 'execute',
      prompt: 'x',
      permissionMode: 'acceptEdits'
    }).expect(201);
    expect(didSpawn()).toBe(true);
  });
});
