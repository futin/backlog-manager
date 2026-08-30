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
/**
 * The clock-dependent fixtures below are all RELATIVE to the moment the suite
 * runs, never literal. The card's in-progress label is now minutes-and-hours,
 * so a literal `started` would read as a different elapsed every day and the
 * suite would have to fake timers to say anything — and faking timers here
 * fights userEvent, which this file uses for the filter selects. Relative
 * values also cannot drift the wrong way: elapsed only ever grows between the
 * fixture being built and the assertion running, and every rung floors, so
 * `3h` stays `3h`.
 *
 * `CREATED` carries the current year for the same reason: `formatCreated` drops
 * the year only when it matches now's, so a hard-coded 2026 would silently
 * start asserting the wrong string on 1 January.
 */
const agoISO = (ms: number): string => `${new Date(Date.now() - ms).toISOString().slice(0, 19)}Z`;
const daysAgoDate = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const CREATED = `${new Date().getUTCFullYear()}-08-20`;

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  // Annotated (not inferred): without a contextual type here, the object
  // literal's `section`/`status` widen to plain `string` and fail against
  // `Section`/`ItemStatus` below — the annotation is what keeps them narrowed.
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: CREATED, started: '', tags: [],
    updated: '', phase: '', groomElapsed: 0, executeElapsed: 0,
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
    ...over
  };
  return { ...base, path: over.path ?? `${base.projectPath}/backlog/${base.section}/${base.status}/${base.id}.md` };
}

