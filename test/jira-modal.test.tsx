/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraIssueModal } from '../client/src/components/jira/JiraIssueModal';
import JiraView from '../client/src/components/jira/JiraView';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { setJiraPage } from '../client/src/hooks/useJiraPage';
import { formatCreated } from '../client/src/lib/item-age';
import type { JiraChildrenIndex } from '../client/src/lib/jira';
import { daysAgoStamp } from './helpers/dates';
import type { JiraBoardStatus, JiraIssue, JiraIssueDetail, JiraStatusPayload } from '../shared/types';

/*
  Jira › the issue modal (Jira phase 2; spec §6.3 minus its controls; DESIGN.md §8.9.2) — the real modal over a mocked `fetch`. It composes `ui/Modal`, so the
  scrim, the close control and the Escape key are the shell's and are asserted here only as far as "this surface still gets them". What it owns: the facts
  column (drawn from the CARD's issue while the detail loads, and kept when the read fails), the description through the sanitising renderer, the Children
  tree (grouped-board spec §6) and its row swap inside the one modal, and the absence of every control. Fixture stamps are relative to the clock the
  assertion runs under (`test/helpers/dates.ts`).
*/

const ADA = { accountId: 'acc-ada', name: 'Ada Lovelace' };

const CARD: JiraIssue = {
  key: 'PAY-131',
  id: '10131',
  url: 'https://acme.atlassian.net/browse/PAY-131',
  summary: 'Refund partial captures',
  project: { key: 'PAY', name: 'Payments' },
  type: { name: 'Story', level: 0, subtask: false },
  status: { name: 'In Review', category: 'indeterminate' },
  priority: 'High',
  assignee: ADA,
  reporter: 'Grace Hopper',
  parent: { key: 'PAY-120', summary: 'Refund flows' },
  subtasks: 2,
  labels: ['payments', 'refunds'],
  sprint: 'Sprint 42',
  created: daysAgoStamp(10),
  updated: daysAgoStamp(1),
  resolved: null
};

const BOARD: JiraBoardStatus = {
  id: 'b_0a1b2c3d',
  name: 'Payments',
  roots: ['PAY-120'],
  queries: [],
  interval: '1m',
  polledAt: daysAgoStamp(0),
  count: 3,
  truncated: false,
  failures: []
};

function detail(over: Partial<JiraIssueDetail> = {}): JiraIssueDetail {
  return { ...CARD, description: 'Partial captures are **not** refunded.', children: [], transitions: [], boards: [BOARD.id], session: null, ...over };
}

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: ADA,
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [BOARD, { ...BOARD, id: 'b_ffffffff', name: 'Platform' }],
    repos: { PAY: ['/Users/ada/pay'] },
    projects: [{ key: 'PAY', name: 'Payments' }],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/Users/ada',
    ...over
  };
}

let urls: string[];
let answer: () => Response | Promise<Response>;

function json(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  // A plain object, not `new Response`: jsdom has no `Response`, and the other jira suites' mocks are this shape too.
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

let onOpenIssue: jest.Mock;

function mount(
  opts: { status?: Partial<JiraStatusPayload>; issue?: JiraIssue; onClose?: () => void; childrenOf?: JiraChildrenIndex | null; onOpenIssue?: jest.Mock } = {}
) {
  onOpenIssue = opts.onOpenIssue ?? jest.fn();
  return render(
    <JiraContext.Provider value={{ data: status(opts.status), loading: false, error: false, reload: () => {} }}>
      <JiraIssueModal issue={opts.issue ?? CARD} childrenOf={opts.childrenOf ?? null} onOpenIssue={onOpenIssue} onClose={opts.onClose ?? (() => {})} />
    </JiraContext.Provider>
  );
}

/** A child of the open issue: CARD with its own key, summary, status category and parent. */
const kid = (key: string, summary: string, category: JiraIssue['status']['category'], parent = 'PAY-131', name?: string): JiraIssue => ({
  ...CARD,
  key,
  summary,
  status: { name: name ?? { new: 'To Do', indeterminate: 'In Progress', done: 'Done' }[category], category },
  parent: { key: parent, summary: 'parent' }
});

/** The tree's rows, as `KEY/depth`, in document order. */
const treeRows = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.jira-tree > li')).map((li) => `${li.querySelector('.jira-tree-key')?.textContent}/${li.dataset.depth}`);

/** The facts column's value for one label, or null when that fact is not drawn. */
function fact(label: string): HTMLElement | null {
  const dialog = screen.getByRole('dialog');
  const dt = within(dialog)
    .queryAllByText(label)
    .find((n) => n.tagName === 'DT');
  return dt === undefined ? null : (dt.nextElementSibling as HTMLElement);
}

beforeEach(() => {
  urls = [];
  answer = () => json(detail());
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return answer();
  }) as unknown as typeof fetch;
});

