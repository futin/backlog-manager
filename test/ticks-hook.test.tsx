/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useTicks } from '../client/src/hooks/useTicks';
import type { TicksPayload } from '../shared/types';

/**
 * `useTicks` — mount fetch, the opt-in 15 s poll, and the two writes that replace `data` from the POST's own answer. jsdom + fake timers + a local fetch stub,
 * the shape `test/watchdog-hook.test.tsx` uses. No fixture here carries a date, so nothing needs to be relative to the clock.
 */

function payload(haltAfter: number, names: string[] = ['a']): TicksPayload {
  return { config: { haltAfter, maxPlans: 3, maxPrs: 2, source: 'file' }, projects: names.map((name) => ({ root: `/r/${name}`, name, lock: null, recent: [] })) };
}

type Reply = { ok?: boolean; status?: number; body: unknown };

/** One scripted answer per call, by method+path; the last unmatched call answers `fallback`. */
function stubFetch(routes: Record<string, Reply | (() => Reply)>): jest.Mock {
  const fn = jest.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected request ${key}`);
    const { ok = true, status = 200, body } = typeof r === 'function' ? r() : r;
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const realFetch = global.fetch;

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('useTicks', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('live: false fetches once on mount and never again after 20 s', async () => {
    const fn = stubFetch({ 'GET /api/ticks': { body: payload(3) } });
    const { result } = renderHook(() => useTicks({ live: false }));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(payload(3));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('live: true re-fetches 15 s after an answer, not before', async () => {
    const fn = stubFetch({ 'GET /api/ticks': { body: payload(3) } });
    renderHook(() => useTicks({ live: true }));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(14_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('defaults to live', async () => {
    const fn = stubFetch({ 'GET /api/ticks': { body: payload(3) } });
    renderHook(() => useTicks());
    await flush();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a failed read sets error and keeps the last data', async () => {
    let fail = false;
    stubFetch({ 'GET /api/ticks': () => (fail ? { ok: false, status: 500, body: { error: 'boom' } } : { body: payload(3) }) });
    const { result } = renderHook(() => useTicks({ live: true }));
    await flush();
    fail = true;
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toEqual(payload(3));
  });

  it('save replaces data with the POST answer, without a second GET', async () => {
    const fn = stubFetch({ 'GET /api/ticks': { body: payload(3) }, 'POST /api/ticks/config': { body: payload(7) } });
    const { result } = renderHook(() => useTicks({ live: false }));
    await flush();
    await act(async () => {
      await result.current.save({ haltAfter: 7 });
    });
    expect(result.current.data).toEqual(payload(7));
    expect(result.current.saveError).toBeNull();
    expect(fn.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fn.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(1);
    expect(JSON.parse(fn.mock.calls[1][1].body as string)).toEqual({ haltAfter: 7 });
  });

  it('reset replaces data with the POST answer', async () => {
    const fn = stubFetch({ 'GET /api/ticks': { body: payload(3, ['a', 'b']) }, 'POST /api/ticks/reset': { body: payload(3, ['a']) } });
    const { result } = renderHook(() => useTicks({ live: false }));
    await flush();
    await act(async () => {
      await result.current.reset('/r/a');
    });
    expect(result.current.data).toEqual(payload(3, ['a']));
    expect(JSON.parse(fn.mock.calls[1][1].body as string)).toEqual({ project: '/r/a' });
  });

  it('a failed POST sets saveError and keeps data; the next success clears it', async () => {
    let fail = true;
    stubFetch({
      'GET /api/ticks': { body: payload(3) },
      'POST /api/ticks/config': () => (fail ? { ok: false, status: 409, body: { error: '/x/tick.json unreadable' } } : { body: payload(4) })
    });
    const { result } = renderHook(() => useTicks({ live: false }));
    await flush();
    await act(async () => {
      await result.current.save({ haltAfter: 4 });
    });
    expect(result.current.saveError).toBe('/x/tick.json unreadable');
    expect(result.current.data).toEqual(payload(3));
    expect(result.current.error).toBeNull();
    fail = false;
    await act(async () => {
      await result.current.save({ haltAfter: 4 });
    });
    expect(result.current.saveError).toBeNull();
    expect(result.current.data).toEqual(payload(4));
  });

  it('a failed reset sets saveError and keeps data', async () => {
    stubFetch({
      'GET /api/ticks': { body: payload(3) },
      'POST /api/ticks/reset': { ok: false, status: 404, body: { error: 'no tick history for that project' } }
    });
    const { result } = renderHook(() => useTicks({ live: false }));
    await flush();
    await act(async () => {
      await result.current.reset('/r/zzz');
    });
    expect(result.current.saveError).toBe('no tick history for that project');
    expect(result.current.data).toEqual(payload(3));
  });
});
