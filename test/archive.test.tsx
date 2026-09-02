/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import ArchiveView from '../client/src/components/archive/ArchiveView';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentsStatus, BacklogItem, ItemsIndex, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary,
  RunQueueItem, RunStage
} from '../shared/types';

/*
 * Every clock-dependent fixture here is RELATIVE to the moment the suite runs,
 * for the reason board.test.tsx states at length: a literal date silently
 * changes meaning as the calendar moves past it, and this suite's whole subject
 * is a 30-day window. `STALE` is comfortably outside the default window and
 * `FRESH` comfortably inside it, so neither can land on the boundary on some
 * particular day of the year.
 *
 * The one exception is the month-grouping case below, which needs three
 * DIFFERENT months and therefore builds its stamps by walking backwards from
 * today — see its own comment.
 */
const daysAgo = (days: number): string =>
  `${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19)}Z`;
const STALE = daysAgo(90);
const FRESH = daysAgo(1);

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  // Annotated, not inferred: without a contextual type the object literal's
  // `section`/`status` widen to plain `string`. Same reasoning board.test.tsx
  // gives for its own factory.
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-01-05', started: '', tags: [],
    // Stale by default — this is the Archive suite, so the interesting fixture
    // is the one that belongs here and the exceptions say so explicitly.
    updated: STALE, lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1.md',
    ...over
  };
  // Derived after the spread so every fixture has a unique key — ArchiveView
  // keys each card on `path`, and ids are only sequential within one project.
  return { ...base, path: over.path ?? `${base.projectPath}/backlog/${base.section}/${base.status}/${base.id}.md` };
}

const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 1, ideas: 1, tasks: 0, refactors: 1, 'out-of-scope': 1 } },
  { name: 'beta', path: '/abs/beta', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 1, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 } }
];

// A real answer rather than an off/unreachable stand-in, so every archived card
// gets an ENABLED dispatch control and the two promotion-path cases below are
// asserting what a working dashboard actually produces.
const AGENTS_STATUS: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha', '/abs/beta']
};

type RunPayload = OrchestratorRunsPayload['runs'][number];

/** One fresh run for `/abs/alpha` holding exactly `id` at `stage`. Built off
 *  the contract fixture, like every other suite that needs a run payload.
 *  bug-11 is what gave this surface a reason to vary the runs it is handed:
 *  before it, the only thing reading them here was `runClaimBlock`, which no
 *  case in this file exercises. */
function runHolding(id: string, stage: RunStage, over: Partial<RunPayload> = {}): RunPayload {
  const fixture = rawFixture as OrchestratorRun;
  const entry: RunQueueItem = { ...fixture.queue[0], id, stage };
  return { ...fixture, project: '/abs/alpha', queue: [entry], fresh: true, pastRuns: 0, ...over };
}

function stubItems(items: BacklogItem[], errors: string[] = [], runs: RunPayload[] = []) {
  const index: ItemsIndex = { items, errors };
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload: unknown = url.includes('/api/agents/status') ? AGENTS_STATUS
      : url.includes('/api/orchestrator/runs') ? ({ runs } satisfies OrchestratorRunsPayload)
        : url.includes('/api/projects') ? PROJECTS : index;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
}

/** The default corpus: one of each thing Archive has an opinion about. */
const ITEMS: BacklogItem[] = [
  fakeItem({ id: 'bug-1', title: 'stale bug' }),
  fakeItem({ id: 'bug-2', title: 'fresh bug', updated: FRESH }),
  fakeItem({ id: 'idea-1', title: 'stale idea', section: 'ideas', groomed: null }),
  fakeItem({ id: 'ref-1', title: 'stale refactor', section: 'refactors', groomed: null, kind: 'debt' }),
  fakeItem({ id: 'task-1', title: 'stale task', section: 'tasks', groomed: true }),
  fakeItem({ id: 'oos-1', title: 'declined thing', section: 'out-of-scope', status: 'terminal', groomed: null, updated: FRESH }),
  fakeItem({ id: 'bug-8', title: 'old fixed bug', status: 'done', groomed: true }),
  fakeItem({ id: 'ref-8', title: 'old done refactor', section: 'refactors', status: 'done', groomed: null }),
  fakeItem({ id: 'task-8', title: 'old done task', section: 'tasks', status: 'done', groomed: true }),
  fakeItem({ id: 'bug-3', title: 'stale beta bug', project: 'beta', projectPath: '/abs/beta' })
];

