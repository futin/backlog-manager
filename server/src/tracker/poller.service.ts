import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

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
  /** Comments by id. Written in phase 2, read by nothing until phase 3. */
  comments: Map<number, GithubComment>;
  /** The newest `updated_at` seen, sent as the next poll's `since`. `null`
   *  before the first sync, which is what makes that sync a full one. */
  hwm: string | null;
  issuesEtag: string | null;
  commentsEtag: string | null;
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
        issuesEtag: null,
        commentsEtag: null,
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
      // Nothing changed. The cache and `polledAt` both stay exactly as they
      // were — the task item's authoritative test case says so in those words.
      // (Spec §12.2 says a 304 MOVES `polledAt`, which would make the rendered
      // age "how long since we last checked" rather than "how old these items
      // are". The item won, being the work order; the disagreement is recorded
      // in its Outcome so phase 3 can settle it rather than rediscover it.)
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

    // Made on EVERY tick that got past the issues read, including a 304 one,
    // and read by nothing until phase 3 (spec §5.1). Skipping it while it has
    // no reader would move the polling loop's shape, its budget and its tests
    // into the phase that also introduces the claim protocol they feed.
    const comments = await this.client.comments(repo, { token, since: state.hwm, etag: state.commentsEtag });
    if (this.handleFailure(state, comments)) return;
    if (comments.status === 200) {
      state.commentsEtag = comments.etag;
      // `Array.isArray` rather than a bare `?? []`, here and in
      // `absorbIssues`: a 200 whose body is not the array this endpoint
      // documents (a proxy's error page, an API change) would otherwise throw
      // inside a `for…of` — and this code runs from a timer chain, where a
      // throw is an unhandled rejection that kills the poll loop rather than
      // one bad tick. Every other failure in this file is a value the board
      // renders; this one must be too.
      if (Array.isArray(comments.data)) {
        for (const comment of comments.data) state.comments.set(comment.id, comment);
      }
    }

    // The bootstrap, after the first sync that proved the repo is readable
    // (spec §5.2). Phase 2's one write to GitHub.
    if (!state.labelsEnsured) await this.ensureLabels(repo, token, state);
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
