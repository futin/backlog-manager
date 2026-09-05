/**
 * The one thing that has to happen BEFORE the jest runtime boots: pin the
 * timezone, unconditionally.
 *
 * `test/run-range.test.ts`'s DST block needs a known zone, and the obvious
 * `process.env.TZ = ...` inside a `beforeAll` does not work: jest hands each
 * test file a COPY of `process.env` (a plain object), so the assignment lands
 * on the copy and never reaches the setter Node uses to invalidate its
 * timezone cache. Measured, not assumed — the env var read back as
 * `America/New_York` while `Date` kept answering in the host's own zone.
 *
 * `globalSetup` runs in jest's own process before any of that, so the
 * assignment here hits the REAL `process.env` and the cache invalidation it
 * carries; every suite then inherits the pinned zone (`--runInBand`, so there
 * is one process, and `pnpm test` sets that flag).
 *
 * `America/New_York` because its transition rules are rule-derived and stable
 * across tzdata releases ("second Sunday in March, first Sunday in November"
 * since 2007), so the dates run-range's DST cases assert will not move under a
 * dependency bump.
 *
 * THE ASSIGNMENT OVERRIDES AN INHERITED `TZ`, and that is the whole point
 * rather than an oversight. This started out as `if (process.env.TZ ===
 * undefined)`, on the reasoning that a developer running `TZ=UTC pnpm test`
 * deliberately should get UTC — but run-range's DST cases assert absolute
 * instants derived from New York's offsets (`2026-03-02T05:00:00Z` is Monday
 * local midnight there and nowhere else), so under any other zone they simply
 * fail. A conditional pin therefore did not "let an explicit TZ win"; it let
 * an explicit TZ turn four passing tests red, in a suite that was green in
 * every zone before the block existed. Reproduced: `TZ=UTC npx jest
 * test/run-range.test.ts` — 4 failures.
 *
 * The cost is real and is accepted knowingly: `TZ=<anything> pnpm test` can no
 * longer be used to check that the rest of the suite is zone-agnostic, because
 * this line discards the value. That property is now maintained by reading —
 * every other date-sensitive suite here builds its instants with the local
 * `Date` constructor rather than an ISO string, which is what makes it true —
 * rather than by being executable. Making it executable again would mean
 * running the DST cases in their own process with their own `TZ`, which is a
 * larger mechanism than four assertions are worth. The compensating guarantee
 * is that the zone is now the same on every machine and in CI, so a
 * date-sensitive failure cannot depend on whose laptop ran it.
 */
export default async function globalSetup(): Promise<void> {
  process.env.TZ = 'America/New_York';
}
