/**
 * @jest-environment jsdom
 */
/*
 * bug-23: one Escape press used to close BOTH the launch sheet and the item
 * drawer it layers over, because all four dialogs in this app bound their own
 * unguarded `keydown` listener on `window` and called their own `onClose`
 * unconditionally. Every listener registered at the moment of the press fired.
 *
 * The two-dialogs-at-once state is deliberate and already pinned elsewhere
 * (`test/dispatch-button.test.tsx`, "opens the sheet from inside the drawer,
 * leaving the drawer open behind it") — what nothing pinned was that Escape
 * from there must close exactly one of them, the topmost.
 *
 * These cases go through the two real hosts rather than the components alone,
 * because the defect only exists where two of them coexist, and the coexistence
 * is the host's decision (BoardView's `open`/`dispatching` are independent
 * state, and ArchiveView copies that). The hook's own contract — LIFO ranking
 * and listener teardown — is the last case, against throwaway components.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { useState } from 'react';

import ArchiveView from '../client/src/components/archive/ArchiveView';
import BoardView from '../client/src/components/board/BoardView';
import { useDialogEscape } from '../client/src/hooks/useDialogEscape';
import type {
  AgentsStatus, BacklogItem, ItemsIndex, OrchestratorRunsPayload, ProjectSummary
} from '../shared/types';

const READY: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
};

/* Archive shows an item only once it is stale, Board only while it is fresh —
   the same corpus therefore cannot serve both hosts, so each gets its own
   `updated` stamp. Relative to now for the reason archive.test.tsx states: a
   literal date changes meaning as the calendar moves past it. */
const daysAgo = (days: number): string =>
  `${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19)}Z`;

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'task-1', title: 'a task', created: '2026-08-20', started: '', tags: [],
    updated: daysAgo(1), lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0,
    groomTokens: 0, executeTokens: 0, kind: '',
    section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: true, path: '/abs/alpha/backlog/tasks/open/task-1.md'
  };
  return { ...base, ...over };
}

const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 1, refactors: 0, 'out-of-scope': 0 } }
];

const realFetch = global.fetch;

/** Both hosts' whole world. `/api/items/body` answers `text()`, not `json()` —
 *  ItemDrawer's effect calls the former, and a json-only stub leaves the drawer
 *  stuck in its "item file unavailable" state, which would make these cases
 *  prove that the sheet layers over a BROKEN drawer. */
function stubFetch(items: BacklogItem[]): void {
  const index: ItemsIndex = { items, errors: [] };
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/items/body')) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') } as Response);
    }
    const payload: unknown = url.includes('/api/agents/status') ? READY
      : url.includes('/api/orchestrator/runs') ? ({ runs: [], starting: [] } satisfies OrchestratorRunsPayload)
        : url.includes('/api/agents/plan') ? {
          action: 'execute', prompt: 'do it', project: 'alpha',
          allowedModes: ['plan', 'acceptEdits'], defaultMode: 'acceptEdits'
        }
          : url.includes('/api/projects') ? PROJECTS : index;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  global.fetch = realFetch;
});

/** Opens the drawer on `a task`, then the launch sheet from inside it, and
 *  returns once both dialogs are on screen and the drawer's body fetch has
 *  landed (an unawaited resolution lands a setState after the assertions). */
async function openDrawerThenSheet(): Promise<void> {
  await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
  await userEvent.click(screen.getByText('a task'));
  const drawer = await screen.findByRole('dialog', { name: 'a task' });
  await waitFor(() => expect(within(drawer).queryByText('loading…')).not.toBeInTheDocument());
  await userEvent.click(within(drawer).getByRole('button', { name: 'execute' }));
  await screen.findByRole('dialog', { name: /dispatch task-1/ });
  expect(screen.getByRole('dialog', { name: 'a task' })).toBeInTheDocument();
}

