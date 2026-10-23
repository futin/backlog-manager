import { suggest } from '../server/src/agents/dashboards/suggest.util';
import type { MachineUsage, SuggestStrategy } from '../shared/types';

/**
 * `suggest` is pure, so every case hands it candidates directly — no fetch, no clock. Home is `used 62` (62 / 41) and Pro `used 28` (12 / 28) unless a case says
 * otherwise; the threshold is 80 throughout, the default.
 */

const usage = (fiveHour: number, week: number, projection: MachineUsage['projection'] = 'safe'): MachineUsage => ({
  fiveHour: { pct: fiveHour, resetsAt: null },
  week: { pct: week, resetsAt: null },
  projection,
  exhaustAt: null,
  fetchedAt: '2026-10-23T10:00:00.000Z'
});

const home = (u: MachineUsage | null) => ({ machine: 'home', label: 'Home', usage: u });
const pro = (u: MachineUsage | null) => ({ machine: 'Pro', label: 'Pro', usage: u });

const pick = (
  strategy: SuggestStrategy,
  candidates: Array<{ machine: string; label: string; usage: MachineUsage | null }>,
  order: string[] = ['home', 'Pro'],
  homeOffered = true
) => suggest({ candidates, order, strategy, threshold: 80, homeOffered });
/** Cases that have at least one candidate always get a suggestion, so they read it non-null; only the empty case reads the raw result. */
const run = (...args: Parameters<typeof pick>) => pick(...args)!;

describe('suggest — prefer order', () => {
  it('takes the first machine in order that is under the threshold on both windows', () => {
    expect(run('prefer', [home(usage(62, 41)), pro(usage(12, 28))])).toEqual({
      machine: 'home',
      reason: 'Prefer order: Home comes first under 80% on both windows',
      basis: 'usage'
    });
  });

  it('follows a reordered prefer order', () => {
    expect(run('prefer', [home(usage(62, 41)), pro(usage(12, 28))], ['Pro', 'home'])).toEqual({
      machine: 'Pro',
      reason: 'Prefer order: Pro comes first under 80% on both windows',
      basis: 'usage'
    });
  });

  it('skips a machine that is over the threshold on either window', () => {
    expect(run('prefer', [home(usage(10, 85)), pro(usage(12, 28))]).machine).toBe('Pro');
    expect(run('prefer', [home(usage(85, 10)), pro(usage(12, 28))]).machine).toBe('Pro');
  });

  it('falls back to the most headroom when none is under the threshold', () => {
    expect(run('prefer', [home(usage(85, 40)), pro(usage(90, 10))])).toEqual({
      machine: 'home',
      reason: 'Prefer order: none under 80% — Home has the most headroom',
      basis: 'usage'
    });
  });
});

describe('suggest — most headroom', () => {
  it('takes the lowest used figure, the higher of the two windows', () => {
    expect(run('headroom', [home(usage(62, 41)), pro(usage(12, 28))])).toEqual({
      machine: 'Pro',
      reason: 'Most headroom: Pro at 28% used',
      basis: 'usage'
    });
  });

  it('breaks a tie by prefer order', () => {
    expect(run('headroom', [home(usage(40, 10)), pro(usage(5, 40))]).machine).toBe('home');
    expect(run('headroom', [home(usage(40, 10)), pro(usage(5, 40))], ['Pro', 'home']).machine).toBe('Pro');
  });

  it('rounds the used figure to an integer in the reason', () => {
    expect(run('headroom', [home(usage(62, 41)), pro(usage(12.6, 3))]).reason).toBe('Most headroom: Pro at 13% used');
  });
});

describe('suggest — least likely to run out', () => {
  it('takes the machine projected safe over one that runs out', () => {
    expect(run('runway', [home(usage(10, 10, 'runs-out')), pro(usage(10, 10, 'safe'))])).toEqual({
      machine: 'Pro',
      reason: 'Least likely to run out: Pro lasts past its weekly reset',
      basis: 'usage'
    });
  });

  it('takes the first safe machine in prefer order when several are safe', () => {
    expect(run('runway', [home(usage(10, 10, 'safe')), pro(usage(10, 10, 'safe'))]).machine).toBe('home');
  });

  it('falls back to prefer order when every machine runs out', () => {
    expect(run('runway', [home(usage(10, 10, 'runs-out')), pro(usage(10, 10, 'runs-out'))])).toEqual({
      machine: 'home',
      reason: 'Least likely to run out: no machine is projected safe — Home by prefer order',
      basis: 'usage'
    });
  });

  it('ranks a known projection above an unknown one, even a bad one', () => {
    expect(run('runway', [home(usage(10, 10, 'unknown')), pro(usage(10, 10, 'runs-out'))]).machine).toBe('Pro');
  });

  it('falls back to prefer order when every projection is unknown', () => {
    const s = run('runway', [home(usage(10, 10, 'unknown')), pro(usage(10, 10, 'unknown'))]);
    expect(s.machine).toBe('home');
    expect(s.reason).toBe('Least likely to run out: no machine is projected safe — Home by prefer order');
  });
});

describe('suggest — missing usage', () => {
  it.each<SuggestStrategy>(['prefer', 'headroom', 'runway'])('never picks a machine without usage while another has some (%s)', (strategy) => {
    expect(run(strategy, [home(null), pro(usage(95, 95, 'runs-out'))]).machine).toBe('Pro');
    expect(run(strategy, [home(null), pro(usage(95, 95, 'runs-out'))]).basis).toBe('usage');
  });

  it('suggests home by default when nothing has usage and home is offered', () => {
    expect(run('prefer', [pro(null), home(null)], ['Pro', 'home'])).toEqual({
      machine: 'home',
      reason: 'No usage figures — Home by default',
      basis: 'default'
    });
  });

  it('suggests the first offered in prefer order when nothing has usage and home is not offered', () => {
    const s = run('prefer', [pro(null), { machine: 'Max', label: 'Max', usage: null }], ['Max', 'home', 'Pro'], false);
    expect(s).toEqual({ machine: 'Max', reason: 'No usage figures — Max by default', basis: 'default' });
  });

  it('returns null with no candidates', () => {
    expect(pick('prefer', [], ['home', 'Pro'], false)).toBeNull();
  });
});
