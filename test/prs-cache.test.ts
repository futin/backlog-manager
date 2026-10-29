import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { PR_TTL_MS, PullRequestsService } from '../server/src/tracker/pulls.service';
import { writeSyncInterval } from '../server/src/tracker/sync-config.util';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FAKE_REPO, FakeGithub } from './helpers/github';
import { makeProject } from './helpers/store';
import type { RegistryService } from '../server/src/registry/registry.service';
import type { PrRepoView, PullRequestRow } from '../shared/types';

/**
 * `PullRequestsService` (Plan B, task 3) — the PRs page's per-repo, on-demand cache. It has no timer: a read happens only inside `list()` (and, from task 4,
 * a write), an entry younger than `PR_TTL_MS` is served without a request, and a failure keeps the last answer and its age.
 *
 * Fixtures discriminate: three registered projects — `futin/x` twice (two checkouts of one repo) and `futin/y` — with PRs #7 and #9 on `futin/x` and #12 on
 * `futin/y`, each with its own title, head, SHA, author and `updatedAt` (the fake derives all of them from repo and number). A view that merged two repos,
 * or listed `futin/x` once per checkout, cannot pass.
 *
 * The clock is `Date.now` under a spy, as in `tracker-failure-verdict.test.ts`, because the poller's `secondaryUntil` reads it; `list(now)` is passed the
 * same value so the two agree.
 */

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
let clock = NOW;
const savedToken = process.env[GITHUB_TOKEN_ENV];
const savedSyncFile = process.env.BM_TRACKER_SYNC_FILE;

