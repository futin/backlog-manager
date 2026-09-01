/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { App, resolveSection } from '../client/src/App';
import { SECTIONS } from '../client/src/components/SideRail';
import { SETTINGS_STORAGE_KEY, clampSettings } from '../client/src/lib/settings';

/*
  Board and Settings are stubbed; Archive and Runs deliberately are not.

  The subject here is the shell — which section a stored value resolves to,
  which tab is marked, what gets written back. Rendering the real BoardView to
  answer that would drag in `useBoard`, `useAgents` and `useOrchestratorRuns`,
  so every case would need four fetch stubs and a polling clock to assert
  something none of them are about, and board.test.tsx already covers that
  component properly. A stub whose whole content is a findable string keeps
  each assertion pointed at the shell.

  Archive and Runs are left real because their placeholders are part of what
  their changes ship: "the tab renders something that explains itself" is a
  claim about the actual component, and a stub would assert it against
  itself. RunsView (Task 5) has no hook to drag in — it is a heading and a
  fixed empty-state string, nothing that would need a fetch stub of its own.

  `require` inside the factories rather than the imports above, because
  jest.mock is hoisted above them and may not close over module scope.
*/
jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/settings/SettingsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'settings stub')
}));

const SECTION_KEY = 'backlog-manager.section';
/** Written the way `usePersistedState` reads it back: JSON, not a bare string. */
const storeSection = (raw: string): void => localStorage.setItem(SECTION_KEY, JSON.stringify(raw));
const storedSection = (): unknown => JSON.parse(localStorage.getItem(SECTION_KEY) ?? 'null');
const storeSettings = (patch: object): void =>
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(patch));

const railTabs = (): HTMLElement[] =>
  within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('button');
const markedTabs = (): HTMLElement[] =>
  railTabs().filter((t) => t.getAttribute('aria-current') === 'page');

/** A phrase from the Archive placeholder — matched loosely so copy can breathe. */
const ARCHIVE_NOTE = /open items nobody has touched/;
/**
 * RunsView's empty state — final copy, not a placeholder (see the file's own
 * comment), so this is matched exactly rather than loosely like ARCHIVE_NOTE:
 * there is no surrounding prose here for a regex to leave room to breathe in.
 */
const RUNS_EMPTY = 'no runs yet';

