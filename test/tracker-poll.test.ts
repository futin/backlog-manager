import { rmSync } from 'node:fs';

import { GithubClient } from '../server/src/tracker/github.client';
import { SECONDARY_BACKOFF_MS, TrackerPollerService } from '../server/src/tracker/poller.service';
import { TRACKER_LABELS } from '../server/src/tracker/labels';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { makeProject } from './helpers/store';
import type { RegistryService } from '../server/src/registry/registry.service';

/**
 * The poller against a fake `fetch` (task-45, spec §12.2). Every branch this
 * suite drives is one a live-network test could never schedule — a `304`, a
 * `403` at the hourly limit, a secondary limit, a second page — which is
 * exactly why `GithubClient` takes its `fetch` through the constructor and
 * carries no Nest decorators.
 *
 * Real temp directories for the projects, the same choice
 * `test/source-resolve.test.ts` makes: the "armed only while something is
 * connected" rule is resolved through `resolveSource` reading a real marker
 * file, and a stubbed `fs` would assert the stub's idea of that.
 */

const dirs: string[] = [];

function githubProject(repo = 'futin/x'): string {
  const root = makeProject('tracker', [], JSON.stringify({ kind: 'github', repo }));
  dirs.push(root);
  return root;
}

function filesProject(): string {
  const root = makeProject('files', []);
  dirs.push(root);
  return root;
}

function registryOf(...paths: string[]): RegistryService {
  return {
    load: () => ({ projects: paths.map((path, i) => ({ name: `p${i}`, path, createdAt: '2026-08-26T00:00:00.000Z' })) })
  } as unknown as RegistryService;
}

/** One recorded call plus the canned answer for it. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface Canned {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fake `fetch` built from a rule table. Each rule's key is a SUBSTRING of the
 * URL — so a case names the endpoint it cares about (`/issues?`, `/labels`)
 * and stays readable — optionally prefixed with a method (`POST /labels`),
 * which matters because listing labels and creating one are the same URL and
 * differ only by verb. The first matching rule wins, so a case can put a
 * specific rule ahead of a general one, and the answer may be a function of
 * how many times that rule has matched.
 */
function fakeFetch(rules: [string, Canned | ((call: number) => Canned)][]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined
    });
    const method = init?.method ?? 'GET';
    for (const [rule, answer] of rules) {
      const verb = /^(GET|POST|PATCH|DELETE) /.exec(rule);
      const needle = verb === null ? rule : rule.slice(verb[0].length);
      if (verb !== null && verb[1] !== method) continue;
      if (!url.includes(needle)) continue;
      const n = (counts.get(rule) ?? 0) + 1;
      counts.set(rule, n);
      const canned = typeof answer === 'function' ? answer(n) : answer;
      const headers = new Headers(canned.headers ?? {});
      if (canned.status === 304) return new Response(null, { status: 304, headers });
      return new Response(JSON.stringify(canned.body ?? {}), { status: canned.status, headers });
    }
    // The default answer is an EMPTY LIST, not `{}`: every endpoint this
    // client calls returns an array, and a case that does not mention one
    // (the comments read, most often) should get a well-formed empty answer
    // rather than a shape no GitHub endpoint produces.
    return new Response('[]', { status: 200 });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function poller(registry: RegistryService, rules: [string, Canned | ((call: number) => Canned)][]): { poller: TrackerPollerService; calls: Call[] } {
  const { fetch, calls } = fakeFetch(rules);
  return { poller: new TrackerPollerService(registry, new GithubClient(fetch)), calls };
}

const issue = (number: number, updated: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `issue ${number}`,
  body: 'x',
  html_url: `https://github.com/futin/x/issues/${number}`,
  state: 'open',
  state_reason: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: updated,
  labels: [{ name: 'type:bug' }],
  assignees: [],
  ...over
});

/** Every label already present, so the bootstrap creates none — the default
 *  for cases that are not about the bootstrap. */
const LABELS_PRESENT: Canned = { status: 200, body: TRACKER_LABELS.map((l) => ({ name: l.name })) };

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

describe('armed, idle, off', () => {
  it('arms when a project resolves to github and a token is present', async () => {
    const { poller: p } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      ['/labels', LABELS_PRESENT]
    ]);
    p.arm();
    await p.tick();
    expect(p.armed).toBe(true);
    p.disarm();
  });

  it('does not arm without a token', async () => {
    delete process.env[GITHUB_TOKEN_ENV];
    const { poller: p, calls } = poller(registryOf(githubProject()), []);
    p.arm();
    await p.tick();
    expect(p.armed).toBe(false);
    // Not one request: "off" means this loop does nothing at all, the same
    // claim the watchdog's own off state makes.
    expect(calls).toHaveLength(0);
  });

  it('does not arm when no project resolves to github', async () => {
    const { poller: p, calls } = poller(registryOf(filesProject()), []);
    p.arm();
    await p.tick();
    expect(p.armed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does not arm when both are missing', async () => {
    delete process.env[GITHUB_TOKEN_ENV];
    const { poller: p } = poller(registryOf(filesProject()), []);
    p.arm();
    await p.tick();
    expect(p.armed).toBe(false);
  });
});

