/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
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
    updated: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
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

  function stubOrchestrate(res: { ok: boolean; status: number; body: unknown }): { url: string; body: unknown }[] {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
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
    expect(calls[0].body).toEqual({
      project: '/abs/alpha', model: 'opus', effort: 'high', permissionMode: 'plan'
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('omits model and effort when both are left on default', async () => {
    const calls = stubOrchestrate({ ok: true, status: 201, body: { sessionId: 'sess-9' } });
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ project: '/abs/alpha', permissionMode: 'acceptEdits' });
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
      body: { error: 'the dashboard cannot see /abs/alpha — no Claude session there inside its LOOKBACK_HOURS' }
    });
    const { onClose, refresh } = renderSheet();

    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    expect(await screen.findByText(/cannot see \/abs\/alpha/)).toBeInTheDocument();
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

  it('closes on Escape', async () => {
    const { onClose } = renderSheet();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
