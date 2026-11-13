import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { JiraLiveReconciler } from '../../server/src/agents/jira-live.service';
import { AppModule } from '../../server/src/app.module';
import { GitlabPollerService } from '../../server/src/gitlab/poller.service';
import { JiraClient } from '../../server/src/jira/jira.client';
import { JIRA_LIVE_CAP, JiraLiveService } from '../../server/src/jira/live.service';
import { JiraPollerService } from '../../server/src/jira/poller.service';
import * as refsUtil from '../../server/src/jira/refs.util';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { DEFAULT_MODEL } from '../../shared/agent';
import type { DashboardRow, GitlabMr, GitlabReview, JiraRefBranch, JiraRepoRefs, JiraStatusPayload } from '../../shared/types';
import { listenLoopback } from '../helpers/app';
import { FakeJira, makeRawIssue, RUN_META } from '../helpers/jira';
import type { FailNext } from '../helpers/jira';
import { makeRegistry } from '../helpers/store';

/**
 * `POST /api/agents/dispatch-jira` (Jira phase 5, Task 5; spec §5, §7 and §8) — the launch sheet's Start: optional assign and transition on Jira, then one
 * dashboard spawn with the composed prompt, behind an in-memory reservation so two Starts on one key yield one session.
 *
 * Two fakes, one per side of the route: `FakeJira` inside a real `JiraClient` (the poller's every call, and its write log), and the dashboard stub
 * `agents-dispatch.test.ts` uses on `global.fetch` (health, the project list, `/api/spawn`). They never see each other's traffic, so "no Jira write" and "no
 * spawn" are two independent readings. A fresh app per case: the live map, the poller's boot and the fake's state are all per-process memory, and a key a
 * previous case reserved would turn every later case into the 409.
 */

const REPO = '/work/pay';
const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE', 'BM_AGENTS', 'BM_AGENTS_URL', 'BM_AGENTS_TOKEN', 'BM_ORCH_HOME'] as const;
const SKILL = { id: 's_0123abcd', name: 'Review it', prompt: 'Review {key} in {repo}, then stop.' };
const START = { id: '31', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } };
// `execute` needs a branch (spec §5.3): a new one, cut from `develop`. `/work/pay` is no directory, so the refs read finds it `available: false` and makes no
// refusal — the cases that want refs stub `readRepoRefs`.
const BODY = {
  key: 'PAY-1',
  repo: REPO,
  action: 'execute',
  assign: true,
  transitionId: '31',
  mode: 'new',
  branch: 'pay-1-export',
  base: 'develop',
  permissionMode: 'acceptEdits',
  remoteControl: false
};
/** The choice for an action that may work in the mapped checkout: `context` and skills, whose prompt carries no workspace block. */
const NONE = { mode: 'none', branch: undefined, base: undefined } as const;

let saved: Record<string, string | undefined>;
let dir: string;
let fake: FakeJira;
let app: INestApplication;
let live: JiraLiveService;
const realFetch = global.fetch;

interface Dashboard {
  spawn?: { ok?: boolean; status?: number; body?: unknown };
  healthDown?: boolean;
  projectPaths?: string[];
  /** The health answer says `desktopAvailable: true` — a Mac whose dashboard can hand a launch to the desktop app. */
  desktop?: boolean;
  /**
   * The FIRST spawn answers only once this settles; later spawns answer at once. A race case needs the first dispatch held mid-spawn — its key reserved, its
   * branch held, no link yet — while a second one runs every gate, and a second spawn that would hang on the same gate would turn a red case into a timeout.
   */
  firstSpawnGate?: Promise<void>;
}

/** What the dashboard stub saw: every URL, the spawn bodies, and the Jira write log as it stood at the moment each spawn arrived. */
interface Sent {
  urls: string[];
  spawns: Record<string, unknown>[];
  writesAtSpawn: string[][];
}

/** The two Jira writes, as `METHOD path`, in the order they reached the fake. Reads are left out: a refusal is allowed to READ the issue, never to write it. */
const writes = (): string[] =>
  fake.calls
    .filter((c) => c.method === 'PUT' || (c.method === 'POST' && c.url.endsWith('/transitions')))
    .map((c) => `${c.method} ${new URL(c.url).pathname.replace(/^.*\/rest\/api\/3/, '')}`);

function stubDashboard(opts: Dashboard = {}): Sent {
  const sent: Sent = { urls: [], spawns: [], writesAtSpawn: [] };
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.urls.push(url);
    if (url.endsWith('/api/spawn')) {
      sent.spawns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      sent.writesAtSpawn.push(writes());
      const ok = opts.spawn?.ok ?? true;
      const answer = {
        ok,
        status: opts.spawn?.status ?? (ok ? 200 : 500),
        json: () => Promise.resolve(opts.spawn?.body ?? { sessionId: 'sess-1' })
      } as Response;
      return opts.firstSpawnGate !== undefined && sent.spawns.length === 1 ? opts.firstSpawnGate.then(() => answer) : Promise.resolve(answer);
    }
    if (url.endsWith('/api/health') && opts.healthDown) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.endsWith('/api/configs')
            ? { projects: (opts.projectPaths ?? [REPO]).map((path, i) => ({ dirName: `-dir-${i}`, name: `p${i}`, path, lastActiveMs: 1 })) }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits', ...(opts.desktop ? { desktopAvailable: true } : {}) }
        )
    } as Response);
  }) as jest.Mock;
  return sent;
}

function writeConfig(over: Record<string, unknown> = {}): void {
  writeFileSync(process.env.BM_JIRA_FILE!, JSON.stringify({ repos: { PAY: [REPO] }, skills: [SKILL], ...over }));
}

/** A fresh app on a fresh fake, booted. `failNext` is in force for the boot, which is how a case gets a poller with no identity. */
async function build(opts: { failNext?: FailNext } = {}): Promise<void> {
  fake = new FakeJira();
  fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1' }));
  fake.transitions.set('PAY-1', [START]);
  fake.failNext = opts.failNext ?? null;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry([]))
    .overrideProvider(JiraClient)
    .useValue(new JiraClient(fake.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  await app.get(JiraPollerService).tick();
  fake.failNext = null;
  live = app.get(JiraLiveService);
}

const post = (body: unknown) =>
  request(app.getHttpServer()).post('/api/agents/dispatch-jira').set('content-type', 'application/json').send(JSON.stringify(body));

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'bm-dispatch-jira-'));
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.BM_JIRA_SITE = 'acme.atlassian.net';
  process.env.BM_JIRA_EMAIL = 'ada@example.com';
  process.env.BM_JIRA_TOKEN = 't0k3n-SECRET';
  process.env.BM_JIRA_FILE = join(dir, `jira-${Math.random().toString(16).slice(2)}.json`);
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env.BM_AGENTS_TOKEN = 's3cret';
  // A fresh, empty orchestrator home, for the reason agents-dispatch.test.ts gives: the app boots the watchdog, which must not read a real run.
  process.env.BM_ORCH_HOME = join(dir, 'orchestrator');
  writeConfig();
});

