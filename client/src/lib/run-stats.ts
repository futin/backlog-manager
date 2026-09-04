import { isTerminalStage, itemDurationMs, runIsLive } from './run-time';
import type { OrchestratorArchiveRun, OrchestratorRun, RunQueueItem, RunStage } from '../../../shared/types';

/**
 * The statistics behind the Runs section's stat tiles (Task 6) and per-item
 * stage bars (Task 7) — pure derivations over `OrchestratorArchiveRun`, the
 * archive listing's own shape. No React, no fetching: `RunsView` calls these
 * against whatever payload `useOrchestratorArchive` already holds, the same
 * separation `run-time.ts` draws between deriving a number and rendering it.
 *
 * This module now IMPORTS two of that file's exports — `itemDurationMs`,
 * `isTerminalStage` — where an earlier version of this file deliberately
 * did not import anything from `run-time.ts` at all. The reason
 * is that "how long did this item take" must have exactly one
 * implementation, not two that quietly disagree. Before this change, this
 * module answered that question itself, with its own `itemWallMs` — first
 * recorded `stageAt` arrival to last, `pending` included — while
 * `run-time.ts`'s `itemDurationMs` answered it by excluding `pending` (the
 * queue-wait interval; see that function's own doc comment). Both numbers
 * described the same item, and on a real run they diverged by the item's
 * entire wait in line: `run-20260901-112815`'s bug-7 read 161 minutes in
 * this module's stat tiles and 25 minutes in the drawer that reads
 * `itemDurationMs` — the other 136 minutes were the four items ahead of it
 * in the queue, not anything that happened to bug-7 itself. `itemWallMs` is
 * gone now; every "how long" reading in this file goes through
 * `run-time.ts`'s version instead, so the two surfaces this feature puts
 * side by side cannot drift apart again — there is only one implementation
 * left for either of them to read.
 *
 * Two conventions carried over from that file, deliberately unchanged here:
 *
 * - Every derivation returns `null` (or skips the offending entry) rather
 *   than throwing when a stamp will not parse. A run file is hand-editable
 *   JSON on disk, there is no ErrorBoundary above whatever eventually
 *   renders these numbers, and a `null` a caller chooses not to render beats
 *   a `NaN` baked into a stat tile or a whole view crashing on one bad file.
 * - `now` is always a parameter, never read internally via `Date.now()`.
 *   `RunDrawer.tsx` states the reason once for the whole app: a caller
 *   rendering several of these numbers against one instant must take that
 *   instant itself and thread it down, or two readings taken a millisecond
 *   apart can print durations that do not agree with each other at a rung
 *   boundary. `aggregateRuns` and `runWallMs` both take `now` for this
 *   reason, not because they default to the wall clock and might skip it.
 *
 * KNOWN BLUR, carried over from `RunQueueItem.stageAt`'s own doc comment and
 * restated here because `itemStageSpans` is where it actually bites:
 * `stageAt` records each stage's FIRST arrival only — `orchestrate.mjs`
 * guards its write with `if (!(stage in item.stageAt))` — so a fix-and-
 * re-review loop's second (or third) pass through `reviewing`/`fixing` never
 * gets a stamp of its own. That second pass's time does not vanish from the
 * spans below; it folds into whichever span was open when the loop actually
 * happened, which is the span belonging to whatever stage's stamp is
 * chronologically just before the NEXT stage the item reached for the first
 * time. A `reviewing` → `fixing` → `reviewing` → `merged` item, for example,
 * reports one `reviewing` span running from the first `reviewing` arrival to
 * `merged`'s arrival — the second trip through `reviewing` is real time
 * spent, but it is invisible as its own span, indistinguishable from time
 * spent on the first pass. This is exactly why the design doc rejected a
 * gantt/timeline rendering of this data: a per-item stage bar (Task 7) is
 * still worth drawing because "which stage ate the most wall time" survives
 * the blur even when "how many passes did it take" does not, but a timeline
 * would present the folded span as if it were one uninterrupted visit, which
 * is the misleading reading the design doc calls out by name.
 */

/**
 * `Date.parse`, but `null` instead of `NaN`. Still a duplicate of
 * `run-time.ts`'s own private `parseStamp` rather than an import of it, even
 * now that this file imports two of that module's OTHER exports (see the
 * file header): `parseStamp` itself is not one of them because it isn't
 * exported there either — nothing outside `run-time.ts` needs it as its own
 * thing, so importing it here would just relocate the duplication, not
 * remove it.
 */
