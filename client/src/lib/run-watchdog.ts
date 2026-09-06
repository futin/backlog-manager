import { formatClock } from './run-time';
import type {
  OrchestratorRun, RunWatchdog, WatchdogConfig, WatchdogEventKind, WatchdogStatus
} from '../../../shared/types';

/**
 * run-watchdog.ts — every sentence the client can print about the watchdog,
 * in one module: "is this run crashed at all" (`isCrashed`), "what is the
 * watchdog doing about THIS run, in one sentence" (`watchdogClause`), and
 * "what is the sweeper itself doing right now" (`stateLine`).
 *
 * task-26 added the readings that are not sentences: `sweepFraction` and
 * `graceRemainingMs`, plus the `WATCHDOG_KIND_GLYPH`/`WATCHDOG_KIND_TONE`
 * records the activity badges read. They live here for the reason the three
 * sentences do — they are statements about the sweeper, two surfaces may
 * come to read them, and the day a second one does it must not be able to
 * derive a different number from the same payload.
 *
 * Two surfaces read them, and that is why all three live together rather
 * than beside whichever component happened to need one first: `RunStrip`
 * (the board's crashed strip) reads the first two, and `WatchdogMonitor`
 * (Runs › Watchdog, task-18) reads all three. `stateLine` in particular
 * spent its first life as a private function inside the Settings watchdog
 * group; when that group's live half moved to Runs it would otherwise have
 * been a component importing a sentence out of another component, on a page
 * that no longer prints it at all.
 *
 * Both exist because of `run-20260903-112622` (design doc's own "Why this
 * exists"): a run whose headless session quit believing it was waiting on a
 * `sleep` left `run.json` frozen at `status: "running"`, went stale at
 * 15:13, and `RunStrip.tsx` rendered nothing for it — the board's only
 * window onto that run vanished for four hours, at exactly the moment a
 * person most needed it to say something. A human reading that file's OLD
 * doc comment would have agreed silence was the right call: a stale run's
 * reported stage cannot be trusted, since nothing here can tell "the run is
 * still exactly where it last reported" from "it moved three more stages
 * and we simply stopped hearing about it". That reasoning about the STAGE
 * was correct. The conclusion drawn from it — that the whole strip must
 * therefore say NOTHING — was not: "no heartbeat for 4h" is a fact this
 * payload can state without guessing, the entire time.
 *
 * `isCrashed` is the one place the split that fixes this gets decided, so
 * `RunStrip`, `BoardView` and `WatchdogMonitor` read the same verdict
 * rather than each re-deriving
 * `status === 'running' && !fresh` by hand and drifting apart the day one
 * of them forgets the `!fresh` half. A run that finished — however long
 * ago, whatever `status` it finished with — still renders nothing; that
 * silence is not a fault being hidden, it is the ordinary end of every run
 * that ever ran. Only `status === 'running' && !fresh` — heartbeat gone
 * quiet while the run file still claims to be working — is the fault this
 * feature exists to stop hiding.
 *
 * `watchdogClause` is the strip's one voice for the sweeper's own state
 * (design §2's `WatchdogEntry`, surfaced to the client as `RunWatchdog`),
 * collapsed to exactly one of five sentences so two surfaces reading the
 * same record can never disagree about which one applies — each `if` below
 * returns before the next is even evaluated, so the five are mutually
 * exclusive by construction, not by the caller's discipline. The order
 * encodes one deliberate ranking, and it is worth stating why in full:
 *
 * `exhausted` outranks everything, including `!enabled` — once a run has
 * burned through every attempt `maxAttempts` allows, flipping the toggle
 * back on would not resume trying (the CAP stopped it, not the toggle), so
 * the more specific and more permanent fact wins over the more general one.
 *
 * `!enabled` ("off") outranks a live, in-progress attempt reading
 * (`attempts > 0`, no error yet) for the opposite reason: an operator who
 * just switched the sweeper off is not owed a stale "attempt 1/2" clause
 * that implies a second try might still land on its own. Nothing will spawn
 * again until the toggle moves back, and the clause has to say that
 * plainly rather than let a reader wait on a spawn the toggle already
 * cancelled — this is the same asymmetry Step 3 of the brief this file
 * implements calls out by name: off outranks a pending attempt, but not
 * exhaustion.
 *
 * A non-null `lastError` is checked ahead of the plain attempt-count
 * reading for a reason rooted in `watchdog.service.ts`'s own `spawn()`:
 * a failed call never increments `attempts` (the comment there is explicit —
 * "a refused spawn started no session"), so `attempts: 0, lastError: 'busy'`
 * is a perfectly real state, not a contradiction to guard against: it is the
 * very first attempt having been refused. The failure is always the more
 * informative thing to report about the LAST thing that happened, whatever
 * the count itself reads.
 */
