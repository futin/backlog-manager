/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { JiraContext } from '../../client/src/hooks/JiraContext';
import { JIRA_STATUS_FLOOR_MS } from '../../client/src/hooks/useJira';
import { useJiraMentions } from '../../client/src/hooks/useJiraMentions';
import { TRACKER_FETCH_SLACK_MS } from '../../client/src/hooks/useTrackers';
import type { JiraMentionsPayload, JiraStatusPayload } from '../../shared/types';

/** `useJiraMentions` on the server's clock: one timer at polledAt + the poll + slack, floored; focus refetch; newest read wins; no timer unconfigured. */

const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();

function payload(over: Partial<Extract<JiraMentionsPayload, { configured: true }>> = {}): JiraMentionsPayload {
  return { configured: true, polledAt: iso(10_000), detail: null, truncated: false, retryAt: null, window: 30, me: 'Ada', issues: [], dismissed: [], ...over };
}

const res = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

let fetchMock: jest.Mock;
let last: ReturnType<typeof useJiraMentions>;
let access: JiraStatusPayload['access'] = 'ok';

function Probe() {
  last = useJiraMentions();
  const d = last.data;
  return <span data-testid="p">{`${d === null ? 'none' : d.configured ? `ok:${d.me}` : 'off'}|${last.checking}|${last.error?.message ?? ''}`}</span>;
}

const tree = () => (
  <JiraContext.Provider value={{ data: { access } as JiraStatusPayload, loading: false, error: false, reload: () => {} }}>
    <Probe />
  </JiraContext.Provider>
);

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}
const calls = (): number => fetchMock.mock.calls.filter(([u, init]) => u === '/api/jira/mentions' && init === undefined).length;

