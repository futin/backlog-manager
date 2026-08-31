/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useOrchestratorRuns } from '../client/src/hooks/useOrchestratorRuns';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, OrchestratorRunsPayload } from '../shared/types';

// Same translation orchestrator-shapes.test.ts (Task 8) and
// orchestrator-runs.test.ts already use: the fixture is plain JSON, so TS
// would otherwise widen its string fields to `string` instead of the
// narrower literal unions (`RunStage`, etc). rawFixture is a bare
// OrchestratorRun; every case below wraps it in the endpoint's own payload
// shape (Task 8: `{ runs: Array<OrchestratorRun & { fresh; pastRuns }> }`).
const fixture = rawFixture as OrchestratorRun;

/**
 * The endpoint's exact answer shape for one project's run, `fresh` toggled
 * per case. `pastRuns` is irrelevant to every case here (the hook never
 * reads it), so it is pinned at 0 rather than threaded through as a
 * parameter nobody would vary.
 */
function payload(fresh: boolean): OrchestratorRunsPayload {
  return { runs: [{ ...fixture, fresh, pastRuns: 0 }] };
}

/** Same shape as test/agents-client.test.ts's own `stub`: every call answers
 *  the same body, since no case here needs the response to change between
 *  polls — only the CALL COUNT is ever under test. */
function stubFetch(body: OrchestratorRunsPayload): jest.Mock {
  const fn = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// Captured once and restored after every case, the same hazard
// test/agents-client.test.ts and test/dispatch-button.test.tsx already guard
// against: a mock left on global.fetch is inherited by whatever runs next in
// this worker.
const realFetch = global.fetch;

// Flushes a promise chain hanging off a mocked (synchronously-resolving)
// fetch. jest's *Async timer helpers reach the fake clock's next tick via a
// REAL setTimeout(0) under the hood (see @sinonjs/fake-timers'
// tickAsync) — and a real setTimeout callback never runs until the
// microtask queue (where our fetch().then(...) chain lives) is fully
// drained, so `advanceTimersByTimeAsync(0)` reliably settles a pending fetch
// with no fake time actually elapsing. Wrapped in `act` because the
// resulting setState has to be flushed before any assertion reads
// `result.current`.
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('useOrchestratorRuns', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  // --- Test case 1: mount fetch lands in state ------------------------------

  it('fetches once on mount and lands the payload in state', async () => {
    const fetchMock = stubFetch(payload(true));
    const { result } = renderHook(() => useOrchestratorRuns());

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/orchestrator/runs');
    expect(result.current.runs).toEqual(payload(true).runs);
  });

  // --- Test case 2: a fresh run polls every 5s ------------------------------

  it('polls again 5s after landing a fresh run, and again 5s after that', async () => {
    const fetchMock = stubFetch(payload(true));
    renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Not a one-shot timeout: the interval must still be armed after firing
    // once, since a run in progress keeps needing a live queue for more than
    // one tick.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // --- Test case 3: an all-stale payload never polls ------------------------

  it('never polls when every known run is stale', async () => {
    const fetchMock = stubFetch(payload(false));
    renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // --- Test case 4: window focus refetches in both worlds -------------------

  it.each([
    ['a fresh', true],
    ['a stale', false]
  ])('refetches on window focus in %s world', async (_label, fresh) => {
    const fetchMock = stubFetch(payload(fresh));
    renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // --- Test case 5: unmount leaves nothing running --------------------------

  it('leaves no interval and no focus listener behind on unmount', async () => {
    const fetchMock = stubFetch(payload(true));
    const { unmount } = renderHook(() => useOrchestratorRuns());
    await flush();
    // One live interval — proof the fresh-world poll actually armed, so the
    // count going to zero below is unmount clearing something real rather
    // than an interval that was never installed to begin with.
    expect(jest.getTimerCount()).toBe(1);

    act(() => {
      unmount();
    });
    expect(jest.getTimerCount()).toBe(0);

    // The listener side of the same claim: fire the exact event the case
    // above proved triggers a refetch, and show it no longer does — and
    // advance well past a poll interval too, proving neither survived.
    const callsAtUnmount = fetchMock.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(callsAtUnmount);
  });

  // --- refresh() is callable directly, not just wired to the two effects ----

  it('exposes a refresh() a caller can invoke on demand', async () => {
    const fetchMock = stubFetch(payload(false));
    const { result } = renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
