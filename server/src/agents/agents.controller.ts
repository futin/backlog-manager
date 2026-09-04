import { Body, Controller, Get, HttpCode, HttpException, Post, Query, UseGuards } from '@nestjs/common';

import { AgentsService, type AgentOrchestrateRequest } from './agents.service';
import type { MergeCheckResult } from './merge-check.util';
import { SameOriginPostGuard } from './origin.guard';
import { WatchdogService } from './watchdog.service';
import { writeWatchdogConfig } from '../orchestrator/watchdog-config.util';
import { isAgentAction } from '../../../shared/agent';
import type {
  AgentDispatchRequest, AgentDispatchResult, AgentPlan, AgentsStatus, WatchdogConfig, WatchdogStatus
} from '../../../shared/types';

/**
 * Under /api like every other controller — test/vite-proxy.test.ts asserts it
 * from Nest's own route metadata, because a route outside /api would not 404
 * in dev, it would be answered by Vite's SPA fallback with index.html.
 */
@Controller('api/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService, private readonly watchdog: WatchdogService) {}

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
   *
   * RULING R3 / orchestrator-watchdog design §2.1's third arming trigger: a
   * successful spawn here starts (or restarts) a run this server may never
   * have read a `run.json` for before — the sweeper's other two triggers
   * (the bootstrap scan, and every `GET /api/orchestrator/runs` whose
   * payload already contains a `running` run) both depend on something
   * having already NOTICED the run exists, and on this exact request
   * nothing has yet: the board's own runs poll is up to 5s away. `arm()` is
   * called here, in the controller, rather than inside
   * `AgentsService.orchestrate()` — `WatchdogService` already injects
   * `AgentsService` (to call `resume()`, design §3), so the reverse edge
   * would be a dependency cycle Nest cannot construct. It is deliberately
   * NOT awaited beyond this synchronous call and no `tick()` is kicked
   * alongside it (contrast `watchdogConfig` below, RULING R2): `arm()`
   * either starts the chain or confirms one already exists, and a run that
   * was just (re)started is fresh, not crashed, so there is no urgency for
   * the sweeper to look at it sooner than its own next scheduled tick —
   * unlike RULING R2's case, where the run is ALREADY crashed and every
   * tick that passes without acting on it is a tick a person is left
   * waiting.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('orchestrate')
  async orchestrate(@Body() body: Partial<AgentOrchestrateRequest> | undefined): Promise<AgentDispatchResult> {
    const project = typeof body?.project === 'string' ? body.project.trim() : '';
    if (project === '') throw new HttpException({ error: 'project is required' }, 400);
    const result = await this.agents.orchestrate({
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
    // See this method's own doc comment above (RULING R3) for why this
    // call lives here rather than inside AgentsService, and why it is
    // fire-and-forget with no accompanying tick().
    this.watchdog.arm();
    return result;
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
   *
   * RULING R3 — the identical reasoning `orchestrate()` above carries in
   * full: a successful resume here is the sweeper's third arming trigger
   * (design §2.1), wired here rather than in `AgentsService` to avoid the
   * `AgentsService` ⇄ `WatchdogService` cycle that injecting `WatchdogService`
   * into the service would create, fire-and-forget with no accompanying
   * `tick()` because the run this just resumed is fresh again, not crashed.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('resume')
  async resume(@Body() body: { project?: unknown } | undefined): Promise<AgentDispatchResult> {
    const project = typeof body?.project === 'string' ? body.project.trim() : '';
    if (project === '') throw new HttpException({ error: 'project is required' }, 400);
    const result = await this.agents.resume(project, 'board');
    this.watchdog.arm();
    return result;
  }

  /**
   * `GET /api/agents/watchdog` (orchestrator-watchdog design §4.2) — the
   * sweeper's whole state in one call: phase/reason, `nextTickAt`, the
   * effective (post-clamp) config, which runIds it is currently watching,
   * and its own event history. Read-only and UNGUARDED, exactly like
   * `status` above and for the identical reason: it starts nothing and
   * reads only in-memory state plus one small settings file this process
   * itself owns (`WatchdogService.status()` reads `readWatchdogConfig()`
   * fresh on every call, so a Settings save is visible immediately rather
   * than at the next tick). The Settings group's State row, its four config
   * controls, and its Activity feed all redraw from this one response
   * rather than needing four.
   */
  @Get('watchdog')
  watchdogStatus(): WatchdogStatus {
    return this.watchdog.status();
  }

  /**
   * `POST /api/agents/watchdog/config` (design §5.3) — the Settings group's
   * one write path onto `settings/watchdog.json`, which
   * `writeWatchdogConfig` (`orchestrator/watchdog-config.util.ts`, Task 1)
   * owns exclusively: this handler never touches the file directly, and
   * never re-implements the clamp — `writeWatchdogConfig` already merges
   * the patch over the file's CURRENT contents, clamps every field to
   * `WATCHDOG_LIMITS`, and writes atomically. `@HttpCode(200)` overrides
   * Nest's POST default of 201: this route redraws an existing setting
   * rather than creating a resource, the same distinction a PUT would carry
   * if this app used one.
   *
   * The body is `Partial<WatchdogConfig>`, but arrives as `unknown` — a
   * caller cannot be trusted to have sent the right shape merely because
   * the type annotation says so. A body that is not a plain, non-null,
   * non-array object is refused outright with 400 `{ error: 'bad body' }`
   * rather than silently coerced into "no fields": `writeWatchdogConfig`'s
   * own `patch` parameter already tolerates a non-object by treating it as
   * `{}` (so a hand-rolled call from a future caller degrades safely), but
   * accepting that leniency HERE, at the one HTTP entry point a browser can
   * reach, would mean a malformed request (a bug in a future client, or a
   * probe) silently succeeds with no config change and no error — the
   * caller would have no way to learn its request never took effect. See
   * this route's own test suite (`test/watchdog-routes.test.ts`) for why an
   * HTTP-level test cannot actually observe this branch for a bare string
   * or `null` body: Express's own strict-mode JSON parser rejects those
   * before Nest's routing ever sees them, with a different error shape —
   * this guard is still pinned directly at the controller-method level.
   *
   * Once past that guard, the four known fields are rebuilt field by field
   * — `{ enabled, tickMs, graceMs, maxAttempts }` — the same "rebuild,
   * never spread" discipline `dispatch`/`orchestrate` already follow above.
   * An UNKNOWN key (`{ unknownKey: 1 }`) is DROPPED, not rejected, matching
   * exactly how an unrecognised `model`/`effort` is handled elsewhere in
   * this controller: a client sending a field this server does not yet
   * understand (an older client talking to a newer server's removed field,
   * or a newer client talking to an older server that has not learned a
   * field yet) must not have its WHOLE request refused over one field
   * neither side needs to agree on. Each of the four fields is copied onto
   * the patch object ONLY when the incoming value is not `undefined` —
   * "undefined stays out", not "included as an explicit `undefined`
   * property" — because `writeWatchdogConfig`'s own merge logic tests
   * presence with `'field' in patch`, not `patch.field !== undefined`: an
   * object literal with an explicit `{ enabled: undefined }` key would read
   * as "the caller specified enabled" to that check, and get merged in as
   * `undefined`, which `clampWatchdogConfig` would then treat as "wrong
   * type, use the DEFAULT" — silently resetting a field the caller never
   * mentioned back to its default, rather than leaving the file's current
   * value alone. Every other field's own type is left unvalidated here on
   * purpose — the same posture `orchestrate`'s `model`/`effort`/`mergeMode`
   * fields already take toward this controller — because clamping is
   * `writeWatchdogConfig`'s job alone (Task 1's own tests already cover
   * every clamp case), and re-clamping here would be a second copy of that
   * logic with its own chance to drift from `WATCHDOG_LIMITS`.
   *
   * `arm()` is called after every save, REGARDLESS of which field changed
   * or what it changed to — including a save that flips `enabled` from
   * `true` to `false`. This is deliberate, not merely harmless: `arm()`
   * only ever WATCHES more eagerly (it starts a chain if none exists; it is
   * a no-op if one already does), so calling it after a save that turns
   * watching OFF costs nothing and calling it after a save that turns
   * watching ON is the one case that actually matters. That case is exactly
   * why this line exists at all: the design's own worked example is an
   * operator toggling `enabled` from false to true while a run is ALREADY
   * sitting crashed. `arm()` alone is not enough to make that toggle act
   * immediately — its own doc comment states plainly that it is a no-op
   * while a timer already exists, which is precisely the state a watchdog
   * that has been watching a crashed-but-disabled run is already in. Without
   * an explicit kick, that flip would sit inert until the ALREADY-SCHEDULED
   * next tick fires — up to a full `tickMs` (a minute, by default) after a
   * person who just turned the feature on would reasonably expect it to
   * have acted. So `arm()` runs first (to start a chain from cold — the
   * fresh-install, nothing-has-ever-run case), and a bare `tick()` runs
   * right after it, UNAWAITED: `tick()`'s own in-flight guard (it returns
   * the ALREADY-RUNNING sweep's promise rather than starting a second one)
   * is what makes firing it unconditionally, even when `arm()` just started
   * an identical one itself, safe rather than a double-sweep. It is not
   * awaited here because this route's job is to persist the setting and
   * report the state that flows from it — `watchdog.status()` below already
   * reflects the ARMED phase synchronously, since `arm()`'s own phase
   * transition happens before this line runs, and reads fresh CONFIG from
   * disk on that call regardless of whether the kicked tick has finished —
   * making the caller wait for a live resume spawn (which can take seconds,
   * and depends on a THIRD process, the dashboard) would turn a settings
   * save into a request with the latency profile of a dispatch, for no
   * benefit the response body would show anyway.
   *
   * CLAUDE.md's "the two agents POSTs are guarded by content-type and
   * origin" line is now stale — `dispatch`/`orchestrate` were the only two
   * when it was written; `resume` made three, and this route makes four.
   * Left unedited here, on purpose: a later task in this plan rewrites that
   * line, and doing it piecemeal from inside an unrelated task's diff is
   * how a line like that drifts a second time.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('watchdog/config')
  @HttpCode(200)
  watchdogConfig(@Body() body: unknown): WatchdogStatus {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpException({ error: 'bad body' }, 400);
    }
    const b = body as Partial<Record<keyof WatchdogConfig, unknown>>;
    const patch: Partial<WatchdogConfig> = {};
    if (b.enabled !== undefined) patch.enabled = b.enabled as WatchdogConfig['enabled'];
    if (b.tickMs !== undefined) patch.tickMs = b.tickMs as WatchdogConfig['tickMs'];
    if (b.graceMs !== undefined) patch.graceMs = b.graceMs as WatchdogConfig['graceMs'];
    if (b.maxAttempts !== undefined) patch.maxAttempts = b.maxAttempts as WatchdogConfig['maxAttempts'];
    writeWatchdogConfig(patch);
    this.watchdog.arm();
    void this.watchdog.tick();
    return this.watchdog.status();
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
