import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ItemsModule } from '../server/src/items/items.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import type { ClaimRecord, ClaimResult, ItemsIndex } from '../shared/types';

/**
 * A claim posted BEFORE this process started (task-46 fix pass, the review's
 * Critical).
 *
 * Every other suite in this branch seeds its claims and then ticks, so the
 * cache always saw the comment arrive. That is the easy half of the world. The
 * hard half — and the one the whole phase exists for — is a server that starts
 * up into a repo where somebody, possibly on another machine, is already
 * holding an item:
 *
 *   * `docker compose restart`, a `pnpm run dev` reload, a laptop reboot;
 *   * the SECOND machine's server, which has never seen the first machine's
 *     comments at all;
 *   * a `backlog.mjs stop` that is the first thing to touch a server nobody has
 *     opened the board on, so the poller has never even been armed.
 *
 * In all three the question is the same: does this build still know who holds
 * the item? Until this fix it did not, and the two answers it gave were the two
 * worst available — the board drew a held item as FREE with its dispatch button
 * enabled, and `backlog.mjs stop` printed `not in progress` and exited 1,
 * orphaning the claim with `in-progress` and the assignee still set and the
 * session's counters (which only the CLI can compute) lost for good.
 *
 * ## Why the timestamps in this file are exact
 *
 * The bug was arithmetic, not logic. `syncRepo` reads issues first and
 * `absorbIssues` advances the high-water mark to the newest issue's
 * `updated_at`; the comments request then sent THAT as its `since`. So a claim
 * is invisible exactly when some OTHER issue has been touched more recently
 * than the claimed one — which is the ordinary state of any repo with more than
 * one issue in it. #5 is claimed at 10:00 and #9 is edited at 10:05 below, and
 * those five minutes are the whole failure.
 */

const TOKEN = 'ghp_task46ColdCacheSentinel';
const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });

const dirs: string[] = [];
const env = { ...process.env };

let app: INestApplication;
let gh: FakeGithub;
let trackerPath: string;

/** A live claim, held now — only its `at`/`heartbeat` matter to these cases. */
function record(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    v: 1,
    session: 'the-other-machine',
    phase: 'execute',
    at: '2026-09-18T10:00:00Z',
    heartbeat: new Date().toISOString(),
    counters: { groomElapsed: 0, executeElapsed: 42, groomTokens: 0, executeTokens: 900 },
    ...over
  };
}

/**
 * A repo as it looks to a server that has just started: #5 claimed at 10:00,
 * #9 touched at 10:05, and the claim comment stamped 10:00 like the issue it
 * sits on. Nothing is ticked here — each case decides whether the poller ever
 * runs, because that is the variable under test.
 */
