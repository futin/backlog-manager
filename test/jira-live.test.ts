import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JIRA_LIVE_CAP, JIRA_LIVE_TTL_MS, JiraLiveService } from '../server/src/jira/live.service';
import { jiraLinksFile } from '../server/src/jira/links.store';
import { jiraSessionName } from '../shared/types';
import type { JiraLink } from '../shared/types';

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
});
