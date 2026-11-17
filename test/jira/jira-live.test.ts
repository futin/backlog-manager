import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { JIRA_LIVE_CAP, JIRA_LIVE_TTL_MS, JiraLiveService } from '../../server/src/jira/live.service';
import { jiraLinksFile } from '../../server/src/jira/links.store';
import { jiraSessionName } from '../../shared/types';
import type { JiraLink } from '../../shared/types';

/**
 * Jira phase 5, Task 3 — the in-memory live map (spec §3 "live map", §4 `live`/`session`). The service reads `Date.now()` (like the poller), so every case
 * drives time with jest's fake clock and `setSystemTime`: nothing sleeps, and expiry and eviction order are exact to the millisecond.
 */

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const REPO = '/work/repo';
const DAY = 24 * 3600_000;

/** What `confirm` is given beyond the ids; the dispatch builds the real one. */
const META = {
  action: 'execute',
  name: 'jira PAY-1',
  branch: null,
  surface: 'dashboard',
  model: null,
  effort: null,
  snapshot: { summary: 'A ticket', type: 'Task', parentKey: null }
} as const;

let live: JiraLiveService;
let dir: string;
let file: string;

// The link store is a file now: every case gets a directory of its own, so no case loads another's links and none touches the developer's real file.
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-links-test-'));
  process.env.BM_JIRA_LINKS_FILE = join(dir, 'jira-links.json');
  file = jiraLinksFile();
  live = new JiraLiveService();
});

afterEach(() => jest.useRealTimers());

/** A `branch`/`manual` link as `addLink` takes it, started at `startedAt` (ms). */
function link(key: string, sessionId: string, over: Partial<Omit<JiraLink, 'endedAt' | 'endReason' | 'quietSince' | 'reattachedAt'>> = {}, startedAt = Date.now()) {
  return {
    key,
    sessionId,
    how: 'branch' as const,
    action: null,
    name: `session ${sessionId}`,
    repo: REPO,
    branch: `${key}-work`,
    surface: null,
    model: null,
    effort: null,
    snapshot: { summary: 'A ticket', type: 'Task', parentKey: null },
    startedAt: new Date(startedAt).toISOString(),
    ...over
  };
}

describe('jiraSessionName', () => {
  it('is `jira <KEY>`', () => {
    expect(jiraSessionName('PAY-1')).toBe('jira PAY-1');
  });

  it('is cut to 60 characters', () => {
    const name = jiraSessionName(`${'A'.repeat(70)}-1`);
    expect(name).toHaveLength(60);
    expect(name.startsWith('jira AAAA')).toBe(true);
  });
});

describe('reserve / confirm / release / end', () => {
  it('a reserve reads as a starting entry with no session id', () => {
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    expect(live.snapshot()).toEqual({ 'PAY-1': { name: 'jira PAY-1', sessionId: null, startedAt: new Date(T0).toISOString(), repo: REPO, starting: true } });
    expect(live.get('PAY-1')).toEqual({ sessionId: null, repo: REPO, startedAt: new Date(T0).toISOString() });
  });

  it('a second reserve of the same key is refused, and leaves the first entry as it was', () => {
    live.reserve('PAY-1', REPO);
    jest.setSystemTime(T0 + 1000);
    expect(live.reserve('PAY-1', '/other')).toBe(false);
    expect(live.get('PAY-1')).toEqual({ sessionId: null, repo: REPO, startedAt: new Date(T0).toISOString() });
  });

  it('confirm records the session id and ends `starting`', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 'sess-1', META);
    expect(live.snapshot()['PAY-1'].starting).toBe(false);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('confirm of a key that is not held does not create it', () => {
    live.confirm('PAY-1', 'sess-1', META);
    expect(live.get('PAY-1')).toBeNull();
    expect(live.snapshot()).toEqual({});
  });

  it('release drops a starting entry, so the key can be reserved again', () => {
    live.reserve('PAY-1', REPO);
    live.release('PAY-1');
    expect(live.get('PAY-1')).toBeNull();
    expect(live.reserve('PAY-1', REPO)).toBe(true);
  });

  it('release after confirm is a no-op', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 'sess-1', META);
    live.release('PAY-1');
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('release drops a starting entry and end a confirmed one, each leaving the key free', () => {
    live.reserve('PAY-1', REPO);
    live.reserve('PAY-2', REPO);
    live.confirm('PAY-2', 'sess-2', META);
    live.release('PAY-1');
    expect(live.end('PAY-2', 'sess-2', 'stopped')).toBe(true);
    expect(live.snapshot()).toEqual({});
    expect(live.reserve('PAY-1', REPO)).toBe(true);
  });
});

