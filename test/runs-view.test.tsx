/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { fetchArchivedRun, fetchOrchestratorArchive, fetchOrchestratorRuns } from '../client/src/lib/agents';
import RunsView from '../client/src/components/runs/RunsView';
import { dayLabel } from '../client/src/lib/run-stats';
import type {
  ArchiveQueueItem, OrchestratorArchivePayload, OrchestratorArchiveRun, OrchestratorRun,
  OrchestratorRunsPayload, RunQueueItem, RunStage, VerificationSummary
} from '../shared/types';

// Task 6 consumes the two archive/live fetchers through the real hooks
// (useOrchestratorArchive, useOrchestratorRuns) rather than through fetch
// directly, so mocking at the lib/agents module boundary — the brief's own
// instruction — lets this suite drive RunsView exactly as the browser will:
// the hooks' mount-time fetch, their promise resolution, and their own
// state plumbing all run for real, and only the network edge is faked.
//
// `fetchArchivedRun` joins the other two here for Task 7: the detail pane
// RunsView now mounts behind the selected row calls it directly (not through
// a hook), and with no entry for it in this factory the real module's
// export would be `undefined` — every RunDetail render for an archived
// selection would throw the instant its effect tried to call it.
jest.mock('../client/src/lib/agents', () => ({
  __esModule: true,
  fetchArchivedRun: jest.fn(),
  fetchOrchestratorArchive: jest.fn(),
  fetchOrchestratorRuns: jest.fn()
}));

const mockArchive = fetchOrchestratorArchive as jest.Mock;
const mockRuns = fetchOrchestratorRuns as jest.Mock;
const mockFetchArchivedRun = fetchArchivedRun as jest.Mock;

/**
 * One queue item, archive-shaped (verification already summarised — the
 * exact shape `GET /api/orchestrator/archive` answers with). Defaults are
 * deliberately inert (no fix loops, no verification, no stage timestamps) so
 * every fixture item below states only the fields its own case actually
 * cares about, the same "narrow the default, override what matters" shape
 * the rest of this repo's test fixtures use (see orchestrator-strip.test.tsx's
 * `fakeItem`).
 */
function item(
  id: string,
  stage: RunStage,
  over: { fixLoops?: number; stageAt?: Partial<Record<RunStage, string>>; verification?: VerificationSummary[] } = {}
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
    questions: [],
    note: null
  };
}

/**
 * The full-shaped (tail-bearing) counterpart to `item()` above — what the
 * LIVE poll payload's own `queue` actually carries (`RunQueueItem`, not the
 * tail-stripped `ArchiveQueueItem`). Used only by the I2 test below, which
 * needs a live entry with a real, non-empty queue: every OTHER test in this
 * file uses `LIVE_RUNS`' own deliberately-empty `queue: []` (see that
 * fixture's own comment for why), since fix round 2 is exactly what makes a
 * live entry's queue matter to a ROW's own rendering for the first time.
 */
function liveQueueItem(id: string, stage: RunStage): RunQueueItem {
  return {
    id,
    title: `${id} title`,
    stage,
    sessionId: null,
    worktree: null,
    branch: null,
    permissionMode: null,
    fixLoops: 0,
    stageAt: {},
    verification: [],
    questions: [],
    note: null
  };
}

function run(over: Partial<OrchestratorArchiveRun> & Pick<OrchestratorArchiveRun, 'runId' | 'project' | 'status' | 'startedAt' | 'updatedAt' | 'queue'>): OrchestratorArchiveRun {
  return { maxItems: null, attention: [], current: false, ...over };
}

