import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { AgentsService } from '../server/src/agents/agents.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { projectDispatchGate } from '../shared/agent';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import type { AgentsStatus, OrchestratorRun } from '../shared/types';

// Same translation orchestrator-start.test.ts already does: the fixture is
// plain JSON, so TS would otherwise widen its string fields to `string`
// instead of the narrower literal unions (`RunStage`, `MergeMode`, etc).
const fixture = rawFixture as OrchestratorRun;

let projectPath: string;

interface Sent { url: string; init?: RequestInit }

/**
 * Same shape as orchestrator-start.test.ts's own stubDashboard — duplicated
 * rather than imported, matching this repo's existing convention of every
 * e2e suite owning its own fixtures and stubs rather than sharing test
 * infrastructure across files. The three URLs it answers (/api/health,
 * /api/management, /api/spawn) are every call AgentsService.resume can make,
 * same as orchestrate.
 */
function stubDashboard(
  spawn: { ok: boolean; status?: number; body?: unknown } = { ok: true },
  ceiling: string = 'acceptEdits'
) {
  const sent: Sent[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
      return Promise.resolve({
        ok: spawn.ok, status: spawn.status ?? (spawn.ok ? 200 : 429),
        json: () => Promise.resolve(spawn.body ?? { sessionId: 'sess-1' })
      } as Response);
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(
        url.endsWith('/api/management')
          ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
          : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: ceiling }
      )
    } as Response);
  }) as jest.Mock;
  return sent;
}

