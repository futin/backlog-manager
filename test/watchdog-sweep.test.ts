import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { WatchdogService } from '../server/src/agents/watchdog.service';
import { OrchestratorService } from '../server/src/orchestrator/orchestrator.service';
import { WatchdogStateService } from '../server/src/orchestrator/watchdog-state.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, WatchdogEventKind } from '../shared/types';

/**
 * The sweeper, end to end through a real `AppModule` — the one suite in this
 * repo that deliberately turns the watchdog ON.
 *
 * `test/helpers/env.ts` sets `BM_WATCHDOG=off` for every jest suite, because
 * the sweeper's bootstrap scan reads `orchHome()` and that is the developer's
 * REAL `~/.backlog-manager/orchestrator/` for any suite that has not
 * overridden `BM_ORCH_HOME`. This suite deletes that variable in `beforeEach`
 * — but only AFTER pointing `BM_ORCH_HOME` at a fresh `mkdtempSync` directory
 * and `BM_WATCHDOG_FILE` at a path inside it. That ordering is the whole
 * safety argument: at no instant between the delete and the app being built
 * is there a live sweeper pointed at anything but this test's own temp
 * directory.
 *
 * Two structural choices worth stating up front, because every case below
 * depends on them:
 *
 *  1. **The app is built per case, not in `beforeEach`.** `app.init()` fires
 *     `onApplicationBootstrap`, which arms and takes the first tick — so
 *     WHEN the app is created relative to when a `run.json` is written is
 *     itself part of each case's setup. Most cases build the app over an
 *     EMPTY orchestrator directory, so the bootstrap tick provably does
 *     nothing (no running run → disarm → idle) and every spawn the case
 *     observes is attributable to a `tick()` the case made itself. The
 *     fake-timer cases (16, 17, 18, 20) do the opposite on purpose: they
 *     write a run first, so the bootstrap tick arms and schedules the chain
 *     they are there to measure.
 *  2. **`tick()` is driven directly for every policy case.** Fake timers
 *     are used only where the case is about SCHEDULING. A policy case that
 *     went through the timer would be testing jest's clock as much as the
 *     sweeper's rules.
 *
 * The dashboard is stubbed the same way `test/agents-resume.test.ts` stubs
 * it — duplicated rather than shared, matching this repo's convention that
 * each e2e suite owns its own stub.
 */

// Same translation agents-resume.test.ts does: the fixture is plain JSON, so
// TS widens its string fields to `string` instead of the narrower literal
// unions (`RunStage`, `MergeMode`, …) the shared types declare.
const fixture = rawFixture as OrchestratorRun;

/** Beta's runId — distinct from the fixture's, so case 21 can tell the two
 *  runs apart in `watching` by id rather than by array position. */
const BETA_RUN_ID = 'run-20260831-084004';

interface Sent {
  url: string;
  init?: RequestInit;
}

interface StubOptions {
  /** What `POST /api/spawn` answers. Defaults to 200 `{ sessionId: 'sess-1' }`. */
  spawn?: { ok?: boolean; status?: number; body?: unknown };
  /** Hold every `/api/spawn` response open until `release()` is called (case 19). */
  pendingSpawn?: boolean;
  /** The dashboard's `spawnMaxPermission` ceiling. */
  ceiling?: string;
  /** Reject every fetch, health included — an unreachable dashboard (case 10). */
  reject?: boolean;
  /** What `/api/management` lists. Defaults to both projects. */
  projects?: Array<{ dirName: string; path: string }>;
}

