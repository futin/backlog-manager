import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import type { OrchestratorRun } from '../shared/types';

// Same translation orchestrator-runs.test.ts (Task 8) already does: the
// fixture is plain JSON, so TS would otherwise widen its string fields to
// `string` instead of the narrower literal unions (`RunStage`, etc).
const fixture = rawFixture as OrchestratorRun;

let projectPath: string;

interface Sent { url: string; init?: RequestInit }

/**
 * Same shape as agents-dispatch.test.ts's own stubDashboard — duplicated
 * rather than imported, matching this repo's existing convention of every
 * e2e suite owning its own fixtures and stubs rather than sharing test
 * infrastructure across files (agents-dispatch.test.ts and
 * agents-origin-guard.test.ts already do this independently of each other).
 * The three URLs it answers (/api/health, /api/management, /api/spawn) are
 * every call AgentsService.orchestrate can make, same as dispatch.
 */
function stubDashboard(spawn: { ok: boolean; status?: number; body?: unknown } = { ok: true }) {
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
          : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
      )
    } as Response);
  }) as jest.Mock;
  return sent;
}

describe('POST /api/agents/orchestrate', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  const realFetch = global.fetch;

  // The exact layout orchestrate.mjs's own projectDir()/runFilePath() write,
  // and the same helper orchestrator-runs.test.ts (Task 8) already uses:
  // <root>/<encodeURIComponent(absolute project path)>/run.json. Duplicated
  // here rather than imported for the same reason as that file's own
  // comment — orchestrate.mjs is a standalone script with no exported
  // package boundary into this TS project.
  function projectDir(project: string): string {
    return join(orchHome, encodeURIComponent(project));
  }

  function writeRun(run: OrchestratorRun): void {
    const dir = projectDir(run.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  beforeEach(async () => {
    projectPath = makeProject('alpha', []);

    // A fresh, empty BM_ORCH_HOME per test — never the developer's real
    // ~/.backlog-manager/orchestrator/. Deliberately not created here (only
    // its parent is): a project with no run yet has no directory at all,
    // and orchestrate() must treat that as "no fresh run" rather than fail.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-start-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;

    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_AGENTS_TOKEN = 's3cret';

    // REGISTRY_FILE overridden the same way every other e2e suite here does
    // it: AppModule also wires up ItemsModule, and leaving this on its
    // real-machine default would read the developer's actual registry.
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
    request(app.getHttpServer()).post('/api/agents/orchestrate').send(body as object);

  // --- Test case 1: BM_AGENTS off -----------------------------------------

  it('404s without any outbound call when BM_AGENTS is off', async () => {
    const sent = stubDashboard();
    process.env.BM_AGENTS = 'off';
    const res = await post({ project: projectPath }).expect(404);
    expect(res.body.error).toBe('not found');
    expect(sent).toEqual([]);
  });

  // --- Test cases 2 & 3: the same-origin POST guard -----------------------
  // Mirrors the assertion style of test/agents-origin-guard.test.ts's own
  // per-route cases (wrong content-type, cross-origin, and the "absent
  // Origin is allowed" semantics), against this new route rather than
  // plan/dispatch.

  it('403s a urlencoded POST without any outbound call', async () => {
    const sent = stubDashboard();
    const res = await request(app.getHttpServer())
      .post('/api/agents/orchestrate')
      .type('form')
      .send({ project: projectPath })
      .expect(403);
    expect(res.body.error).toMatch(/application\/json/);
    expect(sent).toEqual([]);
  });

  it('403s a cross-origin JSON POST without any outbound call', async () => {
    const sent = stubDashboard();
    const res = await request(app.getHttpServer())
      .post('/api/agents/orchestrate')
      .set('origin', 'http://evil.example')
      .send({ project: projectPath })
      .expect(403);
    expect(res.body.error).toMatch(/cross-origin/);
    expect(sent).toEqual([]);
  });

  it('spawns for a same-origin JSON POST with no Origin header at all — curl, and this whole suite', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(true);
  });

  // --- Test case 4: project invisible to the dashboard --------------------

  it('refuses a project the dashboard cannot see, with the same refusal dispatch gives', async () => {
    const sent: Sent[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, init });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          // The dashboard is up and answering, but has no session in this
          // project at all — the same "not in projectPaths" condition
          // dispatchGate's `disabled` case refuses on for a per-item
          // dispatch (shared/agent.ts).
          url.endsWith('/api/management')
            ? { projects: [] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
        )
      } as Response);
    }) as jest.Mock;

    const res = await post({ project: projectPath }).expect(409);
    expect(res.body.error).toContain(projectPath);
    expect(res.body.error).toMatch(/cannot see/);
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
    // Fix round 2: this 409 must NOT carry the activeRun lock's `code` —
    // OrchestrateSheet's own fix-round-2 case for this exact scenario
    // (test/orchestrator-start-ui.test.tsx) depends on this response
    // staying uncoded, or a client-side check would be validated against
    // a server that quietly stopped honouring its own contract.
    expect(res.body.code).toBeUndefined();
  });

  // --- Fix round 1: the other three environmentBlock reasons ---------------
  // An earlier version of orchestrate() checked only `enabled` and project
  // visibility, silently skipping `reachable`, `spawnAvailable` and
  // `remoteAnswer` — so an unreachable dashboard fell through to a flatly
  // wrong "cannot see this project" refusal, and a spawn-unavailable or
  // remote-answers-off dashboard let an actual spawn attempt through that
  // dispatch would have refused first. These two are the ones the review
  // asked for explicitly; `remoteAnswer` shares environmentBlock's own
  // unit coverage (test/agents-shared.test.ts) and dispatch's existing e2e
  // case (test/agents-dispatch.test.ts, "refuses when the dashboard has
  // remote answers off"), so it is not re-proven a third time here.

  it('502s an unreachable dashboard, without spawning', async () => {
    const sent: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      sent.push(String(input));
      // Every call rejects, /api/health included — the same shape
      // agents-dispatch.test.ts's own "502s when the dashboard is
      // unreachable" case uses.
      return Promise.reject(new Error('ECONNREFUSED'));
    }) as jest.Mock;

    const res = await post({ project: projectPath }).expect(502);
    expect(res.body.error).toContain('unreachable');
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  it('409s a dashboard with no CLAUDE_BIN configured, without spawning', async () => {
    const sent: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          url.endsWith('/api/management')
            // The project IS visible here — proving this refusal fires
            // for spawnAvailable specifically, not as a side effect of
            // failing the later project-visibility check too.
            ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: true, spawnAvailable: false, spawnMaxPermission: 'acceptEdits' }
        )
      } as Response);
    }) as jest.Mock;

    const res = await post({ project: projectPath }).expect(409);
    expect(res.body.error).toMatch(/CLAUDE_BIN/);
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(false);
    // Same fix-round-2 pin as the project-invisible case above: uncoded.
    expect(res.body.code).toBeUndefined();
  });

  // --- Test case 5: a fresh run already exists -----------------------------

  it('409s a fresh running run for the project, naming the runId, without spawning', async () => {
    const sent = stubDashboard();
    writeRun({ ...fixture, project: projectPath, updatedAt: new Date().toISOString() });

    const res = await post({ project: projectPath }).expect(409);
    expect(res.body.error).toContain(fixture.runId);
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Fix round 2: the lock 409 alone carries a machine-readable code -----
  // The case just above already proves the human-readable `error` string;
  // this is the one this whole fix round exists for — OrchestrateSheet's
  // client-side check (RUN_IN_PROGRESS_CODE, shared/types.ts) has nothing
  // to check against if this ever regresses to sending the bare `{ error }`
  // fix round 1 shipped.
  it('carries RUN_IN_PROGRESS_CODE on the activeRun lock 409, and only there', async () => {
    const sent = stubDashboard();
    writeRun({ ...fixture, project: projectPath, updatedAt: new Date().toISOString() });

    const res = await post({ project: projectPath }).expect(409);
    expect(res.body.code).toBe(RUN_IN_PROGRESS_CODE);
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Test case 6: a stale run does not block a new one -------------------

  it('spawns when the only run.json on disk is stale', async () => {
    const sent = stubDashboard();
    writeRun({
      ...fixture,
      project: projectPath,
      updatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    });

    const res = await post({ project: projectPath }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(true);
  });

  // --- Test case 7: the outbound body, exactly ------------------------------

  /* A `prompt` and an unrecognised `model` in the request must not survive
     to the dashboard: the prompt is a server-side constant (dispatch's
     "derive, never accept" rule applied to orchestration — the client
     cannot choose what a headless, unattended session is told to do), and
     an unrecognised model is dropped exactly as dispatch drops one, never
     rejected. `toEqual` against the full parsed body — not a handful of
     `toContain`/`toBe` field checks — is what proves nothing beyond the six
     expected keys rides along silently (a `remoteControl`, the request's
     own `prompt`) and that `name` is exactly what orchestrateSessionName
     produces, not merely present; a wider, narrower, or differently-valued
     object than expected fails this either way. */
  it('spawns with the constant prompt and drops the client-supplied prompt and unknown model', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, prompt: 'rm -rf', model: 'claude-x' }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });

    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    expect(spawn).toBeDefined();
    const body = JSON.parse(String(spawn?.init?.body));
    expect(body).toEqual({
      // The dashboard's own dirName, never the absolute path — see
      // dispatch's identical assertion in agents-dispatch.test.ts for why.
      project: '-abs-alpha',
      prompt: '/backlog-orchestrate',
      // orchestrateSessionName's own output: 'orchestrate ' plus the
      // project path's basename (makeProject's tmp dir, not a clean
      // registry display name — this is why the expectation is computed
      // rather than a literal string like dispatch's test can use).
      name: `orchestrate ${basename(projectPath)}`,
      // No permissionMode was sent; the ceiling here is 'acceptEdits', and
      // an absent/unrecognised mode floors to the ladder's lowest allowed
      // rung ('plan'), the same rule clampMode applies for dispatch.
      permissionMode: 'plan'
      // model/effort are absent entirely, not merely falsy: JSON.stringify
      // drops an undefined value outright, which is what proves the flag
      // never reaches the dashboard's argv at all.
    });
  });
});
