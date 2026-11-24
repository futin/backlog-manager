import { HttpException } from '@nestjs/common';

import { authHeaders, dashboardError, readAgentsConfig, type AgentsConfig } from './config.util';
import { CLAIM_STALE_MS } from '../../../shared/types';
import type { DashboardRow, SubagentDetail, SubagentJob } from '../../../shared/types';

/*
 * dashboard-sessions.util.ts — the dashboard's `/api/sessions` read, and the two claim refusals built on it: `staleClaimProbe` (#227) and `itemClaimBlock`,
 * which ends in it. Read by `AgentsService.dispatch` (the item-claim refusal), `ItemsAbortService` (#225's case B and the stale probe) and
 * `JiraLiveReconciler` (every session at once, as rows).
 *
 * Moved out of `agents.service.ts` in #388: three modules imported these from the service file, which made it the grab-bag every neighbour reached into
 * for a helper (#351). They are plain functions over an `AgentsConfig` — no provider state — so they are a util, and `agents.service.ts` exports its class
 * and its request types and nothing else (`test/guards/server-layering.test.ts`).
 */

/** The dashboard's session list is a scan of `~/.claude/projects/`, the same order of work as the management index, and gets that call's budget. */
const SESSIONS_TIMEOUT_MS = 15_000;

/**
 * One session's detail (`GET /api/sessions/:id`, #611) is an incremental read of ONE transcript and its subagents' files, far cheaper than the list scan, and
 * the board polls it every 10 s while a disclosure is open — so a shorter budget than the list's: a dashboard that cannot answer one session in 8 s is not
 * going to answer the next poll either, and the disclosure says so rather than holding a request for 15 s.
 */
const SESSION_DETAIL_TIMEOUT_MS = 8_000;

/** The caps `dashboardSessionRows` asks with: the dashboard's own maxima, so the board sees as many sessions as one call can carry. */
const ROW_LIMIT = 50;
const ROW_LOOKBACK_HOURS = 168;

/**
 * The one fetch-and-parse of `/api/sessions` that every reader goes through. `query` is appended verbatim (`''` or `?limit=…`), `raw` is the list as the
 * dashboard sent it and `rows` is that list normalised: the first entry for an id wins (as `Array.find` did before this was a map), an entry with no string id is
 * skipped, `status` is `'unknown'` without a status string, and `desktopOwned` / `processLive` appear only when the dashboard sent `true` — it never sends
 * `false`, so absent and false are one thing and the row says it once.
 */
