import {
  ApiError, dispatchAgent, fetchAgentPlan, fetchAgentsStatus, fetchArchivedRun, fetchOrchestratorArchive,
  fetchOrchestratorRuns, sessionUrl, startOrchestrate
} from '../client/src/lib/agents';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  AgentDispatchRequest, OrchestratorArchivePayload, OrchestratorArchiveRun, OrchestratorRun, OrchestratorRunsPayload,
  VerificationSummary
} from '../shared/types';

// Same translation orchestrator-shapes.test.ts (Task 8) uses: the fixture is
// plain JSON, so TS would otherwise widen its string fields to `string`
// instead of the narrower literal unions (`RunStage`, etc).
const fixture = rawFixture as OrchestratorRun;

// An OrchestratorArchiveRun built from the same OrchestratorRun fixture,
// tails summarised away the same way OrchestratorService.archive itself does
// (test/orchestrator-archive.test.ts's own service suite) — so a case
// asserting `fetchOrchestratorArchive` round-trips a payload is checking
// against the actual shape the real endpoint answers with, not a
// hand-rolled approximation of it.
function archiveRun(overrides: Partial<OrchestratorArchiveRun> = {}): OrchestratorArchiveRun {
  return {
    ...fixture,
    current: true,
    queue: fixture.queue.map((item) => ({
      ...item,
      verification: item.verification.map(({ cmd, ok }): VerificationSummary => ({ cmd, ok }))
    })),
    ...overrides
  };
}

const REQ: AgentDispatchRequest = {
  itemPath: '/abs/alpha/backlog/tasks/open/task-1.md',
  action: 'execute',
  prompt: 'do the thing',
  permissionMode: 'acceptEdits',
  remoteControl: true
};

function stub(res: { ok: boolean; status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve({
      ok: res.ok, status: res.status ?? 200, json: () => Promise.resolve(res.body)
    } as Response);
  }) as jest.Mock;
  return calls;
}

const AGENTS_STATUS_BODY = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
};

// Captured once and handed back after every case, the way
// test/agents-dispatch.test.ts does it: a mock left on global.fetch is
// inherited by whatever runs next in this worker, where a case that forgot to
// stub passes on someone else's leftovers instead of failing loudly on a real
// network call.
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

