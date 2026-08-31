import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { HttpException, Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { buildAllowlist, resolveAllowed } from '../items/allow.util';
import { scanProject } from '../items/scan.util';
import { readAgentsConfig, type AgentsConfig } from './config.util';
import {
  clampMode, deriveAction, dispatchBlock, environmentBlock, modesUpTo, pickFrom,
  EFFORTS, MODELS, PERMISSION_LADDER
} from '../../../shared/agent';
import { composePrompt, sessionName } from './prompt.util';
import type {
  AgentDispatchRequest, AgentDispatchResult, AgentPlan, AgentsStatus, BacklogItem, PermissionMode
} from '../../../shared/types';

/**
 * agents.service.ts — the only file in this app that makes an outbound call.
 *
 * Everything it talks to belongs to ../claude-agents-dashboard: GET /api/health
 * (cheap, per request), GET /api/management (a full scan of every project's
 * Claude config — cached), and POST /api/spawn. This app has no other network
 * dependency and should not grow one.
 */

/** Health is a few fields off a warm process; a slow one means unreachable. */
const HEALTH_TIMEOUT_MS = 4_000;
/** /api/management walks every recent project's .claude tree. It earns more. */
const MANAGEMENT_TIMEOUT_MS = 15_000;
/**
 * How long a path→dirName map stays good. The list only changes when a Claude
 * session starts somewhere new, and the call behind it is the expensive one in
 * this feature — a minute of staleness costs a disabled button that would have
 * worked, which the sheet's own re-check then corrects.
 */
const PROJECT_TTL_MS = 60_000;
/** The spawn call forks a process on the other side; the health probe's 4s is
 *  the wrong budget for it, and a constant named for the health probe governing
 *  the launch would be a misnomer besides. */
const SPAWN_TIMEOUT_MS = 10_000;
/**
 * A prompt longer than this is not a prompt any more. This is a sanity bound on
 * a runaway paste, not a mirror of the peer's limit.
 *
 * The peer's limit is `PROMPT_CAP = 4000` in
 * ../claude-agents-dashboard/server/lib/spawn.ts — not its 64KB body cap — and
 * it does not truncate: over the cap it answers 400 with
 * "prompt must be at most 4000 characters". Deliberately NOT hardcoded here at
 * 4000: that number is not published on its `/api/health`, so copying it would
 * only relocate the staleness into this file, where a bump on their side turns
 * into a rejection on ours for a prompt they would have accepted. Their 400 is
 * already relayed verbatim (see `dispatch`), and it names the real number,
 * which is a better message than anything this constant could produce.
 */
const PROMPT_MAX = 8_000;

/**
 * The one prompt `orchestrate()` will ever send — never accepted from the
 * request body. `dispatch`'s prompt varies by design: the action the item
 * needs (groom vs. execute) is derived from the item file, but WHAT to say
 * about it is a client-editable default the launch sheet composes
 * (composePrompt, prompt.util.ts) and the reader may reword before sending.
 * Orchestrate has no per-request decision to make room for: it always means
 * "hand this project's whole groomed queue to the backlog-orchestrate skill
 * and let orchestrate.mjs run it", so there is nothing legitimate for a
 * caller to vary — and a `prompt` field, were it honoured, would be the one
 * way an attacker-controlled request could make an unattended, headless
 * session do anything at all (see origin.guard.ts's own reasoning for why
 * that is exactly the threat these POST routes exist to prevent). A `prompt`
 * in the body is therefore dropped the same way dispatch drops any field
 * outside AgentDispatchRequest: by never being read.
 *
 * The leading slash is deliberate and differs from prompt.util.ts's own
 * choice for groom/execute (natural language, not a slash command — see that
 * file's comment on why). backlog-orchestrate's own SKILL.md declares
 * `trigger: /backlog-orchestrate` as its literal invocation phrase, so this
 * constant is that skill's documented trigger, verbatim.
 */
const ORCHESTRATE_PROMPT = '/backlog-orchestrate';

/**
 * Body of `POST /api/agents/orchestrate`, already reduced to exactly the
 * fields that survive the controller's field-by-field rebuild — see
 * AgentsController.orchestrate(). Not declared in shared/types.ts alongside
 * AgentDispatchRequest: that one has a client-side twin because the launch
 * sheet builds its request field by field from a form, and nothing on the
 * client needs this shape yet (a later task's board control has the project
 * already in hand and can compose this request directly). Promote it to
 * shared/ if and when a second consumer needs it.
 */
export interface AgentOrchestrateRequest {
  /** The registered project's absolute path — RegistryProject.path, the same
   *  string OrchestratorRun.project carries. Never a dashboard dirName: that
   *  key is resolved from this one value, the same way dispatch resolves it
   *  from an item's projectPath. */
  project: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/** Shape we rely on from the dashboard's /api/health. Everything optional: it
 *  is a different app's response and an older build may omit fields. */
interface DashboardHealth {
  remoteAnswer?: unknown;
  spawnAvailable?: unknown;
  spawnMaxPermission?: unknown;
}

interface DashboardManagement {
  projects?: { dirName?: unknown; path?: unknown }[];
}

@Injectable()
export class AgentsService {
  /** Keyed by url so a changed BM_AGENTS_URL cannot be answered from the old
   *  dashboard's map — which in tests is the difference between a pass and a
   *  silent cross-contamination between cases. */
  private cache: { at: number; url: string; map: Map<string, string> } | null = null;

  constructor(
    private readonly registry: RegistryService,
    private readonly orchestrator: OrchestratorService
  ) {}

  async status(): Promise<AgentsStatus> {
    const cfg = readAgentsConfig();
    const off: AgentsStatus = {
      enabled: false, reachable: false, remoteAnswer: false,
      spawnAvailable: false, spawnMaxPermission: null, projectPaths: []
    };
    // The short-circuit is the feature's off switch: no fetch, so no egress,
    // so nothing to report about a dashboard we never contacted.
    if (!cfg.enabled) return off;

    let health: DashboardHealth;
    try {
      health = await this.get<DashboardHealth>(cfg, '/api/health', HEALTH_TIMEOUT_MS);
    } catch (e) {
      return { ...off, enabled: true, error: message(e) };
    }

    let projectPaths: string[] = [];
    try {
      projectPaths = [...(await this.projectMap(cfg)).keys()];
    } catch {
      // Swallowed on purpose: health already told us the dashboard is up, and
      // reporting `reachable: false` because the *heavy* call timed out would
      // send the reader to fix a connection that works. An empty list disables
      // the buttons, which is the honest consequence.
    }

    return {
      enabled: true,
      reachable: true,
      remoteAnswer: health.remoteAnswer === true,
      spawnAvailable: health.spawnAvailable === true,
      spawnMaxPermission: asMode(health.spawnMaxPermission),
      projectPaths
    };
  }

  /**
   * Everything the launch sheet needs. `blocked` is filled rather than thrown
   * because the item IS dispatchable — the environment is what is not, and a
   * sheet that can explain that is more use than a failed request. The two
   * genuine 4xx cases (no such item, no next step) are the ones where there is
   * nothing to show a sheet about.
   */
  async plan(itemPath: string): Promise<AgentPlan> {
    const item = this.findItem(itemPath);
    if (item === null) throw new HttpException({ error: 'not found' }, 404);
    const action = deriveAction(item);
    if (action === null) {
      throw new HttpException({ error: 'nothing to dispatch for this item' }, 404);
    }

    const status = await this.status();
    return {
      action,
      prompt: composePrompt(item, action),
      project: item.project,
      allowedModes: modesUpTo(status.spawnMaxPermission),
      // auto, not the ceiling: a dispatched session runs unattended, and often
      // with nobody at the terminal the permission prompt would appear on — a
      // mode that stops on the first tool call it cannot self-approve is a
      // session that silently does nothing. `bypassPermissions`, the rung
      // above, is still refused as a default: asking for the most a host allows
      // is how a convenience becomes an incident. The select is right there if
      // more is wanted, and the ceiling clamps this down on hosts that cap
      // lower, so a stricter dashboard is never widened from here.
      defaultMode: clampMode('auto', status.spawnMaxPermission),
      blocked: dispatchBlock(item, status) ?? undefined
    };
  }

  /**
   * Start the session. Every check that matters re-runs here, because `plan`
   * ran against a different request and the sheet has been open for however
   * long the reader took: the item may have been groomed, archived, or
   * rewritten in between, and the answer must come from the file as it is now.
   */
  async dispatch(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
    if (prompt === '') throw new HttpException({ error: 'prompt is required' }, 400);
    if (prompt.length > PROMPT_MAX) {
      throw new HttpException({ error: 'prompt is too long' }, 400);
    }

    const item = this.findItem(req.itemPath);
    if (item === null) throw new HttpException({ error: 'not found' }, 404);
    const action = deriveAction(item);
    if (action === null) {
      // 409, not plan()'s 404 for this same condition: plan is asked "is
      // there a plan to show" and there is none, while dispatch is asked to
      // act and the file's own state refuses. Deliberate asymmetry — do not
      // "align" these two without re-reading why they differ.
      throw new HttpException({ error: 'nothing to dispatch for this item' }, 409);
    }
    // The whole reason this call is proxied rather than relayed: the client
    // said what it wanted, the file says what is legal, and the file wins.
    // Asking to execute a bug whose Fix still reads "unknown" is refused here,
    // which is the groomed invariant enforced on the only side that can read
    // the file.
    if (req.action !== action) {
      throw new HttpException({ error: `this item's next step is ${action}, not ${req.action}` }, 409);
    }

    const status = await this.status();
    const blocked = dispatchBlock(item, status);
    if (blocked !== null) {
      // 502 only when the feature is on and we genuinely failed to reach the
      // dashboard — the one case with an upstream to blame. BM_AGENTS off is
      // a local configuration state, not a gateway failure: nothing was ever
      // contacted, so there is no gateway to be bad. That case and "answered
      // and said no" both get 409 — a state the reader can go and change.
      throw new HttpException({ error: blocked }, status.enabled && !status.reachable ? 502 : 409);
    }

    const cfg = readAgentsConfig();
    const dirName = (await this.projectMap(cfg)).get(item.projectPath);
    if (dirName === undefined) {
      // dispatchBlock already covers this from the same map, so reaching here
      // means the cache expired between the two reads. Refuse rather than
      // guess a dirName from the path — deriving one would route around the
      // dashboard's membership check, which is the one thing it asks of us.
      throw new HttpException({ error: 'the dashboard cannot see this project' }, 409);
    }

    return this.spawn(cfg, {
      project: dirName,
      prompt,
      name: sessionName(item),
      permissionMode: clampMode(req.permissionMode, status.spawnMaxPermission),
      // Undefined for "default" and for any name this build does not know,
      // and `JSON.stringify` drops an undefined value outright — so the key
      // never reaches the dashboard and its argv carries no `--model` /
      // `--effort`. Validated here rather than trusted because the sheet is
      // not the only possible caller; the dashboard would drop a bad value
      // too, but that is its check, not ours.
      model: pickFrom(req.model, MODELS),
      effort: pickFrom(req.effort, EFFORTS),
      // Strictly `=== true`, matching the dashboard's own parse rule for this
      // field: anything else means off.
      remoteControl: req.remoteControl === true
    });
  }

  /**
   * The board's whole-project cousin of dispatch: same shape, guarded the
   * same way, one extra gate, and no item at all — this acts on a project's
   * whole groomed queue rather than one file, so there is nothing here to
   * call findItem/deriveAction on. See ORCHESTRATE_PROMPT for why the prompt
   * is a constant rather than a request field.
   */
  async orchestrate(req: AgentOrchestrateRequest): Promise<AgentDispatchResult> {
    const status = await this.status();
    if (!status.enabled) {
      // 404, not dispatch's 409-with-a-reason. dispatch's off case still has
      // a sheet open for one specific item, and plan()/dispatchBlock exist
      // precisely to give that sheet a "blocked" string worth rendering
      // ("dispatch is off — set BM_AGENTS=on"). Orchestrate has no sheet: the
      // board's control for it is either rendered or it is not, the same
      // `hidden` posture dispatchGate takes for every environment-level
      // block (see the "An environment-level block hides the dispatch
      // control" invariant) — so the honest HTTP answer for "this feature is
      // not on" is the same one an unregistered item's path gets from
      // dispatch/plan: as far as this caller is concerned, the route is not
      // here.
      throw new HttpException({ error: 'not found' }, 404);
    }

    // The other three environment-level blockers dispatchGate refuses on —
    // dashboard unreachable, no CLAUDE_BIN, remote answers off — shared with
    // dispatchGate through environmentBlock (shared/agent.ts) rather than
    // re-derived here a second time. A version of this method once checked
    // only `enabled` and project visibility and silently skipped these
    // three: an unreachable dashboard fell all the way through to the
    // project-map lookup below and came back as a flatly wrong "cannot see
    // this project" (a failed map lookup and a genuinely invisible project
    // look identical from there), and a dashboard with no CLAUDE_BIN or
    // remote answers off had nothing here to stop it at all — the request
    // went on to an actual POST /api/spawn that dispatchGate would have
    // refused before any outbound call. `status.enabled` is already known
    // true at this point (the block above returns otherwise), so
    // environmentBlock's own first check can never fire here — only the
    // three that follow it can.
    const envBlocked = environmentBlock(status);
    if (envBlocked !== null) {
      // Same split dispatch() makes for the identical situation via
      // dispatchBlock: 502 only when there is a genuine upstream to blame
      // (unreachable — we never got as far as asking the dashboard
      // anything); every other environment block is a state the reader can
      // go and change on the dashboard's own side, so 409.
      throw new HttpException({ error: envBlocked }, !status.reachable ? 502 : 409);
    }

    // dispatchGate's fifth and final check — the only one of its five lines
    // that is genuinely item-shaped (item.projectPath) rather than a plain
    // AgentsStatus read, which is why it is repeated here rather than
    // shared through environmentBlock above: dispatchGate takes a whole
    // BacklogItem only because every existing caller already has one on
    // hand, and this is the one line that actually uses it. Still the same
    // raw string compare against `status.projectPaths`, deliberately not
    // realpath, and deliberately not a dirName derived from the path to
    // route around the dashboard's own membership check — see the "A
    // project the dashboard cannot see cannot be dispatched to" invariant
    // in CLAUDE.md, which this line exists to uphold a second time for a
    // route dispatchGate itself never sees.
    if (!status.projectPaths.includes(req.project)) {
      throw new HttpException(
        { error: `the dashboard cannot see ${req.project} — no Claude session there inside its LOOKBACK_HOURS` },
        409
      );
    }

    // The lock. orchestrate.mjs's own `init` already refuses to start a
    // second run for a project that has a fresh run.json (its on-disk lock,
    // enforced before this endpoint is ever reached from a terminal
    // invocation) — this is that same rule enforced a second time, on the
    // one path that does not go through orchestrate.mjs's own guard at all:
    // a click on the board goes straight from here to POST /api/spawn, so
    // without this check nothing on this side of the dashboard would stop
    // two runs from racing each other into existence for the same project.
    // Belt and suspenders, the same reasoning as the registry file's
    // single-writer rule — the check that truly matters lives with the
    // writer (orchestrate.mjs, there; backlog.mjs, there), and every OTHER
    // path capable of triggering a write re-checks it rather than trusting
    // that every caller will always go through that writer.
    const activeRun = this.orchestrator.runs().runs.find((r) => r.project === req.project && r.fresh);
    if (activeRun) {
      throw new HttpException(
        { error: `a run is already in progress for this project (${activeRun.runId})` },
        409
      );
    }

    const cfg = readAgentsConfig();
    const dirName = (await this.projectMap(cfg)).get(req.project);
    if (dirName === undefined) {
      // Same race dispatch()'s identical line guards against: the membership
      // check above and this lookup read the same cache, and only a TTL
      // expiry between the two reads reaches here. Refuse rather than derive
      // a dirName from the path, for the reason named above.
      throw new HttpException({ error: 'the dashboard cannot see this project' }, 409);
    }

    return this.spawn(cfg, {
      project: dirName,
      prompt: ORCHESTRATE_PROMPT,
      // Unlike dispatch, which names a session after the one item it is
      // working (sessionName, prompt.util.ts), there is no item here to
      // build that name from — orchestrateSessionName below is that
      // function's counterpart for a whole project. Without a name at all,
      // every orchestrate run's dashboard row reads exactly like a session
      // started by hand at a terminal, which is a real usability problem
      // for a feature whose entire purpose is watching a run that is
      // actually happening.
      name: orchestrateSessionName(req.project),
      permissionMode: clampMode(req.permissionMode ?? '', status.spawnMaxPermission),
      model: pickFrom(req.model, MODELS),
      effort: pickFrom(req.effort, EFFORTS)
      // No `remoteControl`. That flag is what gives a spawned session's
      // AskUserQuestion a channel to a human's phone when it hits a
      // preflight question it cannot resolve alone — see
      // skills/backlog-orchestrate/SKILL.md, "With questions: ask,
      // best-effort". Left off on purpose for a board-started run: without
      // a channel, the orchestrator takes that same section's "no channel"
      // path for any question it cannot answer itself — records the
      // question, stages that item `needs-answers`, and moves on to the
      // next one rather than blocking — which is exactly what surfaces on
      // the board's run view for a human to resolve on their own time. A
      // UI-started run is designed to skip questions and surface them on
      // the board, not answer them remotely.
    });
  }

  /**
   * POST /api/spawn against the dashboard, and the one place this app
   * decides what its answer means — shared by dispatch() and orchestrate().
   * Each composes a different body for a different reason (one item vs. one
   * project's whole queue), but once that body is built, the request itself
   * and what a 2xx/4xx/5xx answer or a malformed one means are identical, and
   * this file's own opening comment is the reason not to say so twice:
   * everything this app talks to belongs to one dashboard, and that should
   * not multiply into two slightly different tellings of the same call.
   */
  private async spawn(cfg: AgentsConfig, spawnBody: Record<string, unknown>): Promise<AgentDispatchResult> {
    const res = await fetch(`${cfg.url}/api/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify(spawnBody),
      signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS)
    });

    const body = (await res.json().catch(() => null)) as { sessionId?: unknown; error?: unknown } | null;
    if (!res.ok) {
      // Verbatim. The dashboard's rejections are short and specific ("too many
      // launches in flight", "unknown project: …"); paraphrasing them would
      // only lose the one detail the reader needs.
      const error = typeof body?.error === 'string' ? body.error : `spawn answered ${res.status}`;
      // The message is verbatim; the status is not, because the number alone
      // can lie about whose fault it is. A dashboard 401 would mean OUR
      // BM_AGENTS_TOKEN is wrong, not that the browser's own request failed to
      // authenticate — relaying it as a bare 401 reads as the reader's
      // problem. Anything outside the ordinary 400-499 client-error range
      // (a 500, a proxy's own 502/503) is an upstream fault this app cannot
      // vouch for, so it collapses to 502 instead of leaking an arbitrary code.
      const httpStatus = res.status >= 400 && res.status < 500 ? res.status : 502;
      throw new HttpException({ error }, httpStatus);
    }
    if (typeof body?.sessionId !== 'string') {
      throw new HttpException({ error: 'spawn returned no session id' }, 502);
    }
    return { sessionId: body.sessionId };
  }

  /** Absolute project path → the dashboard's own dirName key. */
  private async projectMap(cfg: AgentsConfig): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.cache && this.cache.url === cfg.url && now - this.cache.at < PROJECT_TTL_MS) {
      return this.cache.map;
    }
    const data = await this.get<DashboardManagement>(cfg, '/api/management', MANAGEMENT_TIMEOUT_MS);
    const map = new Map<string, string>();
    for (const p of data.projects ?? []) {
      // Both fields or neither: a half-shaped entry is one we cannot spawn
      // into, and dropping it is the same posture RegistryService takes on a
      // mis-shaped project — a bad entry, not a bad response.
      if (typeof p.path === 'string' && typeof p.dirName === 'string') map.set(p.path, p.dirName);
    }
    this.cache = { at: now, url: cfg.url, map };
    return map;
  }

  /**
   * The one item at this path, or null. The allowlist runs first and is the
   * same one GET /api/items/body uses — a path outside every registered
   * backlog/ is not an item here either.
   */
  private findItem(requestPath: string): BacklogItem | null {
    const registry = this.registry.load();
    const real = resolveAllowed(requestPath, buildAllowlist(registry));
    if (real === null || !real.endsWith('.md')) return null;
    for (const project of registry.projects) {
      for (const candidate of scanProject(project).items) {
        // Both sides through realpath: resolveAllowed already resolved
        // symlinks, scanProject did not, and on macOS the temp roots the test
        // fixtures live under are themselves symlinks (/var → /private/var).
        // A plain string compare would find nothing there.
        if (samePath(candidate.path, real)) return candidate;
      }
    }
    return null;
  }

  private async get<T>(cfg: AgentsConfig, path: string, timeoutMs: number): Promise<T> {
    const res = await fetch(`${cfg.url}${path}`, {
      headers: authHeaders(cfg),
      // Without this an unreachable-but-routable host hangs the board's status
      // call for the OS connect timeout — minutes, on a tailnet address whose
      // peer is asleep.
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as T;
  }
}

export function authHeaders(cfg: AgentsConfig): Record<string, string> {
  return cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
}

/**
 * The `-n` name an orchestrate run's dashboard row is labelled with —
 * `sessionName`'s (prompt.util.ts) counterpart for a whole project rather
 * than one item, needed because `orchestrate()` has no `BacklogItem` to
 * build that one from. Same dashboard constraint, same reason:
 * `sessionName`'s own comment explains that the dashboard's
 * `NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/` allows neither `:` nor `/`,
 * and a name that fails it is not rejected but silently dropped to
 * `undefined` — the exact failure mode `sessionName` itself was rewritten
 * once to fix, after an earlier `bl:<project>/<id>` spelling was discarded
 * on 100% of dispatches without a single request actually failing. Space-
 * separated for that reason, not the more obvious `orchestrate:<project>`.
 * Sliced to the same 60-character cap `sessionName` uses, for the same
 * reason: over the cap is the same silent drop.
 */
function orchestrateSessionName(projectPath: string): string {
  return `orchestrate ${basename(projectPath)}`.slice(0, 60);
}

/** Never throws — used only to build messages and to compare paths. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * A ceiling we do not recognise is a dashboard newer than this client. Read as
 * null, which `modesUpTo` turns into "plan only" — the safe reading, since we
 * cannot know where an unknown string sits on the ladder.
 */
function asMode(value: unknown): PermissionMode | null {
  return typeof value === 'string' && (PERMISSION_LADDER as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
