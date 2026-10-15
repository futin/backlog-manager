import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JiraBoard, JiraQuery } from '../shared/types';
import { JIRA_RATE_LIMIT_DEFAULT_MS } from '../server/src/jira/errors.util';
import { JIRA_BACKOFF_MAX_MS, JIRA_BACKOFF_MIN_MS, JiraBootState, nextBackoff } from '../server/src/jira/identity';
import { JiraClient } from '../server/src/jira/jira.client';
import { JIRA_ISSUE_FIELDS } from '../server/src/jira/map-issue';
import {
  JIRA_BOARD_CAP,
  JIRA_DESCENDANT_ROUNDS,
  JIRA_PAGE_SIZE,
  JIRA_POLL_MS,
  JIRA_QUERY_CAP,
  JIRA_ROOT_CAP,
  JIRA_SEARCH_LIMIT,
  JIRA_SEARCH_MAX_CHARS,
  JiraPollerService
} from '../server/src/jira/poller.service';
import { FakeJira, makeRawIssue, type JiraCall } from './helpers/jira';

/**
 * Jira phase 1, Task 6 — `identity.ts` and `poller.service.ts` (spec §3, §5 and §8; plan Review Focus 2, 3 and 5; preflight rulings P1–P5, P13).
 *
 * Every sweep is driven by `await poller.tick()`, never by a real timer: the chain's `setTimeout` is observed only through `armed`, and every case shuts the
 * poller down afterwards so no link outlives its case. The clock is `Date.now`, mocked and moved by hand — the poller builds every instant from it, so the
 * fixtures below are arithmetic on `T0` and nothing here is a literal that ages.
 */

const T0 = Date.parse('2026-10-16T12:00:00Z');
const DAY = 86_400_000;
const EMAIL = 'ada@example.com';
const TOKEN = 't0k3n-SECRET';
const B1 = 'b_0123abcd';
const B2 = 'b_0123abce';
const Q1 = 'q_0123abcd';
const SPRINT = 'customfield_10020';
const SWEEP_FIELDS = [...JIRA_ISSUE_FIELDS, SPRINT];

const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE'] as const;

let fake: FakeJira;
let poller: JiraPollerService;
let now: number;
let dir: string;
let file: string;
let saved: Record<string, string | undefined>;
/** Every call every case's fake saw — the token case reads the whole suite's log. */
const suiteCalls: JiraCall[] = [];

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.BM_JIRA_SITE = 'acme.atlassian.net';
  process.env.BM_JIRA_EMAIL = EMAIL;
  process.env.BM_JIRA_TOKEN = TOKEN;
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-poller-'));
  file = join(dir, 'jira.json');
  process.env.BM_JIRA_FILE = file;
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  fake = new FakeJira();
  poller = new JiraPollerService(new JiraClient(fake.fetch));
});

afterEach(() => {
  poller.disarm();
  poller.onApplicationShutdown();
  suiteCalls.push(...fake.calls);
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

function writeConfig(boards: JiraBoard[], repos: Record<string, string[]> = {}): void {
  writeFileSync(file, JSON.stringify({ boards, repos }));
}

/** A short name per call, so a case can assert the exact sequence. */
function label(c: JiraCall): string {
  const u = new URL(c.url);
  if (u.hostname === 'acme.atlassian.net') return u.pathname === '/_edge/tenant_info' ? 'tenant_info' : 'site myself';
  const path = u.pathname.replace(/^\/ex\/jira\/[^/]+\/rest\/api\/3/, '');
  if (path === '/search/jql') return `search ${(c.body as { jql: string }).jql}`;
  return path.slice(1);
}

const labels = () => fake.calls.map(label);
const searches = () => fake.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => (c.body as { jql: string }).jql);
const searchBodies = () => fake.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => c.body as Record<string, unknown>);
const isGatewayMyself = (url: string) => url.startsWith('https://api.atlassian.com/') && url.endsWith('/myself');
const isSearch = (url: string) => url.endsWith('/search/jql');
const keysOf = (id = B1) => poller.boardIssues(id)?.issues.map((i) => i.key);

const BOOT = ['tenant_info', 'serverInfo', 'myself', 'site myself', 'field'];

/** The epic PAY-120 → stories PAY-131, PAY-134 → PAY-131's subtasks PAY-132, PAY-133. */
function seedTree(): void {
  const epic = { name: 'Epic', hierarchyLevel: 1, subtask: false };
  const sub = { name: 'Sub-task', hierarchyLevel: -1, subtask: true };
  const parent = (key: string) => ({ key, fields: { summary: `Summary of ${key}` } });
  fake.issues.set('PAY-120', makeRawIssue({ key: 'PAY-120', fields: { issuetype: epic } }));
  fake.issues.set('PAY-131', makeRawIssue({ key: 'PAY-131', fields: { parent: parent('PAY-120') } }));
  fake.issues.set('PAY-134', makeRawIssue({ key: 'PAY-134', fields: { parent: parent('PAY-120') } }));
  fake.issues.set('PAY-132', makeRawIssue({ key: 'PAY-132', fields: { parent: parent('PAY-131'), issuetype: sub } }));
  fake.issues.set('PAY-133', makeRawIssue({ key: 'PAY-133', fields: { parent: parent('PAY-131'), issuetype: sub } }));
}

/** `n` issues `<prefix>-<from>`…, seeded into the fake and returned as keys. */
function seedMany(n: number, prefix = 'PAY', from = 1, fields: Record<string, unknown> = {}): string[] {
  const keys: string[] = [];
  for (let i = from; i < from + n; i++) {
    const key = `${prefix}-${i}`;
    fake.issues.set(key, makeRawIssue({ key, fields }));
    keys.push(key);
  }
  return keys;
}

function query(jql: string, id = Q1, label = 'mine'): JiraQuery {
  return { id, label, jql };
}

/** Boot the poller with nothing configured, then forget the boot's calls. */
async function booted(): Promise<void> {
  await poller.tick();
  fake.calls.length = 0;
}

