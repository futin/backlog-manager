import { useState } from 'react';

import { ApiError, cancelPauseOrchestrate, pauseOrchestrate, resumeOrchestrate } from '../lib/agents';
import { isTerminalStage } from '../lib/run-time';
import { RUN_IN_PROGRESS_CODE } from '../../../shared/types';
import type { OrchestratorRun, RunQueueItem } from '../../../shared/types';

/**
 * RunControls — Pause / Cancel / Resume for one orchestrator run (task-17).
 *
 * **Why one component, at the top level of `components/`.** Two surfaces
 * host these controls: the board's run drawer (`board/RunDrawer.tsx`) and
 * the Runs view's detail pane (`runs/RunDetail.tsx`). Those live in two
 * different lazy chunks, so neither may import from the other — the same
 * constraint that put `lib/view-keys.ts` at the top level rather than
 * exporting the shared board/archive filter key from one of the two views.
 * A copy per host would be two hand-written renderings of one table, which
 * is precisely the failure `watchdogStoodDown`'s own doc comment records: a
 * rule that lived as two expressions that merely agreed survived a whole
 * branch with every test green while one half was quietly widened.
 *
 * **Why the crashed run is not this component's business.** A crashed run's
 * Resume lives on `RunStrip` alone, behind `watchdogStoodDown` — because the
 * watchdog may be about to spawn a resume for that run itself, and a click
 * plus a sweep both driving `--resume` into one `run.json` is the race that
 * gate exists to prevent. A `paused` run was never a watchdog subject (the
 * sweeper only walks `running` runs), so there is no automation to
 * coordinate with here and no equivalent condition to check. This component
 * therefore renders NOTHING for a crashed run, and that absence is asserted
 * rather than incidental: widening it to "any resumable run" would move the
 * crashed case out from behind its gate.
 *
 * Everything below is decided from the `run` entry alone. Neither host
 * passes a hint about which controls to show, so the two cannot disagree.
 */

/** The only fields of a runs-payload entry this component reads — a `Pick`
 *  rather than the whole entry, so a host can hand it a live entry or a
 *  synthesised one (RunDetail does the latter for a run with no live entry)
 *  without either being a lie about what is used. */
export type RunControlsRun = Pick<OrchestratorRun, 'status' | 'project'> & {
  fresh: boolean;
  pauseRequested: boolean;
  queue: ReadonlyArray<Pick<RunQueueItem, 'id' | 'stage'>>;
};

/** Which call a completed click made — the hosts react differently to a
 *  resume (they also mark the poll) than to the other two. */
export type RunControlsChange = 'pause' | 'cancel' | 'resume';

/**
 * The item the run is working right now, or `null` when it is between items
 * (everything left is `pending`, or everything is done).
 *
 * "Neither `pending` nor terminal" is the same definition `RunStrip`'s own
 * in-flight lookup uses, backed by `isTerminalStage`'s `Record<RunStage,
 * true>` pin — so a stage added to the vocabulary has to be classified
 * there, once, rather than remembered here.
 *
 * FIRST match, not last: a queue is worked in order, so the earliest
 * non-terminal, non-pending entry is the one actually in flight. (A run only
 * ever has one, but reading the first makes that assumption explicit rather
 * than load-bearing.)
 */
export function inFlightItemId(queue: RunControlsRun['queue']): string | null {
  const item = queue.find((q) => q.stage !== 'pending' && !isTerminalStage(q.stage));
  return item?.id ?? null;
}

export function RunControls({ run, gate, resuming, onChanged }: {
  run: RunControlsRun;
  gate: { canResume: boolean; blockedReason: string | null };
  resuming: boolean;
  onChanged: (kind: RunControlsChange) => void;
}): JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  // Guards a double-click from firing two requests before the first answer
  // lands — the payload that would disable the button has not arrived yet at
  // that point, so nothing else prevents it.
  const [busy, setBusy] = useState(false);

  const act = (kind: RunControlsChange, call: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    call()
      .then(() => onChanged(kind))
      .catch((err: unknown) => {
        // The crashed strip's own rule, reused verbatim: a resume refused
        // because the run is already alive means the run came back under
        // this very click — the outcome the click wanted, so it takes the
        // success path rather than rendering an error for something that
        // just fixed itself.
        if (kind === 'resume' && err instanceof ApiError && err.code === RUN_IN_PROGRESS_CODE) {
          onChanged(kind);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  const errorNode = error === null ? null : (
    <span className="run-controls-error" data-testid="run-controls-error">{error}</span>
  );

  // A run this component has nothing to offer for: crashed (the strip owns
  // it), or over. Checked first so every branch below can assume a live or
  // paused run.
  if (run.status === 'running' && run.fresh) {
    if (run.pauseRequested) {
      const inFlight = inFlightItemId(run.queue);
      return (
        <span className="run-controls">
          <span className="run-controls-note" data-testid="run-controls-note">
            {inFlight === null ? 'Pausing at the next boundary' : `Pausing after ${inFlight}`}
          </span>
          <button
            type="button"
            className="run-controls-btn"
            data-testid="run-controls-cancel"
            onClick={() => act('cancel', () => cancelPauseOrchestrate(run.project))}
          >
            Cancel
          </button>
          {errorNode}
        </span>
      );
    }
    return (
      <span className="run-controls">
        <button
          type="button"
          className="run-controls-btn"
          data-testid="run-controls-pause"
          // Not "pause now": the run finishes the item it is on. Saying so
          // in the title is the difference between a control a person trusts
          // and one they click twice.
          title="pause after the current item"
          onClick={() => act('pause', () => pauseOrchestrate(run.project))}
        >
          Pause
        </button>
        {errorNode}
      </span>
    );
  }

  if (run.status === 'paused') {
    // The environment ladder hides the control outright — the dashboard
    // cannot spawn anything for anyone, and a disabled button explaining
    // that on every paused run would be noise. The project-visibility block
    // (a non-null reason with `canResume` still true) keeps its button
    // instead, per CLAUDE.md's disable-don't-hide rule: that is the one
    // answer a tab can hold while it is already wrong.
    if (!gate.canResume) return null;
    return (
      <span className="run-controls">
        {resuming ? (
          <span className="run-controls-note" data-testid="run-controls-resuming">Resuming…</span>
        ) : (
          <button
            type="button"
            className="run-controls-btn"
            data-testid="run-controls-resume"
            // `aria-disabled`, never the native `disabled` attribute — a
            // genuinely disabled button leaves the tab order, and the whole
            // point of keeping this one is that a keyboard user can reach it
            // and read why it will not act.
            aria-disabled={gate.blockedReason !== null || undefined}
            title={gate.blockedReason ?? undefined}
            onClick={() => {
              if (gate.blockedReason !== null) return;
              act('resume', () => resumeOrchestrate(run.project));
            }}
          >
            Resume run
          </button>
        )}
        {errorNode}
      </span>
    );
  }

  return null;
}
