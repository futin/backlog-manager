import {
  dispatchAgent, fetchAgentPlan, fetchAgentsStatus, fetchOrchestratorRuns, sessionUrl, startOrchestrate
} from '../client/src/lib/agents';
import rawFixture from './fixtures/orchestrator-run.json';
import type { AgentDispatchRequest, OrchestratorRun, OrchestratorRunsPayload } from '../shared/types';

// Same translation orchestrator-shapes.test.ts (Task 8) uses: the fixture is
// plain JSON, so TS would otherwise widen its string fields to `string`
// instead of the narrower literal unions (`RunStage`, etc).
const fixture = rawFixture as OrchestratorRun;

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
