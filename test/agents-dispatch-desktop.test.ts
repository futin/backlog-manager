import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { DispatchRecordsService } from '../server/src/items/dispatch-records.service';
import { desktopSpawnError } from '../server/src/agents/desktop.util';
import { finishClause } from '../shared/agent';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';

/**
 * The board's half of the desktop launch (claude-agents-dashboard's desktop-launch spec, decision 7): an item dispatch may carry `surface`, forwarded to the
 * dashboard's `POST /api/spawn` as it came; a desktop answer carries no session id, so dispatch records nothing; and the plan offers the control only while
 * HOME's dashboard says `desktopAvailable`. Its own suite rather than more cases in `agents-dispatch.test.ts`, because every case here needs a health answer
 * that suite's stub never gives — and that suite, untouched, is the proof a body without `surface` still spawns byte for byte as it did.
 */

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');
const RAW_BUG = item('bug-1', 'a fresh bug', '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n');
const OOS = item('oos-1', 'declined', '## Why not\n\nno\n');

let projectPath: string;

interface Sent {
  url: string;
  init?: RequestInit;
}

/** The dashboard: `health` is merged over a reachable, spawn-capable answer; `spawn` is the `/api/spawn` answer. */
function stubDashboard(health: Record<string, unknown> = {}, spawn: { status?: number; body?: unknown } = {}) {
  const sent: Sent[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
      const status = spawn.status ?? 200;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(spawn.body ?? { surface: 'desktop' }) } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.endsWith('/api/configs')
            ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits', ...health }
        )
    } as Response);
  }) as jest.Mock;
  return sent;
}

const DESKTOP = { desktopAvailable: true, launchSurfaceDefault: 'desktop' };