/**
 * The fixture the brief calls for: two projects, four runs, one of them
 * (RUN_LIVE) running and also present in the live poll payload so it reads
 * as "live-backed" — everything else only ever lives in the archive. Two
 * distinct days, each holding two runs, spaced three calendar days apart
 * (Aug 31 vs Aug 28) rather than adjacent — `dayKey`/`dayLabel` bucket by
 * LOCAL time (their own doc comments explain why), and a three-day gap
 * cannot be pushed across a group boundary by any real timezone offset the
 * way one calendar day apart marginally could, which is what keeps this
 * suite's grouping assertions honest regardless of which timezone actually
 * runs the test.
 *
 * RUN_LIVE's own `startedAt` is fix round 1's deliberate change: it is set
 * BEFORE both day groups (Aug 25, three days ahead of the earlier of the
 * two), not after them — the fixture equivalent of "a run that has been
 * going since three days ago, sitting beside a run that merely finished
 * more recently". A fixture where the live run also happened to be the
 * chronologically newest one would let every ordering/selection assertion
 * below pass whether or not RunsView actually pins fresh runs above
 * history, since a plain `startedAt` sort would put it first anyway — this
 * is exactly the case the review that prompted this fix round called out by
 * name ("a fixture where the live run is also the newest proves nothing").
 *
 * Every number below (merged counts, wall times, fix loops, verification
 * pass/fail) was chosen so `aggregateRuns`' own arithmetic lands on a clean,
 * hand-checked value — see the comment beside each assertion below for the
 * exact sum. The point is that this suite is pinning RunsView's *rendering*
 * of aggregateRuns' output, not re-deriving aggregateRuns' own math (that is
 * run-stats.test.ts's job) — a fixture whose numbers required re-deriving
 * fractions in the assertions would blur that line.
 */
const RUN_LIVE = run({
  runId: 'run-20260825-090000',
  project: '/abs/alpha',
  status: 'running',
  startedAt: '2026-08-25T09:00:00.000Z',
  updatedAt: '2026-08-31T12:05:00.000Z',
  current: true,
  queue: [
    // merged, 10-minute wall time
    item('a-1', 'merged', {
      stageAt: { pending: '2026-08-25T09:00:00.000Z', merged: '2026-08-25T09:10:00.000Z' },
      verification: [{ cmd: 'pnpm test', ok: true }]
    }),
    // still moving — two fix loops already spent on it, no verification yet
    item('a-2', 'reviewing', { fixLoops: 2 })
  ]
});

const RUN_DONE_ALPHA = run({
  runId: 'run-20260831-100000',
  project: '/abs/alpha',
  status: 'done',
  startedAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:45:00.000Z',
  queue: [
    // merged, 5-minute wall time
    item('a-3', 'merged', {
      stageAt: { pending: '2026-08-31T07:00:00.000Z', merged: '2026-08-31T07:05:00.000Z' },
      verification: [{ cmd: 'pnpm test', ok: true }]
    }),
    // merged, 15-minute wall time
    item('a-4', 'merged', {
      stageAt: { pending: '2026-08-31T07:00:00.000Z', merged: '2026-08-31T07:15:00.000Z' },
      verification: [{ cmd: 'pnpm test', ok: true }]
    })
  ]
});

const RUN_DONE_BETA = run({
  runId: 'run-20260828-120000',
  project: '/abs/beta',
  status: 'done',
  startedAt: '2026-08-28T12:00:00.000Z',
  updatedAt: '2026-08-28T12:10:00.000Z',
  queue: [
    // merged, 10-minute wall time
    item('b-1', 'merged', {
      stageAt: { pending: '2026-08-28T09:00:00.000Z', merged: '2026-08-28T09:10:00.000Z' },
      verification: [{ cmd: 'pnpm test', ok: true }]
    })
  ]
});

const RUN_FAILED_BETA = run({
  runId: 'run-20260828-100000',
  project: '/abs/beta',
  status: 'failed',
  startedAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:10:00.000Z',
  queue: [
    // never merged, one failing verification
    item('b-2', 'failed', { verification: [{ cmd: 'pnpm test', ok: false }] })
  ]
});

const ARCHIVE_RUNS = [RUN_LIVE, RUN_DONE_ALPHA, RUN_DONE_BETA, RUN_FAILED_BETA];

/**
 * The one entry the live poll payload carries — RUN_LIVE's own runId and
 * project, `fresh: true`. Its `queue` is deliberately `[]`: the design's own
 * "archive listing is the master list" rule means every row RunsView paints
 * (id, stage counts, wall time) reads off the ARCHIVE entry above, never off
 * this one — the live object exists only to answer "is this run still being
 * heard from right now", which is exactly and only what `fresh` says. Task 7
 * is what will actually read a live run's queue.
 */
