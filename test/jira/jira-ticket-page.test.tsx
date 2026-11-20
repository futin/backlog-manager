/**
 * @jest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import JiraView from '../../client/src/components/jira/JiraView';
import { JiraTicketFrame } from '../../client/src/components/jira/JiraTicketPage';
import { GitlabContext } from '../../client/src/hooks/GitlabContext';
import { JiraContext, JiraProvider } from '../../client/src/hooks/JiraContext';
import { JiraSessionsContext, JiraSessionsProvider } from '../../client/src/hooks/JiraSessionsContext';
import { setJiraDetailTab } from '../../client/src/hooks/useJiraDetailTab';
import { setJiraPage } from '../../client/src/hooks/useJiraPage';
import { getJiraTicket, setJiraTicketKey } from '../../client/src/hooks/useJiraTicketKey';
import { setJiraView } from '../../client/src/hooks/useJiraView';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { JIRA_PAGE_KEY } from '../../client/src/lib/jira-page';
import { browserPlatform, fullPageTitle } from '../../client/src/lib/open-intent';
import { NoGitlab } from '../helpers/no-gitlab';
import {
  AGENTS_ON,
  ISSUE,
  READER,
  detail,
  link,
  resolveFixture,
  status,
  ticketBodyCases,
  type BodyFixture,
  type ResolvedFixture
} from '../helpers/ticket-body-cases';
import type { JiraIssue, JiraStatusPayload } from '../../shared/types';

/*
  The Jira ticket page (Jira detail tabs spec §2; Task 8): the section's fifth page, one ticket read by key. Two halves. The first mounts the real section —
  `JiraView` under the shell's providers over a stubbed `fetch` — because what the page is about is how the reader gets there and back: the modal's
  `Open full page ↗`, a modifier click, a remount, an empty key, `← <origin>`, `Retry` and `Forget`. The second runs the ticket body's shared case table
  (`test/helpers/ticket-body-cases.ts`, §9 cases 8–16) through the page's frame, `JiraTicketFrame`, as `jira-detail.test.tsx` runs it through the modal.

  Every fixture is the case table's: PAY-12 `Refund partial captures` under PAY-3 `Refund flows`, on the one board, read by Sam. Stamps are relative to the
  clock the assertion runs under (`test/helpers/dates.ts`, through the table's builders).
*/

const ok = (body: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(typeof body === 'string' ? body : '') } as Response);
const failed = (code: number, error: string): Promise<Response> =>
  Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({ error }), text: () => Promise.resolve(error) } as Response);
const pending = (): Promise<Response> => new Promise<Response>(() => {});

const BOARD_NAME = status().boards[0].name;
const BOARD_ID = status().boards[0].id;
const child = (key: string, parentKey: string): JiraIssue => ({
  ...ISSUE,
  key,
  id: `1${key.replace(/\D/g, '')}`,
  url: `https://acme.atlassian.net/browse/${key}`,
  summary: `Child ${key}`,
  parent: { key: parentKey, summary: '', type: null, status: null }
});
const PAY_15 = child('PAY-15', 'PAY-12');
const PAY_16 = child('PAY-16', 'PAY-15');

let statusAnswer: JiraStatusPayload;
let sessionsAnswer: unknown;
let lists: Record<string, JiraIssue[]>;
/** `GET /api/jira/issue/<KEY>` per key; a key with no entry stays pending, so a stray read of another ticket draws nothing. */
let details: Record<string, () => Promise<Response>>;
let requested: string[];
let posted: string[];

