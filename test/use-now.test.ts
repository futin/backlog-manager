/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useNow } from '../client/src/hooks/useNow';

/**
 * The one place in this codebase where faking timers is the right call: this
 * hook IS the clock. Everything downstream of it — elapsedSince, the card —
 * takes `now` as a value precisely so it can be tested without any of this.
 */
describe('useNow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-08-28T12:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the current time straight away, enabled or not', () => {
    const on = renderHook(() => useNow(true));
    const off = renderHook(() => useNow(false));

    expect(on.result.current).toBe(Date.parse('2026-08-28T12:00:00Z'));
    expect(off.result.current).toBe(Date.parse('2026-08-28T12:00:00Z'));
  });

  it('advances once per period while enabled', () => {
    const { result } = renderHook(() => useNow(true, 60_000));

    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(Date.parse('2026-08-28T12:01:00Z'));

    act(() => {
      jest.advanceTimersByTime(120_000);
    });
    expect(result.current).toBe(Date.parse('2026-08-28T12:03:00Z'));
  });

  // A board with nothing in progress has no label that can go stale, so it
  // should not install a timer at all — the point of the flag, not a detail of
  // it. Asserted on the observable value AND on the timer count, because a hook
  // that ticks a value nobody reads is still a wakeup every minute forever.
  it('installs no timer at all while disabled', () => {
    const { result } = renderHook(() => useNow(false, 60_000));

    expect(jest.getTimerCount()).toBe(0);
    act(() => {
      jest.advanceTimersByTime(600_000);
    });
    expect(result.current).toBe(Date.parse('2026-08-28T12:00:00Z'));
  });

  it('starts ticking when it becomes enabled and stops when it stops', () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useNow(enabled, 60_000),
      { initialProps: { enabled: false } }
    );

    rerender({ enabled: true });
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(Date.parse('2026-08-28T12:01:00Z'));

    rerender({ enabled: false });
    expect(jest.getTimerCount()).toBe(0);
    act(() => {
      jest.advanceTimersByTime(600_000);
    });
    expect(result.current).toBe(Date.parse('2026-08-28T12:01:00Z'));
  });

  it('clears its timer on unmount', () => {
    const { unmount } = renderHook(() => useNow(true, 60_000));
    expect(jest.getTimerCount()).toBe(1);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });
});
