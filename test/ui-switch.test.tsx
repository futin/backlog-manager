/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { Switch } from '../client/src/components/ui/Switch';

describe('Switch', () => {
  /*
    `role="switch"` with `aria-checked`, not `aria-pressed`: this is a setting
    with two states that persists, not a button that stays down. §8.6 gives it
    the pill shape — a recessed --steel track under a raised --strip option —
    which is §8's standing rule drawn: a raised control marks a STATE.
  */
  it('is a switch reporting its checked state', () => {
    const { rerender } = render(<Switch checked={false} onChange={jest.fn()} label="Enabled" />);

    const control = screen.getByRole('switch', { name: 'Enabled' });
    expect(control).toHaveClass('ui-switch');
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).not.toHaveClass('on');

    rerender(<Switch checked onChange={jest.fn()} label="Enabled" />);
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveClass('on');
  });

  it('reports the flipped value, in both directions', async () => {
    const onChange = jest.fn();
    const { rerender } = render(<Switch checked={false} onChange={onChange} label="Enabled" />);
    await userEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<Switch checked onChange={onChange} label="Enabled" />);
    await userEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('flips nothing while disabled', async () => {
    const onChange = jest.fn();
    render(<Switch checked={false} onChange={onChange} label="Enabled" disabled />);

    await userEvent.click(screen.getByRole('switch', { name: 'Enabled' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  /*
    Both ends of the track are drawn, and both are hidden from the
    accessibility tree: the switch already announces its own state, and a
    reader hearing "Off On Enabled switch checked" would hear the control
    twice.
  */
  it('draws both ends of the track, hidden from the accessible name', () => {
    render(<Switch checked onChange={jest.fn()} label="Enabled" onLabel="Yes" offLabel="No" />);

    const opts = document.querySelectorAll('.ui-switch-opt');
    expect([...opts].map((o) => o.textContent)).toEqual(['No', 'Yes']);
    for (const o of opts) expect(o).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeInTheDocument();
  });
});
