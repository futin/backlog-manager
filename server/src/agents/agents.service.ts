import { HttpException, Injectable } from '@nestjs/common';

import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { ItemsService } from '../items/items.service';
import { TrackerPollerService } from '../tracker/poller.service';
import { DispatchRecordsService } from '../items/dispatch-records.service';
import { proveBaseBranch } from '../items/base-branch.util';
import { authHeaders, dashboardError, readAgentsConfig, type AgentsConfig } from './config.util';
import { itemClaimBlock } from './dashboard-sessions.util';
import { desktopSpawnError } from './desktop.util';
import { machineChoiceBlock, remoteDefaultModel, remoteGateBlock } from './machine-choice.util';
import { DashboardStatusService } from './dashboard-status.service';
import { DashboardsService, type Machine } from './dashboards/dashboards.service';
import { filesBackedReason, OffersService, REMOTE_BUDGET } from './dashboards/offers.service';
import { OrchestrateArgsService } from './orchestrate-args.service';
import {
  clampMode,
  deriveAction,
  dispatchBlock,
  FINISH_FLAG,
  inReviewBlock,
  isExecuteFinish,
  modesUpTo,
  planReviewBlock,
  unvettedBlock,
  pickFrom,
  projectDispatchGate,
  runClaimBlock,
  EFFORTS,
  MODELS,
  DEFAULT_MODEL
} from '../../../shared/agent';
import { appendFinishClause, composePrompt, orchestrateSessionName, resumeSessionName, sessionName, stopSessionName } from './prompt.util';
import { clearPauseRequest, controlHome, pauseRequestEffective, readPauseRequest, stopRequestEffective, writePauseRequest } from '../orchestrator/pause-control.util';
import { WatchdogStateService } from '../orchestrator/watchdog-state.service';
import { RemoteStartingService } from '../orchestrator/remote-starting.service';
import { RemoteRunsService } from '../orchestrator/remote-runs.service';
import { RESUME_LOCKED_CODE, RUN_IN_PROGRESS_CODE, RUN_STALE_MS } from '../../../shared/types';
import type {
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentPlan,
  AgentsStatus,
  BacklogItem,
  ItemDispatchResult,
  LaunchSurface,
  OrchestratorRun,
  PauseResult,
  PermissionMode,
  StartOrchestrateRequest,
  StopResult
} from '../../../shared/types';

