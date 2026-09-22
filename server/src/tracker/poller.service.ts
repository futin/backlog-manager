import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { claimsByIssue } from './claim';
import { GithubClient, isRepo, type GithubComment, type GithubIssue } from './github.client';
import { TRACKER_LABELS, TRACKER_LABEL_NAMES } from './labels';
import { githubToken } from './token.util';
import { resolveSource } from '../items/sources/resolve.util';
import { RegistryService } from '../registry/registry.service';
import type { SourceSummary } from '../items/sources/source';

/**
 * poller.service.ts — the tracker's read loop (task-45, spec §5.1).
 *
 * This is the SECOND outbound-calling module in this server; `agents/` was the
 * first and was the only one until this file landed. CLAUDE.md's Layout
 * section said so and was corrected in the same commit — a layout line that
 * quietly stops being true is worse than none, because it is the line someone
 * greps to find out where the network calls are.
 *
 * ## Armed, idle, off — the watchdog's shape, for the same reasons
 *
 * A `setTimeout` chain, never a `setInterval`, and the reasoning in
 * `agents/watchdog.service.ts`'s header applies here verbatim and is not
 * repeated: the next tick is scheduled AFTER the current tick's awaits
 * complete, so two ticks can never overlap by construction, and a tick waiting
 * on a slow api.github.com can never be re-entered by its own successor with
 * two syncs racing for one repo's cache. The in-flight guard is the second,
 * independent belt for a caller that is not the timer.
 *
 * *Armed*: at least one registered project resolves to `github` AND a token is
 * present. *Off/idle*: neither, or either missing — the chain disarms on the
 * tick that finds it. A standing interval against a registry where nobody has
 * connected anything is precisely the cost the watchdog's rule exists to
 * refuse, and this loop would make HTTP requests rather than directory reads.
 *
 * ## The cache, and why this one is allowed to exist
 *
 * **In memory, per repo, lost on restart, rebuilt by the first sync.** This is
 * the one cache in the server whose AGE IS A RENDERED VALUE: `polledAt`
 * travels in `ProjectSummary` and the board draws it (spec §5.5). It exists
 * because GitHub's hourly rate limit makes a per-request fetch impossible —
 * one board render would be one request per project — and its age being
 * visible on the board is what keeps it honest.
 *
 * The registry's "re-read per request, never cache" rule is UNTOUCHED, and so
 * is `resolveSource`'s. This poller re-reads both on every tick; what it keeps
 * is the ISSUES, which are the one thing here that lives behind a network call
 * with a budget.
 */

/** One poll every fifteen seconds (spec §5.1). One named constant, one home:
 *  the budget arithmetic in the spec — four repos at two requests per tick,
 *  1,920 an hour before `304`s against a 5,000 limit — is arithmetic over THIS
 *  number, so a second copy of it would make the spec wrong somewhere. */
export const TRACKER_POLL_MS = 15_000;

/** A secondary (abuse) limit is not the hourly one and does not carry a reset:
 *  GitHub's own guidance is to wait at least a minute (spec §5.1). */
export const SECONDARY_BACKOFF_MS = 60_000;

/**
 * How young a cached comment has to be for the per-issue reconcile to keep it
 * when GitHub's list of that issue's comments does not show it (bug-55).
 *
 * GitHub's comment listing is eventually consistent — it is why the claim
 * protocol lists twice and unions the two — so a claim this process
 * `absorbComment`-ed a second ago can legitimately be absent from a list made
 * now, and dropping it would draw an item as free while a session holds it.
 * Not the protocol's one-second `settleMs`: that is how long one machine waits
 * between two of ITS OWN reads, whereas this compares a GitHub-stamped
 * `created_at` against THIS machine's clock, so it has to absorb clock skew as
 * well as replication lag. Ten seconds is under one poll interval, so a
 * genuinely deleted young comment is kept for at most one extra tick.
 */
export const RECONCILE_GRACE_MS = 10_000;

/** The connection state of one repo, as `ProjectSummary.access` spells it. */
export type Access = NonNullable<SourceSummary['access']>;

/** Everything this process knows about one connected repo. Per repo rather
 *  than per project on purpose: two registered projects can be two checkouts
 *  of one repo, and polling it twice would spend twice the budget to learn the
 *  same thing. */
