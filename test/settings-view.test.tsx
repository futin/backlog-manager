/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { readStyles, ruleBlock } from './helpers/css-rule';

import SettingsView, { SWATCHES } from '../client/src/components/settings/SettingsView';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { TrackersProvider } from '../client/src/hooks/TrackersContext';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { ProjectsContext } from '../client/src/hooks/ProjectsContext';
import type { DrawnSources } from '../client/src/lib/sources';
import type { JiraState } from '../client/src/hooks/useJira';
import { SETTINGS_STORAGE_KEY, type SettingsScope } from '../client/src/lib/settings';
import type { AgentsStatus, JiraSkill, JiraStatusPayload } from '../shared/types';

// A healthy default: `SettingsView` now renders `AgentsGroup`, which calls
// `useAgents()` on every mount, so every pre-existing test below triggers a
// `/api/agents/status` fetch whether or not it cares about dispatch. Without
// a stub here that fetch rejects (no `global.fetch` at all in jsdom),
// `useAgents`'s own `.catch` would map it onto an all-false status — which
// would still render fine, but would report a fictional "dispatch is off" on
// a suite that has nothing to do with agents. A believable healthy shape
// keeps these four tests looking at a normal board; the three
// `describe('the Claude Agents group', …)` cases below override this stub
// per case to exercise the other states.
const DEFAULT_AGENTS_STATUS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: []
};

/**
 * Every card's title, in render order.
 *
 * `.ui-sheet-title` since task-39, where this read `.set-group > .mdetail-label`:
 * a settings group is a `Sheet` under a `SheetHead` now (DESIGN.md §8.6), so the
 * title is the primitive's `h3` and the group's scope is the `p` beside it. A
 * heading has no role this suite can use to tell it from the band's own title,
 * which is also a heading — hence the class, which is the one the component
 * actually renders.
 */
function groupTitles(): string[] {
  return [...document.querySelectorAll('.set-group .ui-sheet-title')].map((el) => el.textContent ?? '');
}

/** Each card's scope subtitle, in the same order — the second half of the pair
 *  `SettingsGroup` splits the old `Display · this device` string into. */
function groupScopes(): string[] {
  return [...document.querySelectorAll('.set-group .ui-sheet-sub')].map((el) => el.textContent ?? '');
}

/** The rows inside one named card, by their visible name — how this suite tells
 *  "moved into the new group" apart from "rendered twice". */
function rowNamesIn(title: string): string[] {
  const group = [...document.querySelectorAll('.set-group')].find((el) => el.querySelector('.ui-sheet-title')?.textContent === title);
  if (!group) throw new Error(`no settings card titled ${title}`);
  return [...group.querySelectorAll('.set-name')].map((el) => el.textContent ?? '');
}

