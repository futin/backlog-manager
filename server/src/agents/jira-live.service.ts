import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { branchCarriesKey, keysInBranch } from '../../../shared/jira-branch';
import type { DashboardRow } from '../../../shared/types';
import { readJiraConfig } from '../jira/config.util';
import { JiraLiveService } from '../jira/live.service';
import { JiraPollerService } from '../jira/poller.service';
import { dashboardSessionRows } from './dashboard-sessions.util';
import { readAgentsConfig } from './config.util';
import { mainCheckoutOf } from './worktree-main.util';

/** How often the reconciler asks the dashboard when no Jira page is open (spec §3, §6). */
export const JIRA_RECONCILE_MS = 60_000;

/** …and how often while a Jira page is open (`JiraLiveService.pageOpen`): the page shows the rows, so it wants them fresher (spec §6). */
export const JIRA_RECONCILE_FAST_MS = 15_000;

/**
 * An entry younger than this is never judged: a just-spawned session has no transcript yet, so the dashboard's list (a scan of `~/.claude/projects/`) does not
 * carry it, and "absent" for the first minutes means "not yet", never "gone" (spec §3).
 */
export const JIRA_LIVE_GRACE_MS = 120_000;

/**
 * How long a session must have been Quiet, continuously, before its link ends (spec §5 Detach, §6). The second of two clocks: the entry must ALSO be past
 * JIRA_LIVE_GRACE_MS by `startedAt`, and the later of the two decides. Spec §5's prose says "more than 120 s" and §6 (with the test that predates this) says
 * "less than 120 s stays", i.e. exactly 120 s ends; this follows §6.
 */
export const JIRA_QUIET_MS = 120_000;

/** The most Jira reads one tick spends confirming detected keys (spec §5): the rest wait for the next tick, so a first sweep over a long session list cannot burst. */
export const JIRA_DETECT_READS_PER_TICK = 5;

/** The two statuses that mean a session is still doing something — the test `ItemsAbortService` case B already makes, and for the same reason. */
const ACTIVE = new Set(['working', 'question']);

/**
 * Keeps `JiraLiveService` honest about sessions that ended without a Stop (Jira phase 5; spec §3 "reconciliation"), and — since Jira sessions — the one reader of
 * the dashboard's session rows the Jira page and detection draw on. A session that finished, was stopped from the dashboard or crashed leaves its link live, and
 * the card would show a strip for it until the 8-hour expiry — this is the timer that ends it.
 *
 * It lives in `agents/` and not beside the map because it calls the dashboard, and `jira/` imports nothing from here (`jira.module.ts` says why). The map
 * stays free of timers and of I/O; this class is the only thing that ever asks the dashboard about it. It does read `jira.json` (`agents/` may import `jira/`,
 * never the reverse) to learn whether Setup maps any repo.
 *
 * ## The rule
 *
 * One `GET /api/sessions` per tick, with the dashboard's caps, stored whole in the map (`setRows`). A dashboard that cannot be read marks the map unreachable
 * and ends NOTHING — lost contact is not evidence about any session, and the 8-hour expiry is the floor. For each live entry that holds a session id and is past
 * the grace: a `working` or `question` row clears its Quiet mark; any other row, or no row in a list shorter than the cap (`gone`), is Quiet — marked on the
 * first such tick, and ended (`idle`, or `gone`) once that mark is JIRA_QUIET_MS old. A full list proves nothing about an absent session, so it is left alone.
 * Never touched: a `starting` entry (no session id — its own Start settles it) and any entry younger than the grace. Then, C5: an ENDED entry whose row is
 * `working` or `question` again is re-attached — its own entry re-opened, the 8-hour clock restarted — so a session the user resumed comes back without the
 * history growing.
 *
 * ## Armed, idle — and why it is the watchdog's shape
 *
 * Like the run watchdog (`watchdog.service.ts`, whose "armed, idle, off" comment is the long form), there is no standing interval: one `setTimeout` is pending
 * only while there is something to watch — a live link, or a Setup that maps a repo (detection and re-attach read these rows even with nothing live) — so an
 * idle server pays nothing and "no timer" is a checkable state. The next link is scheduled AFTER the tick's awaits finish, so two ticks cannot overlap by
 * construction, and the timer is `unref()`'d so a pending tick never keeps a dying process alive. The period is chosen when the link is scheduled: 15 s while
 * a Jira page was read in the last 30 s, else 60 s. `arm()` is called after `JiraLiveService.confirm`, and at boot, and is idempotent and self-gating — it
 * starts a chain only when there is something to watch, so every caller may call it without knowing either. A tick that leaves nothing to watch does not
 * schedule the next one: that is the disarm.
 *
 * ## Never in a request's path, and never throws
 *
 * Nothing a request does awaits a tick: `arm()` only schedules. The tick's body is wrapped whole and swallows what it catches, because it runs from a timer
 * callback with nothing above it — a throw there is an unhandled rejection in a process that is serving the board, and the verdict "leave the map alone" is
 * already the answer to every failure it could have.
 */