describe('JiraIssueModal — the read', () => {
  it('fetches /api/jira/issue/PAY-131 once, and nothing that is not /api/jira', async () => {
    mount();
    await screen.findByText(/not/);
    expect(urls).toEqual(['/api/jira/issue/PAY-131']);
  });

  it("draws the fixture's facts, and the link out is the server's url in a new tab with no referrer", async () => {
    mount();
    await screen.findByText(/not/);

    expect(screen.getByRole('dialog', { name: 'PAY-131 Refund partial captures' })).toBeInTheDocument();
    expect(fact('type · parent')).toHaveTextContent('Story · PAY-120 Refund flows');
    expect(fact('status')).toHaveTextContent('In Review · in progress');
    expect(fact('priority · sprint')).toHaveTextContent('High · Sprint 42');
    expect(fact('assignee · reporter')).toHaveTextContent('Ada Lovelace · Grace Hopper');
    expect(fact('labels')).toHaveTextContent('payments, refunds');
    // created is a short date, updated the board's relative age (`1d`): the fixture is 10 days old and updated 1 day ago.
    expect(fact('created · updated')).toHaveTextContent(`${formatCreated(CARD.created)} · 1d`);
    // Only the board whose id the detail names, by NAME — `Platform` is a board the issue is not on.
    expect(fact('on boards')).toHaveTextContent('Payments');
    expect(fact('on boards')).not.toHaveTextContent('Platform');
    expect(fact('repository')).toHaveTextContent('~/pay');

    const link = screen.getByRole('link', { name: 'open in Jira ↗' });
    expect(link).toHaveAttribute('href', CARD.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });
});

describe('JiraIssueModal — the body', () => {
  it('renders the description as Markdown', async () => {
    mount();
    const strong = await screen.findByText('not');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders no javascript: href for a hostile link', async () => {
    answer = () => json(detail({ description: 'see [x](javascript:alert(1)) here' }));
    mount();
    await screen.findByText(/see/);
    const body = screen.getByRole('dialog').querySelector('.item-body') as HTMLElement;
    expect(body.innerHTML).not.toMatch(/javascript:/i);
  });

  // Grouped-board spec §6: Subtasks became Children. With no `childrenOf` (no board behind the modal) the tree is the direct children only, so nothing
  // is deeper and no `in all` is drawn.
  it('lists the children with their raw status names under a Children heading, with the direct count in its pill', async () => {
    answer = () =>
      json(
        detail({
          children: [
            kid('PAY-132', 'Wire the refund call', 'new', 'PAY-131', 'Selected for Development'),
            kid('PAY-133', 'Receipt copy', 'new', 'PAY-131', 'Blocked')
          ]
        })
      );
    mount();

    expect(await screen.findByRole('heading', { name: 'Children' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Subtasks' })).toBeNull();
    expect((document.querySelector('.jira-tree-head .ui-pill') as HTMLElement).textContent).toBe('2');
    const rows = within(document.querySelector('.jira-tree') as HTMLElement).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(expect.stringContaining('PAY-132'));
    expect(rows[0]).toHaveAccessibleName(expect.stringContaining('Wire the refund call'));
    expect(rows[0]).toHaveTextContent('Selected for Development');
    expect(rows[1]).toHaveAccessibleName(expect.stringContaining('PAY-133 Receipt copy'));
    expect(rows[1]).toHaveTextContent('Blocked');
    expect(screen.queryByText(/in all/)).toBeNull();
  });

  it('draws no Children heading when there are none', async () => {
    mount();
    await screen.findByText('not');
    expect(screen.queryByRole('heading', { name: 'Children' })).toBeNull();
  });

  // The snapshot's descendants hang under the fresh direct children, depth-first in the index's own order, indented 22 px a level (R10).
  it("hangs the board snapshot's grandchildren under their direct child, and counts every row in all", async () => {
    answer = () => json(detail({ children: [kid('PAY-160', 'Ledger story', 'indeterminate'), kid('PAY-170', 'Payout story', 'done')] }));
    const childrenOf: JiraChildrenIndex = new Map([
      ['PAY-160', [kid('PAY-162', 'Ledger rounding fix', 'new', 'PAY-160'), kid('PAY-161', 'Ledger schema', 'done', 'PAY-160')]]
    ]);
    mount({ childrenOf });

    await screen.findByRole('heading', { name: 'Children' });
    expect(treeRows()).toEqual(['PAY-160/0', 'PAY-162/1', 'PAY-161/1', 'PAY-170/0']);
    const lis = Array.from(document.querySelectorAll<HTMLElement>('.jira-tree > li'));
    expect(lis.map((li) => li.style.paddingLeft)).toEqual(['0px', '22px', '22px', '0px']);
    expect((document.querySelector('.jira-tree-head .ui-pill') as HTMLElement).textContent).toBe('2');
    expect(screen.getByText('4 in all')).toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('.ui-spread-caption')).toHaveTextContent('2 done · 1 in progress · 1 to do');
  });

  // Review Focus 4's modal half: the fresh read holds a child the board does not, so the snapshot has nothing under it.
  it('draws a direct child the board does not hold at depth 0 with nothing under it', async () => {
    answer = () => json(detail({ children: [kid('PAY-160', 'Ledger story', 'indeterminate'), kid('PAY-175', 'New child', 'new')] }));
    mount({ childrenOf: new Map([['PAY-160', [kid('PAY-161', 'Ledger schema', 'done', 'PAY-160')]]]) });

    await screen.findByRole('heading', { name: 'Children' });
    expect(treeRows()).toEqual(['PAY-160/0', 'PAY-161/1', 'PAY-175/0']);
    expect(screen.getByText('3 in all')).toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('.ui-spread-caption')).toHaveTextContent('1 done · 1 in progress · 1 to do');
  });

  // Reparented since the last poll: the fresh read says PAY-161 is a direct child, the stale snapshot still files it under PAY-160 — drawn once, where the
  // fresh read puts it.
  it('draws an issue reparented since the last poll once, as the direct child the fresh read says it is', async () => {
    answer = () => json(detail({ children: [kid('PAY-160', 'Ledger story', 'indeterminate'), kid('PAY-161', 'Ledger schema', 'done')] }));
    mount({
      childrenOf: new Map([['PAY-160', [kid('PAY-161', 'Ledger schema', 'done', 'PAY-160'), kid('PAY-162', 'Ledger rounding fix', 'new', 'PAY-160')]]])
    });

    await screen.findByRole('heading', { name: 'Children' });
    expect(treeRows()).toEqual(['PAY-160/0', 'PAY-162/1', 'PAY-161/0']);
    expect(screen.getByText('3 in all')).toBeInTheDocument();
  });

  it('hands a row click to onOpenIssue with that row and the very snapshot the modal was given', async () => {
    const deep = kid('PAY-162', 'Ledger rounding fix', 'new', 'PAY-160');
    answer = () => json(detail({ children: [kid('PAY-160', 'Ledger story', 'indeterminate')] }));
    const childrenOf: JiraChildrenIndex = new Map([['PAY-160', [deep]]]);
    mount({ childrenOf });

    await userEvent.click(await screen.findByRole('button', { name: /PAY-162 Ledger rounding fix/ }));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    expect(onOpenIssue.mock.calls[0][0]).toBe(deep);
    expect(onOpenIssue.mock.calls[0][1]).toBe(childrenOf);
  });

  it('says comments stay in Jira, with the link', async () => {
    mount();
    await screen.findByText('not');
    const line = screen.getByText(/Comments stay in Jira — v1 neither reads nor writes them/);
    expect(within(line).getByRole('link')).toHaveAttribute('href', CARD.url);
  });
});

describe('JiraIssueModal — the repository fact', () => {
  it('writes a path under $HOME with `~`', async () => {
    mount({ status: { repos: { PAY: ['/Users/ada/pay'] }, home: '/Users/ada' } });
    await screen.findByText('not');
    expect(fact('repository')).toHaveTextContent('~/pay');
  });

  it('says where to map one when the project has none', async () => {
    mount({ status: { repos: {} } });
    await screen.findByText('not');
    expect(fact('repository')).toHaveTextContent('no repository mapped for PAY — Jira › Setup › Repositories');
  });
});

describe('JiraIssueModal — while loading, and when the read fails', () => {
  it("draws the card's own facts before the detail arrives, with no body to read yet", async () => {
    let release: (r: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    mount();

    expect(fact('status')).toHaveTextContent('In Review · in progress');
    expect(fact('labels')).toHaveTextContent('payments, refunds');
    expect(screen.getByText('loading…')).toBeInTheDocument();
    // `on boards` comes from the detail, so it is not guessed at while that is in flight.
    expect(fact('on boards')).toBeNull();

    release(json(detail()));
    await screen.findByText('not');
    expect(fact('on boards')).toHaveTextContent('Payments');
  });

  it("keeps the card's facts and says what the server said when the read is a 502", async () => {
    answer = () => json({ error: 'Jira unreachable: timeout' }, { status: 502 });
    mount();

    expect(await screen.findByText('could not read the ticket — Jira unreachable: timeout')).toBeInTheDocument();
    expect(fact('status')).toHaveTextContent('In Review · in progress');
    expect(fact('assignee · reporter')).toHaveTextContent('Ada Lovelace · Grace Hopper');
    expect(screen.queryByText('loading…')).toBeNull();
  });

  it('treats a body that is not a ticket as a failed read rather than throwing in a render', async () => {
    answer = () => json({});
    mount();
    expect(await screen.findByText('could not read the ticket — malformed response')).toBeInTheDocument();
    expect(fact('status')).toHaveTextContent('In Review · in progress');
  });

  it('does not paint a late answer for the issue the modal has since been reopened on', async () => {
    const resolvers = new Map<string, (r: Response) => void>();
    global.fetch = jest.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => resolvers.set(String(input), resolve))) as unknown as typeof fetch;
    const view = mount();
    const other: JiraIssue = { ...CARD, key: 'PAY-9', summary: 'Another' };
    view.rerender(
      <JiraContext.Provider value={{ data: status(), loading: false, error: false, reload: () => {} }}>
        <JiraIssueModal issue={other} childrenOf={null} onOpenIssue={jest.fn()} onClose={() => {}} />
      </JiraContext.Provider>
    );

    resolvers.get('/api/jira/issue/PAY-131')?.(json(detail({ description: 'STALE ANSWER' })));
    resolvers.get('/api/jira/issue/PAY-9')?.(json(detail({ ...other, description: 'FRESH ANSWER' })));
    await screen.findByText('FRESH ANSWER');
    expect(screen.queryByText('STALE ANSWER')).toBeNull();
  });
});

describe('JiraIssueModal — phase 2 has no controls', () => {
  it('draws no Assign to me, Move to, Run or Stop session', async () => {
    mount();
    await screen.findByText('not');
    const dialog = screen.getByRole('dialog');
    for (const name of [/assign to me/i, /move to/i, /^run/i, /stop session/i]) {
      expect(within(dialog).queryByRole('button', { name })).toBeNull();
    }
    expect(fact('session')).toBeNull();
  });
});

describe('JiraIssueModal — the exit', () => {
  it('closes on Escape, which the Modal shell owns', async () => {
    const onClose = jest.fn();
    mount({ onClose });
    await screen.findByText('not');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('JiraView — the open-issue slot draws the modal', () => {
  it('opens the modal from a card click and closes it on its close control', async () => {
    window.localStorage.clear();
    setJiraPage('board');
    const board = status();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/jira/issue/')) return json(detail());
      if (url.includes('/issues')) return json({ issues: [CARD], polledAt: daysAgoStamp(0) });
      return json(board);
    }) as unknown as typeof fetch;

    render(
      <JiraContext.Provider value={{ data: board, loading: false, error: false, reload: () => {} }}>
        <JiraView onOpenJiraPage={jest.fn()} />
      </JiraContext.Provider>
    );

    await userEvent.click(await screen.findByRole('button', { name: /Refund partial captures/ }));
    expect(await screen.findByRole('dialog', { name: 'PAY-131 Refund partial captures' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // Task 3's GROUP slice, rebuilt here (suites share no fixtures): PAY-120 the epic, PAY-160 and PAY-170 under it, PAY-161 and PAY-162 under PAY-160 —
  // with the board suite's `updated` ages too, because the fold index lists siblings newest first, which is what puts PAY-162 above PAY-161.
  const groupIssue = (
    key: string,
    summary: string,
    category: JiraIssue['status']['category'],
    parent: string | null,
    type: JiraIssue['type'],
    days: number
  ): JiraIssue => ({
    ...kid(key, summary, category, parent ?? 'none'),
    parent: parent === null ? null : { key: parent, summary: 'parent' },
    type,
    updated: daysAgoStamp(days)
  });
  const STORY = { name: 'Story', level: 0, subtask: false };
  const SUB = { name: 'Sub-task', level: -1, subtask: true };
  const G_120 = groupIssue('PAY-120', 'Payments epic', 'new', null, { name: 'Epic', level: 1, subtask: false }, 5);
  const G_160 = groupIssue('PAY-160', 'Ledger story', 'indeterminate', 'PAY-120', STORY, 4);
  const G_161 = groupIssue('PAY-161', 'Ledger schema', 'done', 'PAY-160', SUB, 3);
  const G_162 = groupIssue('PAY-162', 'Ledger rounding fix', 'new', 'PAY-160', SUB, 0);
  const G_170 = groupIssue('PAY-170', 'Payout story', 'done', 'PAY-120', STORY, 6);
  const GROUP = [G_120, G_160, G_161, G_162, G_170];

  /** JiraView over GROUP, each issue's detail answered by its URL; returns the URLs requested. */
  function mountView(details: Record<string, Partial<JiraIssueDetail>>): string[] {
    window.localStorage.clear();
    setJiraPage('board');
    const board = status();
    const requested: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const key = url.match(/^\/api\/jira\/issue\/([^/?]+)/)?.[1];
      if (key !== undefined) {
        const own = GROUP.find((g) => g.key === key) ?? { key };
        return json(detail({ ...own, children: [], ...details[key] }));
      }
      if (url.includes('/issues')) return json({ issues: GROUP, polledAt: daysAgoStamp(0) });
      return json(board);
    }) as unknown as typeof fetch;
    render(
      <JiraContext.Provider value={{ data: board, loading: false, error: false, reload: () => {} }}>
        <JiraView onOpenJiraPage={jest.fn()} />
      </JiraContext.Provider>
    );
    return requested;
  }

  // Grouped-board spec §6: a row swaps the ONE modal's issue — never a second Modal, so Escape still has one owner — and the snapshot taken at the card
  // click is what hangs PAY-162 under PAY-160.
  it("swaps the one modal to a tree row's issue, fetching it once, and Escape closes it", async () => {
    const requested = mountView({ 'PAY-120': { children: [G_160, G_170] } });

    await userEvent.click(await screen.findByRole('button', { name: /Payments epic/ }));
    expect(await screen.findByRole('dialog', { name: 'PAY-120 Payments epic' })).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Children' });
    expect(treeRows()).toEqual(['PAY-160/0', 'PAY-162/1', 'PAY-161/1', 'PAY-170/0']);

    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /PAY-162/ }));
    expect(await screen.findByRole('dialog', { name: 'PAY-162 Ledger rounding fix' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await waitFor(() => expect(requested.filter((u) => u.startsWith('/api/jira/issue/PAY-162'))).toHaveLength(1));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // Review Focus 4: a direct child the board list does not hold still opens, in the same single dialog, from the issue the row carries.
  it('opens a direct child the board does not hold in the same single dialog', async () => {
    const PAY_175 = groupIssue('PAY-175', 'New child', 'new', 'PAY-120', STORY, 0);
    mountView({ 'PAY-120': { children: [G_160, PAY_175] }, 'PAY-175': { ...PAY_175, children: [] } });

    await userEvent.click(await screen.findByRole('button', { name: /Payments epic/ }));
    await screen.findByRole('heading', { name: 'Children' });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /PAY-175/ }));

    expect(await screen.findByRole('dialog', { name: 'PAY-175 New child' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Children' })).toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not bring the modal back for an issue the reader left on when the page returns to Board', async () => {
    window.localStorage.clear();
    setJiraPage('board');
    const board = status();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/jira/issue/')) return json(detail());
      if (url.includes('/issues')) return json({ issues: [CARD], polledAt: daysAgoStamp(0) });
      return json(board);
    }) as unknown as typeof fetch;
    render(
      <JiraContext.Provider value={{ data: board, loading: false, error: false, reload: () => {} }}>
        <JiraView onOpenJiraPage={jest.fn()} />
      </JiraContext.Provider>
    );
    await userEvent.click(await screen.findByRole('button', { name: /Refund partial captures/ }));
    await screen.findByRole('dialog', { name: 'PAY-131 Refund partial captures' });

    act(() => setJiraPage('setup'));
    expect(screen.queryByRole('dialog', { name: 'PAY-131 Refund partial captures' })).toBeNull();
    act(() => setJiraPage('board'));
    await screen.findByRole('button', { name: /Refund partial captures/ });
    expect(screen.queryByRole('dialog', { name: 'PAY-131 Refund partial captures' })).toBeNull();
  });
});
