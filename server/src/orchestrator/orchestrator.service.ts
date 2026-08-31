import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

import { RUN_STALE_MS } from '../../../shared/types';
import type { OrchestratorRun, OrchestratorRunsPayload } from '../../../shared/types';

/**
 * `$BM_ORCH_HOME` when set, else `~/.backlog-manager/orchestrator/` — must
 * resolve identically to orchestrate.mjs's own `orchHome()`
 * (skills/backlog-orchestrate/tools/orchestrate.mjs), because that tool is
 * the only writer of everything this service reads: a mismatch here would
 * have the board watching an empty directory while the CLI writes real runs
 * a few characters away. A plain exported function, not a value captured
 * once — see OrchestratorService.runs() below for why it is called fresh
 * on every request rather than resolved at construction.
 */
export function orchHome(): string {
  return process.env.BM_ORCH_HOME || join(homedir(), '.backlog-manager', 'orchestrator');
}

/**
 * `JSON.parse` alone only proves the file held *some* JSON value — a
 * truncated write, a hand-edit, or an unrelated file that happens to parse
 * (a bare `42`, `{}`) would otherwise be spread straight into the API
 * response as a fake run. This checks just enough fields to make every read
 * this service performs on the result safe (the two used for `fresh`, plus
 * the two that identify a run as a run at all), the same "enough to be safe
 * downstream, not a full schema" scope as RegistryService's
 * isRegistryProject.
 */
function isPlausibleRun(value: unknown): value is OrchestratorRun {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<OrchestratorRun>;
  return (
    typeof r.runId === 'string' &&
    typeof r.project === 'string' &&
    typeof r.status === 'string' &&
    typeof r.updatedAt === 'string' &&
    Array.isArray(r.queue)
  );
}

/** Directory-entry count for one project's archived-runs folder, 0 when it
 *  doesn't exist yet (no run for this project has ever been superseded by a
 *  later `init` — see orchestrate.mjs's own archiving comment on cmdInit). */
function countPastRuns(runsDir: string): number {
  try {
    return readdirSync(runsDir).length;
  } catch {
    return 0;
  }
}

/**
 * Read-only view of the orchestrator's run-state directory
 * (~/.backlog-manager/orchestrator/, or $BM_ORCH_HOME) — the same role
 * RegistryService (server/src/registry/registry.service.ts) plays for
 * ~/.backlog-manager/registry.json, pointed at a different tree: written
 * only by skills/backlog-orchestrate/tools/orchestrate.mjs, never by this
 * process, and read fresh on every call rather than cached. A running
 * orchestrate.mjs process re-stamps run.json on every heartbeat, and the
 * whole point of this endpoint is to let the board watch that happen live —
 * a cache here would show a run frozen at whatever moment the server last
 * happened to read it.
 *
 * Unlike ItemsService, this service takes no RegistryModule dependency: a
 * run's project identity lives entirely inside its own run.json (`project`,
 * the same absolute path RegistryProject.path would carry), so there is
 * nothing to cross-reference — this service only ever walks orchHome()'s
 * own subdirectories, one per project that has ever had a run.
 */
@Injectable()
export class OrchestratorService {
  runs(): OrchestratorRunsPayload {
    const root = orchHome();
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // No orchestrator state directory at all — nothing has ever run here.
      // Not an error: the board's "no runs yet" empty state, the same
      // spirit as RegistryService returning { projects: [] } for a missing
      // registry file rather than a 500.
      return { runs: [] };
    }

    const runs: OrchestratorRunsPayload['runs'] = [];
    for (const name of entries) {
      const dir = join(root, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
      } catch (e) {
        // Missing run.json (a stray non-project entry), unreadable, or not
        // valid JSON at all — skip this one project rather than fail the
        // whole payload. A board showing three runs out of four beats one
        // showing none because a single file on disk is mid-write or
        // hand-edited.
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`orchestrator: run.json for "${name}" is unreadable or not valid JSON, skipping (${message})`);
        continue;
      }
      if (!isPlausibleRun(parsed)) {
        console.warn(`orchestrator: run.json for "${name}" parsed but is not a run, skipping`);
        continue;
      }

      const fresh = parsed.status === 'running' && Date.now() - Date.parse(parsed.updatedAt) < RUN_STALE_MS;
      const pastRuns = countPastRuns(join(dir, 'runs'));
      runs.push({ ...parsed, fresh, pastRuns });
    }

    return { runs };
  }
}
