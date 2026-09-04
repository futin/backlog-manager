import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_WATCHDOG_CONFIG, WATCHDOG_LIMITS, type WatchdogConfig } from '../../../shared/types';

/**
 * watchdog-config.util.ts — ~/.backlog-manager/settings/watchdog.json.
 *
 * This is the first file this server has ever written. Every other JSON
 * file it touches is a read-only view of something a skill's CLI owns:
 * `registry.json` belongs to `backlog.mjs`, a project's `run.json` belongs
 * to `orchestrate.mjs` (CLAUDE.md's "exactly one writer" invariants, both of
 * them). Neither skill has anything to say about how eagerly THIS server
 * watches for a crashed run — that is not a fact about a backlog item or an
 * orchestrator run, it is a fact about this process's own behaviour — so
 * there is no existing single-writer file for it to join, and `settings/` is
 * a directory neither `backlog.mjs` nor `orchestrate.mjs` ever reads. It
 * exists as its own nested directory (rather than a file dropped straight
 * into `~/.backlog-manager`) for exactly one reason: docker-compose.yml
 * mounts `~/.backlog-manager` read-only for everything else under it, and a
 * single read-write file cannot be carved out of a read-only mount of its
 * parent — only a nested mount of a whole directory can, which is why this
 * one file gets a directory to itself.
 *
 * Read fresh on every call, never cached — the same reason
 * `server/src/agents/config.util.ts`'s own header gives for
 * `readAgentsConfig`: a test overriding `BM_WATCHDOG_FILE` between cases
 * must see the override, and in production the sweeper reads this at most
 * once every `tickMs` (a full minute by default) and a GET even less often
 * than that, so there is nothing here that a cache would meaningfully save.
 *
 * Every numeric field clamps to the NEAREST BOUND, never to the default —
 * the opposite of `clampSettings`' own `staleDays`
 * (`client/src/lib/settings.ts`), and deliberately so. `staleDays` falls
 * back to its default below its floor because a value of `0` would
 * silently empty three Board columns, an outcome nobody who set it could
 * have intended. None of `tickMs`/`graceMs`/`maxAttempts` have that
 * failure mode: every value inside each range in `WATCHDOG_LIMITS` is a
 * perfectly usable setting, just a more or less eager one, so landing on
 * the floor or ceiling is landing on a real answer rather than papering
 * over a nonsensical one. `graceMs`'s floor (five minutes) is the clearest
 * case — it is not a conservative placeholder, it is the honest worst case:
 * the measured time for a resumed session to reach its first heartbeat is
 * ninety seconds on a good day, and the incident this design responds to
 * was itself an overload event, so a resume spawned into the same overload
 * can take several minutes just to run its first command (design §5.2).
 */

/**
 * `~/.backlog-manager/settings/watchdog.json`, or `BM_WATCHDOG_FILE` when
 * set — the same override-a-computed-default shape `defaultRegistryFile()`
 * (`registry.service.ts`) already uses for `BM_REGISTRY_FILE`. `env` is a
 * parameter rather than a bare read of `process.env` so a test can hand it
 * a plain object without mutating the process-wide environment at all.
 */
export function watchdogFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_WATCHDOG_FILE || join(homedir(), '.backlog-manager', 'settings', 'watchdog.json');
}

/**
 * The operator's kill switch (design §5.1), distinct from `WatchdogConfig.
 * enabled` above: that one is the user's Settings toggle and still lets the
 * sweeper arm, tick and report while withholding the resume spawn; this one
 * stops the process from doing anything watchdog-shaped at all — no timer,
 * no reads of `orchHome()`. It exists for one concrete reason, spelled out
 * in the design: the sweeper's bootstrap scan reads the real orchestrator
 * state directory unless `BM_ORCH_HOME` is overridden, and a jest run that
 * forgets to override it would otherwise have a live process quietly
 * watching (and, worse, resuming into) the developer's own machine.
 * `'off'` only — trimmed and lower-cased, matching `readAgentsConfig`'s own
 * strictness for the same reason: a typo's failure mode must be "the switch
 * had no effect", never "the switch silently disabled the feature".
 */
export function watchdogEnvOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BM_WATCHDOG ?? '').trim().toLowerCase() === 'off';
}

/**
 * A genuine, finite JS `number`, clamped to `[min, max]` — never rounded,
 * and never defaulted merely for landing outside that range. Anything that
 * is not literally typeof `'number'`, or is `NaN`/`±Infinity`, has no
 * reading at all and falls back to `def` instead: `JSON.parse` can produce
 * a string, a boolean, an object, `NaN` has no JSON spelling and is not
 * producible by a spec-conforming parser but IS producible by a POST body
 * built in JS, and a hand-edited file can hold anything.
 */
