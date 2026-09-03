/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { useAgents } from '../client/src/hooks/useAgents';
import type { AgentsStatus } from '../shared/types';

const READY: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
};

/** Same shape test/orchestrator-hook.test.tsx's own `stubFetch` uses. */
function stubFetch(body: AgentsStatus): jest.Mock {
  const fn = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/**
 * The hook's cadence (mount + window focus, no interval) is covered where it
 * is decided — this suite is about `reload`'s RETURN, which bug-13 made
 * load-bearing. `DispatchButton` re-asks the status on a click that a
 * project-visibility block would otherwise swallow, and it has to decide
 * whether to open the sheet from THAT answer: the setState `reload` also
 * performs lands on a later render, which is one render too late for the
 * handler that provoked it.
 */
describe('useAgents reload', () => {
  it('resolves to the status it just fetched', async () => {
    stubFetch(READY);
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.status).toEqual(READY));

    let answered: AgentsStatus | null = null;
    await act(async () => { answered = await result.current.reload(); });

    expect(answered).toEqual(READY);
  });

  /* And it never rejects. The hook's own `.catch` already maps a failing
     status endpoint onto a flatly-off status (our API being down, which the
     board's error state covers), and a caller awaiting the answer to decide
     whether to open a sheet must get that same "off" rather than an unhandled
     rejection inside a click handler. `enabled: false` reads as an
     environment-level block, so the decision it feeds is "open nothing". */
  it('resolves to an off status rather than rejecting when the fetch fails', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let answered: AgentsStatus | null = null;
    await act(async () => { answered = await result.current.reload(); });

    expect(answered).toMatchObject({ enabled: false, reachable: false, projectPaths: [] });
  });
});
