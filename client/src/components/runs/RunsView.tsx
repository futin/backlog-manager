import { useEffect, useRef, useState } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { elapsedSince } from '../../lib/item-age';
import { useOrchestratorArchive } from '../../hooks/useOrchestratorArchive';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { useProjectSources } from '../../hooks/useProjectSources';
import { projectLabel } from '../../lib/project-label';
import { pickAuthority } from '../../lib/run-authority';
import { remoteAsArchive, remoteAsLive, runInvisibleElsewhere } from '../../lib/remote-run';
import { RANGE_BUTTON, RANGE_SCOPE, RUN_RANGES, inRange } from '../../lib/run-range';
import { RUN_STATUS_GLYPH, runDotTone, runStatusChip } from '../../lib/run-stage';
import { useRunsMode } from '../../hooks/useRunsMode';
import { aggregateRuns, dayKey, dayLabel, formatUsd, runStageTotals, runUsageTotals, runWallMs, sumStageTotals } from '../../lib/run-stats';
import { formatSpanCompact, lastReportedEntry } from '../../lib/run-time';
import { isCrashed, watchdogClause } from '../../lib/run-watchdog';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { DayKicker } from '../ui/Ledger';
import { Dot } from '../ui/Dot';
import { Figure, FigureStrip } from '../ui/Figure';
import { Pill } from '../ui/Pill';
import { Segmented } from '../ui/Segmented';
import { Sheet, SheetHead } from '../ui/Sheet';
import { RunDetail } from './RunDetail';
import { StageBars } from './StageBars';
import { WatchdogMonitor } from './WatchdogMonitor';
import type { RunRange } from '../../lib/run-range';
import { resumeGate } from '../../../../shared/agent';
import type { OrchestratorArchiveRun, OrchestratorRun, OrchestratorRunsPayload, RemoteRun, RunStage, StartingRun } from '../../../../shared/types';

/**
 * Runs — the board's third surface: history of every backlog-orchestrate run
 * across every registered project, not the single currently-running one the
 * board's own run chip counts in its band. The chip answers "is anything
 * running right now" and opens this section; this section answers "what has
 * this project's orchestrator ever done" — and, since task-37 took the
 * board's strip and drawer away, everything they used to say about a live
 * run too (the redesign's §8.4.1 lists each reading and where it lands).
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
 * Fix round 1: a live run leads the page, not merely sorted first by
 * `startedAt` — see `splitLive`'s own comment for the case a pure
 * chronological sort gets backwards (a run still going since days ago beside
 * a different project's run that merely finished more recently). This was the
 * approved design doc's decision from the start; the task brief that drove
 * this file's first version dropped it in transcription, and it is restored
 * here rather than left as a filed discrepancy — as the Live sheet, since
 * task-38.
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
 * filters applied in the same fixed order. The sixth cell (`Figure wide`,
 * `data-testid="runs-tile-machine"`) sums `runStageTotals` (Task 2) across
 * every run `filtered` currently holds through `StageBars` (Task 4) — the
 * identical "where did the time go" reading `RunDetail`'s own rollup gives
 * for one run, now folded across however many runs the range/project
 * combination leaves in view, and reading its stat off the SAME
 * `pickAuthority`-resolved authority `aggregates` above already reads, for
 * the identical fix-round-2/3 reason: a live-backed run's still-open span
 * has to come from its fresh live queue, never a stale archive snapshot
 * frozen mid-run.
 *
 * task-18 gives the section two PAGES, not one: History is everything
 * described above, and Watchdog is `WatchdogMonitor` — the sweeper's state,
 * the runs it is watching, and its activity feed, all of which used to sit on
 * the Settings page nobody has open while a run is going. Both read this
 * component's OWN payload (the monitor takes `liveRuns` as a prop rather than
 * fetching runs itself), so moving between them adds no request.
 *
 * task-38 (DESIGN.md §8.4, shape D of `03-runs-shape.html`) redraws that into
 * what this file is now, and four of its decisions are worth stating here
 * because each replaces something a reader of the older comments above would
 * otherwise go looking for:
 *
 *  1. **The mode switch is gone from this page.** task-36 gave the rail a
 *     sub-nav tree naming these same two views, and two controls doing one
 *     job is exactly what that rail work was for. `useRunsMode` is still the
 *     shared value; this component only reads it (and writes it once, for the
 *     Watchdog page's own jump back to History).
 *  2. **The figures LEAD the page** — band, then the strip, then the split
 *     (§8.4.1's "the statistics lead"). The six cells are the same six
 *     readings the old toolbar tiles carried, off the same `aggregateRuns`,
 *     which is why they keep their `runs-tile-*` test hooks: the tile became
 *     a `Figure`, the reading did not change, and renaming thirty assertions
 *     would have churned the suite without pinning anything new.
 *  3. **Live runs are a SHEET of their own, above history, not a pinned
 *     region inside it.** `splitPinned` became `splitLive` below, and its
 *     gate moved with it: the Live sheet holds every run this payload still
 *     lists as `running` or `paused`, freshness NOT considered, because a
 *     crashed run is precisely the row a person came here to see (§8.4.1's
 *     moved-rules table). The old pinned region gated on `isLive` (fresh),
 *     which is what used to drop a crashed run into history among finished
 *     ones; `MergedRun.isLive` survives as what it always was, the
 *     PRESENTATION flag, and is now read only for the breathing dot.
 *  4. **The detail is a sheet beside the list, never behind a click**, and
 *     it is the one place any run state offers a Resume — crashed and paused
 *     alike, through `RunControls` in its head.
 *
 * Emptying the range (or the range-and-project combination) does not empty
 * this whole section the way `merged.length === 0` does: the band and its
 * controls stay mounted (a range is a VIEW over an unchanged corpus, not a
 * reason to hide that the corpus exists — and a person needs the controls
 * still on screen to widen back out of the empty combination they just
 * created), and the figure strip hides with the list, which swaps its sheets
 * for one `no runs in this range` note.
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
   * (`splitLive` until task-38 moved the split off it) and the breathing dot,
   * and by nothing that
   * decides where a number comes from — that is `live`'s job, above.
   *
   * Kept as its own boolean rather than derived at each call site for the
   * reason it always was: it reads as intent where `live?.fresh === true`
   * would make a reader stop and re-derive the rule. Since bug-29 it is no
   * longer one more way to say `live !== null`; the two now genuinely
   * disagree for exactly the run this list used to freeze.
   */
  isLive: boolean;
  /**
   * Another machine's run (task-48), assembled from a tracker repo's claim
   * comments. Such a row has no archive record — `run` and `live` are both
   * built from the one `remote` entry — and it is read-only: the sheet draws
   * no controls for it and fetches no file, because there is none here.
   */
  remote: boolean;
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
function mergeRuns(archiveRuns: readonly OrchestratorArchiveRun[], liveRuns: readonly LiveRun[], remoteRuns: readonly RemoteRun[]): MergedRun[] {
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
    merged.push({ run, live, isLive: live?.fresh === true, remote: false });
  }
  // task-48: other machines' runs, appended after the archive's. The archive
  // can never hold one — the server drops a derived run whose runId any local
  // run file carries — so the `seen` check is the same defensive dedupe as
  // above rather than a merge. `live` is the remote entry itself, which is
  // what keeps `splitLive` unchanged: a remote `running` run is a Live row and
  // a finished one is a History row, by the same rule a local run follows.
  for (const remote of remoteRuns) {
    const key = runKey(remote.project, remote.runId);
    if (seen.has(key)) continue;
    seen.add(key);
    const live = remoteAsLive(remote);
    merged.push({ run: remoteAsArchive(remote), live, isLive: live.fresh, remote: true });
  }
  return merged;
}

