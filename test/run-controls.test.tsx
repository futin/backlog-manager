/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ApiError } from '../client/src/lib/agents';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import { RunControls, inFlightItemId } from '../client/src/components/RunControls';
import type { RunControlsRun } from '../client/src/components/RunControls';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

const fixture = rawFixture as OrchestratorRun;

/** The three calls this component can make, all stubbed — every case here is
 *  about what the component decides, never about what the API answers. */
jest.mock('../client/src/lib/agents', () => {
  const actual = jest.requireActual('../client/src/lib/agents');
  return {
    ...actual,
    pauseOrchestrate: jest.fn(() => Promise.resolve({ pauseRequested: true })),
    cancelPauseOrchestrate: jest.fn(() => Promise.resolve({ pauseRequested: false })),
    resumeOrchestrate: jest.fn(() => Promise.resolve({ sessionId: 'sess-1' }))
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const agents = jest.requireMock('../client/src/lib/agents') as {
  pauseOrchestrate: jest.Mock;
  cancelPauseOrchestrate: jest.Mock;
  resumeOrchestrate: jest.Mock;
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
    queue: fixture.queue.map((q) => ({ id: q.id, stage: q.stage })),
    ...over
  };
}

function renderControls(
  over: Partial<RunControlsRun> = {},
  props: Partial<{
    gate: { canResume: boolean; blockedReason: string | null };
    resuming: boolean;
    onChanged: (kind: 'pause' | 'cancel' | 'resume') => void;
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
  it.each([
    ['a fresh running run', { status: 'running' as const, fresh: true, pauseRequested: false }, 'run-controls-pause'],
    ['a fresh running run already pausing', { status: 'running' as const, fresh: true, pauseRequested: true }, 'run-controls-cancel'],
    ['a paused run', { status: 'paused' as const, fresh: false, pauseRequested: false }, 'run-controls-resume']
  ])('offers the right single control for %s', (_label, over, testid) => {
    renderControls(over);
    expect(screen.getByTestId(testid)).toBeInTheDocument();
    for (const other of ['run-controls-pause', 'run-controls-cancel', 'run-controls-resume'].filter((t) => t !== testid)) {
      expect(screen.queryByTestId(other)).toBeNull();
    }
  });

  it.each([
    ['a crashed run the server has not annotated yet', { status: 'running' as const, fresh: false }],
    ['a done run', { status: 'done' as const, fresh: false }],
    ['an aborted run', { status: 'aborted' as const, fresh: false }],
    ['a failed run', { status: 'failed' as const, fresh: false }]
  ])('renders nothing at all for %s', (_label, over) => {
    const { container } = render(<RunControls run={runFor(over)} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);
    expect(container.firstChild).toBeNull();
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
  it('renders nothing when the environment cannot spawn, however far the sweeper has stood down', () => {
    const { container } = render(<RunControls run={crashedRun()} gate={{ canResume: false, blockedReason: null }} resuming={false} onChanged={jest.fn()} />);
    expect(container.firstChild).toBeNull();
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
