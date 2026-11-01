import { rmSync } from 'node:fs';

import { GithubSource } from '../server/src/items/sources/github.source';
import type { DispatchRecordsService } from '../server/src/items/dispatch-records.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { pullRefs, TrackerPollerService } from '../server/src/tracker/poller.service';
import { TRACKER_LABELS } from '../server/src/tracker/labels';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { inReviewBlock } from '../shared/agent';
import { makeProject } from './helpers/store';
import type { RegistryService } from '../server/src/registry/registry.service';

/**
 * #411 — the `in-review` label is lifted by derivation once the work it guards has landed on the default branch.
 *
 * The label is put on by execute's `pr` mode after a push, and nothing took it off when the PR merged with `Refs #<n>` rather than `Closes #<n>` (#266 after
 * PR #362): the issue stayed open, every gate read `inReview`, and the card said "a PR is open for this item" with no PR open. The fix reads the PRs the
 * issues endpoint already returns, so these cases drive the poller through a fake `fetch` exactly as `tracker-poll.test.ts` does, and read the answer through
 * `reviewLifted` and, end to end, through `GithubSource.list` and the one gate every surface shares.
 */

const dirs: string[] = [];

function githubProject(repo = 'futin/x'): string {
  const root = makeProject('tracker', [], JSON.stringify({ kind: 'github', repo }));
  dirs.push(root);
  return root;
}

function registryOf(...paths: string[]): RegistryService {
  return {
    load: () => ({ projects: paths.map((path, i) => ({ name: `p${i}`, path, createdAt: '2026-08-26T00:00:00.000Z' })) })
  } as unknown as RegistryService;
}

interface Call {
  url: string;
  method: string;
}

interface Canned {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** `tracker-poll.test.ts`'s rule table, slimmed to what these cases send: a URL substring, the first match wins, the answer may depend on the call count. */
function fakeFetch(rules: [string, Canned | ((call: number) => Canned)][]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method ?? 'GET' });
    for (const [rule, answer] of rules) {
      if (!url.includes(rule)) continue;
      const n = (counts.get(rule) ?? 0) + 1;
      counts.set(rule, n);
      const canned = typeof answer === 'function' ? answer(n) : answer;
      const headers = new Headers(canned.headers ?? {});
      if (canned.status === 304) return new Response(null, { status: 304, headers });
      return new Response(JSON.stringify(canned.body ?? {}), { status: canned.status, headers });
    }
    return new Response('[]', { status: 200 });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function poller(rules: [string, Canned | ((call: number) => Canned)][], project = githubProject()): { poller: TrackerPollerService; client: GithubClient; calls: Call[] } {
  const { fetch, calls } = fakeFetch([...rules, ['/labels', LABELS_PRESENT]]);
  const client = new GithubClient(fetch);
  return { poller: new TrackerPollerService(registryOf(project), client), client, calls };
}

const LABELS_PRESENT: Canned = { status: 200, body: TRACKER_LABELS.map((l) => ({ name: l.name })) };

const REVIEWED = [{ name: 'type:bug' }, { name: 'in-review' }];

const issue = (number: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `issue ${number}`,
  body: 'x',
  html_url: `https://github.com/futin/x/issues/${number}`,
  state: 'open',
  state_reason: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
  labels: REVIEWED,
  assignees: [],
  ...over
});

/** A PR as the ISSUES endpoint returns it: an issue-shaped row whose `pull_request` carries `merged_at`, and no base. `closed_at` defaults to the merge
 *  time — a closed-unmerged row passes its own when a case needs the order. */
const pr = (
  number: number,
  body: string,
  merged: string | null,
  state = merged === null ? 'open' : 'closed',
  closedAt: string | null = state === 'closed' ? merged : null
): Record<string, unknown> => ({
  ...issue(number, { body, state, labels: [], updated_at: '2026-10-25T00:00:00Z', closed_at: closedAt }),
  pull_request: { url: `https://api.github.com/repos/futin/x/pulls/${number}`, merged_at: merged }
});

/** The pulls endpoint's answer — the one place the base ref and the repo's default branch both are. */
const pull = (number: number, base: string, defaultBranch = 'main'): Canned => ({
  status: 200,
  body: { number, base: { ref: base, repo: { default_branch: defaultBranch } } }
});

const MERGED = '2026-10-25T09:00:00Z';
const pullCalls = (calls: Call[]): Call[] => calls.filter((c) => c.url.includes('/pulls/'));

const ORIGINAL_TOKEN = process.env[GITHUB_TOKEN_ENV];

