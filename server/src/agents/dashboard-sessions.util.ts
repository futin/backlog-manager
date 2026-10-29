import { HttpException } from '@nestjs/common';

import { authHeaders, dashboardError, readAgentsConfig, type AgentsConfig } from './config.util';
import { CLAIM_STALE_MS } from '../../../shared/types';

/*
 * dashboard-sessions.util.ts — the dashboard's `/api/sessions` read, and the two claim refusals built on it: `staleClaimProbe` (#227) and `itemClaimBlock`,
 * which ends in it. Read by `AgentsService.dispatch` (the item-claim refusal), `ItemsAbortService` (#225's case B and the stale probe) and
 * `JiraLiveService`'s reconciler (every session at once).
 *
 * Moved out of `agents.service.ts` in #388: three modules imported these from the service file, which made it the grab-bag every neighbour reached into
 * for a helper (#351). They are plain functions over an `AgentsConfig` — no provider state — so they are a util, and `agents.service.ts` exports its class
 * and its request types and nothing else (`test/server-layering.test.ts`).
 */

/** The dashboard's session list is a scan of `~/.claude/projects/`, the same order of work as the management index, and gets that call's budget. */
const SESSIONS_TIMEOUT_MS = 15_000;

/**
 * The dashboard's session list as `id → status` — `'unknown'` for an entry with no status string — or a 502 when it cannot be read. One fetch and one parse
 * for every reader: #225's case B and #227's stale probe ask for one session's status (`dashboardSessionStatus`), and Jira's live-map reconciler asks for all
 * of them at once, so none of them can disagree with another about what the list said.
 */
export async function dashboardSessions(cfg: AgentsConfig): Promise<Map<string, string>> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/sessions`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(SESSIONS_TIMEOUT_MS) });
  } catch (e) {
    throw new HttpException({ error: dashboardError(e, 'the dashboard session list', SESSIONS_TIMEOUT_MS) }, 502);
  }
  if (!res.ok) throw new HttpException({ error: `the dashboard session list answered ${res.status}` }, 502);
  const body = (await res.json().catch(() => null)) as { sessions?: unknown } | null;
  if (!Array.isArray(body?.sessions)) throw new HttpException({ error: 'the dashboard session list carried no sessions' }, 502);
  const out = new Map<string, string>();
  for (const s of body.sessions as { id?: unknown; status?: unknown }[]) {
    // The first entry for an id wins, as `Array.find` did before this was a map.
    if (typeof s?.id === 'string' && !out.has(s.id)) out.set(s.id, typeof s.status === 'string' ? s.status : 'unknown');
  }
  return out;
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
