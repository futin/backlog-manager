/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { fetchArchivedRun, fetchOrchestratorArchive, fetchOrchestratorRuns } from '../client/src/lib/agents';
import RunsView from '../client/src/components/runs/RunsView';
import { RUN_RANGES } from '../client/src/lib/run-range';
import { MACHINE_STAGES, dayLabel } from '../client/src/lib/run-stats';
import type {
  ArchiveQueueItem, OrchestratorArchivePayload, OrchestratorArchiveRun, OrchestratorRun,
  OrchestratorRunsPayload, RunQueueItem, RunStage, RunVerification, VerificationSummary
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
 * tail-stripped `ArchiveQueueItem`). Takes the same narrow "only override
 * what this case cares about" `over` shape as `item()`, for the same
 * reason: fix round 3's own `LIVE_RUNS` fixture (below) now needs a live
 * queue with real verification entries of its own, not just a bare stage,
 * to exercise the aggregate-tile fix the same way the I2 test's own
 * bespoke fixture already exercises the row fix.
 */
function liveQueueItem(
  id: string,
  stage: RunStage,
  over: { fixLoops?: number; stageAt?: Partial<Record<RunStage, string>>; verification?: RunVerification[] } = {}
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
    // still moving — two fix loops already spent on it, no verification yet.
    // `stageAt` carries a real `reviewing` arrival (final-review wave,
    // Important 1's own fixture fix) rather than the bare default `{}`
    // `item()` would otherwise leave it at: an empty `stageAt` meant this
    // was, and always had been, the ONLY `status: 'running'` archive fixture
    // in this whole suite that could never actually reach `runStageTotals`'
    // open-span arithmetic no matter what that arithmetic did — a whole-
    // branch review named this exact gap as the reason nothing here would
    // have caught a crashed run inflating the wide tile without bound. See
    // "freezes the wide tile's open span..." below for the case this now
    // makes possible.
    item('a-2', 'reviewing', {
      fixLoops: 2,
      stageAt: { pending: '2026-08-25T09:00:00.000Z', reviewing: '2026-08-25T12:05:00.000Z' }
    })
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
 * project, `fresh: true`. Its `queue` used to be `[]` on the theory that
 * "the archive listing is the master list" meant every row read merged/
 * total off the ARCHIVE entry above, never off this one — that was true of
 * the FIRST version of this file, but fix round 2 made a fresh live entry's
 * queue exactly what `RunRow` reads through `pickAuthority`, and round 3
 * made it what the aggregate tiles read too. A `queue: []` fixture renders
 * `0/0` for RUN_LIVE's own numbers, which is not just unrealistic (no real
 * orchestrator run ever reports an empty queue) but actively hides bugs in
 * either fix: a row or a tile that regressed to reading the archive instead
 * of this entry would print RUN_LIVE's real archive numbers, and nothing
 * here would notice the swap if this queue could never disagree with it.
 *
 * So this queue is deliberately AHEAD of `RUN_LIVE`'s own archive snapshot
 * (which has `a-1` merged, `a-2` still `reviewing`) rather than mirroring
 * it: here `a-2` has ALSO merged, modelling the live poll knowing about
 * progress the last archive fetch could not yet have seen. Any assertion
 * anywhere in this file that reads RUN_LIVE's merged/total or the aggregate
 * tiles is therefore already proof the fix reads live, not archive — see
 * "renders the aggregate tile numbers for the current filter" below for the
 * hand-checked arithmetic this produces.
 */
const LIVE_RUNS: OrchestratorRunsPayload['runs'] = [
  {
    runId: RUN_LIVE.runId,
    project: RUN_LIVE.project,
    status: 'running',
    startedAt: RUN_LIVE.startedAt,
    updatedAt: RUN_LIVE.updatedAt,
    maxItems: null,
    queue: [
      liveQueueItem('a-1', 'merged', { verification: [{ cmd: 'pnpm test', ok: true, tail: '' }] }),
      // live-ahead-of-archive: the archive's own a-2 is still "reviewing".
      liveQueueItem('a-2', 'merged', { verification: [{ cmd: 'pnpm test', ok: true, tail: '' }] })
    ],
    attention: [],
    fresh: true,
    pastRuns: 2
  }
];

