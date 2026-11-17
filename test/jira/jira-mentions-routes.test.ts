import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { JIRA_MENTIONS_DISMISS_MAX, JIRA_REPLY_MAX_CHARS, JIRA_MENTIONS_POLL_MS, JIRA_MENTIONS_WINDOW_DAYS, type JiraMentionsConfigured } from '../../shared/types';
import * as atomic from '../../server/src/atomic-write.util';
import { AppModule } from '../../server/src/app.module';
import { JiraClient } from '../../server/src/jira/jira.client';
import { replyDoc } from '../../server/src/jira/adf';
import { JiraLiveService } from '../../server/src/jira/live.service';
import { JiraMentionsStore } from '../../server/src/jira/mentions.store';
import { replyUnconfirmed } from '../../server/src/jira/mentions.controller';
import { mentionsJql } from '../../server/src/jira/mentions.util';
import { JIRA_POLL_MS, JiraPollerService, SWEEP_FLOOR_MS } from '../../server/src/jira/poller.service';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { listenLoopback } from '../helpers/app';
import { FakeJira, makeRawIssue, type SeededComment } from '../helpers/jira';
import { makeRegistry } from '../helpers/store';

/**
 * Jira › Mentions — the routes (plan Task 6; spec "Routes and shapes", "Poller arming", "Failure handling"): `GET /api/jira/mentions`, the status payload's
 * `mentions` summary, `POST /api/jira/mentions/sweep|dismiss|restore`, `GET /api/jira/issue/:key/thread`, and the site sweep checking mentions.
 *
 * One app per case, built as `jira-sweep-route.test.ts` builds it, with `Date.now` FROZEN at `now` (moved by hand) rather than skewed off the real clock:
 * the cadence case asserts a boundary to the millisecond, which a clock that keeps running cannot. The boot tick that `app.init()` starts checks mentions
 * at once (spec "Poller arming"), so every case starts with one mentions search made, at `T0`.
 */

const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE'] as const;
const T0 = Date.parse('2026-11-16T12:00:00Z');
const MIN = 60_000;
const ME = { accountId: 'acc-1', displayName: 'Ada Lovelace' };
const MARA = { accountId: 'acc-m', displayName: 'Mara Ilić' };
const IVO = { accountId: 'acc-i', displayName: 'Ivo Ban' };
const JQL = mentionsJql(ME.accountId, JIRA_MENTIONS_WINDOW_DAYS);
const BOARD_ON = { id: 'b_0123abcd', name: 'On', roots: ['PAY-120'], queries: [], interval: '1m' };
const BOARD_OFF = { id: 'b_0123abcf', name: 'Off', roots: ['PAY-999'], queries: [], interval: 'off' };

let saved: Record<string, string | undefined>;
let dir: string;
let fake: FakeJira;
let app: INestApplication;
let poller: JiraPollerService;
let now: number;

/** An ADF body that @-mentions `id`, or plain text when `id` is null. */
function body(id: string | null, text: string): unknown {
  const content: unknown[] = id === null ? [] : [{ type: 'mention', attrs: { id, text: '@Ada Lovelace' } }];
  content.push({ type: 'text', text: ` ${text}` });
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] };
}

let seq = 0;
/** One comment `minutesAgo` before T0 by `who`, mentioning me when `mentionsMe`. Ids are distinct digit strings across the suite. */
function comment(who: { accountId: string; displayName: string }, minutesAgo: number, mentionsMe: boolean, text = 'a comment'): SeededComment {
  seq += 1;
  return {
    id: String(20_000 + seq),
    author: { ...who },
    created: new Date(T0 - minutesAgo * MIN).toISOString(),
    body: body(mentionsMe ? ME.accountId : null, text)
  };
}

/** Seed an issue the mentions search returns, with `comments` oldest first. */
function mentionIssue(key: string, comments: SeededComment[]): void {
  fake.issues.set(key, makeRawIssue({ key, fields: { summary: `About ${key}` } }));
  fake.addComments(key, comments);
  fake.answers.set(JQL, [...(fake.answers.get(JQL) ?? []), key]);
}

/**
 * SUP-208's thread, oldest first: Mara's mention I answered (c1), my answer (c2), a plain comment by Ivo (c3), and Mara's mention after it (c4) — the one
 * open mention. SUP-300 and SUP-400 each hold one open mention by Ivo, older than c4.
 */
let c1: SeededComment, c2: SeededComment, c3: SeededComment, c4: SeededComment, s300: SeededComment, s400: SeededComment;
function seedTickets(): void {
  c1 = comment(MARA, 120, true, 'first question');
  c2 = comment(ME, 90, false, 'my answer');
  c3 = comment(IVO, 60, false, 'plain');
  c4 = comment(MARA, 30, true, 'second question');
  mentionIssue('SUP-208', [c1, c2, c3, c4]);
  s300 = comment(IVO, 40, true, 'ping 300');
  mentionIssue('SUP-300', [s300]);
  s400 = comment(IVO, 50, true, 'ping 400');
  mentionIssue('SUP-400', [s400]);
}

interface BuildOpts {
  boards?: unknown[];
  on?: boolean;
  /** Called on the fake after seeding, before `app.init()` starts the boot tick — where a case parks the boot's own search. */
  beforeInit?: () => void;
  /** Wait for the boot tick (default). False leaves it running, for the "before the first check" case. */
  awaitBoot?: boolean;
}

