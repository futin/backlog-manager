/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';
import BoardView from '../client/src/components/board/BoardView';
import { RunChip, runChipReading } from '../client/src/components/board/RunChip';
import rawFixture from './fixtures/orchestrator-run.json';
import type { AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary, StartingRun } from '../shared/types';

/**
 * `RunChip` — everything the Board still says about orchestrator runs
 * (DESIGN.md §8.3). It replaces three components at once: the run strip above
 * the columns, `StartingStrip` and `RunDrawer`, whose suites
 * (`orchestrator-strip`, `starting-strip`, `orchestrator-drawer`) this file
 * inherits the still-live half of.
 *
 * What is being pinned, in the order the design states it:
 *
 *  1. the dot takes the WORST state present — crashed over paused or starting
 *     over live — and the count line names every state that is;
 *  2. the `starting` array renders with NO client-side filter, which is the
 *     rule `StartingStrip` carried and the one thing about this control that
 *     is a server guarantee rather than a rendering choice (bug-21);
 *  3. nothing at all — not an empty chip — when the payload carries no run and
 *     no starting entry;
 *  4. a click calls the same section setter the rail's Runs entry calls.
 *
 * The split is the one the strip's own suites had: the reading is a pure
 * function pinned without a render, the chip's markup is pinned against it,
 * and the board-level cases prove `BoardView` hands it the real payload.
 */
const fixture = rawFixture as OrchestratorRun;

type ChipRun = { status: OrchestratorRun['status']; fresh: boolean };

const live: ChipRun = { status: 'running', fresh: true };
/** `status: 'running'` with a stale heartbeat — `isCrashed`'s own definition
 *  (lib/run-watchdog.ts), which this chip reads rather than restating. */
const crashed: ChipRun = { status: 'running', fresh: false };
const paused: ChipRun = { status: 'paused', fresh: false };
/** A run that finished and then went stale. Still a run in the payload — the
 *  endpoint keeps a project's last run file until the next `init` archives it
 *  — and so still counted, which is why the chip reads `1 run ›` rather than
 *  disappearing. The strip it replaces rendered nothing for this state; the
 *  chip's own rule is absence only when there is no run AND no starting
 *  entry. */
const finished: ChipRun = { status: 'done', fresh: false };

const starting = (project: string): StartingRun => ({ project, requestedAt: new Date().toISOString() });

describe('runChipReading', () => {
  it('is null for an empty payload — no run, no starting entry', () => {
    expect(runChipReading([], [])).toBeNull();
  });

  /**
   * The design's own three worked examples (spec §3.2, DESIGN.md §8.3),
   * verbatim. They are the whole specification of the wording, which is why
   * they are asserted as literal strings rather than as a pattern: the two
   * rules behind them (a lead segment counting the runs; each state named with
   * its count unless that count IS the run total) were derived to reproduce
   * exactly these, and a change that broke one of them would be a change to
   * the design rather than to the code.
   */
  it('reads the three worked examples exactly', () => {
    expect(runChipReading([live, finished], [])?.line).toBe('2 runs · 1 live');
    expect(runChipReading([crashed], [])?.line).toBe('1 run · crashed');
    expect(runChipReading([], [starting('/abs/alpha')])?.line).toBe('1 starting');
  });

  /**
   * Precedence, stated as the design states it: crashed over (paused or
   * starting) over live. Each case pins the dot AND that the line still names
   * every state present — a chip that resolved the dot by dropping the other
   * states would pass a dot-only assertion and tell a reader less than the
   * strip did.
   */
  it('takes the worst state for the dot and names all of them in the line', () => {
    const all = runChipReading([crashed, paused, live], []);
    expect(all?.tone).toBe('crashed');
    expect(all?.line).toBe('3 runs · 1 crashed · 1 paused · 1 live');
  });

  it('paints paused over live', () => {
    // `--fill-live` is `Dot`'s `live` tone; the design gives it to paused and
    // starting, and gives a live run `--fill-progress` (the `done` tone). The
    // names are the primitive's, the tokens are the design's — see RunChip's
    // own comment for why the mismatch is deliberate rather than a bug.
    expect(runChipReading([paused, live], [])?.tone).toBe('live');
  });

  it('paints starting over live', () => {
    expect(runChipReading([live], [starting('/abs/beta')])?.tone).toBe('live');
  });

  it('paints live when nothing worse is present', () => {
    expect(runChipReading([live, live], [])?.tone).toBe('done');
    expect(runChipReading([live, live], [])?.line).toBe('2 runs · live');
  });

  /**
   * A payload of nothing but finished runs: still a chip, with no state word
   * at all AND no tone at all. This is the case the "absent only when there is
   * no run and no starting entry" rule produces and the one a reader is most
   * likely to mistake for a bug, so both halves are pinned rather than left to
   * follow from the examples above.
   *
   * `tone: null` is the assertion that matters. The only thing the props could
   * otherwise have said here is `done`, which paints `--fill-progress` — the
   * token §8.3 assigns to a LIVE run — so a board on which nothing is running
   * would have drawn the same green as one mid-run, told apart only by a
   * missing word and an absent `breathe` ring. A dot that says "no state" has
   * to look like no state; the rendered half is pinned below.
   */
  it('counts a finished run with no state word and no tone', () => {
    const reading = runChipReading([finished], []);
    expect(reading?.line).toBe('1 run');
    expect(reading?.tone).toBeNull();
  });

  /** ...and the state words are still what separates the two readings: a live
   *  run and a finished one both count as `1 run`, and only one of them names
   *  a state or earns a tone. Asserted as a pair, because "the dot is quiet
   *  for a finished run" only means something beside "the dot is not quiet for
   *  a live one". */
  it('tells a finished run from a live one by both the word and the tone', () => {
    expect(runChipReading([finished], [])).toMatchObject({ line: '1 run', tone: null });
    expect(runChipReading([live], [])).toMatchObject({ line: '1 run · live', tone: 'done' });
  });
});

