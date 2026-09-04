import { Injectable } from '@nestjs/common';

import { readAgentsConfig } from '../agents/config.util';
import { readWatchdogConfig, watchdogEnvOff } from './watchdog-config.util';
import { WATCHDOG_EVENT_CAP } from '../../../shared/types';
import type {
  OrchestratorRun,
  OrchestratorRunsPayload,
  RunWatchdog,
  WatchdogConfig,
  WatchdogEvent,
  WatchdogPhase,
  WatchdogStatus
} from '../../../shared/types';

/**
 * watchdog-state.service.ts — the sweeper's in-memory memory, read by the
 * endpoints this file's neighbours already serve.
 *
 * This lives in `orchestrator/`, not `agents/` where the sweeper itself will
 * (design §2, Task 3), and that placement is about dependency direction, not
 * about which module "owns" watchdog behaviour. `OrchestratorService.runs()`
 * has to annotate every crashed run's payload entry from whatever this
 * service knows about it — that read has to happen inside `orchestrator/`,
 * because `runs()` is what builds the payload in the first place. `agents/`
 * already imports `orchestrator/` (`AgentsModule` pulls in `OrchestratorModule`
 * for `AgentsService.resume()`'s own use of `runs()`), never the other way
 * around, so a sweeper living in `agents/` can depend on a state service
 * living in `orchestrator/` with no cycle — the reverse placement would force
 * one. Concretely: the sweeper (Task 3) WRITES into this service (`upsert`,
 * `push`, `setPhase`) every time it ticks; `OrchestratorService.runs()` and
 * `OrchestratorController.runs()` READ it (`annotate`, `observe`) on every
 * poll the board already makes. This service itself never spawns anything —
 * no `AgentsService` reference, no HTTP call, no child process — it only
 * holds data and answers questions about it, which is what makes it safe for
 * the *reader* side of the app to depend on directly instead of waiting on
 * the sweeper to exist (this task ships with no sweeper at all yet; `runs()`
 * annotates from a service nothing has written to, which is exactly the
 * "undefined for every run" case its own tests pin).
 *
 * State here is deliberately volatile (design §9): attempts, phase and the
 * event log all live only in this process's memory, never on disk, never in
 * a run's own `run.json` (that file stays `orchestrate.mjs`'s alone to
 * write — CLAUDE.md's single-writer invariant, unchanged by this feature).
 * A server restart forgets every attempt a crashed run has already received,
 * so the worst case after a restart is up to `maxAttempts` MORE spawns
 * against that run, not an unbounded pile-up — an acceptable trade against
 * the alternative of teaching yet another file how to survive concurrent
 * writers.
 */

/**
 * One crashed run's watchdog bookkeeping — everything the sweeper needs to
 * remember between ticks that the run file itself neither has nor should
 * have (design's own non-goal: no durable "auto-resumed" trail on the run).
 * `recovered` and `disabledLogged` are per-entry flags rather than the
 * sweeper re-deriving "have I already said this" from the event log on
 * every tick: the log is a ring buffer that drops its oldest entries
 * (`WATCHDOG_EVENT_CAP`), so it cannot answer "did I already log this" once
 * enough OTHER events have pushed the relevant line out — only a flag that
 * lives as long as the entry itself can answer that reliably. Exported so
 * the sweeper (`agents/watchdog.service.ts`, Task 3) can name this shape
 * when it reads back what `entry()`/`upsert()` hand it, without this file
 * needing to round-trip through `shared/types.ts` for something no client
 * or cross-process boundary ever sees — unlike `RunWatchdog` below, nothing
 * about this shape crosses the wire.
 */
export interface WatchdogEntry {
  runId: string;
  project: string;
  attempts: number;
  lastSpawnAt: string | null;
  lastSessionId: string | null;
  lastError: string | null;
  exhausted: boolean;
  recovered: boolean;
  disabledLogged: boolean;
}

@Injectable()
export class WatchdogStateService {
  /**
   * The sweeper's own phase (design §1) — `'idle'` at construction because a
   * server that has just booted has not yet taken its first `runs()` read
   * (Task 3's `onApplicationBootstrap` scan), so it does not yet know
   * whether anything is running, and "armed" would be a claim this service
   * cannot back up before that first read completes. `'off'` is something
   * only the sweeper itself can determine (it is the one place that reads
   * `watchdogEnvOff`/`BM_AGENTS` to decide whether it may ever arm at all)
   * and set via `setPhase` — this constructor makes no claim either way.
   */
  phase: WatchdogPhase = 'idle';
  reason: string | undefined;
  nextTickAt: string | null = null;

