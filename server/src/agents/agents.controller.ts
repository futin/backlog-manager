import { Body, Controller, Get, HttpException, Post, UseGuards } from '@nestjs/common';

import { AgentsService, type AgentOrchestrateRequest } from './agents.service';
import { SameOriginPostGuard } from './origin.guard';
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
   *
   * Guarded for the same reason `dispatch` is: it reads an arbitrary
   * registered item and reaches out to the dashboard, so a cross-origin page
   * must not be able to drive it either. See `origin.guard.ts`.
   */
  @UseGuards(SameOriginPostGuard)
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
   *
   * The guard is the exception: it answers "may this caller post at all", which
   * needs the raw request rather than the item, and it is the whole reason a
   * hidden form on an unrelated page cannot spawn a session. See
   * `origin.guard.ts`.
   */
  @UseGuards(SameOriginPostGuard)
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
      // Unvalidated here for the same reason, and forwarded even when absent:
      // `pickFrom` in the service is the one place a name off the list — or a
      // non-string, which this Partial type cannot actually rule out — becomes
      // undefined, and undefined is what makes the flag disappear.
      model: body.model,
      effort: body.effort,
      remoteControl: body.remoteControl === true
    });
  }

  /**
   * The board's "drain the whole queue" control: one project, no item, and
   * no caller-supplied prompt at all — see AgentsService's ORCHESTRATE_PROMPT
   * for why that field is never read off `body` in the first place, which is
   * the whole mechanism by which it gets dropped rather than forwarded.
   *
   * Guarded for the same reason `dispatch` is: this starts something (a
   * whole run of headless sessions across a project's backlog), so a
   * cross-origin page must not be able to drive it either. See
   * `origin.guard.ts`.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('orchestrate')
  orchestrate(@Body() body: Partial<AgentOrchestrateRequest> | undefined): Promise<AgentDispatchResult> {
    const project = typeof body?.project === 'string' ? body.project.trim() : '';
    if (project === '') throw new HttpException({ error: 'project is required' }, 400);
    return this.agents.orchestrate({
      project,
      // Unvalidated here for the same reason dispatch leaves these alone:
      // pickFrom (in the service) is the one place a name off the list — or
      // a non-string, which this Partial type cannot actually rule out —
      // becomes undefined, and undefined is what makes the flag disappear.
      // `?.`, not `.`, on all three: unlike `action` in dispatch, nothing
      // here narrows `body` itself past the `project` check above.
      model: body?.model,
      effort: body?.effort,
      // Unvalidated on purpose: clampMode is the place a junk or absent mode
      // becomes the ladder's floor, applied server-side once the ceiling is
      // known.
      permissionMode: body?.permissionMode,
      // Also unvalidated here, and the most important one to leave alone:
      // `resolveIds` (in the service) is the single place this becomes a
      // list of strings, because it is the only place that can also check
      // each entry against the project's own files. A shape check here would
      // be a second, weaker copy of half that rule. Rebuilt field by field
      // like every other key so that a new field reaches the service only
      // when it is added here too — the same discipline dispatch's own
      // rebuild keeps.
      ids: body?.ids
    });
  }
}
