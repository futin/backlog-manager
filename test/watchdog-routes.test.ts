import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { AgentsController } from '../server/src/agents/agents.controller';
import { WatchdogService } from '../server/src/agents/watchdog.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import { DEFAULT_WATCHDOG_CONFIG } from '../shared/types';
import type { OrchestratorRun } from '../shared/types';

/**
 * The two watchdog routes (design §4.2, §5.3) — `GET /api/agents/watchdog`
 * and `POST /api/agents/watchdog/config` — end to end through a real
 * `AppModule`, the same shape `test/watchdog-sweep.test.ts` already
 * exercises the sweeper itself with.
 *
 * `test/helpers/env.ts` sets `BM_WATCHDOG=off` for every jest suite (the
 * sweeper's bootstrap scan reads `orchHome()`, which is the developer's REAL
 * `~/.backlog-manager/orchestrator/` for any suite that has not overridden
 * `BM_ORCH_HOME`). This suite deletes that variable in `beforeEach` — but
 * only AFTER pointing `BM_ORCH_HOME` and `BM_WATCHDOG_FILE` at a fresh
 * `mkdtempSync` directory, mirroring watchdog-sweep.test.ts's own ordering
 * exactly: at no instant between the delete and the app being built is there
 * a live sweeper pointed at anything but this test's own temp directory.
 *
 * The dashboard stub is duplicated from watchdog-sweep.test.ts rather than
 * imported — this repo's per-suite-owns-its-stub convention — and trimmed
 * to only what these cases need: a bare `/api/spawn` success, since none of
 * the config-shape cases below ever reach the dashboard at all, and the two
 * that do (case 7 and the RULING R3 case) only need one successful spawn.
 */

const fixture = rawFixture as OrchestratorRun;

interface Sent {
  url: string;
}

