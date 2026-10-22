import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { TICK_HALT_LIMITS, type TickRecentEntry } from '../../../shared/types';

/**
 * tick-breaker.util.ts — the tick breaker's streak rule, and `~/.backlog-manager/settings/tick.json`, which says how many failures in a row halt a project and
 * when each project was last Reset.
 *
 * This is the SECOND COPY of the streak rule; the first is `skills/backlog-tick/tools/tick-breaker.mjs`, and each header points at the other. They are two
 * copies and not one import because this server may not import from `skills/` and a plugin skill's `tools/` may never import from `server/` or `shared/`
 * (an install is a copy of whatever shipped) — the `pauseRequestEffective` precedent: `pause-control.util.ts` here and `orchestrate.mjs` each carry a
 * byte-equivalent rule, and the guard against drift is a suite on each side. `test/tick-breaker.test.ts` carries the SAME `streakOf` table, row for row, as
 * `tick-breaker.test.mjs`, so changing the rule on one side fails the other side's tests rather than letting `tick.mjs decide` stop a project the board shows
 * as healthy, or the reverse. "Parseable" is `Date.parse` not being NaN on both sides, for the same reason.
 *
 * Nothing stores a `halted` flag. The streak is derived from a project's `recent` on every read, so lowering N below a streak halts the project at the next
 * `decide`, raising N un-halts it, and a Reset is nothing but a `resetAt` timestamp this file's writer records.
 *
 * `tick.json` has exactly one writer, the server, and the reader on the other side is `tick.mjs`. Its posture is `jira.json`'s — a file that cannot be read is
 * never replaced — but STRICTER on one point: a file that parses to something that is not a plain object (`[]`, `null`, a bare string) is unreadable here.
 * `jira.json` treats that as empty because there is nothing in it to lose; here a person who has just hand-edited their way to `[]` is an edit in flight, and
 * reading it as "3, no resets" would silently re-arm a breaker they had just reset. Both write routes refuse it with a 409 until a person fixes it by hand.
 * It lives under `settings/` for the mount reason `watchdog-config.util.ts` spells out: that is the one read-write directory the container has.
 *
 * Both paths are read per call, never cached (`BM_TICK_FILE`, `BM_TICK_HOME`) — a test overriding them between cases must see the override.
 */

/**
 * `~/.backlog-manager/settings/tick.json`, or `BM_TICK_FILE` when set. `env` is a parameter so a test can hand a plain object without mutating the
 * process-wide environment — the `watchdogFile()` shape.
 */
export function tickFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_TICK_FILE || join(homedir(), '.backlog-manager', 'settings', 'tick.json');
}

/**
 * `~/.backlog-manager/tick/` — where `tick.mjs` keeps each project's `state.json` and lock — or `BM_TICK_HOME` when set. This server only ever READS under it:
 * the tick home has exactly one writer, `tick.mjs`, and a Reset is a `resetAt` in `tick.json` precisely so that nothing here has to write there.
 */
export function tickHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_TICK_HOME || join(homedir(), '.backlog-manager', 'tick');
}

// An ISO string `Date.parse` accepts, as ms since epoch, else `NaN`. One place so the walk and the file reader cannot disagree about "parseable".
function atMs(v: unknown): number {
  return typeof v === 'string' ? Date.parse(v) : NaN;
}

/**
 * Consecutive failures at the NEWEST end of `recent` (stored oldest first). Walk newest to oldest and, for each entry, in this order:
 *   1. an `at` that does not parse stops the walk — checked FIRST, whatever the outcome, so a corrupt record is "older than everything" and can never extend a
 *      streak or hide behind an `ok` it does not have;
 *   2. an `at` at or before `resetAt` stops it — a Reset clears everything it covered, including a failure stamped the very same millisecond;
 *   3. `ok` stops it;
 *   4. `failed` counts;
 *   5. any other outcome neither counts nor stops — none is written today, and a future one must not silently reset a streak.
 * `since` is the `at` of the OLDEST counted entry, `null` when nothing counted. An unparseable `resetAt` is absent. `recent` is `unknown`-tolerant on purpose:
 * it comes off a file, so a non-array or a non-object entry reads as an unparseable `at` and this never throws.
 */
