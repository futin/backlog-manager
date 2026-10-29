import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { OrchestrateArgsService } from '../server/src/agents/orchestrate-args.service';
import { GIT_TIMEOUT_MS, __setGitTimeoutMs } from '../server/src/git-run.util';
import { resolveBaseBranch } from '../server/src/items/base-branch.util';
import { __gitSpawnCount, __resetGitDateMemo, lastCommitDates } from '../server/src/items/git-dates.util';
import { uncommittedItemPaths } from '../server/src/items/uncommitted.util';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { originRepo } from '../server/src/tracker/origin.util';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';

/**
 * #277 — no git process the server spawns can freeze the Node event loop.
 *
 * The proof is a fake `git` first on PATH: a shell script that sleeps, then
 * execs the real one. Against a synchronous spawn the sleep blocks the whole
 * test process, so a timer scheduled right after the call cannot fire before
 * the call returns — which is exactly the 2026-10-15 incident, reproduced
 * without a slow disk. The script traps TERM and kills its own `sleep`, because
 * `execFile` settles on the pipes closing and an orphaned `sleep` holding them
 * open would make every timeout case wait out the full sleep.
 *
 * PATH is switched only around the call under test: fixtures are built with
 * the real git first, so a slow fake never taxes setup.
 */

const FAKE_GIT = `#!/bin/sh
[ -n "$FAKE_GIT_LOG" ] && echo "$*" >> "$FAKE_GIT_LOG"
if [ -z "$FAKE_GIT_ONLY" ] || echo "$*" | grep -q -- "$FAKE_GIT_ONLY"; then
  sleep "\${FAKE_GIT_SLEEP:-0}" &
  trap 'kill $!; exit 143' TERM
  wait $!
fi
exec "$FAKE_GIT_REAL" "$@"
`;

jest.setTimeout(20_000);

const realPath = process.env.PATH as string;
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const scratch: string[] = [];

const fakeDir = mkdtempSync(join(tmpdir(), 'bm-fake-git-'));
scratch.push(fakeDir);
writeFileSync(join(fakeDir, 'git'), FAKE_GIT);
chmodSync(join(fakeDir, 'git'), 0o755);

interface Fake {
  /** Seconds each matching invocation sleeps before running the real git. */
  sleep: number;
  /** Only invocations whose argument string contains this are slowed. */
  only?: string;
  /** File each invocation appends its arguments to, one line apiece. */
  log?: string;
}

function fakeOn(fake: Fake): void {
  process.env.PATH = `${fakeDir}:${realPath}`;
  process.env.FAKE_GIT_REAL = realGit;
  process.env.FAKE_GIT_SLEEP = String(fake.sleep);
  if (fake.only !== undefined) process.env.FAKE_GIT_ONLY = fake.only;
  if (fake.log !== undefined) process.env.FAKE_GIT_LOG = fake.log;
}

function fakeOff(): void {
  process.env.PATH = realPath;
  delete process.env.FAKE_GIT_REAL;
  delete process.env.FAKE_GIT_SLEEP;
  delete process.env.FAKE_GIT_ONLY;
  delete process.env.FAKE_GIT_LOG;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

/** A real repo on `main` with one committed item, a second branch `side`, and an `origin`. */
function fixtureRepo(): string {
  const root = makeProject('git-run', [{ leaf: 'bugs/open', filename: 'bug-1-a.md', content: item('bug-1', 'a', 'body\n') }]);
  scratch.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  git(root, 'branch', 'side');
  git(root, 'remote', 'add', 'origin', 'git@github.com:futin/backlog-manager.git');
  return root;
}

/**
 * Fails when the call blocks the event loop: a 20 ms timer scheduled right
 * after the call must fire while the call is still pending. `Promise.resolve`
 * so a synchronous implementation (which returns a plain value, or throws) is
 * a red case rather than a type error.
 */
async function loopStaysFree(call: () => unknown): Promise<void> {
  let settled = false;
  const running = Promise.resolve(call()).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  let settledWhenTimerFired: boolean | undefined;
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      settledWhenTimerFired = settled;
      resolve();
    }, 20)
  );
  await running;
  expect(settledWhenTimerFired).toBe(false);
}

