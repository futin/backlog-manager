/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { JiraContext, JiraProvider, useJiraContext } from '../client/src/hooks/JiraContext';
import { BOARD_TRACKER_POLL_MS } from '../client/src/hooks/useBoard';
import { JIRA_STATUS_FLOOR_MS, useJira } from '../client/src/hooks/useJira';
import { useJiraBoard } from '../client/src/hooks/useJiraBoard';
import { TRACKER_FETCH_SLACK_MS } from '../client/src/hooks/useTrackers';
import type { JiraBoardStatus, JiraIssue, JiraStatusPayload, SyncInterval } from '../shared/types';

/**
 * `useJira` on the boards' own clock (Jira phase 2): one read of `GET /api/jira` on mount and on focus, then exactly one pending timer aimed at
 * the soonest board's next poll, plus `useJiraBoard`'s coalesced poll of one board's list. Fake timers throughout; every fetch is counted and every
 * date is relative to the clock the assertion runs under.
 */

const NOW = Date.parse('2026-10-16T12:00:00Z');

function board(over: Partial<JiraBoardStatus> = {}): JiraBoardStatus {
  return { id: 'b_00000001', name: 'Board', roots: ['AB-1'], queries: [], interval: '1m', polledAt: null, count: 0, truncated: false, failures: [], ...over };
}

function boardPolled(agoMs: number, interval: SyncInterval = '1m'): JiraBoardStatus {
  return board({ interval, polledAt: new Date(Date.now() - agoMs).toISOString() });
}

function status(boards: JiraBoardStatus[], over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'x.atlassian.net',
    me: { accountId: 'a1', name: 'Ada' },
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards,
    repos: {},
    projects: [],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/home/x',
    ...over
  };
}

const answer = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetchMock: jest.Mock;

function Probe() {
  const { data, error, loading } = useJira();
  return <span data-testid="p">{`${data?.site ?? 'none'}|${error}|${loading}`}</span>;
}

function ContextProbe({ testId }: { testId: string }) {
  const { data } = useJiraContext();
  return <span data-testid={testId}>{data?.site ?? 'none'}</span>;
}

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

