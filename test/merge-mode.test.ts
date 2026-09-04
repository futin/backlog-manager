import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import type { OrchestratorRun } from '../shared/types';

// Same translation orchestrator-runs.test.ts and orchestrator-start.test.ts
// already do: the fixture is plain JSON, so TS would otherwise widen its
// string fields to `string` instead of the narrower literal unions
// (`RunStage`, `MergeMode`, etc).
const fixture = rawFixture as OrchestratorRun;

interface Sent { url: string; init?: RequestInit }

let projectPath: string;

/**
 * Same shape as orchestrator-start.test.ts's own stubDashboard — duplicated
 * rather than imported, matching this repo's existing convention that every
 * e2e suite owns its own fixtures and stubs (that file's own comment makes
 * the identical choice against agents-dispatch.test.ts). The three URLs it
 * answers (/api/health, /api/management, /api/spawn) are every call
 * AgentsService.orchestrate can make.
 */
function stubDashboard(
  spawn: { ok: boolean; status?: number; body?: unknown } = { ok: true }
): Sent[] {
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

/**
 * Task 4's own suite: the nine cases task-4-brief.md's table lays out for
 * `POST /api/agents/orchestrate`'s new `mergeMode` field — absent/valid/
 * invalid handling (design §2.3) and the composed spawn prompt (§2.4).
 * A separate file from orchestrator-start.test.ts (which already covers the
 * gate ladder and the `ids` selector at 600+ lines) rather than appended to
 * it, per the brief's own file list. Case 9 — the field-by-field controller
 * rebuild — is the one case that extends an existing assertion in that file
 * instead of repeating it here, also per the brief.
 */
describe('POST /api/agents/orchestrate — mergeMode', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  const realFetch = global.fetch;

  // The exact layout orchestrate.mjs's own projectDir()/runFilePath() write —
  // duplicated from orchestrator-start.test.ts for the same reason as its
  // own comment: orchestrate.mjs is a standalone script with no exported
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
    // Two open bugs — enough for case 5's ids list (`bug-1`, `bug-2`)
    // without pulling in orchestrator-start.test.ts's wider fixture (a
    // second project, an archived task, an idea): this suite never tests
    // the `ids` membership rules themselves, only that a resolved ids list
    // and a resolved mergeMode compose onto the prompt in the right order.
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-bug.md', content: item('bug-1', 'a bug', '## Cause\n\nknown\n\n## Fix\n\ndo it\n') },
      { leaf: 'bugs/open', filename: 'bug-2-a-bug.md', content: item('bug-2', 'another bug', '## Cause\n\nknown\n\n## Fix\n\ndo it\n') }
    ]);

    // A fresh, empty BM_ORCH_HOME per test — never the developer's real
    // ~/.backlog-manager/orchestrator/.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-merge-mode-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;

    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_AGENTS_TOKEN = 's3cret';

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

  /** The prompt the dashboard was asked to start, or undefined if nothing
   *  was spawned at all — the same helper orchestrator-start.test.ts's own
   *  `ids` block uses, since a composed prompt is this whole feature's
   *  entire surface on this side. */
  function spawnedPrompt(sent: Sent[]): string | undefined {
    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    if (!spawn) return undefined;
    return JSON.parse(String(spawn.init?.body)).prompt as string;
  }

  // --- Cases 1-3: absent, 'merge', and '' are all byte-identical to today --

  it('case 1: an absent mergeMode composes the bare prompt', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  it("case 2: mergeMode: 'merge' composes the bare prompt, same as absent", async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, mergeMode: 'merge' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  it("case 3: mergeMode: '' composes the bare prompt, same as absent", async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, mergeMode: '' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  // --- Case 4: 'branch' appends the flag, and only the flag -----------------

  it("case 4: mergeMode: 'branch' appends the literal --merge-mode branch", async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, mergeMode: 'branch' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate --merge-mode branch');
  });

  // --- Case 5: ids first, the merge-mode flag last ---------------------------

  it('case 5: a selected ids list is followed by the merge-mode flag, in that order', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, ids: ['bug-1', 'bug-2'], mergeMode: 'branch' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate bug-1 bug-2 --merge-mode branch');
  });

  // --- Case 6: an unrecognised mergeMode is a 400, never a silent fallback -
  //
  // The asymmetry with `model`/`effort` (which drop an unrecognised value via
  // `pickFrom`) is the point of this whole feature's server-side rule:
  // dropping `mergeMode` here would resolve it to 'merge' by falling into
  // the absent case, and merging to `main` is the irreversible direction —
  // a caller bug must never be able to select it silently. 'nope' must 400,
  // not run in merge mode by accident.

  it("case 6: mergeMode: 'nope' 400s, uncoded, and spawns nothing", async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, mergeMode: 'nope' }).expect(400);
    expect(res.body.error).toMatch(/mergeMode/);
    // RUN_IN_PROGRESS_CODE stays the one and only coded 409 this endpoint
    // gives — nothing about a malformed enum needs telling apart from any
    // other 4xx, so this 400 carries no `code` at all.
    expect(res.body.code).toBeUndefined();
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Case 7: a non-string mergeMode gets the same 400, not a crash -------
  //
  // The request type says `string | undefined`, but the controller forwards
  // whatever the body actually contained — a `Partial` type cannot rule out
  // a JSON number reaching this field at runtime, the same gap
  // orchestrator-start.test.ts's own "floors a non-string permissionMode"
  // case exists to cover for that neighbouring field. Unlike permissionMode,
  // this field rejects rather than floors — see case 6's comment.

  it('case 7: a non-string mergeMode (42) 400s, and spawns nothing', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, mergeMode: 42 }).expect(400);
    expect(res.body.error).toMatch(/mergeMode/);
    expect(res.body.code).toBeUndefined();
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Case 8: the run-in-progress lock wins over a malformed mergeMode ----
  //
  // Same ordering point orchestrator-start.test.ts's own "lets the
  // run-in-progress lock win over an ids problem" case makes for `ids`: the
  // activeRun lock is the ONLY 409 this endpoint codes, and OrchestrateSheet
  // branches on that code to close itself and hand the screen to the run
  // strip. A stale board tab must be told a run is already going, not that
  // its enum is malformed — so a request carrying BOTH problems must answer
  // with the lock's coded 409, never the mergeMode 400. The mergeMode value
  // here is deliberately invalid so that only ordering can produce the
  // coded response.

  it('case 8: a fresh run in progress wins over an invalid mergeMode, with RUN_IN_PROGRESS_CODE', async () => {
    const sent = stubDashboard();
    writeRun({ ...fixture, project: projectPath, updatedAt: new Date().toISOString() });

    const res = await post({ project: projectPath, mergeMode: 'nope' }).expect(409);
    expect(res.body.code).toBe(RUN_IN_PROGRESS_CODE);
    expect(res.body.error).toContain(fixture.runId);
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });
});