function clampRange(value: unknown, limits: { min: number; max: number; default: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/**
 * Same shape as `clampRange` above, plus one extra requirement:
 * `maxAttempts` must be an INTEGER, and a fractional value DEFAULTS rather
 * than rounds or clamps. An attempt count is a count — "2.7 attempts" is
 * not a smaller or larger request than the number 2, it is not a value
 * this field can represent at all, so it is treated the same as a value of
 * the wrong type entirely (test case 6's own framing). `0` and `9` are, by
 * contrast, perfectly good integers that are merely outside `[min, max]`,
 * so they land on the nearest bound like any other in-range-type value.
 */
function clampAttempts(value: unknown, limits: { min: number; max: number; default: number }): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** Anything but the literal boolean `false` reads as enabled — the config's
 *  own bias toward watching (see `DEFAULT_WATCHDOG_CONFIG`'s comment)
 *  applied field by field: a truthy-but-wrong value (`'no'`, `0`) is a typo,
 *  not a considered "turn this off". */
function clampEnabled(value: unknown): boolean {
  return value !== false;
}

/**
 * Coerce anything — a missing file's `undefined`, a POST body, a
 * hand-edited JSON blob — into a fully usable `WatchdogConfig`. A non-object
 * `raw` (including `null`, and any primitive) is treated exactly like an
 * empty one: every field then falls back to `DEFAULT_WATCHDOG_CONFIG`'s own
 * value through the same per-field clamp a partial object would go through,
 * so there is only one code path for "nothing usable here" rather than a
 * special case ahead of the per-field logic.
 *
 * Every key on the result is spelled out explicitly rather than spreading
 * `raw` and overwriting known fields — the same "rebuild field by field"
 * discipline `AgentsController`'s dispatch/orchestrate handlers already
 * follow (CLAUDE.md), and for the identical reason: `raw` is `unknown`, so
 * blindly spreading it would let an arbitrary key (`junk`, `__proto__`)
 * ride onto the returned object. Building the result key by key is what
 * makes test case 11's "no `junk` on the result" true by construction
 * rather than by a follow-up filter.
 */
export function clampWatchdogConfig(raw: unknown): WatchdogConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WatchdogConfig>;
  return {
    enabled: clampEnabled(r.enabled),
    tickMs: clampRange(r.tickMs, WATCHDOG_LIMITS.tickMs),
    graceMs: clampRange(r.graceMs, WATCHDOG_LIMITS.graceMs),
    maxAttempts: clampAttempts(r.maxAttempts, WATCHDOG_LIMITS.maxAttempts)
  };
}

/**
 * Read `file` (default: `watchdogFile()`) and clamp its contents, degrading
 * to `DEFAULT_WATCHDOG_CONFIG` on every kind of failure but never throwing —
 * the same posture `RegistryService.load()` and `readRun` both already take
 * on their own files. The two failure kinds are deliberately NOT reported
 * the same way. A missing file is the ordinary first-run case: nothing has
 * ever been written, and `DEFAULT_WATCHDOG_CONFIG` existing at all is
 * exactly what lets a fresh install need no file — so it degrades silently.
 * A file that IS there and does not parse means something wrote garbage to
 * it (a truncated disk write, a hand-edit gone wrong), which is worth one
 * line on stderr naming the path: whoever finds all-default settings where
 * they expected their own now has somewhere to start looking, the same
 * value `readRun`'s own parse-failure message provides for `run.json`.
 */
export function readWatchdogConfig(file: string = watchdogFile()): WatchdogConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return DEFAULT_WATCHDOG_CONFIG;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(`${file}: exists but does not parse as JSON — using defaults`);
    return DEFAULT_WATCHDOG_CONFIG;
  }
  return clampWatchdogConfig(raw);
}

/**
 * Merge `patch` over the current effective config, clamp the result, and
 * write it atomically — the one write path for this file, called by
 * `POST /api/agents/watchdog/config` (design §5.3) and by nothing else.
 * `patch` is `unknown`, not `Partial<WatchdogConfig>`, for the same reason
 * `clampWatchdogConfig`'s `raw` is: a controller only proves a request body
 * is AN object, not that it is the RIGHT one, so every field the patch
 * might carry is read out by name rather than trusted by shape — a second
 * "rebuild field by field" pass distinct from the one `clampWatchdogConfig`
 * itself performs, because a key a caller never mentioned (`{ enabled:
 * false }` alone) must fall through to the file's OWN current value, not to
 * `DEFAULT_WATCHDOG_CONFIG`'s — the merge, not-replace behaviour test case
 * 13 pins.
 *
 * Written the same atomic way `orchestrate.mjs`'s own `writeRunAtomic` and
 * `backlog.mjs`'s `moveItem` are: the full new content lands in a temp file
 * in the SAME directory (so the rename that follows is on one filesystem
 * and therefore atomic at the OS level), then `renameSync` swaps it into
 * place in one step — a reader can only ever see the old complete file or
 * the new complete one, and there is never a temp file left over to clean
 * up, because the rename IS the cleanup.
 */
export function writeWatchdogConfig(patch: unknown, file: string = watchdogFile()): WatchdogConfig {
  const current = readWatchdogConfig(file);
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<WatchdogConfig>;
  const merged: Partial<WatchdogConfig> = { ...current };
  if ('enabled' in p) merged.enabled = p.enabled;
  if ('tickMs' in p) merged.tickMs = p.tickMs;
  if ('graceMs' in p) merged.graceMs = p.graceMs;
  if ('maxAttempts' in p) merged.maxAttempts = p.maxAttempts;
  const next = clampWatchdogConfig(merged);

  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.watchdog.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
  return next;
}
