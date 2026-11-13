import { homedir } from 'node:os';
import { HttpException, Injectable } from '@nestjs/common';

import { environmentBlock, projectDispatchGate } from '../../../shared/agent';
import { reviewHalf, reviewState } from '../../../shared/review';
import { jiraSessionName } from '../../../shared/types';
import type {
  GitlabMr,
  ItemDispatchResult,
  JiraDispatchRequest,
  JiraDispatchResult,
  JiraIssueDetail,
  JiraWorkspace,
  PermissionMode
} from '../../../shared/types';
import { GitlabPollerService } from '../gitlab/poller.service';
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
import { authHeaders, dashboardError, readAgentsConfig } from './config.util';
import { dashboardSessionRow } from './dashboard-sessions.util';
import { JiraLiveReconciler } from './jira-live.service';
import { stopDashboardSession } from './session-stop.util';
import { mainCheckoutOf } from './worktree-main.util';

/** What a failure after a landed write says, appended to its own sentence: the write is not undone (spec §7), and the reader must not retry as if it were. */
const ASSIGN_STANDS = ' — the assign stands';
const WRITES_STAND = ' — the Jira writes stand';

/** The hand-over opens a link and answers; `spawn`'s own budget is plenty. */
const OPEN_DESKTOP_TIMEOUT_MS = 10_000;

/**
 * A review dispatch's hold on its MR's source branch, from the branch gate to `confirm` (or the release). `token` is this dispatch's own object, so the
 * release compares identity rather than the key: a late `catch` can never drop an entry another dispatch now owns for the same repo and branch.
 */
interface BranchHold {
  key: string;
  token: object;
}

