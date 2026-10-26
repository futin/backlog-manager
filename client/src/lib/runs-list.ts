import { remoteAsArchive, remoteAsLive } from './remote-run';
import { dayKey, dayLabel } from './run-stats';
import { isCompletedStage } from './run-time';
import type { OrchestratorArchiveRun, OrchestratorRun, OrchestratorRunsPayload, RemoteRun, RunStage } from '../../../shared/types';

/**
 * runs-list.ts — the Runs page's run-list derivations: folding the archive listing, the live poll and other machines' runs into one row list, splitting
 * it into the Live and History sheets, sorting each newest-first, bucketing History by its day in the shared zone (#241), and the per-row completed/total
 * count.
 *
 * `RunsView` is the only consumer today. These lived in RunsView.tsx until #284 moved them here, because every derivation has one home in `lib/`
 * (CLAUDE.md, Layout) and a pure function pinned by a direct unit test (test/runs-list.test.ts) cannot drift the way one exercised only through renders
 * can. A pure module: it imports nothing from `components/` and nothing React. The doc comments below came with the code — only their pointers into RunsView changed — and they are the record
 * of bug-29, M3 and task-38/48, which is why they run long.
 */

/** One row of the merged run list: the archive's own record of the run, plus the live entry backing it, if the live payload has one at all. */
export interface MergedRun {
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
   * The machine a REMOTE run ran on (multi-dashboard task 10): its configured name, else the raw host, `null` when the run recorded none. Absent — the key is
   * not there at all — on a local row, so a row's own shape says whether the run is this machine's.
   */
  machine?: string | null;
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

export type LiveRun = OrchestratorRunsPayload['runs'][number];

/**
 * `{project, runId}` as one string — the same composite identity RunsView's
 * `Selection` already carries, for the same reason: a `runId` is a second-
 * precision timestamp, not a global counter, so two different projects'
 * state directories could in principle produce the same one. Every place in
 * the Runs page that has to treat two run records as "the same run" — the
 * archive/live dedupe in `mergeRuns`, and the live-run-changed effect in
 * `RunsView` — builds the key this same way, so a future edit cannot key one
 * check on `runId` alone while the rest of the page keys on both (which is
 * exactly the inconsistency a whole-branch review flagged: `mergeRuns` used
 * to dedupe on bare `runId`, silently dropping a real run on the one-in-
 * however-many chance two projects' runs collide on the same second).
 */
export function runKey(project: string, runId: string): string {
  return `${project} ${runId}`;
}

/**
 * Folds the archive listing and the live poll into one row list.
 *
 * The archive is still the identity source for every row — id, project,
 * and which runs exist at all come from the archive listing only, per the
 * design doc, and a run that has JUST started, before the next archive
 * fetch (mount, window focus, or fix round 2's own targeted refresh in RunsView)
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
export function mergeRuns(
  archiveRuns: readonly OrchestratorArchiveRun[],
  liveRuns: readonly LiveRun[],
  remoteRuns: readonly RemoteRun[],
  labelByHost?: (host?: string) => string | null
): MergedRun[] {
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
    // Multi-dashboard task 10: the machine the run ran on. A remote's configured name when one owns the host, else the raw host — a person still sees WHERE
    // the run was even for a host no entry names — and `null` when the claims recorded no host at all. Set on remote rows only: a local row's shape is exactly
    // what it was, because a run on the machine you are looking at is never labelled.
    merged.push({
      run: remoteAsArchive(remote),
      live,
      isLive: live.fresh,
      remote: true,
      machine: remote.host === null ? null : (labelByHost?.(remote.host) ?? remote.host)
    });
  }
  return merged;
}

/** `Date.parse`, `-Infinity` instead of `NaN` — so a row with a corrupt `startedAt` sorts to the end of a descending list rather than throwing off every comparison it takes part in. */
export function parseStartedAt(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? -Infinity : at;
}

/** Newest first, by `startedAt`. Used within one sheet at a time (the Live rows, or the History rows) — see `splitLive` below for why the two are never sorted together. */
export function sortByStartedAtDesc(rows: readonly MergedRun[]): MergedRun[] {
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
export function splitLive(rows: readonly MergedRun[]): { live: MergedRun[]; history: MergedRun[] } {
  const going = (r: MergedRun): boolean => r.live !== null && (r.live.status === 'running' || r.live.status === 'paused');
  return {
    live: sortByStartedAtDesc(rows.filter(going)),
    history: sortByStartedAtDesc(rows.filter((r) => !going(r)))
  };
}

/** One day's worth of rows under one heading. */
export interface DayGroup {
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
export function groupByDay(rows: readonly MergedRun[], zone: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const key = dayKey(row.run.startedAt, zone) ?? 'unknown';
    const label = key === 'unknown' ? 'unknown' : (dayLabel(row.run.startedAt, zone) ?? 'unknown');
    const current = groups[groups.length - 1];
    if (current !== undefined && current.key === key) {
      current.rows.push(row);
    } else {
      groups.push({ key, label, rows: [row] });
    }
  }
  return groups;
}

/** Reading order for the tiles' by-status breakdown — active state first, then the three ways a run can have left it, worst-sounding last. */
// `paused` sits beside `running` rather than among the endings: it is the
// one non-running status a run can still leave, so the breakdown reads as
// "in flight" then "over" rather than interleaving the two.
export const STATUS_ORDER: readonly OrchestratorRun['status'][] = ['running', 'paused', 'done', 'aborted', 'failed'];

/**
 * Completed items over a run's whole queue — the same ratio the page's tiles
 * compute across every run in scope (`aggregateRuns`' own
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
 * same call for the page's tiles ("counted as completed, alongside merged",
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
export function queueCounts(run: { queue: readonly { stage: RunStage }[] }): { completed: number; total: number } {
  return {
    completed: run.queue.filter((q) => isCompletedStage(q.stage)).length,
    total: run.queue.length
  };
}