export function isCrashed(run: { status: OrchestratorRun['status']; fresh: boolean }): boolean {
  return run.status === 'running' && !run.fresh;
}

/**
 * `w` is `undefined` for exactly the reason `OrchestratorRunsPayload`'s own
 * doc comment gives: this run has never actually been a watchdog subject,
 * which can only be true in the narrow window between a run first going
 * crashed and the server's next annotation pass. Returning `''` instead of
 * guessing ("off"? "waiting"?) is the same call this file's own header
 * describes the OLD `RunStrip` making for a whole stale strip, kept here for
 * the one field that can still be genuinely unknown even after this feature
 * exists — a caller renders nothing for an empty string exactly as it
 * always has for a `null`.
 *
 * `now` is accepted (and defaulted to the real clock) for the same reason
 * every "describe a moment in time" function in this codebase does —
 * `elapsedSince` (item-age.ts) is the precedent — even though none of the
 * five phrasings below actually read it: the one that touches a clock at
 * all (`lastSpawnAt`) prints its own absolute wall time via `formatClock`,
 * not an age relative to now. Keeping the parameter is what lets a later
 * phrasing (say, "spawned Nm ago") add a relative reading without a
 * signature change breaking every caller that already has one pinned.
 */
export function watchdogClause(w: RunWatchdog | undefined, now: number = Date.now()): string {
  void now;

  if (w === undefined) return '';
  if (w.exhausted) return `watchdog: exhausted after ${w.attempts} — resume by hand`;
  if (!w.enabled) return 'watchdog: off — resume by hand';
  if (w.lastError !== null) return `watchdog: resume failed: ${w.lastError}`;
  if (w.attempts > 0) {
    const clock = w.lastSpawnAt === null ? null : formatClock(w.lastSpawnAt);
    return clock === null
      ? `watchdog: attempt ${w.attempts}/${w.maxAttempts} spawned`
      : `watchdog: attempt ${w.attempts}/${w.maxAttempts} spawned ${clock}`;
  }
  return 'watchdog: waiting for next check';
}

/**
 * The monitor's state card first line — the sweeper's own phase in one
 * sentence, as opposed to `watchdogClause` above, which describes what the
 * sweeper is doing about ONE crashed run. Lives here, beside its two
 * siblings, because all three are sentences the client prints about the
 * watchdog and two surfaces printing the same fact must not be able to
 * disagree about the wording (task-18; it was `WatchdogGroup.tsx`'s private
 * function while Settings was the only place any of this rendered).
 *
 * Pure and exported so it can be unit-tested directly, independent of
 * `useWatchdog`'s render timing (the `armed` countdown is the one reading
 * that moves on its own, and pinning it through a full component render
 * means fighting real wall-clock time or fake timers either way; this
 * function lets the countdown math be pinned once, exactly, against an
 * explicit `now`).
 *
 * The three phase branches are mutually exclusive by construction (each
 * returns before the next runs), matching the same discipline
 * `watchdogClause` above already uses for the crashed strip's own
 * one-sentence summary.
 *
 * `· resume disabled` is appended to the `idle`/`armed` readings alone,
 * never to `off` — the watchdog design's §6.4 calls these out as "either of
 * the LAST two": an operator who just read `off — BM_AGENTS off` already
 * knows nothing is watching at all, so appending a second clause about
 * resuming being disabled would be restating a conclusion the reader already
 * has, about a toggle (`config.enabled`) that is genuinely irrelevant while
 * the sweeper cannot even tick.
 */
export function stateLine(status: WatchdogStatus, now: number = Date.now()): string {
  const { phase, config } = status;

  if (phase === 'off') {
    // The server only ever sets `phase: 'off'` alongside a `reason`
    // (`watchdog.service.ts`'s `offReason()` is the sweeper's only path to
    // this phase, and it always names one of the two kill switches) — the
    // `?? 'unknown'` fallback exists purely so a malformed payload degrades
    // to a readable sentence instead of printing "off — undefined".
    return `off — ${status.reason ?? 'unknown'}`;
  }

  const resumeDisabled = config.enabled ? '' : ' · resume disabled';

  if (phase === 'idle') {
    return `idle — no running run${resumeDisabled}`;
  }

  // phase === 'armed'. `nextTickAt` is an ISO stamp the server sets
  // whenever it arms (`watchdog-state.service.ts`'s `setPhase`); a missing
  // or unparsable one degrades to a 0s countdown rather than throwing or
  // omitting the clause; the armed reading always names the tick.
  const target = status.nextTickAt === null ? NaN : Date.parse(status.nextTickAt);
  const seconds = Number.isFinite(target) ? Math.max(0, Math.round((target - now) / 1000)) : 0;
  return `armed — watching ${status.watching.join(', ')}, next check in ${seconds}s${resumeDisabled}`;
}

