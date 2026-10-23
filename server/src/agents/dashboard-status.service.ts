import { HttpException, Injectable } from '@nestjs/common';

import { PERMISSION_LADDER } from '../../../shared/agent';
import type { AgentsStatus, MachineHealth, PermissionMode } from '../../../shared/types';
import { authHeaders, dashboardError, message, type AgentsConfig } from './config.util';

/*
 * dashboard-status.service.ts — one dashboard's health and project list, for whichever machine's config it is handed.
 *
 * Until multi-dashboard task 4 this was `AgentsService.status()` and its private `projectMap`, which only ever read home. The offers need the same two reads
 * against every configured machine, and task 5 makes `AgentsService` inject the offers, so the offers cannot inject `AgentsService` back — Nest cannot
 * construct that cycle. The reads therefore live here, a provider both of them inject, and `AgentsService.status()` is `statusOf(readAgentsConfig())`.
 * Moved, not rewritten: the comments below are the ones the code carried in `agents.service.ts`, and home's budgets and wording are unchanged.
 *
 * The one structural change is the cache. It was a single slot keyed by url, so reading a second dashboard evicted the first and every offers request would
 * have cost home its map; it is now a `Map` keyed by `cfg.url`, each slot with its own `PROJECT_TTL_MS`.
 */

/** Health is a few fields off a warm process; a slow one means unreachable. */
const HEALTH_TIMEOUT_MS = 4_000;
/** /api/configs walks every recent project's .claude tree. It earns more. */
const MANAGEMENT_TIMEOUT_MS = 15_000;
/**
 * How long a path→dirName map stays good. The list only changes when a Claude
 * session starts somewhere new, and the call behind it is the expensive one in
 * this feature — a minute of staleness costs a disabled button that would have
 * worked.
 *
 * That cost used to be argued away with "which the sheet's own re-check then
 * corrects", and that held in one direction only: a stale ENABLE is corrected
 * by the sheet (clicking opens it and `plan()` re-derives the block here),
 * while a stale DISABLE never reached the sheet at all, because the control
 * the stale answer disabled is what opens it. That was bug-13; the board now
 * re-asks on a click against a project-visibility block (`DispatchButton`'s
 * `reverify`) rather than swallowing it, which is what makes the staleness
 * this constant permits recoverable in both directions. A re-ask inside the
 * same minute can still be answered from this map — the bound is deliberate
 * and unchanged, and one more click a moment later is the whole remaining
 * cost.
 */
const PROJECT_TTL_MS = 60_000;

/** How long `statusOf` may wait on each of its two reads. */
export interface StatusBudget {
  healthMs: number;
  managementMs: number;
}
/** Home's budgets, unchanged by the move: what `AgentsService.status()` has always used. */
export const HOME_BUDGET: StatusBudget = { healthMs: HEALTH_TIMEOUT_MS, managementMs: MANAGEMENT_TIMEOUT_MS };

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
export class DashboardStatusService {
  /** Keyed by url so a changed BM_AGENTS_URL cannot be answered from the old
   *  dashboard's map — which in tests is the difference between a pass and a
   *  silent cross-contamination between cases — and, since multi-dashboard,
   *  so that reading a remote's map never evicts home's. */
  private readonly maps = new Map<string, { at: number; map: Map<string, string> }>();

  /**
   * Any machine's dashboard, judged exactly as `AgentsService.status()` has always judged home's: health first (a failure is `reachable: false` with the
   * error), then the project map (a failure is an empty list, never unreachable). `budget` defaults to home's own timeouts; the offers pass a tighter one
   * for a remote, whose reads are new outbound calls and are held to the 5 s every new read gets.
   */
  async statusOf(cfg: AgentsConfig, budget: StatusBudget = HOME_BUDGET): Promise<AgentsStatus> {
    return this.judge(cfg, budget, false);
  }

  /**
   * A REMOTE dashboard, judged as `statusOf` judges one in every respect but the project map: a failed map read (a timeout, a non-ok answer, a body that
   * is not JSON) is `reachable: false` carrying that read's error, where `statusOf` swallows it into an empty list.
   *
   * Why the two differ (final-review I1). On home the swallow is the right reading and is kept byte for byte: `GET /api/agents/status` drives a board
   * where an empty list disables the buttons, and Settings is where home's dashboard is fixed. On a remote, an empty list lands on the offers' rung 5,
   * `<name>'s dashboard does not list <path>` — which tells the person to go and open a Claude session in that project on that machine, when the project
   * may well be listed and it is the dashboard's own heavy call that is failing. Surfacing the error puts it on rung 1, `dashboard unreachable — <error>`,
   * in the same words a dead health check already gets. Called only from the offers' remote judge and the remote arms of dispatch and orchestrate.
   */
  async remoteStatusOf(cfg: AgentsConfig, budget: StatusBudget): Promise<AgentsStatus> {
    return this.judge(cfg, budget, true);
  }

