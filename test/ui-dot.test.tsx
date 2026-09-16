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
    const tones: DotTone[] = ['live', 'paused', 'crashed', 'done', 'ramp-refactors', 'ramp-ideas', 'ramp-bugs', 'ramp-tasks'];
    for (const tone of tones) {
      const { unmount } = render(<Dot tone={tone} />);
      expect(dot()).toHaveClass(`ui-dot-${tone}`);
      unmount();
    }
  });

  /*
    No tone is a reading, not a missing prop (task-37): `.ui-dot`'s base rule
    paints `--ink3`, and that quiet grey is what a dot whose subject is in no
    state worth colouring has to look like. The run chip draws one when every
    run in the payload has finished; before this the nearest thing the props
    could say was `done`, which is `--fill-progress` — the token §8.3 gives a
    LIVE run.

    The negative half is the assertion that matters: no tone class AT ALL, not
    "some other tone class". A `ui-dot-undefined` would satisfy a check that
    only looked for the absence of one specific name, and would paint the base
    colour by accident rather than by rule.
  */
  it('paints the base quiet dot when it is given no tone at all', () => {
    render(<Dot />);

    expect(dot()).toHaveClass('ui-dot');
    expect(Array.from(dot().classList).filter((c) => c.startsWith('ui-dot-') && c !== 'ui-dot-8')).toEqual([]);
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
