/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraMentionsView } from '../../client/src/components/jira/JiraMentionsView';
import { JiraReplyEditor } from '../../client/src/components/jira/JiraReplyEditor';
import { JiraMentionsProvider } from '../../client/src/hooks/JiraMentionsContext';
import { JiraContext } from '../../client/src/hooks/JiraContext';
import { JiraSessionsContext } from '../../client/src/hooks/JiraSessionsContext';
import { TimeZoneContext } from '../../client/src/hooks/TimeZoneContext';
import { chipMentions, threadFold } from '../../client/src/lib/jira-mentions';
import type {
  JiraIssueDetail,
  JiraMention,
  JiraMentionIssue,
  JiraMentionsConfigured,
  JiraSessionsPayload,
  JiraStatusPayload,
  JiraThreadComment,
  JiraThreadPayload
} from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

/*
  The mention modal (Jira mentions phase 1, Task 10; mock `ModalA.dc.html`, spec "The mention modal"). The real page over a mocked `fetch`, so the modal is
  opened the way a reader opens it — a List row's key or excerpt, a card's body — and its prev/next walks the order the page itself draws.

  Task 8's fixture with times: `SUP-208` holds Ivo's mention (3 h ago) and Mara's (5 h ago), `PAY-131` one (4 h ago), so the payload orders `SUP-208` then
  `PAY-131` and the List draws Ivo, Mara, PAY. `OPS-9` is dismissed. Every instant is `daysAgoStamp` of a fraction of a day, relative to the clock the
  assertion runs under (`test/helpers/dates.ts`).
*/

const HOUR_D = 1 / 24;
const hoursAgo = (h: number): string => daysAgoStamp(h * HOUR_D);
const ME = 'Andreja';
const SUP_REPO = '/Users/me/code/timify-backend';
const PAY_REPO = '/Users/me/code/payments';

function mention(commentId: string, name: string, excerpt: string, hours: number, key: string): JiraMention {
  return {
    commentId,
    author: { accountId: `acc-${name}`, name },
    created: hoursAgo(hours),
    excerpt,
    url: `https://acme.atlassian.net/browse/${key}?focusedCommentId=${commentId}`
  };
}

const SUP: JiraMentionIssue = {
  key: 'SUP-208',
  summary: 'Booking widget shows wrong timezone for Lisbon branch',
  type: 'Bug',
  status: { name: 'In Progress', category: 'indeterminate' },
  boards: [],
  draft: null,
  session: null,
  mentions: [
    mention('101', 'Ivo Kranjc', '@Andreja does the BE store it?', 3, 'SUP-208'),
    mention('102', 'Mara Ilić', '@Andreja can you confirm the branch timezone?', 5, 'SUP-208')
  ]
};
const PAY: JiraMentionIssue = {
  key: 'PAY-131',
  summary: 'Refund webhook retries flood the queue',
  type: 'Story',
  status: { name: 'Code Review', category: 'indeterminate' },
  boards: ['Payments Q4'],
  draft: null,
  session: null,
  mentions: [mention('201', 'Tomás Reyes', '@Andreja is the 3x retry from your change?', 4, 'PAY-131')]
};
const OPS: JiraMentionIssue = {
  key: 'OPS-9',
  summary: 'Staging DB disk at 85%',
  type: 'Task',
  status: { name: 'Done', category: 'done' },
  boards: [],
  draft: null,
  session: null,
  mentions: [mention('301', 'Lukas Brandt', '@Andreja cleaning up old snapshots tonight', 6 * 24, 'OPS-9')]
};

function payload(over: Partial<JiraMentionsConfigured> = {}): JiraMentionsConfigured {
  return {
    configured: true,
    polledAt: hoursAgo(1 / 60),
    detail: null,
    truncated: false,
    retryAt: null,
    window: 30,
    me: ME,
    issues: [SUP, PAY],
    dismissed: [OPS],
    ...over
  };
}

function comment(id: string, name: string, hours: number, markdown: string, flags: Partial<Pick<JiraThreadComment, 'mine' | 'mentionsMe' | 'open'>> = {}): JiraThreadComment {
  return {
    id,
    author: { accountId: `acc-${name}`, name },
    created: hoursAgo(hours),
    markdown,
    mine: false,
    mentionsMe: false,
    open: false,
    ...flags
  };
}

const THREADS: Record<string, JiraThreadPayload> = {
  'SUP-208': {
    key: 'SUP-208',
    total: 6,
    truncated: false,
    comments: [
      comment('91', 'Mara Ilić', 96, 'Customer reports Lisbon branch bookings show one hour off.'),
      comment('92', 'Petar Novak', 72, 'Reproduced on staging.'),
      comment('93', ME, 24, 'Looking at it, my guess is the DST table.', { mine: true }),
      comment('102', 'Mara Ilić', 5, '@Andreja can you confirm the branch timezone?', { mentionsMe: true, open: true }),
      comment('101', 'Ivo Kranjc', 3, '@Andreja does the BE store it? cc @Petar Novak', { mentionsMe: true, open: true }),
      comment('95', 'Ines Kovač', 1, '+1, the Porto branch may have the same problem.')
    ]
  },
  'PAY-131': {
    key: 'PAY-131',
    total: 1,
    truncated: false,
    comments: [comment('201', 'Tomás Reyes', 4, '@Andreja is the 3x retry from your change?', { mentionsMe: true, open: true })]
  },
  // Dismissed: the thread route's `open` is false for a dismissed comment (the check's judgement drops dismissed ids).
  'OPS-9': {
    key: 'OPS-9',
    total: 1,
    truncated: false,
    comments: [comment('301', 'Lukas Brandt', 6 * 24, '@Andreja cleaning up old snapshots tonight', { mentionsMe: true })]
  }
};

function detail(issue: JiraMentionIssue, project: string, extra: Partial<JiraIssueDetail> = {}): JiraIssueDetail {
  return {
    key: issue.key,
    id: `id-${issue.key}`,
    url: `https://acme.atlassian.net/browse/${issue.key}`,
    summary: issue.summary,
    project: { key: issue.key.split('-')[0], name: project },
    type: { name: issue.type, level: 0, subtask: false },
    status: issue.status,
    priority: 'High',
    assignee: { accountId: 'acc-petar', name: 'Petar Novak' },
    reporter: 'Mara Ilić',
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: hoursAgo(5 * 24),
    updated: hoursAgo(1),
    resolved: null,
    description: 'Bookings made through the widget for the Lisbon branch show times one hour later.',
    children: [],
    transitions: [],
    boards: [],
    session: null,
    ...extra
  } as JiraIssueDetail;
}

const DETAILS: Record<string, JiraIssueDetail> = {
  'SUP-208': detail(SUP, 'Support', { parent: { key: 'SUP-190', summary: 'Branch settings issues', type: null, status: null } }),
  'PAY-131': detail(PAY, 'Payments', { boards: ['7'] }),
  'OPS-9': detail(OPS, 'Operations')
};

const res = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

