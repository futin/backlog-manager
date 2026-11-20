/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { App } from '../../client/src/App';
import { setJiraPage } from '../../client/src/hooks/useJiraPage';
import { JIRA_TICKET_KEY_KEY, getJiraTicket, syncJiraTicket } from '../../client/src/hooks/useJiraTicketKey';
import { JIRA_PAGE_KEY } from '../../client/src/lib/jira-page';
import { RUNS_MODE_KEY } from '../../client/src/lib/runs-mode';
import { SETTINGS_STORAGE_KEY } from '../../client/src/lib/settings';
import { AGENTS_ON, ISSUE, detail, status } from '../helpers/ticket-body-cases';
import type { JiraStatusPayload } from '../../shared/types';

/*
  The shell opening on a deep link (`lib/deep-link.ts`): the URL's section wins over the stored section and a pinned landing, the Runs page follows it, both
  are recorded as a click would record them, and the parameters leave the address bar so a reload inside the app does not jump back.

  Board and Runs are stubbed, as `jira-sections.test.tsx` stubs its views: the subject is which section and which Runs page the shell picks. The Runs stub
  reads the real `useRunsMode`, so it shows the page the real view would.
*/
jest.mock('../../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../../client/src/components/runs/RunsView', () => ({
  __esModule: true,
  default: function RunsStub() {
    const [mode] = require('../../client/src/hooks/useRunsMode').useRunsMode();
    return require('react').createElement('div', null, `runs stub: ${mode}`);
  }
}));

const SECTION_KEY = 'backlog-manager.section';
const stored = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  // A real section, so it is held and drawn while the projects answer — which this suite never gives — is unknown.
  localStorage.setItem(SECTION_KEY, JSON.stringify('github'));
  localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('watchdog'));
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as Response)) as unknown as typeof fetch;
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  // The key store is a module value that outlives a mount: a ticket one case opened must not be on screen in the next.
  syncJiraTicket('', 'board');
});

describe('a deep link', () => {
  it('opens Runs › History over a stored GitHub and a stored Watchdog, records both, and leaves the address bar', async () => {
    window.history.replaceState(null, '', '/?section=runs&runs=history');
    render(<App />);
    expect(await screen.findByText('runs stub: runs')).toBeInTheDocument();
    expect(stored(SECTION_KEY)).toBe('runs');
    expect(stored(RUNS_MODE_KEY)).toBe('runs');
    expect(window.location.search).toBe('');
  });

  it('wins over a pinned landing', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'github' }));
    window.history.replaceState(null, '', '/?section=runs&runs=history');
    render(<App />);
    expect(await screen.findByText('runs stub: runs')).toBeInTheDocument();
  });

  it('applies a Settings scope through the settings the rail writes, and only beside the Settings section', async () => {
    window.history.replaceState(null, '', '/?section=settings&settings=shared');
    const first = render(<App />);
    await waitFor(() => expect((stored(SETTINGS_STORAGE_KEY) as { settingsScope?: string } | null)?.settingsScope).toBe('shared'));
    expect(window.location.search).toBe('');
    first.unmount();

    localStorage.clear();
    window.history.replaceState(null, '', '/?section=runs&settings=shared');
    render(<App />);
    expect(await screen.findByText('runs stub: runs')).toBeInTheDocument();
    expect((stored(SETTINGS_STORAGE_KEY) as { settingsScope?: string } | null)?.settingsScope ?? 'local').toBe('local');
  });

  it('applies the Dashboards scope the same way, so the Run on card’s Settings link lands on the machines page', async () => {
    window.history.replaceState(null, '', '/?section=settings&settings=dashboards');
    render(<App />);
    await waitFor(() => expect((stored(SETTINGS_STORAGE_KEY) as { settingsScope?: string } | null)?.settingsScope).toBe('dashboards'));
    expect(window.location.search).toBe('');
  });

  it('opens nothing special for an unknown section', async () => {
    window.history.replaceState(null, '', '/?section=nope');
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(stored(RUNS_MODE_KEY)).toBe('watchdog');
  });

  // The root Board the source rows replaced (source-sections spec): `?section=board` is not a section any more, so the load is a plain one — the stored
  // GitHub opens, and the parameter is left alone like any other the app does not read.
  it('ignores ?section=board, opening the app as a plain load would', async () => {
    window.history.replaceState(null, '', '/?section=board');
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(stored(SECTION_KEY)).toBe('github');
  });
});

