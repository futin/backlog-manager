/**
 * @jest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraBoardView } from '../client/src/components/jira/JiraBoardView';
import JiraView from '../client/src/components/jira/JiraView';
import { JiraSessionsProvider } from '../client/src/hooks/JiraSessionsContext';
import { JiraProvider } from '../client/src/hooks/JiraContext';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { setJiraPage } from '../client/src/hooks/useJiraPage';
import { setJiraView } from '../client/src/hooks/useJiraView';
import { elapsedSince } from '../client/src/lib/item-age';
import { JIRA_BOARD_KEY, JIRA_FILTERS_KEY, bandSub } from '../client/src/lib/jira';
import { JIRA_PAGE_KEY } from '../client/src/lib/jira-page';
import { NoGitlab } from './helpers/no-gitlab';
import { daysAgoStamp } from './helpers/dates';
import { JIRA_BUILTIN_LABELS, type AgentsStatus, type DashboardRow, type JiraBoardStatus, type JiraIssue, type JiraLiveSession, type JiraStatusPayload } from '../shared/types';

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
/* `GET /api/jira/worktrees` — what the board reads once on mount and again when the set of live keys changes. */
let worktreesAnswer: () => Promise<Response>;
/* `GET /api/jira/sessions` — the section's one sessions poll (Jira sessions, Task 10); nothing linked unless a case says so. */
let sessionsAnswer: () => unknown;
/**
 * The link the server keeps for a live Run — `JiraLiveService.snapshot()` is built from exactly these plus the `starting` reservations, so a status `live` entry
 * with a session id always has one, and the default sessions answer below is derived from the status to keep the two fixtures from contradicting each other.
 */
const runLink = (key: string, l: JiraLiveSession, row: DashboardRow | null = null) => ({
  key, sessionId: l.sessionId, how: 'run', action: 'context', name: l.name, repo: l.repo, branch: null, surface: 'dashboard', model: null, effort: null,
  snapshot: { summary: 'x', type: 'Story', parentKey: null }, startedAt: l.startedAt, endedAt: null, endReason: null, quietSince: null, reattachedAt: null,
  state: 'working', row, stateSince: l.startedAt
});

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
  worktreesAnswer = () => ok({ worktrees: [], unavailable: [] });
  sessionsAnswer = () => ({
    links: Object.entries(statusAnswer.live).filter(([, l]) => !l.starting && l.sessionId !== null).map(([k, l]) => runLink(k, l)),
    reachable: true,
    rowsAt: null
  });
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === '/api/jira') return ok(statusAnswer);
    if (url.startsWith('/api/jira/sessions')) return ok(sessionsAnswer());
    const m = /^\/api\/jira\/boards\/([^/]+)\/issues$/.exec(url);
    if (m !== null) {
      const id = decodeURIComponent(m[1]);
      const board = statusAnswer.boards.find((b) => b.id === id);
      return ok({ issues: lists[id] ?? [], polledAt: board?.polledAt ?? null });
    }
    if (url === '/api/agents/status') return ok(AGENTS);
    if (url === '/api/jira/worktrees') return worktreesAnswer();
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
    </JiraProvider>,
    { wrapper: NoGitlab }
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