/*
 * Waits on the loading state clearing, not on a column appearing: several cases
 * below assert an EMPTY state, where no column ever renders. The title is no
 * use either — it is outside the fetch-state ladder and is on screen from the
 * first paint.
 */
async function renderArchive(
  items: BacklogItem[] = ITEMS, errors: string[] = [], runs: RunPayload[] = []
) {
  stubItems(items, errors, runs);
  render(<ArchiveView />);
  await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
}

/** The column with this heading, or a failure naming what was there instead. */
function column(label: string): HTMLElement {
  const cols = screen.getAllByTestId('archive-col');
  const found = cols.find((c) => within(c).getByTestId('col-name').textContent === label);
  if (found === undefined) {
    throw new Error(`no ${label} column; found ${cols.map((c) => within(c).getByTestId('col-name').textContent).join(', ')}`);
  }
  return found;
}

beforeEach(() => {
  localStorage.clear();
});

describe('ArchiveView', () => {
  it('titles itself Archive and renders the design\'s four columns in order', async () => {
    await renderArchive();
    // Refactoring · Ideas · Bugs · Out of scope — three of the Board's sections
    // seen from the far side of the window, plus the one it has no column for.
    // No Tasks column: a task never leaves the Board, so one here could only
    // ever be empty.
    expect(screen.getByText('Archive')).toHaveClass('board-title');
    expect(screen.getAllByTestId('archive-col').map((c) => within(c).getByTestId('col-name').textContent))
      .toEqual(['Refactoring', 'Ideas', 'Bugs', 'Out of scope']);
  });

  it('renders an out-of-scope item in its own column and in no other', async () => {
    await renderArchive();
    expect(within(column('Out of scope')).getByText('declined thing')).toBeInTheDocument();
    for (const label of ['Refactoring', 'Ideas', 'Bugs']) {
      expect(within(column(label)).queryByText('declined thing')).not.toBeInTheDocument();
    }
  });

  it('archives a rejection however recently it was touched', async () => {
    // `oos-1` above carries a FRESH stamp deliberately: an out-of-scope item is
    // here on the strength of the rejection, never on the strength of a date,
    // so the section arm of the predicate has no age in it at all.
    await renderArchive();
    expect(within(column('Out of scope')).getByText('declined thing')).toBeInTheDocument();
  });

  it('renders the stale open refactor, idea and bug', async () => {
    // The positive case. Without it every "does not appear" assertion below
    // would pass just as happily on an Archive that renders nothing at all.
    await renderArchive();
    expect(within(column('Refactoring')).getByText('stale refactor')).toBeInTheDocument();
    expect(within(column('Ideas')).getByText('stale idea')).toBeInTheDocument();
    expect(within(column('Bugs')).getByText('stale bug')).toBeInTheDocument();
  });

  /*
   * bug-11, from the side that proves the two surfaces stayed complementary.
   * The Board case (test/board.test.tsx) shows the card arriving there; this
   * one shows it leaving here, on the same predicate and the same payload. If
   * the exemption had been written into BoardView's filter instead of into
   * `leavesBoard`, this test is the one that would still be red — the item
   * would be in both surfaces at once, which is the single thing the shared
   * module exists to make impossible.
   */
  it('drops a stale bug a fresh run holds', async () => {
    await renderArchive(ITEMS, [], [runHolding('bug-1', 'dispatched')]);
    await waitFor(() =>
      expect(within(column('Bugs')).queryByText('stale bug')).not.toBeInTheDocument());
    // The other stale sections are untouched — this is one item's run, not a
    // blanket "some run exists, empty the surface".
    expect(within(column('Ideas')).getByText('stale idea')).toBeInTheDocument();
  });

  /* The control for the case above, and its own test rather than a second half
     of it: `column()` searches the whole document, so a second `renderArchive`
     in one case mounts a second tree and every query keeps answering out of
     the first one. */
  it('keeps that same bug once the run holding it has gone stale', async () => {
    await renderArchive(ITEMS, [], [runHolding('bug-1', 'dispatched', { fresh: false })]);
    expect(within(column('Bugs')).getByText('stale bug')).toBeInTheDocument();
  });

  it('renders no done item in any column, however old', async () => {
    // Done is not stale — it is finished. `isStale` answers false for it, so it
    // is in neither surface's columns and is reachable only through the Board's
    // own Done status filter. All three fixtures carry the 90-day stamp.
    await renderArchive();
    for (const title of ['old fixed bug', 'old done refactor', 'old done task']) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });

  it('renders no stale task — a task never leaves the Board', async () => {
    await renderArchive();
    expect(screen.queryByText('stale task')).not.toBeInTheDocument();
  });

  it('renders no fresh item', async () => {
    await renderArchive();
    expect(within(column('Bugs')).queryByText('fresh bug')).not.toBeInTheDocument();
  });

  it('counts what each column actually holds', async () => {
    await renderArchive();
    // refactors 1, ideas 1, bugs 2 (alpha's stale one and beta's), oos 1.
    expect(screen.getAllByTestId('archive-col').map((c) => within(c).getByTestId('col-count').textContent))
      .toEqual(['1', '1', '2', '1']);
  });

  it('offers project and search, and neither a status nor a sort select', async () => {
    await renderArchive();
    expect(screen.getByLabelText('Project')).toBeInTheDocument();
    expect(screen.getByLabelText('Search items')).toBeInTheDocument();
    // Archive's contents are defined by staleness and rejection, not by status
    // — a status select here would be a control that either does nothing or
    // contradicts the surface it sits on. Sort is absent because the month
    // grouping is the ordering.
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sort')).not.toBeInTheDocument();
  });

  it('groups a column under month subheaders, newest month first', async () => {
    /*
     * Stamps walked back from today rather than written literally, so the three
     * months are always three DIFFERENT months whatever the date is: 40, 75 and
     * 110 days ago cannot collapse into one calendar month, and all three are
     * outside the 30-day window.
     */
    const items = [
      // Deliberately not in date order in the fixture, so the assertion is
      // about the grouping rather than about the fetch order surviving.
      fakeItem({ id: 'bug-2', title: 'middle', updated: daysAgo(75) }),
      fakeItem({ id: 'bug-3', title: 'oldest', updated: daysAgo(110) }),
      fakeItem({ id: 'bug-1', title: 'newest', updated: daysAgo(40) })
    ];
    await renderArchive(items);

    const headings = within(column('Bugs')).getAllByTestId('archive-month').map((h) => h.textContent);
    expect(headings).toHaveLength(3);
    // Three distinct months, and the cards under them in the same descending
    // order — a heading order that was right while the cards underneath were
    // shuffled would pass a headings-only assertion.
    expect(new Set(headings).size).toBe(3);
    expect(within(column('Bugs')).getAllByText(/newest|middle|oldest/).map((c) => c.textContent))
      .toEqual(['newest', 'middle', 'oldest']);
  });

  it('sorts an item with no dates at all into an "undated" group, last', async () => {
    /*
     * Only reachable in the Out of scope column, and that is worth stating: an
     * item with no usable stamp reads as FRESH to `isStale` (a malformed file
     * has to stay where someone will see it), so it can never arrive in
     * Archive's three stale columns. A rejection arrives on the strength of the
     * rejection alone, so it can — and the grouping has to have an answer for
     * it rather than a NaN month.
     */
    const items = [
      fakeItem({ id: 'oos-1', title: 'no stamps at all', section: 'out-of-scope', status: 'terminal', groomed: null, created: '', updated: '' }),
      fakeItem({ id: 'oos-2', title: 'dated rejection', section: 'out-of-scope', status: 'terminal', groomed: null, updated: daysAgo(40) })
    ];
    await renderArchive(items);

    const headings = within(column('Out of scope')).getAllByTestId('archive-month').map((h) => h.textContent);
    expect(headings).toHaveLength(2);
    // Last, though '' sorts FIRST as a string — the rule groupByMonth has to
    // apply by hand.
    expect(headings[1]).toBe('undated');
    expect(within(column('Out of scope')).getAllByText(/no stamps at all|dated rejection/).map((c) => c.textContent))
      .toEqual(['dated rejection', 'no stamps at all']);
  });

  it('offers groom on a stale card — the path that brings it back to the Board', async () => {
    await renderArchive();
    // A groom session's own start/stop refreshes `updated:`, and the item is on
    // the Board at the next load. The board itself writes nothing.
    const card = within(column('Bugs')).getByText('stale bug').closest('.board-card') as HTMLElement;
    expect(within(card).getByRole('button', { name: 'groom' })).toBeInTheDocument();
  });

  it('offers capture on a rejected card — the path that revives it as a new item', async () => {
    await renderArchive();
    // Not groom, and not a move: `moveItem` refuses every move out of
    // out-of-scope, so reviving a rejection is a NEW item citing `from: oos-1`.
    // The word comes from the same `deriveAction` the server re-derives and
    // 409s against.
    const card = within(column('Out of scope')).getByText('declined thing').closest('.board-card') as HTMLElement;
    expect(within(card).getByRole('button', { name: 'capture' })).toBeInTheDocument();
  });

  it('narrows to one project', async () => {
    await renderArchive();
    expect(within(column('Bugs')).getByText('stale beta bug')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/abs/alpha');
    expect(within(column('Bugs')).queryByText('stale beta bug')).not.toBeInTheDocument();
    expect(within(column('Bugs')).getByText('stale bug')).toBeInTheDocument();
  });

  it('narrows on title', async () => {
    await renderArchive();
    await userEvent.type(screen.getByLabelText('Search items'), 'refactor');
    expect(screen.getByText('stale refactor')).toBeInTheDocument();
    expect(screen.queryByText('stale bug')).not.toBeInTheDocument();
  });

  it('says "nothing archived yet" when the corpus holds nothing stale or rejected', async () => {
    // Distinct from "no matches" on purpose: this one is good news about the
    // backlog, not a narrowing accident, and telling the reader to adjust
    // controls that are working would be the wrong instruction.
    await renderArchive([fakeItem({ id: 'bug-2', title: 'fresh bug', updated: FRESH })]);
    expect(screen.getByText('nothing archived yet')).toBeInTheDocument();
  });

  it('says "no matches" when a filter empties a non-empty archive', async () => {
    await renderArchive();
    await userEvent.type(screen.getByLabelText('Search items'), 'zzzz');
    expect(screen.getByText('no matches')).toBeInTheDocument();
    expect(screen.queryByText('nothing archived yet')).not.toBeInTheDocument();
  });

  it('says "nothing registered yet" for an empty index', async () => {
    await renderArchive([]);
    expect(screen.getByText('nothing registered yet')).toBeInTheDocument();
  });

  it('reports the registry\'s own warnings, since Archive can be the landing section', async () => {
    await renderArchive(ITEMS, ['/abs/alpha/backlog/ideas/open/idea-9-broken.md: frontmatter has no closing --- line']);
    expect(within(screen.getByTestId('board-warn')).getByText(/idea-9-broken/)).toBeInTheDocument();
  });

  it('opens the drawer from a card', async () => {
    await renderArchive();
    await userEvent.click(within(column('Bugs')).getByText('stale bug'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('stale bug');
  });
});
