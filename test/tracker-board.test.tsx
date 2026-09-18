/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { BOARD_TRACKER_POLL_MS } from '../client/src/hooks/useBoard';
import { TRACKER_POLL_MS } from '../server/src/tracker/poller.service';
import type { AgentsStatus, BacklogItem, ItemsIndex, OrchestratorRunsPayload, ProjectSummary } from '../shared/types';

/**
 * What a tracker project looks like ON THE BOARD (task-45, spec §5.5): the
 * band's poll age, the card's untyped badge, its link-out and its assignee,
 * the item modal's age beside the cached body — and, most load-bearing of the
 * six, NO dispatch control at all.
 *
 * One files project beside one GitHub project in every render, deliberately.
 * Each case then asserts both halves of its rule at once — the tracker card has
 * no dispatch button AND the files card still does — which is the only shape
 * that can catch a change that hides the control for everybody.
 */

const FILES_PATH = '/abs/alpha';
const TRACKER_PATH = '/abs/tracker';

function item(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1',
    title: 'a files bug',
    created: '2026-09-01',
    started: '',
    updated: new Date().toISOString().slice(0, 19) + 'Z',
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    tags: [],
    section: 'bugs',
    status: 'open',
    project: 'alpha',
    projectPath: FILES_PATH,
    groomed: true,
    path: `${FILES_PATH}/backlog/bugs/open/bug-1.md`,
    source: 'files',
    url: null,
    assignee: null,
    untyped: false
  };
  return { ...base, ...over };
}

/** The tracker's own row: `source: 'github'`, a URN for a path, a URL, and
 *  whatever the case is about. */
function issueItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return item({
    id: '#31',
    title: 'an issue',
    project: 'tracker',
    projectPath: TRACKER_PATH,
    path: 'gh:futin/x#31',
    source: 'github',
    url: 'https://github.com/futin/x/issues/31',
    ...over
  });
}

function projects(trackerOver: Partial<ProjectSummary> = {}): ProjectSummary[] {
  return [
    {
      name: 'alpha',
      path: FILES_PATH,
      createdAt: '2026-08-26T00:00:00.000Z',
      missing: false,
      counts: { bugs: 1, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
      source: 'files',
      repo: null,
      polledAt: null,
      access: null,
      detail: null
    },
    {
      name: 'tracker',
      path: TRACKER_PATH,
      createdAt: '2026-08-26T00:00:00.000Z',
      missing: false,
      counts: { bugs: 1, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
      source: 'github',
      repo: 'futin/x',
      polledAt: new Date().toISOString(),
      access: 'ok',
      detail: null,
      ...trackerOver
    }
  ];
}

const AGENTS_STATUS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  // BOTH projects are visible to the dashboard, so the only reason a tracker
  // card can lack a dispatch control is the one this suite is about.
  projectPaths: [FILES_PATH, TRACKER_PATH]
};

const NO_RUNS: OrchestratorRunsPayload = { runs: [], starting: [] };

let bodyCalls: string[];

function stubFetch(items: BacklogItem[], summaries: ProjectSummary[]): void {
  bodyCalls = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/items/body')) {
      bodyCalls.push(url);
      return Promise.resolve({ ok: true, text: () => Promise.resolve('## Symptom\n\nthe cached issue body\n') } as Response);
    }
    const payload = url.includes('/api/agents/status')
      ? AGENTS_STATUS
      : url.includes('/api/orchestrator/runs')
        ? NO_RUNS
        : url.includes('/api/projects')
          ? summaries
          : ({ items, errors: [] } as ItemsIndex);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
}

