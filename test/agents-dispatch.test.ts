import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import homeSpawnFixture from './fixtures/dispatch-home-spawn.json';
import { DispatchRecordsService } from '../server/src/items/dispatch-records.service';
import type { BacklogItem, OrchestratorRun, RunStage } from '../shared/types';
import { COMMIT_RULE, DEFAULT_MODEL, finishClause } from '../shared/agent';
import { composePrompt } from '../server/src/agents/prompt.util';

// Same cast every suite reading this fixture makes: it is plain JSON, so TS
// widens its string fields to `string` rather than the literal unions
// (`RunStage` above all) the run-claim cases below turn on.
const runFixture = rawFixture as OrchestratorRun;

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');
const RAW_BUG = item('bug-1', 'a fresh bug', '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n');
const OOS = item('oos-1', 'declined', '## Why not\n\nno\n');
/* "No next step at all" is a DONE item now that a rejection has one (capture).
   Its own fixture because nothing else in this store is `status: done`. */
const DONE_BUG = item('bug-9', 'a fixed bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfixed\n');

let projectPath: string;

interface Sent {
  url: string;
  init?: RequestInit;
}

/* The two shapes a rejected `fetch` actually arrives as, measured on Node 22
   while grooming bug-26 — a connection failure is a `TypeError` whose own
   message is the useless literal `fetch failed`, with the detail only in
   `.cause`; the `AbortSignal.timeout` path is a `DOMException` that names no
   budget. Duplicated into each of the three spawn suites, exactly as the
   stubs they feed already are. */
const CONN_REFUSED = Object.assign(new TypeError('fetch failed'), {
  cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:4173' }
});
const SPAWN_TIMED_OUT = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

/**
 * Records every outbound call and answers the three the service makes.
 *
 * `reject` is the one mode this stub could not express before bug-26: the
 * spawn fetch *rejecting* while health and /api/configs still resolve.
 * Every 502 case in this suite before it rejected `/api/health` too, which
 * `dispatchBlock` answers long before `spawn()` is ever reached — so the
 * one path where a rejection escapes `spawn()` itself had no case at all,
 * which is exactly how the unmapped 500 shipped.
 */
function stubDashboard(spawn: { ok?: boolean; status?: number; body?: unknown; reject?: unknown } = {}) {
  const sent: Sent[] = [];
  const ok = spawn.ok ?? true;
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
      if ('reject' in spawn) return Promise.reject(spawn.reject);
      return Promise.resolve({
        ok,
        status: spawn.status ?? (ok ? 200 : 429),
        json: () => Promise.resolve(spawn.body ?? { sessionId: 'sess-1' })
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.endsWith('/api/configs')
            ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
        )
    } as Response);
  }) as jest.Mock;
  return sent;
}

