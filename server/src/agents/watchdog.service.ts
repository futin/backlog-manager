import { HttpException, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { AgentsService, message } from './agents.service';
import { readAgentsConfig } from './config.util';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { readWatchdogConfig, watchdogEnvOff } from '../orchestrator/watchdog-config.util';
import { WatchdogStateService } from '../orchestrator/watchdog-state.service';
import type { WatchdogEntry } from '../orchestrator/watchdog-state.service';
import type { OrchestratorRunsPayload, WatchdogStatus } from '../../../shared/types';

/**
 * watchdog.service.ts — the sweeper.
 *
 * On 2026-09-03, `run-20260903-112622` (backlog-manager, four bugs) stopped
 * heartbeating at 14:58 and nobody knew for four hours. Every existing piece
 * had worked: staleness was detected on time, `reconcile` read the disk
 * correctly, and a hand-typed `--resume` finished the last item in 35
 * minutes. The only missing part was a TRIGGER. This file is that trigger,
 * and nothing more — it decides WHEN a `--resume` is spawned; it does not
 * change what `--resume` does, and it never touches a run file.
 *
 * ## What it may and may not touch
 *
 * This service writes NOTHING to disk. Not `run.json`, not anything under
 * `orchHome()`, not the item files. `orchestrate.mjs` is the run file's one
 * writer (CLAUDE.md) and a watchdog that stamped "auto-resumed" onto a run
 * would be a second one; the resumed session itself is what updates the run,
 * exactly as it would have if a human had typed the trigger. Everything this
 * service remembers lives in `WatchdogStateService`, in memory.
 *
 * ## Armed, idle, off — and why there is no standing interval
 *
 * Three phases (design §1). *Off*: `BM_WATCHDOG=off` (the operator's kill
 * switch) or `BM_AGENTS` off (nothing on this server can spawn at all, so
 * there is nothing to watch FOR) — no timer ever exists and no tick ever
 * runs. *Idle*: no run file anywhere says `running` — no timer exists.
 * *Armed*: at least one does, fresh or crashed alike, and exactly one
 * `setTimeout` is pending.
 *
 * A standing `setInterval` was the obvious implementation and is deliberately
 * not what this is. The user's requirement was explicit: an idle watchdog
 * must cost nothing and must be OBSERVABLY idle. A standing interval fails
 * both halves — it reads every project's run directory once a minute forever
 * on a machine where nothing has run for a month, and the Settings State row
 * could then only ever say "on", never "there is nothing to watch". A chain
 * that exists only while there is something to lose track of makes "idle"
 * a real, checkable state (`armed === false`, `phase === 'idle'`) rather
 * than a claim.
 *
 * ## Why a setTimeout chain rather than setInterval
 *
 * The next tick is scheduled AFTER the current tick's awaits complete, so two
 * ticks can never overlap BY CONSTRUCTION — there is no moment at which two
 * timers exist. `setInterval` gives the opposite guarantee: it fires on a
 * wall clock regardless of whether the previous callback has finished, and a
 * tick that is waiting on a slow dashboard would be re-entered by the next
 * one, with two `resume()` calls racing for the same crashed run and the
 * grace check reading a `lastSpawnAt` neither had written yet. The in-flight
 * guard in `tick()` is a second, independent belt for the same failure: a
 * caller that is not the timer (the bootstrap hook, `arm()`, a test, a future
 * route) cannot start an overlapping tick either. The timer is `unref()`'d so
 * a pending tick never keeps the process alive on its own.
 *
 * ## Why grace applies to failures as well as successes
 *
 * One rule covers both outcomes of a spawn ATTEMPT: any attempt starts the
 * grace clock; only a SUCCESS counts against the cap. The two halves exist
 * for two different failures. Grace-on-failure: a dashboard that is down —
 * unreachable, out of launch slots, its project list gone stale — would
 * otherwise be re-asked on every single tick, once a minute, for as long as
 * it stays down, which is a retry storm dressed up as monitoring. Cap-on-
 * success-only: those same failures must not BURN the cap either, or a
 * dashboard down for a day would leave every crashed run marked `exhausted`
 * without a single resume ever having been attempted, and the one thing this
 * feature exists to do would silently never happen. `attempts` therefore
 * means "resume sessions actually started", which is also the only reading
 * under which the strip's "attempt 1/2" is a sentence a person can act on.
 *
 * ## Why the state is in-memory
 *
 * Attempts, phase and the event log are lost on restart, on purpose (design
 * §9). The alternative is a writable record beside `run.json`, and the whole
 * run-file design exists to have exactly one writer in that directory. The
 * cost is bounded and stated: a restart forgets the cap, so a crashed run can
 * receive up to `maxAttempts` MORE spawns after one. That is a bounded
 * over-eagerness; a second writer in the orchestrator's own directory would
 * be a permanent structural exception.
 */
@Injectable()
export class WatchdogService implements OnApplicationBootstrap, OnApplicationShutdown {
  /** The one pending timer, or null. `armed` is derived from this rather
   *  than tracked separately: two sources of truth for "is a tick coming"
   *  is exactly how a disarmed sweeper ends up still reporting armed. */
  private timer: NodeJS.Timeout | null = null;

  /** The promise of the tick currently running, or null. Returned verbatim
   *  to a second caller — see `tick()`. */
  private inFlight: Promise<void> | null = null;

  /**
   * Set once, by `onApplicationShutdown`, and never cleared. A tick that was
   * already in flight when the process began shutting down must not schedule
   * its successor: `disarm()` clears the pending timer, but it cannot reach
   * into a tick that is mid-`await` and is about to create a new one. Without
   * this flag a shutdown during a slow dashboard call would leave a live
   * timer behind after `app.close()` resolved — which in a test run means a
   * sweeper ticking against a temp directory that has already been deleted,
   * and in production means a handle keeping a dying process warm.
   */
  private stopped = false;

  /** The runIds the last tick saw `running`, for `status().watching`. Kept
   *  here rather than in `WatchdogStateService` because it is not state ABOUT
   *  anything — it is a snapshot of the last read, and the state service's
   *  own entries are deliberately keyed by runId for exactly the runs this
   *  list holds. */
  private watching: string[] = [];

  constructor(
    private readonly agents: AgentsService,
    private readonly orchestrator: OrchestratorService,
    private readonly state: WatchdogStateService
  ) {}

  /** A tick is scheduled. False while off, while idle, and — briefly —
   *  inside a tick, which has already cleared its own timer and not yet
   *  made the next one. */
  get armed(): boolean {
    return this.timer !== null;
  }

  /**
   * Registers the armer BEFORE arming, so the very first
   * `GET /api/orchestrator/runs` the board makes can arm this sweeper even
   * if the bootstrap scan below found nothing (a run started from a terminal
   * after this process booted is exactly that case — design §2.1's stated
   * gap is only the narrower one where the board is never opened at all).
   */
  onApplicationBootstrap(): void {
    this.state.setArmer(() => this.arm());
    this.arm();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.disarm();
  }

  /**
   * Start the chain, or confirm it is already running. Idempotent in both
   * directions — a no-op while already armed, a no-op while off — because
   * every caller of it is a "something might be running now" signal rather
   * than a command: the bootstrap scan, every runs-payload `observe()`, and
   * (design §5.3) a Settings save. None of them knows or should know whether
   * a chain already exists.
   *
   * While OFF this still sets the phase and reason. "No-op" here means no
   * timer and no tick — not "says nothing": the Settings State row and the
   * strip's watchdog clause both read `phase`/`reason`, and an operator who
   * has set `BM_WATCHDOG=off` needs the UI to say so rather than leave the
   * phase reading whatever it happened to be before. The two are different
   * claims and both are true.
   */
  arm(): void {
    const off = this.offReason();
    if (off !== null) {
      this.clearTimer();
      this.state.setPhase('off', off, null);
      return;
    }
    // A pending timer OR a tick mid-flight both mean the chain is alive: a
    // tick clears its own timer on entry, so checking the timer alone would
    // let a concurrent `arm()` start a second chain in that window.
    if (this.timer !== null || this.inFlight !== null) return;

    this.state.setPhase('armed');
    this.state.push({ project: null, runId: null, kind: 'armed', detail: 'watching for crashed runs' });
    void this.tick();
  }

  /** Clear the timer and report idle. Public because the tick itself calls
   *  it when it finds nothing running, and shutdown calls it too. */
  disarm(): void {
    this.clearTimer();
    this.state.setPhase('idle');
  }

  /**
   * One sweep (design §2.2). Returns the IN-FLIGHT promise when one exists,
   * rather than starting a second sweep or refusing — a caller that awaits
   * `tick()` is asking "has a sweep including right now finished", and the
   * sweep already running is the honest answer to that. Refusing (returning
   * an immediately-resolved promise) would be a lie: the caller would
   * continue before the spawn it triggered had happened.
   */
  tick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const running = this.sweep().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  /** The whole `GET /api/agents/watchdog` payload (design §4.2). `config` is
   *  read fresh here rather than remembered from the last tick, so a Settings
   *  save is visible immediately instead of at the next tick. */
  status(): WatchdogStatus {
    return this.state.status(readWatchdogConfig(), [...this.watching]);
  }

  /**
   * Why the sweeper may not run at all, or `null`. The env kill switch is
   * checked FIRST and reported on its own: with both switches thrown, the
   * one an operator can undo by editing `.env` is the more actionable
   * answer, and it is also the one that means "this process was told to do
   * nothing" rather than "this feature has no way to act".
   *
   * `WatchdogConfig.enabled` is deliberately NOT here. That is the user's
   * Settings toggle, and a disabled watchdog still arms, ticks and reports
   * the crashed run it WOULD have resumed (design §1) — it only withholds
   * the spawn. Folding it in here would turn the strip's honest "off —
   * resume by hand" clause back into a guess, because nothing would be
   * watching to produce it.
   */
  private offReason(): string | null {
    if (watchdogEnvOff()) return 'BM_WATCHDOG off';
    if (!readAgentsConfig().enabled) return 'BM_AGENTS off';
    return null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * The sweep body. Every read it makes — the config, the runs payload — is
   * fresh, the same no-cache posture `OrchestratorService.runs()` and
   * `readWatchdogConfig()` both already take on their own files: a running
   * orchestrator re-stamps its run file continuously, and the whole question
   * this method answers is whether that has stopped.
   */
  private async sweep(): Promise<void> {
    const off = this.offReason();
    if (off !== null) {
      // Checked here as well as in `arm()` because the two can be reached
      // independently — the chain's own timer calls this directly, and an
      // operator can throw either switch between two ticks. Nothing below
      // this line may run under an off switch, including the `runs()` read:
      // "off" means this process does nothing watchdog-shaped at all.
      this.clearTimer();
      this.state.setPhase('off', off, null);
      return;
    }

    // The pending timer, if any, is consumed by this tick. Cleared before any
    // await so `armed` cannot read true for a chain whose next link this tick
    // has not yet created.
    this.clearTimer();

    const config = readWatchdogConfig();
    const payload: OrchestratorRunsPayload = this.orchestrator.runs();
    const running = payload.runs.filter((run) => run.status === 'running');
    this.watching = running.map((run) => run.runId);

    // Retire the bookkeeping of every run that is no longer `running` —
    // finished normally, aborted, or archived out from under a fresh `init`.
    this.state.prune(new Set(this.watching));

    if (running.length === 0) {
      // The `idle` event marks the TRANSITION, not the condition: a sweeper
      // that is already idle and is ticked again (a stray `tick()`, a
      // Settings save while nothing runs) has nothing new to report, and a
      // line per tick would fill the 50-entry ring buffer with identical
      // text and push every real event out of it. This is the same
      // once-per-condition discipline `exhausted` and `disabled` keep below,
      // and the phase is read BEFORE `disarm()` because `disarm()` is what
      // makes it `'idle'`.
      const wasIdle = this.state.phase === 'idle';
      this.disarm();
      if (!wasIdle) {
        this.state.push({ project: null, runId: null, kind: 'idle', detail: 'no running run — standing down' });
      }
      return;
    }

    for (const run of running) {
      // Sequential, not `Promise.all`: each iteration can spawn a session,
      // and the dashboard's launch slots are a shared resource this app does
      // not own. Two projects crashing in the same minute is a real shape
      // (a machine woke from sleep), and firing both spawns at once is how
      // one of them comes back "too many launches in flight" and burns a
      // grace window for no reason.
      await this.visit(run, config);
    }

    if (this.stopped) return;
    const next = Date.now() + config.tickMs;
    this.timer = setTimeout(() => void this.tick(), config.tickMs);
    // Never keep the process alive for a tick. A watchdog is not a reason for
    // a server to refuse to exit.
    this.timer.unref();
    this.state.setPhase('armed', undefined, new Date(next).toISOString());
  }

  /**
   * Design §2.2's five steps for one `running` run, in order. The ordering
   * is load-bearing and is the spec's, not a convenience: `exhausted` is
   * decided BEFORE grace, so a run that has used its last attempt reads
   * `exhausted` on the very next tick rather than waiting out a grace window
   * first — the strip's Resume button renders on `exhausted`, and making a
   * person wait ten minutes to be told nobody is coming is the opposite of
   * what this feature is for.
   */
  private async visit(
    run: OrchestratorRunsPayload['runs'][number],
    config: ReturnType<typeof readWatchdogConfig>
  ): Promise<void> {
    // 1. Fresh — the run is alive. The only thing worth saying is that a run
    //    this sweeper had already spawned against has come back, which is
    //    also the moment it stops trying: `attempts > 0` is what makes this
    //    "the resume worked" rather than "a healthy run stayed healthy".
    if (run.fresh) {
      const entry = this.state.entry(run.runId);
      if (entry && entry.attempts > 0 && !entry.recovered) {
        entry.recovered = true;
        this.push(run, 'recovered', 'run fresh again — standing down');
      }
      return;
    }

    // From here down the run is CRASHED: `status === 'running' && !fresh`,
    // exactly the freshness `runs()` already computed against RUN_STALE_MS.
    // No second threshold is derived here, on purpose — the strip, the
    // resume route and this sweeper must never disagree about which runs are
    // dead (CLAUDE.md's "one freshness number").
    const entry = this.state.upsert(run.runId, run.project);

    // 2. The user's toggle is off. Watching continues and the crashed run is
    //    reported; only the spawn is withheld. Logged once per run — the
    //    flag lives on the entry rather than being re-derived from the event
    //    log, which is a ring buffer and cannot answer "did I already say
    //    this" once fifty other events have pushed the line out.
    if (!config.enabled) {
      if (!entry.disabledLogged) {
        entry.disabledLogged = true;
        this.push(run, 'disabled', 'watchdog off — resume by hand');
      }
      return;
    }

    // 3. The cap. `exhausted` doubles as the once-only guard for its own
    //    event, which is what makes "one line however many ticks follow"
    //    true by construction rather than by a second flag that could
    //    disagree with it.
    if (entry.attempts >= config.maxAttempts) {
      if (!entry.exhausted) {
        entry.exhausted = true;
        this.push(run, 'exhausted', `exhausted after ${entry.attempts} attempts — resume by hand`);
      }
      return;
    }

    // 4. Grace. Measured from the last spawn ATTEMPT, success or failure
    //    alike — see the class comment for why the two share one clock.
    if (entry.lastSpawnAt !== null && Date.now() - Date.parse(entry.lastSpawnAt) < config.graceMs) {
      return;
    }

    // 5. Spawn. `resume()` is the same method `POST /api/agents/resume`
    //    calls, sharing its gate rather than re-deciding any of it — the one
    //    difference a caller can make is the `origin`, which reaches the
    //    dashboard only as the session's NAME, so the session list can say
    //    who asked.
    await this.spawn(run, entry, config.maxAttempts);
  }

  private async spawn(
    run: OrchestratorRunsPayload['runs'][number],
    entry: WatchdogEntry,
    maxAttempts: number
  ): Promise<void> {
    // Stamped before the call, not after: an attempt that never returns —
    // a hung dashboard, a process killed mid-flight — has still consumed a
    // launch slot, and the next tick must back off from it exactly as it
    // would from one that answered.
    entry.lastSpawnAt = new Date().toISOString();
    try {
      const { sessionId } = await this.agents.resume(run.project, 'watchdog');
      entry.attempts += 1;
      entry.lastSessionId = sessionId;
      entry.lastError = null;
      this.push(run, 'spawned', `spawned resume ${entry.attempts}/${maxAttempts} → session ${sessionId}`);
    } catch (e) {
      // Catches EVERYTHING, deliberately. This runs inside a timer callback
      // with no caller to reject to: an escaping rejection would be an
      // unhandled promise rejection that takes the whole chain down with it,
      // and the sweeper would then stop watching precisely because something
      // went wrong — the failure mode it exists to prevent, one level up.
      // `attempts` is untouched: a refused spawn started no session.
      entry.lastError = resumeErrorMessage(e);
      this.push(run, 'failed', `resume failed: ${entry.lastError} (not counted)`);
    }
  }

  private push(
    run: OrchestratorRunsPayload['runs'][number],
    kind: 'spawned' | 'failed' | 'exhausted' | 'recovered' | 'disabled',
    detail: string
  ): void {
    this.state.push({ project: run.project, runId: run.runId, kind, detail });
  }
}

/**
 * The sentence to record for a refused resume.
 *
 * `AgentsService.resume()` reports every refusal as an `HttpException` whose
 * body is `{ error: '…' }` — the gate's own wording for a project the
 * dashboard cannot see, the dashboard's own verbatim rejection for a busy
 * one. That string is the entire value of a `failed` event: it is what tells
 * a reader whether to restart the dashboard, wait, or resume by hand.
 * `HttpException.message` is NOT that string — Nest derives it from the
 * response object only when the object has a `message` key, and these have
 * an `error` key, so it degrades to the literal `'Http Exception'`.
 *
 * The `getResponse` probe is duck-typed rather than `instanceof
 * HttpException` for the reason `readOneRun` (orchestrator.service.ts) reads
 * `.code` instead of using `instanceof` on fs errors: jest's node test
 * environment can put a realm boundary between where an object was
 * constructed and where it is being tested, and `instanceof` silently
 * evaluates false across one. A missing message here would not fail loudly —
 * it would quietly replace the one useful line in the event feed with
 * "Http Exception", which is exactly the kind of degradation nobody notices
 * until they need the feed.
 */
function resumeErrorMessage(e: unknown): string {
  const probe = e as { getResponse?: () => unknown } | null;
  const body = typeof probe?.getResponse === 'function' ? probe.getResponse() : undefined;
  if (body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  // Kept as a fallback for the exception shapes `resume()` does not throw
  // itself — anything raised below it that is not an HttpException at all.
  if (e instanceof HttpException) return e.message;
  return message(e);
}
