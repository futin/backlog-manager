/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { OrchestrateSheet } from '../client/src/components/board/OrchestrateSheet';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import rawFixture from './fixtures/orchestrator-run.json';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import type {
  AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary
} from '../shared/types';

// Same translation every other orchestrator suite (Task 8/10/11/12) already
// applies: the fixture is plain JSON, so without this cast its string fields
// widen to `string` instead of the narrower literal unions (RunStage, etc).
const fixture = rawFixture as OrchestratorRun;
type RunPayload = OrchestratorRun & { fresh: boolean; pastRuns: number };

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'task-1', title: 'a task', created: '2026-08-20', started: '', tags: [],
    updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
    section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: true, path: '/abs/alpha/backlog/tasks/open/task-1.md'
  };
  return { ...base, ...over };
}

const READY: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'acceptEdits', projectPaths: ['/abs/alpha']
};

const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 1, refactors: 0, 'out-of-scope': 0 } }
];

// Two projects, for the run-drawer exclusion case below: it needs a FRESH
// run to open RunDrawer from, but test case 4 already pins that a project's
// own fresh run hides ITS OWN Orchestrate button — so the run has to belong
// to a project other than the one the board is narrowed to, or there would
// be no button left to click at all.
const PROJECTS_TWO: ProjectSummary[] = [
  ...PROJECTS,
  { name: 'beta', path: '/abs/beta', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 } }
];

