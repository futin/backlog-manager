import { daysSince } from '../client/src/lib/item-age';

/**
 * `now` is injected in every case below rather than mocked globally: the whole
 * function is one subtraction, and a test that has to freeze the clock to say
 * anything about it is a test of the clock. Dates are compared in UTC — the
 * same convention backlog.mjs's ageDaysSince uses — so a card cannot read "1d"
 * on a machine in Auckland and "0d" on one in Los Angeles for the same file.
 */
describe('daysSince', () => {
  const at = (iso: string): number => Date.parse(iso);

  it('counts whole days, and 0 for the day the work started', () => {
    expect(daysSince('2026-08-26', at('2026-08-26T09:00:00Z'))).toBe(0);
    expect(daysSince('2026-08-26', at('2026-08-26T23:59:59Z'))).toBe(0);
    expect(daysSince('2026-08-26', at('2026-08-27T00:00:00Z'))).toBe(1);
    expect(daysSince('2026-08-19', at('2026-08-26T12:00:00Z'))).toBe(7);
  });

  // A date in the future is a hand-edited file, not a state the tool can
  // produce. Clamping beats a negative age: "-3d in progress" reads as a bug in
  // the board, while 0d reads as "started today", which is the closest true
  // thing the card can say.
  it('clamps a future date to 0 rather than going negative', () => {
    expect(daysSince('2026-09-01', at('2026-08-26T12:00:00Z'))).toBe(0);
  });

  // Nothing in the pipeline validates the shape of `started` — the CLI writes
  // it, but a person can type anything into the file. null lets the caller drop
  // the age and still render the marker, which is strictly more useful than
  // "NaNd".
  it('returns null for anything it cannot parse, including an empty date', () => {
    expect(daysSince('', at('2026-08-26T12:00:00Z'))).toBeNull();
    expect(daysSince('soon', at('2026-08-26T12:00:00Z'))).toBeNull();
    expect(daysSince('2026-13-45', at('2026-08-26T12:00:00Z'))).toBeNull();
  });
});
