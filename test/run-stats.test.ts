import {
  itemStageSpans, runWallMs, runStageTotals, sumStageTotals, MACHINE_STAGES,
  aggregateRuns, dayKey, dayLabel
} from '../client/src/lib/run-stats';
import { RUN_STALE_MS } from '../shared/types';
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

/** Just the one field itemStageSpans reads — never a whole RunQueueItem, which would bury it. */
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
    mergeMode: 'merge',
    mergeModeEffective: 'merge',
    mergeModeNote: null,
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

  // bug-14. A CRASHED orchestrator leaves run.json at `status: "running"`
  // forever (init refuses to overwrite one; recovery is --resume/--abort
  // only), and the archive serves that frozen file verbatim — so `status`
  // alone can never tell a live run from a dead one. Without the heartbeat
  // gate this reads the whole day-plus span to `now` and keeps growing on
  // every render. The direct analogue of runStageTotals' own "freezes a
  // crashed run's open span at its own last heartbeat" case below.
  it('freezes a crashed running run at its own last heartbeat', () => {
    const run = archiveRun({ status: 'running', startedAt: at(0), updatedAt: at(1_000_000) });
    expect(runWallMs(run, T0 + 1_000_000 + 24 * 60 * 60 * 1000)).toBe(1_000_000);
  });

  // The boundary reads STALE, matching the strict `<` the server itself
  // performs to compute the live payload's own `fresh` flag
  // (orchestrator.service.ts). Exactly RUN_STALE_MS since the heartbeat is
  // not fresh, so this freezes rather than ticking.
  it('treats a heartbeat exactly RUN_STALE_MS old as stale', () => {
    const run = archiveRun({ status: 'running', startedAt: at(0), updatedAt: at(1_000) });
    expect(runWallMs(run, T0 + 1_000 + RUN_STALE_MS)).toBe(1_000);
  });

  // An unparseable heartbeat is not evidence a process is alive, so it
  // cannot earn the `now`-ticking branch — and it leaves no honest instant
  // to freeze at either. `null`, the same "skip rather than fabricate" call
  // this module makes for every other corrupt stamp. Both callers already
  // degrade correctly on a null (RunRow renders no wall span; RunDetail
  // prints `started HH:MM` alone).
  it('is null for a running run whose updatedAt does not parse', () => {
    const run = archiveRun({ status: 'running', startedAt: at(0), updatedAt: 'garbage' });
    expect(runWallMs(run, T0 + 30_000)).toBeNull();
  });

  // The other half of the fork must survive the fix: a run whose heartbeat
  // is genuinely recent still measures against `now`, or the board would
  // freeze a live run at whatever its last write happened to be.
  it('still ticks against now for a genuinely live run', () => {
    const run = archiveRun({ status: 'running', startedAt: at(0), updatedAt: at(60_000) });
    expect(runWallMs(run, T0 + 65_000)).toBe(65_000);
  });
});

describe('MACHINE_STAGES', () => {
  // The seven stages that are the orchestrator actually working — never
  // `pending` (queue wait, not work) and never one of the six exits. Pinned
  // in this exact order because runStageTotals/aggregateRuns fixtures below
  // build their expectations by reasoning about this list positionally, the
  // same way STEPPER_STAGES (run-time.test.ts) is pinned for its callers.
  it('names the seven pipeline stages in pipeline order', () => {
    expect(MACHINE_STAGES).toEqual([
      'preflight', 'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'
    ]);
  });
});

