import { Body, Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { SameOriginPostGuard } from '../agents/origin.guard';

import { originRepo } from './origin.util';
import { TrackerPollerService } from './poller.service';
import { PullRequestsService } from './pulls.service';
import { isRepo } from './github.client';
import { resolveSource } from '../items/sources/resolve.util';
import { RegistryService, registryProjectsOr503 } from '../registry/registry.service';
import type { TrackerProjectRow, TrackersPayload } from '../../../shared/types';

/**
 * `GET /api/trackers` — the Shared Settings page's Sources card and GitHub ›
 * Settings' Sync card (task-45, spec §5.6; split by the source-sections change). Read-only: there is no connections file, and connecting a
 * project is `backlog.mjs connect` writing a marker someone then commits. The
 * card's one write — a repo's sync interval (#17) — is `POST /api/trackers/sync`,
 * which lives in `orchestrator/tracker-sync.controller.ts` for the module-cycle
 * reason its header gives, not here.
 *
 * Under `/api` like every other route (CLAUDE.md), and unguarded for
 * `ItemsController.uncommitted`'s stated reason: `SameOriginPostGuard` answers
 * "may this caller POST at all", and this route starts nothing and reads no
 * caller-supplied path. It discloses strictly less than `/api/projects`
 * already does to the same reader — plus one login and a rate-limit count,
 * and **never the token**.
 *
 * A registry that cannot be read is a 503, as on `/api/projects` (#349): this
 * card would otherwise draw "nothing registered yet" for a broken file.
 *
 * Every read is per request and cached nowhere: the registry, each project's
 * marker, and each files project's `origin`. The one thing that IS cached —
 * the poll state — is cached in the poller, whose age this card renders.
 */
@Controller('api')
export class TrackerController {
  constructor(
    private readonly registry: RegistryService,
    private readonly poller: TrackerPollerService,
    private readonly prs: PullRequestsService
  ) {}

  /**
   * `POST /api/github/sweep` — the popover head's `Sync now`, or one repo's with `{ repo }`. It writes nothing and runs no git: it asks the poller for one
   * sweep now and then the PR cache for one re-read of the swept repos (past its TTL), and answers the `trackers()` payload so the client replaces its
   * cache with the new ages. Guard → validate (400: a `repo` that is not an `owner/name` string) → `sweepNow`: `not-armed` is a 409 (no token, or nothing
   * connected), `unknown` the 404 `GET /api/prs`'s writes use, `wait` a 429 with the later sleep end as `retryAt`. A 401, a 5xx or a transport failure
   * inside the sweep is the poller's to record (`access`, `detail`) and is a 200 here: the request itself worked. The token is never in a body.
   */
  @Post('github/sweep')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async sweep(@Body() body: unknown): Promise<TrackersPayload> {
    const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const raw = fields.repo;
    if (raw !== undefined && !isRepo(raw)) throw new HttpException({ error: 'repo must be an owner/name repository' }, 400);
    const repo = raw as string | undefined;
    const result = await this.poller.sweepNow(repo);
    if (result.kind === 'not-armed') throw new HttpException({ message: 'GitHub is not being polled' }, 409);
    if (result.kind === 'unknown') throw new HttpException({ error: `${repo} is not the repo of a registered GitHub project` }, 404);
    if (result.kind === 'wait') throw new HttpException({ message: 'rate limited', retryAt: new Date(result.retryAt).toISOString() }, 429);
    await this.prs.refreshNow(this.poller.sweepTargets(repo));
    return this.trackers();
  }

  @Get('trackers')
  async trackers(): Promise<TrackersPayload> {
    const platform = this.poller.platform();
    const projects: TrackerProjectRow[] = [];

    // Each project's source is resolved up front so the `origin` lookups — one
    // git spawn per FILES project, async since #277 — can run concurrently
    // rather than one after another: N projects on a slow bind mount would
    // otherwise cost N times the slow read. Still per request, memoised nowhere.
    const entries = registryProjectsOr503(this.registry).map((project) => ({ project, resolved: resolveSource(project.path, KNOWN) }));
    const origins = await Promise.all(entries.map(({ project, resolved }) => (resolved.kind === 'files' ? originRepo(project.path) : null)));

    for (const [index, { project, resolved }] of entries.entries()) {
      const row: TrackerProjectRow = {
        name: project.name,
        path: project.path,
        source: null,
        repo: null,
        polledAt: null,
        access: null,
        detail: null,
        interval: null,
        connect: null
      };

      if (resolved.kind === 'tracker' && isRepo(resolved.marker.repo)) {
        row.source = 'github';
        Object.assign(row, this.poller.summary(resolved.marker.repo));
      } else if (resolved.kind === 'tracker' || resolved.kind === 'unsupported') {
        // A marker that is present and cannot be honoured — malformed, or a
        // `github` marker with no usable `repo`. `unsupported` here matches
        // exactly what `/api/projects` says about the same project (since #400,
        // through `ItemSource.canHonour`), rather than inventing a second
        // vocabulary for the same state.
        row.source = 'unsupported';
      } else if (resolved.kind === 'files') {
        row.source = 'files';
        const origin = origins[index];
        // The suggestion, and only for a project that could actually take it:
        // a files project whose origin is on GitHub. Read per request (see
        // `origin.util.ts` for why it joins no memo).
        if (origin !== null) row.connect = `backlog.mjs connect github ${origin}`;
      }
      // `missing` stays all-nulls: a project with no `backlog/` at all has no
      // source to report and nothing to connect until someone runs `init` or
      // `connect`, which the board already reports in its own words.

      projects.push(row);
    }

    return {
      platforms: [
        {
          kind: 'github',
          hasToken: platform.token,
          login: platform.login,
          limit: platform.rate.limit,
          remaining: platform.rate.remaining,
          reset: platform.rate.reset
        }
      ],
      projects
    };
  }
}

/** The kinds this card can describe — the same single-adapter set the poller
 *  resolves with. */
const KNOWN: ReadonlySet<string> = new Set(['github']);
