import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { EFFORTS, MODELS } from '../../../../shared/agent';
import type { DashboardEntry, DashboardsFile, HomeEntry, SuggestStrategy } from '../../../../shared/types';

/**
 * dashboards-file.util — `~/.backlog-manager/settings/dashboards.json`, the list of OTHER machines' dashboards this board can start work on, plus the strategy,
 * threshold and prefer order the server's suggestion reads (server-side because the server computes it, not the client). Spec:
 * docs/superpowers/specs/2026-10-22-multi-dashboard-design.md. Home — this machine, id `home` — is never in the file as a URL: its URL and token stay
 * `BM_AGENTS_URL` / `BM_AGENTS_TOKEN`, so a board with no file behaves exactly as it did before this feature existed.
 *
 * The file has exactly one writer, the server, and its posture is `tick.json`'s (`tick-breaker.util.ts`): a file that cannot be read — an I/O error that is not
 * ENOENT, text that is not JSON, JSON that is not a plain object — is `unreadable`, never "empty". The consequence is deliberately two-sided: every remote is
 * IGNORED while it is unreadable (fail closed — a typo cannot widen where work may be sent, it can only narrow it to home), and a write refuses with
 * `DashboardsFileUnreadable` (a 409 at the route) so a stray comma cannot be silently replaced by defaults with nothing left on disk to recover the old list from.
 *
 * The path is read per call, never cached (`BM_DASHBOARDS_FILE`) — a test overriding it between cases, or a person hand-editing the file, is seen at once. It
 * lives under `settings/` for the reason `watchdog-config.util.ts` gives: the one read-write directory the container has.
 *
 * Reading NORMALISES, writing does not: `readDashboardsFile` repairs what a hand edit can get wrong (clamps the threshold, drops an entry or a key that fails its
 * rule, completes the order) so every caller sees one shape, while `writeDashboardsFile` stores exactly what a route hands it — the routes validate a POST
 * body strictly (a 400, not a repair) before they get here. The reader also enforces list-level rules by dropping (first name wins
 * case-insensitively, at most 8 remotes); a POST that breaks them is a 400 at the route, not here.
 */

export const DEFAULT_STRATEGY: SuggestStrategy = 'prefer';
export const DEFAULT_THRESHOLD = 80;

const NAME_RULE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const STRATEGIES: readonly string[] = ['prefer', 'headroom', 'runway'];
const HOME_ID = 'home';
const LABEL_MAX = 24;
const ACCOUNT_MAX = 40;
const HOST_MAX = 64;
export const MAX_REMOTES = 8;

/** `$BM_DASHBOARDS_FILE`, else `~/.backlog-manager/settings/dashboards.json`. `env` is a parameter so a test can hand a plain object — the `tickFile()` shape. */
export function dashboardsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_DASHBOARDS_FILE || join(env.HOME || homedir(), '.backlog-manager', 'settings', 'dashboards.json');
}

/** The env var that holds a remote's token: `BM_AGENTS_TOKEN_` + its name uppercased. The name rule keeps this a valid, collision-free identifier. */
export function tokenVar(name: string): string {
  return `BM_AGENTS_TOKEN_${name.toUpperCase()}`;
}

export type DashboardsFileRead = { source: 'file' | 'default'; value: DashboardsFile } | { source: 'unreadable'; reason: string };

