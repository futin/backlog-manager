/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { readStyles, ruleBlock } from './helpers/css-rule';

import SettingsView from '../client/src/components/settings/SettingsView';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';
import type { AgentsStatus } from '../shared/types';

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

  function renderView() {
    render(
      <SettingsProvider>
        <SettingsView />
      </SettingsProvider>
    );
  }

  it('offers the five themes and persists a pick under the backlog-manager key', async () => {
    renderView();
    expect(screen.getAllByRole('button', { pressed: false }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Daylight Strip/ }));
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.theme).toBe('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
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

  it('has no bionic reading rows', async () => {
    renderView();
    expect(screen.queryByText(/Bionic/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fixation/)).not.toBeInTheDocument();
    // Lets the mocked agents-status fetch's state update land inside act()
    // before the test ends — otherwise React logs an act() warning on every
    // run, because nothing above this line waits on the fetch `AgentsGroup`
    // (via `useAgents`) always fires on mount. Same idiom as
    // test/item-modal.test.tsx's identical fix for the modal's body fetch: wait
    // on text the healthy default stub (above) is guaranteed to produce.
    await screen.findByText(/connected/);
  });

  it('changes density and text size', async () => {
    renderView();
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
    await userEvent.click(screen.getByRole('button', { name: '120%' }));
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
  });

  it('offers every rail section as a landing choice, plus Last used', async () => {
    renderView();
    const picker = screen.getByLabelText('Opens on');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Last used', 'Board', 'Runs', 'Archive', 'Settings']);

    // Archive rather than Board, because Board is what an unrecognised value
    // resolves to anyway — picking it could pass on a picker that stored
    // nothing at all.
    await userEvent.selectOptions(picker, 'archive');
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.landing).toBe('archive');
  });

  // Nested (rather than a sibling top-level describe) so these cases can use
  // the `renderView()` closure above: outside a `SettingsProvider`,
  // `useSettings()` falls back to `DEFAULT_SETTINGS` with a no-op `update`
  // (see the last lines of client/src/hooks/useSettings.tsx) and never
  // touches localStorage at all, so a bare `render(<SettingsView />)` could
  // never observe the edited-link case below.
  describe('the Claude Agents group', () => {
    it('does not show the setup steps before the first answer lands', () => {
      // A promise that never resolves keeps `status` at `null` for the
      // whole test — the "not answered yet" frame every real load briefly
      // passes through on the way to healthy or unhealthy. This is the
      // frame `!healthy` alone gets wrong: `healthy` requires `status !==
      // null`, so it is already false here too, and a bare `!healthy` gate
      // would show the five-step setup panel while the status line above it
      // still (correctly) says "checking…".
      global.fetch = jest.fn(() => new Promise(() => {})) as jest.Mock;

      renderView();
      expect(screen.getByText(/checking…/)).toBeInTheDocument();
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

      renderView();
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

      renderView();
      expect(await screen.findByText(/BM_AGENTS=on/)).toBeInTheDocument();
      expect(screen.getByText(/hooks:install/)).toBeInTheDocument();
    });

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

      // The input carries `key={settings.linkBase}` (SettingsView.tsx) so it
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
      expect([...select.options].map((o) => o.value)).toEqual(['merge', 'branch']);

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
  describe('the Orchestrator group', () => {
    it('renders above the watchdog group', async () => {
      renderView();
      await screen.findByLabelText('Default question mode');
      const titles = groupTitles();
      const orchestrator = titles.indexOf('Orchestrator');
      const watchdog = titles.indexOf('Orchestrator watchdog');
      expect(orchestrator).toBeGreaterThanOrEqual(0);
      expect(watchdog).toBeGreaterThanOrEqual(0);
      expect(orchestrator).toBeLessThan(watchdog);
    });

    it('holds both orchestrate defaults, and the Agents group holds neither', async () => {
      renderView();
      await screen.findByLabelText('Default question mode');

      expect(rowNamesIn('Orchestrator')).toEqual(expect.arrayContaining(['Default merge mode', 'Default question mode']));

      const agents = rowNamesIn('Claude Agents');
      expect(agents).not.toContain('Default merge mode');
      expect(agents).toEqual(expect.arrayContaining(['Default model', 'Default effort']));
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
    it('opens on a band, not a card', async () => {
      renderView();
      await screen.findByText(/connected/);
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
    it('renders the same five groupings, each with its own scope', async () => {
      renderView();
      await screen.findByText(/connected/);
      expect(groupTitles()).toEqual(['Display', 'Board', 'Claude Agents', 'Orchestrator', 'Orchestrator watchdog']);
      expect(groupScopes()).toEqual(['this device', 'this device', 'this machine', 'this device', 'this server']);
    });

    /** And the same rows inside them — the three cards this file owns outright.
     *  `Theme` and `Setting it up` are rows without a `SettingsRow` wrapper and
     *  still carry `.set-name`, which is what makes them visible here. */
    it('groups the same rows it grouped before', async () => {
      renderView();
      await screen.findByText(/connected/);
      expect(rowNamesIn('Display')).toEqual(['Theme', 'Density', 'Text size', 'Opens on']);
      expect(rowNamesIn('Board')).toEqual(['Archive after']);
      expect(rowNamesIn('Claude Agents')).toEqual(['Dispatch', 'Default model', 'Default effort', 'Dashboard link']);
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
      const fromRow = /import \{([^}]*)\} from '\.\/SettingsRow'/.exec(src)?.[1] ?? '';
      expect(fromRow.split(',').map((n) => n.trim())).toEqual(['SettingsGroup', 'SettingsRow']);
      // No bare `<select>` left anywhere: the primitive is the one home for the
      // look, so a hand-rolled one is a second.
      expect(src).not.toMatch(/<select\b/);
    });

    /** `Segmented`'s pill variant, on every segmented row this page draws
     *  (§8.6's "the theme and density pickers take `Switch`'s pill shape"). */
    it('draws its segmented rows in the pill skin', async () => {
      renderView();
      await screen.findByText(/connected/);
      for (const label of ['Density', 'Text size', 'Archive after']) {
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
