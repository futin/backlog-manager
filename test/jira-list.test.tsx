/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import JiraView from '../client/src/components/jira/JiraView';
import { JiraSessionsProvider } from '../client/src/hooks/JiraSessionsContext';
import { JiraProvider } from '../client/src/hooks/JiraContext';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { setJiraPage } from '../client/src/hooks/useJiraPage';
import { resetJiraListFilters, setJiraListFilters } from '../client/src/hooks/useJiraListFilters';
import { daysAgoStamp } from './helpers/dates';
import type { JiraBoardStatus, JiraEndReason, JiraIssue, JiraLiveSession, JiraStatusPayload } from '../shared/types';

/*
  Jira › Sessions (Jira sessions, Task 12, moved here from the Board's List by the Sessions-page spec; spec §7.2, C7; DESIGN.md §8.9.1) — the real page over a mocked `fetch`, rendered through `JiraView` because it hosts the
  section's one sessions provider the List reads. Sessions are links handed to the sessions answer, each with a state of its own; a Starting row is NOT a link
  but a status `live` reservation, as the server hands it out. Every instant is relative to the clock the assertion runs under (`test/helpers/dates.ts`).
*/

const ADA = { accountId: 'acc-ada', name: 'Ada Lovelace' };

function issue(key: string, summary: string): JiraIssue {
  return {
    key,
    id: `1${key.replace(/\D/g, '')}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary,
    project: { key: key.split('-')[0], name: 'Payments' },
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
    resolved: null
  };
}

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number): string => hoursAgo(d * 24);

const ALPHA: JiraBoardStatus = {
  id: 'b_000a1fa0',
  name: 'Alpha board',
  roots: [],
  queries: [{ id: 'q_00000001', label: 'Mine', jql: 'assignee = currentUser()' }],
  interval: '1m',
  polledAt: new Date(Date.now() - 12_000).toISOString(),
  count: 4,
  truncated: false,
  failures: []
};
const BETA: JiraBoardStatus = { ...ALPHA, id: 'b_000be7a0', name: 'Beta board', count: 1 };

const ISSUES: Record<string, JiraIssue> = {
  'PAY-131': issue('PAY-131', 'Refund partial captures'),
  'PAY-120': issue('PAY-120', 'Refund flows'),
  'PAY-140': issue('PAY-140', 'Currency symbol missing on receipts'),
  'PAY-151': issue('PAY-151', 'Rounding wrong on invoices')
};

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: ADA,
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [ALPHA, BETA],
    repos: { PAY: ['/home/ada/pay'] },
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

interface LinkOver {
  key: string;
  id: string;
  state: string;
  startedAt: string;
  endedAt?: string | null;
  how?: 'run' | 'branch' | 'manual';
  branch?: string | null;
  repo?: string;
  summary?: string;
}

/** One link as `GET /api/jira/sessions` carries it. `how: 'run'` gets an action so the Run column has a word; the others have none, as the store keeps them. */
function link(o: LinkOver) {
  const how = o.how ?? 'run';
  const ended = o.endedAt !== undefined && o.endedAt !== null;
  return {
    key: o.key,
    sessionId: o.id,
    how,
    action: how === 'run' ? 'context' : null,
    name: `session ${o.id}`,
    repo: o.repo ?? '/home/ada/pay',
    branch: o.branch ?? null,
    surface: 'dashboard',
    model: 'opus',
    effort: null,
    snapshot: { summary: o.summary ?? `Snapshot of ${o.key}`, type: 'Task', parentKey: null },
    startedAt: o.startedAt,
    endedAt: ended ? o.endedAt : null,
    endReason: ended ? ('stopped' as JiraEndReason) : null,
    quietSince: null,
    reattachedAt: null,
    state: ended ? 'ended' : o.state,
    row: null,
    stateSince: o.startedAt
  };
}

let statusAnswer: JiraStatusPayload;
let lists: Record<string, JiraIssue[]>;
let links: ReturnType<typeof link>[];
/** The sessions answer's `saveError`; `null` unless a case sets it. */
let saveError: { message: string; at: string } | null = null;

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(typeof body === 'string' ? body : '') } as Response);

beforeEach(() => {
  localStorage.clear();
  resetJiraListFilters();
  statusAnswer = status();
  lists = { [ALPHA.id]: Object.values(ISSUES), [BETA.id]: [ISSUES['PAY-131']] };
  links = [];
  saveError = null;
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/jira') return ok(statusAnswer);
    if (url.startsWith('/api/jira/sessions')) return ok({ links, reachable: true, rowsAt: null, saveError });
    const m = /^\/api\/jira\/boards\/([^/]+)\/issues$/.exec(url);
    if (m !== null) return ok({ issues: lists[decodeURIComponent(m[1])] ?? [], polledAt: ALPHA.polledAt });
    if (url === '/api/jira/worktrees') return ok({ worktrees: [], unavailable: [] });
    if (url === '/api/agents/status') return ok({ enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits', projectPaths: [] });
    return ok({});
  }) as unknown as typeof fetch;
});

async function renderList(): Promise<void> {
  setJiraPage('sessions');
  render(
    <SettingsProvider>
      <JiraProvider>
        <JiraSessionsProvider open>
          <JiraView onOpenJiraPage={jest.fn()} />
        </JiraSessionsProvider>
      </JiraProvider>
    </SettingsProvider>
  );
  await screen.findByRole('region', { name: 'Sessions' });
  // The sessions answer lands after the shell's: wait for the rows (or the empty line) rather than the section.
  await waitFor(() => expect(screen.queryByText('loading…')).toBeNull());
}

const rowTags = (): string[] => Array.from(document.querySelectorAll('tr.jira-list-row')).map((r) => `${r.getAttribute('data-key')}:${r.getAttribute('data-state')}`);
const group = (label: 'Live' | 'Ended'): HTMLElement => screen.getByRole('rowgroup', { name: label });
const groupTags = (label: 'Live' | 'Ended'): string[] =>
  Array.from(group(label).querySelectorAll('tr.jira-list-row')).map((r) => `${r.getAttribute('data-key')}:${r.getAttribute('data-state')}`);
const chip = (label: string): HTMLElement => within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: new RegExp(`^${label}\\b`) });
const chipCount = (label: string): string => chip(label).querySelector('.jira-list-count')?.textContent ?? '';

/** The fixture most cases share: five live sessions across the board's tickets (one started 10 d ago) and three ended ones (one 10 d ago). */
function standardLinks(): void {
  links = [
    link({ key: 'PAY-131', id: 'plan1', state: 'plan', startedAt: hoursAgo(3), branch: 'feat/refund-partial' }),
    link({ key: 'PAY-140', id: 'reply1', state: 'reply', startedAt: hoursAgo(8) }),
    link({ key: 'PAY-120', id: 'work1', state: 'working', startedAt: hoursAgo(5) }),
    // Live for ten days: the window filters ENDED rows only, so this one must stay.
    link({ key: 'PAY-120', id: 'work2', state: 'working', startedAt: daysAgo(10) }),
    link({ key: 'PAY-151', id: 'quiet1', state: 'quiet', startedAt: hoursAgo(1) }),
    link({ key: 'PAY-131', id: 'end1', state: 'ended', startedAt: daysAgo(3), endedAt: daysAgo(2) }),
    link({ key: 'PAY-120', id: 'end2', state: 'ended', startedAt: daysAgo(2), endedAt: daysAgo(1) }),
    link({ key: 'PAY-151', id: 'end3', state: 'ended', startedAt: daysAgo(11), endedAt: daysAgo(10) })
  ];
}

describe('the Sessions page', () => {
  it('groups Live above Ended and sorts each: Live by state then newest start, Ended by newest end', async () => {
    standardLinks();
    await renderList();
    await waitFor(() => expect(rowTags().length).toBeGreaterThan(0));
    expect(groupTags('Live')).toEqual(['PAY-131:plan', 'PAY-140:reply', 'PAY-120:working', 'PAY-120:working', 'PAY-151:quiet']);
    // The two working rows on PAY-120: the one started 5 h ago comes before the one started 10 d ago.
    const working = Array.from(group('Live').querySelectorAll('tr[data-state="working"]')).map((r) => r.textContent ?? '');
    expect(working).toHaveLength(2);
    expect(working[0]).toMatch(/5h/);
    expect(working[1]).toMatch(/10d/);
    // Ended: newest end first (1 d, then 2 d); the 10 d one is outside the default 7 d window.
    expect(groupTags('Ended')).toEqual(['PAY-120:ended', 'PAY-131:ended']);
    // Live is drawn before Ended in the document.
    expect(group('Live').compareDocumentPosition(group('Ended')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('rowgroup', { name: 'Live' })).toHaveTextContent('Live · 5');
    expect(screen.getByRole('rowgroup', { name: 'Ended' })).toHaveTextContent('Ended · 2');
  });

  it('keeps a live row started 10 d ago under the 7 d window and hides an ended row from 10 d ago', async () => {
    standardLinks();
    await renderList();
    await waitFor(() => expect(rowTags().length).toBeGreaterThan(0));
    const tags = rowTags();
    expect(tags.filter((t) => t === 'PAY-120:working')).toHaveLength(2);
    // PAY-151's ended session (10 d ago) is hidden; its live quiet one is not.
    expect(tags).not.toContain('PAY-151:ended');
    expect(tags).toContain('PAY-151:quiet');
    expect(screen.getByText(/ended sessions older than 7 d are hidden/)).toBeInTheDocument();

    // Widening the window to all brings the old ended row back; live rows did not move.
    act(() => setJiraListFilters({ window: 'all' }));
    await waitFor(() => expect(rowTags()).toContain('PAY-151:ended'));
    expect(groupTags('Ended')).toEqual(['PAY-120:ended', 'PAY-131:ended', 'PAY-151:ended']);
  });

  it('draws each chip with its count and filters to it', async () => {
    standardLinks();
    await renderList();
    await waitFor(() => expect(rowTags().length).toBeGreaterThan(0));
    // Needs you: plan + reply. Working: two. Ended: two inside the window. All: five live + two ended.
    expect(chipCount('All')).toBe('7');
    expect(chipCount('Needs you')).toBe('2');
    expect(chipCount('Working')).toBe('2');
    expect(chipCount('Ended')).toBe('2');

    await userEvent.click(chip('Needs you'));
    expect(rowTags()).toEqual(['PAY-131:plan', 'PAY-140:reply']);
    // A pressed chip does not shrink its neighbours' counts.
    expect(chipCount('Working')).toBe('2');
    expect(chip('Needs you')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(chip('Working'));
    expect(rowTags()).toEqual(['PAY-120:working', 'PAY-120:working']);

    await userEvent.click(chip('Ended'));
    expect(rowTags()).toEqual(['PAY-120:ended', 'PAY-131:ended']);
    expect(screen.queryByRole('rowgroup', { name: 'Live' })).toBeNull();

    await userEvent.click(chip('All'));
    expect(rowTags()).toHaveLength(7);
  });

  it('All tickets shows a session on a key that is not on the board, with its snapshot summary', async () => {
    links = [
      link({ key: 'PAY-131', id: 'on1', state: 'working', startedAt: hoursAgo(2) }),
      link({ key: 'ZZ-9', id: 'off1', state: 'working', startedAt: hoursAgo(1), summary: 'Off board thing' })
    ];
    await renderList();
    await waitFor(() => expect(rowTags().length).toBeGreaterThan(0));
    expect(rowTags()).toEqual(['PAY-131:working']);
    expect(screen.queryByText('Off board thing')).toBeNull();
    expect(screen.getByText(/this board only/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All tickets' }));
    expect(await screen.findByText('Off board thing')).toBeInTheDocument();
    expect(rowTags()).toEqual(['ZZ-9:working', 'PAY-131:working']);
    expect(screen.queryByText(/this board only/)).toBeNull();
  });

  it('an ended row gets Reopen, and Run ▾ when the ticket has only a live branch link', async () => {
    links = [
      link({ key: 'PAY-131', id: 'b1', state: 'working', startedAt: hoursAgo(2), how: 'branch', branch: 'feat/refund-partial' }),
      link({ key: 'PAY-131', id: 'e1', state: 'ended', startedAt: daysAgo(2), endedAt: daysAgo(1) }),
      // PAY-120 has a live RUN link: its ended row must not offer a second Start.
      link({ key: 'PAY-120', id: 'r1', state: 'working', startedAt: hoursAgo(2), how: 'run' }),
      link({ key: 'PAY-120', id: 'e2', state: 'ended', startedAt: daysAgo(2), endedAt: daysAgo(1) })
    ];
    statusAnswer = status({ live: { 'PAY-120': { name: 'run', sessionId: 'r1', startedAt: hoursAgo(2), repo: '/home/ada/pay', starting: false } as JiraLiveSession } });
    await renderList();
    await waitFor(() => expect(rowTags().length).toBe(4));
    const ended = (key: string): HTMLElement => within(group('Ended')).getByRole('row', { name: `Session on ${key}` });
    expect(within(ended('PAY-131')).getByRole('link', { name: 'Reopen' })).toBeInTheDocument();
    expect(within(ended('PAY-131')).getByRole('button', { name: 'Run PAY-131' })).toBeInTheDocument();
    expect(within(ended('PAY-120')).getByRole('link', { name: 'Reopen' })).toBeInTheDocument();
    expect(within(ended('PAY-120')).queryByRole('button', { name: /^Run PAY-120/ })).toBeNull();
    // A live row never carries Run ▾.
    expect(within(group('Live')).queryByRole('button', { name: /^Run PAY/ })).toBeNull();
  });

  it('a click anywhere on a row opens Detail; its own Run ▾, that menu\'s panel and a text selection do not', async () => {
    links = [
      link({ key: 'PAY-131', id: 'b1', state: 'working', startedAt: hoursAgo(2), how: 'branch', branch: 'feat/refund-partial' }),
      link({ key: 'PAY-131', id: 'e1', state: 'ended', startedAt: daysAgo(2), endedAt: daysAgo(1) })
    ];
    await renderList();
    await waitFor(() => expect(rowTags().length).toBe(2));
    const modal = (): Element | null => document.querySelector('[role="dialog"][aria-modal="true"]');
    const ended = (): HTMLElement => within(group('Ended')).getByRole('row', { name: 'Session on PAY-131' });

    // Run ▾ is the button's, and so is a click on the panel it opens inside the cell: neither opens Detail.
    await userEvent.click(within(ended()).getByRole('button', { name: 'Run PAY-131' }));
    const panel = ended().querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    await userEvent.click(panel as HTMLElement);
    expect(modal()).toBeNull();
    await userEvent.keyboard('{Escape}');

    // A click that ends a text selection is someone copying, not opening.
    const selection = jest.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'feat/refund-partial' } as unknown as Selection);
    await userEvent.click(within(group('Live')).getByText('feat/refund-partial'));
    expect(modal()).toBeNull();
    selection.mockRestore();

    // A plain cell — the branch, nowhere near the summary — opens Detail for that row's ticket.
    await userEvent.click(within(group('Live')).getByText('feat/refund-partial'));
    expect(await screen.findByRole('dialog', { name: /^PAY-131 / })).toHaveAttribute('aria-modal', 'true');
  });

  it('draws a Starting row from the status reservation, with no buttons', async () => {
    statusAnswer = status({ live: { 'PAY-151': { name: 'jira run', sessionId: null, startedAt: hoursAgo(0.01), repo: '/home/ada/pay', starting: true } } });
    await renderList();
    await waitFor(() => expect(rowTags()).toEqual(['PAY-151:starting']));
    const row = screen.getByRole('row', { name: 'Session on PAY-151' });
    expect(within(row).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Rounding wrong on invoices']);
  });

  it('search matches the branch, the key, the summary and the repo', async () => {
    standardLinks();
    await renderList();
    await waitFor(() => expect(rowTags().length).toBeGreaterThan(0));
    const search = screen.getByRole('searchbox', { name: 'Search sessions' });

    await userEvent.type(search, 'refund-partial');
    expect(rowTags()).toEqual(['PAY-131:plan']);

    await userEvent.clear(search);
    await userEvent.type(search, 'pay-140');
    expect(rowTags()).toEqual(['PAY-140:reply']);

    await userEvent.clear(search);
    await userEvent.type(search, 'currency symbol');
    expect(rowTags()).toEqual(['PAY-140:reply']);

    await userEvent.clear(search);
    await userEvent.type(search, 'nothing like this');
    expect(rowTags()).toEqual([]);
    expect(screen.getByText('No sessions match')).toBeInTheDocument();
  });

  it('one session on a ticket two boards hold is one row with All tickets on', async () => {
    links = [link({ key: 'PAY-131', id: 'only', state: 'working', startedAt: hoursAgo(2) })];
    await renderList();
    await waitFor(() => expect(rowTags().length).toBe(1));
    await userEvent.click(screen.getByRole('button', { name: 'All tickets' }));
    expect(rowTags()).toEqual(['PAY-131:working']);
    expect(document.querySelectorAll('tr.jira-list-row')).toHaveLength(1);
  });

  it('the Repo select narrows the rows to one repository', async () => {
    links = [
      link({ key: 'PAY-131', id: 'a', state: 'working', startedAt: hoursAgo(2), repo: '/home/ada/pay' }),
      link({ key: 'PAY-120', id: 'b', state: 'working', startedAt: hoursAgo(3), repo: '/home/ada/ledger' })
    ];
    await renderList();
    await waitFor(() => expect(rowTags().length).toBe(2));
    act(() => setJiraListFilters({ repo: 'ledger' }));
    await waitFor(() => expect(rowTags()).toEqual(['PAY-120:working']));
  });

  it('keys no two rows alike: no React key warning across the whole fixture', async () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    standardLinks();
    await renderList();
    await waitFor(() => expect(rowTags().length).toBeGreaterThan(0));
    const keyWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('same key') || String(c[0]).includes('unique "key"'));
    warn.mockRestore();
    expect(keyWarnings).toEqual([]);
  });

  /* The link store's save failing was a log line only, so the stack ran it memory-only for its whole life and every restart dropped every link (2026-11-04).
     The List says so while it lasts, and says nothing once a save lands. */
  it('warns above the rows while the link store cannot save, naming the error', async () => {
    standardLinks();
    saveError = { message: 'EROFS: read-only file system, open \'/x/.atomic-write.tmp\'', at: hoursAgo(0) };
    await renderList();
    const note = await screen.findByRole('status', { name: 'Link store' });
    expect(note.textContent).toBe("Jira links are not being saved — a server restart will drop them. EROFS: read-only file system, open '/x/.atomic-write.tmp'");
  });

  it('draws no warning when the answer has no saveError', async () => {
    standardLinks();
    await renderList();
    await waitFor(() => expect(rowTags().length).toBeGreaterThan(0));
    expect(screen.queryByRole('status', { name: 'Link store' })).toBeNull();
  });

  // Mock SessionsB.dc.html: the page's own band, not the Board page's.
  it('draws its own band: title Sessions, the board picker, Search sessions, and no Board | List switch and no Filters button', async () => {
    await renderList();
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Pick a Jira board/ })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search sessions' })).toHaveAttribute('placeholder', 'search key, summary, repo, branch');
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull();
  });

  it('with All tickets off and no boards, draws the bar and `No boards yet` with an Open Setup chip — and All tickets on draws the off-board rows', async () => {
    statusAnswer = status({ boards: [] });
    links = [link({ key: 'OFFBOARD-9', id: 'o1', state: 'working', startedAt: hoursAgo(1), summary: 'Off board thing' })];
    await renderList();
    expect(screen.getByRole('group', { name: 'Show' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All tickets' })).toBeInTheDocument();
    expect(screen.getByText(/No boards yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Setup' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All tickets' }));
    expect(await screen.findByRole('row', { name: 'Session on OFFBOARD-9' })).toBeInTheDocument();
  });

  it('with All tickets on, the table draws while the board list fails', async () => {
    links = [
      link({ key: 'PAY-131', id: 'on1', state: 'working', startedAt: hoursAgo(2) }),
      link({ key: 'ZZ-9', id: 'off1', state: 'working', startedAt: hoursAgo(1) })
    ];
    const base = global.fetch as jest.Mock;
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      /^\/api\/jira\/boards\/[^/]+\/issues$/.test(String(input)) ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve('') } as Response) : base(input)
    ) as unknown as typeof fetch;
    setJiraListFilters({ allTickets: true });
    await renderList();
    await waitFor(() => expect(rowTags()).toEqual(['ZZ-9:working', 'PAY-131:working']));
    expect(screen.queryByText('board unavailable', { selector: '.board-empty' })).toBeNull();
    // The band is the one place left that says the board is down.
    const down = await screen.findByText(/board unavailable/);
    expect(down).toHaveClass('failing');
    expect(down.closest('.ui-band-sub')).not.toBeNull();
  });

  it("the band shows the board's sweep failure in red", async () => {
    statusAnswer = status({ boards: [{ ...ALPHA, failures: [{ kind: 'query', id: 'q_00000001', message: "Field 'foo' does not exist" }] }, BETA] });
    await renderList();
    const sub = await screen.findByText(/Field 'foo' does not exist/);
    expect(sub).toHaveClass('failing');
  });

  it('with All tickets off and the board list failing, the body reads `board unavailable` under the bar', async () => {
    const base = global.fetch as jest.Mock;
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      /^\/api\/jira\/boards\/[^/]+\/issues$/.test(String(input)) ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve('') } as Response) : base(input)
    ) as unknown as typeof fetch;
    await renderList();
    expect(await screen.findByText('board unavailable')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Show' })).toBeInTheDocument();
    expect(document.querySelector('table')).toBeNull();
  });

  it("picking a board on the Sessions page is the Board page's pick", async () => {
    await renderList();
    await userEvent.click(screen.getByRole('button', { name: /^Pick a Jira board/ }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Boards' })).getByRole('button', { name: 'Beta board' }));
    expect(JSON.parse(localStorage.getItem('backlog-manager.jira-board') ?? 'null')).toBe(BETA.id);
    act(() => setJiraPage('board'));
    expect(await screen.findByRole('heading', { name: 'Beta board' })).toBeInTheDocument();
  });

  it('a row click opens Detail on the Sessions page, and a landed write re-reads the board list', async () => {
    links = [link({ key: 'PAY-131', id: 'w1', state: 'working', startedAt: hoursAgo(1) })];
    const base = global.fetch as jest.Mock;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/jira/issue/assign' ? ok({ ok: true }) : base(input, init)
    ) as unknown as typeof fetch;
    const reads = (): number => (global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]) === `/api/jira/boards/${ALPHA.id}/issues`).length;
    await renderList();
    await waitFor(() => expect(rowTags().length).toBe(1));
    await userEvent.click(within(screen.getByRole('row', { name: 'Session on PAY-131' })).getByRole('button', { name: 'Refund partial captures' }));
    const dialog = await screen.findByRole('dialog', { name: /^PAY-131 / });
    const before = reads();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Assign to me' }));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("search is per page: text typed on Sessions is not in the Board page's search after a switch", async () => {
    await renderList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'refund');
    act(() => setJiraPage('board'));
    expect(await screen.findByRole('searchbox', { name: 'Search issues' })).toHaveValue('');
  });

  it("a Sessions row's `Run ▾` › a pick opens the launch sheet", async () => {
    links = [link({ key: 'PAY-131', id: 'e1', state: 'ended', startedAt: daysAgo(2), endedAt: daysAgo(1) })];
    await renderList();
    await waitFor(() => expect(rowTags().length).toBe(1));
    await userEvent.click(screen.getByRole('button', { name: 'Run PAY-131' }));
    await userEvent.click(await within(await screen.findByRole('dialog', { name: 'Run menu' })).findByRole('button', { name: /Work it end to end/ }));
    expect(await screen.findByRole('dialog', { name: 'run PAY-131' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /^PAY-131 / })).toBeNull();
  });
});
