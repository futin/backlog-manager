import { UsageService } from '../server/src/agents/dashboards/usage.service';
import type { Machine } from '../server/src/agents/dashboards/dashboards.service';

/**
 * `UsageService.read` against a stubbed `fetch` (the dashboard repo is not available to a test, and a test must never reach a network). `NOW` is the clock the
 * service is handed, so ages are exact; the dashboard's two answers are the shapes `GET /api/account` and `GET /api/usage/profile` document.
 */

const NOW = Date.parse('2026-10-23T10:00:00.000Z');
const MIN = 60_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const machine = (url = 'http://pro-mac:4173'): Machine => ({
  id: 'Pro',
  label: 'Pro',
  home: false,
  host: 'pro-mac',
  account: null,
  models: [],
  efforts: [],
  cfg: { enabled: true, url, token: 'tok-pro-456' } as Machine['cfg'],
  bmUrl: 'http://pro-mac:4322'
});

const account = (
  fiveHour: unknown = { utilization: 12, resetsAt: iso(3 * 3_600_000) },
  sevenDay: unknown = { utilization: 28, resetsAt: iso(4 * 86_400_000) }
) => ({
  usageStatus: 'ok',
  usage: { fiveHour, sevenDay }
});
const profile = (over: Record<string, unknown> = {}) => ({ exhaustAt: null, walkAbsent: null, resetsAt: iso(4 * 86_400_000), ...over });

type Answers = { account?: unknown | (() => Promise<Response>); profile?: unknown | (() => Promise<Response>) };

let fetchMock: jest.SpyInstance;
const calls = (route: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(route)).length;

/** Stub fetch by route; a function answer is called as the response (so it can reject or hang), anything else is a 200 JSON body. */
function stub(answers: Answers): void {
  fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
    const route = String(url).endsWith('/api/account') ? answers.account : answers.profile;
    if (typeof route === 'function') return (route as () => Promise<Response>)();
    return Promise.resolve(new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch);
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('UsageService.read — what counts as usage', () => {
  it('reads both windows as percents and a safe projection', async () => {
    stub({ account: account(), profile: profile() });
    const r = await new UsageService().read(machine(), NOW);
    expect(r.ageMs).toBe(0);
    expect(r.usage).toMatchObject({ fiveHour: { pct: 12 }, week: { pct: 28 }, projection: 'safe', exhaustAt: null });
    expect(r.usage?.fetchedAt).toBe(iso(0));
  });

  it("sends the machine's bearer token on both routes", async () => {
    stub({ account: account(), profile: profile() });
    await new UsageService().read(machine(), NOW);
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).headers).toEqual({ authorization: 'Bearer tok-pro-456' });
  });

  it('has no usage when signed out', async () => {
    stub({ account: { usageStatus: 'signed-out' }, profile: profile() });
    expect((await new UsageService().read(machine(), NOW)).usage).toBeNull();
  });

  it('has no usage when the answer carries none (SHOW_USAGE off)', async () => {
    stub({ account: { usageStatus: 'ok' }, profile: profile() });
    expect((await new UsageService().read(machine(), NOW)).usage).toBeNull();
  });

  it('has no usage when either window has a null utilization', async () => {
    stub({ account: account({ utilization: null, resetsAt: null }), profile: profile() });
    expect((await new UsageService().read(machine(), NOW)).usage).toBeNull();
    stub({ account: account(undefined, { utilization: null, resetsAt: null }), profile: profile() });
    expect((await new UsageService().read(machine('http://other:4173'), NOW)).usage).toBeNull();
  });

  it('clamps a utilization above 100 to 100', async () => {
    stub({ account: account({ utilization: 130, resetsAt: null }), profile: profile() });
    expect((await new UsageService().read(machine(), NOW)).usage?.fiveHour.pct).toBe(100);
  });
});

describe('UsageService.read — the projection', () => {
  it('runs out when exhaustAt falls before the weekly reset', async () => {
    stub({ account: account(), profile: profile({ exhaustAt: iso(2 * 86_400_000) }) });
    const r = await new UsageService().read(machine(), NOW);
    expect(r.usage?.projection).toBe('runs-out');
    expect(r.usage?.exhaustAt).toBe(iso(2 * 86_400_000));
  });

  it('is safe when exhaustAt is at or after the weekly reset', async () => {
    stub({ account: account(), profile: profile({ exhaustAt: iso(5 * 86_400_000) }) });
    expect((await new UsageService().read(machine(), NOW)).usage?.projection).toBe('safe');
  });

  it('is unknown for a walkAbsent reason', async () => {
    stub({ account: account(), profile: profile({ walkAbsent: 'no-rate' }) });
    expect((await new UsageService().read(machine(), NOW)).usage?.projection).toBe('unknown');
  });

  it('is unknown when the weekly reset is already past, even with a null exhaustAt', async () => {
    stub({ account: account(), profile: profile({ resetsAt: iso(-MIN) }) });
    expect((await new UsageService().read(machine(), NOW)).usage?.projection).toBe('unknown');
  });

  it('keeps the usage and reads the projection as unknown when only the profile fetch fails', async () => {
    stub({ account: account(), profile: () => Promise.reject(new Error('connect ECONNREFUSED')) });
    const r = await new UsageService().read(machine(), NOW);
    expect(r.usage).toMatchObject({ fiveHour: { pct: 12 }, week: { pct: 28 }, projection: 'unknown', exhaustAt: null });
  });
});