describe('constants', () => {
  it('are the numbers of the global constraints', () => {
    expect(JIRA_POLL_MS).toBe(15_000);
    expect(JIRA_QUERY_CAP).toBe(200);
    expect(JIRA_ROOT_CAP).toBe(200);
    expect(JIRA_BOARD_CAP).toBe(500);
    expect(JIRA_DESCENDANT_ROUNDS).toBe(2);
    expect(JIRA_SEARCH_LIMIT).toBe(20);
    expect(JIRA_SEARCH_MAX_CHARS).toBe(100);
    expect(JIRA_PAGE_SIZE).toBe(100);
    expect(JIRA_BACKOFF_MIN_MS).toBe(15_000);
    expect(JIRA_BACKOFF_MAX_MS).toBe(300_000);
  });
});

describe('unconfigured', () => {
  it('never arms, never calls, and says which key is missing', async () => {
    process.env.BM_JIRA_SITE = '';
    poller.arm();
    expect(poller.armed).toBe(false);
    await poller.tick();
    expect(fake.calls).toEqual([]);
    expect(poller.armed).toBe(false);
    expect(poller.status()).toEqual({
      configured: false,
      configUnreadable: null,
      site: null,
      me: null,
      tokenKind: null,
      access: 'unconfigured',
      detail: 'BM_JIRA_SITE is not set',
      boards: [],
      repos: {},
      projects: [],
      skills: [],
      calls: { sweep: 0, last429At: null },
      live: {}
    });
  });
});

describe('before the first tick', () => {
  it('reads as connecting, with no identity yet', () => {
    const s = poller.status();
    expect(s).toMatchObject({ configured: true, access: 'ok', detail: 'connecting', me: null, site: 'acme.atlassian.net', tokenKind: null });
    expect(fake.calls).toEqual([]);
  });
});

describe('boot, no boards', () => {
  it('asks the five boot calls once, in order, and is then owed nothing', async () => {
    await poller.tick();
    expect(labels()).toEqual(BOOT);
    expect(poller.status()).toMatchObject({
      access: 'ok',
      detail: null,
      me: { accountId: 'acc-1', name: 'Ada Lovelace' },
      tokenKind: 'classic',
      calls: { sweep: 5, last429At: null }
    });
    expect(poller.armed).toBe(false);

    fake.calls.length = 0;
    now += 60_000;
    await poller.tick();
    expect(fake.calls).toEqual([]);
  });

  it('records a scoped token when the site probe answers 401', async () => {
    fake.siteMyselfStatus = 401;
    await poller.tick();
    expect(poller.status().tokenKind).toBe('scoped');
  });

  it.each([
    ['403', () => (fake.siteMyselfStatus = 403)],
    ['500', () => (fake.siteMyselfStatus = 500)],
    ['a transport failure', () => (fake.failNext = (c) => (c.url.startsWith('https://acme.atlassian.net/rest/') ? 'transport' : null))]
  ])('leaves tokenKind null for the process on %s from the site probe, asked once', async (_, arrange) => {
    arrange();
    await poller.tick();
    const s = poller.status();
    expect(s.tokenKind).toBeNull();
    expect(s.access).toBe('ok');
    expect(s.me).not.toBeNull();
    fake.failNext = null;
    fake.siteMyselfStatus = 200;
    now += 600_000;
    await poller.tick();
    expect(labels().filter((l) => l === 'site myself')).toHaveLength(1);
    expect(poller.status().tokenKind).toBeNull();
  });

  it('sends the site probe only after the gateway myself answered 200 — a bad token is not recorded as scoped (P2)', async () => {
    fake.siteMyselfStatus = 401;
    fake.failNext = (c) => (isGatewayMyself(c.url) ? { status: 401, body: { errorMessages: ['Client must be authenticated.'] } } : null);
    await poller.tick();
    expect(labels()).toEqual(['tenant_info', 'serverInfo', 'myself']);
    expect(poller.status().tokenKind).toBeNull();

    fake.failNext = null;
    now += JIRA_BACKOFF_MIN_MS;
    await poller.tick();
    expect(labels().slice(3)).toEqual(['myself', 'site myself', 'field']);
    expect(poller.status().tokenKind).toBe('scoped');
  });
});

describe('boot failures', () => {
  async function expectOwed(): Promise<void> {
    const s = poller.status();
    expect(s.me).toBeNull();
    expect(searches()).toEqual([]);
    expect(poller.armed).toBe(true);
  }

  beforeEach(() => writeConfig([board()]));

  it('tenant_info unreachable: unreachable with the error, and nothing else asked that tick (Review Focus 2)', async () => {
    fake.failNext = (c) => (c.url.endsWith('/_edge/tenant_info') ? 'transport' : null);
    await poller.tick();
    expect(labels()).toEqual(['tenant_info']);
    expect(poller.status()).toMatchObject({ access: 'unreachable', detail: 'fetch failed' });
    await expectOwed();
  });

  it('tenant_info 404 (a mistyped host): unreachable, Jira answered 404, retried on the back-off', async () => {
    fake.failNext = (c) => (c.url.endsWith('/_edge/tenant_info') ? { status: 404 } : null);
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'unreachable', detail: 'Jira answered 404' });
    await expectOwed();
    now += JIRA_BACKOFF_MIN_MS;
    await poller.tick();
    expect(labels()).toEqual(['tenant_info', 'tenant_info']);
  });

  it.each([
    ['deploymentType Server', () => (fake.deploymentType = 'Server')],
    ['a 404 on serverInfo', () => (fake.failNext = (c: { url: string }) => (c.url.endsWith('/serverInfo') ? { status: 404 } : null))]
  ])('%s: unsupported, final, and disarmed (P5)', async (_, arrange) => {
    arrange();
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'unsupported', detail: 'Jira Server/DC is not supported', me: null });
    expect(searches()).toEqual([]);
    expect(poller.armed).toBe(false);
    fake.calls.length = 0;
    fake.deploymentType = 'Cloud';
    fake.failNext = null;
    now += JIRA_BACKOFF_MAX_MS * 2;
    await poller.tick();
    poller.arm();
    expect(fake.calls).toEqual([]);
    expect(poller.armed).toBe(false);
  });

  it('myself 401: unauthorized with Jira’s message', async () => {
    fake.failNext = (c) => (isGatewayMyself(c.url) ? { status: 401, body: { errorMessages: ['Client must be authenticated.'] } } : null);
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'unauthorized', detail: 'Client must be authenticated.' });
    await expectOwed();
  });

  it('myself 403: forbidden', async () => {
    fake.failNext = (c) => (isGatewayMyself(c.url) ? { status: 403, body: { errorMessages: ['No.'] } } : null);
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'forbidden', detail: 'No.' });
    await expectOwed();
  });

  it('field 500: unreachable, Jira answered 500', async () => {
    fake.failNext = (c) => (c.url.endsWith('/field') ? { status: 500 } : null);
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'unreachable', detail: 'Jira answered 500' });
    await expectOwed();
  });
});

