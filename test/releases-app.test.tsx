/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';
import type { ReleasesResponse } from '../shared/types';

/*
  The version chip and the What's new drawer as the SHELL wires them (docs/subsystems/releases.md): `AppShell` owns ui-kit's `useWhatsNew` under this
  board's own storage key, and the drawer, which it renders outside the rail. The hook's own behaviour — no timer, a failed or malformed read keeping the
  last answer — is ui-kit's suite's; what is here is that the shell passes the key this board always used and wires the chip and the drawer to it.
  Through `<App />` because `AppShell` is unexported, with `nav.test.tsx`'s stubs for the two sections that would otherwise fetch, and a `fetch` routed by
  URL: `/api/releases` answers the fixture, every other route the empty answer `nav.test.tsx` gives Archive. The landing section is Board, stubbed, so
  nothing else on screen fetches anything that matters.
*/

/* The key as a literal, not `App`'s constant: what must not change is the string every existing browser already holds (spec D17), and a test reading the
   constant back would follow a rename and stay green while every viewer's dot reset. */
const LAST_SEEN_KEY = 'backlog-manager.releases-last-seen';

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
    const payload = url.includes('/api/orchestrator/runs') ? { runs: [], starting: [], remote: [], remoteStarting: [] } : url.includes('/api/projects') ? [] : { items: [], errors: [] };
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
const dot = (): Element | null => document.querySelector('.uk-chip-dot');

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
    expect(screen.queryByRole('button', { name: /What's new/ })).toBeNull();
  });
});
