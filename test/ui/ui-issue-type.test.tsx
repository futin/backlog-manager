/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { IssueTypeTile } from '../../client/src/components/ui/IssueTypeTile';

describe('IssueTypeTile', () => {
  it('draws the type glyph on a tile toned by the type, with the type name as its title', () => {
    const { container } = render(<IssueTypeTile type={{ name: 'Bug', level: 0, subtask: false }} />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile).toHaveClass('ui-issue-type');
    expect(tile).toHaveAttribute('data-tone', 'bug');
    expect(tile).toHaveAttribute('title', 'Bug');
    expect(tile.querySelector('svg.ui-type-icon')).not.toBeNull();
  });

  it('tones a story green-family and anything else neutral', () => {
    const { container, rerender } = render(<IssueTypeTile type={{ name: 'Story', level: 0, subtask: false }} />);
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'story');
    rerender(<IssueTypeTile type={{ name: 'Epic', level: 1, subtask: false }} />);
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'neutral');
    expect(container.firstElementChild).toHaveAttribute('title', 'Epic');
  });

  it('draws nothing for a type Jira did not send', () => {
    const { container } = render(<IssueTypeTile type={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
