import type {
  AgentBranchesPayload,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentPlan,
  AgentsStatus,
  ExecuteFinish,
  ItemAbortResult,
  MergeCheckResult,
  OrchestratorArchivePayload,
  OrchestratorArchiveRun,
  OrchestratorRun,
  OrchestratorRunsPayload,
  PauseResult,
  StartOrchestrateRequest,
  StartingRun,
  StopResult,
  Unchecked,
  UncommittedItems,
  WatchdogConfig,
  WatchdogStatus
} from '../../../shared/types';
import { EFFORTS, MODELS } from '../../../shared/agent';
import { errorOf } from './http';
import { EXECUTE_FINISHES } from '../../../shared/types';

/**
 * agents.ts — the board's seven calls into its own API.
 *
 * Same-origin, every one of them: the dashboard's origin is server-side
 * configuration this page never learns, which is both why the bearer token
 * stays out of the browser and why `connect-src 'self'` in
 * server/src/security.ts needs no relaxing for this feature.
 */

/**
 * Thrown by `unwrap` on any non-2xx response. `message` is the server's own
 * `{ error }` wording (or the status-only fallback) exactly as before this
 * class existed — every caller that only ever reads `.message` (every one of
 * them until Task 13's fix round 1) sees identical behaviour, since
 * `instanceof Error` still holds and `Error`'s own `.message` is untouched.
 *
 * `status` is what fix round 1 added it FOR: OrchestrateSheet's "already
 * running" 409 used to be detected by matching a substring of the server's
 * free-text message, which is exactly the kind of check a later wording
 * change silently breaks without any test noticing (the regression test's
 * own fixture message is independent of the server's real literal, so it
 * could not have caught that drift either). The status code is the part of
 * the response that is actually part of the contract; the message is prose
 * for a human to read.
 *
 * `code` is fix round 2's addition, and it exists for a narrower reason than
 * `status`: `status === 409` alone turned out to be too coarse for
 * `POST /api/agents/orchestrate` specifically, which answers 409 for several
 * genuinely different reasons (RUN_IN_PROGRESS_CODE's own doc comment,
 * shared/types.ts, has the full story, and is deliberately the only place
 * that says anything about which refusals carry the code — a tally kept
 * anywhere else has gone stale every time one was added). `code` is
 * `undefined` for every response that carries no `{ code }` field at all,
 * which is nearly all of them, so a caller checking a SPECIFIC code rather
 * than merely its presence is what keeps this generic instead of growing
 * into a wider error taxonomy no other route asked for.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Unwraps the `{ error }` body the API answers failures with, so a caller can
 * render the server's own wording. The status is the fallback for the
 * MESSAGE, not the message itself: "409" tells a reader nothing, "this
 * item's next step is groom" tells them everything — but the status (and,
 * when the body carries one, a `code`) is still attached to the thrown
 * `ApiError` (see its own comment) for the one caller that needs to branch
 * on more than just what to display.
 *
 * Exported (tick breaker, `lib/ticks.ts`) so a second lib reads a refusal the same way rather than carrying a copy of this.
 */
export async function unwrap<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as ({ error?: unknown; code?: unknown } & T) | null;
  if (!res.ok) {
    const error = errorOf(data, `request failed (${res.status})`);
    const code = typeof data?.code === 'string' ? data.code : undefined;
    throw new ApiError(error, res.status, code);
  }
  return data as T;
}

/**
 * `unwrap`'s `return data as T` is a compile-time-only promise: it tells
 * TypeScript what shape to expect, but nothing checks that the bytes that
 * actually arrived match it. For every other caller here that promise is
 * cheap to keep — a malformed `AgentPlan` or dispatch result surfaces as a
 * downstream crash the moment a consumer reads a missing field, in the same
 * request/response round trip that produced it. `AgentsStatus` is different:
 * it is cached in `useAgents`' state and re-read by every card on the board,
 * so a bad shape does not fail once, it lies quietly to every consumer for as
 * long as that state sticks around. This is where the cast is made honest —
 * checking every field `dispatchBlock` (`shared/agent.ts`) actually
 * dereferences, in the order it dereferences them, so nothing downstream can
 * read `undefined` as false-y or throw on a missing `.projectPaths`.
 */
