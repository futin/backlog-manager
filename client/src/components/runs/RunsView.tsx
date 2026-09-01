import { useEffect, useRef, useState } from 'react';

import { useOrchestratorArchive } from '../../hooks/useOrchestratorArchive';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { projectLabel } from '../../lib/project-label';
import { pickAuthority } from '../../lib/run-authority';
import { RUN_STATUS_CLASS, RUN_STATUS_GLYPH } from '../../lib/run-stage';
import { aggregateRuns, dayKey, dayLabel, runWallMs } from '../../lib/run-stats';
import { formatSpanCompact } from '../../lib/run-time';
import { RunDetail } from './RunDetail';
import type { OrchestratorArchiveRun, OrchestratorRun, RunStage } from '../../../../shared/types';

/**
 * Runs — the board's third surface: history of every backlog-orchestrate run
 * across every registered project, not the single currently-running one the
 * board's own RunStrip already surfaces above the columns. RunStrip answers
 * "is anything running right now"; this section answers "what has this
 * project's orchestrator ever done".
 *
 * Task 5 landed only the shell (a heading and the fixed "no runs yet" empty
 * state, wired into the rail). This task fills it in: a project filter, five
 * aggregate stat tiles, and a day-grouped run list with a persistent detail
 * slot beside it. The empty state stays exactly the string Task 5 shipped —
 * it was already the final copy for the genuinely-empty case, not
 * placeholder text — and is now reached by an actual check over both
 * payloads instead of being the only thing this file could render.
 *
 * `RunDetail` (Task 7) renders behind `data-testid="run-detail-slot"` below,
 * fed by `selected` — a click sets it, the newest visible run is the
 * default — because `RunDetail` consumes that state rather than owning it:
 * the list has to know what is selected to draw the `aria-current` row
 * highlight and the live marker regardless of which component renders the
 * detail pane behind it.
 *
 * Fix round 1: a fresh (still-heartbeating) live run is PINNED above every
 * day group, not merely sorted first by `startedAt` — see `splitPinned`'s
 * own comment for the case a pure chronological sort gets backwards (a run
 * still going since days ago beside a different project's run that merely
 * finished more recently). This was the approved design doc's decision from
 * the start; the task brief that drove this file's first version dropped it
 * in transcription, and it is restored here rather than left as a filed
 * discrepancy.
 *
 * Fix round 2: a whole-branch review caught this file disagreeing with
 * itself and with `RunDetail` about which source describes a live-backed
 * run. Two symptoms, one cause. The cause: `mergeRuns` used to drop the live
 * payload's queue entirely and read every row's merged/total, status and
 * wall time off the (possibly minutes-stale) archive snapshot, while
 * `RunDetail` sitting beside the selected row read the 5s live poll — same
 * run, two different merged counts, on one screen. The other symptom was
 * this list never noticing a run that started (or finished) while the tab
 * stayed open and focused, because `useOrchestratorArchive`'s own refresh
 * was fetched and thrown away. Both are fixed together: `MergedRun` now
 * carries the fresh live entry itself (not just a boolean), `RunRow` reads
 * its numbers through `pickAuthority` (`lib/run-authority.ts`) — the same
 * function `RunDetail` uses, so the two surfaces can no longer independently
 * pick different winners — and an effect below re-fetches the archive
 * listing the moment the live poll's own set of fresh runs changes.
 */

/** One row of the merged run list: the archive's own record of the run, plus the fresh live entry backing it, if any. */
interface MergedRun {
  run: OrchestratorArchiveRun;
  /**
   * The live poll's own entry for this run, but ONLY when that entry's
   * `fresh` flag is true — `null` otherwise, including when the run appears
   * in the live payload at all but has gone stale. Being "in the live
   * payload at all" is not enough on its own — a run whose heartbeat is
   * older than `RUN_STALE_MS` is exactly the case RunStrip.tsx already
   * renders nothing special for, and this list makes the same call: the
   * live accent (and, per fix round 2, the live NUMBERS) mean "the board is
   * actually still hearing from this process right now", not merely "this
   * is the most recent run.json".
   *
   * Carried as the object itself, not a boolean, because of fix round 2:
   * `RunRow` needs this run's actual `queue`/`status`/`startedAt`/
   * `updatedAt` to compute merged/total and wall time through
   * `pickAuthority`, the same freshest-wins rule `RunDetail` applies to its
   * own header. Deriving `isLive` from this field (`live !== null`) rather
   * than keeping a separate boolean would be one more way to say the same
   * thing; keeping both is deliberate — `isLive` reads as intent at every
   * call site (pinning, the `runs-row-live` class), where `!== null` would
   * make a reader stop and ask what null means here.
   */
  live: LiveRun | null;
  isLive: boolean;
}

