/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { buildProjectHues } from '../client/src/lib/project-hue';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentsStatus, BacklogItem, ItemsIndex, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary,
  RunQueueItem, RunStage
} from '../shared/types';

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
    // Fresh by default, and RELATIVE, so Task 5's staleness split leaves this
    // suite's fixtures on the Board whatever day it runs. `created` stays the
    // fixed `aug 20` the meta-line assertion needs, and an `updated` stamp is
    // exactly what stops that literal month from silently archiving every
    // fixture here once the calendar passes the window — the fallback to
    // `created` is a real rule (see item-stale.test.ts), just not one this
    // suite's shared fixture should be sitting on.
    updated: agoISO(0), lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0, kind: '',
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
    fakeItem({ id: 'oos-1', title: 'declined thing', section: 'out-of-scope', status: 'terminal', groomed: null }),
    // Task 2: one open refactor with a known kind, one with a value the badge
    // does not recognise. `groomed: null` matches what the API derives for the
    // section — a refactor is waiting to be promoted, not groomed.
    fakeItem({ id: 'ref-1', title: 'a refactor', section: 'refactors', groomed: null, kind: 'debt' }),
    fakeItem({ id: 'ref-2', title: 'oddly classified', section: 'refactors', status: 'done', groomed: null, kind: 'whatever' })
  ],
  errors: ['/abs/alpha/backlog/ideas/open/idea-9-broken.md: frontmatter has no closing --- line']
};

const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 2, ideas: 1, tasks: 0, refactors: 0, 'out-of-scope': 1 } },
  { name: 'beta', path: '/abs/beta', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 1, refactors: 0, 'out-of-scope': 0 } },
  { name: 'ghost', path: '/abs/ghost', createdAt: '2026-08-26T00:00:00.000Z', missing: true,
    counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 } }
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

/*
 * bug-11: the orchestrator runs endpoint, which BoardView has polled since
 * task-9 and which staleness now reads too. Answered with a real empty
 * payload rather than left to fall through to the items branch: the fall-
 * through handed `fetchOrchestratorRuns` an `ItemsIndex`, which it rejects as
 * malformed, so every case in this file was quietly exercising the hook's
 * error path. Harmless while nothing but the run strip read it; not harmless
 * once the Board/Archive split does.
 */
type RunPayload = OrchestratorRunsPayload['runs'][number];
const NO_RUNS: OrchestratorRunsPayload = { runs: [] };

/** One fresh run for `/abs/alpha` holding exactly `id` at `stage`. Built off
 *  the contract fixture, like every other suite that needs a run payload, so
 *  the shape stays the real one. */
function runHolding(id: string, stage: RunStage, over: Partial<RunPayload> = {}): RunPayload {
  const fixture = rawFixture as OrchestratorRun;
  const entry: RunQueueItem = { ...fixture.queue[0], id, stage };
  return { ...fixture, project: '/abs/alpha', queue: [entry], fresh: true, pastRuns: 0, ...over };
}

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.includes('/api/agents/status') ? AGENTS_STATUS
      : url.includes('/api/orchestrator/runs') ? NO_RUNS
        : url.includes('/api/projects') ? PROJECTS : ITEMS;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
});

