/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { Select } from '../../client/src/components/ui/Select';

const OPTIONS = [
  { value: 'all', label: 'All projects' },
  { value: 'backlog-manager', label: 'backlog-manager' }
];

describe('Select', () => {
  /*
    A native `<select>`, not a custom listbox: this board is read on a phone
    over a tailnet as often as on a desktop, and the platform picker already
    has the touch, keyboard and screen-reader behaviour right on every device
    it opens on. What the component owns is the skin and the label.
  */
  it('is a combobox named by its label prop', () => {
    render(<Select value="all" options={OPTIONS} onChange={jest.fn()} label="Project" />);

    const select = screen.getByRole('combobox', { name: 'Project' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveClass('ui-select');
    expect(select).toHaveValue('all');
  });

  it('renders one option per entry, in the order given', () => {
    render(<Select value="all" options={OPTIONS} onChange={jest.fn()} label="Project" />);

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['All projects', 'backlog-manager']);
  });

  it('reports the chosen value', async () => {
    const onChange = jest.fn();
    render(<Select value="all" options={OPTIONS} onChange={onChange} label="Project" />);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'backlog-manager');

    expect(onChange).toHaveBeenCalledWith('backlog-manager');
  });

  it('is disabled when the setting cannot be acted on', () => {
    render(<Select value="all" options={OPTIONS} onChange={jest.fn()} label="Project" disabled />);

    expect(screen.getByRole('combobox', { name: 'Project' })).toBeDisabled();
  });

  /*
    A native `<select>` is as wide as its longest option, and Settings › Local's Jira default action lists every run skill on the machine by name, so one
    long name made it 380 px and pushed the page sideways at 375 px (#616). Under the phone break `.set-control` is a row flex container, and a flex item's
    automatic minimum size is its content width — only a definite max size clamps it. jsdom does no layout, so the rule's source is the only thing a jest
    test can pin: the base `.ui-select` rule must cap the control at its container's width.
  */
  it('never grows past its container, however long an option is', () => {
    const css = readFileSync(join(__dirname, '../../client/src/styles.css'), 'utf8');
    const rule = css.match(/^\.ui-select \{([^}]*)\}/m);

    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(^|[;{\s])max-width: 100%;/);
  });
});