/**
 * How much of the sweeper's current tick is still to come — `1` just after a
 * tick, `0` when the next is due (task-26). The bar drawn from it is the
 * same countdown `stateLine`'s armed reading already prints in words; a
 * depleting rule is what makes "armed" read as something that is happening
 * rather than a label.
 *
 * `null` unless the sweeper is genuinely armed with a readable tick: `idle`
 * and `off` have no next tick to be partway through (`off` has no timer at
 * all — see `WatchdogPhase`), and a `tickMs` that is not a positive finite
 * number would divide by zero. In every one of those cases the caller draws
 * no bar, which is not the same as drawing an empty one — an empty bar reads
 * as "a sweep is imminent".
 *
 * Clamped to `[0, 1]`: a tick the server owes us but has not run yet reads
 * `0` rather than drawing backwards past the start of its own track.
 */
export function sweepFraction(status: WatchdogStatus, now: number): number | null {
  if (status.phase !== 'armed') return null;

  const target = status.nextTickAt === null ? NaN : Date.parse(status.nextTickAt);
  if (!Number.isFinite(target)) return null;

  const { tickMs } = status.config;
  if (!Number.isFinite(tickMs) || tickMs <= 0) return null;

  return Math.min(1, Math.max(0, (target - now) / tickMs));
}

/**
 * For a crashed run the sweeper has already spawned against, how long until
 * it may spawn again: `lastSpawnAt + graceMs − now`, floored at zero
 * (task-26).
 *
 * `lastSpawnAt` is the right origin even when that spawn FAILED, and
 * deliberately so: the server starts the grace clock on ANY spawn attempt
 * (CLAUDE.md's "Any spawn attempt starts the grace clock; only a success
 * counts against the cap"), precisely so a dashboard that is down is asked
 * once per window rather than once per tick. A card that measured from the
 * last SUCCESSFUL spawn would promise a retry the sweeper is not going to
 * make.
 *
 * `null` when no attempt has been made or the stamp will not parse —
 * distinct from `0`, which means a window opened and has since closed. The
 * caller prints the line only while the result is positive.
 */
export function graceRemainingMs(
  w: RunWatchdog,
  config: Pick<WatchdogConfig, 'graceMs'>,
  now: number
): number | null {
  if (w.lastSpawnAt === null) return null;
  const spawned = Date.parse(w.lastSpawnAt);
  if (!Number.isFinite(spawned)) return null;
  return Math.max(0, spawned + config.graceMs - now);
}

/** What a kind badge is toned by — a meaning, never a colour name. */
export type WatchdogKindTone = 'live' | 'done' | 'bad' | 'warn' | 'muted';

/**
 * The app's own status vocabulary (`RUN_STATUS_GLYPH`) extended to the seven
 * event kinds, so a badge is never colour alone — the feed used to print
 * `detail` and drop `kind` entirely, leaving a `failed` line and a
 * `recovered` line the same grey until read.
 *
 * A `Record` over the union rather than a lookup with a fallback: adding an
 * eighth kind fails to compile until it is classified, which is the whole
 * mechanism `RUN_STATUS_GLYPH` already relies on.
 */
export const WATCHDOG_KIND_GLYPH: Record<WatchdogEventKind, string> = {
  spawned: '●',
  recovered: '✓',
  failed: '✕',
  exhausted: '⚠',
  disabled: '‖',
  armed: '◉',
  idle: '○'
};

/**
 * What each kind MEANS to the person reading the feed, which is not the same
 * axis as whether the sweeper considered it a success.
 *
 * Both `exhausted` and `disabled` are `warn`, because amber in this app
 * means a human must act, and both of those kinds end in exactly that: the
 * strip's "resume by hand". `armed` and `idle` are `muted` — they are the
 * sweeper's own breathing, logged so a viewer can answer "when did watching
 * start" without having polled `phase` at the right moment, not news.
 */
export const WATCHDOG_KIND_TONE: Record<WatchdogEventKind, WatchdogKindTone> = {
  spawned: 'live',
  recovered: 'done',
  failed: 'bad',
  exhausted: 'warn',
  disabled: 'warn',
  armed: 'muted',
  idle: 'muted'
};