/**
 * Task 7's own fixtures for the range control (`lib/run-range.ts`) and the
 * wide "machine time by stage" tile it feeds — built from the REAL
 * `Date.now()` at test-run time, unlike every fixed-date fixture above,
 * because `rangeStart`/`inRange` compute their windows against the actual
 * wall clock `RunsView` reads via its own `now = Date.now()`; a literal past
 * date could never honestly exercise "is this inside TODAY".
 *
 * `RUN_A` started 60 seconds ago: inside every one of the four windows,
 * `today` included. `RUN_B` started 40 days ago: outside `today`, `week`
 * AND `month` no matter what day this suite happens to run on — 40 days
 * exceeds the longest possible month (31 days) and the longest possible walk
 * back to a Monday (6 days), so it always crosses at least one month
 * boundary and at least one Monday regardless of where "today" falls in
 * either. Only `all` ever shows both. Different projects, so a project
 * filter can isolate one from the other (case 3 below).
 *
 * Each carries one merged item whose OWN internal timing is independent of
 * its run's `startedAt` above — nothing in this codebase cross-checks that
 * an item's `stageAt` falls within its run's start/end window;
 * `runStageTotals` only ever compares an item's own stamps against each
 * other and against `now`. `dispatched` and `merged` sit one second and then
 * five (A) or ten (B) minutes apart on a fixed, literal 2026-01-01 timeline,
 * chosen only to give the wide tile's `dispatched` row a clean, hand-checked
 * sum once both runs are in scope (case 6 below) — the run's own real-time
 * `startedAt` above is what the RANGE control reads, this timeline is what
 * `runStageTotals` reads, and neither has any reason to agree with the
 * other.
 */
const RUN_A_STARTED_AT = new Date(Date.now() - 60_000).toISOString();
const RUN_B_STARTED_AT = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

const RUN_A = run({
  runId: 'run-range-a',
  project: '/abs/range-a',
  status: 'done',
  startedAt: RUN_A_STARTED_AT,
  updatedAt: RUN_A_STARTED_AT,
  queue: [
    // dispatched -> merged: exactly 5 minutes, the span `runStageTotals`
    // credits to the `dispatched` stage (`pending` -> `dispatched` is also
    // a recorded span, but MACHINE_STAGES drops every `pending` span).
    item('ra-1', 'merged', {
      stageAt: {
        pending: '2026-01-01T00:00:00.000Z',
        dispatched: '2026-01-01T00:00:01.000Z',
        merged: '2026-01-01T00:05:01.000Z'
      }
    })
  ]
});