beforeEach(() => {
  process.env[GITHUB_TOKEN_ENV] = 'tok';
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env[GITHUB_TOKEN_ENV];
  else process.env[GITHUB_TOKEN_ENV] = ORIGINAL_TOKEN;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('pullRefs — the issue numbers a PR body names after a keyword', () => {
  it.each([
    ['Refs #266', [266]],
    ['refs #266', [266]],
    ['Ref #266', [266]],
    ['Closes #266', [266]],
    ['close #266', [266]],
    ['closed #266', [266]],
    ['Fixes #266', [266]],
    ['fix #266', [266]],
    ['FIXED #266', [266]],
    ['Resolves #266', [266]],
    ['resolve #266', [266]],
    ['resolved #266', [266]],
    ['Closes: #266', [266]],
    ['Work for this.\n\nRefs #266.', [266]],
    ['Closes #1\nRefs #2', [1, 2]]
  ])('%j → %j', (body, expected) => {
    expect(pullRefs(body)).toEqual(expected);
  });

  // A bare mention is not a reference: #365 mentions #266 and must not lift it.
  it.each([
    ['see #266'],
    ['follow-up to #266'],
    ['prefixes #266'],
    ['Refs 266'],
    ['']
  ])('%j → nothing', (body) => {
    expect(pullRefs(body)).toEqual([]);
  });

  it('reads #310 as 310, never as 31', () => {
    expect(pullRefs('Closes #310')).toEqual([310]);
  });

  it('answers nothing for a null body', () => {
    expect(pullRefs(null)).toEqual([]);
  });

  // `owner/name#n` names another repo's issue, which no cache here holds (#428).
  it.each([
    ['Closes other/repo#12', []],
    ['Refs other/repo#12', []],
    ['Closes other/repo#13 and closes #12', [12]],
    ['Closes other/repo#12 and closes #12', [12]]
  ])('reads same-repo references only: %j → %j', (body, expected) => {
    expect(pullRefs(body)).toEqual(expected);
  });
});

describe('the PR index', () => {
  it('keeps PRs out of issues()', async () => {
    const { poller: p } = poller([
      ['/pulls/362', pull(362, 'main')],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.issues('futin/x').map((i) => i.number)).toEqual([266]);
    p.disarm();
  });

  it('updates a PR re-delivered by the inclusive since: open → merged lifts on the second tick', async () => {
    const { poller: p } = poller([
      ['/pulls/362', pull(362, 'main')],
      ['/issues?', (n) => ({ status: 200, body: n === 1 ? [issue(266), pr(362, 'Refs #266', null)] : [pr(362, 'Refs #266', MERGED)] })]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(true);
    p.disarm();
  });
});

describe('reviewLifted', () => {
  it('is true when one referencing PR merged into the default branch and none is open', async () => {
    const { poller: p } = poller([
      ['/pulls/362', pull(362, 'main')],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(true);
    p.disarm();
  });

  it('is false when the merge went into a non-default base', async () => {
    const { poller: p } = poller([
      ['/pulls/362', pull(362, 'feature/x')],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    p.disarm();
  });

  it('is false while another referencing PR is still open', async () => {
    const { poller: p } = poller([
      ['/pulls/362', pull(362, 'main')],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED), pr(370, 'Refs #266', null)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    p.disarm();
  });

  it('is false when the only referencing PR closed unmerged — the hand step stays', async () => {
    const { poller: p, calls } = poller([['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', null, 'closed')] }]]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(pullCalls(calls)).toHaveLength(0);
    p.disarm();
  });

  // groom's `pr`-mode plan PR says `Refs #<n>` and merges into main BEFORE execute runs: the latest closed PR decides, never any merged one.
  it('is false when the latest referencing PR closed unmerged, even with an older one merged into main', async () => {
    const { poller: p, calls } = poller([
      ['/pulls/350', pull(350, 'main')],
      ['/issues?', { status: 200, body: [issue(266), pr(350, 'Refs #266', '2026-10-20T09:00:00Z'), pr(362, 'Refs #266', null, 'closed', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(pullCalls(calls)).toHaveLength(0);
    p.disarm();
  });

  it('is false when the latest referencing PR merged into a feature base, even with an older one merged into main', async () => {
    const { poller: p, calls } = poller([
      ['/pulls/350', pull(350, 'main')],
      ['/pulls/362', pull(362, 'feature/x')],
      ['/issues?', { status: 200, body: [issue(266), pr(350, 'Refs #266', '2026-10-20T09:00:00Z'), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(pullCalls(calls)).toHaveLength(1);
    p.disarm();
  });

  it('is true when the latest referencing PR merged into main after an earlier one closed unmerged', async () => {
    const { poller: p } = poller([
      ['/pulls/362', pull(362, 'main')],
      ['/issues?', { status: 200, body: [issue(266), pr(355, 'Refs #266', null, 'closed', '2026-10-20T09:00:00Z'), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(true);
    p.disarm();
  });

  // Same closed_at, so the PR number alone decides. Each case runs in both row orders, so a tie left to the Map's insertion order fails one of them (#428).
  const TIED = '2026-10-01T00:00:00Z';

  it.each([
    ['#5 then #9', [5, 9]],
    ['#9 then #5', [9, 5]]
  ])('a tie on closed_at goes to the higher PR number: #9 merged into main lifts (%s)', async (_order, numbers) => {
    const rows = { 5: pr(5, 'Refs #266', null, 'closed', TIED), 9: pr(9, 'Refs #266', TIED) } as Record<number, unknown>;
    const { poller: p } = poller([
      ['/pulls/9', pull(9, 'main')],
      ['/issues?', { status: 200, body: [issue(266), ...numbers.map((n) => rows[n])] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(true);
    p.disarm();
  });

  it.each([
    ['#5 then #9', [5, 9]],
    ['#9 then #5', [9, 5]]
  ])('a tie on closed_at goes to the higher PR number: #9 closed unmerged does not lift (%s)', async (_order, numbers) => {
    const rows = { 5: pr(5, 'Refs #266', TIED), 9: pr(9, 'Refs #266', null, 'closed', TIED) } as Record<number, unknown>;
    const { poller: p, calls } = poller([
      ['/pulls/5', pull(5, 'main')],
      ['/issues?', { status: 200, body: [issue(266), ...numbers.map((n) => rows[n])] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(pullCalls(calls)).toHaveLength(0);
    p.disarm();
  });

  it('is false when the merged PR references the same number in another repo', async () => {
    const { poller: p, calls } = poller([
      ['/pulls/362', pull(362, 'main')],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Closes other/repo#266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(pullCalls(calls)).toHaveLength(0);
    p.disarm();
  });

  it('is false with no referencing PR at all, and for a bare mention', async () => {
    const { poller: p, calls } = poller([['/issues?', { status: 200, body: [issue(266), pr(365, 'see #266', MERGED)] }]]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(p.reviewLifted('futin/x', 999)).toBe(false);
    expect(pullCalls(calls)).toHaveLength(0);
    p.disarm();
  });

  it('is false for a repo that never synced', () => {
    const { poller: p } = poller([]);
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
  });

  it('stays false while the base lookup fails, and the next tick asks again', async () => {
    const { poller: p, calls } = poller([
      ['/pulls/362', (n) => (n === 1 ? { status: 500, body: { message: 'boom' } } : pull(362, 'main'))],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(true);
    expect(pullCalls(calls)).toHaveLength(2);
    p.disarm();
  });

  it('stays false under a rate limit, and the repo sleeps as any limited read does', async () => {
    const { poller: p } = poller([
      ['/pulls/362', { status: 403, body: { message: 'rate limited' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' } }],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(p.summary('futin/x').access).toBe('rate-limited');
    p.disarm();
  });

  it('reads a vanished PR (404) as base unknown without marking the repo unreadable', async () => {
    const { poller: p } = poller([
      ['/pulls/362', { status: 404, body: { message: 'Not Found' } }],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(p.reviewLifted('futin/x', 266)).toBe(false);
    expect(p.summary('futin/x').access).toBe('ok');
    p.disarm();
  });

  it('fetches a merged PR’s base at most once across ticks', async () => {
    const { poller: p, calls } = poller([
      ['/pulls/362', pull(362, 'feature/x')],
      ['/issues?', { status: 200, body: [issue(266), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    await p.tick();
    await p.tick();
    expect(pullCalls(calls)).toHaveLength(1);
    p.disarm();
  });

  it('makes no pull request for an issue without the in-review label', async () => {
    const { poller: p, calls } = poller([
      ['/pulls/362', pull(362, 'main')],
      ['/issues?', { status: 200, body: [issue(266, { labels: [{ name: 'type:bug' }] }), pr(362, 'Refs #266', MERGED)] }]
    ]);
    await p.tick();
    expect(pullCalls(calls)).toHaveLength(0);
    p.disarm();
  });
});

describe('end to end — the #266 shape through GithubSource.list', () => {
  it('drops inReview once a Refs PR merged into the default branch, so no gate refuses', async () => {
    const root = githubProject();
    const { poller: p, client } = poller(
      [
        ['/pulls/362', pull(362, 'main')],
        ['/issues?', { status: 200, body: [issue(266), issue(31), pr(362, 'Partial fix.\n\nRefs #266', MERGED)] }]
      ],
      root
    );
    await p.tick();
    const source = new GithubSource(p, client, { get: () => null } as unknown as DispatchRecordsService);
    const { items } = await source.list({ name: 'p0', path: root, createdAt: '2026-08-26T00:00:00.000Z' }, { kind: 'github', repo: 'futin/x' });
    p.disarm();

    const lifted = items.find((i) => i.id === '#266');
    const kept = items.find((i) => i.id === '#31');
    expect(lifted).toBeDefined();
    expect('inReview' in (lifted ?? {})).toBe(false);
    expect(inReviewBlock(lifted!)).toBeNull();
    // The control: the same label with no merged PR behind it still blocks.
    expect(kept?.inReview).toBe(true);
    expect(inReviewBlock(kept!)).not.toBeNull();
  });
});
