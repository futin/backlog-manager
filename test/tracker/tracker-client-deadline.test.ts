import { GITHUB_TIMEOUT_MS, GithubClient } from '../../server/src/tracker/github.client';

/**
 * The deadline on every GitHub call (#584). Before it, `request()` passed no signal, so a stalled request — a half-open socket, a slow secondary-limit
 * answer — waited out undici's 300 s defaults while the poller's sweep, a board Sync and every queued write on that issue waited behind it. The Jira and
 * GitLab clients' shape, and their test shape: fake timers, a `fetch` that never settles, the bound reached and not before.
 */

const TOKEN = 'ghp_fake';
const REPO = 'futin/x';

afterEach(() => {
  jest.useRealTimers();
});

/** A `fetch` that records the signal it was handed and never answers. */
function never(): { fetch: typeof fetch; signals: (AbortSignal | undefined)[] } {
  const signals: (AbortSignal | undefined)[] = [];
  const impl = (_url: string, init?: RequestInit): Promise<Response> => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>(() => undefined);
  };
  return { fetch: impl as unknown as typeof fetch, signals };
}

describe('the deadline', () => {
  it('is the ten seconds the Jira and GitLab clients use', () => {
    expect(GITHUB_TIMEOUT_MS).toBe(10_000);
  });

  it('a fetch that never resolves ends as status 0 "timed out after 10000 ms", and the signal is aborted', async () => {
    jest.useFakeTimers();
    const { fetch, signals } = never();
    const pending = new GithubClient(fetch).labels(REPO, { token: TOKEN });
    await jest.advanceTimersByTimeAsync(GITHUB_TIMEOUT_MS);
    const res = await pending;
    expect(res.status).toBe(0);
    expect(res.data).toBeNull();
    expect(res.error).toBe('timed out after 10000 ms');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('does not fire early', async () => {
    jest.useFakeTimers();
    let settled = false;
    const pending = new GithubClient(never().fetch).labels(REPO, { token: TOKEN }).then((r) => {
      settled = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(GITHUB_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(0);
  });

  it('bounds the body too: headers that land and a body that never does still end as a timeout, with the rate headers recorded', async () => {
    jest.useFakeTimers();
    const impl = async (): Promise<Response> =>
      ({
        status: 200,
        ok: true,
        headers: new Headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1' }),
        text: () => new Promise<string>(() => undefined)
      }) as unknown as Response;
    const client = new GithubClient(impl as unknown as typeof fetch);
    const pending = client.labels(REPO, { token: TOKEN });
    await jest.advanceTimersByTimeAsync(GITHUB_TIMEOUT_MS);
    const res = await pending;
    expect(res.status).toBe(0);
    expect(res.error).toBe('timed out after 10000 ms');
    expect(client.rate.remaining).toBe(4999);
  });

  it('clears the timer when the response lands', async () => {
    jest.useFakeTimers();
    const impl = async (): Promise<Response> => new Response('[]', { status: 200 });
    const res = await new GithubClient(impl as unknown as typeof fetch).labels(REPO, { token: TOKEN });
    expect(res.status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timer on a 304, which reads no body', async () => {
    jest.useFakeTimers();
    const impl = async (): Promise<Response> => new Response(null, { status: 304 });
    const res = await new GithubClient(impl as unknown as typeof fetch).issues(REPO, { token: TOKEN, etag: 'W/"a"' });
    expect(res.status).toBe(304);
    expect(jest.getTimerCount()).toBe(0);
  });
});
