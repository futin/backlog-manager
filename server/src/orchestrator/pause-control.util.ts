import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { OrchestratorRun } from '../../../shared/types';

/**
 * pause-control.util.ts — `~/.backlog-manager/settings/orchestrator-control/
 * <encodeURIComponent(project)>.json`, the pause request (task-17).
 *
 * This is the SECOND file this server writes, after `watchdog.json`, and it
 * is unlike that one in the way that matters: the watchdog config is written
 * here and read here, while this file is written here and read by
 * `skills/backlog-orchestrate/tools/orchestrate.mjs` at its two dispatch
 * gates. It is the one file in this system that travels server → tool;
 * everything else (`registry.json`, `run.json`) travels tool → server.
 *
 * **Why under `settings/`, when this is emphatically not a setting.**
 * `settings/` is the read-write nested mount inside the otherwise read-only
 * `~/.backlog-manager` bind (docker-compose.yml) — it is the only ground
 * this process can write at all in the container. A control directory
 * anywhere else would either be unwritable there or would need a second
 * nested mount for one small file, and a second mount is a deployment fact a
 * future reader has to discover the hard way. So the directory is chosen for
 * writability, and this comment is the record that its NAME overstates what
 * it holds: one per-run control request, deleted on cancel and retired by
 * the run's own `unpausedAt` stamp otherwise.
 *
 * **Why a file and not a field on `run.json`.** That file has exactly one
 * writer, `orchestrate.mjs` (CLAUDE.md's invariant). A pause request starts
 * in a browser and has to reach a headless session that may be minutes into
 * a `claude -p` child; the filesystem is the only channel between them. A
 * second writer on `run.json` would trade a well-understood single-writer
 * guarantee for a lost-update race against a run that re-stamps its own
 * heartbeat every few turns — and `run.json`'s single writer is not a
 * convention here, it is the thing the whole orchestrator's crash recovery
 * rests on.
 *
 * **Why the effectiveness predicate is duplicated rather than shared.**
 * `orchestrate.mjs` carries its own `pauseRequestEffective`, byte-equivalent
 * to the one below. A skill's `tools/` may never import from this server
 * (nor the reverse) — the same boundary that already forces `orchHome()` to
 * exist twice, and `linkedWorktreeInfo` to exist twice. The predicate is
 * DERIVED on both sides and stored on neither: a stored verdict would be a
 * second answer to a question whose inputs (the file, `startedAt`,
 * `unpausedAt`) all move underneath it, which is precisely the bug class the
 * watchdog's `exhausted` flag was.
 *
 * Read fresh on every call and never cached, for the reason
 * `readWatchdogConfig` gives: the writer here is a browser request seconds
 * old, the reader is a poll a few seconds later, and there is nothing a
 * cache could save that is worth an answer this stale.
 */

/** The shape written to, and expected back from, the control file — the
 *  whole file, not a fragment of a larger one. `orchestrate.mjs` reads the
 *  same two keys and ignores nothing else, because there is nothing else. */
export interface PauseRequest {
  runId: string;
  requestedAt: string;
}

/**
 * `~/.backlog-manager/settings/orchestrator-control`, or
 * `$BM_ORCH_CONTROL_HOME` when set — the same override-a-computed-default
 * shape `watchdogFile()` uses, and the same variable `orchestrate.mjs`'s own
 * `controlHome()` reads. `env` is a parameter rather than a bare
 * `process.env` read so a test can hand it a plain object without mutating
 * the process-wide environment.
 */
export function controlHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_ORCH_CONTROL_HOME || join(homedir(), '.backlog-manager', 'settings', 'orchestrator-control');
}

/**
 * One flat file per project, keyed `encodeURIComponent(<abs path>)` — the
 * same reversible key `orchestrate.mjs`'s `projectDir` uses for its run
 * directories, but flat, because there is exactly one control fact per
 * project and nothing to keep beside it.
 */
