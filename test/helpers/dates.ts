/**
 * dates.ts — the one home for "a fixture date, expressed against the clock the assertion will run under" (bug-44).
 *
 * A jsdom suite that renders the Board has two clocks in it. One is the fixture's date, written the day the case was authored; the other is the real
 * clock `useNow` reads inside `BoardView`, which `leavesBoard` → `isStale` → `lastTouched` compare that date against. Nothing injects an instant
 * between them, so an absolute literal is not a constant — it is an expiry date. A fixture created `2026-08-20` with no `updated` is thirty days from
 * `staleDays`, so the card renders for thirty days and then silently stops rendering, and every `getByText` that wanted it starts throwing. Three cases
 * across two suites went red exactly that way on 2026-09-20, with nothing changed.
 *
 * So: never an absolute date in a fixture. Both functions below are relative to `Date.now()` and both read it AT CALL TIME rather than at module load,
 * which is what lets a suite install a fake clock in `beforeEach` and still get a date that agrees with it — a module-level constant would have been
 * computed against the real clock before the fake one existed.
 *
 * Two functions rather than one because the shapes are not interchangeable and the fields that carry them are not either: `created` is a date (the
 * `YYYY-MM-DD` `backlog.mjs` writes into frontmatter), while `updated`, `lastCommit` and `started` are second-precision UTC stamps. They were already
 * hand-rolled three times before this file existed — `board.test.tsx`'s `daysAgoDate` returned the first shape and `archive.test.tsx`'s and
 * `dialog-escape.test.tsx`'s `daysAgo` returned the second, under names one letter apart. The two exported names here keep that distinction visible,
 * which is the whole reason they are not one function with a flag. Same "one implementation" rule `listenLoopback` follows in `test/helpers/app.ts`.
 *
 * `test/fixture-clock.test.ts` is the guard that keeps absolute literals from coming back; it reads the source of every `test/*.test.tsx` because
 * behaviour cannot catch this class — a fresh absolute date is green on the day it is written and for thirty days afterwards.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD`, `days` days before now — the shape `created` carries. */
export function daysAgoDate(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH:MM:SSZ`, `days` days before now — the second-precision shape `updated`, `lastCommit` and `started` carry. */
export function daysAgoStamp(days: number): string {
  return `${new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 19)}Z`;
}
