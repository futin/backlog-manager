import {
  formatClock, formatSpan, formatSpanCompact, inStageMs, isTerminalStage,
  itemDoneClock, itemDurationMs, itemQueueWaitMs, runClockMs, runElapsedMs, runIsLive,
  stepperDots, STEPPER_STAGES
} from '../client/src/lib/run-time';
import { runWallMs } from '../client/src/lib/run-stats';
import { RUN_STALE_MS } from '../shared/types';
import type { OrchestratorRun, RunQueueItem, RunStage } from '../shared/types';

/**
 * The derivations behind the run strip's and run drawer's time readings. Every
 * case here pins behaviour against a fixed `now` passed in, never the real
 * clock — and for `itemDurationMs`/`inStageMs` there is no longer any other
 * option: bug-15 removed their `= Date.now()` defaults outright, because for
 * a run that has stopped the wall clock is the one instant that is always
 * wrong, and a default is what lets the next caller reach for it silently.
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

/**
 * bug-15's two new exports: the one question every item-level reading on a
 * run detail surface has to ask before it measures anything against `now`.
 *
 * `runIsLive` is deliberately DERIVED from `status` + `updatedAt` rather than
 * read off the live payload's own server-computed `fresh` flag (which is what
 * `runElapsedMs` above does): the Runs pane's authority can be an
 * `OrchestratorArchiveRun`, which carries no such field at all, and deriving
 * is also what makes the crashed-`running` case — a dead orchestrator's run
 * file frozen at `status: "running"` forever, this repo's "one run per
 * project" invariant — fall out for free rather than needing a second rule.
 */
describe('runIsLive', () => {
  // Strictly `<`, exactly like `orchestrate.mjs`'s own `isFresh` and the
  // server's `fresh` computation: a heartbeat exactly RUN_STALE_MS old reads
  // stale on every side rather than fresh on one and stale on another.
  it('treats a running run as live until its heartbeat is exactly RUN_STALE_MS old', () => {
    const running = { status: 'running' as const, updatedAt: at(0) };
    expect(runIsLive(running, T0 + RUN_STALE_MS - 1)).toBe(true);
    expect(runIsLive(running, T0 + RUN_STALE_MS)).toBe(false);
  });

  // The whole point of the fork: an exit status is not a heartbeat. A run
  // that aborted seconds ago is not live — nothing is working on it, however
  // recent its last write was.
  it('is false for every non-running status, however fresh the heartbeat', () => {
    for (const status of ['aborted', 'failed', 'done'] as const) {
      expect(runIsLive({ status, updatedAt: at(0) }, T0 + 5_000)).toBe(false);
    }
  });

  // An unparseable heartbeat is not evidence a process is alive — the same
  // call `heartbeat` (run-stats.ts) already makes for `runWallMs`.
  it('is false for a running run whose heartbeat will not parse', () => {
    expect(runIsLive({ status: 'running', updatedAt: 'nope' }, T0)).toBe(false);
  });
});

/**
 * The last instant a run can actually prove — the clock every item-level
 * reading on that run must be measured against instead of `now`.
 */
