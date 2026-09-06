/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { StartingStrip } from '../client/src/components/board/StartingStrip';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary,
  RunWatchdog, StartingRun
} from '../shared/types';

// The same cast every suite reading this fixture makes — plain JSON widens
// its string fields to `string` rather than the literal unions BoardView
// keys its behaviour on.
const fixture = rawFixture as OrchestratorRun;

type Payload = OrchestratorRun & { fresh: boolean; pastRuns: number; pauseRequested: boolean; watchdog?: RunWatchdog };

/**
 * task-14's placeholder row — the card the board shows for the 1–5 minutes
 * between pressing Start and `orchestrate.mjs init` writing a run file.
 *
 * The cases that actually decide whether this is right are the collision
 * ones (a starting entry arriving alongside a fresh run, and alongside a
 * CRASHED one): the board must render exactly one row per project in both,
 * and the crashed case is the one the server cannot fix for it — `init`
 * refuses a run file that still says `running`, so no new run ever lands,
 * the server's eviction rule 1 never matches, and the entry survives the
 * full RUN_STALE_MS.
 */
describe('StartingStrip', () => {
  function startingRun(over: Partial<StartingRun> = {}): StartingRun {
    return { project: '/abs/alpha', requestedAt: new Date().toISOString(), ...over };
  }

  it('names the project and says starting, with an elapsed off requestedAt', () => {
    render(
      <StartingStrip
        starting={startingRun({ requestedAt: '2026-09-05T12:00:00.000Z' })}
        now={Date.parse('2026-09-05T12:02:00.000Z')}
      />
    );

    const strip = screen.getByTestId('starting-strip');
    expect(strip).toHaveTextContent('alpha');
    expect(strip).toHaveTextContent('starting…');
    expect(strip).toHaveTextContent('2m');
  });

  it('renders no progress bar and no percentage', () => {
    // A 0%-filled bar reads as a run stalled on its first item, which is a
    // worse claim than the honest absence of one: there is no queue yet.
    const { container } = render(<StartingStrip starting={startingRun()} />);

    expect(container.querySelector('.run-strip-bar')).toBeNull();
    expect(container.querySelector('.run-strip-bar-fill')).toBeNull();
    expect(screen.getByTestId('starting-strip').textContent).not.toMatch(/%|\d+\/\d+/);
  });

  it('is not a control — there is no run to open a drawer onto', () => {
    render(<StartingStrip starting={startingRun()} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('prints an em dash rather than NaN for an unparseable requestedAt', () => {
    render(<StartingStrip starting={startingRun({ requestedAt: 'not-a-date' })} />);

    expect(screen.getByTestId('starting-strip')).toHaveTextContent('—');
    expect(screen.getByTestId('starting-strip').textContent).not.toMatch(/NaN/);
  });
});

describe('BoardView: the starting placeholder beside real run strips', () => {
  const PROJECTS: ProjectSummary[] = [
    { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
      counts: { bugs: 0, ideas: 0, tasks: 1, refactors: 0, 'out-of-scope': 0 } },
    { name: 'beta', path: '/abs/beta', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
      counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 } }
  ];

  const AGENTS_STATUS: AgentsStatus = {
    enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
    spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha', '/abs/beta']
  };

  const ITEMS: BacklogItem[] = [{
    id: 'task-1', title: 'wire the heartbeat', created: '2026-08-20', started: '', tags: [],
    updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0, kind: '',
    section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: true, path: '/abs/alpha/backlog/tasks/open/task-1-wire-the-heartbeat.md'
  }];

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  beforeEach(() => {
    localStorage.clear();
  });

  /** The same URL-branching stub orchestrator-strip.test.tsx uses, with
   *  `starting` threaded through as a second knob on the runs endpoint. */
  function stub(runs: Payload[], starting: StartingRun[]): void {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload: unknown = url.includes('/api/agents/status') ? AGENTS_STATUS
        : url.includes('/api/orchestrator/runs') ? ({ runs, starting } satisfies OrchestratorRunsPayload)
        : url.includes('/api/projects') ? PROJECTS
        : { items: ITEMS, errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    }) as unknown as typeof fetch;
  }

  async function renderBoard(): Promise<void> {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
  }

  const marked: StartingRun = { project: '/abs/alpha', requestedAt: new Date().toISOString() };

  it('renders the placeholder when the project has no run at all', async () => {
    stub([], [marked]);
    await renderBoard();

    await waitFor(() => expect(screen.getByTestId('starting-strip')).toBeInTheDocument());
    expect(screen.getByTestId('starting-strip')).toHaveTextContent('alpha');
    expect(screen.queryByTestId('run-strip')).toBeNull();
  });

  it('renders the real strip and NOT the placeholder when a fresh run is already there', async () => {
    // The server should have evicted the entry by now, but both arrive in
    // one payload — so this is an ordering the client can genuinely see, and
    // it must not double-render while waiting for the server to catch up.
    stub([{ ...fixture, project: '/abs/alpha', updatedAt: new Date().toISOString(), fresh: true, pastRuns: 0, pauseRequested: false }], [marked]);
    await renderBoard();

    await waitFor(() => expect(screen.getByTestId('run-strip')).toBeInTheDocument());
    expect(screen.queryByTestId('starting-strip')).toBeNull();
  });

  it('renders the crashed strip and NOT the placeholder when the run crashed', async () => {
    // The case the approved "no fresh run" gate got wrong, and the one the
    // server cannot resolve on its own: `init` refuses a run file that still
    // says `running`, so no new run lands, eviction rule 1 never matches,
    // and the entry survives the full RUN_STALE_MS. Reachable from the UI —
    // the pre-spawn lock only refuses a FRESH run.
    stub([{ ...fixture, project: '/abs/alpha', status: 'running', fresh: false, pastRuns: 0, pauseRequested: false }], [marked]);
    await renderBoard();

    await waitFor(() => expect(screen.getByTestId('run-strip')).toBeInTheDocument());
    expect(screen.queryByTestId('starting-strip')).toBeNull();
  });

  it('still renders the placeholder for a project whose OTHER-project run is live', async () => {
    // The gate is per project, not "is anything running" — a run on beta
    // must not suppress alpha's placeholder.
    stub([{ ...fixture, project: '/abs/beta', updatedAt: new Date().toISOString(), fresh: true, pastRuns: 0, pauseRequested: false }], [marked]);
    await renderBoard();

    await waitFor(() => expect(screen.getByTestId('starting-strip')).toBeInTheDocument());
    expect(screen.getByTestId('run-strip')).toBeInTheDocument();
  });

  it('renders nothing when there is neither a starting entry nor a running run', async () => {
    stub([], []);
    await renderBoard();

    expect(screen.queryByTestId('starting-strip')).toBeNull();
    expect(screen.queryByTestId('run-strip')).toBeNull();
  });
});