describe('back-off', () => {
  it('pins nextBackoff', () => {
    expect(nextBackoff(null)).toBe(15_000);
    expect(nextBackoff(15_000)).toBe(30_000);
    expect(nextBackoff(160_000)).toBe(300_000);
    expect(nextBackoff(300_000)).toBe(300_000);
  });

  it('JiraBootState: due when never asked or once the back-off has passed; a null access is unreachable', () => {
    const s = new JiraBootState();
    expect(s.due(T0)).toBe(true);
    s.fail(null, 'Jira answered 404', T0);
    expect(s).toMatchObject({ access: 'unreachable', detail: 'Jira answered 404', failedAt: T0, backoffMs: 15_000 });
    expect(s.due(T0 + 14_999)).toBe(false);
    expect(s.due(T0 + 15_000)).toBe(true);
  });

  it('waits 15 s, then doubles to a 5 min cap, and a success resets it', async () => {
    fake.failWith = 'transport';
    await poller.tick();
    expect(fake.calls).toHaveLength(1);

    now = T0 + 10_000;
    await poller.tick();
    expect(fake.calls).toHaveLength(1);
    now = T0 + 15_000;
    await poller.tick();
    expect(fake.calls).toHaveLength(2);

    let at = now;
    for (const gap of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const before = fake.calls.length;
      now = at + gap - 1;
      await poller.tick();
      expect(fake.calls).toHaveLength(before);
      now = at + gap;
      await poller.tick();
      expect(fake.calls).toHaveLength(before + 1);
      at = now;
    }

    // A success: the next tick past the back-off boots whole.
    fake.failWith = null;
    now = at + 300_000;
    fake.calls.length = 0;
    await poller.tick();
    expect(labels()).toEqual(BOOT);

    // ...and resets the back-off: a 401 on a later call waits 15 s again, not 5 min.
    writeConfig([board({ roots: ['PAY-1'] })]);
    fake.unauthorized = true;
    at = now;
    await poller.tick();
    expect(poller.status().access).toBe('unauthorized');
    fake.calls.length = 0;
    now = at + 14_999;
    await poller.tick();
    expect(fake.calls).toEqual([]);
    now = at + 15_000;
    await poller.tick();
    expect(labels()).toEqual(['myself']);
  });
});

describe('boards wait for boot', () => {
  it('searches nothing until every boot call has answered, then sweeps in that same tick', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })]);
    fake.failNext = (c) => (c.url.endsWith('/_edge/tenant_info') ? 'transport' : null);
    await poller.tick();
    expect(searches()).toEqual([]);
    expect(poller.boardIssues(B1)).toEqual({ issues: [], polledAt: null });

    fake.failNext = null;
    now += JIRA_BACKOFF_MIN_MS;
    await poller.tick();
    expect(labels().slice(1, 6)).toEqual(BOOT);
    expect(searches()[0]).toBe('key = "PAY-120"');
    expect(poller.boardIssues(B1)?.polledAt).toBe(iso(now));
  });
});

describe('whole-board versus per-entry failures', () => {
  beforeEach(async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] }), board({ id: B2, name: 'Ops', roots: ['PAY-131'] })]);
    await poller.tick();
    expect(keysOf()).toHaveLength(5);
    fake.calls.length = 0;
    now += 60_000;
  });

  it.each([
    ['a transport failure', 'transport' as const, 'fetch failed'],
    ['a 500', { status: 500 }, 'Jira answered 500']
  ])('%s keeps the last good list and polledAt, marks unreachable and ends the sweep', async (_, answer, detail) => {
    fake.failNext = (c) => (isSearch(c.url) ? answer : null);
    await poller.tick();
    expect(keysOf()).toHaveLength(5);
    expect(poller.boardIssues(B1)?.polledAt).toBe(iso(T0));
    expect(poller.status()).toMatchObject({ access: 'unreachable', detail });
    // The sweep ended at the first board: the second was not searched.
    expect(searches()).toEqual(['key = "PAY-120"']);

    // The next good sweep puts access back.
    fake.failNext = null;
    now += JIRA_POLL_MS;
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'ok', detail: null });
    expect(poller.boardIssues(B1)?.polledAt).toBe(iso(now));
  });

  it.each([400, 403, 404])('a %i on one root is that root’s failure; the rest proceeds and access is unchanged', async (status) => {
    writeConfig([board({ roots: ['PAY-131', 'PAY-120'] })]);
    fake.failNext = (c) =>
      isSearch(c.url) && (c.body as { jql: string }).jql === 'key = "PAY-131"' ? { status, body: { errorMessages: [`refused ${status}`] } } : null;
    await poller.tick();
    const s = poller.status();
    expect(s.access).toBe('ok');
    expect(s.boards[0].failures).toEqual([{ kind: 'root', id: 'PAY-131', message: `refused ${status}` }]);
    expect(keysOf()).toEqual(['PAY-120', 'PAY-131', 'PAY-134', 'PAY-132', 'PAY-133']);
    expect(s.boards[0].polledAt).toBe(iso(now));
  });
});

