/**
 * The one thing that has to happen BEFORE the jest runtime boots: pin the
 * timezone.
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
 * dependency bump. The side effect — the whole suite now runs in ONE zone
 * rather than the developer's — is deliberate and an improvement: every other
 * date-sensitive suite here is already written to be zone-agnostic, and a
 * fixed zone makes a machine-dependent failure impossible rather than merely
 * unlikely. An explicit `TZ` in the environment still wins, so a run can be
 * pointed at another zone to check that agnosticism on purpose.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.TZ === undefined) process.env.TZ = 'America/New_York';
}
