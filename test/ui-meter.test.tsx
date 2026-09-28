/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Meter } from '../client/src/components/ui/Meter';

/**
 * The strip chip's line meter (the tracker strip spec, §3): label over value, a 3.5 px track under both. The text is the reading; the bar is decoration,
 * which is why it is hidden from the accessibility tree and why these cases find the reading by its text.
 */

function fill(container: HTMLElement): HTMLElement {
  return container.querySelector('.ui-meter-fill') as HTMLElement;
}

describe('Meter', () => {
  it('draws the label over the value as text', () => {
    render(<Meter label="POLL" value="12s" fraction={0.3} />);
    expect(screen.getByText('POLL')).toBeInTheDocument();
    expect(screen.getByText('12s')).toBeInTheDocument();
  });

  it('fills the track to the fraction, clamped at both ends', () => {
    const { container, rerender } = render(<Meter label="L" value="v" fraction={0.25} />);
    expect(fill(container).style.width).toBe('25%');
    rerender(<Meter label="L" value="v" fraction={1.7} />);
    expect(fill(container).style.width).toBe('100%');
    rerender(<Meter label="L" value="v" fraction={-0.2} />);
    expect(fill(container).style.width).toBe('0%');
  });

  it('draws an empty track for null', () => {
    const { container } = render(<Meter label="POLL" value="…" fraction={null} />);
    expect(fill(container).style.width).toBe('0%');
    expect(screen.getByText('POLL')).toBeInTheDocument();
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('defaults to the green tone and 56 px, and takes both from props', () => {
    const { container, rerender } = render(<Meter label="L" value="v" fraction={0.5} />);
    const root = container.querySelector('.ui-meter') as HTMLElement;
    expect(root).toHaveAttribute('data-tone', 'green');
    expect(root.style.width).toBe('56px');
    rerender(<Meter label="L" value="v" fraction={0.5} tone="red" width={120} />);
    const again = container.querySelector('.ui-meter') as HTMLElement;
    expect(again).toHaveAttribute('data-tone', 'red');
    expect(again.style.width).toBe('120px');
  });

  it("spans its container under width='fill'", () => {
    const { container } = render(<Meter label="L" value="v" fraction={0.5} width="fill" />);
    expect((container.querySelector('.ui-meter') as HTMLElement).style.width).toBe('100%');
  });

  it('hides the bar from the accessibility tree and exposes only the text', () => {
    const { container } = render(<Meter label="API" value="1.4%" fraction={0.014} />);
    expect(container.querySelector('.ui-meter-track')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('API')).toBeInTheDocument();
    expect(screen.getByText('1.4%')).toBeInTheDocument();
  });
});
