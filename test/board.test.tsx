/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { buildProjectHues } from '../client/src/lib/project-hue';
import { daysAgoDate } from './helpers/dates';
import { clearFilters, pickDirection, pickProject, pickSort, pickStatus } from './helpers/filter-bar';
import rawFixture from './fixtures/orchestrator-run.json';
import type { AgentsStatus, BacklogItem, ItemsIndex, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary, RunQueueItem, RunStage } from '../shared/types';

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
 * fights userEvent, which this file uses for the filter popovers. Relative
 * values also cannot drift the wrong way: elapsed only ever grows between the
 * fixture being built and the assertion running, and every rung floors, so
 * `3h` stays `3h`.
 *
 * `CREATED` carries the current year for the same reason: `formatCreated` drops
 * the year only when it matches now's, so a hard-coded 2026 would silently
 * start asserting the wrong string on 1 January.
 *
 * `CREATED` is also the one fixture date in this tree that is deliberately NOT a `daysAgo*` call (bug-44), because the meta-line assertion below pins
 * the rendered string `aug 20` and a moving date cannot produce a fixed month. What makes that safe is the `updated` stamp two lines down, not luck:
 * `lastTouched` reads `updated` first, so the fixed month never reaches `isStale` and no card here can age off the Board. Change that default and this
 * constant becomes a date-bomb of exactly the kind `test/fixture-clock.test.ts` exists to prevent — which that guard cannot see, since it scans for a
 * date literal written as a fixture value and this one is behind a name.
 */
const agoISO = (ms: number): string => `${new Date(Date.now() - ms).toISOString().slice(0, 19)}Z`;
const CREATED = `${new Date().getUTCFullYear()}-08-20`;

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  // Annotated (not inferred): without a contextual type here, the object
  // literal's `section`/`status` widen to plain `string` and fail against
  // `Section`/`ItemStatus` below — the annotation is what keeps them narrowed.
  const base: BacklogItem = {
    id: 'bug-1',
    title: 'a bug',
    created: CREATED,
    started: '',
    tags: [],
    // Fresh by default, and RELATIVE, so Task 5's staleness split leaves this
    // suite's fixtures on the Board whatever day it runs. `created` stays the
    // fixed `aug 20` the meta-line assertion needs, and an `updated` stamp is
    // exactly what stops that literal month from silently archiving every
    // fixture here once the calendar passes the window — the fallback to
    // `created` is a real rule (see item-stale.test.ts), just not one this
    // suite's shared fixture should be sitting on.
    updated: agoISO(0),
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'bugs',
    status: 'open',
    project: 'alpha',
    projectPath: '/abs/alpha',
    groomed: false,
    path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
    source: 'files',
    url: null,
    assignee: null,
    untyped: false,
    ...over
  };
  return { ...base, path: over.path ?? `${base.projectPath}/backlog/${base.section}/${base.status}/${base.id}.md` };
}

const ITEMS: ItemsIndex = {
  items: [
    fakeItem({}),
    fakeItem({ id: 'bug-2', title: 'groomed bug', groomed: true, started: agoISO(3 * 60 * 60 * 1000) }),
    fakeItem({ id: 'task-1', title: 'a task', section: 'tasks', project: 'beta', projectPath: '/abs/beta', groomed: true }),
    fakeItem({ id: 'task-9', title: 'finished task', section: 'tasks', status: 'done', groomed: true, started: daysAgoDate(50) }),
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
  {
    name: 'alpha',
    path: '/abs/alpha',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 2, ideas: 1, tasks: 0, refactors: 0, 'out-of-scope': 1 },
    source: 'files',
    repo: null,
    polledAt: null,
    access: null,
    detail: null,
    interval: null
  },
  {
    name: 'beta',
    path: '/abs/beta',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 1, refactors: 0, 'out-of-scope': 0 },
    source: 'files',
    repo: null,
    polledAt: null,
    access: null,
    detail: null,
    interval: null
  },
  {
    name: 'ghost',
    path: '/abs/ghost',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: true,
    counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
    source: null,
    repo: null,
    polledAt: null,
    access: null,
    detail: null,
    interval: null
  }
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
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: ['/abs/alpha', '/abs/beta']
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
const NO_RUNS: OrchestratorRunsPayload = { runs: [], starting: [], remote: [] };

/** One fresh run for `/abs/alpha` holding exactly `id` at `stage`. Built off
 *  the contract fixture, like every other suite that needs a run payload, so
 *  the shape stays the real one. */
