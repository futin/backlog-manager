/**
 * @jest-environment jsdom
 */
import { StrictMode } from 'react';
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
 *  the same body, for the cases that only care about CALL COUNT in one
 *  unchanging world. */
function stubFetch(body: OrchestratorRunsPayload): jest.Mock {
  const fn = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * Answers a DIFFERENT body per call, clamped to the last one once the list
 * runs out — for the cases below that exist specifically to prove a
 * fresh→stale or stale→fresh TRANSITION, not just a static world. A stub
 * that always answers the same body (`stubFetch` above) cannot exercise
 * these: the polling effect only ever reruns in response to `anyFresh`
 * actually changing value between one landed payload and the next.
 */
function stubFetchSequence(bodies: OrchestratorRunsPayload[]): jest.Mock {
  let call = 0;
  const fn = jest.fn(() => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  });
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

  /**
   * Regression test for fix round 1's Critical finding. client/src/main.tsx
   * wraps the whole app in `<StrictMode>`, which in development mounts every
   * component TWICE on purpose — mount, run every effect's cleanup, mount
   * again — specifically to surface effects that misbehave across that
   * cycle. Every other case in this file renders bare (matching this
   * repo's other hook suites, none of which hit this class of bug), which
   * is exactly why the original bug went uncaught: `mountedRef.current` used
   * to be set to `true` only inside `useRef`'s initializer, which React
   * calls exactly once for the life of the fiber — never again on the
   * remount's own effect run. StrictMode's first (throwaway) cleanup set the
   * flag `false`, and with nothing left to set it back to `true`, it stayed
   * `false` for the rest of the component's real, on-screen life — so
   * `refresh()`'s `setRuns` was skipped forever, from the very first real
   * mount onward, the moment this app is ever actually rendered.
   *
   * Verified empirically before writing this test (see the fix report for
   * the full method): reverting the hook's effect body to only
   * `useRef(true)`'s initializer — i.e. `useEffect(() => () => {
   * mountedRef.current = false; }, [])` — makes this exact case fail with
   * `result.current.runs` stuck at `[]` forever, confirming this case would
   * have caught the bug had it existed from Task 10's first draft.
   */
  it('lands data normally after React StrictMode\'s dev-only mount, cleanup, remount cycle', async () => {
    const fetchMock = stubFetch(payload(true));
    const { result } = renderHook(() => useOrchestratorRuns(), { wrapper: StrictMode });

    await flush();

    expect(result.current.runs).toEqual(payload(true).runs);

    // The stuck-false flag would have skipped every FUTURE poll too, not
    // just the first landing — so prove polling still works post-StrictMode,
    // not only the initial fetch.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // --- Test case 2: a fresh run polls every 5s, and stops on going stale ----

  it('polls again 5s after landing a fresh run, and again 5s after that', async () => {
    const fetchMock = stubFetch(payload(true));
    renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The interval this whole hook exists to install — proof it actually
    // armed, not just that a second fetch happens to follow.
    expect(jest.getTimerCount()).toBe(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Not a one-shot timeout: the interval must still be armed after firing
    // once, since a run in progress keeps needing a live queue for more than
    // one tick.
    expect(jest.getTimerCount()).toBe(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /**
   * The fresh→stale transition, missing from fix round 1's original
   * suite (every case there answered the SAME body on every call, so the
   * polling effect's dependency on `anyFresh` actually changing value was
   * never exercised — only the two static worlds either side of it). A run
   * finishing or going stale mid-poll must stop the interval on the very
   * render that discovers it, not merely stop scheduling new ones from that
   * point while an old one silently keeps ticking.
   */
  it('stops polling the instant a poll discovers every run has gone stale', async () => {
    const fetchMock = stubFetchSequence([payload(true), payload(false)]);
    renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    // This tick's answer (the sequence's second body) is stale.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);

    // And with the interval actually gone, nothing fires again on its own.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // --- Test case 3: an all-stale payload never polls ------------------------

  it('never polls when every known run is stale', async () => {
    const fetchMock = stubFetch(payload(false));
    renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

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

  /**
   * The stale→fresh transition via focus, the other half of the gap fix
   * round 1 flagged: a board sitting quiet (nothing fresh, no interval) must
   * resume polling the instant a focus refetch discovers a run has gone
   * live — not wait for some later mount/focus to notice.
   */
  it('a focus refetch that discovers a newly-fresh run re-arms the interval', async () => {
    const fetchMock = stubFetchSequence([payload(false), payload(true)]);
    renderHook(() => useOrchestratorRuns());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0); // stale on arrival: nothing armed

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1); // now fresh: interval installed

    // And it is a genuinely live interval, not a count that happens to read
    // 1 for an unrelated reason — prove it actually polls from here.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  /**
   * Fix round 1's other IMPORTANT finding: no case here ever unmounted with
   * a fetch genuinely still in flight — the one scenario the `mountedRef`
   * guard's own doc comment says it exists for. This pins that literal
   * contract: start a fetch, unmount before it resolves, resolve it only
   * afterward, and confirm nothing breaks.
   *
   * One finding reported honestly rather than glossed over: this specific
   * case CANNOT be made to fail by removing the guard, in the React version
   * this repo has installed (18.3). Checked by hand before writing this
   * (full method in the fix report): a throwaway probe calling a captured
   * `useState` setter — both synchronously and via an async `.then()`,
   * both inside and outside `act()` — after a real `unmount()` produced
   * zero console output and no change to the rendered value, every time.
   * Stripping this hook's own guard entirely and re-running an equivalent
   * case against the REAL hook produced byte-identical output to the
   * guarded version. React 18 already treats an update targeting a truly
   * unmounted fiber as a fully silent no-op on its own, guard or not — so
   * there is no black-box way to observe the guard's absence once a
   * component is genuinely, finally gone. (The StrictMode case above is the
   * one that actually failed without this round's fix, because a StrictMode
   * remount is NOT a final unmount — the fiber is genuinely still mounted
   * a moment later, which is exactly why an update landing late there is
   * both possible and, without the guard, wrongly suppressed forever.) This
   * case still earns its place: it pins the intended contract in an
   * executable form, and it is the only case in this file that exercises
   * the `false` branch of the guard's own `if` at all.
   */
  it('does not update state, throw, or warn for a fetch that resolves after a genuine unmount', async () => {
    let resolveFetch!: (body: OrchestratorRunsPayload) => void;
    const fetchMock = jest.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = (body) => resolve({
        ok: true, status: 200, json: () => Promise.resolve(body)
      } as Response);
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useOrchestratorRuns());
    // The mount effect has fired (fetch() was called synchronously), but the
    // response has not arrived yet — the exact race the guard is for.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.runs).toEqual([]);

    act(() => {
      unmount();
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Only now, after the component is gone, does the in-flight request
    // resolve.
    await act(async () => {
      resolveFetch(payload(true));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result.current.runs).toEqual([]);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
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