afterEach(() => {
  fakeOff();
  __setGitTimeoutMs(null);
  __resetGitDateMemo();
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('git is async: a slow git never blocks the event loop', () => {
  let app: INestApplication;
  let root: string;

  beforeAll(async () => {
    root = fixtureRepo();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: root }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exports the production timeout as ten seconds', () => {
    expect(GIT_TIMEOUT_MS).toBe(10_000);
  });

  it('lastCommitDates', async () => {
    fakeOn({ sleep: 0.5 });
    await loopStaysFree(() => lastCommitDates(root));
  });

  it('uncommittedItemPaths', async () => {
    fakeOn({ sleep: 0.5 });
    await loopStaysFree(() => uncommittedItemPaths(root));
  });

  it('originRepo', async () => {
    fakeOn({ sleep: 0.5 });
    await loopStaysFree(() => originRepo(root));
  });

  it('resolveBaseBranch, for a non-default base', async () => {
    fakeOn({ sleep: 0.5 });
    await loopStaysFree(() => resolveBaseBranch('side', root));
  });

  it('OrchestrateArgsService.branches', async () => {
    const agents = app.get(OrchestrateArgsService, { strict: false });
    fakeOn({ sleep: 0.5 });
    await loopStaysFree(() => agents.branches(root));
  });
});

describe('a timeout lands in each call site’s existing failure branch', () => {
  let root: string;

  beforeEach(() => {
    root = fixtureRepo();
    __resetGitDateMemo();
  });

  it('lastCommitDates: empty map, and the failure is not memoised', async () => {
    // A tight bound the fake overshoots by an order of magnitude.
    __setGitTimeoutMs(100);
    fakeOn({ sleep: 3 });
    const started = Date.now();
    const failed = await lastCommitDates(root);
    // The trap in the fake is what keeps this near the bound rather than 3 s.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(failed.size).toBe(0);

    fakeOff();
    __setGitTimeoutMs(null);
    const again = await lastCommitDates(root);
    expect(again.get('backlog/bugs/open/bug-1-a.md')).toBeDefined();
  });

  it('uncommittedItemPaths: known false', async () => {
    __setGitTimeoutMs(100);
    fakeOn({ sleep: 3 });
    await expect(uncommittedItemPaths(root)).resolves.toEqual({ paths: [], absent: [], known: false });
  });

  it('originRepo: null', async () => {
    __setGitTimeoutMs(100);
    fakeOn({ sleep: 3 });
    await expect(originRepo(root)).resolves.toBeNull();
  });

  it('OrchestrateArgsService.branches: an empty list', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: root }]))
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const agents = app.get(OrchestrateArgsService, { strict: false });
      __setGitTimeoutMs(100);
      fakeOn({ sleep: 3 });
      await expect(agents.branches(root)).resolves.toEqual({ branches: [] });
    } finally {
      await app.close();
    }
  });

  it('resolveBaseBranch: the same 400 a missing branch gets, whichever check times out', async () => {
    const message = async (base: string): Promise<string> => {
      const err = await resolveBaseBranch(base, root).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(400);
      return JSON.stringify((err as HttpException).getResponse());
    };
    const missing = await message('no-such-branch');
    expect(missing).toContain('is not a branch in this project');

    // Only the existence check is slow: `side` exists, so the ONLY thing that
    // can make this refuse is the timeout, and it must read as a missing branch.
    // The bound is looser than the other cases' because the un-slowed
    // `check-ref-format` still pays the fake's own startup (a shell, an echo and
    // a grep) and must comfortably fit inside it.
    __setGitTimeoutMs(1000);
    fakeOn({ sleep: 5, only: 'show-ref' });
    expect((await message('side')).replace('side', 'no-such-branch')).toBe(missing);

    // The format check timing out is a failed check too — a 400, never a throw
    // out of the route. (It reads "not a valid branch name": that check is
    // first, and a base nothing could prove is refused at the first gate.)
    fakeOn({ sleep: 3, only: 'check-ref-format' });
    expect(await message('side')).toContain('is not a valid branch name');
  });
});

