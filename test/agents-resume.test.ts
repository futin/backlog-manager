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
import {
  pauseRequestEffective, readPauseRequest, writePauseRequest
} from '../server/src/orchestrator/pause-control.util';
import { RUN_IN_PROGRESS_CODE, RUN_STALE_MS } from '../shared/types';
import { WatchdogStateService } from '../server/src/orchestrator/watchdog-state.service';
import type { AgentsStatus, OrchestratorRun } from '../shared/types';

// Same translation orchestrator-start.test.ts already does: the fixture is
// plain JSON, so TS would otherwise widen its string fields to `string`
// instead of the narrower literal unions (`RunStage`, `MergeMode`, etc).
const fixture = rawFixture as OrchestratorRun;

let projectPath: string;

interface Sent { url: string; init?: RequestInit }

/* The two shapes a rejected `fetch` actually arrives as, measured on Node 22
   while grooming bug-26: a connection failure is a `TypeError` whose message
   is the useless literal `fetch failed`, the detail living only in `.cause`;
   the `AbortSignal.timeout` path is a `DOMException` naming no budget.
   Duplicated per suite, exactly as the stub above them already is. */
const CONN_REFUSED = Object.assign(new TypeError('fetch failed'), {
  cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:4173' }
});
const SPAWN_TIMED_OUT = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

/**
 * Same shape as orchestrator-start.test.ts's own stubDashboard — duplicated
 * rather than imported, matching this repo's existing convention of every
 * e2e suite owning its own fixtures and stubs rather than sharing test
 * infrastructure across files. The three URLs it answers (/api/health,
 * /api/management, /api/spawn) are every call AgentsService.resume can make,
 * same as orchestrate.
 */
