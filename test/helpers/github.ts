import { renderClaim } from '../../server/src/tracker/claim';
import { TRACKER_LABELS } from '../../server/src/tracker/labels';
import type { ClaimRecord } from '../../shared/types';

/**
 * github.ts — an in-memory GitHub over the dozen endpoints this app touches
 * (task-46).
 *
 * ## Why a whole little server rather than a stub per case
 *
 * The claim protocol is a SEQUENCE — list, post, settle, list, then win or
 * delete — and its interesting cases are all about what the second list
 * contains relative to the first. A per-call stub can express "answer this
 * body" but not "a comment posted between the two lists is visible in the
 * second", which is the case the whole design exists for. Keeping issues and
 * comments in maps and minting comment ids from a counter makes the lag case,
 * the two-claimant case and the stale-retirement case one line of setup each.
 *
 * It is faked at `fetch`, INSIDE a real `GithubClient`, exactly as
 * `test/tracker-items.test.ts` fakes the read side: the client's own three
 * rules (one host, rate headers recorded, nothing thrown on a status) stay
 * under test rather than being stubbed away.
 *
 * Shared by `tracker-write.test.ts` (the routes and the protocol) and
 * `tracker-dispatch.test.ts` (the dispatch lift) because both need a repo that
 * answers — and two copies of a fake this size is two chances for the two
 * suites to disagree about what GitHub does.
 */

export const FAKE_REPO = 'futin/x';

export interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  /** The conditional-request header, when the caller sent one (bug-55). */
  ifNoneMatch?: string;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  labels: { name: string }[];
  assignees: { login: string }[];
}

export interface FakeComment {
  id: number;
  issue_url: string;
  body: string;
  html_url: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

/**
 * An in-memory GitHub over the dozen endpoints this app touches.
 *
 * `hideFromFirstList` is the one deliberate unfaithfulness, and it models
 * something real: GitHub's comment listing is eventually consistent, so a
 * comment can be absent from one list and present in the next. Naming the
 * comment ids to hide is how the "the loser's list may lag" case is written at
 * all.
 */
export class FakeGithub {
  readonly calls: Call[] = [];
  readonly issues = new Map<number, FakeIssue>();
  readonly comments = new Map<number, FakeComment>();

  /** Comment ids this fake will omit from the NEXT per-issue list only. */
  hideFromFirstList = new Set<number>();

  /**
   * Comment ids this fake omits from EVERY per-issue list, while the comment
   * itself still exists (bug-55). The standing form of `hideFromFirstList`, for
   * the poller's reconcile rather than the protocol's settle window: it is how a
   * case says "GitHub's listing has not caught up with a comment that was just
   * posted" for as many ticks as it likes.
   */
  hideFromIssueLists = new Set<number>();

  /** The mirror image: ids omitted from the REPOSITORY-WIDE comment read only
   *  (bug-55), so a case can hand the poller a comment through its per-issue
   *  reconcile alone and ask what that did to the repo-wide high-water mark. */
  hideFromRepoStream = new Set<number>();

  /**
   * One answer that pre-empts the router for a matching request, then removes
   * itself (bug-55). The fake otherwise only ever answers the way a healthy
   * GitHub does; this is how a case makes ONE request fail — a rate limit on
   * the poller's per-issue read, say — without teaching the router a failure
   * mode per endpoint. `headers` are sent verbatim, so an
   * `x-ratelimit-remaining: 0` reaches the client's rate bookkeeping.
   */
  failNext: { fragment: string; status: number; headers?: Record<string, string> } | null = null;

  /** Rows per page. GitHub's own maximum is 100; a case that wants to prove a
   *  caller follows `Link` lowers this to 1. */
  pageSize = 100;
  private listCount = 0;

  private nextIssue = 77;
  private nextComment = 100;

  /**
   * Move one issue's `updated_at` the way GitHub does for a write that is not a
   * PATCH to the issue itself (bug #220): a label added or removed, a comment
   * posted, a comment edited. None of those endpoints answers with the issue,
   * so a caller that only absorbs what it is handed back never hears about the
   * new stamp — and a fake that did not bump it modelled a GitHub where the
   * claim protocol's own bookkeeping left the stamp alone, which is how
   * `patchBody` refusing a `start`-then-`body` stayed green.
   *
   * Strictly later than the old stamp, not just `new Date()`: two writes inside
   * one millisecond would otherwise tie, and a tie is exactly the "nothing
   * moved" reading this exists to rule out.
   */
  private touch(number: number): void {
    const issue = this.issues.get(number);
    if (issue === undefined) return;
    const next = Math.max(Date.now(), Date.parse(issue.updated_at) + 1);
    issue.updated_at = new Date(next).toISOString();
  }