describe('the reply reservation kind', () => {
  const REPLY_META = { ...META, action: 'reply' } as const;

  it('a reply is not blocked by a live run, and a second reply is refused while starting and while live', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 'run-1', META);
    expect(live.reserve('PAY-1', REPO, 'reply')).toBe(true);
    expect(live.reserve('PAY-1', REPO, 'reply')).toBe(false);
    live.confirm('PAY-1', 'rep-1', REPLY_META, 'reply');
    expect(live.reserve('PAY-1', REPO, 'reply')).toBe(false);
  });

  it('a run reserves while a reply is starting or live: the kinds coexist', () => {
    expect(live.reserve('PAY-1', REPO, 'reply')).toBe(true);
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    live.confirm('PAY-1', 'rep-1', REPLY_META, 'reply');
    expect(live.reserve('PAY-2', REPO)).toBe(true);
    expect(live.reserve('PAY-1', REPO)).toBe(false); // its own run reservation is still pending
  });

  it('get and snapshot never show a reply, starting or live', () => {
    live.reserve('PAY-1', REPO, 'reply');
    expect(live.get('PAY-1')).toBeNull();
    expect(live.snapshot()).toEqual({});
    live.confirm('PAY-1', 'rep-1', REPLY_META, 'reply');
    expect(live.get('PAY-1')).toBeNull();
    expect(live.snapshot()).toEqual({});
    expect(live.confirmed()).toEqual([]);
    expect(live.hasConfirmed()).toBe(false);
  });

  it('confirm writes a how: reply, action: reply link', () => {
    live.reserve('PAY-1', REPO, 'reply');
    live.confirm('PAY-1', 'rep-1', REPLY_META, 'reply');
    expect(live.liveLinks()).toEqual([expect.objectContaining({ key: 'PAY-1', sessionId: 'rep-1', how: 'reply', action: 'reply', repo: REPO })]);
  });

  it('release of a reply drops only the reply reservation; a run reservation survives, and the reverse', () => {
    live.reserve('PAY-1', REPO);
    live.reserve('PAY-1', REPO, 'reply');
    live.release('PAY-1', 'reply');
    expect(live.get('PAY-1')?.sessionId).toBeNull();
    expect(live.reserve('PAY-1', REPO, 'reply')).toBe(true);
    live.release('PAY-1');
    expect(live.get('PAY-1')).toBeNull();
    expect(live.replySession('PAY-1')).toEqual({ sessionId: null, startedAt: new Date(T0).toISOString(), repo: REPO });
  });

  it('replySession: starting, then the link id, then null once the link ends; other keys see null', () => {
    expect(live.replySession('PAY-1')).toBeNull();
    live.reserve('PAY-1', REPO, 'reply');
    expect(live.replySession('PAY-1')).toEqual({ sessionId: null, startedAt: new Date(T0).toISOString(), repo: REPO });
    expect(live.replySession('PAY-2')).toBeNull();
    expect(live.reserve('PAY-2', REPO, 'reply')).toBe(true);
    live.confirm('PAY-1', 'rep-1', REPLY_META, 'reply');
    expect(live.replySession('PAY-1')).toEqual({ sessionId: 'rep-1', startedAt: new Date(T0).toISOString(), repo: REPO });
    live.end('PAY-1', 'rep-1', 'stopped');
    expect(live.replySession('PAY-1')).toBeNull();
  });

  it('replySession answers the newest live reply link', () => {
    live.reserve('PAY-1', REPO, 'reply');
    live.confirm('PAY-1', 'old', REPLY_META, 'reply');
    live.end('PAY-1', 'old', 'idle');
    jest.setSystemTime(T0 + 1000);
    live.reserve('PAY-1', REPO, 'reply');
    live.confirm('PAY-1', 'new', REPLY_META, 'reply');
    expect(live.replySession('PAY-1')?.sessionId).toBe('new');
  });

  it('JIRA_LIVE_CAP counts reply reservations and reply links', () => {
    for (let i = 0; i < JIRA_LIVE_CAP; i++) live.reserve(`PAY-${i}`, REPO, 'reply');
    expect(live.reserve('PAY-X', REPO, 'reply')).toBe(false); // all starting: nothing to evict
    expect(live.reserve('PAY-X', REPO)).toBe(false);
  });

  it('a confirmed reply is evicted oldest-first at the cap, never a starting one', () => {
    live.reserve('PAY-0', REPO, 'reply');
    live.confirm('PAY-0', 'rep-0', REPLY_META, 'reply');
    for (let i = 1; i < JIRA_LIVE_CAP; i++) live.reserve(`PAY-${i}`, REPO, 'reply');
    jest.setSystemTime(T0 + 1000);
    expect(live.reserve('PAY-NEW', REPO, 'reply')).toBe(true);
    expect(live.replySession('PAY-0')).toBeNull();
    expect(live.replySession('PAY-1')).not.toBeNull();
  });

  it('a stale reply reservation is dropped at the top of the next call', () => {
    live.reserve('PAY-1', REPO, 'reply');
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS + 1);
    expect(live.replySession('PAY-1')).toBeNull();
    expect(live.reserve('PAY-1', REPO, 'reply')).toBe(true);
  });

  it('a how: reply link survives save + load', () => {
    live.reserve('PAY-1', REPO, 'reply');
    live.confirm('PAY-1', 'rep-1', REPLY_META, 'reply');
    expect(new JiraLiveService().liveLinks()).toEqual([expect.objectContaining({ key: 'PAY-1', how: 'reply', action: 'reply' })]);
  });

  it('unlink refuses a reply link and suppresses nothing', () => {
    live.reserve('PAY-1', REPO, 'reply');
    live.confirm('PAY-1', 'rep-1', REPLY_META, 'reply');
    expect(live.unlink('PAY-1', 'rep-1')).toBe('reply');
    expect(live.liveLinks()).toHaveLength(1);
    expect(live.isSuppressed('PAY-1', 'rep-1')).toBe(false);
  });
});

