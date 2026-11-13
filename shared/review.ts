import type { GitlabReview, ReviewHalf } from './types';

/**
 * CodeRabbit review state, derived from `GitlabReview`'s raw facts against the clock (spec 4.2). One pure function so the client's drawing, the poller's
 * re-read decision and dispatch's half all agree; the cache never stores a state, because a review that never lands must stop reading `reviewing` by itself.
 */
export type ReviewState = 'none' | 'reviewing' | 'open' | 'stale' | 'clean' | 'unknown';

/** How long a trigger with no landing still reads `reviewing`; the skill itself gives up at 15 min, so 30 is generous (spec 4.2). Strictly under, not up to. */
export const REVIEW_STUCK_MS = 30 * 60_000;

/** How long a `reviewing` MR waits before the poller reads its discussions again (spec 4.3 rule 2). */
export const REVIEW_REREAD_MS = 10 * 60_000;

/** An ISO stamp as epoch ms, or `null` when absent or unparseable — a stamp that does not parse reads as absent. */
function at(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Whether the latest trigger is newer than the latest landing (or nothing ever landed), and the trigger's age. `null` when there is no usable trigger. */
function pendingTrigger(review: GitlabReview, now: number): { ageMs: number } | null {
  const trigger = at(review.triggeredAt);
  if (trigger === null) return null;
  const landed = at(review.landedAt);
  return landed === null || trigger > landed ? { ageMs: now - trigger } : null;
}

/** The ordered table of spec 4.2; the first rule that matches wins. */
export function reviewState(review: GitlabReview, now: number): ReviewState {
  // Rule 0: ran out of page budget with nothing open — we cannot say anything. Open findings skip this and read open (rule 2).
  if (review.capped && review.open === 0) return 'unknown';
  const pending = pendingTrigger(review, now);
  // Rule 1: a young round in flight. Before rule 2 so a re-trigger over old findings reads reviewing.
  if (pending !== null && pending.ageMs < REVIEW_STUCK_MS) return 'reviewing';
  // Rule 2: unresolved threads are the next job whatever else was or was not seen.
  if (review.open > 0) return 'open';
  // Rule 3: no landing at all (never triggered, or every round is stale and unlanded).
  if (at(review.landedAt) === null) return 'none';
  // Rule 4 and 5: a landing exists; something happened since.
  if (review.commitsSince > 0) return 'stale';
  if (pending !== null) return 'stale';
  // Rule 6.
  return 'clean';
}

/** Which half a state offers: `open` fixes, `none` and `stale` request, the rest offer nothing (spec 6). */
export function reviewHalf(state: ReviewState): ReviewHalf | null {
  if (state === 'open') return 'fix';
  if (state === 'none' || state === 'stale') return 'request';
  return null;
}

/** Which stale rule fired, for the copy (rule 4 `commits`, rule 5 `unlanded`); `null` whenever the state is not `stale`. */
export function reviewStaleKind(review: GitlabReview, now: number): 'commits' | 'unlanded' | null {
  if (reviewState(review, now) !== 'stale') return null;
  return review.commitsSince > 0 ? 'commits' : 'unlanded';
}
