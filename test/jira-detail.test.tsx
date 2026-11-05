/**
 * @jest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraDetail } from '../client/src/components/jira/JiraDetail';
import JiraView from '../client/src/components/jira/JiraView';
import { JiraSessionsProvider } from '../client/src/hooks/JiraSessionsContext';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { JiraSessionsContext } from '../client/src/hooks/JiraSessionsContext';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { setJiraPage } from '../client/src/hooks/useJiraPage';
import { formatCreated } from '../client/src/lib/item-age';
import { pollAge } from '../client/src/lib/tracker';
import type { JiraChildrenIndex } from '../client/src/lib/jira';
import { daysAgoStamp } from './helpers/dates';
import { JIRA_BUILTIN_LABELS, type AgentsStatus, type DashboardRow, type JiraLink, type JiraSessionsPayload, type JiraAction, type JiraBoardStatus, type JiraIssue, type JiraIssueDetail, type JiraStatusPayload } from '../shared/types';

/**
 * The zone every reading below is taken in (#241) — the global `TZ` pin (`test/helpers/global-setup.ts`), so the expected values written before the zone
 * became an argument still hold, and so a component mounted without `TimeZoneProvider` (whose default is the browser's zone) reads the same one.
 */
const ZONE = 'America/New_York';

/*
  Jira › the issue modal (Jira phase 2; spec §6.3 minus its controls; DESIGN.md §8.9.2) — the real modal over a mocked `fetch`. It composes `ui/Modal`, so the
  scrim, the close control and the Escape key are the shell's and are asserted here only as far as "this surface still gets them". What it owns: the facts
  column (drawn from the CARD's issue while the detail loads, and kept when the read fails), the description through the sanitising renderer, the Children
  tree (grouped-board spec §6) and its row swap inside the one modal, and — since Jira phase 3 — the controls row: `Assign to me` and `Move to…`, posting
  through `/api/jira/issue/*`, one write at a time, re-reading the detail after a landed one (R8) and nudging the board (R7). Fixture stamps are relative
  to the clock the assertion runs under (`test/helpers/dates.ts`).
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
    repoDefaults: {},
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
/** Every request with its init, POSTs included — `urls` keeps its phase 2 meaning for the reads, and the writes are asserted from here. */
let calls: { url: string; init?: RequestInit }[];
/** What a POST answers. The default is the routes' own 200 (`JiraIssueWriteResult`). */
let post: (url: string) => Response | Promise<Response>;
/** What `GET /api/jira/worktrees` answers — read by the Worktrees list, and kept out of `urls` (which is the issue reads) like the agents-status one. */
let worktrees: () => Response | Promise<Response>;

function json(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  // A plain object, not `new Response`: jsdom has no `Response`, and the other jira suites' mocks are this shape too.
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

/** What `GET /api/agents/status` answers. The modal asks it only while a confirmed session is shown (Stop's gate), and never lands in `urls`. */
let agentsStatus: AgentsStatus;
const AGENTS_ON: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'acceptEdits',
  projectPaths: ['/Users/ada/pay']
};

let onOpenIssue: jest.Mock;
let reload: jest.Mock;
let onWrote: jest.Mock;
let onRun: jest.Mock;
let reloadSessions: jest.Mock;

function mount(
  opts: {
    status?: Partial<JiraStatusPayload>;
    issue?: JiraIssue;
    onClose?: () => void;
    childrenOf?: JiraChildrenIndex | null;
    onOpenIssue?: jest.Mock;
    /** `GET /api/jira/sessions`' answer, handed to the context the section's provider would fill; absent is "not landed yet" (`null`). */
    sessions?: JiraSessionsPayload | null;
  } = {}
) {
  reloadSessions = jest.fn(() => Promise.resolve());
  onOpenIssue = opts.onOpenIssue ?? jest.fn();
  reload = jest.fn();
  onWrote = jest.fn();
  onRun = jest.fn();
  return render(
    <JiraContext.Provider value={{ data: status(opts.status), loading: false, error: false, reload }}>
      <JiraSessionsContext.Provider value={{ data: opts.sessions ?? null, reload: reloadSessions }}>
        <JiraDetail
          issue={opts.issue ?? CARD}
          childrenOf={opts.childrenOf ?? null}
          onOpenIssue={onOpenIssue}
          onWrote={onWrote}
          onRun={onRun}
          onClose={opts.onClose ?? (() => {})}
        />
      </JiraSessionsContext.Provider>
    </JiraContext.Provider>
  );
}

/** The POSTs sent so far, in order. */
const posts = (): { url: string; init?: RequestInit }[] => calls.filter((c) => c.init?.method === 'POST');
/** How many times one issue's detail was read. */
const reads = (key: string, from: readonly string[] = urls): number => from.filter((u) => u === `/api/jira/issue/${key}`).length;
const assignChip = (): HTMLElement => within(screen.getByRole('dialog')).getByRole('button', { name: 'Assign to me' });
const moveSelect = (): HTMLSelectElement => within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Move to' });
/** Neither assigned to `me` (ADA) nor anyone: the case every Assign click mounts, since the default CARD is ADA's own. */
const UNASSIGNED: JiraIssue = { ...CARD, assignee: null };
const TRANSITIONS: JiraIssueDetail['transitions'] = [
  { id: '31', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' } },
  { id: '41', name: 'Done', to: { name: 'Done', category: 'done' } }
];

/** A promise and its resolver, for a request held open across a step. */
function held(): { promise: Promise<Response>; release: (r: Response) => void } {
  let release: (r: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { promise, release };
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
  calls = [];
  answer = () => json(detail());
  post = () => json({ ok: true, reread: true });
  agentsStatus = AGENTS_ON;
  worktrees = () => json({ worktrees: [], unavailable: [] });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (init?.method === 'POST') return post(String(input));
    if (String(input) === '/api/agents/status') return json(agentsStatus);
    if (String(input) === '/api/jira/worktrees') return worktrees();
    urls.push(String(input));
    return answer();
  }) as unknown as typeof fetch;
});