describe('a 401 on a later call', () => {
  it('resets me, reads unauthorized, keeps the list and restarts the boot retry', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    now += 60_000;
    fake.unauthorized = true;
    await poller.tick();
    const s = poller.status();
    expect(s).toMatchObject({ me: null, access: 'unauthorized', detail: 'Unauthorized' });
    expect(keysOf()).toHaveLength(5);
    expect(s.boards[0].polledAt).toBe(iso(T0));
    expect(poller.armed).toBe(true);

    fake.unauthorized = false;
    fake.calls.length = 0;
    now += JIRA_BACKOFF_MIN_MS;
    await poller.tick();
    // Only `myself` is re-asked (the token kind was decided once), then the board is swept again in the same tick.
    expect(labels()[0]).toBe('myself');
    expect(labels()).not.toContain('site myself');
    expect(poller.status()).toMatchObject({ access: 'ok', me: { accountId: 'acc-1', name: 'Ada Lovelace' } });
    expect(searches()[0]).toBe('key = "PAY-120"');
  });
});

describe('one root', () => {
  it('walks the root, its children and grandchildren — two rounds and no third', async () => {
    seedTree();
    const b = board({ roots: ['PAY-120'] });
    writeConfig([b]);
    await poller.tick();
    expect(keysOf()).toEqual(['PAY-120', 'PAY-131', 'PAY-134', 'PAY-132', 'PAY-133']);
    expect(searches()).toEqual(['key = "PAY-120"', 'parent in ("PAY-120")', 'parent in ("PAY-131", "PAY-134")']);
    for (const body of searchBodies()) {
      expect(body.fields).toEqual(SWEEP_FIELDS);
      expect(body.maxResults).toBe(100);
    }
    expect(poller.status().boards[0]).toEqual({ ...b, polledAt: iso(T0), count: 5, truncated: false, failures: [] });
  });
});

describe('a root Jira does not know', () => {
  beforeEach(() => seedTree());

  it('is a failure when Jira answers no issue, and the other root is walked (P3)', async () => {
    writeConfig([board({ roots: ['ZZZ-1', 'PAY-120'] })]);
    await poller.tick();
    expect(poller.status().boards[0].failures).toEqual([{ kind: 'root', id: 'ZZZ-1', message: 'Jira knows no issue ZZZ-1' }]);
    expect(keysOf()).toHaveLength(5);
  });

  it('carries Jira’s message when the root search answers 400', async () => {
    writeConfig([board({ roots: ['PAY-120'] })]);
    fake.failNext = (c) => (isSearch(c.url) ? { status: 400, body: { errorMessages: ["An issue with key 'PAY-120' does not exist."] } } : null);
    await poller.tick();
    expect(poller.status().boards[0].failures[0].message).toBe("An issue with key 'PAY-120' does not exist.");
  });

  it('is a failure when its walk hits 403, while the rest of the board proceeds and access stays ok', async () => {
    writeConfig([board({ roots: ['PAY-120', 'PAY-131'] })]);
    fake.failNext = (c) =>
      isSearch(c.url) && (c.body as { jql: string }).jql === 'parent in ("PAY-120")' ? { status: 403, body: { errorMessages: ['Not yours.'] } } : null;
    await poller.tick();
    const s = poller.status();
    expect(s.access).toBe('ok');
    expect(s.boards[0].failures).toEqual([{ kind: 'root', id: 'PAY-120', message: 'Not yours.' }]);
    expect(keysOf()).toEqual(expect.arrayContaining(['PAY-131', 'PAY-132', 'PAY-133']));
  });
});

describe('one query', () => {
  it('sends the JQL verbatim', async () => {
    seedTree();
    fake.answers.set('assignee = currentUser()', ['PAY-131', 'PAY-134']);
    writeConfig([board({ queries: [query('assignee = currentUser()')] })]);
    await poller.tick();
    expect(searchBodies()).toEqual([{ jql: 'assignee = currentUser()', fields: SWEEP_FIELDS, maxResults: 100 }]);
    expect(keysOf()).toEqual(['PAY-131', 'PAY-134']);
  });

  it('is a query failure when Jira refuses it with 400', async () => {
    writeConfig([board({ queries: [query('sprnt = 1')] })]);
    await poller.tick();
    expect(poller.status().boards[0].failures).toEqual([
      { kind: 'query', id: Q1, message: "Field 'sprnt' does not exist or you do not have permission to view it." }
    ]);
  });
});

describe('paging and the caps', () => {
  it('a query of 250 pages twice and keeps 200, silently', async () => {
    fake.answers.set('project = PAY', seedMany(250));
    writeConfig([board({ queries: [query('project = PAY')] })]);
    await poller.tick();
    const bodies = searchBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].nextPageToken).toBeUndefined();
    expect(bodies[1].nextPageToken).toBe('p1');
    expect(keysOf()).toHaveLength(200);
    expect(poller.status().boards[0].truncated).toBe(false);
  });

  it('a page claiming isLast: false with no token ends the walk at that page (Review Focus 3)', async () => {
    fake.answers.set('project = PAY', seedMany(150));
    fake.omitNextPageToken = true;
    writeConfig([board({ queries: [query('project = PAY')] })]);
    await poller.tick();
    expect(searchBodies()).toHaveLength(1);
    expect(keysOf()).toHaveLength(100);
    expect(poller.status().boards[0].truncated).toBe(false);
  });

  it('a root with 250 children keeps 200, the root counting as the first', async () => {
    fake.issues.set('PAY-1000', makeRawIssue({ key: 'PAY-1000' }));
    seedMany(250, 'PAY', 1, { parent: { key: 'PAY-1000', fields: { summary: 'root' } } });
    writeConfig([board({ roots: ['PAY-1000'] })]);
    await poller.tick();
    const keys = keysOf()!;
    expect(keys).toHaveLength(200);
    expect(keys[0]).toBe('PAY-1000');
    expect(keys[199]).toBe('PAY-199');
    expect(searches()).toEqual(['key = "PAY-1000"', 'parent in ("PAY-1000")', 'parent in ("PAY-1000")']);
    expect(poller.status().boards[0].truncated).toBe(false);
  });

  it('three queries of 200 cap the board at 500, in query order, truncated', async () => {
    fake.answers.set('q one', seedMany(200, 'AAA', 1));
    fake.answers.set('q two', seedMany(200, 'BBB', 1));
    fake.answers.set('q three', seedMany(200, 'CCC', 1));
    writeConfig([
      board({ queries: [query('q one', 'q_00000001', 'one'), query('q two', 'q_00000002', 'two'), query('q three', 'q_00000003', 'three')] })
    ]);
    await poller.tick();
    const keys = keysOf()!;
    expect(keys).toHaveLength(500);
    expect(keys[0]).toBe('AAA-1');
    expect(keys[200]).toBe('BBB-1');
    expect(keys[400]).toBe('CCC-1');
    expect(keys[499]).toBe('CCC-100');
    expect(poller.status().boards[0]).toMatchObject({ count: 500, truncated: true });
  });
});

