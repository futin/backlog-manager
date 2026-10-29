import { API, GithubClient } from '../server/src/tracker/github.client';
import { failureVerdict } from '../server/src/tracker/poller.service';
import { PR_LIST_QUERY, readPull, readPullList, setAutoMerge, toRow, type GqlPullRequest } from '../server/src/tracker/pulls.query';
import { FAKE_REPO, FakeGithub } from './helpers/github';

/**
 * `GithubClient.graphql`, the PR queries in `pulls.query.ts`, and the fake GitHub's PR surface (Plan B, Task 2).
 *
 * The rate cases use a hand fake, because what they assert is which POOL a response's headers land in, and that needs a REST answer and a GraphQL answer
 * carrying different numbers. Everything else goes through `FakeGithub` inside a real client, so the client's normalisation stays under test.
 */

const TOKEN = 'ghp_fake';

/** A `fetch` answering by URL: `status`, a JSON body, and the given headers. */
function byUrl(answers: (url: string) => { status: number; body: unknown; headers?: Record<string, string> }): typeof fetch {
  return (async (url: string) => {
    const a = answers(url);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: a.headers });
  }) as unknown as typeof fetch;
}

describe('GithubClient.graphql', () => {
  it('graphql rate is its own pool', async () => {
    const client = new GithubClient(
      byUrl((url) =>
        url.endsWith('/graphql')
          ? { status: 200, body: { data: { ok: true } }, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } }
          : { status: 200, body: [], headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1800000000' } }
      )
    );
    await client.issues('futin/x', { token: TOKEN });
    const res = await client.graphql<{ ok: boolean }>('query Q { ok }', {}, { token: TOKEN });

    expect(client.rate.remaining).toBe(4000);
    expect(client.rate.reset).toBe(1800000000);
    expect(client.graphqlRate.remaining).toBe(0);
    expect(client.graphqlRate.reset).toBe(1900000000);
    // R1: the answer's own `rate` is GraphQL's, so `failureVerdict` reads the pool that answered.
    expect(res.rate.remaining).toBe(0);
    expect(res.data).toEqual({ ok: true });

    // And a REST answer after it leaves GraphQL's reading alone.
    await client.issues('futin/x', { token: TOKEN });
    expect(client.graphqlRate.remaining).toBe(0);
  });

  it('POSTs the query and variables to the one host', async () => {
    const gh = new FakeGithub();
    const client = new GithubClient(gh.fetch);
    await client.graphql('query PullRequests { x }', { owner: 'futin', name: 'x' }, { token: TOKEN });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0].method).toBe('POST');
    expect(gh.calls[0].url).toBe(`${API}/graphql`);
    expect(gh.calls[0].body).toEqual({ query: 'query PullRequests { x }', variables: { owner: 'futin', name: 'x' } });
  });

  describe('errors mapping', () => {
    async function answer(graphqlError: { type: string; message: string }) {
      const gh = new FakeGithub();
      gh.failNext = { fragment: '/graphql', graphqlError };
      const client = new GithubClient(gh.fetch);
      return client.graphql('query PullRequests { x }', { owner: 'futin', name: 'x' }, { token: TOKEN });
    }

    it('RATE_LIMITED is a 429 the failure rule sleeps on', async () => {
      const res = await answer({ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' });
      expect(res.status).toBe(429);
      expect(res.error).toBe('API rate limit exceeded for user ID 1.');
      expect(res.data).toBeNull();
      expect(res.rate.remaining).toBe(0);
      const verdict = failureVerdict(res, Date.now());
      expect(verdict?.access).toBe('rate-limited');
      expect(verdict?.secondary).toBe(false);
    });

    it('FORBIDDEN is a 403', async () => {
      const res = await answer({ type: 'FORBIDDEN', message: 'Resource not accessible by integration' });
      expect(res.status).toBe(403);
      expect(res.error).toBe('Resource not accessible by integration');
    });

    it('NOT_FOUND is a 404', async () => {
      const res = await answer({ type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'futin/q'." });
      expect(res.status).toBe(404);
      expect(res.error).toBe("Could not resolve to a Repository with the name 'futin/q'.");
    });

    it('any other typed error keeps the 200 and sets error', async () => {
      const res = await answer({ type: 'UNPROCESSABLE', message: 'Pull request is in clean status' });
      expect(res.status).toBe(200);
      expect(res.error).toBe('Pull request is in clean status');
      expect(res.data).toBeNull();
    });

    it('joins every message, and the first typed error picks the status', async () => {
      const client = new GithubClient(
        byUrl(() => ({ status: 200, body: { data: null, errors: [{ message: 'first' }, { type: 'NOT_FOUND', message: 'second' }] } }))
      );
      const res = await client.graphql('query Q { x }', {}, { token: TOKEN });
      expect(res.status).toBe(404);
      expect(res.error).toBe('first; second');
    });

    it('a network failure is status 0', async () => {
      const client = new GithubClient((async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      }) as unknown as typeof fetch);
      const res = await client.graphql('query Q { x }', {}, { token: TOKEN });
      expect(res.status).toBe(0);
      expect(res.error).toBe('getaddrinfo ENOTFOUND api.github.com');
    });

    it('a 403 with the secondary-limit body is secondary', async () => {
      const gh = new FakeGithub();
      gh.failNext = { fragment: '/graphql', status: 403, message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' };
      const res = await new GithubClient(gh.fetch).graphql('query Q { x }', {}, { token: TOKEN });
      expect(res.status).toBe(403);
      expect(res.secondary).toBe(true);
      expect(failureVerdict(res, Date.now())?.secondary).toBe(true);
    });
  });
});

/** Two nodes with every field distinct, so a mapping that reads one field into another — or one node's into the other's row — fails. */
const NODE_7: GqlPullRequest = {
  number: 7,
  title: 'feat: seven',
  url: 'https://github.com/futin/x/pull/7',
  isDraft: true,
  headRefName: 'backlog/31',
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  isCrossRepository: false,
  maintainerCanModify: true,
  updatedAt: '2026-10-20T10:00:00Z',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'BEHIND',
  reviewDecision: 'CHANGES_REQUESTED',
  viewerCanUpdateBranch: true,
  author: { login: 'alice' },
  autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: '2026-10-21T09:00:00Z' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] }
};