describe('concurrency', () => {
  let root: string;

  beforeEach(() => {
    root = fixtureRepo();
    __resetGitDateMemo();
  });

  it('lastCommitDates: concurrent misses share one spawn, and a new fingerprint spawns again', async () => {
    const before = __gitSpawnCount();
    const [a, b, c] = await Promise.all([lastCommitDates(root), lastCommitDates(root), lastCommitDates(root)]);
    expect(__gitSpawnCount() - before).toBe(1);
    expect([...b]).toEqual([...a]);
    expect([...c]).toEqual([...a]);

    // The memo is warm now, so this one spawns nothing.
    await lastCommitDates(root);
    expect(__gitSpawnCount() - before).toBe(1);

    writeFileSync(join(root, 'backlog', 'bugs', 'open', 'bug-2-b.md'), item('bug-2', 'b', 'body\n'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'two');
    const afterCommit = __gitSpawnCount();
    const fresh = await lastCommitDates(root);
    expect(__gitSpawnCount() - afterCommit).toBe(1);
    expect(fresh.has('backlog/bugs/open/bug-2-b.md')).toBe(true);
  });

  it('lastCommitDates: a burst sharing a slow git shares its failure, and the next call retries', async () => {
    __setGitTimeoutMs(100);
    fakeOn({ sleep: 3 });
    const before = __gitSpawnCount();
    const burst = await Promise.all([lastCommitDates(root), lastCommitDates(root)]);
    expect(__gitSpawnCount() - before).toBe(1);
    expect(burst.map((m) => m.size)).toEqual([0, 0]);

    fakeOff();
    __setGitTimeoutMs(null);
    expect((await lastCommitDates(root)).size).toBeGreaterThan(0);
    expect(__gitSpawnCount() - before).toBe(2);
  });

  it('uncommittedItemPaths is never shared: two concurrent calls run git twice', async () => {
    const log = join(root, '..', `bm-fake-log-${process.pid}-${Date.now()}`);
    scratch.push(log);
    fakeOn({ sleep: 0.2, log });
    const [a, b] = await Promise.all([uncommittedItemPaths(root), uncommittedItemPaths(root)]);
    fakeOff();
    expect(a.known).toBe(true);
    expect(b).toEqual(a);
    // Every call that reaches its last read runs exactly one `ls-tree`; a
    // shared in-flight promise would leave one.
    const spawned = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('ls-tree'));
    expect(spawned).toHaveLength(2);
  });
});

describe('route level', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const root = fixtureRepo();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: root }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api/health answers while /api/items is still waiting on a slow git', async () => {
    __resetGitDateMemo();
    fakeOn({ sleep: 1 });
    const started = Date.now();
    const timed = async (path: string): Promise<{ status: number; ms: number }> => {
      const res = await request(app.getHttpServer()).get(path);
      return { status: res.status, ms: Date.now() - started };
    };
    const items = timed('/api/items');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = timed('/api/health');
    const [i, h] = await Promise.all([items, health]);

    expect(h.status).toBe(200);
    expect(i.status).toBe(200);
    expect(h.ms).toBeLessThan(i.ms);
    // Health does no I/O: well under the one second git is made to take.
    expect(h.ms).toBeLessThan(500);
    expect(i.ms).toBeGreaterThanOrEqual(900);
  });
});

describe('no synchronous spawn remains under server/src', () => {
  it('finds none of execFileSync, spawnSync or execSync', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\b(execFileSync|spawnSync|execSync)\b/.test(readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    walk(join(__dirname, '..', 'server', 'src'));
    expect(offenders).toEqual([]);
  });
});
