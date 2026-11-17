import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../atomic-write.util';
import { DEFAULT_GITLAB_INTERVAL, isSyncInterval, type SyncInterval } from '../../../shared/types';

/**
 * sync-config.util.ts — ~/.backlog-manager/settings/gitlab-sync.json (#527).
 *
 * Follows `server/src/tracker/sync-config.util.ts` point for point, and that header's arguments hold here unchanged: the file lives under `settings/` because
 * that is the one read-write directory carved out of the read-only `~/.backlog-manager` mount, it is read fresh on every call and cached nowhere, every
 * failure READS as the default and never throws, the one write goes through `writeJsonAtomic`, and the WRITE refuses a file that exists but does not parse
 * rather than replacing it (#270) — a hand-edit with one stray comma is somebody's intent, and nothing on disk could recover it once rewritten.
 *
 * What differs is the shape. The tracker's file is a map keyed by `owner/name`, because the repo is the unit its poller syncs; GitLab's poller reads every
 * mapped project in ONE sweep, so its cadence is one value per machine (#527, decision 1) and the file is `{ "interval": "<SyncInterval>" }`. An object
 * rather than a bare string, so a later per-site key has room — and a bare string in the file is therefore NOT read as a value, only as a malformed file.
 * The default is `DEFAULT_GITLAB_INTERVAL` (`1m`), not the tracker's `15s`.
 */

/** The file, or `BM_GITLAB_SYNC_FILE` when set and non-empty — `syncConfigFile()`'s shape, `env` a parameter so a test can resolve the default path. */
export function gitlabSyncFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_GITLAB_SYNC_FILE || join(homedir(), '.backlog-manager', 'settings', 'gitlab-sync.json');
}

/**
 * The effective interval: the file's `interval` when it holds one of the four tokens, `DEFAULT_GITLAB_INTERVAL` for every other case — a missing file,
 * JSON that does not parse, JSON that is not a plain object (`null`, an array, a bare string), a missing key or a value `isSyncInterval` rejects. Never
 * throws; the two cases a person would want to know about (unparsable, non-object) warn once per read, naming the file, as the tracker's reader does.
 */
export function readGitlabInterval(file: string = gitlabSyncFile()): SyncInterval {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return DEFAULT_GITLAB_INTERVAL;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(`${file}: exists but does not parse as JSON — GitLab sweeps at ${DEFAULT_GITLAB_INTERVAL}`);
    return DEFAULT_GITLAB_INTERVAL;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`${file}: parsed but is not an object — GitLab sweeps at ${DEFAULT_GITLAB_INTERVAL}`);
    return DEFAULT_GITLAB_INTERVAL;
  }
  const value = Object.prototype.hasOwnProperty.call(raw, 'interval') ? (raw as Record<string, unknown>).interval : undefined;
  return isSyncInterval(value) ? value : DEFAULT_GITLAB_INTERVAL;
}

/**
 * Thrown by `writeGitlabInterval` when the file EXISTS but cannot be read as JSON (or cannot be read at all, for any reason but not existing), and mapped
 * to a 409 by `POST /api/gitlab/sync`. A class so the route can tell this refusal — a state of the file the user has to repair by hand — from an I/O
 * failure in the write itself, which stays a 500. `SyncConfigUnreadableError`'s twin.
 */
export class GitlabSyncUnreadableError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`settings/gitlab-sync.json ${reason} — fix or delete it by hand; nothing was written`);
    this.name = 'GitlabSyncUnreadableError';
  }
}

/**
 * Set the interval and rewrite the whole file atomically — called by `POST /api/gitlab/sync` and nothing else, so this is the file's one writer. Every
 * other key in a parsed object survives (a hand-added key is somebody's intent); a missing file is written fresh; a file that parsed but is not an object
 * is replaced by `{ interval }`, since it holds no key to preserve. A file that exists but does not parse, or cannot be read for any reason other than
 * ENOENT, is refused with `GitlabSyncUnreadableError` and left byte-identical — `writeSyncInterval`'s contract (#270), for the same reason.
 */
export function writeGitlabInterval(interval: SyncInterval, file: string = gitlabSyncFile()): void {
  let current: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`${file}: cannot be read (${(e as Error).message}) — refusing to overwrite it`);
      throw new GitlabSyncUnreadableError(file, 'cannot be read');
    }
  }
  if (text !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      console.warn(`${file}: exists but does not parse as JSON — refusing to overwrite it`);
      throw new GitlabSyncUnreadableError(file, 'does not parse as JSON');
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) current = raw as Record<string, unknown>;
  }
  writeJsonAtomic(file, { ...current, interval });
}
