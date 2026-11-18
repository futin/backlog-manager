/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { IssueStatus } from '../../client/src/components/ui/IssueStatus';

describe('IssueStatus', () => {
  it('draws the raw status name beside a dot in its column’s tone', () => {
    const { container } = render(<IssueStatus status={{ name: 'In Review', category: 'indeterminate' }} />);
    const status = container.firstElementChild as HTMLElement;
    expect(status).toHaveClass('ui-issue-status');
    expect(status).toHaveTextContent('In Review');
    const dot = status.querySelector('.ui-issue-status-dot') as HTMLElement;
    expect(dot).toHaveAttribute('data-tone', 'doing');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });

  it('tones a done status done and a new one todo', () => {
    const { container, rerender } = render(<IssueStatus status={{ name: 'Closed', category: 'done' }} />);
    expect(container.querySelector('.ui-issue-status-dot')).toHaveAttribute('data-tone', 'done');
    rerender(<IssueStatus status={{ name: 'Backlog', category: 'new' }} />);
    expect(container.querySelector('.ui-issue-status-dot')).toHaveAttribute('data-tone', 'todo');
  });

  it('draws nothing for a status Jira did not send', () => {
    expect(render(<IssueStatus status={null} />).container).toBeEmptyDOMElement();
  });
});
