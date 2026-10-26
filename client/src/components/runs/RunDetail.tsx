import { Fragment } from 'react';

import { useFetched } from '../../hooks/useFetched';
import { useNow } from '../../hooks/useNow';
import { fetchArchivedRun } from '../../lib/agents';
import { projectLabel } from '../../lib/project-label';
import { runDetailModel } from '../../lib/run-detail';
import type { RunDetailLive } from '../../lib/run-detail';
import { stageChipClass, stageGlyph } from '../../lib/run-stage';
import { formatTurns, formatUsd, itemStageSpans, itemUsageTotals, runStageTotals } from '../../lib/run-stats';
import { formatSpan, formatSpanCompact, itemQueueWaitMs } from '../../lib/run-time';
import { RunControls } from '../RunControls';
import type { RunControlsChange } from '../RunControls';
import { Dot } from '../ui/Dot';
import { Pill } from '../ui/Pill';
import { SheetHead } from '../ui/Sheet';
import { RowTime } from '../board/RunRowTime';
import { StageBars } from './StageBars';
import { StageTrack } from './StageTrack';
import type { OrchestratorArchiveRun, OrchestratorRun } from '../../../../shared/types';
import { useTimeZone } from '../../hooks/TimeZoneContext';

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
 * only on mount and window focus. `fetchedRun` (`useFetched`, below) is a third
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
 *
 * Both applications of the rule — `pickAuthority` for the run-level winner
 * and the row-mapping fork — happen in `runDetailModel` (lib/run-detail.ts),
 * along with every other header/summary reading this sheet draws (#271). This
 * component hands it the three tiers and one `now`, and reads the result.
 */


export function RunDetail({
  summary,
  live,
  remote = false,
  machine = null,
  invisibleElsewhere = false,
  gate,
  resuming,
  onChanged
}: {
  summary: OrchestratorArchiveRun;
  /** The live poll's own entry for this runId — the whole payload entry
   *  (task-17), not a bare `OrchestratorRun`: `RunControls` below decides
   *  from `fresh`, `pauseRequested`, `stopRequested` (bug-39) and — since
   *  task-38 put the crashed run's Resume in this sheet's head — `watchdog`,
   *  all four annotations the endpoint adds rather than fields the run file
   *  carries. Named as exactly those four rather than the whole payload
   *  entry, so this prop states what it READS: `pastRuns` rides the same
   *  entry and is none of this sheet's business. */
  live: RunDetailLive | null;
  /** task-48: another machine's run, drawn from its claim comments
   *  (`MergedRun.remote`). Read-only: no `RunControls` — pause, resume, abort
   *  and the watchdog are all local mechanisms on the machine that holds the
   *  run file — and no file fetch, because there is no file here. */
  remote?: boolean;
  /** Multi-dashboard task 10: the machine a remote run ran on (`MergedRun.machine` — a remote's name, else the raw host). Drawn as a fact beside started /
   *  finished / status; absent for a local run and for a remote run whose claims recorded no host. Says whose run this is, where the sentence in the controls'
   *  slot says where its controls are. */
  machine?: string | null;
  /** task-48: a LOCAL run of a tracker project that has claimed no issue yet,
   *  and so has posted nothing another machine could find it by
   *  (`runInvisibleElsewhere`, lib/remote-run.ts). Decided by the caller, which
   *  holds the project's source; this sheet only says it. */
  invisibleElsewhere?: boolean;
  /** task-17: the resume gate, from the same `resumeGate` call every host of
   *  `RunControls` has made — one host today (this sheet's head), and the
   *  prop stays so the component never reaches for a data source itself. */
  gate: { canResume: boolean; blockedReason: string | null };
  resuming: boolean;
  onChanged: (kind: RunControlsChange) => void;
}): JSX.Element {
  const { zone } = useTimeZone();
  // The tail-bearing run this pane fetched for an ARCHIVED selection — null before the fetch lands, and never anything for a live-backed selection:
  // `live` itself already carries tails, so there is nothing to fetch (`load` is null, `useFetched`'s skip case).
  //
  // A new selection lands here as new `summary`/`live` props on the SAME component instance (RunsView does not remount RunDetail per row), so the
  // previous selection's tails must be gone on the very render that carries the new key — not overwritten once the new fetch happens to resolve — and a
  // belated answer for a runId the selection has already moved past (a person clicking quickly down the list) must never land. Both are `useFetched`'s
  // (#285): the key change reads pending with no value in the same commit, and a superseded answer sets nothing.
  //
  // Keyed on `live !== null` rather than on `live` itself, so this read does not re-run on every 5s poll tick while a run stays live-backed (a new object
  // arrives each time, but the FACT this read cares about — is there a fetch to do at all — has not changed), while still re-arming the moment a run's
  // liveness actually flips (it goes stale, or finishes) with the same runId still selected. task-48: a remote row always carries its entry as `live`, so
  // that already skips one; `remote` states the rule rather than leaning on it — there is no run file on this machine to ask for.
  const archived = useFetched(
    live !== null || remote ? null : () => fetchArchivedRun(summary.project, summary.runId),
    [summary.project, summary.runId, live !== null, remote]
  );
  const fetchedRun: OrchestratorRun | null = archived.value;
  const fetchFailed = archived.status === 'failed';

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

  // Every header/summary reading this sheet draws — the three-tier precedence
  // the file header describes, the counts, the facts strip, the notes and the
  // controls' entry — is `runDetailModel` (lib/run-detail.ts), a pure function
  // of these three tiers and this render's one `now`, so each reading is
  // unit-tested without a render (#271). The rollup and the per-row readings
  // stay below, in the JSX, because they are the body rather than the head.
  const {
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
    wall,
    wallLabel,
    statusChip,
    statusNote,
    crashed,
    lastHeartbeat,
    modeLabel,
    prNumber,
    questionMode,
    noteLine,
    usageLine,
    sub,
    dotTone,
    controlsRun
  } = runDetailModel({ summary, live, fetchedRun }, now, zone);

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
        sub={
          <>
            {sub}
            {prNumber !== null && (
              <>
                {' · '}
                {/* spec §5: the run's one outbound link. `rel` carries both tokens because the href is a URL a run file supplied; the pattern guard above is
                    the second half of its safety (the server's `sanitizeMergeFields` is the first), the same reasoning `linkBase` is clamped by. */}
                <a className="sheet-link" data-testid="run-detail-pr-link" href={source.prUrl ?? undefined} target="_blank" rel="noopener noreferrer">
                  {`PR #${prNumber}`}
                </a>
              </>
            )}
          </>
        }
        right={
          /* task-17. `controlsRun` is `live` when there is one and a
             synthesised entry otherwise — why that synthesis is honest is
             written beside it, in `runDetailModel` (lib/run-detail.ts). */
          /* The slot §8.8's fade arrives into, reserved whether or not there
             is a control to put in it: `RunControls` renders `null` for most
             run states, and a head that grew by a chip's height the instant
             the sweeper stood down would move every reading under it while
             someone was reading them. */
          <span className="run-detail-controls">
            {/* task-48: a remote run gets the SENTENCE in the controls' slot,
                never the controls. Every one of them would act on this
                machine's run-state directory, which holds nothing for this
                run, so a Pause here would write a request no driver reads. */}
            {remote ? (
              <span className="run-detail-remote" data-testid="run-detail-remote">
                Remote run: its controls are on the machine that ran it.
              </span>
            ) : (
              <RunControls
                run={controlsRun}
                gate={gate}
                resuming={resuming}
                onChanged={onChanged}
              />
            )}
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
            <span className="run-fact-label">{wallLabel}</span>
            <span className="run-fact-value" data-testid="run-detail-time">
              {formatSpanCompact(wall)}
            </span>
          </div>
        )}
        {remote && machine !== null && machine !== '' && (
          <div className="run-fact">
            <span className="run-fact-label">machine</span>
            <span className="run-fact-value" data-testid="run-detail-on-machine">
              {machine}
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
        {usageLine !== null && (
          <div className="run-fact">
            <span className="run-fact-label">cost</span>
            <span className="run-fact-value" data-testid="run-detail-usage">
              {usageLine}
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
      {invisibleElsewhere && (
        // task-48: the one run the claim comments cannot show anyone else —
        // said here rather than left for someone on another machine to wonder
        // why their Runs page is empty.
        <div className="run-detail-mode-note" data-testid="run-detail-invisible">
          Not visible from other machines: this run has not claimed an issue yet.
        </div>
      )}

      {noteLine !== null && (
        <div className="run-detail-mode-note" data-testid="run-detail-mode-note">
          {noteLine}
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
      {remote && (
        // task-48: the queue above is only what the run has CLAIMED — an item
        // it has not reached has no comment, so nothing here can list it.
        <div className="run-detail-sub" data-testid="run-detail-remote-queue">
          Items this run has not claimed yet are not visible from here.
        </div>
      )}

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
