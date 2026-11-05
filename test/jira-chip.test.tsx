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
import { JIRA_429_RED_MS, JIRA_SWEEP_CALL_CEILING, accessPhrase, sweepLine } from '../client/src/lib/jira';
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

function wrap(data: JiraStatusPayload | null, section: Section, reload: () => void = () => {}) {
  const value: JiraState = { data, loading: false, error: false, reload };
  return (
    <JiraContext.Provider value={value}>
      <JiraChip section={section} />
    </JiraContext.Provider>
  );
}

function renderChip(data: JiraStatusPayload | null, section: Section = 'github', reload: () => void = () => {}) {
  const utils = render(wrap(data, section, reload));
  return { ...utils, update: (next: JiraStatusPayload | null, nextSection: Section = section) => utils.rerender(wrap(next, nextSection, reload)) };
}

const chip = () => screen.getByTestId('jira-chip');
const meterOf = (scope: HTMLElement, label: string) => within(scope).getByText(label).closest('.ui-meter') as HTMLElement;
const fillOf = (meter: HTMLElement) => (meter.querySelector('.ui-meter-fill') as HTMLElement).style.width;

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
});

afterEach(() => {
  jest.useRealTimers();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

describe('JiraChip', () => {
  it('draws nothing while Jira is unconfigured, or before the first answer', () => {
    const { update } = renderChip(status({ configured: false, site: null, me: null, access: 'unconfigured', boards: [] }));
    expect(screen.queryByTestId('jira-chip')).toBeNull();
    update(null);
    expect(screen.queryByTestId('jira-chip')).toBeNull();
    update(status());
    expect(chip()).toBeInTheDocument();
  });

  it('reads one initial and `Jira · <first name>`', () => {
    renderChip(status());
    expect(chip().querySelector('.tracker-av')).toHaveTextContent(/^A$/);
    expect(within(chip()).getByText('Jira · Ada')).toBeInTheDocument();
    expect(chip()).toHaveAccessibleName('Jira: Ada Lovelace');
  });

  it('reads `?` for the initial while `me` is null', () => {
    renderChip(status({ me: null }));
    expect(chip().querySelector('.tracker-av')).toHaveTextContent(/^\?$/);
    expect(within(chip()).getByText('Jira')).toBeInTheDocument();
  });

  it('draws the red pip while access is not ok, and none while it is', () => {
    const { update } = renderChip(status({ access: 'unauthorized' }));
    expect(screen.getByTestId('jira-pip')).toHaveAttribute('data-tone', 'red');
    update(status({ access: 'ok' }));
    expect(screen.queryByTestId('jira-pip')).toBeNull();
  });

  it('counts the POLL meter down on the soonest board’s own interval, and empties it with no syncing board', () => {
    const { update } = renderChip(status({ boards: [board({ polledAt: ago(15_000), interval: '1m' })] }));
    // 1m = 60 s: 15 s elapsed leaves 45 s, a quarter of the bar.
    expect(within(meterOf(chip(), 'POLL')).getByText('45s')).toBeInTheDocument();
    expect(fillOf(meterOf(chip(), 'POLL'))).toBe('25%');
    update(status({ boards: [board({ interval: 'off' })] }));
    expect(fillOf(meterOf(chip(), 'POLL'))).toBe('0%');
    expect(within(meterOf(chip(), 'POLL')).getByText('sync off')).toBeInTheDocument();
    expect(meterOf(chip(), 'POLL')).toHaveAttribute('data-tone', 'amber');
    update(status({ boards: [] }));
    expect(within(meterOf(chip(), 'POLL')).getByText('—')).toBeInTheDocument();
    expect(fillOf(meterOf(chip(), 'POLL'))).toBe('0%');
    update(status({ boards: [board({ polledAt: null })] }));
    expect(fillOf(meterOf(chip(), 'POLL'))).toBe('0%');
    expect(within(meterOf(chip(), 'POLL')).getByText('…')).toBeInTheDocument();
  });

  it('fills the CALLS meter at the ceiling, and turns it red for a 429 inside the window', () => {
    const { update } = renderChip(status({ calls: { sweep: JIRA_SWEEP_CALL_CEILING + 40, last429At: null } }));
    expect(fillOf(meterOf(chip(), 'CALLS'))).toBe('100%');
    expect(meterOf(chip(), 'CALLS')).toHaveAttribute('data-tone', 'green');
    update(status({ calls: { sweep: 12, last429At: ago(5 * 60_000) } }));
    expect(meterOf(chip(), 'CALLS')).toHaveAttribute('data-tone', 'red');
    update(status({ calls: { sweep: 12, last429At: ago(JIRA_429_RED_MS + 60_000) } }));
    expect(meterOf(chip(), 'CALLS')).toHaveAttribute('data-tone', 'green');
  });

  it('opens a popover: site, one row per board with Jira’s own failure and a `now` each, calls, last 429 — and no link', async () => {
    renderChip(
      status({
        access: 'rate-limited',
        detail: 'Retry-After 60',
        calls: { sweep: 12, last429At: ago(4 * 60_000) },
        boards: [
          board({ id: 'b_00000001', name: 'Platform', polledAt: ago(12_000) }),
          board({ id: 'b_00000002', name: 'Growth', polledAt: null }),
          board({
            id: 'b_00000003',
            name: 'Ops',
            polledAt: ago(90_000),
            failures: [{ kind: 'query', id: 'q_00000001', message: "Field 'foo' does not exist" }]
          })
        ]
      })
    );
    await user.click(chip());
    const pop = screen.getByRole('dialog', { name: 'Jira' });
    expect(within(pop).getByText('acme.atlassian.net')).toBeInTheDocument();
    const lines = within(pop).getAllByTestId('jira-chip-board');
    // By name (`boardsByName`), the order the picker and Setup use — not the file's order, which is Platform, Growth, Ops.
    expect(lines.map((l) => [l.querySelector('.tracker-row-name')?.textContent, l.querySelector('.jira-chip-board-line')?.textContent])).toEqual([
      ['Growth', 'not polled yet · every 1m'],
      ['Ops', "polled 1m ago · every 1m · Field 'foo' does not exist"],
      ['Platform', 'polled 12 s ago · every 1m']
    ]);
    // The Connection card's copy, from the same two functions, so the two surfaces cannot word one fact two ways.
    const calls = status({ calls: { sweep: 12, last429At: ago(4 * 60_000) } }).calls;
    const sweep = sweepLine(true, calls, NOW);
    expect(within(pop).getByText(sweep.lead)).toBeInTheDocument();
    expect(within(pop).getByText(sweep.rate)).toBeInTheDocument();
    expect(within(pop).getByText(accessPhrase('rate-limited') as string)).toBeInTheDocument();
    expect(within(pop).getByText(/Retry-After 60/)).toBeInTheDocument();
    // No link — the rail is the only switch — and the only buttons are the boards' own `now`s, one per row.
    expect(pop.querySelector('a')).toBeNull();
    expect(within(pop).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Sweep Growth now', 'Sweep Ops now', 'Sweep Platform now']);
  });

  describe('a board’s `now`', () => {
    let fetchMock: jest.Mock;
    let answer: (res: { ok: boolean; status: number; body: unknown }) => void;

    beforeEach(() => {
      fetchMock = jest.fn(
        () =>
          new Promise((resolve) => {
            answer = ({ ok, status, body }) => resolve({ ok, status, json: () => Promise.resolve(body) });
          })
      );
      (globalThis as { fetch?: unknown }).fetch = fetchMock;
    });
    afterEach(() => {
      Reflect.deleteProperty(globalThis, 'fetch');
    });

    const rowOf = (name: string) => screen.getAllByTestId('jira-chip-board').find((r) => r.querySelector('.tracker-row-name')?.textContent === name) as HTMLElement;

    it('POSTs the board’s id, reads syncing… and is disabled until the answer, then re-reads the status once', async () => {
      const reload = jest.fn();
      renderChip(status({ boards: [board({ id: 'b_00000001', name: 'Platform' }), board({ id: 'b_00000002', name: 'Growth' })] }), 'github', reload);
      await user.click(chip());
      await user.click(screen.getByRole('button', { name: 'Sweep Platform now' }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/jira/boards/sweep');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ id: 'b_00000001' });
      expect(within(meterOf(rowOf('Platform'), 'next')).getByText('syncing…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sweep Platform now' })).toBeDisabled();
      // The other board's `now` is independent of this one's.
      expect(screen.getByRole('button', { name: 'Sweep Growth now' })).toBeEnabled();
      expect(reload).not.toHaveBeenCalled();
      await act(async () => answer({ ok: true, status: 200, body: { ok: true } }));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Sweep Platform now' })).toBeEnabled();
      expect(within(meterOf(rowOf('Platform'), 'next')).queryByText('syncing…')).toBeNull();
    });

    it('still reads syncing… when the popover is closed and opened again mid-sweep', async () => {
      renderChip(status());
      await user.click(chip());
      await user.click(screen.getByRole('button', { name: 'Sweep Platform now' }));
      await user.keyboard('{Escape}');
      await user.click(chip());
      expect(within(meterOf(rowOf('Platform'), 'next')).getByText('syncing…')).toBeInTheDocument();
      await act(async () => answer({ ok: true, status: 200, body: { ok: true } }));
    });

    it('a refusal is drawn red in that row with the server’s sentence, and the next `now` clears it', async () => {
      const reload = jest.fn();
      renderChip(status(), 'github', reload);
      await user.click(chip());
      await user.click(screen.getByRole('button', { name: 'Sweep Platform now' }));
      await act(async () => answer({ ok: false, status: 404, body: { error: 'unknown board' } }));
      const refusal = within(rowOf('Platform')).getByText('unknown board');
      expect(refusal).toHaveClass('jira-setup-failure');
      // A refused sweep still re-reads the status: a board deleted elsewhere is exactly the case where the list is stale.
      expect(reload).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Sweep Platform now' }));
      expect(within(rowOf('Platform')).queryByText('unknown board')).toBeNull();
      await act(async () => answer({ ok: true, status: 200, body: { ok: true } }));
    });

    it('an `off` board reads sync off on its meter and keeps its `now`', async () => {
      renderChip(status({ boards: [board({ interval: 'off' })] }));
      await user.click(chip());
      expect(within(meterOf(rowOf('Platform'), 'next')).getByText('sync off')).toBeInTheDocument();
      expect(rowOf('Platform').querySelector('.jira-chip-board-line')?.textContent).toBe('last polled 5 s ago · sync off');
      expect(screen.getByRole('button', { name: 'Sweep Platform now' })).toBeEnabled();
    });
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
