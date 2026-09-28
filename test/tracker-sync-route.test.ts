import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { StartingRunsService } from '../server/src/orchestrator/starting-runs.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, TrackersPayload } from '../shared/types';

/**
 * `POST /api/trackers/sync` (#17, spec §6 with the plan's amendments 1 and 3) — every row of the status table, the guard, and two projects on one repo.
 *
 * No token for the whole suite, deliberately: the route calls nothing outbound, `connectedRepos()` resolves markers without one, and a poller that never
 * arms is a poller that can never reach api.github.com from a test.
 */

const fixture = rawFixture as OrchestratorRun;

let app: INestApplication;
let tmpRoot: string;
let orchHome: string;
let syncFile: string;
let trackerPath: string;
let twinPath: string;
let filesPath: string;
const env = { ...process.env };

function writeRun(project: string, status: OrchestratorRun['status']): void {
  const dir = join(orchHome, encodeURIComponent(project));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...fixture, project, status, runId: 'run-20260928-120000' }, null, 2));
}

async function build(projects: { name: string; path: string }[]): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry(projects))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
}

const post = (body: unknown) =>
  request(app.getHttpServer()).post('/api/trackers/sync').set('content-type', 'application/json').send(JSON.stringify(body));

const fileJson = (): unknown => JSON.parse(readFileSync(syncFile, 'utf8'));

beforeEach(async () => {
  delete process.env[GITHUB_TOKEN_ENV];
  tmpRoot = mkdtempSync(join(tmpdir(), 'bm-sync-route-'));
  orchHome = join(tmpRoot, 'orchestrator');
  process.env.BM_ORCH_HOME = orchHome;
  syncFile = join(tmpRoot, 'settings', 'tracker-sync.json');
  process.env.BM_TRACKER_SYNC_FILE = syncFile;
  process.env.BM_WATCHDOG = 'off';
  trackerPath = makeProject('alpha', [], JSON.stringify({ kind: 'github', repo: 'a/one' }));
  twinPath = makeProject('alpha-twin', [], JSON.stringify({ kind: 'github', repo: 'a/one' }));
  filesPath = makeProject('beta', []);
  await build([
    { name: 'alpha', path: trackerPath },
    { name: 'beta', path: filesPath }
  ]);
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
  for (const dir of [tmpRoot, trackerPath, twinPath, filesPath]) rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/trackers/sync', () => {
  it('writes the interval and answers the repo row, which GET /api/trackers then shows', async () => {
    const res = await post({ repo: 'a/one', interval: '5m' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ repo: 'a/one', interval: '5m', polledAt: null });
    expect(fileJson()).toEqual({ 'a/one': '5m' });
    const trackers = (await request(app.getHttpServer()).get('/api/trackers')).body as TrackersPayload;
    expect(trackers.projects.find((p) => p.name === 'alpha')?.interval).toBe('5m');
    expect(trackers.projects.find((p) => p.name === 'beta')?.interval).toBeNull();
  });

  it.each([
    ['a non-string repo', { repo: 42, interval: '5m' }],
    ['a repo that is not owner/name', { repo: 'not a repo', interval: '5m' }],
    ['an unknown interval', { repo: 'a/one', interval: '2m' }],
    ['a missing interval', { repo: 'a/one' }],
    ['a body that is not an object', ['a/one', 'off']]
  ])('refuses %s with 400 and writes nothing', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(existsSync(syncFile)).toBe(false);
  });

  it('answers 404 for a repo no registered project is connected to, and creates no file', async () => {
    const res = await post({ repo: 'x/unknown', interval: 'off' });
    expect(res.status).toBe(404);
    expect(existsSync(syncFile)).toBe(false);
  });

  it('refuses off while a run is running on the repo, and allows any other interval', async () => {
    writeRun(trackerPath, 'running');
    const off = await post({ repo: 'a/one', interval: 'off' });
    expect(off.status).toBe(409);
    expect(off.body.error).toContain('alpha');
    expect(off.body.error).toContain('run-20260928-120000');
    expect(existsSync(syncFile)).toBe(false);
    expect((await post({ repo: 'a/one', interval: '1m' })).status).toBe(200);
  });

  it('refuses off under a paused run too (amendment 1), and allows it once the run is done', async () => {
    writeRun(trackerPath, 'paused');
    expect((await post({ repo: 'a/one', interval: 'off' })).status).toBe(409);
    writeRun(trackerPath, 'done');
    expect((await post({ repo: 'a/one', interval: 'off' })).status).toBe(200);
    expect(fileJson()).toEqual({ 'a/one': 'off' });
  });

  it('refuses off while a starting entry exists for a project on the repo', async () => {
    app.get(StartingRunsService).mark(trackerPath);
    const res = await post({ repo: 'a/one', interval: 'off' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('alpha');
  });

  it('ignores a run on a project connected to a different repo', async () => {
    writeRun(filesPath, 'running');
    expect((await post({ repo: 'a/one', interval: 'off' })).status).toBe(200);
  });

  it('is guarded like the agents POSTs: wrong content type and foreign origin are refused', async () => {
    const wrongType = await request(app.getHttpServer()).post('/api/trackers/sync').set('content-type', 'text/plain').send('{"repo":"a/one","interval":"off"}');
    expect(wrongType.status).toBe(403);
    const foreign = await post({ repo: 'a/one', interval: 'off' }).set('origin', 'http://evil.test');
    expect(foreign.status).toBe(403);
    expect(existsSync(syncFile)).toBe(false);
  });

  it('calls arm() after the write, so turning a repo back on restarts the poller', async () => {
    const arm = jest.spyOn(app.get(TrackerPollerService), 'arm');
    await post({ repo: 'a/one', interval: 'off' });
    arm.mockClear();
    expect((await post({ repo: 'a/one', interval: '15s' })).status).toBe(200);
    expect(arm).toHaveBeenCalledTimes(1);
  });
});

describe('two registered projects on one repo (Review Focus 3)', () => {
  beforeEach(async () => {
    await app.close();
    await build([
      { name: 'alpha', path: trackerPath },
      { name: 'alpha-twin', path: twinPath }
    ]);
  });

  it('share one key: one POST changes both rows', async () => {
    expect((await post({ repo: 'a/one', interval: '1m' })).status).toBe(200);
    const trackers = (await request(app.getHttpServer()).get('/api/trackers')).body as TrackersPayload;
    expect(trackers.projects.map((p) => [p.name, p.interval])).toEqual([
      ['alpha', '1m'],
      ['alpha-twin', '1m']
    ]);
    expect(fileJson()).toEqual({ 'a/one': '1m' });
  });

  it('refuses off when the run is on the OTHER checkout of the repo', async () => {
    writeRun(twinPath, 'running');
    const res = await post({ repo: 'a/one', interval: 'off' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('alpha-twin');
  });
});