async function readSessions(cfg: AgentsConfig, query: string): Promise<{ rows: DashboardRow[]; count: number }> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/sessions${query}`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(SESSIONS_TIMEOUT_MS) });
  } catch (e) {
    throw new HttpException({ error: dashboardError(e, 'the dashboard session list', SESSIONS_TIMEOUT_MS) }, 502);
  }
  if (!res.ok) throw new HttpException({ error: `the dashboard session list answered ${res.status}` }, 502);
  const body = (await res.json().catch(() => null)) as { sessions?: unknown } | null;
  if (!Array.isArray(body?.sessions)) throw new HttpException({ error: 'the dashboard session list carried no sessions' }, 502);
  const seen = new Set<string>();
  const rows: DashboardRow[] = [];
  for (const s of body.sessions as Record<string, unknown>[]) {
    if (typeof s?.id !== 'string' || seen.has(s.id)) continue;
    seen.add(s.id);
    rows.push(toRow(s.id, s));
  }
  return { rows, count: body.sessions.length };
}

function toRow(id: string, s: Record<string, unknown>): DashboardRow {
  const row: DashboardRow = { id, status: typeof s.status === 'string' ? s.status : 'unknown' };
  if (typeof s.surface === 'string') row.surface = s.surface;
  if (s.desktopOwned === true) row.desktopOwned = true;
  if (s.stopState === 'ready' || s.stopState === 'stopping') row.stopState = s.stopState;
  if (s.processLive === true) row.processLive = true;
  for (const k of ['remoteQuestion', 'remotePlan', 'remoteReply', 'permissionWait'] as const) if (typeof s[k] === 'boolean') row[k] = s[k] as boolean;
  for (const k of ['projectPath', 'gitBranch', 'sessionName', 'model', 'effort'] as const) if (typeof s[k] === 'string') row[k] = s[k] as string;
  if (typeof s.contextPct === 'number') row.contextPct = s.contextPct;
  return row;
}

/**
 * The dashboard's sessions as rows, for the Jira reconciler: one call with the dashboard's caps (`limit=50`, `lookback=168` hours). `full` is true when the
 * answer is as long as the cap — a list that long may have left sessions out, so a session ABSENT from it proves nothing (spec §5). The count is the raw list's,
 * not the deduplicated rows', because the cap is the dashboard's and it counts what it sent. A 502 when the list cannot be read.
 */
export async function dashboardSessionRows(cfg: AgentsConfig): Promise<{ rows: DashboardRow[]; full: boolean }> {
  const { rows, count } = await readSessions(cfg, `?limit=${ROW_LIMIT}&lookback=${ROW_LOOKBACK_HOURS}`);
  return { rows, full: count >= ROW_LIMIT };
}

/**
 * The dashboard's session list as `id → status` — `'unknown'` for an entry with no status string — or a 502 when it cannot be read. One parse for every reader:
 * #225's case B and #227's stale probe ask for one session's status (`dashboardSessionStatus`), and none of them can disagree with another, or with the
 * reconciler's rows, about what the list said. It keeps the bare URL — the dashboard's own default caps — because these readers want any session a claim could
 * name, not the reconciler's capped window, and `test/tracker/tracker-abort.test.ts` matches that URL.
 */
export async function dashboardSessions(cfg: AgentsConfig): Promise<Map<string, string>> {
  const { rows } = await readSessions(cfg, '');
  return new Map(rows.map((r) => [r.id, r.status]));
}

/**
 * A session's status in the dashboard's session list — `null` when the list does not carry it, `'unknown'` for an entry with no status string — or a
 * 502 when the list cannot be read. #225's case B asked this first (`ItemsAbortService`); #227's stale probe asks it too, through `staleClaimProbe` below,
 * and there is one copy so the two can never disagree about what the list said.
 */
export async function dashboardSessionStatus(cfg: AgentsConfig, session: string): Promise<string | null> {
  return (await dashboardSessions(cfg)).get(session) ?? null;
}

/**
 * One session's row from `GET /api/sessions/:id/row` — `null` for the dashboard's 404 (`no such session`: no transcript exists for the id), a 502 for every
 * other failure, worded as `readSessions` words them. Unlike the list this reads ANY transcript whatever its age, with no cap and no lookback, so it is the
 * only honest answer to "does the dashboard know this session": absence from a full list proves nothing (spec §5), and `/jira link` refuses an id on this
 * 404 alone. The id goes into the path through `encodeURIComponent`, and the body is normalised by the same `toRow` the list uses, so the row a manual link
 * is made from has the shape the reconciler's rows have.
 */
export async function dashboardSessionRow(cfg: AgentsConfig, id: string): Promise<DashboardRow | null> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/sessions/${encodeURIComponent(id)}/row`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(SESSIONS_TIMEOUT_MS) });
  } catch (e) {
    throw new HttpException({ error: dashboardError(e, 'the dashboard session list', SESSIONS_TIMEOUT_MS) }, 502);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpException({ error: `the dashboard session list answered ${res.status}` }, 502);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) throw new HttpException({ error: 'the dashboard session row carried no session' }, 502);
  return toRow(id, body);
}

/**
 * #227's guard for a STALE claim nobody dispatched: the refusal sentence when this machine can show the holder is still running, else `null`. Never throws.
 *
 * A stale claim is forfeit by protocol — any `start`, on any machine, retires it with no confirm — so this is only an extra guard, and it refuses on a
 * POSITIVE answer alone: the claim was taken on this machine (`host` equals `BM_MACHINE_NAME`, both non-empty — the `sameHost` rule, absence never
 * matches) and the dashboard reports the holder `working` or `question`. That is a late heartbeat, not a dead session. Every other outcome — agents off,
 * no machine name, a foreign or absent host, a dashboard that is unreachable or does not know the session, any other status — answers `null` and the
 * protocol's own rule stands. The opposite default from #225's case B on purpose: that one releases a LIVE claim, so every unknown there must refuse.
 */
export async function staleClaimProbe(holder: { session: string; host?: string }): Promise<string | null> {
  const cfg = readAgentsConfig();
  const machine = (process.env.BM_MACHINE_NAME ?? '').trim();
  if (!cfg.enabled || machine === '' || typeof holder.host !== 'string' || holder.host === '' || holder.host !== machine) return null;
  let status: string | null;
  try {
    status = await dashboardSessionStatus(cfg, holder.session);
  } catch {
    return null;
  }
  return status === 'working' || status === 'question'
    ? `session ${holder.session} is ${status} on this machine — its heartbeat is late, not stopped; stop it before taking its claim`
    : null;
}

/**
 * The dispatch route's item-claim refusal for a tracker item (#227), `null` to proceed. The server half of the client's `progressBlock`
 * (`client/src/lib/item-progress.ts`), in the same order:
 *
 * - a run holds it — the run owns its items for the whole item, stale or not: a stale run claim is a crashed run, the watchdog's and `--resume`'s;
 * - the board dispatched the holder — its `claude -p` waiting on a reply has no process and sends no heartbeat, so staleness alone must not unblock it;
 * - a live claim — somebody is on it;
 * - a stale one — `staleClaimProbe`; the spawned session's own `start` retires the claim when it proceeds.
 */
