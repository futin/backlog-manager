/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { fetchArchivedRun } from '../client/src/lib/agents';
import { RunDetail } from '../client/src/components/runs/RunDetail';
import { formatSpanCompact } from '../client/src/lib/run-time';
import type {
  ArchiveQueueItem, OrchestratorArchiveRun, OrchestratorRun, RunQueueItem, RunStage, VerificationSummary
} from '../shared/types';

// RunDetail's one outbound call is fetchArchivedRun (Task 4/2) — mocking at
// the lib/agents module boundary, the same seam runs-view.test.tsx already
// mocks at, keeps this suite exercising RunDetail's own effect/state wiring
// for real and only fakes the network edge.
jest.mock('../client/src/lib/agents', () => ({
  __esModule: true,
  fetchArchivedRun: jest.fn()
}));

const mockFetchArchivedRun = fetchArchivedRun as jest.Mock;

/**
 * One archive-summarised queue item (verification already stripped of its
 * `tail`) — the exact shape `GET /api/orchestrator/archive` answers with, and
 * therefore the shape `summary.queue` always carries regardless of whether
 * this run is live-backed or not. Defaults are inert (no fix loops, no
 * verification, no stage timestamps) so a fixture only states the fields its
 * own case cares about, matching runs-view.test.tsx's own `item()` helper.
 */
function archiveItem(
  id: string,
  stage: RunStage,
  over: {
    fixLoops?: number;
    stageAt?: Partial<Record<RunStage, string>>;
    verification?: VerificationSummary[];
    questions?: string[];
  } = {}
): ArchiveQueueItem {
  return {
    id,
    title: `${id} title`,
    stage,
    sessionId: null,
    worktree: null,
    branch: null,
    permissionMode: null,
    fixLoops: over.fixLoops ?? 0,
    stageAt: over.stageAt ?? {},
    verification: over.verification ?? [],
    questions: over.questions ?? [],
    note: null
  };
}

/** The same item, full-shaped (verification entries carry `tail`) — what a
 *  live poll payload or `fetchArchivedRun`'s response actually returns. */
function liveItem(
  id: string,
  stage: RunStage,
  over: {
    fixLoops?: number;
    stageAt?: Partial<Record<RunStage, string>>;
    verification?: RunQueueItem['verification'];
    questions?: string[];
  } = {}
): RunQueueItem {
  return {
    id,
    title: `${id} title`,
    stage,
    sessionId: null,
    worktree: null,
    branch: null,
    permissionMode: null,
    fixLoops: over.fixLoops ?? 0,
    stageAt: over.stageAt ?? {},
    verification: over.verification ?? [],
    questions: over.questions ?? [],
    note: null
  };
}

const RUN_ID = 'run-20260901-090000';
const PROJECT = '/abs/proj';

/**
 * The primary fixture reused by every case that does not need its own
 * bespoke shape (cases 1, 2, 3, 5, 6): three items so merged/skipped/
 * attention/fix-loop counts are each individually distinguishable —
 * a-1 merged (1 fix loop, passing verification), a-2 failed (failing
 * verification, no fix loops), a-3 skipped (nothing recorded at all) — plus
 * one attention entry against a-2. Numbers: merged=1, skipped=1,
 * attention=1, fixLoopsTotal=1 (only a-1's).
 */
function primarySummary(): OrchestratorArchiveRun {
  return {
    runId: RUN_ID,
    project: PROJECT,
    status: 'done',
    startedAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:30:00.000Z',
    maxItems: null,
    current: false,
    attention: [{ id: 'a-2', kind: 'fix-exhausted', detail: 'gave up after 3 fix loops' }],
    queue: [
      archiveItem('a-1', 'merged', {
        fixLoops: 1,
        stageAt: { pending: '2026-09-01T09:00:00.000Z', merged: '2026-09-01T09:10:00.000Z' },
        verification: [{ cmd: 'pnpm test', ok: true }]
      }),
      archiveItem('a-2', 'failed', {
        verification: [{ cmd: 'pnpm test', ok: false }]
      }),
      archiveItem('a-3', 'skipped')
    ]
  };
}

/** The full-shaped run `fetchArchivedRun`/`live` would answer with for the
 *  primary fixture above — same ids/stages, verification entries now
 *  carrying their `tail`. */
