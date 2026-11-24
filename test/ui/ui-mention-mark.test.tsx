/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { MentionMark } from '../../client/src/components/ui/MentionMark';

/** The mark sits inside cards and headers that open Detail on a press, so the parent spies are what prove it stays contained. */
function setup(count: number) {
  const onOpen = jest.fn();
  const onClick = jest.fn();
  const onAuxClick = jest.fn();
  const onKeyDown = jest.fn();
  const view = render(
    <div onClick={onClick} onAuxClick={onAuxClick} onKeyDown={onKeyDown}>
      <MentionMark count={count} onOpen={onOpen} />
    </div>
  );
  return { onOpen, onClick, onAuxClick, onKeyDown, view };
}

describe('MentionMark', () => {
  it('renders nothing for a count of zero', () => {
    const { view } = setup(0);

    expect(view.container.querySelector('button')).toBeNull();
    expect(view.container.querySelector('.ui-chip')).toBeNull();
  });

  it('is a button named by the count, labelled @ N', () => {
    setup(2);

    const mark = screen.getByRole('button', { name: '2 mentions wait for your answer' });
    expect(mark).toHaveTextContent('@ 2');
    expect(mark).toHaveClass('ui-chip-warn');
  });

  it('calls onOpen once and does not reach the parent click', async () => {
    const { onOpen, onClick } = setup(2);

    await userEvent.click(screen.getByRole('button', { name: /mentions wait/ }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not let a middle click reach the parent', () => {
    const { onAuxClick } = setup(2);

    fireEvent(screen.getByRole('button', { name: /mentions wait/ }), new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    expect(onAuxClick).not.toHaveBeenCalled();
  });

  it('does not let Enter or Space reach the parent', () => {
    const { onKeyDown } = setup(2);
    const mark = screen.getByRole('button', { name: /mentions wait/ });

    fireEvent.keyDown(mark, { key: 'Enter' });
    fireEvent.keyDown(mark, { key: ' ' });

    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
