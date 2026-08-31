import type {
  AgentDispatchRequest, AgentDispatchResult, AgentPlan, AgentsStatus, OrchestratorRunsPayload, PermissionMode
} from '../../../shared/types';

/**
 * agents.ts — the board's five calls into its own API.
 *
 * Same-origin, every one of them: the dashboard's origin is server-side
 * configuration this page never learns, which is both why the bearer token
 * stays out of the browser and why `connect-src 'self'` in
 * server/src/security.ts needs no relaxing for this feature.
 */

/**
 * Unwraps the `{ error }` body the API answers failures with, so a caller can
 * render the server's own wording. The status is the fallback, not the message:
 * "409" tells a reader nothing, "this item's next step is groom" tells them
 * everything.
 */
async function unwrap<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as ({ error?: unknown } & T) | null;
  if (!res.ok) {
    const error = typeof data?.error === 'string' ? data.error : `request failed (${res.status})`;
    throw new Error(error);
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
    typeof data === 'object' && data !== null &&
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
  return unwrap<AgentPlan>(await fetch('/api/agents/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemPath })
  }));
}

export async function dispatchAgent(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
  return unwrap<AgentDispatchResult>(await fetch('/api/agents/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req)
  }));
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
 * state holds onto it. There is also no ErrorBoundary anywhere to fall back
 * on if some OTHER malformed field further downstream (Task 11's run strip,
 * say) throws instead: BoardView.tsx's own comment on this is that an
 * unguarded throw during render unmounts the whole tree to a blank page. So
 * `runs` itself is checked for the same reason `isAgentsStatus` checks
 * `projectPaths` (an unguarded `.some`/`.every` on a non-array throws before
 * any of this even matters), and every run's `fresh` is checked because that
 * is the one field this payload's first consumer actually branches on.
 */
function isOrchestratorRunsPayload(data: unknown): data is OrchestratorRunsPayload {
  return (
    typeof data === 'object' && data !== null &&
    Array.isArray((data as OrchestratorRunsPayload).runs) &&
    (data as OrchestratorRunsPayload).runs.every(
      (run) => typeof run === 'object' && run !== null && typeof (run as { fresh?: unknown }).fresh === 'boolean'
    )
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
 * Body of `POST /api/agents/orchestrate` (Task 9). Mirrors the server's own
 * `AgentOrchestrateRequest` (server/src/agents/agents.service.ts) field for
 * field, but is declared here rather than promoted into shared/types.ts
 * alongside `AgentDispatchRequest`: that file's own comment on the server
 * type defers promotion until "a second consumer needs it", and this
 * client-only declaration is exactly that second consumer without requiring
 * a change to the server side, which is out of scope for the task that added
 * this function. `permissionMode` is narrower here than the server's plain
 * `string`: the server is validating a body it cannot trust, but a caller
 * composing this request on the client already has the real `PermissionMode`
 * union in scope (see `AgentDispatchRequest` above), so there is no reason
 * to widen it back to `string` just to send it over the wire.
 */
export interface StartOrchestrateRequest {
  project: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
}

/**
 * The board's "drain the whole queue" call — one project, no item, no
 * caller-supplied prompt (the server drops one if sent; see
 * AgentsService.ORCHESTRATE_PROMPT). POST, not GET, for the same reason
 * `fetchAgentPlan` is: `project` is an absolute path on someone's disk, and
 * a query string puts it in history and in logs.
 */
export async function startOrchestrate(req: StartOrchestrateRequest): Promise<AgentDispatchResult> {
  return unwrap<AgentDispatchResult>(await fetch('/api/agents/orchestrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req)
  }));
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
