import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { JiraLiveService } from '../server/src/jira/live.service';
import type { JiraPollerService, JiraResult } from '../server/src/jira/poller.service';
import { jiraLinksFile } from '../server/src/jira/links.store';
import { RUN_META } from './helpers/jira';
import { dashboardSessionRows, dashboardSessions } from '../server/src/agents/dashboard-sessions.util';
import { readAgentsConfig } from '../server/src/agents/config.util';
import { mainCheckoutOf } from '../server/src/agents/worktree-main.util';
import type { JiraIssue } from '../shared/types';
import {
  JIRA_LIVE_GRACE_MS,
  JIRA_QUIET_MS,
  JIRA_RECONCILE_FAST_MS,
  JIRA_RECONCILE_MS,
  JiraLiveReconciler
} from '../server/src/agents/jira-live.service';

/**
 * Jira phase 5, Task 6, reworked by Jira sessions Task 2 — the link reconciler (spec §5 Detach, Arming and rate; §6): every 60 s (15 s while a Jira page is
 * open), while a link is live or Setup maps a repo, one `GET /api/sessions?limit=50&lookback=168` and a verdict per live entry. A session that is not
 * `working`/`question` is Quiet, and ends only once its `quietSince` AND its `startedAt` are both 120 s old; an ended one whose row is active again re-attaches
 * (C5). Cases drive `tick()` directly, so the verdicts need no timer; the ones about the TIMER use jest's fake clock and count the fetches the chain makes. The
 * link store reads `Date.now()`, so `setSystemTime` moves ages.
 */

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const REPO = '/work/repo';
const KEYS = ['BM_AGENTS', 'BM_AGENTS_URL', 'BM_AGENTS_TOKEN'] as const;

let saved: Record<string, string | undefined>;
let live: JiraLiveService;
let reconciler: JiraLiveReconciler;
let reads: string[];
let issueAnswers: Map<string, JiraResult<JiraIssue>>;
let poller: Pick<JiraPollerService, 'issueSummary'>;
let urls: string[];
let sessions: { status: number; body: unknown } | 'reject';
let savedJiraFile: string | undefined;
const realFetch = global.fetch;

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  savedJiraFile = process.env.BM_JIRA_FILE;
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (savedJiraFile === undefined) delete process.env.BM_JIRA_FILE;
  else process.env.BM_JIRA_FILE = savedJiraFile;
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env.BM_AGENTS_TOKEN = 's3cret';
  live = new JiraLiveService();
  freshPoller();
  reconciler = new JiraLiveReconciler(live, poller as JiraPollerService);
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
  process.env.BM_JIRA_FILE = savedJiraFile;
  reconciler.onApplicationShutdown();
  jest.useRealTimers();
  global.fetch = realFetch;
});

/** A confirmed entry that is `ageMs` old now: reserved in the past, with the clock then moved to the present. */
function seed(key: string, sessionId: string, ageMs: number): void {
  const now = Date.now();
  jest.setSystemTime(now - ageMs);
  expect(live.reserve(key, REPO)).toBe(true);
  live.confirm(key, sessionId, RUN_META);
  jest.setSystemTime(now);
}

