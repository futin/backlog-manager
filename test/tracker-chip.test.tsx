/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { TrackerChip } from '../client/src/components/TrackerChip';
import { TrackersContext } from '../client/src/hooks/TrackersContext';
import type { TrackersState } from '../client/src/hooks/useTrackers';
import { useDialogEscape } from '../client/src/hooks/useDialogEscape';
import { accessReason, resetClock } from '../client/src/lib/tracker';
import type { Section } from '../client/src/lib/sections';
import type { TrackerPlatform, TrackerProjectRow, TrackersPayload } from '../shared/types';

/**
 * The zone every reading below is taken in (#241) — the global `TZ` pin (`test/helpers/global-setup.ts`), so the expected values written before the zone
 * became an argument still hold, and so a component mounted without `TimeZoneProvider` (whose default is the browser's zone) reads the same one.
 */
const ZONE = 'America/New_York';

/**
 * The GitHub status pill and its popover (spec §4.9; Shell mock). The context is provided directly rather than through a stubbed fetch: what this suite owns
 * is what the chip READS off a payload, and `use-trackers.test.tsx` owns how the payload arrives. Fake timers pin `useNow`'s one-second tick.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function platform(over: Partial<TrackerPlatform> = {}): TrackerPlatform {
  return { kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4930, reset: 1_790_000_000, ...over };
}

function row(over: Partial<TrackerProjectRow> = {}): TrackerProjectRow {
  return { name: 'alpha', path: '/abs/alpha', source: 'github', repo: 'futin/alpha', polledAt: ago(5_000), access: 'ok', detail: null, interval: null, connect: null, ...over };
}

const beta = (over: Partial<TrackerProjectRow> = {}) => row({ name: 'beta', path: '/abs/beta', repo: 'futin/beta', ...over });

function payload(rows: TrackerProjectRow[] = [row()], plat: TrackerPlatform = platform()): TrackersPayload {
  return { platforms: [plat], projects: rows };
}

let reload: jest.Mock;
let openSettings: jest.Mock;

function wrap(data: TrackersPayload | null, section: Section, extra?: React.ReactNode) {
  const value: TrackersState = { data, loading: false, error: false, reload, saveInterval: () => Promise.resolve(), refusals: {} };
  return (
    <TrackersContext.Provider value={value}>
      {extra}
      <TrackerChip section={section} onOpenSettings={openSettings} />
    </TrackersContext.Provider>
  );
}

function renderChip(data: TrackersPayload | null, section: Section = 'github') {
  const utils = render(wrap(data, section));
  return { ...utils, update: (next: TrackersPayload | null, nextSection: Section = section) => utils.rerender(wrap(next, nextSection)) };
}

const chip = () => screen.getByTestId('tracker-chip');

let user: ReturnType<typeof userEvent.setup>;
let fetchMock: jest.Mock;
let answer: (res: { ok: boolean; status: number; body: unknown }) => void;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  reload = jest.fn();
  openSettings = jest.fn();
  fetchMock = jest.fn(
    () =>
      new Promise((resolve) => {
        answer = ({ ok, status, body }) => resolve({ ok, status, json: () => Promise.resolve(body) });
      })
  );
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, 'fetch');
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

/** `useNarrow` reads `window.matchMedia`, which jsdom does not implement; the stub is the shape `ui-popover.test.tsx` uses. */
function stubNarrow(matches: boolean): void {
  const matchMedia = jest.fn().mockReturnValue({ matches, addEventListener: jest.fn(), removeEventListener: jest.fn() });
  Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });
}

const dotTone = () => chip().querySelector('.ui-status-dot')?.getAttribute('data-tone');

