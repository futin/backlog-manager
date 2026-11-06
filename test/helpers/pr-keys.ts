import { act, fireEvent, within } from '@testing-library/react';

/*
  Where the PR key strip's controls are (the split Merge, spec §4.8). The strip is the main half (`Merge #n` / `Auto-merge #n` / `Auto-merge on #n`), the
  chevron (`Merge options for #n`), the `Open #n on GitHub` link, and the `Merge menu` the chevron opens, whose rows hold Merge, Enable/Disable auto-merge
  and Update branch. Every PR suite reaches a control through these four, so a rename of one is a one-file change.

  `menuRow` opens the menu itself (synchronously, with a bare click, no pointer events) when it is not already open, so a suite can read a row the way it used
  to read a key. A row click closes the menu, so a row looked up after one reopens it.
*/

export const mainOf = (strip: HTMLElement): HTMLElement => within(strip).getByRole('button', { name: /^(Merge|Auto-merge|Auto-merge on) #\d+$/ });
export const moreOf = (strip: HTMLElement): HTMLElement => within(strip).getByRole('button', { name: /^Merge options for #\d+$/ });
export const openOf = (strip: HTMLElement): HTMLElement => within(strip).getByRole('link', { name: /^Open #\d+ on GitHub$/ });

export type MenuRowName = 'Merge' | 'Enable auto-merge' | 'Disable auto-merge' | 'Update branch';

export function menuRow(strip: HTMLElement, name: MenuRowName): HTMLElement {
  if (within(strip).queryByRole('dialog', { name: 'Merge menu' }) === null) {
    act(() => {
      fireEvent.click(moreOf(strip));
    });
  }
  return within(within(strip).getByRole('dialog', { name: 'Merge menu' })).getByRole('button', { name });
}
