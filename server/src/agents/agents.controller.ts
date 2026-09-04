import { Body, Controller, Get, HttpException, Post, Query, UseGuards } from '@nestjs/common';

import { AgentsService, type AgentOrchestrateRequest } from './agents.service';
import type { MergeCheckResult } from './merge-check.util';
import { SameOriginPostGuard } from './origin.guard';
import { isAgentAction } from '../../../shared/agent';
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
    // `isAgentAction` (shared/agent.ts), not a hand-written comparison chain:
    // this check is a restatement of the `AgentAction` vocabulary, and the
    // hand-written version was the copy that would have gone stale the moment
    // a third action landed. Still only a SHAPE check — which of the three
    // this item may actually have is the service's business, decided by
    // re-deriving from the file and 409ing on disagreement.
    if (!isAgentAction(body?.action)) {
      throw new HttpException({ error: 'action must be groom, execute or capture' }, 400);
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
      // Unvalidated here too, for the same reason as every field above:
      // `resolveMergeMode` (in the service) is the one place a value is
      // judged, and a shape check in this controller would be a second,
      // weaker copy of it — the service alone can tell "absent" (defaults
      // to 'merge') apart from "present and wrong" (a 400), which is the
      // one distinction that makes this field's validation differ from
      // every neighbour's drop-on-unknown rule. See that method's own
      // comment for why the distinction matters here specifically: merging
      // to `main` is the irreversible direction, so a caller bug must not
      // be able to select it by having an unrecognised value silently
      // resolve to the default.
      mergeMode: body?.mergeMode,
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

  /**
   * The strip's manual "Resume" button, and the sweeper's own recovery call
   * (a later task) once it exists — both funnel through
   * `AgentsService.resume()`, which is where the two are actually told
   * apart (`origin: 'board'` here, `origin: 'watchdog'` there; see that
   * method's own doc comment). This route only ever sends `'board'`: it is
   * reached by a click, and there is no way for an HTTP caller to claim to
   * be the sweeper instead.
   *
   * One field, rebuilt like every other route here: `project` is trimmed
   * and required, and nothing else in the body is ever read — the same
   * posture `orchestrate` takes toward a caller-supplied `prompt` (there,
   * a field exists and is dropped by never being read; here, there is no
   * field for a caller-supplied prompt to occupy in the first place, since
   * `AgentsService.RESUME_PROMPT` is a compile-time constant). See that
   * constant's own comment for why this is a narrower surface than
   * `orchestrate`'s, not merely an equally-guarded one.
   *
   * Guarded for the same reason `dispatch`/`orchestrate` are: this starts a
   * headless session, so a cross-origin page must not be able to drive it
   * either. See `origin.guard.ts`.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('resume')
  resume(@Body() body: { project?: unknown } | undefined): Promise<AgentDispatchResult> {
    const project = typeof body?.project === 'string' ? body.project.trim() : '';
    if (project === '') throw new HttpException({ error: 'project is required' }, 400);
    return this.agents.resume(project, 'board');
  }

  /**
   * GET, not POST-with-a-path like `plan`'s `itemPath`. `plan`'s argument is
   * an arbitrary absolute file path the client has no other reason to put
   * anywhere visible, so POST keeps it out of access logs and browser
   * history (see that handler's own comment). This one's `project` is
   * always a path the client already pulled out of the registry via
   * `/api/projects` to build the board in the first place — putting it in a
   * query string discloses nothing an access log couldn't already read off
   * that earlier response, the same reasoning
   * `OrchestratorController.archivedRun`'s own `project` query param gives
   * for itself. A GET is also the more honest verb for what this call
   * actually is: read-only, side-effect-free, and safe to fire every time
   * the sheet's merge-mode toggle is flipped, which is exactly the cadence
   * Task 8's sheet needs it at.
   *
   * No guard, unlike `plan`/`dispatch`/`orchestrate`: `SameOriginPostGuard`
   * answers "may this caller POST at all" for routes that start something
   * or read an arbitrary file — this route does neither. It reads exactly
   * one registered project's own settings and starts nothing, so there is
   * nothing here for a cross-origin page to abuse beyond what `/api/projects`
   * already discloses to any same-origin reader anyway.
   */
  @Get('merge-check')
  mergeCheck(@Query('project') project: string | undefined): MergeCheckResult {
    const trimmed = typeof project === 'string' ? project.trim() : '';
    if (trimmed === '') throw new HttpException({ error: 'project is required' }, 400);
    return this.agents.mergeCheck(trimmed);
  }
}
