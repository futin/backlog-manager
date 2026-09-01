/**
 * The ONE rule for "which object describes this run right now" — shared by
 * `RunsView.tsx` (the list row) and `RunDetail.tsx` (the persistent pane
 * beside it), because a whole-branch review found the two disagreeing about
 * exactly this: a live-backed row printed its merged/total and status off a
 * minutes-stale archive snapshot while the detail pane beside it read the 5s
 * live poll, and a run that had just finished kept reporting `running` in
 * the pane (with elapsed time still climbing) because the pane fell back to
 * that same stale snapshot the instant its `live` prop went `null`, instead
 * of using the run file it had *already re-fetched* for exactly that
 * transition. Both defects were the same root cause wearing two faces: two
 * call sites each hand-rolling their own `??` chain, free to disagree about
 * the order. This file is the fix — one function, so there is exactly one
 * place left for a future edit to get the order wrong.
 *
 * Up to three views of the same run can exist at once, in *decreasing*
 * order of freshness:
 *
 * 1. `live` — this run's entry from `useOrchestratorRuns`' 5s poll, present
 *    only while the server's own `fresh` check (`RUN_STALE_MS`) says the
 *    orchestrator process is still being heard from right now. The
 *    freshest thing either component can ever hold, by construction.
 * 2. `fetched` — a full run file `RunDetail` fetched on demand
 *    (`fetchArchivedRun`) for the currently-selected run. It lands strictly
 *    *after* whatever `useOrchestratorArchive` last held (it is a fetch
 *    triggered by that selection, always initiated later), so whenever it
 *    exists it is at least as fresh as the archive snapshot below — and it
 *    is the one thing that can ever correct a run that just stopped being
 *    live: `live` is gone by definition the moment a run finishes, but a
 *    freshly re-read run file still tells the truth about it.
 * 3. `archive` (the fallback) — `useOrchestratorArchive`'s own snapshot,
 *    fetched only on mount and window focus (see that hook's own doc
 *    comment for why it carries no poll of its own). This can be minutes
 *    stale for a run that is still moving, or for one that moved *and
 *    finished* since the last fetch — which is exactly the case `fetched`
 *    exists to correct.
 *
 * `RunsView`'s list rows have no `fetched` tier at all — fetching every
 * row's full run file just to paint a list would be the "fattening the
 * live poll" cost the design doc's own API-shape decision rejected — so for
 * them the rule collapses to `live ?? archive`. That is not a second rule;
 * it is this same function with its middle argument omitted, which is
 * exactly why both callers reach for the one function below rather than
 * writing their own two-argument or three-argument `??` chain: a reader
 * changing the precedence has one function to change, not one function to
 * find and one more to remember exists.
 *
 * Two independent type parameters, not one shared `T`, because the tiers are
 * not the same TypeScript shape: `OrchestratorRun` (live/fetched) and
 * `OrchestratorArchiveRun` (archive) diverge on their queue items'
 * `verification` field (full `RunVerification` with a `tail` vs. the
 * tail-stripped `VerificationSummary`), so neither is a structural subtype
 * of the other and a single `T` would force TypeScript to fail unifying
 * them. The return type is the honest union of whichever two (or three)
 * concrete types a call site passes in; every caller of this function reads
 * only the fields the design doc's own data model guarantees all of them
 * share (status, startedAt, updatedAt, attention, a `.queue` of
 * stage-bearing items) — which a union assigns into just as safely as any
 * single member would.
 */
export function pickAuthority<A, F = A>(preferred: readonly (A | null)[], fallback: F): A | F {
  for (const candidate of preferred) {
    if (candidate !== null) return candidate;
  }
  return fallback;
}
