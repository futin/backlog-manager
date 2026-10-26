import { startOfZonedDay, zonedDayStart, zonedParts } from './time-zone';

/**
 * run-range.ts — calendar windows behind the Runs section's Today / This
 * week / This month / All range control (design doc: "Range").
 *
 * The board's shared zone (`zone`, from `useTimeZone`, #241), not UTC — the
 * same reason `run-stats.ts`'s `dayKey` gives for grouping the run list by
 * that zone's day: a run that finished at 23:40 is "today's run" to whoever is
 * looking at the Runs section right now, and a UTC-anchored midnight would
 * silently move that run into "yesterday" for anyone west of Greenwich. And
 * one zone for every device, because the zone is a fact about the work, not
 * the screen: a phone and a laptop must agree on which runs are this week's.
 * `dayKey` and
 * this module have to agree on what "today" means for the same underlying
 * reason too — a run sitting under today's day-group heading but excluded
 * from the Today range control would be a visible self-contradiction on the
 * same screen.
 *
 * Keyed on `startedAt`, not `updatedAt` or any other stamp on the run — the
 * same field `dayKey`/`dayLabel` already group the run list by, so a run
 * inside a given day-group is always inside the matching range: the two
 * groupings of the same list can never disagree about which runs are
 * "today's".
 *
 * Calendar-aligned windows, not rolling ones: "today" is midnight in the shared zone
 * through now, not "the last 24 hours", and "this week" is Monday through
 * Sunday, not "the last 7 days". A rolling window's boundary moves on every
 * render, so a run could drift in and out of "this week" between two polls
 * with nothing about the run itself having changed; a calendar window stays
 * fixed for as long as `now`'s own calendar day, week, or month does not
 * change, and it is what a person actually means when they say "today" or
 * "this week" out loud.
 *
 * Pure arithmetic only — no fetching, no React, no `Date.now()` called
 * internally. `now` is always a parameter — the same convention
 * `run-stats.ts`'s own file header states outright ("`now` is always a
 * parameter, never read internally via `Date.now()`") — for the reason that
 * header credits to `RunDrawer.tsx`: a caller rendering several of these
 * against one screen has to take a single clock reading and thread it
 * through everything, or two reads a millisecond apart can disagree about
 * which side of a boundary "now" falls on.
 */

/** The four range choices, in the toolbar's left-to-right order. */
export const RUN_RANGES = ['today', 'week', 'month', 'all'] as const;

/** One of `RUN_RANGES`'s members. */
export type RunRange = (typeof RUN_RANGES)[number];

/** Button copy, in the toolbar: Today / This week / This month / All */
export const RANGE_BUTTON: Record<RunRange, string> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  all: 'All'
};

/**
 * Scope copy, in the wide tile's substat: today / this week / this month /
 * all runs
 *
 * Its own literal Record rather than a `.toLowerCase()` of `RANGE_BUTTON`:
 * "All" lowercases to "all", not the "all runs" this copy actually reads, so
 * a derived transform would still need a special case for that one member —
 * two flat Records, one per surface, is the plainer shape than one Record
 * plus an exception.
 */
export const RANGE_SCOPE: Record<RunRange, string> = {
  today: 'today',
  week: 'this week',
  month: 'this month',
  all: 'all runs'
};

/**
 * Window start in `zone`'s calendar, as epoch ms; `null` for 'all' (no window).
 *
 * Every window is built off `now`'s calendar DATE in `zone`, because "this
 * week" and "this month" are both defined relative to today's own calendar
 * date, not to `now`'s raw millisecond — the time-of-day component is exactly
 * what a calendar-aligned window discards.
 *
 * `week` steps that date back to the Monday at or before it: `weekday` reads
 * 0 for Sunday through 6 for Saturday, so `(weekday + 6) % 7` turns Monday's
 * 1 into a 0-day step back (a Monday is already its own week start) and
 * Sunday's 0 into a 6-day step back — the one line that makes a Sunday belong
 * to the week that started six days earlier rather than reading as day zero
 * of a new one. The step is taken on the calendar date with `Date.UTC`
 * arithmetic, which rolls across a month boundary on its own, and only then
 * converted to an instant by `zonedDayStart` — never by subtracting 24 h
 * multiples from an instant, which lands an hour off whenever a DST change
 * sits inside the week.
 *
 * `month` is day 1 of that same calendar month, simpler than `week`'s offset
 * precisely because a month's start does not depend on which weekday `now`
 * happens to fall on.
 */
export function rangeStart(range: RunRange, now: number, zone: string): number | null {
  if (range === 'all') return null;

  if (range === 'today') return startOfZonedDay(now, zone);

  const today = zonedParts(now, zone);

  if (range === 'week') {
    const daysSinceMonday = (today.weekday + 6) % 7;
    const monday = new Date(Date.UTC(today.year, today.month - 1, today.day - daysSinceMonday));
    return zonedDayStart(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), zone);
  }

  // range === 'month'
  return zonedDayStart(today.year, today.month, 1, zone);
}

/**
 * Is a run whose `startedAt` is this ISO string inside the window?
 *
 * `'all'` short-circuits through `rangeStart`'s own `null` before
 * `startedAt` is ever parsed — there is no window to fall outside of, so a
 * corrupt stamp is not a reason to hide a run from the one range that is
 * asking for literally all of them. Every other range parses `startedAt`
 * itself; an unparseable stamp reads as `false` (out of range) rather than
 * throwing or defaulting to `true`, matching this codebase's rule that a
 * derivation over a hand-editable run file degrades to its safest output on
 * bad data instead of crashing the view that renders it. The comparison is
 * `>=`, not `>`: the window's own start instant belongs to the window.
 */
export function inRange(startedAt: string, range: RunRange, now: number, zone: string): boolean {
  const start = rangeStart(range, now, zone);
  if (start === null) return true;

  const at = Date.parse(startedAt);
  if (Number.isNaN(at)) return false;

  return at >= start;
}
