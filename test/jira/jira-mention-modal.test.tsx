/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraMentionsView } from '../../client/src/components/jira/JiraMentionsView';
import { JiraContext } from '../../client/src/hooks/JiraContext';
import { TimeZoneContext } from '../../client/src/hooks/TimeZoneContext';
import { chipMentions, threadFold } from '../../client/src/lib/jira-mentions';
import type {
  JiraIssueDetail,
  JiraMention,
  JiraMentionIssue,
  JiraMentionsConfigured,
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
  mentions: [mention('201', 'Tomás Reyes', '@Andreja is the 3x retry from your change?', 4, 'PAY-131')]
};
const OPS: JiraMentionIssue = {
  key: 'OPS-9',
  summary: 'Staging DB disk at 85%',
  type: 'Task',
  status: { name: 'Done', category: 'done' },
  boards: [],
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
  'SUP-208': detail(SUP, 'Support', { parent: { key: 'SUP-190', summary: 'Branch settings issues' } }),
  'PAY-131': detail(PAY, 'Payments', { boards: ['7'] }),
  'OPS-9': detail(OPS, 'Operations')
};

const res = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

let fetchMock: jest.Mock;
let answer: JiraMentionsConfigured;
let unreadable: Set<string>;

beforeEach(() => {
  localStorage.clear();
  answer = payload();
  unreadable = new Set();
  fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (url === '/api/jira/mentions' || url === '/api/jira/mentions/sweep') return res(answer);
    if (url === '/api/jira/mentions/dismiss' || url === '/api/jira/mentions/restore') {
      const { key } = JSON.parse(init?.body as string) as { key: string };
      const all = [...answer.issues, ...answer.dismissed];
      const issue = all.find((i) => i.key === key)!;
      const rest = (list: JiraMentionIssue[]) => list.filter((i) => i.key !== key);
      answer =
        url.endsWith('/dismiss')
          ? { ...answer, issues: rest(answer.issues), dismissed: [...rest(answer.dismissed), issue] }
          : { ...answer, issues: [...rest(answer.issues), issue], dismissed: rest(answer.dismissed) };
      return res(answer);
    }
    const thread = /^\/api\/jira\/issue\/([^/]+)\/thread$/.exec(url);
    if (thread !== null) {
      const key = decodeURIComponent(thread[1]);
      return unreadable.has(key) ? res({ error: `${key} is not readable` }, 404) : res(THREADS[key]);
    }
    const issue = /^\/api\/jira\/issue\/([^/]+)$/.exec(url);
    if (issue !== null) return res(DETAILS[decodeURIComponent(issue[1])]);
    return res({}, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderPage() {
  const status = { data: { access: 'ok', configured: true, site: 'acme.atlassian.net' } as JiraStatusPayload, loading: false, error: false, reload: () => {} };
  const zone = { zone: 'UTC', stored: 'UTC', browser: 'UTC', save: () => Promise.resolve(), saveError: null };
  return render(
    <TimeZoneContext.Provider value={zone}>
      <JiraContext.Provider value={status}>
        <JiraMentionsView onOpenJiraPage={() => {}} />
      </JiraContext.Provider>
    </TimeZoneContext.Provider>
  );
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
