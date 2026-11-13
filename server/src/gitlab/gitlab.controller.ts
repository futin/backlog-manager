import { Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import type { GitlabPayload } from '../../../shared/types';
import { SameOriginPostGuard } from '../agents/origin.guard';
import { GitlabPollerService } from './poller.service';

/**
 * `/api/gitlab` — the read-only GitLab connection's two routes (spec §6). Everything a response carries is built by `GitlabPollerService.payload()`, which
 * holds neither the token nor a remote's userinfo, so this controller has nothing to redact: it never touches the environment or a git remote itself.
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
}