beforeEach(() => {
  localStorage.clear();
  setJiraDetailTab('ticket');
  setJiraView('board');
  act(() => setJiraTicketKey(''));
  statusAnswer = status();
  sessionsAnswer = { links: [], reachable: true, rowsAt: null };
  lists = { [BOARD_ID]: [ISSUE] };
  details = {
    'PAY-12': () => ok(detail({ children: [PAY_15] })),
    'PAY-15': () => ok(detail({ ...PAY_15, children: [PAY_16] })),
    'PAY-16': () => ok(detail({ ...PAY_16 }))
  };
  requested = [];
  posted = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    if (init?.method === 'POST') {
      posted.push(url);
      return ok({ ok: true, reread: true });
    }
    if (url === '/api/jira') return ok(statusAnswer);
    if (url.startsWith('/api/jira/sessions')) return ok(sessionsAnswer);
    const board = /^\/api\/jira\/boards\/([^/]+)\/issues$/.exec(url);
    if (board !== null) return ok({ issues: lists[decodeURIComponent(board[1])] ?? [], polledAt: statusAnswer.boards[0].polledAt });
    const issue = /^\/api\/jira\/issue\/([^/?]+)$/.exec(url);
    if (issue !== null) return details[decodeURIComponent(issue[1])]?.() ?? pending();
    if (url === '/api/agents/status') return ok(AGENTS_ON);
    if (url === '/api/jira/worktrees') return ok({ worktrees: [], unavailable: [] });
    return ok({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => {
    setJiraTicketKey('');
    setJiraView('board');
  });
});

const storedKey = (): unknown => getJiraTicket().key;
const page = (): unknown => JSON.parse(localStorage.getItem(JIRA_PAGE_KEY) ?? 'null');
const issueReads = (key: string): number => requested.filter((u) => u === `/api/jira/issue/${key}`).length;
/** The top bar's crumbs, one per element, joined as they read: `Jira / <board> / <parent> / <KEY>`. */
const crumbs = (): string =>
  [...screen.getByRole('navigation', { name: 'Ticket path' }).children].map((c) => c.textContent ?? '').join(' ');
const middle = (el: Element): void => {
  fireEvent(el, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
};
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** The section as the shell mounts it, with the shell's page switch: `onOpenJiraPage` writes the page store, as `App` does. */
const section = () => (
  <SettingsProvider>
    <JiraProvider>
      <JiraSessionsProvider open>
        <JiraView onOpenJiraPage={(p) => setJiraPage(p)} />
      </JiraSessionsProvider>
    </JiraProvider>
  </SettingsProvider>
);
function mountSection(on: 'board' | 'sessions' | 'ticket' = 'board', key = ''): ReturnType<typeof render> {
  setJiraPage(on);
  act(() => setJiraTicketKey(key));
  return render(section(), { wrapper: NoGitlab });
}
const card = (summary: string): HTMLElement =>
  screen.getAllByText(summary).map((n) => n.closest<HTMLElement>('.board-card')).find((c) => c !== null) as HTMLElement;
/** The page's body has landed: its tablist is drawn under the full frame's top bar. */
const landed = async (): Promise<void> => {
  await screen.findByRole('tablist');
  await flush();
};
const openChildren = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: /^Children & comments/ }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const treeRow = (key: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`.jira-tree-row[data-key="${key}"]`) ??
    [...document.querySelectorAll<HTMLElement>('.jira-tree-row')].find((b) => b.querySelector('.jira-tree-key')?.textContent === key);
  if (row === undefined || row === null) throw new Error(`no Children row ${key}`);
  return row;
};

