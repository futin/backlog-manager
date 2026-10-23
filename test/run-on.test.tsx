/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { RunOn } from '../client/src/components/ui/RunOn';
import type { MachineOffer, MachineUsage, ProjectOffers } from '../shared/types';

/**
 * `RunOn` — the "Run on" machine-card group (spec "The picker's look", DESIGN.md §8.9.5 / §7). Everything it draws arrives from `ProjectOffers` as the
 * server sent it, so these cases build offers and read the DOM; the wording of each derived string is `lib/dashboards.ts`'s and is pinned here through what
 * the card shows. The 5 h reset is `now`-relative, so the clock is fixed and the fixture is cut from it (CLAUDE.md: a fixture date is relative to the clock
 * the assertion runs under).
 */
const NOW = new Date('2026-10-23T12:00:00.000Z');
const inMs = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

function usage(fiveHour: number, week: number, resetMs: number): MachineUsage {
  return {
    fiveHour: { pct: fiveHour, resetsAt: inMs(resetMs) },
    week: { pct: week, resetsAt: inMs(3 * 86_400_000) },
    projection: 'safe',
    exhaustAt: null,
    fetchedAt: inMs(-40_000)
  };
}

function offer(patch: Partial<MachineOffer>): MachineOffer {
  return { machine: 'home', label: 'Home', home: true, account: null, offered: true, reason: null, usage: null, usageAgeMs: null, models: [], efforts: [], ...patch };
}

const HOME = offer({ usage: usage(28, 9, 3 * 3_600_000 + 12 * 60_000), usageAgeMs: 12_000 });
const PRO = offer({
  machine: 'Pro',
  label: 'Pro',
  home: false,
  account: 'Max 20x',
  usage: usage(12, 5, 2 * 3_600_000 + 14 * 60_000),
  usageAgeMs: 40_000,
  models: ['sonnet'],
  efforts: ['low']
});
const REASON = 'Prefer order: Pro comes first under 80% on both windows';

function offers(machines: MachineOffer[], suggestion: ProjectOffers['suggestion']): ProjectOffers {
  return { project: '/p', machines, suggestion };
}

const SUGGESTED = offers([HOME, PRO], { machine: 'Pro', reason: REASON, basis: 'usage' });

function card(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });
}

