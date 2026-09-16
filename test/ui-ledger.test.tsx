/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { DayKicker, Ledger } from '../client/src/components/ui/Ledger';

describe('Ledger', () => {
  /*
    The overflow box is this component's whole reason to exist (§8.4): without
    it a wide table scrolls the PAGE sideways and takes the rail and the band
    along. Pinned as the element that owns the class, so a later composer
    cannot move the box onto its own wrapper and leave this one hollow.
  */
  it('owns the scroll box and takes the columns it is handed', () => {
    render(
      <Ledger columns="1fr auto auto" label="History">
        rows
      </Ledger>
    );

    const box = screen.getByRole('group', { name: 'History' });
    expect(box).toHaveClass('ui-ledger');
    expect(box.querySelector('.ui-ledger-grid')).toHaveStyle({ gridTemplateColumns: '1fr auto auto' });
  });
});

describe('DayKicker', () => {
  it('is a rule about the list rather than a card inside it', () => {
    render(<DayKicker>15 September</DayKicker>);

    expect(screen.getByText('15 September')).toHaveClass('ui-ledger-day');
  });
});

/**
 * task-38's own variant: with no `columns`, the primitive holds the overflow
 * box and lays out nothing. Runs › Watchdog's activity feed is a real
 * `<table>` — five columns of the same five fields on every line, with a
 * header row a scrolling reader needs — and a `<table>` laid out by this
 * component's grid would have its columns set by the grid and its semantics by
 * the element, which is two layouts fighting.
 */
describe('Ledger · the box-only variant', () => {
  it('holds the scroll box and no grid when it is handed no columns', () => {
    render(
      <Ledger label="Activity">
        <table>
          <tbody>
            <tr>
              <td>one</td>
            </tr>
          </tbody>
        </table>
      </Ledger>
    );

    const box = screen.getByRole('group', { name: 'Activity' });
    expect(box).toHaveClass('ui-ledger');
    expect(box.querySelector('.ui-ledger-grid')).toBeNull();
    expect(box.querySelector('table')).not.toBeNull();
  });
});