describe('the GitHub pill', () => {
  it('renders nothing when no project is a tracker', () => {
    const { update } = renderChip(payload([row({ source: 'files' })]));
    expect(screen.queryByTestId('tracker-chip')).toBeNull();
    update(null);
    expect(screen.queryByTestId('tracker-chip')).toBeNull();
  });

  it('draws the word GitHub and the newest poll’s age, named for a screen reader', () => {
    renderChip(payload([row({ polledAt: ago(20_000) }), beta({ polledAt: ago(12_000) })]));
    expect(within(chip()).getByText('GitHub')).toBeInTheDocument();
    expect(within(chip()).getByText('12 s')).toBeInTheDocument();
    expect(chip()).toHaveAccessibleName('GitHub: on time');
    expect(dotTone()).toBe('green');
  });

  it('moves the age on the tick and nothing else', () => {
    renderChip(payload());
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(chip()).toHaveAccessibleName('GitHub: on time');
    expect(within(chip()).getByText('6 s')).toBeInTheDocument();
  });

  it('keeps the button name identical across a one-second tick', () => {
    renderChip(payload());
    const before = chip().getAttribute('aria-label');
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(chip().getAttribute('aria-label')).toBe(before);
  });

  it('is amber and named late past twice the repo’s own interval', () => {
    const { update } = renderChip(payload([row({ polledAt: ago(31_000) })]));
    expect(dotTone()).toBe('amber');
    expect(chip()).toHaveAccessibleName('GitHub: late');
    // A 5m repo four minutes old is on time.
    update(payload([row({ interval: '5m', polledAt: ago(4 * 60_000) })]));
    expect(dotTone()).toBe('green');
  });

  it('is red and named down with no token, or when every repo is refused, and not when only some are', () => {
    const { update } = renderChip(payload([row()], platform({ hasToken: false, login: null })));
    expect(dotTone()).toBe('red');
    expect(chip()).toHaveAccessibleName('GitHub: down');
    update(payload([row({ access: 'forbidden' }), beta({ access: 'not-found' })]));
    expect(dotTone()).toBe('red');
    update(payload([row(), beta({ access: 'forbidden' })]));
    expect(dotTone()).toBe('green');
  });

  it('is amber while a repo is rate-limited, grey before anything has polled', () => {
    const { update } = renderChip(payload([row({ access: 'rate-limited' })]));
    expect(dotTone()).toBe('amber');
    update(payload([row({ polledAt: null })]));
    expect(dotTone()).toBe('grey');
    expect(chip()).toHaveAccessibleName('GitHub: not polled yet');
  });

  it('ignores an off repo when judging late', () => {
    renderChip(payload([row(), beta({ interval: 'off', polledAt: ago(86_400_000) })]));
    expect(dotTone()).toBe('green');
  });

  it('closes when the section changes', async () => {
    const { update } = renderChip(payload());
    await user.click(chip());
    update(payload(), 'runs');
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
  });
});