function isAgentsStatus(data: unknown): data is AgentsStatus {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as AgentsStatus).enabled === 'boolean' &&
    typeof (data as AgentsStatus).reachable === 'boolean' &&
    typeof (data as AgentsStatus).spawnAvailable === 'boolean' &&
    typeof (data as AgentsStatus).remoteAnswer === 'boolean' &&
    Array.isArray((data as AgentsStatus).projectPaths)
  );
}

export async function fetchAgentsStatus(): Promise<AgentsStatus> {
  const data = await unwrap<AgentsStatus>(await fetch('/api/agents/status'));
  // Thrown, not returned-anyway: `useAgents`' own `.catch` already maps a
  // failed fetch onto the disabled/unreachable status a real dashboard-off
  // answer would produce. Reusing that path here means a wrong-shaped 200
  // and an unreachable API collapse onto the same "no usable status" —
  // one fallback object, defined once, rather than a second copy of it here.
  if (!isAgentsStatus(data)) {
    throw new Error('malformed /api/agents/status response');
  }
  return data;
}

/** POST, not GET: the argument is an absolute path on someone's disk, and a
 *  query string puts it in history and in logs. */
export async function fetchAgentPlan(itemPath: string): Promise<AgentPlan> {
  return unwrap<AgentPlan>(
    await fetch('/api/agents/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemPath })
    })
  );
}

export async function dispatchAgent(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
  return unwrap<AgentDispatchResult>(
    await fetch('/api/agents/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req)
    })
  );
}

/**
 * Same reasoning as `isAgentsStatus` above, and the same "lies quietly"
 * profile it exists to rule out — a first pass at this function argued the
 * opposite (a missing `runs` array throws loudly, so why guard?) and that
 * argument undersold the actual risk: `useOrchestratorRuns` reads `run.fresh`
 * on every run in the array to decide whether to poll at all, and a `fresh`
 * that is present but the wrong type does not throw. `fresh: "true"` is
 * truthy, `fresh: 0` is falsy, `fresh: undefined` is falsy — every one of
 * those is silently read as a real answer to "is this run live", not an
 * error, and it would keep being read that way for as long as the hook's
 * state holds onto it. Nor is there a fine-grained ErrorBoundary to fall
 * back on if some OTHER malformed field further downstream (Task 11's run
 * strip, say) throws instead: the only one is section-wide (`SectionBoundary`,
 * #270), so an unguarded throw during render swaps the whole view for a
 * "failed to load" line, and BoardView.tsx's own comment on this explains
 * why a reload does not cure a throw that bad stored data causes. So
 * `runs` itself is checked for the same reason `isAgentsStatus` checks
 * `projectPaths` (an unguarded `.some`/`.every` on a non-array throws before
 * any of this even matters), and every run's `fresh` is checked because that
 * is the one field this payload's first consumer actually branches on.
 *
 * `starting` (task-14) is checked on exactly the same terms, with one
 * deliberate difference: ABSENT is accepted, present-but-wrong is not. Absent
 * is what an older server answers — one built before this field existed,
 * which a dev box can genuinely be serving while a newer client bundle is
 * open — and refusing that whole payload would blank the run strip over a
 * field that only ever ADDS a card; `useOrchestratorRuns` defaults it to `[]`
 * for precisely that case. Present-but-wrong is the "lies quietly" shape this
 * guard exists for: `BoardView` calls `.filter` on this array during render
 * and the board's run chip reads `project`/`requestedAt` straight out of each
 * entry, and an unguarded throw during render swaps the whole board for
 * `SectionBoundary`'s "failed to load" line (#270; it was a blank page before).
 */
function isStartingRuns(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (s) => typeof s === 'object' && s !== null && typeof (s as StartingRun).project === 'string' && typeof (s as StartingRun).requestedAt === 'string'
    )
  );
}

function isOrchestratorRunsPayload(data: unknown): data is OrchestratorRunsPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as OrchestratorRunsPayload).runs) &&
    (data as OrchestratorRunsPayload).runs.every((run) => typeof run === 'object' && run !== null && typeof (run as { fresh?: unknown }).fresh === 'boolean') &&
    isStartingRuns((data as Partial<OrchestratorRunsPayload>).starting)
  );
}

