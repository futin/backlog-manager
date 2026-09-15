/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { Segmented } from '../client/src/components/ui/Segmented';

const OPTIONS = [
  { value: 'cosy', label: 'Cosy' },
  { value: 'compact', label: 'Compact' }
];

describe('Segmented', () => {
  /*
    Moved out of `settings/SettingsRow.tsx` by task-36 with its behaviour
    untouched (the design spec's §12.1). These cases are that promise written
    down: the group role, the pressed state on the selected option, the change
    callback, and the disabled path for a setting the server cannot act on.
  */
  it('is a group of toggle buttons, one pressed', () => {
    render(<Segmented value="cosy" options={OPTIONS} onChange={jest.fn()} label="Density" />);

    const group = screen.getByRole('group', { name: 'Density' });
    expect(group).toHaveClass('ui-seg');
    expect(screen.getByRole('button', { name: 'Cosy' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the selected option with the on class and nothing else', () => {
    render(<Segmented value="compact" options={OPTIONS} onChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Compact' })).toHaveClass('on');
    expect(screen.getByRole('button', { name: 'Cosy' })).not.toHaveClass('on');
  });

  it('reports the clicked value', async () => {
    const onChange = jest.fn();
    render(<Segmented value="cosy" options={OPTIONS} onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));

    expect(onChange).toHaveBeenCalledWith('compact');
  });

  it('flips nothing while disabled', async () => {
    const onChange = jest.fn();
    render(<Segmented value="cosy" options={OPTIONS} onChange={onChange} disabled />);

    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Compact' })).toBeDisabled();
  });
});
