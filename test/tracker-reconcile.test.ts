import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ItemsModule } from '../server/src/items/items.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { deriveRemoteRuns } from '../server/src/orchestrator/remote-runs.util';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { RECONCILE_GRACE_MS, TrackerPollerService } from '../server/src/tracker/poller.service';
import { renderClaim } from '../server/src/tracker/claim';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import type { ClaimRecord, ClaimResult, ClaimRun, ItemsIndex } from '../shared/types';

/**
 * A claim deleted by ANOTHER machine's server leaves the cache (bug-55).
 *
 * The poller's repository-wide comment read is incremental — `since` plus an
 * ETag — and a deleted comment is simply never mentioned again by any later
 * response. `forgetComment` closes that hole for the one deletion this process
 * makes itself, a claim that lost the race seconds after posting it. A loser on
 * the OTHER machine is deleted by that machine's server, so on this one it sat
 * in the cache for good: a phantom remote run in `GET /api/orchestrator/runs`,
 * an `executing` card on the board, and the answer `GET /api/items/claim` gave
 * — observed live on 2026-09-22, twice, once per lost race.
 *
 * The fix re-reads, once per tick, the comments of every issue the cache holds
 * an UNRELEASED claim on, and lets that list be the truth for that issue. Every
 * case here is against the in-memory GitHub (`helpers/github.ts`), so "the
 * other machine deleted it" is one `gh.comments.delete(id)`.
 */

const TOKEN = 'ghp_bug55ReconcileSentinel';
const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });
const WINNER_RUN: ClaimRun = { runId: 'run-20260922-201553', startedAt: '2026-09-22T20:15:53.000Z', mergeMode: 'merge', questionMode: 'park', maxItems: null, base: 'main' };
const LOSER_RUN: ClaimRun = { ...WINNER_RUN, runId: 'run-20260922-201615', startedAt: '2026-09-22T20:16:15.000Z' };

const dirs: string[] = [];
const env = { ...process.env };

let app: INestApplication;
let gh: FakeGithub;
let trackerPath: string;

/** A live, unreleased claim on #5. `at` is ten minutes back, so the comment
 *  the fake stamps from it is well outside the reconcile's grace window. */
function record(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    v: 1,
    session: 'mac-driver',
    phase: 'execute',
    at: new Date(Date.now() - 10 * 60_000).toISOString(),
    heartbeat: new Date().toISOString(),
    counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 },
    run: WINNER_RUN,
    ...over
  };
}

/**
 * #5 with two unreleased claims — the winner (100) and the loser (200) — the
 * state the Mac's cache was in the moment it absorbed the Linux run's claim.
 * The app is built with the token withheld across `init()`, for the reason
 * `tracker-cold-cache.test.ts` gives: otherwise the bootstrap's own sweep lands
 * in the call log before any case asks for one.
 */
