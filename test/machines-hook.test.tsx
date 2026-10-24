/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { MACHINES_POLL_MS, useMachines } from '../client/src/hooks/useMachines';
import type { MachinesStatus } from '../shared/types';

/**
 * `useMachines` (Settings › Dashboards, task 4) — mount + focus come from `useRefreshing`, the minute-cadence poll is its `armed`/`intervalMs`; this suite pins
 * the four things the page leans on: one read on mount, one more a period later, a failed read that keeps the last answer, and a `reload` that reads at once.
 * Same posture as `test/watchdog-hook.test.tsx`: jsdom, fake timers, a per-suite fetch stub.
 */

function answer(label: string): MachinesStatus {
  return {
    machines: [{ machine: label, enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: null, usage: null, usageAgeMs: null }]
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

const realFetch = global.fetch;

/** Settles a promise chain hanging off a synchronously-resolving fetch with no fake time elapsing (see `test/watchdog-hook.test.tsx`'s `flush`). */
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('useMachines', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('polls once a minute', () => {
    expect(MACHINES_POLL_MS).toBe(60_000);
  });

  it('fetches once on mount and again after MACHINES_POLL_MS', async () => {
    const fn = jest.fn(() => Promise.resolve(okResponse(answer('home'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useMachines());

    expect(result.current.machines).toBeNull();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('/api/dashboards/machines');
    expect(result.current.machines).toEqual(answer('home'));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MACHINES_POLL_MS);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps the first answer when a later read is rejected', async () => {
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(okResponse(answer('first'))))
      .mockImplementation(() => Promise.reject(new Error('down')));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useMachines());
    await flush();
    expect(result.current.machines).toEqual(answer('first'));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MACHINES_POLL_MS);
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.current.machines).toEqual(answer('first'));
  });

  it('keeps null when the very first read fails, and tries again on the next period', async () => {
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementation(() => Promise.resolve(okResponse(answer('second'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useMachines());
    await flush();
    expect(result.current.machines).toBeNull();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MACHINES_POLL_MS);
    });
    expect(result.current.machines).toEqual(answer('second'));
  });

  it('reload() reads at once', async () => {
    const fn = jest.fn(() => Promise.resolve(okResponse(answer('home'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useMachines());
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.reload();
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fires nothing after unmount', async () => {
    const fn = jest.fn(() => Promise.resolve(okResponse(answer('home'))));
    global.fetch = fn as unknown as typeof fetch;
    const { unmount } = renderHook(() => useMachines());
    await flush();
    unmount();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MACHINES_POLL_MS * 3);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
