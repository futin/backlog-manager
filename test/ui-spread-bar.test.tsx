/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { SpreadBar } from '../client/src/components/ui/SpreadBar';

const segments = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.ui-spread-seg'));

describe('SpreadBar', () => {
  /*
    The card-scale bar (grouped-board spec §4, DESIGN.md §3): three segments in the bar's fixed order, done / in progress / to do, each as wide as its
    count — `flex-grow`, so the bar needs no arithmetic of its own and a count of 0 can simply not be drawn.
  */
  it('draws done, in progress and to do in that order, each growing by its count', () => {
    render(<SpreadBar done={2} doing={4} todo={3} />);

    const segs = segments();
    expect(segs).toHaveLength(3);
    expect(segs[0]).toHaveClass('ui-spread-done');
    expect(segs[1]).toHaveClass('ui-spread-doing');
    expect(segs[2]).toHaveClass('ui-spread-todo');
    expect(segs.map((s) => s.style.flexGrow)).toEqual(['2', '4', '3']);
  });

  /* R5: a zero segment is not drawn at all, so it can never leave a double gap between the two segments beside it. */
  it('draws only the non-zero segments', () => {
    render(<SpreadBar done={0} doing={1} todo={0} />);

    expect(segments()).toHaveLength(1);
    expect(segments()[0]).toHaveClass('ui-spread-doing');
  });

  it('renders nothing when there is nothing to count', () => {
    const { container } = render(<SpreadBar done={0} doing={0} todo={0} caption={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  /* The segments are decoration; the reading lives on the track, so a reader who never sees the bar still hears it. */
  it('draws the caption under the bar, and it is the track’s accessible name', () => {
    render(<SpreadBar done={2} doing={4} todo={3} caption="2 done · 4 in progress · 3 to do" />);

    expect(screen.getByText('2 done · 4 in progress · 3 to do')).toHaveClass('ui-spread-caption');
    expect(screen.getByRole('img', { name: '2 done · 4 in progress · 3 to do' })).toHaveClass('ui-spread-track');
  });

  it('names the track in the caption’s words when no caption is drawn', () => {
    render(<SpreadBar done={1} doing={0} todo={2} />);

    expect(screen.getByRole('img', { name: '1 done · 2 to do' })).toBeInTheDocument();
    expect(document.querySelector('.ui-spread-caption')).toBeNull();
  });
});
