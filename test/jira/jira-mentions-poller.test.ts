import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JIRA_MENTIONS_ISSUE_CAP, JIRA_MENTIONS_POLL_MS, JIRA_MENTIONS_WINDOW_DAYS, JIRA_THREAD_MAX, type JiraBoard } from '../../shared/types';
import { JiraClient } from '../../server/src/jira/jira.client';
import { MENTION_SEARCH_FIELDS, mentionsJql } from '../../server/src/jira/mentions.util';
import { JIRA_POLL_MS, JiraPollerService, SWEEP_FLOOR_MS } from '../../server/src/jira/poller.service';
import { FakeJira, makeRawIssue, type SeededComment } from '../helpers/jira';

/**
 * Jira › Mentions — the poller's mentions step and its widened arming (plan Task 5; spec "How a check works", "Failure handling", "Poller arming").
 *
 * Driven as `jira-poller.test.ts` drives the board sweep: `await poller.tick()` by hand, `Date.now` mocked and moved, so the 3-minute cadence is arithmetic
 * on `T0` and no real timer fires. FakeJira answers the mentions JQL from `answers` (it is not one of the server's own key/parent shapes), and carries each
 * issue's newest 20 comments inline when the search asks for `comment`, which is what makes the ">20 comments" cases mean something.
 */

const T0 = Date.parse('2026-11-16T12:00:00Z');
const MIN = 60_000;
const ME = 'acc-1';
const MARA = { accountId: 'acc-m', displayName: 'Mara Ilić' };
const IVO = { accountId: 'acc-i', displayName: 'Ivo Ban' };
const JQL = mentionsJql(ME, 30);
const B1 = 'b_0123abcd';
const B2 = 'b_0123abce';

const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE'] as const;

let fake: FakeJira;
let poller: JiraPollerService;
let now: number;
let dir: string;
let file: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.BM_JIRA_SITE = 'acme.atlassian.net';
  process.env.BM_JIRA_EMAIL = 'ada@example.com';
  process.env.BM_JIRA_TOKEN = 't0k3n-SECRET';
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-mentions-poller-'));
  file = join(dir, 'jira.json');
  process.env.BM_JIRA_FILE = file;
  writeConfig([]);
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  fake = new FakeJira();
  poller = new JiraPollerService(new JiraClient(fake.fetch));
});

afterEach(() => {
  poller.disarm();
  poller.onApplicationShutdown();
  jest.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();

function board(over: Partial<JiraBoard> = {}): JiraBoard {
  return { id: B1, name: 'Payments', roots: [], queries: [], interval: '1m', ...over };
}

function writeConfig(boards: JiraBoard[]): void {
  writeFileSync(file, JSON.stringify({ boards }));
}

const searches = () => fake.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => (c.body as { jql: string }).jql);
const mentionSearches = () => searches().filter((j) => j === JQL).length;
const commentReads = () => fake.calls.filter((c) => /\/issue\/[^/]+\/comment\?/.test(c.url)).map((c) => c.url);

/** An ADF body that @-mentions `id`, or plain text when `id` is null. */
function body(id: string | null, text = 'can you look?'): unknown {
  const content: unknown[] = id === null ? [] : [{ type: 'mention', attrs: { id, text: '@Someone' } }];
  content.push({ type: 'text', text: ` ${text}` });
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] };
}

let seq = 0;
/** One comment `minutesAgo` before T0, by `who`, mentioning `mentions` (or nobody). Ids are distinct digit strings across the suite. */
function comment(who: { accountId: string; displayName: string }, minutesAgo: number, mentions: string | null = null): SeededComment {
  seq += 1;
  return { id: String(10_000 + seq), author: { ...who }, created: iso(T0 - minutesAgo * MIN), body: body(mentions) };
}

/** Seed an issue into the fake and the mentions answer, with `comments` oldest first. */
function mentionIssue(key: string, comments: SeededComment[], fields: Record<string, unknown> = {}): void {
  fake.issues.set(key, makeRawIssue({ key, fields }));
  fake.addComments(key, comments);
  fake.answers.set(JQL, [...(fake.answers.get(JQL) ?? []), key]);
}

