/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { RepoMark } from '../../client/src/components/ui/RepoMark';

describe('RepoMark', () => {
  it('draws one mapped path as its basename, the path as its title', () => {
    const { container } = render(<RepoMark paths={['/srv/code/payments/']} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark).toHaveClass('ui-repo');
    expect(mark).toHaveTextContent('payments');
    expect(mark).toHaveAttribute('title', '/srv/code/payments/');
    expect(mark.querySelector('svg')).not.toBeNull();
  });

  it('draws several paths as `N repos` with every path in the title', () => {
    const { container } = render(<RepoMark paths={['/srv/a', '/srv/b']} />);
    expect(container.firstElementChild).toHaveTextContent('2 repos');
    expect(container.firstElementChild).toHaveAttribute('title', '/srv/a\n/srv/b');
  });

  it('draws nothing when the project maps no path', () => {
    expect(render(<RepoMark paths={[]} />).container).toBeEmptyDOMElement();
  });
});