beforeEach(() => {
  process.env[GITHUB_TOKEN_ENV] = 'tok';
  const settings = mkdtempSync(join(tmpdir(), 'bm-prs-cache-'));
  dirs.push(settings);
  process.env.BM_TRACKER_SYNC_FILE = join(settings, 'tracker-sync.json');
  clock = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  jest.restoreAllMocks();
  if (savedToken === undefined) delete process.env[GITHUB_TOKEN_ENV];
  else process.env[GITHUB_TOKEN_ENV] = savedToken;
  if (savedSyncFile === undefined) delete process.env.BM_TRACKER_SYNC_FILE;
  else process.env.BM_TRACKER_SYNC_FILE = savedSyncFile;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function githubProject(repo: string): string {
  const root = makeProject('prs-cache', [], JSON.stringify({ kind: 'github', repo }));
  dirs.push(root);
  return root;
}

/** A registry over these paths, answering both the poller's `load()` and the routes' `read()`. */
function registryOf(...paths: string[]): RegistryService {
  const value = { projects: paths.map((path, i) => ({ name: `p${i}`, path, createdAt: '2026-08-26T00:00:00.000Z' })) };
  return { load: () => value, read: () => ({ source: 'file', value }) } as unknown as RegistryService;
}

interface Rig {
  gh: FakeGithub;
  poller: TrackerPollerService;
  prs: PullRequestsService;
  paths: { x1: string; x2: string; y: string };
}

/** `futin/x` registered twice and `futin/y` once; #7 then #9 on `futin/x` (so #9 is the newer), #12 on `futin/y`. One client, as the module provides. */
function rig(): Rig {
  const gh = new FakeGithub();
  gh.addPr(FAKE_REPO, { number: 7 });
  gh.addPr(FAKE_REPO, { number: 9 });
  gh.addPr('futin/y', { number: 12 });
  const paths = { x1: githubProject(FAKE_REPO), x2: githubProject(FAKE_REPO), y: githubProject('futin/y') };
  const registry = registryOf(paths.x1, paths.x2, paths.y);
  const client = new GithubClient(gh.fetch);
  const poller = new TrackerPollerService(registry, client);
  return { gh, poller, prs: new PullRequestsService(registry, client, poller), paths };
}

function view(repos: PrRepoView[], repo: string): PrRepoView {
  const found = repos.find((r) => r.repo === repo);
  if (found === undefined) throw new Error(`no view for ${repo}`);
  return found;
}

const numbers = (v: PrRepoView): number[] => v.prs.map((p) => p.number);
const lists = (gh: FakeGithub, repo?: string): number => gh.graphqlCalls('PullRequests', repo).length;

describe('PullRequestsService.list', () => {
  it('lists each repo once', async () => {
    const { gh, prs } = rig();
    const out = await prs.list(NOW);

    expect(out.token).toBe(true);
    expect(out.repos.map((r) => r.repo)).toEqual([FAKE_REPO, 'futin/y']);
    const x = view(out.repos, FAKE_REPO);
    expect(numbers(x)).toEqual([9, 7]);
    expect(x.prs.map((p) => p.title)).toEqual(['futin/x change 9', 'futin/x change 7']);
    expect(x).toMatchObject({ access: 'ok', detail: null, syncOff: null, total: 2, truncated: false, polledAt: new Date(NOW).toISOString() });
    const y = view(out.repos, 'futin/y');
    expect(numbers(y)).toEqual([12]);
    expect(y.prs[0].head).toBe('feature/y-12');
    expect(y.prs[0].headSha).not.toBe(x.prs[0].headSha);
    expect(lists(gh)).toBe(2);
    expect(lists(gh, FAKE_REPO)).toBe(1);
    expect(lists(gh, 'futin/y')).toBe(1);
  });

  it('serves fresh entries without a request, and re-reads at the TTL', async () => {
    const { gh, prs } = rig();
    expect(PR_TTL_MS).toBe(60_000);
    await prs.list(NOW);

    clock = NOW + 59_000;
    const served = await prs.list(clock);
    expect(lists(gh)).toBe(2);
    expect(view(served.repos, FAKE_REPO).polledAt).toBe(new Date(NOW).toISOString());

    clock = NOW + 60_000;
    const reread = await prs.list(clock);
    expect(lists(gh, FAKE_REPO)).toBe(2);
    expect(lists(gh, 'futin/y')).toBe(2);
    expect(view(reread.repos, FAKE_REPO).polledAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('shares one in-flight query per repo between concurrent reads', async () => {
    const { gh, prs } = rig();
    const release = gh.holdAnswers();
    const pending = [prs.list(NOW), prs.list(NOW), prs.list(NOW)];
    // Let every call reach the fake before anything answers.
    await new Promise((resolve) => setImmediate(resolve));
    expect(lists(gh)).toBe(2);
    release();
    const answers = await Promise.all(pending);

    expect(lists(gh)).toBe(2);
    for (const out of answers) {
      expect(numbers(view(out.repos, FAKE_REPO))).toEqual([9, 7]);
      expect(numbers(view(out.repos, 'futin/y'))).toEqual([12]);
    }
  });

  it('makes no read without a request — the service owns no timer', () => {
    jest.useFakeTimers();
    try {
      const { gh } = rig();
      jest.advanceTimersByTime(10 * 60_000);
      expect(gh.graphqlCalls()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers token: false with no repos and no request when there is no token', async () => {
    delete process.env[GITHUB_TOKEN_ENV];
    const { gh, prs } = rig();
    expect(await prs.list(NOW)).toEqual({ token: false, repos: [] });
    expect(gh.calls).toHaveLength(0);
  });

  it('keeps the last answer and its age when a read fails', async () => {
    const { gh, prs } = rig();
    await prs.list(NOW);

    gh.failNext = { fragment: '/graphql', status: 502, message: 'Bad gateway', repo: FAKE_REPO };
    clock = NOW + 60_000;
    const out = await prs.list(clock);

    const x = view(out.repos, FAKE_REPO);
    expect(numbers(x)).toEqual([9, 7]);
    expect(x.polledAt).toBe(new Date(NOW).toISOString());
    expect(x.access).toBe('error');
    expect(x.detail).toBe('Bad gateway');
    const y = view(out.repos, 'futin/y');
    expect(y).toMatchObject({ access: 'ok', polledAt: new Date(NOW + 60_000).toISOString() });
    expect(numbers(y)).toEqual([12]);
  });

  it('a rate limit sleeps that one repo until its reset', async () => {
    const { gh, prs } = rig();
    const reset = NOW / 1000 + 900;
    gh.failNext = {
      fragment: '/graphql',
      repo: FAKE_REPO,
      graphqlError: { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
    };
    const first = await prs.list(NOW);
    const x = view(first.repos, FAKE_REPO);
    expect(x.access).toBe('rate-limited');
    expect(x.detail).toBe(`rate limit reached — resets ${new Date(reset * 1000).toISOString()}`);
    expect(x.prs).toEqual([]);
    expect(x.polledAt).toBeNull();

    clock = NOW + 120_000;
    const later = await prs.list(clock);
    expect(lists(gh, FAKE_REPO)).toBe(1);
    expect(lists(gh, 'futin/y')).toBe(2);
    expect(view(later.repos, FAKE_REPO)).toMatchObject({ access: 'rate-limited', detail: x.detail });

    // Past the reset the repo is read again.
    clock = reset * 1000 + 1;
    const woken = await prs.list(clock);
    expect(lists(gh, FAKE_REPO)).toBe(2);
    expect(view(woken.repos, FAKE_REPO)).toMatchObject({ access: 'ok', detail: null });
    expect(numbers(view(woken.repos, FAKE_REPO))).toEqual([9, 7]);
  });

  it("a secondary limit on a PR read sleeps the poller's repo too", async () => {
    const { gh, poller, prs } = rig();
    gh.failNext = { fragment: '/graphql', status: 403, message: 'You have exceeded a secondary rate limit', repo: FAKE_REPO };
    const out = await prs.list(NOW);
    expect(view(out.repos, FAKE_REPO).access).toBe('rate-limited');
    expect(poller.secondaryUntil(FAKE_REPO)).toBe(NOW + 60_000);
    expect(poller.secondaryUntil('futin/y')).toBeNull();

    clock = NOW + 30_000;
    await poller.tick();
    expect(gh.matching(`/repos/${FAKE_REPO}/`)).toHaveLength(0);
    expect(gh.matching('/repos/futin/y/issues?')).toHaveLength(1);
    poller.disarm();

    // And the PR cache itself makes no request for the repo inside the backoff.
    clock = NOW + 59_000;
    await prs.list(clock);
    expect(lists(gh, FAKE_REPO)).toBe(1);
  });

  it("a secondary limit the poller met sleeps the PR cache's repo, with the sleep as detail", async () => {
    const { gh, poller, prs } = rig();
    poller.noteSecondary(FAKE_REPO, NOW + 60_000);
    const out = await prs.list(NOW);

    expect(lists(gh, FAKE_REPO)).toBe(0);
    expect(lists(gh, 'futin/y')).toBe(1);
    const x = view(out.repos, FAKE_REPO);
    expect(x).toMatchObject({ access: 'rate-limited', prs: [], total: 0, truncated: false, polledAt: null });
    expect(x.detail).toContain(new Date(NOW + 60_000).toISOString());
  });

  it('carries sync off as a field, not a filter', async () => {
    writeSyncInterval('futin/y', 'off');
    const { prs } = rig();
    const out = await prs.list(NOW);

    const y = view(out.repos, 'futin/y');
    expect(y.syncOff).toBe('sync is off for futin/y — turn it on in GitHub › Settings');
    expect(numbers(y)).toEqual([12]);
    expect(view(out.repos, FAKE_REPO).syncOff).toBeNull();
  });

  it('says when GitHub had more open PRs than one page', async () => {
    const { gh, prs } = rig();
    for (let n = 100; n < 239; n++) gh.addPr('futin/y', { number: n });
    const out = await prs.list(NOW);

    const y = view(out.repos, 'futin/y');
    expect(y.total).toBe(140);
    expect(y.prs).toHaveLength(100);
    expect(y.truncated).toBe(true);
    expect(view(out.repos, FAKE_REPO)).toMatchObject({ total: 2, truncated: false });
  });

  it("offers only the repo's allowed merge methods, in MERGE_METHODS order", async () => {
    const { gh, prs } = rig();
    gh.setRepoSettings(FAKE_REPO, { squashMergeAllowed: false, autoMergeAllowed: false });
    const out = await prs.list(NOW);

    expect(view(out.repos, FAKE_REPO)).toMatchObject({ methods: ['merge', 'rebase'], autoMergeAllowed: false });
    expect(view(out.repos, 'futin/y')).toMatchObject({ methods: ['squash', 'merge', 'rebase'], autoMergeAllowed: true });
  });
});

describe('PullRequestsService.splice', () => {
  it('replaces, adds and removes one cached row, leaving the other repo alone', async () => {
    const { gh, prs } = rig();
    const before = await prs.list(NOW);
    const x = view(before.repos, FAKE_REPO);
    const y = view(before.repos, 'futin/y');

    const seven = x.prs.find((p) => p.number === 7) as PullRequestRow;
    prs.splice(FAKE_REPO, { ...seven, title: 'renamed seven' }, 7);
    const twenty: PullRequestRow = { ...seven, number: 20, title: 'futin/x change 20', head: 'feature/x-20', updatedAt: '2026-10-02T09:00:00.000Z' };
    prs.splice(FAKE_REPO, twenty, 20);
    prs.splice(FAKE_REPO, null, 9);

    // Served from the cache (inside the TTL): the splices are what the page sees, with no further request.
    clock = NOW + 1_000;
    const after = await prs.list(clock);
    expect(lists(gh)).toBe(2);
    const x2 = view(after.repos, FAKE_REPO);
    expect(numbers(x2)).toEqual([20, 7]);
    expect(x2.prs.find((p) => p.number === 7)?.title).toBe('renamed seven');
    expect(x2).toMatchObject({ total: 2, truncated: false, polledAt: new Date(NOW).toISOString() });
    expect(view(after.repos, 'futin/y')).toEqual(y);
  });

  it('a removal of a PR the cache does not hold changes nothing', async () => {
    const { prs } = rig();
    await prs.list(NOW);
    prs.splice(FAKE_REPO, null, 404);
    const out = await prs.list(NOW + 1_000);
    expect(view(out.repos, FAKE_REPO)).toMatchObject({ total: 2 });
    expect(numbers(view(out.repos, FAKE_REPO))).toEqual([9, 7]);
  });
});
