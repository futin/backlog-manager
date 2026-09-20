import { RUN_STALE_MS } from '../../../shared/types';
import type {
  ClaimFinished,
  ClaimRecord,
  ClaimState,
  RemoteRun,
  RunAttention,
  RunQueueItem,
  RunSessionUsage,
  RunStage,
  RunVerification
} from '../../../shared/types';
import { claimsByIssue } from '../tracker/claim';
import type { ParsedClaim } from '../tracker/claim';
import type { GithubComment } from '../tracker/github.client';

/**
 * remote-runs.util.ts — a run another machine drove, assembled from the claim
 * comments one tracker repository carries (task-48, spec §7.3).
 *
 * Pure, the way `tracker/claim.ts` is: no Nest, no client, and no clock of its
 * own — `nowMs` is handed in. `RemoteRunsService` is the Nest half, and all it
 * does is feed this the poller's cached comments per connected repo.
 *
 * ## Why a run can be rebuilt from its claims at all
 *
 * Every claim a run takes carries the same `run` object (`ClaimRun`, the six
 * run facts, redundantly on purpose) and — through every `heartbeat` — the
 * item's `state`. Group the repo's claims by `run.runId` and the group IS the
 * run, as far as another machine can know it: one queue item per issue, the
 * run's modes off any member, and `finished` on whichever claim `finish`
 * stamped. Nothing here asks a file, because the file is on the other machine.
 *
 * What it cannot rebuild is the part of the queue the run has not claimed yet:
 * no claim, no comment, nothing to read. The Runs page says so rather than
 * pretending the queue is complete.
 */

/* =========================================================================
 * The tolerant read of `ClaimRecord.state`
 * ========================================================================= */

/**
 * Every `RunStage`, as a `Record` so adding a member to the union is a compile
 * error here until it is classified — the same forcing `agents-shared.test.ts`
 * uses. Kept local because nothing else needs to ask "is this string a stage".
 */
const RUN_STAGE_SET: Record<RunStage, true> = {
  pending: true,
  preflight: true,
  dispatched: true,
  inspecting: true,
  reviewing: true,
  fixing: true,
  verifying: true,
  merging: true,
  merged: true,
  branched: true,
  failed: true,
  skipped: true,
  'needs-answers': true,
  ungroomed: true,
  parked: true
};

function isRunStage(value: unknown): value is RunStage {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RUN_STAGE_SET, value);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `ClaimRecord.state` → the `ClaimState` fields that have the right shape, and
 * nothing else. Never throws.
 *
 * TOLERANT rather than validated, and that is the contract rather than a
 * shortcut. `state` is a published comment on somebody's issue, written by
 * whatever build of `orchestrate.mjs` the other machine has installed and
 * editable by hand by anyone with write access. A reader that refused the
 * whole claim over one odd field would make a run disappear from every other
 * machine over a detail; this one keeps what it can read and lets the drawn
 * item say less. Array members are checked only as far as "is an object" —
 * the Runs page renders them, it never decides on them.
 */
export function readClaimState(raw: unknown): ClaimState {
  if (!isObject(raw)) return {};
  const out: ClaimState = {};
  if (isRunStage(raw.stage)) out.stage = raw.stage;
  if (isObject(raw.stageAt)) {
    const stageAt: Partial<Record<RunStage, string>> = {};
    for (const [key, value] of Object.entries(raw.stageAt)) {
      if (isRunStage(key) && isString(value)) stageAt[key] = value;
    }
    out.stageAt = stageAt;
  }
  for (const key of ['worktree', 'branch', 'sessionId', 'note'] as const) {
    const value = raw[key];
    if (value === null || isString(value)) out[key] = value;
  }
  if (typeof raw.fixLoops === 'number' && Number.isInteger(raw.fixLoops) && raw.fixLoops >= 0) out.fixLoops = raw.fixLoops;
  if (Array.isArray(raw.verification)) out.verification = raw.verification.filter(isObject) as unknown as RunVerification[];
  if (Array.isArray(raw.usage)) out.usage = raw.usage.filter(isObject) as unknown as RunSessionUsage[];
  if (Array.isArray(raw.assumptions)) {
    out.assumptions = raw.assumptions.filter((a): a is { question: string; answer: string } => isObject(a) && isString(a.question) && isString(a.answer));
  }
  return out;
}

