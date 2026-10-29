import { HttpException, Injectable } from '@nestjs/common';

import { ItemsService } from '../items/items.service';
import { DispatchRecordsService } from '../items/dispatch-records.service';
import { answer } from '../items/write-answer.util';
import { writable } from '../items/write-gate.util';
import { isLive } from '../tracker/claim';
import { TrackerPollerService } from '../tracker/poller.service';
import { readAgentsConfig } from './config.util';
import { dashboardSessionStatus, staleClaimProbe } from './agents.service';
import { stopDashboardSession } from './session-stop.util';
import { DashboardsService, type Machine } from './dashboards/dashboards.service';
import type { ItemAbortResult } from '../../../shared/types';

/**
 * items-abort.service.ts — `POST /api/items/abort` (#225): the board's way to let go of a tracker claim whose session was stopped, or died, without
 * running its own closing `stop` — and, since #227, of one whose heartbeat has gone stale.
 *
 * ## Why this is in `agents/`, when the route is under `/api/items`
 *
 * Because it calls the dashboard, and `agents/`, `tracker/` and `jira/` are this server's only three outbound-calling modules (and the dashboard is `agents/`'s
 * alone). `ItemsModule` knows nothing about the dashboard and must not start to. The release itself still goes through the `ItemWriter` seam like every other
 * item write — `writable` (`items/write-gate.util.ts`) and `answer` (`items/write-answer.util.ts`) are the same two functions the item write routes gate
 * and map with, imported rather than copied — so "what can write to an issue" is still answered by reading `github.source.ts`.
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
 * ## Which machine (multi-dashboard task 7)
 *
 * The card may have been dispatched to a REMOTE dashboard, whose session this machine's dashboard has never heard of — so the stop has to go to the dashboard
 * the session runs on, before the claim is released. The ladder, in order:
 *
 * 1. **A dispatch record** names its machine (`DispatchRecord.machine`): stop on it. A name the machine file no longer holds is a 409 and the claim stays —
 *    the session may still be running on a machine this server can no longer reach, and guessing "home" would answer "no live session" for a process that is
 *    alive. A record stays this case A on any machine: the board started the session, so the board may stop it, wherever it runs.
 * 2. **No record** (this server restarted) and the claim's `host` is a configured remote's `host` (exact match): that remote's dashboard is where the session
 *    is, so stop there and release. Only the stop's own answer is the proof here — a remote's session list is NOT consulted — so this is case A's rule applied
 *    to a session whose record was lost, and a failed stop is a 502 with the claim untouched. Review Focus 4.
 * 3. **Otherwise** case B exactly as before: the `BM_MACHINE_NAME` and host-equality refusals, then the home session list. A host that matches no machine at
 *    all keeps today's `held on <host>, not this one` refusal.
 *
 * The remote's `cfg` carries its own URL and token, and its stop keeps `STOP_TIMEOUT_MS` and its 502s — one stop function, one `cfg` argument.
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
    private readonly poller: TrackerPollerService,
    /** Which machine's dashboard a stop is sent to (multi-dashboard task 7) — see "Which machine" above. Reads the machine file per call, nothing cached. */
    private readonly dashboards: DashboardsService
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
    const record = this.dispatches.get(holder.session);
    let target: Machine | null = null;
    if (record !== null) {
      target = this.dashboards.machine(record.machine);
      if (target === null) {
        throw new HttpException({ error: `${id} was dispatched to ${record.machine}, which is no longer configured` }, 409);
      }
    } else {
      target = this.dashboards.byHost(holder.host);
    }
    if (target !== null) {
      stopped = await stopDashboardSession(target.cfg, holder.session, 'the claim is untouched');
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
}