  issue(over: Partial<FakeIssue> = {}): FakeIssue {
    const number = over.number ?? 31;
    const issue: FakeIssue = {
      number,
      title: 'the board lies',
      body: '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n',
      html_url: `https://github.com/${FAKE_REPO}/issues/${number}`,
      state: 'open',
      state_reason: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-02T10:00:00Z',
      labels: [{ name: 'type:bug' }],
      assignees: [],
      ...over
    };
    this.issues.set(number, issue);
    return issue;
  }

  /**
   * Seed a claim comment straight into the fake, as another session's.
   *
   * An explicitly given `id` pushes the counter past it, so a comment the app
   * posts later can never be minted with the SAME id and silently overwrite the
   * seeded one — which is exactly how "the loser deletes its own comment"
   * quietly became "the loser overwrote the winner's" the first time this file
   * was run.
   */
  claim(record: ClaimRecord, issueNumber = 31, id = this.nextComment++): FakeComment {
    this.nextComment = Math.max(this.nextComment, id + 1);
    const comment: FakeComment = {
      id,
      issue_url: `https://api.github.com/repos/${FAKE_REPO}/issues/${issueNumber}`,
      body: renderClaim(record),
      html_url: `https://github.com/${FAKE_REPO}/issues/${issueNumber}#issuecomment-${id}`,
      user: { login: 'futin' },
      created_at: record.at,
      updated_at: record.heartbeat
    };
    this.comments.set(id, comment);
    return comment;
  }

  /** Every call the app made whose URL contains `fragment`. */
  matching(fragment: string, method?: string): Call[] {
    return this.calls.filter((c) => c.url.includes(fragment) && (method === undefined || c.method === method));
  }

