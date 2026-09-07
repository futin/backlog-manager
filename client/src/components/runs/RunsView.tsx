import { useEffect, useRef, useState } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { elapsedSince } from '../../lib/item-age';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useOrchestratorArchive } from '../../hooks/useOrchestratorArchive';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { projectLabel } from '../../lib/project-label';
import { pickAuthority } from '../../lib/run-authority';
import { RANGE_BUTTON, RANGE_SCOPE, RUN_RANGES, inRange } from '../../lib/run-range';
import { RUN_STATUS_GLYPH, mergeModeLabel, runStatusChip } from '../../lib/run-stage';
import { MODE_BUTTON, RUNS_MODES, RUNS_MODE_KEY, isRunsMode } from '../../lib/runs-mode';
import { aggregateRuns, dayKey, dayLabel, runStageTotals, runWallMs, sumStageTotals } from '../../lib/run-stats';
import { formatSpanCompact } from '../../lib/run-time';
import { RunDetail } from './RunDetail';
import { StageBars } from './StageBars';
import { WatchdogMonitor } from './WatchdogMonitor';
import type { RunRange } from '../../lib/run-range';
import { resumeGate } from '../../../../shared/agent';
import type {
  OrchestratorArchiveRun, OrchestratorRun, OrchestratorRunsPayload, RunStage, StartingRun
} from '../../../../shared/types';

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
 * carries the live entry itself (not just a boolean), `RunRow` reads
 * its numbers through `pickAuthority` (`lib/run-authority.ts`) — the same
 * function `RunDetail` uses, so the two surfaces can no longer independently
 * pick different winners — and an effect below re-fetches the archive
 * listing the moment the live poll's own set of fresh runs changes.
 *
 * Fix round 3: round 2 fixed the ROW but left the aggregate stat tiles
 * behind — a follow-up re-review found `aggregateRuns` still fed the raw
 * archive record for every run, live-backed included, so a run's row could
 * tick `1/6 -> 2/6` on the live poll while the "completed / queued" tile
 * beside it (labelled "merged / queued" at the time; relabelled by the final
 * whole-branch review's finding 1) stayed frozen on the stale archive count
 * for the run's entire duration. Same cause as round 2 (a call site reading
 * `m.run` instead of asking `pickAuthority` who the current authority is),
 * just a second call site that had not been touched yet. See the comment
 * immediately above `aggregateRuns`'s own call below for the specifics.
 *
 * Task 7 adds the range control (design doc: "Range") — a segmented Today /
 * This week / This month / All group in the toolbar (`RUN_RANGES`-driven,
 * `lib/run-range.ts`), component state exactly like `projectFilter` (not
 * persisted, so a reload always opens back on "all runs" rather than
 * silently reopening on whatever a person left it on). It scopes the tiles,
 * the list, AND a new sixth tile together, composed with — not instead of —
 * the existing project filter: range narrows `merged` down to `inScope`
 * first, then the project filter narrows `inScope` down to `filtered`
 * exactly as it always narrowed `merged` before this task, so "this
 * project, this week" and "everything, today" are both just the same two
 * filters applied in the same fixed order. The sixth tile, `.runs-tile-wide`
 * (`data-testid="runs-tile-machine"`), sums `runStageTotals` (Task 2) across
 * every run `filtered` currently holds through `StageBars` (Task 4) — the
 * identical "where did the time go" reading `RunDetail`'s own rollup gives
 * for one run, now folded across however many runs the range/project
 * combination leaves in view, and reading its stat off the SAME
 * `pickAuthority`-resolved authority `aggregates` above already reads, for
 * the identical fix-round-2/3 reason: a live-backed run's still-open span
 * has to come from its fresh live queue, never a stale archive snapshot
 * frozen mid-run.
 *
 * task-18 gives the section two MODES, not one: `Runs` is everything
 * described above, and `Watchdog` replaces the whole body below the bar with
 * `WatchdogMonitor` — the sweeper's state, the runs it is watching, and its
 * activity feed, all of which used to sit on the Settings page nobody has
 * open while a run is going. The switch renders unconditionally (unlike
 * every other tool in this bar, which waits on `merged.length > 0`: the
 * sweeper has a phase to report whether or not this project has ever
 * finished a run) and persists (unlike the range and the project filter,
 * which deliberately do not — see `lib/runs-mode.ts` for that distinction in
 * full). The monitor takes this component's OWN `liveRuns` array as a prop
 * rather than fetching runs itself, so a mode switch adds no request.
 *
 * Emptying the range (or the range-and-project combination) does not empty
 * this whole section the way `merged.length === 0` does: the tiles, the
 * range control and the project select all stay mounted (a range is a VIEW
 * over an unchanged corpus, not a reason to hide that the corpus exists —
 * and a person needs the controls still on screen to widen back out of the
 * empty combination they just created), and only `.runs-list` swaps its
 * pinned-region-plus-day-groups for one `no runs in this range` note.
 */