describe('the two watchdog routes', () => {
  let app: INestApplication | undefined;
  let projectPath: string;
  let tmpRoot: string;
  let orchRoot: string;
  let configFile: string;
  const env = { ...process.env };
  const realFetch = global.fetch;

  function stubDashboard(): { spawns: () => Sent[] } {
    const sent: Sent[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      sent.push({ url });
      if (url.endsWith('/api/spawn')) {
        return { ok: true, status: 200, json: () => Promise.resolve({ sessionId: 'sess-1' }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(
          url.endsWith('/api/management')
            ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' }
        )
      } as Response;
    }) as jest.Mock;
    return { spawns: () => sent.filter((s) => s.url.endsWith('/api/spawn')) };
  }

  async function createApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    app = created;
    return created;
  }

  const svc = (): WatchdogService => app!.get(WatchdogService);

  /** `<BM_ORCH_HOME>/<encodeURIComponent(project)>/run.json` — the exact
   *  layout orchestrate.mjs's own projectDir()/runFilePath() write, same
   *  helper watchdog-sweep.test.ts already has. */
  function writeRun(run: OrchestratorRun): void {
    const dir = join(orchRoot, encodeURIComponent(run.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  function writeConfig(raw: unknown): void {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(raw, null, 2));
  }

  function readConfigFile(): unknown {
    return JSON.parse(readFileSync(configFile, 'utf8'));
  }

  /** A run whose heartbeat is 20 minutes old — past RUN_STALE_MS (15m), so
   *  `runs()` reads it `fresh: false` while `status` is still `running`:
   *  design §1's "crashed run", the sweeper's only subject. */
  function crashedRun(project: string, over: Partial<OrchestratorRun> = {}): OrchestratorRun {
    return {
      ...fixture,
      project,
      status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      ...over
    };
  }

  beforeEach(() => {
    projectPath = makeProject('alpha', []);

    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-watchdog-routes-'));
    orchRoot = join(tmpRoot, 'orchestrator');
    configFile = join(tmpRoot, 'settings', 'watchdog.json');

    process.env.BM_ORCH_HOME = orchRoot;
    process.env.BM_WATCHDOG_FILE = configFile;
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_AGENTS_TOKEN = 's3cret';

    // LAST, and only now: everything a sweeper could read is already pointed
    // at this case's own temp directory. See the suite header.
    delete process.env.BM_WATCHDOG;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    jest.restoreAllMocks();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // --- 1: idle, defaults, the boot idle event --------------------------------

  it('reports idle with the default config, nothing watched, and the boot idle event', async () => {
    stubDashboard();
    await createApp();

    const res = await request(app!.getHttpServer()).get('/api/agents/watchdog').expect(200);

    expect(res.body.phase).toBe('idle');
    expect(res.body.config).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(res.body.watching).toEqual([]);
    expect(res.body.events.some((e: { kind: string }) => e.kind === 'idle')).toBe(true);
  });

  // --- 2: off, BM_AGENTS unset -----------------------------------------------

  it('reports off with the BM_AGENTS reason when BM_AGENTS is unset', async () => {
    delete process.env.BM_AGENTS;
    stubDashboard();
    await createApp();

    const res = await request(app!.getHttpServer()).get('/api/agents/watchdog').expect(200);

    expect(res.body.phase).toBe('off');
    expect(res.body.reason).toBe('BM_AGENTS off');
  });

  // --- 3: graceMs clamps to its floor, on the response AND on disk -----------

  it('clamps a too-small graceMs to its floor, on the response and on disk', async () => {
    stubDashboard();
    await createApp();

    const res = await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .send({ graceMs: 1 })
      .expect(200);

    expect(res.body.config.graceMs).toBe(300_000);
    expect((readConfigFile() as { graceMs: number }).graceMs).toBe(300_000);
  });

  // --- 4: a single-field save leaves every other field where it was ---------

  it('changes only the field the request named, both on the response and on the next GET', async () => {
    stubDashboard();
    await createApp();

    const res = await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .send({ enabled: false })
      .expect(200);

    expect(res.body.config).toEqual({ ...DEFAULT_WATCHDOG_CONFIG, enabled: false });

    const getRes = await request(app!.getHttpServer()).get('/api/agents/watchdog').expect(200);
    expect(getRes.body.config).toEqual({ ...DEFAULT_WATCHDOG_CONFIG, enabled: false });
  });

  // --- 5: an unknown key is dropped, never stored, never rejected ------------

  it('drops an unknown key rather than storing or rejecting it', async () => {
    stubDashboard();
    await createApp();

    await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .send({ unknownKey: 1 })
      .expect(200);

    const onDisk = readConfigFile() as Record<string, unknown>;
    expect(onDisk.unknownKey).toBeUndefined();
    expect(onDisk).toEqual(DEFAULT_WATCHDOG_CONFIG);
  });

  // --- 6: a malformed body -----------------------------------------------
  //
  // The brief's own case 6 wants a bare string / array / null BODY to 400
  // with `{ error: 'bad body' }` over HTTP, all three alike. That is not
  // achievable for the string and the null: Express's `json()` body parser
  // (registered unconditionally by `NestFactory.create`, default options)
  // runs in STRICT mode, which requires the raw request text to start with
  // `{` or `[` before it will even attempt `JSON.parse` — a bare `"x"` or
  // `null` at the top level never reaches Nest's routing, let alone this
  // controller's own code, at all. It 400s earlier, straight out of
  // body-parser, with `{ statusCode, message, error: 'Bad Request' }` — a
  // DIFFERENT shape than this route's `{ error: 'bad body' }`, for the
  // simple reason that this controller's handler never runs to produce it.
  // Confirmed empirically before writing this file (see this task's own
  // report for the throwaway probe and its output) rather than assumed.
  //
  // The array is the one shape strict mode DOES let through unchanged
  // (arrays satisfy the same `{`/`[` check objects do), so it is the one
  // case below that can actually be pinned at the HTTP layer; the other two
  // get their own describe block further down, which calls the
  // controller's guard directly rather than going through Express's parser,
  // so the brief's real intent — the controller refuses all three shapes
  // identically — is still pinned, just at the layer that can actually see
  // it.

  it('400s a bare array reaching the controller, with { error: "bad body" }, and never touches the file', async () => {
    stubDashboard();
    await createApp();

    const res = await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .set('content-type', 'application/json')
      .send(JSON.stringify([]))
      .expect(400);

    expect(res.body).toEqual({ error: 'bad body' });
    // Never created at all — nothing in this test wrote to it before the
    // rejected POST, and the rejected POST itself never reaches
    // writeWatchdogConfig.
    expect(existsSync(configFile)).toBe(false);
  });

  it('400s (from Express\'s own strict JSON parser, before Nest routing) a bare string body, and never touches the file', async () => {
    stubDashboard();
    await createApp();

    const res = await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .set('content-type', 'application/json')
      .send(JSON.stringify('x'))
      .expect(400);

    // NOT { error: 'bad body' } — see the block comment above. This is
    // body-parser's own rejection, documented here so a future reader who
    // "fixes" this assertion to match the brief's literal table does not
    // silently paper over the fact that the controller was never reached.
    expect(res.body.error).toBe('Bad Request');
    expect(existsSync(configFile)).toBe(false);
  });

  it('400s (from Express\'s own strict JSON parser, before Nest routing) a bare null body, and never touches the file', async () => {
    stubDashboard();
    await createApp();

    const res = await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .set('content-type', 'application/json')
      .send(JSON.stringify(null))
      .expect(400);

    expect(res.body.error).toBe('Bad Request');
    expect(existsSync(configFile)).toBe(false);
  });

  describe("the controller's own guard, called directly (bypassing Express's JSON parser)", () => {
    /**
     * Pins what the brief actually cares about for the string and null
     * shapes, at the one layer that can still see it: the controller
     * method itself, called with an already-parsed body, exactly as it
     * would be if some other transport (a unit caller, a future non-strict
     * parser config) ever handed it one of these three values directly.
     * `typeof body === 'object' && body !== null && !Array.isArray(body)`
     * refuses all three identically — this is the assertion the brief's own
     * table was actually reaching for.
     */
    it.each([
      ['a bare string', 'x' as unknown],
      ['an array', [] as unknown],
      ['null', null as unknown]
    ])('refuses %s with 400 { error: "bad body" }, and never calls writeWatchdogConfig', async (_label, body) => {
      stubDashboard();
      await createApp();
      const controller = app!.get(AgentsController);

      let caught: unknown;
      try {
        controller.watchdogConfig(body as never);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(400);
      expect((caught as HttpException).getResponse()).toEqual({ error: 'bad body' });
      expect(existsSync(configFile)).toBe(false);
    });
  });

  // --- 7: RULING R2 — a toggle flipped on while a run sits crashed acts now --

  it('arms and ticks immediately when enabled is flipped on while a run sits crashed and disabled', async () => {
    const dash = stubDashboard();
    writeConfig({ enabled: false });
    await createApp();
    writeRun(crashedRun(projectPath));

    // A baseline established by an explicit tick, not by bootstrap timing
    // (bootstrap saw an empty directory and is idle by the time this line
    // runs) — the same "attributable to this call, not to bootstrap"
    // discipline watchdog-sweep.test.ts's own case 20b documents.
    await svc().tick();
    expect(dash.spawns()).toHaveLength(0);

    const res = await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .send({ enabled: true })
      .expect(200);

    expect(res.body.phase).toBe('armed');

    // RULING R2: the route calls `arm()` (a no-op here — a timer already
    // exists from the tick above) AND THEN kicks `tick()` directly, without
    // awaiting it, so the HTTP response above is never delayed by the
    // spawn. `watchdog.tick()` here returns the SAME in-flight promise the
    // route's own fire-and-forget kick started (`tick()`'s in-flight guard
    // makes a second caller's call resolve the one already running rather
    // than start a duplicate) — awaiting it is what turns "a spawn was
    // made" into an assertion about settled state instead of a race against
    // it.
    await svc().tick();

    expect(dash.spawns()).toHaveLength(1);
  });

  // --- 8: the guard rejects a cross-origin POST, and the file stays untouched

  it("rejects a cross-origin POST via SameOriginPostGuard, and never touches the file", async () => {
    stubDashboard();
    await createApp();

    await request(app!.getHttpServer())
      .post('/api/agents/watchdog/config')
      .set('origin', 'http://evil.example')
      .send({ enabled: false })
      .expect(403);

    expect(existsSync(configFile)).toBe(false);
  });

  // --- 9: events[0].kind is 'spawned' after a resume spawn -------------------

  it("reports the spawned event first, after a resume spawn", async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();
    expect(dash.spawns()).toHaveLength(1);

    const res = await request(app!.getHttpServer()).get('/api/agents/watchdog').expect(200);
    expect(res.body.events[0].kind).toBe('spawned');
  });

  // --- RULING R3: a successful orchestrate/resume spawn is a third arming ---
  // trigger (design §2.1), wired in AgentsController rather than
  // AgentsService — WatchdogService already injects AgentsService (for
  // resume()), so the reverse edge would be a dependency cycle Nest cannot
  // construct.

  it('leaves the watchdog armed after a successful POST /api/agents/resume', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    // A known baseline, not an assumption about bootstrap timing: force
    // idle so the assertion below actually means something.
    svc().disarm();
    expect(svc().armed).toBe(false);

    await request(app!.getHttpServer())
      .post('/api/agents/resume')
      .send({ project: projectPath })
      .expect(201);

    // RULING R3: the controller calls `arm()` right after the successful
    // spawn above. Because the run file on disk in this test is never
    // actually heartbeated (there is no real `--resume` session behind this
    // stub — only `/api/spawn` is answered), the tick `arm()` itself kicks
    // off finds the SAME run still reading crashed and, finding no watchdog
    // state entry yet (a board-triggered resume never touches
    // WatchdogStateService), spawns a SECOND resume of its own. This is not
    // a bug this task introduces: it is the identical "human-versus-
    // watchdog double-resume window" design §7 already names and already
    // accepts, shrunk to "a few seconds" there by an early `heartbeat` on
    // the skill side rather than eliminated here — and design §2.1
    // describes this exact call as "belt-and-braces over the observe()
    // trigger the board's own runs poll already provides," which carries
    // the identical race today via `refreshRuns()`'s own
    // `GET /api/orchestrator/runs` call after every manual Resume click.
    // So this case asserts what Task 5 actually owns — `arm()` ran — and
    // settles the tick it triggered (`svc().tick()` returns the SAME
    // in-flight promise) rather than leaving it dangling past this test's
    // own `afterEach`.
    await svc().tick();

    expect(dash.spawns().length).toBeGreaterThanOrEqual(1);
    expect(svc().armed).toBe(true);
  });
});
