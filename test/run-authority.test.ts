import { pickAuthority } from '../client/src/lib/run-authority';

/**
 * `pickAuthority` is the one `live ?? fetched ?? archive` rule both Runs surfaces call (docs/subsystems/invariants.md, the three tiers behind
 * pickAuthority). These pin its three readings: the first present tier wins in order, `undefined` is "nothing to say" exactly as `null` is, and the
 * fallback answers only when every preferred tier is empty.
 */
describe('pickAuthority', () => {
  const live = { tier: 'live' };
  const fetched = { tier: 'fetched' };
  const archive = { tier: 'archive' };

  it('answers the first present tier, in the order given', () => {
    expect(pickAuthority([live, fetched], archive)).toBe(live);
    expect(pickAuthority([null, fetched], archive)).toBe(fetched);
  });

  it('skips an undefined tier the way it skips a null one', () => {
    expect(pickAuthority([undefined, fetched], archive)).toBe(fetched);
    expect(pickAuthority([undefined, null], archive)).toBe(archive);
  });

  it('answers the fallback when there are no preferred tiers at all', () => {
    expect(pickAuthority([], archive)).toBe(archive);
  });

  it('treats a falsy but present value as a winner — only null and undefined are empty', () => {
    expect(pickAuthority([0, 5], -1)).toBe(0);
    expect(pickAuthority(['', 'x'], 'fallback')).toBe('');
  });
});