/** What a review carries from the cache checks into the launch: the cached MR (its keys are checked once the detail is read) and the branch it holds. */
interface ReviewLaunch {
  mr: GitlabMr;
  hold: BranchHold | null;
}

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
 *  3a. a REVIEW only (spec §5.5, §6), from the GitLab poller's cache and nothing else: the MR is cached and open (400), the repo is one of its candidates
 *     (`reposFor`, 400), the choice continues the MR's source branch (400), then the state 409s — no review state yet, nothing to review, too many threads,
 *     or a half that no longer matches what the sheet previewed. Before 3b so a review that names the wrong branch reads as the review's sentence, never as
 *     `resolveWorkspace`'s 409 about that wrong branch.
 *  3b. the branch choice against the repo's refs (spec §5.3), for every mode but `none`: a new branch whose name is already listed, or a continued one the
 *     mapped checkout holds, is a 409 — and so is the whole read, because it runs BEFORE the reservation: a refusal here has reserved nothing, assigned
 *     nothing, transitioned nothing and spawned nothing, and leaves the live map exactly as it found it. Refs the server cannot read (`available: false`) make
 *     no refusal; `jira.mjs worktree` re-checks both on the host. The resolved workspace is what the composition carries, so the spawned prompt names the
 *     same worktree the preview did.
 *  4. `live.reserve` — the one-session-per-ticket gate, synchronous, so of two Starts that both cleared step 3 exactly one passes it. A refusal here reserved
 *     nothing and so releases nothing: releasing would drop the OTHER request's starting entry.
 *  4b. a REVIEW only: the live-session branch gate (spec §5.2), synchronous too, then the branch hold. A refusal releases the key this request just took and
 *     touches no branch hold — the one it lost to is another dispatch's.
 *  5. after the reservation, still before any write: `no identity` (503) when an assign is asked and the poller has no `me`; a fresh detail read (§8's mapping);
 *     the transition offered by that read (400 `transition not offered` — the sheet's list can be minutes old); for a review, the MR's keys carry the key or
 *     its parent's (400 — only the detail knows the parent); the composition fits (400
 *     `prompt too long`) — or, for an edited `prompt`, no composition at all: the person's text is spawned as written. Refusing these before the assign is what makes "an assign that landed" only ever mean one the request needed.
 *  6. assign → transition, each through `jiraWriteOrThrow` (the two write routes' own mapping), its sentence prefixed with the step and — after a landed
 *     assign — suffixed with ASSIGN_STANDS. An assign the ticket already carries is skipped (`assigned: false`): sending it would be a write that changes
 *     nothing and still bumps `updated`.
 *  7. the spawn, with the prompt from step 5. The prompt carries no ticket text (`prompt.util.ts` says why), so the writes change nothing in it and nothing
 *     is recomposed after them. A spawn failure keeps its status and gains WRITES_STAND when a write landed.
 *  8. `live.confirm`, `reconciler.arm()` and the answer — or, for a desktop answer with no id, `live.release` and a `session: null` answer. A review's branch
 *     hold is dropped at either: the confirmed link's stored `branch` takes over the gate, and an id-less session is one nothing can see to gate on.
 *
 * Every failure from step 5 on runs through one `catch` that releases the reservation, so no failure class can leave a key `starting` until the 8-hour expiry
 * — a retry after any of them is a fresh Start, never a 409. `release` only drops a STARTING entry, so the catch cannot take down a session that did start.
 * The same `catch` drops a review's branch hold, by its token.
 */
@Injectable()
export class JiraDispatchService {
  constructor(
    private readonly agents: AgentsService,
    private readonly poller: JiraPollerService,
    private readonly live: JiraLiveService,
    private readonly reconciler: JiraLiveReconciler,
    private readonly gitlab: GitlabPollerService
  ) {}

  /**
   * Review dispatches between their branch gate and their `confirm`, keyed `<candidate repo>\0<branch>` (spec §5.2). Memory only and never written: like the
   * key's `starting` entry it covers the seconds a spawn takes, before any link holds the branch, and a restart has no spawn in flight to cover. The key
   * reservation cannot do this job — two sub-tasks of one story are two keys on ONE MR branch, and two sessions pushing one branch is the race the gate exists
   * to stop.
   */
  private readonly branchHolds = new Map<string, BranchHold>();

  async dispatch(req: JiraDispatchRequest & { choice: JiraBranchChoice }): Promise<JiraDispatchResult> {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
    const config = readJiraConfig();
    if (config.unreadable !== null) {
      throw new HttpException({ error: `settings/jira.json ${config.unreadable} — fix or delete it by hand` }, 409);
    }
    // A review's compose action is built below from the CACHED MR, never from the request's spelling; `resolveJiraActionOrThrow` refuses a bare review.
    const action: JiraComposeAction | null = req.action === 'review' ? null : resolveJiraActionOrThrow(req.action, config.skills);
    // A project key holds no `-` (`JIRA_PROJECT_KEY_RE`), so the first one ends it.
    const project = req.key.slice(0, req.key.indexOf('-'));
    // Normalised exactly as `/prompt` does it and as `parseReposWrite` stored it: the mapping is compared, the gate asked and the session spawned in this one
    // spelling, which is also the `{repo}` the prompt carries — so the preview and the spawned prompt are the same text.
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

    const review = req.action === 'review' ? this.reviewOrThrow(req, project, repo) : null;
    const composeAction: JiraComposeAction = review?.action ?? (action as JiraComposeAction);

    // `none` names no branch and so has nothing to compare: it makes no git read at all.
    const workspace = await this.workspaceFor(req, repo, config.repoDefaults[repo]?.base ?? null);

    // From here to the branch hold's insert there is no `await`: the key reservation, the branch gate's reads (the hold map, the live links, the kept rows,
    // `mainCheckoutOf`'s synchronous file read) and the insert run in one turn of the event loop, so of two reviews racing for one branch exactly one holds it.
    if (!this.live.reserve(req.key, repo)) throw this.busy(req.key);
    let hold: BranchHold | null = null;
    if (review !== null) {
      const branch = review.mr.sourceBranch;
      if (this.branchBusy(review.candidates, branch)) {
        this.live.release(req.key);
        throw new HttpException({ error: `a session is live on ${branch}` }, 409);
      }
      hold = { key: `${repo}\0${branch}`, token: {} };
      this.branchHolds.set(hold.key, hold);
    }
    try {
      return await this.launch(req, composeAction, repo, workspace, status.spawnMaxPermission, review === null ? null : { mr: review.mr, hold });
    } catch (err) {
      this.live.release(req.key);
      this.dropHold(hold);
      throw err;
    }
  }

  /**
   * Step 3a: a review's checks, all against the GitLab poller's cache and the request (spec §5.5, §6) — no GitLab call, so the dispatch sees exactly what the
   * board drew the button from. The 400s come before the 409s because a malformed pick is wrong whatever the review's state; within each group the order is
   * the spec's, and the first failure wins.
   *
   * - The MR: cached under the project path exactly as sent (`findMr` does not fold case) and `opened`. A merged or closed MR is "not an open merge request",
   *   the same sentence as one the cache never held — the reader's next move is the same.
   * - The repo: one of `reposFor(<Jira project>, <MR project>)`, the mapped checkouts whose origin is that GitLab project. A repo mapped to the Jira project
   *   but cloned from elsewhere is mapped (step 2 passed) and still not this MR's.
   * - The choice: `continue` on the MR's source branch, without `openMr` — a review fixes or asks about THAT branch, so a new branch, no worktree, or another
   *   branch would hand the session a tree the review is not about. The controller already refused `openMr` for a non-execute action; it is re-read here
   *   so this sentence alone is the whole rule.
   * - The state: `reviewState` over the cached review at `Date.now()`, then `reviewHalf` against the sent half. A half that no longer matches means the board
   *   moved on since the sheet was drawn (a round landed, or a push made it stale) and the previewed prompt is the wrong one.
   *
   * The compose action is built from the CACHED MR's project and iid — the same values the request named, since `findMr` matched them exactly, but read
   * from the one source the preview's `GET /api/jira/prompt` also checked.
   */
  private reviewOrThrow(
    req: JiraDispatchRequest & { choice: JiraBranchChoice },
    project: string,
    repo: string
  ): { mr: GitlabMr; candidates: string[]; action: JiraComposeAction } {
    const mrRef = req.mr;
    const half = req.half;
    // The controller rebuilds a review request with both; a caller that skipped it is the controller's 400, in its words.
    if (mrRef === undefined) throw new HttpException({ error: 'mr must be { project, iid }' }, 400);
    if (half === undefined) throw new HttpException({ error: 'half must be request or fix' }, 400);
    const mr = this.gitlab.findMr(mrRef.project, mrRef.iid);
    if (mr === null || mr.state !== 'opened') throw notOpen(mrRef.iid, req.key);
    const candidates = this.gitlab
      .reposFor(project, mr.project)
      .map((p) => normaliseRepoPath(p, homedir()))
      .filter((p): p is string => p !== null);
    if (!candidates.includes(repo)) throw new HttpException({ error: `${req.repo} is not a review candidate for !${mr.iid}` }, 400);
    if (req.choice.mode !== 'continue' || req.choice.branch !== mr.sourceBranch || req.choice.openMr) {
      throw new HttpException({ error: `a review continues ${mr.sourceBranch}` }, 400);
    }
    if (mr.review === null) throw new HttpException({ error: `no review state for !${mr.iid} yet` }, 409);
    const state = reviewState(mr.review, Date.now());
    if (state === 'reviewing' || state === 'clean') throw new HttpException({ error: `nothing to review on !${mr.iid}` }, 409);
    if (state === 'unknown') throw new HttpException({ error: `!${mr.iid} has too many threads to read` }, 409);
    if (reviewHalf(state) !== half) throw new HttpException({ error: `the review on !${mr.iid} moved on — reopen the sheet` }, 409);
    return { mr, candidates, action: { kind: 'review', half, mr: { project: mr.project, iid: mr.iid } } };
  }

  /**
   * The live-session gate (spec §5.2): whether anything may already be pushing `branch` in one of the MR's candidate checkouts. Three sources, because each
   * covers a session the others cannot see:
   *
   * - another review dispatch's hold — a spawn in flight, with no link and no row yet;
   * - a live link of ANY `how` and any key storing that branch — a Run of a sibling sub-task, a detected `branch` session, a `/jira link`ed one. Its `repo` is
   *   the mapped checkout for a Run, but a session's launch folder for the other two, so a linked worktree is folded back to its main checkout;
   * - an ACTIVE dashboard row (`working` or `question`) on that branch — a session nobody linked to any ticket, started by hand in the repo or one of its
   *   worktrees. An idle row is not pushing anything, so it does not block; a row in a checkout that is not a candidate is another clone's branch.
   *
   * Synchronous by construction — every read is memory or `mainCheckoutOf`'s plain file read — because `dispatch` runs it between `reserve` and the hold's
   * insert with no `await`, and that is the whole race guarantee.
   */
  private branchBusy(candidates: string[], branch: string): boolean {
    if (candidates.some((c) => this.branchHolds.has(`${c}\0${branch}`))) return true;
    const inCandidate = (path: string | null | undefined): boolean => {
      if (path === null || path === undefined || path === '') return false;
      const normalised = normaliseRepoPath(path, homedir());
      if (normalised === null) return false;
      if (candidates.includes(normalised)) return true;
      const main = mainCheckoutOf(normalised);
      return main !== null && candidates.includes(main);
    };
    if (this.live.liveLinks().some((l) => l.branch === branch && inCandidate(l.repo))) return true;
    return this.live.activeRows().some((r) => r.gitBranch === branch && inCandidate(r.projectPath));
  }

  /** Drops `hold` if the map still holds THIS dispatch's entry under its key; `null` (not a review, or the gate refused) is a no-op. */
  private dropHold(hold: BranchHold | null): void {
    if (hold !== null && this.branchHolds.get(hold.key)?.token === hold.token) this.branchHolds.delete(hold.key);
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
    maxPermission: PermissionMode | null,
    review: ReviewLaunch | null
  ): Promise<JiraDispatchResult> {
    const me = this.poller.identity();
    if (req.assign && me === null) throw new HttpException({ error: 'no identity' }, 503);
    const detail = unwrapJira(await this.poller.issueDetail(req.key));
    // A review's MR must be this ticket's or its parent's (spec §5.5): `mrKeys` reads the keys off the MR's branch and title, so a sub-task's work usually
    // sits on its story's MR. Only the detail knows the parent, so this is the first check after the read — and before the transition check and every write,
    // so a refusal assigns nothing. Same sentence as the cache miss: either way this is not an open MR of this ticket.
    if (review !== null && !review.mr.keys.includes(req.key) && !(detail.parent !== null && review.mr.keys.includes(detail.parent.key))) {
      throw notOpen(review.mr.iid, req.key);
    }
    const transition = req.transitionId === null ? null : detail.transitions.find((t) => t.id === req.transitionId);
    if (transition === undefined) throw new HttpException({ error: 'transition not offered' }, 400);
    // An edited prompt (the controller proved its shape) replaces the composition: the person's text is what spawns, so the composer is not asked — its
    // refusals (`prompt too long` for a skill whose placeholders overflow) are about a text this launch no longer sends. Still before any write, as before.
    let prompt: string;
    if (req.prompt !== undefined) prompt = req.prompt;
    else {
      const composed = composeJiraPrompt(detail, action, repo, workspace);
      if (!composed.ok) throw new HttpException({ error: composed.error }, 400);
      prompt = composed.prompt;
    }

    let assigned = false;
    if (req.assign && detail.assignee?.accountId !== me?.accountId) {
      this.written('assign: ', await this.poller.assignToMe(req.key), '');
      assigned = true;
    }
    if (transition !== null) {
      this.written('transition: ', await this.poller.transitionIssue(req.key, transition.id), assigned ? ASSIGN_STANDS : '');
    }
    const wrote = assigned || transition !== null;

    let spawned: ItemDispatchResult;
    try {
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
      this.dropHold(review?.hold ?? null);
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
    // The link now stores the review's branch, so the gate's link read covers it from here; holding it too would outlive the session's end.
    this.dropHold(review?.hold ?? null);
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
   * `POST /api/agents/jira-open-desktop` — hand ONE session to the desktop app through the dashboard's own guarded hand-over (spec C2): `POST /api/spawn` with
   * `{ resume: <id>, surface: 'desktop' }`, the body its `parseSpawnRequest` reads as the hand-over (no prompt, no project — `claude://resume` carries neither).
   * The guard stays the dashboard's: it refuses a session that is still running, already resuming, or open in the app, and this route re-implements none of it,
   * so the client's disabled-Desktop rule (`desktopButton`) is a courtesy and this is the check that holds.
   *
   * The dashboard's status and `{ error }` go through UNCHANGED — 501 `desktop app unavailable`, 400 `unknown session`, 409 `session is still running` /
   * `already resuming` / `session is open in the desktop app`, 429, 500 `open failed` — because the button's error line shows that sentence and the person
   * reads it beside a button labelled Desktop. That is deliberately NOT `desktopSpawnError`'s rewording, which was written for the launch sheet and describes
   * a launch, not a hand-over. An unreachable dashboard is a 502 naming the cause. Agents off is `stop`'s 409 and makes no request.
   *
   * A 200 that does not say `surface: 'desktop'` is a 502: a dashboard from before desktop hand-overs ignores `surface`, and a 200 from it is not a session
   * that opened in the app, whatever else it started.
   */
  async openDesktop(sessionId: string): Promise<{ ok: true }> {
    const cfg = readAgentsConfig();
    if (!cfg.enabled) {
      throw new HttpException({ error: environmentBlock(await this.agents.status()) ?? 'dispatch is off — set BM_AGENTS=on for the API' }, 409);
    }
    let res: Response;
    try {
      res = await fetch(`${cfg.url}/api/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cfg) },
        body: JSON.stringify({ resume: sessionId, surface: 'desktop' }),
        signal: AbortSignal.timeout(OPEN_DESKTOP_TIMEOUT_MS)
      });
    } catch (e) {
      throw new HttpException({ error: dashboardError(e, 'the dashboard desktop hand-over', OPEN_DESKTOP_TIMEOUT_MS) }, 502);
    }
    const body = (await res.json().catch(() => null)) as { surface?: unknown; error?: unknown } | null;
    if (!res.ok) {
      throw new HttpException({ error: typeof body?.error === 'string' ? body.error : `the dashboard answered ${res.status}` }, res.status);
    }
    if (body?.surface !== 'desktop') throw new HttpException({ error: 'the dashboard did not hand the session to the desktop app' }, 502);
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

/** A review's MR is not an open MR of this ticket: not cached, not `opened`, or carrying neither the key nor its parent's (spec §5.5, one sentence). */
function notOpen(iid: number, key: string): HttpException {
  return new HttpException({ error: `!${iid} is not an open merge request of ${key}` }, 400);
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
