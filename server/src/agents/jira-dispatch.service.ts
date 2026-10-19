import { homedir } from 'node:os';
import { HttpException, Injectable } from '@nestjs/common';

import { projectDispatchGate } from '../../../shared/agent';
import { jiraSessionName } from '../../../shared/types';
import type { JiraDispatchRequest, JiraDispatchResult, JiraIssueDetail, PermissionMode } from '../../../shared/types';
import { normaliseRepoPath, readJiraConfig } from '../jira/config.util';
import { jiraEnv } from '../jira/env.util';
import { JiraLiveService } from '../jira/live.service';
import { JiraPollerService } from '../jira/poller.service';
import type { JiraIssueWriteOutcome } from '../jira/poller.service';
import { composeJiraPrompt, resolveJiraActionOrThrow } from '../jira/prompt.util';
import type { JiraComposeAction } from '../jira/prompt.util';
import { jiraWriteOrThrow, unwrapJira } from '../jira/unwrap.util';
import { AgentsService } from './agents.service';

/** What a failure after a landed write says, appended to its own sentence: the write is not undone (spec §7), and the reader must not retry as if it were. */
const ASSIGN_STANDS = ' — the assign stands';
const WRITES_STAND = ' — the Jira writes stand';

/**
 * `POST /api/agents/dispatch-jira` — the launch sheet's Start (Jira phase 5; spec §5, §7, §8). Optional assign, optional transition, then ONE dashboard spawn
 * with the composed prompt, in the chosen repository, under the session name `jira <KEY>`.
 *
 * It lives in `agents/`, not `jira/`, because it calls the dashboard, and `agents/` is the module that does (`jira/` imports nothing from here; the edge runs
 * agents → jira and never back — `jira.module.ts` says why). Everything Jira-shaped it needs comes from `jira/`'s own exports: the config reader and the path
 * normaliser, the poller's fresh read and its two writes, the composer, the live map. It composes no Jira call and no prompt of its own.
 *
 * The order is the contract, and it is spec §7's "checked whole before the first write":
 *
 *  1. (the controller) the body's shape — 400.
 *  2. configured (503), `jira.json` readable (409), the skill exists (400), the repo mapped to the key's project (400). The project is the key's prefix, so
 *     no Jira read is needed to refuse an unmapped repo — `GET /api/jira/prompt` keys the same check off the detail it reads anyway; the two agree for every
 *     key Jira has not moved between projects. Same sentences as that route, so a preview and a Start refuse a request in the same words.
 *  3. the dashboard gate, `projectDispatchGate(status, repo)` — 409 with its reason, or 502 when dispatch is on and the dashboard is unreachable, which is
 *     `dispatch()`'s exact mapping.
 *  4. `live.reserve` — the one-session-per-ticket gate, synchronous, so of two Starts that both cleared step 3 exactly one passes it. A refusal here reserved
 *     nothing and so releases nothing: releasing would drop the OTHER request's starting entry.
 *  5. after the reservation, still before any write: `no identity` (503) when an assign is asked and the poller has no `me`; a fresh detail read (§8's mapping);
 *     the transition offered by that read (400 `transition not offered` — the sheet's list can be minutes old); the first composition fits (400
 *     `prompt too long`). Refusing these before the assign is what makes "an assign that landed" only ever mean one the request needed.
 *  6. assign → transition, each through `jiraWriteOrThrow` (the two write routes' own mapping), its sentence prefixed with the step and — after a landed
 *     assign — suffixed with ASSIGN_STANDS. An assign the ticket already carries is skipped (`assigned: false`): sending it would be a write that changes
 *     nothing and still bumps `updated`.
 *  7. the spawn, with the prompt composed AFTER the writes, so the session reads the status and assignee the ticket now has. Any failure from here — the
 *     re-read, the re-composition, the spawn — keeps its status and gains WRITES_STAND when a write landed.
 *  8. `live.confirm` and the answer.
 *
 * Every failure from step 5 on runs through one `catch` that releases the reservation, so no failure class can leave a key `starting` until the 8-hour expiry
 * — a retry after any of them is a fresh Start, never a 409. `release` only drops a STARTING entry, so the catch cannot take down a session that did start.
 */
@Injectable()
export class JiraDispatchService {
  constructor(
    private readonly agents: AgentsService,
    private readonly poller: JiraPollerService,
    private readonly live: JiraLiveService
  ) {}

  async dispatch(req: JiraDispatchRequest): Promise<JiraDispatchResult> {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
    const config = readJiraConfig();
    if (config.unreadable !== null) {
      throw new HttpException({ error: `settings/jira.json ${config.unreadable} — fix or delete it by hand` }, 409);
    }
    const action = resolveJiraActionOrThrow(req.action, config.skills);
    // A project key holds no `-` (`JIRA_PROJECT_KEY_RE`), so the first one ends it.
    const project = req.key.slice(0, req.key.indexOf('-'));
    // Normalised exactly as `/prompt` does it and as `parseReposWrite` stored it: the mapping is compared, the gate asked and the session spawned in this one
    // spelling, which is also the `{repo}` the prompt carries — so the preview and the spawned prompt are the same text but for the nonce.
    const repo = normaliseRepoPath(req.repo, homedir());
    if (repo === null || !(config.repos[project] ?? []).includes(repo)) {
      throw new HttpException({ error: `${req.repo} is not mapped to ${project}` }, 400);
    }

    const status = await this.agents.status();
    const gate = projectDispatchGate(status, repo);
    if (gate.control !== 'enabled') {
      throw new HttpException({ error: gate.reason }, status.enabled && !status.reachable ? 502 : 409);
    }

    if (!this.live.reserve(req.key, repo)) throw this.busy(req.key);
    try {
      return await this.launch(req, action, repo, status.spawnMaxPermission);
    } catch (err) {
      this.live.release(req.key);
      throw err;
    }
  }