describe('confirmed / hasConfirmed', () => {
  it('a starting entry alone is neither listed nor counted', () => {
    live.reserve('PAY-1', REPO);
    expect(live.hasConfirmed()).toBe(false);
    expect(live.confirmed()).toEqual([]);
  });

  it('lists only the entries that hold a session id', () => {
    live.reserve('PAY-1', REPO);
    live.reserve('PAY-2', REPO);
    live.confirm('PAY-2', 'sess-2', META);
    expect(live.hasConfirmed()).toBe(true);
    expect(live.confirmed()).toEqual([{ key: 'PAY-2', sessionId: 'sess-2', startedAt: new Date(T0).toISOString() }]);
  });
});

describe('expiry', () => {
  it('an entry exactly 8 h old is still live; 1 ms later it is absent everywhere and the key can be reserved again', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 'sess-1', META);
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS);
    expect(live.get('PAY-1')).not.toBeNull();
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS + 1);
    expect(live.get('PAY-1')).toBeNull();
    expect(live.snapshot()).toEqual({});
    expect(live.confirmed()).toEqual([]);
    expect(live.hasConfirmed()).toBe(false);
    expect(live.reserve('PAY-1', REPO)).toBe(true);
  });

  it('a confirm that arrives after the expiry does not bring the entry back', () => {
    live.reserve('PAY-1', REPO);
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS + 1);
    live.confirm('PAY-1', 'sess-1', META);
    expect(live.get('PAY-1')).toBeNull();
  });
});

describe('the cap', () => {
  const fill = (n: number, from = 0): void => {
    for (let i = from; i < from + n; i++) {
      jest.setSystemTime(T0 + i * 1000);
      live.reserve(`PAY-${i}`, REPO);
      live.confirm(`PAY-${i}`, `sess-${i}`, META);
    }
  };

  it('the 101st confirmed entry evicts the oldest by startedAt, and only that one', () => {
    fill(JIRA_LIVE_CAP + 1);
    const keys = Object.keys(live.snapshot());
    expect(keys).toHaveLength(JIRA_LIVE_CAP);
    expect(keys).not.toContain('PAY-0');
    expect(keys).toContain('PAY-1');
    expect(keys).toContain(`PAY-${JIRA_LIVE_CAP}`);
  });

  it('a starting entry is never the one evicted, even when it is the oldest', () => {
    jest.setSystemTime(T0);
    live.reserve('PAY-OLD-1', REPO); // starting, oldest of all
    fill(JIRA_LIVE_CAP - 1, 1); // 99 confirmed, map now at 100
    jest.setSystemTime(T0 + 500_000);
    expect(live.reserve('PAY-NEW-1', REPO)).toBe(true);
    const snap = live.snapshot();
    expect(snap['PAY-OLD-1']?.starting).toBe(true);
    expect(snap).not.toHaveProperty('PAY-1'); // the oldest CONFIRMED one went
    expect(Object.keys(snap)).toHaveLength(JIRA_LIVE_CAP);
  });

  it('with every entry starting, reserve at the cap is refused and nothing is evicted', () => {
    for (let i = 0; i < JIRA_LIVE_CAP; i++) live.reserve(`PAY-${i}`, REPO);
    expect(live.reserve('PAY-X-1', REPO)).toBe(false);
    expect(Object.keys(live.snapshot())).toHaveLength(JIRA_LIVE_CAP);
    expect(live.get('PAY-X-1')).toBeNull();
  });

  it('an expired entry frees its slot without any eviction', () => {
    fill(JIRA_LIVE_CAP);
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS + 1); // PAY-0 (at T0) is expired; PAY-1 (at T0 + 1 s) is not
    expect(live.reserve('NEW-1', REPO)).toBe(true);
    const snap = live.snapshot();
    expect(snap).not.toHaveProperty('PAY-0');
    expect(snap).toHaveProperty('PAY-1'); // nothing else was evicted
    expect(snap).toHaveProperty('NEW-1');
    expect(Object.keys(snap)).toHaveLength(JIRA_LIVE_CAP);
  });
});

