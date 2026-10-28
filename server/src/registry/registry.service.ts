import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';

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

  /**
   * The registry as a three-way answer — the shape `readDashboardsFile` uses —
   * so a caller that RENDERS the registry can tell "nothing registered yet"
   * from "the file is broken". Those used to be one branch (#349): a truncated
   * registry.json read as `{ projects: [] }`, the board answered 200 with no
   * projects, and the well drew "nothing registered yet" — the one message that
   * sends a person off to run a backlog skill when the real problem is a file.
   *
   * - `default` — ENOENT only. A fresh install has no registry and that IS
   *   legitimately empty.
   * - `file` — a parsed object with a `projects` array. The per-entry filter
   *   still applies: one bad entry is dropped, not the whole file.
   * - `unreadable` — every other read error, invalid JSON, a non-object, or a
   *   `projects` that is not an array. `reason` names the file.
   */
  read(): RegistryRead {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { source: 'default', value: { projects: [] } };
      return this.unreadable(`${this.file} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return this.unreadable(`${this.file} does not parse as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return this.unreadable(`${this.file} is not a JSON object`);
    const projects = (data as { projects?: unknown }).projects;
    if (!Array.isArray(projects)) return this.unreadable(`${this.file} has no projects array`);
    // Per entry, not just the array. backlog.mjs is the only writer, but the
    // file is plain JSON in $HOME and a hand-edited `{"name":1,"path":2}`
    // used to pass this check and reach join(2, 'backlog') downstream —
    // ERR_INVALID_ARG_TYPE, a 500 for the whole board, which the client then
    // rendered as "nothing registered yet". Dropping the entry keeps the
    // contract below true for a bad entry too, not just a bad file.
    return { source: 'file', value: { projects: projects.filter(isRegistryProject) } };
  }

  /**
   * `read()`'s projection, fail-closed: empty on any failure. Every caller
   * that is not drawing the registry — the pollers, dispatch, the watchdog,
   * the tick and remote-run reads, the tracker write routes — keeps this,
   * because to them a broken registry means "no project", which refuses
   * dispatch rather than guessing. Only the board's routes ask `read()` and
   * turn `unreadable` into a 503.
   */
  load(): Registry {
    const read = this.read();
    return read.source === 'unreadable' ? { projects: [] } : read.value;
  }

  private unreadable(reason: string): RegistryRead {
    // Once per call: the board polls, so this repeats while the file stays
    // broken — which is the point, the log says so for as long as it is true.
    console.warn(`registry: ${reason}`);
    return { source: 'unreadable', reason };
  }
}

export type RegistryRead = { source: 'file' | 'default'; value: Registry } | { source: 'unreadable'; reason: string };

/**
 * The board's reading of the registry: the projects, or a 503 naming the file
 * when it cannot be read. `useBoard` turns any non-ok answer into its `error`
 * state, which renders "board unavailable" rather than "nothing registered
 * yet" — so no client change is needed, only an honest status.
 */
export function registryProjectsOr503(registry: RegistryService): RegistryProject[] {
  const read = registry.read();
  if (read.source === 'unreadable') throw new HttpException({ error: read.reason }, 503);
  return read.value.projects;
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