/** `n` filler comments by Ivo that mention nobody, oldest first, ending `endMinutesAgo` before T0. */
function filler(n: number, endMinutesAgo: number): SeededComment[] {
  return Array.from({ length: n }, (_, i) => comment(IVO, endMinutesAgo + (n - 1 - i)));
}

describe('arming (spec "Poller arming")', () => {
  it('arming with no boards: armed after boot, and one search with the mentions JQL ran', async () => {
    await poller.tick();
    expect(poller.armed).toBe(true);
    expect(searches()).toEqual([JQL]);
    const sent = fake.calls.find((c) => c.url.endsWith('/search/jql'))!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ jql: JQL, fields: MENTION_SEARCH_FIELDS, maxResults: JIRA_MENTIONS_ISSUE_CAP });
    expect(poller.mentionsArmed()).toBe(true);
  });

  it('arming with every board off: still armed, and the next mentions search is 180 000 ms after the last attempt, not before', async () => {
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
    writeConfig([board({ roots: ['PAY-1'], interval: 'off' }), board({ id: B2, name: 'Other', roots: ['PAY-1'], interval: 'off' })]);
    await poller.tick();
    expect(poller.armed).toBe(true);
    expect(mentionSearches()).toBe(1);

    now = T0 + JIRA_MENTIONS_POLL_MS - 1;
    await poller.tick();
    expect(mentionSearches()).toBe(1);
    expect(poller.armed).toBe(true);

    now = T0 + JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect(mentionSearches()).toBe(2);
  });

  it('mentionsArmed is false while unconfigured and once the site is unsupported', async () => {
    fake.deploymentType = 'Server';
    await poller.tick();
    expect(poller.status().access).toBe('unsupported');
    expect(poller.mentionsArmed()).toBe(false);
    expect(poller.armed).toBe(false);
    expect(mentionSearches()).toBe(0);
    // No check will ever stamp the cache, so the status carries no summary: a `polledAt: null` one would hold the shell on its 15 s floor for good.
    expect(poller.status().mentions).toBeNull();

    process.env.BM_JIRA_TOKEN = '';
    const fresh = new JiraPollerService(new JiraClient(fake.fetch));
    expect(fresh.mentionsArmed()).toBe(false);
  });

  it('the site sweep forces a mentions check before its 3 minutes are up, under the floor', async () => {
    writeConfig([board({ interval: 'off' })]);
    await poller.tick();
    expect(mentionSearches()).toBe(1);
    now += SWEEP_FLOOR_MS + 1_000;
    expect(await poller.sweepNow()).toEqual({ kind: 'done' });
    expect(mentionSearches()).toBe(2);
    // A second press inside the floor spends nothing, and the forced flag was spent by the check, so a later tick inside 3 minutes asks nothing either.
    now += 1_000;
    await poller.sweepNow();
    now += MIN;
    await poller.tick();
    expect(mentionSearches()).toBe(2);
  });
});

