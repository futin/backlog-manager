import { Fragment, useEffect, useState } from 'react';

import { useNow } from '../../hooks/useNow';
import { fetchArchivedRun } from '../../lib/agents';
import { pickAuthority } from '../../lib/run-authority';
import { projectLabel } from '../../lib/project-label';
import { mergeModeLabel, runDotTone, runStatusChip, stageChipClass, stageGlyph } from '../../lib/run-stage';
import { formatTurns, formatUsd, itemStageSpans, itemUsageTotals, runStageTotals, runUsageTotals, runWallMs } from '../../lib/run-stats';
import { isCrashed } from '../../lib/run-watchdog';
import { formatClock, formatSpan, formatSpanCompact, itemQueueWaitMs, runClockMs, runIsLive } from '../../lib/run-time';
import { RunControls, inFlightItemId } from '../RunControls';
import type { RunControlsChange } from '../RunControls';
import { Dot } from '../ui/Dot';
import { Pill } from '../ui/Pill';
import { SheetHead } from '../ui/Sheet';
import { ACTIVE_RUN_STAGES } from '../board/ItemCard';
import { RowTime } from '../board/RunRowTime';
import { StageBars } from './StageBars';
import { StageTrack } from './StageTrack';
import type { ArchiveQueueItem, OrchestratorArchiveRun, OrchestratorRun, RunQueueItem, RunSessionUsage, RunStage, RunWatchdog } from '../../../../shared/types';

/**
 * The Runs section's persistent right-hand pane (RunsView.tsx, Task 6) — the
 * whole reason this feature exists, per the design doc's own rejection of a
 * dense ledger table: the run drawer (RunDrawer.tsx) this pane's markup
 * deliberately echoes is a slide-out sized for "glance at a live run in
 * progress," not for actually reading what an unattended overnight run did.
 * A person opening the Runs tab has already committed to reading, and this
 * pane is built at that scale instead.
 *
 * REUSE, not reinvention, is the organizing rule below: `.runs-status`
 * (RunsView's own run-level status chip), `.run-drawer-chip`/`.run-drawer-
 * item`/`.run-drawer-item-verify*` (RunDrawer's per-item chrome), and now
 * `RowTime` itself (`board/RunRowTime.tsx`) are all worn verbatim rather
 * than reimplemented here. `RowTime` moved out of RunDrawer.tsx specifically
 * so this pane could stop growing its own second reading of "how long did
 * this item take": a real run (`run-20260901-112815`) once had bug-7 read a
 * queue-wait-inclusive 161 minutes under this pane's own old arithmetic,
 * against the correct 25 minutes `itemDurationMs` gives by excluding the
 * four items queued ahead of it (full story: `RunRowTime.tsx`'s and
 * `run-stats.ts`'s own file headers). Two things are genuinely new here
 * instead: `StageTrack` (Task 5) in place of the old segmented per-item
 * stage bar and its caption — RunDrawer's seven-dot stepper answers "how
 * far along," which a finished run has no use for; the track answers
 * "where did the time go," which the stepper cannot — and the run-level
 * "machine time by stage" rollup (`StageBars` over `runStageTotals`, Task
 * 6) that now answers the same question once per run instead of once per
 * item.
 *
 * ---- Data source: three tiers, one rule, one function ----
 *
 * `summary` (an `OrchestratorArchiveRun`) is the one prop guaranteed to be
 * populated the instant this component mounts — it is what RunsView already
 * held before a row was even clicked. `live`, when given, is a DIFFERENT
 * run object — the live poll's own entry for this exact runId, strictly
 * fresher than `summary` because `useOrchestratorRuns` polls every five
 * seconds while `useOrchestratorArchive` (the source of `summary`) fetches
 * only on mount and window focus. `fetchedRun` (state, below) is a third
 * view: the full run file this pane fetches on demand for an ARCHIVED
 * selection, which lands strictly after `summary` was read and is therefore
 * at least as fresh — and which is the ONLY thing that can ever correct a
 * run whose live entry has gone away: a fix round found that when `live`
 * turns `null` for a still-selected run, falling back to `summary` at that
 * exact point reproduced a stale "running" header with an ever-growing
 * elapsed time and item rows frozen at their last-known live stage — while
 * the fetch this pane had *already issued* for that same transition sat
 * unused. (That fix round attributed the transition to the server's `fresh`
 * flag flipping as a run finished. It no longer is, and never needed to be:
 * bug-29 took freshness out of `live`'s existence entirely, so an entry now
 * disappears only when that run's `run.json` stops being its project's
 * current file — which `init` does when it archives one run before starting
 * the next. The defect, the fetch and this fallback are all unchanged; only
 * the sentence naming the trigger was wrong.)
 *
 * `pickAuthority` (`lib/run-authority.ts`) is the fix, and its own doc
 * comment is the one place this three-tier precedence is written down —
 * `RunsView.tsx`'s row-level version of the same rule imports the same
 * function rather than re-deriving the order, specifically so the two
 * surfaces this feature puts side by side can never again disagree about
 * which one is telling the truth about a given run. `live` wins whenever it
 * exists; otherwise `fetchedRun` wins once it lands; `summary` is the
 * fallback until either shows up. Rows follow the identical precedence
 * (`live !== null` -> `fetchedRun !== null` -> archive) rather than reading
 * `pickAuthority`'s own return value, only because a live/fetched queue
 * item (`RunQueueItem`, with a verification tail) and an archived one
 * (`ArchiveQueueItem`, without) are different TypeScript shapes — the
 * precedence itself is the same rule, just applied a second time because
 * the two possible winners need two different row-mapping functions
 * (`rowsFromLive` vs `rowsFromArchive`) to read.
 */

/** The run-level fields the header and base chips are computed from — the
 *  slice `OrchestratorRun` and `OrchestratorArchiveRun` already share, so
 *  the same derivations run unchanged whichever one is this render's
 *  authority (see the file header comment for which one that is). */
type RunFields = Pick<OrchestratorRun, 'status' | 'startedAt' | 'updatedAt' | 'attention'>;

