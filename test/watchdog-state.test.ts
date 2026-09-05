import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { WatchdogStateService } from '../server/src/orchestrator/watchdog-state.service';
import type { OrchestratorRun, OrchestratorRunsPayload } from '../shared/types';

/**
 * A minimal, fully-typed `OrchestratorRun` plus the two fields `runs()`
 * annotates every entry with (`fresh`, `pastRuns`) — the same shape every
 * element of `OrchestratorRunsPayload.runs` carries. `annotate()` only
 * needs the narrower `OrchestratorRun & { fresh: boolean }`, and `observe()`
 * needs the full payload-element shape; building one object that satisfies
 * both (rather than two near-duplicate helpers) is what this widens for.
 * Defaults describe a fresh, healthy, empty-queue run — every test overrides
 * only the fields its own case cares about.
 */
function fakeRun(
  overrides: Partial<OrchestratorRun & { fresh: boolean; pastRuns: number }> = {}
): OrchestratorRun & { fresh: boolean; pastRuns: number } {
  return {
    runId: 'run-1',
    project: '/p',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    maxItems: null,
    mergeMode: 'merge',
    mergeModeEffective: 'merge',
    mergeModeNote: null,
    queue: [],
    attention: [],
    fresh: true,
    pastRuns: 0,
    ...overrides
  };
}