describe('RunChip', () => {
  it('renders nothing at all for an empty payload', () => {
    const { container } = render(<RunChip runs={[]} starting={[]} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a button whose accessible name is the reading, and whose click opens Runs', async () => {
    const onOpen = jest.fn();
    render(<RunChip runs={[crashed]} starting={[]} onOpen={onOpen} />);

    // The `›` is decoration and is aria-hidden: if it ever reaches the
    // accessible name, this query stops matching and so does a screen
    // reader's rendering of the control.
    const button = screen.getByRole('button', { name: '1 run · crashed' });
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  /** The dot is `Dot`'s, by class — the primitive owns the paint, so this is
   *  the only place the tone is observable without a stylesheet. */
  it('wears the worst state as its dot class', () => {
    const { rerender } = render(<RunChip runs={[crashed, live]} starting={[]} onOpen={() => {}} />);
    expect(screen.getByTestId('run-chip').querySelector('.ui-dot')).toHaveClass('ui-dot-crashed');

    rerender(<RunChip runs={[paused, live]} starting={[]} onOpen={() => {}} />);
    expect(screen.getByTestId('run-chip').querySelector('.ui-dot')).toHaveClass('ui-dot-live');

    rerender(<RunChip runs={[live]} starting={[]} onOpen={() => {}} />);
    expect(screen.getByTestId('run-chip').querySelector('.ui-dot')).toHaveClass('ui-dot-done');
  });

  /**
   * The rendered half of the stateless reading: a finished-only payload draws
   * `.ui-dot`'s base and NO tone class. The negative is checked as "no tone
   * class at all" rather than "not `ui-dot-done`", because the failure this
   * guards is a fallback tone of any name — and `ui-dot-undefined`, which is
   * what an unguarded optional prop produces, would slip past the narrower
   * check while painting the right colour for the wrong reason.
   */
  it('draws a quiet, toneless dot when every run has finished', () => {
    render(<RunChip runs={[finished]} starting={[]} onOpen={() => {}} />);

    const dot = screen.getByTestId('run-chip').querySelector('.ui-dot') as HTMLElement;
    expect(dot).toBeInTheDocument();
    expect(Array.from(dot.classList).filter((c) => c.startsWith('ui-dot-') && c !== 'ui-dot-8')).toEqual([]);
  });

  /* §8.8's one motion mechanism, and the one state it may assert: a ring
     pulsing around a crashed or paused run would be an animation saying
     something false. */
  it('breathes only while something is actually running', () => {
    const { rerender } = render(<RunChip runs={[live]} starting={[]} onOpen={() => {}} />);
    expect(screen.getByTestId('run-chip').querySelector('.ui-dot')).toHaveClass('ui-dot-breathe');

    rerender(<RunChip runs={[crashed]} starting={[]} onOpen={() => {}} />);
    expect(screen.getByTestId('run-chip').querySelector('.ui-dot')).not.toHaveClass('ui-dot-breathe');
  });
});

describe('BoardView: the run chip', () => {
  const PROJECTS: ProjectSummary[] = [
    {
      name: 'alpha',
      path: '/abs/alpha',
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
      name: 'beta',
      path: '/abs/beta',
      createdAt: '2026-08-26T00:00:00.000Z',
      missing: false,
      counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
      source: 'files',
      repo: null,
      polledAt: null,
      access: null,
      detail: null
    }
  ];

  const AGENTS_STATUS: AgentsStatus = {
    enabled: true,
    reachable: true,
    remoteAnswer: true,
    spawnAvailable: true,
    spawnMaxPermission: 'auto',
    projectPaths: ['/abs/alpha', '/abs/beta']
  };

  const ITEM: BacklogItem = {
    id: 'bug-1',
    title: 'a bug',
    created: '2026-08-20',
    started: '',
    tags: [],
    updated: new Date().toISOString(),
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
    untyped: false
  };

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    localStorage.clear();
  });

  type Payload = OrchestratorRun & { fresh: boolean; pastRuns: number; pauseRequested: boolean };

  function run(over: Partial<Payload>): Payload {
    return { ...fixture, fresh: true, pastRuns: 0, pauseRequested: false, ...over };
  }

  function stub(runs: Payload[], startingRuns: StartingRun[] = []): void {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload: unknown = url.includes('/api/agents/status')
        ? AGENTS_STATUS
        : url.includes('/api/orchestrator/runs')
          ? ({ runs, starting: startingRuns } satisfies OrchestratorRunsPayload)
          : url.includes('/api/projects')
            ? PROJECTS
            : { items: [ITEM], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    }) as unknown as typeof fetch;
  }

  async function renderBoard(): Promise<void> {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
  }

  it('renders no chip when the payload carries neither a run nor a starting entry', async () => {
    stub([]);
    await renderBoard();
    expect(screen.queryByTestId('run-chip')).toBeNull();
  });

  it('counts two live runs on two projects as one chip', async () => {
    stub([run({ project: '/abs/alpha' }), run({ runId: 'run-2', project: '/abs/beta' })]);
    await renderBoard();
    await waitFor(() => expect(screen.getByTestId('run-chip')).toHaveTextContent('2 runs · live'));
  });

  /**
   * bug-21's rule, carried forward from `StartingStrip`: the `starting` array
   * is rendered with no client-side filter at all. The subtraction that used
   * to live in `BoardView` is `StartingRunsService.expired()`'s third
   * eviction rule now, and keeping a filter here beside it would be two
   * expressions that merely agree — the shape this repo pins tests against
   * everywhere else (`watchdogStoodDown`, `isStale`).
   *
   * So this case sends what the server actually sends for a project whose
   * spawn has resolved but whose `run.json` has not landed: a starting entry
   * and no run.
   */
  it('renders a starting entry that has no run file yet', async () => {
    stub([], [starting('/abs/alpha')]);
    await renderBoard();
    await waitFor(() => expect(screen.getByTestId('run-chip')).toHaveTextContent('1 starting'));
  });

  it('counts a starting entry beside another project’s live run', async () => {
    stub([run({ project: '/abs/beta' })], [starting('/abs/alpha')]);
    await renderBoard();
    await waitFor(() => expect(screen.getByTestId('run-chip')).toHaveTextContent('1 run · 1 starting · live'));
  });

  /**
   * The wiring, asserted against the SETTER rather than the rendered Runs
   * page: what this proves is that the chip calls the same section change the
   * rail's own Runs entry calls, and `App` is where that function lives. The
   * rail's entry is clicked first so the two are compared against one
   * observable — the section `AppShell` persists — rather than against an
   * assumption about which one is "correct".
   */
  it('opens the Runs section, the same way the rail does', async () => {
    stub([run({ project: '/abs/alpha' })]);
    render(<App />);

    await userEvent.click(await screen.findByTestId('run-chip'));

    // `AppShell`'s `change` does two things — it swaps the rendered section
    // and it persists the choice — and the chip goes through it rather than
    // round some other way, so both have to have happened. The stored key is
    // the observable the rail's own click writes; a chip that merely swapped
    // the view would leave it on `board`.
    await waitFor(() => expect(JSON.parse(localStorage.getItem('backlog-manager.section') ?? 'null')).toBe('runs'));
    expect(screen.queryByText('Bugs')).not.toBeInTheDocument();
  });
});
