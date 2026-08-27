/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { buildProjectHues } from '../client/src/lib/project-hue';
import type { AgentsStatus, BacklogItem, ItemsIndex, ProjectSummary } from '../shared/types';

// `path` is derived after the spread rather than hard-coded: every other field
// here is a shared default that `over` may or may not touch, but `path` must be
// unique per fixture because BoardView keys each card on it (`id` alone would
// collide across projects, since ids are only sequential within one project's
// own store). An explicit `over.path` still wins, so a test that cares about a
// specific path can still set one.
function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  // Annotated (not inferred): without a contextual type here, the object
  // literal's `section`/`status` widen to plain `string` and fail against
  // `Section`/`ItemStatus` below — the annotation is what keeps them narrowed.
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
    ...over
  };
  return { ...base, path: over.path ?? `${base.projectPath}/backlog/${base.section}/${base.status}/${base.id}.md` };
}

const ITEMS: ItemsIndex = {
  items: [
    fakeItem({}),
    fakeItem({ id: 'bug-2', title: 'groomed bug', groomed: true, started: '2026-08-24' }),
    fakeItem({ id: 'task-1', title: 'a task', section: 'tasks', project: 'beta', projectPath: '/abs/beta', groomed: true }),
    fakeItem({ id: 'task-9', title: 'finished task', section: 'tasks', status: 'done', groomed: true, started: '2026-08-01' }),
    fakeItem({ id: 'idea-1', title: 'an idea', section: 'ideas', groomed: null }),
    fakeItem({ id: 'oos-1', title: 'declined thing', section: 'out-of-scope', status: 'terminal', groomed: null })
  ],
  errors: ['/abs/alpha/backlog/ideas/open/idea-9-broken.md: frontmatter has no closing --- line']
};

const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 2, ideas: 1, tasks: 0, 'out-of-scope': 1 } },
  { name: 'beta', path: '/abs/beta', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 1, 'out-of-scope': 0 } },
  { name: 'ghost', path: '/abs/ghost', createdAt: '2026-08-26T00:00:00.000Z', missing: true,
    counts: { bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 } }
];

// A real answer, not a stand-in: this suite predates dispatch and never had
// a reason to know about `/api/agents/status`, but `BoardView` now calls
// `useAgents()` on every mount regardless of which suite is rendering it. A
// stub that only knows `/api/projects` vs. everything-else used to be enough
// because there was nothing else to ask; now "everything else" also catches
// this URL and would hand `useAgents` the `ITEMS` object instead, which
// `fetchAgentsStatus` (client/src/lib/agents.ts) rejects as malformed. Both
// projects registered below are reachable, so every open bug/task in this
// suite's fixtures gets an enabled dispatch button — deliberately, so this
// stub matches what a working dashboard would actually say instead of
// papering over the endpoint with an off/unreachable stand-in.
const AGENTS_STATUS: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha', '/abs/beta']
};

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.includes('/api/agents/status') ? AGENTS_STATUS
      : url.includes('/api/projects') ? PROJECTS : ITEMS;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
});