type LiveRun = OrchestratorRun & { fresh: boolean; pastRuns: number };

/**
 * `{project, runId}` as one string — the same composite identity `Selection`
 * below already carries, for the same reason: a `runId` is a second-
 * precision timestamp, not a global counter, so two different projects'
 * state directories could in principle produce the same one. Every place in
 * this file that has to treat two run records as "the same run" — the
 * archive/live dedupe in `mergeRuns`, and the live-run-changed effect in
 * `RunsView` — builds the key this same way, so a future edit cannot key one
 * check on `runId` alone while the rest of the file keys on both (which is
 * exactly the inconsistency a whole-branch review flagged: `mergeRuns` used
 * to dedupe on bare `runId`, silently dropping a real run on the one-in-
 * however-many chance two projects' runs collide on the same second).
 */
function runKey(project: string, runId: string): string {
  return `${project} ${runId}`;
}

/**
 * Folds the archive listing and the live poll into one row list.
 *
 * The archive is still the identity source for every row — id, project,
 * and which runs exist at all come from the archive listing only, per the
 * design doc, and a run that has JUST started, before the next archive
 * fetch (mount, window focus, or fix round 2's own targeted refresh below)
 * has picked it up, will not appear as a row at all yet. What changed in fix
 * round 2 is that the row's live-fronted NUMBERS no longer come from the
 * archive once a fresh live entry exists: `live` now carries that entry
 * itself (not just a yes/no flag) so `RunRow` can read merged/total, status
 * and wall time off it through the same `pickAuthority` rule `RunDetail`
 * uses — see `MergedRun.live`'s own doc comment for why the object, not a
 * boolean, is what has to be carried.
 *
 * Dedupe is defensive, not load-bearing: two archive entries should never
 * share a `{project, runId}` in practice (each is either the one `run.json`
 * or one `runs/<runId>.json` file per project, and the id embeds a
 * timestamp), but a hand-edited or corrupted state directory could produce
 * one anyway, and silently keeping the FIRST occurrence (in the archive
 * endpoint's own per-project descending order) is a safer failure than
 * rendering the same run twice in one list.
 */
function mergeRuns(archiveRuns: readonly OrchestratorArchiveRun[], liveRuns: readonly LiveRun[]): MergedRun[] {
  const freshByKey = new Map(liveRuns.filter((r) => r.fresh).map((r) => [runKey(r.project, r.runId), r]));
  const seen = new Set<string>();
  const merged: MergedRun[] = [];
  for (const run of archiveRuns) {
    const key = runKey(run.project, run.runId);
    if (seen.has(key)) continue;
    seen.add(key);
    const live = freshByKey.get(key) ?? null;
    merged.push({ run, live, isLive: live !== null });
  }
  return merged;
}

/** `Date.parse`, `-Infinity` instead of `NaN` — so a row with a corrupt `startedAt` sorts to the end of a descending list rather than throwing off every comparison it takes part in. */
function parseStartedAt(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? -Infinity : at;
}

/** Newest first, by `startedAt`. Used within one region at a time (the pinned rows, or the history rows) — see `splitPinned` below for why the two regions are never sorted together. */
function sortByStartedAtDesc(rows: readonly MergedRun[]): MergedRun[] {
  return [...rows].sort((a, b) => parseStartedAt(b.run.startedAt) - parseStartedAt(a.run.startedAt));
}

