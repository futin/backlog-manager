import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { DispatchRecordsService } from '../server/src/items/dispatch-records.service';
import { RemoteStartingService } from '../server/src/orchestrator/remote-starting.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { COMMIT_RULE, DEFAULT_MODEL, finishClause } from '../shared/agent';
import { RUN_STALE_MS } from '../shared/types';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';

/**
 * Multi-dashboard task 5 — `POST /api/agents/dispatch` with a `machine`. Driven end to end through a real `AppModule`: GitHub is the in-memory fake (so the
 * tracker item is a real mapped issue with a real claim path), and every dashboard and the remote backlog-manager ("board") are real HTTP servers on
 * `127.0.0.1`, each recording the path, the `Authorization` header and the body of every request it was sent — which is how "the spawn went to Pro, with
 * Pro's token, at Pro's dirName" and "nothing was spawned anywhere" are asserted rather than inferred.
 *
 * The local project's path is a temp dir (the registry needs a real checkout with a committed marker), standing in for the brief's `/Users/me/bm`; Pro's
 * copy of the same repo is `/Users/p/bm`, which Pro's board reports and Pro's dashboard lists under its own dirName.
 */

const HOME_TOKEN = 'tok-home-123';
const PRO_TOKEN = 'tok-pro-456';
const REMOTE_PATH = '/Users/p/bm';
const PRO_DIRNAME = '-Users-p-bm';
const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });
const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');
const HEALTH = { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' };
const NOW_ISO = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const ACCOUNT = {
  usageStatus: 'ok',
  usage: { fiveHour: { utilization: 5, resetsAt: NOW_ISO(3_600_000) }, sevenDay: { utilization: 5, resetsAt: NOW_ISO(4 * 86_400_000) } }
};
const PROFILE = { exhaustAt: null, walkAbsent: null, resetsAt: NOW_ISO(4 * 86_400_000) };

interface Seen {
  method: string;
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

/** A route's answer is its JSON body (200), or a bare status code. Every request is recorded, its body included, once it has been read in full. */
async function stub(routes: Record<string, unknown>): Promise<Stub> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
      const answer = routes[path];
      if (answer === undefined) {
        res.writeHead(404).end();
        return;
      }
      if (typeof answer === 'number') {
        res.writeHead(answer).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** An origin nothing listens on: bind an ephemeral port, then give it back. */
async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

const spawnsOf = (s: Stub): Seen[] => s.seen.filter((r) => r.path === '/api/spawn');

describe('POST /api/agents/dispatch with a machine', () => {
  let app: INestApplication | undefined;
  let gh: FakeGithub;
  let home: Stub;
  let pro: Stub;
  let board: Stub;
  let trackerPath: string;
  let filesPath: string;
  let settingsFile: string;
  const env = { ...process.env };

  const post = (body: Record<string, unknown>) => request(app!.getHttpServer()).post('/api/agents/dispatch').send(body);
  const urn = (n: number): string => `gh:${FAKE_REPO}#${n}`;
  const execute = (over: Record<string, unknown> = {}) =>
    post({ itemPath: urn(31), action: 'execute', prompt: 'Use the backlog-execute skill on #31.', permissionMode: 'acceptEdits', ...over });

  /** Writes the settings file (Pro, plus `pro` overrides) and boots the app. `bmUrl` / `url` default to the live stubs. */
  async function start(pro_: Record<string, unknown> = {}): Promise<void> {
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({ dashboards: [{ name: 'Pro', url: pro.url, bmUrl: board.url, host: 'pro-mac', models: ['opus', 'sonnet'], ...pro_ }] })
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(
        makeRegistry([
          { name: 'bm', path: trackerPath },
          { name: 'alpha', path: filesPath }
        ])
      )
      .overrideProvider(GithubClient)
      .useValue(new GithubClient(gh.fetch))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
    app.get(GithubSource).settleMs = 0;
    // Seed the tracker cache the way a sweep would, then stand the poller down so no background tick races a case.
    const poller = app.get(TrackerPollerService);
    await poller.tick();
    poller.disarm();
  }

  /** The local clone the base is proved against — this machine's, never Pro's (the plan's "Base proof" decision). */
  function gitInit(): void {
    execFileSync('git', ['-C', trackerPath, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', trackerPath, 'add', '-A']);
    execFileSync('git', ['-C', trackerPath, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '-m', 'fixture']);
  }

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'bm-dispatch-remote-'));
    dirs.push(root);
    settingsFile = join(root, 'settings', 'dashboards.json');
    process.env.BM_DASHBOARDS_FILE = settingsFile;
    process.env.BM_ORCH_HOME = join(root, 'orchestrator');
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_TOKEN = HOME_TOKEN;
    process.env.BM_AGENTS_TOKEN_PRO = PRO_TOKEN;
    process.env[GITHUB_TOKEN_ENV] = 'ghp_task5RemoteDispatch';

    gh = new FakeGithub();
    gh.issue(); // #31, a groomed bug → execute
    gh.issue({ number: 32, body: '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n' }); // → groom
    gh.issue({ number: 33, state: 'closed', state_reason: 'not_planned' }); // out-of-scope → capture

    trackerPath = makeProject('bm', [], GITHUB_MARKER);
    filesPath = makeProject('alpha', [{ leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG }]);
    dirs.push(trackerPath, filesPath);

    home = await stub({
      '/api/health': HEALTH,
      '/api/configs': {
        projects: [
          { dirName: '-local-bm', path: trackerPath },
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

  it('400s a machine that is not configured, and spawns nothing', async () => {
    await start();
    await execute({ base: 'main', machine: 'Nope' }).expect(400, { error: 'unknown machine "Nope"' });
    expect(spawnsOf(home)).toEqual([]);
    expect(spawnsOf(pro)).toEqual([]);
  });

  it('400s a files-backed project on a remote', async () => {
    await start();
    const res = await post({
      itemPath: join(filesPath, 'backlog', 'bugs/open', 'bug-2-a-known-bug.md'),
      action: 'execute',
      prompt: 'Use the backlog-execute skill on bug-2.',
      permissionMode: 'acceptEdits',
      base: 'main',
      machine: 'Pro'
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Pro runs tracker projects only — ${filesPath} is files-backed` });
    expect(spawnsOf(pro)).toEqual([]);
  });

  describe('finish on a remote', () => {
    it('400s finish in-place', async () => {
      await start();
      await execute({ finish: 'in-place', machine: 'Pro' }).expect(400, { error: 'finish must be pr on Pro' });
      expect(spawnsOf(pro)).toEqual([]);
    });

    it('finish absent with base main: spawned with the pr finish clause', async () => {
      gitInit();
      await start();
      await execute({ base: 'main', machine: 'Pro' }).expect(201, { sessionId: 'sess-pro' });
      const sent = JSON.parse(spawnsOf(pro)[0].body) as { prompt: string };
      expect(sent.prompt).toBe('Use the backlog-execute skill on #31. ' + finishClause('pr', 'main'));
    });

    it('finish absent and no base: 400 base is required with finish pr', async () => {
      await start();
      await execute({ machine: 'Pro' }).expect(400, { error: 'base is required with finish pr' });
      expect(spawnsOf(pro)).toEqual([]);
    });

    it("proves the base against THIS machine's clone: a branch only Pro might have is a 400", async () => {
      gitInit();
      await start();
      await execute({ base: 'develop', machine: 'Pro' }).expect(400, {
        error: 'base must be an existing local branch — "develop" is not a branch in this project'
      });
      expect(spawnsOf(pro)).toEqual([]);
    });
  });

  describe('model and effort', () => {
    it("400s a known model outside Pro's list", async () => {
      await start();
      await execute({ base: 'main', machine: 'Pro', model: 'haiku' }).expect(400, { error: `model "haiku" is not in Pro's list (opus, sonnet)` });
      expect(spawnsOf(pro)).toEqual([]);
    });

    it('400s an unknown model on a remote — the remote dashboard would drop it silently', async () => {
      await start();
      await execute({ base: 'main', machine: 'Pro', model: 'gpt-9' }).expect(400, { error: `model "gpt-9" is not in Pro's list (opus, sonnet)` });
    });

    it("400s an effort outside Pro's list", async () => {
      await start({ efforts: ['low', 'medium'] });
      await execute({ base: 'main', machine: 'Pro', effort: 'max' }).expect(400, { error: `effort "max" is not in Pro's list (low, medium)` });
    });

    it("on home an unknown model is still dropped to DEFAULT_MODEL — today's behaviour, a remote's list notwithstanding", async () => {
      await start();
      await execute({ model: 'gpt-9' }).expect(201, { sessionId: 'sess-home' });
      expect((JSON.parse(spawnsOf(home)[0].body) as { model: string }).model).toBe(DEFAULT_MODEL);
      expect(spawnsOf(pro)).toEqual([]);
    });

    it("no model on a remote whose list lacks DEFAULT_MODEL: the machine's first listed model, never one it cannot run", async () => {
      gitInit();
      await start({ models: ['sonnet'] });
      await execute({ base: 'main', machine: 'Pro' }).expect(201);
      expect((JSON.parse(spawnsOf(pro)[0].body) as { model: string }).model).toBe('sonnet');
    });
  });

  it('409s a remote that is not offered (board down), and spawns nothing', async () => {
    gitInit();
    board = { url: await deadUrl(), seen: [] };
    await start();
    const res = await execute({ base: 'main', machine: 'Pro' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(new RegExp(`^Pro is not offered for ${trackerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: board unreachable — `));
    expect(spawnsOf(pro)).toEqual([]);
    expect(spawnsOf(home)).toEqual([]);
  });

  // T4 / final-review I1, at launch time: Pro's health answers and its project list does not, so the 409 names the dashboard as unreachable rather than
  // telling the person Pro has never seen the project.
  it("409s with 'dashboard unreachable' when Pro's /api/configs answers 500, and spawns nothing", async () => {
    gitInit();
    pro = await stub({ '/api/health': HEALTH, '/api/configs': 500, '/api/account': ACCOUNT, '/api/usage/profile': PROFILE, '/api/spawn': { sessionId: 'sess-pro' } });
    await start();
    const res = await execute({ base: 'main', machine: 'Pro' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`Pro is not offered for ${trackerPath}: dashboard unreachable — /api/configs answered 500`);
    expect(spawnsOf(pro)).toEqual([]);
    expect(spawnsOf(home)).toEqual([]);
  });

  it("success: spawns on Pro with Pro's token at Pro's dirName for the remote path, records machine Pro, and blocks a second launch on home", async () => {
    gitInit();
    await start();
    await execute({ base: 'main', machine: 'Pro' }).expect(201, { sessionId: 'sess-pro' });

    const spawns = spawnsOf(pro);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].auth).toBe(`Bearer ${PRO_TOKEN}`);
    const sent = JSON.parse(spawns[0].body) as Record<string, unknown>;
    expect(sent.project).toBe(PRO_DIRNAME);
    expect(sent.prompt).toBe('Use the backlog-execute skill on #31. ' + finishClause('pr', 'main'));
    expect(sent.model).toBe(DEFAULT_MODEL);
    // Neither machine's path rides the body: membership is by dirName, Pro's own.
    expect(spawns[0].body).not.toContain(trackerPath);
    expect(spawns[0].body).not.toContain(REMOTE_PATH);
    expect(spawnsOf(home)).toEqual([]);
    // No token leaks to the board, whose read carries none.
    expect(board.seen.every((r) => r.auth === undefined)).toBe(true);

    expect(app!.get(DispatchRecordsService).get('sess-pro')?.machine).toBe('Pro');
    expect(app!.get(RemoteStartingService).itemBlock(trackerPath, '#31', Date.now())).toMatchObject({
      kind: 'dispatch',
      project: trackerPath,
      machine: 'Pro',
      itemId: '#31'
    });

    // The same item to home: refused until Pro's session claims it — nothing on the tracker yet says it is taken.
    await execute({}).expect(409, { error: '#31 is already starting on Pro' });
    expect(spawnsOf(home)).toEqual([]);
  });

  it('groom and capture on Pro: no finish clause, no base, no 400', async () => {
    await start();
    await post({ itemPath: urn(32), action: 'groom', prompt: 'Groom #32. ' + COMMIT_RULE, permissionMode: 'acceptEdits', machine: 'Pro' }).expect(201);
    await post({ itemPath: urn(33), action: 'capture', prompt: 'Capture from #33.', permissionMode: 'acceptEdits', machine: 'Pro' }).expect(201);
    const prompts = spawnsOf(pro).map((s) => (JSON.parse(s.body) as { prompt: string }).prompt);
    expect(prompts).toEqual(['Groom #32. ' + COMMIT_RULE, 'Capture from #33.']);
  });
});

/** The service on its own: the sweep rules `list` applies, and the `RUN_STALE_MS` rule the two launch-time blocks apply. */
describe('RemoteStartingService', () => {
  const PRO = { id: 'Pro', host: 'pro-mac' };
  const T0 = Date.parse('2026-10-23T10:00:00.000Z');
  const none = { claimedHost: () => null, remoteRuns: [] };

  it('an item entry: listed, blocks the item on any machine, and dies when the item is claimed on its host', () => {
    const s = new RemoteStartingService();
    s.markItem('/p', '#31', PRO, T0);
    expect(s.itemBlock('/p', '#31', T0 + 1)).toEqual({
      kind: 'dispatch',
      project: '/p',
      machine: 'Pro',
      itemId: '#31',
      requestedAt: '2026-10-23T10:00:00.000Z'
    });
    expect(s.itemBlock('/p', '#32', T0 + 1)).toBeNull();
    // A claim by some OTHER host is not this launch's landing.
    expect(s.list({ nowMs: T0 + 1, claimedHost: () => 'a@x', remoteRuns: [] })).toHaveLength(1);
    expect(s.list({ nowMs: T0 + 1, claimedHost: (p, id) => (p === '/p' && id === '#31' ? 'pro-mac' : null), remoteRuns: [] })).toEqual([]);
    expect(s.itemBlock('/p', '#31', T0 + 1)).toBeNull();
  });

  it('any entry is gone at RUN_STALE_MS + 1, and still there at RUN_STALE_MS', () => {
    const s = new RemoteStartingService();
    s.markItem('/p', '#31', PRO, T0);
    s.markProject('/p', PRO, T0);
    expect(s.itemBlock('/p', '#31', T0 + RUN_STALE_MS)).not.toBeNull();
    expect(s.list({ nowMs: T0 + RUN_STALE_MS, ...none })).toHaveLength(2);
    expect(s.itemBlock('/p', '#31', T0 + RUN_STALE_MS + 1)).toBeNull();
    expect(s.projectBlock('/p', 'Pro', T0 + RUN_STALE_MS + 1)).toBeNull();
    expect(s.list({ nowMs: T0 + RUN_STALE_MS + 1, ...none })).toEqual([]);
  });

  it('a project entry: blocks that machine only, and dies when a remote run on its host started at or after it', () => {
    const s = new RemoteStartingService();
    s.markProject('/p', PRO, T0);
    expect(s.projectBlock('/p', 'Pro', T0 + 1)).toMatchObject({ kind: 'orchestrate', machine: 'Pro', itemId: null });
    expect(s.projectBlock('/p', 'Max', T0 + 1)).toBeNull();
    const run = (host: string | null, startedAt: number) => ({ project: '/p', host, startedAt: new Date(startedAt).toISOString() });
    // Started before the launch, or on another host: not its landing.
    expect(s.list({ nowMs: T0 + 1, claimedHost: () => null, remoteRuns: [run('pro-mac', T0 - 1), run('a@x', T0 + 1)] })).toHaveLength(1);
    expect(s.list({ nowMs: T0 + 1, claimedHost: () => null, remoteRuns: [run('pro-mac', T0)] })).toEqual([]);
  });
});