/** One row of the merged run list: the archive's own record of the run, plus the live entry backing it, if the live payload has one at all. */
interface MergedRun {
  run: OrchestratorArchiveRun;
  /**
   * The live poll's own entry for this run, if the payload has one at all —
   * `null` only when it does not. Freshness is deliberately NOT a condition
   * here; that is `isLive`'s whole job, one field down.
   *
   * bug-29 is why. This field used to be gated on `entry.fresh === true`,
   * which conflated two different questions the payload answers separately:
   * `status` says whether the run is over, `fresh` says whether its
   * heartbeat is recent. A run in a long review or merge step is `running`
   * with a stale heartbeat — `SKILL.md` says outright that review and merge
   * "can outlast the fifteen-minute freshness threshold on their own", and a
   * scan of this machine's archived run files found 57 gaps of more than 15
   * minutes between consecutive stage stamps, the worst two 249 and 206
   * minutes. For every one of those windows this row read `live: null` and
   * fell back to `useOrchestratorArchive`, which by design carries no poll,
   * while `useOrchestratorRuns`' 5s poll went right on arriving (it keeps
   * polling any `running` run, fresh or not) and being discarded. The stage
   * readout froze until a reload or a window focus, on the one surface built
   * to watch a run happen.
   *
   * The last stage a run file recorded is not a guess: `run.json` is re-read
   * per request and its stage stamps are facts with timestamps on them,
   * whatever the heartbeat age says about whether the process is still
   * alive. So a stale-but-arriving live entry beats a minutes-old archive
   * snapshot as DATA every time — which is exactly what `RunStrip` has
   * always done for the same run, and why the two surfaces disagreed.
   *
   * Carried as the object itself, not a boolean, because of fix round 2:
   * `RunRow` needs this run's actual `queue`/`status`/`startedAt`/
   * `updatedAt` to compute merged/total and wall time through
   * `pickAuthority`, the same freshest-wins rule `RunDetail` applies to its
   * own header.
   */
  live: LiveRun | null;
  /**
   * The PRESENTATION gate: `live?.fresh === true`, i.e. "is the board still
   * hearing from this process right now". Read by the pinned region
   * (`splitPinned`) and the `runs-row-live` accent, and by nothing that
   * decides where a number comes from — that is `live`'s job, above.
   *
   * Kept as its own boolean rather than derived at each call site for the
   * reason it always was: it reads as intent where `live?.fresh === true`
   * would make a reader stop and re-derive the rule. Since bug-29 it is no
   * longer one more way to say `live !== null`; the two now genuinely
   * disagree for exactly the run this list used to freeze.
   */
  isLive: boolean;
}

