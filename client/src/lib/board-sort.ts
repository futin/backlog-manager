/**
 * The Board's sort pipeline, and its one home: the three sort keys and the direction, each key's natural direction, the comparators, the guard that
 * resolves a stored key, the live-first rank every comparator runs behind, and `sortItems`, which composes them. BoardView keeps only the wiring around it —
 * the storage keys, the popover's labels and hints, the stored state and the pick handler — and calls in.
 *
 * It left the view because pure ordering logic inside a component can only be pinned through renders, and a render cannot discriminate a comparator: two
 * implementations of `sortItems` that agree on the handful of cards a jsdom fixture draws pass the same test (test/board.test.tsx says as much over its own
 * fallback case). Here `test/board-sort.test.ts` calls each piece directly, so a wrong comparator fails a test that names it (#258, the React-composability
 * audit's gap 2). The render tests stay where they are: they pin the stored key reaching the track, which no unit test can.
 *
 * Pure by construction — no React, no `localStorage`, nothing from `components/` or `hooks/`. `lib/` imports nothing from `components/`, the same reason
 * `ACTIVE_RUN_STAGES` lives in `lib/run-stage.ts`, `liveKind` in `lib/live-bar.ts`, and `SortDir` moved here out of FilterBar.tsx.
 */
import { liveKind } from './live-bar';
import type { BacklogItem, RunStage } from '../../../shared/types';

export type SortKey = 'created' | 'name' | 'project';

/* A direction, `asc` or `desc`. Declared here rather than in FilterBar.tsx, its first home: this module orders by it, and `lib/` imports nothing from
   `components/`. FilterBar imports it from here for its track and its Segmented. */
export type SortDir = 'asc' | 'desc';

/* Each key's natural direction — the order the board drew for it before the direction existed: newest first for `created`, A–Z for the other two.
   A key change lands on the new key's own (so `Name` never opens Z→A because `Created` was descending), and a missing or unrecognised stored direction
   resolves to it; the dashboard leaves the direction alone on every pick, and this board deliberately does not. */
export const NATURAL_DIR: Record<SortKey, SortDir> = { created: 'desc', name: 'asc', project: 'asc' };

/**
 * `created` compares as a string: backlog.mjs writes fixed-width UTC
 * YYYY-MM-DD, where lexicographic order is chronological order, and an
 * unparseable value sorts predictably instead of NaN-scrambling the list.
 *
 * A tracker item's `created` is the other shape — GitHub's full `created_at`, `YYYY-MM-DDTHH:MM:SSZ` (#237) — and string order still holds: every stamp is
 * the same fixed-width UTC `Z` form, so two same-day issues order by their time instead of tying and keeping the API's order (oldest issue first). In a
 * column mixing both shapes, a stamp sorts above the bare date of its own day (the date is its prefix), so a same-day files item lands below it under
 * Newest first. That is accepted, and pinned in board.test.tsx, rather than parsed away.
 *
 * A record keyed on `SortKey`, not the three-branch if/else this used to be:
 * `sortItems` below gives every sort a shared primary key (live work
 * first — `liveRank`), and a primary key that has to run in front of whichever comparator
 * is selected can only be written once against a record's shared call site —
 * three separate branches would each need their own copy of it.
 *
 * Each one is written ASCENDING and handed the direction as a `sign`, which it applies to its own key's comparison and to nothing else (the
 * band-filter spec's §3). That is the whole reason the sign is a parameter rather than a negation of the comparator's result at the call site: `project`
 * breaks its ties newest first, and a negated result would flip the tie-break with the key, so `Project (desc)` would read Z→A *and* oldest first inside
 * every project. `created` was `b` against `a` before the direction existed; it is `a` against `b` now and arrives at the same newest-first order through
 * its natural `desc`.
 */
export const COMPARATORS: Record<SortKey, (a: BacklogItem, b: BacklogItem, sign: 1 | -1) => number> = {
  name: (a, b, sign) => sign * a.title.localeCompare(b.title),
  project: (a, b, sign) => sign * a.project.localeCompare(b.project) || b.created.localeCompare(a.created),
  created: (a, b, sign) => sign * a.created.localeCompare(b.created)
};

