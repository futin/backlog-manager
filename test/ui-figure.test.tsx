/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Figure, FigureStrip } from '../client/src/components/ui/Figure';

describe('Figure', () => {
  it('reads label then value, both as text', () => {
    render(<Figure label="Runs" value="12" />);

    expect(screen.getByText('Runs')).toHaveClass('ui-figure-label');
    expect(screen.getByText('12')).toHaveClass('ui-figure-value', 'ui-figure-ink');
  });

  it('lands each tone as its own class', () => {
    for (const tone of ['ink', 'live', 'good', 'warn', 'bad'] as const) {
      const { unmount } = render(<Figure label="l" value="1" tone={tone} />);
      expect(screen.getByText('1')).toHaveClass(`ui-figure-${tone}`);
      unmount();
    }
  });

  it('draws the unit and the delta line only when given', () => {
    const { rerender } = render(<Figure label="Spend" value="12" />);
    expect(document.querySelector('.ui-figure-unit')).toBeNull();
    expect(document.querySelector('.ui-figure-line')).toBeNull();

    rerender(<Figure label="Spend" value="12" unit="$" line="3 more than last week" />);
    expect(screen.getByText('$')).toHaveClass('ui-figure-unit');
    expect(screen.getByText('3 more than last week')).toHaveClass('ui-figure-line');
  });

  it('takes the row’s full width only when wide', () => {
    const { rerender } = render(<Figure label="l" value="1" />);
    expect(document.querySelector('.ui-figure')).not.toHaveClass('ui-figure-wide');

    rerender(<Figure label="l" value="1" wide />);
    expect(document.querySelector('.ui-figure')).toHaveClass('ui-figure-wide');
  });
});

describe('FigureStrip', () => {
  it('wraps its figures in the one strip that owns their layout', () => {
    render(
      <FigureStrip>
        <Figure label="a" value="1" />
        <Figure label="b" value="2" />
      </FigureStrip>
    );

    const strip = document.querySelector('.ui-figure-strip');
    expect(strip).not.toBeNull();
    expect(strip?.querySelectorAll('.ui-figure')).toHaveLength(2);
  });
});
