import { useRef, useState } from 'react';

import { ApiError, cancelPauseOrchestrate, pauseOrchestrate, resumeOrchestrate } from '../lib/agents';
import { isTerminalStage } from '../lib/run-time';
import { isCrashed } from '../lib/run-watchdog';
import { Chip } from './ui/Chip';
import { watchdogStoodDown } from '../../../shared/agent';
import { RUN_IN_PROGRESS_CODE } from '../../../shared/types';
import type { OrchestratorRun, RunQueueItem, RunWatchdog } from '../../../shared/types';

/**
 * RunControls — Pause / Cancel / Resume for one orchestrator run (task-17).
 *
 * **Why one component, at the top level of `components/`.** Two surfaces
 * hosted these controls: the board's run drawer and the Runs view's detail
 * pane (`runs/RunDetail.tsx`). task-37 deleted the first — the run's detail is
 * the Runs page's own sheet now, never a second copy on the Board — and
 * task-38 collapsed the board's remaining Resume affordances (the crashed
 * strip's and the paused strip's) into this one component, drawn in the Runs
 * detail sheet's HEAD. So there is one host, and it is the only place any run
 * state offers a Resume: **exactly one Resume per run state, never two to keep
 * in agreement.** The component nevertheless stays at the top level rather
 * than moving under `runs/` — it is read from a lazy chunk, and
 * `lib/view-keys.ts` sits at the top level for the same reason.
 * A copy per host would be two hand-written renderings of one table, which
 * is precisely the failure `watchdogStoodDown`'s own doc comment records: a
 * rule that lived as two expressions that merely agreed survived a whole
 * branch with every test green while one half was quietly widened.
 *
 * **Why the crashed run's Resume is gated and the paused one's is not.** A
 * crashed run's Resume renders only once `watchdogStoodDown` (shared/agent.ts)
 * says the sweeper will not spawn one itself, because the watchdog may be
 * about to resume that run on its own and a click plus a sweep both driving
 * `--resume` into one `run.json` is the race that gate exists to prevent
 * (bug-19's hazard; `test/watchdog-coupling.test.tsx` drives this head from
 * one table of hand-checked verdicts). A `paused` run was never a watchdog
 * subject — the sweeper only walks `running` runs — so there is no automation
 * to coordinate with and no equivalent condition to check. Do NOT "align" the
 * two branches: adding the watchdog condition to the paused one would read a
 * `watchdog` key that is absent by construction and hide the control on every
 * paused run, and dropping it from the crashed one reopens the double spawn.
 *
 * **The crashed branch dispatches through `act` like every other branch, and
 * that is bug-19's layer 1.** `act`'s `if (busy) return` is the only guard
 * that can catch a second click before the first answer lands — the hosts'
 * own `resuming` mark is set from `onChanged`, i.e. AFTER the request settles,
 * so for the whole in-flight window nothing above that line has changed on
 * screen (occurrence 1 was three clicks inside ten seconds against a control
 * that looked identical after each). A second, branch-local state variable
 * would be a synchronous guard that does not cover every branch, which is no
 * guard at all.
 *
 * Everything below is decided from the `run` entry alone. The host passes no
 * hint about which controls to show, so a second host could not disagree.
 */

/** The only fields of a runs-payload entry this component reads — a `Pick`
 *  rather than the whole entry, so a host can hand it a live entry or a
 *  synthesised one (RunDetail does the latter for a run with no live entry)
 *  without either being a lie about what is used. */
