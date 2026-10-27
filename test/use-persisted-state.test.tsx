/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { usePersistedState } from '../client/src/hooks/usePersistedState';

/**
 * The hook's two catch paths (client/src/hooks/usePersistedState.ts): a read that throws or does not parse falls back, and a write that throws is
 * swallowed — private mode and a full quota both throw from `localStorage`, and neither may take a render down. Spied on `Storage.prototype` because
 * jsdom's `localStorage` is an instance of it, and restored after every case so no throwing storage leaks into the next suite in this worker.
 */
describe('usePersistedState', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  it('falls back when the stored value is not JSON', () => {
    localStorage.setItem('bm-test', '{ not json');
    const { result } = renderHook(() => usePersistedState('bm-test', { a: 1 }));
    expect(result.current[0]).toEqual({ a: 1 });
  });

  it('falls back when reading localStorage throws', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { result } = renderHook(() => usePersistedState('bm-test', 'fallback'));
    expect(result.current[0]).toBe('fallback');
  });

  it('keeps the new value in state when writing localStorage throws', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => usePersistedState('bm-test', 'fallback'));
    act(() => {
      result.current[1]('next');
    });
    expect(result.current[0]).toBe('next');
    expect(setItem).toHaveBeenCalledWith('bm-test', JSON.stringify('next'));
  });
});