describe('the persisted link store', () => {
  it('persists a confirmed run and reloads it', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    const again = new JiraLiveService();
    expect(again.liveLinks()).toHaveLength(1);
    expect(again.liveLinks()[0]).toMatchObject({ key: 'PAY-1', sessionId: 's1', how: 'run', repo: REPO, action: 'execute', startedAt: new Date(T0).toISOString() });
    expect(again.get('PAY-1')?.sessionId).toBe('s1');
  });

  it('never persists a starting entry', () => {
    live.reserve('PAY-2', REPO);
    expect(existsSync(file)).toBe(false);
    const again = new JiraLiveService();
    expect(again.get('PAY-2')).toBeNull();
    expect(again.reserve('PAY-2', REPO)).toBe(true);
  });

  it('reserve ignores branch and manual links, and refuses while a live run holds the key', () => {
    expect(live.addLink(link('PAY-3', 'b1'))).toBe('added');
    expect(live.addLink(link('PAY-3', 'm1', { how: 'manual' }))).toBe('added');
    expect(live.reserve('PAY-3', REPO)).toBe(true);
    live.confirm('PAY-3', 'r1', META);
    expect(live.reserve('PAY-3', REPO)).toBe(false);
  });

  it('end keeps the entry as history', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    expect(live.end('PAY-1', 's1', 'idle')).toBe(true);
    expect(live.links()).toHaveLength(1);
    expect(live.links()[0]).toMatchObject({ endReason: 'idle', endedAt: new Date(T0).toISOString() });
    expect(live.liveLinks()).toEqual([]);
    expect(live.end('PAY-1', 's1', 'stopped')).toBe(false); // not live any more: the first end stands
    expect(live.links()[0].endReason).toBe('idle');
    expect(live.reserve('PAY-1', REPO)).toBe(true); // the ticket is free for the next Run
  });

  it('reattach reuses the entry', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    live.markQuiet('PAY-1', 's1', new Date(T0).toISOString());
    live.end('PAY-1', 's1', 'idle');
    expect(live.reattach('PAY-1', 's1')).toBe(true);
    expect(live.links()).toHaveLength(1);
    expect(live.links()[0]).toMatchObject({ endedAt: null, endReason: null, quietSince: null });
    expect(live.liveLinks()).toHaveLength(1);
    expect(live.reattach('PAY-1', 'nope')).toBe(false);
    expect(live.reserve('PAY-1', REPO)).toBe(false); // a re-attached run counts for the one-run gate again
  });

  /* The 8-hour backstop counts from the later of `startedAt` and the last re-attach: a session resumed after 9 hours is a new stretch of activity, and expiring
     it on the very next sweep would end the pair the reconciler just re-attached. */
  it('a re-attached entry older than 8 h is not expired by the next sweep; its TTL counts from the re-attach', () => {
    jest.setSystemTime(T0 - 9 * 3600_000);
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    jest.setSystemTime(T0 - 9 * 3600_000 + 60_000);
    expect(live.end('PAY-1', 's1', 'idle')).toBe(true);
    jest.setSystemTime(T0);
    expect(live.reattach('PAY-1', 's1')).toBe(true);
    expect(live.links()[0].reattachedAt).toBe(new Date(T0).toISOString());
    expect(live.liveLinks()).toHaveLength(1); // a sweep ran inside that call: nothing expired
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS);
    expect(live.liveLinks()).toHaveLength(1); // exactly 8 h after the re-attach is still live
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS + 1);
    expect(live.liveLinks()).toEqual([]);
    expect(live.links()[0]).toMatchObject({ endReason: 'expired' });
  });

  it('an entry never re-attached still expires from its startedAt, and reattachedAt is null', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    expect(live.links()[0].reattachedAt).toBeNull();
  });

  it('reattachedAt survives a reload', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    live.end('PAY-1', 's1', 'idle');
    live.reattach('PAY-1', 's1');
    expect(new JiraLiveService().links()[0].reattachedAt).toBe(new Date(T0).toISOString());
  });

  /* A session the user started with a branch carrying the key can be Run-linked afterwards (Run ▾ on a ticket whose live link is a detected one). The pair is
     one entry — a second would double the history line — and it must count for the one-run gate, which only `run` entries do. */
  it('confirm on a pair that already holds a live branch link upgrades that entry to a run, and the gate holds', () => {
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    expect(live.addLink(link('PAY-1', 's1'))).toBe('added');
    live.confirm('PAY-1', 's1', META);
    const links = live.links();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ key: 'PAY-1', sessionId: 's1', how: 'run', action: 'execute', name: 'jira PAY-1', endedAt: null });
    expect(live.get('PAY-1')?.sessionId).toBe('s1');
    expect(live.snapshot()['PAY-1']).toMatchObject({ sessionId: 's1', starting: false });
    expect(live.reserve('PAY-1', REPO)).toBe(false);
    expect(new JiraLiveService().links()[0].how).toBe('run'); // the upgrade is persisted
  });

  it('a late confirm for a pair that has ended does not revive it', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    live.end('PAY-1', 's1', 'stopped');
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    expect(live.liveLinks()).toEqual([]);
    expect(live.links()).toHaveLength(1);
  });

  it('retention keeps 20 ended per key', () => {
    live.addLink(link('PAY-1', 'keep-live'));
    for (let i = 0; i < 22; i++) {
      live.addLink(link('PAY-1', `s${i}`));
      live.end('PAY-1', `s${i}`, 'idle', T0 - (22 - i) * 1000); // s0 is the oldest end
    }
    const ids = live.links().map((l) => l.sessionId);
    expect(ids).toHaveLength(21);
    expect(ids).toContain('keep-live');
    expect(ids).not.toContain('s0');
    expect(ids).not.toContain('s1');
    expect(ids).toContain('s2');
    expect(new JiraLiveService().links()).toHaveLength(21); // the file agrees
  });

  it('drops a key idle for 90 days, and keeps one at 89', () => {
    live.addLink(link('OLD-1', 's1'));
    live.addLink(link('NEW-1', 's2'));
    live.end('OLD-1', 's1', 'idle', T0 - 91 * DAY);
    live.end('NEW-1', 's2', 'idle', T0 - 89 * DAY);
    expect(live.links().map((l) => l.key)).toEqual(['NEW-1']);
  });

  it('a key with a live entry is not dropped however old its ended ones are', () => {
    live.addLink(link('PAY-1', 'old'));
    live.addLink(link('PAY-1', 'now'));
    live.end('PAY-1', 'old', 'idle', T0 - 200 * DAY);
    expect(live.links().map((l) => l.sessionId)).toEqual(['old', 'now']);
  });

  it('TTL ends with expired, strictly after 8 h', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS);
    expect(live.liveLinks()).toHaveLength(1);
    jest.setSystemTime(T0 + JIRA_LIVE_TTL_MS + 1);
    expect(live.liveLinks()).toEqual([]);
    expect(live.links()[0]).toMatchObject({ endReason: 'expired', endedAt: new Date(T0 + JIRA_LIVE_TTL_MS + 1).toISOString() });
  });

  it('the cap evicts by ending the oldest confirmed as expired, so it stays in the history', () => {
    for (let i = 0; i < JIRA_LIVE_CAP; i++) {
      jest.setSystemTime(T0 + i * 1000);
      live.reserve(`PAY-${i}`, REPO);
      live.confirm(`PAY-${i}`, `s${i}`, META);
    }
    expect(live.reserve('NEW-1', REPO)).toBe(true);
    expect(live.links().find((l) => l.key === 'PAY-0')).toMatchObject({ endReason: 'expired' });
    expect(live.liveLinks()).toHaveLength(JIRA_LIVE_CAP - 1);
  });

  it('unlink refuses a run link; a branch link is removed and suppressed', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 'r1', META);
    expect(live.unlink('PAY-1', 'r1')).toBe('run');
    expect(live.liveLinks()).toHaveLength(1);
    live.addLink(link('PAY-1', 'b1'));
    expect(live.unlink('PAY-1', 'b1')).toBe('removed');
    expect(live.addLink(link('PAY-1', 'b1'))).toBe('suppressed');
    expect(live.unlink('PAY-1', 'b1')).toBe('missing');
  });

  it('addLink answers exists for a pair already stored, live or ended', () => {
    expect(live.addLink(link('PAY-1', 'b1'))).toBe('added');
    expect(live.addLink(link('PAY-1', 'b1'))).toBe('exists');
    live.end('PAY-1', 'b1', 'idle');
    expect(live.addLink(link('PAY-1', 'b1'))).toBe('exists');
  });

  it('snapshot is run-only and carries the session id', () => {
    live.reserve('PAY-4', REPO);
    live.confirm('PAY-4', 's4', META);
    live.addLink(link('PAY-5', 'b5'));
    const snap = live.snapshot();
    expect(Object.keys(snap)).toEqual(['PAY-4']);
    expect(snap['PAY-4']).toMatchObject({ sessionId: 's4', starting: false, name: 'jira PAY-1' });
  });

  it('get and release are run-only', () => {
    live.addLink(link('PAY-6', 'b6'));
    expect(live.get('PAY-6')).toBeNull();
    live.release('PAY-6');
    expect(live.liveLinks()).toHaveLength(1);
    expect(live.confirmed()).toEqual([]);
    expect(live.hasConfirmed()).toBe(false);
    expect(live.hasLive()).toBe(true);
  });

  it('never-link and suppression survive a reload, and unsuppress lifts one', () => {
    live.markNeverLink('PAY-8', 's3');
    live.addLink(link('PAY-9', 's4'));
    live.unlink('PAY-9', 's4');
    const again = new JiraLiveService();
    expect(again.isNeverLink('PAY-8', 's3')).toBe(true);
    expect(again.isNeverLink('PAY-8', 's4')).toBe(false);
    expect(again.isSuppressed('PAY-9', 's4')).toBe(true);
    expect(again.isSuppressed('PAY-8', 's4')).toBe(false);
    again.unsuppress('PAY-9', 's4');
    expect(again.addLink(link('PAY-9', 's4'))).toBe('added');
  });

  it('markQuiet keeps the first instant; clearQuiet resets it', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 's1', META);
    live.markQuiet('PAY-1', 's1', '2026-10-19T09:01:00.000Z');
    live.markQuiet('PAY-1', 's1', '2026-10-19T09:02:00.000Z');
    expect(live.links()[0].quietSince).toBe('2026-10-19T09:01:00.000Z');
    live.clearQuiet('PAY-1', 's1');
    expect(live.links()[0].quietSince).toBeNull();
  });

  it('atomic write: no temp file is left behind', () => {
    live.addLink(link('PAY-1', 'b1'));
    live.end('PAY-1', 'b1', 'idle');
    expect(readdirSync(dir)).toEqual(['jira-links.json']);
  });
});