function runHolding(id: string, stage: RunStage, over: Partial<RunPayload> = {}): RunPayload {
  const fixture = rawFixture as OrchestratorRun;
  const entry: RunQueueItem = { ...fixture.queue[0], id, stage };
  return { ...fixture, project: '/abs/alpha', queue: [entry], fresh: true, pastRuns: 0, pauseRequested: false, stopRequested: false, ...over };
}

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.includes('/api/agents/status')
      ? AGENTS_STATUS
      : url.includes('/api/orchestrator/runs')
        ? NO_RUNS
        : url.includes('/api/projects')
          ? PROJECTS
          : ITEMS;
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
// `projects` is for the one case that needs a registry `PROJECTS` cannot be: two checkouts of one repo, sharing a name (Review Focus 2).
function stubItems(items: BacklogItem[], runs: RunPayload[] = [], projects: ProjectSummary[] = PROJECTS) {
  (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    const payload: unknown = url.includes('/api/agents/status')
      ? AGENTS_STATUS
      : url.includes('/api/orchestrator/runs')
        ? ({ runs, starting: [], remote: [] } satisfies OrchestratorRunsPayload)
        : url.includes('/api/projects')
          ? projects
          : { items, errors: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  });
}

/** The Bugs column's card titles, top to bottom — Bugs is index 2 (Refactoring · Ideas · Bugs · Tasks). Every sort case below reads it. */
const bugTitles = (): (string | null)[] =>
  Array.from(screen.getAllByTestId('board-col')[2].querySelectorAll('.board-card-title')).map((el) => el.textContent);

/** The track's `Sort: <key> (<dir>)` reading. `/^Sort:/` and not `Sort by`, which is the sort popover's own header. */
const sortLabel = (): HTMLElement => screen.getByText(/^Sort:/);

/** The band's title text — the picked project's name, or `All projects`. */
const bandTitle = (): string | null | undefined => document.querySelector('.ui-band .ui-band-title')?.textContent;

/** How many cards the four columns hold between them, read off each column's own count. */
const shownCount = (): number =>
  screen.getAllByTestId('board-col').reduce((n, c) => n + Number(within(c).getByTestId('col-count').textContent), 0);

