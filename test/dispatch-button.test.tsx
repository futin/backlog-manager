/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { DispatchButton } from '../client/src/components/board/DispatchButton';
import { ItemDrawer } from '../client/src/components/board/ItemDrawer';
import { buildProjectHues } from '../client/src/lib/project-hue';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentsStatus, BacklogItem, ItemsIndex, OrchestratorRun, OrchestratorRunsPayload, ProjectSummary,
  RunStage
} from '../shared/types';

/* Plain JSON, so TS widens its string fields to `string` rather than the
   literal unions (`RunStage`) the run-claim cases below turn on — the same
   cast every other suite reading this fixture makes. */
const runFixture = rawFixture as OrchestratorRun;
type RunPayload = OrchestratorRunsPayload['runs'][number];

/** One fresh run for `/abs/alpha` — the path `fakeItem` carries — holding
 *  exactly the ids given, all at one stage. Built off the contract fixture so
 *  the queue entries stay the real shape with only id and stage replaced. */
function runFor(ids: string[], stage: RunStage, over: Partial<RunPayload> = {}): RunPayload {
  return {
    ...runFixture,
    project: '/abs/alpha',
    queue: ids.map((id) => ({ ...runFixture.queue[0], id, stage })),
    fresh: true,
    pastRuns: 0,
    ...over
  };
}

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
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
};