describe('dedupe and order', () => {
  beforeEach(() => seedTree());

  it('a key from a query and from a root walk is one entry, at the query’s position', async () => {
    fake.answers.set('labels = x', ['PAY-131']);
    writeConfig([board({ roots: ['PAY-120'], queries: [query('labels = x')] })]);
    await poller.tick();
    expect(keysOf()).toEqual(['PAY-131', 'PAY-120', 'PAY-134', 'PAY-132', 'PAY-133']);
  });

  it('two roots sharing descendants list each key once', async () => {
    writeConfig([board({ roots: ['PAY-120', 'PAY-131'] })]);
    await poller.tick();
    expect(keysOf()).toEqual(['PAY-120', 'PAY-131', 'PAY-134', 'PAY-132', 'PAY-133']);
  });
});

describe('the Done window inside a walk', () => {
  const done = () => ({
    status: { name: 'Done', statusCategory: { key: 'done' } },
    resolutiondate: new Date(Date.now() - 15 * DAY).toISOString()
  });

  it('drops an expired child but still walks it — its live subtask is kept', async () => {
    seedTree();
    fake.issues.set('PAY-134', makeRawIssue({ key: 'PAY-134', fields: { ...done(), parent: { key: 'PAY-120', fields: { summary: 'x' } } } }));
    fake.issues.set('PAY-135', makeRawIssue({ key: 'PAY-135', fields: { parent: { key: 'PAY-134', fields: { summary: 'y' } } } }));
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    expect(keysOf()).not.toContain('PAY-134');
    expect(keysOf()).toContain('PAY-135');
    expect(searches()[2]).toBe('parent in ("PAY-131", "PAY-134")');
  });

  it('drops an expired ROOT without a failure, and walks from it', async () => {
    seedTree();
    fake.issues.set('PAY-120', makeRawIssue({ key: 'PAY-120', fields: done() }));
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    expect(keysOf()).toEqual(['PAY-131', 'PAY-134', 'PAY-132', 'PAY-133']);
    expect(poller.status().boards[0].failures).toEqual([]);
  });
});

describe('due intervals', () => {
  beforeEach(() => seedTree());

  it('a 1m board is not swept at +30 s and is at +60 s', async () => {
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    fake.calls.length = 0;
    now = T0 + 30_000;
    await poller.tick();
    expect(searches()).toEqual([]);
    now = T0 + 60_000;
    await poller.tick();
    expect(searches()[0]).toBe('key = "PAY-120"');
  });

  it('an off board gets one cold sweep and never another, and disarms', async () => {
    writeConfig([board({ roots: ['PAY-120'], interval: 'off' })]);
    await poller.tick();
    expect(poller.boardIssues(B1)?.polledAt).toBe(iso(T0));
    expect(poller.armed).toBe(false);
    fake.calls.length = 0;
    now = T0 + DAY;
    await poller.tick();
    expect(fake.calls).toEqual([]);
  });

  it('an off board whose cold sweep failed whole-board stays owed until one succeeds', async () => {
    writeConfig([board({ roots: ['PAY-120'], interval: 'off' })]);
    fake.failNext = (c) => (isSearch(c.url) ? 'transport' : null);
    await poller.tick();
    expect(poller.armed).toBe(true);
    expect(poller.boardIssues(B1)?.polledAt).toBeNull();

    fake.failNext = null;
    fake.calls.length = 0;
    now += JIRA_POLL_MS;
    await poller.tick();
    expect(searches()[0]).toBe('key = "PAY-120"');
    expect(poller.boardIssues(B1)?.polledAt).toBe(iso(now));
    expect(poller.armed).toBe(false);
  });

  it('a cold sweep with only per-entry failures has succeeded', async () => {
    writeConfig([board({ roots: ['ZZZ-1'], interval: 'off' })]);
    await poller.tick();
    expect(poller.boardIssues(B1)?.polledAt).toBe(iso(T0));
    expect(poller.status().boards[0].failures).toHaveLength(1);
    expect(poller.armed).toBe(false);
  });

  it('1m and 5m boards: at +60 s only the first is re-swept', async () => {
    writeConfig([board({ roots: ['PAY-120'] }), board({ id: B2, name: 'Slow', roots: ['PAY-131'], interval: '5m' })]);
    await poller.tick();
    fake.calls.length = 0;
    now = T0 + 60_000;
    await poller.tick();
    expect(searches()[0]).toBe('key = "PAY-120"');
    expect(searches()).not.toContain('key = "PAY-131"');
    expect(poller.boardIssues(B2)?.polledAt).toBe(iso(T0));
  });
});

describe('armed', () => {
  it('is true after a tick with a 1m board', async () => {
    writeConfig([board()]);
    await poller.tick();
    expect(poller.armed).toBe(true);
  });

  it('is false with only an off board once boot has answered', async () => {
    writeConfig([board({ interval: 'off' })]);
    await poller.tick();
    expect(poller.armed).toBe(false);
  });

  it('is true while boot is unanswered, whatever the boards', async () => {
    writeConfig([board({ interval: 'off' })]);
    fake.failWith = 'transport';
    await poller.tick();
    expect(poller.armed).toBe(true);
  });

  it('arm() starts the chain when something is owed', async () => {
    poller.arm();
    await poller.tick();
    expect(labels()).toEqual(BOOT);
  });
});

