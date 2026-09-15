/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { Chip } from '../client/src/components/ui/Chip';

describe('Chip', () => {
  it('is a button at 32 px with the outline variant by default', () => {
    render(<Chip>All</Chip>);

    const chip = screen.getByRole('button', { name: 'All' });
    expect(chip).toHaveClass('ui-chip', 'ui-chip-outline', 'ui-chip-32');
    expect(chip).toHaveAttribute('type', 'button');
  });

  it('lands each variant as its own class', () => {
    for (const variant of ['outline', 'ink', 'flat', 'danger'] as const) {
      const { unmount } = render(<Chip variant={variant}>x</Chip>);
      expect(screen.getByRole('button', { name: 'x' })).toHaveClass(`ui-chip-${variant}`);
      unmount();
    }
  });

  it('lands the 28 px size as its own class', () => {
    render(<Chip size={28}>x</Chip>);

    expect(screen.getByRole('button', { name: 'x' })).toHaveClass('ui-chip-28');
  });

  /*
    `pressed` is a STATE, so it is announced as one and marked by the fill —
    §8's standing rule that a raised control marks a state, never a button.
    The absence of `aria-pressed` on an unpressed-by-omission chip matters as
    much as its presence: a plain action chip must not announce itself as a
    toggle that happens to be off.
  */
  it('announces pressed as a toggle state and marks it with the on class', () => {
    const { rerender } = render(<Chip>Live</Chip>);
    expect(screen.getByRole('button', { name: 'Live' })).not.toHaveAttribute('aria-pressed');

    rerender(<Chip pressed>Live</Chip>);
    const chip = screen.getByRole('button', { name: 'Live' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveClass('on');
  });

  it('calls onClick, and does not while disabled', async () => {
    const onClick = jest.fn();
    const { rerender } = render(<Chip onClick={onClick}>Go</Chip>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Chip onClick={onClick} disabled>
        Go
      </Chip>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders a label element under as="label", with no toggle state on it', () => {
    render(
      <Chip as="label" pressed>
        Only mine
      </Chip>
    );

    const chip = screen.getByText('Only mine');
    expect(chip.tagName).toBe('LABEL');
    expect(chip).not.toHaveAttribute('aria-pressed');
  });

  it('hides the icon from the accessible name', () => {
    render(<Chip icon={<span>●</span>}>Runs</Chip>);

    expect(screen.getByRole('button', { name: 'Runs' })).toBeInTheDocument();
    expect(document.querySelector('.ui-chip-icon')).toHaveAttribute('aria-hidden', 'true');
  });
});
