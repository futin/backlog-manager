/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { errorMessage, useAction, type ActionHandlers } from '../client/src/hooks/useAction';
import { ApiError } from '../client/src/lib/agents';

/*
  #286 — the one home of a click-fired mutation's guard, `busy`, `error` and message mapping. Every case drives the hook through a tiny component that
  renders the two values and fires `run` from a button, because the guard's whole point is what happens between a click and the re-render that follows it —
  a `renderHook` call would test the function and skip the tick the bug lives in.

  The thunk's promise is settled by hand (`deferred()`), so the in-flight window is exactly as long as the case says it is.
*/

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness<T>({ call, on }: { call: () => Promise<T>; on?: ActionHandlers<T> }) {
  const { busy, error, run } = useAction();
  return (
    <div>
      <button onClick={() => run(call, on)}>go</button>
      <span data-testid="busy">{String(busy)}</span>
      <span data-testid="error">{error === null ? 'null' : error}</span>
    </div>
  );
}

/** Both clicks land before React re-renders — `test/run-controls.test.tsx`'s `doubleClick`, for the same reason: only a raw dispatch pair inside one `act`
 *  reaches the guard rather than the rendered state. */
function doubleClick(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Lets a settled promise's `.then`/`.catch`/`.finally` chain run, inside `act` so its setState is flushed. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

const button = () => screen.getByRole('button', { name: 'go' });
const busyText = () => screen.getByTestId('busy').textContent;
const errorText = () => screen.getByTestId('error').textContent;

describe('useAction', () => {
  it('runs the thunk once for two clicks inside one tick', () => {
    const d = deferred();
    const call = jest.fn(() => d.promise);
    render(<Harness call={call} />);

    doubleClick(button());

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('releases the guard after a success', async () => {
    const d = deferred();
    // The second call gets a promise that never settles, so nothing lands after the case ends.
    const call = jest.fn().mockReturnValueOnce(d.promise).mockReturnValueOnce(deferred().promise);
    render(<Harness call={call} />);

    click(button());
    d.resolve('ok');
    await settle();
    click(button());

    expect(call).toHaveBeenCalledTimes(2);
  });

  it('releases the guard after a failure', async () => {
    const d = deferred();
    // The second call gets a promise that never settles, so nothing lands after the case ends.
    const call = jest.fn().mockReturnValueOnce(d.promise).mockReturnValueOnce(deferred().promise);
    render(<Harness call={call} />);

    click(button());
    d.reject(new Error('nope'));
    await settle();
    click(button());

    expect(call).toHaveBeenCalledTimes(2);
  });

  it('renders busy while the call is out, on both settle paths', async () => {
    const ok = deferred();
    const fail = deferred();
    const call = jest.fn().mockReturnValueOnce(ok.promise).mockReturnValueOnce(fail.promise);
    render(<Harness call={call} />);

    expect(busyText()).toBe('false');
    click(button());
    expect(busyText()).toBe('true');
    ok.resolve('ok');
    await settle();
    expect(busyText()).toBe('false');

    click(button());
    expect(busyText()).toBe('true');
    fail.reject(new Error('nope'));
    await settle();
    expect(busyText()).toBe('false');
  });

  it.each([
    ['an Error', new Error('nope'), 'nope'],
    ['a string', 'raw', 'raw'],
    ['an ApiError', new ApiError('server words', 409), 'server words']
  ])('renders the message of %s', async (_label, rejection, expected) => {
    const d = deferred();
    render(<Harness call={() => d.promise} />);

    click(button());
    d.reject(rejection);
    await settle();

    expect(errorText()).toBe(expected);
  });

  it('clears the error when the next run starts', async () => {
    const first = deferred();
    const second = deferred();
    const call = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Harness call={call} />);

    click(button());
    first.reject(new Error('nope'));
    await settle();
    expect(errorText()).toBe('nope');

    click(button());
    expect(errorText()).toBe('null');
    expect(busyText()).toBe('true');
  });

  it('renders no error when onError returns true', async () => {
    const d = deferred();
    const rejection = new Error('already alive');
    const onError = jest.fn(() => true);
    render(<Harness call={() => d.promise} on={{ onError }} />);

    click(button());
    d.reject(rejection);
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(rejection);
    expect(errorText()).toBe('null');
  });

  it('still renders the error when onError returns nothing', async () => {
    const d = deferred();
    const onError = jest.fn(() => undefined);
    render(<Harness call={() => d.promise} on={{ onError }} />);

    click(button());
    d.reject(new Error('nope'));
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(errorText()).toBe('nope');
  });

  it('hands the resolved value to onSuccess and never calls onError', async () => {
    const d = deferred<{ sessionId: string }>();
    const value = { sessionId: 's1' };
    const onSuccess = jest.fn();
    const onError = jest.fn();
    render(<Harness call={() => d.promise} on={{ onSuccess, onError }} />);

    click(button());
    d.resolve(value);
    await settle();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(value);
    expect(onError).not.toHaveBeenCalled();
  });

  it('makes no state update after unmount, and still calls onSuccess', async () => {
    const d = deferred();
    const onSuccess = jest.fn();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { unmount } = render(<Harness call={() => d.promise} on={{ onSuccess }} />);

      click(button());
      unmount();
      d.resolve('ok');
      await settle();

      expect(spy).not.toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('errorMessage', () => {
  it('maps an Error to its message and anything else through String', () => {
    expect(errorMessage(new Error('a'))).toBe('a');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