describe('runStageTotals', () => {
  // Case 7 (rewritten): two items whose spans both include a `pending` leg
  // and a `dispatched` leg — the totals record must sum the `dispatched`
  // legs across items, and `pending` must be ABSENT from the result now
  // (not present at some summed value): pending is queue wait, not machine
  // time, and runStageTotals's whole job is to answer "where did the
  // orchestrator's OWN time go," not "how long did every item sit in the
  // queue before its turn." A stage neither item ever spanned (`merging`)
  // stays absent too, for the older reason this case always pinned —
  // Partial<Record<...>> is the whole point of the return type, and a
  // caller iterating Object.keys() should not see zero-value noise for a
  // stage nothing touched. Both items are `merged` (archiveItem's default
  // stage), so the extra `now` argument is inert here — pinning that is
  // exactly what this case's second assertion below is for.
  it('sums each MACHINE_STAGES span across every item, excluding pending', () => {
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
    expect(runStageTotals(run, T0)).toEqual({
      // item-a: dispatched 30_000 (pending's 10_000 leg is dropped)
      // item-b: dispatched 30_000 (pending's 20_000 leg is dropped)
      dispatched: 60_000
    });
    // now must not matter for two terminal (merged) items — same totals
    // however far past T0 the clock reads.
    expect(runStageTotals(run, T0 + 999_000)).toEqual({ dispatched: 60_000 });
  });

  // Case 9: a live item still inside the pipeline, in a RUNNING run. Its two
  // recorded spans (pending->dispatched, dispatched->fixing) contribute the
  // usual way, but being non-terminal it ALSO gets an open span for the
  // stage it is sitting in right now (fixing, from its own arrival to
  // `now`) — the "a live run's rollup must move" half of the behaviour:
  // without this, runStageTotals would freeze mid-run at whatever the last
  // completed span happened to be, understating the stage actually eating
  // time right now. `status: 'running'` is load-bearing here after fix
  // round 1 (below): without it this fixture would fall into the very next
  // case instead, which is this same fixture with the run stopped.
  it('adds an open span for a live item on top of its completed spans, in a running run', () => {
    const run = archiveRun({
      status: 'running',
      queue: [
        archiveItem({
          id: 'item-c',
          stage: 'fixing',
          stageAt: { pending: at(0), dispatched: at(10_000), fixing: at(30_000) }
        })
      ]
    });
    // pending->dispatched (10_000, dropped: pending) + dispatched->fixing
    // (20_000, kept) + fixing->now (90_000 - 30_000 = 60_000, open span)
    expect(runStageTotals(run, T0 + 90_000)).toEqual({ dispatched: 20_000, fixing: 60_000 });
  });

  // Fix round 1, Finding 1: the SAME live item as case 9 above, byte-for-byte,
  // except the run itself has already stopped (`aborted` here; `done` and
  // `failed` are the same case in different words). An archived run's item
  // frozen mid-stage is not "still happening" — it is the last thing that
  // happened before nobody was watching — so crediting `now - stamp` to it
  // would add however long it has been since the run stopped (hours, days,
  // however stale this archive read happens to be) as if the orchestrator
  // were still working it. Only the two closed spans survive; `fixing` is
  // absent entirely (not present at some frozen value) because its only
  // possible contribution was the open span this status gate now excludes.
  it('adds no open span at all for a non-running run, however far past its last stamp now is', () => {
    const run = archiveRun({
      status: 'aborted',
      queue: [
        archiveItem({
          id: 'item-c',
          stage: 'fixing',
          stageAt: { pending: at(0), dispatched: at(10_000), fixing: at(30_000) }
        })
      ]
    });
    expect(runStageTotals(run, T0 + 90_000)).toEqual({ dispatched: 20_000 });
  });

  // Fix round 1, Finding 2: an item that RE-ENTERED its current stage after a
  // fix loop — dispatched -> reviewing (T1) -> fixing (T2) -> back to
  // reviewing now, with no fresh `stageAt.reviewing` key for the second visit
  // (stageAt records first arrivals only). `stageAt.reviewing` is therefore
  // STALE: it still points at T1, which is chronologically before `fixing`'s
  // own later arrival (T2). Naively opening the live span at that stale T1
  // would credit the whole T1-to-now interval to `reviewing` — but the T1-to-
  // T2 portion of that interval is ALREADY counted once, as the closed
  // `reviewing` span `itemStageSpans` produces from the T1/T2 stamps
  // themselves. Opening the live span from `max(latest arrival, T1)` = T2
  // instead measures only the genuinely uncounted tail (T2 to now), so
  // `reviewing`'s total is `(T2-T1) + (now-T2)` exactly once — not the
  // `(T2-T1) + (now-T1)` a stale-stamp reading would produce, which is
  // `(T2-T1)` bigger than the truth: T1-to-T2 double-counted.
  it('does not double-count a re-entered stage: the open span starts from the item\'s latest arrival, not the stale first one', () => {
    const run = archiveRun({
      status: 'running',
      queue: [
        archiveItem({
          id: 'item-f',
          stage: 'reviewing',
          stageAt: {
            pending: at(0),
            dispatched: at(10_000),
            reviewing: at(20_000), // T1: stale — first arrival only, second visit unstamped
            fixing: at(50_000) // T2: chronologically AFTER the stale reviewing stamp
          }
        })
      ]
    });

    // now = T0 + 80_000, i.e. 30_000ms past T2.
    //   closed spans:  dispatched 10_000 (dispatched->reviewing), reviewing 30_000 (reviewing->fixing, T2-T1)
    //   correct open:  reviewing += now-T2  = 30_000  =>  reviewing total 60_000
    //   buggy open:    reviewing += now-T1  = 60_000  =>  reviewing total 90_000 (T1->T2 double-counted)
    expect(runStageTotals(run, T0 + 80_000)).toEqual({ dispatched: 10_000, reviewing: 60_000 });
  });

  // Fix round 2 (final-review wave, Important 1): a CRASHED run — `status`
  // still `"running"` forever, because `orchestrate.mjs init` refuses to
  // overwrite a run file already at that status, and recovery is only
  // `--resume`/`--abort` (this repo's own "One run per project, checked
  // twice" invariant) — whose last heartbeat (`updatedAt`) is long past
  // `RUN_STALE_MS`. `status === 'running'` alone used to be enough to open a
  // live span (case 9 above proves the run-level gate is needed AT ALL, and
  // remains true — a fresh `running` run still ticks to `now` there); this
  // case proves the gate ALSO needs `updatedAt`'s own freshness, the same
  // fork `runElapsedMs` (run-time.ts) already makes for a shape with a real
  // `fresh` flag of its own. The item's open span must freeze at
  // `updatedAt`, never grow to `now` — otherwise the exact unbounded-span
  // defect the status-only gate was built to prevent in fix round 1
  // reappears through the one door that gate left open: a process nobody
  // has heard from in hours still reporting `status: "running"` on disk.
  it("freezes a crashed run's open span at its own last heartbeat, not now", () => {
    const run = archiveRun({
      status: 'running',
      startedAt: at(0),
      updatedAt: at(1_000_000), // last heartbeat, ~16.7 minutes after start
      queue: [
        archiveItem({
          id: 'item-g',
          stage: 'fixing',
          stageAt: { pending: at(0), dispatched: at(10_000), fixing: at(30_000) }
        })
      ]
    });

    // now is a full day past the run's last heartbeat — an archive read long
    // after a crash, not a slow poll tick that just missed one beat.
    const now = T0 + 1_000_000 + 24 * 60 * 60 * 1000;

    // dispatched->fixing (20_000, kept — unaffected by this fix) + fixing's
    // open span FROZEN at updatedAt (1_000_000 - 30_000 = 970_000), never
    // reaching the real `now` this test passes in.
    expect(runStageTotals(run, now)).toEqual({ dispatched: 20_000, fixing: 970_000 });
  });

  // Companion to the case above: an `updatedAt` that will not parse reads as
  // NOT fresh (an unparseable heartbeat is not evidence a process is still
  // alive — it cannot earn the `now`-ticking branch) but also leaves no
  // honest instant to freeze the open span AT, so the item's open span
  // contributes nothing at all rather than fabricating one — only its
  // closed spans stand. Pinned as its own case because "not fresh" and
  // "frozen at updatedAt" are two different claims a single corrupt-heartbeat
  // fixture tells apart: this run must fall into neither the fresh branch
  // nor the frozen-number branch above.
  it('adds no open span at all when the heartbeat itself will not parse', () => {
    const run = archiveRun({
      status: 'running',
      startedAt: at(0),
      updatedAt: 'garbage',
      queue: [
        archiveItem({
          id: 'item-h',
          stage: 'fixing',
          stageAt: { pending: at(0), dispatched: at(10_000), fixing: at(30_000) }
        })
      ]
    });

    expect(runStageTotals(run, T0 + 90_000)).toEqual({ dispatched: 20_000 });
  });

  // Case 10: an item that left the pipeline through a non-merge exit
  // (`parked`), in a running run. Its one completed span (pending->dispatched)
  // is dropped for the pending reason as always, but — unlike case 9 — it
  // gets NO open span for `parked`: `parked` is not in MACHINE_STAGES at all
  // (it is an exit, not a place the orchestrator is working), and
  // isTerminalStage would also refuse it a live span even if it were. Both
  // guards land on the same fixture on purpose, so a future change that
  // drops either one still fails this case. `status: 'running'` is set
  // explicitly (rather than left at archiveRun's 'done' default) so this
  // case keeps pinning the ITEM-terminality guard specifically, not the
  // run-status guard fix round 1 added above — a 'done' run would exclude
  // the open span for a completely different reason and this case would
  // stop testing what its own name says it tests.
  it('excludes a terminal-labelled span and adds no open span for a terminal item', () => {
    const run = archiveRun({
      status: 'running',
      queue: [
        archiveItem({
          id: 'item-d',
          stage: 'parked',
          stageAt: { pending: at(0), dispatched: at(10_000), parked: at(30_000) }
        })
      ]
    });
    expect(runStageTotals(run, T0 + 999_000)).toEqual({ dispatched: 20_000 });
  });

  // `branched` is the OTHER terminal success exit (branch mode), and it must
  // be excluded from every open-span guard exactly the way `merged` already
  // is: it is not in MACHINE_STAGES, and isTerminalStage refuses it a live
  // span even in a running run. This mirrors case 10's `parked` fixture
  // above (both guards land on the same shape of fixture on purpose), but is
  // pinned separately because `branched` is a SUCCESS exit — the design's
  // whole reason to add a second terminal stage rather than reuse `merged` —
  // and case 10 alone would leave that half of the partition unexercised.
  it('adds no open span for an item that reached the branch-mode success exit', () => {
    const run = archiveRun({
      status: 'running',
      queue: [
        archiveItem({
          id: 'item-branch',
          stage: 'branched',
          stageAt: { pending: at(0), dispatched: at(10_000), branched: at(30_000) }
        })
      ]
    });
    const result = runStageTotals(run, T0 + 999_000);
    expect(result).not.toHaveProperty('branched');
    expect(result).toEqual({ dispatched: 20_000 });
  });

  // Case 11: a live item whose CURRENT stage is `pending` itself — still
  // queued, not yet dispatched at all, in a running run (see case 10's own
  // comment for why `status: 'running'` is set explicitly here too). It has
  // no completed spans (a single stamp cannot span anything) and earns no
  // open span either, because `pending` fails the
  // `MACHINE_STAGES.includes(item.stage)` half of the open-span guard even
  // though it passes both `!isTerminalStage` and `status === 'running'`. The
  // result is the empty record, not `{ pending: ... }` — the whole point of
  // this module is that a queued item contributes nothing to "where did the
  // orchestrator's time go" until it actually starts.
  it('is empty for a live item still sitting in pending', () => {
    const run = archiveRun({
      status: 'running',
      queue: [archiveItem({ id: 'item-e', stage: 'pending', stageAt: { pending: at(0) } })]
    });
    expect(runStageTotals(run, T0 + 999_000)).toEqual({});
  });
});

