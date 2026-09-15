/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Dot, type DotTone } from '../client/src/components/ui/Dot';

const dot = (): Element => document.querySelector('.ui-dot') as Element;

describe('Dot', () => {
  /*
    Hidden unconditionally, and that IS its accessible name: every place this
    board draws a dot, the word it belongs to is already beside it. A dot with
    a label would read the status twice.
  */
  it('is always hidden from the accessibility tree and carries no text', () => {
    render(<Dot tone="live" />);

    expect(dot()).toHaveAttribute('aria-hidden', 'true');
    expect(dot().textContent).toBe('');
  });

  it('lands each status tone as its own class', () => {
    const tones: DotTone[] = [
      'live', 'paused', 'crashed', 'done',
      'ramp-refactors', 'ramp-ideas', 'ramp-bugs', 'ramp-tasks'
    ];
    for (const tone of tones) {
      const { unmount } = render(<Dot tone={tone} />);
      expect(dot()).toHaveClass(`ui-dot-${tone}`);
      unmount();
    }
  });

  /*
    The hue arrives as a class, never a style attribute (§8.2) — which is what
    lets a theme swap recolour every project dot on the board for free. A
    `style` here would freeze one palette's value onto the element.
  */
  it('paints a project hue by class and never by a style attribute', () => {
    render(<Dot hue={5} />);

    expect(dot()).toHaveClass('ui-dot-proj-5');
    expect(dot().getAttribute('style')).toBeNull();
  });

  it('defaults to 8 px and takes 10 px as its own class', () => {
    const { unmount } = render(<Dot tone="done" />);
    expect(dot()).toHaveClass('ui-dot-8');
    unmount();

    render(<Dot tone="done" size={10} />);
    expect(dot()).toHaveClass('ui-dot-10');
  });

  it('breathes only when asked', () => {
    const { rerender } = render(<Dot tone="live" />);
    expect(dot()).not.toHaveClass('ui-dot-breathe');

    rerender(<Dot tone="live" breathe />);
    expect(dot()).toHaveClass('ui-dot-breathe');
  });
});
