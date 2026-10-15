/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { useBoard } from '../client/src/hooks/useBoard';
import type { ItemsIndex, ProjectSummary } from '../shared/types';

/**
 * `useBoard`'s refetch ordering (#270). Mount, focus, the tracker interval and BoardView's own post-write `refetch` can all have a read in flight at
 * once, and they settle in whatever order the network likes. Before the guard, the LAST answer to land won — so a read started before a claim was
 * released, answering after the read started after it, painted the released claim back onto the card. `useTrackers` has carried the same guard since
 * #231; this pins that only the newest read's answer (or failure) reaches state.
 *
 * A local `deferredFetch` rather than anything shared — this repo's per-suite-owns-its-stub convention — because the case needs each request's answer
 * released by hand, in an order the test picks.
 */

type Pending = { url: string; resolve: (body: unknown) => void; reject: (e: Error) => void };

function deferredFetch(): Pending[] {
  const pending: Pending[] = [];
  global.fetch = jest.fn(
    (input: RequestInfo | URL) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({
          url: String(input),
          resolve: (body) => resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response),
          reject
        });
      })
  ) as unknown as typeof fetch;
  return pending;
}

/** An index whose one marker is `tag`, so an assertion can tell which read's answer is in state. */
function index(tag: string): ItemsIndex {
  return { items: [], generatedAt: tag } as unknown as ItemsIndex;
}

const PROJECTS: ProjectSummary[] = [];

const realFetch = global.fetch;

describe('useBoard', () => {
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('applies only the newest refetch: an older answer landing last does not overwrite it', async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useBoard());
    // The mount read is pair 0; refetch() starts pair 1.
    expect(pending).toHaveLength(2);
    act(() => result.current.refetch());
    expect(pending).toHaveLength(4);

    // The newer pair answers first …
    await act(async () => {
      pending[2].resolve(index('new'));
      pending[3].resolve(PROJECTS);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect((result.current.items as unknown as { generatedAt: string }).generatedAt).toBe('new');

    // … then the older one, which must change nothing.
    await act(async () => {
      pending[0].resolve(index('old'));
      pending[1].resolve(PROJECTS);
    });
    expect((result.current.items as unknown as { generatedAt: string }).generatedAt).toBe('new');
  });

  it('does not raise error when a superseded read fails after the newest one succeeded', async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useBoard());
    act(() => result.current.refetch());

    await act(async () => {
      pending[2].resolve(index('new'));
      pending[3].resolve(PROJECTS);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      pending[0].reject(new Error('network'));
    });
    expect(result.current.error).toBe(false);
    expect((result.current.items as unknown as { generatedAt: string }).generatedAt).toBe('new');
  });
});
