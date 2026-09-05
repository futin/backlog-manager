/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { liveBarFor } from '../client/src/components/board/ItemCard';
import { RunStrip } from '../client/src/components/board/RunStrip';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary,
  RunQueueItem, RunStage, RunWatchdog
} from '../shared/types';

// Same translation orchestrator-hook.test.tsx (Task 10) already uses: the
// fixture file is plain JSON, so without this cast its string fields widen
// to `string` instead of the narrower literal unions (RunStage, etc) both
// RunStrip and BoardView actually key their behaviour on.
const fixture = rawFixture as OrchestratorRun;

// `watchdog?` joins the wrapper shape here (orchestrator-watchdog design
// §4.1's own addition to `OrchestratorRunsPayload`'s run entries) — every
// case in this file that builds a crashed run needs it, and `Payload` is
// the one place both `RunStrip` and `BoardView`'s cases share.
type Payload = OrchestratorRun & { fresh: boolean; pastRuns: number; watchdog?: RunWatchdog };

/**
 * The endpoint's exact wrapper shape (Task 8) around one project's run.
 * `pastRuns` is irrelevant to every case in this file (nothing here reads
 * it), so it is pinned at 0 rather than threaded through as a parameter
 * nobody would vary — the same simplification orchestrator-hook.test.tsx
 * makes for the same reason.
 */
function runPayload(over: Partial<Payload> = {}): Payload {
  return { ...fixture, fresh: true, pastRuns: 0, ...over };
}

/**
 * A full `RunWatchdog`, overridden per case — the same "state only what this
 * case cares about, default the rest" shape `queueItem` below already uses.
 * Duplicated from run-watchdog.test.ts's own identical helper rather than
 * imported: that file is a different suite, and this repo's fixture
 * convention (see `queueItem`'s own comment) is every suite owning its
 * fixtures rather than importing another test file's. The baseline reads
 * as "just started watching, nothing has happened yet": enabled, no
 * attempts, no error, not exhausted.
 */
function watchdog(over: Partial<RunWatchdog> = {}): RunWatchdog {
  return {
    enabled: true, attempts: 0, maxAttempts: 2, lastSpawnAt: null,
    lastSessionId: null, lastError: null, exhausted: false,
    ...over
  };
}

/**
 * A crashed run: `fresh: false` over the fixture's own `status: 'running'`
 * (left unchanged — that pair IS `isCrashed`'s own definition,
 * lib/run-watchdog.ts) with a `watchdog` record attached by default. Every
 * crashed-strip case below builds from this rather than `runPayload({ fresh:
 * false })` directly, so a case that does not care about the watchdog clause
 * still gets one — an `undefined` watchdog is its own distinct case (row 8/9
 * below need no watchdog at all, since they are not `status: 'running'`, but
 * every OTHER crashed case in this suite is exercising the clause, not its
 * absence).
 */
function crashedRun(over: Partial<Payload> & { watchdog?: RunWatchdog } = {}): Payload {
  return { ...fixture, fresh: false, pastRuns: 0, watchdog: watchdog(), ...over };
}

/**
 * A minimal `RunQueueItem`, for the merge-mode cases below only — the
 * fixture this file otherwise reuses throughout predates the `branched`
 * stage entirely (it was recorded before this feature existed), so a case
 * that needs one builds its own small queue from scratch rather than
 * patching a `branched` entry into a fixture that never had one. Narrow
 * defaults (no session, no verification, empty `stageAt`) match this
 * repo's usual "state only what this case cares about" fixture shape
 * (`test/runs-view.test.tsx`'s own `item()`/`liveQueueItem()`).
 */