/** Thrown by `writeDashboardsFile` when the file EXISTS but cannot be read; a route maps it to 409, and an I/O failure in the write itself stays a 500. */
export class DashboardsFileUnreadable extends Error {
  constructor(
    readonly file: string,
    reason: string
  ) {
    super(`${file} unreadable (${reason}) — fix or remove it by hand; nothing was written`);
    this.name = 'DashboardsFileUnreadable';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `ids` are the configured remote names. The result always holds `home` plus every id exactly once: unknown ids and repeats in `order` are dropped, and what it
 * left out is appended — `home` first, then the remotes in configured order — so a machine added after the person arranged the list lands at the end, not nowhere.
 */
export function normaliseOrder(order: unknown, ids: readonly string[]): string[] {
  const known = new Set<string>([HOME_ID, ...ids]);
  const out: string[] = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
  }
  for (const id of [HOME_ID, ...ids]) if (!out.includes(id)) out.push(id);
  return out;
}

// A URL string as its http(s) origin (path, query and fragment dropped), else null. `new URL` throws on a string with no scheme or with whitespace in the host.
function originOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

// A non-empty subset of `allowed`, deduplicated and in the order given; null when it is not one (not an array, empty, or holding a string outside the list).
function subsetOf(v: unknown, allowed: readonly string[]): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !allowed.includes(x)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * One remote entry's shape, and nothing about the list it sits in. Returns the entry as it is to be stored — urls reduced to origins, account trimmed — or the
 * message for a 400. The checks run in a fixed order so the first thing wrong is the one reported: name, reserved, url, bmUrl, host, account, models, efforts.
 * `null` for an optional key reads as absent, because a form that clears a field sends it that way.
 */
export function validateEntry(body: unknown): DashboardEntry | string {
  if (!isPlainObject(body)) return 'entry must be an object';
  const { name, host } = body;
  if (typeof name !== 'string' || !NAME_RULE.test(name)) return 'name must match ^[A-Za-z][A-Za-z0-9]{0,23}$';
  if (name.toLowerCase() === HOME_ID) return `name "${HOME_ID}" is reserved`;
  const url = originOf(body.url);
  if (url === null) return 'url must be an http(s) origin';
  const bmUrl = originOf(body.bmUrl);
  if (bmUrl === null) return 'bmUrl must be an http(s) origin';
  if (typeof host !== 'string' || host.length < 1 || host.length > HOST_MAX || /\s/.test(host))
    return `host must be 1–${HOST_MAX} characters with no whitespace`;
  const entry: DashboardEntry = { name, url, bmUrl, host };
  if (body.account !== undefined && body.account !== null) {
    if (typeof body.account !== 'string') return 'account must be a string';
    const account = body.account.trim();
    if (account.length > ACCOUNT_MAX) return `account must be at most ${ACCOUNT_MAX} characters`;
    if (account) entry.account = account;
  }
  if (body.models !== undefined && body.models !== null) {
    const models = subsetOf(body.models, MODELS);
    if (!models) return `models must be a non-empty subset of ${MODELS.join(', ')}`;
    entry.models = models;
  }
  if (body.efforts !== undefined && body.efforts !== null) {
    const efforts = subsetOf(body.efforts, EFFORTS);
    if (!efforts) return `efforts must be a non-empty subset of ${EFFORTS.join(', ')}`;
    entry.efforts = efforts;
  }
  return entry;
}

// Home's presentation, repaired key by key: a key that fails its rule is dropped (so it falls back to its default) and the others survive.
function normaliseHome(v: unknown): HomeEntry | undefined {
  if (!isPlainObject(v)) return undefined;
  const home: HomeEntry = {};
  if (typeof v.label === 'string') {
    const label = v.label.trim();
    if (label.length >= 1 && label.length <= LABEL_MAX) home.label = label;
  }
  if (typeof v.account === 'string') {
    const account = v.account.trim();
    if (account.length >= 1 && account.length <= ACCOUNT_MAX) home.account = account;
  }
  const models = subsetOf(v.models, MODELS);
  if (models) home.models = models;
  const efforts = subsetOf(v.efforts, EFFORTS);
  if (efforts) home.efforts = efforts;
  return Object.keys(home).length ? home : undefined;
}

// An integer clamps into 1–100; anything else (a string, a float, null, absent) is the default — `clampHaltAfter`'s rule.
function clampThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return DEFAULT_THRESHOLD;
  return Math.min(100, Math.max(1, v));
}

function normalise(obj: Record<string, unknown>): DashboardsFile {
  // An entry that fails `validateEntry` is dropped, not repaired and not fatal: one bad row in a hand-edited list must not take the good ones with it, and a
  // dropped remote is the fail-closed direction (work goes to home, never to a machine the rule did not vouch for). Two more rules, for the same reason: the
  // FIRST entry per lowercased name wins and a later one is dropped (names are machine ids and, uppercased, token env vars, so `Pro` and `pro` would share a
  // token and be indistinguishable on the wire), and only the first MAX_REMOTES valid entries are kept. Both run before `order` is normalised, so it sees
  // only the ids that survived. The routes refuse both as a 400 on a POST; this is the reader's repair for a file a person edited by hand.
  const dashboards: DashboardEntry[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(obj.dashboards) ? obj.dashboards : []) {
    if (dashboards.length >= MAX_REMOTES) break;
    const entry = validateEntry(raw);
    if (typeof entry === 'string' || seen.has(entry.name.toLowerCase())) continue;
    seen.add(entry.name.toLowerCase());
    dashboards.push(entry);
  }
  const value: DashboardsFile = { dashboards };
  const home = normaliseHome(obj.home);
  if (home) value.home = home;
  value.order = normaliseOrder(
    obj.order,
    dashboards.map((d) => d.name)
  );
  value.strategy = typeof obj.strategy === 'string' && STRATEGIES.includes(obj.strategy) ? (obj.strategy as SuggestStrategy) : DEFAULT_STRATEGY;
  value.threshold = clampThreshold(obj.threshold);
  return value;
}

/**
 * The three answers, never a throw:
 *   - no file                                  → `default`, home only — the common case, and what every board had before this feature;
 *   - a file that parses to a plain object     → `file`, normalised (see the header);
 *   - anything else (EISDIR, EACCES, not JSON, `[]`, `null`) → `unreadable` with a reason; callers ignore every remote and refuse writes.
 */
export function readDashboardsFile(file: string = dashboardsFile()): DashboardsFileRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { source: 'default', value: normalise({}) };
    return { source: 'unreadable', reason: e instanceof Error ? e.message : String(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { source: 'unreadable', reason: `${file} does not parse as JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isPlainObject(parsed)) return { source: 'unreadable', reason: `${file} is not a JSON object` };
  return { source: 'file', value: normalise(parsed) };
}

/**
 * The one write path. Refuses (`DashboardsFileUnreadable`, file untouched) when the current file is unreadable, then writes `next` as given: tmp + rename in the
 * SAME directory, so the rename is atomic on one filesystem, a concurrent reader sees the old complete file or the new one and never half of one, and the rename
 * IS the cleanup — no temp file is left behind. A failure before the rename leaves the old file as it was.
 */
export function writeDashboardsFile(next: DashboardsFile, file: string = dashboardsFile()): void {
  const current = readDashboardsFile(file);
  if (current.source === 'unreadable') throw new DashboardsFileUnreadable(file, current.reason);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.dashboards.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (e) {
    // A write or rename that fails must not strand its temp file: "no temp file is left behind" holds on the failure path too.
    rmSync(tmp, { force: true });
    throw e;
  }
}