describe('a store file that cannot be trusted', () => {
  const quiet = () => jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const entry = (over: Record<string, unknown> = {}) => ({ ...link('PAY-1', 's1'), endedAt: null, endReason: null, quietSince: null, ...over });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['truncated JSON', '{"version":1,"links":['],
    ['a wrong version', '{"version":2,"links":[]}']
  ])('%s: boots empty, and the file is renamed aside only at the first save', (_name, text) => {
    quiet();
    writeFileSync(file, text);
    const svc = new JiraLiveService();
    expect(svc.links()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['jira-links.json']); // untouched by the boot
    svc.addLink(link('PAY-1', 'b1'));
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('jira-links.json');
    expect(names[1]).toMatch(/^jira-links\.json\.bad-/);
    expect(readFileSync(join(dir, names[1]), 'utf8')).toBe(text);
    expect(new JiraLiveService().links()).toHaveLength(1);
  });

  it('a malformed entry costs only itself, and the file is not set aside', () => {
    quiet();
    const middle: Record<string, unknown> = entry({ key: 'PAY-2', sessionId: 's2' });
    delete middle.how;
    writeFileSync(file, JSON.stringify({ version: 1, links: [entry({ key: 'PAY-1' }), middle, entry({ key: 'PAY-3', sessionId: 's3' })] }));
    const svc = new JiraLiveService();
    expect(svc.links().map((l) => l.key)).toEqual(['PAY-1', 'PAY-3']);
    svc.addLink(link('PAY-4', 's4'));
    expect(readdirSync(dir)).toEqual(['jira-links.json']);
  });

  it('an unknown how, a missing key and a missing session id each cost only their entry', () => {
    quiet();
    writeFileSync(
      file,
      JSON.stringify({ version: 1, links: [entry({ how: 'telepathy' }), entry({ key: undefined }), entry({ sessionId: null }), entry({ key: 'PAY-7', sessionId: 's7' })] })
    );
    expect(new JiraLiveService().links().map((l) => l.key)).toEqual(['PAY-7']);
  });

  it('a save into a directory that does not exist yet creates it', () => {
    process.env.BM_JIRA_LINKS_FILE = join(dir, 'nested', 'deeper', 'jira-links.json');
    mkdirSync(dir, { recursive: true });
    const svc = new JiraLiveService();
    svc.addLink(link('PAY-1', 'b1'));
    expect(existsSync(process.env.BM_JIRA_LINKS_FILE)).toBe(true);
  });

  /* A save that throws is logged and costs nothing else — which let the store run memory-only in the compose stack for its whole life (EROFS, 2026-11-04).
     The failure is now held for the List to show, and cleared by the next save that lands. */
  it('a failed save is held as saveError, warned once per message, and the next good save clears it', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = process.env.BM_JIRA_LINKS_FILE;
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    const svc = new JiraLiveService();
    expect(svc.saveError()).toBeNull();

    process.env.BM_JIRA_LINKS_FILE = join(blocker, 'jira-links.json');
    svc.addLink(link('PAY-1', 'b1'));
    const first = svc.saveError();
    expect(first).toEqual({ message: expect.any(String), at: new Date(T0).toISOString() });
    expect(svc.links().map((l) => l.key)).toEqual(['PAY-1']); // memory still holds it
    jest.setSystemTime(T0 + 60_000);
    svc.addLink(link('PAY-2', 'b2'));
    expect(svc.saveError()).toEqual({ message: first?.message, at: new Date(T0 + 60_000).toISOString() });
    expect(warn).toHaveBeenCalledTimes(1);

    process.env.BM_JIRA_LINKS_FILE = good;
    svc.addLink(link('PAY-3', 'b3'));
    expect(svc.saveError()).toBeNull();
    expect(existsSync(good as string)).toBe(true);
    warn.mockRestore();
  });
});

