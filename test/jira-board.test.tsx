/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraBoardView } from '../client/src/components/jira/JiraBoardView';
import JiraView from '../client/src/components/jira/JiraView';
import { JiraProvider } from '../client/src/hooks/JiraContext';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { setJiraPage } from '../client/src/hooks/useJiraPage';
import { JIRA_BOARD_KEY, bandSub } from '../client/src/lib/jira';
import { JIRA_PAGE_KEY } from '../client/src/lib/jira-page';
import { daysAgoStamp } from './helpers/dates';
import { JIRA_BUILTIN_LABELS, type AgentsStatus, type JiraBoardStatus, type JiraIssue, type JiraStatusPayload } from '../shared/types';

/*
  Jira › Board (Jira phase 2; spec §6.2; DESIGN.md §8.9.1) — the real page over a mocked `fetch`, in the style of `tracker-board.test.tsx`: the band
  and its picker, the three filters and the summary search, the three status-category columns and the card face, and the two shapes that must never be
  confused with an empty site — a `jira.json` that cannot be read (Review Focus 2) and a stored board pick that names no board (Review Focus 3).

  The page reads `GET /api/jira` through the real `JiraProvider` and one board's list through the real `useJiraBoard`; both are answered here, and every
  URL the page asks for is recorded, because two of the cases below are about a request that must NOT be made. Fixture stamps are relative to the clock the
  assertion runs under (`test/helpers/dates.ts`, guarded by `test/fixture-clock.test.ts`).
*/

const ADA = { accountId: 'acc-ada', name: 'Ada Lovelace' };
const GRACE = { accountId: 'acc-grace', name: 'Grace Hopper' };