/**
 * agents.service.ts — the only file in this app that makes an outbound call.
 *
 * Everything it talks to belongs to ../claude-agents-dashboard: GET /api/health
 * (cheap, per request), GET /api/configs (a full scan of every project's
 * Claude config — cached), and POST /api/spawn. This app has no other network
 * dependency and should not grow one.
 *
 * Multi-dashboard task 4 moved the first two reads, and the cache behind the second, into `dashboard-status.service.ts` so that one copy of them can
 * read any machine's dashboard; this class still makes every one of those calls for home, through that service.
 */

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
 * The base of every prompt `orchestrate()` will ever send — never accepted
 * from the request body. What a caller can influence is exactly four things,
 * enumerated here and composed in `orchestrate()` and nowhere else:
 *
 *   1. **`ids`** — a list `resolveIds` has already proved name open bugs or
 *      tasks in the project being orchestrated (see that method for both
 *      checks and for why shape alone would not be enough).
 *   2. **` --merge-mode branch`** or **` --merge-mode pr`** — appended when
 *      `resolveMergeMode` (Task 4) resolved the request's `mergeMode` to
 *      `'branch'` or `'pr'`; `pr` only ever survives that method for a
 *      tracker project.
 *   3. **` --question-mode decide`** — appended when `resolveQuestionMode`
 *      (task-19) resolved `questionMode` to `'decide'`.
 *   4. **` --base <ref>`** — appended when `resolveBase` (task-44) resolved
 *      `base` to anything other than `'main'`.
 *
 * Each is appended only off its own guard and each default appends nothing,
 * so a request written before any of these fields existed composes the
 * byte-identical prompt it always did. All four are flags `orchestrate.mjs`
 * takes and SKILL.md documents on the trigger, so composing them here is
 * speaking the skill's own invocation surface rather than inventing a
 * channel.
 *
 * **They are not all the same kind of safe, and the difference is worth
 * stating rather than averaging over.** Members 2 and 3 are the tightest: the
 * text each can append is one of a few compile-time constants (`branch` or
 * `pr` for the merge mode, `decide` for the question mode) selected
 * by a guard, so no caller-supplied character reaches the prompt through
 * either channel at all. An id (1) is looser — caller text that passed a
 * shape check and was then proved against a closed vocabulary, this project's
 * own open items. A base (4) is looser still in form and is the reason this
 * comment can no longer say "no caller text reaches the prompt": it appends
 * the caller's own string. What makes it acceptable is that it, too, is
 * proved against a closed vocabulary before composition — the branches that
 * exist in this one project — plus a ref-name check that runs first precisely
 * so the value cannot be read as an option. An earlier version of this
 * comment claimed every appended flag was a compile-time literal; that was
 * true of two of the three flags and is now true of two of four, and a
 * comment that lists some of the influences is worse than one that lists
 * none.
 *
 * `dispatch`'s prompt varies by design: the action the item needs (groom vs.
 * execute) is derived from the item file, but WHAT to say about it is a
 * client-editable default the launch sheet composes (composePrompt,
 * prompt.util.ts) and the reader may reword before sending. Orchestrate has
 * no per-request PROSE to make room for: it always means "hand this project's
 * whole groomed queue to the backlog-orchestrate skill and let
 * orchestrate.mjs run it". A `prompt` field, were it honoured, would still be
 * the one way an attacker-controlled request could make an unattended,
 * headless session do anything at all (see origin.guard.ts's own reasoning
 * for why that is exactly the threat these POST routes exist to prevent). A
 * `prompt` in the body is therefore dropped the same way dispatch drops any
 * field outside AgentDispatchRequest: by never being read. The asymmetry that
 * makes all four members above acceptable where a `prompt` would not be is
 * the same one in every case: a prompt is free text and there is no check
 * that could make it safe, while each of these is checked against something
 * the server can enumerate for itself.
 *
 * The leading slash is deliberate and differs from prompt.util.ts's own
 * choice for groom/execute (natural language, not a slash command — see that
 * file's comment on why). backlog-orchestrate's own SKILL.md declares
 * `trigger: /backlog-orchestrate` as its literal invocation phrase, so this
 * constant is that skill's documented trigger, verbatim.
 */
const ORCHESTRATE_PROMPT = '/backlog-orchestrate';

/**
 * The base of every prompt `resume()` will ever send — and, unlike
 * `ORCHESTRATE_PROMPT` just above, the WHOLE of it: `POST /api/agents/resume`
 * has no `ids`, no `mergeMode`, not even a `prompt` field for a caller to
 * occupy in the request body (see `AgentsController.resume` — the body is
 * rebuilt down to one field, `project`, and nothing else is ever read off
 * it). There is therefore nothing here for a caller to influence at all,
 * which is a NARROWER surface than orchestrate's already-narrow one:
 * orchestrate at least has to validate two fields before composing a string
 * from them, resume has nothing to validate because nothing rides along.
 * `orchestrate.mjs`'s SKILL.md documents `--resume` as a flag its own
 * trigger accepts for recovering an interrupted run (see
 * skills/backlog-orchestrate/references/recovery.md), so this constant is
 * that flag appended to the same literal trigger `ORCHESTRATE_PROMPT` holds
 * — not a second, independent string this file invented.
 */
const RESUME_PROMPT = '/backlog-orchestrate --resume';

/**
 * `POST /api/agents/stop`'s whole spawn (bug-39) — `RESUME_PROMPT`'s exact
 * sibling, and a documented flag of this skill's own trigger (SKILL.md's
 * invocation line: `--resume` takes over an interrupted run, `--abort` ends
 * one), never a string this file invented. Nothing a caller sends reaches
 * it: the request body is rebuilt down to `project` and `cancel`, exactly as
 * resume's is.
 *
 * **The spawn is unconditional, not "only for a stale run", and that is the
 * force stop itself.** If the real driver is still alive, the abort session's
 * `takeOverRun` write evicts it: the driver's very next command hits
 * `assertDriver`, exits `7`, and stops immediately writing nothing more.
 * That is the lease working exactly as designed rather than being worked
 * around — which is why this route needs no pid for the driver and no kill
 * channel to one.
 */
const STOP_PROMPT = '/backlog-orchestrate --abort';

/**
 * Body of `POST /api/agents/orchestrate`, already reduced to exactly the fields that survive the controller's field-by-field rebuild — see
 * AgentsController.orchestrate(). The WIDENED twin of the client's `StartOrchestrateRequest` (shared/types.ts, where every field is documented): the same
 * keys, with the four a body this service cannot trust could hold anything in widened to what it actually might hold. Every other field — `project`,
 * `model`, `effort`, `base`, `machine` — is the shared field itself, so the two cannot drift apart on a field neither side narrows; and
 * `OrchestrateRequestKeysMatch` below fails the typecheck the moment the key sets differ, in either direction.
 */
export interface AgentOrchestrateRequest extends Omit<StartOrchestrateRequest, OrchestrateWidenedKey> {
  /** `string`, not `PermissionMode`: arrives straight off a request body this service cannot trust, and `clampMode` is where it becomes the union. */
  permissionMode?: string;
  /**
   * `string | undefined`, not `MergeMode | undefined`: this arrives straight off a request body this service cannot trust, the same reason `ids` below is
   * `unknown` rather than `string[]`. `resolveMergeMode` is the only place this field is read and the only place it is allowed to become a `MergeMode` — see
   * that method for the validation rule, which deliberately differs from every neighbouring field.
   */
  mergeMode?: string;
  /**
   * `string | undefined` for exactly the reason `mergeMode` above is. `resolveQuestionMode` is the only place it is read and the only place it is allowed to
   * become a `QuestionMode` — and, like its neighbour and unlike `model`/`effort`, an unrecognised value there is a 400 rather than a drop.
   */
  questionMode?: string;
  /**
   * `unknown` rather than `string[]`: this arrives straight off a request body, and the narrowing is the point — see `resolveIds`, which is the only place
   * this value is read and the only place it is allowed to become a string. An explicitly EMPTY array is not the same as an absent one and is refused rather
   * than folded into "everything"; that is the same distinction `parseIdsArg` keeps in orchestrate.mjs, for the same reason, one layer down.
   */
  ids?: unknown;
}

/** The four fields `AgentOrchestrateRequest` widens. Everything else it takes from `StartOrchestrateRequest` as is. */
type OrchestrateWidenedKey = 'permissionMode' | 'mergeMode' | 'questionMode' | 'ids';

/**
 * Compile-time only, and required rather than optional: `Omit` alone does not couple the two key sets, because omitting a key the shared type no longer has
 * is silent — rename `mergeMode` in shared/types.ts and the widened `mergeMode` here would live on as a field no client sends. So both directions are checked:
 * a key `AgentOrchestrateRequest` has that `StartOrchestrateRequest` lacks, and the reverse. Either one makes `SameKeys` `false`, and `Assert<false>` fails
 * `pnpm run typecheck`. A type alias emits no JavaScript, so a running orchestrator sees an identical build.
 */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;
type Assert<T extends true> = T;
export type OrchestrateRequestKeysMatch = Assert<SameKeys<AgentOrchestrateRequest, StartOrchestrateRequest>>;

/** `spawnInProject`'s options — every one-session launch's. `launchInProject` adds the item dispatch's `surface`. */
interface LaunchOpts {
  prompt: string;
  name: string;
  permissionMode: string;
  maxPermission: PermissionMode | null;
  model?: unknown;
  effort?: unknown;
  remoteControl: boolean;
  machine?: Machine;
  remotePath?: string;
}

/**
 * A launch that has to have started a headless session. Every launch but an item dispatch sends no `surface`, and the dashboard answers such a body with an
 * id, so a desktop answer here is a dashboard breaking its contract — the 502 `spawn returned no session id` a missing id has always been.
 */
function headless(result: ItemDispatchResult): AgentDispatchResult {
  if (result.surface === 'desktop') throw new HttpException({ error: 'spawn returned no session id' }, 502);
  return result;
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly orchestrator: OrchestratorService,
    /**
     * bug-19 — the resume lock's home, and the reason this is
     * `WatchdogStateService` rather than `WatchdogService`: the sweeper
     * injects THIS service to call `resume()`, so injecting it back would be
     * the cycle Nest cannot construct (the same one `arm()` and
     * `noteBoardResume` live in the controller to avoid). The state holder
     * has no such edge — it is a plain in-memory record, provided and
     * exported by `OrchestratorModule`, which `AgentsModule` already imports.
     */
    private readonly watchdogState: WatchdogStateService,
    /**
     * task-46 — the dispatch lift. `findItem` used to be a private copy of the
     * files adapter's allowlist-and-scan living in this file, which is why
     * `plan` and `dispatch` could only ever see an item on disk. It is now a
     * one-line delegate to `ItemsService.find`, which dispatches on the ref's
     * shape over the same adapters `/api/items` reads through — so a URN
     * resolves to exactly the `BacklogItem` the board drew its button from.
     *
     * The edge runs agents → items and never back: `ItemsModule` knows nothing
     * about dispatch, so there is no cycle for Nest to refuse.
     */
    private readonly items: ItemsService,
    /**
     * #388 — "is this orchestrate request legal": the `ids`, base, merge-mode and question-mode resolvers `spawnOrchestrate` runs in its refusal order,
     * and the two reads behind the Orchestrate sheet (`branches`, `mergeCheck`), which the controller calls directly. They need only the registry and
     * the item adapters, which is why `RegistryService` is no longer injected here. Injects nothing from this module, so no cycle.
     */
    private readonly orchestrateArgs: OrchestrateArgsService,
    /** #225 — written by `dispatch` alone; see `DispatchRecordsService` for why it lives in `ItemsModule`. */
    private readonly dispatches: DispatchRecordsService,
    /**
     * #17 — for `syncOffBlock` alone: dispatch, orchestrate and resume refuse a project whose repo's sync is `off`, because every one of them starts a
     * session that writes through the item routes, and those refuse too. `TrackerModule` imports only `RegistryModule`, so the edge opens no cycle.
     */
    private readonly poller: TrackerPollerService,
    /**
     * Multi-dashboard task 4 — the health probe and the path→dirName map, moved out of this class so the offers can read ANY machine's dashboard through
     * the same code without injecting this service (task 5 makes this service inject the offers, and the reverse edge would be a cycle Nest cannot
     * construct). Every call here still goes through it with home's config, so home's reads, budgets and cache behave exactly as before the move.
     */
    private readonly dashboardStatus: DashboardStatusService,
    /**
     * Multi-dashboard task 5 — which machines a launch may go to (`machine(id)`), whether the picked one is offered for the project right now, and the
     * project's path on it. Neither service injects this one (both read dashboards through `DashboardStatusService`), so the edge opens no cycle.
     */
    private readonly dashboards: DashboardsService,
    private readonly offers: OffersService,
    /**
     * "Starting on <machine>" between a remote launch and its first claim — provided and exported by `OrchestratorModule`, which this module already
     * imports, so the runs controller there lists the same singleton this marks.
     */
    private readonly remoteStarting: RemoteStartingService,
    /**
     * Multi-dashboard task 6 — the remote runs the tracker cache derives, for the one refusal no other record can give: a drain of this repo already
     * live on the machine a remote orchestrate is aimed at. `OrchestratorService.runs()` answers `remote: []` by design (remote runs ride beside `runs`,
     * never in it), so this reads the derivation itself. Exported by `OrchestratorModule`; it injects nothing from this module, so no cycle.
     */
    private readonly remoteRuns: RemoteRunsService
  ) {}

  /** Home's dashboard, as Settings and every launch gate read it. The body is `DashboardStatusService.statusOf`, which can read any machine's. */
  async status(): Promise<AgentsStatus> {
    return this.dashboardStatus.statusOf(readAgentsConfig());
  }


  /**
   * Everything the launch sheet needs. `blocked` is filled rather than thrown
   * because the item IS dispatchable — the environment is what is not, and a
   * sheet that can explain that is more use than a failed request. The two
   * genuine 4xx cases (no such item, no next step) are the ones where there is
   * nothing to show a sheet about.
   */
  async plan(itemPath: string): Promise<AgentPlan> {
    const item = await this.findItem(itemPath);
    if (item === null) throw new HttpException({ error: 'not found' }, 404);
    const action = deriveAction(item);
    if (action === null) {
      throw new HttpException({ error: 'nothing to dispatch for this item' }, 404);
    }

    const status = await this.status();
    // One read, both halves. `OrchestratorService.runs()` has always returned
    // `{ runs, starting }` from a single call, and destructuring it here
    // rather than reaching for `.runs` inline is the whole of the server-side
    // change bug-21 needed: no new wiring, no new injection, no second read.
    const { runs, starting } = this.orchestrator.runs();
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
      // Two blocks, one field, in the order the reader has to fix them: the
      // dashboard ladder first (nothing about a run matters if dispatch is off
      // or the project is invisible), then the run claim. `runClaimBlock` does
      // its own project/id/freshness matching against the run payload — see
      // its doc comment for why that lookup lives in one place rather than
      // being re-derived on each side.
      //
      // bug-21: BOTH halves of the one `runs()` call, not `.runs` alone. A
      // run is invisible to the run file for the 1–5 minutes before `init`
      // writes it, and this is the field the launch sheet renders its refusal
      // from — a sheet that offers a launch button for an item the dispatch
      // route below is about to 409 is the half-fixed state.
      // #17: a project whose sync is off is the third, after the run claim — the sheet must not offer what `dispatch` below would refuse.
      // The in-review rung (spec decision 9) sits between the dashboard ladder and the run claim, the client's order: a PR is open for this tracker
      // item, and `dispatch` below refuses it with the same sentence.
      // The plan-review rung (backlog-tick) follows it, in the client's order: a plan written unattended and not yet approved, refused by `dispatch` below with
      // the same sentence. In-review first, so an item holding both says the PR reason.
      // The unvetted rung (#341) sits between those two, the client's order again: an outsider's issue no trusted groom has pinned, which approving the
      // plan would not clear — so its reason reads before plan-review's.
      blocked:
        dispatchBlock(item, status) ??
        inReviewBlock(item) ??
        unvettedBlock(item) ??
        planReviewBlock(item) ??
        runClaimBlock(item, runs, starting) ??
        this.poller.syncOffBlock(item.projectPath) ??
        undefined,
      // Home's dashboard alone is asked (`status()`), and only an execute or a groom may open in the desktop app — a capture, like every launch that is not
      // an item dispatch, stays headless. Absent unless that dashboard says `desktopAvailable`, so a dashboard from before desktop launches draws no control.
      ...((action === 'execute' || action === 'groom') && status.desktopAvailable === true
        ? { launchSurface: status.launchSurfaceDefault ?? 'dashboard' }
        : {})
    };
  }

  /**
   * Start the session. Every check that matters re-runs here, because `plan`
   * ran against a different request and the sheet has been open for however
   * long the reader took: the item may have been groomed, archived, or
   * rewritten in between, and the answer must come from the file as it is now.
   */
  async dispatch(req: AgentDispatchRequest): Promise<ItemDispatchResult> {
    const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
    if (prompt === '') throw new HttpException({ error: 'prompt is required' }, 400);
    if (prompt.length > PROMPT_MAX) {
      throw new HttpException({ error: 'prompt is too long' }, 400);
    }

    // Multi-dashboard task 5 — the machine, resolved ahead of every other rule because the finish below depends on it. Absent (the client omits it for home)
    // and `home` in any case are this machine, which is the whole of the home-only promise: such a body walks exactly the path it walked before, gate for
    // gate, to a byte-identical spawn. Anything that names no machine is a 400 — `resolveMachine`, shared with orchestrate, says why.
    const m = this.resolveMachine(req.machine);

    // Work sent to a remote machine always comes back as a PR (spec, Goals): a remote execute's finish IS `pr`, whatever the body says — and a body that
    // names another finish is refused rather than overridden, because the sheet locks the picker to PR for a remote, so a body that disagrees came from
    // somewhere that would be surprised by a push. A remote GROOM is the opposite case and is refused by rule 3 below: it has no finish at all (it stays
    // an in-place groom on the remote, whose claim and plan the board already follows), so a body naming one came from a sheet that does not know that.
    if (!m.home && req.action === 'execute' && req.finish !== undefined && req.finish !== 'pr') {
      throw new HttpException({ error: `finish must be pr on ${m.label}` }, 400);
    }

    // The finish — the sheet's picker for an execute OR a groom, validated here and appended as `finishClause` below. `req.finish`, `req.base`,
    // `req.autoMerge` and `req.fix` are typed, but the controller forwards them unvalidated (as `model` is, and `pickFrom` checks that), so every rule below
    // runs on what the wire actually carried. A body from before these fields sends none of them and is `in-place`: no 400, which is what keeps an open tab
    // working across the deploy.
    //
    // All the SHAPE rules run before the item lookup — they need only the body — and the one that needs git (the base proof) runs after every 409, so a
    // reader told "this item's next step is groom" is not first told their branch is wrong.
    //   1. a finish outside the vocabulary; 2. a finish on anything but an execute or a groom; 3. a finish on a groom sent to another machine;
    //   4. `autoMerge` or `fix` that is not a boolean; then, on the DERIVED finish, 5. a base without `pr` and `pr` without a base; 6. `autoMerge: true` or
    //   `fix: true` beside a finish other than `pr` (a `false` is an untouched toggle and is accepted anywhere); 7. `fix: true` without `autoMerge: true`.
    if (req.finish !== undefined && !isExecuteFinish(req.finish)) {
      throw new HttpException({ error: 'finish must be in-place or pr' }, 400);
    }
    if (req.finish !== undefined && req.action !== 'execute' && req.action !== 'groom') {
      throw new HttpException({ error: 'finish applies only to execute or groom' }, 400);
    }
    if (!m.home && req.action === 'groom' && req.finish !== undefined) {
      throw new HttpException({ error: `a groom on ${m.label} has no finish` }, 400);
    }
    if (req.autoMerge !== undefined && typeof req.autoMerge !== 'boolean') {
      throw new HttpException({ error: 'autoMerge must be a boolean' }, 400);
    }
    if (req.fix !== undefined && typeof req.fix !== 'boolean') {
      throw new HttpException({ error: 'fix must be a boolean' }, 400);
    }
    // The base rules run on the DERIVED finish, so a remote execute with no `finish` is held to `pr`'s own rule — a base is required — rather than to a
    // second copy of it.
    const finish = !m.home && req.action === 'execute' ? 'pr' : (req.finish ?? 'in-place');
    if (req.base !== undefined && finish !== 'pr') {
      throw new HttpException({ error: 'base applies only to finish pr' }, 400);
    }
    if (finish === 'pr' && req.base === undefined) {
      throw new HttpException({ error: 'base is required with finish pr' }, 400);
    }
    // Rule 6 comes before rule 7 on purpose: a lone `fix: true` with no finish derives `in-place`, and the reader should hear "this applies only to a PR"
    // before "fix needs auto-merge" — the second would send them to tick a box that a PR finish would then have to be chosen for anyway.
    if ((req.autoMerge === true || req.fix === true) && finish !== 'pr') {
      throw new HttpException({ error: 'autoMerge and fix apply only to finish pr' }, 400);
    }
    if (req.fix === true && req.autoMerge !== true) {
      throw new HttpException({ error: 'fix requires autoMerge' }, 400);
    }
    // The surface — the sheet's Dashboard | Desktop control, drawn only from `AgentPlan.launchSurface`. Shape rules, so they run here with the others. Refused
    // rather than dropped, the dashboard's own reasoning for its `bad surface`: a headless launch the person believed was opening in the desktop app is
    // worse than a 400. Desktop is an item launch on THIS machine only: `desktopAvailable` describes the Mac that answered, and a remote dashboard from
    // before desktop launches would ignore the field and start a headless session while the sheet said Desktop.
    if (req.surface !== undefined && req.surface !== 'dashboard' && req.surface !== 'desktop') {
      throw new HttpException({ error: 'surface must be dashboard or desktop' }, 400);
    }
    if (req.surface === 'desktop' && req.action !== 'execute' && req.action !== 'groom') {
      throw new HttpException({ error: 'only an execute or a groom can open in the desktop app' }, 400);
    }
    if (req.surface === 'desktop' && !m.home) {
      throw new HttpException({ error: `the desktop app opens only on this machine, not on ${m.label}` }, 400);
    }
    //   8. An execute or groom body carrying a `--finish`, `--base`, `--auto-merge` or `--fix` token. The pickers and checkboxes are the only channel for any
    //      of them: the clause appended below is built from validated values alone, so a typed `--finish pr` under an In place pick would reach the skill
    //      beside `COMMIT_RULE` (which carries no token) and push, a typed `--base develop` beside the clause's own `--base main` would leave the session
    //      two bases, and a typed `--auto-merge` under a plain PR pick would arm a merge nobody chose. The skill reads the token as the signal wherever it
    //      appears in the trigger, and the board's own clause spells it inside backticks, so a body that quotes, backticks or parenthesises the token
    //      (`--finish pr`, "--finish pr", (--base x)) steers the session as surely as a bare one. The pattern therefore asks only that no word character or
    //      hyphen sits on either side of the token — `[\w-]` — rather than requiring whitespace: `--finished`, `--base-ref` and a `base64` blob are longer
    //      words and are left alone, while `--base=develop` (`=` is neither) is refused. A capture body is free text no flag parser reads, and is not
    //      refused.
    if ((req.action === 'execute' || req.action === 'groom') && FINISH_FLAG.test(prompt)) {
      throw new HttpException(
        { error: "the finish mode, base, auto-merge and fix are set by the sheet's pickers — remove --finish, --base, --auto-merge and --fix from the prompt" },
        400
      );
    }

    const item = await this.findItem(req.itemPath);
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

    // A remote's two 400s (`remoteChoiceChecks`, shared with orchestrate), here because both need the item: its source and the machine's model/effort
    // lists. Home keeps its `pickFrom` drop untouched.
    if (!m.home) this.remoteChoiceChecks(m, item.source === 'github', item.projectPath, req.model, req.effort);

    // Offered NOW and the project's path on that machine asked again (`remoteLaunchPath`, shared with orchestrate) — uncoded 409s, with the 502 left to
    // the gate below for the one case with an upstream to blame.
    const remotePath = m.home ? undefined : await this.remoteLaunchPath(item.projectPath, m);

    // Home: `dispatchBlock` against home's status, exactly as before. A remote: the same gate (`projectDispatchGate`, which `dispatchBlock` is a one-line
    // delegate to) against THAT machine's status and THAT machine's path — never `dispatchBlock(item, …)`, whose `item.projectPath` is this machine's
    // path, which a remote dashboard's project list never holds. Its status is read under the 5 s every remote read gets, and its ceiling clamps the
    // spawn below, so a stricter remote is never widened by home's. `remoteStatusOf`, so a project list that fails between the offer and here is the 502
    // "unreachable" below, not a 409 saying Pro has never seen the project (final-review I1).
    const status = m.home ? await this.status() : await this.dashboardStatus.remoteStatusOf(m.cfg, REMOTE_BUDGET);
    const blocked = m.home ? dispatchBlock(item, status) : remoteGateBlock(status, remotePath as string);
    if (blocked !== null) {
      // 502 only when the feature is on and we genuinely failed to reach the
      // dashboard — the one case with an upstream to blame. BM_AGENTS off is
      // a local configuration state, not a gateway failure: nothing was ever
      // contacted, so there is no gateway to be bad. That case and "answered
      // and said no" both get 409 — a state the reader can go and change.
      throw new HttpException({ error: blocked }, status.enabled && !status.reachable ? 502 : 409);
    }
    // Right after the gate, from the same read: home's dashboard has stopped offering the desktop app since the sheet's plan was read (the app was removed,
    // or the dashboard rolled back). Uncoded 409, a state the reader changes by picking Dashboard — the dashboard's own 501 would say the same, later.
    if (req.surface === 'desktop' && status.desktopAvailable !== true) {
      throw new HttpException({ error: "the desktop app is not available on this machine's dashboard — launch on Dashboard instead" }, 409);
    }

    // The in-review block (spec decision 9), re-checked for the reason the run claim below is: the sheet's plan was read once, and execute in `pr` mode
    // may have labelled the issue since. Uncoded 409, the run-claim refusal's status — a fact about this item a person can go and resolve (merge or
    // close the PR, or `backlog.mjs review <id> off`), with no upstream to blame.
    const inReview = inReviewBlock(item);
    if (inReview !== null) throw new HttpException({ error: inReview }, 409);

    // The unvetted block (#341), re-checked for the same reason: an outsider may have edited the body since the sheet's plan was read, which un-pins it.
    // Same uncoded 409 — a person resolves it by grooming the item, whose `body` write pins it. Between in-review and plan-review, the ladder's order.
    const unvetted = unvettedBlock(item);
    if (unvetted !== null) throw new HttpException({ error: unvetted }, 409);

    // The plan-review block (backlog-tick), re-checked for the same reason: a tick may have written a plan and marked the item since the sheet's plan was read.
    // Same uncoded 409 — a person resolves it by removing the label (or the `plan-review:` line) once they have read the plan. After in-review, the ladder's order.
    const planReview = planReviewBlock(item);
    if (planReview !== null) throw new HttpException({ error: planReview }, 409);

    // The run-claim block, re-checked here rather than trusted from `plan()`.
    // This is the layer that actually holds: LaunchSheet fetches its plan once
    // on mount, so a sheet left open while a run claims the item still shows an
    // enabled launch button, and only this call sees the run as it is at click
    // time. Same reasoning as the orchestrate lock's own re-check below —
    // "every other path capable of triggering a write re-checks it".
    //
    // 409 and no `code`: `RUN_IN_PROGRESS_CODE` (one of the app's two 409
    // codes, beside #268's `RESUME_LOCKED_CODE`) means "a run for this
    // project is alive right now" (see its doc comment
    // in shared/types.ts for the incident that rule exists to prevent a repeat
    // of, and for why no site here counts where it appears). This refusal is a
    // different fact — a run has CLAIMED this item — and nothing needs to tell
    // it apart from dispatch's other 409s programmatically. Deliberately
    // not 502 either — an orchestrator run is local state, with no upstream to
    // blame for it.
    //
    // bug-21: both halves of the one call, for the reason `plan` above gives
    // — this is the layer that actually stops a double execution, so it is
    // the one gate of the four that must not be blind for the window before
    // `init` writes the run file.
    const { runs, starting } = this.orchestrator.runs();
    const claimed = runClaimBlock(item, runs, starting);
    if (claimed !== null) {
      throw new HttpException({ error: claimed }, 409);
    }

    // #17 — after the run-claim check (a reader told a run holds the item learns more than "sync is off"), before anything spawns. Uncoded 409, the
    // sentence `syncOffBlock`'s: the session this would start writes through the item routes, and every one of them refuses while the repo is off.
    const syncOff = this.poller.syncOffBlock(item.projectPath);
    if (syncOff !== null) throw new HttpException({ error: syncOff }, 409);

    // #227 — the item-claim block, re-checked here for a tracker item the way `runClaimBlock` is above, and for the same reason: the sheet's plan was
    // read once, and the claim moves under it. The client's `progressBlock` is the offer; this is the refusal that holds. A files item is not re-checked
    // — its `started:` stamp has no heartbeat to age and no holder to name, and the file's own claim is `start`'s to refuse (see the tracker-dispatch
    // suite's note on why plan() still offers).
    const holder = item.source === 'github' ? item.holder : undefined;
    if (holder !== undefined) {
      const refusal = await itemClaimBlock(item.id, holder, this.dispatches.get(holder.session) !== null);
      if (refusal !== null) throw new HttpException({ error: refusal }, 409);
    }

    // A remote launch of this item that has not claimed it yet — on ANY machine, home included. Until that session's first claim lands nothing on the
    // tracker says the item is taken, so every claim check above waves a second launch through onto the same issue; this is the one record that it is
    // not free. Uncoded 409, the claim refusals' status. In a home-only setup nothing ever marks it, so home's path is unchanged.
    // `claimsOn` lets the block see a landing the board's runs read has not swept yet — a remote groom that claimed and released since (final-review I2).
    const startingOn = this.remoteStarting.itemBlock(item.projectPath, item.id, Date.now(), (p, id) => this.remoteRuns.claimsOn(p, id));
    if (startingOn !== null) throw new HttpException({ error: `${item.id} is already starting on ${startingOn.machine}` }, 409);

    // Proved last of the checks, and always asked of git — `main` included (`proveBaseBranch`, which says why `resolveBase`'s `'main'` carve-out is wrong
    // here). `item.projectPath` is the registry's own path for the project, resolved from the item, never from the body — and it is THIS machine's clone
    // for a remote launch too (the plan's "Base proof" decision): the server never fetches, and the PR the remote opens targets the shared repo's branch.
    const base = finish === 'pr' ? await proveBaseBranch(req.base, item.projectPath) : '';

    const spawned = await this.launchInProject(item.projectPath, {
      // An execute's or groom's body is the sheet's text as sent and the clause follows it, built from `finish`, the proved `base` and the two validated
      // booleans alone — see composePrompt's note on why the clause is not in the editable body. A groom body from a tab that predates the move still ends
      // in `COMMIT_RULE`, so one trailing copy is stripped first: the in-place clause puts the same bytes back, and a PR finish does not end up with a
      // "do not push" the clause then contradicts. An execute is NOT stripped — its existing "doubled, harmless" case stays. Capture keeps its
      // `COMMIT_RULE` inside the text and goes out unchanged.
      prompt: appendFinishClause(prompt, action, finish, base, { autoMerge: req.autoMerge, fix: req.fix }),
      name: sessionName(item),
      permissionMode: req.permissionMode,
      maxPermission: status.spawnMaxPermission,
      model: req.model,
      effort: req.effort,
      remoteControl: req.remoteControl,
      machine: m,
      remotePath,
      surface: req.surface
    });
    // A desktop launch ends here. It has no session id — the app mints its own — so there is nothing to remember: abort and the holder claim key on the id
    // a dispatch record stores, and the session is the app's to stop. And it is home-only (above), so there is no remote starting entry to mark.
    if (spawned.surface === 'desktop') return spawned;
    // #225 — remembered, because this id is the one the spawned session claims its issue under (`claude -p --session-id`), and without it nothing on
    // the board can later tell "the board started the session holding this claim" from "somebody at a terminal did". Only after a spawn that came
    // back with an id: a refused spawn started nothing to remember.
    // `machine` is which dashboard holds the session — `home` for this machine's — so Stop & release can be sent where the session actually runs.
    this.dispatches.record(spawned.sessionId, { projectPath: item.projectPath, itemPath: item.path, action, machine: m.id, at: Date.now() });
    // Marked only after the spawn came back with an id, as `StartingRunsService` is: a refused spawn started nothing to wait for. Remote only — a home
    // session is this machine's, and its claim is visible to the gates above the moment it lands. Never for a capture (final-review I2): it files a NEW
    // item and never claims this one, so nothing could retire the entry but age, and the card would read "Starting on" for the full RUN_STALE_MS. The
    // floor is the newest claim already on the issue, so only a claim this launch's session writes retires the entry (see `RemoteStartingService`).
    if (!m.home && action !== 'capture') {
      this.remoteStarting.markItem(item.projectPath, item.id, m, this.remoteRuns.claimFloor(item.projectPath, item.id), Date.now());
    }
    return spawned;
  }

  /**
   * The tail every one-session launch shares: the project path → the dashboard's dirName, the permission mode clamped to the ceiling, model and effort
   * picked off the mirrored lists, and the spawn itself. Extracted from `dispatch()` unchanged (Jira phase 5) so `POST /api/agents/dispatch-jira` launches
   * through exactly the same rules — `agents-dispatch.test.ts`, untouched, is the proof the extraction moved nothing. Every check that decides WHETHER to
   * launch stays with the caller; this only decides HOW.
   *
   * `maxPermission` is the caller's `status().spawnMaxPermission`, passed in rather than re-read: each caller has just read the status for its own gate,
   * and a second read here would be a second `/api/health` call per launch, and a ceiling that could differ from the one the gate was judged against.
   *
   * Multi-dashboard task 5: `machine` + `remotePath` send the launch to a REMOTE dashboard — its `cfg` (url and token), its dirName for the project's path
   * on THAT machine, and its own model/effort lists. Absent, or home, is today's path line for line: home's config read the way it always was, this
   * project's own path, `pickFrom` over the mirrored lists — which is what keeps a home spawn byte-identical (Review Focus 1). The body's keys are built in
   * one literal for both, in the same order, so the two can never drift into differently shaped requests. The caller has already 400'd a remote model or
   * effort outside the machine's lists, so `pickFrom` against those lists only ever keeps a pick or fills the default here.
   */
  async spawnInProject(projectPath: string, opts: LaunchOpts): Promise<AgentDispatchResult> {
    return headless(await this.launchInProject(projectPath, opts));
  }

  /**
   * `spawnInProject` with a `surface`: item dispatch's call, the one launch that may open in the desktop app and so the one caller that must handle an
   * answer with no session id. `surface` is put on the spawn body exactly as it came — absent stays absent, so a launch from a sheet that drew no control
   * is byte-identical to one from before it existed. On `desktop` the dashboard ignores name, model, effort, permission mode and remote control; they are
   * still sent, because the dashboard is the one that decides what a desktop launch reads, and an old client's fields must not break it.
   */
  async launchInProject(projectPath: string, opts: LaunchOpts & { surface?: LaunchSurface }): Promise<ItemDispatchResult> {
    const remote = opts.machine !== undefined && !opts.machine.home ? opts.machine : null;
    const cfg = remote === null ? readAgentsConfig() : remote.cfg;
    const map = remote === null ? await this.dashboardStatus.projectMap(cfg) : await this.dashboardStatus.projectMap(cfg, REMOTE_BUDGET.managementMs);
    // A remote with no path is refused below like an unseen one — never sent this machine's path, which names nothing on that disk.
    const path = remote === null ? projectPath : opts.remotePath;
    const dirName = path === undefined ? undefined : map.get(path);
    if (dirName === undefined) {
      // The caller's gate already covers this from the same map, so reaching
      // here means the cache expired between the two reads. Refuse rather than
      // guess a dirName from the path — deriving one would route around the
      // dashboard's membership check, which is the one thing it asks of us.
      throw new HttpException({ error: 'the dashboard cannot see this project' }, 409);
    }

    return this.launch(cfg, {
      project: dirName,
      prompt: opts.prompt,
      name: opts.name,
      permissionMode: clampMode(opts.permissionMode, opts.maxPermission),
      // Undefined for "default" and for any name this build does not know,
      // and `JSON.stringify` drops an undefined value outright — so the key
      // never reaches the dashboard and its argv carries no `--model` /
      // `--effort`. Validated here rather than trusted because the sheet is
      // not the only possible caller; the dashboard would drop a bad value
      // too, but that is its check, not ours.
      model: remote === null ? (pickFrom(opts.model, MODELS) ?? DEFAULT_MODEL) : (pickFrom(opts.model, remote.models) ?? remoteDefaultModel(remote)),
      effort: pickFrom(opts.effort, remote === null ? EFFORTS : remote.efforts),
      // Strictly `=== true`, matching the dashboard's own parse rule for this
      // field: anything else means off.
      remoteControl: opts.remoteControl === true,
      ...(opts.surface === undefined ? {} : { surface: opts.surface })
    });
  }

  /**
   * The board's whole-project cousin of dispatch: same shape, guarded the
   * same way, one extra gate, and no item at all — this acts on a project's
   * whole groomed queue rather than one file, so there is nothing here to
   * call findItem/deriveAction on. See ORCHESTRATE_PROMPT for why the prompt
   * is a constant rather than a request field.
   *
   * Multi-dashboard task 6 — `req.machine` aims the drain at a remote machine. Returns the resolved machine beside the result because the run's
   * spawn-success side effects live in the controller (`watchdog.arm()`, `starting.mark()` for home; `remoteStarting.markProject` for a remote — see that
   * route's comment for why there), and the controller must act on the machine THIS call judged, not on a second resolution of the body that a settings
   * edit in between could answer differently.
   */
  async orchestrate(req: AgentOrchestrateRequest): Promise<{ result: AgentDispatchResult; machine: Machine }> {
    // The machine first, through dispatch's own `resolveMachine` (multi-dashboard task 5) and for the same reason: every rule below depends on it. Absent and `home` in any
    // case are this machine, and from here on a home body walks exactly the path it walked before this field existed, to a byte-identical spawn — the
    // `m.home` branches below are the whole of the difference, and each one's home arm is the line that stood there before.
    const m = this.resolveMachine(req.machine);

    // A remote drain always ends in a PR (spec, Goals) — the remote's merge would land on a clone this machine never sees, and a branch would leave work
    // nobody here is shown. An absent or empty `mergeMode` IS `pr` there; any other value is refused rather than overridden, because the Orchestrate
    // sheet locks its picker to PR for a remote, so a body that disagrees came from somewhere that expects a merge or a branch and would be surprised.
    if (!m.home && req.mergeMode !== undefined && req.mergeMode !== '' && req.mergeMode !== 'pr') {
      throw new HttpException({ error: `merge mode must be pr on ${m.label}` }, 400);
    }

    // A remote's two 400s and its offer, in dispatch's order and through dispatch's own helpers, so the sheet and the card refuse in the same words.
    let remotePath: string | undefined;
    if (!m.home) {
      this.remoteChoiceChecks(m, this.items.sourceOf(req.project) === 'github', req.project, req.model, req.effort);
      remotePath = await this.remoteLaunchPath(req.project, m);
    }

    // Home's status as before; a remote's read under the 5 s every remote read gets. Its `enabled` is home's own flag (`DashboardsService` copies it into
    // every machine's config), so the 404 below means the same thing on either. `remoteStatusOf`, as dispatch reads it: a remote's failed project list
    // is unreachable (the 502 below), never "does not list" (final-review I1).
    const status = m.home ? await this.status() : await this.dashboardStatus.remoteStatusOf(m.cfg, REMOTE_BUDGET);
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

    // The other four dispatchGate conditions — the three remaining
    // environment-level blockers (dashboard unreachable, no CLAUDE_BIN,
    // remote answers off) plus project visibility — now share ONE
    // implementation with dispatchGate itself: `projectDispatchGate`
    // (shared/agent.ts), which dispatchGate delegates to for an item's own
    // project path and which this method now calls directly with
    // `req.project` in place of an item it does not have. Hoisted in Task
    // 13's fix round 1 after a review found this method's project-visibility
    // line (below, before the hoist) and the board's own toolbar gate had
    // each hand-duplicated the exact same reason string dispatchGate
    // produces — three copies of one rule, the identical drift class
    // `environmentBlock`'s own doc comment already tells the story of one
    // level down (an earlier version of THIS method reimplemented only the
    // project-visibility line and silently dropped the other four — see
    // that comment for the full incident). `status.enabled` is already
    // known true at this point (the block above returns otherwise), so
    // `projectDispatchGate`'s own first check (via environmentBlock) can
    // never produce `hidden` for THAT specific reason here — only its other
    // three environment reasons, or `disabled` for project visibility, can.
    //
    // A remote is asked about the project's path ON that machine (task 5's `remoteGateBlock` does the same for dispatch): `req.project` is this
    // machine's path, which a remote dashboard's project list never holds.
    const gate = projectDispatchGate(status, m.home ? req.project : (remotePath as string));
    if (gate.control === 'hidden') {
      // Same split dispatch() makes for the identical situation via
      // dispatchBlock: 502 only when there is a genuine upstream to blame
      // (unreachable — we never got as far as asking the dashboard
      // anything); every other environment block is a state the reader can
      // go and change on the dashboard's own side, so 409.
      throw new HttpException({ error: gate.reason }, !status.reachable ? 502 : 409);
    }
    if (gate.control === 'disabled') {
      // Still the same raw string compare against `status.projectPaths`,
      // deliberately not realpath, and deliberately not a dirName derived
      // from the path to route around the dashboard's own membership check
      // — see the "A project the dashboard cannot see cannot be dispatched
      // to" invariant in CLAUDE.md, which this exists to uphold a second
      // time for a route dispatchGate itself never sees. `gate.reason` is
      // `projectDispatchGate`'s own wording, identical to what this line
      // built by hand before the hoist.
      throw new HttpException({ error: gate.reason }, 409);
    }

    /* task-46's `orchestrating a tracker project arrives in phase 4` refusal
       stood here, and task-47 is phase 4a: it is gone, and so is the client's
       half of it (`projectIsFiles`). What replaced it is not a looser gate but
       a different one, and it lives in `resolveIds` below — which now proves
       an id against `ItemsService` for a tracker project where it scans files
       for a files one, and normalises every accepted id to BARE DIGITS before
       the prompt is composed. Nothing named `#` reaches the prompt. */

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
    //
    // bug-21 widened this from `.runs` to both halves of the one call. The
    // check above is blind for the 1–5 minutes before `init` writes anything
    // — while THIS SAME PROCESS holds the record proving a run is on its way
    // — so a second click returned 200 and spawned a second session; both
    // booted, and whichever reached `init` second exited `4` (lock held) and
    // died, having burned a session and told its user "never retry, go to
    // `--resume`" for a run that never crashed.
    //
    // Multi-dashboard task 6 — home only. Both of these records are THIS machine's: a local run.json and a local starting entry say nothing about a
    // remote's clone, so a local run does not block a remote drain, and the remote's own pair (`remoteOrchestrateLocks`) does not block a local one.
    if (m.home) this.homeOrchestrateLocks(req.project);
    else this.remoteOrchestrateLocks(req.project, m);

    // #17 — after both run-in-progress locks, before the spawn. A drain on a repo whose sync is off would park at its first claim.
    const syncOff = this.poller.syncOffBlock(req.project);
    if (syncOff !== null) throw new HttpException({ error: syncOff }, 409);

    // Home's config and map exactly as before; a remote's from its own settings entry, read under the management budget, and looked up by the path the
    // offer resolved on that machine.
    const cfg = m.home ? readAgentsConfig() : m.cfg;
    const map = m.home ? await this.dashboardStatus.projectMap(cfg) : await this.dashboardStatus.projectMap(cfg, REMOTE_BUDGET.managementMs);
    const dirName = map.get(m.home ? req.project : (remotePath as string));
    if (dirName === undefined) {
      // Same race dispatch()'s identical line guards against: the membership
      // check above and this lookup read the same cache, and only a TTL
      // expiry between the two reads reaches here. Refuse rather than derive
      // a dirName from the path, for the reason named above.
      throw new HttpException({ error: 'the dashboard cannot see this project' }, 409);
    }
    return { result: await this.spawnOrchestrate(req, m, status, cfg, dirName), machine: m };
  }

  /** `orchestrate`'s two home locks, unchanged since bug-21 — extracted only so the remote's pair can sit beside them under one `m.home` branch. */
  private homeOrchestrateLocks(project: string): void {
    const { runs, starting } = this.orchestrator.runs();
    const activeRun = runs.find((r) => r.project === project && r.fresh);
    if (activeRun) {
      throw new HttpException(
        {
          error: `a run is already in progress for this project (${activeRun.runId})`,
          // Fix round 2: this endpoint throws several distinct 409s sharing
          // one HTTP status, so a client cannot tell which one happened from
          // the status code alone — and must never guess from this `error`
          // string's prose either (RUN_IN_PROGRESS_CODE's own doc comment,
          // shared/types.ts, has the full incident that rule exists to
          // prevent a repeat of). `code` is that stable, machine-readable
          // answer.
          //
          // Deliberately no tally of those reasons here, and no list of
          // which refusals carry the code. This line used to carry both, and
          // bug-21 falsified both at a stroke by adding a lock below and
          // giving it this SAME code. A hand-maintained count of a list that
          // lives elsewhere is the drift class CLAUDE.md's origin-guard
          // invariant already records going stale once inside a single
          // branch — so the count is gone rather than incremented, and the
          // one place that describes where this code appears is the
          // constant's own doc comment.
          //
          // What IS load-bearing here, and what a reader has to be able to
          // trust: the code marks "a run for this project is alive right
          // now", which is what this `activeRun` lock and the starting lock
          // immediately below — the same lock one window earlier — each
          // mean. Every other throw in this method means something else and
          // is deliberately left uncoded; nothing about those needs
          // distinguishing by machine, and OrchestrateSheet's own retry path
          // (client/src/hooks/useOrchestrateDraft.ts) is exactly
          // right for them as-is.
          code: RUN_IN_PROGRESS_CODE
        },
        409
      );
    }

    /* The same lock, one window earlier (bug-21). Beside the `activeRun`
       throw and therefore still BEFORE `resolveIds`, for the reason that
       ordering comment gives: a stale tab whose selection has since been
       archived must be told a run is in progress, not that `task-3` is not
       open.

       The SAME `code`, deliberately, not a second one. It is the same lock
       the case above enforces, and `OrchestrateSheet` branches on that code
       to `refresh()` + `onClose()` — exactly the right behaviour here, since
       the sheet closes and hands the screen to the board's run chip, which is
       already counting the starting entry. `RUN_IN_PROGRESS_CODE` stays this route's only coded
       409 — this is a second OCCASION for it, not a second code — and the
       comment on the throw above says so from its side too, since a reader
       who lands there first must not be told a second coded 409 on this
       route is a mistake.

       No `runId` to name, which is the one way this refusal reads
       differently from the one above: a starting entry has a project and a
       requestedAt and nothing else — there is no runId until `init` mints
       one. That is also why the block it produces everywhere else is
       project-wide rather than per-item (see `runClaimBlock`). */
    if (starting.some((s) => s.project === project)) {
      throw new HttpException({ error: 'a run is already starting for this project', code: RUN_IN_PROGRESS_CODE }, 409);
    }
  }

  /**
   * A launch body's `machine`, resolved — dispatch's and orchestrate's one copy (multi-dashboard tasks 5–6), so the card and the sheet refuse in the same
   * words. Absent and `home` in any case are this machine; a remote is found by its name in the settings file as read for THIS request. Anything else — a
   * name edited away since the sheet opened, or a non-string the controller forwarded unvalidated — is a 400, never a quiet fallback to home, which would
   * run the work on a machine the reader did not pick.
   */
  private resolveMachine(raw: unknown): Machine {
    const m = raw === undefined || typeof raw === 'string' ? this.dashboards.machine(raw) : null;
    if (m === null) throw new HttpException({ error: `unknown machine "${String(raw)}"` }, 400);
    return m;
  }

  /**
   * A remote launch's two 400s, shared by dispatch and orchestrate. A files project cannot run remotely at all (the remote session writes its items
   * through the remote's own backlog-manager, which only a tracker project has); a model or effort outside the machine's list is a 400 where home's
   * `pickFrom` drops, because the remote dashboard would drop an unknown name just as silently and the session would then run on that account's default
   * with no error anywhere (spec, "Models and efforts are per machine"). `tracker` is the caller's own reading of the source — the item's for dispatch,
   * the project's for orchestrate — because each has a different thing in hand. Never called for home.
   */
  private remoteChoiceChecks(m: Machine, tracker: boolean, projectPath: string, model: unknown, effort: unknown): void {
    if (!tracker) throw new HttpException({ error: filesBackedReason(m.label, projectPath) }, 400);
    const choice = machineChoiceBlock(m, model, effort);
    if (choice !== null) throw new HttpException({ error: choice }, 400);
  }

  /**
   * The project's path on remote `m`, or the uncoded 409 `<label> is not offered for <project>: <reason>` — dispatch's and orchestrate's one copy. Offered
   * NOW, not when the picker drew: the offers are minutes old by the time Start is clicked, and a remote that has since gone down, lost the repo or had its
   * sync turned off is refused with the same reason the picker would now show. Then the path ON that machine, asked again rather than lifted from the
   * offer, so the gate and the spawn after it judge the path that is true at this moment. 409, a state a reader can go and change; the 502 is left to the
   * caller's gate for the one case with an upstream to blame.
   */
  private async remoteLaunchPath(projectPath: string, m: Machine): Promise<string> {
    const notOffered = (reason: string): HttpException => new HttpException({ error: `${m.label} is not offered for ${projectPath}: ${reason}` }, 409);
    const offer = (await this.offers.offers(projectPath)).machines.find((o) => o.machine === m.id);
    if (offer === undefined) throw notOffered('no longer configured');
    if (offer.reason !== null) throw notOffered(offer.reason);
    const there = await this.offers.remotePath(projectPath, m);
    if ('reason' in there) throw notOffered(there.reason);
    return there.path;
  }

  /**
   * A remote orchestrate's two locks — the same pair home has, one window apart, read from the records that describe THAT machine. Both uncoded:
   * `RUN_IN_PROGRESS_CODE` tells OrchestrateSheet to close and hand the screen to the board's run chip, which counts home's runs, so a remote refusal
   * carrying it would close the sheet onto a chip that shows nothing.
   *
   * 1. Starting on that machine — keyed (project, machine), so a drain starting on Pro blocks a second one to Pro and nothing else. Until the remote's
   *    first claim lands no other record says a run is coming, which is the bug-21 gap one machine over.
   * 2. Live on that machine — a remote run of this project whose host is the machine's own. `status === 'running'`, fresh or not: `orchestrate.mjs init`
   *    on that machine refuses any `running` run file, crashed included, so a spawn here would only boot a session that dies at `init`. A run on
   *    another host, or one whose claims carry no host, is not this machine's and does not block.
   */
  private remoteOrchestrateLocks(project: string, m: Machine): void {
    if (this.remoteStarting.projectBlock(project, m.id, Date.now()) !== null) {
      throw new HttpException({ error: `${project} is already starting on ${m.label}` }, 409);
    }
    const live = this.remoteRuns.list().find((r) => r.project === project && r.host === m.host && r.status === 'running');
    if (live !== undefined) throw new HttpException({ error: `a run of ${live.repo} is live on ${m.label}` }, 409);
  }

  /** `orchestrate`'s tail: what the run should contain, then the spawn. Split off with the locks above, its body otherwise as it stood. */
  private async spawnOrchestrate(req: AgentOrchestrateRequest, m: Machine, status: AgentsStatus, cfg: AgentsConfig, dirName: string): Promise<AgentDispatchResult> {
    // Last, deliberately: every gate above answers a question about whether
    // this project can be orchestrated at all, and this one answers what the
    // run should contain. Ordering matters for the two locks above — they are
    // the refusals this endpoint CODES, and OrchestrateSheet branches on that
    // code to close itself and hand the screen to the board's run chip. A stale
    // board tab whose selection has since
    // been archived must still be told "a run is already in progress", not
    // "task-3 is not open"; validating ids first would answer the second and
    // leave the sheet sitting on a project that is already mid-run. The same
    // reasoning is why `resolveMergeMode` is called here too, after the
    // lock, rather than up with the other gates — a malformed `mergeMode`
    // is a problem with what the run should contain, not whether it may
    // start at all, and case 8 of the design's server-validation table
    // (task-4-brief.md) pins the lock winning over it, same as it wins over
    // an ids problem.
    const ids = await this.orchestrateArgs.resolveIds(req.project, req.ids);
    // A remote's is always `pr` — the 400 at the top of `orchestrate` already refused any other value — so it appends `--merge-mode pr`.
    const mergeMode = m.home ? this.orchestrateArgs.resolveMergeMode(req.mergeMode, req.project) : 'pr';
    // Beside resolveMergeMode, after the lock, for the identical reason the
    // comment directly above gives: a malformed `questionMode` is a problem
    // with what the run should contain, not with whether it may start, so
    // the coded RUN_IN_PROGRESS_CODE 409 must still win over it.
    const questionMode = this.orchestrateArgs.resolveQuestionMode(req.questionMode);
    // Beside the other two resolvers and after the lock, for the identical
    // reason both comments above give: a base naming no branch is a problem
    // with what the run should contain, not with whether it may start, so the
    // coded RUN_IN_PROGRESS_CODE 409 must still win over it.
    const base = await this.orchestrateArgs.resolveBase(req.base, req.project);

    return this.spawn(cfg, {
      project: dirName,
      // The composition, and the whole of what a caller can influence: a
      // bare constant for a full-queue, merge-mode, main-based run, that same
      // constant followed by ids that have each been proved to name an open
      // bug or task in THIS project, and then up to three flags (the first of them one of two merge-mode literals), each
      // appended only off its own guard and each default appending nothing.
      // Nothing a caller sends is ever concatenated in unchecked — see
      // resolveIds, resolveMergeMode, resolveBase, and ORCHESTRATE_PROMPT's
      // own comment for why a `prompt` field remains unreadable rather than
      // merely validated.
      //
      // Ids first, every flag after: `orchestrate.mjs`'s own argv parsing
      // reads bare tokens as ids and each `--flag` as taking an argument, so
      // a flag ahead of the ids would swallow the first id as its value.
      prompt: [
        ORCHESTRATE_PROMPT,
        ...(ids === undefined ? [] : ids),
        // Two guarded literals, never one interpolation: `mergeMode` is the
        // `MergeMode` union here, but a template over it would be the one
        // place a future member (or a widened type) could reach the prompt
        // unreviewed. `merge` appends nothing — the default.
        ...(mergeMode === 'branch' ? ['--merge-mode', 'branch'] : []),
        ...(mergeMode === 'pr' ? ['--merge-mode', 'pr'] : []),
        // Last of the three, and `park` appends nothing at all — which is
        // what keeps every prompt this endpoint composed before task-19 a
        // byte-exact PREFIX of what it composes now. The silent value is
        // inverted from merge mode's (`merge` there, `park` here) because
        // both follow the same rule: whichever value is the default appends
        // nothing. As with `--merge-mode`, the appended text is two
        // compile-time literals selected by a guard, so no caller-supplied
        // character reaches the prompt through this channel either.
        ...(questionMode === 'decide' ? ['--question-mode', 'decide'] : []),
        // The third and last, and the ONE place caller-supplied text reaches
        // this prompt. `resolveBase` has already proved it is a legal ref
        // name AND an existing local branch in this project, which is why it
        // can be appended at all; `'main'` appends nothing, so a request
        // written before this field existed composes the byte-identical
        // prompt it composed then. See resolveBase's doc comment for why
        // proving is the rule here where its two neighbours merely clamp.
        ...(base === 'main' ? [] : ['--base', base])
      ].join(' '),
      // Unlike dispatch, which names a session after the one item it is
      // working (sessionName, prompt.util.ts), there is no item here to
      // build that name from — orchestrateSessionName below is that
      // function's counterpart for a whole project. Without a name at all,
      // every orchestrate run's dashboard row reads exactly like a session
      // started by hand at a terminal, which is a real usability problem
      // for a feature whose entire purpose is watching a run that is
      // actually happening.
      name: orchestrateSessionName(req.project),
      // Defaulted here, before clampMode, rather than inside it: an ABSENT
      // field and an UNRECOGNISED one deserve opposite answers, and clampMode
      // cannot tell them apart once both have become the same string. Its
      // floor-on-unknown rule is right and stays as it is — a mode nobody
      // recognises cannot be placed on the ladder — but "the caller expressed
      // no preference" is not a nonsensical request, and flooring it to `plan`
      // starts a run that cannot write a file, create a worktree, commit or
      // merge, answers 201, and then reports nothing about why nothing
      // happened. Only `undefined` and `''` count as absent — `''` because
      // that is what a "no pick" select submits everywhere else in this app
      // (see pickFrom). Anything else, including the non-string the
      // controller's Partial type cannot rule out, is a caller asking for
      // something this build does not recognise, so it goes to clampMode
      // untouched and floors there exactly as it does today.
      //
      // `auto` and not the ceiling — the same trade plan() spells out for a
      // dispatched session (see its `defaultMode`): a session that stops on
      // the first tool call it cannot self-approve does nothing, while asking
      // for the most a host allows is how a convenience becomes an incident.
      // The ceiling still clamps this down on a stricter dashboard, so this
      // can never widen what a host permits.
      permissionMode: clampMode(req.permissionMode === undefined || req.permissionMode === '' ? 'auto' : req.permissionMode, status.spawnMaxPermission),
      // A remote picks off its own lists, already proved by `machineChoiceBlock`, and defaults the way `spawnInProject` does for a remote dispatch.
      model: m.home ? (pickFrom(req.model, MODELS) ?? DEFAULT_MODEL) : (pickFrom(req.model, m.models) ?? remoteDefaultModel(m)),
      effort: pickFrom(req.effort, m.home ? EFFORTS : m.efforts)
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
   * Resume a crashed run through the exact same spawn path `orchestrate()`
   * uses — `POST /api/agents/resume`'s whole implementation, and the
   * sweeper's own recovery action (design §2.2 step 5, a later task) once it
   * exists. Two callers, `origin: 'board'` and `origin: 'watchdog'`, sharing
   * one method rather than each composing its own spawn call — see
   * `resumeSessionName` below for the one place that distinction actually
   * shows up (the dashboard row's name).
   *
   * Mirrors `orchestrate()` step for step and SHARES its gate code rather
   * than re-deriving it — `status()` for the environment kill switch,
   * `projectDispatchGate` for everything else the environment or the
   * project's own visibility can refuse. This is not a style preference: an
   * earlier version of `orchestrate()` reimplemented one line of
   * `projectDispatchGate`'s five-line ladder by hand and silently dropped
   * the other four (see `environmentBlock`'s own doc comment, shared/agent.ts,
   * for the full incident — an unreachable dashboard read as "cannot see
   * this project", and a dashboard with no `CLAUDE_BIN` or remote answers
   * off let a spawn through that should have been refused first). Writing a
   * second, resume-flavoured copy of that ladder here would be the same
   * mistake with a different name attached to it — so this method calls the
   * shared function and repeats none of its strings.
   *
   * The one place this method is DELIBERATELY STRICTER than `orchestrate()`,
   * and in the opposite direction: `orchestrate()`'s own activeRun lock
   * refuses to start a new run while an existing one is FRESH, because two
   * runs racing for the same project is the failure that check exists to
   * prevent. `resume()` exists for the opposite premise — a run has gone
   * SILENT — so it refuses unless the run it finds is STALE. A future
   * reader tempted to "align" these two checks so they read the same way
   * would be erasing the actual distinction between the two endpoints: one
   * guards against starting a run that already exists, the other exists
   * only because one has stopped heartbeating.
   */
  async resume(project: string, origin: 'watchdog' | 'board'): Promise<AgentDispatchResult> {
    const status = await this.status();
    if (!status.enabled) {
      // Same 404 orchestrate() answers for the same condition, and the same
      // reason: the board's own control for this feature is either rendered
      // or it is not (see the "environment-level block hides the dispatch
      // control" invariant), so "this feature is not on" is the honest
      // answer for a route that, as far as this caller is concerned, is not
      // here at all.
      throw new HttpException({ error: 'not found' }, 404);
    }

    // The remaining four environmentBlock reasons, plus project visibility —
    // see this method's own doc comment above for why this is a call, not a
    // hand-written copy of projectDispatchGate's ladder.
    const gate = projectDispatchGate(status, project);
    if (gate.control === 'hidden') {
      // Same split orchestrate() makes for the identical situation: 502 only
      // when there is a genuine upstream to blame (unreachable), every
      // other environment block is a state the reader can go and fix on the
      // dashboard's own side, so 409.
      throw new HttpException({ error: gate.reason }, !status.reachable ? 502 : 409);
    }
    if (gate.control === 'disabled') {
      throw new HttpException({ error: gate.reason }, 409);
    }

    // The run this project actually has, if any — read fresh, the same
    // "never cache a run file" posture OrchestratorService.runs() itself
    // takes, since a run this stale might be resumed by the very call this
    // method is about to make.
    const run = this.orchestrator.runs().runs.find((r) => r.project === project);
    if (run === undefined || (run.status !== 'running' && run.status !== 'paused')) {
      // Both "no run has ever existed for this project" and "the last run
      // already finished (done/aborted/failed)" collapse to the identical
      // uncoded 409: neither has anything a resume spawn could act on, and
      // telling them apart would tell the caller nothing it could do
      // differently — reopen the board, there is nothing here to recover.
      //
      // task-17 widened this to admit `paused`, the one status a run can
      // still leave. A paused run is the FIRST resumable shape that is not a
      // recovery: nothing went wrong, a person stopped it. The fresh-run
      // refusal below deliberately does not apply to it — a paused run is
      // never fresh (its heartbeat stopped when it finished), so it falls
      // through to the spawn without a second condition being needed.
      throw new HttpException({ error: 'no crashed or paused run to resume for this project' }, 409);
    }
    // bug-39 — a stop and a resume are opposite instructions about one run,
    // and the stop is the one a person made most recently by construction:
    // the control file has to post-date the run's own start for the field to
    // read `true` at all. Refused here as well as suppressed in the board's
    // controls, because the sweeper is not the only caller — a stale tab, a
    // hand-rolled request, or the Watchdog page in another window can all
    // still reach this method with the control gone from their own render.
    //
    // UNCODED, and not `RUN_IN_PROGRESS_CODE` for the same reason the resume
    // lock below is not: that code means "a run is alive right now", which
    // both callers treat as a silent success. This one needs a person to read it
    // — a stopped run is over, and its work is a new run's — so it must not
    // be swallowed.
    if (run.stopRequested) {
      throw new HttpException(
        {
          error:
            `run ${run.runId} has a stop request on file — nothing resumes a stopped run. ` +
            'Let it end, and start a new run for the work that is left.'
        },
        409
      );
    }
    if (run.fresh) {
      // `run.fresh` is the one and only freshness number this app computes
      // (OrchestratorService.runs(), against RUN_STALE_MS) — not a second
      // threshold minted here, so this check can never drift from what the
      // strip itself is already showing as "still going."
      //
      // RUN_IN_PROGRESS_CODE is reused here rather than minting a resume-
      // specific code, on purpose: this 409 states the same fact every other
      // sender of that code states — "a run is alive for this project, right
      // now" — just reached from a different direction (this caller tried to
      // RESUME one; `orchestrate()`'s two locks refuse callers trying to
      // START one). Two codes for one fact is precisely the drift
      // RUN_IN_PROGRESS_CODE's own doc comment (shared/types.ts) exists to
      // rule out, and every caller already treats the code identically —
      // "the run recovered on its own, nothing to do here" — so there is
      // nothing for a second code to distinguish even if one existed.
      throw new HttpException(
        {
          error: `run ${run.runId} is alive (last heartbeat ${run.updatedAt}) — nothing to resume`,
          code: RUN_IN_PROGRESS_CODE
        },
        409
      );
    }

    // #17 (plan amendment 2) — `POST /api/trackers/sync` refuses `off` under a paused or running run, but a hand-edited settings file can still turn the
    // repo off, and a resumed driver's first act is to re-claim through the item routes, which refuse. Refused here, after the alive check and before the
    // resume lock below, so a refused resume consumes no lock and spawns nothing — the watchdog reads it as a refusal like any other.
    const syncOff = this.poller.syncOffBlock(project);
    if (syncOff !== null) throw new HttpException({ error: syncOff }, 409);

    // bug-19 — the resume LOCK, and the one refusal in this method that is
    // taken rather than merely decided.
    //
    // Everything above this line is a check: `run.fresh` refuses a run that
    // is still alive, and nothing refused a SECOND resume of a crashed one.
    // That is not a hole a further check could close, because the fact being
    // checked does not change fast enough: a resumed session takes ~90s to
    // reach its first `heartbeat`, so for that whole window every arriving
    // call re-reads the identical stale run file and every one spawns. Three
    // sessions inside ten seconds is what it looked like on
    // run-20260905-113818, and they were harmless only because a spend limit
    // killed all three ~600ms in.
    //
    // Three properties, none of them optional:
    //
    // **Synchronous.** The check and the stamp sit in one run of the event
    // loop, before the next `await` below — a lock taken after an await is
    // not a lock, it is a check every concurrent caller passes. That is
    // precisely what `noteBoardResume` (called from the controller, after
    // `await this.agents.resume(...)` returns) could never fix from where it
    // stands, and why the fix lives here rather than beside it.
    //
    // **On the shared path.** Both origins funnel through this method — the
    // board's click and the sweeper's own `spawn()` — so the sweeper obeys
    // the same lock a person does without a second expression of it
    // anywhere. What the sweeper does with the refusal is its own business
    // (no `failed` line, neither counter moved, grace re-stamped — #268): a
    // refused spawn started no session, and this refusal says one is already
    // on its way, so it is "not yet" rather than a failure.
    //
    // **`RUN_STALE_MS`, not a new number.** The question is "is a resume
    // session believed to be alive in this run", and this app computes
    // liveness exactly once. A resumed session that has not heartbeated in
    // fifteen minutes is dead by the app's own definition, and a second
    // resume is then the right answer.
    //
    // Not `RUN_IN_PROGRESS_CODE`, unlike the `run.fresh` refusal just above:
    // that code means "a run is alive for this project, right now", which is
    // false here — the run is crashed (or paused) and a resume is on its way
    // to it. Both of this endpoint's callers treat that code as a silent
    // success ("the run recovered under this very click"), which is exactly
    // the wrong reaction to being told to wait. It carries its own code,
    // `RESUME_LOCKED_CODE` (#268), because the watchdog has to tell "wait"
    // apart from "refused": its grace is shorter than this lock, so its own
    // retry lands here, and counting that as a refusal stood runs down after
    // one real attempt. The board reads no code here and shows the sentence.
    const entry = this.watchdogState.upsert(run.runId, run.project);
    const now = Date.now();
    // `entry.project === run.project` as well as the stamp: entries are keyed
    // by `runId` alone, and a runId is a timestamp to the second
    // (`run-YYYYMMDD-HHMMSS`), so two projects whose runs started in the same
    // second share one entry. That collision has always mis-attributed the
    // sweeper's bookkeeping; without this clause it would newly refuse a
    // perfectly legitimate resume of the OTHER project for up to RUN_STALE_MS,
    // which is a collision upgraded from a wrong number into a wrong answer.
    if (entry.project === run.project && entry.resumeSpawnAt !== null && now - Date.parse(entry.resumeSpawnAt) < RUN_STALE_MS) {
      const ageSec = Math.round((now - Date.parse(entry.resumeSpawnAt)) / 1000);
      throw new HttpException(
        {
          error:
            `a resume for run ${run.runId} was already started ${ageSec}s ago — a resumed session takes about ` +
            'ninety seconds to reach its first heartbeat, so this run will keep reading crashed for a while yet. ' +
            'Two --resume sessions on one run.json both stage-write and both end in a merge to main.',
          code: RESUME_LOCKED_CODE
        },
        409
      );
    }
    const stamp = new Date(now).toISOString();
    entry.resumeSpawnAt = stamp;

    try {
      return await this.spawnResume(readAgentsConfig(), project, run, origin, status);
    } catch (e) {
      // Cleared, not kept: a spawn that threw started no session, and holding
      // the lock through a dashboard that was briefly down would silence the
      // board's only resume control for a full RUN_STALE_MS. Only OUR stamp is
      // cleared — a later caller that took the lock in the meantime (possible
      // once this method has awaited) owns a live session this one knows
      // nothing about. This is the same success-versus-attempt split the
      // watchdog's own cap already makes; grace covers the failure case and is
      // untouched.
      if (entry.resumeSpawnAt === stamp) entry.resumeSpawnAt = null;
      throw e;
    }
  }

  /**
   * The second half of `resume()` — everything from the dashboard lookup to
   * the spawn, split out for one reason only: it is the whole of what the
   * resume lock above wraps in a `try`, and inlining it would put a
   * forty-line `try` block around code whose own error handling is already
   * three deep.
   */
  private async spawnResume(
    cfg: AgentsConfig,
    project: string,
    run: { runId: string; status: string },
    origin: 'watchdog' | 'board',
    status: AgentsStatus
  ): Promise<AgentDispatchResult> {
    const dirName = (await this.dashboardStatus.projectMap(cfg)).get(project);
    if (dirName === undefined) {
      // The same TTL-race guard orchestrate() and dispatch() both carry:
      // projectDispatchGate's visibility check and this lookup read the same
      // cache, and only a TTL expiry between the two reads reaches here.
      // Refuse rather than derive a dirName from the path — see the "cannot
      // be dispatched to" invariant this exists to uphold a second time.
      throw new HttpException({ error: 'the dashboard cannot see this project' }, 409);
    }

    const result = await this.spawn(cfg, {
      project: dirName,
      // The whole of what a caller — board or sweeper alike — can ever make
      // this session do. See RESUME_PROMPT's own comment for why there is
      // nothing here to validate: unlike orchestrate's ids/mergeMode, no
      // field of the request body ever reaches this string.
      prompt: RESUME_PROMPT,
      name: resumeSessionName(project, origin),
      // 'auto', clamped to the ceiling — the identical trade orchestrate()
      // and plan() both document for an unattended session: asking for the
      // most a host allows is how a convenience becomes an incident, and a
      // session that stops on the first tool call it cannot self-approve
      // does nothing at all. No model/effort/remoteControl: a resume is not
      // a new choice about how to run the queue, it is the SAME run picking
      // up where its own heartbeat stopped, so there is no new preference to
      // express here.
      permissionMode: clampMode('auto', status.spawnMaxPermission)
    });

    // task-17. Two conditions, and the STATUS one is the load-bearing half:
    //
    // **Only for a `paused` run.** A crashed run's request has never been
    // seen by anything — the run died before reaching a dispatch gate, and
    // the watchdog that resumes it does not read this file at all (design
    // §4.4). The resumed session is what honours it, at its first gate, by
    // exiting `6`. Clearing it here for a crashed run would delete a request
    // that is still fully effective and that nobody has acted on, and the
    // resumed session would then drain the whole queue against an explicit
    // pause somebody asked for — the exact outcome this feature exists to
    // prevent, reached through the automation that is on by default. §4.3's
    // own "tidiness, not correctness" argument holds ONLY for the paused
    // case, because that is the only one where an `unpause` is coming to
    // retire the request anyway: a crashed run's resumed session takes
    // `recovery.md`'s `running` path, which heartbeats and never unpauses,
    // so nothing else would ever retire it.
    //
    // **After the spawn, never before it.** A spawn that threw leaves the
    // request in place, which is what keeps the board drawing the run as
    // paused for a resume that never started.
    //
    // For the paused case it is genuinely tidiness: `unpause` retires the
    // request by moving `unpausedAt` past its `requestedAt`, on both sides
    // of the predicate. Clearing it here only stops `status` and the board
    // reporting a pause that is already being undone, in the minute or two
    // before that session gets there. Swallowed, therefore: a failure to
    // delete a file must not turn a successful resume into an error the
    // caller sees, when the thing that matters has already happened.
    if (run.status === 'paused') {
      try {
        clearPauseRequest(project);
      } catch {
        /* see above — the unpause is the real retirement */
      }
    }
    return result;
  }

  /**
   * `POST /api/agents/pause` (task-17) — record that the board wants this
   * project's run to stop at its next item boundary, or withdraw that
   * request.
   *
   * The one POST in this file that never calls the dashboard, and the one
   * that is deliberately INDEPENDENT of `BM_AGENTS`. Both follow from what a
   * pause actually is: a fact written to this machine's own disk about a run
   * that is already going. There is no session to spawn, so there is nothing
   * `BM_AGENTS` could be gating — and gating it anyway would mean a run
   * started while agents were on could never be stopped after somebody
   * turned them off, which is the exact moment a person is most likely to
   * want to stop it.
   *
   * It lives here rather than under `/api/orchestrator/` for the reason
   * `watchdog/config` does: that controller is documented as a READ-ONLY
   * view of the run-state directory, and this route writes. `agents/` is
   * where the guarded, state-changing routes live, and `SameOriginPostGuard`
   * is already wired across all of them — a write reachable by a
   * cross-origin form post is exactly what that guard exists to prevent.
   *
   * Synchronous by nature: nothing here awaits a third process.
   *
   * The returned `pauseRequested` is RE-DERIVED from what landed on disk
   * rather than echoed back from the request — a confirmation, not an
   * acknowledgement. It is the same predicate the runs payload uses, so a
   * request the predicate would refuse for any reason answers `false` here
   * rather than claiming a pause the run will never see.
   */
  pause(project: string, cancel: boolean): PauseResult {
    // Read fresh, the same never-cache-a-run-file posture `resume()` above
    // takes: the runId this request gets pinned to has to be the run that is
    // actually going right now, not one this process saw a minute ago.
    const run = this.orchestrator.runs().runs.find((r) => r.project === project);
    if (run === undefined || run.status !== 'running') {
      // `running` only, fresh or stale alike — pausing a run whose heartbeat
      // has stopped is exactly what a person watching a crashed-looking strip
      // wants, and that run may still be minutes into a `claude -p` child.
      // Every other status is refused with one uncoded message, for the same
      // reason `resume()` collapses its own two cases: nothing the caller
      // could do differently distinguishes them. A run that is already
      // `paused` is refused here too — there is nothing left to ask it.
      throw new HttpException({ error: 'no running run to pause for this project' }, 409);
    }

    if (cancel) {
      clearPauseRequest(project);
    } else {
      writePauseRequest(project, run.runId);
    }
    return { pauseRequested: pauseRequestEffective(readPauseRequest(project), run) };
  }

  /**
   * `POST /api/agents/stop` (bug-39) — record that a person ENDED this run,
   * and then try to end it.
   *
   * **Two outcomes, and only the first is guaranteed.** Writing the control
   * file is the fact; spawning `--abort` is an attempt at the consequence. A
   * gate refusal or a spawn failure is therefore NOT an error status here:
   * the request is already on disk, the sweeper is already standing down on
   * it, and `abort` will already take the lease on the strength of it — so
   * the honest answer is a 200 saying what did and did not happen, plus the
   * one command a person can run instead. Returning a 5xx would tell a
   * caller the stop did not land when the half that matters did.
   *
   * It is `pause()`'s sibling in every other respect but one — the gate admits
   * a `running` run, fresh or stale alike (a stale one is the case this whole
   * bug is about), AND a `paused` one (#305), which pause has nothing to ask
   * of. Same independence from `BM_AGENTS`: recording the
   * fact must work on a machine whose launcher is off, and the spawn half
   * simply does not happen there. What it does NOT share is the `cancel`
   * direction (bug-53): a stop has already happened by the time this method
   * returns, so there is nothing to withdraw, and the controller refuses
   * `cancel: true` before this method is reached.
   *
   * **Why this is not `pause` with a flag.** A pause is read at two dispatch
   * gates and deliberately cannot strand half-finished work; a stop refuses
   * every transition and is allowed to abandon a worktree, because a person
   * decided the run should end rather than finish its item. Widening pause
   * would make every pause do the second thing. Two keys, one file.
   */
  async stop(project: string): Promise<StopResult> {
    // Read fresh, the same posture `pause()` takes and for the same reason:
    // the runId this request is pinned to has to be the run going right now.
    const run = this.orchestrator.runs().runs.find((r) => r.project === project);
    if (run === undefined || (run.status !== 'running' && run.status !== 'paused')) {
      // `running`, fresh or stale alike — a stale `running` run is exactly the
      // shape bug-39 was filed about (a killed driver leaves one for fifteen
      // minutes), so `fresh` is deliberately not part of the gate.
      //
      // `paused` too (#305). Its driver has exited, but the run has not
      // ended: it still holds claims, `orchestrator:queued` labels on the
      // entries it never reached, and any parked worktrees — exactly what an
      // abort clears. Refusing it left two exits, Resume-then-Stop (a driver
      // session spent only to tear the run down) or a hand-typed `--abort`.
      // The stop written here is also the fence against the paused run's own
      // Resume: `resume()` refuses on it below, `RunControls` drops Resume on
      // `stopRequested`, and `orchestrate.mjs unpause` refuses it too — the
      // one that matters, because an unpause stamps `unpausedAt` past the
      // stop's `requestedAt` and would silently cancel it.
      //
      // Every other status is refused with one uncoded message: a run that is
      // `done`, `aborted` or `failed` has already ended.
      throw new HttpException({ error: 'no running or paused run to stop for this project' }, 409);
    }

    writePauseRequest(project, run.runId, new Date(), controlHome(), 'stop');
    // RE-DERIVED from what landed on disk, never echoed back from the
    // request — the confirmation-not-acknowledgement rule `pause()` follows.
    const stopRequested = stopRequestEffective(readPauseRequest(project), run);

    // AFTER the stop is on file, so a sweep that fails — or throws past its own
    // guard — can never cost the stop itself; BEFORE the abort spawns, so the
    // label stops advertising the plan within this request rather than when
    // that session gets round to its own sweep.
    const unqueueFailed = await this.unqueue(project, run);

    const { abortSession, abortRefused } = await this.spawnAbort(project);
    return { stopRequested, abortSession, abortRefused, ...(unqueueFailed.length > 0 ? { unqueueFailed } : {}) };
  }

  /**
   * The stop's server-side queue sweep (the orchestrator:queued spec, §3.1):
   * take `orchestrator:queued` off every queue item the run never claimed, and
   * answer the ids whose removal was refused.
   *
   * **Why the server does it, and not only the driver.** The driver reads a
   * stop only at its dispatch gates, so a stop pressed at the start of a long
   * execute session would leave the queue labelled for that whole session —
   * and a dead driver reads nothing at all. The server holds the token and the
   * run file's queue, so it can answer "the plan is off" within one request.
   * The spawned `--abort` repeats the sweep, which is what makes a partial
   * failure here a warning rather than a fault.
   *
   * **Never-claimed is `claim === undefined`.** An item with a claim has had
   * its label swapped for `in-progress` by the claim itself (§3.3), and one
   * that is being worked right now is not this sweep's to write to.
   *
   * **Through the item writer, never `GithubClient`.** The per-item lock and
   * the refusal mapping live in the source, and a second route to GitHub from
   * this module would be a second copy of both. A `files` project has no writer
   * and no label, so it returns before anything is asked.
   *
   * Sequential, not parallel: every removal lands on its own item's chain
   * anyway, and one request at a time is the kinder shape against a rate limit
   * this sweep may be the thing that hits. A refusal and a thrown error are the
   * same answer — the id goes on the list and the next item is still tried.
   */
  private async unqueue(project: string, run: OrchestratorRun): Promise<string[]> {
    const lookup = this.items.writerFor(project);
    if (lookup.kind !== 'writer') return [];

    const failed: string[] = [];
    for (const entry of run.queue) {
      if (entry.claim !== undefined) continue;
      try {
        const outcome = await lookup.writer.queue(lookup.project, lookup.marker, { project, id: entry.id, queued: false });
        if (!outcome.ok) failed.push(entry.id);
      } catch {
        failed.push(entry.id);
      }
    }
    return failed;
  }

  /**
   * The spawn half of `stop()` — split out because every failure in it is a
   * VALUE this route returns rather than an exception it propagates, and a
   * method whose whole body is one `try` reads worse than one that is.
   *
   * The gate is `resume()`'s, called rather than re-derived, for the reason
   * `resume()`'s own doc comment gives at length: an earlier hand-written
   * copy of `projectDispatchGate`'s ladder dropped four of its five rungs.
   * The difference is only in what a refusal DOES — there, a status; here, a
   * sentence in the body.
   */
  private async spawnAbort(project: string): Promise<{ abortSession: string | null; abortRefused: string | null }> {
    try {
      const status = await this.status();
      if (!status.enabled) {
        // Not an error, and not silence either: a machine with agents off can
        // still record a stop, and the person who asked deserves to be told
        // that the run will not be ended for them here.
        return { abortSession: null, abortRefused: 'agents are off on this machine — run `/backlog-orchestrate --abort` at the project root to end the run' };
      }
      const gate = projectDispatchGate(status, project);
      if (gate.control !== 'enabled') {
        return { abortSession: null, abortRefused: `${gate.reason} — run \`/backlog-orchestrate --abort\` at the project root to end the run` };
      }

      const cfg = readAgentsConfig();
      const dirName = (await this.dashboardStatus.projectMap(cfg)).get(project);
      if (dirName === undefined) {
        // The same TTL-race guard every other spawn path carries — never
        // derive a dirName from the path to route around it.
        return { abortSession: null, abortRefused: 'the dashboard cannot see this project — run `/backlog-orchestrate --abort` at the project root to end the run' };
      }

      const result = await this.spawn(cfg, {
        project: dirName,
        prompt: STOP_PROMPT,
        name: stopSessionName(project),
        // 'auto', clamped — the same trade every unattended session in this
        // file makes. An abort removes worktrees and branches, so a session
        // that cannot self-approve its own git calls would do nothing at all.
        permissionMode: clampMode('auto', status.spawnMaxPermission)
      });
      return { abortSession: result.sessionId, abortRefused: null };
    } catch (e) {
      // Every throw from the three awaits above lands here — an unreachable
      // dashboard, a refused spawn, a malformed answer. The control file is
      // already written, so this is information about the second outcome and
      // never a reason to fail the first.
      const message = e instanceof HttpException ? String((e.getResponse() as { error?: unknown }).error ?? e.message) : e instanceof Error ? e.message : String(e);
      return { abortSession: null, abortRefused: `${message} — run \`/backlog-orchestrate --abort\` at the project root to end the run` };
    }
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
    return headless(await this.launch(cfg, spawnBody));
  }

  /**
   * `spawn` with the dashboard's whole answer: a headless launch's id, or `{ surface: 'desktop' }` for a body that asked for the desktop app and was
   * answered that way. Only `launchInProject` calls it directly; every other launch goes through `spawn`, whose `headless` turns a desktop answer it never
   * asked for into the 502 a missing id always was.
   */
  private async launch(cfg: AgentsConfig, spawnBody: Record<string, unknown>): Promise<ItemDispatchResult> {
    const desktop = spawnBody.surface === 'desktop';
    // Only the call itself is inside the try — deliberately not the `json()`
    // read or the two `throw`s below it. Those already map their own failure
    // to a status this app chose, and pulling them in here would re-map their
    // `HttpException`s into a second, wronger one.
    //
    // Uncaught, this is bug-26: a connection reset or the 10s timeout escapes
    // spawn(), all three of its callers and a controller with no try/catch at
    // all, and — with no exception filter registered anywhere in server/src —
    // Nest answers a bare `{ statusCode: 500, message: 'Internal server
    // error' }`. That body carries no `error` key, so the client's `unwrap`
    // degrades it to `request failed (500)`: the one dashboard failure on this
    // route the reader was told nothing about, while every other one relays a
    // 502 naming the cause.
    let res: Response;
    try {
      res = await fetch(`${cfg.url}/api/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cfg) },
        body: JSON.stringify(spawnBody),
        signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS)
      });
    } catch (e) {
      // 502 for the reason the `!res.ok` branch below already gives: nothing
      // came back, so this is an upstream fault this app cannot vouch for.
      throw new HttpException({ error: dashboardError(e, 'the dashboard spawn call', SPAWN_TIMEOUT_MS) }, 502);
    }

    const body = (await res.json().catch(() => null)) as { sessionId?: unknown; surface?: unknown; error?: unknown } | null;
    if (!res.ok) {
      // Verbatim. The dashboard's rejections are short and specific ("too many
      // launches in flight", "unknown project: …"); paraphrasing them would
      // only lose the one detail the reader needs.
      const relayed = typeof body?.error === 'string' ? body.error : `spawn answered ${res.status}`;
      // A desktop launch's refusals are the one exception to "verbatim": the dashboard's are codes for its own form (`open failed`), and here would read
      // as the board's failure — `desktopSpawnError` says why, and relays anything it does not name unchanged.
      const error = desktop ? desktopSpawnError(res.status, relayed) : relayed;
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
    // Only a body that asked for the desktop app may come back without an id. A dashboard from before desktop launches ignores `surface` and answers a
    // bare `{ sessionId }` — a headless session really did start, so it is reported as one (and recorded by dispatch), not dressed up as a desktop launch.
    if (desktop && body?.surface === 'desktop' && typeof body.sessionId !== 'string') return { surface: 'desktop' };
    if (typeof body?.sessionId !== 'string') {
      throw new HttpException({ error: 'spawn returned no session id' }, 502);
    }
    return { sessionId: body.sessionId };
  }

  /**
   * The one item at this path, or null. The allowlist runs first and is the
   * same one GET /api/items/body uses — a path outside every registered
   * backlog/ is not an item here either.
   */
  /**
   * One item by the ref a request named — a filesystem path or, since task-46,
   * a `gh:<owner>/<repo>#<n>` URN.
   *
   * A delegate and nothing else. The lookup itself belongs to the item sources:
   * "resolve against the allowlist, then scan every project" is a statement
   * about ITEM FILES, and this module holding a private copy of it was exactly
   * why a tracker item had no dispatch. Now the REF'S SHAPE picks the adapter,
   * in `ItemsService.find`, which is the same one decision `/api/items/body`
   * already made — one home, two callers.
   */
  private async findItem(requestPath: string): Promise<BacklogItem | null> {
    return this.items.find(requestPath);
  }
}