/* =========================================================================
 * Attention comments
 * ========================================================================= */

/**
 * The attention marker, line 1 of an attention comment:
 * `<!-- bm:attention kind=<kind> run=<runId> -->`.
 *
 * Written by `orchestrate.mjs attention` (its `ATTENTION_MARKER`), which cannot
 * import this file — a plugin skill's `tools/` stands alone — so the two agree
 * through a SOURCE-READING guard (`test/remote-runs.test.ts`, G-1), the way
 * `labels.ts` and `connect`'s issue forms do, and never through an import.
 *
 * Strict on purpose: the kinds are `RunAttention['kind']`'s three and nothing
 * else, and the run id is `init`'s `run-YYYYMMDD-HHMMSS` shape. A comment that
 * merely mentions the marker, or carries a kind this build does not know, is an
 * ordinary comment — the same "not a claim" posture `parseClaim` takes.
 */
export const ATTENTION_LINE = /^<!-- bm:attention kind=(needs-answers|parked|fix-exhausted) run=(run-\d{8}-\d{6}) -->$/;

export interface ParsedAttention {
  kind: RunAttention['kind'];
  runId: string;
  detail: string;
}

/**
 * One comment → the attention entry in it, or `null`.
 *
 * The marker must be LINE 1 — a quote of it further down a conversation
 * comment is not an attention entry. The detail is everything after it with
 * the leading `@login ` mention removed: the mention exists to make a phone
 * buzz, and the Runs page already knows who it is talking to.
 */
export function parseAttention(comment: Pick<GithubComment, 'body'>): ParsedAttention | null {
  const body = comment.body ?? '';
  const newline = body.indexOf('\n');
  const first = (newline === -1 ? body : body.slice(0, newline)).replace(/\r$/, '');
  const match = ATTENTION_LINE.exec(first);
  if (match === null) return null;
  const rest = newline === -1 ? '' : body.slice(newline + 1);
  const detail = rest.trim().replace(/^@[A-Za-z0-9-]+\s*/, '');
  return { kind: match[1] as RunAttention['kind'], runId: match[2], detail };
}

/* =========================================================================
 * The derivation
 * ========================================================================= */

export interface DeriveRemoteRunsInput {
  /** `owner/name`. */
  repo: string;
  /** THIS machine's registry path for the repo — never anything a claim says. */
  project: string;
  /** The repo's cached comments, every issue at once. */
  comments: Iterable<GithubComment>;
  /** The cached issue's title, or `null` when the issue is not cached. */
  issueTitle: (issueNumber: number) => string | null;
  /** Every run id this machine holds a run file for — current or archived. */
  localRunIds: ReadonlySet<string>;
  nowMs: number;
}

const ISSUE_TAIL = /\/issues\/(\d+)$/;

/** The ms value of an ISO stamp, or `null` when it does not parse. */
function ms(stamp: unknown): number | null {
  if (!isString(stamp)) return null;
  const t = Date.parse(stamp);
  return Number.isNaN(t) ? null : t;
}

/**
 * The item's stage as another machine can know it.
 *
 * A RELEASED claim whose `reason` is a stage says that stage: the driver
 * releases at a terminal stage WITHOUT a final state heartbeat, passing the
 * stage as the release reason (`stage <n> merged` → `release … merged`), so
 * the claim's `state.stage` is still the stage before it — `merging`, for a
 * merged item. A release for any other reason (`resumed`, `stale`) is not a
 * stage and falls through to `state`. No state at all reads as `preflight`,
 * the stage at which a run claims.
 */
function stageOf(record: ClaimRecord, state: ClaimState): RunStage {
  if (record.released !== undefined && isRunStage(record.released.reason)) return record.released.reason;
  return state.stage ?? 'preflight';
}

/** A queue item from an issue's newest claim in the group, defaulted the way
 *  `makeQueueItem` defaults a fresh one. */
