import { homedir } from 'node:os';
import { HttpException, Injectable } from '@nestjs/common';

import { environmentBlock, projectDispatchGate } from '../../../shared/agent';
import { jiraSessionName } from '../../../shared/types';
import type { ItemDispatchResult, JiraDispatchRequest, JiraDispatchResult, JiraIssueDetail, JiraWorkspace, PermissionMode } from '../../../shared/types';
import { resolveWorkspace } from '../jira/branch-choice.util';
import type { JiraBranchChoice } from '../jira/branch-choice.util';
import { normaliseRepoPath, readJiraConfig } from '../jira/config.util';
import { jiraEnv, repoRoots } from '../jira/env.util';
import { JiraLiveService } from '../jira/live.service';
import { JiraPollerService } from '../jira/poller.service';
import type { JiraIssueWriteOutcome } from '../jira/poller.service';
import { composeJiraPrompt, resolveJiraActionOrThrow } from '../jira/prompt.util';
import type { JiraComposeAction } from '../jira/prompt.util';
import { readRepoRefs } from '../jira/refs.util';
import { jiraWriteOrThrow, unwrapJira } from '../jira/unwrap.util';
import { AgentsService } from './agents.service';
import { readAgentsConfig } from './config.util';
import { dashboardSessionRow } from './dashboard-sessions.util';
import { JiraLiveReconciler } from './jira-live.service';
import { stopDashboardSession } from './session-stop.util';

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
 *     `dispatch()`'s exact mapping. Then, from the same read, a `desktop` surface while the dashboard no longer says `desktopAvailable` — 409.
 *  3b. the branch choice against the repo's refs (spec §5.3), for every mode but `none`: a new branch whose name is already listed, or a continued one the
 *     mapped checkout holds, is a 409 — and so is the whole read, because it runs BEFORE the reservation: a refusal here has reserved nothing, assigned
 *     nothing, transitioned nothing and spawned nothing, and leaves the live map exactly as it found it. Refs the server cannot read (`available: false`) make
 *     no refusal; `jira.mjs worktree` re-checks both on the host. The resolved workspace is what both compositions carry, so the spawned prompt names the
 *     same worktree the preview did.
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
 *  8. `live.confirm`, `reconciler.arm()` and the answer — or, for a desktop answer with no id, `live.release` and a `session: null` answer.
 *
 * Every failure from step 5 on runs through one `catch` that releases the reservation, so no failure class can leave a key `starting` until the 8-hour expiry
 * — a retry after any of them is a fresh Start, never a 409. `release` only drops a STARTING entry, so the catch cannot take down a session that did start.
 */
@Injectable()
export class JiraDispatchService {
  constructor(
    private readonly agents: AgentsService,
    private readonly poller: JiraPollerService,
    private readonly live: JiraLiveService,
    private readonly reconciler: JiraLiveReconciler
  ) {}

  async dispatch(req: JiraDispatchRequest & { choice: JiraBranchChoice }): Promise<JiraDispatchResult> {
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
    // From the same read, item dispatch's check and sentence: home's dashboard stopped offering the desktop app since the sheet read the status. Before the
    // reservation and before any Jira write, because picking Dashboard is a retry the reader makes at once.
    if (req.surface === 'desktop' && status.desktopAvailable !== true) {
      throw new HttpException({ error: "the desktop app is not available on this machine's dashboard — launch on Dashboard instead" }, 409);
    }

    // `none` names no branch and so has nothing to compare: it makes no git read at all.
    const workspace = await this.workspaceFor(req, repo, config.repoDefaults[repo]?.base ?? null);

    if (!this.live.reserve(req.key, repo)) throw this.busy(req.key);
    try {
      return await this.launch(req, action, repo, workspace, status.spawnMaxPermission);
    } catch (err) {
      this.live.release(req.key);
      throw err;
    }
  }

  /**
   * Step 3b: the workspace the choice names in `repo`, or the 409 the refs make of it. The stored base is the repo's `repoDefaults` entry's, found by the
   * normalised path exactly as `GET /api/jira/refs` finds it — the refs' `defaultBase` is not read here, but the read must be the one the sheet's picker saw.
   */
  private async workspaceFor(req: JiraDispatchRequest & { choice: JiraBranchChoice }, repo: string, storedBase: string | null): Promise<JiraWorkspace | null> {
    if (req.choice.mode === 'none') return null;
    const resolved = resolveWorkspace(req.choice, req.key, repo, await readRepoRefs(repo, req.key, repoRoots(), storedBase));
    if (!resolved.ok) throw new HttpException({ error: resolved.error }, resolved.status);
    return resolved.workspace;
  }

