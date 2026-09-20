import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FAKE_REPO, FakeGithub } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import type { ClaimRecord, ClaimRun, OrchestratorRun, OrchestratorRunsPayload } from '../shared/types';

/**
 * `GET /api/orchestrator/runs`' `remote` array, through the real app (task-48).
 *
 * The network is the in-memory GitHub behind a real `GithubClient`
 * (`helpers/github.ts`); the dashboard, for S-3's spawn, is a `global.fetch`
 * stub — the two never share a transport, so the fake's call log is exactly
 * the app's GitHub traffic.
 */

const fixture = rawFixture as OrchestratorRun;
const TOKEN = 'ghp_task48SentinelValue';
const RUN_ID = 'run-20260919-110000';
const RUN: ClaimRun = { runId: RUN_ID, startedAt: '2026-09-19T11:00:00.000Z', mergeMode: 'merge', questionMode: 'park', maxItems: null, base: 'main' };

let app: INestApplication;
let gh: FakeGithub;
let tmpRoot: string;
let orchHome: string;
const dirs: string[] = [];
const env = { ...process.env };
const realFetch = global.fetch;

function claim(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    v: 1,
    session: 'machine-a-driver',
    phase: 'execute',
    at: new Date(Date.now() - 10 * 60_000).toISOString(),
    heartbeat: new Date(Date.now() - 60_000).toISOString(),
    counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 },
    run: RUN,
    ...over
  };
}

function writeRun(run: OrchestratorRun): void {
  const dir = join(orchHome, encodeURIComponent(run.project));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
}

/** One app over `projects`; the fake is seeded BEFORE this, and one poll tick
 *  fills the cache the way a real sweep would. */
async function build(projects: Array<{ name: string; path: string }>): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry(projects))
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
  gh.calls.length = 0;
}

function project(name: string, marker?: string): string {
  const root = makeProject(name, [], marker);
  dirs.push(root);
  return root;
}

async function runs(): Promise<OrchestratorRunsPayload> {
  return (await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200)).body as OrchestratorRunsPayload;
}

beforeEach(() => {
  gh = new FakeGithub();
  tmpRoot = mkdtempSync(join(tmpdir(), 'bm-remote-runs-'));
  orchHome = join(tmpRoot, 'orchestrator');
  process.env.BM_ORCH_HOME = orchHome;
  process.env[GITHUB_TOKEN_ENV] = TOKEN;
});

afterEach(async () => {
  await app?.close();
  process.env = { ...env };
  global.fetch = realFetch;
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/orchestrator/runs — remote', () => {
  it('S-1: a connected repo holding another machine’s claims yields one remote run, never a member of runs', async () => {
    const gamma = project('gamma', JSON.stringify({ kind: 'github', repo: FAKE_REPO }));
    gh.issue({ number: 3, title: 'three' });
    gh.claim(claim({ state: { stage: 'reviewing' } }), 3);
    await build([{ name: 'gamma', path: gamma }]);

    const body = await runs();
    expect(body.remote).toHaveLength(1);
    expect(body.remote[0]).toMatchObject({ runId: RUN_ID, project: gamma, repo: FAKE_REPO, remote: true, status: 'running', fresh: true });
    expect(body.remote[0].queue.map((q) => [q.id, q.title, q.stage])).toEqual([['3', 'three', 'reviewing']]);
    expect(body.runs.some((r) => r.runId === RUN_ID)).toBe(false);
  });

  it('S-2: the same claims plus a local run.json with the same runId → no remote run', async () => {
    const gamma = project('gamma', JSON.stringify({ kind: 'github', repo: FAKE_REPO }));
    gh.issue({ number: 3 });
    gh.claim(claim(), 3);
    writeRun({ ...fixture, runId: RUN_ID, project: gamma, updatedAt: new Date().toISOString() });
    await build([{ name: 'gamma', path: gamma }]);

    const body = await runs();
    expect(body.remote).toEqual([]);
    expect(body.runs.map((r) => r.runId)).toEqual([RUN_ID]);
  });

  it('S-2: an ARCHIVED run file with the same runId drops it too', async () => {
    const gamma = project('gamma', JSON.stringify({ kind: 'github', repo: FAKE_REPO }));
    gh.issue({ number: 3 });
    gh.claim(claim(), 3);
    const archive = join(orchHome, encodeURIComponent(gamma), 'runs');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, `${RUN_ID}-2.json`), JSON.stringify({ ...fixture, runId: RUN_ID, project: gamma }));
    await build([{ name: 'gamma', path: gamma }]);

    expect((await runs()).remote).toEqual([]);
  });

  it('S-4: no tracker project registered → remote is empty and GitHub is never asked', async () => {
    const alpha = project('alpha');
    await build([{ name: 'alpha', path: alpha }]);

    expect((await runs()).remote).toEqual([]);
    expect(gh.calls).toEqual([]);
  });
});

describe('POST /api/agents/orchestrate — a remote run never locks the project', () => {
  it('S-3: a fresh, running remote run on P does not 409 a local Orchestrate of P', async () => {
    const gamma = project('gamma', JSON.stringify({ kind: 'github', repo: FAKE_REPO }));
    gh.issue({ number: 3 });
    gh.claim(claim(), 3);
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith('/api/spawn')
        ? { sessionId: 'sess-1' }
        : url.endsWith('/api/management')
          ? { projects: [{ dirName: '-gamma', name: 'gamma', path: gamma, lastActiveMs: 1 }] }
          : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    }) as jest.Mock;
    await build([{ name: 'gamma', path: gamma }]);

    // The precondition, so the case cannot pass vacuously.
    expect((await runs()).remote.map((r) => [r.status, r.fresh])).toEqual([['running', true]]);

    const res = await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: gamma });
    expect(res.body.code).not.toBe(RUN_IN_PROGRESS_CODE);
    expect(res.status).toBe(201);
  });
});