describe('RunOn', () => {
  it('draws one aria-pressed button per machine, the value pressed', () => {
    render(<RunOn offers={SUGGESTED} value="Pro" onChange={() => {}} />);
    const buttons = within(screen.getByRole('group', { name: /run on/i })).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(card('Pro')).toHaveAttribute('aria-pressed', 'true');
    expect(card('Home')).toHaveAttribute('aria-pressed', 'false');
  });

  it('tags the suggested machine and the home one', () => {
    render(<RunOn offers={SUGGESTED} value="Pro" onChange={() => {}} />);
    expect(within(card('Pro')).getByText('Suggested')).toBeInTheDocument();
    expect(within(card('Pro')).queryByText('home')).toBeNull();
    expect(within(card('Home')).getByText('home')).toBeInTheDocument();
    expect(within(card('Home')).queryByText('Suggested')).toBeNull();
  });

  it('shows the account line, each window’s percentage and the 5 h reset', () => {
    render(<RunOn offers={SUGGESTED} value="Pro" onChange={() => {}} />);
    expect(within(card('Pro')).getByText('Max 20x')).toBeInTheDocument();
    expect(within(card('Pro')).getByText('12%')).toBeInTheDocument();
    expect(within(card('Pro')).getByText('5%')).toBeInTheDocument();
    expect(within(card('Pro')).getByText('5 h resets in 2h 14m')).toBeInTheDocument();
    expect(within(card('Home')).getByText('28%')).toBeInTheDocument();
    expect(within(card('Home')).getByText('9%')).toBeInTheDocument();
    expect(within(card('Home')).getByText('5 h resets in 3h 12m')).toBeInTheDocument();
  });

  it('says which windows the bars are', () => {
    render(<RunOn offers={SUGGESTED} value="Pro" onChange={() => {}} />);
    expect(within(card('Pro')).getByText('5 h')).toBeInTheDocument();
    expect(within(card('Pro')).getByText('week')).toBeInTheDocument();
  });

  it('puts the suggestion’s reason on its own line, with a link to Settings beside it', () => {
    render(<RunOn offers={SUGGESTED} value="Pro" onChange={() => {}} />);
    expect(screen.getByText(REASON).textContent).toBe(REASON);
    const link = screen.getByRole('link', { name: /settings/i });
    expect(link.getAttribute('href')).toBe('/?section=settings');
  });

  it('reads the cache age at the group’s top right', () => {
    render(<RunOn offers={SUGGESTED} value="Pro" onChange={() => {}} />);
    // The oldest reading on the cards, not the freshest: Pro's 40 s against home's 12 s.
    expect(screen.getByText('usage 40 s ago')).toBeInTheDocument();
  });

  it('reports a minutes-old reading in minutes', () => {
    render(<RunOn offers={offers([HOME, { ...PRO, usageAgeMs: 4 * 60_000 }], SUGGESTED.suggestion)} value="Pro" onChange={() => {}} />);
    expect(screen.getByText('usage 4 min ago')).toBeInTheDocument();
  });

  it('reports a pick through onChange with the machine id, home included', () => {
    const onChange = jest.fn();
    render(<RunOn offers={SUGGESTED} value="Pro" onChange={onChange} />);
    fireEvent.click(card('Home'));
    expect(onChange).toHaveBeenLastCalledWith('home');
    fireEvent.click(card('Pro'));
    expect(onChange).toHaveBeenLastCalledWith('Pro');
  });

  it('draws a not-offered machine disabled with its reason, and a click does nothing', () => {
    const onChange = jest.fn();
    const down = { ...PRO, offered: false, reason: 'Pro’s dashboard does not list /p', usage: null, usageAgeMs: null };
    render(<RunOn offers={offers([HOME, down], { machine: 'home', reason: 'Home by default', basis: 'default' })} value="home" onChange={onChange} />);
    expect(card('Pro')).toBeDisabled();
    expect(within(card('Pro')).getByText('Pro’s dashboard does not list /p')).toBeInTheDocument();
    fireEvent.click(card('Pro'));
    expect(onChange).not.toHaveBeenCalled();
    expect(card('Home')).toBeEnabled();
  });

  it('says usage unknown for a machine with no reading, and draws no bars for it', () => {
    const blind = { ...PRO, usage: null, usageAgeMs: null };
    render(<RunOn offers={offers([HOME, blind], { machine: 'home', reason: 'r', basis: 'usage' })} value="home" onChange={() => {}} />);
    expect(within(card('Pro')).getByText('usage unknown')).toBeInTheDocument();
    expect(within(card('Pro')).queryByText('5 h')).toBeNull();
    expect(within(card('Home')).queryByText('usage unknown')).toBeNull();
  });

  it('draws nothing for a single machine', () => {
    const { container } = render(<RunOn offers={offers([HOME], null)} value="home" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing for no machines', () => {
    const { container } = render(<RunOn offers={offers([], null)} value="home" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says so when nothing is offered and no machine is suggested, with every card disabled', () => {
    const none = offers(
      [
        { ...HOME, offered: false, reason: 'dashboard unreachable — refused', usage: null },
        { ...PRO, offered: false, reason: 'board unreachable — timeout', usage: null }
      ],
      null
    );
    render(<RunOn offers={none} value="home" onChange={() => {}} />);
    expect(screen.getByText('No machine can run this project right now')).toBeInTheDocument();
    expect(card('Home')).toBeDisabled();
    expect(card('Pro')).toBeDisabled();
    expect(screen.queryByRole('link', { name: /settings/i })).toBeNull();
  });

  it('a window past its reset reads as resetting now rather than a negative span', () => {
    const past = { ...PRO, usage: usage(12, 5, -60_000) };
    render(<RunOn offers={offers([HOME, past], SUGGESTED.suggestion)} value="Pro" onChange={() => {}} />);
    expect(within(card('Pro')).getByText('5 h resets now')).toBeInTheDocument();
  });

  it('a utilisation past 100 draws as 100%', () => {
    const over = { ...PRO, usage: usage(130, 5, 3_600_000) };
    render(<RunOn offers={offers([HOME, over], SUGGESTED.suggestion)} value="Pro" onChange={() => {}} />);
    expect(within(card('Pro')).getByText('100%')).toBeInTheDocument();
  });
});