/** `Date.parse`, `-Infinity` instead of `NaN` — so a row with a corrupt `startedAt` sorts to the end of a descending list rather than throwing off every comparison it takes part in. */
function parseStartedAt(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? -Infinity : at;
}

/** Newest first, by `startedAt`. Used within one sheet at a time (the Live rows, or the History rows) — see `splitLive` below for why the two are never sorted together. */
function sortByStartedAtDesc(rows: readonly MergedRun[]): MergedRun[] {
  return [...rows].sort((a, b) => parseStartedAt(b.run.startedAt) - parseStartedAt(a.run.startedAt));
}

/**
 * Splits the filtered row list into the LIVE sheet's rows and the History
 * sheet's — task-38's redraw of what `splitPinned` used to do for a pinned
 * region inside one list, with one deliberate change of gate.
 *
 * **The gate is "does the payload still list this run as going", not "is its
 * heartbeat fresh".** A run is a Live row when it has a live entry at all AND
 * that entry's status is `running` or `paused`. Both halves earn their keep:
 *
 *  - `live !== null` is what "the payload still lists it" means. A run whose
 *    `run.json` has been archived (`init` does that to the previous run before
 *    starting the next, paused runs included) has no live entry, so it is a
 *    past run — which is what makes a `paused` History row a real case rather
 *    than a contradiction of this sheet, and CLAUDE.md's "`init` archives a
 *    paused run like a done one" is the rule that produces it.
 *  - `status === 'running' || status === 'paused'` is the two statuses a run
 *    can still LEAVE. A run file that has reached `done`/`aborted`/`failed`
 *    but has not been archived yet is still in the payload, and it belongs in
 *    History: "a run reaches History when it has finished, not when it has
 *    stopped reporting" (§8.4.1).
 *
 * Freshness is deliberately NOT part of it, and that is the correction: the
 * old pinned region gated on `isLive` (i.e. `live.fresh`), so a crashed run —
 * `running` with a dead heartbeat — fell out of the pinned region and landed
 * in history among finished runs, where a reader scanning for trouble would
 * not look. §8.4.1's moved-rules table puts that row in the Live sheet with a
 * `--red` dot, a `crashed` pill and its own second line. `MergedRun.isLive`
 * still says exactly what it always said (is this board hearing from the
 * process right now) and is still read for the breathing dot; it is simply no
 * longer what decides which list a row is in.
 *
 * Both halves are sorted newest-first among THEMSELVES, never together. That
 * is what the pinned region was really for and it survives: a run going since
 * three days ago has to render above a different project's run that merely
 * finished this morning, because it is the one a person opened this page to
 * watch. Sorting the two lists separately makes that structural rather than a
 * comparator's special case.
 */