describe('POST /api/agents/dispatch', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  // Captured once so every case — including the ones that replace
  // global.fetch outright rather than calling stubDashboard() — hands the
  // real implementation back afterwards. Without this, a ninth case that
  // forgets to stub inherits whatever the previous case's mock left behind
  // instead of failing loudly on a real network call.
  const realFetch = global.fetch;

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-fresh-bug.md', content: RAW_BUG },
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG },
      { leaf: 'bugs/done', filename: 'bug-9-a-fixed-bug.md', content: DONE_BUG },
      { leaf: 'out-of-scope', filename: 'oos-1-declined.md', content: OOS }
    ]);

    // A fresh, empty BM_ORCH_HOME per case — the same guard
    // orchestrator-start.test.ts states at length: dispatch() now consults
    // the orchestrator's run files, and without this the suite would read
    // the developer's real ~/.backlog-manager/orchestrator/ and pass or fail
    // on whatever run happens to be live on their machine. Deliberately not
    // created (only its parent is): a project with no run yet has no
    // directory at all, and that must read as "no run", not fail.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-dispatch-'));
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
    await listenLoopback(app);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /* The exact layout orchestrate.mjs's own runFilePath() writes, duplicated
     here for the reason orchestrator-start.test.ts's copy already records:
     that script is standalone, with no exported package boundary into this
     TS project. `bug-2` is the id every dispatch case below acts on, so the
     queue holds exactly that one entry at whatever stage the case is about. */
  function writeRun(stage: RunStage, over: Partial<OrchestratorRun> = {}): void {
    const run: OrchestratorRun = {
      ...runFixture,
      project: projectPath,
      updatedAt: new Date().toISOString(),
      queue: [{ ...runFixture.queue[0], id: 'bug-2', stage }],
      ...over
    };
    const dir = join(orchHome, encodeURIComponent(run.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  const bugPath = (name: string) => join(projectPath, 'backlog', 'bugs/open', name);
  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .send(body as object);

  const good = {
    itemPath: '',
    action: 'execute' as const,
    prompt: 'Use the backlog-manager:backlog-execute skill on bug-2.',
    permissionMode: 'acceptEdits' as const,
    remoteControl: true
  };

  it('spawns with the dashboard dirName, the bearer token, and a labelled name', async () => {
    const sent = stubDashboard();
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });

    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    expect(spawn).toBeDefined();
    expect((spawn?.init?.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
    const body = JSON.parse(String(spawn?.init?.body));
    expect(body.project).toBe('-abs-alpha');
    expect(body.name).toBe('bl alpha bug-2');
    expect(body.permissionMode).toBe('acceptEdits');
    expect(body.remoteControl).toBe(true);
    // The client's prompt, byte for byte, then the finish clause — not a `toContain` on some phrase both the sent prompt and a server-recomposed one
    // would satisfy. Editing the prompt in the launch sheet is the whole point of the sheet, and only an equality assertion can tell "forwards what was
    // sent" from "recomposes and silently discards the edit". With no `finish` the clause is the in-place `COMMIT_RULE`, the old client's default.
    expect(body.prompt).toBe(good.prompt + ' ' + COMMIT_RULE);
    // A path must never be sent — dirName membership is the dashboard's own
    // contract and this is the assertion that keeps us inside it.
    expect(JSON.stringify(body)).not.toContain(projectPath);
  });

  /**
   * Multi-dashboard Review Focus 1 — the home-only setup (no `dashboards.json`, no `machine` field) must send the dashboard the spawn body it sent before the
   * feature, BYTE for byte. `fixtures/dispatch-home-spawn.json` was captured from a run of the unchanged code (the commit before task 5), so these compare
   * against what the old code actually put on the wire rather than against a re-statement of it a refactor could drift along with. `machine: 'home'` is
   * the same launch spelled out, and must be the same bytes too. The settings file is pointed at a path that does not exist, so the developer's own
   * `~/.backlog-manager/settings/dashboards.json` cannot leak into the case.
   */
  describe('home dispatch is byte-identical to before multi-dashboard', () => {
    const recorded = homeSpawnFixture as { default: string; picked: string };
    const cases = [
      ['default', {}],
      ['picked', { model: 'sonnet', effort: 'high' }]
    ] as const;

    beforeEach(() => {
      process.env.BM_DASHBOARDS_FILE = join(tmpRoot, 'settings', 'dashboards.json');
    });

    for (const [key, extra] of cases) {
      for (const machine of [undefined, 'home']) {
        it(`${key} pick, machine ${machine ?? 'absent'}: the exact recorded /api/spawn body, to home's dashboard, recorded as machine home`, async () => {
          const sent = stubDashboard();
          const body = { ...good, itemPath: bugPath('bug-2-a-known-bug.md'), ...extra, ...(machine === undefined ? {} : { machine }) };
          await post(body).expect(201, { sessionId: 'sess-1' });
          const spawns = sent.filter((s) => s.url.endsWith('/api/spawn'));
          expect(spawns.map((s) => s.url)).toEqual(['http://dash.test:4173/api/spawn']);
          expect((spawns[0].init?.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
          expect(spawns[0].init?.body).toBe(recorded[key]);
          expect(app.get(DispatchRecordsService).get('sess-1')?.machine).toBe('home');
        });
      }
    }
  });

  it('refuses to execute an ungroomed bug and names the step it does have', async () => {
    stubDashboard();
    const res = await post({ ...good, itemPath: bugPath('bug-1-a-fresh-bug.md') }).expect(409);
    expect(res.body.error).toContain('groom');
  });

  it('clamps a mode above the ceiling instead of forwarding it', async () => {
    const sent = stubDashboard();
    await post({
      ...good,
      itemPath: bugPath('bug-2-a-known-bug.md'),
      permissionMode: 'bypassPermissions'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.permissionMode).toBe('acceptEdits');
  });

  it('404s an unregistered path without spawning', async () => {
    const sent = stubDashboard();
    await post({ ...good, itemPath: '/etc/passwd' }).expect(404, { error: 'not found' });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it('400s an empty prompt', async () => {
    stubDashboard();
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md'), prompt: '   ' }).expect(400, { error: 'prompt is required' });
  });

  it('passes the dashboard error through verbatim', async () => {
    stubDashboard({ ok: false, status: 429, body: { error: 'too many launches in flight' } });
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(429, { error: 'too many launches in flight' });
  });

  it('refuses when the dashboard has remote answers off, without spawning', async () => {
    const sent: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url.endsWith('/api/configs')
              ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
              : { ok: true, remoteAnswer: false, spawnAvailable: true, spawnMaxPermission: 'auto' }
          )
      } as Response);
    }) as jest.Mock;
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toMatch(/remote answers/);
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  it('502s when the dashboard is unreachable', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as jest.Mock;
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(502);
    expect(res.body.error).toContain('unreachable');
  });

  /* The case above rejects EVERY fetch, so `dispatchBlock` refuses on the
     health probe and `spawn()` is never entered. These two let health and
     /api/configs through and fail only the spawn call itself — the path
     that answered a bare `{ statusCode: 500, message: 'Internal server
     error' }` before bug-26, which the client degrades to
     `request failed (500)`. `statusCode` being absent is what actually pins
     "not the Nest default shape": a status assertion alone would pass just
     as well against a filter that only relabelled the number. */
  it('502s with the connection detail when the spawn fetch is refused', async () => {
    stubDashboard({ reject: CONN_REFUSED });
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(502);
    expect(res.body.error).toContain('ECONNREFUSED');
    expect(res.body.statusCode).toBeUndefined();
  });

  it('502s naming the timeout budget when the spawn fetch times out', async () => {
    stubDashboard({ reject: SPAWN_TIMED_OUT });
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(502);
    expect(res.body.error).toContain('10000');
    expect(res.body.error).toMatch(/timed out/);
    // The DOMException's own wording names neither the call nor its budget,
    // so relaying it verbatim would be the same silence in a 502 costume.
    expect(res.body.error).not.toContain('The operation was aborted');
    expect(res.body.statusCode).toBeUndefined();
  });

  it('400s a prompt over the cap', async () => {
    stubDashboard();
    const res = await post({
      ...good,
      itemPath: bugPath('bug-2-a-known-bug.md'),
      prompt: 'x'.repeat(9_000)
    }).expect(400, { error: 'prompt is too long' });
    expect(res.body.error).toBe('prompt is too long');
  });

  it('treats a stringy "true" as off, not on, for remoteControl', async () => {
    const sent = stubDashboard();
    await post({
      ...good,
      itemPath: bugPath('bug-2-a-known-bug.md'),
      remoteControl: 'true'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.remoteControl).toBe(false);
  });

  it('409s "dispatch is off" without spawning, when BM_AGENTS is off', async () => {
    const sent = stubDashboard();
    process.env.BM_AGENTS = 'off';
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toContain('dispatch is off');
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it('409s an item with no next step at all — a DONE one', async () => {
    // Not the out-of-scope file this case used to name: a rejection has a next
    // step now (capture), and only history has none.
    stubDashboard();
    const res = await post({
      ...good,
      itemPath: join(projectPath, 'backlog', 'bugs/done', 'bug-9-a-fixed-bug.md')
    }).expect(409);
    expect(res.body.error).toBe('nothing to dispatch for this item');
  });

  /* The one end-to-end proof that `scan.util.ts` reads `plan-review:` from a files item's frontmatter and the dispatch re-check refuses it. Written into the
     store at case time: the scan is per request, so no fixture has to carry the line for every other case. */
  it('409s a files item whose frontmatter says plan-review: true, and spawns nothing', async () => {
    const sent = stubDashboard();
    writeFileSync(
      bugPath('bug-3-plan-awaits.md'),
      item('bug-3', 'plan awaits', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n', 'plan-review: true\n')
    );
    const res = await post({ ...good, itemPath: bugPath('bug-3-plan-awaits.md') }).expect(409);
    expect(res.body).toEqual({ error: 'this plan awaits review' });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it("spawns a capture for an out-of-scope item — the rejection's way back", async () => {
    const sent = stubDashboard();
    await post({
      ...good,
      itemPath: join(projectPath, 'backlog', 'out-of-scope', 'oos-1-declined.md'),
      action: 'capture',
      prompt: 'Use the backlog-manager:backlog-capture skill on oos-1, citing from: oos-1.'
    }).expect(201);

    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    expect(spawn).toBeDefined();
    expect(JSON.parse(String(spawn?.init?.body)).prompt).toContain('backlog-manager:backlog-capture');
  });

  it("refuses a groom request when the item's actual next step is capture", async () => {
    // The derive-never-accept rule, exercised on the new action: the client
    // said groom, the file says the item is rejected, and the file wins.
    stubDashboard();
    const res = await post({
      ...good,
      itemPath: join(projectPath, 'backlog', 'out-of-scope', 'oos-1-declined.md'),
      action: 'groom'
    }).expect(409);
    expect(res.body.error).toContain('capture');
  });

  it('400s an action outside the vocabulary, naming all three', async () => {
    stubDashboard();
    const res = await post({
      ...good,
      itemPath: bugPath('bug-2-a-known-bug.md'),
      action: 'archive'
    }).expect(400);
    expect(res.body.error).toBe('action must be groom, execute or capture');
  });

  it("refuses a groom request when the item's actual next step is execute", async () => {
    stubDashboard();
    const res = await post({
      ...good,
      itemPath: bugPath('bug-2-a-known-bug.md'),
      action: 'groom'
    }).expect(409);
    expect(res.body.error).toContain('execute');
  });
  it('forwards a picked model and effort to the dashboard', async () => {
    const sent = stubDashboard();
    await post({
      ...good,
      itemPath: bugPath('bug-2-a-known-bug.md'),
      model: 'sonnet',
      effort: 'high'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.model).toBe('sonnet');
    expect(body.effort).toBe('high');
  });

  /* Absent, not null and not '': the dashboard only omits `--model`/`--effort`
     from its argv when the field is missing or unrecognised, and a key present
     with a falsy value is the shape most likely to be "fixed" later into
     something it forwards. Asserting on the serialised body — the bytes that
     actually leave — rather than on the parsed object, because
     `{ model: undefined }` parses to a missing key too and would hide a
     regression that started sending `"model": null`. */
  it('sends the default model and no effort key when the sheet left both on default', async () => {
    const sent = stubDashboard();
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(201);
    const raw = String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body);
    expect(JSON.parse(raw).model).toBe(DEFAULT_MODEL);
    expect(raw).not.toContain('effort');
  });

  /* Fail soft, matching the dashboard's own rule for these two fields: a name
     this build has never heard of costs the flag, not the launch — and the
     model then falls to DEFAULT_MODEL rather than to whatever the host CLI
     defaults to. */
  it('drops an unrecognised model or effort instead of refusing the launch', async () => {
    const sent = stubDashboard();
    await post({
      ...good,
      itemPath: bugPath('bug-2-a-known-bug.md'),
      model: 'gpt',
      effort: 'ludicrous'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.effort).toBeUndefined();
  });

  /*
   * The run-claim block, and the layer that actually holds: the launch sheet
   * fetches its plan once on mount, so a sheet left open while a run claims
   * the item still shows an enabled launch button, and only the server sees
   * the run as it is at click time. Same reasoning as the orchestrate lock's
   * own re-check.
   */
  it('refuses to dispatch an item a fresh run is working, naming the stage', async () => {
    const sent = stubDashboard();
    writeRun('reviewing');
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toContain('reviewing');
    // Nothing was spawned — the refusal is not merely reported after the fact.
    expect(sent.some((c) => c.url.endsWith('/api/spawn'))).toBe(false);
  });

  /* `RUN_IN_PROGRESS_CODE` means "a run for this project is alive right now"
     (see its own doc comment for the incident that rule exists to prevent).
     This refusal is a different fact — a run has CLAIMED this item — and
     nothing needs to tell it apart from dispatch's other 409s
     programmatically, so it carries no code. Asserted, because a `code` added
     here later is exactly the drift that comment forbids. */
  it('sends no machine-readable code on the run-claim refusal', async () => {
    stubDashboard();
    writeRun('reviewing');
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.code).toBeUndefined();
  });

  /* The run is FINISHED with this item, and a human picking it up by hand is
     the intended next move — the whole reason the block reads a stage list
     rather than "is this id in a queue". */
  it('dispatches an item the run has already merged', async () => {
    stubDashboard();
    writeRun('merged');
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(201);
  });

  /* Staleness, the other half of that filter. `updatedAt` is pushed well past
     RUN_STALE_MS rather than merely old-ish, so this case cannot start passing
     for the wrong reason if that threshold is ever raised. */
  it('dispatches an item held only by a stale run', async () => {
    stubDashboard();
    writeRun('reviewing', { updatedAt: '2020-01-01T00:00:00.000Z' });
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(201);
  });

  /* bug-21 — the starting window, the same block one window earlier. There is
     no run file at all here: the entry that refuses this dispatch is
     `StartingRunsService`'s in-memory record of the orchestrate POST above,
     which is the ONLY way to create one (nothing writes it to disk, by
     design). `POST /api/agents/dispatch` is the layer that actually stops a
     double execution, so it is the one that matters most of the four gates
     this fix feeds — a client-side hide alone leaves the API's own promise
     unkept for any caller that is not this board. */
  it('refuses to dispatch an item whose project has a run starting, with no run file at all', async () => {
    const sent = stubDashboard();
    await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: projectPath }).expect(201);

    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toBe('an orchestrator run is starting for this project');
    // Uncoded, like every other dispatch 409: RUN_IN_PROGRESS_CODE means "a
    // run for this project is alive right now", and a run CLAIMING this item
    // is a different fact that nothing needs to tell apart by machine.
    expect(res.body.code).toBeUndefined();
    // One spawn — the orchestrate one. The dispatch was refused before its
    // own, which is the difference between a block and an after-the-fact
    // report.
    expect(sent.filter((c) => c.url.endsWith('/api/spawn'))).toHaveLength(1);
  });

  /* Ruling 1 in e2e form: the block is project-wide, so it covers even an
     item no launch selected — which is the whole point, since the server
     cannot know what the run will queue until `buildGatedQueue` decides
     inside the spawned session minutes later. */
  it('refuses a second item in the same starting project', async () => {
    stubDashboard();
    await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: projectPath }).expect(201);

    const res = await post({
      ...good,
      action: 'groom',
      itemPath: bugPath('bug-1-a-fresh-bug.md'),
      prompt: 'Use the backlog-manager:backlog-groom skill on bug-1.'
    }).expect(409);
    expect(res.body.error).toBe('an orchestrator run is starting for this project');
  });

  /* Precedence. `dispatchBlock` runs first, so an item that is BOTH claimed by
     a run and in a project the dashboard cannot see reports the dashboard —
     the more fundamental block, and the one the reader has to fix first. */
  it('reports the dashboard block, not the run claim, when both apply', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(input).endsWith('/api/configs')
              ? { projects: [] }
              : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
          )
      } as Response)
    ) as jest.Mock;
    writeRun('reviewing');
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toContain('does not list');
    expect(res.body.error).not.toContain('reviewing');
  });

  /* ---- the execute finish: `finish`/`base` fields, the --finish/--base token refusal, and the appended clause ----
     The suite's project is a plain directory, so every `finish: 'pr'` case first turns it into a repo with one commit (trunk `main` unless named). */
  describe('finish and base', () => {
    function makeRepo(trunk = 'main', extraBranches: string[] = []): void {
      execFileSync('git', ['-C', projectPath, 'init', '-q', '-b', trunk]);
      execFileSync('git', ['-C', projectPath, 'add', '-A']);
      execFileSync('git', ['-C', projectPath, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
      for (const b of extraBranches) execFileSync('git', ['-C', projectPath, 'branch', b]);
    }
    const spawned = (sent: Sent[]) => sent.find((s) => s.url.endsWith('/api/spawn'));
    const spawnedPrompt = (sent: Sent[]) => JSON.parse(String(spawned(sent)?.init?.body)).prompt as string;
    const exec = (over: Record<string, unknown> = {}) => post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md'), ...over });
    /** The token refusal, byte for byte (the plan's Global Constraints). */
    const TOKEN_REFUSAL =
      "the finish mode, base, auto-merge and fix are set by the sheet's pickers — remove --finish, --base, --auto-merge and --fix from the prompt";
    const GROOM_PROMPT = 'Use the backlog-manager:backlog-groom skill on bug-1.';
    /** A groom twin of `exec`: bug-1 is the ungroomed bug, so its derived action is groom. */
    const groom = (over: Record<string, unknown> = {}) =>
      post({ ...good, action: 'groom', itemPath: bugPath('bug-1-a-fresh-bug.md'), prompt: GROOM_PROMPT, ...over });

    it('no finish: the spawned prompt ends with COMMIT_RULE', async () => {
      const sent = stubDashboard();
      await exec().expect(201);
      expect(spawnedPrompt(sent)).toBe(good.prompt + ' ' + COMMIT_RULE);
    });

    it("an old client's body that already ends with COMMIT_RULE gets it appended again — doubled, harmless, never a 400", async () => {
      const sent = stubDashboard();
      await exec({ prompt: good.prompt + ' ' + COMMIT_RULE }).expect(201);
      expect(spawnedPrompt(sent)).toBe(good.prompt + ' ' + COMMIT_RULE + ' ' + COMMIT_RULE);
    });

    it('finish in-place: ends with COMMIT_RULE and carries no --finish', async () => {
      const sent = stubDashboard();
      await exec({ finish: 'in-place' }).expect(201);
      const p = spawnedPrompt(sent);
      expect(p.endsWith(COMMIT_RULE)).toBe(true);
      expect(p).not.toContain('--finish');
    });

    it('finish pr, base main in a repo whose main exists: ends with finishClause(pr, main)', async () => {
      makeRepo('main');
      const sent = stubDashboard();
      await exec({ finish: 'pr', base: 'main' }).expect(201);
      expect(spawnedPrompt(sent)).toBe(good.prompt + ' ' + finishClause('execute', 'pr', 'main'));
    });

    it('finish pr, base develop with a real local develop: ends with finishClause(pr, develop)', async () => {
      makeRepo('main', ['develop']);
      const sent = stubDashboard();
      await exec({ finish: 'pr', base: 'develop' }).expect(201);
      expect(spawnedPrompt(sent)).toBe(good.prompt + ' ' + finishClause('execute', 'pr', 'develop'));
    });

    it('400s a finish outside the vocabulary (rule 1)', async () => {
      const sent = stubDashboard();
      await exec({ finish: 'merge' }).expect(400, { error: 'finish must be in-place or pr' });
      expect(spawned(sent)).toBeUndefined();
    });

    it('groom finish pr + base main: the prompt ends with finishClause(groom, pr, main) and carries no COMMIT_RULE', async () => {
      makeRepo('main');
      const sent = stubDashboard();
      await groom({ finish: 'pr', base: 'main' }).expect(201);
      expect(spawnedPrompt(sent)).toBe(GROOM_PROMPT + ' ' + finishClause('groom', 'pr', 'main'));
      expect(spawnedPrompt(sent)).not.toContain(COMMIT_RULE);
    });

    it("in-place groom: the spawned prompt equals today's composePrompt bytes, with and without an explicit finish", async () => {
      const sent = stubDashboard();
      const untouched = GROOM_PROMPT + ' ' + COMMIT_RULE;
      await groom().expect(201);
      await groom({ finish: 'in-place' }).expect(201);
      const prompts = sent.filter((s) => s.url.endsWith('/api/spawn')).map((s) => JSON.parse(String(s.init?.body)).prompt);
      expect(prompts).toEqual([untouched, untouched]);
    });

    it('old-tab groom body ending in COMMIT_RULE: exactly one clause, whichever finish', async () => {
      makeRepo('main');
      const sent = stubDashboard();
      const body = GROOM_PROMPT + ' ' + COMMIT_RULE;
      await groom({ prompt: body }).expect(201);
      expect(spawnedPrompt(sent).split(COMMIT_RULE)).toHaveLength(2);
      const sent2 = stubDashboard();
      await groom({ prompt: body, finish: 'pr', base: 'main' }).expect(201);
      const p = spawnedPrompt(sent2);
      expect(p).not.toContain(COMMIT_RULE);
      expect(p.endsWith(finishClause('groom', 'pr', 'main'))).toBe(true);
    });

    it('groom pr with autoMerge and fix ends with the groom flag sentence', async () => {
      makeRepo('main');
      const sent = stubDashboard();
      await groom({ finish: 'pr', base: 'main', autoMerge: true, fix: true }).expect(201);
      expect(spawnedPrompt(sent)).toBe(GROOM_PROMPT + ' ' + finishClause('groom', 'pr', 'main', { autoMerge: true, fix: true }));
      expect(spawnedPrompt(sent)).toContain('--auto-merge --fix');
    });

    it('execute pr with autoMerge ends with the execute auto-merge sentence', async () => {
      makeRepo('main');
      const sent = stubDashboard();
      await exec({ finish: 'pr', base: 'main', autoMerge: true }).expect(201);
      expect(spawnedPrompt(sent)).toBe(good.prompt + ' ' + finishClause('execute', 'pr', 'main', { autoMerge: true }));
    });

    it('400s a finish on a capture item (rule 2)', async () => {
      const sent = stubDashboard();
      await post({
        ...good,
        action: 'capture',
        itemPath: join(projectPath, 'backlog', 'out-of-scope', 'oos-1-declined.md'),
        prompt: 'Use the backlog-manager:backlog-capture skill on oos-1.',
        finish: 'pr',
        base: 'main'
      }).expect(400, { error: 'finish applies only to execute or groom' });
      expect(spawned(sent)).toBeUndefined();
    });

    it('400s autoMerge or fix beside a finish other than pr (rule 6), fix before rule 7, and a lone fix beside pr (rule 7)', async () => {
      makeRepo('main');
      const sent = stubDashboard();
      const only = { error: 'autoMerge and fix apply only to finish pr' };
      await exec({ finish: 'in-place', autoMerge: true }).expect(400, only);
      await exec({ fix: true }).expect(400, only);
      await groom({ autoMerge: true }).expect(400, only);
      await exec({ finish: 'pr', base: 'main', fix: true }).expect(400, { error: 'fix requires autoMerge' });
      expect(spawned(sent)).toBeUndefined();
    });

    it('400s a non-boolean autoMerge or fix (rule 4)', async () => {
      const sent = stubDashboard();
      await exec({ autoMerge: 'yes' }).expect(400, { error: 'autoMerge must be a boolean' });
      await exec({ fix: 1 }).expect(400, { error: 'fix must be a boolean' });
      expect(spawned(sent)).toBeUndefined();
    });

    it('accepts autoMerge false and fix false under in-place: an untouched toggle', async () => {
      const sent = stubDashboard();
      await exec({ finish: 'in-place', autoMerge: false, fix: false }).expect(201);
      expect(spawnedPrompt(sent)).toBe(good.prompt + ' ' + COMMIT_RULE);
    });

    it('400s a base beside finish in-place, and beside no finish (rule 5)', async () => {
      const sent = stubDashboard();
      await exec({ finish: 'in-place', base: 'main' }).expect(400, { error: 'base applies only to finish pr' });
      await exec({ base: 'main' }).expect(400, { error: 'base applies only to finish pr' });
      expect(spawned(sent)).toBeUndefined();
    });

    it('400s finish pr with no base (rule 5)', async () => {
      const sent = stubDashboard();
      await exec({ finish: 'pr' }).expect(400, { error: 'base is required with finish pr' });
      expect(spawned(sent)).toBeUndefined();
    });

    it.each([
      ['a trailing --finish pr', 'Use the skill on bug-2. --finish pr'],
      ['a leading --base=develop', '--base=develop Use the skill on bug-2.'],
      ['--finish alone', '--finish'],
      ['--base in the middle', 'Use the skill --base develop on bug-2.'],
      ['a backticked token', 'Use the skill on bug-2, then `--finish pr`.'],
      ['a double-quoted token', 'Use the skill on bug-2 with "--finish pr".'],
      ['a parenthesised token', 'Use the skill on bug-2 (--base develop).']
    ])('400s an execute body with %s (rule 8), whatever the pick', async (_name, prompt) => {
      const sent = stubDashboard();
      await exec({ prompt }).expect(400, { error: TOKEN_REFUSAL });
      await exec({ prompt, finish: 'in-place' }).expect(400, { error: TOKEN_REFUSAL });
      expect(spawned(sent)).toBeUndefined();
    });

    it('does not refuse words that merely contain the tokens: --finished, --base-ref, base64', async () => {
      const sent = stubDashboard();
      await exec({ prompt: 'Use the skill on bug-2; the --finished flag, a --base-ref name and a base64 blob stay.' }).expect(201);
      expect(spawned(sent)).toBeDefined();
    });

    it.each([
      ['--auto-merge', 'Use the skill on bug-2 with --auto-merge.'],
      ['--fix', 'Use the skill on bug-2, then `--fix`.']
    ])('400s an execute body typing %s', async (_name, prompt) => {
      const sent = stubDashboard();
      await exec({ prompt }).expect(400, { error: TOKEN_REFUSAL });
      expect(spawned(sent)).toBeUndefined();
    });

    it.each([
      ['--finish', 'Use the skill on bug-1; --finish pr.'],
      ['--auto-merge', 'Use the skill on bug-1 (--auto-merge).'],
      ['--base', 'Use the skill on bug-1. Mention --base x.']
    ])('400s a groom body typing %s', async (_name, prompt) => {
      const sent = stubDashboard();
      await groom({ prompt }).expect(400, { error: TOKEN_REFUSAL });
      expect(spawned(sent)).toBeUndefined();
    });

    it('a capture body is not checked: a typed --fix is a 201 and goes out unchanged', async () => {
      const sent = stubDashboard();
      const prompt = 'Use the backlog-manager:backlog-capture skill on oos-1, mentioning --fix.';
      await post({ ...good, action: 'capture', itemPath: join(projectPath, 'backlog', 'out-of-scope', 'oos-1-declined.md'), prompt }).expect(201);
      expect(spawnedPrompt(sent)).toBe(prompt);
    });

    it('the untouched groom plan for an item titled "Add --fix and --auto-merge flags" dispatches 201', async () => {
      const file = 'bug-4-flagged.md';
      writeFileSync(
        join(projectPath, 'backlog', 'bugs/open', file),
        item('bug-4', 'Add --fix and --auto-merge flags', '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n')
      );
      const prompt = composePrompt({ id: 'bug-4', title: 'Add --fix and --auto-merge flags', section: 'bugs', groomed: false } as BacklogItem, 'groom');
      const sent = stubDashboard();
      await groom({ itemPath: bugPath(file), prompt }).expect(201);
      expect(spawnedPrompt(sent).match(/--fix|--auto-merge/g)).toBeNull();
    });

    /* A title spelling `--base x` must not break the board's own untouched default: composePrompt defuses the token inside the quoted title, so rule 8 sees
       only a typed one. The spawned prompt then carries exactly one `--base`, the clause's. */
    describe('an item whose title spells --base', () => {
      const titled = () => {
        const file = 'bug-3-flagged.md';
        const body = '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n';
        writeFileSync(join(projectPath, 'backlog', 'bugs/open', file), item('bug-3', 'On a --base run the branch -d refuses', body));
        const itemPath = bugPath(file);
        const prompt = composePrompt(
          { id: 'bug-3', title: 'On a --base run the branch -d refuses', section: 'bugs', groomed: true } as BacklogItem,
          'execute'
        );
        return { itemPath, prompt };
      };

      it('finish pr: 201, and the spawned prompt contains exactly one --base (the clause\'s)', async () => {
        makeRepo('main');
        const { itemPath, prompt } = titled();
        const sent = stubDashboard();
        await exec({ itemPath, prompt, finish: 'pr', base: 'main' }).expect(201);
        const p = spawnedPrompt(sent);
        expect(p.match(/--base/g)).toHaveLength(1);
        expect(p.endsWith(finishClause('execute', 'pr', 'main'))).toBe(true);
      });

      it('finish in-place: 201', async () => {
        const { itemPath, prompt } = titled();
        stubDashboard();
        await exec({ itemPath, prompt, finish: 'in-place' }).expect(201);
      });
    });

    it('proves main too: a master-trunk repo gets a 400, not a PR into a branch that is not there', async () => {
      makeRepo('master');
      const sent = stubDashboard();
      await exec({ finish: 'pr', base: 'main' }).expect(400, { error: 'base must be an existing local branch — "main" is not a branch in this project' });
      expect(spawned(sent)).toBeUndefined();
    });

    it('400s a base that is no local branch', async () => {
      makeRepo('main');
      const sent = stubDashboard();
      await exec({ finish: 'pr', base: 'nope' }).expect(400, { error: 'base must be an existing local branch — "nope" is not a branch in this project' });
      expect(spawned(sent)).toBeUndefined();
    });
  });
});
