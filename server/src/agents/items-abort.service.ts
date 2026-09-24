import { HttpException, Injectable } from '@nestjs/common';

import { ItemsService } from '../items/items.service';
import { DispatchRecordsService } from '../items/dispatch-records.service';
import { answer, writable } from '../items/items-write.controller';
import { isLive } from '../tracker/claim';
import { readAgentsConfig, type AgentsConfig } from './config.util';
import { authHeaders, dashboardError } from './agents.service';
import type { ItemAbortResult } from '../../../shared/types';

/** The dashboard's stop answers at once — it signals a process, it does not wait for one — so the spawn call's budget is plenty. */
const STOP_TIMEOUT_MS = 10_000;
/** The session list is a scan of `~/.claude/projects/`, the same order of work as the management index, and gets that call's budget. */
const SESSIONS_TIMEOUT_MS = 15_000;

/**
 * items-abort.service.ts — `POST /api/items/abort` (#225): the board's way to let go of a tracker claim whose session was stopped, or died, without
 * running its own closing `stop`.
 *
 * ## Why this is in `agents/`, when the route is under `/api/items`
 *
 * Because it calls the dashboard, and `agents/` and `tracker/` are this server's only two outbound-calling modules. `ItemsModule` knows nothing about the
 * dashboard and must not start to. The release itself still goes through the `ItemWriter` seam like every other item write — `writable` and `answer` are the
 * same two functions `items-write.controller.ts` gates and maps with, imported rather than copied — so "what can write to an issue" is still answered by
 * reading `github.source.ts`.
 *
 * ## The two cases, and why each proof is the one it is
 *
 * The holder is the live claim `readClaim` answers. No live claim, or one a RUN holds, is refused before the dashboard is asked anything: a stale claim is the
 * protocol's to retire at the next `start`, and a run owns its items for the whole item.
 *
 * - **Case A — this server dispatched the holding session.** The board started it, so the board may stop it: ask the dashboard to stop the session, then
 *   release. A 200 (`stopped` or `stopping`) proceeds, and so does a 404 that says `no live session` — the process is already gone, which for a
 *   board-dispatched `claude -p` also means "between turns". Any other answer, including the dashboard's OTHER 404 (`remote answers disabled`, which says
 *   nothing about the session), or no answer at all, is a 502 and no release: the session may still be running, and releasing under a running session is
 *   the double-work this protocol exists to prevent.
 * - **Case B — no record** (a session started at a terminal, or before this server's last restart). Nothing here can stop it, so the release needs proof it
 *   is not running: the claim's `host` equals this server's `BM_MACHINE_NAME` (both non-empty — absence never matches, the `sameHost` rule), and the
 *   dashboard's session list reports the holder as neither `working` nor `question`. A session the list does not carry is refused too: not found is not
 *   the same as not running. What this cannot see is a board-dispatched `claude -p` between turns on a record this server lost — it reads `idle` like a
 *   finished session — which is why the client's confirm for this case says so.
 *
 * The release is `reason: 'aborted'`, `by: 'board'`, and carries `authority: 'board'` — the release rule's fifth clause, which no HTTP body can set.
 */
@Injectable()
export class ItemsAbortService {
  constructor(
    private readonly items: ItemsService,
    private readonly dispatches: DispatchRecordsService
  ) {}

  async abort(project: string, id: string): Promise<ItemAbortResult> {
    const w = writable(this.items.writerFor(project));
    const claim = answer(await w.writer.readClaim(w.project, w.marker, id));
    if (claim === null || !isLive(claim.record, Date.now())) {
      throw new HttpException({ error: `${id} is not claimed` }, 409);
    }
    const holder = claim.record;
    if (holder.run !== undefined) {
      throw new HttpException({ error: `${id} is held by orchestrator run ${holder.run.runId} — stop the run, not the item` }, 409);
    }

    const cfg = readAgentsConfig();
    if (!cfg.enabled) {
      throw new HttpException({ error: 'agents are off on this machine, so nothing here can stop the holding session or show it is not running' }, 409);
    }

    let stopped = false;
    if (this.dispatches.get(holder.session) !== null) {
      stopped = await this.stopSession(cfg, holder.session);
    } else {
      const machine = (process.env.BM_MACHINE_NAME ?? '').trim();
      if (machine === '') {
        throw new HttpException({ error: `this server has no BM_MACHINE_NAME, so it cannot tell a claim taken on this machine from one taken elsewhere` }, 409);
      }
      if (typeof holder.host !== 'string' || holder.host.length === 0 || holder.host !== machine) {
        throw new HttpException({ error: `${id} is held on ${holder.host ?? 'a machine the claim did not record'}, not this one (${machine})` }, 409);
      }
      const status = await this.sessionStatus(cfg, holder.session);
      if (status === null) {
        throw new HttpException({ error: `the dashboard does not know session ${holder.session}, so nothing shows it is not running` }, 409);
      }
      if (status === 'working' || status === 'question') {
        throw new HttpException({ error: `session ${holder.session} is ${status} — stop it before releasing its claim` }, 409);
      }
    }

    answer(await w.writer.release(w.project, w.marker, { project, id, commentId: claim.commentId, session: 'board', reason: 'aborted', authority: 'board' }));
    // Forgotten only now: a release GitHub refused leaves the claim live, and the retry must still find the session was ours.
    this.dispatches.forget(holder.session);
    return { id, released: true, stopped };
  }

  /** `true` for a 200, `false` for the one 404 that means the process is already gone; a 502 for anything else. */
  private async stopSession(cfg: AgentsConfig, session: string): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(`${cfg.url}/api/sessions/${encodeURIComponent(session)}/stop`, {
        method: 'POST',
        headers: authHeaders(cfg),
        signal: AbortSignal.timeout(STOP_TIMEOUT_MS)
      });
    } catch (e) {
      throw new HttpException({ error: dashboardError(e, 'the dashboard session stop', STOP_TIMEOUT_MS) }, 502);
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.ok) return true;
    if (res.status === 404 && body?.error === 'no live session') return false;
    const error = typeof body?.error === 'string' ? body.error : `answered ${res.status}`;
    throw new HttpException({ error: `the dashboard did not stop session ${session}: ${error} — the claim is untouched` }, 502);
  }

  /** The holder's status in the dashboard's session list, `null` when the list does not carry it; a 502 when the list cannot be read. */
  private async sessionStatus(cfg: AgentsConfig, session: string): Promise<string | null> {
    let res: Response;
    try {
      res = await fetch(`${cfg.url}/api/sessions`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(SESSIONS_TIMEOUT_MS) });
    } catch (e) {
      throw new HttpException({ error: dashboardError(e, 'the dashboard session list', SESSIONS_TIMEOUT_MS) }, 502);
    }
    if (!res.ok) throw new HttpException({ error: `the dashboard session list answered ${res.status}` }, 502);
    const body = (await res.json().catch(() => null)) as { sessions?: unknown } | null;
    if (!Array.isArray(body?.sessions)) throw new HttpException({ error: 'the dashboard session list carried no sessions' }, 502);
    const found = (body.sessions as { id?: unknown; status?: unknown }[]).find((s) => s?.id === session);
    return found === undefined ? null : typeof found.status === 'string' ? found.status : 'unknown';
  }
}
