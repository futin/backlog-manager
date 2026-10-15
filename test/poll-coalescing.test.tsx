/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useAgents } from '../client/src/hooks/useAgents';
import { BOARD_TRACKER_POLL_MS, useBoard } from '../client/src/hooks/useBoard';
import { POLL_MS, useOrchestratorRuns } from '../client/src/hooks/useOrchestratorRuns';
import { useWatchdog, WATCHDOG_POLL_MS } from '../client/src/hooks/useWatchdog';
import rawFixture from './fixtures/orchestrator-run.json';
import { DEFAULT_WATCHDOG_CONFIG } from '../shared/types';
import type { AgentsStatus, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary, WatchdogPhase, WatchdogStatus } from '../shared/types';

/**
 * #277 — the board's pollers never have two of their own requests in flight, and a focus / mount / refresh that lands mid-flight coalesces into exactly ONE
 * follow-up. One subject per hook, one generic suite over all of them, because the contract is the same four sentences for each:
 *
 *   7.  A slow answer slows the poll; it does not stack requests behind it (and the next tick is `period` AFTER the answer, not on the wall clock).
 *   8.  Focus during a flight starts nothing; the settle runs one follow-up at once; the timer re-arms from that follow-up.
 *   9.  The arming condition each hook already had still decides whether a timer exists, including when it flips mid-flight.
 *   10. Unmount mid-flight: no state update, no follow-up, no further request however long the clock runs.
 *
 * Every request is a promise the test settles by hand, so "in flight" is a state the test holds rather than a race it hopes to win. Nothing here depends
 * on a date: `fresh` and `phase` arrive in the stubbed bodies, so there is no fixture clock to keep relative to anything.
 */

type Kind = 'live' | 'quiet';

interface Subject {
  name: string;
  /** null: no clock at all (`useAgents`) — mount and focus only. */
  periodMs: number | null;
  /** How many `fetch` calls one request makes (`useBoard` reads `items` and `projects` as a pair). */
  perRequest: number;
  mount: () => { unmount: () => void };
  /** The body a URL answers: `live` is the world where the hook's arming condition holds, `quiet` the one where it does not. */
  body: (url: string, kind: Kind) => unknown;
}

const run = rawFixture as OrchestratorRun;

function runsPayload(kind: Kind): OrchestratorRunsPayload {
  const live = kind === 'live';
  const entry = { ...run, status: live ? ('running' as const) : ('done' as const), fresh: live, pastRuns: 0, pauseRequested: false, stopRequested: false };
  return { runs: [entry], starting: [], remote: [] };
}

function projects(kind: Kind): ProjectSummary[] {
  return [
    {
      name: 'tracker',
      path: '/abs/tracker',
      createdAt: '2026-08-26T00:00:00.000Z',
      missing: false,
      counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
      source: 'github',
      repo: 'futin/x',
      polledAt: new Date().toISOString(),
      access: 'ok',
      detail: null,
      // `off` is a tracker that no longer syncs: `hasSyncingTracker` is false for it, so the board stops polling.
      interval: kind === 'live' ? null : 'off'
    }
  ];
}

function watchdog(phase: WatchdogPhase): WatchdogStatus {
  return { phase, nextTickAt: null, config: DEFAULT_WATCHDOG_CONFIG, watching: [], events: [] };
}

const AGENTS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: []
};

const SUBJECTS: Subject[] = [
  {
    name: 'useOrchestratorRuns',
    periodMs: POLL_MS,
    perRequest: 1,
    mount: () => renderHook(() => useOrchestratorRuns()),
    body: (_url, kind) => runsPayload(kind)
  },
  {
    name: 'useBoard',
    periodMs: BOARD_TRACKER_POLL_MS,
    perRequest: 2,
    mount: () => renderHook(() => useBoard()),
    body: (url, kind) => (url === '/api/projects' ? projects(kind) : { items: [], errors: [] })
  },
  {
    name: 'useWatchdog',
    periodMs: WATCHDOG_POLL_MS,
    perRequest: 1,
    mount: () => renderHook(() => useWatchdog()),
    body: (_url, kind) => watchdog(kind === 'live' ? 'armed' : 'idle')
  },
  {
    name: 'useAgents',
    periodMs: null,
    perRequest: 1,
    mount: () => renderHook(() => useAgents()),
    body: () => AGENTS
  }
];
const POLLERS = SUBJECTS.filter((s) => s.periodMs !== null);

