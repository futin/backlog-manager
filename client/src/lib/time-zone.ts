/**
 * time-zone.ts — the one home of wall-clock and calendar math on this board (#241).
 *
 * Every reading the board draws that depends on WHERE the reader is — a run's `HH:MM`, the Runs list's day groups and day headings, the today/week/month
 * windows, the tracker's rate-limit reset, a machine's usage reset, a card's created date for a full stamp, Archive's month groups — goes through a function
 * in this file, and every function here takes the zone as an explicit argument. The zone is a fact about the work, not about the screen: two devices looking at
 * the same run must read the same clock, the same day and the same week, so the board reads ONE zone, chosen on Settings › Shared and stored on the API host
 * (`~/.backlog-manager/settings/timezone.json`), and falls back to each browser's own zone only while nobody has chosen one. `useTimeZone` hands it out.
 *
 * Why one file, guarded by `test/time-zone-guard.test.ts`: a `Date`'s local getters (`getHours`, `getDay`, `setHours` …) and the locale formatters
 * (`toLocaleTimeString`, `toLocaleDateString`) silently read the BROWSER's zone, so a single one left anywhere else reintroduces exactly the disagreement this
 * setting removes, and nothing on screen would say which reading is the odd one out. Here, every reading is `Intl.DateTimeFormat` with `timeZone` set, and the
 * guard refuses those calls in every other client file.
 *
 * Pure functions, no `Date.now()` — `now` stays the caller's parameter, the convention `run-stats.ts` and `run-range.ts` state in their own headers.
 */

/** The calendar and clock fields of one instant, read in one zone. `month` is 1–12, `weekday` is `Date#getUTCDay` order (0 = Sunday), `hour` is 0–23. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

/** This browser's own zone — what every reading uses while the shared setting is unset. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * One formatter per zone id, built on first use and kept for the page's life. Constructing an `Intl.DateTimeFormat` is the expensive part — far more than
 * formatting with one — and the Runs list reads a clock per row per render, so this is a memo of formatters, never of answers: nothing it holds goes stale.
 *
 * `en-US` with numeric fields only, because only the NUMBERS are read off `formatToParts`, never the text — the locale decides nothing a reader sees.
 * `hourCycle: 'h23'` rather than `hour12: false`, which renders midnight as `24` on some engines and would print `24:30` for half past midnight.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric'
    });
    formatters.set(zone, f);
  }
  return f;
}

/**
 * The calendar date and clock `ms` reads as in `zone`.
 *
 * The weekday is derived from the date with `Date.UTC` rather than asked of the formatter: a calendar date's weekday is the same in every zone, and reading
 * it as a number avoids parsing a locale's weekday name. The `% 24` folds the `24` an engine that ignores `hourCycle` would print back to `0`.
 */
export function zonedParts(ms: number, zone: string): ZonedParts {
  const parts = formatterFor(zone).formatToParts(ms);
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const year = field('year');
  const month = field('month');
  const day = field('day');
  return {
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    hour: field('hour') % 24,
    minute: field('minute')
  };
}

/** The zone's offset from UTC at instant `ms`, in ms (east positive) — the gap between the wall clock `ms` reads as and `ms` itself, to the minute. */
function offsetAt(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - (ms - (((ms % 60_000) + 60_000) % 60_000));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Epoch ms of the first instant of the calendar day `year-month-day` in `zone` — what week and month stepping use: step the calendar DATE with `Date.UTC`
 * arithmetic, then convert it here, because adding multiples of 24 h to an instant lands an hour off on every day a DST change sits between.
 *
 * Local midnight is `wall − offset`, but the offset in force at midnight is the thing being solved for, and a DST day has two. So every offset the zone
 * shows within a day either side is tried, each candidate is kept only if it really reads as `year-month-day` in `zone`, and the earliest survivor wins:
 * - an ordinary day has one offset and one candidate, at 00:00;
 * - a day whose change is at 02:00 or 03:00 (most of Europe) keeps the midnight candidate and drops, or out-ranks, the other;
 * - a day whose spring-forward skips midnight itself (America/Santiago) has no 00:00 at all — the old offset's candidate reads 01:00, the first instant that
 *   exists, and that is the answer;
 * - a fall-back from 00:00 to the previous day's 23:00 leaves the old offset's candidate reading the previous day, so it is dropped and the second midnight —
 *   the one the day actually starts on — wins.
 */
export function zonedDayStart(year: number, month: number, day: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  const offsets = new Set([offsetAt(wall - MS_PER_DAY, zone), offsetAt(wall, zone), offsetAt(wall + MS_PER_DAY, zone)]);
  let best: number | null = null;
  for (const off of offsets) {
    const candidate = wall - off;
    const p = zonedParts(candidate, zone);
    if (p.year === year && p.month === month && p.day === day && (best === null || candidate < best)) best = candidate;
  }
  // Unreachable for any zone the platform ships — every day has an instant that reads as it — but a number is owed, and the plain conversion is the one
  // a day with no offset change would have produced.
  return best ?? wall - offsetAt(wall, zone);
}

/** Epoch ms of the first instant of the calendar day `ms` falls on in `zone`. */
export function startOfZonedDay(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  return zonedDayStart(p.year, p.month, p.day, zone);
}

function pad2(n: number): string {
  return `${n}`.padStart(2, '0');
}

/**
 * `HH:MM`, 24-hour and zero-padded, in `zone` — the one clock every surface prints. Hand-shaped rather than a locale's time string so it reads `09:59` on
 * every machine, never `9:59 AM` on one, and keeps its width in the mono columns it sits in.
 */
export function formatZonedClock(ms: number, zone: string): string {
  const p = zonedParts(ms, zone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * The zone a reading may actually be drawn in: `stored` when this browser's engine accepts it, else `browser`. The stored id was picked on whichever device
 * last saved it, from THAT engine's list, so a newer IANA id (`America/Coyhaique`) can reach a browser whose ICU predates it — and `Intl.DateTimeFormat`
 * throws a `RangeError` on an id it does not know, which mid-render takes the whole board down on that device, on every reload. Falling back to the
 * browser's own zone draws that one device as if the setting were unset; Settings still shows the stored id (`timeZoneOptions` keeps it), so the
 * disagreement is visible where it can be fixed.
 */
export function readableZone(stored: string | null, browser: string): string {
  if (stored === null) return browser;
  try {
    formatterFor(stored);
    return stored;
  } catch {
    return browser;
  }
}

/**
 * The Settings select's zones: every id the platform lists, plus `UTC` — which `Intl.supportedValuesOf('timeZone')` leaves out on current engines although
 * every engine accepts it — plus `current` when it is set and missing, so a stored zone this browser does not list still shows as the selected value rather
 * than the select silently reading as the first option. De-duplicated and sorted.
 */
export function timeZoneOptions(current: string | null): string[] {
  const zones = new Set(Intl.supportedValuesOf('timeZone'));
  zones.add('UTC');
  if (current !== null) zones.add(current);
  return [...zones].sort();
}