/* The key the board orders by, out of whatever BoardView's SORT_KEY holds.

   The `SortKey` type is not a promise that the stored value is one. It
   arrives from localStorage through `usePersistedState`, which JSON.parses
   whatever is stored and hands back anything it finds — the type describes
   what this build WRITES, never what it is capable of READING. A key
   hand-edited, or written by a later build and then rolled back, misses
   `COMPARATORS` entirely, and an unguarded miss is *called*: `undefined(a, b)`
   throws inside render. With no ErrorBoundary anywhere in client/src React
   unmounted the tree to a blank page; since #270 `SectionBoundary` catches it
   and draws a reload prompt instead, but the reload re-reads the same stored
   key and throws again, so only clearing site data recovers either way.
   Degrading to `created` is precisely what the if/else chain the record
   replaced did in its final `else`, so this restores behaviour rather than
   adding a new rule.

   Resolved here, once, rather than as a `COMPARATORS[sort] ?? COMPARATORS.created`
   lookup inside `sortItems` (where it lived until the band's filter track):
   the sort track reads the key too now — it prints `Sort: <label> (<dir>)` and
   ticks the chosen row — and a raw value handed to it would print `Sort: newest`
   over a board ordered by Created, or, for a stored object, render that object
   as a React child, which is the same failure by another road. One
   resolution feeds the order, the label, the ticked row and the natural
   direction, so the four cannot disagree. An own-property test rather than
   `??`, because `COMPARATORS['constructor']` is not undefined.

   Deliberately NOT matched by the Status filter, which reads the same
   unvalidated storage and is left unguarded on purpose: a stale status value
   just matches nothing in the four type columns, leaving a visibly narrowed
   board — the filter button raised with a `1` on it, no option lit in the
   Status switch — whose fix is `Clear all`, one click inside the panel that
   button opens. (The Project filter goes further still and fails open to
   "all".) The asymmetry is the point — a degraded board a user can reason
   about is a different class of problem from a page that isn't there. */
export function resolveSortKey(stored: unknown): SortKey {
  return typeof stored === 'string' && Object.prototype.hasOwnProperty.call(COMPARATORS, stored) ? (stored as SortKey) : 'created';
}

/**
 * The primary sort key every comparator shares, and the board's one answer to
 * "is anybody on this right now". Lower sorts first, so live cards float to the
 * top of their column no matter which comparator is selected, and whichever one
 * is selected still decides order *within* each rank — two live cards do not
 * collapse to file order against each other just because they tied.
 *
 *   0 — a fresh run is BLOCKED on a person (`ATTENTION_RUN_STAGES`).
 *   1 — a fresh run is working it (`ACTIVE_RUN_STAGES`), or a hand-run session
 *       has stamped `started:` on the file (`isInProgress`) and, on a tracker
 *       item, its claim still has a heartbeat inside `CLAIM_STALE_MS`
 *       (`liveKind`'s `hand` rather than its `stale`, #227).
 *   2 — everything else — a stale tracker claim among it.
 *
 * Rank 0 sits above running work because it is the only one of the three that
 * is waiting on the reader: a run that has stopped and will not restart on its
 * own is the single most actionable thing a column can contain.
 *
 * Hand-run and orchestrator-run live work deliberately TIE at rank 1. Both mean
 * "somebody is on this", and there is no reading under which one of them
 * deserves to sit above the other — the selected sort orders them against each
 * other exactly as it always has.
 *
 * Three readers, and they must not disagree: this rank orders the columns, its
 * `< 2` half is the Status filter's `started` predicate, and the same `< 2` half
 * gates the board's clock (`hasLive`). Its `< 2` half is the set of cards
 * `liveBarFor` (lib/live-bar.ts) draws a bar for MINUS the `stale` ones: a stale
 * tracker claim is drawn, so a person sees it and can release it, but nobody is
 * working it, so it neither floats up a column nor counts as In progress (#227).
 * The rank and the bar read one classification, `liveKind` (lib/live-bar.ts), so
 * neither restates the other's stage lists; they differ only in what `stale` means.
 *
 * The card's queued band (`queuedStripFor`) paints in the same place and is
 * deliberately NOT in that set: an `orchestrator:queued` item is a plan nobody
 * is on yet, so it neither floats up a column nor counts as In progress.
 *
 * `now` is the clock the claim is aged against, and `null` asks for the UNAGED
 * reading — `isInProgress` alone, a stale claim still counted live. Exactly one
 * reader wants that: the gate on the board's clock (`hasLive`), which has to be
 * computed before the clock exists and has to run for a claim that is live now
 * so the card can be seen going stale later. Every other reader passes `now`.
 */
export function liveRank(item: BacklogItem, stage: RunStage | undefined, now: number | null): 0 | 1 | 2 {
  const kind = liveKind(item, stage, now);
  if (kind === 'attention') return 0;
  if (kind === 'run' || kind === 'hand') return 1;
  return 2;
}

/**
 * Onto a copy, never in place — the array belongs to the fetched index.
 *
 * `stageFor` is threaded in rather than read off the item: an orchestrated
 * item's file says nothing about the run working it (see `liveBarFor`'s own
 * comment for why), so the primary key can no longer be a pure function of one
 * item and the lookup has to come from the caller that holds the run payload.
 *
 * `sort` is already resolved (`resolveSortKey`, above), so the lookup cannot miss. `dir` reaches the key's own comparison only: `liveRank` stays the
 * primary key in both directions, because "live cards first" is not an order the reader chose and so not one a direction can turn over — the sort
 * popover's foot line says as much.
 */
export function sortItems(items: BacklogItem[], sort: SortKey, dir: SortDir, stageFor: (item: BacklogItem) => RunStage | undefined, now: number): BacklogItem[] {
  const out = [...items];
  const compare = COMPARATORS[sort];
  const sign = dir === 'asc' ? 1 : -1;
  out.sort((a, b) => liveRank(a, stageFor(a), now) - liveRank(b, stageFor(b), now) || compare(a, b, sign));
  return out;
}
