import { HttpException, Injectable } from '@nestjs/common';

import { ItemsService } from '../items/items.service';
import { DispatchRecordsService } from '../items/dispatch-records.service';
import { answer, writable } from '../items/items-write.controller';
import { isLive } from '../tracker/claim';
import { TrackerPollerService } from '../tracker/poller.service';
import { readAgentsConfig, type AgentsConfig } from './config.util';
import { authHeaders, dashboardError, dashboardSessionStatus, staleClaimProbe } from './agents.service';
import type { ItemAbortResult } from '../../../shared/types';

/** The dashboard's stop answers at once — it signals a process, it does not wait for one — so the spawn call's budget is plenty. */
const STOP_TIMEOUT_MS = 10_000;

/**
 * items-abort.service.ts — `POST /api/items/abort` (#225): the board's way to let go of a tracker claim whose session was stopped, or died, without
 * running its own closing `stop` — and, since #227, of one whose heartbeat has gone stale.
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
 * The holder is the claim `readClaim` answers. No unreleased claim, or one a RUN holds, live or stale, is refused before the dashboard is asked anything: a
 * run owns its items for the whole item, and a stale run claim is a crashed run, which the watchdog and `--resume` own.
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
 *
 * ## A stale claim (#227)
 *
 * Before #227 a claim past its heartbeat window was refused here as `not claimed`, on the reasoning that the protocol retires it at the next `start`. But
 * the board went on showing it as held, and the item modal offered no way to let go of it — so an item nobody was on read as worked, on every machine,
 * until somebody happened to dispatch it. A stale claim is forfeit by protocol: any `start`, anywhere, retires it with no confirm. The board releasing it
 * behind a confirm naming the heartbeat age and host adds no authority the protocol does not already grant.
 *
 * - **Dispatched by this server** — case A, unchanged: a `claude -p` waiting on a reply sends no heartbeat, so its age says nothing, and the stop is what
 *   makes the release safe.
 * - **Anything else** — `staleClaimProbe`, which refuses only when the claim was taken on this machine and the dashboard positively reports the holder
 *   `working` or `question`. Every unknown proceeds, including agents off, which is why this branch runs before the agents-off 409 below. Released as
 *   `reason: 'stale'`, `by: 'board'`, the word `claim`'s own retire loop writes, and with no `authority`: `release` refuses only a LIVE claim held by
 *   somebody else, so it needs none.
 */
@Injectable()
export class ItemsAbortService {
  constructor(
    private readonly items: ItemsService,
    private readonly dispatches: DispatchRecordsService,
    /** For `syncOffBlock` alone (#17) — see the first check in `abort`. */
    private readonly poller: TrackerPollerService
  ) {}

  async abort(project: string, id: string): Promise<ItemAbortResult> {
    const w = writable(this.items.writerFor(project));
    // Sync off refuses the release (`GithubSource.writeChain`), so it must refuse here, FIRST: this route's other half is a dashboard stop, and a stop
    // followed by a refused release is a killed session with its claim still live and an error on the screen (#17, final review M2).
    const syncOff = this.poller.syncOffBlock(project);
    if (syncOff !== null) throw new HttpException({ error: syncOff }, 409);
    const claim = answer(await w.writer.readClaim(w.project, w.marker, id));
    if (claim === null || claim.record.released !== undefined) {
      throw new HttpException({ error: `${id} is not claimed` }, 409);
    }
    const holder = claim.record;
    if (holder.run !== undefined) {
      throw new HttpException({ error: `${id} is held by orchestrator run ${holder.run.runId} — stop the run, not the item` }, 409);
    }

    if (!isLive(holder, Date.now()) && this.dispatches.get(holder.session) === null) {
      const refusal = await staleClaimProbe(holder);
      if (refusal !== null) throw new HttpException({ error: refusal }, 409);
      answer(await w.writer.release(w.project, w.marker, { project, id, commentId: claim.commentId, session: 'board', reason: 'stale' }));
      return { id, released: true, stopped: false };
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
      const status = await dashboardSessionStatus(cfg, holder.session);
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
}
