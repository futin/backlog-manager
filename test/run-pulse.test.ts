import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runsWorking } from '../client/src/lib/run-pulse';
import { remoteAsLive } from '../client/src/lib/remote-run';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, OrchestratorRunsPayload, StartingRun } from '../shared/types';

/**
 * `runsWorking` — the one answer the rail's wordmark cursor blinks on (.claude/DESIGN.md §8.0, dashboard-redesign-ports task 4).
 *
 * The case this suite exists for is the crashed one. A run whose file still says `running` but whose heartbeat has gone stale is crashed, not working
 * (`isCrashed`, lib/run-watchdog.ts), and a cursor that kept blinking for it would tell a person glancing at the rail that work is happening on a run the
 * board everywhere else calls crashed — exactly the silence-or-lie choice "A crashed run renders as crashed, never as nothing" was written to refuse.
 */
const fixture = rawFixture as OrchestratorRun;
type LiveRun = OrchestratorRunsPayload['runs'][number];

function run(over: Partial<LiveRun>): LiveRun {
  return { ...fixture, fresh: true, pastRuns: 0, pauseRequested: false, stopRequested: false, ...over };
}

const starting = (project: string): StartingRun => ({ project, requestedAt: new Date().toISOString() });

describe('runsWorking', () => {
  it('is false for an empty payload', () => {
    expect(runsWorking([], [])).toBe(false);
  });

  it('is true for one running run with a fresh heartbeat', () => {
    expect(runsWorking([run({ status: 'running', fresh: true })], [])).toBe(true);
  });

  it('is false for a running run whose heartbeat is stale — crashed is not working', () => {
    expect(runsWorking([run({ status: 'running', fresh: false })], [])).toBe(false);
  });

  it('is false for a paused run, fresh or not', () => {
    expect(runsWorking([run({ status: 'paused', fresh: true })], [])).toBe(false);
    expect(runsWorking([run({ status: 'paused', fresh: false })], [])).toBe(false);
  });

  it('is false for a run that finished', () => {
    expect(runsWorking([run({ status: 'done', fresh: true })], [])).toBe(false);
  });

  it('is true for one starting entry and no run file yet — a spawn this server made is on its way', () => {
    expect(runsWorking([], [starting('/abs/alpha')])).toBe(true);
  });

  /* Another machine's run is that machine's work. `remote` never rides in `runs` on the wire, but the Runs page folds remote runs into its rows through
     `remoteAsLive`, which keeps the `remote: true` literal at run time — so the derivation asks `isRemoteRun` rather than trusting which array a caller
     happened to hand it. */
  it('is false when the only running run is a remote one', () => {
    const remote = remoteAsLive({ ...fixture, status: 'running', fresh: true, remote: true, repo: 'octo/alpha' });
    expect(runsWorking([remote], [])).toBe(false);
  });

  it('is true when one of several runs is working, whatever the others are doing', () => {
    expect(runsWorking([run({ status: 'running', fresh: false }), run({ status: 'paused' }), run({ runId: 'run-2', status: 'running' })], [])).toBe(true);
  });
});

/**
 * The wiring, read from source because behaviour cannot see what is missing. Every `useOrchestratorRuns()` call is its own 5 s poller, so the shell must
 * not grow a fourth one just to learn what the three views already know: each view reports its own reading up, and `App` only holds it.
 */
describe('the cursor reads the views’ pollers rather than adding one', () => {
  const SRC = join(__dirname, '..', 'client', 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const sources = walk(SRC)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ file: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));

  it('calls useOrchestratorRuns() in exactly the three views, and App is not one of them', () => {
    const callers = sources.filter((s) => /=\s*useOrchestratorRuns\(\)/.test(s.text)).map((s) => s.file);
    expect(callers.sort()).toEqual(['components/archive/ArchiveView.tsx', 'components/board/BoardView.tsx', 'components/runs/RunsView.tsx']);
  });

  it('has each of those views report its own runs and starting entries up', () => {
    for (const file of ['components/archive/ArchiveView.tsx', 'components/board/BoardView.tsx', 'components/runs/RunsView.tsx']) {
      const text = sources.find((s) => s.file === file)?.text ?? '';
      expect({ file, reports: /useReportWorking\(/.test(text) }).toEqual({ file, reports: true });
    }
  });
});