type LiveRun = OrchestratorRunsPayload['runs'][number];

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
 * archive once a live entry exists: `live` now carries that entry
 * itself (not just a yes/no flag) so `RunRow` can read merged/total, status
 * and wall time off it through the same `pickAuthority` rule `RunDetail`
 * uses — see `MergedRun.live`'s own doc comment for why the object, not a
 * boolean, is what has to be carried. bug-29 then dropped the `fresh` filter
 * from the map built below: a `running` run with a stale heartbeat still has
 * a live entry arriving every 5 seconds, and dropping it handed the row back
 * to a source that never polls.
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
  // bug-29: EVERY live entry, not `liveRuns.filter((r) => r.fresh)`. The
  // freshness question moved down one line, onto `isLive` alone — see both
  // fields' own doc comments for the split and why it is the whole fix.
  const liveByKey = new Map(liveRuns.map((r) => [runKey(r.project, r.runId), r]));
  const seen = new Set<string>();
  const merged: MergedRun[] = [];
  for (const run of archiveRuns) {
    const key = runKey(run.project, run.runId);
    if (seen.has(key)) continue;
    seen.add(key);
    const live = liveByKey.get(key) ?? null;
    merged.push({ run, live, isLive: live?.fresh === true });
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
 * `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS` key on the whole
 * RUN's own `status`, deliberately not `lib/run-stage.ts`'s `stageGlyph`/
 * `stageChipClass`, which key on one ITEM's `RunStage` — a different union
 * that shares only one spelling (`failed`) and means something different
 * even there. Both pairs now live in `lib/run-stage.ts` itself (fix round 1
 * hoisted these two out of here — `RunDetail.tsx` needed the identical pair
 * for its own header and had, at first, duplicated rather than shared them);
 * see that file's own comment, right beside `STAGE_TONE`, for the full
 * reasoning on why the two vocabularies cannot be merged into one map.
 *
 * The ROW no longer reads either record directly — bug-29 put
 * `runStatusChip` (same file) in front of both, so a `running` run with a
 * dead heartbeat prints `crashed` in the Board strip's own word rather than
 * the live cyan `running` it used to. The tiles' by-status substat below
 * still reads `RUN_STATUS_GLYPH` straight, and deliberately: that is a tally
 * over the archived corpus, not a claim about any run right now.
 */

/** Reading order for the tiles' by-status breakdown — active state first, then the three ways a run can have left it, worst-sounding last. */
// `paused` sits beside `running` rather than among the endings: it is the
// one non-running status a run can still leave, so the breakdown reads as
// "in flight" then "over" rather than interleaving the two.
const STATUS_ORDER: readonly OrchestratorRun['status'][] = ['running', 'paused', 'done', 'aborted', 'failed'];

/**
 * Completed items over a run's whole queue — the same ratio the tiles
 * above compute across every run in scope (`aggregateRuns`' own
 * `itemsQueued`/`itemsMerged`, Task 3), read here for one run at a time.
 * Takes any object with a `.queue` of stage-bearing items rather than
 * `OrchestratorArchiveRun` specifically — fix round 2's own change, so
 * `RunRow` can call this on WHICHEVER object `pickAuthority` names as the
 * authority (the archive record, or a fresh `LiveRun`), not only the
 * archive one.
 *
 * `completed` counts BOTH of `RunStage`'s success exits, `merged` and
 * `branched` — one per `MergeMode` — for the identical reason
 * `RunStrip.tsx`'s own `completed` does (that file's own comment has the
 * full account): a run holding items in both stages, the shape a merge
 * denied partway through the queue actually leaves behind (design §5.2),
 * must count both rather than silently dropping whichever one this
 * function's numerator did not name. `aggregateRuns` already made this
 * same call for the tiles above ("counted as completed, alongside merged",
 * design §4) — this is that same rule applied to one run instead of every
 * run in scope, not a second, independently-arrived-at decision.
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
function queueCounts(run: { queue: readonly { stage: RunStage }[] }): { completed: number; total: number } {
  return {
    completed: run.queue.filter((q) => q.stage === 'merged' || q.stage === 'branched').length,
    total: run.queue.length
  };
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
 *
 * Task 9 adds the mode badge (`mergeModeLabel`, lib/run-stage.ts), read off
 * the SAME `authority` object every other reading on this row already uses
 * — `mergeMode`/`mergeModeEffective` live on both `OrchestratorRun` and
 * `OrchestratorArchiveRun`, so no third field has to be threaded through
 * `pickAuthority` for it. Design §7 asks for this at the LIST level, not
 * just the detail pane behind it, specifically so a downgraded run is
 * "legible at a glance in history" — a person scanning a day's worth of
 * rows should not have to open every one just to learn which runs left
 * branches behind. `mergeModeLabel` returns `null` for a plain merge-mode
 * run, so this adds nothing to the row for the shape of run that made up
 * every row in this list before this feature existed.
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
  // bug-29: the status word, glyph and class, with `running` + a dead
  // heartbeat substituted to `crashed`. Derived from `row.live`, never from
  // `authority` — `authority` can be the archive record, which carries no
  // `fresh` field at all, and a row with no heartbeat to judge must keep
  // printing its recorded status. See `runStatusChip` (lib/run-stage.ts) for
  // why `crashed` stays derived rather than becoming a sixth `RunStatus`.
  const status = runStatusChip(authority.status, row.live);
  const { completed, total } = queueCounts(authority);
  const wall = runWallMs(authority, now);
  const modeLabel = mergeModeLabel(authority.mergeMode, authority.mergeModeEffective);

  return (
    <button
      type="button"
      className={row.isLive ? 'runs-row runs-row-live' : 'runs-row'}
      data-testid={`runs-row-${run.runId}`}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="runs-row-head">
        <span className={`runs-status ${status.className}`}>
          {/* aria-hidden: the status word right beside it is the accessible
              answer, the same "colour and glyph restate the word, never
              replace it" rule run-stage.ts's own doc comment states for the
              per-item chips this row deliberately does NOT reuse. */}
          <span aria-hidden="true">{status.glyph}</span>
          {status.label}
        </span>
        <span className="runs-row-project">{projectLabel(run.project)}</span>
        {modeLabel !== null && (
          <span className="run-mode-badge" data-testid={`runs-row-mode-${run.runId}`}>{modeLabel}</span>
        )}
        {/* task-17: only a LIVE entry can carry this — `pauseRequested` is
            derived per request against a run that still exists on disk, and an
            archived row has no live entry to derive it from. Reuses
            `.run-mode-badge` rather than minting a class: it is the same
            register (a small qualifier on the run's own headline) and sits in
            the same slot.
              bug-29 widened which rows can reach this, since `row.live` is no
            longer gated on freshness — a crashed run with an outstanding pause
            request now carries the badge where it used to be silent. That is
            right rather than incidental: the request is a real file on this
            machine's disk waiting at the run's next dispatch gate, and it is
            still waiting whether or not the run has stamped a heartbeat
            lately. */}
        {row.live?.pauseRequested === true && (
          <span className="run-mode-badge" data-testid={`runs-row-pausing-${run.runId}`}>pausing</span>
        )}
        <span className="runs-row-count">{completed}/{total}</span>
      </span>
      {wall !== null && <span className="runs-row-wall">{formatSpanCompact(wall)}</span>}
    </button>
  );
}

/**
 * task-21's placeholder row: a run this server spawned whose `run.json` does
 * not exist yet. `StartingStrip`'s counterpart on this surface, and
 * deliberately a separate component rather than that one reused — a strip is
 * the board's own shape (its own frame, its own progress bar slot, its own
 * `.run-strips` stack), and mounting it inside `.runs-list` would put one
 * row in this list wearing a different layout from every other row in it.
 * What the two DO share is the fact they print and the ladder they print it
 * with: project, the word "starting", and `elapsedSince` — the same
 * formatter, already in `lib/`, so "now"/"2m" means the same thing on both
 * surfaces.
 *
 * Everything `RunRow` above prints comes off a run file, and the whole point
 * of this row is the 1–5 minutes in which that file does not exist: no
 * status chip off `runStatusChip`, no `completed/total`, no wall time. The
 * two facts that DO exist — which project was asked, and how long ago — are
 * the only two it carries, for the reason `StartingStrip`'s own comment
 * gives at length: a 0/0 count or an empty stage would be a claim about a
 * queue nothing has computed yet.
 *
 * A `<div>`, not the `<button>` `RunRow` is. There is no run to select:
 * `RunDetail` is keyed on project + runId and this row has no runId to give
 * it, so making it focusable would put a stop in the tab order that does
 * nothing when a keyboard reader reaches it. That is also why it takes no
 * `isSelected`/`onSelect` — it is outside `orderedRows` entirely, and
 * nothing about the selection can name it.
 */