function queueItemOf(issueNumber: number, claim: ParsedClaim, title: string | null): RunQueueItem {
  const state = readClaimState(claim.record.state);
  const item: RunQueueItem = {
    // The inside-a-run spelling: a bare issue number, never `#31` or a URN.
    id: String(issueNumber),
    title: title ?? `#${issueNumber}`,
    stage: stageOf(claim.record, state),
    sessionId: state.sessionId ?? null,
    worktree: state.worktree ?? null,
    branch: state.branch ?? null,
    // Not published (`ClaimState` does not carry it), so unknown here.
    permissionMode: null,
    // Always `null` for a remote run, and not for want of a field to publish
    // it in: a pid is meaningful only on the machine whose kernel minted it,
    // so carrying another machine's across would be a number this one could
    // signal by accident. The one reader (`cmdAbort`) never sees a remote
    // run at all — it reads this machine's own run file.
    pid: null,
    fixLoops: state.fixLoops ?? 0,
    stageAt: state.stageAt ?? {},
    verification: state.verification ?? [],
    questions: [],
    note: state.note ?? null,
    assumptions: state.assumptions ?? [],
    claim: { commentId: claim.commentId }
  };
  if (state.usage !== undefined) item.usage = state.usage;
  return item;
}

/**
 * The run's status and freshness from its claims (the item's Decision 5):
 *
 *   * `F` is the newest `finished` stamp in the group, by `finished.at`.
 *   * If `F` exists and no OTHER claim's `heartbeat` is later than `F.at`, the
 *     run is `F.status` (see the loop below for why F's own claim is excluded).
 *   * Otherwise it is `running`, fresh while the newest heartbeat is younger
 *     than `RUN_STALE_MS`.
 *
 * Deliberately NOT spec §7.3's "else the last-touched claim's outcome": that
 * would report a crashed run — every heartbeat stale, never finished — as
 * having finished, and "a crashed run renders as crashed, never as nothing"
 * holds for a remote run too. `running && !fresh` is what the Runs page already
 * draws as crashed. The "heartbeat later than `F.at`" clause is a run that was
 * paused and then resumed: its re-claims heartbeat after the `paused` stamp.
 */
function statusOf(claims: readonly ParsedClaim[], nowMs: number): { status: RemoteRun['status']; fresh: boolean } {
  let finished: ClaimFinished | null = null;
  let finishedAt = -Infinity;
  let finishedOn = -1;
  let newestBeat = -Infinity;
  for (const { commentId, record } of claims) {
    const beat = ms(record.heartbeat);
    if (beat !== null && beat > newestBeat) newestBeat = beat;
    const f = record.finished;
    const at = f === undefined ? null : ms(f.at);
    if (f !== undefined && at !== null && at > finishedAt) {
      finished = f;
      finishedAt = at;
      finishedOn = commentId;
    }
  }
  const fresh = newestBeat !== -Infinity && nowMs - newestBeat < RUN_STALE_MS;
  if (finished === null) return { status: 'running', fresh };

  // "A heartbeat later than F" is asked of every claim EXCEPT the one carrying
  // F. `finish` stamps through the heartbeat route, and on a claim that is
  // still unreleased (a `needs-answers` item keeps its claim) that request
  // also moves the heartbeat — to the SERVER's clock, milliseconds after the
  // `at` the CLI chose. Counting it would read every such run as resumed the
  // instant it finished. Nothing is lost by the exclusion: a resumed run
  // re-claims its held items, and a re-claim is a takeover that posts a NEW
  // comment (`GithubSource.claim`), so a resume always heartbeats elsewhere.
  let resumed = false;
  for (const { commentId, record } of claims) {
    if (commentId === finishedOn) continue;
    const beat = ms(record.heartbeat);
    if (beat !== null && beat > finishedAt) resumed = true;
  }
  return resumed ? { status: 'running', fresh } : { status: finished.status, fresh };
}

/**
 * Every run one repository's claim comments describe, minus the ones this
 * machine holds a run file for.
 *
 * A run whose `runId` is in `localRunIds` is DROPPED, never merged: the local
 * journal is the richer record and the one this machine's controls act on, and
 * overlaying claim state onto it field by field would make "which one is
 * right" a per-field question. Claims without a `run` (a hand `start`) belong
 * to no run and are ignored.
 */
