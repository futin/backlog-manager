import { reviewState } from '../../../shared/review';
import type { ReviewState } from '../../../shared/review';
import type { GitlabMr, GitlabPipeline } from '../../../shared/types';

/**
 * What a reader chose to look past on the Delivery tab (Jira detail tabs spec §4.5.1): the pure half of the ignore store — the shape, the key, the repairing
 * read, when an entry still holds, and the prune. The store that persists it (one JSON string under `backlog-manager.jira-ignored-steps`, one listener set) is a
 * separate module; nothing here touches storage, a clock or a component, so `deliveryNext` can take an entry as a plain argument.
 *
 * An entry remembers the state the step read when it was ignored plus a stamp that moves when the thing behind it is redone, so a new review round or a push
 * is judged fresh instead of staying ignored forever. This browser only, by design: ignoring is a reader's call about what to look at next, not a fact about
 * the MR.
 */

/** The review half: the state at the time (`'unread'` for a `null` review) and its `landedAt` — `null` is a real stamp, a `none` or unread review has none. */
export interface IgnoredReview {
  state: ReviewState | 'unread';
  landedAt: string | null;
}

/**
 * The pipeline half: the head pipeline's status at the time, the MR's head commit (`sha`) and its `updatedAt`. A push moves the head commit; a comment, a label
 * or an approval moves nothing it carries — but all of them move `updatedAt`, which is why the commit is the key (#588). `sha` is `null` for an entry stored
 * before that (read back without one) or for an MR GitLab gave no head commit; such an entry is judged by `updatedAt`, as it always was.
 */
export interface IgnoredPipeline {
  status: GitlabPipeline;
  sha: string | null;
  updatedAt: string;
}

export interface IgnoreEntry {
  review?: IgnoredReview;
  pipeline?: IgnoredPipeline;
}

/** Every ignore this browser holds, by `ignoreKey`. Entries of other tickets' MRs sit in the same object, which is why a prune only ever names its own keys. */
export type IgnoredSteps = Record<string, IgnoreEntry>;

/** `<project>!<iid>` — the GitLab project path keeps two projects' iids apart, and `!` is GitLab's own spelling of a merge request reference. */
export const ignoreKey = (mr: GitlabMr): string => `${mr.project}!${mr.iid}`;

// Closed lists the guard checks membership against; typed as the unions so a new `ReviewState` or `GitlabPipeline` fails to compile here instead of being
// silently dropped from a stored entry.
const REVIEW_STATES: Record<ReviewState | 'unread', true> = { none: true, reviewing: true, open: true, stale: true, clean: true, unknown: true, unread: true };
const PIPELINES: Record<GitlabPipeline, true> = { success: true, failed: true, running: true, canceled: true, none: true };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (table: object, key: unknown): boolean => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

function readReview(v: unknown): IgnoredReview | null {
  if (!isRecord(v) || !has(REVIEW_STATES, v.state)) return null;
  // `null` is a stamp (no landing yet); absent or any other type is not.
  if (v.landedAt !== null && typeof v.landedAt !== 'string') return null;
  return { state: v.state as IgnoredReview['state'], landedAt: v.landedAt };
}

function readPipeline(v: unknown): IgnoredPipeline | null {
  if (!isRecord(v) || !has(PIPELINES, v.status) || typeof v.updatedAt !== 'string') return null;
  // An absent `sha` is an ignore stored before the head-commit key (#588): kept, read as `null`, judged by `updatedAt`. Any other non-string is malformed.
  if (v.sha !== undefined && v.sha !== null && typeof v.sha !== 'string') return null;
  return { status: v.status as GitlabPipeline, sha: typeof v.sha === 'string' ? v.sha : null, updatedAt: v.updatedAt };
}

/**
 * A repairing guard, not a yes/no one (§4.5.1): each entry keeps the half or halves that are well-formed and drops the rest, an entry left with neither is
 * dropped, and anything that is not a plain object — `null`, an array, the raw text the store passes when `JSON.parse` fails — reads as `{}`. One bad entry in
 * a hand-edited or older value must not cost the reader every other ignore. The result is built by `Object.fromEntries`, which defines own data properties,
 * so a key `__proto__` or `constructor` is a key like any other and never reaches a prototype.
 */
export function readIgnoredSteps(v: unknown): IgnoredSteps {
  if (!isRecord(v)) return {};
  const kept: [string, IgnoreEntry][] = [];
  for (const [key, raw] of Object.entries(v)) {
    if (!isRecord(raw)) continue;
    const review = readReview(raw.review);
    const pipeline = readPipeline(raw.pipeline);
    if (review === null && pipeline === null) continue;
    kept.push([key, { ...(review === null ? {} : { review }), ...(pipeline === null ? {} : { pipeline }) }]);
  }
  return Object.fromEntries(kept);
}

/**
 * Which halves of an entry still hold for this MR right now. The review holds while the CURRENT state (`'unread'` for `review === null`) is the stored one and
 * the review's `landedAt` is still the stored stamp — a state that moved, or a new round that landed, is a fresh review. The pipeline holds while its status
 * is unchanged and the MR is on the same head commit: a push moves the head commit, a comment moves nothing (#588 — keyed on `updatedAt`, any comment, label
 * or approval lapsed the ignore). Only when either side has no commit (a legacy entry, or an MR GitLab gave none) is it judged by `updatedAt`, as before.
 * Limit, accepted by the spec: a pipeline retried by hand on the same commit and failing again keeps its ignore, since nothing on the MR moved; `ignored` is
 * one click to undo.
 */
export function ignoreHolds(entry: IgnoreEntry | undefined, mr: GitlabMr, now: number): { review: boolean; pipeline: boolean } {
  const state: ReviewState | 'unread' = mr.review === null ? 'unread' : reviewState(mr.review, now);
  return {
    review: entry?.review !== undefined && entry.review.state === state && entry.review.landedAt === (mr.review?.landedAt ?? null),
    pipeline: entry?.pipeline !== undefined && entry.pipeline.status === mr.pipeline && samePush(entry.pipeline, mr)
  };
}

/** The head commit when both sides carry one, else the `updatedAt` stamp — see `ignoreHolds`. */
function samePush(entry: IgnoredPipeline, mr: GitlabMr): boolean {
  return entry.sha !== null && mr.headSha !== null ? entry.sha === mr.headSha : entry.updatedAt === mr.updatedAt;
}

/**
 * The store after a write's prune (§4.5.1): the entries of THIS ticket's MRs that are no longer open are dropped, and no other key is touched — the rest
 * belong to other tickets, whose delivery this call knows nothing about. `null` is "this ticket's delivery is not in hand" (the GitLab payload is `null`, or
 * the ticket's delivery is not `kind: 'mrs'`): nothing is pruned and the SAME object comes back, so a caller can compare references to skip a write. The
 * same holds when nothing needed dropping. The input is never mutated.
 */
export function pruneIgnored(all: IgnoredSteps, ticketMrs: readonly GitlabMr[] | null): IgnoredSteps {
  if (ticketMrs === null) return all;
  const gone = new Set(ticketMrs.filter((mr) => mr.state !== 'opened').map(ignoreKey));
  const doomed = Object.keys(all).filter((key) => gone.has(key));
  if (doomed.length === 0) return all;
  return Object.fromEntries(Object.entries(all).filter(([key]) => !gone.has(key)));
}
