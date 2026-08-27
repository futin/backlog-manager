import { Body, Controller, Get, HttpException, Post } from '@nestjs/common';

import { AgentsService } from './agents.service';
import type { AgentDispatchRequest, AgentDispatchResult, AgentPlan, AgentsStatus } from '../../../shared/types';

/**
 * Under /api like every other controller — test/vite-proxy.test.ts asserts it
 * from Nest's own route metadata, because a route outside /api would not 404
 * in dev, it would be answered by Vite's SPA fallback with index.html.
 */
@Controller('api/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /**
   * Read-only and always 200, even when the dashboard is down: "is this wired
   * up" is exactly the question a failing request cannot answer. The reason
   * rides in `error`.
   */
  @Get('status')
  status(): Promise<AgentsStatus> {
    return this.agents.status();
  }

  /**
   * POST, not GET, because the item's absolute path is the argument: a path in
   * a query string ends up in access logs and in the browser's history, and
   * this one names a file on a developer's disk.
   */
  @Post('plan')
  plan(@Body() body: { itemPath?: unknown } | undefined): Promise<AgentPlan> {
    const itemPath = typeof body?.itemPath === 'string' ? body.itemPath.trim() : '';
    if (itemPath === '') throw new HttpException({ error: 'itemPath is required' }, 400);
    return this.agents.plan(itemPath);
  }

  /**
   * The one endpoint in this app that starts something. Validation lives in the
   * service, not here, because it needs the item file — the controller only
   * proves the body has the right shape.
   */
  @Post('dispatch')
  dispatch(@Body() body: Partial<AgentDispatchRequest> | undefined): Promise<AgentDispatchResult> {
    const itemPath = typeof body?.itemPath === 'string' ? body.itemPath.trim() : '';
    if (itemPath === '') throw new HttpException({ error: 'itemPath is required' }, 400);
    if (body?.action !== 'groom' && body?.action !== 'execute') {
      throw new HttpException({ error: 'action must be groom or execute' }, 400);
    }
    return this.agents.dispatch({
      itemPath,
      action: body.action,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      // Unvalidated on purpose: clampMode is the place a junk mode becomes
      // 'plan', and it is applied server-side after the ceiling is known.
      permissionMode: body.permissionMode as AgentDispatchRequest['permissionMode'],
      remoteControl: body.remoteControl === true
    });
  }
}
