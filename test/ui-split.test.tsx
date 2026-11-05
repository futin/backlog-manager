/**
 * @jest-environment jsdom
 */
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SplitChip } from '../client/src/components/ui/SplitChip';
import { Glyph } from '../client/src/components/ui/Glyphs';

const base = { label: 'Open repo', labelMore: 'Choose repo', children: 'repo', onMain: () => {}, onMore: () => {}, open: false };

describe('SplitChip', () => {
  it('renders a group of exactly two buttons named by label and labelMore', () => {
    render(<SplitChip {...base} />);
    const group = screen.getByRole('group');
    expect(group).toHaveClass('ui-split', 'ui-split-28');
    expect(group.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Open repo' })).toHaveClass('ui-split-main');
    expect(screen.getByRole('button', { name: 'Choose repo' })).toHaveClass('ui-split-more');
  });

  it('routes each half to its own handler', async () => {
    const onMain = jest.fn();
    const onMore = jest.fn();
    render(<SplitChip {...base} onMain={onMain} onMore={onMore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open repo' }));
    expect([onMain.mock.calls.length, onMore.mock.calls.length]).toEqual([1, 0]);
    await userEvent.click(screen.getByRole('button', { name: 'Choose repo' }));
    expect([onMain.mock.calls.length, onMore.mock.calls.length]).toEqual([1, 1]);
  });

  it('disables both halves, and takes dashed and size as classes', () => {
    const { rerender } = render(<SplitChip {...base} disabled dashed size={32} />);
    expect(screen.getByRole('button', { name: 'Open repo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose repo' })).toBeDisabled();
    expect(screen.getByRole('group')).toHaveClass('ui-split-dashed');
    expect(screen.getByRole('group')).not.toHaveClass('ui-split-28');
    rerender(<SplitChip {...base} />);
    expect(screen.getByRole('group')).not.toHaveClass('ui-split-dashed');
  });

  it('reports open as aria-expanded on the chevron, which has a dialog popup', () => {
    const { rerender } = render(<SplitChip {...base} />);
    const more = screen.getByRole('button', { name: 'Choose repo' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    expect(more.querySelector('.chev-down')).not.toBeNull();
    rerender(<SplitChip {...base} open />);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(more.querySelector('.chev-up')).not.toBeNull();
  });

  it('puts the title on the group and both halves, and the ref on the chevron', () => {
    const moreRef = createRef<HTMLButtonElement>();
    render(<SplitChip {...base} title="why" moreRef={moreRef} />);
    expect(screen.getByRole('group')).toHaveAttribute('title', 'why');
    expect(screen.getByRole('button', { name: 'Open repo' })).toHaveAttribute('title', 'why');
    expect(screen.getByRole('button', { name: 'Choose repo' })).toHaveAttribute('title', 'why');
    expect(moreRef.current).toBe(screen.getByRole('button', { name: 'Choose repo' }));
  });

  it.each(['Open repo', 'Choose repo'])('keeps a click and Enter on %s from reaching a parent', async (name) => {
    const onClick = jest.fn();
    const onKeyDown = jest.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onClick={onClick} onKeyDown={onKeyDown}>
        <SplitChip {...base} />
      </div>
    );
    const half = screen.getByRole('button', { name });
    await userEvent.click(half);
    half.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

describe('Glyph', () => {
  it('is an aria-hidden currentColor outline at 14 px by default', () => {
    const { container } = render(<Glyph name="branch" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '14');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });

  it('draws every name and takes a size', () => {
    const names = ['play', 'document', 'sparkle', 'robot', 'person', 'flag', 'branch', 'tag', 'calendar', 'ring', 'grid', 'tick', 'up', 'down', 'equals'] as const;
    for (const name of names) {
      const { container, unmount } = render(<Glyph name={name} size={10} />);
      expect(container.querySelector('svg')!.children.length).toBeGreaterThan(0);
      expect(container.querySelector('svg')).toHaveAttribute('width', '10');
      unmount();
    }
  });

  it('with href the main half is a new-tab link named by label, and variant outline puts the class on the group', () => {
    const { rerender } = render(<SplitChip {...base} href="https://x.test/s" variant="outline" />);
    const main = screen.getByRole('link', { name: 'Open repo' });
    expect(main).toHaveAttribute('href', 'https://x.test/s');
    expect(main).toHaveAttribute('target', '_blank');
    expect(main).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByRole('group')).toHaveClass('ui-split-outline');
    // Disabled: an anchor cannot be, so the main half is a disabled button with no href.
    rerender(<SplitChip {...base} href="https://x.test/s" disabled />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open repo' })).toBeDisabled();
    expect(screen.getByRole('group')).not.toHaveClass('ui-split-outline');
  });
});
