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
import type { AgentsStatus, BacklogItem, ItemsIndex, ProjectSummary } from '../shared/types';

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

  beforeEach(() => {
    localStorage.clear();
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
});