describe('the agents client', () => {
  it('reads status from the same-origin API', async () => {
    // A full, real-shaped body — this test is about the request
    // (URL, no init), not the response, but `fetchAgentsStatus` now validates
    // the shape before returning it (see the test below), so a partial body
    // here would throw before either assertion below ever ran.
    const calls = stub({ ok: true, body: AGENTS_STATUS_BODY });
    await fetchAgentsStatus();
    expect(calls[0].url).toBe('/api/agents/status');
    expect(calls[0].init).toBeUndefined();
  });

  // `unwrap`'s cast to `AgentsStatus` is compile-time only; nothing before
  // this checked that a 200 body actually looked like one. Malformed here
  // means "missing what `dispatchBlock` (shared/agent.ts) dereferences" —
  // `enabled` alone, with none of `reachable`/`spawnAvailable`/`remoteAnswer`/
  // `projectPaths`, is exactly the shape an unrelated 200 (this repo's own
  // `/api/items` or `/api/projects`, say) could accidentally satisfy if ever
  // hit by mistake.
  it('rejects a malformed status body instead of returning it silently', async () => {
    stub({ ok: true, body: { enabled: true } });
    await expect(fetchAgentsStatus()).rejects.toThrow('malformed');
  });

  it('posts the item path as a body, never a query string', async () => {
    const calls = stub({ ok: true, body: { action: 'groom' } });
    await fetchAgentPlan('/abs/alpha/backlog/ideas/open/idea-1.md');
    expect(calls[0].url).toBe('/api/agents/plan');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      itemPath: '/abs/alpha/backlog/ideas/open/idea-1.md'
    });
  });

  it('returns the session id on a successful dispatch', async () => {
    stub({ ok: true, body: { sessionId: 'sess-9' } });
    await expect(dispatchAgent(REQ)).resolves.toEqual({ sessionId: 'sess-9' });
  });

  it('throws the server error string, not the status code', async () => {
    stub({ ok: false, status: 409, body: { error: 'this item\'s next step is groom, not execute' } });
    await expect(dispatchAgent(REQ)).rejects.toThrow('next step is groom');
  });

  it('falls back to the status when the error body is unusable', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) } as Response)
    ) as jest.Mock;
    await expect(dispatchAgent(REQ)).rejects.toThrow('500');
  });

  // Fix round 1 (Important): every rejection here used to be a plain Error,
  // so a caller that needed to distinguish two different non-2xx OUTCOMES
  // from each other (not just get some text to show) had nothing but the
  // server's free-text message to match against — see OrchestrateSheet's
  // own history with this (client/src/components/board/OrchestrateSheet.tsx),
  // where a substring match on "already in progress" would break silently
  // the moment the server's wording changed. `ApiError` is the fix: the
  // status code is a stable part of the contract, the message is prose.
  it('rejects with an ApiError carrying the response status, not just the message', async () => {
    stub({ ok: false, status: 409, body: { error: 'a run is already in progress for this project (run-9)' } });
    const err = await startOrchestrate({ project: '/abs/alpha' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toContain('already in progress');
  });

  // The other half of the "falls back to the status when the error body is
  // unusable" case above: the FALLBACK message is not the only thing built
  // from `res.status` — the real status is still attached even when the
  // body could not be parsed into an `{ error }` string at all.
  it('preserves the response status even when the error body is unusable', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) } as Response)
    ) as jest.Mock;
    const err = await dispatchAgent(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  // Fix round 2: `status === 409` alone turned out to be too coarse for
  // OrchestrateSheet's one caller that needs to distinguish the
  // orchestrate-lock 409 from the same endpoint's three OTHER 409 reasons
  // (project-invisible, no CLAUDE_BIN, the dirName race) — see
  // RUN_IN_PROGRESS_CODE's own doc comment (shared/types.ts) for the full
  // story. These two cases are `unwrap`'s own half of that fix: a `code`
  // field, when the body actually carries one, has to survive the same
  // parse `error`/`status` already do.
  it('carries an optional code through from the error body when present', async () => {
    stub({
      ok: false, status: 409,
      body: { error: 'a run is already in progress for this project (run-9)', code: 'run-in-progress' }
    });
    const err = await startOrchestrate({ project: '/abs/alpha' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('run-in-progress');
  });

  // The overwhelmingly common case — no server route sends a `code` on any
  // OTHER response today — has to stay silently absent rather than, say,
  // coercing to `null` or an empty string a caller's `=== someCode` check
  // could accidentally match.
  it('leaves code undefined when the error body carries none', async () => {
    stub({ ok: false, status: 409, body: { error: 'the dashboard cannot see this project' } });
    const err = await startOrchestrate({ project: '/abs/alpha' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
  });
});

// The hook (test/orchestrator-hook.test.tsx) exercises fetchOrchestratorRuns
// end-to-end already, but only through the URL/method contract it happens to
// need; these two are the direct, function-level proof every other export in
// this file already gets (fetchAgentsStatus, fetchAgentPlan, dispatchAgent
// above), so a change to either call's shape fails here first rather than as
// a mystery in the hook suite.
describe('the orchestrator calls', () => {
  it('reads runs from the same-origin API', async () => {
    const body: OrchestratorRunsPayload = { runs: [{ ...fixture, fresh: true, pastRuns: 0 }] };
    const calls = stub({ ok: true, body });
    await expect(fetchOrchestratorRuns()).resolves.toEqual(body);
    expect(calls[0].url).toBe('/api/orchestrator/runs');
    expect(calls[0].init).toBeUndefined();
  });

  // Fix round 1 (IMPORTANT): fetchOrchestratorRuns now validates the shape
  // it gets back, the same way fetchAgentsStatus already does — see
  // isOrchestratorRunsPayload's own comment in client/src/lib/agents.ts for
  // why `fresh` specifically is the field worth guarding (it decides
  // whether useOrchestratorRuns polls at all, and a wrong-typed value is
  // read as a real answer rather than throwing). A string where a boolean
  // belongs is exactly that case, not a missing key.
  it('rejects a runs body whose fresh field is the wrong type instead of returning it silently', async () => {
    stub({ ok: true, body: { runs: [{ ...fixture, fresh: 'true', pastRuns: 0 }] } });
    await expect(fetchOrchestratorRuns()).rejects.toThrow('malformed');
  });

  // POST, not GET, for the same reason fetchAgentPlan is: `project` is an
  // absolute path on someone's disk, and a query string puts it in history
  // and in logs.
  it('posts the project as a body, never a query string', async () => {
    const calls = stub({ ok: true, body: { sessionId: 'sess-1' } });
    await startOrchestrate({ project: '/abs/alpha' });
    expect(calls[0].url).toBe('/api/agents/orchestrate');
    // model/effort/permissionMode all absent: JSON.stringify drops an
    // undefined value outright, which is what proves this request carries
    // no accidental extra key when the caller supplies only a project — the
    // same shape orchestrator-start.test.ts's own e2e case pins on the
    // server side of this same call.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ project: '/abs/alpha' });
  });

  it('returns the session id on a successful start', async () => {
    stub({ ok: true, body: { sessionId: 'sess-9' } });
    await expect(startOrchestrate({ project: '/abs/alpha' })).resolves.toEqual({ sessionId: 'sess-9' });
  });

  // The 409-with-a-runId shape orchestrator-start.test.ts's own "fresh
  // running run" case answers with.
  it('throws the server error string on a fresh-run conflict', async () => {
    stub({ ok: false, status: 409, body: { error: `a fresh run already exists (${fixture.runId})` } });
    await expect(startOrchestrate({ project: '/abs/alpha' })).rejects.toThrow(fixture.runId);
  });
});

// Task 4: the archive listing and per-run detail calls RunsView (Task 6/7)
// builds on. Same direct, function-level coverage the live calls above get —
// a change to either call's shape fails here first rather than as a mystery
// in the (not-yet-written) hook or component suites that consume them.
describe('the orchestrator archive calls', () => {
  it('reads the archive listing from the same-origin API', async () => {
    const body: OrchestratorArchivePayload = { runs: [archiveRun()] };
    const calls = stub({ ok: true, body });
    await expect(fetchOrchestratorArchive()).resolves.toEqual(body);
    expect(calls[0].url).toBe('/api/orchestrator/archive');
    expect(calls[0].init).toBeUndefined();
  });

  // isOrchestratorArchivePayload's own comment in client/src/lib/agents.ts
  // explains why this shallow a check earns its place: RunsView (Task 6)
  // dereferences `runId`/`project`/`current`/`queue` on every row of every
  // run in this list, so a payload missing all four is exactly the "lies
  // quietly in hook state" risk the existing guards already exist to rule
  // out for the live-run payload — this is the same rationale applied to
  // the archive one.
  it('throws on a malformed archive payload', async () => {
    stub({ ok: true, body: { runs: [{}] } });
    await expect(fetchOrchestratorArchive()).rejects.toThrow('malformed');
  });

  // GET, with the query string the controller actually reads
  // (server/src/orchestrator/orchestrator.controller.ts's `archivedRun`) —
  // unlike fetchAgentPlan/startOrchestrate above, this one has no body to
  // put an absolute path in, so the query string IS the transport. The
  // space in the fixture project path is deliberate: it is what proves this
  // assertion is checking real `encodeURIComponent` output rather than a
  // literal `%20` that happened to be typed correctly by hand.
  it('hits the right URL for a single archived run', async () => {
    const calls = stub({ ok: true, body: fixture });
    await fetchArchivedRun('/tmp/my project', 'run-20260901-150701');
    const project = encodeURIComponent('/tmp/my project');
    const runId = encodeURIComponent('run-20260901-150701');
    expect(calls[0].url).toBe(`/api/orchestrator/archive/run?project=${project}&runId=${runId}`);
    expect(calls[0].init).toBeUndefined();
  });

  // No shape guard on this call (see fetchArchivedRun's own comment): the
  // response is rendered once by the pane that fetched it, and a 404 already
  // arrives as an ApiError via `unwrap` — this pins that path specifically,
  // the same way `startOrchestrate`'s own 409 case above pins ApiError for
  // the live-run call.
  it('surfaces a 404 as an ApiError with status 404', async () => {
    stub({ ok: false, status: 404, body: { error: 'not found' } });
    const err = await fetchArchivedRun('/abs/alpha', 'run-20260901-150701').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

describe('sessionUrl', () => {
  it('builds the dashboard deep link', () => {
    expect(sessionUrl('http://127.0.0.1:5174', 'sess-1'))
      .toBe('http://127.0.0.1:5174/?session=sess-1');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(sessionUrl('http://dash/', 'sess-1')).toBe('http://dash/?session=sess-1');
  });

  it('encodes the id rather than interpolating it raw', () => {
    expect(sessionUrl('http://dash', 'a b&c')).toBe('http://dash/?session=a%20b%26c');
  });
});
