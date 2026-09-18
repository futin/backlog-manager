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
  private listCount = 0;

  private nextIssue = 77;
  private nextComment = 100;

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
    this.calls.push({ method, url, body });
    const { status, payload } = this.route(method, url, body);
    return new Response(payload === undefined ? null : JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;

  private route(method: string, url: string, body: Record<string, unknown> | undefined): { status: number; payload?: unknown } {
    const path = url.replace('https://api.github.com', '').split('?')[0];

    if (path === '/user') return { status: 200, payload: { login: 'futin' } };
    if (path === `/repos/${FAKE_REPO}/labels`) return { status: 200, payload: TRACKER_LABELS.map((l) => ({ name: l.name })) };

    // The repository-wide comment read the poller makes.
    if (path === `/repos/${FAKE_REPO}/issues/comments`) return { status: 200, payload: [...this.comments.values()] };

    if (path === `/repos/${FAKE_REPO}/issues`) {
      if (method === 'GET') return { status: 200, payload: [...this.issues.values()] };
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
        this.listCount++;
        const hide = this.listCount === 1 ? this.hideFromFirstList : new Set<number>();
        const rows = [...this.comments.values()].filter((c) => c.issue_url.endsWith(`/issues/${number}`) && !hide.has(c.id));
        return { status: 200, payload: rows };
      }
      const id = this.nextComment++;
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
        return { status: 200, payload: issue.labels };
      }
      const name = decodeURIComponent(labels[2] ?? '');
      const before = issue.labels.length;
      issue.labels = issue.labels.filter((l) => l.name !== name);
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

