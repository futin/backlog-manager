import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RemoteRunsService } from '../server/src/orchestrator/remote-runs.service';
import { renderClaim } from '../server/src/tracker/claim';
import { GithubClient } from '../server/src/tracker/github.client';
import { TRACKER_LABELS } from '../server/src/tracker/labels';
import { TRACKER_POLL_MS, TrackerPollerService } from '../server/src/tracker/poller.service';
import { writeSyncInterval } from '../server/src/tracker/sync-config.util';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { makeProject } from './helpers/store';
import type { OrchestratorService } from '../server/src/orchestrator/orchestrator.service';
import type { RegistryService } from '../server/src/registry/registry.service';
import type { ClaimRecord } from '../shared/types';

/**
 * The poller honours each repo's sync interval (#17, spec §5).
 *
 * The clock is `Date.now` under a spy rather than jest's fake timers: the due-check and the last-sync stamp are the only readers of time this feature adds,
 * and both read `Date.now()`, while faking every timer would also fake the `nextTick`/microtask machinery `Response` bodies resolve on. Ticks are driven by
 * calling `tick()` directly — the way `tracker-poll.test.ts` drives the poller — so the real 15 s `setTimeout` the chain schedules never fires inside a case;
 * `armed` reads whether one is pending.
 *
 * The fake `fetch` below is multi-repo on purpose: `helpers/github.ts` models one repo (`FAKE_REPO`), and the cases here are about two repos on two
 * intervals sharing one tick. It answers the four reads a sweep makes — viewer, issues, comments, labels — counts the ISSUES reads per repo (one per sync),
 * and lets a case fail or hold one repo's next issues read.
 */

