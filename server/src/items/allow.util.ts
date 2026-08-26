import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { Registry } from '../../../shared/types';

/**
 * Port of guide-manager's render/paths.util.ts, narrowed: only a registered
 * project's backlog/ directory is servable — the item bodies live nowhere
 * else, so nothing else is on the list.
 */
export function buildAllowlist(registry: Registry): Set<string> {
  const dirs = new Set<string>();
  for (const project of registry.projects) {
    try {
      dirs.add(realpathSync(join(project.path, 'backlog')));
    } catch {
      // project gone or store never created — /api/projects reports it
    }
  }
  return dirs;
}

export function resolveAllowed(requestPath: string, allowedDirs: Set<string>): string | null {
  let real: string;
  try {
    real = realpathSync(requestPath);
  } catch {
    return null;
  }
  for (const dir of allowedDirs) {
    // `dir + sep`, not `dir`: a bare prefix check would let /x/backlog-evil
    // through on an allowlist entry of /x/backlog.
    if (real.startsWith(dir + sep)) return real;
  }
  return null;
}
