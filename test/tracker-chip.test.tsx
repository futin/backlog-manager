/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * The strip chip and its popover (the tracker strip spec, §2). The context is provided directly rather than through a stubbed fetch: what this suite owns
 * is what the chip READS off a payload, and `use-trackers.test.tsx` owns how the payload arrives. Fake timers pin `useNow`'s one-second tick.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function platform(over: Partial<TrackerPlatform> = {}): TrackerPlatform {
  return { kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4930, reset: 1_790_000_000, ...over };
}

function row(over: Partial<TrackerProjectRow> = {}): TrackerProjectRow {
  return { name: 'alpha', path: '/abs/alpha', source: 'github', repo: 'futin/alpha', polledAt: ago(5_000), access: 'ok', detail: null, connect: null, ...over };
}

const beta = (over: Partial<TrackerProjectRow> = {}) => row({ name: 'beta', path: '/abs/beta', repo: 'futin/beta', ...over });

function payload(rows: TrackerProjectRow[] = [row()], plat: TrackerPlatform = platform()): TrackersPayload {
  return { platforms: [plat], projects: rows };
}

function wrap(data: TrackersPayload | null, section: Section, extra?: React.ReactNode) {
  const value: TrackersState = { data, loading: false, error: false, reload: () => {} };
  return (
    <TrackersContext.Provider value={value}>
      {extra}
      <TrackerChip section={section} />
    </TrackersContext.Provider>
  );
}

function renderChip(data: TrackersPayload | null, section: Section = 'board') {
  const utils = render(wrap(data, section));
  return { ...utils, update: (next: TrackersPayload | null, nextSection: Section = section) => utils.rerender(wrap(next, nextSection)) };
}

const chip = () => screen.getByTestId('tracker-chip');
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
});

