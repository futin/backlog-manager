/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ItemDrawer } from '../client/src/components/board/ItemDrawer';
import type { BacklogItem } from '../shared/types';

const ITEM: BacklogItem = {
  id: 'bug-2', title: 'groomed bug', created: '2026-08-20', tags: ['ui'],
  section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
  groomed: true, path: '/abs/alpha/backlog/bugs/open/bug-2-groomed-bug.md'
};

describe('ItemDrawer', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('## Cause\n\noff by one\n') } as Response)
    ) as jest.Mock;
  });

  it('fetches the body by path and renders the markdown', async () => {
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/items/body?path=${encodeURIComponent(ITEM.path)}`
    );
    await waitFor(() => expect(screen.getByText('Cause')).toBeInTheDocument());
    expect(screen.getByText('off by one')).toBeInTheDocument();
  });

  it('shows the item meta: pill, project, created, path', async () => {
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'groomed bug' })).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText(/alpha · 2026-08-20/)).toBeInTheDocument();
    expect(screen.getByText(ITEM.path)).toBeInTheDocument();
  });

  it('closes on Escape, on the close button, and on the backdrop', async () => {
    const onClose = jest.fn();
    render(<ItemDrawer item={ITEM} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('shows an unavailable state when the body fetch fails', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: false, status: 404 } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('item file unavailable')).toBeInTheDocument());
  });
});
