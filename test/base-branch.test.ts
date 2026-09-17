import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';

interface Sent {
  url: string;
  init?: RequestInit;
}

let projectPath: string;

/**
 * Same shape as question-mode.test.ts's own stubDashboard, duplicated rather
 * than imported — this repo's convention that every e2e suite owns its own
 * fixtures and stubs, argued in orchestrator-start.test.ts's own comment.
 */
function stubDashboard(): Sent[] {
  const sent: Sent[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessionId: 'sess-1' }) } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.endsWith('/api/management')
            ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
        )
    } as Response);
  }) as jest.Mock;
  return sent;
}

/**
 * task-44's server suite: `resolveBase`'s resolution table, the composed spawn
 * prompt, and `GET /api/agents/branches`.
 *
 * A sibling file to `merge-mode.test.ts` and `question-mode.test.ts` rather
 * than rows added to `test/agents-prompt.test.ts`, which the plan named — that
 * file covers `composePrompt` (prompt.util.ts, the DISPATCH prompt) and has
 * never carried an orchestrate-composition case. question-mode.test.ts made
 * exactly this departure for exactly this reason and recorded it in its own
 * header; this is that precedent followed, not a second opinion.
 *
 * Prompts are asserted as WHOLE strings, never substrings: the byte-identity
 * of a pre-task-44 prompt is the property most worth guarding, and a
 * `toContain` would still pass with a stray flag appended.
 */
