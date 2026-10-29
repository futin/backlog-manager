import { rmSync } from 'node:fs';

import { GithubClient, type GithubResponse } from '../server/src/tracker/github.client';
import { SECONDARY_BACKOFF_MS, TrackerPollerService, failureVerdict } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FakeGithub } from './helpers/github';
import { makeProject } from './helpers/store';
import type { RegistryService } from '../server/src/registry/registry.service';

/**
 * `failureVerdict` (Plan B, task 1) — the poller's failure rule as one pure function, so the PR cache can apply the very same mapping to a GraphQL or write
 * answer. The unit table pins the rule at a fixed `now`; the equivalence cases feed the SAME response through a real poller sweep and demand the access and
 * detail it records match the verdict's, so a refactor that drifted the strings would fail here rather than on a card. Two repos throughout: `futin/x` is the
 * one that fails and `futin/y` answers 200, so a verdict applied to the wrong repo's state shows up as `futin/y` leaving `ok`.
 *
 * The clock is `Date.now` under a spy, the way `tracker-sync-interval.test.ts` pins it; ticks are driven by calling `tick()` directly.
 */

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
let clock = NOW;
const savedToken = process.env[GITHUB_TOKEN_ENV];

beforeEach(() => {
  process.env[GITHUB_TOKEN_ENV] = 'tok';
  clock = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  jest.restoreAllMocks();
  if (savedToken === undefined) delete process.env[GITHUB_TOKEN_ENV];
  else process.env[GITHUB_TOKEN_ENV] = savedToken;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function githubProject(repo: string): string {
  const root = makeProject('verdict', [], JSON.stringify({ kind: 'github', repo }));
  dirs.push(root);
  return root;
}

function registryOf(...paths: string[]): RegistryService {
  return {
    load: () => ({ projects: paths.map((path, i) => ({ name: `p${i}`, path, createdAt: '2026-08-26T00:00:00.000Z' })) })
  } as unknown as RegistryService;
}

function response(over: Partial<GithubResponse<unknown>>): GithubResponse<unknown> {
  return {
    status: 200,
    data: null,
    etag: null,
    next: null,
    retryAfter: null,
    secondary: false,
    error: null,
    rate: { limit: null, remaining: null, reset: null },
    ...over
  };
}

/** Two registered repos on one fake GitHub; `futin/y` answers empty and healthy. */
function twoRepos(): { gh: FakeGithub; poller: TrackerPollerService } {
  const gh = new FakeGithub();
  gh.addRepo('futin/y');
  const poller = new TrackerPollerService(registryOf(githubProject('futin/x'), githubProject('futin/y')), new GithubClient(gh.fetch));
  return { gh, poller };
}

describe('failureVerdict', () => {
  it('is null for a 2xx and a 304', () => {
    expect(failureVerdict(response({ status: 200 }), NOW)).toBeNull();
    expect(failureVerdict(response({ status: 304 }), NOW)).toBeNull();
    expect(failureVerdict(response({ status: 201 }), NOW)).toBeNull();
  });

  it('sleeps a minute on a secondary limit', () => {
    const verdict = failureVerdict(response({ status: 403, secondary: true }), NOW);
    expect(verdict).toMatchObject({ access: 'rate-limited', sleepUntil: NOW + 60_000, secondary: true });
    expect(SECONDARY_BACKOFF_MS).toBe(60_000);
  });

  it('sleeps until the reset on a 403 at the hourly limit, and is not secondary', () => {
    const verdict = failureVerdict(response({ status: 403, rate: { limit: 60, remaining: 0, reset: 1_700_000_900 } }), NOW);
    expect(verdict).toMatchObject({ access: 'rate-limited', sleepUntil: 1_700_000_900_000, secondary: false });
    expect(verdict?.detail).toBe(`rate limit reached — resets ${new Date(1_700_000_900_000).toISOString()}`);
  });

  it('sleeps Retry-After seconds from now on a 429', () => {
    const verdict = failureVerdict(response({ status: 429, retryAfter: 30 }), NOW);
    expect(verdict).toMatchObject({ access: 'rate-limited', sleepUntil: NOW + 30_000, secondary: false });
  });

  it('reads a 403 with budget left as forbidden, not a limit', () => {
    const verdict = failureVerdict(response({ status: 403, error: 'Resource not accessible', rate: { limit: 60, remaining: 12, reset: 1_700_000_900 } }), NOW);
    expect(verdict).toEqual({ access: 'forbidden', detail: 'Resource not accessible', sleepUntil: null, secondary: false });
  });

  it('reads 401 as forbidden, 404 as not-found, anything else as error', () => {
    expect(failureVerdict(response({ status: 401, error: 'Bad credentials' }), NOW)).toMatchObject({ access: 'forbidden', detail: 'Bad credentials', sleepUntil: null });
    expect(failureVerdict(response({ status: 404, error: 'Not Found' }), NOW)).toMatchObject({ access: 'not-found', detail: 'Not Found', sleepUntil: null });
    expect(failureVerdict(response({ status: 502, error: null }), NOW)).toEqual({ access: 'error', detail: 'HTTP 502', sleepUntil: null, secondary: false });
    expect(failureVerdict(response({ status: 0, error: 'fetch failed' }), NOW)).toEqual({ access: 'error', detail: 'fetch failed', sleepUntil: null, secondary: false });
  });
});

describe('the poller applies the same verdict', () => {
  /** One failing issues read for `futin/x`, as the fake sends it, and the verdict the same response earns through a real client. */
  const cases: [string, { status: number; headers?: Record<string, string>; message?: string }][] = [
    ['a secondary limit', { status: 403, message: 'You have exceeded a secondary rate limit' }],
    ['the hourly limit', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 600) } }],
    ['a 429 with Retry-After', { status: 429, headers: { 'retry-after': '30' } }],
    ['a 403 with budget left', { status: 403, headers: { 'x-ratelimit-remaining': '12' }, message: 'Resource not accessible' }],
    ['a 401', { status: 401, message: 'Bad credentials' }],
    ['a 404', { status: 404, message: 'Not Found' }],
    ['a 502', { status: 502, message: 'Bad gateway' }]
  ];

  it.each(cases)('records, for %s, what failureVerdict says — and leaves the other repo ok', async (_name, failure) => {
    const { gh, poller } = twoRepos();
    gh.failNext = { fragment: '/repos/futin/x/issues?', ...failure };
    await poller.tick();

    const probe = new FakeGithub();
    probe.failNext = { fragment: '/repos/futin/x/issues', ...failure };
    const res = await new GithubClient(probe.fetch).issues('futin/x', { token: 'tok' });
    const verdict = failureVerdict(res, clock);
    expect(verdict).not.toBeNull();

    const summary = poller.summary('futin/x');
    expect(summary.access).toBe(verdict?.access);
    expect(summary.detail).toBe(verdict?.detail);
    expect(poller.summary('futin/y').access).toBe('ok');
    poller.disarm();
  });
});

