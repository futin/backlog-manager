/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { useParentRead } from '../client/src/hooks/useParentRead';
import { parentLineText, parentLiveLine } from '../client/src/lib/jira-parent';
import { daysAgoStamp } from './helpers/dates';
import type { JiraIssue, JiraIssueDetail, JiraLink, JiraSessionsPayload } from '../shared/types';

/*
  The shared parent read (spec §4.1, §4.2, §7; plan Task 1) — one in-memory read per parent key, joined while pending, kept while a surface that asked is
  mounted, and never cached on failure — plus the two pure helpers the parent-live line draws from. `fetch` is mocked per URL with a deferred answer, so a
  case decides exactly when a read lands relative to a second ask, a rerender or an unmount.
*/

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    id: `1${key.replace(/\D/g, '')}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `Summary of ${key}`,
    project: { key: key.split('-')[0], name: 'Project' },
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'To Do', category: 'new' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: daysAgoStamp(3),
    updated: daysAgoStamp(1),
    resolved: null,
    ...over
  };
}

function detail(key: string): JiraIssueDetail {
  return { ...issue(key), description: '', children: [], transitions: [], boards: [], session: null };
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

/** Every URL fetched, in order, and one pending answer per request — `land(i, res)` resolves the i-th. */
let urls: string[];
let pending: ((res: Response) => void)[];
const land = async (i: number, res: Response): Promise<void> => {
  await act(async () => {
    pending[i](res);
  });
};

beforeEach(() => {
  urls = [];
  pending = [];
  global.fetch = jest.fn(
    (input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        urls.push(String(input));
        pending.push(resolve);
      })
  ) as unknown as typeof fetch;
});

describe('useParentRead — one read per parent key', () => {
  it('joins a pending read: two hooks asking for P-1 fetch once and both land the same issue', async () => {
    const a = renderHook(() => useParentRead('P-1'));
    const b = renderHook(() => useParentRead('P-1'));
    let ra: Promise<JiraIssue | null> = Promise.resolve(null);
    let rb: Promise<JiraIssue | null> = Promise.resolve(null);
    act(() => {
      ra = a.result.current.ask();
      rb = b.result.current.ask();
    });
    expect(urls).toEqual(['/api/jira/issue/P-1']);
    expect(a.result.current.read.state).toBe('loading');
    await land(0, json(detail('P-1')));
    const [ia, ib] = await Promise.all([ra, rb]);
    expect(ia?.key).toBe('P-1');
    expect(ib).toBe(ia);
    expect(a.result.current.read.state).toBe('ready');
    expect(b.result.current.read.state).toBe('ready');
  });

  it('never caches a failure: a 500 resolves null with the server sentence, and the next ask fetches again', async () => {
    const a = renderHook(() => useParentRead('P-1'));
    let r: Promise<JiraIssue | null> = Promise.resolve(null);
    act(() => {
      r = a.result.current.ask();
    });
    await land(0, json({ error: 'boom' }, 500));
    expect(await r).toBeNull();
    expect(a.result.current.read).toEqual({ state: 'failed', error: 'boom' });
    act(() => {
      void a.result.current.ask();
    });
    expect(urls).toHaveLength(2);
    expect(a.result.current.read.state).toBe('loading');
    await land(1, json(detail('P-1')));
    expect(a.result.current.read.state).toBe('ready');
  });

  it('keeps a landed read while a surface for that key is mounted, and drops it when the last one unmounts', async () => {
    const a = renderHook(() => useParentRead('P-1'));
    act(() => {
      void a.result.current.ask();
    });
    await land(0, json(detail('P-1')));
    const b = renderHook(() => useParentRead('P-1'));
    let rb: Promise<JiraIssue | null> = Promise.resolve(null);
    await act(async () => {
      rb = b.result.current.ask();
      await rb;
    });
    expect(urls).toHaveLength(1);
    expect((await rb)?.key).toBe('P-1');
    expect(b.result.current.read.state).toBe('ready');
    a.unmount();
    b.unmount();
    const c = renderHook(() => useParentRead('P-1'));
    act(() => {
      void c.result.current.ask();
    });
    expect(urls).toHaveLength(2);
    await land(1, json(detail('P-1')));
  });

  it('reads nothing on mount: a hook that never asks stays idle and fetches nothing', () => {
    const a = renderHook(() => useParentRead('P-1'));
    expect(a.result.current.read).toEqual({ state: 'idle' });
    expect(urls).toEqual([]);
  });

  it('with no parent key, ask resolves null without a fetch', async () => {
    const a = renderHook(() => useParentRead(null));
    let r: Promise<JiraIssue | null> = Promise.resolve(null);
    await act(async () => {
      r = a.result.current.ask();
      await r;
    });
    expect(await r).toBeNull();
    expect(urls).toEqual([]);
  });

  it('keeps two keys apart: P-1 and P-2 asked at once fetch twice and each lands its own issue', async () => {
    const one = renderHook(() => useParentRead('P-1'));
    const two = renderHook(() => useParentRead('P-2'));
    let r1: Promise<JiraIssue | null> = Promise.resolve(null);
    let r2: Promise<JiraIssue | null> = Promise.resolve(null);
    act(() => {
      r1 = one.result.current.ask();
      r2 = two.result.current.ask();
    });
    expect(urls).toEqual(['/api/jira/issue/P-1', '/api/jira/issue/P-2']);
    await land(1, json(detail('P-2')));
    await land(0, json(detail('P-1')));
    expect((await r1)?.summary).toBe('Summary of P-1');
    expect((await r2)?.summary).toBe('Summary of P-2');
  });

  it('resets on a key change: rerendered P-1 → P-2 after P-1 landed reads idle, and its ask lands P-2', async () => {
    const h = renderHook(({ k }: { k: string }) => useParentRead(k), { initialProps: { k: 'P-1' } });
    act(() => {
      void h.result.current.ask();
    });
    await land(0, json(detail('P-1')));
    expect(h.result.current.read.state).toBe('ready');
    h.rerender({ k: 'P-2' });
    expect(h.result.current.read).toEqual({ state: 'idle' });
    let r: Promise<JiraIssue | null> = Promise.resolve(null);
    act(() => {
      r = h.result.current.ask();
    });
    expect(urls[1]).toBe('/api/jira/issue/P-2');
    await land(1, json(detail('P-2')));
    expect((await r)?.key).toBe('P-2');
    const read = h.result.current.read;
    expect(read.state === 'ready' ? read.issue.key : null).toBe('P-2');
  });

  it('resolves null for a read that lands after the surface unmounted, so a closed surface acts on nothing (final review)', async () => {
    const a = renderHook(() => useParentRead('P-1'));
    let r: Promise<JiraIssue | null> = Promise.resolve(null);
    act(() => {
      r = a.result.current.ask();
    });
    a.unmount();
    await land(0, json(detail('P-1')));
    expect(await r).toBeNull();
  });

  it('does not strand a loading read: P-1 asked, swapped to P-2, landed, swapped back reads idle (final review)', async () => {
    const h = renderHook(({ k }: { k: string }) => useParentRead(k), { initialProps: { k: 'P-1' } });
    let r: Promise<JiraIssue | null> = Promise.resolve(null);
    act(() => {
      r = h.result.current.ask();
    });
    h.rerender({ k: 'P-2' });
    await land(0, json(detail('P-1')));
    expect(await r).toBeNull();
    h.rerender({ k: 'P-1' });
    expect(h.result.current.read).toEqual({ state: 'idle' });
  });

  it('shows a failure on the surface that asked only: A fails, B (same key, never asked) stays idle', async () => {
    const a = renderHook(() => useParentRead('P-1'));
    const b = renderHook(() => useParentRead('P-1'));
    act(() => {
      void a.result.current.ask();
    });
    await land(0, json({ error: 'boom' }, 500));
    expect(a.result.current.read).toEqual({ state: 'failed', error: 'boom' });
    expect(b.result.current.read).toEqual({ state: 'idle' });
  });
});

type SessionLink = JiraSessionsPayload['links'][number];
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
function link(over: Partial<SessionLink> = {}): SessionLink {
  const base: JiraLink = {
    key: 'P-1',
    sessionId: 's1',
    how: 'run',
    action: 'execute',
    name: 'jira P-1',
    repo: '/Users/ada/microservice',
    branch: null,
    surface: 'dashboard',
    model: null,
    effort: null,
    snapshot: { summary: 'S', type: 'Story', parentKey: null },
    startedAt: minutesAgo(30),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null
  };
  return { ...base, state: 'working', row: null, stateSince: minutesAgo(30), ...over };
}
const payload = (...links: SessionLink[]): JiraSessionsPayload => ({ links, reachable: true, rowsAt: new Date().toISOString() });

describe('parentLiveLine / parentLineText — the sub-task band line', () => {
  const SUB = issue('S-1', { type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'P-1', summary: 'S' } });
  // Two live links on P-1 ten:00-ish and ten:05-ish (relative: 30 and 25 minutes ago) and one ended one.
  const older = link({ sessionId: 'older', state: 'quiet', startedAt: minutesAgo(30) });
  const newer = link({ sessionId: 'newer', state: 'working', startedAt: minutesAgo(25) });
  const ended = link({ sessionId: 'ended', state: 'ended', startedAt: minutesAgo(10), endedAt: minutesAgo(5) });

  it("leads with the parent's newest live session and counts the rest", () => {
    const line = parentLiveLine(SUB, payload(older, newer, ended));
    expect(line?.lead.sessionId).toBe('newer');
    expect(line?.more).toBe(1);
  });

  it('draws nothing for a story under an epic, even when the epic is live', () => {
    const story = issue('S-2', { parent: { key: 'P-1', summary: 'Epic' } });
    expect(parentLiveLine(story, payload(older, newer))).toBeNull();
  });

  it('draws nothing for a sub-task whose parent has no live session', () => {
    expect(parentLiveLine(SUB, payload(ended, link({ key: 'OTHER-1' })))).toBeNull();
    expect(parentLiveLine(SUB, null)).toBeNull();
  });

  it('words the line `Parent <KEY> · <state label> · <repo basename> →`', () => {
    expect(parentLineText('P-1', link({ state: 'working', repo: '/x/y/microservice' }))).toBe('Parent P-1 · Working · microservice →');
  });
});
