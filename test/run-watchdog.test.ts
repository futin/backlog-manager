import {
  graceRemainingMs, isCrashed, stateLine, sweepFraction, watchdogClause,
  WATCHDOG_KIND_GLYPH, WATCHDOG_KIND_TONE
} from '../client/src/lib/run-watchdog';
import { DEFAULT_WATCHDOG_CONFIG } from '../shared/types';
import type { RunWatchdog, WatchdogEventKind, WatchdogStatus } from '../shared/types';

/**
 * A full `RunWatchdog`, overridden per case — the same "state everything a
 * case cares about, default the rest" shape this repo's other fixture
 * factories use (test/orchestrator-strip.test.tsx's own `queueItem`, e.g.).
 * The baseline reads as "just started watching, nothing has happened yet":
 * enabled, no attempts, no error, not exhausted.
 */
function watchdog(over: Partial<RunWatchdog> = {}): RunWatchdog {
  return {
    enabled: true, attempts: 0, maxAttempts: 2, lastSpawnAt: null,
    lastSessionId: null, lastError: null, exhausted: false,
    ...over
  };
}

describe('isCrashed', () => {
  // The four combinations of { status: running | done } x { fresh: true |
  // false } — true only for running+stale, matching `status === 'running'
  // && !fresh` exactly (OrchestratorRunsPayload's own doc comment names this
  // pair as the one case a watchdog record can exist for at all).
  it('reads false for a running run that is still fresh', () => {
    expect(isCrashed({ status: 'running', fresh: true })).toBe(false);
  });

  it('reads true for a running run that has gone stale', () => {
    expect(isCrashed({ status: 'running', fresh: false })).toBe(true);
  });

  it('reads false for a done run that happens to be fresh', () => {
    expect(isCrashed({ status: 'done', fresh: true })).toBe(false);
  });

  it('reads false for a done run that is stale', () => {
    // A finished run going stale is the ordinary end of every run ever
    // started, not a fault — the whole reason `isCrashed` exists is to tell
    // this apart from the genuinely crashed case directly above.
    expect(isCrashed({ status: 'done', fresh: false })).toBe(false);
  });
});

describe('watchdogClause', () => {
  it('reads the empty string when the run has never been a watchdog subject', () => {
    expect(watchdogClause(undefined)).toBe('');
  });

  it('reads "waiting for next check" before any attempt has been made', () => {
    expect(watchdogClause(watchdog())).toBe('watchdog: waiting for next check');
  });

  it('reads "attempt N/M spawned HH:MM" once a spawn has landed', () => {
    const lastSpawnAt = '2026-09-03T15:14:07Z';
    const clause = watchdogClause(watchdog({ attempts: 1, lastSpawnAt }));
    // Computed dynamically off the SAME instant, not a literal — a literal
    // would pin this suite to whatever timezone happened to write it. This
    // mirrors run-time.ts's own `formatClock`, the codebase's one local-time
    // formatter (hand-rolled there rather than `toLocaleTimeString` on
    // purpose, per that file's own comment, to keep the reading a fixed
    // zero-padded 24-hour width instead of a locale-dependent one) — the
    // implementation under test reuses that exact function, so the expected
    // value has to be built the same way to mean anything.
    const at = new Date(lastSpawnAt);
    const hh = `${at.getHours()}`.padStart(2, '0');
    const mm = `${at.getMinutes()}`.padStart(2, '0');
    expect(clause).toBe(`watchdog: attempt 1/2 spawned ${hh}:${mm}`);
  });

  it('reads "resume failed: <lastError>" when the last attempt was refused', () => {
    expect(watchdogClause(watchdog({ lastError: 'busy' }))).toBe('watchdog: resume failed: busy');
  });

  it('reports a failed FIRST attempt correctly: attempts still 0, lastError set', () => {
    // watchdog.service.ts's own spawn() never increments `attempts` on a
    // failed call ("a refused spawn started no session") — so this is a
    // real state, not a contradiction, and the failure must still win over
    // the "waiting for next check" reading attempts: 0 would otherwise imply.
    expect(watchdogClause(watchdog({ attempts: 0, lastError: 'dashboard down' })))
      .toBe('watchdog: resume failed: dashboard down');
  });

  it('reads "exhausted after N — resume by hand" once the cap is reached', () => {
    expect(watchdogClause(watchdog({ attempts: 2, maxAttempts: 2, exhausted: true })))
      .toBe('watchdog: exhausted after 2 — resume by hand');
  });

  it('reads "off — resume by hand" when disabled, even with a live attempt count', () => {
    // `enabled: false` must win over a live "attempt 1/2" reading — see
    // run-watchdog.ts's own header comment on why "off" outranks a pending
    // attempt.
    expect(watchdogClause(watchdog({ enabled: false, attempts: 1, lastSpawnAt: '2026-09-03T15:14:07Z' })))
      .toBe('watchdog: off — resume by hand');
  });

  it('reads "off — resume by hand" over a pending lastError too', () => {
    expect(watchdogClause(watchdog({ enabled: false, lastError: 'busy' })))
      .toBe('watchdog: off — resume by hand');
  });

  it('reads "exhausted" even when the sweeper has since been disabled', () => {
    // Exhaustion outranks everything, including `off` — re-enabling the
    // toggle would not resume trying, since the CAP is what stopped it.
    expect(watchdogClause(watchdog({ enabled: false, attempts: 2, maxAttempts: 2, exhausted: true })))
      .toBe('watchdog: exhausted after 2 — resume by hand');
  });
});

