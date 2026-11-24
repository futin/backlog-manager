/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { SubagentDisclosure } from '../../client/src/components/ui/SubagentList';
import type { SubagentDetail, SubagentJob } from '../../shared/types';

/*
  subagent-list.test.tsx — the `Subagents` disclosure and the list it opens (#611, spec docs/superpowers/specs/2026-11-24-subagent-visibility-design.md,
  "Client"). The disclosure fetches nothing while closed, mounts the list (and so the 10 s poll) only while open, and keeps the last good answer across a
  failed refresh. Every string asserted is the spec's copy table verbatim.

  Fake timers throughout, so the poll and the "nothing while closed" cases count requests against a clock the test owns. Fixture stamps are offsets from
  `Date.now()` read at call time (the faked clock), never literals.
*/

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function job(over: Partial<SubagentJob> = {}): SubagentJob {
  return {
    id: 'toolu_1',
    type: 'Explore',
    description: 'look around',
    status: 'running',
    startedAt: ago(2 * MIN),
    endedAt: null,
    durationMs: null,
    tokens: null,
    agentId: 'a1',
    toolUses: null,
    ...over
  };
}

function detail(agents: SubagentJob[], over: Partial<SubagentDetail> = {}): SubagentDetail {
  const running = agents.filter((a) => a.status === 'running').length;
  return { agents, running, finished: agents.length - running, ...over };
}

type Reply = { status: number; body: unknown };

/** A `fetch` answering each call with the next queued reply (the last one repeats), recording every URL. */
function stubFetch(...replies: Reply[]): { urls: string[]; queue: (r: Reply) => void } {
  const urls: string[] = [];
  const pending = [...replies];
  let last = replies[replies.length - 1];
  global.fetch = jest.fn((url: string) => {
    urls.push(url);
    const r = pending.shift() ?? last;
    last = r;
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body) } as Response);
  }) as unknown as typeof fetch;
  return { urls, queue: (r) => pending.push(r) };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

const toggle = () => screen.getByRole('button', { name: 'Subagents' });
async function open(): Promise<void> {
  fireEvent.click(toggle());
  await advance(0);
}

const realFetch = global.fetch;
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  global.fetch = realFetch;
});

describe('SubagentDisclosure', () => {
  it('1: closed, it draws the button and fetches nothing', async () => {
    const { urls } = stubFetch({ status: 200, body: detail([job()]) });
    render(<SubagentDisclosure sessionId="s-1" />);
    await advance(0);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(urls).toEqual([]);
    expect(screen.queryByText(/subagents? ·|^\d+ subagents?$/)).toBeNull();
  });

  it('2: open, it asks for the session’s subagents and draws the summary, the badge and one row per agent in order', async () => {
    const agents = [
      job({ id: 'a', description: 'first one', background: false, lastWriteAt: ago(MIN) }),
      job({ id: 'b', description: 'second one', status: 'done', endStatus: 'completed', durationMs: 4 * MIN })
    ];
    let resolve: (r: Response) => void = () => {};
    const urls: string[] = [];
    global.fetch = jest.fn((url: string) => {
      urls.push(url);
      return new Promise<Response>((r) => {
        resolve = r;
      });
    }) as unknown as typeof fetch;
    render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    expect(urls).toEqual(['/api/agents/sessions/s-1/subagents']);
    expect(screen.getByText('loading subagents…')).toBeInTheDocument();
    await act(async () => {
      resolve({ ok: true, status: 200, json: () => Promise.resolve(detail(agents)) } as Response);
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('loading subagents…')).toBeNull();
    expect(screen.getByText('2 subagents · 1 working · 1 ended')).toBeInTheDocument();
    expect(screen.getByText('waiting on subagent')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('first one')).toBeInTheDocument();
    expect(within(rows[1]).getByText('second one')).toBeInTheDocument();
    expect(within(rows[1]).getByText('ran 4m')).toBeInTheDocument();
  });

  it('3: an empty list reads `no subagents`', async () => {
    stubFetch({ status: 200, body: detail([]) });
    render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    expect(screen.getByText('no subagents')).toBeInTheDocument();
  });

  it('4: a first failure shows the route’s sentence; a failure after a good answer keeps the list and adds the refresh line', async () => {
    stubFetch({ status: 502, body: { error: 'the dashboard session detail answered 500' } });
    const first = render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    expect(screen.getByText('the dashboard session detail answered 500')).toBeInTheDocument();
    first.unmount();

    stubFetch({ status: 200, body: detail([job({ description: 'kept row' })]) }, { status: 502, body: { error: 'the dashboard session detail answered 500' } });
    render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    expect(screen.getByText('kept row')).toBeInTheDocument();
    await advance(10_000);
    expect(screen.getByText('kept row')).toBeInTheDocument();
    expect(screen.getByText('couldn’t refresh — the dashboard session detail answered 500')).toBeInTheDocument();
  });

  it('5: a 404 says the dashboard has no transcript', async () => {
    stubFetch({ status: 404, body: { error: 'the dashboard has no transcript for this session' } });
    render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    expect(screen.getByText('the dashboard has no transcript for this session')).toBeInTheDocument();
  });

  it('6: an orphan row carries the titled tag; a blocked row its reason after the pill', async () => {
    const agents = [job({ id: 'o', description: 'lost child', background: true }), job({ id: 'b', description: 'held', blockedReason: 'rate-limit' })];
    stubFetch({ status: 200, body: detail(agents, { parentLive: false }) });
    render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    const [orphanRow, blockedRow] = screen.getAllByRole('listitem');
    expect(within(orphanRow).getByText('orphan')).toHaveAttribute(
      'title',
      'background agent whose parent process is gone — nothing will wake the parent when it stops'
    );
    expect(within(blockedRow).queryByText('orphan')).toBeNull();
    const pill = within(blockedRow).getByText('blocked');
    const reason = within(blockedRow).getByText('rate limit');
    expect(pill.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('7: closed, nothing is fetched however long; reopening fetches again', async () => {
    const { urls } = stubFetch({ status: 200, body: detail([]) });
    render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    expect(urls).toHaveLength(1);
    fireEvent.click(toggle());
    await advance(30_000);
    expect(urls).toHaveLength(1);
    await open();
    expect(urls).toHaveLength(2);
  });

  it('8: open, it polls every 10 s', async () => {
    const { urls } = stubFetch({ status: 200, body: detail([]) });
    render(<SubagentDisclosure sessionId="s-1" />);
    await open();
    expect(urls).toHaveLength(1);
    await advance(10_000);
    expect(urls).toHaveLength(2);
  });
});
