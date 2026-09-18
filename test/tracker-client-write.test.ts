import { API, GithubClient } from '../server/src/tracker/github.client';

/**
 * The nine write methods (task-46, spec §6.2), against a fake `fetch`.
 *
 * Each case asserts the METHOD and the PATH, because those two are what the
 * client alone decides — everything past them is the writer's judgement and is
 * tested where that judgement is made. The point of driving them here rather
 * than only through the routes is the same point `github.client.ts`'s header
 * makes about the read side: the branches that matter are the ones a live
 * network can never be asked to schedule.
 */

const TOKEN = 'ghp_fake';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Records every call and answers `status`/`payload`. Not a Response subclass:
 *  the client reads `.status`, `.headers`, and `.text()`, and a real `Response`
 *  refuses a body on a 204 — which is exactly one of the statuses under test. */
function fake(status = 200, payload: unknown = {}): { client: GithubClient; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
    });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      text: async () => (payload === undefined ? '' : JSON.stringify(payload))
    } as unknown as Response;
  };
  return { client: new GithubClient(impl as unknown as typeof fetch), calls };
}

describe('the write methods', () => {
  it('creates an issue', async () => {
    const { client, calls } = fake(201, { number: 77 });
    const res = await client.createIssue('futin/x', { title: 't', body: 'b', labels: ['type:bug'] }, { token: TOKEN });
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ number: 77 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues`);
    expect(calls[0].body).toEqual({ title: 't', body: 'b', labels: ['type:bug'] });
    expect(calls[0].headers['content-type']).toBe('application/json');
  });

  it('patches an issue', async () => {
    const { client, calls } = fake(200, { number: 31 });
    await client.updateIssue('futin/x', 31, { state: 'closed', state_reason: 'completed' }, { token: TOKEN });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/31`);
    expect(calls[0].body).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('reads one issue', async () => {
    const { client, calls } = fake(200, { number: 31, updated_at: '2026-09-18T10:00:00Z' });
    const res = await client.issue('futin/x', 31, { token: TOKEN });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/31`);
    expect(calls[0].body).toBeUndefined();
    expect(res.data).toEqual({ number: 31, updated_at: '2026-09-18T10:00:00Z' });
  });

  it('reads one issue-s comments, a hundred at a time', async () => {
    const { client, calls } = fake(200, []);
    await client.issueComments('futin/x', 31, { token: TOKEN });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/31/comments?per_page=100`);
  });

  it('creates a comment', async () => {
    const { client, calls } = fake(201, { id: 100 });
    const res = await client.createComment('futin/x', 31, 'hello', { token: TOKEN });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/31/comments`);
    expect(calls[0].body).toEqual({ body: 'hello' });
    expect(res.data).toEqual({ id: 100 });
  });

  /* The comment endpoint is repo-scoped and takes a COMMENT id — the path
     `/issues/comments/{id}` carries no issue number at all, which reads like a
     mistake and is GitHub's actual shape. */
  it('edits a comment by comment id, not issue number', async () => {
    const { client, calls } = fake(200, { id: 100 });
    await client.updateComment('futin/x', 100, 'edited', { token: TOKEN });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/comments/100`);
    expect(calls[0].body).toEqual({ body: 'edited' });
  });

  it('deletes a comment and reads a 204 with no body', async () => {
    const { client, calls } = fake(204, undefined);
    const res = await client.deleteComment('futin/x', 101, { token: TOKEN });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/comments/101`);
    expect(res.status).toBe(204);
    expect(res.error).toBeNull();
  });

  it('adds labels additively', async () => {
    const { client, calls } = fake(200, []);
    await client.addLabels('futin/x', 31, ['in-progress'], { token: TOKEN });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/31/labels`);
    expect(calls[0].body).toEqual({ labels: ['in-progress'] });
  });

  /* URL-encoded because a label name legitimately carries `:` and spaces, and
     this one goes in a path segment. */
  it('removes one label, url-encoding its name', async () => {
    const { client, calls } = fake(200, []);
    await client.removeLabel('futin/x', 31, 'kind:debt', { token: TOKEN });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`${API}/repos/futin/x/issues/31/labels/kind%3Adebt`);
  });

  /* The 404 is handed back honestly. Treating "the label was not there" as a
     success is the WRITER's judgement, asserted where that judgement is made
     (the release cases) and deliberately not baked in here. */
  it('reports a removeLabel 404 as a 404', async () => {
    const { client } = fake(404, { message: 'Label does not exist' });
    const res = await client.removeLabel('futin/x', 31, 'in-progress', { token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.error).toBe('Label does not exist');
  });
});

/**
 * The repo guard. A repo string reaches this process from a marker file
 * somebody committed and, on these routes, through a `project` a caller named —
 * so the check is here, in the one place it cannot be forgotten, and it answers
 * a VALUE rather than throwing, because rule 3 of this file has no exceptions.
 */
describe('a malformed repo', () => {
  for (const bad of ['futin', 'futin/x/y', '../../etc', 'futin/x?a=b']) {
    it(`never reaches fetch for ${JSON.stringify(bad)}`, async () => {
      const { client, calls } = fake(201, { number: 1 });
      const res = await client.createIssue(bad, { title: 't', body: 'b', labels: [] }, { token: TOKEN });
      expect(calls).toEqual([]);
      expect(res.status).toBe(0);
      expect(res.error).toContain('owner/name');
    });
  }

  it('guards every one of the nine, not only create', async () => {
    const { client, calls } = fake(200, {});
    const results = await Promise.all([
      client.createIssue('nope', { title: 't', body: 'b', labels: [] }, { token: TOKEN }),
      client.updateIssue('nope', 1, { body: 'x' }, { token: TOKEN }),
      client.issue('nope', 1, { token: TOKEN }),
      client.issueComments('nope', 1, { token: TOKEN }),
      client.createComment('nope', 1, 'x', { token: TOKEN }),
      client.updateComment('nope', 1, 'x', { token: TOKEN }),
      client.deleteComment('nope', 1, { token: TOKEN }),
      client.addLabels('nope', 1, ['a'], { token: TOKEN }),
      client.removeLabel('nope', 1, 'a', { token: TOKEN })
    ]);
    expect(results.map((r) => r.status)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(calls).toEqual([]);
  });
});