/**
 * A full `WatchdogStatus`, defaults everywhere a case does not care — the
 * same factory `test/settings-watchdog.test.tsx` carries, duplicated here
 * rather than exported from there because these cases MOVED out of that
 * suite (task-18 plan Task 1) and this file must not import from a
 * component suite to keep them running.
 */
function watchdogStatus(over: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return {
    phase: 'idle',
    nextTickAt: null,
    config: DEFAULT_WATCHDOG_CONFIG,
    watching: [],
    events: [],
    ...over
  };
}

/**
 * `stateLine` moved here from `WatchdogGroup.tsx` (task-18): it is the third
 * of the three watchdog sentences the client can print, and the Settings
 * group that used to own it no longer renders any of them — `WatchdogMonitor`
 * on Runs › Watchdog does. These cases came with it, verbatim in intent, and
 * gained the two `nextTickAt` degradation cases the Settings suite never
 * pinned.
 */
describe('stateLine', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');

  it('names the off reason', () => {
    expect(stateLine(watchdogStatus({ phase: 'off', reason: 'BM_WATCHDOG off' }), now))
      .toBe('off — BM_WATCHDOG off');
  });

  it('degrades a reasonless off to "unknown" rather than printing undefined', () => {
    expect(stateLine(watchdogStatus({ phase: 'off' }), now)).toBe('off — unknown');
  });

  it('reads idle with no suffix while resuming is enabled', () => {
    expect(stateLine(watchdogStatus({ phase: 'idle' }), now)).toBe('idle — no running run');
  });

  it('appends the resume-disabled suffix to idle', () => {
    expect(stateLine(
      watchdogStatus({ phase: 'idle', config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: false } }),
      now
    )).toBe('idle — no running run · resume disabled');
  });

  it('lists every watched run id and counts down to the next tick', () => {
    expect(stateLine(watchdogStatus({
      phase: 'armed',
      watching: ['run-a', 'run-b'],
      nextTickAt: new Date(now + 42_000).toISOString()
    }), now)).toBe('armed — watching run-a, run-b, next check in 42s');
  });

  it('appends the resume-disabled suffix to armed too', () => {
    expect(stateLine(watchdogStatus({
      phase: 'armed',
      watching: ['run-a', 'run-b'],
      nextTickAt: new Date(now + 42_000).toISOString(),
      config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: false }
    }), now)).toBe('armed — watching run-a, run-b, next check in 42s · resume disabled');
  });

  it('reads 0s rather than NaN when armed with no nextTickAt', () => {
    expect(stateLine(watchdogStatus({ phase: 'armed', watching: ['run-a'], nextTickAt: null }), now))
      .toBe('armed — watching run-a, next check in 0s');
  });

  it('clamps a nextTickAt already in the past to 0s, never a negative countdown', () => {
    expect(stateLine(watchdogStatus({
      phase: 'armed',
      watching: ['run-a'],
      nextTickAt: new Date(now - 5_000).toISOString()
    }), now)).toBe('armed — watching run-a, next check in 0s');
  });
});

/**
 * task-26's three readings — the same facts `stateLine` and `watchdogClause`
 * already state in words, expressed as numbers a meter can be drawn from.
 * Each takes an explicit `now` and returns `null` for input it cannot read,
 * so a caller never has to tell a guess from a measurement.
 */
