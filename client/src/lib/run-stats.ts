import type { OrchestratorArchiveRun, RunQueueItem, RunStage } from '../../../shared/types';

/**
 * The statistics behind the Runs section's stat tiles (Task 6) and per-item
 * stage bars (Task 7) — pure derivations over `OrchestratorArchiveRun`, the
 * archive listing's own shape. No React, no fetching: `RunsView` calls these
 * against whatever payload `useOrchestratorArchive` already holds, the same
 * separation `run-time.ts` draws between deriving a number and rendering it.
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
 * `Date.parse`, but `null` instead of `NaN`. A duplicate of `run-time.ts`'s
 * own private `parseStamp` rather than an import of it: that function is not
 * exported (nothing outside that file currently needs it as its OWN thing),
 * and the instruction this module follows is "do not re-implement the
 * primitives `run-time.ts` exports" — `formatSpan`, `formatClock`,
 * `isTerminalStage`, and so on. A three-line stamp parser that neither file
 * exports is not one of those primitives; it is the one piece of plumbing
 * every derivation in both files necessarily starts from, and duplicating
 * three lines of plumbing costs less than adding a cross-file dependency
 * between two lib files that otherwise have no reason to import each other.
 */
function parseStamp(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/**
 * Every `stageAt` entry that parses, as `{stage, at}` pairs sorted ascending
 * by the parsed instant — the one pass `itemStageSpans` and `itemWallMs`
 * both build on, so the two can never disagree about which stamps count or
 * what order they fall in. Corrupt entries are dropped outright (not kept
 * with a `null` placeholder) precisely so a bad `pending` stamp does not
 * anchor a span at a fictitious zero point — see the `'garbage'` case in the
 * test suite, where dropping the entry entirely is what lets the remaining
 * two stamps span correctly against each other instead of against a hole.
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
 * The item's total time in the pipeline: its last recorded arrival minus its
 * first, over whichever stamps actually parse. `null` with fewer than two —
 * one lone stamp (or a `stageAt` with nothing parseable in it at all) has no
 * "first" and "last" to subtract, and `0` would misreport that as "this item
 * took no time" rather than "this item's duration is unknown."
 *
 * Unlike `run-time.ts`'s `itemDurationMs`, this never falls back to `now` for
 * a still-moving item — there is no `now` parameter here at all, on purpose.
 * `itemDurationMs` answers "how long has this been going," a live-render
 * question the run strip and drawer ask on every poll tick; `itemWallMs`
 * answers "how long did this take," the question `aggregateRuns` below asks
 * only of items that have actually finished (`stage === 'merged'`), where
 * the last recorded arrival already IS the end.
 */
export function itemWallMs(item: Pick<RunQueueItem, 'stageAt'>): number | null {
  const arrivals = parsedArrivals(item);
  if (arrivals.length < 2) return null;
  return arrivals[arrivals.length - 1].at - arrivals[0].at;
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
 * Per-stage total milliseconds, summed over every queue item's own
 * `itemStageSpans` — "across this whole run, where did the time actually
 * go," the number behind the detail pane's stage-time breakdown (Task 6).
 *
 * `Partial`, not a fully-keyed record defaulting absent stages to `0`: a
 * stage nothing in the queue ever spanned (every item merged clean with no
 * `fixing` span, say) is a fact worth keeping visible as "absent" rather
 * than flattening into the same `0` a stage that WAS visited but happened to
 * take no measurable time would also produce — a caller iterating
 * `Object.keys()` sees only the stages that actually happened anywhere in
 * this run.
 */
export function runStageTotals(
  run: Pick<OrchestratorArchiveRun, 'queue'>
): Partial<Record<RunStage, number>> {
  const totals: Partial<Record<RunStage, number>> = {};
  for (const item of run.queue) {
    for (const span of itemStageSpans(item)) {
      totals[span.stage] = (totals[span.stage] ?? 0) + span.ms;
    }
  }
  return totals;
}

/** The stat-tile header's numbers (design doc: "Header row" / "aggregate stat tiles"), across whatever runs are in scope (all, or one project's). */
export interface RunAggregates {
  runs: number;
  byStatus: Record<OrchestratorArchiveRun['status'], number>;
  itemsMerged: number;
  /** Total queue length across every run in scope — includes items that never merged. */
  itemsQueued: number;
  /** Mean `itemWallMs` over merged items whose wall time is known; `null` when none qualify. */
  avgItemWallMs: number | null;
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
  // Accepted but not read below — see the comment ahead of the return
  // statement for why "average run wall time" is deliberately not one of
  // these seven numbers, and why the parameter stays in the signature
  // anyway.
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
  const mergedWallTimes: number[] = [];

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
        const wall = itemWallMs(item);
        if (wall !== null) mergedWallTimes.push(wall);
      }
    }
  }

  const avgItemWallMs = mergedWallTimes.length === 0
    ? null
    : mergedWallTimes.reduce((sum, ms) => sum + ms, 0) / mergedWallTimes.length;

  const fixLoopsPerMerged = itemsMerged === 0 ? null : totalFixLoops / itemsMerged;
  const verifyPassRate = verifyTotal === 0 ? null : verifyOk / verifyTotal;

  // `now` deliberately goes unread below: a per-run `runWallMs(run, now)`
  // is NOT folded into these totals, because "average run wall time" would
  // mix finished runs (a fixed span) with a `running` run (a span that
  // grows every time this function is next called with a later `now`) into
  // one number that visibly drifts between two calls a minute apart with no
  // run in scope having actually changed. The parameter stays in the
  // signature anyway — this module's own no-internal-Date.now() rule means
  // any derivation that could need "now" must take it, and a caller already
  // holding one clock reading for `runWallMs` on the selected run should not
  // have to special-case the one aggregate function that happens not to
  // need it yet.
  return {
    runs: runs.length,
    byStatus,
    itemsMerged,
    itemsQueued,
    avgItemWallMs,
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