  /** Steps 5–8, under the reservation `dispatch` holds and releases on any throw. */
  private async launch(
    req: JiraDispatchRequest,
    action: JiraComposeAction,
    repo: string,
    workspace: JiraWorkspace | null,
    maxPermission: PermissionMode | null
  ): Promise<JiraDispatchResult> {
    const me = this.poller.identity();
    if (req.assign && me === null) throw new HttpException({ error: 'no identity' }, 503);
    const detail = unwrapJira(await this.poller.issueDetail(req.key));
    const transition = req.transitionId === null ? null : detail.transitions.find((t) => t.id === req.transitionId);
    if (transition === undefined) throw new HttpException({ error: 'transition not offered' }, 400);
    const first = composeJiraPrompt(detail, action, repo, workspace);
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
    let spawned: ItemDispatchResult;
    try {
      // Nothing written, nothing changed by us: the first composition already holds the ticket as it is, and re-reading it would spend three more Jira
      // calls of the 429 budget to learn nothing.
      if (wrote) prompt = this.composeAfterWrites(unwrapJira(await this.poller.issueDetail(req.key)), action, repo, workspace);
      // `launchInProject`, not `spawnInProject`: only it carries a `surface`, and only it lets a desktop answer with no id through.
      spawned = await this.agents.launchInProject(repo, {
        prompt,
        name: jiraSessionName(req.key),
        permissionMode: req.permissionMode,
        maxPermission,
        model: req.model,
        effort: req.effort,
        remoteControl: req.remoteControl,
        surface: req.surface
      });
    } catch (err) {
      throw wrote ? withSuffix(err, WRITES_STAND) : err;
    }

    // A dashboard from before the desktop hand-over: the app took the launch and minted its own id, so there is no session to confirm, watch or stop.
    // Released, not left `starting`, or the key would refuse every Start until the 8-hour expiry. Today's dashboard answers an id and takes the path below.
    if (!('sessionId' in spawned)) {
      this.live.release(req.key);
      return { surface: 'desktop', assigned, transitioned: transition?.name ?? null, session: null };
    }

    // What the link keeps of this launch (spec §5). `name` is what `launchInProject` was given above; the snapshot is the ticket as the dispatch read it, so the
    // List can still draw it after it leaves the board (`parent` is Jira's own, not a board fold's). `surface` absent is a dashboard launch, byte for byte as the
    // spawn body treats it. The workspace's branch is the one a `new`/`continue` choice named, `null` for `none`.
    this.live.confirm(req.key, spawned.sessionId, {
      action: req.action,
      name: jiraSessionName(req.key),
      branch: workspace?.branch ?? null,
      surface: req.surface ?? 'dashboard',
      model: req.model ?? null,
      effort: req.effort ?? null,
      snapshot: { summary: detail.summary, type: detail.type.name, parentKey: detail.parent?.key ?? null }
    });
    // The map now holds a session the dashboard can end without telling us; the reconciler is what notices. Idempotent, and only a `setTimeout` — nothing here awaits it.
    this.reconciler.arm();
    return {
      sessionId: spawned.sessionId,
      assigned,
      transitioned: transition?.name ?? null,
      session: { name: jiraSessionName(req.key), startedAt: this.live.get(req.key)?.startedAt ?? new Date().toISOString(), repo }
    };
  }

  /**
   * `POST /api/agents/jira-stop` — Stop one named session of a ticket (spec §5; sessions §7.3). Stops it through the dashboard, then ends its link `stopped`,
   * which keeps it as history rather than deleting it. Jira is never called: the ticket keeps its assignee and its status, which is what the confirm in the
   * client says.
   *
   * The order is the spec's: agents off (409, `environmentBlock`'s own sentence — a disabled `status()` makes no request), then a `sessionId` that is not live on
   * this key: a `starting` entry (409 — it has no session id to stop, and its own Start will confirm or release it), a key with nothing live (409), or an id
   * that is another ticket's, unknown or already ended (409, naming its first 8 characters). Any live link can be named, `branch`
   * and `manual` included — the client offers Stop only for a session the dashboard can signal. Then the stop: a 200 and the dashboard's `no live session`
   * 404 both mean the process is gone, and both end the link; any other answer is a 502 from `stopDashboardSession` and the link STAYS, because the session
   * may still be running and a page that says otherwise would invite a second Start on a busy repository.
   */
  async stop(key: string, sessionId: string): Promise<{ ok: true }> {
    const cfg = readAgentsConfig();
    if (!cfg.enabled) {
      throw new HttpException({ error: environmentBlock(await this.agents.status()) ?? 'dispatch is off — set BM_AGENTS=on for the API' }, 409);
    }
    const onKey = this.live.liveLinks().filter((l) => l.key === key);
    if (!onKey.some((l) => l.sessionId === sessionId)) {
      // Not a live link of this key. A `starting` Run has no id to name, so it is told apart from a plain miss; and a key with nothing live at all is the
      // spec's older sentence, kept as it was.
      if (this.live.get(key)?.sessionId === null) throw new HttpException({ error: `${key} is still starting` }, 409);
      if (onKey.length === 0) throw new HttpException({ error: `no live session for ${key}` }, 409);
      throw new HttpException({ error: `${key} has no live session ${sessionId.slice(0, 8)}` }, 409);
    }
    await stopDashboardSession(cfg, sessionId, 'Jira is untouched');
    // `end` is a no-op for a pair that ended while the stop was in flight (the reconciler's own verdict, or a second Stop), so the first end stands — and a
    // fresh Start on the key, a different session, is never the pair this names.
    this.live.end(key, sessionId, 'stopped');
    return { ok: true };
  }