  fetch: typeof fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({ method, url, body, ifNoneMatch: headers['if-none-match'] });
    if (this.failNext !== null && url.includes(this.failNext.fragment)) {
      const failure = this.failNext;
      this.failNext = null;
      return new Response(JSON.stringify({ message: 'failed on purpose' }), { status: failure.status, headers: failure.headers });
    }
    const { status, payload, next, etag } = this.route(method, url, body, headers['if-none-match']);
    const out: Record<string, string> = {};
    // `Link` is how this API paginates, and the client reads `rel="next"` off
    // it — so a fake that never sends one can never exercise a caller's page
    // loop. Task-46's review caught a poller that dropped every comment past
    // the first page precisely because nothing here ever asked for a second.
    if (next !== undefined) out.link = `<${next}>; rel="next"`;
    if (etag !== undefined) out.etag = etag;
    return new Response(status === 304 || payload === undefined ? null : JSON.stringify(payload), { status, headers: out });
  }) as unknown as typeof fetch;

  /**
   * `since` and one page of rows, the way GitHub answers a list.
   *
   * Both halves are faithfulness this fake lacked until task-46's fix pass, and
   * both were load-bearing: it returned every row whatever `since` asked for and
   * never paginated, so a caller sending a WRONG `since` — or reading only the
   * first page — looked identical to a correct one. `pageSize` is large enough
   * that no existing case pages, and a case that wants to prove a page loop
   * lowers it.
   */
  private page<T extends { updated_at: string }>(rows: T[], url: string): { status: number; payload: unknown; next?: string } {
    const since = new URL(url).searchParams.get('since');
    const cursor = Number(new URL(url).searchParams.get('bm_page') ?? '0');
    // Ascending by `updated_at`, which is what `sort=updated&direction=asc`
    // asks for and what makes a high-water mark meaningful at all.
    const matching = rows
      .filter((r) => since === null || r.updated_at >= since)
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0));
    const slice = matching.slice(cursor, cursor + this.pageSize);
    const more = cursor + this.pageSize < matching.length;
    const nextUrl = `${url.split('?')[0]}?bm_page=${cursor + this.pageSize}${since === null ? '' : `&since=${encodeURIComponent(since)}`}`;
    return { status: 200, payload: slice, next: more ? nextUrl : undefined };
  }

  private route(
    method: string,
    url: string,
    body: Record<string, unknown> | undefined,
    ifNoneMatch?: string
  ): { status: number; payload?: unknown; next?: string; etag?: string } {
    const path = url.replace('https://api.github.com', '').split('?')[0];

    if (path === '/user') return { status: 200, payload: { login: 'futin' } };
    if (path === `/repos/${FAKE_REPO}/labels`) return { status: 200, payload: TRACKER_LABELS.map((l) => ({ name: l.name })) };

    // The repository-wide comment read the poller makes.
    if (path === `/repos/${FAKE_REPO}/issues/comments`) return this.page([...this.comments.values()].filter((c) => !this.hideFromRepoStream.has(c.id)), url);

    if (path === `/repos/${FAKE_REPO}/issues`) {
      if (method === 'GET') return this.page([...this.issues.values()], url);
      const created = this.issue({
        number: this.nextIssue++,
        title: String(body?.title ?? ''),
        body: String(body?.body ?? ''),
        labels: ((body?.labels as string[]) ?? []).map((name) => ({ name }))
      });
      return { status: 201, payload: created };
    }

    const issueComments = /^\/repos\/futin\/x\/issues\/(\d+)\/comments$/.exec(path);
    if (issueComments !== null) {
      const number = Number(issueComments[1]);
      if (method === 'GET') {
        // `bm_page` only on a follow-up page: the settle window's "first list"
        // is the first REQUEST for this issue, not each page of it.
        const paging = url.includes('bm_page=');
        if (!paging) this.listCount++;
        const hide = this.listCount === 1 && !paging ? this.hideFromFirstList : new Set<number>();
        const rows = [...this.comments.values()].filter(
          (c) => c.issue_url.endsWith(`/issues/${number}`) && !hide.has(c.id) && !this.hideFromIssueLists.has(c.id)
        );
        // An ETag over the whole list, the way GitHub's is a digest of the
        // response (bug-55): the poller's per-issue reconcile sends it back as
        // `if-none-match`, and a `304` must mean "this list has not changed" —
        // ids AND edits, so an in-place claim rewrite is a new tag. Only on this
        // endpoint: the protocol never sends one here, and giving the
        // repo-wide reads a tag would move every other suite's request counts.
        const etag = `"${rows.map((c) => `${c.id}@${c.updated_at}`).sort().join(',')}"`;
        if (!paging && ifNoneMatch === etag) return { status: 304, etag };
        return { ...this.page(rows, url), etag };
      }
      const id = this.nextComment++;
      this.touch(number);
      this.comments.set(id, {
        id,
        issue_url: `https://api.github.com/repos/${FAKE_REPO}/issues/${number}`,
        body: String(body?.body ?? ''),
        html_url: `https://github.com/${FAKE_REPO}/issues/${number}#issuecomment-${id}`,
        user: { login: 'futin' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      return { status: 201, payload: this.comments.get(id) };
    }

    const oneComment = /^\/repos\/futin\/x\/issues\/comments\/(\d+)$/.exec(path);
    if (oneComment !== null) {
      const id = Number(oneComment[1]);
      const existing = this.comments.get(id);
      if (existing === undefined) return { status: 404, payload: { message: 'Not Found' } };
      if (method === 'DELETE') {
        this.comments.delete(id);
        return { status: 204 };
      }
      const updated = { ...existing, body: String(body?.body ?? ''), updated_at: new Date().toISOString() };
      this.comments.set(id, updated);
      this.touch(Number(/\/issues\/(\d+)$/.exec(existing.issue_url)?.[1]));
      return { status: 200, payload: updated };
    }

    const labels = /^\/repos\/futin\/x\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(path);
    if (labels !== null) {
      const issue = this.issues.get(Number(labels[1]));
      if (issue === undefined) return { status: 404, payload: { message: 'Not Found' } };
      if (method === 'POST') {
        for (const name of (body?.labels as string[]) ?? []) {
          if (!issue.labels.some((l) => l.name === name)) issue.labels.push({ name });
        }
        this.touch(issue.number);
        return { status: 200, payload: issue.labels };
      }
      const name = decodeURIComponent(labels[2] ?? '');
      const before = issue.labels.length;
      issue.labels = issue.labels.filter((l) => l.name !== name);
      if (before !== issue.labels.length) this.touch(issue.number);
      return before === issue.labels.length ? { status: 404, payload: { message: 'Label does not exist' } } : { status: 200, payload: issue.labels };
    }

    const oneIssue = /^\/repos\/futin\/x\/issues\/(\d+)$/.exec(path);
    if (oneIssue !== null) {
      const issue = this.issues.get(Number(oneIssue[1]));
      if (issue === undefined) return { status: 404, payload: { message: 'Not Found' } };
      if (method === 'GET') return { status: 200, payload: issue };
      const patched: FakeIssue = {
        ...issue,
        ...(typeof body?.state === 'string' ? { state: body.state } : {}),
        ...(body?.state_reason !== undefined ? { state_reason: body.state_reason as string | null } : {}),
        ...(typeof body?.body === 'string' ? { body: body.body } : {}),
        ...(Array.isArray(body?.assignees) ? { assignees: (body.assignees as string[]).map((login) => ({ login })) } : {}),
        updated_at: new Date().toISOString()
      };
      this.issues.set(patched.number, patched);
      return { status: 200, payload: patched };
    }

    return { status: 404, payload: { message: 'Not Found' } };
  }
}

