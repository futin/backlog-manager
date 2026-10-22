/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import SettingsView from '../client/src/components/settings/SettingsView';
import { TickGroup } from '../client/src/components/settings/TickGroup';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { TrackersProvider } from '../client/src/hooks/TrackersContext';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';
import type { AgentsStatus, TicksPayload } from '../shared/types';

/**
 * Task 7 of the tick breaker: the `Backlog tick` card on Settings' Shared page — one Select, `haltAfter` 1–10, over `useTicks({ live: false })`. The card is
 * rendered bare for everything about the control, and through `SettingsView` only for the one question that is about the page (Shared and not Local).
 */

const AGENTS_STATUS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: []
};

function payload(haltAfter: number, over: Partial<TicksPayload['config']> = {}): TicksPayload {
  return { config: { haltAfter, source: 'file', ...over }, projects: [] };
}

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
}

/** `GET /api/ticks` answers `get`; `POST /api/ticks/config` answers `post(body)`. Anything else is the agents status, which is all `SettingsView`'s other
 *  cards need to mount quietly. */
function stubFetch(opts: { get: TicksPayload | 'reject'; post?: (body: { haltAfter: number }) => { status: number; body: unknown } }): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/ticks/config')) {
      const answer = (opts.post ?? ((b) => ({ status: 200, body: payload(b.haltAfter) })))(JSON.parse(String(init?.body ?? '{}')));
      return respond(answer.status, answer.body);
    }
    if (url.endsWith('/api/ticks')) return opts.get === 'reject' ? Promise.reject(new Error('ticks unreachable')) : respond(200, opts.get);
    return respond(200, AGENTS_STATUS);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const posts = (fn: jest.Mock) => fn.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

describe('TickGroup', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('titles the card Backlog tick, scoped to this machine, and shows the payload value', async () => {
    stubFetch({ get: payload(4) });
    render(<TickGroup />);

    const select = (await screen.findByRole('combobox', { name: 'Halt after' })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('4'));
    expect(document.querySelector('.ui-sheet-title')).toHaveTextContent('Backlog tick');
    expect(document.querySelector('.ui-sheet-sub')).toHaveTextContent('this machine');
    expect(screen.getByText('failures in a row')).toBeInTheDocument();
    expect(screen.getByText('A halted project stops ticking until reset on Runs › Ticks.')).toBeInTheDocument();
    // 1 through 10, nothing else: the bounds the server clamps to, so no pick can be quietly corrected.
    expect([...select.options].map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(select).toBeEnabled();
  });

  it('posts {haltAfter: 5} once and shows the answer, not the pick', async () => {
    // The server answers 6, not 5: the select must redraw from the POST's own answer.
    const fn = stubFetch({ get: payload(3), post: () => ({ status: 200, body: payload(6) }) });
    render(<TickGroup />);

    const select = (await screen.findByRole('combobox', { name: 'Halt after' })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('3'));
    await userEvent.selectOptions(select, '5');

    await waitFor(() => expect(select.value).toBe('6'));
    expect(posts(fn)).toHaveLength(1);
    expect(posts(fn)[0][0]).toBe('/api/ticks/config');
    expect(JSON.parse(String((posts(fn)[0][1] as RequestInit).body))).toEqual({ haltAfter: 5 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the refusal and keeps the old value on a 409', async () => {
    stubFetch({ get: payload(3), post: () => ({ status: 409, body: { error: 'tick.json unreadable' } }) });
    render(<TickGroup />);

    const select = (await screen.findByRole('combobox', { name: 'Halt after' })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('3'));
    await userEvent.selectOptions(select, '5');

    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved — tick.json unreadable');
    expect(select.value).toBe('3');
  });

  it('disables the Select and names the file when tick.json is unreadable', async () => {
    stubFetch({ get: payload(3, { source: 'unreadable', error: '/home/me/.backlog-manager/settings/tick.json unreadable' }) });
    render(<TickGroup />);

    const select = await screen.findByRole('combobox', { name: 'Halt after' });
    expect(select).toBeDisabled();
    expect(screen.getByText('/home/me/.backlog-manager/settings/tick.json unreadable — fix or remove the file by hand.')).toBeInTheDocument();
    // The ordinary hint is replaced, not stacked beside it.
    expect(screen.queryByText(/A halted project stops ticking/)).toBeNull();
  });

  it('says it is unavailable, and draws no control, while the API has not answered', async () => {
    stubFetch({ get: 'reject' });
    render(<TickGroup />);

    expect(await screen.findByText(/Could not reach the tick settings — ticks unreachable/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('the Backlog tick card, by page', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  function renderView(scope: 'local' | 'shared') {
    if (scope === 'shared') localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ settingsScope: 'shared' }));
    render(
      <SettingsProvider>
        <TrackersProvider>
          <SettingsView />
        </TrackersProvider>
      </SettingsProvider>
    );
  }

  const titles = () => [...document.querySelectorAll('.set-group .ui-sheet-title')].map((el) => el.textContent);

  it('is on Shared, under the watchdog', async () => {
    stubFetch({ get: payload(3) });
    renderView('shared');
    await screen.findByRole('combobox', { name: 'Halt after' });
    // Settle the Agents card's own fetch too (as `settings-view.test.tsx` does), so its state update lands inside act().
    await screen.findByText(/connected/);

    expect(titles()).toContain('Backlog tick');
    expect(titles().indexOf('Backlog tick')).toBe(titles().indexOf('Orchestrator watchdog') + 1);
  });

  it('is not on Local, and Local never asks for ticks', async () => {
    const fn = stubFetch({ get: payload(3) });
    renderView('local');

    expect(titles()).not.toContain('Backlog tick');
    expect(screen.queryByRole('combobox', { name: 'Halt after' })).toBeNull();
    expect(fn.mock.calls.some(([url]) => String(url).endsWith('/api/ticks'))).toBe(false);
  });
});