function stubDashboard(
  spawn: { ok?: boolean; status?: number; body?: unknown; reject?: unknown } = {},
  ceiling: string = 'acceptEdits'
) {
  const sent: Sent[] = [];
  const ok = spawn.ok ?? true;
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
      // `reject` fails the spawn call ALONE, health and /api/management still
      // resolving — the shape bug-26 was invisible in, since case 3 below
      // rejects every fetch and so never reaches spawn() at all.
      if ('reject' in spawn) return Promise.reject(spawn.reject);
      return Promise.resolve({
        ok, status: spawn.status ?? (ok ? 200 : 429),
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
  let controlRoot: string;
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
    // task-17: resume() deletes this project's pause request after a
    // successful spawn, so this suite writes into a scratch directory of its
    // own rather than the process-wide default env.ts sets.
    controlRoot = join(tmpRoot, 'settings', 'orchestrator-control');
    process.env.BM_ORCH_CONTROL_HOME = controlRoot;

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

  it('409s with nothing to resume when there is no run.json for the project', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no crashed or paused run to resume for this project' });
    expect(res.body.code).toBeUndefined();
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it('409s the same way for a run that has already finished (status: done)', async () => {
    const sent = stubDashboard();
    writeRun({ ...fixture, project: projectPath, status: 'done' });
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no crashed or paused run to resume for this project' });
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
      name: `resume ${basename(projectPath)}`,
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

  // --- Case 9b/9c (bug-26): the spawn call itself rejects -------------------
  // Case 3 above rejects every fetch, so the environment gate refuses on the
  // health probe and spawn() is never entered. These two get all the way
  // there and fail the spawn call alone — the path that answered a bare
  // `{ statusCode: 500, message: 'Internal server error' }`, which the client
  // degrades to `request failed (500)`. Asserting `statusCode` is absent is
  // what pins "not the Nest default shape"; the status alone would pass
  // against a filter that merely relabelled the number.

  it('502s with the connection detail when the resume spawn fetch is refused', async () => {
    stubDashboard({ reject: CONN_REFUSED });
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    const res = await post({ project: projectPath }).expect(502);
    expect(res.body.error).toContain('ECONNREFUSED');
    expect(res.body.statusCode).toBeUndefined();
  });

  it('502s naming the timeout budget when the resume spawn fetch times out', async () => {
    stubDashboard({ reject: SPAWN_TIMED_OUT });
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    const res = await post({ project: projectPath }).expect(502);
    expect(res.body.error).toContain('10000');
    expect(res.body.error).toMatch(/timed out/);
    expect(res.body.error).not.toContain('The operation was aborted');
    expect(res.body.statusCode).toBeUndefined();
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
      name: `resume ${basename(projectPath)}`,
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

  it('names the session "watchdog resume <basename>" when the service is called with origin "watchdog"', async () => {
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
    expect(body.name).toBe(`watchdog resume ${basename(projectPath)}`);
  });
  /* task-17 — a `paused` run is the second thing this endpoint resumes, and
     the FIRST one whose resume is an ordinary, expected event rather than a
     recovery from a crash. The spawn body is deliberately identical: a
     resume is the same run picking up where it stopped, and nothing about
     WHY it stopped changes what the resumed session is told to do. */

  it('resumes a paused run with the byte-identical spawn body a crashed one gets', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    writeRun({ ...fixture, project: projectPath, status: 'paused', updatedAt: new Date().toISOString() });

    const res = await post({ project: projectPath }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });

    const spawns = sent.filter((s) => s.url.endsWith('/api/spawn'));
    expect(spawns).toHaveLength(1);
    expect(JSON.parse(String(spawns[0].init?.body))).toEqual({
      project: '-abs-alpha',
      prompt: '/backlog-orchestrate --resume',
      name: `resume ${basename(projectPath)}`,
      permissionMode: 'auto'
    });
  });

  // Tidiness, not correctness: the resumed session's own `unpause` is what
  // actually retires the request (its `unpausedAt` stamp moves past it). This
  // clears the file early so a `status` call in between does not report a
  // pause that is already being undone.
  it('clears the pause request after a successful resume', async () => {
    stubDashboard({ ok: true }, 'auto');
    writeRun({ ...fixture, project: projectPath, status: 'paused', updatedAt: new Date().toISOString() });
    writePauseRequest(projectPath, fixture.runId, new Date(), controlRoot);

    await post({ project: projectPath }).expect(201);

    expect(readPauseRequest(projectPath, controlRoot)).toBeNull();
  });

  // The clear happens AFTER the spawn, so a spawn that never happened leaves
  // the request alone — the run is still paused, and the board must still
  // show it that way.
  /* The Critical finding from this branch's own review, pinned. The clear
     above is guarded on `status === 'paused'`, and this is the case that
     guard exists for: a CRASHED run's request has never been seen by
     anything — the run died before reaching a dispatch gate, and neither the
     watchdog nor this route reads the control file to decide anything. The
     resumed session is what honours it, by exiting `6` at its first gate
     (design §4.4). Deleting it here would silently drain the whole queue
     against a pause somebody explicitly asked for. */
  it('leaves a crashed run\'s pause request in place — the resumed session is what honours it', async () => {
    stubDashboard({ ok: true }, 'auto');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });
    writePauseRequest(projectPath, fixture.runId, new Date(), controlRoot);

    await post({ project: projectPath }).expect(201);

    const survived = readPauseRequest(projectPath, controlRoot);
    expect(survived).not.toBeNull();
    // Still EFFECTIVE, not merely present: a file left on disk that the
    // predicate would refuse is the same failure with an extra step.
    expect(pauseRequestEffective(survived, {
      runId: fixture.runId, startedAt: fixture.startedAt, unpausedAt: undefined
    })).toBe(true);
  });

  it('leaves the pause request in place when the spawn fails', async () => {
    stubDashboard({ ok: false, status: 429, body: { error: 'busy' } }, 'auto');
    writeRun({ ...fixture, project: projectPath, status: 'paused', updatedAt: new Date().toISOString() });
    writePauseRequest(projectPath, fixture.runId, new Date(), controlRoot);

    await post({ project: projectPath }).expect(429);

    expect(readPauseRequest(projectPath, controlRoot)).not.toBeNull();
  });

  it('409s a paused run the same way as a done one when asked to PAUSE it, but resumes it here', async () => {
    // The asymmetry stated as a test: `paused` is resumable and un-pausable.
    // (The pause half lives in agents-pause.test.ts; this half is the one
    // that would break if the widened 409 condition were written as
    // `status !== 'running' && status !== 'paused'` in only one of the two.)
    stubDashboard({ ok: true }, 'auto');
    writeRun({ ...fixture, project: projectPath, status: 'aborted', updatedAt: new Date().toISOString() });
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no crashed or paused run to resume for this project' });
  });

  // The watchdog only ever watches `running` runs, and a paused run is not
  // one — so its payload entry must carry no watchdog record at all, or the
  // strip would draw a crashed run's "attempt 1 of 3" under a run nobody is
  // rescuing.
  it('leaves a resumed paused run without a watchdog key on the runs payload', async () => {
    stubDashboard({ ok: true }, 'auto');
    writeRun({ ...fixture, project: projectPath, status: 'paused', updatedAt: new Date().toISOString() });

    await post({ project: projectPath }).expect(201);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    const entry = res.body.runs.find((r: { project: string }) => r.project === projectPath);
    expect('watchdog' in entry).toBe(false);
  });
  // --- bug-19: the resume lock -------------------------------------------
  // The gap these close: `resume()`'s only run-level refusal was `run.fresh`,
  // and a crashed run stays crashed for the ~90s a resumed session needs to
  // reach its first heartbeat — so every call arriving in that window saw the
  // identical stale run and every one spawned. Three sessions inside ten
  // seconds is what that actually looked like on run-20260905-113818, and
  // they were harmless only because a spend limit killed all three ~600ms in.
  //
  // The lock is `WatchdogEntry.resumeSpawnAt`, taken SYNCHRONOUSLY — checked
  // and stamped in one run of the event loop, before any further `await` —
  // which is the whole reason these cases fire their requests without
  // awaiting the first: a check that sits on the far side of an await lets
  // every concurrent caller through, which is precisely what
  // `noteBoardResume`'s after-the-await placement already did.

  it('serializes concurrent resumes of one crashed run — one spawn, the rest an uncoded 409', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });

    // Occurrence 1's own shape: three clicks, none of them awaiting the
    // previous answer.
    const responses = await Promise.all([
      post({ project: projectPath }),
      post({ project: projectPath }),
      post({ project: projectPath })
    ]);

    expect(sent.filter((s) => s.url.endsWith('/api/spawn'))).toHaveLength(1);

    const ok = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      // Uncoded, deliberately: RUN_IN_PROGRESS_CODE means "a run is alive for
      // this project right now", which is false here — the run is crashed and
      // a resume is on its way to it. The strip treats that code as a silent
      // success, which is exactly the wrong reaction to this refusal.
      expect(r.body.code).toBeUndefined();
      expect(r.body.error).toContain('resume');
      expect(r.body.error).toContain(fixture.runId);
    }
  });

  it('takes no lock when the spawn itself fails, so the next click still spawns', async () => {
    // A spawn that threw started no session: leaving the stamp behind would
    // silence the board's only resume control for a full RUN_STALE_MS because
    // the dashboard was briefly down.
    stubDashboard({ reject: CONN_REFUSED });
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });
    await post({ project: projectPath }).expect(502);

    const sent = stubDashboard({ ok: true }, 'auto');
    await post({ project: projectPath }).expect(201);
    expect(sent.filter((s) => s.url.endsWith('/api/spawn'))).toHaveLength(1);
  });

  it('stops locking RUN_STALE_MS after the stamp — the app\'s one freshness number, not a second one', async () => {
    const first = stubDashboard({ ok: true }, 'auto');
    writeRun({
      ...fixture, project: projectPath, status: 'running',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });
    await post({ project: projectPath }).expect(201);
    expect(first.filter((s) => s.url.endsWith('/api/spawn'))).toHaveLength(1);

    // Still locked a moment later...
    await post({ project: projectPath }).expect(409);

    // ...and no longer locked once the stamp is older than RUN_STALE_MS. Aged
    // through the service rather than by faking the clock: a resumed session
    // that has not heartbeated in fifteen minutes is dead by this app's own
    // definition, and a second resume is then the right answer.
    const state = app.get(WatchdogStateService);
    const entry = state.entry(fixture.runId);
    expect(entry?.resumeSpawnAt).not.toBeNull();
    entry!.resumeSpawnAt = new Date(Date.now() - (RUN_STALE_MS + 1_000)).toISOString();

    const second = stubDashboard({ ok: true }, 'auto');
    await post({ project: projectPath }).expect(201);
    expect(second.filter((s) => s.url.endsWith('/api/spawn'))).toHaveLength(1);
  });

  it('serializes a paused run\'s resumes too — the lock is per run, not per crash', async () => {
    // Two tabs on the Runs view, both showing the same paused run: the
    // per-component `busy` guard cannot see across them, so this is the only
    // layer that can refuse the second click.
    const sent = stubDashboard({ ok: true }, 'auto');
    writeRun({ ...fixture, project: projectPath, status: 'paused', updatedAt: new Date().toISOString() });

    const responses = await Promise.all([
      post({ project: projectPath }),
      post({ project: projectPath })
    ]);
    expect(sent.filter((s) => s.url.endsWith('/api/spawn'))).toHaveLength(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
  });
});
