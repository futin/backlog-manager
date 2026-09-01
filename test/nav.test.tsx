/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { App, resolveSection } from '../client/src/App';
import { SECTIONS } from '../client/src/components/SideRail';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';

/*
  Board and Settings are stubbed; Archive deliberately is not.

  The subject here is the shell — which section a stored value resolves to,
  which tab is marked, what gets written back. Rendering the real BoardView to
  answer that would drag in `useBoard`, `useAgents` and `useOrchestratorRuns`,
  so every case would need four fetch stubs and a polling clock to assert
  something none of them are about, and board.test.tsx already covers that
  component properly. A stub whose whole content is a findable string keeps
  each assertion pointed at the shell.

  Archive is left real because "the tab renders the section it names" is a
  claim about the actual component, and a stub would assert it against itself.
  It is no longer a placeholder, so it now fetches like the Board does — hence
  the `beforeEach` stub below, which is the whole cost of keeping it real.

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

/**
 * The Archive marker these cases wait on: its Out of scope column heading,
 * which no other surface has — the Board evicted that section entirely. A
 * column only renders when it has something to hold, which is why the stub
 * below carries one rejected item and nothing else.
 */
const ARCHIVE_MARK = 'Out of scope';

/** One rejected item, so Archive renders its columns rather than an empty
 *  state. Deliberately minimal: this suite is about the shell, not about what
 *  Archive puts in its columns (test/archive.test.tsx owns that). */
const ARCHIVE_ITEM = {
  id: 'oos-1', title: 'declined thing', created: '2026-08-20', started: '', updated: '',
  phase: '', groomElapsed: 0, executeElapsed: 0, kind: '', tags: [],
  section: 'out-of-scope', status: 'terminal', project: 'alpha', projectPath: '/abs/alpha',
  groomed: null, path: '/abs/alpha/backlog/out-of-scope/oos-1.md'
};

describe('the section rail', () => {
  beforeEach(() => {
    localStorage.clear();
    /* Archive is the one un-stubbed section here and it now fetches: items,
       projects, agents status and orchestrator runs. Answered rather than
       failed, so a case waiting on a column is not waiting on a retry. */
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status')
        ? {
          enabled: false, reachable: false, remoteAnswer: false,
          spawnAvailable: false, spawnMaxPermission: null, projectPaths: []
        }
        : url.includes('/api/orchestrator/runs') ? { runs: [] }
          : url.includes('/api/projects')
            ? [{ name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
              counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 1 } }]
            : { items: [ARCHIVE_ITEM], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    }) as jest.Mock;
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

    expect(await screen.findByText(ARCHIVE_MARK)).toBeInTheDocument();
    expect(screen.queryByText('board stub')).not.toBeInTheDocument();
  });

  it('keeps recording the last section under a landing pin, and finds it when the pin comes off', async () => {
    storeSection('board');
    storeSettings({ landing: 'archive' });
    const pinned = render(<App />);
    expect(await screen.findByText(ARCHIVE_MARK)).toBeInTheDocument();

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

    expect(railTabs().map((t) => t.textContent)).toEqual(['Board', 'Archive', 'Settings']);
    expect(markedTabs()).toHaveLength(1);
    expect(markedTabs()[0]).toHaveTextContent('Board');

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(markedTabs()).toHaveLength(1);
    expect(markedTabs()[0]).toHaveTextContent('Archive');
    expect(await screen.findByText(ARCHIVE_MARK)).toBeInTheDocument();
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
    expect(SECTIONS).toEqual(['board', 'archive', 'settings']);
    for (const s of SECTIONS) expect(resolveSection(s)).toBe(s);
  });

  it('maps the legacy name, and anything else that is not a section, onto Board', () => {
    // 'Board' is in here for the case: the compare is exact, not case-folded.
    const strays = ['projects', 'guides', 'Board', '', null, undefined, 7, { section: 'archive' }];
    for (const raw of strays) expect(resolveSection(raw)).toBe('board');
  });
});