function StartingRow({ starting, now }: { starting: StartingRun; now: number }): JSX.Element {
  // `null` — an unparseable or future `requestedAt` — prints an em dash
  // rather than `NaNm`, matching `StartingStrip`'s own `age ?? '—'` and the
  // `wall !== null` guard `RunRow` uses one component up.
  const age = elapsedSince(starting.requestedAt, now);

  return (
    <div className="runs-row runs-row-starting" data-testid={`runs-starting-${starting.project}`}>
      <span className="runs-row-head">
        <span className="runs-status runs-status-starting">
          {/* Hollow, never `RUN_STATUS_GLYPH.running`'s filled `●`: that
              glyph means "this run is reporting a heartbeat right now", and
              this one has not reported anything at all yet. aria-hidden for
              the same reason every other chip glyph in this file is — the
              word beside it is the accessible answer. */}
          <span aria-hidden="true">○</span>
          starting
        </span>
        <span className="runs-row-project">{projectLabel(starting.project)}</span>
        <span className="runs-row-starting-age">{age ?? '—'}</span>
      </span>
    </div>
  );
}

/** Which run is selected — `project` disambiguates a `runId` that, in principle, could collide across two different projects' state directories (the id is a second-precision timestamp, not a global counter). */
interface Selection {
  project: string;
  runId: string;
}

/**
 * How many history rows the list renders before `load more` (task-16), and
 * how many each click of that control adds.
 *
 * Exported so the suite can assert the RELATION ("renders exactly
 * RUNS_PAGE_SIZE rows") rather than pinning a bare 25 in two files that can
 * then drift apart — the same reason MACHINE_STAGES is a named export rather
 * than a list retyped at each call site.
 *
 * 25 is roughly a week and a half of history at the ~2–3 runs/day this
 * machine's busiest project actually produces: enough that a first visit to
 * `all` reads as a complete picture rather than a truncated one, short enough
 * that the bounded box above scrolls a few times over rather than dozens.
 */
export const RUNS_PAGE_SIZE = 25;