export function streakOf(recent: readonly TickRecentEntry[], resetAt: string | undefined): { streak: number; since: string | null } {
  const resetMs = atMs(resetAt);
  let streak = 0;
  let since: string | null = null;
  const entries: readonly unknown[] = Array.isArray(recent) ? recent : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i];
    const entry = (raw !== null && typeof raw === 'object' ? raw : {}) as Partial<TickRecentEntry>;
    const ms = atMs(entry.at);
    if (Number.isNaN(ms)) break;
    if (!Number.isNaN(resetMs) && ms <= resetMs) break;
    if (entry.outcome === 'ok') break;
    if (entry.outcome === 'failed') {
      streak++;
      since = entry.at as string;
    }
  }
  return { streak, since };
}

/** An integer clamps into the limits; anything else — a string, a float, null, a missing key — is the default (the `clampAttempts` rule). */
function clampHaltAfter(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return TICK_HALT_LIMITS.default;
  return Math.min(TICK_HALT_LIMITS.max, Math.max(TICK_HALT_LIMITS.min, v));
}

export type TickFileRead =
  | { ok: true; haltAfter: number; resetAt: Record<string, string>; source: 'default' | 'file' }
  | { ok: false; file: string; error: string };

/**
 * The three shapes of answer, never a throw:
 *   - no file                              → `{ ok: true, source: 'default' }` — never configured, the common case;
 *   - a file that parses to a plain object → `{ ok: true, source: 'file' }`, `haltAfter` clamped and `resetAt` reduced to its usable entries;
 *   - ANYTHING else (an I/O error that is not ENOENT — EISDIR, EACCES —, text that is not JSON, JSON that is an array or `null`) → `{ ok: false, file, error }`.
 * The last is never read as the default: see the header — `decide` answers `idle` naming the file, and the board shows `source: 'unreadable'`.
 */
export function readTickFile(file: string = tickFile()): TickFileRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, haltAfter: TICK_HALT_LIMITS.default, resetAt: {}, source: 'default' };
    return { ok: false, file, error: e instanceof Error ? e.message : String(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, file, error: e instanceof Error ? e.message : String(e) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, file, error: 'not a JSON object' };
  const obj = parsed as Record<string, unknown>;
  const resetAt: Record<string, string> = {};
  if (obj.resetAt !== null && typeof obj.resetAt === 'object' && !Array.isArray(obj.resetAt)) {
    // An entry that is not a parseable ISO string is DROPPED, not repaired: `streakOf` would treat it as absent anyway, and carrying it would let a reader that
    // trusts `resetAt` for display print a value the rule ignored. `__proto__` is skipped because assigning it would set the result's prototype, not add a key.
    for (const [project, at] of Object.entries(obj.resetAt as Record<string, unknown>)) {
      if (project !== '__proto__' && !Number.isNaN(atMs(at))) resetAt[project] = at as string;
    }
  }
  return { ok: true, haltAfter: clampHaltAfter(obj.haltAfter), resetAt, source: 'file' };
}

/**
 * Thrown by `writeTickFile` when the file EXISTS but `readTickFile` cannot read it, and mapped to a 409 by both write routes (Task 4). A class so a route can
 * tell this refusal — a state of the file a person has to repair by hand — from an I/O failure in the write itself, which stays a 500.
 */
export class TickFileUnreadable extends Error {
  constructor(readonly file: string, reason: string) {
    super(`${file} unreadable (${reason}) — fix or remove it by hand; nothing was written`);
    this.name = 'TickFileUnreadable';
  }
}

/**
 * The one write path for `tick.json`. Reads the current file first and refuses (`TickFileUnreadable`, file untouched) if it is unreadable: rewriting from
 * defaults would turn a stray comma into "3, no resets" with nothing on disk left to recover the old values from. Otherwise `haltAfter` replaces the current
 * one only when the patch carries it (clamped), and `resetAt` merges KEY-WISE over the current map — resetting one project must not forget another's Reset.
 *
 * Written tmp + rename, the same atomic way `writeWatchdogConfig` and `writeSyncInterval` are: the temp file is in the SAME directory, so the rename is one
 * filesystem and atomic at the OS level, a `tick.mjs` reading concurrently sees the old complete file or the new complete one and never half of one, and the
 * rename IS the cleanup — no temp file is left behind. A write that fails before the rename leaves the old file as it was.
 */
export function writeTickFile(patch: { haltAfter?: number; resetAt?: Record<string, string> }, file: string = tickFile()): void {
  const current = readTickFile(file);
  if (!current.ok) throw new TickFileUnreadable(file, current.error);
  const next = {
    haltAfter: patch.haltAfter !== undefined ? clampHaltAfter(patch.haltAfter) : current.haltAfter,
    resetAt: { ...current.resetAt, ...(patch.resetAt ?? {}) }
  };
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tick.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
}