/** One row's worth of rendering data, folded down from either an
 *  `ArchiveQueueItem` (summary path) or a `RunQueueItem` (live/fetched
 *  path) into the one shape the JSX below actually needs. `verify` is
 *  `null` for an item that never reached verify, matching `RunDrawer.tsx`'s
 *  own `lastVerification` — only the LAST verification entry is shown, the
 *  same "skim the build log's last relevant line" reasoning that function's
 *  doc comment gives; `tail` inside it is `null` until a fuller run object
 *  (live, or a landed fetch) supplies it.
 *
 *  `branch` (Task 9) is threaded through for the "branches to merge" list
 *  below: `RunQueueItem.branch`'s own contract (shared/types.ts) is `null`
 *  only for an item skipped before dispatch, and CLAUDE.md's own invariant
 *  on `backlog-orchestrate` being the one skill that ever writes it says the
 *  branch is always exactly `backlog/<id>` — so a `branched` row (which, by
 *  construction, was committed, reviewed and verified) always carries a
 *  real value here in practice; the section below still falls back to
 *  rebuilding that name from `id` rather than trusting the field blindly,
 *  the same defensiveness this file already applies to every other stamp
 *  a hand-edited run file could leave blank. */
interface DetailRow {
  id: string;
  title: string;
  stage: RunStage;
  stageAt: Partial<Record<RunStage, string>>;
  fixLoops: number;
  questions: string[];
  /** What the run decided on its own for this item (task-19). `?? []` at
   *  both mapping sites below, not here: an archived run written before the
   *  field existed carries no key at all, and the archive endpoints serve
   *  run files verbatim. */
  assumptions: { question: string; answer: string }[];
  verify: { cmd: string; ok: boolean; tail: string | null } | null;
  branch: string | null;
  /** What every session dispatched for this item cost (task-27). Passed
   *  through UNDEFAULTED at both mapping sites below — deliberately unlike
   *  `assumptions`' `?? []` two lines up, and the difference is the whole
   *  point: an absent key means this run predates the feature and the row
   *  must render nothing, where `[]` would be indistinguishable from it and
   *  invite a `$0.00`. `itemUsageTotals` collapses both to `null` for the
   *  caller anyway, so nothing downstream has to remember the distinction —
   *  it just must not be erased before that function sees it. */
  usage?: RunSessionUsage[];
}

function rowsFromArchive(queue: readonly ArchiveQueueItem[]): DetailRow[] {
  return queue.map((q) => {
    const last = q.verification.length === 0 ? null : q.verification[q.verification.length - 1];
    return {
      id: q.id,
      title: q.title,
      stage: q.stage,
      stageAt: q.stageAt,
      fixLoops: q.fixLoops,
      questions: q.questions,
      branch: q.branch,
      assumptions: q.assumptions ?? [],
      usage: q.usage,
      verify: last === null ? null : { cmd: last.cmd, ok: last.ok, tail: null }
    };
  });
}

function rowsFromLive(queue: readonly RunQueueItem[]): DetailRow[] {
  return queue.map((q) => {
    const last = q.verification.length === 0 ? null : q.verification[q.verification.length - 1];
    return {
      id: q.id,
      title: q.title,
      stage: q.stage,
      stageAt: q.stageAt,
      fixLoops: q.fixLoops,
      questions: q.questions,
      branch: q.branch,
      assumptions: q.assumptions ?? [],
      usage: q.usage,
      verify: last === null ? null : { cmd: last.cmd, ok: last.ok, tail: last.tail }
    };
  });
}