describe('JiraDetail — the read', () => {
  it('fetches /api/jira/issue/PAY-131 once, and nothing that is not /api/jira', async () => {
    mount();
    await screen.findByText(/not/);
    expect(urls).toEqual(['/api/jira/issue/PAY-131']);
  });

  it("draws the fixture's facts, and the link out is the server's url in a new tab with no referrer", async () => {
    mount();
    await screen.findByText(/not/);

    expect(screen.getByRole('dialog', { name: 'PAY-131 Refund partial captures' })).toBeInTheDocument();
    // The type, parent and sprint ride the head's crumbs, as the mock draws them (the flex gap is the space jsdom does not see); the parent and sprint
    // are facts in the ticket pane too.
    expect(document.querySelector('.jira-detail-crumbs')).toHaveTextContent('PAY-131· Story· in PAY-120 Refund flows· Sprint 42');
    expect(fact('Parent')).toHaveTextContent('PAY-120 Refund flows');
    expect(fact('Status')).toHaveTextContent('In Review · in progress');
    expect(fact('Priority')).toHaveTextContent('High');
    expect(fact('Sprint')).toHaveTextContent('Sprint 42');
    expect(fact('Assignee')).toHaveTextContent('Ada Lovelace');
    expect(fact('Reporter')).toHaveTextContent('Grace Hopper');
    expect(fact('Labels')).toHaveTextContent('payments, refunds');
    // created is a short date, updated the board's relative age (`1d`): the fixture is 10 days old and updated 1 day ago.
    expect(fact('Created · updated')).toHaveTextContent(`${formatCreated(CARD.created, Date.now(), ZONE)} · 1d`);
    // Only the board whose id the detail names, by NAME — `Platform` is a board the issue is not on.
    expect(fact('On boards')).toHaveTextContent('Payments');
    expect(fact('On boards')).not.toHaveTextContent('Platform');
    expect(fact('Repository')).toHaveTextContent('~/pay');

    const link = screen.getByRole('link', { name: 'Open in Jira ↗' });
    expect(link).toHaveAttribute('href', CARD.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });
});

describe('JiraDetail — the body', () => {
  it('renders the description as Markdown', async () => {
    mount();
    const strong = await screen.findByText('not');
    expect(strong.tagName).toBe('STRONG');
  });

  // jsdom has no layout, so every box measures 0 × 0 and the description always "fits"; the overflow case stubs the two heights the clamp reads.
  it('draws no Show more when the description fits its clamp', async () => {
    mount();
    await screen.findByText('not');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('clamps an overflowing description behind Show more, which opens and closes it', async () => {
    const scroll = jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('jira-desc') ? 600 : 0;
    });
    const client = jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('jira-desc') ? 144 : 0;
    });
    try {
      mount();
      await screen.findByText('not');
      const box = screen.getByRole('dialog').querySelector('.jira-desc') as HTMLElement;
      const more = await screen.findByRole('button', { name: 'Show more' });
      expect(box).toHaveClass('clamped');
      expect(more).toHaveAttribute('aria-expanded', 'false');

      await userEvent.click(more);
      expect(box).toHaveClass('open');
      expect(box).not.toHaveClass('clamped');
      const less = screen.getByRole('button', { name: 'Show less' });
      expect(less).toHaveAttribute('aria-expanded', 'true');

      await userEvent.click(less);
      expect(box).toHaveClass('clamped');
      expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
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

describe('JiraDetail — the repository fact', () => {
  it('writes a path under $HOME with `~`', async () => {
    mount({ status: { repos: { PAY: ['/Users/ada/pay'] }, home: '/Users/ada' } });
    await screen.findByText('not');
    expect(fact('Repository')).toHaveTextContent('~/pay');
  });

  it('says where to map one when the project has none', async () => {
    mount({ status: { repos: {} } });
    await screen.findByText('not');
    expect(fact('Repository')).toHaveTextContent('no repository mapped for PAY — Jira › Setup › Repositories');
  });
});

describe('JiraDetail — while loading, and when the read fails', () => {
  it("draws the card's own facts before the detail arrives, with no body to read yet", async () => {
    let release: (r: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    mount();

    expect(fact('Status')).toHaveTextContent('In Review · in progress');
    expect(fact('Labels')).toHaveTextContent('payments, refunds');
    expect(screen.getByText('loading…')).toBeInTheDocument();
    // `on boards` comes from the detail, so it is not guessed at while that is in flight.
    expect(fact('On boards')).toBeNull();

    release(json(detail()));
    await screen.findByText('not');
    expect(fact('On boards')).toHaveTextContent('Payments');
  });

  it("keeps the card's facts and says what the server said when the read is a 502", async () => {
    answer = () => json({ error: 'Jira unreachable: timeout' }, { status: 502 });
    mount();

    expect(await screen.findByText('could not read the ticket — Jira unreachable: timeout')).toBeInTheDocument();
    expect(fact('Status')).toHaveTextContent('In Review · in progress');
    expect(fact('Assignee')).toHaveTextContent('Ada Lovelace');
    expect(screen.queryByText('loading…')).toBeNull();
  });

  it('treats a body that is not a ticket as a failed read rather than throwing in a render', async () => {
    answer = () => json({});
    mount();
    expect(await screen.findByText('could not read the ticket — malformed response')).toBeInTheDocument();
    expect(fact('Status')).toHaveTextContent('In Review · in progress');
  });

  it('does not paint a late answer for the issue the modal has since been reopened on', async () => {
    const resolvers = new Map<string, (r: Response) => void>();
    global.fetch = jest.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => resolvers.set(String(input), resolve))) as unknown as typeof fetch;
    const view = mount();
    const other: JiraIssue = { ...CARD, key: 'PAY-9', summary: 'Another' };
    view.rerender(
      <JiraContext.Provider value={{ data: status(), loading: false, error: false, reload: () => {} }}>
        <JiraDetail issue={other} childrenOf={null} onOpenIssue={jest.fn()} onWrote={jest.fn()} onRun={jest.fn()} onClose={() => {}} />
      </JiraContext.Provider>
    );

    resolvers.get('/api/jira/issue/PAY-131')?.(json(detail({ description: 'STALE ANSWER' })));
    resolvers.get('/api/jira/issue/PAY-9')?.(json(detail({ ...other, description: 'FRESH ANSWER' })));
    await screen.findByText('FRESH ANSWER');
    expect(screen.queryByText('STALE ANSWER')).toBeNull();
  });
});

/** A session started three hours ago, so the elapsed reading is `3h` for the whole of a case. */
const threeHoursAgo = (): string => new Date(Date.now() - 3 * 3_600_000).toISOString();
const SESSION = (over: Partial<{ starting: boolean }> = {}) => ({
  'PAY-131': { sessionId: 's1', name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false, ...over }
});
const modalRun = (): HTMLElement => within(screen.getByRole('dialog')).getByRole('button', { name: 'Run PAY-131' });
const modalMore = (): HTMLElement => within(screen.getByRole('dialog')).getByRole('button', { name: 'Run options for PAY-131' });
const stopChip = (): HTMLElement | null => within(screen.getByRole('dialog')).queryByRole('button', { name: 'Stop session' });
/** Agents-status reads, which the modal mounts only for a confirmed session and which are kept out of `urls`. */
const agentsReads = (): number => calls.filter((c) => c.url === '/api/agents/status').length;

type SessionLink = JiraSessionsPayload['links'][number];
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
/** One entry of `GET /api/jira/sessions`: a live `run` link on PAY-131 started three hours ago, `working`, with no dashboard row unless the case gives one. */
function link(over: Partial<SessionLink> = {}): SessionLink {
  const base: JiraLink = {
    key: 'PAY-131',
    sessionId: 's1',
    how: 'run',
    action: 'context',
    name: 'jira PAY-131',
    repo: '/Users/ada/pay',
    branch: null,
    surface: 'dashboard',
    model: null,
    effort: null,
    snapshot: { summary: 'Refund partial captures', type: 'Story', parentKey: null },
    startedAt: threeHoursAgo(),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null
  };
  return { ...base, state: 'working', row: null, stateSince: threeHoursAgo(), ...over };
}
const payload = (...links: SessionLink[]): JiraSessionsPayload => ({ links, reachable: true, rowsAt: new Date().toISOString() });
const row = (over: Partial<DashboardRow> = {}): DashboardRow => ({ id: 's1', status: 'busy', stopState: 'ready', ...over });
/** The one confirmed live session the Stop cases need: a Run link whose row says the dashboard can end it. */
const STOPPABLE = (): JiraSessionsPayload => payload(link({ row: row() }));
/** The cards in the agent column, in document order. */
const cards = (): HTMLElement[] => within(screen.getByRole('dialog')).queryAllByRole('article');

describe('JiraDetail — the session fact (Jira phase 5)', () => {
  it('reads `<name> · <repo> · <elapsed>` for a confirmed session', async () => {
    mount({ status: { live: SESSION() } });
    await screen.findByText('not');
    expect(fact('Session')).toHaveTextContent('jira PAY-131 · pay · 3h');
  });

  it('keeps counting while the modal stays open: the elapsed reading follows the clock', async () => {
    jest.useFakeTimers();
    try {
      mount({ status: { live: { 'PAY-131': { ...SESSION()['PAY-131'], startedAt: new Date(Date.now() - 59 * 60_000).toISOString() } } } });
      await screen.findByText('not');
      expect(fact('Session')).toHaveTextContent('jira PAY-131 · pay · 59m');
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(fact('Session')).toHaveTextContent('jira PAY-131 · pay · 1h');
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads `starting` while the key is only reserved', async () => {
    mount({ status: { live: SESSION({ starting: true }) } });
    await screen.findByText('not');
    expect(fact('Session')).toHaveTextContent(/^starting$/);
  });

  it('reads `—` with no session on the key, and ignores another key\'s', async () => {
    mount({ status: { live: { 'PAY-9': SESSION()['PAY-131'] } } });
    await screen.findByText('not');
    expect(fact('Session')).toHaveTextContent(/^—$/);
  });
});

describe('JiraDetail — Run ▾ (Jira phase 5)', () => {
  it('draws the chip in the controls row, beside Assign and Move, and a pick hands the issue and the action up', async () => {
    mount({ status: { skills: [{ id: 's_0a1b2c3d', name: 'Groom ticket', prompt: '/jira-groom {key}' }] } });
    await screen.findByText('not');
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.jira-modal-controls')).toContainElement(modalRun());

    await userEvent.click(modalMore());
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: new RegExp(JIRA_BUILTIN_LABELS.context) }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-131' }), 'context' satisfies JiraAction);

    await userEvent.click(modalMore());
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: /Groom ticket/ }));
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'PAY-131' }), { skill: 's_0a1b2c3d' });
  });

  it('the left half hands the default action up with no menu', async () => {
    mount();
    await screen.findByText('not');
    await userEvent.click(modalRun());
    expect(screen.queryByRole('dialog', { name: 'Run menu' })).toBeNull();
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-131' }), 'execute' satisfies JiraAction);
  });

  it('opens its panel inside the facts column: the row-wide width, every label as a title, and scrolled into view', async () => {
    // jsdom has no layout and no `scrollIntoView`, so the call is stubbed onto the prototype and the width is read off the custom property `Popover` sets.
    // The CSS half — the controls row as the positioning parent — is layout, so it was measured on the running board rather than pinned here.
    const scrolled = jest.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      mount({ status: { skills: [{ id: 's_0a1b2c3d', name: 'A very long skill name that the narrow panel ellipsises', prompt: '/x {key}' }] } });
      await screen.findByText('not');
      await userEvent.click(modalMore());
      const menu = screen.getByRole('dialog', { name: 'Run menu' });
      expect(menu.style.getPropertyValue('--ui-popover-width')).toBe('300px');
      expect(within(menu).getByRole('button', { name: /A very long skill name/ })).toHaveAttribute('title', 'A very long skill name that the narrow panel ellipsises');
      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrolled.mock.contexts[0]).toBe(menu);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('is disabled with the reason while a session runs on the key, and dashed with the hint when the project has no repository', async () => {
    const view = mount({ status: { live: SESSION() } });
    await screen.findByText('not');
    expect(modalRun()).toBeDisabled();
    expect(modalMore()).toBeDisabled();
    expect(modalRun()).toHaveAttribute('title', 'a session is running on PAY-131');
    expect(modalMore()).toHaveAttribute('title', 'a session is running on PAY-131');
    expect(modalRun()).toHaveTextContent('Running · 3h');
    view.unmount();

    mount({ status: { repos: {} } });
    await screen.findByText('not');
    const noRepo = 'no repository mapped for PAY — Jira › Setup › Repositories';
    expect(modalRun()).toHaveAttribute('title', noRepo);
    expect(modalMore()).toHaveAttribute('title', noRepo);
    expect(modalRun()).toBeDisabled();
    expect(modalMore()).toBeDisabled();
    await userEvent.click(modalRun());
    expect(screen.queryByRole('dialog', { name: 'Run menu' })).toBeNull();
    expect(onRun).not.toHaveBeenCalled();
  });

  it('with only a live run link on the sessions payload, the left half reads Running with that link\'s age', async () => {
    mount({ sessions: payload(link({ startedAt: hoursAgo(2) })) });
    await screen.findByText('not');
    expect(modalRun()).toBeDisabled();
    expect(modalRun()).toHaveTextContent('Running · 2h');
  });
});

