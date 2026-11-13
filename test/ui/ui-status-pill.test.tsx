/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { StatusPill } from '../../client/src/components/ui/StatusPill';

describe('StatusPill', () => {
  it('renders the word', () => {
    render(<StatusPill tone="green" word="Working" />);
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it.each(['green', 'amber', 'red', 'grey'] as const)('carries tone %s on an aria-hidden dot', (tone) => {
    const { container } = render(<StatusPill tone={tone} word="x" />);
    const dot = container.querySelector('.ui-status-dot');
    expect(dot).toHaveAttribute('data-tone', tone);
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the age when given and no age node for null or absent', () => {
    const { container, rerender } = render(<StatusPill tone="green" word="Working" age="9s ago" />);
    expect(screen.getByText('9s ago')).toHaveClass('ui-status-age');

    rerender(<StatusPill tone="green" word="Working" age={null} />);
    expect(container.querySelector('.ui-status-age')).toBeNull();
    rerender(<StatusPill tone="green" word="Working" />);
    expect(container.querySelector('.ui-status-age')).toBeNull();
  });
});
