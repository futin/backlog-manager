import { watchdogExhausted } from '../../shared/agent';
import type { RunWatchdog } from '../../shared/types';

/**
 * The one table of watchdog states both halves of the Resume coupling are
 * driven from — `test/watchdog-coupling.test.tsx` (the board's crashed strip)
 * and `test/watchdog-sweep.test.ts`'s own table case (the sweeper's per-run
 * pass).
 *
 * **Why this is shared, against this repo's usual "every suite owns its
 * fixtures" convention** (stated at length in `test/orchestrator-strip.test.tsx`
 * and honoured everywhere else): the thing under test here is not a shape, it
 * is an AGREEMENT between two components that live in different jest
 * environments — a React tree in jsdom, and a Nest app in node — and can
 * therefore never be asserted inside one `it`. Two copies of the table would
 * be two copies of the rule, which is precisely the defect this file exists
 * to prevent: the board renders a Resume control exactly when the sweeper
 * will NOT spawn a resume of its own, and nothing else stops a click and a
 * tick from both driving `--resume` into one `run.json`. A row that says
 * "stands down" to one suite and something else to the other would be the
 * bug wearing a green test suite, which is exactly what the branch shipped
 * with before the whole-branch review found it (widening the strip's
 * condition to `canResume === true` left all 1102 tests passing).
 *
 * `standsDown` is written out per row rather than computed, deliberately.
 * Deriving it would make both suites assert only that the two sides agree
 * with `watchdogStoodDown`, which a `watchdogStoodDown` that returned a
 * constant would also satisfy — both sides would move together and stay
 * "coupled" while saying something false. The literal is the third leg: the
 * predicate itself is pinned against a hand-checked verdict, and the two
 * implementations are pinned against the predicate.
 */
export interface CouplingRow {
  /** Reads as the jest case title (`$name`). */
  name: string;
  /** `WatchdogConfig.enabled` — the user's Settings toggle. In both suites the
   *  two env gates (`BM_AGENTS`, `BM_WATCHDOG`) are on/absent, so this is the
   *  whole of `spawningEnabled()` and the whole of the wire's
   *  `RunWatchdog.enabled`. */
  configEnabled: boolean;
  /** Resume sessions the sweeper has actually started for this run. */
  attempts: number;
  /** The cap those attempts are measured against — `WatchdogConfig.maxAttempts`,
   *  which a person can move in Settings at any time, which is the entire
   *  reason `exhausted` may not be stored. */
  maxAttempts: number;
  /**
   * Hand-checked: does the sweeper's next tick decline to spawn for this
   * state, and does the board therefore offer a Resume control? One answer,
   * asserted against both sides.
   */
  standsDown: boolean;
}

export const COUPLING_ROWS: readonly CouplingRow[] = [
  // Still trying: the sweeper has not spawned yet, so grace is not holding it
  // back either — it spawns, and a Resume button would be the second spawn.
  { name: 'enabled, nothing spent yet', configEnabled: true, attempts: 0, maxAttempts: 2, standsDown: false },
  // Mid-cap: one attempt made, one left. Same answer, and the state the
  // strip's "attempt 1/2 spawned" clause describes.
  { name: 'enabled, one attempt of two spent', configEnabled: true, attempts: 1, maxAttempts: 2, standsDown: false },
  // The cap, exactly reached — the state that renders "exhausted after 2 —
  // resume by hand", which is the sentence the Resume control belongs to.
  { name: 'enabled, cap reached', configEnabled: true, attempts: 2, maxAttempts: 2, standsDown: true },
  // Past the cap: reachable by LOWERING "Give up after" while a run is
  // crashed, so `>=` rather than `===` is the comparison that matters.
  { name: 'enabled, cap lowered below attempts already spent', configEnabled: true, attempts: 3, maxAttempts: 2, standsDown: true },
  // The user's toggle off. Watching continues and the crashed run is still
  // reported; only the spawn is withheld, which is what makes the strip's
  // "off — resume by hand" an honest offer rather than a race.
  { name: 'watchdog off, nothing spent', configEnabled: false, attempts: 0, maxAttempts: 2, standsDown: true },
  // Both at once: still one answer, and the sweeper logs `disabled` rather
  // than `exhausted` for it (off is reported ahead of the cap — see
  // `visit()`).
  { name: 'watchdog off and cap reached', configEnabled: false, attempts: 2, maxAttempts: 2, standsDown: true },
  // **The row the whole-branch review's Critical was about.** A run that was
  // exhausted at `maxAttempts: 1` and whose operator then did the obvious
  // thing the strip invited — raised "Give up after" — is NOT exhausted any
  // more. The sweeper re-derives that from the config it reads fresh every
  // tick and starts spawning again, so the board must stop offering the
  // button in the same instant. It did not, for as long as `exhausted` was a
  // flag written once and never cleared.
  { name: 'enabled, cap raised above the attempts already spent', configEnabled: true, attempts: 1, maxAttempts: 3, standsDown: false }
];

/**
 * The row as the board actually receives it — the `RunWatchdog` record
 * `WatchdogStateService.annotate()` builds for a crashed run in this state.
 * `exhausted` goes through `watchdogExhausted`, the same one-line derivation
 * `annotate()` and the sweeper both use, so this helper cannot become a third
 * copy of the rule; `standsDown` on the row is what keeps that derivation
 * itself honest.
 *
 * The three fields no row varies (`lastSpawnAt`, `lastSessionId`,
 * `lastError`) are zeroed: none of them takes part in the coupling, and
 * varying them would only invite a reader to think one of them does.
 */
export function rowWatchdog(row: CouplingRow): RunWatchdog {
  return {
    enabled: row.configEnabled,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastSpawnAt: null,
    lastSessionId: null,
    lastError: null,
    exhausted: watchdogExhausted(row.attempts, row.maxAttempts)
  };
}