let fetchMock: jest.Mock;
let answer: JiraMentionsConfigured;
let unreadable: Set<string>;
// A write the server refuses, by route: the status and the `{ error }` sentence it answers with, the payload untouched.
let refuse: Partial<Record<'dismiss' | 'restore', { status: number; error: string }>>;
// A case's own thread for a key, over `THREADS` — so the shared fixture is never mutated.
let threadOverride: Record<string, JiraThreadPayload>;
// Holds for the next writes, one per write in order: a write whose hold is set answers only once the case releases it (an answer still out).
let holds: Promise<void>[];
// Task 8 — the reply half. The status payload's project → repos map (the Draft session picker), the sessions context's payload (Open session's link), the
// dispatch route's answer and an optional hold on it, and a refusal for the reply route.
let repos: Record<string, string[]>;
let sessions: JiraSessionsPayload | null;
let dispatchAnswer: { status: number; body: unknown };
let dispatchHold: Promise<void> | null;
let replyRefusal: { status: number; error: string } | null;

function hold(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

beforeEach(() => {
  localStorage.clear();
  answer = payload();
  unreadable = new Set();
  refuse = {};
  threadOverride = {};
  holds = [];
  repos = { SUP: [SUP_REPO], PAY: [PAY_REPO] };
  sessions = null;
  dispatchAnswer = { status: 200, body: { assigned: false, transitioned: null, session: { name: 'jira SUP-208', startedAt: hoursAgo(0), repo: SUP_REPO } } };
  dispatchHold = null;
  replyRefusal = null;
  fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (url === '/api/jira/mentions' || url === '/api/jira/mentions/sweep') return res(answer);
    if (url === '/api/agents/dispatch-jira') {
      const send = () => res(dispatchAnswer.body, dispatchAnswer.status);
      return dispatchHold === null ? send() : dispatchHold.then(send);
    }
    if (url === '/api/agents/jira-stop') return res({ ok: true });
    if (url === '/api/agents/jira-open-desktop') return res({ error: 'the dashboard could not hand the session to the desktop app' }, 500);
    if (url === '/api/jira/mentions/draft/discard') {
      const { key } = JSON.parse(init?.body as string) as { key: string };
      answer = { ...answer, issues: answer.issues.map((i) => (i.key === key ? { ...i, draft: null } : i)) };
      return res(answer);
    }
    if (url === '/api/jira/mentions/reply') {
      if (replyRefusal !== null) return res({ error: replyRefusal.error }, replyRefusal.status);
      const { key } = JSON.parse(init?.body as string) as { key: string };
      answer = { ...answer, issues: answer.issues.filter((i) => i.key !== key) };
      return res({ ...answer, posted: { id: '999', url: `https://acme.atlassian.net/browse/${key}?focusedCommentId=999` } });
    }
    if (url === '/api/jira/mentions/dismiss' || url === '/api/jira/mentions/restore') {
      const write = (): Promise<Response> => {
        const refused = refuse[url.endsWith('/dismiss') ? 'dismiss' : 'restore'];
        if (refused !== undefined) return res({ error: refused.error }, refused.status);
        const { key } = JSON.parse(init?.body as string) as { key: string };
        const all = [...answer.issues, ...answer.dismissed];
        const issue = all.find((i) => i.key === key)!;
        const rest = (list: JiraMentionIssue[]) => list.filter((i) => i.key !== key);
        answer =
          url.endsWith('/dismiss')
            ? { ...answer, issues: rest(answer.issues), dismissed: [...rest(answer.dismissed), issue] }
            : { ...answer, issues: [...rest(answer.issues), issue], dismissed: rest(answer.dismissed) };
        return res(answer);
      };
      const held = holds.shift();
      return held === undefined ? write() : held.then(write);
    }
    const thread = /^\/api\/jira\/issue\/([^/]+)\/thread$/.exec(url);
    if (thread !== null) {
      const key = decodeURIComponent(thread[1]);
      return unreadable.has(key) ? res({ error: `${key} is not readable` }, 404) : res(threadOverride[key] ?? THREADS[key]);
    }
    const issue = /^\/api\/jira\/issue\/([^/]+)$/.exec(url);
    if (issue !== null) return res(DETAILS[decodeURIComponent(issue[1])]);
    return res({}, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

// Read on every render, so a case that changes `repos` or `sessions` and calls `rerenderPage()` hands the page the new contexts.
const tree = () => {
  const status = {
    data: { access: 'ok', configured: true, site: 'acme.atlassian.net', repos } as JiraStatusPayload,
    loading: false,
    error: false,
    reload: () => {}
  };
  const zone = { zone: 'UTC', stored: 'UTC', browser: 'UTC', save: () => Promise.resolve(), saveError: null };
  // Inside a `.shell`, as `App.tsx` draws every page: the reply editor portals into it (spec 2026-11-18-jira-reply-markdown, "Where the editor's DOM goes").
  return (
    <div className="shell">
      <TimeZoneContext.Provider value={zone}>
        <JiraContext.Provider value={status}>
          <JiraSessionsContext.Provider value={{ data: sessions, reload: () => Promise.resolve() }}>
            <JiraMentionsProvider enabled>
              <JiraMentionsView onOpenJiraPage={() => {}} />
            </JiraMentionsProvider>
          </JiraSessionsContext.Provider>
        </JiraContext.Provider>
      </TimeZoneContext.Provider>
    </div>
  );
};
let view: ReturnType<typeof render>;
function renderPage() {
  view = render(tree());
  return view;
}
function rerenderPage() {
  view.rerender(tree());
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const gets = (url: string): number => fetchMock.mock.calls.filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === undefined).length;
const posts = (path: string): unknown[] =>
  fetchMock.mock.calls
    .filter(([u, init]) => u === `/api/jira/mentions/${path}` && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
const dialog = (): HTMLElement => screen.getByRole('dialog');
const crumbs = (): string => dialog().querySelector('.jira-detail-crumbs')?.textContent ?? '';
const position = (): string | null => dialog().querySelector('.jira-mention-pos')?.textContent ?? null;
const focused = (): string | null => dialog().querySelector('[data-focused]')?.getAttribute('data-comment-id') ?? null;
const bodyRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tbody tr'));
const NOTE = 'This ticket is on none of your boards, so the board cannot open it.';

async function openList() {
  renderPage();
  await settle();
}

async function openCards(user: ReturnType<typeof userEvent.setup>) {
  renderPage();
  await settle();
  await user.click(screen.getByRole('button', { name: 'Cards' }));
}

const card = (key: string): HTMLElement => document.querySelector<HTMLElement>(`.jira-mentions-card[data-key="${key}"]`)!;

describe('the mention modal — opened from the List', () => {
  it('opens SUP-208’s first row by its key, fetching each route once, and walks the rows in display order', async () => {
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();

    expect(gets('/api/jira/issue/SUP-208/thread')).toBe(1);
    expect(gets('/api/jira/issue/SUP-208')).toBe(1);
    expect(crumbs()).toContain('SUP-208');
    expect(crumbs()).toContain('on none of your boards');
    expect(position()).toBe('Mention 1 of 3');
    expect(focused()).toBe('101');
    expect(within(dialog()).getByRole('heading', { name: SUP.summary })).toBeInTheDocument();
    expect(within(dialog()).getByText(NOTE)).toBeInTheDocument();

    // Mara's mention is the same ticket: the comment refocuses, and nothing is read again.
    await user.click(within(dialog()).getByRole('button', { name: 'Next mention' }));
    await settle();
    expect(position()).toBe('Mention 2 of 3');
    expect(crumbs()).toContain('SUP-208');
    expect(focused()).toBe('102');
    expect(gets('/api/jira/issue/SUP-208/thread')).toBe(1);
    expect(gets('/api/jira/issue/SUP-208')).toBe(1);

    await user.click(within(dialog()).getByRole('button', { name: 'Next mention' }));
    await settle();
    expect(position()).toBe('Mention 3 of 3');
    expect(crumbs()).toContain('PAY-131');
    expect(crumbs()).not.toContain('on none of your boards');
    expect(within(dialog()).queryByText(NOTE)).toBeNull();
    expect(gets('/api/jira/issue/PAY-131/thread')).toBe(1);
    expect(gets('/api/jira/issue/PAY-131')).toBe(1);
    expect(within(dialog()).getByRole('button', { name: 'Next mention' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: 'Previous mention' })).toBeEnabled();
  });

  it('opens from the excerpt too, on that row’s mention', async () => {
    const user = userEvent.setup();
    await openList();
    const mara = bodyRows()[1];
    await user.click(within(mara.querySelector<HTMLElement>('[data-col="comment"]')!).getByRole('button'));
    await settle();
    expect(position()).toBe('Mention 2 of 3');
    expect(focused()).toBe('102');
    expect(within(dialog()).getByRole('button', { name: 'Previous mention' })).toBeEnabled();
  });

  it('a poll under the open modal keeps it on its mention and recounts; a mention that left the order stays shown', async () => {
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
    expect(position()).toBe('Mention 1 of 3');

    answer = payload({ issues: [PAY, SUP] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(crumbs()).toContain('SUP-208');
    expect(focused()).toBe('101');
    expect(position()).toBe('Mention 2 of 3');

    answer = payload({ issues: [PAY] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(crumbs()).toContain('SUP-208');
    expect(position()).toBeNull();
    expect(gets('/api/jira/issue/SUP-208/thread')).toBe(1);
    await user.click(within(dialog()).getByRole('button', { name: 'Previous mention' }));
    await settle();
    expect(crumbs()).toContain('PAY-131');
    expect(position()).toBe('Mention 1 of 1');
  });
});

describe('the mention modal — opened from the Cards', () => {
  it('SUP-208’s card opens as Mention 1 of 2, and next is PAY-131', async () => {
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    expect(position()).toBe('Mention 1 of 2');
    expect(crumbs()).toContain('SUP-208');
    await user.click(within(dialog()).getByRole('button', { name: 'Next mention' }));
    await settle();
    expect(position()).toBe('Mention 2 of 2');
    expect(crumbs()).toContain('PAY-131');
  });

  it('a card’s own buttons do not open it', async () => {
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws the thread: Comments · total, the earlier ones folded, the open ones asking, mine as You, @Name chips', async () => {
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    const d = dialog();

    expect(within(d).getByText('Comments · 6')).toBeInTheDocument();
    expect(d.querySelectorAll('[data-comment-id]')).toHaveLength(4);
    expect(d.querySelector('[data-comment-id="91"]')).toBeNull();
    await user.click(within(d).getByRole('button', { name: 'Show 2 earlier comments' }));
    expect(d.querySelectorAll('[data-comment-id]')).toHaveLength(6);
    expect(d.querySelector('[data-comment-id="91"]')).toHaveTextContent('Customer reports Lisbon branch bookings');

    const ivo = d.querySelector<HTMLElement>('[data-comment-id="101"]')!;
    expect(within(ivo).getByText('Asks you · 3 h ago')).toBeInTheDocument();
    expect(within(d.querySelector<HTMLElement>('[data-comment-id="102"]')!).getByText('Asks you · 5 h ago')).toBeInTheDocument();
    expect(within(d.querySelector<HTMLElement>('[data-comment-id="95"]')!).queryByText(/Asks you/)).toBeNull();
    expect(within(d.querySelector<HTMLElement>('[data-comment-id="93"]')!).getByText('You')).toBeInTheDocument();
    expect(within(ivo).getByText('@Andreja')).toHaveClass('jira-mentions-at');
    expect(within(ivo).getByText('@Petar Novak')).toHaveClass('jira-mentions-at');

    // The ticket column: facts from the fresh detail, its link out, and the board note.
    expect(within(d).getByText('Petar Novak', { selector: 'dd *, dd' })).toBeInTheDocument();
    expect(within(d).getByText('SUP-190 Branch settings issues')).toBeInTheDocument();
    expect(within(d).getByRole('link', { name: 'Open ticket in Jira' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208');
    expect(within(d).getByRole('link', { name: 'Open ticket in Jira' })).toHaveAttribute('rel', 'noreferrer');
  });

  it('Dismiss posts the ticket’s open ids and swaps the footer; Undo restores', async () => {
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    const d = dialog();
    expect(within(d).getByText('You have not commented since this mention.')).toBeInTheDocument();
    const reply = within(d).getByRole('link', { name: 'Reply in Jira' });
    expect(reply).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208?focusedCommentId=101');
    expect(reply).toHaveAttribute('target', '_blank');

    await user.click(within(d).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(posts('dismiss')).toEqual([{ key: 'SUP-208', commentIds: ['101', '102'] }]);
    expect(within(d).getByText('Dismissed. It comes back if someone mentions you on SUP-208 again.')).toBeInTheDocument();
    expect(within(d).queryByText('You have not commented since this mention.')).toBeNull();
    expect(within(d).queryByText(/Asks you/)).toBeNull();
    expect(crumbs()).toContain('SUP-208');

    await user.click(within(d).getByRole('button', { name: 'Undo' }));
    await settle();
    expect(posts('restore')).toEqual([{ key: 'SUP-208' }]);
    expect(within(d).getByText('You have not commented since this mention.')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  // The likeliest refusal: the page's data is one poll stale, and a mention it still lists was answered meanwhile.
  it('a refused Dismiss says why inside the modal, and the footer stays open with Dismiss to press again', async () => {
    refuse.dismiss = { status: 400, error: '101 is not an open mention on SUP-208' };
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    const d = dialog();
    await user.click(within(d).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(within(d).getByRole('alert')).toHaveTextContent('101 is not an open mention on SUP-208');
    expect(within(d).getByText('You have not commented since this mention.')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    expect(within(d).queryByText(/^Dismissed\./)).toBeNull();

    // A retry that lands clears the line.
    delete refuse.dismiss;
    await user.click(within(d).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(within(d).queryByRole('alert')).toBeNull();
    expect(within(d).getByText('Dismissed. It comes back if someone mentions you on SUP-208 again.')).toBeInTheDocument();
  });

  it('a refused Undo says why, and the footer stays dismissed with Undo to press again', async () => {
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    const d = dialog();
    await user.click(within(d).getByRole('button', { name: 'Dismiss' }));
    await settle();
    refuse.restore = { status: 500, error: 'could not save — nothing changed' };
    await user.click(within(d).getByRole('button', { name: 'Undo' }));
    await settle();
    expect(within(d).getByRole('alert')).toHaveTextContent('could not save — nothing changed');
    expect(within(d).getByText('Dismissed. It comes back if someone mentions you on SUP-208 again.')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Undo' })).toBeEnabled();
    expect(within(d).queryByText('You have not commented since this mention.')).toBeNull();
  });

  it('a thread the server cannot read says so inside the modal, which stays open', async () => {
    unreadable.add('SUP-208');
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    expect(within(dialog()).getByText('SUP-208 is not readable')).toBeInTheDocument();
    expect(crumbs()).toContain('SUP-208');
  });

  it('Escape closes it, through the Escape stack', async () => {
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a dismissed OPS-9 (Show dismissed on) opens with Restore and Open in Jira, and Restore brings Dismiss back', async () => {
    const user = userEvent.setup();
    await openCards(user);
    await user.click(screen.getByRole('button', { name: 'Show dismissed · 1' }));
    await user.click(within(card('OPS-9')).getByText(OPS.summary));
    await settle();
    const d = dialog();
    expect(position()).toBe('Mention 3 of 3');
    expect(within(d).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(within(d).getByRole('link', { name: 'Open in Jira' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/OPS-9?focusedCommentId=301');
    expect(within(d).queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(within(d).queryByText(/Asks you/)).toBeNull();

    await user.click(within(d).getByRole('button', { name: 'Restore' }));
    await settle();
    expect(posts('restore')).toEqual([{ key: 'OPS-9' }]);
    expect(within(d).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});

describe('the mention modal — the header’s other promises', () => {
  // Every fixture above focuses a comment AFTER my latest own one; here the focused mention sits inside the fold, so it must open by itself.
  it('opens the fold by itself when the focused mention is inside it', async () => {
    threadOverride['SUP-208'] = {
      key: 'SUP-208',
      total: 4,
      truncated: false,
      comments: [
        comment('91', 'Mara Ilić', 96, 'Customer reports Lisbon branch bookings show one hour off.'),
        comment('101', 'Ivo Kranjc', 3, '@Andreja does the BE store it?', { mentionsMe: true, open: true }),
        comment('93', ME, 2, 'Looking at it.', { mine: true }),
        comment('95', 'Ines Kovač', 1, '+1, the Porto branch may have the same problem.')
      ]
    };
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
    expect(focused()).toBe('101');
    expect(dialog().querySelectorAll('[data-comment-id]')).toHaveLength(4);
    expect(within(dialog()).queryByRole('button', { name: /earlier comment/ })).toBeNull();
  });

  it('says the mention is older than the loaded thread when a truncated thread does not hold it, and keeps the Jira link', async () => {
    threadOverride['SUP-208'] = {
      key: 'SUP-208',
      total: 140,
      truncated: true,
      comments: [comment('95', 'Ines Kovač', 1, '+1, the Porto branch may have the same problem.'), comment('96', 'Petar Novak', 0.5, 'Same here.')]
    };
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
    expect(focused()).toBeNull();
    expect(within(dialog()).getByText('This mention is older than the 2 newest comments loaded here — open it in Jira.')).toHaveClass('jira-detail-none');
    expect(within(dialog()).getByRole('link', { name: 'Reply in Jira' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208?focusedCommentId=101');
  });

  it('says nothing of the kind on a whole thread that lacks the mention', async () => {
    threadOverride['SUP-208'] = { key: 'SUP-208', total: 1, truncated: false, comments: [comment('95', 'Ines Kovač', 1, '+1')] };
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
    expect(within(dialog()).queryByText(/older than the/)).toBeNull();
  });

  it('a ticket gone from both lists under the open modal leaves only the link in the footer', async () => {
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
    answer = payload({ issues: [PAY], dismissed: [OPS] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    const d = dialog();
    expect(crumbs()).toContain('SUP-208');
    expect(within(d).getByRole('link', { name: 'Open in Jira' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208?focusedCommentId=101');
    expect(within(d).queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(within(d).queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(within(d).queryByText('You have not commented since this mention.')).toBeNull();
  });

  it('holds Dismiss, then Undo’s Restore, off while its write is out, so a double click cannot post twice', async () => {
    const dismissHeld = hold();
    const undoHeld = hold();
    holds = [dismissHeld.promise, undoHeld.promise];
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    const d = dialog();
    await user.click(within(d).getByRole('button', { name: 'Dismiss' }));
    expect(within(d).getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    await act(async () => dismissHeld.release());
    await settle();
    await settle();
    await user.click(within(d).getByRole('button', { name: 'Undo' }));
    // The footer answers the click at once (`dismissedHere` off, the page's answer still dismissed), so the write's control is `Restore` until it lands.
    expect(within(d).getByRole('button', { name: 'Restore' })).toBeDisabled();
    await act(async () => undoHeld.release());
    await settle();
    await settle();
    expect(posts('dismiss')).toHaveLength(1);
    expect(posts('restore')).toHaveLength(1);
  });

  // Dismiss on SUP-208, Next to PAY-131 before the post answers: SUP-208's refusal must not become PAY-131's alert, nor re-enable PAY-131's Dismiss
  // while PAY-131's own write is out.
  it('a write that settles after a step to another ticket touches nothing on the ticket now shown', async () => {
    refuse.dismiss = { status: 400, error: '101 is not an open mention on SUP-208' };
    const supHeld = hold();
    const payHeld = hold();
    holds = [supHeld.promise, payHeld.promise];
    const user = userEvent.setup();
    await openCards(user);
    await user.click(within(card('SUP-208')).getByText(SUP.summary));
    await settle();
    const d = dialog();
    await user.click(within(d).getByRole('button', { name: 'Dismiss' }));
    await user.click(within(d).getByRole('button', { name: 'Next mention' }));
    await settle();
    expect(crumbs()).toContain('PAY-131');
    await user.click(within(d).getByRole('button', { name: 'Dismiss' }));
    expect(within(d).getByRole('button', { name: 'Dismiss' })).toBeDisabled();

    await act(async () => supHeld.release());
    await settle();
    expect(within(d).queryByRole('alert')).toBeNull();
    expect(within(d).getByRole('button', { name: 'Dismiss' })).toBeDisabled();

    await act(async () => payHeld.release());
    await settle();
    expect(within(d).getByRole('alert')).toHaveTextContent('101 is not an open mention on SUP-208');
    expect(within(d).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });

  it('reads both routes again when the same ticket is opened a second time — nothing is cached past the modal', async () => {
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
    expect(gets('/api/jira/issue/SUP-208/thread')).toBe(2);
    expect(gets('/api/jira/issue/SUP-208')).toBe(2);
  });
});

describe('the mention modal — Draft a reply (phase 2, Task 8; mock `ModalDraft.dc.html`)', () => {
  /*
    The ticket's draft state is read from the payload (`draftState`: idle, drafting, ready, replacing) and every write goes out through the real lib over the
    mocked `fetch`: `POST /api/agents/dispatch-jira` for Draft a reply and Redraft, `/api/agents/jira-stop` for Stop, `/api/jira/mentions/draft/discard` and
    `/api/jira/mentions/reply`. No case reaches Jira — the routes are this file's fetch mock.
  */
  const draft = (text: string, minutes: number, sessionId = 'sess-1') => ({ text, at: hoursAgo(minutes / 60), sessionId });
  const session = (sessionId: string | null, minutes = 5) => ({ sessionId, startedAt: hoursAgo(minutes / 60), repo: SUP_REPO });
  const withSup = (over: Partial<JiraMentionIssue>): void => {
    answer = payload({ issues: [{ ...SUP, ...over }, PAY] });
  };
  function link(sessionId: string): JiraSessionsPayload['links'][number] {
    return {
      key: 'SUP-208',
      sessionId,
      how: 'reply',
      action: 'reply',
      name: 'jira SUP-208',
      repo: SUP_REPO,
      branch: null,
      surface: 'dashboard',
      model: null,
      effort: null,
      snapshot: { summary: SUP.summary, type: 'Bug', parentKey: null },
      startedAt: hoursAgo(5 / 60),
      endedAt: null,
      endReason: null,
      quietSince: null,
      reattachedAt: null,
      state: 'working',
      row: null,
      stateSince: hoursAgo(5 / 60)
    };
  }
  async function openSup(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openList();
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'SUP-208' }));
    await settle();
  }
  async function poll(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
  }
  const btn = (name: string): HTMLElement => within(dialog()).getByRole('button', { name });
  const queryBtn = (name: string): HTMLElement | null => within(dialog()).queryByRole('button', { name });
  const box = (): HTMLTextAreaElement => within(dialog()).getByRole('textbox', { name: /^Reply to / }) as HTMLTextAreaElement;
  const counter = (): HTMLElement => dialog().querySelector<HTMLElement>('.jira-reply-count')!;
  const dispatched = (): unknown[] =>
    fetchMock.mock.calls.filter(([u]) => u === '/api/agents/dispatch-jira').map(([, init]) => JSON.parse((init as RequestInit).body as string));
  const stops = (): unknown[] =>
    fetchMock.mock.calls.filter(([u]) => u === '/api/agents/jira-stop').map(([, init]) => JSON.parse((init as RequestInit).body as string));
  const SENTENCE = 'The session reads the thread, the ticket and the code, and writes a draft here. It never posts; Post reply does.';

  it('idle: Draft a reply sits beside Dismiss and Reply in Jira, and the Draft session column offers the ticket project’s repo first', async () => {
    const user = userEvent.setup();
    await openSup(user);
    const foot = dialog().querySelector<HTMLElement>('.jira-mention-foot')!;
    expect(within(foot).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    expect(within(foot).getByRole('button', { name: 'Draft a reply' })).toBeEnabled();
    expect(within(foot).getByRole('link', { name: 'Reply in Jira' })).toBeInTheDocument();
    expect(within(dialog()).getByText('Draft session')).toBeInTheDocument();
    const picker = within(dialog()).getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => [o.value, o.textContent])).toEqual([
      [SUP_REPO, 'timify-backend'],
      [PAY_REPO, 'payments']
    ]);
    expect(picker.value).toBe(SUP_REPO);
    expect(within(dialog()).getByText('· read only')).toBeInTheDocument();
    expect(within(dialog()).getByText(SENTENCE)).toBeInTheDocument();
  });

  it('with no repository mapped anywhere, Draft a reply is disabled and says why', async () => {
    repos = {};
    const user = userEvent.setup();
    await openSup(user);
    expect(btn('Draft a reply')).toBeDisabled();
    expect(btn('Draft a reply')).toHaveAttribute('title', 'Map a repository in Jira › Setup first');
  });

  it('Draft a reply dispatches the picked repo once as a narrow reply launch, busy while it is out, then re-reads mentions', async () => {
    const user = userEvent.setup();
    await openSup(user);
    await user.selectOptions(within(dialog()).getByRole('combobox', { name: 'Repository' }), PAY_REPO);
    const gate = hold();
    dispatchHold = gate.promise;
    const before = gets('/api/jira/mentions');
    await user.click(btn('Draft a reply'));
    expect(btn('Draft a reply')).toBeDisabled();
    await user.click(btn('Draft a reply'));
    expect(dispatched()).toHaveLength(1);
    expect(dispatched()[0]).toMatchObject({ key: 'SUP-208', repo: PAY_REPO, action: 'reply', mode: 'none', assign: false, transitionId: null });
    await act(async () => gate.release());
    await settle();
    expect(gets('/api/jira/mentions')).toBeGreaterThan(before);
    expect(btn('Draft a reply')).toBeEnabled();
  });

  it('a refused dispatch prints the server’s sentence under the footer', async () => {
    dispatchAnswer = { status: 409, body: { error: 'a reply is already being drafted for SUP-208' } };
    const user = userEvent.setup();
    await openSup(user);
    await user.click(btn('Draft a reply'));
    await settle();
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('a reply is already being drafted for SUP-208');
  });

  it('drafting: the elapsed time, Open session once the sessions context has the link, and Stop once the session has an id', async () => {
    withSup({ session: session(null, 5) });
    const user = userEvent.setup();
    await openSup(user);
    const run = dialog().querySelector<HTMLElement>('.jira-reply-run')!;
    expect(within(run).getByText('Drafting a reply')).toBeInTheDocument();
    expect(within(run).getByText('5m')).toBeInTheDocument();
    expect(within(run).getByRole('button', { name: 'Open session' })).toBeDisabled();
    expect(within(run).getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(queryBtn('Draft a reply')).toBeNull();
    // The session got its id; the sessions poll has not seen it yet — Stop works, Open session still waits.
    withSup({ session: session('sess-1', 5) });
    await poll();
    expect(within(run).getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(within(run).getByRole('button', { name: 'Open session' })).toBeDisabled();
    sessions = { links: [link('sess-1')], reachable: true, rowsAt: null };
    rerenderPage();
    expect(within(dialog()).getByRole('link', { name: 'Open session' })).toHaveAttribute('href', expect.stringContaining('session=sess-1'));
    await user.click(within(dialog()).getByRole('button', { name: 'Stop' }));
    await settle();
    expect(stops()).toEqual([{ key: 'SUP-208', sessionId: 'sess-1' }]);
  });

  it('ready: the drafted reply, addressed to the newest mention’s author, editable, and Post sends the EDITED text', async () => {
    withSup({ draft: draft('The backend stores it per branch.', 2) });
    const user = userEvent.setup();
    await openSup(user);
    const d = dialog().querySelector<HTMLElement>('.jira-reply')!;
    expect(within(d).getByText('Your reply')).toBeInTheDocument();
    expect(within(d).getByText('drafted by a session 2 m ago · edit before posting')).toBeInTheDocument();
    expect(within(d).getByText('To @Ivo Kranjc')).toBeInTheDocument();
    expect(box().value).toBe('The backend stores it per branch.');
    expect(counter()).toHaveTextContent(`33 / 8000`);
    expect(within(d).getByText('Posts to SUP-208 as you and clears this mention.')).toBeInTheDocument();
    expect(btn('Redraft')).toBeEnabled();
    expect(btn('Discard')).toBeEnabled();
    expect(btn('Post reply')).toBeEnabled();
    // The mock's one bar under the text (ui-verify): the sentence, the counter and all three actions share `.jira-reply-foot` — the buttons are not a
    // second row of their own.
    const foot = d.querySelector<HTMLElement>('.jira-reply-foot')!;
    expect(foot).toContainElement(counter());
    for (const name of ['Redraft', 'Discard', 'Post reply']) expect(foot).toContainElement(btn(name));
    await user.clear(box());
    await user.type(box(), 'Stored per branch; fix is ours.');
    await user.click(btn('Post reply'));
    await settle();
    expect(posts('reply')).toEqual([{ key: 'SUP-208', text: 'Stored per branch; fix is ours.' }]);
  });

  it('Post is refused for whitespace only and past 8 000 characters, where the counter turns into an error', async () => {
    withSup({ draft: draft('x', 2) });
    const user = userEvent.setup();
    await openSup(user);
    fireEvent.change(box(), { target: { value: '   \n  ' } });
    expect(btn('Post reply')).toBeDisabled();
    fireEvent.change(box(), { target: { value: 'a'.repeat(8000) } });
    expect(btn('Post reply')).toBeEnabled();
    expect(counter()).not.toHaveAttribute('data-over');
    fireEvent.change(box(), { target: { value: 'a'.repeat(8001) } });
    expect(btn('Post reply')).toBeDisabled();
    expect(counter()).toHaveAttribute('data-over');
    expect(counter()).toHaveTextContent('8001 / 8000');
  });

  it('ready while the drafting session is still live: editable and postable, but Redraft waits for the session to stop', async () => {
    withSup({ draft: draft('Stored per branch.', 1), session: session('sess-1', 3) });
    const user = userEvent.setup();
    await openSup(user);
    expect(box()).not.toHaveAttribute('readonly');
    expect(btn('Post reply')).toBeEnabled();
    expect(btn('Redraft')).toBeDisabled();
    expect(btn('Redraft')).toHaveAttribute('title', 'Stop the drafting session first');
  });

  it('replacing: the old draft stays with a being-replaced note while a newer session drafts, and Redraft waits', async () => {
    withSup({ draft: draft('Old draft text.', 10, 'sess-1'), session: session('sess-2', 1) });
    const user = userEvent.setup();
    await openSup(user);
    expect(box().value).toBe('Old draft text.');
    expect(within(dialog()).getByText(/being replaced/)).toBeInTheDocument();
    expect(within(dialog()).getByText('Drafting a reply')).toBeInTheDocument();
    expect(btn('Redraft')).toBeDisabled();
    expect(btn('Redraft')).toHaveAttribute('title', 'Stop the drafting session first');
  });

  it('a newer draft replaces untouched text, but never the person’s edits — those get `A newer draft arrived · Use it`', async () => {
    withSup({ draft: draft('First draft.', 5) });
    const user = userEvent.setup();
    await openSup(user);
    withSup({ draft: draft('Second draft.', 1) });
    await poll();
    expect(box().value).toBe('Second draft.');
    expect(within(dialog()).queryByText(/A newer draft arrived/)).toBeNull();

    await user.type(box(), ' Mine.');
    withSup({ draft: draft('Third draft.', 0) });
    await poll();
    expect(box().value).toBe('Second draft. Mine.');
    expect(within(dialog()).getByText(/A newer draft arrived/)).toBeInTheDocument();
    await user.click(btn('Use it'));
    expect(box().value).toBe('Third draft.');
    expect(within(dialog()).queryByText(/A newer draft arrived/)).toBeNull();
  });

  it('Redraft with no live session dispatches again and keeps the draft; Discard posts the key', async () => {
    withSup({ draft: draft('Stored per branch.', 2) });
    const user = userEvent.setup();
    await openSup(user);
    await user.click(btn('Redraft'));
    await settle();
    expect(dispatched()).toHaveLength(1);
    expect(dispatched()[0]).toMatchObject({ key: 'SUP-208', repo: SUP_REPO, action: 'reply' });
    expect(box().value).toBe('Stored per branch.');
    await user.click(btn('Discard'));
    await settle();
    expect(posts('draft/discard')).toEqual([{ key: 'SUP-208' }]);
    expect(within(dialog()).queryByRole('textbox', { name: /^Reply to / })).toBeNull();
    expect(btn('Draft a reply')).toBeEnabled();
  });

  it('Post reply 200: the reply joins the thread as You · just now, the posted line links it, and Next mention walks on', async () => {
    withSup({ draft: draft('Stored per branch.', 2) });
    const user = userEvent.setup();
    await openSup(user);
    await user.click(btn('Post reply'));
    await settle();
    const done = dialog().querySelector<HTMLElement>('.jira-mention-done')!;
    expect(within(done).getByText('Posted to SUP-208. The mention left your list.')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: 'View in Jira' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208?focusedCommentId=999');
    const mine = dialog().querySelector<HTMLElement>('.jira-mention-cm[data-comment-id="999"]')!;
    expect(within(mine).getByText('You')).toBeInTheDocument();
    expect(within(mine).getByText('just now')).toBeInTheDocument();
    expect(mine).toHaveTextContent('@Ivo Kranjc Stored per branch.');
    // Both of the posted line's chips are outline, as the mock draws them: nothing is left to do here, so there is no primary (ui-verify).
    expect(within(done).getByRole('button', { name: 'Next mention' })).toHaveClass('ui-chip-outline');
    await user.click(within(done).getByRole('button', { name: 'Next mention' }));
    await settle();
    expect(crumbs()).toContain('PAY-131');
  });

  it('Post reply 200 of a Markdown reply: the joined comment renders it, the mention in its own paragraph before the heading', async () => {
    withSup({ draft: draft('# Done\n\nok', 2) });
    const user = userEvent.setup();
    await openSup(user);
    await user.click(btn('Post reply'));
    await settle();
    const mine = dialog().querySelector<HTMLElement>('.jira-mention-cm[data-comment-id="999"]')!;
    const heading = within(mine).getByRole('heading', { name: 'Done' });
    const chip = mine.querySelector('.jira-mentions-at')!;
    expect(chip).toHaveTextContent('@Ivo Kranjc');
    expect(chip.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mine).not.toHaveTextContent('# Done');
  });

  it('the last mention’s posted line has no Next mention', async () => {
    answer = payload({ issues: [SUP, { ...PAY, draft: draft('Not from my change.', 2) }] });
    const user = userEvent.setup();
    await openList();
    await user.click(within(bodyRows()[2]).getByRole('button', { name: 'PAY-131' }));
    await settle();
    await user.click(btn('Post reply'));
    await settle();
    const done = dialog().querySelector<HTMLElement>('.jira-mention-done')!;
    expect(within(done).getByText('Posted to PAY-131. The mention left your list.')).toBeInTheDocument();
    expect(within(done).queryByRole('button', { name: 'Next mention' })).toBeNull();
  });

  it('a refused post keeps the text in the box and says the server’s sentence', async () => {
    replyRefusal = { status: 409, error: 'SUP-208 has no open mention — it was answered or dismissed' };
    withSup({ draft: draft('Stored per branch.', 2) });
    const user = userEvent.setup();
    await openSup(user);
    await user.type(box(), ' Edited.');
    await user.click(btn('Post reply'));
    await settle();
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('SUP-208 has no open mention — it was answered or dismissed');
    expect(box().value).toBe('Stored per branch. Edited.');
    expect(dialog().querySelector('.jira-mention-done')).toBeNull();
  });

  it('a newer mention by someone else re-addresses the reply (Review Focus 3)', async () => {
    withSup({ draft: draft('Stored per branch.', 2) });
    const user = userEvent.setup();
    await openSup(user);
    expect(within(dialog()).getByText('To @Ivo Kranjc')).toBeInTheDocument();
    withSup({ draft: draft('Stored per branch.', 2), mentions: [mention('103', 'Nina Horvat', '@Andreja any news?', 0.5, 'SUP-208'), ...SUP.mentions] });
    await poll();
    expect(within(dialog()).getByText('To @Nina Horvat')).toBeInTheDocument();
  });

  it('a session that ends with no draft falls back to the plain open footer (Review Focus 2)', async () => {
    withSup({ session: session('sess-1', 5) });
    const user = userEvent.setup();
    await openSup(user);
    expect(within(dialog()).getByText('Drafting a reply')).toBeInTheDocument();
    withSup({ session: null, draft: null });
    await poll();
    expect(within(dialog()).queryByText('Drafting a reply')).toBeNull();
    expect(btn('Draft a reply')).toBeEnabled();
  });

  it('a refused Desktop hand-over from Open session says the server’s sentence instead of doing nothing (fix round 1)', async () => {
    // The one primary that hands over: an ENDED link with no launch surface, whose dashboard row rests (`openButtons` → desktop, `openTarget` → handover).
    withSup({ draft: draft('Stored per branch.', 2), session: session('sess-1', 3) });
    sessions = {
      links: [{ ...link('sess-1'), surface: null, state: 'ended', endedAt: hoursAgo(1 / 60), row: { id: 'sess-1', status: 'idle', surface: 'dashboard' } }],
      reachable: true,
      rowsAt: null
    };
    const user = userEvent.setup();
    await openSup(user);
    await user.click(btn('Open session'));
    await settle();
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/agents/jira-open-desktop')).toHaveLength(1);
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('the dashboard could not hand the session to the desktop app');
    expect(box().value).toBe('Stored per branch.');
  });

  it('a dismissed ticket offers no Draft a reply until it is restored', async () => {
    const user = userEvent.setup();
    await openList();
    await user.click(screen.getByRole('button', { name: 'Show dismissed · 1' }));
    const ops = bodyRows().find((r) => r.getAttribute('data-key') === 'OPS-9')!;
    await user.click(within(ops).getByRole('button', { name: 'OPS-9' }));
    await settle();
    expect(queryBtn('Draft a reply')).toBeNull();
    expect(within(dialog()).queryByText('Draft session')).toBeNull();
    await user.click(btn('Restore'));
    await settle();
    expect(btn('Draft a reply')).toBeEnabled();
  });

  describe('the reply editor (spec 2026-11-18-jira-reply-markdown, "Draft box and Reply editor")', () => {
    /*
      Open editor in the draft box's footer opens a Write/Preview modal over the mention modal. Two dialogs are mounted at once while it is open, so these
      cases name each one: the mention modal is `SUP-208 mention`, the editor `Reply editor for SUP-208`.
    */
    const mentionDlg = (): HTMLElement => screen.getByRole('dialog', { name: 'SUP-208 mention' });
    const editor = (): HTMLElement => screen.getByRole('dialog', { name: 'Reply editor for SUP-208' });
    const queryEditor = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Reply editor for SUP-208' });
    const area = (): HTMLTextAreaElement => within(editor()).getByRole('textbox', { name: 'Edit reply to Ivo Kranjc' }) as HTMLTextAreaElement;
    const preview = (): HTMLElement => editor().querySelector<HTMLElement>('.ui-modal-body')!;
    const ebtn = (name: string): HTMLElement => within(editor()).getByRole('button', { name });
    async function openEditor(text: string, user: ReturnType<typeof userEvent.setup>): Promise<void> {
      withSup({ draft: draft(text, 2) });
      await openSup(user);
      await user.click(within(mentionDlg()).getByRole('button', { name: 'Open editor' }));
    }

    it('Open editor sits first in the box’s action group and portals the editor into the shell, outside the mention panel', async () => {
      const user = userEvent.setup();
      withSup({ draft: draft('Stored per branch.', 2) });
      await openSup(user);
      const acts = mentionDlg().querySelector<HTMLElement>('.jira-reply-acts')!;
      expect(Array.from(acts.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Open editor', 'Redraft', 'Discard', 'Post reply']);
      await user.click(within(acts).getByRole('button', { name: 'Open editor' }));
      expect(mentionDlg()).not.toContainElement(editor());
      expect(editor().closest('.shell')).not.toBeNull();
      expect(editor()).toHaveClass('ui-modal-split', 'ui-modal-footed', 'ui-modal-over');
      expect(editor()).not.toHaveClass('ui-modal-lead');
      expect(within(editor()).getByText('Reply to SUP-208')).toBeInTheDocument();
      expect(within(editor()).getByText('To @Ivo Kranjc')).toBeInTheDocument();
    });

    it('the editor and the box edit one text, both ways', async () => {
      const user = userEvent.setup();
      await openEditor('Stored per branch.', user);
      expect(area().value).toBe('Stored per branch.');
      await user.type(area(), ' Ours.');
      expect(within(mentionDlg()).getByRole('textbox', { name: 'Reply to Ivo Kranjc' })).toHaveValue('Stored per branch. Ours.');
      fireEvent.change(within(mentionDlg()).getByRole('textbox', { name: 'Reply to Ivo Kranjc' }), { target: { value: 'From the box.' } });
      expect(area().value).toBe('From the box.');
      expect(within(editor()).getByText('13 / 8000')).toBeInTheDocument();
    });

    it('Close closes only the editor and the box keeps the text', async () => {
      const user = userEvent.setup();
      await openEditor('Stored per branch.', user);
      await user.type(area(), ' Kept.');
      await user.click(ebtn('Close'));
      expect(queryEditor()).toBeNull();
      expect(within(mentionDlg()).getByRole('textbox', { name: 'Reply to Ivo Kranjc' })).toHaveValue('Stored per branch. Kept.');
    });

    it('Escape closes only the editor, the mention modal stays', async () => {
      const user = userEvent.setup();
      await openEditor('Stored per branch.', user);
      await user.keyboard('{Escape}');
      expect(queryEditor()).toBeNull();
      expect(mentionDlg()).toBeInTheDocument();
    });

    it('a click on the editor’s scrim closes only the editor', async () => {
      const user = userEvent.setup();
      await openEditor('Stored per branch.', user);
      await user.click(document.querySelector<HTMLElement>('.ui-modal-scrim.ui-modal-over')!);
      expect(queryEditor()).toBeNull();
      expect(mentionDlg()).toBeInTheDocument();
    });

    it('the preview reads GFM: intraword underscores and spaced stars stay text, and `1)` is an ordered list', async () => {
      const user = userEvent.setup();
      await openEditor('snake_case_name and 2 * 3 * 4\n\n1) first', user);
      expect(preview().querySelector('em, strong')).toBeNull();
      expect(preview()).toHaveTextContent('snake_case_name and 2 * 3 * 4');
      expect(preview().querySelector('ol li')).toHaveTextContent('first');
    });

    it('the preview puts the mention in its own paragraph before a heading, and a single newline is a line break', async () => {
      const user = userEvent.setup();
      await openEditor('# H\n\n- a', user);
      const heading = within(preview()).getByRole('heading', { level: 1, name: 'H' });
      expect(preview().querySelector('li')).toHaveTextContent('a');
      const chip = preview().querySelector('.jira-mentions-at')!;
      expect(chip).toHaveTextContent('@Ivo Kranjc');
      expect(chip.closest('p')).not.toBeNull();
      expect(chip.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.change(area(), { target: { value: 'a\nb' } });
      expect(preview().querySelector('br')).not.toBeNull();
    });

    it('blank text previews as one muted line and Post is disabled; past 8 000 characters Post is disabled too', async () => {
      const user = userEvent.setup();
      await openEditor('x', user);
      fireEvent.change(area(), { target: { value: '  \n ' } });
      expect(within(editor()).getByText('Nothing to preview yet.')).toBeInTheDocument();
      expect(ebtn('Post reply')).toBeDisabled();
      fireEvent.change(area(), { target: { value: 'a'.repeat(8000) } });
      expect(ebtn('Post reply')).toBeEnabled();
      fireEvent.change(area(), { target: { value: 'a'.repeat(8001) } });
      expect(ebtn('Post reply')).toBeDisabled();
      expect(within(editor()).getByText('8001 / 8000')).toBeInTheDocument();
    });

    it('Post reply is disabled while the post is out', async () => {
      const user = userEvent.setup();
      await openEditor('Stored per branch.', user);
      // Hold the reply route's answer: the post is out until the case releases it.
      const held = hold();
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: RequestInit) =>
        url === '/api/jira/mentions/reply' ? held.promise.then(() => base(url, init)) : base(url, init)
      );
      expect(ebtn('Post reply')).toBeEnabled();
      fireEvent.click(ebtn('Post reply'));
      await settle();
      expect(ebtn('Post reply')).toBeDisabled();
      held.release();
      await settle();
      expect(posts('reply')).toHaveLength(1);
    });

    it('Post reply sends the text once and closes the editor on success', async () => {
      const user = userEvent.setup();
      await openEditor('Stored per branch.', user);
      await user.type(area(), ' Ours.');
      await user.click(ebtn('Post reply'));
      await settle();
      expect(posts('reply')).toEqual([{ key: 'SUP-208', text: 'Stored per branch. Ours.' }]);
      expect(queryEditor()).toBeNull();
    });

    it('a refused post keeps the editor open with the server’s sentence in its foot', async () => {
      replyRefusal = { status: 409, error: 'SUP-208 has no open mention — it was answered or dismissed' };
      const user = userEvent.setup();
      await openEditor('Stored per branch.', user);
      await user.click(ebtn('Post reply'));
      await settle();
      const foot = editor().querySelector<HTMLElement>('.ui-modal-foot')!;
      expect(within(foot).getByRole('alert')).toHaveTextContent('SUP-208 has no open mention — it was answered or dismissed');
      expect(area().value).toBe('Stored per branch.');
    });

    it('a newer draft shows `A newer draft arrived · Use it` atop the Write column, and Use it swaps the text in both places', async () => {
      const user = userEvent.setup();
      await openEditor('First draft.', user);
      await user.type(area(), ' Mine.');
      withSup({ draft: draft('Second draft.', 0) });
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await settle();
      const write = editor().querySelector<HTMLElement>('.ui-modal-facts')!;
      expect(within(write).getByText(/A newer draft arrived/)).toBeInTheDocument();
      await user.click(within(write).getByRole('button', { name: 'Use it' }));
      expect(area().value).toBe('Second draft.');
      expect(within(mentionDlg()).getByRole('textbox', { name: 'Reply to Ivo Kranjc' })).toHaveValue('Second draft.');
      expect(within(editor()).queryByText(/A newer draft arrived/)).toBeNull();
    });

    it('with no author to address, the head has no To line and the textarea is named for the ticket', () => {
      render(
        <div className="shell">
          <JiraReplyEditor
            issueKey="SUP-208"
            to={null}
            text="Plain."
            onText={() => {}}
            busy={false}
            newer={false}
            onUseNewer={() => {}}
            error={null}
            onPost={() => {}}
            onClose={() => {}}
          />
        </div>
      );
      expect(screen.queryByText(/^To @/)).toBeNull();
      expect(within(editor()).getByRole('textbox', { name: 'Edit reply to SUP-208' })).toHaveValue('Plain.');
      expect(preview().querySelector('.jira-mentions-at')).toBeNull();
      expect(preview()).toHaveTextContent('Plain.');
    });
  });
});

describe('the modal’s pure parts', () => {
  it('threadFold counts the comments before my latest own one, none when I never commented', () => {
    expect(threadFold(THREADS['SUP-208'].comments)).toBe(2);
    expect(threadFold(THREADS['PAY-131'].comments)).toBe(0);
    expect(threadFold([])).toBe(0);
  });

  it('chipMentions wraps a known @Name in text, longest name first, never inside code or mid-word', () => {
    const names = ['Mara', 'Mara Ilić', ME];
    expect(chipMentions('<p>@Mara Ilić and @Andreja</p>', names)).toBe(
      '<p><span class="jira-mentions-at">@Mara Ilić</span> and <span class="jira-mentions-at">@Andreja</span></p>'
    );
    expect(chipMentions('<p><code>@Andreja</code> @Andrejas</p>', names)).toBe('<p><code>@Andreja</code> @Andrejas</p>');
    expect(chipMentions('<p>@O&#39;Brien</p>', ["O'Brien"])).toBe('<p><span class="jira-mentions-at">@O&#39;Brien</span></p>');
    expect(chipMentions('<p>@Andreja</p>', [])).toBe('<p>@Andreja</p>');
  });
});
