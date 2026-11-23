import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';

import { SameOriginPostGuard } from '../origin.guard';
import { PrResolveService } from './pr-resolve.service';
import type { AgentDispatchResult, PrResolvePayload } from '../../../shared/types';

/**
 * The board's PR conflict resolve (spec 2026-11-17-pr-conflict-resolve-design.md). Its own controller under the `api/agents` prefix, like the Jira routes:
 * it shares nothing with `AgentsController`'s services, and a dependency there would put a PR import into every one of them.
 *
 * `dispatch-pr-resolve` takes the body's `repo` and `number` and nothing else — the service parses it (`parseResolveBody`) and composes the trigger from a
 * fresh PR read, never from the request — and is guarded like every agents POST, since it starts a session that pushes to a repository. The GET is the
 * read the board polls beside `GET /api/prs`: unguarded, always 200, memory plus a scan of the skill's outcome files.
 */
@Controller('api/agents')
export class PrResolveController {
  constructor(private readonly resolves: PrResolveService) {}

  @UseGuards(SameOriginPostGuard)
  @Post('dispatch-pr-resolve')
  @HttpCode(201)
  dispatch(@Body() body: unknown): Promise<AgentDispatchResult> {
    return this.resolves.dispatch(body);
  }

  @Get('pr-resolve')
  list(): Promise<PrResolvePayload> {
    return this.resolves.list();
  }
}
