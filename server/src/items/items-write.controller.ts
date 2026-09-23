import { Body, Controller, HttpException, Post, UseGuards } from '@nestjs/common';

import { ItemsService, type WriterLookup } from './items.service';
import { SameOriginPostGuard } from '../agents/origin.guard';
import { KIND_NAMES } from '../tracker/labels';
import { isMergeMode, isQuestionMode } from '../../../shared/agent';
import { CLAIM_FINISHED_STATUSES, MERGE_MODES, QUESTION_MODES } from '../../../shared/types';
import type { CreatedItem, WriteOutcome, WriteRefusal } from './sources/source';
import type { ClaimCounters, ClaimFinished, ClaimFinishedStatus, ClaimResult, ClaimRun, Section } from '../../../shared/types';

/**
 * items-write.controller.ts — the eight write routes of a tracker project
 * (task-46, spec §6.2; the eighth, `queue`, is the orchestrator:queued spec's §2).
 *
 * ## What this file is, and what it deliberately is not
 *
 * Eight thin pass-throughs. Every route does the same four things in the same
 * order and nothing else: rebuild the body field by field, ask
 * `ItemsService.writerFor` whether this project can be written to at all, call
 * one `ItemWriter` method, and turn its `WriteRefusal` into a status. No route
 * here talks to GitHub, holds a token, or knows what a claim is — all three
 * live behind the writer seam, which is what keeps "where can this process
 * write" answerable by reading `github.source.ts` alone.
 *
 * **The token never leaves the server.** It is read per call inside the
 * adapter (`token.util.ts`) and no response shape here carries it; a project
 * with no token gets a 503 naming the ENVIRONMENT VARIABLE, which is the thing
 * an operator can act on, and never the value.
 *
 * ## Why these are guarded like the agents POSTs
 *
 * `@UseGuards(SameOriginPostGuard)` on every one of them, imported from
 * `agents/` — the guard has no agents-specific dependency and moving it to a
 * shared home is not this phase's job. These routes CREATE AND CLOSE ISSUES in
 * somebody's repository with a credential the browser never sees, which is a
 * strictly larger consequence than the dispatch route the guard was written
 * for: a hidden cross-origin form auto-submit needs no CORS preflight, and
 * without the guard any page in the developer's browser could file issues, edit
 * bodies and close items. `test/agents-origin-guard.test.ts`'s route list is
 * where the guarded set lives, and it grew by these eight.
 *
 * A JSON POST with NO `Origin` at all still passes, deliberately and by the
 * guard's existing rule — because the CLI is exactly that caller.
 * `backlog.mjs` in API mode is a Node process, not a browser, and requiring an
 * origin would break every skill while adding nothing a browser cannot already
 * forge.
 *
 * ## The refusal order, and why it is fixed
 *
 * Malformed body (400) · unregistered project (404) · files project (400) ·
 * unsupported marker (400) · no token (503) · issue not found (404) · rate
 * limited (429) · anything else from GitHub (502).
 *
 * The first four are answered here, before the adapter is reached, so none of
 * them can make a network call — which is the property `test/tracker-write.
 * test.ts` asserts directly: a `files` project, an unregistered path, an
 * unsupported marker and a missing token all answer with `fetch` untouched.
 * The last four are the adapter's verdict, mapped one-to-one; no route invents
 * a status of its own.
 */
@Controller('api/items')
@UseGuards(SameOriginPostGuard)
export class ItemsWriteController {
  constructor(private readonly items: ItemsService) {}

  /**
   * A new item. `section` becomes the `type:*` label — the label IS the
   * section, so this is what decides which column it lands in on every machine.
   */
  @Post('create')
  async create(@Body() body: Record<string, unknown> | undefined): Promise<CreatedItem> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const section = text(raw.section);
    if (!CREATABLE_SECTIONS.includes(section as Section)) {
      throw new HttpException({ error: `section must be one of ${CREATABLE_SECTIONS.join(', ')}` }, 400);
    }
    const title = required(raw.title, 'title');
    // The body is taken VERBATIM — not trimmed, not defaulted to a template.
    // It is the item's text, composed by the skill, and a server that trimmed
    // it would silently change bytes a groom is about to diff against.
    const itemBody = typeof raw.body === 'string' ? raw.body : '';
    const kind = raw.kind === undefined ? undefined : text(raw.kind);
    if (kind !== undefined && !KIND_NAMES.includes(kind)) {
      // A 400 rather than a dropped field: a caller that asked for a label this
      // build does not know has made a mistake worth hearing about, and GitHub
      // would otherwise CREATE the label silently on first use — a mystery grey
      // label instead of a refusal.
      throw new HttpException({ error: `kind must be one of ${KIND_NAMES.join(', ')}` }, 400);
    }
    const from = raw.from === undefined ? undefined : text(raw.from);

