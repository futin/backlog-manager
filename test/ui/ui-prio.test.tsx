/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { PriorityPill } from '../../client/src/components/ui/PriorityPill';

describe('PriorityPill', () => {
  it('draws the priority name toned by its weight, a glyph for Jira’s own names, and `priority <name>` as its title', () => {
    const { container } = render(<PriorityPill priority="High" />);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill).toHaveClass('ui-prio');
    expect(pill).toHaveAttribute('data-tone', 'high');
    expect(pill).toHaveAttribute('title', 'priority High');
    expect(pill).toHaveTextContent('High');
    expect(pill.querySelector('svg')).not.toBeNull();
  });

  it('draws a custom name as the quiet pill with no glyph', () => {
    const { container } = render(<PriorityPill priority="P1" />);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill).toHaveAttribute('data-tone', 'other');
    expect(pill).toHaveTextContent('P1');
    expect(pill.querySelector('svg')).toBeNull();
  });

  it('draws nothing for a null or empty priority', () => {
    expect(render(<PriorityPill priority={null} />).container).toBeEmptyDOMElement();
    expect(render(<PriorityPill priority="" />).container).toBeEmptyDOMElement();
  });
});
