import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { CLAIM_SWEEPER_SESSION, ClaimSweeperService, SESSIONS_DIR_ENV } from '../server/src/items/claim-sweeper.service';
import { ItemsModule } from '../server/src/items/items.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { parseClaim } from '../server/src/tracker/claim';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import { CLAIM_STALE_MS, type ClaimRecord } from '../shared/types';

/**
 * bug-49 — the claim sweeper: a hand-run session that exits while it holds a tracker item's claim released nothing, and every machine read the item as in
 * progress for a full `CLAIM_STALE_MS` though this machine's own session registry already said the process was gone.
 *
 * The sweeper runs after each successful per-repo sync of the poller and releases a cached claim only when every one of these holds: it is live, it carries
 * no `run`, its `session` is a Claude Code session id rather than the `<user>@<host>` fallback, its `host` is one this process has seen on a claim request,
 * and the registry directory is readable, understood, and has no file naming the session. Each case below breaks exactly one of those.
 */

const TOKEN = 'ghp_bug49SweeperSentinel';
const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });
const OWN_HOST = 'futin@this-box';
const HOLDER = '77a705a3-1111-4222-8333-444455556666';
const NEIGHBOUR = '6bb566f5-aaaa-4bbb-8ccc-ddddeeeeffff';

const dirs: string[] = [];
const env = { ...process.env };

let app: INestApplication;
let gh: FakeGithub;
let registryDir: string;
let trackerPath: string;

/** A live hand claim on this machine by a Claude Code session: the one shape the sweeper may release. */
function record(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    v: 1,
    session: HOLDER,
    host: OWN_HOST,
    phase: 'execute',
    at: new Date(Date.now() - 10 * 60_000).toISOString(),
    heartbeat: new Date(Date.now() - 60_000).toISOString(),
    counters: { groomElapsed: 0, executeElapsed: 40, groomTokens: 0, executeTokens: 900 },
    ...over
  };
}

/** A registry file the way Claude Code writes one. The pid is irrelevant to the sweeper — it reads file presence only, never a pid. */
function registryFile(name: string, entry: Record<string, unknown>): void {
  writeFileSync(join(registryDir, name), JSON.stringify(entry));
}

async function build(claims: Array<{ record: ClaimRecord; issue: number; id: number }>): Promise<void> {
  gh = new FakeGithub();
  for (const c of claims) {
    if (!gh.issues.has(c.issue)) gh.issue({ number: c.issue, labels: [{ name: 'type:bug' }, { name: 'in-progress' }] });
    gh.claim(c.record, c.issue, c.id);
  }

  trackerPath = makeProject('gamma', [], GITHUB_MARKER);
  dirs.push(trackerPath);
  registryDir = realpathSync(mkdtempSync(join(tmpdir(), 'bm-sessions-')));
  dirs.push(registryDir);
  process.env[SESSIONS_DIR_ENV] = registryDir;

  delete process.env[GITHUB_TOKEN_ENV];
  const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry([{ name: 'gamma', path: trackerPath }]))
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  app.get(GithubSource).settleMs = 0;
  app.get(TrackerPollerService).disarm();
  process.env[GITHUB_TOKEN_ENV] = TOKEN;
}

/** One poll and no successor — see `tracker-cold-cache.test.ts`'s `sweep`. The claim sweep runs inside it, after the repo synced. */
async function poll(): Promise<void> {
  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
}

function sweeper(): ClaimSweeperService {
  return app.get(ClaimSweeperService);
}

function claimIn(id: number): ClaimRecord | null {
  const comment = gh.comments.get(id);
  return comment === undefined ? null : parseClaim(comment as never);
}

function releaseSpy(): jest.SpyInstance {
  return jest.spyOn(app.get(GithubSource), 'release');
}

