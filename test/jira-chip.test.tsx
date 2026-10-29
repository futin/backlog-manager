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

function wrap(data: JiraStatusPayload | null, section: Section) {
  const value: JiraState = { data, loading: false, error: false, reload: () => {} };
  return (
    <JiraContext.Provider value={value}>
      <JiraChip section={section} />
    </JiraContext.Provider>
  );
}

function renderChip(data: JiraStatusPayload | null, section: Section = 'github') {
  const utils = render(wrap(data, section));
  return { ...utils, update: (next: JiraStatusPayload | null, nextSection: Section = section) => utils.rerender(wrap(next, nextSection)) };
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

  it('opens a popover that is a reading: site, one line per board with Jira’s own failure, calls, last 429 — no link and no button', async () => {
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
    expect(lines.map((l) => l.textContent)).toEqual([
      'Growth · not polled yet',
      "Ops · polled 1m ago · Field 'foo' does not exist",
      'Platform · polled 12 s ago'
    ]);
    // The Connection card's copy, from the same two functions, so the two surfaces cannot word one fact two ways.
    const calls = status({ calls: { sweep: 12, last429At: ago(4 * 60_000) } }).calls;
    const sweep = sweepLine(true, calls, NOW);
    expect(within(pop).getByText(sweep.lead)).toBeInTheDocument();
    expect(within(pop).getByText(sweep.rate)).toBeInTheDocument();
    expect(within(pop).getByText(accessPhrase('rate-limited') as string)).toBeInTheDocument();
    expect(within(pop).getByText(/Retry-After 60/)).toBeInTheDocument();
    expect(pop.querySelector('a')).toBeNull();
    expect(pop.querySelector('button')).toBeNull();
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
