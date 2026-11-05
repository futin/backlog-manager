/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';
import { JiraChip } from '../client/src/components/JiraChip';
import { JiraContext } from '../client/src/hooks/JiraContext';
import type { JiraState } from '../client/src/hooks/useJira';
import { NARROW_QUERY } from '../client/src/hooks/useNarrow';
import { accessPhrase } from '../client/src/lib/jira';
import type { Section } from '../client/src/lib/sections';
import type { JiraBoardStatus, JiraStatusPayload } from '../shared/types';

/**
 * The Jira chip and its popover (Jira phase 2; spec §6.5; DESIGN.md §8.9.4). The context is provided directly, as `tracker-chip.test.tsx` does for
 * its own: what this suite owns is what the chip READS off a status payload, and `use-jira.test.tsx` owns how the payload arrives. The two home cases at the
 * bottom mount the real `App` instead, because "one chip in exactly one home" is a fact about the shell. Fake timers pin `useNow`'s one-second tick.
 */
jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/settings/SettingsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'settings stub')
}));

const NOW = Date.parse('2026-09-18T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function board(over: Partial<JiraBoardStatus> = {}): JiraBoardStatus {
  return { id: 'b_00000001', name: 'Platform', roots: ['PLAT-1'], queries: [], interval: '1m', polledAt: ago(5_000), count: 4, truncated: false, failures: [], ...over };
}

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: { accountId: 'a1', name: 'Ada Lovelace' },
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [board()],
    repos: {},
    repoDefaults: {},
    projects: [],
    skills: [],
    calls: { sweep: 12, last429At: null },
    live: {},
    armed: true,
    home: '/home/x',
    ...over
  };
}

let openSetup: jest.Mock;
let reloadMock: jest.Mock;

function wrap(data: JiraStatusPayload | null, section: Section) {
  const value: JiraState = { data, loading: false, error: false, reload: reloadMock };
  return (
    <JiraContext.Provider value={value}>
      <JiraChip section={section} onOpenSetup={openSetup} />
    </JiraContext.Provider>
  );
}

function renderChip(data: JiraStatusPayload | null, section: Section = 'github') {
  const utils = render(wrap(data, section));
  return { ...utils, update: (next: JiraStatusPayload | null, nextSection: Section = section) => utils.rerender(wrap(next, nextSection)) };
}

const chip = () => screen.getByTestId('jira-chip');
const dotTone = () => chip().querySelector('.ui-status-dot')?.getAttribute('data-tone');

let user: ReturnType<typeof userEvent.setup>;
let fetchMock: jest.Mock;
let answer: (res: { ok: boolean; status: number; body: unknown }) => void;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  openSetup = jest.fn();
  reloadMock = jest.fn();
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
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

