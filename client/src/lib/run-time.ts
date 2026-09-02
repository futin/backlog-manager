import { RUN_CLAIMED_STAGES } from '../../../shared/types';
import type { OrchestratorRun, RunQueueItem, RunStage } from '../../../shared/types';

/**
 * Everything the run strip and the run drawer need to answer "how long" and
 * "how far along" out of the run file as it already exists. No server field,
 * no CLI change, no run.json key was added for any of this — `startedAt`,
 * `updatedAt` and `RunQueueItem.stageAt` were all already being written, and
 * were all already on the payload the board polls.
 *
 * Every derivation here returns `null` rather than a number when a stamp
 * cannot be parsed, mirroring `elapsedSince`'s contract in lib/item-age.ts
 * for the same reason it has one: nothing validates the shape of a timestamp
 * on the way in (a run file is a file, and a person can edit one), and a
 * `null` the caller renders nothing for beats `NaNm` rendered into the board.
 *
 * KNOWN BLUR, and it is worth stating once here rather than at each caller:
 * `stageAt` records FIRST arrivals only — `orchestrate.mjs` guards its write
 * with `if (!(stage in item.stageAt))`, and `RunQueueItem.stageAt`'s own doc
 * comment calls the field "a shape record, not a full event log". So a
 * fix-and-re-review loop that re-enters `reviewing` does not re-stamp it, and
 * `inStageMs` below will report time measured from the FIRST time the item
 * reached that stage, not from the loop it is actually in now. Totals
 * (`runElapsedMs`) and done-times (`itemDurationMs`, `formatClock`) are
 * unaffected — both read stamps that are only ever written once anyway.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * The seven dots of the row stepper, in pipeline order — the same order
 * `RunStage`'s own union is written in, and for the reason that union's doc
 * comment gives ("Order here is the pipeline order, not alphabetical,
 * because ... the client render a 'how far along' indicator by finding a
 * stage's position in this list"). This is that client.
 *
 * Seven, not fourteen: `pending` and `preflight` are before the pipeline
 * proper (nothing about this item is happening yet), and the five non-merge
 * exits (`failed`, `skipped`, `needs-answers`, `ungroomed`, `parked`) are not
 * positions ALONG it — they are ways of leaving it, which the row's own stage
 * chip already prints in words. Giving them dots would imply a sequence they
 * are not part of.
 */
export const STEPPER_STAGES: readonly RunStage[] = [
  'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging', 'merged'
];

/**
 * Has this item left the pipeline for good?
 *
 * Derived as the complement of `RUN_CLAIMED_STAGES` (shared/types.ts) rather
 * than written out as a third list of stage names. The two are already exact
 * complements — that constant's own doc comment enumerates the six it leaves
 * out as "the run's exits" — and a hand-copied list here would be a fourth
 * place a newly added `RunStage` member has to be remembered in. The compiler
 * cannot check a list of strings against a union it was copied from; it can
 * check this.
 */
export function isTerminalStage(stage: RunStage): boolean {
  return !RUN_CLAIMED_STAGES.includes(stage);
}

