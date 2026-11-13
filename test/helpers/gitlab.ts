import type { FetchLike, RawMr } from '../../server/src/gitlab/gitlab.client';

/** One call the fake saw: the URL as dialled and the init it was given, so a test can prove the token went in one header and `redirect` was `manual`. */
export interface GitlabCall {
  url: string;
  init: RequestInit | undefined;
}

/** What a test scripts for one path (a URL path, no query): the first match wins. A `delay` of `Infinity` never resolves. */
export interface Scripted {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Answer as undici's `manual` mode may: status 0, type `opaqueredirect`. */
  opaqueRedirect?: boolean;
  delay?: number;
  throws?: Error;
}

export function rawMr(iid: number, partial: Partial<RawMr> = {}): RawMr {
  return {
    iid,
    title: `MR ${iid}`,
    web_url: `https://www.gitlab.timify.io/ns/repo/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    source_branch: `feature/${iid}`,
    target_branch: 'develop',
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-02T10:00:00.000Z',
    merged_at: null,
    head_pipeline: null,
    ...partial
  };
}

/**
 * An in-memory GitLab, the shape of `FakeJira`: `fetch` records every call and serves `/user`, the MR list per project/state/page and MR detail, and a test
 * scripts a status, `Retry-After`, 3xx, delay or thrown network error for a path in `script`. A real GitLab can schedule none of those failures.
 */
export class FakeGitlab {
  user = { username: 'ada', name: 'Ada Lovelace' };
  /** `projectPath` -> state -> every MR of that state; paged by `per_page` on read. */
  mrs = new Map<string, Map<string, RawMr[]>>();
  /** Keyed by the URL's path, e.g. `/api/v4/user`. */
  script = new Map<string, Scripted>();
  readonly calls: GitlabCall[] = [];

  seed(projectPath: string, state: 'opened' | 'merged' | 'closed', list: RawMr[]): void {
    const byState = this.mrs.get(projectPath) ?? new Map<string, RawMr[]>();
    byState.set(state, list);
    this.mrs.set(projectPath, byState);
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  fetch: FetchLike = async (url, init) => {
    this.calls.push({ url, init });
    const u = new URL(url);
    const scripted = this.script.get(u.pathname);
    if (scripted?.throws) throw scripted.throws;
    if (scripted?.delay !== undefined) await new Promise<void>((resolve) => (scripted.delay === Infinity ? undefined : setTimeout(resolve, scripted.delay)));
    if (scripted?.opaqueRedirect) {
      // `Response` cannot be constructed with status 0 or this type, so the two properties are defined over a plain one.
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, 'status', { value: 0 });
      Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
      return res;
    }
    if (scripted?.status !== undefined) {
      // A 3xx may not carry a body in a `Response` constructor for some statuses; null is what a redirect has anyway.
      const noBody = scripted.status >= 300 && scripted.status < 400;
      if (noBody) return new Response(null, { status: scripted.status, headers: scripted.headers });
      return this.json(scripted.status, scripted.body ?? {}, scripted.headers);
    }

    if (u.pathname === '/api/v4/user') return this.json(200, this.user);
    const list = /^\/api\/v4\/projects\/([^/]+)\/merge_requests$/.exec(u.pathname);
    if (list) {
      const all = this.mrs.get(decodeURIComponent(list[1]))?.get(u.searchParams.get('state') ?? '') ?? [];
      const perPage = Number(u.searchParams.get('per_page') ?? 20);
      const page = Number(u.searchParams.get('page') ?? 1);
      return this.json(200, all.slice((page - 1) * perPage, page * perPage));
    }
    const one = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(u.pathname);
    if (one) {
      const found = [...(this.mrs.get(decodeURIComponent(one[1]))?.values() ?? [])].flat().find((m) => m.iid === Number(one[2]));
      return found ? this.json(200, found) : this.json(404, { message: '404 Not found' });
    }
    return this.json(404, { message: '404 Not found' });
  };
}