const RUN_B = run({
  runId: 'run-range-b',
  project: '/abs/range-b',
  status: 'done',
  startedAt: RUN_B_STARTED_AT,
  updatedAt: RUN_B_STARTED_AT,
  queue: [
    // dispatched -> merged: exactly 10 minutes.
    item('rb-1', 'merged', {
      stageAt: {
        pending: '2026-01-01T00:00:00.000Z',
        dispatched: '2026-01-01T00:00:01.000Z',
        merged: '2026-01-01T00:10:01.000Z'
      }
    })
  ]
});

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

    // RUN_LIVE is live-backed, so it contributes its LIVE_RUNS queue (a-1
    // merged, a-2 ALSO merged — ahead of the archive's a-2 "reviewing")
    // through `pickAuthority`, not its archive snapshot. itemsMerged=5
    // (a-1, a-2, a-3, a-4, b-1) of itemsQueued=6 (2+2+1+1). Before fix round
    // 3 this read the archive record for every run, including RUN_LIVE, and
    // printed 4/6 (a-2 still counted as "reviewing") — a number that would
    // have disagreed with RUN_LIVE's own row, which round 2 already fixed
    // to print 2/2.
    expect(screen.getByTestId('runs-tile-merged')).toHaveTextContent('5/6');

    // avgItemWorkMs (Task 7's own addition — this assertion did not exist
    // before this task; CONSTRAINTS.md's R2/amendments deferred it here on
    // purpose). `itemDurationMs` (run-time.ts) measures from an item's
    // FIRST NON-PENDING `stageAt` arrival — `startedAtMs`'s own rule, which
    // skips only `pending` and keeps everything else, `preflight` included —
    // to its terminal stamp, never from `dispatched` specifically. RUN_LIVE's
    // own two merged items (a-1, a-2, read live through `pickAuthority`)
    // carry NO `stageAt` at all in the `LIVE_RUNS` fixture above (only
    // `verification` was ever given them), so `startedAtMs` finds nothing to
    // call "earliest" and `itemDurationMs` returns `null` for both —
    // EXCLUDED from the average entirely, not counted as a zero. The three
    // ARCHIVE-only merged items (a-3, a-4, b-1) each recorded only `pending`
    // and their own terminal `merged` stamp, with no intermediate arrival of
    // any kind in between — so `startedAtMs`, skipping `pending` and taking
    // the earliest of whatever remains, finds only `merged` ITSELF, and
    // measures an item's "start" and "end" off the identical stamp: end -
    // start = 0 for all three. avgItemWorkMs = (0 + 0 + 0) / 3 = 0 ->
    // formatSpanCompact(0) = "0s" — a degenerate number, but the honest one
    // this fixture's own stageAt data (never a `dispatched` entry) actually
    // produces once the correct rule is applied to it.
    expect(screen.getByTestId('runs-tile-avg-item')).toHaveTextContent('avg item work');
    expect(screen.getByTestId('runs-tile-avg-item')).toHaveTextContent('0s');

    // verifyOk=5 of verifyTotal=6 (a-1 ok, a-2 ok [live], a-3 ok, a-4 ok,
    // b-1 ok, b-2 failed) => 83%, rounded to 0 decimals. Before fix round 3:
    // verifyOk=4 of verifyTotal=5 (a-2's live verification entry was never
    // counted at all) => 80%.
    expect(screen.getByTestId('runs-tile-verify')).toHaveTextContent('83%');
  });

  // Task 7's own case: `runStageTotals`' open span (Task 2's own fix-round-1
  // rule) is gated on the RUN's status being `running` — RUN_LIVE's live
  // authority already satisfies that half, but neither of ITS two queue
  // items (a-1, a-2, both `merged` in the `LIVE_RUNS` fixture above) is
  // itself in a non-terminal MACHINE_STAGES stage for the open span to ever
  // fire against, so nothing built on the shared fixtures proves this path
  // actually reaches the WIDE tile the way `run-stats.test.ts` already
  // proves it for `runStageTotals` in isolation.
  //
  // This test extends that same live-backed scenario with its OWN LOCAL
  // copy of the live queue — `a-2` moves from `merged` to `fixing` here —
  // rather than editing the shared `LIVE_RUNS` constant every other test in
  // this file (this one included, immediately above) also renders against:
  // doing that globally would also change the "renders the aggregate tile
  // numbers" test's own pinned 5/6 merged and 83% verify totals, two
  // hand-checked numbers that test's own comments derive in full and that
  // this case has no reason to disturb just to prove a different, orthogonal
  // property of a different tile.
  it("extends the live-backed run's queue so a fixing item's open span reaches the wide tile", async () => {
    const liveRunsWithFixingItem: OrchestratorRunsPayload['runs'] = [
      {
        ...LIVE_RUNS[0],
        queue: [
          LIVE_RUNS[0].queue[0],
          // No later stamp than `fixing` itself — this is what makes it
          // "still open": `runStageTotals` credits it `now - stageAt.fixing`
          // rather than a closed span between two recorded arrivals.
          liveQueueItem('a-2', 'fixing', { fixLoops: 2, stageAt: { fixing: '2026-08-25T09:20:00.000Z' } })
        ]
      }
    ];

    await renderRunsView(ARCHIVE_RUNS, liveRunsWithFixingItem);

    const fixingValue = screen.getByTestId('runs-tile-machine-bars-fixing').querySelector('.run-bars-value')?.textContent;
    expect(fixingValue).not.toBe('—');
  });

  // Final-review wave, Important 1: the SAME "does not pin or accent..."
  // (I4) scenario above — RUN_LIVE's own live-payload entry gone stale
  // (`fresh: false`), so `pickAuthority` falls back to RUN_LIVE's ARCHIVE
  // record — but read through the WIDE tile this time, not the row. That
  // fallback is what a whole-branch review found this suite could reach
  // without ever actually exercising `runStageTotals`' open-span arithmetic,
  // because RUN_LIVE's own archive-shaped `a-2` used to carry no `stageAt`
  // at all (`item()`'s own inert default) — see that fixture's own comment,
  // above, for the fix. With a real `reviewing` arrival now on it, this
  // fallback lands on a genuinely live item in a MACHINE_STAGES stage for
  // the first time.
  //
  // RUN_LIVE's own `updatedAt` (2026-08-31T12:05, unchanged from every other
  // test in this file) is a fixed past date no real run of this suite can
  // ever land on, so `runStageTotals` must read it as a dead heartbeat —
  // always, regardless of which real day actually executes this file — and
  // freeze `a-2`'s open span there rather than at `RunsView`'s own
  // `Date.now()`. `a-2`'s `reviewing` arrival (2026-08-25T12:05) is chosen
  // to make that frozen span a clean, hand-checked 144 hours (exactly 6
  // days) to `updatedAt`. Were the pre-fix code path still active, this same
  // fixture would instead credit `Date.now() - reviewing` — a number that
  // grows with the real calendar and could never be pinned to a fixed string
  // at all, which is exactly the "passes by accident" gap this case closes:
  // nobody could have written a deterministic assertion against the OLD
  // formula for a fixed-past fixture like this one.
  it("freezes the wide tile's open span at a stale archived run's last heartbeat, not real time", async () => {
    const staleLive: OrchestratorRunsPayload['runs'] = [{ ...LIVE_RUNS[0], fresh: false }];

    await renderRunsView(ARCHIVE_RUNS, staleLive);

    const reviewingValue = screen.getByTestId('runs-tile-machine-bars-reviewing')
      .querySelector('.run-bars-value')?.textContent;
    expect(reviewingValue).toBe('144h 00m');
  });

  // bug-14. A crashed orchestrator leaves run.json at `status: "running"`
  // forever and the archive serves it verbatim, with no live entry to back
  // it (mergeRuns keeps a live entry only while its server-computed `fresh`
  // flag holds), so `runWallMs` is the only place that can notice the
  // process is dead. No unit test can prove the ROW stopped growing, which
  // is what this case is for.
  //
  // No fake timers needed, and that is the point: the real `Date.now()`
  // RunsView reads is months past this fixture's September 1st heartbeat,
  // so the run is stale by construction on every day this suite ever runs.
  // Pre-fix, the row prints the whole span since that date — a number that
  // grows with the real calendar and could not be pinned to a fixed string
  // at all; post-fix it freezes at `updatedAt - startedAt`, exactly 42m.
  it('freezes a crashed archived run at its own last heartbeat rather than growing', async () => {
    const crashed = run({
      runId: 'run-20260901-090000',
      project: '/repo/alpha',
      status: 'running',
      startedAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:42:00.000Z',
      queue: [item('bug-1', 'fixing', { stageAt: { pending: '2026-09-01T09:00:00.000Z', fixing: '2026-09-01T09:10:00.000Z' } })]
    });

    await renderRunsView([crashed], []);

    expect(screen.getByTestId(`runs-row-${crashed.runId}`).querySelector('.runs-row-wall')?.textContent).toBe('42m');
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

  // Fix round 3: a follow-up re-review found the row fix above (I2) did not
  // reach the aggregate tiles a few pixels away — `aggregateRuns` was still
  // fed `filtered.map((m) => m.run)`, the raw archive record, so a
  // live-backed run's items merging mid-run moved the ROW's own count
  // (I3's refresh effect does not re-fire for this — merges don't change
  // the FRESH set, only starts/finishes/staleness do) while the "merged /
  // queued" tile stayed frozen at whatever the last archive fetch saw.
  // With exactly one run in scope (as here) that is a flat contradiction:
  // one screen printing two different merged counts for the same run.
  //
  // Reuses the identical archive-behind/live-ahead fixture the row test
  // above already built (archive: g-1 merged, g-2 still reviewing = 1/2;
  // live: g-1 AND g-2 merged = 2/2) specifically so this test is provably
  // the SAME scenario, just asserting the OTHER surface — a reader who
  // sees this test pass and the row test above pass has direct proof the
  // two can no longer disagree, which neither test alone would establish.
  it('the aggregate merged/queued tile agrees with a live-backed row instead of freezing on the archive snapshot', async () => {
    const archiveEntry = run({
      runId: 'run-20260901-090000',
      project: '/abs/gamma',
      status: 'running',
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
      status: 'done',
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

    // Single run in scope, so the tile's own denominator is unambiguous:
    // it must read the same 2/2 the row reads, never the archive's 1/2.
    // Before the fix, this tile printed "1/2" while the row (asserted the
    // same way as the test above) printed "2/2" on the same screen.
    expect(screen.getByTestId('runs-tile-merged')).toHaveTextContent('2/2');
    expect(screen.getByTestId('runs-tile-merged')).not.toHaveTextContent('1/2');
    expect(screen.getByTestId(`runs-row-${archiveEntry.runId}`)).toHaveTextContent('2/2');
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

  // Task 7: the range control (design doc: "Range") — a segmented Today /
  // This week / This month / All group that scopes the tiles, the list, and
  // the wide "machine time by stage" tile together, composed with (not
  // instead of) the existing project filter.
  it('renders the four range buttons, defaulting to All', async () => {
    await renderRunsView(ARCHIVE_RUNS, LIVE_RUNS);

    expect(screen.getByTestId('runs-range')).toHaveAttribute('aria-label', 'Range');

    for (const r of RUN_RANGES) {
      expect(screen.getByTestId(`runs-range-${r}`)).toHaveAttribute('aria-pressed', r === 'all' ? 'true' : 'false');
    }
  });

  it('narrows the run list to the clicked range, and restores it on clicking back to All', async () => {
    await renderRunsView([RUN_A, RUN_B], []);

    await userEvent.click(screen.getByTestId('runs-range-today'));

    // RUN_B started 40 days ago — out of `today`'s window regardless of
    // which day this suite runs on (see RUN_A/RUN_B's own fixture comment).
    expect(screen.getByTestId(`runs-row-${RUN_A.runId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`runs-row-${RUN_B.runId}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('runs-tile-runs')).toHaveTextContent('1');
    expect(screen.getByTestId('runs-range-today')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('runs-range-all')).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(screen.getByTestId('runs-range-all'));

    // Widening back to `all` restores both rows — this is not merely "the
    // filter cleared", it is proof the range narrowing above never dropped
    // RUN_B from `merged` (the unfiltered corpus), only from `filtered`.
    expect(screen.getByTestId(`runs-row-${RUN_A.runId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`runs-row-${RUN_B.runId}`)).toBeInTheDocument();
  });

  it('composes the range filter with the project filter down to the range-empty state', async () => {
    await renderRunsView([RUN_A, RUN_B], []);

    await userEvent.click(screen.getByTestId('runs-range-today'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project' }), RUN_B.project);

    // `today` already excludes RUN_B on its own (case above); narrowing the
    // PROJECT filter to RUN_B's project on top of it excludes RUN_A too
    // (different project), so the intersection is empty even though neither
    // filter alone would be.
    expect(screen.getByTestId('runs-empty-range')).toHaveTextContent('no runs in this range');
    expect(screen.getByTestId('runs-tile-runs')).toHaveTextContent('0');
    expect(screen.getByTestId('runs-tile-avg-item')).toHaveTextContent('—');
    expect(screen.getByTestId('runs-tile-fixloops')).toHaveTextContent('—');
    expect(screen.getByTestId('runs-tile-verify')).toHaveTextContent('—');
    for (const stage of MACHINE_STAGES) {
      expect(screen.getByTestId(`runs-tile-machine-bars-${stage}`)).toHaveTextContent('—');
    }

    // The combination emptied the visible rows, but the project SELECT still
    // offers both projects — `projects` derives from `merged`, never from
    // the range/project-filtered list, so a range that empties a project
    // must not also remove the option that would switch back to it.
    const optionValues = Array.from(
      screen.getByRole('combobox', { name: 'Project' }).querySelectorAll('option')
    ).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(expect.arrayContaining([RUN_A.project, RUN_B.project]));
  });

  it('sums machine time by stage across the runs in range, in the wide tile', async () => {
    const { container } = await renderRunsView([RUN_A, RUN_B], []);

    // All seven MACHINE_STAGES rows always render, in pipeline order,
    // whether or not this fixture recorded a millisecond in every one of
    // them — StageBars.tsx's own "always seven, always ordered" contract.
    const barRowIds = Array.from(container.querySelectorAll('[data-testid^="runs-tile-machine-bars-"]'))
      .map((el) => el.getAttribute('data-testid'));
    expect(barRowIds).toEqual(MACHINE_STAGES.map((stage) => `runs-tile-machine-bars-${stage}`));

    const dispatchedValue = () =>
      screen.getByTestId('runs-tile-machine-bars-dispatched').querySelector('.run-bars-value')?.textContent;

    // A's own `dispatched` span is 5 minutes, B's is 10 (see their shared
    // fixture comment above). Summed under `all` (both runs in scope):
    // 5 + 10 = 15 minutes. Read off the row's own `.run-bars-value` text
    // node directly, not the row's whole `toHaveTextContent`, because "5m"
    // is a substring of "15m" — a stale, unfiltered "15m" left on screen by
    // a broken range filter would falsely satisfy a plain substring check
    // against "5m" below.
    expect(dispatchedValue()).toBe('15m');
    expect(screen.getByTestId('runs-tile-machine')).toHaveTextContent('all runs · queue wait excluded');

    await userEvent.click(screen.getByTestId('runs-range-today'));

    // B (40 days ago) drops out of scope under `today` — only A's own
    // 5-minute span remains.
    expect(dispatchedValue()).toBe('5m');
    expect(screen.getByTestId('runs-tile-machine')).toHaveTextContent('today · queue wait excluded');
  });
});
