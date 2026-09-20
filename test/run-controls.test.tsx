/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ApiError } from '../client/src/lib/agents';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import { RunControls, inFlightItemId } from '../client/src/components/RunControls';
import type { RunControlsChange, RunControlsRun } from '../client/src/components/RunControls';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

const fixture = rawFixture as OrchestratorRun;

/** The five calls this component can make, all stubbed — every case here is
 *  about what the component decides, never about what the API answers. */
jest.mock('../client/src/lib/agents', () => {
  const actual = jest.requireActual('../client/src/lib/agents');
  return {
    ...actual,
    pauseOrchestrate: jest.fn(() => Promise.resolve({ pauseRequested: true })),
    cancelPauseOrchestrate: jest.fn(() => Promise.resolve({ pauseRequested: false })),
    resumeOrchestrate: jest.fn(() => Promise.resolve({ sessionId: 'sess-1' })),
    // bug-39. The default answer is the SUCCEEDING one — a stop recorded and
    // an abort session started — so a case about a refusal has to arrange it
    // rather than inherit it.
    stopOrchestrate: jest.fn(() => Promise.resolve({ stopRequested: true, abortSession: 'sess-abort', abortRefused: null })),
    cancelStopOrchestrate: jest.fn(() => Promise.resolve({ stopRequested: false, abortSession: null, abortRefused: null }))
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const agents = jest.requireMock('../client/src/lib/agents') as {
  pauseOrchestrate: jest.Mock;
  cancelPauseOrchestrate: jest.Mock;
  resumeOrchestrate: jest.Mock;
  stopOrchestrate: jest.Mock;
  cancelStopOrchestrate: jest.Mock;
};

const OPEN_GATE = { canResume: true, blockedReason: null };

/**
 * Two clicks that both land before React re-renders — which is the ONLY shape
 * that tests bug-19's layer 1, and the reason this is a raw `dispatchEvent`
 * pair inside one `act` rather than two `userEvent.click`s.
 *
 * `userEvent.click` awaits between clicks, so React has already re-rendered by
 * the second one and the control has already swapped itself for the
 * `Resuming…` word. The second click then lands on a detached node and calls
 * nothing — which means the case passes with the synchronous guard DELETED,
 * i.e. it proves the rendered state and not the guard. (Measured: with
 * `if (busy) return` removed from `act`, the `userEvent` version of this case
 * stayed green.)
 *
 * The real defect is a person double-clicking inside the in-flight window,
 * where nothing on screen has changed yet because the host's `resuming` mark
 * is set from `onChanged` — i.e. after the request settles. Dispatching both
 * events in one `act` reproduces exactly that: both handlers run against the
 * same render, and only `act`'s own `if (busy) return` can stop the second.
 */
function doubleClick(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function runFor(over: Partial<RunControlsRun> = {}): RunControlsRun {
  return {
    status: fixture.status,
    project: fixture.project,
    fresh: true,
    pauseRequested: false,
    stopRequested: false,
    queue: fixture.queue.map((q) => ({ id: q.id, stage: q.stage })),
    ...over
  };
}

function renderControls(
  over: Partial<RunControlsRun> = {},
  props: Partial<{
    gate: { canResume: boolean; blockedReason: string | null };
    resuming: boolean;
    onChanged: (kind: RunControlsChange) => void;
  }> = {}
) {
  const onChanged = props.onChanged ?? jest.fn();
  render(<RunControls run={runFor(over)} gate={props.gate ?? OPEN_GATE} resuming={props.resuming ?? false} onChanged={onChanged} />);
  return onChanged;
}

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * One component, one decision table, every decision made from the run entry
 * alone — that is what these cases pin. A second copy of the table living in
 * each host is exactly the drift `watchdogStoodDown`'s own history records.
 *
 * task-38 made the crashed run this component's business too: its Resume is
 * here, behind `watchdogStoodDown`, because the watchdog may be about to spawn
 * one itself and a click plus a sweep both driving `--resume` into one
 * `run.json` is the race that gate exists to prevent. The full verdict TABLE
 * for that gate lives in `test/watchdog-coupling.test.tsx`, driven from the
 * same hand-checked rows the sweeper's own half is; what this file adds is the
 * rest of the crashed branch — that an unannotated run offers nothing, and
 * that the branch dispatches through the same synchronous guard every other
 * one does.
 *
 * A paused run was never a watchdog subject (the sweeper only walks `running`
 * runs), so it has no such coordination to do, and its Resume is gated by the
 * environment ladder alone.
 */
describe('RunControls — what renders, by run', () => {
  /**
   * The exact control set per run state, as an EXACT set rather than a
   * presence check — bug-39 added a second control to two of these rows, and
   * a case that only asserted what it expected to find would not have
   * noticed either the addition or a later accidental removal.
   *
   * A `running` run carries Stop in both of its rows, fresh or pausing
   * alike, because `running` fresh-or-stale is exactly the set the stop route
   * accepts. A `paused` run does not: it has already stopped, and the route
   * refuses it.
   */
  const ALL_CONTROLS = ['run-controls-pause', 'run-controls-cancel', 'run-controls-stop', 'run-controls-cancel-stop', 'run-controls-resume'];

  it.each([
    ['a fresh running run', { status: 'running' as const, fresh: true, pauseRequested: false }, ['run-controls-pause', 'run-controls-stop']],
    ['a fresh running run already pausing', { status: 'running' as const, fresh: true, pauseRequested: true }, ['run-controls-cancel', 'run-controls-stop']],
    ['a paused run', { status: 'paused' as const, fresh: false, pauseRequested: false }, ['run-controls-resume']]
  ])('offers exactly the right controls for %s', (_label, over, expected) => {
    renderControls(over);
    for (const testid of expected) expect(screen.getByTestId(testid)).toBeInTheDocument();
    for (const other of ALL_CONTROLS.filter((t) => !expected.includes(t))) {
      expect(screen.queryByTestId(other)).toBeNull();
    }
  });

  it.each([
    ['a done run', { status: 'done' as const, fresh: false }],
    ['an aborted run', { status: 'aborted' as const, fresh: false }],
    ['a failed run', { status: 'failed' as const, fresh: false }]
  ])('renders nothing at all for %s', (_label, over) => {
    const { container } = render(<RunControls run={runFor(over)} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  /**
   * bug-39 moved the crashed-but-unannotated run OUT of the table above, and
   * the move is the fix rather than a concession to it. `status: 'running'`
   * with a dead heartbeat is exactly the run `POST /api/agents/stop` accepts
   * and exactly the run this bug was filed about — a driver killed by hand
   * leaves one for fifteen minutes. The RESUME is still withheld (the server
   * has not said what the sweeper intends, and an unknown reads as "it may
   * still act"), which is what the second assertion pins.
   */
  it('offers Stop, and only Stop, for a crashed run the server has not annotated yet', () => {
    renderControls({ status: 'running', fresh: false });
    expect(screen.getByTestId('run-controls-stop')).toBeInTheDocument();
    for (const other of ['run-controls-pause', 'run-controls-cancel', 'run-controls-resume']) {
      expect(screen.queryByTestId(other)).toBeNull();
    }
  });

  // The note names the item the run will finish before it stops — the one
  // fact a person watching a pause actually wants ("how long is this").
  it('names the in-flight item in the pausing note', () => {
    renderControls({ status: 'running', fresh: true, pauseRequested: true });
    expect(screen.getByTestId('run-controls-note')).toHaveTextContent('Pausing after task-14');
  });

  // No in-flight item: the run is between items, so the boundary is now.
  it('says "at the next boundary" when nothing is in flight', () => {
    renderControls({
      status: 'running',
      fresh: true,
      pauseRequested: true,
      queue: [
        { id: 'a-1', stage: 'merged' },
        { id: 'a-2', stage: 'pending' }
      ]
    });
    expect(screen.getByTestId('run-controls-note')).toHaveTextContent('Pausing at the next boundary');
  });

  it('renders no control for a paused run the environment ladder blocks', () => {
    const { container } = render(
      <RunControls run={runFor({ status: 'paused', fresh: false })} gate={{ canResume: false, blockedReason: null }} resuming={false} onChanged={jest.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  // The project-visibility block keeps its button, disabled with the reason —
  // the same disable-don't-hide rule DispatchButton follows, and for the same
  // reason: that is the one answer that can be silently stale.
  it('disables the Resume button, with the reason as its title, for a project-visibility block', async () => {
    const onChanged = renderControls(
      { status: 'paused', fresh: false },
      { gate: { canResume: true, blockedReason: 'the dashboard does not list /abs/alpha' } }
    );
    const button = screen.getByTestId('run-controls-resume');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('title', 'the dashboard does not list /abs/alpha');

    await userEvent.click(button);
    expect(agents.resumeOrchestrate).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('replaces the Resume button with a placeholder while a resume is in flight', () => {
    renderControls({ status: 'paused', fresh: false }, { resuming: true });
    expect(screen.getByTestId('run-controls-resuming')).toHaveTextContent('Resuming…');
    expect(screen.queryByTestId('run-controls-resume')).toBeNull();
  });
});

describe('RunControls — what the clicks do', () => {
  it('pauses, then reports the change', async () => {
    const onChanged = renderControls({ status: 'running', fresh: true, pauseRequested: false });
    await userEvent.click(screen.getByTestId('run-controls-pause'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('pause'));
    expect(agents.pauseOrchestrate).toHaveBeenCalledTimes(1);
    expect(agents.pauseOrchestrate).toHaveBeenCalledWith(fixture.project);
  });

  it('cancels a pending pause, then reports the change', async () => {
    const onChanged = renderControls({ status: 'running', fresh: true, pauseRequested: true });
    await userEvent.click(screen.getByTestId('run-controls-cancel'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('cancel'));
    expect(agents.cancelPauseOrchestrate).toHaveBeenCalledWith(fixture.project);
  });

  it('resumes a paused run, then reports the change', async () => {
    const onChanged = renderControls({ status: 'paused', fresh: false });
    await userEvent.click(screen.getByTestId('run-controls-resume'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('resume'));
    expect(agents.resumeOrchestrate).toHaveBeenCalledWith(fixture.project);
  });

  // The crashed strip's own rule, reused verbatim: a run that came back to
  // life under the click is the outcome the click wanted, not an error.
  it('treats a run-in-progress 409 on resume as success', async () => {
    agents.resumeOrchestrate.mockRejectedValueOnce(new ApiError('busy', 409, RUN_IN_PROGRESS_CODE));
    const onChanged = renderControls({ status: 'paused', fresh: false });

    await userEvent.click(screen.getByTestId('run-controls-resume'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('resume'));
    expect(screen.queryByTestId('run-controls-error')).toBeNull();
  });

  it('renders any other failure and reports no change', async () => {
    agents.pauseOrchestrate.mockRejectedValueOnce(new Error('boom'));
    const onChanged = renderControls({ status: 'running', fresh: true, pauseRequested: false });

    await userEvent.click(screen.getByTestId('run-controls-pause'));

    await waitFor(() => expect(screen.getByTestId('run-controls-error')).toHaveTextContent('boom'));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('inFlightItemId', () => {
  it('names the first item that is neither pending nor terminal', () => {
    expect(inFlightItemId(fixture.queue.map((q) => ({ id: q.id, stage: q.stage })))).toBe('task-14');
  });

  it('is null for an all-pending queue and for an all-terminal one', () => {
    expect(
      inFlightItemId([
        { id: 'a', stage: 'pending' },
        { id: 'b', stage: 'pending' }
      ])
    ).toBeNull();
    expect(
      inFlightItemId([
        { id: 'a', stage: 'merged' },
        { id: 'b', stage: 'branched' }
      ])
    ).toBeNull();
  });
});

/**
 * task-38's crashed branch — the half `watchdog-coupling.test.tsx` does not
 * own. That file drives the stand-down VERDICT from one table shared with the
 * sweeper; these are the two things about the branch that are not verdicts.
 */
describe('RunControls — the crashed run', () => {
  /** A crashed run (running, heartbeat gone) whose sweeper has stood down. */
  function crashedRun(over: Partial<RunControlsRun> = {}): RunControlsRun {
    return runFor({
      status: 'running',
      fresh: false,
      watchdog: {
        enabled: false,
        attempts: 0,
        maxAttempts: 2,
        lastSpawnAt: null,
        lastSessionId: null,
        lastError: null,
        exhausted: false
      },
      ...over
    });
  }

  it('offers Resume, and only Resume, once the sweeper has stood down', () => {
    render(<RunControls run={crashedRun()} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);
    expect(screen.getByTestId('run-controls-resume')).toBeInTheDocument();
    expect(screen.queryByTestId('run-controls-pause')).toBeNull();
    expect(screen.queryByTestId('run-controls-cancel')).toBeNull();
  });

  // The environment ladder applies to this branch exactly as it does to the
  // paused one — both halves of the gate must agree before any control is
  // drawn, and the environment half HIDES rather than disables.
  it('offers no Resume when the environment cannot spawn, however far the sweeper has stood down', () => {
    render(<RunControls run={crashedRun()} gate={{ canResume: false, blockedReason: null }} resuming={false} onChanged={jest.fn()} />);
    expect(screen.queryByTestId('run-controls-resume')).toBeNull();
  });

  /**
   * bug-39, and the inverse of the case above: the environment ladder governs
   * the RESUME and must not reach the Stop.
   *
   * `POST /api/agents/stop` is deliberately independent of `BM_AGENTS`, for
   * the reason `pause` is — a stop is a fact recorded on this machine's own
   * disk about a run that is already going, and gating it on the launcher
   * would mean a run started while agents were on could never be ended after
   * somebody turned them off, which is the exact moment a person most wants
   * to end one. Hiding the control here would reproduce bug-39 on any machine
   * with agents off.
   */
  it('still offers Stop when the environment cannot spawn — a stop is not a spawn', () => {
    render(<RunControls run={crashedRun()} gate={{ canResume: false, blockedReason: null }} resuming={false} onChanged={jest.fn()} />);
    expect(screen.getByTestId('run-controls-stop')).toBeInTheDocument();
  });

  /**
   * **bug-19's layer 1, applied to the branch task-38 added.** This is the
   * direct regression test: two rapid clicks must produce exactly ONE
   * `resumeOrchestrate` call.
   *
   * The call COUNT is the assertion, not the rendered state, and that
   * distinction is the whole point — the host's own `resuming` mark is set
   * from `onChanged`, i.e. after the request settles, so for the whole
   * in-flight window nothing above the guard has changed on screen. A case
   * that only checked what was rendered would pass against a branch with no
   * guard at all (occurrence 1 was three clicks inside ten seconds against a
   * control that looked identical after each one).
   *
   * The stub is held UNRESOLVED so the second click lands inside that window
   * rather than after it; resolving it first would test nothing.
   */
  it('fires exactly one resume for two clicks landing before the first re-render', async () => {
    let settle: () => void = () => {};
    agents.resumeOrchestrate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = () => resolve();
        })
    );
    const onChanged = jest.fn();
    render(<RunControls run={crashedRun()} gate={OPEN_GATE} resuming={false} onChanged={onChanged} />);

    doubleClick(screen.getByTestId('run-controls-resume'));

    expect(agents.resumeOrchestrate).toHaveBeenCalledTimes(1);

    settle();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('resume'));
    expect(agents.resumeOrchestrate).toHaveBeenCalledTimes(1);
  });

  /* The same guard, on the branch that already had it — asserted as a PAIR
     with the case above rather than on its own, because what regressed
     bug-19 the first time was a guard that covered some branches and not
     others, and a suite that checked each branch in isolation would not have
     caught it. */
  it('fires exactly one resume for two clicks on a paused run too', () => {
    agents.resumeOrchestrate.mockImplementation(() => new Promise<void>(() => {}));
    render(<RunControls run={runFor({ status: 'paused', fresh: false })} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);

    doubleClick(screen.getByTestId('run-controls-resume'));

    expect(agents.resumeOrchestrate).toHaveBeenCalledTimes(1);
  });

  /* The pause control is the third branch through the same `act`, and it is
     in this block rather than the one above because what it pins is the same
     one thing: the guard is `act`'s, so it covers whatever `act` dispatches.
     A branch added later that bypassed `act` would fail this row and no
     other. */
  it('fires exactly one pause for two clicks on a running run', () => {
    agents.pauseOrchestrate.mockImplementation(() => new Promise<void>(() => {}));
    render(<RunControls run={runFor({ status: 'running', fresh: true })} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);

    doubleClick(screen.getByTestId('run-controls-pause'));

    expect(agents.pauseOrchestrate).toHaveBeenCalledTimes(1);
  });
});

/**
 * bug-39 — the Stop control, and the readings a stopped run carries.
 *
 * The rendering rules are covered by the exact-control-set table at the top
 * of this file and by `test/watchdog-coupling.test.tsx`'s stop leg (no Resume
 * under a stop, whatever the sweeper's state). What is left here is the
 * BEHAVIOUR: which call each control makes, what the head says once a stop is
 * on file, and how the one fact no later poll can re-supply — a refused
 * `--abort` spawn — reaches the reader.
 */
describe('RunControls — the stop', () => {
  it('sends a stop for a fresh run and reports the change to its host', async () => {
    const onChanged = renderControls({ status: 'running', fresh: true });

    await userEvent.click(screen.getByTestId('run-controls-stop'));

    expect(agents.stopOrchestrate).toHaveBeenCalledWith(fixture.project);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('stop'));
  });

  /**
   * A crashed run is the case this bug was filed about, and the control has to
   * reach the same call from that branch — a Stop that only existed on a
   * heartbeating run would be absent from precisely the runs that cannot be
   * ended any other way.
   */
  it('sends a stop for a crashed run too', async () => {
    renderControls({ status: 'running', fresh: false });

    await userEvent.click(screen.getByTestId('run-controls-stop'));

    expect(agents.stopOrchestrate).toHaveBeenCalledWith(fixture.project);
  });

  it('says the run is being ended, and offers only the withdrawal', () => {
    renderControls({ status: 'running', fresh: true, stopRequested: true });

    expect(screen.getByTestId('run-controls-stop-note')).toHaveTextContent('Stopping');
    expect(screen.getByTestId('run-controls-cancel-stop')).toBeInTheDocument();
    // Not a second Stop, and not a Pause: the run is already ending, and a
    // pause would be asking a run that is stopping to stop more politely.
    expect(screen.queryByTestId('run-controls-stop')).toBeNull();
    expect(screen.queryByTestId('run-controls-pause')).toBeNull();
  });

  it('withdraws the request through the cancel call, not the pause one', async () => {
    const onChanged = renderControls({ status: 'running', fresh: true, stopRequested: true });

    await userEvent.click(screen.getByTestId('run-controls-cancel-stop'));

    expect(agents.cancelStopOrchestrate).toHaveBeenCalledWith(fixture.project);
    // The two control files are one file, but the two ROUTES are not
    // interchangeable: cancelling a stop through `pause`'s cancel would
    // 409 on a run this one accepts.
    expect(agents.cancelPauseOrchestrate).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('cancel-stop'));
  });

  /**
   * `abortRefused` is the one thing this component learns that no later poll
   * can tell it: a refusal starts nothing and writes nothing, so there is
   * nothing on disk for the runs payload to report. It is rendered from the
   * click's own answer, beside the withdrawal, and it names the command a
   * person can run instead.
   */
  it('renders the refusal sentence the stop click came back with', async () => {
    agents.stopOrchestrate.mockResolvedValueOnce({
      stopRequested: true,
      abortSession: null,
      abortRefused: 'agents are off on this machine — run `/backlog-orchestrate --abort` at the project root to end the run'
    });
    const { rerender } = render(
      <RunControls run={runFor({ status: 'running', fresh: true })} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />
    );

    await userEvent.click(screen.getByTestId('run-controls-stop'));
    // The host's next poll turns the run into a stop-requested one, which is
    // the state the refusal is drawn in — the same component instance, so the
    // note it learned from the click survives the re-render.
    rerender(<RunControls run={runFor({ status: 'running', fresh: true, stopRequested: true })} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('run-controls-abort-refused')).toHaveTextContent('--abort'));
  });

  /* bug-19's layer 1 again, over the branch bug-39 added: the guard is
     `act`'s, so a branch that dispatched around it would fail this row and no
     other. Two POSTs would be two `--abort` spawns into one run. */
  it('fires exactly one stop for two clicks', () => {
    agents.stopOrchestrate.mockImplementation(() => new Promise<void>(() => {}));
    render(<RunControls run={runFor({ status: 'running', fresh: true })} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);

    doubleClick(screen.getByTestId('run-controls-stop'));

    expect(agents.stopOrchestrate).toHaveBeenCalledTimes(1);
  });
});
