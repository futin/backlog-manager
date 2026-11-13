/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Pill } from '../../client/src/components/ui/Pill';

describe('Pill', () => {
  it('is plain text at the neutral tone by default', () => {
    render(<Pill>7</Pill>);

    const pill = screen.getByText('7');
    expect(pill.tagName).toBe('SPAN');
    expect(pill).toHaveClass('ui-pill', 'ui-pill-neutral');
  });

  it('lands each tone as its own class', () => {
    for (const tone of ['neutral', 'live', 'warn', 'bad', 'done'] as const) {
      const { unmount } = render(<Pill tone={tone}>x</Pill>);
      expect(screen.getByText('x')).toHaveClass(`ui-pill-${tone}`);
      unmount();
    }
  });

  /*
    `off` is a state on top of a tone, not a sixth tone: the tone class stays
    (so a palette swap still moves the colour) and `ui-pill-off` is added beside
    it. A machine's disallowed models and efforts are drawn this way.
  */
  it('adds ui-pill-off on top of the neutral tone when off', () => {
    render(<Pill off>opus</Pill>);

    expect(screen.getByText('opus')).toHaveClass('ui-pill', 'ui-pill-neutral', 'ui-pill-off');
  });

  it('is not off unless asked', () => {
    render(<Pill>opus</Pill>);

    expect(screen.getByText('opus')).not.toHaveClass('ui-pill-off');
  });

  it('keeps its tone class and title when off', () => {
    render(
      <Pill off tone="live" title="t">
        opus
      </Pill>
    );

    const pill = screen.getByText('opus');
    expect(pill).toHaveClass('ui-pill-live', 'ui-pill-off');
    expect(pill).toHaveAttribute('title', 't');
  });

  /*
    A pill states a fact and is never clickable — §7 gives the chip the stroke
    and the pointer. Pinned as the absence of a role rather than left implicit:
    the first composer that wants a clickable pill should reach for `Chip`, and
    this case is what tells them so.
  */
  it('has no interactive role', () => {
    render(<Pill tone="live">running</Pill>);

    expect(screen.queryByRole('button')).toBeNull();
  });

  /*
    A pill's glyph leads its text and is decorative, like every Glyph: the words carry the claim. Absent unless passed, so a count or a mode pill draws
    exactly the one text node it always did.
  */
  it('draws a leading aria-hidden glyph when given one', () => {
    render(
      <Pill tone="bad" glyph="cross">
        checks failing
      </Pill>
    );

    const pill = screen.getByText('checks failing');
    const svg = pill.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(pill.firstElementChild).toBe(svg);
  });

  it('draws no svg without a glyph', () => {
    render(<Pill>7</Pill>);

    expect(screen.getByText('7').querySelector('svg')).toBeNull();
  });
});
