import { Injectable } from '@nestjs/common';

import { GithubClient, isRepo, type GithubResponse } from './github.client';
import { TrackerPollerService, failureVerdict, type Access, type FailureVerdict } from './poller.service';
import { readPull, readPullList, setAutoMerge, type PullOne } from './pulls.query';
import { githubToken } from './token.util';
import { resolveSource } from '../items/sources/resolve.util';
import { RegistryService, registryProjectsOr503 } from '../registry/registry.service';
import {
  MERGE_METHODS,
  PR_UPDATING_MS,
  type MergeMethod,
  type PrAutoMergeRequest,
  type PrMergeRequest,
  type PrRepoView,
  type PrUpdateBranchRequest,
  type PrWriteOutcome,
  type PrWriteResult,
  type PullRequestRow,
  type PullRequestsPayload
} from '../../../shared/types';

/**
 * The PRs page's cache (spec 2026-10-29-source-sections-design.md, "PR list freshness"): per repo, in memory, lost on restart, filled ON DEMAND.
 *
 * ## Why on demand, and why no timer
 *
 * The issue poller sweeps on a clock because the board, the claim protocol and every run read its cache whether or not anybody is looking. Nothing reads
 * pull requests except the PRs page, so a sweep would spend GraphQL budget on a list nobody is drawing and break "the poller is armed only while something
 * is connected" in spirit — a page closed an hour ago would still be polling. So this service has NO `setTimeout`, no interval and no sweep: a read happens
 * only inside `list()` (a `GET /api/prs`) or, from task 4, inside a write's re-read. The page's own `useCoalescedFetch` at 60 s is the only cadence, and it
 * stops when the page unmounts.
 *
 * ## Why a cache at all
 *
 * The TTL is what makes two tabs, or a tab and a write's re-read, cost one query per minute per repo instead of one each. An entry younger than `PR_TTL_MS`
 * is served as it is; an older one is re-read. A concurrent second `list()` for a repo already being read awaits the SAME promise rather than sending a
 * second query — the fresh-check alone cannot do that, because nothing is fresh until the first answer lands.
 *
 * ## Its age is rendered, and a failure keeps the last answer
 *
 * This is the third of the caches whose age is a rendered value (CLAUDE.md; the tracker's issue cache and the Jira board caches are the other two):
 * `polledAt` rides on every repo's view and the page draws it. It moves on a SUCCESSFUL read only. A failure keeps the previous rows and their `polledAt`,
 * and sets `access`/`detail` from `failureVerdict` — the poller's one failure rule, applied unchanged, so a GraphQL rate limit reads exactly as a REST one
 * does on the board. A page that blanked its list on a 502 would trade a stale-but-labelled answer for no answer, which is never the better one.
 *
 * A failed read still counts against the TTL (ruling R6): freshness is judged from the later of `polledAt` and `attemptedAt`, the time of the last read
 * of either outcome. Without it a repo answering 502 would be re-queried on every `GET` — two tabs, two queries a minute each — which is exactly the cost the
 * TTL exists to cap; a failing repo is retried once a minute like a healthy one.
 *
 * One thing makes an entry due BEFORE its TTL: an accepted update-branch sets `dueAt` to `PR_UPDATING_MS` after the write. GitHub merges the base in
 * asynchronously, the write's own re-read usually still shows the old head, and the page's row says `updating…` for exactly that long and then re-reads
 * once (`shared/types.ts`, the one home of the number). Served from a 60 s TTL, that re-read would bring back the old head with the row's actions enabled on
 * it — and a `Merge` clicked then sends a stale SHA into a self-caused 409. `dueAt` only ever makes a read happen sooner; the in-flight join still holds,
 * so it never causes a second concurrent read.
 *
 * ## A read in flight never undoes a write
 *
 * A list read started before a write and landing after it carries GitHub's state from before the write. Stored, it would put a merged PR back on the page
 * for a whole TTL. So `splice` counts its changes (`splices`), a read notes the count when it starts, and a read that lands after a splice keeps its
 * verdict and its attempt time but not its rows — the rows the cache holds are the read's minus nothing it can prove, plus the write's re-read. Likewise a
 * successful read clears only a sleep that has run out: one a write recorded while the read was out is younger than the read's answer, not refuted by it.
 *
 * ## Rate limits
 *
 * Values, never sleeps inside a request. An hourly-limit verdict puts ONE POOL of this repo's entry to sleep until the reset — `rest` or `graphql`, the pool
 * the failed request spent (#395) — because GitHub counts the two primary budgets apart (ruling R1): a merge that exhausts REST must not put the GraphQL list
 * read to sleep, and a GraphQL limit must not refuse a REST merge. Every request checks the pool it spends: the list read, a write's re-read and auto-merge
 * check `graphql`; merge and update-branch check `rest`, and that rung also reads the issue poller's own sleep (`poller.restSleep`), since the poller spends
 * the same REST pool. Only a `graphql` sleep is the list's `access`/`detail`. A secondary verdict is shared — GitHub counts it per token, across both APIs —
 * so it also goes to `poller.noteSecondary`, and the poller's own `secondaryUntil` is read here before every request, which is the other direction of the
 * same sharing. A repo asleep is served from its entry (or an empty view) with the sleep as `detail`, and gets no request in that pool.
 *
 * ## One view per repo
 *
 * Keyed by repo, never by project: two checkouts of one repo are one list on GitHub. `syncOff` is resolved through the FIRST registered project on the repo,
 * because `syncOffBlock` is keyed by project path and is the one home of its sentence; sync is per repo, so every checkout answers the same.
 */