const ITEMS: ItemsIndex = {
  items: [
    fakeItem({}),
    fakeItem({ id: 'bug-2', title: 'groomed bug', groomed: true, started: agoISO(3 * 60 * 60 * 1000) }),
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

// Same branching as the `beforeEach` stub, over a caller-supplied item list
// instead of the fixed `ITEMS` fixture. The sort tests below need bugs whose
// exact `created`/`started` values carry the assertion, and `ITEMS` cannot
// grow to hold them: several tests above assert exact `col-count` numbers
// against it, so a shared fixture is the one thing a sort-order test must
// not touch.
function stubItems(items: BacklogItem[]) {
  (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.includes('/api/agents/status') ? AGENTS_STATUS
      : url.includes('/api/projects') ? PROJECTS : { items, errors: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  });
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

  it('marks groomed bugs, pills the project, and shows id · short date on the card', async () => {
    await renderBoard();
    const card = screen.getByText('groomed bug').closest('.board-card') as HTMLElement;
    // Beside the meta line, not inside it: inside, the nowrap-with-ellipsis
    // clipped it to `· gr…` at the real column width.
    const groomed = within(card).getByText('groomed');
    expect(groomed).toHaveClass('board-card-groomed');
    expect(groomed.closest('.board-card-meta')).toBeNull();
    expect(groomed.closest('.board-card-foot')).not.toBeNull();
    // The pill carries the project — not the type, which the column already
    // states — and the meta line carries what is left.
    expect(within(card).getByText('alpha'))
      .toHaveClass('pill', buildProjectHues(PROJECTS).classFor('alpha'));
    // Short, not the stored YYYY-MM-DD: the meta line is nowrap-with-ellipsis
    // in ~118px and the full date left no room for the id beside it, which is
    // the clipping this format exists to fix.
    expect(card.textContent).toContain('bug-2 · aug 20');
  });

  // An item nobody has picked up carries no created date at all in some
  // hand-written files. The separator has to go with it — `bug-4 ·` trailing
  // into nothing reads as a value that failed to load.
  it('drops the separator on a card whose created date is empty', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status') ? AGENTS_STATUS
        : url.includes('/api/projects') ? PROJECTS
          : { items: [fakeItem({ id: 'bug-4', title: 'undated bug', created: '' })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const meta = screen
      .getByText('undated bug').closest('.board-card')!
      .querySelector('.board-card-meta') as HTMLElement;
    expect(meta.textContent).toBe('bug-4');
  });

  /**
   * The in-progress marker is a full-width amber bar across the top of the
   * card's face, not the 3px inset down its left edge it used to be. "Which of
   * these twelve is anyone on" is a question asked of a whole column at once,
   * and a hairline at the edge of one card could not answer it at a glance.
   *
   * The elapsed reading moves into that bar and out of the foot, which is the
   * other half of the fix: the foot's meta line is nowrap-with-ellipsis inside
   * ~118px at the real column width, so id, date and marker could not all fit
   * there — measured, not guessed. In the bar the reading has the card's whole
   * width and the foot gets its id and date back.
   */
  it('marks an in-progress card with a live bar carrying the words and the elapsed time', async () => {
    await renderBoard();
    const live = screen.getByText('groomed bug').closest('.board-card') as HTMLElement;
    expect(live).toHaveClass('board-card-live');

    const bar = live.querySelector('.board-card-live-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain('in progress');
    // The exact date is not on the card at any size — it is in the title
    // attribute here and spelled out in the drawer.
    expect(bar).toHaveAttribute('title', expect.stringContaining('in progress since'));

    // Three hours before this render, per the fixture. Hours, not days: `0d`
    // was the old reading for anything started today, which is exactly the
    // in-progress work the marker is for.
    const mark = within(bar).getByText('3h');
    expect(mark).toHaveClass('board-card-live-mark');
    expect(mark.closest('.board-card-foot')).toBeNull();

    // The negative half matters as much: without it, a bar rendered
    // unconditionally would pass every assertion above.
    const idle = screen.getByText('a bug').closest('.board-card') as HTMLElement;
    expect(idle).not.toHaveClass('board-card-live');
    expect(idle.querySelector('.board-card-live-bar')).toBeNull();
  });

  // The bar used to always say "in progress"; now it names which skill holds
  // the item, because "grooming" and "executing" are different facts about
  // what is actually happening to it. An empty phase (started before Task 4
  // added the key, or a stop that already cleared it while `started` is
  // somehow still set on a hand-edited file) is not an error case — it falls
  // back to the old generic wording rather than rendering nothing.
  it('names the activity on the live bar: grooming for a groom-phase item, generic otherwise', async () => {
    stubItems([
      fakeItem({ id: 'bug-grooming', title: 'being groomed', started: agoISO(5 * 60 * 1000), phase: 'groom' }),
      fakeItem({ id: 'bug-plain-live', title: 'plain live', started: agoISO(5 * 60 * 1000) })
    ]);
    await renderBoard();

    const groomingBar = screen.getByText('being groomed').closest('.board-card')!
      .querySelector('.board-card-live-bar') as HTMLElement;
    expect(within(groomingBar).getByText('grooming')).toBeInTheDocument();

    const plainBar = screen.getByText('plain live').closest('.board-card')!
      .querySelector('.board-card-live-bar') as HTMLElement;
    expect(within(plainBar).getByText('in progress')).toBeInTheDocument();
  });

  it('reads the elapsed time in minutes for work picked up this hour', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status') ? AGENTS_STATUS
        : url.includes('/api/projects') ? PROJECTS
          : { items: [fakeItem({ id: 'bug-5', title: 'just started', started: agoISO(20 * 60 * 1000) })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const bar = screen.getByText('just started').closest('.board-card')!
      .querySelector('.board-card-live-bar') as HTMLElement;
    expect(within(bar).getByText('20m')).toBeInTheDocument();
  });

  // Every file stamped before `start` wrote a time carries a bare date, and
  // nothing rewrites them — so this is a shape the card renders forever, aged in
  // days because a bare date carries no hour to read.
  it('ages a legacy date-only started value in days', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status') ? AGENTS_STATUS
        : url.includes('/api/projects') ? PROJECTS
          : { items: [fakeItem({ id: 'bug-6', title: 'legacy start', started: daysAgoDate(1) })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const bar = screen.getByText('legacy start').closest('.board-card')!
      .querySelector('.board-card-live-bar') as HTMLElement;
    expect(within(bar).getByText('1d')).toBeInTheDocument();
  });

  // Nothing validates the shape of `started` on the way in: the CLI writes it,
  // but a person can edit the file. The bar still has to say someone is on this
  // — dropping only the unreadable half — and must never print NaN.
  it('renders the bar without an elapsed reading when started cannot be parsed', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status') ? AGENTS_STATUS
        : url.includes('/api/projects') ? PROJECTS
          : { items: [fakeItem({ id: 'bug-8', title: 'hand edited', started: 'soon' })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const card = screen.getByText('hand edited').closest('.board-card') as HTMLElement;
    const bar = card.querySelector('.board-card-live-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain('in progress');
    expect(card.textContent).not.toContain('NaN');
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
    expect(card.querySelector('.board-card-live-bar')).toBeNull();
    expect(within(card).getByText('done')).toHaveClass('board-card-done');
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

  it('status select offers open, in progress, done and all, in that order', async () => {
    await renderBoard();
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    const labels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['Open', 'In progress', 'Done', 'All']);
  });

  it('status filter: in progress narrows to open items carrying a started stamp', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'started');
    // Only bug-2 ("groomed bug") is open with a started stamp; task-9 is
    // started but done, and everything else carries no stamp at all.
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent))
      .toEqual(['1', '0', '0', '0']);
    expect(screen.getByText('groomed bug')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
  });

  // The regression guard for the out-of-scope ordering: oos-1 is terminal, so
  // it would leak through under 'started' if the out-of-scope bypass ran
  // before the 'started' branch — this is the case that ordering bug would
  // actually break. task-9 (done, but carrying a started stamp) is asserted
  // alongside it as a plain sanity check that "started but no longer open"
  // stays excluded too. Both are asserted separately from the case above,
  // even though its counts already imply this, so a future edit that re-adds
  // the bypass fails a test whose name says what broke.
  it('status filter: in progress hides out-of-scope items even though they bypass open and done', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'started');
    expect(screen.queryByText('declined thing')).not.toBeInTheDocument();
    expect(screen.queryByText('finished task')).not.toBeInTheDocument();
  });

  it('project filter narrows every column by projectPath', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/abs/beta');
    expect(screen.getByText('a task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
  });

  // The primary sort key: in-progress ranks above everything else, and the
  // selected comparator only breaks ties inside each half. Newest-first is
  // the default in play here specifically so a broken primary key produces a
  // plausible-looking wrong answer (plain newest-on-top) instead of an
  // assertion that would pass by accident either way.
  it('an in-progress card sorts above a newer one under Newest first', async () => {
    stubItems([
      fakeItem({ id: 'bug-old-live', title: 'old-live', created: daysAgoDate(10), started: daysAgoDate(10) }),
      fakeItem({ id: 'bug-new-idle', title: 'new-idle', created: daysAgoDate(0) }),
      fakeItem({ id: 'bug-mid-idle', title: 'mid-idle', created: daysAgoDate(5) })
    ]);
    await renderBoard();
    const bugsCol = screen.getAllByTestId('board-col')[0];
    const titles = Array.from(bugsCol.querySelectorAll('.board-card-title')).map((el) => el.textContent);
    // old-live jumps both newer idle cards; the two idle cards still read
    // newest-first between themselves, proving the tiebreak comparator ran.
    expect(titles).toEqual(['old-live', 'new-idle', 'mid-idle']);
  });

  // The case the user actually asked for: with two cards live at once, the
  // primary key alone (rank 0 vs. rank 1) cannot order them against each
  // other, so whichever sort is selected has to keep doing its job *inside*
  // the in-progress group, not only inside the idle one.
  it('two in-progress cards keep the selected sort between them', async () => {
    stubItems([
      fakeItem({ id: 'bug-zulu', title: 'zulu-live', started: agoISO(60 * 60 * 1000) }),
      fakeItem({ id: 'bug-alpha', title: 'alpha-live', started: agoISO(2 * 60 * 60 * 1000) }),
      fakeItem({ id: 'bug-beta', title: 'beta-idle' }),
      fakeItem({ id: 'bug-yankee', title: 'yankee-idle' })
    ]);
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'name');
    const bugsCol = screen.getAllByTestId('board-col')[0];
    const titles = Array.from(bugsCol.querySelectorAll('.board-card-title')).map((el) => el.textContent);
    expect(titles).toEqual(['alpha-live', 'zulu-live', 'beta-idle', 'yankee-idle']);
  });

  // A stored sort key this build has no comparator for — hand-edited, or written
  // by a later build the user has since rolled back. `usePersistedState` parses
  // whatever JSON it finds and hands the string straight back (the `SortKey`
  // type is a claim about what this build WRITES, never about what it can read),
  // so the lookup in `sortItems` misses. Without a fallback that miss is called
  // as a function, and the TypeError lands inside render with no ErrorBoundary
  // anywhere in client/src to catch it: the entire board unmounts to a blank
  // page that only clearing site data recovers. Three idle bugs, not two,
  // because the fallback comparator only runs once the shared in-progress
  // primary key ties.
  it('falls back to the default sort when the stored sort key is unrecognized', async () => {
    localStorage.setItem('backlog-manager.sort', JSON.stringify('newest'));
    stubItems([
      fakeItem({ id: 'bug-old', title: 'old-idle', created: daysAgoDate(10) }),
      fakeItem({ id: 'bug-new', title: 'new-idle', created: daysAgoDate(0) }),
      fakeItem({ id: 'bug-mid', title: 'mid-idle', created: daysAgoDate(5) })
    ]);
    await renderBoard();
    const bugsCol = screen.getAllByTestId('board-col')[0];
    const titles = Array.from(bugsCol.querySelectorAll('.board-card-title')).map((el) => el.textContent);
    // Rendering at all is only half the assertion. The other half is that the
    // fallback IS the `created` comparator — the fetched order here is
    // old, new, mid, so a fallback that merely returned 0 and left the array
    // as fetched would pass a "didn't crash" check and fail this one.
    expect(titles).toEqual(['new-idle', 'mid-idle', 'old-idle']);
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
