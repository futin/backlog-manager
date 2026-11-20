/**
 * @jest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraBoardView } from '../../client/src/components/jira/JiraBoardView';
import JiraView from '../../client/src/components/jira/JiraView';
import { JiraSessionsProvider } from '../../client/src/hooks/JiraSessionsContext';
import { JiraProvider } from '../../client/src/hooks/JiraContext';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { setJiraPage } from '../../client/src/hooks/useJiraPage';
import { getJiraTicket, setJiraTicketKey, syncJiraTicket } from '../../client/src/hooks/useJiraTicketKey';
import { browserPlatform, fullPageTitle } from '../../client/src/lib/open-intent';
import { setJiraDetailTab } from '../../client/src/hooks/useJiraDetailTab';
import { setJiraView } from '../../client/src/hooks/useJiraView';
import { elapsedSince } from '../../client/src/lib/item-age';
import { JIRA_BOARD_KEY, JIRA_FILTERS_KEY, JIRA_LANE_FOLDS_KEY, LANE_INDENT_CAP, bandSub } from '../../client/src/lib/jira';
import { JIRA_PAGE_KEY } from '../../client/src/lib/jira-page';
import { GitlabContext } from '../../client/src/hooks/GitlabContext';
import { NoGitlab } from '../helpers/no-gitlab';
import { daysAgoStamp } from '../helpers/dates';
import { readStyles, ruleBlock } from '../helpers/css-rule';
import {
  JIRA_BUILTIN_LABELS,
  type AgentsStatus,
  type DashboardRow,
  type GitlabMr,
  type GitlabPayload,
  type JiraBoardStatus,
  type JiraIssue,
  type JiraLiveSession,
  type JiraStatusPayload
} from '../../shared/types';

/*
  Jira › Board (Jira phase 2; spec §6.2; DESIGN.md §8.9.1) — the real page over a mocked `fetch`, in the style of `tracker-board.test.tsx`: the band
  and its picker, the three filters and the summary search, the three status-category columns and the card face, and the two shapes that must never be
  confused with an empty site — a `jira.json` that cannot be read (Review Focus 2) and a stored board pick that names no board (Review Focus 3).

  The page reads `GET /api/jira` through the real `JiraProvider` and one board's list through the real `useJiraBoard`; both are answered here, and every
  URL the page asks for is recorded, because two of the cases below are about a request that must NOT be made. Fixture stamps are relative to the clock the
  assertion runs under (`test/helpers/dates.ts`, guarded by `test/guards/fixture-clock.test.ts`).
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
  parent: { key: 'PAY-99', summary: 'Payments platform', type: null, status: null },
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
    mentions: null,
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
  // The Detail's tab is a module store that outlives a mount (and the storage clear above): every case opens on Ticket, as a first open does.
  setJiraDetailTab('ticket');
  // The key store and the address outlive a case too: a ticket page one case opened would leave `?section=jira&ticket=…` and its key for the next.
  window.history.replaceState(null, '', '/');
  act(() => syncJiraTicket('', 'board'));
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
  await screen.findAllByText('Refund partial captures');
}

/** The lane card holding `summary` — a live ticket's summary is on its deck card too, and an on-board header's is a row, never a card. */
function card(summary: string): HTMLElement {
  return screen.getAllByText(summary).map((n) => n.closest<HTMLElement>('.board-card')).find((c) => c !== null) as HTMLElement;
}

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

/* The lane fixture (parent-lanes spec §3; mocks `Board.dc.html`, `BoardDeep.dc.html`). PAY-120, the followed Epic, is an on-board header with one card
   (PAY-170, Done) and one nested lane — PAY-160, whose children are PAY-161 (Done) and PAY-162 (To Do, touched today). PAY-180 has no parent; PAY-190's
   parent PAY-999 is off the board, so its lane's header is the child's stub. Headers sit in no column, so the columns count five cards: 2 · 1 · 2. */
const G_120 = issue({ key: 'PAY-120', summary: 'Payments epic', type: { name: 'Epic', level: 1, subtask: false }, updated: daysAgoStamp(5) });
const G_160 = issue({
  key: 'PAY-160',
  type: { name: 'Story', level: 0, subtask: false },
  status: { name: 'In Progress', category: 'indeterminate' },
  parent: { key: 'PAY-120', summary: 'Payments epic', type: null, status: null },
  updated: daysAgoStamp(4)
});
const G_161 = issue({
  key: 'PAY-161',
  type: { name: 'Sub-task', level: -1, subtask: true },
  status: { name: 'Done', category: 'done' },
  parent: { key: 'PAY-160', summary: 'Summary of PAY-160', type: null, status: null },
  updated: daysAgoStamp(3),
  resolved: daysAgoStamp(3)
});
const G_162 = issue({
  key: 'PAY-162',
  summary: 'Ledger rounding fix',
  type: { name: 'Sub-task', level: -1, subtask: true },
  parent: { key: 'PAY-160', summary: 'Summary of PAY-160', type: null, status: null },
  updated: daysAgoStamp(0)
});
const G_170 = issue({
  key: 'PAY-170',
  type: { name: 'Story', level: 0, subtask: false },
  status: { name: 'Done', category: 'done' },
  parent: { key: 'PAY-120', summary: 'Payments epic', type: null, status: null },
  updated: daysAgoStamp(6),
  resolved: daysAgoStamp(6)
});
const G_180 = issue({ key: 'PAY-180', summary: 'Standalone task', updated: daysAgoStamp(1) });
const G_190 = issue({
  key: 'PAY-190',
  summary: 'Payout retries',
  status: { name: 'In Progress', category: 'indeterminate' },
  parent: { key: 'PAY-999', summary: 'Billing platform', type: null, status: null },
  updated: daysAgoStamp(2)
});
const GROUP = [G_120, G_160, G_161, G_162, G_170, G_180, G_190];

async function renderGroup(): Promise<void> {
  lists[ALPHA.id] = GROUP;
  renderPage();
  await screen.findByText('Standalone task');
}

/** A lane's `<section>` by its key (`none` for `No parent`), or null when the lane is not drawn. */
const lane = (key: string): HTMLElement | null => document.querySelector<HTMLElement>(`section.jira-lane[data-lane="${key}"]`);
const headOf = (key: string): HTMLElement => lane(key)?.querySelector('.jira-lane-head') as HTMLElement;
/** Every drawn lane's key, in document order — the lanes are drawn flat, a nested lane right after its parent's cells. */
const laneKeys = (): string[] => Array.from(document.querySelectorAll('section.jira-lane')).map((s) => s.getAttribute('data-lane') ?? '');
const cellSummaries = (laneKey: string, slug: 'todo' | 'doing' | 'done'): string[] =>
  Array.from(screen.getByTestId(`cell-${laneKey}-${slug}`).querySelectorAll('.board-card-title')).map((t) => t.textContent ?? '');
/** One lane's three tile counts, To Do · In Progress · Done — each tile's own head, there is no page-wide column header. */
const tileCounts = (laneKey: string): string[] =>
  (['todo', 'doing', 'done'] as const).map((s) => screen.getByTestId(`cell-${laneKey}-${s}`).querySelector('.jira-cell-count')?.textContent ?? '');
/** Every drawn tile's count summed per category, To Do · In Progress · Done — what the cards on screen add up to. */
const tileTotals = (): number[] =>
  (['todo', 'doing', 'done'] as const).map((s) =>
    Array.from(document.querySelectorAll(`.jira-cell-head[data-tone="${s}"] .jira-cell-count`)).reduce((a, e) => a + Number(e.textContent), 0)
  );
