/**
 * @jest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import JiraView from '../../client/src/components/jira/JiraView';
import { JiraMentionsProvider } from '../../client/src/hooks/JiraMentionsContext';
import { JiraProvider } from '../../client/src/hooks/JiraContext';
import { JiraSessionsProvider } from '../../client/src/hooks/JiraSessionsContext';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { TimeZoneContext } from '../../client/src/hooks/TimeZoneContext';
import { setJiraDetailTab } from '../../client/src/hooks/useJiraDetailTab';
import { setJiraPage } from '../../client/src/hooks/useJiraPage';
import { syncJiraTicket } from '../../client/src/hooks/useJiraTicketKey';
import { JIRA_BOARD_KEY } from '../../client/src/lib/jira';
import { NoGitlab } from '../helpers/no-gitlab';
import { daysAgoStamp } from '../helpers/dates';
import { mention, mentionIssue, mentionsPayload } from '../helpers/mention-stub';
import type { JiraBoardStatus, JiraIssue, JiraMentionsConfigured, JiraStatusPayload } from '../../shared/types';

/*
  The mention modal over the board (Jira mentions <-> board link, Task 5; spec §4) — the real `JiraView` on the Board page, the real mentions provider over a
  mocked `fetch`: the `@ N` mark on a card opens the dialog for ITS ticket, the walk follows the live payload, a Dismiss's answer removes the mark on the same
  render, and the Detail's strip mark swaps the two dialogs rather than stacking them.
*/

const ADA = { accountId: 'acc-ada', name: 'Ada Lovelace' };
function issue(key: string): JiraIssue {
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
    resolved: null
  };
}
const BOARD: JiraBoardStatus = {
  id: 'b_000a1fa0',
  name: 'Alpha board',
  roots: [],
  queries: [],
  interval: '1m',
  polledAt: new Date(Date.now() - 12_000).toISOString(),
  count: 3,
  truncated: false,
  failures: []
};
const STATUS: JiraStatusPayload = {
  configured: true,
  configUnreadable: null,
  site: 'acme.atlassian.net',
  me: ADA,
  tokenKind: 'classic',
  access: 'ok',
  detail: null,
  boards: [BOARD],
  repos: {},
  repoDefaults: {},
  projects: [],
  skills: [],
  calls: { sweep: 0, last429At: null },
  live: {},
  armed: true,
  home: '/home/ada',
  mentions: null
} as JiraStatusPayload;

const M2 = mention('m2', 'Ivo', 'newer question for you', 'PAY-1', 0.1);
const M1 = mention('m1', 'Mara', 'older question', 'PAY-1', 0.2);
const PAY1 = mentionIssue('PAY-1', [M2, M1]);
const PAY4 = mentionIssue('PAY-4', [mention('m9', 'Lukas', 'one more from Lukas', 'PAY-4', 0.3)]);

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response);
let mentionsAnswer: JiraMentionsConfigured;
let mentionsGets: number;
let dismissAnswer: JiraMentionsConfigured | null;

beforeEach(() => {
  localStorage.setItem(JIRA_BOARD_KEY, JSON.stringify({ acme: BOARD.id }));
  window.history.replaceState(null, '', '/');
  act(() => syncJiraTicket('', 'board'));
  setJiraDetailTab('ticket');
  mentionsAnswer = mentionsPayload({ issues: [PAY1, PAY4] });
  mentionsGets = 0;
  dismissAnswer = null;
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/jira') return ok(STATUS);
    if (url.startsWith('/api/jira/sessions')) return ok({ links: [], reachable: true, rowsAt: null });
    if (url === '/api/jira/mentions' && init?.method === undefined) {
      mentionsGets += 1;
      return ok(mentionsAnswer);
    }
    if (url.startsWith('/api/jira/mentions/dismiss') && dismissAnswer !== null) return ok(dismissAnswer);
    if (/^\/api\/jira\/boards\/[^/]+\/issues$/.test(url)) return ok({ issues: ['PAY-1', 'PAY-2', 'PAY-4'].map(issue), polledAt: BOARD.polledAt });
    if (url === '/api/jira/worktrees') return ok({ worktrees: [], unavailable: [] });
    const thread = /^\/api\/jira\/issue\/([^/]+)\/thread$/.exec(url);
    if (thread !== null) {
      const entry = mentionsAnswer.issues.find((i) => i.key === thread[1]);
      const comments = (entry?.mentions ?? []).map((x) => ({ id: x.commentId, author: x.author, created: x.created, markdown: x.excerpt, mine: false, mentionsMe: true, open: true }));
      return ok({ key: thread[1], total: comments.length, truncated: false, comments });
    }
    if (url.startsWith('/api/jira/issue/')) return ok({ ...issue('PAY-1'), description: '', children: [], transitions: [], boards: [], session: null });
    return ok({});
  }) as unknown as typeof fetch;
});
afterEach(cleanup);

