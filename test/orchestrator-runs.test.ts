import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { OrchestratorService } from '../server/src/orchestrator/orchestrator.service';
import { RemoteRunsService } from '../server/src/orchestrator/remote-runs.service';
import { RemoteStartingService } from '../server/src/orchestrator/remote-starting.service';
import { StartingRunsService } from '../server/src/orchestrator/starting-runs.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import { runClaimBlock } from '../shared/agent';
import type { BacklogItem, OrchestratorRun, RemoteRun } from '../shared/types';

// Same translation orchestrator-shapes.test.ts already does: the fixture is
// plain JSON (no `as const`), so TS would otherwise widen its string fields
// to `string` instead of the narrower literal unions (`RunStage`, etc.).
// This cast is what lets `{ ...fixture, updatedAt: ... }` below type-check
// as a real OrchestratorRun rather than a bag of strings.
const fixture = rawFixture as OrchestratorRun;

describe('GET /api/orchestrator/runs', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  let controlRoot: string;
  const env = { ...process.env };

  // The exact layout orchestrate.mjs's own projectDir()/runFilePath() write:
  // <root>/<encodeURIComponent(absolute project path)>/run.json, plus a
  // sibling runs/ directory for archived runs. Duplicated here rather than
  // imported from the .mjs tool because that tool is a standalone script
  // with no exported package boundary into this TS project — the fixture
  // and this path shape are the cross-language contract, not a shared module.
  function projectDir(project: string): string {
    return join(orchHome, encodeURIComponent(project));
  }

  function writeRun(run: OrchestratorRun): string {
    const dir = projectDir(run.project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify(run, null, 2));
    return file;
  }

  /** The pause-request file's own layout (task-17) — flat under
   *  `BM_ORCH_CONTROL_HOME`, one encodeURIComponent-keyed file per project.
   *  Written by hand here for the same reason `writeRun` is: what this suite
   *  proves is that the READER derives `pauseRequested` from whatever is on
   *  disk, so the writing side has to be the raw bytes, not the util that
   *  the reader also uses. */
  function writeControl(project: string, body: unknown): void {
    mkdirSync(controlRoot, { recursive: true });
    writeFileSync(join(controlRoot, `${encodeURIComponent(project)}.json`), JSON.stringify(body));
  }

  beforeEach(async () => {
    // orchHome itself is deliberately never created here. A machine that has
    // never run the orchestrator has no ~/.backlog-manager/orchestrator/ at
    // all, and the first test case below depends on that directory genuinely
    // not existing — mkdtempSync gives us a fresh unique parent to point
    // BM_ORCH_HOME's child at, not the state dir itself.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;
    // A crashed run's payload entry now reads readWatchdogConfig() (via
    // WatchdogStateService.annotate()) to fill in maxAttempts/enabled — this
    // override keeps that read pointed at a file under tmpRoot rather than
    // the developer's real ~/.backlog-manager/settings/watchdog.json, the
    // same isolation BM_ORCH_HOME above already gives run.json itself. Left
    // pointing at a path that never gets written in this suite, so every
    // case here reads DEFAULT_WATCHDOG_CONFIG.
    process.env.BM_WATCHDOG_FILE = join(tmpRoot, 'settings', 'watchdog.json');
    // task-17: the pause-request directory, pointed inside tmpRoot for the
    // same reason as the two above. `test/helpers/env.ts` already defaults
    // it away from the real one process-wide; this narrows it to one case's
    // own scratch space so a request written here cannot outlive the test.
    controlRoot = join(tmpRoot, 'settings', 'orchestrator-control');
    process.env.BM_ORCH_CONTROL_HOME = controlRoot;

    // REGISTRY_FILE is overridden the same way app.test.ts and
    // agents-status.test.ts do it: AppModule also wires up ItemsModule and
    // AgentsModule, and leaving REGISTRY_FILE on its real-machine default
    // would have this suite reading the developer's actual
    // ~/.backlog-manager/registry.json on every test run.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // Explicitly listen once here rather than leaving it to supertest. Left
    // alone, supertest's Test#serverAddress calls `app.getHttpServer().listen(0)`
    // itself whenever the server isn't already listening, and its own end()
    // then calls `.close()` on that same server once the response lands —
    // see node_modules/supertest/lib/test.js. That is a listen/close cycle
    // per request, on the *same* underlying http.Server object, and it is
    // only safe if each cycle fully completes before the next begins. Every
    // other case in this file makes one request per test, so it never
    // exercises this — but "never caches" below makes two, with a disk write
    // in between, specifically to prove the endpoint re-reads per request.
    // Under `--runInBand`'s single process, with dozens of other suites
    // opening and closing their own Nest apps and ephemeral servers on the
    // same event loop, that back-to-back listen/close pair on one Server
    // instance was the flaky part: it reproduced as a bare `socket hang up`
    // roughly 1 run in 4 under the full suite, never in isolation, and never
    // on any single-request case in this same file. Listening once here (and
    // never again per request) means every `request(app.getHttpServer())`
    // call below finds `app.address()` already non-null, so supertest reuses
    // that one address for the whole test and never touches listen/close
    // itself — see the `if (!addr)` branch in serverAddress. `app.close()`
    // below still tears the one listener down at the end of each test.
    //
    // What that reasoning got half right (bug-33): the churn is what buys a
    // ticket in the port lottery per REQUEST rather than per suite, but the
    // bare `listen(0)` it was written as left the wildcard bind in place, so
    // this suite kept the rarer half of the defect — supertest dials
    // 127.0.0.1 while a host-less bind takes the port on `::`, and whoever
    // else holds that number on 127.0.0.1 answers. The helper is the same
    // single listen with the host argument that closes it.
    await listenLoopback(app);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty list when the state dir does not exist yet', async () => {
    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body).toEqual({ runs: [], starting: [], remote: [], remoteStarting: [] });
  });

  it('reports a fresh running fixture with its queue passed through intact', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    // toEqual over the whole object (not just a `fresh`/`pastRuns` check) is
    // what proves the queue — and every other field — survives verbatim.
    expect(res.body.runs).toEqual([{ ...run, fresh: true, pastRuns: 0, pauseRequested: false, stopRequested: false }]);
  });

  it("carries a run's merge-mode fields through untouched when they already disagree", async () => {
    // Deliberately NOT the fixture's own 'merge'/'merge'/null — those three
    // values are also this reader's default, so a sanitiser that silently
    // defaulted instead of reading the file would pass a test built on them
    // without anyone noticing. mergeMode !== mergeModeEffective, plus a real
    // note, is the actual shape a mid-run merge denial produces (design
    // §2.5) and the only shape that proves "read from disk" apart from
    // "defaulted" — if the reader defaulted here, mergeModeEffective would
    // come back 'merge', not 'branch', and mergeModeNote would come back
    // null, not this string.
    const run: OrchestratorRun = {
      ...fixture,
      updatedAt: new Date().toISOString(),
      mergeMode: 'merge',
      mergeModeEffective: 'branch',
      mergeModeNote: 'merge classifier denied the merge for bug-14; falling back to branch for the rest of the queue'
    };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].mergeMode).toBe('merge');
    expect(res.body.runs[0].mergeModeEffective).toBe('branch');
    expect(res.body.runs[0].mergeModeNote).toBe('merge classifier denied the merge for bug-14; falling back to branch for the rest of the queue');
  });

  it('defaults mergeMode/mergeModeEffective to merge and mergeModeNote to null for a run file written before this feature existed', async () => {
    // Every archived run on every machine today predates this feature, so a
    // pre-feature run.json has none of these three keys at all — not `null`,
    // simply absent, the shape JSON.parse hands back for a key nobody ever
    // wrote. This is the single most important case in this task: an old run
    // must keep rendering as a plain, uneventful merge run, not as one with
    // `undefined` fields the board has never been told how to draw.
    const { mergeMode: _mergeMode, mergeModeEffective: _mergeModeEffective, mergeModeNote: _mergeModeNote, ...legacyRun } = fixture;
    const dir = projectDir(fixture.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...legacyRun, updatedAt: new Date().toISOString() }, null, 2));

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].mergeMode).toBe('merge');
    expect(res.body.runs[0].mergeModeEffective).toBe('merge');
    expect(res.body.runs[0].mergeModeNote).toBeNull();
  });

  it('resolves an absent base to main for a run file written before task-44', async () => {
    // The same shape as the merge-fields case above and for the same reason:
    // every run file written before task-44 lacks `base` entirely, and those
    // runs could merge nowhere but `main`, so resolving to it is a statement
    // of what they actually did rather than a guess.
    //
    // This case exists because a red-proof found the resolution UNPINNED —
    // deleting it from `sanitizeMergeFields` broke nothing. That absence is
    // what lets `OrchestratorRun.base` be declared required: if this reader
    // stopped totalising it, every consumer above would start receiving
    // `undefined` through a field typed `string`, and the first one to render
    // it would print nothing where a branch name belongs.
    const { base: _base, ...legacyRun } = fixture;
    const dir = projectDir(fixture.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...legacyRun, updatedAt: new Date().toISOString() }, null, 2));

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].base).toBe('main');
  });

  it('reads a real base off disk rather than defaulting it', async () => {
    // The other half, and the one the case above cannot make on its own:
    // `'main'` is also this reader's default, so a sanitiser that ignored the
    // file entirely would pass it. A run that merged into `feature/x` must
    // come back saying so — that value is the only record of where the work
    // landed.
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString(), base: 'feature/x' };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].base).toBe('feature/x');
  });

  it('falls back to merge for a nonsense mergeMode on disk rather than throwing', async () => {
    // This reader sanitises a file another process wrote; it does not trust
    // it. A hand-edited file, a future build's mode this server has never
    // heard of, or plain disk corruption must degrade exactly like the
    // absent-fields case above rather than 500 the whole payload — the
    // deliberate asymmetry with POST /api/agents/orchestrate's 400 for the
    // identical string (agents.service.ts's resolveMergeMode): there the
    // value is a caller's instruction about to be acted on and merging to
    // main is irreversible, so a bad value must be refused; here the value
    // is a reading of a run that already happened, and refusing to render
    // history helps nobody.
    const run = { ...fixture, updatedAt: new Date().toISOString(), mergeMode: 'nonsense' };
    const dir = projectDir(fixture.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].mergeMode).toBe('merge');
  });

  // spec P4/P5. The two PR fields are read at the same two sites as the merge fields and degrade the same way — a reading of a run that already happened, so
  // a bad byte becomes `null` rather than a 500 — but `prUrl` is held to `isPrUrl` and not just `typeof === 'string'`, because the client renders it as an href.
  describe('prTarget and prUrl', () => {
    async function readBack(over: Record<string, unknown>, drop: string[] = []): Promise<OrchestratorRun> {
      const run: Record<string, unknown> = { ...fixture, updatedAt: new Date().toISOString(), ...over };
      for (const key of drop) delete run[key];
      const dir = projectDir(fixture.project);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
      const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
      return res.body.runs[0];
    }

    it('reads a run file with neither key back with both null', async () => {
      const run = await readBack({}, ['prTarget', 'prUrl']);
      expect(run.prTarget).toBeNull();
      expect(run.prUrl).toBeNull();
    });

    it('reads a recorded target and a valid URL back unchanged', async () => {
      const run = await readBack({ mergeMode: 'pr', mergeModeEffective: 'pr', prTarget: 'main', prUrl: 'https://github.com/futin/backlog-manager/pull/275' });
      expect(run.prTarget).toBe('main');
      expect(run.prUrl).toBe('https://github.com/futin/backlog-manager/pull/275');
    });

    it('nulls a URL that is not a pull request URL and leaves everything else intact', async () => {
      const run = await readBack({ prTarget: 'main', prUrl: 'https://example.com/x' });
      expect(run.prUrl).toBeNull();
      expect(run.prTarget).toBe('main');
      expect(run.base).toBe(fixture.base);
      expect(run.runId).toBe(fixture.runId);
    });

    it('nulls a prTarget that is not a string', async () => {
      const run = await readBack({ prTarget: 7 });
      expect(run.prTarget).toBeNull();
    });

    it('nulls an empty prTarget, as base treats an empty base', async () => {
      const run = await readBack({ prTarget: '' });
      expect(run.prTarget).toBeNull();
    });

    it('lets mergeMode and mergeModeEffective pr survive the sanitiser instead of degrading to merge', async () => {
      const run = await readBack({ mergeMode: 'pr', mergeModeEffective: 'pr' });
      expect(run.mergeMode).toBe('pr');
      expect(run.mergeModeEffective).toBe('pr');
    });
  });

  it('marks a run whose heartbeat is 16 minutes old as not fresh', async () => {
    const run: OrchestratorRun = {
      ...fixture,
      updatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].fresh).toBe(false);
  });

  it('never caches — a status flip on disk shows up on the very next request', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    const file = writeRun(run);

    const first = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(first.body.runs[0].status).toBe('running');

    writeFileSync(file, JSON.stringify({ ...run, status: 'done' }, null, 2));

    const second = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(second.body.runs[0].status).toBe('done');
  });

  it('skips a corrupt run.json for one project and still returns a valid sibling', async () => {
    const good: OrchestratorRun = { ...fixture, project: '/abs/good', updatedAt: new Date().toISOString() };
    writeRun(good);

    const badDir = projectDir('/abs/bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'run.json'), '{ this is not json');

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].project).toBe('/abs/good');
  });

  it('counts entries under runs/ as pastRuns', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    const dir = projectDir(run.project);
    writeRun(run);
    const runsDir = join(dir, 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'run-20260101-000000.json'), '{}');
    writeFileSync(join(runsDir, 'run-20260102-000000.json'), '{}');

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].pastRuns).toBe(2);
  });

  // task-31: `runs/` stopped being a directory of run files alone the moment
  // each archived run gained a sibling `runs/<runId>/` holding its sidecars.
  // pastRuns is the count a person actually reads — RunDrawer prints
  // "<n> past run(s)" straight off it — so counting a run's evidence folder
  // as a second run doubles that number on every archived run.
  it("counts run FILES under runs/ as pastRuns, not a run's archived sidecar directory", async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    const dir = projectDir(run.project);
    writeRun(run);
    const runsDir = join(dir, 'runs');
    mkdirSync(join(runsDir, 'run-20260101-000000'), { recursive: true });
    writeFileSync(join(runsDir, 'run-20260101-000000.json'), '{}');
    writeFileSync(join(runsDir, 'run-20260101-000000', 'bug-1.jsonl'), '{}');

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].pastRuns).toBe(1);
  });

  // #322: `stale-plans.json` is project-level state orchestrate.mjs keeps beside `run.json` and never archives — the one file in a project directory that
  // outlives every run. The reader must neither list it nor trip over it: the same runs come back with it as without it, and a project directory holding the
  // marks but no current run file (its last run archived) reads as no run at all.
  it('returns the same runs with a stale-plans.json beside run.json, and none for a directory holding only the marks', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    writeRun(run);
    const without = (await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200)).body;

    const mark = { planHash: 'a'.repeat(64), detail: 'X', runId: run.runId, at: run.updatedAt };
    writeFileSync(join(projectDir(run.project), 'stale-plans.json'), JSON.stringify({ 'task-1': mark }));
    const marksOnly = projectDir('/tmp/archived-project');
    mkdirSync(join(marksOnly, 'runs'), { recursive: true });
    writeFileSync(join(marksOnly, 'stale-plans.json'), '{garbage');

    const withMarks = (await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200)).body;
    expect(withMarks).toEqual(without);
  });

  it('attaches a zeroed watchdog record to a crashed running run', async () => {
    // The fixture as-is: its own updatedAt (2026-08-31) is already well past
    // RUN_STALE_MS relative to "now", and its own status is already
    // 'running' — this is deliberately the one case in this file that does
    // NOT override updatedAt to `new Date().toISOString()`, because the
    // crashed shape (status === 'running' && !fresh) is exactly what every
    // other case here mutates AWAY from.
    writeRun(fixture);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].fresh).toBe(false);
    expect(res.body.runs[0].watchdog).toMatchObject({ attempts: 0, exhausted: false });
  });

  it('carries no watchdog key at all on a fresh running run', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    // Key ABSENCE, not merely an undefined value: a payload entry built as
    // `{ ...run, fresh, pastRuns, watchdog: undefined }` would satisfy
    // `toBeUndefined()` just as well, but only checking for the key itself
    // proves the conditional spread actually ran rather than always adding
    // the field.
    expect('watchdog' in res.body.runs[0]).toBe(false);
  });

  it('carries no watchdog key on a done run, even with a stale updatedAt', async () => {
    // fixture's own stale updatedAt, left untouched — only status changes,
    // to prove the gate is `status === 'running' && !fresh`, not `!fresh`
    // alone (a done run is just as un-fresh as a crashed one, by the exact
    // same arithmetic, and must still get no watchdog key).
    const run: OrchestratorRun = { ...fixture, status: 'done' };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect('watchdog' in res.body.runs[0]).toBe(false);
  });

  /* task-14 — the starting-run placeholder's own half of this payload. These
     cases exist at the endpoint level (rather than only against
     StartingRunsService, which test/orchestrator-starting.test.ts covers in
     isolation) because the two things most easily got wrong here are both
     about wiring, not about the rule: the `readdirSync` catch dropping the
     field entirely, and the prune ending up in the wrong layer. */

  it('carries a marked project through the missing-state-dir path — the first-ever-run shape', () => {
    // No state directory at all is exactly what a project's FIRST run looks
    // like while it is starting, so this is the shape the placeholder must
    // survive, not an edge case. Called on the service directly: the catch
    // being tested is inside runs(), and going through HTTP here would also
    // sweep, which is a different question (see the controller case below).
    app.get(StartingRunsService).mark('/abs/first-ever');

    expect(app.get(OrchestratorService).runs()).toEqual({
      runs: [],
      starting: [{ project: '/abs/first-ever', requestedAt: expect.any(String) }],
      // The service's own `remote` is always empty — the controller fills it
      // (task-48), so the agents lock that calls this directly never sees one.
      // `remoteStarting` likewise (multi-dashboard task 6).
      remote: [],
      remoteStarting: []
    });
  });

  it('filters starting against the real runs it just read, not against an empty list', async () => {
    // A run file whose startedAt is AFTER the mark: the run this spawn asked
    // for has landed, so the placeholder must be gone from the very payload
    // that first reports the run. Passing `[]` as the filter's runs would
    // leave both on screen for the full RUN_STALE_MS.
    app.get(StartingRunsService).mark(fixture.project);
    writeRun({ ...fixture, updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() });

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.starting).toEqual([]);
  });

  it('runs() filters but never prunes — the entry is still in the map after two calls', () => {
    // The pair that fails if `sweep` is ever merged back into `list`.
    // `runs()` is documented as a pure read (its class comment), and the
    // watchdog's own mutation was moved out to the controller for exactly
    // that reason; this is task-14's half of the same seam.
    const starting = app.get(StartingRunsService);
    starting.mark(fixture.project);
    writeRun({ ...fixture, updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() });

    const service = app.get(OrchestratorService);
    expect(service.runs().starting).toEqual([]);
    expect(service.runs().starting).toEqual([]);
    // Asked a question the landed run does not answer: with no runs at all,
    // a surviving entry proves neither call deleted anything.
    expect(starting.list([])).toHaveLength(1);
  });

  /* task-17 — `pauseRequested`, the payload's own derived answer to "has the
     board asked this run to stop". Derived here rather than read off the run
     file because the run file has one writer and it is not this process; the
     cases below are what pin that the derivation matches the tool's, since a
     disagreement means the board says "pausing" while the run works on. */

  it('reports pauseRequested false for a running run with no request on disk', async () => {
    writeRun({ ...fixture, updatedAt: new Date().toISOString() });

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].pauseRequested).toBe(false);
  });

  it('reports pauseRequested true for a request naming this run, made after it started', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    writeRun(run);
    writeControl(run.project, { runId: run.runId, requestedAt: new Date().toISOString() });

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].pauseRequested).toBe(true);
  });

  it('ignores a request pinned to another run', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    writeRun(run);
    writeControl(run.project, { runId: 'run-19990101-000000', requestedAt: new Date().toISOString() });

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].pauseRequested).toBe(false);
  });

  it('ignores a request the run has already resumed past', async () => {
    const now = Date.now();
    const run: OrchestratorRun = {
      ...fixture,
      updatedAt: new Date(now).toISOString(),
      unpausedAt: new Date(now).toISOString()
    };
    writeRun(run);
    writeControl(run.project, { runId: run.runId, requestedAt: new Date(now - 60_000).toISOString() });

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].pauseRequested).toBe(false);
  });

  it('passes a paused run through as neither fresh nor watchdog-annotated', async () => {
    // A paused run is un-fresh by construction (its heartbeat stopped when it
    // finished), and it must NOT be a watchdog subject: the sweeper only ever
    // walks `running` runs, and a paused run does not need rescuing — a
    // person stopped it. Key absence, like the two watchdog cases above.
    writeRun({ ...fixture, status: 'paused', updatedAt: new Date().toISOString() });

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].status).toBe('paused');
    expect(res.body.runs[0].fresh).toBe(false);
    expect(res.body.runs[0].pauseRequested).toBe(false);
    expect('watchdog' in res.body.runs[0]).toBe(false);
  });

  it('never caches the request either — a file written between two requests shows up on the second', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    writeRun(run);

    const first = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(first.body.runs[0].pauseRequested).toBe(false);

    writeControl(run.project, { runId: run.runId, requestedAt: new Date().toISOString() });

    const second = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(second.body.runs[0].pauseRequested).toBe(true);
  });

  it('the controller prunes — one GET empties the map', async () => {
    // Pins the LAYER, not just the behaviour: same setup as the case above,
    // driven through HTTP instead of the service.
    const starting = app.get(StartingRunsService);
    starting.mark(fixture.project);
    writeRun({ ...fixture, updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() });

    await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);

    expect(starting.list([])).toEqual([]);
  });

  it.each(['running', 'aborted'] as const)(
    'a remote run started after the mark keeps the placeholder, for the payload AND the direct callers, until a local run lands (bug-57, %s)',
    async (status) => {
      // The bug-57 repro. A board spawn can only land on THIS machine — the
      // dashboard spawns in a registry path on this host, and `init` writes a
      // local run file before anything is claimed — and `deriveRemoteRuns`
      // excludes every run id this machine holds a file for, so no remote run
      // is ever the landing a mark waits for. Another machine that started in
      // the window between this board's spawn and its `init` is coincidence,
      // and the slow start it coincided with must keep its placeholder. The
      // remote run is stubbed at the service, because deriving one from claim
      // comments is remote-runs.util's own suite and not this one's.
      const starting = app.get(StartingRunsService);
      starting.mark(fixture.project);
      const requestedAt = Date.parse(starting.list([])[0].requestedAt);
      const remote: RemoteRun = {
        ...fixture,
        status,
        startedAt: new Date(requestedAt + 1_000).toISOString(),
        fresh: status === 'running',
        remote: true,
        repo: 'owner/repo',
        // Multi-dashboard task 6: a remote run now says which machine it is on. A host a configured remote's launch is waiting for changes nothing
        // here — bug-57's rule is that NO remote run retires a local placeholder, whatever host it carries.
        host: 'pro-mac'
      };
      jest.spyOn(app.get(RemoteRunsService), 'list').mockReturnValue([remote]);

      const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
      expect(res.body.remote).toHaveLength(1);
      expect(res.body.starting).toEqual([{ project: fixture.project, requestedAt: new Date(requestedAt).toISOString() }]);
      // The GET's sweep did not delete it either: AgentsService's direct
      // `runs()` callers, which never see a remote run, still see the mark.
      expect(app.get(OrchestratorService).runs().starting).toHaveLength(1);

      // This machine's own `init` lands — a local run file started after the
      // mark — and that, alone, retires the placeholder on the next GET.
      writeRun({ ...fixture, status: 'done', updatedAt: new Date().toISOString(), startedAt: new Date(requestedAt + 2_000).toISOString() });
      const landed = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
      expect(landed.body.starting).toEqual([]);
      expect(starting.list([])).toEqual([]);
    }
  );

  /**
   * Multi-dashboard task 6 — a remote orchestrate's "starting on <machine>" rides in its own `remoteStarting` field, never in `starting`: `starting` is what
   * `runClaimBlock` and the local expiry read, and a remote launch must block neither this machine's Orchestrate nor its card launches (spec, "Starting on
   * <machine> between a remote launch and its first claim").
   */
  describe('remoteStarting (multi-dashboard task 6)', () => {
    const PRO = { id: 'Pro', host: 'pro-mac' };

    it('a remote orchestrate entry is listed in remoteStarting, never in starting, so runClaimBlock never sees it', async () => {
      app.get(RemoteStartingService).markProject(fixture.project, PRO);

      const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
      expect(res.body.remoteStarting).toEqual([
        { kind: 'orchestrate', project: fixture.project, machine: 'Pro', itemId: null, requestedAt: expect.any(String) }
      ]);
      expect(res.body.starting).toEqual([]);
      expect(app.get(OrchestratorService).runs().starting).toEqual([]);
      const item = { id: 'bug-1', projectPath: fixture.project } as BacklogItem;
      expect(runClaimBlock(item, res.body.runs, res.body.starting)).toBeNull();
    });

    it("a remote run with host pro-mac retires the remote entry waiting on pro-mac, and NEVER the local starting entry (bug-57's rule)", async () => {
      const starting = app.get(StartingRunsService);
      starting.mark(fixture.project);
      app.get(RemoteStartingService).markProject(fixture.project, PRO);
      const requestedAt = Date.parse(starting.list([])[0].requestedAt);
      const remote: RemoteRun = {
        ...fixture,
        status: 'running',
        startedAt: new Date(requestedAt + 1_000).toISOString(),
        fresh: true,
        remote: true,
        repo: 'owner/repo',
        host: 'pro-mac'
      };
      jest.spyOn(app.get(RemoteRunsService), 'list').mockReturnValue([remote]);

      const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
      expect(res.body.remoteStarting).toEqual([]);
      expect(res.body.starting).toEqual([{ project: fixture.project, requestedAt: new Date(requestedAt).toISOString() }]);
      expect(app.get(OrchestratorService).runs().starting).toHaveLength(1);
    });
  });
});