@Injectable()
export class JiraLiveReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  /** The one pending timer, or null. "Armed" is derived from this and `inFlight`, never tracked as a second flag. */
  private timer: NodeJS.Timeout | null = null;

  /** The tick running now, or null — a second caller gets this promise rather than starting an overlapping read of the list. */
  private inFlight: Promise<void> | null = null;

  /**
   * Set once by `onApplicationShutdown` and never cleared: a tick already mid-`await` at shutdown must not schedule its successor, which `clearTimeout` cannot
   * reach. Without it a shutdown during a slow dashboard call leaves a live timer behind `app.close()` — the same hazard `WatchdogService.stopped` documents.
   */
  private stopped = false;

  constructor(
    private readonly live: JiraLiveService,
    private readonly poller: JiraPollerService
  ) {
    // Setup mapping a repo while the server runs is the one change `watchable` cannot see by itself: nothing else would start the chain, and detection would wait
    // for a restart. The listener lives on the jira side (`agents/` imports `jira/`, never back); `arm` is idempotent and self-gating.
    live.onReposChanged(() => this.arm());
  }

  /** A server that restarts with live links in the file, or with repos mapped, has something to watch from the first second — nothing else would arm it. */
  onApplicationBootstrap(): void {
    this.arm();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Starts the chain, or confirms one is running. A no-op while a timer is pending or a tick is in flight (the tick schedules its own successor), after
   * shutdown, and when there is nothing to watch. Called after every `confirm` and at boot: it is a "something might be watchable now" signal, not a command.
   */
  arm(): void {
    if (this.stopped || this.timer !== null || this.inFlight !== null || !this.watchable()) return;
    const period = this.live.pageOpen(Date.now()) ? JIRA_RECONCILE_FAST_MS : JIRA_RECONCILE_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      // `arm` re-checks `watchable` after the tick, so a tick that ended the last link of an unmapped project stands the chain down, and the next `confirm`'s
      // `arm()` starts a fresh one.
      void this.tick().then(() => this.arm());
    }, period);
    // A pending reconcile is not a reason for a server to refuse to exit.
    this.timer.unref();
  }

  /** One reconciliation. Public for tests; returns the in-flight promise when a tick is already running, as `WatchdogService.tick` does. Never rejects. */
  tick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const running = this.reconcile()
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = running;
    return running;
  }

  /** Something is live, or Setup maps a repo (so a session on a mapped ticket may be found, or a resumed one re-attached). */
  private watchable(): boolean {
    return this.live.hasLive() || this.reposMapped();
  }

  private reposMapped(): boolean {
    try {
      return Object.values(readJiraConfig().repos).some((paths) => paths.length > 0);
    } catch {
      return false;
    }
  }

  private async reconcile(): Promise<void> {
    const cfg = readAgentsConfig();
    if (!cfg.enabled || !this.watchable()) return;
    let answer: Awaited<ReturnType<typeof dashboardSessionRows>>;
    try {
      answer = await dashboardSessionRows(cfg);
    } catch {
      // An unreachable dashboard, a 5xx, a body with no sessions: not an answer. Nothing ends; the page learns the rows are old.
      this.live.markUnreachable(Date.now());
      return;
    }
    const now = Date.now();
    this.live.setRows(answer.rows, now);
    const rows = new Map(answer.rows.map((r) => [r.id, r]));
    // Everything below is synchronous after the await above, so the links read here are the ones the verdicts apply to — and `end` is per (key, session id), so a
    // Stop-and-restart that landed inside the fetch can never have a verdict about the old session rewrite the new one.
    for (const link of this.live.liveLinks()) {
      const id = link.sessionId;
      if (id === null || now - Date.parse(link.startedAt) < JIRA_LIVE_GRACE_MS) continue;
      const row = rows.get(id);
      if (row !== undefined && ACTIVE.has(row.status)) {
        this.live.clearQuiet(link.key, id);
        continue;
      }
      if (row === undefined && answer.full) continue;
      const quietSince = link.quietSince ?? new Date(now).toISOString();
      this.live.markQuiet(link.key, id, quietSince);
      if (now - Date.parse(quietSince) >= JIRA_QUIET_MS) this.live.end(link.key, id, row === undefined ? 'gone' : 'idle', now);
    }
    // C5: a session that ended and is working again is live again, on its own entry.
    for (const link of this.live.links()) {
      const row = link.sessionId === null ? undefined : rows.get(link.sessionId);
      if (link.endedAt !== null && link.sessionId !== null && row !== undefined && ACTIVE.has(row.status)) this.live.reattach(link.key, link.sessionId, now);
    }
    await this.detect(answer.rows);
  }

  /**
   * Branch detection (Jira sessions §5): a `working` or `question` session whose `gitBranch` carries a key of a project Setup maps, launched in a repo Setup maps to
   * that project (or in a linked worktree of one — `mainCheckoutOf`, a file read), is linked. It only ever ADDS: nothing here ends, edits or re-attaches a link,
   * so a session that moved on from `PAY-151-x` keeps its PAY-151 line. A pair already in the store (live or ended), unlinked by a person, or answered 404 before
   * is skipped without a read; every other pair costs one `issueSummary` — at most JIRA_DETECT_READS_PER_TICK a tick, in the dashboard's row order, so a long list
   * drains over a few ticks. A 404 marks the pair never-link (the branch merely looks like a ticket); any other failure leaves it to the next tick.
   */
  private async detect(rows: DashboardRow[]): Promise<void> {
    const repos = readJiraConfig().repos;
    const projects = Object.keys(repos);
    if (projects.length === 0) return;
    const mapped = new Map(projects.map((p) => [p, new Set(repos[p].map((r) => resolve(r)))]));
    const known = new Set(this.live.links().map((l) => `${l.key}\u0000${l.sessionId}`));
    let budget = JIRA_DETECT_READS_PER_TICK;
    for (const row of rows) {
      if (!ACTIVE.has(row.status) || row.gitBranch === undefined || row.gitBranch === '' || row.projectPath === undefined || row.projectPath === '') continue;
      const keys = keysInBranch(row.gitBranch, projects);
      if (keys.length === 0) continue;
      const path = resolve(row.projectPath);
      const main = mainCheckoutOf(path);
      for (const key of keys) {
        const repo = [...(mapped.get(key.slice(0, key.lastIndexOf('-'))) ?? [])].find((r) => r === path || r === main);
        if (repo === undefined || !branchCarriesKey(row.gitBranch, key)) continue;
        if (known.has(`${key}\u0000${row.id}`) || this.live.isSuppressed(key, row.id) || this.live.isNeverLink(key, row.id)) continue;
        if (budget === 0) return;
        budget -= 1;
        const res = await this.poller.issueSummary(key);
        if (!res.ok) {
          if (res.response.status === 404) this.live.markNeverLink(key, row.id);
          continue;
        }
        const issue = res.value;
        this.live.addLink({
          key,
          sessionId: row.id,
          how: 'branch',
          action: null,
          name: row.sessionName ?? row.gitBranch,
          repo,
          branch: row.gitBranch,
          surface: row.surface === 'dashboard' ? 'dashboard' : null,
          model: row.model ?? null,
          effort: row.effort ?? null,
          snapshot: { summary: issue.summary, type: issue.type.name, parentKey: issue.parent?.key ?? null },
          startedAt: new Date().toISOString()
        });
      }
    }
  }
}