async function build(): Promise<void> {
  gh = new FakeGithub();
  gh.issue({ number: 5, title: 'somebody is on this', updated_at: '2026-09-18T10:00:00Z' });
  gh.issue({ number: 9, title: 'edited more recently', updated_at: '2026-09-18T10:05:00Z' });
  const claim = gh.claim(record(), 5, 100);
  claim.created_at = '2026-09-18T10:00:00Z';
  claim.updated_at = '2026-09-18T10:00:00Z';

  trackerPath = makeProject('gamma', [], GITHUB_MARKER);
  dirs.push(trackerPath);

  /* The bootstrap hook arms the poller, and `arm()` starts its first sweep
     fire-and-forget — so an app built with a token present has already made a
     round of requests by the time a case looks at the log, and every count
     below would be off by one sweep it did not ask for. `disarm()` cannot undo
     it either: that clears the timer, not a sweep already in flight.

     Withholding the token across `init()` is what actually prevents it —
     `shouldPoll()` is false without one, so `arm()` clears the timer and
     returns having done nothing. The token goes back immediately afterwards,
     before any case runs, so the sweeps each case DOES ask for are ordinary. */
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

/** `#5` as `/api/items` renders it. */
async function itemFive(): Promise<{ started: string; phase: string; executeElapsed: number } | undefined> {
  const res = await request(app.getHttpServer()).get('/api/items').expect(200);
  return (res.body as ItemsIndex).items.find((i) => i.id === '#5');
}

/** One sweep, and no successor: `sweep()` schedules the next tick when it
 *  finishes, and a pending timer is one more thing that could fire between a
 *  case's act and its assert. */
async function sweep(): Promise<void> {
  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
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

describe('a claim made before this process started', () => {
  /**
   * The POLLER's half, and the one that cannot be papered over by a fallback:
   * `claimsByIssue` (`github.source.ts`'s `list`) reads the cache and nothing
   * else, so if the sweep did not bring the comment in, every board in the
   * world draws #5 as free while a session holds it.
   */
  it('is in the cache after one sweep, so the board draws the item as held', async () => {
    await sweep();

    const item = await itemFive();
    expect(item?.started).toBe('2026-09-18T10:00:00Z');
    expect(item?.phase).toBe('execute');
    // The counters ride the same claim: an item whose accrued cost reads zero
    // after a restart is the same defect wearing a different number.
    expect(item?.executeElapsed).toBe(42);
  });

  /**
   * The same sweep, through the eighth route — `backlog.mjs stop`'s lookup.
   * Asserted beside the board's because the two readers are independent and
   * the failure was worse on this one: the board merely looked wrong, while the
   * CLI ended the session by losing the counters.
   */
  it('is answered by GET /api/items/claim after one sweep', async () => {
    await sweep();

    const res = await request(app.getHttpServer())
      .get('/api/items/claim')
      .query({ project: trackerPath, id: '#5' })
      .expect(200);
    expect((res.body as ClaimResult).commentId).toBe(100);
    expect((res.body as ClaimResult).record.session).toBe('the-other-machine');
  });

  /**
   * The comments read must ask for a window of its OWN. Stated as a request
   * assertion rather than only as an outcome because the outcome above can be
   * made green by a fallback, and this is the line that actually decides
   * whether the cache is complete: the first sweep of a repo has seen no
   * comments, so it must send no `since` at all.
   */
  it('asks for every comment on the first sweep, never since the newest issue', async () => {
    await sweep();

    const commentReads = gh.calls.filter((c) => c.method === 'GET' && c.url.includes('/issues/comments'));
    expect(commentReads).toHaveLength(1);
    expect(commentReads[0].url).not.toContain('since=');
    // And the issues read DID send its own mark forward on the next sweep, so
    // the two marks are provably separate rather than both simply disabled.
    await sweep();
    const second = gh.calls.filter((c) => c.method === 'GET' && c.url.includes('/issues?state=all'));
    expect(second[1].url).toContain(`since=${encodeURIComponent('2026-09-18T10:05:00Z')}`);
  });

  /**
   * The second sweep asks from the newest COMMENT, not from zero: the mark has
   * to move or every tick re-reads the whole repo's comment history, which is
   * the cost `since` exists to avoid.
   */
  it('moves its own comments mark, so a later sweep asks from the newest comment', async () => {
    await sweep();
    await sweep();

    const commentReads = gh.calls.filter((c) => c.method === 'GET' && c.url.includes('/issues/comments'));
    expect(commentReads).toHaveLength(2);
    expect(commentReads[1].url).toContain(`since=${encodeURIComponent('2026-09-18T10:00:00Z')}`);
  });

  /**
   * `Link` is followed to the end. A repo with more than a page of comments
   * newer than the mark would otherwise land only its first page, and a claim
   * is as likely to be on the second — the issues loop one method up has always
   * paginated, and this one silently did not.
   */
  it('follows the comments pagination, so a claim on a later page still lands', async () => {
    // Two comments, one row per page, and the claim is the SECOND — so only a
    // caller that follows `rel="next"` ever sees it.
    gh.pageSize = 1;
    const chatter = gh.claim(record(), 9, 50);
    chatter.body = 'just a conversation comment';
    chatter.updated_at = '2026-09-17T09:00:00Z';

    await sweep();

    expect((await itemFive())?.started).toBe('2026-09-18T10:00:00Z');
  });

  /**
   * The COLD path, and the one the poller fix alone cannot reach: a server
   * nobody has opened the board on has never armed the poller, so its cache is
   * empty rather than merely incomplete. `readClaim` falls back to one fresh
   * read, because a cache miss means "this process has not seen it" and
   * answering `null` there is what orphans the claim.
   *
   * No tick anywhere in this case — that is the whole point of it.
   */
  it('is answered by GET /api/items/claim with no sweep at all, from a fresh read', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/items/claim')
      .query({ project: trackerPath, id: '#5' })
      .expect(200);

    expect((res.body as ClaimResult).commentId).toBe(100);
    expect((res.body as ClaimResult).record.counters.executeElapsed).toBe(42);
    // It really did go to the network, and only for this one issue's comments.
    expect(gh.calls.filter((c) => c.url.includes('/issues/5/comments'))).toHaveLength(1);
  });

  /** A genuinely unclaimed item still answers `null` — the fallback must not
   *  turn "nobody holds it" into an error or into a phantom claim. */
  it('answers null for an unclaimed item, having looked', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/items/claim')
      .query({ project: trackerPath, id: '#9' })
      .expect(200);

    expect(res.body).toEqual({});
    expect(gh.calls.filter((c) => c.url.includes('/issues/9/comments'))).toHaveLength(1);
  });

  /** …and the cache is still the fast path: a claim already there costs no
   *  request at all, which is what keeps `stop` free in the common case. */
  it('makes no request when the cache already holds the claim', async () => {
    await sweep();
    gh.calls.length = 0;

    await request(app.getHttpServer()).get('/api/items/claim').query({ project: trackerPath, id: '#5' }).expect(200);
    expect(gh.calls).toEqual([]);
  });
});