    const lookup = this.items.writerFor(project);
    const w = this.writable(lookup);
    return this.answer(
      await w.writer.create(w.project, w.marker, {
        project,
        section: section as Section,
        title,
        body: itemBody,
        kind,
        // Strictly `=== true`, the same parse rule `remoteControl` follows on
        // the dispatch route: anything else means off.
        runnerFix: raw.runnerFix === true,
        from
      })
    );
  }

  /** `move <id> done|out-of-scope`, with the Outcome as the closing comment. */
  @Post('state')
  async state(@Body() body: Record<string, unknown> | undefined): Promise<{ id: string; status: string; url: string }> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    const status = text(raw.status);
    if (status !== 'done' && status !== 'out-of-scope') {
      throw new HttpException({ error: 'status must be done or out-of-scope' }, 400);
    }
    const outcome = typeof raw.outcome === 'string' ? raw.outcome : '';

    const w = this.writable(this.items.writerFor(project));
    return this.answer(await w.writer.state(w.project, w.marker, { project, id, status, outcome }));
  }

  /** Take the issue. The protocol's entry point — see `tracker/claim.ts`. */
  @Post('claim')
  async claim(@Body() body: Record<string, unknown> | undefined): Promise<ClaimResult> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    const phase = text(raw.phase);
    if (phase !== 'groom' && phase !== 'execute') {
      throw new HttpException({ error: 'phase must be groom or execute' }, 400);
    }
    const session = required(raw.session, 'session');
    const host = optional(raw.host, 'host');
    const run = claimRunOf(raw.run);

    const w = this.writable(this.items.writerFor(project));
    return this.answer(await w.writer.claim(w.project, w.marker, { project, id, phase, session, host, run }));
  }

  /** Give it back, billing the counters the CALLER computed — the CLI is the
   *  biller, here as in `stopItem`. `runId` (bug-42) is the optional assertion
   *  "this is my run's claim", which is how an abort session that is not the
   *  holder releases a live claim — see `runIdOf` and `GithubSource.release`.
   *  `host` (bug-48) is its human sibling, "this is my MACHINE's claim", which
   *  is how `backlog.mjs abort` clears a fresh claim left by a session killed
   *  mid-item — validated by the same `optional` the `claim` route's `host`
   *  uses, since it is the same field answering a question about the same
   *  record. */
  @Post('release')
  async release(@Body() body: Record<string, unknown> | undefined): Promise<ClaimResult> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    const commentId = commentIdOf(raw.commentId);
    const session = required(raw.session, 'session');
    const reason = required(raw.reason, 'reason');
    const counters = countersOf(raw.counters);
    const runId = runIdOf(raw.runId);
    const host = optional(raw.host, 'host');

    const w = this.writable(this.items.writerFor(project));
    return this.answer(await w.writer.release(w.project, w.marker, { project, id, commentId, session, reason, counters, runId, host }));
  }

  /** Say the session is still alive; carry the driver's opaque `state` when
   *  given, and `finish`'s `finished` stamp — the one field this route also
   *  accepts on a RELEASED claim (see `GithubSource.heartbeat`). `session` is
   *  required and `runId` optional for the same reasons they are on `release`:
   *  a heartbeat names its author, and a resumed driver proves itself by its
   *  run (bug-45). */
  @Post('heartbeat')
  async heartbeat(@Body() body: Record<string, unknown> | undefined): Promise<ClaimResult> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    const commentId = commentIdOf(raw.commentId);
    const session = required(raw.session, 'session');
    const runId = runIdOf(raw.runId);
    const finished = claimFinishedOf(raw.finished);

    const w = this.writable(this.items.writerFor(project));
    // `state` is the ONE field on these eight routes taken outright, and it is
    // safe for the reason the dispatch route's `prompt` is not: no predicate
    // branches on it. It is the `ClaimState` task-47's driver publishes,
    // round-tripped into a comment this app wrote and back out again; its one
    // reader (task-48's remote-run assembly) only DRAWS it, and reads it
    // tolerantly. `run`, one route over, is the opposite case and is validated
    // field by field for exactly that reason — and so is `finished`, which a
    // derived run's status is decided from.
    return this.answer(await w.writer.heartbeat(w.project, w.marker, { project, id, commentId, session, runId, state: raw.state, finished }));
  }

  /** Groom's route — the ONE route that rewrites an item's body (§6.4), behind
   *  an `ifUpdatedAt` check against a fresh read. */
  @Post('body')
  async body(@Body() body: Record<string, unknown> | undefined): Promise<{ id: string; updatedAt: string }> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    const itemBody = typeof raw.body === 'string' ? raw.body : '';
    const ifUpdatedAt = required(raw.ifUpdatedAt, 'ifUpdatedAt');
    // Three states, and `undefined` is one of them — see `ItemBodyRequest.
    // runnerFix`. A non-boolean is a 400 rather than a coerced value for the
    // reason `kind` is: a caller that sent `'yes'` meant something, and
    // dropping it would leave the marker silently unset on an item a groom
    // just decided repairs the runner.
    if (raw.runnerFix !== undefined && typeof raw.runnerFix !== 'boolean') {
      throw new HttpException({ error: 'runnerFix must be a boolean' }, 400);
    }
    const runnerFix = raw.runnerFix as boolean | undefined;

    const w = this.writable(this.items.writerFor(project));
    return this.answer(await w.writer.patchBody(w.project, w.marker, { project, id, body: itemBody, ifUpdatedAt, runnerFix }));
  }

  /** Append a comment. Execute's failure path: the Outcome is recorded and the
   *  item does not move. */
  @Post('comment')
  async comment(@Body() body: Record<string, unknown> | undefined): Promise<{ commentId: number; url: string }> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    const itemBody = typeof raw.body === 'string' ? raw.body : '';
    if (itemBody.trim() === '') throw new HttpException({ error: 'body is required' }, 400);

    const w = this.writable(this.items.writerFor(project));
    return this.answer(await w.writer.comment(w.project, w.marker, { project, id, body: itemBody }));
  }

  /**
   * The eighth route (the orchestrator:queued spec, §2): add or remove the
   * advisory `orchestrator:queued` label. The driver's only way to GitHub for
   * it — the headless session never sees the token.
   *
   * `queued` must be a literal boolean, and a non-boolean is a 400 rather than
   * a coerced value for the reason `body`'s `runnerFix` is: a caller that sent
   * `'yes'` meant something, and coercing `'false'` to truthy would add the
   * label a sweep was trying to take off.
   */
  @Post('queue')
  async queue(@Body() body: Record<string, unknown> | undefined): Promise<{ id: string; queued: boolean }> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    if (typeof raw.queued !== 'boolean') throw new HttpException({ error: 'queued must be a boolean' }, 400);
    const queued = raw.queued;

    const w = this.writable(this.items.writerFor(project));
    return this.answer(await w.writer.queue(w.project, w.marker, { project, id, queued }));
  }

  /**
   * The project gate, in one place for all eight (the second, third and fourth
   * refusals). Throws rather than returning a union, because every caller does
   * the identical thing with a failure and an eighth copy of that branch is
   * eight chances for one of them to answer 404 where the others answer 400.
   */
  private writable(lookup: WriterLookup): Extract<WriterLookup, { kind: 'writer' }> {
    // 404 rather than 400: a path this server was never told about is, as far
    // as this caller is concerned, not a project — the same answer
    // `uncommitted` and `mergeCheck` already give an unregistered path.
    if (lookup.kind === 'unregistered') throw new HttpException({ error: 'not found' }, 404);
    if (lookup.kind === 'files') {
      throw new HttpException({ error: "this project's items are files — the skills write them directly" }, 400);
    }
    // `resolveSource`'s own reason, already prefixed with the marker's absolute
    // path, rather than a sentence composed here: it is the same string
    // `ItemsIndex.errors` carries for the same project, and two wordings for
    // one fact is how a reader ends up believing they are two facts.
    if (lookup.kind === 'unsupported') throw new HttpException({ error: lookup.reason }, 400);
    return lookup;
  }

  /**
   * One `WriteOutcome` → the response, or the exception. The ONE mapping from
   * `refused` to a status, so no route can invent its own.
   *
   * Each status is chosen for what the READER can do about it: 503 for a
   * credential this machine is missing (fix the environment), 404 for an issue
   * that is not there (fix the id), 409 for a race or a stale read (re-read and
   * retry), 429 for a budget with a time on it (wait), 502 for anything else
   * GitHub said (nothing local to fix).
   */
  private answer<T>(outcome: WriteOutcome<T>): T {
    if (outcome.ok) return outcome.value;
    const r: WriteRefusal = outcome.refusal;
    switch (r.refused) {
      case 'no-token':
        throw new HttpException({ error: r.error }, 503);
      case 'not-found':
        throw new HttpException({ error: r.error }, 404);
      case 'conflict':
        // `holder` and `updatedAt` ride along when the adapter set them: each
        // is what the caller needs in order to do something other than give up
        // — who holds the claim, or the stamp to re-read against.
        throw new HttpException({ error: r.error, holder: r.holder, updatedAt: r.updatedAt }, 409);
      case 'rate-limited':
        throw new HttpException({ error: r.error, resetAt: r.resetAt ?? null }, 429);
      default:
        throw new HttpException({ error: r.error, status: r.status ?? null }, 502);
    }
  }
}

