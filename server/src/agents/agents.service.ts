import { realpathSync } from 'node:fs';
import { HttpException, Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { buildAllowlist, resolveAllowed } from '../items/allow.util';
import { scanProject } from '../items/scan.util';
import { readAgentsConfig, type AgentsConfig } from './config.util';
import { clampMode, deriveAction, dispatchBlock, modesUpTo, PERMISSION_LADDER } from '../../../shared/agent';
import { composePrompt } from './prompt.util';
import type { AgentPlan, AgentsStatus, BacklogItem, PermissionMode } from '../../../shared/types';

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

  constructor(private readonly registry: RegistryService) {}

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
      // acceptEdits, not the ceiling: the work is editing files in one repo,
      // and asking for the most a host allows by default is how a convenience
      // becomes an incident. The select is right there if more is wanted.
      defaultMode: clampMode('acceptEdits', status.spawnMaxPermission),
      blocked: dispatchBlock(item, status) ?? undefined
    };
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