describe('JiraDetail — Stop session (Jira phase 5)', () => {
  it('is drawn for a session whose row says it can be stopped, with agents on, and asks before it posts', async () => {
    mount({ status: { live: SESSION() }, sessions: STOPPABLE() });
    await screen.findByText('not');
    await waitFor(() => expect(stopChip()).not.toBeNull());

    await userEvent.click(stopChip() as HTMLElement);
    expect(screen.getByTestId('jira-stop-confirm')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);

    await userEvent.click(screen.getByTestId('jira-stop-confirm-dismiss'));
    expect(screen.queryByTestId('jira-stop-confirm')).toBeNull();
    expect(stopChip()).not.toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('posts `{ key, sessionId }` to /api/agents/jira-stop on accept, then reloads the status and nudges the board', async () => {
    mount({ status: { live: SESSION() }, sessions: STOPPABLE() });
    await screen.findByText('not');
    await waitFor(() => expect(stopChip()).not.toBeNull());

    await userEvent.click(stopChip() as HTMLElement);
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));
    await waitFor(() => expect(onWrote).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
    const [{ url, init }] = posts();
    expect(url).toBe('/api/agents/jira-stop');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init?.body).toBe('{"key":"PAY-131","sessionId":"s1"}');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the server\'s sentence and reloads nothing when the stop is refused', async () => {
    post = () => json({ error: 'no live session on PAY-131' }, { status: 409 });
    mount({ status: { live: SESSION() }, sessions: STOPPABLE() });
    await screen.findByText('not');
    await waitFor(() => expect(stopChip()).not.toBeNull());

    await userEvent.click(stopChip() as HTMLElement);
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));
    expect(await screen.findByRole('alert')).toHaveTextContent('no live session on PAY-131');
    expect(reload).not.toHaveBeenCalled();
    expect(onWrote).not.toHaveBeenCalled();
  });

  it('is not drawn with agents off, for a starting entry, or with no session — and a key with none never asks the agents status', async () => {
    agentsStatus = { ...AGENTS_ON, enabled: false };
    const off = mount({ status: { live: SESSION() }, sessions: STOPPABLE() });
    await screen.findByText('not');
    await waitFor(() => expect(agentsReads()).toBeGreaterThan(0));
    expect(stopChip()).toBeNull();
    off.unmount();

    agentsStatus = AGENTS_ON;
    calls = [];
    const starting = mount({ status: { live: SESSION({ starting: true }) }, sessions: payload() });
    await screen.findByText('not');
    expect(stopChip()).toBeNull();
    expect(agentsReads()).toBe(0);
    starting.unmount();

    mount();
    await screen.findByText('not');
    expect(stopChip()).toBeNull();
    expect(agentsReads()).toBe(0);
  });
});

