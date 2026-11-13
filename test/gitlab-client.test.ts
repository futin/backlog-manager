import { GITLAB_TIMEOUT_MS, GitlabClient } from '../server/src/gitlab/gitlab.client';
import { FakeGitlab } from './helpers/gitlab';

const SITE = 'www.gitlab.timify.io';
const TOKEN = 'glpat-secret-token';

function client(fake: FakeGitlab): GitlabClient {
  return new GitlabClient(fake.fetch);
}

function noToken(res: { message: string | null }): void {
  expect(res.message ?? '').not.toContain(TOKEN);
}

describe('GitlabClient', () => {
  it('currentUser fetches /user with the token header and redirect manual', async () => {
    const fake = new FakeGitlab();
    const res = await client(fake).currentUser(SITE, TOKEN);
    expect(res).toMatchObject({ status: 200, data: { username: 'ada', name: 'Ada Lovelace' } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe(`https://${SITE}/api/v4/user`);
    expect(new Headers(fake.calls[0].init?.headers).get('PRIVATE-TOKEN')).toBe(TOKEN);
    expect(fake.calls[0].init?.redirect).toBe('manual');
    noToken(res);
  });

  it('listMergeRequests builds the project path and the paging query', async () => {
    const fake = new FakeGitlab();
    const res = await client(fake).listMergeRequests(SITE, TOKEN, 'development/backend/microservice', {
      state: 'merged',
      updatedAfter: '2026-10-13T00:00:00.000Z',
      page: 2
    });
    expect(res.status).toBe(200);
    const u = new URL(fake.calls[0].url);
    expect(u.pathname).toBe('/api/v4/projects/development%2Fbackend%2Fmicroservice/merge_requests');
    expect(u.searchParams.get('state')).toBe('merged');
    expect(u.searchParams.get('updated_after')).toBe('2026-10-13T00:00:00.000Z');
    expect(u.searchParams.get('order_by')).toBe('updated_at');
    expect(u.searchParams.get('sort')).toBe('desc');
    expect(u.searchParams.get('per_page')).toBe('100');
    expect(u.searchParams.get('page')).toBe('2');
    noToken(res);
  });

  it('refuses a 302 and never dials the Location', async () => {
    const fake = new FakeGitlab();
    fake.script.set('/api/v4/user', { status: 302, headers: { location: 'https://evil.example/' } });
    const res = await client(fake).currentUser(SITE, TOKEN);
    expect(res).toMatchObject({ status: 0, data: null, message: 'redirect refused (302)' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe(`https://${SITE}/api/v4/user`);
    noToken(res);
  });

  it('refuses an opaque redirect the same way', async () => {
    const fake = new FakeGitlab();
    fake.script.set('/api/v4/user', { opaqueRedirect: true });
    const res = await client(fake).currentUser(SITE, TOKEN);
    expect(res.status).toBe(0);
    expect(res.message).toMatch(/^redirect refused/);
    expect(fake.calls).toHaveLength(1);
    noToken(res);
  });

  it('reads Retry-After on a 429', async () => {
    const fake = new FakeGitlab();
    fake.script.set('/api/v4/user', { status: 429, headers: { 'retry-after': '30' } });
    const res = await client(fake).currentUser(SITE, TOKEN);
    expect(res).toMatchObject({ status: 429, retryAfter: 30 });
    noToken(res);
  });

  it('carries GitLab\'s own message on a 401', async () => {
    const fake = new FakeGitlab();
    fake.script.set('/api/v4/user', { status: 401, body: { message: '401 Unauthorized' } });
    const res = await client(fake).currentUser(SITE, TOKEN);
    expect(res).toMatchObject({ status: 401, data: null, message: '401 Unauthorized' });
    noToken(res);
  });

  it('turns a thrown network error into status 0', async () => {
    const fake = new FakeGitlab();
    fake.script.set('/api/v4/user', { throws: new TypeError('fetch failed') });
    const res = await client(fake).currentUser(SITE, TOKEN);
    expect(res).toMatchObject({ status: 0, message: 'fetch failed' });
    noToken(res);
  });

  it('times out a call that never answers', async () => {
    jest.useFakeTimers();
    try {
      const fake = new FakeGitlab();
      fake.script.set('/api/v4/user', { delay: Infinity });
      const pending = client(fake).currentUser(SITE, TOKEN);
      await jest.advanceTimersByTimeAsync(GITLAB_TIMEOUT_MS);
      const res = await pending;
      expect(res).toMatchObject({ status: 0, message: 'timed out after 10000 ms' });
      noToken(res);
    } finally {
      jest.useRealTimers();
    }
  });
});