/** What `GET /api/jira/issue/<KEY>` answers for an off-board parent's read. */
const detailOf = (i: JiraIssue) => ({ ...i, description: '', children: [], transitions: [], boards: [], session: null });
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Answers `/api/jira/issue/<KEY>` from `reads`, every other URL as `beforeEach` does, and records the issue reads. */
function answerReads(reads: Record<string, () => Promise<Response>>): void {
  const answered = global.fetch;
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const m = /^\/api\/jira\/issue\/([^/?]+)$/.exec(String(input));
    if (m !== null && reads[decodeURIComponent(m[1])] !== undefined) {
      requested.push(String(input));
      return reads[decodeURIComponent(m[1])]();
    }
    return (answered as jest.Mock)(input, init);
  }) as unknown as typeof fetch;
}
const issueReads = (): string[] => requested.filter((u) => u.startsWith('/api/jira/issue/'));

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
  // ALPHA's list has one parent behind it: PAY-131's off-board PAY-99 (the other three sit in `No parent`, which is not one).
  it('reads bandSub’s text for the board under the title, `1 parent` in the singular', async () => {
    await renderAlpha();
    const sub = bandSub(ALPHA, 'acme.atlassian.net', Date.now(), { issues: 4, parents: 1 });
    expect(sub.text).toBe('acme.atlassian.net · 4 issues from 1 root and 1 query · 1 parent · polled 10m ago');
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toBe(sub.text);
  });

  // Mock A (2026-11-18): the site as a word, each count a neutral pill, then a toned dot and the age. ALPHA polled ten minutes ago on a `1m` interval, so
  // its dot is the chip's amber "late"; the hidden words give a screen reader the state and the `polled` the visible age drops.
  it('draws the site, one neutral pill per count, and the dot with the age', async () => {
    await renderAlpha();
    const row = document.querySelector('.jira-band-sub') as HTMLElement;
    expect(row.querySelector('.jira-band-site')?.textContent).toBe('acme.atlassian.net');
    expect([...row.querySelectorAll('.ui-pill-neutral')].map((p) => p.textContent)).toEqual(['4 issues', '1 parent', '1 root', '1 query']);
    expect(row.querySelector('.ui-pill-bad')).toBeNull();
    const poll = row.querySelector('.ui-poll') as HTMLElement;
    expect(poll.querySelector('.ui-poll-dot')).toHaveAttribute('data-tone', 'amber');
    expect(poll).toHaveAttribute('title', 'polled 10m ago');
    expect(poll.textContent).toBe('late, polled 10m ago');
  });

  /*
    The GitLab line (GitLab connection spec §7.2): `bandTotals` over the issues the page's filters match, under the board's own sub-line. The payload is
    handed in through the raw context, as the shell's one answer would hand it over; PAY maps one GitLab project polled two minutes ago, PAY-131 leads
    with an open MR whose pipeline failed and PAY-140 with a merged one.
  */
  const gitlabMr = (over: Partial<GitlabMr>): GitlabMr => ({
    project: 'payments/api',
    iid: 415,
    title: 'PAY-131 | refund partial captures',
    webUrl: 'https://gitlab.example.test/payments/api/-/merge_requests/415',
    state: 'opened',
    draft: false,
    sourceBranch: 'pay-131-refunds',
    targetBranch: 'develop',
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    mergedAt: null,
    pipeline: 'failed',
    keys: ['PAY-131'],
    review: null,
    ...over
  });
  const gitlab = (over: Partial<GitlabPayload['status']> = {}): GitlabPayload => ({
    status: {
      state: 'connected',
      site: 'gitlab.example.test',
      malformedSite: false,
      user: { username: 'ada', name: 'Ada' },
      httpStatus: null,
      reason: null,
      armed: true,
      retryAt: null,
      mappedRepos: 1,
      foundHosts: [],
      problems: [],
      interval: '1m',
      ...over
    },
    jiraProjects: { PAY: [{ path: 'payments/api', repo: 'api', polledAt: new Date(Date.now() - 120_000).toISOString(), capped: false, failed: false, repos: [] }] },
    mrs: [gitlabMr({}), gitlabMr({ iid: 398, state: 'merged', pipeline: null, keys: ['PAY-140'], mergedAt: new Date(Date.now() - 86_400_000).toISOString() })]
  });
  async function renderWithGitlab(data: GitlabPayload, drawn = 'Refund partial captures'): Promise<void> {
    render(
      <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>
        <JiraProvider>
          <JiraBoardView onOpenJiraPage={jest.fn()} onOpenIssue={jest.fn()} onRun={jest.fn()} nudge={0} />
        </JiraProvider>
      </GitlabContext.Provider>
    );
    await screen.findByText(drawn);
  }

  it('adds the GitLab half beside the sub-line while GitLab is shown, counted over the matching issues', async () => {
    await renderWithGitlab(gitlab());
    const line = document.querySelector('.ui-band-sub .jira-band-gitlab');
    expect(line?.getAttribute('title')).toBe('GitLab: 1 open · 1 failing · 1 merged · polled 2m ago');
    // Mock A: the same counts as pills after the Jira half, `failing` the red one, then GitLab's own dot and age.
    expect([...(line?.querySelectorAll('.ui-pill') ?? [])].map((p) => `${p.className}|${p.textContent}`)).toEqual([
      'ui-pill ui-pill-neutral ui-pill-raised|1 open',
      'ui-pill ui-pill-bad|1 failing',
      'ui-pill ui-pill-neutral ui-pill-raised|1 merged'
    ]);
    expect(line?.querySelector('.ui-poll-dot')).toHaveAttribute('data-tone', 'green');
    expect(line?.textContent).toContain('GitLab');
    // The board's own sub-line is untouched beside it.
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toMatch(/^acme\.atlassian\.net · 4 issues/);
  });

  // Spec §6.1: the line counts every matching issue, so an MR on a nested on-board child counts. Under the old fold model PAY-162 folded into its top,
  // PAY-120, and its MR went uncounted; ALPHA's default list has only tops, so the case above cannot tell the two wirings apart.
  it('counts an MR that sits only on a nested on-board child', async () => {
    lists[ALPHA.id] = GROUP;
    await renderWithGitlab({ ...gitlab(), mrs: [gitlabMr({ title: 'PAY-162 | ledger rounding', pipeline: null, keys: ['PAY-162'] })] }, 'Ledger rounding fix');
    expect(document.querySelector('.ui-band-sub .jira-band-gitlab')?.getAttribute('title')).toBe('GitLab: 1 open · polled 2m ago');
  });

  it('draws no GitLab text anywhere on the board while GitLab is unconfigured', async () => {
    await renderWithGitlab({ ...gitlab({ state: 'unconfigured', site: null, user: null, armed: false }), jiraProjects: {}, mrs: [] });
    expect(document.body.textContent).not.toContain('GitLab:');
    expect(document.querySelector('.jira-mr-chip')).toBeNull();
  });

  // Mock A: a failed sweep reddens one pill — Jira's message, titled with it whole since the pill ellipsises — and the dot, never the counts beside them.
  it('draws a failing board’s message as one red pill and a red dot, the counts left neutral', async () => {
    statusAnswer = status({ boards: [BETA, { ...ALPHA, failures: [{ kind: 'query', id: 'q_00000001', message: "Field 'foo' does not exist" }] }] });
    await renderAlpha();
    const sub = document.querySelector('.jira-band-sub') as HTMLElement;
    expect(sub).not.toHaveClass('failing');
    const bad = sub.querySelector('.ui-pill-bad') as HTMLElement;
    expect(bad.textContent).toBe("Field 'foo' does not exist");
    expect(bad).toHaveAttribute('title', "Field 'foo' does not exist");
    expect(sub.querySelectorAll('.ui-pill-neutral').length).toBeGreaterThan(0);
    expect(sub.querySelector('.ui-poll-dot')).toHaveAttribute('data-tone', 'red');
  });
  // GROUP's parents: PAY-120 and the nested PAY-160 (on-board headers) and PAY-999 (off-board) — `No parent` is not one.
  it('the band counts the loaded list, not the status poll, and adds the parents part', async () => {
    await renderGroup();
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toBe('acme.atlassian.net · 7 issues from 1 root and 1 query · 3 parents · polled 10m ago');
  });

  it('the band reads the status count, with no parents part, while the list has not loaded', async () => {
    const answered = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      /\/issues$/.test(String(input)) ? new Promise<Response>(() => {}) : answered(input)
    ) as unknown as typeof fetch;
    renderPage();
    await screen.findByText('loading…');
    await waitFor(() => expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toBe(bandSub(ALPHA, 'acme.atlassian.net', Date.now(), null).text));
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toContain(' · 4 issues ');
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).not.toContain('parent');
  });

  it('a board of parentless issues has no parents part', async () => {
    lists[ALPHA.id] = [PAY_120, PAY_140, PAY_151];
    renderPage();
    await screen.findByText('Refund flows');
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toBe('acme.atlassian.net · 3 issues from 1 root and 1 query · polled 10m ago');
  });

  /*
    Sixteen issues under eight parents (parent-lanes spec §6.1), on a query-only board: four on-board headers PAY-201..204 with one card each, and four
    off-board parents PAY-901..904 with two cards each. Half the issues are Bugs, so a Type filter hides half of them — and the band, which describes the
    board and not the view, does not move.
  */
  const EIGHT = (() => {
    const out: JiraIssue[] = [];
    const typeOf = (n: number): JiraIssue['type'] => (n % 2 === 0 ? { name: 'Bug', level: 0, subtask: false } : { name: 'Story', level: 0, subtask: false });
    let n = 0;
    const next = (key: string, parent: JiraIssue['parent']): void => {
      out.push(issue({ key, summary: `Issue ${key}`, type: typeOf(n), parent, updated: daysAgoStamp(n) }));
      n += 1;
    };
    for (const h of [201, 202, 203, 204]) {
      next(`PAY-${h}`, null);
      next(`PAY-${h + 100}`, { key: `PAY-${h}`, summary: `Header ${h}`, type: null, status: null });
    }
    for (const p of [901, 902, 903, 904]) {
      next(`PAY-${p + 10}`, { key: `PAY-${p}`, summary: `Off-board ${p}`, type: null, status: null });
      next(`PAY-${p + 20}`, { key: `PAY-${p}`, summary: `Off-board ${p}`, type: null, status: null });
    }
    return out;
  })();
  const QUERY_ONLY = { ...ALPHA, roots: [] as string[] };

  it('sixteen issues under eight parents read `16 issues from 1 query · 8 parents`, and a filter that hides half of them moves nothing', async () => {
    statusAnswer = status({ boards: [BETA, QUERY_ONLY] });
    lists[ALPHA.id] = EIGHT;
    renderPage();
    await screen.findByText('Issue PAY-301');
    const before = document.querySelector('.jira-band-sub')?.getAttribute('title');
    expect(before).toBe('acme.atlassian.net · 16 issues from 1 query · 8 parents · polled 10m ago');
    await pick('Type', 'Bug');
    expect(screen.queryByText('Issue PAY-301')).toBeNull();
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toBe(before);
  });

  // Review Focus 5: the band counts the unfiltered list, whatever the filters hide.
  it('a filter never moves the band', async () => {
    await renderGroup();
    const before = document.querySelector('.jira-band-sub')?.getAttribute('title');
    await pick('Type', 'Sub-task');
    expect(document.querySelector('.jira-band-sub')?.getAttribute('title')).toBe(before);
    expect(before).toContain('7 issues from 1 root and 1 query · 3 parents');
  });
});

/*
  The lanes (parent-lanes spec §3; DESIGN.md §8.9.1): no page-wide column header, one lane per parent — an on-board header, an off-board stub, or
  `No parent` — each with its three cell tiles, every tile headed by its category and its count. ALPHA's list makes two: PAY-131 under the off-board PAY-99, and the other three under `No parent`.
*/
describe('the lanes', () => {
  it('draws no page-wide column header; every tile names its category in tone order, with a dot and its own lane’s count', async () => {
    await renderAlpha();
    expect(document.querySelector('.jira-lanes-head')).toBeNull();
    for (const key of ['none', 'PAY-99']) {
      const heads = (['todo', 'doing', 'done'] as const).map((s) => screen.getByTestId(`cell-${key}-${s}`).querySelector('.jira-cell-head') as HTMLElement);
      expect(heads.map((h) => h.getAttribute('data-tone'))).toEqual(['todo', 'doing', 'done']);
      expect(heads.map((h) => h.querySelector('.jira-cell-name')?.textContent)).toEqual(['To Do', 'In Progress', 'Done']);
      for (const h of heads) expect(h.querySelectorAll('.jira-cell-dot')).toHaveLength(1);
    }
    // Lane-local, not page totals: `No parent` holds two To Do cards and one Done, PAY-99 the one In Progress card.
    expect(tileCounts('none')).toEqual(['2', '0', '1']);
    expect(tileCounts('PAY-99')).toEqual(['0', '1', '0']);
  });

  it('a status Jira files under To Do (In Testing, In Review) sits in the To Do tile, its own status word on the card', async () => {
    lists[ALPHA.id] = [
      issue({ key: 'PAY-701', summary: 'Testing ticket', status: { name: 'In Testing', category: 'new' }, updated: daysAgoStamp(1) }),
      issue({ key: 'PAY-702', summary: 'Review ticket', status: { name: 'In Review', category: 'new' }, updated: daysAgoStamp(2) })
    ];
    renderPage();
    await screen.findByText('Testing ticket');
    expect(cellSummaries('none', 'todo')).toEqual(['Testing ticket', 'Review ticket']);
    expect(tileCounts('none')).toEqual(['2', '0', '0']);
    const todo = screen.getByTestId('cell-none-todo');
    expect(within(todo).getByText('In Testing')).toBeInTheDocument();
    expect(within(todo).getByText('In Review')).toBeInTheDocument();
  });

  it('puts PAY-131 in its off-board parent’s lane and the rest under `No parent`, each cell newest first', async () => {
    await renderAlpha();
    expect([...laneKeys()].sort()).toEqual(['PAY-99', 'none']);
    expect(cellSummaries('PAY-99', 'doing')).toEqual(['Refund partial captures']);
    // PAY-151 was updated today and PAY-120 two days ago — the list order (PAY-120 first) must not survive.
    expect(cellSummaries('none', 'todo')).toEqual(['Rounding wrong on invoices over 1,000', 'Refund flows']);
    expect(cellSummaries('none', 'done')).toEqual(['Currency symbol missing on receipts']);
    expect(within(headOf('none')).getByText('No parent')).toBeInTheDocument();
  });

  it('a board with no issues draws `No issues` and no lanes', async () => {
    lists[ALPHA.id] = [];
    renderPage();
    expect(await screen.findByText('No issues')).toBeInTheDocument();
    expect(document.querySelector('.jira-lanes-head')).toBeNull();
    expect(laneKeys()).toEqual([]);
    expect(screen.queryByText('No boards yet')).toBeNull();
  });

  it('filters that match nothing read `No issues match`', async () => {
    await renderAlpha();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'zzz-nothing');
    expect(screen.getByText('No issues match')).toBeInTheDocument();
    expect(laneKeys()).toEqual([]);
  });

  // §3.1: header issues are in no column. GROUP's cards are PAY-162 and PAY-180 (To Do), PAY-190 (In Progress), PAY-161 and PAY-170 (Done); PAY-120 and
  // PAY-160 are headers. A lane's count is its subtree's matching issues, nested headers included.
  it('counts cards, never headers, and a lane counts its subtree: `4 issues` on PAY-120, `2 issues` on the nested PAY-160', async () => {
    await renderGroup();
    expect(tileTotals()).toEqual([2, 1, 2]);
    expect(headOf('PAY-120').querySelector('.jira-lane-count')).toHaveTextContent('4 issues');
    expect(headOf('PAY-160').querySelector('.jira-lane-count')).toHaveTextContent('2 issues');
    expect(headOf('PAY-120').querySelectorAll('.ui-spread-seg').length).toBeGreaterThan(0);
  });

  it('nests PAY-160 after PAY-120’s cells at depth 1, and draws every issue exactly once', async () => {
    await renderGroup();
    expect(laneKeys().indexOf('PAY-160')).toBe(laneKeys().indexOf('PAY-120') + 1);
    expect(lane('PAY-120')).toHaveAttribute('data-depth', '0');
    expect(lane('PAY-160')).toHaveAttribute('data-depth', '1');
    expect(cellSummaries('PAY-120', 'done')).toEqual(['Summary of PAY-170']);
    expect(cellSummaries('PAY-160', 'todo')).toEqual(['Ledger rounding fix']);
    for (const i of GROUP) expect(screen.getAllByText(i.key)).toHaveLength(1);
  });

  // Case 20: depth is the model's, the indent is capped at LANE_INDENT_CAP (3) — an attribute, because the CSP allows no inline style.
  it('a six-deep chain draws every issue once, with depths 0, 1, 2, 3, 3, 3', async () => {
    const chain = Array.from({ length: 7 }, (_, i) =>
      issue({
        key: `PAY-${i + 1}`,
        summary: `Chain ${i + 1}`,
        parent: i === 0 ? null : { key: `PAY-${i}`, summary: `Chain ${i}`, type: null, status: null },
        updated: daysAgoStamp(i + 1)
      })
    );
    lists[ALPHA.id] = chain;
    renderPage();
    await screen.findByText('Chain 7');
    expect(laneKeys()).toEqual(['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5', 'PAY-6']);
    expect(laneKeys().map((k) => lane(k)?.getAttribute('data-depth'))).toEqual(['0', '1', '2', '3', '3', '3']);
    for (const i of chain) expect(screen.getAllByText(i.summary)).toHaveLength(1);
    expect(cellSummaries('PAY-6', 'todo')).toEqual(['Chain 7']);
  });

  // Review Focus 1: a cached list with a cycle renders, terminates and draws each member once.
  it('draws a two-cycle with each member once, and settles', async () => {
    lists[ALPHA.id] = [
      issue({ key: 'PAY-1', summary: 'Cycle one', parent: { key: 'PAY-2', summary: 'Cycle two', type: null, status: null } }),
      issue({ key: 'PAY-2', summary: 'Cycle two', parent: { key: 'PAY-1', summary: 'Cycle one', type: null, status: null } })
    ];
    renderPage();
    await screen.findByText('Cycle one');
    expect(screen.getAllByText('Cycle one')).toHaveLength(1);
    expect(screen.getAllByText('Cycle two')).toHaveLength(1);
  });

  // Spec §6, "Where the board's list comes from": opening an issue hands the modal the lanes' `childrenOf`, so its tree can reach the grandchildren.
  it('a header’s title opens its issue with the lanes’ childrenOf', async () => {
    await renderGroup();
    await userEvent.click(within(headOf('PAY-120')).getByRole('button', { name: 'Payments epic' }));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    const [opened, index] = onOpenIssue.mock.calls[0] as [JiraIssue, ReadonlyMap<string, readonly JiraIssue[]>];
    expect(opened).toBe(G_120);
    expect(index.get('PAY-120')?.map((i) => i.key).sort()).toEqual(['PAY-160', 'PAY-170']);
    expect(index.get('PAY-160')?.map((i) => i.key).sort()).toEqual(['PAY-161', 'PAY-162']);
  });
});