const list = (...entries: { id: string; status?: string }[]) => {
  sessions = { status: 200, body: { sessions: entries } };
};
const OLD = JIRA_LIVE_GRACE_MS + 1;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (ms: number) => jest.setSystemTime(ms);
/** The one link on `key`/`sessionId`, as the store holds it now. */
const entryOf = (key: string, sessionId: string) => live.links().find((l) => l.key === key && l.sessionId === sessionId);
/** A `branch` link as `addLink` takes it, started `ageMs` ago. */
const branchLink = (key: string, sessionId: string, ageMs: number) => ({
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
  startedAt: iso(Date.now() - ageMs)
});
/** A poller double: `issueSummary` answers from `issueAnswers`, else an ok issue for the key, and records each read in `reads`. */
function freshPoller(): void {
  reads = [];
  issueAnswers = new Map();
  poller = {
    issueSummary: jest.fn((key: string) => {
      reads.push(key);
      return Promise.resolve(issueAnswers.get(key) ?? { ok: true as const, value: issueFor(key) });
    })
  };
}
function issueFor(key: string): JiraIssue {
  return {
    key,
    id: '1',
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `Summary of ${key}`,
    project: { key: key.split('-')[0], name: 'P' },
    type: { name: 'Bug', level: 0, subtask: false },
    status: { name: 'In Progress', category: 'indeterminate' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: { key: 'PAY-1', summary: 'Epic' },
    subtasks: 0,
    labels: [],
    sprint: null,
    created: iso(T0),
    updated: iso(T0),
    resolved: null
  };
}
const failure = (status: number): JiraResult<JiraIssue> => ({ ok: false, response: { status, data: null, message: null, retryAfter: null } });

/** Points `jira.json` at a file mapping `PAY` to one repo, so Setup "maps a repo". */
function mapRepo(): void {
  const file = join(mkdtempSync(join(tmpdir(), 'bm-jira-live-')), 'jira.json');
  writeFileSync(file, JSON.stringify({ repos: { PAY: [REPO] } }));
  process.env.BM_JIRA_FILE = file;
}

describe('tick — which entries stay', () => {
  /* Rewritten from "drops an entry whose session is idle": an idle row no longer ends the entry on the spot. It starts the Quiet clock (spec §5 Detach), and the
     entry ends only once that clock is 120 s old. */
  it('an idle row starts the quiet clock and the entry stays live — no immediate drop', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1', status: 'idle' });
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
    expect(entryOf('PAY-1', 'sess-1')?.quietSince).toBe(iso(T0));
  });

  /* Rewritten from "drops an entry whose session is missing from the list": absence from a list SHORTER than the cap is quiet with reason `gone`, on the same
     two clocks, so the end comes 120 s after the first tick that missed it. */
  it('absent from a short list ends gone, once the quiet clock is 120 s old', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'someone-else', status: 'working' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endedAt: null, quietSince: iso(T0) });
    at(T0 + JIRA_QUIET_MS - 1);
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')?.endedAt).toBeNull();
    at(T0 + JIRA_QUIET_MS);
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endReason: 'gone', endedAt: iso(T0 + JIRA_QUIET_MS) });
    expect(live.get('PAY-1')).toBeNull();
  });

  /* The list's cap is why absence proves nothing: a full answer may simply not have reached this session. It stays live and the 8-hour backstop ends it. */
  it('absent from a full list of 50 stays live — nothing marks it quiet either', async () => {
    seed('PAY-1', 'sess-1', OLD);
    sessions = { status: 200, body: { sessions: Array.from({ length: 50 }, (_, i) => ({ id: `other-${i}`, status: 'working' })) } };
    await reconciler.tick();
    at(T0 + 10 * JIRA_QUIET_MS);
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endedAt: null, quietSince: null });
  });

  /* Rewritten from "drops an entry whose session has no status string": only working and question are active, so a row with none is Quiet like any other. */
  it('a row with no status string is not active: it goes quiet, never dropped on the spot', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endedAt: null, quietSince: iso(T0) });
    at(T0 + JIRA_QUIET_MS);
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endReason: 'idle' });
  });

  it.each(['working', 'question'])('keeps an entry whose session is %s', async (status) => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1', status });
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  /* Rewritten from the version that asserted one tick drops the idle and the absent entry: each is judged on its own session, but each now needs its quiet clock. */
  it('judges each entry on its own session', async () => {
    seed('PAY-1', 'sess-1', OLD);
    seed('PAY-2', 'sess-2', OLD);
    seed('PAY-3', 'sess-3', OLD);
    list({ id: 'sess-1', status: 'working' }, { id: 'sess-2', status: 'idle' });
    await reconciler.tick();
    expect(Object.keys(live.snapshot())).toEqual(['PAY-1', 'PAY-2', 'PAY-3']);
    expect(entryOf('PAY-1', 'sess-1')?.quietSince).toBeNull();
    expect(entryOf('PAY-2', 'sess-2')?.quietSince).toBe(iso(T0));
    expect(entryOf('PAY-3', 'sess-3')?.quietSince).toBe(iso(T0));
    at(T0 + JIRA_QUIET_MS);
    await reconciler.tick();
    expect(Object.keys(live.snapshot())).toEqual(['PAY-1']);
    expect(entryOf('PAY-2', 'sess-2')?.endReason).toBe('idle');
    expect(entryOf('PAY-3', 'sess-3')?.endReason).toBe('gone');
  });

  /* Rewritten from the exact-URL assertion: the read now carries the caps (the dashboard's own SCAN_CAPS maxima), still one per tick whatever the entry count. */
  it('asks the dashboard once per tick, with its token and the caps, however many entries there are', async () => {
    seed('PAY-1', 'sess-1', OLD);
    seed('PAY-2', 'sess-2', OLD);
    await reconciler.tick();
    expect(urls).toEqual(['http://dash.test:4173/api/sessions?limit=50&lookback=168']);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toEqual({ authorization: 'Bearer s3cret' });
  });
});

