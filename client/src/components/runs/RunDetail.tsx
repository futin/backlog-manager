import { useEffect, useState } from 'react';

import { useNow } from '../../hooks/useNow';
import { fetchArchivedRun } from '../../lib/agents';
import { pickAuthority } from '../../lib/run-authority';
import { itemStageSpans, runStageTotals, runWallMs } from '../../lib/run-stats';
import { RUN_STATUS_CLASS, RUN_STATUS_GLYPH, stageChipClass, stageGlyph } from '../../lib/run-stage';
import { formatClock, formatSpan, formatSpanCompact, itemQueueWaitMs } from '../../lib/run-time';
import { ACTIVE_RUN_STAGES } from '../board/ItemCard';
import { RowTime } from '../board/RunRowTime';
import { StageBars } from './StageBars';
import { StageTrack } from './StageTrack';
import type {
  ArchiveQueueItem, OrchestratorArchiveRun, OrchestratorRun, RunQueueItem, RunStage
} from '../../../../shared/types';

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
 * run that just stopped being live: a fix round found that the moment a
 * live run finishes, `live` goes `null` on the very next render (the
 * server's `fresh` flag flips), and falling back to `summary` at that exact
 * point reproduced a stale "running" header with an ever-growing elapsed
 * time and item rows frozen at their last-known live stage — while the
 * fetch this pane had *already issued* for that same transition sat unused.
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
 *  (live, or a landed fetch) supplies it. */
interface DetailRow {
  id: string;
  title: string;
  stage: RunStage;
  stageAt: Partial<Record<RunStage, string>>;
  fixLoops: number;
  questions: string[];
  verify: { cmd: string; ok: boolean; tail: string | null } | null;
}

function rowsFromArchive(queue: readonly ArchiveQueueItem[]): DetailRow[] {
  return queue.map((q) => {
    const last = q.verification.length === 0 ? null : q.verification[q.verification.length - 1];
    return {
      id: q.id, title: q.title, stage: q.stage, stageAt: q.stageAt,
      fixLoops: q.fixLoops, questions: q.questions,
      verify: last === null ? null : { cmd: last.cmd, ok: last.ok, tail: null }
    };
  });
}

function rowsFromLive(queue: readonly RunQueueItem[]): DetailRow[] {
  return queue.map((q) => {
    const last = q.verification.length === 0 ? null : q.verification[q.verification.length - 1];
    return {
      id: q.id, title: q.title, stage: q.stage, stageAt: q.stageAt,
      fixLoops: q.fixLoops, questions: q.questions,
      verify: last === null ? null : { cmd: last.cmd, ok: last.ok, tail: last.tail }
    };
  });
}

export function RunDetail(
  { summary, live }: { summary: OrchestratorArchiveRun; live: OrchestratorRun | null }
): JSX.Element {
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
    return () => { cancelled = true; };
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
  // Gated on `live !== null`, exactly like `StageTrack`'s own reduced-
  // motion sweep: an ARCHIVED selection has nothing left to tick — every
  // stamp it can ever have is already written — so `useNow(false, ...)`
  // installs no interval at all and this render stays a pure function of
  // its props, matching every other archived-row reading on this pane.
  const now = useNow(live !== null, 1_000);

  // The file header's "Data source" section names the rule; `pickAuthority`
  // (lib/run-authority.ts) is its one implementation. `live` wins whenever
  // it exists (freshest, by construction); otherwise the just-landed
  // `fetchedRun` wins; `summary` is the fallback until either shows up —
  // and critically, that fallback is no longer permanent once `live` goes
  // `null` (a run finishing), because `fetchedRun` is already in flight for
  // exactly that transition (see the effect above) and replaces `summary`
  // itself, not merely one field on it, the moment it lands.
  const authority: RunFields = pickAuthority([live, fetchedRun], summary);
  const attention = authority.attention;

  // Rows follow the SAME precedence as `authority` above, restated here
  // (rather than derived from `authority` itself) only because a live/
  // fetched queue item and an archived one are different TypeScript shapes
  // — `rowsFromLive` reads a full `RunQueueItem[]` (verification tails
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
  const rows: DetailRow[] = live !== null
    ? rowsFromLive(live.queue)
    : fetchedRun !== null
      ? rowsFromLive(fetchedRun.queue)
      : rowsFromArchive(summary.queue);

  // One more view of the same live -> fetchedRun -> summary precedence as
  // `authority`/`rows` above, but as the WHOLE object rather than either of
  // their narrower projections (`authority` is a `RunFields` slice; `rows`
  // is already flattened into `DetailRow[]`). `runStageTotals` below needs
  // a real `.queue` of `{stage, stageAt}` items plus the run's own
  // `status` (its open-span credit is gated on `status === 'running'`,
  // never on `live` alone — see that function's own doc comment for why),
  // which only this unprojected object still carries.
  const source: OrchestratorRun | OrchestratorArchiveRun = live ?? fetchedRun ?? summary;

  const merged = rows.filter((r) => r.stage === 'merged').length;
  const skipped = rows.filter((r) => r.stage === 'skipped').length;
  const fixLoopsTotal = rows.reduce((sum, r) => sum + r.fixLoops, 0);
  // `ACTIVE_RUN_STAGES` (ItemCard.tsx) rather than RunDrawer's own
  // re-derivation of the same list — the exact import the brief's own
  // interfaces section names, and the one RunDrawer.tsx already reuses for
  // its equivalent "active" chip.
  const active = live !== null ? live.queue.filter((q) => ACTIVE_RUN_STAGES.includes(q.stage)).length : 0;
  const queued = live !== null ? live.queue.filter((q) => q.stage === 'pending').length : 0;

  const startedClock = formatClock(authority.startedAt);
  const wall = runWallMs(authority, now);

  return (
    <>
      <div className="run-detail-head">
        <span className="run-detail-id">{summary.runId}</span>
        <span className={`runs-status ${RUN_STATUS_CLASS[authority.status]}`}>
          <span aria-hidden="true">{RUN_STATUS_GLYPH[authority.status]}</span>
          {authority.status}
        </span>
        {/* Each half renders only if its own stamp parsed — RunDrawer's own
            null-tolerant join, restated here rather than re-derived: a run
            with a readable `startedAt` and a corrupt `updatedAt` can still
            say when it began even with no honest wall time to report. */}
        {(startedClock !== null || wall !== null) && (
          <span className="run-detail-time" data-testid="run-detail-time">
            {[
              startedClock === null ? null : `started ${startedClock}`,
              wall === null ? null : `${formatSpanCompact(wall)} elapsed`
            ].filter((part) => part !== null).join(' · ')}
          </span>
        )}
      </div>

      <div className="run-drawer-chips" data-testid="run-detail-chips">
        <span className="run-drawer-chip" data-testid="run-detail-chip-merged">
          <span className="run-drawer-chip-num">{merged}</span> merged
        </span>
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
            zero chips on every archived row would be noise, not information. */}
        {live !== null && (
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

      {fetchFailed && (
        // The one failure mode this pane can hit on its own (the fetch,
        // not the poll or the archive listing, both handled upstream): the
        // rows above are already fully rendered off `summary` regardless,
        // per the brief's own instruction that a failed tail fetch must
        // leave them standing — this note says only that one thing behind
        // them (a still-collapsed or still-open `<details>`) may never
        // gain a tail.
        <div className="run-detail-error" data-testid="run-detail-error">couldn't load verification output</div>
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
                  <span className="board-card-stage-glyph" aria-hidden="true">{stageGlyph(row.stage)}</span>
                  {row.stage}
                </span>
                {/* The shared `RowTime` (board/RunRowTime.tsx), not a
                    second inline reading — see this file's own header for
                    why growing a second "how long" implementation here is
                    exactly the mistake this move exists to foreclose. */}
                <RowTime item={row} now={now} testIdPrefix="run-detail-item-time" />
              </div>

              {/* The queue-wait / preflight lead line (Task 6) — the two
                  numbers `RowTime`'s `itemDurationMs` deliberately excludes
                  from "how long did this take" (this file's own header has
                  the real-run defect that exclusion fixed), restored here
                  as CONTEXT for why a queue was long rather than folded
                  back into any total. Omitted entirely, not rendered
                  empty, when NEITHER half is known: a `pending` item has
                  not started queueing out yet, and a hand-edited or
                  corrupt `stageAt` has nothing honest to report either. */}
              {(queueWait !== null || preflightSpan !== undefined) && (
                <div className="run-detail-lead" data-testid={`run-detail-lead-${row.id}`}>
                  {[
                    queueWait === null ? null : `queue ${formatSpanCompact(queueWait)}`,
                    preflightSpan === undefined ? null : `preflight ${formatSpan(preflightSpan.ms)}`
                  ].filter((part) => part !== null).join(' · ')}
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
                  count, not two. */}
              <StageTrack item={row} now={now} />

              {row.verify !== null && (
                // RunDrawer's own one-way-seed pattern, unchanged: React
                // only writes the `open` attribute when this PROP's value
                // changes, so a tail a person expanded by hand survives a
                // live run's 5s poll re-render instead of snapping shut on
                // every tick. Collapsed is not dropped — a passing tail is
                // still the proof the command ran; what has to stay legible
                // without expanding (what ran, whether it passed) is
                // already on the summary line above it.
                <details
                  className="run-drawer-item-verify"
                  data-testid={`run-detail-verify-${row.id}`}
                  open={!row.verify.ok}
                >
                  <summary className="run-drawer-item-verify-summary">
                    <span className="run-drawer-item-verify-cmd">{row.verify.cmd}</span>
                    <span className={row.verify.ok ? 'run-drawer-item-verify-ok' : 'run-drawer-item-verify-bad'}>
                      {row.verify.ok ? 'ok' : 'failed'}
                    </span>
                  </summary>
                  <span className="run-drawer-item-verify-tail">{row.verify.tail ?? ''}</span>
                </details>
              )}
            </div>
          );
        })}
      </div>

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
            <div
              key={`${a.id}-${a.kind}-${i}`}
              className="run-drawer-attn"
              data-testid={`run-detail-attention-${a.id}`}
            >
              <div className="run-drawer-attn-head">
                <span className="run-drawer-item-id">{a.id}</span>
                <span className="run-drawer-attn-kind">{a.kind}</span>
              </div>
              <div className="run-drawer-attn-detail">{a.detail}</div>
              {row !== undefined && row.questions.length > 0 && (
                <ul className="run-drawer-questions">
                  {row.questions.map((question) => <li key={question}>{question}</li>)}
                </ul>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