// =====================================================================
// The toolbar button — test cases 1-4 from the task brief, plus the
// mutual-exclusion regression the brief's own context calls out (Task 12
// added it for the item/run drawer pair; this sheet is a second dialog
// class that can now be open at the same time as LaunchSheet's, so the
// same hazard needs the same fix).
//
// All five render the real BoardView: the button's visibility is a
// function of board state (the project filter, useAgents' status, and
// useOrchestratorRuns' run list) that only BoardView actually assembles —
// unit-rendering a button in isolation would just be re-asserting the
// gate function's own logic against itself.
// =====================================================================
describe('toolbar Orchestrate button', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  /** Same URL-branching shape board.test.tsx / orchestrator-strip.test.tsx
   *  already use, with every endpoint BoardView now calls on mount. */
  function stub(
    opts: { agents?: AgentsStatus; runs?: RunPayload[]; items?: BacklogItem[]; projects?: ProjectSummary[] }
  ): jest.Mock {
    const agents = opts.agents ?? READY;
    const runs = opts.runs ?? [];
    const items = opts.items ?? [];
    const projects = opts.projects ?? PROJECTS;
    const fn = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      // /api/agents/plan and /api/agents/dispatch only matter to the mutual
      // -exclusion case below (it opens a real LaunchSheet), but stubbing
      // them unconditionally costs nothing for the other cases, which never
      // request either URL.
      const payload: unknown = url.includes('/api/agents/status') ? agents
        : url.includes('/api/orchestrator/runs') ? ({ runs } satisfies OrchestratorRunsPayload)
        : url.includes('/api/agents/plan') ? {
          action: 'execute', prompt: 'do it', project: 'alpha',
          allowedModes: ['plan', 'acceptEdits'], defaultMode: 'acceptEdits'
        }
        : url.includes('/api/agents/dispatch') ? { sessionId: 'sess-1' }
        : url.includes('/api/projects') ? projects
        : { items, errors: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  async function renderNarrowed(): Promise<void> {
    render(<BoardView />);
    // Not just "the label exists" — the select renders with only "All
    // projects" the instant BoardView mounts, before `/api/projects` has
    // even resolved. Waiting for alpha's own option is what proves the
    // fetch landed and selectOptions below has something to pick.
    await waitFor(() => expect(screen.getByRole('option', { name: 'alpha' })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/abs/alpha');
  }

  // --- Test case 1 ---------------------------------------------------
  it('renders no button while the board is unfiltered, even with capability on', async () => {
    stub({});
    render(<BoardView />);
    await waitFor(() => expect(screen.getByLabelText('Project')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Orchestrate' })).not.toBeInTheDocument();
  });

  // --- Test case 2 -----------------------------------------------------
  // Only the one environment reason the brief names (BM_AGENTS off) is
  // exercised here — environmentBlock's other three reasons already have
  // their own dedicated coverage (test/agents-shared.test.ts) and
  // DispatchButton's own it.each; re-running all four again here would only
  // re-prove the shared function, not this button's wiring to it.
  it('renders no button at all when narrowed but BM_AGENTS is off — hidden, not disabled', async () => {
    stub({ agents: { ...READY, enabled: false } });
    await renderNarrowed();
    expect(screen.queryByRole('button', { name: 'Orchestrate' })).not.toBeInTheDocument();
  });

  // --- Test case 3 -----------------------------------------------------
  it('disables the button with the reason in title when the dashboard cannot see the project', async () => {
    stub({ agents: { ...READY, projectPaths: [] } });
    await renderNarrowed();
    const btn = await screen.findByRole('button', { name: 'Orchestrate' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', expect.stringContaining('/abs/alpha'));

    // Mirrors DispatchButton's own "aria-disabled is a label, not a
    // behaviour" case: the guard inside onClick is what actually makes a
    // blocked control inert, and this is the only place that guard is
    // proven rather than merely declared.
    await userEvent.click(btn);
    expect(screen.queryByRole('dialog', { name: /orchestrate/ })).not.toBeInTheDocument();
  });

  // --- Test case 4 -----------------------------------------------------
  it('renders no button once a fresh run exists for the project — the strip owns that space', async () => {
    stub({ runs: [{ ...fixture, project: '/abs/alpha', fresh: true, pastRuns: 0 }] });
    await renderNarrowed();
    // The strip itself is proof the run landed, so the button's absence
    // here is "replaced by", not merely "coincides with".
    await waitFor(() => expect(screen.getByTestId('run-strip')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Orchestrate' })).not.toBeInTheDocument();
  });

  // A stale run must NOT hide the button — the strip itself renders
  // nothing for a stale run (RunStrip.tsx's own file comment), so the
  // toolbar control is the only way to start a fresh one once the last
  // one has gone silent. Not one of the brief's numbered cases, but the
  // inverse of case 4 is exactly the kind of edge its own "fresh" qualifier
  // implies, and it costs one more stub call to pin.
  it('still renders the button when the only known run for the project is stale', async () => {
    stub({ runs: [{ ...fixture, project: '/abs/alpha', fresh: false, pastRuns: 0 }] });
    await renderNarrowed();
    expect(await screen.findByRole('button', { name: 'Orchestrate' })).toBeEnabled();
  });

  // --- Dialog mutual exclusion ------------------------------------------
  // Task 12 made ItemDrawer/RunDrawer mutually exclusive because both are
  // `.drawer`s with no focus trap of their own — two mounted at once lets a
  // keyboard user Tab straight through the frontmost one into the other's
  // controls. OrchestrateSheet reuses LaunchSheet's own `.sheet` shape,
  // which has exactly the same no-focus-trap property, and this toolbar
  // button is always reachable at the same time as every card's dispatch
  // button AND every open drawer's own trigger (a card, a run strip) — so
  // the identical hazard exists for this sheet against all three of the
  // other overlays, not just LaunchSheet's.
  //
  // Every case below also asserts `queryAllByRole('dialog')` has length at
  // most 1 at each step — fix round 1's own ask, and a strictly stronger
  // claim than "the one I closed is gone": a length check catches a THIRD
  // dialog sneaking in that neither named assertion happens to be looking
  // for, which two `queryByRole(..., { name })` checks on their own cannot.
  it('opening the Orchestrate sheet closes an open item-dispatch sheet, and vice versa', async () => {
    stub({ items: [fakeItem()] });
    await renderNarrowed();
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());

    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'execute' }));
    expect(await screen.findByRole('dialog', { name: /dispatch task-1/ })).toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Orchestrate' }));
    expect(await screen.findByRole('dialog', { name: /orchestrate/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /dispatch task-1/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);

    await userEvent.click(within(card).getByRole('button', { name: 'execute' }));
    expect(await screen.findByRole('dialog', { name: /dispatch task-1/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /orchestrate/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
  });

  // Fix round 1 (Important — the gap this task's own review found): the
  // first pass reasoned by analogy from LaunchSheet's proven coexistence
  // with ItemDrawer that OrchestrateSheet could coexist with the drawers
  // too, but never actually tested it — and the analogy does not hold, since
  // LaunchSheet's coexistence is reachable only through a control INSIDE the
  // drawer it coexists with, while this toolbar button sits outside every
  // drawer and is clickable (or Tab-reachable past either drawer's own
  // untrapped focus) the entire time one is open. See BoardView's own
  // `openOrchestrateSheet` comment for the full reasoning; this pins it.
  it('opening the Orchestrate sheet closes an open item drawer, and vice versa — never more than one dialog', async () => {
    // Not just `open`: task-1 is `deriveAction`-queueable (open, groomed),
    // so it appears a SECOND time once the sheet is open — inside its own
    // queue preview (context point 6). Captured once here, while "a task"
    // is still unique, and reused below so the later clicks target the
    // CARD specifically rather than colliding with the preview's own copy
    // of the same title.
    stub({ items: [fakeItem()] });
    await renderNarrowed();
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;

    // The card's face, not its dispatch tab — this opens ItemDrawer, the
    // OTHER overlay from the one the case above already covers.
    await userEvent.click(within(card).getByText('a task'));
    expect(await screen.findByRole('dialog', { name: 'a task' })).toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Orchestrate' }));
    expect(await screen.findByRole('dialog', { name: /orchestrate/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'a task' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);

    // Back the other way: the card is still there behind where the sheet
    // was (opening Orchestrate does not remove the card, only the drawer).
    await userEvent.click(within(card).getByText('a task'));
    expect(await screen.findByRole('dialog', { name: 'a task' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /orchestrate/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
  });

  // The run-drawer half of the same gap. Needs a run belonging to a
  // DIFFERENT project than the one the board is narrowed to — see
  // PROJECTS_TWO's own comment for why: a project's own fresh run hides ITS
  // button (test case 4), so a run strip for the NARROWED project would
  // leave no Orchestrate button here to click at all.
  it('opening the Orchestrate sheet closes an open run drawer, and vice versa — never more than one dialog', async () => {
    stub({
      projects: PROJECTS_TWO,
      runs: [{ ...fixture, project: '/abs/beta', fresh: true, pastRuns: 0 }]
    });
    await renderNarrowed();

    const strip = await screen.findByTestId('run-strip');
    await userEvent.click(strip);
    expect(await screen.findByRole('dialog', { name: 'beta run' })).toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);

    await userEvent.click(await screen.findByRole('button', { name: 'Orchestrate' }));
    expect(await screen.findByRole('dialog', { name: /orchestrate/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'beta run' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);

    await userEvent.click(strip);
    expect(await screen.findByRole('dialog', { name: 'beta run' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /orchestrate/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
  });
});

// =====================================================================
// OrchestrateSheet itself, direct-rendered — the same split
// dispatch-button.test.tsx and launch-sheet.test.tsx already use between a
// component's own suite and the board-wiring one above. Covers test cases
// 5-7 from the brief, the queue-preview derivation (context point 6), and
// two rounds of differentiation the "closes into the strip world" case-7
// behaviour requires:
//   - fix round 1: a DIFFERENT http status (502, the dashboard itself
//     unreachable) must leave the sheet open and retryable, or every
//     transient failure would silently discard the user's picks.
//   - fix round 2: a SAME-status 409 that is not the activeRun lock — this
//     one endpoint answers 409 for three other reasons too (project just
//     lost visibility, no CLAUDE_BIN, remote answers off) — must ALSO leave
//     the sheet open, or a capability/visibility problem gets reported as
//     "your run is already in progress", which is confidently wrong rather
//     than merely unhelpful. `RUN_IN_PROGRESS_CODE` (shared/types.ts) is
//     what makes the lock 409 distinguishable from the other three at all.
// =====================================================================
describe('OrchestrateSheet', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  function renderSheet(props: Partial<Parameters<typeof OrchestrateSheet>[0]> = {}) {
    const onClose = jest.fn();
    const refresh = jest.fn();
    render(
      <SettingsProvider>
        <OrchestrateSheet
          project="/abs/alpha"
          projectName="alpha"
          items={[]}
          spawnMaxPermission="acceptEdits"
          onClose={onClose}
          refresh={refresh}
          {...props}
        />
      </SettingsProvider>
    );
    return { onClose, refresh };
  }

  /**
   * @param res The `/api/agents/orchestrate` response this test cares about
   *   — unchanged from before Task 8.
   * @param mergeCheck What `/api/agents/merge-check` answers. Defaults to
   *   "covered", which is what keeps Task 8's merge-mode picker from ever
   *   fetching that endpoint. Task 8's merge-mode picker seeds `mergeMode`
   *   from Settings, whose own default is `'merge'` — so every sheet in this
   *   describe block now fires a `/api/agents/merge-check` request the
   *   instant it mounts, whether or not the test below has anything to do
   *   with merge mode at all. Answered here, and kept OUT of `calls`, for
   *   the same reason `stub()`'s `/api/agents/plan`/`dispatch` branches
   *   above answer requests the mutual-exclusion cases never asked about:
   *   `calls` exists to record the one request most of these tests actually
   *   care about (the launch itself), and a merge-check row appearing in it
   *   would fail `toHaveLength(1)`/`toEqual` assertions that predate this
   *   feature and have nothing to do with it. The default's `covered: true`
   *   also keeps the setup hint (see the "merge-mode picker" section below)
   *   from rendering and leaking into an unrelated test's text assertions.
   *   A caller that DOES care passes a literal `{ covered, source }` to
   *   choose the hint's own answer, or the string `'fail'` to make the
   *   request reject outright (brief case 7).
   */
  function stubOrchestrate(
    res: { ok: boolean; status: number; body: unknown },
    mergeCheck: { covered: boolean; source: string | null } | 'fail' = { covered: true, source: null }
  ): { url: string; body: unknown }[] {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/agents/merge-check')) {
        return mergeCheck === 'fail'
          ? Promise.reject(new Error('network down'))
          : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mergeCheck) } as Response);
      }
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve({ ok: res.ok, status: res.status, json: () => Promise.resolve(res.body) } as Response);
    }) as jest.Mock;
    return calls;
  }

  // --- Test case 5 -------------------------------------------------------
  it('seeds model, effort and permission mode from settings and the ceiling, never a previous launch', () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({
      dispatchDefaultModel: 'sonnet', dispatchDefaultEffort: 'low'
    }));
    renderSheet({ spawnMaxPermission: 'acceptEdits' });

    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('sonnet');
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('low');
    // clampMode('auto', 'acceptEdits') === 'acceptEdits' — proves the seed is
    // actually clamped against the ceiling, not just echoing 'auto' back.
    expect((screen.getByLabelText('Permission mode') as HTMLSelectElement).value).toBe('acceptEdits');
    const modes = screen.getByLabelText('Permission mode') as HTMLSelectElement;
    expect([...modes.options].map((o) => o.value)).toEqual(['plan', 'acceptEdits']);
  });

  afterEach(() => {
    localStorage.clear();
  });

  // --- Queue preview derivation (context point 6) -------------------------
  // Final-review Important 5: this used to assert that `Fresh idea` WAS
  // rendered, which pinned the preview to `deriveAction` alone — and
  // `deriveAction` returns 'groom' for ideas and refactors, sections an
  // orchestrate run can never touch (`GATE_SECTIONS = { bugs, tasks }`,
  // orchestrate.mjs). The expectation is inverted below; a refactor joins the
  // fixture so the other half of `deriveAction`'s 'groom' answer is pinned
  // too, and the ungroomed BUG that was already here now carries the load of
  // proving the fix was not over-applied into "groomed bugs and tasks only".
  // Against the old code the two `queryByText` lines fail.
  it('previews only the open bugs and tasks a run can actually queue, and labels itself a preview', () => {
    // Every call overrides `path` along with `id`: `fakeItem`'s default path
    // names task-1 specifically, so leaving it unoverridden across the six
    // items here would collide `queue`'s own `key={item.path}` six ways.
    const items = [
      fakeItem({
        id: 'task-1', title: 'Groomed task', section: 'tasks', groomed: true,
        path: '/abs/alpha/backlog/tasks/open/task-1.md'
      }),
      fakeItem({
        id: 'bug-1', title: 'Ungroomed bug', section: 'bugs', groomed: false,
        path: '/abs/alpha/backlog/bugs/open/bug-1.md'
      }),
      fakeItem({
        id: 'idea-1', title: 'Fresh idea', section: 'ideas', groomed: null,
        path: '/abs/alpha/backlog/ideas/open/idea-1.md'
      }),
      fakeItem({
        id: 'refactor-1', title: 'Tidy the thing', section: 'refactors', groomed: null,
        path: '/abs/alpha/backlog/refactors/open/refactor-1.md'
      }),
      fakeItem({
        id: 'task-2', title: 'Already done', status: 'done', groomed: true,
        path: '/abs/alpha/backlog/tasks/done/task-2.md'
      }),
      fakeItem({
        id: 'oos-1', title: 'Rejected', section: 'out-of-scope', status: 'terminal', groomed: null,
        path: '/abs/alpha/backlog/out-of-scope/oos-1.md'
      })
    ];
    renderSheet({ items });

    expect(screen.getByText('Groomed task')).toBeInTheDocument();
    // An ungroomed BUG stays: the run queues it, gates it, and reports it as
    // ungroomed — which is exactly what this screen is for.
    expect(screen.getByText('Ungroomed bug')).toBeInTheDocument();
    // Ideas and refactors do not: `deriveAction` says 'groom' for both, but
    // the run's own queue is bugs and tasks, so listing them here would
    // promise work that can never happen.
    expect(screen.queryByText('Fresh idea')).not.toBeInTheDocument();
    expect(screen.queryByText('Tidy the thing')).not.toBeInTheDocument();
    expect(screen.queryByText('Already done')).not.toBeInTheDocument();
    expect(screen.queryByText('Rejected')).not.toBeInTheDocument();
    // The non-authoritative disclaimer this whole preview exists under.
    expect(screen.getByText(/preview/i)).toBeInTheDocument();
  });

  it('says so, rather than rendering an empty box, when nothing in the project is queueable', () => {
    renderSheet({ items: [fakeItem({ status: 'done' })] });
    expect(screen.getByText(/nothing groomed and open/i)).toBeInTheDocument();
  });

  // The empty-state's other route, and the one the section filter opened: a
  // project whose only open work is ideas has a non-empty `items` array and
  // still nothing an orchestrate run could queue.
  it('says so when the only open items are in sections a run never touches', () => {
    renderSheet({ items: [fakeItem({ id: 'idea-9', section: 'ideas', groomed: null, title: 'Just an idea' })] });
    expect(screen.getByText(/nothing groomed and open/i)).toBeInTheDocument();
    expect(screen.queryByText('Just an idea')).not.toBeInTheDocument();
  });

  // --- Test case 6 ---------------------------------------------------
  it('starts with exactly the picked project/model/effort/permissionMode and refreshes on success', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    const { onClose, refresh } = renderSheet();

    await userEvent.selectOptions(screen.getByLabelText('Model'), 'opus');
    await userEvent.selectOptions(screen.getByLabelText('Effort'), 'high');
    await userEvent.selectOptions(screen.getByLabelText('Permission mode'), 'plan');
    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0].url.endsWith('/api/agents/orchestrate')).toBe(true);
    // `mergeMode: 'merge'` here is Task 8's own addition (Settings' default,
    // untouched by this test) — see that feature's own describe block below
    // for the cases that pin ITS behaviour; this assertion only has to keep
    // proving it rides along unconditionally, same as every other body here.
    expect(calls[0].body).toEqual({
      project: '/abs/alpha', model: 'opus', effort: 'high', permissionMode: 'plan', mergeMode: 'merge'
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('omits model and effort when both are left on default', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge' });
  });

  // --- Test case 7 ---------------------------------------------------
  // Fix round 2: the server now sends `code: RUN_IN_PROGRESS_CODE` ONLY on
  // the activeRun-lock 409 (agents.service.ts's `orchestrate()`), and this
  // is the shape a real lock conflict actually arrives in — error text AND
  // code together, matching what test/orchestrator-start.test.ts's own
  // "carries RUN_IN_PROGRESS_CODE on the activeRun lock 409" case pins
  // server-side.
  it('shows the already-running message and closes into the strip world after refresh on a 409 conflict', async () => {
    stubOrchestrate({
      ok: false, status: 409,
      body: { error: 'a run is already in progress for this project (run-9)', code: RUN_IN_PROGRESS_CODE }
    });
    const { onClose, refresh } = renderSheet();

    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    expect(await screen.findByText(/already in progress/)).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  // Fix round 1 (Important): the case above alone cannot prove this is
  // detected by a stable discriminator rather than by matching a substring
  // of the server's message — its fixture happens to say "already in
  // progress" too, so a message-based check would pass it right alongside
  // a discriminator-based one. This case is the one that actually tells
  // them apart: same 409 status, same `code`, deliberately DIFFERENT
  // wording (not even a real server literal) — and the sheet still has to
  // close into the strip, because what it now checks is the code, not the
  // prose.
  it('closes on a coded 409, regardless of the message wording', async () => {
    stubOrchestrate({
      ok: false, status: 409,
      body: { error: 'nope, not right now', code: RUN_IN_PROGRESS_CODE }
    });
    const { onClose, refresh } = renderSheet();

    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    expect(await screen.findByText('nope, not right now')).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  // Fix round 2 (the finding this whole round exists for): a 409 status
  // ALONE is not enough — this endpoint's other three 409 reasons
  // (project-invisible, no CLAUDE_BIN, remote-answers-off, the dirName
  // race) never carry `code` at all, and confusing one of THOSE for the
  // lock would tell a user their run is "already in progress" when the
  // real problem is that the dashboard cannot spawn — confidently wrong,
  // not merely brittle. The message here is the server's REAL
  // project-invisible wording (agents.service.ts / shared/agent.ts's
  // `projectDispatchGate`), uncoded, and the sheet must stay open with it
  // rather than silently closing into a strip that will never appear
  // (nothing was ever started).
  it('leaves the sheet open and shows the server message for an uncoded 409 — a capability or visibility conflict, not the lock', async () => {
    stubOrchestrate({
      ok: false, status: 409,
      body: { error: 'the dashboard does not list /abs/alpha — most likely no Claude session there inside its LOOKBACK_HOURS' }
    });
    const { onClose, refresh } = renderSheet();

    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    expect(await screen.findByText(/does not list \/abs\/alpha/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'start' })).toBeEnabled();
  });

  // The differentiation above must NOT generalise past 409 either — see
  // this describe block's own file comment. 502 specifically: the one
  // status this endpoint answers with for "the dashboard itself is
  // unreachable" (agents.service.ts), which retrying a moment later can
  // genuinely resolve.
  it('leaves the sheet open and retryable for any other error', async () => {
    stubOrchestrate({ ok: false, status: 502, body: { error: 'dashboard unreachable' } });
    const { onClose, refresh } = renderSheet();

    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    expect(await screen.findByText('dashboard unreachable')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'start' })).toBeEnabled();
  });

  // =====================================================================
  // The item selector — checkboxes over the preview rows, so a run can be
  // narrowed to a subset of the queue instead of always draining all of it.
  //
  // The contract these cases defend, in one line: `ids` rides along ONLY
  // when the selection is a strict subset. Everything else about the
  // request, and every case above, is unchanged — which is itself pinned,
  // because "starts with exactly the picked project/model/effort/
  // permissionMode" asserts the whole body with toEqual and fails the
  // moment an `ids` key appears in a request that did not narrow anything.
  // =====================================================================

  /** Three queueable rows: two tasks and a bug, in board order. Every one
   *  overrides `path` as well as `id` for the reason the preview case above
   *  already gives — `fakeItem`'s default path names task-1, and `queue`
   *  keys on `item.path`. */
  const THREE = [
    fakeItem({ id: 'bug-1', title: 'A bug', section: 'bugs', groomed: true, path: '/abs/alpha/backlog/bugs/open/bug-1.md' }),
    fakeItem({ id: 'task-1', title: 'A task', section: 'tasks', groomed: true, path: '/abs/alpha/backlog/tasks/open/task-1.md' }),
    fakeItem({ id: 'task-2', title: 'Another task', section: 'tasks', groomed: true, path: '/abs/alpha/backlog/tasks/open/task-2.md' })
  ];

  const boxFor = (id: string): HTMLInputElement =>
    screen.getByRole('checkbox', { name: new RegExp(id) }) as HTMLInputElement;

  /* Everything checked on open, and this is the case that keeps the control
     from changing what the sheet MEANS. Someone who opens Orchestrate and
     presses start without noticing the checkboxes has always got a
     whole-queue drain, and must keep getting one. */
  it('checks every previewed row when it opens', () => {
    renderSheet({ items: THREE });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
  });

  /* The regression the whole "strict subset" rule exists for — and, since
     Task 8, the task brief's own case 8: `mergeMode` and `ids` have
     deliberately opposite absent-value semantics (the former is always
     sent, the latter only for a strict subset) and share this one request
     body, which is exactly where that distinction would get confused. An
     untouched sheet must send the request it sent before this feature
     existed, `mergeMode` aside — no `ids` key at all — because a full list
     is not the same instruction: it freezes the run to a snapshot of the
     queue taken when the sheet opened, and an item groomed and committed in
     the meantime would be silently dropped from a run the user believes is
     draining everything. */
  it('sends no ids at all when nothing was unchecked (brief case 8)', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet({ items: THREE });

    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge' });
  });

  it('sends exactly the still-checked ids, in board order, once one is unchecked', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet({ items: THREE });

    await userEvent.click(boxFor('task-1'));
    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({
      project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge', ids: ['bug-1', 'task-2']
    });
  });

  /* Refused on this side rather than left to the server's 400. The server
     check is the one that matters (a non-browser caller reaches it too), but
     a disabled button with a reason beside it is a better answer than a
     round trip that comes back an error, and it is the only place that can
     explain the distinction: unchecking everything means "run nothing",
     which is never what anyone wants, and is emphatically not the same as
     "run everything". */
  it('disables start, with a reason, when every row is unchecked', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet({ items: THREE });

    await userEvent.click(screen.getByRole('button', { name: /select none/i }));

    expect(screen.getByRole('button', { name: 'start' })).toBeDisabled();
    expect(screen.getByText(/pick at least one/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    expect(calls).toHaveLength(0);
  });

  it('re-enables start as soon as one row is checked again', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet({ items: THREE });

    await userEvent.click(screen.getByRole('button', { name: /select none/i }));
    await userEvent.click(boxFor('task-2'));

    expect(screen.getByRole('button', { name: 'start' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({
      project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge', ids: ['task-2']
    });
  });

  /* The subtle one, and the reason "strict subset" is a rule rather than an
     optimisation: a round trip through select-none and select-all lands on
     the same SET the sheet opened with, so it must land on the same REQUEST
     too. An implementation that tracked "has the user touched anything"
     instead of comparing the selection to the queue sends an explicit
     three-id list here and quietly re-introduces the snapshot problem the
     case above describes. */
  it('goes back to sending no ids after select-none then select-all', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet({ items: THREE });

    await userEvent.click(screen.getByRole('button', { name: /select none/i }));
    await userEvent.click(screen.getByRole('button', { name: /select all/i }));
    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge' });
  });

  /* An ungroomed item is a legal pick. The run really will queue it, gate
     it and report it as ungroomed — information, not an error — which is the
     same reasoning the preview itself is built on (see `queue`'s comment in
     OrchestrateSheet.tsx). Disabling its checkbox would be this screen
     claiming an authority over the gate that it explicitly does not have. */
  it('lets an ungroomed row be selected like any other', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet({
      items: [
        ...THREE,
        fakeItem({
          id: 'bug-2', title: 'Ungroomed bug', section: 'bugs', groomed: false,
          path: '/abs/alpha/backlog/bugs/open/bug-2.md'
        })
      ]
    });

    expect(boxFor('bug-2')).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /select none/i }));
    await userEvent.click(boxFor('bug-2'));
    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({
      project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge', ids: ['bug-2']
    });
  });

  /* The existing disclaimer promises the run may re-gate an item to a
     different VERDICT. It says nothing about the run ignoring most of the
     list, so a narrowed selection needs its own sentence — this is the last
     screen before a multi-hour unattended operation. */
  it('says the run is narrowed once a subset is selected, and not before', async () => {
    renderSheet({ items: THREE });
    expect(screen.queryByText(/only the 2 selected/i)).not.toBeInTheDocument();

    await userEvent.click(boxFor('task-1'));
    expect(screen.getByText(/only the 2 selected/i)).toBeInTheDocument();
  });

  /* Zero selected is narrowed too, arithmetically, and the sentence above
     renders as "only the 0 selected items will run" if it is gated on
     `narrowed` alone — a promise about a run that cannot start, sitting
     directly above the message explaining that it cannot. Caught by looking
     at the real sheet, not by the case above, which never reaches zero. */
  it('drops the narrowed sentence entirely when nothing is selected', async () => {
    renderSheet({ items: THREE });

    await userEvent.click(screen.getByRole('button', { name: /select none/i }));

    expect(screen.queryByText(/selected item/i)).not.toBeInTheDocument();
    expect(screen.getByText(/pick at least one/i)).toBeInTheDocument();
  });

  /* An empty queue is not an empty selection. There are no rows to check, so
     there is nothing to narrow, and the sheet keeps its pre-selector
     behaviour: start stays live and sends a plain whole-queue request. The
     preview is only an approximation of the gate (its own disclaimer says
     so), so refusing to start here would be the board overruling the tool on
     the strength of a derivation it already admits is not authoritative. */
  it('leaves start live for an empty queue, with no ids and no checkboxes', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet({ items: [fakeItem({ status: 'done' })] });

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'start' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge' });
  });

  // =====================================================================
  // The merge-mode picker and its setup hint (Task 8; design §2.2/§6). The
  // eight cases below are numbered to match the task brief's own table
  // exactly — case 8 is the regression guard fixed into the ids tests
  // above, not a new test here, since it pins the SHARED request body those
  // tests already cover rather than anything specific to this picker.
  // =====================================================================

  // --- Test case 1 -----------------------------------------------------
  it('seeds the merge-mode picker from the Settings default "branch"', () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ orchestrateDefaultMergeMode: 'branch' }));
    renderSheet();
    const picker = screen.getByLabelText('Merge mode') as HTMLSelectElement;
    expect(picker.value).toBe('branch');
    // The design's own binding wording (§2.2): each option names the
    // OUTCOME, never the flag — pinned here so a future edit that quietly
    // reverts to 'merge'/'branch' as the visible label fails a test instead
    // of only a design-doc diff.
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Merge to main', 'Leave branches for me']);
  });

  // --- Test case 2 -----------------------------------------------------
  // Seeded on 'branch' specifically (not the Settings default of 'merge')
  // so a passing assertion can only mean the OVERRIDE was sent, never a
  // default that happened to already read 'merge'.
  it('sends the picked mergeMode once the user switches away from the seeded default', async () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ orchestrateDefaultMergeMode: 'branch' }));
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet();

    await userEvent.selectOptions(screen.getByLabelText('Merge mode'), 'merge');
    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge' });
  });

  // --- Test case 3 -----------------------------------------------------
  // The brief's own wording: sent on EVERY launch, never omitted — even
  // an untouched sheet, sitting on exactly the Settings default nobody
  // picked, must still say so explicitly. (`stubOrchestrate`'s default
  // merge-check answer is 'covered', so this is not also exercising the
  // hint — that is cases 4/5/6/7's job below.)
  it('sends the Settings default mergeMode on an untouched launch, never omitted', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet();

    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge' });
  });

  // --- Test case 4 -----------------------------------------------------
  it('shows the setup hint, naming the file and the JSON to paste, when merge-check reports no coverage', async () => {
    stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } }, { covered: false, source: null });
    renderSheet();

    // `findBy`, not a synchronous `getBy`: the hint depends on the
    // merge-check response actually landing, and this is the one case in
    // this section where waiting for something to APPEAR is the right tool
    // — case 5 below is the mirror case (waiting for something to stay
    // ABSENT), which `findBy` cannot prove and is handled differently.
    expect(await screen.findByText(/settings\.local\.json/)).toBeInTheDocument();
    expect(screen.getByText('git merge')).toBeInTheDocument();
    expect(screen.getByText('Bash(git merge:*)', { exact: false })).toBeInTheDocument();
  });

  // --- Test case 5 -----------------------------------------------------
  // A controlled deferred + `act`, not `findBy`/`waitFor`, because the
  // claim here is an ABSENCE. `findByText` retries until something APPEARS
  // and would simply time out trying to prove a negative, and a bare
  // `waitFor(() => expect(...).not.toBeInTheDocument())` would pass at
  // t=0 — before the merge-check round trip (and the `mergeCoverage`
  // update it drives) has happened at all — which would let a real
  // inversion of the hint's own `!mergeCoverage.covered` guard slip
  // straight through this test undetected. Awaiting the SPECIFIC promise
  // this mock handed out, inside `act`, is what makes "settled, and still
  // nothing rendered" an actual claim about mounted state rather than
  // about the instant of render, before `mergeCoverage` has even left
  // `null`. Same technique dispatch-button.test.tsx's own
  // "marks itself busy while the re-ask is in flight" case already uses.
  it('shows no hint once merge-check reports coverage', async () => {
    let settle: (value: Response) => void = () => {};
    global.fetch = jest.fn(() => new Promise<Response>((resolve) => { settle = resolve; })) as jest.Mock;
    renderSheet();

    await act(async () => {
      settle({
        ok: true, status: 200,
        json: () => Promise.resolve({ covered: true, source: '/abs/alpha/.claude/settings.json' })
      } as Response);
    });

    expect(screen.queryByText(/settings\.local\.json/)).not.toBeInTheDocument();
  });

  // --- Test case 6 -----------------------------------------------------
  // No `act`/`waitFor` needed here at all: the decision not to fetch is
  // made SYNCHRONOUSLY, in the effect's own `mergeMode !== 'merge'` branch
  // (OrchestrateSheet.tsx), which RTL's `render` already flushes before
  // returning — there is no async step for this assertion to race against.
  it('never fetches merge-check at all when branch mode is selected', () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ orchestrateDefaultMergeMode: 'branch' }));
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as jest.Mock;
    renderSheet();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/settings\.local\.json/)).not.toBeInTheDocument();
  });

  // --- Test case 7 -----------------------------------------------------
  // A controlled deferred REJECTION + `act`, deliberately awaited BEFORE
  // clicking start — not after, and not interleaved via plain `waitFor`.
  // `start` (OrchestrateSheet.tsx) calls `setError(null)` as its own very
  // first line, unconditionally, the instant it is pressed: a version of
  // this test that clicked start first and only checked for "no error" at
  // the end would have that click silently erase the exact evidence a
  // merge-check leak would leave behind, passing whether or not the leak
  // happened. Splitting it into "let the failed request settle and prove
  // nothing rendered from it" first, THEN "start still launches", is what
  // makes each half a claim about its own step rather than one step's
  // side effect quietly covering for the other's bug.
  it('shows no hint and surfaces no error once merge-check fails, then still launches on start', async () => {
    let reject: (err: Error) => void = () => {};
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/agents/merge-check')) {
        return new Promise<Response>((_resolve, rej) => { reject = rej; });
      }
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve({
        ok: true, status: 201, json: () => Promise.resolve({ sessionId: 'sess-9' })
      } as Response);
    }) as jest.Mock;
    const { onClose, refresh } = renderSheet();

    await act(async () => {
      reject(new Error('network down'));
    });

    expect(screen.queryByText(/settings\.local\.json/)).not.toBeInTheDocument();
    // A substring match, not an exact one: a leak would render whatever
    // `error` holds VERBATIM (no fixed prefix), so it could arrive wrapped
    // (`Error: network down`, `String(e)`, ...) rather than as the bare
    // message this mock rejects with — an exact-match query would miss it.
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();

    // The hint failing to show up must not have cost the launch anything —
    // a hint is not worth blocking a run over, and this is the step that
    // proves it literally does not.
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { onClose } = renderSheet();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