export async function itemClaimBlock(id: string, holder: { session: string; host?: string; heartbeat: string; run?: string }, dispatched: boolean): Promise<string | null> {
  if (holder.run !== undefined) return `${id} is held by orchestrator run ${holder.run} — stop the run, not the item`;
  if (dispatched) return `the board's own session ${holder.session} holds this item — Stop & release it first`;
  const beat = Date.parse(holder.heartbeat);
  if (!Number.isNaN(beat) && Date.now() - beat < CLAIM_STALE_MS) return `${id} is in progress — session ${holder.session} holds its claim`;
  return staleClaimProbe(holder);
}

/** The literal sets the detail's enum fields are checked against: a value outside one is dropped, never forwarded (spec, "Server route"). */
const END_STATUSES: readonly NonNullable<SubagentJob['endStatus']>[] = ['completed', 'failed', 'killed', 'stopped'];
const BLOCKED_REASONS: readonly NonNullable<SubagentJob['blockedReason']>[] = ['rate-limit', 'rejected', 'interrupted'];

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * One `AgentJob` normalised field by field into a `SubagentJob`, or `null` when it has no string `id` or no legal `status` — a row that cannot say what it
 * is or whether it runs has nothing to draw. The ten base fields are always set (`''` / `null` for a missing or mistyped one, as the dashboard's own types
 * allow); each optional field the dashboard item adds is set only when present AND of its type, an enum only when it is one of its literals, so an unknown
 * key or a mistyped value never reaches the browser and an older dashboard's absent field stays absent rather than turning into a `null` that means "read,
 * and nothing there".
 */
function toSubagentJob(a: Record<string, unknown>): SubagentJob | null {
  if (typeof a?.id !== 'string' || (a.status !== 'running' && a.status !== 'done')) return null;
  const job: SubagentJob = {
    id: a.id,
    type: typeof a.type === 'string' ? a.type : '',
    description: typeof a.description === 'string' ? a.description : '',
    status: a.status,
    startedAt: strOrNull(a.startedAt),
    endedAt: strOrNull(a.endedAt),
    durationMs: numOrNull(a.durationMs),
    tokens: numOrNull(a.tokens),
    agentId: strOrNull(a.agentId),
    toolUses: numOrNull(a.toolUses)
  };
  if (a.resumed === true) job.resumed = true;
  if (typeof a.background === 'boolean') job.background = a.background;
  for (const k of ['model', 'lastWriteAt', 'lastTool'] as const) if (typeof a[k] === 'string' || a[k] === null) job[k] = a[k] as string | null;
  if (a.endStatus === null || END_STATUSES.includes(a.endStatus as never)) job.endStatus = a.endStatus as SubagentJob['endStatus'];
  if (a.blockedReason === null || BLOCKED_REASONS.includes(a.blockedReason as never)) job.blockedReason = a.blockedReason as SubagentJob['blockedReason'];
  return job;
}

/**
 * One session's subagents from the dashboard's `GET /api/sessions/:id` (#611) — `null` for the dashboard's 404 (no transcript for the id), a 502 for every
 * other failure, in `dashboardSessionRow`'s shape: a network failure or timeout through `dashboardError`, a non-2xx as `answered <status>`, and a 200 whose
 * body carries `error: true` (the dashboard's "scan failed") or no `agents` array as `carried no agents` — never an empty list, which would read as "no
 * subagents" when nothing was actually read. The body is rebuilt field by field (`toSubagentJob`), never forwarded raw; the detail's own `id` and `error`
 * are dropped, and `parentLive` is kept only as `true`, `false` or `null`. No cache: the dashboard's read is incremental, and a cached copy here would be a
 * sixth cache whose age is a rendered value. The caller validates `id` with `isSessionId` before this is reached.
 */
export async function dashboardSessionDetail(cfg: AgentsConfig, id: string): Promise<SubagentDetail | null> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/sessions/${encodeURIComponent(id)}`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(SESSION_DETAIL_TIMEOUT_MS) });
  } catch (e) {
    throw new HttpException({ error: dashboardError(e, 'the dashboard session detail', SESSION_DETAIL_TIMEOUT_MS) }, 502);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpException({ error: `the dashboard session detail answered ${res.status}` }, 502);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null || body.error === true || !Array.isArray(body.agents)) {
    throw new HttpException({ error: 'the dashboard session detail carried no agents' }, 502);
  }
  const agents = (body.agents as Record<string, unknown>[]).map(toSubagentJob).filter((j): j is SubagentJob => j !== null);
  const detail: SubagentDetail = {
    agents,
    running: numOrNull(body.running) ?? agents.filter((a) => a.status === 'running').length,
    finished: numOrNull(body.finished) ?? agents.filter((a) => a.status === 'done').length
  };
  if (body.parentLive === true || body.parentLive === false || body.parentLive === null) detail.parentLive = body.parentLive;
  return detail;
}
