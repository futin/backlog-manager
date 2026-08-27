/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
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

  it('has no bionic reading rows', () => {
    renderView();
    expect(screen.queryByText(/Bionic/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fixation/)).not.toBeInTheDocument();
  });

  it('changes density and text size', async () => {
    renderView();
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
    await userEvent.click(screen.getByRole('button', { name: '120%' }));
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
  });

  it('offers Projects as a landing choice', async () => {
    renderView();
    await userEvent.selectOptions(screen.getByLabelText('Opens on'), 'projects');
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.landing).toBe('projects');
  });

  // Nested (rather than a sibling top-level describe) so these cases can use
  // the `renderView()` closure above: outside a `SettingsProvider`,
  // `useSettings()` falls back to `DEFAULT_SETTINGS` with a no-op `update`
  // (see the last lines of client/src/hooks/useSettings.tsx) and never
  // touches localStorage at all, so a bare `render(<SettingsView />)` could
  // never observe the edited-link case below.
  describe('the Claude Agents group', () => {
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
      await userEvent.type(field, 'https://box.ts.net:5174');
      await userEvent.tab();
      expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase)
        .toBe('https://box.ts.net:5174');

      await userEvent.clear(field);
      await userEvent.type(field, 'javascript:alert(1)');
      await userEvent.tab();
      expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase)
        .toBe('http://127.0.0.1:5174');
    });
  });
});
