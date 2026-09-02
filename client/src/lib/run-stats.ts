import { inStageMs, isTerminalStage, itemDurationMs } from './run-time';
import type { OrchestratorArchiveRun, RunQueueItem, RunStage } from '../../../shared/types';

/**
 * The statistics behind the Runs section's stat tiles (Task 6) and per-item
 * stage bars (Task 7) — pure derivations over `OrchestratorArchiveRun`, the
 * archive listing's own shape. No React, no fetching: `RunsView` calls these
 * against whatever payload `useOrchestratorArchive` already holds, the same
 * separation `run-time.ts` draws between deriving a number and rendering it.
 *
 * This module now IMPORTS three of that file's exports — `itemDurationMs`,
 * `inStageMs`, `isTerminalStage` — where an earlier version of this file
 * deliberately did not import anything from `run-time.ts` at all. The reason
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
 * now that this file imports three of that module's OTHER exports (see the
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
 * How long a whole run took (or has taken so far): `updatedAt − startedAt`
 * for a run that has already finished, `now − startedAt` for one still
 * `running`. The same fork `run-time.ts`'s `runElapsedMs` makes for the live
 * board, restated here rather than imported because that function's
 * signature is keyed on the LIVE payload's `fresh` flag (a `RUN_STALE_MS`
 * heartbeat check with no equivalent in an archived run, which cannot go
 * stale — it is either still running right now or it is finished forever)
 * — a genuinely different question asked of a genuinely different shape,
 * not a primitive worth sharing.
 *
 * `null` when `startedAt` will not parse, for either branch: there is no
 * honest number to report without a start to measure from. A `running` run
 * with an unparseable `startedAt` cannot fall back to `updatedAt` either —
 * that would silently answer a different question ("how long since the last
 * heartbeat") under the same label.
 */
export function runWallMs(
  run: Pick<OrchestratorArchiveRun, 'status' | 'startedAt' | 'updatedAt'>,
  now: number
): number | null {
  const started = parseStamp(run.startedAt);
  if (started === null) return null;

  if (run.status === 'running') return Math.max(0, now - started);

  const updated = parseStamp(run.updatedAt);
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
 * for a whole run's rollup. The six terminal stages (`merged`, `failed`,
 * `skipped`, `needs-answers`, `ungroomed`, `parked`) are left out for the
 * more obvious reason that they are exits, not places work happens — an
 * item's OWN terminal stamp closes its last real span (see `itemStageSpans`)
 * rather than opening a new one of its own.
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
 * The one thing ADDED on top of `itemStageSpans`'s own completed spans is an
 * OPEN span for a still-live item: `now` minus the current stage's own
 * arrival, credited to that stage, but only when the item has not yet left
 * the pipeline (`!isTerminalStage(item.stage)`) AND its current stage is one
 * the orchestrator is actually working (`MACHINE_STAGES.includes(item.stage)`
 * — false for `pending` itself, so a queued-but-not-yet-dispatched item adds
 * nothing). Without this, a run's stage-time rollup would freeze mid-run at
 * whatever the last COMPLETED span happened to be, understating — sometimes
 * by hours — whichever stage is eating time on the item the run is on right
 * now. A live run's rollup has to keep moving even between two items handing
 * off a stamp to each other, and this open span is what makes it.
 */
export function runStageTotals(
  run: { queue: readonly Pick<RunQueueItem, 'stage' | 'stageAt'>[] },
  now: number
): StageTotals {
  const totals: StageTotals = {};

  for (const item of run.queue) {
    for (const span of itemStageSpans(item)) {
      if (!MACHINE_STAGES.includes(span.stage)) continue;
      totals[span.stage] = (totals[span.stage] ?? 0) + span.ms;
    }

    if (!isTerminalStage(item.stage) && MACHINE_STAGES.includes(item.stage)) {
      const open = inStageMs(item, now);
      if (open !== null) totals[item.stage] = (totals[item.stage] ?? 0) + open;
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
  itemsMerged: number;
  /** Total queue length across every run in scope — includes items that never merged. */
  itemsQueued: number;
  /**
   * Mean `itemDurationMs` (run-time.ts) over merged items whose work time is
   * known; `null` when none qualify. Named `...WorkMs`, not `...WallMs`, on
   * purpose — this used to mean "first stamp to last stamp, `pending`
   * included" (the old `itemWallMs`, deleted along with the field this
   * replaces), and that number silently double-counted queue wait as if it
   * were part of the item's own duration. `itemDurationMs` excludes it, the
   * same exclusion `itemQueueWaitMs` (run-time.ts) makes explicit for a
   * single item, so this average now answers "how long did merging an item
   * actually take," not "how long, including everything else queued ahead
   * of it, did an item sit between its first and last stamp."
   */
  avgItemWorkMs: number | null;
  /**
   * Total `fixLoops` spent across EVERY queued item in scope — including
   * ones that never merged — divided by how many DID merge. Deliberately
   * NOT `sum(fixLoops of merged items only) / merged`: rework spent on an
   * item that was ultimately parked or fix-exhausted is still cost this
   * run paid on the way to whatever it did merge, and a caption reading
   * "average fix loops per merge" would understate that cost if the
   * numerator only counted the items that happened to succeed. Pinned
   * against the "merged only" alternative by a dedicated fixture in
   * `test/run-stats.test.ts` (`aggregateRuns` describe block) where a
   * never-merged item carries fix loops of its own specifically so the two
   * readings diverge — case 8, the main aggregate fixture, cannot tell them
   * apart on its own, because every non-merged item there happens to carry
   * zero. `null` when nothing merged (nothing to divide by, and the number
   * would be either infinite or a lie).
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
 * merged ones, before dividing by the merged count: a fix loop spent on an
 * item that was ultimately abandoned (parked, or fix-exhausted into
 * `attention`) is still orchestrator effort that went into producing this
 * run's merges, and folding only the successful items' loops into the
 * numerator would understate what merging anything here actually cost.
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
  // of the return statement): every merged item's `itemDurationMs(item,
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

      if (item.stage === 'merged') {
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

  // `now` IS genuinely read above now, via each merged item's
  // `itemDurationMs(item, now)` call — though for every item that reaches
  // this branch (`stage === 'merged'` is itself a terminal stage)
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