const jiraCalls = (): number => fetchMock.mock.calls.filter(([url]) => url === '/api/jira').length;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  fetchMock = jest.fn(() => answer(status([boardPolled(10_000)])));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useJira', () => {
  it('fetches /api/jira once on mount', async () => {
    render(<Probe />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/jira');
    expect(screen.getByTestId('p')).toHaveTextContent('x.atlassian.net|false|false');
  });

  it('refetches on focus at once and leaves exactly one pending timer', async () => {
    render(<Probe />);
    await flush();
    expect(jest.getTimerCount()).toBe(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('aims the next fetch at the soonest board polled-at plus its interval plus the slack', async () => {
    // A 1m board polled 10 s ago: 50 s to its next poll, then the slack.
    const due = 50_000 + TRACKER_FETCH_SLACK_MS;
    render(<Probe />);
    await flush();
    await advance(due - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('floors the schedule at JIRA_STATUS_FLOOR_MS when the deadline is nearer than that', async () => {
    // Polled 55 s ago: the deadline is 5.5 s away, below the 15 s floor.
    fetchMock.mockImplementation(() => answer(status([boardPolled(55_000)])));
    render(<Probe />);
    await flush();
    await advance(JIRA_STATUS_FLOOR_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('floors a board that has never polled — it is due now, and asking faster than the floor learns nothing', async () => {
    fetchMock.mockImplementation(() => answer(status([board({ polledAt: null })])));
    render(<Probe />);
    await flush();
    await advance(JIRA_STATUS_FLOOR_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('arms no timer at all when every board is off', async () => {
    fetchMock.mockImplementation(() => answer(status([boardPolled(1_000, 'off'), board({ id: 'b_00000002', interval: 'off' })])));
    render(<Probe />);
    await flush();
    expect(jest.getTimerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('arms no timer when there are no boards', async () => {
    fetchMock.mockImplementation(() => answer(status([])));
    render(<Probe />);
    await flush();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('arms no timer while unconfigured', async () => {
    fetchMock.mockImplementation(() => answer(status([boardPolled(10_000)], { configured: false, armed: false, home: null })));
    render(<Probe />);
    await flush();
    expect(jest.getTimerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous data, raises error and retries at the floor when a fetch fails', async () => {
    render(<Probe />);
    await flush();
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('x.atlassian.net|true|false');
    expect(jest.getTimerCount()).toBe(1);
    const before = fetchMock.mock.calls.length;
    await advance(JIRA_STATUS_FLOOR_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);
  });

  it('treats a wrong-shaped 200 as a failed read, keeping nothing from it', async () => {
    fetchMock.mockImplementation(() => answer({ configured: true }));
    render(<Probe />);
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('none|true|false');
  });

  it('lets only the newest read write when two reloads settle in reverse order', async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Probe />);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve({ ok: true, status: 200, json: () => Promise.resolve(status([boardPolled(1_000)], { site: 'new.atlassian.net' })) } as Response);
    });
    await flush();
    await act(async () => {
      first.resolve({ ok: true, status: 200, json: () => Promise.resolve(status([boardPolled(5_000)], { site: 'old.atlassian.net' })) } as Response);
    });
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('new.atlassian.net|false|false');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('lets a late failure of a superseded read raise nothing over a newer good answer', async () => {
    const first = deferred();
    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(first.promise).mockImplementationOnce(() => answer(status([boardPolled(1_000)], { site: 'new.atlassian.net' })));
    render(<Probe />);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    await act(async () => {
      first.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response);
    });
    await flush();
    expect(screen.getByTestId('p')).toHaveTextContent('new.atlassian.net|false|false');
  });
});

describe('JiraProvider', () => {
  it('hands one instance to every reader — one fetch, however many consumers', async () => {
    render(
      <JiraProvider>
        <ContextProbe testId="a" />
        <ContextProbe testId="b" />
      </JiraProvider>
    );
    await flush();
    expect(jiraCalls()).toBe(1);
    expect(screen.getByTestId('a')).toHaveTextContent('x.atlassian.net');
    expect(screen.getByTestId('b')).toHaveTextContent('x.atlassian.net');
  });

  it('draws the loading default without a provider and never fetches', async () => {
    render(<ContextProbe testId="a" />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('a')).toHaveTextContent('none');
  });
});

function issue(key: string): JiraIssue {
  return {
    key,
    id: key,
    url: `https://x.atlassian.net/browse/${key}`,
    summary: `Summary ${key}`,
    project: { key: 'AB', name: 'Ab' },
    type: { name: 'Task', level: 0, subtask: false },
    status: { name: 'To Do', category: 'new' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: new Date(Date.now() - 86_400_000).toISOString(),
    updated: new Date(Date.now() - 3_600_000).toISOString(),
    resolved: null
  };
}

let boardFetch: jest.Mock;
const boardUrl = (id: string): string => `/api/jira/boards/${id}/issues`;
const listFor = (id: string) => ({ issues: [issue(`${id.toUpperCase()}-1`)], polledAt: new Date(Date.now() - 2_000).toISOString() });

function BoardProbe({ id, interval }: { id: string | null; interval: SyncInterval | null }) {
  const { issues, polledAt, loading, error, reload } = useJiraBoard(id, interval);
  return (
    <div>
      <span data-testid="b">{`${issues.map((i) => i.key).join(',') || 'empty'}|${polledAt === null ? 'null' : 'stamp'}|${loading}|${error}`}</span>
      <button onClick={() => void reload()}>reload</button>
    </div>
  );
}

describe('useJiraBoard', () => {
  beforeEach(() => {
    boardFetch = jest.fn((url: string) => answer(listFor(url.split('/')[4])));
    global.fetch = boardFetch as unknown as typeof fetch;
  });

  it('fetches the board list on mount and again at BOARD_TRACKER_POLL_MS', async () => {
    render(<BoardProbe id="b_1" interval="1m" />);
    await flush();
    expect(boardFetch).toHaveBeenCalledTimes(1);
    expect(boardFetch).toHaveBeenCalledWith(boardUrl('b_1'));
    expect(screen.getByTestId('b')).toHaveTextContent('B_1-1|stamp|false|false');
    await advance(BOARD_TRACKER_POLL_MS - 1);
    expect(boardFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(boardFetch).toHaveBeenCalledTimes(2);
    await advance(BOARD_TRACKER_POLL_MS);
    expect(boardFetch).toHaveBeenCalledTimes(3);
  });

  it('fetches once and never again with interval off', async () => {
    render(<BoardProbe id="b_1" interval="off" />);
    await flush();
    await advance(10 * 60_000);
    expect(boardFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing for a null id', async () => {
    render(<BoardProbe id={null} interval="1m" />);
    await flush();
    await advance(10 * 60_000);
    expect(boardFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('b')).toHaveTextContent('empty|null|false|false');
  });

  it('fetches the new board at once when the id changes, never showing the old board under the new id', async () => {
    const { rerender } = render(<BoardProbe id="b_1" interval="1m" />);
    await flush();
    const slow = deferred();
    boardFetch.mockImplementation(() => slow.promise);
    rerender(<BoardProbe id="b_2" interval="1m" />);
    await flush();
    expect(boardFetch).toHaveBeenLastCalledWith(boardUrl('b_2'));
    expect(screen.getByTestId('b')).toHaveTextContent('empty|null|true|false');
    await act(async () => {
      slow.resolve({ ok: true, status: 200, json: () => Promise.resolve(listFor('b_2')) } as Response);
    });
    await flush();
    expect(screen.getByTestId('b')).toHaveTextContent('B_2-1|stamp|false|false');
  });

  it('drops a late answer for the board the id has left', async () => {
    const old = deferred();
    boardFetch.mockImplementationOnce(() => old.promise);
    const { rerender } = render(<BoardProbe id="b_1" interval="1m" />);
    await flush();
    rerender(<BoardProbe id="b_2" interval="1m" />);
    await flush();
    await act(async () => {
      old.resolve({ ok: true, status: 200, json: () => Promise.resolve(listFor('b_1')) } as Response);
    });
    await flush();
    expect(boardFetch).toHaveBeenLastCalledWith(boardUrl('b_2'));
    expect(screen.getByTestId('b')).toHaveTextContent('B_2-1|stamp|false|false');
  });

  it('reload() fetches at once whatever the interval', async () => {
    render(<BoardProbe id="b_1" interval="off" />);
    await flush();
    await act(async () => {
      screen.getByText('reload').click();
    });
    await flush();
    expect(boardFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the last list and raises error on a failed poll', async () => {
    render(<BoardProbe id="b_1" interval="1m" />);
    await flush();
    boardFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response));
    await advance(BOARD_TRACKER_POLL_MS);
    expect(screen.getByTestId('b')).toHaveTextContent('B_1-1|stamp|false|true');
  });

  it('asks for an id percent-encoded, as the modal does', async () => {
    render(<BoardProbe id="b/1 x" interval="1m" />);
    await flush();
    expect(boardFetch).toHaveBeenCalledWith('/api/jira/boards/b%2F1%20x/issues');
  });

  // A 404 is a board deleted in another browser: the shell's status is re-read at once (so the page falls to the next board), and a plain failure is not.
  it('re-reads the shell status on a 404 from the list, and on no other failure', async () => {
    const reload = jest.fn();
    const withShell = (id: string) => (
      <JiraContext.Provider value={{ data: null, loading: false, error: false, reload }}>
        <BoardProbe id={id} interval="1m" />
      </JiraContext.Provider>
    );
    boardFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response));
    const { rerender } = render(withShell('b_1'));
    await flush();
    expect(screen.getByTestId('b')).toHaveTextContent('empty|null|false|true');
    expect(reload).not.toHaveBeenCalled();

    boardFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
    rerender(withShell('b_2'));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('b')).toHaveTextContent('empty|null|false|true');
  });

  it('has at most one request of its own in flight when a poll tick lands mid-flight', async () => {
    const slow = deferred();
    boardFetch.mockImplementationOnce(() => slow.promise);
    render(<BoardProbe id="b_1" interval="1m" />);
    await flush();
    await act(async () => {
      screen.getByText('reload').click();
      screen.getByText('reload').click();
    });
    expect(boardFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      slow.resolve({ ok: true, status: 200, json: () => Promise.resolve(listFor('b_1')) } as Response);
    });
    await flush();
    // The two clicks folded into ONE follow-up.
    expect(boardFetch).toHaveBeenCalledTimes(2);
  });
});
