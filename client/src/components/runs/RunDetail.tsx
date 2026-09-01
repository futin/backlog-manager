import { useEffect, useState } from 'react';

import { fetchArchivedRun } from '../../lib/agents';
import { itemStageSpans, itemWallMs, runWallMs } from '../../lib/run-stats';
import {
  RUN_STATUS_CLASS, RUN_STATUS_GLYPH, stageChipClass, stageGlyph, STAGE_TONE
} from '../../lib/run-stage';
import { formatClock, formatSpanCompact } from '../../lib/run-time';
import { ACTIVE_RUN_STAGES } from '../board/ItemCard';
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
 * item`/`.run-drawer-item-verify*` (RunDrawer's per-item chrome) are all
 * worn verbatim. The only genuinely new visual grammar this file needs is
 * the segmented per-item stage bar — RunDrawer's seven-dot stepper answers
 * "how far along," which a finished run has no use for; this pane answers
 * "where did the time go," which the stepper cannot.
 *
 * ---- Data source: summary vs. live, and why rows read from BOTH ----
 *
 * `summary` (an `OrchestratorArchiveRun`) is the one prop guaranteed to be
 * populated the instant this component mounts — it is what RunsView already
 * held before a row was even clicked. It drives the header stamps, the four
 * base count chips, and every ROW's id/title/stage/stageAt/fixLoops: an
 * `ArchiveQueueItem` differs from a full `RunQueueItem` in exactly one way
 * (`verification[].tail` stripped to keep the archive listing's payload
 * bounded — see `ArchiveQueueItem`'s own doc comment), so every field this
 * pane needs for a row except the verification tail is already sitting on
 * `summary.queue` with no fetch required at all.
 *
 * `live`, when given, is a DIFFERENT run object — the live poll's own entry
 * for this exact runId — and RunsView.tsx's own comment on `mergeRuns`
 * states plainly why this pane, not that one, is the thing that reads it:
 * "Task 7 is what will render a selected live run's actual queue from the
 * live object directly." The reason is freshness, not shape:
 * `useOrchestratorArchive` (the source of `summary`) fetches only on mount
 * and window focus, so a `summary` entry for a run that is STILL RUNNING can
 * be minutes stale while `useOrchestratorRuns` (the source of `live`) polls
 * every five seconds. Reading rows off `summary` regardless would make an
 * actively-progressing run look frozen behind the pane RunsView built
 * specifically to watch it live. So: `live` present -> every row, the base
 * chip counts, AND the header's status/wall-time all read off `live`
 * instead, including its own verification tails (a live payload never has
 * them stripped). `live` absent -> everything reads off `summary`, and only
 * the tail text is worth fetching at all, since the rest of an ARCHIVED
 * run's own summary can never go stale (the run is over; nothing about it
 * changes again).
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
  const now = Date.now();

  // See the file header comment's "Data source" section for why `live`,
  // when present, is the authority for every one of these — not just tails.
  const runForHeader: RunFields = live ?? summary;
  const rows: DetailRow[] = live !== null ? rowsFromLive(live.queue) : rowsFromArchive(summary.queue);
  const attention = runForHeader.attention;

  // The tail patch-in for the ARCHIVED path only: once `fetchedRun` lands,
  // every row's `verify.tail` (still `null` from `rowsFromArchive` above)
  // is filled in by matching on item id — the fetched run is the same run
  // file `summary` was already built from, so id and "last verification
  // entry" line up exactly. Left as a no-op map on the live path (`rows`
  // there already has tails from `rowsFromLive`) and while nothing has
  // landed yet, which is exactly "rows render immediately, tails fill in
  // later" from the brief.
  const rowsWithTails: DetailRow[] = live !== null || fetchedRun === null
    ? rows
    : rows.map((row) => {
      if (row.verify === null) return row;
      const full = fetchedRun.queue.find((q) => q.id === row.id);
      const tail = full !== undefined && full.verification.length > 0
        ? full.verification[full.verification.length - 1].tail
        : null;
      return { ...row, verify: { ...row.verify, tail } };
    });

  const merged = rowsWithTails.filter((r) => r.stage === 'merged').length;
  const skipped = rowsWithTails.filter((r) => r.stage === 'skipped').length;
  const fixLoopsTotal = rowsWithTails.reduce((sum, r) => sum + r.fixLoops, 0);
  // `ACTIVE_RUN_STAGES` (ItemCard.tsx) rather than RunDrawer's own
  // re-derivation of the same list — the exact import the brief's own
  // interfaces section names, and the one RunDrawer.tsx already reuses for
  // its equivalent "active" chip.
  const active = live !== null ? live.queue.filter((q) => ACTIVE_RUN_STAGES.includes(q.stage)).length : 0;
  const queued = live !== null ? live.queue.filter((q) => q.stage === 'pending').length : 0;

  const startedClock = formatClock(runForHeader.startedAt);
  const wall = runWallMs(runForHeader, now);

  return (
    <>
      <div className="run-detail-head">
        <span className="run-detail-id">{summary.runId}</span>
        <span className={`runs-status ${RUN_STATUS_CLASS[runForHeader.status]}`}>
          <span aria-hidden="true">{RUN_STATUS_GLYPH[runForHeader.status]}</span>
          {runForHeader.status}
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

      <div className="run-detail-heading">Items</div>
      <div className="run-drawer-queue" data-testid="run-detail-items">
        {rowsWithTails.map((row) => {
          const spans = itemStageSpans(row);
          const wallItem = itemWallMs(row);
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
                {wallItem !== null && (
                  <span className="run-drawer-item-time">{formatSpanCompact(wallItem)}</span>
                )}
              </div>

              {/* A stage bar with no spans renders NOTHING — not an empty
                  rail — per the brief: an item with fewer than two parsed
                  `stageAt` stamps (never dispatched, or corrupt timestamps)
                  has no "where did the time go" story to tell, and an empty
                  strip of the same height as a real bar would look like a
                  rendering bug rather than the honest absence it is. */}
              {spans.length > 0 && (
                <>
                  <div className="run-detail-stagebar" data-testid={`run-detail-stagebar-${row.id}`}>
                    {spans.map((span, i) => (
                      <span
                        key={`${span.stage}-${i}`}
                        // `run-seg-<tone>` — STAGE_TONE's own six-way map,
                        // not a second stage->color ladder invented here.
                        // Width proportional to the span's own share of
                        // this item's total wall time: `flexGrow` set to
                        // the raw millisecond count with `flexBasis: 0`
                        // lets flexbox do that division for every segment
                        // in one pass, with `.run-detail-seg`'s own
                        // `min-width: 2px` (styles.css) as the floor that
                        // keeps a genuinely brief stage visible rather than
                        // shrinking to nothing beside a much longer one.
                        className={`run-detail-seg run-seg-${STAGE_TONE[span.stage]}`}
                        style={{ flexGrow: span.ms, flexBasis: 0 }}
                      />
                    ))}
                  </div>
                  <div className="run-detail-caption" data-testid={`run-detail-caption-${row.id}`}>
                    {spans.map((span) => `${span.stage} ${formatSpanCompact(span.ms)}`).join(' · ')}
                  </div>
                </>
              )}

              {row.fixLoops > 0 && (
                <div className="run-drawer-item-fixloops">
                  {row.fixLoops} fix loop{row.fixLoops === 1 ? '' : 's'}
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
          const row = rowsWithTails.find((r) => r.id === a.id);
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