describe('syncing', () => {
  it('sends no since on the first sync and consumes every page', async () => {
    const page2 = 'https://api.github.com/repositories/1/issues?page=2';
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['page=2', { status: 200, body: [issue(2, '2026-09-02T00:00:00Z')] }],
      ['/issues?', { status: 200, body: [issue(1, '2026-09-01T00:00:00Z')], headers: { link: `<${page2}>; rel="next"` } }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();

    const first = calls.find((c) => c.url.includes('/issues?state=all'));
    expect(first?.url).not.toContain('since=');
    // Both pages consumed, not just the first: a poller that stopped at page
    // one would silently show a truncated backlog on any repo with more than
    // a hundred issues.
    expect(calls.some((c) => c.url === page2)).toBe(true);
    expect(p.issues('futin/x').map((i) => i.number)).toEqual([1, 2]);
    p.disarm();
  });

  it('upserts on an inclusive since rather than duplicating', async () => {
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [issue(1, '2026-09-01T00:00:00Z')] }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    expect(p.issues('futin/x')).toHaveLength(1);

    // The second tick sends the high-water mark and GitHub answers with the
    // same issue, because `since` is inclusive. The cache is keyed by issue
    // number, so the count does not grow.
    await p.tick();
    expect(p.issues('futin/x')).toHaveLength(1);
    const second = calls.filter((c) => c.url.includes('/issues?state=all'))[1];
    expect(second.url).toContain(`since=${encodeURIComponent('2026-09-01T00:00:00Z')}`);
    p.disarm();
  });

  it('leaves the cache untouched and moves polledAt on a 304', async () => {
    const { poller: p } = poller(registryOf(githubProject()), [
      ['/issues?', (n): Canned => (n === 1 ? { status: 200, body: [issue(1, '2026-09-01T00:00:00Z')], headers: { etag: 'W/"abc"' } } : { status: 304 })],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    const after = p.summary('futin/x');
    expect(after.polledAt).not.toBeNull();

    // Two milliseconds, so the two stamps cannot land in the same one: the
    // assertion below is STRICTLY newer, which is what tells "the 304 branch
    // stamped it" apart from "the 304 branch left it alone", and an equality
    // that happened to hold because both ticks ran inside one millisecond would
    // report the second as the first.
    await new Promise((resolve) => setTimeout(resolve, 2));

    await p.tick();
    // The cache is untouched — nothing changed, so there is nothing to absorb —
    // and `polledAt` MOVES, because the age the board renders means "since we
    // last successfully checked" and a 304 is a successful check. Task-45
    // shipped the opposite reading against spec §12.2 and recorded the
    // disagreement; task-46 settled it in the spec's favour.
    expect(p.issues('futin/x')).toHaveLength(1);
    expect(p.summary('futin/x').access).toBe('ok');
    const moved = p.summary('futin/x').polledAt;
    expect(moved).not.toBeNull();
    // Strictly newer, not merely different: a stamp that moved BACKWARDS would
    // satisfy an inequality and would be a clock bug rather than a poll.
    expect(Date.parse(moved as string)).toBeGreaterThan(Date.parse(after.polledAt as string));
    p.disarm();
  });

  it('sends If-None-Match once it has an ETag', async () => {
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [], headers: { etag: 'W/"abc"' } }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    await p.tick();
    const second = calls.filter((c) => c.url.includes('/issues?state=all'))[1];
    expect(second.headers['if-none-match']).toBe('W/"abc"');
    p.disarm();
  });

  it('drops pull requests out of the cache', async () => {
    const { poller: p } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [issue(1, '2026-09-01T00:00:00Z'), issue(2, '2026-09-02T00:00:00Z', { pull_request: { url: 'u' } })] }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    expect(p.issues('futin/x').map((i) => i.number)).toEqual([1]);
    p.disarm();
  });

  it('asks for the repo comments on every tick, including one whose issues read was a 304', async () => {
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues/comments', { status: 200, body: [] }],
      // Changed on the first tick, unchanged on the second — so the second
      // tick's comments call is the one a "only when the issues read changed"
      // implementation would skip.
      ['/issues?', (n): Canned => (n === 1 ? { status: 200, body: [], headers: { etag: 'W/"abc"' } } : { status: 304 })],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    await p.tick();
    // Asserted explicitly BECAUSE nothing reads the result in this phase: a
    // call with no reader is exactly the kind of thing a later edit drops as
    // dead, and phase 3's claim watching depends on it already being paid for.
    expect(calls.filter((c) => c.url.includes('/issues/comments')).length).toBe(2);
    p.disarm();
  });
});

