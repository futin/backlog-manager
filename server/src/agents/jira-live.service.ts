import { Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';

import { JiraLiveService } from '../jira/live.service';
import { dashboardSessions } from './dashboard-sessions.util';
import { readAgentsConfig } from './config.util';

/** How often the reconciler asks the dashboard, while the map holds a confirmed session (spec §3). */
export const JIRA_RECONCILE_MS = 60_000;

/**
 * An entry younger than this is never judged: a just-spawned session has no transcript yet, so the dashboard's list (a scan of `~/.claude/projects/`) does not
 * carry it, and "absent" for the first minutes means "not yet", never "gone" (spec §3).
 */
export const JIRA_LIVE_GRACE_MS = 120_000;

/** The two statuses that mean a session is still doing something — the test `ItemsAbortService` case B already makes, and for the same reason. */
const ACTIVE = new Set(['working', 'question']);

/**
 * Keeps `JiraLiveService` honest about sessions that ended without a Stop (Jira phase 5; spec §3 "reconciliation"). A session that finished, was stopped from the
 * dashboard or crashed leaves its key in the live map, and the card would show a strip for it until the 8-hour expiry — this is the timer that clears it.
 *
 * It lives in `agents/` and not beside the map because it calls the dashboard, and `jira/` imports nothing from here (`jira.module.ts` says why). The map
 * stays free of timers and of I/O; this class is the only thing that ever asks the dashboard about it.
 *
 * ## The rule
 *
 * One `GET /api/sessions` per tick. A confirmed entry stays only while its session is `working` or `question`: the list keeps an exited session as `idle` for
 * its whole lookback, so "present" proves nothing and "absent" is the other way an ended session reads. Never touched: a `starting` entry (no session id to
 * look up — its own Start settles it), and any entry younger than JIRA_LIVE_GRACE_MS. A list that cannot be read, or agents switched off, leaves the map exactly
 * as it was — an unreadable answer is not an answer, and the 8-hour expiry is the floor for a dashboard that cannot be asked.
 *
 * ## Armed, idle — and why it is the watchdog's shape
 *
 * Like the run watchdog (`watchdog.service.ts`, whose "armed, idle, off" comment is the long form), there is no standing interval: one `setTimeout` is pending
 * only while some entry holds a session id, so an idle server pays nothing and "no timer" is a checkable state. The next link is scheduled AFTER the tick's awaits
 * finish, so two ticks cannot overlap by construction, and the timer is `unref()`'d so a pending tick never keeps a dying process alive. `arm()` is called
 * after `JiraLiveService.confirm` — the moment the map first holds a session — and is idempotent, so every confirm may call it without knowing whether a chain
 * exists. A tick that finds nothing confirmed does not schedule the next one: that is the disarm.
 *
 * ## Never in a request's path, and never throws
 *
 * Nothing a request does awaits a tick: `arm()` only schedules. The tick's body is wrapped whole and swallows what it catches, because it runs from a timer
 * callback with nothing above it — a throw there is an unhandled rejection in a process that is serving the board, and the verdict "leave the map alone" is
 * already the answer to every failure it could have.
 */
@Injectable()
export class JiraLiveReconciler implements OnApplicationShutdown {
  /** The one pending timer, or null. "Armed" is derived from this and `inFlight`, never tracked as a second flag. */
  private timer: NodeJS.Timeout | null = null;

  /** The tick running now, or null — a second caller gets this promise rather than starting an overlapping read of the list. */
  private inFlight: Promise<void> | null = null;

  /**
   * Set once by `onApplicationShutdown` and never cleared: a tick already mid-`await` at shutdown must not schedule its successor, which `clearTimeout` cannot
   * reach. Without it a shutdown during a slow dashboard call leaves a live timer behind `app.close()` — the same hazard `WatchdogService.stopped` documents.
   */
  private stopped = false;

  constructor(private readonly live: JiraLiveService) {}

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Starts the chain, or confirms one is running. A no-op while a timer is pending or a tick is in flight (the tick schedules its own successor), and after
   * shutdown. Called after every `confirm`: it is a "something might be watchable now" signal, not a command.
   */
  arm(): void {
    if (this.stopped || this.timer !== null || this.inFlight !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // The next link only while there is something left to watch: this is the disarm. `hasConfirmed` is read after the tick, so a tick that cleared the last
      // entry stands the chain down and the next `confirm`'s `arm()` starts a fresh one.
      void this.tick().then(() => {
        if (this.live.hasConfirmed()) this.arm();
      });
    }, JIRA_RECONCILE_MS);
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

  private async reconcile(): Promise<void> {
    const cfg = readAgentsConfig();
    if (!cfg.enabled) return;
    const candidates = this.live.confirmed();
    if (candidates.length === 0) return;
    // A throw here — an unreachable dashboard, a 5xx, a body with no sessions — lands in `tick`'s catch with the map untouched.
    const sessions = await dashboardSessions(cfg);
    const now = Date.now();
    for (const { key, sessionId, startedAt } of candidates) {
      if (now - Date.parse(startedAt) < JIRA_LIVE_GRACE_MS) continue;
      if (ACTIVE.has(sessions.get(sessionId) ?? '')) continue;
      // The list was read across an await, in which a Stop and a fresh Start can have replaced this key's entry. Only the entry this verdict is about goes.
      if (this.live.get(key)?.sessionId === sessionId) this.live.clear(key);
    }
  }
}