  /** `statusOf`'s body as it stood, with the one switch `remoteStatusOf` needs: what a failed project-map read means. */
  /**
   * One dashboard's `/api/health` and NOTHING else — the Dashboards page's per-machine read (`MachinesService`). `statusOf` and `remoteStatusOf` also read the
   * project map (`/api/configs`, up to 15 s), which a Settings page has no project to ask about and which would make a remote's health depend on one; this is
   * their health half on its own, so `projectPaths` is not in the answer and the three fields the dot reads come out exactly as `judge` reads them.
   *
   * `!cfg.enabled` is the same off switch `judge` has: the all-false answer with no fetch, so `BM_AGENTS` off stays egress-free here too. A failed read is
   * `enabled: true, reachable: false` carrying `message(e)` — the wording `judge` has always given.
   */
  async healthOf(cfg: AgentsConfig, healthMs: number): Promise<MachineHealth> {
    const off: MachineHealth = { enabled: false, reachable: false, remoteAnswer: false, spawnAvailable: false, spawnMaxPermission: null };
    // The short-circuit is the feature's off switch: no fetch, so no egress,
    // so nothing to report about a dashboard we never contacted.
    if (!cfg.enabled) return off;
    let health: DashboardHealth;
    try {
      health = await this.get<DashboardHealth>(cfg, '/api/health', healthMs);
    } catch (e) {
      return { ...off, enabled: true, error: message(e) };
    }
    return {
      enabled: true,
      reachable: true,
      remoteAnswer: health.remoteAnswer === true,
      spawnAvailable: health.spawnAvailable === true,
      spawnMaxPermission: asMode(health.spawnMaxPermission)
    };
  }

  private async judge(cfg: AgentsConfig, budget: StatusBudget, mapFailureIsUnreachable: boolean): Promise<AgentsStatus> {
    // The health half is `healthOf`; what this adds is the project map. A disabled or unreachable answer is returned as it came, with the empty list the
    // old `off` answer always carried.
    const health = await this.healthOf(cfg, budget.healthMs);
    if (!health.reachable) return { ...health, projectPaths: [] };

    let projectPaths: string[] = [];
    try {
      projectPaths = [...(await this.projectMap(cfg, budget.managementMs)).keys()];
    } catch (e) {
      // Swallowed on purpose for home: health already told us the dashboard is up, and
      // reporting `reachable: false` because the *heavy* call timed out would
      // send the reader to fix a connection that works. An empty list disables
      // the buttons, which is the honest consequence.
      //
      // Not for a remote (`remoteStatusOf`): there the empty list would be read as "never seen the project", the worse lie of the two. `projectMap`
      // wraps every failure in an HttpException whose `error` is already `dashboardError`'s wording, so that text is relayed as it stands.
      if (mapFailureIsUnreachable) {
        return { enabled: true, reachable: false, remoteAnswer: false, spawnAvailable: false, spawnMaxPermission: null, projectPaths: [], error: mapError(e) };
      }
    }

    return { ...health, projectPaths };
  }

  /**
   * Absolute project path → that dashboard's own dirName key, cached per dashboard `url` for `PROJECT_TTL_MS`. `managementMs` is the budget for a fetch this
   * call has to make; a cached answer costs nothing whatever budget it is asked under.
   */
  async projectMap(cfg: AgentsConfig, managementMs: number = MANAGEMENT_TIMEOUT_MS): Promise<Map<string, string>> {
    const now = Date.now();
    const held = this.maps.get(cfg.url);
    if (held !== undefined && now - held.at < PROJECT_TTL_MS) {
      return held.map;
    }
    // The second escaping seam bug-26 names, and wider than the spawn one:
    // `get()` rejects on a connection failure or a timeout AND throws a plain
    // Error for a non-ok answer, so a dashboard that merely 500s its own
    // /api/configs inside the TTL window reached the same unmapped 500.
    //
    // Caught here rather than at the three post-gate call sites for the same
    // reason it is one function at all: one seam, three identical callers.
    // The 409 sitting under each of those calls stays untouched and stays
    // right — it means "the dashboard answered and this project was not in
    // the list", where this means "we never got to ask", which is the same
    // split `dispatch()` and `orchestrate()` already make between an
    // unreachable dashboard and one that said no.
    //
    // `statusOf()`'s bare `catch {}` swallows this HttpException exactly as it
    // swallowed the raw error before, so GET /api/agents/status is unchanged:
    // an empty project list, not a 502.
    let data: DashboardManagement;
    try {
      // `/api/configs` was `/api/management` until the dashboard's dc3ade0 (2026-10-01) renamed it with no alias. The old path then fell through to
      // the dashboard's SPA fallback — a 200 carrying index.html — whose JSON parse threw, the status route swallowed that, and every project
      // showed as unseen, which disabled dispatch everywhere with no error on screen. A rename over there has to be followed here.
      data = await this.get<DashboardManagement>(cfg, '/api/configs', managementMs);
    } catch (e) {
      throw new HttpException({ error: dashboardError(e, 'the dashboard project list', managementMs) }, 502);
    }
    const map = new Map<string, string>();
    for (const p of data.projects ?? []) {
      // Both fields or neither: a half-shaped entry is one we cannot spawn
      // into, and dropping it is the same posture RegistryService takes on a
      // mis-shaped project — a bad entry, not a bad response.
      if (typeof p.path === 'string' && typeof p.dirName === 'string') map.set(p.path, p.dirName);
    }
    // Expired slots are dropped on every write, so a URL edited away in Settings does not keep its map for the life of the process.
    for (const [url, slot] of this.maps) if (now - slot.at >= PROJECT_TTL_MS) this.maps.delete(url);
    this.maps.set(cfg.url, { at: now, map });
    return map;
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
/** The text of a `projectMap` failure: the HttpException's own `error` (`dashboardError`'s wording), else the raw message. */
function mapError(e: unknown): string {
  if (e instanceof HttpException) {
    const body = e.getResponse() as { error?: unknown };
    if (typeof body === 'object' && body !== null && typeof body.error === 'string') return body.error;
  }
  return message(e);
}

/**
 * A ceiling we do not recognise is a dashboard newer than this client. Read as
 * null, which `modesUpTo` turns into "plan only" — the safe reading, since we
 * cannot know where an unknown string sits on the ladder.
 */
function asMode(value: unknown): PermissionMode | null {
  return typeof value === 'string' && (PERMISSION_LADDER as readonly string[]).includes(value) ? (value as PermissionMode) : null;
}