describe('tick — the quiet clock', () => {
  it.each(['incomplete', 'idle'])('%s for 120 s after a turn ends with idle: live at +119 s, ended at +120 s', async (status) => {
    seed('PAY-1', 'sess-1', 10 * 60_000);
    list({ id: 'sess-1', status });
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endedAt: null, quietSince: iso(T0) });
    at(T0 + 119_000);
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endedAt: null, quietSince: iso(T0) }); // a later quiet tick does not restart the clock
    at(T0 + 120_000);
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endReason: 'idle', endedAt: iso(T0 + 120_000), quietSince: null });
  });

  it('working inside the quiet window clears it, and the next quiet spell is a new clock', async () => {
    seed('PAY-1', 'sess-1', 10 * 60_000);
    list({ id: 'sess-1', status: 'incomplete' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')?.quietSince).toBe(iso(T0));
    at(T0 + 60_000);
    list({ id: 'sess-1', status: 'working' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')?.quietSince).toBeNull();
    at(T0 + 180_000);
    list({ id: 'sess-1', status: 'incomplete' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 'sess-1')).toMatchObject({ endedAt: null, quietSince: iso(T0 + 180_000) });
  });

  it('a branch link is judged like a run link', async () => {
    live.addLink(branchLink('PAY-1', 'b1', 10 * 60_000));
    list({ id: 'b1', status: 'idle' });
    await reconciler.tick();
    at(T0 + JIRA_QUIET_MS);
    await reconciler.tick();
    expect(entryOf('PAY-1', 'b1')?.endReason).toBe('idle');
  });
});

describe('tick — re-attach (C5)', () => {
  it('an ended session whose row is working again is live on its own entry, beside the other live session on the ticket', async () => {
    seed('PAY-1', 's1', 10 * 60_000);
    expect(live.end('PAY-1', 's1', 'idle')).toBe(true);
    seed('PAY-1', 's2', 10 * 60_000); // a second live Run, allowed now the first has ended
    const before = live.links().length;
    list({ id: 's1', status: 'working' }, { id: 's2', status: 'working' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 's1')).toMatchObject({ endedAt: null, endReason: null, reattachedAt: iso(T0) });
    expect(entryOf('PAY-1', 's2')).toMatchObject({ endedAt: null, reattachedAt: null });
    expect(live.links()).toHaveLength(before);
    expect(live.liveLinks()).toHaveLength(2);
  });

  it('a question row re-attaches too; an idle or absent one does not', async () => {
    for (const [key, id] of [['PAY-1', 'q'], ['PAY-2', 'i'], ['PAY-3', 'a']] as const) {
      seed(key, id, 10 * 60_000);
      live.end(key, id, 'idle');
    }
    seed('PAY-9', 'keep', 10 * 60_000); // something live, so the tick reads the list at all
    list({ id: 'q', status: 'question' }, { id: 'i', status: 'idle' }, { id: 'keep', status: 'working' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 'q')?.endedAt).toBeNull();
    expect(entryOf('PAY-2', 'i')?.endedAt).not.toBeNull();
    expect(entryOf('PAY-3', 'a')?.endedAt).not.toBeNull();
  });

  it('a re-attached run is judged afresh: quiet again for 120 s before it ends, however old its startedAt', async () => {
    mapRepo(); // nothing else is live, so only a mapped repo makes the tick read the list at all
    seed('PAY-1', 's1', 10 * 60_000);
    live.end('PAY-1', 's1', 'idle');
    list({ id: 's1', status: 'working' });
    await reconciler.tick();
    at(T0 + 1000);
    list({ id: 's1', status: 'incomplete' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 's1')).toMatchObject({ endedAt: null, quietSince: iso(T0 + 1000) });
  });
});

describe('tick — what it leaves alone', () => {
  /* A just-spawned session has no transcript yet, so the dashboard's list does not carry it: absent, for the first minutes, means "not yet", not "gone". */
  it('an entry younger than the grace is untouched, even when its session is absent', async () => {
    seed('PAY-1', 'sess-1', 90_000);
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
    expect(entryOf('PAY-1', 'sess-1')?.quietSince).toBeNull();
  });

  /* Rewritten from "one millisecond short is kept, the full 2 minutes is judged": judged no longer means dropped. The young entry gets no quiet clock at all; the
     one exactly at the grace starts its clock, and is still live. */
  it('the grace is exact: one millisecond short is not judged, the full 2 minutes is — and starts its quiet clock', async () => {
    seed('PAY-1', 'sess-1', JIRA_LIVE_GRACE_MS - 1);
    seed('PAY-2', 'sess-2', JIRA_LIVE_GRACE_MS);
    await reconciler.tick();
    expect(Object.keys(live.snapshot())).toEqual(['PAY-1', 'PAY-2']);
    expect(entryOf('PAY-1', 'sess-1')?.quietSince).toBeNull();
    expect(entryOf('PAY-2', 'sess-2')?.quietSince).toBe(iso(T0));
  });

  it('a starting entry is never reconciled, however old', async () => {
    jest.setSystemTime(T0 - OLD);
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    jest.setSystemTime(T0);
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBeNull();
  });

  it('does not ask the dashboard when there is nothing live to judge and no repo is mapped', async () => {
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    await reconciler.tick();
    expect(urls).toEqual([]);
  });

  it('asks once for an empty store when Setup maps a repo — the rows are what detection will read', async () => {
    mapRepo();
    await reconciler.tick();
    expect(urls).toHaveLength(1);
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

  /* Lost contact (spec §6) is only the dashboard not answering: ten ticks of it end nothing, and the first good answer clears the flag. */
  it('unreachable dashboard ends nothing: ten failing ticks leave every entry live and reachable() false; the next good tick is reachable again', async () => {
    seed('PAY-1', 'sess-1', 10 * 60_000);
    live.markQuiet('PAY-1', 'sess-1', iso(T0 - 10 * 60_000)); // quiet far past the clock — only the missing answer protects it
    seed('PAY-2', 'sess-2', 10 * 60_000);
    sessions = 'reject';
    for (let i = 0; i < 10; i++) {
      at(T0 + i * JIRA_RECONCILE_MS);
      await reconciler.tick();
    }
    expect(live.liveLinks()).toHaveLength(2);
    expect(live.reachable()).toBe(false);
    list({ id: 'sess-1', status: 'working' }, { id: 'sess-2', status: 'working' });
    at(T0 + 11 * JIRA_RECONCILE_MS);
    await reconciler.tick();
    expect(live.reachable()).toBe(true);
    expect(live.rowsAt()).toBe(iso(T0 + 11 * JIRA_RECONCILE_MS));
    expect(live.rowFor('sess-1')?.status).toBe('working');
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
    live.markQuiet('PAY-1', 'sess-1', iso(T0 - JIRA_QUIET_MS)); // sess-1 is due to end the moment the list says it is not active
    (global.fetch as jest.Mock).mockImplementationOnce(() => {
      live.end('PAY-1', 'sess-1', 'stopped');
      expect(live.reserve('PAY-1', REPO)).toBe(true);
      live.confirm('PAY-1', 'sess-2', RUN_META);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) } as Response);
    });
    await reconciler.tick();
    expect(live.get('PAY-1')?.sessionId).toBe('sess-2');
    expect(entryOf('PAY-1', 'sess-1')?.endReason).toBe('stopped'); // Stop's end stands; the verdict did not rewrite it
  });
});

describe('after a restart', () => {
  const persisted = (key: string, sessionId: string, startedAt: number, quietSince: number | null) => ({
    ...branchLink(key, sessionId, 0),
    how: 'run',
    action: 'execute',
    startedAt: iso(startedAt),
    endedAt: null,
    endReason: null,
    quietSince: quietSince === null ? null : iso(quietSince),
    reattachedAt: null
  });
  const restart = (links: unknown[]) => {
    mkdirSync(dirname(jiraLinksFile()), { recursive: true });
    writeFileSync(jiraLinksFile(), JSON.stringify({ version: 1, links, suppressed: [], neverLink: [] }));
    live = new JiraLiveService();
    reconciler = new JiraLiveReconciler(live, poller as JiraPollerService);
  };

  it('a persisted live run is not ended on load; the quiet clock starts at the first tick and ends it 120 s after', async () => {
    expect(live.reserve('PAY-2', REPO)).toBe(true); // a Start that was in flight when the server went down
    restart([persisted('PAY-1', 's1', T0 - 3600_000, null)]);
    expect(live.get('PAY-2')).toBeNull();
    expect(entryOf('PAY-1', 's1')).toMatchObject({ endedAt: null, quietSince: null });
    list({ id: 's1', status: 'idle' });
    await reconciler.tick();
    expect(entryOf('PAY-1', 's1')).toMatchObject({ endedAt: null, quietSince: iso(T0) });
    at(T0 + 120_000);
    await reconciler.tick();
    expect(entryOf('PAY-1', 's1')).toMatchObject({ endReason: 'idle', endedAt: iso(T0 + 120_000) });
  });

  /* Spec §12: "ends at the first reconcile, not on load" — a session that ended while the server was down. */
  it('a session that went quiet 10 minutes before the restart is live after load and ended idle at the first tick', async () => {
    restart([persisted('PAY-3', 's2', T0 - 3600_000, T0 - 10 * 60_000)]);
    expect(entryOf('PAY-3', 's2')?.endedAt).toBeNull();
    list({ id: 's2', status: 'idle' });
    await reconciler.tick();
    expect(entryOf('PAY-3', 's2')).toMatchObject({ endReason: 'idle', endedAt: iso(T0) });
  });
});

describe('the dashboard read', () => {
  const fixture = {
    sessions: [
      { id: 'a', status: 'working', surface: 'dashboard', stopState: 'ready', remotePlan: true, projectPath: '/p', gitBranch: 'PAY-1-x', sessionName: 'n', model: 'opus', effort: 'high', contextPct: 12 },
      { id: 'b', status: 'idle', surface: 'local', desktopOwned: true, processLive: true },
      { id: 'c' },
      { id: 'a', status: 'idle' },
      { status: 'working' },
      'junk'
    ]
  };

  it('dashboardSessions output unchanged: the same fixture reads as the same id → status map, over the bare URL', async () => {
    sessions = { status: 200, body: fixture };
    const map = await dashboardSessions(readAgentsConfig());
    expect([...map]).toEqual([['a', 'working'], ['b', 'idle'], ['c', 'unknown']]);
    expect(urls).toEqual(['http://dash.test:4173/api/sessions']); // the three existing readers keep the dashboard's own caps, not this one's
  });

  it('asks with the caps, and carries each row field the spec lists — absent flags stay absent', async () => {
    sessions = { status: 200, body: fixture };
    const { rows, full } = await dashboardSessionRows(readAgentsConfig());
    expect(urls[0]).toContain('limit=50');
    expect(urls[0]).toContain('lookback=168');
    expect(full).toBe(false);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).toMatchObject({
      status: 'working',
      surface: 'dashboard',
      stopState: 'ready',
      remotePlan: true,
      projectPath: '/p',
      gitBranch: 'PAY-1-x',
      sessionName: 'n',
      model: 'opus',
      effort: 'high',
      contextPct: 12
    });
    expect(rows[1]).toMatchObject({ desktopOwned: true, processLive: true });
    expect('stopState' in rows[1]).toBe(false);
    expect('desktopOwned' in rows[0]).toBe(false);
    expect(rows[2].status).toBe('unknown');
  });

  it('full is true at 50 rows and false at 49', async () => {
    const many = (n: number) => ({ sessions: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, status: 'idle' })) });
    sessions = { status: 200, body: many(49) };
    expect((await dashboardSessionRows(readAgentsConfig())).full).toBe(false);
    sessions = { status: 200, body: many(50) };
    expect((await dashboardSessionRows(readAgentsConfig())).full).toBe(true);
  });
});

