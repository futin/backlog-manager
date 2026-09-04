/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useWatchdog, WATCHDOG_POLL_MS } from '../client/src/hooks/useWatchdog';
import { DEFAULT_WATCHDOG_CONFIG } from '../shared/types';
import type { WatchdogPhase, WatchdogStatus } from '../shared/types';

/**
 * `useWatchdog` (design §6.4) — Task 5's client hook, tested the same way
 * `test/orchestrator-hook.test.tsx` tests `useOrchestratorRuns`: jsdom,
 * fake timers, and a local `stubFetch` rather than anything shared, matching
 * this repo's per-suite-owns-its-stub convention.
 *
 * RULING R1: this suite lives in its own file rather than a second
 * `describe` inside `test/watchdog-routes.test.ts` — that suite is node
 * environment (it drives a real Nest app over HTTP), this one needs jsdom
 * (`renderHook`, `window` events), and jest's `testEnvironment` is set per
 * FILE via the docblock above, not per `describe` block.
 */

function status(phase: WatchdogPhase, over: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return {
    phase,
    nextTickAt: phase === 'armed' ? new Date().toISOString() : null,
    config: DEFAULT_WATCHDOG_CONFIG,
    watching: [],
    events: [],
    ...over
  };
}

/** Every call answers the same body — the cases below that only care about
 *  CALL COUNT and CALL ARGS in one unchanging world, the same shape
 *  `test/orchestrator-hook.test.tsx`'s own `stubFetch` uses. */
function stubFetch(body: WatchdogStatus): jest.Mock {
  const fn = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const realFetch = global.fetch;

/** Flushes a promise chain hanging off a mocked (synchronously-resolving)
 *  fetch — identical to `test/orchestrator-hook.test.tsx`'s own `flush`,
 *  and for the identical reason: jest's fake-timer async helpers reach the
 *  clock's next tick through a real `setTimeout(0)` under the hood, which
 *  never runs until the microtask queue (where `fetch().then(...)` lives)
 *  is fully drained — so `advanceTimersByTimeAsync(0)` reliably settles a
 *  pending fetch with no fake time actually elapsing. Wrapped in `act`
 *  because the resulting `setState` has to be flushed before any assertion
 *  reads `result.current`. */
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('useWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  // --- 10: armed polls again after WATCHDOG_POLL_MS --------------------------

  it('fetches once on mount, and again after WATCHDOG_POLL_MS while armed', async () => {
    const fetchMock = stubFetch(status('armed'));
    renderHook(() => useWatchdog());

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/watchdog');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // --- 11: idle never polls ---------------------------------------------------

  it('fetches once on mount, and never again while idle', async () => {
    const fetchMock = stubFetch(status('idle'));
    renderHook(() => useWatchdog());

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // --- 12: window focus refetches, independent of phase -----------------------

  it('refetches once on a window focus event', async () => {
    const fetchMock = stubFetch(status('idle'));
    renderHook(() => useWatchdog());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // --- 13: save() posts exactly the patch, and redraws from the response -----

  it('save() posts exactly the given patch and replaces status from the response, with no extra GET', async () => {
    const fetchMock = stubFetch(status('idle'));
    const { result } = renderHook(() => useWatchdog());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const saved = status('armed', { config: { ...DEFAULT_WATCHDOG_CONFIG, tickMs: 120_000 } });
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(saved) } as Response)
    );

    await act(async () => {
      await result.current.save({ tickMs: 120_000 });
    });

    // Exactly one more call than the mount fetch — the POST itself, and
    // nothing else: `save` must not follow its own POST with a GET, since
    // the POST's response already carries the full status.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/agents/watchdog/config');
    expect(JSON.parse(String(init.body))).toEqual({ tickMs: 120_000 });
    expect(result.current.status).toEqual(saved);
  });

  // --- 14: a rejected fetch never throws, and reports a non-empty error ------

  it('leaves status null and reports a non-empty error when the fetch rejects, without throwing', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new Error('network down')));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useWatchdog());
    await flush();

    expect(result.current.status).toBeNull();
    expect(typeof result.current.error).toBe('string');
    expect((result.current.error as string).length).toBeGreaterThan(0);
  });
});