describe('BoardView', () => {
  /* The band's title names the board's scope, not the place: the rail tab already says `Board`, and the title said it too until it was asked to say
     what the board is showing. `All projects` with no project picked — the pressed chip's own words — and the project's name once one is. */
  it('titles itself All projects, then the picked project, then All projects again', async () => {
    await renderBoard();
    expect(bandTitle()).toBe('All projects');
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();

    await pickProject('alpha');
    expect(bandTitle()).toBe('alpha');

    await pickProject('All projects');
    expect(bandTitle()).toBe('All projects');
  });

  /**
   * The band, composed (DESIGN.md §8.3): `Band` carries the title and the count line, its right slot carries the run chip, the 36 px search field, the
   * filter track (`FilterBar` — the funnel, `Sort: <key> (<dir>)` and the sort button) and — last, and the page's ONE ink chip — Orchestrate.
   *
   * What is being pinned is the COMPOSITION, because that is what the design spec's §12.1 rule is about: the track's own look and mechanics are
   * `test/filter-bar.test.tsx`'s, and this case only proves the Board puts it where the design says and that nothing of the old row of selects is left
   * beside it. Orchestrate's four visibility rules stay pinned by `test/orchestrator-start-ui.test.tsx`; here it is only its place, after the track.
   */
  it('composes the band: title, count line, search, the filter track, and Orchestrate after it once a project is picked', async () => {
    await renderBoard();

    const band = document.querySelector('.ui-band') as HTMLElement;
    expect(band).not.toBeNull();
    // The old row was three native selects; none survives anywhere in the band.
    expect(band.querySelector('select')).toBeNull();
    const search = within(band).getByLabelText('Search items');
    expect(search).toHaveClass('board-band-search');
    const filters = within(band).getByRole('button', { name: 'Filters' });
    expect(within(band).getByRole('button', { name: 'Change sort' })).toBeInTheDocument();
    expect(search.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await pickProject('alpha');
    const orchestrate = await within(band).findByRole('button', { name: 'Orchestrate' });
    const track = band.querySelector('.filter-bar-wrap') as HTMLElement;
    expect(track).not.toBeNull();
    expect(track.compareDocumentPosition(orchestrate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // After the track, not inside it: the track is filter and sort, and Orchestrate is the band's own control.
    expect(track.contains(orchestrate)).toBe(false);
  });

  /* The band's 13 px count line is gone: the title names the scope, and the columns count what they hold. */
  it('draws no count line under the title', async () => {
    await renderBoard();
    expect(document.querySelector('.ui-band .ui-band-sub')).toBeNull();
    await pickProject('alpha');
    expect(document.querySelector('.ui-band .ui-band-sub')).toBeNull();
  });

  it('renders the four columns with counts of what they hold (open by default)', async () => {
    await renderBoard();
    const cols = screen.getAllByTestId('board-col');
    // The design's order, and exactly four of them: out-of-scope has no
    // column on this surface at all any more — it belongs to Archive.
    expect(cols.map((c) => within(c).getByTestId('col-name').textContent)).toEqual(['Refactoring', 'Ideas', 'Bugs', 'Tasks']);
    // done task-9 and done ref-2 hidden by the default open filter
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent)).toEqual(['1', '1', '2', '1']);
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
    expect(cols.map((c) => String(c.querySelectorAll('.board-card').length))).toEqual(cols.map((c) => within(c).getByTestId('col-count').textContent));
    expect(screen.queryByText('finished task')).not.toBeInTheDocument();
  });

  it('marks groomed bugs, pills the project, and shows id · short date on the card', async () => {
    await renderBoard();
    const card = screen.getByText('groomed bug').closest('.board-card') as HTMLElement;
    // Beside the meta line, not inside it: inside, the nowrap-with-ellipsis
    // clipped it to `· gr…` at the real column width.
    const groomed = within(card).getByText('groomed');
    expect(groomed).toHaveClass('ui-marker', 'ui-marker-groomed');
    expect(groomed.closest('.board-card-meta')).toBeNull();
    // Its own row since task-37 (DESIGN.md §8.3), no longer wedged into the
    // foot beside the project and the id.
    expect(groomed.closest('.board-card-markers')).not.toBeNull();
    // A dot plus the name carries the project — not the type, which the column
    // already states — and the meta line carries what is left. The dot takes
    // the same hue assignment the pill it replaced did, through the same
    // module, which is why `hueFor` and `classFor` are asserted as one answer.
    expect(within(card).getByText('alpha')).toHaveClass('board-card-proj-name');
    const dot = card.querySelector('.ui-dot') as HTMLElement;
    expect(dot).toHaveClass(`ui-dot-proj-${buildProjectHues(PROJECTS).hueFor('alpha')}`);
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
      const payload = url.includes('/api/agents/status')
        ? AGENTS_STATUS
        : url.includes('/api/projects')
          ? PROJECTS
          : { items: [fakeItem({ id: 'bug-4', title: 'undated bug', created: '' })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const meta = screen.getByText('undated bug').closest('.board-card')!.querySelector('.board-card-meta') as HTMLElement;
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
    // The card itself carries no live class any more: §8.3 gives it no stroke
    // to recolour, and the strip below is the whole marker.
    expect(live).not.toHaveClass('board-card-live');

    const bar = live.querySelector('.board-card-live') as HTMLElement;
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

    // One fill, and the hatch over it (DESIGN.md §8.3): the cyan/amber split
    // task-9 drew is gone, and the stage word carries the distinction the
    // second tone used to.
    expect(bar).toHaveClass('hatch');
    expect(bar).not.toHaveClass('board-card-live-bar-run');

    // The negative half matters as much: without it, a strip rendered
    // unconditionally would pass every assertion above.
    const idle = screen.getByText('a bug').closest('.board-card') as HTMLElement;
    expect(idle.querySelector('.board-card-live')).toBeNull();
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

    const kindOf = (title: string): HTMLElement | null => screen.getByText(title).closest('.board-card')!.querySelector('.ui-marker-kind');

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
    expect(badge).toHaveClass('ui-marker', 'ui-marker-kind');
    expect(badge.closest('.board-card-meta')).toBeNull();
    expect(badge.closest('.board-card-markers')).not.toBeNull();
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

    const groomingBar = screen.getByText('being groomed').closest('.board-card')!.querySelector('.board-card-live') as HTMLElement;
    expect(within(groomingBar).getByText('grooming')).toBeInTheDocument();

    const plainBar = screen.getByText('plain live').closest('.board-card')!.querySelector('.board-card-live') as HTMLElement;
    expect(within(plainBar).getByText('in progress')).toBeInTheDocument();
  });

  it('reads the elapsed time in minutes for work picked up this hour', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status')
        ? AGENTS_STATUS
        : url.includes('/api/projects')
          ? PROJECTS
          : { items: [fakeItem({ id: 'bug-5', title: 'just started', started: agoISO(20 * 60 * 1000) })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const bar = screen.getByText('just started').closest('.board-card')!.querySelector('.board-card-live') as HTMLElement;
    expect(within(bar).getByText('20m')).toBeInTheDocument();
  });

  // Every file stamped before `start` wrote a time carries a bare date, and
  // nothing rewrites them — so this is a shape the card renders forever, aged in
  // days because a bare date carries no hour to read.
  it('ages a legacy date-only started value in days', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status')
        ? AGENTS_STATUS
        : url.includes('/api/projects')
          ? PROJECTS
          : { items: [fakeItem({ id: 'bug-6', title: 'legacy start', started: daysAgoDate(1) })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const bar = screen.getByText('legacy start').closest('.board-card')!.querySelector('.board-card-live') as HTMLElement;
    expect(within(bar).getByText('1d')).toBeInTheDocument();
  });

  // Nothing validates the shape of `started` on the way in: the CLI writes it,
  // but a person can edit the file. The bar still has to say someone is on this
  // — dropping only the unreadable half — and must never print NaN.
  it('renders the bar without an elapsed reading when started cannot be parsed', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status')
        ? AGENTS_STATUS
        : url.includes('/api/projects')
          ? PROJECTS
          : { items: [fakeItem({ id: 'bug-8', title: 'hand edited', started: 'soon' })], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    await renderBoard();

    const card = screen.getByText('hand edited').closest('.board-card') as HTMLElement;
    const bar = card.querySelector('.board-card-live') as HTMLElement;
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
    await pickStatus('Done');
    const card = screen.getByText('finished task').closest('.board-card') as HTMLElement;
    expect(card.querySelector('.board-card-live')).toBeNull();
    expect(within(card).getByText('done')).toHaveClass('ui-marker', 'ui-marker-done');
  });

  it('colours the dot by project, not by section', async () => {
    await renderBoard();
    // alpha's bug and alpha's idea: different columns, so under the old
    // section-keyed pill these two carried different classes. Same project now
    // means the same class, which is the whole point — a project reads as one
    // colour straight across the board. The mark is a `Dot` since task-37; the
    // assignment behind it did not move.
    const dotIn = (title: string): string => (screen.getByText(title).closest('.board-card')!.querySelector('.ui-dot') as HTMLElement).className;

    expect(dotIn('an idea')).toBe(dotIn('a bug'));

    // ...and beta, a different project, does not — otherwise "same class
    // everywhere" would also pass on a constant.
    expect(dotIn('a task')).not.toBe(dotIn('a bug'));
  });

  // Done is a filter value over the same four type columns, not a view of its
  // own: a done task renders in Tasks, under the Tasks header, exactly where
  // its open siblings do.
  it('status filter: done shows only done items, inside their own type columns', async () => {
    await renderBoard();
    await pickStatus('Done');
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent)).toEqual(['1', '0', '0', '1']);
    // ref-2 in Refactoring, task-9 in Tasks — not pooled into one "done" list.
    expect(within(cols[0]).getByText('oddly classified')).toBeInTheDocument();
    expect(within(cols[3]).getByText('finished task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
  });

  it('the Status switch offers Open, In progress, Done and All, in that order', async () => {
    await renderBoard();
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const group = within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('group', { name: 'Status' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open', 'In progress', 'Done', 'All']);
  });

  it('status filter: in progress narrows to open items carrying a started stamp', async () => {
    await renderBoard();
    await pickStatus('In progress');
    // Only bug-2 ("groomed bug") is open with a started stamp; task-9 is
    // started but done, and everything else carries no stamp at all.
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent)).toEqual(['0', '0', '1', '0']);
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
    for (const label of ['Open', 'In progress', 'Done', 'All'] as const) {
      await pickStatus(label);
      expect(screen.queryByText('declined thing')).not.toBeInTheDocument();
      // Nor a column to put it in.
      expect(screen.queryByText('Out of scope')).not.toBeInTheDocument();
    }
  });

  it('project filter narrows every column by projectPath, and the title names the project', async () => {
    await renderBoard();
    await pickProject('beta');
    expect(screen.getByText('a task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
    // Every column, not only the one the assertion above happens to look at: beta's one open item is a task.
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent)).toEqual(['0', '0', '0', '1']);
    expect(bandTitle()).toBe('beta');
  });

  /*
   * The Filters popover, from the Board's side (the band-filter spec's §2, §3). `FilterBar`'s own mechanics — the badge, the raised look, Clear all's
   * inertness, one popover at a time — are `test/filter-bar.test.tsx`'s; what is pinned here is what the BOARD hands it: its hint, its count, its reset,
   * and the fail-open project value rather than the raw stored one.
   */
  it('the open Filters dialog carries the Board’s hint beside Project', async () => {
    await renderBoard();
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(within(screen.getByRole('dialog', { name: 'Filters' })).getByText('· one at a time — Orchestrate needs one')).toBeInTheDocument();
  });

  it('passes count 0 on a default board, so Clear all is inert', async () => {
    await renderBoard();
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('button', { name: 'Clear all' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('Clear all after picking alpha and Done restores all projects and Open', async () => {
    await renderBoard();
    await pickProject('alpha');
    await pickStatus('Done');
    expect(screen.getByRole('button', { name: 'Filters, 2 set' })).toBeInTheDocument();
    expect(bandTitle()).toBe('alpha');
    expect(shownCount()).toBe(2);

    await clearFilters();
    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(within(dialog).getByRole('group', { name: 'Project' })).getByRole('button', { pressed: true })).toHaveTextContent('All projects');
    expect(within(within(dialog).getByRole('group', { name: 'Status' })).getByRole('button', { pressed: true })).toHaveTextContent('Open');
    expect(bandTitle()).toBe('All projects');
    expect(shownCount()).toBe(5);
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  /* A status value this build never wrote — the Status filter's stored value is deliberately unvalidated (see the comment over `resolveSortKey`
     in BoardView.tsx). It lights nothing in the switch, counts as set, and narrows the board to nothing; the raised button and Clear all are the way
     back. The board has no columns to wait on here — it renders the no-matches state — so the render waits on that instead of `renderBoard`. */
  it('a stored unrecognised status lights no Status option, counts as one set, and Clear all recovers', async () => {
    localStorage.setItem('backlog-manager.status', JSON.stringify('stale'));
    render(<BoardView />);
    expect(await screen.findByText('no matches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Filters, 1 set' }));
    const status = within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('group', { name: 'Status' });
    expect(within(status).queryAllByRole('button', { pressed: true })).toHaveLength(0);

    await clearFilters();
    expect(within(status).getByRole('button', { pressed: true })).toHaveTextContent('Open');
    expect(shownCount()).toBe(5);
  });

  // Review Focus 2: two checkouts of one repo share a name and never a path. Both get a chip, and the second one narrows to the second path alone.
  it('two registered projects named alpha get two chips, and picking the second shows only its items', async () => {
    const twin = (path: string): ProjectSummary => ({ ...PROJECTS[0], path });
    stubItems(
      [
        fakeItem({ id: 'bug-1', title: 'first checkout', projectPath: '/a/alpha' }),
        fakeItem({ id: 'bug-1', title: 'second checkout', projectPath: '/b/alpha' })
      ],
      [],
      [twin('/a/alpha'), twin('/b/alpha')]
    );
    await renderBoard();
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(within(screen.getByRole('group', { name: 'Project' })).getAllByRole('button', { name: 'alpha' })).toHaveLength(2);

    await pickProject('alpha', 1);
    expect(screen.getByText('second checkout')).toBeInTheDocument();
    expect(screen.queryByText('first checkout')).not.toBeInTheDocument();
    expect(bandTitle()).toBe('alpha');
  });

  // Review Focus 3: a stored path whose project has since been unregistered fails open — and the badge, the pressed chip and the title all read
  // the fail-open value, so none of them claims a filter the board is not applying.
  it('a stale stored project path reads as All projects: no badge, All projects pressed, All projects titled', async () => {
    localStorage.setItem('backlog-manager.project', JSON.stringify('/abs/gone'));
    await renderBoard();
    const button = screen.getByRole('button', { name: 'Filters' });
    expect(button.querySelector('.filter-bar-badge')).toBeNull();
    expect(shownCount()).toBe(5);
    // The title fails open with the board, never naming a project that is gone.
    expect(bandTitle()).toBe('All projects');

    await userEvent.click(button);
    const picks = within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('group', { name: 'Project' });
    expect(within(picks).getByRole('button', { pressed: true })).toHaveTextContent('All projects');
  });

  // Review Focus 4: `FilterBar` keeps its own open state, so it must not remount when a pick changes the band around it — Orchestrate appearing after
  // the track is exactly such a change. Same element before and after, so a remount that happened to reopen would still fail.
  it('picking a project with the popover open keeps that popover open, alone, while Orchestrate appears', async () => {
    await renderBoard();
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const before = screen.getByRole('dialog', { name: 'Filters' });

    await pickProject('alpha');
    expect(await screen.findByRole('button', { name: 'Orchestrate' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBe(before);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  // Review Focus 5: Clear all resets the two filters it counts, and nothing it does not — the search is visible in its own field, and sort is not a filter.
  it('Clear all leaves the typed search and the chosen sort alone', async () => {
    await renderBoard();
    await userEvent.type(screen.getByLabelText('Search items'), 'bug');
    await pickSort('Name');
    await pickProject('alpha');
    await clearFilters();
    expect(screen.getByLabelText('Search items')).toHaveValue('bug');
    expect(sortLabel()).toHaveTextContent('Sort: Name (asc)');
  });

  // The primary sort key: in-progress ranks above everything else, and the
  // selected comparator only breaks ties inside each half. Newest-first is
  // the default in play here specifically so a broken primary key produces a
  // plausible-looking wrong answer (plain newest-on-top) instead of an
  // assertion that would pass by accident either way.
  it('an in-progress card sorts above a newer one under Created (desc), the default', async () => {
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
    await pickSort('Name');
    // Index 2: Bugs is the third column now — Refactoring · Ideas · Bugs · Tasks.
    const bugsCol = screen.getAllByTestId('board-col')[2];
    const titles = Array.from(bugsCol.querySelectorAll('.board-card-title')).map((el) => el.textContent);
    expect(titles).toEqual(['alpha-live', 'zulu-live', 'beta-idle', 'yankee-idle']);
  });

  // A stored sort key this build has no comparator for — hand-edited, or written
  // by a later build the user has since rolled back. `usePersistedState` parses
  // whatever JSON it finds and hands the string straight back (the `SortKey`
  // type is a claim about what this build WRITES, never about what it can read),
  // so it misses `COMPARATORS`. Without a fallback that miss is called
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
    // And the track says so. The order alone cannot tell `resolveSortKey` from a `COMPARATORS[sort] ?? COMPARATORS.created` lookup inside `sortItems` —
    // both draw created-desc here — but only the resolved key reaches the track: the raw one prints `Sort: newest ()` (FilterBar's label falls back to
    // the key, and `NATURAL_DIR` has no direction for it) over a board ordered by Created, and ticks no row in the panel.
    expect(sortLabel()).toHaveTextContent('Sort: Created (desc)');
    await userEvent.click(screen.getByRole('button', { name: 'Change sort' }));
    const sortPanel = screen.getByRole('dialog', { name: 'Sort by' });
    expect(within(sortPanel).getByRole('button', { name: 'Created' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sortPanel).getByRole('button', { name: 'Name' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(sortPanel).getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'false');
  });

  // The same storage, holding something that is not a string at all. `usePersistedState` hands a number back as itself, and shallow-merges an object
  // over the `'created'` fallback — so `{}` arrives as `{0: 'c', 1: 'r', …}`. A key looked up raw would survive the comparator (`?? COMPARATORS.created`
  // catches the miss) and then reach the track: `42` prints as the sort's name, and the object is rendered as a React child, which throws inside render
  // and — with no ErrorBoundary in client/src — blanks the page. `resolveSortKey` accepts own-property strings only, so both read as `Created (desc)`.
  it.each([
    ['an object', {}],
    ['a number', 42]
  ])('a stored sort key that is %s renders the board under Created (desc)', async (_what, stored) => {
    localStorage.setItem('backlog-manager.sort', JSON.stringify(stored));
    stubItems([
      fakeItem({ id: 'bug-old', title: 'old-idle', created: daysAgoDate(10) }),
      fakeItem({ id: 'bug-new', title: 'new-idle', created: daysAgoDate(0) }),
      fakeItem({ id: 'bug-mid', title: 'mid-idle', created: daysAgoDate(5) })
    ]);
    await renderBoard();
    expect(screen.getAllByTestId('board-col')).toHaveLength(4);
    expect(bugTitles()).toEqual(['new-idle', 'mid-idle', 'old-idle']);
    expect(sortLabel()).toHaveTextContent('Sort: Created (desc)');
  });

  /*
   * Sort direction (the band-filter spec's §3). Three idle bugs whose name order and created order disagree, fetched in an order that matches neither
   * direction of either key — so every assertion below can only pass if the comparator it names actually ran, in the direction it names:
   *   name asc  alpha-t, bravo, charlie      created desc  alpha-t (0d), charlie (2d), bravo (5d)
   *   name desc charlie, bravo, alpha-t      created asc   bravo, charlie, alpha-t
   */
  const SORTABLE = (): BacklogItem[] => [
    fakeItem({ id: 'bug-c', title: 'charlie', created: daysAgoDate(2) }),
    fakeItem({ id: 'bug-a', title: 'alpha-t', created: daysAgoDate(0) }),
    fakeItem({ id: 'bug-b', title: 'bravo', created: daysAgoDate(5) })
  ];

  it('Name orders A→Z ascending and Z→A descending; Created descending is newest first', async () => {
    stubItems(SORTABLE());
    await renderBoard();
    await pickSort('Name');
    await pickDirection('Ascending');
    expect(bugTitles()).toEqual(['alpha-t', 'bravo', 'charlie']);
    await pickDirection('Descending');
    expect(bugTitles()).toEqual(['charlie', 'bravo', 'alpha-t']);

    await pickSort('Created');
    await pickDirection('Descending');
    expect(bugTitles()).toEqual(['alpha-t', 'charlie', 'bravo']);
    await pickDirection('Ascending');
    expect(bugTitles()).toEqual(['bravo', 'charlie', 'alpha-t']);
  });

  // The direction flips the key's OWN comparison only: `project`'s tie-break is newest first inside each project in both directions.
  it('Project descending orders projects Z→A and keeps newest first inside each project', async () => {
    const beta = { project: 'beta', projectPath: '/abs/beta' };
    stubItems([
      fakeItem({ id: 'bug-1', title: 'a-old', created: daysAgoDate(5) }),
      fakeItem({ id: 'bug-2', title: 'b-old', created: daysAgoDate(4), ...beta }),
      fakeItem({ id: 'bug-3', title: 'a-new', created: daysAgoDate(1) }),
      fakeItem({ id: 'bug-4', title: 'b-new', created: daysAgoDate(0), ...beta })
    ]);
    await renderBoard();
    await pickSort('Project');
    expect(bugTitles()).toEqual(['a-new', 'a-old', 'b-new', 'b-old']);
    await pickDirection('Descending');
    expect(bugTitles()).toEqual(['b-new', 'b-old', 'a-new', 'a-old']);
  });

  // `liveRank` is the primary key in both directions. The live card is the MIDDLE one by date, so neither direction puts it first by accident.
  it('an in-progress card leads its column under Created in both directions', async () => {
    stubItems([
      fakeItem({ id: 'bug-new', title: 'new-idle', created: daysAgoDate(0) }),
      fakeItem({ id: 'bug-old', title: 'old-idle', created: daysAgoDate(10) }),
      fakeItem({ id: 'bug-mid', title: 'mid-live', created: daysAgoDate(5), started: agoISO(60 * 60 * 1000) })
    ]);
    await renderBoard();
    expect(sortLabel()).toHaveTextContent('Sort: Created (desc)');
    expect(bugTitles()).toEqual(['mid-live', 'new-idle', 'old-idle']);
    await pickDirection('Ascending');
    expect(bugTitles()).toEqual(['mid-live', 'old-idle', 'new-idle']);
  });

  /* Each key's natural direction: a DIFFERENT key arrives in its own (`Name` never opens Z→A because `Created` was descending), and re-picking the
     current key leaves whatever direction the reader chose. */
  it('picking a different key sets its natural direction; re-picking the current key leaves the direction', async () => {
    await renderBoard();
    expect(sortLabel()).toHaveTextContent('Sort: Created (desc)');
    await pickSort('Name');
    expect(sortLabel()).toHaveTextContent('Sort: Name (asc)');

    await pickSort('Created');
    expect(sortLabel()).toHaveTextContent('Sort: Created (desc)');
    await pickDirection('Ascending');
    expect(sortLabel()).toHaveTextContent('Sort: Created (asc)');
    await pickSort('Created');
    expect(sortLabel()).toHaveTextContent('Sort: Created (asc)');
  });

  it('a stored unrecognised direction falls back to the key’s natural one', async () => {
    localStorage.setItem('backlog-manager.sort', JSON.stringify('name'));
    localStorage.setItem('backlog-manager.sort-dir', JSON.stringify('sideways'));
    stubItems(SORTABLE());
    await renderBoard();
    expect(sortLabel()).toHaveTextContent('Sort: Name (asc)');
    expect(bugTitles()).toEqual(['alpha-t', 'bravo', 'charlie']);
  });

  // Review Focus 1: a reader who picked `By name` before the direction existed has the key stored and no direction at all. They land where they were —
  // A→Z — and not on a board-wide `desc` default, which is why the direction's fallback is `null` and resolved per key.
  it('a stored sort key with no direction stored lands on that key’s natural direction', async () => {
    localStorage.setItem('backlog-manager.sort', JSON.stringify('name'));
    stubItems(SORTABLE());
    await renderBoard();
    expect(sortLabel()).toHaveTextContent('Sort: Name (asc)');
    expect(bugTitles()).toEqual(['alpha-t', 'bravo', 'charlie']);
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
    stubItems([fakeItem({ id: 'task-7', title: 'old task', section: 'tasks', groomed: true, updated: STALE_STAMP })]);
    await renderBoard();
    const card = screen.getByText('old task').closest('.board-card') as HTMLElement;
    const marker = within(card).getByText('stale');
    expect(marker).toHaveClass('ui-marker', 'ui-marker-stale');
    // On the marker row, not in the meta line — the same nowrap-with-ellipsis
    // clipping the groomed marker had to be moved out of.
    expect(marker.closest('.board-card-meta')).toBeNull();
    expect(marker.closest('.board-card-markers')).not.toBeNull();
  });

  it('marks no fresh task', async () => {
    stubItems([fakeItem({ id: 'task-8', title: 'new task', section: 'tasks', groomed: true, updated: FRESH_STAMP })]);
    await renderBoard();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  // `started` outranks the arithmetic: someone is on this right now, so
  // "nobody has touched it in months" is simply false however old the stamp.
  it('keeps an in-progress item with a stale stamp, unmarked', async () => {
    stubItems([
      fakeItem({
        id: 'idea-8',
        title: 'live idea',
        section: 'ideas',
        groomed: null,
        updated: STALE_STAMP,
        started: agoISO(30 * 60 * 1000)
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
      [fakeItem({ id: 'bug-7', title: 'old bug', updated: STALE_STAMP }), fakeItem({ id: 'bug-8', title: 'recent bug', updated: FRESH_STAMP })],
      [runHolding('bug-7', 'dispatched')]
    );
    await renderBoard();
    // Index 2: Bugs is the third column — Refactoring · Ideas · Bugs · Tasks.
    const bugsCol = screen.getAllByTestId('board-col')[2];
    await waitFor(() => {
      const titles = Array.from(bugsCol.querySelectorAll('.board-card-title')).map((el) => el.textContent);
      expect(titles).toEqual(['old bug', 'recent bug']);
    });
  });

  /* The control, and the reason the exemption is not "any run that mentions
     the item": a run that stopped heartbeating is not working anything, so the
     file's own reckoning is the honest one again and the card goes back to
     Archive. Same fixture, same stage, one flag different. */
  it('sends that same bug to Archive when the run holding it has gone stale', async () => {
    stubItems(
      [fakeItem({ id: 'bug-7', title: 'old bug', updated: STALE_STAMP }), fakeItem({ id: 'bug-8', title: 'recent bug', updated: FRESH_STAMP })],
      [runHolding('bug-7', 'dispatched', { fresh: false })]
    );
    await renderBoard();
    // The poll has to have actually landed before an absence means anything —
    // otherwise this passes on a board that has not read the payload yet.
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/orchestrator/runs')));
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
    await pickStatus('Done');
    expect(screen.getByText('ancient fix')).toBeInTheDocument();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  // The window is a setting, not a constant: the same item is on the board
  // under the 30-day default and gone under a 7-day one. This is the
  // "changing the window in Settings visibly moves items between the two
  // surfaces" half of the task's own done-when, asserted at the seam where
  // the setting reaches the filter.
  const TEN_DAYS = agoISO(10 * 24 * 60 * 60 * 1000);
  const tenDayFixture = () =>
    stubItems([fakeItem({ id: 'bug-10', title: 'ten days quiet', updated: TEN_DAYS }), fakeItem({ id: 'bug-13', title: 'yesterday', updated: FRESH_STAMP })]);

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
