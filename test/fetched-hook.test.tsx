/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useFetched, type Fetched } from '../client/src/hooks/useFetched';

/**
 * #285 — `useFetched`, the one keyed one-shot read. Every load is a promise the test settles by hand, so "pending" is a state the test holds rather than a
 * race it hopes to win, and every render's reading is recorded so "no frame ever showed X" is an assertion over the whole history, not the last render.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('useFetched', () => {
  it('F1: pending, then ok with the resolved value', async () => {
    const d = deferred<number>();
    const seen: Fetched<number>[] = [];
    const { result } = renderHook(() => {
      const f = useFetched(() => d.promise, []);
      seen.push(f);
      return f;
    });
    expect(result.current).toMatchObject({ status: 'pending', value: null });

    await act(async () => d.resolve(42));
    expect(result.current).toMatchObject({ status: 'ok', value: 42 });
    expect(seen.map((f) => f.status)).toEqual(['pending', 'ok']);
  });

  it('F2: a superseded answer never renders, and the first render under a new key is pending with no value', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const seen: Fetched<string>[] = [];
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => {
        const f = useFetched(() => (key === 'a' ? first.promise : second.promise), [key]);
        seen.push(f);
        return f;
      },
      { initialProps: { key: 'a' } }
    );

    rerender({ key: 'b' });
    await act(async () => first.resolve('old'));
    await act(async () => second.resolve('new'));

    expect(seen.some((f) => f.value === 'old')).toBe(false);
    expect(result.current).toMatchObject({ status: 'ok', value: 'new' });

    // ok for key C, then key D: the very first render under D reads pending, never C's value.
    const c = deferred<string>();
    const dd = deferred<string>();
    const log: { key: string; f: Fetched<string> }[] = [];
    const hook = renderHook(
      ({ key }: { key: string }) => {
        const f = useFetched(() => (key === 'c' ? c.promise : dd.promise), [key]);
        log.push({ key, f });
        return f;
      },
      { initialProps: { key: 'c' } }
    );
    await act(async () => c.resolve('C'));
    expect(hook.result.current).toMatchObject({ status: 'ok', value: 'C' });

    hook.rerender({ key: 'd' });
    const firstUnderD = log.find((entry) => entry.key === 'd');
    expect(firstUnderD?.f).toMatchObject({ status: 'pending', value: null });
  });

  it('F3: a rejection reads failed, with the error and no value', async () => {
    const d = deferred<number>();
    const { result } = renderHook(() => useFetched(() => d.promise, []));
    await act(async () => d.reject(new Error('x')));
    expect(result.current.status).toBe('failed');
    expect(result.current.value).toBeNull();
    expect((result.current.error as Error).message).toBe('x');
  });

  it('F4: a null load is idle and asks nothing; switching to a function starts exactly one call', async () => {
    const load = jest.fn(() => Promise.resolve(1));
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useFetched(on ? load : null, ['same']), { initialProps: { on: false } });
    expect(result.current).toMatchObject({ status: 'idle', value: null });
    expect(load).not.toHaveBeenCalled();

    rerender({ on: true });
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ status: 'ok', value: 1 });
  });

  it('F5: unmounting while pending, then resolving, logs nothing', async () => {
    const d = deferred<number>();
    const { unmount } = renderHook(() => useFetched(() => d.promise, []));
    unmount();
    await act(async () => d.resolve(1));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('F6: a rerender with the same deps and a fresh closure does not ask again', async () => {
    const calls = jest.fn();
    const { rerender } = renderHook(({ n }: { n: number }) =>
      useFetched(() => {
        calls(n);
        return Promise.resolve(n);
      }, ['k']),
      { initialProps: { n: 1 } }
    );
    rerender({ n: 2 });
    rerender({ n: 3 });
    await act(async () => {});
    expect(calls).toHaveBeenCalledTimes(1);
  });
});
