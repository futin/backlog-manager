import { JIRA_LIVE_CAP, JIRA_LIVE_TTL_MS, JiraLiveService } from '../server/src/jira/live.service';
import { jiraSessionName } from '../shared/types';

/**
 * Jira phase 5, Task 3 — the in-memory live map (spec §3 "live map", §4 `live`/`session`). The service reads `Date.now()` (like the poller), so every case
 * drives time with jest's fake clock and `setSystemTime`: nothing sleeps, and expiry and eviction order are exact to the millisecond.
 */

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const REPO = '/work/repo';

let live: JiraLiveService;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  live = new JiraLiveService();
});

afterEach(() => jest.useRealTimers());

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

describe('reserve / confirm / release / clear', () => {
  it('a reserve reads as a starting entry with no session id', () => {
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    expect(live.snapshot()).toEqual({ 'PAY-1': { name: 'jira PAY-1', startedAt: new Date(T0).toISOString(), repo: REPO, starting: true } });
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
    live.confirm('PAY-1', 'sess-1');
    expect(live.snapshot()['PAY-1'].starting).toBe(false);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('confirm of a key that is not held does not create it', () => {
    live.confirm('PAY-1', 'sess-1');
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
    live.confirm('PAY-1', 'sess-1');
    live.release('PAY-1');
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('clear removes an entry in either state', () => {
    live.reserve('PAY-1', REPO);
    live.reserve('PAY-2', REPO);
    live.confirm('PAY-2', 'sess-2');
    live.clear('PAY-1');
    live.clear('PAY-2');
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
    live.confirm('PAY-2', 'sess-2');
    expect(live.hasConfirmed()).toBe(true);
    expect(live.confirmed()).toEqual([{ key: 'PAY-2', sessionId: 'sess-2', startedAt: new Date(T0).toISOString() }]);
  });
});

describe('expiry', () => {
  it('an entry exactly 8 h old is still live; 1 ms later it is absent everywhere and the key can be reserved again', () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 'sess-1');
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
    live.confirm('PAY-1', 'sess-1');
    expect(live.get('PAY-1')).toBeNull();
  });
});

describe('the cap', () => {
  const fill = (n: number, from = 0): void => {
    for (let i = from; i < from + n; i++) {
      jest.setSystemTime(T0 + i * 1000);
      live.reserve(`PAY-${i}`, REPO);
      live.confirm(`PAY-${i}`, `sess-${i}`);
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