/** How long a successful read is served before the next `list()` re-reads it — the page's own poll period, so a page open alone costs one query per minute
 *  per repo and a second tab costs nothing. */
export const PR_TTL_MS = 60_000;

/** The two primary rate-limit pools a PR request spends from — GitHub counts them apart (ruling R1). */
type PrPool = 'rest' | 'graphql';

/** One pool's sleep: the reset, and the verdict's sentence a request refused under it carries. */
interface PoolSleep {
  until: number;
  detail: string | null;
}

/** One repo's cached state. Created by the first read or the first sleep (`noteSleep`), whichever comes first. */
interface PrEntry {
  /** Epoch ms of the last SUCCESSFUL read; `null` before one. */
  polledAt: number | null;
  /** Epoch ms of the last list read of EITHER outcome; `null` before one. What the TTL is measured from, with `polledAt` (R6). */
  attemptedAt: number | null;
  /** The LIST's state — the list read's verdict, or a `graphql` sleep's — never a `rest` sleep's, which says nothing about whether the list can be read. */
  access: Access;
  detail: string | null;
  /** Per pool, the limit this cache met itself (an hourly reset or a secondary backoff), before whose end that pool gets no request; `null` when none. */
  sleeps: Record<PrPool, PoolSleep | null>;
  /** Epoch ms at which the entry is due again although its TTL has not run out — set by an accepted update-branch (`PR_UPDATING_MS`); cleared by a read
   *  that started at or after it. `null` when only the TTL decides. */
  dueAt: number | null;
  /** How many splices this entry has taken — a read that lands with a different count than it started with drops its rows. */
  splices: number;
  prs: PullRequestRow[];
  total: number;
  methods: MergeMethod[];
  autoMergeAllowed: boolean;
}

/** A PR write's refusal: the HTTP status the route answers and the sentence it carries as `{ error }`. */
export interface PrWriteRefusal {
  ok: false;
  status: number;
  error: string;
}

/** What a PR write hands its route: the result with the success status (`200`, or `202` for update-branch), or the refusal. */
export type PrWriteAnswer = { ok: true; status: 200 | 202; result: PrWriteResult } | PrWriteRefusal;

/** `GithubSource.ready`'s sentence for the same fact, so the two write surfaces say it alike. */
const NO_TOKEN = 'BM_GITHUB_TOKEN is not set on this machine';

/** A 2xx with no error — GraphQL's refusals arrive as a `200` with `error` set, so the status alone is not success. */
function succeeded(res: GithubResponse<unknown>): boolean {
  return res.status >= 200 && res.status < 300 && res.error === null;
}

