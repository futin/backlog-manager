/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';
import { RUNS_MODE_KEY } from '../client/src/lib/runs-mode';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';

/*
  The shell opening on a deep link (`lib/deep-link.ts`): the URL's section wins over the stored section and a pinned landing, the Runs page follows it, both
  are recorded as a click would record them, and the parameters leave the address bar so a reload inside the app does not jump back.

  Board and Runs are stubbed, as `jira-sections.test.tsx` stubs its views: the subject is which section and which Runs page the shell picks. The Runs stub
  reads the real `useRunsMode`, so it shows the page the real view would.
*/
jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/runs/RunsView', () => ({
  __esModule: true,
  default: function RunsStub() {
    const [mode] = require('../client/src/hooks/useRunsMode').useRunsMode();
    return require('react').createElement('div', null, `runs stub: ${mode}`);
  }
}));

const SECTION_KEY = 'backlog-manager.section';
const stored = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SECTION_KEY, JSON.stringify('board'));
  localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('watchdog'));
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as Response)) as unknown as typeof fetch;
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('a deep link', () => {
  it('opens Runs › History over a stored Board and a stored Watchdog, records both, and leaves the address bar', async () => {
    window.history.replaceState(null, '', '/?section=runs&runs=history');
    render(<App />);
    expect(await screen.findByText('runs stub: runs')).toBeInTheDocument();
    expect(stored(SECTION_KEY)).toBe('runs');
    expect(stored(RUNS_MODE_KEY)).toBe('runs');
    expect(window.location.search).toBe('');
  });

  it('wins over a pinned landing', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'board' }));
    window.history.replaceState(null, '', '/?section=runs&runs=history');
    render(<App />);
    expect(await screen.findByText('runs stub: runs')).toBeInTheDocument();
  });

  it('applies a Settings scope through the settings the rail writes, and only beside the Settings section', async () => {
    window.history.replaceState(null, '', '/?section=settings&settings=shared');
    const first = render(<App />);
    await waitFor(() => expect((stored(SETTINGS_STORAGE_KEY) as { settingsScope?: string } | null)?.settingsScope).toBe('shared'));
    expect(window.location.search).toBe('');
    first.unmount();

    localStorage.clear();
    window.history.replaceState(null, '', '/?section=runs&settings=shared');
    render(<App />);
    expect(await screen.findByText('runs stub: runs')).toBeInTheDocument();
    expect((stored(SETTINGS_STORAGE_KEY) as { settingsScope?: string } | null)?.settingsScope ?? 'local').toBe('local');
  });

  it('applies the Dashboards scope the same way, so the Run on card’s Settings link lands on the machines page', async () => {
    window.history.replaceState(null, '', '/?section=settings&settings=dashboards');
    render(<App />);
    await waitFor(() => expect((stored(SETTINGS_STORAGE_KEY) as { settingsScope?: string } | null)?.settingsScope).toBe('dashboards'));
    expect(window.location.search).toBe('');
  });

  it('opens nothing special for an unknown section', async () => {
    window.history.replaceState(null, '', '/?section=nope');
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(stored(RUNS_MODE_KEY)).toBe('watchdog');
  });
});