describe('sweepFraction', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');

  /** Armed with an explicit tick length — the only phase that has a sweep to be partway through. */
  function armed(nextTickAt: string | null, tickMs: number): WatchdogStatus {
    return watchdogStatus({
      phase: 'armed',
      watching: ['run-a'],
      nextTickAt,
      config: { ...DEFAULT_WATCHDOG_CONFIG, tickMs }
    });
  }

  it('is the share of the tick still to come', () => {
    expect(sweepFraction(armed(new Date(now + 42_000).toISOString(), 60_000), now))
      .toBeCloseTo(0.7, 10);
  });

  // A tick the server owes us but has not run yet: the bar sits empty rather
  // than drawing backwards past its own track.
  it('clamps an overdue tick to 0 rather than going negative', () => {
    expect(sweepFraction(armed(new Date(now - 5_000).toISOString(), 60_000), now)).toBe(0);
  });

  // Neither phase has a next tick to be partway through: `idle` has nothing
  // to watch and `off` has no timer at all. `null`, so the caller draws no
  // bar rather than an empty one that would read as "a sweep is imminent".
  it('is null for every phase but armed', () => {
    expect(sweepFraction(watchdogStatus({ phase: 'idle' }), now)).toBeNull();
    expect(sweepFraction(watchdogStatus({ phase: 'off', reason: 'BM_AGENTS off' }), now)).toBeNull();
  });

  it('is null when armed without a readable nextTickAt', () => {
    expect(sweepFraction(armed(null, 60_000), now)).toBeNull();
    expect(sweepFraction(armed('garbage', 60_000), now)).toBeNull();
  });

  // A zero tick would divide by zero; a meter is not the place to discover
  // that a config field is nonsense.
  it('is null when the configured tick is not a positive length', () => {
    expect(sweepFraction(armed(new Date(now + 42_000).toISOString(), 0), now)).toBeNull();
  });
});

describe('graceRemainingMs', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  const config = { graceMs: 600_000 };

  it('counts down from the last spawn attempt', () => {
    expect(graceRemainingMs(watchdog({ lastSpawnAt: new Date(now - 120_000).toISOString() }), config, now))
      .toBe(480_000);
  });

  // Floored, never negative: a window that closed eight minutes ago is
  // simply closed, and the caller renders nothing at 0.
  it('floors an elapsed window at 0', () => {
    expect(graceRemainingMs(watchdog({ lastSpawnAt: new Date(now - 720_000).toISOString() }), config, now))
      .toBe(0);
  });

  // No attempt has been made, so no window has opened — distinct from 0,
  // which means one opened and closed.
  it('is null when nothing has been spawned yet', () => {
    expect(graceRemainingMs(watchdog({ lastSpawnAt: null }), config, now)).toBeNull();
  });

  it('is null for an unreadable spawn stamp', () => {
    expect(graceRemainingMs(watchdog({ lastSpawnAt: 'garbage' }), config, now)).toBeNull();
  });
});

describe('the kind records', () => {
  // The same mechanism `test/agents-shared.test.ts` uses for `RunStage`: a
  // `Record<WatchdogEventKind, true>` literal fails to compile the day an
  // eighth kind is added, so this suite cannot silently stop covering one.
  const every: Record<WatchdogEventKind, true> = {
    armed: true, idle: true, spawned: true, failed: true,
    exhausted: true, recovered: true, disabled: true
  };
  const kinds = Object.keys(every) as WatchdogEventKind[];

  it('gives every kind a glyph, and no two the same', () => {
    const glyphs = kinds.map((k) => WATCHDOG_KIND_GLYPH[k]);
    for (const g of glyphs) expect(g.length).toBeGreaterThan(0);
    expect(new Set(glyphs).size).toBe(kinds.length);
  });

  it('gives every kind a tone', () => {
    for (const k of kinds) expect(WATCHDOG_KIND_TONE[k]).toBeTruthy();
  });

  // The tones are meanings, not decoration: red is a failure, amber is the
  // two kinds that both end in "resume by hand", and the sweeper's own
  // breathing is muted so a busy feed still reads at a glance.
  it('tones a failure red and both resume-by-hand kinds amber', () => {
    expect(WATCHDOG_KIND_TONE.spawned).toBe('live');
    expect(WATCHDOG_KIND_TONE.recovered).toBe('done');
    expect(WATCHDOG_KIND_TONE.failed).toBe('bad');
    expect(WATCHDOG_KIND_TONE.exhausted).toBe('warn');
    expect(WATCHDOG_KIND_TONE.disabled).toBe('warn');
    expect(WATCHDOG_KIND_TONE.armed).toBe('muted');
    expect(WATCHDOG_KIND_TONE.idle).toBe('muted');
  });
});
