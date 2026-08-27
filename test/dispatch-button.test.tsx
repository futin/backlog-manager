/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { DispatchButton } from '../client/src/components/board/DispatchButton';
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

  // `status` is only ever as trustworthy as whoever resolved the hook that
  // produced it: `unwrap` in lib/agents.ts casts the fetched JSON to
  // `AgentsStatus` with a bare `as`, a promise TypeScript cannot enforce once
  // the bytes actually arrive. A payload missing the fields every real answer
  // carries (this is exactly the shape BoardView's own item/project index
  // takes) is not a status this component has ever validated — it must render
  // nothing, the same as `status === null`, rather than let `dispatchBlock`
  // read `undefined` as a false-y `enabled` and announce a fabricated reason.
  it('renders nothing when the status object does not look like a real answer', () => {
    const bogus = { items: [], errors: [] } as unknown as AgentsStatus;
    const { container } = render(<DispatchButton item={fakeItem()} status={bogus} onDispatch={() => {}} />);
    expect(container).toBeEmptyDOMElement();
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
});
