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
    render(<Ledger columns="1fr auto auto" label="History">rows</Ledger>);

    const box = screen.getByRole('group', { name: 'History' });
    expect(box).toHaveClass('ui-ledger');
    expect(box.querySelector('.ui-ledger-grid'))
      .toHaveStyle({ gridTemplateColumns: '1fr auto auto' });
  });
});

describe('DayKicker', () => {
  it('is a rule about the list rather than a card inside it', () => {
    render(<DayKicker>15 September</DayKicker>);

    expect(screen.getByText('15 September')).toHaveClass('ui-ledger-day');
  });
});
