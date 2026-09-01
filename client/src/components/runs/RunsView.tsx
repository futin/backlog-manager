import { useState } from 'react';

import { useOrchestratorArchive } from '../../hooks/useOrchestratorArchive';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { projectLabel } from '../../lib/project-label';
import { aggregateRuns, dayKey, dayLabel, runWallMs } from '../../lib/run-stats';
import { formatSpanCompact } from '../../lib/run-time';
import type { OrchestratorArchiveRun, OrchestratorRun } from '../../../../shared/types';

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
 * `RunDetail` (Task 7) is not built yet; `data-testid="run-detail-slot"`
 * below is what it replaces. Selection is already real — a click sets it,
 * the newest visible run is the default — because Task 7 consumes that
 * state (`selected`) rather than owning it: the list has to know what is
 * selected to draw the `aria-current` row highlight and the live marker
 * regardless of which task renders the detail pane behind it.
 */

/** One row of the merged run list: the archive's own record of the run, plus whether it is currently being heard from live. */
interface MergedRun {
  run: OrchestratorArchiveRun;
  /**
   * True only when this run's `runId` also appears in the live poll payload
   * AND that live entry's own `fresh` flag is true. Being "in the live
   * payload at all" is not enough on its own — a run that has gone stale
   * (heartbeat older than `RUN_STALE_MS`) is exactly the case RunStrip.tsx
   * already renders nothing special for, and this list makes the same call:
   * the live accent means "the board is actually still hearing from this
   * process right now", not merely "this is the most recent run.json".
   */
  isLive: boolean;
}

type LiveRun = OrchestratorRun & { fresh: boolean; pastRuns: number };

/**
 * Folds the archive listing and the live poll into one row list.
 *
 * The archive is the master list, per the design doc: every row painted
 * below reads its id, project, queue counts and timestamps off the ARCHIVE
 * entry, never off the live one. That is deliberate, not an oversight — the
 * live payload's own queue is dropped entirely by this function (only
 * `runId` and `fresh` are read off it) because Task 7 is what will render a
 * selected live run's actual queue from the live object directly; this list
 * only needs the live payload to answer one yes/no question per row.
 *
 * One consequence worth stating: a run that has JUST started, before the
 * next archive fetch (mount or window focus — `useOrchestratorArchive` has
 * no poll of its own) has picked it up, will not appear as a row at all yet,
 * live or not. That is the same lag the design doc accepts elsewhere for the
 * same hook, and it self-corrects the next time this tab is focused.
 *
 * Dedupe is defensive, not load-bearing: two archive entries should never
 * share a `runId` in practice (each is either the one `run.json` or one
 * `runs/<runId>.json` file per project, and the id embeds a timestamp), but
 * a hand-edited or corrupted state directory could produce one anyway, and
 * silently keeping the FIRST occurrence (in the archive endpoint's own
 * per-project descending order) is a safer failure than rendering the same
 * run twice in one list.
 */
function mergeRuns(archiveRuns: readonly OrchestratorArchiveRun[], liveRuns: readonly LiveRun[]): MergedRun[] {
  const freshByRunId = new Map(liveRuns.filter((r) => r.fresh).map((r) => [r.runId, true]));
  const seen = new Set<string>();
  const merged: MergedRun[] = [];
  for (const run of archiveRuns) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    merged.push({ run, isLive: freshByRunId.has(run.runId) });
  }
  return merged;
}

/** `Date.parse`, `-Infinity` instead of `NaN` — so a row with a corrupt `startedAt` sorts to the end of a descending list rather than throwing off every comparison it takes part in. */
function parseStartedAt(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? -Infinity : at;
}

/**
 * Newest first, by `startedAt`. Ties (down to the same millisecond — a real
 * possibility only for two runs that started in the same second on the same
 * project, since `runId` itself is a second-precision timestamp) break in
 * favour of the live-backed entry, which is the concrete meaning behind the
 * design doc's "the newest run (live one wins if present)": in the ordinary
 * case a running run's `startedAt` already IS the most recent one, so this
 * tie-break rarely fires — it exists for the edge the plain timestamp
 * comparison cannot settle on its own.
 */
