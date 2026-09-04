/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

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
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: []
};

describe('SettingsView', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(DEFAULT_AGENTS_STATUS)
    } as Response)) as jest.Mock;
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
    // test/drawer.test.tsx's identical fix for ItemDrawer's body fetch: wait
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
    expect(within(picker).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Last used', 'Board', 'Runs', 'Archive', 'Settings']);

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
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({
          enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
          spawnMaxPermission: 'auto', projectPaths: ['/a', '/b']
        })
      } as Response)) as jest.Mock;

      renderView();
      expect(await screen.findByText(/connected/)).toBeInTheDocument();
      expect(screen.getByText(/ceiling: auto/)).toBeInTheDocument();
      expect(screen.getByText(/2 projects/)).toBeInTheDocument();
      // No setup steps when everything is green — the panel should not nag.
      expect(screen.queryByText(/BM_AGENTS=on/)).not.toBeInTheDocument();
    });

    it('shows the setup steps when dispatch is off', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({
          enabled: false, reachable: false, remoteAnswer: false, spawnAvailable: false,
          spawnMaxPermission: null, projectPaths: []
        })
      } as Response)) as jest.Mock;

      renderView();
      expect(await screen.findByText(/BM_AGENTS=on/)).toBeInTheDocument();
      expect(screen.getByText(/hooks:install/)).toBeInTheDocument();
    });

    it('stores an edited dashboard link and refuses a bad scheme', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({
          enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
          spawnMaxPermission: 'auto', projectPaths: []
        })
      } as Response)) as jest.Mock;

      renderView();
      const field = await screen.findByLabelText('Dashboard link');
      await userEvent.clear(field);
      await userEvent.type(field, 'https://box.ts.net:5174/');
      await userEvent.tab();
      expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase)
        .toBe('https://box.ts.net:5174');

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
      expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase)
        .toBe('http://127.0.0.1:5174');

      // Same guarantee on the refusal path: storage falls back to the
      // default, and the box must show that fallback too — not the
      // rejected text it was last typed, with nothing on screen to say it
      // was refused.
      const fieldAfterRefusal = screen.getByLabelText('Dashboard link');
      expect(fieldAfterRefusal).toHaveValue('http://127.0.0.1:5174');
    });

    it('offers a default model and effort, both starting on the CLI default', async () => {
      renderView();
      const model = await screen.findByLabelText('Default model') as HTMLSelectElement;
      const effort = screen.getByLabelText('Default effort') as HTMLSelectElement;
      expect(model.value).toBe('');
      expect(effort.value).toBe('');
      expect([...model.options].map((o) => o.textContent))
        .toEqual(['CLI default', 'opus', 'sonnet', 'haiku', 'fable']);
      expect([...effort.options].map((o) => o.textContent))
        .toEqual(['CLI default', 'low', 'medium', 'high', 'xhigh', 'max']);
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
      const select = await screen.findByLabelText('Default merge mode') as HTMLSelectElement;
      expect(select.value).toBe('merge');
      expect([...select.options].map((o) => o.value)).toEqual(['merge', 'branch']);

      await userEvent.selectOptions(select, 'branch');
      const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
      expect(stored.orchestrateDefaultMergeMode).toBe('branch');
    });
  });
});
