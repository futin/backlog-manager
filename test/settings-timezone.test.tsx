/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import SettingsView from '../client/src/components/settings/SettingsView';
import { TimeZoneGroup } from '../client/src/components/settings/TimeZoneGroup';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { TimeZoneProvider } from '../client/src/hooks/TimeZoneContext';
import { TrackersProvider } from '../client/src/hooks/TrackersContext';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';
import { browserTimeZone } from '../client/src/lib/time-zone';
import type { AgentsStatus, TimeZoneSetting } from '../shared/types';

/**
 * #241's Settings card: `Time zone` on the Shared page — one Select over the platform's zones, its first option "unset", writing
 * `POST /api/settings/timezone` through `TimeZoneProvider`. The card is rendered bare (inside its provider) for the control, and through `SettingsView` only
 * for the question that is about the page.
 */

const AGENTS_STATUS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: []
};

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
}

/** `GET /api/settings/timezone` answers `get`; its POST answers `post(body)` — by default echoing the body, as the server does for a canonical id. Anything
 *  else is the agents status, which is all `SettingsView`'s other cards need to mount quietly. */
function stubFetch(opts: { get: TimeZoneSetting; post?: (body: TimeZoneSetting) => { status: number; body: unknown } }): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/settings/timezone')) {
      if (init?.method === 'POST') {
        const answer = (opts.post ?? ((b) => ({ status: 200, body: b })))(JSON.parse(String(init.body ?? '{}')));
        return respond(answer.status, answer.body);
      }
      return respond(200, opts.get);
    }
    return respond(200, AGENTS_STATUS);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const posts = (fn: jest.Mock) =>
  fn.mock.calls.filter(([url, init]) => String(url).endsWith('/api/settings/timezone') && (init as RequestInit)?.method === 'POST');

function renderCard() {
  render(
    <TimeZoneProvider>
      <TimeZoneGroup />
    </TimeZoneProvider>
  );
}

describe('TimeZoneGroup', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('reads "Each browser\'s own (…)" while the server holds no zone', async () => {
    const fn = stubFetch({ get: { timeZone: null } });
    renderCard();

    const select = (await screen.findByRole('combobox', { name: 'Time zone' })) as HTMLSelectElement;
    await waitFor(() => expect(fn.mock.calls.some(([url]) => String(url).endsWith('/api/settings/timezone'))).toBe(true));
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]).toHaveTextContent(`Each browser's own (${browserTimeZone()})`);
    expect(document.querySelector('.ui-sheet-title')).toHaveTextContent('Time zone');
    expect(document.querySelector('.ui-sheet-sub')).toHaveTextContent('this server');
    expect([...select.options].map((o) => o.value)).toEqual(expect.arrayContaining(['', 'UTC', 'Europe/Belgrade']));
  });

  it('posts exactly {"timeZone":"Europe/Belgrade"} and shows the answer', async () => {
    const fn = stubFetch({ get: { timeZone: null } });
    renderCard();

    const select = (await screen.findByRole('combobox', { name: 'Time zone' })) as HTMLSelectElement;
    await userEvent.selectOptions(select, 'Europe/Belgrade');

    await waitFor(() => expect(select.value).toBe('Europe/Belgrade'));
    expect(posts(fn)).toHaveLength(1);
    expect(String((posts(fn)[0][1] as RequestInit).body)).toBe('{"timeZone":"Europe/Belgrade"}');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('posts {"timeZone":null} for the first option', async () => {
    const fn = stubFetch({ get: { timeZone: 'Europe/Belgrade' } });
    renderCard();

    const select = (await screen.findByRole('combobox', { name: 'Time zone' })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('Europe/Belgrade'));
    await userEvent.selectOptions(select, '');

    await waitFor(() => expect(select.value).toBe(''));
    expect(posts(fn)).toHaveLength(1);
    expect(String((posts(fn)[0][1] as RequestInit).body)).toBe('{"timeZone":null}');
  });

  it('shows the refusal and keeps the server value on a 400', async () => {
    stubFetch({ get: { timeZone: 'UTC' }, post: () => ({ status: 400, body: { error: 'boom' } }) });
    renderCard();

    const select = (await screen.findByRole('combobox', { name: 'Time zone' })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('UTC'));
    await userEvent.selectOptions(select, 'Europe/Belgrade');

    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved — boom');
    expect(select.value).toBe('UTC');
  });

  it('keeps a stored zone this browser does not list selectable, rather than reading as the first option', async () => {
    stubFetch({ get: { timeZone: 'Mars/Olympus' } });
    renderCard();

    const select = (await screen.findByRole('combobox', { name: 'Time zone' })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('Mars/Olympus'));
  });
});

describe('the Time zone card, by page', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  function renderView(scope: 'local' | 'shared') {
    if (scope === 'shared') localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ settingsScope: 'shared' }));
    render(
      <SettingsProvider>
        <TrackersProvider>
          <TimeZoneProvider>
            <SettingsView />
          </TimeZoneProvider>
        </TrackersProvider>
      </SettingsProvider>
    );
  }

  const titles = () => [...document.querySelectorAll('.set-group .ui-sheet-title')].map((el) => el.textContent);

  it('is on Shared, under the tick breaker', async () => {
    stubFetch({ get: { timeZone: null } });
    renderView('shared');
    await screen.findByRole('combobox', { name: 'Time zone' });

    expect(titles().indexOf('Time zone')).toBe(titles().indexOf('Backlog tick') + 1);
  });

  it('is not on Local', async () => {
    stubFetch({ get: { timeZone: null } });
    renderView('local');

    expect(titles()).not.toContain('Time zone');
    expect(screen.queryByRole('combobox', { name: 'Time zone' })).toBeNull();
  });
});