/** `GET /api/orchestrator/runs` (Task 8) — one entry per project with any run
 *  history, each already annotated with `fresh`/`pastRuns`. */
export async function fetchOrchestratorRuns(): Promise<OrchestratorRunsPayload> {
  const data = await unwrap<OrchestratorRunsPayload>(await fetch('/api/orchestrator/runs'));
  // Thrown, not returned-anyway, mirroring fetchAgentsStatus: a caller gets
  // a clean rejection rather than a payload that looks real until something
  // reads the wrong field out of it.
  if (!isOrchestratorRunsPayload(data)) {
    throw new Error('malformed /api/orchestrator/runs response');
  }
  return data;
}

/**
 * Same reasoning and the same "lies quietly" profile as `isOrchestratorRunsPayload`
 * above, applied to the archive listing (Task 1) instead of the live one:
 * `RunsView` (Task 6) holds this payload's `runs` array in hook state and
 * dereferences `runId`, `project`, `current`, and `queue` on every row it
 * renders — a row list, a project filter, and the "is this the live entry"
 * accent all read straight off those four fields. A wrong-shaped
 * `current` (say a string, or simply absent because a future server change
 * dropped it) would not throw on its own; it would just render every row as
 * neither current nor archived, or crash three renders later the first time
 * something maps over a `queue` that turned out not to be an array. Checking
 * those four here, once, at the one place a malformed response can still be
 * turned into a clean `throw` instead of a slow-motion downstream failure,
 * is the same trade `isOrchestratorRunsPayload` already makes for `fresh`.
 * `runs` itself still needs the `Array.isArray` guard first for the same
 * reason too: an unguarded `.every` on a non-array throws before any of this
 * even matters.
 */
function isOrchestratorArchivePayload(data: unknown): data is OrchestratorArchivePayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as OrchestratorArchivePayload).runs) &&
    (data as OrchestratorArchivePayload).runs.every(
      (run) =>
        typeof run === 'object' &&
        run !== null &&
        typeof (run as OrchestratorArchiveRun).runId === 'string' &&
        typeof (run as OrchestratorArchiveRun).project === 'string' &&
        typeof (run as OrchestratorArchiveRun).current === 'boolean' &&
        Array.isArray((run as OrchestratorArchiveRun).queue)
    )
  );
}

/** `GET /api/orchestrator/archive` (Task 1) — every run the orchestrator
 *  state directory has ever recorded, across every project, verification
 *  tails already stripped by the server. */
export async function fetchOrchestratorArchive(): Promise<OrchestratorArchivePayload> {
  const data = await unwrap<OrchestratorArchivePayload>(await fetch('/api/orchestrator/archive'));
  // Thrown, not returned-anyway, mirroring fetchOrchestratorRuns above: a
  // caller gets a clean rejection rather than a payload that looks real
  // until some row's render reads the wrong field out of it.
  if (!isOrchestratorArchivePayload(data)) {
    throw new Error('malformed /api/orchestrator/archive response');
  }
  return data;
}

/**
 * `GET /api/orchestrator/archive/run` (Task 2) — one archived run, verbatim,
 * tails included: the detail pane's one fetch, made only when a viewer
 * actually opens that run. Unlike `fetchOrchestratorArchive` above this
 * function carries no shape guard, and deliberately so — the response is
 * rendered exactly once, by the same pane that issued the fetch, in the same
 * round trip; there is no hook state for a malformed shape to lie quietly
 * inside of, so a downstream `undefined` read fails exactly where and when
 * it happened rather than needing to be pre-empted here. A 404 (unknown run,
 * unregistered project, a runId shaped like path traversal — every failure
 * mode the controller has collapses to the same 404, on purpose) already
 * arrives as an `ApiError` via `unwrap`, which is the one failure this
 * caller actually needs to branch on.
 *
 * GET, with `project`/`runId` as query params rather than a POST body: this
 * mirrors the server's own transport choice (there is no body on a GET to
 * put an absolute path in), not the POST-for-path-privacy pattern
 * `fetchAgentPlan`/`startOrchestrate` follow below — `project` already rides
 * unmodified in every `/api/orchestrator/archive` listing entry this call's
 * caller already has in hand, so putting it in a query string here discloses
 * nothing that response didn't already hand the client.
 */
