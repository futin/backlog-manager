/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { TreeMark } from '../../client/src/components/ui/TreeMark';

describe('TreeMark', () => {
  it('draws the one tree’s branch, its path as the title', () => {
    const { container } = render(<TreeMark trees={[{ path: '/srv/wt/pay-12', branch: 'pay-12-refunds' }]} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark).toHaveClass('ui-tree');
    expect(mark).toHaveTextContent('pay-12-refunds');
    expect(mark).toHaveAttribute('title', '/srv/wt/pay-12');
  });

  it('draws a detached tree’s directory name when its one tree has no branch', () => {
    const { container } = render(<TreeMark trees={[{ path: '/srv/wt/pay-12/', branch: null }]} />);
    expect(container.firstElementChild).toHaveTextContent('pay-12');
    expect(container.firstElementChild).toHaveAttribute('title', '/srv/wt/pay-12/');
  });

  it('draws several trees as `N worktrees` with every path in the title', () => {
    const { container } = render(
      <TreeMark
        trees={[
          { path: '/srv/wt/a', branch: 'a' },
          { path: '/srv/wt/b', branch: null }
        ]}
      />
    );
    expect(container.firstElementChild).toHaveTextContent('2 worktrees');
    expect(container.firstElementChild).toHaveAttribute('title', '/srv/wt/a\n/srv/wt/b');
  });

  it('draws nothing for a ticket with no tree', () => {
    expect(render(<TreeMark trees={[]} />).container).toBeEmptyDOMElement();
  });
});