describe('JiraDetail — the agent column (Jira sessions, spec §7.3)', () => {
  it('draws one card per live session, newest first, and counts live and ended in its heading', async () => {
    mount({
      sessions: payload(
        link({ sessionId: 'old-one', startedAt: hoursAgo(5), stateSince: hoursAgo(5) }),
        link({ sessionId: 'new-one', startedAt: hoursAgo(1), stateSince: hoursAgo(1), how: 'branch', action: null, branch: 'PAY-131-refunds' }),
        link({ sessionId: 'gone-one', startedAt: hoursAgo(9), endedAt: hoursAgo(8), endReason: 'idle', state: 'ended' })
      )
    });
    await screen.findByText('not');
    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual(['Session new-one', 'Session old-one']);
    expect(within(screen.getByRole('dialog')).getByText('2 live · 1 ended')).toBeInTheDocument();
    // The strip says the state and how long it has held, in the one age the page uses everywhere.
    expect(within(cards()[1]).getByText('Working')).toBeInTheDocument();
    expect(within(cards()[1]).getByText(pollAge(hoursAgo(5), Date.now()) as string)).toBeInTheDocument();
  });

  it('draws the linked-how tag and the short id on each card, and names a waiting state without ever showing a question', async () => {
    mount({
      sessions: payload(
        link({ sessionId: '0123456789abcdef', how: 'manual', action: null, name: 'my own session', state: 'answer', row: row({ remoteQuestion: true }) })
      )
    });
    await screen.findByText('not');
    const [card] = cards();
    expect(within(card).getByText('linked by hand')).toBeInTheDocument();
    expect(within(card).getByText('0123…cdef')).toBeInTheDocument();
    expect(within(card).getByText('Waiting on your answer')).toBeInTheDocument();
  });

  it('offers Unlink only on a `branch` link, and posts `{ key, sessionId }` to jira-unlink, then reloads both reads and nudges the board', async () => {
    mount({
      sessions: payload(
        link({ sessionId: 'run-one', startedAt: hoursAgo(1), stateSince: hoursAgo(1) }),
        link({ sessionId: 'branch-one', how: 'branch', action: null, branch: 'PAY-131-x', startedAt: hoursAgo(2), stateSince: hoursAgo(2) })
      )
    });
    await screen.findByText('not');
    const [runCard, branchCard] = cards();
    expect(within(runCard).queryByRole('button', { name: 'Unlink' })).toBeNull();
    await userEvent.click(within(branchCard).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(onWrote).toHaveBeenCalledTimes(1));
    const [{ url, init }] = posts();
    expect(url).toBe('/api/agents/jira-unlink');
    expect(init?.body).toBe('{"key":"PAY-131","sessionId":"branch-one"}');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadSessions).toHaveBeenCalledTimes(1);
  });

  it('offers Stop only with a `stopState`, and the POST names the card\'s own session', async () => {
    mount({
      status: { live: SESSION() },
      sessions: payload(
        link({ sessionId: 'with-stop', startedAt: hoursAgo(1), stateSince: hoursAgo(1), row: row({ id: 'with-stop' }) }),
        link({ sessionId: 'no-stop', startedAt: hoursAgo(2), stateSince: hoursAgo(2), row: row({ id: 'no-stop', stopState: undefined }) }),
        link({ sessionId: 'no-row', startedAt: hoursAgo(3), stateSince: hoursAgo(3), row: null })
      )
    });
    await screen.findByText('not');
    await waitFor(() => expect(within(cards()[0]).queryByRole('button', { name: 'Stop session' })).not.toBeNull());
    expect(within(cards()[1]).queryByRole('button', { name: 'Stop session' })).toBeNull();
    expect(within(cards()[2]).queryByRole('button', { name: 'Stop session' })).toBeNull();

    await userEvent.click(within(cards()[0]).getByRole('button', { name: 'Stop session' }));
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe('/api/agents/jira-stop');
    expect(posts()[0].init?.body).toBe('{"key":"PAY-131","sessionId":"with-stop"}');
    await waitFor(() => expect(reloadSessions).toHaveBeenCalledTimes(1));
  });

  it('draws a `Starting…` card from the shell\'s reservation, which the sessions payload never carries', async () => {
    mount({ status: { live: SESSION({ starting: true }) }, sessions: payload() });
    await screen.findByText('not');
    const [card] = cards();
    expect(card).toHaveAttribute('aria-label', 'Session starting');
    expect(within(card).getByText('Starting…')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).toBeNull();
    expect(fact('Session')).toHaveTextContent(/^starting$/);
  });

  it('says so when no session is running, and reads from the shell\'s live entry until the sessions payload lands', async () => {
    const none = mount({ sessions: payload() });
    await screen.findByText('not');
    expect(within(screen.getByRole('dialog')).getByText('no session is running on this ticket')).toBeInTheDocument();
    none.unmount();

    // `sessions: null` is "not landed yet": no card can be drawn, but the fact and the Run gate still read the shell's entry (the old behaviour).
    mount({ status: { live: SESSION() } });
    await screen.findByText('not');
    expect(cards()).toHaveLength(0);
    expect(fact('Session')).toHaveTextContent('jira PAY-131 · pay · 3h');
    expect(modalRun()).toBeDisabled();
  });

  it('draws the history newest first, `<how> · ended <age> ago` with the age pollAge gives, and a Reopen on each', async () => {
    const run = hoursAgo(2);
    const branch = hoursAgo(5);
    mount({
      sessions: payload(
        link({ sessionId: 'older-br', how: 'branch', action: null, startedAt: hoursAgo(7), endedAt: branch, endReason: 'idle', state: 'ended' }),
        link({ sessionId: 'newer-run', startedAt: hoursAgo(3), endedAt: run, endReason: 'stopped', state: 'ended' })
      )
    });
    await screen.findByText('not');
    const items = Array.from(document.querySelectorAll<HTMLElement>('.jira-hist'));
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText(`run · ended ${pollAge(run, Date.now())} ago`)).toBeInTheDocument();
    expect(within(items[1]).getByText(`branch · ended ${pollAge(branch, Date.now())} ago`)).toBeInTheDocument();
    expect(pollAge(run, Date.now())).toBe('2h');
    expect(within(items[0]).getByRole('link', { name: 'Reopen' })).toHaveAttribute('href', expect.stringContaining('newer-run'));
    // An ended line has no live card, and draws no Unlink or Stop.
    expect(cards()).toHaveLength(0);
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Unlink' })).toBeNull();
  });

  it('keeps Run ▾ enabled with only a branch link live, and disables it for a live run link or a starting reservation', async () => {
    const branch = mount({ sessions: payload(link({ how: 'branch', action: null, branch: 'PAY-131-x' })) });
    await screen.findByText('not');
    expect(modalRun()).toBeEnabled();
    branch.unmount();

    const manual = mount({ sessions: payload(link({ how: 'manual', action: null })) });
    await screen.findByText('not');
    expect(modalRun()).toBeEnabled();
    manual.unmount();

    const run = mount({ sessions: payload(link()) });
    await screen.findByText('not');
    expect(modalRun()).toBeDisabled();
    expect(modalRun()).toHaveAttribute('title', 'a session is running on PAY-131');
    run.unmount();

    // An ENDED run link does not hold the gate, and a reservation does even though no link exists for it yet.
    const ended = mount({ sessions: payload(link({ endedAt: hoursAgo(1), endReason: 'idle', state: 'ended' })) });
    await screen.findByText('not');
    expect(modalRun()).toBeEnabled();
    ended.unmount();

    mount({ status: { live: SESSION({ starting: true }) }, sessions: payload() });
    await screen.findByText('not');
    expect(modalRun()).toBeDisabled();
  });

  it('draws Run ▾ after the cards and the history — last in the agent column', async () => {
    mount({ sessions: payload(link({ how: 'branch', action: null }), link({ sessionId: 'e1', endedAt: hoursAgo(1), state: 'ended', endReason: 'idle' })) });
    await screen.findByText('not');
    const column = document.querySelector('.jira-detail-agent') as HTMLElement;
    expect(column.lastElementChild).toContainElement(modalRun());
    expect(column.querySelector('.jira-hist-list')?.compareDocumentPosition(modalRun())).toBe(Node.DOCUMENT_POSITION_FOLLOWING | 0);
  });
});

