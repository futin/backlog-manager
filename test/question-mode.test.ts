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
 * task-19's server suite: the resolution table (design §2.3) and the composed
 * spawn prompt (§2.4) for `POST /api/agents/orchestrate`'s new `questionMode`
 * field.
 *
 * A sibling file to `merge-mode.test.ts` rather than rows added to it, and a
 * deliberate departure from the plan's own file list, which named
 * `test/agents-prompt.test.ts` — that file covers `composePrompt`
 * (prompt.util.ts, the DISPATCH prompt) and has never carried a `mergeMode`
 * case, so the orchestrate prompt's real home on this side is here, beside
 * the field this one mirrors exactly.
 *
 * The prompt cases below are the load-bearing ones, and they are asserted as
 * whole strings rather than substrings on purpose: three of the five are
 * prompts this endpoint already composed before this field existed, so an
 * exact match is what makes them a byte-identity regression guard instead of
 * a test that would still pass with a stray flag appended.
 */
describe('POST /api/agents/orchestrate — questionMode', () => {
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
    // Two open bugs, the same narrow fixture merge-mode.test.ts uses and
    // for the same reason: this suite never tests the `ids` membership
    // rules themselves, only that a resolved ids list, a resolved
    // mergeMode and a resolved questionMode compose onto the prompt in
    // the right order.
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-bug.md', content: item('bug-1', 'a bug', '## Cause\n\nknown\n\n## Fix\n\ndo it\n') },
      { leaf: 'bugs/open', filename: 'bug-2-a-bug.md', content: item('bug-2', 'another bug', '## Cause\n\nknown\n\n## Fix\n\ndo it\n') }
    ]);

    // A fresh, empty BM_ORCH_HOME per test — never the developer's real
    // ~/.backlog-manager/orchestrator/.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-question-mode-'));
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


  // --- Resolution rows 1-3: absent, '' and 'park' all append nothing -------
  //
  // Inverted from merge mode's own silent value — `merge` there, `park` here
  // — because both follow the same underlying rule: the DEFAULT appends
  // nothing, so a default run's prompt stays byte-identical to what shipped
  // before the field existed.

  it('an absent questionMode composes the bare prompt', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  it("questionMode: '' composes the bare prompt, same as absent", async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, questionMode: '' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  it("questionMode: 'park' composes the bare prompt, same as absent", async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, questionMode: 'park' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  // --- Resolution row 4: 'decide' appends the flag, and only the flag ------

  it("questionMode: 'decide' appends the literal --question-mode decide", async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, questionMode: 'decide' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate --question-mode decide');
  });

  // --- Resolution rows 5-7: anything else is a 400, never a clamp ----------
  //
  // The same asymmetry with `model`/`effort` that `mergeMode` keeps, argued
  // in this field's own terms: dropping an unrecognised value would fall
  // into the absent branch and resolve to `park`, and that value is written
  // verbatim into `run.json` and read out of the archive months later. A
  // typo'd `decide` silently becoming `park` would put a claim in the
  // archive that no caller ever made.

  it("questionMode: 'Decide' 400s, uncoded, echoing the value it refused", async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, questionMode: 'Decide' }).expect(400);
    expect(res.body.error).toMatch(/questionMode/);
    expect(res.body.error).toContain('"Decide"');
    expect(res.body.code).toBeUndefined();
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it("questionMode: 'auto' 400s, uncoded, and spawns nothing", async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, questionMode: 'auto' }).expect(400);
    expect(res.body.error).toMatch(/questionMode/);
    expect(res.body.code).toBeUndefined();
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // A `Partial`-typed body cannot rule out a JSON number reaching this field
  // at runtime, so the echo has to render one sensibly — `42`, not `"42"`,
  // which is what `JSON.stringify` on the raw value gives and a template
  // literal would not.
  it('a non-string questionMode (42) 400s, rendering the number unquoted', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, questionMode: 42 }).expect(400);
    expect(res.body.error).toMatch(/questionMode/);
    expect(res.body.error).toContain('42');
    expect(res.body.error).not.toContain('"42"');
    expect(res.body.code).toBeUndefined();
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  // --- Ordering, and the byte-identity guard ------------------------------
  //
  // Ids first, then --merge-mode, then --question-mode. The order between
  // the two flags is immaterial to `orchestrate.mjs`'s own argv loop, and is
  // fixed here anyway for one reason: with --question-mode last, every
  // prompt this endpoint composed before today stays a byte-exact PREFIX of
  // what it composes now. Ids ahead of both flags is not a style choice —
  // the tool reads bare tokens as ids, so a flag ahead of them would swallow
  // the first id as its own argument.

  it('composes ids, then the merge-mode flag, then the question-mode flag', async () => {
    const sent = stubDashboard();
    await post({
      project: projectPath, ids: ['bug-1'], mergeMode: 'branch', questionMode: 'decide'
    }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate bug-1 --merge-mode branch --question-mode decide');
  });

  it('appends the question-mode flag after the merge-mode flag with no ids at all', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, mergeMode: 'branch', questionMode: 'decide' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate --merge-mode branch --question-mode decide');
  });

  // The three shapes this endpoint could compose before task-19, asserted as
  // exact strings. If any of them ever gains a trailing flag, this is what
  // goes red — which is the whole reason `park` appends nothing rather than
  // appending `--question-mode park`.
  it('leaves every pre-task-19 prompt shape byte-identical', async () => {
    const sent1 = stubDashboard();
    await post({ project: projectPath }).expect(201);
    expect(spawnedPrompt(sent1)).toBe('/backlog-orchestrate');

    const sent2 = stubDashboard();
    await post({ project: projectPath, ids: ['bug-1', 'bug-2'] }).expect(201);
    expect(spawnedPrompt(sent2)).toBe('/backlog-orchestrate bug-1 bug-2');

    const sent3 = stubDashboard();
    await post({ project: projectPath, mergeMode: 'branch' }).expect(201);
    expect(spawnedPrompt(sent3)).toBe('/backlog-orchestrate --merge-mode branch');
  });

  // --- The lock still wins ------------------------------------------------
  //
  // Same ordering point merge-mode.test.ts's case 8 makes, for the same
  // reason: the activeRun lock is the ONLY 409 this endpoint codes, and
  // OrchestrateSheet branches on that code to close itself. A request
  // carrying both problems must answer with the coded 409, never the 400.

  it('lets a fresh run in progress win over an invalid questionMode', async () => {
    const sent = stubDashboard();
    writeRun({ ...fixture, project: projectPath, updatedAt: new Date().toISOString() });

    const res = await post({ project: projectPath, questionMode: 'auto' }).expect(409);
    expect(res.body.code).toBe(RUN_IN_PROGRESS_CODE);
    expect(res.body.error).toContain(fixture.runId);
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });
});
