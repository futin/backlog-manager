import { CLAIM_MARKER, CLAIM_STALE_MS } from '../../../shared/types';
import type { ClaimRecord } from '../../../shared/types';
import type { GithubComment } from './github.client';

/**
 * claim.ts — the readable half of the claim protocol (task-46, spec §6.3).
 *
 * No Nest, no client, no clock of its own: every function here is pure over
 * values it is handed, which is what lets the protocol be tested row by row
 * against fixture comments rather than only through a live sequence of network
 * calls. The WRITING half — post, list, settle, win or delete — lives in
 * `items/sources/github.source.ts`, where the client and the per-item
 * serialisation chain are; this file is what both sides agree a claim IS.
 *
 * ## Why the state is a comment
 *
 * A claim has to be readable by every machine, editable in place, ordered
 * consistently, and visible to a PERSON looking at the issue in GitHub's web
 * UI. A label is not ordered, an assignee cannot be edited to carry counters,
 * and a hidden field does not exist. A comment is all four — which is also why
 * `renderClaim` writes a human sentence under the fenced JSON: someone reading
 * the timeline should see who holds the issue without knowing this protocol
 * exists.
 *
 * ## Why the LOWEST live comment id wins
 *
 * Two sessions on two machines both post a claim, both list the comments, and
 * both compute the same winner without a lock, a lease server or agreeing
 * clocks: GitHub assigns comment ids monotonically, so "lowest" means "posted
 * first" and every reader of the same comment list reaches the same verdict.
 * The loser deletes its own comment; the winner sets the assignee and the
 * `in-progress` label. Contrast the alternative — highest id, i.e. last writer
 * wins — which is not convergent at all: a third claimant arriving mid-race
 * would change the answer for everyone who had already decided.
 */

/**
 * A claim as it exists on GitHub: the record, plus the id of the comment
 * carrying it.
 *
 * The id is not inside `ClaimRecord` and must not be, for two reasons. It is
 * assigned by GitHub AFTER the body is composed — `renderClaim` runs before the
 * POST that mints the id — so a record carrying its own id would be a field
 * that is wrong at exactly the moment it is written. And the id is the
 * protocol's ORDERING key, which is a fact about the comment rather than about
 * the claim: "newest" and "winner" are both questions about comment ids, and
 * every function below that answers one takes this pair rather than a bare
 * record.
 */
export interface ParsedClaim {
  commentId: number;
  record: ClaimRecord;
}

/**
 * The comment body for a record: the marker, a fenced JSON block, and one
 * human sentence.
 *
 * The order is deliberate. The marker first, so `parseClaim`'s cheapest check
 * is a substring test that does not have to parse anything. The JSON second,
 * because it is what this app reads. The sentence last, because it is what a
 * PERSON reads — and putting it last means a claim that grows a field later
 * still ends with the line a human scans for.
 */
export function renderClaim(record: ClaimRecord): string {
  /* The host clause is bug-46's, and it is the half of this line a PERSON
     reads: a session id names a transcript on one machine, so a reader on any
     other machine is told who holds the issue in the one vocabulary they
     cannot look up. `<user>@<host>` they can.

     Absent, the sentence is today's byte for byte — no empty clause, no
     `unknown`. Every claim written before this field has no host, and a word
     like `unknown` is one a session can argue with, where nothing said is
     nothing to argue with. */
  const where = record.host === undefined ? '' : ` on ${record.host}`;
  const human =
    record.released === undefined
      ? `session ${record.session}${where} holds this issue (${record.phase}) since ${record.at}`
      : `released ${record.released.reason} at ${record.released.at}`;
  return `${CLAIM_MARKER}\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n\n${human}\n`;
}

/** The fenced JSON block inside a claim body. Non-greedy, so a body that grew a
 *  second fence later still yields the first one — the claim is always written
 *  first by `renderClaim`. */
const FENCE = /```json\s*\n([\s\S]*?)\n```/;

/**
 * One comment → the claim inside it, or `null`.
 *
 * Tolerant in exactly the way `mapIssue` is, and for the same reason: these
 * comments come off a repository anyone with write access can edit by hand, so
 * a malformed claim is an ordinary state of the world and not an exception a
 * request handler should turn into a 500. `null` here means "this is not a
 * claim", which is the same answer an ordinary conversation comment gets — and
 * that is what makes a hand-mangled claim comment fall out of the protocol
 * rather than wedge it.
 *
 * A `v` this build does not know reads as `null` too, deliberately. An old
 * build ignoring a future version's claim is a build that will contest an issue
 * it should have left alone — visible, recoverable, and loud. An old build
 * half-reading one would act on fields it does not understand, which is not.
 */
