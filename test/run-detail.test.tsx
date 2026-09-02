/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { fetchArchivedRun } from '../client/src/lib/agents';
import { RunDetail } from '../client/src/components/runs/RunDetail';
import { formatClock, formatSpanCompact } from '../client/src/lib/run-time';
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
 * a-1 merged (1 fix loop, passing verification, `dispatched` stamped two
 * minutes after `pending` and `merged` eight minutes after THAT — so its
 * head time reads a real "8m 00s" instead of the whole pending-to-merged
 * span, and its fix-loop badge has a real dot to sit on), a-2 failed
 * (failing verification, no fix loops), a-3 skipped (nothing recorded at
 * all) — plus one attention entry against a-2. Numbers: merged=1, skipped=1,
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
        stageAt: {
          pending: '2026-09-01T09:00:00.000Z',
          dispatched: '2026-09-01T09:02:00.000Z',
          merged: '2026-09-01T09:10:00.000Z'
        },
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
 *  primary fixture above — same ids/stages/stamps, verification entries now
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
        stageAt: {
          pending: '2026-09-01T09:00:00.000Z',
          dispatched: '2026-09-01T09:02:00.000Z',
          merged: '2026-09-01T09:10:00.000Z'
        },
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

// Belt-and-braces for the one case below that fakes timers: a throw mid-test
// would otherwise skip its own cleanup and leak fake timers into every test
// that runs after it in this file. Harmless to call when timers are already
// real (Jest no-ops it), so this runs after every test, not just that one.
afterEach(() => {
  jest.useRealTimers();
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
    // itemDurationMs(a-1) = dispatched(09:02) -> merged(09:10) = 8 minutes
    // exactly, excluding the 2 minutes a-1 spent in `pending` beforehand —
    // this is the "known weak assertion" fix: the old "10m" reading here
    // passed only because the deleted stage-bar caption happened to emit
    // the same digits for the old fixture, never actually pinning this
    // number. `RowTime`'s own contract (RunRowTime.tsx) is duration ·
    // finish-clock for a terminal row, so `formatClock` builds the second
    // half instead of a hand-typed HH:MM that could drift from the
    // test environment's timezone.
    expect(screen.getByTestId('run-detail-item-time-a-1')).toHaveTextContent(
      `8m 00s · ${formatClock('2026-09-01T09:10:00.000Z')}`
    );
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

  // I1: a whole-branch review found that when a live run finishes, `live`
  // goes `null` on RunDetail's very next render (the server's own `fresh`
  // flag flips) — and the OLD implementation (`runForHeader = live ??
  // summary`) fell straight back to `summary`, the archive snapshot fetched
  // BEFORE the finish. That reproduced a header stuck on "running" with
  // elapsed time still climbing, and item rows frozen at their last-known
  // LIVE stage, even though the very fetch this pane issues for exactly
  // this transition (`live !== null` flipping is one of the effect's own
  // dependencies) would have told it the truth once it landed. This test
  // pins the fix: once `fetchedRun` lands, it must become the authority for
  // the WHOLE row (not just a verification tail), replacing `summary`
  // outright.
  it('adopts the freshly fetched run once a live selection goes stale, instead of freezing on the archived summary', async () => {
    const staleSummary: OrchestratorArchiveRun = {
      runId: RUN_ID,
      project: PROJECT,
      status: 'running', // stale: this archive snapshot predates the finish
      startedAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:15:00.000Z',
      maxItems: null,
      current: true,
      attention: [],
      queue: [
        archiveItem('a-1', 'merged', {
          stageAt: { pending: '2026-09-01T09:00:00.000Z', merged: '2026-09-01T09:10:00.000Z' }
        }),
        archiveItem('a-2', 'reviewing') // stale: a-2 hadn't merged yet as of this snapshot
      ]
    };
    const runningLive: OrchestratorRun = {
      runId: RUN_ID,
      project: PROJECT,
      status: 'running',
      startedAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:12:00.000Z',
      maxItems: null,
      attention: [],
      queue: [
        liveItem('a-1', 'merged', {
          stageAt: { pending: '2026-09-01T09:00:00.000Z', merged: '2026-09-01T09:10:00.000Z' }
        }),
        liveItem('a-2', 'reviewing')
      ]
    };
    // What `fetchArchivedRun` returns once the run has actually finished —
    // the truth this pane's own effect goes and fetches the moment `live`
    // disappears.
    const freshFetched: OrchestratorRun = {
      runId: RUN_ID,
      project: PROJECT,
      status: 'done',
      startedAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:20:00.000Z',
      maxItems: null,
      attention: [],
      queue: [
        liveItem('a-1', 'merged', {
          stageAt: { pending: '2026-09-01T09:00:00.000Z', merged: '2026-09-01T09:10:00.000Z' }
        }),
        liveItem('a-2', 'merged', {
          stageAt: { pending: '2026-09-01T09:00:00.000Z', merged: '2026-09-01T09:20:00.000Z' }
        })
      ]
    };
    mockFetchArchivedRun.mockResolvedValue(freshFetched);

    const { rerender } = render(<RunDetail summary={staleSummary} live={runningLive} />);
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByTestId('run-detail-item-a-2')).toHaveTextContent('reviewing');
    // No fetch yet — `live` is present, so there is nothing to correct.
    expect(mockFetchArchivedRun).not.toHaveBeenCalled();

    // The run finishes: RunsView's own next render (once the live poll's
    // `fresh` flag flips) passes live={null} for this same selection.
    rerender(<RunDetail summary={staleSummary} live={null} />);

    // The pane must show what the fresh fetch found, not what the stale
    // `staleSummary` still says.
    await screen.findByText('done');
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-detail-item-a-2')).toHaveTextContent('merged');
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

  // The real-run measurement this whole redesign traces back to
  // (RunRowTime.tsx's own file header): bug-7 read 161 minutes under the
  // old first-stamp-to-last-stamp reading and 25 minutes under
  // `itemDurationMs`, entirely because of the four items queued ahead of it.
  // This fixture is that same shape in miniature — a `preflight` gate stamp
  // between `pending` and `dispatched` so the lead line has both halves to
  // report — with round numbers chosen so every reading lands on a clean
  // digit rather than something this test would have to compute to check.
  it('item time excludes queue wait', () => {
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    const summary: OrchestratorArchiveRun = {
      ...primarySummary(),
      queue: [
        archiveItem('q-1', 'merged', {
          stageAt: {
            pending: '2026-09-01T09:00:00.000Z',
            preflight: '2026-09-01T11:16:00.000Z',
            dispatched: '2026-09-01T11:17:00.000Z',
            merged: '2026-09-01T11:41:00.000Z'
          }
        })
      ],
      attention: []
    };

    render(<RunDetail summary={summary} live={null} />);

    const time = screen.getByTestId('run-detail-item-time-q-1');
    // 11:41 minus 11:17 (the earliest NON-pending stamp) = 25 minutes flat.
    expect(time).toHaveTextContent(`25m 00s · ${formatClock('2026-09-01T11:41:00.000Z')}`);
    // The wrong, queue-wait-inclusive reading (11:41 minus the 09:00
    // `pending` stamp) would print 2h 41m — asserted absent by name, not
    // just "some other number", so a regression back to that arithmetic
    // fails loudly rather than merely failing the line above.
    expect(time).not.toHaveTextContent('2h 41m');

    // queue: 11:16 (preflight, the earliest non-pending arrival) minus
    // 09:00 = 2h 16m. preflight: 11:17 (dispatched) minus 11:16 = 1m 00s.
    expect(screen.getByTestId('run-detail-lead-q-1')).toHaveTextContent('queue 2h 16m · preflight 1m 00s');
  });

  it('lead line is omitted when nothing is known', () => {
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    const summary: OrchestratorArchiveRun = {
      ...primarySummary(),
      queue: [
        // No stamps at all — never entered the pipeline.
        archiveItem('n-1', 'ungroomed'),
        // A `pending` stamp with nothing after it: still queued, so there
        // is no "started" instant yet for a wait to be measured up to.
        archiveItem('n-2', 'pending', { stageAt: { pending: '2026-09-01T09:00:00.000Z' } }),
        // Queue wait is known (pending -> dispatched); preflight never ran.
        archiveItem('n-3', 'dispatched', {
          stageAt: {
            pending: '2026-09-01T09:00:00.000Z',
            dispatched: '2026-09-01T09:05:00.000Z'
          }
        })
      ],
      attention: []
    };

    render(<RunDetail summary={summary} live={null} />);

    expect(screen.queryByTestId('run-detail-lead-n-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-detail-lead-n-2')).not.toBeInTheDocument();

    const lead = screen.getByTestId('run-detail-lead-n-3');
    expect(lead).toHaveTextContent(`queue ${formatSpanCompact(5 * 60 * 1000)}`);
    expect(lead).not.toHaveTextContent('preflight');
  });

  it('rollup sums machine time across items and excludes queue wait', () => {
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    const summary: OrchestratorArchiveRun = {
      ...primarySummary(),
      queue: [
        // 20 minutes of `pending` (queue wait — must not reach the rollup),
        // then a 5-minute `dispatched` span.
        archiveItem('r-1', 'merged', {
          stageAt: {
            pending: '2026-09-01T09:00:00.000Z',
            dispatched: '2026-09-01T09:20:00.000Z',
            merged: '2026-09-01T09:25:00.000Z'
          }
        }),
        // A different queue wait (3 minutes), then a 10-minute `dispatched`
        // span — deliberately uneven so the two items' own waits could not
        // coincidentally sum to the `dispatched` total below.
        archiveItem('r-2', 'merged', {
          stageAt: {
            pending: '2026-09-01T10:00:00.000Z',
            dispatched: '2026-09-01T10:03:00.000Z',
            merged: '2026-09-01T10:13:00.000Z'
          }
        })
      ],
      attention: []
    };

    render(<RunDetail summary={summary} live={null} />);

    expect(screen.getByTestId('run-detail-machine-dispatched')).toHaveTextContent(
      formatSpanCompact(15 * 60 * 1000)
    );
    // Neither item ever recorded a `preflight` arrival, so the row must
    // read the honest "nothing recorded" dash, not a zero.
    expect(screen.getByTestId('run-detail-machine-preflight')).toHaveTextContent('—');
    // One rollup per run, not one per item — StageBars is called exactly
    // once here regardless of queue length.
    expect(screen.getAllByTestId('run-detail-machine')).toHaveLength(1);
  });

  // The one case in this suite that fakes timers, because it is the one
  // case actually testing the clock: `useNow(live !== null, 1_000)` has to
  // both tick while a selection is live-backed AND install nothing at all
  // once it is archived. `jest.advanceTimersByTimeAsync(0)` (rather than a
  // bare `await Promise.resolve()`) is runs-view.test.tsx's own technique
  // for draining a fetch's microtask under fake timers without letting any
  // fake time actually elapse.
  it('live selection ticks every second and an archived one installs no timer', async () => {
    jest.useFakeTimers();

    // Computed AFTER `useFakeTimers()` so `Date.now()` is the frozen fake
    // clock, not the real one — the render below reads that same frozen
    // instant for its own initial `now`, so the first assertion lands on
    // exactly 600_000ms with nothing to round.
    const fixingAt = new Date(Date.now() - 600_000).toISOString();
    const fixingSummary: OrchestratorArchiveRun = {
      ...primarySummary(),
      queue: [archiveItem('f-1', 'fixing', { stageAt: { fixing: fixingAt } })]
    };
    const fixingLive: OrchestratorRun = {
      runId: RUN_ID,
      project: PROJECT,
      status: 'running',
      startedAt: fixingAt,
      updatedAt: fixingAt,
      maxItems: null,
      attention: [],
      queue: [liveItem('f-1', 'fixing', { stageAt: { fixing: fixingAt } })]
    };

    const { unmount } = render(<RunDetail summary={fixingSummary} live={fixingLive} />);

    expect(screen.getByTestId('run-track-f-1-fixing-val')).toHaveTextContent('10m 00s');

    act(() => {
      jest.advanceTimersByTime(1_000);
    });

    expect(screen.getByTestId('run-track-f-1-fixing-val')).toHaveTextContent('10m 01s');
    // The run-level rollup ticks off the SAME `now`, off the SAME open
    // span — it must not still read the absent-stage dash.
    expect(screen.getByTestId('run-detail-machine-fixing')).not.toHaveTextContent('—');

    // Unmount before mounting the archived case: proves the FIRST
    // instance's own interval is gone (RunDetail.tsx owns no timer of its
    // own beyond `useNow`'s), so the assertion below is about the SECOND
    // instance, not leftover state from the first.
    unmount();

    mockFetchArchivedRun.mockResolvedValue(primaryFull());
    render(<RunDetail summary={primarySummary()} live={null} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    // `live` is `null` for this whole instance's life, so `fetchedRun`
    // landing must not have started a timer anyway — pinning that `useNow`
    // reads `live !== null`, never `source !== null` or similar, which
    // would incorrectly re-enable ticking the moment a fetch resolves.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fix loops show as a badge, not a line', () => {
    mockFetchArchivedRun.mockImplementation(() => new Promise(() => {}));

    render(<RunDetail summary={primarySummary()} live={null} />);

    expect(screen.getByTestId('run-track-a-1-loops')).toHaveTextContent('×1');

    const item = screen.getByTestId('run-detail-item-a-1');
    expect(within(item).queryAllByText(/^\d+ fix loops?$/)).toHaveLength(0);

    expect(screen.queryByTestId('run-detail-stagebar-a-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-detail-caption-a-1')).not.toBeInTheDocument();
  });
});
