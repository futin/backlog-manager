import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GithubClient } from '../../server/src/tracker/github.client';
import { TrackerPollerService } from '../../server/src/tracker/poller.service';
import { PullRequestsService } from '../../server/src/tracker/pulls.service';
import { writeSyncInterval } from '../../server/src/tracker/sync-config.util';
import { GITHUB_TOKEN_ENV } from '../../server/src/tracker/token.util';
import { FAKE_REPO, FakeGithub } from '../helpers/github';
import { makeProject } from '../helpers/store';
import type { RegistryService } from '../../server/src/registry/registry.service';

/**
 * `PullRequestsService.projectFor` and `readOne` — the two public reads the resolve route's ladder calls (spec 2026-11-17-pr-conflict-resolve-design.md).
 * The rig is `prs-cache.test.ts`'s: `futin/x` registered twice, so "the first path in registry order" is observable, and PR #7 on it with its own SHA.
 */

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
const savedToken = process.env[GITHUB_TOKEN_ENV];
const savedSyncFile = process.env.BM_TRACKER_SYNC_FILE;

beforeEach(() => {
  process.env[GITHUB_TOKEN_ENV] = 'tok';
  const settings = mkdtempSync(join(tmpdir(), 'bm-prs-read-one-'));
  dirs.push(settings);
  process.env.BM_TRACKER_SYNC_FILE = join(settings, 'tracker-sync.json');
});

afterEach(() => {
  if (savedToken === undefined) delete process.env[GITHUB_TOKEN_ENV];
  else process.env[GITHUB_TOKEN_ENV] = savedToken;
  if (savedSyncFile === undefined) delete process.env.BM_TRACKER_SYNC_FILE;
  else process.env.BM_TRACKER_SYNC_FILE = savedSyncFile;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function githubProject(repo: string): string {
  const root = makeProject('prs-read-one', [], JSON.stringify({ kind: 'github', repo }));
  dirs.push(root);
  return root;
}

function registryOf(...paths: string[]): RegistryService {
  const value = { projects: paths.map((path, i) => ({ name: `p${i}`, path, createdAt: '2026-08-26T00:00:00.000Z' })) };
  return { load: () => value, read: () => ({ source: 'file', value }) } as unknown as RegistryService;
}

function rig() {
  const gh = new FakeGithub();
  gh.addPr(FAKE_REPO, { number: 7 });
  const paths = { x1: githubProject(FAKE_REPO), x2: githubProject(FAKE_REPO) };
  const registry = registryOf(paths.x1, paths.x2);
  const client = new GithubClient(gh.fetch);
  const poller = new TrackerPollerService(registry, client);
  return { gh, prs: new PullRequestsService(registry, client, poller), paths };
}

const reads = (gh: FakeGithub): number => gh.graphqlCalls('PullRequest').length;

describe('PullRequestsService.projectFor', () => {
  it('answers the FIRST registered path for a repo two projects share', () => {
    const { prs, paths } = rig();
    expect(prs.projectFor(FAKE_REPO)).toEqual({ ok: true, path: paths.x1 });
  });

  it('refuses a repo no registered project resolves to with 404', () => {
    const { prs } = rig();
    expect(prs.projectFor('acme/none')).toEqual({ ok: false, status: 404, error: 'acme/none is not the repo of a registered GitHub project' });
  });

  it("refuses a repo whose sync is off with 409 and the poller's sentence", () => {
    const { prs } = rig();
    writeSyncInterval(FAKE_REPO, 'off');
    expect(prs.projectFor(FAKE_REPO)).toEqual({ ok: false, status: 409, error: 'sync is off for futin/x — turn it on in GitHub › Settings' });
  });
});

describe('PullRequestsService.readOne', () => {
  it('refuses with 503 and sends nothing when there is no token', async () => {
    const { gh, prs } = rig();
    delete process.env[GITHUB_TOKEN_ENV];
    expect(await prs.readOne(FAKE_REPO, 7, NOW)).toEqual({ ok: false, status: 503, error: 'BM_GITHUB_TOKEN is not set on this machine' });
    expect(gh.calls).toHaveLength(0);
  });

  it('a rate limit answers 429 with the verdict, and the next read is refused with no request', async () => {
    const { gh, prs } = rig();
    const reset = NOW / 1000 + 900;
    gh.failNext = {
      fragment: '/graphql',
      repo: FAKE_REPO,
      graphqlError: { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
    };
    const detail = `rate limit reached — resets ${new Date(reset * 1000).toISOString()}`;
    expect(await prs.readOne(FAKE_REPO, 7, NOW)).toEqual({ ok: false, status: 429, error: detail });
    expect(reads(gh)).toBe(1);

    // The pool slept: refused as asleep, with the sleep's detail and no second request.
    expect(await prs.readOne(FAKE_REPO, 7, NOW + 1000)).toEqual({ ok: false, status: 429, error: detail });
    expect(reads(gh)).toBe(1);
  });

  it('a 500 answers 502 with the repo and number', async () => {
    const { gh, prs } = rig();
    gh.failNext = { fragment: '/graphql', repo: FAKE_REPO, status: 500, message: 'boom' };
    expect(await prs.readOne(FAKE_REPO, 7, NOW)).toEqual({ ok: false, status: 502, error: 'could not read futin/x#7 from GitHub' });
  });

  it('an OPEN PR is answered and its row spliced into the cached list; a CLOSED one is answered and its row removed', async () => {
    const { gh, prs } = rig();
    await prs.list(NOW);
    expect(reads(gh)).toBe(0);

    const open = await prs.readOne(FAKE_REPO, 7, NOW);
    expect(open).toMatchObject({ ok: true, pr: { state: 'OPEN', row: { number: 7 } } });

    gh.pulls.get(FAKE_REPO)?.forEach((p) => {
      if (p.number === 7) p.state = 'CLOSED';
    });
    const closed = await prs.readOne(FAKE_REPO, 7, NOW);
    expect(closed).toMatchObject({ ok: true, pr: { state: 'CLOSED' } });
    const after = await prs.list(NOW);
    expect(after.repos.find((r) => r.repo === FAKE_REPO)?.prs.map((p) => p.number)).toEqual([]);
  });

  it('an open read puts the row in a cache that did not hold it', async () => {
    const { gh, prs } = rig();
    await prs.list(NOW);
    gh.addPr(FAKE_REPO, { number: 9 });
    const res = await prs.readOne(FAKE_REPO, 9, NOW);
    expect(res).toMatchObject({ ok: true, pr: { state: 'OPEN' } });
    const after = await prs.list(NOW);
    expect(after.repos.find((r) => r.repo === FAKE_REPO)?.prs.map((p) => p.number).sort()).toEqual([7, 9]);
  });

  it("GraphQL's null pullRequest is { ok: true, pr: null }, not a 502, and drops any cached row", async () => {
    const { gh, prs } = rig();
    await prs.list(NOW);
    gh.pulls.set(FAKE_REPO, []);
    expect(await prs.readOne(FAKE_REPO, 7, NOW)).toEqual({ ok: true, pr: null });
    const after = await prs.list(NOW);
    expect(after.repos.find((r) => r.repo === FAKE_REPO)?.prs).toEqual([]);
  });
});