async function build(): Promise<void> {
  gh = new FakeGithub();
  gh.issue({ number: 5, title: 'raced', updated_at: '2026-09-22T20:00:00Z' });
  gh.claim(record(), 5, 100);
  gh.claim(record({ session: 'linux-driver', run: LOSER_RUN }), 5, 200);

  trackerPath = makeProject('gamma', [], GITHUB_MARKER);
  dirs.push(trackerPath);

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

function poller(): TrackerPollerService {
  return app.get(TrackerPollerService);
}

/** One sweep and no successor — see `tracker-cold-cache.test.ts`'s `sweep`. */
async function sweep(): Promise<void> {
  await poller().tick();
  poller().disarm();
}

function cachedIds(): number[] {
  return [...poller().comments(FAKE_REPO)].map((c) => c.id).sort((a, b) => a - b);
}

function issueReads(): Array<{ url: string; ifNoneMatch?: string }> {
  return gh.calls.filter((c) => c.method === 'GET' && /\/issues\/\d+\/comments/.test(c.url));
}

/** The loser deletes its own comment — on the other machine, so this
 *  process's `forgetComment` never hears of it. */
function otherMachineDeletes(id: number): void {
  gh.comments.delete(id);
}

beforeEach(async () => {
  await build();
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('a claim deleted by another machine', () => {
  it('leaves the cache on the next tick, and no remote run is derived from it', async () => {
    await sweep();
    expect(cachedIds()).toEqual([100, 200]);

    otherMachineDeletes(200);
    await sweep();

    expect(cachedIds()).toEqual([100]);
    const remote = deriveRemoteRuns({
      repo: FAKE_REPO,
      project: trackerPath,
      comments: poller().comments(FAKE_REPO),
      issueTitle: () => 'raced',
      localRunIds: new Set(),
      nowMs: Date.now()
    });
    expect(remote.map((r) => r.runId)).toEqual([WINNER_RUN.runId]);
  });

  /**
   * The case the rejected mapper-side filter ("ignore a claim with a lower live
   * rival") would have got wrong: once the winner releases, the ghost is the
   * lowest UNRELEASED claim and would be drawn as the holder again.
   */
  it('stays gone once the winner releases, so the item maps as free', async () => {
    await sweep();

    const winner = gh.comments.get(100)!;
    gh.comments.set(100, {
      ...winner,
      body: renderClaim(record({ released: { at: new Date().toISOString(), reason: 'aborted', by: 'mac-driver' } })),
      updated_at: new Date().toISOString()
    });
    otherMachineDeletes(200);
    await sweep();

    expect(cachedIds()).toEqual([100]);
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const five = (res.body as ItemsIndex).items.find((i) => i.id === '#5');
    expect(five?.started).toBe('');
  });

  it('answers GET /api/items/claim with the surviving claim, not the ghost', async () => {
    await sweep();
    otherMachineDeletes(200);
    await sweep();

    const res = await request(app.getHttpServer()).get('/api/items/claim').query({ project: trackerPath, id: '#5' }).expect(200);
    expect((res.body as ClaimResult).commentId).toBe(100);
  });
});

describe('what the reconcile costs', () => {
  it('makes no per-issue request for a repo whose claims are all released', async () => {
    const released = { at: new Date().toISOString(), reason: 'done', by: 'mac-driver' };
    for (const id of [100, 200]) {
      const c = gh.comments.get(id)!;
      gh.comments.set(id, { ...c, body: renderClaim(record({ released })) });
    }

    await sweep();
    await sweep();

    expect(cachedIds()).toEqual([100, 200]);
    expect(issueReads()).toEqual([]);
  });

  it('makes no per-issue request for a repo with no claims at all', async () => {
    gh.comments.clear();

    await sweep();

    expect(issueReads()).toEqual([]);
  });

  it('sends the per-issue ETag back, and a 304 leaves the cache as it was', async () => {
    await sweep();
    const before = JSON.stringify([...poller().comments(FAKE_REPO)]);

    await sweep();

    const reads = issueReads();
    expect(reads).toHaveLength(2);
    expect(reads[0].ifNoneMatch).toBeUndefined();
    expect(reads[1].ifNoneMatch).toEqual(expect.any(String));
    expect(JSON.stringify([...poller().comments(FAKE_REPO)])).toBe(before);
  });

  it('stops re-checking an issue whose last unreleased claim is gone', async () => {
    await sweep();
    gh.comments.clear();
    await sweep();
    expect(cachedIds()).toEqual([]);

    const before = issueReads().length;
    await sweep();
    expect(issueReads()).toHaveLength(before);
  });
});

describe('the grace window', () => {
  /**
   * GitHub's comment listing is eventually consistent — the reason the claim
   * protocol unions two lists — so a claim this process absorbed a second ago
   * can be missing from a list made now. Dropping it would draw a held item as
   * free.
   */
  it('keeps a just-absorbed claim the per-issue list does not show yet', async () => {
    await sweep();
    const young = gh.claim(record({ session: 'fresh', at: new Date().toISOString() }), 5, 300);
    poller().absorbComment(FAKE_REPO, young);
    gh.hideFromIssueLists.add(300);

    await sweep();

    expect(cachedIds()).toContain(300);
  });

  it('drops the same claim once it is older than the grace', async () => {
    await sweep();
    const old = gh.claim(record({ session: 'old', at: new Date(Date.now() - RECONCILE_GRACE_MS - 5_000).toISOString() }), 5, 300);
    poller().absorbComment(FAKE_REPO, old);
    gh.comments.delete(300);

    await sweep();

    expect(cachedIds()).not.toContain(300);
  });

  /** A 304 must not freeze a young comment in: the list it vouches for did not
   *  have it, so once the grace lapses a 304 drops it just as a 200 would. */
  it('drops a grace-kept comment on a later 304 once the grace has lapsed', async () => {
    await sweep();
    const young = gh.claim(record({ session: 'ghost', at: new Date().toISOString() }), 5, 300);
    poller().absorbComment(FAKE_REPO, young);
    gh.comments.delete(300);
    await sweep();
    expect(cachedIds()).toContain(300);

    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + RECONCILE_GRACE_MS + 5_000);
    try {
      await sweep();
    } finally {
      spy.mockRestore();
    }

    expect(issueReads().at(-1)?.ifNoneMatch).toEqual(expect.any(String));
    expect(cachedIds()).not.toContain(300);
  });
});

describe('failures', () => {
  it('leaves the issue untouched on a rate limit and makes no further per-issue request that tick', async () => {
    gh.issue({ number: 6, title: 'also claimed', updated_at: '2026-09-22T20:00:00Z' });
    gh.claim(record({ session: 'six' }), 6, 150);
    await sweep();
    expect(cachedIds()).toEqual([100, 150, 200]);

    otherMachineDeletes(200);
    otherMachineDeletes(150);
    const before = issueReads().length;
    gh.failNext = { fragment: '/issues/5/comments', status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } };
    await sweep();

    expect(cachedIds()).toEqual([100, 150, 200]);
    expect(poller().summary(FAKE_REPO).access).toBe('rate-limited');
    // #5 is asked first (ascending) and fails; #6 is never asked.
    expect(issueReads().slice(before).map((c) => c.url.match(/\/issues\/(\d+)\//)?.[1])).toEqual(['5']);
  });

  it('treats a 404 on the issue as an empty list, and leaves access alone', async () => {
    await sweep();
    gh.failNext = { fragment: '/issues/5/comments', status: 404 };

    await sweep();

    expect(cachedIds()).toEqual([]);
    expect(poller().summary(FAKE_REPO).access).toBe('ok');
  });
});

describe('the repo-wide stream', () => {
  /** `commentsHwm` belongs to the repository-wide read alone — the task-46
   *  incident that field's doc describes is what a shared mark re-opens. */
  it('does not move the comments high-water mark from a reconcile', async () => {
    await sweep();

    // A comment only the per-issue list returns, stamped far in the future so
    // any mark it moved would show up in the next repo-wide `since`.
    const late = gh.claim(record({ session: 'late' }), 5, 400);
    late.updated_at = '2099-01-01T00:00:00Z';
    gh.hideFromRepoStream.add(400);

    await sweep();
    expect(cachedIds()).toContain(400);

    await sweep();
    const reads = gh.calls.filter((c) => c.url.includes('/issues/comments?'));
    expect(reads.at(-1)?.url).not.toContain(encodeURIComponent('2099-01-01T00:00:00Z'));
  });
});
