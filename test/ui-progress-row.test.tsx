/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ProgressRow } from '../client/src/components/ui/ProgressRow';

const bar = (): HTMLElement => screen.getByRole('progressbar');
const fill = (): HTMLElement => document.querySelector('.ui-progress-fill') as HTMLElement;

describe('ProgressRow', () => {
  /*
    The numbers live on the element, not in the caption: the caption is
    optional and the bar is decoration, so a reader with no bar and no caption
    still has to be able to hear the reading.
  */
  it('carries the reading as a progressbar', () => {
    render(<ProgressRow name="Sweep" value={3} max={8} />);

    expect(bar()).toHaveAttribute('aria-valuenow', '3');
    expect(bar()).toHaveAttribute('aria-valuemin', '0');
    expect(bar()).toHaveAttribute('aria-valuemax', '8');
    expect(fill()).toHaveStyle({ width: '37.5%' });
  });

  /*
    Clamped rather than trusted. Every caller computes `value` from live data —
    an elapsed over a budget — and a bar drawn past its own track reads as a
    rendering bug rather than as a number being large.
  */
  it('clamps a value past its own max, and a negative one, rather than overdrawing', () => {
    const { rerender } = render(<ProgressRow value={20} max={8} />);
    expect(fill()).toHaveStyle({ width: '100%' });
    expect(bar()).toHaveAttribute('aria-valuenow', '8');

    rerender(<ProgressRow value={-3} max={8} />);
    expect(fill()).toHaveStyle({ width: '0%' });
    expect(bar()).toHaveAttribute('aria-valuenow', '0');
  });

  it('draws nothing rather than dividing by zero on an empty budget', () => {
    render(<ProgressRow value={5} max={0} />);

    expect(fill()).toHaveStyle({ width: '0%' });
    expect(bar()).toHaveAttribute('aria-valuemax', '0');
  });

  it('defaults to the 10 px progress fill and takes 6 px and ink as classes', () => {
    const { rerender } = render(<ProgressRow value={1} max={2} />);
    expect(bar()).not.toHaveClass('ui-progress-6');
    expect(fill()).toHaveClass('ui-progress-fill-progress');

    rerender(<ProgressRow value={1} max={2} height={6} fill="ink" />);
    expect(bar()).toHaveClass('ui-progress-6');
    expect(fill()).toHaveClass('ui-progress-fill-ink');
  });

  /*
    §2: the design's 45° hatch rides the FILL and never the track, and a
    remainder is flat. `hatch` composes the one `.hatch` utility rather than a
    gradient of this component's own, so every hatched fill on the board is one
    declaration.
  */
  it('hatches the fill only when asked, through the one hatch utility', () => {
    const { rerender } = render(<ProgressRow value={1} max={2} />);
    expect(fill()).not.toHaveClass('hatch');

    rerender(<ProgressRow value={1} max={2} hatch />);
    expect(fill()).toHaveClass('hatch');
  });

  it('draws name, value and caption only when given', () => {
    const { rerender } = render(<ProgressRow value={1} max={2} />);
    expect(document.querySelector('.ui-progress-head')).toBeNull();
    expect(document.querySelector('.ui-progress-caption')).toBeNull();

    rerender(<ProgressRow value={1} max={2} name="Housing" valueText="1 / 2" caption="left to save" />);
    expect(screen.getByText('Housing')).toHaveClass('ui-progress-name');
    expect(screen.getByText('1 / 2')).toHaveClass('ui-progress-value');
    expect(screen.getByText('left to save')).toHaveClass('ui-progress-caption');
  });
});