describe('POST /api/agents/orchestrate — base', () => {
  let app: INestApplication;
  let tmpRoot: string;
  const env = { ...process.env };
  const realFetch = global.fetch;

  /** Turns the fixture project into a real repo with one commit, so
   *  `refs/heads/main` actually resolves. `-b main` rather than a bare `init`
   *  so the trunk name is this suite's decision and not the developer's
   *  `init.defaultBranch`. */
  function makeRepo(root: string): void {
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '-m', 'fixture']);
  }

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-bug.md', content: item('bug-1', 'a bug', '## Cause\n\nknown\n\n## Fix\n\ndo it\n') },
      { leaf: 'bugs/open', filename: 'bug-2-a-bug.md', content: item('bug-2', 'another bug', '## Cause\n\nknown\n\n## Fix\n\ndo it\n') }
    ]);
    makeRepo(projectPath);
    execFileSync('git', ['-C', projectPath, 'branch', 'feature/x']);

    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-base-branch-'));
    process.env.BM_ORCH_HOME = join(tmpRoot, 'orchestrator');
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_AGENTS_TOKEN = 's3cret';

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
    rmSync(projectPath, { recursive: true, force: true });
  });

  const post = (body: unknown) => request(app.getHttpServer()).post('/api/agents/orchestrate').send(body as object);

  function spawnedPrompt(sent: Sent[]): string | undefined {
    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    if (!spawn) return undefined;
    return JSON.parse(String(spawn.init?.body)).prompt as string;
  }

  // --- A default base appends nothing, in every existing combination -------
  //
  // The regression guard for every caller written before this field existed.
  // All four combinations of `ids` and the two modes are exercised, because
  // the bug this would catch — a `--base main` appended unconditionally — is
  // one that shows up in ALL of them at once and in none of them individually
  // if only the bare case is checked.

  it.each([
    ['absent', {}, '/backlog-orchestrate'],
    ['absent, with ids', { ids: ['bug-1'] }, '/backlog-orchestrate bug-1'],
    ['absent, with both modes', { mergeMode: 'branch', questionMode: 'decide' }, '/backlog-orchestrate --merge-mode branch --question-mode decide'],
    [
      'absent, with ids and both modes',
      { ids: ['bug-1'], mergeMode: 'branch', questionMode: 'decide' },
      '/backlog-orchestrate bug-1 --merge-mode branch --question-mode decide'
    ]
  ])('an %s base composes the byte-identical pre-task-44 prompt', async (_label, body, expected) => {
    const sent = stubDashboard();
    await post({ project: projectPath, ...(body as object) }).expect(201);
    expect(spawnedPrompt(sent)).toBe(expected);
  });

  it("base: '' composes the bare prompt, same as absent", async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, base: '' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  it("base: 'main' appends nothing — the default is silent whether stated or omitted", async () => {
    // The sheet sends `base` on every launch, so this is the ordinary path,
    // not an edge case: it must compose what an absent base composes.
    const sent = stubDashboard();
    await post({ project: projectPath, base: 'main' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate');
  });

  // --- A non-default base appends the flag, last -----------------------------

  it('a non-default base appends --base after the ids and beside the mode flags', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, ids: ['bug-1'], mergeMode: 'branch', questionMode: 'decide', base: 'feature/x' }).expect(201);
    // Ids FIRST is the load-bearing half: orchestrate.mjs reads bare tokens as
    // ids and each `--flag` as taking an argument, so a flag ahead of the ids
    // would swallow the first id as its value.
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate bug-1 --merge-mode branch --question-mode decide --base feature/x');
  });

  it('a non-default base alone appends only --base', async () => {
    const sent = stubDashboard();
    await post({ project: projectPath, base: 'feature/x' }).expect(201);
    expect(spawnedPrompt(sent)).toBe('/backlog-orchestrate --base feature/x');
  });

  // --- Anything else is a 400, before anything spawns -----------------------
  //
  // `expect(spawnedPrompt(sent)).toBeUndefined()` on every row is the half
  // that matters: a 400 that still spawned would have started an unattended
  // headless session on a base nobody could name.

  it('a base naming no branch 400s and spawns nothing', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, base: 'no-such-branch' }).expect(400);
    expect(res.body.error).toContain('"no-such-branch"');
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  // These two pin the ORDER of the checks, which is the part a plain "it
  // 400s" assertion cannot see. The membership check alone would refuse both
  // values — measured, by deleting the ref-name guards and watching the status
  // stay 400 — so the message is what distinguishes "refused because it is not
  // a well-formed ref name" from "refused because no such branch exists".
  //
  // Why the order is worth pinning at all, stated honestly: for THIS call it
  // is not a safety property, because `refs/heads/${base}` can never start
  // with a `-` however the caller spells the base. It matters downstream. A
  // base that passes here is composed into the spawn prompt and then
  // substituted for `<base>` in SKILL.md's own shell commands, where a
  // leading `-` or embedded whitespace WOULD be read as an option or split an
  // argument. Proving well-formedness before composition is what keeps that
  // true, and the ordering is what makes the refusal say so.

  it('a base shaped like a git option is refused as a bad NAME, before membership is consulted', async () => {
    const sent = stubDashboard();
    const res = await post({ project: projectPath, base: '--upload-pack=evil' }).expect(400);
    expect(res.body.error).toMatch(/not a valid branch name/);
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  it('a malformed ref name that does not start with a dash is refused by check-ref-format, not by membership', async () => {
    // `a..b` is illegal as a ref name but carries no leading `-`, so the
    // cheap JS guard cannot catch it. This case is the only thing in the
    // suite that `git check-ref-format` alone satisfies: without that call the
    // value falls through to membership and the message changes.
    const sent = stubDashboard();
    const res = await post({ project: projectPath, base: 'a..b' }).expect(400);
    expect(res.body.error).toMatch(/not a valid branch name/);
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  it('a non-string base 400s and is rendered as itself, not as a quoted string', async () => {
    // `Partial<AgentOrchestrateRequest>` cannot rule this out, and
    // JSON.stringify is what renders it `42` rather than `"42"` — the
    // convention resolveIds and resolveMergeMode both already follow.
    const sent = stubDashboard();
    const res = await post({ project: projectPath, base: 42 }).expect(400);
    expect(res.body.error).toContain('42');
    expect(res.body.error).not.toContain('"42"');
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  it.each([
    ['a tag', 'v1.0.0'],
    ['a remote-tracking ref', 'origin/main']
  ])('%s 400s — it passes the ref-name check and is caught only by membership', async (_label, base) => {
    execFileSync('git', ['-C', projectPath, 'tag', 'v1.0.0']);
    const sent = stubDashboard();
    await post({ project: projectPath, base }).expect(400);
    expect(spawnedPrompt(sent)).toBeUndefined();
  });

  // --- GET /api/agents/branches --------------------------------------------

  it('lists the project local branches', async () => {
    const res = await request(app.getHttpServer()).get(`/api/agents/branches?project=${encodeURIComponent(projectPath)}`).expect(200);
    expect(res.body.branches.sort()).toEqual(['feature/x', 'main']);
  });

  it('400s on a blank project and 404s on an unregistered one — told apart deliberately', async () => {
    await request(app.getHttpServer()).get('/api/agents/branches?project=').expect(400);
    await request(app.getHttpServer()).get('/api/agents/branches?project=%2Fnot%2Fregistered').expect(404);
  });
});
