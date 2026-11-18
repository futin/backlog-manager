/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { PersonMark } from '../../client/src/components/ui/PersonMark';

describe('PersonMark', () => {
  it('draws the initials on a disc and the name beside it', () => {
    const { container } = render(<PersonMark name="Dana Novak" />);
    const who = container.firstElementChild as HTMLElement;
    expect(who).toHaveClass('ui-person');
    const disc = who.querySelector('.ui-person-av') as HTMLElement;
    expect(disc).toHaveTextContent('DN');
    expect(disc).toHaveAttribute('aria-hidden', 'true');
    expect(disc).not.toHaveClass('none');
    expect(who.querySelector('.ui-person-name')).toHaveTextContent('Dana Novak');
  });

  it('draws the empty dashed disc and `unassigned` for nobody, so a row keeps its shape', () => {
    const { container } = render(<PersonMark name={null} />);
    const disc = container.querySelector('.ui-person-av') as HTMLElement;
    expect(disc).toHaveClass('none');
    expect(disc).toBeEmptyDOMElement();
    expect(container.querySelector('.ui-person-name')).toHaveTextContent('unassigned');
  });

  it('draws the disc alone, the name as its title, when `compact`', () => {
    const { container } = render(<PersonMark name="Dana Novak" compact />);
    expect(container.querySelector('.ui-person-name')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('title', 'Dana Novak');
  });
});
