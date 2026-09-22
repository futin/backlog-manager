import { useRef, useState } from 'react';

import { ApiError, cancelPauseOrchestrate, pauseOrchestrate, resumeOrchestrate, stopOrchestrate } from '../lib/agents';
import { isTerminalStage } from '../lib/run-time';
import { isCrashed } from '../lib/run-watchdog';
import { Chip } from './ui/Chip';
import { Confirm } from './ui/Confirm';
import { watchdogStoodDown } from '../../../shared/agent';
import { RUN_IN_PROGRESS_CODE } from '../../../shared/types';
import type { OrchestratorRun, RunQueueItem, RunWatchdog } from '../../../shared/types';

/**
 * RunControls — Pause / Cancel / Stop / Resume for one orchestrator run (task-17).
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
  /**
   * bug-39 — a person has asked for this run to END. Read verbatim off the
   * runs payload, never re-derived, and it outranks every other reading this
   * component makes: while it holds, no Resume is drawn in ANY branch, the
   * sweeper is standing down on the same one boolean, and no control is
   * offered at all — bug-53: the stop has already happened by the time this
   * reads `true`, so there is nothing left to withdraw.
   *
   * It is deliberately not folded into `watchdogStoodDown`: that predicate
   * being TRUE is what makes the crashed branch OFFER a Resume, so a stop
   * expressed through it would light up the button on exactly the runs it is
   * meant to take it away from.
   */
  stopRequested: boolean;
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
export type RunControlsChange = 'pause' | 'cancel' | 'resume' | 'stop';

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
  /**
   * bug-39 — `StopResult.abortRefused` from the click this component made,
   * or `null`.
   *
   * Component state rather than a field on `run`, and that is the honest
   * place for it: the runs payload can say whether a stop was REQUESTED (a
   * file on disk) but nothing on disk records whether a spawn was refused,
   * because a refusal starts nothing and writes nothing. So this survives
   * exactly as long as the tab that made the request, which is exactly as
   * long as the person who needs to read it is looking. A reload drops it
   * and the run is still stopped — the half that matters is on disk.
   */
  const [abortNote, setAbortNote] = useState<string | null>(null);
  /**
   * bug-53 — the Stop chip was clicked and the confirmation is drawn in its
   * place. Nothing has been sent: the click only asks, and the request goes out
   * from the confirmation's accept alone. Plain state, not a ref — nothing
   * races on it, and the row has to re-render to swap the chip for the question.
   */
  const [confirmingStop, setConfirmingStop] = useState(false);

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
      /* §8.8's third moving thing: a needs-you control FADES into the slot its
         host already reserves rather than snapping in or shoving the row
         beside it. One class on the one component both surfaces draw — the
         Runs detail head and the Watchdog page's rows — so the fade arrives
         wherever a Resume does, and the reserved slot is the host's
         (`.run-detail-controls`, `.watchdog-row-resume`), since only the host
         knows what it is reserving space inside of.
           It rides the resume control alone and not `.run-controls`: a Pause
         is present for the whole length of a healthy run and has nothing to
         fade in FROM, while a Resume appears mid-read, at the moment the
         sweeper gives up, which is precisely when a row that jumps costs a
         reader their place. */
      <span className="run-controls run-controls-needs-you">
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

  /**
   * The Stop control (bug-39) — drawn beside Pause on a fresh run and beside
   * (or instead of) Resume on a crashed one, because `running` fresh or stale
   * is exactly the set `POST /api/agents/stop` accepts and a STALE running run
   * is the case this bug was filed about: a driver killed by hand leaves one
   * for fifteen minutes, during which nothing could end it.
   *
   * **The click asks; only the answer acts (bug-53).** A stop abandons the item
   * in flight, removes its worktree and branch, and ends the run for good — and
   * for a whole release it did all of that on one click, at Pause's size, one
   * pixel-miss from it. So the chip opens `ui/Confirm` in its own place, naming
   * those consequences in the run's terms, and the request goes out from the
   * accept alone; the dismissal and Escape both make no request at all. The
   * confirmation is closed BEFORE the request is sent, and that is safe because
   * the guard against a second one is `act`'s ref, not the confirmation's
   * presence (bug-19's layer 1 — the accept goes through `act` like every other
   * branch).
   *
   * `variant` is left at the default accent, unlike Pause's cancel: this one
   * IS destructive, and a control that ends work must read like one — the
   * confirmation's own accept goes further, to `danger`.
   *
   * The result is read inside the call rather than in `onChanged`, because
   * `abortRefused` is the one thing this component learns that no later poll
   * can tell it.
   */
  const stopControl = (): JSX.Element => {
    if (confirmingStop) {
      const inFlight = inFlightItemId(run.queue);
      return (
        <Confirm
          label="confirm stop"
          testId="run-controls-stop-confirm"
          acceptLabel="Stop run"
          dismissLabel="Keep running"
          onDismiss={() => setConfirmingStop(false)}
          onAccept={() => {
            setConfirmingStop(false);
            act('stop', async () => {
              const result = await stopOrchestrate(run.project);
              setAbortNote(result.abortRefused);
            });
          }}
        >
          {inFlight === null
            ? 'End this run now? It cannot be resumed — the work left is a new run.'
            : `End this run now? ${inFlight} is abandoned, its worktree and branch are removed, and the run cannot be resumed.`}
        </Confirm>
      );
    }
    return (
      <Chip size={28} data-testid="run-controls-stop" title="end this run now — asks first, then abandons the item in flight" onClick={() => setConfirmingStop(true)}>
        Stop
      </Chip>
    );
  };

  /**
   * bug-39, and it outranks every branch below it: a person has asked for this
   * run to END.
   *
   * First, because a stop is a stronger statement than anything else this
   * component can read off a run. A stopped run offers no Pause (there is
   * nothing left to pause gracefully), and above all no Resume in ANY of the
   * three branches that draw one — a board that offered to resume a run
   * somebody just stopped would be fighting its own user, and on a crashed
   * stopped run the click would also race the `--abort` session this stop
   * already spawned.
   *
   * And no withdrawal either (bug-53). This branch used to draw a `Cancel
   * stop` chip, copied from Pause's `Cancel` along with the rest of the
   * control's shape — but a pause is a REQUEST the run honours later, and a
   * stop is an ACT: the request that recorded it already awaited the `--abort`
   * spawn before this field could read `true`, so the child is signalled and
   * the worktree is going. Deleting the control file then restored nothing and
   * read as an undo. What is left is the note, and the one fact the click
   * learned that no poll can re-supply. Starting the work again is a new run,
   * which the board already offers.
   */
  if (run.stopRequested) {
    return (
      <span className="run-controls">
        <span className="run-controls-note" data-testid="run-controls-stop-note">
          Stopping — this run is being ended
        </span>
        {abortNote === null ? null : (
          <span className="run-controls-note" data-testid="run-controls-abort-refused">
            {abortNote}
          </span>
        )}
        {errorNode}
      </span>
    );
  }

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
          {/* A pause already on file does not make a stop unreachable. They
              are different requests, and a person who asked for the graceful
              one is entitled to change their mind before the run reaches a
              boundary — which, if its session is wedged, it never will. The
              click overwrites the pause with a stop on the one control file,
              last write wins, which is why there is no third state to
              render here. */}
          {stopControl()}
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
        {stopControl()}
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
    //
    //   bug-39: what this branch may not do any more is return NOTHING. A
    // crashed run is `running` with a dead heartbeat, which is precisely the
    // shape `POST /api/agents/stop` accepts and precisely the shape this bug
    // was filed about — a driver killed by hand leaves one for fifteen
    // minutes, and until now the board offered no way to end it. So the
    // Resume stays gated exactly as it was, and the Stop is drawn either way.
    const resume = run.watchdog !== undefined && watchdogStoodDown(run.watchdog) ? resumeControl() : null;
    return (
      <span className="run-controls">
        {resume}
        {stopControl()}
        {errorNode}
      </span>
    );
  }

  if (run.status === 'paused') return resumeControl();

  return null;
}
