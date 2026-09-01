import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';

import { OrchestratorController } from '../server/src/orchestrator/orchestrator.controller';
import { OrchestratorService } from '../server/src/orchestrator/orchestrator.service';
import type { OrchestratorRun, RunQueueItem, RunVerification } from '../shared/types';

// Same layout orchestrate.mjs's own projectDir()/runFilePath() write:
// <root>/<encodeURIComponent(absolute project path)>/run.json, plus a
// sibling runs/ directory for archived runs. Duplicated from
// orchestrator-runs.test.ts's identical helper rather than imported — that
// tool has no exported package boundary into this TS project, so the path
// shape is a cross-language contract every consuming suite re-states.
//
// Module-scope (not nested inside a describe): both describe blocks below —
// OrchestratorService.archive (Task 1) and OrchestratorController.archivedRun
// (Task 2) — exercise the same on-disk shape against the same kind of
// scratch BM_ORCH_HOME, so this is one fixture harness shared by both rather
// than a second one built for the detail endpoint.
function projectDir(orchHome: string, project: string): string {
  return join(orchHome, encodeURIComponent(project));
}

// One RunVerification with a non-trivial tail, so a test asserting the tail
// was stripped (archive) or preserved (detail) is checking a real fixture
// value rather than an already-empty string surviving by accident.
function verification(overrides: Partial<RunVerification> = {}): RunVerification {
  return { cmd: 'pnpm test', ok: true, tail: 'Tests: 46 passed, 46 total', ...overrides };
}

// Every RunQueueItem key, copied from shared/types.ts rather than recalled
// from memory — a field this helper silently dropped would let a fixture
// through that isPlausibleRun's downstream reads would never actually see on
// a real run file, hiding a bug the service under test might have on that
// field.
function queueItem(overrides: Partial<RunQueueItem> = {}): RunQueueItem {
  return {
    id: 'bug-1',
    title: 'Example item',
    stage: 'merged',
    sessionId: 'session-1',
    worktree: '/abs/project/.worktrees/bug-1',
    branch: 'backlog/bug-1',
    permissionMode: 'auto',
    fixLoops: 0,
    stageAt: { pending: '2026-08-31T08:40:03Z', merged: '2026-08-31T08:59:55Z' },
    verification: [verification()],
    questions: [],
    note: null,
    ...overrides
  };
}

// Every OrchestratorRun key. Callers override `project` and `runId` per
// case; the rest is filler that only has to be plausible, not meaningful.
function makeRun(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    runId: 'run-20260901-150701',
    project: '/abs/project-a',
    status: 'done',
    startedAt: '2026-08-31T08:40:03Z',
    updatedAt: '2026-08-31T09:36:40Z',
    maxItems: null,
    queue: [queueItem()],
    attention: [],
    ...overrides
  };
}