function splitLive(rows: readonly MergedRun[]): { live: MergedRun[]; history: MergedRun[] } {
  const going = (r: MergedRun): boolean => r.live !== null && (r.live.status === 'running' || r.live.status === 'paused');
  return {
    live: sortByStartedAtDesc(rows.filter(going)),
    history: sortByStartedAtDesc(rows.filter((r) => !going(r)))
  };
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
 * The two-tone count §7 gives every "spent over a ceiling" reading on this
 * board — `1 / 5`, the completed figure in `--ink` and the queue length in
 * `--ink3` at the same size. One component because both row kinds draw it and
 * §12.1's rule is that a shape more than one surface draws has one home; a
 * page-level composition rather than a `ui/` primitive because §12.2's table
 * does not list it and a task may not add one without amending that section.
 */
function CountPair({ completed, total }: { completed: number; total: number }): JSX.Element {
  return (
    <span className="runs-count">
      <span className="runs-count-done">{completed}</span>
      <span className="runs-count-total"> / {total}</span>
    </span>
  );
}

/**
 * One LIVE row (task-38, DESIGN.md §8.4.1) — a run this payload still lists as
 * `running` or `paused`, drawn as a **row, not a card**, compact enough for the
 * 420 px list column.
 *
 * What it carries, and nothing more: a `Dot`, the project at 14/500, `⚠ N` in
 * amber when the run has attention entries, the two-tone count, the elapsed
 * reading, and a status pill **only where one is earned** — `‖ paused`,
 * `⚠ crashed`, and nothing at all on a running, fresh run, whose state the
 * breathing dot and the elapsed reading already carry. Everything C's live
 * card carried that no longer fits this width — the run id and start clock,
 * the heartbeat word, `$ · turns · sessions`, the mode pill, `paused after
 * <id>`, the current item's stage track — is in the detail sheet, which is
 * beside this list rather than behind a click.
 *
 * **A crashed run's three readings travel together or this row says less than
 * the strip it replaces did** (§8.4.1's moved-rules table): a `--red` dot, a
 * `crashed` pill, and a second amber line carrying `no heartbeat for <age>`,
 * then `last reported <id> at <stage>` or `all items at rest`, then
 * `watchdogClause`'s own sentence. All three are in ONE element (`data-testid`
 * `runs-live-crashed-<runId>`) precisely so a later edit cannot drop one of
 * them silently — the suite asserts the line, not three independent nodes.
 *
 * Every number comes off `pickAuthority([row.live], run)` — the same
 * freshest-wins rule the detail sheet applies — so a row and the sheet beside
 * it can never print different counts for one run (fix rounds 2 and 3).
 */
function LiveRow({ row, now, isSelected, onSelect }: { row: MergedRun; now: number; isSelected: boolean; onSelect: () => void }): JSX.Element {
  const { run } = row;
  const authority = pickAuthority([row.live], run);
  // bug-29: the status word, glyph and class, with `running` + a dead
  // heartbeat substituted to `crashed`. Derived from `row.live`, never from
  // `authority` — `authority` can be the archive record, which carries no
  // `fresh` field. See `runStatusChip` (lib/run-stage.ts) for why `crashed`
  // stays derived rather than becoming a sixth `RunStatus`.
  const status = runStatusChip(authority.status, row.live);
  const tone = runDotTone(authority.status, row.live);
  const crashed = row.live !== null && isCrashed(row.live);
  const { completed, total } = queueCounts(authority);
  const wall = runWallMs(authority, now);
  const attention = authority.attention.length;
  // The crashed row's own second line, composed once. `elapsedSince` is the
  // same ladder the card's in-progress bar and the old strip both read, so
  // "2m" means the same thing on every surface that prints an age.
  const age = row.live === null ? null : elapsedSince(row.live.updatedAt, now);
  // `lastReportedEntry` (lib/run-time.ts), never a hand-written scan: it is
  // the one implementation of "the entry a crashed run was last working", and
  // it is what the old crashed strip printed from too.
  const reported = row.live === null ? null : lastReportedEntry(row.live.queue);
  const clause = crashed && row.live !== null ? watchdogClause(row.live.watchdog, now) : '';

  return (
    <button type="button" className="runs-row" data-testid={`runs-row-${run.runId}`} aria-current={isSelected ? 'true' : undefined} onClick={onSelect}>
      <span className="runs-row-head">
        {/* `breathe` only while this board is actually hearing from the
            process (§8.8): a ring pulsing around a crashed or paused run
            would be an animation asserting something false. */}
        {tone === undefined ? <Dot size={10} /> : <Dot size={10} tone={tone} breathe={row.isLive} />}
        <span className="runs-row-project">{projectLabel(run.project)}</span>
        {row.remote && <RemoteTag runId={run.runId} />}
        {attention > 0 && (
          <span className="runs-row-attn" data-testid={`runs-row-attn-${run.runId}`}>
            <span aria-hidden="true">⚠ </span>
            {attention}
          </span>
        )}
        <CountPair completed={completed} total={total} />
        <span className="runs-row-wall">{wall === null ? '—' : formatSpanCompact(wall)}</span>
        {/* Earned, never decorative: a running, fresh run draws no pill at
            all. `crashed` is `warn`, not `bad` — the run may still be
            recovered unattended, which is the same call the old strip made
            for its amber border. */}
        {crashed ? (
          <Pill tone="warn">
            <span aria-hidden="true">⚠ </span>
            {status.label}
          </Pill>
        ) : (
          authority.status === 'paused' && (
            <Pill tone="neutral">
              <span aria-hidden="true">‖ </span>
              paused
            </Pill>
          )
        )}
      </span>
      {crashed && (
        <span className="runs-row-crashed" data-testid={`runs-live-crashed-${run.runId}`}>
          {[
            `no heartbeat for ${age ?? '—'}`,
            reported === null ? 'all items at rest' : `last reported ${reported.id} at ${reported.stage}`,
            clause === '' ? null : clause
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </span>
      )}
    </button>
  );
}

/**
 * task-21's placeholder row: a run this server spawned whose `run.json` does
 * not exist yet. The Live sheet's first rows, above every real one — a run
 * nobody can see yet is the most recent thing that happened by construction,
 * and it is the row a person is actively waiting on.
 *
 * Everything `LiveRow` above prints comes off a run file, and the whole point
 * of this row is the 1–5 minutes in which that file does not exist: no status
 * chip, no `completed/total`, no wall time. The two facts that DO exist —
 * which project was asked, and how long ago — are the only two it carries,
 * because a `0/0` count or an empty stage would be a claim about a queue
 * nothing has computed yet.
 *
 * **A `<div>`, not the `<button>` `LiveRow` is, and it CANNOT be selected**
 * (§8.4.1's moved-rules table states that outright). There is no run to show:
 * `RunDetail` is keyed on project + runId and this row has no runId to give
 * it, so making it focusable would put a stop in the tab order that does
 * nothing when a keyboard reader reaches it. That is also why it takes no
 * `isSelected`/`onSelect` — it is outside `orderedRows` entirely, and nothing
 * about the selection can name it.
 */
function StartingRow({ starting, now }: { starting: StartingRun; now: number }): JSX.Element {
  // `null` — an unparseable or future `requestedAt` — prints an em dash
  // rather than `NaNm`, matching the `wall !== null` guard one component up.
  const age = elapsedSince(starting.requestedAt, now);

  return (
    <div className="runs-row runs-row-starting" data-testid={`runs-starting-${starting.project}`}>
      <span className="runs-row-head">
        {/* No tone: `.ui-dot`'s base `--ink3` is the honest paint for a run
            that has not reported anything at all yet. Never the live fill,
            which means "heartbeating right now" everywhere in this app, and
            never amber — starting is the most ordinary thing a run can be
            doing, not a state anyone needs to look at. */}
        <Dot size={10} />
        <span className="runs-row-project">{projectLabel(starting.project)}</span>
        {/* Its OWN class, not `.runs-row-wall`: what a real row prints there
            is a wall time off a run file, and this row's whole point is the
            window in which that file does not exist. An age is a different
            reading and says so. */}
        <span className="runs-row-starting-age">{`starting… · ${age ?? '—'}`}</span>
      </span>
    </div>
  );
}

/**
 * One HISTORY row (task-38, DESIGN.md §8.4.1) — a past run, at 44 px: the dot
 * **and the status word** from `runStatusChip`, the project at 14/500, the
 * two-tone count, the wall time and the cost beside it when usage exists.
 *
 * The word is not decoration and this is the one row where that has to be said
 * outright: a dot alone cannot tell `done`, `aborted` and `failed` apart, and
 * three colours of the same dot is the encoding §5 rules out — so the dot
 * carries only whether the run is still a going concern (`runDotTone` returns
 * no tone for every finished run) and the word carries which ending it was.
 *
 * A row **selects** the run into the detail sheet. Nothing opens: there is no
 * run modal on this page and none anywhere in this redesign.
 */
function HistoryRow({ row, now, isSelected, onSelect }: { row: MergedRun; now: number; isSelected: boolean; onSelect: () => void }): JSX.Element {
  const { run } = row;
  const authority = pickAuthority([row.live], run);
  const status = runStatusChip(authority.status, row.live);
  const tone = runDotTone(authority.status, row.live);
  const { completed, total } = queueCounts(authority);
  const wall = runWallMs(authority, now);
  // task-27. Off `authority` like every other number on this row, for the
  // same reason: a live-backed row must not print a total the sheet beside it
  // has already moved past. `null` for every run archived before the feature
  // existed — those runs carry no `usage` key at all, and this row renders
  // nothing extra for them rather than a `$0.00` that would read as a claim.
  // Cost alone here, not cost AND turns: the row has one slot's worth of
  // room, and "what did it cost" is the question this list is scanned for.
  // Turns are in the detail sheet, per item and per run.
  const usage = runUsageTotals(authority);
  const cost = usage === null || usage.costUsd === null ? null : formatUsd(usage.costUsd);

  return (
    <button
      type="button"
      className="runs-row runs-row-past"
      data-testid={`runs-row-${run.runId}`}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="runs-row-head">
        {tone === undefined ? <Dot /> : <Dot tone={tone} />}
        {/* aria-hidden on the glyph alone: the status word right beside it is
            the accessible answer, the same "colour and glyph restate the
            word, never replace it" rule run-stage.ts states for every chip
            in this app. */}
        <span className={`runs-status ${status.className}`} data-testid={`runs-row-status-${run.runId}`}>
          <span aria-hidden="true">{status.glyph}</span>
          {status.label}
        </span>
        <span className="runs-row-project">{projectLabel(run.project)}</span>
        {row.remote && <RemoteTag runId={run.runId} />}
        <CountPair completed={completed} total={total} />
        {/* The row's right-hand reading: wall time, and what the run cost.
            Either half can be known without the other — a run with a corrupt
            `startedAt` has no honest wall time and still has its transcripts'
            cost, and every pre-task-27 run is the reverse — so this joins
            whichever halves exist rather than gating the second on the
            first. */}
        {(wall !== null || cost !== null) && (
          <span className="runs-row-wall" data-testid={`runs-row-foot-${run.runId}`}>
            {[wall === null ? null : formatSpanCompact(wall), cost].filter((part) => part !== null).join(' · ')}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The `remote` tag on a row (task-48) — `ui/Pill`'s neutral tone, .claude/
 * DESIGN.md §1's status micro-label as §8 applies it: a pill states a fact and
 * is never clickable, and "another machine ran this" is a fact, not a state
 * anyone is waiting on, so it takes the tone that carries no urgency.
 */
function RemoteTag({ runId }: { runId: string }): JSX.Element {
  return (
    <span data-testid={`runs-row-remote-${runId}`}>
      <Pill tone="neutral" title="Driven from another machine — seen through its claim comments">
        remote
      </Pill>
    </span>
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
  const { runs: liveRuns, starting, remote: remoteRuns, refresh: refreshRuns, noteResume, resuming } = useOrchestratorRuns();
  // task-48: which projects are tracker-backed, for the one line a local run
  // that has not claimed an issue yet carries in its detail sheet.
  const projectSources = useProjectSources();
  // task-17: the environment half of the resume gate. Read here rather than
  // inside `RunControls` so that component stays free of a data source —
  // `resumeGate` (shared/agent.ts) is the single implementation, and a
  // component that reached for the hook itself would be a second place the
  // gate could be derived.
  const { status: agents } = useAgents();
  // Which of the section's two PAGES is showing. Persisted, unlike the two
  // filters below it — see `lib/runs-mode.ts` for why a view is section-like
  // where a filter is not — and read back through `isRunsMode` because
  // localStorage can hand back anything at all (an older build, a hand edit,
  // a `JSON.parse` of a number); the one outcome this section must never have
  // is rendering neither page. That guard lives inside `useRunsMode`.
  //
  // task-38 took the in-page segmented control that used to WRITE this away:
  // the rail's sub-nav tree (task-36, DESIGN.md §8.0) is where the two views
  // are named, and two controls doing one job is exactly what that rail work
  // was for. The setter survives for one caller — the Watchdog page's own row
  // click, which jumps to History and selects the run there, because under
  // shape D the run's detail IS that page's sheet and there is nowhere else
  // for it to go.
  const [mode, setStoredMode] = useRunsMode();
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
  // the Board showed it live a click away.
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

  const merged = mergeRuns(archiveRuns, liveRuns, remoteRuns);

  // Every project seen anywhere in the (unfiltered) merged list — computed
  // off `merged`, not off `inScope`/`filtered` below, so narrowing EITHER
  // the range or the project filter never removes an option that would
  // switch back: a project with no runs in the selected range must still
  // appear in this select, or there would be no way to widen back to it.
  const projects = Array.from(new Set(merged.map((m) => m.run.project))).sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));

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
  // The split is computed AFTER filtering, not before: a project filter that
  // hides the only going run in scope must not leave a phantom Live sheet
  // over an empty rows list, and the design's own "newest VISIBLE run"
  // wording for the default selection below only makes sense read against
  // whatever the filter currently shows.
  const { live: liveRows, history } = splitLive(filtered);
  // task-16's window, and the ONE place it applies. Which lists are windowed
  // and which deliberately are not is the whole rule, and it is the kind of
  // thing fix rounds 2 and 3 in this file already went wrong on (a call site
  // quietly reading a different source than its neighbours), so it is worth
  // stating outright:
  //
  //   windowed  — `groupByDay`'s input, and nothing else. The list is a
  //               window; every other reader wants the whole corpus.
  //   NOT       — `liveRows`. A run still going since three days ago must
  //               render regardless of its own startedAt, which is the
  //               entire reason `splitLive` exists; paging that row away is
  //               the exact failure that split was written to prevent. The
  //               "one run per project" invariant caps the Live sheet at one
  //               row per registered project, so it cannot grow the way
  //               history can and leaves no hole in the bound.
  //   NOT       — `orderedRows`/`selectedRow` (selection survives a reset
  //               that pushes its row out of the window), `filtered` (the
  //               aggregate tiles and the wide machine-time tile). A window
  //               is a RENDERING decision and must not move a single number
  //               in the tiles.
  //
  // The slice lands between `splitLive` and `groupByDay` and nowhere else,
  // which is what makes a boundary falling mid-day render correctly: window
  // first, group second, so a partially-revealed day renders its own heading
  // over exactly the rows revealed and the next `load more` extends that
  // same group rather than emitting a second heading for the same key.
  const windowed = history.slice(0, windowSize);
  const hiddenCount = history.length - windowed.length;
  const groups = groupByDay(windowed);

  // Reading order top to bottom: the Live sheet first (regardless of its
  // rows' own startedAt — see splitLive's own comment for why), then history
  // newest-day-first. Selection defaults to whatever leads that order — the
  // fresh run if one is visible, otherwise the newest historical row — which
  // is the concrete, order-following meaning of "the newest run (live one
  // wins if present)" now that "live wins" is a real precedence rather than
  // a same-millisecond tie-break.
  const orderedRows = [...liveRows, ...history];

  // The design brief's own wording is "defaulting to the newest VISIBLE run"
  // — visible, not newest overall — which is exactly why this is derived
  // from `orderedRows` (the FILTERED, ordered list) rather than from
  // `merged` directly. A `selected` pointer that no longer names a row in
  // the current filter (the project filter just changed out from under it,
  // or the row it named was dropped by a refetch) falls back the same way:
  // `find` returns `undefined` and the first row in reading order takes over
  // rather than the detail pane silently pointing at a run the list can no
  // longer show.
  const selectedRow =
    (selected !== null ? orderedRows.find((r) => r.run.project === selected.project && r.run.runId === selected.runId) : undefined) ?? orderedRows[0];

  // Fix round 3: this used to be `filtered.map((m) => m.run)` — the
  // ARCHIVE record for every run, live-backed or not. A re-review caught
  // the consequence: the row (above) had already been fixed to read
  // merged/total and status off `pickAuthority([row.live], row.run)`, but
  // the tiles below still summed the raw archive snapshot, so an item
  // merging mid-run ticked the Live row's own count up (1/6 -> 2/6) while
  // this "completed / queued" tile a few tiles away stayed frozen at
  // whatever the last archive fetch saw — the exact I2 defect class (row and
  // tile disagreeing about one run's numbers), relocated from the detail
  // pane to the aggregate tiles rather than fixed everywhere at once. Mapping
  // through the same `pickAuthority` call the rows already use closes it
  // the same way: every run in scope contributes its freshest known queue,
  // not whichever snapshot happened to be sitting in the archive payload.
  const aggregates = aggregateRuns(
    filtered.map((m) => pickAuthority([m.live], m.run)),
    now
  );

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

  // Shared by the Live sheet and every day group below: both render a list of
  // rows against the one `selectedRow` and `now` this render already
  // computed, and factoring the `.map` out once is what keeps the two render
  // sites from drifting on the `isSelected` comparison.
  //
  // `key` is `runKey(...)`, not bare `run.runId` — the same M3 fix as
  // `mergeRuns`' own dedupe, and for the identical reason: two different
  // projects' runs could in principle share a `runId` (a second-precision
  // timestamp, not a global counter), and React's own reconciliation reads
  // `key` for identity exactly the way this list already treats it
  // everywhere else.
  //
  // It takes the row COMPONENT rather than branching inside, because the two
  // rows are genuinely different shapes at the same width (§8.4.1) and a
  // single component forking on "am I live" would be one element carrying
  // both designs — the thing this redraw split apart.
  const renderRows = (rows: readonly MergedRun[], Row: typeof LiveRow): JSX.Element[] =>
    rows.map((row) => (
      <Row
        key={runKey(row.run.project, row.run.runId)}
        row={row}
        now={now}
        isSelected={selectedRow !== undefined && selectedRow.run.project === row.run.project && selectedRow.run.runId === row.run.runId}
        onSelect={() => setSelected({ project: row.run.project, runId: row.run.runId })}
      />
    ));

  // The band's three-state count line (§8.4.1) — `3 live · 1 starting · 28
  // past`, and the three counts are the three lists actually on this page, so
  // the line can never disagree with what is under it. A zero segment is
  // dropped rather than printed: `0 starting` is a fact nobody needs, and the
  // empty states below already say when there is nothing at all.
  const countLine =
    [
      liveRows.length === 0 ? null : `${liveRows.length} live`,
      startingRows.length === 0 ? null : `${startingRows.length} starting`,
      history.length === 0 ? null : `${history.length} past`
    ]
      .filter((part) => part !== null)
      .join(' · ') || undefined;

  if (mode === 'watchdog') {
    // Its own PAGE, with its own band — not a body swapped in under a shared
    // header (§8.4.2). `liveRuns` is this component's own array, handed down
    // rather than re-fetched, so switching pages adds no request.
    return (
      <div className="board runs-board">
        <WatchdogMonitor
          runs={liveRuns}
          /* The same three props the detail sheet hands `RunControls`, from
             the same `resumeGate` call and the same `resuming` mark — so the
             Resume the Watching sheet draws and the one the detail head draws
             are one control reading one gate, never two that agree. */
          gateFor={(project) => resumeGate(agents, project)}
          resuming={resuming}
          onChanged={(project, kind) => {
            if (kind === 'resume') noteResume(project);
            refreshRuns();
          }}
          onSelectRun={(project, runId) => {
            // Back to History, on that run's detail sheet: a monitor row IS a
            // run in that list. A key that names no row right now (a
            // filtered-out or archive-less run) resolves through
            // `selectedRow`'s existing lookup exactly as any other stale
            // selection does — the page still switches, and the sheet falls
            // back to the default row.
            setStoredMode('runs');
            setSelected({ project, runId });
          }}
        />
      </div>
    );
  }

  const empty = merged.length === 0 && startingRows.length === 0;

  return (
    // `runs-frame` (2026-09-17, DESIGN.md §8.4.1 "Wide") is a measuring element and nothing else: no padding, no background, no border. It carries
    // `container-type: inline-size` so the rule below it can ask how wide this SECTION actually is — which a media query cannot answer here, because the
    // board's width is the window minus a 280 px rail, minus `--body-pad` twice, minus whatever `.wrap`'s cap is doing, all of it divided by `.shell`'s
    // `zoom`. At 120% text a 1920 px window leaves about 1112 CSS px of board, and a media query would happily lay three columns into it.
    //   It wraps History alone. Watchdog returns above this point and renders no frame: it has no figure strip to stand as a rail, and a container nobody
    // queries is a containment boundary for free.
    //   The frame is HERE rather than on `.wrap` or `.main` for a reason worth stating where someone might "simplify" it: `container-type: inline-size`
    // applies layout containment, and a layout-contained element becomes the containing block for every `position: fixed` descendant. The item modal and
    // the form sheets are fixed and render inside `.wrap` with no portal, so a container up there would pin them to the section instead of the viewport.
    // Nothing under Runs positions itself fixed today; whatever does must portal to `body`.
    <div className="runs-frame">
      {/* `runs-board` (task-16) is the modifier that bounds this section to one
          viewport — see its rule in styles.css for why the height is derived
          from layout rather than a `calc(100vh - <chrome>px)` constant.
          BoardView and ArchiveView keep rendering a bare `.board`. */}
      <div className="board runs-board">
        <Band title="Runs" sub={countLine} className="runs-band">
          {/* The controls appear exactly when there is a corpus for them to
              scope. With none, the band is a title over the empty state below —
              a range control over nothing is an instrument with no subject. */}
          {merged.length > 0 && (
            <>
              {/* `RUN_RANGES`' four steps as ONE segmented control, not a fifth
                  `<select>`: a select is right for the open-ended list of
                  project names nobody has memorised the position of, and wrong
                  for four FIXED choices a person flips between constantly while
                  reading history — and "always visible" also means the active
                  range reads at a glance, which a collapsed select cannot
                  offer. */}
              <Segmented value={range} options={RUN_RANGES.map((r) => ({ value: r, label: RANGE_BUTTON[r] }))} onChange={setRange} label="Range" />
              {/* A `Chip` wrapping its own native `<select>` — the same shape
                  the Board's own filters wear (DESIGN.md §8.3), so a filter
                  looks like a filter on every page. `as: 'label'` is what makes
                  the chip the select's label rather than a button around it. */}
              <Chip as="label" data-testid="runs-project-chip">
                <select className="runs-project" aria-label="Project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
                  <option value="all">All projects</option>
                  {projects.map((p) => (
                    <option key={p} value={p}>
                      {projectLabel(p)}
                    </option>
                  ))}
                </select>
              </Chip>
            </>
          )}
        </Band>

        {empty ? (
          // Task 5's own final copy for the genuinely-empty case, verbatim.
          //
          // task-21 added the second half of the condition, and it is the whole
          // point of that task: a project's FIRST run, in the 1–5 minutes before
          // `init` writes `run.json`, has an empty archive and an empty live
          // payload, so this string was what someone saw right after pressing
          // Orchestrate — "the click did nothing", stated by the one surface a
          // run is meant to be watched from.
          <p className="board-note">no runs yet</p>
        ) : (
          <>
            {/* The figure strip, directly under the band — the statistics lead
                the page (§8.4.1). Six cells reading `aggregateRuns` and nothing
                else: no prior-period delta (nothing computes one), no parked
                count (the aggregate does not keep it), no invented ratio. It
                hides with the list when the range or project filter empties it,
                because a row of zeros over `no runs in this range` would be
                six readings about a set the page has just said is empty. */}
            {filtered.length > 0 && (
              <FigureStrip testId="runs-tiles" className="runs-stats">
                <Figure
                  testId="runs-tile-runs"
                  label="runs"
                  value={aggregates.runs}
                  line={
                    <span className="runs-figure-breakdown" data-testid="runs-figure-runs-line">
                      {STATUS_ORDER.map((status) => (
                        <span key={status} className="runs-figure-breakdown-item">
                          <span aria-hidden="true">{RUN_STATUS_GLYPH[status]}</span> {aggregates.byStatus[status]} {status}
                        </span>
                      ))}
                    </span>
                  }
                />
                {/* "completed", not "merged": `itemsMerged` counts `branched`
                    alongside `merged` per spec §4, so a fully successful
                    branch-mode run (nothing reached `main`) used to render
                    "4/4 merged" over a queue that merged nothing at all — the
                    exact failure `branched` was invented to stop, reappearing
                    in a label. The line states the definition rather than
                    glossing it. */}
                <Figure
                  testId="runs-tile-merged"
                  label="completed / queued"
                  value={`${aggregates.itemsMerged}/${aggregates.itemsQueued}`}
                  line="merged or branched"
                />
                {/* "avg item work", not "avg item": `avgItemWorkMs` is
                    `itemDurationMs` averaged over completed items, first
                    non-pending arrival to the terminal stamp, which
                    deliberately EXCLUDES the queue-wait interval a bare "avg
                    item" reading would leave a person assuming is included. The
                    line states the exclusion outright. */}
                <Figure
                  testId="runs-tile-avg-item"
                  label="avg item work"
                  value={aggregates.avgItemWorkMs === null ? '—' : formatSpanCompact(aggregates.avgItemWorkMs)}
                  line="queue wait excluded"
                />
                <Figure
                  testId="runs-tile-fixloops"
                  label="rework / completed"
                  value={aggregates.fixLoopsPerMerged === null ? '—' : aggregates.fixLoopsPerMerged.toFixed(1)}
                  line="fix loops per completed item"
                  title="Total fix loops across every queued item, including ones that never finished, divided by how many completed — merged or branched — what each completion cost in rework."
                />
                {/* A rate over verification RUNS, not items, and the line says
                    which — the unit is the whole claim. */}
                <Figure
                  testId="runs-tile-verify"
                  label="verify pass"
                  value={aggregates.verifyPassRate === null ? '—' : `${Math.round(aggregates.verifyPassRate * 100)}%`}
                  line="of every verification run"
                />
                {/* The sixth cell, full width: the same `StageBars` widget the
                    detail sheet's own per-run rollup uses, so the two read as
                    one visual vocabulary at two scopes — one run there, however
                    many runs the range/project combination leaves in view here.
                    `RANGE_SCOPE[range]` names which scope this rendering is,
                    since — unlike the sheet's rollup, which is always "this one
                    run" — this cell's meaning changes every time the range
                    control does. No `value`: at full width the chart is the
                    cell's subject rather than a sparkline beside a number. */}
                <Figure wide testId="runs-tile-machine" label="machine time by stage" line={`${RANGE_SCOPE[range]} · queue wait excluded`}>
                  <div className="runs-figure-bars">
                    <StageBars totals={machine} testId="runs-tile-machine-bars" />
                  </div>
                </Figure>
              </FigureStrip>
            )}

            <div className="runs-split">
              {/* The 420 px list column: the Live sheet, then the History
                  sheet. `tabIndex={-1}` earns its place twice over (task-16):
                  the History sheet inside it is a scroll region and a scroll
                  region needs a programmatic focus target — both for the
                  exhausting-click handoff below and because a keyboard reader
                  who scrolls it needs somewhere for focus to be. It is -1, not
                  0: the row buttons inside are what keep the region operable
                  via Tab, so adding it to the tab order would only insert an
                  extra stop before them. */}
              <div className="runs-list" data-testid="runs-list" ref={listRef} tabIndex={-1}>
                {/* The Live sheet, drawn only when it has rows. An empty one
                    would be a heading over nothing — and "nothing is running"
                    is already what its absence says. Starting placeholders sit
                    above every real row: a run nobody can see yet is the most
                    recent thing that happened by construction. */}
                {(liveRows.length > 0 || startingRows.length > 0) && (
                  <Sheet className="runs-live-sheet">
                    <SheetHead
                      title="Live"
                      sub={[
                        liveRows.length === 0 ? null : `${liveRows.length} ${liveRows.length === 1 ? 'run' : 'runs'}`,
                        startingRows.length === 0 ? null : `${startingRows.length} starting`
                      ]
                        .filter((part) => part !== null)
                        .join(' · ')}
                    />
                    <div className="runs-rows" data-testid="runs-live-rows">
                      {startingRows.map((entry) => (
                        <StartingRow key={`starting:${entry.project}`} starting={entry} now={now} />
                      ))}
                      {renderRows(liveRows, LiveRow)}
                    </div>
                  </Sheet>
                )}

                <Sheet className="runs-history-sheet">
                  <SheetHead title="History" sub={`${history.length} ${history.length === 1 ? 'run' : 'runs'} · ${RANGE_SCOPE[range]}`} />
                  {/* Three states, and the ORDER of the checks is the whole
                      rule: an empty History sheet has to say WHY it is empty,
                      and only one of the three reasons is the range.
                        `merged.length === 0` is first because it is the one
                      case where the range cannot possibly be the reason —
                      there is no corpus to filter. It is reachable only
                      alongside a starting placeholder (with nothing at all the
                      page shows `no runs yet` instead), which is exactly the
                      window task-21 exists for: a project's FIRST run, before
                      `run.json` is written. Printing `no runs in this range`
                      there would send a person hunting through a range control
                      for runs that do not exist yet.
                        Then the range/project combination, and last the case
                      where every run in scope is still going. */}
                  {merged.length === 0 ? (
                    <div className="drawer-empty" data-testid="runs-empty-history">
                      nothing has finished yet
                    </div>
                  ) : filtered.length === 0 ? (
                    // A DIFFERENT fact from "no runs yet" above
                    // (`merged.length === 0`), which stays reachable only for a
                    // project with a genuinely empty history. This one fires
                    // when the range/project combination leaves nothing in
                    // `filtered` even though `merged` is not empty — the band
                    // and its controls stay mounted around it, because a person
                    // needs them on screen to widen back out of the empty
                    // combination they just created.
                    <div className="drawer-empty" data-testid="runs-empty-range">
                      no runs in this range
                    </div>
                  ) : history.length === 0 ? (
                    // Third: there IS a corpus and the filters left something in
                    // scope, but every one of those runs is still going. The
                    // Live sheet above is showing them; this one has nothing to
                    // show yet, and the range is not why.
                    <div className="drawer-empty" data-testid="runs-empty-history">
                      nothing has finished yet
                    </div>
                  ) : (
                    <>
                      {groups.map((group) => (
                        <div key={group.key} className="runs-day" data-testid={`runs-day-${group.key}`}>
                          <DayKicker>{group.label}</DayKicker>
                          <div className="runs-rows">{renderRows(group.rows, HistoryRow)}</div>
                        </div>
                      ))}
                      {/* task-16's `load more`, at the FOOT of the sheet and
                          INSIDE its scroll box — it is the end of the list, not
                          a fixture beside it. The label states the remaining
                          count rather than saying "more", so the button says
                          what it will do, and it is also what tells a reader
                          that a selection whose row sits below the window still
                          has list underneath it.
                            The exhausting click is the case worth handling: it
                          unmounts this control from under the pointer, which
                          drops focus to <body> and strands a keyboard reader at
                          the top of the document. Handing focus to the list
                          container puts them back at the region they were
                          reading. The check is `hiddenCount <= RUNS_PAGE_SIZE`,
                          evaluated against the value this click is about to
                          consume, not a re-read of state that has not updated
                          yet. */}
                      {hiddenCount > 0 && (
                        <div className="runs-load-more">
                          <Chip
                            variant="flat"
                            data-testid="runs-load-more"
                            onClick={() => {
                              setWindowSize((n) => n + RUNS_PAGE_SIZE);
                              if (hiddenCount <= RUNS_PAGE_SIZE) listRef.current?.focus();
                            }}
                          >
                            load more ({hiddenCount} older)
                          </Chip>
                        </div>
                      )}
                    </>
                  )}
                </Sheet>
              </div>

              {/* The detail sheet — one run, whole, BESIDE the list rather than
                  behind a click. `RunDetail` owns everything inside it,
                  including the head; the sheet and its layout class stay here,
                  since it is this file's own `.runs-split` grid that sizes it.
                    `selectedRow` is typed `MergedRun | undefined`, and since
                  task-21 the guard below is a REAL case rather than defensive
                  typing: a project whose only entry is a starting placeholder
                  reaches here with `orderedRows` genuinely empty, so
                  `orderedRows[0]` is `undefined` and this sheet renders
                  nothing. That is the designed outcome — `RunDetail` is keyed on
                  project + runId and a placeholder has no runId to give it, so
                  an empty sheet beside a starting row is strictly better than
                  one inventing a run to describe.
                    `selectedRow.live` (fix round 2) — not a fresh lookup into
                  `liveRuns` — is where the LIVE object comes from: `mergeRuns`
                  already did the project-AND-runId-matched lookup once, when it
                  built this row, and carries the result on `MergedRun` itself.
                  Re-deriving the same match here would be a second place that
                  lookup could drift from the first. */}
              <Sheet as="aside" className="runs-detail">
                <div data-testid="run-detail-slot">
                  {selectedRow !== undefined && (
                    <RunDetail
                      summary={selectedRow.run}
                      live={selectedRow.live}
                      remote={selectedRow.remote}
                      invisibleElsewhere={runInvisibleElsewhere(
                        pickAuthority([selectedRow.live], selectedRow.run),
                        projectSources.get(selectedRow.run.project)
                      )}
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
              </Sheet>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