const NODE_12: GqlPullRequest = {
  number: 12,
  title: 'fix: twelve',
  url: 'https://github.com/futin/x/pull/12',
  isDraft: false,
  headRefName: 'contrib/patch',
  headRefOid: 'b'.repeat(40),
  baseRefName: 'develop',
  isCrossRepository: true,
  maintainerCanModify: false,
  updatedAt: '2026-10-22T11:30:00Z',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  viewerCanUpdateBranch: false,
  author: { login: 'bob' },
  autoMergeRequest: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'EXPECTED' } } }] }
};

describe('toRow', () => {
  it('maps every field of each node onto its own row', () => {
    expect(toRow(NODE_7)).toEqual({
      number: 7,
      title: 'feat: seven',
      url: 'https://github.com/futin/x/pull/7',
      author: 'alice',
      draft: true,
      head: 'backlog/31',
      headSha: 'a'.repeat(40),
      base: 'main',
      crossRepository: false,
      maintainerCanModify: true,
      updatedAt: '2026-10-20T10:00:00Z',
      mergeable: 'conflicting',
      mergeState: 'behind',
      review: 'changes-requested',
      checks: 'failure',
      autoMerge: { method: 'squash', enabledAt: '2026-10-21T09:00:00Z' },
      canUpdateBranch: true
    });
    expect(toRow(NODE_12)).toEqual({
      number: 12,
      title: 'fix: twelve',
      url: 'https://github.com/futin/x/pull/12',
      author: 'bob',
      draft: false,
      head: 'contrib/patch',
      headSha: 'b'.repeat(40),
      base: 'develop',
      crossRepository: true,
      maintainerCanModify: false,
      updatedAt: '2026-10-22T11:30:00Z',
      mergeable: 'mergeable',
      mergeState: 'clean',
      review: 'approved',
      checks: 'pending',
      autoMerge: null,
      canUpdateBranch: false
    });
  });

  it('maps the remaining enum values', () => {
    const row = (over: Partial<GqlPullRequest>) => toRow({ ...NODE_12, ...over });
    expect(row({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }).checks).toBe('success');
    expect(row({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }).checks).toBe('failure');
    expect(row({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }).checks).toBe('pending');
    expect(row({ mergeable: 'UNKNOWN' }).mergeable).toBe('unknown');
    expect(row({ reviewDecision: 'REVIEW_REQUIRED' }).review).toBe('review-required');
    expect(row({ reviewDecision: null }).review).toBeNull();
    expect(row({ autoMergeRequest: { mergeMethod: 'REBASE', enabledAt: null } }).autoMerge).toEqual({ method: 'rebase', enabledAt: '' });
    expect(row({ autoMergeRequest: { mergeMethod: 'MERGE', enabledAt: '2026-10-23T00:00:00Z' } }).autoMerge?.method).toBe('merge');
  });

  it('no commits or no rollup is checks none', () => {
    expect(toRow({ ...NODE_7, commits: { nodes: [] } }).checks).toBe('none');
    expect(toRow({ ...NODE_7, commits: null }).checks).toBe('none');
    expect(toRow({ ...NODE_7, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }).checks).toBe('none');
  });

  it('a deleted author is null', () => {
    expect(toRow({ ...NODE_7, author: null }).author).toBeNull();
  });
});