describe('the check', () => {
  it('mention found end to end: one issue, one candidate, on no board', async () => {
    const hers = comment(MARA, 120, ME);
    mentionIssue('SUP-208', [comment(IVO, 200), hers], { summary: 'Refund stuck', issuetype: { name: 'Bug' } });
    await poller.tick();
    const cache = poller.mentionsCache();
    expect(cache).toMatchObject({ polledAt: iso(T0), detail: null, truncated: false });
    expect(cache.issues).toHaveLength(1);
    expect(cache.issues[0]).toMatchObject({
      key: 'SUP-208',
      summary: 'Refund stuck',
      type: 'Bug',
      status: { name: 'To Do', category: 'new' },
      boards: []
    });
    expect(cache.issues[0].candidates).toHaveLength(1);
    expect(cache.issues[0].candidates[0]).toMatchObject({
      commentId: hers.id,
      author: { accountId: 'acc-m', name: 'Mara Ilić' },
      created: hers.created,
      url: `https://acme.atlassian.net/browse/SUP-208?focusedCommentId=${hers.id}`
    });
    expect(commentReads()).toEqual([]);
  });

  it('board names: boards holds the NAMES of the boards whose cache holds the key, in config order', async () => {
    fake.answers.set('project = PAY', ['PAY-131']);
    mentionIssue('PAY-131', [comment(MARA, 30, ME)]);
    mentionIssue('SUP-208', [comment(MARA, 10, ME)]);
    writeConfig([board({ name: 'Payments Q4', queries: [{ id: 'q_0123abcd', label: 'mine', jql: 'project = PAY' }] })]);
    await poller.tick();
    const byKey = Object.fromEntries(poller.mentionsCache().issues.map((i) => [i.key, i.boards]));
    expect(byKey).toEqual({ 'PAY-131': ['Payments Q4'], 'SUP-208': [] });
  });

  it('orders issues by their newest candidate, newest first, and drops an issue with none', async () => {
    mentionIssue('PAY-1', [comment(MARA, 300, ME)]);
    // Seeded oldest first like every thread here: PAY-2's older mention (400 min) first, then its newer one (100 min) — the one that ranks it.
    mentionIssue('PAY-2', [comment(IVO, 400, ME), comment(MARA, 100, ME)]);
    mentionIssue('PAY-3', [comment(MARA, 50, ME), { ...comment(MARA, 40), author: { accountId: ME, displayName: 'Ada' } }]);
    await poller.tick();
    expect(poller.mentionsCache().issues.map((i) => i.key)).toEqual(['PAY-2', 'PAY-1']);
  });

  it('>20 comments fetch: the newest 100 are read and judged, so an older reply answers and an older mention is found', async () => {
    // Each thread is 23 comments: #1 filler, #2 Mara's mention, #3 (SUP-208 only) my reply, then fillers. The inline 20 are #4..#23.
    const supMention = comment(MARA, 1_000, ME);
    const myReply = { ...comment(IVO, 990), author: { accountId: ME, displayName: 'Ada' } };
    mentionIssue('SUP-208', [comment(IVO, 1_010), supMention, myReply, ...filler(20, 100)]);
    const payMention = comment(MARA, 1_000, ME);
    mentionIssue('PAY-131', [comment(IVO, 1_010), payMention, comment(IVO, 990), ...filler(20, 100)]);
    await poller.tick();
    const issues = poller.mentionsCache().issues;
    expect(issues.map((i) => i.key)).toEqual(['PAY-131']);
    expect(issues[0].candidates.map((c) => c.commentId)).toEqual([payMention.id]);
    expect(commentReads()).toHaveLength(2);
    for (const url of commentReads()) expect(url).toContain(`orderBy=-created&maxResults=${JIRA_THREAD_MAX}`);
  });

  it.each([403, 404])('comment read %i drops the issue, and the rest of the check stands with no detail', async (status) => {
    mentionIssue('PAY-131', [...filler(20, 100), comment(MARA, 10, ME)]);
    mentionIssue('SUP-208', [comment(MARA, 20, ME)]);
    fake.failNext = ({ url }) => (url.includes('/issue/PAY-131/comment') ? { status, body: { errorMessages: ['Issue does not exist'] } } : null);
    await poller.tick();
    const cache = poller.mentionsCache();
    expect(cache.issues.map((i) => i.key)).toEqual(['SUP-208']);
    expect(cache.detail).toBeNull();
    expect(cache.polledAt).toBe(iso(T0));
  });

  it('a comment read 500 fails the whole check: nothing swapped, detail set', async () => {
    mentionIssue('PAY-131', [...filler(20, 100), comment(MARA, 10, ME)]);
    mentionIssue('SUP-208', [comment(MARA, 20, ME)]);
    fake.failNext = ({ url }) => (url.includes('/issue/PAY-131/comment') ? { status: 500 } : null);
    await poller.tick();
    expect(poller.mentionsCache()).toMatchObject({ polledAt: null, issues: [], detail: 'Jira answered 500' });
    expect(poller.status().access).toBe('ok');
  });

  it('truncated: the search answering isLast: false sets truncated', async () => {
    mentionIssue('SUP-208', [comment(MARA, 20, ME)]);
    fake.omitNextPageToken = true;
    await poller.tick();
    expect(poller.mentionsCache().truncated).toBe(true);
    expect(mentionSearches()).toBe(1);
  });
});