describe('the timer — armed while a link is live or a repo is mapped', () => {
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

  /* Rewritten from "disarms once a tick leaves nothing confirmed": the first tick that sees the session quiet no longer ends it, so the chain runs on until the
     tick that does — three 60 s ticks — and only then, with nothing live and no repo mapped, stands down. */
  it('disarms once a tick leaves nothing live and no repo is mapped: no further fetch, no timer left', async () => {
    seed('PAY-1', 'sess-1', OLD);
    list({ id: 'sess-1', status: 'idle' });
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(2 * JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(2);
    expect(live.hasLive()).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(3);
    expect(live.hasLive()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(2 * JIRA_LIVE_GRACE_MS);
    expect(urls).toHaveLength(3);
  });

  /* Rewritten from "disarms when nothing is confirmed" for the other half of the new rule: a mapped repo keeps the chain going on an empty store, because
     detection has something to find there. */
  it('stays armed on an empty store while a repo is mapped', async () => {
    mapRepo();
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(3 * JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(3);
    expect(jest.getTimerCount()).toBe(1);
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
    await jest.advanceTimersByTimeAsync(3 * JIRA_RECONCILE_MS);
    expect(live.hasLive()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    seed('PAY-2', 'sess-2', 0);
    list({ id: 'sess-2', status: 'working' });
    reconciler.arm();
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(4);
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

  describe('on boot', () => {
    it('arms with an empty store when a repo is mapped', () => {
      mapRepo();
      reconciler.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(1);
    });

    it('arms for a live link with no repo mapped', () => {
      seed('PAY-1', 'sess-1', OLD);
      reconciler.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(1);
    });

    it('does not arm with no repos and nothing live — an ended entry and a starting one are not live', () => {
      seed('PAY-1', 'sess-1', OLD);
      live.end('PAY-1', 'sess-1', 'idle');
      expect(live.reserve('PAY-2', REPO)).toBe(true);
      reconciler.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('the period follows whether a Jira page is open', () => {
    it('15 s while a page is open: the next tick is scheduled at 15 s, and 60 s once a read is more than 30 s old', async () => {
      seed('PAY-1', 'sess-1', 0);
      list({ id: 'sess-1', status: 'working' });
      live.notePageRead(Date.now());
      reconciler.arm();
      await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_FAST_MS - 1);
      expect(urls).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(urls).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_FAST_MS); // re-armed at 15 s with the read 15 s old: still fast
      expect(urls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_FAST_MS); // re-armed at 30 s with the read exactly 30 s old: still open
      expect(urls).toHaveLength(3);
      // The read is now 45 s old at the re-arm: the chain falls back to 60 s.
      await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS - 1);
      expect(urls).toHaveLength(3);
      await jest.advanceTimersByTimeAsync(1);
      expect(urls).toHaveLength(4);
    });

    it('31 s without a read arms at 60 s', async () => {
      seed('PAY-1', 'sess-1', 0);
      live.notePageRead(Date.now());
      jest.setSystemTime(T0 + 31_000);
      expect(live.pageOpen(Date.now())).toBe(false);
      reconciler.arm();
      await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_FAST_MS);
      expect(urls).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS - JIRA_RECONCILE_FAST_MS);
      expect(urls).toHaveLength(1);
    });
  });
});

describe('mainCheckoutOf', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bm-main-checkout-'));
  });

  it('a directory .git is a main checkout: the path itself', () => {
    mkdirSync(join(root, '.git'));
    expect(mainCheckoutOf(root)).toBe(root);
  });

  it('a gitdir: file under <x>/.git/worktrees/<name> resolves to <x>', () => {
    writeFileSync(join(root, '.git'), 'gitdir: /r/.git/worktrees/w\n');
    expect(mainCheckoutOf(root)).toBe('/r');
  });

  it('a relative gitdir resolves against the path', () => {
    const wt = join(root, 'repo', '.worktrees', 'w');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ../../.git/worktrees/w\n');
    expect(mainCheckoutOf(wt)).toBe(join(root, 'repo'));
  });

  it('missing, garbage, and a gitdir outside .git/worktrees all say null', () => {
    expect(mainCheckoutOf(join(root, 'nope'))).toBeNull();
    expect(mainCheckoutOf(root)).toBeNull();
    writeFileSync(join(root, '.git'), 'not a pointer');
    expect(mainCheckoutOf(root)).toBeNull();
    writeFileSync(join(root, '.git'), 'gitdir: /r/.git/modules/sub\n');
    expect(mainCheckoutOf(root)).toBeNull();
  });
});

describe('branch detection (Jira sessions §5)', () => {
  let main: string;
  let other: string;
  const mapped = (project = 'PAY', repo = main): void => {
    const file = join(mkdtempSync(join(tmpdir(), 'bm-jira-detect-')), 'jira.json');
    writeFileSync(file, JSON.stringify({ repos: { [project]: [repo] } }));
    process.env.BM_JIRA_FILE = file;
  };
  /** A linked worktree of `repo` at `<repo>/.worktrees/<name>`, with the `.git` file git writes. */
  const worktreeOf = (repo: string, name: string): string => {
    const wt = join(repo, '.worktrees', name);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${repo}/.git/worktrees/${name}\n`);
    return wt;
  };
  const row = (id: string, branch: string, projectPath: string, status = 'working', surface = 'dashboard') => ({ id, status, gitBranch: branch, projectPath, surface });
  const rows = (...r: ReturnType<typeof row>[]) => {
    sessions = { status: 200, body: { sessions: r } };
  };
  const linkOf = (key: string, id: string) => live.links().find((l) => l.key === key && l.sessionId === id);

  beforeEach(() => {
    main = mkdtempSync(join(tmpdir(), 'bm-detect-main-'));
    mkdirSync(join(main, '.git'));
    other = mkdtempSync(join(tmpdir(), 'bm-detect-other-'));
    mkdirSync(join(other, '.git'));
    mapped();
  });

  it('links a working session whose branch carries a key in a mapped repo, with the issue snapshot, on an empty store', async () => {
    rows(row('s1', 'PAY-151-currency-rounding', main));
    await reconciler.tick();
    expect(reads).toEqual(['PAY-151']);
    expect(linkOf('PAY-151', 's1')).toMatchObject({
      how: 'branch',
      action: null,
      repo: main,
      branch: 'PAY-151-currency-rounding',
      surface: 'dashboard',
      startedAt: iso(T0),
      endedAt: null,
      snapshot: { summary: 'Summary of PAY-151', type: 'Bug', parentKey: 'PAY-1' }
    });
  });

  it('a question row is detected too; a non-dashboard surface records null', async () => {
    rows(row('s1', 'feature/PAY-151', main, 'question', 'local'));
    await reconciler.tick();
    expect(linkOf('PAY-151', 's1')).toMatchObject({ surface: null });
  });

  it('a key in an unmapped repo, or of an unmapped project, never links and costs no read', async () => {
    rows(row('s1', 'PAY-151-x', other), row('s2', 'OPS-3-x', main));
    await reconciler.tick();
    expect(reads).toEqual([]);
    expect(live.links()).toEqual([]);
  });

  it('a session in <mapped>/.worktrees/PAY-151-x links; one in a worktree of an unmapped repo does not', async () => {
    rows(row('s1', 'PAY-151-x', worktreeOf(main, 'PAY-151-x')), row('s2', 'PAY-152-x', worktreeOf(other, 'PAY-152-x')));
    await reconciler.tick();
    expect(reads).toEqual(['PAY-151']);
    expect(linkOf('PAY-151', 's1')).toMatchObject({ repo: main });
    expect(linkOf('PAY-152', 's2')).toBeUndefined();
  });

  it('a trailing slash on the row path, and an underscore before the key, still match', async () => {
    rows(row('s1', 'release_PAY-151', `${main}/`));
    await reconciler.tick();
    expect(linkOf('PAY-151', 's1')).toMatchObject({ repo: main });
  });

  it('idle and incomplete rows are never detected', async () => {
    rows(row('s1', 'PAY-151-x', main, 'idle'), row('s2', 'PAY-152-x', main, 'incomplete'));
    await reconciler.tick();
    expect(reads).toEqual([]);
  });

  it('a row with no branch or no project path is skipped', async () => {
    sessions = { status: 200, body: { sessions: [{ id: 's1', status: 'working', projectPath: main }, { id: 's2', status: 'working', gitBranch: 'PAY-1-x' }] } };
    await reconciler.tick();
    expect(reads).toEqual([]);
  });

  it('two keys on one branch link both', async () => {
    rows(row('s1', 'PAY-1-and-PAY-2', main));
    await reconciler.tick();
    expect(linkOf('PAY-1', 's1')).toBeDefined();
    expect(linkOf('PAY-2', 's1')).toBeDefined();
  });

  it('a session that moves from PAY-151-x to PAY-160-y keeps PAY-151 and gains PAY-160, and the known pair costs no second read', async () => {
    rows(row('s1', 'PAY-151-x', main));
    await reconciler.tick();
    rows(row('s1', 'PAY-160-y', main));
    await reconciler.tick();
    expect(linkOf('PAY-151', 's1')).toMatchObject({ endedAt: null });
    expect(linkOf('PAY-160', 's1')).toBeDefined();
    expect(reads).toEqual(['PAY-151', 'PAY-160']);
    await reconciler.tick();
    expect(reads).toEqual(['PAY-151', 'PAY-160']);
  });

  it('a Jira 404 is never linked and not re-read next tick', async () => {
    issueAnswers.set('PAY-151', failure(404));
    rows(row('s1', 'PAY-151-x', main));
    await reconciler.tick();
    expect(live.links()).toEqual([]);
    expect(live.isNeverLink('PAY-151', 's1')).toBe(true);
    await reconciler.tick();
    expect(reads).toEqual(['PAY-151']);
  });

  it('a 429 (or any other failure) leaves nothing and is read again next tick, then links', async () => {
    issueAnswers.set('PAY-151', failure(429));
    rows(row('s1', 'PAY-151-x', main));
    await reconciler.tick();
    expect(live.links()).toEqual([]);
    expect(live.isNeverLink('PAY-151', 's1')).toBe(false);
    issueAnswers.delete('PAY-151');
    await reconciler.tick();
    expect(reads).toEqual(['PAY-151', 'PAY-151']);
    expect(linkOf('PAY-151', 's1')).toBeDefined();
  });

  it('a person-unlinked (suppressed) pair is not read, and an ended pair is left to re-attach', async () => {
    expect(live.addLink({ ...branchLink('PAY-151', 's1', 1000) })).toBe('added');
    live.unlink('PAY-151', 's1');
    rows(row('s1', 'PAY-151-x', main));
    await reconciler.tick();
    expect(reads).toEqual([]);
    expect(live.links()).toEqual([]);
  });

  it('at most 5 reads per tick; the other 2 wait for the next', async () => {
    rows(...[1, 2, 3, 4, 5, 6, 7].map((n) => row(`s${n}`, `PAY-${100 + n}-x`, main)));
    await reconciler.tick();
    expect(reads).toHaveLength(5);
    expect(live.links()).toHaveLength(5);
    await reconciler.tick();
    expect(reads).toHaveLength(7);
    expect(reads.slice(5)).toEqual(['PAY-106', 'PAY-107']);
    expect(live.links()).toHaveLength(7);
  });

  it('a detected session beside a live Run on the ticket: both live, and reserve is still refused; a branch link alone leaves reserve open', async () => {
    seed('PAY-151', 'run-1', OLD);
    rows(row('run-1', 'PAY-151-x', main), row('s2', 'PAY-151-y', main));
    await reconciler.tick();
    expect(live.liveLinks().filter((l) => l.key === 'PAY-151').map((l) => l.how).sort()).toEqual(['branch', 'run']);
    expect(live.reserve('PAY-151', main)).toBe(false);
    // …and a ticket that holds only a branch link can be Run.
    rows(row('s3', 'PAY-200-x', main));
    await reconciler.tick();
    expect(linkOf('PAY-200', 's3')).toMatchObject({ how: 'branch' });
    expect(live.reserve('PAY-200', main)).toBe(true);
  });

  it('with no repo mapped nothing is detected and nothing is asked of Jira', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bm-jira-detect-')), 'jira.json');
    writeFileSync(file, '{}');
    process.env.BM_JIRA_FILE = file;
    rows(row('s1', 'PAY-151-x', main));
    await reconciler.tick();
    expect(reads).toEqual([]);
  });
});

describe('arming when Setup maps a repo while the server runs', () => {
  it('an empty store with no mapped repo is not ticking; a repos save arms the reconciler', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bm-jira-arm-')), 'jira.json');
    writeFileSync(file, '{}');
    process.env.BM_JIRA_FILE = file;
    reconciler.arm();
    expect(jest.getTimerCount()).toBe(0);
    writeFileSync(file, JSON.stringify({ repos: { PAY: [REPO] } }));
    live.reposChanged();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(JIRA_RECONCILE_MS);
    expect(urls).toHaveLength(1);
  });

  it('a save that maps nothing arms nothing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bm-jira-arm-')), 'jira.json');
    writeFileSync(file, '{}');
    process.env.BM_JIRA_FILE = file;
    live.reposChanged();
    expect(jest.getTimerCount()).toBe(0);
  });
});
