import { Injectable } from '@nestjs/common';

import { RUN_STALE_MS } from '../../../shared/types';
import type { OrchestratorRun, StartingRun } from '../../../shared/types';

/**
 * starting-runs.service.ts — the in-memory record of "this server spawned an
 * orchestrator session for that project, and no run file has appeared for it
 * yet" (task-14).
 *
 * The gap this closes: `GET /api/orchestrator/runs` can only see run files,
 * and the first one is written by `orchestrate.mjs init` (SKILL.md §2), so a
 * board-started run is invisible for the 1–5 minutes the dashboard spawn, the
 * session boot, the 1360-line SKILL.md read and the §1 `plan` turn take. This
 * makes that stretch VISIBLE; it does not make it shorter, and nothing here
 * is a latency fix.
 *
 * **This is not a cache, and it is not a second writer.** `OrchestratorService`
 * refuses to cache run files because a running orchestrator re-stamps
 * `run.json` on every heartbeat and the board's whole job is to watch that
 * happen live (see that service's own class comment). Nothing in here is a
 * copy of anything on disk: an entry is a record of a request THIS PROCESS
 * made, which no file on disk can answer at all until `init` lands. It is
 * never persisted — CLAUDE.md's "the run file has exactly one writer"
 * invariant is untouched, and the reason this whole design was chosen over
 * having the server call `init` itself is that doing so would make the
 * spawned session hit `init`'s exit `4` (lock held), whose documented answer
 * in SKILL.md is "never retry, go to `--resume`".
 *
 * Volatile on purpose, the same posture `WatchdogStateService` takes: a
 * server restart forgets every entry, and the real runs are unaffected —
 * the worst case is a board that goes back to showing nothing for the
 * remainder of a boot it was already showing nothing for before this feature
 * existed.
 *
 * **Pure/mutating split, and why the two halves must share one predicate.**
 * `list()` is the pure filter `OrchestratorService.runs()` calls (which is
 * documented as a pure read, its one side effect having been deliberately
 * moved out to the controller); `sweep()` is the mutation
 * `OrchestratorController.runs()` calls afterwards, beside
 * `watchdogState.observe()` and for the identical reason. They are the exact
 * counterparts of that service's `annotate()`/`observe()` pair. Both defer to
 * the SAME private `expired()` predicate rather than being two expressions
 * that agree, for the reason `watchdogStoodDown` (shared/agent.ts) is one
 * function rather than the strip's expression plus the sweeper's: a `list`
 * that could return an entry `sweep` would delete — or the reverse — is the
 * bug this shape makes impossible to write.
 *
 * **Correctness never depends on the sweep.** `list()` re-applies both
 * eviction rules on every call, so an entry nobody ever sweeps is filtered
 * out of every payload anyway: an unswept map leaks memory (bounded at one
 * entry per project), it never lies. That is what makes `AgentsService`'s own
 * direct `runs()` calls — the `RUN_IN_PROGRESS` lock check, and `resume()` —
 * safe despite bypassing the controller and therefore never sweeping. Do not
 * "fix" that by folding `sweep` back into `list`; the next
 * `GET /api/orchestrator/runs` clears whatever those calls left behind.
 */
@Injectable()
export class StartingRunsService {
  /**
   * Project path → the `Date.now()` at which its spawn resolved. One entry
   * per project, so a second POST for the same project overwrites rather
   * than accumulating. (Two rapid POSTs before `init` lands is an existing
   * race the pre-spawn lock cannot catch — it only fires against a *fresh*
   * `run.json`, and there is no run file at all yet. Overwriting neither
   * creates that race nor worsens it; it just refuses to grow a second card
   * for it.)
   *
   * Keyed by project rather than by anything run-shaped because a project is
   * the only identity that exists at this point: there is no runId, no
   * startedAt and no queue until `init` writes one.
   */
  private readonly marks = new Map<string, number>();

  /** Record that a spawn for `project` has just succeeded. Called from
   *  `AgentsController.orchestrate()` AFTER the awaited spawn resolves, so a
   *  spawn that throws leaves no entry behind. */
  mark(project: string): void {
    this.marks.set(project, Date.now());
  }

  /**
   * The live entries, given the real runs the caller has just read off disk.
   * **Pure — never touches the map**, so it is safe inside
   * `OrchestratorService.runs()`.
   *
   * `now` is injectable for the tests that pin the `RUN_STALE_MS` boundary in
   * both directions; production callers pass nothing.
   */
  list(realRuns: readonly OrchestratorRun[], now: number = Date.now()): StartingRun[] {
    const live: StartingRun[] = [];
    for (const [project, requestedAt] of this.marks) {
      if (this.expired(project, requestedAt, realRuns, now)) continue;
      live.push({ project, requestedAt: new Date(requestedAt).toISOString() });
    }
    return live;
  }

  /**
   * Delete every entry `list` would have filtered out. Called from
   * `OrchestratorController.runs()` once the payload is built — the same
   * layer, and the same reasoning, as `WatchdogStateService.observe()`.
   *
   * No timers and no background work: the prune still happens per request,
   * one layer up from where it used to sit in the approved design.
   */
  sweep(realRuns: readonly OrchestratorRun[], now: number = Date.now()): void {
    for (const [project, requestedAt] of [...this.marks]) {
      if (this.expired(project, requestedAt, realRuns, now)) this.marks.delete(project);
    }
  }

  /**
   * The ONE eviction rule, shared by both methods above. An entry stops
   * being live when either holds:
   *
   *   1. **A real run for that project has landed.** A run in `realRuns`
   *      whose `project` matches and whose `startedAt` parses to at or after
   *      `requestedAt`. `startedAt`, emphatically not "a run.json exists for
   *      this project": `cmdInit` archives the previous `run.json` into
   *      `runs/` and writes a fresh one, so a project that has ever run
   *      already has a file, and mere existence would evict the placeholder
   *      on the very first poll for every project but a first-ever run. An
   *      unparseable `startedAt` is NOT a match — `Date.parse` gives NaN and
   *      every comparison against NaN is false, which lands on "keep" by
   *      construction rather than by an explicit branch; a run file this
   *      reader cannot date cannot prove it is the run that was asked for.
   *
   *   2. **The entry is older than `RUN_STALE_MS`.** The app's one freshness
   *      number (shared/types.ts, whose own comment claims to be exactly
   *      that), reused rather than joined by a second one. A session that
   *      spawned but never reached `init` is a broken session, diagnosed at
   *      the dashboard where its transcript is — not by a card that claims
   *      it is still starting forever.
   */
  private expired(
    project: string,
    requestedAt: number,
    realRuns: readonly OrchestratorRun[],
    now: number
  ): boolean {
    if (now - requestedAt > RUN_STALE_MS) return true;
    return realRuns.some((run) => run.project === project && Date.parse(run.startedAt) >= requestedAt);
  }
}
