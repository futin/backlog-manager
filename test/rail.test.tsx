/**
 * @jest-environment jsdom
 */
import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SideRail } from '../client/src/components/SideRail';
import { type Section } from '../client/src/lib/sections';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { ProjectsContext } from '../client/src/hooks/ProjectsContext';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { JiraSessionsContext, JiraSessionsProvider } from '../client/src/hooks/JiraSessionsContext';
import { resetJiraListFilters, useJiraListFilters } from '../client/src/hooks/useJiraListFilters';
import { useJiraPage } from '../client/src/hooks/useJiraPage';
import { setJiraView, useJiraView } from '../client/src/hooks/useJiraView';
import type { JiraStatusPayload, JiraSessionsPayload } from '../shared/types';
import type { DrawnSources } from '../client/src/lib/sources';
import { FILES_PAGE_KEY, GITHUB_PAGE_KEY } from '../client/src/lib/source-page';
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
/**
 * The shell's projects answer, supplied straight through `ProjectsContext` rather than through `ProjectsProvider` and a mocked `fetch`: every case here
 * is about what the rail draws for a GIVEN answer, and the provider's own fetching is test/projects-context.test.tsx's. `drawn` defaults to both sources
 * present, the shape most cases want; `null` is the unknown state.
 */
const BOTH: DrawnSources = { files: true, github: true };

function railTree(section: Section, onChange: (s: Section) => void, drawn: DrawnSources | null, provisional: boolean) {
  return (
    <SettingsProvider>
      <ProjectsContext.Provider value={{ data: null, drawn, reload: () => {} }}>
        <SideRail section={section} onChange={onChange} provisional={provisional} />
      </ProjectsContext.Provider>
    </SettingsProvider>
  );
}