/** The five sections `create` accepts — every one of them, `out-of-scope`
 *  included, which is the tracker spelling of filing something already decided
 *  against. */
const CREATABLE_SECTIONS: readonly Section[] = ['bugs', 'ideas', 'tasks', 'refactors', 'out-of-scope'];

/** A field read as a trimmed string, `''` for anything that is not one. The
 *  shape every identifier-ish field on these routes takes — never a spread of
 *  the caller's object, the rule `AgentsController.dispatch` already follows. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** …and the same, refusing an empty one by name, because a missing `project`
 *  and a missing `id` are different mistakes and a caller should be told which
 *  it made. */
function required(value: unknown, field: string): string {
  const trimmed = text(value);
  if (trimmed === '') throw new HttpException({ error: `${field} is required` }, 400);
  return trimmed;
}

/**
 * A field that may be absent, but must be a non-empty string when it is there
 * — `host`'s rule (bug-46), which is `required`'s minus the requirement.
 *
 * The middle case is the one worth the helper: a caller that sent `host: 7` or
 * `host: '  '` has made a mistake, and answering 400 says so where dropping
 * the field would publish a claim that is silently missing the one thing this
 * field exists to carry. `undefined` is the only value that means "did not
 * send one", so a `null` is a 400 too.
 */
function optional(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = text(value);
  if (trimmed === '') throw new HttpException({ error: `${field} must be a non-empty string` }, 400);
  return trimmed;
}

