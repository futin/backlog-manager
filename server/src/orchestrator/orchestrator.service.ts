import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

import { RUN_STALE_MS } from '../../../shared/types';
import type {
  OrchestratorArchivePayload,
  OrchestratorArchiveRun,
  OrchestratorRun,
  OrchestratorRunsPayload
} from '../../../shared/types';

/**
 * `$BM_ORCH_HOME` when set, else `~/.backlog-manager/orchestrator/` — must
 * resolve identically to orchestrate.mjs's own `orchHome()`
 * (skills/backlog-orchestrate/tools/orchestrate.mjs), because that tool is
 * the only writer of everything this service reads: a mismatch here would
 * have the board watching an empty directory while the CLI writes real runs
 * a few characters away. A plain exported function, not a value captured
 * once — see OrchestratorService.runs() below for why it is called fresh
 * on every request rather than resolved at construction.
 */
export function orchHome(): string {
  return process.env.BM_ORCH_HOME || join(homedir(), '.backlog-manager', 'orchestrator');
}

/**
 * `JSON.parse` alone only proves the file held *some* JSON value — a
 * truncated write, a hand-edit, or an unrelated file that happens to parse
 * (a bare `42`, `{}`) would otherwise be spread straight into the API
 * response as a fake run. This checks just enough fields to make every read
 * this service performs on the result safe (the two used for `fresh`, plus
 * the two that identify a run as a run at all), the same "enough to be safe
 * downstream, not a full schema" scope as RegistryService's
 * isRegistryProject.
 */
function isPlausibleRun(value: unknown): value is OrchestratorRun {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<OrchestratorRun>;
  return (
    typeof r.runId === 'string' &&
    typeof r.project === 'string' &&
    typeof r.status === 'string' &&
    typeof r.updatedAt === 'string' &&
    Array.isArray(r.queue)
  );
}

/**
 * `run-YYYYMMDD-HHMMSS`, optionally suffixed `-<n>` for a same-second
 * collision — the exact shape `archivePath` (orchestrate.mjs) mints, and
 * `archivedRun()` below's first guard. Tested before anything else touches
 * the filesystem: the threat this exists to name is traversal
 * (`../../etc/passwd`-shaped input), and the only way to be sure a
 * traversal-shaped runId never reaches `path.join` is to reject it before
 * the first join, not to join first and hope the result stays inside a
 * directory this service intended.
 */
const RUN_ID_RE = /^run-\d{8}-\d{6}(-\d+)?$/;

/** Directory-entry count for one project's archived-runs folder, 0 when it
 *  doesn't exist yet (no run for this project has ever been superseded by a
 *  later `init` — see orchestrate.mjs's own archiving comment on cmdInit). */
function countPastRuns(runsDir: string): number {
  try {
    return readdirSync(runsDir).length;
  } catch {
    return 0;
  }
}

/**
 * Parses and validates one run file at `path`, skip-and-warn on failure —
 * the exact behaviour `runs()` inlines for `run.json` alone, factored out
 * here because `archive()` (below) performs this same read twice per
 * project: once for `run.json`, once per `runs/*.json` sibling. `label` is
 * folded into the warning so a skipped archived file names itself
 * (`runs/run-20260831-211011.json for "…"`) rather than borrowing
 * `run.json`'s own wording for a file that isn't `run.json`.
 *
 * `expectMiss` (default false) exists for one more caller: `archivedRun()`'s
 * speculative probe of `runs/<runId>.json` (below) tries that exact path
 * before knowing whether an archived file with that name exists at all — for
 * a request naming the *current* run (arguably the most common shape a
 * request takes), it never will, and that miss is not a problem to report,
 * just the probe finding out "no, check run.json instead." Passing
 * `expectMiss: true` keeps THAT ONE outcome — the file genuinely absent,
 * `ENOENT` — silent. Every other way this function can fail still warns
 * exactly as before, `expectMiss` or not: a permission error, truncated
 * JSON, a file that parses but isn't shaped like a run. Those are facts
 * about a file that exists and is broken, which is a different situation
 * from a file that was never there to begin with, and only the caller
 * making a speculative "does this exist" probe knows to read an absence as
 * the harmless answer to its own question rather than as a problem.
 */
