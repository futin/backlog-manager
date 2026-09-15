/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SideRail, type Section } from '../client/src/components/SideRail';
import { RUNS_MODE_KEY, isRunsMode } from '../client/src/lib/runs-mode';

/*
  The rail's own suite (task-36; .claude/DESIGN.md §8.0). `nav.test.tsx` covers
  what the SHELL does with a section — which one a stored value resolves to,
  what gets written back — and stays the home of that. What is here is what the
  rail itself gained: the sub-nav tree under the open section, and the fact
  that the tree writes the SAME key the segmented control inside `RunsView`
  already owns rather than a second one beside it.

  Rendered directly rather than through `App`, deliberately: every case below
  is about the rail, and going through the shell would drag four lazy sections
  and their fetches into a test that asserts nothing about any of them.
*/

const tree = (): HTMLElement | null => screen.queryByRole('group', { name: 'Runs views' });

function renderRail(section: Section = 'runs') {
  const onChange = jest.fn();
  const result = render(<SideRail section={section} onChange={onChange} />);
  return { ...result, onChange };
}

describe('SideRail · the sub-nav tree', () => {
  beforeEach(() => localStorage.clear());

  it('draws the tree only while Runs is the open section', () => {
    const { rerender } = renderRail('board');
    expect(tree()).toBeNull();

    rerender(<SideRail section="runs" onChange={jest.fn()} />);
    expect(tree()).not.toBeNull();

    rerender(<SideRail section="archive" onChange={jest.fn()} />);
    expect(tree()).toBeNull();
  });

  /*
    History and Watchdog, not "Runs" and Watchdog: `runs-mode.ts`'s
    `MODE_BUTTON` labels a control sitting INSIDE the Runs section, where
    "Runs" is the view you switch back to. In the rail the row directly above
    already says Runs, so a child repeating it would name its parent.
  */
  it('names the two views History and Watchdog', () => {
    renderRail('runs');

    expect(
      within(tree() as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['History', 'Watchdog']);
  });

  /*
    The one seam this task shares with task 3: the tree is a SECOND writer of
    the key the in-page segmented control already writes, and it has to write
    it the way that control does — same key, same guard — or the two disagree
    about which view is open the moment a reload happens.
  */
  it('writes the stored mode through the same key and guard runs-mode.ts owns', async () => {
    renderRail('runs');

    await userEvent.click(screen.getByRole('button', { name: 'Watchdog' }));

    const stored: unknown = JSON.parse(localStorage.getItem(RUNS_MODE_KEY) as string);
    expect(isRunsMode(stored)).toBe(true);
    expect(stored).toBe('watchdog');

    await userEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(JSON.parse(localStorage.getItem(RUNS_MODE_KEY) as string)).toBe('runs');
  });

  it('marks the open view, and only while Runs is the open section', () => {
    localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('watchdog'));
    const { rerender } = renderRail('runs');

    expect(screen.getByRole('button', { name: 'Watchdog' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'History' })).not.toHaveAttribute('aria-current');

    rerender(<SideRail section="board" onChange={jest.fn()} />);
    expect(tree()).toBeNull();
  });

  /*
    A tree entry is a destination, so it takes the reader to Runs as well as
    choosing the view — otherwise clicking Watchdog from the Board would
    persist a mode and leave the Board on screen.
  */
  it('opens the Runs section as well as choosing the view', async () => {
    const { onChange } = renderRail('runs');

    await userEvent.click(screen.getByRole('button', { name: 'Watchdog' }));

    expect(onChange).toHaveBeenCalledWith('runs');
  });

  /*
    The section rows stay plain switches: a button that only navigates must not
    announce a panel it does not hold. The tree is drawn because the section is
    open, not because the row was expanded — which is why the Runs row gains no
    `aria-expanded` from having one.
  */
  it('gives the Runs row no aria-expanded even with a tree under it', () => {
    renderRail('runs');

    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-expanded');
  });

  /*
    Desktop is the shape every existing suite asserts against, and jsdom has no
    `matchMedia`, so `useNarrow` reads wide here: no ☰, and the rows stand
    without one.
  */
  it('draws no phone menu button at desktop width', () => {
    renderRail('board');

    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  });
});
