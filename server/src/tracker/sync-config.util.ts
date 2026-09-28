import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_SYNC_INTERVAL, isSyncInterval, type SyncInterval } from '../../../shared/types';

/**
 * sync-config.util.ts — ~/.backlog-manager/settings/tracker-sync.json (#17).
 *
 * The third file this server writes, after `watchdog.json` and the pause-control files, and it follows `watchdog-config.util.ts` on every point that
 * header argues at length: it lives under `settings/` because that is the one read-write directory carved out of the read-only `~/.backlog-manager` mount,
 * it is read fresh on every call and cached nowhere, every failure reads as the default and never throws, and the one write is temp file plus rename.
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
 * included, whatever `typeof` says). Separate from `readSyncConfig` because the WRITER needs the invalid entries too: it rewrites the whole file and must not
 * drop a key it did not understand.
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
 * Set one repo's interval and rewrite the whole file atomically — called by `POST /api/trackers/sync` and nothing else. Every other key survives,
 * invalid ones included (see the header); a file that was not an object to begin with is replaced by one holding only this key, since there was nothing in
 * it to preserve.
 */
export function writeSyncInterval(repo: string, interval: SyncInterval, file: string = syncConfigFile()): void {
  const next = { ...(readRaw(file) ?? {}), [repo]: interval };
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tracker-sync.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
}