describe('the section rail', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('resolves the legacy stored "projects" onto Board, not onto a blank main area', async () => {
    // What every install that predates this change has in localStorage.
    storeSection('projects');
    render(<App />);

    expect(markedTabs()[0]).toHaveTextContent('Board');
    expect(await screen.findByText('board stub')).toBeInTheDocument();
  });

  it('resolves a hand-edited garbage section onto Board', async () => {
    storeSection('not-a-section');
    render(<App />);

    expect(markedTabs()[0]).toHaveTextContent('Board');
    expect(await screen.findByText('board stub')).toBeInTheDocument();
  });

  it('opens on Archive when landing pins it, with no flash of another section', async () => {
    // Stored section is Board on purpose: if `landing` were ignored, or applied
    // a render late, the board is what would paint first and this would catch it.
    storeSection('board');
    storeSettings({ landing: 'archive' });
    render(<App />);

    /*
      Synchronous, before the awaits below let the lazy chunk resolve. The rail
      is not lazy, so what it says here IS the first paint — and it already says
      Archive, which is the whole claim: the landing override is resolved in the
      useState initializer, not in an effect that would repaint a frame later.
    */
    expect(markedTabs()[0]).toHaveTextContent('Archive');
    expect(screen.queryByText('board stub')).not.toBeInTheDocument();

    expect(await screen.findByText(ARCHIVE_NOTE)).toBeInTheDocument();
    expect(screen.queryByText('board stub')).not.toBeInTheDocument();
  });

  it('keeps recording the last section under a landing pin, and finds it when the pin comes off', async () => {
    storeSection('board');
    storeSettings({ landing: 'archive' });
    const pinned = render(<App />);
    expect(await screen.findByText(ARCHIVE_NOTE)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('settings stub')).toBeInTheDocument();
    // The switch wrote through even though `landing` was pinning the section —
    // `stored` records underneath the override rather than being frozen by it.
    expect(storedSection()).toBe('settings');

    // Reload with the pin taken off. 'last' has to find Settings, the section
    // genuinely left last, and not Archive, the one the pin had it sitting on.
    pinned.unmount();
    storeSettings({ landing: 'last' });
    render(<App />);

    expect(markedTabs()[0]).toHaveTextContent('Settings');
    expect(await screen.findByText('settings stub')).toBeInTheDocument();
  });

  it('marks exactly one tab as the current page, and moves the mark on a switch', async () => {
    render(<App />);

    expect(railTabs().map((t) => t.textContent)).toEqual(['Board', 'Runs', 'Archive', 'Settings']);
    expect(markedTabs()).toHaveLength(1);
    expect(markedTabs()[0]).toHaveTextContent('Board');

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(markedTabs()).toHaveLength(1);
    expect(markedTabs()[0]).toHaveTextContent('Archive');
    expect(await screen.findByText(ARCHIVE_NOTE)).toBeInTheDocument();
  });

  /*
    Its own test, separate from the order assertion folded into "marks
    exactly one tab" above, because that one's subject is the *mark* moving
    and this one's subject is the *rail* itself — Board's companions first,
    per the design spec, with Runs seated between Board and Archive rather
    than after Settings where a careless append would have landed it.
  */
  it('shows four tabs in order: Board, Runs, Archive, Settings', () => {
    render(<App />);

    expect(railTabs().map((t) => t.textContent)).toEqual(['Board', 'Runs', 'Archive', 'Settings']);
  });

  it('clicking Runs renders the runs view', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Runs' }));

    expect(markedTabs()[0]).toHaveTextContent('Runs');
    // Exact match, not loose like ARCHIVE_NOTE: this is the shell's whole
    // body, and Task 6 keeps this exact string for the genuinely-empty case
    // rather than treating it as placeholder copy to improve on later.
    expect(await screen.findByText(RUNS_EMPTY)).toBeInTheDocument();
  });

  it('gives no tab aria-expanded — every tab is a plain section switch', async () => {
    render(<App />);

    // A button that only navigates must not announce a panel it does not hold.
    // Narrowing the board to one project is a board control, not a rail one.
    for (const tab of railTabs()) expect(tab).not.toHaveAttribute('aria-expanded');
    // Lets the lazy chunk land inside act() before the test ends.
    expect(await screen.findByText('board stub')).toBeInTheDocument();
  });
});

describe('resolveSection', () => {
  it('passes every section the rail actually has straight through', () => {
    // Runs sits between Board and Archive here too — this list is read
    // straight off SideRail's TABS, so an out-of-order entry here would mean
    // the rail itself drifted, not just this test.
    expect(SECTIONS).toEqual(['board', 'runs', 'archive', 'settings']);
    for (const s of SECTIONS) expect(resolveSection(s)).toBe(s);
  });

  it('maps the legacy name, and anything else that is not a section, onto Board', () => {
    // 'Board' is in here for the case: the compare is exact, not case-folded.
    const strays = ['projects', 'guides', 'Board', '', null, undefined, 7, { section: 'archive' }];
    for (const raw of strays) expect(resolveSection(raw)).toBe('board');
  });

  /*
    Not exercised by the loop above: that one calls `resolveSection`, not
    `clampSettings`, and the two guard different things — a stored *section*
    versus a stored *landing preference*. This is the "settings' LANDINGS
    all derive from it too" half of SideRail's own comment on SECTIONS: the
    only way `clampSettings({ landing: 'runs' })` could keep the value is if
    `lib/settings.ts`'s derived `LANDINGS` (`['last', ...SECTIONS]`) actually
    picked up the new tab, rather than a hand-copied list sitting one entry
    behind SideRail.tsx the way SettingsView's *labeled* LANDINGS would if
    nobody had touched it.
  */
  it('clampSettings accepts the new section as a landing value too', () => {
    expect(clampSettings({ landing: 'runs' }).landing).toBe('runs');
  });
});