export function parseClaim(comment: GithubComment): ClaimRecord | null {
  const body = comment.body ?? '';
  if (!body.includes(CLAIM_MARKER)) return null;
  const fenced = FENCE.exec(body);
  if (fenced === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if ((parsed as { v?: unknown }).v !== 1) return null;
  return parsed as ClaimRecord;
}

/**
 * Every claim on one issue, ascending by comment id.
 *
 * Membership is the comment's `issue_url`, which is the only field the
 * repository-wide comments endpoint gives naming the issue a comment belongs
 * to. Matched by SUFFIX (`/issues/31`) rather than by a substring or a parsed
 * number: `/issues/310` ends with `310`, not with `/issues/31`, so the suffix
 * is what distinguishes them — and a bare `includes('/issues/31')` would match
 * both, silently mixing two issues' claims and handing the protocol a winner
 * from the wrong issue.
 *
 * Takes an `Iterable` because the poller's cache hands out a `Map`'s values and
 * copying it into an array first would be a second allocation per call on the
 * board's hottest read.
 */
export function claimsFor(issueNumber: number, comments: Iterable<GithubComment>): ParsedClaim[] {
  const suffix = `/issues/${issueNumber}`;
  const out: ParsedClaim[] = [];
  for (const comment of comments) {
    if (typeof comment.issue_url !== 'string' || !comment.issue_url.endsWith(suffix)) continue;
    const record = parseClaim(comment);
    if (record === null) continue;
    out.push({ commentId: comment.id, record });
  }
  return out.sort((a, b) => a.commentId - b.commentId);
}

/** `…/issues/31` at the end of a comment's `issue_url`, captured. The same
 *  suffix rule `claimsFor` applies one issue at a time. */
const ISSUE_TAIL = /\/issues\/(\d+)$/;

/**
 * Every claim in a whole repository, bucketed by issue number, each bucket
 * ascending by comment id — `claimsFor` turned inside out for the board's read
 * path.
 *
 * It exists for one reason, and it is arithmetic rather than taste: `list`
 * maps every issue of a repo on every board render, and asking `claimsFor` per
 * issue would re-parse every comment in the repo once per issue — 200 issues
 * against 500 comments is 100,000 regex executions per render, for an answer
 * that is one pass over the comments.
 *
 * `claimsFor` stays the primitive the PROTOCOL uses, where exactly one issue is
 * in question and building a map of a repo would be the wasteful direction.
 */
export function claimsByIssue(comments: Iterable<GithubComment>): Map<number, ParsedClaim[]> {
  const out = new Map<number, ParsedClaim[]>();
  for (const comment of comments) {
    if (typeof comment.issue_url !== 'string') continue;
    const tail = ISSUE_TAIL.exec(comment.issue_url);
    if (tail === null) continue;
    const record = parseClaim(comment);
    if (record === null) continue;
    const number = Number(tail[1]);
    const bucket = out.get(number);
    if (bucket === undefined) out.set(number, [{ commentId: comment.id, record }]);
    else bucket.push({ commentId: comment.id, record });
  }
  for (const bucket of out.values()) bucket.sort((a, b) => a.commentId - b.commentId);
  return out;
}

/**
 * Is this claim still held?
 *
 * Two conditions, and the ORDER of the fields they read is the whole rule: a
 * released claim is dead whatever its heartbeat says (release is permanent),
 * and an unreleased one is alive only while its HEARTBEAT is fresh — never its
 * `at`. A groom that has run for an hour with heartbeats is alive; one that
 * stopped answering four minutes into a ten-minute window is not.
 *
 * An unparseable heartbeat is NOT live. `Date.parse` answers `NaN`, and every
 * comparison with `NaN` is false, so the arithmetic below already produces the
 * right answer — but it is checked explicitly rather than left to that, because
 * "it happens to fall out of IEEE 754" is not a thing a reader should have to
 * derive in order to trust a liveness check.
 */
export function isLive(record: ClaimRecord, nowMs: number): boolean {
  if (record.released !== undefined) return false;
  const beat = Date.parse(record.heartbeat);
  if (Number.isNaN(beat)) return false;
  return nowMs - beat < CLAIM_STALE_MS;
}

/**
 * The most recently POSTED claim — highest comment id — released or not, or
 * `null` for an issue nobody has ever claimed.
 *
 * "Released or not" is what makes it the mapper's input: a released claim still
 * carries the counters of the work it recorded, and those are the item's
 * accumulated totals whether or not anyone holds it right now. Liveness is a
 * separate question, asked separately (`isLive`).
 */
export function newestClaim(claims: readonly ParsedClaim[]): ParsedClaim | null {
  let newest: ParsedClaim | null = null;
  for (const claim of claims) {
    if (newest === null || claim.commentId > newest.commentId) newest = claim;
  }
  return newest;
}

/** The claims still held at `nowMs`. */
export function liveClaims(claims: readonly ParsedClaim[], nowMs: number): ParsedClaim[] {
  return claims.filter((c) => isLive(c.record, nowMs));
}

/**
 * Who holds the issue: the LOWEST comment id among live claims — see this
 * file's header for why lowest rather than highest. `null` when nothing is
 * live, which is an unheld issue and the ordinary case.
 */
export function winner(live: readonly ParsedClaim[]): ParsedClaim | null {
  let low: ParsedClaim | null = null;
  for (const claim of live) {
    if (low === null || claim.commentId < low.commentId) low = claim;
  }
  return low;
}