function writeCurrent(orchHome: string, run: OrchestratorRun): void {
  const dir = projectDir(orchHome, run.project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
}

// `content` is `unknown` rather than `OrchestratorRun` on purpose — several
// cases deliberately write garbage or an implausible shape into runs/, which
// a typed parameter would refuse to accept.
function writeArchived(orchHome: string, project: string, fileName: string, content: unknown): void {
  const runsDir = join(projectDir(orchHome, project), 'runs');
  mkdirSync(runsDir, { recursive: true });
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  writeFileSync(join(runsDir, fileName), body);
}

// Asserts `fn` throws exactly an HttpException with status 404 — the one
// shape every failure mode of the detail endpoint collapses to (missing
// param, bad runId shape, unregistered project, unknown run, mismatched
// run.json — GET /api/items/body's own "caller has no business learning
// which" stance). Calling `fn` twice (once inside `expect(...).toThrow`,
// once to catch and inspect) is safe: every case below is a read-only
// lookup against files this suite wrote, with no state to mutate between
// calls.
function expectNotFound(fn: () => unknown): void {
  expect(fn).toThrow(HttpException);
  try {
    fn();
  } catch (e) {
    expect((e as HttpException).getStatus()).toBe(404);
  }
}

// Direct service/controller instantiation, not supertest-over-HTTP:
// OrchestratorService takes no constructor dependencies (no RegistryModule,
// see its own class doc comment), so there is nothing an HTTP-level test
// would exercise here that calling the controller method directly doesn't
// already reach. This is the same choice registry.test.ts makes for
// RegistryService, and it is deliberately different from
// orchestrator-runs.test.ts, which goes over HTTP specifically because that
// suite is also proving the controller wiring and the AppModule's
// REGISTRY_FILE override — neither is this file's job.
describe('OrchestratorService.archive', () => {
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  let service: OrchestratorService;

  beforeEach(() => {
    // orchHome itself is deliberately never created here, same reasoning as
    // orchestrator-runs.test.ts's identical beforeEach: a machine that has
    // never run the orchestrator has no ~/.backlog-manager/orchestrator/ at
    // all, and the missing-state-dir case below depends on that directory
    // genuinely not existing.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-archive-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;
    service = new OrchestratorService();
  });

  afterEach(() => {
    process.env = { ...env };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('lists current and archived runs with correct flags', () => {
    const project = '/abs/project-a';
    writeCurrent(orchHome, makeRun({ project, runId: 'run-20260901-150701', status: 'done' }));
    writeArchived(orchHome, project, 'run-20260831-211011.json', makeRun({ project, runId: 'run-20260831-211011' }));

    const result = service.archive();
    expect(result.runs).toHaveLength(2);

    const current = result.runs.find((r) => r.runId === 'run-20260901-150701');
    const archived = result.runs.find((r) => r.runId === 'run-20260831-211011');
    expect(current?.current).toBe(true);
    expect(archived?.current).toBe(false);
  });

  it('strips verification tails but keeps cmd and ok', () => {
    const project = '/abs/project-b';
    writeCurrent(orchHome, makeRun({
      project,
      queue: [queueItem({ verification: [{ cmd: 'pnpm test', ok: true, tail: 'BIG' }] })]
    }));

    const result = service.archive();
    const entry = result.runs[0].queue[0].verification[0];
    expect(entry).toEqual({ cmd: 'pnpm test', ok: true });
    expect('tail' in entry).toBe(false);
  });

  it('sorts a project\'s runs newest first including suffix collisions', () => {
    const project = '/abs/project-c';
    writeCurrent(orchHome, makeRun({ project, runId: 'run-20260901-150701' }));
    writeArchived(orchHome, project, 'a.json', makeRun({ project, runId: 'run-20260901-112815' }));
    writeArchived(orchHome, project, 'b.json', makeRun({ project, runId: 'run-20260901-112815-2' }));
    writeArchived(orchHome, project, 'c.json', makeRun({ project, runId: 'run-20260901-073202' }));

    const result = service.archive();
    expect(result.runs.map((r) => r.runId)).toEqual([
      'run-20260901-150701',
      'run-20260901-112815-2',
      'run-20260901-112815',
      'run-20260901-073202'
    ]);
  });

  it('skips an unreadable archived file without failing the payload', () => {
    const project = '/abs/project-d';
    writeArchived(orchHome, project, 'garbage.json', 'not json');
    writeArchived(orchHome, project, 'good.json', makeRun({ project, runId: 'run-20260901-100000' }));

    const result = service.archive();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].runId).toBe('run-20260901-100000');
  });

  it('skips an implausible archived file', () => {
    const project = '/abs/project-e';
    writeArchived(orchHome, project, 'run-20260901-000000.json', { hello: 1 });

    const result = service.archive();
    expect(result.runs).toHaveLength(0);
  });

  it('returns empty runs for a missing state dir', () => {
    // No writes at all in this case — beforeEach never creates orchHome
    // itself (see its own comment), so this is already the "state directory
    // does not exist" condition without any extra setup.
    expect(service.archive()).toEqual({ runs: [] });
  });

  it('a project with runs/ but no run.json still lists its archive', () => {
    const project = '/abs/project-f';
    writeArchived(orchHome, project, 'run-20260901-090000.json', makeRun({ project, runId: 'run-20260901-090000' }));

    const result = service.archive();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].current).toBe(false);
  });
});

