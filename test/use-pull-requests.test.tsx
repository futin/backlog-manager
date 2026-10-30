/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { PRS_POLL_MS, usePullRequests } from '../client/src/hooks/usePullRequests';
import { fetchPullRequests, mergePr, updateBranch } from '../client/src/lib/prs-api';
import type { PullRequestsPayload } from '../shared/types';

/**
 * `usePullRequests` and `prs-api` (GitHub › PRs, task 6): one read on mount, one a minute later and none sooner, none after unmount, two refreshes during one
 * flight folding into one follow-up, a failed read keeping the last rows, and a refused write carrying the server's own sentence. Same posture as
 * `test/machines-hook.test.tsx`: jsdom, fake timers, a per-suite fetch stub.
 */

function payload(repo: string): PullRequestsPayload {
  return {
    token: true,
    repos: [
      {
        repo,
        polledAt: '2026-10-29T10:00:00Z',
        access: 'ok',
        detail: null,
        syncOff: null,
        methods: ['squash'],
        autoMergeAllowed: true,
        prs: [],
        total: 0,
        truncated: false
      }
    ]
  };
}

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const realFetch = global.fetch;

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('usePullRequests', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('reads once on mount, again at 60 s and not at 59 s', async () => {
    const fn = jest.fn(() => Promise.resolve(res(200, payload('futin/x'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => usePullRequests());

    expect(PRS_POLL_MS).toBe(60_000);
    expect(result.current.data).toBeNull();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('/api/prs');
    expect(result.current.data).toEqual(payload('futin/x'));

    await advance(59_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops reading when the page unmounts', async () => {
    const fn = jest.fn(() => Promise.resolve(res(200, payload('futin/x'))));
    global.fetch = fn as unknown as typeof fetch;
    const { unmount } = renderHook(() => usePullRequests());
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);

    unmount();
    await advance(120_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('folds two refreshes during one flight into one follow-up', async () => {
    let release: (r: Response) => void = () => {};
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(res(200, payload('futin/x'))))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)))
      .mockImplementation(() => Promise.resolve(res(200, payload('futin/y'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => usePullRequests());
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.refresh();
      void result.current.refresh();
      void result.current.refresh();
    });
    expect(fn).toHaveBeenCalledTimes(2); // one in flight, the other two queued behind it

    await act(async () => {
      release(res(200, payload('futin/x')));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(fn).toHaveBeenCalledTimes(3); // exactly one follow-up for the two that arrived mid-flight
    expect(result.current.data).toEqual(payload('futin/y'));
  });

  it('keeps the last data when a later read fails, and says why', async () => {
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(res(200, payload('futin/x'))))
      .mockImplementation(() => Promise.resolve(res(500, { error: 'GitHub is having a day' })));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => usePullRequests());
    await flush();
    expect(result.current.error).toBeNull();

    await advance(PRS_POLL_MS);
    expect(result.current.data).toEqual(payload('futin/x'));
    expect(result.current.error).toBe('GitHub is having a day');
  });

  it('clears the error when the next read succeeds', async () => {
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(res(500, null)))
      .mockImplementation(() => Promise.resolve(res(200, payload('futin/y'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => usePullRequests());
    await flush();
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe('could not read pull requests (500)');

    await advance(PRS_POLL_MS);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(payload('futin/y'));
  });

  it('refresh resolves the payload it stored, so a caller can judge the re-read it just awaited', async () => {
    // The mount read and the refresh answer different repos, so a resolved value that is really the stale `data` (or the mount's payload) cannot pass.
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(res(200, payload('futin/mounted'))))
      .mockImplementation(() => Promise.resolve(res(200, payload('futin/refreshed'))));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => usePullRequests());
    await flush();
    expect(result.current.data).toEqual(payload('futin/mounted'));

    let resolved: PullRequestsPayload | null | undefined;
    await act(async () => {
      resolved = await result.current.refresh();
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(resolved).toEqual(payload('futin/refreshed'));
    expect(result.current.data).toEqual(resolved);
    expect(result.current.error).toBeNull();
  });

  it('refresh resolves null when the read rejects, with the rejection already in error and the last data kept', async () => {
    const fn = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(res(200, payload('futin/mounted'))))
      .mockImplementation(() => Promise.reject(new Error('stub: the refresh could not connect')));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => usePullRequests());
    await flush();
    expect(result.current.data).toEqual(payload('futin/mounted'));

    let resolved: PullRequestsPayload | null | undefined;
    await act(async () => {
      resolved = await result.current.refresh();
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(resolved).toBeNull();
    expect(result.current.error).toBe('stub: the refresh could not connect');
    expect(result.current.data).toEqual(payload('futin/mounted'));
  });
});

describe('prs-api', () => {
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('rejects a refused merge with the server sentence, verbatim', async () => {
    const sentence = 'head moved: expected a1b2c3 but the PR is at d4e5f6 — reload the page';
    const fn = jest.fn(() => Promise.resolve(res(409, { error: sentence })));
    global.fetch = fn as unknown as typeof fetch;

    await expect(mergePr({ repo: 'futin/x', number: 17, method: 'squash', headSha: 'a'.repeat(40) })).rejects.toThrow(new Error(sentence));
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/prs/merge');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ repo: 'futin/x', number: 17, method: 'squash', headSha: 'a'.repeat(40) });
  });

  it('falls back to the status when the refusal carries no sentence, and resolves the write result otherwise', async () => {
    global.fetch = jest.fn(() => Promise.resolve(res(502, null))) as unknown as typeof fetch;
    await expect(fetchPullRequests()).rejects.toThrow('could not read pull requests (502)');

    const ok = { ok: true, outcome: 'merged', pr: null, reread: true };
    global.fetch = jest.fn(() => Promise.resolve(res(200, ok))) as unknown as typeof fetch;
    await expect(mergePr({ repo: 'futin/y', number: 3, method: 'merge', headSha: 'b'.repeat(40) })).resolves.toEqual(ok);
  });

  it('a 200 whose body is not a write result goes down the error path, never resolving a garbage outcome', async () => {
    // A proxy's HTML page: the body does not parse as JSON at all.
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) } as Response)
    ) as unknown as typeof fetch;
    await expect(mergePr({ repo: 'futin/x', number: 17, method: 'squash', headSha: 'a'.repeat(40) })).rejects.toThrow('merge failed (200)');

    // JSON, but not ours: an outcome this page has no word for.
    global.fetch = jest.fn(() => Promise.resolve(res(200, { ok: true, outcome: 'exploded', pr: null, reread: true }))) as unknown as typeof fetch;
    await expect(updateBranch({ repo: 'futin/y', number: 3, headSha: 'b'.repeat(40) })).rejects.toThrow('update branch failed (200)');
  });
});
