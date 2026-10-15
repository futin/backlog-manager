import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_SYNC_INTERVAL, isSyncInterval, type SyncInterval } from '../../../shared/types';

/**
 * sync-config.util.ts — ~/.backlog-manager/settings/tracker-sync.json (#17).
 *
 * The third file this server writes, after `watchdog.json` and the pause-control files, and it follows `watchdog-config.util.ts` on every point that
 * header argues at length: it lives under `settings/` because that is the one read-write directory carved out of the read-only `~/.backlog-manager` mount,
 * it is read fresh on every call and cached nowhere, every failure reads as the default and never throws, and the one write is temp file plus rename. One
 * departure (#270): the WRITE refuses a file that exists but does not parse, rather than replacing it — see `writeSyncInterval`.
 *
 * What differs is the shape. The watchdog's file is one fixed object whose every field has a range to clamp into; this one is a MAP keyed by `owner/name`,
 * because the repo is the unit the poller syncs (`connectedRepos` already dedups by repo) and two registered projects on one repo must not be able to
 * disagree. So validation is per ENTRY, not per file: a bad value costs only its own repo its setting (it reads `15s`), never its neighbours. Keys match by
 * exact string — `Futin/X` is not `futin/x` — because `isRepo` accepts either spelling and guessing a case-folding GitHub may or may not apply would be a
 * second opinion about identity this server has no business holding.
 *
 * Keys for repos no longer connected are kept, on read and on write alike: disconnecting a project and reconnecting it later restores its setting, and a
 * hand-edited key nobody here recognises is somebody's intent, not litter.
 */

/** The file, or `BM_TRACKER_SYNC_FILE` when set — `watchdogFile()`'s shape, `env` a parameter for the same reason. */
export function syncConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_TRACKER_SYNC_FILE || join(homedir(), '.backlog-manager', 'settings', 'tracker-sync.json');
}

/**
 * The raw parsed object, or `null` for every way the file can fail to be one — missing, not JSON, or JSON that is not a plain object (`null` and arrays
 * included, whatever `typeof` says). The READERS' view only: the writer reads the file itself, because it must tell "missing" from "unparsable" — the one
 * it writes fresh, the other it refuses — and this function folds both into `null`.
 */
function readRaw(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(`${file}: exists but does not parse as JSON — every repo syncs at ${DEFAULT_SYNC_INTERVAL}`);
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`${file}: parsed but is not an object — every repo syncs at ${DEFAULT_SYNC_INTERVAL}`);
    return null;
  }
  return raw as Record<string, unknown>;
}

/** Only the entries whose value is one of the four tokens — what the file actually SAYS, after spec §4's defaults have thrown out the rest. */
export function readSyncConfig(file: string = syncConfigFile()): Record<string, SyncInterval> {
  const raw = readRaw(file);
  const out: Record<string, SyncInterval> = {};
  if (raw === null) return out;
  // `__proto__` is skipped because assigning it would set the result's prototype rather than add a key, and no `owner/name` is spelled that way.
  for (const [repo, value] of Object.entries(raw)) if (repo !== '__proto__' && isSyncInterval(value)) out[repo] = value;
  return out;
}

/** The effective interval for one repo: its entry when it holds a token, `15s` for every other case in spec §4's table. */
export function intervalFor(repo: string, file: string = syncConfigFile()): SyncInterval {
  const raw = readRaw(file);
  const value = raw !== null && Object.prototype.hasOwnProperty.call(raw, repo) ? raw[repo] : undefined;
  return isSyncInterval(value) ? value : DEFAULT_SYNC_INTERVAL;
}

/**
 * Thrown by `writeSyncInterval` when the file EXISTS but cannot be read as JSON (or cannot be read at all, for any reason other than not existing), and
 * mapped to a 409 by `POST /api/trackers/sync`. A class rather than a bare `Error` so the route can tell this refusal — a state of the file the user has to
 * repair by hand — from an I/O failure in the write itself, which stays a 500.
 */
export class SyncConfigUnreadableError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`settings/tracker-sync.json ${reason} — fix or delete it by hand; nothing was written`);
    this.name = 'SyncConfigUnreadableError';
  }
}

/**
 * Set one repo's interval and rewrite the whole file atomically — called by `POST /api/trackers/sync` and nothing else. Every other key survives,
 * invalid ones included (see the header); a missing file is written fresh, and a file that parsed but was not an object (`[]`, `null`, a bare string) is
 * replaced by one holding only this key, since there is no `owner/name` key in it to preserve.
 *
 * A file that does NOT parse is refused instead (`SyncConfigUnreadableError`) and left exactly as it is. The readers may treat it as empty — reading every
 * repo as `15s` is a safe default for one tick and costs nothing permanent — but the writer may not: rewriting the whole file from `{}` would turn a
 * hand-edit with one stray comma, or a file truncated by a full disk, into a file holding only the repo being changed, every other repo's setting silently
 * gone and back to `15s` with nothing on disk left to recover them from (#270). The same goes for a read that fails for any reason but ENOENT: we cannot
 * know what is in a file we could not read, so we must not replace it.
 */
export function writeSyncInterval(repo: string, interval: SyncInterval, file: string = syncConfigFile()): void {
  let current: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`${file}: cannot be read (${(e as Error).message}) — refusing to overwrite it`);
      throw new SyncConfigUnreadableError(file, 'cannot be read');
    }
  }
  if (text !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      console.warn(`${file}: exists but does not parse as JSON — refusing to overwrite it, so no other repo's interval is lost`);
      throw new SyncConfigUnreadableError(file, 'does not parse as JSON');
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) current = raw as Record<string, unknown>;
  }
  const next = { ...current, [repo]: interval };
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tracker-sync.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
}