  /** Steps 5–8, under the reservation `dispatch` holds and releases on any throw. */
  private async launch(
    req: JiraDispatchRequest,
    action: JiraComposeAction,
    repo: string,
    maxPermission: PermissionMode | null
  ): Promise<JiraDispatchResult> {
    const me = this.poller.identity();
    if (req.assign && me === null) throw new HttpException({ error: 'no identity' }, 503);
    const detail = unwrapJira(await this.poller.issueDetail(req.key));
    const transition = req.transitionId === null ? null : detail.transitions.find((t) => t.id === req.transitionId);
    if (transition === undefined) throw new HttpException({ error: 'transition not offered' }, 400);
    const first = composeJiraPrompt(detail, action, repo);
    if (!first.ok) throw new HttpException({ error: first.error }, 400);

    let assigned = false;
    if (req.assign && detail.assignee?.accountId !== me?.accountId) {
      this.written('assign: ', await this.poller.assignToMe(req.key), '');
      assigned = true;
    }
    if (transition !== null) {
      this.written('transition: ', await this.poller.transitionIssue(req.key, transition.id), assigned ? ASSIGN_STANDS : '');
    }
    const wrote = assigned || transition !== null;

    let prompt = first.prompt;
    let spawned: { sessionId: string };
    try {
      // Nothing written, nothing changed by us: the first composition already holds the ticket as it is, and re-reading it would spend three more Jira
      // calls of the 429 budget to learn nothing.
      if (wrote) prompt = this.composeAfterWrites(unwrapJira(await this.poller.issueDetail(req.key)), action, repo);
      spawned = await this.agents.spawnInProject(repo, {
        prompt,
        name: jiraSessionName(req.key),
        permissionMode: req.permissionMode,
        maxPermission,
        model: req.model,
        effort: req.effort,
        remoteControl: req.remoteControl
      });
    } catch (err) {
      throw wrote ? withSuffix(err, WRITES_STAND) : err;
    }

    this.live.confirm(req.key, spawned.sessionId);
    return {
      sessionId: spawned.sessionId,
      assigned,
      transitioned: transition?.name ?? null,
      session: { name: jiraSessionName(req.key), startedAt: this.live.get(req.key)?.startedAt ?? new Date().toISOString(), repo }
    };
  }

  /** The second composition, from the re-read detail. Only reached after a write, so its refusal is the caller's to suffix; the sentence is the first's. */
  private composeAfterWrites(detail: JiraIssueDetail, action: JiraComposeAction, repo: string): string {
    const composed = composeJiraPrompt(detail, action, repo);
    if (!composed.ok) throw new HttpException({ error: composed.error }, 400);
    return composed.prompt;
  }

  /** One write's outcome, or its error named for the step (`assign: ` / `transition: `) with `suffix` after the sentence; status and other fields kept. */
  private written(prefix: string, outcome: JiraIssueWriteOutcome, suffix: string): void {
    try {
      jiraWriteOrThrow(outcome);
    } catch (err) {
      throw reworded(err, (sentence) => `${prefix}${sentence}${suffix}`);
    }
  }

  /**
   * The 409 for a key `reserve` refused, worded from what the map holds. `reserve` says only "no"; the entry says why — a reservation still waiting on the
   * dashboard, a session that started, or (no entry at all) a map whose every slot is a starting entry, which `reserve` will not evict.
   */
  private busy(key: string): HttpException {
    const entry = this.live.get(key);
    if (entry === null) return new HttpException({ error: 'too many Jira sessions are starting — try again in a moment' }, 409);
    return new HttpException({ error: entry.sessionId === null ? `${key} is starting` : `${key} already has a session` }, 409);
  }
}

/** `err` with `suffix` after its sentence, when it is an `HttpException` carrying one; anything else (an I/O throw, Nest's 500) passes through untouched. */
function withSuffix(err: unknown, suffix: string): unknown {
  return reworded(err, (sentence) => `${sentence}${suffix}`);
}

/** A copy of an `{ error }` `HttpException` with its sentence rewritten and every other field (`retryAt`, `access`) and the status kept. */
function reworded(err: unknown, rewrite: (sentence: string) => string): unknown {
  if (!(err instanceof HttpException)) return err;
  const body = err.getResponse();
  if (typeof body !== 'object' || body === null || typeof (body as { error?: unknown }).error !== 'string') return err;
  const record = body as Record<string, unknown> & { error: string };
  return new HttpException({ ...record, error: rewrite(record.error) }, err.getStatus());
}