interface RepoState {
  /** Issues by number — the cache proper. A `Map` so `since`'s inclusive
   *  re-send is an upsert rather than a duplicate (spec §5.1). */
  issues: Map<number, GithubIssue>;
  /** Comments by id. Written since phase 2; read since task-46 by `comments()`
   *  below, which is what the claim protocol maps an item's `started`/`phase`
   *  and counters from.
   *
   *  Filled by the repository-wide `since` read, which can ADD and EDIT but
   *  never delete: a deleted comment is simply not mentioned by any later
   *  response. Deletions reach this map two ways — `forgetComment`, for the
   *  loser THIS process deleted, and the per-issue reconcile in `syncRepo`,
   *  for every other machine's (bug-55). */
  comments: Map<number, GithubComment>;
  /** The newest issue `updated_at` seen, sent as the next ISSUES poll's
   *  `since`. `null` before the first sync, which is what makes that sync a
   *  full one. */
  hwm: string | null;
  /**
   * The same thing for COMMENTS, and a separate field rather than a reuse of
   * `hwm` — which is the bug task-46's review caught (Critical).
   *
   * `syncRepo` reads issues first, and `absorbIssues` moves `hwm` to the newest
   * issue's `updated_at` BEFORE the comments request is made. Sending that as
   * the comments `since` asks for "every comment at or after the single most
   * recently touched issue's timestamp", which on a fresh process silently
   * excludes every claim comment older than that — and no later response ever
   * mentions an unedited comment again, so the gap never closes. Two readers
   * added by task-46 rest on this cache (`claimsByIssue` for the board's
   * `started`/`phase`, and `readClaim` for `backlog.mjs stop`), so the item
   * looked FREE after any restart while a session held it.
   *
   * The two streams have independent clocks and now have independent marks:
   * this one moves only from what the comments responses themselves return.
   */
  commentsHwm: string | null;
  issuesEtag: string | null;
  commentsEtag: string | null;
  /**
   * The per-issue reconcile's memory (bug-55): for each issue it re-checked on
   * the last tick, the ETag of that issue's comment list and the ids the list
   * held. The ids are what make a `304` usable rather than merely cheap — it
   * means "the list is still exactly THIS", so the reconcile runs against the
   * remembered list instead of being skipped, and a comment the cache gained
   * from elsewhere since (a grace-kept one, or one the repo-wide read caught
   * between its creation and its deletion) is still judged against it.
   *
   * Pruned every tick to the issues being re-checked, so an issue whose last
   * unreleased claim is gone costs neither a request nor an entry.
   */
  issueChecks: Map<number, { etag: string | null; ids: ReadonlySet<number> }>;
  polledAt: string | null;
  access: Access;
  detail: string | null;
  /** The label bootstrap has run to completion once. */
  labelsEnsured: boolean;
  /** Epoch ms before which this repo gets no requests at all — a rate limit's
   *  reset, or a secondary limit's backoff. */
  sleepUntil: number | null;
}

