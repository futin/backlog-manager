/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { WatchdogMonitor } from '../client/src/components/runs/WatchdogMonitor';
import { projectLabel } from '../client/src/lib/project-label';
import { formatClock, formatSpanCompact } from '../client/src/lib/run-time';
import { watchdogClause } from '../client/src/lib/run-watchdog';
import { DEFAULT_WATCHDOG_CONFIG, WATCHDOG_EVENT_CAP } from '../shared/types';
import type {
  OrchestratorRunsPayload, RunQueueItem, RunStage, RunWatchdog, WatchdogEvent, WatchdogStatus
} from '../shared/types';

/**
 * `WatchdogMonitor` (task-18, spec §3) driven standalone on its own two
 * props, with only `GET /api/agents/watchdog` stubbed — the component owns
 * `useWatchdog` and takes the live runs array from `RunsView` rather than
 * fetching it, so a case that hits any OTHER url is a bug in the component,
 * not in the fixture. The stub asserts that directly by rejecting anything
 * else.
 *
 * The clock is pinned with fake timers for every case, not just the two that
 * advance it: the heartbeat ages below are computed against `useNow`'s
 * reading of the real `Date.now()`, so an unpinned clock would make `4s`
 * flake to `5s` on a slow machine.
 */

const NOW = Date.parse('2026-09-05T12:00:00.000Z');

function watchdogStatus(over: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return {
    phase: 'idle',
    nextTickAt: null,
    config: DEFAULT_WATCHDOG_CONFIG,
    watching: [],
    events: [],
    ...over
  };
}

/** Inert but full — the monitor reads `id` and `stage` and nothing else. */
function queueItem(id: string, stage: RunStage): RunQueueItem {
  return {
    id,
    title: `${id} title`,
    stage,
    sessionId: null,
    worktree: null,
    branch: null,
    permissionMode: null,
    fixLoops: 0,
    stageAt: {},
    verification: [],
    questions: [],
    note: null
  };
}

type LiveRun = OrchestratorRunsPayload['runs'][number];

function liveRun(over: Partial<LiveRun> = {}): LiveRun {
  return {
    runId: 'run-1',
    project: '/abs/alpha',
    status: 'running',
    startedAt: new Date(NOW - 600_000).toISOString(),
    updatedAt: new Date(NOW - 4_000).toISOString(),
    maxItems: null,
    mergeMode: 'merge',
    mergeModeEffective: 'merge',
    mergeModeNote: null,
    queue: [],
    attention: [],
    fresh: true,
    pastRuns: 0,
    pauseRequested: false,
    ...over
  };
}

const realFetch = global.fetch;

function stubFetch(watchdog: WatchdogStatus | 'reject'): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/agents/watchdog')) {
      if (watchdog === 'reject') return Promise.reject(new Error('watchdog unreachable'));
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve(watchdog)
      } as unknown as Response);
    }
    return Promise.reject(new Error(`watchdog-monitor.test.tsx: unexpected fetch ${url}`));
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Settles the mount fetch's microtask chain under fake timers without
 *  advancing any fake time — the same idiom test/watchdog-hook.test.tsx uses. */
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

async function renderMonitor(
  watchdog: WatchdogStatus | 'reject',
  runs: LiveRun[] = [],
  onSelectRun: (project: string, runId: string) => void = jest.fn()
): Promise<jest.Mock> {
  const fetchMock = stubFetch(watchdog);
  render(<WatchdogMonitor runs={runs} onSelectRun={onSelectRun} />);
  await flush();
  return fetchMock;
}