function queueItem(id: string, stage: RunStage, over: Partial<RunQueueItem> = {}): RunQueueItem {
  return {
    id, title: `${id} title`, stage, sessionId: null, worktree: null, branch: null,
    permissionMode: null, fixLoops: 0, stageAt: {}, verification: [], questions: [], note: null,
    ...over
  };
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

  // Minor fix round 1: the `total === 0` guard (what stops the progress
  // bar's `merged / total` from dividing by zero) was already correct by
  // hand and confirmed by a live render, but nothing pinned it — a run
  // whose entire queue is `ungroomed` items excludes every one of them from
  // `total`, so it must read `0/0`, not throw and not print `NaN` into the
  // strip. Built from the fixture's own ungroomed entries rather than a
  // hand-rolled queue, so this stays a real shape rather than a contrived
  // one; the length assertion guards against the fixture someday losing
  // its only ungroomed item and this test silently exercising an empty
  // queue instead of the case it names.
  it('reads 0/0 for a run whose entire queue is ungroomed', () => {
    const allUngroomed = fixture.queue.filter((q) => q.stage === 'ungroomed');
    expect(allUngroomed.length).toBeGreaterThan(0);
    render(<RunStrip run={runPayload({ queue: allUngroomed })} onOpen={() => {}} />);
    expect(screen.getByTestId('run-strip')).toHaveTextContent('0/0');
  });

  // --- orchestrator-watchdog (Task 6): a crashed run renders AS crashed ---
  //
  // Replaces the old "renders no strip for a stale run" case: `!fresh` alone
  // no longer means "render nothing" (that reading is what let
  // `run-20260903-112622` disappear from the board for four hours — see
  // RunStrip.tsx's own file-level comment for the incident). The split now
  // is `isCrashed` (lib/run-watchdog.ts): `!fresh && status !== 'running'`
  // (rows 8/9 below) still renders nothing, because a finished run going
  // stale is not a fault; `!fresh && status === 'running'` (every other row
  // here) renders a crashed strip instead.
  describe('a crashed run', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    /** Stubs `fetch` to answer every call (the Resume click's one POST) with
     *  one fixed response — matching test/agents-client.test.ts's own
     *  `stub` shape for a single-call case. */
    function stubResume(status: number, body: unknown): jest.Mock {
      const fn = jest.fn(() => Promise.resolve({
        ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body)
      } as Response));
      global.fetch = fn as unknown as typeof fetch;
      return fn;
    }

    // Row 1. The fixture's own queue order (see the comment on the "3/6"
    // case above): the last entry that is neither terminal nor `pending` —
    // the controller ruling this task exists to honour — is task-14 at
    // `reviewing`, NOT the naive "first non-terminal item" (that would be
    // task-21 at `needs-answers`, which this fixture's queue order puts
    // second). Every substring below is asserted against the fixture as it
    // actually reads, not against illustrative prose.
    it('renders a crashed strip: project, "crashed", no-heartbeat, last-reported stage, waiting clause, no Resume', () => {
      render(<RunStrip run={crashedRun()} onOpen={() => {}} />);
      const strip = screen.getByTestId('run-strip');
      expect(strip).toHaveClass('run-strip-crashed');
      expect(strip).toHaveTextContent('crashed');
      expect(strip).toHaveTextContent('no heartbeat for');
      expect(strip).toHaveTextContent('last reported task-14 at reviewing');
      expect(strip).toHaveTextContent('watchdog: waiting for next check');
      expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
    });

    // Row 2.
    it('reads the watchdog\'s "attempt N/M spawned" clause, still with no Resume control', () => {
      const lastSpawnAt = new Date().toISOString();
      render(<RunStrip
        run={crashedRun({ watchdog: watchdog({ attempts: 1, lastSpawnAt }) })}
        onOpen={() => {}}
      />);
      expect(screen.getByTestId('run-strip')).toHaveTextContent('attempt 1/2 spawned');
      expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
    });

    // Row 3.
    it('reads the watchdog\'s "resume failed" clause', () => {
      render(<RunStrip
        run={crashedRun({ watchdog: watchdog({ lastError: 'busy' }) })}
        onOpen={() => {}}
      />);
      expect(screen.getByTestId('run-strip')).toHaveTextContent('resume failed: busy');
    });

    // Row 4. `canResume` present and true: the watchdog is exhausted, so
    // the Resume control renders, enabled — the one hard constraint this
    // task must not relax (widening it reintroduces a double-spawn race
    // with the watchdog's own next tick, see RunStrip.tsx's own comment).
    it('shows an enabled Resume control once the watchdog is exhausted and the board allows it', () => {
      render(<RunStrip
        run={crashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) })}
        onOpen={() => {}}
        canResume
      />);
      const strip = screen.getByTestId('run-strip');
      expect(strip).toHaveTextContent('exhausted after 2 — resume by hand');
      const button = screen.getByRole('button', { name: 'Resume run' });
      expect(button).toBeInTheDocument();
      expect(button.getAttribute('aria-disabled')).not.toBe('true');
    });

    // Row 5. `!watchdog.enabled` is the OTHER state the hard constraint
    // allows Resume for.
    it('shows a Resume control when the watchdog itself is off', () => {
      render(<RunStrip
        run={crashedRun({ watchdog: watchdog({ enabled: false }) })}
        onOpen={() => {}}
        canResume
      />);
      const strip = screen.getByTestId('run-strip');
      expect(strip).toHaveTextContent('off — resume by hand');
      expect(screen.getByRole('button', { name: 'Resume run' })).toBeInTheDocument();
    });

    // Row 6: same watchdog state as row 4 (exhausted), but the BOARD side of
    // the gate says no — no control at all, matching CLAUDE.md's rule that
    // an environment-level/project-visibility block hides rather than merely
    // disables (BoardView passes `canResume` for exactly this reason).
    it('renders no Resume control when the board withholds it, even once exhausted', () => {
      render(<RunStrip
        run={crashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) })}
        onOpen={() => {}}
        canResume={false}
      />);
      expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
    });

    // Row 7: `canResume` true but a per-project reason blocks it — present,
    // aria-disabled, titled with the reason, matching DispatchButton's own
    // aria-disabled + title idiom (CLAUDE.md) rather than a native
    // `disabled` attribute, which a keyboard user cannot even focus.
    it('renders a disabled, titled Resume control when the board names a blocking reason', () => {
      render(<RunStrip
        run={crashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) })}
        onOpen={() => {}}
        canResume
        resumeBlockedReason="the dashboard cannot see this project"
      />);
      const button = screen.getByRole('button', { name: 'Resume run' });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('title', 'the dashboard cannot see this project');
    });

    // Rows 8/9: a run whose heartbeat is stale but whose `status` is not
    // `'running'` is not crashed at all — it is the ordinary end of every
    // run that ever finished, and renders nothing, exactly as a stale run
    // always has.
    it.each(['done', 'aborted', 'failed'] as const)(
      'renders nothing for a stale run whose status is %s (not crashed)',
      (status) => {
        const { container } = render(
          <RunStrip run={runPayload({ fresh: false, status })} onOpen={() => {}} />
        );
        expect(container).toBeEmptyDOMElement();
      }
    );

    // Row 10: the regression guard — a fresh run must render byte-identically
    // to before this feature, carrying neither the crashed class nor any of
    // its wording. The existing "3/6" case elsewhere in this file already
    // covers the rest of a fresh strip's own content.
    it('does not read as crashed while the run is still fresh', () => {
      render(<RunStrip run={runPayload()} onOpen={() => {}} />);
      const strip = screen.getByTestId('run-strip');
      expect(strip).not.toHaveClass('run-strip-crashed');
      expect(strip).not.toHaveTextContent('crashed');
    });

    // Row 11: a successful resume posts to the right endpoint with the right
    // body, calls `onResumed`, and does NOT also open the drawer — the two
    // are different outcomes of two different controls sharing one strip.
    it('posts to /api/agents/resume and calls onResumed on a successful click, without opening the drawer', async () => {
      const fetchMock = stubResume(200, { sessionId: 's' });
      const onOpen = jest.fn();
      const onResumed = jest.fn();
      const run = crashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) });
      render(<RunStrip run={run} onOpen={onOpen} canResume onResumed={onResumed} />);

      await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('/api/agents/resume');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ project: fixture.project });
      await waitFor(() => expect(onResumed).toHaveBeenCalledTimes(1));
      expect(onOpen).not.toHaveBeenCalled();
    });

    // Row 12: a 409 "already running" answer means the run recovered under
    // the click (design §6.1) — treated as success, not an error.
    it('treats a 409 run-in-progress answer as success, not an error', async () => {
      stubResume(409, { error: 'alive', code: 'run-in-progress' });
      const onResumed = jest.fn();
      const run = crashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) });
      render(<RunStrip run={run} onOpen={() => {}} canResume onResumed={onResumed} />);

      await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));

      await waitFor(() => expect(onResumed).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('alive')).not.toBeInTheDocument();
    });

    // Row 13: any other error renders inline on the strip instead.
    it('renders any other resume failure inline on the strip, without calling onResumed', async () => {
      stubResume(502, { error: 'dashboard down' });
      const onResumed = jest.fn();
      const run = crashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) });
      render(<RunStrip run={run} onOpen={() => {}} canResume onResumed={onResumed} />);

      await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));

      await waitFor(() => expect(screen.getByTestId('run-strip')).toHaveTextContent('dashboard down'));
      expect(onResumed).not.toHaveBeenCalled();
    });

    // Row 14: clicking anywhere else on a crashed strip still opens the
    // drawer, exactly as a fresh strip's click always has.
    it('calls onOpen when a crashed strip is clicked anywhere but the Resume control', async () => {
      const onOpen = jest.fn();
      const run = crashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) });
      render(<RunStrip run={run} onOpen={onOpen} canResume />);

      await userEvent.click(screen.getByText('crashed'));

      expect(onOpen).toHaveBeenCalledWith(run);
    });
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

  // Task 9's own case (brief case a): the real overnight run this whole
  // feature traces back to finished four items — all reviewed, all green —
  // and merged none, because the classifier refused every merge. Reported
  // as four parks, that read as a failed run. Under branch mode the same
  // four items all reach `branched`, and this pins that a run shaped
  // exactly like that one now reads as fully done, not as a failure or a
  // park: 4/4, a full bar, no "current" item pointing at already-finished
  // work, and neither of the words a genuine failure state would use.
  it('renders a fully successful branch-mode run as done, not as a park or a failure', () => {
    const queue = [
      queueItem('bug-1', 'branched'),
      queueItem('bug-2', 'branched'),
      queueItem('bug-3', 'branched'),
      queueItem('bug-4', 'branched')
    ];
    const run = runPayload({
      queue, attention: [], mergeMode: 'branch', mergeModeEffective: 'branch', mergeModeNote: null
    });
    render(<RunStrip run={run} onOpen={() => {}} />);
    const strip = screen.getByTestId('run-strip');

    expect(strip).toHaveTextContent('4/4');
    expect(strip.querySelector('.run-strip-bar-fill')).toHaveStyle({ width: '100%' });
    // Every entry already exited the pipeline, so nothing is "still
    // working" — the ruling defect this fixture also exercises (below) is
    // exactly a run like this one misreading its own last exited item as
    // current.
    expect(strip.querySelector('.run-strip-current')).toBeNull();
    expect(strip).not.toHaveTextContent('parked');
    expect(strip).not.toHaveTextContent('failed');
    expect(screen.getByTestId('run-strip-mode')).toHaveTextContent('branch mode');
  });

  // Controller ruling defect #1: `TERMINAL_STAGES` used to omit `branched`
  // entirely, so `run.queue.find((q) => !TERMINAL_STAGES.includes(q.stage))`
  // treated an already-finished branched item as the one non-terminal —
  // "current" — entry the moment it was the first one in queue order,
  // regardless of whether real work was still ahead of it. Pinned with a
  // branched item FOLLOWED BY a genuinely pending one: before the fix this
  // read `bug-1` (done) as current; after it, `bug-2` (the true next item).
  it("does not read an already-exited branched item as the run's current work", () => {
    const queue = [queueItem('bug-1', 'branched'), queueItem('bug-2', 'pending')];
    const run = runPayload({
      queue, attention: [], mergeMode: 'branch', mergeModeEffective: 'branch', mergeModeNote: null
    });
    render(<RunStrip run={run} onOpen={() => {}} />);
    const current = screen.getByTestId('run-strip').querySelector('.run-strip-current');
    expect(current).not.toBeNull();
    expect(current).toHaveTextContent('bug-2');
    expect(current).not.toHaveTextContent('bug-1');
  });

  // Brief case 5: a run whose merge was denied partway through (design
  // §5.2) holds items in BOTH success exits at once — the two merged
  // before the denial, the two branched after it. Controller ruling defect
  // #2 was counting `merged` alone, which for a run shaped like this one
  // undercounts real completion by half; this pins that both exits now
  // count toward the same "done" total, hiding neither.
  it('counts merged and branched items together for a run that downgraded mid-queue', () => {
    const queue = [
      queueItem('bug-1', 'merged'),
      queueItem('bug-2', 'merged'),
      queueItem('bug-3', 'branched'),
      queueItem('bug-4', 'branched')
    ];
    const run = runPayload({
      queue, attention: [], mergeMode: 'merge', mergeModeEffective: 'branch',
      mergeModeNote: 'classifier denied the merge on bug-3'
    });
    render(<RunStrip run={run} onOpen={() => {}} />);
    const strip = screen.getByTestId('run-strip');
    expect(strip).toHaveTextContent('4/4');
    expect(strip.querySelector('.run-strip-bar-fill')).toHaveStyle({ width: '100%' });
  });

  // Brief case 3, the regression guard: a plain merge-mode run — the shape
  // of every run ever archived before this feature existed — must render
  // byte-identically to today. The fixture's own `mergeMode`/
  // `mergeModeEffective` are both `'merge'` (asserted here, not assumed),
  // so `mergeModeLabel` (lib/run-stage.ts) must return `null` and the badge
  // this feature adds must be entirely absent, on top of the exact
  // merged/total ratio the very first test in this file already pins.
  it('renders a merge-mode run byte-identically to before this feature: no mode badge', () => {
    expect(fixture.mergeMode).toBe('merge');
    expect(fixture.mergeModeEffective).toBe('merge');
    render(<RunStrip run={runPayload()} onOpen={() => {}} />);
    expect(screen.queryByTestId('run-strip-mode')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-strip')).toHaveTextContent('3/6');
  });
});

