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
  AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary,
  RunQueueItem, RunStage
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

/**
 * A minimal `RunQueueItem`, for the merge-mode cases below only — the
 * fixture this file otherwise reuses throughout predates the `branched`
 * stage entirely, so a case that needs one builds its own small queue from
 * scratch rather than patching a `branched` entry into a fixture that never
 * had one (the identical reasoning orchestrator-strip.test.tsx's own
 * `queueItem` gives).
 */
function queueItem(id: string, stage: RunStage, over: Partial<RunQueueItem> = {}): RunQueueItem {
  return {
    id, title: `${id} title`, stage, sessionId: null, worktree: null, branch: null,
    permissionMode: null, fixLoops: 0, stageAt: {}, verification: [], questions: [], note: null,
    ...over
  };
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

  /**
   * The tone map's whole purpose, asserted on the surface that proves it: the
   * drawer is the one place `merged`, `pending`, `ungroomed`, `needs-answers`
   * and a live stage are all on screen at once. Before lib/run-stage.ts the
   * chip's class ladder fell through to the ACTIVE tone for everything it did
   * not name, so four of this fixture's seven rows — three merged and one
   * pending — rendered as "the orchestrator is working on this right now".
   *
   * The fixture's own stages drive the expectations rather than a restated
   * list, so a fixture edit cannot leave this passing against stages it no
   * longer contains.
   */
  it('tones each queue row by what its stage means, not by a cyan default', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    const expected: Record<string, string | null> = {
      merged: 'board-card-stage-done',
      'needs-answers': 'board-card-stage-warn',
      ungroomed: 'board-card-stage-muted',
      pending: 'board-card-stage-idle',
      // reviewing is one of the six ACTIVE_RUN_STAGES: the bare base class,
      // no modifier — null here means "assert there is no modifier at all",
      // which is what keeps the active tone from quietly gaining one.
      reviewing: null
    };
    for (const q of fixture.queue) {
      const chip = screen.getByTestId(`run-drawer-item-${q.id}`).querySelector('.board-card-stage');
      expect(chip).not.toBeNull();
      const modifier = expected[q.stage];
      if (modifier === null) {
        expect((chip as HTMLElement).className.trim()).toBe('board-card-stage');
      } else {
        expect(chip as HTMLElement).toHaveClass(modifier);
      }
    }
  });

  /**
   * Colour is never the only carrier of state (the same rule the strip's live
   * dot follows). The glyph is decorative — the stage word beside it is the
   * accessible answer — so it must be hidden from the accessibility tree, or
   * a screen reader reads "check merged" and the redundancy becomes noise.
   */
  it('leads every chip with a glyph hidden from the accessibility tree', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    for (const q of fixture.queue) {
      const glyph = screen
        .getByTestId(`run-drawer-item-${q.id}`)
        .querySelector('.board-card-stage-glyph');
      expect(glyph).not.toBeNull();
      expect((glyph as HTMLElement).textContent?.trim()).not.toEqual('');
      expect(glyph as HTMLElement).toHaveAttribute('aria-hidden', 'true');
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

  // The fixture's four verification rows are ALL `ok: true` (and
  // orchestrator-strip.test.tsx reads the same file), so the failing cases
  // below build their queue inline through runPayload's override rather than
  // editing a fixture two suites share.
  const failingQueue = () => [
    {
      ...fixture.queue.find((q) => q.id === 'bug-14')!,
      id: 'bug-99',
      verification: [{ cmd: 'pnpm run build', ok: false, tail: 'error TS2554: wrong arity' }],
    },
    ...fixture.queue.filter((q) => q.id !== 'bug-14'),
  ];

  it("collapses a passing row's tail and leaves a failing row's open", () => {
    const { rerender } = render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    // bug-14's last row is `pnpm run typecheck`, ok: true.
    const pass = screen.getByTestId('run-drawer-item-bug-14').querySelector('details');
    expect(pass).not.toBeNull();
    expect(pass!.open).toBe(false);

    rerender(<RunDrawer run={runPayload({ queue: failingQueue() })} onClose={() => {}} />);
    const fail = screen.getByTestId('run-drawer-item-bug-99').querySelector('details');
    expect(fail).not.toBeNull();
    expect(fail!.open).toBe(true);
    // Open on arrival means the output is readable without a click — the
    // whole point of gating on `ok` rather than collapsing everything.
    expect(fail).toHaveTextContent('error TS2554: wrong arity');
  });

  it('keeps the command and the pass mark in the summary, so collapsing hides output and never identity', () => {
    const { rerender } = render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    const passSummary = screen.getByTestId('run-drawer-item-bug-14').querySelector('summary')!;
    expect(passSummary).toHaveTextContent('pnpm run typecheck');
    expect(passSummary).toHaveTextContent('ok');
    // The tail lives outside the summary — that separation is what the
    // collapse actually acts on.
    expect(passSummary).not.toHaveTextContent('Found 0 errors.');

    rerender(<RunDrawer run={runPayload({ queue: failingQueue() })} onClose={() => {}} />);
    const failSummary = screen.getByTestId('run-drawer-item-bug-99').querySelector('summary')!;
    expect(failSummary).toHaveTextContent('pnpm run build');
    expect(failSummary).toHaveTextContent('failed');
  });

  it('renders no disclosure at all for an item that never reached verify', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    // task-21 has `verification: []`. Guards the `verify !== null` gate
    // against being folded into the new ok/failed conditional — "no rows"
    // must stay a different case from "rows that passed".
    expect(screen.getByTestId('run-drawer-item-task-21').querySelector('details')).toBeNull();
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

  // Fix round 1 — reviewer-reproduced: `RunAttention`'s own doc comment
  // (shared/types.ts) is explicit that this list is "a log of what
  // happened... not a live filter over queue", so the same item id can
  // legitimately earn a second entry (orchestrate.mjs pushes onto
  // run.attention with no per-item guard). The fixture is task-locked and
  // never exercises this shape (each of its three entries names a
  // different id), so this constructs the colliding shape directly rather
  // than waiting for a fixture edit.
  it('renders two attention entries for the same item id, with no duplicate React key warning', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const attention: OrchestratorRun['attention'] = [
      { id: 'task-9', kind: 'fix-exhausted', detail: 'first pass: asked whether to merge anyway' },
      { id: 'task-9', kind: 'parked', detail: 'second pass: merge conflicted after resuming' }
    ];

    render(<RunDrawer run={runPayload({ attention })} onClose={() => {}} />);

    // Both render — data-testid is shared on purpose when two entries name
    // the same item (getAllByTestId is exactly the tool for that; changing
    // the id scheme itself was not what collided, only the React `key`
    // was), so this asserts on the array getAllByTestId returns rather than
    // on a single unique id per row.
    const rows = screen.getAllByTestId('run-drawer-attention-task-9');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('first pass: asked whether to merge anyway');
    expect(rows[1]).toHaveTextContent('second pass: merge conflicted after resuming');

    // React logs "Warning: Encountered two children with the same key" via
    // console.error when a list's keys collide — this is the exact warning
    // the reviewer reproduced against the old `key={a.id}`. Matched by
    // substring, not exact text: React's message is a format string with
    // the offending key value interpolated in, not this literal sentence.
    const keyWarnings = consoleError.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('same key')
    );
    expect(keyWarnings).toEqual([]);
    consoleError.mockRestore();
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

  // bug-6: `fresh` is false for two unrelated reasons — a live run that went
  // quiet, and a run that ended on purpose — and the drawer used to read both
  // as the former, telling a finished run to "resume or abort" one line under
  // a header already printing `done`. Every one of these three statuses is
  // terminal, and none of them can be resumed (`--resume` reconciles a
  // `running` run) or aborted, so each gets its own case rather than one
  // parameterised assertion: they are three separate claims about three
  // separate end states, and a loop would let two of them silently vanish
  // behind a typo'd array.
  it.each(['done', 'aborted', 'failed'] as const)(
    'hides the no-heartbeat note for a %s run, whose heartbeat stopped because the run ended',
    (status) => {
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      render(
        <RunDrawer
          run={runPayload({ status, fresh: false, updatedAt: twentyMinutesAgo })}
          onClose={() => {}}
        />
      );
      // The header still prints the status it always did — that half was
      // never wrong, and it is what made the contradiction visible.
      expect(screen.getByTestId('run-drawer-past')).toHaveTextContent(status);
      expect(screen.queryByText(/no heartbeat/)).not.toBeInTheDocument();
    }
  );

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

  // Task 9's own coverage gap, not a Task 9 source change: `RowStepper`
  // already threads `mergeModeEffective` through to `stepperTerminal`
  // (wired in an earlier task, RunDrawer.tsx's own file header), but no
  // suite had ever exercised a `branched` row through it — this fixture
  // predates the stage entirely. Brief case 5's shape (design §5.2: some
  // items merged before a mid-queue denial, the rest branched after)
  // applied to the live drawer: BOTH exits must render correctly side by
  // side, hiding neither behind the other's own tone or terminal word.
  it("renders a branched row's own stage chip and terminal stepper dot correctly, beside a merged row in the same run", () => {
    const queue = [
      queueItem('m-1', 'merged', { stageAt: { dispatched: '2026-09-01T09:00:00Z', merged: '2026-09-01T09:10:00Z' } }),
      queueItem('b-1', 'branched', { stageAt: { dispatched: '2026-09-01T09:20:00Z', branched: '2026-09-01T09:30:00Z' } })
    ];
    render(
      <RunDrawer
        run={runPayload({ queue, mergeMode: 'merge', mergeModeEffective: 'branch', mergeModeNote: 'classifier denied the merge on b-1' })}
        onClose={() => {}}
      />
    );

    // Stage chips: the same tone (`board-card-stage-done`, "this item is
    // done, cleanly" — lib/run-stage.ts's own comment on why the two exits
    // share a colour) but the different WORD each item actually earned.
    const mergedChip = screen.getByTestId('run-drawer-item-m-1').querySelector('.board-card-stage');
    const branchedChip = screen.getByTestId('run-drawer-item-b-1').querySelector('.board-card-stage');
    expect(mergedChip).toHaveClass('board-card-stage-done');
    expect(mergedChip).toHaveTextContent('merged');
    expect(branchedChip).toHaveClass('board-card-stage-done');
    expect(branchedChip).toHaveTextContent('branched');

    // The stepper's own seventh (terminal) dot: filled — `stageAt` carries
    // an arrival for it on both rows — and carrying the item's OWN exit
    // word, not the run's shared `mergeModeEffective` blindly applied to
    // both (`stepperTerminal`'s own rule: an item that already reached
    // `merged` or `branched` answers with its own stage). `m-1` finished
    // BEFORE the run's mode moved to `branch`, so a stepper that read the
    // run's field instead of the item's own history would wrongly draw a
    // hollow `branched` dot under a chip still reading `merged`.
    const mergedDot = screen.getByTestId('run-drawer-stepper-m-1').querySelector('[data-stage="merged"]');
    const branchedDot = screen.getByTestId('run-drawer-stepper-b-1').querySelector('[data-stage="branched"]');
    expect(mergedDot).toHaveClass('run-stepper-dot-filled');
    expect(branchedDot).toHaveClass('run-stepper-dot-filled');
    // Neither row's stepper has the OTHER exit's dot at all — the seven
    // dots are fixed positions ending in ONE resolved terminal word apiece.
    expect(screen.getByTestId('run-drawer-stepper-m-1').querySelector('[data-stage="branched"]')).toBeNull();
    expect(screen.getByTestId('run-drawer-stepper-b-1').querySelector('[data-stage="merged"]')).toBeNull();
  });

  // Brief case 3, the regression guard, applied to the drawer: the
  // fixture's own queue (every finished item at `merged`, `mergeMode` and
  // `mergeModeEffective` both `'merge'`) must keep resolving every stepper's
  // terminal dot to `merged` — proof that the coverage gap the test above
  // closes was a gap in TESTING, not a change in RunDrawer.tsx's own
  // (untouched by this task) behaviour.
  it('keeps resolving every stepper to a merged terminal dot for a plain merge-mode run', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    for (const q of fixture.queue) {
      if (q.stage === 'ungroomed') continue; // no stepper at all for this one
      const stepper = screen.getByTestId(`run-drawer-stepper-${q.id}`);
      expect(stepper.querySelector('[data-stage="branched"]')).toBeNull();
    }
  });

  // Final whole-branch review, finding 2: before this fix, RunDrawer was the
  // one design §7 surface ("RunStrip / RunDrawer — a branch-mode run says so")
  // that showed NEITHER half of that claim. A run that finished 4/4 items in
  // branch mode opened a strip reading "4/4, branch mode" onto a drawer
  // reading "0 merged" with no branched chip anywhere — two surfaces, one
  // run, contradictory summaries. `mergeModeLabel` and the `branched > 0`
  // chip gate mirror RunDetail.tsx's own, already-covered implementation
  // exactly (same helper, same construction), so this is the drawer's first
  // direct coverage of either.
  it('shows the mode badge and a branched chip for a branch-mode run, without losing the merged count', () => {
    const queue = [
      queueItem('m-1', 'merged'),
      queueItem('b-1', 'branched'),
      queueItem('b-2', 'branched')
    ];
    render(
      <RunDrawer
        run={runPayload({ queue, mergeMode: 'branch', mergeModeEffective: 'branch', mergeModeNote: null })}
        onClose={() => {}}
      />
    );

    expect(screen.getByTestId('run-drawer-mode')).toHaveTextContent('branch mode');
    expect(screen.getByTestId('run-drawer-mode')).not.toHaveTextContent('downgraded');
    expect(screen.getByTestId('run-drawer-chip-merged')).toHaveTextContent('1');
    expect(screen.getByTestId('run-drawer-chip-branched')).toHaveTextContent('2');
  });

  // `mergeModeLabel`'s other branch: a run that ASKED for `merge` but
  // downgraded mid-queue (design §5.2) has to read distinctly from a run that
  // chose branch mode up front — the same distinction RunsView's row and
  // RunDetail's header already pin, now pinned on the drawer too.
  it('labels a mid-queue-denied run\'s badge "(downgraded)", distinct from a deliberately-chosen branch-mode run', () => {
    const queue = [
      queueItem('m-1', 'merged'),
      queueItem('b-1', 'branched')
    ];
    render(
      <RunDrawer
        run={runPayload({ queue, mergeMode: 'merge', mergeModeEffective: 'branch', mergeModeNote: 'classifier denied the merge on b-1' })}
        onClose={() => {}}
      />
    );
    expect(screen.getByTestId('run-drawer-mode')).toHaveTextContent('branch mode (downgraded)');
  });

  // Brief case 3, the regression guard, applied to the two nodes this finding
  // actually added: the fixture is every drawer this app rendered before this
  // feature existed (`mergeMode`/`mergeModeEffective` both `'merge'`, every
  // finished item at `merged`), so neither the mode badge nor a branched chip
  // may appear for it at all — the "byte-identical for a plain merge-mode
  // run" claim, this time for the surface finding 2 fixed.
  it('renders no mode badge and no branched chip for a plain merge-mode run', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    expect(screen.queryByTestId('run-drawer-mode')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-drawer-chip-branched')).not.toBeInTheDocument();
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
      updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
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

  // Fix round 1 — reviewer-reproduced: with no exclusion between `open` and
  // `openRunProject`, ItemDrawer and RunDrawer could both be mounted at
  // once — two role="dialog" elements in the document simultaneously, and
  // since neither traps focus, a keyboard user could Tab past whichever
  // backdrop is on top into the drawer still sitting behind it. Exercises
  // both directions, not just one, since the fix (openItemDrawer /
  // openRunDrawer in BoardView.tsx) is two symmetric functions and a test
  // of only one direction wouldn't prove the other was ever wired up.
  it('opening either drawer closes the other — only one dialog is ever mounted', async () => {
    stub([{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }], [fakeItem({})]);
    await renderBoard();

    // Open the item drawer first (this describe block's own fakeItem()
    // card: id task-14, title "wire the heartbeat").
    await userEvent.click(await screen.findByText('wire the heartbeat'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'wire the heartbeat' })).toBeInTheDocument();

    // Opening the run drawer must REPLACE it, not stack a second dialog on
    // top of it.
    await userEvent.click(await screen.findByTestId('run-strip'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'alpha run' })).toBeInTheDocument();

    // And the reverse: reopening the item drawer must close the run drawer.
    await userEvent.click(await screen.findByText('wire the heartbeat'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'wire the heartbeat' })).toBeInTheDocument();
  });
});