/**
 * Splits the filtered row list into the pinned region and the history below
 * it — fix round 1's own correction of this file's first version, which
 * sorted every row by `startedAt` alone and only ever put a live run first
 * BY COINCIDENCE (a running run's own `startedAt` is usually the most recent
 * one, since a new run only starts once the last one finished). The design
 * doc's actual decision, restated explicitly here because the task brief
 * that drove the first version of this file dropped it in transcription: "a
 * fresh, running run sorts above all history regardless of its startedAt" —
 * not merely first within its own day, and not merely first because it
 * happens to be newest. The case this earns its keep on is exactly the one
 * a pure timestamp sort gets backwards: a run that has been going since
 * three days ago, sitting beside one project's freshly-finished run from
 * this morning. Chronologically the finished one is "newer"; the one still
 * running is the one a person opened this page to actually watch, and it
 * has to render first regardless.
 *
 * `isLive` is exactly the gate this needs, not `run.status === 'running'`
 * — see `MergedRun.isLive`'s own doc comment: it is already `run.fresh` as
 * the live poll's own server-side RUN_STALE_MS check computes it, not a
 * bare status read. A `running` run whose heartbeat has gone stale is a
 * crashed process, not a live one, and belongs in history with everything
 * else — pinning it would be presenting a guess (is it still going?) as a
 * fact, the same call RunStrip.tsx's own file comment makes for rendering
 * nothing at all over a stale run rather than a frozen last-known state.
 *
 * More than one project can have a fresh run at once, so `pinned` is sorted
 * among ITSELF by `startedAt` descending too — the newest of the currently-
 * running runs still leads the pinned region, which is the one place the
 * old pure-chronological ordering was already correct and is kept.
 */
function splitPinned(rows: readonly MergedRun[]): { pinned: MergedRun[]; history: MergedRun[] } {
  const pinned = sortByStartedAtDesc(rows.filter((r) => r.isLive));
  const history = sortByStartedAtDesc(rows.filter((r) => !r.isLive));
  return { pinned, history };
}

/** One day's worth of rows under one heading. */
interface DayGroup {
  key: string;
  label: string;
  rows: MergedRun[];
}

/**
 * Buckets an already-sorted (newest first) row list into day groups. Because
 * the input is sorted by the same instant `dayKey` builds its bucket from,
 * every row belonging to one calendar day is guaranteed to sit contiguously
 * in the input — grouping is therefore a single linear pass that only ever
 * has to compare a row against the group it is already building, not a full
 * map-then-sort over the whole list.
 *
 * A `startedAt` that will not parse gets its own literal `'unknown'` group
 * (key AND label) rather than being silently dropped — `dayKey`/`dayLabel`
 * both already return `null` for exactly this case, and grouping it under a
 * named bucket, per the design brief, is what lets it still be selected and
 * opened rather than vanishing from the list a person can see is missing an
 * item elsewhere (the aggregate tiles, which do count every run in scope).
 */
function groupByDay(rows: readonly MergedRun[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const key = dayKey(row.run.startedAt) ?? 'unknown';
    const label = key === 'unknown' ? 'unknown' : (dayLabel(row.run.startedAt) ?? 'unknown');
    const current = groups[groups.length - 1];
    if (current !== undefined && current.key === key) {
      current.rows.push(row);
    } else {
      groups.push({ key, label, rows: [row] });
    }
  }
  return groups;
}

/**
 * `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS` (imported above) key on the whole
 * RUN's own `status`, deliberately not `lib/run-stage.ts`'s `stageGlyph`/
 * `stageChipClass`, which key on one ITEM's `RunStage` — a different union
 * that shares only one spelling (`failed`) and means something different
 * even there. Both pairs now live in `lib/run-stage.ts` itself (fix round 1
 * hoisted these two out of here — `RunDetail.tsx` needed the identical pair
 * for its own header and had, at first, duplicated rather than shared them);
 * see that file's own comment, right beside `STAGE_TONE`, for the full
 * reasoning on why the two vocabularies cannot be merged into one map.
 */

/** Reading order for the tiles' by-status breakdown — active state first, then the three ways a run can have left it, worst-sounding last. */
const STATUS_ORDER: readonly OrchestratorRun['status'][] = ['running', 'done', 'aborted', 'failed'];

