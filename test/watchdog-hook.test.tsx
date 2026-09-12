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
  // --- task-18: the `live` option -------------------------------------------
  //
  // The armed-only poll exists for a countdown and a set of heartbeat ages
  // that move on their own — `WatchdogMonitor`'s state card and rows. The
  // Settings group that used to carry that countdown no longer renders
  // anything that changes on a clock, so it passes `live: false` and the
  // interval is never installed. Everything else about the hook is
  // deliberately unchanged under the flag: these cases exist as much to pin
  // what `live: false` must NOT switch off as what it must.

  it('installs no poll while armed when live is false', async () => {
    const fetchMock = stubFetch(status('armed'));
    renderHook(() => useWatchdog({ live: false }));

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Two full poll periods, not one: an off-by-one in the guard (say, an
    // interval installed and cleared on the next render) would still be
    // caught by the first, but a poll that merely starts LATE would slip
    // through a single-period assertion.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still refetches on a window focus event when live is false', async () => {
    const fetchMock = stubFetch(status('armed'));
    renderHook(() => useWatchdog({ live: false }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still saves, with no extra GET, when live is false', async () => {
    const fetchMock = stubFetch(status('armed'));
    const { result } = renderHook(() => useWatchdog({ live: false }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.save({ enabled: false });
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/agents/watchdog/config');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('polls while armed when live is spelled out as true', async () => {
    const fetchMock = stubFetch(status('armed'));
    renderHook(() => useWatchdog({ live: true }));

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // --- bug-24: a failed SAVE is its own state, with its own render site -----
  //
  // The defect these five pin: `save`'s catch used to write the same `error`
  // field `reload`'s catch writes, and `WatchdogGroup` renders `error` in
  // exactly one branch — the one guarded by `status === null`, which a
  // successful mount GET has already made unreachable. A refused POST
  // therefore had NO render site at all. `saveError` is a second field
  // precisely so the two failures can land in two places; the cases below
  // pin that they stay apart, that the failing field travels with the
  // message (that is what buys per-control placement in the group), and
  // that a background refetch does not silently erase it.

  it('lands a non-2xx POST in saveError and nowhere else', async () => {
    const fetchMock = stubFetch(status('idle'));
    const { result } = renderHook(() => useWatchdog());
    await flush();

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'watchdog.json is read-only' })
      } as unknown as Response)
    );

    const mounted = result.current.status;
    await act(async () => {
      await result.current.save({ tickMs: 120_000 });
    });

    expect(result.current.saveError).toEqual({
      field: 'tickMs', message: 'watchdog.json is read-only'
    });
    expect(result.current.error).toBeNull();
    // `status` untouched: the failure was on the write, so what is on screen
    // is still the last value the server actually returned.
    expect(result.current.status).toEqual(mounted);
    expect(result.current.status?.config.tickMs).toBe(DEFAULT_WATCHDOG_CONFIG.tickMs);
  });

  it('lands a rejected POST in saveError too, carrying the field it was posting', async () => {
    const fetchMock = stubFetch(status('idle'));
    const { result } = renderHook(() => useWatchdog());
    await flush();

    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('network down')));

    const mounted = result.current.status;
    await act(async () => {
      await result.current.save({ maxAttempts: 4 });
    });

    expect(result.current.saveError?.message).toBe('network down');
    expect(result.current.saveError?.field).toBe('maxAttempts');
    expect(result.current.status).toEqual(mounted);
    expect(result.current.error).toBeNull();
  });

  it('reports a null field rather than dropping the message when the patch is empty', async () => {
    const fetchMock = stubFetch(status('idle'));
    const { result } = renderHook(() => useWatchdog());
    await flush();

    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('network down')));

    await act(async () => {
      await result.current.save({});
    });

    // The message is the point: a `saveError` that renders nowhere is the
    // bug, so an unattributable failure must still carry something to show.
    expect(result.current.saveError?.field).toBeNull();
    expect(typeof result.current.saveError?.message).toBe('string');
    expect((result.current.saveError?.message as string).length).toBeGreaterThan(0);
  });

  it('clears saveError on a later successful save', async () => {
    const fetchMock = stubFetch(status('idle'));
    const { result } = renderHook(() => useWatchdog());
    await flush();

    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    await act(async () => {
      await result.current.save({ tickMs: 120_000 });
    });
    expect(result.current.saveError).not.toBeNull();

    const saved = status('idle', { config: { ...DEFAULT_WATCHDOG_CONFIG, tickMs: 300_000 } });
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(saved) } as Response)
    );
    await act(async () => {
      await result.current.save({ tickMs: 300_000 });
    });

    expect(result.current.saveError).toBeNull();
    expect(result.current.status?.config.tickMs).toBe(300_000);
  });

  it('leaves saveError standing across a successful reload', async () => {
    const fetchMock = stubFetch(status('idle'));
    const { result } = renderHook(() => useWatchdog());
    await flush();

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'watchdog.json is read-only' })
      } as unknown as Response)
    );
    await act(async () => {
      await result.current.save({ tickMs: 120_000 });
    });
    const afterSave = result.current.saveError;
    expect(afterSave).toEqual({ field: 'tickMs', message: 'watchdog.json is read-only' });

    // A focus refetch fires on the window's schedule, not the user's. It
    // must not erase the one line telling them their change never stuck —
    // and the refreshed config is what makes that line true rather than
    // stale, since the value on screen is once again the server's own.
    const refetched = status('armed');
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(refetched) } as Response)
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    expect(result.current.error).toBeNull();
    expect(result.current.status).toEqual(refetched);
    expect(result.current.saveError).toEqual(afterSave);
  });
});