describe('WatchdogMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  // --- 1: the GET rejects — the notice alone, nothing that looks like data --

  it('renders only the unavailable notice when the watchdog cannot be reached', async () => {
    await renderMonitor('reject');

    expect(screen.getByText(/Could not reach the watchdog — watchdog unreachable/))
      .toBeInTheDocument();
    // A monitor whose whole job is to report on the watchdog must not fall
    // back to a default that looks like a reading — no state line, no rows,
    // no feed.
    expect(screen.queryByTestId('watchdog-state-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-rows')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-events')).not.toBeInTheDocument();
  });

  // --- 2: off — the state line and the config line, and no rows section -----

  it('names the off reason and prints the config, with no rows section at all', async () => {
    await renderMonitor(watchdogStatus({ phase: 'off', reason: 'BM_AGENTS off' }), []);

    expect(screen.getByTestId('watchdog-state-line')).toHaveTextContent('off — BM_AGENTS off');

    // Computed from the same formatter the component uses, never re-typed:
    // a test that hard-codes "1m" would go green against a component that
    // stopped using `formatSpanCompact` at all.
    const { tickMs, graceMs, maxAttempts } = DEFAULT_WATCHDOG_CONFIG;
    expect(screen.getByTestId('watchdog-config-line')).toHaveTextContent(
      `check every ${formatSpanCompact(tickMs)} · leave alone for ${formatSpanCompact(graceMs)} · give up after ${maxAttempts}`
    );
    expect(screen.getByText('Configure in Settings › Orchestrator watchdog.')).toBeInTheDocument();

    // Nothing is being watched and the state line has already said why —
    // an empty-rows line here would be a second answer to a settled question.
    expect(screen.queryByTestId('watchdog-rows')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-rows-empty')).not.toBeInTheDocument();
    // The feed is not part of that argument: it is history, and it renders.
    expect(screen.getByText('nothing since the server started')).toBeInTheDocument();
  });

  // --- 3/4: the two empty states, which say different things ----------------

  it('reads "no running run" when idle with nothing in the payload', async () => {
    await renderMonitor(watchdogStatus({ phase: 'idle' }), []);
    expect(screen.getByTestId('watchdog-rows-empty')).toHaveTextContent('no running run');
  });

  it('reads the one-tick-skew line when armed with nothing in the payload', async () => {
    await renderMonitor(watchdogStatus({ phase: 'armed', watching: [] }), []);
    expect(screen.getByTestId('watchdog-rows-empty'))
      .toHaveTextContent('nothing running in the runs payload yet');
  });

  // --- 5: one fresh, watched run -------------------------------------------

  it('renders a fresh watched run with its project tail, item, heartbeat and ok verdict', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'dispatched'), queueItem('task-13', 'pending')] })]
    );

    const rows = screen.getAllByTestId('watchdog-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('alpha');
    expect(rows[0]).toHaveTextContent('run-1');
    expect(rows[0]).toHaveTextContent('bug-16 · dispatched');
    expect(rows[0]).toHaveTextContent('heartbeat 4s ago');
    expect(rows[0]).toHaveTextContent('ok');
    expect(rows[0]).not.toHaveTextContent('not yet watched');
    expect(rows[0]).toHaveClass('watchdog-row-ok');
  });

  // --- 6: nothing in flight -------------------------------------------------

  it('reads "between items" when every queue entry has exited or not started', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'merged'), queueItem('task-13', 'pending')] })]
    );

    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('between items');
  });

  // --- 7: crashed, annotated ------------------------------------------------

  it('prints the strip\'s own watchdog clause for a crashed run', async () => {
    const annotation: RunWatchdog = {
      enabled: true,
      attempts: 1,
      maxAttempts: 2,
      lastSpawnAt: '2026-09-05T11:58:00.000Z',
      lastSessionId: 's1',
      lastError: null,
      exhausted: false
    };
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ fresh: false, updatedAt: new Date(NOW - 130_000).toISOString(), watchdog: annotation })]
    );

    const row = screen.getByTestId('watchdog-row');
    expect(row).toHaveClass('watchdog-row-crashed');
    expect(row).toHaveTextContent('heartbeat 2m ago');
    // Asserted by CALLING `watchdogClause`, never by re-typing its sentence:
    // the whole reason the monitor reads that function is that the strip and
    // this surface must not be able to disagree, and a hand-copied string
    // here would let them.
    expect(row).toHaveTextContent(`crashed · ${watchdogClause(annotation, NOW)}`);
  });

  // --- 8: crashed, not yet annotated ---------------------------------------

  it('reads a bare "crashed" for a run the server has not annotated yet', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ fresh: false, updatedAt: new Date(NOW - 130_000).toISOString() })]
    );

    // Exactly `crashed`, with no dangling separator behind it — the empty
    // clause `watchdogClause(undefined)` returns must not print as `crashed ·`.
    expect(screen.getByTestId('watchdog-verdict')).toHaveTextContent(/^crashed$/);
  });

  // --- 9: the two payloads disagree, running side --------------------------

  it('marks a running run the sweeper has not picked up yet', async () => {
    await renderMonitor(watchdogStatus({ phase: 'armed', watching: [] }), [liveRun()]);
    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('· not yet watched');
  });

  // --- 10: the two payloads disagree, watching side ------------------------

  it('renders a non-clickable placeholder for a watched id with no run behind it', async () => {
    await renderMonitor(watchdogStatus({ phase: 'armed', watching: ['run-9'] }), []);

    const missing = screen.getByTestId('watchdog-row-missing');
    expect(missing).toHaveTextContent('run-9 — not in the runs payload');
    // There is no run to select, so it must not look like something to click.
    expect(missing.tagName).not.toBe('BUTTON');
    // The disagreement IS the content — an empty-rows line beside it would
    // claim there is nothing to show.
    expect(screen.queryByTestId('watchdog-rows-empty')).not.toBeInTheDocument();
  });

  // --- 11: two projects, one runId -----------------------------------------

  it('renders one row per project when two runs share a runId', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ project: '/abs/alpha' }), liveRun({ project: '/abs/beta' })]
    );

    const rows = screen.getAllByTestId('watchdog-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('alpha');
    expect(rows[1]).toHaveTextContent('beta');
    // A join on the bare `runId` would have to either drop one of these or
    // annotate only one of them; `watching` annotates both because both are
    // `running`.
    rows.forEach((row) => expect(row).not.toHaveTextContent('not yet watched'));
  });

  // --- 12: only running runs are rows --------------------------------------

  it('ignores a finished run in the payload', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'idle' }),
      [liveRun({ status: 'done', fresh: false })]
    );
    expect(screen.queryAllByTestId('watchdog-row')).toHaveLength(0);
  });

  // --- 13: the click-through -----------------------------------------------

  it('calls onSelectRun with the row\'s own project and runId', async () => {
    const onSelectRun = jest.fn();
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'dispatched')] })],
      onSelectRun
    );

    // `userEvent` installs its own timer plumbing; under fake timers it has
    // to be told, or its internal delay never resolves.
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(screen.getByTestId('watchdog-row'));

    expect(onSelectRun).toHaveBeenCalledTimes(1);
    expect(onSelectRun).toHaveBeenCalledWith('/abs/alpha', 'run-1');
  });

  // --- 14: the activity feed, moved from Settings --------------------------

  it('renders every event newest-first with its clock, project tail and detail', async () => {
    const events: WatchdogEvent[] = [
      { at: '2026-09-05T09:59:00Z', project: '/abs/alpha', runId: 'run-a', kind: 'spawned', detail: 'resumed run-a (attempt 1/2)' },
      { at: '2026-09-05T09:30:00Z', project: '/abs/beta', runId: null, kind: 'idle', detail: 'no running run — standing down' },
      { at: '2026-09-05T09:00:00Z', project: null, runId: null, kind: 'armed', detail: 'watching for crashed runs' }
    ];
    await renderMonitor(watchdogStatus({ events }), []);

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveTextContent(formatClock(events[0].at) ?? '');
    expect(rows[0]).toHaveTextContent(projectLabel('/abs/alpha'));
    expect(rows[0]).toHaveTextContent(events[0].detail);

    expect(rows[1]).toHaveTextContent(formatClock(events[1].at) ?? '');
    expect(rows[1]).toHaveTextContent(projectLabel('/abs/beta'));
    expect(rows[1]).toHaveTextContent(events[1].detail);

    // A project-less event (the sweeper arming, which is not about any one
    // project) renders no project span rather than an empty one.
    expect(rows[2]).toHaveTextContent(events[2].detail);
    expect(rows[2].querySelector('.watchdog-event-project')).toBeNull();
  });

  // --- 15: empty feed, and the two facts its hint has to carry --------------

  it('says the feed is empty and names the cap it is bounded by', async () => {
    await renderMonitor(watchdogStatus({ events: [] }), []);

    expect(screen.getByText('nothing since the server started')).toBeInTheDocument();
    // The events are the server's own memory: capped, and lost on restart.
    // A reader who does not know both will misread a short list as a quiet
    // watchdog.
    expect(screen.getByTestId('watchdog-events-hint'))
      .toHaveTextContent(String(WATCHDOG_EVENT_CAP));
    expect(screen.getByTestId('watchdog-events-hint')).toHaveTextContent(/restart/i);
  });

  // --- 16: the heartbeat is a clock, not a screenshot -----------------------

  it('ages the heartbeat on its own, with no new payload', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'dispatched')] })]
    );
    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('heartbeat 4s ago');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    // The fetch stub keeps answering the identical payload, so `updatedAt`
    // has not moved — `useNow` alone is what advanced this.
    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('heartbeat 9s ago');
  });
});
