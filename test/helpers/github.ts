import { createHash } from 'node:crypto';
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
  /** A `/graphql` call's operation name (`PullRequests`, `PullRequest`, `EnableAutoMerge`, `DisableAutoMerge`), read off the query text — every call
   *  shares one URL, so this is how a case counts list reads apart from single reads. */
  operation?: string;
  /** The repo a `/graphql` call is about: its `owner`/`name` variables, or — for a mutation, which names only a node id — the repo of the PR that id is. */
  repo?: string;
}

/**
 * One fake pull request, stored under GraphQL's own field names so rendering a node is a spread, not a mapping — the mapping under test is `toRow`'s, and a
 * second one here could only hide its mistakes. `rollup` is the head commit's `statusCheckRollup.state`, `null` for a commit with no checks.
 */
export interface FakePr {
  /** The GraphQL node id. Built from the repo and number so two repos' PRs can never share one. */
  id: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  viewerCanUpdateBranch: boolean;
  autoMergeRequest: { mergeMethod: string; enabledAt: string | null } | null;
  rollup: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

/** A repo's merge settings, as the list query reads them. Every one `true` until a case says otherwise (`setRepoSettings`). */
export interface FakeRepoSettings {
  squashMergeAllowed: boolean;
  mergeCommitAllowed: boolean;
  rebaseMergeAllowed: boolean;
  autoMergeAllowed: boolean;
}

/** `PullRequestMergeMethod` → the REST `merge_method` word and the setting that allows it. */
const METHOD_SETTING: Record<string, keyof FakeRepoSettings> = {
  squash: 'squashMergeAllowed',
  merge: 'mergeCommitAllowed',
  rebase: 'rebaseMergeAllowed'
};

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
  /** The author's association (#341). Absent unless a case sets it, which `trustedAssociation` reads as trusted — so every existing fixture stays vetted. */
  author_association?: string;
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
   * `x-ratelimit-remaining: 0` reaches the client's rate bookkeeping. `message` replaces the body's sentence, because a secondary limit is told
   * apart from the hourly one by that sentence alone (`GithubClient.request`), never by a header. `method`, when given, narrows the match to that verb: a
   * fresh `GET` of an issue and the `PATCH` that closes it share one URL (#348), and a case about the close must not fail the read in front of it.
   */
  failNext: {
    fragment: string;
    /** The HTTP status. Ignored when `graphqlError` is set — that answer is always GraphQL's `200` with `errors`. */
    status?: number;
    method?: string;
    headers?: Record<string, string>;
    message?: string;
    /** A GraphQL failure: a `200` whose body is `{ data: null, errors: [{ type, message }] }`. A `RATE_LIMITED` one also sends `x-ratelimit-remaining: 0`
     *  and a reset an hour out unless `headers` says otherwise, because that is how GitHub reports it and what `failureVerdict` reads. */
    graphqlError?: { type: string; message: string };
    /** Narrows the match to a call about this repo — every `/graphql` call shares one URL, so the fragment alone cannot fail `futin/x`'s read and not
     *  `futin/y`'s. Matched against `Call.repo` for `/graphql` and against the URL otherwise. */
    repo?: string;
    /** Narrows a `/graphql` match to one operation name. */
    operation?: string;
  } | null = null;

  /** Open and closed PRs per repo (`addPr`). */
  readonly pulls = new Map<string, FakePr[]>();

  /** Per-repo merge settings; a repo absent here allows everything. */
  readonly repoSettings = new Map<string, FakeRepoSettings>();

  /**
   * The most writes ever in flight at once per `<repo>#<number>` — the PR writes' serialisation key — counting both REST writes and both mutations. Only
   * measurable while answers are held (`holdAnswers`): an unheld answer is routed synchronously, so nothing overlaps it.
   */
  readonly maxConcurrent = new Map<string, number>();
  private inFlight = new Map<string, number>();

  /** While set, every `/graphql` call and every PR write waits for it before being answered — or, with `gateOperation`, only that one operation. */
  private gate: Promise<void> | null = null;
  private gateOperation: string | undefined;
  private nextPrNumber = 7;
  private prSeq = 0;
  private shaSeq = 0;

  /**
   * Repos besides `FAKE_REPO` this fake answers for (`addRepo`). Every other route in `route` is pinned to `FAKE_REPO`; a second registered repo gets the
   * poller's three REST reads — `labels`, `issues`, `issues/comments` — answered `200` with an empty list, and a label create `201`. A repo not added here
   * still 404s, which is what "the token cannot see it" looks like.
   */
  readonly extraRepos = new Set<string>();

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

  /** Register a second repo: its poller reads answer empty and healthy. `FAKE_REPO` keeps its issues; anything not added or `FAKE_REPO` still 404s. */
  addRepo(repo: string): void {
    this.extraRepos.add(repo);
  }

  /** `FAKE_REPO` or a repo `addRepo` registered — the repos this fake answers PR calls for; any other is GitHub's "cannot see it". */
  private knows(repo: string): boolean {
    return repo === FAKE_REPO || this.extraRepos.has(repo);
  }

  /** A fresh 40-hex SHA, distinct per call — a head SHA, or the one an update-branch moves a head to. */
  private sha(seed: string): string {
    return createHash('sha1').update(`${seed}#${this.shaSeq++}`).digest('hex');
  }

  /**
   * Seed one PR. Every default discriminates — the number counts up from 7, and the title, head branch, head SHA, author and `updatedAt` are all derived
   * from the repo and number — so a mapping that swaps two PRs' fields, or two repos' PRs, cannot pass by accident. A repo other than `FAKE_REPO` is
   * registered (`addRepo`) on first use. `updatedAt` moves one minute later per seeded PR, so seed order is update order unless a case says otherwise.
   */
  addPr(repo: string, over: Partial<FakePr> = {}): FakePr {
    if (repo !== FAKE_REPO) this.addRepo(repo);
    const number = over.number ?? this.nextPrNumber++;
    this.nextPrNumber = Math.max(this.nextPrNumber, number + 1);
    const pr: FakePr = {
      id: `PR_${repo.replace('/', '_')}_${number}`,
      number,
      title: `${repo} change ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      author: `author-${number}`,
      isDraft: false,
      headRefName: `feature/${repo.split('/')[1]}-${number}`,
      headRefOid: this.sha(`${repo}#${number}`),
      baseRefName: 'main',
      isCrossRepository: false,
      maintainerCanModify: true,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 10, this.prSeq++)).toISOString(),
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      viewerCanUpdateBranch: false,
      autoMergeRequest: null,
      rollup: 'SUCCESS',
      state: 'OPEN',
      ...over
    };
    const list = (this.pulls.get(repo) ?? []).filter((p) => p.number !== number);
    list.push(pr);
    this.pulls.set(repo, list);
    return pr;
  }

  /** Change some of a repo's merge settings; the rest keep their value (all `true` to begin with). */
  setRepoSettings(repo: string, over: Partial<FakeRepoSettings>): void {
    this.repoSettings.set(repo, { ...this.settingsOf(repo), ...over });
  }

  private settingsOf(repo: string): FakeRepoSettings {
    return this.repoSettings.get(repo) ?? { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true };
  }

  /** Hold every `/graphql` answer and every PR write until the returned function is called — how a case starts several requests and asks what overlapped
   *  (`maxConcurrent`) or which ones were made at all before any answered. `operation` narrows the hold to that one GraphQL operation, so a case can keep
   *  a list read (`PullRequests`) out while a write and its re-read go through — the race between a read in flight and a write's splice. */
  holdAnswers(operation?: string): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    this.gateOperation = operation;
    return () => {
      this.gate = null;
      this.gateOperation = undefined;
      release();
    };
  }

  /** The `/graphql` calls, optionally narrowed to one operation and one repo. */
  graphqlCalls(operation?: string, repo?: string): Call[] {
    return this.calls.filter((c) => c.operation !== undefined && (operation === undefined || c.operation === operation) && (repo === undefined || c.repo === repo));
  }

  private prById(id: unknown): { repo: string; pr: FakePr } | null {
    for (const [repo, list] of this.pulls) {
      const pr = list.find((p) => p.id === id);
      if (pr !== undefined) return { repo, pr };
    }
    return null;
  }

  private prOf(repo: string, number: number): FakePr | undefined {
    return this.pulls.get(repo)?.find((p) => p.number === number);
  }

  /** A PR as the queries select it — GraphQL's own field names, plus the nesting `author` and `commits` have on the wire. */
  private node(pr: FakePr, withIdentity: boolean): Record<string, unknown> {
    const { id, state, rollup, author, ...fields } = pr;
    return {
      ...(withIdentity ? { id, state } : {}),
      ...fields,
      author: author === null ? null : { login: author },
      commits: { nodes: [{ commit: { statusCheckRollup: rollup === null ? null : { state: rollup } } }] }
    };
  }

  /** The operation name and subject repo of a `/graphql` body; `undefined` for any other call. */
  private graphqlTarget(url: string, body: Record<string, unknown> | undefined): { operation: string; repo?: string } | undefined {
    if (!url.endsWith('/graphql')) return undefined;
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(String(body?.query ?? ''))?.[1] ?? 'anonymous';
    const vars = (body?.variables ?? {}) as Record<string, unknown>;
    if (typeof vars.owner === 'string' && typeof vars.name === 'string') return { operation, repo: `${vars.owner}/${vars.name}` };
    return { operation, repo: this.prById(vars.id)?.repo };
  }

  /** The `<repo>#<number>` a PR WRITE is about, or `null` for a read or any other call. */
  private writeKey(method: string, url: string, target: { operation: string; repo?: string } | undefined, body: Record<string, unknown> | undefined): string | null {
    const rest = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/(?:merge|update-branch)$/.exec(url.split('?')[0]);
    if (rest !== null && method === 'PUT') return `${rest[1]}#${rest[2]}`;
    if (target !== undefined && (target.operation === 'EnableAutoMerge' || target.operation === 'DisableAutoMerge')) {
      const found = this.prById((body?.variables as Record<string, unknown> | undefined)?.id);
      return found === null ? null : `${found.repo}#${found.pr.number}`;
    }
    return null;
  }

  /**
   * The empty-and-healthy answers for an added repo — a table of path suffix to answer, so a later task adds a route (the PR reads and writes) by adding a row
   * here rather than another branch in `route`. `null` when `path` is not an added repo's, so `route` falls through to its `FAKE_REPO` table.
   */
  private extraRepoRoute(method: string, path: string): { status: number; payload?: unknown } | null {
    const match = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(path);
    if (match === null || !this.extraRepos.has(match[1])) return null;
    const answers: Record<string, { status: number; payload?: unknown }> = {
      labels: method === 'POST' ? { status: 201, payload: {} } : { status: 200, payload: [] },
      issues: { status: 200, payload: [] },
      'issues/comments': { status: 200, payload: [] }
    };
    return answers[match[2]] ?? { status: 404, payload: { message: 'Not Found' } };
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
    const target = this.graphqlTarget(url, body);
    this.calls.push({ method, url, body, ifNoneMatch: headers['if-none-match'], ...(target === undefined ? {} : { operation: target.operation, repo: target.repo }) });

    // The PR surface may be held (`holdAnswers`); a write is counted in flight for the whole wait, which is what makes overlap measurable.
    const key = this.writeKey(method, url, target, body);
    if (key !== null) {
      const now = (this.inFlight.get(key) ?? 0) + 1;
      this.inFlight.set(key, now);
      this.maxConcurrent.set(key, Math.max(this.maxConcurrent.get(key) ?? 0, now));
    }
    try {
      // A narrowed hold answers FIRST and delivers late: the answer is GitHub's state when the request arrived, which is what a read in flight while a
      // write lands really carries back. The broad hold answers after the wait, as it always has — its cases ask what overlapped, not what was seen.
      if (this.gate !== null && this.gateOperation !== undefined && target?.operation === this.gateOperation) {
        const gate = this.gate;
        const early = this.answer(method, url, body, headers, target);
        await gate;
        return early;
      }
      if (this.gate !== null && this.gateOperation === undefined && (target !== undefined || /\/pulls\//.test(url))) await this.gate;
      return this.answer(method, url, body, headers, target);
    } finally {
      if (key !== null) this.inFlight.set(key, (this.inFlight.get(key) ?? 1) - 1);
    }
  }) as unknown as typeof fetch;

  private answer(
    method: string,
    url: string,
    body: Record<string, unknown> | undefined,
    headers: Record<string, string>,
    target: { operation: string; repo?: string } | undefined
  ): Response {
    const f = this.failNext;
    if (
      f !== null &&
      url.includes(f.fragment) &&
      (f.method === undefined || f.method === method) &&
      (f.operation === undefined || f.operation === target?.operation) &&
      (f.repo === undefined || (target !== undefined ? target.repo === f.repo : url.includes(`/repos/${f.repo}/`)))
    ) {
      this.failNext = null;
      if (f.graphqlError !== undefined) {
        const limited: Record<string, string> =
          f.graphqlError.type === 'RATE_LIMITED' ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } : {};
        return new Response(JSON.stringify({ data: null, errors: [f.graphqlError] }), { status: 200, headers: { ...limited, ...f.headers } });
      }
      return new Response(JSON.stringify({ message: f.message ?? 'failed on purpose' }), { status: f.status ?? 500, headers: f.headers });
    }
    const routed: { status: number; payload?: unknown; next?: string; etag?: string } =
      target !== undefined ? this.graphqlRoute(target, body) : this.route(method, url, body, headers['if-none-match']);
    const { status, payload, next, etag } = routed;
    const out: Record<string, string> = {};
    // `Link` is how this API paginates, and the client reads `rel="next"` off
    // it — so a fake that never sends one can never exercise a caller's page
    // loop. Task-46's review caught a poller that dropped every comment past
    // the first page precisely because nothing here ever asked for a second.
    if (next !== undefined) out.link = `<${next}>; rel="next"`;
    if (etag !== undefined) out.etag = etag;
    return new Response(status === 304 || payload === undefined ? null : JSON.stringify(payload), { status, headers: out });
  }

  /**
   * The four operations `pulls.query.ts` sends, told apart by operation name. Failures are GitHub's shape: a `200` whose `errors` carry a `type`
   * (`NOT_FOUND` for a repo or PR it cannot see, `UNPROCESSABLE` for a mutation refused on its merits) and whose `data` holds `null` where the answer
   * would have been.
   */
  private graphqlRoute(target: { operation: string; repo?: string }, body: Record<string, unknown> | undefined): { status: number; payload: unknown } {
    const vars = (body?.variables ?? {}) as Record<string, unknown>;
    const fail = (data: unknown, type: string, message: string) => ({ status: 200, payload: { data, errors: [{ type, message }] } });

    if (target.operation === 'PullRequests' || target.operation === 'PullRequest') {
      const repo = target.repo ?? '';
      if (!this.knows(repo)) return fail({ repository: null }, 'NOT_FOUND', `Could not resolve to a Repository with the name '${repo}'.`);
      const all = this.pulls.get(repo) ?? [];
      if (target.operation === 'PullRequest') {
        const pr = all.find((p) => p.number === vars.number);
        if (pr === undefined) return fail({ repository: { pullRequest: null } }, 'NOT_FOUND', `Could not resolve to a PullRequest with the number of ${String(vars.number)}.`);
        return { status: 200, payload: { data: { repository: { pullRequest: this.node(pr, true) } } } };
      }
      // `states: OPEN`, `orderBy: UPDATED_AT DESC`, `first: 100` — what the list query asks for.
      const open = all.filter((p) => p.state === 'OPEN').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      return {
        status: 200,
        payload: {
          data: {
            repository: { ...this.settingsOf(repo), pullRequests: { totalCount: open.length, nodes: open.slice(0, 100).map((p) => this.node(p, false)) } }
          }
        }
      };
    }

    if (target.operation === 'EnableAutoMerge' || target.operation === 'DisableAutoMerge') {
      const field = target.operation === 'EnableAutoMerge' ? 'enablePullRequestAutoMerge' : 'disablePullRequestAutoMerge';
      const found = this.prById(vars.id);
      if (found === null) return fail({ [field]: null }, 'NOT_FOUND', `Could not resolve to a node with the global id of '${String(vars.id)}'`);
      const { repo, pr } = found;
      if (target.operation === 'EnableAutoMerge') {
        if (!this.settingsOf(repo).autoMergeAllowed) return fail({ [field]: null }, 'UNPROCESSABLE', 'Pull request Auto merge is not allowed for this repository');
        if (pr.state !== 'OPEN') return fail({ [field]: null }, 'UNPROCESSABLE', 'Pull request is not open');
        pr.autoMergeRequest = { mergeMethod: String(vars.method), enabledAt: new Date().toISOString() };
      } else {
        pr.autoMergeRequest = null;
      }
      pr.updatedAt = new Date(Math.max(Date.now(), Date.parse(pr.updatedAt) + 1)).toISOString();
      return { status: 200, payload: { data: { [field]: { pullRequest: { id: pr.id } } } } };
    }

    return fail(null, 'UNKNOWN', `unknown operation ${target.operation}`);
  }

  /**
   * The two REST PR writes. `merge` answers GitHub's refusals in GitHub's order: a PR that is not open (already merged, or closed) `405`, a `sha` that is
   * not the head `409`, a method the repo disallows `405`. `update-branch` answers `202` and moves the head at once — GitHub's is asynchronous, but the
   * only thing a caller can observe either way is a later read showing a new SHA — and `422` for a moved head or a fork that does not allow edits.
   */
  private pullWrite(repo: string, number: number, action: string, body: Record<string, unknown> | undefined): { status: number; payload: unknown } {
    const pr = this.prOf(repo, number);
    if (pr === undefined) return { status: 404, payload: { message: 'Not Found' } };
    const bump = (): void => {
      pr.updatedAt = new Date(Math.max(Date.now(), Date.parse(pr.updatedAt) + 1)).toISOString();
    };
    if (action === 'merge') {
      if (pr.state !== 'OPEN') return { status: 405, payload: { message: 'Pull Request is not mergeable' } };
      if (body?.sha !== undefined && body.sha !== pr.headRefOid) return { status: 409, payload: { message: 'Head branch was modified. Review and try the merge again.' } };
      const method = String(body?.merge_method ?? 'merge');
      const setting = METHOD_SETTING[method];
      if (setting === undefined || !this.settingsOf(repo)[setting]) return { status: 405, payload: { message: `${method} merges are not allowed on this repository.` } };
      pr.state = 'MERGED';
      pr.autoMergeRequest = null;
      bump();
      return { status: 200, payload: { sha: this.sha(`merge ${repo}#${number}`), merged: true, message: 'Pull Request successfully merged' } };
    }
    if (pr.state !== 'OPEN') return { status: 422, payload: { message: 'Pull request is not open' } };
    if (pr.isCrossRepository && !pr.maintainerCanModify) return { status: 422, payload: { message: 'You do not have permission to update this pull request branch' } };
    if (body?.expected_head_sha !== undefined && body.expected_head_sha !== pr.headRefOid) {
      return { status: 422, payload: { message: 'expected_head_sha does not match the current head SHA of the pull request' } };
    }
    pr.headRefOid = this.sha(`update ${repo}#${number}`);
    pr.mergeable = 'UNKNOWN';
    pr.mergeStateStatus = 'UNKNOWN';
    pr.viewerCanUpdateBranch = false;
    bump();
    return { status: 202, payload: { message: 'Updating pull request branch.', url: pr.url } };
  }

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
    const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/(merge|update-branch)$/.exec(path);
    if (pull !== null && method === 'PUT' && this.knows(pull[1])) return this.pullWrite(pull[1], Number(pull[2]), pull[3], body);
    const extra = this.extraRepoRoute(method, path);
    if (extra !== null) return extra;
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