const dirs: string[] = [];
let settingsDir: string;
let clock = 0;
const savedFile = process.env.BM_TRACKER_SYNC_FILE;
const savedToken = process.env[GITHUB_TOKEN_ENV];

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'bm-sync-interval-'));
  process.env.BM_TRACKER_SYNC_FILE = join(settingsDir, 'tracker-sync.json');
  process.env[GITHUB_TOKEN_ENV] = 'tok';
  clock = Date.parse('2026-09-28T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(settingsDir, { recursive: true, force: true });
  if (savedFile === undefined) delete process.env.BM_TRACKER_SYNC_FILE;
  else process.env.BM_TRACKER_SYNC_FILE = savedFile;
  if (savedToken === undefined) delete process.env[GITHUB_TOKEN_ENV];
  else process.env[GITHUB_TOKEN_ENV] = savedToken;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function githubProject(repo: string): string {
  const root = makeProject('tracker', [], JSON.stringify({ kind: 'github', repo }));
  dirs.push(root);
  return root;
}

function registryOf(...paths: string[]): RegistryService {
  return {
    load: () => ({ projects: paths.map((path, i) => ({ name: `p${i}`, path, createdAt: '2026-08-26T00:00:00.000Z' })) })
  } as unknown as RegistryService;
}

interface Fake {
  poller: TrackerPollerService;
  /** Issues reads per repo — one per sync that got past the asleep check. */
  syncs: (repo: string) => number;
  /** The next issues read for `repo` answers this status instead of 200. */
  failNext: (repo: string, status: number) => void;
  /** The next issues read for `repo` waits until the returned function is called, then answers with `body`. */
  holdNext: (repo: string, body: unknown[]) => () => void;
}

function fake(...repos: string[]): Fake {
  const counts = new Map<string, number>();
  const fails = new Map<string, number>();
  const holds = new Map<string, { gate: Promise<void>; body: unknown[] }>();
  const labels = JSON.stringify(TRACKER_LABELS.map((l) => ({ name: l.name })));
  const impl = async (url: string): Promise<Response> => {
    const m = /\/repos\/([^/]+\/[^/]+)\/issues\?/.exec(url);
    if (m !== null) {
      const repo = m[1];
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
      const status = fails.get(repo);
      if (status !== undefined) {
        fails.delete(repo);
        return new Response('{"message":"boom"}', { status });
      }
      const hold = holds.get(repo);
      if (hold !== undefined) {
        holds.delete(repo);
        await hold.gate;
        return new Response(JSON.stringify(hold.body), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }
    if (url.includes('/labels')) return new Response(labels, { status: 200 });
    if (url.endsWith('/user')) return new Response('{"login":"futin"}', { status: 200 });
    return new Response('[]', { status: 200 });
  };
  const poller = new TrackerPollerService(registryOf(...repos.map(githubProject)), new GithubClient(impl as unknown as typeof fetch));
  return {
    poller,
    syncs: (repo) => counts.get(repo) ?? 0,
    failNext: (repo, status) => fails.set(repo, status),
    holdNext: (repo, body) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      holds.set(repo, { gate, body });
      return release;
    }
  };
}

/** Advance the clock by `ms`, then run one sweep. */
async function tickAt(p: TrackerPollerService, ms: number): Promise<void> {
  clock += ms;
  await p.tick();
}

const issue = (number: number): Record<string, unknown> => ({
  number,
  title: `issue ${number}`,
  body: 'x',
  html_url: `https://github.com/a/one/issues/${number}`,
  state: 'open',
  state_reason: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  labels: [{ name: 'type:bug' }],
  assignees: []
});

describe('which repos a sweep syncs', () => {
  it('syncs a 15s repo every tick and a 1m repo once a minute', async () => {
    writeSyncInterval('a/two', '1m');
    const f = fake('a/one', 'a/two');
    await f.poller.tick();
    for (let i = 0; i < 3; i++) await tickAt(f.poller, TRACKER_POLL_MS);
    expect(f.syncs('a/one')).toBe(4);
    expect(f.syncs('a/two')).toBe(1);
    await tickAt(f.poller, TRACKER_POLL_MS); // t = 60 s
    expect(f.syncs('a/two')).toBe(2);
    f.poller.onApplicationShutdown();
  });

  it('gives an off repo with an empty cache exactly one sync', async () => {
    writeSyncInterval('a/off', 'off');
    const f = fake('a/off', 'a/one');
    await f.poller.tick();
    await tickAt(f.poller, TRACKER_POLL_MS);
    await tickAt(f.poller, TRACKER_POLL_MS);
    expect(f.syncs('a/off')).toBe(1);
    expect(f.syncs('a/one')).toBe(3);
    f.poller.onApplicationShutdown();
  });

  it('counts a failed cold sync as the one attempt an off repo gets', async () => {
    writeSyncInterval('a/off', 'off');
    const f = fake('a/off', 'a/one');
    f.failNext('a/off', 500);
    await f.poller.tick();
    await tickAt(f.poller, TRACKER_POLL_MS);
    await tickAt(f.poller, TRACKER_POLL_MS);
    expect(f.syncs('a/off')).toBe(1);
    f.poller.onApplicationShutdown();
  });

  it('does not retry a failing 1m repo before its minute is up', async () => {
    writeSyncInterval('a/one', '1m');
    const f = fake('a/one');
    f.failNext('a/one', 500);
    await f.poller.tick();
    for (let i = 0; i < 3; i++) await tickAt(f.poller, TRACKER_POLL_MS); // 15, 30, 45 s
    expect(f.syncs('a/one')).toBe(1);
    await tickAt(f.poller, TRACKER_POLL_MS); // 60 s
    expect(f.syncs('a/one')).toBe(2);
    f.poller.onApplicationShutdown();
  });

  it('stamps nothing while a repo sleeps, so a 5m repo retries on the first tick after it wakes (Review Focus 4)', async () => {
    writeSyncInterval('a/one', '5m');
    const f = fake('a/one');
    // Put the repo to sleep the way a secondary limit would, 20 s out from now.
    (f.poller as unknown as { stateOf(repo: string): { sleepUntil: number | null } }).stateOf('a/one').sleepUntil = clock + 20_000;
    await f.poller.tick(); // t = 0: asleep
    await tickAt(f.poller, TRACKER_POLL_MS); // t = 15 s: asleep
    expect(f.syncs('a/one')).toBe(0);
    await tickAt(f.poller, TRACKER_POLL_MS); // t = 30 s: awake, never synced → due
    expect(f.syncs('a/one')).toBe(1);
    f.poller.onApplicationShutdown();
  });

  it('syncs a repo moved to a slower interval at once when its last sync is already older than the new one', async () => {
    const f = fake('a/one');
    await f.poller.tick();
    expect(f.syncs('a/one')).toBe(1);
    writeSyncInterval('a/one', '1m');
    await tickAt(f.poller, 70_000);
    expect(f.syncs('a/one')).toBe(2);
    await tickAt(f.poller, TRACKER_POLL_MS);
    expect(f.syncs('a/one')).toBe(2);
    f.poller.onApplicationShutdown();
  });

  it('finishes a sync that was in flight when the repo was switched off, then makes no more (Review Focus 2)', async () => {
    const f = fake('a/one');
    await f.poller.tick(); // the cold sync, so `off` is not owed one
    const release = f.holdNext('a/one', [issue(9)]);
    clock += TRACKER_POLL_MS;
    const inFlight = f.poller.tick();
    await new Promise((resolve) => setImmediate(resolve));
    writeSyncInterval('a/one', 'off');
    release();
    await inFlight;
    expect(f.poller.issues('a/one').map((i) => i.number)).toEqual([9]);
    await tickAt(f.poller, TRACKER_POLL_MS);
    await tickAt(f.poller, TRACKER_POLL_MS);
    expect(f.syncs('a/one')).toBe(2);
    f.poller.onApplicationShutdown();
  });
});

describe('armed while something is on', () => {
  it('disarms once every repo is off and has had its cold attempt', async () => {
    writeSyncInterval('a/one', 'off');
    writeSyncInterval('a/two', 'off');
    const f = fake('a/one', 'a/two');
    f.poller.arm();
    expect(f.poller.armed).toBe(false); // the cold tick is in flight, its timer not yet made
    await f.poller.tick();
    expect(f.syncs('a/one')).toBe(1);
    expect(f.syncs('a/two')).toBe(1);
    expect(f.poller.armed).toBe(false);
    // and `arm()` does not restart a chain that has nothing to do
    f.poller.arm();
    expect(f.poller.armed).toBe(false);
    await f.poller.tick();
    expect(f.syncs('a/one')).toBe(1);

    // Turning one back on re-arms, and its next tick syncs it. `arm()` starts that tick itself; awaiting `tick()` joins it rather than starting another.
    clock += TRACKER_POLL_MS;
    writeSyncInterval('a/one', '15s');
    f.poller.arm();
    await f.poller.tick();
    expect(f.syncs('a/one')).toBe(2);
    expect(f.poller.armed).toBe(true);
    f.poller.onApplicationShutdown();
  });
});

describe('summary and syncOffBlock', () => {
  it('carries the effective interval, read fresh with no restart', () => {
    const f = fake('a/one');
    expect(f.poller.summary('a/one').interval).toBe('15s');
    writeSyncInterval('a/one', '5m');
    expect(f.poller.summary('a/one').interval).toBe('5m');
  });

  it('answers the refusal sentence for an off github project and null for everything else', () => {
    const f = fake();
    const tracker = githubProject('futin/x');
    writeSyncInterval('futin/x', 'off');
    expect(f.poller.syncOffBlock(tracker)).toBe('sync is off for futin/x — turn it on in Settings › Shared › Trackers');
    writeSyncInterval('futin/x', '1m');
    expect(f.poller.syncOffBlock(tracker)).toBeNull();

    const files = makeProject('files', []);
    dirs.push(files);
    expect(f.poller.syncOffBlock(files)).toBeNull();

    const bare = mkdtempSync(join(tmpdir(), 'bm-no-backlog-'));
    dirs.push(bare);
    expect(f.poller.syncOffBlock(bare)).toBeNull();
  });
});

describe('remote runs', () => {
  function withLiveClaim(repo: string): { remote: RemoteRunsService } {
    const project = githubProject(repo);
    const registry = registryOf(project);
    const poller = new TrackerPollerService(registry, new GithubClient((async () => new Response('[]')) as unknown as typeof fetch));
    const record: ClaimRecord = {
      v: 1,
      session: 'linux-driver',
      phase: 'execute',
      at: new Date(clock - 60_000).toISOString(),
      heartbeat: new Date(clock).toISOString(),
      counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 },
      run: { runId: 'run-20260928-115900', startedAt: new Date(clock - 60_000).toISOString(), mergeMode: 'merge', questionMode: 'park', maxItems: null, base: 'main' }
    };
    poller.absorbComment(repo, {
      id: 100,
      issue_url: `https://api.github.com/repos/${repo}/issues/5`,
      body: renderClaim(record),
      html_url: `https://github.com/${repo}/issues/5#issuecomment-100`,
      user: { login: 'futin' },
      created_at: record.at,
      updated_at: record.heartbeat
    });
    const orchestrator = { localRunIds: () => new Set<string>() } as unknown as OrchestratorService;
    return { remote: new RemoteRunsService(registry, poller, orchestrator) };
  }

  it('derives nothing for an off repo, and the run for the same repo at 15s', () => {
    const { remote } = withLiveClaim('b/remote');
    expect(remote.list(clock).map((r) => r.runId)).toEqual(['run-20260928-115900']);
    writeSyncInterval('b/remote', 'off');
    expect(remote.list(clock)).toEqual([]);
  });
});