describe('JiraDetail — Assign to me and Move to… (Jira phase 3)', () => {
  it('posts the assign as JSON with the key alone, then reloads the status, nudges the board and re-reads the detail', async () => {
    answer = () => json(detail({ assignee: null }));
    mount({ issue: UNASSIGNED });
    await screen.findByText('not');

    await userEvent.click(assignChip());
    await waitFor(() => expect(onWrote).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
    const [{ url, init }] = posts();
    expect(url).toBe('/api/jira/issue/assign');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init?.body).toBe('{"key":"PAY-131"}');
    expect(reload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reads('PAY-131')).toBe(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why Assign is disabled: no identity, or already yours', async () => {
    const view = mount({ status: { me: null }, issue: UNASSIGNED });
    answer = () => json(detail({ assignee: null }));
    await screen.findByText('not');
    expect(assignChip()).toBeDisabled();
    expect(assignChip()).toHaveAttribute('title', 'no identity');
    view.unmount();

    answer = () => json(detail());
    mount();
    await screen.findByText('not');
    expect(assignChip()).toBeDisabled();
    expect(assignChip()).toHaveAttribute('title', 'already assigned to you');
  });

  it('lists the offered transitions by the status each lands in, and a pick posts at once and returns to Move to…', async () => {
    answer = () => json(detail({ transitions: TRANSITIONS }));
    mount();
    await screen.findByText('not');
    const select = moveSelect();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Move to…', 'In Progress', 'Done']);

    await userEvent.selectOptions(select, '41');
    await waitFor(() => expect(onWrote).toHaveBeenCalledTimes(1));
    expect(posts().map((c) => [c.url, c.init?.body])).toEqual([['/api/jira/issue/transition', '{"key":"PAY-131","transitionId":"41"}']]);
    expect(moveSelect()).toHaveDisplayValue('Move to…');
  });

  // Two transitions landing in one status would read as two identical options, so only those two bring their own name back.
  it('names a transition only when another offered one lands in the same status', async () => {
    answer = () =>
      json(
        detail({
          transitions: [
            { id: '11', name: 'In testing', to: { name: 'In Testing', category: 'indeterminate' } },
            { id: '21', name: 'In Review', to: { name: 'In Review', category: 'indeterminate' } },
            { id: '22', name: 'In Review (2)', to: { name: 'In Review', category: 'indeterminate' } }
          ]
        })
      );
    mount();
    await screen.findByText('not');
    expect(Array.from(moveSelect().options).map((o) => o.textContent)).toEqual(['Move to…', 'In Testing', 'In Review', 'In Review (2)']);
  });

  it('disables Move while the detail is in flight, and with transitions unavailable once it failed — Assign stays usable', async () => {
    const slow = held();
    answer = () => slow.promise;
    const view = mount({ issue: UNASSIGNED });
    expect(moveSelect()).toBeDisabled();
    expect(moveSelect()).not.toHaveAttribute('title');
    view.unmount();

    answer = () => json({ error: 'Jira unreachable: timeout' }, { status: 502 });
    mount({ issue: UNASSIGNED });
    await screen.findByText('could not read the ticket — Jira unreachable: timeout');
    expect(moveSelect()).toBeDisabled();
    expect(moveSelect()).toHaveAttribute('title', 'transitions unavailable');
    expect(assignChip()).toBeEnabled();
  });

  it('disables Move for a detail that offers no transition', async () => {
    mount();
    await screen.findByText('not');
    expect(moveSelect()).toBeDisabled();
  });

  it("draws a refusal's own sentence in an alert, keeps the modal open and both controls usable, and nudges nothing", async () => {
    answer = () => json(detail({ assignee: null, transitions: TRANSITIONS }));
    post = () => json({ error: 'Jira refused: User cannot be assigned' }, { status: 409 });
    mount({ issue: UNASSIGNED });
    await screen.findByText('not');

    await userEvent.click(assignChip());
    expect(await screen.findByRole('alert')).toHaveTextContent('Jira refused: User cannot be assigned');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(assignChip()).toBeEnabled();
    expect(moveSelect()).toBeEnabled();
    expect(onWrote).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(reads('PAY-131')).toBe(1);
  });

  it("falls back to HTTP <status>, then to the network's message, and the next write clears the line", async () => {
    answer = () => json(detail({ assignee: null }));
    post = () => ({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('not JSON')) }) as unknown as Response;
    mount({ issue: UNASSIGNED });
    await screen.findByText('not');

    await userEvent.click(assignChip());
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502');

    const dropped = held();
    post = () => dropped.promise;
    await userEvent.click(assignChip());
    // Cleared the moment the next write leaves, not when it settles: the line describes the last attempt, and that one is still out.
    expect(screen.queryByRole('alert')).toBeNull();
    post = () => Promise.reject(new TypeError('Failed to fetch'));
    await act(async () => dropped.release(json({ ok: true, reread: true })));
    await userEvent.click(assignChip());
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });

  // Review Focus 1: the guard is a ref, so two clicks dispatched before React re-renders — both inside one act — cannot both pass a `disabled` that has
  // not been painted yet. A state-only guard sends three POSTs here.
  it('sends exactly one POST for a double click and a Move pick while that write is out', async () => {
    answer = () => json(detail({ assignee: null, transitions: TRANSITIONS }));
    const out = held();
    post = () => out.promise;
    mount({ issue: UNASSIGNED });
    await screen.findByText('not');

    act(() => {
      assignChip().click();
      assignChip().click();
      fireEvent.change(moveSelect(), { target: { value: '41' } });
    });
    expect(posts()).toHaveLength(1);
    expect(assignChip()).toBeDisabled();
    expect(moveSelect()).toBeDisabled();
    fireEvent.change(moveSelect(), { target: { value: '31' } });
    expect(posts()).toHaveLength(1);

    await act(async () => out.release(json({ ok: true, reread: true })));
    await waitFor(() => expect(onWrote).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  // Ruling R8: the re-read after a write is a refresh, not a reopen — the last detail of the same key stays on screen while it is out.
  it('keeps the description on screen, with no loading line, while the re-read after a write is out', async () => {
    let n = 0;
    const reread = held();
    answer = () => (++n === 1 ? json(detail({ assignee: null })) : reread.promise);
    mount({ issue: UNASSIGNED });
    await screen.findByText('not');

    await userEvent.click(assignChip());
    await waitFor(() => expect(reads('PAY-131')).toBe(2));
    expect(screen.getByText('not')).toBeInTheDocument();
    expect(screen.queryByText('loading…')).toBeNull();

    await act(async () => reread.release(json(detail({ assignee: ADA, description: 'Now **assigned**.' }))));
    expect(await screen.findByText('assigned')).toBeInTheDocument();
    expect(fact('Assignee')).toHaveTextContent('Ada Lovelace');
    expect(assignChip()).toHaveAttribute('title', 'already assigned to you');
  });

  // Review Focus 5's client half: `reread: false` says the SERVER's re-read failed after the write landed. That is a 200 and the write stood — no alert,
  // the board still nudged, and the modal's own re-read still goes out.
  it('treats a landed write whose server re-read failed as a success', async () => {
    answer = () => json(detail({ assignee: null }));
    post = () => json({ ok: true, reread: false });
    mount({ issue: UNASSIGNED });
    await screen.findByText('not');

    await userEvent.click(assignChip());
    await waitFor(() => expect(onWrote).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reads('PAY-131')).toBe(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('JiraDetail — the exit', () => {
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
        <JiraSessionsProvider open>
          <JiraView onOpenJiraPage={jest.fn()} />
        </JiraSessionsProvider>
      </JiraContext.Provider>
    );

    await userEvent.click(await screen.findByRole('button', { name: /Refund partial captures/ }));
    expect(await screen.findByRole('dialog', { name: 'PAY-131 Refund partial captures' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // The sheet is hosted by JiraView and mounted after the modal, so it is the topmost entry of the one dialog stack: Escape closes it and leaves the modal.
  it('with the launch sheet open over the modal, Escape closes only the sheet, and the next one closes the modal', async () => {
    window.localStorage.clear();
    setJiraPage('board');
    const board = status();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/agents/status') return json(AGENTS_ON);
      if (url.startsWith('/api/jira/prompt')) return json('a prompt');
      if (url.startsWith('/api/jira/issue/')) return json(detail());
      if (url.includes('/issues')) return json({ issues: [CARD], polledAt: daysAgoStamp(0) });
      return json(board);
    }) as unknown as typeof fetch;
    render(
      <SettingsProvider>
        <JiraContext.Provider value={{ data: board, loading: false, error: false, reload: () => {} }}>
          <JiraSessionsProvider open>
            <JiraView onOpenJiraPage={jest.fn()} />
          </JiraSessionsProvider>
        </JiraContext.Provider>
      </SettingsProvider>
    );

    await userEvent.click(await screen.findByRole('button', { name: /Refund partial captures/ }));
    const modal = await screen.findByRole('dialog', { name: 'PAY-131 Refund partial captures' });
    await userEvent.click(within(modal).getByRole('button', { name: 'Run options for PAY-131' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: new RegExp(JIRA_BUILTIN_LABELS.execute) }));
    expect(await screen.findByRole('dialog', { name: 'run PAY-131' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'run PAY-131' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'PAY-131 Refund partial captures' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
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

  /** JiraView over GROUP, each issue's detail answered by its URL; returns the URLs requested. A POST is answered by `onPost`, and is not in the list. */
  function mountView(
    details: Record<string, Partial<JiraIssueDetail>>,
    onPost: () => Promise<Response> = async () => json({ ok: true, reread: true })
  ): string[] {
    window.localStorage.clear();
    setJiraPage('board');
    const board = status();
    const requested: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return onPost();
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
        <JiraSessionsProvider open>
          <JiraView onOpenJiraPage={jest.fn()} />
        </JiraSessionsProvider>
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

  // Review Focus 2: the write is stamped with the key it was sent for. Swapped to a child while it is out, the late answer neither draws its refusal on the
  // child nor re-reads the parent's detail into a modal that no longer shows it.
  it('drops a late refusal for the issue the modal has since swapped away from', async () => {
    const out = held();
    const requested = mountView({ 'PAY-120': { children: [G_160, G_170], assignee: null } }, () => out.promise);
    await userEvent.click(await screen.findByRole('button', { name: /Payments epic/ }));
    await screen.findByRole('heading', { name: 'Children' });
    await waitFor(() => expect(assignChip()).toBeEnabled());

    await userEvent.click(assignChip());
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /PAY-160/ }));
    await screen.findByRole('dialog', { name: 'PAY-160 Ledger story' });
    const before = reads('PAY-120', requested);

    await act(async () => out.release(json({ error: 'Jira refused: User cannot be assigned' }, { status: 409 })));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(reads('PAY-120', requested)).toBe(before);
  });

  it("re-reads nothing of the old key after a swap, but a landed write still nudges the board's list", async () => {
    const out = held();
    const requested = mountView({ 'PAY-120': { children: [G_160, G_170], assignee: null } }, () => out.promise);
    await userEvent.click(await screen.findByRole('button', { name: /Payments epic/ }));
    await screen.findByRole('heading', { name: 'Children' });
    await waitFor(() => expect(assignChip()).toBeEnabled());

    await userEvent.click(assignChip());
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /PAY-160/ }));
    await screen.findByRole('dialog', { name: 'PAY-160 Ledger story' });
    const before = reads('PAY-120', requested);
    const lists = (): number => requested.filter((u) => u.includes('/issues')).length;
    const listsBefore = lists();

    await act(async () => out.release(json({ ok: true, reread: true })));
    await waitFor(() => expect(lists()).toBe(listsBefore + 1));
    expect(reads('PAY-120', requested)).toBe(before);
    expect(reads('PAY-160', requested)).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
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
        <JiraSessionsProvider open>
          <JiraView onOpenJiraPage={jest.fn()} />
        </JiraSessionsProvider>
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

/* The Worktrees list (Jira repo/branch, spec §5.5; DESIGN.md §8.9.2): the trees this ticket has, each with a Remove that only copies the command — the board
   never writes git — and is off while the board knows of a session on the key. The main tree never gets a row. */
describe('JiraDetail — Worktrees (Jira repo/branch)', () => {
  const PAY_TREE = { repo: '/Users/ada/pay', path: '/Users/ada/pay/.worktrees/PAY-131-refund', branch: 'PAY-131-refund', main: false };
  const worktreeCalls = (): number => calls.filter((c) => c.url === '/api/jira/worktrees').length;
  const section = async (): Promise<HTMLElement> => {
    const heading = await screen.findByRole('heading', { name: 'Worktrees' });
    return heading.closest('section') as HTMLElement;
  };
  const setClipboard = (value: { writeText: jest.Mock } | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  };
  afterEach(() => setClipboard(undefined));

  it('lists the ticket\'s trees — branch, path and repo through displayPath — and never the main tree or another ticket\'s', async () => {
    worktrees = () =>
      json({
        worktrees: [
          { ...PAY_TREE, branch: 'main', path: '/Users/ada/pay', main: true },
          PAY_TREE,
          { ...PAY_TREE, branch: 'PAY-999-other', path: '/Users/ada/pay/.worktrees/PAY-999-other' }
        ],
        unavailable: []
      });
    mount();
    const rows = within(await section()).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('PAY-131-refund');
    expect(rows[0]).toHaveTextContent('~/pay/.worktrees/PAY-131-refund');
    expect(rows[0]).toHaveTextContent('~/pay');
    expect(worktreeCalls()).toBe(1);
  });

  it('draws no Worktrees heading when the ticket has no tree, and none when the read fails', async () => {
    mount();
    await screen.findByText('not');
    expect(screen.queryByRole('heading', { name: 'Worktrees' })).toBeNull();
    expect(worktreeCalls()).toBe(1);

    cleanup();
    worktrees = () => json({ error: 'git down' }, { status: 502 });
    mount();
    await screen.findByText('not');
    await waitFor(() => expect(worktreeCalls()).toBe(2));
    expect(screen.queryByRole('heading', { name: 'Worktrees' })).toBeNull();
  });

  it('Remove copies the quoted command, with no --force, and runs nothing', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const odd = { ...PAY_TREE, repo: '/Users/ada/my repos/pay', path: "/Users/ada/my repos/pay/.worktrees/it's-PAY-131", branch: "it's-PAY-131" };
    worktrees = () => json({ worktrees: [odd], unavailable: [] });
    mount();
    const remove = within(await section()).getByRole('button', { name: /^Remove/ });
    expect(remove).toBeEnabled();
    expect(remove).toHaveAttribute(
      'title',
      'Copies the command. Sessions the board did not start — Copy prompt, a terminal — cannot be seen: make sure none is using this tree.'
    );
    await userEvent.click(remove);
    expect(writeText).toHaveBeenCalledWith(
      "git -C '/Users/ada/my repos/pay' worktree remove '/Users/ada/my repos/pay/.worktrees/it'\\''s-PAY-131'"
    );
    expect(writeText.mock.calls[0][0]).not.toContain('--force');
    expect(await within(await section()).findByText('Copied')).toBeInTheDocument();
    // Nothing was sent anywhere: no POST, and no other route asked.
    expect(posts()).toEqual([]);
  });

  it('shows the command itself when the clipboard refuses or does not exist', async () => {
    worktrees = () => json({ worktrees: [PAY_TREE], unavailable: [] });
    setClipboard({ writeText: jest.fn().mockRejectedValue(new Error('denied')) });
    mount();
    await userEvent.click(within(await section()).getByRole('button', { name: /^Remove/ }));
    expect(await within(await section()).findByText("git -C '/Users/ada/pay' worktree remove '/Users/ada/pay/.worktrees/PAY-131-refund'")).toBeInTheDocument();
  });

  it('disables Remove, titled with the key, while a session is live on it, and enables it again when the session goes', async () => {
    worktrees = () => json({ worktrees: [PAY_TREE], unavailable: [] });
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
    const view = mount({ status: { live: SESSION() } });
    const remove = within(await section()).getByRole('button', { name: /^Remove/ });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'a session is running on PAY-131');
    expect(remove.closest('.jira-wt-row')).not.toBeNull();

    view.rerender(
      <JiraContext.Provider value={{ data: status({ live: {} }), loading: false, error: false, reload }}>
        <JiraDetail issue={CARD} childrenOf={null} onOpenIssue={onOpenIssue} onWrote={onWrote} onRun={onRun} onClose={() => {}} />
      </JiraContext.Provider>
    );
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: /^Remove/ })).toBeEnabled());
  });
});
