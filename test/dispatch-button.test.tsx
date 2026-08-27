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

  it('names the destination for an idea', () => {
    render(<DispatchButton item={fakeItem({ id: 'idea-1', section: 'ideas', groomed: null })} status={READY} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'groom → task' })).toBeInTheDocument();
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
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringContaining('/abs/alpha'));
  });

  it('disables when dispatch is off', () => {
    render(<DispatchButton item={fakeItem()} status={{ ...READY, enabled: false }} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'execute' })).toBeDisabled();
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

  beforeEach(() => {
    // The drawer always fetches the item body on mount; a resolved stub
    // keeps that effect from rejecting into an unrelated "unavailable" state
    // that has nothing to do with what this test checks.
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response)
    ) as jest.Mock;
  });

  it('renders the dispatch button in the drawer head when the board supplies one', () => {
    render(
      <ItemDrawer item={fakeItem()} hues={HUES} onClose={() => {}} agents={READY} onDispatch={() => {}} />
    );
    const head = document.querySelector('.drawer-head') as HTMLElement;
    expect(within(head).getByRole('button', { name: 'execute' })).toBeInTheDocument();
  });

  it('renders nothing extra when agents/onDispatch are absent, same as before this task', () => {
    render(<ItemDrawer item={fakeItem()} hues={HUES} onClose={() => {}} />);
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
    counts: { bugs: 0, ideas: 1, tasks: 1, 'out-of-scope': 0 } }
];

describe('the board wiring', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status') ? READY
        : url.includes('/api/agents/plan') ? {
          action: 'execute', prompt: 'do it', project: 'alpha',
          allowedModes: ['plan', 'acceptEdits'], defaultMode: 'acceptEdits'
        }
        : url.includes('/api/projects') ? PROJECTS : ITEMS;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
    }) as jest.Mock;
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
    await userEvent.click(within(drawer).getByRole('button', { name: 'execute' }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: /dispatch task-1/ })).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'a task' })).toBeInTheDocument();
  });
});