/*
  The Jira ticket page's address (Jira ticket URL spec, "Deep link on load"): `?section=jira&ticket=<KEY>` opens that ticket over whatever Jira page is
  stored, keeps the pair in the address while the page is on screen, and reads the Back chip's origin from the entry's `history.state`. A `ticket=` that is not
  half of a valid pair is stripped on mount even when nothing else in the address is read, so the address never names a ticket that is not on screen.

  `JiraView` and the ticket page are real here — only the files/GitHub board and Runs are stubbed, above — over the ticket-body fixture's PAY-12 on its one
  board, so the page that draws is the one a reader would see.
*/
describe('a Jira ticket link', () => {
  let jiraAnswer: JiraStatusPayload;
  const ok = (body: unknown): Promise<Response> =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response);

  beforeEach(() => {
    setJiraPage('board');
    jiraAnswer = status();
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/jira') return ok(jiraAnswer);
      if (url.startsWith('/api/jira/sessions')) return ok({ links: [], reachable: true, rowsAt: null });
      if (/^\/api\/jira\/boards\/[^/]+\/issues$/.test(url)) return ok({ issues: [ISSUE], polledAt: jiraAnswer.boards[0]?.polledAt ?? null });
      if (url === '/api/jira/issue/PAY-12') return ok(detail());
      if (url === '/api/agents/status') return ok(AGENTS_ON);
      if (url === '/api/jira/worktrees') return ok({ worktrees: [], unavailable: [] });
      // GitLab and every other shell read: no answer, so nothing they draw competes with the section.
      if (url === '/api/gitlab') return new Promise<Response>(() => {});
      return ok({ ok: true });
    }) as unknown as typeof fetch;
  });

  const main = (): HTMLElement => document.querySelector('main') as HTMLElement;
  const ticketPath = (): HTMLElement | null => within(main()).queryByRole('navigation', { name: 'Ticket path' });

  it('opens the ticket page over a stored Board, keeps the pair in the address, and names Board as the origin of a pasted link', async () => {
    window.history.replaceState(null, '', '/?section=jira&ticket=PAY-12');
    render(<App />);
    expect(await within(main()).findByRole('navigation', { name: 'Ticket path' })).toHaveTextContent('PAY-12');
    expect(getJiraTicket().key).toBe('PAY-12');
    expect(stored(JIRA_PAGE_KEY)).toBe('ticket');
    expect(stored(SECTION_KEY)).toBe('jira');
    expect(within(main()).getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(window.location.search).toBe('?section=jira&ticket=PAY-12');
  });

  it('keeps the origin a reload finds in the entry’s state', async () => {
    window.history.replaceState({ jiraTicketOrigin: 'sessions' }, '', '/?section=jira&ticket=PAY-12');
    render(<App />);
    expect(await within(main()).findByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(window.location.search).toBe('?section=jira&ticket=PAY-12');
    expect(window.history.state).toEqual({ jiraTicketOrigin: 'sessions' });
  });

  it('a key that is not key-shaped opens the Jira Board and leaves the address (Review Focus 1)', async () => {
    window.history.replaceState(null, '', '/?section=jira&ticket=pay-12');
    render(<App />);
    expect(await within(main()).findAllByText('Refund partial captures')).not.toHaveLength(0);
    expect(window.location.search).toBe('');
    expect(stored(JIRA_PAGE_KEY)).toBe('board');
    expect(getJiraTicket().key).toBe('');
    expect(ticketPath()).toBeNull();
  });

  it('a lone `ticket=` is stripped and the app opens as a plain load', async () => {
    window.history.replaceState(null, '', '/?ticket=PAY-12');
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(getJiraTicket().key).toBe('');
  });

  it('a `ticket=` beside another section is stripped with it, and that section opens (Review Focus 5)', async () => {
    window.history.replaceState(null, '', '/?section=runs&runs=watchdog&ticket=PAY-12');
    render(<App />);
    expect(await screen.findByText('runs stub: watchdog')).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(getJiraTicket().key).toBe('');
  });

  it('on `configured: false` the section falls and the pair leaves the address', async () => {
    jiraAnswer = status({ configured: false, site: null, me: null, tokenKind: null, access: 'unconfigured', home: null, boards: [] });
    window.history.replaceState(null, '', '/?section=jira&ticket=PAY-12');
    render(<App />);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(getJiraTicket().key).toBe('');
    expect(ticketPath()).toBeNull();
  });

  it('forgets the key an older build persisted', async () => {
    localStorage.setItem(JIRA_TICKET_KEY_KEY, JSON.stringify('PAY-12'));
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(localStorage.getItem(JIRA_TICKET_KEY_KEY)).toBeNull();
    expect(getJiraTicket().key).toBe('');
  });

  // A regression pin, green before the ticket link too: a parameter the app does not read stays where it is — only a `ticket=` is stripped without a section.
  it('leaves an unread `section=` in the address', async () => {
    window.history.replaceState(null, '', '/?section=nope');
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(window.location.search).toBe('?section=nope');
  });
});
