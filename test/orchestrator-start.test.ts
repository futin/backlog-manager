import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import { RUN_IN_PROGRESS_CODE } from '../shared/types';
import type { OrchestratorRun } from '../shared/types';

// Same translation orchestrator-runs.test.ts (Task 8) already does: the
// fixture is plain JSON, so TS would otherwise widen its string fields to
// `string` instead of the narrower literal unions (`RunStage`, etc).
const fixture = rawFixture as OrchestratorRun;

let projectPath: string;
/* A SECOND registered project, holding an item id `alpha` does not have.
   It exists for exactly one assertion — that `ids` are resolved against the
   project being orchestrated and not, like AgentsService.findItem's own
   registry-wide walk, against every registered store at once. Without a
   second project on the registry that regression cannot be written down at
   all: a whole-registry scan and a project-scoped one agree on every input
   until two projects exist. */
let otherPath: string;

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
function stubDashboard(
  spawn: { ok: boolean; status?: number; body?: unknown } = { ok: true },
  // The host's permission ceiling, as its /api/health reports it. A
  // parameter rather than the fixed 'acceptEdits' this suite used to hard-code
  // because the permission-mode cases below turn on the difference between a
  // ceiling at or above the default and one under it — with a single ceiling
  // "the default was applied" and "the ceiling clamped it" are the same value.
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
    /* The store the `ids` cases resolve against. Deliberately one item per
       case the membership check has to tell apart — open bug, open task,
       ARCHIVED task, open idea — rather than a single generic item, because
       every one of those four is a different refusal (or acceptance) and a
       shared fixture would let three of them pass on the strength of the
       fourth. Bodies are the minimum each section's `groomed` derivation
       reads; grooming is NOT what the membership check tests (an ungroomed
       item is a legal selection — the run re-gates it and reports it), so
       the values here are chosen to make the SECTION and STATUS unambiguous,
       nothing more. */
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-2-a-bug.md', content: item('bug-2', 'a bug', '## Cause\n\nknown\n\n## Fix\n\ndo it\n') },
      { leaf: 'tasks/open', filename: 'task-1-a-task.md', content: item('task-1', 'a task', '## Plan\n\nstep one\n') },
      { leaf: 'tasks/done', filename: 'task-3-archived.md', content: item('task-3', 'archived', '## Plan\n\nstep one\n') },
      { leaf: 'ideas/open', filename: 'idea-1-an-idea.md', content: item('idea-1', 'an idea', 'a thought\n') }
    ]);
    otherPath = makeProject('beta', [
      { leaf: 'tasks/open', filename: 'task-9-beta-only.md', content: item('task-9', 'beta only', '## Plan\n\nstep one\n') }
    ]);

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
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }, { name: 'beta', path: otherPath }]))
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
    expect(res.body.error).toMatch(/does not list/);
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
      // No permissionMode was sent, so the server's own default ('auto',
      // the same one plan() hands the launch sheet) applies and the
      // 'acceptEdits' ceiling then clamps it down to that. NOT the ladder
      // floor: an absent field is "no preference", not "a request nobody
      // recognises" — see the permission-mode block below, which pins both
      // halves of that distinction.
      permissionMode: 'acceptEdits'
      // model/effort are absent entirely, not merely falsy: JSON.stringify
      // drops an undefined value outright, which is what proves the flag
      // never reaches the dashboard's argv at all.
    });
  });

  // --- The permission mode the spawn is actually started with -------------
  //
  // The route runs a whole unattended queue: worktrees, commits, merges. A
  // session that cannot write a file does none of that, answers 201 anyway,
  // and reports nothing about why — which is why the absent-field case gets
  // a real server-side default here rather than the ladder floor. The two
  // halves worth keeping apart are "the caller expressed no preference"
  // (default it) and "the caller asked for something unrecognised" (floor
  // it); every case below exists to pin one of them, and clampMode itself is
  // deliberately unchanged.

  /** The permission mode the dashboard was asked to spawn with, or undefined
   *  if nothing was spawned at all. */
  function spawnedMode(sent: Sent[]): string | undefined {
    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    if (!spawn) return undefined;
    return JSON.parse(String(spawn.init?.body)).permissionMode as string | undefined;
  }

  /* The bug itself: a body carrying only `project` — a curl, a script, a
     future client, or the sheet dropping the field while keeping the rest.
     'auto' and not the ceiling, the same trade plan() documents for a
     dispatched session: asking for the most a host allows is how a
     convenience becomes an incident. */
  it('defaults an absent permissionMode to auto, not the ladder floor', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    await post({ project: projectPath }).expect(201);
    expect(spawnedMode(sent)).toBe('auto');
  });

  /* The default is a request, not an override — a stricter host still wins,
     so this change can never widen what a dashboard permits. */
  it('clamps the absent-mode default down to a stricter ceiling', async () => {
    const sent = stubDashboard({ ok: true }, 'acceptEdits');
    await post({ project: projectPath }).expect(201);
    expect(spawnedMode(sent)).toBe('acceptEdits');
  });

  /* Existing clamping, unchanged: a recognised mode above the ceiling lands
     ON the ceiling. */
  it('still clamps an explicit mode above the ceiling down to it', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    await post({ project: projectPath, permissionMode: 'bypassPermissions' }).expect(201);
    expect(spawnedMode(sent)).toBe('auto');
  });

  /* The case the fix must NOT change, and the reason the default is applied
     before clampMode rather than inside it: an unrecognised string cannot be
     placed on the ladder, so it floors. Defaulting it to 'auto' instead
     would turn every typo into a privilege escalation. */
  it('still floors an unrecognised mode — an unknown request is not a missing one', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    await post({ project: projectPath, permissionMode: 'nonsense' }).expect(201);
    expect(spawnedMode(sent)).toBe('plan');
  });

  /* The controller forwards this field unvalidated, and its `Partial` type
     cannot rule out a non-string — so a JSON number is a shape the service
     genuinely receives. Not a missing field: the caller sent something, it
     just is not a mode, which is the floor case. */
  it('floors a non-string permissionMode rather than defaulting it', async () => {
    const sent = stubDashboard({ ok: true }, 'auto');
    await post({ project: projectPath, permissionMode: 7 }).expect(201);
    expect(spawnedMode(sent)).toBe('plan');
  });

  // =======================================================================
  // The `ids` selector — the board's Orchestrate sheet sending a SUBSET of
  // the project's queue rather than the whole thing.
  //
  // Every case here asserts against the spawn body's `prompt`, because that
  // is the whole surface of the feature on this side: the ids never reach
  // the dashboard as a field of their own, they are composed into the one
  // prompt string the spawned session is started with. The invariant being
  // defended is "the orchestrate spawn prompt is a server-side constant"
  // (CLAUDE.md) in its post-selector wording — the prompt is COMPOSED
  // server-side, and the only caller influence on it is a list of validated
  // ids naming this project's own open bugs and tasks. `prompt: 'rm -rf'`
  // is still dropped on the floor, which the "constant prompt" case above
  // pins independently of everything here.
  //
  // Test case 1 of the plan's table — no `ids` at all, bare prompt — is the
  // "spawns with the constant prompt" case above, which asserts the whole
  // spawn body with toEqual and therefore already fails if an `ids` key
  // ever leaks into a request that did not carry one.

  /** The prompt the dashboard was asked to start, or undefined if nothing
   *  was spawned at all. Every case below is one of those two questions. */
  function spawnedPrompt(sent: Sent[]): string | undefined {
    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    if (!spawn) return undefined;
    return JSON.parse(String(spawn.init?.body)).prompt as string;
  }

  it('composes one selected id onto the constant prompt', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, ids: ['task-1'] }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate task-1');
  });

  /* Request order, not board order. `--ids a,b,c` restricts the run to those
     ids IN THE ORDER GIVEN, overriding the tool's own bugs-then-tasks
     ordering (orchestrate.mjs, and SKILL.md section 1) — so the order this
     list arrives in is a real instruction and re-sorting it here would
     silently change what the run does. `bug-2` before `task-1` is the
     board's own order; the assertion deliberately sends the reverse. */
  it('preserves the order the ids arrived in, not the board order', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, ids: ['task-1', 'bug-2'] }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate task-1 bug-2');
  });

  /* De-duplicated rather than refused: a repeated id is not an error the
     caller can act on, and the run would work the item once either way —
     but a prompt naming it twice is a confusing thing to leave in a
     transcript nobody is watching. First-seen order is kept, so the
     de-duplication cannot quietly reorder a list either. */
  it('de-duplicates a repeated id, keeping first-seen order', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, ids: ['task-1', 'bug-2', 'task-1'] }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate task-1 bug-2');
  });

  /* The single most important refusal in this block. `parseIdsArg`
     (orchestrate.mjs) deliberately keeps `undefined` (no flag at all)
     distinct from `[]` (an explicit, empty selection) precisely so that
     `--ids ''` cannot silently mean "give me everything" — this is that same
     distinction enforced one layer up, at the only place a browser can reach.
     Treating `[]` as "no restriction" here would turn a user who unchecked
     every box into a full unattended drain of their backlog. */
  it('400s an explicitly empty ids list rather than reading it as "everything"', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, ids: [] }).expect(400);
    expect(res.body.error).toMatch(/ids/);
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  it('400s a non-array ids, including a bare string that looks like one id', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, ids: 'task-1' }).expect(400);
    await post({ project: projectPath, ids: 7 }).expect(400);
    await post({ project: projectPath, ids: { '0': 'task-1' } }).expect(400);
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  /* isItemId's whole reason for existing (shared/agent.ts). None of these
     can reach the membership scan, let alone the prompt: the prompt is one
     line handed to a shell-invoked session, so a newline or a `;` inside an
     "id" is not a lookup that will fail harmlessly later, it is the thing
     the anchoring exists to stop. 400, not 409 — the request is malformed,
     not merely naming something absent. */
  it('400s an id that is not shaped like an id, naming it', async () => {
    const sent = stubDashboard();
    for (const bad of ['../../etc/passwd', 'task-1; rm -rf /', 'task-1 --resume', 'task-1\nbug-2', '', 'task']) {
      const res = await post({ project: projectPath, ids: [bad] }).expect(400);
      expect(res.body.error).toMatch(/ids/);
    }
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  /* 409, not 400: the shape was fine, the store just has no such item. Same
     split dispatch already makes between "this request is malformed" and
     "the files disagree with what you asked for". The id is named because
     an unattended run started from a stale board tab is exactly how this
     happens, and "one of your ids is gone" without saying which is not an
     answer anyone can act on. */
  it('409s a well-formed id that names no item, naming it', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, ids: ['task-99'] }).expect(409);
    expect(res.body.error).toContain('task-99');
    expect(spawnedPrompt(sent)).toBeUndefined();
    expect(res.body.code).toBeUndefined();
  });

  /* An archived item is not a candidate — orchestrate.mjs's own queue
     builder reads `open/` only. Refusing here rather than letting init
     discover it means the error arrives while somebody is still looking at
     the sheet, instead of inside a headless session that has already been
     spawned and will exit 1. */
  it('409s an id whose item is already archived', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, ids: ['task-3'] }).expect(409);
    expect(res.body.error).toContain('task-3');
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  /* Sections, for the same reason. GATE_SECTIONS in orchestrate.mjs is bugs
     and tasks and nothing else — ideas, refactors and out-of-scope have
     nothing to execute by definition, which is the same limit
     backlog-execute refuses on. `idea-1` is open and real, so nothing but
     an explicit section check can turn it away. */
  it('409s an open item from a section a run never looks at', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, ids: ['idea-1'] }).expect(409);
    expect(res.body.error).toContain('idea-1');
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  /* The regression `otherPath` exists for. `task-9` is a real, open,
     groomed task — in a DIFFERENT registered project. Resolving ids the way
     AgentsService.findItem resolves an item path (walk every project in the
     registry) would accept it here and hand `--ids task-9` to a run rooted
     in alpha, where init exits 1 naming an id the caller never typed into
     that project. The scan has to be scoped to `req.project`. */
  it('409s an id that belongs to a different registered project', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, ids: ['task-9'] }).expect(409);
    expect(res.body.error).toContain('task-9');
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  /* Ordering, and the one mistake this whole feature can make. The activeRun
     lock is the ONLY 409 this endpoint codes, and OrchestrateSheet branches
     on that code to close itself and hand the screen to the run strip. If
     ids were validated before the lock, a stale board tab whose selection
     has since been archived would answer an uncoded 409 for a project that
     is actually mid-run — and the sheet would sit there showing "task-3 is
     not open" while the real answer was "a run is already going". The ids
     here are deliberately INVALID so that only ordering can produce the
     coded response. */
  it('lets the run-in-progress lock win over an ids problem', async () => {
    const sent = stubDashboard();
    writeRun({ ...fixture, project: projectPath, updatedAt: new Date().toISOString() });

    const res = await post({ project: projectPath, ids: ['task-3'] }).expect(409);
    expect(res.body.code).toBe(RUN_IN_PROGRESS_CODE);
    expect(res.body.error).toContain(fixture.runId);
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  /* Same ordering point at the other end of the gate ladder: BM_AGENTS off
     is still 404 and still makes no outbound call, whatever the body says.
     A route that is "not here" must not start answering 400s about the
     shape of a field, which would tell an unauthenticated caller the route
     exists after all. */
  it('still 404s with BM_AGENTS off, whatever the ids say', async () => {
    const sent = stubDashboard();
    process.env.BM_AGENTS = 'off';
    await post({ project: projectPath, ids: ['task-1'] }).expect(404);
    await post({ project: projectPath, ids: ['../../etc/passwd'] }).expect(404);
    expect(sent).toEqual([]);
  });
});
