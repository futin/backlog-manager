import { createHash } from 'node:crypto';
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  GITLAB_FINISHED_DAYS,
  GITLAB_IDENTITY_RETRY_MS,
  GITLAB_PAGES_PER_PROJECT,
  GITLAB_POLL_MS,
  GITLAB_RATE_LIMIT_DEFAULT_MS,
  GITLAB_SWEEP_WAIT_MS,
  type GitlabMr,
  type GitlabPayload,
  type GitlabPipeline,
  type GitlabProjectView,
  type GitlabRepoProblem,
  type GitlabState,
  type GitlabStatus
} from '../../../shared/types';
import { readJiraConfig } from '../jira/config.util';
import type { JiraLiveService } from '../jira/live.service';
import { runGit } from '../git-run.util';
import { gitlabEnv } from './env.util';
import { GITLAB_PER_PAGE, GitlabClient, type GitlabResponse, type RawMr } from './gitlab.client';
import { foldMrState, foldPipeline, mrKeys, resolveGitlabProjects, type GitlabMapping, type GitlabProjectTarget } from './mapping.util';

/**
 * The GitLab poller: the one writer of the in-memory MR cache `GET /api/gitlab` serves, and of the identity and state the Sources row draws (spec §5.2,
 * §6.3, §6.4). The tracker poller's shape — a `setTimeout` chain armed only while there is something to poll, one sweep in flight that every caller joins —
 * with the Jira poller's 429 window: one stored `retryAt`, expired where it is read rather than by a timer.
 *
 * **Decoupled from the Jira boards and the Jira poller** (spec §6.3). What it polls is every GitLab project a `jira.json` repo's `origin` names on the site,
 * and the cache is keyed by the ticket keys those projects' MRs carry — not by the keys on a board. So Detail can show an MR for a ticket no board holds
 * (Sessions › All tickets, a parent reached through `Run on`), a board edit never has to re-aim this loop, and `gitlab/` never imports `jira/`'s poller: it
 * reads `readJiraConfig().repos` per sweep and hears a repos save through `JiraLiveService.onReposChanged`, the callback list that exists so `jira/` names
 * nobody who listens.
 *
 * **Failure keeps the last good answer.** A project whose list read fails keeps its MRs and its `polledAt` as they were and records the failure beside them;
 * a detail read that fails keeps that MR's last good pipeline. The Jira poller's reasoning: a list that empties on a blip makes every chip on the board
 * vanish and flash back on the next sweep, which reads as the work disappearing — while a `polledAt` that stops moving is the honest way to say "this is
 * old", and the board already renders it.
 *
 * **Identity is its own question** (spec §5.2): read at bootstrap and when the (site, token) fingerprint changes, independent of arming, so a refused token
 * shows on the Sources row even when no mapped repo is on the site. The fingerprint is a SHA-256 of the pair, held in memory — never the token, which this
 * file only ever passes straight from `gitlabEnv` to the client.
 */

/** What `sweepNow` answers; the sweep route maps it (`not-armed` → 409, `wait` → 429). */
export type GitlabSweepResult = { kind: 'done' } | { kind: 'not-armed' } | { kind: 'wait'; retryAt: number };

export interface GitlabPollerDeps {
  /** Jira project key → repo paths; `readJiraConfig().repos`, read fresh per sweep so a `jira.json` edit lands on the next poll. */
  repos?: () => Record<string, string[]>;
  /** A repo's `origin` URL, `null` for any failure; `runGit`'s `remote get-url`, the one git call this module makes (a read). */
  readOrigin?: (repoPath: string) => Promise<string | null>;
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
}

type IdentityVerdict =
  | { kind: 'checking' }
  | { kind: 'ok'; user: { username: string; name: string } }
  | { kind: 'rejected'; httpStatus: number; reason: string | null }
  | { kind: 'unreachable'; httpStatus: number | null; reason: string };

/** The cached answer for one GitLab project. Replaced whole on a successful read of its lists; on a failure only `failed`/`cannotRead` move. */
interface ProjectCache {
  mrs: GitlabMr[];
  polledAt: string | null;
  capped: boolean;
  /** Rows the capped read fetched, for `first <N> shown`. */
  shown: number;
  failed: boolean;
  cannotRead: 403 | 404 | null;
}

/** A call that got no HTTP answer, a 5xx or a refused 3xx — what turns the state `unreachable`. */
type Unanswered = { httpStatus: number | null; reason: string };