describe('UsageService.read — the cache', () => {
  it('shares one fetch per route between concurrent reads of one dashboard', async () => {
    stub({ account: account(), profile: profile() });
    const svc = new UsageService();
    const [a, b] = await Promise.all([svc.read(machine(), NOW), svc.read(machine(), NOW)]);
    expect(a).toEqual(b);
    expect(calls('/api/account')).toBe(1);
    expect(calls('/api/usage/profile')).toBe(1);
  });

  it('keys the cache by the dashboard url', async () => {
    stub({ account: account(), profile: profile() });
    const svc = new UsageService();
    await Promise.all([svc.read(machine('http://a:4173'), NOW), svc.read(machine('http://b:4173'), NOW)]);
    expect(calls('/api/account')).toBe(2);
  });

  it('serves a second read within 60 s from the cache and refetches past it', async () => {
    stub({ account: account(), profile: profile() });
    const svc = new UsageService();
    await svc.read(machine(), NOW);
    const second = await svc.read(machine(), NOW + 59 * 1000);
    expect(calls('/api/account')).toBe(1);
    expect(second.ageMs).toBe(59_000);
    const third = await svc.read(machine(), NOW + 61 * 1000);
    expect(calls('/api/account')).toBe(2);
    expect(third.ageMs).toBe(0);
  });

  it('keeps the previous answer, aged, when a refetch fails', async () => {
    stub({ account: account(), profile: profile() });
    const svc = new UsageService();
    await svc.read(machine(), NOW);
    stub({ account: () => Promise.reject(new Error('connect ECONNREFUSED')), profile: profile() });
    const r = await svc.read(machine(), NOW + 5 * MIN);
    expect(r.ageMs).toBe(5 * MIN);
    expect(r.usage).toMatchObject({ fiveHour: { pct: 12 } });
  });

  it('keeps the previous answer when a refetch answers a non-200', async () => {
    stub({ account: account(), profile: profile() });
    const svc = new UsageService();
    await svc.read(machine(), NOW);
    stub({ account: () => Promise.resolve(new Response('nope', { status: 500 })), profile: profile() });
    expect((await svc.read(machine(), NOW + 2 * MIN)).usage).not.toBeNull();
  });

  it('reports no usage, with its age, once the kept answer is older than 10 minutes', async () => {
    stub({ account: account(), profile: profile() });
    const svc = new UsageService();
    await svc.read(machine(), NOW);
    stub({ account: () => Promise.reject(new Error('connect ECONNREFUSED')), profile: profile() });
    const r = await svc.read(machine(), NOW + 11 * MIN);
    expect(r).toEqual({ usage: null, ageMs: 11 * MIN });
  });

  it('answers no usage and no age when the first fetch fails', async () => {
    stub({ account: () => Promise.reject(new Error('connect ECONNREFUSED')), profile: profile() });
    expect(await new UsageService().read(machine(), NOW)).toEqual({ usage: null, ageMs: null });
  });
});

describe('UsageService.read — a dashboard that hangs (Review Focus 2)', () => {
  it('settles within the 5 s timeout with no usage', async () => {
    jest.useFakeTimers();
    stub({ account: () => new Promise<Response>(() => undefined), profile: () => new Promise<Response>(() => undefined) });
    let settled: { usage: unknown; ageMs: number | null } | undefined;
    const p = new UsageService().read(machine(), NOW).then((r: { usage: unknown; ageMs: number | null }) => (settled = r));
    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toEqual({ usage: null, ageMs: null });
  });

  it('keeps usage when only the profile hangs', async () => {
    jest.useFakeTimers();
    stub({ account: account(), profile: () => new Promise<Response>(() => undefined) });
    const p = new UsageService().read(machine(), NOW);
    await jest.advanceTimersByTimeAsync(5_001);
    const r = await p;
    expect(r.usage).toMatchObject({ fiveHour: { pct: 12 }, projection: 'unknown' });
  });
});
