import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { readTickFile, streakOf, tickFile, tickHome, writeTickFile } from './tick-breaker.util';
import { TICK_HALT_LIMITS } from '../../../shared/types';
import type { TickConfig, TickLock, TickProject, TickRecentEntry, TicksPayload } from '../../../shared/types';

/**
 * `GET /api/ticks`'s one builder, and the reset's one stamp. The payload is built on EVERY call and cached nowhere — the `readWatchdogConfig` reasoning: a
 * `tick.mjs` records an outcome or a person hand-edits `tick.json` at any moment, and a cache here would show a halted project as healthy until a restart.
 *
 * What it reads, and what it never writes: the tick home (`BM_TICK_HOME`) has exactly one writer, `tick.mjs`, so this service only ever READS under it —
 * one directory per project, named `encodeURIComponent(<abs main-checkout path>)` (`projectDir()` in `tick-lib.mjs`), holding `state.json` and `lock`. The
 * only file it writes is `settings/tick.json`, and only through `writeTickFile`. `streak`/`halted`/`haltedSince` are derived here from each project's
 * `recent` and are never stored; a Reset is a `resetAt` timestamp, nothing else.
 */

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A directory name back to the absolute main-checkout path `tick.mjs` encoded it from, or `null` for a name nothing of ours could have written:
 * `decodeURIComponent` throws (`%E0%A4%A`), the result is relative (`foo`), or it does not re-encode to the very same name (`%2f`, where `tick.mjs` writes
 * `%2F`) — so a stray directory, a hand-made one or a half-copied one is skipped rather than answered as a project whose Reset could never match anything.
 * One skipped name must never throw out of the listing: that would be a 500 blanking EVERY project's row (review focus 1).
 */
function decodeProjectDir(name: string): string | null {
  let root: string;
  try {
    root = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (!isAbsolute(root) || encodeURIComponent(root) !== name) return null;
  return root;
}

/** One file under a project's tick directory as parsed JSON: `undefined` when absent, a `{ error }` for everything else that cannot be read. */
type Slurp = { kind: 'absent' } | { kind: 'ok'; value: unknown } | { kind: 'error'; error: string };

function slurp(file: string): Slurp {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', error: `${file}: cannot be read (${e instanceof Error ? e.message : String(e)})` };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) };
  } catch (e) {
    return { kind: 'error', error: `${file}: not valid JSON (${e instanceof Error ? e.message : String(e)}) — left untouched; fix or remove it by hand` };
  }
}

type History = { ok: true; recent: TickRecentEntry[] } | { ok: false; error: string };

/**
 * A project's `recent`, oldest first as stored. The shape check is `readState`'s in `tick-state.mjs` and the error text is the same one it throws, so the row
 * says what `tick.mjs` would — "a person has to fix this file by hand". An absent file is an empty history, not an error: a first tick holding the lock has
 * not written one yet.
 */
function readHistory(dir: string): History {
  const file = join(dir, 'state.json');
  const read = slurp(file);
  if (read.kind === 'absent') return { ok: true, recent: [] };
  if (read.kind === 'error') return { ok: false, error: read.error };
  const v = read.value;
  if (!isObject(v) || !isObject(v.items) || !Array.isArray(v.recent)) {
    return { ok: false, error: `${file}: expected { "items": {…}, "recent": […] } — left untouched; fix or remove it by hand` };
  }
  return { ok: true, recent: v.recent as TickRecentEntry[] };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * `{ kind, id, host, at }` from the lock file, `null` when there is none — or none that parses to an object. A lock this server cannot read is the reader's
 * ("stale, never free") business in `tick.mjs`, not something to draw as "a tick is running" with no host or time: the board shows what it can attest to.
 * Stale-or-not is not judged here either way — the TTL is a job flag this process cannot see.
 */
function readLock(dir: string): TickLock | null {
  const read = slurp(join(dir, 'lock'));
  if (read.kind !== 'ok' || !isObject(read.value)) return null;
  const lock = read.value;
  const verdict = isObject(lock.verdict) ? lock.verdict : {};
  return { kind: str(verdict.kind), id: str(verdict.id), host: str(lock.host), at: str(lock.at) };
}

@Injectable()
export class TickService {
  constructor(private readonly registry: RegistryService) {}

  /** The whole `GET /api/ticks` answer, fresh from disk. */
  payload(): TicksPayload {
    const file = readTickFile();
    // An unreadable `tick.json` still lets every figure render (review focus 5): the default N and no Resets, for display only — the file is never replaced
    // while it is in that state, and `config.source` says so.
    const haltAfter = file.ok ? file.haltAfter : TICK_HALT_LIMITS.default;
    const resetAt = file.ok ? file.resetAt : {};
    const config: TickConfig = file.ok ? { haltAfter, source: file.source } : { haltAfter, source: 'unreadable', error: file.error };

    const names = new Map(this.registry.load().projects.map((p) => [p.path, p.name]));
    const projects: TickProject[] = [];
    for (const dirName of this.projectDirs()) {
      const root = decodeProjectDir(dirName);
      if (root === null) continue;
      projects.push(this.project(join(tickHome(), dirName), root, names.get(root) ?? basename(root), haltAfter, resetAt[root]));
    }
    return { config, projects };
  }

  private project(dir: string, root: string, name: string, haltAfter: number, resetAt: string | undefined): TickProject {
    const lock = readLock(dir);
    const history = readHistory(dir);
    const row: TickProject = { root, name, lock, recent: [] };
    if (resetAt !== undefined) row.resetAt = resetAt;
    if (!history.ok) {
      row.error = history.error;
      return row;
    }
    // Entries are served as stored, only reversed to newest first; a stored non-object is dropped rather than shipped to a client that reads `.at` off it.
    row.recent = history.recent.filter(isObject).reverse();
    const { streak, since } = streakOf(history.recent, resetAt);
    row.streak = streak;
    row.halted = streak >= haltAfter;
    if (row.halted && since !== null) row.haltedSince = since;
    return row;
  }

  /** Directory entries under the tick home — `[]` when it does not exist yet (no tick has ever run) or cannot be listed, never a throw. */
  private projectDirs(): string[] {
    try {
      return readdirSync(tickHome(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** `POST /api/ticks/config`. Throws `TickFileUnreadable` (the controller's 409) and writes nothing in that case. */
  setHaltAfter(haltAfter: number): TicksPayload {
    writeTickFile({ haltAfter }, tickFile());
    return this.payload();
  }

  /** Does the tick home hold a directory for exactly this root? The only "known project" there is — no arbitrary keys into `tick.json`. */
  knows(root: string): boolean {
    try {
      return statSync(join(tickHome(), encodeURIComponent(root))).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Stamps `resetAt[root]` with `max(now, newest parseable at in that project's recent)`, so a container clock running behind the host's can never leave
   * the newest failure "after" the Reset (review focus 3). A history that cannot be read counts as "no records" and stamps now: Reset is allowed in every
   * state, including the one where `state.json` is the broken thing a person is trying to get past, so it must never answer 500 for it. Touches no lock and
   * nothing under the tick home. Throws `TickFileUnreadable` for a `tick.json` that cannot be read.
   */
  reset(root: string): TicksPayload {
    const history = readHistory(join(tickHome(), encodeURIComponent(root)));
    let stamp = Date.now();
    if (history.ok) {
      for (const entry of history.recent) {
        const at = isObject(entry) && typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
        if (!Number.isNaN(at) && at > stamp) stamp = at;
      }
    }
    writeTickFile({ resetAt: { [root]: new Date(stamp).toISOString() } }, tickFile());
    return this.payload();
  }
}
