import { isMergeMode, isQuestionMode } from '../../../shared/agent';
import { CLAIM_FINISHED_STATUSES, CLAIM_MARKER, CLAIM_STALE_MS } from '../../../shared/types';
import type { ClaimFinishedStatus, ClaimRecord } from '../../../shared/types';
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
 * Since #266 three more things read as "not a claim", because on a public
 * repository ANYONE can comment, not only those with write access: a comment
 * by an outsider (`trustedAuthor`), a record whose fields do not have the shape
 * their writers give them (`wellFormed`) — and a heartbeat from the future is
 * clamped (`CLAIM_HEARTBEAT_SKEW_MS`) rather than believed.
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
  if (!isObject(parsed)) return null;
  if (parsed.v !== 1) return null;
  if (!trustedAuthor(comment)) return null;
  if (!wellFormed(parsed)) return null;
  const record = parsed as unknown as ClaimRecord;
  const ceiling = heartbeatCeiling(comment);
  if (ceiling !== null && Date.parse(record.heartbeat) > ceiling) record.heartbeat = new Date(ceiling).toISOString();
  return record;
}

/**
 * How far a heartbeat may run ahead of the comment that carries it (#266).
 *
 * A heartbeat is stamped by the server's clock a moment before the edit that publishes it, and the edit moves the comment's `updated_at` on GITHUB's
 * clock — so a real heartbeat is never later than `updated_at` by more than the two clocks disagree. A forged one can name any year it likes, and before
 * this it was live for that long: `claim` refused every session and the board's abort refused to clear it. Clamped rather than refused, so a claim
 * written by a machine whose clock runs fast still reads as a claim; it just goes stale on GitHub's clock instead of its own.
 *
 * Five minutes is the skew allowance — far above an NTP-synced pair of machines, far below the fifteen-minute stale window it bounds.
 */
export const CLAIM_HEARTBEAT_SKEW_MS = 5 * 60_000;

/** `updated_at` plus the skew allowance, or `null` when the comment carries no readable stamp — a hand-built comment, never one off the API. */
function heartbeatCeiling(comment: GithubComment): number | null {
  const updated = typeof comment.updated_at === 'string' ? Date.parse(comment.updated_at) : Number.NaN;
  return Number.isNaN(updated) ? null : updated + CLAIM_HEARTBEAT_SKEW_MS;
}

/**
 * The authors whose comments can carry a claim (#266): the repository's owner, an organisation member, a collaborator — every account a token this app
 * holds can belong to, since writing a claim needs write access.
 *
 * Read off `author_association`, which GitHub sets on every comment, rather than compared with the token's own login: two machines on one repo may hold
 * two people's tokens, and both are legitimate claimants. An absent field is trusted — it means the comment was built here, not received — because every
 * comment the API returns carries one, so the case this check exists for always states its association.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function trustedAuthor(comment: GithubComment): boolean {
  return comment.author_association === undefined || TRUSTED_ASSOCIATIONS.has(comment.author_association);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Does the parsed JSON have the shape `ClaimRecord` declares (#266)?
 *
 * The cast below used to be the whole check, and every reader trusted it: `statusOf` read `finished.at` off a `null` and the runs route answered 500 on
 * every poll; the abort route did the same on `run: null`. Checking here, once, is what lets every one of those readers stay as written — a record that
 * fails is "not a claim", the same answer a hand-mangled comment always got.
 *
 * Every field is held to what its one writer produces: the item write routes validate `run` and `finished` with the same vocabularies (`claimRunOf`,
 * `claimFinishedOf` in `items-write.controller.ts`), and the server seeds all four counters. `state` is not checked — it is carried opaque and read
 * tolerantly by `readClaimState` — and unknown keys pass through, which is how an old build reads a newer build's claim.
 */
function wellFormed(raw: Record<string, unknown>): boolean {
  if (!isString(raw.session) || raw.session === '') return false;
  if (raw.phase !== 'groom' && raw.phase !== 'execute') return false;
  if (!isString(raw.at) || !isString(raw.heartbeat)) return false;
  if (raw.host !== undefined && !isString(raw.host)) return false;

  const counters = raw.counters;
  if (!isObject(counters)) return false;
  for (const key of ['groomElapsed', 'executeElapsed', 'groomTokens', 'executeTokens']) if (!isCount(counters[key])) return false;

  const released = raw.released;
  if (released !== undefined && !(isObject(released) && isString(released.at) && isString(released.reason) && isString(released.by))) return false;

  const finished = raw.finished;
  if (finished !== undefined && !(isObject(finished) && isString(finished.at) && CLAIM_FINISHED_STATUSES.includes(finished.status as ClaimFinishedStatus))) {
    return false;
  }

  const run = raw.run;
  if (run !== undefined) {
    if (!isObject(run)) return false;
    if (!isString(run.runId) || run.runId === '' || !isString(run.startedAt) || !isString(run.base)) return false;
    if (!isMergeMode(run.mergeMode) || !isQuestionMode(run.questionMode)) return false;
    if (run.maxItems !== null && !(Number.isInteger(run.maxItems) && (run.maxItems as number) >= 0)) return false;
  }
  return true;
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

/**
 * The claim the read route answers (bug-58): the HOLDER, resolved by the same
 * rule `claim` resolves it — the lowest live id is the holder — and, only when
 * nothing is live, the newest claim, released or not.
 *
 * Holder first because every caller of the route asks "who holds this": `stop`
 * refuses or releases by it, `heartbeat` beats it, `abort` checks its host and
 * `show` prints its session. Inside a race window the loser's comment is both
 * live and NEWER, so answering `newestClaim` there named the loser as the
 * holder until the loser deleted it — and `claim` leaves that comment standing
 * for the full stale window when its delete fails.
 *
 * The newest-claim fallback is not a convenience. With nothing live the
 * counters live on the newest claim, and `stop`'s released and stale paths
 * depend on getting exactly that claim back. `newestClaim` itself is unchanged:
 * `claim`'s counter seed and the mapper still want it.
 */
export function currentClaim(claims: readonly ParsedClaim[], nowMs: number): ParsedClaim | null {
  return winner(liveClaims(claims, nowMs)) ?? newestClaim(claims);
}