async function pick(group: 'Type' | 'Status' | 'Assignee' | 'Sprint', name: string): Promise<void> {
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

describe('a newer sweep in the status (the chip’s `now`)', () => {
  // An `off` board: no 15 s timer, so the only things that can read its list again are a nudge and the status's stamp moving — and this case sends no nudge.
  const OFF = { ...ALPHA, interval: 'off' as const };
  const alphaReads = (): number => boardRequests().filter((u) => u === `/api/jira/boards/${ALPHA.id}/issues`).length;

  it('reads the list again when the status’s polledAt for the board on screen moves, and not when the status comes back unchanged', async () => {
    statusAnswer = status({ boards: [OFF, BETA] });
    await renderAlpha();
    const before = alphaReads();

    // The same stamp: a status re-read alone asks for no list.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(requested.filter((u) => u === '/api/jira').length).toBeGreaterThanOrEqual(2));
    expect(alphaReads()).toBe(before);

    // A sweep landed: the next status carries a newer stamp, and the cards follow without a timer or a nudge.
    statusAnswer = status({ boards: [{ ...OFF, polledAt: new Date().toISOString() }, BETA] });
    lists = { ...lists, [ALPHA.id]: [...ALPHA_ISSUES, { ...ALPHA_ISSUES[0], key: 'PAY-999', summary: 'Swept in just now' }] };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText('Swept in just now')).toBeInTheDocument();
    expect(alphaReads()).toBe(before + 1);
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
  it('gives each shelf a tone, a page-local dot and a page-local count in place of the Dot and Pill', async () => {
    await renderAlpha();
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => c.getAttribute('data-tone'))).toEqual(['todo', 'doing', 'done']);
    for (const c of cols) {
      expect(c.querySelectorAll('.board-col-head .board-col-dot')).toHaveLength(1);
      expect(c.querySelector('.board-col-head .ui-dot')).toBeNull();
      expect(c.querySelector('.board-col-head .ui-pill')).toBeNull();
    }
    expect(cols.map((c) => c.querySelector('.board-col-count')?.textContent)).toEqual(['2', '1', '1']);
  });

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

  it('the priority pill: tone and glyph by name, grey and glyphless for a custom name, nothing for null', async () => {
    const cases: [string | null, string | null, boolean][] = [
      ['High', 'high', true],
      ['Medium', 'med', true],
      ['Lowest', 'low', true],
      ['P1', 'other', false],
      [null, null, false]
    ];
    for (const [name, tone, glyph] of cases) {
      statusAnswer = status();
      lists[ALPHA.id] = [issue({ key: 'PAY-7', summary: 'Pill case', priority: name })];
      renderPage();
      await screen.findByText('Pill case');
      const pill = name === null ? null : within(card('Pill case')).getByTitle(`priority ${name}`);
      if (tone === null) expect(card('Pill case').querySelector('[title^="priority "]')).toBeNull();
      else {
        expect(pill).toHaveAttribute('data-tone', tone);
        expect(pill?.querySelector('svg') !== null).toBe(glyph);
      }
      cleanup();
    }
  });

  it('the status is the raw name beside a tone dot, and the type tile carries a tone per type', async () => {
    await renderAlpha();
    const c = card('Refund partial captures');
    expect(within(c).getByText('In Review')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/in progress/);
    expect(c.querySelector('.jira-status-dot')).toHaveAttribute('data-tone', 'doing');
    expect(within(c).getByTitle('Story')).toHaveAttribute('data-tone', 'story');
    expect(within(card('Currency symbol missing on receipts')).getByTitle('Bug')).toHaveAttribute('data-tone', 'bug');
    expect(within(card('Refund flows')).getByTitle('Epic')).toHaveAttribute('data-tone', 'neutral');
  });

  it('the foot names the one mapped repository by basename, `N repos` for several with every path in the title, and nothing for none', async () => {
    statusAnswer = status({ repos: { PAY: ['/x/microservice'] } });
    await renderAlpha();
    expect(within(card('Refund flows')).getByText('microservice')).toBeInTheDocument();
    cleanup();
    statusAnswer = status({ repos: { PAY: ['/x/microservice', '/y/other'] } });
    await renderAlpha();
    const many = within(card('Refund flows')).getByText('2 repos').closest('.jira-card-repo') as HTMLElement;
    expect(many.getAttribute('title')).toBe('/x/microservice\n/y/other');
    cleanup();
    statusAnswer = status();
    await renderAlpha();
    expect(card('Refund flows').querySelector('.jira-card-repo')).toBeNull();
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

  // The one multi-select: `To Do` + `In Progress` is a set no single chip names. Chips run in workflow order (category, then name), not alphabetically.
  it('status is a multi-select in workflow order; `All statuses` empties the set', async () => {
    await renderAlpha();
    const group = (): HTMLElement => within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('group', { name: 'Status' });
    await openFilters();
    expect(within(group()).getAllByRole('button').map((b) => b.textContent)).toEqual(['All statuses', 'Backlog', 'To Do', 'In Review', 'Done']);
    expect(within(group()).getByRole('button', { name: 'All statuses' })).toHaveAttribute('aria-pressed', 'true');
    await pick('Status', 'To Do');
    expect(shown()).toEqual(['Refund flows']);
    await pick('Status', 'In Review');
    expect(shown()).toEqual(['Refund flows', 'Refund partial captures']);
    expect(within(group()).getByRole('button', { name: 'All statuses' })).toHaveAttribute('aria-pressed', 'false');
    // Two statuses are one filter on the badge.
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeInTheDocument();
    // A second click takes a status back out of the set.
    await pick('Status', 'To Do');
    expect(shown()).toEqual(['Refund partial captures']);
    await pick('Status', 'All statuses');
    expect(shown()).toEqual(ALL);
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
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

  // The panel filters survive a reload (a remount over the same localStorage); the search does not, and `Clear all` clears what is stored too.
  it('the panel filters survive a remount; the search does not', async () => {
    await renderAlpha();
    await pick('Assignee', 'me');
    await pick('Status', 'Backlog');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'refund');
    expect(JSON.parse(localStorage.getItem(JIRA_FILTERS_KEY) ?? 'null')).toEqual({ assignee: 'me', statuses: ['Backlog'] });
    cleanup();

    // Not `renderAlpha`: the card it waits for is one the restored filters hide. The badge counts the APPLIED filters, so it lights only once the list
    // has loaded and offers the picks — which is the wait this case needs.
    renderPage();
    await screen.findByRole('button', { name: 'Filters, 2 set' });
    expect(screen.getByRole('searchbox', { name: 'Search issues' })).toHaveValue('');
    expect(shown()).toEqual(['Rounding wrong on invoices over 1,000']);
    await userEvent.click(within(await openFilters()).getByRole('button', { name: 'Clear all' }));
    expect(shown()).toEqual(ALL);
    cleanup();

    await renderAlpha();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('a `no sprint` pick round-trips as null, not as any', async () => {
    localStorage.setItem(JIRA_FILTERS_KEY, JSON.stringify({ sprint: null }));
    renderPage();
    await screen.findByRole('button', { name: 'Filters, 1 set' });
    expect(shown()).toEqual(['Refund flows']);
  });

  // localStorage hands back whatever was written: a wrong-shaped value must read as no filter, never crash the page.
  it.each([['"banana"'], ['42'], ['{"statuses":"To Do","assignee":"boss","type":7}'], ['not json']])('a stored %s reads as no filter', async (raw) => {
    localStorage.setItem(JIRA_FILTERS_KEY, raw);
    await renderAlpha();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
    expect(shown()).toEqual(ALL);
  });
});

describe('the shapes that are not a board', () => {
  it('no boards: `No boards yet`, and its chip opens Setup', async () => {
    statusAnswer = status({ boards: [] });
    onOpenIssue = jest.fn();
    render(
      <JiraProvider>
        <JiraBoardView onOpenJiraPage={setJiraPage} onOpenIssue={onOpenIssue} onRun={jest.fn()} nudge={0} />
      </JiraProvider>,
      { wrapper: NoGitlab }
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

// The section's two pages are switched by the rail's tree alone (spec §6.1, `.claude/rules/board.md` "Settings is three pages…"): the real Board page, drawn
// through the real `JiraView` inside a `main`, holds no control that restates that choice.
it('draws no page switch inside main', async () => {
  render(
    <main>
      <JiraProvider>
        <JiraSessionsProvider open>
          <JiraView onOpenJiraPage={jest.fn()} />
        </JiraSessionsProvider>
      </JiraProvider>
    </main>,
    { wrapper: NoGitlab }
  );
  await screen.findByText('Refund partial captures');
  const main = document.querySelector('main') as HTMLElement;
  // The Board | List switch is a view of THIS page, not a page (Jira sessions C1): its `Board` option lives in the `View` group and nowhere else.
  expect(within(main).queryByRole('button', { name: 'Setup' })).toBeNull();
  const boardButtons = within(main).queryAllByRole('button', { name: 'Board' });
  expect(boardButtons.every((b) => b.closest('[role="group"]')?.getAttribute('aria-label') === 'View')).toBe(true);
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

  it('the marker row reads repo, match, worktree (spec §4.2), and the repo glyph is 14 px', async () => {
    statusAnswer = status({ repos: { PAY: ['/x/microservice'] } });
    await renderGroup();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'ledger');
    const row = within(card('Payments epic')).getByTestId('marker-row');
    const repo = row.querySelector('.jira-card-repo') as HTMLElement;
    const match = within(row).getByText('1 match: PAY-162');
    expect(repo).not.toBeNull();
    // Document order: the repo precedes the match marker.
    expect(repo.compareDocumentPosition(match) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(repo.querySelector('svg')).toHaveAttribute('width', '14');
  });

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
describe('Run ▾ on the card, and the deck card for a live key', () => {
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
          <JiraSessionsProvider open>
            <JiraView onOpenJiraPage={jest.fn()} />
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>,
      { wrapper: NoGitlab }
    );
    await screen.findByText(firstCard);
  }

  const runChip = (summary: string): HTMLElement => within(card(summary)).getByRole('button', { name: /^Run PAY-/ });
  /** The chevron half: the one that opens the menu. The left half starts the default action and never opens it. */
  const runMore = (summary: string): HTMLElement => within(card(summary)).getByRole('button', { name: /^Run options for PAY-/ });
  /** A live top has no shelf row any more (spec §7.1); its session is a deck card, found by the session's own key. */
  const deckCards = (key: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`.jira-deck-card[data-key="${key}"]`));
  const onShelves = (summary: string): boolean => screen.queryAllByText(summary).some((n) => n.closest('.board-card') !== null);

  it('an unmapped project draws a dashed chip whose title names Setup, and a click opens no menu and no modal', async () => {
    await renderRun({ repos: {} });
    const chip = runChip('Refund partial captures');
    const title = 'no repository mapped for PAY — Jira › Setup › Repositories';
    expect(chip).toHaveAttribute('title', title);
    expect(runMore('Refund partial captures')).toHaveAttribute('title', title);
    expect(chip).toBeDisabled();
    expect(runMore('Refund partial captures')).toBeDisabled();
    expect(chip.closest('.jira-run')).toHaveAttribute('data-state', 'no-repo');
    await userEvent.click(chip);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('draws the chip on a card with no priority and no match — the marker row is no longer conditional', async () => {
    await renderRun();
    expect(within(card('Refund flows')).getByTestId('marker-row')).toBeInTheDocument();
    expect(runChip('Refund flows')).toBeEnabled();
  });

  it('a live key takes its card off the shelves and draws a deck card: strip, key, crumb naming the repo basename, and the elapsed reading', async () => {
    await renderRun({ live: { 'PAY-131': { sessionId: 's1', name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } } });
    const [deck] = await waitFor(() => {
      const found = deckCards('PAY-131');
      expect(found).toHaveLength(1);
      return found;
    });
    // The card is a stripe now: its tone is the state's mark, and the first line says the state and how long it has held.
    expect(deck).toHaveClass('ui-stripe');
    expect(deck).toHaveAttribute('data-tone', 'green');
    expect(deck.querySelector('.ui-stripe-dot')).toHaveAttribute('data-tone', 'green');
    expect(deck.querySelector('.jira-deck-state')).toHaveTextContent('Working · 3h');
    expect(deck.querySelector('.jira-card-crumb')).toHaveTextContent('pay');
    expect(onShelves('Refund partial captures')).toBe(false);
    // Another card is not the one with a session.
    expect(onShelves('Refund flows')).toBe(true);
    expect(within(card('Refund flows')).getByRole('button', { name: /^Run PAY-/ })).toBeEnabled();
  });

  it('a starting entry is a deck card reading `Starting…` with no buttons, and its top is off the shelves just the same', async () => {
    await renderRun({ live: { 'PAY-131': { sessionId: null, name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: true } } });
    const [deck] = await waitFor(() => {
      const found = deckCards('PAY-131');
      expect(found).toHaveLength(1);
      return found;
    });
    expect(deck).toHaveAttribute('data-state', 'starting');
    expect(deck).toHaveAttribute('data-tone', 'green');
    expect(deck.querySelector('.jira-deck-state')).toHaveTextContent('Starting…');
    expect(within(deck).queryByRole('link')).toBeNull();
    expect(onShelves('Refund partial captures')).toBe(false);
  });

  // Grouped-board ruling: a folded issue is not a card, so the session on it would be invisible without this. The deck card shows the session's OWN key and
  // names the top it hangs under in its crumb; the top leaves the shelves, and the folded issue is still no shelf row.
  it('a live issue folded under a top is a deck card on the folded key, naming the top in its crumb, and the top leaves the shelves', async () => {
    const top = issue({ key: 'PAY-160', summary: 'Top story', type: { name: 'Story', level: 0, subtask: false } });
    const under = issue({ key: 'PAY-162', summary: 'Folded sub-task', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'PAY-160', summary: 'Top story' } });
    lists[ALPHA.id] = [top, under];
    await renderRun({ live: { 'PAY-162': { sessionId: 's1', name: 'jira PAY-162', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } } }, 'Folded sub-task');
    const [deck] = await waitFor(() => {
      const found = deckCards('PAY-162');
      expect(found).toHaveLength(1);
      return found;
    });
    // The fold is a pill beside the key now, not the crumb's lead.
    expect(deck.querySelector('.ui-fold')).toHaveTextContent('↳ PAY-160');
    expect(deck.querySelector('.jira-card-crumb')).not.toHaveTextContent('↳');
    expect(deck.querySelector('.jira-card-crumb')).toHaveTextContent('pay');
    expect(onShelves('Top story')).toBe(false);
  });

  it('a deck card shows the session\'s context as a 4 px meter reading `context 42%`', async () => {
    const live = { 'PAY-131': { sessionId: 's1', name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } };
    sessionsAnswer = () => ({ links: [runLink('PAY-131', live['PAY-131'], { id: 's1', status: 'busy', contextPct: 42 })], reachable: true, rowsAt: null });
    await renderRun({ live });
    const [deck] = await waitFor(() => {
      const found = deckCards('PAY-131');
      expect(found).toHaveLength(1);
      return found;
    });
    expect(deck.querySelector('.ui-meter')).toHaveAttribute('data-height', '4');
    expect(deck.querySelector('.ui-meter')).toHaveTextContent('context 42%');
  });

  it('a ready chip opens a menu: both built-ins, a rule, the skills by name, and the note', async () => {
    await renderRun();
    await userEvent.click(runMore('Refund partial captures'));
    const menu = screen.getByRole('dialog', { name: 'Run menu' });
    expect(within(menu).getByRole('button', { name: JIRA_BUILTIN_LABELS.execute })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: JIRA_BUILTIN_LABELS.context })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: /Groom ticket/ })).toBeInTheDocument();
    expect(within(menu).getByText('Every choice opens the launch sheet first')).toBeInTheDocument();
    expect(within(menu).getByText('Built in')).toBeInTheDocument();
    expect(within(menu).getByText('Skills on this machine · 1')).toBeInTheDocument();
  });

  it('the foot holds both halves; the left one opens the sheet on the default action and no menu', async () => {
    await renderRun();
    const foot = card('Refund partial captures');
    expect(within(foot).getByRole('button', { name: /^Run PAY-/ })).toBeInTheDocument();
    expect(within(foot).getByRole('button', { name: /^Run options for PAY-/ })).toBeInTheDocument();
    await userEvent.click(runChip('Refund partial captures'));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    expect(within(within(sheet).getByRole('group', { name: 'Action' })).getByRole('button', { name: 'End to end' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog', { name: 'Run menu' })).not.toBeInTheDocument();
  });

  it('the left half runs the configured default, not always execute', async () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ jiraDefaultAction: SKILL.id }));
    await renderRun();
    await userEvent.click(runChip('Refund partial captures'));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    expect(within(within(sheet).getByRole('group', { name: 'Action' })).getByRole('button', { name: 'A skill' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('combobox', { name: 'Skill' })).toHaveValue(`skill:${SKILL.id}`);
  });

  it('with no skills on the machine the menu has no Skills header', async () => {
    await renderRun({ skills: [] });
    await userEvent.click(runMore('Refund partial captures'));
    const menu = screen.getByRole('dialog', { name: 'Run menu' });
    expect(within(menu).queryByText(/Skills on this machine/)).toBeNull();
    expect(within(menu).getByText('Built in')).toBeInTheDocument();
  });

  it('after a pick, focus returns to the chevron', async () => {
    await renderRun();
    await userEvent.click(runMore('Refund partial captures'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: JIRA_BUILTIN_LABELS.context }));
    expect(document.activeElement).toBe(runMore('Refund partial captures'));
  });

  it('a pick opens the launch sheet on that action, and not the issue modal', async () => {
    await renderRun();
    await userEvent.click(runMore('Refund partial captures'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: JIRA_BUILTIN_LABELS.context }));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    expect(within(within(sheet).getByRole('group', { name: 'Action' })).getByRole('button', { name: 'Ticket loaded' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog', { name: /PAY-131 Refund partial captures/ })).not.toBeInTheDocument();
    // The menu closed behind the pick.
    expect(screen.queryByRole('dialog', { name: 'Run menu' })).not.toBeInTheDocument();
  });

  it('a skill pick opens the sheet on that skill', async () => {
    await renderRun();
    await userEvent.click(runMore('Refund partial captures'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: /Groom ticket/ }));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    expect(within(within(sheet).getByRole('group', { name: 'Action' })).getByRole('button', { name: 'A skill' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('combobox', { name: 'Skill' })).toHaveValue(`skill:${SKILL.id}`);
  });

  // I1 (final review): `Jira default action` is read HERE — the menu lists the resolved default first and marks it `default` — because every way into the launch
  // sheet passes the clicked row, so the sheet never seeds from the setting. Rows are read as [label, hint] pairs off the `.jira-run-opt` buttons.
  describe('the default action', () => {
    const setDefault = (jiraDefaultAction: string): void =>
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ jiraDefaultAction }));
    const openMenu = async (): Promise<HTMLElement> => {
      await renderRun();
      await userEvent.click(runMore('Refund partial captures'));
      return screen.getByRole('dialog', { name: 'Run menu' });
    };
    /** Every row as [label, sub-line, carries the `default` mark], in menu order. */
    const rows = (menu: HTMLElement): [string, string, boolean][] =>
      Array.from(menu.querySelectorAll<HTMLElement>('.jira-run-opt')).map((b) => [
        b.querySelector('.jira-run-label')?.textContent ?? '',
        b.querySelector('.jira-run-sub')?.textContent ?? '',
        b.querySelector('.jira-run-mark')?.textContent === 'default'
      ]);

    it('marks Work it end to end default, in place, when that is the setting', async () => {
      setDefault('execute');
      const menu = await openMenu();
      expect(rows(menu)).toEqual([
        [JIRA_BUILTIN_LABELS.execute, 'Work the ticket end to end', true],
        [JIRA_BUILTIN_LABELS.context, 'A session, you drive', false],
        ['Groom ticket', '/jira-groom', false]
      ]);
    });

    it('marks Open with the ticket loaded default and leaves it second', async () => {
      setDefault('context');
      const menu = await openMenu();
      expect(rows(menu)).toEqual([
        [JIRA_BUILTIN_LABELS.execute, 'Work the ticket end to end', false],
        [JIRA_BUILTIN_LABELS.context, 'A session, you drive', true],
        ['Groom ticket', '/jira-groom', false]
      ]);
    });

    it('marks an existing skill default without pulling it first, and does not repeat it', async () => {
      setDefault(SKILL.id);
      const menu = await openMenu();
      expect(rows(menu)).toEqual([
        [JIRA_BUILTIN_LABELS.execute, 'Work the ticket end to end', false],
        [JIRA_BUILTIN_LABELS.context, 'A session, you drive', false],
        ['Groom ticket', '/jira-groom', true]
      ]);
      expect(within(menu).getAllByRole('button', { name: /Groom ticket/ })).toHaveLength(1);
    });

    it('puts default on the row resolveJiraAction returns for a deleted skill id', async () => {
      setDefault('s_gone0000');
      const menu = await openMenu();
      expect(rows(menu)[0]).toEqual([JIRA_BUILTIN_LABELS.execute, 'Work the ticket end to end', true]);
      expect(rows(menu)).toHaveLength(3);
    });

    it('a row\'s accessible name is its label only', async () => {
      setDefault('execute');
      const menu = await openMenu();
      expect(within(menu).getByRole('button', { name: JIRA_BUILTIN_LABELS.execute })).toBeInTheDocument();
    });

    it('opens the sheet on a row\'s own action', async () => {
      setDefault('execute');
      const menu = await openMenu();
      await userEvent.click(within(menu).getByRole('button', { name: JIRA_BUILTIN_LABELS.context }));
      const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
      expect(within(within(sheet).getByRole('group', { name: 'Action' })).getByRole('button', { name: 'Ticket loaded' })).toHaveAttribute('aria-pressed', 'true');
    });
  });

  // Spec §11: a resolved dispatch-jira reloads the status without waiting for the poll. `use-jira`'s probe re-implements `.then(reload)`, so only THIS case, through
  // the real `JiraView` -> `JiraLaunchSheet`'s `onStarted`, fails when that wiring loses its reload or its board nudge.
  it('Start from a card\'s Run menu reads GET /api/jira, the sessions payload and the board list once more each, with no timer wait', async () => {
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
    await userEvent.click(runMore('Refund partial captures'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Run menu' })).getByRole('button', { name: JIRA_BUILTIN_LABELS.execute }));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-131' });
    const start = await within(sheet).findByRole('button', { name: 'Start session' });
    await waitFor(() => expect(start).toBeEnabled());
    // The sessions payload is the second thing a landed Start must re-read (Detail's Start gate and the List's `canRun` read it, not the status).
    const sessionsReads = (): number => requested.filter((u) => u.startsWith('/api/jira/sessions')).length;
    const statusBefore = statusReads();
    const boardBefore = boardRequests().length;
    const sessionsBefore = sessionsReads();

    await userEvent.click(start);
    await waitFor(() => expect(requested).toContain('POST /api/agents/dispatch-jira'));
    await waitFor(() => expect(statusReads()).toBe(statusBefore + 1));
    await waitFor(() => expect(boardRequests().length).toBe(boardBefore + 1));
    await waitFor(() => expect(sessionsReads()).toBe(sessionsBefore + 1));
    // Settled: nothing else follows (a second read would be the timer or a doubled trigger).
    await new Promise((r) => setTimeout(r, 50));
    expect(statusReads()).toBe(statusBefore + 1);
    expect(boardRequests().length).toBe(boardBefore + 1);
    expect(sessionsReads()).toBe(sessionsBefore + 1);
  });

  // The modal's Stop is the other half: the modal reloads the status itself, and `JiraView`'s `onWrote` is what re-reads the board list. Both are pinned here
  // through the real page, since `jira-modal`'s cases hand the modal mock callbacks.
  it('Stop from the modal reads GET /api/jira once more and the board list once more, and the deck card is gone', async () => {
    const live = { 'PAY-131': { sessionId: 's1', name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } };
    // Stop is the Detail dialog's card's, and the card is the sessions payload's: the Run link the status' `live` implies, with a dashboard row that can end it.
    sessionsAnswer = () => ({ links: [runLink('PAY-131', live['PAY-131'], { id: 's1', status: 'busy', stopState: 'ready' })], reachable: true, rowsAt: null });
    await renderRun({ live });
    const refund = (lists[ALPHA.id] ?? []).find((i) => i.key === 'PAY-131') as JiraIssue;
    const answered = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/jira/issue/PAY-131') return ok({ ...refund, description: '', children: [], transitions: [], boards: [ALPHA.id], session: null });
      if (url === '/api/agents/jira-stop') {
        requested.push(`POST ${url}`);
        statusAnswer = status({ repos: MAPPED, skills: [SKILL] });
        sessionsAnswer = () => ({ links: [], reachable: true, rowsAt: null });
        return ok({ ok: true });
      }
      return (answered as jest.Mock)(input, init);
    }) as unknown as typeof fetch;
    const statusReads = (): number => requested.filter((u) => u === '/api/jira').length;
    await waitFor(() => expect(deckCards('PAY-131')).toHaveLength(1));

    // The deck card's summary opens Detail on the ticket.
    await userEvent.click(within(deckCards('PAY-131')[0]).getByRole('button', { name: 'Refund partial captures' }));
    const modal = await screen.findByRole('dialog', { name: /PAY-131 Refund partial captures/ });
    await userEvent.click(await within(modal).findByRole('button', { name: 'More for PAY-131' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Session actions' })).getByRole('button', { name: 'Stop session' }));
    const statusBefore = statusReads();
    const boardBefore = boardRequests().length;
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));

    await waitFor(() => expect(requested).toContain('POST /api/agents/jira-stop'));
    await waitFor(() => expect(statusReads()).toBe(statusBefore + 1));
    await waitFor(() => expect(boardRequests().length).toBe(boardBefore + 1));
    await waitFor(() => expect(deckCards('PAY-131')).toHaveLength(0));
    expect(onShelves('Refund partial captures')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(statusReads()).toBe(statusBefore + 1);
    expect(boardRequests().length).toBe(boardBefore + 1);
  });

  // DESIGN.md §8.9.2, Head: a Children-row click pushes onto `JiraView`'s walk, and the head's `← <key>` pops one step — through the real page, because
  // the walk lives one level above the modal and `jira-detail`'s cases hand the modal a mock `onBack`.
  it('a Children row walks down, Back climbs one step at a time, and a fresh card click starts a new walk', async () => {
    await renderRun();
    const refund = (lists[ALPHA.id] ?? []).find((i) => i.key === 'PAY-131') as JiraIssue;
    const child = { ...refund, key: 'PAY-200', summary: 'Child story', parent: { key: 'PAY-131', summary: refund.summary } };
    const grandchild = { ...refund, key: 'PAY-201', summary: 'Grandchild task', parent: { key: 'PAY-200', summary: 'Child story' } };
    const kids: Record<string, JiraIssue[]> = { 'PAY-131': [child], 'PAY-200': [grandchild], 'PAY-201': [] };
    const byKey: Record<string, JiraIssue> = { 'PAY-131': refund, 'PAY-200': child, 'PAY-201': grandchild };
    const answered = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const m = /^\/api\/jira\/issue\/(PAY-\d+)$/.exec(String(input));
      if (m !== null && byKey[m[1]] !== undefined)
        return ok({ ...byKey[m[1]], description: '', children: kids[m[1]], transitions: [], boards: [ALPHA.id], session: null });
      return (answered as jest.Mock)(input, init);
    }) as unknown as typeof fetch;
    const dialog = (): HTMLElement => screen.getByRole('dialog');
    const back = (): HTMLElement | null => within(dialog()).queryByRole('button', { name: /^Back to / });

    await userEvent.click(card('Refund partial captures'));
    await screen.findByRole('dialog', { name: /PAY-131 Refund partial captures/ });
    expect(back()).toBeNull();

    await userEvent.click(await within(dialog()).findByRole('button', { name: /PAY-200 Child story/ }));
    await screen.findByRole('dialog', { name: /PAY-200 Child story/ });
    expect(back()).toHaveAccessibleName('Back to PAY-131');
    await userEvent.click(await within(dialog()).findByRole('button', { name: /PAY-201 Grandchild task/ }));
    await screen.findByRole('dialog', { name: /PAY-201 Grandchild task/ });
    expect(back()).toHaveAccessibleName('Back to PAY-200');

    await userEvent.click(back() as HTMLElement);
    await screen.findByRole('dialog', { name: /PAY-200 Child story/ });
    expect(back()).toHaveAccessibleName('Back to PAY-131');
    await userEvent.click(back() as HTMLElement);
    await screen.findByRole('dialog', { name: /PAY-131 Refund partial captures/ });
    expect(back()).toBeNull();

    // Down one, close, and open the card again: the walk is the reading's, so the reopened dialog has nowhere to go back to.
    await userEvent.click(await within(dialog()).findByRole('button', { name: /PAY-200 Child story/ }));
    await screen.findByRole('dialog', { name: /PAY-200 Child story/ });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(card('Refund partial captures'));
    await screen.findByRole('dialog', { name: /PAY-131 Refund partial captures/ });
    expect(back()).toBeNull();
  });

  it('the chip stops the card: a click or Enter on it opens no modal', async () => {
    await renderRun();
    const chip = runMore('Refund partial captures');
    await userEvent.click(chip);
    expect(screen.queryByRole('dialog', { name: /PAY-131 Refund partial captures/ })).not.toBeInTheDocument();
    await userEvent.click(chip);
    chip.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: /PAY-131 Refund partial captures/ })).not.toBeInTheDocument();
  });
});

/* Worktree chips (Jira repo/branch, spec §5.5; DESIGN.md §8.9.1): the board asks `/api/jira/worktrees` once on mount, and again only when the SET of live keys
   changes — never on a timer, never because a render handed it a new object — and a failed read draws no chip and no error. */
describe('worktree chips on the card', () => {
  const tree = (branch: string | null, over: Partial<{ repo: string; path: string; main: boolean }> = {}) => ({
    repo: '/home/ada/pay',
    path: `/home/ada/pay/.worktrees/${(branch ?? 'detached').replaceAll('/', '-')}`,
    branch,
    main: false,
    ...over
  });
  const worktreeReads = (): number => requested.filter((u) => u === '/api/jira/worktrees').length;
  const chipOf = (summary: string): HTMLElement | null => card(summary).querySelector<HTMLElement>('.jira-card-tree');
  const live = (key: string) => ({ [key]: { sessionId: 's1', name: `jira ${key}`, startedAt: new Date().toISOString(), repo: '/home/ada/pay', starting: false } });

  async function renderBoard(over: Partial<JiraStatusPayload> = {}): Promise<void> {
    setJiraPage('board');
    statusAnswer = status({ repos: { PAY: ['/home/ada/pay'] }, ...over });
    render(
      <SettingsProvider>
        <JiraProvider>
          <JiraSessionsProvider open>
            <JiraView onOpenJiraPage={jest.fn()} />
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>,
      { wrapper: NoGitlab }
    );
    await screen.findByText('Refund partial captures');
  }

  it('shows the branch name on a card whose key has one tree, and nothing on a card with none or only the main tree', async () => {
    worktreesAnswer = () =>
      ok({
        worktrees: [tree('main', { path: '/home/ada/pay', main: true }), tree('PAY-131-refund-partial'), tree('PAY-999-elsewhere')],
        unavailable: []
      });
    await renderBoard();
    await waitFor(() => expect(chipOf('Refund partial captures')).not.toBeNull());
    expect(chipOf('Refund partial captures')).toHaveTextContent('PAY-131-refund-partial');
    expect(chipOf('Refund partial captures')).toHaveAttribute('title', '/home/ada/pay/.worktrees/PAY-131-refund-partial');
    expect(chipOf('Refund flows')).toBeNull();
    expect(chipOf('Rounding wrong on invoices over 1,000')).toBeNull();
  });

  it('reads `N worktrees` for several trees, with every path in the title', async () => {
    worktreesAnswer = () =>
      ok({ worktrees: [tree('PAY-131-a'), tree('PAY-131-b', { repo: '/home/ada/other', path: '/home/ada/other/.worktrees/PAY-131-b' })], unavailable: [] });
    await renderBoard({ repos: { PAY: ['/home/ada/pay', '/home/ada/other'] } });
    await waitFor(() => expect(chipOf('Refund partial captures')).not.toBeNull());
    expect(chipOf('Refund partial captures')).toHaveTextContent('2 worktrees');
    expect(chipOf('Refund partial captures')?.getAttribute('title')).toContain('/home/ada/other/.worktrees/PAY-131-b');
    expect(chipOf('Refund partial captures')?.getAttribute('title')).toContain('/home/ada/pay/.worktrees/PAY-131-a');
  });

  it('asks once on mount, not again when the status reloads with the same live keys, and again when a key joins or leaves', async () => {
    await renderBoard({ live: live('PAY-131') });
    await waitFor(() => expect(worktreeReads()).toBe(1));

    // A focus read answers the same set: a new `live` object, the same keys — no second request.
    statusAnswer = status({ repos: { PAY: ['/home/ada/pay'] }, live: live('PAY-131') });
    const reads = requested.filter((u) => u === '/api/jira').length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(requested.filter((u) => u === '/api/jira').length).toBeGreaterThan(reads));
    await new Promise((r) => setTimeout(r, 30));
    expect(worktreeReads()).toBe(1);

    // A second key goes live: the set changed, so the trees are read again.
    statusAnswer = status({ repos: { PAY: ['/home/ada/pay'] }, live: { ...live('PAY-131'), ...live('PAY-140') } });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(worktreeReads()).toBe(2));

    // And one leaves.
    statusAnswer = status({ repos: { PAY: ['/home/ada/pay'] }, live: live('PAY-140') });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(worktreeReads()).toBe(3));
  });

  it('a failed read draws no chip and no error', async () => {
    worktreesAnswer = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ error: 'git down' }) } as Response);
    await renderBoard();
    await waitFor(() => expect(worktreeReads()).toBe(1));
    expect(document.querySelectorAll('.jira-card-tree')).toHaveLength(0);
    expect(screen.queryByText('git down')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/*
  The Board as an agent deck over status shelves (Jira sessions, Task 11; spec §7.1, C1, C8; DESIGN.md §8.9.1). Rendered through `JiraView`, which carries the
  section's one sessions provider the deck reads. Sessions are links handed to the sessions answer with a state of their own; a `starting` one is not a link at
  all but a status `live` reservation (it has no session id yet), as the server hands it out.
*/
describe('the agent deck and the status shelves', () => {
  const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
  const reservation = (h: number, starting = false): JiraLiveSession => ({ sessionId: starting ? null : 's', name: 'jira run', startedAt: hoursAgo(h), repo: '/Users/ada/pay', starting });
  const linkOn = (key: string, id: string, state: string, h: number) => ({
    ...runLink(key, { ...reservation(h), sessionId: id }),
    state
  });

  async function renderDeck(firstText: string): Promise<void> {
    setJiraPage('board');
    render(
      <SettingsProvider>
        <JiraProvider>
          <JiraSessionsProvider open>
            <JiraView onOpenJiraPage={jest.fn()} />
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>,
      { wrapper: NoGitlab }
    );
    await screen.findByText(firstText);
  }

  const deckStates = (): string[] =>
    Array.from(document.querySelectorAll('.jira-deck-card')).map((c) => `${c.getAttribute('data-key')}:${c.getAttribute('data-state')}`);
  const shelfRows = (label: string): number => column(label).querySelectorAll('.board-card').length;
  const todos = (n: number): JiraIssue[] =>
    Array.from({ length: n }, (_, i) => issue({ key: `PAY-${300 + i}`, summary: `Todo ${i}`, updated: daysAgoStamp(i + 1) }));
  const dones = (n: number): JiraIssue[] =>
    Array.from({ length: n }, (_, i) =>
      issue({ key: `PAY-${400 + i}`, summary: `Done ${i}`, status: { name: 'Done', category: 'done' }, updated: daysAgoStamp(i + 1), resolved: daysAgoStamp(i + 1) })
    );

  it('orders the deck Needs you, Working, Quiet, then Starting and Lost, newest first within a group', async () => {
    lists[ALPHA.id] = ['PAY-11', 'PAY-12', 'PAY-13', 'PAY-14', 'PAY-15', 'PAY-16'].map((key) => issue({ key, summary: `Ticket ${key}` }));
    statusAnswer = status({ live: { 'PAY-15': reservation(1, true) } });
    sessionsAnswer = () => ({
      links: [
        linkOn('PAY-11', 'q', 'quiet', 5),
        linkOn('PAY-12', 'w', 'working', 4),
        linkOn('PAY-13', 'p', 'plan', 3),
        linkOn('PAY-14', 'l', 'lost', 6),
        // A second Needs you, started earlier than PAY-13's: newest first puts PAY-13 first.
        linkOn('PAY-16', 'r', 'reply', 7)
      ],
      reachable: true,
      rowsAt: null
    });
    await renderDeck('Ticket PAY-11');
    await waitFor(() => expect(deckStates()).toEqual(['PAY-13:plan', 'PAY-16:reply', 'PAY-12:working', 'PAY-11:quiet', 'PAY-15:starting', 'PAY-14:lost']));
    // The heading's tally: two want a person, one is working.
    expect(screen.getByText('2 need you')).toBeInTheDocument();
    expect(screen.getByText('1 working')).toBeInTheDocument();
  });

  it('draws no deck at all while nothing is live', async () => {
    await renderDeck('Refund partial captures');
    expect(document.querySelector('.jira-deck')).toBeNull();
  });

  it('draws the switch in the band: Board pressed, List enabled and one click away', async () => {
    await renderDeck('Refund partial captures');
    const group = screen.getByRole('group', { name: 'View' });
    expect(within(group).getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true');
    const list = within(group).getByRole('button', { name: 'List' });
    expect(list).toBeEnabled();
    await userEvent.click(list);
    expect(within(group).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    // The session table lives on Jira › Sessions now; Task 4 fills List with the issue table.
    expect(screen.queryByRole('region', { name: 'Sessions' })).toBeNull();
    // Back to the Board for the cases that follow (the view is a module store that outlives a test).
    await userEvent.click(within(group).getByRole('button', { name: 'Board' }));
  });

  it('the FilterBar is drawn in List too, and the search reads `Search issues` in both views', async () => {
    await renderDeck('Refund partial captures');
    const group = screen.getByRole('group', { name: 'View' });
    expect(screen.getByRole('button', { name: /^Filters/ })).toBeInTheDocument();
    await userEvent.click(within(group).getByRole('button', { name: 'List' }));
    expect(screen.getByRole('button', { name: /^Filters/ })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search issues' })).toHaveAttribute('placeholder', 'search summaries');
    await userEvent.click(within(group).getByRole('button', { name: 'Board' }));
  });

  it('cuts To Do at 8 rows with `+ 3 more` for 11 tops, the count pill saying 11, and opens the rest on a click', async () => {
    lists[ALPHA.id] = todos(11);
    await renderDeck('Todo 0');
    expect(shelfRows('To Do')).toBe(8);
    expect(within(column('To Do')).getByTestId('col-count')).toHaveTextContent('11');
    await userEvent.click(within(column('To Do')).getByRole('button', { name: '+ 3 more' }));
    expect(shelfRows('To Do')).toBe(11);
    await userEvent.click(within(column('To Do')).getByRole('button', { name: 'show fewer' }));
    expect(shelfRows('To Do')).toBe(8);
  });

  it('collapses Done to its 3 newest of 5', async () => {
    lists[ALPHA.id] = dones(5);
    await renderDeck('Done 0');
    expect(shelfRows('Done')).toBe(3);
    expect(summariesIn('Done')).toEqual(['Done 0', 'Done 1', 'Done 2']);
    expect(within(column('Done')).getByRole('button', { name: '+ 2 more' })).toBeInTheDocument();
  });

  // F1 and the deck answer ONE filter: a hit inside a fold rings the top on its shelf, and a live ticket that does not match leaves the deck with it.
  it('a search hit inside a fold rings the top in the shelf, and a live card the search does not match leaves the deck', async () => {
    const epic = issue({ key: 'PAY-120', summary: 'Payments epic', type: { name: 'Epic', level: 1, subtask: false } });
    const sub = issue({ key: 'PAY-162', summary: 'Ledger rounding fix', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'PAY-120', summary: 'Payments epic' } });
    const busy = issue({ key: 'PAY-180', summary: 'Standalone task' });
    lists[ALPHA.id] = [epic, sub, busy];
    sessionsAnswer = () => ({ links: [linkOn('PAY-180', 's180', 'working', 2)], reachable: true, rowsAt: null });
    await renderDeck('Payments epic');
    await waitFor(() => expect(deckStates()).toEqual(['PAY-180:working']));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'ledger');
    expect(card('Payments epic')).toHaveClass('jira-card-match');
    expect(within(card('Payments epic')).getByText('1 match: PAY-162')).toBeInTheDocument();
    expect(deckStates()).toEqual([]);
  });

  it('a session on a key two boards both hold shows its deck card on each of them', async () => {
    const shared = issue({ key: 'PAY-20', summary: 'Shared ticket' });
    lists[ALPHA.id] = [shared];
    lists[BETA.id] = [shared];
    sessionsAnswer = () => ({ links: [linkOn('PAY-20', 's20', 'working', 1)], reachable: true, rowsAt: null });
    await renderDeck('Shared ticket');
    await waitFor(() => expect(deckStates()).toEqual(['PAY-20:working']));
    await userEvent.click(screen.getByRole('button', { name: /^Pick a Jira board/ }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Boards' })).getByRole('button', { name: 'Beta board' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Pick a Jira board: Beta board/ })).toBeInTheDocument());
    await waitFor(() => expect(deckStates()).toEqual(['PAY-20:working']));
  });

  describe('the shelf row’s extra line', () => {
    const ended = (id: string, endedHoursAgo: number) => ({ ...linkOn('PAY-131', id, 'ended', 5), endedAt: hoursAgo(endedHoursAgo), endReason: 'finished' });

    it('one ended session reads `run ended <age> ago` with a Reopen link', async () => {
      sessionsAnswer = () => ({ links: [ended('e1', 2)], reachable: true, rowsAt: null });
      await renderDeck('Refund partial captures');
      const line = await within(card('Refund partial captures')).findByTestId('ended-line');
      expect(line).toHaveTextContent('run ended 2h ago');
      expect(within(line).getByRole('link')).toBeInTheDocument();
    });

    it('several ended sessions read `N sessions`, with nothing to reopen', async () => {
      sessionsAnswer = () => ({ links: [ended('e1', 2), ended('e2', 9)], reachable: true, rowsAt: null });
      await renderDeck('Refund partial captures');
      const line = await within(card('Refund partial captures')).findByTestId('ended-line');
      expect(line).toHaveTextContent('2 sessions');
      expect(within(line).queryByRole('link')).toBeNull();
    });

    it('a ticket that was never run draws no extra line', async () => {
      await renderDeck('Refund partial captures');
      expect(within(card('Refund partial captures')).queryByTestId('ended-line')).toBeNull();
    });
  });
});

/*
  Jira › Board › List is an issue table (Jira › Sessions plan, Task 4; spec "Jira › Board" D2–D4, mock `Main.dc.html`): one row per board card — a fold top,
  never a folded issue — in `sortTops` order, with a Session cell that rolls the live sessions up the way the deck does. Same fold shape as `the fold` above,
  with a second small fold (PAY-210 over PAY-211) so a top with exactly one folded issue is on the list too.
*/
describe('the issue List', () => {
  const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
  const linkOn = (key: string, id: string, state: string, h: number) => ({
    ...runLink(key, { sessionId: id, name: 'jira run', startedAt: hoursAgo(h), repo: '/Users/ada/pay', starting: false }),
    state
  });
  const EPIC = { name: 'Epic', level: 1, subtask: false };
  const STORY = { name: 'Story', level: 0, subtask: false };
  const SUB = { name: 'Sub-task', level: -1, subtask: true };
  const DOING = { name: 'In Progress', category: 'indeterminate' as const };
  const G_120 = issue({ key: 'PAY-120', summary: 'Payments epic', type: EPIC, updated: daysAgoStamp(5) });
  const G_160 = issue({ key: 'PAY-160', summary: 'Ledger story', type: STORY, status: DOING, parent: { key: 'PAY-120', summary: 'Payments epic' }, updated: daysAgoStamp(4) });
  const G_162 = issue({ key: 'PAY-162', summary: 'Ledger rounding fix', type: SUB, parent: { key: 'PAY-160', summary: 'Ledger story' }, updated: daysAgoStamp(0) });
  const G_170 = issue({ key: 'PAY-170', summary: 'Payout story', type: STORY, parent: { key: 'PAY-120', summary: 'Payments epic' }, updated: daysAgoStamp(6) });
  const G_180 = issue({ key: 'PAY-180', summary: 'Standalone task', updated: daysAgoStamp(1) });
  const G_190 = issue({ key: 'PAY-190', summary: 'Payout retries', status: DOING, assignee: ADA, sprint: 'Sprint 44', parent: { key: 'PAY-999', summary: 'Billing platform' }, updated: daysAgoStamp(2) });
  const G_210 = issue({ key: 'PAY-210', summary: 'Chargeback upload', updated: daysAgoStamp(5) });
  const G_211 = issue({ key: 'PAY-211', summary: 'Chargeback storage', type: SUB, parent: { key: 'PAY-210', summary: 'Chargeback upload' }, updated: daysAgoStamp(1.5) });
  const GROUP = [G_120, G_160, G_162, G_170, G_180, G_190, G_210, G_211];

  async function renderList(issues: JiraIssue[] = GROUP): Promise<void> {
    lists[ALPHA.id] = issues;
    setJiraView('list');
    setJiraPage('board');
    onOpenIssue = jest.fn();
    render(
      <SettingsProvider>
        <JiraProvider>
          <JiraSessionsProvider open>
            <JiraBoardView onOpenJiraPage={jest.fn()} onOpenIssue={onOpenIssue} onRun={jest.fn()} nudge={0} />
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>,
      { wrapper: NoGitlab }
    );
    await screen.findByRole('table');
  }
  afterEach(() => setJiraView('board'));

  const rowKeys = (): string[] => Array.from(document.querySelectorAll('tr[data-key]')).map((r) => r.getAttribute('data-key') ?? '');
  const row = (key: string): HTMLElement => document.querySelector(`tr[data-key="${key}"]`) as HTMLElement;
  const sessionCell = (key: string): string => row(key).querySelector('.jira-issues-session')?.textContent ?? '';

  it('draws one row per top and no folded issue, in sortTops order', async () => {
    await renderList();
    // PAY-120 rises on PAY-162's stamp, PAY-210 on PAY-211's; PAY-190 (2 d) sinks below them. Input order is 120, 180, 190, 210.
    expect(rowKeys()).toEqual(['PAY-120', 'PAY-180', 'PAY-210', 'PAY-190']);
    for (const folded of ['PAY-160', 'PAY-162', 'PAY-170', 'PAY-211']) expect(row(folded)).toBeNull();
    expect(screen.queryByText('Ledger rounding fix')).toBeNull();
  });

  it('puts a newer top first even when the served list ends with it', async () => {
    await renderList([...GROUP, issue({ key: 'PAY-100', summary: 'Fresh work', status: DOING, updated: daysAgoStamp(0) })]);
    expect(rowKeys()[0]).toBe('PAY-100');
  });

  it('draws the columns of the mock: key, summary, type, raw status, assignee, sprint and the rolled-up age', async () => {
    await renderList();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Session', 'Key', 'Summary', 'Type', 'Status', 'Priority', 'Assignee', 'Sprint', 'Updated', '']);
    const r = row('PAY-190');
    expect(within(r).getByText('PAY-190')).toBeInTheDocument();
    expect(within(r).getByText('Payout retries')).toBeInTheDocument();
    expect(within(r).getByText('Task')).toBeInTheDocument();
    expect(within(r).getByText('In Progress')).toBeInTheDocument();
    expect(within(r).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(r).getByText('Sprint 44')).toBeInTheDocument();
    expect(within(row('PAY-180')).getByText('unassigned')).toBeInTheDocument();
    // The Sprint cell is the 8th; the Session cell reads `—` too when nothing ran, so the lookup is scoped.
    expect(within((row('PAY-180') as HTMLTableRowElement).cells[7]).getByText('—')).toBeInTheDocument();
  });

  it('draws a priority pill per row, `Not prioritised` for null, a Run split per row, and the full summary as the cell title', async () => {
    await renderList([issue({ key: 'PAY-1', summary: 'A very long summary that the cell will cut', priority: 'High' }), issue({ key: 'PAY-2', summary: 'Plain', priority: null })]);
    expect(within(row('PAY-1')).getByTitle('priority High')).toHaveClass('jira-card-prio');
    expect(within(row('PAY-2')).getByText('Not prioritised')).toHaveAttribute('data-tone', 'low');
    for (const key of ['PAY-1', 'PAY-2']) expect(within(row(key)).getAllByRole('button', { name: `Run ${key}` })).toHaveLength(1);
    expect(row('PAY-1').querySelector('.jira-issues-summary')).toHaveAttribute('title', 'A very long summary that the cell will cut');
  });

  it('the Summary cell is a flex row (title ellipsises, count never cut) and the Session cell keeps its age out of the ellipsis (ui-verify D3, D4)', async () => {
    sessionsAnswer = () => ({ links: [linkOn('PAY-120', 's1', 'plan', 3)], reachable: true, rowsAt: null });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-120')).toContain('Waiting for plan approval'));
    const summary = row('PAY-120').querySelector('.jira-issues-summary') as HTMLElement;
    const flex = summary.querySelector('.jira-issues-flex') as HTMLElement;
    expect(flex.querySelector('.jira-issues-title')).not.toBeNull();
    expect(flex.querySelector('.jira-issues-under')?.textContent).toBe('3 under it');
    const session = row('PAY-120').querySelector('.jira-issues-session') as HTMLElement;
    expect(session.querySelector('.jira-issues-cut')?.textContent).toBe('Waiting for plan approval');
    expect(session.querySelector('.jira-issues-age')?.textContent).toMatch(/^ · \d/);
  });

  it('names the folded ticket a session runs on under the Session cell\u2019s state, and counts the card\u2019s other live sessions', async () => {
    sessionsAnswer = () => ({ links: [linkOn('PAY-162', 's1', 'working', 1), linkOn('PAY-170', 's2', 'working', 3), linkOn('PAY-180', 's3', 'working', 2)], reachable: true, rowsAt: null });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-120')).toContain('Working'));
    const on = row('PAY-120').querySelector('.jira-issues-on') as HTMLElement;
    expect(on.querySelector('.ui-fold')).toHaveTextContent('↳ PAY-162');
    expect(on.querySelector('.jira-issues-more')).toHaveTextContent('+1');
    // A session on the top itself needs no mark: the row already is its ticket.
    expect(sessionCell('PAY-180')).toContain('Working');
    expect(row('PAY-180').querySelector('.jira-issues-on')).toBeNull();
  });

  it('names how many issues fold under a top: the whole fold, one for a single, nothing for none', async () => {
    await renderList();
    // PAY-120 has two direct children but three folded issues (160, 162 under it, 170); the count is the fold's, not the children's.
    expect(row('PAY-120').textContent).toContain('3 under it');
    expect(row('PAY-210').textContent).toContain('1 under it');
    expect(row('PAY-180').textContent).not.toContain('under it');
  });

  it('marks a top for a session live only on a folded child, and never draws the child', async () => {
    // 2.05, not 2: the same race the ended-row case below names — the row's `now` is read at mount, before `sessionsAnswer` mints this stamp, so an exact
    // 2 h reads `1h` by a few ms. It went red in CI on PR #480 (a CSS-only change), so it is the fixture's flake, not the row's.
    sessionsAnswer = () => ({ links: [linkOn('PAY-162', 's162', 'working', 2.05)], reachable: true, rowsAt: null });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-120')).toContain('Working · 2h'));
    expect(sessionCell('PAY-180')).toBe('—');
    expect(row('PAY-162')).toBeNull();
  });

  it('names the deck’s lead session on a card with two: needs you beats working, and the deck leads with the same one', async () => {
    sessionsAnswer = () => ({ links: [linkOn('PAY-120', 'a', 'working', 3), linkOn('PAY-162', 'b', 'answer', 2)], reachable: true, rowsAt: null });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-120')).toContain('Waiting on your answer'));
    await userEvent.click(screen.getByRole('button', { name: 'Board' }));
    const first = document.querySelector('.jira-deck-card');
    expect(first?.getAttribute('data-state')).toBe('answer');
    expect(first?.getAttribute('data-key')).toBe('PAY-162');
  });

  it('reads `Ended · 2h` for a top whose only session ended on a folded child', async () => {
    sessionsAnswer = () => ({ links: [{ ...linkOn('PAY-162', 'e', 'ended', 5), endedAt: hoursAgo(2.05) /* a margin: the row's `now` is read at mount, before this stamp is minted, and exactly 2 h reads `1h` by a few ms */, endReason: 'finished' }], reachable: true, rowsAt: null });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-120')).toContain('Ended · 2h'));
  });

  it('keeps a top whose folded issue matches the search', async () => {
    await renderList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'ledger rounding');
    expect(rowKeys()).toEqual(['PAY-120']);
  });

  it('the FilterBar filters the rows: assignee me leaves only my tops', async () => {
    await renderList();
    await pick('Assignee', 'me');
    expect(rowKeys()).toEqual(['PAY-190']);
  });

  it('reads the rolled-up time in Updated: a child’s 1.5 d, not the top’s 5 d', async () => {
    await renderList();
    expect(row('PAY-210').querySelector('.jira-issues-updated')?.textContent).toBe(elapsedSince(G_211.updated));
    expect(row('PAY-210').querySelector('.jira-issues-updated')?.textContent).toBe('1d');
  });

  it('opens the modal with the fold on a row click, and not from the Jira link', async () => {
    await renderList();
    await userEvent.click(within(row('PAY-120')).getByRole('link', { name: /open PAY-120 in Jira/ }));
    expect(onOpenIssue).not.toHaveBeenCalled();
    // The Type cell is plain text: only the row's own handler can open the modal from it (the summary button has its own).
    await userEvent.click(within(row('PAY-120')).getByText('Epic'));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    const [opened, index] = onOpenIssue.mock.calls[0] as [JiraIssue, ReadonlyMap<string, readonly JiraIssue[]>];
    expect(opened).toBe(G_120);
    expect(index.get('PAY-160')?.map((i) => i.key)).toEqual(['PAY-162']);
  });

  it('says `No issues match` when a search cuts every row', async () => {
    await renderList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'zzzz');
    expect(screen.getByText('No issues match')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says `No issues` for a loaded board with nothing on it', async () => {
    lists[ALPHA.id] = [];
    setJiraView('list');
    render(
      <SettingsProvider>
        <JiraProvider>
          <JiraSessionsProvider open>
            <JiraBoardView onOpenJiraPage={jest.fn()} onOpenIssue={jest.fn()} onRun={jest.fn()} nudge={0} />
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>,
      { wrapper: NoGitlab }
    );
    expect(await screen.findByText('No issues')).toBeInTheDocument();
  });
});

/*
  `Run on` through the real pages (spec `2026-11-11-jira-run-on-parent-design.md` §4.2, §6 cases 12 and 13; anti-goal 1). `jira-run-menu.test.tsx` calls the
  menu's `onPick` directly, so it cannot see a CALLER that closes over its own issue and drops the one the menu hands it; these go through `JiraView`, whose
  launch sheet names the issue it was opened on. The sub-task's parent, PAY-99, is on no board — the case the feature exists for — so only the parent read
  (answered below with a detail) can supply it.
*/
describe('Run on: a sub-task runs its parent from the card and the List cell', () => {
  const SUB = issue({
    key: 'PAY-175',
    summary: 'Prepare refund TODOs',
    type: { name: 'Sub-task', level: -1, subtask: true },
    parent: { key: 'PAY-99', summary: 'Payments platform' },
    updated: daysAgoStamp(0)
  });
  const PARENT = issue({ key: 'PAY-99', summary: 'Payments platform', type: { name: 'Story', level: 0, subtask: false } });

  async function renderWithParent(view: 'board' | 'list'): Promise<void> {
    lists[ALPHA.id] = [...ALPHA_ISSUES, SUB];
    statusAnswer = status({ repos: { PAY: ['/Users/ada/pay'] } });
    const base = global.fetch as jest.Mock;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/jira/issue/PAY-99') {
        requested.push(String(input));
        return ok({ ...PARENT, description: '', children: [], transitions: [], boards: [], session: null });
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    setJiraView(view);
    setJiraPage('board');
    render(
      <SettingsProvider>
        <JiraProvider>
          <JiraSessionsProvider open>
            <JiraView onOpenJiraPage={jest.fn()} />
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>,
      { wrapper: NoGitlab }
    );
    await screen.findByText('Prepare refund TODOs');
  }
  afterEach(() => act(() => setJiraView('board')));

  async function runParentFrom(scope: HTMLElement): Promise<void> {
    await userEvent.click(within(scope).getByRole('button', { name: 'Run options for PAY-175' }));
    const menu = screen.getByRole('dialog', { name: 'Run menu' });
    await userEvent.click(within(within(menu).getByRole('group', { name: 'Run on' })).getByRole('button', { name: /^PAY-99\b/ }));
    const work = within(menu).getByRole('button', { name: JIRA_BUILTIN_LABELS.execute });
    await waitFor(() => expect(work).toBeEnabled());
    await userEvent.click(work);
  }

  it("a card's parent pick opens the sheet as the parent's, with the parent's key-and-slug branch default", async () => {
    await renderWithParent('board');
    await runParentFrom(card('Prepare refund TODOs'));
    const sheet = await screen.findByRole('dialog', { name: 'run PAY-99' });
    expect(screen.queryByRole('dialog', { name: 'run PAY-175' })).toBeNull();
    const name = (await within(sheet).findByLabelText('Name')) as HTMLInputElement;
    expect(name.value).toBe('pay-99-payments-platform');
  });

  it("the List cell's parent pick opens the sheet as the parent's", async () => {
    await renderWithParent('list');
    const row = document.querySelector('tr[data-key="PAY-175"]') as HTMLElement;
    await runParentFrom(row);
    expect(await screen.findByRole('dialog', { name: 'run PAY-99' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'run PAY-175' })).toBeNull();
  });
});
