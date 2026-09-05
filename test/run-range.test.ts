import { RUN_RANGES, RANGE_BUTTON, RANGE_SCOPE, rangeStart, inRange } from '../client/src/lib/run-range';
import type { RunRange } from '../client/src/lib/run-range';

/**
 * The calendar-window arithmetic behind the Runs section's Today / This
 * week / This month / All range control (Task 1 of the Runs view redesign —
 * nothing here renders anything; `RunsView`, Task 7, is the only consumer).
 *
 * Every `now` is built with the local `Date` constructor
 * (`new Date(2026, 8, 2, 14, 7)`), never an ISO string or `Date.UTC(...)`:
 * this suite has to pass in whatever timezone happens to run it, and
 * `rangeStart` reads `now` through `new Date(now)` plus local getters and
 * setters (`getDay`, `setHours`, `setDate`). A `now` built from an ISO string
 * would already be pinned to a specific offset before the arithmetic under
 * test ever sees it, which would make the suite assert something true only
 * in the runner's own timezone. 2026-08-31 is a Monday and 2026-09-06 is a
 * Sunday — checked against a real calendar, not assumed — and the week cases
 * below depend on both.
 */

/**
 * `now` (or a `startedAt` instant) from local calendar fields. Month is
 * 0-indexed, matching `Date`'s own constructor — `8` is September, not `9`.
 */
function local(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  return new Date(year, month, day, hour, minute, second, ms).getTime();
}

describe('rangeStart', () => {
  // Case 1: the plainest window there is — local midnight of `now`.
  it('today is local midnight of `now`', () => {
    const now = local(2026, 8, 2, 14, 7); // Wed 2 Sep, mid-afternoon
    expect(rangeStart('today', now)).toBe(local(2026, 8, 2));
  });

  // Case 2: the preceding Monday, not a rolling 7-day lookback.
  it('week starts on the Monday at or before `now`, at local midnight', () => {
    const now = local(2026, 8, 2, 14, 7); // Wed 2 Sep
    expect(rangeStart('week', now)).toBe(local(2026, 7, 31)); // Mon 31 Aug
  });

  // Case 3: the case the Monday-based (not Sunday-based) rule exists for —
  // a Sunday is the LAST day of its own week, not the first day of the next.
  it('a Sunday belongs to the week that started six days earlier, not the next Monday', () => {
    const now = local(2026, 8, 6, 23, 59); // Sun 6 Sep, one minute before midnight
    expect(rangeStart('week', now)).toBe(local(2026, 7, 31)); // still Mon 31 Aug
  });

  // Case 4: the boundary is a fixed point — a Monday midnight does not step
  // back to the PREVIOUS Monday.
  it('a Monday at exact midnight is its own week start', () => {
    const now = local(2026, 7, 31, 0, 0, 0, 0); // Mon 31 Aug, exact midnight
    expect(rangeStart('week', now)).toBe(now);
  });

  // Case 5a: the 1st of the month, not a rolling 30-day lookback.
  it('month starts on the 1st at local midnight', () => {
    expect(rangeStart('month', local(2026, 8, 2, 14, 7))).toBe(local(2026, 8, 1));
  });

  // Case 5b: same fixed-point shape as case 4, one calendar rung up.
  it('the 1st at exact midnight is its own month start', () => {
    const now = local(2026, 8, 1, 0, 0);
    expect(rangeStart('month', now)).toBe(now);
  });

  // Case 6: no window at all, independent of whatever `now` is.
  it('all has no window, regardless of now', () => {
    expect(rangeStart('all', local(2026, 8, 2, 14, 7))).toBeNull();
    expect(rangeStart('all', local(2020, 0, 1))).toBeNull();
  });
});

describe('inRange', () => {
  // Case 7: inclusive at the boundary — `at >= start`, not `at > start`.
  it('is inclusive at the window boundary: the boundary instant is in, one ms earlier is out', () => {
    const now = local(2026, 8, 2, 14, 7); // Wed 2 Sep 14:07
    const boundary = local(2026, 8, 2); // local midnight — the 'today' window start case 1 pins
    expect(inRange(new Date(boundary).toISOString(), 'today', now)).toBe(true);
    expect(inRange(new Date(boundary - 1).toISOString(), 'today', now)).toBe(false);
  });

  // Case 8 (windowed half): a stamp that will not parse can never be inside
  // an actual window — there is nothing to compare `NaN` against.
  it('an unparseable startedAt is out of every windowed range', () => {
    const now = local(2026, 8, 2, 14, 7);
    const ranges: RunRange[] = ['today', 'week', 'month'];
    for (const range of ranges) {
      expect(inRange('garbage', range, now)).toBe(false);
    }
  });

  // Case 8 ('all' half): 'all' short-circuits before the stamp is ever
  // parsed, so a corrupt `startedAt` does not hide a run from the one range
  // that is asking for literally everything.
  it("an unparseable startedAt is still in for 'all' — there is no window to fall outside of", () => {
    expect(inRange('garbage', 'all', local(2026, 8, 2, 14, 7))).toBe(true);
  });
});