describe('desktop launches through POST /api/agents/dispatch', () => {
  let app: INestApplication;
  let tmpRoot: string;
  const env = { ...process.env };
  const realFetch = global.fetch;

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-fresh-bug.md', content: RAW_BUG },
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG },
      { leaf: 'out-of-scope', filename: 'oos-1-declined.md', content: OOS }
    ]);
    // An empty run-state home, so no case reads the developer's real runs; and a dashboards file naming one remote, for the home-only rule.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-dispatch-desktop-'));
    process.env.BM_ORCH_HOME = join(tmpRoot, 'orchestrator');
    const dashboards = join(tmpRoot, 'dashboards.json');
    writeFileSync(dashboards, JSON.stringify({ dashboards: [{ name: 'Pro', url: 'http://pro.test:4173', bmUrl: 'http://pro.test:4322', host: 'pro' }] }));
    process.env.BM_DASHBOARDS_FILE = dashboards;
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const bugPath = (name: string) => join(projectPath, 'backlog', 'bugs/open', name);
  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .send(body as object);
  const plan = (itemPath: string) => request(app.getHttpServer()).post('/api/agents/plan').send({ itemPath });
  const spawnBody = (sent: Sent[]) => JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
  const execute = (over: Record<string, unknown> = {}) =>
    post({
      itemPath: bugPath('bug-2-a-known-bug.md'),
      action: 'execute',
      prompt: 'Use the backlog-manager:backlog-execute skill on bug-2.',
      permissionMode: 'acceptEdits',
      remoteControl: true,
      ...over
    });

  describe('the plan', () => {
    it("carries launchSurface, preselected from the dashboard's default, when home's dashboard says desktopAvailable", async () => {
      stubDashboard(DESKTOP);
      expect((await plan(bugPath('bug-2-a-known-bug.md')).expect(201)).body.launchSurface).toBe('desktop');
    });

    it('falls back to dashboard when the dashboard sends no default, or one outside the two surfaces', async () => {
      stubDashboard({ desktopAvailable: true, launchSurfaceDefault: 'phone' });
      expect((await plan(bugPath('bug-2-a-known-bug.md')).expect(201)).body.launchSurface).toBe('dashboard');
    });

    it('offers it for a groom too', async () => {
      stubDashboard(DESKTOP);
      expect((await plan(bugPath('bug-1-a-fresh-bug.md')).expect(201)).body.launchSurface).toBe('desktop');
    });

    it('carries no launchSurface for a capture', async () => {
      stubDashboard(DESKTOP);
      const res = await plan(join(projectPath, 'backlog', 'out-of-scope', 'oos-1-declined.md')).expect(201);
      expect(res.body.action).toBe('capture');
      expect(res.body).not.toHaveProperty('launchSurface');
    });

    it('carries no launchSurface for a dashboard from before desktop launches, or one that says false', async () => {
      stubDashboard({ launchSurfaceDefault: 'desktop' });
      expect((await plan(bugPath('bug-2-a-known-bug.md')).expect(201)).body).not.toHaveProperty('launchSurface');
      stubDashboard({ desktopAvailable: false, launchSurfaceDefault: 'desktop' });
      expect((await plan(bugPath('bug-2-a-known-bug.md')).expect(201)).body).not.toHaveProperty('launchSurface');
    });
  });

  describe('the spawn', () => {
    it('forwards surface: desktop, answers { surface: desktop } and records no dispatch', async () => {
      const sent = stubDashboard(DESKTOP);
      const res = await execute({ surface: 'desktop' }).expect(201);
      expect(res.body).toEqual({ surface: 'desktop' });
      const body = spawnBody(sent);
      expect(body.surface).toBe('desktop');
      expect(body.project).toBe('-abs-alpha');
      // No id to key a record on: abort and the holder claim read the record by session id, and the app owns this session.
      expect(app.get(DispatchRecordsService).get('sess-1')).toBeNull();
      expect(app.get(DispatchRecordsService).get('undefined')).toBeNull();
    });

    it("sends the whole prompt with the finish clause as its tail — never cut, whatever the surface", async () => {
      const sent = stubDashboard(DESKTOP);
      await execute({ surface: 'desktop' }).expect(201);
      const prompt: string = spawnBody(sent).prompt;
      expect(prompt.startsWith('Use the backlog-manager:backlog-execute skill on bug-2.')).toBe(true);
      expect(prompt.endsWith(finishClause('execute', 'in-place', '', {}))).toBe(true);
    });

    it("relays the dashboard's prompt-cap 400 unchanged, so an over-long desktop prompt is refused, never truncated", async () => {
      stubDashboard(DESKTOP, { status: 400, body: { error: 'prompt must be at most 4000 characters' } });
      await execute({ surface: 'desktop', prompt: 'x'.repeat(5000) }).expect(400, { error: 'prompt must be at most 4000 characters' });
    });

    it('forwards surface: dashboard as sent, and records the headless session as ever', async () => {
      const sent = stubDashboard(DESKTOP, { body: { surface: 'dashboard', sessionId: 'sess-1' } });
      const res = await execute({ surface: 'dashboard' }).expect(201);
      expect(res.body).toEqual({ sessionId: 'sess-1' });
      expect(spawnBody(sent).surface).toBe('dashboard');
      expect(app.get(DispatchRecordsService).get('sess-1')?.machine).toBe('home');
    });

    it('sends no surface key at all when the body carries none', async () => {
      const sent = stubDashboard(DESKTOP, { body: { surface: 'dashboard', sessionId: 'sess-1' } });
      await execute().expect(201);
      expect(spawnBody(sent)).not.toHaveProperty('surface');
    });

    it('reports a headless session as one when an older dashboard ignores surface and answers a bare id', async () => {
      stubDashboard(DESKTOP, { body: { sessionId: 'sess-1' } });
      expect((await execute({ surface: 'desktop' }).expect(201)).body).toEqual({ sessionId: 'sess-1' });
      expect(app.get(DispatchRecordsService).get('sess-1')).not.toBeNull();
    });

    it('502s a desktop answer to a launch that never asked for one', async () => {
      stubDashboard(DESKTOP, { body: { surface: 'desktop' } });
      await execute().expect(502, { error: 'spawn returned no session id' });
    });
  });

  describe('refusals', () => {
    it('400s a surface outside the two', async () => {
      const sent = stubDashboard(DESKTOP);
      await execute({ surface: 'phone' }).expect(400, { error: 'surface must be dashboard or desktop' });
      expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
    });

    it('400s desktop on a capture', async () => {
      stubDashboard(DESKTOP);
      await post({
        itemPath: join(projectPath, 'backlog', 'out-of-scope', 'oos-1-declined.md'),
        action: 'capture',
        prompt: 'capture it',
        permissionMode: 'acceptEdits',
        remoteControl: false,
        surface: 'desktop'
      }).expect(400, { error: 'only an execute or a groom can open in the desktop app' });
    });

    it('400s desktop on a remote machine, before anything is asked of it', async () => {
      const sent = stubDashboard(DESKTOP);
      await execute({ surface: 'desktop', machine: 'Pro', finish: 'pr', base: 'main' }).expect(400, {
        error: 'the desktop app opens only on this machine, not on Pro'
      });
      expect(sent.some((s) => s.url.startsWith('http://pro.test'))).toBe(false);
    });

    it("409s desktop once home's dashboard stops offering the app", async () => {
      const sent = stubDashboard({});
      await execute({ surface: 'desktop' }).expect(409, {
        error: "the desktop app is not available on this machine's dashboard — launch on Dashboard instead"
      });
      expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
    });

    it.each([
      [500, 'open failed', 502, "couldn't open the desktop app on this Mac — is Claude installed and able to start?"],
      [501, 'desktop app unavailable', 502, 'the desktop app is not available on this Mac — launch on Dashboard instead'],
      [429, 'too many launches in flight', 429, 'the desktop app was asked to open several sessions in the last few seconds — wait a moment and launch again']
    ])("puts the dashboard's %i %s in plain words", async (status, error, relayed, words) => {
      stubDashboard(DESKTOP, { status, body: { error } });
      await execute({ surface: 'desktop' }).expect(relayed, { error: words });
    });

    it('relays a headless refusal verbatim, as ever', async () => {
      stubDashboard(DESKTOP, { status: 429, body: { error: 'too many launches in flight' } });
      await execute({ surface: 'dashboard' }).expect(429, { error: 'too many launches in flight' });
    });
  });
});

describe('desktopSpawnError', () => {
  it.each([
    [400, 'bad surface', 'the dashboard did not accept the Desktop pick — update claude-agents-dashboard on this Mac, or launch on Dashboard'],
    [409, 'session is open in the desktop app', 'that session is already open in the desktop app'],
    [409, 'already resuming', 'that session is already being handed to the desktop app — give it a few seconds'],
    [429, 'too many launches in flight', 'the desktop app was asked to open several sessions in the last few seconds — wait a moment and launch again'],
    [500, 'open failed', "couldn't open the desktop app on this Mac — is Claude installed and able to start?"],
    [501, 'desktop app unavailable', 'the desktop app is not available on this Mac — launch on Dashboard instead']
  ])('%i %s', (status, error, words) => {
    expect(desktopSpawnError(status, error)).toBe(words);
  });

  it('relays anything it does not name unchanged', () => {
    expect(desktopSpawnError(400, 'unknown project: x')).toBe('unknown project: x');
    expect(desktopSpawnError(500, 'spawn failed')).toBe('spawn failed');
    expect(desktopSpawnError(409, 'some other conflict')).toBe('some other conflict');
  });
});