describe('BoardView: run strips and card live bars', () => {
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
      updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0, kind: '',
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

  /* The status filter cases below drive the toolbar's Status select, and
     `usePersistedState` writes every such choice to localStorage — which jsdom
     keeps for the whole FILE, not the test. Without this, the first case to
     select "In progress" silently narrows every case declared after it. */
  beforeEach(() => {
    localStorage.clear();
  });

  /** The fixture's own queue entry for `id` — every run below is built from these. */
  function entry(id: string): RunQueueItem {
    const found = fixture.queue.find((q) => q.id === id);
    if (found === undefined) throw new Error(`fixture has no queue entry for ${id}`);
    return found;
  }

  /**
   * A stamp in the shape the run file writes, relative to the moment the suite
   * runs. The fixture's own stamps are literal August dates, which is right for
   * asserting WHICH stamp the bar anchors on (the unit cases below pin those
   * verbatim) and wrong for asserting what the bar READS: an elapsed off a
   * literal date is a different string every day the suite runs. Relative
   * values cannot drift the wrong way either — elapsed only grows between the
   * fixture being built and the assertion running, and every rung floors.
   */
  const agoISO = (ms: number): string => `${new Date(Date.now() - ms).toISOString().slice(0, 19)}Z`;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  /** One fresh alpha run over exactly the queue entries handed in. */
  function alphaRun(queue: RunQueueItem[], over: Partial<Payload> = {}): Payload {
    return { ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0, queue, ...over };
  }

  /** The bar on a card, found by the card's own title. */
  function barOf(title: string): HTMLElement | null {
    return screen.getByText(title).closest('.board-card')!.querySelector('.board-card-live-bar');
  }

  /** Every card title in one column, in rendered order. */
  function titlesIn(colIndex: number): (string | null)[] {
    const cards = screen.getAllByTestId('board-col')[colIndex].querySelector('.board-col-cards');
    return Array.from(cards!.querySelectorAll('.board-card-title')).map((el) => el.textContent);
  }

  /** A task card in alpha, with a path derived from its id like the real index. */
  function task(id: string, title: string, over: Partial<BacklogItem> = {}): BacklogItem {
    return fakeItem({ id, title, path: `/abs/alpha/backlog/tasks/open/${id}.md`, ...over });
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

  // `status: 'done'` here, not the fixture's own default `'running'` — a
  // stale run whose status is still `'running'` is a CRASHED run
  // post-watchdog (`isCrashed`, lib/run-watchdog.ts) and now renders a
  // strip on purpose (the cases just below this one); this case is testing
  // the other half, a run that genuinely finished going stale, which still
  // renders nothing at all.
  it('does not render a strip for a project whose run has genuinely finished and gone stale', async () => {
    stub([{ ...fixture, project: '/abs/alpha', fresh: false, status: 'done', pastRuns: 0 }], [fakeItem({})]);
    await renderBoard();
    expect(screen.queryByTestId('run-strip')).not.toBeInTheDocument();
  });

  // --- orchestrator-watchdog (Task 6), BoardView cases 15-18 --------------

  /** Same shape as the top-level `crashedRun` builder, scoped to alpha. */
  function alphaCrashedRun(over: Partial<Payload> = {}): Payload {
    return crashedRun({ project: '/abs/alpha', ...over });
  }

  // Row 15: a crashed strip renders on the board, and the existing
  // stale-run card assertions (this file's own "pins nothing at all once
  // the run is stale" and "keeps a stale run readable in the drawer while
  // its cards go unmarked" cases, both built on `fresh: false` over this
  // same fixture) are untouched by this — `freshRuns` (badges/claims) stays
  // exactly as freshness-based as it always was; only the STRIP gained a
  // second, wider list to render from.
  it('renders a crashed strip on the board for a project with a stale-but-running run', async () => {
    stub([alphaCrashedRun()], [fakeItem({})]);
    await renderBoard();
    const strip = await screen.findByTestId('run-strip');
    expect(strip).toHaveClass('run-strip-crashed');
  });

  // Row 16: the dashboard cannot see this project — `projectDispatchGate`
  // disables rather than hides (the project is invisible, not the whole
  // environment), so the Resume control renders present but blocked.
  /** Same URL-branching shape `stub` above uses, with the agents-status
   *  body overridable per case — the two gate cases below (16/17) each need
   *  a DIFFERENT status shape than `AGENTS_STATUS`'s own default, which
   *  `stub`'s own signature has no parameter for. */
  function stubWithStatus(agentsStatus: AgentsStatus, runs: Payload[], items: BacklogItem[]): jest.Mock {
    const fn = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload: unknown = url.includes('/api/agents/status') ? agentsStatus
        : url.includes('/api/orchestrator/runs') ? ({ runs } satisfies OrchestratorRunsPayload)
        : url.includes('/api/projects') ? PROJECTS
        : { items, errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('disables the crashed strip\'s Resume control when the dashboard cannot see the project', async () => {
    stubWithStatus(
      { ...AGENTS_STATUS, projectPaths: [] },
      [alphaCrashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) })],
      [fakeItem({})]
    );
    await renderBoard();
    const button = await screen.findByRole('button', { name: 'Resume run' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.getAttribute('title')).toMatch(/does not list/);
  });

  // Row 17: `BM_AGENTS` off (the environment-level block) hides the control
  // outright — CLAUDE.md's own rule, applied to Resume the same way it
  // already applies to DispatchButton and the Orchestrate toolbar button.
  it('renders no Resume control on the crashed strip when agent dispatch is disabled entirely', async () => {
    stubWithStatus(
      { ...AGENTS_STATUS, enabled: false },
      [alphaCrashedRun({ watchdog: watchdog({ attempts: 2, maxAttempts: 2, exhausted: true }) })],
      [fakeItem({})]
    );
    await renderBoard();
    await screen.findByTestId('run-strip');
    expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
  });

  // Row 18: a crashed run and a fresh run, different projects — both strips
  // render, one crashed and one not.
  it('renders one crashed strip and one fresh strip for two different projects', async () => {
    stub(
      [
        alphaCrashedRun(),
        { ...fixture, runId: 'run-2', project: '/abs/beta', fresh: true, pastRuns: 0 }
      ],
      [fakeItem({})]
    );
    await renderBoard();
    const strips = await waitFor(() => {
      const found = screen.getAllByTestId('run-strip');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(strips.filter((s) => s.classList.contains('run-strip-crashed'))).toHaveLength(1);
    expect(strips.filter((s) => !s.classList.contains('run-strip-crashed'))).toHaveLength(1);
  });

  // The card half of this task: task-14 (this suite's own fixture item) sits at
  // `reviewing` in the fixture's queue, matched to the card by project PATH
  // (run.project === item.projectPath), not by the project's display name — see
  // BoardView's own comment on why.
  //
  // Task 9 moved what that match earns from a footer chip to the card's own
  // live bar, in cyan: the question "which of these twelve is being worked" is
  // asked of a whole column at once, and a 9.5px chip in a card's foot could no
  // more answer it than the 3px inset the hand-run bar replaced could. Both
  // halves of the tone are asserted — the bar's fill class and the card's own
  // border class — because a cyan bar on an amber-bordered card reads as two
  // different claims about one item.
  it('gives the card matching the fresh run\'s queue entry a cyan live bar, then clears it once the run goes stale', async () => {
    stub([{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }], [fakeItem({})]);
    await renderBoard();

    const card = await screen.findByText('wire the heartbeat');
    await waitFor(() => {
      const bar = (card.closest('.board-card') as HTMLElement).querySelector('.board-card-live-bar');
      expect(bar).toHaveTextContent('reviewing');
      expect(bar).toHaveClass('board-card-live-bar-run');
    });
    expect(card.closest('.board-card')).toHaveClass('board-card-live', 'board-card-live-run');

    // Same mounted board, not a remount: swap the stub to answer a stale run
    // and drive the hook's own window-focus refetch path
    // (useOrchestratorRuns.ts fires `refresh()` unconditionally on focus),
    // proving the marker actually reacts to fresh data going stale under it
    // rather than merely being correct on first paint.
    stub([{ ...fixture, project: '/abs/alpha', fresh: false, pastRuns: 0 }], [fakeItem({})]);
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      const stillThere = screen.getByText('wire the heartbeat').closest('.board-card') as HTMLElement;
      expect(stillThere.querySelector('.board-card-live-bar')).toBeNull();
      expect(stillThere).not.toHaveClass('board-card-live');
    });
  });

  // IMPORTANT fix round 1 (Task 11), carried forward to the bar: the test above
  // only ever exercised the six-active-stage branch (task-14, `reviewing`). The
  // other two — a run BLOCKED on a person, and a stage that earns no marker at
  // all — had no coverage through BoardView. Both are pinned here against the
  // SAME contract fixture, needing no new fixture data: task-21 IS the
  // fixture's own needs-answers entry, and bug-27 IS its pending one. Combined
  // into one test (matching board.test.tsx's own "badges a refactor kind it
  // knows, and nothing else" precedent) because both cards have to be on the
  // board together for the negative half to mean anything — a marker that
  // rendered unconditionally would still pass a version of this split across
  // two separate, unrelated renders.
  it('gives a needs-answers card the amber bar, and no bar at all to a pending one', async () => {
    stub(
      [{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }],
      [
        fakeItem({
          id: 'task-21', title: 'decide the archive question',
          path: '/abs/alpha/backlog/tasks/open/task-21-decide-the-archive-question.md'
        }),
        fakeItem({
          id: 'bug-27', title: 'hue swatch lag', section: 'bugs',
          path: '/abs/alpha/backlog/bugs/open/bug-27-hue-swatch-lag.md'
        }),
        // The terminal end of the same negative: bug-14 is the fixture's merged
        // entry. `pending` and `merged` bracket the live stages on either side,
        // and a marker that keyed off "the run mentions this item" rather than
        // off the stage would light up both.
        fakeItem({
          id: 'bug-14', title: 'already merged', section: 'bugs', groomed: true,
          path: '/abs/alpha/backlog/bugs/open/bug-14-already-merged.md'
        })
      ]
    );
    await renderBoard();

    // task-21: needs-answers, which is amber and NOT cyan — the run has
    // stopped and will not restart until a person answers, which is the
    // legend's "a human is involved here" rather than a shade of progress.
    // The absent cyan class is asserted outright: the text alone would pass
    // just as well if the two tones had been collapsed into one.
    const needsAnswersCard = (await screen.findByText('decide the archive question'))
      .closest('.board-card') as HTMLElement;
    const warnBar = needsAnswersCard.querySelector('.board-card-live-bar');
    expect(warnBar).not.toBeNull();
    expect(warnBar).toHaveTextContent('needs-answers');
    expect(warnBar).not.toHaveClass('board-card-live-bar-run');
    expect(needsAnswersCard).toHaveClass('board-card-live');
    expect(needsAnswersCard).not.toHaveClass('board-card-live-run');

    // bug-27: pending — neither active nor attention, so no bar. Checked
    // against the card's own rendered content (its title, proving the card
    // rendered in full) rather than the container being empty, which would
    // prove nothing about this specific branch on a card that legitimately has
    // plenty of other content.
    const pendingCard = screen.getByText('hue swatch lag').closest('.board-card') as HTMLElement;
    expect(pendingCard.querySelector('.board-card-title')).toHaveTextContent('hue swatch lag');
    expect(pendingCard.querySelector('.board-card-live-bar')).toBeNull();
    expect(pendingCard).not.toHaveClass('board-card-live');

    // bug-14: merged. No bar either, and its file-derived footer marker is
    // still exactly where it was — nothing about this task touches a card the
    // run is not currently working.
    const mergedCard = screen.getByText('already merged').closest('.board-card') as HTMLElement;
    expect(mergedCard.querySelector('.board-card-live-bar')).toBeNull();
    expect(mergedCard).not.toHaveClass('board-card-live');
    expect(mergedCard.querySelector('.board-card-groomed')).toHaveTextContent('groomed');
  });

  // The negative case a same-project match alone cannot rule out: a run
  // whose queue happens to share an id with a DIFFERENT project's card must
  // not badge it. Ids are only sequential within one project's own store
  // (board.test.tsx's own fixture comment), so this is a real collision, not
  // a contrived one.
  it('does not mark a same-id card belonging to a different project', async () => {
    stub(
      [{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }],
      [fakeItem({ project: 'beta', projectPath: '/abs/beta', path: '/abs/beta/backlog/tasks/open/task-14.md' })]
    );
    await renderBoard();
    const card = await screen.findByText('wire the heartbeat');
    expect((card.closest('.board-card') as HTMLElement).querySelector('.board-card-live-bar')).toBeNull();
  });

  /*
   * The anchor, pinned against the fixture's literal stamps and clock-free.
   * `stageAt` keeps FIRST arrivals only (shared/types.ts), which is the whole
   * reason `dispatched` is the preferred anchor rather than the current stage's
   * own arrival: a `fixing` → `reviewing` loop re-stamps neither, so anchoring
   * on the current stage would report a long item as "2m in reviewing" instead
   * of "40m in the orchestrator's hands" — the analogue of `started:`, and the
   * reading a person scanning a column actually wants.
   *
   * A unit case rather than a render, because this is the one assertion that can
   * name the fixture's exact stamps: an elapsed computed off a literal August
   * date reads as a different string every day the suite runs (board.test.tsx's
   * own header comment states that rule), so the RENDERED reading is pinned in
   * the case below this one, against relative stamps.
   */
  it('anchors the bar on stageAt.dispatched, falling back to the current stage', () => {
    const active = liveBarFor(fakeItem({}), entry('task-14'));
    expect(active).toEqual({
      label: 'reviewing',
      tone: 'run',
      // dispatched (09:32:40Z), NOT the `reviewing` arrival (09:36:40Z).
      anchor: '2026-08-31T09:32:40Z',
      title: 'reviewing since 2026-08-31T09:32:40Z'
    });

    // task-21's route (pending → preflight → needs-answers) never visits
    // `dispatched` at all, so the fallback is not a defensive branch — it is
    // the only anchor an attention item has, and it reads as exactly the right
    // thing: how long this has been waiting on you.
    const attention = liveBarFor(fakeItem({ id: 'task-21' }), entry('task-21'));
    expect(attention).toEqual({
      label: 'needs-answers',
      tone: 'human',
      anchor: '2026-08-31T09:00:42Z',
      title: 'needs-answers since 2026-08-31T09:00:42Z'
    });
  });

  // The bar drops the reading rather than printing `NaN` into it — the same
  // rule the hand-run bar already applies to an unageable `started`
  // (board.test.tsx pins that half). A queue entry with no stamp for the stage
  // it reports is the run-payload shape of the same problem.
  it('renders the words and no reading for a queue entry carrying no usable stamp', async () => {
    stub(
      [alphaRun([{ ...entry('task-14'), stageAt: {} }])],
      [fakeItem({})]
    );
    await renderBoard();
    const bar = await waitFor(() => {
      const found = barOf('wire the heartbeat');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(bar).toHaveTextContent('reviewing');
    expect(bar.querySelector('.board-card-live-mark')).toBeNull();
    expect(bar.textContent).not.toContain('NaN');
  });

  // The rendered reading, against relative stamps so the expected string cannot
  // rot: `dispatched` three hours ago, `reviewing` five minutes ago. `3h` is
  // therefore the dispatched anchor and `5m` would be the current stage's — the
  // wrong one, asserted absent so a swapped anchor fails here rather than
  // reading plausibly and being off by hours.
  it("reads the elapsed since dispatch on an active card, not since the stage it is on", async () => {
    stub(
      [alphaRun([{
        ...entry('task-14'),
        stageAt: { ...entry('task-14').stageAt, dispatched: agoISO(3 * HOUR), reviewing: agoISO(5 * MIN) }
      }])],
      [fakeItem({})]
    );
    await renderBoard();
    const bar = await waitFor(() => {
      const found = barOf('wire the heartbeat');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const mark = within(bar).getByText('3h');
    expect(mark).toHaveClass('board-card-live-mark');
    expect(bar.textContent).not.toContain('5m');
  });

  // The attention anchor, rendered: 45 minutes since the question was asked,
  // read off `stageAt['needs-answers']` because there is no `dispatched` key to
  // prefer. Amber, and the elapsed is the half a reader cannot guess from the
  // colour — "waiting on you" is very different at 45m and at 4d.
  it('reads the elapsed since the question was asked on an attention card', async () => {
    stub(
      [alphaRun([{
        ...entry('task-21'),
        stageAt: { ...entry('task-21').stageAt, 'needs-answers': agoISO(45 * MIN) }
      }])],
      [task('task-21', 'decide the archive question')]
    );
    await renderBoard();
    const bar = await waitFor(() => {
      const found = barOf('decide the archive question');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(bar).not.toHaveClass('board-card-live-bar-run');
    expect(within(bar).getByText('45m')).toBeInTheDocument();
  });

  /*
   * `parked` earns a marker it never had as a chip, and ranks with
   * `needs-answers` rather than with the six working stages. Both mean the
   * pipeline has stopped and will not restart on its own, which is the one thing
   * on this board worth surfacing above running work — so the parked card sorts
   * above the actively-reviewing one even though the sort in play (newest first,
   * the default) would put it second on its own.
   */
  it('treats parked as attention: amber, and above running work in the column', async () => {
    stub(
      [alphaRun([
        { ...entry('task-14'), id: 'task-30', stage: 'parked' as RunStage,
          stageAt: { parked: agoISO(20 * MIN) } },
        entry('task-14')
      ])],
      [
        task('task-30', 'parked item', { created: '2026-08-01' }),
        task('task-14', 'wire the heartbeat', { created: '2026-08-20' })
      ]
    );
    await renderBoard();
    const bar = await waitFor(() => {
      const found = barOf('parked item');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(bar).toHaveTextContent('parked');
    expect(bar).not.toHaveClass('board-card-live-bar-run');
    expect(titlesIn(3)).toEqual(['parked item', 'wire the heartbeat']);
  });

  /*
   * The bar replaced the footer chip; it did not join it. A card showing a cyan
   * bar reading `reviewing` must not also print `reviewing` two lines below in
   * the same colour — the second copy carries no information and costs the foot
   * the width its stable facts need. Counted rather than merely checking the
   * chip class is gone, because the ways that word could reappear are not
   * limited to the class this task deleted.
   *
   * The other footer markers are facts the item FILE holds, and Task 9 left
   * every one of them alone — asserted here on the same card, since "the chip
   * is gone" and "the foot is intact" is one claim. (`groomed` is the one of the
   * three an orchestrated card can actually carry: `kind` badges refactors,
   * which the orchestrator refuses outright, and a `done` item has left the
   * queue.) The queue entry is re-keyed onto a bug id precisely so the groomed
   * marker is in play — the fixture has no bug sitting at an active stage.
   */
  it('prints the stage once, on the bar, and leaves the file-derived footer markers alone', async () => {
    stub(
      [alphaRun([{ ...entry('task-14'), id: 'bug-9' }])],
      [fakeItem({
        id: 'bug-9', title: 'a groomed bug', section: 'bugs', groomed: true,
        path: '/abs/alpha/backlog/bugs/open/bug-9-a-groomed-bug.md'
      })]
    );
    await renderBoard();
    const card = await waitFor(() => {
      const found = screen.getByText('a groomed bug').closest('.board-card') as HTMLElement;
      expect(found.querySelector('.board-card-live-bar')).not.toBeNull();
      return found;
    });

    // Counted over the card's printed face, which is what "twice on one card"
    // meant: the dispatch tab's own blocked-reason span ("an orchestrator run
    // is working this item (reviewing)") sits outside it, is sr-only, and
    // answers a different question — why that button is inert — so it is not a
    // second copy of this marker and must not be counted as one.
    const face = card.querySelector('.board-card-main') as HTMLElement;
    expect(face.textContent?.match(/reviewing/g) ?? []).toHaveLength(1);
    expect(card.querySelector('.board-card-stage')).toBeNull();
    expect(card.querySelector('.board-card-groomed')).toHaveTextContent('groomed');
  });

  /*
   * The whole ordering, in one column, under the default `created` sort — chosen
   * because a broken rank produces a plausible-looking wrong answer (plain
   * newest-on-top) there rather than an assertion that would pass either way.
   *
   * attention (task-21) first, then the rank-1 pair, then the idle pair. The
   * pair at rank 1 is the point of this fixture: an orchestrator-active card and
   * a hand-run `started:` card TIE, because both mean "somebody is on this", and
   * the selected sort orders them against each other — task-30 is newer, so it
   * leads, even though the other one is the one a run is holding. task-21 is the
   * OLDEST of the five, so newest-first alone would have put it last.
   */
  it('orders a column attention-first, then live work, then idle — sort breaking every tie', async () => {
    stub(
      [alphaRun([entry('task-21'), entry('task-14')])],
      [
        task('task-21', 'needs an answer', { created: '2026-08-01' }),
        task('task-14', 'orchestrator has it', { created: '2026-08-05' }),
        task('task-30', 'hand-run', { created: '2026-08-10', started: agoISO(HOUR) }),
        task('task-40', 'idle newest', { created: '2026-08-20' }),
        task('task-41', 'idle older', { created: '2026-08-15' })
      ]
    );
    await renderBoard();
    await waitFor(() => expect(barOf('needs an answer')).not.toBeNull());
    expect(titlesIn(3)).toEqual([
      'needs an answer', 'hand-run', 'orchestrator has it', 'idle newest', 'idle older'
    ]);
  });

  /*
   * The regression that keeps the pin from outliving the run that justified it.
   * `runEntriesByProject` is built from `freshRuns`, so a run whose heartbeat
   * has gone quiet contributes no stage to any card and both the bar and the
   * rank fall away on their own — there is deliberately no second `fresh` check
   * anywhere downstream, and nothing else in the suite would catch a future
   * refactor sourcing that map from `runs` instead. A dead run pinning three
   * cards to the top of a column forever is exactly what this pins against.
   */
  it('pins nothing at all once the run is stale: no bars, and pure sort order', async () => {
    stub(
      [alphaRun([entry('task-21'), entry('task-14')], { fresh: false })],
      [
        task('task-21', 'needs an answer', { created: '2026-08-01' }),
        task('task-14', 'orchestrator has it', { created: '2026-08-05' }),
        task('task-40', 'idle newest', { created: '2026-08-20' }),
        task('task-41', 'idle older', { created: '2026-08-15' })
      ]
    );
    await renderBoard();
    expect(document.querySelectorAll('.board-card-live-bar')).toHaveLength(0);
    expect(titlesIn(3)).toEqual([
      'idle newest', 'idle older', 'orchestrator has it', 'needs an answer'
    ]);
  });

  /*
   * The other side of that same split, from the card's angle: going stale must
   * unpin the CARDS without dropping the run from `runs`, because the drawer
   * reads the full list and its whole job is to say that the heartbeat stopped
   * (orchestrator-drawer.test.tsx pins the note itself). A "fix" that filtered
   * stale runs out of `runs` rather than at `freshRuns` would pass every
   * card-side assertion above and silently unmount the one surface a person
   * needs at exactly that moment.
   */
  it('keeps a stale run readable in the drawer while its cards go unmarked', async () => {
    stub([alphaRun([entry('task-14')])], [fakeItem({})]);
    await renderBoard();
    await userEvent.click(await screen.findByTestId('run-strip'));
    expect(await screen.findByTestId('run-drawer-item-task-14')).toBeInTheDocument();

    stub([alphaRun([entry('task-14')], { fresh: false })], [fakeItem({})]);
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(barOf('wire the heartbeat')).toBeNull());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('run-drawer-item-task-14')).toBeInTheDocument();
  });

  /*
   * The Status filter's "In progress" used to resolve through the item file's
   * `started:` alone, which hid exactly the items the orchestrator was working
   * — the precise opposite of what that view is for. Not one of these four items
   * carries a `started` stamp, so under the old predicate this list would have
   * been empty; it now matches the same rank-0-and-1 set the column order uses.
   */
  it('shows orchestrated work under the In progress filter, and only that', async () => {
    stub(
      [alphaRun([entry('task-14'), entry('task-21'), entry('bug-27'), entry('bug-14')])],
      [
        task('task-14', 'orchestrator has it'),
        task('task-21', 'needs an answer'),
        fakeItem({ id: 'bug-27', title: 'still pending', section: 'bugs',
          path: '/abs/alpha/backlog/bugs/open/bug-27.md' }),
        fakeItem({ id: 'bug-14', title: 'already merged', section: 'bugs',
          path: '/abs/alpha/backlog/bugs/open/bug-14.md' })
      ]
    );
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'started');

    expect(screen.getByText('orchestrator has it')).toBeInTheDocument();
    expect(screen.getByText('needs an answer')).toBeInTheDocument();
    // pending is claimed but not yet being worked; merged is finished. Neither
    // is live work, and a filter that swept in the whole queue would be as
    // wrong as one that swept in none of it.
    expect(screen.queryByText('still pending')).not.toBeInTheDocument();
    expect(screen.queryByText('already merged')).not.toBeInTheDocument();
  });
});