/** A comment id: a positive integer, and nothing else. It is interpolated into
 *  a URL path, so a float or a string that happens to parse would reach GitHub
 *  as a path nobody meant. */
function commentIdOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpException({ error: 'commentId must be a positive integer' }, 400);
  }
  return value;
}

/**
 * The four counters, or `undefined` when the caller sent none — a release with
 * nothing to bill (`--abandon`) sends no `counters` key at all, and that is a
 * value rather than four zeros: zeros would OVERWRITE the totals the claim was
 * seeded with, silently erasing every earlier session's work on the item.
 *
 * All four required together and each a non-negative integer, checked rather
 * than clamped: these numbers are written verbatim into a comment that is the
 * only record of them, and a clamp would quietly bank a wrong total where a 400
 * sends the caller back to fix the arithmetic.
 */
/**
 * `ItemClaimRequest.run`, or `undefined` when the caller sent none (task-47).
 *
 * Validated field by field, and it is the only nested object on these seven
 * routes that is — `heartbeat`'s `state` is taken outright one route over, and
 * the difference between them is the whole rule: **the server BRANCHES on this
 * one.** `runId` decides whether a contesting claim is a takeover or a race
 * (`GithubSource.claim`), so a value of the wrong type here does not merely
 * travel through and come back out again — it silently matches no run,
 * contests its own run's claim, and the resumed driver loses the item it
 * already held. `state` has no such reading and is round-tripped verbatim.
 *
 * Each refusal NAMES the field, `run.mergeMode` rather than `run`, because the
 * caller is a CLI composing this object out of a run file: "something in `run`
 * is wrong" sends it re-reading six fields, and one name sends it to the line.
 *
 * `mergeMode` and `questionMode` are checked against the two guards that
 * already exist rather than against literals — the same "one copy of the
 * vocabulary" rule `MERGE_MODES` exists for, and the same two guards
 * `AgentsService` runs on the orchestrate route.
 */
