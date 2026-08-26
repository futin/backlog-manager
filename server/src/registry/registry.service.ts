import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { Registry, RegistryProject } from '../../../shared/types';

export const REGISTRY_FILE = 'REGISTRY_FILE';

export function defaultRegistryFile(): string {
  return process.env.BM_REGISTRY_FILE || join(homedir(), '.backlog-manager', 'registry.json');
}

/**
 * Read-only view of ~/.backlog-manager/registry.json — the single source of
 * truth for which projects have a backlog. Written only by
 * skills/backlog/tools/backlog.mjs (its init and new commands); this service
 * never writes it.
 *
 * Read per call rather than cached: a skill can register a project at any
 * moment, and the file is a few KB. A cache here would show a stale board
 * until restart.
 *
 * The constructor takes the file path so tests can point at a fixture. Nest
 * supplies it through the REGISTRY_FILE token.
 */
@Injectable()
export class RegistryService {
  private readonly file: string;

  constructor(@Optional() @Inject(REGISTRY_FILE) file?: string) {
    this.file = file ?? defaultRegistryFile();
  }

  load(): Registry {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Registry;
      if (!Array.isArray(data.projects)) throw new Error('bad shape');
      // Per entry, not just the array. backlog.mjs is the only writer, but the
      // file is plain JSON in $HOME and a hand-edited `{"name":1,"path":2}`
      // used to pass this check and reach join(2, 'backlog') downstream —
      // ERR_INVALID_ARG_TYPE, a 500 for the whole board, which the client then
      // rendered as "nothing registered yet". Dropping the entry keeps the
      // contract below true for a bad entry too, not just a bad file.
      return { projects: data.projects.filter(isRegistryProject) };
    } catch {
      // Missing, unreadable, or mis-shaped: an empty board with the "nothing
      // registered yet" state, never a 500.
      return { projects: [] };
    }
  }
}

/**
 * All three fields, all strings — every one of them is used as a path segment
 * or a display string somewhere downstream, so a non-string in any of them is
 * a project nothing can do anything useful with.
 */
function isRegistryProject(entry: unknown): entry is RegistryProject {
  if (typeof entry !== 'object' || entry === null) return false;
  const p = entry as Partial<RegistryProject>;
  return typeof p.name === 'string' && typeof p.path === 'string' && typeof p.createdAt === 'string';
}
