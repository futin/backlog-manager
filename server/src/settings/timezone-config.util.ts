import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * timezone-config.util.ts — ~/.backlog-manager/settings/timezone.json (#241).
 *
 * The one zone every clock, day group, week window and created date on the board is drawn in, so a phone, a laptop and a tailnet browser looking at the same
 * run read the same times. It follows `sync-config.util.ts` and `watchdog-config.util.ts` on every point those headers argue: it lives under `settings/`
 * because that is the one read-write directory carved out of the read-only `~/.backlog-manager` mount, it is read fresh on every call and cached nowhere,
 * every failure reads as the default and never throws, and the one write is temp file plus rename.
 *
 * The default is `null` — "unset", each browser keeps its own zone — and NOT this host's zone: the API runs in a container whose zone is `UTC` unless somebody
 * set `TZ`, so defaulting to it would move every reading by hours for the person who never opened Settings.
 *
 * The server never formats or buckets a date itself. It only stores, validates and canonicalises the id; every reading is the client's
 * (`client/src/lib/time-zone.ts`).
 *
 * One departure from the newer settings files (`jira.json`, `tick.json`, `dashboards.json`), which refuse to replace a file they cannot read: this file holds
 * one value and the write replaces that value whole, so a file that does not parse has nothing in it a write could lose — the person choosing a zone is the
 * repair.
 */

/** The file, or `BM_TIMEZONE_FILE` when set — `syncConfigFile()`'s shape, `env` a parameter for the same reason. */
export function timeZoneFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_TIMEZONE_FILE || join(homedir(), '.backlog-manager', 'settings', 'timezone.json');
}

/**
 * The canonical IANA id for a zone the platform accepts, else `null`.
 *
 * The check is constructing a formatter in that zone — it throws `RangeError` for an id the platform does not know — and the answer is the formatter's own
 * `resolvedOptions().timeZone`, which canonicalises case and aliases (`europe/belgrade` → `Europe/Belgrade`, `Etc/UTC` → `UTC`), so two spellings of one zone
 * can never be stored as two settings. Not `Intl.supportedValuesOf('timeZone')`: that list leaves out `UTC`, which every engine accepts.
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The stored zone, canonical, or `null` for every way the file can fail to name one — missing, not JSON, not an object, no `timeZone` key, or a zone this
 * platform rejects. Never throws; the parse and shape failures warn the way `sync-config.util.ts` does, so a hand-edit gone wrong is visible in the log.
 */
export function readTimeZone(file: string = timeZoneFile()): string | null {
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
    console.warn(`${file}: exists but does not parse as JSON — every browser uses its own time zone`);
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`${file}: parsed but is not an object — every browser uses its own time zone`);
    return null;
  }
  return canonicalTimeZone((raw as { timeZone?: unknown }).timeZone);
}

/**
 * Write `{ timeZone }` atomically — temp file in the same directory, then rename — creating the directory when it is missing, and return what was written.
 * Called by `POST /api/settings/timezone` and nothing else; the route has already canonicalised `zone`.
 */
export function writeTimeZone(zone: string | null, file: string = timeZoneFile()): string | null {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.timezone.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify({ timeZone: zone }, null, 2) + '\n');
  renameSync(tmp, file);
  return zone;
}