/* The compose stack mounts ~/.backlog-manager read-only and only its `settings/` subtree read-write, so a links file anywhere else under it can never be
   saved there: every save logged EROFS and every restart dropped every link and every unlink (2026-11-04). The default path must sit in the writable mount. */
describe('jiraLinksFile default', () => {
  it('is settings/jira-links.json, beside jira.json, when BM_JIRA_LINKS_FILE is unset', () => {
    expect(jiraLinksFile({})).toBe(join(homedir(), '.backlog-manager', 'settings', 'jira-links.json'));
  });

  it("sits in the subtree docker-compose.yml mounts read-write", () => {
    const compose = readFileSync(join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    expect(dirname(jiraLinksFile({}))).toBe(join(homedir(), '.backlog-manager', 'settings'));
    expect(compose).toMatch(/^\s*- \$\{HOME\}\/\.backlog-manager\/settings:\$\{HOME\}\/\.backlog-manager\/settings\s*$/m);
  });
});

/**
 * The quiet-only Run gate (spec 2026-11-17-jira-quiet-run-gate-design.md): `reserve(key, repo, 'run', true)` lets a Run through beside live Runs on the
 * key that all yield (`runYields` — `quietSince` set AND a current row that reads Quiet), and `runBlock` names why the newest one that does not yield
 * still holds the key. Strict (`yieldToQuiet` false, the review's call) keeps today's rule.
 */
describe('the quiet gate', () => {
  const QUIET = new Date(T0 + 60_000).toISOString();
  const idle = (id: string) => ({ id, status: 'idle' });

  /** A confirmed Run on `key` started at `at` ms — reserved through the yielding path, so every live Run already on the key must yield. */
  function runOn(key: string, sessionId: string, at: number): void {
    jest.setSystemTime(at);
    expect(live.reserve(key, REPO, 'run', true)).toBe(true);
    live.confirm(key, sessionId, { ...META, name: jiraSessionName(key) });
  }

  /** Two live Runs on PAY-1: `a` (older, made quiet so `b` could start) and `b` (newer, quiet too). The case then sets the rows it wants. */
  function twoRuns(): void {
    runOn('PAY-1', 'a', T0);
    live.markQuiet('PAY-1', 'a', QUIET);
    live.setRows([idle('a')], T0 + 1000);
    runOn('PAY-1', 'b', T0 + 5000);
    live.markQuiet('PAY-1', 'b', QUIET);
  }

  it('a quiet Run yields to the next Run, but not to a strict (review) reserve', () => {
    runOn('PAY-1', 's1', T0);
    live.markQuiet('PAY-1', 's1', QUIET);
    live.setRows([idle('s1')], Date.now());
    expect(live.runBlock('PAY-1')).toBeNull();
    expect(live.reserve('PAY-1', REPO, 'run')).toBe(false);
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(true);
  });

  it('after a restart the persisted quietSince alone does not yield: no row yet is not seen by the dashboard', () => {
    runOn('PAY-1', 's1', T0);
    live.markQuiet('PAY-1', 's1', QUIET);
    const fresh = new JiraLiveService();
    expect(fresh.links()[0].quietSince).toBe(QUIET);
    expect(fresh.reserve('PAY-1', REPO, 'run', true)).toBe(false);
    expect(fresh.runBlock('PAY-1')).toBe('not seen by the dashboard');
  });

  it('an unreachable dashboard blocks a quiet Run as not seen by the dashboard', () => {
    runOn('PAY-1', 's1', T0);
    live.markQuiet('PAY-1', 's1', QUIET);
    live.setRows([idle('s1')], Date.now());
    live.markUnreachable(Date.now());
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(false);
    expect(live.runBlock('PAY-1')).toBe('not seen by the dashboard');
  });

  it.each([
    ['a working row', { id: 's1', status: 'working' }, QUIET, 'still working'],
    ['a question row with a remote reply', { id: 's1', status: 'question', remoteReply: true }, QUIET, 'waiting on you'],
    ['an idle row before quietSince', { id: 's1', status: 'idle' }, null, 'not quiet yet']
  ])('%s blocks: %s', (_name, row, quietSince, phrase) => {
    runOn('PAY-1', 's1', T0);
    if (quietSince !== null) live.markQuiet('PAY-1', 's1', quietSince);
    live.setRows([row], Date.now());
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(false);
    expect(live.runBlock('PAY-1')).toBe(phrase);
  });

  it.each([
    ['older quiet, newer working', [idle('a'), { id: 'b', status: 'working' }], 'still working'],
    ['older working, newer quiet', [{ id: 'a', status: 'working' }, idle('b')], 'still working'],
    ['older working, newer waiting', [{ id: 'a', status: 'working' }, { id: 'b', status: 'question', remoteReply: true }], 'waiting on you'],
    ['older waiting, newer working', [{ id: 'a', status: 'question', remoteReply: true }, { id: 'b', status: 'working' }], 'still working']
  ])('two live Runs on one key, %s: blocked, named by the newest that does not yield', (_name, rows, phrase) => {
    twoRuns();
    live.setRows(rows, Date.now());
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(false);
    expect(live.runBlock('PAY-1')).toBe(phrase);
  });

  it('two live Runs on one key that are both quiet let a third through', () => {
    twoRuns();
    live.setRows([idle('a'), idle('b')], Date.now());
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(true);
  });

  it('is per key: a working Run on PAY-2 does not hold PAY-1', () => {
    runOn('PAY-1', 's1', T0);
    runOn('PAY-2', 's2', T0 + 1000);
    live.markQuiet('PAY-1', 's1', QUIET);
    live.setRows([idle('s1'), { id: 's2', status: 'working' }], Date.now());
    expect(live.runBlock('PAY-1')).toBeNull();
    expect(live.runBlock('PAY-2')).toBe('still working');
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(true);
    expect(live.reserve('PAY-2', REPO, 'run', true)).toBe(false);
  });

  it('a run reservation on the key still refuses a yielding reserve', () => {
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(true);
    expect(live.reserve('PAY-1', REPO, 'run', true)).toBe(false);
  });

  it('snapshot reports the newest live Run on a key, whatever the store order', () => {
    const run = (sessionId: string, at: number) => ({
      ...link('PAY-1', sessionId, { action: 'execute', name: 'jira PAY-1' }, at),
      how: 'run',
      endedAt: null,
      endReason: null,
      quietSince: null
    });
    writeFileSync(file, JSON.stringify({ version: 1, links: [run('newer', T0 + 60_000), run('older', T0)] }));
    const fresh = new JiraLiveService();
    expect(fresh.links()).toHaveLength(2);
    expect(fresh.snapshot()['PAY-1'].sessionId).toBe('newer');
  });
});