const LIVE_RUNS: OrchestratorRunsPayload['runs'] = [
  {
    runId: RUN_LIVE.runId,
    project: RUN_LIVE.project,
    status: 'running',
    startedAt: RUN_LIVE.startedAt,
    updatedAt: RUN_LIVE.updatedAt,
    maxItems: null,
    queue: [],
    attention: [],
    fresh: true,
    pastRuns: 2
  }
];

async function renderRunsView(archiveRuns: OrchestratorArchiveRun[], liveRuns: OrchestratorRunsPayload['runs'] = []): Promise<RenderResult> {
  mockArchive.mockResolvedValue({ runs: archiveRuns } satisfies OrchestratorArchivePayload);
  mockRuns.mockResolvedValue({ runs: liveRuns } satisfies OrchestratorRunsPayload);
  const result = render(<RunsView />);
  if (archiveRuns.length === 0 && liveRuns.length === 0) {
    await screen.findByText('no runs yet');
  } else {
    await screen.findByTestId('runs-list');
  }
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  // A safe, inert default for every test in this file that does not care
  // about the detail pane's own fetch: RunDetail (Task 7) now mounts behind
  // whatever row is selected, and the default selection lands on an
  // ARCHIVED row in more than one existing test below once a project filter
  // removes the pinned live run from scope (see "narrows both the row list
  // and the tiles"). Without an implementation here that row's RunDetail
  // would call a bare `jest.fn()`, get back `undefined`, and throw the
  // instant its effect called `.then()` on it — a suite whose own subject is
  // the run LIST, not the detail pane, should not have to know that detail
  // about Task 7's own effect to keep passing. A promise that never resolves
  // is enough: nothing here asserts on the fetched tail text.
  (fetchArchivedRun as jest.Mock).mockImplementation(() => new Promise(() => {}));
});