function primaryFull(overTails: { a1?: string; a2?: string } = {}): OrchestratorRun {
  return {
    runId: RUN_ID,
    project: PROJECT,
    status: 'done',
    startedAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:30:00.000Z',
    maxItems: null,
    attention: [{ id: 'a-2', kind: 'fix-exhausted', detail: 'gave up after 3 fix loops' }],
    queue: [
      liveItem('a-1', 'merged', {
        fixLoops: 1,
        stageAt: { pending: '2026-09-01T09:00:00.000Z', merged: '2026-09-01T09:10:00.000Z' },
        verification: [{ cmd: 'pnpm test', ok: true, tail: overTails.a1 ?? 'PASS a-1' }]
      }),
      liveItem('a-2', 'failed', {
        verification: [{ cmd: 'pnpm test', ok: false, tail: overTails.a2 ?? 'boom output' }]
      }),
      liveItem('a-3', 'skipped')
    ]
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RunDetail', () => {
  it('renders header, chips and item rows from the summary alone', async () => {
    // Never resolves — proves nothing below depends on the fetch landing.
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    render(<RunDetail summary={primarySummary()} live={null} />);

    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByTestId('run-detail-chip-merged')).toHaveTextContent('1');
    expect(screen.getByTestId('run-detail-chip-skipped')).toHaveTextContent('1');
    expect(screen.getByTestId('run-detail-chip-attention')).toHaveTextContent('1');
    expect(screen.getByTestId('run-detail-chip-fixloops')).toHaveTextContent('1');

    const row = screen.getByTestId('run-detail-item-a-1');
    expect(row).toHaveTextContent('merged');
    // itemWallMs(a-1) = 10 minutes exactly => formatSpanCompact => "10m".
    expect(row).toHaveTextContent(formatSpanCompact(10 * 60 * 1000));
  });

  it('fetches tails for an archived run and fills the details body', async () => {
    mockFetchArchivedRun.mockResolvedValue(primaryFull({ a2: 'FETCHED_TAIL' }));

    render(<RunDetail summary={primarySummary()} live={null} />);

    expect(await screen.findByText('FETCHED_TAIL')).toBeInTheDocument();
    expect(mockFetchArchivedRun).toHaveBeenCalledWith(PROJECT, RUN_ID);
  });

  it('failed verification seeds its details open; passing stays closed', () => {
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    render(<RunDetail summary={primarySummary()} live={null} />);

    expect(screen.getByTestId('run-detail-verify-a-1')).not.toHaveAttribute('open');
    expect(screen.getByTestId('run-detail-verify-a-2')).toHaveAttribute('open');
  });

  it('live run renders tails without fetching', async () => {
    const full = primaryFull({ a2: 'LIVE_TAIL' });

    render(<RunDetail summary={primarySummary()} live={full} />);

    expect(await screen.findByText('LIVE_TAIL')).toBeInTheDocument();
    expect(mockFetchArchivedRun).not.toHaveBeenCalled();
  });

  it('stale fetch resolution is ignored', async () => {
    const resolvers: Record<string, (run: OrchestratorRun) => void> = {};
    mockFetchArchivedRun.mockImplementation((_project: string, runId: string) => (
      new Promise<OrchestratorRun>((resolve) => { resolvers[runId] = resolve; })
    ));

    const otherSummary: OrchestratorArchiveRun = {
      ...primarySummary(),
      runId: 'run-20260901-100000',
      queue: [archiveItem('b-1', 'failed', { verification: [{ cmd: 'pnpm test', ok: false }] })]
    };

    const { rerender } = render(<RunDetail summary={primarySummary()} live={null} />);
    // Move the selection on before the first run's fetch has resolved —
    // exactly the "selection can change mid-flight" case the brief calls
    // out. The second run's own fetch is left unresolved too; only the
    // FIRST call's belated resolution is exercised below.
    rerender(<RunDetail summary={otherSummary} live={null} />);

    resolvers[RUN_ID](primaryFull({ a2: 'STALE_TAIL' }));

    // Give the resolved promise's .then a turn to run before asserting its
    // absence — otherwise this assertion could pass merely because nothing
    // has been given a chance to (incorrectly) apply the stale result yet.
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('STALE_TAIL')).not.toBeInTheDocument();
  });

  it('fetch failure shows the inline error and keeps rows', async () => {
    mockFetchArchivedRun.mockRejectedValue(new Error('network down'));

    render(<RunDetail summary={primarySummary()} live={null} />);

    expect(await screen.findByTestId('run-detail-error')).toHaveTextContent("couldn't load verification output");
    expect(screen.getByTestId('run-detail-item-a-1')).toBeInTheDocument();
  });

  it('stage bar renders one segment per span with the tone class', () => {
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    // Three stamps => two spans: `pending` (idle tone) running 10s, then
    // `dispatched` (active tone) running 65s. formatSpanCompact(65_000) is
    // "1m" (the sub-minute rung is dropped entirely, not "1m 00s") — checked
    // against the real function rather than hand-guessed, per the brief's
    // own warning.
    const summary: OrchestratorArchiveRun = {
      ...primarySummary(),
      queue: [
        archiveItem('c-1', 'merged', {
          stageAt: {
            pending: '2026-09-01T09:00:00.000Z',
            dispatched: '2026-09-01T09:00:10.000Z',
            merged: '2026-09-01T09:01:15.000Z'
          }
        })
      ],
      attention: []
    };

    render(<RunDetail summary={summary} live={null} />);

    const bar = screen.getByTestId('run-detail-stagebar-c-1');
    expect(bar.children).toHaveLength(2);
    expect(bar.children[0]).toHaveClass('run-seg-idle');
    expect(bar.children[1]).toHaveClass('run-seg-active');

    expect(screen.getByTestId('run-detail-caption-c-1')).toHaveTextContent(
      `pending ${formatSpanCompact(10_000)} · dispatched ${formatSpanCompact(65_000)}`
    );
  });

  it('renders no stage bar or caption for an item with no recorded spans', () => {
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    render(<RunDetail summary={primarySummary()} live={null} />);

    // a-3 (skipped) carries an empty stageAt — no spans, so no bar at all.
    expect(screen.queryByTestId('run-detail-stagebar-a-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-detail-caption-a-3')).not.toBeInTheDocument();
  });
});