export function deriveRemoteRuns(input: DeriveRemoteRunsInput): RemoteRun[] {
  const { repo, project, issueTitle, localRunIds, nowMs } = input;
  const comments = [...input.comments];

  // runId → issue number → that issue's claims in this run.
  const groups = new Map<string, Map<number, ParsedClaim[]>>();
  for (const [issueNumber, claims] of claimsByIssue(comments)) {
    for (const claim of claims) {
      const runId = claim.record.run?.runId;
      if (!isString(runId) || localRunIds.has(runId)) continue;
      let byIssue = groups.get(runId);
      if (byIssue === undefined) groups.set(runId, (byIssue = new Map()));
      const bucket = byIssue.get(issueNumber);
      if (bucket === undefined) byIssue.set(issueNumber, [claim]);
      else bucket.push(claim);
    }
  }
  if (groups.size === 0) return [];

  // Attention comments, keyed by run.
  const attention = new Map<string, Array<{ at: string; commentId: number; entry: RunAttention }>>();
  for (const comment of comments) {
    const parsed = parseAttention(comment);
    if (parsed === null || !groups.has(parsed.runId)) continue;
    const tail = isString(comment.issue_url) ? ISSUE_TAIL.exec(comment.issue_url) : null;
    if (tail === null) continue;
    const list = attention.get(parsed.runId) ?? [];
    list.push({ at: comment.created_at, commentId: comment.id, entry: { id: tail[1], kind: parsed.kind, detail: parsed.detail } });
    attention.set(parsed.runId, list);
  }

  const out: RemoteRun[] = [];
  for (const [runId, byIssue] of groups) {
    const all: ParsedClaim[] = [];
    const newest: Array<{ issueNumber: number; claim: ParsedClaim }> = [];
    for (const [issueNumber, claims] of byIssue) {
      all.push(...claims);
      // `claimsByIssue` sorts each bucket ascending by comment id, and the
      // bucket here keeps that order: the last one is the newest.
      newest.push({ issueNumber, claim: claims[claims.length - 1] });
    }
    // The queue in the order the run took its items: by claim `at`, ties (and
    // unparseable stamps) broken by comment id so the order is total.
    newest.sort((a, b) => (ms(a.claim.record.at) ?? 0) - (ms(b.claim.record.at) ?? 0) || a.claim.commentId - b.claim.commentId);

    // The run facts off the newest claim in the group — every claim carries all
    // six, so any would do, and the newest is the one least likely to predate
    // a mode change (`mergeMode` is the EFFECTIVE mode, which can degrade).
    const lead = all.reduce((a, b) => (b.commentId > a.commentId ? b : a));
    const run = lead.record.run!;

    let updated = -Infinity;
    let updatedAt = run.startedAt;
    for (const { record } of all) {
      for (const stamp of [record.heartbeat, record.released?.at, record.finished?.at]) {
        const t = ms(stamp);
        if (t !== null && t > updated) {
          updated = t;
          updatedAt = stamp as string;
        }
      }
    }

    const { status, fresh } = statusOf(all, nowMs);
    const notes = (attention.get(runId) ?? []).sort((a, b) => a.commentId - b.commentId).map((a) => a.entry);

    out.push({
      runId,
      project,
      status,
      startedAt: run.startedAt,
      updatedAt,
      maxItems: run.maxItems ?? null,
      base: run.base,
      mergeMode: run.mergeMode,
      mergeModeEffective: run.mergeMode,
      mergeModeNote: null,
      questionMode: run.questionMode,
      driver: null,
      queue: newest.map(({ issueNumber, claim }) => queueItemOf(issueNumber, claim, issueTitle(issueNumber))),
      attention: notes,
      fresh,
      remote: true,
      repo
    });
  }
  // Newest run first, the order every other run list on the page uses.
  return out.sort((a, b) => (ms(b.startedAt) ?? 0) - (ms(a.startedAt) ?? 0));
}