/**
 * Merged-stage items over a run's whole queue — the same ratio the tiles
 * above compute across every run in scope (`aggregateRuns`' own
 * `itemsQueued`/`itemsMerged`, Task 3), read here for one run at a time.
 * Takes any object with a `.queue` of stage-bearing items rather than
 * `OrchestratorArchiveRun` specifically — fix round 2's own change, so
 * `RunRow` can call this on WHICHEVER object `pickAuthority` names as the
 * authority (the archive record, or a fresh `LiveRun`), not only the
 * archive one.
 *
 * `total` is deliberately the RAW `queue.length` — fix round 1's own
 * flagged-but-ruled-on discrepancy: `RunStrip.tsx`'s live strip computes its
 * own `merged/total` by first filtering OUT every `ungroomed` item ("an
 * ungroomed item was never queueable work to begin with", that file's own
 * comment), so the identical run can print two different totals on the two
 * surfaces. That mismatch is real and it stays, on purpose, rather than
 * being reconciled by changing either one: this page's whole reason to
 * exist is to report what a run actually queued, and its own aggregate
 * tiles sitting inches above this row already commit to that same raw
 * denominator (`aggregateRuns` sums `run.queue.length` with no exclusion at
 * all) — a row that quietly excluded `ungroomed` here would disagree with
 * the tiles on THIS page while agreeing with a DIFFERENT page, which is a
 * worse inconsistency than the one it would "fix". RunStrip is answering a
 * different question ("how much of the real work is done") for a different
 * reader (someone watching a run progress live, for whom an item the gate
 * never even queued is noise); this page is answering "what did this run's
 * queue actually contain", for which an ungroomed entry is part of the
 * history being reported, not noise to filter out of it. A future reader
 * who notices the two numbers disagree on the same run should find that
 * reasoning here rather than assume one of the two is a bug.
 *
 * That reasoning once claimed the detail pane "surfaces skipped items
 * explicitly" — a whole-branch review found that inaccurate and asked for
 * the correction: the item this ruling is actually about is `ungroomed`, a
 * different `RunStage` with no chip of its own in `RunDetail`'s four count
 * chips. It still isn't hidden — it shows up as an item ROW carrying an
 * `ungroomed` stage chip, same as any other stage — but a reader looking
 * for a "skipped" count to explain the mismatch would not find one, because
 * that is not where this stage surfaces.
 */
function queueCounts(run: { queue: readonly { stage: RunStage }[] }): { merged: number; total: number } {
  return { merged: run.queue.filter((q) => q.stage === 'merged').length, total: run.queue.length };
}

/**
 * One row of the run list. Its own component (matching RunDrawer.tsx's own
 * split into RowTime/RowStepper/RowStageCaption) rather than inlined into
 * the `.map` below, because a row is not simple: a status chip, a project
 * label, a merged/total count and a wall-time reading are four independently
 * reasoned-about pieces sharing one line, and giving the whole thing a name
 * makes the list's own render method read as "one row per merged run" rather
 * than a wall of JSX.
 *
 * Fix round 2: `merged`/`total`, the status chip, and `wall` are computed
 * off `authority` — `pickAuthority([row.live], run)`, `lib/run-authority.ts`
 * — not off `run` (the archive record) directly. `row.live` is `null`
 * whenever this row is not currently live-backed, in which case `authority`
 * collapses to `run` and every number below is exactly what it always was.
 * When `row.live` IS present, this is the one place that freshest-wins rule
 * actually changes what renders: the live poll's own queue/status/wall
 * time win over whatever the archive snapshot beside them still says,
 * which is what stops this row from printing a different merged count than
 * `RunDetail` reads for the SAME run a few hundred pixels to the right.
 * `run.project`/`run.runId` are read straight off `run` regardless — those
 * are identity fields that cannot change between the two sources for what
 * is, by construction, the same run file.
 */