function sortRows(rows: readonly MergedRun[]): MergedRun[] {
  return [...rows].sort((a, b) => {
    const diff = parseStartedAt(b.run.startedAt) - parseStartedAt(a.run.startedAt);
    if (diff !== 0) return diff;
    return Number(b.isLive) - Number(a.isLive);
  });
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
 * The run-level status tone map — deliberately NOT `lib/run-stage.ts`'s
 * `stageGlyph`/`stageChipClass`. Those two operate on `RunStage`, the
 * fourteen-member per-ITEM pipeline union (`pending`, `reviewing`, `merged`,
 * ...); a row here reports the whole RUN's own `status` field, a completely
 * separate four-member union (`running | done | aborted | failed`) that
 * shares only one spelling (`failed`) with the other and means something
 * different even there. Calling `stageGlyph(run.status)` would not compile
 * without a cast, and with one it would silently read `undefined` out of
 * `STAGE_TONE` for `running`, `done` and `aborted`, none of which are
 * `RunStage` members. This is a second, small, total map over a different
 * four-word union — the tone VOCABULARY it reuses (cyan-for-live,
 * green-for-success, amber-for-needs-a-look, red-for-broken) is identical to
 * `STAGE_TONE`'s, per the brief's own instruction, but the two maps cannot
 * be merged into one without conflating two different questions a reader
 * could ask about a run.
 */
const RUN_STATUS_GLYPH: Record<OrchestratorRun['status'], string> = {
  running: '●',
  done: '✓',
  aborted: '⚠',
  failed: '✕'
};

const RUN_STATUS_CLASS: Record<OrchestratorRun['status'], string> = {
  running: 'runs-status-live',
  done: 'runs-status-done',
  aborted: 'runs-status-warn',
  failed: 'runs-status-bad'
};

/** Reading order for the tiles' by-status breakdown — active state first, then the three ways a run can have left it, worst-sounding last. */
const STATUS_ORDER: readonly OrchestratorRun['status'][] = ['running', 'done', 'aborted', 'failed'];

/** One `merged`-stage item over the row's whole queue — the same ratio the tiles compute across every run in scope, read for one run at a time. */
function queueCounts(run: OrchestratorArchiveRun): { merged: number; total: number } {
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
  const { merged, total } = queueCounts(run);
  const wall = runWallMs(run, now);

  return (
    <button
      type="button"
      className={row.isLive ? 'runs-row runs-row-live' : 'runs-row'}
      data-testid={`runs-row-${run.runId}`}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="runs-row-head">
        <span className={`runs-status ${RUN_STATUS_CLASS[run.status]}`}>
          {/* aria-hidden: the status word right beside it is the accessible
              answer, the same "colour and glyph restate the word, never
              replace it" rule run-stage.ts's own doc comment states for the
              per-item chips this row deliberately does NOT reuse. */}
          <span aria-hidden="true">{RUN_STATUS_GLYPH[run.status]}</span>
          {run.status}
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
  const { runs: archiveRuns } = useOrchestratorArchive();
  const { runs: liveRuns } = useOrchestratorRuns();
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Selection | null>(null);

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
  const sorted = sortRows(filtered);
  const groups = groupByDay(sorted);

  // The design brief's own wording is "defaulting to the newest VISIBLE run"
  // — visible, not newest overall — which is exactly why this is derived
  // from `sorted` (the FILTERED, sorted list) rather than from `merged`
  // directly. A `selected` pointer that no longer names a row in the current
  // filter (the project filter just changed out from under it, or the row it
  // named was dropped by a refetch) falls back the same way: `find` returns
  // `undefined` and the newest visible row takes over rather than the detail
  // pane silently pointing at a run the list can no longer show.
  const selectedRow = (
    selected !== null
      ? sorted.find((r) => r.run.project === selected.project && r.run.runId === selected.runId)
      : undefined
  ) ?? sorted[0];

  const aggregates = aggregateRuns(filtered.map((m) => m.run), now);

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
            <div className="runs-tile" data-testid="runs-tile-fixloops">
              <div className="runs-tile-value">
                {aggregates.fixLoopsPerMerged === null ? '—' : aggregates.fixLoopsPerMerged.toFixed(1)}
              </div>
              <div className="runs-tile-label">fix loops / merged</div>
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
              {groups.map((group) => (
                <div key={group.key} className="runs-day">
                  <div className="runs-day-heading">{group.label}</div>
                  <div className="runs-day-rows">
                    {group.rows.map((row) => (
                      <RunRow
                        key={row.run.runId}
                        row={row}
                        now={now}
                        isSelected={selectedRow !== undefined
                          && selectedRow.run.project === row.run.project
                          && selectedRow.run.runId === row.run.runId}
                        onSelect={() => setSelected({ project: row.run.project, runId: row.run.runId })}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Task 7's RunDetail replaces this slot outright; until then the
                selected runId is the one thing worth proving actually wired
                up — that a click on the left really does move what "this
                run" means, without building the detail pane twice. */}
            <div className="runs-detail" data-testid="run-detail-slot">
              {selectedRow?.run.runId ?? ''}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