function issue(over: Partial<JiraIssue>): JiraIssue {
  const key = over.key ?? 'PAY-1';
  return {
    key,
    id: `1${key.replace(/\D/g, '')}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `Summary of ${key}`,
    project: { key: 'PAY', name: 'Payments' },
    type: { name: 'Task', level: 0, subtask: false },
    status: { name: 'To Do', category: 'new' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: daysAgoStamp(10),
    updated: daysAgoStamp(1),
    resolved: null,
    ...over
  };
}

/* The first board's list. Each issue is there for a reading: PAY-131 is the full card face (a parent crumb, `In Review`, `High`) — its parent is OFF the
   board, so it stays a card of its own rather than folding (grouped-board spec §3); PAY-120 the board's root (nobody, no sprint), PAY-140 the Done column (another person, another sprint, a Bug), PAY-151 the `Assigned to me` crumb and the
   newest card in To Do, so the column's order is a fact about `updated` and not about list order. */
const PAY_131 = issue({
  key: 'PAY-131',
  summary: 'Refund partial captures',
  type: { name: 'Story', level: 0, subtask: false },
  status: { name: 'In Review', category: 'indeterminate' },
  priority: 'High',
  assignee: ADA,
  parent: { key: 'PAY-99', summary: 'Payments platform' },
  subtasks: 2,
  sprint: 'Sprint 42',
  updated: daysAgoStamp(1)
});
const PAY_120 = issue({
  key: 'PAY-120',
  summary: 'Refund flows',
  type: { name: 'Epic', level: 1, subtask: false },
  subtasks: 1,
  updated: daysAgoStamp(2)
});
const PAY_140 = issue({
  key: 'PAY-140',
  summary: 'Currency symbol missing on receipts',
  type: { name: 'Bug', level: 0, subtask: false },
  status: { name: 'Done', category: 'done' },
  assignee: GRACE,
  sprint: 'Sprint 41',
  updated: daysAgoStamp(3),
  resolved: daysAgoStamp(3)
});
const PAY_151 = issue({
  key: 'PAY-151',
  summary: 'Rounding wrong on invoices over 1,000',
  status: { name: 'Backlog', category: 'new' },
  assignee: ADA,
  sprint: 'Sprint 42',
  updated: daysAgoStamp(0)
});
const ALPHA_ISSUES = [PAY_120, PAY_131, PAY_140, PAY_151];
const BETA_ISSUES = [issue({ key: 'OPS-7', summary: 'Beta only issue' })];

function board(over: Partial<JiraBoardStatus>): JiraBoardStatus {
  return {
    id: 'b_00000001',
    name: 'Alpha board',
    roots: [],
    queries: [],
    interval: '1m',
    polledAt: new Date(Date.now() - 12_000).toISOString(),
    count: 0,
    truncated: false,
    failures: [],
    ...over
  };
}

/* Polled ten and a half minutes ago, so the band's age reads `10m` for the whole of a case rather than ticking through seconds between the render and the
   assertion's own `bandSub` call. */
const ALPHA = board({
  id: 'b_000a1fa0',
  name: 'Alpha board',
  roots: ['PAY-120'],
  queries: [{ id: 'q_00000001', label: 'Mine', jql: 'assignee = currentUser()' }],
  count: 4,
  polledAt: new Date(Date.now() - 630_000).toISOString()
});
const BETA = board({ id: 'b_000be7a0', name: 'Beta board', count: 1 });

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: ADA,
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    // Beta listed FIRST, so "the first board by name" (Alpha) is never also "the first board in the payload".
    boards: [BETA, ALPHA],
    repos: {},
    repoDefaults: {},
    projects: [],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/home/ada',
    ...over
  };
}

let statusAnswer: JiraStatusPayload;
let lists: Record<string, JiraIssue[]>;
let requested: string[];

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(typeof body === 'string' ? body : '') } as Response);

/** What `GET /api/agents/status` answers — the launch sheet asks it on open, and the Run cases below open it. */
const AGENTS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'acceptEdits',
  projectPaths: ['/Users/ada/pay']
};

beforeEach(() => {
  localStorage.clear();
  statusAnswer = status();
  lists = { [ALPHA.id]: ALPHA_ISSUES, [BETA.id]: BETA_ISSUES };
  requested = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === '/api/jira') return ok(statusAnswer);
    const m = /^\/api\/jira\/boards\/([^/]+)\/issues$/.exec(url);
    if (m !== null) {
      const id = decodeURIComponent(m[1]);
      const board = statusAnswer.boards.find((b) => b.id === id);
      return ok({ issues: lists[id] ?? [], polledAt: board?.polledAt ?? null });
    }
    if (url === '/api/agents/status') return ok(AGENTS);
    if (url.startsWith('/api/jira/prompt')) return ok('a prompt');
    // The launch sheet's Branch section reads the repository's branches before it lets an execute Start: a readable repo with a default base, so the sheet
    // opens on a New branch it will launch (a `{}` would be a failed read — the unavailable form, with no base and Start refused for it).
    if (url.startsWith('/api/jira/refs')) {
      const repo = new URL(url, 'http://x').searchParams.get('repo');
      return ok({ repo, available: true, fetchedAt: null, mainBranch: 'develop', defaultBase: 'develop', branches: [] });
    }
    return ok({});
  }) as unknown as typeof fetch;
});

const storeBoard = (raw: unknown): void => localStorage.setItem(JIRA_BOARD_KEY, JSON.stringify(raw));
const boardRequests = (): string[] => requested.filter((u) => u.startsWith('/api/jira/boards/'));

let onOpenIssue: jest.Mock;
let onOpenJiraPage: jest.Mock;

function renderPage(): void {
  onOpenIssue = jest.fn();
  onOpenJiraPage = jest.fn();
  render(
    <JiraProvider>
      <JiraBoardView onOpenJiraPage={onOpenJiraPage} onOpenIssue={onOpenIssue} onRun={jest.fn()} nudge={0} />
    </JiraProvider>
  );
}

async function renderAlpha(): Promise<void> {
  renderPage();
  await screen.findByText('Refund partial captures');
}

function card(summary: string): HTMLElement {
  return screen.getByText(summary).closest('.board-card') as HTMLElement;
}

const column = (label: string): HTMLElement =>
  screen.getAllByTestId('board-col').find((c) => within(c).getByTestId('col-name').textContent === label) as HTMLElement;
const summariesIn = (label: string): string[] =>
  Array.from(column(label).querySelectorAll('.board-card-title')).map((t) => t.textContent ?? '');
const visibleSummaries = (): string[] => Array.from(document.querySelectorAll('.board-card-title')).map((t) => t.textContent ?? '');

async function openFilters(): Promise<HTMLElement> {
  const open = screen.queryByRole('dialog', { name: 'Filters' });
  if (open !== null) return open;
  await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  return screen.getByRole('dialog', { name: 'Filters' });
}

async function pick(group: 'Type' | 'Assignee' | 'Sprint', name: string): Promise<void> {
  const dialog = await openFilters();
  await userEvent.click(within(within(dialog).getByRole('group', { name: group })).getByRole('button', { name }));
}

describe('which board the page draws', () => {
  it('fetches the stored board, and only that board', async () => {
    storeBoard(BETA.id);
    renderPage();
    await screen.findByText('Beta only issue');
    expect(screen.getByRole('heading', { name: 'Beta board' })).toBeInTheDocument();
    expect(new Set(boardRequests())).toEqual(new Set([`/api/jira/boards/${BETA.id}/issues`]));
  });

  // Review Focus 3: a pick naming a board that is gone — deleted here or in another browser — or garbage falls to the first board by NAME, and the page
  // never asks the server for the stored id: `useJiraBoard` is handed only an id taken from the board list.
  it.each([['b_deadbeef'], [{ x: 1 }], [7]])('a stored pick of %p falls to the first board by name and is never requested', async (stored) => {
    storeBoard(stored);
    renderPage();
    await screen.findByText('Refund partial captures');
    expect(screen.getByRole('heading', { name: 'Alpha board' })).toBeInTheDocument();
    expect(boardRequests().every((u) => u === `/api/jira/boards/${ALPHA.id}/issues`)).toBe(true);
    expect(requested.some((u) => u.includes('deadbeef'))).toBe(false);
  });

  it('with no stored pick, draws the first board by name — not the first in the payload', async () => {
    await renderAlpha();
    expect(screen.getByRole('heading', { name: 'Alpha board' })).toBeInTheDocument();
  });

  it('picking another board in the picker stores it and fetches its list; the popover holds board names and nothing else', async () => {
    await renderAlpha();
    await userEvent.click(screen.getByRole('button', { name: 'Pick a Jira board: Alpha board' }));
    const pop = screen.getByRole('dialog', { name: 'Boards' });
    expect(within(pop).getAllByRole('button').map((b) => b.textContent)).toEqual(['Alpha board', 'Beta board']);
    expect(within(pop).queryByRole('button', { name: /edit|new/i })).toBeNull();
    expect(within(pop).getByRole('button', { name: 'Alpha board' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(pop).getByRole('button', { name: 'Beta board' }));
    await screen.findByText('Beta only issue');
    expect(JSON.parse(localStorage.getItem(JIRA_BOARD_KEY) ?? 'null')).toBe(BETA.id);
    expect(boardRequests()).toContain(`/api/jira/boards/${BETA.id}/issues`);
    expect(screen.getByRole('heading', { name: 'Beta board' })).toBeInTheDocument();
    expect(screen.queryByText('Refund partial captures')).toBeNull();
  });
});

describe('the band', () => {
  it('reads bandSub’s text for the board under the title', async () => {
    await renderAlpha();
    const sub = bandSub(ALPHA, 'acme.atlassian.net', Date.now(), { issues: 4, cards: 4 });
    expect(sub.text).toBe('acme.atlassian.net · 4 issues from 1 root and 1 query · polled 10m ago');
    expect(document.querySelector('.ui-band-sub')?.textContent).toBe(sub.text);
    expect(document.querySelector('.jira-band-sub')).not.toHaveClass('failing');
  });

  it('draws a failing board’s sub with the failing class and Jira’s message', async () => {
    statusAnswer = status({ boards: [BETA, { ...ALPHA, failures: [{ kind: 'query', id: 'q_00000001', message: "Field 'foo' does not exist" }] }] });
    await renderAlpha();
    const sub = document.querySelector('.jira-band-sub') as HTMLElement;
    expect(sub).toHaveClass('failing');
    expect(sub.textContent).toContain("Field 'foo' does not exist");
  });
});

describe('the columns', () => {
  it('draws To Do, In Progress and Done with their counts, Done holding the done issue, newest first', async () => {
    await renderAlpha();
    expect(screen.getAllByTestId('col-name').map((n) => n.textContent)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(screen.getAllByTestId('col-count').map((n) => n.textContent)).toEqual(['2', '1', '1']);
    expect(summariesIn('Done')).toEqual(['Currency symbol missing on receipts']);
    // PAY-151 was updated today and PAY-120 two days ago — the list order (PAY-120 first) must not survive.
    expect(summariesIn('To Do')).toEqual(['Rounding wrong on invoices over 1,000', 'Refund flows']);
  });

  it('a board with no issues draws its three columns, empty', async () => {
    lists[ALPHA.id] = [];
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('col-count').map((n) => n.textContent)).toEqual(['0', '0', '0']));
    expect(screen.queryByText('No boards yet')).toBeNull();
  });
});

describe('the card', () => {
  it('draws the key, crumb, summary, person, raw status and priority', async () => {
    await renderAlpha();
    const c = card('Refund partial captures');
    expect(within(c).getByText('PAY-131')).toBeInTheDocument();
    expect(within(c).getByText('↳ PAY-99 Payments platform')).toBeInTheDocument();
    expect(within(c).getByText('AL')).toBeInTheDocument();
    expect(within(c).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(c).getByText('In Review')).toBeInTheDocument();
    expect(within(c).getByText('High')).toBeInTheDocument();
    expect(within(c).getByTitle('Story')).toBeInTheDocument();
  });

  it('reads `root` for a root, `Assigned to me` for my own, and `unassigned`', async () => {
    await renderAlpha();
    expect(within(card('Refund flows')).getByText('root')).toBeInTheDocument();
    expect(within(card('Refund flows')).getByText('unassigned')).toBeInTheDocument();
    expect(within(card('Rounding wrong on invoices over 1,000')).getByText('Assigned to me')).toBeInTheDocument();
  });

  // Grouped-board spec §4: the `N subtasks` marker is gone. `JiraIssue.subtasks` counts Jira subtasks on the board or not, which is not this board's
  // business — what sits under a card is the fold block's to say. PAY-131 and PAY-120 both carry a non-zero `subtasks`, so this is not vacuous.
  it('draws no subtask count anywhere', async () => {
    await renderAlpha();
    expect(document.querySelector('.board-columns')?.textContent).not.toMatch(/subtask/);
  });

  // The browser never talks to Jira: initials, never an avatar image; the link out is the server's own `url`, opened in a new tab with no referrer.
  it('draws no image anywhere, and links out to the issue’s url as given', async () => {
    await renderAlpha();
    expect(document.querySelectorAll('img')).toHaveLength(0);
    const link = within(card('Refund partial captures')).getByRole('link', { name: /open PAY-131 in Jira/ });
    expect(link).toHaveAttribute('href', PAY_131.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('a click opens the issue, and the link out does not', async () => {
    await renderAlpha();
    await userEvent.click(card('Refund partial captures'));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    expect(onOpenIssue).toHaveBeenCalledWith(PAY_131, expect.any(Map));

    await userEvent.click(within(card('Refund flows')).getByRole('link'));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);

    card('Refund flows').focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenIssue).toHaveBeenLastCalledWith(PAY_120, expect.any(Map));
  });
});

describe('filters and search', () => {
  const ALL = [
    'Rounding wrong on invoices over 1,000',
    'Refund flows',
    'Refund partial captures',
    'Currency symbol missing on receipts'
  ].sort();
  const shown = (): string[] => [...visibleSummaries()].sort();

  it('assignee: me shows my cards, unassigned only the nobody’s; Clear all restores', async () => {
    await renderAlpha();
    await pick('Assignee', 'me');
    expect(shown()).toEqual(['Refund partial captures', 'Rounding wrong on invoices over 1,000']);
    await pick('Assignee', 'unassigned');
    expect(shown()).toEqual(['Refund flows']);
    await userEvent.click(within(await openFilters()).getByRole('button', { name: 'Clear all' }));
    expect(shown()).toEqual(ALL);
  });

  it('assignee offers no `me` while the identity is unknown', async () => {
    statusAnswer = status({ me: null });
    await renderAlpha();
    const group = within(await openFilters()).getByRole('group', { name: 'Assignee' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['anyone', 'unassigned']);
  });

  it('type and sprint narrow from the loaded list’s own values, `no sprint` included', async () => {
    await renderAlpha();
    const dialog = await openFilters();
    expect(within(within(dialog).getByRole('group', { name: 'Type' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All types',
      'Bug',
      'Epic',
      'Story',
      'Task'
    ]);
    expect(within(within(dialog).getByRole('group', { name: 'Sprint' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All sprints',
      'Sprint 41',
      'Sprint 42',
      'no sprint'
    ]);
    await pick('Type', 'Bug');
    expect(shown()).toEqual(['Currency symbol missing on receipts']);
    await pick('Type', 'All types');
    await pick('Sprint', 'no sprint');
    expect(shown()).toEqual(['Refund flows']);
    await pick('Sprint', 'Sprint 42');
    expect(shown()).toEqual(['Refund partial captures', 'Rounding wrong on invoices over 1,000']);
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeInTheDocument();
  });

  it('the search matches the summary or the key, case-insensitively; clearing it restores every card', async () => {
    await renderAlpha();
    const search = screen.getByRole('searchbox', { name: 'Search issues' });
    await userEvent.type(search, 'refund');
    expect(shown()).toEqual(['Refund flows', 'Refund partial captures']);
    await userEvent.clear(search);
    await userEvent.type(search, 'pay-12');
    expect(shown()).toEqual(['Refund flows']);
    await userEvent.clear(search);
    expect(shown()).toEqual(ALL);
  });

  // A pick the current list no longer offers reads as "any" (`effectiveBoardFilters`): switching boards must not leave the columns emptied by a filter the
  // panel cannot even draw a chip for any more.
  it('a type pick the next board does not carry reads as any, and lights no badge', async () => {
    await renderAlpha();
    await pick('Type', 'Story');
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Pick a Jira board/ }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Boards' })).getByRole('button', { name: 'Beta board' }));
    await screen.findByText('Beta only issue');
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('writes nothing to localStorage — filters and the search are per mount', async () => {
    await renderAlpha();
    const before = { ...localStorage };
    // The spread does enumerate the store: the page's own pick key is in it (written on mount, as `usePersistedState` does), so `{}` is not a free pass.
    expect(Object.keys(before)).toContain(JIRA_BOARD_KEY);
    await pick('Assignee', 'me');
    await pick('Type', 'Story');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'refund');
    expect({ ...localStorage }).toEqual(before);
  });
});

describe('the shapes that are not a board', () => {
  it('no boards: `No boards yet`, and its chip opens Setup', async () => {
    statusAnswer = status({ boards: [] });
    onOpenIssue = jest.fn();
    render(
      <JiraProvider>
        <JiraBoardView onOpenJiraPage={setJiraPage} onOpenIssue={onOpenIssue} onRun={jest.fn()} nudge={0} />
      </JiraProvider>
    );
    await screen.findByText('No boards yet');
    expect(screen.queryByRole('button', { name: /Pick a Jira board/ })).toBeNull();
    expect(boardRequests()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Open Setup' }));
    expect(JSON.parse(localStorage.getItem(JIRA_PAGE_KEY) ?? 'null')).toBe('setup');
  });

  // Review Focus 2: a `jira.json` that stopped parsing is not an empty site. The status still says `configured: true` (the credentials are in `.env`), with
  // no boards because none could be read — and the page must say WHY rather than invite a reader to create a board the server would refuse to write.
  it('an unreadable jira.json reads `jira.json cannot be read — <reason>`, never `No boards yet`, and draws no picker', async () => {
    statusAnswer = status({ boards: [], configUnreadable: 'does not parse as JSON' });
    renderPage();
    await screen.findByText('jira.json cannot be read — does not parse as JSON');
    expect(screen.queryByText('No boards yet')).toBeNull();
    expect(screen.queryByRole('button', { name: /Pick a Jira board/ })).toBeNull();
    expect(boardRequests()).toEqual([]);
  });
});

// The section's two pages are switched by the rail's tree alone (spec §6.1, CLAUDE.md "Settings is two pages…"): the real Board page, drawn through the
// real `JiraView` inside a `main`, holds no control that restates that choice.
it('draws no page switch inside main', async () => {
  render(
    <main>
      <JiraProvider>
        <JiraView onOpenJiraPage={jest.fn()} />
      </JiraProvider>
    </main>
  );
  await screen.findByText('Refund partial captures');
  const main = document.querySelector('main') as HTMLElement;
  expect(within(main).queryByRole('button', { name: /^(Board|Setup)$/ })).toBeNull();
  expect(within(main).queryByRole('tab')).toBeNull();
  expect(within(main).queryByRole('tablist')).toBeNull();
  // And the card's click goes to the slot the issue modal fills — no throw, no dialog from this page alone.
  await act(async () => {
    card('Refund partial captures').click();
  });
});

/*
  Grouped-board spec §3–§4: the board draws one card per TOP issue, and every on-board descendant folds into its topmost on-board ancestor. GROUP is the
  shape the user's own board has — an epic root with stories under it and sub-tasks under those — plus a standalone task and a story whose parent is off
  the board. Served for ALPHA's id, with ALPHA's status `count` left at 4, so the band case can tell the loaded list (7) from the status poll (4).
*/
describe('the fold', () => {
  const G_120 = issue({ key: 'PAY-120', summary: 'Payments epic', type: { name: 'Epic', level: 1, subtask: false }, updated: daysAgoStamp(5) });
  const G_160 = issue({
    key: 'PAY-160',
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'In Progress', category: 'indeterminate' },
    parent: { key: 'PAY-120', summary: 'Payments epic' },
    updated: daysAgoStamp(4)
  });
  const G_161 = issue({
    key: 'PAY-161',
    type: { name: 'Sub-task', level: -1, subtask: true },
    status: { name: 'Done', category: 'done' },
    parent: { key: 'PAY-160', summary: 'Summary of PAY-160' },
    updated: daysAgoStamp(3),
    resolved: daysAgoStamp(3)
  });
  const G_162 = issue({
    key: 'PAY-162',
    summary: 'Ledger rounding fix',
    type: { name: 'Sub-task', level: -1, subtask: true },
    parent: { key: 'PAY-160', summary: 'Summary of PAY-160' },
    updated: daysAgoStamp(0)
  });
  const G_170 = issue({
    key: 'PAY-170',
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'Done', category: 'done' },
    parent: { key: 'PAY-120', summary: 'Payments epic' },
    updated: daysAgoStamp(6),
    resolved: daysAgoStamp(6)
  });
  const G_180 = issue({ key: 'PAY-180', summary: 'Standalone task', updated: daysAgoStamp(1) });
  const G_190 = issue({
    key: 'PAY-190',
    summary: 'Payout retries',
    status: { name: 'In Progress', category: 'indeterminate' },
    parent: { key: 'PAY-999', summary: 'Billing platform' },
    updated: daysAgoStamp(2)
  });
  const GROUP = [G_120, G_160, G_161, G_162, G_170, G_180, G_190];

  async function renderGroup(): Promise<void> {
    lists[ALPHA.id] = GROUP;
    renderPage();
    await screen.findByText('Standalone task');
  }

  it('draws tops only: column counts count cards, and no folded issue is drawn anywhere', async () => {
    await renderGroup();
    expect(screen.getAllByTestId('col-count').map((n) => n.textContent)).toEqual(['2', '1', '0']);
    for (const folded of ['Summary of PAY-160', 'Summary of PAY-161', 'Ledger rounding fix', 'Summary of PAY-170']) {
      expect(screen.queryByText(folded)).toBeNull();
    }
  });

  // Review Focus 3: PAY-161 and PAY-170 are done, but they are folded under a To Do epic, which stays in its OWN column; the Done column gains nothing.
  it('keeps a top in its own column whatever its folded issues’ columns are', async () => {
    await renderGroup();
    expect(summariesIn('Done')).toEqual([]);
    expect(summariesIn('In Progress')).toEqual(['Payout retries']);
  });

  // Sort (§3): PAY-120's own `updated` (5 d) is older than PAY-180's (1 d), but PAY-162 under it was touched today, so the epic rises above the task.
  it('sorts tops by the newest updated across each top and everything folded under it', async () => {
    await renderGroup();
    expect(summariesIn('To Do')).toEqual(['Payments epic', 'Standalone task']);
  });

  it('draws the fold block on a top with folded issues: the children line, a three-segment bar and its caption', async () => {
    await renderGroup();
    const c = card('Payments epic');
    expect(within(c).getByText('2 children · 2 below them')).toBeInTheDocument();
    expect(within(c).getByText('2 done · 1 in progress · 1 to do')).toBeInTheDocument();
    expect(c.querySelectorAll('.ui-spread-seg')).toHaveLength(3);
    // The age is the top's own (§3: the sort key is never drawn) — 5 d, not PAY-162's `now`.
    expect(c.querySelector('.board-card-meta')?.textContent).toBe('5d');
  });

  it('draws no fold block on a top with nothing folded, and an off-board parent still reads as the crumb', async () => {
    await renderGroup();
    expect(card('Standalone task').querySelector('.jira-card-fold')).toBeNull();
    expect(card('Payout retries').querySelector('.jira-card-fold')).toBeNull();
    expect(within(card('Payout retries')).getByText('↳ PAY-999 Billing platform')).toBeInTheDocument();
  });

  // Spec §6, "Where the board's list comes from": a card click hands the modal the fold's `childrenOf`, so its tree can reach the grandchildren.
  it('a card click passes the fold’s childrenOf with the issue', async () => {
    await renderGroup();
    await userEvent.click(card('Payments epic'));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    const [opened, index] = onOpenIssue.mock.calls[0] as [JiraIssue, ReadonlyMap<string, readonly JiraIssue[]>];
    expect(opened).toBe(G_120);
    expect(index.get('PAY-120')?.map((i) => i.key)).toEqual(['PAY-160', 'PAY-170']);
    expect(index.get('PAY-160')?.map((i) => i.key)).toEqual(['PAY-162', 'PAY-161']);
  });

  it('the band counts the loaded list, not the status poll, and adds the cards part', async () => {
    await renderGroup();
    expect(document.querySelector('.jira-band-sub')?.textContent).toBe('acme.atlassian.net · 7 issues from 1 root and 1 query · 3 cards · polled 10m ago');
  });

  it('the band reads the status count, with no cards part, while the list has not loaded', async () => {
    const answered = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      /\/issues$/.test(String(input)) ? new Promise<Response>(() => {}) : answered(input)
    ) as unknown as typeof fetch;
    renderPage();
    await screen.findByText('loading…');
    await waitFor(() => expect(document.querySelector('.jira-band-sub')?.textContent).toBe(bandSub(ALPHA, 'acme.atlassian.net', Date.now(), null).text));
    expect(document.querySelector('.jira-band-sub')?.textContent).toContain(' · 4 issues ');
    expect(document.querySelector('.jira-band-sub')?.textContent).not.toContain('card');
  });

  it('on a list where nothing folds the band has no cards part', async () => {
    await renderAlpha();
    expect(document.querySelector('.jira-band-sub')?.textContent).not.toContain('card');
  });

  // Review Focus 1: a cached list with a cycle renders, terminates and draws each member once.
  it('draws a two-cycle as two cards, and settles', async () => {
    lists[ALPHA.id] = [
      issue({ key: 'PAY-1', summary: 'Cycle one', parent: { key: 'PAY-2', summary: 'Cycle two' } }),
      issue({ key: 'PAY-2', summary: 'Cycle two', parent: { key: 'PAY-1', summary: 'Cycle one' } })
    ];
    renderPage();
    await screen.findByText('Cycle one');
    expect(visibleSummaries().sort()).toEqual(['Cycle one', 'Cycle two']);
  });

  /*
    F1 (grouped-board spec §5): a top card shows when it matches, or when any issue folded under it matches. Shown only for a folded match, it carries a
    2 px amber ring and a `match` marker naming the match — the answer to "why is this here". A top that matches on its own draws neither.
  */
  describe('filters find folded issues (F1)', () => {
    const search = async (text: string): Promise<void> => {
      await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), text);
    };
    const ringed = (): Element[] => Array.from(document.querySelectorAll('.jira-card-match'));

    // PAY-162 is a GRANDCHILD (epic → story → sub-task): its depth-0 top shows, not the intermediate story (Review Focus 2).
    it('a search matching only a folded grandchild shows its top, ringed, naming the match', async () => {
      await renderGroup();
      await search('ledger');
      expect(visibleSummaries()).toEqual(['Payments epic']);
      expect(card('Payments epic')).toHaveClass('jira-card-match');
      expect(within(card('Payments epic')).getByText('1 match: PAY-162')).toHaveClass('ui-marker', 'ui-marker-match');
      expect(screen.getAllByTestId('col-count').map((n) => n.textContent)).toEqual(['1', '0', '0']);
    });

    it('a search every top matches on its own rings nothing', async () => {
      await renderGroup();
      await search('PAY-1');
      expect(visibleSummaries().sort()).toEqual(['Payments epic', 'Payout retries', 'Standalone task']);
      expect(ringed()).toHaveLength(0);
      expect(document.querySelector('.ui-marker-match')).toBeNull();
    });

    // `boardFilterOptions` reads every loaded issue, folded or not: a type only sub-tasks carry must still be pickable, though no card is one.
    it('the Type filter offers a type only folded issues carry, and picking it rings their top with the count and the keys', async () => {
      await renderGroup();
      const dialog = await openFilters();
      expect(within(within(dialog).getByRole('group', { name: 'Type' })).getByRole('button', { name: 'Sub-task' })).toBeInTheDocument();
      await pick('Type', 'Sub-task');
      expect(visibleSummaries()).toEqual(['Payments epic']);
      expect(card('Payments epic')).toHaveClass('jira-card-match');
      const marker = within(card('Payments epic')).getByText('2 matches');
      expect(marker).toHaveClass('ui-marker-match');
      expect(marker).toHaveAttribute('title', 'PAY-162, PAY-161');
    });

    // Review Focus 5: the band counts the unfiltered list, whatever the filters hide.
    it('a filter never moves the band', async () => {
      await renderGroup();
      const before = document.querySelector('.jira-band-sub')?.textContent;
      await pick('Type', 'Sub-task');
      expect(document.querySelector('.jira-band-sub')?.textContent).toBe(before);
      expect(before).toContain('7 issues from 1 root and 1 query · 3 cards');
    });

    it('rings nothing with no filter and no search', async () => {
      await renderGroup();
      expect(ringed()).toHaveLength(0);
    });

    it('a top that matches on its own is not ringed', async () => {
      await renderGroup();
      await search('standalone');
      expect(visibleSummaries()).toEqual(['Standalone task']);
      expect(card('Standalone task')).not.toHaveClass('jira-card-match');
      expect(within(card('Standalone task')).queryByText(/match/)).toBeNull();
    });
  });
});

/*
  Run ▾ and the live strip (Jira phase 5, Task 10; spec §6.2, §7; DESIGN.md §8.9.1). Rendered through `JiraView`, because the launch sheet it opens is hosted
  one level above the page (the modal's own Run reaches the same sheet) — a card's pick and a modal's pick are one code path ending in one sheet.
*/
describe('Run ▾ and the live strip', () => {
  const SKILL = { id: 's_0a1b2c3d', name: 'Groom ticket', prompt: '/jira-groom {key}' };
  const MAPPED = { PAY: ['/Users/ada/pay'] };
  /** A session started three hours ago: the strip's elapsed reading is `3h` for the whole of a case. */
  const threeHoursAgo = (): string => new Date(Date.now() - 3 * 3_600_000).toISOString();

  async function renderRun(over: Partial<JiraStatusPayload> = {}, firstCard = 'Refund partial captures'): Promise<void> {
    setJiraPage('board');
    statusAnswer = status({ repos: MAPPED, skills: [SKILL], ...over });
    render(
      <SettingsProvider>
        <JiraProvider>
          <JiraView onOpenJiraPage={jest.fn()} />
        </JiraProvider>
      </SettingsProvider>
    );
    await screen.findByText(firstCard);
  }

  const runChip = (summary: string): HTMLElement => within(card(summary)).getByRole('button', { name: /^Run PAY-/ });
  const strips = (summary: string): HTMLElement[] => Array.from(card(summary).querySelectorAll<HTMLElement>('.board-card-live'));

  it('an unmapped project draws a dashed chip whose title names Setup, and a click opens no menu and no modal', async () => {
    await renderRun({ repos: {} });
    const chip = runChip('Refund partial captures');
    expect(chip).toHaveAttribute('title', 'no repository mapped for PAY — Jira › Setup › Repositories');
    expect(chip.closest('.jira-run')).toHaveAttribute('data-state', 'no-repo');
    await userEvent.click(chip);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('draws the chip on a card with no priority and no match — the marker row is no longer conditional', async () => {
    await renderRun();
    expect(within(card('Refund flows')).getByTestId('marker-row')).toBeInTheDocument();
    expect(runChip('Refund flows')).toBeEnabled();
  });

  it('a live key draws a disabled chip titled with the key, and a strip naming the repo basename and the elapsed reading', async () => {
    await renderRun({ live: { 'PAY-131': { name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } } });
    const chip = runChip('Refund partial captures');
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'a session is running on PAY-131');
    const [strip] = strips('Refund partial captures');
    expect(strip).toHaveClass('hatch');
    expect(strip).toHaveTextContent('session · pay');
    expect(strip).toHaveTextContent('3h');
    // Another card is not the one with a session.
    expect(strips('Refund flows')).toHaveLength(0);
  });

  it('a starting entry reads `starting` in the strip, and the chip is disabled just the same', async () => {
    await renderRun({ live: { 'PAY-131': { name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: true } } });
    const [strip] = strips('Refund partial captures');
    expect(strip).toHaveTextContent('starting');
    expect(strip).not.toHaveTextContent('3h');
    expect(runChip('Refund partial captures')).toBeDisabled();
  });

  // Grouped-board ruling: a folded issue is not a card, so the session on it would be invisible without this. The strip belongs to the top that holds it and
  // names the folded key, and the top's own chip is not disabled for a session that is not its own.
  it('a live issue folded under a top shows a strip on the top naming the folded key', async () => {
    const top = issue({ key: 'PAY-160', summary: 'Top story', type: { name: 'Story', level: 0, subtask: false } });
    const under = issue({ key: 'PAY-162', summary: 'Folded sub-task', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'PAY-160', summary: 'Top story' } });
    lists[ALPHA.id] = [top, under];
    await renderRun({ live: { 'PAY-162': { name: 'jira PAY-162', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } } }, 'Top story');
    const [strip] = strips('Top story');
    expect(strip).toHaveTextContent('PAY-162');
    expect(strip).toHaveTextContent('session · pay');
    expect(runChip('Top story')).toBeEnabled();
    expect(screen.queryByText('Folded sub-task')).not.toBeInTheDocument();
  });

  it('a ready chip opens a menu: both built-ins, a rule, the skills by name, and the note', async () => {
    await renderRun();
    await userEvent.click(runChip('Refund partial captures'));
    const menu = screen.getByRole('dialog', { name: 'Run menu' });
    expect(within(menu).getByRole('button', { name: JIRA_BUILTIN_LABELS.execute })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: JIRA_BUILTIN_LABELS.context })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: /Groom ticket/ })).toBeInTheDocument();
    expect(within(menu).getByText('opens the launch sheet')).toBeInTheDocument();
    expect(menu.querySelectorAll('hr')).toHaveLength(2);
  });

  it('a pick opens the launch sheet on that action, and not the issue modal', async () => {
    await renderRun();
    await userEvent.click(runChip('Refund partial captures'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: JIRA_BUILTIN_LABELS.context }));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    expect(within(sheet).getByRole('combobox', { name: 'Action' })).toHaveValue('context');
    expect(screen.queryByRole('dialog', { name: /PAY-131 Refund partial captures/ })).not.toBeInTheDocument();
    // The menu closed behind the pick.
    expect(screen.queryByRole('dialog', { name: 'Run menu' })).not.toBeInTheDocument();
  });

  it('a skill pick opens the sheet on that skill', async () => {
    await renderRun();
    await userEvent.click(runChip('Refund partial captures'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: /Groom ticket/ }));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    expect(within(sheet).getByRole('combobox', { name: 'Action' })).toHaveValue(`skill:${SKILL.id}`);
  });

  // I1 (final review): `Jira default action` is read HERE — the menu lists the resolved default first and marks it `default` — because every way into the launch
  // sheet passes the clicked row, so the sheet never seeds from the setting. Rows are read as [label, hint] pairs off the `.jira-run-opt` buttons.
  describe('the default action', () => {
    const setDefault = (jiraDefaultAction: string): void =>
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ jiraDefaultAction }));
    const openMenu = async (): Promise<HTMLElement> => {
      await renderRun();
      await userEvent.click(runChip('Refund partial captures'));
      return screen.getByRole('dialog', { name: 'Run menu' });
    };
    const rows = (menu: HTMLElement): [string, string][] =>
      Array.from(menu.querySelectorAll<HTMLElement>('.jira-run-opt')).map((b) => {
        const [label, hint] = Array.from(b.querySelectorAll('span')).map((n) => n.textContent ?? '');
        return [label, hint];
      });

    it('lists Work it end to end first, marked default, when that is the setting', async () => {
      setDefault('execute');
      const menu = await openMenu();
      expect(rows(menu)).toEqual([
        [JIRA_BUILTIN_LABELS.execute, 'default'],
        [JIRA_BUILTIN_LABELS.context, 'built-in'],
        ['Groom ticket', '/jira-groom']
      ]);
    });

    it('lists Open with the ticket loaded first when that is the setting, Work it end to end following as built-in', async () => {
      setDefault('context');
      const menu = await openMenu();
      expect(rows(menu)).toEqual([
        [JIRA_BUILTIN_LABELS.context, 'default'],
        [JIRA_BUILTIN_LABELS.execute, 'built-in'],
        ['Groom ticket', '/jira-groom']
      ]);
    });

    it('lists an existing skill first, marked default, and does not repeat it lower down', async () => {
      setDefault(SKILL.id);
      const menu = await openMenu();
      expect(rows(menu)).toEqual([
        ['Groom ticket', 'default'],
        [JIRA_BUILTIN_LABELS.execute, 'built-in'],
        [JIRA_BUILTIN_LABELS.context, 'built-in']
      ]);
      expect(within(menu).getAllByRole('button', { name: /Groom ticket/ })).toHaveLength(1);
    });

    it('reads a deleted skill id as Work it end to end', async () => {
      setDefault('s_gone0000');
      const menu = await openMenu();
      expect(rows(menu)[0]).toEqual([JIRA_BUILTIN_LABELS.execute, 'default']);
      expect(rows(menu)).toHaveLength(3);
    });

    it('opens the sheet on the promoted row\'s action', async () => {
      setDefault('context');
      const menu = await openMenu();
      await userEvent.click(within(menu).getAllByRole('button')[0]);
      const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
      expect(within(sheet).getByRole('combobox', { name: 'Action' })).toHaveValue('context');
    });
  });

  // Spec §11: a resolved dispatch-jira reloads the status without waiting for the poll. `use-jira`'s probe re-implements `.then(reload)`, so only THIS case, through
  // the real `JiraView` -> `JiraLaunchSheet`'s `onStarted`, fails when that wiring loses its reload or its board nudge.
  it('Start from a card\'s Run menu reads GET /api/jira once more and the board list once more, with no timer wait', async () => {
    await renderRun();
    const dispatched = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/agents/dispatch-jira') {
        requested.push(`POST ${String(input)}`);
        return ok({ sessionId: 'sess-9', assigned: false, transitioned: null, session: { name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay' } });
      }
      return (dispatched as jest.Mock)(input, init);
    }) as unknown as typeof fetch;
    const statusReads = (): number => requested.filter((u) => u === '/api/jira').length;
    await userEvent.click(runChip('Refund partial captures'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: JIRA_BUILTIN_LABELS.execute }));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    const start = await within(sheet).findByRole('button', { name: 'Start' });
    await waitFor(() => expect(start).toBeEnabled());
    const statusBefore = statusReads();
    const boardBefore = boardRequests().length;

    await userEvent.click(start);
    await waitFor(() => expect(requested).toContain('POST /api/agents/dispatch-jira'));
    await waitFor(() => expect(statusReads()).toBe(statusBefore + 1));
    await waitFor(() => expect(boardRequests().length).toBe(boardBefore + 1));
    // Settled: nothing else follows (a second read would be the timer or a doubled trigger).
    await new Promise((r) => setTimeout(r, 50));
    expect(statusReads()).toBe(statusBefore + 1);
    expect(boardRequests().length).toBe(boardBefore + 1);
  });

  // The modal's Stop is the other half: the modal reloads the status itself, and `JiraView`'s `onWrote` is what re-reads the board list. Both are pinned here
  // through the real page, since `jira-modal`'s cases hand the modal mock callbacks.
  it('Stop from the modal reads GET /api/jira once more and the board list once more, and the strip is gone', async () => {
    const live = { 'PAY-131': { name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } };
    await renderRun({ live });
    const refund = (lists[ALPHA.id] ?? []).find((i) => i.key === 'PAY-131') as JiraIssue;
    const answered = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/jira/issue/PAY-131') return ok({ ...refund, description: '', children: [], transitions: [], boards: [ALPHA.id], session: null });
      if (url === '/api/agents/jira-stop') {
        requested.push(`POST ${url}`);
        statusAnswer = status({ repos: MAPPED, skills: [SKILL] });
        return ok({ ok: true });
      }
      return (answered as jest.Mock)(input, init);
    }) as unknown as typeof fetch;
    const statusReads = (): number => requested.filter((u) => u === '/api/jira').length;
    expect(strips('Refund partial captures')).toHaveLength(1);
    // Held before the modal opens: its title repeats the card's text, so a lookup by summary is ambiguous after.
    const refundCard = card('Refund partial captures');
    const stripsOnCard = (): number => refundCard.querySelectorAll('.board-card-live').length;

    await userEvent.click(refundCard);
    const modal = await screen.findByRole('dialog', { name: /PAY-131 Refund partial captures/ });
    await userEvent.click(await within(modal).findByRole('button', { name: 'Stop session' }));
    const statusBefore = statusReads();
    const boardBefore = boardRequests().length;
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));

    await waitFor(() => expect(requested).toContain('POST /api/agents/jira-stop'));
    await waitFor(() => expect(statusReads()).toBe(statusBefore + 1));
    await waitFor(() => expect(boardRequests().length).toBe(boardBefore + 1));
    await waitFor(() => expect(stripsOnCard()).toBe(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(statusReads()).toBe(statusBefore + 1);
    expect(boardRequests().length).toBe(boardBefore + 1);
  });

  it('the chip stops the card: a click or Enter on it opens no modal', async () => {
    await renderRun();
    const chip = runChip('Refund partial captures');
    await userEvent.click(chip);
    expect(screen.queryByRole('dialog', { name: /PAY-131 Refund partial captures/ })).not.toBeInTheDocument();
    await userEvent.click(chip);
    chip.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: /PAY-131 Refund partial captures/ })).not.toBeInTheDocument();
  });
});
