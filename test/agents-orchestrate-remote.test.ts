import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { WatchdogService } from '../server/src/agents/watchdog.service';
import { RemoteRunsService } from '../server/src/orchestrator/remote-runs.service';
import { StartingRunsService } from '../server/src/orchestrator/starting-runs.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { DEFAULT_MODEL } from '../shared/agent';
import type { OrchestratorRun, RemoteRun } from '../shared/types';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry, writeRunFile } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import homeSpawnFixture from './fixtures/orchestrate-home-spawn.json';

/**
 * Multi-dashboard task 6 — `POST /api/agents/orchestrate` with a `machine`, and the `remoteStarting` field of the runs payload it feeds. Driven end to end
 * through a real `AppModule`, every dashboard and the remote backlog-manager ("board") being real HTTP servers on `127.0.0.1` that record each request —
 * the shape `agents-dispatch-remote.test.ts` set for the card dispatch, so "the spawn went to Pro" and "nothing was spawned anywhere" are asserted rather
 * than inferred.
 *
 * The tracker project lives at `<tmp>/bm` rather than under `makeProject`'s random name, because an orchestrate session is named after the project's
 * basename (`orchestrate bm`) and the home case compares the spawn body BYTE for byte against a recording.
 */

const fixture = rawFixture as OrchestratorRun;
const HOME_TOKEN = 'tok-home-123';
const PRO_TOKEN = 'tok-pro-456';
const REMOTE_PATH = '/Users/p/bm';
const PRO_DIRNAME = '-Users-p-bm';
const HOME_DIRNAME = '-local-bm';
const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });
const HEALTH = { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' };
const NOW_ISO = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const ACCOUNT = {
  usageStatus: 'ok',
  usage: { fiveHour: { utilization: 5, resetsAt: NOW_ISO(3_600_000) }, sevenDay: { utilization: 5, resetsAt: NOW_ISO(4 * 86_400_000) } }
};
const PROFILE = { exhaustAt: null, walkAbsent: null, resetsAt: NOW_ISO(4 * 86_400_000) };

interface Seen {
  path: string;
  auth: string | undefined;
  body: string;
}
interface Stub {
  url: string;
  seen: Seen[];
}

const servers: Server[] = [];
const dirs: string[] = [];

/** A route's answer is its JSON body (200). Every request is recorded, its body included, once it has been read in full. */
async function stub(routes: Record<string, unknown>): Promise<Stub> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      seen.push({ path, auth: req.headers.authorization, body });
      const answer = routes[path];
      if (answer === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const spawnsOf = (s: Stub): Seen[] => s.seen.filter((r) => r.path === '/api/spawn');

describe('POST /api/agents/orchestrate with a machine', () => {
  let app: INestApplication | undefined;
  let home: Stub;
  let pro: Stub;
  let board: Stub;
  let root: string;
  let trackerPath: string;
  let filesPath: string;
  let settingsFile: string;
  let arm: jest.SpyInstance;
  const env = { ...process.env };

  const post = (body: Record<string, unknown>) => request(app!.getHttpServer()).post('/api/agents/orchestrate').send(body);
  const runs = () => request(app!.getHttpServer()).get('/api/orchestrator/runs').expect(200);

  /** Writes the settings file (Pro, plus overrides) unless told not to, and boots the app. */
  async function start(pro_: Record<string, unknown> | null = {}): Promise<void> {
    if (pro_ !== null) {
      mkdirSync(dirname(settingsFile), { recursive: true });
      writeFileSync(
        settingsFile,
        JSON.stringify({ dashboards: [{ name: 'Pro', url: pro.url, bmUrl: board.url, host: 'pro-mac', models: ['opus', 'sonnet'], ...pro_ }] })
      );
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(
        makeRegistry([
          { name: 'bm', path: trackerPath },
          { name: 'alpha', path: filesPath }
        ])
      )
      .overrideProvider(GithubClient)
      .useValue(new GithubClient(new FakeGithub().fetch))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
    app.get(TrackerPollerService).disarm();
    arm = jest.spyOn(app.get(WatchdogService), 'arm').mockImplementation(() => undefined);
  }

  /** A local run file for the tracker project — the exact layout `orchestrate.mjs` writes under `BM_ORCH_HOME`. */
  function writeLocalRun(over: Partial<OrchestratorRun>): void {
    writeRunFile(process.env.BM_ORCH_HOME as string, trackerPath, { ...fixture, project: trackerPath, ...over });
  }

  /** A run Pro drives, as `RemoteRunsService` would derive it from Pro's claims — stubbed at the service, deriving one being remote-runs.test.ts's job. */
  function remoteRun(host: string | null): RemoteRun {
    return { ...fixture, project: trackerPath, status: 'running', startedAt: NOW_ISO(-60_000), fresh: true, remote: true, repo: FAKE_REPO, host };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bm-orchestrate-remote-'));
    dirs.push(root);
    settingsFile = join(root, 'settings', 'dashboards.json');
    process.env.BM_DASHBOARDS_FILE = settingsFile;
    process.env.BM_ORCH_HOME = join(root, 'orchestrator');
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_TOKEN = HOME_TOKEN;
    process.env.BM_AGENTS_TOKEN_PRO = PRO_TOKEN;
    process.env[GITHUB_TOKEN_ENV] = 'ghp_task6RemoteOrchestrate';

    trackerPath = join(root, 'bm');
    mkdirSync(join(trackerPath, 'backlog'), { recursive: true });
    writeFileSync(join(trackerPath, 'backlog', 'source.json'), GITHUB_MARKER);
    filesPath = makeProject('alpha', []);
    dirs.push(filesPath);

    home = await stub({
      '/api/health': HEALTH,
      '/api/configs': {
        projects: [
          { dirName: HOME_DIRNAME, path: trackerPath },
          { dirName: '-local-alpha', path: filesPath }
        ]
      },
      '/api/spawn': { sessionId: 'sess-home' }
    });
    process.env.BM_AGENTS_URL = home.url;
    pro = await stub({
      '/api/health': HEALTH,
      '/api/configs': { projects: [{ dirName: PRO_DIRNAME, path: REMOTE_PATH }] },
      '/api/account': ACCOUNT,
      '/api/usage/profile': PROFILE,
      '/api/spawn': { sessionId: 'sess-pro' }
    });
    board = await stub({ '/api/projects': [{ name: 'bm', path: REMOTE_PATH, source: 'github', repo: FAKE_REPO, interval: '1m' }] });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          })
      )
    );
    process.env = { ...env };
  });

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Review Focus 1 — the home-only setup (no `dashboards.json`, no `machine` field) must send the dashboard the spawn body it sent before multi-dashboard,
   * BYTE for byte. `fixtures/orchestrate-home-spawn.json` was captured from a run of the unchanged code (task 5's HEAD), so these compare against what the
   * old code put on the wire rather than a re-statement of it a refactor could drift along with. `picked` carries every flag the prompt can grow
   * (`--merge-mode pr`, `--question-mode decide`) and a model/effort pick. `machine: 'home'` is the same launch spelled out and must be the same bytes.
   */
  describe('home orchestrate is byte-identical to before multi-dashboard', () => {
    const recorded = homeSpawnFixture as { default: string; picked: string };
    const cases = [
      ['default', {}],
      ['picked', { mergeMode: 'pr', questionMode: 'decide', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits' }]
    ] as const;

    for (const [key, extra] of cases) {
      for (const machine of [undefined, 'home']) {
        it(`${key}, machine ${machine ?? 'absent'}: the recorded /api/spawn body to home's dashboard, watchdog armed, starting marked`, async () => {
          await start(null);
          await post({ project: trackerPath, ...extra, ...(machine === undefined ? {} : { machine }) }).expect(201, { sessionId: 'sess-home' });
          const spawns = spawnsOf(home);
          expect(spawns).toHaveLength(1);
          expect(spawns[0].auth).toBe(`Bearer ${HOME_TOKEN}`);
          expect(spawns[0].body).toBe(recorded[key]);
          expect(arm).toHaveBeenCalledTimes(1);
          expect(app!.get(StartingRunsService).list([]).map((s) => s.project)).toEqual([trackerPath]);
          expect((await runs()).body.remoteStarting).toEqual([]);
        });
      }
    }
  });

  it('400s a machine that is not configured, and spawns nothing', async () => {
    await start();
    await post({ project: trackerPath, machine: 'Nope' }).expect(400, { error: 'unknown machine "Nope"' });
    expect(spawnsOf(home)).toEqual([]);
    expect(spawnsOf(pro)).toEqual([]);
  });

  describe('merge mode on a remote', () => {
    it('400s mergeMode merge', async () => {
      await start();
      await post({ project: trackerPath, machine: 'Pro', mergeMode: 'merge' }).expect(400, { error: 'merge mode must be pr on Pro' });
      expect(spawnsOf(pro)).toEqual([]);
    });

    it('400s mergeMode branch', async () => {
      await start();
      await post({ project: trackerPath, machine: 'Pro', mergeMode: 'branch' }).expect(400, { error: 'merge mode must be pr on Pro' });
      expect(spawnsOf(pro)).toEqual([]);
    });

    it('mergeMode absent: the prompt carries --merge-mode pr', async () => {
      await start();
      await post({ project: trackerPath, machine: 'Pro' }).expect(201, { sessionId: 'sess-pro' });
      expect((JSON.parse(spawnsOf(pro)[0].body) as { prompt: string }).prompt).toBe('/backlog-orchestrate --merge-mode pr');
    });
  });

  it('400s a files-backed project on a remote', async () => {
    await start();
    await post({ project: filesPath, machine: 'Pro' }).expect(400, { error: `Pro runs tracker projects only — ${filesPath} is files-backed` });
    expect(spawnsOf(pro)).toEqual([]);
  });

  it("400s a model outside Pro's list", async () => {
    await start();
    await post({ project: trackerPath, machine: 'Pro', model: 'haiku' }).expect(400, { error: `model "haiku" is not in Pro's list (opus, sonnet)` });
    expect(spawnsOf(pro)).toEqual([]);
  });

  it("400s an effort outside Pro's list", async () => {
    await start({ efforts: ['low', 'medium'] });
    await post({ project: trackerPath, machine: 'Pro', effort: 'max' }).expect(400, { error: `effort "max" is not in Pro's list (low, medium)` });
    expect(spawnsOf(pro)).toEqual([]);
  });

  it("409s when Pro is not offered for the project (Pro's board does not list it), and spawns nothing", async () => {
    board = await stub({ '/api/projects': [] });
    await start();
    const res = await post({ project: trackerPath, machine: 'Pro' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(new RegExp(`^Pro is not offered for ${trackerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    expect(spawnsOf(pro)).toEqual([]);
    expect(spawnsOf(home)).toEqual([]);
  });

  it("success on Pro: Pro's dashboard, token and dirName; no watchdog arm, no local starting entry, a remoteStarting entry; a second Pro launch 409s, home is allowed", async () => {
    await start();
    await post({ project: trackerPath, machine: 'Pro' }).expect(201, { sessionId: 'sess-pro' });

    const spawns = spawnsOf(pro);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].auth).toBe(`Bearer ${PRO_TOKEN}`);
    const sent = JSON.parse(spawns[0].body) as Record<string, unknown>;
    expect(sent.project).toBe(PRO_DIRNAME);
    expect(sent.model).toBe(DEFAULT_MODEL);
    expect(spawns[0].body).not.toContain(trackerPath);
    expect(spawnsOf(home)).toEqual([]);

    expect(arm).not.toHaveBeenCalled();
    expect(app!.get(StartingRunsService).list([])).toEqual([]);
    const payload = (await runs()).body;
    expect(payload.starting).toEqual([]);
    expect(payload.remoteStarting).toEqual([{ kind: 'orchestrate', project: trackerPath, machine: 'Pro', itemId: null, requestedAt: expect.any(String) }]);

    await post({ project: trackerPath, machine: 'Pro' }).expect(409, { error: `${trackerPath} is already starting on Pro` });
    expect(spawnsOf(pro)).toHaveLength(1);

    // A remote launch never blocks this machine's own Orchestrate (spec, "Starting on <machine>").
    await post({ project: trackerPath }).expect(201, { sessionId: 'sess-home' });
    expect(spawnsOf(home)).toHaveLength(1);
  });

  it("a live remote run on Pro's host 409s a Pro orchestrate, and does not block home", async () => {
    await start();
    jest.spyOn(app!.get(RemoteRunsService), 'list').mockReturnValue([remoteRun('pro-mac')]);
    await post({ project: trackerPath, machine: 'Pro' }).expect(409, { error: `a run of ${FAKE_REPO} is live on Pro` });
    expect(spawnsOf(pro)).toEqual([]);
    await post({ project: trackerPath }).expect(201, { sessionId: 'sess-home' });
  });

  it("a remote run on ANOTHER machine's host does not block a Pro orchestrate", async () => {
    await start();
    jest.spyOn(app!.get(RemoteRunsService), 'list').mockReturnValue([remoteRun('a@x'), remoteRun(null)]);
    await post({ project: trackerPath, machine: 'Pro' }).expect(201, { sessionId: 'sess-pro' });
  });

  it('a local running run does not block a Pro orchestrate', async () => {
    writeLocalRun({ status: 'running', startedAt: NOW_ISO(-60_000), updatedAt: NOW_ISO(0) });
    await start();
    // The lock still holds for home — the run is this machine's.
    expect((await post({ project: trackerPath })).status).toBe(409);
    await post({ project: trackerPath, machine: 'Pro' }).expect(201, { sessionId: 'sess-pro' });
  });
});
