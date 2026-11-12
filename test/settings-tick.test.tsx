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
import { NoGitlab } from './helpers/no-gitlab';

/**
 * Task 7 of the tick breaker: the `Backlog tick` card on Settings' Shared page — `haltAfter` 1–10, and since #378 the two tick caps `maxPlans` and `maxPrs`,
 * each its own 1–10 Select, over `useTicks({ live: false })`. The card is rendered bare for everything about the controls, and through `SettingsView` only for
 * the one question that is about the page (Shared and not Local).
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
  return { config: { haltAfter, maxPlans: 3, maxPrs: 2, source: 'file', ...over }, projects: [] };
}

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
}

/** `GET /api/ticks` answers `get`; `POST /api/ticks/config` answers `post(body)`. Anything else is the agents status, which is all `SettingsView`'s other
 *  cards need to mount quietly. */
function stubFetch(opts: { get: TicksPayload | 'reject'; post?: (body: { haltAfter?: number }) => { status: number; body: unknown } }): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/ticks/config')) {
      const answer = (opts.post ?? ((b) => ({ status: 200, body: payload(b.haltAfter ?? 3) })))(JSON.parse(String(init?.body ?? '{}')));
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

    const halt = await screen.findByLabelText('Halt after');
    await waitFor(() => expect(halt.textContent).toBe('4'));
    expect(document.querySelector('.ui-sheet-title')).toHaveTextContent('Backlog tick');
    expect(document.querySelector('.ui-pill-neutral')).toHaveTextContent('this machine');
    expect(screen.getByText('failures in a row')).toBeInTheDocument();
    expect(screen.getByText('A halted project stops ticking until reset on Runs › Ticks.')).toBeInTheDocument();
    // 1 through 10, nothing else: the bounds the server clamps to, so no press can be quietly corrected — the stepper stops at both ends.
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByRole('button', { name: 'Increase Halt after' })).toBeEnabled();
  });

  it('posts {haltAfter: 4} once from `Increase Halt after` and shows the answer, not the press', async () => {
    // The server answers 6, not 4: the stepper must redraw from the POST's own answer.
    const fn = stubFetch({ get: payload(3), post: () => ({ status: 200, body: payload(6) }) });
    render(<TickGroup />);

    const halt = await screen.findByLabelText('Halt after');
    await waitFor(() => expect(halt.textContent).toBe('3'));
    await userEvent.click(screen.getByRole('button', { name: 'Increase Halt after' }));

    await waitFor(() => expect(screen.getByLabelText('Halt after').textContent).toBe('6'));
    expect(posts(fn)).toHaveLength(1);
    expect(posts(fn)[0][0]).toBe('/api/ticks/config');
    expect(JSON.parse(String((posts(fn)[0][1] as RequestInit).body))).toEqual({ haltAfter: 4 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws the two caps beside Halt after, each showing the payload value', async () => {
    stubFetch({ get: payload(3, { maxPlans: 4, maxPrs: 6 }) });
    render(<TickGroup />);

    const plans = await screen.findByLabelText('Plans awaiting review');
    await waitFor(() => expect(plans.textContent).toBe('4'));
    expect(screen.getByLabelText('Open execute PRs').textContent).toBe('6');
    // Each hint names the job flag that still wins over the setting.
    expect(screen.getByText('--max-plans')).toBeInTheDocument();
    expect(screen.getByText('--max-prs')).toBeInTheDocument();
  });

  it('posts {maxPlans: 4} once — only the key that was picked — and shows the answer', async () => {
    const fn = stubFetch({ get: payload(3), post: () => ({ status: 200, body: payload(3, { maxPlans: 5 }) }) });
    render(<TickGroup />);

    const plans = await screen.findByLabelText('Plans awaiting review');
    await waitFor(() => expect(plans.textContent).toBe('3'));
    await userEvent.click(screen.getByRole('button', { name: 'Increase Plans awaiting review' }));

    await waitFor(() => expect(screen.getByLabelText('Plans awaiting review').textContent).toBe('5'));
    expect(posts(fn)).toHaveLength(1);
    expect(JSON.parse(String((posts(fn)[0][1] as RequestInit).body))).toEqual({ maxPlans: 4 });
  });

  it('posts {maxPrs: 3} from `Increase Open execute PRs`', async () => {
    const fn = stubFetch({ get: payload(3), post: () => ({ status: 200, body: payload(3, { maxPrs: 4 }) }) });
    render(<TickGroup />);

    const prs = await screen.findByLabelText('Open execute PRs');
    await waitFor(() => expect(prs.textContent).toBe('2'));
    await userEvent.click(screen.getByRole('button', { name: 'Increase Open execute PRs' }));

    await waitFor(() => expect(screen.getByLabelText('Open execute PRs').textContent).toBe('4'));
    expect(JSON.parse(String((posts(fn)[0][1] as RequestInit).body))).toEqual({ maxPrs: 3 });
  });

  it('shows the refusal and keeps every old value on a 409', async () => {
    stubFetch({ get: payload(3), post: () => ({ status: 409, body: { error: 'tick.json unreadable' } }) });
    render(<TickGroup />);

    const halt = await screen.findByLabelText('Halt after');
    await waitFor(() => expect(halt.textContent).toBe('3'));
    await userEvent.click(screen.getByRole('button', { name: 'Increase Plans awaiting review' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved — tick.json unreadable');
    expect(['Halt after', 'Plans awaiting review', 'Open execute PRs'].map((l) => screen.getByLabelText(l).textContent)).toEqual(['3', '3', '2']);
  });

  it('disables every stepper and names the file when tick.json is unreadable', async () => {
    // The shape the server sends since fix round 1: `<path>: <reason>`.
    stubFetch({ get: payload(3, { source: 'unreadable', error: '/home/me/.backlog-manager/settings/tick.json: Unexpected token } in JSON at position 12' }) });
    render(<TickGroup />);

    await screen.findByLabelText('Halt after');
    // All three go together: the server refuses every write to an unreadable file, so no control may offer one — both buttons of each stepper are off.
    for (const l of ['Halt after', 'Plans awaiting review', 'Open execute PRs']) {
      expect(screen.getByRole('button', { name: `Increase ${l}` })).toBeDisabled();
      expect(screen.getByRole('button', { name: `Decrease ${l}` })).toBeDisabled();
    }
    expect(
      screen.getByText('/home/me/.backlog-manager/settings/tick.json: Unexpected token } in JSON at position 12 — fix or remove the file by hand.')
    ).toBeInTheDocument();
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
          <NoGitlab><SettingsView /></NoGitlab>
        </TrackersProvider>
      </SettingsProvider>
    );
  }

  const titles = () => [...document.querySelectorAll('.set-group .ui-sheet-title')].map((el) => el.textContent);

  it('is on Shared, under the watchdog', async () => {
    stubFetch({ get: payload(3) });
    renderView('shared');
    await screen.findByLabelText('Halt after');

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