describe('failures', () => {
  const failMentions = (status: number, headers?: Record<string, string>) => {
    fake.failNext = ({ body: b }) => ((b as { jql?: string } | undefined)?.jql === JQL ? { status, headers } : null);
  };

  it('5xx keeps rows: issues and polledAt unchanged, detail set, site access still ok', async () => {
    mentionIssue('SUP-208', [comment(MARA, 20, ME)]);
    await poller.tick();
    // A deep clone, not the accessor's live object: an in-place clear (`issues = []` on the same cache) must fail this, not compare equal to itself.
    const good = structuredClone(poller.mentionsCache());
    expect(good.issues.map((i) => i.key)).toEqual(['SUP-208']);

    now = T0 + JIRA_MENTIONS_POLL_MS;
    failMentions(503);
    await poller.tick();
    const after = poller.mentionsCache();
    expect(after.issues.map((i) => i.key)).toEqual(['SUP-208']);
    expect(after.issues).toEqual(good.issues);
    expect(after.polledAt).toBe(iso(T0));
    expect(after.detail).toBe('Jira answered 503');
    expect(poller.status().access).toBe('ok');

    // The next good check clears the detail and moves polledAt.
    fake.failNext = null;
    now = T0 + 2 * JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect(poller.mentionsCache()).toMatchObject({ detail: null, polledAt: iso(now) });
  });

  it('the cadence runs from the failed ATTEMPT: no search one poll after the 503, one exactly 180 000 ms after it', async () => {
    mentionIssue('SUP-208', [comment(MARA, 20, ME)]);
    await poller.tick();
    const attempt = T0 + JIRA_MENTIONS_POLL_MS;
    now = attempt;
    failMentions(503);
    await poller.tick();
    expect(poller.mentionsCache().detail).toBe('Jira answered 503');
    fake.failNext = null;
    expect(mentionSearches()).toBe(2);

    // A build that stamped the cadence only on success would be due again here (its last stamp is T0, 180 s ago) and send a third search.
    now = attempt + JIRA_POLL_MS;
    await poller.tick();
    expect(mentionSearches()).toBe(2);

    now = attempt + JIRA_MENTIONS_POLL_MS - 1;
    await poller.tick();
    expect(mentionSearches()).toBe(2);

    now = attempt + JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect(mentionSearches()).toBe(3);
    expect(poller.mentionsCache().detail).toBeNull();
  });

  it.each([
    ['a 400', 400],
    ['a 403 on the search', 403],
    ['a 404 on the search', 404]
  ])('%s is the mentions detail, never an empty list or a site verdict', async (_, status) => {
    failMentions(status);
    await poller.tick();
    expect(poller.mentionsCache()).toMatchObject({ polledAt: null, issues: [], detail: expect.any(String) });
    expect(poller.status().access).toBe('ok');
  });

  it('a transport failure is the mentions detail, with the error text', async () => {
    fake.failNext = ({ body: b }) => ((b as { jql?: string } | undefined)?.jql === JQL ? 'transport' : null);
    await poller.tick();
    expect(poller.mentionsCache().detail).toBe('fetch failed');
    expect(poller.status().access).toBe('ok');
  });

  it('401 moves access to unauthorized and resets the boot', async () => {
    failMentions(401);
    await poller.tick();
    const s = poller.status();
    expect(s.access).toBe('unauthorized');
    expect(s.me).toBeNull();
    expect(poller.armed).toBe(true);
  });

  it('429 window respected: no mentions call until the window ends', async () => {
    failMentions(429, { 'retry-after': '300' });
    await poller.tick();
    expect(poller.status().access).toBe('rate-limited');
    fake.failNext = null;
    fake.calls.length = 0;

    now = T0 + JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect(fake.calls).toEqual([]);

    now = T0 + 300_000;
    await poller.tick();
    expect(mentionSearches()).toBe(1);
    expect(poller.status().access).toBe('ok');
  });

  it('board 5xx does not starve mentions: the mentions search still runs on that tick', async () => {
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
    writeConfig([board({ roots: ['PAY-1'] })]);
    fake.answers.set(JQL, []);
    fake.failNext = ({ body: b }) => ((b as { jql?: string } | undefined)?.jql === 'key = "PAY-1"' ? { status: 503 } : null);
    await poller.tick();
    expect(poller.status().access).toBe('unreachable');
    expect(mentionSearches()).toBe(1);
    expect(poller.mentionsCache().polledAt).toBe(iso(T0));
  });

  it('a board 429 mid-tick skips the step without stamping the attempt, so the check runs on the first tick after the window', async () => {
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
    writeConfig([board({ roots: ['PAY-1'] })]);
    fake.answers.set(JQL, []);
    fake.failNext = ({ body: b }) =>
      (b as { jql?: string } | undefined)?.jql === 'key = "PAY-1"' ? { status: 429, headers: { 'retry-after': '60' } } : null;
    await poller.tick();
    expect(poller.status().access).toBe('rate-limited');
    expect(mentionSearches()).toBe(0);
    fake.failNext = null;

    // 60 s on, well inside the 3-minute cadence: never attempted, so due at once.
    now = T0 + MIN;
    await poller.tick();
    expect(mentionSearches()).toBe(1);
  });

  it('a site sweep that joins an in-flight tick forces nothing: one mentions search, and none on the next tick', async () => {
    writeConfig([board({ interval: 'off' })]);
    await poller.tick();
    expect(mentionSearches()).toBe(1);

    now = T0 + JIRA_MENTIONS_POLL_MS;
    const tick = poller.tick();
    expect(await poller.sweepNow()).toEqual({ kind: 'done' });
    await tick;
    expect(mentionSearches()).toBe(2);

    now += JIRA_POLL_MS;
    await poller.tick();
    expect(mentionSearches()).toBe(2);
  });

  it('a board 401 ends the tick before mentions: the boot is not answered', async () => {
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
    writeConfig([board({ roots: ['PAY-1'] })]);
    fake.failNext = ({ body: b }) => ((b as { jql?: string } | undefined)?.jql === 'key = "PAY-1"' ? { status: 401 } : null);
    await poller.tick();
    expect(poller.status().access).toBe('unauthorized');
    expect(mentionSearches()).toBe(0);
  });
});

