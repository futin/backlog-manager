import { JiraLiveService } from '../server/src/jira/live.service';
import { JIRA_LIVE_GRACE_MS, JIRA_RECONCILE_MS, JiraLiveReconciler } from '../server/src/agents/jira-live.service';

/**
 * Jira phase 5, Task 6 — the live-map reconciler (spec §3): every 60 s, while the map holds a confirmed session, one `GET /api/sessions` and a verdict per
 * entry. Cases drive `tick()` directly, so the verdicts need no timer; the three that are about the TIMER (armed once, disarmed when nothing is left to watch,
 * shut down with the app) use jest's fake clock and count the fetches the chain makes. The live map reads `Date.now()`, so `setSystemTime` moves ages.
 */

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const REPO = '/work/repo';
const KEYS = ['BM_AGENTS', 'BM_AGENTS_URL', 'BM_AGENTS_TOKEN'] as const;

let saved: Record<string, string | undefined>;
let live: JiraLiveService;
let reconciler: JiraLiveReconciler;
let urls: string[];
let sessions: { status: number; body: unknown } | 'reject';
const realFetch = global.fetch;

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env.BM_AGENTS_TOKEN = 's3cret';
  live = new JiraLiveService();
  reconciler = new JiraLiveReconciler(live);
  urls = [];
  sessions = { status: 200, body: { sessions: [] } };
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    urls.push(String(input));
    const answer = sessions;
    if (answer === 'reject') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve({ ok: answer.status < 400, status: answer.status, json: () => Promise.resolve(answer.body) } as Response);
  }) as jest.Mock;
});

afterEach(() => {
  reconciler.onApplicationShutdown();
  jest.useRealTimers();
  global.fetch = realFetch;
});

/** A confirmed entry that is `ageMs` old now: reserved in the past, with the clock then moved to the present. */
function seed(key: string, sessionId: string, ageMs: number): void {
  const now = Date.now();
  jest.setSystemTime(now - ageMs);
  expect(live.reserve(key, REPO)).toBe(true);
  live.confirm(key, sessionId);
  jest.setSystemTime(now);
}

const list = (...entries: { id: string; status?: string }[]) => {
  sessions = { status: 200, body: { sessions: entries } };
};
const OLD = JIRA_LIVE_GRACE_MS + 1;

describe('tick — which entries stay', () => {
  it('drops an entry whose session is idle', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1', status: 'idle' });
    await reconciler.tick();
    expect(live.get('PAY-1')).toBeNull();
  });

  it('drops an entry whose session is missing from the list', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'someone-else', status: 'working' });
    await reconciler.tick();
    expect(live.get('PAY-1')).toBeNull();
  });

  it('drops an entry whose session has no status string — only working and question keep one', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1' });
    await reconciler.tick();
    expect(live.get('PAY-1')).toBeNull();
  });

  it.each(['working', 'question'])('keeps an entry whose session is %s', async (status) => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1', status });
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('judges each entry on its own session', async () => {
    seed('PAY-1', 'sess-1', OLD);
    seed('PAY-2', 'sess-2', OLD);
    seed('PAY-3', 'sess-3', OLD);
    list({ id: 'sess-1', status: 'working' }, { id: 'sess-2', status: 'idle' });
    await reconciler.tick();
    expect(Object.keys(live.snapshot())).toEqual(['PAY-1']);
  });

  it('asks the dashboard once per tick, with its token, however many entries there are', async () => {
    seed('PAY-1', 'sess-1', OLD);
    seed('PAY-2', 'sess-2', OLD);
    await reconciler.tick();
    expect(urls).toEqual(['http://dash.test:4173/api/sessions']);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toEqual({ authorization: 'Bearer s3cret' });
  });
});