  /** Keyed by `runId`, exactly as `runs()` and `prune()` both key their own
   *  work — a project can have at most one `running` run at a time (CLAUDE.md's
   *  "one run per project"), but keying by `runId` rather than `project`
   *  costs nothing and survives a project starting a fresh run under a new
   *  `runId` without this service needing to notice the old key is stale
   *  itself; `prune()` (called every tick against the current `runs()` read)
   *  is what actually retires it. */
  private readonly entries = new Map<string, WatchdogEntry>();

  /** Newest event at index 0 — `push` unshifts and then trims from the end,
   *  so the oldest entries are the ones a long-running server eventually
   *  drops, never the newest ones a viewer just wrote to disk. */
  private readonly ringBuffer: WatchdogEvent[] = [];

  /** Registered once, by the sweeper's own constructor (Task 3) — this
   *  service never constructs a `WatchdogService` itself (that would be the
   *  cycle the class comment above says this placement avoids), so arming
   *  is a callback handed in rather than a direct method call. Absent for
   *  the entire lifetime of THIS task, since nothing yet calls `setArmer` —
   *  `observe()` has to stay a safe no-op under that exact condition, which
   *  is its own pinned test case rather than an oversight. */
  private armer: (() => void) | undefined;

  setPhase(phase: WatchdogPhase, reason?: string, nextTickAt: string | null = null): void {
    this.phase = phase;
    this.reason = reason;
    this.nextTickAt = nextTickAt;
  }

  entry(runId: string): WatchdogEntry | undefined {
    return this.entries.get(runId);
  }

  /** Returns the SAME object on every call for a given `runId` once it
   *  exists — the sweeper mutates the fields of what this returns in place
   *  (`e.attempts += 1`, etc.) rather than calling a setter per field, so an
   *  `upsert` that returned a fresh copy each time would silently discard
   *  every earlier tick's writes. */
  upsert(runId: string, project: string): WatchdogEntry {
    let entry = this.entries.get(runId);
    if (!entry) {
      entry = {
        runId,
        project,
        attempts: 0,
        lastSpawnAt: null,
        lastSessionId: null,
        lastError: null,
        exhausted: false,
        recovered: false,
        disabledLogged: false
      };
      this.entries.set(runId, entry);
    }
    return entry;
  }

  /** Drops every entry whose `runId` is not in `keep` — the sweeper's own
   *  per-tick call with the full set of currently-`running` `runId`s, which
   *  is what actually retires a run's bookkeeping once `orchestrate.mjs`
   *  moves it to `done`/`aborted`/`failed` or archives it out from under a
   *  fresh `init`. Nothing here decides retirement policy; it only performs
   *  whatever the caller already decided. */
  prune(keep: ReadonlySet<string>): void {
    for (const runId of this.entries.keys()) {
      if (!keep.has(runId)) this.entries.delete(runId);
    }
  }

  /** Ring buffer, capped at `WATCHDOG_EVENT_CAP`. `at` defaults to `new
   *  Date()` rather than being computed by every caller, so a test can pin
   *  an exact timestamp without every production call site needing to
   *  thread one through — the same optional-trailing-clock-parameter shape
   *  `backlog.mjs`'s own timestamp-writing functions use for the identical
   *  reason. */
  push(event: Omit<WatchdogEvent, 'at'>, at: Date = new Date()): void {
    this.ringBuffer.unshift({ ...event, at: at.toISOString() });
    if (this.ringBuffer.length > WATCHDOG_EVENT_CAP) this.ringBuffer.length = WATCHDOG_EVENT_CAP;
  }

  /** A copy, not the live array — callers (the `/api/agents/watchdog` route,
   *  and `status()` below) must not be able to mutate this service's own
   *  history by mutating what they were handed. */
  events(): WatchdogEvent[] {
    return [...this.ringBuffer];
  }

  /**
   * Whether the sweeper (once it exists) is allowed to actually SPAWN a
   * resume — as opposed to merely watching and reporting. Three
   * independent gates, all read fresh on every call rather than cached:
   * the operator's kill switch (`watchdogEnvOff`, `BM_WATCHDOG=off`), the
   * outbound-calling feature flag everything in `agents/` already answers
   * to (`readAgentsConfig().enabled`, `BM_AGENTS`), and the user's own
   * Settings toggle (`readWatchdogConfig().enabled`, design §5). Any one of
   * the three being false means "do not spawn," which is why this is a
   * plain `&&` chain rather than three separately-reported reasons — the
   * one caller that needs to explain WHY (the Settings row, `status()`'s
   * `WatchdogStatus.reason`) reports the sweeper's own phase separately, not
   * this boolean broken down field by field.
   */
  spawningEnabled(): boolean {
    return !watchdogEnvOff() && readAgentsConfig().enabled && readWatchdogConfig().enabled;
  }