export async function fetchArchivedRun(project: string, runId: string): Promise<OrchestratorRun> {
  return unwrap<OrchestratorRun>(await fetch(`/api/orchestrator/archive/run?project=${encodeURIComponent(project)}&runId=${encodeURIComponent(runId)}`));
}

/**
 * The board's "drain the whole queue" call — one project, no item, no
 * caller-supplied prompt (the server drops one if sent; see
 * AgentsService.ORCHESTRATE_PROMPT). POST, not GET, for the same reason
 * `fetchAgentPlan` is: `project` is an absolute path on someone's disk, and
 * a query string puts it in history and in logs.
 */
export async function startOrchestrate(req: StartOrchestrateRequest): Promise<AgentDispatchResult> {
  return unwrap<AgentDispatchResult>(
    await fetch('/api/agents/orchestrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req)
    })
  );
}

/**
 * "Stop this project's run at the next item boundary" — `POST
 * /api/agents/pause` (task-17). One field, matching a request that has
 * nothing else to carry: which run gets paused is decided server-side from
 * the project's own `run.json`, so there is no runId for a caller to send
 * (and therefore no way for a stale tab to pause a run that is not the one
 * it is looking at — the server pins the request to whatever is running when
 * it arrives).
 *
 * Two functions rather than one with a boolean, for the reason the call
 * sites make obvious: `pauseOrchestrate(p)` and `cancelPauseOrchestrate(p)`
 * cannot be turned into each other by a misread argument, and one of the two
 * directions throws away something a person asked for.
 */
export async function pauseOrchestrate(project: string): Promise<PauseResult> {
  return unwrap<PauseResult>(
    await fetch('/api/agents/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project })
    })
  );
}

/** The withdrawal half of `pauseOrchestrate` above — `cancel: true` is the
 *  only form the server honours (a string `'true'` is read as a pause), so
 *  it is a literal here rather than anything derived from a caller. */
export async function cancelPauseOrchestrate(project: string): Promise<PauseResult> {
  return unwrap<PauseResult>(
    await fetch('/api/agents/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, cancel: true })
    })
  );
}

/**
 * The Runs detail head's "Stop run" control (bug-39) — `POST
 * /api/agents/stop`. `pauseOrchestrate`'s sibling, and separate from it for
 * exactly the reason the pause/cancel pair is a pair of functions rather than
 * one with a flag: a stop and a pause are different requests with different
 * consequences, and neither may be reachable from the other by a misread
 * argument.
 *
 * The 200 body carries THREE facts, not one — the request landed, and
 * separately whether an `--abort` session was started for it. The caller
 * renders the second only when it is a refusal; see `StopResult`.
 *
 * It has no withdrawal half, unlike pause (bug-53): by the time this resolves
 * the `--abort` spawn has already been awaited, so there is nothing a
 * `cancel` could undo, and the route refuses one with a 409.
 */
export async function stopOrchestrate(project: string): Promise<StopResult> {
  return unwrap<StopResult>(
    await fetch('/api/agents/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project })
    })
  );
}

/**
 * The item modal's **Stop & release** / **Release claim** (#225) — `POST /api/items/abort`. Two fields: which claim, which session and whether the board
 * may release it are all the server's to decide, so the client sends nothing it could get wrong. Here rather than beside the item reads because this is
 * the board's same-origin POST layer, and `unwrap` turns a refusal into an `ApiError` carrying the server's own sentence.
 */
export async function abortClaim(project: string, id: string): Promise<ItemAbortResult> {
  return unwrap<ItemAbortResult>(
    await fetch('/api/items/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, id })
    })
  );
}

/**
 * The item modal's **Approve plan** (#367) — `POST /api/items/plan-review` with `planReview: false`, lifting the `plan-review` label a tick's groom put on a
 * TRACKER item. `abortClaim`'s shape and its reasons: the route, its guard and the GitHub write (with the cache re-read) are the server's, and `unwrap` turns
 * a refusal — a files project, a sync-off repo — into an `ApiError` carrying the server's own sentence. A files item never reaches this: the board writes no
 * item file, so its approval is a copied prompt (`planApprovePrompt`, `lib/plan-review.ts`).
 */