async function build({ boards = [], on = true, beforeInit, awaitBoot = true }: BuildOpts = {}): Promise<void> {
  process.env.BM_JIRA_SITE = on ? 'acme.atlassian.net' : '';
  process.env.BM_JIRA_EMAIL = on ? 'ada@example.com' : '';
  process.env.BM_JIRA_TOKEN = on ? 't0k3n-SECRET' : '';
  const file = join(dir, `jira-${seq}-${Math.random().toString(36).slice(2)}.json`);
  process.env.BM_JIRA_FILE = file;
  writeFileSync(file, JSON.stringify({ boards }));
  fake = new FakeJira();
  for (const key of ['PAY-120', 'PAY-999']) {
    fake.issues.set(key, makeRawIssue({ key, fields: { issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false } } }));
  }
  seedTickets();
  beforeInit?.();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry([]))
    .overrideProvider(JiraClient)
    .useValue(new JiraClient(fake.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  poller = app.get(JiraPollerService);
  if (awaitBoot) await poller.tick();
}

const http = () => request(app.getHttpServer());
const post = (path: string, payload: unknown = {}) => http().post(path).set('content-type', 'application/json').send(JSON.stringify(payload));
const mentions = async (): Promise<JiraMentionsConfigured> => (await http().get('/api/jira/mentions').expect(200)).body as JiraMentionsConfigured;
const check = () => post('/api/jira/mentions/sweep');
const dismiss = (key: string, commentIds: unknown) => post('/api/jira/mentions/dismiss', { key, commentIds });
const restore = (key: string) => post('/api/jira/mentions/restore', { key });

const searches = () => fake.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => (c.body as { jql: string }).jql);
const mentionSearches = () => searches().filter((j) => j === JQL).length;
const boardSearches = () => searches().filter((j) => j !== JQL).length;
const keysOf = (list: { key: string }[]) => list.map((i) => i.key);

/** Step past the floor of the last mentions check, so the next press is a real check. */
const pastFloor = () => (now += SWEEP_FLOOR_MS + 1_000);