describe('the lane card', () => {
  it('draws the key, summary, person, raw status and priority — and no crumb under a parent, though PAY-131 is mine', async () => {
    await renderAlpha();
    const c = card('Refund partial captures');
    expect(within(c).getByText('PAY-131')).toBeInTheDocument();
    expect(within(c).getByText('AL')).toBeInTheDocument();
    expect(within(c).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(c).getByText('In Review')).toBeInTheDocument();
    expect(within(c).getByText('High')).toBeInTheDocument();
    expect(within(c).getByTitle('Story')).toBeInTheDocument();
    expect(c.querySelector('.jira-card-crumb')).toBeNull();
    expect(c.querySelector('.ui-fold')).toBeNull();
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
      if (tone === null) {
        expect(card('Pill case').querySelector('[title^="priority "]')).toBeNull();
        // No pill, no slot: an empty slot would be the head's last child, and the key would not move anyway — but nothing stands in for a priority.
        expect(card('Pill case').querySelector('.jira-card-prio-slot')).toBeNull();
      } else {
        expect(pill).toHaveClass('ui-prio');
        expect(pill).toHaveAttribute('data-tone', tone);
        expect(pill?.querySelector('svg') !== null).toBe(glyph);
        // The page lays the primitive out through its own span (guard 7), which is what the push right hangs on.
        expect(pill?.parentElement).toHaveClass('jira-card-prio-slot');
      }
      cleanup();
    }
    // The push right is the slot's alone: no structural selector reaches past it into the head's last child, so a card with no priority keeps its key left.
    const css = readStyles();
    expect(ruleBlock(css, '.jira-card-prio-slot') as string).toMatch(/margin-left:\s*auto/);
    expect(css).not.toMatch(/\.jira-card-head\s*>\s*:last-child/);
    expect(css).not.toMatch(/\.jira-lane-tally\s*>\s*:first-child/);
    expect(ruleBlock(css, '.jira-lane-bar') as string).toMatch(/width:\s*96px/);
  });

  it('the status is the raw name beside a tone dot, and the type tile carries a tone per type', async () => {
    await renderAlpha();
    const c = card('Refund partial captures');
    expect(within(c).getByText('In Review')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/in progress/);
    expect(c.querySelector('.ui-issue-status-dot')).toHaveAttribute('data-tone', 'doing');
    expect(within(c).getByTitle('Story')).toHaveAttribute('data-tone', 'story');
    expect(within(card('Currency symbol missing on receipts')).getByTitle('Bug')).toHaveAttribute('data-tone', 'bug');
    expect(within(card('Refund flows')).getByTitle('Epic')).toHaveAttribute('data-tone', 'neutral');
  });

  it('the marker row names the one mapped repository by basename with a 14 px glyph, `N repos` for several with every path in the title, nothing for none', async () => {
    statusAnswer = status({ repos: { PAY: ['/x/microservice'] } });
    await renderAlpha();
    expect(within(card('Refund flows')).getByText('microservice')).toBeInTheDocument();
    expect(card('Refund flows').querySelector('.ui-repo svg')).toHaveAttribute('width', '14');
    cleanup();
    statusAnswer = status({ repos: { PAY: ['/x/microservice', '/y/other'] } });
    await renderAlpha();
    const many = within(card('Refund flows')).getByText('2 repos').closest('.ui-repo') as HTMLElement;
    expect(many.getAttribute('title')).toBe('/x/microservice\n/y/other');
    cleanup();
    statusAnswer = status();
    await renderAlpha();
    expect(card('Refund flows').querySelector('.ui-repo')).toBeNull();
  });

  // §3.4: the crumb never names the parent — the lane says it — but the precedence is unchanged, so a followed root still reads `root`.
  it('reads `root` for a root, `Assigned to me` for my own parentless card, and `unassigned`', async () => {
    await renderAlpha();
    expect(within(card('Refund flows')).getByText('root')).toBeInTheDocument();
    expect(within(card('Refund flows')).getByText('unassigned')).toBeInTheDocument();
    expect(within(card('Rounding wrong on invoices over 1,000')).getByText('Assigned to me')).toBeInTheDocument();
  });

  it('a followed root under an on-board parent still reads `root`, and the card carries no parent chip', async () => {
    lists[ALPHA.id] = [
      issue({ key: 'PAY-110', summary: 'Platform epic', type: { name: 'Epic', level: 1, subtask: false } }),
      issue({ key: 'PAY-120', summary: 'Followed root', assignee: ADA, parent: { key: 'PAY-110', summary: 'Platform epic', type: null, status: null } })
    ];
    renderPage();
    await screen.findByText('Followed root');
    expect(within(card('Followed root')).getByText('root')).toBeInTheDocument();
    expect(card('Followed root').querySelector('.ui-fold')).toBeNull();
    expect(cellSummaries('PAY-110', 'todo')).toEqual(['Followed root']);
  });

  // Grouped-board spec §4: no `N subtasks` marker. PAY-131 and PAY-120 both carry a non-zero `subtasks`, so this is not vacuous.
  it('draws no subtask count anywhere', async () => {
    await renderAlpha();
    expect(document.querySelector('.jira-lanes')?.textContent).not.toMatch(/subtask/);
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
    expect(JSON.parse(localStorage.getItem(JIRA_FILTERS_KEY) ?? 'null')).toEqual({ assignee: 'me', statuses: ['Backlog'], delivery: 'all' });
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

// The section's pages are switched by the rail's tree alone (spec §6.1, `.claude/rules/board.md` "The Jira section's four pages are switched by the rail's
// tree…"): the real Board page, drawn through the real `JiraView` inside a `main`, holds no control that restates that choice.
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

// Parent-lanes spec §3.2–§3.4: what an on-board and an off-board lane header draw, over the lane fixtures declared near the top of this file.
describe('the lane headers', () => {
  const stubbed = (over: Partial<JiraIssue['parent'] & object>): JiraIssue =>
    issue({ ...G_190, parent: { key: 'PAY-999', summary: 'Billing platform', type: null, status: null, ...over } });

  it('an off-board header: key, the stub’s summary, `not on this board`, the count, a link composed from the site — and no Run ▾, tile or pill Jira did not send', async () => {
    await renderGroup();
    const h = headOf('PAY-999');
    expect(h).toHaveAttribute('data-kind', 'off');
    expect(within(h).getByText('PAY-999')).toBeInTheDocument();
    expect(within(h).getByRole('button', { name: 'Billing platform' })).toBeEnabled();
    expect(within(h).getByText('not on this board')).toBeInTheDocument();
    expect(within(h).getByText('1 issue')).toBeInTheDocument();
    expect(within(h).queryByRole('button', { name: /^Run / })).toBeNull();
    expect(h.querySelector('.ui-issue-type')).toBeNull();
    expect(h.querySelector('.ui-issue-status')).toBeNull();
    expect(h.querySelector('.ui-prio')).toBeNull();
    expect(h.querySelector('.ui-person')).toBeNull();
    expect(within(h).getByRole('link', { name: /open PAY-999 in Jira/ })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/PAY-999');
  });

  it('an off-board header draws the type tile and the status pill when the stub carries them', async () => {
    lists[ALPHA.id] = [stubbed({ type: { name: 'Epic', level: 1, subtask: false }, status: { name: 'In Progress', category: 'indeterminate' } })];
    renderPage();
    await screen.findByText('Payout retries');
    const h = headOf('PAY-999');
    expect(within(h).getByTitle('Epic')).toHaveClass('ui-issue-type');
    expect(within(h).getByText('In Progress').closest('.ui-issue-status')).not.toBeNull();
  });

  it('an off-board header has no link out while the site is unknown', async () => {
    statusAnswer = status({ site: '' });
    await renderGroup();
    expect(within(headOf('PAY-999')).queryByRole('link')).toBeNull();
  });

  // Case 9: Jira sent the parent's key and no summary — the title reads the key, and it still reads the parent.
  it('an empty stub summary draws the key as the title, and the click still reads the parent', async () => {
    lists[ALPHA.id] = [stubbed({ summary: '' })];
    const parent = issue({ key: 'PAY-999', summary: 'Billing platform' });
    answerReads({ 'PAY-999': () => ok(detailOf(parent)) });
    renderPage();
    await screen.findByText('Payout retries');
    await userEvent.click(within(headOf('PAY-999')).getByRole('button', { name: 'PAY-999' }));
    await waitFor(() => expect(onOpenIssue).toHaveBeenCalledTimes(1));
    expect((onOpenIssue.mock.calls[0] as [JiraIssue])[0].key).toBe('PAY-999');
  });

  it('an on-board header: the issue’s row with Run ▾, and no parent chip without a parent', async () => {
    statusAnswer = status({ repos: { PAY: ['/x/pay'] } });
    await renderGroup();
    const h = headOf('PAY-120');
    expect(h).toHaveAttribute('data-kind', 'board');
    expect(within(h).getByRole('button', { name: /^Run PAY-120/ })).toBeEnabled();
    expect(within(h).getByTitle('Epic')).toHaveClass('ui-issue-type');
    expect(within(h).getByText('root')).toBeInTheDocument();
    expect(within(h).queryByText('not on this board')).toBeNull();
    expect(h.querySelector('.ui-fold')).toBeNull();
    expect(within(h).getByText('pay')).toBeInTheDocument();
  });

  it('a nested header names its parent as `↳ <key>`, the parent’s summary in its title', async () => {
    await renderGroup();
    const fold = headOf('PAY-160').querySelector('.ui-fold');
    expect(fold).toHaveTextContent('↳ PAY-120');
    expect(fold).toHaveAttribute('title', 'Payments epic');
    expect(headOf('PAY-160').querySelector('.jira-card-crumb')).toBeNull();
  });

  // Case 18: the parent arrives on the board — the header becomes the issue's own row; the fold the reader set on the stub still holds.
  it('a sweep that brings the off-board parent onto the board turns its header into an on-board one, and the stored fold still applies', async () => {
    const OFF = { ...ALPHA, interval: 'off' as const };
    statusAnswer = status({ boards: [OFF, BETA], repos: { PAY: ['/x/pay'] } });
    await renderGroup();
    await userEvent.click(within(headOf('PAY-999')).getByRole('button', { name: 'Collapse PAY-999' }));
    expect(screen.queryByText('Payout retries')).toBeNull();
    statusAnswer = status({ boards: [{ ...OFF, polledAt: new Date().toISOString() }, BETA], repos: { PAY: ['/x/pay'] } });
    lists = { ...lists, [ALPHA.id]: [...GROUP, issue({ key: 'PAY-999', summary: 'Billing platform', type: { name: 'Epic', level: 1, subtask: false } })] };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(headOf('PAY-999')).toHaveAttribute('data-kind', 'board'));
    const h = headOf('PAY-999');
    expect(within(h).getByRole('button', { name: /^Run PAY-999/ })).toBeInTheDocument();
    expect(within(h).queryByText('not on this board')).toBeNull();
    expect(within(h).getByRole('button', { name: 'Expand PAY-999' })).toBeInTheDocument();
    expect(screen.queryByText('Payout retries')).toBeNull();
  });
});

/*
  An off-board parent is read on a click, never on draw (§3.2): one `GET /api/jira/issue/<KEY>`, the summary disabled while it is out, Detail on the answer.
  The newest click across every header is the only one that may open Detail, and a failure's sentence sits under its own header alone.
*/
describe('reading an off-board parent', () => {
  const second = issue({ key: 'PAY-191', summary: 'Ledger export', parent: { key: 'PAY-998', summary: 'Ledger platform', type: null, status: null } });
  const billing = issue({ key: 'PAY-999', summary: 'Billing platform' });
  const ledger = issue({ key: 'PAY-998', summary: 'Ledger platform' });

  it('requests nothing on draw; a click asks once, disables the summary while it is out, and opens the answer', async () => {
    const read = deferred<Response>();
    answerReads({ 'PAY-999': () => read.promise });
    await renderGroup();
    expect(issueReads()).toEqual([]);
    const title = within(headOf('PAY-999')).getByRole('button', { name: 'Billing platform' });
    await userEvent.click(title);
    expect(issueReads()).toEqual(['/api/jira/issue/PAY-999']);
    expect(title).toBeDisabled();
    expect(onOpenIssue).not.toHaveBeenCalled();
    await act(async () => read.resolve(await ok(detailOf(billing))));
    await waitFor(() => expect(onOpenIssue).toHaveBeenCalledTimes(1));
    expect((onOpenIssue.mock.calls[0] as [JiraIssue])[0].key).toBe('PAY-999');
    expect(title).toBeEnabled();
  });

  it('two clicks, the first answered last: Detail opens once, on the second', async () => {
    const first = deferred<Response>();
    const later = deferred<Response>();
    answerReads({ 'PAY-999': () => first.promise, 'PAY-998': () => later.promise });
    lists[ALPHA.id] = [...GROUP, second];
    renderPage();
    await screen.findByText('Ledger export');
    await userEvent.click(within(headOf('PAY-999')).getByRole('button', { name: 'Billing platform' }));
    await userEvent.click(within(headOf('PAY-998')).getByRole('button', { name: 'Ledger platform' }));
    await act(async () => later.resolve(await ok(detailOf(ledger))));
    await act(async () => first.resolve(await ok(detailOf(billing))));
    await waitFor(() => expect(onOpenIssue).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    expect((onOpenIssue.mock.calls[0] as [JiraIssue])[0].key).toBe('PAY-998');
  });

  it('a failed read says so under that header only, and the next click clears it', async () => {
    let fail = true;
    answerReads({ 'PAY-998': () => (fail ? Promise.reject(new Error('Jira timed out')) : ok(detailOf(ledger))) });
    lists[ALPHA.id] = [...GROUP, second];
    renderPage();
    await screen.findByText('Ledger export');
    await userEvent.click(within(headOf('PAY-998')).getByRole('button', { name: 'Ledger platform' }));
    expect(await within(headOf('PAY-998')).findByRole('alert')).toHaveTextContent('Jira timed out');
    expect(within(headOf('PAY-999')).queryByRole('alert')).toBeNull();
    expect(onOpenIssue).not.toHaveBeenCalled();
    fail = false;
    await userEvent.click(within(headOf('PAY-998')).getByRole('button', { name: 'Ledger platform' }));
    await waitFor(() => expect(onOpenIssue).toHaveBeenCalledTimes(1));
    expect(within(headOf('PAY-998')).queryByRole('alert')).toBeNull();
  });

  it('a failed read is cleared by the next click on a DIFFERENT off-board header', async () => {
    answerReads({ 'PAY-998': () => Promise.reject(new Error('Jira timed out')), 'PAY-999': () => ok(detailOf(billing)) });
    lists[ALPHA.id] = [...GROUP, second];
    renderPage();
    await screen.findByText('Ledger export');
    await userEvent.click(within(headOf('PAY-998')).getByRole('button', { name: 'Ledger platform' }));
    expect(await within(headOf('PAY-998')).findByRole('alert')).toHaveTextContent('Jira timed out');
    await userEvent.click(within(headOf('PAY-999')).getByRole('button', { name: 'Billing platform' }));
    await waitFor(() => expect(onOpenIssue).toHaveBeenCalledTimes(1));
    expect((onOpenIssue.mock.calls[0] as [JiraIssue])[0].key).toBe('PAY-999');
    expect(within(headOf('PAY-998')).queryByRole('alert')).toBeNull();
    expect(within(headOf('PAY-999')).queryByRole('alert')).toBeNull();
  });

  // Case 19: the lane leaves while its read is out — nothing throws, the lane is gone, and the late answer opens nothing.
  it('a sweep that drops the lane while its read is out: no error, the lane is gone, and the late answer opens nothing', async () => {
    const OFF = { ...ALPHA, interval: 'off' as const };
    const read = deferred<Response>();
    answerReads({ 'PAY-998': () => read.promise });
    statusAnswer = status({ boards: [OFF, BETA] });
    lists[ALPHA.id] = [...GROUP, second, ...Array.from({ length: 6 }, (_, i) => issue({ key: `PAY-${700 + i}`, summary: `Loose ${i}`, updated: daysAgoStamp(i + 2) }))];
    renderPage();
    await screen.findByText('Ledger export');
    await userEvent.click(within(screen.getByTestId('cell-none-todo')).getByRole('button', { name: '+ 2 more' }));
    await userEvent.click(within(headOf('PAY-998')).getByRole('button', { name: 'Ledger platform' }));
    statusAnswer = status({ boards: [{ ...OFF, polledAt: new Date().toISOString() }, BETA] });
    lists = { ...lists, [ALPHA.id]: GROUP };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(lane('PAY-998')).toBeNull());
    await act(async () => read.resolve(await ok(detailOf(ledger))));
    await new Promise((r) => setTimeout(r, 20));
    expect(onOpenIssue).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/*
  Folds (§3.6): a lane starts open unless everything it counts is done; a press is stored per board under JIRA_LANE_FOLDS_KEY and outlives a remount; a
  typed search opens every lane holding a match and locks the chevrons, writing nothing.
*/
describe('the lane folds', () => {
  const SETTLED = [
    issue({ key: 'PAY-200', summary: 'Shipped epic', type: { name: 'Epic', level: 1, subtask: false }, status: { name: 'Done', category: 'done' }, resolved: daysAgoStamp(2) }),
    issue({
      key: 'PAY-201',
      summary: 'Shipped story',
      status: { name: 'Done', category: 'done' },
      parent: { key: 'PAY-200', summary: 'Shipped epic', type: null, status: null },
      resolved: daysAgoStamp(2)
    })
  ];
  const stored = (): unknown => JSON.parse(localStorage.getItem(JIRA_LANE_FOLDS_KEY) ?? 'null');

  async function renderFolds(): Promise<void> {
    lists[ALPHA.id] = [...GROUP, ...SETTLED];
    renderPage();
    await screen.findByText('Standalone task');
  }

  it('an open lane reads `Collapse <KEY>`, a settled one starts folded with `Expand <KEY>` and no cells, and `No parent` names itself', async () => {
    await renderFolds();
    expect(screen.getByRole('button', { name: 'Collapse PAY-120' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Collapse No parent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand PAY-200' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('cell-PAY-200-done')).toBeNull();
    expect(screen.queryByText('Shipped story')).toBeNull();
    expect(headOf('PAY-200').querySelector('.jira-lane-count')).toHaveTextContent('1 issue');
  });

  // Case 15's page half: a folded lane draws no cells, but its cards still count in the column heads — the heads count the board, not what is unfolded.
  it('a folded settled lane still counts in the column heads', async () => {
    const parentOf = (key: string, summary: string) => ({ key, summary, type: null, status: null });
    lists[ALPHA.id] = [
      issue({ key: 'PAY-210', summary: 'Open epic', type: { name: 'Epic', level: 1, subtask: false } }),
      issue({ key: 'PAY-211', summary: 'Open story one', parent: parentOf('PAY-210', 'Open epic') }),
      issue({ key: 'PAY-212', summary: 'Open story two', parent: parentOf('PAY-210', 'Open epic') }),
      issue({
        key: 'PAY-220',
        summary: 'Closed epic',
        type: { name: 'Epic', level: 1, subtask: false },
        status: { name: 'Done', category: 'done' },
        resolved: daysAgoStamp(2)
      }),
      ...[1, 2, 3].map((n) =>
        issue({
          key: `PAY-22${n}`,
          summary: `Closed story ${n}`,
          status: { name: 'Done', category: 'done' },
          parent: parentOf('PAY-220', 'Closed epic'),
          resolved: daysAgoStamp(2)
        })
      )
    ];
    renderPage();
    await screen.findByText('Open story one');
    expect(screen.getByRole('button', { name: 'Expand PAY-220' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Closed story 1')).toBeNull();
    // A folded lane draws no tiles, so its Done cards are counted on its header only.
    expect(screen.queryByTestId('cell-PAY-220-done')).toBeNull();
  });

  it('folding a lane hides its cells and every lane under it', async () => {
    await renderFolds();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse PAY-120' }));
    expect(lane('PAY-160')).toBeNull();
    expect(screen.queryByTestId('cell-PAY-120-done')).toBeNull();
    expect(lane('PAY-120')).toHaveAttribute('data-open', 'false');
  });

  it('a toggle survives a remount; a second board gets its own defaults; both boards land in storage', async () => {
    lists[BETA.id] = SETTLED;
    await renderFolds();
    await userEvent.click(screen.getByRole('button', { name: 'Expand PAY-200' }));
    expect(screen.getByText('Shipped story')).toBeInTheDocument();
    cleanup();
    await renderFolds();
    expect(screen.getByRole('button', { name: 'Collapse PAY-200' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Pick a Jira board/ }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Boards' })).getByRole('button', { name: 'Beta board' }));
    const expand = await screen.findByRole('button', { name: 'Expand PAY-200' });
    await userEvent.click(expand);
    expect(Object.keys(stored() as object).sort()).toEqual([ALPHA.id, BETA.id].sort());
    // Beta's write leaves Alpha's entry as it was, not replaced with `{}`.
    expect((stored() as Record<string, unknown>)[ALPHA.id]).toEqual({ 'PAY-200': 'open' });
  });

  it('a search opens a folded lane holding a match and locks the chevrons; clearing it folds the lane again, and storage is untouched', async () => {
    await renderFolds();
    const before = localStorage.getItem(JIRA_LANE_FOLDS_KEY);
    const box = screen.getByRole('searchbox', { name: 'Search issues' });
    await userEvent.type(box, 'shipped story');
    expect(screen.getByText('Shipped story')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse PAY-200' })).toBeDisabled();
    await userEvent.clear(box);
    expect(screen.getByRole('button', { name: 'Expand PAY-200' })).toBeEnabled();
    expect(screen.queryByText('Shipped story')).toBeNull();
    expect(localStorage.getItem(JIRA_LANE_FOLDS_KEY)).toBe(before);
  });

  it('junk in storage reads as the defaults', async () => {
    for (const junk of [null, 'x', [], { [ALPHA.id]: { 'PAY-200': 'junk', 'PAY-120': 7 } }]) {
      localStorage.setItem(JIRA_LANE_FOLDS_KEY, JSON.stringify(junk));
      await renderFolds();
      expect(screen.getByRole('button', { name: 'Expand PAY-200' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Collapse PAY-120' })).toBeInTheDocument();
      cleanup();
    }
  });
});

/* Filters match per issue (§6.2): a card shows when it matches, a header when it or anything under it does, and a lane with nothing left is gone. */
describe('filters over lanes', () => {
  const THREE = ['Alpha card', 'Beta card', 'Gamma card'].map((summary, i) =>
    issue({ key: `PAY-${51 + i}`, summary, parent: { key: 'PAY-50', summary: 'Card platform', type: null, status: null }, updated: daysAgoStamp(i + 1) })
  );
  const search = async (text: string): Promise<void> => {
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), text);
  };

  async function renderFilters(): Promise<void> {
    lists[ALPHA.id] = [...GROUP, ...THREE];
    renderPage();
    await screen.findByText('Gamma card');
  }

  it('one matching card in a three-card lane: that card alone, `1 issue`, and every lane with no match is gone', async () => {
    await renderFilters();
    await search('gamma');
    expect(laneKeys()).toEqual(['PAY-50']);
    expect(cellSummaries('PAY-50', 'todo')).toEqual(['Gamma card']);
    expect(headOf('PAY-50').querySelector('.jira-lane-count')).toHaveTextContent('1 issue');
    expect(tileCounts('PAY-50')).toEqual(['1', '0', '0']);
  });

  it('a header that matches on its own draws with empty cells and no count or bar', async () => {
    await renderFilters();
    await search('payments epic');
    expect(laneKeys()).toEqual(['PAY-120']);
    expect(lane('PAY-120')?.querySelectorAll('.board-card')).toHaveLength(0);
    expect(headOf('PAY-120').querySelector('.jira-lane-tally')).toBeNull();
  });

  it('a nested header that matches draws its parent’s header above it', async () => {
    await renderFilters();
    await search('summary of pay-160');
    expect(laneKeys()).toEqual(['PAY-120', 'PAY-160']);
    expect(lane('PAY-120')?.querySelectorAll('.board-card')).toHaveLength(0);
  });

  it('the Type filter offers a type only nested cards carry, and picking it keeps their lanes', async () => {
    await renderFilters();
    const dialog = await openFilters();
    expect(within(within(dialog).getByRole('group', { name: 'Type' })).getByRole('button', { name: 'Sub-task' })).toBeInTheDocument();
    await pick('Type', 'Sub-task');
    expect(laneKeys()).toEqual(['PAY-120', 'PAY-160']);
    expect(visibleSummaries().sort()).toEqual(['Ledger rounding fix', 'Summary of PAY-161']);
  });

  it('the Filters panel’s `Showing` counts the matching issues of the loaded list', async () => {
    await renderFilters();
    await search('PAY-16');
    const dialog = await openFilters();
    expect(within(dialog).getByText(/^Showing 3 of 10/)).toBeInTheDocument();
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
    await screen.findAllByText(firstCard);
  }

  const runChip = (summary: string): HTMLElement => within(card(summary)).getByRole('button', { name: /^Run PAY-/ });
  /** The chevron half: the one that opens the menu. The left half starts the default action and never opens it. */
  const runMore = (summary: string): HTMLElement => within(card(summary)).getByRole('button', { name: /^Run options for PAY-/ });
  /** A live key's session is a deck card, found by the session's own key; its lane card stays in its cell (parent-lanes D7). */
  const deckCards = (key: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`.jira-deck-card[data-key="${key}"]`));
  const inCell = (summary: string): boolean => screen.queryAllByText(summary).some((n) => n.closest('.board-card') !== null);

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

  it('draws the chip on a card with no priority — the marker row is unconditional', async () => {
    await renderRun();
    expect(within(card('Refund flows')).getByTestId('marker-row')).toBeInTheDocument();
    expect(runChip('Refund flows')).toBeEnabled();
  });

  it('a live key draws a deck card — strip, key, crumb naming the repo basename, and the elapsed reading — and its card stays in its cell', async () => {
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
    expect(inCell('Refund partial captures')).toBe(true);
    expect(within(card('Refund partial captures')).getByRole('button', { name: /^Run PAY-131/ })).toBeInTheDocument();
    // Another card is not the one with a session.
    expect(card('Refund flows')).not.toHaveClass('ui-stripe');
    expect(within(card('Refund flows')).getByRole('button', { name: /^Run PAY-/ })).toBeEnabled();
  });

  it('a starting entry is a deck card reading `Starting…` with no buttons, and its card stays in its cell reading the same', async () => {
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
    expect(inCell('Refund partial captures')).toBe(true);
    expect(within(card('Refund partial captures')).getByTestId('session-line')).toHaveTextContent('Starting…');
  });

  // The deck card shows the session's OWN key and names the parent it hangs under; the parent is a lane header now, and the live issue is a card in its
  // cell, so the session shows in both places (parent-lanes D7).
  it('a live issue under an on-board parent is a deck card on its own key, naming the parent, and stays a card in the parent’s lane', async () => {
    const top = issue({ key: 'PAY-160', summary: 'Top story', type: { name: 'Story', level: 0, subtask: false } });
    const under = issue({ key: 'PAY-162', summary: 'Folded sub-task', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'PAY-160', summary: 'Top story', type: null, status: null } });
    lists[ALPHA.id] = [top, under];
    await renderRun({ live: { 'PAY-162': { sessionId: 's1', name: 'jira PAY-162', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } } }, 'Folded sub-task');
    const [deck] = await waitFor(() => {
      const found = deckCards('PAY-162');
      expect(found).toHaveLength(1);
      return found;
    });
    // The `↳ <key>` pill sits beside the key, not in the crumb's lead.
    expect(deck.querySelector('.ui-fold')).toHaveTextContent('↳ PAY-160');
    expect(deck.querySelector('.jira-card-crumb')).not.toHaveTextContent('↳');
    expect(deck.querySelector('.jira-card-crumb')).toHaveTextContent('pay');
    expect(within(screen.getByTestId('cell-PAY-160-todo')).getByText('Folded sub-task')).toBeInTheDocument();
    expect(headOf('PAY-160')).toHaveAttribute('data-kind', 'board');
  });

  // Parent-lanes spec §5: the mark names the issue's direct parent on the board or off it — the lane to look in — with the parent's summary as its title.
  it('a deck card on an issue with an off-board parent draws `↳ <parent>` titled with the parent’s summary', async () => {
    await renderRun({ live: { 'PAY-131': { sessionId: 's1', name: 'jira PAY-131', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } } });
    const [deck] = await waitFor(() => {
      const found = deckCards('PAY-131');
      expect(found).toHaveLength(1);
      return found;
    });
    const mark = deck.querySelector('.ui-fold');
    expect(mark).toHaveTextContent('↳ PAY-99');
    expect(mark).toHaveAttribute('title', 'Payments platform');
  });

  it('a deck card on a parentless issue draws no mark', async () => {
    await renderRun({ live: { 'PAY-151': { sessionId: 's1', name: 'jira PAY-151', startedAt: threeHoursAgo(), repo: '/Users/ada/pay', starting: false } } });
    const [deck] = await waitFor(() => {
      const found = deckCards('PAY-151');
      expect(found).toHaveLength(1);
      return found;
    });
    expect(deck.querySelector('.ui-fold')).toBeNull();
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
    expect(screen.queryByRole('dialog', { name: 'Refund partial captures' })).not.toBeInTheDocument();
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
    const modal = await screen.findByRole('dialog', { name: 'Refund partial captures' });
    // The session cards are the Agent tab's since Jira detail tabs (spec §5); the dialog opens on Ticket.
    await userEvent.click(within(modal).getByRole('tab', { name: /^Agent/ }));
    await userEvent.click(await within(modal).findByRole('button', { name: 'More for PAY-131' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Session actions' })).getByRole('button', { name: 'Stop session' }));
    const statusBefore = statusReads();
    const boardBefore = boardRequests().length;
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));

    await waitFor(() => expect(requested).toContain('POST /api/agents/jira-stop'));
    await waitFor(() => expect(statusReads()).toBe(statusBefore + 1));
    await waitFor(() => expect(boardRequests().length).toBe(boardBefore + 1));
    await waitFor(() => expect(deckCards('PAY-131')).toHaveLength(0));
    expect(inCell('Refund partial captures')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(statusReads()).toBe(statusBefore + 1);
    expect(boardRequests().length).toBe(boardBefore + 1);
  });

  // DESIGN.md §8.9.2, Head: a Children-row click pushes onto `JiraView`'s walk, and the head's `← <key>` pops one step — through the real page, because
  // the walk lives one level above the modal and `jira-detail`'s cases hand the modal a mock `onBack`.
  it('a Children row walks down, Back climbs one step at a time, and a fresh card click starts a new walk', async () => {
    await renderRun();
    const refund = (lists[ALPHA.id] ?? []).find((i) => i.key === 'PAY-131') as JiraIssue;
    const child = { ...refund, key: 'PAY-200', summary: 'Child story', parent: { key: 'PAY-131', summary: refund.summary, type: null, status: null } };
    const grandchild = { ...refund, key: 'PAY-201', summary: 'Grandchild task', parent: { key: 'PAY-200', summary: 'Child story', type: null, status: null } };
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
    await screen.findByRole('dialog', { name: 'Refund partial captures' });
    expect(back()).toBeNull();
    // The Children rows are the Children & comments tab's since Jira detail tabs; the tab then stays selected for the whole walk (§9 case 16).
    await userEvent.click(within(dialog()).getByRole('tab', { name: /^Children/ }));

    await userEvent.click(await within(dialog()).findByRole('button', { name: /PAY-200 Child story/ }));
    await screen.findByRole('dialog', { name: 'Child story' });
    expect(back()).toHaveAccessibleName('Back to PAY-131');
    await userEvent.click(await within(dialog()).findByRole('button', { name: /PAY-201 Grandchild task/ }));
    await screen.findByRole('dialog', { name: 'Grandchild task' });
    expect(back()).toHaveAccessibleName('Back to PAY-200');

    await userEvent.click(back() as HTMLElement);
    await screen.findByRole('dialog', { name: 'Child story' });
    expect(back()).toHaveAccessibleName('Back to PAY-131');
    await userEvent.click(back() as HTMLElement);
    await screen.findByRole('dialog', { name: 'Refund partial captures' });
    expect(back()).toBeNull();

    // Down one, close, and open the card again: the walk is the reading's, so the reopened dialog has nowhere to go back to.
    await userEvent.click(await within(dialog()).findByRole('button', { name: /PAY-200 Child story/ }));
    await screen.findByRole('dialog', { name: 'Child story' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(card('Refund partial captures'));
    await screen.findByRole('dialog', { name: 'Refund partial captures' });
    expect(back()).toBeNull();
  });

  it('the chip stops the card: a click or Enter on it opens no modal', async () => {
    await renderRun();
    const chip = runMore('Refund partial captures');
    await userEvent.click(chip);
    expect(screen.queryByRole('dialog', { name: 'Refund partial captures' })).not.toBeInTheDocument();
    await userEvent.click(chip);
    chip.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Refund partial captures' })).not.toBeInTheDocument();
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
  const chipOf = (summary: string): HTMLElement | null => card(summary).querySelector<HTMLElement>('.ui-tree');
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
    await screen.findAllByText('Refund partial captures');
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
    expect(document.querySelectorAll('.ui-tree')).toHaveLength(0);
    expect(screen.queryByText('git down')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/*
  The Board as an agent deck over status shelves (Jira sessions, Task 11; spec §7.1, C1, C8; DESIGN.md §8.9.1). Rendered through `JiraView`, which carries the
  section's one sessions provider the deck reads. Sessions are links handed to the sessions answer with a state of their own; a `starting` one is not a link at
  all but a status `live` reservation (it has no session id yet), as the server hands it out.
*/
describe('the agent deck and the lane cells', () => {
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
    await screen.findAllByText(firstText);
  }

  const deckStates = (): string[] =>
    Array.from(document.querySelectorAll('.jira-deck-card')).map((c) => `${c.getAttribute('data-key')}:${c.getAttribute('data-state')}`);
  const cellRows = (laneKey: string, slug: 'todo' | 'doing' | 'done'): number => screen.getByTestId(`cell-${laneKey}-${slug}`).querySelectorAll('.board-card').length;
  const cellMore = (laneKey: string, slug: 'todo' | 'doing' | 'done'): HTMLElement | null =>
    screen.getByTestId(`cell-${laneKey}-${slug}`).querySelector<HTMLElement>('.jira-lane-more button');
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

  // Case 4: a cell cuts at five; `+ N more` opens that cell alone, and reads `show fewer` while it is open. Two lanes each hold a 7-card To Do cell, so
  // "alone" is pinned against the same column of another lane — an open-cell set keyed by the column only would open both — and against another column
  // of the same lane.
  it('a cell of 7 shows 5 and `+ 2 more`; the click opens only that cell', async () => {
    const epic = issue({ key: 'PAY-500', summary: 'Checkout epic', type: { name: 'Epic', level: 1, subtask: false } });
    const under = Array.from({ length: 7 }, (_, i) =>
      issue({
        key: `PAY-${510 + i}`,
        summary: `Epic todo ${i}`,
        updated: daysAgoStamp(i + 1),
        parent: { key: 'PAY-500', summary: 'Checkout epic', type: null, status: null }
      })
    );
    lists[ALPHA.id] = [...todos(7), ...dones(6), epic, ...under];
    await renderDeck('Todo 0');
    expect(cellRows('none', 'todo')).toBe(5);
    expect(cellRows('none', 'done')).toBe(5);
    expect(cellRows('PAY-500', 'todo')).toBe(5);
    const more = cellMore('none', 'todo') as HTMLElement;
    expect(more).toHaveTextContent('+ 2 more');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    // A tile counts its lane's matching cards before the cut, so `+ 2 more` and the count agree; the epic is a header and counts nothing.
    expect(screen.getByTestId('cell-none-todo').querySelector('.jira-cell-count')).toHaveTextContent('7');
    expect(screen.getByTestId('cell-PAY-500-todo').querySelector('.jira-cell-count')).toHaveTextContent('7');
    await userEvent.click(more);
    expect(cellRows('none', 'todo')).toBe(7);
    expect(cellMore('none', 'todo')).toHaveTextContent('show fewer');
    expect(cellMore('none', 'todo')).toHaveAttribute('aria-expanded', 'true');
    // The other lane's cell in the SAME column stays cut.
    expect(cellRows('PAY-500', 'todo')).toBe(5);
    expect(cellMore('PAY-500', 'todo')).toHaveTextContent('+ 2 more');
    expect(cellMore('PAY-500', 'todo')).toHaveAttribute('aria-expanded', 'false');
    // And another column of the same lane does too.
    expect(cellRows('none', 'done')).toBe(5);
    expect(cellMore('none', 'done')).toHaveTextContent('+ 1 more');
    await userEvent.click(cellMore('none', 'todo') as HTMLElement);
    expect(cellRows('none', 'todo')).toBe(5);
  });

  // The `+ N more` state is the lane board's own and keyed `<lane>:<column>`, so a parent key that is a lane on two boards would carry an opened cell across a
  // board switch without the `key={board.id}` on `JiraLaneBoard`.
  it('a cell opened on one board is cut again after switching to a board with the same parent', async () => {
    const parent = { key: 'PAY-500', summary: 'Checkout epic', type: null, status: null };
    const epic = issue({ key: 'PAY-500', summary: 'Checkout epic', type: { name: 'Epic', level: 1, subtask: false } });
    const under = (from: number): JiraIssue[] =>
      Array.from({ length: 7 }, (_, i) => issue({ key: `PAY-${from + i}`, summary: `Epic todo ${from + i}`, updated: daysAgoStamp(i + 1), parent }));
    lists[ALPHA.id] = [epic, ...under(510)];
    lists[BETA.id] = [epic, ...under(610)];
    await renderDeck('Epic todo 510');
    await userEvent.click(cellMore('PAY-500', 'todo') as HTMLElement);
    expect(cellRows('PAY-500', 'todo')).toBe(7);
    await userEvent.click(screen.getByRole('button', { name: 'Pick a Jira board: Alpha board' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Boards' })).getByRole('button', { name: 'Beta board' }));
    await screen.findAllByText('Epic todo 610');
    expect(cellRows('PAY-500', 'todo')).toBe(5);
    expect(cellMore('PAY-500', 'todo')).toHaveTextContent('+ 2 more');
  });

  // Case 6: a live card past the cut is never hidden — the cut keeps it, in its place, and hides one fewer.
  it('7 cards with the 7th live: 6 shown and `+ 1 more`', async () => {
    lists[ALPHA.id] = todos(7);
    sessionsAnswer = () => ({ links: [linkOn('PAY-306', 's306', 'working', 1)], reachable: true, rowsAt: null });
    await renderDeck('Todo 0');
    await waitFor(() => expect(cellRows('none', 'todo')).toBe(6));
    expect(cellMore('none', 'todo')).toHaveTextContent('+ 1 more');
    expect(cellSummaries('none', 'todo')).toEqual(['Todo 0', 'Todo 1', 'Todo 2', 'Todo 3', 'Todo 4', 'Todo 6']);
  });

  // Case 5 (D7): a live card stays in its cell, as a stripe with the deck card's words and the open control, Run ▾ still on it, and the deck has it too.
  it('a live card stays in its cell with the state line, the open control and Run ▾, and the deck shows it as well', async () => {
    statusAnswer = status({ repos: { PAY: ['/Users/ada/pay'] } });
    sessionsAnswer = () => ({ links: [linkOn('PAY-131', 's131', 'working', 3)], reachable: true, rowsAt: null });
    await renderDeck('Refund partial captures');
    await waitFor(() => expect(deckStates()).toEqual(['PAY-131:working']));
    const c = within(screen.getByTestId('cell-PAY-99-doing')).getByText('Refund partial captures').closest('.board-card') as HTMLElement;
    await waitFor(() => expect(c).toHaveClass('ui-stripe'));
    expect(c).toHaveAttribute('data-tone', 'green');
    expect(within(c).getByTestId('session-line')).toHaveTextContent('Working · 3h');
    expect(c.querySelector('.jira-card-open')).not.toBeNull();
    expect(within(c).getByRole('button', { name: /^Run PAY-131/ })).toBeInTheDocument();
    expect(card('Refund flows')).not.toHaveClass('ui-stripe');
    expect(within(card('Refund flows')).queryByTestId('session-line')).toBeNull();
  });

  // Case 14: the deck and the lanes answer ONE filter, per issue — a session stays while its own ticket matches, not while only its parent does.
  it('the deck keeps a session whose own issue matches, and drops it when only its parent does', async () => {
    const epic = issue({ key: 'PAY-120', summary: 'Payments epic', type: { name: 'Epic', level: 1, subtask: false } });
    const sub = issue({ key: 'PAY-162', summary: 'Ledger rounding fix', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'PAY-120', summary: 'Payments epic', type: null, status: null } });
    lists[ALPHA.id] = [epic, sub];
    sessionsAnswer = () => ({ links: [linkOn('PAY-162', 's162', 'working', 2)], reachable: true, rowsAt: null });
    await renderDeck('Payments epic');
    await waitFor(() => expect(deckStates()).toEqual(['PAY-162:working']));
    const box = screen.getByRole('searchbox', { name: 'Search issues' });
    await userEvent.type(box, 'ledger');
    expect(deckStates()).toEqual(['PAY-162:working']);
    await userEvent.clear(box);
    await userEvent.type(box, 'payments');
    expect(deckStates()).toEqual([]);
    expect(laneKeys()).toEqual(['PAY-120']);
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

  describe('the lane card’s extra line', () => {
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
  The issue List draws the Board's lanes as rows (parent-lanes spec §4; mocks `List.dc.html`, `ListDeep.dc.html`): a header row per lane on a tinted ground,
  the lane's cards under it in `sortForBoard` order across every status, then its nested lanes — the same lanes, the same order and the same folds as the
  Board. NESTING is the lane model's own nesting shape (`jira-lib.test.ts`, case 5): epic PAY-40 holds the card PAY-44 and the nested story PAY-41, whose
  cards are PAY-42 (Done, touched today) and PAY-43 (To Do, a day old). PAY-190 hangs under PAY-999, which is not on the board and whose stub carries a type
  and a status of its own; PAY-180 has no parent. Every value a case asserts is distinct per issue.
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
  const DONE = { name: 'Done', category: 'done' as const };
  const under = (key: string, summary: string) => ({ key, summary, type: null, status: null });
  const N_40 = issue({ key: 'PAY-40', summary: 'Checkout epic', type: EPIC, status: DOING, updated: daysAgoStamp(9) });
  const N_41 = issue({
    key: 'PAY-41',
    summary: 'Address story',
    type: STORY,
    status: DOING,
    priority: 'High',
    assignee: GRACE,
    sprint: 'Sprint 43',
    parent: under('PAY-40', 'Checkout epic'),
    updated: daysAgoStamp(2)
  });
  const N_42 = issue({
    key: 'PAY-42',
    summary: 'Address validation',
    type: SUB,
    status: DONE,
    parent: under('PAY-41', 'Address story'),
    updated: daysAgoStamp(0.01),
    resolved: daysAgoStamp(0.01)
  });
  const N_43 = issue({ key: 'PAY-43', summary: 'Postcode lookup', type: SUB, assignee: ADA, sprint: 'Sprint 44', parent: under('PAY-41', 'Address story'), updated: daysAgoStamp(1) });
  const N_44 = issue({ key: 'PAY-44', summary: 'Checkout copy', parent: under('PAY-40', 'Checkout epic'), updated: daysAgoStamp(3) });
  const NESTING = [N_40, N_41, N_42, N_43, N_44];
  const N_190 = issue({
    key: 'PAY-190',
    summary: 'Payout retries',
    status: DOING,
    parent: { key: 'PAY-999', summary: 'Billing platform', type: EPIC, status: { name: 'In Review', category: 'indeterminate' } },
    updated: daysAgoStamp(4)
  });
  const N_180 = issue({ key: 'PAY-180', summary: 'Standalone task', updated: daysAgoStamp(5) });
  const ALL = [...NESTING, N_190, N_180];

  async function renderList(issues: JiraIssue[] = ALL): Promise<void> {
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
  afterEach(() => act(() => setJiraView('board')));

  /** Every row that stands for one issue — card rows and the on- and off-board header rows — in document order. */
  const rowKeys = (): string[] => Array.from(document.querySelectorAll('tr[data-key]')).map((r) => r.getAttribute('data-key') ?? '');
  const row = (key: string): HTMLTableRowElement => document.querySelector(`tr[data-key="${key}"]`) as HTMLTableRowElement;
  /** A lane's header row by its lane key (`none` for `No parent`). */
  const headRow = (laneKey: string): HTMLTableRowElement => document.querySelector(`tr[data-lane="${laneKey}"]`) as HTMLTableRowElement;
  const headers = (): string[] => screen.getAllByRole('columnheader').map((h) => h.textContent || h.getAttribute('aria-label') || '');
  /** `r`'s cell under the column named `name`, found by the head's own index so a cell is never read from the wrong column. */
  const cellOf = (r: HTMLTableRowElement, name: string): HTMLTableCellElement => r.cells[headers().indexOf(name)];
  const sessionCell = (key: string): string => row(key).querySelector('.jira-issues-session')?.textContent ?? '';
  const depthOf = (r: HTMLTableRowElement): string | null => r.querySelector('td.jira-issues-summary')?.getAttribute('data-depth') ?? null;

  it('draws the lanes in order: a header row, its cards in sortForBoard order across statuses, then its nested lane', async () => {
    await renderList(NESTING);
    // PAY-42 (Done, today) before PAY-43 (To Do, a day old): newest first, never split by status — the Status column says the status.
    expect(rowKeys()).toEqual(['PAY-40', 'PAY-44', 'PAY-41', 'PAY-42', 'PAY-43']);
    expect(headRow('PAY-40')).toBe(row('PAY-40'));
    expect(headRow('PAY-41')).toBe(row('PAY-41'));
    for (const key of ['PAY-40', 'PAY-41']) expect(row(key)).toHaveClass('jira-issues-lane');
    for (const key of ['PAY-42', 'PAY-43', 'PAY-44']) expect(row(key)).not.toHaveClass('jira-issues-lane');
  });

  it('lists every root lane — on-board, off-board, then `No parent` — with the issues each holds', async () => {
    await renderList();
    expect(rowKeys()).toEqual(['PAY-40', 'PAY-44', 'PAY-41', 'PAY-42', 'PAY-43', 'PAY-999', 'PAY-190', 'PAY-180']);
    expect(headRow('none')).not.toBeNull();
    expect(headRow('none').hasAttribute('data-key')).toBe(false);
  });

  it('draws today’s columns, Sprint and Assignee (disc and name) included', async () => {
    await renderList();
    expect(headers()).toEqual(['Type', 'Status', 'Key', 'Summary', 'Updated', 'Session', 'Assignee', 'Sprint', 'Priority', 'Run']);
    const r = row('PAY-43');
    expect(within(cellOf(r, 'Assignee')).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(cellOf(r, 'Assignee').querySelector('.jira-card-av')).toHaveTextContent('AL');
    expect(cellOf(r, 'Sprint')).toHaveTextContent('Sprint 44');
    expect(within(cellOf(row('PAY-44'), 'Assignee')).getByText('unassigned')).toBeInTheDocument();
    expect(cellOf(row('PAY-44'), 'Sprint')).toHaveTextContent('—');
  });

  it('an off-board header row: Key, Summary, Type and Status from the stub, the tag and the count, every other cell empty, and no colSpan', async () => {
    await renderList();
    const r = headRow('PAY-999');
    expect(r).toHaveAttribute('data-kind', 'off');
    expect(r.cells).toHaveLength(headers().length);
    expect(within(cellOf(r, 'Key')).getByRole('link', { name: /open PAY-999 in Jira/ })).toHaveTextContent('PAY-999');
    const summary = cellOf(r, 'Summary');
    expect(within(summary).getByRole('button', { name: 'Billing platform' })).toBeEnabled();
    expect(within(summary).getByText('not on this board')).toBeInTheDocument();
    expect(within(summary).getByText('1 issue')).toBeInTheDocument();
    expect(cellOf(r, 'Type')).toHaveTextContent('Epic');
    expect(cellOf(r, 'Status')).toHaveTextContent('In Review');
    for (const name of ['Session', 'Priority', 'Assignee', 'Sprint', 'Updated', 'Run']) {
      expect(cellOf(r, name).textContent).toBe('');
      expect(cellOf(r, name).childElementCount).toBe(0);
    }
    expect(document.querySelectorAll('td[colspan], th[colspan]')).toHaveLength(0);
  });

  it('the `No parent` header row: the label, a chevron and the count in Summary, and nothing anywhere else', async () => {
    await renderList();
    const r = headRow('none');
    expect(r).toHaveAttribute('data-kind', 'none');
    expect(r.cells).toHaveLength(headers().length);
    const summary = cellOf(r, 'Summary');
    expect(within(summary).getByText('No parent')).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Collapse No parent' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(summary).getByText('1 issue')).toBeInTheDocument();
    for (const name of headers().filter((h) => h !== 'Summary')) expect(cellOf(r, name).textContent).toBe('');
  });

  it('an on-board header row fills every cell with its own values, draws Run ▾, and names its parent as `↳ <KEY>`', async () => {
    await renderList();
    const r = headRow('PAY-41');
    expect(r).toHaveAttribute('data-kind', 'board');
    expect(cellOf(r, 'Session')).toHaveTextContent('—');
    expect(within(cellOf(r, 'Key')).getByRole('link', { name: /open PAY-41 in Jira/ })).toHaveAttribute('href', N_41.url);
    const summary = cellOf(r, 'Summary');
    expect(within(summary).getByRole('button', { name: 'Address story' })).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Collapse PAY-41' })).toBeInTheDocument();
    expect(summary.querySelector('.ui-fold')).toHaveTextContent('↳ PAY-40');
    expect(summary.querySelector('.ui-fold')).toHaveAttribute('title', 'Checkout epic');
    expect(cellOf(r, 'Type')).toHaveTextContent('Story');
    expect(cellOf(r, 'Status')).toHaveTextContent('In Progress');
    expect(cellOf(r, 'Priority')).toHaveTextContent('High');
    expect(cellOf(r, 'Assignee')).toHaveTextContent('Grace Hopper');
    expect(cellOf(r, 'Sprint')).toHaveTextContent('Sprint 43');
    expect(cellOf(r, 'Updated')).toHaveTextContent(elapsedSince(N_41.updated) as string);
    expect(within(cellOf(r, 'Run')).getAllByRole('button', { name: 'Run PAY-41' })).toHaveLength(1);
    // The root header has no parent, so no chip.
    expect(cellOf(headRow('PAY-40'), 'Summary').querySelector('.ui-fold')).toBeNull();
  });

  it('a row’s Session cell is its own key’s: a child’s session marks the child alone, no FoldMark anywhere, `+1` for a second live one', async () => {
    sessionsAnswer = () => ({
      links: [linkOn('PAY-42', 's1', 'working', 2.05), linkOn('PAY-44', 's2', 'working', 3), linkOn('PAY-44', 's3', 'answer', 1)],
      reachable: true,
      rowsAt: null
    });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-42')).toContain('Working · 2h'));
    expect(sessionCell('PAY-41')).toBe('—');
    expect(sessionCell('PAY-40')).toBe('—');
    // The deck leads PAY-44 with its `answer` session, and so does the row; the second live one is `+1`.
    expect(sessionCell('PAY-44')).toContain('Waiting on your answer');
    expect(row('PAY-44').querySelector('.jira-issues-more')).toHaveTextContent('+1');
    expect(row('PAY-42').querySelector('.jira-issues-more')).toBeNull();
    expect(document.querySelectorAll('.jira-issues-session .ui-fold')).toHaveLength(0);
  });

  it('reads `Ended · 2h` on the row whose own session ended, and nothing on its parent’s', async () => {
    sessionsAnswer = () => ({
      links: [{ ...linkOn('PAY-43', 'e', 'ended', 5), endedAt: hoursAgo(2.05) /* a margin: the row's `now` is read at mount, before this stamp is minted */, endReason: 'finished' }],
      reachable: true,
      rowsAt: null
    });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-43')).toContain('Ended · 2h'));
    expect(sessionCell('PAY-41')).toBe('—');
  });

  it('the Summary cell is a flex row (title ellipsises, count never cut) and the Session cell keeps its age out of the ellipsis (ui-verify D3, D4)', async () => {
    sessionsAnswer = () => ({ links: [linkOn('PAY-41', 's1', 'plan', 3)], reachable: true, rowsAt: null });
    await renderList();
    await waitFor(() => expect(sessionCell('PAY-41')).toContain('Waiting for plan approval'));
    const flex = cellOf(headRow('PAY-41'), 'Summary').querySelector('.jira-issues-flex') as HTMLElement;
    expect(flex.querySelector('.jira-issues-title')).not.toBeNull();
    expect(flex.querySelector('.jira-issues-under')?.textContent).toBe('2 issues');
    const session = row('PAY-41').querySelector('.jira-issues-session') as HTMLElement;
    expect(session.querySelector('.jira-issues-cut')?.textContent).toBe('Waiting for plan approval');
    expect(session.querySelector('.jira-issues-age')?.textContent).toMatch(/^ · \d/);
  });

  it('a row’s Updated is its own stamp: the header’s 9 days, not its newest card’s today', async () => {
    await renderList();
    expect(row('PAY-40').querySelector('.jira-issues-updated')?.textContent).toBe(elapsedSince(N_40.updated));
    expect(row('PAY-40').querySelector('.jira-issues-updated')?.textContent).toBe('9d');
    expect(row('PAY-42').querySelector('.jira-issues-updated')?.textContent).toBe(elapsedSince(N_42.updated));
  });

  it('every header row’s count is `.jira-issues-under`, reading `n issues` or `1 issue` over the lane’s subtree', async () => {
    await renderList();
    const count = (laneKey: string): Element | null => headRow(laneKey).querySelector('.jira-issues-under');
    expect(count('PAY-40')).toHaveTextContent('4 issues');
    expect(count('PAY-41')).toHaveTextContent('2 issues');
    expect(count('PAY-999')).toHaveTextContent('1 issue');
    expect(count('none')).toHaveTextContent('1 issue');
    expect(document.querySelectorAll('.jira-issues-under')).toHaveLength(4);
  });

  it('indents in the Summary cell: a nested header at depth 1, its cards at 2, and a depth-5 lane’s rows at LANE_INDENT_CAP', async () => {
    await renderList();
    // The Key cell never indents, so a parent's key and its children's keys start at one edge.
    expect(document.querySelectorAll('td.jira-issues-key[data-depth]')).toHaveLength(0);
    expect(depthOf(row('PAY-40'))).toBe('0');
    expect(depthOf(row('PAY-44'))).toBe('1');
    expect(depthOf(row('PAY-41'))).toBe('1');
    for (const key of ['PAY-42', 'PAY-43']) expect(depthOf(row(key))).toBe('2');
    cleanup();

    const chain = [issue({ key: 'PAY-80', summary: 'Chain 0' })];
    for (let n = 1; n <= 6; n++) chain.push(issue({ key: `PAY-8${n}`, summary: `Chain ${n}`, parent: under(`PAY-8${n - 1}`, `Chain ${n - 1}`) }));
    await renderList(chain);
    // PAY-85 is the depth-5 lane's header and PAY-86 its card: both sit at the cap, as do PAY-83 and PAY-84 above them.
    expect(['PAY-80', 'PAY-81', 'PAY-82', 'PAY-83', 'PAY-84', 'PAY-85', 'PAY-86'].map((k) => depthOf(row(k)))).toEqual(['0', '1', '2', '3', '3', '3', '3']);
    expect(depthOf(row('PAY-86'))).toBe(String(LANE_INDENT_CAP));
  });

  it('a lane folded from its List chevron is folded on the Board, and one opened on the Board is open in the List', async () => {
    await renderList();
    await userEvent.click(within(headRow('PAY-41')).getByRole('button', { name: 'Collapse PAY-41' }));
    expect(row('PAY-42')).toBeNull();
    expect(row('PAY-43')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(await screen.findByRole('button', { name: 'Expand PAY-41' })).toHaveAttribute('aria-expanded', 'false');
    expect(lane('PAY-41')).toHaveAttribute('data-open', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Expand PAY-41' }));
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    await screen.findByRole('table');
    expect(within(headRow('PAY-41')).getByRole('button', { name: 'Collapse PAY-41' })).toBeInTheDocument();
    expect(row('PAY-42')).not.toBeNull();
  });

  it('a settled off-board lane and a settled `No parent` lane start folded, and each opens from its own header row', async () => {
    const SETTLED = [
      issue({ key: 'PAY-195', summary: 'Ledger export', status: DONE, parent: under('PAY-998', 'Ledger platform'), updated: daysAgoStamp(6), resolved: daysAgoStamp(6) }),
      issue({ key: 'PAY-185', summary: 'Old cleanup', status: DONE, updated: daysAgoStamp(7), resolved: daysAgoStamp(7) })
    ];
    await renderList([...NESTING, ...SETTLED]);
    expect(row('PAY-195')).toBeNull();
    expect(row('PAY-185')).toBeNull();
    await userEvent.click(within(headRow('PAY-998')).getByRole('button', { name: 'Expand PAY-998' }));
    expect(row('PAY-195')).not.toBeNull();
    await userEvent.click(within(headRow('none')).getByRole('button', { name: 'Expand No parent' }));
    expect(row('PAY-185')).not.toBeNull();
  });

  it('an off-board header row’s summary reads the parent once and opens Detail; drawing it asked nothing', async () => {
    answerReads({ 'PAY-999': () => ok(detailOf(issue({ key: 'PAY-999', summary: 'Billing platform' }))) });
    await renderList();
    expect(issueReads()).toEqual([]);
    await userEvent.click(within(headRow('PAY-999')).getByRole('button', { name: 'Billing platform' }));
    await waitFor(() => expect(onOpenIssue).toHaveBeenCalledTimes(1));
    expect(issueReads()).toEqual(['/api/jira/issue/PAY-999']);
    expect((onOpenIssue.mock.calls[0] as [JiraIssue])[0].key).toBe('PAY-999');
    expect(within(cellOf(headRow('PAY-999'), 'Key')).getByRole('link')).toHaveAttribute('href', 'https://acme.atlassian.net/browse/PAY-999');
  });

  it('an off-board header row’s key is plain text while the site is unknown', async () => {
    statusAnswer = status({ site: '' });
    await renderList();
    const key = cellOf(headRow('PAY-999'), 'Key');
    expect(key).toHaveTextContent('PAY-999');
    expect(within(key).queryByRole('link')).toBeNull();
  });

  it('draws a priority pill per row, `Not prioritised` for null, a Run split per row, and the full summary as the cell title', async () => {
    await renderList([issue({ key: 'PAY-1', summary: 'A very long summary that the cell will cut', priority: 'High' }), issue({ key: 'PAY-2', summary: 'Plain', priority: null })]);
    expect(within(row('PAY-1')).getByTitle('priority High')).toHaveClass('jira-card-prio');
    expect(within(row('PAY-2')).getByText('Not prioritised')).toHaveAttribute('data-tone', 'low');
    for (const key of ['PAY-1', 'PAY-2']) expect(within(row(key)).getAllByRole('button', { name: `Run ${key}` })).toHaveLength(1);
    expect(row('PAY-1').querySelector('.jira-issues-summary')).toHaveAttribute('title', 'A very long summary that the cell will cut');
  });

  it('opens the modal with the lanes’ childrenOf on a row click — a header row’s as a card row’s — and not from the Jira link', async () => {
    await renderList();
    await userEvent.click(within(row('PAY-41')).getByRole('link', { name: /open PAY-41 in Jira/ }));
    expect(onOpenIssue).not.toHaveBeenCalled();
    // The Type cell is plain text: only the row's own handler can open the modal from it (the summary button has its own).
    await userEvent.click(within(cellOf(row('PAY-41'), 'Type')).getByText('Story'));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    const [opened, index] = onOpenIssue.mock.calls[0] as [JiraIssue, ReadonlyMap<string, readonly JiraIssue[]>];
    expect(opened.key).toBe('PAY-41');
    expect(index.get('PAY-41')?.map((i) => i.key).sort()).toEqual(['PAY-42', 'PAY-43']);
    await userEvent.click(within(cellOf(row('PAY-43'), 'Type')).getByText('Sub-task'));
    expect((onOpenIssue.mock.calls[1] as [JiraIssue])[0].key).toBe('PAY-43');
    // The chevron folds; it opens nothing.
    await userEvent.click(within(headRow('PAY-41')).getByRole('button', { name: 'Collapse PAY-41' }));
    expect(onOpenIssue).toHaveBeenCalledTimes(2);
  });

  it('a search keeps the matching issue and the headers above it, per issue', async () => {
    await renderList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search issues' }), 'address validation');
    expect(rowKeys()).toEqual(['PAY-40', 'PAY-41', 'PAY-42']);
  });

  it('the FilterBar filters per issue: assignee me leaves my card under its headers', async () => {
    await renderList();
    await pick('Assignee', 'me');
    expect(rowKeys()).toEqual(['PAY-40', 'PAY-41', 'PAY-43']);
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
    parent: { key: 'PAY-99', summary: 'Payments platform', type: null, status: null },
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

/*
  The Delivery quick filter (GitLab connection spec §7.4; mock `List.dc.html`): one stored value, drawn twice — a `Delivery` section in the Filters panel and a
  segmented control above the List. PAY-131 leads with an open MR whose pipeline failed, PAY-140 with a merged one (the same payload the band line reads).
*/
describe('the Delivery quick filter', () => {
  const MR = (over: Partial<GitlabMr>): GitlabMr => ({
    project: 'payments/api',
    iid: 415,
    title: 'PAY-131 | refund partial captures',
    webUrl: 'https://gitlab.example.test/payments/api/-/merge_requests/415',
    state: 'opened',
    draft: false,
    sourceBranch: 'pay-131-refunds',
    targetBranch: 'develop',
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    mergedAt: null,
    pipeline: 'failed',
    keys: ['PAY-131'],
    review: null,
    ...over
  });
  const payload = (state: 'connected' | 'unconfigured' = 'connected', mrs: GitlabMr[] = [MR({}), MR({ iid: 398, state: 'merged', pipeline: null, keys: ['PAY-140'], mergedAt: new Date(Date.now() - 86_400_000).toISOString() })]): GitlabPayload => ({
    status: {
      state,
      site: state === 'connected' ? 'gitlab.example.test' : null,
      malformedSite: false,
      user: state === 'connected' ? { username: 'ada', name: 'Ada' } : null,
      httpStatus: null,
      reason: null,
      armed: state === 'connected',
      retryAt: null,
      mappedRepos: 1,
      foundHosts: [],
      problems: [],
      interval: '1m'
    },
    jiraProjects: state === 'connected' ? { PAY: [{ path: 'payments/api', repo: 'api', polledAt: new Date(Date.now() - 120_000).toISOString(), capped: false, failed: false, repos: [] }] } : {},
    mrs: state === 'connected' ? mrs : []
  });

  function mount(data: GitlabPayload, view: 'board' | 'list'): void {
    setJiraView(view);
    setJiraPage('board');
    render(
      <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>
        <SettingsProvider>
          <JiraProvider>
            <JiraSessionsProvider open>
              <JiraBoardView onOpenJiraPage={jest.fn()} onOpenIssue={jest.fn()} onRun={jest.fn()} nudge={0} />
            </JiraSessionsProvider>
          </JiraProvider>
        </SettingsProvider>
      </GitlabContext.Provider>
    );
  }
  afterEach(() => act(() => setJiraView('board')));

  const seg = (): HTMLElement => screen.getByRole('group', { name: 'Delivery' });
  /** The card rows' summaries — a lane's header row is the lane's heading, not one of the rows the filter is about. */
  const rowSummaries = (): string[] =>
    Array.from(document.querySelectorAll('.jira-issues-table tbody tr.jira-issues-row:not(.jira-issues-lane)')).map((r) => r.querySelector('td.jira-issues-summary')?.textContent ?? '');

  it('picks Pipeline failing in the panel: only the failing top stays, and the List control shows the same value', async () => {
    mount(payload(), 'list');
    await screen.findByText('Currency symbol missing on receipts');
    expect(rowSummaries()).toHaveLength(4);
    const panel = await openFilters();
    await userEvent.click(within(within(panel).getByRole('group', { name: 'Delivery' })).getByRole('button', { name: 'Pipeline failing' }));
    expect(rowSummaries()).toEqual([expect.stringContaining('Refund partial captures')]);
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeInTheDocument();
    // Two groups carry the name (panel and List): the control above the table is the one outside the dialog.
    const controls = screen.getAllByRole('group', { name: 'Delivery' });
    const listControl = controls.find((c) => !panel.contains(c)) as HTMLElement;
    expect(within(listControl).getByRole('button', { name: 'Pipeline failing' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(listControl).getByRole('button', { name: 'All' }));
    expect(rowSummaries()).toHaveLength(4);
    // The click outside shut the panel (its own pointerdown listener); reopened, it reads the value the List control set.
    const reopened = await openFilters();
    expect(within(within(reopened).getByRole('group', { name: 'Delivery' })).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers `Review open` after `Done, not merged` (CodeRabbit spec §5.4)', async () => {
    mount(payload(), 'list');
    await screen.findByText('Currency symbol missing on receipts');
    const names = within(seg()).getAllByRole('button').map((b) => b.textContent);
    expect(names.indexOf('Review open')).toBe(names.indexOf('Done, not merged') + 1);
  });

  it('the segmented control drives the value, and it survives a remount through JIRA_FILTERS_KEY', async () => {
    mount(payload(), 'list');
    await screen.findByText('Currency symbol missing on receipts');
    await userEvent.click(within(seg()).getByRole('button', { name: 'Has MR' }));
    expect(rowSummaries().sort()).toEqual([expect.stringContaining('Currency symbol'), expect.stringContaining('Refund partial captures')]);
    expect(JSON.parse(localStorage.getItem(JIRA_FILTERS_KEY) ?? 'null')).toMatchObject({ delivery: 'has-mr' });
    cleanup();

    mount(payload(), 'list');
    await screen.findByText('Currency symbol missing on receipts');
    expect(within(seg()).getByRole('button', { name: 'Has MR' })).toHaveAttribute('aria-pressed', 'true');
    expect(rowSummaries()).toHaveLength(2);
  });

  // Per issue (parent-lanes spec §6.2): the child whose own MR fails is the row that stays, under its parent's header row — the story with no MR is a
  // heading there, not a match, and nothing is ringed.
  it('narrows per issue: a child whose own MR fails stays as a card row under its parent’s header row', async () => {
    const STORY = issue({ key: 'PAY-60', summary: 'Story without an MR', type: { name: 'Story', level: 0, subtask: false }, subtasks: 1, updated: daysAgoStamp(0) });
    const CHILD = issue({
      key: 'PAY-61',
      summary: 'Child with a failing MR',
      type: { name: 'Sub-task', level: -1, subtask: true },
      parent: { key: 'PAY-60', summary: 'Story without an MR', type: null, status: null },
      updated: daysAgoStamp(0)
    });
    lists[ALPHA.id] = [STORY, CHILD, PAY_140];
    mount(payload('connected', [MR({ iid: 500, keys: ['PAY-61'], title: 'PAY-61 | child' })]), 'list');
    // PAY-140 alone is the `No parent` lane, and a lane of only Done work starts folded (spec §3.6), so its row is not there to wait on.
    await screen.findByText('Child with a failing MR');
    await userEvent.click(within(seg()).getByRole('button', { name: 'Pipeline failing' }));
    expect(rowSummaries()).toEqual(['Child with a failing MR']);
    expect(Array.from(document.querySelectorAll('tr[data-key]')).map((r) => r.getAttribute('data-key'))).toEqual(['PAY-60', 'PAY-61']);
    expect(document.querySelector('tr[data-key="PAY-60"]')).toHaveClass('jira-issues-lane');
  });

  // Review Focus 5: a stored filter for a GitLab that is no longer shown is not a filter — nothing hides, nothing counts, and nothing offers it.
  it('reads a stored Pipeline failing as All when GitLab is unconfigured: every ticket, no control, no badge', async () => {
    localStorage.setItem(JIRA_FILTERS_KEY, JSON.stringify({ delivery: 'failing' }));
    mount(payload('unconfigured'), 'list');
    await screen.findByText('Currency symbol missing on receipts');
    expect(rowSummaries()).toHaveLength(4);
    expect(screen.queryByRole('group', { name: 'Delivery' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
    await openFilters();
    expect(screen.queryByRole('group', { name: 'Delivery' })).toBeNull();
    expect(screen.queryByText('Delivery')).toBeNull();
  });

  it('draws the panel section but no List control in Board view', async () => {
    mount(payload(), 'board');
    await screen.findByText('Refund partial captures');
    expect(screen.queryByRole('group', { name: 'Delivery' })).toBeNull();
    await openFilters();
    expect(screen.getAllByRole('group', { name: 'Delivery' })).toHaveLength(1);
  });
});

/*
  Modifier clicks (Jira detail tabs spec §2.3, T23 and Review Focus 2): on a Board card, a List row and a deck card, Cmd-click, Ctrl-click and a middle-click
  open the full ticket page with no dialog in between — the key store set, the page `ticket`, the origin the Board — and a plain click still opens the
  dialog. Each surface's `title` names the platform's modifier. A control inside the surface keeps its own clicks: the card's `↗` link and `Run ▾`, and a
  List row's title-free cells' controls, never move the page. `JiraView` is real, with `onOpenJiraPage` wired to the page store as `App` wires it, so the
  page switch is the one the shell would make; the page's own read answers `{}` here (a failed read), which is the page's business, not this block's.
*/
describe('modifier clicks open the ticket page', () => {
  const MAPPED = { PAY: ['/Users/ada/pay'] };
  const storedKey = (): unknown => getJiraTicket().key;
  const page = (): unknown => JSON.parse(localStorage.getItem(JIRA_PAGE_KEY) ?? 'null');
  const middle = (el: Element): void => {
    fireEvent(el, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  };
  const TITLE = fullPageTitle(browserPlatform());

  beforeEach(() => {
    act(() => setJiraTicketKey(''));
  });
  afterEach(() => {
    act(() => {
      setJiraView('board');
      setJiraTicketKey('');
    });
  });

  async function renderView(over: Partial<JiraStatusPayload> = {}, firstText = 'Refund partial captures'): Promise<void> {
    setJiraPage('board');
    statusAnswer = status({ repos: MAPPED, ...over });
    render(
      <SettingsProvider>
        <JiraProvider>
          <JiraSessionsProvider open>
            <JiraView onOpenJiraPage={(p) => setJiraPage(p)} />
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>,
      { wrapper: NoGitlab }
    );
    await screen.findAllByText(firstText);
  }

  /** The page landed on the ticket page for `key`, from the Board, and no dialog opened on the way. */
  async function onPage(key: string): Promise<void> {
    await screen.findByRole('button', { name: 'Board' });
    expect(page()).toBe('ticket');
    expect(storedKey()).toBe(key);
    expect(screen.queryByRole('dialog')).toBeNull();
  }

  describe.each([
    ['Cmd-click', (el: Element) => fireEvent.click(el, { metaKey: true })],
    ['Ctrl-click', (el: Element) => fireEvent.click(el, { ctrlKey: true })],
    ['middle-click', middle]
  ])('%s', (_name, gesture) => {
    it('on a Board card opens the page', async () => {
      await renderView();
      act(() => gesture(card('Refund partial captures')));
      await onPage('PAY-131');
    });

    it('on a List row opens the page', async () => {
      setJiraView('list');
      await renderView();
      const row = document.querySelector('tr[data-key="PAY-131"] td:last-child') as HTMLElement;
      act(() => gesture(row));
      await onPage('PAY-131');
    });

    it('on a deck card’s title opens the page', async () => {
      await renderView({
        live: { 'PAY-131': { sessionId: 's-1', name: 'jira run', startedAt: new Date(Date.now() - 3_600_000).toISOString(), repo: '/Users/ada/pay', starting: false } }
      });
      const deck = document.querySelector('.jira-deck-card[data-key="PAY-131"]') as HTMLElement;
      act(() => gesture(within(deck).getByRole('button', { name: 'Refund partial captures' })));
      await onPage('PAY-131');
    });
  });

  it('a plain click on each surface still opens the dialog and leaves the page alone', async () => {
    await renderView({
      live: { 'PAY-131': { sessionId: 's-1', name: 'jira run', startedAt: new Date(Date.now() - 3_600_000).toISOString(), repo: '/Users/ada/pay', starting: false } }
    });
    await userEvent.click(card('Refund partial captures'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(page()).toBe('board');
    expect(storedKey()).toBe('');
    await userEvent.keyboard('{Escape}');
    const deck = document.querySelector('.jira-deck-card[data-key="PAY-131"]') as HTMLElement;
    await userEvent.click(within(deck).getByRole('button', { name: 'Refund partial captures' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(page()).toBe('board');
  });

  it('a plain click on a List row opens the dialog', async () => {
    setJiraView('list');
    await renderView();
    await userEvent.click(document.querySelector('tr[data-key="PAY-131"] td:last-child') as HTMLElement);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(page()).toBe('board');
  });

  it('each surface’s title names the platform’s modifier', async () => {
    await renderView({
      live: { 'PAY-131': { sessionId: 's-1', name: 'jira run', startedAt: new Date(Date.now() - 3_600_000).toISOString(), repo: '/Users/ada/pay', starting: false } }
    });
    expect(TITLE).toMatch(/^(⌘|Ctrl)-click: full page$/);
    expect(card('Refund partial captures')).toHaveAttribute('title', TITLE);
    const deck = document.querySelector('.jira-deck-card[data-key="PAY-131"]') as HTMLElement;
    expect(within(deck).getByRole('button', { name: 'Refund partial captures' })).toHaveAttribute('title', TITLE);
    cleanup();
    setJiraView('list');
    await renderView();
    expect(document.querySelector('tr[data-key="PAY-131"]')).toHaveAttribute('title', TITLE);
  });

  it('Review Focus 2: Cmd- and middle-clicks on the card’s `↗` link and its `Run ▾` stay theirs', async () => {
    await renderView();
    const c = card('Refund partial captures');
    const link = within(c).getByRole('link', { name: 'open PAY-131 in Jira' });
    link.addEventListener('click', (e) => e.preventDefault());
    const run = within(c).getByRole('button', { name: /^Run options for PAY-/ });
    for (const el of [link, run]) {
      act(() => {
        fireEvent.click(el, { metaKey: true });
      });
      act(() => middle(el));
    }
    expect(page()).toBe('board');
    expect(storedKey()).toBe('');
    // A Cmd-click on `Run ▾` is still a click on `Run ▾`, so its own popover opening is the control keeping it; what must not open is the card's modal.
    expect(screen.queryAllByRole('dialog').filter((d) => d.getAttribute('aria-label') !== 'Run menu')).toEqual([]);
  });

  it('Review Focus 2: a middle-click on a control inside a List row stays that control’s', async () => {
    setJiraView('list');
    await renderView();
    const row = document.querySelector('tr[data-key="PAY-131"]') as HTMLElement;
    act(() => middle(within(row).getByRole('button', { name: /^Run options for PAY-/ })));
    expect(page()).toBe('board');
    expect(storedKey()).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