describe('TrackerChip', () => {
  it('renders nothing when no project is a tracker', () => {
    const { update } = renderChip(payload([row({ source: 'files' })]));
    expect(screen.queryByTestId('tracker-chip')).toBeNull();
    update(null);
    expect(screen.queryByTestId('tracker-chip')).toBeNull();
  });

  it('draws the login, a POLL countdown and the API share for a healthy payload', () => {
    renderChip(payload());
    const c = chip();
    expect(within(c).getByText('F')).toBeInTheDocument();
    expect(within(c).getByText('futin')).toBeInTheDocument();
    expect(within(meterOf(c, 'POLL')).getByText('12s')).toBeInTheDocument();
    expect(within(meterOf(c, 'API')).getByText('1.4%')).toBeInTheDocument();
    expect(screen.queryByTestId('tracker-pip')).toBeNull();
  });

  it('advances the countdown once a second', () => {
    renderChip(payload());
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(within(meterOf(chip(), 'POLL')).getByText('11s')).toBeInTheDocument();
  });

  it('reads overdue on a full amber bar at two cycles', () => {
    renderChip(payload([row({ polledAt: ago(34_000) })]));
    const poll = meterOf(chip(), 'POLL');
    expect(within(poll).getByText('overdue')).toBeInTheDocument();
    expect(poll).toHaveAttribute('data-tone', 'amber');
    expect(fillOf(poll)).toBe('100%');
  });

  it('reads failing on a full red bar when every repo is failing, and only a red pip when some are', () => {
    const { update } = renderChip(payload([row({ access: 'forbidden' }), beta({ access: 'forbidden' })]));
    let poll = meterOf(chip(), 'POLL');
    expect(within(poll).getByText('failing')).toBeInTheDocument();
    expect(poll).toHaveAttribute('data-tone', 'red');
    expect(fillOf(poll)).toBe('100%');

    update(payload([row(), beta({ access: 'forbidden' })]));
    poll = meterOf(chip(), 'POLL');
    expect(within(poll).getByText('12s')).toBeInTheDocument();
    expect(poll).toHaveAttribute('data-tone', 'green');
    expect(screen.getByTestId('tracker-pip')).toHaveAttribute('data-tone', 'red');
  });

  it('reads … before the first poll', () => {
    renderChip(payload([row({ polledAt: null })]));
    const poll = meterOf(chip(), 'POLL');
    expect(within(poll).getByText('…')).toBeInTheDocument();
    expect(fillOf(poll)).toBe('0%');
  });

  it('takes no-token from the platform, not from the rows', () => {
    // Review Focus 5: `hasToken` decides the no-token state; `access` decides the red pip.
    const { update } = renderChip(payload([row({ access: 'ok' })], platform({ hasToken: false, login: null })));
    let c = chip();
    expect(within(c).getByText('no token')).toBeInTheDocument();
    expect(within(c).getByText('—')).toBeInTheDocument();
    expect(screen.getByTestId('tracker-pip')).toHaveAttribute('data-tone', 'amber');
    expect(within(c).queryByText('POLL')).toBeNull();
    expect(within(c).queryByText('API')).toBeNull();

    update(payload([row({ access: 'no-token' }), beta({ access: 'no-token' })], platform({ hasToken: true })));
    c = chip();
    expect(within(c).getByText('futin')).toBeInTheDocument();
    expect(screen.getByTestId('tracker-pip')).toHaveAttribute('data-tone', 'red');
    expect(within(meterOf(c, 'POLL')).getByText('failing')).toBeInTheDocument();
  });

  it('escapes the phone rail: under 700 px the popover is fixed, not absolute', () => {
    // The narrow `.rail` is a scroll container (`overflow-x: hidden` computes `overflow-y` to auto), so an absolute popover inside it is clipped to the
    // 53 px bar and paints nothing; right-anchored under a chip beside ☰ it would start off-screen besides. jsdom does no layout, so this pins the rule.
    const css = readFileSync(join(__dirname, '../client/src/styles.css'), 'utf8');
    const narrow = [...css.matchAll(/@media \(max-width: 700px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
    const rule = /\.tracker-pop \{([^}]*)\}/.exec(narrow);
    expect(rule?.[1]).toMatch(/position: fixed/);
    // The base rule's `top: calc(100% + 6px)` would resolve against the viewport once fixed and put the panel below the screen.
    expect(rule?.[1]).toMatch(/top: auto/);
    expect(rule?.[1]).toMatch(/left: 12px/);
    expect(rule?.[1]).toMatch(/right: 12px/);
    expect(rule?.[1]).toMatch(/width: auto/);
  });

  it('colours the API meter by the budget ramp: green under 60 %, amber from 60 %, red from 90 %', () => {
    // Remaining counts at each edge of the ramp, out of 5000: 2001 left is 59.98 % used, 2000 is exactly 60 %, 500 is exactly 90 %.
    const cases: [number, string][] = [
      [2001, 'green'],
      [2000, 'amber'],
      [501, 'amber'],
      [500, 'red']
    ];
    const { update } = renderChip(payload());
    for (const [remaining, tone] of cases) {
      update(payload([row()], platform({ remaining })));
      expect({ remaining, tone: meterOf(chip(), 'API').getAttribute('data-tone') }).toEqual({ remaining, tone });
    }
  });

  it('hides the API meter until the platform has a limit', () => {
    renderChip(payload([row()], platform({ limit: null, remaining: null, reset: null })));
    expect(within(chip()).queryByText('API')).toBeNull();
    expect(within(chip()).getByText('POLL')).toBeInTheDocument();
  });
});

describe('TrackerPopover', () => {
  it('opens a read-only popover with one row per connected repo', async () => {
    renderChip(payload([row(), beta(), row({ name: 'gamma', path: '/abs/gamma', source: 'files', repo: null })]));
    await user.click(chip());
    const dialog = screen.getByRole('dialog', { name: 'Tracker' });
    expect(within(dialog).getAllByTestId('tracker-row')).toHaveLength(2);
    expect(within(dialog).getByText('GitHub · 2 repos connected')).toBeInTheDocument();
    expect(within(dialog).queryAllByRole('button')).toHaveLength(0);
    expect(within(dialog).queryAllByRole('link')).toHaveLength(0);
  });

  it('draws a failing repo as a full red bar carrying the access reason', async () => {
    const failing = beta({ access: 'forbidden', detail: 'x' });
    renderChip(payload([row(), failing]));
    await user.click(chip());
    const rows = screen.getAllByTestId('tracker-row');
    const bad = rows[1]!;
    const reason = accessReason(failing)!;
    const meter = within(bad).getByText(reason).closest('.ui-meter') as HTMLElement;
    expect(meter).toHaveAttribute('data-tone', 'red');
    expect(fillOf(meter)).toBe('100%');
  });

  it('draws the API line with the remaining count and the reset clock', async () => {
    renderChip(payload());
    await user.click(chip());
    const dialog = screen.getByRole('dialog', { name: 'Tracker' });
    expect(within(dialog).getByText(`${(4930).toLocaleString()} of ${(5000).toLocaleString()} left · resets ${resetClock(1_790_000_000)}`)).toBeInTheDocument();
  });

  it("runs the popover's API bar the whole width of the panel, whatever the panel's width", async () => {
    // Not a px width: under 700 px the panel is the viewport less 24 px (351 px at 375), and a 388 px bar ran off its right edge.
    renderChip(payload());
    await user.click(chip());
    const dialog = screen.getByRole('dialog', { name: 'Tracker' });
    expect(meterOf(dialog, 'API').style.width).toBe('100%');
  });

  it('replaces the rows with the token sentence when there is no token', async () => {
    renderChip(payload([row()], platform({ hasToken: false, login: null })));
    await user.click(chip());
    const dialog = screen.getByRole('dialog', { name: 'Tracker' });
    expect(dialog).toHaveTextContent('BM_GITHUB_TOKEN');
    expect(within(dialog).queryAllByTestId('tracker-row')).toHaveLength(0);
  });

  it('closes on a pointerdown outside and stays open on one inside', async () => {
    renderChip(payload([row(), beta()]));
    await user.click(chip());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();

    await user.click(chip());
    fireEvent.pointerDown(screen.getAllByTestId('tracker-row')[0]!);
    expect(screen.getByRole('dialog', { name: 'Tracker' })).toBeInTheDocument();
  });

  it('closes when the section changes', async () => {
    const { update } = renderChip(payload());
    await user.click(chip());
    update(payload(), 'runs');
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
  });

  it('gives Escape to the popover and not to a dialog beneath it, then hands it back', async () => {
    const closeBelow = jest.fn();
    function Below() {
      useDialogEscape(closeBelow);
      return null;
    }
    render(wrap(payload(), 'board', <Below />));
    await user.click(chip());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
    expect(closeBelow).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(closeBelow).toHaveBeenCalledTimes(1);
  });

  it('follows the payload while open', async () => {
    // Review Focus 3: a repo disconnected or the token removed while the popover is up.
    const { update } = renderChip(payload([row(), beta()]));
    await user.click(chip());
    update(payload([row()]));
    const dialog = screen.getByRole('dialog', { name: 'Tracker' });
    expect(within(dialog).getAllByTestId('tracker-row')).toHaveLength(1);
    update(payload([row()], platform({ hasToken: false, login: null })));
    const again = screen.getByRole('dialog', { name: 'Tracker' });
    expect(again).toHaveTextContent('BM_GITHUB_TOKEN');
    expect(within(again).queryAllByTestId('tracker-row')).toHaveLength(0);
  });
});
