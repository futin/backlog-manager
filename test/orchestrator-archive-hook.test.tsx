/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useOrchestratorArchive } from '../client/src/hooks/useOrchestratorArchive';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorArchivePayload, OrchestratorArchiveRun, OrchestratorRun, VerificationSummary } from '../shared/types';

// Same translation orchestrator-hook.test.tsx and orchestrator-archive.test.ts
// already use: the fixture is plain JSON, so TS would otherwise widen its
// string fields to `string` instead of the narrower literal unions
// (`RunStage`, etc).
const fixture = rawFixture as OrchestratorRun;

/**
 * An `OrchestratorArchiveRun` built from the same `OrchestratorRun` fixture
 * every other run-shaped suite in this repo shares, tails summarised away
 * the same way `OrchestratorService.archive` does on the server
 * (test/orchestrator-archive.test.ts) — so this hook's tests exercise the
 * exact shape the real `/api/orchestrator/archive` endpoint answers with,
 * not a hand-rolled approximation of it.
 */
function archiveRun(overrides: Partial<OrchestratorArchiveRun> = {}): OrchestratorArchiveRun {
  return {
    ...fixture,
    current: true,
    queue: fixture.queue.map((item) => ({
      ...item,
      verification: item.verification.map(({ cmd, ok }): VerificationSummary => ({ cmd, ok }))
    })),
    ...overrides
  };
}

function payload(overrides: Partial<OrchestratorArchiveRun> = {}): OrchestratorArchivePayload {
  return { runs: [archiveRun(overrides)] };
}

/** Same shape as test/agents-client.test.ts's own `stub` / test/orchestrator-hook.test.tsx's `stubFetch`:
 *  every call answers the same body, for cases that only care about how many
 *  times fetch was called in one unchanging world. */
function stubFetch(body: OrchestratorArchivePayload): jest.Mock {
  const fn = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** A fetch that always rejects — for the "failed fetch keeps previous
 *  state" case, where the interesting behaviour is what does NOT change. */
function stubFetchRejecting(): jest.Mock {
  const fn = jest.fn(() => Promise.reject(new Error('network down')));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// Captured once and restored after every case, the same hazard
// test/agents-client.test.ts and test/orchestrator-hook.test.tsx already
// guard against: a mock left on global.fetch is inherited by whatever runs
// next in this worker.
const realFetch = global.fetch;

// Flushes a promise chain hanging off a mocked (synchronously-resolving)
// fetch — same reasoning as test/orchestrator-hook.test.tsx's identical
// helper: jest's *Async timer helpers reach the fake clock's next tick via a
// real setTimeout(0) under the hood, which never runs until the microtask
// queue (where our fetch().then(...) chain lives) is fully drained, so
// advanceTimersByTimeAsync(0) reliably settles a pending fetch with no fake
// time actually elapsing. Wrapped in `act` because the resulting setState
// has to be flushed before any assertion reads `result.current`.
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('useOrchestratorArchive', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('fetches on mount and exposes runs', async () => {
    const fetchMock = stubFetch(payload());
    const { result } = renderHook(() => useOrchestratorArchive());

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/orchestrator/archive');
    expect(result.current.runs).toEqual(payload().runs);
  });

  it('refetches on window focus', async () => {
    const fetchMock = stubFetch(payload());
    renderHook(() => useOrchestratorArchive());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The one behavioural difference from `useOrchestratorRuns` this hook
   * exists for: run HISTORY moves at run boundaries (a run starts, a run
   * finishes, the next `init` archives `run.json` into `runs/`), not on a
   * heartbeat, so there is nothing here for a poll to usefully catch that
   * the next mount or focus would not already catch just as well —
   * installing one anyway would cost every idle Runs-tab viewer a request
   * every few seconds for no reason. Proven the same way
   * orchestrator-hook.test.tsx proves the opposite hook DOES install one:
   * advance fake time past several would-be poll intervals (30s is six
   * multiples of useOrchestratorRuns' own 5s `POLL_MS`) and show the call
   * count never moves, and that no timer was ever armed to begin with.
   */
  it('does not install any polling interval', async () => {
    const fetchMock = stubFetch(payload());
    renderHook(() => useOrchestratorArchive());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous runs when a fetch fails', async () => {
    const fetchMock = stubFetch(payload());
    const { result } = renderHook(() => useOrchestratorArchive());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.runs).toEqual(payload().runs);

    stubFetchRejecting();
    act(() => {
      result.current.refresh();
    });
    await flush();

    expect(result.current.runs).toEqual(payload().runs);
  });
});