/** Turn the event loop until `cond` holds — for a request started without awaiting it, until it has reached the point the case needs. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('until: condition never held');
}

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-mentions-routes-'));
});
beforeEach(() => {
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await app.close();
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/jira/mentions', () => {
  it('answers the unconfigured shape GET /api/jira uses, with no call', async () => {
    await build({ on: false });
    expect((await http().get('/api/jira/mentions').expect(200)).body).toEqual({ configured: false, detail: 'BM_JIRA_SITE is not set' });
    expect(fake.calls).toEqual([]);
  });

  it('serves the cache, newest open mention first, with the row fields only (no candidates)', async () => {
    await build();
    const before = fake.calls.length;
    const body = await mentions();
    expect(fake.calls.length).toBe(before);
    expect(body).toMatchObject({ configured: true, polledAt: new Date(T0).toISOString(), detail: null, truncated: false, retryAt: null, window: 30 });
    expect(body.me).toBe('Ada Lovelace');
    expect(keysOf(body.issues)).toEqual(['SUP-208', 'SUP-300', 'SUP-400']);
    expect(body.dismissed).toEqual([]);
    const sup = body.issues[0];
    expect(Object.keys(sup).sort()).toEqual(['boards', 'draft', 'key', 'mentions', 'session', 'status', 'summary', 'type']);
    expect(sup).toMatchObject({ draft: null, session: null });
    expect(sup).toMatchObject({ key: 'SUP-208', summary: 'About SUP-208', type: 'Task', status: { name: 'To Do', category: 'new' }, boards: [] });
    expect(sup.mentions.map((m) => m.commentId)).toEqual([c4.id]);
  });

  it('is polledAt null and empty before the first check lands', async () => {
    let release!: () => void;
    await build({ awaitBoot: false, beforeInit: () => (release = fake.holdNextSearch()) });
    await until(() => mentionSearches() === 1);
    const body = await mentions();
    expect(body).toMatchObject({ polledAt: null, issues: [], dismissed: [] });
    release();
    await poller.tick();
    expect((await mentions()).polledAt).toBe(new Date(T0).toISOString());
  });
});

describe('the status summary (spec "Poller arming")', () => {
  it('is null while unconfigured', async () => {
    await build({ on: false });
    expect((await http().get('/api/jira').expect(200)).body.mentions).toBeNull();
  });

  it('counts null before the first check, then the waiting TICKETS, a dismissed one not among them', async () => {
    let release!: () => void;
    await build({ awaitBoot: false, beforeInit: () => (release = fake.holdNextSearch()) });
    await until(() => mentionSearches() === 1);
    expect((await http().get('/api/jira').expect(200)).body.mentions).toEqual({
      polledAt: null,
      count: null,
      detail: null,
      truncated: false,
      retryAt: null
    });
    release();
    await poller.tick();
    expect((await http().get('/api/jira').expect(200)).body.mentions).toMatchObject({ count: 3, polledAt: new Date(T0).toISOString() });
    await dismiss('SUP-400', [s400.id]).expect(200);
    expect((await http().get('/api/jira').expect(200)).body.mentions).toMatchObject({ count: 2 });
  });
});

describe('POST /api/jira/mentions/dismiss and /restore', () => {
  it('moves a ticket whose open mentions are all dismissed into dismissed, and answers the new payload', async () => {
    await build();
    const res = await dismiss('SUP-208', [c4.id]).expect(200);
    expect(keysOf(res.body.issues)).toEqual(['SUP-300', 'SUP-400']);
    expect(keysOf(res.body.dismissed)).toEqual(['SUP-208']);
    expect(res.body.dismissed[0].mentions.map((m: { commentId: string }) => m.commentId)).toEqual([c4.id]);
    expect(await mentions()).toEqual(res.body);
  });

  it('dismiss during an in-flight check survives the swap', async () => {
    await build();
    pastFloor();
    const release = fake.holdNextSearch();
    const pressed = check().then((r) => r);
    await until(() => mentionSearches() === 2);
    await dismiss('SUP-208', [c4.id]).expect(200);
    release();
    const res = await pressed;
    expect(res.status).toBe(200);
    expect(keysOf(res.body.dismissed)).toEqual(['SUP-208']);
    expect(keysOf(res.body.issues)).not.toContain('SUP-208');
    expect(keysOf((await mentions()).dismissed)).toEqual(['SUP-208']);
  });

  it('dismiss then a later new mention: the ticket is back in issues with only the new one; restore merges both back, newest first', async () => {
    await build();
    await dismiss('SUP-208', [c4.id]).expect(200);
    const c5 = comment(IVO, 10, true, 'third question');
    fake.addComments('SUP-208', [c5]);
    pastFloor();
    const res = await check().expect(200);
    expect(keysOf(res.body.issues)).toEqual(['SUP-208', 'SUP-300', 'SUP-400']);
    expect(res.body.issues[0].mentions.map((m: { commentId: string }) => m.commentId)).toEqual([c5.id]);
    expect(keysOf(res.body.dismissed)).toEqual([]);

    const restored = await restore('SUP-208').expect(200);
    expect(restored.body.issues[0].key).toBe('SUP-208');
    expect(restored.body.issues[0].mentions.map((m: { commentId: string }) => m.commentId)).toEqual([c5.id, c4.id]);
    expect(restored.body.dismissed).toEqual([]);
  });

  it('orders dismissed tickets by their newest dismissed mention', async () => {
    await build();
    await dismiss('SUP-400', [s400.id]).expect(200);
    const res = await dismiss('SUP-300', [s300.id]).expect(200);
    expect(keysOf(res.body.dismissed)).toEqual(['SUP-300', 'SUP-400']);
  });

  it('refuses a malformed request with a 400 and writes nothing', async () => {
    await build();
    const before = await mentions();
    const many = Array.from({ length: JIRA_MENTIONS_DISMISS_MAX + 1 }, (_, i) => String(i + 1));
    expect((await dismiss('SUP-208', []).expect(400)).body).toEqual({ error: 'commentIds must be 1 to 50 comment ids' });
    expect((await dismiss('SUP-208', many).expect(400)).body).toEqual({ error: 'commentIds must be 1 to 50 comment ids' });
    expect((await dismiss('SUP-208', 'nope').expect(400)).body).toEqual({ error: 'commentIds must be 1 to 50 comment ids' });
    expect((await dismiss('SUP-208', ['12a']).expect(400)).body).toEqual({ error: '12a is not a comment id' });
    expect((await dismiss('SUP-208', [12]).expect(400)).body).toEqual({ error: '12 is not a comment id' });
    expect((await dismiss('sup-208', [c4.id]).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await restore('sup-208').expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect(await mentions()).toEqual(before);
  });

  it('refuses an id that is not an open mention on that key: another ticket\'s, an answered one, an already dismissed one', async () => {
    await build();
    expect((await dismiss('SUP-208', [s300.id]).expect(400)).body).toEqual({ error: `${s300.id} is not an open mention on SUP-208` });
    expect((await dismiss('SUP-208', [c1.id]).expect(400)).body).toEqual({ error: `${c1.id} is not an open mention on SUP-208` });
    expect((await dismiss('SUP-999', [c4.id]).expect(400)).body).toEqual({ error: `${c4.id} is not an open mention on SUP-999` });
    await dismiss('SUP-208', [c4.id]).expect(200);
    expect((await dismiss('SUP-208', [c4.id]).expect(400)).body).toEqual({ error: `${c4.id} is not an open mention on SUP-208` });
  });

  it('is 500 "could not save — nothing changed" when the store cannot write, and the ticket stays in issues', async () => {
    await build();
    // The route logs the store's error once; silenced so the suite's output carries only failures.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(atomic, 'writeJsonAtomic').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect((await dismiss('SUP-208', [c4.id]).expect(500)).body).toEqual({ error: 'could not save — nothing changed' });
    expect(keysOf((await mentions()).issues)).toContain('SUP-208');
  });

  it('restore of a key with nothing dismissed is a 200 no-op', async () => {
    await build();
    const before = await mentions();
    const write = jest.spyOn(atomic, 'writeJsonAtomic');
    expect((await restore('SUP-208').expect(200)).body).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });

  it('is 503 while Jira is unconfigured, after the 400s', async () => {
    await build({ on: false });
    expect((await dismiss('sup-1', ['1']).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await dismiss('SUP-1', ['1']).expect(503)).body).toEqual({ error: 'Jira is not configured' });
    expect((await restore('SUP-1').expect(503)).body).toEqual({ error: 'Jira is not configured' });
  });
});

describe('POST /api/jira/mentions/sweep', () => {
  it('is 409 "Jira is not being polled" while unconfigured, with no call', async () => {
    await build({ on: false });
    expect((await check().expect(409)).body).toEqual({ message: 'Jira is not being polled' });
    expect(fake.calls).toEqual([]);
  });

  it('checks now and answers the fresh payload; a press within 5 s of the last check is answered from the cache', async () => {
    await build();
    const ivo = comment(IVO, 5, true, 'new');
    fake.addComments('SUP-300', [ivo]);
    pastFloor();
    const res = await check().expect(200);
    expect(mentionSearches()).toBe(2);
    expect(res.body.polledAt).toBe(new Date(now).toISOString());
    expect(res.body.issues[0].key).toBe('SUP-300');
    now += 1_000;
    await check().expect(200);
    now += 1_000;
    await check().expect(200);
    expect(mentionSearches()).toBe(2);
  });

  it('two concurrent presses make one search: the second joins the first while it is still out', async () => {
    await build();
    const presses = jest.spyOn(poller, 'mentionsSweepNow');
    pastFloor();
    // Parked until BOTH presses have reached the poller, so the second cannot be answered by the floor after the first ended: only the join answers it.
    const release = fake.holdNextSearch();
    const first = check().then((r) => r);
    await until(() => mentionSearches() === 2);
    const second = check().then((r) => r);
    await until(() => presses.mock.calls.length === 2);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(mentionSearches()).toBe(2);
  });

  it('inside a 429 window is 429 with the stored retryAt, and makes no call', async () => {
    await build();
    pastFloor();
    fake.rateLimit = { retryAfter: 120 };
    const first = await check().expect(200);
    const retryAt = new Date(now + 120_000).toISOString();
    expect(first.body.retryAt).toBe(retryAt);
    expect((await http().get('/api/jira').expect(200)).body.mentions.retryAt).toBe(retryAt);
    const calls = fake.calls.length;
    pastFloor();
    expect((await check().expect(429)).body).toEqual({ message: 'rate limited', retryAt });
    expect(fake.calls.length).toBe(calls);
  });

  it('a 401 inside the check is a 200, and moves access', async () => {
    await build();
    pastFloor();
    fake.unauthorized = true;
    await check().expect(200);
    expect((await http().get('/api/jira').expect(200)).body.access).toBe('unauthorized');
  });

  it('a 5xx inside the check is a 200 carrying the mentions detail, rows kept', async () => {
    await build();
    pastFloor();
    fake.failWith = 503;
    const res = await check().expect(200);
    expect(res.body.detail).toBe('Jira answered 503');
    expect(keysOf(res.body.issues)).toEqual(['SUP-208', 'SUP-300', 'SUP-400']);
  });

  it('resets the cadence: the next background search is 180 000 ms after the press', async () => {
    await build();
    pastFloor();
    const pressedAt = now;
    await check().expect(200);
    expect(mentionSearches()).toBe(2);
    // Without the reset the boot's check (T0) would make the next one due at T0 + 180 000, before this.
    now = pressedAt + JIRA_MENTIONS_POLL_MS - 1;
    await poller.tick();
    expect(mentionSearches()).toBe(2);
    now = pressedAt + JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect(mentionSearches()).toBe(3);
  });

  it('checks mentions only: a board due at the moment of the press is not searched by it', async () => {
    await build({ boards: [BOARD_ON] });
    const boards = boardSearches();
    now += 61_000; // the 1m board is due
    await check().expect(200);
    expect(boardSearches()).toBe(boards);
    expect(mentionSearches()).toBe(2);
  });

  it("leaves the CALLS meter alone: the press's calls are a route's, not a tick's", async () => {
    await build();
    const sweep = (await http().get('/api/jira').expect(200)).body.calls.sweep;
    pastFloor();
    await check().expect(200);
    expect(mentionSearches()).toBe(2);
    expect((await http().get('/api/jira').expect(200)).body.calls.sweep).toBe(sweep);
  });

  it("leaves the CALLS meter alone when the press lands while a tick's board sweep is out", async () => {
    await build({ boards: [BOARD_ON] });
    now += JIRA_POLL_MS + 61_000; // the 1m board is due; the mentions check is not (the boot's was under 180 s ago)
    const before = fake.calls.length;
    const release = fake.holdNextSearch();
    const tick = poller.tick();
    // The tick's first call is the board's search, parked: everything the press sends below lands while this tick is in flight.
    await until(() => fake.calls.length > before);
    const tickCallsBeforePress = fake.calls.length - before;
    const pressStart = fake.calls.length;
    pastFloor();
    await check().expect(200);
    const pressCalls = fake.calls.length - pressStart;
    expect(pressCalls).toBeGreaterThan(0);
    const afterPress = fake.calls.length;
    release();
    await tick;
    const tickCalls = tickCallsBeforePress + (fake.calls.length - afterPress);
    // The tick's figure is the tick's own calls, none of the press's — though the client's one counter saw both.
    expect((await http().get('/api/jira').expect(200)).body.calls.sweep).toBe(tickCalls);
  });

  it('is refused by the guard from another origin, as dismiss and restore are', async () => {
    await build();
    const before = fake.calls.length;
    await check().set('origin', 'http://evil.test').expect(403);
    await dismiss('SUP-208', [c4.id]).set('origin', 'http://evil.test').expect(403);
    await restore('SUP-208').set('origin', 'http://evil.test').expect(403);
    await http().post('/api/jira/mentions/sweep').send('{}').expect(403);
    expect(fake.calls.length).toBe(before);
    expect((await mentions()).dismissed).toEqual([]);
  });
});

describe('POST /api/jira/sweep checks mentions too (spec "Poller arming")', () => {
  it('site sweep with all boards off: 200, one more mentions search, no board searched', async () => {
    await build({ boards: [BOARD_OFF] });
    expect(mentionSearches()).toBe(1);
    const boards = boardSearches();
    pastFloor();
    await post('/api/jira/sweep').expect(200);
    expect(mentionSearches()).toBe(2);
    expect(boardSearches()).toBe(boards);
  });

  it('a site sweep that joins an in-flight manual check spends the force: one mentions search in all, none on the next tick', async () => {
    await build();
    const checks = jest.spyOn(poller as unknown as { checkMentions: (...a: unknown[]) => Promise<void> }, 'checkMentions');
    pastFloor();
    const release = fake.holdNextSearch();
    const manual = check().then((r) => r);
    await until(() => mentionSearches() === 2);
    const site = post('/api/jira/sweep').then((r) => r);
    // The site sweep's tick reached the mentions step and joined the parked check.
    await until(() => checks.mock.calls.length === 2);
    release();
    expect((await manual).status).toBe(200);
    expect((await site).status).toBe(200);
    expect(mentionSearches()).toBe(2);
    now += JIRA_POLL_MS;
    await poller.tick();
    expect(mentionSearches()).toBe(2);
  });
});

describe('GET /api/jira/issue/:key/thread', () => {
  it('answers the thread in time order, with mine, mentionsMe and open judged as the check judges them', async () => {
    await build();
    const res = await http().get('/api/jira/issue/SUP-208/thread').expect(200);
    expect(res.body).toMatchObject({ key: 'SUP-208', total: 4, truncated: false });
    expect(res.body.comments.map((c: { id: string }) => c.id)).toEqual([c1.id, c2.id, c3.id, c4.id]);
    expect(res.body.comments.map((c: { mine: boolean }) => c.mine)).toEqual([false, true, false, false]);
    expect(res.body.comments.map((c: { mentionsMe: boolean }) => c.mentionsMe)).toEqual([true, false, false, true]);
    expect(res.body.comments.map((c: { open: boolean }) => c.open)).toEqual([false, false, false, true]);
    expect(res.body.comments[3]).toEqual({
      id: c4.id,
      author: { accountId: MARA.accountId, name: MARA.displayName },
      created: c4.created,
      markdown: expect.stringContaining('second question'),
      mine: false,
      mentionsMe: true,
      open: true
    });
  });

  it('a dismissed mention is not open', async () => {
    await build();
    await dismiss('SUP-208', [c4.id]).expect(200);
    const res = await http().get('/api/jira/issue/SUP-208/thread').expect(200);
    expect(res.body.comments.map((c: { open: boolean }) => c.open)).toEqual([false, false, false, false]);
  });

  it('is truncated when the thread holds more than it returned', async () => {
    await build();
    fake.addComments('SUP-400', Array.from({ length: 100 }, (_, i) => comment(IVO, 45 - i * 0.1, false)));
    const res = await http().get('/api/jira/issue/SUP-400/thread').expect(200);
    expect(res.body).toMatchObject({ total: 101, truncated: true });
    expect(res.body.comments).toHaveLength(100);
  });

  it('is not truncated when Jira returned the whole thread but one entry was unreadable', async () => {
    await build();
    // An entry with no string id: `rawComments` skips it, so the modal shows 1 — but Jira sent all 2 it counts, which is not a cut thread.
    fake.addComments('SUP-400', [{ ...comment(IVO, 45, false), id: undefined } as unknown as SeededComment]);
    const res = await http().get('/api/jira/issue/SUP-400/thread').expect(200);
    expect(res.body).toMatchObject({ total: 2, truncated: false });
    expect(res.body.comments).toHaveLength(1);
  });

  it('a 404 or a 403 on the comment read is 404 "<KEY> is not readable"', async () => {
    await build();
    fake.failNext = ({ url }) => (url.includes('/issue/SUP-208/comment') ? { status: 404 } : null);
    expect((await http().get('/api/jira/issue/SUP-208/thread').expect(404)).body).toEqual({ error: 'SUP-208 is not readable' });
    fake.failNext = ({ url }) => (url.includes('/issue/SUP-208/comment') ? { status: 403 } : null);
    expect((await http().get('/api/jira/issue/SUP-208/thread').expect(404)).body).toEqual({ error: 'SUP-208 is not readable' });
  });

  it('any other failure goes through the routes\' mapping, and a bad key is 400', async () => {
    await build();
    fake.failWith = 500;
    expect((await http().get('/api/jira/issue/SUP-208/thread').expect(502)).body).toEqual({ error: 'Jira answered 500', access: 'unreachable' });
    expect((await http().get('/api/jira/issue/sup-208/thread').expect(400)).body).toEqual({ error: 'invalid issue key' });
  });

  it('is 503 while unconfigured', async () => {
    await build({ on: false });
    expect((await http().get('/api/jira/issue/SUP-208/thread').expect(503)).body).toEqual({ error: 'Jira is not configured' });
  });
});

describe('POST /api/jira/mentions/draft and /draft/discard (plan Task 4)', () => {
  const META = { action: 'reply', name: 'jira SUP-208', branch: null, surface: 'dashboard', model: null, effort: null, snapshot: { summary: 'S', type: 'Task', parentKey: null } } as const;
  const draft = (payload: Record<string, unknown>) => post('/api/jira/mentions/draft', payload);
  const discard = (key: string) => post('/api/jira/mentions/draft/discard', { key });
  /** A live reply link on `key` for `sessionId`, made the way the dispatch makes one. */
  const replyLink = (key = 'SUP-208', sessionId = 'rep-1'): JiraLiveService => {
    const live = app.get(JiraLiveService);
    live.reserve(key, '/repo', 'reply');
    live.confirm(key, sessionId, META, 'reply');
    return live;
  };
  const ok = { key: 'SUP-208', sessionId: 'rep-1', text: 'Thanks, fixed in the next release.' };

  it('refuses another origin with 403, and the CLI shape (no origin header, loopback) passes', async () => {
    await build();
    replyLink();
    await draft(ok).set('origin', 'http://evil.test').expect(403);
    await discard('SUP-208').set('origin', 'http://evil.test').expect(403);
    await draft(ok).expect(200);
  });

  it('validates in order: key, session id, text, then length', async () => {
    await build();
    expect((await draft({ ...ok, key: 'sup-208' }).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await draft({ ...ok, sessionId: 'x y' }).expect(400)).body).toEqual({ error: 'invalid session id' });
    expect((await draft({ ...ok, text: '   ' }).expect(400)).body).toEqual({ error: 'text must be a non-empty string' });
    expect((await draft({ ...ok, text: 7 }).expect(400)).body).toEqual({ error: 'text must be a non-empty string' });
    expect((await draft({ ...ok, text: 'a'.repeat(JIRA_REPLY_MAX_CHARS + 1) }).expect(400)).body).toEqual({ error: 'text too long' });
  });

  it('is 503 while unconfigured', async () => {
    await build({ on: false });
    expect((await draft(ok).expect(503)).body).toEqual({ error: 'Jira is not configured' });
  });

  it('is 409 with no live reply link for the (key, session): none, a run link, an ended reply, another session\'s', async () => {
    await build();
    const want = { error: 'no reply session for SUP-208' };
    expect((await draft(ok).expect(409)).body).toEqual(want);
    const live = app.get(JiraLiveService);
    live.reserve('SUP-208', '/repo');
    live.confirm('SUP-208', 'rep-1', { ...META, action: 'execute' });
    expect((await draft(ok).expect(409)).body).toEqual(want);
    live.reserve('SUP-208', '/repo', 'reply');
    live.confirm('SUP-208', 'rep-2', META, 'reply');
    expect((await draft(ok).expect(409)).body).toEqual(want);
    live.end('SUP-208', 'rep-2', 'stopped');
    expect((await draft({ ...ok, sessionId: 'rep-2' }).expect(409)).body).toEqual(want);
    expect((await mentions()).issues.every((i) => i.draft === null)).toBe(true);
  });

  it('stores the draft from a live reply link, shows it on the payload, and a second draft replaces it; exactly 8 000 characters is accepted', async () => {
    await build();
    replyLink();
    const res = await draft(ok).expect(200);
    const row = res.body.issues.find((i: { key: string }) => i.key === 'SUP-208');
    expect(row.draft).toEqual({ text: ok.text, sessionId: 'rep-1', at: new Date(T0).toISOString() });
    expect((await mentions()).issues.find((i) => i.key === 'SUP-208')?.draft).toEqual(row.draft);
    expect((await mentions()).issues.find((i) => i.key === 'SUP-300')?.draft).toBeNull();
    const long = 'b'.repeat(JIRA_REPLY_MAX_CHARS);
    await draft({ ...ok, text: long }).expect(200);
    expect((await mentions()).issues.find((i) => i.key === 'SUP-208')?.draft?.text).toBe(long);
  });

  it('carries session: null with no reply link, sessionId null while starting, the id once confirmed', async () => {
    await build();
    const sess = async () => (await mentions()).issues.find((i) => i.key === 'SUP-208')?.session;
    expect(await sess()).toBeNull();
    const live = app.get(JiraLiveService);
    live.reserve('SUP-208', '/repo', 'reply');
    expect(await sess()).toMatchObject({ sessionId: null, repo: '/repo' });
    live.confirm('SUP-208', 'rep-1', META, 'reply');
    expect(await sess()).toMatchObject({ sessionId: 'rep-1', repo: '/repo' });
  });

  it('a dismissed ticket carries its draft and session in dismissed[]', async () => {
    await build();
    replyLink();
    await draft(ok).expect(200);
    const res = await dismiss('SUP-208', [c4.id]).expect(200);
    expect(keysOf(res.body.dismissed)).toEqual(['SUP-208']);
    expect(res.body.dismissed[0].draft).toMatchObject({ text: ok.text });
    expect(res.body.dismissed[0].session).toMatchObject({ sessionId: 'rep-1' });
  });

  it('discard drops the draft and answers draft: null; a key with no draft is 200 and writes nothing', async () => {
    await build();
    replyLink();
    await draft(ok).expect(200);
    const res = await discard('SUP-208').expect(200);
    expect(res.body.issues.find((i: { key: string }) => i.key === 'SUP-208').draft).toBeNull();
    const spy = jest.spyOn(atomic, 'writeJsonAtomic');
    await discard('SUP-208').expect(200);
    await discard('SUP-300').expect(200);
    expect(spy).not.toHaveBeenCalled();
    expect((await discard('nope').expect(400)).body).toEqual({ error: 'invalid issue key' });
  });

  it('a failed save is 500 "could not save — nothing changed" and the payload is unchanged', async () => {
    await build();
    replyLink();
    const before = await mentions();
    jest.spyOn(atomic, 'writeJsonAtomic').mockImplementation(() => {
      throw new Error('disk full');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await draft(ok).expect(500)).body).toEqual({ error: 'could not save — nothing changed' });
    expect(await mentions()).toEqual(before);
  });
});