export type RunControlsRun = Pick<OrchestratorRun, 'status' | 'project'> & {
  fresh: boolean;
  pauseRequested: boolean;
  queue: ReadonlyArray<Pick<RunQueueItem, 'id' | 'stage'>>;
  /** The sweeper's own record for this run, `undefined` for a run it has
   *  never been a subject of — the narrow window between a run first going
   *  crashed and the server's next annotation pass (`OrchestratorRunsPayload`'s
   *  own doc comment). Absent is treated as "the sweeper may still act", which
   *  is why the crashed branch below requires the key to be present before it
   *  asks `watchdogStoodDown` anything. */
  watchdog?: RunWatchdog;
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

export function RunControls({
  run,
  gate,
  resuming,
  onChanged
}: {
  run: RunControlsRun;
  gate: { canResume: boolean; blockedReason: string | null };
  resuming: boolean;
  onChanged: (kind: RunControlsChange) => void;
}): JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  /**
   * bug-19's layer 1, in two halves — and they are two on purpose.
   *
   * `busyRef` is the GUARD. It has to be a ref rather than the state below
   * because `setBusy(true)` does not change the value `busy` holds in this
   * render's closure: two clicks dispatched before React re-renders both read
   * `false` and both fire. A state-backed check only catches a second click
   * that arrives after a repaint — which is most of them, and is the shape
   * bug-19's own occurrence had (three clicks inside ten seconds), but it is
   * not the guarantee the invariant states. A ref is assigned and read in the
   * same synchronous turn, so "the only layer that can catch a second click
   * before the first answer lands" is true of every second click rather than
   * of the slow ones. Measured: with the ref removed, two clicks in one tick
   * send two POSTs.
   *
   * `busy` is the RENDERING. A ref does not re-render, and the control has to
   * swap itself for the `Resuming…` word while the request is out — the
   * host's own `resuming` mark cannot do it, being set from `onChanged`, i.e.
   * after the request settles.
   */
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const act = (kind: RunControlsChange, call: () => Promise<unknown>): void => {
    if (busyRef.current) return;
    busyRef.current = true;
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
      // Both halves cleared on BOTH settle paths — a spawn that threw started
      // no session, and the server's own lock is likewise cleared there.
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const errorNode =
    error === null ? null : (
      <span className="run-controls-error" data-testid="run-controls-error">
        {error}
      </span>
    );

  /**
   * The Resume control itself, composed ONCE and drawn by both the paused and
   * the crashed branch below (task-38). Two hand-written copies of it is the
   * shape this file's own header argues against, and here it would be four
   * decisions to keep in agreement rather than one: the environment ladder
   * hides the control outright (the dashboard cannot spawn for anyone, and a
   * disabled button explaining that on every resumable run is noise), the
   * project-visibility block keeps its button `aria-disabled` with the reason
   * as its title (CLAUDE.md's disable-don't-hide rule — that is the one answer
   * a tab can hold while it is already wrong), `aria-disabled` is never the
   * native attribute (a genuinely disabled button leaves the tab order, and
   * the whole point of keeping this one is that a keyboard user can reach it
   * and read why it will not act), and a resume already on its way replaces
   * the button with a word.
   *
   * "Already on its way" is BOTH halves, and they are not redundant (bug-19):
   * `busy` is this component's own synchronous in-flight flag, the only thing
   * that can catch a second click before the first answer lands, and
   * `resuming` is the host's mark, the only thing that survives past it — a
   * resumed session needs ~90s to reach its first heartbeat, and re-enabling
   * the control on settle alone restores exactly the state a triple-click
   * came out of.
   */
  const resumeControl = (): JSX.Element | null => {
    if (!gate.canResume) return null;
    return (
      <span className="run-controls">
        {resuming || busy ? (
          <span className="run-controls-note" data-testid="run-controls-resuming">
            Resuming…
          </span>
        ) : (
          <Chip
            size={28}
            data-testid="run-controls-resume"
            aria-disabled={gate.blockedReason !== null || undefined}
            title={gate.blockedReason ?? undefined}
            onClick={() => {
              if (gate.blockedReason !== null) return;
              // Through `act`, never a second guard of its own — see the
              // file header's "bug-19's layer 1" paragraph.
              act('resume', () => resumeOrchestrate(run.project));
            }}
          >
            Resume run
          </Chip>
        )}
        {errorNode}
      </span>
    );
  };

  // A fresh, reporting run: the only state with something to STOP. Checked
  // first so every branch below can assume a run that is not moving.
  if (run.status === 'running' && run.fresh) {
    if (run.pauseRequested) {
      const inFlight = inFlightItemId(run.queue);
      return (
        <span className="run-controls">
          <span className="run-controls-note" data-testid="run-controls-note">
            {inFlight === null ? 'Pausing at the next boundary' : `Pausing after ${inFlight}`}
          </span>
          {/* `flat` — no accent, and that is the design's own call
              (DESIGN.md §8.4.1): nothing here stops a run, this only
              withdraws the pause request, and a control that is not
              destructive must not read as one. */}
          <Chip size={28} variant="flat" data-testid="run-controls-cancel" onClick={() => act('cancel', () => cancelPauseOrchestrate(run.project))}>
            Cancel
          </Chip>
          {errorNode}
        </span>
      );
    }
    return (
      <span className="run-controls">
        {/* Not "pause now": the run finishes the item it is on. Saying so in
            the title is the difference between a control a person trusts and
            one they click twice. */}
        <Chip size={28} data-testid="run-controls-pause" title="pause after the current item" onClick={() => act('pause', () => pauseOrchestrate(run.project))}>
          Pause
        </Chip>
        {errorNode}
      </span>
    );
  }

  // task-38: the crashed run's Resume, and the ONE place on the client that
  // offers it. `isCrashed` (lib/run-watchdog.ts) rather than a second
  // `status === 'running' && !fresh` written here — a crashed run renders as
  // crashed and never as nothing, and the one implementation of "is it
  // crashed" is what keeps this head, the Live row and the sweeper from
  // drifting about where the line falls.
  if (isCrashed(run)) {
    // The one hard constraint this branch must not relax: the control renders
    // ONLY once the watchdog itself has stood down — exhausted its attempts,
    // or been switched off — never while it might still be mid-cycle. Those
    // two states are exactly the ones in which the sweeper's own next tick
    // will NOT spawn a resume, which is the only thing preventing a click and
    // a sweep from both driving `--resume` into the same run at the same
    // moment. `watchdogStoodDown` is the SAME function `watchdog.service.ts`'s
    // `visit()` returns on without spawning; do not inline it back into an
    // `||` here, however obvious it looks — until a whole-branch review that
    // widening left every test green, because the rule lived as two hand-
    // written expressions in two files that merely agreed.
    //   An ABSENT `watchdog` key offers nothing: it means the server has not
    // annotated this run yet, so the sweeper's intentions are unknown, and an
    // unknown must read as "it may still act" rather than as a stand-down.
    if (run.watchdog === undefined || !watchdogStoodDown(run.watchdog)) return null;
    return resumeControl();
  }

  if (run.status === 'paused') return resumeControl();

  return null;
}