async function renderBoard() {
  render(<BoardView />);
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

/*
 * The same render, inside a real `SettingsProvider`. Every other case here
 * renders BoardView bare, which is deliberate and stays that way: `useSettings`
 * falls back to `DEFAULT_SETTINGS` outside a provider (see its own comment), so
 * a bare board is a board on the documented 30-day window with no fixture
 * setup at all.
 *
 * That fallback is also why a staleness-window test cannot just write to
 * localStorage and render bare — nothing outside the provider reads storage,
 * so the write would be silently ignored and the test would pass for the wrong
 * reason. Mounting the provider is what puts the stored value on the path the
 * app actually uses.
 */
async function renderBoardWithSettings() {
  render(
    <SettingsProvider>
      <BoardView />
    </SettingsProvider>
  );
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

// Same branching as the `beforeEach` stub, over a caller-supplied item list
// instead of the fixed `ITEMS` fixture. The sort tests below need bugs whose
// exact `created`/`started` values carry the assertion, and `ITEMS` cannot
// grow to hold them: several tests above assert exact `col-count` numbers
// against it, so a shared fixture is the one thing a sort-order test must
// not touch.
function stubItems(items: BacklogItem[], runs: RunPayload[] = []) {
  (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    const payload: unknown = url.includes('/api/agents/status') ? AGENTS_STATUS
      : url.includes('/api/orchestrator/runs') ? ({ runs } satisfies OrchestratorRunsPayload)
        : url.includes('/api/projects') ? PROJECTS : { items, errors: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  });
}

describe('BoardView', () => {
  it('titles itself Board, matching the rail tab that opens it', async () => {
    await renderBoard();
    // Not "Projects", which is what this said while the rail tab said it too.
    // A nav entry names a place, not a type, and this place holds bugs, ideas
    // and refactors as well as tasks — narrowing to one project is the
    // toolbar's job, one line to the right of this title.
    expect(screen.getByText('Board')).toHaveClass('board-title');
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
  });

  it('renders the four columns with counts of what they hold (open by default)', async () => {
    await renderBoard();
    const cols = screen.getAllByTestId('board-col');
    // The design's order, and exactly four of them: out-of-scope has no
    // column on this surface at all any more — it belongs to Archive.
    expect(cols.map((c) => within(c).getByTestId('col-name').textContent))
      .toEqual(['Refactoring', 'Ideas', 'Bugs', 'Tasks']);
    // done task-9 and done ref-2 hidden by the default open filter
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent))
      .toEqual(['1', '1', '2', '1']);
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
    // this task's own UI broke. Asserted for every column, not just the
    // busiest one: the reorder moved which index each section sits at, and a
    // per-column check is what makes a header land on the wrong stack of
    // cards fail here rather than somewhere downstream.
    expect(cols.map((c) => String(c.querySelectorAll('.board-card').length)))
      .toEqual(cols.map((c) => within(c).getByTestId('col-count').textContent));
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

  // The kind badge, and the three ways it stays silent. Written as one test
  // because the four cards have to be on the board together: "renders for a
  // known kind" and "renders for nothing else" are the same claim, and split
  // across two tests a badge that rendered unconditionally would still pass
  // the first one.
  it('badges a refactor kind it knows, and nothing else', async () => {
    stubItems([
      fakeItem({ id: 'ref-1', title: 'a chore', section: 'refactors', groomed: null, kind: 'chore' }),
      fakeItem({ id: 'ref-2', title: 'some debt', section: 'refactors', groomed: null, kind: 'debt' }),
      // Preserved on disk and reported verbatim by the API (see items.test.ts),
      // but not badged: a badge reading `whatever` would present a typo as a
      // category, and a new kind is meant to cost one entry in REFACTOR_KINDS.
      fakeItem({ id: 'ref-3', title: 'oddly classified', section: 'refactors', groomed: null, kind: 'whatever' }),
      // Gated on the section as well as the value: `kind` means nothing on a
      // bug, so a hand-added one must not sprout a badge.
      fakeItem({ id: 'bug-1', title: 'a bug with a kind', kind: 'debt' })
    ]);
    await renderBoard();

    const kindOf = (title: string): HTMLElement | null =>
      screen.getByText(title).closest('.board-card')!.querySelector('.board-card-kind');

    expect(kindOf('a chore')).toHaveTextContent('chore');
    expect(kindOf('some debt')).toHaveTextContent('debt');
    expect(kindOf('oddly classified')).toBeNull();
    expect(kindOf('a bug with a kind')).toBeNull();
  });

  // Same placement rule the groomed marker and the elapsed mark are pinned to:
  // a sibling of the meta line, not a child of it. The meta line is
  // nowrap-with-ellipsis in about 118px, so a badge appended inside it renders
  // as `ref-1 · aug 3…` and tells nobody anything.
  it('places the kind badge outside the meta line, inside the card footer', async () => {
    stubItems([fakeItem({ id: 'ref-1', title: 'some debt', section: 'refactors', groomed: null, kind: 'debt' })]);
    await renderBoard();

    const badge = screen.getByText('debt');
    expect(badge).toHaveClass('board-card-kind');
    expect(badge.closest('.board-card-meta')).toBeNull();
    expect(badge.closest('.board-card-foot')).not.toBeNull();
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

  // Done is a filter value over the same four type columns, not a view of its
  // own: a done task renders in Tasks, under the Tasks header, exactly where
  // its open siblings do.
  it('status filter: done shows only done items, inside their own type columns', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent))
      .toEqual(['1', '0', '0', '1']);
    // ref-2 in Refactoring, task-9 in Tasks — not pooled into one "done" list.
    expect(within(cols[0]).getByText('oddly classified')).toBeInTheDocument();
    expect(within(cols[3]).getByText('finished task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
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
      .toEqual(['0', '0', '1', '0']);
    expect(screen.getByText('groomed bug')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
    // task-9 is done but carries a started stamp — "started but no longer
    // open" stays excluded.
    expect(screen.queryByText('finished task')).not.toBeInTheDocument();
  });

  // The eviction, asserted at every status value rather than only the default.
  // out-of-scope used to BYPASS the status predicate (Open/Done/All showed it
  // regardless of status, and only 'started' was ordered in front of the
  // bypass to keep a terminal card out of a live-work view). With the section
  // off the board entirely there is no value it can reappear under — including
  // 'all', the one a re-added bypass would look most correct beneath.
  it('renders no out-of-scope item in any column, at any status filter value', async () => {
    await renderBoard();
    for (const value of ['open', 'started', 'done', 'all']) {
      await userEvent.selectOptions(screen.getByLabelText('Status'), value);
      expect(screen.queryByText('declined thing')).not.toBeInTheDocument();
      // Nor a column to put it in.
      expect(screen.queryByText('Out of scope')).not.toBeInTheDocument();
    }
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
    // Index 2: Bugs is the third column now — Refactoring · Ideas · Bugs · Tasks.
    const bugsCol = screen.getAllByTestId('board-col')[2];
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
    // Index 2: Bugs is the third column now — Refactoring · Ideas · Bugs · Tasks.
    const bugsCol = screen.getAllByTestId('board-col')[2];
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
    // Index 2: Bugs is the third column now — Refactoring · Ideas · Bugs · Tasks.
    const bugsCol = screen.getAllByTestId('board-col')[2];
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

  /*
   * Task 5 — the Board/Archive split, seen from the Board's side. The
   * predicate's own arithmetic is pinned in test/item-stale.test.ts against a
   * fixed instant; what these cases prove is the wiring: that BoardView reads
   * it at all, reads the window from Settings rather than a constant, and
   * applies the task exemption where the design put it.
   *
   * Every fixture here sets `updated` explicitly, including the fresh ones —
   * the shared builder's default is already fresh, but a staleness test whose
   * fresh case depends on a default defined ninety lines away is a test that
   * stops meaning anything the day that default changes.
   */
  const STALE_STAMP = agoISO(200 * 24 * 60 * 60 * 1000);
  const FRESH_STAMP = agoISO(2 * 24 * 60 * 60 * 1000);

  it('drops a stale refactor, idea and bug off the board', async () => {
    stubItems([
      fakeItem({ id: 'ref-7', title: 'old refactor', section: 'refactors', groomed: null, updated: STALE_STAMP }),
      fakeItem({ id: 'idea-7', title: 'old idea', section: 'ideas', groomed: null, updated: STALE_STAMP }),
      fakeItem({ id: 'bug-7', title: 'old bug', updated: STALE_STAMP }),
      fakeItem({ id: 'bug-8', title: 'recent bug', updated: FRESH_STAMP })
    ]);
    await renderBoard();
    expect(screen.queryByText('old refactor')).not.toBeInTheDocument();
    expect(screen.queryByText('old idea')).not.toBeInTheDocument();
    expect(screen.queryByText('old bug')).not.toBeInTheDocument();
    expect(screen.getByText('recent bug')).toBeInTheDocument();
  });

  // The exemption the design argues for at length: a task is committed work,
  // so one rotting for months is a fact to be made to look at rather than one
  // to tidy away. It keeps its column and says so on its face.
  it('keeps a stale task on the board and marks it', async () => {
    stubItems([
      fakeItem({ id: 'task-7', title: 'old task', section: 'tasks', groomed: true, updated: STALE_STAMP })
    ]);
    await renderBoard();
    const card = screen.getByText('old task').closest('.board-card') as HTMLElement;
    const marker = within(card).getByText('stale');
    expect(marker).toHaveClass('board-card-stale');
    // Beside the meta line, not inside it — the same nowrap-with-ellipsis
    // clipping the groomed marker had to be moved out of.
    expect(marker.closest('.board-card-meta')).toBeNull();
    expect(marker.closest('.board-card-foot')).not.toBeNull();
  });

  it('marks no fresh task', async () => {
    stubItems([
      fakeItem({ id: 'task-8', title: 'new task', section: 'tasks', groomed: true, updated: FRESH_STAMP })
    ]);
    await renderBoard();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  // `started` outranks the arithmetic: someone is on this right now, so
  // "nobody has touched it in months" is simply false however old the stamp.
  it('keeps an in-progress item with a stale stamp, unmarked', async () => {
    stubItems([
      fakeItem({
        id: 'idea-8', title: 'live idea', section: 'ideas', groomed: null,
        updated: STALE_STAMP, started: agoISO(30 * 60 * 1000)
      })
    ]);
    await renderBoard();
    expect(screen.getByText('live idea')).toBeInTheDocument();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  /*
   * bug-11 — the same rule read from its second source. A run stamps
   * `started:` on its own worktree's copy of the item, so the copy this board
   * renders is silent for the whole run and the case above cannot save it: the
   * one card the run strip and the rank exist to point at was the one card not
   * on the board. Ordering is asserted alongside presence because rendering it
   * somewhere is only half the fix — `liveRank` ranks a dispatched item 1
   * against the fresh sibling's 2, so it belongs at the top of the column.
   */
  it('keeps a stale bug a fresh run holds, at the top of its column', async () => {
    stubItems(
      [
        fakeItem({ id: 'bug-7', title: 'old bug', updated: STALE_STAMP }),
        fakeItem({ id: 'bug-8', title: 'recent bug', updated: FRESH_STAMP })
      ],
      [runHolding('bug-7', 'dispatched')]
    );
    await renderBoard();
    // Index 2: Bugs is the third column — Refactoring · Ideas · Bugs · Tasks.
    const bugsCol = screen.getAllByTestId('board-col')[2];
    await waitFor(() => {
      const titles = Array.from(bugsCol.querySelectorAll('.board-card-title'))
        .map((el) => el.textContent);
      expect(titles).toEqual(['old bug', 'recent bug']);
    });
  });

  /* The control, and the reason the exemption is not "any run that mentions
     the item": a run that stopped heartbeating is not working anything, so the
     file's own reckoning is the honest one again and the card goes back to
     Archive. Same fixture, same stage, one flag different. */
  it('sends that same bug to Archive when the run holding it has gone stale', async () => {
    stubItems(
      [
        fakeItem({ id: 'bug-7', title: 'old bug', updated: STALE_STAMP }),
        fakeItem({ id: 'bug-8', title: 'recent bug', updated: FRESH_STAMP })
      ],
      [runHolding('bug-7', 'dispatched', { fresh: false })]
    );
    await renderBoard();
    // The poll has to have actually landed before an absence means anything —
    // otherwise this passes on a board that has not read the payload yet.
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/orchestrator/runs')
    ));
    expect(screen.getByText('recent bug')).toBeInTheDocument();
    expect(screen.queryByText('old bug')).not.toBeInTheDocument();
  });

  // A done item is finished, not neglected, and the Board's `Done` filter is
  // the only surface that shows it — so staleness must not reach it. Without
  // the `status === 'open'` condition in `isStale`, this bug vanishes from
  // every view the app has.
  it('still shows a long-finished bug under the done filter', async () => {
    stubItems([
      fakeItem({ id: 'bug-9', title: 'ancient fix', status: 'done', updated: STALE_STAMP }),
      // A live card purely so the board renders its columns rather than the
      // "no matches" empty state under the default open filter — the done
      // item is the one under test and is invisible until the filter moves.
      fakeItem({ id: 'bug-13', title: 'something open', updated: FRESH_STAMP })
    ]);
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');
    expect(screen.getByText('ancient fix')).toBeInTheDocument();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  // The window is a setting, not a constant: the same item is on the board
  // under the 30-day default and gone under a 7-day one. This is the
  // "changing the window in Settings visibly moves items between the two
  // surfaces" half of the task's own done-when, asserted at the seam where
  // the setting reaches the filter.
  const TEN_DAYS = agoISO(10 * 24 * 60 * 60 * 1000);
  const tenDayFixture = () => stubItems([
    fakeItem({ id: 'bug-10', title: 'ten days quiet', updated: TEN_DAYS }),
    fakeItem({ id: 'bug-13', title: 'yesterday', updated: FRESH_STAMP })
  ]);

  it('keeps a ten-day-old bug under the default window', async () => {
    tenDayFixture();
    await renderBoardWithSettings();
    expect(screen.getByText('ten days quiet')).toBeInTheDocument();
  });

  // The same item, the same fixture, one stored setting different. Together
  // with the case above this is the task's own done-when — "changing the
  // window in Settings visibly moves items between the two surfaces" —
  // asserted at the seam where the stored value reaches the filter, which is
  // the part a click in Settings cannot prove on its own.
  it('drops that same bug once the stored window is seven days', async () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ staleDays: 7 }));
    tenDayFixture();
    await renderBoardWithSettings();
    // The fresh sibling is what makes the absence mean "archived" rather than
    // "the board never rendered".
    expect(screen.getByText('yesterday')).toBeInTheDocument();
    expect(screen.queryByText('ten days quiet')).not.toBeInTheDocument();
  });

  // An item whose `created` is old and whose `updated` was never written —
  // which is every file on disk the day this ships. The fallback is what makes
  // that first load archive genuinely old work rather than nothing at all.
  it('falls back to created when no updated stamp was ever written', async () => {
    stubItems([
      fakeItem({ id: 'bug-11', title: 'never stamped', created: daysAgoDate(200), updated: '' }),
      fakeItem({ id: 'bug-12', title: 'filed today', created: daysAgoDate(0), updated: '' })
    ]);
    await renderBoard();
    expect(screen.queryByText('never stamped')).not.toBeInTheDocument();
    expect(screen.getByText('filed today')).toBeInTheDocument();
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
