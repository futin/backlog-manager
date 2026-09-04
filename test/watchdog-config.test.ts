import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  clampWatchdogConfig,
  readWatchdogConfig,
  writeWatchdogConfig,
  watchdogFile,
  watchdogEnvOff
} from '../server/src/orchestrator/watchdog-config.util';
import { DEFAULT_WATCHDOG_CONFIG } from '../shared/types';

// --- clampWatchdogConfig — pure, no filesystem involved --------------------
//
// Every case here is either "not a usable value at all" (wrong type, not
// finite, non-integer where an integer is required) or "a usable value
// outside its range". The two degrade differently on purpose (spec §5.2):
// the first kind has no reading at all and falls all the way back to
// DEFAULT_WATCHDOG_CONFIG's own field, the second is a real request that is
// merely too eager or too timid and lands on the nearest bound instead —
// the opposite of client/src/lib/settings.ts's own `staleDays`, which falls
// back to its default rather than its floor because 0 would silently empty
// three Board columns. None of tickMs/graceMs/maxAttempts have that
// problem: every value in range is a safe setting, so the floor and
// ceiling are themselves worth landing on.

describe('clampWatchdogConfig', () => {
  it('defaults every field when the raw value is not a usable object at all', () => {
    expect(clampWatchdogConfig(undefined)).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(clampWatchdogConfig(42)).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(clampWatchdogConfig('x')).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(clampWatchdogConfig(null)).toEqual(DEFAULT_WATCHDOG_CONFIG);
  });

  it('clamps tickMs below its floor up to the floor, leaving the other three fields at default', () => {
    expect(clampWatchdogConfig({ tickMs: 1 })).toEqual({
      ...DEFAULT_WATCHDOG_CONFIG,
      tickMs: 30_000
    });
  });

  it('clamps tickMs above its ceiling down to the ceiling', () => {
    expect(clampWatchdogConfig({ tickMs: 10_000_000 }).tickMs).toBe(600_000);
  });

  it('clamps graceMs to its floor and its ceiling', () => {
    expect(clampWatchdogConfig({ graceMs: 1 }).graceMs).toBe(300_000);
    expect(clampWatchdogConfig({ graceMs: 99_999_999 }).graceMs).toBe(3_600_000);
  });

  it('clamps maxAttempts to its floor and ceiling, but DEFAULTS a non-integer rather than rounding or clamping it', () => {
    // An attempt count is a count: 2.7 is not "a bit more than 2 attempts",
    // it is not a value this field can represent at all, so it gets the
    // same treatment as a value of the wrong type entirely — unlike 0 and 9
    // below, which are perfectly good integers that are merely out of range
    // and therefore land on the nearest bound instead.
    expect(clampWatchdogConfig({ maxAttempts: 0 }).maxAttempts).toBe(1);
    expect(clampWatchdogConfig({ maxAttempts: 9 }).maxAttempts).toBe(5);
    expect(clampWatchdogConfig({ maxAttempts: 2.7 }).maxAttempts).toBe(2);
  });

  it('defaults tickMs when it is not a finite number at all', () => {
    expect(clampWatchdogConfig({ tickMs: 'soon' }).tickMs).toBe(60_000);
    expect(clampWatchdogConfig({ tickMs: NaN }).tickMs).toBe(60_000);
    expect(clampWatchdogConfig({ tickMs: Infinity }).tickMs).toBe(60_000);
  });

  it('reads enabled as false only for the literal boolean false', () => {
    expect(clampWatchdogConfig({ enabled: false }).enabled).toBe(false);
    expect(clampWatchdogConfig({ enabled: 'no' }).enabled).toBe(true);
    expect(clampWatchdogConfig({ enabled: 0 }).enabled).toBe(true);
    expect(clampWatchdogConfig({}).enabled).toBe(true);
  });
});

// --- readWatchdogConfig / writeWatchdogConfig — the settings file itself ---
//
// Every case below calls the functions with NO explicit file argument,
// exactly as production code will: the default `file = watchdogFile()`
// reads `BM_WATCHDOG_FILE`, so pointing that env var at a fresh
// `mkdtempSync` directory per case (and restoring it in afterEach) is what
// keeps this suite from ever touching the developer's real
// ~/.backlog-manager. The path is nested one level (`settings/watchdog.json`)
// to mirror the real default shape and exercise `mkdirSync(..., {recursive:
// true})` on every case, not just the one written for it.

describe('readWatchdogConfig / writeWatchdogConfig', () => {
  let tmpRoot: string;
  let file: string;
  const envBackup = { ...process.env };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-watchdog-'));
    file = join(tmpRoot, 'settings', 'watchdog.json');
    process.env.BM_WATCHDOG_FILE = file;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    process.env = { ...envBackup };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('defaults silently when no file exists yet — a fresh install needs nothing on disk', () => {
    expect(readWatchdogConfig()).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(existsSync(file)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults and warns exactly once, naming the path, when the file exists but is not JSON', () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'not json');

    expect(readWatchdogConfig()).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(file);
  });

  it('clamps a partial file, defaulting the rest and dropping unknown keys', () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ graceMs: 900_000, junk: 1 }));

    const cfg = readWatchdogConfig();
    expect(cfg).toEqual({ ...DEFAULT_WATCHDOG_CONFIG, graceMs: 900_000 });
    expect('junk' in cfg).toBe(false);
  });

  it('creates the settings directory and writes a fully clamped file when none existed', () => {
    expect(existsSync(dirname(file))).toBe(false);

    const result = writeWatchdogConfig({ graceMs: 1 });
    const expected = { enabled: true, tickMs: 60_000, graceMs: 300_000, maxAttempts: 2 };

    expect(existsSync(dirname(file))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected);
    expect(result).toEqual(expected);
  });

  it('merges a patch over the existing file rather than replacing it', () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ tickMs: 120_000 }));

    writeWatchdogConfig({ enabled: false });

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.tickMs).toBe(120_000);
    expect(onDisk.enabled).toBe(false);
  });

  it('leaves no *.tmp sibling behind after a write', () => {
    writeWatchdogConfig({ tickMs: 90_000 });

    const leftover = readdirSync(dirname(file)).filter((name) => name.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });
});

// --- watchdogFile / watchdogEnvOff — pure env readers -----------------------

describe('watchdogFile', () => {
  it('defaults under ~/.backlog-manager/settings, overridable by BM_WATCHDOG_FILE', () => {
    expect(watchdogFile({})).toMatch(/\.backlog-manager\/settings\/watchdog\.json$/);
    expect(watchdogFile({ BM_WATCHDOG_FILE: '/x/y.json' })).toBe('/x/y.json');
  });
});

describe('watchdogEnvOff', () => {
  it('reads BM_WATCHDOG=off trimmed and case-insensitively, and defaults to false', () => {
    expect(watchdogEnvOff({ BM_WATCHDOG: 'off' })).toBe(true);
    expect(watchdogEnvOff({ BM_WATCHDOG: ' OFF ' })).toBe(true);
    expect(watchdogEnvOff({ BM_WATCHDOG: 'on' })).toBe(false);
    expect(watchdogEnvOff({})).toBe(false);
  });
});
