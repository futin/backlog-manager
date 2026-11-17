/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraMentionsView } from '../../client/src/components/jira/JiraMentionsView';
import { JiraContext } from '../../client/src/hooks/JiraContext';
import { TimeZoneContext } from '../../client/src/hooks/TimeZoneContext';
import type { JiraAccess, JiraMention, JiraMentionIssue, JiraMentionsPayload, JiraStatusPayload } from '../../shared/types';

/*
  Jira › Mentions, List view (Jira mentions phase 1, Task 8; mock `Main.dc.html`, band states `Sync.dc.html`). The real page over a mocked `fetch`, inside the
  two contexts it reads: the shell's Jira status (for `access`) and the board's time zone, pinned to UTC so a wait end reads one clock. Every instant is
  relative to the real clock the assertion runs under (`test/helpers/dates.ts`' rule): `created` and `polledAt` are "N ago", and the 14:32 wait end is the
  NEXT 14:32 UTC after now, so it is in the future on any day the suite runs.
*/

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * The next 14:32 UTC at least a minute after now — a wait end that is always in the future and always prints `14:32` in UTC. The minute is margin: a 14:32
 * only milliseconds ahead would already be past by the time `mentionsWait` reads it, and the case would go red for a suite run just before 14:32.
 */
function next1432(): string {
  const d = new Date();
  d.setUTCHours(14, 32, 0, 0);
  if (d.getTime() <= Date.now() + MIN) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function mention(commentId: string, name: string, excerpt: string, agoMs: number, key: string): JiraMention {
  return {
    commentId,
    author: { accountId: `acc-${name}`, name },
    created: ago(agoMs),
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
    mention('101', 'Mara Ilić', 'ask @Andreja about it', 2 * HOUR, 'SUP-208'),
    mention('102', 'Tomás Reyes', 'is the branch zone stored or derived?', 5 * HOUR, 'SUP-208')
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
  mentions: [mention('201', 'Tomás Reyes', 'is the 3x retry from your change last sprint?', 26 * HOUR, 'PAY-131')]
};
const OPS: JiraMentionIssue = {
  key: 'OPS-9',
  summary: 'Staging DB disk at 85%',
  type: 'Task',
  status: { name: 'Done', category: 'done' },
  boards: [],
  draft: null,
  session: null,
  mentions: [mention('301', 'Lukas Brandt', 'cleaning up old snapshots tonight', 6 * 24 * HOUR, 'OPS-9')]
};

function payload(over: Partial<Extract<JiraMentionsPayload, { configured: true }>> = {}): JiraMentionsPayload {
  return {
    configured: true,
    polledAt: ago(MIN + 5_000),
    detail: null,
    truncated: false,
    retryAt: null,
    window: 30,
    me: 'Andreja',
    issues: [SUP, PAY],
    dismissed: [OPS],
    ...over
  };
}

const res = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

let fetchMock: jest.Mock;
let answer: JiraMentionsPayload;
const onOpenJiraPage = jest.fn();

function renderPage(access: JiraAccess = 'ok') {
  const status = { data: { access, configured: true, site: 'acme.atlassian.net' } as JiraStatusPayload, loading: false, error: false, reload: () => {} };
  const zone = { zone: 'UTC', stored: 'UTC', browser: 'UTC', save: () => Promise.resolve(), saveError: null };
  return render(
    <TimeZoneContext.Provider value={zone}>
      <JiraContext.Provider value={status}>
        <JiraMentionsView onOpenJiraPage={onOpenJiraPage} />
      </JiraContext.Provider>
    </TimeZoneContext.Provider>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const sub = (): string => document.querySelector('.ui-band-sub')?.textContent ?? '';
const bodyRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tbody tr'));
const rowKeys = (): string[] => bodyRows().map((r) => r.getAttribute('data-key') ?? '');
const posts = (path: string): unknown[] =>
  fetchMock.mock.calls.filter(([u, init]) => u === `/api/jira/mentions/${path}` && (init as RequestInit | undefined)?.method === 'POST').map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  localStorage.clear();
  onOpenJiraPage.mockReset();
  answer = payload();
  fetchMock = jest.fn((url: string) => (url === '/api/jira/mentions' || url.startsWith('/api/jira/mentions/') ? res(answer) : res({}, 404)));
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('Jira › Mentions — the List view', () => {
  it('says how many wait, the window and the check age; a truncated check ends on the cap', async () => {
    const { unmount } = renderPage();
    await settle();
    expect(sub()).toBe('3 waiting · last 30 days · checked 1 min ago');
    unmount();

    answer = payload({ truncated: true });
    renderPage();
    await settle();
    expect(sub().endsWith(' · newest 100 tickets checked')).toBe(true);
  });

  it('draws one row per mention, the boards (muted none) and the user’s own @ as a chip in place', async () => {
    renderPage();
    await settle();
    expect(rowKeys()).toEqual(['SUP-208', 'SUP-208', 'PAY-131']);
    const [mara, , pay] = bodyRows();
    const boardsOf = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('[data-col="boards"]')!;
    expect(boardsOf(mara)).toHaveTextContent('none');
    expect(boardsOf(mara)).toHaveClass('jira-issues-muted');
    expect(boardsOf(pay)).toHaveTextContent('Payments Q4');
    expect(boardsOf(pay)).not.toHaveClass('jira-issues-muted');
    const comment = mara.querySelector<HTMLElement>('[data-col="comment"]')!;
    expect(comment).toHaveAttribute('title', 'ask @Andreja about it');
    expect(comment).toHaveTextContent('ask @Andreja about it');
    const chip = within(comment).getByText('@Andreja');
    expect(chip).toHaveClass('jira-mentions-at');
    expect(within(mara).getByText('Mara Ilić')).toBeInTheDocument();
    expect(within(mara).getByRole('link', { name: 'Open in Jira' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208?focusedCommentId=101');
  });

  it('the search keeps only the rows whose author, key, summary or excerpt match, case-insensitively', async () => {
    const user = userEvent.setup();
    renderPage();
    await settle();
    await user.type(screen.getByRole('searchbox', { name: 'Search mentions' }), 'mara');
    expect(bodyRows()).toHaveLength(1);
    expect(within(bodyRows()[0]).getByText('Mara Ilić')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search mentions' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search mentions' }), 'pay-131');
    expect(rowKeys()).toEqual(['PAY-131']);
  });

  it('Show dismissed · 1 draws the dismissed ticket dimmed with Restore, and Restore posts its key', async () => {
    const user = userEvent.setup();
    renderPage();
    await settle();
    expect(rowKeys()).not.toContain('OPS-9');
    await user.click(screen.getByRole('button', { name: 'Show dismissed · 1' }));
    const ops = bodyRows().find((r) => r.getAttribute('data-key') === 'OPS-9')!;
    expect(ops).toHaveAttribute('data-dismissed');
    expect(within(ops).queryByRole('button', { name: 'Dismiss' })).toBeNull();
    await user.click(within(ops).getByRole('button', { name: 'Restore' }));
    await settle();
    expect(posts('restore')).toEqual([{ key: 'OPS-9' }]);
    // The pick is a per-viewer convenience, remembered (spec "The page") — the value the click chose, not merely some value.
    expect(JSON.parse(localStorage.getItem('backlog-manager.jira-mentions-dismissed') ?? 'null')).toBe('shown');
  });

  it('Dismiss on a ticket posts every open mention id on it', async () => {
    const user = userEvent.setup();
    renderPage();
    await settle();
    await user.click(within(bodyRows()[1]).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(posts('dismiss')).toEqual([{ key: 'SUP-208', commentIds: ['101', '102'] }]);
  });

  it('before the first check: `checking…`, the chip disabled, and never "Nothing waiting"', async () => {
    answer = payload({ polledAt: null, issues: [], dismissed: [] });
    renderPage();
    await settle();
    expect(sub()).toBe('checking…');
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });

  it('a healthy empty answer says nothing waits; an unconfigured one points at Setup like the other pages', async () => {
    const user = userEvent.setup();
    answer = payload({ issues: [], dismissed: [] });
    const { unmount } = renderPage();
    await settle();
    expect(screen.getByText('Nothing waiting on you in the last 30 days.')).toBeInTheDocument();
    unmount();

    answer = { configured: false, detail: 'JIRA_SITE is not set' };
    renderPage();
    await settle();
    await user.click(screen.getByRole('button', { name: 'Open Setup' }));
    expect(onOpenJiraPage).toHaveBeenCalledWith('setup');
  });

  it('failed band keeps rows: a check that failed after a good one draws the rows and the reason in red', async () => {
    answer = payload({ detail: 'Jira answered 503' });
    renderPage();
    await settle();
    expect(rowKeys()).toEqual(['SUP-208', 'SUP-208', 'PAY-131']);
    const red = within(document.querySelector<HTMLElement>('.ui-band-sub')!).getByText('Jira answered 503');
    expect(red).toHaveClass('failing');
    expect(sub()).toBe('3 waiting · last 30 days · checked 1 min ago · Jira answered 503');
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });

  it('no check can run: the access sentence before a first check, and the 429 wait end in the sub-line and the chip’s tooltip', async () => {
    answer = payload({ polledAt: null, issues: [], dismissed: [] });
    const { unmount } = renderPage('unauthorized');
    await settle();
    expect(sub()).toBe('Jira rejected the credentials');
    expect(sub()).not.toContain('checking…');
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    unmount();

    answer = payload({ retryAt: next1432() });
    renderPage();
    await settle();
    expect(sub()).toBe('3 waiting · last 30 days · checked 1 min ago · Jira asked to wait until 14:32');
    const chip = screen.getByRole('button', { name: 'Sync now' });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'Jira asked to wait until 14:32');
  });

  it('a search that matches no row says so, rather than the healthy-empty line', async () => {
    const user = userEvent.setup();
    renderPage();
    await settle();
    await user.type(screen.getByRole('searchbox', { name: 'Search mentions' }), 'no such text');
    expect(bodyRows()).toHaveLength(0);
    expect(screen.getByText('No mentions match')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });

  it('every read failing reads Mentions unavailable, never an empty list', async () => {
    fetchMock.mockImplementation(() => res({ error: 'boom' }, 500));
    const { unmount } = renderPage();
    await settle();
    expect(screen.getByText('Mentions unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
    unmount();
  });

  it('a refused Dismiss lands in the band’s red beside the rows it left', async () => {
    const user = userEvent.setup();
    renderPage();
    await settle();
    fetchMock.mockImplementation((url: string) =>
      url === '/api/jira/mentions/dismiss' ? res({ error: '101 is not an open mention on SUP-208' }, 400) : res(answer)
    );
    await user.click(within(bodyRows()[0]).getByRole('button', { name: 'Dismiss' }));
    await settle();
    const red = within(document.querySelector<HTMLElement>('.ui-band-sub')!).getByText('101 is not an open mention on SUP-208');
    expect(red).toHaveClass('failing');
    expect(rowKeys()).toEqual(['SUP-208', 'SUP-208', 'PAY-131']);
  });

  it('Sync now checks mentions only; the List | Cards pick is remembered', async () => {
    const user = userEvent.setup();
    renderPage();
    await settle();
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    await settle();
    expect(posts('sweep')).toEqual([{}]);
    // "Only": no other write went out beside it — the site-wide `/api/jira/sweep` is the pill's Sync now, not this page's (spec "Sync now, two ways").
    const allPosts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([u]) => u);
    expect(allPosts).toEqual(['/api/jira/mentions/sweep']);
    await user.click(screen.getByRole('button', { name: 'Cards' }));
    expect(JSON.parse(localStorage.getItem('backlog-manager.jira-mentions-view') ?? 'null')).toBe('cards');
    expect(document.querySelector('tbody')).toBeNull();
  });
});

describe('Jira › Mentions — the Cards view', () => {
  const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.jira-mentions-card'));
  const card = (key: string): HTMLElement => cards().find((c) => c.getAttribute('data-key') === key) as HTMLElement;

  async function openCards() {
    const user = userEvent.setup();
    renderPage();
    await settle();
    await user.click(screen.getByRole('button', { name: 'Cards' }));
    return user;
  }

  it('draws one card per ticket, the newest mention quoted with +1 earlier mention, and the sub-line counts tickets', async () => {
    await openCards();
    expect(cards().map((c) => c.getAttribute('data-key'))).toEqual(['SUP-208', 'PAY-131']);
    expect(document.querySelector('tbody')).toBeNull();
    const sup = within(card('SUP-208'));
    expect(sup.getByText('Mara Ilić asked you · 2 h ago')).toBeInTheDocument();
    expect(card('SUP-208').querySelector('.jira-mentions-at')?.textContent).toBe('@Andreja');
    expect(card('SUP-208').textContent).not.toContain('is the branch zone stored or derived?');
    expect(sup.getByText('+1 earlier mention')).toBeInTheDocument();
    expect(within(card('PAY-131')).queryByText(/earlier/)).toBeNull();
    expect(sup.getByText('on none of your boards')).toBeInTheDocument();
    expect(within(card('PAY-131')).getByText('on Payments Q4')).toBeInTheDocument();
    expect(sub()).toBe('2 tickets waiting · last 30 days · checked 1 min ago');
  });

  it('pluralises earlier mentions and says 1 ticket waiting for one ticket', async () => {
    answer = payload({ issues: [{ ...SUP, mentions: [...SUP.mentions, mention('103', 'Ines Kovač', 'third', 9 * HOUR, 'SUP-208')] }], dismissed: [] });
    await openCards();
    expect(within(card('SUP-208')).getByText('+2 earlier mentions')).toBeInTheDocument();
    expect(sub()).toBe('1 ticket waiting · last 30 days · checked 1 min ago');
  });

  it('Reply in Jira links the newest comment in a new tab; Dismiss posts every id on the ticket', async () => {
    const user = await openCards();
    const link = within(card('SUP-208')).getByRole('link', { name: 'Reply in Jira' });
    expect(link).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208?focusedCommentId=101');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    await user.click(within(card('SUP-208')).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(posts('dismiss')).toEqual([{ key: 'SUP-208', commentIds: ['101', '102'] }]);
  });

  it('a dismissed ticket is a dimmed card with Restore under Show dismissed', async () => {
    const user = await openCards();
    await user.click(screen.getByRole('button', { name: 'Show dismissed · 1' }));
    expect(cards().map((c) => c.getAttribute('data-key'))).toEqual(['SUP-208', 'PAY-131', 'OPS-9']);
    expect(card('OPS-9')).toHaveAttribute('data-dismissed');
    await user.click(within(card('OPS-9')).getByRole('button', { name: 'Restore' }));
    await settle();
    expect(posts('restore')).toEqual([{ key: 'OPS-9' }]);
  });

  it('quotes the newest mention by `created`, whatever order the payload lists them in', async () => {
    answer = payload({ issues: [{ ...SUP, mentions: [...SUP.mentions].reverse() }, PAY] });
    await openCards();
    expect(within(card('SUP-208')).getByText('Mara Ilić asked you · 2 h ago')).toBeInTheDocument();
    expect(within(card('SUP-208')).getByText('+1 earlier mention')).toBeInTheDocument();
    expect(within(card('SUP-208')).getByRole('link', { name: 'Reply in Jira' })).toHaveAttribute('href', 'https://acme.atlassian.net/browse/SUP-208?focusedCommentId=101');
  });

  it('a search that matches only the older comment still shows the ticket, quoting the newer mention', async () => {
    const user = await openCards();
    await user.type(screen.getByRole('searchbox', { name: 'Search mentions' }), 'derived');
    expect(cards().map((c) => c.getAttribute('data-key'))).toEqual(['SUP-208']);
    expect(within(card('SUP-208')).getByText('Mara Ilić asked you · 2 h ago')).toBeInTheDocument();
    expect(within(card('SUP-208')).getByText('+1 earlier mention')).toBeInTheDocument();
    expect(within(card('SUP-208')).getByRole('link', { name: 'Reply in Jira' })).toHaveAttribute('href', expect.stringContaining('focusedCommentId=101'));
  });

  it('the Cards pick survives a remount', async () => {
    await openCards();
    document.body.innerHTML = '';
    renderPage();
    await settle();
    expect(cards()).toHaveLength(2);
  });
});

describe('Jira › Mentions — the Draft ready marker (phase 2, Task 8)', () => {
  // A ticket whose reply draft waits (`draft !== null`) says so on its List row and its card, so the reader can find the draft again after closing the
  // modal; a ticket without one says nothing. The marker sits in the Summary cell (List) and the card's foot (Cards) — the slots `Main.dc.html` and
  // `ListB.dc.html` leave beside the ticket's own words.
  const DRAFT = { text: 'The backend stores it per branch.', at: ago(2 * MIN), sessionId: 'sess-1' };
  const marker = (el: Element): Element | null => Array.from(el.querySelectorAll('.ui-pill')).find((p) => p.textContent === 'Draft ready') ?? null;

  it('marks every List row of the ticket with a draft, and no other row', async () => {
    answer = payload({ issues: [{ ...SUP, draft: DRAFT }, PAY] });
    renderPage();
    await settle();
    const [mara, tomas, pay] = bodyRows();
    expect(marker(mara)).not.toBeNull();
    expect(marker(tomas)).not.toBeNull();
    expect(marker(pay)).toBeNull();
    // Held at its own width by a page-class wrapper (`flex: none`): bare in the Summary cell's flex row, a long summary squeezed it to "Draft read" (ui-verify).
    expect(marker(mara)!.parentElement).toHaveClass('jira-mentions-marker');
  });

  it('marks the ticket’s card, and no other card', async () => {
    answer = payload({ issues: [{ ...SUP, draft: DRAFT }, PAY] });
    const user = userEvent.setup();
    renderPage();
    await settle();
    await user.click(screen.getByRole('button', { name: 'Cards' }));
    const card = (key: string): HTMLElement => document.querySelector<HTMLElement>(`.jira-mentions-card[data-key="${key}"]`)!;
    expect(marker(card('SUP-208'))).not.toBeNull();
    expect(marker(card('SUP-208'))!.parentElement).toHaveClass('jira-mentions-marker');
    expect(marker(card('PAY-131'))).toBeNull();
  });

  it('draws no marker anywhere while no ticket holds a draft', async () => {
    renderPage();
    await settle();
    expect(screen.queryByText('Draft ready')).toBeNull();
  });
});