function RunRow({
  row, now, isSelected, onSelect
}: {
  row: MergedRun;
  now: number;
  isSelected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { run } = row;
  const authority = pickAuthority([row.live], run);
  const { merged, total } = queueCounts(authority);
  const wall = runWallMs(authority, now);

  return (
    <button
      type="button"
      className={row.isLive ? 'runs-row runs-row-live' : 'runs-row'}
      data-testid={`runs-row-${run.runId}`}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="runs-row-head">
        <span className={`runs-status ${RUN_STATUS_CLASS[authority.status]}`}>
          {/* aria-hidden: the status word right beside it is the accessible
              answer, the same "colour and glyph restate the word, never
              replace it" rule run-stage.ts's own doc comment states for the
              per-item chips this row deliberately does NOT reuse. */}
          <span aria-hidden="true">{RUN_STATUS_GLYPH[authority.status]}</span>
          {authority.status}
        </span>
        <span className="runs-row-project">{projectLabel(run.project)}</span>
        <span className="runs-row-count">{merged}/{total}</span>
      </span>
      {wall !== null && <span className="runs-row-wall">{formatSpanCompact(wall)}</span>}
    </button>
  );
}

/** Which run is selected — `project` disambiguates a `runId` that, in principle, could collide across two different projects' state directories (the id is a second-precision timestamp, not a global counter). */
interface Selection {
  project: string;
  runId: string;
}

export default function RunsView() {
  const { runs: archiveRuns, refresh: refreshArchive } = useOrchestratorArchive();
  const { runs: liveRuns } = useOrchestratorRuns();
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Selection | null>(null);

  // I3's fix: the one signal that tells this view "run history just moved"
  // without adding a poll of its own — `useOrchestratorArchive`'s own doc
  // comment explains why it deliberately has none, and a whole-branch review
  // found the consequence of taking that at face value: this view held onto
  // `refresh` and never called it, so a run that started (or finished)
  // while the tab stayed open and focused never showed up here at all — for
  // a project's very first run, the page kept reading "no runs yet" while
  // RunStrip on the Board showed it live a click away.
  //
  // The set of currently-FRESH live runIds is exactly the "did anything
  // change at a run boundary" signal the design doc's own reasoning already
  // grants this hook: a run starting adds a key, a run finishing (or going
  // stale) removes one. Comma-joined into one sorted string, not compared as
  // an array, because `liveRuns` is a brand-new array reference on every 5s
  // poll tick even when its fresh SET hasn't changed at all — depending on
  // the array itself would re-fire this effect (and re-fetch the archive)
  // every 5s for no reason, exactly the redundant-request cost
  // `useOrchestratorArchive` was built to avoid.
  const freshRunKey = liveRuns
    .filter((r) => r.fresh)
    .map((r) => runKey(r.project, r.runId))
    .sort()
    .join('\n');

  // Skips the call this effect would otherwise make on the very FIRST
  // render: `useOrchestratorArchive`'s own mount-time fetch already covers
  // "what does history look like right now", so re-fetching again before
  // `freshRunKey` has had any chance to actually CHANGE would just be a
  // second, redundant request for the same instant. `useRef`'s initializer
  // captures whatever `freshRunKey` is on this component's first call, so
  // the effect's own first run always finds `lastFreshRunKey.current`
  // already equal to it and does nothing; only a LATER render, where
  // `freshRunKey` has moved on from that captured value, updates the ref and
  // fires the refresh.
  const lastFreshRunKey = useRef(freshRunKey);
  useEffect(() => {
    if (lastFreshRunKey.current === freshRunKey) return;
    lastFreshRunKey.current = freshRunKey;
    refreshArchive();
  }, [freshRunKey, refreshArchive]);

  // One clock reading for the whole render, threaded into every derivation
  // that needs "now" below (the aggregate tiles and every row's own wall
  // time) — RunDrawer.tsx's own comment states the reason once for the whole
  // app: two readings taken a millisecond apart can print durations that do
  // not agree with each other at a rung boundary, and a view rendering
  // several such numbers off one instant must actually share that instant
  // rather than let each derivation call Date.now() for itself.
  const now = Date.now();

  const merged = mergeRuns(archiveRuns, liveRuns);

  // Every project seen anywhere in the (unfiltered) merged list — computed
  // off `merged`, not off `filtered` below, so switching the filter to one
  // project never removes the very option that would switch back to another.
  const projects = Array.from(new Set(merged.map((m) => m.run.project)))
    .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));

  const filtered = projectFilter === 'all' ? merged : merged.filter((m) => m.run.project === projectFilter);
  // Pinning is computed AFTER filtering, not before: a project filter that
  // hides the only fresh run in scope must not leave a phantom "live" group
  // heading over an empty rows list, and the design's own "newest VISIBLE
  // run" wording for the default selection below only makes sense read
  // against whatever the filter currently shows.
  const { pinned, history } = splitPinned(filtered);
  const groups = groupByDay(history);

  // Reading order top to bottom: the pinned region first (regardless of its
  // own startedAt — see splitPinned's own comment for why), then history
  // newest-day-first. Selection defaults to whatever leads that order — the
  // fresh run if one is visible, otherwise the newest historical row — which
  // is the concrete, order-following meaning of "the newest run (live one
  // wins if present)" now that "live wins" is a real precedence rather than
  // a same-millisecond tie-break.
  const orderedRows = [...pinned, ...history];

  // The design brief's own wording is "defaulting to the newest VISIBLE run"
  // — visible, not newest overall — which is exactly why this is derived
  // from `orderedRows` (the FILTERED, ordered list) rather than from
  // `merged` directly. A `selected` pointer that no longer names a row in
  // the current filter (the project filter just changed out from under it,
  // or the row it named was dropped by a refetch) falls back the same way:
  // `find` returns `undefined` and the first row in reading order takes over
  // rather than the detail pane silently pointing at a run the list can no
  // longer show.
  const selectedRow = (
    selected !== null
      ? orderedRows.find((r) => r.run.project === selected.project && r.run.runId === selected.runId)
      : undefined
  ) ?? orderedRows[0];

  const aggregates = aggregateRuns(filtered.map((m) => m.run), now);

  // Shared by the pinned region and every day group below: both render the
  // same kind of thing (a list of `RunRow`s against the one `selectedRow`
  // and `now` this render already computed), and factoring the `.map` out
  // once is what keeps the two render sites from drifting on the
  // `isSelected` comparison — the pin fix (round 1) is exactly the kind of
  // change that used to have to be applied in two places at once.
  //
  // `key` is `runKey(...)`, not bare `run.runId` — the same M3 fix as
  // `mergeRuns`' own dedupe, and for the identical reason: two different
  // projects' runs could in principle share a `runId` (a second-precision
  // timestamp, not a global counter), and React's own reconciliation reads
  // `key` for identity exactly the way this list already treats it
  // everywhere else. A bare `runId` key would silently misbehave on a
  // collision the dedupe fix above no longer drops from the list.
  const renderRows = (rows: readonly MergedRun[]): JSX.Element[] => rows.map((row) => (
    <RunRow
      key={runKey(row.run.project, row.run.runId)}
      row={row}
      now={now}
      isSelected={selectedRow !== undefined
        && selectedRow.run.project === row.run.project
        && selectedRow.run.runId === row.run.runId}
      onSelect={() => setSelected({ project: row.run.project, runId: row.run.runId })}
    />
  ));

  return (
    <div className="board">
      <div className="board-bar">
        <div className="board-title">Runs</div>
        {merged.length > 0 && (
          <div className="board-tools">
            <select
              className="board-select"
              aria-label="Project"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="all">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{projectLabel(p)}</option>)}
            </select>
          </div>
        )}
      </div>

      {merged.length === 0 ? (
        // Task 5's own final copy for the genuinely-empty case, verbatim —
        // see this file's own header comment for why this is not
        // placeholder text being replaced, only reached by a real check now.
        <p className="board-note">no runs yet</p>
      ) : (
        <>
          <div className="runs-tiles" data-testid="runs-tiles">
            <div className="runs-tile" data-testid="runs-tile-runs">
              <div className="runs-tile-value">{aggregates.runs}</div>
              <div className="runs-tile-label">runs</div>
              <div className="runs-tile-substat">
                {STATUS_ORDER.map((status) => (
                  <span key={status} className="runs-tile-substat-item">
                    <span aria-hidden="true">{RUN_STATUS_GLYPH[status]}</span> {aggregates.byStatus[status]} {status}
                  </span>
                ))}
              </div>
            </div>
            <div className="runs-tile" data-testid="runs-tile-merged">
              <div className="runs-tile-value">{aggregates.itemsMerged}/{aggregates.itemsQueued}</div>
              <div className="runs-tile-label">merged / queued</div>
            </div>
            <div className="runs-tile" data-testid="runs-tile-avg-item">
              <div className="runs-tile-value">
                {aggregates.avgItemWallMs === null ? '—' : formatSpanCompact(aggregates.avgItemWallMs)}
              </div>
              <div className="runs-tile-label">avg item</div>
            </div>
            {/* "fix loops / merged" read as the MERGED-ONLY reading R1
                deliberately rejected (`RunAggregates.fixLoopsPerMerged`'s own
                doc comment): the numerator sums fix loops across every
                QUEUED item, including ones that never merged, because rework
                spent on an item that was ultimately parked or fix-exhausted
                is still cost this run paid on the way to whatever it did
                merge. The math never changed; only the label was wrong, so a
                reader who checked the number against the old caption could
                reasonably conclude a bug that was never there. "rework /
                merge" plus the `title` below spells out what a reader would
                otherwise only find in run-stats.ts. */}
            <div
              className="runs-tile"
              data-testid="runs-tile-fixloops"
              title="Total fix loops across every queued item, including ones that never merged, divided by how many did merge — what each merge cost in rework."
            >
              <div className="runs-tile-value">
                {aggregates.fixLoopsPerMerged === null ? '—' : aggregates.fixLoopsPerMerged.toFixed(1)}
              </div>
              <div className="runs-tile-label">rework / merge</div>
            </div>
            <div className="runs-tile" data-testid="runs-tile-verify">
              <div className="runs-tile-value">
                {aggregates.verifyPassRate === null ? '—' : `${Math.round(aggregates.verifyPassRate * 100)}%`}
              </div>
              <div className="runs-tile-label">verify pass</div>
            </div>
          </div>

          <div className="runs-split">
            <div className="runs-list" data-testid="runs-list">
              {/* The pinned region: reuses the exact `.runs-day`/
                  `.runs-day-heading`/`.runs-day-rows` chrome the history
                  groups below use, rather than inventing a second visual
                  language for "here is a region" — the "live" heading is
                  what tells a reader this group is not a calendar day like
                  its neighbours, the same way `groupByDay`'s own `unknown`
                  heading already marks an unparseable-date group without a
                  different box or colour of its own. Rendered only when at
                  least one row is actually pinned, so a project filter with
                  no fresh run in scope shows no heading for a region with
                  nothing under it. */}
              {pinned.length > 0 && (
                <div className="runs-day" data-testid="runs-day-live">
                  <div className="runs-day-heading">live</div>
                  <div className="runs-day-rows">{renderRows(pinned)}</div>
                </div>
              )}
              {groups.map((group) => (
                <div key={group.key} className="runs-day" data-testid={`runs-day-${group.key}`}>
                  <div className="runs-day-heading">{group.label}</div>
                  <div className="runs-day-rows">{renderRows(group.rows)}</div>
                </div>
              ))}
            </div>

            {/* RunDetail (Task 7) owns everything inside this wrapper; the
                wrapper itself — class and testid — stays here rather than
                moving into that component, since it is this file's own
                layout grid (.runs-split) that sizes it, the same reason
                .runs-list's rows live in this file rather than a component
                of their own.
                  `selectedRow` is typed `MergedRun | undefined` only
                because TypeScript cannot see across the `merged.length ===
                0` branch above that guards this whole block: by the time
                render reaches here there is always at least one row, and
                `orderedRows[0]` (this variable's own fallback) is never
                actually empty. The guard below is defensive typing, not a
                real empty-selection case this pane has to design for.
                  `selectedRow.live` (fix round 2) — not a fresh lookup into
                `liveRuns` — is where the LIVE object comes from: `mergeRuns`
                already did the project-AND-runId-matched lookup once, when
                it built this row, and carries the result on `MergedRun`
                itself (see that field's own doc comment for why the object,
                not a boolean, is what it keeps). Re-deriving the same match
                here would be a second place that lookup could drift from
                the first. */}
            <div className="runs-detail" data-testid="run-detail-slot">
              {selectedRow !== undefined && (
                <RunDetail summary={selectedRow.run} live={selectedRow.live} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