async function renderBoard() {
  render(<BoardView />);
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

describe('BoardView', () => {
  it('renders the four columns with counts of what they hold (open by default)', async () => {
    await renderBoard();
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-name').textContent))
      .toEqual(['Bugs', 'Ideas', 'Tasks', 'Out of scope']);
    // done task-9 hidden by the default open filter; oos unaffected
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent))
      .toEqual(['2', '1', '1', '1']);
    // col-count renders colItems.length, an array length — assert the DOM
    // actually holds that many cards so a key-driven card omission would fail
    // this test instead of passing unnoticed behind a correct-looking number.
    // Counts `.board-card` elements directly rather than `role="button"`: the
    // card itself carries that role, and now so does its own dispatch button
    // when the item has one — but per Task 8's design, WHICH cards get a
    // second (dispatch) button depends on each item's own groomed/status
    // state, not on how many cards actually rendered. A role count is no
    // longer a stable proxy for card count at all (it would vary with the mix
    // of dispatchable vs. archived items, independent of any card going
    // missing); cards were always what this assertion meant to prove, so
    // counting them directly says that outright instead of through a proxy
    // this task's own UI broke.
    expect(cols[0].querySelectorAll('.board-card')).toHaveLength(2);
    expect(screen.queryByText('finished task')).not.toBeInTheDocument();
  });

  it('marks groomed bugs, pills the project, and shows id · date on the card', async () => {
    await renderBoard();
    const card = screen.getByText('groomed bug').closest('.board-card') as HTMLElement;
    expect(within(card).getByText('· groomed')).toBeInTheDocument();
    // The pill carries the project — not the type, which the column already
    // states — and the meta line carries what is left.
    expect(within(card).getByText('alpha'))
      .toHaveClass('pill', buildProjectHues(PROJECTS).classFor('alpha'));
    expect(card.textContent).toContain('bug-2 · 2026-08-20');
  });

  // The marker is `◍ <age>` and lives in the foot rather than on the meta line,
  // pinned unshrinkable at the card's right edge. Measured, not guessed: the
  // meta line is nowrap-with-ellipsis inside ~118px at the real column width,
  // already clips `· groomed`, and swallowed the marker whole when it sat there —
  // 239px of content in a 118px box, rendered but invisible. The words move to
  // the title attribute (and to the drawer), which is what the assertion on the
  // title below is protecting: the visible text alone is deliberately terse.
  it('marks an in-progress card with the live class and an aged marker in the foot', async () => {
    await renderBoard();
    const live = screen.getByText('groomed bug').closest('.board-card') as HTMLElement;
    expect(live).toHaveClass('board-card-live');
    const mark = within(live).getByTitle(/in progress since 2026-08-24/);
    expect(mark).toHaveClass('board-card-live-mark');
    expect(mark.textContent).toMatch(/^◍ \d+d$/);
    expect(mark.closest('.board-card-foot')).not.toBeNull();
    expect(mark.closest('.board-card-meta')).toBeNull();

    // The negative half matters as much: without it, a marker rendered
    // unconditionally would pass the assertions above.
    const idle = screen.getByText('a bug').closest('.board-card') as HTMLElement;
    expect(idle).not.toHaveClass('board-card-live');
    expect(within(idle).queryByTitle(/in progress/)).not.toBeInTheDocument();
  });

  // An archived item keeps its started date — "picked up on the 1st, finished on
  // the 20th" is history worth having in the file, and `move` never rewrites
  // content to strip it. So the card has to gate on status as well as the date,
  // or every item ever worked would read as live forever after it shipped.
  it('renders a done item that still carries a started date as done, not live', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');
    const card = screen.getByText('finished task').closest('.board-card') as HTMLElement;
    expect(card).not.toHaveClass('board-card-live');
    expect(within(card).queryByTitle(/in progress/)).not.toBeInTheDocument();
    expect(within(card).getByText('· done')).toBeInTheDocument();
  });

  it('colours the pill by project, not by section', async () => {
    await renderBoard();
    // alpha's bug and alpha's task: different columns, so under the old
    // section-keyed pill these two carried different classes. Same project now
    // means the same class, which is the whole point — a project reads as one
    // colour straight across the board.
    const bug = screen.getByText('a bug').closest('.board-card') as HTMLElement;
    const idea = screen.getByText('an idea').closest('.board-card') as HTMLElement;
    const alphaOnBug = within(bug).getByText('alpha');
    const alphaOnIdea = within(idea).getByText('alpha');
    expect(alphaOnIdea.className).toBe(alphaOnBug.className);

    // ...and beta, a different project in the same column as one of them, does
    // not — otherwise "same class everywhere" would also pass on a constant.
    const betaTask = screen.getByText('a task').closest('.board-card') as HTMLElement;
    expect(within(betaTask).getByText('beta').className).not.toBe(alphaOnBug.className);
  });

  it('status filter: done shows only done items in the three queue columns', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');
    expect(screen.getByText('finished task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
    // out-of-scope is flat and stays put
    expect(screen.getByText('declined thing')).toBeInTheDocument();
  });

  it('project filter narrows every column by projectPath', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/abs/beta');
    expect(screen.getByText('a task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
  });

  it('search narrows by title, and no matches shows the empty state', async () => {
    await renderBoard();
    await userEvent.type(screen.getByLabelText('Search items'), 'zzz');
    expect(screen.getByText('no matches')).toBeInTheDocument();
  });

  it('surfaces scan errors and missing projects as a warning line', async () => {
    await renderBoard();
    const warn = screen.getByTestId('board-warn');
    expect(warn.textContent).toContain('idea-9-broken.md');
    expect(warn.textContent).toContain('ghost');
  });

  it('opens the drawer when a card is clicked', async () => {
    await renderBoard();
    await userEvent.click(screen.getByText('a bug'));
    expect(screen.getByRole('dialog', { name: 'a bug' })).toBeInTheDocument();
  });

  it('shows board unavailable on a non-2xx fetch, not the empty state', async () => {
    // A 500 from Nest is a JSON body, so it parses cleanly. Without the res.ok
    // check in useBoard it landed in state as the index, `all` fell back to
    // [], and the board told you to go run a backlog skill — the one message
    // that hides a server failure behind a user-error prompt.
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ statusCode: 500, message: 'Internal Server Error' })
      } as Response)
    );
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('board unavailable')).toBeInTheDocument());
    expect(screen.queryByText('nothing registered yet')).not.toBeInTheDocument();
  });

  it('shows the nothing-registered empty state on an empty index', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/projects') ? [] : { items: [], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('nothing registered yet')).toBeInTheDocument());
  });
});
