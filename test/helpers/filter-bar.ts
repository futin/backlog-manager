import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Driving the band's filter track the way a reader does (the band-filter spec's §3; `client/src/components/FilterBar.tsx`).
 *
 * The suites that used to `selectOptions` a native `<select>` — Board's own, the tracker board's, the live cards', the Orchestrate start UI's, and Archive's —
 * now reach the same state through a popover, and one home for that walk keeps the accessible names it relies on in one place: the
 * dialogs `Filters` and `Sort by`, the buttons `Filters` / `Filters, N set` and `Change sort`, the groups `Project`, `Status` and `Direction`, and each sort
 * row's bare-label name. `test/filter-bar.test.tsx` pins those names on the component; a rename is a change there and here at once.
 *
 * **Each helper opens its popover only if that dialog is not already open, and none closes it.** A pick does not close the panel (the dashboard's
 * behaviour, which `FilterBar` keeps), so two picks in a row are one visit — the second finds the dialog up and clicks inside it, rather than clicking the
 * button again, which would CLOSE it. A suite whose next step asserts on dialogs gets the popover closed by that step's own click outside the panel, whose
 * `pointerdown` is `Popover`'s dismissal; nothing here does it for them, because a helper that closed after every pick could not drive Board's case
 * that the popover stays open, as the same element, across a pick.
 *
 * The default `userEvent` export rather than a `setup()` instance passed in: every caller already uses it that way for its other clicks, and each call
 * here is one self-contained gesture with no keyboard state to carry between them.
 */

type Panel = { dialog: 'Filters' | 'Sort by'; button: RegExp | string };

// `/^Filters/` because the button's name carries the count once anything is set (`Filters, 2 set`); the dialog's name never does.
const FILTERS: Panel = { dialog: 'Filters', button: /^Filters/ };
const SORT: Panel = { dialog: 'Sort by', button: 'Change sort' };

async function openPanel({ dialog, button }: Panel): Promise<HTMLElement> {
  const open = screen.queryByRole('dialog', { name: dialog });
  if (open !== null) return open;
  await userEvent.click(screen.getByRole('button', { name: button }));
  return screen.getByRole('dialog', { name: dialog });
}

/**
 * Picks a project chip by its NAME. `nth` is for two checkouts of one repo, which share a name and never a path (Board's twin-checkout case) — the chips
 * are in registry order, so `nth = 1` is the second-registered one. `All projects` is a chip like any other.
 */
export async function pickProject(name: string, nth = 0): Promise<void> {
  const dialog = await openPanel(FILTERS);
  const chips = within(within(dialog).getByRole('group', { name: 'Project' })).getAllByRole('button', { name });
  if (nth >= chips.length) throw new Error(`pickProject: no chip #${nth} named ${name} (found ${chips.length})`);
  await userEvent.click(chips[nth]);
}

/** Picks one option of the Board's four-way Status switch. */
export async function pickStatus(label: 'Open' | 'In progress' | 'Done' | 'All'): Promise<void> {
  const dialog = await openPanel(FILTERS);
  await userEvent.click(within(within(dialog).getByRole('group', { name: 'Status' })).getByRole('button', { name: label }));
}

/** Picks a sort key's row. Exact names, so `Project` here is the sort row and never the Filters panel's group of the same name. */
export async function pickSort(label: 'Created' | 'Name' | 'Project'): Promise<void> {
  const dialog = await openPanel(SORT);
  await userEvent.click(within(dialog).getByRole('button', { name: label }));
}

/** Flips the sort popover's Direction switch. */
export async function pickDirection(label: 'Ascending' | 'Descending'): Promise<void> {
  const dialog = await openPanel(SORT);
  await userEvent.click(within(within(dialog).getByRole('group', { name: 'Direction' })).getByRole('button', { name: label }));
}

/** Presses the Filters panel's `Clear all`. At count 0 the button is inert (`FilterBar`'s own rule), so this is a no-op click there, not an error. */
export async function clearFilters(): Promise<void> {
  const dialog = await openPanel(FILTERS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Clear all' }));
}
