import { formatZonedClock, readableZone, startOfZonedDay, timeZoneOptions, zoneOffsetLabel, zonedDayStart, zonedParts } from '../../client/src/lib/time-zone';

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

describe('readableZone', () => {
  it('is the stored zone when this engine accepts it', () => {
    expect(readableZone('Europe/Belgrade', 'America/New_York')).toBe('Europe/Belgrade');
  });

  it('is the browser zone while nothing is stored', () => {
    expect(readableZone(null, 'America/New_York')).toBe('America/New_York');
  });

  it('is the browser zone for a stored id this engine rejects, rather than throwing', () => {
    expect(readableZone('Mars/Olympus', 'America/New_York')).toBe('America/New_York');
  });
});

describe('zoneOffsetLabel', () => {
  const JAN = Date.UTC(2026, 0, 15, 12);
  const JUL = Date.UTC(2026, 6, 15, 12);

  it('prints a whole-hour offset bare and a part-hour one with its minutes', () => {
    expect(zoneOffsetLabel('Europe/Belgrade', JAN)).toBe('Europe/Belgrade · UTC+1');
    expect(zoneOffsetLabel('Asia/Kolkata', JAN)).toBe('Asia/Kolkata · UTC+5:30');
    expect(zoneOffsetLabel('Asia/Kathmandu', JAN)).toBe('Asia/Kathmandu · UTC+5:45');
  });

  it('prints a west offset with a minus, and zero as a bare UTC', () => {
    expect(zoneOffsetLabel('America/New_York', JAN)).toBe('America/New_York · UTC-5');
    expect(zoneOffsetLabel('America/St_Johns', JAN)).toBe('America/St_Johns · UTC-3:30');
    expect(zoneOffsetLabel('UTC', JAN)).toBe('UTC · UTC');
  });

  it('reads the offset in force at `now`, so a DST zone moves with the season', () => {
    expect(zoneOffsetLabel('Europe/Belgrade', JUL)).toBe('Europe/Belgrade · UTC+2');
  });

  it('returns the bare id for a zone this engine rejects, instead of throwing', () => {
    expect(zoneOffsetLabel('Mars/Olympus', JAN)).toBe('Mars/Olympus');
  });
});
