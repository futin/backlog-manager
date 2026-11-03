/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { JIRA_SESSIONS_POLL_MS, useJiraSessions } from '../client/src/hooks/useJiraSessions';
import type { JiraSessionsPayload } from '../shared/types';

/**
 * `useJiraSessions` (Jira sessions Task 10) — the Jira section's one sessions poll. Pinned here: one read on mount carrying `?open=1` for a page and not for a
 * reader that is not one, one more a period (15 s) later, a failed or malformed read that keeps the last answer, and a `reload` that reads at once. Same
 * posture as `test/machines-hook.test.tsx`: jsdom, fake timers, a per-suite fetch stub.
 */

const payload = (rowsAt: string): JiraSessionsPayload => ({ links: [], reachable: true, rowsAt });
const okResponse = (body: unknown): Response => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;
const realFetch = global.fetch;

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('useJiraSessions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('polls every 15 seconds, the server’s own fast reconciler rate', () => {
    expect(JIRA_SESSIONS_POLL_MS).toBe(15_000);
  });

  it('reads once on mount with ?open=1 and again a period later', async () => {
    const fn = jest.fn(() => Promise.resolve(okResponse(payload('a'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useJiraSessions({ open: true }));
    expect(result.current.data).toBeNull();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('/api/jira/sessions?open=1');
    expect(result.current.data).toEqual(payload('a'));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(JIRA_SESSIONS_POLL_MS);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('asks without ?open=1 when the reader is not a page', async () => {
    const fn = jest.fn(() => Promise.resolve(okResponse(payload('a'))));
    global.fetch = fn as unknown as typeof fetch;
    renderHook(() => useJiraSessions({ open: false }));
    await flush();
    expect(fn).toHaveBeenCalledWith('/api/jira/sessions');
  });

  it('keeps the last answer through a rejected read and through a malformed one', async () => {
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(okResponse(payload('first'))))
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementation(() => Promise.resolve(okResponse({ nope: true })));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useJiraSessions({ open: true }));
    await flush();
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(JIRA_SESSIONS_POLL_MS);
      });
    }
    expect(fn).toHaveBeenCalledTimes(3);
    expect(result.current.data).toEqual(payload('first'));
  });

  it('reload() reads at once, and nothing fires after unmount', async () => {
    const fn = jest.fn(() => Promise.resolve(okResponse(payload('a'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result, unmount } = renderHook(() => useJiraSessions({ open: true }));
    await flush();
    await act(async () => {
      await result.current.reload();
    });
    expect(fn).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(JIRA_SESSIONS_POLL_MS * 3);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