describe('runClockMs', () => {
  it('hands back the exact now it was given for a live run', () => {
    const now = T0 + 60_000;
    expect(runClockMs({ status: 'running', updatedAt: at(0) }, now)).toBe(now);
  });

  // The bug-15 fork, on both of the two shapes that produce it: a run that
  // exited, and a `running` run whose orchestrator is gone. Neither can
  // prove anything past its own last write.
  it('freezes a stopped run at its own last heartbeat, never at now', () => {
    expect(runClockMs({ status: 'aborted', updatedAt: at(455_500) }, T0 + 86_400_000)).toBe(T0 + 455_500);
    expect(runClockMs({ status: 'running', updatedAt: at(0) }, T0 + RUN_STALE_MS + 1)).toBe(T0);
  });

  // No honest instant at all: not live, and nothing parseable to freeze at.
  // `null`, which every caller already renders as nothing.
  it('is null for a stopped run whose heartbeat will not parse', () => {
    expect(runClockMs({ status: 'aborted', updatedAt: 'nope' }, T0)).toBeNull();
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

  /**
   * bug-15: a null clock is what a caller passes when the run holding this
   * item cannot prove any instant at all (`runClockMs` answered `null`).
   * Blanking the reading is the only honest answer for a still-moving item —
   * there is nothing to measure TO.
   */
  it('returns null for a non-terminal item measured against a null clock', () => {
    const item = queueItem('dispatched', { pending: at(0), dispatched: at(10_000) });
    expect(itemDurationMs(item, null)).toBeNull();
  });

  /**
   * ...and the terminal branch must survive that same null, because it never
   * reads the clock in the first place: the item's own two stamps prove this
   * span outright, and blanking it would lose a number nobody had to guess.
   */
  it('still reports a terminal item span against a null clock, from its own stamps', () => {
    const item = queueItem('merged', { dispatched: at(0), merged: at(552_000) });
    expect(itemDurationMs(item, null)).toBe(552_000);
  });
});

/**
 * The cross-surface rule bug-15 exists to enforce, pinned on the real run it
 * was filed from (`run-20260901-112035`, aborted, bug-2 frozen at
 * `dispatched`): no item's reading can honestly exceed its own run's wall
 * time. Before the fix this row read `now − preflight` — about 32 hours when
 * the bug was groomed, growing on every render — beside a pane header
 * correctly printing the run's own 7m 35s.
 */
describe('an aborted run\'s frozen item (bug-15 regression)', () => {
  const abortedRun = {
    status: 'aborted' as const,
    startedAt: '2026-09-01T11:20:35.499Z',
    updatedAt: '2026-09-01T11:28:10.999Z'
  };
  const frozenItem = queueItem('dispatched', {
    pending: '2026-09-01T11:20:35.499Z',
    preflight: '2026-09-01T11:20:46.414Z',
    dispatched: '2026-09-01T11:21:05.935Z'
  });

  // 11:20:46.414 (preflight, the first non-pending arrival) → 11:28:10.999
  // (the run's last heartbeat) = 444585ms, 7m 24s. The same number a day
  // later and a week later, because neither reading touches `now` any more.
  it('reads the same frozen span whenever the pane is opened', () => {
    for (const now of [Date.parse('2026-09-02T11:28:10.999Z'), Date.parse('2026-09-08T11:28:10.999Z')]) {
      expect(itemDurationMs(frozenItem, runClockMs(abortedRun, now))).toBe(444_585);
    }
  });

  // The invariant, not just the value — and asserted against `runWallMs`
  // itself (run-stats.ts, bug-14's function) rather than a hand-typed
  // constant, since the claim is about the two surfaces agreeing, not about
  // either number in isolation. Already correct for an `aborted` run today,
  // so this needs nothing from bug-14.
  it('never exceeds its own run wall time', () => {
    const now = Date.parse('2026-09-02T11:28:10.999Z');
    const item = itemDurationMs(frozenItem, runClockMs(abortedRun, now)) as number;
    const wall = runWallMs(abortedRun, now) as number;
    expect(wall).toBe(455_500);
    expect(item).toBeLessThanOrEqual(wall);
  });
});

describe('itemQueueWaitMs', () => {
  // Case 1: preflight is the earliest NON-pending arrival, so the wait is
  // measured to that stamp, not to whatever arrived after it (dispatched,
  // here) — the same "earliest real work" reading startedAtMs itself uses,
  // and preflight counts as real work for this same reason elsewhere in the
  // file (itemDurationMs keeps it for an identical reason).
  it('measures pending to the earliest non-pending arrival', () => {
    const item = { stageAt: { pending: at(0), preflight: at(15_000), dispatched: at(40_000) } };
    expect(itemQueueWaitMs(item)).toBe(15_000);
  });

  // Case 2: no preflight stamp at all — dispatched is then the earliest
  // non-pending arrival, so the wait is measured to it instead.
  it('measures pending to dispatched when there is no preflight stamp', () => {
    const item = { stageAt: { pending: at(0), dispatched: at(20_000) } };
    expect(itemQueueWaitMs(item)).toBe(20_000);
  });

  // Case 3: nothing has started yet — a pending-only item has not finished
  // waiting, so there is no honest wait to report.
  it('is null with only a pending stamp and nothing started yet', () => {
    const item = { stageAt: { pending: at(0) } };
    expect(itemQueueWaitMs(item)).toBeNull();
  });

  // Case 4: no pending stamp at all (a hand-edited or malformed file) leaves
  // nothing to measure the wait FROM.
  it('is null with no pending stamp to measure from', () => {
    const item = { stageAt: { dispatched: at(20_000) } };
    expect(itemQueueWaitMs(item)).toBeNull();
  });

  // Case 5: a corrupt pending stamp is the same fact as no pending stamp —
  // there is no honest instant to start measuring the wait from.
  it('is null when the pending stamp is unparseable', () => {
    const item = { stageAt: { pending: 'garbage', dispatched: at(20_000) } };
    expect(itemQueueWaitMs(item)).toBeNull();
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

  // bug-15: unlike `itemDurationMs` there is no branch here that can survive
  // a null clock — every reading this function makes is "until when", and a
  // stopped run with no provable instant has no answer to that.
  it('returns null outright for a null clock', () => {
    expect(inStageMs(queueItem('reviewing', { dispatched: at(0), reviewing: at(120_000) }), null)).toBeNull();
  });
});

describe('stepperDots', () => {
  it('covers the seven pipeline stages in order, and nothing else', () => {
    expect(STEPPER_STAGES).toEqual([
      'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging', 'merged'
    ]);
    expect(stepperDots(queueItem('pending', {}), true).map((d) => d.stage)).toEqual([...STEPPER_STAGES]);
  });

  it('rings the current stage of an active row, fills what it visited, leaves the rest hollow', () => {
    const item = queueItem('reviewing', { dispatched: at(0), inspecting: at(60_000), reviewing: at(120_000) });
    const byStage = Object.fromEntries(stepperDots(item, true).map((d) => [d.stage, d.state]));
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
    const byStage = Object.fromEntries(stepperDots(item, true).map((d) => [d.stage, d.state]));
    expect(byStage.fixing).toBe('hollow');
    expect(byStage.verifying).toBe('filled');
    expect(byStage.merging).toBe('filled');
    // Terminal: no ring anywhere, the last dot reads like the six before it.
    expect(byStage.merged).toBe('filled');
  });

  it('rings nothing for a row that left the pipeline early, showing only how far it got', () => {
    const item = queueItem('parked', { dispatched: at(0), inspecting: at(60_000), parked: at(120_000) });
    const states = stepperDots(item, true).map((d) => d.state);
    expect(states).not.toContain('current');
    expect(states.filter((s) => s === 'filled')).toHaveLength(2);
  });

  it('labels a visited dot with its arrival time and a never-entered dot with the bare stage name', () => {
    const local = new Date(2026, 7, 31, 14, 31, 0);
    const item = queueItem('reviewing', { dispatched: at(0), inspecting: local.toISOString(), reviewing: at(120_000) });
    const dots = Object.fromEntries(stepperDots(item, true).map((d) => [d.stage, d.label]));
    expect(dots.inspecting).toBe('inspecting · 14:31');
    expect(dots.fixing).toBe('fixing');
  });

  /**
   * bug-15's fourth state. A clock cannot fix this one — `current` is a
   * boolean CLAIM ("this is happening right now"), not a measurement — so the
   * caller has to say whether the run is live, and `live: false` demotes the
   * ring to `stalled`.
   *
   * Not to `filled`: filled means "visited and left behind", and the whole
   * hollow-between-filled design (see the case above) reads a filled node as
   * "went through cleanly". This item never left this stage. Demoting to
   * filled would swap one lie for a quieter one.
   */
  it('marks the stage a stopped run died on as stalled, leaving the rest of the row alone', () => {
    const item = queueItem('reviewing', { dispatched: at(0), inspecting: at(60_000), reviewing: at(120_000) });
    const byStage = Object.fromEntries(stepperDots(item, false).map((d) => [d.stage, d.state]));
    expect(byStage).toEqual({
      dispatched: 'filled', inspecting: 'filled', reviewing: 'stalled',
      fixing: 'hollow', verifying: 'hollow', merging: 'hollow', merged: 'hollow'
    });
  });

  // Nothing was `current` to demote: every stage of a merged row is either
  // visited or never entered, so a stopped run's finished rows read exactly
  // as they always have.
  it('marks nothing stalled on a row that finished before the run stopped', () => {
    const item = queueItem('merged', {
      dispatched: at(0), inspecting: at(60_000), reviewing: at(120_000),
      verifying: at(180_000), merging: at(240_000), merged: at(300_000)
    });
    expect(stepperDots(item, false).map((d) => d.state)).not.toContain('stalled');
  });
});
