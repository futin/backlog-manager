import { Injectable } from '@nestjs/common';

import { GithubClient, isRepo } from './github.client';
import { TrackerPollerService, failureVerdict, type Access, type FailureVerdict } from './poller.service';
import { readPullList } from './pulls.query';
import { githubToken } from './token.util';
import { resolveSource } from '../items/sources/resolve.util';
import { RegistryService, registryProjectsOr503 } from '../registry/registry.service';
import { MERGE_METHODS, type MergeMethod, type PrRepoView, type PullRequestRow, type PullRequestsPayload } from '../../../shared/types';

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
 * ## Rate limits
 *
 * Values, never sleeps inside a request. An hourly-limit verdict puts this repo's ENTRY to sleep until the reset; GraphQL's primary budget is a separate pool
 * from REST's, so it does not touch the issue poller. A secondary verdict is shared — GitHub counts it per token, across both APIs — so it also goes to
 * `poller.noteSecondary`, and the poller's own `secondaryUntil` is read here before a request, which is the other direction of the same sharing. A repo
 * asleep either way is served from its entry (or an empty view) with the sleep as `detail`, and gets no request.
 *
 * ## One view per repo
 *
 * Keyed by repo, never by project: two checkouts of one repo are one list on GitHub. `syncOff` is resolved through the FIRST registered project on the repo,
 * because `syncOffBlock` is keyed by project path and is the one home of its sentence; sync is per repo, so every checkout answers the same.
 */

/** How long a successful read is served before the next `list()` re-reads it — the page's own poll period, so a page open alone costs one query per minute
 *  per repo and a second tab costs nothing. */
export const PR_TTL_MS = 60_000;

/** One repo's cached state. Created by the first read or the first sleep (`noteSleep`), whichever comes first. */
interface PrEntry {
  /** Epoch ms of the last SUCCESSFUL read; `null` before one. */
  polledAt: number | null;
  access: Access;
  detail: string | null;
  /** Epoch ms before which this repo gets no PR request — a rate limit's reset or a secondary backoff this cache met itself. */
  sleepUntil: number | null;
  prs: PullRequestRow[];
  total: number;
  methods: MergeMethod[];
  autoMergeAllowed: boolean;
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

    // Repo → its first registered project's path, in registry order. Resolved per call, as everywhere else: a marker committed a second ago counts.
    const repos = new Map<string, string>();
    for (const project of registryProjectsOr503(this.registry)) {
      const resolved = resolveSource(project.path, KNOWN);
      if (resolved.kind !== 'tracker') continue;
      const repo = resolved.marker.repo;
      if (isRepo(repo) && !repos.has(repo)) repos.set(repo, project.path);
    }

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
   * when absent, or — `row` null, the re-read said `MERGED` or `CLOSED` — remove it. `total` follows an add or a removal so `truncated` stays true to the
   * list; `polledAt` does NOT move, because it is the age of the list read and a splice re-read one row. A repo with no successful read yet is left alone:
   * one row would draw as the whole list.
   */
  splice(repo: string, row: PullRequestRow | null, number: number): void {
    const entry = this.entries.get(repo);
    if (entry === undefined || entry.polledAt === null) return;
    const at = entry.prs.findIndex((p) => p.number === number);
    if (row === null) {
      if (at === -1) return;
      entry.prs.splice(at, 1);
      entry.total = Math.max(0, entry.total - 1);
      return;
    }
    if (at === -1) {
      entry.prs.push(row);
      entry.total += 1;
    } else {
      entry.prs[at] = row;
    }
    entry.prs.sort(byUpdatedDesc);
  }

  /**
   * Apply a limit verdict to a repo's entry — creating an empty, never-read entry when there is none (ruling R4: a write can meet a limit before any list
   * read did, and the sleep must not be lost to that ordering). A verdict that is not a limit is ignored here: a write's 409 or 422 is that write's answer,
   * not the repo's connection state. Never shortens a sleep already set. A secondary verdict also sleeps the issue poller's repo.
   */
  noteSleep(repo: string, verdict: FailureVerdict): void {
    if (verdict.sleepUntil === null) return;
    const entry = this.entryOf(repo);
    entry.access = verdict.access;
    entry.detail = verdict.detail;
    if (entry.sleepUntil === null || verdict.sleepUntil > entry.sleepUntil) entry.sleepUntil = verdict.sleepUntil;
    if (verdict.secondary) this.poller.noteSecondary(repo, verdict.sleepUntil);
  }

  /** Read `repo` unless its entry is fresh or it is asleep; join the read already in flight when there is one. */
  private refresh(repo: string, now: number, token: string): Promise<void> {
    const entry = this.entries.get(repo);
    if (entry?.polledAt != null && now - entry.polledAt < PR_TTL_MS) return Promise.resolve();
    if (this.sleepingUntil(repo, now) !== null) return Promise.resolve();
    const inFlight = this.reading.get(repo);
    if (inFlight !== undefined) return inFlight;
    const read = this.read(repo, now, token).finally(() => this.reading.delete(repo));
    this.reading.set(repo, read);
    return read;
  }

  private async read(repo: string, now: number, token: string): Promise<void> {
    const res = await readPullList(this.client, repo, { token });
    const entry = this.entryOf(repo);
    const verdict = failureVerdict(res, now);
    if (verdict !== null || res.data === null) {
      // `data` null on a 2xx cannot happen through `readPullList` (it maps a missing repository to a 404) — counted as an error rather than trusted.
      const v = verdict ?? { access: 'error' as const, detail: res.error ?? 'empty answer from GitHub', sleepUntil: null, secondary: false };
      entry.access = v.access;
      entry.detail = v.detail;
      this.noteSleep(repo, v);
      return;
    }
    const list = res.data;
    entry.polledAt = now;
    entry.access = 'ok';
    entry.detail = null;
    entry.sleepUntil = null;
    entry.prs = list.rows;
    entry.total = list.totalCount;
    const allowed: Record<MergeMethod, boolean> = { squash: list.squashMergeAllowed, merge: list.mergeCommitAllowed, rebase: list.rebaseMergeAllowed };
    entry.methods = MERGE_METHODS.filter((m) => allowed[m]);
    entry.autoMergeAllowed = list.autoMergeAllowed;
  }

  /** The later of this cache's own sleep and the poller's secondary one, when either is still ahead of `now`; else `null`. */
  private sleepingUntil(repo: string, now: number): number | null {
    const own = this.entries.get(repo)?.sleepUntil ?? null;
    const shared = this.poller.secondaryUntil(repo);
    const until = Math.max(own ?? 0, shared ?? 0);
    return until > now ? until : null;
  }

  private entryOf(repo: string): PrEntry {
    let entry = this.entries.get(repo);
    if (entry === undefined) {
      entry = { polledAt: null, access: 'ok', detail: null, sleepUntil: null, prs: [], total: 0, methods: [], autoMergeAllowed: false };
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
    const ownAhead = entry?.sleepUntil != null && entry.sleepUntil > now;
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