/** What one sweep has learned so far, shared by the project loop: the first unanswered call, and whether the sweep has to stop (a 429, a refused token). */
interface SweepRun {
  site: string;
  token: string;
  now: number;
  unanswered: Unanswered | null;
  stop: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

function fingerprint(site: string, token: string): string {
  // A NUL between the two so `ab`+`c` and `a`+`bc` cannot collide; the digest is the only thing kept, so the token is never held twice.
  return createHash('sha256').update(site).update('\0').update(token).digest('hex');
}

const unansweredStatus = (status: number): boolean => status === 0 || status >= 500;

@Injectable()
export class GitlabPollerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  /** An `arm()` that landed while a sweep was running: that sweep may have derived its mapping before the save it signals, so if it then disarms, it re-arms. */
  private armWhileSweeping = false;

  /** The 429 window's end, epoch ms. Expired where read (`retryAtNow`), never by a timer — the Jira poller's rule. */
  private retryAt: number | null = null;

  /** The identity verdict and the fingerprint of the (site, token) pair it answers. A verdict for another pair is not shown. */
  private identity: { fp: string; verdict: IdentityVerdict } | null = null;
  /** The identity read in flight, for the pair it was started with; every caller joins it rather than asking twice. */
  private identityRead: { fp: string; promise: Promise<void> } | null = null;
  /** When the last identity read STARTED — the one pace `payload()` and the sweep share for retries. */
  private identityReadAt: number | null = null;

  /** The last mapping a sweep derived, with the site it was derived for; `null` until the first sweep. */
  private mapping: (GitlabMapping & { site: string }) | null = null;
  private readonly cache = new Map<string, ProjectCache>();
  /** The last finished sweep's first unanswered call, or `null` when it had none — the precedence rule's `unreachable` from a sweep. */
  private sweepUnanswered: Unanswered | null = null;

  private readonly repos: () => Record<string, string[]>;
  private readonly readOrigin: (repoPath: string) => Promise<string | null>;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(
    private readonly client: GitlabClient,
    live: Pick<JiraLiveService, 'onReposChanged'>,
    deps: GitlabPollerDeps = {}
  ) {
    this.repos = deps.repos ?? (() => readJiraConfig().repos);
    this.readOrigin = deps.readOrigin ?? ((repoPath) => runGit(['-C', repoPath, 'remote', 'get-url', 'origin']));
    this.env = deps.env ?? (() => process.env);
    this.now = deps.now ?? Date.now;
    // A repo mapped after boot arms the poller without a restart (spec §6.3). `arm()` never throws and never awaits, so the save that emits this is never
    // held up by GitLab.
    live.onReposChanged(() => this.arm());
  }

  /**
   * A tick is coming OR one is running. Unlike the tracker's `timer !== null`, a sweep in flight counts: a sweep clears its own timer on entry and makes
   * the next one only at its end, so a timer-only answer would read `false` for the whole of every sweep — and every delivery surface that gates on
   * `armed` would blink out each time GitLab is asked.
   */
  get armed(): boolean {
    return this.timer !== null || this.inFlight !== null;
  }

  onApplicationBootstrap(): void {
    const env = gitlabEnv(this.env());
    // Identity is independent of arming (spec §5.2): a refused token must show even when no mapped repo is on the site and the poller never arms.
    if (env.configured) void this.ensureIdentity(env.site, env.token, this.now(), false);
    this.arm();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.disarm();
  }

  /**
   * Start the chain, or confirm it is already running. A signal, not a command: the bootstrap hook, a repos save and the sweep route all call it, and
   * whether there is anything to poll is the sweep's to find out (it re-derives the mapping and disarms on zero projects).
   */
  arm(): void {
    if (this.stopped) return;
    if (!gitlabEnv(this.env()).configured) {
      this.clearTimer();
      return;
    }
    if (this.inFlight !== null) {
      this.armWhileSweeping = true;
      return;
    }
    if (this.timer !== null) return;
    void this.tick();
  }

  disarm(): void {
    this.clearTimer();
  }