describe('DispatchButton', () => {
  it('labels the action the item actually has', () => {
    render(<DispatchButton item={fakeItem()} status={READY} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'execute' })).toBeEnabled();
  });

  // Reads `groom`, not `groom → task`: where the item lands is the skill's
  // business, and one control should not look like two actions by column.
  it('labels an idea with the plain action word', () => {
    render(<DispatchButton item={fakeItem({ id: 'idea-1', section: 'ideas', groomed: null })} status={READY} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'groom' })).toBeInTheDocument();
  });

  // The tone class IS the action, so the palette cannot drift from the
  // derivation — `.groom` is mustard and `.execute` cyan in styles.css, and
  // neither is amber, which the in-progress mark on the same card owns.
  it('wears the action as its tone class, in both shapes', () => {
    const { unmount } = render(
      <DispatchButton item={fakeItem()} status={READY} onDispatch={() => {}} variant="tab" />
    );
    expect(screen.getByRole('button', { name: 'execute' })).toHaveClass('dispatch-tab', 'execute');
    unmount();

    render(
      <DispatchButton
        item={fakeItem({ section: 'bugs', groomed: false })} status={READY}
        onDispatch={() => {}}
      />
    );
    // chip is the default shape: the drawer head renders it with no variant.
    expect(screen.getByRole('button', { name: 'groom' })).toHaveClass('dispatch-chip', 'groom');
  });

  // The ▸ is decoration. If it ever reaches the accessible name, every query in
  // this file that asks for 'groom' or 'execute' stops matching — and so does a
  // screen reader's rendering of the control.
  it('keeps the mark out of the accessible name', () => {
    render(<DispatchButton item={fakeItem()} status={READY} onDispatch={() => {}} variant="tab" />);
    expect(screen.getByRole('button', { name: 'execute' })).toBeInTheDocument();
  });

  it('offers groom on an ungroomed bug and execute on a groomed one', () => {
    const { unmount } = render(
      <DispatchButton item={fakeItem({ section: 'bugs', groomed: false })} status={READY} onDispatch={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'groom' })).toBeEnabled();
    unmount();

    render(<DispatchButton item={fakeItem({ section: 'bugs', groomed: true })} status={READY} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'execute' })).toBeEnabled();
  });

  it('renders nothing for an item with no next step', () => {
    const { container } = render(
      <DispatchButton item={fakeItem({ status: 'done' })} status={READY} onDispatch={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the status is still unknown', () => {
    const { container } = render(<DispatchButton item={fakeItem()} status={null} onDispatch={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  /*
   * The fourth kind of block, and the only one whose reason comes in as a prop
   * rather than being derived here: "an orchestrator run has already claimed
   * this item" lives in the run payload alone, which this leaf has no access to
   * (see runClaimBlock in shared/agent.ts for why the item file cannot say it).
   * It disables with the reason rather than hiding, exactly like the
   * project-visibility block: it IS about this card, and it names a state the
   * reader can go and look at in the run strip above.
   */
  it('disables with the run\'s reason when a run has claimed the item', () => {
    render(
      <DispatchButton
        item={fakeItem()} status={READY} onDispatch={() => {}}
        runBlock="an orchestrator run is working this item (reviewing)"
      />
    );
    const btn = screen.getByRole('button', { name: 'execute' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', expect.stringContaining('reviewing'));
    // Same accessibility contract the project-visibility reason has: a tooltip
    // alone is announced unreliably, so the reason has to be a real description.
    const describedBy = btn.getAttribute('aria-describedby');
    expect(document.getElementById(String(describedBy))).toHaveTextContent('reviewing');
  });

  it('dispatches nothing when a run-claimed button is clicked', async () => {
    const onDispatch = jest.fn();
    render(
      <DispatchButton
        item={fakeItem()} status={READY} onDispatch={onDispatch}
        runBlock="an orchestrator run is working this item (reviewing)"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'execute' }));
    expect(onDispatch).not.toHaveBeenCalled();
  });

  /* Order preserved: an ENVIRONMENT-level block still hides the control
     outright, and a run claim must not resurrect it as a disabled button. That
     ordering is the "an environment-level block hides the dispatch control; the
     per-item ones disable it" invariant (CLAUDE.md), and a new block folded in
     ahead of the hidden check is exactly how it would be lost. */
  it('still renders nothing when the environment hides the control, run claim or not', () => {
    const { container } = render(
      <DispatchButton
        item={fakeItem()} status={{ ...READY, enabled: false }} onDispatch={() => {}}
        runBlock="an orchestrator run is working this item (reviewing)"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  /*
   * bug-12: the THIRD per-item block, and the only one derived from the item
   * file itself. `started:` is written by `backlog.mjs start` and cleared by
   * `stop`, so unlike the run claim it is right there on the item this leaf
   * already holds — hence a derivation and not a prop, and hence no signature
   * change at any of the three call sites.
   *
   * It disables rather than hides for the same reason the other two per-item
   * blocks do: it is a fact about THIS card, and the reason names something
   * the reader can act on (go find the session that holds it, or `stop` the
   * marker if nobody does).
   */
  it("disables with the session's reason when a local session already holds the item", () => {
    render(
      <DispatchButton
        item={fakeItem({ started: '2026-08-28T14:03:07Z', phase: 'execute' })}
        status={READY} onDispatch={() => {}}
      />
    );
    const btn = screen.getByRole('button', { name: 'execute' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', expect.stringContaining('executing'));
    const describedBy = btn.getAttribute('aria-describedby');
    expect(document.getElementById(String(describedBy)))
      .toHaveTextContent('2026-08-28T14:03:07Z');
  });

  it('dispatches nothing when an in-progress button is clicked', async () => {
    const onDispatch = jest.fn();
    render(
      <DispatchButton
        item={fakeItem({ started: '2026-08-28T14:03:07Z', phase: 'execute' })}
        status={READY} onDispatch={onDispatch}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'execute' }));
    expect(onDispatch).not.toHaveBeenCalled();
  });

  /* Ordering, and the half of it this block introduces: the stamp is on the
     file this board is rendering, the run claim is a volatile fact about
     another worktree, so the file wins. The two coexist only pathologically —
     a run works in its own worktree, so main's copy of a claimed item normally
     carries no stamp at all — but when they do, the reason has to name the
     thing the reader can actually go and look at on disk. */
  it("prefers the session's reason over a run's when an item somehow carries both", () => {
    render(
      <DispatchButton
        item={fakeItem({ started: '2026-08-28T14:03:07Z', phase: 'execute' })}
        status={READY} onDispatch={() => {}}
        runBlock="an orchestrator run is working this item (reviewing)"
      />
    );
    const btn = screen.getByRole('button', { name: 'execute' });
    expect(btn).toHaveAttribute('title', expect.stringContaining('executing'));
    expect(btn.getAttribute('title')).not.toContain('reviewing');
  });

  /* And the other half: project visibility still outranks it. A reason naming
     a running session would send the reader to look for a session when what
     actually needs fixing is which projects the dashboard can see. */
  it('still names the dashboard, not the session, when the project is invisible too', () => {
    render(
      <DispatchButton
        item={fakeItem({ started: '2026-08-28T14:03:07Z', phase: 'execute' })}
        status={{ ...READY, projectPaths: ['/abs/other'] }} onDispatch={() => {}}
      />
    );
    const btn = screen.getByRole('button', { name: 'execute' });
    expect(btn).toHaveAttribute('title', expect.stringContaining('/abs/alpha'));
    expect(btn.getAttribute('title')).not.toContain('executing');
  });

  /* The environment level is still above all three: ".env off ⇒ the board
     looks exactly as it did before this feature" has to stay true of an
     in-progress card as well, or the new block resurrects a control the
     environment had hidden. */
  it('still renders nothing when the environment hides the control, in progress or not', () => {
    const { container } = render(
      <DispatchButton
        item={fakeItem({ started: '2026-08-28T14:03:07Z', phase: 'execute' })}
        status={{ ...READY, enabled: false }} onDispatch={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The other side of the block, and the one that proves it is not simply
  // disabling everything: an item no session holds dispatches exactly as it
  // always did.
  it('dispatches normally for an open item no session holds', async () => {
    const onDispatch = jest.fn();
    render(<DispatchButton item={fakeItem()} status={READY} onDispatch={onDispatch} />);
    const btn = screen.getByRole('button', { name: 'execute' });
    expect(btn).toHaveAttribute('aria-disabled', 'false');
    await userEvent.click(btn);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it('disables with the reason when the dashboard cannot see the project', () => {
    render(
      <DispatchButton item={fakeItem()} status={{ ...READY, projectPaths: ['/abs/other'] }} onDispatch={() => {}} />
    );
    const btn = screen.getByRole('button', { name: 'execute' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', expect.stringContaining('/abs/alpha'));
  });

  // `title` on a `disabled` button is unreachable: the element is out of the
  // tab order, so a keyboard user cannot land on it, and the tooltip is
  // announced unreliably even when they could. This is now the ONLY disabled
  // state the button has, and the reason it carries is the only place in the
  // whole UI that names which project the dashboard cannot see (Settings
  // reports a count). So the reason has to be in the accessibility tree, and
  // the control has to be focusable for anything to read it out.
  it('keeps a blocked button focusable and describes the reason to a screen reader', async () => {
    render(
      <DispatchButton item={fakeItem()} status={{ ...READY, projectPaths: ['/abs/other'] }} onDispatch={() => {}} />
    );
    const btn = screen.getByRole('button', { name: 'execute' });

    // Reachable: Tab lands on it. A `disabled` attribute would make this fail.
    await userEvent.tab();
    expect(btn).toHaveFocus();

    // And the reason is a real description, not just a tooltip.
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(String(describedBy))).toHaveTextContent('/abs/alpha');
  });

  // aria-disabled is a label, not a behaviour: the browser happily fires a
  // click on it, so the handler's own guard is what makes the control inert.
  it('dispatches nothing when a blocked button is clicked or activated', async () => {
    const onDispatch = jest.fn();
    render(
      <DispatchButton item={fakeItem()} status={{ ...READY, projectPaths: ['/abs/other'] }} onDispatch={onDispatch} />
    );
    const btn = screen.getByRole('button', { name: 'execute' });
    await userEvent.click(btn);
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(onDispatch).not.toHaveBeenCalled();
  });

  // Environment-level blocks render NOTHING, which is what makes ".env off ⇒
  // the board looks exactly as it did before this feature" true rather than
  // aspirational. All four are properties of the host, not of this card: they
  // are true of every card at once, none is fixable from the board, and a dead
  // control on forty cards is noise the reader cannot act on. Settings is
  // where those four are reported, and it names the fix for each.
  it.each([
    ['dispatch is off', { enabled: false }],
    ['the dashboard is unreachable', { reachable: false, error: 'ECONNREFUSED' }],
    ['the dashboard has no CLAUDE_BIN', { spawnAvailable: false }],
    ['remote answers are off', { remoteAnswer: false }]
  ])('renders no button at all when %s', (_why, over) => {
    const { container } = render(
      <DispatchButton item={fakeItem()} status={{ ...READY, ...over }} onDispatch={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The button is a real <button>, so its own native Enter/Space activation
  // must be what fires — not the card's onKeyDown, which bubbles up from any
  // descendant and unconditionally opens the drawer. Proven at the board level
  // below (`opens the sheet from the keyboard...`), since that is where the
  // card's competing handler actually lives; this component alone has no card
  // to race against.
});

// Coverage gap the brief never touched: `ItemDrawer` gained the same two
// optional props as `ItemCard`, but no existing suite ever rendered it WITH
// them — `test/drawer.test.tsx` only ever calls it bare. Direct-render it
// here, the same way `test/drawer.test.tsx` does, rather than going through
// `BoardView`: the question is only "does the drawer render the button it
// was handed", which needs no board around it.
describe('ItemDrawer wiring', () => {
  const HUES = buildProjectHues([
    { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z' }
  ]);

  const realFetch = global.fetch;

  beforeEach(() => {
    // The drawer always fetches the item body on mount; a resolved stub
    // keeps that effect from rejecting into an unrelated "unavailable" state
    // that has nothing to do with what this test checks.
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response)
    ) as jest.Mock;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  /* Both cases await the body landing before asserting. The assertions
     themselves do not need it — the button is in the head, which renders
     immediately — but the fetch resolves either way, and a setState after the
     test has finished is exactly the un-acted update React warns about. */
  it('renders the dispatch button in the drawer head when the board supplies one', async () => {
    render(
      <ItemDrawer item={fakeItem()} hues={HUES} onClose={() => {}} agents={READY} onDispatch={() => {}} />
    );
    await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
    const head = document.querySelector('.drawer-head') as HTMLElement;
    expect(within(head).getByRole('button', { name: 'execute' })).toBeInTheDocument();
  });

  it('renders nothing extra when agents/onDispatch are absent, same as before this task', async () => {
    render(<ItemDrawer item={fakeItem()} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
    const head = document.querySelector('.drawer-head') as HTMLElement;
    expect(within(head).queryByRole('button', { name: /execute|groom/ })).not.toBeInTheDocument();
  });
});

// `title` is overridden on the idea fixture — the brief's version left it at
// the `fakeItem` default ('a task'), so the board rendered two cards with the
// identical text "a task" and `screen.getByText('a task')` in the tests below
// threw "found multiple elements" before either test's own assertions ran.
// Both items still exercise the board with a real mix of sections; only the
// title changed, so nothing about what these tests verify has moved.
const ITEMS: ItemsIndex = { items: [fakeItem(), fakeItem({ id: 'idea-1', title: 'an idea', section: 'ideas', groomed: null, path: '/abs/alpha/backlog/ideas/open/idea-1.md' })], errors: [] };
const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 1, tasks: 1, refactors: 0, 'out-of-scope': 0 } }
];

describe('the board wiring', () => {
  const realFetch = global.fetch;
  /* What the stub answers `/api/orchestrator/runs` with, per case. Mutable
     rather than a parameter because every case below renders BoardView the
     same way and only this list varies; the default is the empty payload the
     endpoint itself returns for a project that has never run the
     orchestrator, so every pre-existing case in this describe keeps behaving
     exactly as it did before runs entered the picture. */
  let RUNS: RunPayload[] = [];

  beforeEach(() => {
    localStorage.clear();
    RUNS = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      // `text`, not `json`, for this one route — ItemDrawer's effect calls
      // res.text(). A json-only stub made that effect throw a TypeError its
      // own .catch swallowed, so the drawer sat in its "item file
      // unavailable" state: the drawer test below then proved only that the
      // sheet layers over a BROKEN drawer, and the swallowed rejection landed
      // a setState after the assertions, which is where this file's two
      // act() warnings came from. Same shape test/drawer.test.tsx uses.
      if (url.includes('/api/items/body')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') } as Response);
      }
      const payload = url.includes('/api/agents/status') ? READY
        : url.includes('/api/orchestrator/runs') ? ({ runs: RUNS } satisfies OrchestratorRunsPayload)
        : url.includes('/api/agents/plan') ? {
          action: 'execute', prompt: 'do it', project: 'alpha',
          allowedModes: ['plan', 'acceptEdits'], defaultMode: 'acceptEdits'
        }
        : url.includes('/api/agents/dispatch') ? { sessionId: 'sess-1' }
        : url.includes('/api/projects') ? PROJECTS : ITEMS;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
    }) as jest.Mock;
  });

  // Same hazard test/agents-dispatch.test.ts guards against: a suite that
  // leaves a mock on global.fetch hands it to whatever runs next in the same
  // worker, where a forgotten stub passes on someone else's leftovers instead
  // of failing loudly.
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('opens the sheet from a card without opening the item drawer', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'execute' }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: /dispatch task-1/ })).toBeInTheDocument());
    // The card's own onClick must not have fired: two overlapping dialogs is
    // the bug this assertion exists for.
    expect(screen.queryByRole('dialog', { name: 'a task' })).not.toBeInTheDocument();
  });

  it('closes the sheet on cancel', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'execute' }));
    await userEvent.click(await screen.findByRole('button', { name: 'cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /dispatch task-1/ })).not.toBeInTheDocument()
    );
  });

  // The card's whole surface is role="button" with its own onKeyDown, which
  // bubbles up from ANY descendant (including this button) and unconditionally
  // opens the drawer. Enter on a focused dispatch button must activate the
  // button, not the card underneath it — the mouse-click test above proves
  // stopPropagation on click; this proves the keyboard path independently,
  // since a keydown reaching the card is a different bug than a click reaching
  // it (preventDefault on keydown silently cancels the button's own activation
  // rather than triggering both handlers the way an unstopped click would).
  it('opens the sheet from the keyboard without opening the item drawer', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;
    within(card).getByRole('button', { name: 'execute' }).focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('dialog', { name: /dispatch task-1/ })).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'a task' })).not.toBeInTheDocument();
  });

  // `open` and `dispatching` are two separate pieces of state in BoardView
  // specifically so the sheet can layer over an already-open drawer instead
  // of replacing it. Clicking a card's own dispatch button (proven above) only
  // ever exercises the drawer-closed path; this is the other one, and the
  // only assertion that actually distinguishes "separate state" from "shared
  // state that happens to pass the simpler case".
  it('opens the sheet from inside the drawer, leaving the drawer open behind it', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    await userEvent.click(screen.getByText('a task'));
    const drawer = await screen.findByRole('dialog', { name: 'a task' });
    // The drawer's own body fetch must have LANDED before anything else
    // happens here: otherwise this case proves the sheet layers over a drawer
    // stuck in its load-failed state, and the resolution arrives after the
    // last assertion as an un-acted state update.
    await waitFor(() => expect(within(drawer).queryByText('loading…')).not.toBeInTheDocument());
    expect(within(drawer).queryByText('item file unavailable')).not.toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole('button', { name: 'execute' }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: /dispatch task-1/ })).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'a task' })).toBeInTheDocument();
  });

  // The bug this exists for: DispatchButton's onKeyDown used to call
  // stopPropagation for EVERY key. React 18 delegates keydown at the root and
  // a synthetic stopPropagation also stops the native event, so nothing at
  // `window` ever saw it — and focus stays on this button after the sheet
  // opens, because nothing in the sheet takes it. Escape therefore never
  // reached the sheet's own window listener and the sheet would not close.
  // The standalone "closes on Escape" case in test/launch-sheet.test.tsx
  // passed throughout, because it mounts the sheet with nothing focused.
  it('closes the sheet on Escape with focus still on the card button that opened it', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;
    const btn = within(card).getByRole('button', { name: 'execute' });
    await userEvent.click(btn);
    await screen.findByRole('dialog', { name: /dispatch task-1/ });
    // Not re-focused by the test: this is where the click left it, which is
    // the whole point.
    expect(btn).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /dispatch task-1/ })).not.toBeInTheDocument()
    );
  });

  // LaunchSheet holds nine pieces of state and resets none of them on an
  // `item.path` change, so BoardView renders it with a `key`. Without that
  // key, re-targeting the sheet is a prop change: item A's `sessionId`
  // survives, and item B renders A's success panel under B's title with no
  // launch button at all — B reading as already launched and undispatchable.
  it('re-seeds the sheet when a different item is dispatched after a launch', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());

    const taskCard = screen.getByText('a task').closest('.board-card') as HTMLElement;
    await userEvent.click(within(taskCard).getByRole('button', { name: 'execute' }));
    await userEvent.click(await screen.findByRole('button', { name: 'launch' }));
    // The launched panel — the state that must not survive the switch.
    expect(await screen.findByText(/launched · /)).toBeInTheDocument();

    const ideaCard = screen.getByText('an idea').closest('.board-card') as HTMLElement;
    await userEvent.click(within(ideaCard).getByRole('button', { name: 'groom' }));

    expect(await screen.findByRole('dialog', { name: /dispatch idea-1/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'launch' })).toBeEnabled();
    expect(screen.queryByText(/launched · /)).not.toBeInTheDocument();
  });

  /*
   * The bug's own repro, at the layer it was reported from: while a run holds
   * `task-1`, that card's tear-off tab must be dead. The idea card is the
   * control — the run's queue does not mention it, so it stays live, which is
   * what distinguishes "the claimed card is disabled" from "the board disabled
   * everything the moment any run appeared".
   */
  it('disables the tab of a card a fresh run has claimed, leaving an unqueued sibling live', async () => {
    RUNS = [runFor(['task-1'], 'reviewing')];
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());

    const taskCard = screen.getByText('a task').closest('.board-card') as HTMLElement;
    await waitFor(() =>
      expect(within(taskCard).getByRole('button', { name: 'execute' }))
        .toHaveAttribute('aria-disabled', 'true')
    );
    expect(within(taskCard).getByRole('button', { name: 'execute' }))
      .toHaveAttribute('title', expect.stringContaining('reviewing'));

    const ideaCard = screen.getByText('an idea').closest('.board-card') as HTMLElement;
    expect(within(ideaCard).getByRole('button', { name: 'groom' }))
      .toHaveAttribute('aria-disabled', 'false');
  });

  /* The second render site, from the same payload — the drawer chip was passed
     no run data at all, which is half of what made this bug three surfaces
     saying "go ahead" instead of one. */
  it('disables the drawer chip for a claimed item, from the same run payload', async () => {
    RUNS = [runFor(['task-1'], 'merging')];
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());

    await userEvent.click(screen.getByText('a task'));
    const drawer = await screen.findByRole('dialog', { name: 'a task' });
    await waitFor(() => expect(within(drawer).queryByText('loading…')).not.toBeInTheDocument());

    await waitFor(() =>
      expect(within(drawer).getByRole('button', { name: 'execute' }))
        .toHaveAttribute('aria-disabled', 'true')
    );
    expect(within(drawer).getByRole('button', { name: 'execute' }))
      .toHaveAttribute('title', expect.stringContaining('merging'));
  });

  /* Staleness, at the board layer: a run that has stopped reporting renders no
     strip and badges no card, and it must not hold the dispatch control hostage
     either — recovering a crashed run is `--resume`/`--abort`'s job, and a
     permanently dead card is the worse failure. */
  it('leaves the tab live when the run holding the item has gone stale', async () => {
    RUNS = [runFor(['task-1'], 'reviewing', { fresh: false })];
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());

    const taskCard = screen.getByText('a task').closest('.board-card') as HTMLElement;
    expect(within(taskCard).getByRole('button', { name: 'execute' }))
      .toHaveAttribute('aria-disabled', 'false');
  });
});
