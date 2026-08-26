const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between a `YYYY-MM-DD` frontmatter date and now, or null when the
 * string is not one the board can age (empty, or anything Date.parse rejects).
 *
 * A port of ageDaysSince in `skills/backlog/tools/backlog.mjs`, kept to the
 * same two rules for the same reasons: the `T00:00:00Z` suffix pins the
 * comparison to UTC, so one file does not read "1d" in Auckland and "0d" in
 * Los Angeles; and the result is clamped at 0, because a future date is a
 * hand-edited file and "started today" is the closest true thing to say about
 * one — a negative age reads as a bug in the board itself.
 *
 * Returning null rather than throwing on a bad date is what lets the card
 * render `in progress` without an age instead of `in progress NaNd`: nothing
 * validates the shape of `started` on the way in, since a person can type
 * anything into an item file.
 */
export function daysSince(date: string, now: number = Date.now()): number | null {
  const then = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / MS_PER_DAY));
}
