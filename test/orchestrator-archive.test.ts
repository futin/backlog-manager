import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OrchestratorService } from '../server/src/orchestrator/orchestrator.service';
import type { OrchestratorRun, RunQueueItem, RunVerification } from '../shared/types';

// Direct service instantiation, not supertest-over-HTTP: OrchestratorService
// takes no constructor dependencies (no RegistryModule, see its own class
// doc comment), so there is nothing an HTTP-level test would exercise here
// that `new OrchestratorService().archive()` doesn't already reach. This is
// the same choice registry.test.ts makes for RegistryService, and it is
// deliberately different from orchestrator-runs.test.ts, which goes over
// HTTP specifically because that suite is also proving the controller wiring
// and the AppModule's REGISTRY_FILE override — neither is this file's job.
describe('OrchestratorService.archive', () => {
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  let service: OrchestratorService;

  // Same layout orchestrate.mjs's own projectDir()/runFilePath() write:
  // <root>/<encodeURIComponent(absolute project path)>/run.json, plus a
  // sibling runs/ directory for archived runs. Duplicated from
  // orchestrator-runs.test.ts's identical helper rather than imported —
  // that tool has no exported package boundary into this TS project, so the
  // path shape is a cross-language contract every consuming suite re-states.
  function projectDir(project: string): string {
    return join(orchHome, encodeURIComponent(project));
  }

  // One RunVerification with a non-trivial tail, so a test asserting the
  // tail was stripped is checking a real removal rather than an already-
  // empty string surviving by accident.
  function verification(overrides: Partial<RunVerification> = {}): RunVerification {
    return { cmd: 'pnpm test', ok: true, tail: 'Tests: 46 passed, 46 total', ...overrides };
  }

  // Every RunQueueItem key, copied from shared/types.ts rather than recalled
  // from memory — a field this helper silently dropped would let a fixture
  // through that isPlausibleRun's downstream reads would never actually see
  // on a real run file, hiding a bug archive() might have on that field.
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

  function writeCurrent(run: OrchestratorRun): void {
    const dir = projectDir(run.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  // `content` is `unknown` rather than `OrchestratorRun` on purpose — several
  // cases below deliberately write garbage or an implausible shape into
  // runs/, which a typed parameter would refuse to accept.
  function writeArchived(project: string, fileName: string, content: unknown): void {
    const runsDir = join(projectDir(project), 'runs');
    mkdirSync(runsDir, { recursive: true });
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    writeFileSync(join(runsDir, fileName), body);
  }

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
    writeCurrent(makeRun({ project, runId: 'run-20260901-150701', status: 'done' }));
    writeArchived(project, 'run-20260831-211011.json', makeRun({ project, runId: 'run-20260831-211011' }));

    const result = service.archive();
    expect(result.runs).toHaveLength(2);

    const current = result.runs.find((r) => r.runId === 'run-20260901-150701');
    const archived = result.runs.find((r) => r.runId === 'run-20260831-211011');
    expect(current?.current).toBe(true);
    expect(archived?.current).toBe(false);
  });

  it('strips verification tails but keeps cmd and ok', () => {
    const project = '/abs/project-b';
    writeCurrent(makeRun({
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
    writeCurrent(makeRun({ project, runId: 'run-20260901-150701' }));
    writeArchived(project, 'a.json', makeRun({ project, runId: 'run-20260901-112815' }));
    writeArchived(project, 'b.json', makeRun({ project, runId: 'run-20260901-112815-2' }));
    writeArchived(project, 'c.json', makeRun({ project, runId: 'run-20260901-073202' }));

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
    writeArchived(project, 'garbage.json', 'not json');
    writeArchived(project, 'good.json', makeRun({ project, runId: 'run-20260901-100000' }));

    const result = service.archive();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].runId).toBe('run-20260901-100000');
  });

  it('skips an implausible archived file', () => {
    const project = '/abs/project-e';
    writeArchived(project, 'run-20260901-000000.json', { hello: 1 });

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
    writeArchived(project, 'run-20260901-090000.json', makeRun({ project, runId: 'run-20260901-090000' }));

    const result = service.archive();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].current).toBe(false);
  });
});