afterEach(async () => {
  await app?.close();
  process.env = { ...env };
  jest.restoreAllMocks();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('claim sweeper', () => {
  it('releases a live hand claim on this machine whose session has no registry file, as aborted, on the claim-s own host, with no counters', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    const spy = releaseSpy();

    await poll();

    expect(spy).toHaveBeenCalledTimes(1);
    const req = spy.mock.calls[0][2];
    expect(req).toMatchObject({ commentId: 100, reason: 'aborted', host: OWN_HOST, session: CLAIM_SWEEPER_SESSION });
    // The abandon rule: the stretch between the last heartbeat and the exit is not work anybody did. ABSENT, never zeroed.
    expect(req.counters).toBeUndefined();
    expect(req.runId).toBeUndefined();

    const released = claimIn(100);
    expect(released?.released).toMatchObject({ reason: 'aborted', by: CLAIM_SWEEPER_SESSION });
    expect(released?.counters.executeTokens).toBe(900);
    expect(gh.issues.get(5)?.labels.map((l) => l.name)).not.toContain('in-progress');
  });

  it('learns its own host from a claim request, and leaves the requesting session-s own claim alone because the registry names it', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    gh.issue({ number: 6 });
    registryFile('4242.json', { pid: 4242, sessionId: NEIGHBOUR, procStart: '1' });

    const claimed = await request(app.getHttpServer())
      .post('/api/items/claim')
      .send({ project: trackerPath, id: '#6', phase: 'groom', session: NEIGHBOUR, host: OWN_HOST });
    expect(claimed.status).toBe(201);
    const neighbourComment = claimed.body.commentId as number;

    await poll();

    expect(claimIn(100)?.released?.reason).toBe('aborted');
    expect(claimIn(neighbourComment)?.released).toBeUndefined();
  });

  it('leaves a claim alone when a registry file names its session — whatever that file-s pid, since the sweeper never tests a pid', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    // A pid that is certainly not running on this machine. Inside the container every host pid would answer ESRCH, so a pid test would read this live
    // session as dead; file presence alone is the rule, and a hard-killed session's leftover file keeps it on the fifteen-minute window.
    registryFile('999999.json', { pid: 999_999, sessionId: HOLDER, procStart: '1' });
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
    expect(claimIn(100)?.released).toBeUndefined();
  });

  it('leaves a claim alone when its host is not one this process has seen', async () => {
    await build([{ record: record({ host: 'futin@other-box' }), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves every claim alone until some claim request has taught it a host', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves a run-s claim alone — a run has its own recovery path', async () => {
    const run = { runId: 'run-20260923-073143', startedAt: '2026-09-23T07:31:43.000Z', mergeMode: 'merge', questionMode: 'park', maxItems: null, base: 'main' } as const;
    await build([{ record: record({ run }), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves a claim alone whose session is the <user>@<host> fallback, which has no registry entry by construction', async () => {
    await build([{ record: record({ session: 'futin@box' }), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when the registry directory is missing', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    process.env[SESSIONS_DIR_ENV] = join(registryDir, 'absent');
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when the registry directory is not configured', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    delete process.env[SESSIONS_DIR_ENV];
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when a registry file carries no sessionId — a registry it does not understand reads as unknown, never as empty', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    registryFile('4242.json', { pid: 4242, procStart: '1' });
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores the sibling .key files Claude Code writes beside each registry entry', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    writeFileSync(join(registryDir, '4242.0123abcd.key'), 'not json');
    const spy = releaseSpy();

    await poll();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-released claim and a dead one alone', async () => {
    await build([
      { record: record({ released: { at: new Date().toISOString(), reason: 'stopped', by: HOLDER } }), issue: 5, id: 100 },
      { record: record({ heartbeat: new Date(Date.now() - CLAIM_STALE_MS - 60_000).toISOString() }), issue: 6, id: 200 }
    ]);
    sweeper().noteOwnHost(OWN_HOST);
    const spy = releaseSpy();

    await poll();

    expect(spy).not.toHaveBeenCalled();
  });

  it('takes a conflict answer in its stride and goes on to the next claim', async () => {
    await build([
      { record: record(), issue: 5, id: 100 },
      { record: record({ session: NEIGHBOUR }), issue: 6, id: 200 }
    ]);
    sweeper().noteOwnHost(OWN_HOST);
    const source = app.get(GithubSource);
    const real = source.release.bind(source);
    const spy = jest
      .spyOn(source, 'release')
      .mockImplementationOnce(async () => ({ ok: false, refusal: { refused: 'conflict', error: 'claim 100 on #5 is already released' } }))
      .mockImplementation(real);

    await expect(poll()).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(claimIn(200)?.released?.reason).toBe('aborted');
  });

  it('is never invoked while the poller is not armed — no token, no sweep', async () => {
    await build([{ record: record(), issue: 5, id: 100 }]);
    sweeper().noteOwnHost(OWN_HOST);
    delete process.env[GITHUB_TOKEN_ENV];
    const spy = jest.spyOn(sweeper(), 'sweepRepo');

    await poll();

    expect(spy).not.toHaveBeenCalled();
    expect(claimIn(100)?.released).toBeUndefined();
  });
});
