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

/**
 * task-38's two prop-driven variants. Both exist because §12.1 says a surface
 * that needs a variant adds a PROP rather than a second class family — these
 * pin that the props actually land as the classes the stylesheet paints, which
 * is the only half a page can no longer restate for itself.
 */
describe('FigureStrip · the three-figure variant', () => {
  it('takes the narrower grid only when asked', () => {
    const { container, rerender } = render(
      <FigureStrip>
        <Figure label="a" value="1" />
      </FigureStrip>
    );
    expect(container.firstChild).toHaveClass('ui-figure-strip');
    expect(container.firstChild).not.toHaveClass('ui-figure-strip-3');

    rerender(
      <FigureStrip cols={3}>
        <Figure label="a" value="1" />
      </FigureStrip>
    );
    expect(container.firstChild).toHaveClass('ui-figure-strip-3');
  });
});

describe('Figure · the cell whose subject is not a number', () => {
  /*
    History's sixth cell draws a chart rather than a figure (§8.4.1 — "at full
    width the bar is now the cell's subject rather than a sparkline beside a
    number"), so `value` is optional and the value span must not be drawn at
    all rather than drawn empty: an empty 30/700 span reserves a line of
    headline height above a chart that does not want one.
  */
  it('draws no value span at all when it has no value', () => {
    const { container } = render(
      <Figure wide label="machine time by stage" line="all runs">
        <div data-testid="chart" />
      </Figure>
    );
    expect(container.querySelector('.ui-figure-value')).toBeNull();
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('ui-figure-wide');
  });

  it('carries the long-form reading as a native title', () => {
    const { container } = render(<Figure label="rework / completed" value="1.2" line="fix loops per completed item" title="the long sentence" />);
    expect(container.firstChild).toHaveAttribute('title', 'the long sentence');
  });
});
