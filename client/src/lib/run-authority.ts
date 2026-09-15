/**
 * The ONE rule for "which object describes this run right now" — `live ?? fetched ?? archive`, in decreasing order of freshness. Both `RunsView.tsx` (the list
 * row) and `RunDetail.tsx` (the pane beside it) call it rather than hand-rolling a `??` chain each, because a whole-branch review found their two hand-rolled
 * chains disagreeing. What each tier is, why `live` is passed here even when it is not `fresh` (bug-29), and why the list rows legitimately omit the middle
 * argument are all in docs/subsystems/invariants.md#which-object-describes-a-run-right-now--the-three-tiers-behind-pickauthority.
 *
 * Two type parameters, not one shared `T`: the tiers are not the same TypeScript shape. `OrchestratorRun` (live/fetched) and `OrchestratorArchiveRun` (archive)
 * diverge on their queue items' `verification` field — full `RunVerification` with a `tail` vs. the tail-stripped `VerificationSummary` — so neither is a
 * structural subtype of the other and a single `T` would fail to unify. The returned union is honest: every caller reads only the fields the design doc's own
 * data model guarantees all tiers share — `status`, `startedAt`, `updatedAt`, `attention`, and a `.queue` of stage-bearing items — which a union assigns
 * into just as safely as any single member would.
 *
 * `undefined` is accepted alongside `null` in `preferred` because a review found the original signature guarding `null` only: a future caller reading an
 * optional field (`foo?: Bar`, which reads back as `undefined`) would have had `undefined` treated as a real winner by the one module whose whole job is to make
 * that bug class impossible. Both mean "this tier has nothing to say". `NonNullable<A> | F` makes it a type-level fact rather than a convention callers trust.
 */
export function pickAuthority<A, F = A>(preferred: readonly (A | null | undefined)[], fallback: F): NonNullable<A> | F {
  for (const candidate of preferred) {
    if (candidate !== null && candidate !== undefined) return candidate as NonNullable<A>;
  }
  return fallback;
}