  /**
   * The one method `OrchestratorService.runs()` calls per run, and the
   * whole reason this service lives beside it rather than in `agents/`.
   * `undefined` in every case but one — a crashed run, `status === 'running'
   * && !fresh`, exactly `RunWatchdog`'s own doc comment in shared/types.ts —
   * because that is the only state in which a watchdog record MEANS
   * anything:
   *
   * - A `done`/`aborted`/`failed` run has nothing left to watch — the
   *   sweeper will `prune()` its entry (if any) on its very next tick, and
   *   attaching a stale watchdog record to a finished run's payload entry
   *   would tell a viewer "this is still being resumed" about a run that
   *   is not.
   * - A fresh, healthy `running` run was never a watchdog SUBJECT in the
   *   first place — it may be armed-against in the sense that the sweeper
   *   is watching it tick by tick (design §1's "armed" covers fresh runs
   *   too), but nothing has happened to it worth reporting, and a
   *   `RunWatchdog` with every field zeroed would be indistinguishable from
   *   a genuinely crashed-but-untouched run (case below) to any caller that
   *   didn't also re-derive freshness itself — exactly the "make every
   *   caller branch on a default that means nothing" trap `OrchestratorRunsPayload`'s
   *   own comment on this field's optionality already names.
   *
   * For the one case that does return a value, `entry(run.runId)` may
   * itself be `undefined` — a run can go stale before the sweeper's very
   * first tick ever reaches it, or before any task in this repo ships a
   * sweeper at all, which is exactly this task's own situation — so every
   * field the entry would have supplied falls back to its own zero value
   * rather than the whole method returning `undefined` for that case too:
   * a crashed run the sweeper has never touched still needs to read as
   * "watchdog: waiting for next check," not "no watchdog exists," which is
   * a different, wrong claim about a run that unambiguously qualifies.
   */
  annotate(run: OrchestratorRun & { fresh: boolean }): RunWatchdog | undefined {
    if (!(run.status === 'running' && !run.fresh)) return undefined;
    const entry = this.entry(run.runId);
    return {
      enabled: this.spawningEnabled(),
      attempts: entry?.attempts ?? 0,
      maxAttempts: readWatchdogConfig().maxAttempts,
      lastSpawnAt: entry?.lastSpawnAt ?? null,
      lastSessionId: entry?.lastSessionId ?? null,
      lastError: entry?.lastError ?? null,
      exhausted: entry?.exhausted ?? false
    };
  }

  /** Registered once by the sweeper's own bootstrap (Task 3); nothing else
   *  ever calls this. A plain setter rather than a constructor argument
   *  because the dependency runs the other way — the sweeper depends on
   *  THIS service (to arm through it), so this service cannot also depend
   *  on the sweeper to receive the callback at construction time without
   *  reintroducing the very cycle the class comment above explains this
   *  placement avoids. */
  setArmer(fn: () => void): void {
    this.armer = fn;
  }

  /**
   * The one side effect `OrchestratorController.runs()` performs after
   * building its payload (never inside `OrchestratorService.runs()` itself,
   * which stays a pure read — see that method's own comment). If any run in
   * the payload is `status === 'running'` — fresh or crashed alike, exactly
   * design §1's "armed" — and a sweeper has registered an armer via
   * `setArmer`, that armer runs. This is how a board that has simply been
   * open and polling this endpoint the whole time can arm a sweeper that
   * bootstrapped AFTER that run started: without this call, the sweeper
   * would only ever learn a run exists from its own bootstrap scan or from
   * a spawn IT made — never from a run someone else's terminal started and
   * the board merely happens to be watching.
   *
   * A safe no-op with no armer registered — this task ships no sweeper, so
   * every call this task's own tests make to `observe()` exercises exactly
   * that no-op path, which is deliberately its own pinned case rather than
   * incidental: the day Task 3 lands and calls `setArmer`, this method's
   * behaviour must not need to change to accommodate it.
   */
  observe(payload: OrchestratorRunsPayload): void {
    if (!this.armer) return;
    if (payload.runs.some((run) => run.status === 'running')) this.armer();
  }

  /**
   * Assembles `GET /api/agents/watchdog`'s whole response (design §4.2) from
   * this service's own phase/reason/nextTickAt/events plus two values only
   * the caller can supply: `config` (the controller's own fresh
   * `readWatchdogConfig()` read — this service does not re-read it here so
   * a caller building a response from a config it deliberately just patched
   * via `POST /api/agents/watchdog/config` sees THAT value reflected, not a
   * second independent read that could theoretically race it) and
   * `watching` (the live `runId`s currently `running`, which only the
   * caller's own fresh `runs()` read can supply — this service has no
   * standing view of which runs currently exist, only bookkeeping about the
   * ones it has been told about).
   */
  status(config: WatchdogConfig, watching: string[]): WatchdogStatus {
    return {
      phase: this.phase,
      reason: this.reason,
      nextTickAt: this.nextTickAt,
      config,
      watching,
      events: this.events()
    };
  }
}