/** A `fetch` whose every call hangs until the test answers it. `answer` settles everything outstanding with the subject's body for `kind`. */
function controlledFetch(subject: Subject): { fn: jest.Mock; answer: (kind: Kind) => Promise<void> } {
  const outstanding: { url: string; settle: (body: unknown) => void }[] = [];
  const fn = jest.fn(
    (url: string) =>
      new Promise<Response>((resolve) => {
        outstanding.push({ url, settle: (body) => resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response) });
      })
  );
  global.fetch = fn as unknown as typeof fetch;
  return {
    fn,
    async answer(kind) {
      const batch = outstanding.splice(0);
      for (const call of batch) call.settle(subject.body(call.url, kind));
      await flush();
    }
  };
}

/** Lets every settled fetch's `.then` chain run and its setState commit, with no fake time passing. */
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function focus(times = 1): void {
  for (let i = 0; i < times; i += 1) {
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
  }
}

const realFetch = global.fetch;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Every case below must leave React quiet: an act() or unmounted-update warning is the failure this suite exists to catch.
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
  jest.useRealTimers();
  global.fetch = realFetch;
});

describe.each(POLLERS)('$name — no overlap on a slow answer (#277 case 7)', (subject) => {
  const period = subject.periodMs as number;

  it('asks once while its first request never resolves, however far the clock runs', async () => {
    const f = controlledFetch(subject);
    subject.mount();
    await advance(3 * period);

    expect(f.fn).toHaveBeenCalledTimes(subject.perRequest);
  });

  it('asks once while a tick never resolves; the next tick is a whole period after the answer, not an instant after', async () => {
    const f = controlledFetch(subject);
    subject.mount();
    await f.answer('live');
    expect(f.fn).toHaveBeenCalledTimes(subject.perRequest);

    await advance(period);
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);

    // The tick hangs. On a wall-clock interval this is where three more requests would pile up.
    await advance(3 * period);
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);

    await f.answer('live');
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
    await advance(period - 1);
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
    await advance(1);
    expect(f.fn).toHaveBeenCalledTimes(3 * subject.perRequest);
  });
});

describe.each(SUBJECTS)('$name — focus coalesces (#277 case 8)', (subject) => {
  it('starts nothing for three focuses mid-flight, then exactly one follow-up the moment the flight settles', async () => {
    const f = controlledFetch(subject);
    subject.mount();
    focus(3);
    expect(f.fn).toHaveBeenCalledTimes(subject.perRequest);

    await f.answer('live');
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);

    // The follow-up is itself a flight: a further focus folds into the NEXT one rather than racing it, and nothing else starts while it hangs.
    await advance(3 * (subject.periodMs ?? 5_000));
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);

    await f.answer('live');
    // One follow-up only — and, for a poller, the timer re-arms from THIS answer.
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
    if (subject.periodMs === null) {
      await advance(10 * 60_000);
      expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
    } else {
      await advance(subject.periodMs - 1);
      expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
      await advance(1);
      expect(f.fn).toHaveBeenCalledTimes(3 * subject.perRequest);
    }
  });

  it('a focus with nothing in flight starts a request at once', async () => {
    const f = controlledFetch(subject);
    subject.mount();
    await f.answer('quiet');
    expect(f.fn).toHaveBeenCalledTimes(subject.perRequest);

    focus();
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
  });
});

