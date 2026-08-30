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
 *
 * No component calls this directly any more — `elapsedSince` below is what the
 * card and the drawer read, and it delegates here for a bare `YYYY-MM-DD`. Still
 * exported and still separately tested, because this is where the day-level rule
 * and the UTC convention are actually specified.
 */
export function daysSince(date: string, now: number = Date.now()): number | null {
  const then = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / MS_PER_DAY));
}

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * The two shapes `started` can have on disk. `start` writes the timestamp, but
 * every file stamped before it did carries a bare date, and nothing in the
 * pipeline rewrites an existing item's frontmatter — so this is a permanent
 * fork in the parser, not a migration window that closes.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How long ago work was picked up, as the string the card prints: `now`, `20m`,
 * `3h`, `11d` — or null when the value cannot be aged at all.
 *
 * The ladder exists because one unit cannot carry the whole range. A session
 * started twenty minutes ago and one started eleven days ago are different
 * facts about whether anyone is actually on this right now, and days-only
 * rounded the first to `0d`, which read as "nothing has happened yet". Each rung
 * floors: `59m` holds until the hour is complete, `23h` until the day is.
 *
 * A date-only value is aged in DAYS ONLY, never promoted to the hours rung. A
 * bare date carries no hour, and the elapsed time from UTC midnight is not the
 * elapsed time from whenever the person actually started — printing `14h` off
 * `2026-08-26` would be inventing that hour. `today` rather than `0d` for the
 * same reason `now` beats `0m`.
 *
 * Clamped at the bottom of the ladder rather than going negative, and null
 * rather than throwing, for the two reasons daysSince has: a future value means
 * a hand-edited file, and `-2h in progress` reads as a bug in the board, while
 * a null lets the caller render the marker without an elapsed instead of
 * printing `NaNm` into it.
 */
export function elapsedSince(started: string, now: number = Date.now()): string | null {
  if (DATE_ONLY.test(started)) {
    const days = daysSince(started, now);
    if (days === null) return null;
    return days === 0 ? 'today' : `${days}d`;
  }

  const then = Date.parse(started);
  if (Number.isNaN(then)) return null;

  const ms = Math.max(0, now - then);
  if (ms < MS_PER_MINUTE) return 'now';
  if (ms < MS_PER_HOUR) return `${Math.floor(ms / MS_PER_MINUTE)}m`;
  if (ms < MS_PER_DAY) return `${Math.floor(ms / MS_PER_HOUR)}h`;
  return `${Math.floor(ms / MS_PER_DAY)}d`;
}

/**
 * Hardcoded rather than toLocaleString('en', { month: 'short' }): the board is
 * a shared view of shared files, and a date that renders `aug` on one machine
 * and `ago` on another (Catalan, same abbreviation slot) is a date two people
 * cannot talk about. Lowercase to sit with the mono meta line it prints into
 * rather than shouting over it.
 */
const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/**
 * A `created` date short enough to share the card's foot with the item id:
 * `aug 20`, or `dec 31 '25` when the year is not the one we are in.
 *
 * The year is conditional because the board is overwhelmingly current-year
 * items — a `'26` repeated down every card is noise crowding out the half that
 * varies, while its absence is itself the signal "this year".
 *
 * An unparseable value comes back VERBATIM rather than as null or a placeholder.
 * `created` is written by the CLI but lives in a file a person can edit, and
 * showing what is actually on the line is what lets them find and fix it;
 * `''` stays `''` so the caller can drop the separator along with it.
 */
export function formatCreated(created: string, now: number = Date.now()): string {
  const then = Date.parse(`${created}T00:00:00Z`);
  if (Number.isNaN(then)) return created;

  const date = new Date(then);
  const month = MONTHS[date.getUTCMonth()];
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();

  if (year === new Date(now).getUTCFullYear()) return `${month} ${day}`;
  return `${month} ${day} '${`${year}`.slice(-2)}`;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/**
 * The drawer's accumulated-time reading for `groomElapsed`/`executeElapsed`:
 * a whole-seconds total that was billed and closed, not an instant to diff
 * against `now` the way `elapsedSince` above does — so this takes a duration
 * directly rather than a stamp and a clock.
 *
 * Two rungs, not three. `elapsedSince` needs a days rung because a card's
 * `started` marker can legitimately be weeks old and still describe ongoing
 * work; nobody accrues 24 real hours of continuous grooming or execution, so
 * a days rung here would only ever fire on a hand-edited or clock-skewed
 * file, and hiding a full day of real billed time behind `1d` would read as
 * LESS work than `24h` does — the reason days are explicitly not a unit,
 * called out in this task's brief. Both remaining rungs floor, matching
 * `elapsedSince`'s convention: a total short of the next whole unit reads as
 * the unit below it rather than rounding up and overclaiming.
 *
 * The hours rung keeps its minutes remainder only when it is non-zero:
 * `3600` is a clean hour and appending `0m` to it is noise with no
 * information in it, while `3660` genuinely needs the extra minute to be
 * exact. The minutes rung drops any leftover seconds outright rather than
 * chaining a third unit the way `3600` keeps its minutes — once the total
 * clears a minute, the remaining seconds are not interesting: `90` reads
 * `1m`, not `1m 30s`.
 *
 * `groomElapsed`/`executeElapsed` are already whole non-negative integers by
 * the time they reach here (BacklogItem clamps a hand-edited negative,
 * fractional, or non-numeric value on disk to `0` — see shared/types.ts), so
 * this guard is not load-bearing for any real caller. It exists anyway for
 * the same reason the rest of this module returns a safe default instead of
 * letting a bad input reach the DOM: a future caller passing an untrusted
 * number should get `0s` rather than `NaNs`.
 */
export function formatSeconds(total: number): string {
  const seconds = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;

  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;

  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  }

  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
