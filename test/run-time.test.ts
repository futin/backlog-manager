import {
  formatClock, formatSpan, formatSpanCompact, inStageMs, isTerminalStage,
  itemDoneClock, itemDurationMs, runElapsedMs, stepperDots, STEPPER_STAGES
} from '../client/src/lib/run-time';
import type { OrchestratorRun, RunQueueItem, RunStage } from '../shared/types';

/**
 * The derivations behind the run strip's and run drawer's time readings. Every
 * case here pins behaviour against a fixed `now` passed in, never the real
 * clock: these functions all default to `Date.now()` for their callers'
 * convenience, and a suite that leaned on that default would be timing-flaky
 * for no gain.
 */

/** An arbitrary but fixed instant, and the base every relative stamp below is built from. */
const T0 = Date.parse('2026-08-31T09:20:45Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** Just the two fields the item derivations read — never a whole RunQueueItem, which would bury them. */
function queueItem(stage: RunStage, stageAt: Partial<Record<RunStage, string>>): Pick<RunQueueItem, 'stage' | 'stageAt'> {
  return { stage, stageAt };
}

function run(over: Partial<OrchestratorRun & { fresh: boolean }> = {}) {
  return {
    status: 'running' as OrchestratorRun['status'],
    startedAt: at(0),
    updatedAt: at(0),
    fresh: true,
    ...over
  };
}

describe('formatSpan', () => {
  // The three rungs, at the exact values the task's brief names.
  it('formats seconds, minutes and hours at their own scale', () => {
    expect(formatSpan(42_000)).toBe('42s');
    expect(formatSpan(552_000)).toBe('9m 12s');
    expect(formatSpan(3_840_000)).toBe('1h 04m');
  });

  // The rung boundaries themselves, which is where an off-by-one hides: 59s
  // is still seconds, 60s is the first minute, 3599s is still minutes.
  it('switches rung on the whole unit, never before it', () => {
    expect(formatSpan(59_999)).toBe('59s');
    expect(formatSpan(60_000)).toBe('1m 00s');
    expect(formatSpan(3_599_000)).toBe('59m 59s');
    expect(formatSpan(3_600_000)).toBe('1h 00m');
  });

  // Zero-padding is the reason the remainder is formatted at all rather than
  // interpolated raw — see the function's own comment on column width.
  it('zero-pads the remainder so the reading keeps a stable width', () => {
    expect(formatSpan(62_000)).toBe('1m 02s');
    expect(formatSpan(3_720_000)).toBe('1h 02m');
  });

  // No real caller can reach these — every derivation returns null instead of
  // a bad number — but the guard is what keeps a future one from putting
  // `NaNs` on the board.
  it('floors a bad or negative input to 0s rather than rendering NaN', () => {
    expect(formatSpan(Number.NaN)).toBe('0s');
    expect(formatSpan(-5_000)).toBe('0s');
  });
});

describe('formatSpanCompact', () => {
  // The whole difference from formatSpan: the minutes rung drops its seconds,
  // because this is what the two live-ticking readings render and a
  // five-at-a-time jumping seconds counter reads as a glitch.
  it('drops the seconds remainder at the minutes rung', () => {
    expect(formatSpanCompact(552_000)).toBe('9m');
    expect(formatSpanCompact(38 * 60_000)).toBe('38m');
  });

  it('leaves the seconds and hours rungs exactly as formatSpan writes them', () => {
    expect(formatSpanCompact(42_000)).toBe('42s');
    expect(formatSpanCompact(3_840_000)).toBe('1h 04m');
  });
});

describe('formatClock', () => {
  // Local, not UTC — the opposite call from item-age.ts's date handling, for
  // the reason the function's own comment gives. Built from a locally
  // constructed Date so the expectation holds under any TZ the suite runs in.
  it('renders a stamp as local HH:MM, zero-padded', () => {
    const local = new Date(2026, 7, 31, 9, 5, 30);
    expect(formatClock(local.toISOString())).toBe('09:05');
  });

  it('returns null for an unparseable or absent stamp', () => {
    expect(formatClock('not-a-date')).toBeNull();
    expect(formatClock(undefined)).toBeNull();
  });
});

describe('isTerminalStage', () => {
  // The complement of RUN_CLAIMED_STAGES, asserted on both halves so a stage
  // moved between them fails here rather than silently changing what the
  // stepper rings and what the row measures against.
  it('names the six exits terminal and the eight in-pipeline stages not', () => {
    for (const stage of ['merged', 'failed', 'skipped', 'needs-answers', 'ungroomed', 'parked'] as const) {
      expect(isTerminalStage(stage)).toBe(true);
    }
    for (const stage of ['pending', 'preflight', 'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'] as const) {
      expect(isTerminalStage(stage)).toBe(false);
    }
  });
});

describe('runElapsedMs', () => {
  it('measures a live run against the wall clock', () => {
    expect(runElapsedMs(run({ status: 'running', fresh: true }), T0 + 552_000)).toBe(552_000);
  });

  it('measures a finished run startedAt → updatedAt, ignoring now', () => {
    const finished = run({ status: 'done', fresh: false, updatedAt: at(552_000) });
    expect(runElapsedMs(finished, T0 + 99_000_000)).toBe(552_000);
  });

  // A `running` run whose heartbeat went stale takes the frozen branch on
  // purpose: nobody knows whether that process is still working, so the last
  // confirmed heartbeat is the only honest end.
  it('freezes a stale running run at its last heartbeat rather than letting it grow', () => {
    const stale = run({ status: 'running', fresh: false, updatedAt: at(552_000) });
    expect(runElapsedMs(stale, T0 + 99_000_000)).toBe(552_000);
  });

  it('returns null for a malformed startedAt, and for a malformed updatedAt it needs', () => {
    expect(runElapsedMs(run({ startedAt: 'nonsense' }))).toBeNull();
    expect(runElapsedMs(run({ status: 'done', fresh: false, updatedAt: 'nonsense' }))).toBeNull();
  });
});

describe('itemDurationMs', () => {
  it('measures a terminal item from its first real stage to its terminal stamp', () => {
    const item = queueItem('merged', { dispatched: at(0), merged: at(552_000) });
    expect(itemDurationMs(item, T0 + 99_000_000)).toBe(552_000);
  });

  it('measures an active item against now', () => {
    const item = queueItem('reviewing', { dispatched: at(0), inspecting: at(60_000), reviewing: at(120_000) });
    expect(itemDurationMs(item, T0 + 300_000)).toBe(300_000);
  });

  /**
   * The judgement call this module exists to make, and the one thing a
   * literal reading of "earliest stageAt arrival" would have got wrong:
   * `orchestrate.mjs` stamps `pending` for EVERY queue item at init with the
   * same run-start timestamp, so counting from the earliest key would report
   * time-since-the-run-began for every row. On a serially worked queue that
   * makes the seventh item claim the whole run's duration as its own.
   */
  it('excludes the pending queue-wait stamp, so a row reports its own work, not the run', () => {
    const item = queueItem('merged', {
      pending: at(-2_400_000), // waited 40 minutes for its turn
      dispatched: at(0),
      merged: at(552_000)
    });
    expect(itemDurationMs(item, T0 + 99_000_000)).toBe(552_000);
  });

  // preflight is kept where pending is dropped: the gate check is work on
  // THIS item, and keeping it is what gives the two before-dispatch exits a
  // duration at all instead of a blank.
  it('counts from preflight for an item that exited before dispatch', () => {
    const item = queueItem('needs-answers', {
      pending: at(-2_400_000),
      preflight: at(0),
      'needs-answers': at(37_000)
    });
    expect(itemDurationMs(item, T0 + 99_000_000)).toBe(37_000);
  });

  it('returns null for an empty stageAt, and for one holding nothing but pending', () => {
    expect(itemDurationMs(queueItem('pending', {}), T0)).toBeNull();
    expect(itemDurationMs(queueItem('pending', { pending: at(-2_400_000) }), T0)).toBeNull();
  });

  // A terminal stage whose own key never landed (a run file resumed across a
  // crash, or hand-edited during a park) still reports the span it can prove,
  // rather than measuring a finished item against a clock that keeps running.
  it('falls back to the last known arrival for a terminal stage that never stamped itself', () => {
    const item = queueItem('failed', { dispatched: at(0), inspecting: at(300_000) });
    expect(itemDurationMs(item, T0 + 99_000_000)).toBe(300_000);
  });
});

describe('itemDoneClock', () => {
  it('renders the terminal stage arrival as local HH:MM', () => {
    const local = new Date(2026, 7, 31, 9, 59, 55);
    const item = queueItem('merged', { dispatched: at(0), merged: local.toISOString() });
    expect(itemDoneClock(item)).toBe('09:59');
  });

  // Unlike itemDurationMs there is no fallback here: "the last thing we heard"
  // is a different claim from "this is when it merged".
  it('returns null for an active row and for a terminal stage with no stamp of its own', () => {
    expect(itemDoneClock(queueItem('reviewing', { dispatched: at(0), reviewing: at(60_000) }))).toBeNull();
    expect(itemDoneClock(queueItem('failed', { dispatched: at(0), inspecting: at(300_000) }))).toBeNull();
  });
});

describe('inStageMs', () => {
  it('measures from the current stage arrival to now', () => {
    const item = queueItem('reviewing', { dispatched: at(0), reviewing: at(120_000) });
    expect(inStageMs(item, T0 + 300_000)).toBe(180_000);
  });

  it('returns null when the current stage has no stamp', () => {
    expect(inStageMs(queueItem('reviewing', { dispatched: at(0) }), T0 + 300_000)).toBeNull();
  });
});

describe('stepperDots', () => {
  it('covers the seven pipeline stages in order, and nothing else', () => {
    expect(STEPPER_STAGES).toEqual([
      'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging', 'merged'
    ]);
    expect(stepperDots(queueItem('pending', {})).map((d) => d.stage)).toEqual([...STEPPER_STAGES]);
  });

  it('rings the current stage of an active row, fills what it visited, leaves the rest hollow', () => {
    const item = queueItem('reviewing', { dispatched: at(0), inspecting: at(60_000), reviewing: at(120_000) });
    const byStage = Object.fromEntries(stepperDots(item).map((d) => [d.stage, d.state]));
    expect(byStage).toEqual({
      dispatched: 'filled', inspecting: 'filled', reviewing: 'current',
      fixing: 'hollow', verifying: 'hollow', merging: 'hollow', merged: 'hollow'
    });
  });

  /**
   * The reason `filled` is keyed on a stageAt entry rather than on position:
   * an item that merged with no fix loop has no `fixing` key, and that hollow
   * dot between two filled neighbours is the most useful thing the row says.
   */
  it('leaves a skipped stage hollow between filled neighbours rather than backfilling it', () => {
    const item = queueItem('merged', {
      dispatched: at(0), inspecting: at(60_000), reviewing: at(120_000),
      verifying: at(180_000), merging: at(240_000), merged: at(300_000)
    });
    const byStage = Object.fromEntries(stepperDots(item).map((d) => [d.stage, d.state]));
    expect(byStage.fixing).toBe('hollow');
    expect(byStage.verifying).toBe('filled');
    expect(byStage.merging).toBe('filled');
    // Terminal: no ring anywhere, the last dot reads like the six before it.
    expect(byStage.merged).toBe('filled');
  });

  it('rings nothing for a row that left the pipeline early, showing only how far it got', () => {
    const item = queueItem('parked', { dispatched: at(0), inspecting: at(60_000), parked: at(120_000) });
    const states = stepperDots(item).map((d) => d.state);
    expect(states).not.toContain('current');
    expect(states.filter((s) => s === 'filled')).toHaveLength(2);
  });

  it('labels a visited dot with its arrival time and a never-entered dot with the bare stage name', () => {
    const local = new Date(2026, 7, 31, 14, 31, 0);
    const item = queueItem('reviewing', { dispatched: at(0), inspecting: local.toISOString(), reviewing: at(120_000) });
    const dots = Object.fromEntries(stepperDots(item).map((d) => [d.stage, d.label]));
    expect(dots.inspecting).toBe('inspecting · 14:31');
    expect(dots.fixing).toBe('fixing');
  });
});
