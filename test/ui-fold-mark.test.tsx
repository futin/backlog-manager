/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { FoldMark } from '../client/src/components/ui/FoldMark';

describe('FoldMark', () => {
  it('draws `↳ <key>` with the whole key as its title, so a narrow cell that cuts it still says which ticket', () => {
    render(<FoldMark issueKey="TIMIFY-26366" />);
    const mark = document.querySelector('.ui-fold') as HTMLElement;
    expect(mark.textContent).toBe('↳ TIMIFY-26366');
    expect(mark).toHaveAttribute('title', 'TIMIFY-26366');
  });

  // It states a fact; the row or card it sits on is what a press opens, so the mark must not be a second stop in the tab order.
  it('is not a control', () => {
    render(<FoldMark issueKey="PAY-2" />);
    const mark = document.querySelector('.ui-fold') as HTMLElement;
    expect(mark.tagName).toBe('SPAN');
    expect(mark).not.toHaveAttribute('role');
    expect(mark).not.toHaveAttribute('tabindex');
  });
});