describe('POST /api/agents/resume', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  const realFetch = global.fetch;

  // Same layout orchestrate.mjs's own projectDir()/runFilePath() write, and
  // the same helper orchestrator-start.test.ts already uses:
  // <root>/<encodeURIComponent(absolute project path)>/run.json.
  function projectDir(project: string): string {
    return join(orchHome, encodeURIComponent(project));
  }

  function writeRun(run: OrchestratorRun): void {
    const dir = projectDir(run.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  beforeEach(async () => {
    // resume() never reads an item file, so the store needs no fixtures of
    // its own — unlike orchestrate()'s `ids` selector, there is nothing
    // here to select.
    projectPath = makeProject('alpha', []);

    // A fresh, empty BM_ORCH_HOME per test — never the developer's real
    // ~/.backlog-manager/orchestrator/. Deliberately not created here (only
    // its parent is): a project with no run yet has no directory at all,
    // and resume() must treat that as "no crashed run" rather than fail.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-resume-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;

    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_AGENTS_TOKEN = 's3cret';
    // The sweeper does not exist yet (a later task), but this suite must
    // never depend on that — turning the operator kill switch off here is
    // what keeps this suite green once a bootstrap timer lands beside it.
    process.env.BM_WATCHDOG = 'off';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/agents/resume').send(body as object);

  // --- Case 1: a missing/blank project is a 400, no outbound call ----------

  it('400s a missing, empty or blank project, with no outbound call at all', async () => {
    const sent = stubDashboard();
    for (const body of [{}, { project: '' }, { project: '   ' }]) {
      const res = await post(body).expect(400);
      expect(res.body).toEqual({ error: 'project is required' });
    }
    expect(sent).toEqual([]);
  });

  // --- Case 2: BM_AGENTS off ------------------------------------------------

  it('404s without any outbound call when BM_AGENTS is off', async () => {
    const sent = stubDashboard();
    process.env.BM_AGENTS = 'off';
    const res = await post({ project: projectPath }).expect(404);
    expect(res.body).toEqual({ error: 'not found' });
    expect(sent).toEqual([]);
  });

  // --- Case 3: the dashboard is unreachable ---------------------------------

  it('502s an unreachable dashboard, without spawning', async () => {
    const sent: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      sent.push(String(input));
      return Promise.reject(new Error('ECONNREFUSED'));
    }) as jest.Mock;

    const res = await post({ project: projectPath }).expect(502);
    expect(res.body.error).toContain('unreachable');
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Case 4: project invisible to the dashboard ---------------------------
  // The `error` string is asserted against a live call to projectDispatchGate
  // itself, per the brief, rather than a string literal copied out of it —
  // a literal here would be a second copy of a string that already has one
  // owner (shared/agent.ts), and it is exactly the copy that would go stale
  // the next time that wording changes.

  it('refuses a project the dashboard cannot see, with projectDispatchGate\'s own wording', async () => {
    const sent: Sent[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, init });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          url.endsWith('/api/management')
            ? { projects: [] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
        )
      } as Response);
    }) as jest.Mock;

    const visibleStatus: AgentsStatus = {
      enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
      spawnMaxPermission: 'acceptEdits', projectPaths: []
    };
    const gate = projectDispatchGate(visibleStatus, projectPath);
    if (gate.control !== 'disabled') throw new Error('test setup: expected a disabled gate');

    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: gate.reason });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Case 5 & 6: nothing to resume -----------------------------------------

  it('409s with no crashed run when there is no run.json for the project', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no crashed run to resume for this project' });
    expect(res.body.code).toBeUndefined();
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it('409s the same way for a run that has already finished (status: done)', async () => {
    const sent = stubDashboard();
    writeRun({ ...fixture, project: projectPath, status: 'done' });
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no crashed run to resume for this project' });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Case 7: the run is alive, not crashed --------------------------------

  it('409s a fresh running run with RUN_IN_PROGRESS_CODE, naming the runId and heartbeat, no spawn', async () => {
    const sent = stubDashboard();
    const updatedAt = new Date().toISOString();
    writeRun({ ...fixture, project: projectPath, status: 'running', updatedAt });

    const res = await post({ project: projectPath }).expect(409);
    expect(res.body.code).toBe(RUN_IN_PROGRESS_CODE);
    expect(res.body.error).toContain(fixture.runId);
    expect(res.body.error).toContain(updatedAt);
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Case 8: the crashed run this endpoint exists to fix ------------------

  it('resumes a stale running run — one spawn, the constant prompt, the resume name, auto clamped to auto', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    const res = await post({ project: projectPath }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });

    const spawns = sent.filter((s) => s.url.endsWith('/api/spawn'));
    expect(spawns).toHaveLength(1);
    const body = JSON.parse(String(spawns[0].init?.body));
    expect(body).toEqual({
      project: '-abs-alpha',
      prompt: '/backlog-orchestrate --resume',
      name: `resume · ${basename(projectPath)}`,
      permissionMode: 'auto'
    });
  });

  // --- Case 9: the ceiling clamps the mode down -----------------------------

  it('clamps the resume spawn down to a stricter ceiling', async () => {
    const sent = stubDashboard({ ok: true }, 'acceptEdits');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    await post({ project: projectPath }).expect(201);
    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    const body = JSON.parse(String(spawn?.init?.body));
    expect(body.permissionMode).toBe('acceptEdits');
  });

  // --- Case 10: nothing from the body reaches the spawn but `project` -------

  it('drops a caller-supplied prompt, ids and model — only the constant prompt reaches the dashboard', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    await post({
      project: projectPath, prompt: 'rm -rf /', ids: ['x'], model: 'opus'
    }).expect(201);

    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    const body = JSON.parse(String(spawn?.init?.body));
    expect(body).toEqual({
      project: '-abs-alpha',
      prompt: '/backlog-orchestrate --resume',
      name: `resume · ${basename(projectPath)}`,
      permissionMode: 'auto'
    });
  });

  // --- Case 11: the same-origin POST guard ----------------------------------
  // Mirrors the assertion style of test/agents-origin-guard.test.ts's own
  // cross-origin case against plan/dispatch/orchestrate.

  it('403s a cross-origin JSON POST without any outbound call', async () => {
    const sent = stubDashboard();
    const res = await request(app.getHttpServer())
      .post('/api/agents/resume')
      .set('origin', 'http://evil.example')
      .send({ project: projectPath })
      .expect(403);
    expect(res.body.error).toMatch(/cross-origin/);
    expect(sent).toEqual([]);
  });

  // --- Case 12: the dashboard's own spawn rejection is relayed verbatim ----

  it('relays a busy dashboard\'s 429 verbatim', async () => {
    const sent = stubDashboard({ ok: false, status: 429, body: { error: 'busy' } }, 'auto');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    const res = await post({ project: projectPath }).expect(429);
    expect(res.body).toEqual({ error: 'busy' });
    expect(sent.filter((s) => s.url.endsWith('/api/spawn'))).toHaveLength(1);
  });

  // --- Case 13: the watchdog origin, called directly on the service --------
  // The sweeper's own caller, unreachable through the HTTP route (that one
  // always passes 'board' — see AgentsController.resume) — so this is the
  // one case in this suite that talks to AgentsService directly rather than
  // through supertest.

  it('names the session "watchdog resume · <basename>" when the service is called with origin "watchdog"', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    const agents = app.get(AgentsService);
    const result = await agents.resume(projectPath, 'watchdog');
    expect(result).toEqual({ sessionId: 'sess-1' });

    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    const body = JSON.parse(String(spawn?.init?.body));
    expect(body.name).toBe(`watchdog resume · ${basename(projectPath)}`);
  });
});