describe('RunsView', () => {
  // Also the "would fail without the pin" case the review asked for: RUN_LIVE's
  // own `startedAt` (2026-08-25) is BEFORE both day groups' runs, so a plain
  // startedAt-descending sort with no pinning would print it LAST, under its
  // own day heading — not first, and not under a "live" heading at all. The
  // self-check below pins that premise so a future edit that accidentally
  // makes RUN_LIVE the chronologically newest run again cannot silently
  // defeat what this test is actually proving.
  it('pins the fresh live run above every day group, even though its startedAt is the oldest in scope', async () => {
    expect(Date.parse(RUN_LIVE.startedAt)).toBeLessThan(Date.parse(RUN_DONE_BETA.startedAt));

    const { container } = await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);

    const headings = Array.from(container.querySelectorAll('.runs-day-heading')).map((el) => el.textContent);
    expect(headings[0]).toBe('live');

    const rowIds = Array.from(container.querySelectorAll('.runs-row'))
      .map((el) => el.getAttribute('data-testid'));
    expect(rowIds[0]).toBe(`runs-row-${RUN_LIVE.runId}`);

    expect(screen.getByTestId('run-detail-slot')).toHaveTextContent(RUN_LIVE.runId);
  });

  it('groups history by day under the pinned live region, newest first, with rows inside a day ordered by startedAt desc', async () => {
    const { container } = await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);

    const headings = Array.from(container.querySelectorAll('.runs-day-heading')).map((el) => el.textContent);
    // "live" leads (see the pin test above), then the two day headings —
    // read off the real `dayLabel` function against this fixture's own
    // timestamps, never hand-typed: a hand-typed "tue 1 sep" would silently
    // pass or fail depending on the machine's timezone, exactly the
    // flakiness dayLabel's own doc comment warns dayKey/dayLabel's
    // LOCAL-time behaviour can cause. RUN_DONE_ALPHA is alone in the Aug 31
    // group now that RUN_LIVE (also Aug-31-adjacent by nothing but its own
    // runId) is pinned out of history entirely.
    expect(headings).toEqual(['live', dayLabel(RUN_DONE_ALPHA.startedAt), dayLabel(RUN_DONE_BETA.startedAt)]);

    const rowIds = Array.from(container.querySelectorAll('.runs-row'))
      .map((el) => el.getAttribute('data-testid'));
    expect(rowIds).toEqual([
      `runs-row-${RUN_LIVE.runId}`,
      `runs-row-${RUN_DONE_ALPHA.runId}`,
      `runs-row-${RUN_DONE_BETA.runId}`,
      `runs-row-${RUN_FAILED_BETA.runId}`
    ]);
  });

  it('defaults selection to the pinned live run', async () => {
    await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);
    expect(screen.getByTestId('run-detail-slot')).toHaveTextContent(RUN_LIVE.runId);
  });

  it('carries a live marker on the row backed by a fresh live run, and no other row', async () => {
    await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);
    expect(screen.getByTestId(`runs-row-${RUN_LIVE.runId}`)).toHaveClass('runs-row-live');
    expect(screen.getByTestId(`runs-row-${RUN_DONE_ALPHA.runId}`)).not.toHaveClass('runs-row-live');
    expect(screen.getByTestId(`runs-row-${RUN_DONE_BETA.runId}`)).not.toHaveClass('runs-row-live');
    expect(screen.getByTestId(`runs-row-${RUN_FAILED_BETA.runId}`)).not.toHaveClass('runs-row-live');
  });

  it('narrows both the row list and the tiles to the selected project', async () => {
    await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project' }), '/abs/beta');

    // Only beta's two runs remain on screen.
    expect(screen.queryByTestId(`runs-row-${RUN_LIVE.runId}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`runs-row-${RUN_DONE_ALPHA.runId}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`runs-row-${RUN_DONE_BETA.runId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`runs-row-${RUN_FAILED_BETA.runId}`)).toBeInTheDocument();

    // aggregateRuns([RUN_DONE_BETA, RUN_FAILED_BETA], now).runs === 2.
    expect(screen.getByTestId('runs-tile-runs')).toHaveTextContent('2');
  });

  it('renders the aggregate tile numbers for the current filter', async () => {
    await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);

    // itemsMerged=4 (a-1, a-3, a-4, b-1) of itemsQueued=6 (2+2+1+1).
    expect(screen.getByTestId('runs-tile-merged')).toHaveTextContent('4/6');

    // verifyOk=4 of verifyTotal=5 (a-1 ok, a-2 none, a-3 ok, a-4 ok, b-1 ok,
    // b-2 failed) => 80%, rounded to 0 decimals.
    expect(screen.getByTestId('runs-tile-verify')).toHaveTextContent('80%');
  });

  it('renders the empty state and nothing else for empty payloads', async () => {
    await renderRunsView([], []);
    expect(screen.getByText('no runs yet')).toBeInTheDocument();
    expect(screen.queryByTestId('runs-tiles')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runs-list')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
  });

  it('moves the selection when a different row is clicked', async () => {
    await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);
    expect(screen.getByTestId('run-detail-slot')).toHaveTextContent(RUN_LIVE.runId);

    await userEvent.click(screen.getByTestId(`runs-row-${RUN_DONE_BETA.runId}`));

    expect(screen.getByTestId('run-detail-slot')).toHaveTextContent(RUN_DONE_BETA.runId);
    expect(screen.getByTestId(`runs-row-${RUN_DONE_BETA.runId}`)).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId(`runs-row-${RUN_LIVE.runId}`)).not.toHaveAttribute('aria-current', 'true');
  });

  // Task 7's own integration case: RunDetail is mounted by RunsView, not
  // tested standalone here (test/run-detail.test.tsx already covers its
  // internals in isolation) — what this suite is responsible for proving is
  // the WIRING, specifically that clicking an ARCHIVED row (one with no
  // fresh live entry backing it) is what makes RunsView pass `live={null}`
  // down, which is what makes RunDetail decide to fetch at all. RUN_LIVE
  // itself is the wrong row to click for this: it IS live-backed, so
  // selecting it must resolve to a non-null `live` prop and no fetch should
  // fire — that half of the contract belongs to run-detail.test.tsx's own
  // "live run renders tails without fetching" case, not this one.
  it('selecting an archived run mounts RunDetail which fetches that project+runId', async () => {
    await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);

    await userEvent.click(screen.getByTestId(`runs-row-${RUN_DONE_BETA.runId}`));

    await waitFor(() => {
      expect(mockFetchArchivedRun).toHaveBeenCalledWith(RUN_DONE_BETA.project, RUN_DONE_BETA.runId);
    });
  });

  // I4: `LIVE_RUNS` (used by every test above) has exactly one entry and it
  // is always `fresh: true` — no fixture anywhere before this test supplied
  // the ONE case `mergeRuns`' `.filter((r) => r.fresh)` gate exists to
  // reject: a run that IS in the live payload (the board has heard from it)
  // but is NOT fresh (its heartbeat has gone stale — RUN_STALE_MS). Without
  // this test, deleting that `.filter` leaves every other test in this file
  // green: the row would still gain the live class and get pinned, since
  // nothing before this exercised the `fresh: false` branch at all.
  it('does not pin or accent a run whose live-payload entry has gone stale (fresh: false)', async () => {
    const staleLive: OrchestratorRunsPayload['runs'] = [{ ...LIVE_RUNS[0], fresh: false }];

    const { container } = await renderRunsView(ARCHIVE_RUNS, staleLive);

    // No "live" pinned heading at all — RUN_LIVE sorts into ordinary
    // history by its own startedAt (the oldest run in this fixture — see
    // the pin test's own premise assertion above), not pinned above every
    // day group the way a naive "present in the live payload at all" check
    // would render it.
    const headings = Array.from(container.querySelectorAll('.runs-day-heading')).map((el) => el.textContent);
    expect(headings).not.toContain('live');
    expect(screen.getByTestId(`runs-row-${RUN_LIVE.runId}`)).not.toHaveClass('runs-row-live');
  });

  // I2: a whole-branch review found that a live-backed row's merged/total
  // and status read the ARCHIVE snapshot (`mergeRuns` used to drop the live
  // payload's queue entirely) while `RunDetail` beside it reads the 5s live
  // poll — same run, two different merged counts on one screen. This
  // fixture makes the archive snapshot deliberately STALE (1/2 merged,
  // `running`) and the live entry deliberately AHEAD of it (2/2 merged,
  // `done`), so a row still reading the archive would print `1/2` and
  // `running` where the fix makes it print `2/2` and `done`.
  it("a live-backed row reads its merged/total and status off the live entry, not the stale archive snapshot", async () => {
    const archiveEntry = run({
      runId: 'run-20260901-090000',
      project: '/abs/gamma',
      status: 'running', // stale: this archive snapshot predates what the live poll now knows
      startedAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:05:00.000Z',
      current: true,
      queue: [
        item('g-1', 'merged'),
        item('g-2', 'reviewing') // archive's stale snapshot: still "in progress"
      ]
    });
    const liveEntry: OrchestratorRunsPayload['runs'][number] = {
      runId: archiveEntry.runId,
      project: archiveEntry.project,
      status: 'done', // the live poll already knows it finished
      startedAt: archiveEntry.startedAt,
      updatedAt: '2026-09-01T09:10:00.000Z',
      maxItems: null,
      attention: [],
      queue: [
        liveQueueItem('g-1', 'merged'),
        liveQueueItem('g-2', 'merged') // live: g-2 has ALSO merged now (2/2), unlike the archive's 1/2
      ],
      fresh: true,
      pastRuns: 0
    };

    await renderRunsView([archiveEntry], [liveEntry]);

    const row = screen.getByTestId(`runs-row-${archiveEntry.runId}`);
    expect(row).toHaveTextContent('2/2');
    expect(row).not.toHaveTextContent('1/2');
    expect(row).toHaveTextContent('done');
  });

  // M3: `mergeRuns` used to dedupe on bare `runId`, contradicting
  // `Selection` (and the detail-slot lookup) elsewhere in this same file —
  // both of which key on `{project, runId}` precisely because a `runId` is
  // a second-precision timestamp, not a global counter, and could in
  // principle collide across two different projects' state directories.
  // This fixture IS that collision. A `runId`-only dedupe would silently
  // drop one of these two rows from the list entirely.
  it('keeps both runs when two different projects happen to share a runId ({project, runId} dedupe)', async () => {
    const sharedRunId = 'run-20260901-120000';
    const runOne = run({
      runId: sharedRunId,
      project: '/abs/collide-one',
      status: 'done',
      startedAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:05:00.000Z',
      queue: [item('c1-1', 'merged')]
    });
    const runTwo = run({
      runId: sharedRunId,
      project: '/abs/collide-two',
      status: 'done',
      startedAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:05:00.000Z',
      queue: [item('c2-1', 'merged')]
    });

    await renderRunsView([runOne, runTwo], []);

    // Both rows render, sharing the same `data-testid` (it is built off the
    // bare `runId` too, unaffected by this fix) — a `runId`-only dedupe
    // would keep only the FIRST and this would find one, not two.
    expect(screen.getAllByTestId(`runs-row-${sharedRunId}`)).toHaveLength(2);
  });

  // I3: `useOrchestratorArchive`'s own `refresh()` used to be returned and
  // never called by this view, so a run starting (or a fresh set otherwise
  // changing) while the tab stayed open and focused never updated the
  // archive listing at all — no focus event, no new mount, nothing. This
  // test proves the fix WITHOUT relying on a focus event (which would also
  // trigger `useOrchestratorArchive`'s own independent focus listener,
  // masking whether RunsView's own new effect fired): it arms
  // `useOrchestratorRuns`' 5s poll with an already-fresh run at mount, then
  // has that poll's NEXT tick report a SECOND project's run as newly fresh
  // — a state change with no focus event anywhere in the sequence.
  it("refetches the archive listing when the live poll's set of fresh runs changes, with no focus event", async () => {
    jest.useFakeTimers();
    try {
      const archiveAlpha = run({
        runId: 'run-20260901-090000',
        project: '/abs/alpha-i3',
        status: 'running',
        startedAt: '2026-09-01T09:00:00.000Z',
        updatedAt: '2026-09-01T09:00:00.000Z',
        queue: []
      });
      const liveAlpha: OrchestratorRunsPayload['runs'][number] = {
        runId: archiveAlpha.runId,
        project: archiveAlpha.project,
        status: 'running',
        startedAt: archiveAlpha.startedAt,
        updatedAt: archiveAlpha.updatedAt,
        maxItems: null,
        queue: [],
        attention: [],
        fresh: true,
        pastRuns: 0
      };

      mockArchive.mockResolvedValue({ runs: [archiveAlpha] } satisfies OrchestratorArchivePayload);
      mockRuns.mockResolvedValue({ runs: [liveAlpha] } satisfies OrchestratorRunsPayload);

      render(<RunsView />);
      // Flushes the mount-time fetches (both hooks') and whatever effects
      // their landed state triggers — `advanceTimersByTimeAsync(0)` reaches
      // a real microtask-queue drain without any fake time actually
      // elapsing, the same technique test/orchestrator-hook.test.tsx uses
      // for the identical reason.
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });

      const archiveCallsAfterMount = mockArchive.mock.calls.length;
      // `useOrchestratorRuns`' own polling interval is armed here (a fresh
      // run already exists from mount), so a real 5s tick — not a focus
      // event — is what makes it notice this SECOND project's run.
      const liveBeta: OrchestratorRunsPayload['runs'][number] = {
        runId: 'run-20260901-093000',
        project: '/abs/beta-i3',
        status: 'running',
        startedAt: '2026-09-01T09:30:00.000Z',
        updatedAt: '2026-09-01T09:30:00.000Z',
        maxItems: null,
        queue: [],
        attention: [],
        fresh: true,
        pastRuns: 0
      };
      mockRuns.mockResolvedValue({ runs: [liveAlpha, liveBeta] } satisfies OrchestratorRunsPayload);

      await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });

      // The archive listing was re-fetched strictly because the live poll's
      // OWN set of fresh runs changed — no focus event fired anywhere in
      // this test. Without the fix, `refreshArchive` is never called after
      // mount, so this count would never move no matter how many poll
      // ticks pass.
      expect(mockArchive.mock.calls.length).toBeGreaterThan(archiveCallsAfterMount);
    } finally {
      jest.useRealTimers();
    }
  });
});