async function mount() {
  setJiraPage('board');
  const r = render(
    <TimeZoneContext.Provider value={{ zone: 'UTC', setZone: () => {} } as never}>
      <SettingsProvider>
        <JiraProvider>
          <JiraSessionsProvider open>
            <JiraMentionsProvider enabled>
              <JiraView onOpenJiraPage={jest.fn()} />
            </JiraMentionsProvider>
          </JiraSessionsProvider>
        </JiraProvider>
      </SettingsProvider>
    </TimeZoneContext.Provider>,
    { wrapper: NoGitlab }
  );
  await screen.findByText('Summary of PAY-2');
  await screen.findByRole('button', { name: '2 mentions wait for your answer' });
  return r;
}
const cardOf = (summary: string): HTMLElement => screen.getAllByText(summary).map((e) => e.closest('.board-card')).find((c) => c !== null) as HTMLElement;
const markOf = (summary: string, name: string): HTMLElement => within(cardOf(summary)).getByRole('button', { name });

describe('the mention modal over the board', () => {
  it('opens on the ticket whose mark was pressed, newest first, and walks its mentions', async () => {
    await mount();
    await userEvent.click(markOf('Summary of PAY-1', '2 mentions wait for your answer'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('Mention 1 of 2')).toBeInTheDocument();
    expect(await screen.findByText(/newer question for you/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('Mention 2 of 2')).toBeInTheDocument();
    expect(await screen.findByText(/older question/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(markOf('Summary of PAY-4', '1 mention waits for your answer'));
    expect(screen.getByText('Mention 1 of 1')).toBeInTheDocument();
    expect(await screen.findByText(/one more from Lukas/)).toBeInTheDocument();
  });

  it('a Dismiss removes that ticket’s mark on the same render, keeps the dialog on its Dismissed footer, and re-reads nothing', async () => {
    await mount();
    await userEvent.click(markOf('Summary of PAY-1', '2 mentions wait for your answer'));
    const gets = mentionsGets;
    dismissAnswer = mentionsPayload({ issues: [PAY4], dismissed: [PAY1] });
    await userEvent.click(screen.getByRole('button', { name: /^Dismiss$/ }));
    await screen.findByRole('button', { name: /Undo/ });
    expect(within(cardOf('Summary of PAY-1')).queryByText('@ 2')).toBeNull();
    expect(within(cardOf('Summary of PAY-4')).getByText('@ 1')).toBeInTheDocument();
    expect(screen.queryByText(/Mention \d of \d/)).toBeNull();
    expect(mentionsGets).toBe(gets);
  });

  it('a newer mention arriving mid-walk joins the order and the position recounts', async () => {
    await mount();
    await userEvent.click(markOf('Summary of PAY-1', '2 mentions wait for your answer'));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('Mention 2 of 2')).toBeInTheDocument();
    // The poll answers a third, newest mention: the shown one (m1, the oldest) is now third.
    mentionsAnswer = mentionsPayload({ issues: [mentionIssue('PAY-1', [mention('m3', 'Zed', 'brand new', 'PAY-1', 0.05), M2, M1]), PAY4] });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText('Mention 3 of 3')).toBeInTheDocument();
  });

  it('the Detail strip’s mark swaps the dialogs: exactly one dialog, the mention modal, and Escape leaves none', async () => {
    await mount();
    await userEvent.click(screen.getByText('Summary of PAY-1'));
    const strip = await screen.findByRole('group', { name: 'Summary' });
    await userEvent.click(within(strip).getByText('@ 2'));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    expect(screen.getByText('Mention 1 of 2')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  });

  it('leaving the Board for another Jira page clears the slot', async () => {
    await mount();
    await userEvent.click(markOf('Summary of PAY-1', '2 mentions wait for your answer'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    act(() => setJiraPage('sessions'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