describe('RUN_RANGES / RANGE_BUTTON / RANGE_SCOPE', () => {
  // Case 9.
  it('RUN_RANGES lists all four ranges in toolbar order', () => {
    expect(RUN_RANGES).toEqual(['today', 'week', 'month', 'all']);
  });

  // Case 9.
  it('RANGE_BUTTON is the toolbar button copy', () => {
    expect(RANGE_BUTTON).toEqual({
      today: 'Today',
      week: 'This week',
      month: 'This month',
      all: 'All'
    });
  });

  // Case 9.
  it('RANGE_SCOPE is the wide tile substat copy', () => {
    expect(RANGE_SCOPE).toEqual({
      today: 'today',
      week: 'this week',
      month: 'this month',
      all: 'all runs'
    });
  });
});

/**
 * DST. `rangeStart` does all of its arithmetic in local time —
 * `setHours(0, 0, 0, 0)` and `setDate(...)` — and no case above crosses a
 * transition, so the local-time behaviour under one had never been pinned.
 *
 * This block needs a KNOWN zone where every case above is deliberately
 * zone-agnostic, and it gets one from `test/helpers/global-setup.ts`
 * (`America/New_York`, chosen because US transition rules are rule-derived and
 * stable across tzdata releases — "second Sunday in March, first Sunday in
 * November" since 2007 — so 2026-03-08 and 2026-11-01 will not move under a
 * dependency bump).
 *
 * The pin lives in `globalSetup` rather than in a `beforeAll` here because a
 * `beforeAll` DOES NOT WORK, measured rather than assumed: jest gives each
 * test file a copy of `process.env`, so `process.env.TZ = ...` lands on the
 * copy and never reaches the setter Node uses to invalidate its timezone
 * cache — the variable reads back correctly while `Date` keeps answering in
 * the host's own zone. Case 6 below is the guard against that reappearing;
 * nothing else in this block means anything if it fails. There is
 * correspondingly nothing to restore afterwards — the zone is the whole run's,
 * not this block's, so no suite can leak it into another.
 *
 * Deliberately NOT covered: the sharper "local midnight does not exist on this
 * day" case, which needs a zone that transitions AT midnight (e.g.
 * `America/Santiago`, where `setHours(0, 0, 0, 0)` yields 01:00). Those zones'
 * transition dates are politically volatile and change between tzdata
 * releases, so a test pinned to one would go flaky for a reason that has
 * nothing to do with this code. The omission is a choice, not an oversight.
 */
describe('rangeStart / inRange across DST transitions', () => {
  // Case 6: the pin itself. Everything below is meaningless if the zone is not
  // the one asserted, and a wrong-zone run would fail the later cases with
  // confusing arithmetic rather than saying why — so assert the zone first, on
  // a known instant. 2026-03-11 is inside EDT (UTC−4).
  it('the global TZ pin reached Date (2026-03-11T12:00:00Z is 08:00 local)', () => {
    expect(new Date(Date.parse('2026-03-11T12:00:00Z')).getHours()).toBe(8);
  });

  // Case 7: spring-forward. `now` is on the transition DAY itself, so the
  // `setDate(getDate() - 6)` walk back to Monday crosses the transition: it
  // starts from a local day at UTC−4 and has to land on a local midnight at
  // UTC−5. (The plan this task came from named Wed 11 Mar here, which crosses
  // nothing — the week Mon 9 – Sun 15 Mar is entirely inside EDT. Sunday 8 Mar
  // belongs to the PRECEDING week, and that is the week with the seam in it.)
  //
  // The resulting window is calendar-aligned, not duration-aligned: Mon 2 Mar
  // 00:00 EST through Mon 9 Mar 00:00 EDT is 6 days and 23 hours of real time,
  // and that is the correct answer, not an off-by-one-hour bug.
  it('week starts at the preceding Monday local midnight across spring-forward', () => {
    const now = Date.parse('2026-03-08T17:00:00Z'); // Sun 8 Mar, 12:00 EDT — transition day
    expect(rangeStart('week', now)).toBe(Date.parse('2026-03-02T05:00:00Z')); // Mon 2 Mar 00:00 EST
  });

  // Case 8: the same boundary read through `inRange`. The window's own start
  // instant is in (`>=`), one second earlier is out, and a run from the
  // Saturday before that Monday is out — all three read across the transition,
  // since `now` is on the far side of it.
  it('inRange holds either side of the week boundary across spring-forward', () => {
    const now = Date.parse('2026-03-08T17:00:00Z');
    expect(inRange('2026-03-02T05:00:00Z', 'week', now)).toBe(true); // Mon 2 Mar, 00:00 EST
    expect(inRange('2026-03-02T04:59:59Z', 'week', now)).toBe(false); // one second earlier
    expect(inRange('2026-02-28T17:00:00Z', 'week', now)).toBe(false); // Sat 28 Feb, 12:00 EST
  });

  // Case 9: fall-back. The month starts at 2026-11-01 00:00 EDT — still
  // daylight time, because midnight precedes the 02:00 transition and so
  // precedes both of that day's two 01:00s.
  it('month starts at the first of the month at local midnight across fall-back', () => {
    const now = Date.parse('2026-11-15T17:00:00Z'); // Sun 15 Nov, 12:00 EST
    expect(rangeStart('month', now)).toBe(Date.parse('2026-11-01T04:00:00Z')); // 1 Nov 00:00 EDT
  });
});
