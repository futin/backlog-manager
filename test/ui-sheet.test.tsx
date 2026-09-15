/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Sheet, SheetHead } from '../client/src/components/ui/Sheet';

describe('Sheet', () => {
  it('is a div by default and carries the family class', () => {
    render(<Sheet>body</Sheet>);

    const el = screen.getByText('body');
    expect(el.tagName).toBe('DIV');
    expect(el).toHaveClass('ui-sheet');
  });

  it('takes the element the composer names, keeping the class', () => {
    render(<Sheet as="section">body</Sheet>);

    const el = screen.getByText('body');
    expect(el.tagName).toBe('SECTION');
    expect(el).toHaveClass('ui-sheet');
  });

  it('appends a layout class rather than replacing its own', () => {
    render(<Sheet className="runs-detail-box">body</Sheet>);

    expect(screen.getByText('body')).toHaveClass('ui-sheet', 'runs-detail-box');
  });
});

describe('SheetHead', () => {
  it('lands its title as a heading', () => {
    render(<SheetHead title="Watching" />);

    expect(screen.getByRole('heading', { name: 'Watching' })).toBeInTheDocument();
  });

  it('draws the subtitle and the right slot only when given', () => {
    const { rerender } = render(<SheetHead title="Watching" />);
    expect(document.querySelector('.ui-sheet-sub')).toBeNull();
    expect(document.querySelector('.ui-sheet-head-right')).toBeNull();

    rerender(<SheetHead title="Watching" sub="three runs" right={<button>Pause</button>} />);
    expect(screen.getByText('three runs')).toHaveClass('ui-sheet-sub');
    expect(document.querySelector('.ui-sheet-head-right'))
      .toContainElement(screen.getByRole('button', { name: 'Pause' }));
  });
});