describe('SettingsView', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(DEFAULT_AGENTS_STATUS)
      } as Response)
    ) as jest.Mock;
  });

  /**
   * Renders one of Settings' three pages (task-42 made it two; Dashboards is the third).
   *
   * The scope is written to storage rather than passed as a prop, because the
   * page genuinely reads it from there: `settingsScope` is a settings field,
   * and `SettingsView`'s props are unchanged by the split. A case that wants
   * the other page therefore has to say so BEFORE the first render — the
   * provider reads localStorage once on mount — which is why this takes a
   * parameter rather than offering a switch to click afterwards. There is no
   * in-page switch to click; the rail is the only thing that moves between
   * these three pages, at every width.
   */
  function renderView(scope: SettingsScope = 'local') {
    if (scope !== 'local') localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ settingsScope: scope }));
    render(
      <SettingsProvider>
        <TrackersProvider>
          <SettingsView />
        </TrackersProvider>
      </SettingsProvider>
    );
  }

  /** A fetch that answers the machines read with a minimal valid view, so the page draws its list and detail rather than its fallback. */
  const answerDashboards = () => {
    const view = {
      source: 'file',
      file: '/h/.backlog-manager/settings/dashboards.json',
      home: { label: 'Home', url: 'http://127.0.0.1:4310', account: null, models: ['opus'], efforts: ['low'], tokenVar: 'BM_AGENTS_TOKEN', tokenSet: true },
      dashboards: [],
      order: ['home'],
      strategy: 'prefer',
      threshold: 80
    };
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith('/api/dashboards/machines')
        ? { machines: [] }
        : url.endsWith('/api/dashboards')
          ? view
          : DEFAULT_AGENTS_STATUS;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    }) as jest.Mock;
  };

  it('offers the five themes and persists a pick under the backlog-manager key', async () => {
    renderView();
    expect(screen.getAllByRole('button', { pressed: false }).length).toBeGreaterThan(0);
    // Midnight, not Daylight: Daylight is the default, so clicking it would write what the provider already wrote on mount and prove nothing.
    await userEvent.click(screen.getByRole('button', { name: /^Midnight/ }));
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.theme).toBe('midnight');
    expect(document.documentElement.dataset.theme).toBe('midnight');
  });

  // Task 5: the staleness window, which is the only Board-scoped setting on
  // this page and the one control that changes what the board SHOWS rather
  // than how it looks. Asserted through storage rather than through the
  // board: what this test owns is that the row exists, is labelled, and
  // commits the value the board later reads — board.test.tsx owns what the
  // board does with it.
  it('persists the staleness window from the Board group', async () => {
    renderView();
    const row = screen.getByText('Archive after').closest('.set-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: '7d' }));
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.staleDays).toBe(7);
    // The default is what is pressed before anything is clicked, so the row
    // states the window in force rather than leaving it to be inferred.
    expect(within(row).getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(row).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  });

  // No `findByText(/connected/)` settle here since task-42, and its absence is
  // the point: the Local page mounts no `useAgents`, so there is no in-flight
  // fetch to land inside act(). The Shared page's own cases still wait on it.
  it('has no bionic reading rows', () => {
    renderView();
    expect(screen.queryByText(/Bionic/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fixation/)).not.toBeInTheDocument();
  });

  /* #350 — a stored value between the stops (LIMITS honours one on purpose) matched no option, so the row selected nothing and showed no current value. */
  it('lists and selects an off-step text size and staleness window', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ fontScale: 105, staleDays: 45 }));
    renderView();
    const size = screen.getByText('Text size').closest('.set-row') as HTMLElement;
    expect(within(size).getByRole('button', { name: '105%' })).toHaveAttribute('aria-pressed', 'true');
    const stale = screen.getByText('Archive after').closest('.set-row') as HTMLElement;
    expect(within(stale).getByRole('button', { name: '45d' })).toHaveAttribute('aria-pressed', 'true');
  });

  /* #350 — the swatches mirror shared/theme.css by hand (the swatch paints a palette that is not applied, so it cannot read live properties), and the
     mirror drifted: amber and nightshift painted another token as their accent. `--accent` is `var(--cyan)` in every theme, so the third band is `--cyan`. */
  it('paints each theme swatch from that theme’s own board, strip and accent', () => {
    const css = readFileSync(join(__dirname, '../shared/theme.css'), 'utf8');
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector}{`);
      if (at < 0) throw new Error(`no ${selector} block in theme.css`);
      return css.slice(at, css.indexOf('}', at));
    };
    const token = (body: string, name: string): string => {
      const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(body);
      if (m === null) throw new Error(`no --${name} in block`);
      return m[1].toLowerCase();
    };
    for (const id of ['midnight', 'graphite', 'amber', 'nightshift', 'daylight'] as const) {
      const body = block(id === 'midnight' ? ':root,[data-theme="midnight"]' : `[data-theme="${id}"]`);
      expect([id, SWATCHES[id].map((c) => c.toLowerCase())]).toEqual([id, [token(body, 'board'), token(body, 'strip'), token(body, 'cyan')]]);
    }
  });

  it('changes density and text size', async () => {
    renderView();
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
    await userEvent.click(screen.getByRole('button', { name: '120%' }));
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
  });

  /*
    The content-width row (task-42). Three cases rather than one, because the
    setting has three separable halves and only two of them are observable
    here: the control exists and starts on the drawn measure; a pick reaches
    storage; and the same pick reaches `<html>`.

    That third assertion is the one worth its line. Control and stamp are
    wired to each other by a dependency list in `useSettings`'s effect, and a
    stamp missing from that list is the classic version of this bug — it works
    on reload and not on the click, which is the shape nobody notices while
    developing because a reload is what you do next anyway. The CSS half and
    the pre-paint half are not observable at all and live in
    test/content-width-style.test.ts.
  */
  it('offers a content width, starting on the drawn measure', () => {
    renderView();
    const row = screen.getByText('Content width').closest('.set-row') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Fixed' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(row).getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('persists a full-width pick and stamps it on the document', async () => {
    renderView();
    const row = screen.getByText('Content width').closest('.set-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Full' }));

    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').contentWidth).toBe('full');
    expect(document.documentElement.dataset.width).toBe('full');
  });

  /*
    The source options follow the rail (source-sections spec): `Files` and `GitHub` are offered while their row is drawn — the shell's projects answer,
    supplied here straight through `ProjectsContext` — withheld while it is unknown, and a stored pin keeps its own option, Jira's rule.
  */
  function renderWithSources(drawn: DrawnSources | null) {
    render(
      <SettingsProvider>
        <TrackersProvider>
          <ProjectsContext.Provider value={{ data: null, drawn, reload: () => {} }}>
            <SettingsView />
          </ProjectsContext.Provider>
        </TrackersProvider>
      </SettingsProvider>
    );
  }
  const landingOptions = (): (string | null)[] =>
    within(screen.getByLabelText('Opens on'))
      .getAllByRole('option')
      .map((o) => o.textContent);

  it('offers every rail section as a landing choice, plus Last used', async () => {
    renderWithSources({ files: true, github: true });
    expect(landingOptions()).toEqual(['Last used', 'Files', 'GitHub', 'Runs', 'Settings']);

    // Files rather than GitHub, because GitHub is what an unrecognised section
    // resolves to anyway — picking it could pass on a picker that stored
    // nothing at all.
    await userEvent.selectOptions(screen.getByLabelText('Opens on'), 'files');
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.landing).toBe('files');
  });

  it('offers only the sources whose row is drawn, and none while the answer is unknown', () => {
    renderWithSources({ files: true, github: false });
    expect(landingOptions()).toContain('Files');
    expect(landingOptions()).not.toContain('GitHub');
    cleanup();

    renderWithSources(null);
    expect(landingOptions()).toEqual(['Last used', 'Runs', 'Settings']);
  });

  it('keeps a stored github pin its GitHub option on a machine with no github project', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'github' }));
    renderWithSources({ files: true, github: false });
    expect(landingOptions()).toEqual(['Last used', 'Files', 'GitHub', 'Runs', 'Settings']);
    expect(screen.getByLabelText('Opens on')).toHaveValue('github');
  });

  /*
   * task-42 — the split itself (Local and Shared; Dashboards joined later as a third page). What these cases pin is the claim the whole feature rests on:
   * the PAGE is the scope, so no card can mix backends and no card appears on both pages.
   *
   * Asserted both ways round on purpose. A presence check alone would pass on
   * a build that rendered every card on every page and merely added a band
   * pill — which is precisely the shape a half-done version of this change
   * takes, and precisely the shape that would make the pill a lie.
   */
  describe('the three pages (task-42)', () => {
    it('renders only the per-device cards on Local', () => {
      renderView();

      for (const title of ['Display', 'Board', 'Orchestrator', 'Dispatch']) expect(groupTitles()).toContain(title);
      expect(groupTitles()).not.toContain('Orchestrator watchdog');
      expect(groupTitles()).not.toContain('Dashboards');
    });

    it('renders only the host-backed cards on Shared — and not the Dashboards card, which is a page of its own', () => {
      renderView('shared');

      for (const title of ['Sources', 'Orchestrator watchdog', 'Backlog tick']) expect(groupTitles()).toContain(title);
      // The Trackers card was split by subject (source-sections spec): its sync pickers live on GitHub › Settings, the rest on the Sources card.
      expect(groupTitles()).not.toContain('Trackers');
      for (const title of ['Display', 'Board', 'Orchestrator', 'Dispatch', 'Dashboards']) expect(groupTitles()).not.toContain(title);
    });

    /*
      The third page draws the machines list's own sheets (`.dash-page-*`), never a `SettingsGroup`: a card from Local or Shared on it would make the
      band's pill a lie, and a `Dashboards` card on Shared would be the page twice. Asserted by what is absent as well as by what is present, for the
      reason the two cases above give.
    */
    it('renders only the Dashboards page on Dashboards: the Suggest group and the machine list, none of Local’s or Shared’s cards', async () => {
      answerDashboards();
      renderView('dashboards');
      await waitFor(() => expect(document.querySelectorAll('.dash-page-row').length).toBeGreaterThan(0));

      expect(groupTitles()).toContain('Suggest');
      for (const title of ['Display', 'Board', 'Orchestrator', 'Dispatch', 'Orchestrator watchdog', 'Backlog tick', 'Sources'])
        expect(groupTitles()).not.toContain(title);
    });

    /*
      The pill carries the distinction in WORDS, not in a colour: it is the
      existing `Pill` primitive at `neutral` on both pages. `PillTone`'s five
      members each name a reading — live, warn, bad, done, neutral — none of
      them means "shared", and minting a sixth look for the settings block
      would be a second home for a primitive, which design-guards' guard 7
      exists to refuse.
    */
    /*
      Queried inside the band's own right slot rather than by text alone, and
      that is not query hygiene — on Shared the `Claude Agents` card's scope
      subtitle says `this machine` too, so a bare text query matches two nodes
      and would pass on a build where the pill had vanished and the card's
      subtitle was all that was left.
    */
    const scopePill = (): HTMLElement => document.querySelector('.ui-band-right .ui-pill') as HTMLElement;

    it('states the scope in the band, in words rather than in a tone', () => {
      renderView();
      expect(scopePill()).toHaveTextContent('this browser');
      expect(scopePill()).toHaveClass('ui-pill-neutral');
    });

    it('states the Shared scope as this machine', () => {
      renderView('shared');
      expect(scopePill()).toHaveTextContent('this machine');
      expect(scopePill()).toHaveClass('ui-pill-neutral');
    });

    it('states the Dashboards scope as this machine too, in the same neutral pill', () => {
      renderView('dashboards');
      expect(scopePill()).toHaveTextContent('this machine');
      expect(scopePill()).toHaveClass('ui-pill-neutral');
    });

    // The title is the page's own name and does not change with the scope; the subtitle is the sentence that says what is on the page, so it must differ.
    it('titles every page Settings and gives each its own subtitle', () => {
      const sub = (): string | null => document.querySelector('.ui-band-sub')?.textContent ?? null;
      const subs: Array<string | null> = [];
      for (const scope of ['local', 'shared', 'dashboards'] as const) {
        renderView(scope);
        expect(screen.getByRole('heading', { name: 'Settings' })).toHaveClass('ui-band-title');
        subs.push(sub());
        cleanup();
        localStorage.clear();
      }
      expect(new Set(subs).size).toBe(3);
      expect(subs[2]).toBe(
        'The machines a launch can run on, in prefer order, and how the launch sheet picks one. Saved on the API host — change it here and it changes for everyone.'
      );
    });

    /*
      No in-page switch, at any width — the rail's tree is the only thing that
      moves between the three pages, the same rule Runs' three pages follow since
      task-38. The dashboard this pattern was ported from DOES show a pill
      switch in the band below 700 px; this board does not, because the rail's
      trees stand open at that width and a second control here would be a
      second wording free to disagree with the tree's.

      Pinned rather than left to the code, because "add a switch on the phone"
      is exactly the improvement a later reader would make without knowing it
      was already decided against.
    */
    it('offers no control of its own that changes the page', async () => {
      renderView();
      expect(screen.queryByRole('button', { name: 'Local' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Shared' })).toBeNull();

      cleanup();
      renderView('shared');
      expect(screen.queryByRole('button', { name: 'Local' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Shared' })).toBeNull();

      cleanup();
      renderView('dashboards');
      await screen.findByText(/connected/);
      for (const name of ['Local', 'Shared', 'Dashboards']) expect(screen.queryByRole('button', { name })).toBeNull();
    });

    /*
      `open dashboard ↗` moves with the value that supplies its href. A link
      driven by a per-device field has no business on the page that promises
      everything on it is the host's, and beside the field that sets it the
      link also becomes self-explaining.
    */
    it('keeps the dashboard link and its open control together on Local', () => {
      renderView();

      const dispatch = [...document.querySelectorAll('.set-group')].find((el) => el.querySelector('.ui-sheet-title')?.textContent === 'Dispatch');
      expect(dispatch).toBeTruthy();
      expect(within(dispatch as HTMLElement).getByRole('link', { name: /open dashboard/ })).toHaveAttribute('href', 'http://127.0.0.1:5174');
    });

    it('leaves the Shared and Dashboards pages with no dashboard-link control', async () => {
      renderView('shared');
      expect(screen.queryByRole('link', { name: /open dashboard/ })).toBeNull();

      cleanup();
      renderView('dashboards');
      await screen.findByText(/connected/);
      expect(screen.queryByRole('link', { name: /open dashboard/ })).toBeNull();
    });
  });

  // Nested (rather than a sibling top-level describe) so these cases can use
  // the `renderView()` closure above: outside a `SettingsProvider`,
  // `useSettings()` falls back to `DEFAULT_SETTINGS` with a no-op `update`
  // (see the last lines of client/src/hooks/useSettings.tsx) and never
  // touches localStorage at all, so a bare `render(<SettingsView />)` could
  // never observe the edited-link case below.
  // The status that was the `Claude Agents` card is now Home's dispatch report on the Dashboards page. These cases answer every fetch with an agents status,
  // so the dashboards read fails its shape check and the page draws its fallback, which keeps the dispatch row — the cases still hold as they were written.
  describe('the dispatch report · Dashboards (Home’s detail)', () => {
    it('does not show the setup steps before the first answer lands', () => {
      // A promise that never resolves keeps `status` at `null` for the
      // whole test — the "not answered yet" frame every real load briefly
      // passes through on the way to healthy or unhealthy. This is the
      // frame `!healthy` alone gets wrong: `healthy` requires `status !==
      // null`, so it is already false here too, and a bare `!healthy` gate
      // would show the five-step setup panel while the status line above it
      // still (correctly) says "checking…".
      global.fetch = jest.fn(() => new Promise(() => {})) as jest.Mock;

      renderView('dashboards');
      // `getAllBy`, not `getBy`: the page's other unanswered reads (the list,
      // each machine's health) say `checking…` in the same frame and for the same reason — its own
      // fetch has not answered either. What this case is about is the SETUP
      // PANEL below the status line, which must not appear while the answer is
      // still outstanding.
      expect(screen.getAllByText(/checking…/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/BM_AGENTS=on/)).not.toBeInTheDocument();
    });

    it('reports a healthy dashboard and the project count', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              enabled: true,
              reachable: true,
              remoteAnswer: true,
              spawnAvailable: true,
              spawnMaxPermission: 'auto',
              projectPaths: ['/a', '/b']
            })
        } as Response)
      ) as jest.Mock;

      renderView('dashboards');
      expect(await screen.findByText(/connected/)).toBeInTheDocument();
      expect(screen.getByText(/ceiling: auto/)).toBeInTheDocument();
      expect(screen.getByText(/2 projects/)).toBeInTheDocument();
      // No setup steps when everything is green — the panel should not nag.
      expect(screen.queryByText(/BM_AGENTS=on/)).not.toBeInTheDocument();
    });

    it('shows the setup steps when dispatch is off', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              enabled: false,
              reachable: false,
              remoteAnswer: false,
              spawnAvailable: false,
              spawnMaxPermission: null,
              projectPaths: []
            })
        } as Response)
      ) as jest.Mock;

      renderView('dashboards');
      expect(await screen.findByText(/BM_AGENTS=on/)).toBeInTheDocument();
      expect(screen.getByText(/hooks:install/)).toBeInTheDocument();
    });

    /** Answers every fetch with one agents status, so the dispatch row is the only thing under test. */
    const answerWith = (status: Record<string, unknown>) => {
      global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status) } as Response)) as jest.Mock;
    };
    const dispatchLine = () => screen.getByText('Dispatch', { selector: '.set-name' }).closest('.set-row') as HTMLElement;

    it('draws an unreachable dashboard as a crashed dot', async () => {
      answerWith({ enabled: true, reachable: false, remoteAnswer: false, spawnAvailable: false, spawnMaxPermission: null, projectPaths: [], error: 'ECONNREFUSED' });

      renderView('dashboards');
      await screen.findByText(/unreachable/);
      expect(dispatchLine().querySelector('.ui-dot-crashed')).not.toBeNull();
    });

    it('draws a reachable dashboard with no CLAUDE_BIN as a paused dot and shows the setup steps', async () => {
      // The case the old three-colour dot drew green: every launch to this dashboard is a 404, and nothing on the row said so.
      answerWith({ enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: false, spawnMaxPermission: 'auto', projectPaths: ['/a'] });

      renderView('dashboards');
      await screen.findByText(/no CLAUDE_BIN/);
      expect(dispatchLine().querySelector('.ui-dot-paused')).not.toBeNull();
      expect(screen.getByText(/BM_AGENTS=on/)).toBeInTheDocument();
    });

    it('draws a healthy dashboard as a live dot', async () => {
      answerWith({ enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto', projectPaths: ['/a'] });

      renderView('dashboards');
      await screen.findByText(/connected/);
      expect(dispatchLine().querySelector('.ui-dot-live')).not.toBeNull();
    });
  });

  /*
   * task-42: the per-device half of what `Claude Agents` used to hold, in a
   * Local card of its own.
   *
   * That card mixed backends — its status lines report the HOST's environment
   * while the model, effort and link rows are this browser's localStorage —
   * and the whole promise of the Local/Shared split is that the page IS the
   * scope, so it had to divide. The cases below are the old ones MOVED, not
   * rewritten: what they assert about each control is unchanged, and only the
   * page they are rendered on is new.
   */
  describe('the Dispatch group · Local', () => {
    it('stores an edited dashboard link and refuses a bad scheme', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              enabled: true,
              reachable: true,
              remoteAnswer: true,
              spawnAvailable: true,
              spawnMaxPermission: 'auto',
              projectPaths: []
            })
        } as Response)
      ) as jest.Mock;

      renderView();
      const field = await screen.findByLabelText('Dashboard link');
      await userEvent.clear(field);
      await userEvent.type(field, 'https://box.ts.net:5174/');
      await userEvent.tab();
      expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase).toBe('https://box.ts.net:5174');

      // The input is keyed on the stored link and a commit counter (SettingsView.tsx) so it
      // re-seeds from the clamped value on every commit — here, the
      // trailing slash just typed is gone from the box too, not only from
      // storage. That commit changed the key and remounted the input, so
      // the earlier `field` handle is now a detached node; re-query for the
      // live one rather than reusing it.
      const fieldAfterSlashStrip = screen.getByLabelText('Dashboard link');
      expect(fieldAfterSlashStrip).toHaveValue('https://box.ts.net:5174');

      await userEvent.clear(fieldAfterSlashStrip);
      await userEvent.type(fieldAfterSlashStrip, 'javascript:alert(1)');
      await userEvent.tab();
      expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase).toBe('http://127.0.0.1:5174');

      // Same guarantee on the refusal path: storage falls back to the
      // default, and the box must show that fallback too — not the
      // rejected text it was last typed, with nothing on screen to say it
      // was refused.
      const fieldAfterRefusal = screen.getByLabelText('Dashboard link');
      expect(fieldAfterRefusal).toHaveValue('http://127.0.0.1:5174');
    });

    /* #350 — the input re-seeded on `key={settings.linkBase}`, which only changes when the STORED value does. A commit that clamps back to the value
       already stored kept the key, so React kept the node and the box went on showing the typed text. Both cases below start from the stored default. */
    it('re-seeds the dashboard link when a commit clamps back to the value already stored', async () => {
      renderView();
      const field = await screen.findByLabelText('Dashboard link');
      await userEvent.clear(field);
      await userEvent.type(field, 'http://127.0.0.1:5174/');
      await userEvent.tab();
      expect(screen.getByLabelText('Dashboard link')).toHaveValue('http://127.0.0.1:5174');

      const again = screen.getByLabelText('Dashboard link');
      await userEvent.clear(again);
      await userEvent.type(again, 'javascript:alert(1)');
      await userEvent.tab();
      expect(screen.getByLabelText('Dashboard link')).toHaveValue('http://127.0.0.1:5174');
    });

    it('offers a default model and effort, both starting on the CLI default', async () => {
      renderView();
      const model = (await screen.findByLabelText('Default model')) as HTMLSelectElement;
      const effort = screen.getByLabelText('Default effort') as HTMLSelectElement;
      expect(model.value).toBe('');
      expect(effort.value).toBe('');
      expect([...model.options].map((o) => o.textContent)).toEqual(['CLI default', 'opus', 'sonnet', 'haiku', 'fable']);
      expect([...effort.options].map((o) => o.textContent)).toEqual(['CLI default', 'low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('persists a picked default under the backlog-manager key', async () => {
      renderView();
      await userEvent.selectOptions(await screen.findByLabelText('Default model'), 'haiku');
      await userEvent.selectOptions(screen.getByLabelText('Default effort'), 'low');
      const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
      expect(stored.dispatchDefaultModel).toBe('haiku');
      expect(stored.dispatchDefaultEffort).toBe('low');
    });

    // The board's execute launch sheet's Finish default: both real options, no blank third state (an absent value reads in-place), and a pick lands under
    // the one settings key like the model/effort defaults beside it.
    it('offers an execute finish default, starting on In place, and persists a pick', async () => {
      renderView();
      const select = (await screen.findByLabelText('Execute finish')) as HTMLSelectElement;
      expect(select.value).toBe('in-place');
      expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
        ['in-place', 'In place'],
        ['pr', 'PR']
      ]);
      expect(screen.getByText('PR mode works in its own worktree, reviews, pushes and opens a PR. It never merges.')).toBeInTheDocument();
      await userEvent.selectOptions(select, 'pr');
      expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').executeDefaultFinish).toBe('pr');
    });

    // The groom sheet's Finish default and the two PR defaults every PR launch shares. Fix is a refinement of auto-merge, so its switch is dead (with a title
    // saying why) while auto-merge is off; turning auto-merge off never rewrites the stored fix value — it is inert, and the sheet seeds Fix off.
    it('offers a groom finish default, starting on In place, and persists a pick', async () => {
      renderView();
      const select = (await screen.findByLabelText('Groom finish')) as HTMLSelectElement;
      expect(select.value).toBe('in-place');
      expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
        ['in-place', 'In place'],
        ['pr', 'PR']
      ]);
      expect(
        screen.getByText('PR mode writes the spec and plan in its own worktree, commits, pushes and opens a PR. It never merges.')
      ).toBeInTheDocument();
      await userEvent.selectOptions(select, 'pr');
      expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').groomDefaultFinish).toBe('pr');
    });

    it('offers the auto-merge and fix defaults, with Fix disabled until Auto-merge is on', async () => {
      renderView();
      const autoMerge = await screen.findByRole('switch', { name: 'auto-merge PRs' });
      const fix = screen.getByRole('switch', { name: 'fix if it fails' });
      expect(
        screen.getByText('Preselects Auto-merge on a PR launch. Armed only if the GitHub repo allows auto-merge — GitHub does the merge.')
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Preselects Fix on a PR launch: the session stays and fixes failing checks and base conflicts, up to 3 rounds in 45 minutes.'
        )
      ).toBeInTheDocument();
      expect(autoMerge).toHaveAttribute('aria-checked', 'false');
      expect(fix).toBeDisabled();
      expect(fix).toHaveAttribute('title', 'Needs Auto-merge PRs on');
      await userEvent.click(autoMerge);
      expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').prAutoMergeDefault).toBe(true);
      expect(screen.getByRole('switch', { name: 'fix if it fails' })).toBeEnabled();
      await userEvent.click(screen.getByRole('switch', { name: 'fix if it fails' }));
      expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').prFixDefault).toBe(true);
      // Auto-merge off again: Fix greys out but its stored value is left alone.
      await userEvent.click(screen.getByRole('switch', { name: 'auto-merge PRs' }));
      const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
      expect([stored.prAutoMergeDefault, stored.prFixDefault]).toEqual([false, true]);
      expect(screen.getByRole('switch', { name: 'fix if it fails' })).toBeDisabled();
    });

    // Task 7: the orchestrator's own default, seeding the sheet Task 8 adds —
    // not the per-item launch sheet the two rows above feed. Asserted the
    // same way as those: the row offers both real options (never a blank
    // "CLI default" — absent means 'merge' server-side too, there is no third
    // state to represent) and starts on 'merge', since that is the default
    // this whole feature must not silently change for a board that has never
    // touched the setting.
    it('offers a default merge mode, starting on merge, and persists a pick', async () => {
      renderView();
      const select = (await screen.findByLabelText('Default merge mode')) as HTMLSelectElement;
      expect(select.value).toBe('merge');
      expect([...select.options].map((o) => o.value)).toEqual(['merge', 'branch', 'pr']);
      // bug-36. Text as well as value, because the text is what was wrong:
      // this row picks a default BEFORE any run exists, so it cannot know a
      // base and must not name one. 'Merge to main' here was a claim about
      // where every future run would land, which task-44 made false.
      expect([...select.options].map((o) => o.textContent)).toEqual([
        'Merge into the base branch',
        'Leave branches for me',
        'Open a PR into the base branch'
      ]);
      // The hint's own claim, separately false since task-44 whatever the
      // picker is called: a run merges into the branch it was STARTED on, not
      // into main. Asserted as an absence because the replacement sentence's
      // exact wording is not what this row is for — the falsehood leaving is.
      const hint = select.closest('.set-row')?.querySelector('.set-hint')?.textContent ?? '';
      expect(hint).not.toContain('every run does today');

      await userEvent.selectOptions(select, 'branch');
      const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
      expect(stored.orchestrateDefaultMergeMode).toBe('branch');
    });
  });

  /*
   * task-19: the orchestrate defaults get a group of their own, and `Default
   * merge mode` MOVES into it. The Claude Agents group's own comment says a
   * reader arrives there asking "how does dispatch behave on this device" —
   * merge mode never answered that question, and with a second orchestrate
   * default landing beside it the mismatch stops being cosmetic. Model and
   * effort stay: they genuinely are dispatch defaults, and the orchestrate
   * sheet borrowing them is not a reason to move them.
   */
  // Jira phase 5 (spec §2): `Jira default action` is the row Run ▾ lists first, marked `default` — never the last launch. Drawn only while the status says
  // configured, like every Jira surface; the options are the two built-ins by label and then the machine's skills.
  describe('the Jira default action row', () => {
    const SKILL: JiraSkill = { id: 's_0123abcd', name: 'Groom ticket', prompt: '/jira-groom {key}' };

    function jiraData(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
      return {
        configured: true,
        configUnreadable: null,
        site: 'acme.atlassian.net',
        me: null,
        tokenKind: 'classic',
        access: 'ok',
        detail: null,
        boards: [],
        repos: {},
        repoDefaults: {},
        projects: [],
        skills: [SKILL],
        calls: { sweep: 0, last429At: null },
        live: {},
        armed: false,
        home: '/home/x',
        ...over
      };
    }

    function renderWithJira(data: JiraStatusPayload | null) {
      const jira: JiraState = { data, loading: false, error: false, reload: () => {} };
      render(
        <JiraContext.Provider value={jira}>
          <SettingsProvider>
            <TrackersProvider>
              <SettingsView />
            </TrackersProvider>
          </SettingsProvider>
        </JiraContext.Provider>
      );
    }

    it('is absent while Jira is unconfigured and before the status has answered', () => {
      renderWithJira(jiraData({ configured: false }));
      expect(screen.queryByLabelText('Jira default action')).toBeNull();
      expect(rowNamesIn('Dispatch')).not.toContain('Jira default action');
      cleanup();
      renderWithJira(null);
      expect(screen.queryByLabelText('Jira default action')).toBeNull();
    });

    it('offers the two built-ins by label and then each skill, starting on Work it end to end', () => {
      renderWithJira(jiraData());
      const select = screen.getByLabelText('Jira default action') as HTMLSelectElement;
      expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
        ['execute', 'Work it end to end'],
        ['context', 'Open with the ticket loaded'],
        ['s_0123abcd', 'Groom ticket']
      ]);
      expect(select.value).toBe('execute');
      expect(rowNamesIn('Dispatch')).toEqual([
        'Default model',
        'Default effort',
        'Execute finish',
        'Groom finish',
        'Auto-merge PRs',
        'Fix if it fails',
        'Jira default action',
        'Dashboard link'
      ]);
    });

    it('persists a pick as the setting string', async () => {
      renderWithJira(jiraData());
      await userEvent.selectOptions(screen.getByLabelText('Jira default action'), 's_0123abcd');
      expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').jiraDefaultAction).toBe('s_0123abcd');
      await userEvent.selectOptions(screen.getByLabelText('Jira default action'), 'context');
      expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').jiraDefaultAction).toBe('context');
    });

    it('reads a stored skill that has since been deleted as Work it end to end, without rewriting the stored value', () => {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ jiraDefaultAction: 's_gone0000' }));
      renderWithJira(jiraData({ skills: [] }));
      const select = screen.getByLabelText('Jira default action') as HTMLSelectElement;
      expect(select.value).toBe('execute');
      expect(select.options[select.selectedIndex].textContent).toBe('Work it end to end');
    });
  });

  describe('the Orchestrator group', () => {
    /*
      This case used to read `renders above the watchdog group`, and task-42
      had to restate it rather than keep it: `Orchestrator` is Local and
      `Orchestrator watchdog` is Shared, so "renders above" is no longer a
      question either page can be asked. The adjacency it protected — the same
      subject read at two scopes, met in that order — is gone BY DESIGN, since
      the scopes are now the pages themselves, and a test asserting a layout
      the design deliberately dropped is worse than no test at all.

      What survives is the half that is still true and still worth pinning:
      the card exists on Local and holds its own two rows rather than having
      shed them into the Dispatch card beside it.
    */
    it('holds its own two rows on the Local page', () => {
      renderView();

      expect(groupTitles()).toContain('Orchestrator');
      expect(rowNamesIn('Orchestrator')).toEqual(['Default merge mode', 'Default question mode']);
    });

    /*
      The other half of the old `holds both orchestrate defaults, and the Agents
      group holds neither`, which could no longer be asked in one render: the
      two cards it compared are on different pages now. Same claim, asked of
      the card that is actually beside this one.
    */
    it('does not hold the dispatch defaults, which are the Dispatch card', () => {
      renderView();

      const dispatch = rowNamesIn('Dispatch');
      expect(dispatch).not.toContain('Default merge mode');
      expect(dispatch).toEqual(expect.arrayContaining(['Default model', 'Default effort']));
    });

    // Starts on `park` — what every run did before the mode existed — and
    // offers both real members with no blank "CLI default" third state, for
    // the same reason the merge-mode row above has none: the union is closed
    // and absent already means one of the two server-side.
    it('offers a default question mode, starting on park, and persists a pick', async () => {
      renderView();
      const select = (await screen.findByLabelText('Default question mode')) as HTMLSelectElement;
      expect(select.value).toBe('park');
      expect([...select.options].map((o) => o.value)).toEqual(['decide', 'park']);

      await userEvent.selectOptions(select, 'decide');
      const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
      expect(stored.orchestrateDefaultQuestionMode).toBe('decide');
    });

    it('keeps a stored pr default and falls back to merge for a value outside the vocabulary', async () => {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ orchestrateDefaultMergeMode: 'pr' }));
      renderView();
      expect(((await screen.findByLabelText('Default merge mode')) as HTMLSelectElement).value).toBe('pr');
      cleanup();

      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ orchestrateDefaultMergeMode: 'pull' }));
      renderView();
      expect(((await screen.findByLabelText('Default merge mode')) as HTMLSelectElement).value).toBe('merge');
    });

    it('still persists a merge-mode pick from its new home', async () => {
      renderView();
      const select = (await screen.findByLabelText('Default merge mode')) as HTMLSelectElement;
      await userEvent.selectOptions(select, 'branch');
      const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
      expect(stored.orchestrateDefaultMergeMode).toBe('branch');
    });
  });
  /*
   * task-39 — the restyle. What these cases pin is the half of §8.6 that is
   * structural rather than cosmetic: which cards exist, what each groups, and
   * that every control on the page is one of the `ui/` 36 px family rather than
   * a bare element this file styled itself.
   */
  describe('the redrawn page (task-39)', () => {
    it('opens on a band, not a card', () => {
      renderView();
      // The same `Band` primitive every other page opens with (§8.2). Queried by
      // ROLE as well as text, because `Settings` is also one of the five
      // `Opens on` options and a bare text query matches both — and asserted
      // through the primitive's own class because a band title and a card title
      // are both headings, and the distinction between them is the point.
      expect(screen.getByRole('heading', { name: 'Settings' })).toHaveClass('ui-band-title');
    });

    /**
     * The five groupings, unchanged — this task restyles the cards, it does not
     * decide what they group. Asserted as an exact ordered list rather than five
     * `toBeInTheDocument`s, because the failure worth catching is a card
     * quietly gaining or losing a member, which five presence checks would miss.
     *
     * The scopes are asserted beside them because `SettingsGroup` splits what
     * used to be one `Display · this device` string into a title and a subtitle:
     * a list of titles alone would pass on a page that had dropped every scope,
     * and the scope is the half that says whether changing a setting affects
     * anybody else.
     */
    it("renders the Local page's four cards, each with its own scope", () => {
      renderView();
      expect(groupTitles()).toEqual(['Display', 'Board', 'Orchestrator', 'Dispatch']);
      expect(groupScopes()).toEqual(['this device', 'this device', 'this device', 'this device']);
    });

    /*
      Both pages asserted, because the five cards that used to sit on one page
      are now two sets and an exact list of one set alone would pass on a build
      that had lost the other outright. The scopes are asserted beside the
      titles for the reason task-39 gave: a list of titles alone would pass on
      a page that had dropped every scope, and the scope is the half that says
      whether changing a setting affects anybody else.

      On Local every scope is the same three words, which looks redundant and
      is not: the PAGE says `this browser` in its pill and each card says
      `this device`, and the day a card on this page says anything else it is a
      card on the wrong page.
    */
    it("renders the Shared page's four cards, each with its own scope", () => {
      renderView('shared');
      // `Trackers` joined the pair in task-45: a third host-backed report, in
      // the same column as `Claude Agents` because both report and neither
      // sets. An exact list rather than a `toContain` for the reason the
      // comment above gives — a build that lost one card outright would pass
      // the looser check.
      // `Backlog tick` joined in the tick breaker, under the watchdog in the left column (the two controls), so it renders second.
      // `Dashboards` joined in multi-dashboard task 11, absorbed `Claude Agents` (whose dispatch report became its Home row) and then left for a
      // Settings page of its own, which is why Shared draws no dispatch line at all.
      // `Time zone` joined in #241, under the tick breaker in the same column — the third host control.
      // `Sources` replaced `Trackers` in the source-sections change and comes FIRST: the spec puts it at the page's top, so the one host report now
      // opens the left column and the three controls moved to the right. `Trackers` is gone from this page — its pickers are GitHub › Settings'.
      expect(groupTitles()).toEqual(['Sources', 'Orchestrator watchdog', 'Backlog tick', 'Time zone']);
      expect(groupScopes()).toEqual(['this machine', 'this server', 'this machine', 'this server']);
    });

    /** And the same rows inside them — the three cards this file owns outright.
     *  `Theme` and `Setting it up` are rows without a `SettingsRow` wrapper and
     *  still carry `.set-name`, which is what makes them visible here. */
    /*
      The rows inside each card. `Claude Agents` used to hold all four of
      `Dispatch`, `Default model`, `Default effort` and `Dashboard link`; the
      three per-device ones moved to the new `Dispatch` card on Local and the
      status row stayed behind, which is exactly what these two cases now say.
    */
    it('groups the same rows it grouped before, on the Local page', () => {
      renderView();
      expect(rowNamesIn('Display')).toEqual(['Theme', 'Density', 'Text size', 'Content width', 'Opens on']);
      expect(rowNamesIn('Board')).toEqual(['Archive after']);
      expect(rowNamesIn('Dispatch')).toEqual([
        'Default model',
        'Default effort',
        'Execute finish',
        'Groom finish',
        'Auto-merge PRs',
        'Fix if it fails',
        'Dashboard link'
      ]);
    });

    it('puts the dispatch status line in Home’s detail on the Dashboards page, and none on Shared', async () => {
      answerDashboards();
      renderView('dashboards');
      await waitFor(() => expect(document.querySelector('.dash-page-detail')).not.toBeNull());
      const detail = document.querySelector('.dash-page-detail') as HTMLElement;
      expect(within(detail).getByText(/^dispatch/, { selector: '.dash-page-status' })).toBeInTheDocument();

      cleanup();
      renderView('shared');
      expect(screen.queryByText('Dispatch', { selector: '.set-name' })).toBeNull();
    });

    /**
     * Every picker on the page is the `Select` primitive, and every segmented
     * control is `Segmented` wearing its pill variant (§8.6) — a source-level
     * check over what this file IMPORTS, not over what it renders.
     *
     * Rendered classes would pass just as happily on a page that had copied the
     * primitive's markup inline, which is precisely the drift `ui/` exists to
     * stop and precisely what a `./SettingsRow` import left behind by task-36
     * would look like. The one thing a test can say about that is where the
     * component came from.
     */
    it('takes every control from ui/, never from ./SettingsRow', () => {
      const src = readFileSync(join(__dirname, '..', 'client', 'src', 'components', 'settings', 'SettingsView.tsx'), 'utf8');
      expect(src).toMatch(/import \{ Segmented \} from '\.\.\/ui\/Segmented'/);
      expect(src).toMatch(/import \{ Select \} from '\.\.\/ui\/Select'/);
      expect(src).toMatch(/import \{ Band \} from '\.\.\/ui\/Band'/);
      // `./SettingsRow` may still hand over the row and the group — those are
      // this card's composition, not primitives (the design spec's §12.3) — and
      // nothing else.
      const fromRow = /import \{([^}]*)\} from '\.\.\/ui\/SettingsRow'/.exec(src)?.[1] ?? '';
      expect(fromRow.split(',').map((n) => n.trim())).toEqual(['SettingsGroup', 'SettingsRow']);
      // No bare `<select>` left anywhere: the primitive is the one home for the
      // look, so a hand-rolled one is a second.
      expect(src).not.toMatch(/<select\b/);
    });

    /** `Segmented`'s pill variant, on every segmented row this page draws
     *  (§8.6's "the theme and density pickers take `Switch`'s pill shape"). */
    it('draws its segmented rows in the pill skin', () => {
      renderView();
      for (const label of ['Density', 'Text size', 'Content width', 'Archive after']) {
        expect(screen.getByRole('group', { name: label })).toHaveClass('ui-seg-pill');
      }
    });

    /**
     * The theme swatch keeps its job at 24 px and an 8 px radius — this design's
     * own figure (§8.6), against the 34 px strip at a 2 px corner it drew
     * before. Read off the stylesheet, since jsdom applies none.
     */
    it('sizes the theme swatch at 24 px and an 8 px radius', () => {
      const block = ruleBlock(readStyles(), '.set-swatch') as string;
      expect(block).toMatch(/width: *24px/);
      expect(block).toMatch(/height: *24px/);
      expect(block).toMatch(/border-radius: *8px/);
    });

    /**
     * Settings' own breakpoint (§8.6): the two columns fold to one under
     * 1100 px, ABOVE the 700 px phone break every other split on this board
     * uses. A regression guard against unifying it with the others — which is
     * the change a reader tidying up media queries would make, and which would
     * squeeze a label, a hint and a 36 px control into one 800 px-wide row.
     */
    it('folds its columns at 1100 px, not at the board-wide 700 px', () => {
      const css = readStyles();
      const fold = /@media \(max-width: (\d+)px\) \{ \.set-cols \{[^}]*grid-template-columns: 1fr/.exec(css);
      expect(fold?.[1]).toBe('1100');
      // And the 700 px block that DOES exist for this page touches the row, not
      // the grid: it stacks a control under its label and says nothing about
      // `.set-cols`.
      const phone = /@media \(max-width: 700px\) \{\s*\.set-row[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
      expect(phone).not.toMatch(/set-cols/);
    });
  });
});
