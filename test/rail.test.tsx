/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SideRail } from '../client/src/components/SideRail';
import { type Section } from '../client/src/lib/sections';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { RUNS_MODE_KEY, isRunsMode } from '../client/src/lib/runs-mode';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';

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
const settingsTree = (): HTMLElement | null => screen.queryByRole('group', { name: 'Settings pages' });

/**
 * The provider wrapper, and the reason the rail needs one at all since task-42:
 * the Settings tree reads and writes `settingsScope`, which is a field on the
 * settings object rather than a module-level store like `useRunsMode`. In the
 * app the rail is already inside `SettingsProvider` — `App` wraps `AppShell`,
 * which renders this — but every case here renders the rail directly, so the
 * wrapper has to be supplied. Same pattern as test/settings-view.test.tsx's
 * `renderView`, deliberately rather than a second one: outside a provider
 * `useSettings()` falls back to `DEFAULT_SETTINGS` with a no-op `update` and
 * never touches localStorage, so a bare render could never observe a pick.
 */
function renderRail(section: Section = 'runs') {
  const onChange = jest.fn();
  const result = render(
    <SettingsProvider>
      <SideRail section={section} onChange={onChange} />
    </SettingsProvider>
  );
  const rerenderRail = (next: Section, handler: () => void = jest.fn()): void =>
    result.rerender(
      <SettingsProvider>
        <SideRail section={next} onChange={handler} />
      </SettingsProvider>
    );
  return { ...result, onChange, rerenderRail };
}

/** The stored scope, read the way `usePersistedState` writes it. */
const storedScope = (): unknown => JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').settingsScope;

/**
 * Forces `useNarrow` below its 700 px break for one case. jsdom implements no
 * `matchMedia` at all, so the rail reads wide everywhere else in this file —
 * which is the shape every other case here wants. Same stub as
 * test/ui-form-sheet.test.tsx's, and it has to be deleted again afterwards or
 * every later case in the file inherits the phone.
 */
async function withNarrow(run: () => Promise<void>): Promise<void> {
  Object.defineProperty(window, 'matchMedia', {
    value: jest.fn().mockReturnValue({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() }),
    configurable: true,
    writable: true
  });
  try {
    await run();
  } finally {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  }
}

describe('SideRail · the sub-nav tree', () => {
  beforeEach(() => localStorage.clear());

  it('draws the tree only while Runs is the open section', () => {
    const { rerenderRail } = renderRail('board');
    expect(tree()).toBeNull();

    rerenderRail('runs');
    expect(tree()).not.toBeNull();

    rerenderRail('archive');
    expect(tree()).toBeNull();
  });

  /*
    History and Watchdog, not "Runs" and Watchdog: the row directly above
    already says Runs, so a child repeating it would name its parent. These are
    the only labels these two views have — task-38 deleted `runs-mode.ts`'s
    `MODE_BUTTON` pair with the in-page control it named, so there is no second
    wording to keep this one in agreement with.
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
    The seam: the tree writes the key `RunsView` reads, and it has to write it
    the way that page reads it — same key, same guard — or the two disagree
    about which view is open the moment a reload happens. Since task-38 the
    tree is the only control that switches them; `RunsView` writes the key once
    more, to jump back to History from a Watchdog row.
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
    const { rerenderRail } = renderRail('runs');

    expect(screen.getByRole('button', { name: 'Watchdog' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'History' })).not.toHaveAttribute('aria-current');

    rerenderRail('board');
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

/**
 * task-42: the same tree, under a second section.
 *
 * The cases above are the Runs tree's and stay exactly as they were — they are
 * the regression cover for the generalisation, and a case that had to be
 * rewritten to keep passing would not be cover at all. What is below is the
 * Settings tree asserted against the same three facts: it is drawn only for its
 * own open section, it marks the current entry with `aria-current="true"`, and a
 * click both writes the value and opens the section.
 *
 * Where the two differ is the store, and deliberately so. Runs' mode is a
 * module-level value (`useRunsMode`) because `RunsView` writes it too; the
 * Settings scope is a settings field, because the only two readers — this tree
 * and `SettingsView` — already sit inside `SettingsProvider`, so a second store
 * beside the context would be a second mechanism for no gain.
 */
describe('SideRail · the Settings tree', () => {
  beforeEach(() => localStorage.clear());

  it('draws the tree only while Settings is the open section', () => {
    const { rerenderRail } = renderRail('board');
    expect(settingsTree()).toBeNull();

    rerenderRail('settings');
    expect(settingsTree()).not.toBeNull();

    rerenderRail('runs');
    expect(settingsTree()).toBeNull();
  });

  /*
    Local and Shared, and these are the ONLY labels these two pages have —
    Settings draws no in-page switch at any width (§8.6), the same rule Runs'
    two pages follow since task-38. A second control would be a second wording
    free to disagree with this one.
  */
  it('names the two pages Local and Shared', () => {
    renderRail('settings');

    expect(
      within(settingsTree() as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Local', 'Shared']);
  });

  it('marks Local by default and moves the mark on a pick', async () => {
    renderRail('settings');

    expect(screen.getByRole('button', { name: 'Local' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Shared' })).not.toHaveAttribute('aria-current');

    await userEvent.click(screen.getByRole('button', { name: 'Shared' }));

    expect(screen.getByRole('button', { name: 'Shared' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Local' })).not.toHaveAttribute('aria-current');
  });

  /*
    Both halves of a tree entry's click, in one case because they are one
    action: a tree entry is a destination as well as a choice, so clicking
    Shared from the Board has to switch the section too — otherwise it would
    persist a page nobody can see.
  */
  it('persists the picked page and opens the Settings section', async () => {
    const { onChange } = renderRail('settings');

    await userEvent.click(screen.getByRole('button', { name: 'Shared' }));

    expect(storedScope()).toBe('shared');
    expect(onChange).toHaveBeenCalledWith('settings');
  });

  /*
    The generalisation's own case, and the only one that asserts both trees at
    once: below 700 px every tree stands open regardless of which section is
    current (§8.0), so a reader on the phone reaches any sub-view in one tap.
    Runs got that behaviour from `treeOpen`, and the whole point of one render
    path is that Settings gets it without anybody deciding to give it.
  */
  it('stands both trees open below 700px, whatever the current section is', async () => {
    await withNarrow(async () => {
      renderRail('board');

      // The rows live behind the ☰ below 700 px, so the trees are only on
      // screen once the menu is: `treeOpen` decides whether a tree is drawn
      // WITH its rows, not whether the rows are drawn at all.
      await userEvent.click(screen.getByRole('button', { name: 'Menu' }));

      expect(tree()).not.toBeNull();
      expect(settingsTree()).not.toBeNull();
    });
  });

  /*
    And the mark still belongs to the open section alone. On the phone the
    Settings tree is drawn while the Board is current, and nothing in it may
    claim to be the current item of a page the reader is not on — the same rule
    the Runs tree's own `section === 'runs'` check already enforced.
  */
  it('marks nothing in a tree whose section is not the current one', async () => {
    await withNarrow(async () => {
      renderRail('board');
      await userEvent.click(screen.getByRole('button', { name: 'Menu' }));

      for (const b of within(settingsTree() as HTMLElement).getAllByRole('button')) expect(b).not.toHaveAttribute('aria-current');
      for (const b of within(tree() as HTMLElement).getAllByRole('button')) expect(b).not.toHaveAttribute('aria-current');
    });
  });
});
