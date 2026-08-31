/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { RunDrawer } from '../client/src/components/board/RunDrawer';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary
} from '../shared/types';

// Same translation orchestrator-strip.test.tsx (Task 11) already uses: the
// fixture file is plain JSON, so without this cast its string fields widen to
// `string` instead of the narrower literal unions (RunStage, RunAttention's
// `kind`, ...) this suite keys its assertions on.
const fixture = rawFixture as OrchestratorRun;

type Payload = OrchestratorRun & { fresh: boolean; pastRuns: number };

/** The endpoint's exact wrapper shape (Task 8), identical to the helper
 *  orchestrator-strip.test.tsx already builds around this same fixture — kept
 *  identical rather than reinvented, since both suites exercise the same
 *  GET /api/orchestrator/runs contract. */
function runPayload(over: Partial<OrchestratorRun & { fresh: boolean; pastRuns: number }> = {}): Payload {
  return { ...fixture, fresh: true, pastRuns: 0, ...over };
}

describe('RunDrawer', () => {
  // The fixture's own queue, in order: bug-14 merged (fixLoops 1, 2
  // verification rows), task-21 needs-answers (1 question), bug-22
  // ungroomed, task-16 merged, task-9 merged (fixLoops 2, the loop cap),
  // task-14 reviewing, bug-27 pending — 7 items, 3 attention entries, one of
  // each kind. See test/fixtures/orchestrator-run.json for the full shape.

  it("renders every queue item id, and the needs-answers item's question verbatim", () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);

    // Scoped to the queue section specifically: three of these seven ids
    // (task-21, task-16, task-9) recur in the attention section below, so an
    // unscoped screen.getByText(id) would find two matches for those three
    // and throw. Scoping to .run-drawer-queue is what "every queue item id
    // appears" actually asks — the attention section is a different claim,
    // covered by its own test below.
    const queue = screen.getByTestId('run-drawer-queue');
    for (const q of fixture.queue) {
      expect(within(queue).getByText(q.id)).toBeInTheDocument();
    }

    // v1 has no answer-from-the-UI path (see the brief's own context on
    // this task): the exact wording is what a person carries into
    // backlog-groom to actually resolve it, so it has to appear verbatim,
    // not paraphrased or truncated.
    const question = fixture.queue.find((q) => q.id === 'task-21')!.questions[0];
    expect(screen.getByText(question)).toBeInTheDocument();
  });

  it('renders a stage chip per row matching the fixture stage', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    for (const q of fixture.queue) {
      expect(screen.getByTestId(`run-drawer-item-${q.id}`)).toHaveTextContent(q.stage);
    }
  });

  it('renders the fix-loop count only when greater than zero, and pluralizes it', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    // bug-14: fixLoops 1 (singular). task-9: fixLoops 2 (plural, and also
    // the fixture's own loop-cap example — see its attention entry).
    expect(screen.getByTestId('run-drawer-item-bug-14')).toHaveTextContent('1 fix loop');
    expect(screen.getByTestId('run-drawer-item-task-9')).toHaveTextContent('2 fix loops');
    // bug-27 and task-14 both carry fixLoops: 0 — the brief's "when > 0"
    // gate means neither should print anything at all, not even "0 fix loops".
    expect(screen.getByTestId('run-drawer-item-bug-27')).not.toHaveTextContent(/fix loop/);
    expect(screen.getByTestId('run-drawer-item-task-14')).not.toHaveTextContent(/fix loop/);
  });

  it("shows the last verification row's command, pass mark and tail — never the earlier rows, never for an item that has none", () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    // bug-14 carries TWO verification rows (pnpm test, then pnpm run
    // typecheck); only the LAST should surface on its row.
    const bug14 = screen.getByTestId('run-drawer-item-bug-14');
    expect(bug14).toHaveTextContent('pnpm run typecheck');
    expect(bug14).toHaveTextContent('Found 0 errors. Watching for file changes.');
    expect(bug14).not.toHaveTextContent('Tests: 2 skipped, 44 passed, 46 total');

    // task-21 never reached verify at all: `verification: []` in the fixture.
    expect(screen.getByTestId('run-drawer-item-task-21')).not.toHaveTextContent('pnpm');
  });

  it('shows pipeline chip counts against the fixture: 3 merged, 1 active, 1 queued, 3 attention', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    // merged: bug-14, task-16, task-9. active (ACTIVE_RUN_STAGES,
    // ItemCard.tsx): task-14 (reviewing) alone. queued (pending): bug-27
    // alone. attention: the fixture's own three entries, one per kind.
    expect(screen.getByTestId('run-drawer-chip-merged')).toHaveTextContent('3');
    expect(screen.getByTestId('run-drawer-chip-active')).toHaveTextContent('1');
    expect(screen.getByTestId('run-drawer-chip-queued')).toHaveTextContent('1');
    expect(screen.getByTestId('run-drawer-chip-attention')).toHaveTextContent('3');
  });

  it("lists each attention entry's kind and detail", () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    expect(fixture.attention).toHaveLength(3);
    for (const a of fixture.attention) {
      const row = screen.getByTestId(`run-drawer-attention-${a.id}`);
      expect(row).toHaveTextContent(a.kind);
      expect(row).toHaveTextContent(a.detail);
    }
  });

  it('shows the pastRuns line, pluralized correctly', () => {
    const { unmount } = render(<RunDrawer run={runPayload({ pastRuns: 5 })} onClose={() => {}} />);
    // Exact string, not a substring match: toHaveTextContent's default
    // substring semantics would let "1 past run" pass against a broken
    // implementation that always appended "s" ("1 past runs") — the exact
    // compare is what actually pins the singular/plural branch.
    expect(screen.getByTestId('run-drawer-past').textContent).toBe(`${fixture.status} · 5 past runs`);
    unmount();

    render(<RunDrawer run={runPayload({ pastRuns: 1 })} onClose={() => {}} />);
    expect(screen.getByTestId('run-drawer-past').textContent).toBe(`${fixture.status} · 1 past run`);
  });

  it('shows the no-heartbeat note for a stale run, and hides it for a fresh one', () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { unmount } = render(
      <RunDrawer run={runPayload({ fresh: false, updatedAt: twentyMinutesAgo })} onClose={() => {}} />
    );
    // The brief's own template, verbatim: "no heartbeat for N minutes —
    // resume or abort from the terminal" — a person reading this needs the
    // actual next step named, not just told something is wrong.
    expect(screen.getByText(/no heartbeat for \d+ minutes? — resume or abort from the terminal/))
      .toBeInTheDocument();
    unmount();

    render(<RunDrawer run={runPayload({ fresh: true })} onClose={() => {}} />);
    expect(screen.queryByText(/no heartbeat/)).not.toBeInTheDocument();
  });

  it('closes on Escape, on the close button, and on the scrim — mirroring ItemDrawer', async () => {
    const onClose = jest.fn();
    render(<RunDrawer run={runPayload()} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.click(screen.getByTestId('run-drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('labels the dialog for assistive tech with the project name', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    // fixture.project is "/Users/dev/code/example-app" — the readable tail,
    // same reading RunStrip.tsx prints on its own strip.
    expect(screen.getByRole('dialog', { name: 'example-app run' })).toBeInTheDocument();
  });
});

describe('BoardView: run drawer wiring', () => {
  const PROJECTS: ProjectSummary[] = [
    { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
      counts: { bugs: 0, ideas: 0, tasks: 1, refactors: 0, 'out-of-scope': 0 } }
  ];

  const AGENTS_STATUS: AgentsStatus = {
    enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
    spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
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

  /** Same URL-branching shape orchestrator-strip.test.tsx's own stub uses. */
  function stub(runs: Payload[], items: BacklogItem[]): jest.Mock {
    const fn = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload: unknown = url.includes('/api/agents/status') ? AGENTS_STATUS
        : url.includes('/api/orchestrator/runs') ? ({ runs } satisfies OrchestratorRunsPayload)
        : url.includes('/api/projects') ? PROJECTS
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

  it('opens the run drawer for the clicked strip, and Escape closes it', async () => {
    stub([{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }], [fakeItem({})]);
    await renderBoard();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('run-strip'));

    // A row the strip itself never prints (every queue item, not just the
    // "current" one) is what proves this dialog is really the drawer's own
    // content and not some coincidental match on role alone.
    expect(await screen.findByTestId('run-drawer-item-bug-27')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // The regression this task's brief context specifically calls out: the
  // drawer must not show "a frozen pipeline that looks live" once the run it
  // is open on has gone quiet. Proving it requires the SAME mounted board
  // (not a remount) picking up a second poll's worth of new data while the
  // drawer sits open — the same technique orchestrator-strip.test.tsx already
  // uses to pin the card badge clearing on staleness.
  it('keeps an open drawer in sync with newer poll data instead of freezing the pipeline at click time', async () => {
    stub([{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }], [fakeItem({})]);
    await renderBoard();
    await userEvent.click(await screen.findByTestId('run-strip'));
    await screen.findByTestId('run-drawer-item-bug-27');
    expect(screen.queryByText(/no heartbeat/)).not.toBeInTheDocument();

    // Swap the stub to answer a stale reading for the SAME run and drive the
    // hook's own window-focus refetch path (useOrchestratorRuns.ts fires
    // refresh() unconditionally on focus).
    stub([{ ...fixture, project: '/abs/alpha', fresh: false, pastRuns: 0 }], [fakeItem({})]);
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(screen.getByText(/no heartbeat/)).toBeInTheDocument());
  });
});
