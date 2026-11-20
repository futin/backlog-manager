import { reviewHalf, reviewStaleKind, reviewState } from '../../../shared/review';
import type { ReviewState } from '../../../shared/review';
import type { GitlabReview, ReviewSeverity } from '../../../shared/types';
import { elapsedSince } from './item-age';

/**
 * Every CodeRabbit string the board draws (spec §5.5), one function per table row, so Detail's step, Detail's row and the Run launch sheet cannot word the
 * same state two ways. Pure: each takes the review and the clock, and derives the state through `shared/review.ts` — the one place the table of states lives.
 * Counts take the singular at 1, and an age is `elapsedSince` (`4m`, `2h`, `3d`, `now`), the ladder Detail's delivery ages already read through `pollAge`.
 *
 * A capped read (`review.capped`) means the discussions ran past the page budget, so a count is a floor, not a total: it reads `<n>+` wherever it is drawn
 * (ruling R1 — the same `+` the chip and List word carry in `deliveryLook`).
 */

/** The severities in the order the row's breakdown lists them (spec §5.5); `other` is the threads whose severity did not parse. */
const SEVERITY_ORDER: readonly (ReviewSeverity | 'other')[] = ['critical', 'major', 'minor', 'trivial', 'other'];

/** `n` with the cap's plus when the count is a floor. */
const count = (n: number, capped: boolean): string => (capped ? `${n}+` : `${n}`);

/** `1 commit` / `3 commits`. */
const commits = (n: number): string => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** An age through the board's ladder; an unparseable stamp reads as the stamp itself rather than `NaN`, which is what `pollAge`'s callers do. */
const age = (iso: string, now: number): string => elapsedSince(iso, now) ?? iso;
/** `<age> ago` for the row's `reviewed` clause: under a minute `elapsedSince` says `now`, and `now ago` is not English. */
const agoText = (iso: string, now: number): string => {
  const a = age(iso, now);
  return a === 'now' ? 'just now' : `${a} ago`;
};
/** `since <age>` for the not-refreshed suffix, with the same under-a-minute case: `since just now` reads, `since now` does not. */
const sinceText = (iso: string, now: number): string => {
  const a = age(iso, now);
  return a === 'now' ? 'just now' : a;
};

/**
 * The word under Detail's Review step; `null` when the step draws none (no review read). `reviewing` counts from `triggeredAt`, which is non-null whenever
 * the state is `reviewing` (a pending trigger is what makes it so).
 */
export function reviewStepWord(review: GitlabReview | null, now: number): string | null {
  if (review === null) return null;
  const state = reviewState(review, now);
  switch (state) {
    case 'none':
      return 'not reviewed';
    case 'reviewing':
      return `reviewing… ${review.triggeredAt === null ? '' : age(review.triggeredAt, now)}`.trimEnd();
    case 'open': {
      const n = count(review.open, review.capped);
      // A capped read drops the severity part (§5.5: `<n>+ open`): the worst of a floor is not the worst of the whole.
      return review.worst === null || review.capped ? `${n} open` : `${n} open · ${review.bySeverity[review.worst]} ${review.worst}`;
    }
    case 'stale':
      return reviewStaleKind(review, now) === 'commits' ? `${commits(review.commitsSince)} since review` : "last review didn't land";
    case 'clean':
      return `0 open · ${review.resolved} resolved`;
    case 'unknown':
      return 'too long to read';
  }
}

/** ` · not refreshed since <age>` when the latest read failed, from `readAt` (the last GOOD read); empty otherwise. The row and the step's title share it. */
export function reviewStepTitleSuffix(review: GitlabReview | null, now: number): string {
  return review !== null && review.failed ? ` · not refreshed since ${sinceText(review.readAt, now)}` : '';
}

/**
 * The sentence in Detail's CodeRabbit row (spec §5.2), or `null` where the row is absent: `reviewing`, `clean`, `unknown`, and no review read. The caller
 * also hides it for a non-open lead MR, which only it knows. It opens `Review · `, never the bot's name (Jira detail tabs spec §4.7): which bot reviews is
 * the repository's, so a drawn string names the step, not the product.
 */
export function reviewRowText(review: GitlabReview | null, now: number): string | null {
  if (review === null) return null;
  const state = reviewState(review, now);
  let body: string;
  switch (state) {
    case 'open': {
      const n = count(review.open, review.capped);
      const breakdown = SEVERITY_ORDER.filter((k) => review.bySeverity[k] > 0)
        .map((k) => `${review.bySeverity[k]} ${k}`)
        .join(', ');
      // A thread count of exactly 1 is the singular, even capped (`1+ open findings` reads as plural-ish, but the cap says "at least" and 1 is the floor).
      const noun = review.open === 1 && !review.capped ? 'finding' : 'findings';
      const reviewed = review.landedAt === null ? '' : ` · reviewed ${agoText(review.landedAt, now)}`;
      body = `${n} open ${noun}${breakdown === '' ? '' : ` · ${breakdown}`}${reviewed}`;
      break;
    }
    case 'none':
      body = 'not reviewed yet';
      break;
    case 'stale':
      body = reviewStaleKind(review, now) === 'commits' ? `${commits(review.commitsSince)} since the last review` : "the last review didn't land";
      break;
    default:
      return null;
  }
  return `Review · ${body}${reviewStepTitleSuffix(review, now)}`;
}

/**
 * The live-session gate's sentence (`<name> is live on this ticket` / `<name> is live on <branch>`) — the blocked button's title, and the head of the reason
 * line under the row. `where` is `null` for the ticket and the MR's source branch otherwise; `reviewGate` decides which.
 */
export function reviewGateText(gate: { name: string; where: string | null }): string {
  return `${gate.name} is live on ${gate.where ?? 'this ticket'}`;
}

/**
 * The reason line's tail after the gate's sentence: what the blocked button is waiting for and the one thing the reader can do about it. Said on screen
 * because a disabled ink button drew exactly like an enabled one and the title alone needed a hover to find (2026-11-16, TIMIFY-27764). `Review` is a review
 * skill's button (spec §7): it waits on the same live-session gate as the bot review's two.
 */
export function reviewBlockedTail(label: 'Fix review' | 'Request review' | 'Review'): string {
  return ` — ${label} waits until it ends or you stop it.`;
}

/** The row's button label by state: `Fix review` fixes the open findings, `Request review` asks for one; no button otherwise (`reviewHalf`'s two halves). */
export function reviewButtonLabel(state: ReviewState): 'Fix review' | 'Request review' | null {
  const half = reviewHalf(state);
  return half === 'fix' ? 'Fix review' : half === 'request' ? 'Request review' : null;
}