function renderRail(section: Section = 'runs', { drawn = BOTH, provisional = false }: { drawn?: DrawnSources | null; provisional?: boolean } = {}) {
  const onChange = jest.fn();
  const result = render(railTree(section, onChange, drawn, provisional));
  const rerenderRail = (next: Section, handler: () => void = jest.fn()): void => result.rerender(railTree(next, handler, drawn, provisional));
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
    const { rerenderRail } = renderRail('files');
    expect(tree()).toBeNull();

    rerenderRail('runs');
    expect(tree()).not.toBeNull();

    rerenderRail('github');
    expect(tree()).toBeNull();
  });

  /*
    History and Watchdog, not "Runs" and Watchdog: the row directly above
    already says Runs, so a child repeating it would name its parent. These are
    the only labels these two views have — task-38 deleted `runs-mode.ts`'s
    `MODE_BUTTON` pair with the in-page control it named, so there is no second
    wording to keep this one in agreement with.
  */
  it('names the three views History, Watchdog and Ticks', () => {
    renderRail('runs');

    expect(
      within(tree() as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['History', 'Watchdog', 'Ticks']);
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

  it('sets the mode to ticks when the Ticks row is clicked', async () => {
    renderRail('runs');

    await userEvent.click(screen.getByRole('button', { name: 'Ticks' }));

    expect(JSON.parse(localStorage.getItem(RUNS_MODE_KEY) as string)).toBe('ticks');
  });

  it('marks the open view, and only while Runs is the open section', () => {
    localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('watchdog'));
    const { rerenderRail } = renderRail('runs');

    expect(screen.getByRole('button', { name: 'Watchdog' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'History' })).not.toHaveAttribute('aria-current');

    rerenderRail('files');
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
    renderRail('github');

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
    const { rerenderRail } = renderRail('github');
    expect(settingsTree()).toBeNull();

    rerenderRail('settings');
    expect(settingsTree()).not.toBeNull();

    rerenderRail('runs');
    expect(settingsTree()).toBeNull();
  });

  /*
    Local, Shared and Dashboards, and these are the ONLY labels these three pages have —
    Settings draws no in-page switch at any width (§8.6), the same rule Runs'
    pages follow since task-38. A second control would be a second wording
    free to disagree with this one.
  */
  it('names the three pages Local, Shared and Dashboards, in that order', () => {
    renderRail('settings');

    expect(
      within(settingsTree() as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Local', 'Shared', 'Dashboards']);
  });

  it('marks Local by default and moves the mark on a pick', async () => {
    renderRail('settings');

    expect(screen.getByRole('button', { name: 'Local' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Shared' })).not.toHaveAttribute('aria-current');

    await userEvent.click(screen.getByRole('button', { name: 'Shared' }));

    expect(screen.getByRole('button', { name: 'Shared' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Local' })).not.toHaveAttribute('aria-current');
  });

  it('persists Dashboards as the third page and marks it', async () => {
    renderRail('settings');

    await userEvent.click(screen.getByRole('button', { name: 'Dashboards' }));

    expect(storedScope()).toBe('dashboards');
    expect(screen.getByRole('button', { name: 'Dashboards' })).toHaveAttribute('aria-current', 'true');
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
      renderRail('github');

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
      renderRail('github');
      await userEvent.click(screen.getByRole('button', { name: 'Menu' }));

      for (const b of within(settingsTree() as HTMLElement).getAllByRole('button')) expect(b).not.toHaveAttribute('aria-current');
      for (const b of within(tree() as HTMLElement).getAllByRole('button')) expect(b).not.toHaveAttribute('aria-current');
    });
  });
});

/*
  The source rows (source-sections spec, "The rail after the change"): Files and GitHub replace the root Board and Archive, each drawn from the shell's
  projects answer by the Jira row's three states — unknown draws a source row only while it is the section on screen (and never while that section is a
  provisional guess), answered-present draws it, answered-absent hides it. Each carries its own tree, switched by the tree alone.
*/
describe('SideRail · the source rows', () => {
  beforeEach(() => localStorage.clear());

  const rows = (): string[] =>
    within(screen.getByRole('navigation', { name: 'Sections' }))
      .getAllByRole('button')
      .filter((b) => b.classList.contains('rail-link'))
      .map((b) => b.textContent ?? '');
  const filesTree = (): HTMLElement | null => screen.queryByRole('group', { name: 'Files pages' });
  const githubTree = (): HTMLElement | null => screen.queryByRole('group', { name: 'GitHub pages' });
  const labels = (el: HTMLElement | null): string[] =>
    within(el as HTMLElement)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');

  it('reads Files, GitHub, Runs, Settings with both sources answered', () => {
    renderRail('runs');
    expect(rows()).toEqual(['Files', 'GitHub', 'Runs', 'Settings']);
  });

  it("names Files' tree Board, Archive and GitHub's Board, PRs, Archive, Settings", () => {
    const { rerenderRail } = renderRail('files');
    expect(labels(filesTree())).toEqual(['Board', 'Archive']);
    expect(githubTree()).toBeNull();

    rerenderRail('github');
    expect(labels(githubTree())).toEqual(['Board', 'PRs', 'Archive', 'Settings']);
    expect(filesTree()).toBeNull();
  });

  it('draws no Files row when no files project is registered', () => {
    renderRail('github', { drawn: { files: false, github: true } });
    expect(rows()).toEqual(['GitHub', 'Runs', 'Settings']);
  });

  it('draws the current source row, and only it, while the answer is unknown and the section is a stored one', () => {
    renderRail('github', { drawn: null, provisional: false });
    expect(rows()).toEqual(['GitHub', 'Runs', 'Settings']);
  });

  it('draws neither source row while the answer is unknown and the section is a provisional guess', () => {
    renderRail('github', { drawn: null, provisional: true });
    expect(rows()).toEqual(['Runs', 'Settings']);
  });

  it("switches section and page in one click from another section, marking only the current section's tree", async () => {
    await withNarrow(async () => {
      // Below 700 px every tree stands open, so GitHub's is reachable while Files is current.
      const { onChange } = renderRail('files');
      await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
      await userEvent.click(within(githubTree() as HTMLElement).getByRole('button', { name: 'Settings' }));
      expect(onChange).toHaveBeenLastCalledWith('github');
      expect(JSON.parse(localStorage.getItem(GITHUB_PAGE_KEY) as string)).toBe('settings');

      // Still on Files (the handler is a spy): GitHub's tree marks nothing, and Files' marks its own page — Board, the store's default.
      await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
      const marked = (el: HTMLElement | null): string[] =>
        labels(el).filter(
          (_, i) =>
            within(el as HTMLElement)
              .getAllByRole('button')
              [i].getAttribute('aria-current') === 'true'
        );
      expect(marked(githubTree())).toEqual([]);
      expect(marked(filesTree())).toEqual(['Board']);
      expect(localStorage.getItem(FILES_PAGE_KEY)).toBeNull();
    });
  });
});

/*
  The wordmark (dashboard-redesign-ports task 4; .claude/DESIGN.md §8.0): a `BACKLOG` kicker over `› manager▌`, whose cursor blinks while a run on this
  machine is working. `working` is the rail's whole input for it, so these cases drive the prop directly; what decides the prop — `runsWorking` and the
  three views reporting it — is test/run-pulse.test.ts and nav.test.tsx's.
*/
describe('SideRail · the prompt-cursor wordmark', () => {
  const cursor = (): Element | null => document.querySelector('.rail-cursor');

  function renderWithWorking(working: boolean | undefined) {
    return render(
      <SettingsProvider>
        <SideRail section="github" onChange={jest.fn()} working={working} provisional={false} />
      </SettingsProvider>
    );
  }

  it('blinks the cursor while a run is working', () => {
    renderWithWorking(true);
    expect(cursor()).toHaveClass('rail-cursor', 'blink');
  });

  /* `undefined` is Settings, which reports nothing, and every view before its first poll lands: neither knows of a run, so neither may claim one. */
  it.each([
    ['false', false],
    ['omitted', undefined]
  ])('stands the cursor solid when working is %s', (_label, working) => {
    renderWithWorking(working);
    expect(cursor()).not.toBeNull();
    expect(cursor()).not.toHaveClass('blink');
  });

  /* One <h1>, named for the app rather than for what it draws: read verbatim its parts would be "BACKLOG › manager", a caret glyph and an empty box. */
  it('is the one h1, named Backlog Manager, with its drawn parts hidden from the accessibility tree', () => {
    renderWithWorking(true);
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveAccessibleName('Backlog Manager');
    for (const part of Array.from(headings[0].children)) expect(part).toHaveAttribute('aria-hidden', 'true');
  });

  it('is still the one h1 in the phone bar', async () => {
    await withNarrow(async () => {
      renderWithWorking(false);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Backlog Manager');
    });
  });
});

/*
  The version chip (DESIGN.md §8.10): the rail's last element, drawn only when the shell hands it a `releases` reading. What the reading is — the label,
  the dot, the seed — is the shell's (`test/releases-app.test.tsx`); what is here is where the rail puts it and what a click does. The chip itself is
  ui-kit's `VersionChip`, so its name is `What's new — <label>` and its dot `.uk-chip-dot`.
*/
describe('SideRail · the version chip', () => {
  const chip = (): HTMLElement | null => screen.queryByRole('button', { name: /v0\.2\.0\+3/ });

  function renderWithReleases(releases?: { label: string; dot: boolean; onOpen: () => void }) {
    return render(
      <SettingsProvider>
        <SideRail section="github" onChange={jest.fn()} releases={releases} provisional={false} />
      </SettingsProvider>
    );
  }

  it('draws no chip without a releases reading', () => {
    renderWithReleases();
    expect(screen.queryByRole('button', { name: /What's new/ })).toBeNull();
  });

  it("is the rail's last element at desktop width, with no dot unless asked", () => {
    renderWithReleases({ label: 'v0.2.0+3', dot: false, onOpen: jest.fn() });
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(chip()).toBeInTheDocument();
    // The chip draws itself (ui-kit takes no className), so the nav's last child is the `.rail-foot` card that places it.
    expect(nav.lastElementChild).toHaveClass('rail-foot');
    expect(nav.lastElementChild).toContainElement(chip());
    expect(nav.querySelector('.uk-chip-dot')).toBeNull();
  });

  it('draws the dot when a release has not been opened yet', () => {
    renderWithReleases({ label: 'v0.2.0+3', dot: true, onOpen: jest.fn() });
    expect(chip()?.querySelector('.uk-chip-dot')).not.toBeNull();
  });

  it('calls onOpen on a click', async () => {
    const onOpen = jest.fn();
    renderWithReleases({ label: 'v0.2.0+3', dot: false, onOpen });
    await userEvent.click(chip() as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is the phone menu's last row, only while the menu is open, and a click closes the menu", async () => {
    await withNarrow(async () => {
      const onOpen = jest.fn();
      renderWithReleases({ label: 'v0.2.0+3', dot: false, onOpen });
      expect(chip()).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
      const nav = screen.getByRole('navigation', { name: 'Sections' });
      expect(nav.lastElementChild).toHaveClass('rail-foot');
      expect(nav.lastElementChild).toContainElement(chip());
      // The phone shape is ui-kit's: `narrow` is what gives the pill its 44 px hit area.
      expect(chip()).toHaveClass('uk-chip--narrow');
      await userEvent.click(chip() as HTMLElement);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
      expect(chip()).toBeNull();
    });
  });
});

/*
  The Jira row's Needs-you badge (Jira sessions spec §7.4, C4; DESIGN.md §8.0). The rail reads the shell's one sessions answer through
  `JiraSessionsContext`, so the count cases hand the answer in directly and the wiring case below mounts the real provider over a stubbed `fetch`. Which
  states count is `needsYou`'s (`test/jira-sessions-shared.test.ts`); what is here is the number the rail draws from a payload, where it draws it, and what a
  click does.
*/
describe('the Jira row’s Needs-you badge', () => {
  const configured = { data: { configured: true } as unknown as JiraStatusPayload, loading: false, error: false, reload: () => {} };
  const badge = (): HTMLElement | null => document.querySelector('.rail-count');

  type Over = { key: string; id: string | null; state: string; endedAt?: string | null };
  const link = (o: Over) => ({
    key: o.key,
    sessionId: o.id,
    how: 'run',
    action: 'context',
    name: `session ${o.id}`,
    repo: '/home/ada/pay',
    branch: null,
    surface: 'dashboard',
    model: 'opus',
    effort: null,
    snapshot: { summary: `Snapshot of ${o.key}`, type: 'Task', parentKey: null },
    startedAt: '2026-11-01T10:00:00.000Z',
    endedAt: o.endedAt ?? null,
    endReason: null,
    quietSince: null,
    reattachedAt: null,
    state: o.state,
    row: null,
    stateSince: '2026-11-01T10:00:00.000Z'
  });
  const payload = (links: Over[], reachable = true): JiraSessionsPayload =>
    ({ links: links.map(link), reachable, rowsAt: '2026-11-01T10:00:00.000Z' }) as unknown as JiraSessionsPayload;

  const tree = (data: JiraSessionsPayload | null, onChange: (s: Section) => void = jest.fn(), section: Section = 'runs') => (
    <SettingsProvider>
      <ProjectsContext.Provider value={{ data: null, drawn: BOTH, reload: () => {} }}>
        <JiraContext.Provider value={configured}>
          <JiraSessionsContext.Provider value={{ data, reload: () => Promise.resolve() }}>
            <SideRail section={section} onChange={onChange} provisional={false} />
          </JiraSessionsContext.Provider>
        </JiraContext.Provider>
      </ProjectsContext.Provider>
    </SettingsProvider>
  );

  beforeEach(() => {
    localStorage.clear();
    resetJiraListFilters();
  });

  it('counts a plan, a permission, a reply and an answer — and not a working session', () => {
    render(
      tree(
        payload([
          { key: 'PAY-1', id: 's1', state: 'plan' },
          { key: 'PAY-2', id: 's2', state: 'permission' },
          { key: 'PAY-3', id: 's3', state: 'reply' },
          { key: 'PAY-4', id: 's4', state: 'answer' },
          { key: 'PAY-5', id: 's5', state: 'working' },
          { key: 'PAY-6', id: 's6', state: 'quiet' }
        ])
      )
    );
    expect(badge()).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: '4 sessions need you' })).toBe(badge());
  });

  it('draws no element at zero, and none before the first answer', () => {
    const { rerender } = render(tree(null));
    expect(badge()).toBeNull();
    rerender(tree(payload([{ key: 'PAY-1', id: 's1', state: 'working' }])));
    expect(badge()).toBeNull();
    rerender(tree(payload([{ key: 'PAY-1', id: 's1', state: 'plan', endedAt: '2026-11-02T10:00:00.000Z' }])));
    expect(badge()).toBeNull();
  });

  it('counts a session on a ticket that is on no picked board — every linked ticket counts, not the board’s', () => {
    render(tree(payload([{ key: 'OFFBOARD-9', id: 's1', state: 'answer' }])));
    expect(badge()).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: '1 session needs you' })).toBe(badge());
  });

  it('counts one session once, however many times the payload lists it and however many tickets it is linked to', () => {
    render(
      tree(
        payload([
          { key: 'PAY-1', id: 's1', state: 'plan' },
          { key: 'PAY-1', id: 's1', state: 'plan' },
          // The same session linked to a second ticket is a second row in the List, but the same person waiting once: the badge counts sessions (spec §5).
          { key: 'PAY-2', id: 's1', state: 'plan' },
          // A Starting reservation has no session id and cannot be waiting on anyone.
          { key: 'PAY-3', id: null, state: 'starting' }
        ])
      )
    );
    expect(badge()).toHaveTextContent('1');
  });

  it('counts two different sessions on two tickets as two', () => {
    render(tree(payload([{ key: 'PAY-1', id: 's1', state: 'plan' }, { key: 'PAY-2', id: 's2', state: 'plan' }])));
    expect(badge()).toHaveTextContent('2');
  });

  it('keeps the last count while the dashboard is unreachable, and a failed read leaves the payload untouched', () => {
    const { rerender } = render(tree(payload([{ key: 'PAY-1', id: 's1', state: 'plan' }, { key: 'PAY-2', id: 's2', state: 'reply' }])));
    expect(badge()).toHaveTextContent('2');
    // Unreachable: every live link reads Lost contact — nobody can say who is waiting, so the number does not drop to nothing.
    rerender(tree(payload([{ key: 'PAY-1', id: 's1', state: 'lost' }, { key: 'PAY-2', id: 's2', state: 'lost' }], false)));
    expect(badge()).toHaveTextContent('2');
    // The next reachable answer is believed again.
    rerender(tree(payload([{ key: 'PAY-1', id: 's1', state: 'working' }])));
    expect(badge()).toBeNull();
  });

  it('is its own button beside the row’s, hung on the Jira row — the row still just opens Jira', async () => {
    const onChange = jest.fn();
    render(tree(payload([{ key: 'PAY-1', id: 's1', state: 'plan' }]), onChange));
    const row = screen.getByRole('button', { name: 'Jira' });
    expect(row).toHaveClass('rail-link');
    expect(row).not.toContainElement(badge());
    expect(badge()?.parentElement).toHaveClass('rail-group');
    expect(badge()?.parentElement).toContainElement(row);
    await userEvent.click(row);
    expect(onChange).toHaveBeenCalledWith('jira');
    expect(JSON.parse(localStorage.getItem('backlog-manager.jira-view') ?? 'null')).not.toBe('list');
  });

  it('lands on the Sessions page with Needs you and All tickets set', async () => {
    const onChange = jest.fn();
    setJiraView('board');
    const filters = renderHook(() => useJiraListFilters());
    const view = renderHook(() => useJiraView());
    const page = renderHook(() => useJiraPage());
    act(() => page.result.current[1]('setup'));
    render(tree(payload([{ key: 'OFFBOARD-9', id: 's1', state: 'answer' }]), onChange));

    await userEvent.click(screen.getByRole('button', { name: '1 session needs you' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('jira');
    expect(page.result.current[0]).toBe('sessions');
    expect(view.result.current[0]).toBe('board');
    expect(filters.result.current[0]).toMatchObject({ chip: 'needs-you', allTickets: true });
  });

  it('no longer writes the Board page’s view: a stored List stays List', async () => {
    setJiraView('list');
    const view = renderHook(() => useJiraView());
    render(tree(payload([{ key: 'OFFBOARD-9', id: 's1', state: 'answer' }])));
    await userEvent.click(screen.getByRole('button', { name: '1 session needs you' }));
    expect(view.result.current[0]).toBe('list');
  });

  it('draws Board, Sessions, Setup in the open Jira tree, carries no count on Sessions, and picking Sessions sets the page', async () => {
    const page = renderHook(() => useJiraPage());
    act(() => page.result.current[1]('board'));
    render(tree(payload([{ key: 'PAY-1', id: 's1', state: 'plan' }]), jest.fn(), 'jira'));
    const group = screen.getByRole('group', { name: 'Jira pages' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Board', 'Sessions', 'Setup']);
    expect(within(buttons[1]).queryByText('1')).toBeNull();
    expect(group.querySelector('.rail-count')).toBeNull();
    await userEvent.click(buttons[1]);
    expect(page.result.current[0]).toBe('sessions');
  });

  it('is fed by the shell’s one poll: a read with no `open=1` while the section is closed, none at all while Jira is unconfigured', async () => {
    const realFetch = global.fetch;
    const fn = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload([{ key: 'PAY-1', id: 's1', state: 'permission' }])) } as Response)
    );
    global.fetch = fn as unknown as typeof fetch;
    try {
      const wired = (enabled: boolean) => (
        <SettingsProvider>
          <ProjectsContext.Provider value={{ data: null, drawn: BOTH, reload: () => {} }}>
            <JiraContext.Provider value={configured}>
              <JiraSessionsProvider open={false} enabled={enabled}>
                <SideRail section="runs" onChange={jest.fn()} provisional={false} />
              </JiraSessionsProvider>
            </JiraContext.Provider>
          </ProjectsContext.Provider>
        </SettingsProvider>
      );
      const { rerender } = render(wired(false));
      await act(async () => {});
      expect(fn).not.toHaveBeenCalled();
      expect(badge()).toBeNull();

      rerender(wired(true));
      await act(async () => {});
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('/api/jira/sessions');
      expect(badge()).toHaveTextContent('1');
    } finally {
      global.fetch = realFetch;
    }
  });
});

/*
  The restyled rail (restyle plan 4, task 6): every row is a glyph tile, a label and — while there is something to say — a count pill. `App` hands GitHub's
  and Runs' counts in; Jira's is the rail's own read. The footer card says whether the client's reads are answering.
*/
describe('the rail rows and footer', () => {
  beforeEach(() => localStorage.clear());

  const withProps = (props: { counts?: { github?: number; runs?: number }; api?: 'ok' | 'down' | null; working?: boolean }, section: Section = 'files') => (
    <SettingsProvider>
      <ProjectsContext.Provider value={{ data: null, drawn: BOTH, reload: () => {} }}>
        <SideRail section={section} onChange={jest.fn()} provisional={false} {...props} />
      </ProjectsContext.Provider>
    </SettingsProvider>
  );
  const rowOf = (name: string): HTMLElement => screen.getByRole('button', { name }).closest('div') as HTMLElement;

  it('draws GitHub’s count as an amber pill and nothing at zero', () => {
    const { rerender } = render(withProps({ counts: { github: 3 } }));
    const pill = rowOf('GitHub').querySelector('.ui-pill');
    expect(pill).toHaveTextContent('3');
    expect(pill).toHaveClass('ui-pill-warn');
    rerender(withProps({ counts: { github: 0 } }));
    expect(rowOf('GitHub').querySelector('.ui-pill')).toBeNull();
  });

  it('draws Runs’ count as a neutral pill', () => {
    render(withProps({ counts: { runs: 2 } }));
    const pill = rowOf('Runs').querySelector('.ui-pill');
    expect(pill).toHaveTextContent('2');
    expect(pill).toHaveClass('ui-pill-neutral');
  });

  it('puts a tile on every row and keeps the page and item marks apart', () => {
    render(withProps({}, 'runs'));
    expect(screen.getByRole('button', { name: 'Runs' }).querySelector('.ui-glyph-tile')).toHaveAttribute('data-tone', 'ink');
    expect(screen.getByRole('button', { name: 'Files' }).querySelector('.ui-glyph-tile')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('aria-current', 'true');
  });

  it('names the API state in the footer, and draws nothing while it is unknown', () => {
    const { rerender } = render(withProps({ api: null }));
    expect(screen.queryByText(/^API /)).toBeNull();
    rerender(withProps({ api: 'ok' }));
    expect(screen.getByText('API connected')).toBeInTheDocument();
    rerender(withProps({ api: 'down' }));
    expect(screen.getByText('API unreachable')).toBeInTheDocument();
  });

  it('blinks the cursor only for working === true', () => {
    const { rerender } = render(withProps({ working: true }));
    expect(document.querySelector('.rail-cursor')).toHaveClass('blink');
    rerender(withProps({ working: false }));
    expect(document.querySelector('.rail-cursor')).not.toHaveClass('blink');
    rerender(withProps({}));
    expect(document.querySelector('.rail-cursor')).not.toHaveClass('blink');
  });
});