  /** One sweep — the running one when there is one, so an older sweep can never write the cache after a newer one (spec §6.3). */
  tick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    this.armWhileSweeping = false;
    const running = this.sweep().finally(() => {
      this.inFlight = null;
      if (this.armWhileSweeping) {
        this.armWhileSweeping = false;
        // The sweep that just ended may have read the repos before the save that armed it; if it left no successor, sweep once more with the new ones.
        if (this.timer === null && !this.stopped) this.arm();
      }
    });
    this.inFlight = running;
    return running;
  }

  /**
   * Read again. In order: inside a 429 window → `wait` with the stored end, no call; a sweep in flight (the immediate one `arm()` starts included) → join
   * it, bounded, then `not-armed` if it left no timer (nothing to poll) else `done`; no timer → `not-armed`; else start a sweep and wait for it, bounded
   * by `GITLAB_SWEEP_WAIT_MS` — past the bound it answers `done` anyway and the sweep finishes behind it, the Jira save-sweep's precedent.
   */
  async sweepNow(): Promise<GitlabSweepResult> {
    const retryAt = this.retryAtNow(this.now());
    if (retryAt !== null) return { kind: 'wait', retryAt };
    if (this.inFlight !== null) {
      const finished = await this.bounded(this.inFlight);
      // `armed`, not `timer === null`: a re-arm sweep an `arm()` that landed mid-sweep starts in the finally is in flight with no timer yet.
      if (finished && !this.armed) return { kind: 'not-armed' };
      return { kind: 'done' };
    }
    if (this.stopped || !this.armed) return { kind: 'not-armed' };
    await this.bounded(this.tick());
    return { kind: 'done' };
  }

  /** `GET /api/gitlab`: from memory and env, no awaited outbound call. A changed or retry-due identity is asked for here, un-awaited. */
  payload(): GitlabPayload {
    const now = this.now();
    const env = gitlabEnv(this.env());
    if (!env.configured) {
      return {
        status: {
          state: 'unconfigured',
          site: null,
          malformedSite: env.malformedSite,
          user: null,
          httpStatus: null,
          reason: env.detail,
          armed: this.armed,
          retryAt: null,
          mappedRepos: 0,
          foundHosts: [],
          problems: []
        },
        jiraProjects: {},
        mrs: []
      };
    }
    void this.ensureIdentity(env.site, env.token, now, false);

    // Only a mapping derived for THIS site is shown; one derived for another (before a restart that changed it) describes nothing here.
    const mapping = this.mapping !== null && this.mapping.site === env.site ? this.mapping : null;
    const projects = mapping?.projects ?? [];
    const verdict = this.identity !== null && this.identity.fp === fingerprint(env.site, env.token) ? this.identity.verdict : { kind: 'checking' as const };

    const jiraProjects: Record<string, GitlabProjectView[]> = {};
    const mrs: GitlabMr[] = [];
    const cannotRead: GitlabRepoProblem[] = [];
    const capped: GitlabRepoProblem[] = [];
    for (const p of projects) {
      const c = this.cache.get(p.path);
      const view: GitlabProjectView = { path: p.path, repo: p.repo, polledAt: c?.polledAt ?? null, capped: c?.capped ?? false, failed: c?.failed ?? false };
      for (const key of p.jiraKeys) (jiraProjects[key] ??= []).push({ ...view });
      if (c === undefined) continue;
      mrs.push(...c.mrs.map((m) => ({ ...m, keys: [...m.keys] })));
      if (c.failed && c.cannotRead !== null) cannotRead.push({ kind: 'cannot-read', path: p.path, status: c.cannotRead });
      if (c.capped) capped.push({ kind: 'capped', path: p.path, shown: c.shown });
    }
    const origins: GitlabRepoProblem[] = (mapping?.originFailures ?? []).map((repo) => ({ kind: 'origin', repo }));

    const { state, httpStatus, reason } = this.stateOf(verdict, projects.length);
    const retryAt = this.retryAtNow(now);
    return {
      status: {
        state,
        site: env.site,
        malformedSite: false,
        user: verdict.kind === 'ok' ? { ...verdict.user } : null,
        httpStatus,
        reason,
        armed: this.armed,
        retryAt: retryAt === null ? null : iso(retryAt),
        mappedRepos: projects.length,
        foundHosts: [...(mapping?.foundHosts ?? [])],
        problems: [...cannotRead, ...origins, ...capped]
      },
      jiraProjects,
      mrs
    };
  }

  /**
   * State precedence, the one place it is decided (configured is already established): the identity verdict while it is not a working token; then
   * `unreachable` while the last finished sweep had a call with no HTTP answer, a 5xx or a refused 3xx; then `idle` with nothing on the site, else
   * `connected`. A 403/404 on one project is that project's line, not the state — one unreadable project does not make the source down.
   */
  private stateOf(verdict: IdentityVerdict, projects: number): { state: GitlabState; httpStatus: number | null; reason: string | null } {
    if (verdict.kind === 'checking') return { state: 'checking', httpStatus: null, reason: null };
    if (verdict.kind === 'rejected') return { state: 'rejected', httpStatus: verdict.httpStatus, reason: verdict.reason };
    if (verdict.kind === 'unreachable') return { state: 'unreachable', httpStatus: verdict.httpStatus, reason: verdict.reason };
    if (this.sweepUnanswered !== null) return { state: 'unreachable', ...this.sweepUnanswered };
    return { state: projects === 0 ? 'idle' : 'connected', httpStatus: null, reason: null };
  }

  // ---- identity -------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Ask for the identity when it needs asking, and hand back the read to wait on (or `null` when nothing is asked). A changed fingerprint asks at once and
   * reads `checking` until it lands. An unanswered or `unreachable` verdict is re-asked at most once per `GITLAB_IDENTITY_RETRY_MS`, measured from the last
   * read's start, whoever asks; `force` (a 401 on some other call — a token revoked after a good read) skips the pace. A `rejected` verdict is otherwise
   * final for its pair: the server cannot tell a fixed scope from an unfixed one without asking, and spec §5.2 asks only on a pair change or a 401. A read
   * already in flight for this pair is joined, never doubled.
   */
  private ensureIdentity(site: string, token: string, now: number, force: boolean): Promise<void> | null {
    const fp = fingerprint(site, token);
    if (this.identity === null || this.identity.fp !== fp) {
      this.identity = { fp, verdict: { kind: 'checking' } };
      return this.startIdentityRead(site, token, fp, now);
    }
    if (this.identityRead !== null && this.identityRead.fp === fp) return this.identityRead.promise;
    if (force) return this.startIdentityRead(site, token, fp, now);
    const kind = this.identity.verdict.kind;
    if (kind !== 'checking' && kind !== 'unreachable') return null;
    if (this.identityReadAt !== null && now - this.identityReadAt < GITLAB_IDENTITY_RETRY_MS) return null;
    return this.startIdentityRead(site, token, fp, now);
  }

  private startIdentityRead(site: string, token: string, fp: string, now: number): Promise<void> {
    this.identityReadAt = now;
    const promise: Promise<void> = this.client
      .currentUser(site, token)
      .then((res) => {
        // A read for a pair that has since changed answers nothing about the current one.
        if (this.identity === null || this.identity.fp !== fp) return;
        const verdict = this.identityVerdict(res);
        if (verdict !== null) this.identity = { fp, verdict };
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.identityRead?.promise === promise) this.identityRead = null;
      });
    this.identityRead = { fp, promise };
    return promise;
  }

  /** `null` leaves the verdict as it was: a 429 opens the window and says nothing about the token. */
  private identityVerdict(res: GitlabResponse<{ username: string; name: string }>): IdentityVerdict | null {
    if (res.status === 200) {
      const d = res.data as { username?: unknown; name?: unknown } | null;
      if (d !== null && typeof d.username === 'string' && d.username !== '') {
        return { kind: 'ok', user: { username: d.username, name: typeof d.name === 'string' ? d.name : d.username } };
      }
      return { kind: 'unreachable', httpStatus: 200, reason: 'unexpected answer from /user' };
    }
    if (res.status === 401 || res.status === 403) return { kind: 'rejected', httpStatus: res.status, reason: res.message };
    if (res.status === 429) {
      this.openWindow(res);
      return null;
    }
    // Status 0 (no answer, a deadline, a refused 3xx), a 5xx — and any other code `/user` has no business answering, which is not a working token either.
    return { kind: 'unreachable', httpStatus: res.status === 0 ? null : res.status, reason: res.message ?? `HTTP ${res.status}` };
  }

  // ---- 429 window -----------------------------------------------------------------------------------------------------------------------------------

  private openWindow(res: GitlabResponse<unknown>): void {
    const now = this.now();
    // A window already in force keeps its end: a second 429 inside it is the same limit, and moving the end would let a burst push it out forever.
    if (this.retryAtNow(now) !== null) return;
    this.retryAt = now + (res.retryAfter !== null ? res.retryAfter * 1000 : GITLAB_RATE_LIMIT_DEFAULT_MS);
  }

  /** The window's end while it is ahead, else `null` — and an expired one is dropped here, where it is read. */
  private retryAtNow(now: number): number | null {
    if (this.retryAt === null) return null;
    if (now < this.retryAt) return this.retryAt;
    this.retryAt = null;
    return null;
  }

  // ---- the sweep ------------------------------------------------------------------------------------------------------------------------------------

  private async sweep(): Promise<void> {
    // Consumed on entry; the successor is made at the end, and `armed` still reads true meanwhile through `inFlight`.
    this.clearTimer();
    let successor = false;
    try {
      successor = await this.sweepOnce();
    } catch (e) {
      // Nothing above throws by design (every failure is a value), so this is a bug; keep the chain alive and let the next sweep re-decide.
      console.warn(`gitlab sweep failed: ${(e as Error).message}`);
      successor = true;
    }
    if (successor) this.schedule();
  }

  /** One sweep's work; answers whether a successor should be scheduled. */
  private async sweepOnce(): Promise<boolean> {
    const env = gitlabEnv(this.env());
    if (this.stopped || !env.configured) return false;
    const { site, token } = env;
    const startedAt = this.now();

    // The identity (when due) and the mapping are independent: asked together. The sweep waits for the identity so the state it leaves is decided.
    const identity = this.ensureIdentity(site, token, startedAt, false);
    const mapping = await resolveGitlabProjects(this.repos(), site, this.readOrigin);
    if (identity !== null) await identity;
    this.mapping = { ...mapping, site };
    const mapped = new Set(mapping.projects.map((p) => p.path));
    for (const path of [...this.cache.keys()]) if (!mapped.has(path)) this.cache.delete(path);

    // Nothing on the site: disarm (no successor). The state reads `idle` once the identity is good; a sweep that asked nothing has nothing unanswered.
    if (mapping.projects.length === 0) {
      this.sweepUnanswered = null;
      return false;
    }
    // A refused token gets nothing more asked with it; the chain stays up so a re-derived mapping still lands, and a pair change re-reads the identity.
    if (this.identity?.verdict.kind === 'rejected') return true;
    // Inside a 429 window nothing is asked; the successor (scheduled past the window's end) waits it out.
    if (this.retryAtNow(startedAt) !== null) return true;

    const run: SweepRun = { site, token, now: startedAt, unanswered: null, stop: false };
    for (const target of mapping.projects) {
      await this.sweepProject(run, target);
      if (run.stop) break;
    }
    // A sweep cut short keeps the previous verdict unless it saw an unanswered call itself; one that ran to the end replaces it either way.
    if (run.unanswered !== null || !run.stop) this.sweepUnanswered = run.unanswered;
    return true;
  }

  /**
   * One project: the MR lists within the page budget, then one detail read per kept OPEN MR for its head pipeline. The lists decide the project's verdict;
   * a detail failure only ever costs that MR its fresh pipeline.
   */
  private async sweepProject(run: SweepRun, target: GitlabProjectTarget): Promise<void> {
    const prev = this.cache.get(target.path);
    const rows: RawMr[] = [];
    let pages = 0;
    let capped = false;
    const updatedAfter = iso(run.now - GITLAB_FINISHED_DAYS * DAY_MS);

    // Opened first, then merged and closed, each newest-updated first (the client asks `order_by=updated_at&sort=desc`): the budget cuts the oldest
    // finished MRs, never an open one while finished ones are kept (spec §6.3).
    for (const state of ['opened', 'merged', 'closed'] as const) {
      let page = 1;
      for (;;) {
        if (pages >= GITLAB_PAGES_PER_PROJECT) {
          // The budget is spent and the last page was full: there is more than was read.
          capped = true;
          break;
        }
        const res = await this.client.listMergeRequests(run.site, run.token, target.path, {
          state,
          page,
          ...(state === 'opened' ? {} : { updatedAfter })
        });
        pages++;
        if (res.status !== 200) {
          await this.listFailed(run, target.path, prev, res);
          return;
        }
        const list = Array.isArray(res.data) ? res.data : [];
        rows.push(...list);
        if (list.length < GITLAB_PER_PAGE) break;
        page++;
      }
      if (capped) break;
    }

    // Fold and key. A row read twice (an MR updated between two page reads moves up the order) keeps its first, fresher read.
    const byIid = new Map<number, GitlabMr>();
    for (const raw of rows) {
      if (byIid.has(raw.iid)) continue;
      const state = foldMrState(raw.state);
      if (state === null) continue;
      const keys = mrKeys(raw.source_branch, raw.title, target.jiraKeys);
      // An MR that names no ticket of this project's keys has nowhere to be drawn.
      if (keys.length === 0) continue;
      byIid.set(raw.iid, {
        project: target.path,
        iid: raw.iid,
        title: raw.title,
        webUrl: raw.web_url,
        state,
        draft: raw.draft === true,
        sourceBranch: raw.source_branch,
        targetBranch: raw.target_branch,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        mergedAt: raw.merged_at ?? null,
        // Finished MRs are not read for a pipeline (spec §6.3 bounds the requests by open MRs), so they carry `null`, never a guessed `none`.
        pipeline: null,
        keys
      });
    }

    const lastGood = (iid: number): GitlabPipeline => prev?.mrs.find((m) => m.iid === iid)?.pipeline ?? 'none';
    for (const mr of byIid.values()) {
      if (mr.state !== 'opened') continue;
      if (run.stop) {
        mr.pipeline = lastGood(mr.iid);
        continue;
      }
      const res = await this.client.mergeRequest(run.site, run.token, target.path, mr.iid);
      if (res.status === 200) {
        mr.pipeline = foldPipeline(res.data?.head_pipeline?.status);
        continue;
      }
      mr.pipeline = lastGood(mr.iid);
      if (res.status === 429) {
        this.openWindow(res);
        run.stop = true;
      } else if (res.status === 401) {
        if (await this.reReadIdentity(run)) run.stop = true;
      } else if (unansweredStatus(res.status)) {
        run.unanswered ??= { httpStatus: res.status === 0 ? null : res.status, reason: res.message ?? `HTTP ${res.status}` };
      }
      // A detail 403/404 (or any other code) is that MR's problem alone: last good pipeline, no project verdict, no state.
    }

    // The lists were read: they are the answer, even when a stop above left some pipelines at their last good value.
    this.cache.set(target.path, {
      mrs: [...byIid.values()],
      polledAt: iso(run.now),
      capped,
      shown: capped ? rows.length : 0,
      failed: false,
      cannotRead: null
    });
  }

  /** A list read that did not answer 200: the project keeps its MRs and `polledAt`, and the code decides what else happens. */
  private async listFailed(run: SweepRun, path: string, prev: ProjectCache | undefined, res: GitlabResponse<unknown>): Promise<void> {
    if (res.status === 429) {
      // The limit is GitLab's, not the project's: no verdict on it, and the sweep stops.
      this.openWindow(res);
      run.stop = true;
      return;
    }
    const kept: ProjectCache = prev ?? { mrs: [], polledAt: null, capped: false, shown: 0, failed: false, cannotRead: null };
    if (res.status === 401) {
      // A token revoked after a good identity read: ask again now, so the row turns `rejected` within this sweep rather than at a restart.
      if (await this.reReadIdentity(run)) {
        run.stop = true;
        return;
      }
    }
    if (unansweredStatus(res.status)) run.unanswered ??= { httpStatus: res.status === 0 ? null : res.status, reason: res.message ?? `HTTP ${res.status}` };
    const cannotRead = res.status === 403 || res.status === 404 ? res.status : null;
    this.cache.set(path, { ...kept, failed: true, cannotRead });
  }

  /** Re-read the identity at once (a 401 somewhere); answers whether the token is now refused, which stops the sweep. */
  private async reReadIdentity(run: SweepRun): Promise<boolean> {
    const read = this.ensureIdentity(run.site, run.token, this.now(), true);
    if (read !== null) await read;
    return this.identity?.verdict.kind === 'rejected';
  }

  // ---- timers -----------------------------------------------------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.stopped || this.timer !== null) return;
    // Inside a 429 window the next sweep waits the window out rather than finding it open and asking nothing.
    const now = this.now();
    const retryAt = this.retryAtNow(now);
    const delay = retryAt === null ? GITLAB_POLL_MS : Math.max(GITLAB_POLL_MS, retryAt - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    // A pending poll never keeps the process alive on its own — the tracker's and the watchdog's treatment.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wait for `p`, at most `GITLAB_SWEEP_WAIT_MS`; answers whether it finished in time. The bound's timer is unref'd and cleared either way. */
  private async bounded(p: Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), GITLAB_SWEEP_WAIT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([p.then(() => true as const, () => true as const), bound]);
    } finally {
      clearTimeout(timer);
    }
  }
}