  /**
   * `POST /api/agents/jira-link` — `/jira link <KEY>`: link a session to a ticket by hand (spec §5). In the order the spec gives: agents off (409, `stop`'s own
   * sentence — the row read is a dashboard call), then the key is a real issue (`issueSummary`, one poller read; its status and sentence go through
   * `unwrapJira`, so a 404, a 429 and an unreachable Jira each read as they do on every other route), then the session is one the dashboard knows — its
   * `GET /api/sessions/:id/row` answering 404 is the ONLY refusal, never absence from the capped list, which proves nothing. The ticket is checked before the
   * session so a typo in the key costs no dashboard call.
   *
   * An explicit link is the person changing their mind, so it lifts a suppression an earlier unlink left BEFORE `addLink` (which would answer `suppressed`)
   * — and only here, after both checks passed, so a refused link leaves the suppression standing. The snapshot is the ticket as Jira reports it now; `surface`
   * is the row's `dashboard` or null, as detection does (the row's `local`/`cloud` are not this repo's launch surfaces). The row carries no `repo` mapping, so
   * `repo` is its launch folder, `''` when the dashboard sent none.
   */
  async link(key: string, sessionId: string): Promise<{ ok: true; linked: 'added' | 'exists' }> {
    const cfg = readAgentsConfig();
    if (!cfg.enabled) {
      throw new HttpException({ error: environmentBlock(await this.agents.status()) ?? 'dispatch is off — set BM_AGENTS=on for the API' }, 409);
    }
    const issue = unwrapJira(await this.poller.issueSummary(key));
    const row = await dashboardSessionRow(cfg, sessionId);
    if (row === null) throw new HttpException({ error: `the dashboard does not know session ${sessionId.slice(0, 8)}` }, 409);
    this.live.unsuppress(key, sessionId);
    const linked = this.live.addLink({
      key,
      sessionId,
      how: 'manual',
      action: null,
      name: row.sessionName ?? row.gitBranch ?? `session ${sessionId.slice(0, 8)}`,
      repo: row.projectPath ?? '',
      branch: row.gitBranch ?? null,
      surface: row.surface === 'dashboard' ? 'dashboard' : null,
      model: row.model ?? null,
      effort: row.effort ?? null,
      snapshot: { summary: issue.summary, type: issue.type.name, parentKey: issue.parent?.key ?? null },
      startedAt: new Date().toISOString()
    });
    // `unsuppress` ran first, so the store cannot answer `suppressed`; the type still says it could, and a link that was not made must not read as one that was.
    if (linked === 'suppressed') throw new HttpException({ error: `${key} could not be linked to session ${sessionId.slice(0, 8)}` }, 409);
    this.reconciler.arm();
    return { ok: true, linked };
  }

  /**
   * `POST /api/agents/jira-unlink` — `/jira unlink <KEY>` (spec C9): removes a `branch` or `manual` link and remembers the pair so detection never re-adds it.
   * No dashboard call, so it works with dispatch off. A `run` link refuses (409): dropping it would free the one-run gate under a live Run session, and
   * only Stop ends one. `missing` is a pair the store does not hold, 404.
   */
  unlink(key: string, sessionId: string): { ok: true } {
    const id8 = sessionId.slice(0, 8);
    switch (this.live.unlink(key, sessionId)) {
      case 'run':
        throw new HttpException({ error: `${key} was started by Run ▾ — stop it from the board instead` }, 409);
      case 'missing':
        throw new HttpException({ error: `${key} is not linked to session ${id8}` }, 404);
      default:
        return { ok: true };
    }
  }

  /** The second composition, from the re-read detail. Only reached after a write, so its refusal is the caller's to suffix; the sentence is the first's. */
  private composeAfterWrites(detail: JiraIssueDetail, action: JiraComposeAction, repo: string, workspace: JiraWorkspace | null): string {
    const composed = composeJiraPrompt(detail, action, repo, workspace);
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
