/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import type { BacklogItem, ItemsIndex, ProjectSummary } from '../shared/types';

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
    ...over
  };
}

const ITEMS: ItemsIndex = {
  items: [
    fakeItem({}),
    fakeItem({ id: 'bug-2', title: 'groomed bug', groomed: true }),
    fakeItem({ id: 'task-1', title: 'a task', section: 'tasks', project: 'beta', projectPath: '/abs/beta', groomed: true }),
    fakeItem({ id: 'task-9', title: 'finished task', section: 'tasks', status: 'done', groomed: true }),
    fakeItem({ id: 'idea-1', title: 'an idea', section: 'ideas', groomed: null }),
    fakeItem({ id: 'oos-1', title: 'declined thing', section: 'out-of-scope', status: 'terminal', groomed: null })
  ],
  errors: ['/abs/alpha/backlog/ideas/open/idea-9-broken.md: frontmatter has no closing --- line']
};

const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 2, ideas: 1, tasks: 0, 'out-of-scope': 1 } },
  { name: 'beta', path: '/abs/beta', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 1, 'out-of-scope': 0 } },
  { name: 'ghost', path: '/abs/ghost', createdAt: '2026-08-26T00:00:00.000Z', missing: true,
    counts: { bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 } }
];

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.includes('/api/projects') ? PROJECTS : ITEMS;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
});

async function renderBoard() {
  render(<BoardView />);
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

describe('BoardView', () => {
  it('renders the four columns with counts of what they hold (open by default)', async () => {
    await renderBoard();
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-name').textContent))
      .toEqual(['Bugs', 'Ideas', 'Tasks', 'Out of scope']);
    // done task-9 hidden by the default open filter; oos unaffected
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent))
      .toEqual(['2', '1', '1', '1']);
    expect(screen.queryByText('finished task')).not.toBeInTheDocument();
  });

  it('marks groomed bugs and shows id · project · date on the card', async () => {
    await renderBoard();
    const card = screen.getByText('groomed bug').closest('.board-card') as HTMLElement;
    expect(within(card).getByText('· groomed')).toBeInTheDocument();
    expect(card.textContent).toContain('bug-2 · alpha · 2026-08-20');
  });

  it('status filter: done shows only done items in the three queue columns', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');
    expect(screen.getByText('finished task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
    // out-of-scope is flat and stays put
    expect(screen.getByText('declined thing')).toBeInTheDocument();
  });

  it('project filter narrows every column by projectPath', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/abs/beta');
    expect(screen.getByText('a task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
  });

  it('search narrows by title, and no matches shows the empty state', async () => {
    await renderBoard();
    await userEvent.type(screen.getByLabelText('Search items'), 'zzz');
    expect(screen.getByText('no matches')).toBeInTheDocument();
  });

  it('surfaces scan errors and missing projects as a warning line', async () => {
    await renderBoard();
    const warn = screen.getByTestId('board-warn');
    expect(warn.textContent).toContain('idea-9-broken.md');
    expect(warn.textContent).toContain('ghost');
  });

  it('opens the drawer when a card is clicked', async () => {
    await renderBoard();
    await userEvent.click(screen.getByText('a bug'));
    expect(screen.getByRole('dialog', { name: 'a bug' })).toBeInTheDocument();
  });

  it('shows the nothing-registered empty state on an empty index', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/projects') ? [] : { items: [], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('nothing registered yet')).toBeInTheDocument());
  });
});
