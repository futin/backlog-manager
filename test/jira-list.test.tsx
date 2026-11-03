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
import { setJiraView } from '../client/src/hooks/useJiraView';
import { resetJiraListFilters, setJiraListFilters } from '../client/src/hooks/useJiraListFilters';
import { daysAgoStamp } from './helpers/dates';
import type { JiraBoardStatus, JiraEndReason, JiraIssue, JiraLiveSession, JiraStatusPayload } from '../shared/types';

/*
  Jira › List (Jira sessions, Task 12; spec §7.2, C7; DESIGN.md §8.9.1) — the real page over a mocked `fetch`, rendered through `JiraView` because it hosts the
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

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(typeof body === 'string' ? body : '') } as Response);

beforeEach(() => {
  localStorage.clear();
  resetJiraListFilters();
  statusAnswer = status();
  lists = { [ALPHA.id]: Object.values(ISSUES), [BETA.id]: [ISSUES['PAY-131']] };
  links = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/jira') return ok(statusAnswer);
    if (url.startsWith('/api/jira/sessions')) return ok({ links, reachable: true, rowsAt: null });
    const m = /^\/api\/jira\/boards\/([^/]+)\/issues$/.exec(url);
    if (m !== null) return ok({ issues: lists[decodeURIComponent(m[1])] ?? [], polledAt: ALPHA.polledAt });
    if (url === '/api/jira/worktrees') return ok({ worktrees: [], unavailable: [] });
    if (url === '/api/agents/status') return ok({ enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits', projectPaths: [] });
    return ok({});
  }) as unknown as typeof fetch;
});

async function renderList(): Promise<void> {
  setJiraPage('board');
  setJiraView('list');
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

describe('the List view', () => {
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
});