describe('sumStageTotals', () => {
  it('is the empty record for an empty list', () => {
    expect(sumStageTotals([])).toEqual({});
  });

  // Field-wise sum: a stage present in only one operand (fixing) still
  // shows up in the result, and a stage present in both (dispatched) adds
  // rather than overwrites.
  it('sums corresponding stages across a list of totals, keeping stages unique to one', () => {
    expect(sumStageTotals([
      { dispatched: 1_000, fixing: 500 },
      { dispatched: 2_000 }
    ])).toEqual({ dispatched: 3_000, fixing: 500 });
  });
});

describe('aggregateRuns', () => {
  // Case 8: three runs standing in for the whole tile row at once — one
  // finished run with two merges and a fix loop on each, one failed run that
  // merged only one of its two items, one still-running run that has merged
  // nothing yet. Every stamp below is a round number chosen so the average
  // work time comes out exact rather than needing toBeCloseTo.
  //
  // Each merged item's `dispatched` stamp lands exactly 50s after its OWN
  // `pending` — pinning the queue-wait exclusion this whole task exists for.
  // Read against `itemDurationMs`, "50s after pending" makes each item's new
  // work time exactly 50s shorter than the OLD first-to-last reading
  // (itemWallMs, pending included) would have said — see the per-item
  // comments below and the final assertion for the arithmetic. bug-2's
  // `dispatched` is `at(250_000)`, not the `at(50_000)` bug-1/bug-3 use,
  // because bug-2's own `pending` is not at T0 — "50s after pending" is the
  // invariant every item shares, not a common absolute offset.
  it('aggregates counts, fix-loop cost, verification pass rate and average work time across runs', () => {
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
          // old wall (pending->merged) 100_000; new work (dispatched->merged) 50_000
          stageAt: { pending: at(0), dispatched: at(50_000), merged: at(100_000) }
        }),
        archiveItem({
          id: 'bug-2',
          stage: 'merged',
          fixLoops: 2,
          verification: [
            { cmd: 'pnpm test', ok: true },
            { cmd: 'pnpm lint', ok: false }
          ],
          // old wall 200_000; new work 150_000 (dispatched is pending + 50s)
          stageAt: { pending: at(200_000), dispatched: at(250_000), merged: at(400_000) }
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
          // old wall 300_000; new work 250_000
          stageAt: { pending: at(0), dispatched: at(50_000), merged: at(300_000) }
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
    // (50_000 + 150_000 + 250_000) / 3 merged items with a known work time.
    // The OLD rule (itemWallMs, queue wait folded in) would read this exact
    // fixture as (100_000 + 200_000 + 300_000) / 3 = 200_000 instead — the
    // 50_000ms gap between the two numbers is exactly the 50s this fixture
    // shaved off each of the three items' dispatched stamps, and is the one
    // thing in this suite that would silently keep passing at the OLD
    // number if the queue-wait exclusion this task adds were ever lost.
    expect(result.avgItemWorkMs).toBe(150_000);
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

  // Case 14: the queue-wait exclusion at its starkest — a single merged item
  // that waited a full hour in the queue (pending -> preflight) but only
  // took a minute of actual work (preflight -> merged). The OLD rule
  // (itemWallMs, pending included) would read this item's own wall time as
  // 3_660_000ms (61 minutes) and report that as the average of one; the new
  // rule reports 60_000ms (the one minute of real work), because
  // itemDurationMs's whole reason for existing is dropping exactly the
  // `pending` leg this fixture makes an hour long. This is the real-run
  // failure mode named in run-stats.ts's own file header (bug-7 reading 161m
  // in the pane vs 25m in the drawer) reproduced as a single deterministic
  // case, not just an aggregate arithmetic coincidence like case 8 above.
  it('avg item work excludes queue wait', () => {
    const run = archiveRun({
      status: 'done',
      queue: [
        archiveItem({
          id: 'bug-slow-queue',
          stage: 'merged',
          stageAt: { pending: at(0), preflight: at(3_600_000), merged: at(3_660_000) }
        })
      ]
    });

    const result = aggregateRuns([run], T0);

    expect(result.avgItemWorkMs).toBe(60_000);
  });

  // Design spec §4's own classification table (docs/superpowers/specs/
  // 2026-09-04-orchestrator-merge-mode-design.md): "aggregateRuns | counted
  // as completed, alongside merged." A branch-mode run's item that reached a
  // reviewed branch is exactly as finished as one that reached `main` — this
  // pins that `itemsMerged` (the run-level "completed" count) treats the two
  // success exits as interchangeable. Mixed with one genuine non-completion
  // (`parked`) so the count cannot pass by coincidentally counting the whole
  // queue.
  it('counts branched items as completed, alongside a non-completed parked one', () => {
    const run = archiveRun({
      status: 'done',
      queue: [
        archiveItem({ id: 'b-1', stage: 'branched', stageAt: { pending: at(0), branched: at(10_000) } }),
        archiveItem({ id: 'b-2', stage: 'branched', stageAt: { pending: at(0), branched: at(10_000) } }),
        archiveItem({ id: 'b-3', stage: 'branched', stageAt: { pending: at(0), branched: at(10_000) } }),
        archiveItem({ id: 'b-4', stage: 'parked', stageAt: { pending: at(0), parked: at(10_000) } })
      ]
    });
    expect(aggregateRuns([run], T0).itemsMerged).toBe(3);
  });

  // The two success exits sum into the SAME count, not two separate ones —
  // a run mixing merge-mode and branch-mode completions (e.g. one degraded
  // mid-queue per the design's §5.2) must not undercount its own progress.
  it('sums merged and branched items into one completed count', () => {
    const run = archiveRun({
      status: 'done',
      queue: [
        archiveItem({ id: 'm-1', stage: 'merged', stageAt: { pending: at(0), merged: at(10_000) } }),
        archiveItem({ id: 'm-2', stage: 'merged', stageAt: { pending: at(0), merged: at(10_000) } }),
        archiveItem({ id: 'b-1', stage: 'branched', stageAt: { pending: at(0), branched: at(10_000) } }),
        archiveItem({ id: 'b-2', stage: 'branched', stageAt: { pending: at(0), branched: at(10_000) } })
      ]
    });
    expect(aggregateRuns([run], T0).itemsMerged).toBe(4);
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
      avgItemWorkMs: null,
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