describe('429', () => {
  beforeEach(async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    now = T0 + 60_000;
  });

  it('keeps the list, reads rate-limited, refuses every call inside the window, and recovers at its end', async () => {
    fake.rateLimit = { retryAfter: 30 };
    await poller.tick();
    const until = iso(T0 + 90_000);
    const s = poller.status();
    expect(s.access).toBe('rate-limited');
    expect(s.detail).toContain(until);
    expect(s.calls.last429At).toBe(iso(T0 + 60_000));
    expect(keysOf()).toHaveLength(5);
    expect(s.boards[0].polledAt).toBe(iso(T0));

    fake.rateLimit = null;
    fake.calls.length = 0;
    now = T0 + 70_000;
    await poller.tick();
    expect(fake.calls).toEqual([]);
    expect(poller.armed).toBe(true);

    now = T0 + 90_000;
    await poller.tick();
    expect(searches()[0]).toBe('key = "PAY-120"');
    expect(poller.status()).toMatchObject({ access: 'ok', detail: null });
    expect(poller.boardIssues(B1)?.polledAt).toBe(iso(now));
  });

  it('without Retry-After the window is JIRA_RATE_LIMIT_DEFAULT_MS', async () => {
    fake.rateLimit = { retryAfter: null };
    await poller.tick();
    fake.rateLimit = null;
    fake.calls.length = 0;
    now = T0 + 60_000 + JIRA_RATE_LIMIT_DEFAULT_MS - 1;
    await poller.tick();
    expect(fake.calls).toEqual([]);
    now = T0 + 60_000 + JIRA_RATE_LIMIT_DEFAULT_MS;
    await poller.tick();
    expect(searches()).not.toEqual([]);
  });
});

describe('an unreadable config', () => {
  it('is reported, its boards are none, and boot still runs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(file, '{not json');
    await poller.tick();
    expect(warn).toHaveBeenCalled();
    expect(labels()).toEqual(BOOT);
    expect(poller.status()).toMatchObject({ configUnreadable: 'does not parse as JSON', boards: [] });
  });
});

describe('boardIssues and boardsHolding', () => {
  it('answers null for an unknown board, empty before a sweep, the cache after', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })]);
    expect(poller.boardIssues('b_ffffffff')).toBeNull();
    expect(poller.boardIssues(B1)).toEqual({ issues: [], polledAt: null });
    expect(poller.boardsHolding('PAY-131')).toEqual([]);
    await poller.tick();
    expect(poller.boardIssues(B1)).toEqual({ issues: expect.any(Array), polledAt: iso(T0) });
    expect(keysOf()).toHaveLength(5);
  });

  it('boardsHolding names every board whose cache holds the key', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] }), board({ id: B2, name: 'Ops', roots: ['PAY-131'] })]);
    await poller.tick();
    expect(poller.boardsHolding('PAY-131')).toEqual([B1, B2]);
    expect(poller.boardsHolding('PAY-134')).toEqual([B1]);
    expect(poller.boardsHolding('ZZZ-9')).toEqual([]);
  });
});

describe('projects in status()', () => {
  it('is the union of cached and mapped project keys, sorted, with no outbound call', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })], { OPS: ['/repo/ops'], PAY: ['/repo/pay'] });
    await poller.tick();
    const before = fake.calls.length;
    expect(poller.status().projects).toEqual([
      { key: 'OPS', name: 'OPS' },
      { key: 'PAY', name: 'PAY project' }
    ]);
    expect(fake.calls).toHaveLength(before);
  });
});