export default function RunsView() {
  const { runs: archiveRuns, refresh: refreshArchive } = useOrchestratorArchive();
  // task-21: `starting` rides the same payload and the same poll `liveRuns`
  // does — the hook already ORs `starting.length > 0` into its own "keep
  // polling" predicate, so reading it here adds no request. It is taken
  // straight, with NO client-side collision filter beside it: the rule that
  // a project with a `running` run file (fresh or crashed) carries no
  // starting entry at all lives in `StartingRunsService.expired()` on the
  // server (bug-21's third eviction rule, tested in
  // test/orchestrator-starting.test.ts), which is exactly why BoardView
  // deleted the filter it used to have. Restating that rule here would be a
  // second expression agreeing with the first — the shape `watchdogStoodDown`
  // and `isStale` are each one function to avoid, and the one this repo has
  // already been bitten by twice.
  const { runs: liveRuns, starting, refresh: refreshRuns, noteResume, resuming } = useOrchestratorRuns();
  // task-17: the environment half of the resume gate, the same answer the
  // board derives for its own strips. Read here rather than inside
  // `RunControls` so the two hosts keep handing the component one prop
  // rather than each reaching for the hook themselves — `resumeGate` is the
  // single implementation, and the component stays free of a data source.
  const { status: agents } = useAgents();
  // Persisted, unlike the two filters below it — see `lib/runs-mode.ts` for
  // why a mode is section-like where a filter is not. Read back through
  // `isRunsMode` because localStorage can hand back anything at all
  // (an older build, a hand edit, a `JSON.parse` of a number), and the one
  // outcome this section must never have is rendering neither surface.
  const [storedMode, setStoredMode] = usePersistedState<string>(RUNS_MODE_KEY, 'runs');
  const mode = isRunsMode(storedMode) ? storedMode : 'runs';
  const [projectFilter, setProjectFilter] = useState<string>('all');
  // Component state, not persisted — same as `projectFilter` immediately
  // above, and for the same reason: a saved range would silently reopen the
  // section scoped to whatever a person last looked at instead of the
  // default "all runs" view a fresh visit should show.
  const [range, setRange] = useState<RunRange>('all');
  const [selected, setSelected] = useState<Selection | null>(null);
  // task-16's window over `history`. Component state and NOT persisted, for
  // exactly the reason the two above already state for themselves: a saved
  // window would silently reopen this section at whatever height someone
  // last left it, so the same view would have two different heights
  // depending on a decision made in a previous visit nobody remembers
  // making.
  const [windowSize, setWindowSize] = useState(RUNS_PAGE_SIZE);
  // The scroll container `load more` hands focus back to when the click that
  // exhausts the list unmounts the button under the pointer (see the control
  // itself below).
  const listRef = useRef<HTMLDivElement | null>(null);

  // Both the range control and the project filter NARROW the corpus, so both
  // reset the window to its first page. Carrying a raised window across a
  // change would mean all -> today -> all leaves the list taller than a
  // first visit to `all` ever did — the same view at two heights depending
  // on the path taken to it.
  //
  // An effect keyed on the two values, deliberately not a changing `key` on
  // the list that would remount it: a remount would also destroy `selected`,
  // and a reset must leave a selection whose run is still in range alone
  // (see `selectedRow` below — it is resolved against the UNWINDOWED
  // `orderedRows` precisely so the pane keeps describing a run whose row the
  // reset pushed below the window).
  useEffect(() => {
    setWindowSize(RUNS_PAGE_SIZE);
  }, [range, projectFilter]);

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
  // off `merged`, not off `inScope`/`filtered` below, so narrowing EITHER
  // the range or the project filter never removes an option that would
  // switch back: a project with no runs in the selected range must still
  // appear in this select, or there would be no way to widen back to it.
  const projects = Array.from(new Set(merged.map((m) => m.run.project)))
    .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));

  // Range scoping runs BEFORE the project filter, not merely alongside it:
  // `inRange` reads only `startedAt` (lib/run-range.ts's own file header
  // states why that field, and no other, is what a range window is keyed
  // on), so this pass can run directly off `merged` with no dependency on
  // which project is currently selected, and the project filter below then
  // narrows whatever the range already left in scope exactly the way it
  // always narrowed `merged` before this task existed.
  const inScope = merged.filter((m) => inRange(m.run.startedAt, range, now));
  const filtered = projectFilter === 'all' ? inScope : inScope.filter((m) => m.run.project === projectFilter);
  // The project filter applies to the placeholder rows; the RANGE control
  // deliberately does not. `inRange` reads `startedAt` and only `startedAt`
  // (lib/run-range.ts's own header states why no other field is a legitimate
  // window key), a starting entry has no `startedAt` at all — it has
  // `requestedAt`, the moment THIS process was asked — and every one of the
  // four windows this view offers ends at now, so an entry marked seconds
  // ago is inside all four by construction. Rendering it regardless of range
  // is therefore not an exemption from the range rule, it is that rule's own
  // answer, reached without teaching `inRange` a second date field it would
  // then have to justify.
  //
  // Note this filters `starting`, never `merged`/`filtered`: a placeholder is
  // not a run, so it stays out of `orderedRows`, out of `selectedRow`, out of
  // `aggregateRuns`/`sumStageTotals` and out of the `projects` option list
  // below. A window that showed a number for it would be inventing one.
  const startingRows = projectFilter === 'all' ? starting : starting.filter((s) => s.project === projectFilter);
  // Pinning is computed AFTER filtering, not before: a project filter that
  // hides the only fresh run in scope must not leave a phantom "live" group
  // heading over an empty rows list, and the design's own "newest VISIBLE
  // run" wording for the default selection below only makes sense read
  // against whatever the filter currently shows.
  const { pinned, history } = splitPinned(filtered);
  // task-16's window, and the ONE place it applies. Which lists are windowed
  // and which deliberately are not is the whole rule, and it is the kind of
  // thing fix rounds 2 and 3 in this file already went wrong on (a call site
  // quietly reading a different source than its neighbours), so it is worth
  // stating outright:
  //
  //   windowed  — `groupByDay`'s input, and nothing else. The list is a
  //               window; every other reader wants the whole corpus.
  //   NOT       — `pinned`. A run still going since three days ago must
  //               render regardless of its own startedAt, which is the
  //               entire reason `splitPinned` exists; paging that row away
  //               is the exact failure that split was written to prevent.
  //               The "one run per project" invariant caps this region at
  //               one row per registered project, so it cannot grow the way
  //               history can and leaves no hole in the bound.
  //   NOT       — `orderedRows`/`selectedRow` (selection survives a reset
  //               that pushes its row out of the window), `filtered` (the
  //               aggregate tiles and the wide machine-time tile). A window
  //               is a RENDERING decision and must not move a single number
  //               in the tiles.
  //
  // The slice lands between `splitPinned` and `groupByDay` and nowhere else,
  // which is what makes a boundary falling mid-day render correctly: window
  // first, group second, so a partially-revealed day renders its own heading
  // over exactly the rows revealed and the next `load more` extends that
  // same group rather than emitting a second heading for the same key.
  const windowed = history.slice(0, windowSize);
  const hiddenCount = history.length - windowed.length;
  const groups = groupByDay(windowed);

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

  // Fix round 3: this used to be `filtered.map((m) => m.run)` — the
  // ARCHIVE record for every run, live-backed or not. A re-review caught
  // the consequence: `RunRow` (above) had already been fixed to read
  // merged/total and status off `pickAuthority([row.live], row.run)`, but
  // the tiles below still summed the raw archive snapshot, so an item
  // merging mid-run ticked the pinned row's own count up (1/6 -> 2/6) while
  // this "completed / queued" tile a few tiles away stayed frozen at
  // whatever the last archive fetch saw — the exact I2 defect class (row and
  // tile disagreeing about one run's numbers), relocated from the detail
  // pane to the aggregate tiles rather than fixed everywhere at once. Mapping
  // through the same `pickAuthority` call `RunRow` already uses closes it
  // the same way: every run in scope contributes its freshest known queue,
  // not whichever snapshot happened to be sitting in the archive payload.
  const aggregates = aggregateRuns(filtered.map((m) => pickAuthority([m.live], m.run)), now);

  // Task 7's own generalization of the identical fix-round-3 rule
  // immediately above: the wide "machine time by stage" tile sums
  // `runStageTotals` (lib/run-stats.ts, Task 2) over the SAME
  // `pickAuthority`-resolved authority every other cross-run number on this
  // page already reads, for the identical reason — a live-backed run's
  // still-open span has to come from its fresh live queue, not a stale
  // archive snapshot frozen mid-run. `runStageTotals` itself gates that open
  // span on `status === 'running'` (that function's own doc comment has the
  // full reasoning for why an archived, stopped run must never contribute
  // one), which is exactly why `pickAuthority`'s result — carrying a real
  // `status`, live or archived — is what gets passed to it, never a bare
  // `.queue` plucked out on its own.
  const machine = sumStageTotals(filtered.map((m) => runStageTotals(pickAuthority([m.live], m.run), now)));

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
    // `runs-board` (task-16) is the modifier that bounds this section to one
    // viewport — see its rule in styles.css for why the height is derived
    // from layout rather than a `calc(100vh - <chrome>px)` constant.
    // BoardView and ArchiveView keep rendering a bare `.board`.
    <div className="board runs-board">
      <div className="board-bar">
        <div className="board-title">Runs</div>
        <div className="board-tools">
          {mode === 'runs' && merged.length > 0 && (
          <>
            {/* The range control (Task 7) — see styles.css's own `.runs-seg`
                comment for why this is a segmented button group and not a
                fifth `<select>` beside the project one. `role="group"` +
                `aria-label` name the whole cluster for assistive tech the
                way a `<fieldset>` would without that element's own layout;
                each button's own `aria-pressed` (not a shared radio input)
                states ITS membership in the group, matching the semantics
                an exclusive toggle set is supposed to carry. */}
            <div className="runs-seg" role="group" aria-label="Range" data-testid="runs-range">
              {RUN_RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  data-testid={`runs-range-${r}`}
                  aria-pressed={r === range}
                  onClick={() => setRange(r)}
                >
                  {RANGE_BUTTON[r]}
                </button>
              ))}
            </div>
            <select
              className="board-select"
              aria-label="Project"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="all">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{projectLabel(p)}</option>)}
            </select>
            {/* Inert, and inside this fragment on purpose: it appears exactly
                when the filters do, so watchdog mode never shows an orphan
                rule beside a lone switch. Its job is grouping — three
                controls in one row, two of which scope history and one of
                which picks the surface, should not read as one instrument. */}
            <span className="board-tools-divider" aria-hidden="true" data-testid="runs-tools-divider" />
          </>
          )}
          {/* task-18's mode switch, and the one tool in this bar that sits
              OUTSIDE the `merged.length > 0` condition wrapping the two
              above it: those two scope run history, so with no history
              there is nothing for them to do, while the watchdog has a
              phase to report whether or not this project has ever finished
              a run. Same `.runs-seg` idiom, same `role="group"` +
              `aria-label` + per-button `aria-pressed` semantics as the
              range control — see that control's own comment for why a
              segmented button group and not a fifth `<select>`.

              task-26 made it the LAST child rather than the first, and that
              order is load-bearing rather than taste: `.board-tools` is
              right-anchored (`margin-left: auto`), so a first child slides
              right by the width of whatever unmounts beside it — clicking
              Watchdog unmounted the range control and the project select
              and moved this switch out from under the pointer that had just
              clicked it, then clicking Runs slid it back. Last, its right
              edge is pinned by the bar and the two filters come and go on
              its left. */}
          <div className="runs-seg" role="group" aria-label="View" data-testid="runs-mode">
            {RUNS_MODES.map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`runs-mode-${m}`}
                aria-pressed={m === mode}
                onClick={() => setStoredMode(m)}
              >
                {MODE_BUTTON[m]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === 'watchdog' ? (
        // The whole body, replaced — not a panel wedged above the list. The
        // two modes answer different questions ("what has this orchestrator
        // ever done" vs "what is the sweeper doing right now"), and the
        // alternative designs that kept both on screen at once each spent a
        // permanent bar or a fake list row on the one a person was not
        // asking. `liveRuns` is this component's own array, handed down
        // rather than re-fetched.
        <WatchdogMonitor
          runs={liveRuns}
          onSelectRun={(project, runId) => {
            // Back to Runs, on that run's detail: a monitor row IS a run in
            // the list. A key that names no row right now (a filtered-out or
            // archive-less run) resolves through `selectedRow`'s existing
            // lookup exactly as any other stale selection does — the mode
            // still switches, and the pane falls back to the default row.
            setStoredMode('runs');
            setSelected({ project, runId });
          }}
        />
      ) : merged.length === 0 && startingRows.length === 0 ? (
        // Task 5's own final copy for the genuinely-empty case, verbatim —
        // see this file's own header comment for why this is not
        // placeholder text being replaced, only reached by a real check now.
        //
        // task-21 added the second half of the condition, and it is the whole
        // point of that task: a project's FIRST run, in the 1–5 minutes before
        // `init` writes `run.json`, has an empty archive and an empty live
        // payload, so this string was what someone saw right after pressing
        // Orchestrate — "the click did nothing", stated by the one surface a
        // run is meant to be watched from.
        //
        // The consequence of falling through with `merged.length === 0` is
        // deliberate rather than tolerated: the tiles below render zeros and
        // dashes, the list renders the starting row alone, and the detail pane
        // renders nothing. Every one of those is true. A separate
        // starting-only branch was the alternative and was rejected — it would
        // give the same view two different layouts depending on whether any
        // history existed, and the zeros are not a lie: this project has run
        // nothing yet, which is exactly why the row above them says starting.
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
            {/* Final whole-branch review, finding 1: this tile's VALUE
                (`itemsMerged`) already counted `branched` alongside `merged`
                per spec §4 — `aggregateRuns`'s own doc comment has always
                said so — but the LABEL still read "merged / queued", so a
                fully successful branch-mode run (nothing reached `main`)
                rendered "4/4 merged" over a queue that merged nothing at
                all. That is the exact failure spec §4 invented `branched` to
                stop, reappearing one level up in the tile's wording instead
                of its stored state. "completed" is the word `itemsMerged`'s
                own doc comment already uses to describe the union of both
                success exits, so the label now says what the number means
                instead of naming only one of the two ways to earn it. No
                arithmetic changed — see `test/runs-view.test.tsx`'s
                branch-mode fixture, which pins this tile at `2/2` for a run
                that merged zero of two items. */}
            <div className="runs-tile" data-testid="runs-tile-merged">
              <div className="runs-tile-value">{aggregates.itemsMerged}/{aggregates.itemsQueued}</div>
              <div className="runs-tile-label">completed / queued</div>
            </div>
            {/* "avg item work" (Task 7), not "avg item": `avgItemWorkMs`
                (RunAggregates' own doc comment has the full reasoning) is
                `itemDurationMs` averaged over completed items — merged or
                branched alike, per the same finding-1 correction as the tile
                above — first non-pending arrival to the terminal stamp —
                which deliberately EXCLUDES the queue-wait interval a bare
                "avg item" reading would leave a person assuming is included.
                The substat states the exclusion outright, matching how the
                wide tile below (and RunDetail's own rollup) already caveat
                the identical number rather than leaving it implicit. */}
            <div className="runs-tile" data-testid="runs-tile-avg-item">
              <div className="runs-tile-value">
                {aggregates.avgItemWorkMs === null ? '—' : formatSpanCompact(aggregates.avgItemWorkMs)}
              </div>
              <div className="runs-tile-label">avg item work</div>
              <div className="runs-tile-substat">queue wait excluded</div>
            </div>
            {/* "fix loops / merged" read as the MERGED-ONLY reading R1
                deliberately rejected (`RunAggregates.fixLoopsPerMerged`'s own
                doc comment): the numerator sums fix loops across every
                QUEUED item, including ones that never completed, because
                rework spent on an item that was ultimately parked or
                fix-exhausted is still cost this run paid on the way to
                whatever it did finish. The math never changed; only the
                label was wrong, so a reader who checked the number against
                the old caption could reasonably conclude a bug that was
                never there. The `title` below was corrected alongside the
                tile above (finding 1): it used to say "how many did merge",
                which is false for a branch-mode run's denominator
                (`itemsMerged` counts `branched` too) — but that pass fixed
                only the tooltip, leaving the VISIBLE label reading
                "rework / merge", the identical mislabel one tile over: a
                reader who never hovers still sees a claim that every
                completion reached `main`. This is finding 1's other half.
                "completed" is the word `itemsMerged`'s own doc comment uses
                for the union of both success exits, the same word the tile
                above already adopted, so this label now says what the
                denominator means instead of naming only one of the two ways
                to earn it. No arithmetic changed — see
                `test/runs-view.test.tsx`'s branch-mode fixture, which now
                pins this label (and its predecessor's) alongside the value
                each already had pinned. */}
            <div
              className="runs-tile"
              data-testid="runs-tile-fixloops"
              title="Total fix loops across every queued item, including ones that never finished, divided by how many completed — merged or branched — what each completion cost in rework."
            >
              <div className="runs-tile-value">
                {aggregates.fixLoopsPerMerged === null ? '—' : aggregates.fixLoopsPerMerged.toFixed(1)}
              </div>
              <div className="runs-tile-label">rework / completed</div>
            </div>
            <div className="runs-tile" data-testid="runs-tile-verify">
              <div className="runs-tile-value">
                {aggregates.verifyPassRate === null ? '—' : `${Math.round(aggregates.verifyPassRate * 100)}%`}
              </div>
              <div className="runs-tile-label">verify pass</div>
            </div>
            {/* The sixth, wide tile (Task 7) — `machine` (computed above,
                right beside `aggregates`) summed across whatever `filtered`
                currently holds, rendered through the identical `StageBars`
                widget `RunDetail`'s own per-run rollup already uses (Task 4),
                so the two read as one visual vocabulary at two different
                scopes: one run there, however many runs the range/project
                combination leaves in view here. `RANGE_SCOPE[range]` states
                which scope this particular rendering is, since — unlike
                RunDetail's rollup, which is always "this one run" — this
                tile's own meaning changes every time the range control does. */}
            <div className="runs-tile runs-tile-wide" data-testid="runs-tile-machine">
              <div className="runs-tile-head">
                <div className="runs-tile-label">machine time by stage</div>
                <span className="runs-tile-substat">{RANGE_SCOPE[range]} · queue wait excluded</span>
              </div>
              <StageBars totals={machine} testId="runs-tile-machine-bars" />
            </div>
          </div>

          <div className="runs-split">
            {/* `tabIndex={-1}` earns its place twice over (task-16): this is
                now a scrollable region, and a scrollable region needs a
                programmatic focus target — both for the exhausting-click
                handoff below and because a keyboard reader who scrolls it
                needs somewhere for focus to be. It is -1, not 0: the row
                buttons inside are what keep the region operable via Tab, so
                adding it to the tab order would only insert an extra stop
                before them. */}
            <div className="runs-list" data-testid="runs-list" ref={listRef} tabIndex={-1}>
              {/* task-21's placeholders, ABOVE the pinned live region and
                  therefore above everything: a run nobody can see yet is the
                  most recent thing that happened by construction, and it is
                  the one row on this list a person is actively waiting on.
                  Reading order is starting, then fresh live runs, then history
                  newest day first.

                  It reuses the `.runs-day` / `.runs-day-heading` /
                  `.runs-day-rows` chrome the pinned `live` region and every
                  calendar group already use, for that region's own stated
                  reason: the heading is what tells a reader this group is not
                  a day, and a second visual language for "here is a region"
                  would make three shapes out of one.

                  Outside the `filtered.length === 0` ternary below, not inside
                  either of its branches — the placeholder has to render
                  whether or not the current range/project combination left any
                  RUNS in scope, and those are two independent facts. */}
              {startingRows.length > 0 && (
                <div className="runs-day" data-testid="runs-day-starting">
                  <div className="runs-day-heading">starting</div>
                  <div className="runs-day-rows">
                    {startingRows.map((s) => (
                      <StartingRow key={`starting:${s.project}`} starting={s} now={now} />
                    ))}
                  </div>
                </div>
              )}
              {filtered.length === 0 ? (
                // Task 7's own empty state — a DIFFERENT fact from "no runs
                // yet" above (`merged.length === 0`), which stays reachable
                // only for a project with a genuinely empty history. This one
                // fires when the range/project combination leaves nothing in
                // `filtered` even though `merged` is not empty — the tiles,
                // the range control and the project select all stay mounted
                // around it (see this file's own header comment for why),
                // and no day groups render alongside it: `pinned`/`groups`
                // are themselves derived from `filtered`, so they are already
                // empty here regardless — this note exists for the READER,
                // not because the markup below would otherwise render
                // something wrong.
                // task-21: suppressed while a placeholder is showing, the
                // same rule "no runs yet" above follows and for the same
                // reason — an empty state describes a list with nothing in it,
                // and this list has a row. The two notes stay separate
                // conditions rather than one, because they answer different
                // questions and the starting row can coexist with either.
                startingRows.length > 0 ? null : (
                  <div className="drawer-empty" data-testid="runs-empty-range">no runs in this range</div>
                )
              ) : (
                <>
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
                  {/* task-16's `load more`, at the FOOT of the list and
                      INSIDE the scroll container — it is the end of the
                      list, not a fixture beside it, so it should arrive
                      under the last row rather than sit permanently in view
                      over a list it may not even apply to.
                        The label states the remaining count rather than
                      saying "more", so the button says what it will do — and
                      it is also what tells a reader that a selection whose
                      row sits below the window still has list underneath it
                      (see `selectedRow`'s own note).
                        The exhausting click is the case worth handling: it
                      unmounts this button from under the pointer, which
                      drops focus to <body> and strands a keyboard reader at
                      the top of the document. Handing focus to the list
                      container puts them at the region they were just
                      reading. The check is `hiddenCount <= RUNS_PAGE_SIZE`,
                      evaluated against the value this click is about to
                      consume, not a re-read of state that has not updated
                      yet. */}
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      className="runs-load-more"
                      data-testid="runs-load-more"
                      onClick={() => {
                        setWindowSize((n) => n + RUNS_PAGE_SIZE);
                        if (hiddenCount <= RUNS_PAGE_SIZE) listRef.current?.focus();
                      }}
                    >
                      load more ({hiddenCount} older)
                    </button>
                  )}
                </>
              )}
            </div>

            {/* RunDetail (Task 7) owns everything inside this wrapper; the
                wrapper itself — class and testid — stays here rather than
                moving into that component, since it is this file's own
                layout grid (.runs-split) that sizes it, the same reason
                .runs-list's rows live in this file rather than a component
                of their own.
                  `selectedRow` is typed `MergedRun | undefined`, and
                since task-21 the guard below is a REAL case rather than the
                defensive typing it used to be. The branch above no longer
                reads `merged.length === 0` alone: a project whose only entry
                is a starting placeholder reaches this pane with `orderedRows`
                genuinely empty, so `orderedRows[0]` is `undefined` and this
                slot renders nothing at all. That is the designed outcome —
                `RunDetail` is keyed on project + runId and a placeholder has
                no runId to give it, so an empty pane beside a starting row is
                strictly better than a pane inventing a run to describe.
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
                <RunDetail
                  summary={selectedRow.run}
                  live={selectedRow.live}
                  gate={resumeGate(agents, selectedRow.run.project)}
                  resuming={resuming.has(selectedRow.run.project)}
                  onChanged={(kind) => {
                    // `refreshRuns` alone is enough for a pause or a cancel:
                    // both flip `pauseRequested` on the live entry and change
                    // nothing the archive holds. A resume additionally needs
                    // the mark, since a paused run polls nothing by the
                    // ordinary rule. The archive's own refresh already fires
                    // when the fresh set changes.
                    if (kind === 'resume') noteResume(selectedRow.run.project);
                    refreshRuns();
                  }}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