function claimRunOf(value: unknown): ClaimRun | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ error: 'run must be an object' }, 400);
  }
  const raw = value as Record<string, unknown>;
  for (const key of ['runId', 'startedAt', 'base'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).trim() === '') {
      throw new HttpException({ error: `run.${key} must be a non-empty string` }, 400);
    }
  }
  if (!isMergeMode(raw.mergeMode)) {
    throw new HttpException({ error: `run.mergeMode must be one of ${MERGE_MODES.join(', ')}` }, 400);
  }
  if (!isQuestionMode(raw.questionMode)) {
    throw new HttpException({ error: `run.questionMode must be one of ${QUESTION_MODES.join(', ')}` }, 400);
  }
  // `null` is a VALUE here (an uncapped run), not an absent field — the same
  // distinction `OrchestratorRun.maxItems` carries — so it is accepted
  // explicitly rather than falling through the integer check.
  if (raw.maxItems !== null && (typeof raw.maxItems !== 'number' || !Number.isInteger(raw.maxItems) || raw.maxItems < 0)) {
    throw new HttpException({ error: 'run.maxItems must be a non-negative integer or null' }, 400);
  }
  return {
    runId: (raw.runId as string).trim(),
    startedAt: (raw.startedAt as string).trim(),
    mergeMode: raw.mergeMode,
    questionMode: raw.questionMode,
    maxItems: raw.maxItems as number | null,
    base: (raw.base as string).trim()
  };
}

/**
 * `ItemHeartbeatRequest.finished`, or `undefined` when the caller sent none
 * (task-48).
 *
 * Validated field by field, the `run` rule rather than the `state` one, because
 * something decides on it: a derived remote run's `status` IS this value. A
 * `status` outside the four, or an `at` that does not parse, would otherwise be
 * banked into a comment where it reads as a run that finished with no known
 * outcome at no known time. The refusal happens before the adapter is reached,
 * so nothing is edited.
 */
function claimFinishedOf(value: unknown): ClaimFinished | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ error: 'finished must be an object' }, 400);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) {
    throw new HttpException({ error: 'finished.at must be an ISO 8601 timestamp' }, 400);
  }
  if (!CLAIM_FINISHED_STATUSES.includes(raw.status as ClaimFinishedStatus)) {
    throw new HttpException({ error: `finished.status must be one of ${CLAIM_FINISHED_STATUSES.join(', ')}` }, 400);
  }
  return { at: raw.at, status: raw.status as ClaimFinishedStatus };
}

/**
 * `ItemReleaseRequest.runId`, or `undefined` when the caller sent none
 * (bug-42) — the run asserting it owns the claim it is releasing.
 *
 * A 400 rather than a dropped field, for exactly the reason `claimRunOf`'s
 * comment gives about `run`: this is a field the SERVER BRANCHES on, and a
 * silently dropped one turns an authorised release into a refusal nobody can
 * explain — the abort session would be told the claim is held by a session
 * that no longer exists, with nothing anywhere naming the value that was
 * thrown away.
 *
 * Trimmed like every other string on these routes, and an empty one is the
 * same mistake as a missing one rather than a value: the adapter's same-run
 * test requires a non-empty string, so accepting `''` here would only move
 * the silent no-match one layer down.
 */
function runIdOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') throw new HttpException({ error: 'runId must be a non-empty string' }, 400);
  return trimmed;
}

function countersOf(value: unknown): ClaimCounters | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ error: 'counters must be an object with four non-negative integers' }, 400);
  }
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ['groomElapsed', 'executeElapsed', 'groomTokens', 'executeTokens']) {
    const n = raw[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new HttpException({ error: `counters.${key} must be a non-negative integer` }, 400);
    }
    out[key] = n;
  }
  return out as unknown as ClaimCounters;
}