describe('issueDetail', () => {
  const description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Refund the rest.' }] }] };

  beforeEach(() => {
    seedTree();
    const old = { status: { name: 'Done', statusCategory: { key: 'done' } }, resolutiondate: new Date(T0 - 30 * DAY).toISOString() };
    fake.issues.set('PAY-131', makeRawIssue({ key: 'PAY-131', fields: { ...old, description, parent: { key: 'PAY-120', fields: { summary: 'Epic' } } } }));
    fake.issues.set('PAY-133', makeRawIssue({ key: 'PAY-133', fields: { ...old, parent: { key: 'PAY-131', fields: { summary: 'x' } } } }));
    fake.transitions.set('PAY-131', [{ id: '21', name: 'Reopen', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }]);
  });

  it('reads the issue, its children and its transitions, window off', async () => {
    writeConfig([board({ roots: ['PAY-120'] })]);
    await booted();
    const r = await poller.issueDetail('PAY-131');
    expect(labels()).toEqual(['issue/PAY-131', 'search parent in ("PAY-131")', 'issue/PAY-131/transitions']);
    expect(new URL(fake.calls[0].url).searchParams.get('fields')!.split(',')).toEqual([...SWEEP_FIELDS, 'description']);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value).toMatchObject({
      key: 'PAY-131',
      status: { name: 'Done', category: 'done' },
      description: 'Refund the rest.',
      transitions: [{ id: '21', name: 'Reopen', to: { name: 'In Progress', category: 'indeterminate' } }],
      session: null
    });
    expect(r.value.children.map((c) => c.key)).toEqual(['PAY-132', 'PAY-133']);
    // The board's cache does not hold the expired PAY-131 (the sweep drops it); a detail read is not the sweep.
    expect(r.value.boards).toEqual([]);
  });

  it('names the boards holding the key, and renders a null description as empty (Review Focus 5)', async () => {
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    fake.calls.length = 0;
    const r = await poller.issueDetail('PAY-134');
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.description).toBe('');
    expect(r.value.boards).toEqual([B1]);
    expect(r.value.children).toEqual([]);
    expect(r.value.transitions).toEqual([]);
  });

  it('a key on no board answers with boards: [] (Review Focus 5)', async () => {
    await booted();
    const r = await poller.issueDetail('PAY-132');
    expect(r.ok && r.value.boards).toEqual([]);
  });

  it('a 404 and a transport failure are failures that leave access alone', async () => {
    await booted();
    const missing = await poller.issueDetail('PAY-999');
    expect(missing).toMatchObject({ ok: false, response: { status: 404 } });
    fake.failWith = 'transport';
    const down = await poller.issueDetail('PAY-131');
    expect(down).toMatchObject({ ok: false, response: { status: 0 } });
    fake.failWith = 403;
    expect(await poller.issueDetail('PAY-131')).toMatchObject({ ok: false, response: { status: 403 } });
    expect(poller.status().access).toBe('ok');
  });

  it('fails whole when the children search or the transitions read fails (P4)', async () => {
    await booted();
    fake.failNext = (c) => (isSearch(c.url) ? { status: 500 } : null);
    expect(await poller.issueDetail('PAY-131')).toMatchObject({ ok: false, response: { status: 500 } });
    fake.failNext = (c) => (c.url.endsWith('/transitions') ? { status: 403, body: { errorMessages: ['No.'] } } : null);
    expect(await poller.issueDetail('PAY-131')).toMatchObject({ ok: false, response: { status: 403, message: 'No.' } });
  });

  it('a 401 resets me, reads unauthorized and restarts the boot retry', async () => {
    await booted();
    expect(poller.armed).toBe(false);
    fake.unauthorized = true;
    expect(await poller.issueDetail('PAY-131')).toMatchObject({ ok: false, response: { status: 401 } });
    expect(poller.status()).toMatchObject({ me: null, access: 'unauthorized' });
    expect(poller.armed).toBe(true);
  });

  it('a 429 opens the window; a read inside it is refused with the stored instant and no call (P1)', async () => {
    await booted();
    fake.rateLimit = { retryAfter: 30 };
    const first = await poller.issueDetail('PAY-131');
    const until = iso(T0 + 30_000);
    expect(first).toMatchObject({ ok: false, response: { status: 429 }, retryAt: until });
    expect(poller.status()).toMatchObject({ access: 'rate-limited', calls: { last429At: iso(T0) } });
    fake.calls.length = 0;
    now += 5_000;
    const second = await poller.issueDetail('PAY-131');
    expect(second).toMatchObject({ ok: false, response: { status: 429 }, retryAt: until });
    expect(fake.calls).toEqual([]);
  });

  it('before boot has a cloudId: no call, the boot state’s answer (P3)', async () => {
    expect(await poller.issueDetail('PAY-131')).toMatchObject({ ok: false, response: { status: 0, message: 'connecting' } });
    fake.failNext = (c) => (c.url.endsWith('/_edge/tenant_info') ? 'transport' : null);
    await poller.tick();
    fake.calls.length = 0;
    expect(await poller.issueDetail('PAY-131')).toMatchObject({ ok: false, response: { status: 0, message: 'fetch failed' } });
    expect(await poller.search('PAY-131')).toMatchObject({ ok: false, response: { status: 0 } });
    expect(await poller.projects()).toMatchObject({ ok: false, response: { status: 0 } });
    expect(await poller.checkJql('x = 1')).toMatchObject({ ok: false, response: { status: 0 } });
    expect(fake.calls).toEqual([]);
  });

  it('before boot has a cloudId, a 401 boot state answers the 401 (P3)', async () => {
    fake.failNext = (c) => (c.url.endsWith('/_edge/tenant_info') ? { status: 401 } : null);
    await poller.tick();
    fake.calls.length = 0;
    expect(await poller.issueDetail('PAY-131')).toMatchObject({ ok: false, response: { status: 401 } });
    expect(fake.calls).toEqual([]);
  });
});

describe('search', () => {
  beforeEach(async () => {
    seedTree();
    await booted();
  });

  it('a key is an exact key search, upper-cased, 20 at most', async () => {
    const r = await poller.search('pay-131');
    expect(searchBodies()).toEqual([{ jql: 'key = "PAY-131"', fields: SWEEP_FIELDS, maxResults: 20 }]);
    expect(r.ok && r.value.map((i) => i.key)).toEqual(['PAY-131']);
  });

  it('anything else is a summary prefix search with " and \\ escaped', async () => {
    fake.answers.set('summary ~ "refund \\"x\\"*"', ['PAY-131']);
    await poller.search('refund "x"');
    expect(searches()).toEqual(['summary ~ "refund \\"x\\"*"']);
  });

  it('blank is [] with no call', async () => {
    expect(await poller.search('   ')).toEqual({ ok: true, value: [] });
    expect(fake.calls).toEqual([]);
  });

  it('a 400 is a failure', async () => {
    fake.failNext = () => ({ status: 400, body: { errorMessages: ['bad'] } });
    expect(await poller.search('refund')).toMatchObject({ ok: false, response: { status: 400 } });
  });

  it('maps with the window off', async () => {
    fake.issues.set(
      'PAY-131',
      makeRawIssue({ key: 'PAY-131', fields: { status: { name: 'Done', statusCategory: { key: 'done' } }, resolutiondate: iso(T0 - 60 * DAY) } })
    );
    const r = await poller.search('PAY-131');
    expect(r.ok && r.value.map((i) => i.key)).toEqual(['PAY-131']);
  });
});

describe('projects()', () => {
  it('pages by startAt and answers the union sorted by key (P13)', async () => {
    fake.projects = Array.from({ length: 70 }, (_, i) => ({ key: `P${String(69 - i).padStart(2, '0')}X`, name: `Project ${i}` }));
    await booted();
    const r = await poller.projects();
    expect(fake.calls.map((c) => new URL(c.url).searchParams.get('startAt'))).toEqual(['0', '50']);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value).toHaveLength(70);
    expect(r.value[0].key).toBe('P00X');
    expect(r.value[69].key).toBe('P69X');
  });
});

describe('checkJql', () => {
  beforeEach(async () => {
    fake.counts.set('assignee = currentUser()', 875);
    fake.parseErrors.set('sprnt = 1', ["Field 'sprnt' does not exist or you do not have permission to view it."]);
    await booted();
  });

  it('a good query is its count', async () => {
    expect(await poller.checkJql('assignee = currentUser()')).toEqual({ ok: true, value: { ok: true, count: 875 } });
  });

  it('a parse error is the message, with no count call', async () => {
    expect(await poller.checkJql('sprnt = 1')).toEqual({
      ok: true,
      value: { ok: false, message: "Field 'sprnt' does not exist or you do not have permission to view it." }
    });
    expect(labels()).toEqual(['jql/parse']);
  });

  it('an unbounded query passes parse and is refused by the count (P8)', async () => {
    expect(await poller.checkJql('order by updated desc')).toEqual({
      ok: true,
      value: { ok: false, message: 'Unbounded JQL queries are not allowed here. Please add a search restriction to your query.' }
    });
  });
});