describe('tick — what it leaves alone', () => {
  /* A just-spawned session has no transcript yet, so the dashboard's list does not carry it: absent, for the first minutes, means "not yet", not "gone". */
  it('an entry younger than the grace is untouched, even when its session is absent', async () => {
    seed('PAY-1', 'sess-1', 90_000);
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('the grace is exact: one millisecond short is kept, the full 2 minutes is judged', async () => {
    seed('PAY-1', 'sess-1', JIRA_LIVE_GRACE_MS - 1);
    seed('PAY-2', 'sess-2', JIRA_LIVE_GRACE_MS);
    await reconciler.tick();
    expect(Object.keys(live.snapshot())).toEqual(['PAY-1']);
  });

  it('a starting entry is never reconciled, however old', async () => {
    jest.setSystemTime(T0 - OLD);
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    jest.setSystemTime(T0);
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBeNull();
  });

  it('does not ask the dashboard when there is nothing confirmed to judge', async () => {
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    await reconciler.tick();
    expect(urls).toEqual([]);
  });

  it('an unreadable list leaves the map untouched', async () => {
    seed('PAY-1', 'sess-1', OLD);
    sessions = { status: 500, body: { error: 'boom' } };
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('a dashboard that cannot be reached leaves the map untouched, and the tick does not throw', async () => {
    seed('PAY-1', 'sess-1', OLD);
    sessions = 'reject';
    await expect(reconciler.tick()).resolves.toBeUndefined();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('agents off leaves the map untouched and asks nothing', async () => {
    seed('PAY-1', 'sess-1', OLD);
    process.env.BM_AGENTS = 'off';
    await reconciler.tick();
    expect(urls).toEqual([]);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  /* The list is read across an await: a Stop followed by a fresh Start on the same key can land inside it. The new entry holds a different session id, and
     the verdict about the old one must not take it down. */
  it('does not drop an entry that was replaced while the list was being read', async () => {
    seed('PAY-1', 'sess-1', OLD);
    (global.fetch as jest.Mock).mockImplementationOnce(() => {
      live.clear('PAY-1');
      expect(live.reserve('PAY-1', REPO)).toBe(true);
      live.confirm('PAY-1', 'sess-2');
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) } as Response);
    });
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-2');
  });
});

describe('the timer — armed only while a session is confirmed', () => {
  it('arm() twice makes one chain: one fetch per interval, not two', async () => {
    seed('PAY-1', 'sess-1', 0);
    list({ id: 'sess-1', status: 'working' });
    reconciler.arm();
    reconciler.arm();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(2);
  });

  it('makes no request before its first interval, and none at all while never armed', async () => {
    seed('PAY-1', 'sess-1', OLD);
    await jest.advanceTimersByTimeAsync(10 * JIRA_RECONCILE_MS);
    expect(urls).toEqual([]);
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS - 1);
    expect(urls).toEqual([]);
  });

  it('disarms once a tick leaves nothing confirmed: no further fetch, no timer left', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1', status: 'idle' });
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(1);
    expect(live.hasConfirmed()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(2 * JIRA_LIVE_GRACE_MS);
    expect(urls).toHaveLength(1);
  });

  it('stays armed through an unreadable list and a dashboard that is off — the next interval asks again', async () => {
    seed('PAY-1', 'sess-1', OLD);
    sessions = { status: 500, body: {} };
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    process.env.BM_AGENTS = 'off';
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    process.env.BM_AGENTS = 'on';
    list({ id: 'sess-1', status: 'working' });
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(2);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('arm() can start a chain again after it disarmed', async () => {
    seed('PAY-1', 'sess-1', OLD);
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(live.hasConfirmed()).toBe(false);
    seed('PAY-2', 'sess-2', 0);
    list({ id: 'sess-2', status: 'working' });
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(2);
  });

  it('shutdown clears the timer and nothing re-arms it', async () => {
    seed('PAY-1', 'sess-1', 0);
    reconciler.arm();
    reconciler.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
    reconciler.arm();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(2 * JIRA_RECONCILE_MS);
    expect(urls).toEqual([]);
  });
});
