import { isPrUrl } from '../../../shared/agent';
import { pickAuthority } from './run-authority';
import { ACTIVE_RUN_STAGES, mergeModeLabel, runDotTone, runStatusChip } from './run-stage';
import { formatTurns, formatUsd, runUsageTotals, runWallMs } from './run-stats';
import { isCrashed } from './run-watchdog';
import { formatClock, inFlightItemId, runClockMs, runIsLive } from './run-time';
import type { ArchiveQueueItem, OrchestratorArchiveRun, OrchestratorRun, RunQueueItem, RunSessionUsage, RunStage, RunWatchdog } from '../../../shared/types';

/**
 * `runDetailModel` — every header and summary reading the Runs detail sheet
 * (`components/runs/RunDetail.tsx`) draws, derived in one pure function so
 * each can be pinned under jest's default `node` environment with no render
 * and no jsdom (#271, from #263's audit of that sheet).
 *
 * What lives here is the HEAD of the sheet: the facts strip, the chip row, the
 * SheetHead's sub line, the crashed box, the mode/question note and the entry
 * `RunControls` decides from. What stays in the component is everything that
 * is not a summary of the run: the fetch effect and its state, the `useNow`
 * interval, the per-row JSX with its own usage line (`itemUsageTotals`), and
 * the machine-time rollup `runStageTotals`, which the JSX calls with the real
 * `now` — never with `clock` — for the reason the `clock` comment below gives.
 *
 * The comments below moved here verbatim from the component's render body,
 * and a "below" or "above" in them that names a piece of markup means the
 * markup in RunDetail.tsx that reads the value. The three-tier data-source
 * rule they apply is written down once, in RunDetail.tsx's file header.
 *
 * Imports nothing from `components/` and nothing from React — asserted by
 * `test/run-detail-model.test.ts` — which is why `ACTIVE_RUN_STAGES` and
 * `inFlightItemId` moved into `lib/` alongside this file.
 */

/** The run-level fields the header and base chips are computed from — the
 *  slice `OrchestratorRun` and `OrchestratorArchiveRun` already share, so
 *  the same derivations run unchanged whichever one is this render's
 *  authority (see the file header comment for which one that is). */
export type RunFields = Pick<OrchestratorRun, 'status' | 'startedAt' | 'updatedAt' | 'attention'>;

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
export interface DetailRow {
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

export function rowsFromArchive(queue: readonly ArchiveQueueItem[]): DetailRow[] {
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

export function rowsFromLive(queue: readonly RunQueueItem[]): DetailRow[] {
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

/** The live poll's entry for one run as the detail sheet reads it — the run
 *  file plus the four annotations the endpoint adds. One declaration for both
 *  `RunDetail`'s `live` prop and this model's input, so the two cannot drift;
 *  the prop's own doc comment says why it names exactly these four. */
export type RunDetailLive = OrchestratorRun & { fresh: boolean; pauseRequested: boolean; stopRequested: boolean; watchdog?: RunWatchdog };

/** The three tiers the sheet's precedence rule reads, kept separate because
 *  the rows need them separately (see the rows comment in the model). */
export interface RunDetailInput {
  summary: OrchestratorArchiveRun;
  live: RunDetailLive | null;
  fetchedRun: OrchestratorRun | null;
}

/** The entry `RunControls` decides from: `live` itself, or the synthesised
 *  stand-in for a run with no live entry (see `controlsRun` in the model). */
export type RunDetailControlsRun =
  | RunDetailLive
  | { status: OrchestratorRun['status']; project: string; queue: (RunQueueItem | ArchiveQueueItem)[]; fresh: false; pauseRequested: false; stopRequested: false };

/** Everything `runDetailModel` returns — one flat object, one field per
 *  reading the sheet's head draws. */
export type RunDetailModel = ReturnType<typeof runDetailModel>;

/**
 * Every header/summary reading of the detail sheet for one render.
 *
 * `now` is the component's `useNow` reading, passed in rather than read here
 * so the model is a pure function of its arguments — the same instant every
 * reading below shares, for the reason the component's `useNow` comment gives.
 */
export function runDetailModel(input: RunDetailInput, now: number) {
  const { summary, live, fetchedRun } = input;

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
  // `ACTIVE_RUN_STAGES` (lib/run-stage.ts) rather than RunDrawer's own
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
  // The PR's number is read off the URL itself — the run file records only `prUrl`, and `isPrUrl` is the same pattern the tool and the server hold, so a
  // value that fails it draws no link at all rather than an anchor with an unvetted href. `null` is the whole answer for every non-pr run and for a pr
  // run whose `gh pr create` failed or was denied (`prUrl` stays `null`, spec §6).
  const prNumber = isPrUrl(source.prUrl) ? (source.prUrl.split('/').pop() ?? null) : null;
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
  // `inFlightItemId` (lib/run-time.ts), the same lookup the Pause note in this
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

  // The SheetHead's sub line: the run id, then the item count once the run is
  // over, joined the way every other compound reading on this sheet is.
  const sub = [summary.runId, itemCount].filter((part) => part !== null).join(' · ');
  // `wall` while the run is over, `elapsed` while it is not — one reading from
  // `runWallMs` under whichever of the two words is true.
  const wallLabel = finished ? 'wall' : 'elapsed';
  // The mode and question notes as one line, mode note first; `null` when
  // neither has anything to say, so the line does not render at all.
  const noteLine = modeNote !== null || questionNote !== null ? [modeNote, questionNote].filter((part) => part !== null).join(' · ') : null;
  // The cost fact's one line. `null` exactly when `runUsage` is — every run
  // archived before task-27 — so the fact never renders as a `$0.00`.
  const usageLine =
    runUsage === null
      ? null
      : [
          runUsage.costUsd === null ? null : formatUsd(runUsage.costUsd),
          runUsage.turns === null ? null : formatTurns(runUsage.turns),
          `${runUsage.sessions} session${runUsage.sessions === 1 ? '' : 's'}`
        ]
          .filter((part) => part !== null)
          .join(' · ');

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
  const controlsRun: RunDetailControlsRun = live ?? {
    status: source.status,
    project: summary.project,
    queue: source.queue,
    fresh: false,
    pauseRequested: false,
    stopRequested: false
  };

  return {
    source,
    rows,
    runLive,
    clock,
    liveFresh,
    merged,
    branched,
    skipped,
    fixLoopsTotal,
    attention,
    active,
    queued,
    startedClock,
    finishedClock,
    finished,
    wall,
    wallLabel,
    statusChip,
    statusNote,
    crashed,
    lastHeartbeat,
    modeLabel,
    modeNote,
    prNumber,
    questionMode,
    questionNote,
    noteLine,
    runUsage,
    usageLine,
    itemCount,
    sub,
    dotTone,
    boundaryItem,
    controlsRun
  };
}