describe('noteSecondary', () => {
  it('puts a repo to sleep for the sweep without touching another', async () => {
    const { gh, poller } = twoRepos();
    poller.noteSecondary('futin/x', NOW + 60_000);
    expect(poller.secondaryUntil('futin/x')).toBe(NOW + 60_000);
    expect(poller.secondaryUntil('futin/y')).toBeNull();

    clock = NOW + 1_000;
    await poller.tick();
    expect(gh.matching('/repos/futin/x/')).toHaveLength(0);
    expect(gh.matching('/repos/futin/y/issues?')).toHaveLength(1);
    poller.disarm();
  });

  it('never shortens a sleep already set', async () => {
    const { gh, poller } = twoRepos();
    poller.noteSecondary('futin/x', NOW + 60_000);
    poller.noteSecondary('futin/x', NOW + 10_000);
    expect(poller.secondaryUntil('futin/x')).toBe(NOW + 60_000);

    // Past the shorter bound, inside the longer one: still no request for futin/x.
    clock = NOW + 20_000;
    await poller.tick();
    expect(gh.matching('/repos/futin/x/')).toHaveLength(0);
    poller.disarm();
  });

  it('wakes the repo once the sleep has passed', async () => {
    const { gh, poller } = twoRepos();
    poller.noteSecondary('futin/x', NOW + 60_000);
    clock = NOW + 61_000;
    expect(poller.secondaryUntil('futin/x')).toBeNull();
    await poller.tick();
    expect(gh.matching('/repos/futin/x/issues?')).toHaveLength(1);
    poller.disarm();
  });

  it("is also what the poller's own secondary limit sets", async () => {
    const { gh, poller } = twoRepos();
    gh.failNext = { fragment: '/repos/futin/x/issues?', status: 403, message: 'You have exceeded a secondary rate limit' };
    await poller.tick();
    expect(poller.secondaryUntil('futin/x')).toBe(NOW + SECONDARY_BACKOFF_MS);
    poller.disarm();
  });
});