describe('rate limits', () => {
  it('records rate-limited with the reset time and makes no further request until it', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    const summary = p.summary('futin/x');
    expect(summary.access).toBe('rate-limited');
    expect(summary.detail).toContain(new Date(reset * 1000).toISOString());

    const before = calls.length;
    await p.tick();
    // Not one request while asleep — not even a conditional one. A 304 is free
    // against the budget but a 403 is not, and asking again before the reset
    // is how an app earns a secondary limit on top of the one it has.
    expect(calls.length).toBe(before);
    p.disarm();
  });

  it('backs off a minute on a secondary limit', async () => {
    const { poller: p } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 403, body: { message: 'You have exceeded a secondary rate limit' } }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    const summary = p.summary('futin/x');
    expect(summary.access).toBe('rate-limited');
    expect(summary.detail).toContain(String(SECONDARY_BACKOFF_MS / 1000));
    p.disarm();
  });

  it('separates a forbidden repo from a missing one', async () => {
    const forbidden = poller(registryOf(githubProject()), [['/issues?', { status: 403, body: { message: 'Resource not accessible' } }]]);
    await forbidden.poller.tick();
    expect(forbidden.poller.summary('futin/x').access).toBe('forbidden');
    forbidden.poller.disarm();

    const missing = poller(registryOf(githubProject()), [['/issues?', { status: 404, body: { message: 'Not Found' } }]]);
    await missing.poller.tick();
    expect(missing.poller.summary('futin/x').access).toBe('not-found');
    missing.poller.disarm();
  });

  it('reads no-token whatever the last sync said', async () => {
    const { poller: p } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    expect(p.summary('futin/x').access).toBe('ok');
    delete process.env[GITHUB_TOKEN_ENV];
    // The credential is read per call, so removing it is visible at once —
    // a stale `ok` would be a lie the Trackers card renders.
    expect(p.summary('futin/x').access).toBe('no-token');
    p.disarm();
  });
});

describe('the label bootstrap', () => {
  it('creates exactly the missing labels, once', async () => {
    const present = TRACKER_LABELS.slice(0, 5).map((l) => ({ name: l.name }));
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      ['POST /labels', { status: 201 }],
      ['GET /labels', { status: 200, body: present }]
    ]);
    await p.tick();

    const created = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/labels'));
    expect(created).toHaveLength(TRACKER_LABELS.length - present.length);

    const before = created.length;
    await p.tick();
    // Idempotent across ticks: the second sync creates nothing, which is the
    // half of "created idempotently" a single-tick test cannot see.
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/labels'))).toHaveLength(before);
    p.disarm();
  });

  /* A repo bootstrapped before orchestrator:queued existed carries the other
     eight; its next sync must create exactly the one it lacks, and by name —
     a count alone would pass with the wrong label created. */
  it('creates exactly orchestrator:queued for a repo that has the earlier eight', async () => {
    const eight = TRACKER_LABELS.filter((l) => l.name !== 'orchestrator:queued').map((l) => ({ name: l.name }));
    expect(eight).toHaveLength(8);
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      ['POST /labels', { status: 201 }],
      ['GET /labels', { status: 200, body: eight }]
    ]);
    await p.tick();

    const created = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/labels'));
    expect(created.map((c) => (JSON.parse(c.body ?? '{}') as { name?: string }).name)).toEqual(['orchestrator:queued']);
    p.disarm();
  });

  it('creates none when the repo already has all nine', async () => {
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      ['/labels', LABELS_PRESENT]
    ]);
    await p.tick();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    p.disarm();
  });

  it('treats an existing label case-insensitively', async () => {
    const shouty = TRACKER_LABELS.map((l) => ({ name: l.name.toUpperCase() }));
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      ['/labels', { status: 200, body: shouty }]
    ]);
    await p.tick();
    // GitHub label names preserve case but collide without it, so creating
    // `type:bug` beside `TYPE:BUG` is a 422 on every tick forever.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    p.disarm();
  });

  it('survives a labels body that is not a list, and keeps ticking', async () => {
    const { poller: p } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      // A 200 carrying valid JSON that is not the array the endpoint
      // documents. This runs inside the timer chain, where a `TypeError` is an
      // unhandled rejection that kills the poll loop rather than costing one
      // tick — so the read is guarded by `Array.isArray`, like every other
      // list read in the file, and the repo stays `ok` rather than blowing up.
      ['GET /labels', { status: 200, body: { message: 'not a list' } }]
    ]);
    await expect(p.tick()).resolves.toBeUndefined();
    expect(p.summary('futin/x').access).toBe('ok');
    p.disarm();
  });

  it('retries on the next tick when a create fails, and stops once it succeeds', async () => {
    const { poller: p, calls } = poller(registryOf(githubProject()), [
      ['/issues?', { status: 200, body: [] }],
      // Every create fails on the first tick and succeeds on the second: eight
      // creates a tick, so the ninth call onwards is the second tick's.
      ['POST /labels', (n): Canned => (n <= TRACKER_LABELS.length ? { status: 500, body: { message: 'boom' } } : { status: 201 })],
      ['GET /labels', { status: 200, body: [] }]
    ]);
    await p.tick();
    const first = calls.filter((c) => c.method === 'POST').length;
    expect(first).toBe(TRACKER_LABELS.length);

    // A failed create leaves the flag down, so the next tick tries again —
    // and once they all succeed, a third tick creates nothing.
    await p.tick();
    expect(calls.filter((c) => c.method === 'POST').length).toBe(first * 2);
    await p.tick();
    expect(calls.filter((c) => c.method === 'POST').length).toBe(first * 2);
    p.disarm();
  });
});
