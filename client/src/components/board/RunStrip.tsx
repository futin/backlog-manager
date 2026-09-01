import { POLL_MS } from '../../hooks/useOrchestratorRuns';
import { elapsedSince } from '../../lib/item-age';
import { projectLabel } from '../../lib/project-label';
import { stageChipClass, stageGlyph } from '../../lib/run-stage';
import { formatSpanCompact, runElapsedMs } from '../../lib/run-time';
import type { OrchestratorRun, RunStage } from '../../../../shared/types';

/**
 * Mirrors RunStage's own doc comment in shared/types.ts almost verbatim:
 * "`merged` is the only success exit; `failed`, `skipped`, `needs-answers`,
 * `ungroomed`, and `parked` are the five ways an item leaves the pipeline
 * without merging." That set — the six rest states a queue item never moves
 * on from — is exactly what "current" below is defined against: the first
 * item NOT at one of these six is either genuinely mid-pipeline right now,
 * or (if the run has not dispatched anything yet) the next one due to be,
 * either of which is an honest answer to "what is this run doing".
 */
const TERMINAL_STAGES: readonly RunStage[] = [
  'merged', 'failed', 'skipped', 'needs-answers', 'ungroomed', 'parked'
];

/**
 * How young a run's heartbeat (`updatedAt`) has to be to read as the word
 * "live" outright rather than as an aged reading ("3m", "1h", ...) off the
 * same `elapsedSince` ladder the card's own in-progress bar uses. Equal to
 * `useOrchestratorRuns`' own POLL_MS, imported rather than restated (fix
 * round 1 — the two used to just happen to share a value): that hook only
 * learns anything new about a fresh run once per poll, so a heartbeat
 * younger than one poll's worth of time is, from this board's vantage
 * point, as current as information gets — and that IS the reason for the
 * number, not a coincidence next to it, so importing it means a future
 * change to the poll interval carries this reading with it instead of
 * leaving it silently wrong.
 */
const LIVE_THRESHOLD_MS = POLL_MS;

type RunPayload = OrchestratorRun & { fresh: boolean; pastRuns: number };

/**
 * RunStrip — the board's one window onto an orchestrator run in progress.
 *
 * Why this reads the RUN payload at all, rather than the items the columns
 * below it already render: an orchestrator run works each queued item
 * inside its own git worktree (see the plan's Task 3/5), and nothing about
 * that work reaches `main` — and so nothing reaches the item file this
 * board's own `/api/items` scan reads — until the item actually merges. A
 * bug or task can sit at `reviewing` for ten minutes with its item file on
 * `main` looking exactly as it did before the run started: no `started:`
 * stamp, no `phase:` key, nothing `isInProgress` (item-progress.ts) could
 * ever key off. The item, in other words, is not lying — it is telling the
 * truth about `main`, which genuinely has not changed yet. The only place
 * "this item is executing right now" exists at all is the run file
 * `useOrchestratorRuns` already polls for a completely different reason
 * (Task 10), so that payload — not the item — is this strip's only possible
 * source, and it is ItemCard's `run` prop's source too (see
 * BoardView's own comment on the id→entry lookup for the other half of
 * this).
 *
 * The flip side of that same fact is why a stale run must render nothing at
 * all rather than a dimmed or frozen version of its last known state: once
 * `fresh` goes false, this component has no way to tell "the run is still
 * exactly where it last reported" from "the run moved on three more stages
 * and we simply stopped hearing about it" — RUN_STALE_MS (shared/types.ts)
 * exists precisely because the watch loop can go silent (crash, wedge) with
 * no further writes to the run file at all. A strip left on screen after
 * that point would be presenting a guess as a fact. Returning null here is
 * the same call DispatchButton already makes for its own four
 * environment-level blocks — render nothing, not a control that LOOKS live
 * but cannot be trusted.
 */
