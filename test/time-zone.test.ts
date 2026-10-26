import { formatZonedClock, startOfZonedDay, timeZoneOptions, zonedDayStart, zonedParts } from '../client/src/lib/time-zone';

/**
 * The zone helper every board reading goes through (#241). Every case names its zone, so nothing here depends on the `TZ` the run happens under — the
 * global `America/New_York` pin (`test/helpers/global-setup.ts`) included. Instants are UTC; the expected values were computed with `Intl` and checked by hand
 * against each zone's offset on that day.
 */
const at = (iso: string): number => Date.parse(iso);

describe('zonedParts', () => {
  const ms = at('2026-09-01T22:30:00Z');

  it.each([
    ['UTC', { year: 2026, month: 9, day: 1, weekday: 2, hour: 22, minute: 30 }],
    ['Europe/Belgrade', { year: 2026, month: 9, day: 2, weekday: 3, hour: 0, minute: 30 }],
    ['America/New_York', { year: 2026, month: 9, day: 1, weekday: 2, hour: 18, minute: 30 }],
    ['Asia/Kolkata', { year: 2026, month: 9, day: 2, weekday: 3, hour: 4, minute: 0 }]
  ])('reads 2026-09-01T22:30Z in %s', (zone, expected) => {
    expect(zonedParts(ms, zone)).toEqual(expected);
  });

  it('reads the hour before a DST jump as the old offset', () => {
    expect(zonedParts(at('2026-03-29T00:30:00Z'), 'Europe/Belgrade')).toMatchObject({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 });
  });
});

describe('startOfZonedDay', () => {
  it('a DST-start day starts at the old offset’s midnight', () => {
    expect(startOfZonedDay(at('2026-03-29T12:00:00Z'), 'Europe/Belgrade')).toBe(at('2026-03-28T23:00:00Z'));
  });

  it('a DST-end day starts at the summer offset’s midnight', () => {
    expect(startOfZonedDay(at('2026-10-25T12:00:00Z'), 'Europe/Belgrade')).toBe(at('2026-10-24T22:00:00Z'));
  });

  it('a half-hour offset', () => {
    expect(startOfZonedDay(at('2026-10-01T20:00:00Z'), 'Asia/Kolkata')).toBe(at('2026-10-01T18:30:00Z'));
  });

  it('a day whose midnight does not exist starts at the first instant that does (01:00)', () => {
    expect(startOfZonedDay(at('2026-09-06T15:00:00Z'), 'America/Santiago')).toBe(at('2026-09-06T04:00:00Z'));
  });

  it('agrees with zonedDayStart on the calendar date', () => {
    expect(zonedDayStart(2026, 3, 29, 'Europe/Belgrade')).toBe(at('2026-03-28T23:00:00Z'));
  });
});

describe('formatZonedClock', () => {
  it('prints half past midnight as 00:30, never 24:30', () => {
    expect(formatZonedClock(at('2026-09-01T22:30:00Z'), 'Europe/Belgrade')).toBe('00:30');
  });
});

describe('timeZoneOptions', () => {
  it('lists UTC and the platform zones, sorted', () => {
    const zones = timeZoneOptions(null);
    expect(zones).toContain('UTC');
    expect(zones).toContain('Europe/Belgrade');
    expect(zones).toEqual([...zones].sort());
  });

  it('keeps a stored zone the platform does not list', () => {
    expect(timeZoneOptions('Mars/Olympus')).toContain('Mars/Olympus');
  });
});
