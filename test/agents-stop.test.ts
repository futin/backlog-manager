import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { readPauseRequest, writePauseRequest } from '../server/src/orchestrator/pause-control.util';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

const fixture = rawFixture as OrchestratorRun;

let projectPath: string;

/**
 * `POST /api/agents/stop` (bug-39) — `pause`'s sibling in every respect but
 * one, and this suite is organised around that one.
 *
 * A pause records a fact and stops there. A stop records a fact AND attempts
 * one spawn, so the two outcomes are separable and the assertions keep them
 * separate throughout: `stopRequested` is what landed on disk and is
 * guaranteed; `abortSession`/`abortRefused` are what became of the spawn and
 * are not. A route that collapsed them — a 502 when the dashboard is down,
 * say — would tell a caller the stop did not land when the half that
 * actually ends the run did.
 *
 * The dashboard is stubbed per case rather than shared, matching this repo's
 * convention that each e2e suite owns its own stub.
 */
describe('POST /api/agents/stop', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  let controlRoot: string;
  const env = { ...process.env };
  const realFetch = global.fetch;
  let sent: string[];

  function projectDir(project: string): string {
    return join(orchHome, encodeURIComponent(project));
  }

  function writeRun(run: OrchestratorRun): void {
    const dir = projectDir(run.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  const runningRun = (over: Partial<OrchestratorRun> = {}): OrchestratorRun => ({
    ...fixture,
    project: projectPath,
    status: 'running',
    updatedAt: new Date().toISOString(),
    ...over
  });

  /** A dashboard that answers everything, so a case asserting a REFUSAL is
   *  asserting this app's own decision rather than a stub that could not have
   *  succeeded anyway. */
  function stubDashboard(opts: { spawnOk?: boolean; reject?: boolean } = {}): void {
    sent = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      if (opts.reject) throw new Error('ECONNREFUSED');
      if (url.endsWith('/api/spawn')) {
        return {
          ok: opts.spawnOk ?? true,
          status: (opts.spawnOk ?? true) ? 200 : 429,
          json: () => Promise.resolve((opts.spawnOk ?? true) ? { sessionId: 'sess-abort' } : { error: 'too many launches in flight' })
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url.endsWith('/api/management')
              ? { projects: [{ dirName: '-abs-alpha', path: projectPath, name: 'alpha', lastActiveMs: 1 }] }
              : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' }
          )
      } as Response;
    }) as jest.Mock;
  }

  async function createApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // `listenLoopback`, never a bare `listen(0)` — see test/helpers/app.ts
    // and bug-33 for what the wildcard bind does to supertest's dial.
    await listenLoopback(app);
  }

  beforeEach(async () => {
    projectPath = makeProject('alpha', []);

    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-stop-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;
    controlRoot = join(tmpRoot, 'settings', 'orchestrator-control');
    process.env.BM_ORCH_CONTROL_HOME = controlRoot;

    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_WATCHDOG = 'off';

    stubDashboard();
    await createApp();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/agents/stop')
      .send(body as object);

  const spawns = () => sent.filter((url) => url.endsWith('/api/spawn'));

  it('400s a missing, empty or blank project', async () => {
    for (const body of [{}, { project: '' }, { project: '  ' }]) {
      const res = await post(body).expect(400);
      expect(res.body).toEqual({ error: 'project is required' });
    }
    expect(spawns()).toHaveLength(0);
  });

  it('409s when the project has no run at all', async () => {
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no running run to stop for this project' });
  });

  it.each([['done'], ['aborted'], ['failed'], ['paused']] as const)('409s a run whose status is already %s', async (status) => {
    writeRun(runningRun({ status }));
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no running run to stop for this project' });
    // Nothing written on a refusal, for pause's reason: a request naming a run
    // that cannot act on it would sit there and be judged against the NEXT
    // run of this project instead.
    expect(readPauseRequest(projectPath, controlRoot)).toBeNull();
    expect(spawns()).toHaveLength(0);
  });

  it('writes a stop pinned to the run and spawns one --abort session', async () => {
    writeRun(runningRun());

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body).toEqual({ stopRequested: true, abortSession: 'sess-abort', abortRefused: null });
    expect(readPauseRequest(projectPath, controlRoot)).toEqual({
      runId: fixture.runId,
      requestedAt: expect.any(String),
      kind: 'stop'
    });
    expect(spawns()).toHaveLength(1);
  });

  /**
   * bug-54 pins what the server KEEPS. A fresh run naming a driver is the one
   * that driver is about to end itself — its `watch` returns `10` and it runs
   * `--abort` — and the spawned session is then redundant, refused by
   * `orchestrate.mjs abort`'s own mark. Gating the spawn here instead would
   * strand a run whose driver dies after the stop lands, because the client
   * draws no second Stop once one is on file. So the spawn stays
   * unconditional; a liveness gate reintroduced here must come with a re-stop
   * control, and this case is what makes that a decision rather than a drift.
   */
  it('spawns the --abort session even for a fresh run whose driver is live', async () => {
    const now = new Date().toISOString();
    writeRun(runningRun({ updatedAt: now, driver: { sessionId: 'sess-driver', at: now } }));

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body).toEqual({ stopRequested: true, abortSession: 'sess-abort', abortRefused: null });
    expect(spawns()).toHaveLength(1);
    const call = (global.fetch as jest.Mock).mock.calls.find(([url]: [string]) => String(url).endsWith('/api/spawn'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body)).prompt).toBe('/backlog-orchestrate --abort');
  });

  /**
   * The case this whole bug is about. A driver killed by hand leaves a run
   * that is `running` with a dead heartbeat for fifteen minutes, and until
   * bug-39 nothing could end it: `abort` refused on the dead session's lease,
   * `init` refused the project, and the watchdog resumed it. `fresh` is
   * deliberately not part of this gate.
   */
  it('accepts a stale running run — the state this bug was filed about', async () => {
    writeRun(runningRun({ updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body.stopRequested).toBe(true);
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('stop');
  });

  it('spawns the documented trigger and nothing a caller could influence', async () => {
    writeRun(runningRun());
    await post({ project: projectPath, prompt: 'rm -rf /', ids: ['task-1'] }).expect(200);

    const call = (global.fetch as jest.Mock).mock.calls.find(([url]: [string]) => String(url).endsWith('/api/spawn'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
    // The prompt is a compile-time constant, so neither of the two fields the
    // request carried above can reach it. `project` is the dashboard's own
    // dirName, never the path — see "a project the dashboard cannot see
    // cannot be dispatched to".
    expect(body.prompt).toBe('/backlog-orchestrate --abort');
    expect(body.project).toBe('-abs-alpha');
    expect(body).not.toHaveProperty('ids');
  });

  /**
   * bug-53 — a stop cannot be withdrawn, and the route says so rather than
   * pretending. By the time a `cancel` could arrive, the request that recorded
   * the stop has already awaited the `--abort` spawn, so deleting the control
   * file would restore no child, no worktree, no branch and no run. Refused
   * with a 409 rather than dropped from the body, because an old client still
   * sends `cancel: true` from a `Cancel stop` chip, and a route that ignored
   * the flag would read that click as a SECOND stop — a second `--abort` spawn
   * into a run that is already ending.
   */
  it('refuses cancel: true, leaving the stop on file and spawning nothing', async () => {
    writeRun(runningRun());
    await post({ project: projectPath }).expect(200);
    sent = [];

    const res = await post({ project: projectPath, cancel: true }).expect(409);

    expect(res.body.error).toMatch(/cannot be withdrawn/);
    // Uncoded: RUN_IN_PROGRESS_CODE reads as a silent success to both of its
    // readers, and this is a refusal a person has to read.
    expect(res.body.code).toBeUndefined();
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('stop');
    expect(spawns()).toHaveLength(0);
  });

  /* Refused before the run is looked up: "a stop cannot be withdrawn" is true
     of every run, so a project with none gets the same answer rather than the
     no-run 409 that would suggest a withdrawal might work on another. */
  it('refuses cancel: true the same way for a project with no run', async () => {
    const res = await post({ project: projectPath, cancel: true }).expect(409);

    expect(res.body.error).toMatch(/cannot be withdrawn/);
    expect(spawns()).toHaveLength(0);
  });

  // `cancel` selects the direction that undoes a human's decision, so only the
  // strict boolean counts — the same strictness `pause` applies, for the same
  // reason.
  it('treats any non-boolean cancel as a stop, not a cancel', async () => {
    writeRun(runningRun());

    const res = await post({ project: projectPath, cancel: 'true' }).expect(200);

    expect(res.body.stopRequested).toBe(true);
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('stop');
  });

  /**
   * One control fact per project is ONE FILE, and last write wins in both
   * directions. Two files would be two facts to reconcile ("stopped but also
   * paused") and the reconciliation would be a third rule nobody reads.
   */
  it('overwrites a pause with a stop, and a stop with a pause', async () => {
    writeRun(runningRun());
    writePauseRequest(projectPath, fixture.runId, new Date(), controlRoot);
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('pause');

    await post({ project: projectPath }).expect(200);
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('stop');

    await request(app.getHttpServer()).post('/api/agents/pause').send({ project: projectPath }).expect(200);
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('pause');
  });

  /**
   * A gate refusal is a 200 carrying a sentence, never an error status. The
   * request is already on disk, the sweeper is already standing down on it and
   * `abort` will already take the lease on the strength of it — so the honest
   * answer names the one command a person can run instead.
   */
  it('reports a spawn refusal in the body and still records the stop', async () => {
    stubDashboard({ spawnOk: false });
    writeRun(runningRun());

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body.stopRequested).toBe(true);
    expect(res.body.abortSession).toBeNull();
    expect(res.body.abortRefused).toMatch(/--abort/);
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('stop');
  });

  it('reports an unreachable dashboard the same way, and still records the stop', async () => {
    stubDashboard({ reject: true });
    writeRun(runningRun());

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body.stopRequested).toBe(true);
    expect(res.body.abortSession).toBeNull();
    expect(res.body.abortRefused).toMatch(/--abort/);
  });

  /**
   * Independent of `BM_AGENTS`, for the reason `pause` is: gating it on that
   * switch would mean a run started while agents were on could never be ended
   * after somebody turned them off — the exact moment a person most wants to
   * end one. The spawn half simply does not happen, and says so.
   */
  it('works with agents off — the fact is recorded, only the spawn is refused', async () => {
    await app.close();
    delete process.env.BM_AGENTS;
    await createApp();
    writeRun(runningRun());

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body.stopRequested).toBe(true);
    expect(res.body.abortSession).toBeNull();
    expect(res.body.abortRefused).toMatch(/agents are off/);
    expect(readPauseRequest(projectPath, controlRoot)?.kind).toBe('stop');
    expect(spawns()).toHaveLength(0);
  });

  it('the runs payload reports the stop — and no pause — on the very next read', async () => {
    writeRun(runningRun());
    await post({ project: projectPath }).expect(200);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    const entry = res.body.runs.find((r: { project: string }) => r.project === projectPath);
    expect(entry.stopRequested).toBe(true);
    // Disjoint over one file: a stop is not also a pause, or the run would
    // take the cooperative path for a request whose whole point is that the
    // cooperative path is not reaching it.
    expect(entry.pauseRequested).toBe(false);
  });

  it('refuses a resume while a stop is on file', async () => {
    // Crashed: the shape `resume` otherwise accepts, so the refusal below is
    // attributable to the stop and to nothing else.
    writeRun(runningRun({ updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));
    await post({ project: projectPath }).expect(200);

    const res = await request(app.getHttpServer()).post('/api/agents/resume').send({ project: projectPath }).expect(409);

    expect(res.body.error).toMatch(/stop request/);
    // Uncoded, unlike the fresh-run refusal: both callers treat
    // RUN_IN_PROGRESS_CODE as a silent success, and this one needs a person
    // to read it — a stopped run is over, and its work is a new run's.
    expect(res.body.code).toBeUndefined();
  });
});