afterEach(async () => {
  await app?.close();
  global.fetch = realFetch;
});

describe('refusals before the reservation — no Jira write, no spawn, nothing reserved', () => {
  let sent: Sent;
  let callsAtStart: number;

  beforeEach(async () => {
    await build();
    sent = stubDashboard();
    callsAtStart = fake.calls.length;
  });

  /** Steps 1–4 make no Jira call at all; the key's project is its prefix, so nothing needs reading to refuse. */
  function untouched(): void {
    expect(fake.calls.length).toBe(callsAtStart);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
  }

  it.each([
    ['a lower-case key', { key: 'pay-1' }, 'invalid issue key'],
    ['no key', { key: undefined }, 'invalid issue key'],
    ['an unknown action', { action: 'nope' }, 'action must be execute, context, review or { skill: <id> }'],
    ['the query spelling of a skill', { action: 'skill:s_0123abcd' }, 'action must be execute, context, review or { skill: <id> }'],
    ['a blank repo', { repo: '  ' }, 'repo is required'],
    ['a string assign', { assign: 'yes' }, 'assign must be true or false'],
    ['a numeric transitionId', { transitionId: 31 }, 'transitionId must be null or a non-empty string'],
    ['an empty transitionId', { transitionId: '' }, 'transitionId must be null or a non-empty string'],
    ['a 65-character transitionId', { transitionId: '1'.repeat(65) }, 'transitionId must be null or a non-empty string'],
    ['no mode', { mode: undefined }, 'mode must be new, continue or none'],
    ['an unknown mode', { mode: 'old' }, 'mode must be new, continue or none'],
    ['none for execute', { ...NONE }, 'execute needs a branch (mode new or continue)'],
    ['a new branch with no base', { base: undefined }, 'base is required for a new branch'],
    ['a new branch that does not carry the key', { branch: 'export' }, 'branch must carry PAY-1'],
    ['a base with continue', { mode: 'continue' }, 'base is only for a new branch'],
    ['an MR for context', { action: 'context', openMr: true }, 'openMr is only for execute with a branch'],
    ['an unknown surface', { surface: 'terminal' }, 'surface must be dashboard or desktop'],
    ['a numeric prompt', { prompt: 42 }, 'prompt must be a non-empty string'],
    ['a blank prompt', { prompt: ' \n ' }, 'prompt must be a non-empty string'],
    ['a prompt over the 4 000 cap', { prompt: 'x'.repeat(4001) }, 'prompt too long']
  ])('400 for %s', async (_label, over, error) => {
    expect((await post({ ...BODY, ...over }).expect(400)).body).toEqual({ error });
    untouched();
  });

  it('a 64-character transitionId passes the shape check (and is then refused as not offered, after the reservation)', async () => {
    expect((await post({ ...BODY, transitionId: '1'.repeat(64) }).expect(400)).body).toEqual({ error: 'transition not offered' });
    expect(writes()).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
  });

  it('403 for a cross-origin POST — the guard every agents POST carries', async () => {
    await post(BODY).set('origin', 'http://evil.example').expect(403);
    untouched();
  });

  it('503 while Jira is unconfigured, after the shape check — the branch choice\'s included', async () => {
    process.env.BM_JIRA_TOKEN = '';
    expect((await post(BODY).expect(503)).body).toEqual({ error: 'Jira is not configured' });
    expect((await post({ ...BODY, key: 'nope' }).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect((await post({ ...BODY, mode: undefined }).expect(400)).body).toEqual({ error: 'mode must be new, continue or none' });
    untouched();
  });

  it('409 when jira.json cannot be read, ahead of an unknown skill', async () => {
    writeFileSync(process.env.BM_JIRA_FILE!, '{ not json');
    const res = await post({ ...BODY, ...NONE, action: { skill: 's_ffffffff' } }).expect(409);
    expect(res.body.error).toMatch(/jira\.json does not parse as JSON — fix or delete it by hand/);
    untouched();
  });

  it('400 unknown skill <id> for a skill deleted while the sheet was open (Review Focus 3), nothing reserved', async () => {
    expect((await post({ ...BODY, ...NONE, action: { skill: 's_ffffffff' } }).expect(400)).body).toEqual({ error: 'unknown skill s_ffffffff' });
    untouched();
  });

  it("400 <repo> is not mapped to <PROJECT>, the project being the key's prefix, the repo quoted as sent", async () => {
    expect((await post({ ...BODY, repo: '/elsewhere' }).expect(400)).body).toEqual({ error: '/elsewhere is not mapped to PAY' });
    expect((await post({ ...BODY, key: 'ZED-1', branch: 'zed-1-export' }).expect(400)).body).toEqual({ error: `${REPO} is not mapped to ZED` });
    untouched();
  });

  it('409 with the gate reason when the dashboard does not list the repo', async () => {
    sent = stubDashboard({ projectPaths: ['/somewhere/else'] });
    const res = await post(BODY).expect(409);
    expect(res.body.error).toBe(`the dashboard does not list ${REPO} — most likely no Claude session there inside its LOOKBACK_HOURS`);
    untouched();
  });

  it('409 when dispatch is off', async () => {
    process.env.BM_AGENTS = 'off';
    expect((await post(BODY).expect(409)).body).toEqual({ error: 'dispatch is off — set BM_AGENTS=on for the API' });
    untouched();
  });

  it('502 when dispatch is on and the dashboard is unreachable', async () => {
    sent = stubDashboard({ healthDown: true });
    const res = await post(BODY).expect(502);
    expect(res.body.error).toMatch(/^dashboard unreachable/);
    untouched();
  });

  it('409 <KEY> is starting for a reserved key, and the other request\'s reservation is left alone', async () => {
    live.reserve('PAY-1', REPO);
    expect((await post(BODY).expect(409)).body).toEqual({ error: 'PAY-1 is starting' });
    expect(fake.calls.length).toBe(callsAtStart);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toMatchObject({ sessionId: null, repo: REPO });
  });

  it('409 <KEY> already has a session for a confirmed key', async () => {
    live.reserve('PAY-1', REPO);
    live.confirm('PAY-1', 'sess-old', RUN_META);
    expect((await post(BODY).expect(409)).body).toEqual({ error: 'PAY-1 already has a session' });
    expect(fake.calls.length).toBe(callsAtStart);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toMatchObject({ sessionId: 'sess-old' });
  });

  it('409 too many Jira sessions are starting when the map is full of starting entries', async () => {
    for (let i = 0; i < JIRA_LIVE_CAP; i++) expect(live.reserve(`OPS-${i}`, REPO)).toBe(true);
    expect((await post(BODY).expect(409)).body).toEqual({ error: 'too many Jira sessions are starting — try again in a moment' });
    untouched();
  });
});

describe('refusals after the reservation — released, so a retry is not a 409', () => {
  it('503 no identity when assign is asked and the poller has no `me`; a retry without assign starts', async () => {
    await build({ failNext: (call) => (call.url.endsWith('/rest/api/3/myself') && call.url.includes('api.atlassian.com') ? { status: 500 } : null) });
    const sent = stubDashboard();
    expect((await post(BODY).expect(503)).body).toEqual({ error: 'no identity' });
    expect(writes()).toEqual([]);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
    await post({ ...BODY, assign: false }).expect(200);
    expect(sent.spawns).toHaveLength(1);
  });

  it('400 transition not offered (gone between open and Start, Review Focus 5) before any write, the assign included; a retry starts', async () => {
    await build();
    const sent = stubDashboard();
    expect((await post({ ...BODY, transitionId: '99' }).expect(400)).body).toEqual({ error: 'transition not offered' });
    expect(writes()).toEqual([]);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
    await post(BODY).expect(200);
  });

  it('a failed issue read keeps its §8 mapping, writes nothing and releases the key', async () => {
    await build();
    const sent = stubDashboard();
    fake.issues.delete('PAY-1');
    expect((await post(BODY).expect(404)).body).toEqual({ error: 'issue not found' });
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
  });

  it('400 prompt too long before any write when the composed prompt is over the cap', async () => {
    writeConfig({ skills: [{ ...SKILL, prompt: '{url}'.repeat(300) }] });
    await build();
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1', fields: { summary: 'S'.repeat(300) } }));
    const sent = stubDashboard();
    expect((await post({ ...BODY, ...NONE, action: { skill: SKILL.id } }).expect(400)).body).toEqual({ error: 'prompt too long' });
    expect(writes()).toEqual([]);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
  });

  it('a transition Jira refuses after a landed assign → 409 naming the step, saying the assign stands; key released; a retry starts', async () => {
    await build();
    const sent = stubDashboard();
    fake.failNext = (call) =>
      call.method === 'POST' && call.url.endsWith('/transitions') ? { status: 400, body: { errorMessages: ['A screen is required'], errors: {} } } : null;
    const res = await post(BODY).expect(409);
    expect(res.body.error).toBe('transition: Jira refused: A screen is required — the assign stands');
    expect(writes()).toEqual(['PUT /issue/PAY-1/assignee', 'POST /issue/PAY-1/transitions']);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();

    fake.failNext = null;
    const retry = await post(BODY).expect(200);
    // The assign stood, so the retry finds the ticket already mine and skips it.
    expect(retry.body.assigned).toBe(false);
    expect(retry.body.transitioned).toBe('Start');
  });

  it('an assign Jira refuses → its status, prefixed `assign: `, with no suffix (nothing stands) and no transition sent', async () => {
    await build();
    const sent = stubDashboard();
    fake.failNext = (call) => (call.method === 'PUT' ? { status: 403, body: { errorMessages: ['You cannot assign'], errors: {} } } : null);
    const res = await post(BODY).expect(502);
    expect(res.body.error).toBe('assign: Jira refused: You cannot assign');
    expect(writes()).toEqual(['PUT /issue/PAY-1/assignee']);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
  });

  it('a spawn 502 after both writes → 502 saying the Jira writes stand; key released; a retry starts', async () => {
    await build();
    let sent = stubDashboard({ spawn: { ok: false, status: 500, body: { error: 'boom' } } });
    const res = await post(BODY).expect(502);
    expect(res.body.error).toBe('boom — the Jira writes stand');
    expect(writes()).toEqual(['PUT /issue/PAY-1/assignee', 'POST /issue/PAY-1/transitions']);
    expect(live.get('PAY-1')).toBeNull();

    sent = stubDashboard();
    await post({ ...BODY, transitionId: null }).expect(200);
    expect(sent.spawns).toHaveLength(1);
  });

  // The prompt carries no ticket text, so nothing is recomposed after the writes: the only issue read after them is the poller's splice, whose failure a write
  // survives (`reread: false`). It must not turn a landed launch into a 502.
  it('an issue read that fails after the writes does not stop the spawn: the prompt is not recomposed', async () => {
    await build();
    const sent = stubDashboard();
    let posted = false;
    fake.failNext = (call) => {
      if (call.method === 'POST' && call.url.endsWith('/transitions')) posted = true;
      else if (posted && call.method === 'GET' && /\/issue\/PAY-1(\?|$)/.test(call.url)) return { status: 500 };
      return null;
    };
    await post(BODY).expect(200);
    expect(writes()).toEqual(['PUT /issue/PAY-1/assignee', 'POST /issue/PAY-1/transitions']);
    expect(sent.spawns).toHaveLength(1);
  });

  it('a spawn refusal with no write keeps its status and its sentence verbatim', async () => {
    await build();
    stubDashboard({ spawn: { ok: false, status: 429, body: { error: 'too many launches in flight' } } });
    const res = await post({ ...BODY, assign: false, transitionId: null }).expect(429);
    expect(res.body).toEqual({ error: 'too many launches in flight' });
    expect(writes()).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
  });
});

/**
 * The branch choice against the repo's refs (Jira repo/branch, Task 6; spec §5.3). The git read is stubbed — `jira-refs.test.ts` runs it against real git; what
 * this owns is that a refusal comes BEFORE the reservation and every write, and that the workspace the refs resolve is the one the spawned prompt carries.
 */
describe('the branch choice', () => {
  const branch = (name: string, worktree: string | null = null): JiraRefBranch => ({
    name,
    local: true,
    remote: true,
    sync: 'same',
    committedAt: '2026-01-01T00:00:00.000Z',
    worktree,
    ticket: name.includes('pay-1')
  });
  const refs = (branches: JiraRefBranch[], mainBranch: string | null = 'develop'): JiraRepoRefs => ({
    repo: REPO,
    available: true,
    fetchedAt: null,
    mainBranch,
    defaultBase: 'develop',
    branches
  });
  let readRefs: jest.SpyInstance;

  beforeEach(() => {
    readRefs = jest.spyOn(refsUtil, 'readRepoRefs').mockResolvedValue(refs([branch('develop', REPO)]));
  });
  afterEach(() => jest.restoreAllMocks());

  /** A refusal made from the refs: no Jira call beyond the boot's, no spawn, no assign, no transition, and the live map exactly as empty as it was. */
  async function refused(body: Record<string, unknown>, error: string): Promise<void> {
    await build();
    const sent = stubDashboard();
    const callsAtStart = fake.calls.length;
    expect((await post(body).expect(409)).body).toEqual({ error });
    expect(fake.calls.length).toBe(callsAtStart);
    expect(writes()).toEqual([]);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
    expect(live.hasConfirmed()).toBe(false);
    // Nothing was reserved, so the very next Start is not a "starting" 409.
    readRefs.mockResolvedValue(refs([branch('develop', REPO)]));
    await post({ ...BODY, branch: 'pay-1-other' }).expect(200);
  }

  it('409 <branch> exists — switch to Continue for a new branch whose name is listed, before anything is reserved or written', async () => {
    readRefs.mockResolvedValue(refs([branch('develop', REPO), branch('pay-1-export')]));
    await refused(BODY, 'pay-1-export exists — switch to Continue');
  });

  it('409 for a continued branch the mapped checkout holds, naming the checkout', async () => {
    readRefs.mockResolvedValue(refs([branch('pay-1-export', REPO)], 'pay-1-export'));
    await refused({ ...BODY, mode: 'continue', base: undefined }, `pay-1-export is checked out in the mapped checkout ${REPO}`);
  });

  it('reads the refs once, for this repo and key, with the roots from the environment and the repo\'s stored base', async () => {
    writeConfig({ repoDefaults: { [REPO]: { base: 'release/9' } } });
    await build();
    stubDashboard();
    await post(BODY).expect(200);
    expect(readRefs.mock.calls).toEqual([[REPO, 'PAY-1', null, 'release/9']]);
  });

  it('a continued branch held by a linked worktree starts in that worktree: the spawned prompt names it', async () => {
    readRefs.mockResolvedValue(refs([branch('develop', REPO), branch('pay-1-export', '/work/pay-hand-made')]));
    await build();
    const sent = stubDashboard();
    await post({ ...BODY, mode: 'continue', base: undefined, openMr: true, target: 'release/9' }).expect(200);
    const prompt = sent.spawns[0].prompt as string;
    expect(prompt.startsWith(`Workspace: repository ${REPO}, mode continue, branch pay-1-export, expected worktree /work/pay-hand-made. `)).toBe(true);
    expect(prompt).toContain('open one merge request from it into release/9');
  });

  it('none makes no git read at all', async () => {
    await build();
    stubDashboard();
    await post({ ...BODY, ...NONE, action: 'context' }).expect(200);
    expect(readRefs).not.toHaveBeenCalled();
  });

  it('refs the server cannot read make no refusal, and the worktree is the conventional path', async () => {
    readRefs.mockResolvedValue({ repo: REPO, available: false, reason: 'not mounted into the board' });
    await build();
    const sent = stubDashboard();
    await post(BODY).expect(200);
    expect(sent.spawns[0].prompt).toContain(`expected worktree ${REPO}/.worktrees/pay-1-export. `);
  });

  it('the spawned prompt is the preview for the same choice, byte for byte', async () => {
    await build();
    const sent = stubDashboard();
    const choice = { ...BODY, assign: false, transitionId: null };
    await post(choice).expect(200);
    const query = new URLSearchParams({ key: 'PAY-1', action: 'execute', repo: REPO, mode: 'new', branch: 'pay-1-export', base: 'develop' });
    const preview = (await request(app.getHttpServer()).get(`/api/jira/prompt?${query.toString()}`).expect(200)).text;
    expect(sent.spawns[0].prompt).toBe(preview);
    expect(preview).toContain('Workspace: repository');
  });
});

describe('Start', () => {
  it('assign → transition → spawn, in that order, then the key is live and confirmed', async () => {
    await build();
    const sent = stubDashboard();
    const res = await post(BODY).expect(200);

    expect(sent.spawns).toHaveLength(1);
    // Both writes had landed when the spawn arrived, assign first.
    expect(sent.writesAtSpawn[0]).toEqual(['PUT /issue/PAY-1/assignee', 'POST /issue/PAY-1/transitions']);
    expect(res.body).toEqual({
      sessionId: 'sess-1',
      assigned: true,
      transitioned: 'Start',
      session: { name: 'jira PAY-1', startedAt: expect.any(String), repo: REPO }
    });

    const spawn = sent.spawns[0];
    expect(spawn).toMatchObject({ project: '-dir-0', name: 'jira PAY-1', permissionMode: 'acceptEdits', model: DEFAULT_MODEL, remoteControl: false });
    // No copy of the ticket: the session reads it with `jira.mjs show`, so its status and assignee are whatever the writes left.
    const prompt = spawn.prompt as string;
    expect(
      prompt.startsWith(`Workspace: repository ${REPO}, mode new, branch pay-1-export cut from develop, expected worktree ${REPO}/.worktrees/pay-1-export. `)
    ).toBe(true);
    expect(prompt).toContain('Work on Jira ticket PAY-1 in this repository, end to end');
    expect(prompt).toContain('`jira.mjs show PAY-1`');
    expect(prompt).not.toContain('TICKET');

    const status: JiraStatusPayload = (await request(app.getHttpServer()).get('/api/jira').expect(200)).body;
    expect(status.live['PAY-1']).toMatchObject({ name: 'jira PAY-1', repo: REPO, starting: false });
    expect(live.get('PAY-1')).toMatchObject({ sessionId: 'sess-1' });
  });

  /* The reconciler is armed by a session that exists and by nothing else: a refused or failed Start leaves no confirmed entry for it to watch. */
  it('arms the live-map reconciler once the session is confirmed — and not for a Start whose spawn failed', async () => {
    await build();
    const arm = jest.spyOn(app.get(JiraLiveReconciler), 'arm');
    stubDashboard({ spawn: { ok: false, status: 500, body: { error: 'boom' } } });
    await post(BODY).expect(502);
    expect(arm).not.toHaveBeenCalled();

    stubDashboard();
    await post(BODY).expect(200);
    expect(arm).toHaveBeenCalledTimes(1);
    expect(live.hasConfirmed()).toBe(true);
  });

  it('spawns in the normalised repo path, so `~`-free trailing-slash spellings reach the same project', async () => {
    await build();
    const sent = stubDashboard();
    // `context` and no branch: an `execute` prompt names its worktree, `${REPO}/.worktrees/…`, which would be a trailing-slash spelling of the repo by itself.
    const res = await post({ ...BODY, ...NONE, action: 'context', repo: `${REPO}/`, assign: false, transitionId: null }).expect(200);
    expect(res.body.session.repo).toBe(REPO);
    expect(sent.spawns[0]).toMatchObject({ project: '-dir-0' });
    expect((sent.spawns[0].prompt as string).includes(`${REPO}/`)).toBe(false);
  });

  it('a ticket already assigned to me is not assigned again: `assigned: false`, no PUT', async () => {
    await build();
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1', fields: { assignee: { accountId: 'acc-1', displayName: 'Ada Lovelace' } } }));
    const sent = stubDashboard();
    const res = await post(BODY).expect(200);
    expect(res.body.assigned).toBe(false);
    expect(writes()).toEqual(['POST /issue/PAY-1/transitions']);
    expect(sent.spawns).toHaveLength(1);
  });

  it('neither write asked: no write, `assigned: false`, `transitioned: null`, and the permission mode is clamped to the ceiling', async () => {
    await build();
    const sent = stubDashboard();
    const res = await post({ ...BODY, assign: false, transitionId: null, permissionMode: 'bypassPermissions' }).expect(200);
    expect(res.body).toMatchObject({ assigned: false, transitioned: null });
    expect(writes()).toEqual([]);
    expect(sent.spawns[0]).toMatchObject({ permissionMode: 'acceptEdits' });
  });

  it("a skill action spawns its template's text with the placeholders filled, and no ticket block", async () => {
    await build();
    const sent = stubDashboard();
    await post({ ...BODY, ...NONE, action: { skill: SKILL.id }, assign: false, transitionId: null }).expect(200);
    expect(sent.spawns[0].prompt).toBe(`Review PAY-1 in ${REPO}, then stop.`);
  });

  // The launch sheet's edited prompt: spawned as written, after both writes — and the session is still the ticket's, linked and named as
  // a composed launch would be. A 4 000-character prompt is at the cap, not over it.
  it('an edited prompt is spawned verbatim after the writes, and the session is still linked to the ticket', async () => {
    await build();
    const sent = stubDashboard();
    const custom = `Look at PAY-1 and only write a summary.${'.'.repeat(4000 - 39)}`;
    expect(custom).toHaveLength(4000);
    await post({ ...BODY, prompt: custom }).expect(200);
    expect(sent.writesAtSpawn[0]).toEqual(['PUT /issue/PAY-1/assignee', 'POST /issue/PAY-1/transitions']);
    expect(sent.spawns[0]).toMatchObject({ name: 'jira PAY-1', prompt: custom });
    expect(live.get('PAY-1')).toMatchObject({ sessionId: 'sess-1' });
  });

  it('an edited prompt skips the composer, so a ticket whose composed prompt would be too long still starts', async () => {
    writeConfig({ skills: [{ ...SKILL, prompt: '{url}'.repeat(300) }] });
    await build();
    fake.issues.set('PAY-1', makeRawIssue({ key: 'PAY-1', fields: { summary: 'S'.repeat(300) } }));
    const sent = stubDashboard();
    await post({ ...BODY, ...NONE, action: { skill: SKILL.id }, prompt: 'Just review it.' }).expect(200);
    expect(sent.spawns[0].prompt).toBe('Just review it.');
  });

  it('two Starts on one key in the same moment (Review Focus 2): one 200, one 409, one spawn', async () => {
    await build();
    const sent = stubDashboard();
    const [a, b] = await Promise.all([post(BODY), post(BODY)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body.error).toMatch(/^PAY-1 (is starting|already has a session)$/);
    expect(sent.spawns).toHaveLength(1);
    expect(writes()).toEqual(['PUT /issue/PAY-1/assignee', 'POST /issue/PAY-1/transitions']);
    expect(live.get('PAY-1')).toMatchObject({ sessionId: 'sess-1' });
  });
});

describe('Open in: the surface', () => {
  it('a body with no surface spawns with no surface key — byte for byte the launch from before the control', async () => {
    await build();
    const sent = stubDashboard({ desktop: true });
    await post(BODY).expect(200);
    expect(sent.spawns[0]).not.toHaveProperty('surface');
  });

  it('desktop is forwarded to the spawn, for any action, and the session it answers is confirmed like any other', async () => {
    await build();
    const sent = stubDashboard({ desktop: true, spawn: { body: { surface: 'desktop', sessionId: 'sess-d' } } });
    const res = await post({ ...BODY, ...NONE, action: { skill: SKILL.id }, surface: 'desktop' }).expect(200);
    expect(sent.spawns[0]).toMatchObject({ surface: 'desktop', name: 'jira PAY-1' });
    expect(res.body).toMatchObject({ sessionId: 'sess-d', session: { name: 'jira PAY-1', repo: REPO } });
    expect(live.get('PAY-1')).toMatchObject({ sessionId: 'sess-d' });
  });

  it('dashboard is forwarded as it came', async () => {
    await build();
    const sent = stubDashboard({ desktop: true });
    await post({ ...BODY, surface: 'dashboard' }).expect(200);
    expect(sent.spawns[0]).toMatchObject({ surface: 'dashboard' });
  });

  it('409 for desktop once the dashboard stops saying desktopAvailable — before the reservation and before any Jira write', async () => {
    await build();
    const sent = stubDashboard();
    const res = await post({ ...BODY, surface: 'desktop' }).expect(409);
    expect(res.body).toEqual({ error: "the desktop app is not available on this machine's dashboard — launch on Dashboard instead" });
    expect(writes()).toEqual([]);
    expect(sent.spawns).toEqual([]);
    expect(live.get('PAY-1')).toBeNull();
  });

  it('a desktop answer with no id (a dashboard from before the hand-over): 200 with `session: null`, the writes reported, and the key released', async () => {
    await build();
    const arm = jest.spyOn(app.get(JiraLiveReconciler), 'arm');
    stubDashboard({ desktop: true, spawn: { body: { surface: 'desktop' } } });
    const res = await post({ ...BODY, surface: 'desktop' }).expect(200);
    expect(res.body).toEqual({ surface: 'desktop', assigned: true, transitioned: 'Start', session: null });
    expect(live.get('PAY-1')).toBeNull();
    expect(arm).not.toHaveBeenCalled();
  });

  it("a desktop refusal reads in the board's words, not the dashboard's code", async () => {
    await build();
    stubDashboard({ desktop: true, spawn: { ok: false, status: 501, body: { error: 'desktop app unavailable' } } });
    const res = await post({ ...BODY, ...NONE, action: 'context', assign: false, transitionId: null, surface: 'desktop' }).expect(502);
    expect(res.body).toEqual({ error: 'the desktop app is not available on this Mac — launch on Dashboard instead' });
    expect(live.get('PAY-1')).toBeNull();
  });
});

/**
 * The `review` action (CodeRabbit review, Task 5; spec §5.2 live-session gate, §5.5's refusal table, §6). The GitLab side is the poller's CACHE only, so the
 * suite seeds it by replacing `findMr` / `reposFor` on the app's own `GitlabPollerService` — no GitLab is dialled, and what dispatch sees is what the board drew.
 *
 * Every field distinct: two sub-tasks (PAY-2, PAY-3) of one story (PAY-1), whose MR !42 in `grp/pay` is on `pay-1-export`; two mapped repos, MAIN (the one
 * review candidate, a real directory so `mainCheckoutOf` can map a linked worktree of it) and CLONE (mapped to PAY, origin elsewhere, so never a candidate).
 */
describe('review', () => {
  const PROJECT = 'grp/pay';
  const IID = 42;
  const SOURCE = 'pay-1-export';
  let MAIN: string;
  let CLONE: string;
  let WORKTREE: string;
  let mrs: Map<string, GitlabMr>;
  let candidates: string[];
  let reposForCalls: [string, string][];

  const review = (over: Partial<GitlabReview> = {}): GitlabReview => ({
    open: 2,
    resolved: 1,
    worst: 'major',
    bySeverity: { critical: 0, major: 1, minor: 1, trivial: 0, other: 0 },
    triggeredAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    landedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    commitsSince: 0,
    capped: false,
    readAt: new Date().toISOString(),
    failed: false,
    ...over
  });
  const mr = (over: Partial<GitlabMr> = {}): GitlabMr => ({
    project: PROJECT,
    iid: IID,
    title: 'PAY-1 export',
    webUrl: `https://gitlab.test/${PROJECT}/-/merge_requests/${IID}`,
    state: 'opened',
    draft: false,
    sourceBranch: SOURCE,
    targetBranch: 'develop',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    mergedAt: null,
    pipeline: null,
    keys: ['PAY-1'],
    review: review(),
    ...over
  });
  const seed = (m: GitlabMr): void => {
    mrs.set(`${m.project}\u0000${m.iid}`, m);
  };
  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: 'PAY-2',
    repo: MAIN,
    action: 'review',
    mr: { project: PROJECT, iid: IID },
    half: 'fix',
    assign: false,
    transitionId: null,
    mode: 'continue',
    branch: SOURCE,
    permissionMode: 'acceptEdits',
    remoteControl: false,
    ...over
  });
  const subtask = (key: string) =>
    makeRawIssue({ key, fields: { parent: { key: 'PAY-1', fields: { summary: 'The story' } }, issuetype: { name: 'Sub-task', hierarchyLevel: -1, subtask: true } } });
  const manual = (key: string, repo: string, branch: string) => ({
    key,
    sessionId: `sess-${key}`,
    how: 'manual' as const,
    action: null,
    name: `by hand ${key}`,
    repo,
    branch,
    surface: null,
    model: null,
    effort: null,
    snapshot: { summary: 'x', type: 'Sub-task', parentKey: 'PAY-1' },
    startedAt: new Date().toISOString()
  });
  const row = (over: Partial<DashboardRow>): DashboardRow => ({ id: 'row-1', status: 'working', ...over }) as DashboardRow;

  beforeAll(() => {
    MAIN = join(dir, 'pay-main');
    CLONE = join(dir, 'pay-clone');
    WORKTREE = join(MAIN, '.worktrees', SOURCE);
    mkdirSync(join(MAIN, '.git', 'worktrees', SOURCE), { recursive: true });
    mkdirSync(join(CLONE, '.git'), { recursive: true });
    mkdirSync(WORKTREE, { recursive: true });
    writeFileSync(join(WORKTREE, '.git'), `gitdir: ${join(MAIN, '.git', 'worktrees', SOURCE)}\n`);
  });

  let sent: Sent;
  beforeEach(async () => {
    writeConfig({ repos: { PAY: [MAIN, CLONE] } });
    await build();
    fake.issues.set('PAY-2', subtask('PAY-2'));
    fake.issues.set('PAY-3', subtask('PAY-3'));
    fake.transitions.set('PAY-2', [START]);
    mrs = new Map();
    seed(mr());
    candidates = [MAIN];
    reposForCalls = [];
    const gitlab = app.get(GitlabPollerService);
    jest.spyOn(gitlab, 'findMr').mockImplementation((project: string, iid: number) => mrs.get(`${project}\u0000${iid}`) ?? null);
    jest.spyOn(gitlab, 'reposFor').mockImplementation((jiraProject: string, gitlabProject: string) => {
      reposForCalls.push([jiraProject, gitlabProject]);
      return jiraProject === 'PAY' && gitlabProject === PROJECT ? [...candidates] : [];
    });
    sent = stubDashboard({ projectPaths: [MAIN, CLONE], desktop: true });
  });
  afterEach(() => jest.restoreAllMocks());

  /** Refused before the reservation: nothing reserved on the key, nothing spawned, nothing written to Jira. */
  function untouched(key = 'PAY-2'): void {
    expect(sent.spawns).toEqual([]);
    expect(writes()).toEqual([]);
    expect(live.get(key)).toBeNull();
  }

  describe('the controller — shape, before anything else', () => {
    it.each([
      ['no mr', { mr: undefined }, 'mr must be { project, iid }'],
      ['an mr that is a string', { mr: 'grp/pay!42' }, 'mr must be { project, iid }'],
      ['an empty project', { mr: { project: '', iid: IID } }, 'mr must be { project, iid }'],
      ['a zero iid', { mr: { project: PROJECT, iid: 0 } }, 'mr must be { project, iid }'],
      ['a fractional iid', { mr: { project: PROJECT, iid: 4.2 } }, 'mr must be { project, iid }'],
      ['a string iid', { mr: { project: PROJECT, iid: '42' } }, 'mr must be { project, iid }'],
      ['no half', { half: undefined }, 'half must be request or fix'],
      ['a capitalised half', { half: 'Fix' }, 'half must be request or fix'],
      ['openMr on a review', { openMr: true }, 'openMr is only for execute with a branch'],
      ['an unknown action, mr and half present', { action: 'reveiw' }, 'action must be execute, context, review or { skill: <id> }']
    ])('400 for %s', async (_label, over, error) => {
      expect((await post(body(over)).expect(400)).body).toEqual({ error });
      untouched();
      expect(reposForCalls).toEqual([]);
    });

    it('mr is read before half', async () => {
      expect((await post(body({ mr: undefined, half: undefined })).expect(400)).body).toEqual({ error: 'mr must be { project, iid }' });
    });
  });

  describe('the cached MR, the candidate and the choice — 400s in that order, before the reservation', () => {
    it.each([
      ['an MR the cache does not hold', () => mrs.clear(), {}, `!${IID} is not an open merge request of PAY-2`],
      ['a merged MR', () => seed(mr({ state: 'merged' })), {}, `!${IID} is not an open merge request of PAY-2`],
      ['a closed MR', () => seed(mr({ state: 'closed' })), {}, `!${IID} is not an open merge request of PAY-2`],
      ['another spelling of the project (the cache match is exact)', () => undefined, { mr: { project: 'GRP/pay', iid: IID } }, `!${IID} is not an open merge request of PAY-2`],
      ['a repo that is mapped but not a candidate', () => undefined, () => ({ repo: CLONE }), ''],
      ['a new branch', () => undefined, { mode: 'new', branch: 'pay-2-fix', base: 'develop' }, `a review continues ${SOURCE}`],
      ['no branch', () => undefined, { mode: 'none', branch: undefined }, `a review continues ${SOURCE}`],
      ['continue on another branch', () => undefined, { branch: 'pay-1-other' }, `a review continues ${SOURCE}`],
      ['an MR not open AND a wrong choice — the MR sentence', () => seed(mr({ state: 'merged' })), { branch: 'pay-1-other' }, `!${IID} is not an open merge request of PAY-2`],
      ['not a candidate AND a wrong choice — the candidate sentence', () => undefined, () => ({ repo: CLONE, branch: 'pay-1-other' }), '']
    ])('400 for %s', async (_label, arrange, over, error) => {
      arrange();
      const expected = error === '' ? `${CLONE} is not a review candidate for !${IID}` : error;
      // A thunk where the override names `CLONE`, which is only assigned in `beforeEach` — read at table time it would still be undefined.
      const fields = typeof over === 'function' ? over() : over;
      expect((await post(body(fields)).expect(400)).body).toEqual({ error: expected });
      untouched();
    });

    it("the candidates are asked for the key's Jira project and the CACHED MR's project", async () => {
      await post(body()).expect(200);
      expect(reposForCalls).toEqual([['PAY', PROJECT]]);
    });

    it("continue on the mapped checkout's own branch, which is not the source branch: the choice's 400, not resolveWorkspace's 409", async () => {
      jest.spyOn(refsUtil, 'readRepoRefs').mockResolvedValue({
        repo: MAIN,
        available: true,
        fetchedAt: null,
        mainBranch: 'develop',
        defaultBase: 'develop',
        branches: []
      });
      expect((await post(body({ branch: 'develop' })).expect(400)).body).toEqual({ error: `a review continues ${SOURCE}` });
      untouched();
    });
  });

  describe('the review state — 409s, before the reservation', () => {
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    it.each([
      ['reviewing', { open: 0, triggeredAt: ago(60_000), landedAt: null }, 'fix', `nothing to review on !${IID}`],
      ['clean', { open: 0 }, 'fix', `nothing to review on !${IID}`],
      ['unknown (capped, nothing open)', { open: 0, capped: true }, 'request', `!${IID} has too many threads to read`],
      ['none, the sheet sent fix', { open: 0, triggeredAt: null, landedAt: null }, 'fix', `the review on !${IID} moved on — reopen the sheet`],
      ['open, the sheet sent request', {}, 'request', `the review on !${IID} moved on — reopen the sheet`]
    ])('409 for %s', async (_label, over, half, error) => {
      seed(mr({ review: review(over as Partial<GitlabReview>) }));
      expect((await post(body({ half })).expect(409)).body).toEqual({ error });
      untouched();
    });

    it('409 when the review has not been read (review: null)', async () => {
      seed(mr({ review: null }));
      expect((await post(body()).expect(409)).body).toEqual({ error: `no review state for !${IID} yet` });
      untouched();
    });

    it('a stale review starts the request half', async () => {
      seed(mr({ review: review({ open: 0, commitsSince: 3 }) }));
      await post(body({ half: 'request' })).expect(200);
      expect(sent.spawns[0].prompt).toContain('`@coderabbitai review`');
    });
  });

  describe('the ticket and the MR', () => {
    it("400 when the MR's keys carry neither the key nor its parent — after the detail read, before any Jira write", async () => {
      seed(mr({ keys: ['PAY-9'] }));
      expect((await post(body({ assign: true, transitionId: '31' })).expect(400)).body).toEqual({
        error: `!${IID} is not an open merge request of PAY-2`
      });
      untouched();
    });

    it("a sub-task whose parent's key is on the MR passes, and so does a ticket whose own key is", async () => {
      await post(body()).expect(200);
      // The first session holds the branch until it ends; then PAY-3, named on the MR itself, passes.
      live.end('PAY-2', 'sess-1', 'stopped');
      seed(mr({ keys: ['PAY-3'] }));
      await post(body({ key: 'PAY-3' })).expect(200);
      expect(sent.spawns).toHaveLength(2);
    });

    it('409 <KEY> already has a session for a live run link on the key — the ticket gate is unchanged', async () => {
      live.reserve('PAY-2', MAIN);
      live.confirm('PAY-2', 'sess-old', RUN_META);
      expect((await post(body()).expect(409)).body).toEqual({ error: 'PAY-2 already has a session' });
      expect(sent.spawns).toEqual([]);
    });
  });

  describe('the branch gate', () => {
    const busy = { error: `a session is live on ${SOURCE}` };

    it('409 for a live manual link on another key with that branch in a candidate repo; the key it reserved is released', async () => {
      live.addLink(manual('PAY-3', MAIN, SOURCE));
      expect((await post(body()).expect(409)).body).toEqual(busy);
      untouched();
      // The refused key was released: once the branch is free, the same key passes — not `PAY-2 is starting`.
      live.unlink('PAY-3', 'sess-PAY-3');
      await post(body()).expect(200);
    });

    it('no 409 for a live link with that branch in a repo that is not a candidate, or with another branch', async () => {
      live.addLink(manual('PAY-3', CLONE, SOURCE));
      live.addLink(manual('PAY-4', MAIN, 'pay-4-other'));
      await post(body()).expect(200);
    });

    it("409 for an ACTIVE row on the branch in a linked worktree of the candidate (mainCheckoutOf maps it), working or question", async () => {
      live.setRows([row({ id: 'row-q', status: 'question', gitBranch: SOURCE, projectPath: WORKTREE })], Date.now());
      expect((await post(body()).expect(409)).body).toEqual(busy);
      live.setRows([row({ id: 'row-w', status: 'working', gitBranch: SOURCE, projectPath: MAIN })], Date.now());
      expect((await post(body()).expect(409)).body).toEqual(busy);
      untouched();
    });

    it('no 409 for an idle row, a row in a repo that is not a candidate, or a row on another branch', async () => {
      live.setRows(
        [
          row({ id: 'row-idle', status: 'idle', gitBranch: SOURCE, projectPath: WORKTREE }),
          row({ id: 'row-clone', status: 'working', gitBranch: SOURCE, projectPath: CLONE }),
          row({ id: 'row-other', status: 'working', gitBranch: 'pay-1-other', projectPath: MAIN })
        ],
        Date.now()
      );
      await post(body()).expect(200);
    });

    it('two sub-tasks of one parent on the same MR branch, the second while the first is still spawning: it 409s on the hold, not on a link', async () => {
      // `Promise.all` over two posts does not race them: supertest's first request usually finishes before the second reaches the gate, so the second 409s
      // on the first one's LINK and the hold is never exercised. Here the first dispatch is parked inside its spawn — key reserved, branch held, no link —
      // and the second runs every gate in that window, so the only thing that can refuse it is the hold.
      let open!: () => void;
      sent = stubDashboard({ projectPaths: [MAIN, CLONE], firstSpawnGate: new Promise<void>((resolve) => (open = resolve)) });
      const first = post(body()).then((res) => res);
      // `finally`, so a failed assertion still lets the parked request answer: left parked, it holds the app open and the case reads as a 30 s timeout.
      try {
        for (let waited = 0; sent.spawns.length === 0; waited += 5) {
          if (waited > 5_000) throw new Error('the first dispatch never reached its spawn');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(live.liveLinks()).toEqual([]);
        expect(live.get('PAY-2')).toMatchObject({ sessionId: null });
        expect((await post(body({ key: 'PAY-3' })).expect(409)).body).toEqual(busy);
        expect(live.get('PAY-3')).toBeNull();
      } finally {
        open();
      }
      expect((await first).status).toBe(200);
      expect(sent.spawns).toHaveLength(1);
      // Bounded on its own: a red state must fail here, never park the suite behind a request that never answers.
    }, 5_000);

    it('a failed spawn releases the branch reservation: a third dispatch passes', async () => {
      sent = stubDashboard({ projectPaths: [MAIN, CLONE], spawn: { ok: false, status: 500, body: { error: 'boom' } } });
      await post(body()).expect(502);
      sent = stubDashboard({ projectPaths: [MAIN, CLONE] });
      await post(body({ key: 'PAY-3' })).expect(200);
      expect(sent.spawns).toHaveLength(1);
    });

    it('on success the link holds the branch: a second dispatch 409s, and once the link ends a third passes', async () => {
      await post(body()).expect(200);
      expect((await post(body({ key: 'PAY-3' })).expect(409)).body).toEqual(busy);
      expect(live.get('PAY-3')).toBeNull();
      live.end('PAY-2', 'sess-1', 'stopped');
      await post(body({ key: 'PAY-3' })).expect(200);
    });

    it('a no-id desktop spawn drops the branch reservation at once: the next dispatch on that branch passes', async () => {
      sent = stubDashboard({ projectPaths: [MAIN, CLONE], desktop: true, spawn: { body: { surface: 'desktop' } } });
      expect((await post(body({ surface: 'desktop' })).expect(200)).body).toMatchObject({ session: null });
      sent = stubDashboard({ projectPaths: [MAIN, CLONE] });
      await post(body({ key: 'PAY-3' })).expect(200);
    });
  });

  describe('Start', () => {
    it('spawns the composition over the cached MR — the preview for the same request, byte for byte — and links it as a review on the branch', async () => {
      const res = await post(body()).expect(200);
      expect(res.body).toMatchObject({ sessionId: 'sess-1', assigned: false, transitioned: null });
      const query = new URLSearchParams({ key: 'PAY-2', action: 'review', repo: MAIN, mode: 'continue', branch: SOURCE, mrProject: PROJECT, mrIid: String(IID), half: 'fix' });
      const preview = (await request(app.getHttpServer()).get(`/api/jira/prompt?${query.toString()}`).expect(200)).text;
      expect(sent.spawns[0].prompt).toBe(preview);
      expect(preview).toContain(`!${IID}`);
      expect(preview).toContain(PROJECT);
      expect(sent.spawns[0]).toMatchObject({ name: 'jira PAY-2', permissionMode: 'acceptEdits' });
      const link = live.links().find((l) => l.key === 'PAY-2');
      expect(link).toMatchObject({ how: 'run', action: 'review', branch: SOURCE, repo: MAIN, sessionId: 'sess-1' });
    });

    it('with assign false and no transition, nothing is written to Jira', async () => {
      await post(body()).expect(200);
      expect(writes()).toEqual([]);
    });

    it('an edited prompt spawns as written', async () => {
      await post(body({ prompt: 'Fix the review on !42 my way.' })).expect(200);
      expect(sent.spawns[0].prompt).toBe('Fix the review on !42 my way.');
    });
  });
});