async function renderBoard(items: BacklogItem[], summaries: ProjectSummary[] = projects()): Promise<void> {
  stubFetch(items, summaries);
  render(<BoardView />);
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

/** The card for one title — every assertion here is about one card's contents,
 *  and `getByText` on a marker would happily match the other card's. */
function card(title: string): HTMLElement {
  return screen.getByText(title).closest('.board-card') as HTMLElement;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('dispatch on a tracker project', () => {
  it('draws no dispatch control at all, while a files card in the same render still has one', async () => {
    await renderBoard([item({}), issueItem()]);

    // Absence, not a disabled control: a spawned session would run the
    // file-writing skills against a project with no files, so this is an
    // environment-level block and CLAUDE.md's rule is that those HIDE.
    expect(within(card('an issue')).queryByRole('button', { name: /groom|execute|capture/i })).toBeNull();
    expect(within(card('a files bug')).getByRole('button', { name: /execute/i })).toBeInTheDocument();
  });
});

describe('the card’s three tracker readings', () => {
  it('draws the untyped badge only for an untyped item', async () => {
    await renderBoard([issueItem({ untyped: true, section: 'ideas', groomed: null }), issueItem({ id: '#32', title: 'typed issue' })]);
    expect(within(card('an issue')).getByText('untyped')).toBeInTheDocument();
    expect(within(card('typed issue')).queryByText('untyped')).toBeNull();
  });

  it('draws the link-out only when the item has a url', async () => {
    await renderBoard([item({}), issueItem()]);
    const link = within(card('an issue')).getByRole('link', { name: /open #31/i });
    expect(link).toHaveAttribute('href', 'https://github.com/futin/x/issues/31');
    expect(within(card('a files bug')).queryByRole('link')).toBeNull();
  });

  it('draws an assignee login, and nothing for an unassigned item', async () => {
    await renderBoard([issueItem({ assignee: 'futin' }), issueItem({ id: '#32', title: 'nobody', assignee: null })]);
    expect(within(card('an issue')).getByText('@futin')).toBeInTheDocument();
    expect(within(card('nobody')).queryByText(/^@/)).toBeNull();
  });

  it('opening the issue does not open the item modal behind it', async () => {
    await renderBoard([issueItem()]);
    const link = within(card('an issue')).getByRole('link', { name: /open #31/i });
    await userEvent.click(link);
    // The whole card is a button; without `stopPropagation` the click would
    // open the modal as well as the issue.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the band', () => {
  it('shows the poll age while access is ok', async () => {
    await renderBoard([issueItem()]);
    expect(screen.getByTestId('tracker-line')).toHaveTextContent(/futin\/x · polled \d+ s ago/);
  });

  it('shows the access reason in place of the age when access is not ok', async () => {
    await renderBoard([issueItem()], projects({ access: 'no-token', polledAt: null }));
    const line = screen.getByTestId('tracker-line');
    expect(line).toHaveTextContent('BM_GITHUB_TOKEN');
    expect(line).not.toHaveTextContent('polled');
  });

  it('says nothing at all when no project is a tracker', async () => {
    await renderBoard([item({})], [projects()[0]]);
    expect(screen.queryByTestId('tracker-line')).toBeNull();
  });
});

describe('the item modal', () => {
  it('renders the cached body with the poll age beside it, and asks GitHub for nothing', async () => {
    await renderBoard([issueItem()]);
    await userEvent.click(screen.getByText('an issue'));

    await waitFor(() => expect(screen.getByText('the cached issue body')).toBeInTheDocument());
    // The age says how old the cached copy is — the point of drawing it beside
    // a body that was not fetched from GitHub on open (spec §5.5). Scoped to
    // the dialog: the band prints the same line, and an unscoped query would
    // pass on the band's copy while the modal drew nothing.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/futin\/x · polled \d+ s ago/)).toBeInTheDocument();

    // The ONE request the open made went to this app's own API, by URN, and
    // was answered out of the poller's cache. Nothing in this browser ever
    // talks to GitHub — the token is on the server and never leaves it.
    expect(bodyCalls).toHaveLength(1);
    expect(bodyCalls[0]).toContain(encodeURIComponent('gh:futin/x#31'));
    for (const call of (global.fetch as jest.Mock).mock.calls) {
      expect(String(call[0])).not.toContain('api.github.com');
    }
  });
});

describe('the board’s own poll', () => {
  it('matches the server’s poll interval', () => {
    // Two constants, one number, and a test rather than an import: the client
    // module is bundled into the browser and the server's imports Nest. A
    // client interval slower than the server's would make the rendered age
    // claim the items are older than they are.
    expect(BOARD_TRACKER_POLL_MS).toBe(TRACKER_POLL_MS);
  });

  it('re-reads the payload while a tracker project is registered, and not otherwise', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      stubFetch([item({})], [projects()[0]]);
      render(<BoardView />);
      await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
      const filesOnly = (global.fetch as jest.Mock).mock.calls.length;
      jest.advanceTimersByTime(BOARD_TRACKER_POLL_MS * 2);
      // No interval at all on a board with no tracker: every card is a pure
      // function of props that cannot change without an event this tab sees.
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(filesOnly);
    } finally {
      jest.useRealTimers();
    }
  });
});