@Injectable()
export class TrackerPollerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private readonly repos = new Map<string, RepoState>();

  /**
   * The authenticated login, for the Trackers card's platform row, and the
   * token it was read with. Fetched at most ONCE per token per process, inside
   * a sweep that already holds the credential — not per card render, which
   * would spend a request of the hourly budget every time someone opened
   * Settings. Keeping the token beside it is what makes "the token changed"
   * detectable without storing a second copy of the answer: the pair is
   * replaced together or not at all.
   *
   * The token in this field never leaves the process, exactly like the one in
   * the environment: `platform()` below returns the LOGIN and a boolean, never
   * the value (spec §11).
   */
  private identity: { token: string; login: string | null } | null = null;

  constructor(
    private readonly registry: RegistryService,
    private readonly client: GithubClient
  ) {}

  /** A tick is scheduled. False while idle and — briefly — inside a tick,
   *  which has already cleared its own timer and not yet made the next one.
   *  Derived from the timer rather than tracked separately, for the reason
   *  the watchdog gives: two sources of truth for "is a tick coming" is how a
   *  disarmed loop ends up still reporting armed. */
  get armed(): boolean {
    return this.timer !== null;
  }

  onApplicationBootstrap(): void {
    this.arm();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.disarm();
  }

  /**
   * Start the chain, or confirm it is already running. Idempotent in both
   * directions, like the watchdog's: every caller is a "something might be
   * connected now" signal rather than a command — the bootstrap hook, and the
   * GitHub adapter on every `list`, which is reached exactly when a project
   * resolved to `github` and so is the cheapest honest trigger there is. A
   * repo connected after this process booted is polled from the first board
   * read that touches it, with no restart.
   */
  arm(): void {
    if (this.stopped) return;
    if (!this.shouldPoll()) {
      this.clearTimer();
      return;
    }
    // A pending timer OR a tick mid-flight both mean the chain is alive: a
    // tick clears its own timer on entry, so checking the timer alone would
    // let a concurrent `arm()` start a second chain in that window.
    if (this.timer !== null || this.inFlight !== null) return;
    void this.tick();
  }

  disarm(): void {
    this.clearTimer();
  }

  /**
   * One sweep. Returns the IN-FLIGHT promise when one exists rather than
   * starting a second — a caller awaiting `tick()` is asking "has a sweep
   * including right now finished", and the sweep already running is the
   * honest answer.
   */
  tick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const running = this.sweep().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  /**
   * What the Trackers card draws in its platform row (spec §5.6): whether a
   * token is configured, who it authenticates as, and how much of the hourly
   * budget is left. **Never the token itself** — this is the payload the
   * browser receives, and the credential is process-only.
   *
   * Every field but `token` may be `null` before the first sweep: nothing here
   * is worth a request of its own on a machine where nobody has connected
   * anything.
   */
  platform(): { token: boolean; login: string | null; rate: { limit: number | null; remaining: number | null; reset: number | null } } {
    const token = githubToken();
    return {
      token: token !== null,
      login: this.identity !== null && this.identity.token === token ? this.identity.login : null,
      rate: this.client.rate
    };
  }

  /**
   * The authenticated login, fetching it once if this process has not got one
   * for this token yet (task-46) — what the claim protocol assigns an issue to.
   *
   * Reuses the SAME `identity` field the sweep fills, deliberately: the login
   * is "who does this token authenticate as", a question with one answer per
   * token per process, and a second cache of it would be a second thing to
   * invalidate when `BM_GITHUB_TOKEN` changes. A claim made before the first
   * sweep (a fresh process, someone's first `start`) pays one request for it;
   * every claim after that pays none.
   *
   * `null` when the credential cannot be read back. The protocol treats that as
   * "no assignee to set" and carries on: the claim comment is the claim, and
   * the assignee is a courtesy to a person looking at the issue in the web UI.
   */
  async viewerLogin(token: string): Promise<string | null> {
    if (this.identity !== null && this.identity.token === token) return this.identity.login;
    const viewer = await this.client.viewer(token);
    this.identity = { token, login: viewer.data?.login ?? null };
    return this.identity.login;
  }

  /** Every cached issue of one repo, in ascending issue number so the board's
   *  order is a property of the data rather than of the order GitHub answered
   *  in. Empty for a repo that has never synced — which renders as a project
   *  with no items and a `polledAt` of `null` saying why. */
  issues(repo: string): GithubIssue[] {
    const state = this.repos.get(repo);
    if (state === undefined) return [];
    return [...state.issues.values()].sort((a, b) => a.number - b.number);
  }

  /** One cached issue, or `undefined` — the body route's whole lookup. */
  issue(repo: string, number: number): GithubIssue | undefined {
    return this.repos.get(repo)?.issues.get(number);
  }

  /**
   * Every cached comment of one repo (task-46) — the claim protocol's read on
   * the BOARD path, where a per-issue fetch is out of the question: one board
   * render touches every issue of every connected project, and the hourly rate
   * limit would be gone in a minute. `claimsFor` filters this repository-wide
   * bag down to one issue's claims.
   *
   * This is what phase 2's otherwise-unread `comments()` call was for, and it
   * is why that call was made a phase before it had a reader: the polling
   * loop's shape, its budget and its tests were settled without the claim
   * protocol also being new in the same commit.
   *
   * The PROTOCOL itself does not read this — it reads the network, fresh,
   * because a claim posted a second ago has to be visible to the session
   * deciding who won. This accessor is for rendering, where up-to-one-poll-old
   * is the price `polledAt` already advertises.
   */
  comments(repo: string): Iterable<GithubComment> {
    const state = this.repos.get(repo);
    return state === undefined ? [] : state.comments.values();
  }

  /**
   * Take one issue straight off a write's response into the cache (task-46,
   * §6.2's "absorption").
   *
   * Without this a capture would not appear on the board until the next poll —
   * up to fifteen seconds of a person watching an issue they just filed not
   * exist. With it, the very next `GET /api/items` lists it.
   *
   * Shares `absorbIssues`' rules rather than restating them: pull requests are
   * dropped (the one write that could ever hand one back is none of them, and
   * the rule costs a line) and the high-water mark moves, which matters because
   * the next poll sends it as `since` — an absorbed issue whose `updated_at` is
   * newer than the mark would otherwise pull the whole window back on the next
   * request.
   *
   * `polledAt` is deliberately NOT moved: nothing was polled. The board's age
   * line answers "when did we last read this repo", and a write is not a read —
   * moving it would report a freshness the other 99 issues in the cache do not
   * have.
   */
  absorbIssue(repo: string, issue: GithubIssue): void {
    this.absorbIssues(this.stateOf(repo), [issue]);
  }

  /** The comment half of the same absorption: a claim this process just posted
   *  or edited is in the cache before the request that made it returns, so the
   *  next board read maps the item as claimed. Keyed by comment id, so an edit
   *  replaces rather than duplicates — the same upsert `syncRepo` does. */
  absorbComment(repo: string, comment: GithubComment): void {
    this.stateOf(repo).comments.set(comment.id, comment);
  }

  /**
   * Drop one comment from the cache — the deletion half, for the ONE thing the
   * protocol deletes: a claim that lost the race, seconds after posting it.
   *
   * The poller's repository-wide comment read is conditional and incremental
   * (`since` plus an ETag), so a comment that no longer exists is never
   * mentioned again by any later response. The per-issue reconcile in
   * `syncRepo` catches that within a tick for ANY deletion — including a loser
   * deleted by another machine's server, which never reaches this method
   * (bug-55) — so this is no longer the only thing standing between a deleted
   * claim and a permanent ghost. It stays as the zero-latency path for the
   * deletion this process made itself: the next board read is right at once,
   * not after the next poll.
   */
  forgetComment(repo: string, commentId: number): void {
    this.repos.get(repo)?.comments.delete(commentId);
  }

  /**
   * The four connection fields for one repo (spec §5.4). `access` reads
   * `no-token` whenever there is no token, whatever the last sync said: the
   * credential is read per call (see `token.util.ts`), so removing it from the
   * environment and restarting is immediately visible, and a stale `ok` from
   * before it was removed would be a lie the card renders.
   */
  summary(repo: string): SourceSummary {
    const state = this.repos.get(repo);
    if (githubToken() === null) {
      return { repo, polledAt: state?.polledAt ?? null, access: 'no-token', detail: null };
    }
    // A repo with a token and no state yet has not failed at anything — it has
    // simply not been polled, which `polledAt: null` already says. `ok` here
    // is "nothing is wrong", not "we have read it".
    if (state === undefined) return { repo, polledAt: null, access: 'ok', detail: null };
    return { repo, polledAt: state.polledAt, access: state.access, detail: state.detail };
  }

  /** The repos the registry currently resolves to `github`, de-duplicated.
   *  Re-read per call, never remembered: both the registry and each project's
   *  marker are per-request reads everywhere else in this server, and a poller
   *  holding the only stale copy of them would poll a repo nobody is connected
   *  to any more. */
  connectedRepos(): string[] {
    const seen = new Set<string>();
    for (const project of this.registry.load().projects) {
      const resolved = resolveSource(project.path, KNOWN);
      if (resolved.kind !== 'tracker') continue;
      const repo = resolved.marker.repo;
      if (isRepo(repo)) seen.add(repo);
    }
    return [...seen];
  }

  /**
   * Whether `arm()` should start a chain at all — a cheap early-out, not the
   * rule. The RULE is enforced in `sweep()`, which reads both halves fresh at
   * the top of EVERY tick and returns without scheduling a successor when
   * either is missing; that is what disarms a chain when the token is removed
   * or the last connected project is unregistered, and it is the check
   * `test/tracker-poll.test.ts`'s four arming cases drive. (Within one tick
   * the pair is read once, before the awaits, and deliberately not re-read
   * afterwards: a token removed mid-tick costs at most the requests of the
   * tick already in flight, and the next tick — which cannot start before
   * this one finishes — sees it.) This early-out only saves kicking off a
   * tick that would immediately discover it has nothing to do.
   */
  private shouldPoll(): boolean {
    return githubToken() !== null && this.connectedRepos().length > 0;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) return;
    // `unref()` so a pending poll never keeps the process alive on its own —
    // the same treatment the watchdog's timer gets, and the reason a test that
    // forgets to shut the module down still exits.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, TRACKER_POLL_MS);
    this.timer.unref?.();
  }

  private async sweep(): Promise<void> {
    // Consumed by this tick, before any await, so `armed` cannot read true for
    // a chain whose next link this tick has not created yet.
    this.clearTimer();

    const token = githubToken();
    const repos = this.connectedRepos();
    // Disarmed the tick that finds either half missing (spec §5.1): no token,
    // nothing connected, or both. Nothing below may run without a token — this
    // is the loop's whole "off" state.
    if (token === null || repos.length === 0) return;

    // Once per token per process — see `identity` above. A failed read stores
    // `login: null` against the same token rather than retrying every tick:
    // the login is a nicety on a settings card, and the access states the card
    // shows beside it already report a credential that cannot be used.
    if (this.identity === null || this.identity.token !== token) {
      const viewer = await this.client.viewer(token);
      this.identity = { token, login: viewer.data?.login ?? null };
    }

    for (const repo of repos) {
      await this.syncRepo(repo, token);
    }

    this.schedule();
  }

  private stateOf(repo: string): RepoState {
    let state = this.repos.get(repo);
    if (state === undefined) {
      state = {
        issues: new Map(),
        comments: new Map(),
        hwm: null,
        commentsHwm: null,
        issuesEtag: null,
        commentsEtag: null,
        issueChecks: new Map(),
        polledAt: null,
        access: 'ok',
        detail: null,
        labelsEnsured: false,
        sleepUntil: null
      };
      this.repos.set(repo, state);
    }
    return state;
  }

  private async syncRepo(repo: string, token: string): Promise<void> {
    const state = this.stateOf(repo);

    // Asleep under a rate limit: no request at all, not even a conditional
    // one. A `304` is free against the budget but a 403 is not, and asking
    // again before the reset is how an app earns a secondary limit on top of
    // the one it already has.
    if (state.sleepUntil !== null && Date.now() < state.sleepUntil) return;
    state.sleepUntil = null;

    const first = await this.client.issues(repo, { token, since: state.hwm, etag: state.issuesEtag });
    if (this.handleFailure(state, first)) return;

    if (first.status === 304) {
      // Nothing changed, so the CACHE stays exactly as it was — and `polledAt`
      // moves anyway, because the age the board renders means "since we last
      // successfully checked", not "how old these items are". A conditional
      // request that came back `304` IS a successful check: it proves the repo
      // is reachable, the token works, and nothing has changed since. Freezing
      // the age on a repo nobody is editing would make a healthy connection
      // look progressively more broken, which is the opposite of what the
      // rendered age exists to tell an operator.
      //
      // Task-45 shipped the other reading — its authoritative test case said
      // the cache AND `polledAt` both stay put, disagreeing with spec §12.2 —
      // and recorded the disagreement for this phase to settle rather than
      // rediscover. Settled here, 2026-09-18, in the spec's favour (task-46).
      state.polledAt = new Date().toISOString();
      state.access = 'ok';
      state.detail = null;
    } else if (first.status === 200) {
      let page = first;
      // The first page's ETag is the one worth keeping: it belongs to the URL
      // this poller will re-request next tick. A later page's ETag names a URL
      // nobody asks for twice.
      state.issuesEtag = first.etag;
      for (;;) {
        this.absorbIssues(state, page.data ?? []);
        if (page.next === null) break;
        const nextPage = await this.client.page<GithubIssue[]>(page.next, { token });
        if (this.handleFailure(state, nextPage)) return;
        if (nextPage.status !== 200) break;
        page = nextPage;
      }
      state.polledAt = new Date().toISOString();
      state.access = 'ok';
      state.detail = null;
    }

    // Made on EVERY tick that got past the issues read, including a 304 one
    // (spec §5.1). It had no reader at all in phase 2, deliberately: skipping
    // it while it had none would have moved the polling loop's shape, its
    // budget and its tests into the phase that also introduced the claim
    // protocol they feed. Since task-46 `comments()` reads this cache, and the
    // loop itself did not have to change.
    // `commentsHwm`, never `hwm` — see that field for the incident. And
    // PAGINATED to the end, exactly as the issues loop above is: a repo with
    // more than a hundred comments newer than the mark would otherwise land
    // only its first page, and the claim the CLI needs is as likely to be on
    // the second as on the first.
    const comments = await this.client.comments(repo, { token, since: state.commentsHwm, etag: state.commentsEtag });
    if (this.handleFailure(state, comments)) return;
    if (comments.status === 200) {
      state.commentsEtag = comments.etag;
      let page = comments;
      for (;;) {
        this.absorbComments(state, page.data ?? []);
        if (page.next === null) break;
        const nextPage = await this.client.page<GithubComment[]>(page.next, { token });
        if (this.handleFailure(state, nextPage)) return;
        if (nextPage.status !== 200) break;
        page = nextPage;
      }
    }

    // Only once BOTH repo-wide reads succeeded (a failure returned above), so
    // the reconcile judges a cache that is as current as the repo-wide stream
    // can make it. It returns `false` when it hit a failure, which has already
    // been recorded as this repo's `access` — and a rate-limited repo must not
    // go on to spend requests on labels either.
    if (!(await this.reconcileClaimedIssues(repo, token, state))) return;

    // The bootstrap, after the first sync that proved the repo is readable
    // (spec §5.2). Phase 2's one write to GitHub.
    if (!state.labelsEnsured) await this.ensureLabels(repo, token, state);
  }

  /**
   * Re-read the comments of every issue the cache holds an UNRELEASED claim on,
   * and let that fresh list be the truth for that issue (bug-55).
   *
   * The repo-wide read above can never see a deletion — `since` returns what
   * was created or edited, and a deleted comment is neither — so a claim that
   * lost the race and was deleted by ANOTHER machine's server sat in this cache
   * for good: a phantom remote run, an `executing` card, and the answer
   * `readClaim` gave. Fixed here, in the one bag all three read, rather than in
   * each reader. A reader-side "ignore a claim with a lower live rival" was
   * weighed and rejected: once the winner releases, the ghost is the lowest
   * unreleased claim and is drawn as the holder again — and the cache itself
   * would still be wrong.
   *
   * **Cost.** Only issues with an unreleased claim are asked about, so a repo
   * with nothing running costs zero extra requests, and each re-check is
   * conditional on the last one's ETag, so a quiet held issue is a `304` —
   * which GitHub does not count against the hourly budget. The spec's
   * two-requests-per-tick arithmetic (`TRACKER_POLL_MS`) is therefore unchanged
   * for everything but the budget-free `304`s and the tick after a claim moves.
   *
   * **Absent means deleted — except when young.** A cached comment on the issue
   * that the list does not carry is dropped, unless its `created_at` is within
   * `RECONCILE_GRACE_MS` of the moment the request was sent: GitHub's listing
   * is eventually consistent, and a claim this process absorbed a second ago
   * may not be in a list made now.
   *
   * **Upsert without the mark.** Every listed comment is written into the
   * cache, as `absorbComments` does, but `commentsHwm` is NOT moved: it belongs
   * to the repo-wide stream alone, and the task-46 incident that field's doc
   * describes is exactly what a mark shared between two streams re-opens.
   *
   * Returns `false` on the first failed response — already recorded by
   * `handleFailure` — leaving that issue's cached comments untouched and asking
   * about no further issue this tick: a rate limit must not be hammered by the
   * remaining issues. A `404` is NOT a failure here: the issue was deleted or
   * transferred, so its comments are gone too, and it reconciles as an empty
   * list. (Every other `404` in this file means the REPO is unreadable, which
   * the repo-wide reads that just succeeded rule out.)
   */
  private async reconcileClaimedIssues(repo: string, token: string, state: RepoState): Promise<boolean> {
    const claimed: number[] = [];
    for (const [number, claims] of claimsByIssue(state.comments.values())) {
      if (claims.some((c) => c.record.released === undefined)) claimed.push(number);
    }
    claimed.sort((a, b) => a - b);
    for (const number of state.issueChecks.keys()) {
      if (!claimed.includes(number)) state.issueChecks.delete(number);
    }

    for (const number of claimed) {
      const prior = state.issueChecks.get(number);
      const sentAt = Date.now();
      const first = await this.client.issueComments(repo, number, { token, etag: prior?.etag ?? null });

      let listed: GithubComment[] = [];
      let check: { etag: string | null; ids: ReadonlySet<number> };
      if (first.status === 304) {
        // An ETag is only ever sent from a remembered check, so `prior` is
        // there; the guard is for the type, and skips rather than guesses.
        if (prior === undefined) continue;
        check = prior;
      } else if (first.status === 404) {
        check = { etag: null, ids: new Set() };
      } else {
        if (this.handleFailure(state, first)) return false;
        if (first.status !== 200) continue;
        // Paginated to the END before anything is deleted: a partial list
        // would read every comment on the unread pages as deleted.
        let page = first;
        let complete = true;
        for (;;) {
          if (Array.isArray(page.data)) listed.push(...page.data);
          if (page.next === null) break;
          const nextPage = await this.client.page<GithubComment[]>(page.next, { token });
          if (this.handleFailure(state, nextPage)) return false;
          if (nextPage.status !== 200) {
            complete = false;
            break;
          }
          page = nextPage;
        }
        if (!complete) continue;
        listed = listed.filter((c) => typeof c?.id === 'number');
        check = { etag: first.etag, ids: new Set(listed.map((c) => c.id)) };
      }

      // `claimsFor`'s membership rule — the `issue_url` SUFFIX, so #31 never
      // matches #310 — over every cached comment, claim or not: an attention
      // comment on a deleted issue is as gone as a claim on it.
      const suffix = `/issues/${number}`;
      const young = sentAt - RECONCILE_GRACE_MS;
      for (const comment of [...state.comments.values()]) {
        if (typeof comment.issue_url !== 'string' || !comment.issue_url.endsWith(suffix)) continue;
        if (check.ids.has(comment.id)) continue;
        // An unparseable `created_at` is NaN, and NaN is never young.
        if (Date.parse(comment.created_at) > young) continue;
        state.comments.delete(comment.id);
      }
      for (const comment of listed) state.comments.set(comment.id, comment);
      state.issueChecks.set(number, check);
    }
    return true;
  }

  /** Upsert by issue number, dropping pull requests, and move the high-water
   *  mark. `since` is INCLUSIVE, so the newest issue comes back on the next
   *  poll too — which is exactly why this is an upsert into a Map keyed by
   *  number and never an append. */
  private absorbIssues(state: RepoState, issues: GithubIssue[]): void {
    // See the comments read for why this is a guard and not a `?? []`.
    if (!Array.isArray(issues)) return;
    for (const issue of issues) {
      // The issues endpoint returns PRs as well. Dropped here as well as in
      // the mapper: here so the cache does not grow a copy of every PR in the
      // repo, there so no other reader of the cache has to remember.
      if (issue.pull_request !== undefined && issue.pull_request !== null) continue;
      state.issues.set(issue.number, issue);
      if (typeof issue.updated_at === 'string' && (state.hwm === null || issue.updated_at > state.hwm)) {
        state.hwm = issue.updated_at;
      }
    }
  }

  /**
   * Upsert by comment id and move the COMMENTS high-water mark — `absorbIssues`
   * one stream over, and separate for the reason `commentsHwm` gives.
   *
   * `Array.isArray` rather than a bare `?? []`, here as there: a 200 whose body
   * is not the array this endpoint documents (a proxy's error page, an API
   * change) would otherwise throw inside a `for…of`, and this code runs from a
   * timer chain where a throw is an unhandled rejection that kills the poll
   * loop rather than one bad tick. Every other failure in this file is a value
   * the board renders; this one must be too.
   */
  private absorbComments(state: RepoState, comments: GithubComment[]): void {
    if (!Array.isArray(comments)) return;
    for (const comment of comments) {
      state.comments.set(comment.id, comment);
      if (typeof comment.updated_at === 'string' && (state.commentsHwm === null || comment.updated_at > state.commentsHwm)) {
        state.commentsHwm = comment.updated_at;
      }
    }
  }

  /**
   * Turn a failed response into this repo's `access`/`detail`, and say whether
   * the caller should stop. One place for the whole mapping, because every
   * request in this file can fail the same six ways and six copies of the
   * branch is how one of them ends up reading `error` for a rate limit.
   */
  private handleFailure(state: RepoState, res: { status: number; error: string | null; retryAfter: number | null; secondary: boolean; rate: { remaining: number | null; reset: number | null } }): boolean {
    if (res.status === 200 || res.status === 304 || res.status === 201) return false;

    if (res.secondary) {
      state.sleepUntil = Date.now() + SECONDARY_BACKOFF_MS;
      state.access = 'rate-limited';
      state.detail = `secondary rate limit — backing off ${SECONDARY_BACKOFF_MS / 1000} s`;
      return true;
    }

    // The hourly limit, which GitHub signals as a 403 or a 429 with
    // `x-ratelimit-remaining: 0`, or with a `Retry-After`. Both are honoured:
    // `remaining` alone would miss a 429 that carries only the header, and
    // `retry-after` alone would miss the far more common 403.
    const limited = (res.status === 403 || res.status === 429) && (res.rate.remaining === 0 || res.retryAfter !== null);
    if (limited) {
      const resetMs = res.retryAfter !== null ? Date.now() + res.retryAfter * 1000 : res.rate.reset !== null ? res.rate.reset * 1000 : Date.now() + SECONDARY_BACKOFF_MS;
      state.sleepUntil = resetMs;
      state.access = 'rate-limited';
      // The reset TIME, not a duration: the card is read minutes after the
      // fact as often as seconds after it, and "resets 14:32" stays true while
      // "in 47 s" goes stale the moment it is drawn.
      state.detail = `rate limit reached — resets ${new Date(resetMs).toISOString()}`;
      return true;
    }

    // 401 sits with 403 deliberately: both mean "this credential cannot do
    // this", which is one thing to fix (the token) rather than two.
    if (res.status === 401 || res.status === 403) {
      state.access = 'forbidden';
      state.detail = res.error;
      return true;
    }
    if (res.status === 404) {
      // GitHub answers 404 for a repo that does not exist AND for one the
      // token cannot see — deliberately, so a private repo's existence is not
      // disclosed. This app cannot tell them apart either, and says so in one
      // state rather than guessing.
      state.access = 'not-found';
      state.detail = res.error;
      return true;
    }
    state.access = 'error';
    state.detail = res.error ?? `HTTP ${res.status}`;
    return true;
  }

  /**
   * Create whichever of the eight labels (spec §5.2) the repo is missing, once
   * per repo per process. Idempotent twice over: only the missing ones are
   * created, and a 422 from a create — another machine's poller won the race —
   * counts as success, because the label exists either way and that is the
   * whole claim being made.
   *
   * A failure here does NOT set `access`: the repo is readable (a sync just
   * proved it) and the board should render its items rather than an error
   * about a label. The flag simply stays down and the next tick tries again.
   */
  private async ensureLabels(repo: string, token: string, state: RepoState): Promise<void> {
    const listed = await this.client.labels(repo, { token });
    // `Array.isArray`, not `!== null`, for the reason the issues and comments
    // reads above give: this runs from the timer chain, where a throw is an
    // unhandled rejection that kills the poll loop rather than one bad tick.
    // A 200 whose body is valid JSON but not an array is the only way to get
    // here with something unmappable (a non-JSON body already leaves `data`
    // null, since the client's own `JSON.parse` catch handles it) — unlikely,
    // and cheaper to rule out than to reason about.
    if (listed.status !== 200 || !Array.isArray(listed.data)) return;

    // Case-insensitively: GitHub label names preserve case but collide without
    // it, so a repo carrying `Type:Bug` HAS `type:bug` and creating it again
    // would be a 422 on every tick forever.
    // Filtered to the elements that actually carry a string `name`, not just
    // to "the container is an array": `[1]` or `[{}]` would throw on
    // `undefined.toLowerCase()` one line down, which is the same
    // unhandled-rejection-kills-the-timer-chain hazard the guard above exists
    // for, one level in. An element this drops is a label this process cannot
    // name, so it cannot be compared against the eight either way.
    const present = new Set(
      listed.data.filter((l): l is { name: string } => typeof (l as { name?: unknown })?.name === 'string').map((l) => l.name.toLowerCase())
    );
    const missing = TRACKER_LABELS.filter((l) => !present.has(l.name.toLowerCase()));

    let ok = true;
    for (const label of missing) {
      const created = await this.client.createLabel(repo, label, { token });
      // 201 created, 422 already there (the race). Anything else leaves the
      // flag down so the next sync retries.
      if (created.status !== 201 && created.status !== 422) ok = false;
    }
    if (ok) state.labelsEnsured = true;
  }
}

/** The kinds `resolveSource` is told this loop can honour. `github` alone: the
 *  poller has nothing to do with any other adapter, and passing the service's
 *  whole key set in would couple this file to the module's provider list. */
const KNOWN: ReadonlySet<string> = new Set(['github']);

/** Re-exported so tests and the module can name the client type without
 *  reaching past this file into the transport. */
export { GithubClient };
export { TRACKER_LABEL_NAMES };