describe('Escape with the launch sheet layered over the item drawer', () => {
  it('closes only the sheet on the board, leaving the drawer behind it open', async () => {
    stubFetch([fakeItem()]);
    render(<BoardView />);
    await openDrawerThenSheet();

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /dispatch task-1/ })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('dialog', { name: 'a task' })).toBeInTheDocument();
  });

  it('closes the drawer on the second press', async () => {
    stubFetch([fakeItem()]);
    render(<BoardView />);
    await openDrawerThenSheet();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /dispatch task-1/ })).not.toBeInTheDocument()
    );
    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'a task' })).not.toBeInTheDocument()
    );
  });

  /* The case that catches a registration effect keyed on `[onClose]`. Both
     hosts pass an inline arrow, so `onClose` has a new identity on every
     render — an effect keyed on it would pop and re-push the drawer's entry,
     climbing it back above the sheet. BoardView re-renders on its 5s runs poll
     and on `useNow` in real use; typing in its own search box is the same
     re-render with no timers to fake. */
  it('still closes only the sheet after the host re-renders underneath it', async () => {
    stubFetch([fakeItem()]);
    render(<BoardView />);
    await openDrawerThenSheet();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search items' }), 'a');
    expect(screen.getByRole('searchbox', { name: 'Search items' })).toHaveValue('a');

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /dispatch task-1/ })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('dialog', { name: 'a task' })).toBeInTheDocument();
  });

  // Archive renders the same two components from the same two independent
  // pieces of state, so the defect is reachable there identically.
  it('closes only the sheet on Archive too', async () => {
    stubFetch([fakeItem({ updated: daysAgo(90), section: 'bugs', id: 'bug-1', groomed: false })]);
    render(<ArchiveView />);
    await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
    await userEvent.click(screen.getByText('a task'));
    const drawer = await screen.findByRole('dialog', { name: 'a task' });
    await waitFor(() => expect(within(drawer).queryByText('loading…')).not.toBeInTheDocument());
    await userEvent.click(within(drawer).getByRole('button', { name: 'groom' }));
    await screen.findByRole('dialog', { name: /dispatch bug-1/ });

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /dispatch bug-1/ })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('dialog', { name: 'a task' })).toBeInTheDocument();
  });
});

describe('useDialogEscape', () => {
  function Dialog({ onClose }: { onClose: () => void }) {
    useDialogEscape(onClose);
    return null;
  }

  it('gives Escape to the last dialog mounted, then back to the one below it', async () => {
    const first = jest.fn();
    const second = jest.fn();
    render(<Dialog onClose={first} />);
    const { unmount } = render(<Dialog onClose={second} />);

    await userEvent.keyboard('{Escape}');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    unmount();
    await userEvent.keyboard('{Escape}');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  /* The listener is installed on the first entry and removed on the last one
     leaving — not installed permanently — so launch-sheet.test.tsx's "removes
     its Escape listener when it unmounts" keeps testing something real. */
  it('leaves no window listener behind once the stack empties', async () => {
    const remove = jest.spyOn(window, 'removeEventListener');
    const onClose = jest.fn();
    const { unmount } = render(<Dialog onClose={onClose} />);
    unmount();

    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    // And the proof it is gone rather than merely reported gone: the entry
    // that was on the stack hears nothing from a press after it left.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).not.toHaveBeenCalled();
    remove.mockRestore();
  });

  /* A dialog can unmount while another sits above it — the drawer's own close
     button while the sheet is open — so entries are removed by identity, never
     popped off the end. */
  it('removes the right entry when a dialog below the top unmounts', async () => {
    const below = jest.fn();
    const top = jest.fn();
    const { unmount } = render(<Dialog onClose={below} />);
    render(<Dialog onClose={top} />);

    unmount();
    await userEvent.keyboard('{Escape}');

    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  /* The callback behind an entry may change on every render; its position may
     not. This is the hook-level half of the board case above. */
  it('calls the latest onClose an entry was rendered with', async () => {
    const stale = jest.fn();
    const fresh = jest.fn();
    function Rerendering() {
      const [swapped, setSwapped] = useState(false);
      useDialogEscape(swapped ? fresh : stale);
      return <button onClick={() => setSwapped(true)}>swap</button>;
    }
    render(<Rerendering />);
    await userEvent.click(screen.getByRole('button', { name: 'swap' }));

    await userEvent.keyboard('{Escape}');

    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });
});