/** `Date.parse`, but `null` instead of `NaN` — the one conversion every derivation below starts from. */
function parseStamp(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/**
 * A millisecond span as a person reads it: `42s`, `9m 12s`, `1h 04m`.
 *
 * Three rungs, each one dropping the unit below the one it just gained, so
 * the string never carries more than two units and never more than five or
 * six characters — this prints into a drawer row's right margin and a strip
 * that already has five other readings on it.
 *
 * Remainders are zero-padded to two digits (`1h 04m`, `9m 02s`) so the
 * reading keeps a stable width in the mono face it renders in: a column of
 * durations that shifts left and right as the remainder crosses ten reads as
 * noise, and `1h 4m` invites being misread as `1h 40m` at a glance.
 *
 * Guarded against a non-finite or negative input for the same reason
 * `formatSeconds` (lib/item-age.ts) is: no real caller here can produce one
 * — every derivation above returns `null` instead — but a future one passing
 * a bad number should get `0s`, not `NaNs` in the DOM.
 */
export function formatSpan(ms: number): string {
  const span = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;

  if (span < MS_PER_MINUTE) return `${Math.floor(span / MS_PER_SECOND)}s`;

  if (span < MS_PER_HOUR) {
    const minutes = Math.floor(span / MS_PER_MINUTE);
    const seconds = Math.floor((span % MS_PER_MINUTE) / MS_PER_SECOND);
    return `${minutes}m ${pad2(seconds)}s`;
  }

  const hours = Math.floor(span / MS_PER_HOUR);
  const minutes = Math.floor((span % MS_PER_HOUR) / MS_PER_MINUTE);
  return `${hours}h ${pad2(minutes)}m`;
}

/**
 * The same span with the sub-unit dropped below the hour rung: `42s`, `38m`,
 * `1h 04m`.
 *
 * Exists for the two readings that tick live — the strip's total and the
 * drawer's meta total — where the run's 5s poll re-renders them. A seconds
 * remainder there does not update smoothly, it JUMPS five at a time, which
 * reads as a glitch rather than as a clock; and at the scale those two
 * readings live at (a run is minutes to hours), the seconds were never the
 * information anyway. The per-row durations keep `formatSpan`'s precision:
 * they are mostly frozen values a person is comparing against each other,
 * where `9m 12s` vs `9m 47s` is exactly the difference worth seeing.
 *
 * The hour rung is identical in both, deliberately: `1h 04m` already dropped
 * its seconds, so there is nothing left for "compact" to take.
 */
export function formatSpanCompact(ms: number): string {
  const span = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (span < MS_PER_MINUTE) return `${Math.floor(span / MS_PER_SECOND)}s`;
  if (span < MS_PER_HOUR) return `${Math.floor(span / MS_PER_MINUTE)}m`;
  return formatSpan(span);
}

function pad2(n: number): string {
  return `${n}`.padStart(2, '0');
}

/**
 * Wall-clock time of day for a stamp, as local `HH:MM` — the answer to "when
 * did this finish", which a duration alone cannot give.
 *
 * Local, not UTC, unlike `item-age.ts`'s date handling: an item's `created`
 * date is pinned to UTC there precisely so one file does not read differently
 * in two timezones, but this is the opposite question. "bug-14 merged at
 * 09:59" is only useful measured against the clock on the wall of the person
 * reading it, and that person is the one who left the run going.
 *
 * Hand-formatted rather than `toLocaleTimeString`, matching the reasoning
 * behind this codebase's hardcoded `MONTHS`: the locale default would render
 * `9:59 AM` on one machine and `09:59` on another, and this prints into a
 * mono column where a variable-width reading breaks the alignment it exists
 * to have.
 */
export function formatClock(iso: string | undefined): string | null {
  const at = parseStamp(iso);
  if (at === null) return null;
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** The run fields these derivations read — a structural subset of the board's own run payload. */
type RunTiming = Pick<OrchestratorRun, 'status' | 'startedAt' | 'updatedAt'> & { fresh: boolean };

/**
 * How long the run has been going: `now − startedAt` while it is genuinely
 * live, `updatedAt − startedAt` once it is not.
 *
 * The fork is on `status === 'running' && fresh` — the exact pair
 * `staleNote` (RunDrawer.tsx) already reads, because it is the same
 * distinction. A live run's elapsed must count against the wall clock or it
 * freezes at whatever the last heartbeat happened to be; a finished run's
 * must not, or an hour after it merged its last item the board would report
 * it as having taken an hour longer than it did. `updatedAt` is the right
 * end for a finished run because the run file's last write IS the run
 * finishing — the same field, re-stamped on every write, that `fresh` is
 * computed from.
 *
 * A `running` run whose heartbeat has gone stale takes the second branch on
 * purpose: nobody knows whether that process is still working, so freezing
 * the total at its last confirmed heartbeat is the only honest reading — the
 * same call RunStrip makes when it renders nothing at all for a stale run.
 */
export function runElapsedMs(run: RunTiming, now: number = Date.now()): number | null {
  const started = parseStamp(run.startedAt);
  if (started === null) return null;

  if (run.status === 'running' && run.fresh) return Math.max(0, now - started);

  const updated = parseStamp(run.updatedAt);
  if (updated === null) return null;
  return Math.max(0, updated - started);
}

/**
 * When work on this item actually started, as a parsed instant — the earliest
 * `stageAt` arrival that is NOT the `pending` stamp.
 *
 * That exclusion is the whole judgement of this module. `orchestrate.mjs`
 * writes `stageAt: { pending: stamp }` for every queue item at `init`, all
 * with the same run-start timestamp, so the literal earliest key is `pending`
 * for every real item and "earliest arrival to merge" would measure time
 * since the RUN began, not time this item took. The queue is worked one item
 * at a time: on a seven-item run the last item would report the whole run's
 * duration as its own, and every merged row would read within seconds of
 * every other. Dropping `pending` — the stamp for "waiting its turn", the one
 * interval where nothing is happening to this item at all — is what makes the
 * number mean "how long did this take".
 *
 * `preflight` is kept, unlike `pending`: the gate check is the orchestrator
 * doing work on THIS item, and keeping it is also what gives the two
 * before-dispatch exits (`needs-answers`, `ungroomed`) a duration at all
 * instead of a blank where a number belongs.
 *
 * `null` when there is no such stamp — an empty `stageAt`, or one holding
 * nothing but `pending`. Both are the same fact: this item has not started.
 */
function startedAtMs(item: Pick<RunQueueItem, 'stageAt'>): number | null {
  let earliest: number | null = null;
  for (const [stage, iso] of Object.entries(item.stageAt)) {
    if (stage === 'pending') continue;
    const at = parseStamp(iso);
    if (at === null) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/** The latest parseable arrival of any stage, `pending` included — the last thing known to have happened. */
function lastArrivalMs(item: Pick<RunQueueItem, 'stageAt'>): number | null {
  let latest: number | null = null;
  for (const iso of Object.values(item.stageAt)) {
    const at = parseStamp(iso);
    if (at === null) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/**
 * How long this item has been in the pipeline: from `startedAtMs` above to
 * the stamp of the stage it ended on, or to `now` while it is still moving.
 *
 * The end has a fallback because a terminal stage is not guaranteed to have
 * stamped itself. `stageAt` is written by the same call that sets `stage`, so
 * in practice the key is there — but a run file resumed across a crash, or
 * hand-edited during a park, can carry a terminal `stage` whose own key never
 * landed. Falling back to the last arrival that DID land keeps such a row
 * reporting the span it can actually prove, rather than measuring a finished
 * item against a clock that keeps running and growing a number that is pure
 * fiction.
 */
export function itemDurationMs(
  item: Pick<RunQueueItem, 'stage' | 'stageAt'>,
  now: number = Date.now()
): number | null {
  const started = startedAtMs(item);
  if (started === null) return null;

  if (!isTerminalStage(item.stage)) return Math.max(0, now - started);

  const end = parseStamp(item.stageAt[item.stage]) ?? lastArrivalMs(item);
  if (end === null) return null;
  return Math.max(0, end - started);
}

/**
 * How long this item sat in the queue before any work on it began: the gap
 * from its `pending` stamp (every item gets one, at run `init`) to
 * `startedAtMs` above — the earliest arrival that is NOT `pending`.
 *
 * This is the one interval `itemDurationMs` deliberately excludes, and this
 * function exists to give that excluded interval a name and a number of its
 * own rather than just discarding it. On a real run (`run-20260901-112815`)
 * bug-7's four items ahead of it in the queue made the Runs pane's old
 * first-stamp-to-last reading say 161 minutes while the drawer's
 * `itemDurationMs` said the true 25 minutes of actual work — the other 136
 * minutes were entirely this item sitting in line, not anything happening to
 * it. So the pane prints this number beside the work-time reading, as
 * CONTEXT for why a queue was long, and it is never added back into any
 * "how long did this take" total anywhere in this codebase: folding queue
 * wait back in is exactly the bug this whole module exists to not repeat.
 *
 * `null` when either stamp is missing or will not parse: a `pending`-only
 * item has not finished waiting (there is no "arrived" instant to measure
 * to yet), and an item with no `pending` stamp at all — a hand-edited or
 * malformed file — has no instant to measure the wait FROM.
 */
export function itemQueueWaitMs(item: Pick<RunQueueItem, 'stageAt'>): number | null {
  const pending = parseStamp(item.stageAt.pending);
  if (pending === null) return null;

  const started = startedAtMs(item);
  if (started === null) return null;

  return Math.max(0, started - pending);
}

/**
 * The clock time this item finished, for a row that has finished — the
 * terminal stage's own arrival, formatted `HH:MM`.
 *
 * `null` for anything still moving, and for a terminal row whose stage never
 * stamped itself: unlike `itemDurationMs` above there is no honest fallback
 * here, because "the last thing we heard about this item" is a different
 * claim from "this is when it merged", and printing one under the other's
 * label would be a lie a reader has no way to detect.
 */
export function itemDoneClock(item: Pick<RunQueueItem, 'stage' | 'stageAt'>): string | null {
  if (!isTerminalStage(item.stage)) return null;
  return formatClock(item.stageAt[item.stage]);
}

/**
 * How long this item has been sitting in the stage it is in right now.
 *
 * Read straight off `stageAt[item.stage]`, which is where the KNOWN BLUR at
 * the top of this file bites: on a second pass through `reviewing` the stamp
 * is still the first pass's, so this over-reports. It is still worth
 * rendering — the common case is a first pass, and "this has been inspecting
 * for 14m" is the single most useful thing the drawer can say about a run
 * that looks wedged — but a caller printing it next to `fixLoops > 0` is
 * printing a number measured across the loops, not within the current one.
 */
export function inStageMs(
  item: Pick<RunQueueItem, 'stage' | 'stageAt'>,
  now: number = Date.now()
): number | null {
  const at = parseStamp(item.stageAt[item.stage]);
  if (at === null) return null;
  return Math.max(0, now - at);
}

/** One dot of a row's stepper: which stage, when it was reached, and how it renders. */
export interface StepperDot {
  stage: RunStage;
  /** Local `HH:MM` of first arrival, or `null` for a stage never entered. */
  at: string | null;
  /**
   * `current` — the row is sitting here now; `filled` — visited and left
   * behind; `hollow` — never entered.
   */
  state: 'current' | 'filled' | 'hollow';
  /** `dispatched · 09:20` for a visited stage, the bare stage name otherwise. */
  label: string;
}

/**
 * The row's seven dots, resolved against what it has actually visited.
 *
 * `filled` is keyed on the presence of a `stageAt` entry rather than on
 * position relative to the current stage, which is the point: an item that
 * merged without ever needing a fix loop has no `fixing` key, so its fixing
 * dot stays hollow between two filled neighbours. That is not a gap in the
 * data, it is the most useful thing the row says — "this one went through
 * clean" — and a stepper that filled everything behind the current position
 * would erase it.
 *
 * The `current` ring is only ever placed on a NON-terminal stage. A merged
 * row is not "at" merged the way a reviewing row is at reviewing — it is
 * finished, and its last dot should read like the six before it. Terminal
 * stages other than `merged` (`failed`, `parked`, ...) are not in the seven
 * at all, so such a row simply shows how far it got before leaving, with the
 * chip beside it naming the exit.
 */
export function stepperDots(item: Pick<RunQueueItem, 'stage' | 'stageAt'>): StepperDot[] {
  return STEPPER_STAGES.map((stage) => {
    const at = formatClock(item.stageAt[stage]);
    const visited = stage in item.stageAt;
    const isCurrent = stage === item.stage && !isTerminalStage(stage);
    return {
      stage,
      at,
      state: isCurrent ? 'current' : visited ? 'filled' : 'hollow',
      // The time is appended only when it is actually known: a visited stage
      // whose stamp will not parse still names itself rather than reading
      // `inspecting · null`.
      label: at === null ? stage : `${stage} · ${at}`
    };
  });
}
