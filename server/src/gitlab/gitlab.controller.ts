import { Body, Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { isSyncInterval, SYNC_INTERVALS, type GitlabPayload, type SyncInterval } from '../../../shared/types';
import { SameOriginPostGuard } from '../origin.guard';
import { GitlabPollerService } from './poller.service';
import { GitlabSyncUnreadableError, readGitlabInterval, writeGitlabInterval } from './sync-config.util';

/**
 * `/api/gitlab` — the read-only GitLab connection's routes (spec §6). Everything a response carries is built by `GitlabPollerService.payload()`, which
 * holds neither the token nor a remote's userinfo, so this controller has nothing to redact: it never touches the environment or a git remote itself. The one
 * thing it writes is this machine's sweep interval (`POST /api/gitlab/sync`, #527) — a settings file, never anything on GitLab, which stays read-only.
 */
@Controller('api/gitlab')
export class GitlabController {
  constructor(private readonly poller: GitlabPollerService) {}

  /** `GET /api/gitlab` — from memory; an identity read this triggers is not awaited. */
  @Get()
  get(): GitlabPayload {
    return this.poller.payload();
  }

  /**
   * `POST /api/gitlab/sweep` — the Sources row's `Sync now`. `arm()` first (spec §6.3 "What arms it"): a press is the one thing that can start a poller whose
   * every project was unmapped at bootstrap, and it is a no-op when already armed or unconfigured. Then the Jira sweep's mapping (`jira-write.controller.ts`):
   * `not-armed` is a 409, an open 429 window a 429 carrying its end, anything else a 200 — a 401 or a 5xx inside the sweep is the poller's to record in the
   * status, the request itself worked.
   */
  @Post('sweep')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async sweep(): Promise<{ ok: true }> {
    this.poller.arm();
    const result = await this.poller.sweepNow();
    if (result.kind === 'not-armed') throw new HttpException({ message: 'GitLab is not being polled' }, 409);
    if (result.kind === 'wait') throw new HttpException({ message: 'rate limited', retryAt: new Date(result.retryAt).toISOString() }, 429);
    return { ok: true };
  }

  /**
   * `POST /api/gitlab/sync` `{ interval }` — Jira › Setup › GitLab's Sync interval pill (#527), and `gitlab-sync.json`'s one write path. The sweep route's
   * guard. In order: a body that is not a plain object, or an interval that is not a `SyncInterval`, is a 400; a file that exists but does not parse is a
   * 409 and left untouched (`GitlabSyncUnreadableError`, the #270 rule); any other write failure propagates as Nest's 500. Then `reschedule()` so the new
   * interval counts from now, and the answer is the value the file NOW holds, read back — the card shows the server's answer, never the click.
   *
   * Allowed while GitLab is unconfigured (a fact about this machine, taking effect once it is configured), and with no "under a live run" refusal like the
   * tracker's `off`: GitLab is read-only here, so nothing a run does depends on the sweep.
   */
  @Post('sync')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  sync(@Body() body: unknown): { interval: SyncInterval } {
    const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { interval?: unknown }) : null;
    const interval = b?.interval;
    if (!isSyncInterval(interval)) throw new HttpException({ error: `interval must be one of ${Object.keys(SYNC_INTERVALS).join(', ')}` }, 400);
    try {
      writeGitlabInterval(interval);
    } catch (e) {
      if (e instanceof GitlabSyncUnreadableError) throw new HttpException({ error: e.message }, 409);
      throw e;
    }
    this.poller.reschedule();
    return { interval: readGitlabInterval() };
  }
}