describe('calls', () => {
  it('calls counted: a tick with one board page and a mentions search with one comment read is calls.sweep 3', async () => {
    fake.answers.set('project = PAY', ['PAY-1']);
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
    mentionIssue('SUP-208', [...filler(20, 100), comment(MARA, 10, ME)]);
    writeConfig([board({ queries: [{ id: 'q_0123abcd', label: 'mine', jql: 'project = PAY' }] })]);
    await poller.tick();
    now = T0 + JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect(poller.status().calls.sweep).toBe(3);
  });
});

/**
 * R7 (plan Task 5): a posted reply hides the mentions it answered at once, though the search index that feeds the next check has not caught up with it.
 * The fake never appends a POSTed comment to its threads (`FakeJira.posted`), so every check here returns the ticket WITHOUT the reply — the lag — and the
 * poller's `answeredAt`, applied on read, is the only thing that can keep the ticket out.
 */
describe('a posted reply (R7: answeredAt, applied on read)', () => {
  const keys = () => {
    const p = poller.mentionsPayload();
    return p.configured ? p.issues.map((i) => i.key) : null;
  };
  const answeredAt = () => (poller as unknown as { answeredAt: Map<string, string> }).answeredAt;

  it('keeps the ticket out while the index lags, and a NEW mention after the reply brings it back', async () => {
    mentionIssue('SUP-208', [comment(MARA, 120, ME)]);
    mentionIssue('SUP-300', [comment(IVO, 60, ME)]);
    await poller.tick();
    expect(keys()).toEqual(['SUP-300', 'SUP-208']);

    const posted = await poller.postReply('SUP-208', 'done');
    expect(posted).toMatchObject({ ok: true, value: { id: fake.posted[0].id, created: iso(T0) } });
    expect(keys()).toEqual(['SUP-300']);
    expect(poller.status().mentions?.count).toBe(1);

    now = T0 + JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    // The check swapped the ticket back into the cache whole — nothing is filtered in the swap — and the read hides it.
    expect(poller.mentionsCache().issues.map((i) => i.key)).toContain('SUP-208');
    expect(keys()).toEqual(['SUP-300']);
    expect(poller.status().mentions?.count).toBe(1);

    const fresh = comment(MARA, -1, ME);
    fake.addComments('SUP-208', [fresh]);
    now = T0 + 2 * JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect(keys()).toEqual(['SUP-208', 'SUP-300']);
    expect(poller.mentionCandidate('SUP-208', fresh.id)).toMatchObject({ commentId: fresh.id });
  });

  it('a check started before the post and resolving after it swaps in without the ticket', async () => {
    mentionIssue('SUP-208', [comment(MARA, 120, ME)]);
    await poller.tick();
    now = T0 + JIRA_MENTIONS_POLL_MS;
    const release = fake.holdNextSearch();
    const tick = poller.tick();
    for (let i = 0; i < 500 && mentionSearches() < 2; i++) await new Promise((r) => setImmediate(r));
    expect(mentionSearches()).toBe(2);
    expect((await poller.postReply('SUP-208', 'done')).ok).toBe(true);
    release();
    await tick;
    expect(keys()).toEqual([]);
  });

  it('leaves another key alone: its row and its candidate are unchanged', async () => {
    const theirs = comment(IVO, 60, ME);
    mentionIssue('SUP-208', [comment(MARA, 120, ME)]);
    mentionIssue('SUP-300', [theirs]);
    await poller.tick();
    const before = poller.mentionCandidate('SUP-300', theirs.id);
    await poller.postReply('SUP-208', 'done');
    expect(keys()).toEqual(['SUP-300']);
    expect(poller.mentionCandidate('SUP-300', theirs.id)).toEqual(before);
  });

  it('refuses a key with no open mention, and a second post while the first is out, before any call', async () => {
    mentionIssue('SUP-208', [comment(MARA, 120, ME)]);
    await poller.tick();
    const calls = fake.calls.length;
    expect(await poller.postReply('SUP-999', 'x')).toEqual({ ok: false, refusal: 'no open mention' });
    const release = fake.holdNextComment();
    const first = poller.postReply('SUP-208', 'one');
    expect(await poller.postReply('SUP-208', 'two')).toEqual({ ok: false, refusal: 'posting' });
    release();
    expect((await first).ok).toBe(true);
    expect(await poller.postReply('SUP-208', 'three')).toEqual({ ok: false, refusal: 'no open mention' });
    expect(fake.calls.length).toBe(calls + 1);
  });

  it('drops an answeredAt entry older than the window at the next check', async () => {
    mentionIssue('SUP-208', [comment(MARA, 120, ME)]);
    await poller.tick();
    await poller.postReply('SUP-208', 'done');
    now = T0 + JIRA_MENTIONS_POLL_MS;
    await poller.tick();
    expect([...answeredAt().keys()]).toEqual(['SUP-208']);
    now = T0 + JIRA_MENTIONS_WINDOW_DAYS * 24 * 60 * MIN + MIN;
    await poller.tick();
    expect(answeredAt().size).toBe(0);
  });
});
