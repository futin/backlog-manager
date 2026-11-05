/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { GlyphTile } from '../client/src/components/ui/GlyphTile';

describe('GlyphTile', () => {
  it('defaults to a neutral 28 tile around an svg, hidden from assistive tech', () => {
    const { container } = render(<GlyphTile glyph="play" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile).toHaveClass('ui-glyph-tile');
    expect(tile).toHaveAttribute('data-tone', 'neutral');
    expect(tile).toHaveAttribute('data-size', '28');
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile.querySelector('svg')).not.toBeNull();
  });
  it('takes tone and size, and draws a 10 px glyph at size 18', () => {
    const { container } = render(<GlyphTile glyph="tick" tone="ink" size={18} />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile).toHaveAttribute('data-tone', 'ink');
    expect(tile).toHaveAttribute('data-size', '18');
    expect(tile.querySelector('svg')).toHaveAttribute('width', '10');
  });
  it('draws a 14 px glyph at 28 and 32', () => {
    const { container } = render(<GlyphTile glyph="tick" size={32} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
  });
});