function parseStamp(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/**
 * A run's own heartbeat, parsed, together with whether the run is still
 * genuinely alive.
 *
 * The boolean half is no longer derived here: it is `runIsLive`
 * (`run-time.ts`), which asks exactly this question — `status: "running"`
 * AND `RUN_STALE_MS` measured strictly against `updatedAt`, the same
 * comparison `orchestrator.service.ts` performs server-side for the live
 * payload's `fresh` flag. bug-15 exported it from that file for its own
 * item-level clamp (`runClockMs`), which would have made this the FOURTH
 * spelling of the same comparison in the repo and the SECOND on the client;
 * delegating keeps it at one client-side implementation, which is the whole
 * lesson bug-14 left behind (`runStageTotals` grew this check while
 * `runWallMs` did not, and for months a crashed run's wall time ticked
 * upward beside a stage rollup that had correctly frozen).
 *
 * What this function still does that `runIsLive` cannot is answer the parsed
 * INSTANT alongside the boolean, because the two callers need different
 * things from it: `runWallMs` measures its stopped branch to `updated`, and
 * `runStageTotals` freezes an open span there. `null` for a stamp that will
 * not parse — and such a run is never live either, since an unparseable
 * heartbeat is not evidence a process is alive.
 *
 * Takes the run rather than the bare `updatedAt` string it used to, because
 * `runIsLive` reads `status` too: liveness was always the conjunction of the
 * two, this file just used to spell the `status` half at each call site.
 *
 * Still deliberately NOT exported. `run-time.ts`'s `runElapsedMs` asks the
 * same question of the LIVE payload, which carries the server's own `fresh`
 * flag as a field, so it reads that flag instead of deriving anything.
 */
function heartbeat(
  run: Pick<OrchestratorArchiveRun, 'status' | 'updatedAt'>,
  now: number
): { updated: number | null; live: boolean } {
  return { updated: parseStamp(run.updatedAt), live: runIsLive(run, now) };
}

/**
 * Every `stageAt` entry that parses, as `{stage, at}` pairs sorted ascending
 * by the parsed instant — the one pass `itemStageSpans` builds its own
 * output on. Corrupt entries are dropped outright (not kept with a `null`
 * placeholder) precisely so a bad `pending` stamp does not anchor a span at
 * a fictitious zero point — see the `'garbage'` case in the test suite,
 * where dropping the entry entirely is what lets the remaining two stamps
 * span correctly against each other instead of against a hole.
 */
function parsedArrivals(item: Pick<RunQueueItem, 'stageAt'>): Array<{ stage: RunStage; at: number }> {
  const arrivals: Array<{ stage: RunStage; at: number }> = [];
  for (const [stage, iso] of Object.entries(item.stageAt)) {
    const at = parseStamp(iso);
    if (at === null) continue;
    arrivals.push({ stage: stage as RunStage, at });
  }
  arrivals.sort((a, b) => a.at - b.at);
  return arrivals;
}

/** One gap between two consecutive recorded stage arrivals, in `itemStageSpans`'s output. */
export interface StageSpan {
  stage: RunStage;
  ms: number;
}

/**
 * Spans between consecutive recorded stage arrivals, sorted by time and
 * labeled by the EARLIER stage of each pair — "how long did this item spend
 * having just arrived at `dispatched`, before it arrived at whatever came
 * next." Sorting by parsed TIMESTAMP rather than by `RunStage`'s own nominal
 * pipeline order is what keeps every span non-negative even on a fix-looped
 * item: see this file's own KNOWN BLUR note above for why an item's
 * `stageAt` keys are not always written in — and are never REVISITED in —
 * pipeline order once a fix loop has run.
 *
 * The last arrival contributes no span of its own: three spans come out of
 * four stamps, not four, because there is nothing after the last one to
 * measure it against. A single stamp (or none) therefore always produces
 * `[]` — there is no earlier point to start a first span from either.
 *
 * Accepts a `Pick<RunQueueItem, 'stageAt'>` rather than a whole item because
 * this is the entire slice both a live `RunQueueItem` and an archived
 * `ArchiveQueueItem` share — a live item's dropped `verification.tail` (or
 * anything else the archive summary strips) is irrelevant to a function that
 * only ever reads `stageAt`, so accepting the narrower shape lets the same
 * function serve both without a cast at either call site.
 */
export function itemStageSpans(item: Pick<RunQueueItem, 'stageAt'>): StageSpan[] {
  const arrivals = parsedArrivals(item);
  const spans: StageSpan[] = [];
  for (let i = 0; i < arrivals.length - 1; i++) {
    spans.push({ stage: arrivals[i].stage, ms: arrivals[i + 1].at - arrivals[i].at });
  }
  return spans;
}

/**
 * How long a whole run took (or has taken so far): `now − startedAt` for a
 * run that is genuinely live, `updatedAt − startedAt` for every other run —
 * finished, aborted, failed, and a `running` one whose heartbeat has gone
 * stale alike.
 *
 * The fork is `status === 'running' && fresh`, the same pair `run-time.ts`'s
 * `runElapsedMs` makes for the live board. It is restated here rather than
 * imported because freshness has to be DERIVED at this call site, not read:
 * `runElapsedMs`' signature is keyed on the LIVE payload's own `fresh`
 * flag, and `OrchestratorArchiveRun` carries no equivalent of it at all
 * (live-backed or archived, there is no `fresh` field on this shape). The
 * derivation is `heartbeat` above — `RUN_STALE_MS` measured against
 * `updatedAt` — shared with `runStageTotals` below, which forks on exactly
 * the same question for its own open spans.
 *
 * Why a `running` run needs a freshness check at all, since `status` sounds
 * like it already answers this: a CRASHED orchestrator leaves `run.json` at
 * `status: "running"` FOREVER. `orchestrate.mjs init` refuses to overwrite
 * one, fresh or stale — recovery is `--resume`/`--abort` only, this repo's
 * own "One run per project, checked twice" invariant — and `GET
 * /api/orchestrator/archive` serves that frozen file verbatim, while the
 * live poll's merge drops it (a stale entry is never `fresh`, so
 * `pickAuthority` never picks it as a live winner). So the archive path
 * hands this function `running` runs of arbitrarily old heartbeat, and
 * `status` alone never says which. Gating on `status` alone was bug-14:
 * a crashed run's wall time grew by a second every second, indefinitely,
 * printed as "how long this run has taken" — three days after the crash it
 * read three days.
 *
 * A stale `running` run therefore freezes at its own last confirmed
 * heartbeat, which is the reading `runElapsedMs`' own comment argues for:
 * nobody knows whether that process is still working, so its last confirmed
 * heartbeat is the only honest instant to report against — never whatever
 * moment the archive happens to be read at.
 *
 * `null` when `startedAt` will not parse, for either branch: there is no
 * honest number to report without a start to measure from. A `running` run
 * with an unparseable `startedAt` cannot fall back to `updatedAt` either —
 * that would silently answer a different question ("how long since the last
 * heartbeat") under the same label.
 *
 * `null` also for a `running` run whose UPDATEDAT will not parse, which is
 * the one behaviour bug-14's fix changes beyond the crashed case (it used
 * to answer `now − startedAt`). An unparseable heartbeat is not evidence a
 * process is alive, so it cannot earn the `now`-ticking branch, and it
 * leaves no honest instant to freeze at either — the same "skip rather than
 * fabricate" call `runStageTotals` already makes for its own open span.
 * Both callers already degrade correctly on a `null` with no edit: `RunRow`
 * renders the wall span only when it is non-null, and `RunDetail`'s header
 * prints `started HH:MM` alone, precisely the case its own comment there
 * describes (a run that can still say when it began with no honest wall
 * time to report) — a comment that covered only finished runs and simply
 * becomes true of `running` ones too.
 */
export function runWallMs(
  run: Pick<OrchestratorArchiveRun, 'status' | 'startedAt' | 'updatedAt'>,
  now: number
): number | null {
  const started = parseStamp(run.startedAt);
  if (started === null) return null;

  // `heartbeat`'s boolean already carries the `status === 'running'` half of
  // this fork (it delegates to `runIsLive`), so the branch reads as the one
  // question it always was rather than restating half of it here.
  const { updated, live } = heartbeat(run, now);
  if (live) return Math.max(0, now - started);

  if (updated === null) return null;
  return Math.max(0, updated - started);
}

/**
 * Pipeline order. The seven stages that are the orchestrator working — never
 * `pending`, never an exit.
 *
 * `pending` is left out on purpose, and it is the whole judgement call this
 * constant makes: it is queue WAIT, not the orchestrator doing anything to
 * this item, so a "where did the time go" total that included it would
 * misreport a long queue as a long-running stage. This is the same
 * exclusion `itemQueueWaitMs` (run-time.ts) makes for a single item's own
 * reading, restated here as the list `runStageTotals` below filters against
 * for a whole run's rollup. The seven terminal stages (`merged`, `branched`,
 * `failed`, `skipped`, `needs-answers`, `ungroomed`, `parked` — the run's two
 * success exits, one per `MergeMode`, alongside its five failure ones; see
 * `RunStage`'s own doc comment in shared/types.ts) are left out for the more
 * obvious reason that they are exits, not places work happens — an item's
 * OWN terminal stamp, whichever of the two success exits it lands on or one
 * of the five failure ones, closes its last real span (see `itemStageSpans`)
 * rather than opening a new one of its own. `branched` needed no separate
 * carve-out when it was added: it is a terminal arrival exactly like
 * `merged` already was, so the sentence that always excluded one success
 * exit already covered both without changing a word of its reasoning.
 */
export const MACHINE_STAGES: readonly RunStage[] = [
  'preflight', 'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'
];

/** A run's (or several runs', via `sumStageTotals`) per-stage machine-time total, keyed by `RunStage`. */
export type StageTotals = Partial<Record<RunStage, number>>;

/**
 * Per-stage total milliseconds of MACHINE TIME — the orchestrator actually
 * working, never queue wait — across every item in the queue. "Across this
 * whole run, where did the time actually go," the number behind the detail
 * pane's stage-time breakdown (Task 6).
 *
 * Two things are deliberately excluded from the sum, both for the same
 * underlying reason: this function answers "where did the ORCHESTRATOR'S
 * time go," not "where did the WALL-CLOCK time between two stamps go."
 *
 *   - `pending` spans (`itemStageSpans` entries labeled `pending`, and the
 *     implicit "still in pending" case for a live item — see the second
 *     bullet) are dropped via the `MACHINE_STAGES.includes(span.stage)`
 *     filter below. A run works its queue one item at a time; every OTHER
 *     item's `pending` span is time this item spent waiting its turn, not
 *     time the orchestrator was idle or the run was somehow slow. Summing
 *     five items' queue waits into this total would report four run-lengths
 *     of pure nothing on top of whatever the run actually did.
 *   - A span labeled by a TERMINAL stage (`merged`, `parked`, ...) cannot
 *     occur from `itemStageSpans` in the first place — a terminal arrival is
 *     always the LAST recorded stamp, and `itemStageSpans` never opens a
 *     span from the last stamp (see that function's own doc comment) — so
 *     the only place a terminal stage could contribute is the open-span step
 *     below, which is guarded against it explicitly by `isTerminalStage`.
 *
 * On top of `itemStageSpans`'s own completed spans, this adds an OPEN span
 * for a still-live item — `now` minus (a corrected version of) the current
 * stage's own arrival, credited to that stage — but ONLY when the RUN is
 * itself `status === 'running'`. That run-level gate is fix round 1's
 * addition, and the reason is `now`: for a run that has stopped —
 * `done`/`aborted`/`failed` — whatever `stage` an item was frozen in when
 * the run stopped is not "still happening," it is the last thing that
 * happened before nobody was watching anymore. Crediting `now − stamp` to
 * an aborted run's stranded `fixing` item would add however long it has
 * been since the abort — hours, days, however stale the archive is read —
 * as if the orchestrator were still working it. That single unbounded
 * number does not just misreport one stage: Task 7 sums `runStageTotals`
 * across every run in a selected range, so one dead item's ever-growing
 * "open" span would keep inflating a RANGE total that should be fixed
 * forever once every run in it has stopped, and the per-run stage bar
 * (which scales every segment to the largest value in the set) would
 * flatten every other, real stage into an invisible sliver beside it. The
 * spec's own reasoning for the open span ("so the row for the stage it is
 * in grows as the pane ticks") is about a live run specifically — an
 * archived, stopped run was an omission in that reasoning, not something it
 * argued for, so gating on it is filling a gap rather than overriding a
 * decision. `status` is a REQUIRED field of the parameter, not optional
 * with some default: every real caller already has it on hand (`RunDetail`'s
 * resolved `source`, and Task 7's `pickAuthority(...)` result both carry a
 * `status`), so there is no legitimate call site that would need a default,
 * and an optional field is exactly the kind of gap a future caller could
 * silently fall through — passing archived data without its `status` would
 * otherwise resolve to whatever the default happened to be instead of
 * failing to compile.
 *
 * The open span's OWN start is also corrected from what a first reading of
 * the spec would produce, and this is fix round 1's second, unrelated fix
 * living in the same function. `stageAt[item.stage]` is that stage's FIRST
 * arrival only (`orchestrate.mjs` guards the write with `if (!(stage in
 * item.stageAt))` — see this file's own KNOWN BLUR paragraph above), so an
 * item that re-entered its current stage after a fix loop — `reviewing` →
 * `fixing` → back to `reviewing`, with no fresh `stageAt.reviewing` key for
 * the second visit — has a current-stage stamp that is now STALE: it points
 * at the first visit, which chronologically precedes a LATER stamp
 * (`fixing`'s own arrival) already recorded on the item. Naively opening the
 * span at that stale stamp would credit the WHOLE interval from the first
 * `reviewing` arrival to `now`, but the first-arrival-to-`fixing` portion of
 * that interval is ALSO already counted once, as the closed `reviewing` span
 * `itemStageSpans` produces from those same two stamps — so the item's
 * second pass through `reviewing` would have its whole first pass counted
 * TWICE. This is a different failure from the file's own accepted KNOWN
 * BLUR: that paragraph accepts MIS-ATTRIBUTION (the second pass's real time
 * folds invisibly into whichever span was open when the loop happened,
 * rather than appearing as its own `reviewing` span) as a cost worth paying
 * for keeping `stageAt` a shape record instead of a full event log; it does
 * not accept DOUBLE-COUNTING the same interval into two different numbers
 * that get summed together, which is an arithmetic error, not a blur. The
 * fix is to open the live span from `max(the item's own latest parseable
 * arrival across every stamp it has, stageAt[item.stage])` instead of from
 * `stageAt[item.stage]` alone. For an item that never re-entered its current
 * stage, that MAX is a no-op — the current stage's own arrival already IS
 * the latest stamp the item has, because nothing chronologically later has
 * been recorded — so no existing case's numbers move. For a re-entered
 * stage, the max resolves to whatever LATER stage's stamp the item picked up
 * on its way through the loop (`fixing`'s arrival, above), which is exactly
 * the boundary the closed span already stopped counting at, so the open
 * span now measures only the genuinely uncounted tail: from that later
 * stamp to `now`.
 *
 * FIX ROUND 2 (final-review wave): the run-level gate above — `status ===
 * 'running'` — is right but was INCOMPLETE on its own, for a case fix round
 * 1 did not anticipate: a CRASHED orchestrator leaves `run.json` at
 * `status: "running"` forever. `orchestrate.mjs init` refuses to overwrite
 * a run file already at that status, fresh or stale — recovery is
 * `--resume`/`--abort` only (this repo's own "One run per project, checked
 * twice" invariant) — so `status` alone cannot tell a run still genuinely
 * being worked apart from one whose process died hours or days ago and
 * simply never got the chance to write anything else. `GET
 * /api/orchestrator/archive` serves that frozen file verbatim, and the live
 * poll's own merge drops it (a stale entry is never `fresh`, so
 * `pickAuthority` never picks it as a live winner) — so the archive path
 * was still handing this function a `running` run of arbitrarily old
 * heartbeat, and crediting its frozen item `now - stamp` forever: the exact
 * unbounded-growth failure the `status` gate above exists to prevent,
 * reached through the one door that gate left open, both to this run's own
 * rollup and — via `sumStageTotals` — to the wide tile summing every run in
 * scope.
 *
 * The fix mirrors `runElapsedMs` (run-time.ts), which already forks on
 * exactly this distinction for the live board: `now − startedAt` while
 * genuinely live, `updatedAt − startedAt` once not, gated on `status ===
 * 'running' && fresh`. This function cannot read that same `fresh` flag —
 * `OrchestratorArchiveRun` carries no `fresh` field at all, live-backed or
 * archived (see `runWallMs`'s own corrected comment above for the identical
 * fact stated from that function's side) — so freshness has to be derived
 * here instead of trusted from a passed-in flag: the same `RUN_STALE_MS`
 * heartbeat check the server performs once for the live payload, measured
 * here directly against `updatedAt`. While fresh, the open span still ends
 * at `now`, unchanged from fix round 1. Once stale, it ends at `updatedAt`
 * instead — frozen at the run's own last confirmed heartbeat, the same
 * honest reading `runElapsedMs`'s own comment gives for a process nobody
 * knows the state of, rather than at whatever instant the archive happens
 * to be read.
 *
 * An `updatedAt` that will not parse is treated as NOT fresh — an
 * unparseable heartbeat is not evidence a process is still alive, so it
 * cannot earn the `now`-ticking branch — but it also leaves no honest
 * instant to freeze the open span AT. Such an item's open span contributes
 * nothing at all in that case, beyond the closed spans already summed above
 * for it: the same "skip rather than fabricate" rule this file applies to
 * every other unparseable stamp (see `parsedArrivals` above), rather than
 * either extreme a less careful reading might reach for — crediting `now`
 * anyway (silently un-fixing the very bug this round closes) or throwing
 * (a hand-editable run file is exactly the kind of input this whole module
 * exists to survive).
 */
export function runStageTotals(
  run: {
    status: OrchestratorRun['status'];
    updatedAt: string;
    queue: readonly Pick<RunQueueItem, 'stage' | 'stageAt'>[];
  },
  now: number
): StageTotals {
  const totals: StageTotals = {};

  // This run's own heartbeat freshness — see FIX ROUND 2 above for why it
  // must be DERIVED here (RUN_STALE_MS measured against `updatedAt`) rather
  // than read off a `fresh` flag the way the live board's `runElapsedMs`
  // can. Computed once, outside the item loop, since it depends only on the
  // run itself, never on which item the loop happens to be measuring.
  // `heartbeat` is that derivation, shared with `runWallMs` above rather
  // than written inline here as it once was: bug-14 was precisely the two
  // going out of step.
  const { updated, live } = heartbeat(run, now);

  for (const item of run.queue) {
    for (const span of itemStageSpans(item)) {
      if (!MACHINE_STAGES.includes(span.stage)) continue;
      totals[span.stage] = (totals[span.stage] ?? 0) + span.ms;
    }

    if (run.status === 'running' && !isTerminalStage(item.stage) && MACHINE_STAGES.includes(item.stage)) {
      const currentAt = parseStamp(item.stageAt[item.stage]);
      if (currentAt !== null) {
        // `parsedArrivals` re-parses every stamp on the item (including this
        // same one), sorted ascending, so its last entry is the item's
        // overall latest parseable arrival — never empty here, because
        // `currentAt` just parsed successfully from one of exactly those
        // entries. Taking the max against `currentAt` explicitly (rather
        // than trusting that fact silently) is what makes the "no-op for a
        // never-re-entered stage" claim above visible in the code, not just
        // true of it.
        const arrivals = parsedArrivals(item);
        const start = Math.max(arrivals[arrivals.length - 1].at, currentAt);
        if (live) {
          totals[item.stage] = (totals[item.stage] ?? 0) + Math.max(0, now - start);
        } else if (updated !== null) {
          // Stale, but with an honest last-heartbeat instant to freeze the
          // span at — FIX ROUND 2's own branch. Never `now` here: that is
          // precisely the unbounded reading a crashed run's frozen item must
          // not be credited with.
          totals[item.stage] = (totals[item.stage] ?? 0) + Math.max(0, updated - start);
        }
        // else: `updatedAt` itself will not parse. Never live (an
        // unparseable heartbeat is no evidence of a process) and with no honest instant to
        // freeze at either, this item's open span adds nothing on top of
        // its closed spans (already summed above) for this render.
      }
    }
  }

  return totals;
}

/**
 * Field-wise sum of several `StageTotals` records — how the Runs section's
 * stat tiles (Task 6) fold every run's own `runStageTotals` into one
 * across-runs breakdown, the same "sum the per-item numbers, then let a
 * caller decide the scope" shape `aggregateRuns` below uses for its own
 * totals. `{}` for an empty list: no runs in scope means no stages to report
 * on, which is a different fact from every stage reporting a `0` nobody
 * measured.
 */
export function sumStageTotals(totals: readonly StageTotals[]): StageTotals {
  const sum: StageTotals = {};
  for (const t of totals) {
    for (const stage of Object.keys(t) as RunStage[]) {
      sum[stage] = (sum[stage] ?? 0) + (t[stage] ?? 0);
    }
  }
  return sum;
}

/** The stat-tile header's numbers (design doc: "Header row" / "aggregate stat tiles"), across whatever runs are in scope (all, or one project's). */
export interface RunAggregates {
  runs: number;
  byStatus: Record<OrchestratorArchiveRun['status'], number>;
  /**
   * Items that reached a SUCCESSFUL terminal stage — `merged` (merge mode)
   * or `branched` (branch mode) alike, per the design's own classification
   * (`docs/superpowers/specs/2026-09-04-orchestrator-merge-mode-design.md`
   * §4: "aggregateRuns | counted as completed, alongside merged"). A
   * branch-mode item that reached a reviewed branch is exactly as finished,
   * and exactly as much real orchestrator work, as one that reached `main`.
   * The field keeps its pre-existing name rather than becoming
   * `itemsCompleted`: renaming a field every caller of this shape already
   * reads is a decision for whichever later task actually surfaces
   * `mergeMode` on this tile, not one buried in a stats module's own naming.
   */
  itemsMerged: number;
  /** Total queue length across every run in scope — includes items that never merged. */
  itemsQueued: number;
  /**
   * Mean `itemDurationMs` (run-time.ts) over items that reached a successful
   * terminal stage (`merged` or `branched`) whose work time is known; `null`
   * when none qualify. Named `...WorkMs`, not `...WallMs`, on
   * purpose — this used to mean "first stamp to last stamp, `pending`
   * included" (the old `itemWallMs`, deleted along with the field this
   * replaces), and that number silently double-counted queue wait as if it
   * were part of the item's own duration. `itemDurationMs` excludes it, the
   * same exclusion `itemQueueWaitMs` (run-time.ts) makes explicit for a
   * single item, so this average now answers "how long did merging an item
   * actually take," not "how long, including everything else queued ahead
   * of it, did an item sit between its first and last stamp."
   *
   * A GENUINE `0` from `itemDurationMs` — a completed item whose only
   * recorded arrival is its own terminal stamp, so start and end read the
   * identical instant — COUNTS toward this mean, deliberately, and this is
   * a real behaviour change from the deleted rule: old `itemWallMs`
   * returned `null` (excluded outright) for any item with fewer than two
   * recorded stamps, where `itemDurationMs` finds one non-`pending`
   * arrival to measure both ends from and reports the honest `0` instead.
   * Keeping it is the same principle the rest of this task applies
   * everywhere else — an item that genuinely took under a second of
   * measured work is a real data point, and silently dropping it would be
   * exactly the kind of quiet exclusion this whole rewrite exists to
   * remove, just aimed at a `0` instead of a `pending` leg this time.
   */
  avgItemWorkMs: number | null;
  /**
   * Total `fixLoops` spent across EVERY queued item in scope — including
   * ones that never completed — divided by how many DID (merged or
   * branched, `itemsMerged` above). Deliberately NOT `sum(fixLoops of
   * completed items only) / completed`: rework spent on an item that was
   * ultimately parked or fix-exhausted is still cost this run paid on the
   * way to whatever it did finish, and a caption reading "average fix loops
   * per merge" would understate that cost if the numerator only counted the
   * items that happened to succeed. Pinned against the "merged only"
   * alternative by a dedicated fixture in `test/run-stats.test.ts`
   * (`aggregateRuns` describe block) where a never-merged item carries fix
   * loops of its own specifically so the two readings diverge — case 8, the
   * main aggregate fixture, cannot tell them apart on its own, because every
   * non-merged item there happens to carry zero. `null` when nothing
   * completed (nothing to divide by, and the number would be either
   * infinite or a lie).
   */
  fixLoopsPerMerged: number | null;
  /**
   * `ok` verification entries over ALL verification entries recorded by
   * EVERY item in scope, merged or not. Deliberately not scoped to merged
   * items only: a verify failure that correctly kept an item from merging
   * is exactly the signal this rate exists to surface, and excluding
   * non-merged items would hide a run's failures from its own pass-rate
   * tile. Pinned the same way `fixLoopsPerMerged` is, by the same
   * dedicated fixture — see that field's comment. `null` when no run in
   * scope has recorded any verification entries at all.
   */
  verifyPassRate: number | null;
}

/**
 * The cross-run rollup behind the Runs section's header row. Takes the whole
 * scoped list of runs (already filtered by project, if the caller is
 * filtering) and folds it into the seven numbers the tile row prints.
 *
 * `fixLoopsPerMerged` sums `fixLoops` over EVERY queued item, not just the
 * completed ones, before dividing by `itemsMerged` — the completed count,
 * `merged` and `branched` summed together (that field's own comment has the
 * reasoning for why the two exits share one count): a fix loop spent on an
 * item that was ultimately abandoned (parked, or fix-exhausted into
 * `attention`) is still orchestrator effort that went into producing this
 * run's completions, and folding only the successful items' loops into the
 * numerator would understate what finishing anything here actually cost.
 *
 * `verifyPassRate` counts every verification entry on every item, merged or
 * not, for the same reason a failing verify run is exactly the kind of
 * signal this rate exists to surface — restricting it to merged items would
 * hide every failure that (correctly) kept an item from merging at all.
 *
 * Both "all items, not just merged" readings are asserted by a dedicated
 * fixture in `test/run-stats.test.ts` where a never-merged item carries its
 * own nonzero fix loops and verification entries, chosen specifically so the
 * "merged items only" alternative would produce a different number — the
 * main aggregate fixture (case 8) cannot rule that alternative out on its
 * own, because every non-merged item in it happens to carry zero of both.
 *
 * Every ratio is `null`, never `0` or `NaN`, when its denominator is zero:
 * `0` would misreport "we tried and every result was bad" for the different
 * fact "there is nothing here to measure yet," which matters most for the
 * empty-history case (a freshly registered project) where every tile would
 * otherwise print a red 0% for having done nothing at all.
 *
 * `runs`' element type is a structural shape, not `OrchestratorArchiveRun`
 * itself — the same generalization `RunsView.tsx`'s own `queueCounts`
 * already made, and for the identical reason: a re-review found the
 * aggregate tiles this function feeds still reading the archive record for
 * a live-backed run while `RunRow` beside them had already been fixed to
 * read `pickAuthority([row.live], row.run)` (`lib/run-authority.ts`) — so
 * mid-run, an item merging would tick the row's own count up while these
 * tiles kept reporting whatever the last archive fetch saw, minutes stale,
 * inches away on the same screen. `RunsView` now maps every run in scope
 * through that same `pickAuthority` call before handing the list here, so
 * this function has to accept whichever of the two concrete shapes
 * (`OrchestratorArchiveRun` or a fresh live `OrchestratorRun`) that
 * produces — a fixed `OrchestratorArchiveRun` parameter would force a cast
 * at the call site, exactly the kind of "trust me" seam a future edit could
 * silently get wrong again. The shape below names only the fields this
 * function actually reads (`status`, and a `.queue` of items carrying
 * `stage`/`fixLoops`/`stageAt`/`verification[].ok`), which both concrete
 * run types satisfy without narrowing.
 */
export function aggregateRuns(
  runs: readonly {
    status: OrchestratorArchiveRun['status'];
    queue: readonly {
      stage: RunStage;
      fixLoops: number;
      stageAt: Partial<Record<RunStage, string>>;
      verification: readonly { ok: boolean }[];
    }[];
  }[],
  // Genuinely read below now (it did not used to be — see the comment ahead
  // of the return statement): every completed item's `itemDurationMs(item,
  // now)` call needs it, the one clock reading this whole computation shares
  // for the same reason every other now-taking derivation in this codebase
  // does. "Average run wall time" is still deliberately not one of these
  // seven numbers regardless — see that same comment for why.
  now: number
): RunAggregates {
  const byStatus: Record<OrchestratorArchiveRun['status'], number> = {
    running: 0,
    done: 0,
    aborted: 0,
    failed: 0
  };

  let itemsMerged = 0;
  let itemsQueued = 0;
  let totalFixLoops = 0;
  let verifyOk = 0;
  let verifyTotal = 0;
  const mergedWorkTimes: number[] = [];

  for (const run of runs) {
    byStatus[run.status] += 1;
    itemsQueued += run.queue.length;

    for (const item of run.queue) {
      totalFixLoops += item.fixLoops;

      for (const entry of item.verification) {
        verifyTotal += 1;
        if (entry.ok) verifyOk += 1;
      }

      // A run's SUCCESSFUL terminal stage is either `merged` or `branched`
      // (`RunStage`'s own doc comment, shared/types.ts: "the two success
      // exits ... a queue item reaches exactly one of them, never both").
      // `itemsMerged` counts both, per the design's own classification
      // ("counted as completed, alongside merged") — a branch-mode item that
      // reached a reviewed branch is exactly as finished, and exactly as
      // much real orchestrator work, as one that reached `main`.
      if (item.stage === 'merged' || item.stage === 'branched') {
        itemsMerged += 1;
        const work = itemDurationMs(item, now);
        if (work !== null) mergedWorkTimes.push(work);
      }
    }
  }

  const avgItemWorkMs = mergedWorkTimes.length === 0
    ? null
    : mergedWorkTimes.reduce((sum, ms) => sum + ms, 0) / mergedWorkTimes.length;

  const fixLoopsPerMerged = itemsMerged === 0 ? null : totalFixLoops / itemsMerged;
  const verifyPassRate = verifyTotal === 0 ? null : verifyOk / verifyTotal;

  // `now` IS genuinely read above now, via each completed item's
  // `itemDurationMs(item, now)` call — though for every item that reaches
  // this branch (`merged` and `branched` are both terminal stages)
  // `itemDurationMs` ignores the value it was handed and measures to the
  // item's own terminal stamp instead (see that function's own doc
  // comment), so `avgItemWorkMs` still cannot itself drift between two
  // calls a minute apart. What stays true from before this task: a per-run
  // `runWallMs(run, now)` is still NOT folded into these totals, because
  // "average run wall time" would mix finished runs (a fixed span) with a
  // `running` run (a span that keeps growing) into one number that WOULD
  // drift between two calls with no run in scope having actually changed —
  // exactly the drift `itemDurationMs` above turns out not to have, and
  // `runWallMs` does.
  return {
    runs: runs.length,
    byStatus,
    itemsMerged,
    itemsQueued,
    avgItemWorkMs,
    fixLoopsPerMerged,
    verifyPassRate
  };
}

/** Two-digit zero-padding — `item-age.ts`'s own tiny helper, re-written rather than imported for the same "not a shared primitive" reason `parseStamp` above is duplicated. */
function pad2(n: number): string {
  return `${n}`.padStart(2, '0');
}

/**
 * The run list's grouping key: `YYYY-MM-DD` in the VIEWER'S LOCAL time, not
 * UTC. Deliberately the opposite convention from `item-age.ts`'s `created`
 * handling (`formatCreated` pins to UTC so one file reads the same date in
 * every timezone) — this key exists to bucket runs the way a person reading
 * the Runs section actually experiences their day, the same reasoning
 * `run-time.ts`'s `formatClock` gives for using local hours: "bug-14 merged
 * at 09:59" is a fact about the wall clock of whoever left the run going,
 * and grouping "today's runs" together only works if "today" means the
 * viewer's today.
 *
 * `null` for a stamp that will not parse — the run list can safely drop such
 * a run from every day-group rather than inventing a group for it.
 */
export function dayKey(iso: string): string | null {
  const at = parseStamp(iso);
  if (at === null) return null;
  const date = new Date(at);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Hardcoded rather than `toLocaleDateString`, matching `item-age.ts`'s own
 * `MONTHS` array and its stated reason: the Runs section is a shared view of
 * one project's shared run history, and a label that reads `mon 1 sep` on
 * one machine and `lun 1 sept.` on another (locale-default French) is a date
 * two people looking at the same run cannot talk about. A second, separate
 * array from `item-age.ts`'s rather than an import of it — that file's
 * `MONTHS` is deliberately UTC-keyed (`getUTCMonth`) for its own reasons,
 * while this one is read against LOCAL month/day, so the two are answering
 * different questions even where the twelve strings happen to be identical.
 */
const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
];

/** `Date#getDay()` order — index 0 is Sunday, matching the platform's own convention rather than an ISO week starting Monday. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The run list's day-group heading: `mon 1 sep`, lowercase, local time — the
 * same instant `dayKey` buckets by, spelled out for a human rather than kept
 * as a sortable string. No leading zero on the day-of-month (`1`, not `01`):
 * unlike the mono duration columns `run-time.ts` pads for alignment, this
 * sits alone as a section heading with nothing beside it to misalign against.
 *
 * `null` for a stamp that will not parse, same as `dayKey` — a run with a
 * corrupt `startedAt` has no honest day to be grouped under at all.
 */
export function dayLabel(iso: string): string | null {
  const at = parseStamp(iso);
  if (at === null) return null;
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}