describe('POST /api/jira/mentions/reply (plan Task 5)', () => {
  const reply = (key: unknown, text: unknown) => post('/api/jira/mentions/reply', { key, text });
  const commentPosts = () => fake.calls.filter((c) => c.method === 'POST' && /\/issue\/[^/]+\/comment$/.test(c.url));
  /** Comment-page reads (the thread route's GET, and the post's own read after an unconfirmed attempt), every key. */
  const threadReads = () => fake.calls.filter((c) => c.method === 'GET' && /\/issue\/[^/]+\/comment\?/.test(c.url)).length;
  const NO_OPEN = (key: string) => ({ error: `${key} has no open mention — it was answered or dismissed` });
  const store = () => app.get(JiraMentionsStore);
  /** A draft waiting on `key`, written straight into the store — the draft route's own proof (a live reply link) is Task 4's to test. */
  const seedDraft = (key = 'SUP-208') => store().setDraft(key, { text: 'drafted', sessionId: 'rep-1', at: new Date(T0).toISOString() });
  const status = async () => (await http().get('/api/jira').expect(200)).body as { access: string };
  /** Answer the next comment POST with `status` and Jira's sentence; every other call proceeds. */
  const failPost = (status: number, message: string) =>
    (fake.failNext = (c) => (c.method === 'POST' && /\/comment$/.test(c.url) ? { status, body: { errorMessages: [message], errors: {} } } : null));

  it('refuses another origin with 403 and posts nothing', async () => {
    await build();
    await reply('SUP-208', 'hi').set('origin', 'http://evil.test').expect(403);
    expect(commentPosts()).toEqual([]);
  });

  it('validates key, then text (empty, whitespace, not a string, 8 001); exactly 8 000 characters is posted', async () => {
    await build();
    expect((await reply('sup-208', 'hi').expect(400)).body).toEqual({ error: 'invalid issue key' });
    for (const text of ['', '   \n ', 7, null]) {
      expect((await reply('SUP-208', text).expect(400)).body).toEqual({ error: 'text must be a non-empty string' });
    }
    expect((await reply('SUP-208', 'a'.repeat(JIRA_REPLY_MAX_CHARS + 1)).expect(400)).body).toEqual({ error: 'text too long' });
    expect(commentPosts()).toEqual([]);
    await reply('SUP-208', 'a'.repeat(JIRA_REPLY_MAX_CHARS)).expect(200);
    expect(commentPosts()).toHaveLength(1);
  });

  it('is 503 while unconfigured, after the 400s', async () => {
    await build({ on: false });
    expect((await reply('sup-208', 'hi').expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await reply('SUP-208', 'hi').expect(503)).body).toEqual({ error: 'Jira is not configured' });
    expect(fake.calls).toEqual([]);
  });

  it('is 409 for a key with no open mention — not cached, or every mention dismissed — with no call and the draft kept', async () => {
    await build();
    seedDraft();
    expect((await reply('SUP-999', 'hi').expect(409)).body).toEqual(NO_OPEN('SUP-999'));
    await dismiss('SUP-208', [c4.id]).expect(200);
    expect((await reply('SUP-208', 'hi').expect(409)).body).toEqual(NO_OPEN('SUP-208'));
    expect(commentPosts()).toEqual([]);
    expect(store().draftFor('SUP-208')).toMatchObject({ text: 'drafted' });
  });

  it('inside a 429 window answers the window with its stored retryAt and sends nothing', async () => {
    await build();
    pastFloor();
    fake.rateLimit = { retryAfter: 120 };
    await check().expect(200);
    fake.rateLimit = null;
    const retryAt = new Date(now + 120_000).toISOString();
    expect((await reply('SUP-208', 'hi').expect(503)).body).toEqual({ error: `Jira rate limit — retry after ${retryAt}`, access: 'rate-limited', retryAt });
    expect(commentPosts()).toEqual([]);
  });

  it('under access unauthorized answers the 401 body with no call and NO scope suffix — that 401 is about the token, from before any post', async () => {
    await build();
    pastFloor();
    fake.unauthorized = true;
    await check().expect(200);
    expect((await status()).access).toBe('unauthorized');
    fake.unauthorized = false;
    expect((await reply('SUP-208', 'hi').expect(503)).body).toEqual({ error: 'Jira rejected the credentials', access: 'unauthorized' });
    expect(commentPosts()).toEqual([]);
  });

  it('a 401 on the post moves access through routeFailed and names the scope; the draft is kept', async () => {
    await build();
    seedDraft();
    failPost(401, 'Unauthorized');
    const res = await reply('SUP-208', 'hi').expect(503);
    expect(res.body).toEqual({ error: 'Jira rejected the credentials — the token needs write:comment:jira', access: 'unauthorized' });
    expect(commentPosts()).toHaveLength(1);
    expect((await status()).access).toBe('unauthorized');
    expect(store().draftFor('SUP-208')).toMatchObject({ text: 'drafted' });
    expect(keysOf((await mentions()).issues)).toContain('SUP-208');
  });

  it("a 403 on the post is 502 carrying Jira's sentence and the scope; access unchanged, draft kept", async () => {
    await build();
    seedDraft();
    failPost(403, 'You do not have permission to add comments');
    const res = await reply('SUP-208', 'hi').expect(502);
    expect(res.body).toEqual({
      error: 'Jira refused: You do not have permission to add comments — the token needs write:comment:jira',
      access: 'forbidden'
    });
    expect((await status()).access).toBe('ok');
    expect(store().draftFor('SUP-208')).toMatchObject({ text: 'drafted' });
    expect(keysOf((await mentions()).issues)).toContain('SUP-208');
  });

  it("any other failure is the routes' mapping without the suffix", async () => {
    await build();
    failPost(400, 'Comment body is not valid');
    expect((await reply('SUP-208', 'hi').expect(409)).body).toEqual({ error: 'Jira refused: Comment body is not valid' });
  });

  it('a 201 answers 200 with posted, drops the ticket and its draft, and leaves every other ticket alone', async () => {
    await build();
    seedDraft();
    seedDraft('SUP-300');
    const res = await reply('SUP-208', 'Thanks — fixed.\n\nShips Monday.').expect(200);
    const sent = fake.posted[0];
    expect(fake.posted).toHaveLength(1);
    expect(sent.key).toBe('SUP-208');
    expect(res.body.posted).toEqual({ id: sent.id, url: `https://acme.atlassian.net/browse/SUP-208?focusedCommentId=${sent.id}` });
    expect(res.body).toMatchObject({ configured: true, window: 30 });
    expect(keysOf(res.body.issues)).toEqual(['SUP-300', 'SUP-400']);
    expect(keysOf((await mentions()).issues)).toEqual(['SUP-300', 'SUP-400']);
    expect(store().draftFor('SUP-208')).toBeNull();
    expect(store().draftFor('SUP-300')).toMatchObject({ text: 'drafted' });
    expect(res.body.issues[0].draft).toMatchObject({ text: 'drafted' });
    expect(poller.mentionCandidate('SUP-300', s300.id)).toMatchObject({ commentId: s300.id });
    expect(poller.mentionCandidate('SUP-208', c4.id)).toBeNull();
    // c4 is Mara's: the mention node targets the author of the open mention being answered, from the cache.
    expect(sent.body).toEqual(replyDoc({ accountId: MARA.accountId, name: MARA.displayName }, 'Thanks — fixed.\n\nShips Monday.'));
    expect((await http().get('/api/jira').expect(200)).body.mentions.count).toBe(2);
  });

  it("targets the author of the ticket's NEWEST open mention; a newer dismissed one is not open", async () => {
    let ivoOld!: SeededComment, mara!: SeededComment, ivoNew!: SeededComment;
    await build({
      beforeInit: () => {
        ivoOld = comment(IVO, 50, true, 'old ping');
        mara = comment(MARA, 20, true, 'newer ping');
        ivoNew = comment(IVO, 10, true, 'newest ping');
        mentionIssue('SUP-500', [ivoOld, mara, ivoNew]);
      }
    });
    await dismiss('SUP-500', [ivoNew.id]).expect(200);
    await reply('SUP-500', 'hi').expect(200);
    const body = fake.posted[0].body as ReturnType<typeof replyDoc>;
    expect(body.content[0].content[0]).toEqual({ type: 'mention', attrs: { id: MARA.accountId, text: `@${MARA.displayName}` } });
    expect(mara.id).not.toBe(ivoOld.id);
  });

  it('the thread route marks the answered mention open: false after the post, though the read does not carry the reply', async () => {
    await build();
    expect((await http().get('/api/jira/issue/SUP-208/thread').expect(200)).body.comments.find((c: { id: string }) => c.id === c4.id).open).toBe(true);
    await reply('SUP-208', 'hi').expect(200);
    const after = (await http().get('/api/jira/issue/SUP-208/thread').expect(200)).body.comments as { id: string; open: boolean }[];
    expect(after.map((c) => c.id)).not.toContain(fake.posted[0].id);
    expect(after.find((c) => c.id === c4.id)?.open).toBe(false);
  });

  it('a failed draft drop is logged and never turns the 200 into an error — the comment is posted', async () => {
    await build();
    seedDraft();
    jest.spyOn(atomic, 'writeJsonAtomic').mockImplementation(() => {
      throw new Error('disk full');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await reply('SUP-208', 'hi').expect(200);
    expect(res.body.posted.id).toBe(fake.posted[0].id);
    expect(keysOf(res.body.issues)).not.toContain('SUP-208');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('R4: of two concurrent posts on one key exactly one reaches Jira; the other is 409, and a third after the first is the no-open-mention 409', async () => {
    await build();
    const release = fake.holdNextComment();
    const first = reply('SUP-208', 'one').then((r) => r);
    await until(() => commentPosts().length === 1);
    expect((await reply('SUP-208', 'two').expect(409)).body).toEqual({ error: 'a reply to SUP-208 is already being posted' });
    // The guard is per key: SUP-300's post goes through while SUP-208's is still out.
    await reply('SUP-300', 'other').expect(200);
    release();
    expect((await first).status).toBe(200);
    expect((await reply('SUP-208', 'three').expect(409)).body).toEqual(NO_OPEN('SUP-208'));
    expect(commentPosts().map((c) => c.url.replace(/^.*\/issue\//, ''))).toEqual(['SUP-208/comment', 'SUP-300/comment']);
  });

  it('R4: the key is free again after a 5xx, and the retry reads the thread first — no reply there, so it posts once more', async () => {
    await build();
    seedDraft();
    failPost(500, 'boom');
    expect((await reply('SUP-208', 'one').expect(502)).body).toEqual({ error: replyUnconfirmed('SUP-208') });
    expect(store().draftFor('SUP-208')).toMatchObject({ text: 'drafted' });
    expect(keysOf((await mentions()).issues)).toContain('SUP-208');
    fake.failNext = null;
    const before = threadReads();
    await reply('SUP-208', 'one').expect(200);
    expect(threadReads() - before).toBe(1);
    expect(commentPosts()).toHaveLength(2);
  });

  describe('a POST Jira did not confirm (status 0 or 5xx) is never posted twice', () => {
    /** The next comment POST times out at the transport — the request left, no answer came back. */
    const timeOutPost = () => (fake.failNext = (c) => (c.method === 'POST' && /\/comment$/.test(c.url) ? 'transport' : null));

    it('(a) a timeout, then the reply in the thread: the second click sends no POST and answers posted with that comment', async () => {
      await build();
      seedDraft();
      timeOutPost();
      expect((await reply('SUP-208', 'Thanks').expect(502)).body).toEqual({ error: replyUnconfirmed('SUP-208') });
      expect(commentPosts()).toHaveLength(1);
      fake.failNext = null;
      // Jira did write it: my comment, stamped a second after the attempt by Jira's clock.
      const landed = { ...comment(ME, 0, false, 'Thanks'), created: new Date(now + 1_000).toISOString() };
      fake.addComments('SUP-208', [landed]);
      now += 5_000;
      const res = await reply('SUP-208', 'Thanks').expect(200);
      expect(commentPosts()).toHaveLength(1);
      expect(fake.posted).toEqual([]);
      expect(res.body.posted).toEqual({ id: landed.id, url: `https://acme.atlassian.net/browse/SUP-208?focusedCommentId=${landed.id}` });
      expect(keysOf(res.body.issues)).not.toContain('SUP-208');
      expect(store().draftFor('SUP-208')).toBeNull();
      // The adopted comment answers the mention like a posted one: a third click is the no-open-mention 409.
      expect((await reply('SUP-208', 'Thanks').expect(409)).body).toEqual(NO_OPEN('SUP-208'));
    });

    it('(b) a timeout, then no reply in the thread: the second click POSTs exactly once — an own comment from before the attempt is not it', async () => {
      await build();
      timeOutPost();
      await reply('SUP-208', 'Thanks').expect(502);
      fake.failNext = null;
      // c2 is mine, 90 minutes before the attempt: not the attempt, and older than the mention being answered.
      expect(c2.author?.accountId).toBe(ME.accountId);
      const before = threadReads();
      const res = await reply('SUP-208', 'Thanks').expect(200);
      expect(threadReads() - before).toBe(1);
      expect(commentPosts()).toHaveLength(2);
      expect(fake.posted).toHaveLength(1);
      expect(res.body.posted.id).toBe(fake.posted[0].id);
    });

    it('a failed thread read refuses without posting, keeps the mark, and the next click reads again', async () => {
      await build();
      timeOutPost();
      await reply('SUP-208', 'Thanks').expect(502);
      fake.failNext = (c) => (c.method === 'GET' && /\/comment\?/.test(c.url) ? { status: 503, body: {} } : null);
      await reply('SUP-208', 'Thanks').expect(502);
      expect(commentPosts()).toHaveLength(1);
      fake.failNext = null;
      const before = threadReads();
      await reply('SUP-208', 'Thanks').expect(200);
      expect(threadReads() - before).toBe(1);
      expect(commentPosts()).toHaveLength(2);
    });

    it('(c) a definite 4xx keeps its answer, and the retry posts with no thread read first', async () => {
      await build();
      failPost(400, 'Comment body is not valid');
      expect((await reply('SUP-208', 'hi').expect(409)).body).toEqual({ error: 'Jira refused: Comment body is not valid' });
      fake.failNext = null;
      const before = threadReads();
      await reply('SUP-208', 'hi').expect(200);
      expect(threadReads()).toBe(before);
      expect(commentPosts()).toHaveLength(2);
    });
  });
});