export async function approvePlan(project: string, id: string): Promise<{ id: string; planReview: boolean }> {
  return unwrap<{ id: string; planReview: boolean }>(
    await fetch('/api/items/plan-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, id, planReview: false })
    })
  );
}

/**
 * The strip's manual "Resume" button — `POST /api/agents/resume`, `origin:
 * 'board'` server-side (`AgentsService.resume()`). One field, matching the
 * request itself: there is no `prompt`/`ids`/`model` for a caller to send,
 * because `resume()` builds the whole spawn from a compile-time constant —
 * see `AgentsService.RESUME_PROMPT`'s own comment for why this request has
 * nothing to widen the way `StartOrchestrateRequest` (shared/types.ts) does.
 */
export async function resumeOrchestrate(project: string): Promise<AgentDispatchResult> {
  return unwrap<AgentDispatchResult>(
    await fetch('/api/agents/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project })
    })
  );
}

/**
 * The Model and Effort selects' options, `default` first. `''` is that option: it means no flag, so the CLI's own default stands. One home because three
 * launch sheets (the board's, the orchestrator's, Jira's) draw the same two pickers over the same two lists, and a list only one of them learned about
 * would be a pick the others cannot make.
 */
export const MODEL_OPTIONS: { value: string; label: string }[] = [{ value: '', label: 'default' }, ...MODELS.map((m) => ({ value: m, label: m }))];
export const EFFORT_OPTIONS: { value: string; label: string }[] = [{ value: '', label: 'default' }, ...EFFORTS.map((f) => ({ value: f, label: f }))];

/**
 * The execute Finish select's options — one home because Settings' `Execute finish` row and the board's launch sheet draw the same two choices, and the
 * row's label has to read as the control it seeds. A record over `ExecuteFinish`, so a third finish added to the union fails to compile here until it has
 * a label; the option order is `EXECUTE_FINISHES`', in-place first.
 */
const EXECUTE_FINISH_LABELS: Record<ExecuteFinish, string> = { 'in-place': 'In place', pr: 'PR' };
export const EXECUTE_FINISH_OPTIONS: { value: ExecuteFinish; label: string }[] = EXECUTE_FINISHES.map((f) => ({ value: f, label: EXECUTE_FINISH_LABELS[f] }));

/**
 * The model and effort a launch body carries, as spreadable fields: the key is ABSENT for the `default` option rather than present-and-empty, which is the
 * shape the server's `pickFrom` and the dashboard's own parser both read as "no flag".
 */
export function modelEffortFlags(model: string, effort: string): { model?: string; effort?: string } {
  return { ...(model === '' ? {} : { model }), ...(effort === '' ? {} : { effort }) };
}

/**
 * The dashboard's own deep link (`?session=<id>`, read by its
 * client/src/lib/deepLink.ts). Built here rather than server-side because the
 * base is per-device: the laptop reaches the dashboard on loopback, the phone
 * on a tailnet name.
 */
export function sessionUrl(linkBase: string, sessionId: string): string {
  return `${linkBase.replace(/\/+$/, '')}/?session=${encodeURIComponent(sessionId)}`;
}

/**
 * `GET /api/agents/merge-check` (Task 6) — a read-only guess at whether this
 * project's Claude Code settings already grant `git merge`, so the
 * orchestrate sheet can hint at the one-time setup that makes a `merge`-mode
 * run's last step reliable instead of a coin flip against the auto-mode
 * classifier (see the design doc's "Why this exists"). `project` rides in
 * the query string, not a POST body, mirroring the server's own transport
 * choice (`AgentsController.mergeCheck`'s own comment): unlike
 * `fetchAgentPlan`'s `itemPath`, this `project` is a path the client already
 * pulled out of `/api/projects` to build the board, so a query string
 * discloses nothing an access log couldn't already read off that response.
 *
 * Unlike every neighbour above, a rejection here is not this caller's
 * problem to turn into a rendered error — it is a missing HINT, not a
 * missing capability, and the one caller (useOrchestrateDraft's own read)
 * deliberately swallows a thrown `ApiError` into "show no hint" rather than
 * anything that could block or blemish a launch that otherwise works fine.
 *
 * Shape-guarded (review fix round 1), reversing this function's original
 * "read once, rendered once, nothing to lie inside of" reasoning — that
 * reasoning is true of a CACHE but not of a RENDER, and this response feeds
 * a render directly. `ModesStep`'s hint guard is
 * `!mergeCoverage.covered`, and `!` on a missing field is not "no answer",
 * it is `true`: any 200 whose body lacks `covered` — a wrong endpoint
 * answering the URL pattern, a future server refactor that renames the
 * field, or (as the reviewer reproduced) a test stub with a stale
 * catch-all shape — renders the hint as a confident, false STATEMENT OF
 * FACT that this project's settings lack a rule they may well have. That is
 * a worse failure than the network error the `.catch` below already
 * handles cleanly, not a better one, so it gets routed into the identical
 * path: `isMergeCheckResult` throws, and the caller's `useFetched` read
 * lands as `failed`, which renders as no coverage — a malformed 200 exactly
 * like a rejected request, which is the only value this hint is allowed to
 * ever assert an absence from.
 */