describe('route verdicts against the sweep (review round 1)', () => {
  const jqlOf = (c: { body: unknown }) => (c.body as { jql: string }).jql;

  it('a route 429 met while a sweep awaits is not cleared by that sweep (I1)', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    now = T0 + 60_000;
    let route: Promise<unknown> | null = null;
    fake.failNext = (c) => {
      if (!isSearch(c.url)) return null;
      if (jqlOf(c).startsWith('summary ~')) return { status: 429 };
      if (route === null) route = poller.search('refund');
      return null;
    };
    await poller.tick();
    await route;
    expect(poller.status()).toMatchObject({
      access: 'rate-limited',
      detail: `Jira rate limit — retry after ${iso(T0 + 60_000 + JIRA_RATE_LIMIT_DEFAULT_MS)}`
    });
  });

  it('a route 401 met while a sweep awaits is not cleared by that sweep (I1)', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    now = T0 + 60_000;
    let route: Promise<unknown> | null = null;
    fake.failNext = (c) => {
      if (c.url.includes('/issue/PAY-131')) return { status: 401 };
      if (isSearch(c.url) && route === null) route = poller.issueDetail('PAY-131');
      return null;
    };
    await poller.tick();
    await route;
    expect(poller.status()).toMatchObject({ access: 'unauthorized', me: null });
    expect(poller.armed).toBe(true);
  });

  it('a route 401 met while the boot awaits leaves the boot unanswered (I1)', async () => {
    let route: Promise<unknown> | null = null;
    fake.failNext = (c) => {
      if (c.url.includes('/issue/')) return { status: 401 };
      if (c.url.endsWith('/field') && route === null) route = poller.issueDetail('PAY-131');
      return null;
    };
    await poller.tick();
    await route;
    expect(poller.status()).toMatchObject({ access: 'unauthorized', me: null });
    expect(poller.armed).toBe(true);
    fake.failNext = null;
    fake.calls.length = 0;
    now += JIRA_BACKOFF_MIN_MS;
    await poller.tick();
    expect(labels()).toEqual(['myself']);
    expect(poller.status()).toMatchObject({ access: 'ok', me: { accountId: 'acc-1', name: 'Ada Lovelace' } });
  });

  it('a route 429 on a disarmed poller lapses on its own at the window end (I2)', async () => {
    await booted();
    fake.rateLimit = { retryAfter: 30 };
    expect(await poller.checkJql('assignee = currentUser()')).toMatchObject({ ok: false, response: { status: 429 } });
    expect(poller.armed).toBe(false);
    expect(poller.status().access).toBe('rate-limited');
    fake.rateLimit = null;
    now = T0 + 29_999;
    expect(poller.status().access).toBe('rate-limited');
    now = T0 + 30_000;
    expect(poller.status()).toMatchObject({ access: 'ok', detail: null });
    fake.counts.set('assignee = currentUser()', 875);
    expect(await poller.checkJql('assignee = currentUser()')).toEqual({ ok: true, value: { ok: true, count: 875 } });
  });

  it('a board saved and arm()ed while a sweep is in flight is owed when it ends (I3)', async () => {
    seedTree();
    const cold = board({ roots: ['PAY-120'], interval: 'off' });
    const added = board({ id: B2, name: 'Ops', roots: ['PAY-131'], interval: '1m' });
    writeConfig([cold]);
    let wrote = false;
    fake.failNext = (c) => {
      if (isSearch(c.url) && !wrote) {
        wrote = true;
        writeConfig([cold, added]);
        poller.arm();
      }
      return null;
    };
    await poller.tick();
    expect(poller.armed).toBe(true);
    // Due-ness was judged on the file as read at the top of that sweep: the new board waits for the next tick.
    expect(poller.boardIssues(B2)).toEqual({ issues: [], polledAt: null });
    now += JIRA_POLL_MS;
    await poller.tick();
    expect(poller.boardIssues(B2)?.polledAt).toBe(iso(now));
  });

  it('a serverInfo 2xx with no deploymentType is retried, not final (M1)', async () => {
    fake.deploymentType = undefined as unknown as string;
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'unreachable', detail: 'serverInfo carried no deploymentType' });
    expect(poller.armed).toBe(true);
    fake.deploymentType = 'Cloud';
    now += JIRA_BACKOFF_MIN_MS;
    await poller.tick();
    expect(poller.status()).toMatchObject({ access: 'ok', detail: null });
  });

  it('repeated route 401s restart the boot retry once, not compound its back-off (M3)', async () => {
    await booted();
    fake.unauthorized = true;
    await poller.issueDetail('PAY-131');
    await poller.issueDetail('PAY-131');
    fake.unauthorized = false;
    fake.calls.length = 0;
    now += JIRA_BACKOFF_MIN_MS;
    await poller.tick();
    expect(labels()).toEqual(['myself']);
  });
});

describe('the token', () => {
  it('appears in no status payload', async () => {
    seedTree();
    writeConfig([board({ roots: ['PAY-120'] })]);
    await poller.tick();
    const text = JSON.stringify(poller.status());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
  });

  // Last on purpose: it reads the call log of every case above.
  it('appears, over the whole suite, only in authorization headers', () => {
    const pair = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
    expect(suiteCalls.length).toBeGreaterThan(100);
    const secrets = [TOKEN, EMAIL, pair];
    const leaks = (text: string) => secrets.filter((secret) => text.includes(secret));
    let carried = 0;
    for (const c of suiteCalls) {
      expect(leaks(c.url)).toEqual([]);
      expect(leaks(JSON.stringify(c.body ?? null))).toEqual([]);
      for (const [name, value] of Object.entries(c.headers)) {
        if (name === 'authorization') {
          expect(value).toBe(`Basic ${pair}`);
          carried += 1;
        } else {
          expect(leaks(value)).toEqual([]);
        }
      }
    }
    expect(carried).toBeGreaterThan(0);
  });
});