describe('the Jira pill', () => {
  it('draws nothing while Jira is unconfigured, or before the first answer', () => {
    const { update } = renderChip(status({ configured: false, site: null, me: null, access: 'unconfigured', boards: [] }));
    expect(screen.queryByTestId('jira-chip')).toBeNull();
    update(null);
    expect(screen.queryByTestId('jira-chip')).toBeNull();
    update(status());
    expect(chip()).toBeInTheDocument();
  });

  it('draws the word Jira and the newest age, named for a screen reader', () => {
    renderChip(status({ boards: [board({ polledAt: ago(20_000) }), board({ id: 'b_00000002', name: 'Growth', polledAt: ago(5_000) })] }));
    expect(within(chip()).getByText('Jira')).toBeInTheDocument();
    expect(within(chip()).getByText('5 s')).toBeInTheDocument();
    expect(chip()).toHaveAccessibleName('Jira: on time');
    expect(dotTone()).toBe('green');
  });

  it('is red and named down while access is not ok or rate-limited', () => {
    const { update } = renderChip(status({ access: 'unauthorized' }));
    expect(dotTone()).toBe('red');
    expect(chip()).toHaveAccessibleName('Jira: down');
    update(status({ access: 'ok' }));
    expect(dotTone()).toBe('green');
  });

  it('is amber while rate-limited, and past twice a board’s own interval; a 5m board four minutes old is on time', () => {
    const { update } = renderChip(status({ access: 'rate-limited' }));
    expect(dotTone()).toBe('amber');
    update(status({ boards: [board({ interval: '1m', polledAt: ago(121_000) })] }));
    expect(dotTone()).toBe('amber');
    update(status({ boards: [board({ interval: '5m', polledAt: ago(4 * 60_000) }), board({ id: 'b_00000002', name: 'Growth', interval: '15s', polledAt: ago(31_000) })] }));
    expect(dotTone()).toBe('amber');
    update(status({ boards: [board({ interval: '5m', polledAt: ago(4 * 60_000) })] }));
    expect(dotTone()).toBe('green');
  });

  it('is grey with nothing polled, and ignores off boards', () => {
    const { update } = renderChip(status({ boards: [board({ polledAt: null })] }));
    expect(dotTone()).toBe('grey');
    update(status({ boards: [board({ interval: 'off', polledAt: ago(86_400_000) }), board({ id: 'b_00000002', name: 'Growth', polledAt: ago(5_000) })] }));
    expect(dotTone()).toBe('green');
  });

  it('closes on Escape and on a change of section', async () => {
    const { update } = renderChip(status());
    await user.click(chip());
    expect(screen.getByRole('dialog', { name: 'Jira' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(chip());
    update(status(), 'runs');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the popover', () => {
  const syncNow = () => screen.getByRole('button', { name: 'Sync now' });
  const rowOf = (name: string) => screen.getAllByTestId('jira-chip-board').find((r) => r.querySelector('.tracker-row-name')?.textContent === name) as HTMLElement;

  it('shows the disc, name, connected · site, the two figures, and a row per board with Jira’s own failure', async () => {
    renderChip(
      status({
        access: 'rate-limited',
        detail: 'Retry-After 60',
        calls: { sweep: 12, last429At: ago(4 * 60_000) },
        boards: [
          board({ id: 'b_00000001', name: 'Platform', polledAt: ago(12_000) }),
          board({ id: 'b_00000002', name: 'Growth', polledAt: null }),
          board({ id: 'b_00000003', name: 'Ops', polledAt: ago(90_000), failures: [{ kind: 'query', id: 'q_00000001', message: "Field 'foo' does not exist" }] })
        ]
      })
    );
    await user.click(chip());
    const pop = screen.getByRole('dialog', { name: 'Jira' });
    expect(within(pop).getByText('AL')).toBeInTheDocument();
    expect(within(pop).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(pop).getByText(/connected · acme\.atlassian\.net/)).toBeInTheDocument();
    expect(within(pop).getByText('12 · last 429 4m ago')).toBeInTheDocument();
    const lines = within(pop).getAllByTestId('jira-chip-board');
    // By name (`boardsByName`), the order the picker and Setup use.
    expect(lines.map((l) => [l.querySelector('.tracker-row-name')?.textContent, l.querySelector('.jira-chip-board-line')?.textContent])).toEqual([
      ['Growth', 'not polled yet · every 1m'],
      ['Ops', "polled 1m ago · every 1m · Field 'foo' does not exist"],
      ['Platform', 'polled 12 s ago · every 1m']
    ]);
    expect(within(pop).getByText(accessPhrase('rate-limited') as string)).toBeInTheDocument();
    expect(within(pop).getByText(/Retry-After 60/)).toBeInTheDocument();
  });

  it('puts focus on Sync now, and the Jira setup link navigates to Jira › Setup', async () => {
    renderChip(status());
    await user.click(chip());
    expect(syncNow()).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /Jira setup/ }));
    expect(openSetup).toHaveBeenCalledWith('setup');
    expect(screen.queryByRole('dialog', { name: 'Jira' })).toBeNull();
  });

  it('Sync now posts once on a double click with no body, is disabled while pending, then reloads', async () => {
    const { update } = renderChip(status());
    await user.click(chip());
    await user.dblClick(syncNow());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/jira/sweep');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(syncNow()).toBeDisabled();
    expect(reloadMock).not.toHaveBeenCalled();
    await act(async () => answer({ ok: true, status: 200, body: {} }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(syncNow()).toBeEnabled();
    update(status({ boards: [board({ polledAt: ago(1_000) })] }));
    expect(chip()).toHaveAccessibleName('Jira: on time');
  });

  it('a 429 reads `Jira asked to wait until HH:MM`', async () => {
    renderChip(status());
    await user.click(chip());
    await user.click(syncNow());
    await act(async () => answer({ ok: false, status: 429, body: { message: 'slow down', retryAt: '2026-09-18T12:05:00Z' } }));
    expect(screen.getByText(/^Jira asked to wait until \d\d:\d\d$/)).toBeInTheDocument();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(syncNow()).toBeEnabled();
  });

  it('a 409 disables Sync now and puts the server’s sentence in its title', async () => {
    renderChip(status());
    await user.click(chip());
    await user.click(syncNow());
    await act(async () => answer({ ok: false, status: 409, body: { message: 'Jira is not being polled' } }));
    expect(syncNow()).toBeDisabled();
    expect(syncNow()).toHaveAttribute('title', 'Jira is not being polled');
  });

  describe('a board’s sync icon', () => {
    it('POSTs the board’s id to boards/sweep, reads syncing… and is disabled until the answer, then re-reads the status once', async () => {
      renderChip(status({ boards: [board({ id: 'b_00000001', name: 'Platform' }), board({ id: 'b_00000002', name: 'Growth' })] }));
      await user.click(chip());
      await user.click(screen.getByRole('button', { name: 'Sync Platform' }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/jira/boards/sweep');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ id: 'b_00000001' });
      expect(rowOf('Platform').querySelector('.jira-chip-board-line')?.textContent).toMatch(/^syncing…/);
      expect(screen.getByRole('button', { name: 'Sync Platform' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Sync Growth' })).toBeEnabled();
      expect(reloadMock).not.toHaveBeenCalled();
      await act(async () => answer({ ok: true, status: 200, body: { ok: true } }));
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Sync Platform' })).toBeEnabled();
      expect(rowOf('Platform').querySelector('.jira-chip-board-line')?.textContent).not.toMatch(/syncing…/);
    });

    it('still reads syncing… when the popover is closed and opened again mid-sweep', async () => {
      renderChip(status());
      await user.click(chip());
      await user.click(screen.getByRole('button', { name: 'Sync Platform' }));
      await user.keyboard('{Escape}');
      await user.click(chip());
      expect(rowOf('Platform').querySelector('.jira-chip-board-line')?.textContent).toMatch(/^syncing…/);
      await act(async () => answer({ ok: true, status: 200, body: { ok: true } }));
    });

    it('a refusal is drawn red in that row with the server’s sentence, and the next sync clears it', async () => {
      renderChip(status());
      await user.click(chip());
      await user.click(screen.getByRole('button', { name: 'Sync Platform' }));
      await act(async () => answer({ ok: false, status: 404, body: { error: 'unknown board' } }));
      expect(within(rowOf('Platform')).getByText('unknown board')).toHaveClass('jira-setup-failure');
      // A refused sweep still re-reads the status: a board deleted elsewhere is exactly the case where the list is stale.
      expect(reloadMock).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Sync Platform' }));
      expect(within(rowOf('Platform')).queryByText('unknown board')).toBeNull();
      await act(async () => answer({ ok: true, status: 200, body: { ok: true } }));
    });

    it('an `off` board reads sync off and keeps its sync icon enabled', async () => {
      renderChip(status({ boards: [board({ interval: 'off' })] }));
      await user.click(chip());
      expect(rowOf('Platform').querySelector('.jira-chip-board-line')?.textContent).toBe('last polled 5 s ago · sync off');
      expect(screen.getByRole('button', { name: 'Sync Platform' })).toBeEnabled();
    });
  });
});

describe('the Jira chip’s homes', () => {
  function installMatchMedia(matches: boolean) {
    const mql = { matches, media: NARROW_QUERY, addEventListener: jest.fn(), removeEventListener: jest.fn() };
    Object.defineProperty(window, 'matchMedia', { value: jest.fn(() => mql), configurable: true, writable: true });
  }

  function stubFetch(jira: JiraStatusPayload) {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const body = String(input) === '/api/jira' ? jira : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    }) as unknown as typeof fetch;
  }

  const count = (): number => document.querySelectorAll('[data-testid="jira-chip"]').length;

  beforeEach(() => localStorage.clear());

  it('draws one chip in the strip at desktop width, beside the tracker chip’s home', async () => {
    installMatchMedia(false);
    stubFetch(status());
    render(<App />);
    const el = await screen.findByTestId('jira-chip');
    expect(el.closest('.topstrip')).not.toBeNull();
    expect(count()).toBe(1);
    expect(document.querySelector('.rail-bar')).toBeNull();
  });

  it('draws one chip in the rail bar below 700 px, and none in the strip', async () => {
    installMatchMedia(true);
    stubFetch(status());
    render(<App />);
    const el = await screen.findByTestId('jira-chip');
    expect(el.closest('.rail-bar')).not.toBeNull();
    expect(el.closest('.topstrip')).toBeNull();
    expect(count()).toBe(1);
  });

  it('draws no chip anywhere while unconfigured', async () => {
    installMatchMedia(false);
    stubFetch(status({ configured: false, site: null, me: null, access: 'unconfigured', boards: [], home: null }));
    // A real stored section, held while the projects answer is unknown (this fetch gives no array) — no stored key would paint the loading shape instead.
    localStorage.setItem('backlog-manager.section', JSON.stringify('github'));
    render(<App />);
    await screen.findByText('board stub');
    await act(async () => {
      await Promise.resolve();
    });
    expect(count()).toBe(0);
  });
});