// Task 2: the detail endpoint one run file, verbatim (tails included), for
// the archive view's detail pane. Unlike archive() above, this reaches
// through the controller (not just the service): the two guards this
// endpoint exists for — runId shape, then project-must-be-a-listing-entry —
// are what stand between a browser-supplied query string and the
// filesystem, and the brief's own security note is that the controller is
// where a caller-supplied `project`/`runId` actually originates (as query
// params), so proving the controller method rejects bad input is the point,
// not an HTTP-transport detail this suite can skip the way
// OrchestratorService.archive above skips it.
describe('OrchestratorController.archivedRun', () => {
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  let controller: OrchestratorController;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-archive-detail-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;
    controller = new OrchestratorController(new OrchestratorService());
  });

  afterEach(() => {
    process.env = { ...env };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('serves an archived run verbatim, tail included', () => {
    const project = '/abs/project-a';
    const run = makeRun({
      project,
      runId: 'run-20260831-211011',
      queue: [queueItem({ verification: [verification({ tail: 'the tail' })] })]
    });
    writeArchived(orchHome, project, 'run-20260831-211011.json', run);

    const result = controller.archivedRun(project, 'run-20260831-211011');
    // Deep equality against the exact fixture written to disk — this fails
    // if the endpoint stripped the tail (it must not; that summarising is
    // archive()'s job, not this one's) or added a `current` key (the detail
    // endpoint returns the raw OrchestratorRun shape, never
    // OrchestratorArchiveRun — see the design doc's "no fresh, no pastRuns"
    // line, extended here to "no current" for the same reason).
    expect(result).toEqual(run);
    expect(result?.queue[0].verification[0].tail).toBe('the tail');
  });

  it('serves the current run when runId matches run.json, without warning about the archived-file miss', () => {
    const project = '/abs/project-b';
    const run = makeRun({ project, runId: 'run-20260901-150701' });
    writeCurrent(orchHome, run);

    // No runs/<runId>.json exists for this project at all — this is the
    // fix-round-1 regression case: archivedRun() always probes that path
    // first, and for a request naming the current run (this test's whole
    // scenario) that probe misses every time. Before the fix, readOneRun's
    // plain ENOENT handling logged that expected miss as if it were a
    // problem; pinning `console.warn` was never called proves the "no
    // archived file with this name" path stays quiet on this normal,
    // successful, 200-returning request.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = controller.archivedRun(project, 'run-20260901-150701');
      expect(result).toEqual(run);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still warns when an archived file exists under the requested name but is corrupt', () => {
    const project = '/abs/project-h';
    const runId = 'run-20260901-150701';
    // A file DOES exist at runs/<runId>.json — unlike the miss case above,
    // this is a real problem (broken JSON under a name the filename-trusting
    // archived branch expected to be able to parse straight through), not
    // the "genuinely not there" ENOENT the fix's `expectMiss` flag exists to
    // quiet. It must still warn, and — with no run.json to fall back to
    // either — still 404, exactly as before the fix.
    writeArchived(orchHome, project, `${runId}.json`, 'not json');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expectNotFound(() => controller.archivedRun(project, runId));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`runs/${runId}.json`));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('404 for a well-formed runId that exists nowhere', () => {
    const project = '/abs/project-c';
    // The project directory has to actually be a readdirSync(orchHome())
    // entry for guard 2 to pass at all — an unrelated archived run (a
    // different runId) puts it on that listing without giving the
    // requested runId anything to match, which is the "guards pass, still
    // nothing to serve" case guard 2 alone can't catch.
    writeArchived(orchHome, project, 'run-20260101-000000.json', makeRun({ project, runId: 'run-20260101-000000' }));

    expectNotFound(() => controller.archivedRun(project, 'run-20260901-150701'));
  });

  it('404 for traversal-shaped runIds', () => {
    const project = '/abs/project-d';
    writeCurrent(orchHome, makeRun({ project, runId: 'run-20260901-150701' }));

    // The first two are path-traversal-shaped; if RUN_ID_RE failed to reject
    // them before any join/read, the implementation would attempt a
    // filesystem read at a path built from '..' segments and could throw a
    // raw fs error (ENOENT, naming a path outside the scratch dir) instead
    // of the clean HttpException expectNotFound checks for below — so this
    // case is also the traversal-escape check, not just a 404 check.
    const badRunIds = ['../../run', 'run-20260901-150701/../x', 'run-1; rm -rf', ''];
    for (const runId of badRunIds) {
      expectNotFound(() => controller.archivedRun(project, runId));
    }
  });

  it('404 for an unregistered project', () => {
    const project = '/abs/project-f/sub';
    writeCurrent(orchHome, makeRun({ project, runId: 'run-20260901-150701' }));

    // A real absolute path that was simply never registered.
    expectNotFound(() => controller.archivedRun('/abs/unregistered-project', 'run-20260901-150701'));

    // A PREFIX of the registered path (the registered path minus its last
    // segment). Guard 2 is exact string equality against a listing entry —
    // this proves it isn't a startsWith/prefix check a shared-prefix path
    // could slip through, the same distinction allow.util.ts's `dir + sep`
    // comment makes for the opposite direction (there the candidate is
    // longer than the allowed dir; here the candidate is shorter than the
    // registered one).
    expectNotFound(() => controller.archivedRun('/abs/project-f', 'run-20260901-150701'));
  });

  it('404 when run.json exists but its runId differs from the request', () => {
    const project = '/abs/project-g';
    writeCurrent(orchHome, makeRun({ project, runId: 'run-20260901-150701' }));

    expectNotFound(() => controller.archivedRun(project, 'run-20260831-000000'));
  });
});