describe('getting to the page', () => {
  it('T18: the modal’s `Open full page ↗` closes the modal and opens the page on that key, drawn from the detail read', async () => {
    mountSection('board');
    await screen.findAllByText('Refund partial captures');
    fireEvent.click(card('Refund partial captures'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open full page ↗' }));
    await landed();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(storedKey()).toBe('PAY-12');
    expect(page()).toBe('ticket');
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
  });

  it('T19: a stored key with no board poll draws `loading…`, then the body, from `fetchJiraDetail` alone', async () => {
    let answer!: (r: Promise<Response>) => void;
    details['PAY-12'] = () => new Promise<Response>((resolve) => (answer = (r) => void r.then(resolve)));
    mountSection('ticket', 'PAY-12');
    expect(await screen.findByText('loading…')).toBeInTheDocument();
    await waitFor(() => expect(issueReads('PAY-12')).toBe(1));
    await act(async () => {
      answer(ok(detail()));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await landed();
    expect(screen.queryByText('loading…')).toBeNull();
    expect(requested.some((u) => u.startsWith('/api/jira/boards/'))).toBe(false);
  });

  it('T19: a rejected read draws the failure line and `Retry`', async () => {
    details['PAY-12'] = () => failed(502, 'Jira answered 502');
    mountSection('ticket', 'PAY-12');
    expect(await screen.findByRole('alert')).toHaveTextContent('could not read the ticket — Jira answered 502');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('T20: page `ticket` with no key held draws the Board, and the page store reads `board`', async () => {
    mountSection('ticket', '');
    await screen.findAllByText('Refund partial captures');
    expect(card('Refund partial captures')).toBeInTheDocument();
    await waitFor(() => expect(page()).toBe('board'));
    expect(screen.queryByRole('navigation', { name: 'Ticket path' })).toBeNull();
  });
});

describe('the origin chip (§2.3)', () => {
  beforeEach(() => {
    sessionsAnswer = { links: [link({ sessionId: 's-1', state: 'working' })], reachable: true, rowsAt: null };
  });

  it('T22: entered from Sessions, `← Sessions` goes back to Sessions', async () => {
    mountSection('sessions');
    await waitFor(() => expect(document.querySelector('tr.jira-list-row[data-key="PAY-12"]')).not.toBeNull());
    const row = document.querySelector('tr.jira-list-row[data-key="PAY-12"] td:last-child') as HTMLElement;
    act(() => {
      fireEvent.click(row, { metaKey: true });
    });
    await landed();
    expect(page()).toBe('ticket');
    expect(storedKey()).toBe('PAY-12');
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    await waitFor(() => expect(page()).toBe('sessions'));
    expect(screen.queryByRole('navigation', { name: 'Ticket path' })).toBeNull();
  });

  it('T22: entered by the rail’s row (the page store alone), the chip is `← Board`', async () => {
    mountSection('sessions');
    await waitFor(() => expect(document.querySelector('tr.jira-list-row[data-key="PAY-12"]')).not.toBeNull());
    act(() => {
      setJiraTicketKey('PAY-12');
      setJiraPage('ticket');
    });
    await landed();
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sessions' })).toBeNull();
  });

  it('T22: after a remount, an origin of Sessions is forgotten and the chip is `← Board`', async () => {
    const first = mountSection('sessions');
    await waitFor(() => expect(document.querySelector('tr.jira-list-row[data-key="PAY-12"]')).not.toBeNull());
    act(() => middle(document.querySelector('tr.jira-list-row[data-key="PAY-12"] td:last-child') as HTMLElement));
    await landed();
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    first.unmount();
    render(section(), { wrapper: NoGitlab });
    await landed();
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
  });
});

describe('modifier clicks reach the page from Sessions and from the modal’s Children (T23)', () => {
  const TITLE = fullPageTitle(browserPlatform());

  describe.each([
    ['Cmd-click', (el: Element) => fireEvent.click(el, { metaKey: true })],
    ['Ctrl-click', (el: Element) => fireEvent.click(el, { ctrlKey: true })],
    ['middle-click', middle]
  ])('%s', (_name, gesture) => {
    it('on a Sessions row opens the page, origin Sessions', async () => {
      sessionsAnswer = { links: [link({ sessionId: 's-1', state: 'working' })], reachable: true, rowsAt: null };
      mountSection('sessions');
      await waitFor(() => expect(document.querySelector('tr.jira-list-row[data-key="PAY-12"]')).not.toBeNull());
      act(() => gesture(document.querySelector('tr.jira-list-row[data-key="PAY-12"] td:last-child') as HTMLElement));
      await landed();
      expect(page()).toBe('ticket');
      expect(storedKey()).toBe('PAY-12');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    });

    it('on a Children row in the modal opens the page on that child, and the modal closes', async () => {
      mountSection('board');
      await screen.findAllByText('Refund partial captures');
      fireEvent.click(card('Refund partial captures'));
      await screen.findByRole('dialog');
      await waitFor(() => expect(issueReads('PAY-12')).toBeGreaterThan(0));
      await flush();
      await openChildren();
      act(() => gesture(treeRow('PAY-15')));
      await landed();
      expect(page()).toBe('ticket');
      expect(storedKey()).toBe('PAY-15');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    });
  });

  it('a plain click on a Sessions row and on a modal Children row stays in the modal; both carry the platform’s title', async () => {
    sessionsAnswer = { links: [link({ sessionId: 's-1', state: 'working' })], reachable: true, rowsAt: null };
    mountSection('sessions');
    await waitFor(() => expect(document.querySelector('tr.jira-list-row[data-key="PAY-12"]')).not.toBeNull());
    const row = document.querySelector('tr.jira-list-row[data-key="PAY-12"]') as HTMLElement;
    expect(row).toHaveAttribute('title', TITLE);
    fireEvent.click(row.querySelector('td:last-child') as HTMLElement);
    await screen.findByRole('dialog');
    expect(page()).toBe('sessions');
    await waitFor(() => expect(issueReads('PAY-12')).toBeGreaterThan(0));
    await flush();
    await openChildren();
    expect(treeRow('PAY-15')).toHaveAttribute('title', TITLE);
    await act(async () => {
      fireEvent.click(treeRow('PAY-15'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(page()).toBe('sessions');
    expect(storedKey()).toBe('');
  });

  // The title button is the row's own open control — its middle-click IS the page, as the row's is — so the controls checked are every other one.
  it('Review Focus 2: a middle-click on a control inside a Sessions row stays that control’s', async () => {
    // An ended row, so it carries `Run ▾` — the row's one control besides the title while no dashboard row offers `Open`.
    const ended = link({ sessionId: 's-1', state: 'ended', endedAt: new Date(Date.now() - 60_000).toISOString(), endReason: 'stopped' });
    sessionsAnswer = { links: [ended], reachable: true, rowsAt: null };
    mountSection('sessions');
    await waitFor(() => expect(document.querySelector('tr.jira-list-row[data-key="PAY-12"]')).not.toBeNull());
    const row = document.querySelector('tr.jira-list-row[data-key="PAY-12"]') as HTMLElement;
    const controls = within(row).getAllByRole('button').filter((b) => !b.classList.contains('jira-list-title'));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) act(() => middle(control));
    for (const anchor of within(row).queryAllByRole('link')) act(() => middle(anchor));
    expect(page()).toBe('sessions');
    expect(storedKey()).toBe('');
  });
});

describe('the frame', () => {
  it('pre-issue: `Jira / PAY-12` and `← Board`, no `Open in Jira ↗` or `Run ▾`, then the full crumbs and actions once the read lands', async () => {
    let answer!: () => void;
    details['PAY-12'] = () => new Promise<Response>((resolve) => (answer = () => void ok(detail()).then(resolve)));
    mountSection('ticket', 'PAY-12');
    await screen.findByText('loading…');
    await waitFor(() => expect(issueReads('PAY-12')).toBe(1));
    expect(crumbs()).toBe('Jira / PAY-12');
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in Jira ↗' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run PAY-12' })).toBeNull();
    await act(async () => {
      answer();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await landed();
    expect(crumbs()).toBe(`Jira / ${BOARD_NAME} / PAY-3 Refund flows / PAY-12`);
    expect(screen.getByRole('link', { name: 'Open in Jira ↗' })).toHaveAttribute('href', ISSUE.url);
    expect(screen.getByRole('button', { name: 'Run PAY-12' })).toBeInTheDocument();
  });

  it('draws no board crumb for a ticket that is not on the picked board', async () => {
    details['PAY-12'] = () => ok(detail({ boards: [] }));
    mountSection('ticket', 'PAY-12');
    await landed();
    expect(crumbs()).toBe('Jira / PAY-3 Refund flows / PAY-12');
  });

  it('T28: `Retry` reads again; `Forget PAY-12` empties the key and goes back to the origin', async () => {
    details['PAY-12'] = () => failed(502, 'Jira answered 502');
    mountSection('ticket', 'PAY-12');
    await screen.findByRole('alert');
    expect(issueReads('PAY-12')).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(issueReads('PAY-12')).toBe(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Forget PAY-12' }));
    await waitFor(() => expect(page()).toBe('board'));
    expect(storedKey()).toBe('');
    await screen.findAllByText('Refund partial captures');
  });

  it('a write on the page posts, re-reads the detail and draws the answer', async () => {
    let assigned = false;
    details['PAY-12'] = () => ok(detail(assigned ? { assignee: READER } : {}));
    mountSection('ticket', 'PAY-12');
    await landed();
    const strip = screen.getByRole('group', { name: 'Summary' });
    assigned = true;
    await act(async () => {
      fireEvent.click(within(strip).getByRole('button', { name: 'Assign to me' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(posted).toEqual(['/api/jira/issue/assign']));
    await waitFor(() => expect(issueReads('PAY-12')).toBe(2));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Summary' })).getByText(READER.name)).toBeInTheDocument());
  });
});

describe('the walk (§2.3)', () => {
  it('a Children row swaps the key and draws `← PAY-12`; Back writes PAY-12 again', async () => {
    mountSection('ticket', 'PAY-12');
    await landed();
    await openChildren();
    await act(async () => {
      fireEvent.click(treeRow('PAY-15'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(storedKey()).toBe('PAY-15');
    const back = await screen.findByRole('button', { name: 'Back to PAY-12' });
    await waitFor(() => expect(crumbs()).toMatch(/PAY-15$/));
    await act(async () => {
      fireEvent.click(back);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(storedKey()).toBe('PAY-12');
    await waitFor(() => expect(crumbs()).toMatch(/PAY-12$/));
    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull();
  });

  it('a later failed re-read keeps the drawn ticket and says so under the strip', async () => {
    let fail = false;
    details['PAY-12'] = () => (fail ? failed(502, 'Jira answered 502') : ok(detail()));
    mountSection('ticket', 'PAY-12');
    await landed();
    fail = true;
    await act(async () => {
      fireEvent.click(within(screen.getByRole('group', { name: 'Summary' })).getByRole('button', { name: 'Assign to me' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(issueReads('PAY-12')).toBe(2));
    expect(await screen.findByText(/could not read the ticket — Jira answered 502/)).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(crumbs()).toBe(`Jira / ${BOARD_NAME} / PAY-3 Refund flows / PAY-12`);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('Review Focus 3: two walk steps, then a remount, land on the last child with no walk chip and `← Board`', async () => {
    const first = mountSection('ticket', 'PAY-12');
    await landed();
    await openChildren();
    await act(async () => {
      fireEvent.click(treeRow('PAY-15'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByRole('button', { name: 'Back to PAY-12' });
    await waitFor(() => expect(issueReads('PAY-15')).toBeGreaterThan(0));
    await flush();
    await openChildren();
    await waitFor(() => treeRow('PAY-16'));
    await act(async () => {
      fireEvent.click(treeRow('PAY-16'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByRole('button', { name: 'Back to PAY-15' });
    expect(storedKey()).toBe('PAY-16');
    first.unmount();
    cleanup();
    render(section(), { wrapper: NoGitlab });
    await landed();
    await waitFor(() => expect(crumbs()).toMatch(/PAY-16$/));
    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
  });
});

/*
  §9 cases 8–16 through the page's frame: the body's shared table, mounted as the page draws it — the GitLab, Jira and sessions answers through their
  contexts, the detail through the frame's own read (`useTicketDetail`). The page's walk is `JiraTicketPage`'s, around the frame, so here the frame's walk
  callbacks are the table's mocks: a Children row reports the child with no lane index (`childrenOf` is always `null` on the page). A landed write is the
  frame's `onWrote` plus its re-read of the detail, as on the modal.
*/
describe('JiraTicketFrame — the ticket body, through the page', () => {
  let current: ResolvedFixture;
  let sent: string[];
  let reads: Record<string, number>;

  beforeEach(() => {
    sent = [];
    reads = {};
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        sent.push(url);
        return ok({ ok: true, reread: true });
      }
      if (url === '/api/agents/status') return ok(current.agents);
      if (url === '/api/jira/worktrees') return ok({ worktrees: [], unavailable: [] });
      if (url.startsWith('/api/jira/issue/')) {
        const key = url.slice('/api/jira/issue/'.length);
        reads[key] = (reads[key] ?? 0) + 1;
        if (key === current.issue.key) return ok(current.detail);
      }
      return pending();
    }) as unknown as typeof fetch;
  });

  interface Frame {
    onOpenIssue: jest.Mock;
    onBack: jest.Mock;
    onReview: jest.Mock;
    onWrote: jest.Mock;
  }
  const frame = (f: ResolvedFixture, cb: Frame) => (
    <SettingsProvider>
      <GitlabContext.Provider value={{ data: f.gitlab, error: null, refresh: () => Promise.resolve(f.gitlab) }}>
        <JiraContext.Provider value={{ data: f.status, loading: false, error: false, reload: jest.fn() }}>
          <JiraSessionsContext.Provider value={{ data: f.sessions, reload: jest.fn(() => Promise.resolve()) }}>
            <JiraTicketFrame
              ticketKey={f.issue.key}
              origin="board"
              back={f.back}
              onOpenIssue={(_from: JiraIssue, to: JiraIssue) => cb.onOpenIssue(to, null)}
              onBack={cb.onBack}
              onLeave={jest.fn()}
              onForget={jest.fn()}
              onWrote={cb.onWrote}
              onRun={jest.fn()}
              onReview={cb.onReview}
            />
          </JiraSessionsContext.Provider>
        </JiraContext.Provider>
      </GitlabContext.Provider>
    </SettingsProvider>
  );
  const settle = async (key: string): Promise<void> => {
    await waitFor(() => expect(reads[key] ?? 0).toBeGreaterThan(0));
    await flush();
  };

  ticketBodyCases(async (f: BodyFixture) => {
    current = resolveFixture(f);
    const cb: Frame = { onOpenIssue: jest.fn(), onBack: jest.fn(), onReview: jest.fn(), onWrote: jest.fn() };
    const view = render(frame(current, cb));
    await settle(current.issue.key);
    return {
      rerender: async (next: BodyFixture) => {
        current = resolveFixture(next);
        view.rerender(frame(current, cb));
        await settle(current.issue.key);
      },
      onOpenIssue: cb.onOpenIssue,
      onBack: cb.onBack,
      onReview: cb.onReview,
      posts: () => [...sent],
      wrote: async () => {
        await waitFor(() => expect(cb.onWrote).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(reads[current.issue.key]).toBe(2));
      }
    };
  });
});

