/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { JiraContext } from '../../client/src/hooks/JiraContext';
import { JIRA_STATUS_FLOOR_MS } from '../../client/src/hooks/useJira';
import { JIRA_REPLY_REREAD_MS, useJiraMentions } from '../../client/src/hooks/useJiraMentions';
import { TRACKER_FETCH_SLACK_MS } from '../../client/src/hooks/useTrackers';
import type { JiraMentionIssue, JiraMentionsPayload, JiraStatusPayload } from '../../shared/types';

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
let statusReload: jest.Mock;

function Probe() {
  last = useJiraMentions();
  const d = last.data;
  return <span data-testid="p">{`${d === null ? 'none' : d.configured ? `ok:${d.me}` : 'off'}|${last.checking}|${last.error?.message ?? ''}`}</span>;
}

const tree = () => (
  <JiraContext.Provider value={{ data: { access } as JiraStatusPayload, loading: false, error: false, reload: statusReload }}>
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
  statusReload = jest.fn();
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

  it('reads the floor for a cache that was never stamped', async () => {
    fetchMock.mockImplementation(() => res(payload({ polledAt: null })));
    render(tree());
    await flush();
    await advance(JIRA_STATUS_FLOOR_MS - 1);
    expect(calls()).toBe(1);
    await advance(1);
    expect(calls()).toBe(2);
  });

  // The header's other half of "newest read wins": a POST's answer takes a sequence number, so a GET that was already out when the write was sent cannot
  // land over the write's newer answer when it finally settles.
  it('lets a write that settles first retire a read that was in flight before it', async () => {
    render(tree());
    await flush();
    const stale = deferred();
    fetchMock.mockImplementation((u: string, init?: RequestInit) =>
      init === undefined ? stale.promise : u === '/api/jira/mentions/dismiss' ? res(payload({ me: 'dismissed' })) : res(payload())
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(calls()).toBe(2);
    await act(async () => {
      await last.dismiss('PAY-1', ['10']);
    });
    expect(screen.getByTestId('p')).toHaveTextContent('ok:dismissed');
    await act(async () => {
      stale.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload({ me: 'stale' })) } as Response);
    });
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('ok:dismissed');
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

  it('a successful write re-reads the shell status, so the rail and popover counts follow the page; a refused one does not', async () => {
    render(tree());
    await flush();
    expect(statusReload).not.toHaveBeenCalled();
    fetchMock.mockImplementation(() => res(payload({ me: 'dismissed' })));
    await act(async () => {
      await last.dismiss('PAY-1', ['10']);
    });
    expect(statusReload).toHaveBeenCalledTimes(1);
    await act(async () => {
      await last.restore('PAY-1');
    });
    await act(async () => {
      await last.sweep();
    });
    expect(statusReload).toHaveBeenCalledTimes(3);
    fetchMock.mockImplementation(() => res({ error: 'nope' }, 400));
    await act(async () => {
      await last.dismiss('PAY-1', ['10']);
    });
    expect(statusReload).toHaveBeenCalledTimes(3);
  });

  it('ignores a second dismiss or restore for a key whose write is still out', async () => {
    render(tree());
    await flush();
    const d = deferred();
    fetchMock.mockImplementation(() => d.promise);
    let first!: Promise<unknown>;
    let second: unknown;
    await act(async () => {
      first = last.dismiss('PAY-1', ['10']);
      second = await last.dismiss('PAY-1', ['10']);
    });
    expect(second).toEqual({ ok: true });
    const posts = () => fetchMock.mock.calls.filter(([, init]) => init !== undefined).length;
    expect(posts()).toBe(1);
    await act(async () => {
      d.resolve(await res(payload()) as unknown as Response);
      await first;
    });
    fetchMock.mockImplementation(() => res(payload()));
    await act(async () => {
      await last.dismiss('PAY-1', ['10']);
    });
    expect(posts()).toBe(2);
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
  const issueRow = { key: 'PAY-1', summary: 's', type: 'Bug', status: { name: 'To Do', category: 'new' }, boards: [], mentions: [], draft: null, session: null };

  it('postReply: a 200 replaces data (the ticket gone) and resolves ok with the posted comment', async () => {
    fetchMock.mockImplementation((u: string, init?: RequestInit) => res(init === undefined ? payload({ issues: [issueRow] as never }) : { ...payload({ me: 'posted' }), posted: { id: '5', url: 'https://x/5' } }));
    render(tree());
    await flush();
    let out: unknown;
    await act(async () => {
      out = await last.postReply('PAY-1', 'Thanks');
    });
    expect(out).toEqual({ ok: true, posted: { id: '5', url: 'https://x/5' } });
    expect(screen.getByTestId('p')).toHaveTextContent('ok:posted');
    expect(statusReload).toHaveBeenCalled();
  });

  it('postReply: a 409 resolves { ok: false, message } with data unchanged and error set', async () => {
    render(tree());
    await flush();
    fetchMock.mockImplementation(() => res({ error: 'a reply to PAY-1 is already being posted' }, 409));
    let out: unknown;
    await act(async () => {
      out = await last.postReply('PAY-1', 'Thanks');
    });
    expect(out).toEqual({ ok: false, message: 'a reply to PAY-1 is already being posted' });
    expect(last.error?.message).toBe('a reply to PAY-1 is already being posted');
    expect(screen.getByTestId('p')).toHaveTextContent('ok:Ada');
  });

  it('postReply: a 503 rate-limit answer carries its retryAt into error', async () => {
    render(tree());
    await flush();
    const until = new Date(Date.now() + 60_000).toISOString();
    fetchMock.mockImplementation(() => res({ error: 'Jira asked to wait', retryAt: until }, 503));
    await act(async () => {
      await last.postReply('PAY-1', 'Thanks');
    });
    expect(last.error).toMatchObject({ message: 'Jira asked to wait', retryAt: until, status: 503 });
  });

  it('postReply: two calls for one key while the first is out send ONE request and both resolve the same outcome', async () => {
    render(tree());
    await flush();
    const d = deferred();
    fetchMock.mockImplementation(() => d.promise);
    let a: Promise<unknown> = Promise.resolve();
    let b: Promise<unknown> = Promise.resolve();
    await act(async () => {
      a = last.postReply('PAY-1', 'Thanks');
      b = last.postReply('PAY-1', 'Thanks');
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init !== undefined)).toHaveLength(1);
    await act(async () => {
      d.resolve(await res({ error: 'nope' }, 409));
    });
    expect(await a).toEqual({ ok: false, message: 'nope' });
    expect(await b).toEqual({ ok: false, message: 'nope' });
  });

  it('discardDraft posts the key and replaces data with the answer', async () => {
    render(tree());
    await flush();
    fetchMock.mockImplementation(() => res(payload({ me: 'discarded' })));
    await act(async () => {
      await last.discardDraft('PAY-1');
    });
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe('/api/jira/mentions/draft/discard');
    expect(JSON.parse(init.body as string)).toEqual({ key: 'PAY-1' });
    expect(screen.getByTestId('p')).toHaveTextContent('ok:discarded');
  });

  it('re-reads every 15 s while a shown ticket carries a reply session, and goes back to the server’s clock once none does', async () => {
    // Task 8: the drafting session hands its draft over between two mentions checks, so while any ticket (open or dismissed) has a `session` the ONE timer
    // is aimed at JIRA_REPLY_REREAD_MS instead of the 3-minute clock. It is the same `reload`, so the sequence counter still lets a POST win.
    const issue = (session: JiraMentionIssue['session']): JiraMentionIssue => ({
      key: 'SUP-1',
      summary: 's',
      type: 'Bug',
      status: { name: 'Open', category: 'new' },
      boards: [],
      mentions: [],
      draft: null,
      session
    });
    const live = { sessionId: 'sess-1', startedAt: iso(30_000), repo: '/r' };
    fetchMock.mockImplementation(() => res(payload({ dismissed: [issue(live)] })));
    render(tree());
    await flush();
    expect(calls()).toBe(1);
    await advance(JIRA_REPLY_REREAD_MS - 1);
    expect(calls()).toBe(1);
    fetchMock.mockImplementation(() => res(payload({ dismissed: [issue(null)] })));
    await advance(1);
    expect(calls()).toBe(2);
    // No session left: the next read waits for the server's clock again (polled 10 s ago → 170 s + slack).
    await advance(JIRA_REPLY_REREAD_MS);
    expect(calls()).toBe(2);
    await advance(170_000 + TRACKER_FETCH_SLACK_MS - JIRA_REPLY_REREAD_MS);
    expect(calls()).toBe(3);
  });
});
