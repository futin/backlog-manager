// The tick's failure breaker — what counts as "N failures in a row" — and the settings file, `tick.json`, which says what N is and what the two caps are
// when a job's `--max-plans` / `--max-prs` flag does not (#378). Read-only — nothing here writes a byte.
//
// This is ONE OF TWO COPIES of the streak rule. The other is `server/src/tick/tick-breaker.util.ts` (it cites this file back), and they are two
// copies and not one import because a plugin skill's `tools/` may never import from `server/` or `shared/` (CLAUDE.md Invariants — an install is a copy of
// whatever shipped). It is the `pauseRequestEffective` precedent exactly: `server/src/orchestrator/pause-control.util.ts` and `orchestrate.mjs` each carry a
// byte-equivalent rule, and the guard against drift is a suite on each side. Here that guard is `tick-breaker.test.mjs`'s `streakOf` table; the server's suite
// carries the SAME table, so changing the rule on one side fails the other side's tests rather than letting `decide` stop a project the board shows as healthy.
//
// Nothing stores a `halted` flag. The streak is derived from `state.json`'s `recent` on every read (`tick-state.mjs` writes it), so lowering N below a
// project's streak halts it at the next `decide`, raising N un-halts it, and a Reset is nothing but a `resetAt` timestamp the server writes into `tick.json`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HALT_DEFAULT = 3;
export const HALT_MIN = 1;
export const HALT_MAX = 10;

// The two caps' machine-wide defaults and their range — the SECOND hand copy of `TICK_CAP_LIMITS` in `shared/types.ts` (the first, which the server's
// `tick-breaker.util.ts` reads), for the same no-import reason as the streak rule above. The range is the setting's, never the flag's: `--max-plans 0` still
// means "this job never grooms", a schedule-level choice `parseDecide` accepts as it always did, while a machine default of 0 would silently stop every job.
export const MAX_PLANS_DEFAULT = 3;
export const MAX_PRS_DEFAULT = 2;
export const CAP_MIN = 1;
export const CAP_MAX = 10;

// --- where the settings live ---------------------------------------------

// `$BM_TICK_FILE` when set, else `~/.backlog-manager/settings/tick.json`. Read per call and cached nowhere, like `tickHome()` in `tick-lib.mjs`: the override
// exists so a test process, or a developer poking at the tool by hand, never reads or touches a real machine's settings. The server is this file's only writer.
export function tickSettingsFile() {
  return process.env.BM_TICK_FILE || path.join(os.homedir(), '.backlog-manager', 'settings', 'tick.json');
}

// --- the settings reader -------------------------------------------------

// An integer clamps into 1–10; anything else — a string, a float, null, a missing key — is the default. A hand-edited `"7"` or `2.5` is not guessed at: the
// file's author most likely meant something, and 3 is the documented default. (The server's POST is stricter: a non-integer is a 400.)
export function clampHaltAfter(v) {
  return clampSetting(v, HALT_DEFAULT, HALT_MIN, HALT_MAX);
}

// The one clamp rule every number in `tick.json` follows — `haltAfter` and both caps — so a hand-edited `"5"` reads the same way whichever key it sits under.
export function clampSetting(v, fallback, min, max) {
  if (!Number.isInteger(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// An ISO string `Date.parse` accepts, as ms since epoch, else `NaN`. One place so the walk and the settings reader cannot disagree about "parseable".
function atMs(v) {
  return typeof v === 'string' ? Date.parse(v) : NaN;
}

// The three shapes of answer:
//   - no file                      → `{ ok: true, source: 'default' }` — the project has never been configured, which is the common case;
//   - a file that parses to a plain object → `{ ok: true, source: 'file' }` with `haltAfter`, `maxPlans` and `maxPrs` clamped and `resetAt` reduced to its
//     usable entries;
//   - ANYTHING else (an I/O error that is not ENOENT — EISDIR, EACCES —, text that is not JSON, JSON that is an array or `null`) → `{ ok: false, file, error }`.
// The last is never read as the default: a settings file somebody left half-written is evidence of an edit in flight, and treating it as "3, no resets" would
// silently re-arm a breaker the person had just reset. `decide` answers `idle` naming the file instead. Never throws.
export function readTickSettings(file = tickSettingsFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, haltAfter: HALT_DEFAULT, maxPlans: MAX_PLANS_DEFAULT, maxPrs: MAX_PRS_DEFAULT, resetAt: {}, source: 'default' };
    }
    return { ok: false, file, error: e instanceof Error ? e.message : String(e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, file, error: e instanceof Error ? e.message : String(e) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, file, error: 'not a JSON object' };
  const resetAt = {};
  if (parsed.resetAt !== null && typeof parsed.resetAt === 'object' && !Array.isArray(parsed.resetAt)) {
    // An entry that is not a parseable ISO string is DROPPED, not repaired: `streakOf` would treat it as absent anyway, and carrying it would let a reader that
    // trusts `resetAt` for display print a value the rule ignored.
    for (const [project, at] of Object.entries(parsed.resetAt)) if (!Number.isNaN(atMs(at))) resetAt[project] = at;
  }
  return {
    ok: true,
    haltAfter: clampHaltAfter(parsed.haltAfter),
    maxPlans: clampSetting(parsed.maxPlans, MAX_PLANS_DEFAULT, CAP_MIN, CAP_MAX),
    maxPrs: clampSetting(parsed.maxPrs, MAX_PRS_DEFAULT, CAP_MIN, CAP_MAX),
    resetAt,
    source: 'file'
  };
}

// --- the streak ----------------------------------------------------------

// Consecutive failures at the NEWEST end of `recent` (oldest first, as `tick-state.mjs` stores it). Walk newest to oldest and, for each entry, in this order:
//   1. an `at` that does not parse stops the walk — checked FIRST, whatever the outcome, so a corrupt record is "older than everything" and can never extend a
//      streak or hide behind an `ok` it does not have;
//   2. an `at` at or before `resetAt` stops it — a Reset clears everything it covered, including a failure stamped the very same millisecond;
//   3. `ok` stops it;
//   4. `failed` counts;
//   5. any other outcome neither counts nor stops — none is written today, and a future one must not silently reset a streak.
// `since` is the `at` of the OLDEST counted entry (what the `status` line and the board print), `null` when nothing counted. An unparseable `resetAt` is absent.
// Anything malformed — `recent` not an array, an entry that is not an object — reads as an unparseable `at`, so this never throws.
export function streakOf(recent, resetAt) {
  const resetMs = atMs(resetAt);
  let streak = 0;
  let since = null;
  const entries = Array.isArray(recent) ? recent : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const ms = atMs(entry && typeof entry === 'object' ? entry.at : undefined);
    if (Number.isNaN(ms)) break;
    if (!Number.isNaN(resetMs) && ms <= resetMs) break;
    if (entry.outcome === 'ok') break;
    if (entry.outcome === 'failed') {
      streak++;
      since = entry.at;
    }
  }
  return { streak, since };
}