describe('watchdog sweeper', () => {
  let app: INestApplication | undefined;
  let projectPath: string;
  let projectPathB: string;
  let tmpRoot: string;
  let orchRoot: string;
  let configFile: string;
  const env = { ...process.env };
  const realFetch = global.fetch;

  function stubDashboard(opts: StubOptions = {}) {
    const sent: Sent[] = [];
    let releaseSpawn: (() => void) | undefined;
    const gate = opts.pendingSpawn
      ? new Promise<void>((resolve) => {
          releaseSpawn = resolve;
        })
      : undefined;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Recorded BEFORE any awaiting, so a request that is still in flight is
      // still visible to an assertion — case 19 depends on exactly that.
      sent.push({ url, init });
      if (opts.reject) throw new Error('ECONNREFUSED');
      if (url.endsWith('/api/spawn')) {
        if (gate) await gate;
        const spawn = opts.spawn ?? {};
        const ok = spawn.ok ?? true;
        return {
          ok,
          status: spawn.status ?? (ok ? 200 : 429),
          json: () => Promise.resolve(spawn.body ?? { sessionId: 'sess-1' })
        } as Response;
      }
      const projects = opts.projects ?? [
        { dirName: '-abs-alpha', path: projectPath },
        { dirName: '-abs-beta', path: projectPathB }
      ];
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url.endsWith('/api/management')
              ? { projects: projects.map((p) => ({ ...p, name: p.dirName, lastActiveMs: 1 })) }
              : {
                  ok: true,
                  remoteAnswer: true,
                  spawnAvailable: true,
                  spawnMaxPermission: opts.ceiling ?? 'auto'
                }
          )
      } as Response;
    }) as jest.Mock;

    return {
      sent,
      spawns: () => sent.filter((s) => s.url.endsWith('/api/spawn')),
      release: () => releaseSpawn?.()
    };
  }

  async function createApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(
        makeRegistry([
          { name: 'alpha', path: projectPath },
          { name: 'beta', path: projectPathB }
        ])
      )
      .compile();
    const created = moduleRef.createNestApplication();
    // No enableShutdownHooks(): that is only for OS signals, and it would add
    // (and, on a failing case, leak) process listeners once per case. Nest's
    // `app.close()` calls onApplicationShutdown on its own, which is what
    // afterEach relies on to disarm the chain before the temp directory goes.
    await created.init();
    app = created;
    return created;
  }

  const svc = (): WatchdogService => app!.get(WatchdogService);
  const state = (): WatchdogStateService => app!.get(WatchdogStateService);
  const kinds = (kind: WatchdogEventKind) => state().events().filter((e) => e.kind === kind);

  /** `<BM_ORCH_HOME>/<encodeURIComponent(project)>/run.json` — the exact
   *  layout orchestrate.mjs's own projectDir()/runFilePath() write. */
  function writeRun(run: OrchestratorRun): void {
    const dir = join(orchRoot, encodeURIComponent(run.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  function writeConfig(raw: unknown): void {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(raw, null, 2));
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

  function freshRun(project: string, over: Partial<OrchestratorRun> = {}): OrchestratorRun {
    return {
      ...fixture,
      project,
      status: 'running',
      updatedAt: new Date().toISOString(),
      ...over
    };
  }

  function spawnBody(sent: Sent): Record<string, unknown> {
    return JSON.parse(String(sent.init?.body)) as Record<string, unknown>;
  }

  beforeEach(() => {
    projectPath = makeProject('alpha', []);
    projectPathB = makeProject('beta', []);

    // A fresh, empty orchestrator home per case — deliberately NOT created,
    // so the "no run.json anywhere" case (4) is the natural starting state
    // rather than something a case has to arrange.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-watchdog-'));
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
      // Closed while any fake clock is still installed, so the sweeper's
      // clearTimeout() matches the setTimeout() that made the handle.
      await app.close();
      app = undefined;
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // --- 1: the whole point of the feature ------------------------------------

  it('spawns exactly one resume for a crashed run, and records it', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();

    expect(dash.spawns()).toHaveLength(1);
    const body = spawnBody(dash.spawns()[0]);
    expect(body.prompt).toBe('/backlog-orchestrate --resume');
    expect(String(body.name).startsWith('watchdog resume ')).toBe(true);
    expect(body.permissionMode).toBe('auto');

    const entry = state().entry(fixture.runId);
    expect(entry?.attempts).toBe(1);
    expect(entry?.lastSessionId).toBe('sess-1');
    expect(entry?.lastError).toBeNull();

    const spawned = kinds('spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].detail).toContain('1/2');
    expect(spawned[0].detail).toContain('sess-1');
  });

  // --- 2: a healthy run keeps the chain alive and spawns nothing ------------

  it('leaves a fresh running run alone, stays armed, and schedules the next tick', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(freshRun(projectPath));

    await svc().tick();

    expect(dash.spawns()).toHaveLength(0);
    expect(svc().armed).toBe(true);
    expect(state().nextTickAt).not.toBeNull();
  });

  // --- 3 & 4: nothing running → stand down ---------------------------------
  // One `idle` event, not one per tick: the event marks the TRANSITION into
  // idle, so a sweeper that sits idle for a week does not fill its own ring
  // buffer with fifty identical lines and push every real event out of it.

  it('stands down for a finished run, with exactly one idle event', async () => {
    const dash = stubDashboard();
    writeRun({ ...fixture, project: projectPath, status: 'done' });
    await createApp();

    await svc().tick();

    expect(dash.spawns()).toHaveLength(0);
    expect(svc().armed).toBe(false);
    expect(state().phase).toBe('idle');
    expect(kinds('idle')).toHaveLength(1);
  });

  it('stands down when there is no run file at all, with exactly one idle event', async () => {
    const dash = stubDashboard();
    await createApp();

    await svc().tick();

    expect(dash.spawns()).toHaveLength(0);
    expect(svc().armed).toBe(false);
    expect(state().phase).toBe('idle');
    expect(kinds('idle')).toHaveLength(1);
  });

  // --- 5: grace, not the in-flight guard ------------------------------------
  // The first tick is AWAITED before the second is made, so the in-flight
  // dedup (case 19) is provably not what produces the single spawn here —
  // grace is. Called without awaiting, this case would be a duplicate of 19.

  it('does not spawn twice back to back — grace holds the second tick off', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();
    await svc().tick();

    expect(dash.spawns()).toHaveLength(1);
    expect(state().entry(fixture.runId)?.attempts).toBe(1);
  });

  // --- 6: past grace, the second attempt lands ------------------------------

  it('spawns a second resume once grace has elapsed', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();
    const entry = state().entry(fixture.runId)!;
    entry.lastSpawnAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();

    await svc().tick();

    expect(dash.spawns()).toHaveLength(2);
    expect(state().entry(fixture.runId)?.attempts).toBe(2);
  });

  // --- 7: the cap, and the once-only exhausted line -------------------------

  it('stops at maxAttempts, logging exhausted exactly once however many ticks follow', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();
    const entry = state().entry(fixture.runId)!;
    entry.lastSpawnAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await svc().tick();
    entry.lastSpawnAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();

    await svc().tick();

    expect(dash.spawns()).toHaveLength(2);
    expect(state().entry(fixture.runId)?.exhausted).toBe(true);
    expect(kinds('exhausted')).toHaveLength(1);

    await svc().tick();
    expect(kinds('exhausted')).toHaveLength(1);
    expect(dash.spawns()).toHaveLength(2);
  });

  // --- 7b: exhausted is decided BEFORE grace --------------------------------
  // Not one of the brief's 22 rows, and added because the ordering of design
  // §2.2's steps 3 and 4 is otherwise unpinned: with grace checked first, a
  // run that just used its LAST attempt would sit un-`exhausted` for the
  // whole grace window, and the strip's Resume button — which renders on
  // `exhausted` — would appear ten minutes after the sweeper had already
  // given up. Making a person wait to be told nobody is coming is exactly
  // what this feature exists to stop.

  it('marks a run exhausted on the next tick even while grace is still running', async () => {
    const dash = stubDashboard();
    writeConfig({ maxAttempts: 1 });
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();
    expect(state().entry(fixture.runId)?.attempts).toBe(1);

    // No lastSpawnAt rewind: this second tick is squarely inside graceMs.
    await svc().tick();

    expect(dash.spawns()).toHaveLength(1);
    expect(state().entry(fixture.runId)?.exhausted).toBe(true);
    expect(kinds('exhausted')).toHaveLength(1);
  });

  // --- 8: a rejected spawn starts grace but burns no attempt ----------------

  it('records a rejected spawn without counting it against the cap', async () => {
    const dash = stubDashboard({ spawn: { ok: false, status: 429, body: { error: 'busy' } } });
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();

    const entry = state().entry(fixture.runId);
    expect(entry?.attempts).toBe(0);
    expect(entry?.lastError).toBe('busy');
    expect(entry?.lastSpawnAt).not.toBeNull();

    const failed = kinds('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toContain('busy');
    expect(failed[0].detail).toContain('not counted');
  });

  // --- 9: grace covers failures too -----------------------------------------
  // "A dashboard that is down for a day must not burn the cap, and a spawn
  // that failed must not be retried every tick" (design §2.2).

  it('does not retry a failed spawn on the very next tick', async () => {
    const dash = stubDashboard({ spawn: { ok: false, status: 429, body: { error: 'busy' } } });
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();
    await svc().tick();

    expect(dash.spawns()).toHaveLength(1);
    expect(state().entry(fixture.runId)?.attempts).toBe(0);
  });

  // --- 10: the gate refusing is a failure, recorded the same way ------------

  it('records the gate\'s own wording when the dashboard is unreachable', async () => {
    const dash = stubDashboard({ reject: true });
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();

    expect(dash.spawns()).toHaveLength(0);
    const entry = state().entry(fixture.runId);
    expect(entry?.attempts).toBe(0);
    expect(entry?.lastError).toContain('unreachable');
    expect(kinds('failed')).toHaveLength(1);
  });

  // --- 11: BM_AGENTS off — nothing on this server can spawn -----------------

  it('reports phase off with the BM_AGENTS reason and makes no call of any kind', async () => {
    delete process.env.BM_AGENTS;
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    svc().arm();
    await svc().tick();

    expect(state().phase).toBe('off');
    expect(state().reason).toBe('BM_AGENTS off');
    expect(dash.sent).toHaveLength(0);
    expect(svc().armed).toBe(false);
  });

  // --- 12: BM_WATCHDOG=off — the operator's kill switch ---------------------
  // `arm()` still SAYS what it is doing (phase + reason are what the Settings
  // State row reads); "no-op" means no timer and no tick, which is what the
  // `runs()` spy proves.

  it('reports phase off with the BM_WATCHDOG reason, and arms nothing', async () => {
    process.env.BM_WATCHDOG = 'off';
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));

    const runsSpy = jest.spyOn(OrchestratorService.prototype, 'runs');
    svc().arm();

    expect(state().phase).toBe('off');
    expect(state().reason).toBe('BM_WATCHDOG off');
    expect(svc().armed).toBe(false);
    expect(runsSpy).not.toHaveBeenCalled();
    expect(dash.sent).toHaveLength(0);
  });

  // --- 13: the Settings toggle — watch, report, never spawn -----------------

  it('keeps watching but never spawns while the config toggle is off', async () => {
    const dash = stubDashboard();
    writeConfig({ enabled: false });
    await createApp();
    writeRun(crashedRun(projectPath));

    await svc().tick();
    await svc().tick();
    await svc().tick();

    expect(state().phase).toBe('armed');
    expect(dash.sent).toHaveLength(0);
    expect(kinds('disabled')).toHaveLength(1);

    const res = await request(app!.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    const run = res.body.runs.find((r: { runId: string }) => r.runId === fixture.runId);
    expect(run.watchdog.enabled).toBe(false);
  });

  // --- 14 & 15: the run comes back, then finishes ---------------------------

  it('logs recovered once when a spawned-at run starts heartbeating again', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));
    await svc().tick();
    expect(dash.spawns()).toHaveLength(1);

    writeRun(freshRun(projectPath));
    await svc().tick();

    expect(kinds('recovered')).toHaveLength(1);
    expect(dash.spawns()).toHaveLength(1);
    expect(state().entry(fixture.runId)).toBeDefined();
  });

  it('prunes the entry and goes idle once the recovered run finishes', async () => {
    stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));
    await svc().tick();
    writeRun(freshRun(projectPath));
    await svc().tick();

    writeRun({ ...freshRun(projectPath), status: 'done' });
    await svc().tick();

    expect(state().entry(fixture.runId)).toBeUndefined();
    expect(state().phase).toBe('idle');
  });

  // --- 16: the chain reschedules itself -------------------------------------
  // Measured with a spy on OrchestratorService.prototype.runs rather than by
  // counting readFileSync: a spy is deterministic, where an fs counter would
  // couple the assertion to how many files this case's temp directory happens
  // to hold.

  it('reschedules itself: a tick runs again one tickMs later', async () => {
    jest.useFakeTimers();
    stubDashboard();
    writeRun(freshRun(projectPath));
    await createApp();

    const runsSpy = jest.spyOn(OrchestratorService.prototype, 'runs');
    await jest.advanceTimersByTimeAsync(60_000);

    expect(runsSpy).toHaveBeenCalled();
  });

  // --- 17: a config change between ticks is honoured ------------------------
  // The pending timer keeps the interval it was SCHEDULED with — a setTimeout
  // chain reads its interval when it schedules, not when it fires — so the
  // new 30s cadence starts from the next tick, not from the write.

  it('honours a tickMs written between ticks, from the next tick onwards', async () => {
    jest.useFakeTimers();
    stubDashboard();
    writeRun(freshRun(projectPath));
    await createApp();

    writeConfig({ tickMs: 30_000 });
    const runsSpy = jest.spyOn(OrchestratorService.prototype, 'runs');

    await jest.advanceTimersByTimeAsync(30_000);
    expect(runsSpy).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(runsSpy).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(runsSpy).toHaveBeenCalledTimes(2);
  });

  // --- 18: arm() is idempotent ----------------------------------------------

  it('arms once however many times arm() is called', async () => {
    jest.useFakeTimers();
    stubDashboard();
    writeRun(freshRun(projectPath));
    await createApp();

    const runsSpy = jest.spyOn(OrchestratorService.prototype, 'runs');
    svc().arm();
    svc().arm();
    await Promise.resolve();

    expect(jest.getTimerCount()).toBe(1);
    expect(runsSpy).not.toHaveBeenCalled();
    expect(kinds('armed')).toHaveLength(1);
    expect(svc().armed).toBe(true);
  });

  // --- 19: two ticks can never overlap --------------------------------------

  it('returns the in-flight promise rather than starting a second tick', async () => {
    const dash = stubDashboard({ pendingSpawn: true });
    await createApp();
    writeRun(crashedRun(projectPath));

    const first = svc().tick();
    const second = svc().tick();
    expect(second).toBe(first);

    dash.release();
    await first;

    expect(dash.spawns()).toHaveLength(1);
  });

  // --- 20: shutdown stops the chain dead ------------------------------------

  it('disarms on shutdown and fires no further tick', async () => {
    jest.useFakeTimers();
    stubDashboard();
    writeRun(freshRun(projectPath));
    await createApp();
    expect(svc().armed).toBe(true);

    svc().onApplicationShutdown();
    expect(svc().armed).toBe(false);

    const runsSpy = jest.spyOn(OrchestratorService.prototype, 'runs');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(runsSpy).not.toHaveBeenCalled();
  });

  // --- 20b: shutdown mid-await must not let the tick reschedule itself -----
  //
  // Case 20 only pins the EASY half of the shutdown race: a timer already
  // pending, which disarm()'s own clearTimer() reaches directly. The HARD
  // half — shutdown landing while a tick is mid-`await`, after sweep() has
  // already cleared its OWN timer at the top but before it reaches the
  // `setTimeout` at the bottom — is exactly what the `stopped` flag exists
  // for (watchdog.service.ts:301). Case 20 never has a tick in flight when
  // shutdown lands, so it cannot exercise that check: deleting
  // `if (this.stopped) return;` leaves case 20 green. This case forces a
  // tick to still be running by holding its spawn open with the suite's own
  // `pendingSpawn` gate (the same mechanism case 19 uses to prove two ticks
  // never overlap).
  it('does not schedule a new tick when shutdown lands mid-await', async () => {
    jest.useFakeTimers();
    const dash = stubDashboard({ pendingSpawn: true });
    await createApp();
    // Written AFTER createApp(), so the bootstrap tick sees an empty
    // directory and disarms immediately — matching case 19's structure, so
    // every runs() read below is attributable to the tick() this case makes
    // itself, not to bootstrap.
    writeRun(crashedRun(projectPath));

    // Installed after createApp() and after the run is written, so this spy
    // counts only reads made by the tick() below — case 16's own technique
    // for turning "no further tick ran" into a checkable count rather than
    // an assertion of absence.
    const runsSpy = jest.spyOn(OrchestratorService.prototype, 'runs');

    const p = svc().tick();
    // By the time tick() returns control here, sweep() has read runs() once
    // (the count below is captured baseline, not asserted to be 1: a
    // SUCCESSFUL spawn makes `agents.resume()` re-read `orchestrator.runs()`
    // a second time on its own, as part of re-validating the run is still
    // crashed immediately before it dispatches — see
    // `agents.service.ts`'s `resume()`, the `this.orchestrator.runs().runs.find(...)`
    // above its freshness check. That second read is unrelated to
    // rescheduling and must not be mistaken for it, which is exactly why
    // this case compares against a captured baseline instead of a literal
    // count) and is now suspended inside spawn()'s
    // `await this.agents.resume(...)` on the gated /api/spawn fetch —
    // genuinely mid-await, not merely "about to await".
    svc().onApplicationShutdown();
    dash.release();
    await p;

    // Shutdown's own disarm() is what makes this false; the assertion that
    // matters is the one below.
    expect(svc().armed).toBe(false);

    // Baseline AFTER the in-flight tick has fully settled (its own top-level
    // read, plus resume()'s internal re-check, both done). Comparing against
    // this rather than a literal number is what keeps the assertion honest:
    // it is about whether a NEW tick ran, not about how many times a single
    // tick happens to call runs() internally.
    const callsOnceSettled = runsSpy.mock.calls.length;

    // Advance well past the default 60s tickMs. If `stopped` were not
    // checked at the bottom of sweep(), the tick that just finished
    // resolving its spawn would have gone on to schedule a fresh
    // setTimeout right before returning, and that timer would fire in this
    // window and take at least one further runs() read.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(runsSpy.mock.calls.length).toBe(callsOnceSettled);
  });

  // --- 21: two projects, one crashed ----------------------------------------

  it('spawns only for the crashed project while watching both', async () => {
    const dash = stubDashboard();
    await createApp();
    writeRun(crashedRun(projectPath));
    writeRun(freshRun(projectPathB, { runId: BETA_RUN_ID }));

    await svc().tick();

    expect(dash.spawns()).toHaveLength(1);
    expect(spawnBody(dash.spawns()[0]).project).toBe('-abs-alpha');
    expect(svc().status().watching.sort()).toEqual([fixture.runId, BETA_RUN_ID].sort());
  });

  // --- 22: what GET /api/agents/watchdog will serve -------------------------

  it('reports phase, the clamped config, newest-first events and a due nextTickAt', async () => {
    stubDashboard();
    writeConfig({ tickMs: 30_000 });
    writeRun(crashedRun(projectPath));
    await createApp();
    await svc().tick();

    const status = svc().status();
    expect(status.phase).toBe('armed');
    expect(status.config).toEqual({
      enabled: true,
      tickMs: 30_000,
      graceMs: 600_000,
      maxAttempts: 2
    });
    expect(status.watching).toEqual([fixture.runId]);

    expect(status.events.length).toBeGreaterThanOrEqual(2);
    expect(status.events[0].kind).toBe('spawned');
    expect(status.events[status.events.length - 1].kind).toBe('armed');
    const times = status.events.map((e) => Date.parse(e.at));
    for (let i = 1; i < times.length; i += 1) expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);

    const due = Date.parse(status.nextTickAt!) - Date.now();
    expect(due).toBeGreaterThan(0);
    expect(due).toBeLessThanOrEqual(30_000);
  });
});
