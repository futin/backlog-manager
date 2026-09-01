import {
  itemStageSpans, itemWallMs, runWallMs, runStageTotals, aggregateRuns, dayKey, dayLabel
} from '../client/src/lib/run-stats';
import type { ArchiveQueueItem, OrchestratorArchiveRun, RunQueueItem, RunStage } from '../shared/types';

/**
 * The derivations behind the Runs section's stat tiles and per-item stage
 * bars (Tasks 6 and 7 consume this module by these exact names). Every case
 * pins a fixed `now`/set of stamps rather than the real clock, matching
 * run-time.test.ts's own reasoning: these are pure functions with no
 * fallback default, so there is nothing for the real clock to buy a test
 * here and everything for it to make flaky.
 */

/** An arbitrary but fixed instant, and the base every relative stamp below is built from. */
const T0 = Date.parse('2026-08-31T09:20:45Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** Just the one field itemStageSpans/itemWallMs read — never a whole RunQueueItem, which would bury it. */
function withStageAt(stageAt: Partial<Record<RunStage, string>>): Pick<RunQueueItem, 'stageAt'> {
  return { stageAt };
}

/**
 * A full ArchiveQueueItem, defaulted to a merged item with no fix loops and
 * no verification history — runStageTotals/aggregateRuns take whole queues,
 * not the stageAt-only slice the two item-level functions accept, so their
 * fixtures need every field even though most of it is irrelevant to any one
 * assertion.
 */
function archiveItem(over: Partial<ArchiveQueueItem> = {}): ArchiveQueueItem {
  return {
    id: 'item-1',
    title: 'Item',
    stage: 'merged',
    sessionId: null,
    worktree: null,
    branch: null,
    permissionMode: null,
    fixLoops: 0,
    stageAt: {},
    verification: [],
    questions: [],
    note: null,
    ...over
  };
}

function archiveRun(over: Partial<OrchestratorArchiveRun> = {}): OrchestratorArchiveRun {
  return {
    runId: 'run-20260831-092045',
    project: '/repo',
    status: 'done',
    startedAt: at(0),
    updatedAt: at(0),
    maxItems: null,
    queue: [],
    attention: [],
    current: false,
    ...over
  };
}

describe('itemStageSpans', () => {
  // Case 1: a clean progression. Four stamps make three spans — the last
  // arrival (merged) is the terminal point, not the start of a fourth span.
  it('spans a clean progression, in stamp order, labeled by the earlier stage', () => {
    const item = withStageAt({
      pending: at(0),
      dispatched: at(10_000),
      reviewing: at(70_000),
      merged: at(100_000)
    });
    expect(itemStageSpans(item)).toEqual([
      { stage: 'pending', ms: 10_000 },
      { stage: 'dispatched', ms: 60_000 },
      { stage: 'reviewing', ms: 30_000 }
    ]);
  });

  // Case 2: same four instants, but the object literal's keys are written in
  // scrambled order. itemStageSpans must sort by the parsed TIMESTAMP, never
  // by where the key sits in Object.entries — a fix-looped item's stageAt
  // can easily be written to disk in a different order than it was visited.
  it('sorts by timestamp, not by insertion order, and reaches the same spans', () => {
    const item = withStageAt({
      merged: at(100_000),
      pending: at(0),
      reviewing: at(70_000),
      dispatched: at(10_000)
    });
    expect(itemStageSpans(item)).toEqual([
      { stage: 'pending', ms: 10_000 },
      { stage: 'dispatched', ms: 60_000 },
      { stage: 'reviewing', ms: 30_000 }
    ]);
  });

  // Case 3: one stamp cannot span anything against itself.
  it('returns no spans for a single stamp', () => {
    const item = withStageAt({ pending: at(0) });
    expect(itemStageSpans(item)).toEqual([]);
  });

  // Case 4: a corrupt stamp is dropped along with the key that held it — not
  // just skipped as a value — so the surrounding stamps still span correctly
  // against each other rather than against a hole.
  it('drops a corrupt stamp entirely rather than treating it as a boundary', () => {
    const item = withStageAt({
      pending: 'garbage',
      dispatched: at(0),
      merged: at(5_000)
    });
    expect(itemStageSpans(item)).toEqual([{ stage: 'dispatched', ms: 5_000 }]);
  });
});

describe('itemWallMs', () => {
  // Case 3 (wall half): fewer than two parseable stamps means there is no
  // "first" and "last" to subtract, so this is null rather than 0 — 0 would
  // read as "this item took no time," which is not the same fact.
  it('is null with fewer than two parseable stamps', () => {
    expect(itemWallMs(withStageAt({ pending: at(0) }))).toBeNull();
    expect(itemWallMs(withStageAt({}))).toBeNull();
  });

  // Case 5: last recorded arrival minus first, off the case-1 fixture.
  it('is the last arrival minus the first', () => {
    const item = withStageAt({
      pending: at(0),
      dispatched: at(10_000),
      reviewing: at(70_000),
      merged: at(100_000)
    });
    expect(itemWallMs(item)).toBe(100_000);
  });

  // Case 4 (wall half): the corrupt `pending` stamp is excluded from both
  // ends of the subtraction, so wall time is measured off what actually
  // parsed (dispatched..merged), not off a phantom zero point.
  it('excludes a corrupt stamp from both ends of the subtraction', () => {
    const item = withStageAt({
      pending: 'garbage',
      dispatched: at(0),
      merged: at(5_000)
    });
    expect(itemWallMs(item)).toBe(5_000);
  });
});

describe('runWallMs', () => {
  // Case 6a: a finished run measures updatedAt - startedAt. `now` must not
  // matter here — a run that ended an hour ago must not read as having taken
  // an hour longer just because nobody asked about it until later.
  it('is updatedAt minus startedAt for a finished run, regardless of now', () => {
    const run = archiveRun({ status: 'done', startedAt: at(0), updatedAt: at(90_000) });
    expect(runWallMs(run, T0)).toBe(90_000);
    expect(runWallMs(run, T0 + 999_999)).toBe(90_000);
  });

  // Case 6b: a running run measures against `now` instead — updatedAt is
  // whatever the last heartbeat happened to write, not the answer to "how
  // long has this been going" while it is still going.
  it('is now minus startedAt while the run is still running', () => {
    const run = archiveRun({ status: 'running', startedAt: at(0), updatedAt: at(1_000) });
    expect(runWallMs(run, T0 + 30_000)).toBe(30_000);
  });

  // Case 6c: an unparseable startedAt leaves nothing to measure from, for
  // either branch — this must not throw or fall back to a wrong instant.
  it('is null when startedAt does not parse', () => {
    const run = archiveRun({ status: 'done', startedAt: 'garbage', updatedAt: at(90_000) });
    expect(runWallMs(run, T0)).toBeNull();
  });
});

describe('runStageTotals', () => {
  // Case 7: two items whose spans both include a `dispatched` leg — the
  // totals record must sum them rather than overwrite, and a stage neither
  // item ever spanned (`merging`) must be absent from the record entirely,
  // not present at 0 — Partial<Record<...>> is the whole point of the return
  // type, and a caller iterating Object.keys() should not see zero-value
  // noise for stages nothing touched.
  it('sums each stage span across every item in the queue', () => {
    const run = archiveRun({
      queue: [
        archiveItem({
          id: 'item-a',
          stageAt: { pending: at(0), dispatched: at(10_000), reviewing: at(40_000) }
        }),
        archiveItem({
          id: 'item-b',
          stageAt: { pending: at(0), dispatched: at(20_000), merged: at(50_000) }
        })
      ]
    });
    expect(runStageTotals(run)).toEqual({
      // item-a: pending 10_000, dispatched 30_000
      // item-b: pending 20_000, dispatched 30_000
      pending: 30_000,
      dispatched: 60_000
    });
  });
});

describe('aggregateRuns', () => {
  // Case 8: three runs standing in for the whole tile row at once — one
  // finished run with two merges and a fix loop on each, one failed run that
  // merged only one of its two items, one still-running run that has merged
  // nothing yet. Every stamp below is a round number chosen so the average
  // wall time comes out exact rather than needing toBeCloseTo.
  it('aggregates counts, fix-loop cost, verification pass rate and average wall time across runs', () => {
    const doneRun = archiveRun({
      status: 'done',
      queue: [
        archiveItem({
          id: 'bug-1',
          stage: 'merged',
          fixLoops: 1,
          verification: [
            { cmd: 'pnpm test', ok: true },
            { cmd: 'pnpm typecheck', ok: true }
          ],
          // wall: 100_000
          stageAt: { pending: at(0), dispatched: at(10_000), merged: at(100_000) }
        }),
        archiveItem({
          id: 'bug-2',
          stage: 'merged',
          fixLoops: 2,
          verification: [
            { cmd: 'pnpm test', ok: true },
            { cmd: 'pnpm lint', ok: false }
          ],
          // wall: 200_000
          stageAt: { pending: at(200_000), dispatched: at(210_000), merged: at(400_000) }
        })
      ]
    });

    const failedRun = archiveRun({
      status: 'failed',
      queue: [
        archiveItem({
          id: 'bug-3',
          stage: 'merged',
          fixLoops: 0,
          verification: [],
          // wall: 300_000
          stageAt: { pending: at(0), dispatched: at(10_000), merged: at(300_000) }
        }),
        archiveItem({
          id: 'bug-4',
          stage: 'failed',
          fixLoops: 0,
          verification: [],
          stageAt: { pending: at(0), dispatched: at(10_000), failed: at(50_000) }
        })
      ]
    });

    const runningRun = archiveRun({
      status: 'running',
      queue: [
        archiveItem({ id: 'bug-5', stage: 'pending', stageAt: { pending: at(0) } }),
        archiveItem({ id: 'bug-6', stage: 'dispatched', stageAt: { pending: at(0), dispatched: at(5_000) } }),
        archiveItem({
          id: 'bug-7',
          stage: 'reviewing',
          stageAt: { pending: at(0), dispatched: at(5_000), reviewing: at(20_000) }
        })
      ]
    });

    const result = aggregateRuns([doneRun, failedRun, runningRun], T0 + 500_000);

    expect(result.runs).toBe(3);
    expect(result.byStatus).toEqual({ done: 1, failed: 1, running: 1, aborted: 0 });
    expect(result.itemsMerged).toBe(3);
    expect(result.itemsQueued).toBe(7);
    // (1 + 2 + 0 + 0) fix loops / 3 merged
    expect(result.fixLoopsPerMerged).toBe(1);
    // 3 ok out of 4 total verification entries, all from doneRun
    expect(result.verifyPassRate).toBe(0.75);
    // (100_000 + 200_000 + 300_000) / 3 merged items with a wall time
    expect(result.avgItemWallMs).toBe(200_000);
  });

  // Fix round 1: case 8 above cannot tell "sum fixLoops/verification over
  // ALL queued items" apart from "sum over merged items only" — every
  // non-merged item in that fixture (bug-4, and every item in the running
  // run) happens to carry fixLoops: 0 and verification: [], so the two
  // readings land on the same numbers by coincidence, not by test design.
  // This case exists solely to rule the "merged only" reading out:
  // `bug-unmerged` never merges (stage 'failed') but still carries 5 fix
  // loops and two verification entries of its own.
  //
  //   all-items reading (what aggregateRuns implements, per its own doc
  //   comment and RunAggregates's field comments):
  //     fixLoopsPerMerged = (1 + 0 + 5) fix loops / 2 merged     = 3
  //     verifyPassRate    = (1 + 0 + 1) ok / (1 + 0 + 2) entries = 2/3
  //
  //   merged-only reading (the alternative this pins against):
  //     fixLoopsPerMerged = (1 + 0) fix loops / 2 merged         = 0.5
  //     verifyPassRate    = (1 + 0) ok / (1 + 0) entries         = 1
  //
  // If aggregateRuns is ever changed to sum over merged items only, this
  // test fails loudly instead of silently agreeing with case 8's fixture.
  it('sums fixLoops and verification over ALL queued items, not merged ones only', () => {
    const run = archiveRun({
      status: 'done',
      queue: [
        archiveItem({
          id: 'bug-m1',
          stage: 'merged',
          fixLoops: 1,
          verification: [{ cmd: 'pnpm test', ok: true }],
          stageAt: { pending: at(0), merged: at(10_000) }
        }),
        archiveItem({
          id: 'bug-m2',
          stage: 'merged',
          fixLoops: 0,
          verification: [],
          stageAt: { pending: at(0), merged: at(20_000) }
        }),
        // Never merges — must still contribute to the "all items" sums
        // above, but must NOT count toward itemsMerged, the divisor for
        // both ratios.
        archiveItem({
          id: 'bug-unmerged',
          stage: 'failed',
          fixLoops: 5,
          verification: [
            { cmd: 'pnpm test', ok: true },
            { cmd: 'pnpm lint', ok: false }
          ],
          stageAt: { pending: at(0), dispatched: at(5_000), failed: at(30_000) }
        })
      ]
    });

    const result = aggregateRuns([run], T0);

    expect(result.itemsMerged).toBe(2);
    expect(result.fixLoopsPerMerged).toBe(3);
    expect(result.verifyPassRate).toBeCloseTo(2 / 3);
  });

  // Case 9: the empty-list floor. Every ratio is null (nothing to divide by)
  // rather than 0 or NaN — 0 would misreport "a 0% pass rate" for a run
  // history that simply does not exist yet.
  it('is all zeros and nulls for an empty run list', () => {
    const result = aggregateRuns([], T0);
    expect(result).toEqual({
      runs: 0,
      byStatus: { done: 0, failed: 0, running: 0, aborted: 0 },
      itemsMerged: 0,
      itemsQueued: 0,
      avgItemWallMs: null,
      fixLoopsPerMerged: null,
      verifyPassRate: null
    });
  });
});

// I5: a regex-shape assertion (`/^\d{4}-\d{2}-\d{2}$/`, `/^(mon|tue|...)...$/`)
// passes for a UTC implementation, a local one, a wrong day entirely, or a
// `WEEKDAYS`/`MONTHS` table with an off-by-one baked in — the classic bug for
// a hand-rolled `getDay()`/`getMonth()` lookup. The plan itself mandated
// exactly this regex (a "plans give test cases, not verbatim code" failure in
// miniature: the implementer transcribed a weak assertion because the plan
// supplied it literally), so the fix is here, not in the implementation.
//
// The construction below is timezone-independent WITHOUT re-implementing
// `dayKey`/`dayLabel`'s own local-time logic in the test: `new Date(2026, 8,
// 1, 12, 0, 0)` builds "September 1st, 2026, noon" in whatever timezone this
// process runs in — there is no real-world UTC offset (they all fall well
// inside +/-14h) that can push a LOCAL noon across a day boundary into Aug 31
// or Sep 2, so `.toISOString()` of that instant, read back by `dayKey`/
// `dayLabel` (both of which convert back to LOCAL components before
// formatting), reproduces the exact same local date this test built,
// regardless of which timezone the machine running it uses. The exact expected
// values (`'2026-09-01'`, `'tue 1 sep'`) are pinned against the real calendar
// (September 1st, 2026 is a Tuesday), not derived from `WEEKDAYS`/`MONTHS`
// themselves — which is exactly what lets an off-by-one in either table fail
// this test instead of silently agreeing with it.
const NOON_SEP_1_2026 = new Date(2026, 8, 1, 12, 0, 0).toISOString();

describe('dayKey', () => {
  it('formats a parseable stamp as a local YYYY-MM-DD key', () => {
    expect(dayKey(NOON_SEP_1_2026)).toBe('2026-09-01');
  });

  it('is null for a stamp that does not parse', () => {
    expect(dayKey('garbage')).toBeNull();
  });
});

describe('dayLabel', () => {
  it('formats a parseable stamp as "weekday day month", lowercase', () => {
    expect(dayLabel(NOON_SEP_1_2026)).toBe('tue 1 sep');
  });

  it('is null for a stamp that does not parse', () => {
    expect(dayLabel('garbage')).toBeNull();
  });
});