export function controlFile(project: string, root: string = controlHome()): string {
  return join(root, `${encodeURIComponent(project)}.json`);
}

/**
 * This project's pause request, or `null` for every way there isn't one:
 * no file, unreadable file, unparseable JSON, a non-object parse, or either
 * required field missing or not a string.
 *
 * Total by construction. The file is written by one process and read by
 * another; a malformed one must never throw out of a request handler, and
 * the tool's own copy of this function takes the identical posture at its
 * dispatch gate, where throwing would wedge a run.
 */
export function readPauseRequest(project: string, root: string = controlHome()): PauseRequest | null {
  let text: string;
  try {
    text = readFileSync(controlFile(project, root), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { runId, requestedAt } = parsed as Partial<PauseRequest>;
  if (typeof runId !== 'string' || typeof requestedAt !== 'string') return null;
  return { runId, requestedAt };
}

/**
 * Is this request one THIS run must act on? Two clauses, both load-bearing:
 *
 *   - `runId` pins a request to one run, so a request that outlived the run
 *     it was made for — a cancel that never arrived, a crash — can never
 *     pause the NEXT run of the same project.
 *   - `requestedAt` must post-date the run's most recent start:
 *     `unpausedAt` when the run has been resumed, `startedAt` otherwise.
 *     This is what RETIRES a request. Without it, a resumed run would read
 *     the very file that paused it at its first dispatch gate and pause
 *     itself again, forever — and no one deletes that file, because the
 *     resume path's `clearPauseRequest` is tidiness (a spawn that never
 *     reaches the session leaves the file behind) rather than correctness.
 *
 * Every malformed or unparseable input answers `false`: a request this
 * function cannot understand is not one a run should stop for.
 *
 * Takes a `Pick`, not a whole run, so a caller can never be tempted to make
 * the answer depend on anything but these three fields — the tool's copy has
 * only these three to work with.
 */
export function pauseRequestEffective(
  request: PauseRequest | null,
  run: Pick<OrchestratorRun, 'runId' | 'startedAt' | 'unpausedAt'>
): boolean {
  if (request === null) return false;
  if (request.runId !== run.runId) return false;

  const requestedAt = Date.parse(request.requestedAt);
  const since = Date.parse(run.unpausedAt ?? run.startedAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(since)) return false;
  return requestedAt > since;
}

/**
 * Records a pause request for `project` against `runId`, returning exactly
 * what landed on disk so the caller can re-derive the verdict from the same
 * bytes rather than echo its own request back.
 *
 * Written atomically the same way `writeWatchdogConfig`, `writeRunAtomic`
 * and `moveItem` are — full content into a temp file in the SAME directory
 * (so the rename is on one filesystem and therefore atomic at the OS level),
 * then `renameSync` in one step. That matters more here than for the
 * watchdog config: the reader is a DIFFERENT process, polling this path at
 * every dispatch gate, and a half-written file it happened to catch would
 * read as no request at all — a pause silently dropped.
 *
 * `now` is a parameter for the reason every other clock in this codebase is:
 * a test needs one reading it controls, and the stamp is compared against a
 * run's own timestamps rather than merely displayed.
 */
export function writePauseRequest(
  project: string,
  runId: string,
  now: Date = new Date(),
  root: string = controlHome()
): PauseRequest {
  const request: PauseRequest = { runId, requestedAt: now.toISOString() };
  const file = controlFile(project, root);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.control.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(request, null, 2) + '\n');
  renameSync(tmp, file);
  return request;
}

/**
 * Deletes the request, if there is one. `force: true` makes an absent file a
 * no-op rather than a throw, which is the behaviour every caller wants: a
 * cancel for a project that was never paused is a request the user is
 * entitled to make, and the resume path clears the file speculatively.
 */
export function clearPauseRequest(project: string, root: string = controlHome()): void {
  rmSync(controlFile(project, root), { force: true });
}
