import { Body, Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { SameOriginPostGuard } from '../agents/origin.guard';
import { isRepo } from './github.client';
import { PullRequestsService, type PrWriteAnswer } from './pulls.service';
import {
  MERGE_METHODS,
  type MergeMethod,
  type PrAutoMergeRequest,
  type PrMergeRequest,
  type PrUpdateBranchRequest,
  type PrWriteResult,
  type PullRequestsPayload
} from '../../../shared/types';

/**
 * The PRs page's routes (spec 2026-10-29-source-sections-design.md, Goal 2): one read and the board's three pull-request writes — merge, auto-merge,
 * update-branch, nothing else. Every one is a GitHub API call made by `PullRequestsService` through the one `GithubClient`; none runs git, so "the server
 * never writes git" holds.
 *
 * `GET /api/prs` is unguarded, like every read here. The three POSTs each carry `SameOriginPostGuard` per route — `application/json` and a same-origin
 * `Origin`, 403 otherwise — the guard every other state-changing route carries; the Host allowlist is global and has answered before any handler runs, so a
 * tailnet host it admits may merge exactly as loopback may.
 *
 * The order is the contract: guard → validate (`400`, here, naming the field) → the service's ladder (`404` repo not registered, `503` no token, then inside
 * the per-PR chain `409` sync off and `429` asleep) → GitHub. A malformed body is wrong whatever the environment, so it never reads as an environment fact.
 * The service answers a value; this file turns a refusal into `{ error }` with its status, the shape every write route here answers.
 */

/** A head SHA as GitHub spells it — 40 lowercase hex. Anything else could only ever be refused by GitHub, so it is refused here without a request. */
const SHA = /^[0-9a-f]{40}$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** `repo` and `number`, which every write names: the PR as `<repo>#<number>`, its serialisation key. */
function target(b: Record<string, unknown>): Parsed<{ repo: string; number: number }> {
  if (!isRepo(b.repo)) return { ok: false, error: 'repo must be an owner/name repository' };
  if (typeof b.number !== 'number' || !Number.isSafeInteger(b.number) || b.number < 1) return { ok: false, error: 'number must be a positive integer' };
  return { ok: true, value: { repo: b.repo, number: b.number } };
}

function isMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && (MERGE_METHODS as readonly string[]).includes(value);
}

const METHOD_ERROR = `method must be one of ${MERGE_METHODS.join(', ')}`;
const SHA_ERROR = 'headSha must be a 40-character lowercase hex SHA';

export function parseMerge(body: unknown): Parsed<PrMergeRequest> {
  const b = fieldsOf(body);
  const t = target(b);
  if (!t.ok) return t;
  if (!isMethod(b.method)) return { ok: false, error: METHOD_ERROR };
  if (typeof b.headSha !== 'string' || !SHA.test(b.headSha)) return { ok: false, error: SHA_ERROR };
  return { ok: true, value: { ...t.value, method: b.method, headSha: b.headSha } };
}

export function parseAutoMerge(body: unknown): Parsed<PrAutoMergeRequest> {
  const b = fieldsOf(body);
  const t = target(b);
  if (!t.ok) return t;
  if (typeof b.enable !== 'boolean') return { ok: false, error: 'enable must be a boolean' };
  // `method` is required to arm, and checked when present to disarm too: a disarm carrying `method: 'fast'` is a malformed body, not a harmless extra.
  if (b.enable && b.method === undefined) return { ok: false, error: 'method is required to enable auto-merge' };
  if (b.method !== undefined && !isMethod(b.method)) return { ok: false, error: METHOD_ERROR };
  return { ok: true, value: { ...t.value, enable: b.enable, ...(isMethod(b.method) && { method: b.method }) } };
}

export function parseUpdateBranch(body: unknown): Parsed<PrUpdateBranchRequest> {
  const b = fieldsOf(body);
  const t = target(b);
  if (!t.ok) return t;
  if (typeof b.headSha !== 'string' || !SHA.test(b.headSha)) return { ok: false, error: SHA_ERROR };
  return { ok: true, value: { ...t.value, headSha: b.headSha } };
}

function valid<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new HttpException({ error: parsed.error }, 400);
  return parsed.value;
}

/** The service's value → the route's answer: the result (its status set by `@HttpCode`), or the refusal as `{ error }` under its own status. */
function unwrap(answer: PrWriteAnswer): PrWriteResult {
  if (!answer.ok) throw new HttpException({ error: answer.error }, answer.status);
  return answer.result;
}

@Controller('api/prs')
export class PullsController {
  constructor(private readonly prs: PullRequestsService) {}

  /** `GET /api/prs` — every registered GitHub repo's open PRs from the on-demand cache. A registry that cannot be read is the 503 `/api/trackers` answers. */
  @Get()
  list(): Promise<PullRequestsPayload> {
    return this.prs.list();
  }

  /** `POST /api/prs/merge` — `{ repo, number, method, headSha }`; `200` `merged` or `already-merged`. */
  @Post('merge')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async merge(@Body() body: unknown): Promise<PrWriteResult> {
    return unwrap(await this.prs.merge(valid(parseMerge(body))));
  }

  /** `POST /api/prs/auto-merge` — `{ repo, number, enable, method? }`; `200` `auto-merge-enabled`, `auto-merge-disabled` or `noop`. */
  @Post('auto-merge')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async autoMerge(@Body() body: unknown): Promise<PrWriteResult> {
    return unwrap(await this.prs.autoMerge(valid(parseAutoMerge(body))));
  }

  /** `POST /api/prs/update-branch` — `{ repo, number, headSha }`; `202` `update-requested`, because GitHub's update runs after it answers. */
  @Post('update-branch')
  @HttpCode(202)
  @UseGuards(SameOriginPostGuard)
  async updateBranch(@Body() body: unknown): Promise<PrWriteResult> {
    return unwrap(await this.prs.updateBranch(valid(parseUpdateBranch(body))));
  }
}
