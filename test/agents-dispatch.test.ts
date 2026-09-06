import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, RunStage } from '../shared/types';

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

interface Sent { url: string; init?: RequestInit }

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
 * spawn fetch *rejecting* while health and /api/management still resolve.
 * Every 502 case in this suite before it rejected `/api/health` too, which
 * `dispatchBlock` answers long before `spawn()` is ever reached — so the
 * one path where a rejection escapes `spawn()` itself had no case at all,
 * which is exactly how the unmapped 500 shipped.
 */
function stubDashboard(
  spawn: { ok?: boolean; status?: number; body?: unknown; reject?: unknown } = {}
) {
  const sent: Sent[] = [];
  const ok = spawn.ok ?? true;
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
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
    request(app.getHttpServer()).post('/api/agents/dispatch').send(body as object);

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
    // The client's prompt, byte for byte — not a `toContain` on some phrase
    // both the sent prompt and a server-recomposed one would satisfy. Editing
    // the prompt in the launch sheet is the whole point of the sheet, and only
    // an equality assertion can tell "forwards what was sent" from
    // "recomposes and silently discards the edit".
    expect(body.prompt).toBe(good.prompt);
    // A path must never be sent — dirName membership is the dashboard's own
    // contract and this is the assertion that keeps us inside it.
    expect(JSON.stringify(body)).not.toContain(projectPath);
  });

  it('refuses to execute an ungroomed bug and names the step it does have', async () => {
    stubDashboard();
    const res = await post({ ...good, itemPath: bugPath('bug-1-a-fresh-bug.md') }).expect(409);
    expect(res.body.error).toContain('groom');
  });

  it('clamps a mode above the ceiling instead of forwarding it', async () => {
    const sent = stubDashboard();
    await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), permissionMode: 'bypassPermissions'
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
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md'), prompt: '   ' })
      .expect(400, { error: 'prompt is required' });
  });

  it('passes the dashboard error through verbatim', async () => {
    stubDashboard({ ok: false, status: 429, body: { error: 'too many launches in flight' } });
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') })
      .expect(429, { error: 'too many launches in flight' });
  });

  it('refuses when the dashboard has remote answers off, without spawning', async () => {
    const sent: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          url.endsWith('/api/management')
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
     /api/management through and fail only the spawn call itself — the path
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
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), prompt: 'x'.repeat(9_000)
    }).expect(400, { error: 'prompt is too long' });
    expect(res.body.error).toBe('prompt is too long');
  });

  it('treats a stringy "true" as off, not on, for remoteControl', async () => {
    const sent = stubDashboard();
    await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), remoteControl: 'true'
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
      ...good, itemPath: join(projectPath, 'backlog', 'bugs/done', 'bug-9-a-fixed-bug.md')
    }).expect(409);
    expect(res.body.error).toBe('nothing to dispatch for this item');
  });

  it('spawns a capture for an out-of-scope item — the rejection\'s way back', async () => {
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

  it('refuses a groom request when the item\'s actual next step is capture', async () => {
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
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), action: 'archive'
    }).expect(400);
    expect(res.body.error).toBe('action must be groom, execute or capture');
  });

  it('refuses a groom request when the item\'s actual next step is execute', async () => {
    stubDashboard();
    const res = await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), action: 'groom'
    }).expect(409);
    expect(res.body.error).toContain('execute');
  });
  it('forwards a picked model and effort to the dashboard', async () => {
    const sent = stubDashboard();
    await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), model: 'sonnet', effort: 'high'
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
  it('sends no model or effort key at all when the sheet left both on default', async () => {
    const sent = stubDashboard();
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(201);
    const raw = String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body);
    expect(raw).not.toContain('model');
    expect(raw).not.toContain('effort');
  });

  /* Fail soft, matching the dashboard's own rule for these two fields: a name
     this build has never heard of costs the flag, not the launch. */
  it('drops an unrecognised model or effort instead of refusing the launch', async () => {
    const sent = stubDashboard();
    await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), model: 'gpt', effort: 'ludicrous'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.model).toBeUndefined();
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

  /* `RUN_IN_PROGRESS_CODE` stays the one and only coded 409 in this app (see
     its own doc comment for the incident that rule exists to prevent). Nothing
     needs to tell this refusal apart from dispatch's other 409s
     programmatically, so it carries no code — asserted, because a `code` added
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

  /* Precedence. `dispatchBlock` runs first, so an item that is BOTH claimed by
     a run and in a project the dashboard cannot see reports the dashboard —
     the more fundamental block, and the one the reader has to fix first. */
  it('reports the dashboard block, not the run claim, when both apply', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          String(input).endsWith('/api/management')
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
});
