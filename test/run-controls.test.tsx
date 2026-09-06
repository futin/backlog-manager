/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
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

function renderControls(over: Partial<RunControlsRun> = {}, props: Partial<{
  gate: { canResume: boolean; blockedReason: string | null };
  resuming: boolean;
  onChanged: (kind: 'pause' | 'cancel' | 'resume') => void;
}> = {}) {
  const onChanged = props.onChanged ?? jest.fn();
  render(
    <RunControls
      run={runFor(over)}
      gate={props.gate ?? OPEN_GATE}
      resuming={props.resuming ?? false}
      onChanged={onChanged}
    />
  );
  return onChanged;
}

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * One component, two hosts (the board's run drawer and the Runs view's
 * detail pane), and every decision made from the run entry alone — that is
 * what these cases pin. A second copy of this table living in each host is
 * exactly the drift `watchdogStoodDown`'s own history records, and the two
 * hosts here are in different lazy chunks, so a shared component at the top
 * level is the only shape that keeps them agreeing.
 *
 * The crashed run is deliberately NOT this component's business: a crashed
 * run's Resume lives on the strip, behind `watchdogStoodDown`, because the
 * watchdog may be about to spawn one itself. A paused run was never a
 * watchdog subject, so it has no such coordination to do.
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
    ['a crashed run — the strip owns that Resume', { status: 'running' as const, fresh: false }],
    ['a done run', { status: 'done' as const, fresh: false }],
    ['an aborted run', { status: 'aborted' as const, fresh: false }],
    ['a failed run', { status: 'failed' as const, fresh: false }]
  ])('renders nothing at all for %s', (_label, over) => {
    const { container } = render(
      <RunControls run={runFor(over)} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />
    );
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
      queue: [{ id: 'a-1', stage: 'merged' }, { id: 'a-2', stage: 'pending' }]
    });
    expect(screen.getByTestId('run-controls-note')).toHaveTextContent('Pausing at the next boundary');
  });

  it('renders no control for a paused run the environment ladder blocks', () => {
    const { container } = render(
      <RunControls
        run={runFor({ status: 'paused', fresh: false })}
        gate={{ canResume: false, blockedReason: null }}
        resuming={false}
        onChanged={jest.fn()}
      />
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
    expect(inFlightItemId([{ id: 'a', stage: 'pending' }, { id: 'b', stage: 'pending' }])).toBeNull();
    expect(inFlightItemId([{ id: 'a', stage: 'merged' }, { id: 'b', stage: 'branched' }])).toBeNull();
  });
});
