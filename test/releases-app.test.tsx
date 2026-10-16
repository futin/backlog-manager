/**
 * @jest-environment jsdom
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';
import { useReleases } from '../client/src/hooks/useReleases';
import { LAST_SEEN_KEY } from '../client/src/lib/releases';
import type { ReleasesResponse } from '../shared/types';

/*
  The version chip and the What's new drawer as the SHELL wires them (docs/subsystems/releases.md): `AppShell` owns `useReleases`, the unseen dot over
  `localStorage`, and the drawer, which it renders outside the rail. Through `<App />` because `AppShell` is unexported, with `nav.test.tsx`'s stubs for the
  two sections that would otherwise fetch, and a `fetch` routed by URL: `/api/releases` answers the fixture, every other route the empty answer `nav.test.tsx`
  gives Archive. The landing section is Board, stubbed, so nothing else on screen fetches anything that matters.
*/

jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/settings/SettingsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'settings stub')
}));

const FIXTURE: ReleasesResponse = {
  current: { version: '0.2.1', ahead: 0 },
  releases: [
    { version: '0.2.1', date: '2026-10-16T12:00:00+00:00', title: 'fix(api)!: tighten', type: 'fix', scope: 'api', pr: 13, breaking: true, notes: '' },
    {
      version: '0.2.0',
      date: '2026-10-15T12:00:00+00:00',
      title: 'feat(releases): version chip',
      type: 'feat',
      scope: 'releases',
      pr: 12,
      url: 'https://github.com/futin/backlog-manager/pull/12',
      breaking: false,
      notes: '- Shows the running version'
    },
    { version: '0.1.0', date: '2026-10-14T12:00:00+00:00', title: 'Baseline — versioning starts here', type: 'baseline', breaking: false, notes: '' }
  ]
};

let releases: ReleasesResponse;
let releaseCalls: number;

function routedFetch(): jest.Mock {
  return jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/releases')) {
      releaseCalls += 1;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(releases) } as Response);
    }
    const payload = url.includes('/api/orchestrator/runs') ? { runs: [], starting: [], remote: [] } : url.includes('/api/projects') ? [] : { items: [], errors: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
}

const realFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  releases = FIXTURE;
  releaseCalls = 0;
  global.fetch = routedFetch();
});

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

const chip = (): HTMLElement | null => screen.queryByRole('button', { name: /v0\.2\.1/ });
const dot = (): Element | null => document.querySelector('.rail-release-dot');

describe('the version chip in the shell', () => {
  it('dots a release newer than the one stored, opens the drawer on a click, re-reads, and marks the newest seen', async () => {
    localStorage.setItem(LAST_SEEN_KEY, '0.1.0');
    render(<App />);
    await waitFor(() => expect(chip()).toBeInTheDocument());
    expect(dot()).not.toBeNull();

    await userEvent.click(chip() as HTMLElement);
    expect(await screen.findByRole('dialog', { name: "What's new" })).toBeInTheDocument();
    await waitFor(() => expect(releaseCalls).toBe(2));
    await waitFor(() => expect(localStorage.getItem(LAST_SEEN_KEY)).toBe('0.2.1'));
    expect(dot()).toBeNull();
  });

  it('opened on a checkout older than the one last seen, keeps the higher stored version', async () => {
    localStorage.setItem(LAST_SEEN_KEY, '0.3.0');
    render(<App />);
    await waitFor(() => expect(chip()).toBeInTheDocument());
    expect(dot()).toBeNull();

    await userEvent.click(chip() as HTMLElement);
    expect(await screen.findByRole('dialog', { name: "What's new" })).toBeInTheDocument();
    await waitFor(() => expect(releaseCalls).toBe(2));
    expect(localStorage.getItem(LAST_SEEN_KEY)).toBe('0.3.0');
  });

  it('seeds a first visit with the newest, and draws no dot', async () => {
    render(<App />);
    await waitFor(() => expect(chip()).toBeInTheDocument());
    await waitFor(() => expect(localStorage.getItem(LAST_SEEN_KEY)).toBe('0.2.1'));
    expect(dot()).toBeNull();
  });

  it('draws no dot when storage throws on every call, and the chip still opens the drawer', async () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<App />);
    await waitFor(() => expect(chip()).toBeInTheDocument());
    expect(dot()).toBeNull();
    await userEvent.click(chip() as HTMLElement);
    expect(await screen.findByRole('dialog', { name: "What's new" })).toBeInTheDocument();
  });

  it('closes the drawer on Escape', async () => {
    render(<App />);
    await waitFor(() => expect(chip()).toBeInTheDocument());
    await userEvent.click(chip() as HTMLElement);
    await screen.findByRole('dialog', { name: "What's new" });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "What's new" })).not.toBeInTheDocument());
  });

  it('draws no chip when the checkout has no version', async () => {
    releases = { current: null, releases: FIXTURE.releases };
    render(<App />);
    await waitFor(() => expect(releaseCalls).toBe(1));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /^v\d/ })).toBeNull();
  });
});

describe('useReleases', () => {
  it('fetches once on mount and once per refresh, with no timer', async () => {
    const { result } = renderHook(() => useReleases());
    await waitFor(() => expect(result.current.data).toEqual(FIXTURE));
    expect(releaseCalls).toBe(1);
    act(() => result.current.refresh());
    await waitFor(() => expect(releaseCalls).toBe(2));
  });

  it('keeps the previous data when a fetch fails', async () => {
    const { result } = renderHook(() => useReleases());
    await waitFor(() => expect(result.current.data).toEqual(FIXTURE));
    global.fetch = jest.fn(() => Promise.reject(new Error('down'))) as jest.Mock;
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.data).toEqual(FIXTURE);
  });

  it('reads an answer that is not the releases shape as nothing', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) } as Response)) as jest.Mock;
    const { result } = renderHook(() => useReleases());
    await act(async () => {});
    expect(result.current.data).toBeNull();
  });
});
