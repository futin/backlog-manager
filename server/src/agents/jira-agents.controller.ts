import { Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { isJiraKey, parseJiraAction } from '../../../shared/types';
import type { JiraDispatchRequest, JiraDispatchResult } from '../../../shared/types';
import { parseBranchChoice } from '../jira/branch-choice.util';
import { JIRA_TRANSITION_ID_MAX_CHARS } from '../jira/config.util';
import { JiraDispatchService } from './jira-dispatch.service';
import { SameOriginPostGuard } from './origin.guard';

/**
 * A session id as this route accepts it. The repo has no validator of its own for a dashboard session id (they are minted by the dashboard and compared, never
 * parsed here), and a UUID-only check would refuse the short ids the suites seed, so this is the shape that makes the id safe to compare, name in a sentence and
 * put into the dashboard's stop URL: 1–128 characters of `[A-Za-z0-9._-]` whose FIRST is alphanumeric, so `.` and `..` can never become a path segment there
 * (`encodeURIComponent` leaves dots alone) and no separator gets in. Whether the id is LIVE on the key is the service's 409, not this check's. Exported for the
 * link route a later task adds, which takes the same id.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * The Jira phase-5 agents routes — `POST /api/agents/dispatch-jira` and `POST /api/agents/jira-stop` (spec §5, §7). Its own controller under the same `api/agents` prefix rather than more
 * methods on `AgentsController`, which is already the item dispatcher's, the orchestrator's and the watchdog's: the Jira routes share none of those
 * services, and a fourth constructor dependency there would put a Jira import into every one of them.
 *
 * `SameOriginPostGuard` like every agents POST — this one starts a session that can write files in a mapped repository and writes to Jira on the way, so a
 * page the developer did not write must not be able to drive it (`origin.guard.ts`). Both routes belong in `test/agents-origin-guard.test.ts`'s list.
 */
@Controller('api/agents')
export class JiraAgentsController {
  constructor(private readonly dispatcher: JiraDispatchService) {}

  /**
   * The body's SHAPE, field by field, before anything about the environment (a malformed request is wrong whatever the environment, so it must not read as
   * an environment problem); everything that needs a file, Jira or the dashboard is the service's. The controller rebuilds the request rather than passing
   * the body on, so a field this route does not know never reaches the service. `permissionMode`, `model` and `effort` are forwarded unvalidated for
   * `dispatch`'s reasons: `clampMode` and `pickFrom` are where a junk value becomes a safe one, never a refusal. 200, not Nest's default 201 for a POST:
   * what this answers is a session that started elsewhere, not a resource this server now holds.
   *
   * The branch choice (`mode`, `branch`, `base`, `openMr`, `target`) is read by `parseBranchChoice`, which `GET /api/jira/prompt` calls too, so a preview and a
   * Start refuse a choice in the same sentence. The service takes the PARSED choice as `choice` and reads none of the wire's flat fields: `mode` is set from
   * the parsed value only because the request type says it is required.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('dispatch-jira')
  @HttpCode(200)
  dispatchJira(@Body() raw: unknown): Promise<JiraDispatchResult> {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const key = body.key;
    if (!isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    const action = parseJiraAction(body.action);
    if (action === null) throw new HttpException({ error: 'action must be execute, context or { skill: <id> }' }, 400);
    const repo = body.repo;
    if (typeof repo !== 'string' || repo.trim() === '') throw new HttpException({ error: 'repo is required' }, 400);
    if (typeof body.assign !== 'boolean') throw new HttpException({ error: 'assign must be true or false' }, 400);
    // `null` is "leave as is". A string is checked as the transition route checks it (non-empty, at most 64): which ids are real is the fresh read's call.
    const transitionId = body.transitionId;
    if (transitionId !== null && (typeof transitionId !== 'string' || transitionId === '' || transitionId.length > JIRA_TRANSITION_ID_MAX_CHARS)) {
      throw new HttpException({ error: 'transitionId must be null or a non-empty string' }, 400);
    }
    // The branch choice is shape too (spec §5.3): `/prompt` refuses it in the same words, before it looks at the environment.
    const choice = parseBranchChoice(body, key, action);
    if (!choice.ok) throw new HttpException({ error: choice.error }, 400);
    // Refused rather than dropped, item dispatch's reasoning in the same words: a headless launch the person believed was opening in the desktop app is
    // worse than a 400. Any action may open there — a Jira Run is one session in one mapped repo on this machine, which is all the hand-over needs.
    const surface = body.surface;
    if (surface !== undefined && surface !== 'dashboard' && surface !== 'desktop') {
      throw new HttpException({ error: 'surface must be dashboard or desktop' }, 400);
    }
    return this.dispatcher.dispatch({
      key,
      repo,
      action,
      assign: body.assign,
      transitionId,
      mode: choice.value.mode,
      choice: choice.value,
      permissionMode: body.permissionMode as JiraDispatchRequest['permissionMode'],
      model: body.model as string | undefined,
      effort: body.effort as string | undefined,
      remoteControl: body.remoteControl === true,
      ...(surface === undefined ? {} : { surface })
    });
  }

  /**
   * `POST /api/agents/jira-stop` `{ key, sessionId }` — Stop, naming ONE session: a ticket can hold several live ones (a Run and a detected branch session), so
   * a bare `{ key }` no longer says which to stop and is a 400. The two fields' shapes are the only thing checked here, the key with the same sentence
   * `dispatch-jira` uses; whether the session is live on the key, and whether agents are on, are the service's. 200 for the same reason `dispatch-jira`
   * answers 200: what this reports is something that happened on the dashboard, not a resource this server created.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('jira-stop')
  @HttpCode(200)
  jiraStop(@Body() raw: unknown): Promise<{ ok: true }> {
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (!isJiraKey(body.key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    if (!isSessionId(body.sessionId)) throw new HttpException({ error: 'invalid session id' }, 400);
    return this.dispatcher.stop(body.key, body.sessionId);
  }
}