describe('useOrchestratorRuns — the resume-click refresh coalesces too (#277 case 8)', () => {
  it('a noteResume during a flight starts nothing, and one follow-up runs when it settles', async () => {
    const subject = SUBJECTS[0];
    const f = controlledFetch(subject);
    const { result } = renderHook(() => useOrchestratorRuns());
    await f.answer('quiet');
    expect(f.fn).toHaveBeenCalledTimes(1);

    // A request is out (the focus), and the click's own refresh — plus a second one from the mark's caller — must fold into one follow-up behind it.
    focus();
    expect(f.fn).toHaveBeenCalledTimes(2);
    act(() => result.current.noteResume('some-project'));
    act(() => result.current.refresh());
    expect(f.fn).toHaveBeenCalledTimes(2);

    await f.answer('quiet');
    expect(f.fn).toHaveBeenCalledTimes(3);
  });
});

describe.each(POLLERS)('$name — arming conditions hold (#277 case 9)', (subject) => {
  const period = subject.periodMs as number;

  it('arms no timer when the answer says there is nothing to watch', async () => {
    const f = controlledFetch(subject);
    subject.mount();
    await f.answer('quiet');
    await advance(10 * period);

    expect(f.fn).toHaveBeenCalledTimes(subject.perRequest);
  });

  it('a tick in flight when the condition flips false settles, updates state, and re-arms nothing', async () => {
    const f = controlledFetch(subject);
    subject.mount();
    await f.answer('live');
    await advance(period);
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);

    await f.answer('quiet');
    await advance(10 * period);
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
  });

  it('clears the pending timer when the condition flips false while it is waiting', async () => {
    const f = controlledFetch(subject);
    subject.mount();
    await f.answer('live');
    await advance(period - 1);
    // A focus is the one thing that can change the answer while a timer waits; it starts a request at once and drops the old timer.
    focus();
    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
    await f.answer('quiet');
    await advance(10 * period);

    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
  });
});

describe('useWatchdog — live:false skips the clock and nothing else (#277 case 9)', () => {
  it('does not tick for an armed sweeper, but still refetches on focus', async () => {
    const subject = SUBJECTS[2];
    const f = controlledFetch(subject);
    renderHook(() => useWatchdog({ live: false }));
    await f.answer('live');
    await advance(10 * WATCHDOG_POLL_MS);
    expect(f.fn).toHaveBeenCalledTimes(1);

    focus();
    expect(f.fn).toHaveBeenCalledTimes(2);
  });
});

describe('useBoard — no syncing tracker means no tick (#277 case 9)', () => {
  it('a board of files projects only never polls', async () => {
    const subject: Subject = {
      ...SUBJECTS[1],
      body: (url) => {
        const files: ProjectSummary = { ...projects('live')[0], source: 'files', repo: null, polledAt: null, access: null, interval: null };
        return url === '/api/projects' ? [files] : { items: [], errors: [] };
      }
    };
    const f = controlledFetch(subject);
    subject.mount();
    await f.answer('live');
    await advance(10 * BOARD_TRACKER_POLL_MS);

    expect(f.fn).toHaveBeenCalledTimes(2);
  });
});

describe.each(SUBJECTS)('$name — unmount (#277 case 10)', (subject) => {
  const horizon = 10 * (subject.periodMs ?? 60_000);

  it('unmounted mid-flight: the answer sets no state and nothing else is ever asked', async () => {
    const f = controlledFetch(subject);
    const { unmount } = subject.mount();
    unmount();
    await f.answer('live');
    await advance(horizon);

    expect(f.fn).toHaveBeenCalledTimes(subject.perRequest);
  });

  it('unmounted with a follow-up queued: the follow-up is dropped and no timer is armed', async () => {
    const f = controlledFetch(subject);
    const { unmount } = subject.mount();
    await f.answer('live');
    if (subject.periodMs !== null) {
      await advance(subject.periodMs);
      expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
    } else {
      focus();
      expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
    }
    focus(2);
    unmount();
    await f.answer('live');
    await advance(horizon);

    expect(f.fn).toHaveBeenCalledTimes(2 * subject.perRequest);
  });
});