/** The row the cache should hold for a re-read PR: the row while it is open, `null` (a removal) once merged or closed. */
function openRow(one: PullOne): PullRequestRow | null {
  return one.state === 'OPEN' ? one.row : null;
}

function answered(status: 200 | 202, outcome: PrWriteOutcome, re: PullOne | null): PrWriteAnswer {
  return { ok: true, status, result: { ok: true, outcome, pr: re === null ? null : openRow(re), reread: re !== null } };
}

/** The kinds `resolveSource` is asked to honour here — the poller's and the trackers route's set. */
const KNOWN: ReadonlySet<string> = new Set(['github']);

/** Newest update first — the list query's own order, restored after a splice adds or moves a row. ISO-8601 stamps from one source compare as strings. */
function byUpdatedDesc(a: PullRequestRow, b: PullRequestRow): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

@Injectable()
export class PullRequestsService {
  private readonly entries = new Map<string, PrEntry>();
  /** The read in flight per repo, so a second caller joins it instead of sending its own query. Removed when it settles. */
  private readonly reading = new Map<string, Promise<void>>();
  /** The write chain per `<repo>#<number>` (`serialise`). */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: RegistryService,
    private readonly client: GithubClient,
    private readonly poller: TrackerPollerService
  ) {}

  /**
   * Every distinct registered GitHub repo's view, reading the ones whose entry is stale and that are not asleep. `now` is a parameter so a case can pin it;
   * the default is the real clock. No token answers `{ token: false, repos: [] }` before the registry is even read — there is nothing a request could be
   * made with, and the page says "no token" from that one bit.
   *
   * Throws 503 (`registryProjectsOr503`) for a registry that cannot be read, as `/api/trackers` does: an empty list would read as "no repos registered".
   */
  async list(now: number = Date.now()): Promise<PullRequestsPayload> {
    const token = githubToken();
    if (token === null) return { token: false, repos: [] };

    const repos = this.registeredRepos();

    // Every repo's read starts synchronously inside `map` (no await before `refresh` registers its promise), which is what lets a concurrent `list()`
    // find the in-flight read and join it.
    const views = await Promise.all(
      [...repos].map(async ([repo, path]) => {
        await this.refresh(repo, now, token);
        return this.view(repo, path, now);
      })
    );
    return { token: true, repos: views };
  }

  /**
   * Put one re-read PR into the cached list (task 4's writes call this after the write's own single-PR read): replace the row with this number, add it
   * when absent, or — `row` null, the re-read said `MERGED` or `CLOSED` — remove it. `total` follows so `truncated` stays true to the list: a removal of a
   * held row counts down, and an add counts up only when the list was COMPLETE — on a list truncated at 100, a PR absent from the page is one GitHub's
   * `totalCount` already counted, and counting it again would overshoot. `polledAt` does NOT move, because it is the age of the list read and a splice
   * re-read one row. A repo with no successful read yet is left alone: one row would draw as the whole list.
   */
  splice(repo: string, row: PullRequestRow | null, number: number): void {
    const entry = this.entries.get(repo);
    if (entry === undefined || entry.polledAt === null) return;
    // Counted before anything else, a no-op removal included: a read in flight may still hold the row this splice found absent.
    entry.splices += 1;
    const at = entry.prs.findIndex((p) => p.number === number);
    if (row === null) {
      if (at === -1) return;
      entry.prs.splice(at, 1);
      entry.total = Math.max(0, entry.total - 1);
      return;
    }
    if (at === -1) {
      const complete = entry.total <= entry.prs.length;
      entry.prs.push(row);
      if (complete) entry.total += 1;
    } else {
      entry.prs[at] = row;
    }
    entry.prs.sort(byUpdatedDesc);
  }

  /**
   * Apply a limit verdict to a repo's entry — creating an empty, never-read entry when there is none (ruling R4: a write can meet a limit before any list
   * read did, and the sleep must not be lost to that ordering). A verdict that is not a limit is ignored here: a write's 409 or 422 is that write's answer,
   * not the repo's connection state. Sleeps `pool`, the one the failed request spent, and never shortens a sleep already set there. Only a `graphql` sleep
   * becomes the list's `access`/`detail`. A secondary verdict also sleeps the issue poller's repo — and, through its `secondaryUntil`, both pools here.
   */
  noteSleep(repo: string, verdict: FailureVerdict, pool: PrPool): void {
    if (verdict.sleepUntil === null) return;
    const entry = this.entryOf(repo);
    if (pool === 'graphql') {
      entry.access = verdict.access;
      entry.detail = verdict.detail;
    }
    const held = entry.sleeps[pool];
    if (held === null || verdict.sleepUntil > held.until) entry.sleeps[pool] = { until: verdict.sleepUntil, detail: verdict.detail };
    if (verdict.secondary) this.poller.noteSecondary(repo, verdict.sleepUntil);
  }

  /**
   * `POST /api/prs/merge`. GitHub's `200` is `merged`. A refusal re-reads the PR first: a re-read that says `MERGED` turns it into `200 already-merged` —
   * the second of two clicks, serialised behind the first by `serialise`, meets GitHub's `405` on a PR that is no longer open, and that is the answer the
   * person wanted, not an error — and any other refusal is answered after its re-read is spliced, so a `409` (head moved) leaves the cache holding the head
   * the page must now show. A successful merge splices the PR out even when its re-read fails, because GitHub's `200` already said it is merged.
   */
  merge(req: PrMergeRequest, at?: number): Promise<PrWriteAnswer> {
    return this.write(req.repo, req.number, at, 'rest', async (token, now) => {
      const res = await this.client.mergePull(req.repo, req.number, { merge_method: req.method, sha: req.headSha }, { token });
      if (succeeded(res)) {
        const re = await this.reread(req.repo, req.number, token, now);
        if (re === null) this.splice(req.repo, null, req.number);
        return answered(200, 'merged', re);
      }
      const refusal = this.refusal(req.repo, res, now, 'rest');
      if (refusal.status === 429) return refusal;
      const re = await this.reread(req.repo, req.number, token, now);
      if (re?.state === 'MERGED') return answered(200, 'already-merged', re);
      return refusal;
    });
  }

  /**
   * `POST /api/prs/auto-merge`. The PR is read FIRST — the mutations take its node id, which never leaves the server, and the read says whether anything is
   * armed — and that read is spliced. A disarm of a PR with nothing armed is `200 noop` with no mutation sent. GitHub's refusal of the mutation (auto-merge
   * off on the repo, a PR already clean to merge) is a typed GraphQL error on a `200`, answered `409` with its text.
   */
  autoMerge(req: PrAutoMergeRequest, at?: number): Promise<PrWriteAnswer> {
    return this.write(req.repo, req.number, at, 'graphql', async (token, now) => {
      const before = await readPull(this.client, req.repo, req.number, { token });
      if (!succeeded(before) || before.data === null) return this.refusal(req.repo, before, now, 'graphql');
      this.splice(req.repo, openRow(before.data), req.number);
      if (!req.enable && before.data.row.autoMerge === null) return answered(200, 'noop', before.data);

      const change = req.enable ? { enable: true as const, method: req.method ?? 'merge' } : { enable: false as const };
      const res = await setAutoMerge(this.client, before.data.id, change, { token });
      if (!succeeded(res)) {
        const refusal = this.refusal(req.repo, res, now, 'graphql');
        if (refusal.status !== 429) await this.reread(req.repo, req.number, token, now);
        return refusal;
      }
      return answered(200, req.enable ? 'auto-merge-enabled' : 'auto-merge-disabled', await this.reread(req.repo, req.number, token, now));
    });
  }

  /**
   * `POST /api/prs/update-branch`. GitHub's `202` is `update-requested`: the update runs asynchronously on GitHub, so the immediate re-read may still show the
   * old head — the page shows `updating…` until a read shows a new one, or `PR_UPDATING_MS` pass and it re-reads once. That re-read must reach GitHub, so
   * the repo's entry is made due at the same moment (`dueAt`). A `422` (head moved, a fork that does not allow edits) is a `409` with GitHub's text.
   */
  updateBranch(req: PrUpdateBranchRequest, at?: number): Promise<PrWriteAnswer> {
    return this.write(req.repo, req.number, at, 'rest', async (token, now) => {
      const res = await this.client.updatePullBranch(req.repo, req.number, req.headSha, { token });
      if (succeeded(res)) {
        const re = await this.reread(req.repo, req.number, token, now);
        this.dueBy(req.repo, now + PR_UPDATING_MS);
        return answered(202, 'update-requested', re);
      }
      const refusal = this.refusal(req.repo, res, now, 'rest');
      if (refusal.status !== 429) await this.reread(req.repo, req.number, token, now);
      return refusal;
    });
  }

  /**
   * The refusal ladder every PR write shares, in its order. Outside the chain: `404` for a repo no registered project resolves to (the registry is read per
   * call, so an unreadable one is `registryProjectsOr503`'s 503, as `GET /api/prs` answers), then `503` for no token — both facts about this machine that no
   * waiting changes. Inside `serialise('<repo>#<number>')`, re-judged when the write's turn comes rather than when it was queued: `409` sync off (the
   * poller's `syncOffBlock` sentence, its one home), `429` while `pool` — the one the write's own call spends — is asleep: this cache's sleep in that pool,
   * the poller's secondary one, and for `rest` the poller's own REST sleep (#395) — and only then `fn`, the GitHub calls. Nothing before `fn` makes an
   * outbound call. A write's re-read is GraphQL and is not judged here: it fails on its own, and the write's answer says `reread: false`.
   *
   * The clock is read when the write's turn comes, not when it was queued: a write behind another waits one GitHub round trip or more, and a `now` from
   * before that wait would judge the asleep check — and the sleep its own answer sets — against a moment already past. `at` pins it for a case.
   */
  private async write(
    repo: string,
    number: number,
    at: number | undefined,
    pool: PrPool,
    fn: (token: string, now: number) => Promise<PrWriteAnswer>
  ): Promise<PrWriteAnswer> {
    const path = this.registeredRepos().get(repo);
    if (path === undefined) return { ok: false, status: 404, error: `${repo} is not the repo of a registered GitHub project` };
    const token = githubToken();
    if (token === null) return { ok: false, status: 503, error: NO_TOKEN };
    return this.serialise(`${repo}#${number}`, async () => {
      const now = at ?? Date.now();
      const off = this.poller.syncOffBlock(path);
      if (off !== null) return { ok: false, status: 409, error: off };
      const asleep = this.asleepDetail(repo, now, pool);
      if (asleep !== null) return { ok: false, status: 429, error: asleep };
      return fn(token, now);
    });
  }

  /** Make `repo`'s entry due no later than `until`, whatever its TTL says — never later than a due time already set. An entry never read is due anyway. */
  private dueBy(repo: string, until: number): void {
    const entry = this.entries.get(repo);
    if (entry === undefined) return;
    if (entry.dueAt === null || until < entry.dueAt) entry.dueAt = until;
  }

  /**
   * A failed GitHub answer → the write's refusal. A limit (`failureVerdict`'s rule, the poller's one, unchanged) is `429` and puts `pool` — the one the
   * failed call spent — to sleep through `noteSleep` — ruling R4: the PR-cache entry, created empty when none exists, and the poller's repo too for a
   * secondary limit — so the next request from that pool makes none until it ends. A `401`/`403` that is not a limit is a token without the permission this write needs: a fine-grained token's
   * write permissions cannot be read back, so this is where a person learns it, from GitHub's own message. GitHub refusing the write on its merits — REST's
   * `405`/`409`/`422`, or a typed GraphQL error on a `200` — is `409` with GitHub's text. Anything else (a 5xx, a transport failure, a 404) is `502`.
   */
  private refusal(repo: string, res: GithubResponse<unknown>, now: number, pool: PrPool): PrWriteRefusal {
    const message = res.error ?? `HTTP ${res.status}`;
    const verdict = failureVerdict(res, now);
    if (verdict !== null && verdict.sleepUntil !== null) {
      this.noteSleep(repo, verdict, pool);
      return { ok: false, status: 429, error: verdict.detail ?? message };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, status: 502, error: `the token lacks permission for this — ${message}` };
    if (res.status === 405 || res.status === 409 || res.status === 422 || (res.status === 200 && res.error !== null)) {
      return { ok: false, status: 409, error: message };
    }
    return { ok: false, status: 502, error: message };
  }

  /**
   * The write's own single-PR read, spliced into the cache — the PR's row when it is open, its removal when it is merged or closed. `null` when the read
   * failed, which no write turns into an error (the write has landed or been refused already; the answer says `reread: false`). A limit met here still
   * sleeps the repo's `graphql` pool, the one the read spent.
   */
  private async reread(repo: string, number: number, token: string, now: number): Promise<PullOne | null> {
    const res = await readPull(this.client, repo, number, { token });
    if (!succeeded(res) || res.data === null) {
      const verdict = failureVerdict(res, now);
      if (verdict !== null) this.noteSleep(repo, verdict, 'graphql');
      return null;
    }
    this.splice(repo, openRow(res.data), number);
    return res.data;
  }

  /**
   * Run `fn` after every write already queued for this `<repo>#<number>` — `GithubSource.serialise`'s shape. The chain survives a refusal (`then(fn, fn)`),
   * and the entry is dropped once it is the tail again, so the map holds only the PRs being written right now. Per PR, not per repo: a merge of #12 is never
   * queued behind a merge of #7.
   */
  private serialise<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  /** The sentence a write is refused with while `pool` is asleep on `repo`, or `null` when it is awake: the verdict of this cache's own sleep in that pool,
   *  then for `rest` the poller's own sentence, then the poller's secondary backoff (worded as `view` words it) for one only the poller met. */
  private asleepDetail(repo: string, now: number, pool: PrPool): string | null {
    const until = this.sleepingUntil(repo, now, pool);
    if (until === null) return null;
    const own = this.entries.get(repo)?.sleeps[pool];
    if (own != null && own.until > now && own.detail !== null) return own.detail;
    const rest = pool === 'rest' ? this.poller.restSleep(repo) : null;
    if (rest !== null && rest.detail !== null) return rest.detail;
    return `secondary rate limit — backing off until ${new Date(until).toISOString()}`;
  }

  /** Repo → its FIRST registered project's path, in registry order — the path `syncOffBlock` is asked about. Resolved per call, as everywhere else: a
   *  marker committed a second ago counts. Throws `registryProjectsOr503`'s 503 for a registry that cannot be read. */
  private registeredRepos(): Map<string, string> {
    const repos = new Map<string, string>();
    for (const project of registryProjectsOr503(this.registry)) {
      const resolved = resolveSource(project.path, KNOWN);
      if (resolved.kind !== 'tracker') continue;
      const repo = resolved.marker.repo;
      if (isRepo(repo) && !repos.has(repo)) repos.set(repo, project.path);
    }
    return repos;
  }

  /** Read `repo` unless its entry is fresh or it is asleep; join the read already in flight when there is one. Fresh is "inside the TTL and not past a
   *  `dueAt`". */
  private refresh(repo: string, now: number, token: string): Promise<void> {
    const entry = this.entries.get(repo);
    const last = Math.max(entry?.polledAt ?? -Infinity, entry?.attemptedAt ?? -Infinity);
    const due = entry?.dueAt != null && now >= entry.dueAt;
    if (now - last < PR_TTL_MS && !due) return Promise.resolve();
    if (this.sleepingUntil(repo, now, 'graphql') !== null) return Promise.resolve();
    const inFlight = this.reading.get(repo);
    if (inFlight !== undefined) return inFlight;
    const read = this.read(repo, now, token).finally(() => this.reading.delete(repo));
    this.reading.set(repo, read);
    return read;
  }

  private async read(repo: string, now: number, token: string): Promise<void> {
    const splices = this.entries.get(repo)?.splices ?? 0;
    const res = await readPullList(this.client, repo, { token });
    const entry = this.entryOf(repo);
    entry.attemptedAt = now;
    // A read that started at or after the due time answers it; one that started before (a `dueAt` set while it was out) does not — its answer predates
    // the update it was meant to see. It is answered by a read that FAILED (retrying a failing repo on every GET is what the TTL exists to stop) or one
    // whose rows were stored — never by one dropped for a splice below, which leaves the page holding the pre-update head it was due to replace.
    const answersDue = entry.dueAt !== null && entry.dueAt <= now;
    const verdict = failureVerdict(res, now);
    if (verdict !== null || res.data === null) {
      if (answersDue) entry.dueAt = null;
      // `data` null on a 2xx cannot happen through `readPullList` (it maps a missing repository to a 404) — counted as an error rather than trusted.
      const v = verdict ?? { access: 'error' as const, detail: res.error ?? 'empty answer from GitHub', sleepUntil: null, secondary: false };
      entry.access = v.access;
      entry.detail = v.detail;
      this.noteSleep(repo, v, 'graphql');
      return;
    }
    const list = res.data;
    // A GraphQL sleep set while this read was out (a write's limit, R4) is still ahead and still the list's state; only one that has run out is cleared.
    // A `rest` sleep is left alone either way: this read spent nothing from that pool, so its success refutes nothing there.
    const graphql = entry.sleeps.graphql;
    if (graphql === null || graphql.until <= now) {
      entry.sleeps.graphql = null;
      entry.access = 'ok';
      entry.detail = null;
    }
    // The repo's merge settings are not something a splice touches, so they are taken either way.
    const allowed: Record<MergeMethod, boolean> = { squash: list.squashMergeAllowed, merge: list.mergeCommitAllowed, rebase: list.rebaseMergeAllowed };
    entry.methods = MERGE_METHODS.filter((m) => allowed[m]);
    entry.autoMergeAllowed = list.autoMergeAllowed;
    // A write spliced this repo while the read was out: its rows predate that write, so they are dropped and `polledAt` — the age of the rows held —
    // stays where it was. The attempt above still counts, so the next read waits the TTL like any other.
    if (entry.splices !== splices) return;
    if (answersDue) entry.dueAt = null;
    entry.polledAt = now;
    entry.prs = list.rows;
    entry.total = list.totalCount;
  }

  /** The latest of this cache's own sleep in `pool`, the poller's secondary one and — for `rest` only — the poller's own REST sleep, when any is still
   *  ahead of `now`; else `null`. */
  private sleepingUntil(repo: string, now: number, pool: PrPool): number | null {
    const own = this.entries.get(repo)?.sleeps[pool]?.until ?? null;
    const shared = this.poller.secondaryUntil(repo);
    const rest = pool === 'rest' ? (this.poller.restSleep(repo)?.until ?? null) : null;
    const until = Math.max(own ?? 0, shared ?? 0, rest ?? 0);
    return until > now ? until : null;
  }

  private entryOf(repo: string): PrEntry {
    let entry = this.entries.get(repo);
    if (entry === undefined) {
      entry = {
        polledAt: null,
        attemptedAt: null,
        access: 'ok',
        detail: null,
        sleeps: { rest: null, graphql: null },
        dueAt: null,
        splices: 0,
        prs: [],
        total: 0,
        methods: [],
        autoMergeAllowed: false
      };
      this.entries.set(repo, entry);
    }
    return entry;
  }

  private view(repo: string, path: string, now: number): PrRepoView {
    const entry = this.entries.get(repo);
    let access: Access = entry?.access ?? 'ok';
    let detail = entry?.detail ?? null;
    // A sleep the poller noted and this cache never met has no verdict on the entry; it is still why no request was made, so it is what the row says.
    const shared = this.poller.secondaryUntil(repo);
    const ownAhead = entry?.sleeps.graphql != null && entry.sleeps.graphql.until > now;
    if (!ownAhead && shared !== null && shared > now) {
      access = 'rate-limited';
      detail = `secondary rate limit — backing off until ${new Date(shared).toISOString()}`;
    }
    const prs = entry?.prs ?? [];
    const total = entry?.total ?? 0;
    return {
      repo,
      polledAt: entry?.polledAt == null ? null : new Date(entry.polledAt).toISOString(),
      access,
      detail,
      syncOff: this.poller.syncOffBlock(path),
      methods: entry?.methods ?? [],
      autoMergeAllowed: entry?.autoMergeAllowed ?? false,
      prs: [...prs],
      total,
      truncated: total > prs.length
    };
  }
}