export function RunDetail({
  summary,
  live,
  gate,
  resuming,
  onChanged
}: {
  summary: OrchestratorArchiveRun;
  /** The live poll's own entry for this runId — the whole payload entry
   *  (task-17), not a bare `OrchestratorRun`: `RunControls` below decides
   *  from `fresh`, `pauseRequested` and — since task-38 put the crashed
   *  run's Resume in this sheet's head — `watchdog`, all three annotations
   *  the endpoint adds rather than fields the run file carries. Named as
   *  exactly those three rather than the whole payload entry, so this prop
   *  states what it READS: `pastRuns` rides the same entry and is none of
   *  this sheet's business. */
  live: (OrchestratorRun & { fresh: boolean; pauseRequested: boolean; watchdog?: RunWatchdog }) | null;
  /** task-17: the resume gate, from the same `resumeGate` call every host of
   *  `RunControls` has made — one host today (this sheet's head), and the
   *  prop stays so the component never reaches for a data source itself. */
  gate: { canResume: boolean; blockedReason: string | null };
  resuming: boolean;
  onChanged: (kind: RunControlsChange) => void;
}): JSX.Element {
  // Holds the tail-bearing run this pane fetched for an ARCHIVED selection —
  // null before the fetch lands (or when this selection is live-backed and
  // never needs one at all). Never holds anything for the live-backed case:
  // `live` itself already carries tails, so there is nothing this state
  // needs to remember for that path.
  const [fetchedRun, setFetchedRun] = useState<OrchestratorRun | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    // A new selection lands here as new `summary`/`live` props on the SAME
    // component instance (RunsView does not remount RunDetail per row — see
    // the stale-guard note below for why that matters), so any tail state
    // left over from the PREVIOUS selection has to be cleared immediately,
    // not just overwritten once a new fetch happens to resolve.
    setFetchedRun(null);
    setFetchFailed(false);

    // Live-backed: `live` already carries tails, so there is nothing to
    // fetch. Depending on `live !== null` rather than on `live` itself keeps
    // this effect from re-running on every 5s poll tick while a live run
    // stays live-backed (a new object arrives each time, but the FACT this
    // effect cares about — is there a fetch to do at all — has not changed)
    // while still re-arming correctly the moment a run's liveness actually
    // flips (it goes stale, or finishes) with the same runId still selected.
    if (live !== null) return;

    // The stale-response guard the brief calls for: the selection can move
    // on to a different run before this fetch resolves (a person clicking
    // quickly down the list), and a belated resolution for a runId that is
    // no longer what `summary` names must never land in state. A plain
    // boolean closed over by this effect run — flipped in its own cleanup —
    // is enough: React calls that cleanup before running the effect again
    // for a new [project, runId] pair, or on unmount, either of which is
    // exactly the moment a resolution for the OLD pair should be discarded.
    let cancelled = false;
    fetchArchivedRun(summary.project, summary.runId)
      .then((run) => {
        if (cancelled) return;
        setFetchedRun(run);
      })
      .catch(() => {
        if (cancelled) return;
        setFetchFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [summary.project, summary.runId, live !== null]);

  // One clock reading for this render, matching RunDrawer.tsx's own rule
  // (restated there in full): every derivation below that needs "now"
  // shares this single instant rather than each calling Date.now() for
  // itself, so two readings taken a millisecond apart cannot print
  // durations that disagree with each other at a rung boundary.
  //
  // `useNow`, not a bare `Date.now()`, because three readings on this pane
  // now have to move on their own between poll ticks: the current node's
  // duration and the fix-loop-free "elapsed" reading `StageTrack` prints
  // for a still-running item, and the live rollup row `runStageTotals`
  // credits to whichever stage that item is sitting in right now (see that
  // function's own "OPEN span" paragraph). The 5s live poll alone would
  // make all three jump in five-second steps instead of ticking smoothly.
  // Gated on `live?.fresh === true`, not on `live !== null`: an ARCHIVED
  // selection has nothing left to tick — every stamp it can ever have is
  // already written — so `useNow(false, ...)` installs no interval at all and
  // this render stays a pure function of its props, matching every other
  // archived-row reading on this pane. bug-29 narrowed the gate from presence
  // to freshness for COST rather than correctness: a stale live entry now
  // exists where it used to be `null`, and every clock on this pane already
  // freezes itself on a dead heartbeat (`runWallMs`, `runStageTotals`,
  // `runClockMs`, all through `runIsLive`), so a 1s interval on a crashed run
  // would only repaint numbers that cannot move.
  const now = useNow(live?.fresh === true, 1_000);

  // The file header's "Data source" section names the rule; `pickAuthority`
  // (lib/run-authority.ts) is its one implementation. `live` wins whenever
  // it exists (freshest, by construction — a per-request read of `run.json`
  // arriving every 5s, whether or not that file's heartbeat is recent);
  // otherwise the just-landed `fetchedRun` wins; `summary` is the fallback
  // until either shows up — and critically, that fallback is no longer
  // permanent once `live` goes `null` (this run's file stopped being its
  // project's current one), because `fetchedRun` is already in flight for
  // exactly that transition (see the effect above) and replaces `summary`
  // itself, not merely one field on it, the moment it lands.
  //
  // `source` holds the WHOLE winning object, not a projection of it —
  // `runStageTotals` below needs a real `.queue` of `{stage, stageAt}` items
  // plus the run's own `status`/`updatedAt` (its open-span credit is gated
  // on the run's status AND heartbeat freshness, never on `live` alone —
  // see that function's own doc comment for why), which only the
  // unprojected object still carries. `authority` used to be a SECOND call
  // to `pickAuthority`, returning the identical winner under the narrower
  // `RunFields` type — restating the same precedence a second time just to
  // get a different type is exactly the kind of duplicate this component's
  // own reuse rule (file header) argues against, so it is now `source`
  // itself, narrowed by a plain assignment: structural typing accepts a
  // wider object wherever the narrower `Pick` is expected, so the
  // projection costs nothing beyond the type annotation.
  const source: OrchestratorRun | OrchestratorArchiveRun = pickAuthority([live, fetchedRun], summary);
  const authority: RunFields = source;
  const attention = authority.attention;

  // Is the run this pane is showing actually ALIVE, and what is the last
  // instant it can PROVE? Every ITEM-level reading below is measured against
  // `clock` rather than `now` — bug-15, which is the item-level half of the
  // same defect bug-14 fixed for `runWallMs`: the pane computes one `now` per
  // render and used to hand it both to the header (which forks on liveness)
  // and to the rows (which did not), so an aborted run reported its own 7m
  // 35s in the header above a row claiming 32 hours and climbing.
  //
  // Derived from `source` — the winning authority, the same object
  // `runWallMs` and `runStageTotals` read — for the reason `runWallMs`'s own
  // comment gives: that object can be an `OrchestratorArchiveRun`, which
  // carries no `fresh` flag at all, and deriving is also what makes a CRASHED
  // `running` run (a killed orchestrator's file, frozen at that status
  // forever) fall out without a second rule.
  //
  // `runStageTotals` below deliberately keeps receiving the real `now`, NOT
  // this clamped clock: it derives its own freshness internally, and handing
  // it a pre-clamped instant would make that check trivially true — reaching
  // the right number by accident rather than by rule. Same for `useNow`'s own
  // `live?.fresh === true` gate above, which governs whether an interval
  // exists at all, not what any reading measures against.
  const runLive = runIsLive(source, now);
  const clock = runClockMs(source, now);

  // Rows follow the SAME precedence as `source`/`authority` above, restated
  // here (rather than derived from either) only because a live/fetched
  // queue item and an archived one are different TypeScript shapes —
  // `rowsFromLive` reads a full `RunQueueItem[]` (verification tails
  // included), `rowsFromArchive` reads a stripped `ArchiveQueueItem[]`. The
  // ORDER of the three checks below is not a second decision to keep in
  // sync with `pickAuthority`'s: it can only ever produce the same winner,
  // since `live`/`fetchedRun`/`summary` are the identical three values in
  // the identical order. This replaces the old `rowsWithTails` id-matching
  // patch-in entirely — that map only ever corrected a row's verification
  // TAIL once a fetch landed; every other field (stage, stageAt, fixLoops)
  // stayed frozen at whatever `summary` said, which is exactly how a
  // finished run's rows used to keep reading their last live-known stage
  // forever. Reading the whole row set off `fetchedRun` once it exists
  // fixes that: every field on a fetched-authority row is as fresh as the
  // header stamps built from the same object.
  const rows: DetailRow[] = live !== null ? rowsFromLive(live.queue) : fetchedRun !== null ? rowsFromLive(fetchedRun.queue) : rowsFromArchive(summary.queue);

  const merged = rows.filter((r) => r.stage === 'merged').length;
  // Which rows reached RunStage's OTHER success exit (one per MergeMode),
  // and in queue order — this is also the "what do I do next" list design
  // §7 asks for ("lists the branches ... with their git merge --no-ff
  // backlog/<id> commands"), so it is kept as the row array rather than a
  // bare count: `branched.length` below feeds the chip, `branched` itself
  // feeds the list a few lines down, and computing it once means the two
  // can never quietly disagree about which rows qualify. Listed in QUEUE
  // order, not MERGE order: design §5.3's overlap-flagging is the
  // ORCHESTRATOR's own finish-summary job (skills/backlog-orchestrate,
  // which can re-run git against the actual worktrees), not this pane's,
  // which can only re-list history it already has on hand.
  //
  // Before Task 9 a downgraded run (design §5.2: some items merged before
  // the classifier was denied, the rest branched afterwards) had NO chip
  // for this half of its queue at all — the chips below printed only
  // `merged`, silently dropping however many items finished the other way.
  // Its own chip, not folded into `merged`'s count, for the same reason
  // `mergeMode`/`mergeModeEffective` stay two fields rather than one (this
  // file's own mode-note comment below): collapsing them would erase
  // exactly the distinction a reader needs — which exit each item actually
  // took — that a bare "N completed" total cannot answer on its own. Empty
  // for every run this feature predates, which is what keeps a plain
  // merge-mode run's chip row (and this list) rendering exactly as they
  // always have.
  const branched = rows.filter((r) => r.stage === 'branched');
  const skipped = rows.filter((r) => r.stage === 'skipped').length;
  const fixLoopsTotal = rows.reduce((sum, r) => sum + r.fixLoops, 0);
  // `ACTIVE_RUN_STAGES` (ItemCard.tsx) rather than RunDrawer's own
  // re-derivation of the same list — the exact import the brief's own
  // interfaces section names, and the one RunDrawer.tsx already reuses for
  // its equivalent "active" chip.
  // bug-29: `live.fresh === true`, not `live !== null`. These two count what
  // the run is doing THIS INSTANT, which a stale entry cannot claim — its
  // queue is the last thing the run reported, however long ago. Every OTHER
  // `live !== null` site in this file is correct on presence alone: the rows
  // source below is the fix itself, and the one-shot fetch above is right to
  // stand down once a live entry exists, stale or not.
  const liveFresh = live !== null && live.fresh;
  const active = liveFresh ? live.queue.filter((q) => ACTIVE_RUN_STAGES.includes(q.stage)).length : 0;
  const queued = liveFresh ? live.queue.filter((q) => q.stage === 'pending').length : 0;

  const startedClock = formatClock(authority.startedAt);
  const wall = runWallMs(authority, now);

  // `mergeMode`/`mergeModeEffective`/`mergeModeNote` are read off `source`
  // (the full winning object), not the narrower `authority` — the same
  // choice `mergeModeEffective`'s own existing use a few lines below
  // (`StageTrack`'s prop) already makes and documents in this file's own
  // header, for the identical reason: `RunFields` is a `Pick` that never
  // claimed these three fields, and widening it just to read them here
  // would be a second projection of `source` to keep in sync with the
  // first.
  //
  // `modeLabel` is `null` for a plain merge-mode run (`mergeModeLabel`'s own
  // contract, lib/run-stage.ts) — the fact that keeps this pane rendering
  // byte-identically to before this feature existed for every run that
  // shape describes, which is every run ever archived before Task 9 landed.
  const modeLabel = mergeModeLabel(source.mergeMode, source.mergeModeEffective);
  // The two-field distinction design §7 asks for ("plus ... the note, when
  // it differs") is deliberately NOT collapsed into `modeLabel` above: a
  // reader needs to tell "this run was TOLD to leave branches" apart from
  // "this run tried to merge and was turned down partway through" (design
  // §5.2 — the classifier's own verdict is a per-call coin flip, and the
  // whole post-mortem value of `mergeModeNote` is naming WHICH call got
  // denied), and folding the note's prose into the same short badge every
  // surface prints would either truncate it illegibly or blow the badge's
  // one-line shape out on every OTHER run. `mergeModeNote` is `null`
  // whenever the two fields agree (its own contract, shared/types.ts), so
  // this renders nothing extra for a deliberately-chosen branch-mode run
  // either — only a genuinely downgraded one earns the second line.
  const modeNote = source.mergeMode === source.mergeModeEffective ? null : source.mergeModeNote;

  // bug-29's two halves of "say it is last-reported, do not imply it is
  // current". The badge is the loud one — a run whose heartbeat died 46
  // minutes ago used to render the word `running`, in the live cyan, beside a
  // `34m elapsed` that `runWallMs` had already correctly frozen, while the
  // Board strip one click away said `crashed` off the same payload
  // (`run-20260906-185312`). The note below it is the quiet one: this pane's
  // stages now MOVE for such a run, and a readout that moves must not read as
  // a process anybody is still hearing from.
  const statusChip = runStatusChip(authority.status, live);
  // The last heartbeat as a CLOCK TIME, deliberately not the strip's own
  // "no heartbeat for 46m" age: an age has to tick, and this pane installs no
  // interval for a crashed run (see `useNow`'s gate above — every other
  // reading here freezes itself on a dead heartbeat, and adding one that does
  // not would take that saving straight back). A fixed stamp is a fact that
  // never goes stale, and the Board strip is one click away for the age.
  // Read off `live`, never `authority`: an archive record carries no `fresh`
  // field, so it has no heartbeat to be judged crashed on.
  const crashed = live !== null && isCrashed(live);
  const lastHeartbeat = crashed && live !== null ? formatClock(live.updatedAt) : null;

  // task-27. Off `source` — `authority` is the same object narrowed to
  // `RunFields`, which names no queue — so this total comes from the same
  // three-tier winner every other run-level reading in this head does,
  // rather than from `rows`, which are mapped by a second application of
  // that precedence for a TypeScript reason (see the file header). Both
  // concrete queue-item shapes carry `usage`, so no narrowing is needed.
  const runUsage = runUsageTotals(source);

  // ── task-38: what the detail SHEET's head and facts strip need ───────────
  //
  // "Finished" is the two statuses a run can still leave excluded, never a
  // list of the three it cannot — `RunStatus` gaining a sixth member must not
  // silently read as finished here, and `running`/`paused` are the two this
  // sheet already forks on everywhere else.
  const finished = authority.status !== 'running' && authority.status !== 'paused';
  const finishedClock = finished ? formatClock(authority.updatedAt) : null;
  // The head's own sub line: the run id, and the item count ONLY once the run
  // is over (DESIGN.md §8.4.1). While it is live the count is still moving and
  // the chip row below already carries every number that matters about it.
  const itemCount = finished ? `${rows.length} ${rows.length === 1 ? 'item' : 'items'}` : null;
  // The dot beside the project name, from the same function the Live and
  // History rows read — see `runDotTone` (lib/run-stage.ts) for why a finished
  // run gets no tone at all rather than a third colour of the same dot.
  const dotTone = runDotTone(authority.status, live);
  // The item a pause is waiting on, or the one a paused run stopped after —
  // `inFlightItemId` (RunControls.tsx), the same lookup the Pause note in this
  // sheet's own head already prints, never a second scan of the queue.
  const boundaryItem = inFlightItemId(source.queue);
  /**
   * The `status` fact's second reading (§8.4.1). One of four, in this
   * precedence, and the order is the point rather than incidental: a pause
   * REQUESTED against a still-running run is the most specific thing true of
   * it, `paused` is the state that request became, and only then does the
   * heartbeat get a word.
   *
   * `null` for a crashed run deliberately: its sentence is the boxed
   * `.run-detail-crashed` line below, which is the one reading on this sheet
   * that must not be skimmed past (bug-29 — the stages below it MOVE), and
   * printing an age here as well would be the same fact twice.
   */
  const statusNote =
    live?.pauseRequested === true
      ? `pausing · finishes ${boundaryItem ?? 'the current item'}`
      : authority.status === 'paused'
        ? boundaryItem === null
          ? 'paused at a boundary'
          : `paused after ${boundaryItem}`
        : crashed
          ? null
          : liveFresh
            ? 'heartbeat live'
            : null;
  /**
   * The headless note under `decide` (§8.4.1), and the reason `questionMode`
   * is read defensively: a run file written before the field existed simply
   * lacks it, and absent means `park` — the mode those runs actually had
   * (`OrchestratorRun.questionMode`'s own doc comment calls tolerating that a
   * display concern in this file, which is exactly what this is). `park`
   * appends nothing, matching the tool's own default.
   */
  const questionMode = source.questionMode === 'decide' ? 'decide' : 'park';
  const questionNote = questionMode === 'decide' ? 'decide mode — a question nobody could answer was decided by the run, not parked' : null;

  return (
    <>
      {/* The detail sheet's HEAD (task-38, DESIGN.md §8.4.1): project, the run
          id, the item count once the run is over, and `RunControls` right.
          `SheetHead` rather than this file's own old `.run-detail-head` row —
          the detail is a sheet now, and §12.1's rule is that a shape more than
          one surface draws has one home. The head's own three readings moved
          in from what used to sit here: the status chip, the mode badge and
          the elapsed/cost lines are all facts about the run rather than
          identity, so they are in the facts strip below.
            This is also the ONE place any run state offers a Resume — crashed
          and paused alike (§8.4.1's moved-rules table). `RunControls` decides
          which control that is from the entry alone. */}
      <SheetHead
        title={
          <span className="run-detail-proj">
            {/* `breathe` only while something is actually moving (§8.8): a
                ring pulsing around a crashed, paused or finished run would be
                an animation asserting something false. */}
            {dotTone === undefined ? <Dot size={10} /> : <Dot size={10} tone={dotTone} breathe={dotTone === 'live'} />}
            {projectLabel(summary.project)}
          </span>
        }
        sub={[summary.runId, itemCount].filter((part) => part !== null).join(' · ')}
        right={
          /* task-17. `live` when there is one — it already carries `fresh`,
             `pauseRequested` and `watchdog`, the three fields the controls
             decide from — and a synthesised entry otherwise. The synthesis is
             honest rather than a placeholder: a run with no live entry is one
             this server's run payload does not list, which means its file is
             gone or superseded, so it is neither fresh nor pause-requested nor
             a watchdog subject by construction. The one thing that CAN still
             be true of it is `status: 'paused'`, read off the archive record,
             and that is exactly the case the Resume control exists for.
             `RunControls` renders nothing for every other finished status. */
          /* The slot §8.8's fade arrives into, reserved whether or not there
             is a control to put in it: `RunControls` renders `null` for most
             run states, and a head that grew by a chip's height the instant
             the sweeper stood down would move every reading under it while
             someone was reading them. */
          <span className="run-detail-controls">
            <RunControls
              run={
                live ?? {
                  status: source.status,
                  project: summary.project,
                  queue: source.queue,
                  fresh: false,
                  pauseRequested: false
                }
              }
              gate={gate}
              resuming={resuming}
              onChanged={onChanged}
            />
          </span>
        }
      />

      {/* The facts strip (§8.4.1's body item 1) — label over value on a
          wrapping grid, replacing the row of loose spans this sheet's head
          used to carry. Each fact renders only when it has something to say:
          a run with a corrupt `startedAt` still reports its cost, a
          merge-mode run draws no mode pill (`mergeModeLabel` returns `null`
          for one), and every run archived before task-27 carries no usage at
          all — the reading that must never become a `$0.00`. */}
      <div className="run-facts" data-testid="run-detail-facts">
        {startedClock !== null && (
          <div className="run-fact">
            <span className="run-fact-label">started</span>
            <span className="run-fact-value" data-testid="run-detail-started">
              {startedClock}
            </span>
          </div>
        )}
        {finishedClock !== null && (
          <div className="run-fact">
            <span className="run-fact-label">finished</span>
            <span className="run-fact-value" data-testid="run-detail-finished">
              {finishedClock}
            </span>
          </div>
        )}
        {/* `wall` while the run is over, `elapsed` while it is not — one
            reading from `runWallMs`, which freezes itself on a dead heartbeat
            (bug-14), under whichever of the two words is true. The testid is
            the one this reading has always carried, so the case that pins it
            follows the number rather than the markup. */}
        {wall !== null && (
          <div className="run-fact">
            <span className="run-fact-label">{finished ? 'wall' : 'elapsed'}</span>
            <span className="run-fact-value" data-testid="run-detail-time">
              {formatSpanCompact(wall)}
            </span>
          </div>
        )}
        <div className="run-fact">
          <span className="run-fact-label">status</span>
          <span className="run-fact-value">
            {/* bug-29: `runStatusChip` (lib/run-stage.ts), the one place the
                `running` + dead-heartbeat -> `crashed` substitution is
                decided, shared with the Live and History rows so no two
                badges on one screen can disagree. Derived from `live`, never
                from `authority` — `authority` may be an archive record, which
                carries no `fresh` field, and a run with no heartbeat to judge
                must keep printing its recorded status. */}
            <span className={`runs-status ${statusChip.className}`}>
              <span aria-hidden="true">{statusChip.glyph}</span>
              {statusChip.label}
            </span>
            {statusNote !== null && (
              <span className="run-fact-note" data-testid="run-detail-status-note">
                {statusNote}
              </span>
            )}
          </span>
        </div>
        {modeLabel !== null && (
          <div className="run-fact">
            <span className="run-fact-label">mode</span>
            <span className="run-fact-value">
              <Pill tone="warn">
                <span data-testid="run-detail-mode">{modeLabel}</span>
              </Pill>
            </span>
          </div>
        )}
        <div className="run-fact">
          <span className="run-fact-label">questions</span>
          <span className="run-fact-value" data-testid="run-detail-questions">
            {questionMode}
          </span>
        </div>
        {/* task-44: which branch this run gated at, cut its worktrees from and
            merged into.

            **Rendered for every run, `main` ones included**, deliberately
            unlike the `mode` fact directly above, which hides itself for a
            plain merge-mode run. The two are different kinds of fact: a mode
            pill marks a run that DEVIATED, so its absence is itself a reading
            ("this run merged, as asked"). A base is where the work went, and a
            field that appeared only sometimes would read as an anomaly on the
            runs that had it rather than as ordinary metadata — and would leave
            the reader of a `main` run unsure whether the field was missing or
            the run predated it.

            Unrecoverable from anything else after the fact, which is the whole
            reason it is drawn: the merge commits are on the base, not in any
            file this app keeps, so a runs history that omitted it would lie by
            omission. `source.base` is total for every run — the server's
            reader resolves an older run file's absent `base` to `'main'` once
            (`sanitizeMergeFields`), so there is no `?? 'main'` to re-implement
            here. */}
        <div className="run-fact">
          <span className="run-fact-label">base</span>
          <span className="run-fact-value" data-testid="run-detail-base">
            <code>{source.base}</code>
          </span>
        </div>
        {/* task-27: what the whole run cost, summed off the per-transcript
            entries `orchestrate.mjs usage` wrote. `runUsageTotals` returns
            `null` for every run archived before that command existed, so this
            fact does not render at all for them — never a `$0.00`, which is
            the one reading that feature must not produce. The `sessions`
            count rides along because it is what explains a total that looks
            high for the queue length. */}
        {runUsage !== null && (
          <div className="run-fact">
            <span className="run-fact-label">cost</span>
            <span className="run-fact-value" data-testid="run-detail-usage">
              {[
                runUsage.costUsd === null ? null : formatUsd(runUsage.costUsd),
                runUsage.turns === null ? null : formatTurns(runUsage.turns),
                `${runUsage.sessions} session${runUsage.sessions === 1 ? '' : 's'}`
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </span>
          </div>
        )}
      </div>

      {crashed && (
        // §8.4.1 lists this sentence as the `status` fact's own second
        // reading; it is drawn here, immediately under the strip and boxed,
        // for the reason bug-29 gave it that box in the first place — a reader
        // who skims past it goes on to read every stage below as current, and
        // this sheet's stages MOVE for a crashed run. A boxed alert inside one
        // narrow cell of a wrapping facts grid is not readable, and the
        // `status` fact says `crashed` in its chip either way, so the box
        // keeps the sentence and the fact keeps the word. The Live row carries
        // the age; this line carries a fixed stamp, which is a fact that never
        // goes stale — and no interval is installed for a crashed run.
        <div className="run-detail-crashed" data-testid="run-detail-crashed">
          {/* Null-tolerant, matching the facts above: a run whose `updatedAt`
              will not parse is exactly the run the server already reads as
              un-fresh, so it reaches this line with no stamp to print — and
              the qualifier is the load-bearing half anyway. */}
          {lastHeartbeat === null ? 'heartbeat stopped' : `last heartbeat ${lastHeartbeat}`}
          {' · every stage below is last reported, not current'}
        </div>
      )}

      {fetchFailed && (
        // The one failure mode this pane can hit on its own (the fetch,
        // not the poll or the archive listing, both handled upstream): the
        // rows above are already fully rendered off `summary` regardless,
        // per the brief's own instruction that a failed tail fetch must
        // leave them standing — this note says only that one thing behind
        // them (a still-collapsed or still-open `<details>`) may never
        // gain a tail.
        <div className="run-detail-error" data-testid="run-detail-error">
          couldn't load verification output
        </div>
      )}

      {/* The mode and question notes as ONE 12 px line under the strip
          (§8.4.1's body item 2), joined rather than stacked: both qualify the
          run's own configuration, and two separate lines would read as two
          unrelated alerts.
            `mergeModeNote` verbatim, not paraphrased — matching RunDrawer's
          own rule for `RunAttention`'s `detail` prose: the exact reason a
          person carries forward is more useful than this sheet's summary of
          it. It is `null` whenever the two mode fields agree, so a
          deliberately-chosen branch-mode run earns nothing here either; only
          a genuinely DOWNGRADED one does, which is the distinction design
          §5.2 exists for (the classifier's verdict is a per-call coin flip,
          and naming WHICH call got denied is the whole post-mortem value).
            The `decide` note is the other half: a run that answered its own
          questions did something a reader has to know before trusting the
          `assumed` lists further down. */}
      {(modeNote !== null || questionNote !== null) && (
        <div className="run-detail-mode-note" data-testid="run-detail-mode-note">
          {[modeNote, questionNote].filter((part) => part !== null).join(' · ')}
        </div>
      )}

      <div className="run-drawer-chips" data-testid="run-detail-chips">
        <span className="run-drawer-chip" data-testid="run-detail-chip-merged">
          <span className="run-drawer-chip-num">{merged}</span> merged
        </span>
        {/* Rendered only once this run has an actual branched item to
            report — see `branched`'s own comment above for why zero of them
            means this chip must not appear at all: a plain merge-mode run's
            chip row is exactly the three-then-fourth set it printed before
            this feature existed, unchanged. */}
        {branched.length > 0 && (
          <span className="run-drawer-chip" data-testid="run-detail-chip-branched">
            <span className="run-drawer-chip-num">{branched.length}</span> branched
          </span>
        )}
        <span className="run-drawer-chip" data-testid="run-detail-chip-skipped">
          <span className="run-drawer-chip-num">{skipped}</span> skipped
        </span>
        <span className="run-drawer-chip" data-testid="run-detail-chip-attention">
          <span className="run-drawer-chip-num">{attention.length}</span> attention
        </span>
        <span className="run-drawer-chip" data-testid="run-detail-chip-fixloops">
          <span className="run-drawer-chip-num">{fixLoopsTotal}</span> fix loops
        </span>
        {/* Active/queued only ever mean something for a run this board is
            still hearing from — a finished run is zero of both "by
            construction" (design doc's own wording), and printing two more
            zero chips on every archived row would be noise, not information.
            A CRASHED run is the same case (bug-29): its heartbeat is gone, so
            "active right now" is a claim this sheet cannot make for it. */}
        {liveFresh && (
          <>
            <span className="run-drawer-chip" data-testid="run-detail-chip-active">
              <span className="run-drawer-chip-num">{active}</span> active
            </span>
            <span className="run-drawer-chip" data-testid="run-detail-chip-queued">
              <span className="run-drawer-chip-num">{queued}</span> queued
            </span>
          </>
        )}
      </div>

      {/* Branch mode's own "what do I do next" list (design §7 and §5.2's
          own "the actionable part ... belongs in the finish summary, where
          it is one list rather than N copies of one sentence" — the finish
          summary is the ORCHESTRATOR's own console output at the moment the
          run ends; this is that same list's home once the run has scrolled
          off a terminal and only this pane still has it). Rendered only
          when at least one row actually reached `branched` — the same
          "nothing extra for a run this feature predates" rule every other
          addition on this pane follows, and it is what keeps a plain
          merge-mode run's history rendering byte-identically to before this
          feature existed.
            Queue order, not merge order: see `branched`'s own comment above
          for why the overlap-flagging design §5.3 asks for stays the
          orchestrator's job, not this pane's. */}
      {branched.length > 0 && (
        <>
          <div className="run-detail-heading">Branches to merge</div>
          <div className="run-drawer-queue" data-testid="run-detail-branches">
            {branched.map((row) => (
              <div key={row.id} className="run-drawer-item" data-testid={`run-detail-branch-${row.id}`}>
                <div className="run-drawer-item-head">
                  <span className="run-drawer-item-id">{row.id}</span>
                  <span className="run-drawer-item-title">{row.title}</span>
                </div>
                {/* `row.branch ?? backlog/<id>` — see `DetailRow.branch`'s
                    own doc comment for why the fallback exists at all (a
                    hand-edited or corrupted run file, never a real
                    orchestrator-produced one) rather than trusting the
                    field outright the way every other reader of it could. */}
                <code className="run-detail-branch-cmd">git merge --no-ff {row.branch ?? `backlog/${row.id}`}</code>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="run-detail-heading">Items</div>
      <div className="run-drawer-queue" data-testid="run-detail-items">
        {rows.map((row) => {
          // `spans` now serves one purpose instead of colouring a whole
          // per-item bar: finding the `preflight`-labelled gap (if any) for
          // the lead line below. `queueWait`/`preflightSpan` are each
          // `null`/`undefined` independently — either can be known without
          // the other (see the two lead-omission cases in this file's own
          // test suite) — so the lead line's own conditional checks both
          // rather than gating on `spans.length` the way the old bar did.
          const spans = itemStageSpans(row);
          const queueWait = itemQueueWaitMs(row);
          const preflightSpan = spans.find((span) => span.stage === 'preflight');
          return (
            <div key={row.id} className="run-drawer-item" data-testid={`run-detail-item-${row.id}`}>
              <div className="run-drawer-item-head">
                <span className="run-drawer-item-id">{row.id}</span>
                <span className="run-drawer-item-title">{row.title}</span>
                {/* Tone/glyph from lib/run-stage.ts, shared with the card,
                    the strip, and the drawer — an item's stage reads the
                    same everywhere in this app. */}
                <span className={stageChipClass(row.stage)}>
                  <span className="board-card-stage-glyph" aria-hidden="true">
                    {stageGlyph(row.stage)}
                  </span>
                  {row.stage}
                </span>
                {/* The shared `RowTime` (board/RunRowTime.tsx), not a
                    second inline reading — see this file's own header for
                    why growing a second "how long" implementation here is
                    exactly the mistake this move exists to foreclose. */}
                <RowTime item={row} now={clock} testIdPrefix="run-detail-item-time" />
              </div>

              {/* The queue-wait / preflight lead line (Task 6). Only
                  `queueWait` is something `RowTime`'s `itemDurationMs`
                  actually excludes — `pending`, the one interval
                  `startedAtMs` (run-time.ts) drops (this file's own header
                  has the real-run defect that exclusion fixed) — so it is
                  genuine CONTEXT the head reading has no room for.
                  `preflightSpan` is a different kind of number:
                  `itemDurationMs` KEEPS `preflight` (`startedAtMs` treats
                  the gate check as work on this item, the same way
                  `MACHINE_STAGES`, run-stats.ts, counts `preflight` toward
                  the run-level rollup above), so this figure is a
                  BREAKDOWN of time already sitting inside the head reading,
                  not a second thing subtracted from it. Omitted entirely,
                  not rendered empty, when NEITHER half is known: a
                  `pending` item has not started queueing out yet, and a
                  hand-edited or corrupt `stageAt` has nothing honest to
                  report either. */}
              {(queueWait !== null || preflightSpan !== undefined) && (
                <div className="run-detail-lead" data-testid={`run-detail-lead-${row.id}`}>
                  {[
                    queueWait === null ? null : `queue ${formatSpanCompact(queueWait)}`,
                    preflightSpan === undefined ? null : `preflight ${formatSpan(preflightSpan.ms)}`
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
                </div>
              )}

              {/* `StageTrack` (Task 5) replaces the old segmented per-item
                  stage bar and its caption outright — deleted along with
                  their CSS (`.run-detail-stagebar`/`-seg`/`-caption`, the
                  six `.run-seg-*` tones). No conditional needed around it:
                  the component's own `stage === 'ungroomed'` guard already
                  returns `null` for the one item shape with nothing to
                  draw. The fix-loop count that used to print as its own
                  "N fix loop(s)" line now rides as `StageTrack`'s own
                  badge on the `fixing` node instead — one reading of that
                  count, not two.
                    `mergeModeEffective` comes from `source`, not `row`: it
                  is a fact about the RUN this item is in, and `row` (a
                  per-item `DetailRow`) carries no such field — an item
                  cannot say which mode the run around it is running. */}
              <StageTrack item={row} now={clock} live={runLive} mergeModeEffective={source.mergeModeEffective} />

              {/* task-27: what this item's sessions cost, printed UNDER the
                  track's own durations rather than folded into the head's
                  `RowTime` reading. They are different quantities and the
                  distinction is the point: `itemDurationMs` measures the
                  item's wall time through the pipeline — review, verify and
                  merge included, none of which is a dispatched session — while
                  this is what the sessions themselves billed. Printing them in
                  one slot would invite reading the dollar as a rate over the
                  duration beside it.
                    `null` for an item from a run archived before the feature,
                  and for one skipped before dispatch (`ungroomed`,
                  `needs-answers`) — those never had a session to cost
                  anything, and a `$0.00` on them would be a claim rather than
                  a blank. `sessions` prints only above one: every dispatched
                  item has exactly one transcript, so "1 session" is noise,
                  where "3 sessions" is the retry-and-fix-loop history that
                  explains the number beside it. */}
              {(() => {
                const usage = itemUsageTotals(row);
                if (usage === null) return null;
                const parts = [
                  usage.costUsd === null ? null : formatUsd(usage.costUsd),
                  usage.turns === null ? null : formatTurns(usage.turns),
                  usage.sessions === 1 ? null : `${usage.sessions} sessions`
                ].filter((part) => part !== null);
                if (parts.length === 0) return null;
                return (
                  <div className="run-detail-lead" data-testid={`run-detail-usage-${row.id}`}>
                    {parts.join(' · ')}
                  </div>
                );
              })()}

              {/* Beside the stage track, on the item row — the same placement
                  and the same reasoning as RunDrawer's own block: a decided
                  item produces no attention entry (design §6, ATTENTION_KINDS
                  stays three), so this record would be invisible under
                  Attention for exactly the runs that have any. Gated on the
                  length rather than the key, because every item of every
                  `park` run carries an empty list. */}
              {row.assumptions.length > 0 && (
                <div className="run-drawer-item-assumptions" data-testid={`run-detail-assumptions-${row.id}`}>
                  <div className="run-drawer-assumptions-label">assumed</div>
                  <dl className="run-drawer-assumptions-list">
                    {row.assumptions.map((a, i) => (
                      <Fragment key={`${a.question}-${i}`}>
                        <dt>{a.question}</dt>
                        <dd>{a.answer}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </div>
              )}

              {row.verify !== null && (
                // RunDrawer's own one-way-seed pattern, unchanged: React
                // only writes the `open` attribute when this PROP's value
                // changes, so a tail a person expanded by hand survives a
                // live run's 5s poll re-render instead of snapping shut on
                // every tick. Collapsed is not dropped — a passing tail is
                // still the proof the command ran; what has to stay legible
                // without expanding (what ran, whether it passed) is
                // already on the summary line above it.
                <details className="run-drawer-item-verify" data-testid={`run-detail-verify-${row.id}`} open={!row.verify.ok}>
                  <summary className="run-drawer-item-verify-summary">
                    <span className="run-drawer-item-verify-cmd">{row.verify.cmd}</span>
                    <span className={row.verify.ok ? 'run-drawer-item-verify-ok' : 'run-drawer-item-verify-bad'}>{row.verify.ok ? 'ok' : 'failed'}</span>
                  </summary>
                  <span className="run-drawer-item-verify-tail">{row.verify.tail ?? ''}</span>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {/* The run-level "machine time by stage" rollup (Task 6) — the same
          `StageBars` widget Task 7's wide toolbar tile reuses, here fed
          `source` (not `authority`) because it needs a real `.queue` and
          `status` to sum over rather than either's narrower projection.
          "queue wait excluded" is stated outright rather than left implicit
          — `runStageTotals` already drops every `pending` span (see that
          function's own doc comment), but a reader comparing this total
          against a run's own wall-clock elapsed has no other way to know
          why the two numbers do not add up. */}
      <div className="run-detail-heading">
        Machine time by stage
        <span className="run-detail-sub">queue wait excluded</span>
      </div>
      <div className="run-detail-rollup">
        <StageBars totals={runStageTotals(source, now)} testId="run-detail-machine" />
      </div>

      {/* Attention sits LAST — the user's call on 2026-09-17, made while picking the wide layout, and a reversal of task-38's move of this block to the
          top of the body. task-38's argument was that a reader scrolling a forty-item queue to learn whether anything waits on them has been made to work.
          What won against it is what the sheet looks like on almost every run: an empty list is the common case, so the section was `nothing needs a look`
          standing between the chips and the items, and the chip row above already carries the count — a reader who sees `0 attention` there has nothing to
          scroll for, and one who sees `2` knows to. The chip counts; this is the list; the list is only worth the screen when it is not empty. */}
      <div className="run-detail-heading">Attention</div>
      {attention.length === 0 ? (
        <div className="drawer-empty">nothing needs a look</div>
      ) : (
        // `i` in the key for the same reason RunDrawer.tsx's own attention
        // list carries it: RunAttention's doc comment calls this list "a
        // log of what happened, not a live filter over queue", so the same
        // item can legitimately earn a second entry later in the same run.
        attention.map((a, i) => {
          const row = rows.find((r) => r.id === a.id);
          return (
            <div key={`${a.id}-${a.kind}-${i}`} className="run-drawer-attn" data-testid={`run-detail-attention-${a.id}`}>
              <div className="run-drawer-attn-head">
                <span className="run-drawer-item-id">{a.id}</span>
                <span className="run-drawer-attn-kind">{a.kind}</span>
              </div>
              <div className="run-drawer-attn-detail">{a.detail}</div>
              {row !== undefined && row.questions.length > 0 && (
                <ul className="run-drawer-questions">
                  {row.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