export function RunStrip({ run, onOpen }: { run: RunPayload; onOpen: (run: RunPayload) => void }) {
  // See this function's own doc comment above for why a stale run gets
  // silence instead of a dimmed rendering of its last known state.
  if (!run.fresh) return null;

  // total excludes `ungroomed`: a controller ruling this task exists to
  // honour (see the fixture comment in test/orchestrator-strip.test.tsx) —
  // an ungroomed item was never queueable work to begin with, so counting
  // it against the denominator would make a run that skipped it on sight
  // read as permanently short of "done".
  const total = run.queue.filter((q) => q.stage !== 'ungroomed').length;
  const merged = run.queue.filter((q) => q.stage === 'merged').length;
  const current = run.queue.find((q) => !TERMINAL_STAGES.includes(q.stage));
  const pct = total === 0 ? 0 : Math.round((merged / total) * 100);

  const heartbeatMs = Date.now() - Date.parse(run.updatedAt);
  const live = Number.isFinite(heartbeatMs) && heartbeatMs < LIVE_THRESHOLD_MS;
  // Reused from item-age.ts rather than a second age ladder: this is the
  // exact same problem (an ISO stamp aged into "now"/"20m"/"3h"/"11d" for a
  // human to read at a glance) the card's own in-progress bar already
  // solved. `null` here means `updatedAt` could not be parsed at all — a
  // malformed run file is not this component's problem to diagnose, just
  // one it must not crash or print "NaN" over.
  const age = elapsedSince(run.updatedAt);

  // How long the whole run has been going — a different question from the
  // heartbeat beside it, and the one people actually ask about an unattended
  // run they left going. `live`/`3m` says whether the board is still hearing
  // from the process; this says how long that process has been at it. Ticks
  // on its own because `useOrchestratorRuns` re-renders this every 5s while
  // the run is fresh, so no clock of its own is needed here (contrast
  // `useNow`, which exists precisely for the cards that get no such poll).
  //
  // `null` — an unparseable `startedAt` — renders NOTHING rather than a dash:
  // the heartbeat slot next to it already owns the "—" placeholder for its
  // own unparseable case, and two dashes in a row would read as one broken
  // field rather than as two separate readings, one of which is fine.
  const elapsed = runElapsedMs(run);

  // A label only — NOT the key anything is matched on. BoardView's own
  // lookup (see its comment on runStageFor) compares `run.project` to
  // `item.projectPath` directly, both already the same absolute registry
  // path; that comparison never touches this derivation. This component's
  // signature is fixed at `{ run, onOpen }`, so the one project-identifying
  // field it has is the path itself — see lib/project-label.ts (fix round 1)
  // for why it's the readable tail rather than the raw path that gets
  // printed here, and why that derivation now lives in one shared place.
  const label = projectLabel(run.project);

  return (
    <button
      type="button"
      className="run-strip"
      data-testid="run-strip"
      onClick={() => onOpen(run)}
    >
      {/* Decorative: the adjacent "live"/aged text is the actual answer for
          a screen reader, matching how the card's own live-bar dot-equivalent
          (its amber fill) is never the only carrier of that state — the words
          beside it always are. */}
      <span className={live ? 'run-strip-dot run-strip-dot-live' : 'run-strip-dot'} aria-hidden="true" />
      <span className="run-strip-project">{label}</span>
      <span className="run-strip-heartbeat">{live ? 'live' : age ?? '—'}</span>
      {elapsed !== null && (
        <span className="run-strip-elapsed" data-testid="run-strip-elapsed">
          {formatSpanCompact(elapsed)}
        </span>
      )}
      <span className="run-strip-count">{merged}/{total}</span>
      {/* Purely a graphical restatement of the count just printed — hidden
          from the accessibility tree so a screen reader is not made to sit
          through the same fact twice in two forms. */}
      <span className="run-strip-bar" aria-hidden="true">
        <span className="run-strip-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      {/* The id stays plain text and the stage becomes a chip: they are two
          different kinds of fact sitting in one phrase — which item (stable,
          it is the item's name) and what it is doing (the most volatile thing
          on this strip). Chipping the stage with the same class the card and
          drawer use means the reader learns one visual language once. The
          `·` separator goes with it: a chip is its own delimiter. */}
      {current && (
        <span className="run-strip-current">
          {current.id}
          <span className={stageChipClass(current.stage)}>
            <span className="board-card-stage-glyph" aria-hidden="true">
              {stageGlyph(current.stage)}
            </span>
            {current.stage}
          </span>
        </span>
      )}
      {run.attention.length > 0 && (
        <span className="run-strip-attention">{run.attention.length} needs attention</span>
      )}
      {/* The same "there is more here" mark DispatchButton's own ▸ already
          is on every card (dispatch-mark) — aria-hidden for the identical
          reason: the accessible story is "this is a button", which the
          element's own role already says, not a glyph. Task 12's run drawer
          is what this mark promises; until it exists the click is real (see
          BoardView's own comment on why onOpen is still a no-op today) but
          this is the one honest way to say "there will be more to see". */}
      <span className="run-strip-mark" aria-hidden="true">▸</span>
    </button>
  );
}
