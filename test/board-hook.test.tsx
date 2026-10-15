/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { useBoard } from '../client/src/hooks/useBoard';
import type { ItemsIndex, ProjectSummary } from '../shared/types';

/**
 * `useBoard`'s refetch ordering (#270), as it holds since #277. Mount, focus and BoardView's own post-write `refetch` used to each put a pair in flight,
 * and they settled in whatever order the network liked — so a read started before a claim was released, answering after the read started after it,
 * painted the released claim back onto the card, and a superseded read that failed raised `error` over a good answer. #270 fixed that with a sequence
 * guard; #277 then put every request this hook makes through `useCoalescedFetch`, which never has two pairs in the air, so the older answer cannot land
 * last at all. These cases pin the property rather than either mechanism: a refetch asked mid-flight is answered by a pair REQUESTED after it, and that
 * pair's answer is what state is left holding.
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

function tagOf(items: ItemsIndex | null): string | undefined {
  return (items as unknown as { generatedAt: string } | null)?.generatedAt;
}

// No tracker project, so no timer is ever armed: every request below is one the test caused.
const PROJECTS: ProjectSummary[] = [];

const realFetch = global.fetch;

describe('useBoard', () => {
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('a refetch during a flight starts nothing, and the follow-up asked after it is the answer state is left holding', async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useBoard());
    // The mount read is pair 0; a refetch while it is out queues behind it instead of racing it.
    expect(pending).toHaveLength(2);
    act(() => result.current.refetch());
    expect(pending).toHaveLength(2);

    // The older pair answers; only then does the follow-up go out.
    await act(async () => {
      pending[0].resolve(index('old'));
      pending[1].resolve(PROJECTS);
    });
    await waitFor(() => expect(pending).toHaveLength(4));
    expect(tagOf(result.current.items)).toBe('old');

    await act(async () => {
      pending[2].resolve(index('new'));
      pending[3].resolve(PROJECTS);
    });
    await waitFor(() => expect(tagOf(result.current.items)).toBe('new'));
    expect(result.current.error).toBe(false);
    expect(pending).toHaveLength(4);
  });

  it('an older read that fails lands before the follow-up, so the follow-up clears error rather than being covered by it', async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useBoard());
    act(() => result.current.refetch());

    await act(async () => {
      pending[0].reject(new Error('network'));
    });
    await waitFor(() => expect(pending).toHaveLength(4));

    await act(async () => {
      pending[2].resolve(index('new'));
      pending[3].resolve(PROJECTS);
    });
    await waitFor(() => expect(tagOf(result.current.items)).toBe('new'));
    expect(result.current.error).toBe(false);
  });
});