beforeEach(() => {
  jest.useFakeTimers();
  access = 'ok';
  fetchMock = jest.fn(() => res(payload()));
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => jest.useRealTimers());

describe('useJiraMentions', () => {
  it('reads once on mount and aims the next read at polledAt + the poll + the slack', async () => {
    render(tree());
    await flush();
    expect(calls()).toBe(1);
    // polled 10 s ago: 170 s to go, then the slack.
    const due = 170_000 + TRACKER_FETCH_SLACK_MS;
    await advance(due - 1);
    expect(calls()).toBe(1);
    await advance(1);
    expect(calls()).toBe(2);
  });

  it('arms no timer while unconfigured', async () => {
    fetchMock.mockImplementation(() => res({ configured: false, detail: null }));
    render(tree());
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('off');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('floors a near deadline at JIRA_STATUS_FLOOR_MS, not at the slack', async () => {
    fetchMock.mockImplementation(() => res(payload({ polledAt: iso(179_000) })));
    render(tree());
    await flush();
    await advance(TRACKER_FETCH_SLACK_MS + 1_000);
    expect(calls()).toBe(1);
    await advance(JIRA_STATUS_FLOOR_MS - TRACKER_FETCH_SLACK_MS - 1_000);
    expect(calls()).toBe(2);
  });

  it('refetches on focus and keeps one timer', async () => {
    render(tree());
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(calls()).toBe(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('lets a slower first read answer after a faster second without overwriting it', async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(tree());
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      second.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload({ me: 'new' })) } as Response);
    });
    await flush();
    await act(async () => {
      first.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload({ me: 'old' })) } as Response);
    });
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('ok:new');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('keeps the last answer on a failed read, raises error and retries at the floor', async () => {
    render(tree());
    await flush();
    fetchMock.mockImplementation(() => res({ error: 'x' }, 500));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('ok:Ada');
    expect(last.error).not.toBeNull();
    await advance(JIRA_STATUS_FLOOR_MS);
    expect(calls()).toBe(3);
  });

  it('checking is true before the first stamp and false once blocked by access or retryAt', async () => {
    fetchMock.mockImplementation(() => res(payload({ polledAt: null })));
    const { rerender } = render(tree());
    await flush();
    expect(last.checking).toBe(true);
    access = 'unauthorized';
    rerender(tree());
    expect(last.checking).toBe(false);
    access = 'ok';
    fetchMock.mockImplementation(() => res(payload({ polledAt: null, retryAt: iso(-60_000) })));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(last.checking).toBe(false);
  });

  it('sweep posts, is checking meanwhile, and replaces data with the answer', async () => {
    render(tree());
    await flush();
    const d = deferred();
    fetchMock.mockImplementation((u: string) => (u === '/api/jira/mentions/sweep' ? d.promise : res(payload())));
    let p!: Promise<void>;
    await act(async () => {
      p = last.sweep();
    });
    expect(last.checking).toBe(true);
    await act(async () => {
      d.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload({ me: 'swept' })) } as Response);
      await p;
    });
    expect(last.checking).toBe(false);
    expect(screen.getByTestId('p')).toHaveTextContent('ok:swept');
    const post = fetchMock.mock.calls.find(([u]) => u === '/api/jira/mentions/sweep');
    expect(post?.[1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  });

  it('a 429 sweep surfaces its message and retryAt through error and keeps data', async () => {
    render(tree());
    await flush();
    const until = iso(-60_000);
    fetchMock.mockImplementation(() => res({ message: 'rate limited', retryAt: until }, 429));
    await act(async () => {
      await last.sweep();
    });
    expect(last.error).toEqual({ message: 'rate limited', retryAt: until, status: 429 });
    expect(screen.getByTestId('p')).toHaveTextContent('ok:Ada');
  });

  it('a 409 sweep surfaces its message', async () => {
    render(tree());
    await flush();
    fetchMock.mockImplementation(() => res({ message: 'Jira is not being polled' }, 409));
    await act(async () => {
      await last.sweep();
    });
    expect(last.error?.message).toBe('Jira is not being polled');
    expect(last.error?.retryAt).toBeNull();
  });

  it('dismiss and restore post their bodies and replace data with the answer; a refusal reads its error sentence', async () => {
    render(tree());
    await flush();
    fetchMock.mockImplementation(() => res(payload({ me: 'dismissed' })));
    await act(async () => {
      await last.dismiss('PAY-1', ['10', '11']);
    });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({ key: 'PAY-1', commentIds: ['10', '11'] });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/jira/mentions/dismiss');
    expect(screen.getByTestId('p')).toHaveTextContent('ok:dismissed');
    fetchMock.mockImplementation(() => res(payload({ me: 'restored' })));
    await act(async () => {
      await last.restore('PAY-1');
    });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({ key: 'PAY-1' });
    expect(screen.getByTestId('p')).toHaveTextContent('ok:restored');
    fetchMock.mockImplementation(() => res({ error: 'could not save — nothing changed' }, 500));
    await act(async () => {
      await last.restore('PAY-1');
    });
    expect(last.error?.message).toBe('could not save — nothing changed');
  });

  it('dismiss and restore resolve their own outcome — ok, or the refusal sentence — so a caller over the band can say it; they never reject', async () => {
    render(tree());
    await flush();
    fetchMock.mockImplementation(() => res(payload({ me: 'dismissed' })));
    let outcome: unknown;
    await act(async () => {
      outcome = await last.dismiss('PAY-1', ['10']);
    });
    expect(outcome).toEqual({ ok: true });
    fetchMock.mockImplementation(() => res({ error: '10 is not an open mention on PAY-1' }, 400));
    await act(async () => {
      outcome = await last.dismiss('PAY-1', ['10']);
    });
    expect(outcome).toEqual({ ok: false, message: '10 is not an open mention on PAY-1' });
    // The band's half is unchanged: the refusal is still the hook's `error`, and the last good answer stays.
    expect(last.error?.message).toBe('10 is not an open mention on PAY-1');
    expect(screen.getByTestId('p')).toHaveTextContent('ok:dismissed');
    fetchMock.mockImplementation(() => res({ error: 'could not save — nothing changed' }, 500));
    await act(async () => {
      outcome = await last.restore('PAY-1');
    });
    expect(outcome).toEqual({ ok: false, message: 'could not save — nothing changed' });
  });
});