describe('the popover head', () => {
  it('shows the initials disc, login, connected · github.com, Sync now, and the two figures', async () => {
    renderChip(payload([row({ polledAt: ago(12_000) })]));
    await user.click(chip());
    const dialog = screen.getByRole('dialog', { name: 'Tracker' });
    expect(within(dialog).getByText('F')).toBeInTheDocument();
    expect(within(dialog).getByText('futin')).toBeInTheDocument();
    expect(within(dialog).getByText('connected · github.com')).toBeInTheDocument();
    expect(within(dialog).getByText('12 s ago · every 15s')).toBeInTheDocument();
    expect(within(dialog).getByText(`${(4930).toLocaleString()} of ${(5000).toLocaleString()} · resets ${resetClock(1_790_000_000, ZONE)}`)).toBeInTheDocument();
  });

  it('puts focus on Sync now', async () => {
    renderChip(payload());
    await user.click(chip());
    expect(screen.getByRole('button', { name: 'Sync now' })).toHaveFocus();
  });

  it('with no token: the sentence replaces the rows, and Sync now is disabled', async () => {
    renderChip(payload([row()], platform({ hasToken: false, login: null })));
    await user.click(chip());
    const dialog = screen.getByRole('dialog', { name: 'Tracker' });
    expect(dialog).toHaveTextContent('BM_GITHUB_TOKEN');
    expect(within(dialog).getByText('not connected · github.com')).toBeInTheDocument();
    expect(within(dialog).queryAllByTestId('tracker-row')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });

  it('draws one row per repo with `polled <age> ago`, a failing repo’s reason, and an off repo as sync off', async () => {
    const failing = beta({ access: 'forbidden', detail: 'x', polledAt: ago(90_000) });
    renderChip(payload([row({ polledAt: ago(12_000) }), failing, row({ name: 'gamma', path: '/abs/gamma', repo: 'futin/gamma', interval: 'off', polledAt: null }), row({ name: 'f', path: '/f', source: 'files', repo: null })]));
    await user.click(chip());
    const rows = screen.getAllByTestId('tracker-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('polled 12 s ago')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('polled 1m ago')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(accessReason(failing)!)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('not polled yet · sync off')).toBeInTheDocument();
  });

  it('a GitHub row whose repo did not resolve has its sync disabled, so no project name is posted', async () => {
    renderChip(payload([row({ name: 'unresolved', path: '/abs/u', repo: null })]));
    await user.click(chip());
    expect(screen.getByRole('button', { name: 'Sync unresolved' })).toBeDisabled();
  });

  it('a 409 survives a poll that changes nothing', async () => {
    const { update } = renderChip(payload());
    await user.click(chip());
    const syncNow = () => screen.getByRole('button', { name: 'Sync now' });
    await user.click(syncNow());
    await act(async () => answer({ ok: false, status: 409, body: { message: 'GitHub is not being polled' } }));
    update(payload());
    expect(syncNow()).toBeDisabled();
    expect(syncNow()).toHaveAttribute('title', 'GitHub is not being polled');
  });

  it('the setup link navigates to GitHub › Settings and closes the popover', async () => {
    renderChip(payload());
    await user.click(chip());
    await user.click(screen.getByRole('button', { name: /GitHub page/ }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
  });

  it('escapes the phone rail under 700 px, and is the plain desktop panel otherwise', async () => {
    stubNarrow(true);
    const { unmount } = renderChip(payload());
    await user.click(chip());
    expect(screen.getByRole('dialog', { name: 'Tracker' })).toHaveClass('ui-popover', 'ui-popover-narrow');
    unmount();
    stubNarrow(false);
    renderChip(payload());
    await user.click(chip());
    expect(screen.getByRole('dialog', { name: 'Tracker' })).not.toHaveClass('ui-popover-narrow');
  });

  it('closes on a pointerdown outside, stays open on one inside, and a second click of the pill closes it', async () => {
    renderChip(payload([row(), beta()]));
    await user.click(chip());
    fireEvent.pointerDown(screen.getAllByTestId('tracker-row')[0]!);
    expect(screen.getByRole('dialog', { name: 'Tracker' })).toBeInTheDocument();
    await user.click(chip());
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
    expect(chip()).toHaveAttribute('aria-expanded', 'false');
    await user.click(chip());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
  });

  it('gives Escape to the popover and not to a dialog beneath it, then hands it back', async () => {
    const closeBelow = jest.fn();
    function Below() {
      useDialogEscape(closeBelow);
      return null;
    }
    render(wrap(payload(), 'github', <Below />));
    await user.click(chip());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
    expect(closeBelow).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(closeBelow).toHaveBeenCalledTimes(1);
  });

  it('follows the payload while open', async () => {
    const { update } = renderChip(payload([row(), beta()]));
    await user.click(chip());
    update(payload([row()]));
    expect(within(screen.getByRole('dialog', { name: 'Tracker' })).getAllByTestId('tracker-row')).toHaveLength(1);
    update(payload([row()], platform({ hasToken: false, login: null })));
    expect(screen.getByRole('dialog', { name: 'Tracker' })).toHaveTextContent('BM_GITHUB_TOKEN');
  });
});

describe('Sync now and a row’s sync icon', () => {
  const syncNow = () => screen.getByRole('button', { name: 'Sync now' });

  it('posts once on a double click, is disabled while pending, then re-reads and shows the new age', async () => {
    const { update } = renderChip(payload());
    await user.click(chip());
    await user.dblClick(syncNow());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/github/sweep');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(syncNow()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync futin/alpha' })).toBeDisabled();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => answer({ ok: true, status: 200, body: {} }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(syncNow()).toBeEnabled();
    // The reload the context performs lands as a fresher payload, and the pill reads it.
    update(payload([row({ polledAt: ago(1_000) })]));
    expect(chip()).toHaveAccessibleName('GitHub: on time');
  });

  it('a row’s icon posts that repo and nothing else', async () => {
    renderChip(payload([row(), beta()]));
    await user.click(chip());
    await user.click(screen.getByRole('button', { name: 'Sync futin/beta' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ repo: 'futin/beta' });
    expect(within(screen.getAllByTestId('tracker-row')[1]!).getByText('syncing…')).toBeInTheDocument();
    await act(async () => answer({ ok: true, status: 200, body: {} }));
  });

  it('an off repo’s icon is disabled with the title `sync is off`', async () => {
    renderChip(payload([row({ interval: 'off' })]));
    await user.click(chip());
    const icon = screen.getByRole('button', { name: 'Sync futin/alpha' });
    expect(icon).toBeDisabled();
    expect(icon).toHaveAttribute('title', 'sync is off');
  });

  it('a 429 reads `GitHub asked to wait until HH:MM`, in the board’s zone', async () => {
    renderChip(payload());
    await user.click(chip());
    await user.click(syncNow());
    await act(async () => answer({ ok: false, status: 429, body: { message: 'rate limited', retryAt: '2026-09-18T12:05:00Z' } }));
    // 12:05 UTC is 08:05 in New York.
    expect(screen.getByText('GitHub asked to wait until 08:05')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(syncNow()).toBeEnabled();
  });

  it('a 409 disables the buttons and puts the server’s sentence in their title', async () => {
    renderChip(payload());
    await user.click(chip());
    await user.click(syncNow());
    await act(async () => answer({ ok: false, status: 409, body: { message: 'GitHub is not being polled' } }));
    expect(syncNow()).toBeDisabled();
    expect(syncNow()).toHaveAttribute('title', 'GitHub is not being polled');
    expect(screen.getByRole('button', { name: 'Sync futin/alpha' })).toBeDisabled();
  });

  it('survives the popover closing mid-sweep: still disabled when it opens again', async () => {
    renderChip(payload());
    await user.click(chip());
    await user.click(syncNow());
    await user.keyboard('{Escape}');
    await user.click(chip());
    expect(syncNow()).toBeDisabled();
    await act(async () => answer({ ok: true, status: 200, body: {} }));
  });
});
