/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { NumberField } from '../client/src/components/ui/NumberField';

describe('NumberField', () => {
  it('is a spinbutton carrying its bounds and its label', () => {
    render(<NumberField value={30} min={1} max={365} onCommit={jest.fn()} label="Stale after" />);

    const field = screen.getByRole('spinbutton', { name: 'Stale after' });
    expect(field).toHaveClass('ui-number');
    expect(field).toHaveValue(30);
    expect(field).toHaveAttribute('min', '1');
    expect(field).toHaveAttribute('max', '365');
  });

  /*
    Commits on blur, not on keystroke — moved here from `settings/` unchanged
    (the design spec's §12.1). Committing per keystroke would clamp a
    half-typed `4` on the way to `45` and leave the field holding the clamp.
  */
  it('commits on blur, and not before', async () => {
    const onCommit = jest.fn();
    render(<NumberField value={30} min={1} max={365} onCommit={onCommit} label="Stale after" />);

    const field = screen.getByRole('spinbutton', { name: 'Stale after' });
    await userEvent.clear(field);
    await userEvent.type(field, '45');
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith(45);
  });

  it('commits on Enter, by blurring', async () => {
    const onCommit = jest.fn();
    render(<NumberField value={30} min={1} max={365} onCommit={onCommit} label="Stale after" />);

    const field = screen.getByRole('spinbutton', { name: 'Stale after' });
    await userEvent.clear(field);
    await userEvent.type(field, '7{Enter}');

    expect(onCommit).toHaveBeenCalledWith(7);
  });

  it('re-seeds when the value changes from somewhere else', () => {
    const { rerender } = render(<NumberField value={30} min={1} max={365} onCommit={jest.fn()} label="Stale after" />);
    rerender(<NumberField value={90} min={1} max={365} onCommit={jest.fn()} label="Stale after" />);

    expect(screen.getByRole('spinbutton', { name: 'Stale after' })).toHaveValue(90);
  });

  /* #350 — the input re-seeded on `key={value}` alone, so a commit the parent clamped back to the value it already held kept the key, React kept the
     node, and the box went on showing the out-of-range number that was typed. */
  it('re-seeds after a commit the parent clamps back to the value it already holds', async () => {
    function Clamped() {
      const [v, setV] = useState(365);
      return <NumberField value={v} min={1} max={365} onCommit={(n) => setV(Math.min(365, n))} label="Stale after" />;
    }
    render(<Clamped />);

    const field = screen.getByRole('spinbutton', { name: 'Stale after' });
    await userEvent.clear(field);
    await userEvent.type(field, '999');
    await userEvent.tab();

    expect(screen.getByRole('spinbutton', { name: 'Stale after' })).toHaveValue(365);
  });

  it('draws the unit only when given', () => {
    const { rerender } = render(<NumberField value={30} min={1} max={365} onCommit={jest.fn()} label="Stale after" />);
    expect(document.querySelector('.ui-number-unit')).toBeNull();

    rerender(<NumberField value={30} min={1} max={365} onCommit={jest.fn()} label="Stale after" unit="days" />);
    expect(screen.getByText('days')).toHaveClass('ui-number-unit');
  });
});