function isMergeCheckResult(data: unknown): data is MergeCheckResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as MergeCheckResult).covered === 'boolean' &&
    (typeof (data as MergeCheckResult).source === 'string' || (data as MergeCheckResult).source === null)
  );
}

/**
 * This project's local branch names, for the Orchestrate sheet's base picker
 * (task-44) — `GET /api/agents/branches`.
 *
 * A malformed payload resolves to an EMPTY list rather than throwing, which
 * is the opposite of `fetchMergeCheck` directly below and deliberate: a
 * merge-check result that lies changes what the sheet TELLS the user, while a
 * missing branch list only shortens a picker that always offers `'main'`
 * anyway. The sheet's own effect swallows the failure on the same reasoning —
 * a run onto `main` must never be blocked by a read that is only there to
 * offer alternatives to it.
 */
export async function fetchBranches(project: string): Promise<string[]> {
  const data = await unwrap<Unchecked<AgentBranchesPayload>>(await fetch(`/api/agents/branches?project=${encodeURIComponent(project)}`));
  const list = data.branches;
  if (!Array.isArray(list)) return [];
  return list.filter((b): b is string => typeof b === 'string' && b !== '');
}

export async function fetchMergeCheck(project: string): Promise<MergeCheckResult> {
  const data = await unwrap<MergeCheckResult>(await fetch(`/api/agents/merge-check?project=${encodeURIComponent(project)}`));
  // Thrown, not returned-anyway, mirroring fetchAgentsStatus /
  // fetchOrchestratorRuns above: a caller gets a clean rejection rather
  // than a payload that looks real until the render that reads `.covered`
  // off it lies.
  if (!isMergeCheckResult(data)) {
    throw new Error('malformed /api/agents/merge-check response');
  }
  return data;
}

/**
 * Shape-guarded for the identical reason `isMergeCheckResult` is, restated in
 * this field's terms: the answer feeds a render that asserts a FACT about
 * someone's repository, and a 200 whose body lacks `paths` — a wrong endpoint
 * answering the URL pattern, a future rename, or a test stub with a stale
 * catch-all shape — must read as "no answer", never as "nothing is
 * uncommitted". `known` cannot carry that load on its own: `undefined` is
 * falsy, so a malformed body would happen to suppress the chip today and
 * silently start asserting the opposite the day the guard is `known !== false`
 * instead. So the guard throws and the caller's `.catch` stays the single
 * place a missing answer is handled.
 *
 * `absent` (#235) is required the same way and never defaulted to `[]`: a
 * missing one read as "nothing is absent" would tell the sheet every flagged
 * row is stale — a statement of fact about someone's repository the server
 * never made.
 */
function isUncommittedItems(data: unknown): data is UncommittedItems {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as UncommittedItems).paths) &&
    (data as UncommittedItems).paths.every((p) => typeof p === 'string') &&
    Array.isArray((data as UncommittedItems).absent) &&
    (data as UncommittedItems).absent.every((p) => typeof p === 'string') &&
    typeof (data as UncommittedItems).known === 'boolean'
  );
}