describe('the PR queries against the fake', () => {
  it('the list query sent for futin/y names futin/y and asks for the newest 100 open PRs', async () => {
    const gh = new FakeGithub();
    const y12 = gh.addPr('futin/y', { number: 12, updatedAt: '2026-10-22T11:00:00Z', author: 'bob' });
    const y15 = gh.addPr('futin/y', { number: 15, updatedAt: '2026-10-24T08:00:00Z', author: 'carol' });
    gh.addPr('futin/y', { number: 14, state: 'MERGED' });
    gh.addPr(FAKE_REPO, { number: 7, author: 'alice' });
    gh.setRepoSettings('futin/y', { mergeCommitAllowed: false, autoMergeAllowed: false });
    const client = new GithubClient(gh.fetch);

    const res = await readPullList(client, 'futin/y', { token: TOKEN });

    expect(gh.calls).toHaveLength(1);
    const sent = gh.calls[0].body as { query: string; variables: Record<string, unknown> };
    expect(sent.query).toBe(PR_LIST_QUERY);
    expect(sent.variables).toEqual({ owner: 'futin', name: 'y' });
    expect(sent.query).toContain('repository(owner: $owner, name: $name)');
    expect(sent.query).toContain('first: 100');
    expect(sent.query).toContain('states: OPEN');
    expect(sent.query).toContain('orderBy: { field: UPDATED_AT, direction: DESC }');
    expect(gh.graphqlCalls('PullRequests', 'futin/y')).toHaveLength(1);

    expect(res.status).toBe(200);
    expect(res.error).toBeNull();
    expect(res.data?.rows.map((r) => [r.number, r.author, r.headSha])).toEqual([
      [15, 'carol', y15.headRefOid],
      [12, 'bob', y12.headRefOid]
    ]);
    expect(res.data?.totalCount).toBe(2);
    expect(res.data).toMatchObject({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, autoMergeAllowed: false });
  });

  it('refuses a malformed repo without a request', async () => {
    const gh = new FakeGithub();
    const client = new GithubClient(gh.fetch);
    const list = await readPullList(client, 'nope', { token: TOKEN });
    const one = await readPull(client, 'futin/x/../y', 7, { token: TOKEN });
    const zero = await readPull(client, FAKE_REPO, 0, { token: TOKEN });
    expect([list.status, one.status, zero.status]).toEqual([0, 0, 0]);
    expect(list.error).toContain('not an owner/name repository');
    expect(zero.error).toBe('not a pull request number: 0');
    expect(gh.calls).toHaveLength(0);
  });

  it('a repo the token cannot see is a 404', async () => {
    const gh = new FakeGithub();
    const res = await readPullList(new GithubClient(gh.fetch), 'futin/q', { token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.data).toBeNull();
  });

  it('the single read sees any state and carries the node id beside the row', async () => {
    const gh = new FakeGithub();
    const x7 = gh.addPr(FAKE_REPO, { number: 7, title: 'seven' });
    gh.addPr('futin/y', { number: 7, title: 'other seven' });
    x7.state = 'MERGED';
    const res = await readPull(new GithubClient(gh.fetch), FAKE_REPO, 7, { token: TOKEN });
    expect(res.data?.id).toBe(x7.id);
    expect(res.data?.state).toBe('MERGED');
    expect(res.data?.row.title).toBe('seven');
    expect(res.data?.row).not.toHaveProperty('id');
    expect(gh.graphqlCalls('PullRequest', FAKE_REPO)).toHaveLength(1);

    const missing = await readPull(new GithubClient(gh.fetch), FAKE_REPO, 99, { token: TOKEN });
    expect(missing.status).toBe(404);
  });

  it('arms and disarms auto-merge by node id, and a repo with it off answers GitHub text', async () => {
    const gh = new FakeGithub();
    const y12 = gh.addPr('futin/y', { number: 12 });
    const x7 = gh.addPr(FAKE_REPO, { number: 7 });
    gh.setRepoSettings(FAKE_REPO, { autoMergeAllowed: false });
    const client = new GithubClient(gh.fetch);

    const on = await setAutoMerge(client, y12.id, { enable: true, method: 'rebase' }, { token: TOKEN });
    expect(on.status).toBe(200);
    expect(on.error).toBeNull();
    expect((gh.calls[0].body as { variables: unknown }).variables).toEqual({ id: y12.id, method: 'REBASE' });
    expect(gh.calls[0].operation).toBe('EnableAutoMerge');
    expect(gh.calls[0].repo).toBe('futin/y');
    expect((await readPull(client, 'futin/y', 12, { token: TOKEN })).data?.row.autoMerge?.method).toBe('rebase');

    const off = await setAutoMerge(client, y12.id, { enable: false }, { token: TOKEN });
    expect(off.error).toBeNull();
    expect(gh.pulls.get('futin/y')?.[0].autoMergeRequest).toBeNull();

    const refused = await setAutoMerge(client, x7.id, { enable: true, method: 'squash' }, { token: TOKEN });
    expect(refused.status).toBe(200);
    expect(refused.error).toBe('Pull request Auto merge is not allowed for this repository');
  });

  it('failNext narrows to one repo on /graphql', async () => {
    const gh = new FakeGithub();
    gh.addPr(FAKE_REPO, { number: 7 });
    gh.addPr('futin/y', { number: 12 });
    gh.failNext = { fragment: '/graphql', status: 502, repo: FAKE_REPO };
    const client = new GithubClient(gh.fetch);
    const y = await readPullList(client, 'futin/y', { token: TOKEN });
    const x = await readPullList(client, FAKE_REPO, { token: TOKEN });
    expect(y.status).toBe(200);
    expect(x.status).toBe(502);
  });
});

describe("the fake's REST PR writes", () => {
  async function put(gh: FakeGithub, path: string, body: unknown): Promise<{ status: number; body: { message?: string } }> {
    const res = await gh.fetch(`${API}${path}`, { method: 'PUT', body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { message?: string } };
  }

  it('merge: 409 on a moved head, 200 and MERGED on the right one, 405 once merged', async () => {
    const gh = new FakeGithub();
    const pr = gh.addPr(FAKE_REPO, { number: 7 });
    expect((await put(gh, '/repos/futin/x/pulls/7/merge', { merge_method: 'squash', sha: 'f'.repeat(40) })).status).toBe(409);
    expect((await put(gh, '/repos/futin/x/pulls/7/merge', { merge_method: 'squash', sha: pr.headRefOid })).status).toBe(200);
    expect(pr.state).toBe('MERGED');
    const again = await put(gh, '/repos/futin/x/pulls/7/merge', { merge_method: 'squash', sha: pr.headRefOid });
    expect(again.status).toBe(405);
  });

  it('merge: a method the repo disallows is a 405', async () => {
    const gh = new FakeGithub();
    const pr = gh.addPr('futin/y', { number: 12 });
    gh.setRepoSettings('futin/y', { squashMergeAllowed: false });
    expect((await put(gh, '/repos/futin/y/pulls/12/merge', { merge_method: 'squash', sha: pr.headRefOid })).status).toBe(405);
    expect(pr.state).toBe('OPEN');
  });

  it('update-branch: 202 moves the head; a stale expected sha or a locked fork is a 422', async () => {
    const gh = new FakeGithub();
    const pr = gh.addPr('futin/y', { number: 12 });
    const fork = gh.addPr('futin/y', { number: 13, isCrossRepository: true, maintainerCanModify: false });
    const before = pr.headRefOid;
    expect((await put(gh, '/repos/futin/y/pulls/12/update-branch', { expected_head_sha: before })).status).toBe(202);
    expect(pr.headRefOid).not.toBe(before);
    expect(pr.headRefOid).toMatch(/^[0-9a-f]{40}$/);
    expect((await put(gh, '/repos/futin/y/pulls/12/update-branch', { expected_head_sha: before })).status).toBe(422);
    expect((await put(gh, '/repos/futin/y/pulls/13/update-branch', { expected_head_sha: fork.headRefOid })).status).toBe(422);
  });

  it('maxConcurrent counts overlapping writes per PR while answers are held', async () => {
    const gh = new FakeGithub();
    const pr = gh.addPr(FAKE_REPO, { number: 7 });
    gh.addPr('futin/y', { number: 12 });
    const release = gh.holdAnswers();
    const a = put(gh, '/repos/futin/x/pulls/7/merge', { merge_method: 'squash', sha: pr.headRefOid });
    const b = put(gh, '/repos/futin/x/pulls/7/merge', { merge_method: 'squash', sha: pr.headRefOid });
    const c = put(gh, '/repos/futin/y/pulls/12/update-branch', {});
    await Promise.resolve();
    expect(gh.calls).toHaveLength(3);
    release();
    const statuses = (await Promise.all([a, b, c])).map((r) => r.status);
    expect(statuses).toEqual([200, 405, 202]);
    expect(gh.maxConcurrent.get('futin/x#7')).toBe(2);
    expect(gh.maxConcurrent.get('futin/y#12')).toBe(1);
  });
});