describe('WatchdogStateService', () => {
  let tmpDir: string;
  const env = { ...process.env };

  beforeEach(() => {
    // Every case that reaches spawningEnabled()/annotate() ends up reading
    // BM_WATCHDOG_FILE — pointed inside a fresh mkdtempSync directory, never
    // at the developer's real ~/.backlog-manager, exactly as
    // watchdog-config.test.ts already does for the same reason. Nested
    // under settings/ (not yet existing) so cases that write a file here
    // also exercise the same recursive mkdir the real default path needs.
    tmpDir = mkdtempSync(join(tmpdir(), 'bm-watchdog-state-'));
    process.env.BM_WATCHDOG_FILE = join(tmpDir, 'settings', 'watchdog.json');
    // BM_AGENTS/BM_WATCHDOG start absent every case, regardless of what the
    // shell running this suite happens to export — each case that cares
    // sets exactly what it needs, explicitly, rather than inheriting
    // whatever a previous case (or the developer's own shell) left behind.
    delete process.env.BM_AGENTS;
    delete process.env.BM_WATCHDOG;
  });

  afterEach(() => {
    process.env = { ...env };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts idle, with no events and no scheduled tick', () => {
    const service = new WatchdogStateService();
    expect(service.phase).toBe('idle');
    expect(service.events()).toEqual([]);
    expect(service.nextTickAt).toBeNull();
  });

  it('keeps only the newest WATCHDOG_EVENT_CAP (50) events, newest first', () => {
    const service = new WatchdogStateService();
    for (let i = 1; i <= 55; i++) {
      service.push({ project: null, runId: null, kind: 'armed', detail: `event ${i}` });
    }

    const events = service.events();
    expect(events).toHaveLength(50);
    // Newest first: the 55th push is at index 0.
    expect(events[0].detail).toBe('event 55');
    // The first five pushed are the ones the cap dropped.
    const details = events.map((event) => event.detail);
    expect(details).not.toContain('event 1');
    expect(details).not.toContain('event 5');
    expect(details).toContain('event 6');
  });

  it('upsert creates a zeroed entry once, then returns the SAME object on repeat calls', () => {
    const service = new WatchdogStateService();
    const first = service.upsert('r1', '/p');
    const second = service.upsert('r1', '/p');

    expect(second).toBe(first);
    expect(first).toEqual({
      runId: 'r1',
      project: '/p',
      attempts: 0,
      lastSpawnAt: null,
      lastSessionId: null,
      lastError: null,
      recovered: false,
      exhaustedLogged: false,
      disabledLogged: false
    });
  });

  it('prune drops every entry whose runId is not in the keep set', () => {
    const service = new WatchdogStateService();
    service.upsert('r1', '/p1');
    service.upsert('r2', '/p2');

    service.prune(new Set(['r2']));

    expect(service.entry('r1')).toBeUndefined();
    expect(service.entry('r2')).toBeDefined();
  });

  it('annotate returns undefined for a fresh running run', () => {
    const service = new WatchdogStateService();
    expect(service.annotate(fakeRun({ status: 'running', fresh: true }))).toBeUndefined();
  });

  it('annotate returns undefined for a done run, even with a stale updatedAt', () => {
    const service = new WatchdogStateService();
    expect(service.annotate(fakeRun({ status: 'done', fresh: false }))).toBeUndefined();
  });

  it('annotates a crashed run with no state entry using zeroed defaults, watchdog enabled', () => {
    process.env.BM_AGENTS = 'on';
    // No BM_WATCHDOG set, no settings file written — spawningEnabled() must
    // read true from BM_AGENTS=on plus both watchdog defaults (env not off,
    // file-absent config defaults to enabled: true).
    const service = new WatchdogStateService();

    const result = service.annotate(fakeRun({ status: 'running', fresh: false }));

    expect(result).toEqual({
      enabled: true,
      attempts: 0,
      maxAttempts: 2,
      lastSpawnAt: null,
      lastSessionId: null,
      lastError: null,
      exhausted: false
    });
  });

  it('reads enabled: false when BM_AGENTS is unset', () => {
    // Same crashed run as the previous case, but BM_AGENTS is left absent
    // (beforeEach's own default) — spawningEnabled() must read false purely
    // from the missing agents flag, with the watchdog's own config and env
    // switch both left at their permissive defaults.
    const service = new WatchdogStateService();
    const result = service.annotate(fakeRun({ status: 'running', fresh: false }));
    expect(result?.enabled).toBe(false);
  });

  it('reads enabled: false when BM_WATCHDOG=off overrides an enabled BM_AGENTS', () => {
    process.env.BM_AGENTS = 'on';
    process.env.BM_WATCHDOG = 'off';
    const service = new WatchdogStateService();
    const result = service.annotate(fakeRun({ status: 'running', fresh: false }));
    expect(result?.enabled).toBe(false);
  });

  it('reads enabled and maxAttempts from the watchdog settings file', () => {
    process.env.BM_AGENTS = 'on';
    const file = process.env.BM_WATCHDOG_FILE as string;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ enabled: false, maxAttempts: 4 }));

    const service = new WatchdogStateService();
    const result = service.annotate(fakeRun({ status: 'running', fresh: false }));

    expect(result?.enabled).toBe(false);
    expect(result?.maxAttempts).toBe(4);
  });

  it("annotate reflects an existing entry's attempts and lastSessionId, and derives exhausted from them", () => {
    process.env.BM_AGENTS = 'on';
    const service = new WatchdogStateService();
    const entry = service.upsert('run-1', '/p');
    // Two attempts against the default cap of 2. Nothing sets `exhausted`
    // here because no such field exists to set: the entry records what
    // happened (`attempts`), and the verdict is derived from it against
    // whatever the config says at the moment of the read.
    entry.attempts = 2;
    entry.lastSessionId = 'sess-1';

    const result = service.annotate(fakeRun({ runId: 'run-1', status: 'running', fresh: false }));

    expect(result?.attempts).toBe(2);
    expect(result?.lastSessionId).toBe('sess-1');
    expect(result?.exhausted).toBe(true);
  });

  // The Critical, at the layer that publishes the field: the SAME entry, the
  // same two attempts, read against a cap a person has since raised. A stored
  // flag would still read `true` here — and the board renders its Resume
  // control on this exact boolean, while the sweeper is off spawning again
  // because it re-derives the same comparison every tick.
  it('annotate reports exhausted: false once maxAttempts is raised past the attempts spent', () => {
    process.env.BM_AGENTS = 'on';
    const file = process.env.BM_WATCHDOG_FILE as string;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ maxAttempts: 3 }));

    const service = new WatchdogStateService();
    service.upsert('run-1', '/p').attempts = 2;

    const result = service.annotate(fakeRun({ runId: 'run-1', status: 'running', fresh: false }));

    expect(result?.exhausted).toBe(false);
    // The two numbers the sentence is built from ride the same record, out of
    // the same single config read, so a reader can always check it.
    expect(result?.attempts).toBe(2);
    expect(result?.maxAttempts).toBe(3);
  });

  it('observe does not throw when no armer has been registered', () => {
    const service = new WatchdogStateService();
    const payload: OrchestratorRunsPayload = { runs: [fakeRun({ status: 'running', fresh: false })] };
    expect(() => service.observe(payload)).not.toThrow();
  });

  it('does not call the armer when no run in the payload is running', () => {
    const service = new WatchdogStateService();
    const spy = jest.fn();
    service.setArmer(spy);

    service.observe({ runs: [fakeRun({ status: 'done', fresh: false })] });

    expect(spy).not.toHaveBeenCalled();
  });

  it('calls the armer once when a run in the payload is fresh and running', () => {
    const service = new WatchdogStateService();
    const spy = jest.fn();
    service.setArmer(spy);

    service.observe({ runs: [fakeRun({ status: 'running', fresh: true })] });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls the armer once when a run in the payload is crashed — crashed is still running', () => {
    const service = new WatchdogStateService();
    const spy = jest.fn();
    service.setArmer(spy);

    service.observe({ runs: [fakeRun({ status: 'running', fresh: false })] });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