function readOneRun(path: string, label: string, expectMiss = false): OrchestratorRun | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    // `.code`, not `e instanceof Error`: a plain property read survives
    // across the realm boundary Jest's node test environment puts between a
    // built-in fs error (constructed in Node's own realm) and this module's
    // `Error` global (rebound inside the test VM context) — `instanceof`
    // does not, so it silently evaluates false here for every fs error, the
    // same reason the fallback branch below (`String(e)`, not `e.message`)
    // already fires in this suite's own warning output. Guarding with
    // `typeof e === 'object'` first, not just casting straight to
    // ErrnoException, is what keeps this safe for the JSON.parse branch too:
    // a SyntaxError has no `.code` at all, so `code === 'ENOENT'` is simply
    // false for it rather than throwing on a read from `null`/`undefined`.
    const code = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
    const isExpectedMiss = expectMiss && code === 'ENOENT';
    if (!isExpectedMiss) {
      // Covers both "not valid JSON" and "doesn't exist at all" (a missing
      // run.json reads as ENOENT here, same as runs() treats it) — a project
      // dir that only ever has runs/ and no current run.json is a legitimate
      // shape (a crashed-then-cleaned run), so this is skip-and-warn, not a
      // reason to fail the whole payload.
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`orchestrator: ${label} is unreadable or not valid JSON, skipping (${message})`);
    }
    return null;
  }
  if (!isPlausibleRun(parsed)) {
    console.warn(`orchestrator: ${label} parsed but is not a run, skipping`);
    return null;
  }
  return parsed;
}

/**
 * Builds a new `OrchestratorArchiveRun` from a parsed run rather than
 * mutating the parsed object in place — `run` may still be aliased to
 * nothing else today, but the whole point of building fresh objects at
 * every level (the run, its queue array, each item, each verification
 * entry) is that `archive()` never has to reason about aliasing as this
 * shape picks up more differences from `OrchestratorRun` later. Today the
 * only difference is verification tails stripped to `{cmd, ok}` (see
 * `VerificationSummary`'s doc comment in shared/types.ts for why) plus the
 * `current` flag this function is also responsible for stamping.
 */
function toArchiveEntry(run: OrchestratorRun, current: boolean): OrchestratorArchiveRun {
  return {
    ...run,
    queue: run.queue.map((item) => ({
      ...item,
      verification: item.verification.map(({ cmd, ok }) => ({ cmd, ok }))
    })),
    current
  };
}

/**
 * Read-only view of the orchestrator's run-state directory
 * (~/.backlog-manager/orchestrator/, or $BM_ORCH_HOME) — the same role
 * RegistryService (server/src/registry/registry.service.ts) plays for
 * ~/.backlog-manager/registry.json, pointed at a different tree: written
 * only by skills/backlog-orchestrate/tools/orchestrate.mjs, never by this
 * process, and read fresh on every call rather than cached. A running
 * orchestrate.mjs process re-stamps run.json on every heartbeat, and the
 * whole point of this endpoint is to let the board watch that happen live —
 * a cache here would show a run frozen at whatever moment the server last
 * happened to read it.
 *
 * Unlike ItemsService, this service takes no RegistryModule dependency: a
 * run's project identity lives entirely inside its own run.json (`project`,
 * the same absolute path RegistryProject.path would carry), so there is
 * nothing to cross-reference — this service only ever walks orchHome()'s
 * own subdirectories, one per project that has ever had a run.
 */
@Injectable()
export class OrchestratorService {
  runs(): OrchestratorRunsPayload {
    const root = orchHome();
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // No orchestrator state directory at all — nothing has ever run here.
      // Not an error: the board's "no runs yet" empty state, the same
      // spirit as RegistryService returning { projects: [] } for a missing
      // registry file rather than a 500.
      return { runs: [] };
    }

    const runs: OrchestratorRunsPayload['runs'] = [];
    for (const name of entries) {
      const dir = join(root, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
      } catch (e) {
        // Missing run.json (a stray non-project entry), unreadable, or not
        // valid JSON at all — skip this one project rather than fail the
        // whole payload. A board showing three runs out of four beats one
        // showing none because a single file on disk is mid-write or
        // hand-edited.
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`orchestrator: run.json for "${name}" is unreadable or not valid JSON, skipping (${message})`);
        continue;
      }
      if (!isPlausibleRun(parsed)) {
        console.warn(`orchestrator: run.json for "${name}" parsed but is not a run, skipping`);
        continue;
      }

