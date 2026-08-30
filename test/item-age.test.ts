import { daysSince, elapsedSince, formatCreated, formatSeconds } from '../client/src/lib/item-age';

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

/**
 * The card's in-progress label. Same injected-`now` convention and same UTC
 * parsing as daysSince above; what is new is that the answer has four shapes
 * rather than one number, because "someone picked this up 20 minutes ago" and
 * "someone picked this up 11 days ago" are different facts and a single unit
 * cannot carry both.
 */
describe('elapsedSince', () => {
  const at = (iso: string): number => Date.parse(iso);
  const STAMP = '2026-08-28T12:00:00Z';

  // Under a minute is a word, not `0m`: a session that started this second is
  // the one case where a number tells you less than plain language does.
  it('reads "now" for the first minute', () => {
    expect(elapsedSince(STAMP, at('2026-08-28T12:00:00Z'))).toBe('now');
    expect(elapsedSince(STAMP, at('2026-08-28T12:00:59Z'))).toBe('now');
  });

  it('counts floored minutes up to the hour', () => {
    expect(elapsedSince(STAMP, at('2026-08-28T12:01:00Z'))).toBe('1m');
    expect(elapsedSince(STAMP, at('2026-08-28T12:20:30Z'))).toBe('20m');
    expect(elapsedSince(STAMP, at('2026-08-28T12:59:59Z'))).toBe('59m');
  });

  it('counts floored hours up to the day', () => {
    expect(elapsedSince(STAMP, at('2026-08-28T13:00:00Z'))).toBe('1h');
    expect(elapsedSince(STAMP, at('2026-08-28T15:00:00Z'))).toBe('3h');
    expect(elapsedSince(STAMP, at('2026-08-29T11:59:59Z'))).toBe('23h');
  });

  it('counts floored days from a full day on', () => {
    expect(elapsedSince(STAMP, at('2026-08-29T12:00:00Z'))).toBe('1d');
    expect(elapsedSince(STAMP, at('2026-09-04T12:00:00Z'))).toBe('7d');
  });

  // A timestamp ahead of now is a hand-edited file. Clamping to the bottom of
  // the ladder rather than going negative, for the reason daysSince clamps to
  // 0: "-2h in progress" reads as a bug in the board.
  it('clamps a future timestamp to the bottom of the ladder', () => {
    expect(elapsedSince(STAMP, at('2026-08-28T11:00:00Z'))).toBe('now');
  });

  /**
   * Every file written before `start` stamped a time carries a bare date, and
   * nothing rewrites them — so this branch is permanent, not a migration
   * window. A bare date genuinely does not carry an hour, so it is aged in
   * days only: reading "14h" off `2026-08-26` would be inventing the hour the
   * work began out of UTC midnight.
   */
  describe('a legacy date-only value', () => {
    it('reads "today" on the day itself, then whole days', () => {
      expect(elapsedSince('2026-08-26', at('2026-08-26T09:00:00Z'))).toBe('today');
      expect(elapsedSince('2026-08-26', at('2026-08-26T23:59:59Z'))).toBe('today');
      expect(elapsedSince('2026-08-26', at('2026-08-27T00:00:00Z'))).toBe('1d');
      expect(elapsedSince('2026-08-26', at('2026-09-02T12:00:00Z'))).toBe('7d');
    });

    it('clamps a future date to "today"', () => {
      expect(elapsedSince('2026-09-05', at('2026-09-01T00:00:00Z'))).toBe('today');
    });
  });

  // null rather than a string, so the caller can render the in-progress bar
  // without an elapsed instead of printing NaN into it. Nothing validates the
  // shape of `started` on the way in — a person can type anything.
  it('returns null for anything it cannot parse', () => {
    expect(elapsedSince('', at('2026-08-28T12:00:00Z'))).toBeNull();
    expect(elapsedSince('soon', at('2026-08-28T12:00:00Z'))).toBeNull();
    expect(elapsedSince('2026-13-45', at('2026-08-28T12:00:00Z'))).toBeNull();
    expect(elapsedSince('2026-08-28T99:00:00Z', at('2026-08-28T12:00:00Z'))).toBeNull();
  });
});

/**
 * The card's created date. Months come from a hardcoded array rather than
 * toLocaleString: the output must not depend on the browser's locale, or two
 * machines looking at the same board read different dates.
 */
describe('formatCreated', () => {
  const at = (iso: string): number => Date.parse(iso);
  const NOW = at('2026-08-28T12:00:00Z');

  it('drops the year for the current year, and the leading zero from the day', () => {
    expect(formatCreated('2026-08-20', NOW)).toBe('aug 20');
    expect(formatCreated('2026-01-05', NOW)).toBe('jan 5');
  });

  // Two digits, apostrophe-prefixed, and only when the year differs: the board
  // is overwhelmingly current-year items, so a repeated '26 on every card is
  // noise that crowds out the part that varies.
  it('carries a two-digit year when it is not the current one', () => {
    expect(formatCreated('2025-12-31', NOW)).toBe("dec 31 '25");
    expect(formatCreated('2027-03-01', NOW)).toBe("mar 1 '27");
  });

  // Verbatim rather than null or a placeholder: an unparseable `created` is a
  // hand-edited file, and showing what is actually in it is what lets someone
  // find and fix the line. Empty stays empty so the caller can drop the
  // separator with it.
  it('passes anything it cannot parse straight through', () => {
    expect(formatCreated('', NOW)).toBe('');
    expect(formatCreated('whenever', NOW)).toBe('whenever');
    expect(formatCreated('2026-13-45', NOW)).toBe('2026-13-45');
  });
});

/**
 * The drawer's accumulated-time reading — `groomElapsed`/`executeElapsed` are
 * whole seconds, not an instant to diff against `now`, so this is a pure
 * formatter rather than another `elapsedSince`-shaped clock function.
 *
 * Only two rungs, not three: `elapsedSince` above needs a days rung because a
 * card's `started` marker can be weeks old and still be true, live, ongoing
 * work. Accumulated time is billed, closed seconds — nobody accrues 24 real
 * hours of active grooming or execution, and the day-of-precision that made
 * sense for "how long has this been open" would only make an unusually large
 * number look smaller than it is here. So minutes and hours are the whole
 * ladder, and both floor: `90` seconds is short of two full minutes, so it
 * reads `1m`, not `1m 30s` — seconds stop being interesting once minutes
 * exist to hold the value, which is also why the hours rung drops the minutes
 * remainder entirely instead of chaining a third unit onto it. The minutes
 * remainder on the hours rung is kept only when it is non-zero: `3600` is a
 * clean hour and `3600 · ' 0m'` would be noise, while `3660` genuinely needs
 * the extra minute to be exact.
 */
describe('formatSeconds', () => {
  it.each([
    [0, '0s'],
    [1, '1s'],
    [59, '59s'],
    [60, '1m'],
    [90, '1m'],
    [3599, '59m'],
    [3600, '1h'],
    [3660, '1h 1m'],
    [7860, '2h 11m'],
    [86400, '24h']
  ])('formats %i seconds as %s', (input, expected) => {
    expect(formatSeconds(input)).toBe(expected);
  });
});
