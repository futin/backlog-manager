/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { RunStrip } from '../client/src/components/board/RunStrip';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary
} from '../shared/types';

// Same translation orchestrator-hook.test.tsx (Task 10) already uses: the
// fixture file is plain JSON, so without this cast its string fields widen
// to `string` instead of the narrower literal unions (RunStage, etc) both
// RunStrip and BoardView actually key their behaviour on.
const fixture = rawFixture as OrchestratorRun;

type Payload = OrchestratorRun & { fresh: boolean; pastRuns: number };

/**
 * The endpoint's exact wrapper shape (Task 8) around one project's run.
 * `pastRuns` is irrelevant to every case in this file (nothing here reads
 * it), so it is pinned at 0 rather than threaded through as a parameter
 * nobody would vary — the same simplification orchestrator-hook.test.tsx
 * makes for the same reason.
 */
function runPayload(over: Partial<OrchestratorRun & { fresh: boolean }> = {}): Payload {
  return { ...fixture, fresh: true, pastRuns: 0, ...over };
}

describe('RunStrip', () => {
  // The fixture's own queue, in order: bug-14 merged, task-21 needs-answers,
  // bug-22 ungroomed, task-16 merged, task-9 merged, task-14 reviewing,
  // bug-27 pending — 7 items. The controller ruling this task exists to
  // honour excludes the one ungroomed item from `total`, so this fixture's
  // own arithmetic is 3 merged / 6 total, not /7. Written as the ratio the
  // brief itself pins ("fix the expected numbers against that fixture")
  // rather than as a restatement of the queue above, so a future fixture
  // edit that changes the mix fails this line with the fixture's own new
  // truth rather than a copy of today's.
  it('renders in the document with merged/total excluding the ungroomed item', () => {
    render(<RunStrip run={runPayload()} onOpen={() => {}} />);
    expect(screen.getByTestId('run-strip')).toHaveTextContent('3/6');
  });

  it('renders no strip for a stale run', () => {
    const { container } = render(<RunStrip run={runPayload({ fresh: false })} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onOpen with the run when clicked', async () => {
    const onOpen = jest.fn();
    const run = runPayload();
    render(<RunStrip run={run} onOpen={onOpen} />);
    await userEvent.click(screen.getByTestId('run-strip'));
    expect(onOpen).toHaveBeenCalledWith(run);
  });

  it('activates onOpen from the keyboard, matching the card idiom', async () => {
    const onOpen = jest.fn();
    const run = runPayload();
    render(<RunStrip run={run} onOpen={onOpen} />);
    screen.getByTestId('run-strip').focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(run);
  });

  // Distinguished from a plain "3" substring check on purpose: "3/6" already
  // puts a bare "3" in the document, so a weaker assertion here would pass
  // even if the attention count were never wired up at all — this pins the
  // actual attention wording, which "3/6" cannot produce by accident.
  it('shows the attention count from the fixture', () => {
    render(<RunStrip run={runPayload()} onOpen={() => {}} />);
    expect(fixture.attention).toHaveLength(3);
    expect(screen.getByTestId('run-strip')).toHaveTextContent('3 needs attention');
  });

  // task-14 is the fixture's only queue entry sitting at a non-terminal,
  // non-pending stage (reviewing) — everything before it in queue order is
  // already merged or skipped, everything after is still untouched pending
  // work, so it is the one item actually "current" right now.
  it("shows the current item's id and stage", () => {
    render(<RunStrip run={runPayload()} onOpen={() => {}} />);
    const strip = screen.getByTestId('run-strip');
    expect(strip).toHaveTextContent('task-14');
    expect(strip).toHaveTextContent('reviewing');
  });

  it('reads "live" when the heartbeat is younger than the freshness window', () => {
    render(<RunStrip run={runPayload({ updatedAt: new Date().toISOString() })} onOpen={() => {}} />);
    expect(screen.getByTestId('run-strip')).toHaveTextContent('live');
  });

  it('reads an aged reading once the heartbeat is older than the freshness window, even though the run itself is still fresh', () => {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    render(<RunStrip run={runPayload({ updatedAt: threeMinutesAgo })} onOpen={() => {}} />);
    const strip = screen.getByTestId('run-strip');
    expect(strip).toHaveTextContent('3m');
    expect(strip).not.toHaveTextContent('live');
  });
});

describe('BoardView: run strips and card stage badges', () => {
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

  function fakeItem(over: Partial<BacklogItem>): BacklogItem {
    const base: BacklogItem = {
      id: 'task-14', title: 'wire the heartbeat', created: '2026-08-20', started: '', tags: [],
      updated: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
      section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
      groomed: true, path: '/abs/alpha/backlog/tasks/open/task-14-wire-the-heartbeat.md',
      ...over
    };
    return base;
  }

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** Same URL-branching shape board.test.tsx's own stub uses, with one more
   *  branch for the orchestrator runs endpoint this task adds a consumer of. */
  function stub(runs: Payload[], items: BacklogItem[], projects: ProjectSummary[] = PROJECTS): jest.Mock {
    const fn = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload: unknown = url.includes('/api/agents/status') ? AGENTS_STATUS
        : url.includes('/api/orchestrator/runs') ? ({ runs } satisfies OrchestratorRunsPayload)
        : url.includes('/api/projects') ? projects
        : { items, errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  async function renderBoard(): Promise<void> {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
  }

  it('renders two strips for two fresh runs on different projects', async () => {
    stub(
      [
        { ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 },
        { ...fixture, runId: 'run-2', project: '/abs/beta', fresh: true, pastRuns: 0 }
      ],
      [fakeItem({})]
    );
    await renderBoard();
    await waitFor(() => expect(screen.getAllByTestId('run-strip')).toHaveLength(2));
  });

  it('does not render a strip for a project whose run has gone stale', async () => {
    stub([{ ...fixture, project: '/abs/alpha', fresh: false, pastRuns: 0 }], [fakeItem({})]);
    await renderBoard();
    expect(screen.queryByTestId('run-strip')).not.toBeInTheDocument();
  });

  // The card-badge half of this task: task-14 (this suite's own fixture
  // item) sits at `reviewing` in the fixture's queue, matched to the card by
  // project PATH (run.project === item.projectPath), not by the project's
  // display name — see BoardView's own comment on why.
  it('badges the card matching the fresh run\'s queue entry, then clears the badge once the run goes stale', async () => {
    stub([{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }], [fakeItem({})]);
    await renderBoard();

    const card = await screen.findByText('wire the heartbeat');
    await waitFor(() => {
      const chip = (card.closest('.board-card') as HTMLElement).querySelector('.board-card-stage');
      expect(chip).toHaveTextContent('reviewing');
    });

    // Same mounted board, not a remount: swap the stub to answer a stale run
    // and drive the hook's own window-focus refetch path
    // (useOrchestratorRuns.ts fires `refresh()` unconditionally on focus),
    // proving the badge actually reacts to fresh data going stale under it
    // rather than merely being correct on first paint.
    stub([{ ...fixture, project: '/abs/alpha', fresh: false, pastRuns: 0 }], [fakeItem({})]);
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      const stillThere = screen.getByText('wire the heartbeat').closest('.board-card') as HTMLElement;
      expect(stillThere.querySelector('.board-card-stage')).toBeNull();
    });
  });

  // The negative case a same-project match alone cannot rule out: a run
  // whose queue happens to share an id with a DIFFERENT project's card must
  // not badge it. Ids are only sequential within one project's own store
  // (board.test.tsx's own fixture comment), so this is a real collision, not
  // a contrived one.
  it('does not badge a same-id card belonging to a different project', async () => {
    stub(
      [{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }],
      [fakeItem({ project: 'beta', projectPath: '/abs/beta', path: '/abs/beta/backlog/tasks/open/task-14.md' })]
    );
    await renderBoard();
    const card = await screen.findByText('wire the heartbeat');
    expect((card.closest('.board-card') as HTMLElement).querySelector('.board-card-stage')).toBeNull();
  });
});