/**
 * `GET /api/items/uncommitted` (task-32), whose body is `UncommittedItems` (shared/types.ts). The endpoint is not under `/api/agents`, and this module is
 * still the right home for the call: it is the board's same-origin fetch layer, it owns `unwrap`/`ApiError`, and it already holds this same sheet's other
 * on-open read.
 *
 * `base` is the sheet's picked base, sent on every call — `main` included —
 * for the reason the launch body sends it on every launch: the server treats
 * `main` as the default either way, and an always-present parameter is one
 * URL shape rather than two (#254).
 */
export async function fetchUncommitted(project: string, base: string): Promise<UncommittedItems> {
  const data = await unwrap<UncommittedItems>(
    await fetch(`/api/items/uncommitted?project=${encodeURIComponent(project)}&base=${encodeURIComponent(base)}`)
  );
  if (!isUncommittedItems(data)) {
    throw new Error('malformed /api/items/uncommitted response');
  }
  return data;
}

/**
 * Same "lies quietly" reasoning as `isAgentsStatus`/`isOrchestratorRunsPayload`
 * above, applied to `WatchdogStatus` (Task 5): it lands in `useWatchdog`'s
 * own hook state, kept live across a mount, every window focus, and a poll
 * while armed, and is read from there by the Settings group's State row,
 * its four config controls, and its Activity feed — a wrong-shaped `phase`
 * or `config` would not throw on its own, it would just render a nonsense
 * state (an unrecognised phase string reads as neither off, idle, nor
 * armed to anything downstream that switches on it) for as long as that
 * hook state sticks around, exactly the profile `isOrchestratorRunsPayload`'s
 * own comment describes for `fresh`. Checked at the field level `useWatchdog`
 * and the Settings group actually dereference — `phase` against its closed
 * three-value union, `config`'s four fields by type, `watching`/`events` as
 * arrays — not a deep validation of every event's own shape, which no
 * caller here branches on beyond "is this an array to map over".
 */
function isWatchdogStatus(data: unknown): data is WatchdogStatus {
  if (typeof data !== 'object' || data === null) return false;
  const s = data as WatchdogStatus;
  return (
    (s.phase === 'off' || s.phase === 'idle' || s.phase === 'armed') &&
    Array.isArray(s.watching) &&
    Array.isArray(s.events) &&
    typeof s.config === 'object' &&
    s.config !== null &&
    typeof s.config.enabled === 'boolean' &&
    typeof s.config.tickMs === 'number' &&
    typeof s.config.graceMs === 'number' &&
    typeof s.config.maxAttempts === 'number'
  );
}

/** `GET /api/agents/watchdog` (Task 5) — the sweeper's whole state in one
 *  call: phase/reason, `nextTickAt`, the effective (post-clamp) config,
 *  which runIds it is watching, and its own event history. Read-only,
 *  unguarded on the server side (like `fetchAgentsStatus`'s own route), so
 *  this is a plain GET with no body to compose. */
export async function fetchWatchdog(): Promise<WatchdogStatus> {
  const data = await unwrap<WatchdogStatus>(await fetch('/api/agents/watchdog'));
  // Thrown, not returned-anyway, mirroring every other shape-guarded fetch
  // above: a caller gets a clean rejection rather than a payload that looks
  // real until the Settings group's own render reads the wrong field off it.
  if (!isWatchdogStatus(data)) {
    throw new Error('malformed /api/agents/watchdog response');
  }
  return data;
}

/**
 * `POST /api/agents/watchdog/config` (Task 5) — the Settings group's one
 * write path. `patch` rides the body verbatim: the server is the one place
 * that rebuilds it field by field and drops an unknown key (the same
 * `model`/`effort` posture `dispatchAgent`'s own request already trusts the
 * server to enforce rather than re-validating client-side), so there is
 * nothing for this function to filter before sending — every caller here
 * (`useWatchdog.save`) already composes `patch` from the Settings form's own
 * typed controls, which cannot produce a field this type doesn't have.
 */
export async function updateWatchdogConfig(patch: Partial<WatchdogConfig>): Promise<WatchdogStatus> {
  const data = await unwrap<WatchdogStatus>(
    await fetch('/api/agents/watchdog/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    })
  );
  if (!isWatchdogStatus(data)) {
    throw new Error('malformed /api/agents/watchdog/config response');
  }
  return data;
}