      const fresh = parsed.status === 'running' && Date.now() - Date.parse(parsed.updatedAt) < RUN_STALE_MS;
      const pastRuns = countPastRuns(join(dir, 'runs'));
      runs.push({ ...parsed, fresh, pastRuns });
    }

    return { runs };
  }

  /**
   * Every run this orchestrator state directory has ever recorded, across
   * every project — the archive view's (Task 4) data source. Where runs()
   * exists for the live board strip (one entry per project, `fresh`/
   * `pastRuns` annotated, tails intact because a live run's own detail is
   * what the drawer renders from directly), this exists for browsing
   * history: every project's `run.json` *and* every `runs/*.json` sibling,
   * flattened into one list with tails stripped so the payload's size
   * tracks run count rather than run count times average test-output size.
   */
  archive(): OrchestratorArchivePayload {
    const root = orchHome();
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // Same empty-state reasoning as runs(): no state directory at all
      // means nothing has ever run here, not an error.
      return { runs: [] };
    }

    const runs: OrchestratorArchiveRun[] = [];
    for (const name of entries) {
      const dir = join(root, name);
      const projectRuns: OrchestratorArchiveRun[] = [];

      // run.json — this project's current/latest run, if any. Absent is a
      // legitimate shape (a crashed-then-cleaned project dir with only
      // archived history left, or one whose only run never finished
      // writing this file) — readOneRun already skip-and-warns on it, so
      // there is nothing further to do here beyond checking for null.
      const current = readOneRun(join(dir, 'run.json'), `run.json for "${name}"`);
      if (current) projectRuns.push(toArchiveEntry(current, true));

      // runs/ — every run this project has archived, one file per
      // superseded run. A project with only ever one run has no runs/ dir
      // at all, which is exactly as unremarkable as countPastRuns treats
      // it above: no warning, no entries, just an empty read.
      let runFiles: string[];
      try {
        runFiles = readdirSync(join(dir, 'runs'));
      } catch {
        runFiles = [];
      }
      for (const file of runFiles) {
        const archived = readOneRun(join(dir, 'runs', file), `runs/${file} for "${name}"`);
        if (archived) projectRuns.push(toArchiveEntry(archived, false));
      }

      // Newest first within this project. Plain string comparison is
      // correct here, not just convenient: a runId embeds a second-
      // precision timestamp (run-YYYYMMDD-HHMMSS), and a `-2` collision
      // suffix sorts after its unsuffixed base under '<' the same way
      // "abc" sorts before "abcd" — the suffixed run was archived later,
      // so descending order correctly puts it first. Projects themselves
      // are appended in readdirSync order rather than interleaved; the
      // client re-sorts the flattened list globally (Task 4).
      projectRuns.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
      runs.push(...projectRuns);
    }

    return { runs };
  }

  /**
   * One run file, verbatim (tails included) — the detail pane's data source
   * (Task 2), the companion to archive() above: that method lists every run
   * with tails stripped so the payload scales with run count, this one
   * fetches a single run in full for the one entry a user actually opens.
   *
   * Two guards run in order before either `project` or `runId` — both
   * caller-supplied, both riding in as raw query-string values by the time
   * they reach the controller — is allowed anywhere near a filesystem path:
   *
   *   1. RUN_ID_RE above rejects anything not shaped like a run id, so a
   *      traversal or shell-metacharacter payload never survives to be
   *      joined into a path at all.
   *   2. `encodeURIComponent(project)` is checked for *string equality*
   *      against an entry `readdirSync(orchHome())` actually returned — the
   *      same allowlist-by-listing shape server/src/items/allow.util.ts uses
   *      for item bodies. The raw `project` string is never path.joined
   *      first and then checked; it is only ever compared against names the
   *      filesystem already listed, so an unregistered path can't be probed
   *      into existing.
   *
   * Every failure below — bad runId shape, missing state dir, unregistered
   * project, no matching archived file AND no matching run.json — collapses
   * to the same `null`. The controller turns every one of those into an
   * identical 404: GET /api/items/body's own stance, that the caller has no
   * business learning which check failed.
   */
  archivedRun(project: string, runId: string): OrchestratorRun | null {
    if (!RUN_ID_RE.test(runId)) return null;

    const root = orchHome();
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // Same empty-state reasoning as runs()/archive(): no state directory
      // at all means nothing has ever run here, which is indistinguishable
      // from "this project was never registered" as far as this guard cares.
      return null;
    }

    // Guard 2 itself: encodeURIComponent(project) is compared against the
    // listing, never joined into a path before this check runs. A raw
    // project string that happens to share a directory listing's *prefix*
    // (e.g. the registered path minus its last segment) fails this exact
    // string-equality test the same as one that shares nothing at all —
    // there is no startsWith here to fool.
    const encoded = encodeURIComponent(project);
    if (!entries.includes(encoded)) return null;

    const dir = join(root, encoded);

    // Archived first: an archived run's filename IS the claim (orchestrate.mjs
    // never writes runs/<runId>.json under any name but its own runId), so a
    // direct read needs no further check once it parses and passes
    // isPlausibleRun. `expectMiss: true` is what this call site is FOR —
    // this is exactly the speculative probe readOneRun's own doc comment
    // describes: "no archived file with this name" is the routine outcome
    // for any request naming the current run (it lives in run.json, never
    // in runs/), not an error worth a log line, so it stays quiet here and
    // falls through to run.json below. A corrupt or implausible file that
    // DOES exist under this name is still a real problem and still warns —
    // expectMiss only silences the "genuinely not there" ENOENT case.
    const archived = readOneRun(join(dir, 'runs', `${runId}.json`), `runs/${runId}.json for "${project}"`, true);
    if (archived) return archived;

    // Fall back to the current run — but only when ITS OWN runId field
    // matches what was requested. Unlike the archived file above, run.json's
    // filename says nothing about which run it holds (it is always literally
    // "run.json"), so this is the one branch where archivedRun has to check
    // content rather than trust a path's existence.
    const current = readOneRun(join(dir, 'run.json'), `run.json for "${project}"`);
    if (current && current.runId === runId) return current;

    return null;
  }
}
