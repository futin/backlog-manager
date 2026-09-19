#!/usr/bin/env node
// orchestrate: the run-state core for backlog-orchestrate. This tool owns
// EVERY write to a project's run file — the same single-writer discipline
// skills/backlog/tools/backlog.mjs keeps for the registry and for item
// files, applied here to `~/.backlog-manager/orchestrator/<project
// key>/run.json`. Task 3 built init/lock, stage, heartbeat, attention,
// finish and status; Task 4 added `plan` — the queue builder and refusal
// gate that decides which backlog items are executable, in what order, and
// which are refused as ungroomed or flagged as carrying open questions —
// and wired that same gate into `init`'s own queue builder; Task 5 (this
// one) adds `watch` (survive a long headless child across the orchestrator
// loop's own Bash-tool ceiling), `verify` (run the project's proof
// commands and record them), `reconcile` (read-only crash-recovery report)
// and `abort` (tear down worktrees/branches and mark the run over) on top
// of the same run file.
//
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" init --project /abs/path/to/repo
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" status --json
//
// Deliberately standalone: this file imports nothing from skills/backlog/
// tools/backlog.mjs, even though a couple of things below (the git-root
// walk, an ISO timestamp helper) are close cousins of functions already
// written there. Plugin skill directories are installed as independent
// copies of whatever shipped at sync time, and CLAUDE.md's own invariants
// call out that a later prune of one skill's tools/ must never break
// another's — so the two tools duplicate a few small helpers on purpose
// rather than share a module neither can safely assume the other has.
// Anywhere this file re-derives something backlog.mjs already has, the
// function's own comment says so and says why.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- errors -------------------------------------------------------------
// Carries the intended process exit code so `main`'s one try/catch (see the
// bottom of this file) never has to re-classify an error after the fact —
// the same pattern backlog.mjs's BacklogError uses, duplicated rather than
// imported for the standalone reason above. The contract other tasks quote
// verbatim: 0 success, 1 bad args / unknown item / unknown stage / missing
// input, 3 no run exists, 4 lock held (a fresh OR stale `status: "running"`
// run.json — see cmdInit's own long comment on why both refuse
// identically), 5 `verify` found nothing resolvable to prove itself with
// (that command's own "cannot verify" exit, never used anywhere else), 6
// `stage <id> preflight`/`dispatched` refused because a pause request is
// effective for this run (nothing written; the run finishes `paused`). One
// number is deliberately overloaded: `watch` also exits 3 when its own
// budget elapses with the child still alive — see cmdWatch's own comment
// for why reusing "3" there (rather than minting a new code) is
// intentional, not a collision this file failed to notice.
export class OrchestrateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OrchestrateError';
    this.code = code;
  }
}

// --- the API, for a tracker project (task-47) ------------------------------
//
// A project whose committed `backlog/source.json` says `github` has NO ITEM
// FILES: its queue comes from `GET /api/items`, and its claim — the thing that
// stops two machines working one issue — is a comment the API writes. Both go
// through the local backlog-manager server, which holds the credential; this
// tool never talks to GitHub and never holds a token.
//
// **Every one of these calls is a CHILD PROCESS.** `fetch` is asynchronous and
// `main` below is not, deliberately — see `api-call.mjs`'s own header for the
// whole argument, and CLAUDE.md's "all three skill CLIs exit through
// process.exitCode" invariant for what it protects. `spawnSync` reaps the
// child before this function returns, so nothing asynchronous ever exists in
// THIS process.
//
// **In files mode nothing below is ever reached.** Not one command in this
// tool spawns the helper for a project with no marker or a `files` one; test
// case O-1 pins that by running the whole stage sequence with `BM_API_PORT`
// pointed at a closed port and expecting exit `0` at every step.

// The stack is not running. A code of its own rather than a `1`, for the
// reason `backlog.mjs`'s own exit `5` has one: "the store said no" and "there
// is no store reachable at all" are different things to a caller, and the
// second has the same fix every time. `5` was already taken here (`verify`:
// nothing to verify with) and so was `3` (`watch`: budget elapsed), and
// SKILL.md branches on both — so this tool's number is `8`, not the helper's.
const EXIT_API_DOWN = 8;

// An API refusal the command cannot absorb — a 500 on the route that closes an
// issue, a 400 naming a field this tool composed wrong. Distinct from `1`,
// which means "this call was wrong": a `9` means the call was right and the
// other side would not do it, and the reaction is a park rather than a fix.
// Commands that CAN absorb a refusal do — a `claim` 409 naming another run is
// exit `0` and a skipped item, because a refusal is information.
const EXIT_API_REFUSED = 9;

const API_CALL = fileURLToPath(new URL('./api-call.mjs', import.meta.url));

// The helper's own private exit codes, named here because this is the only
// place that reads them. They are deliberately NOT this tool's: `api-call.mjs`
// answers `3`/`5` and knows nothing about `watch`'s budget or `verify`'s
// nothing-to-prove, and this function is the one-way mapping between the two
// vocabularies.
const HELPER_EXIT_NON_2XX = 3;
const HELPER_EXIT_NO_API = 5;

// One request. `{ ok, status, data }` for a 2xx and for an ordinary refusal
// alike — a 409's body is what the caller needs in order to skip an item
// rather than fail — and a throw only for the stack being down, which no
// command can proceed past.
//
// `status` is `null` for a non-2xx, and that is honest rather than lazy: the
// helper prints the status to stderr for a human and hands the BODY to stdout,
// and every branch in this file that cares reads the body's own `error` or
// `holder`. A caller that genuinely needs the number can read it off `stderr`.
// Carrying a parsed-out copy would be a second decoding of the same fact.
//
// The body goes to the child on STDIN, never on argv: a `state` heartbeat
// carries a whole queue item — verification tails, usage entries, assumptions
// — and argv has a length ceiling (`E2BIG`) that a long item would cross
// silently at the worst moment.
function apiCall(method, requestPath, body) {
  const res = spawnSync(process.execPath, [API_CALL, method, requestPath, body === undefined ? undefined : '-'].filter((a) => a !== undefined), {
    encoding: 'utf8',
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: GIT_BLOB_MAX_BUFFER
  });

  if (res.status === HELPER_EXIT_NO_API) {
    throw new OrchestrateError((res.stderr || '').trim() || 'the backlog-manager API is not running', EXIT_API_DOWN);
  }
  // A child that could not be spawned at all, or died on a signal. Neither is
  // an API answer, and treating it as one would let a broken node install read
  // as an empty queue.
  if (res.status !== 0 && res.status !== HELPER_EXIT_NON_2XX) {
    throw new OrchestrateError(`api-call.mjs ${method} ${requestPath} failed to run (${res.error ? res.error.message : `exit ${res.status}`})`, EXIT_API_REFUSED);
  }

  let data = null;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    // The helper always writes one JSON line, so this is a child that died
    // before it could. Left `null`; the caller reports what it was doing.
    data = null;
  }
  return { ok: res.status === 0, status: res.status === 0 ? 200 : null, data, stderr: (res.stderr || '').trim() };
}

// The sentence a refusal becomes. The server composes every one of them (it is
// the only side that knows what GitHub said), so this copies the sentence
// rather than inventing a second wording for one fact — the same posture
// `backlog.mjs`'s `apiPost` takes.
function apiErrorText(res, fallback) {
  if (res.data !== null && typeof res.data === 'object' && typeof res.data.error === 'string') return res.data.error;
  return res.stderr || fallback;
}

// Which mode a project is in, read from its committed marker and nothing else
// — this tool's copy of `backlog.mjs`'s `sourceMode`, which is itself a copy of
// the server's `resolveSource`. Restated rather than imported for the reason
// this file's header gives: a plugin skill's `tools/` is installed as a
// standalone copy of what was pushed, and one skill's tools may never import
// another's.
//
// Three answers, and the load-bearing one is the third. Absent or
// `{"kind":"files"}` is `files` — the implicit case is every project on this
// machine today. `{"kind":"github"}` with a usable repo is `github`. Anything
// else is a REFUSAL, never a fallback to files: falling back would make this
// tool build a queue by scanning `backlog/` in a project whose items live on
// GitHub, dispatch sessions for files that are not there, and report every one
// of them as ungroomed.
//
// Read per call and cached nowhere, the same posture the server takes toward
// the same file.
function projectSource(projectRoot) {
  const marker = path.join(projectRoot, 'backlog', 'source.json');
  if (!fs.existsSync(marker)) return 'files';

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch (e) {
    throw new OrchestrateError(`${marker}: cannot be read as JSON (${e.message})`, 1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrchestrateError(`${marker}: expected an object with a string "kind"`, 1);
  }
  if (parsed.kind === 'files') return 'files';
  if (parsed.kind === 'github') {
    // GitHub's own character set for an owner and a name, the same class the
    // server's `isRepo` and `backlog.mjs`'s `isValidRepo` enforce. A `github`
    // marker with no usable repo is a refusal rather than a files fallback,
    // for the reason above.
    if (typeof parsed.repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(parsed.repo)) {
      throw new OrchestrateError(`${marker}: names kind "github" with no valid "repo" (expected "owner/name")`, 1);
    }
    return 'github';
  }
  throw new OrchestrateError(`${marker} names source kind ${JSON.stringify(String(parsed.kind))}, which this tool cannot orchestrate`, 1);
}

// --- freshness ------------------------------------------------------------
// Fifteen minutes, exactly mirroring shared/types.ts's own RUN_STALE_MS.
// That file is TypeScript and this file is a plugin skill tool that must
// stand alone (see the header comment above), so importing one constant
// from the other is not on the table — the two are kept from silently
// drifting apart the cheap way instead: both test suites (this one and the
// jest suite over shared/types.ts) assert the literal 900000, not just
// "equal to whatever the other file says today," so an edit to either
// constant without the other fails a test immediately rather than months
// later when a run gets declared stale nine minutes early or nine minutes
// late.
export const RUN_STALE_MS = 15 * 60 * 1000;

// True when `updatedAt` is within RUN_STALE_MS of `now` — the one freshness
// check every "is this run still alive" decision in this file reads,
// rather than five call sites each re-deriving the comparison.
function isFresh(updatedAt, now = Date.now()) {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && now - t < RUN_STALE_MS;
}

// --- timestamps -------------------------------------------------------------
// Millisecond-precision ISO-8601 — deliberately NOT backlog.mjs's own
// nowISO(), which truncates to the second because ITS timestamps land in a
// human-read frontmatter block where three extra digits are pure noise.
// This file's timestamps live only in a machine-only JSON state file no one
// hand-edits, and two commands here can legitimately run less than a second
// apart in the same process (`init` immediately followed by `stage`, or two
// `heartbeat`s back to back) — keeping the millisecond field is what lets
// `updatedAt` stay strictly monotonic across back-to-back writes instead of
// occasionally colliding on the same whole second and breaking anything
// that compares two heartbeats to prove time actually passed.
function nowISO() {
  return new Date().toISOString();
}

// The run id's own shape, `run-YYYYMMDD-HHMMSS` — matches
// test/fixtures/orchestrator-run.json's own example verbatim. Built from a
// Date's UTC calendar fields rather than by stripping non-digits out of
// `stamp` itself, because `stamp` (see nowISO above) carries millisecond
// digits and a trailing `Z`; a blind digit-strip would fold the
// milliseconds into the id and change its width unpredictably. Second
// resolution is enough: a run id only has to be unique enough to name one
// archived file among a project's `runs/` siblings, and two runs starting
// in the same second is not a case this tool needs to defend against (the
// lock already prevents two runs existing for one project at once).
function makeRunId(stamp) {
  const d = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `run-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

// --- where state lives ---------------------------------------------------

// `$BM_ORCH_HOME` when set, else `~/.backlog-manager/orchestrator/` — the
// override exists solely so a test process (or a developer poking at the
// tool by hand) never touches a real machine's orchestrator state, the same
// escape hatch backlog.mjs's own BM_REGISTRY_FILE provides for the
// registry.
export function orchHome() {
  return process.env.BM_ORCH_HOME || path.join(os.homedir(), '.backlog-manager', 'orchestrator');
}

// Project key = encodeURIComponent(<abs project path>) — reversible with
// decodeURIComponent, no lookup table to keep in sync with the registry or
// with anything else. encodeURIComponent turns every `/` in the path into
// `%2F`, which is what makes the result safe as a single path SEGMENT
// (mkdirSync never has to create intermediate directories for the key
// itself, only for `root` and for `runs/` beneath it) — a plain
// `path.join` of the raw absolute path would instead try to recreate the
// project's entire directory structure underneath `root`, which is not
// what "one directory per project" means here.
export function projectDir(root, project) {
  return path.join(root, encodeURIComponent(project));
}

// --- the pause request (task-17) -----------------------------------------
// The one file in this system that travels the OTHER way: everything else
// under `~/.backlog-manager/` is written by a skill tool and read by the
// server, and this is written by the SERVER (`POST /api/agents/pause`, via
// `server/src/orchestrator/pause-control.util.ts`) and read here.
//
// It lives under `settings/` because that subdirectory is already the
// read-write nested mount inside the otherwise read-only
// `~/.backlog-manager` (docker-compose.yml) — the server's only writable
// ground. It is emphatically not a *setting*: it is one control request
// about one run, deleted the moment it is cancelled and retired by the
// run's own `unpausedAt` stamp otherwise.
//
// Why a file at all, and not a field on `run.json`: that file has exactly
// one writer, this tool. A pause request originates in a browser, reaches a
// server, and has to arrive at a headless session that may be several
// minutes into a `claude -p` child — there is no channel between those two
// processes except the filesystem, and adding a second writer to `run.json`
// would trade a well-understood single-writer invariant for a lost-update
// race against a run heart-beating every few turns.
//
// `$BM_ORCH_CONTROL_HOME` exists for exactly the reason `$BM_ORCH_HOME`
// does: so a test process never reads (or writes) a real machine's control
// directory and pauses somebody's actual run.
export function controlHome() {
  return process.env.BM_ORCH_CONTROL_HOME || path.join(os.homedir(), '.backlog-manager', 'settings', 'orchestrator-control');
}

// One flat file per project, keyed the same reversible encodeURIComponent
// way `projectDir` keys its directories — but flat rather than a directory,
// because there is only ever one control fact per project and nothing else
// to keep beside it. The server's own `controlFile` computes this identical
// path; the two are duplicated by comment rather than shared by import, for
// the same reason `orchHome()` is duplicated there (a skill's `tools/` may
// never import from the server, and vice versa).
export function controlFilePath(root, project) {
  return path.join(root, `${encodeURIComponent(project)}.json`);
}

// Reads this project's pause request, or `null` for every way there isn't
// one: no file, unreadable file, unparseable JSON, or a parse that isn't an
// object. Deliberately total — a malformed control file must never wedge a
// run, because the process that writes it is not this one and a
// half-written or hand-edited file is not a reason to stop working. The
// same posture `readRun` takes toward an unparseable run.json, minus the
// refusal: a missing pause request is the normal case, not an error.
export function readPauseRequest(project) {
  let text;
  try {
    text = fs.readFileSync(controlFilePath(controlHome(), project), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Is this request one THIS run must act on? Two clauses, both necessary:
//
//   - `runId` pins the request to one run, so a request that outlived the
//     run it was made for (a `cancel` that never arrived, a crash) can never
//     pause the next run of the same project.
//   - `requestedAt` must post-date the run's most recent START — `unpausedAt`
//     when the run has been resumed, `startedAt` otherwise. This is what
//     retires a request: the resume stamp moves past it, and the same file
//     that paused the run stops being effective without anyone having to
//     delete it. Without this clause a resumed run would re-pause itself on
//     its very first dispatch gate, forever.
//
// Derived, never stored — on this side and on the server's alike. A stored
// verdict would be a second answer to a question whose inputs both move
// underneath it, which is the exact bug class the watchdog's `exhausted`
// flag was (a flag written once, never cleared, while the sweeper re-read
// its inputs every tick).
//
// Every malformed input answers `false`: a request this function cannot
// understand is not one a run should stop for.
export function pauseRequestEffective(control, run) {
  if (control === null || control === undefined || typeof control !== 'object') return false;
  if (typeof control.runId !== 'string' || typeof control.requestedAt !== 'string') return false;
  if (control.runId !== run.runId) return false;

  const requestedAt = Date.parse(control.requestedAt);
  const since = Date.parse(typeof run.unpausedAt === 'string' ? run.unpausedAt : run.startedAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(since)) return false;
  return requestedAt > since;
}

function runFilePath(dir) {
  return path.join(dir, 'run.json');
}

function runsArchiveDir(dir) {
  return path.join(dir, 'runs');
}

// Picks the archive STEM for a finished run — `<runId>` unless
// `<archiveDir>/<runId>.json` is already taken, which makeRunId's
// second-precision shape makes a real possibility, not a theoretical one:
// `finish` followed immediately by `init` (a human clearing a done run and
// starting the next one, or a test doing the same two calls back to back)
// can easily land two runs' worth of archiving in the same wall-clock
// second. Falling through to `-2`, `-3`, … on a collision means the second
// archive can never silently overwrite the first and destroy a finished
// run's only surviving record — the alternative, a bare renameSync straight
// to `<runId>.json`, would make that data loss possible on nothing more
// exotic than a fast human or a fast test.
//
// A STEM rather than a path because a finished run now has TWO archived
// artefacts sharing one name: `<archiveDir>/<stem>.json` (the run file) and
// `<archiveDir>/<stem>/` (that run's sidecar directories — see
// archiveSidecars below). Both are minted from this one answer to "which
// name is free"; deriving the directory by stripping `.json` off a returned
// path at the call site would be a second, weaker copy of the same rule,
// and the sibling-name convention is exactly what lets a reader find a
// run's evidence without any field in the run file recording where it went.
//
// The collision check is on `<stem>.json` ALONE, deliberately not "either
// `<stem>.json` or `<stem>/` is free". The only way to reach a free `.json`
// beside an existing directory of that name is an archive interrupted
// between its two moves (cmdInit moves the sidecars first, then renames
// run.json) — and in that state REUSING the stem is the repair: the next
// init merges whatever sidecars remain into the directory already there and
// completes the rename. Widening the check would instead split one run's
// evidence across `<stem>/` and `<stem>-2.json` permanently.
export function archiveStem(archiveDir, runId) {
  let stem = runId;
  for (let suffix = 2; fs.existsSync(path.join(archiveDir, `${stem}.json`)); suffix++) {
    stem = `${runId}-${suffix}`;
  }
  return stem;
}

// Moves a finished run's SIDECAR artefacts out of the flat, project-scoped
// state directory and into `destDir` (`runs/<stem>/`, the sibling of that
// run's archived `<stem>.json`). Everything under `<dir>` moves EXCEPT two
// names: `run.json`, which cmdInit renames itself moments later, and
// `runs`, the archive folder this would otherwise bury inside its own
// newest entry.
//
// A DENYLIST of two, not an allowlist of the five names known today
// (`logs`, `reviews`, `verify`, `questions`, `prompts`). Those directories
// are created by DRIVERS following SKILL.md prose (`mkdir -p
// "<dir>/logs"`), never by this tool, so the set is open by construction —
// `prompts/` began as a directory one driver invented unprompted on one
// project, and bug-31 later made it prescribed in SKILL.md §5 and §7 without
// this list needing an edit. An allowlist minted today would silently
// drop whatever the next prose edit names, which is precisely the evidence
// loss this whole mechanism exists to close. `runs/` being off limits to
// drivers is already SKILL.md §2's rule ("stay out of `<dir>/runs/`"), so
// excluding it enforces an existing rule rather than inventing one.
//
// Best-effort throughout, and never fatal. `init`'s contract is that a bad
// call writes nothing and a good call ends with a valid run.json; failing a
// real run over evidence bookkeeping would trade the run for a filing
// error. Every failure warns to stderr naming the entry and continues.
function archiveSidecars(dir, destDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`warning: could not read ${dir} to archive its sidecars: ${err.message}\n`);
    return;
  }

  const movable = entries.filter((entry) => entry.name !== 'run.json' && entry.name !== 'runs');
  // Created only when there is something to put in it. An unconditional
  // mkdir would leave an empty `runs/<stem>/` after every init, and an
  // empty directory claims evidence exists where none does.
  if (movable.length === 0) return;
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`warning: could not create ${destDir} to archive sidecars: ${err.message}\n`);
    return;
  }

  for (const entry of movable) {
    const target = path.join(destDir, entry.name);
    // Reachable only through the interrupted-archive path (sidecars already
    // moved, run.json not renamed yet, a live run since recreating the same
    // name). renameSync onto an existing name is an error on some platforms
    // and a silent replace of an empty directory on others; neither is a
    // thing to do to archived evidence, so the newer copy is left flat and
    // says so rather than being merged in over the top.
    if (fs.existsSync(target)) {
      process.stderr.write(`warning: ${target} already exists — leaving ${entry.name} where it is rather than overwriting archived evidence\n`);
      continue;
    }
    try {
      fs.renameSync(path.join(dir, entry.name), target);
    } catch (err) {
      process.stderr.write(`warning: could not archive ${entry.name} into ${destDir}: ${err.message}\n`);
    }
  }
}

// Is `dir` the top of a LINKED GIT WORKTREE? Returns a
// `{ worktree, gitdir, projectRoot }` description if so, or null for
// anything else — an ordinary clone, a main working tree, a submodule
// working tree, or a directory with no `.git` at all.
//
// The whole discriminator is what `<dir>/.git` IS, and it takes two small
// reads rather than a `git rev-parse` subprocess in front of every command:
//
//   - a DIRECTORY — ordinary clone or main tree. Not a worktree.
//   - a FILE whose `gitdir:` target contains a `commondir` entry — a linked
//     worktree. This is the case that has to be refused.
//   - a FILE whose target has NO `commondir` — a submodule working tree.
//     Not a worktree, and resolving it to itself is the correct answer.
//
// That last case is why "`.git` is a file" is not on its own a sufficient
// test, and the distinction was verified against real git plumbing rather
// than assumed: a worktree gitdir (`<main>/.git/worktrees/<name>`) carries
// `HEAD commondir gitdir index logs refs`, a submodule gitdir
// (`<super>/.git/modules/<name>`) carries `HEAD config description hooks
// index info logs objects packed-refs refs`. `commondir` is present in
// exactly one of them. The test suite builds a real submodule for exactly
// this case, so a future git that changes the layout fails loudly here
// instead of silently refusing inside every submodule.
//
// Both pointers can be relative, and both are resolved against the right
// base: the `.git` file's `gitdir:` against the directory holding that file
// (a submodule's is written relative, and git can be configured to write
// relative worktree pointers too), and `commondir` against the gitdir
// itself (`../..` in practice). `projectRoot` — the main working tree,
// i.e. the common git dir's parent — is best-effort and may come back null:
// a bare main repo has no working tree to name, and refusing while naming
// only the worktree and its gitdir still beats answering wrongly.
export function linkedWorktreeInfo(dir) {
  const gitEntry = path.join(dir, '.git');
  let stat;
  try {
    stat = fs.statSync(gitEntry);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let pointer;
  try {
    pointer = fs.readFileSync(gitEntry, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) return null;
  const gitdir = path.resolve(dir, match[1]);

  let commonRaw;
  try {
    commonRaw = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
  } catch {
    // No commondir — a submodule (or a gitdir this process cannot read, in
    // which case refusing on a guess would be worse than the status quo).
    return null;
  }
  const commonDir = path.resolve(gitdir, commonRaw);

  // The main tree is the common git dir's parent, but only when that common
  // dir actually IS a `.git` directory inside a working tree. A bare main
  // repo's common dir is the repository itself (`/srv/foo.git`), whose
  // parent is not a checkout of anything.
  let projectRoot = null;
  if (path.basename(commonDir) === '.git') {
    try {
      if (fs.statSync(commonDir).isDirectory()) projectRoot = path.dirname(commonDir);
    } catch {
      projectRoot = null;
    }
  }

  return { worktree: dir, gitdir, projectRoot };
}

// The one refusal message, shared by the two entry points that can arrive
// at a worktree (cwd-derived, in resolveProjectRoot below, and
// `--project`-derived, in cmdInit). Actionable by construction: the
// operator who trips this is mid-run and possibly unattended, so the
// message names the directory that is wrong AND the directory to re-run
// from, without shelling out to git for either.
//
// Exit 1, never 3. Code 3 means "no run exists," which is exactly the
// answer this bug used to give for a perfectly healthy run — an unattended
// loop treating 3 as "nothing to do" would read the run as absent. Code 1
// is "a problem with THIS call, independent of run state; nothing is ever
// written," which is precisely what this is.
function refuseLinkedWorktree(info) {
  const where = info.projectRoot
    ? `its project root is ${info.projectRoot} — re-run this command from there`
    : `its shared git dir is ${info.gitdir}, whose main working tree could not be determined (a bare main repo?) — re-run this command from the project root`;
  throw new OrchestrateError(
    `${info.worktree} is a linked git worktree, not a project root; ${where}. orchestrate.mjs keys a run under the project's own path, so a worktree would write to a location nothing else ever reads`,
    1
  );
}

// Walks up from `startDir` looking for a `.git` entry, exactly the git-root
// walk backlog.mjs's own resolveRoot does. Duplicated rather than imported
// for the standalone reason in this file's header comment — and no longer
// byte-identical to it: this walk refuses a linked worktree (see
// linkedWorktreeInfo above) where backlog.mjs's deliberately resolves one
// to itself. The two tools want opposite answers from the same shape,
// because the headless `backlog-execute` sessions this orchestrator
// dispatches run backlog.mjs INSIDE a worktree on purpose — the item file
// they read and stamp is the worktree's own copy.
//
// Every command but `init` uses this — not a `--project` flag — to decide
// which project's run.json it means. That asymmetry is deliberate, not an
// oversight: `init` is the one command that can plausibly run from
// somewhere other than the project itself (a server endpoint spawning the
// orchestrator, say, before its child process has even changed into the
// project directory), so it takes the path explicitly. Every other command
// — `stage`, `heartbeat`, `attention`, `finish`, `status`, and (Task 5)
// `watch`/`abort` — is only ever invoked BY the orchestrator loop itself,
// whose own cwd IS the project root for the run's entire lifetime (the
// per-item worktrees Task 5 creates are a separate concern: the headless
// sessions that do the actual item work run `backlog.mjs` inside those
// worktrees, never `orchestrate.mjs` — this tool's own commands never run
// from inside one).
//
// bug-2 is why that contract is now enforced here rather than only stated
// in the skill. The contract used to be prose alone, and prose can only
// bind the commands it knows about: the trap was armed by anything at all
// that left the session's cwd inside a worktree — in the run that surfaced
// it, an ad-hoc `pnpm exec jest --version` probe, a command the skill has
// no reason to mention. Every later call then resolved to the worktree,
// whose `.git` is a file the old `existsSync` test could not tell from a
// directory, and reported exit 3, "no run exists," for a live and healthy
// run. Nothing was corrupted and nothing said the project had been
// misidentified; the run simply appeared to vanish. Refusing on cwd here
// costs two small reads on a path already being stat'ed and turns that
// silent wrong answer into a loud, actionable one.
//
// What is deliberately NOT checked: `stage --worktree`, `stage --branch`
// and `verify --cwd`. Those name a per-item worktree on purpose — they are
// the very mechanism that keeps this tool's own cwd in the main tree — so
// the check belongs on cwd-derived and `--project`-derived roots only.
export function resolveProjectRoot(startDir = process.cwd()) {
  const resolvedStart = path.resolve(startDir);
  let dir = resolvedStart;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const worktree = linkedWorktreeInfo(dir);
      if (worktree) refuseLinkedWorktree(worktree);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new OrchestrateError(
        `no .git found in ${resolvedStart} or any parent directory — orchestrate.mjs resolves "which project" from its own cwd for every command except init, so this must run from inside the project being orchestrated`,
        1
      );
    }
    dir = parent;
  }
}

// --- reading and writing the run file --------------------------------------

// Reads and parses the project's run.json, or throws a code-3 OrchestrateError
// ("no run exists") for either of the two ways that can be true: the file is
// genuinely missing, or it is present but doesn't parse as JSON. The two are
// folded into the same exit code deliberately — code 3 is documented as "no
// run exists," and a run file this tool cannot even read back is not a run
// this tool can act on, whatever put it in that state. (This tool is the
// run file's only writer, so an unparseable run.json is not a shape this
// tool itself ever produces via a completed write — atomic rename means a
// reader never observes a half-written file — but a hand-edit or a
// truncated disk write from outside this tool's control is not impossible,
// and refusing cleanly beats crashing on a JSON.parse exception with a
// bare stack trace.)
export function readRun(dir) {
  const file = runFilePath(dir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new OrchestrateError('no run exists for this project — run `orchestrate.mjs init --project <path>` first', 3);
    }
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new OrchestrateError(`${file}: exists but does not parse as JSON (${e.message}) — nothing this tool can act on`, 3);
  }
}

// The one place any run.json is ever written. Atomic by construction: the
// full new content is written to a temp file in the SAME directory (so the
// eventual rename is on the same filesystem and therefore atomic at the OS
// level — a temp file on a different filesystem would make renameSync fall
// back to a copy, which is not atomic), then renameSync replaces run.json
// in one step. A reader can only ever observe the old complete file or the
// new complete file, never a partial write — and there is never a leftover
// temp file to clean up afterward, because renameSync's whole job is
// removing the temp name by giving its content the target name instead.
// The random suffix (rather than just the pid) guards against two writes
// racing inside the same process across two commands run back to back in a
// test, where the pid alone is constant.
function writeRunAtomic(dir, run) {
  fs.mkdirSync(dir, { recursive: true });
  const file = runFilePath(dir);
  const tmp = path.join(dir, `.run.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// --- the driver lease (bug-19) ---------------------------------------------
//
// `--resume` is not a command. It is a prose flow in references/recovery.md
// that a session carries out with the ordinary commands below, and `init` —
// the one command that takes a lock at all — is deliberately never part of it,
// since exit 4 is what `init` answers for the very run file a resume exists to
// take over. Everything downstream is a blind read-modify-write:
// `writeRunAtomic` is atomic per write, so no reader ever sees a torn file,
// and last-writer-wins across processes, so two drivers each read a copy,
// mutate their own and write over each other. `run.json`'s single-writer
// guarantee is a statement about which PROGRAM writes it, which two instances
// of that program satisfy while destroying each other's state.
//
// That is not hypothetical: on 2026-09-05 two live sessions held one crashed
// run — one spawned by this app's own `POST /api/agents/resume`, one by the
// dashboard's session-resume, which nothing in backlog-manager requested and
// no server-side lock could ever refuse. Both were heading for a merge to
// `main`. This is the only layer both spawn shapes pass through, which is why
// the durable half of the fix lives here rather than only in the server.
//
// The lease gives a DETERMINISTIC SINGLE SURVIVOR with no cross-process
// locking primitive: on a crashed run both resumers may claim, the later write
// wins, and the loser's very next write refuses and stops it. Last-writer-wins
// — the property that makes a racing `stage` dangerous — is exactly what makes
// `claim` safe: precisely one of the two claims is visible afterwards, and
// every subsequent write is checked against it.

// Exit code for "another session has taken this run over". Its own number
// rather than a `1` for `6`'s reason: the reaction is not "fix this call and
// retry", it is STOP — write nothing more and exit.
const EXIT_FOREIGN_DRIVER = 7;

// This session's identity, or `null` when there is none.
//
// `CLAUDE_CODE_SESSION_ID` is the same variable `backlog.mjs` reads for token
// accounting, and deliberately NOT a synthetic per-process id: each invocation
// of this tool is its own process, so a generated id would present a different
// identity on every command and the run would lock itself out of its own file
// on the second one.
function sessionIdentity() {
  const raw = process.env.CLAUDE_CODE_SESSION_ID;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed === '' ? null : trimmed;
}

// The lease a run file carries, or `null` for one that carries none.
// **Absent means unclaimed, never locked**: every run file written before this
// feature existed lacks the key, and a missing field must never be able to
// strand a run.
function runDriver(run) {
  const driver = run.driver;
  if (!driver || typeof driver !== 'object') return null;
  return typeof driver.sessionId === 'string' && driver.sessionId !== '' ? driver : null;
}

// Refuses a mutating command whose run is leased to a DIFFERENT session.
//
// Called by every command that writes and by none that only reads: `status`,
// `plan`, `denials` and `reconcile` are what a session evicted from a run
// should still be able to run in order to understand what happened to it.
//
// An unidentified caller (no CLAUDE_CODE_SESSION_ID — a hand-run terminal)
// proceeds with a warning rather than being refused. Refusing would strand the
// one person recovering a run by hand, which is the situation this whole
// feature exists to leave open; the warning is there so nobody reads a
// successful command as proof the lease held.
// Once per process, not once per call: `watch` runs `assertDriver` on every
// poll of its interval, so an unidentified caller printed this line for the
// whole length of a dispatch. The fact does not change within a process — the
// env var is read at every call and cannot appear mid-run — so saying it again
// only buries whatever else that session wrote to stderr.
let leaseWarned = false;

function assertDriver(run) {
  const me = sessionIdentity();
  const driver = runDriver(run);
  if (me === null) {
    if (!leaseWarned) {
      leaseWarned = true;
      console.error(
        "warning: CLAUDE_CODE_SESSION_ID is not set, so this run's driver lease cannot be enforced for this command" +
          (driver ? ` (run.json names ${driver.sessionId} as its driver)` : '')
      );
    }
    return;
  }
  if (driver === null || driver.sessionId === me) return;
  throw new OrchestrateError(
    `this run is being driven by session ${driver.sessionId} (since ${driver.at}), not this one — another session has ` +
      'taken it over. Stop immediately: write nothing more, and exit. See references/recovery.md.',
    EXIT_FOREIGN_DRIVER
  );
}

const CLAIM_USAGE = 'usage: orchestrate.mjs claim';

// `claim` — take this run over, and heartbeat it in the same write.
//
// The first thing a `--resume` session does, replacing the unconditional
// `heartbeat` recovery.md used to open with: same position, same purpose (shrink
// the window in which two resumes can both believe they are alone), now also
// recording WHO, which is what makes the shrinking into a guarantee rather than
// a narrowing.
//
// It refuses exactly one situation: a run that is `running`, FRESH, and leased
// to another session — one that is actively heartbeating already has a driver
// and needs no second one. A crashed run is claimable by anybody, which is the
// point: that is the state a resume exists for, and refusing there would make
// this lease the thing that strands a run instead of the thing that protects it.
// The takeover itself, shared by `claim` and by `abort` (review round 1).
//
// `abort` takes the run over rather than asserting the lease because of what
// abort IS: the run-ending command, whose entire premise is that the driver is
// gone. A crashed run carries the lease of the dead `init` session, so
// asserting it there refused every abort with exit `7` — "another session has
// taken it over", which was false — and `init` then refused the project with
// exit `4` forever, since it refuses any `running` run file fresh or stale.
// That is the lease becoming the thing that strands a run, which
// docs/subsystems/invariants.md names as the one outcome it must never produce.
//
// It lives in the TOOL rather than in an extra `claim` step in
// references/recovery.md's `--abort` section, for the reason SKILL.md's own
// exit-code table gives about prose: recovery.md is read once by a session that
// then makes several hundred turns, and a step it skips is a brick. A rule the
// command applies to itself cannot be skipped.
//
// The refusal rule is the one `claim` has always had, unchanged and applied
// identically here: only a run that is `running`, FRESH and led by another
// session is refused, because that is the one state where somebody else really
// is driving. So aborting a crashed or paused run always works, and aborting a
// live one that another session is actively heartbeating is refused and says
// whose it is — pause it first (a pause is server-side and needs no lease),
// then abort the paused run.
function takeOverRun(dir, run) {
  const me = sessionIdentity();
  const driver = runDriver(run);
  if (driver !== null && driver.sessionId !== me && run.status === 'running' && isFresh(run.updatedAt)) {
    throw new OrchestrateError(
      `run ${run.runId} is alive (last heartbeat ${run.updatedAt}) and driven by session ${driver.sessionId} — ` +
        'nothing to take over. Stop immediately: write nothing, and exit.',
      EXIT_FOREIGN_DRIVER
    );
  }

  // One clock reading for both stamps, the same rule `unpause` follows: the
  // lease's `at` and the heartbeat are the same instant, so nothing can land
  // between them and be judged against the wrong one.
  const at = nowISO();
  // `null` for an unidentified caller rather than a placeholder string: a
  // hand-run terminal cannot hold a lease, and writing a made-up id would let
  // it lock out the very session that comes to recover the run afterwards.
  run.driver = me === null ? null : { sessionId: me, at };
  run.updatedAt = at;
  writeRunAtomic(dir, run);
  if (me === null) {
    console.error('warning: CLAUDE_CODE_SESSION_ID is not set — this run is now unclaimed, and the lease cannot be enforced');
  }
  return at;
}

function cmdClaim(argv) {
  if (argv.length > 0) {
    throw new OrchestrateError(CLAIM_USAGE, 1);
  }
  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);

  const at = takeOverRun(dir, run);

  /* task-47, and only for a tracker project: taking the RUN over is not the
     same as taking its ITEMS over. Each in-flight item's issue carries a claim
     posted by the session that just died — still live, still holding the
     lowest comment id — and under the plain protocol this session would lose
     every one of them to a process that no longer exists, once per item, for
     fifteen minutes each.

     So each is re-claimed here, at the one command a `--resume` session opens
     with. The SERVER makes that succeed: a live claim carrying this same
     `runId` is a takeover rather than a contest (`GithubSource.claim`), which
     is why `run` rides every claim and not only the first.

     A claim now held by a DIFFERENT run is the one case that is not
     recoverable, and it is not an error either — another machine picked the
     item up while this one was down. The item goes to `skipped`, and its
     worktree and branch are LEFT IN PLACE and named in the note: the run did
     not lose them, it lost the item, and whatever that session built is still
     on disk for a person to look at. Removing them here would be this run
     deleting work on the strength of somebody else's claim. */
  const reclaimed = [];
  if (projectSource(run.project) === 'github') {
    for (const item of run.queue) {
      if (item.claim === undefined || CLAIM_RELEASE_STAGES.has(item.stage)) continue;
      const taken = trackerClaim(run, item);
      if (taken.won) {
        item.claim = { commentId: taken.commentId };
        reclaimed.push({ id: item.id, stage: item.stage });
        continue;
      }
      const where = item.worktree === null ? '' : ` — worktree ${item.worktree} left in place`;
      applyQueueItemFields(item, { stage: 'skipped', note: `${taken.note}${where}` });
      reclaimed.push({ id: item.id, stage: 'skipped', note: item.note });
    }
    run.updatedAt = nowISO();
    writeRunAtomic(dir, run);
    console.log(JSON.stringify({ runId: run.runId, driver: run.driver, updatedAt: run.updatedAt, reclaimed }));
    return 0;
  }

  console.log(JSON.stringify({ runId: run.runId, driver: run.driver, updatedAt: at }));
  return 0;
}

// --- queue items -------------------------------------------------------

// The full RunStage vocabulary, verbatim from shared/types.ts's own
// RunStage union — duplicated for the same standalone reason as
// RUN_STALE_MS above (see that constant's comment). `stage` validates
// against this list; an unrecognized string is a code-1 usage error, never
// silently accepted. `branched` sits right after `merged` — same terminal
// position in the pipeline as the union itself documents: one success exit
// per MergeMode, and a queue item reaches exactly one of the two, never
// both.
const RUN_STAGES = [
  'pending',
  'preflight',
  'dispatched',
  'inspecting',
  'reviewing',
  'fixing',
  'verifying',
  'merging',
  'merged',
  'branched',
  'failed',
  'skipped',
  'needs-answers',
  'ungroomed',
  'parked'
];

// The MergeMode vocabulary, verbatim from shared/types.ts's own MergeMode
// union and its MERGE_MODES const — duplicated for the exact same
// standalone reason RUN_STAGES just above already is (this file may not
// import from shared/, even though the two lists are one feature: `branch`
// mode is the entire reason RUN_STAGES needed a second success exit).
// `merge` is today's behaviour, byte for byte — merge each verified item
// into main and clean up its worktree and branch. `branch` commits, reviews
// and verifies exactly the same way, then removes the worktree and KEEPS
// the branch; main is never touched. `init --merge-mode` and the
// `merge-mode` command below both validate against this exact list, rather
// than a hand-written `=== 'merge' || === 'branch'` chain, for the same
// "one copy of the vocabulary" reason RUN_STAGES is a list and not a
// scattered set of string literals.
const MERGE_MODES = ['merge', 'branch'];

// The QuestionMode vocabulary, verbatim from shared/types.ts's own
// QuestionMode union and its QUESTION_MODES const — the same standalone
// duplication MERGE_MODES just above and RUN_STAGES before it already are,
// for the same reason (this file may not import from shared/). `park` is
// today's behaviour, byte for byte: an item whose preflight questions
// nobody answered gets an `attention --kind needs-answers` row, is staged
// `needs-answers`, and the run moves on. `decide` is permission for the run
// to answer those questions itself, write the answers into the item body
// and record what it assumed via the `assume` command below — permission,
// not obligation, which is why `attention --kind needs-answers` stays legal
// under it. `init --question-mode` validates against this exact list rather
// than a hand-written `=== 'decide' || === 'park'` chain, for the "one copy
// of the vocabulary" reason MERGE_MODES' own comment gives.
const QUESTION_MODES = ['decide', 'park'];

// Builds one full RunQueueItem from just an id and a title, with every
// other field at the shape's own documented default: `pending` is the
// stage every item starts in (shared/types.ts's own words), the three
// session/worktree/branch fields are null until dispatch actually happens,
// fixLoops starts at zero, stageAt records this first (and so far only)
// arrival, and verification/questions/note are each the shape's own "no
// verify yet / no questions / nothing to add" value. This is the ONLY place
// a queue item is constructed, so every queue item this tool ever writes
// has the exact same key set by construction — which is what Test case 1's
// key-set comparison against the contract fixture is actually checking.
function makeQueueItem(id, title, stamp) {
  return {
    id,
    title,
    stage: 'pending',
    sessionId: null,
    worktree: null,
    branch: null,
    fixLoops: 0,
    stageAt: { pending: stamp },
    verification: [],
    questions: [],
    // Null until a dispatch actually chooses one. Before bug-3 there was
    // nothing to record: every session ran under the one hard-coded flag,
    // so the mode was a constant of the design rather than a property of a
    // run. Now that it can vary, a denial found in a transcript needs the
    // mode that produced it recorded next to it.
    permissionMode: null,
    note: null,
    // Empty until the `assume` command writes into it, which only ever
    // happens on a run whose questionMode is 'decide'. Present on every
    // queue item regardless of mode — the key set this function produces is
    // the run file's contract (see this function's own comment above), and
    // a field that appeared only on some items would make every reader
    // branch on its absence rather than on its emptiness.
    assumptions: []
  };
}

// --- the gate: deciding which items are executable -------------------------
// This is the mechanical twin of skills/backlog-execute/SKILL.md's own "The
// refusal gate" section — the prose there is the load-bearing rule ("refuse
// any item whose plan isn't real yet"), and everything below exists only to
// answer the same question without a human reading the file by hand: does
// this task's `## Plan` say anything real, does this bug's `## Fix` say
// anything beyond the `unknown` placeholder backlog-capture writes for every
// bug nobody has diagnosed yet. Kept in exact agreement with that prose on
// purpose — a queue that gates more strictly (or more loosely) than the
// skill that actually does the work would either block groomed items for no
// reason, or hand the orchestrator loop something backlog-execute would
// refuse the moment it got there.
//
// Deliberately reads item files with its own small, purpose-built
// frontmatter and section reader rather than importing skills/backlog/
// tools/backlog.mjs's parseFrontmatter — see this file's header comment for
// why the two tools stand alone rather than sharing a module. The reader
// below is intentionally narrower than backlog.mjs's own: it only ever needs
// an item's `title` and its raw body text (to find `## Plan`/`## Fix`/
// `## Done when`), never `tags`, `started`, or any of the other keys
// backlog.mjs's version round-trips for a full read-modify-write — this file
// never writes an item back, so there is nothing here to round-trip.

// Only bugs and tasks are ever orchestrable, exactly mirroring
// backlog-execute's own Hard limits ("Never touches ideas/, refactors/ or
// out-of-scope/"): an idea or a refactor has nothing to execute yet — that
// is what promoting one via backlog-groom is for — and out-of-scope is
// already closed. There is no third prefix here for the same reason
// backlog-execute has no third case in its own gate: an id from any other
// section is simply never a candidate, the same way that skill's own "Pick
// an item" step turns one away before its refusal gate ever runs.
const GATE_SECTIONS = { bugs: 'bug', tasks: 'task' };

// The placeholder backlog-capture writes for a bug nobody has diagnosed yet
// (`## Cause`/`## Fix` both start as this), and the value a task's own
// `## Plan` is treated as equivalent to "nothing here" when it's all that is
// present — matching the brief's own wording for the task rule ("non-empty
// content ... that is not just unknown/whitespace").
const PLACEHOLDER = 'unknown';

// Every open item in one section (bugs or tasks), each as its id, its
// numeric id (for the oldest-first sort below — ids are minted as a
// monotonic max+1 per store, so the number IS creation order, unlike file
// mtime), and the absolute path it was found at. Same `^prefix-digits-`
// filename convention as skills/backlog/tools/backlog.mjs's own
// openEntries, re-derived here for the standalone reason given above.
// Returns [] rather than throwing when the section's open/ directory (or
// backlog/ itself) doesn't exist at all — a project with no backlog store
// yet, or a fresh clone that has never run `backlog.mjs init`, has no
// candidates to gate, not an error; `plan`/`init` both read that as "nothing
// here yet," never as a reason to fail the whole command.
function listOpenItems(backlogDir, section) {
  const dir = path.join(backlogDir, section, 'open');
  if (!fs.existsSync(dir)) return [];
  const prefix = GATE_SECTIONS[section];
  const idPattern = new RegExp(`^(${prefix}-(\\d+))-`);
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    const m = idPattern.exec(name);
    if (m) items.push({ id: m[1], num: Number(m[2]), section, path: path.join(dir, name) });
  }
  return items;
}

// A narrow read: `title` and the `runner-fix:` marker off the frontmatter
// fence, plus the raw body
// text after it, via the same `key:` line-splitter parseFrontmatter uses
// (see this section's own header comment for why a full parse is not worth
// duplicating here). A file that doesn't even open the fence the way
// backlog.mjs always writes one is treated as titleless and bodyless rather
// than thrown on — this tool never refuses to gate the REST of a store over
// one file some other process wrote badly; that item just reads as
// ungroomed by construction (no recognizable `## Plan`/`## Fix` will ever be
// found in a body of `''`).
function readItemForGate(absPath) {
  return parseItemForGate(fs.readFileSync(absPath, 'utf8'));
}

// The same narrow read, applied to bytes that never came off the working
// tree at all: the gate below hands this a blob read out of `<base>` with
// `git show`, because the content a dispatched session will actually see is
// whatever the worktree gets from that ref, not the file sitting on disk
// here. Split out of readItemForGate rather than copied so the two can never
// drift into parsing the same item two different ways.
//
// `runnerFix` is the task-13 marker: *executing this item repairs machinery
// this run itself depends on*, so buildGatedQueue hoists it to the front of
// the queue rather than letting it sit behind the very items it unblocks.
// It is read HERE, in the one function both the working-copy and the
// `<base>` blob path funnel through, so an item's marker always comes off
// the same bytes its gate verdict did — a `runner-fix:` present only in the
// working copy must not reorder a run whose worktree will not contain it.
//
// Presence hoists; only `false` opts out. `runner-fix: true`,
// `runner-fix: yes` and a bare `runner-fix:` all hoist, deliberately: a key
// that hoisted on `true` alone would let `runner-fix: yes` silently not
// hoist, which is the exact failure this marker exists to remove — a queue
// in the wrong order with nobody told. The `false` compare is
// case-insensitive because `False` and `FALSE` are the same YAML boolean a
// human meant to write, and reading one of them as "hoist" would be the
// mistake in the direction that actually reorders a run.
function parseItemForGate(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { title: '', body: '', runnerFix: false };
  let i = 1;
  let title = '';
  let runnerFix = false;
  for (; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const sep = lines[i].indexOf(':');
    if (sep === -1) continue;
    const key = lines[i].slice(0, sep).trim();
    if (key === 'title') title = lines[i].slice(sep + 1).trim();
    else if (key === 'runner-fix')
      runnerFix =
        lines[i]
          .slice(sep + 1)
          .trim()
          .toLowerCase() !== 'false';
  }
  if (i === lines.length) return { title, body: '', runnerFix };
  return { title, body: lines.slice(i + 1).join('\n'), runnerFix };
}

// Finds one `## <heading>` section's own content: everything between that
// heading line and the next line that opens another `##` heading (or end of
// file). Returns `undefined` when the heading isn't present at all — kept
// distinct from an empty string, because "the heading is missing" and "the
// heading is there with nothing under it" are two different reasons in the
// gate below, and backlog-execute's own prose calls out both ("the heading
// is missing entirely, ... or if all that's there is a placeholder").
function extractSection(body, heading) {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (idx === -1) return undefined;
  const rest = lines.slice(idx + 1);
  const end = rest.findIndex((l) => l.trimStart().startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// The task half of the gate: `## Plan` must exist and hold something beyond
// whitespace or the `unknown` placeholder. Each reason is its own string
// (rather than one combined message) so a caller — `plan`'s own human-
// readable printer, or a future UI — can list them as separate bullets.
// `questionSection` carries the section text forward for detectQuestions
// below, so that function never has to re-derive "which section did this
// item's own gate actually look at."
function gateTask(body) {
  const plan = extractSection(body, 'Plan');
  if (plan === undefined) {
    return { reasons: ['## Plan heading is missing — nothing for backlog-execute to work'], questionSection: undefined };
  }
  const trimmed = plan.trim();
  if (trimmed === '') {
    return { reasons: ['## Plan has no content under it — it is still empty'], questionSection: plan };
  }
  if (trimmed === PLACEHOLDER) {
    return { reasons: [`## Plan is still the "${PLACEHOLDER}" placeholder`], questionSection: plan };
  }
  return { reasons: [], questionSection: plan };
}

// The bug half: `## Fix` must not be exactly the `unknown` placeholder.
// Mirrors backlog-execute's own wording precisely ("Refuse if its content is
// still exactly `unknown`") — that skill does not separately call out a
// missing `## Fix` heading, because backlog-capture's bug template always
// writes one; a heading that is missing anyway is refused here too, rather
// than silently read as "ready," since there is equally nothing there for
// backlog-execute to work.
function gateBug(body) {
  const fix = extractSection(body, 'Fix');
  if (fix === undefined) {
    return { reasons: ['## Fix heading is missing'], questionSection: undefined };
  }
  if (fix.trim() === PLACEHOLDER) {
    return { reasons: [`## Fix is still the "${PLACEHOLDER}" placeholder — nobody has diagnosed this yet`], questionSection: fix };
  }
  return { reasons: [], questionSection: fix };
}

// Pulls each command line out of a fenced code block under `## Done when` —
// the same convention this repo's own archived items already use in their
// `## Outcome`'s "Verification" block (a fenced block, one shell invocation
// per line, sometimes prefixed with a `$ ` prompt marker, which is stripped
// here). Deliberately narrower than "any backtick span in the section": a
// task's `## Done when` prose routinely names a command or a file in
// backticks without meaning "run this to prove I'm done" (e.g. "matches the
// plan command's own output"), and treating every such mention as a command
// to verify would flag ordinary prose as a question. A fenced block is the
// one shape in this section that unambiguously means "here is something to
// run."
function extractDoneWhenCommands(doneWhenText) {
  const commands = [];
  let inFence = false;
  for (const line of doneWhenText.split('\n')) {
    const t = line.trim();
    if (t.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence || t === '') continue;
    commands.push(t.startsWith('$ ') ? t.slice(2).trim() : t);
  }
  return commands;
}

// Resolves each `## Done when` command against the same two places Task 5's
// own `verify` will (per the plan doc): `<project>/backlog/verify.json`'s
// `commands` array, or a `pnpm`/`npm`/`yarn run <script>` naming a real
// `package.json` script. Neither file existing, or either failing to parse,
// is read as "nothing known" rather than an error — a project with no
// verify.json and no package.json at all is a normal thing for this gate to
// see (this tool's own fixtures/store/ is exactly that), and the whole point
// of this check is a soft warning, never a reason to fail the command.
function findUnresolvedCommands(doneWhenText, projectRoot) {
  const commands = extractDoneWhenCommands(doneWhenText);
  if (commands.length === 0) return [];

  let verifyCommands = [];
  try {
    const verifyJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'backlog', 'verify.json'), 'utf8'));
    if (Array.isArray(verifyJson.commands)) verifyCommands = verifyJson.commands;
  } catch {
    // no backlog/verify.json here, or it doesn't parse — package.json
    // scripts (below) is the only other place a command can be "known"
  }

  let scripts = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (pkg.scripts && typeof pkg.scripts === 'object') scripts = pkg.scripts;
  } catch {
    // no package.json here, or it doesn't parse
  }

  return commands.filter((cmd) => {
    if (verifyCommands.includes(cmd)) return false;
    const m = /^(?:pnpm|npm|yarn)\s+(?:run\s+)?([\w:-]+)$/.exec(cmd);
    return !(m && scripts[m[1]] !== undefined);
  });
}

// Layers the "needs-answers" overlay on top of an otherwise-ready item: a
// plan or fix that passed the primary gate can still be hiding an open
// question, and surfacing that is softer than refusing outright — the item
// is still listed (see the brief's own case 5: "still listed, not
// dropped"), just flagged rather than handed straight to a dispatch. Three
// independent triggers, all additive into one `questions` array:
//   1. `TBD` anywhere in the body at all — not just Plan/Fix — because a TBD
//      left in, say, `## Test cases` is just as much an open question as
//      one left in the plan itself.
//   2. A line ending in `?` inside the section the primary gate just read
//      (`## Plan` for a task, `## Fix` for a bug) — that line already reads
//      as a question, so it is used verbatim rather than paraphrased.
//   3. A `## Done when` command this project can't actually resolve (see
//      findUnresolvedCommands above) — phrased as a question because that
//      is literally what it is ("is this command real?"), and it is a
//      WARNING only: it can only ever add a question, never a reason, so it
//      can never by itself turn a ready item into an ungroomed one.
function detectQuestions(body, questionSection, projectRoot) {
  const questions = [];
  if (body.includes('TBD')) {
    questions.push('There is a TBD in this item — what still needs deciding before it can run?');
  }
  if (questionSection) {
    for (const line of questionSection.split('\n')) {
      const t = line.trim();
      if (t.endsWith('?')) questions.push(t);
    }
  }
  const doneWhen = extractSection(body, 'Done when');
  if (doneWhen !== undefined) {
    for (const cmd of findUnresolvedCommands(doneWhen, projectRoot)) {
      questions.push(`## Done when references \`${cmd}\` — is that command actually runnable (not found in verify.json or package.json)?`);
    }
  }
  return questions;
}

// One item's full gate result: `reasons` is non-empty only for `ungroomed`,
// `questions` only for `needs-answers` — the two never overlap, because an
// item whose primary gate already failed has nothing further worth asking:
// its plan or fix isn't real yet, so whether it ALSO contains a TBD is not
// the more useful thing to tell whoever is looking at this queue.
function gateItem(section, body, projectRoot) {
  const { reasons, questionSection } = section === 'tasks' ? gateTask(body) : gateBug(body);
  if (reasons.length > 0) {
    return { gate: 'ungroomed', reasons, questions: [] };
  }
  const questions = detectQuestions(body, questionSection, projectRoot);
  if (questions.length > 0) {
    return { gate: 'needs-answers', reasons: [], questions };
  }
  return { gate: 'ready', reasons: [], questions: [] };
}

// Comma-separated --ids, trimmed — the one flag `plan` and `init` both
// accept and parse identically, so a caller who validated a list against
// one command can hand the exact same string to the other. `undefined` (the
// flag was never given at all) is preserved as `undefined`, not folded into
// `[]`: buildGatedQueue (below) reads the two very differently — no
// restriction at all, vs. an explicit, if empty, selection — and collapsing
// them here would make `--ids ''` silently mean "give me everything"
// instead of "give me nothing," the opposite of what a caller building this
// flag from a possibly-empty list would expect.
function parseIdsArg(idsArg) {
  if (idsArg === undefined) return undefined;
  return idsArg
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// The ref the gate reads, the item worktree is cut from, and the finished
// item is merged into — a run's base. `main` for a run that asked for nothing
// else, which is every run started before task-44.
//
// **This value IS recorded in run.json, as `OrchestratorRun.base`** (task-44).
// The comment that stood here until then said the opposite — "deliberately NOT
// recorded … a value the loop can just pass on each `plan` call" — and that was
// right for as long as the base was a queue gate and nothing else: a gate is
// re-derivable from the flag on every call, so storing it bought nothing but a
// schema change. It stopped being right the moment the base became the ref the
// merge targets. Which branch a run wrote to is not re-derivable from anything
// afterwards — the merge commits are on the base, not in any file this tool
// keeps — so a run that did not record it could not tell anyone where its work
// landed, and `--resume` would have to take the base on trust from whoever
// resumed it rather than from the run's own file. See shared/types.ts's
// `OrchestratorRun.base` for the reader-side half of the same argument.
//
// Still a constant rather than a per-call default: `buildGatedQueue` keeps it
// for a direct hand call, but every command belonging to a RUN reads the
// recorded value out of run.json instead of re-deriving this one.
const BASE_REF_DEFAULT = 'main';

// Generous, because the failure mode of the default 1MB is a truncated blob
// silently gating as ungroomed rather than a loud error. An item file this
// size would be pathological; the ceiling exists so that if one ever is, the
// gate still reads all of it.
const GIT_BLOB_MAX_BUFFER = 16 * 1024 * 1024;

// Returns a `(repo-relative path) => string | null` reader for `<base>`, or
// null when this projectRoot has no usable git view to read from at all — in
// which case buildGatedQueue falls back to the working copy exactly as it
// always did (`plan` stays usable against a bare store; this tool's own
// fixtures/store/ is precisely that, and so is a fresh `git init` with no
// commits yet, where `main` resolves to nothing). The fallback is not a hole
// in the fix: SKILL.md §4's post-checkout probe runs unconditionally and
// catches every case this layer cannot see.
//
// `--show-toplevel` is compared against projectRoot rather than trusting
// `--is-inside-work-tree`: a --project path that merely SITS INSIDE some
// other repository (a scratch directory under one, say) would answer "yes,
// a work tree" and then have every repo-relative path computed against the
// wrong root — silently gating each item against a blob that has nothing to
// do with it. Only a directory that is itself the top of a work tree is
// accepted; anything else takes the fallback.
//
// Every git call here is a read: `rev-parse` and `show` never touch the
// index or the working tree, which is what keeps `plan`'s "writes nothing"
// guarantee true now that it covers git state too.
function blobReaderAt(projectRoot, base) {
  const top = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return null;
  let toplevel;
  let root;
  try {
    toplevel = fs.realpathSync(top.stdout.trim());
    root = fs.realpathSync(projectRoot);
  } catch {
    return null;
  }
  if (toplevel !== root) return null;
  const resolved = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`], { encoding: 'utf8' });
  if (resolved.status !== 0) return null;
  return (relPath) => {
    const shown = spawnSync('git', ['-C', projectRoot, 'show', `${base}:${relPath}`], { encoding: 'utf8', maxBuffer: GIT_BLOB_MAX_BUFFER });
    return shown.status === 0 ? shown.stdout : null;
  };
}

// The queue builder itself: reads every open bug and task under
// `<projectRoot>/backlog`, gates each one, and returns them in the exact
// order the brief specifies (bugs oldest-first, then tasks oldest-first).
// This one function is the queue's only builder: `plan` (below) calls it to
// preview a run and writes nothing at all; `cmdInit` calls this SAME
// function to decide what actually goes into a new run's queue — the brief's
// own words are "the UI's queue preview and init's builder are the same
// code path." Never throws for "no backlog store" (see listOpenItems) —
// only for an --ids entry that names nothing this store has, which is a
// usage error regardless of which caller asked.
function buildGatedQueue(projectRoot, { ids, maxItems = null, base = BASE_REF_DEFAULT } = {}) {
  // task-47. Read per call, never recorded in run.json and never passed down
  // from a caller: a project's source is a COMMITTED marker, so re-deriving it
  // is one `existsSync` and cannot go stale, while a copy on the run would
  // have to be kept true across a `connect` that happened mid-run.
  if (projectSource(projectRoot) === 'github') return orderGatedQueue(trackerCandidates(projectRoot, { ids }), maxItems);

  const backlogDir = path.join(projectRoot, 'backlog');
  const bugs = listOpenItems(backlogDir, 'bugs').sort((a, b) => a.num - b.num);
  const tasks = listOpenItems(backlogDir, 'tasks').sort((a, b) => a.num - b.num);
  const byId = new Map([...bugs, ...tasks].map((item) => [item.id, item]));

  let ordered;
  if (ids !== undefined) {
    ordered = ids.map((id) => {
      const found = byId.get(id);
      if (!found) throw new OrchestrateError(`unknown item id: ${id}`, 1);
      return found;
    });
  } else {
    ordered = [...bugs, ...tasks];
  }

  // `readyCount` is read BEFORE it is possibly incremented for the item
  // currently being examined, so an item only ever counts as "beyond max"
  // once `maxItems` ready items have ALREADY been placed ahead of it — the
  // maxItems-th ready item itself lands exactly on the cap, not past it.
  // Once that line is crossed, every later item is beyond it too, whatever
  // its OWN gate says: a run capped at 2 items is not going to dispatch a
  // 3rd or 4th ready item, and it is equally not going to spend a preflight
  // cycle discovering that the item after the cap happens to be ungroomed
  // either — the cap bounds how much of the queue this run will ever look
  // at, not just how many items it will end up dispatching.
  // One gate verdict for one candidate, read from the bytes the worktree
  // this run would create is actually going to hold — see blobReaderAt above
  // for why that is the ref and not the file on disk. Three outcomes:
  //
  //   - no git view at all (readBlob === null) → the working copy, exactly
  //     as this function always did, and no extra reason;
  //   - the item is absent from <base> → refused before its content is ever
  //     looked at, because there is no content to look at: the session
  //     dispatched into that worktree would find nothing there. The reason
  //     names the path rather than just the condition, since "not committed"
  //     alone leaves the reader guessing which of their items it means;
  //   - present → gated through the UNCHANGED gateItem, on those bytes. That
  //     also closes the sibling case: an item committed while ungroomed and
  //     groomed only in the working copy used to read `ready` and dispatch
  //     into a worktree holding the ungroomed version, where backlog-execute
  //     refuses it and the whole item is spent for nothing.
  //
  // The verdict stays `ungroomed` rather than a new stage value: a new one
  // would mean a new member in RUN_STAGES here, in shared/types.ts's
  // RunStage, in the server's view of it, in the run drawer and in docs/,
  // for a state whose handling is byte-identical to the one that already
  // exists (record it with a note, move to the next item). "Groomed but
  // uncommitted" genuinely is not ungroomed — the distinction lives in the
  // reason string, which is the thing the drawer actually shows.
  //
  // The title for a missing blob comes off the working copy, the only copy
  // that exists; for a present one it comes off the blob, so that everything
  // this function reports about an item describes the same bytes.
  const readBlob = blobReaderAt(projectRoot, base);
  const gateEntry = (entry) => {
    if (readBlob === null) {
      const { title, body, runnerFix } = readItemForGate(entry.path);
      return { title, hoisted: runnerFix, ...gateItem(entry.section, body, projectRoot) };
    }
    const relPath = path.relative(projectRoot, entry.path).split(path.sep).join('/');
    const committed = readBlob(relPath);
    if (committed === null) {
      return {
        title: readItemForGate(entry.path).title,
        // Deliberately NOT the working copy's marker, even though the title
        // right above it is: an item the run cannot see the content of is
        // not an item whose frontmatter gets to reorder the queue. The title
        // is a label on a row that will be printed either way; the marker
        // moves other items.
        hoisted: false,
        gate: 'ungroomed',
        reasons: [`not committed on ${base} — the worktree this run creates from ${base} would not contain ${relPath}`],
        questions: []
      };
    }
    const { title, body, runnerFix } = parseItemForGate(committed);
    return { title, hoisted: runnerFix, ...gateItem(entry.section, body, projectRoot) };
  };

  // Gate everything first, THEN reorder, THEN count the cap. The marker is
  // one of the things gateEntry reads off the item, so it cannot be known
  // before this walk; and `--max` has to be counted over the hoisted order
  // rather than the natural one, which is most of the point — a runner fix
  // that was going to fall outside the cap now lands inside it.
  const gated = ordered.map((entry) => ({ id: entry.id, ...gateEntry(entry) }));

  // The hoist partition and the cap are `orderGatedQueue`'s, shared with the
  // tracker path below — see that function for the rules, which are the
  // queue's rather than either source's.
  return orderGatedQueue(gated, maxItems);
}

// The hoist partition and the `--max` count, over an already-gated list —
// shared by the files walk above and the tracker read below (task-47).
//
// It is one function rather than two identical tails because these are the
// queue's ORDERING rules, and they are the same rules whatever the items came
// out of: a run capped at two items works two items, and a runner fix goes
// first, on GitHub exactly as on disk. The two sources differ in where an
// item's text and marker are READ from, and that is all they differ in — which
// is the whole shape of this phase.
//
// A stable partition, not a sort: every item keeps its relative position
// inside its own half, so the hoisted items stay bugs-before-tasks and
// oldest-first among themselves (or, under `--ids`, in the order the caller
// gave) and everything else keeps the order it already had. The partition
// OUTRANKS the bugs-then-tasks rule rather than sorting inside it — a marked
// task hoists ahead of an unmarked bug, because "repairs the thing about to
// execute the rest of this queue" is a property of the item, not of its
// section.
//
// This applies to `--ids` too, narrowing SKILL.md §1's old "in the order
// given" promise on purpose: OrchestrateSheet sends `ids` for any strict
// subset of its checkbox list, so that list is a *selection*, not an ordering
// — nobody chose the order it arrives in, and exempting `--ids` would defeat
// the hoist on the one surface CLAUDE.md tells you to start runs from.
//
// The gate itself is untouched: membership and verdicts are decided before
// this function is reached, and this only reorders. An ungroomed marked item
// therefore hoists too and appears first in the preview labelled `ungroomed` —
// "the thing that would fix your runner is not groomed" is information, and
// the top of the list is where it will be read.
function orderGatedQueue(gated, maxItems) {
  const hoistedOrder = [...gated.filter((item) => item.hoisted), ...gated.filter((item) => !item.hoisted)];

  // `readyCount` is read BEFORE it is possibly incremented for the item
  // currently being examined — see the long comment above `gateEntry`.
  let readyCount = 0;
  return hoistedOrder.map(({ id, title, gate, reasons, questions, hoisted }) => {
    const beyondMax = maxItems !== null && readyCount >= maxItems;
    if (gate === 'ready') readyCount++;
    return { id, title, gate, reasons, questions, beyondMax, hoisted };
  });
}

// A tracker project's candidates, gated (task-47) — the queue builder's other
// half, and deliberately the ONLY thing about the queue that differs.
//
// Four differences from the files walk above, and each one is the absence of
// something rather than a new rule:
//
//   * The candidates come from `GET /api/items` rather than from a directory
//     walk. Filtered to THIS project by the registry path, raw string compare
//     — the same not-realpath rule every membership check in this app follows.
//   * **There is no `<base>` read and no "not committed on `<base>`" reason.**
//     An issue is not in git; there is no blob for the worktree to be missing,
//     so the skip that exists for one cannot fire. This is also why the tracker
//     path takes no `base` parameter at all.
//   * Each candidate's body comes from `GET /api/items/body`, and goes through
//     the UNCHANGED `gateItem`. A bug still needs Cause and Fix, a task still
//     needs a Plan; the gate never learns where the bytes came from.
//   * `hoisted` reads `item.runnerFix`, the label, where the files walk reads
//     a frontmatter key.
//
// Ordering is bugs then tasks, oldest ISSUE NUMBER first — the same rule the
// files walk applies to its own `<prefix>-<n>` numbers, and for the same
// reason: the oldest open thing has been waiting longest.
function trackerCandidates(projectRoot, { ids }) {
  const index = apiCall('GET', '/api/items');
  if (!index.ok) throw new OrchestrateError(apiErrorText(index, 'GET /api/items was refused'), EXIT_API_REFUSED);
  const all = index.data !== null && Array.isArray(index.data.items) ? index.data.items : [];

  const mine = all.filter((item) => item.projectPath === projectRoot && item.status === 'open' && (item.section === 'bugs' || item.section === 'tasks'));
  // The bare issue number is the id INSIDE a run, and `#31` is the id
  // everywhere else. `#` opens a comment in every shell SKILL.md's fenced
  // blocks use, and this id is substituted into dozens of them — so the `#`
  // comes off once, here, at the one place a run's queue is built.
  // `shared/agent.ts`'s `queueItemIs` is the reader-side half of the same
  // decision.
  const byId = new Map(mine.map((item) => [String(item.id).replace(/^#/, ''), item]));

  const ordered = [];
  if (ids !== undefined) {
    for (const id of ids) {
      /* A tracker run names items by bare number and nothing else. `#31`, a
         URN and a files id are each refused rather than normalised, and the
         refusal names the shape: a caller typing `#31` at a terminal has the
         board's spelling in mind and needs to be told the run's, and a caller
         passing `task-3` is carrying a habit across from a files project.
         Normalising them silently would leave `--ids '#31'` working here and
         failing in every later `stage`/`verify` call that takes the same
         string. */
      if (!/^\d+$/.test(id)) {
        throw new OrchestrateError(`tracker items are named by issue number inside a run — got ${id}`, 1);
      }
      const found = byId.get(id);
      if (!found) throw new OrchestrateError(`unknown item id: ${id}`, 1);
      ordered.push(found);
    }
  } else {
    const num = (item) => Number(String(item.id).replace(/^#/, ''));
    const bugs = mine.filter((item) => item.section === 'bugs').sort((a, b) => num(a) - num(b));
    const tasks = mine.filter((item) => item.section === 'tasks').sort((a, b) => num(a) - num(b));
    ordered.push(...bugs, ...tasks);
  }

  return ordered.map((item) => {
    const id = String(item.id).replace(/^#/, '');
    const body = apiCall('GET', `/api/items/body?path=${encodeURIComponent(item.path)}`);
    if (!body.ok) throw new OrchestrateError(apiErrorText(body, `GET /api/items/body was refused for ${item.path}`), EXIT_API_REFUSED);
    // The route answers `text/plain`, and `api-call.mjs` carries a non-JSON
    // body through as a string for exactly this read.
    const text = typeof body.data === 'string' ? body.data : '';
    return { id, title: item.title, hoisted: item.runnerFix === true, ...gateItem(item.section, text, projectRoot) };
  });
}

// --- the claim, as this machine's state on a tracker item (task-47) ------
//
// Everything in this section runs in TRACKER MODE ONLY. A files run reaches
// none of it, and O-1 pins that by driving a whole stage sequence with the API
// port closed.
//
// ## Who owns the claim
//
// **The driver does, for the whole item.** It claims at `stage <n> preflight`
// — before the worktree exists — and releases at the terminal stage. The
// dispatched `backlog-execute` session never runs `start`, `stop`, `move` or
// `heartbeat` on a tracker item (its SKILL.md says so, and W-3 pins the
// sentence), which is the opposite of the files arrangement where execute
// stamps the item file itself.
//
// The reason is the worktree. A files item's marker is a line in a file the
// execute session has in its own tree; a tracker item's marker is a comment on
// an issue, and the session that would post it lives in a directory with no
// `run.json`, no run id and no way to say which run it belongs to. The driver
// has all three. So the driver claims, and the session does the work.
//
// ## What the claim carries
//
// `run` — six fields identifying the run, on every claim, redundantly (see
// `ClaimRun` in shared/types.ts for why redundantly). `state` — the queue
// item, published so another machine can draw it. Neither is read by anything
// in this build: `run.runId` is read by the SERVER, to decide a same-run
// takeover, and `state` is read by task-48 and by nothing before it.
//
// ## Why a failed heartbeat is never a failure
//
// `run.json` is the journal of record on this machine. The claim's `state` is
// a published COPY of it, and a copy that failed to publish costs a reader on
// another machine one stale reading — where failing the command would cost
// this machine an item mid-flight, over a write nothing local depends on. The
// known trade is that a claim can go stale, and be retired by the next
// contestant, if the API is down for fifteen minutes; that is the protocol
// working as designed rather than a hole in it.

// The stages at which the driver has finished with the item and gives the
// issue back. `needs-answers` is deliberately NOT here: the run is waiting on
// an answer and will come back to the item, so it keeps the claim — the same
// split `RUN_HELD_STAGES` makes on the client side, where a `needs-answers`
// item is still held.
const CLAIM_RELEASE_STAGES = new Set(['merged', 'branched', 'failed', 'skipped', 'parked', 'ungroomed']);

// The registry path a write route gates on. `resolveProjectRoot` already
// refuses a linked worktree (exit 1), so the root this tool resolved IS the
// tree the registry holds — which is what makes a raw string compare on the
// server side correct without a realpath here.
function claimProjectOf(run) {
  return run.project;
}

// A queue id (`31`) as the id the routes take (`#31`). The one place the two
// spellings meet inside this tool — see `trackerCandidates` for why the queue
// holds the bare number at all.
function claimItemId(itemId) {
  return `#${itemId}`;
}

// The six run facts every claim carries. `mergeModeEffective` rather than
// `mergeMode`: a reader on another machine wants to know whether this item
// will be merged, not what was hoped for before a classifier said no.
function claimRunOf(run) {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    mergeMode: run.mergeModeEffective ?? run.mergeMode ?? 'merge',
    questionMode: run.questionMode ?? 'park',
    maxItems: run.maxItems ?? null,
    base: run.base ?? BASE_REF_DEFAULT
  };
}

// The queue item, as `ClaimState` (shared/types.ts). Field by field rather
// than a spread of the item, and deliberately: the item is this machine's
// record and this is a PUBLISHED shape with mixed-version readers by
// construction, so what crosses that boundary has to be a decision rather than
// a consequence of whatever `RunQueueItem` grew this week.
function claimStateOf(item) {
  return {
    stage: item.stage,
    stageAt: item.stageAt,
    worktree: item.worktree,
    branch: item.branch,
    sessionId: item.sessionId,
    fixLoops: item.fixLoops,
    verification: item.verification,
    usage: item.usage,
    assumptions: item.assumptions,
    note: item.note
  };
}

/**
 * Publish this item's state onto its claim. Best-effort, always.
 *
 * Called by every command that changes an item's fields — `stage`, `usage`,
 * `verify`, `assume`, and `watch`'s tick — AFTER the run file is written, so
 * what it publishes is what this machine actually recorded rather than what it
 * was about to.
 *
 * A failure is one stderr line and never a failure of the command. See this
 * section's header for why; the short version is that `run.json` is the
 * journal of record and this is a copy of it.
 *
 * No claim on the item means nothing to heartbeat — an item the run reached
 * before `preflight`, or one whose claim was lost — and that is silence rather
 * than a complaint: there is no failure to report.
 */
function trackerHeartbeat(run, item) {
  if (item.claim === undefined) return;
  try {
    const res = apiCall('POST', '/api/items/heartbeat', {
      project: claimProjectOf(run),
      id: claimItemId(item.id),
      commentId: item.claim.commentId,
      state: claimStateOf(item)
    });
    if (!res.ok) console.error(`heartbeat for ${item.id} was refused: ${apiErrorText(res, 'the API refused it')}`);
  } catch (e) {
    console.error(`heartbeat for ${item.id} could not be sent: ${e.message}`);
  }
}

/**
 * This run's bill for one item, added to what the claim already carries.
 *
 * The counters are the ITEM's running totals across every session that has
 * ever worked it, so they are READ first and added to — never recomputed.
 * `GET /api/items/claim` answers the newest claim, released or not, which is
 * where those totals live.
 *
 * What this run spent is the sum over its own `usage` entries: seconds of
 * wall-clock, and the three token kinds that are actually BILLED. Cache READS
 * are excluded, exactly as `backlog.mjs stop` excludes them for a files item —
 * they routinely run an order of magnitude above everything else and including
 * them would make the counter a measure of context size rather than of work.
 *
 * A `null` field contributes nothing, and if EVERY field of every entry is
 * `null` the read counters are sent back unchanged. That is the same
 * distinction `usage` itself keeps: "nothing was recorded" is not "it cost
 * zero", and writing zeros over a total somebody else accumulated would erase
 * their work to record the absence of ours.
 */
function claimCountersFor(run, item) {
  const held = apiCall('GET', `/api/items/claim?project=${encodeURIComponent(claimProjectOf(run))}&id=${encodeURIComponent(claimItemId(item.id))}`);
  /* A FAILED read sends no `counters` key at all, which is not the same as
     four zeros — the route treats an absent key as "nothing to bill" and
     leaves the claim's totals alone, where zeros would overwrite every earlier
     session's work on the item. The same distinction `--abandon` relies on in
     `backlog.mjs stop`. A SUCCESSFUL read answering `null` is a different
     thing and is zeros: nobody has ever claimed this item, so there is nothing
     to carry forward. */
  if (!held.ok) {
    console.error(`could not read ${claimItemId(item.id)}'s counters — releasing without billing rather than overwriting them with zeros`);
    return undefined;
  }
  const base =
    held.data !== null && held.data.record && held.data.record.counters
      ? held.data.record.counters
      : { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 };

  let ms = 0;
  let tokens = 0;
  for (const entry of item.usage ?? []) {
    if (Number.isFinite(entry.durationMs)) ms += entry.durationMs;
    for (const key of ['inputTokens', 'outputTokens', 'cacheCreationTokens']) {
      if (Number.isFinite(entry[key])) tokens += entry[key];
    }
  }

  return {
    groomElapsed: base.groomElapsed ?? 0,
    // A run is EXECUTION, which is why the claim's `phase` is `'execute'` and
    // why the bill lands in this pair. `ClaimRecord.phase` has two values and
    // a driver is never grooming.
    executeElapsed: (base.executeElapsed ?? 0) + Math.floor(ms / 1000),
    groomTokens: base.groomTokens ?? 0,
    executeTokens: (base.executeTokens ?? 0) + tokens
  };
}

/**
 * Give the issue back, billing this run's spend — the terminal half of the
 * claim's life.
 *
 * Best-effort like the heartbeat, and for a sharper version of the same
 * reason: by the time this runs the item has REACHED its terminal stage, and
 * on the `merged` path the issue is already closed. Failing the command would
 * report a finished item as unfinished. A dangling live claim goes stale on
 * its own within `CLAIM_STALE_MS`, which is the protocol's own repair.
 */
function trackerRelease(run, item, reason, counters = undefined) {
  if (item.claim === undefined) return;
  try {
    // Read here unless the caller already read them. `stage <n> merged` reads
    // them BEFORE it closes the issue, so the three requests that path makes
    // arrive in the order `GET claim`, `state`, `release` — the counters are
    // the item's running totals and are read while the claim is plainly still
    // the newest thing on the issue, rather than after a close has put a
    // comment on it.
    const billed = counters === undefined ? claimCountersFor(run, item) : counters;
    const payload = {
      project: claimProjectOf(run),
      id: claimItemId(item.id),
      commentId: item.claim.commentId,
      session: sessionIdentity() ?? run.runId,
      reason
    };
    // Omitted rather than sent as zeros when the read failed — see
    // `claimCountersFor`.
    if (billed !== undefined) payload.counters = billed;
    const res = apiCall('POST', '/api/items/release', payload);
    if (!res.ok) console.error(`release of ${item.id} was refused: ${apiErrorText(res, 'the API refused it')}`);
  } catch (e) {
    console.error(`release of ${item.id} could not be sent: ${e.message}`);
  }
}

/**
 * Take the issue for this run, at `preflight` or on a resume.
 *
 * Three outcomes, and the middle one is the whole point of the phase:
 *
 *   * **Won** — `{ won: true, commentId }`. The caller stores it on the queue
 *     item and carries on.
 *   * **Held by another run** — `{ won: false, note }`. A refusal here is
 *     INFORMATION, not a failure: another machine is working this item, and
 *     the right answer is to skip it and move to the next one. Exit `0`.
 *   * **Anything else** — a throw with exit `9`. A 503 with no token, a 502
 *     from GitHub: the run cannot know whether it holds the item, and
 *     proceeding on that would be two sessions on one issue.
 *
 * The 409 is told from the rest by its `holder`, which only the claim route's
 * conflict answer carries — never by parsing the sentence.
 *
 * A resumed driver's re-claim succeeds against its OWN run's live claim
 * because the SERVER treats a matching `run.runId` as a takeover rather than a
 * contest (`GithubSource.claim`). That is why `run` is sent on every claim and
 * not only the first.
 */
function trackerClaim(run, item) {
  const res = apiCall('POST', '/api/items/claim', {
    project: claimProjectOf(run),
    id: claimItemId(item.id),
    phase: 'execute',
    session: sessionIdentity() ?? run.runId,
    run: claimRunOf(run)
  });
  if (res.ok) return { won: true, commentId: res.data.commentId };

  const holder = res.data !== null && typeof res.data === 'object' ? res.data.holder : undefined;
  if (holder !== undefined && holder !== null) {
    const age = Number.isFinite(holder.ageMs) ? `${Math.round(holder.ageMs / 1000)}s` : 'unknown';
    return { won: false, note: `claimed elsewhere (session ${holder.session}, heartbeat ${age} ago)` };
  }
  throw new OrchestrateError(`claiming ${claimItemId(item.id)} was refused: ${apiErrorText(res, 'the API refused it')}`, EXIT_API_REFUSED);
}

/**
 * Close the issue with the Outcome as its closing comment — `stage <n> merged`
 * and nothing else calls this.
 *
 * Comment first, then close, which is task-46's `state` route doing it in one
 * call: the issue's timeline then reads in the order the work happened.
 *
 * A failure THROWS with exit `9` and the caller writes nothing. That is the
 * one place in this section where a refusal is fatal, and the asymmetry with
 * the heartbeat and the release is deliberate: those two publish a copy of
 * something already true locally, while this one is the only record anywhere
 * that the item is done. An item staged `merged` whose issue is still open
 * would be an issue nobody ever closes, because the run has moved on and no
 * later command looks back.
 */
function trackerClose(run, item, outcome) {
  const res = apiCall('POST', '/api/items/state', {
    project: claimProjectOf(run),
    id: claimItemId(item.id),
    status: 'done',
    outcome
  });
  if (!res.ok) {
    throw new OrchestrateError(
      `${claimItemId(item.id)} was merged and pushed, but closing the issue was refused: ${apiErrorText(res, 'the API refused it')}. Nothing was written.`,
      EXIT_API_REFUSED
    );
  }
}

// The two sidecar directories a TRACKER run writes (task-47), and the reason
// they are directories under `<dir>` rather than files in the worktree:
//
//   * `outcomes/<n>.md` — created empty by the driver before dispatch, written
//     by the execute session, read by `snapshot` and by `stage merged`. It is
//     NOT in the worktree because the driver's own `git add -A` (§6) would
//     commit it into the project's history — an execute session's report
//     landing as a file on the item's branch, in a repo whose items are
//     issues.
//   * `items/<n>.md` — the snapshot the reviewer is handed where a files run
//     hands the item file. Under `<dir>` for the same reason, and so that the
//     existing archive mover carries both away with the run: `archiveSidecars`
//     is a DENYLIST of two (`run.json`, `runs/`), so a new sidecar directory
//     needs no change to it at all.
function outcomeFilePath(dir, itemId) {
  return path.join(dir, 'outcomes', `${itemId}.md`);
}

function snapshotFilePath(dir, itemId) {
  return path.join(dir, 'items', `${itemId}.md`);
}

const SNAPSHOT_USAGE = 'usage: orchestrate.mjs snapshot <itemId>';

/**
 * Write the item, as one file, for the things that expect an item file
 * (task-47) — the reviewer, and `verify`'s `## Done when` read.
 *
 * `<dir>/items/<n>.md` is the issue's body, then `## Outcome`, then whatever
 * the execute session wrote to `<dir>/outcomes/<n>.md`. That is exactly what a
 * files run's item file looks like at this point in the loop: the item's text
 * with the session's Outcome appended.
 *
 * **Why a file at all, when the API could answer the same question.** The
 * reviewer's input contract is "here is the item file path", and it is an
 * agent with `Read` — handing it a URN would mean a new code path, a running
 * stack, and a contract that differs by project source. `itemDoneWhenCommands`
 * is the same story one layer down. A snapshot keeps both contracts byte-identical
 * and costs one write.
 *
 * Re-run after each fix loop, deliberately: the Outcome grows with every loop,
 * and a reviewer reading the first loop's snapshot would be reviewing a report
 * that no longer describes the branch.
 *
 * Exit `1` in files mode. Not a silent no-op: a driver calling this against a
 * files project has misread which loop it is in, and the item file it should
 * be pointing the reviewer at already exists.
 */
function cmdSnapshot(argv) {
  const itemId = argv[0];
  if (!itemId) throw new OrchestrateError(SNAPSHOT_USAGE, 1);

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  const item = findQueueItem(run, itemId);
  if (projectSource(run.project) !== 'github') {
    throw new OrchestrateError('snapshot is for a tracker project — a files item already has a file, in the worktree the session wrote it in', 1);
  }

  const body = apiCall('GET', `/api/items/body?path=${encodeURIComponent(`gh:${trackerRepoOf(run)}#${itemId}`)}`);
  if (!body.ok) throw new OrchestrateError(apiErrorText(body, `GET /api/items/body was refused for ${claimItemId(itemId)}`), EXIT_API_REFUSED);
  const text = typeof body.data === 'string' ? body.data : '';

  // A missing outcome file is an EMPTY Outcome, not a refusal. §5's inspect
  // step has already decided what an empty one means (the session left
  // nothing, which is the same evidence as an unmoved item file in a files
  // run) and taken its own branch on it; this command's job is to record what
  // is there.
  const outcomePath = outcomeFilePath(dir, itemId);
  const outcome = fs.existsSync(outcomePath) ? fs.readFileSync(outcomePath, 'utf8') : '';

  const target = snapshotFilePath(dir, itemId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${text.replace(/\s*$/, '')}\n\n## Outcome\n\n${outcome.replace(/^\s*/, '')}`);
  console.log(JSON.stringify({ id: itemId, snapshot: target, title: item.title }));
  return 0;
}

// The repo a tracker project is connected to, read from the same committed
// marker `projectSource` reads — needed because a body is fetched by URN and
// a URN names the repository. Read per call and cached nowhere, like every
// other reader of this file.
function trackerRepoOf(run) {
  const marker = path.join(run.project, 'backlog', 'source.json');
  const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  return parsed.repo;
}

// --- shared queue-item lookup + field application ---------------------
// Factored out of what used to be cmdStage's own inline body so Task 5's
// `watch` can write a session id it discovers mid-run through the EXACT
// SAME code path `stage --session` uses, rather than a second
// implementation that could silently drift from it (e.g. forgetting the
// first-arrival stageAt guard below, or the field undefined-vs-explicit-
// value distinction this function's callers both rely on). Neither
// function touches `run.updatedAt` or writes the file — every caller does
// both itself, since a plain stage transition and a heartbeat-driven
// session-id write want that timestamp bump for different reasons and at
// different points in their own control flow.

function findQueueItem(run, itemId) {
  const item = run.queue.find((q) => q.id === itemId);
  if (!item) {
    throw new OrchestrateError(`unknown item id: ${itemId}`, 1);
  }
  return item;
}

function applyQueueItemFields(item, { stage, session, worktree, branch, note, permissionMode, fixLoop = false } = {}) {
  if (stage !== undefined) {
    item.stage = stage;
    // First-arrival only — see shared/types.ts's own RunQueueItem.stageAt
    // comment: a fix-and-re-review loop revisiting `reviewing`/`fixing`
    // must not move that stage's timestamp forward a second time.
    if (!(stage in item.stageAt)) {
      item.stageAt[stage] = nowISO();
    }
  }
  // `fixLoops` is the ONLY counter in a queue item, and this is the only
  // place it ever moves. It exists because the skill's own ceiling ("at most
  // two fix loops per item") has to survive the thing most likely to break
  // it: a crash and a `--resume`, after which the session enforcing that
  // ceiling from memory is gone and a brand-new one takes over. Counted in
  // the run file, the ceiling is still there after the resume; counted in
  // the orchestrator's head, an item could loop forever, two loops at a
  // time. Deliberately a separate boolean rather than being inferred from
  // `stage === 'fixing'`: the run file records first ARRIVAL at a stage
  // (see stageAt above), so a second visit to `fixing` is indistinguishable
  // from the first by stage alone, and a caller that re-stages an item for
  // any other reason must not silently spend one of its two loops.
  if (fixLoop) {
    // Guarded rather than a bare `+ 1` because a non-integer would go
    // through JSON.stringify as `null` (NaN has no JSON form) and silently
    // disarm the ceiling on the next read — this file writes no NaN
    // anywhere, and this is the one arithmetic site where it could sneak in
    // from a run.json that reached us some other way (a hand-edit, a
    // restored backup).
    item.fixLoops = Number.isInteger(item.fixLoops) ? item.fixLoops + 1 : 1;
  }
  if (session !== undefined) item.sessionId = session;
  if (worktree !== undefined) item.worktree = worktree;
  if (branch !== undefined) item.branch = branch;
  if (permissionMode !== undefined) item.permissionMode = permissionMode;
  if (note !== undefined) item.note = note;
}

// --- Task 5 shared helpers: item files inside a worktree, git plumbing ----
// `verify`, `reconcile`, and `abort` all need to find one backlog item's
// file inside an arbitrary directory (a worktree, or `--cwd`) and ask
// whether it currently carries an in-progress marker — two small, narrow
// readers in the same spirit as readItemForGate above (see that section's
// own header comment for why this file keeps rolling its own tiny readers
// instead of importing backlog.mjs's parseFrontmatter).

// Finds one backlog item's file by id under `<dir>/backlog/{bugs,tasks}/
// {open,done}` — broader than listOpenItems' open-only search (used by the
// gate above) because by the time verify/reconcile/abort run, backlog-
// execute has typically already moved the item to done/ inside the
// worktree (see the design spec's own per-item loop, step 2 — the archive
// move happens INSIDE the headless session, before review/verify/merge
// ever run against the branch). Same `^<id>-` prefix convention as
// listOpenItems; returns null rather than throwing when nothing matches —
// "no item file here" is a normal thing for a crashed or pre-dispatch item
// to report, not an error.
function findItemFilePath(dir, itemId) {
  const idPattern = new RegExp(`^${itemId}-`);
  for (const section of ['bugs', 'tasks']) {
    for (const state of ['open', 'done']) {
      const sectionDir = path.join(dir, 'backlog', section, state);
      if (!fs.existsSync(sectionDir)) continue;
      const found = fs.readdirSync(sectionDir).find((name) => idPattern.test(name));
      if (found) return { path: path.join(sectionDir, found), section, state };
    }
  }
  return null;
}

// True when the item file at `absPath` carries a `<key>:` line inside its
// frontmatter fence — a one-key version of readItemForGate's own line
// splitter, reused below for both `started` (reconcile reports it, purely
// as information) and `phase` (reconcile/abort's actual decision signal —
// see itemHasPhaseMarker's own comment for why the two are not
// interchangeable).
function itemFrontmatterHasKey(absPath, key) {
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  if (lines[0] !== '---') return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const sep = lines[i].indexOf(':');
    if (sep === -1) continue;
    if (lines[i].slice(0, sep).trim() === key) return true;
  }
  return false;
}

// Deliberately `phase:` alone, not `started:` too, even though CLAUDE.md's
// own invariant describes both keys together as "the marker." The two mean
// different things once `--keep-started` enters the picture (see that
// invariant's own long paragraph): `backlog-execute`'s SUCCESSFUL archive
// path calls `stop --keep-started`, which removes `phase:` but
// deliberately leaves `started:` behind for provenance — so a plain
// `started:` with no `phase:` is a NORMAL completed item, not a crash.
// Only `phase:` still being present means a session was genuinely live
// when whatever holds this worktree stopped updating it — which is exactly
// the thing reconcile/abort need to tell apart from "finished cleanly, the
// orchestrator just hasn't gotten to it yet."
function itemHasPhaseMarker(absPath) {
  return itemFrontmatterHasKey(absPath, 'phase');
}

// `git show-ref` rather than `git branch --list` — a plumbing command with
// a stable, script-friendly exit code (0 found, 1 not found) instead of
// parsing porcelain output for presence. Run against `projectRoot` (the
// MAIN tree, always — see resolveProjectRoot's own comment on why every
// command in this file runs from there): a linked worktree's branch is a
// branch in the SAME repository, visible from the main tree regardless of
// whether the worktree directory itself still exists on disk.
function branchExists(projectRoot, branch) {
  if (!branch) return false;
  return spawnSync('git', ['-C', projectRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

// task-44: the two checks a run-scoped base must pass, in this order, before
// `init` writes anything. A base is not just a gate any more — it is the ref
// item worktrees are cut from and finished items are merged INTO — so only an
// existing LOCAL branch will do. A tag and a SHA cannot move; a
// remote-tracking ref like `origin/main` is not a thing this repository can
// merge into; and a branch that does not exist is a typo, not an instruction
// to create one (creating the base is a stated non-goal of the design).
//
// The order is deliberate, and the reason is worth stating accurately rather
// than flatteringly. It is NOT that `branchExists` below would otherwise read
// the value as an option — it interpolates into `refs/heads/${base}`, which
// can never begin with a `-`, and measuring confirms that check alone refuses
// every value the format check does. The format check runs first because the
// base this function accepts goes on to be substituted for `<base>` in
// SKILL.md's own shell commands (`git worktree add … <base>`, `git -C …
// merge --no-edit <base>`), where a leading `-` or embedded whitespace WOULD
// be read as an option or split an argument. Proving the string is well
// formed before anything records it is what keeps that safe, and running it
// first is also what makes the refusal say "not a ref name" rather than "no
// such branch".
//
// Measured on this machine's git before any of it was relied on: `--branch`
// refuses `''`, `-x`, `has space`, `a..b` and `a~1` with exit 128, and
// ACCEPTS `origin/main`, a 40-hex SHA and any unknown name with exit 0 — all
// three of which are then refused by `branchExists`. So neither check alone
// is the rule; the pair is.
//
// A leading `-` is refused here in JS as well, rather than left to git. That
// same probe showed git treats `--branch`'s value positionally and so already
// rejects `-x`, but the guarantee we want is "this function never hands git an
// argument that could be read as a flag", and a guarantee borrowed from
// another program's argument parser is one that can be revised by that
// program's next release. `git check-ref-format` has no `--` separator to fall
// back on (it exits 129 on one), so this is the only way to own the property.
function assertUsableBase(projectRoot, base) {
  if (typeof base !== 'string' || base === '' || base.startsWith('-')) {
    throw new OrchestrateError(`--base must be an existing local branch: ${JSON.stringify(base ?? null)} is not a valid branch name`, 1);
  }
  if (spawnSync('git', ['check-ref-format', '--branch', base]).status !== 0) {
    throw new OrchestrateError(`--base must be an existing local branch: ${JSON.stringify(base)} is not a valid branch name`, 1);
  }
  if (!branchExists(projectRoot, base) && !isUnbornHead(projectRoot, base)) {
    throw new OrchestrateError(
      `--base must be an existing local branch: ${JSON.stringify(base)} is not a branch in ${projectRoot} ` +
        `(a tag, a commit SHA and a remote-tracking ref such as origin/main are all refused — a run merges INTO its base, and only a local branch can move)`,
      1
    );
  }
}

// The third accepted case, and the one a two-line version of this rule gets
// wrong: a branch that HEAD already points at but which has no commit yet.
//
// `git init` leaves HEAD at `refs/heads/main` (or whatever `init.defaultBranch`
// says) with no such ref on disk, so `show-ref` correctly answers "no" for a
// repository nobody has committed to. Refusing that would change `init`'s
// behaviour in a fresh repository from "write a run with an empty queue" —
// which is tested, and is the state every `orchestrate.test.mjs` fixture is in
// — to exit 1, for a base nobody chose and that names the branch the
// repository is literally on. That is a regression dressed up as strictness.
//
// It stays narrow on purpose: the base must be the branch HEAD points at, not
// merely absent. `--base feature/x` in a commitless repo is still refused,
// because HEAD is on `main`; `--base main` in a repo whose HEAD is on `master`
// is still refused, for the mirror-image reason. So the typo this check exists
// to keep catching is still caught.
//
// Honest about what it does NOT promise: an unborn base cannot actually be
// merged into, and a run that reached §9 with one would fail there. Nothing
// about task-44 made that worse — `worktree add` from an unborn `main` has
// always failed the same way — and pretending otherwise by refusing at `init`
// would trade a clear late failure for a confusing early one in the one case
// where the base is not the user's choice at all.
function isUnbornHead(projectRoot, base) {
  const head = spawnSync('git', ['-C', projectRoot, 'symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' });
  return head.status === 0 && head.stdout.trim() === `refs/heads/${base}`;
}

// The working tree that has `<branch>` checked out, or `null` (task-47).
//
// The same `worktree list --porcelain` scan SKILL.md §9 spells out, in the
// tool because `init` needs the answer too — and it needs it for the same
// reason §9 does: "the main tree" and "the tree holding `main`" are not
// synonyms, and on a `--base feature/x` run they are different directories.
// A command aimed at the wrong one silently acts on the wrong branch.
//
// Repo-wide and HEAD-independent, so it is correct from the project root:
// `worktree list` reports the repository's trees whichever of them it is
// typed in.
//
// `null` covers the two states §9 enumerates as outcomes 2 and 3 — no tree
// holds the base, and a tree holds it but is mid-rebase and reports
// `detached`. Neither is distinguishable here and neither needs to be: both
// mean "there is nothing checked out on this branch to fast-forward".
function treeHoldingBranch(projectRoot, branch) {
  const listed = spawnSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (listed.status !== 0) return null;
  let current = null;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && current !== null) return current;
  }
  return null;
}

/**
 * `init`'s pull, for a TRACKER project only (task-47, spec §7.5).
 *
 * A tracker project is shared by definition — that is the whole point of the
 * phase — so the machine starting a run may be behind a base another machine
 * pushed. Every item this run merges lands on that base and is then pushed
 * back, and a push from a tree that never caught up is rejected at the end of
 * the first item, after the whole pipeline has been spent on it. Pulling at
 * `init` moves that failure to the one moment when nothing has been built yet
 * and nothing has been written.
 *
 * **A failure refuses the init**: exit `1`, nothing written, git's own stderr
 * quoted. Not a warning, because the thing that cannot fast-forward is the
 * branch every item of this run is about to be cut from — a run that started
 * anyway would produce worktrees from a commit that is not what anybody else's
 * `main` means.
 *
 * `plan` never calls this. `plan` writes nothing, and git state counts as
 * state: a preview that quietly moved a branch would be the one command in
 * this tool whose "writes nothing at all" promise was false.
 *
 * Two skips, and each is an absence rather than a tolerance:
 *
 *   * **No `origin`.** There is nothing to pull from — a repo with a tracker
 *     marker and no remote is odd but not this command's business to refuse.
 *   * **No tree holds `<base>`.** Nothing is checked out on it, so there is no
 *     fast-forward to attempt. §9 creates a base worktree from the local ref
 *     when it needs one, and SKILL.md §8's per-item pull runs in whatever tree
 *     that resolution settled on — which is where the miss is caught.
 *
 * `origin <base>` explicitly rather than a bare `pull`: a bare one needs
 * upstream tracking configured, which a fresh clone of somebody else's branch
 * does not necessarily have, and would otherwise fail with a message about
 * tracking information that has nothing to do with what went wrong.
 */
function pullBaseAtInit(projectRoot, base) {
  if (spawnSync('git', ['-C', projectRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).status !== 0) return;
  const tree = treeHoldingBranch(projectRoot, base);
  if (tree === null) return;

  const pulled = spawnSync('git', ['-C', tree, 'pull', '--ff-only', 'origin', base], { encoding: 'utf8' });
  if (pulled.status === 0) return;
  throw new OrchestrateError(
    `git pull --ff-only origin ${base} failed in ${tree} — another machine has pushed something this tree cannot fast-forward onto. ` +
      `Nothing was written. git said: ${(pulled.stderr || pulled.stdout || '').trim()}`,
    1
  );
}

// --- commands ----------------------------------------------------------
// Each cmdXxx function is the CLI's own contract for one command: parse
// this command's flags, validate everything that can be validated before
// touching disk, then do the one thing this command does. `main` (bottom of
// file) is deliberately thin — a plain command-name dispatch plus one
// try/catch around all of them — rather than backlog.mjs's inline-per-
// command style, so the contract for "what does `stage` do" lives entirely
// inside cmdStage and not spread across a bigger switch.

const INIT_USAGE =
  'usage: orchestrate.mjs init --project <abs path> [--ids a,b,c] [--max N] [--base <ref>] [--merge-mode <merge|branch>] [--question-mode <decide|park>]';

function cmdInit(argv) {
  let project;
  let idsArg;
  let maxArg;
  // Defaulted at the flag rather than left undefined for buildGatedQueue to
  // fill in, so that an ABSENT `--base` and an EXPLICIT one are the same value
  // by the time anything reads it. `--base ''` is no longer the "resolves to
  // nothing and takes the fallback" case this comment used to describe: since
  // task-44 the base is merged into, not merely read at, so `assertUsableBase`
  // below refuses `''` outright (exit 1, nothing written) rather than letting
  // it silently mean `main`. The server never sends that value — it treats an
  // empty `base` in a request as absent and appends no flag at all — so the
  // refusal is aimed at a hand call, which is exactly the caller that benefits
  // from being told its flag had no argument.
  let base = BASE_REF_DEFAULT;
  // Same reasoning as `base` above: defaulted right here so an absent flag
  // reads as the literal value 'merge' everywhere below rather than as
  // undefined needing its own fallback later — and so this run's very
  // first `mergeMode`/`mergeModeEffective` pair is byte-identical to a run
  // started before this flag existed at all (design §2.5: "a new key must
  // not silently change the behaviour of a board that has been working for
  // a fortnight").
  let mergeMode = 'merge';
  // Same defaulting reasoning as `mergeMode` directly above, with the
  // default inverted: 'park' is what every run did before this flag
  // existed, so an absent flag has to read as the literal 'park' here for a
  // board that has been working for a fortnight to keep behaving the way it
  // always has.
  let questionMode = 'park';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') project = argv[++i];
    else if (argv[i] === '--ids') idsArg = argv[++i];
    else if (argv[i] === '--max') maxArg = argv[++i];
    else if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--merge-mode') mergeMode = argv[++i];
    else if (argv[i] === '--question-mode') questionMode = argv[++i];
  }

  // Validated before anything else touches disk: an unusable --project is a
  // shape problem with the call itself, and init must write nothing at all
  // when it refuses (same "validate first, mutate last" order backlog.mjs
  // uses for its own section/--from checks). Absolute, specifically,
  // because the project key downstream (projectDir/encodeURIComponent) and
  // every other command's cwd-based resolveProjectRoot() must agree on
  // exactly the same string — a relative path here would key a run under a
  // string no other command could ever reproduce from its own cwd.
  if (!project || !path.isAbsolute(project)) {
    throw new OrchestrateError(INIT_USAGE, 1);
  }

  // The same worktree refusal resolveProjectRoot applies to a cwd-derived
  // root, applied here to the `--project`-derived one — bug-2's second
  // entry point. init is the one command that never walks up from cwd, so
  // without this a worktree path handed straight to `--project` would key a
  // run under a directory nothing else ever reads, and every subsequent
  // command (correctly resolving the real project root) would report exit 3
  // for a run that was written successfully. Checked here, before --max is
  // even parsed, so the "nothing written when init refuses" guarantee holds.
  const projectWorktree = linkedWorktreeInfo(project);
  if (projectWorktree) refuseLinkedWorktree(projectWorktree);

  // Validated in this SAME block, immediately after the two checks above —
  // the task-3 brief pins this exact ordering, and the reason is the same
  // "validate first, mutate last" guarantee those two already give: a
  // caller cannot tell from the outside whether --merge-mode was checked
  // before or after --project, but a bug that checked it AFTER
  // buildGatedQueue (which does real filesystem/git work) could leave a
  // half-built queue's side effects behind an eventual throw. An
  // unrecognized --merge-mode is a shape problem with the call itself,
  // exactly like a non-absolute --project or a linked-worktree --project,
  // so it is refused the same way: exit 1, nothing written. Checked
  // against MERGE_MODES rather than `mergeMode !== 'merge' && mergeMode
  // !== 'branch'` for the "one copy of the vocabulary" reason that
  // constant's own comment gives.
  if (!MERGE_MODES.includes(mergeMode)) {
    throw new OrchestrateError(`--merge-mode must be one of ${MERGE_MODES.join(', ')} (got ${mergeMode === undefined ? 'no value' : mergeMode})`, 1);
  }

  // Checked in the same pre-write block, immediately after --merge-mode,
  // and the ordering carries more weight here than the message shape does:
  // cmdInit ARCHIVES any existing run.json before writing the new one, so a
  // validation that ran after that point would destroy a real run's file on
  // behalf of a call that was never going to succeed. Exit 1 with nothing
  // written is the same posture --merge-mode takes, and the `(got no
  // value)` branch is the same one, because a flag whose argv slot does not
  // exist is a different mistake from a flag whose value is misspelled and
  // the caller has to be able to tell them apart.
  if (!QUESTION_MODES.includes(questionMode)) {
    throw new OrchestrateError(
      `--question-mode must be one of ${QUESTION_MODES.join(', ')} (got ${questionMode === undefined ? 'no value' : questionMode})`,
      1
    );
  }

  // task-44, and in this same pre-write block for the reason --question-mode's
  // comment directly above gives in full: cmdInit ARCHIVES any existing
  // run.json before it writes the new one, so a base validated after that
  // point would destroy a real run's file on behalf of a call that was never
  // going to succeed. It goes last of the four because it is the only one that
  // touches the filesystem — the other three are membership tests against
  // constants — and there is no reason to shell out to git twice before a
  // misspelled --merge-mode has even been caught.
  //
  // Re-checked here rather than trusted from the caller because this tool is
  // driven by hand as well as by POST /api/agents/orchestrate. The endpoint
  // runs its own copy of the same two checks (`resolveBase`,
  // agents.service.ts) and that is not redundancy to be collapsed: the
  // endpoint's copy exists to refuse a bad request BEFORE it spawns a headless
  // session, and this one exists because a terminal is not the endpoint.
  assertUsableBase(project, base);

  let maxItems = null;
  if (maxArg !== undefined) {
    const n = Number(maxArg);
    if (!Number.isInteger(n) || n < 0) {
      throw new OrchestrateError(`--max must be a non-negative integer: ${maxArg}`, 1);
    }
    maxItems = n;
  }

  // The queue is built — and, critically, FULLY VALIDATED — before this
  // function does anything to the filesystem: before orchHome()/projectDir
  // are even consulted, before any directory is created, before an
  // existing run.json is read for the lock check, and before that existing
  // run.json is archived away. This ordering fixes a real bug a reviewer
  // reproduced live: with validation done LATER (as an earlier version of
  // this function had it), a bad queue build arriving after a prior `done`
  // run would archive the done run to runs/<runId>.json and THEN throw —
  // leaving the project with no run.json at all. The data wasn't lost (it
  // survived under runs/), but `status` would then wrongly report exit 3
  // ("no run exists"), and a fresh project's `init` would even leave behind
  // a stray empty directory (see writeRunAtomic/archiveStem below, both of
  // which now create their own directories on demand instead of this
  // function pre-creating one). Validating first — today that means
  // buildGatedQueue throwing on an --ids entry this store doesn't have —
  // means a bad call can never destroy or hide state that already existed;
  // the failure is confined to "nothing written," the same guarantee every
  // other error path in this file already gives.
  // task-47, and BEFORE the queue is built rather than after: a queue built
  // from `GET /api/items` is already current, but the WORKTREES this run will
  // cut come from the local base, and every later item merges into it. Still
  // inside the "nothing written" block — the pull moves git state, which is
  // the project's, and writes nothing of this tool's. A files project never
  // reaches this call, which is why the source is asked first.
  if (projectSource(project) === 'github') pullBaseAtInit(project, base);

  const stamp = nowISO();
  // buildGatedQueue is the exact function `plan` (below) calls to preview a
  // run — see its own comment for the ordering/gate/max rules, kept in one
  // place. init deliberately does NOT carry an ungroomed or needs-answers
  // item's reasons/questions into the queue item it writes here: those are
  // a snapshot of the gate at THIS instant, and a run can span hours during
  // which a human might groom the very item this instant found wanting.
  // Baking a stale verdict into run.json would give the orchestrator loop
  // (a later task) no reason to ever look again — so init only uses the
  // gate to decide MEMBERSHIP (excluding whatever --max pushed past the
  // cap) and ORDER, and leaves the per-item gate re-check, right before
  // that item is actually dispatched, to whichever later task drives the
  // loop. Every item that makes the cut starts exactly like every queue
  // item always has: `pending`, via the same makeQueueItem every other
  // caller already uses.
  const gated = buildGatedQueue(project, { ids: parseIdsArg(idsArg), maxItems, base });
  const queue = gated.filter((item) => !item.beyondMax).map((item) => makeQueueItem(item.id, item.title, stamp));

  const root = orchHome();
  const dir = projectDir(root, project);

  const file = runFilePath(dir);
  let existing = null;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // A run.json that exists but doesn't parse is left alone rather than
      // silently clobbered: this tool is the file's only writer, so a
      // corrupt file here was hand-edited or damaged by something outside
      // this tool's control, and overwriting it would destroy whatever
      // diagnostic value it still has for a human sorting out what
      // happened. Reported as a usage-shaped error (code 1: this init call
      // cannot proceed as given) rather than code 4 (lock held) — this is
      // not a running lock refusing a legitimate overwrite, it is a file
      // this tool cannot make sense of at all.
      throw new OrchestrateError(`${file} exists but does not parse as JSON — resolve or remove it by hand before running init again: ${e.message}`, 1);
    }
  }

  // --- the lock: a `status: "running"` run.json is never overwritten by a
  // plain `init`, whether its heartbeat is fresh or stale --------------
  //
  // A FRESH running run is the easy case: another orchestrator invocation
  // (or this same one, re-run by mistake) is actively working this
  // project's queue right now, and a second `init` stomping its run.json
  // out from under it would corrupt live state — lost queue progress, a
  // session id nobody could find again, an item silently re-dispatched
  // into a worktree another process already owns. That case is refused
  // outright, and it must be: there is no way to proceed safely.
  //
  // A STALE running run — `status: "running"` but `updatedAt` older than
  // RUN_STALE_MS — looks, at a glance, like nothing is actually holding it:
  // no live heartbeat suggests no live process. It would be tempting to
  // let plain `init` treat a stale lock as "as good as free" and quietly
  // start over on top of it. That temptation is exactly what this comment
  // exists to head off: a stale `status: "running"` run is not an idle
  // lock, it is the last known state of a run that CRASHED mid-item — a
  // worktree may still exist on disk, a branch may still be checked out, an
  // item's file may still carry a `started:`/`phase:` marker nobody
  // stopped, and the run's own history (which items already merged, which
  // one was mid-review when the process died) exists ONLY in this file.
  // Silently discarding it on the next `init` would bury that crash without
  // a trace: the next run starts from an empty queue as if nothing had ever
  // happened, the orphaned worktree and branch leak forever, and the
  // abandoned marker keeps billing wall-clock time into `execute-elapsed:`
  // until a human notices by hand.
  //
  // So both cases refuse identically at this call site — same exit code,
  // same "nothing is written" guarantee — and only the message differs, to
  // tell whoever is looking at this error which situation they are
  // actually in. Recovering a stale run is deliberately NOT plain `init`'s
  // job: `--resume` (Task 5) reconciles the crashed state against reality
  // (does the worktree still exist, does the branch, is there a dead
  // marker that needs a `backlog.mjs stop` before re-dispatch) and
  // continues the SAME run; `--abort` tears it down cleanly and marks it
  // `aborted`. Naming both by name in the refusal message means the person
  // staring at this error is never left to guess what to do next.
  if (existing && existing.status === 'running') {
    const reason = isFresh(existing.updatedAt)
      ? `a run is already in progress for this project (last heartbeat ${existing.updatedAt})`
      : `this project's run.json is still marked "running" but its last heartbeat (${existing.updatedAt}) is stale — this looks like a crashed run, not an active lock`;
    throw new OrchestrateError(`${reason}. Use \`orchestrate.mjs status\` to inspect it, then --resume or --abort (never plain init) to take it over.`, 4);
  }

  // A non-running existing run (done/aborted/failed) is archived rather
  // than discarded: `runs/<stem>.json` is the only place a finished run's
  // full history survives once run.json itself is about to be replaced, and
  // `runs/<stem>/` beside it is the only place that run's SIDECARS survive
  // once the next run starts writing to the same flat paths. `pastRuns`
  // (the server payload, Task 8) is a listing of this folder filtered to
  // `.json` — the directory entries are one run's evidence, not runs of
  // their own. By the time execution reaches here, `queue` above has
  // already been built and validated successfully — so none of this can run
  // only to be followed by a throw that leaves the project without any
  // run.json at all.
  if (existing) {
    const archiveDir = runsArchiveDir(dir);
    fs.mkdirSync(archiveDir, { recursive: true });
    const stem = archiveStem(archiveDir, existing.runId);
    // Sidecars FIRST, run.json LAST, and the order is the design. A crash
    // between the two leaves the sidecars under `runs/<stem>/` with
    // run.json still flat and still `done` — so the next init resolves the
    // SAME stem (archiveStem checks the .json, which is still free), merges
    // whatever sidecars remain into the directory already there, and
    // completes the rename. Self-repairing. The other order is not:
    // renaming run.json first and crashing leaves `existing === null` next
    // time, so this whole block never runs again and the sidecars are
    // overwritten by the very run that was supposed to preserve them.
    archiveSidecars(dir, path.join(archiveDir, stem));
    fs.renameSync(file, path.join(archiveDir, `${stem}.json`));
  }

  const runId = makeRunId(stamp);
  // Read once for the one field it fills — two reads of one env var for one
  // value is two chances for them to disagree, however small.
  const initDriver = sessionIdentity();
  const newRun = {
    runId,
    project,
    status: 'running',
    startedAt: stamp,
    updatedAt: stamp,
    maxItems,
    // The branch this run gates at, cuts each item worktree from, and merges
    // each finished item into — proved by `assertUsableBase` above to be an
    // existing local branch before this object was built, so every later
    // command can read it without re-checking. Recorded once and never
    // rewritten: unlike `mergeMode` directly below, nothing degrades a base
    // mid-run, because a base that cannot be merged into parks the item and a
    // parked item is already a recorded state with its own detail. See
    // shared/types.ts's OrchestratorRun.base for the fuller rationale this
    // file may not import but still has to uphold byte for byte, and
    // BASE_REF_DEFAULT's own comment for why this is recorded at all when the
    // gate-only version of the flag deliberately was not.
    base,
    // What this run was ASKED to do (never rewritten after this line — see
    // the `merge-mode` command below, which only ever moves the EFFECTIVE
    // field) and what it is actually doing right now. The two start equal,
    // by construction, at every init: a run that opens in 'branch' mode
    // chose that from the start, no different from one that will only
    // reach 'branch' later via a denied merge — the note is what tells
    // those two apart in the archive, and it starts null because nothing
    // has diverged yet. See shared/types.ts's OrchestratorRun fields of the
    // same names for the fuller rationale this file may not import but
    // still has to uphold byte for byte.
    mergeMode,
    mergeModeEffective: mergeMode,
    mergeModeNote: null,
    // Written once, here, and never moved by anything — deliberately ONE
    // field where mergeMode above needs three. Nothing degrades or promotes
    // a question mode mid-run the way a denied merge degrades merge->branch,
    // so a `questionModeEffective` beside this would record a divergence
    // that cannot occur and leave every later reader working out which of
    // the two to trust. See shared/types.ts's OrchestratorRun.questionMode
    // for the fuller rationale this file may not import but must uphold byte
    // for byte.
    questionMode,
    queue,
    attention: [],
    // bug-19: the initiating session is a driver like any other, stamped from
    // the same `stamp` the run's own clock readings all come from. `null` when
    // this process has no identity to record (a hand-run terminal), which
    // reads as "unclaimed" everywhere the lease is checked — see
    // `runDriver`/`assertDriver` above.
    driver: initDriver === null ? null : { sessionId: initDriver, at: stamp }
  };

  writeRunAtomic(dir, newRun);
  // bug-19: said out loud rather than left to be inferred from a `null` in the
  // file. A run started without an identity can never enforce its own driver
  // lease, and the one place that is worth knowing is here — at the start,
  // where whoever launched it is still watching — not three hours later when a
  // second `--resume` session walks in and nothing refuses it.
  if (newRun.driver === null) {
    console.error('warning: CLAUDE_CODE_SESSION_ID is not set — this run records no driver, so its lease cannot be enforced');
  }
  console.log(JSON.stringify({ runId, dir }));
  return 0;
}

const PLAN_USAGE = 'usage: orchestrate.mjs plan --project <abs path> [--ids a,b,c] [--max N] [--base <ref>] [--json]';

// Previews a run without starting one: the exact queue `init` would build
// for these flags, printed rather than written. This is what lets a human
// (or the board's own launch UI, later) see which items are ready, which
// are ungroomed, and which are flagged with open questions BEFORE
// committing to a run — and what lets `init` itself stay a thin wrapper
// around buildGatedQueue instead of duplicating its own copy of the gate.
function cmdPlan(argv) {
  let project;
  let idsArg;
  let maxArg;
  let base = BASE_REF_DEFAULT;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') project = argv[++i];
    else if (argv[i] === '--ids') idsArg = argv[++i];
    else if (argv[i] === '--max') maxArg = argv[++i];
    else if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--json') json = true;
  }

  // Same absolute-path requirement as init, for the same reason: whatever
  // this prints must describe the identical project a matching `init` call
  // would act on, and a relative path here could silently mean a different
  // directory than the one a human typing the same string into `init`
  // right after would get.
  if (!project || !path.isAbsolute(project)) {
    throw new OrchestrateError(PLAN_USAGE, 1);
  }

  let maxItems = null;
  if (maxArg !== undefined) {
    const n = Number(maxArg);
    if (!Number.isInteger(n) || n < 0) {
      throw new OrchestrateError(`--max must be a non-negative integer: ${maxArg}`, 1);
    }
    maxItems = n;
  }

  // Side-effect free by construction, not just by convention: everything
  // above is argument validation and everything below is buildGatedQueue's
  // own read-only walk of <project>/backlog — this function never calls
  // orchHome(), never resolves a run directory, and never opens a file for
  // writing. That is what lets a caller (a UI's queue preview, or a human
  // sanity-checking a run before committing to it) call this as many times
  // as it wants without ever risking a run's own state.
  const queue = buildGatedQueue(project, { ids: parseIdsArg(idsArg), maxItems, base });

  if (json) {
    console.log(JSON.stringify(queue));
  } else {
    for (const item of queue) {
      // Two independent suffixes that concatenate rather than exclude each
      // other: `--max 0` puts even a hoisted item beyond the cap, and a row
      // that was moved to the front AND will not be dispatched needs to say
      // both. Hoist first, because it explains why this row is where it is.
      const hoist = item.hoisted ? '  (runner fix — hoisted)' : '';
      const flag = item.beyondMax ? '  (beyond --max)' : '';
      console.log(`${item.gate.padEnd(13)} ${item.id}  ${item.title}${hoist}${flag}`);
      for (const reason of item.reasons) console.log(`    - ${reason}`);
      for (const question of item.questions) console.log(`    ? ${question}`);
    }
  }
  return 0;
}

const STAGE_USAGE =
  'usage: orchestrate.mjs stage <itemId> <stage> [--session S] [--worktree W] [--branch B] [--permission-mode M] [--note S] [--fix-loop] [--outcome <file>]';

function cmdStage(argv) {
  const itemId = argv[0];
  const stage = argv[1];
  let session;
  let worktree;
  let branch;
  let note;
  let permissionMode;
  // task-47: the Outcome text that becomes the issue's closing comment.
  // Required by `stage <n> merged` in a tracker project and refused in a files
  // one — a files item's Outcome is already in the item file the branch
  // carries, and there is no timeline to post it to.
  let outcomeFile;
  // The one valueless flag on this command: it consumes no argv slot, so it
  // never does the `argv[++i]` step the five above all take.
  let fixLoop = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--session') session = argv[++i];
    else if (argv[i] === '--worktree') worktree = argv[++i];
    else if (argv[i] === '--branch') branch = argv[++i];
    else if (argv[i] === '--permission-mode') permissionMode = argv[++i];
    else if (argv[i] === '--note') note = argv[++i];
    else if (argv[i] === '--outcome') outcomeFile = argv[++i];
    else if (argv[i] === '--fix-loop') fixLoop = true;
  }

  if (!itemId || !stage) {
    throw new OrchestrateError(STAGE_USAGE, 1);
  }
  // Validated before the run is even read: an unrecognized stage name is a
  // problem with the command line itself, independent of whether a run
  // exists at all, so it is refused the same way regardless of run state.
  if (!RUN_STAGES.includes(stage)) {
    throw new OrchestrateError(`unknown stage: ${stage} (expected one of ${RUN_STAGES.join(', ')})`, 1);
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  assertDriver(run);

  // Design §3: enforcement lives in the TOOL, not in SKILL.md's prose — a
  // prose reminder has to survive several hundred turns of a headless
  // session re-reading its own body across a whole run, and a tool refusal
  // does not drift the way prose can. A branch-mode run has already
  // decided `main` is never touched this run (see `mergeModeEffective`'s
  // own comment on the run skeleton above), so `stage <id> merged` — the
  // literal shape of "an item just landed on main" — cannot be allowed to
  // write that lie into the run file, no matter what called it or why.
  // Checked here: after the stage name itself is validated (a bad stage
  // string is a problem with THIS call regardless of run state, see the
  // comment above) but before the queue item is touched at all, so a
  // refusal leaves run.json byte-identical, exactly like every other exit-1
  // path in this function. The converse is deliberately NOT enforced:
  // `stage <id> branched` stays legal under `merge` mode too, because that
  // is precisely what a merge denied mid-queue degrades an item to (design
  // §5.2) — see the `merge-mode` command below for the run-level half of
  // that same degrade.
  if (stage === 'merged' && run.mergeModeEffective === 'branch') {
    throw new OrchestrateError(
      `this run's merge mode is 'branch' — an item cannot be staged 'merged' under branch mode. Use \`stage ${itemId} branched\` instead.`,
      1
    );
  }

  const item = findQueueItem(run, itemId);

  // task-17's dispatch gate, in the tool for the same reason the branch-mode
  // `merged` refusal one screen up is: SKILL.md is re-read on every one of a
  // run's several hundred turns and prose drifts across them; an exit code
  // does not.
  //
  // Exactly two stages, and exactly on a TRANSITION into one of them:
  //
  //   - `preflight` and `dispatched` are the two calls that START work on an
  //     item — the first creates the worktree, the second spawns the child.
  //     Every stage past them describes an item already in flight, and
  //     refusing one of those would strand half-finished work in a worktree
  //     nobody is coming back to. "Stop at the next item boundary" is
  //     precisely the boundary these two calls sit on.
  //   - `item.stage !== stage` is what makes it a transition. A RE-STAMP of a
  //     stage the item already occupies (`stage <id> dispatched --session s1`
  //     after the child exists, which is exactly how §4 records a session id)
  //     must never be refused: there would then be a live `claude -p` process
  //     the run file has no id for — strictly worse than letting the item run
  //     to its own end, which is what the run does before it finishes paused.
  //
  // Placed after `findQueueItem` (the gate needs the item's current stage)
  // and before `applyQueueItemFields`, so a refusal leaves run.json
  // byte-identical like every other refusal in this function.
  if ((stage === 'preflight' || stage === 'dispatched') && item.stage !== stage && pauseRequestEffective(readPauseRequest(run.project), run)) {
    throw new OrchestrateError(
      `a pause was requested for this run — ${itemId} is not being staged '${stage}'. Nothing was written. Finish the run with \`finish --status paused\` (SKILL.md §10, "Pausing").`,
      6
    );
  }

  /* --- task-47: the claim, in tracker mode only -------------------------
     Everything from here to `applyQueueItemFields` is skipped outright for a
     files project — `projectSource` is asked once, off the committed marker,
     and O-1 pins that a files run makes no request on any stage. */
  const tracker = projectSource(run.project) === 'github';

  // `--outcome` belongs to exactly one (mode, stage) pair, and both halves of
  // that are refused here — before the queue item is touched, so a refusal
  // leaves run.json byte-identical like every other exit 1 in this function.
  if (outcomeFile !== undefined && !(tracker && stage === 'merged')) {
    throw new OrchestrateError('--outcome is only for `stage <id> merged` in a tracker project — a files item carries its Outcome in the item file', 1);
  }
  if (tracker && stage === 'merged' && outcomeFile === undefined) {
    throw new OrchestrateError(
      'a tracker item is closed by `stage <id> merged --outcome <file>` — the file becomes the issue-s closing comment, and there is no item file carrying it',
      1
    );
  }

  /* **`preflight` is where a tracker run takes the issue**, before the
     worktree exists and before anything is spent on the item. On a TRANSITION
     only, exactly like the pause gate above and for the same reason: a
     re-stamp of a stage the item already occupies must not post a second
     claim comment on an issue this run already holds. */
  if (tracker && stage === 'preflight' && item.stage !== stage) {
    const claimed = trackerClaim(run, item);
    if (!claimed.won) {
      /* Another run holds it. The item is SKIPPED and the loop moves on, exit
         `0` — a refusal here is information about the world, not a failure of
         this call. This is the one place a `stage` command writes a stage
         other than the one it was given, and it says so in the note. */
      applyQueueItemFields(item, { stage: 'skipped', note: claimed.note });
      run.updatedAt = nowISO();
      writeRunAtomic(dir, run);
      console.log(JSON.stringify({ id: itemId, stage: 'skipped', note: claimed.note }));
      return 0;
    }
    item.claim = { commentId: claimed.commentId };
  }

  /* **`merged` closes the issue, and it happens BEFORE the stage is written.**
     The order is the design (Decision 3 of the item's plan): the tool cannot
     see the push, so SKILL.md calls this only after the push succeeded, and
     the close is tied to the stage rather than to the merge. A failure throws
     exit `9` with nothing written — see `trackerClose` for why this one
     refusal is fatal where the heartbeat's and the release's are not. */
  let mergedCounters;
  if (tracker && stage === 'merged') {
    let outcome;
    try {
      outcome = fs.readFileSync(outcomeFile, 'utf8');
    } catch (e) {
      throw new OrchestrateError(`--outcome ${outcomeFile}: could not be read (${e.message})`, 1);
    }
    // Read before the close, so this path's three requests go out as
    // `GET claim`, `state`, `release` — see `trackerRelease` for why.
    mergedCounters = claimCountersFor(run, item);
    trackerClose(run, item, outcome);
  }

  applyQueueItemFields(item, { stage, session, worktree, branch, note, permissionMode, fixLoop });

  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);

  /* The claim's two ends, after the run file is written so that what is
     published is what this machine actually recorded. A terminal stage
     releases — with this run's bill — and every other stage publishes the
     item's state. Both are best-effort; neither can fail this command. */
  if (tracker) {
    if (CLAIM_RELEASE_STAGES.has(stage)) trackerRelease(run, item, stage, mergedCounters);
    else trackerHeartbeat(run, item);
  }
  // The new count is echoed back only when this call actually incremented it,
  // so the caller enforcing the two-loop ceiling reads it straight off the
  // command that spent the loop rather than making a second `status --json`
  // round trip (and rather than counting in its own head, which a crash and
  // a `--resume` would reset). Every other stage call keeps the exact
  // two-key line it has always printed.
  console.log(JSON.stringify(fixLoop ? { id: itemId, stage, fixLoops: item.fixLoops } : { id: itemId, stage }));
  return 0;
}

// Records the one degrade design §5.2 allows: a run that started (or was
// previously left) in `merge` mode gives up on merging for the REST of the
// queue, because the evidence this whole feature is built on (§ "Why this
// exists" at the top of the design doc) is that the classifier's verdict on
// an identical merge command is a per-call coin flip — once one merge has
// been denied, retrying merge mode on a later item just repeats the same
// four-hour failure this command exists to head off. `mergeMode` itself
// (what was asked for at `init`) is never touched here; only
// `mergeModeEffective` (what the run is actually doing) and the note move,
// and they always move together — a note with no mode change, or a mode
// change with no note, would both leave the archive unable to answer "why
// did this run stop merging" months later.
//
// The one-way rule (`merge` -> `branch`, never back) is enforced by
// CONSTRUCTION here, not by trusting the caller to only ever ask for the
// right thing: the sole transition this function will ever perform is
// exactly `mergeModeEffective === 'merge'` and `target === 'branch'`.
// Everything else is refused untouched — including trying to move back to
// `merge` (case 9 of the task-3 brief: the downgrade is one-way) AND
// re-recording a downgrade that has already happened. That second refusal
// is deliberate too: `mergeModeNote`'s own contract (shared/types.ts) is
// "set once, at the moment a merge is denied, and never cleared back to
// null afterwards" — letting a second call silently overwrite an existing
// note would erase the very post-mortem detail this field exists to keep.
function cmdMergeMode(argv) {
  const target = argv[0];
  let note;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--note') note = argv[++i];
  }

  // Validated before the run is even read, same "a problem with THIS call"
  // reasoning `stage`'s own unknown-stage check uses: a target outside
  // MERGE_MODES, or a missing --note, is wrong regardless of what run
  // exists. Split into two throws, each naming the half that failed and
  // echoing the value actually received, in the same register cmdInit's own
  // --merge-mode check uses just above (`` `--merge-mode must be one of ...
  // (got ...)` ``) — a single bare usage string here told the reader THAT
  // the call was wrong but not WHICH of the two required pieces of argv was
  // the problem, unlike every other validation failure in this file.
  if (!MERGE_MODES.includes(target)) {
    throw new OrchestrateError(`merge-mode target must be one of ${MERGE_MODES.join(', ')} (got ${target === undefined ? 'no value' : target})`, 1);
  }
  if (note === undefined) {
    throw new OrchestrateError('merge-mode requires --note <text> (got no value)', 1);
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  assertDriver(run);

  if (!(run.mergeModeEffective === 'merge' && target === 'branch')) {
    throw new OrchestrateError(
      `merge mode cannot move from '${run.mergeModeEffective}' to '${target}' — the only move this command ever allows is merge -> branch, and only once per run`,
      1
    );
  }

  run.mergeModeEffective = target;
  run.mergeModeNote = note;
  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);
  console.log(JSON.stringify({ mergeModeEffective: run.mergeModeEffective, mergeModeNote: run.mergeModeNote }));
  return 0;
}

function cmdHeartbeat() {
  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  assertDriver(run);
  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);
  console.log(run.updatedAt);
  return 0;
}

const ATTENTION_USAGE = 'usage: orchestrate.mjs attention <itemId> --kind <needs-answers|parked|fix-exhausted> --detail <text> [--questions-json <file>]';
const ATTENTION_KINDS = ['needs-answers', 'parked', 'fix-exhausted'];

function cmdAttention(argv) {
  const itemId = argv[0];
  let kind;
  let detail;
  let questionsJsonFile;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--kind') kind = argv[++i];
    else if (argv[i] === '--detail') detail = argv[++i];
    else if (argv[i] === '--questions-json') questionsJsonFile = argv[++i];
  }

  if (!itemId || !kind || detail === undefined) {
    throw new OrchestrateError(ATTENTION_USAGE, 1);
  }
  if (!ATTENTION_KINDS.includes(kind)) {
    throw new OrchestrateError(`unknown kind: ${kind} (expected one of ${ATTENTION_KINDS.join(', ')})`, 1);
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  assertDriver(run);

  const item = run.queue.find((q) => q.id === itemId);
  if (!item) {
    throw new OrchestrateError(`unknown item id: ${itemId}`, 1);
  }

  // --questions-json only ever means something for kind needs-answers — the
  // field it mirrors onto the queue item (RunQueueItem.questions) is
  // documented as "[] for every other stage," so a --parked or
  // --fix-exhausted call carrying the flag anyway is read and validated
  // (a bad file should still fail loudly) but its content is deliberately
  // never applied — see the `kind === 'needs-answers'` guard below.
  let questions;
  if (questionsJsonFile !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(questionsJsonFile, 'utf8'));
    } catch (e) {
      throw new OrchestrateError(`--questions-json ${questionsJsonFile}: ${e.message}`, 1);
    }
    if (!Array.isArray(parsed) || !parsed.every((q) => typeof q === 'string')) {
      throw new OrchestrateError(`--questions-json must be a JSON array of strings: ${questionsJsonFile}`, 1);
    }
    questions = parsed;
  }

  run.attention.push({ id: itemId, kind, detail });
  if (kind === 'needs-answers' && questions !== undefined) {
    item.questions = questions;
  }

  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);
  console.log(JSON.stringify({ id: itemId, kind }));
  return 0;
}

const ASSUME_USAGE = 'usage: orchestrate.mjs assume <itemId> --json <file of [{question, answer}, …]>';

// The one writer of RunQueueItem.assumptions — what this run decided on its
// own for an item whose pre-flight questions nobody was there to answer.
//
// Placed beside cmdAttention because the two are the two halves of the same
// fork: `attention --kind needs-answers` records that a question could not
// be answered and the item was skipped; this records that it was answered
// by the runner and the item went ahead. They are NOT alternatives the tool
// picks between — SKILL.md §3 does that — and deliberately neither one
// disables the other under `decide` (see the refusal below for the single
// direction that IS enforced).
//
// `--json <file>` rather than inline argv, matching --questions-json's own
// convention for the same reason: the content is prose the run composed,
// and prose does not survive shell quoting intact.
function cmdAssume(argv) {
  const itemId = argv[0];
  let jsonFile;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--json') jsonFile = argv[++i];
  }

  if (!itemId || jsonFile === undefined) {
    throw new OrchestrateError(ASSUME_USAGE, 1);
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  assertDriver(run);

  // Checked BEFORE the file is opened, let alone parsed, so a refused call
  // reports exactly one thing: that this run parks its unanswerable items.
  // A refusal that also complained about a malformed file would invite the
  // caller to fix the file and retry, which is the one reaction that must
  // never work here.
  //
  // This is the enforcement point design §5 calls for, and it is the same
  // division of labour `stage <id> merged` under branch mode already keeps:
  // SKILL.md is re-read on every one of a run's several hundred turns and
  // prose drifts across them, where a tool refusal does not. A run told to
  // park an item and found writing assumptions about it is a run whose
  // prose has drifted — precisely the failure worth making impossible
  // rather than merely discouraged.
  //
  // Absent reads as 'park' for the same reason cmdInit defaults it there:
  // a run file written before this field existed had park's behaviour.
  if ((run.questionMode ?? 'park') !== 'decide') {
    throw new OrchestrateError(
      `assume is refused: this run's questionMode is '${run.questionMode ?? 'park'}', so an item whose questions ` +
        `nobody answered is parked, not decided — record it with ` +
        `\`attention ${itemId} --kind needs-answers --questions-json <file>\` and stage it 'needs-answers' instead`,
      1
    );
  }

  // Through the shared lookup rather than a second `run.queue.find`, which
  // is what that helper exists for: a new writer must not become a second
  // code path that can drift from the one `stage` and `watch` already use.
  const item = findQueueItem(run, itemId);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (e) {
    throw new OrchestrateError(`--json ${jsonFile}: ${e.message}`, 1);
  }
  if (!Array.isArray(parsed)) {
    throw new OrchestrateError(`--json must be a JSON array of {question, answer} objects: ${jsonFile}`, 1);
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OrchestrateError(`--json entries must be {question, answer} objects: ${jsonFile}`, 1);
    }
    // Named individually rather than as one "malformed entry" message: the
    // pair is the whole point of the field (shared/types.ts spells out why
    // half of it is useless), so a caller that wrote only one of the two
    // keys needs to be told WHICH one it left out.
    if (typeof entry.question !== 'string') {
      throw new OrchestrateError(`--json entry is missing a string 'question' key: ${jsonFile}`, 1);
    }
    if (typeof entry.answer !== 'string') {
      throw new OrchestrateError(`--json entry is missing a string 'answer' key: ${jsonFile}`, 1);
    }
  }

  // Appends. A second question decided later in the same item's pre-flight
  // must not erase the first — the archive's question is "what did this run
  // assume about this item", and a replace answers it with whatever
  // happened to be decided last.
  //
  // `?? []` covers a queue item written before this field existed, which a
  // `--resume` against an older run file can genuinely produce.
  item.assumptions = [...(item.assumptions ?? []), ...parsed];

  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);
  // task-47, as in `stage` and `usage`: the item's fields changed, so the
  // published copy follows. Best-effort; a files project never reaches it.
  if (projectSource(run.project) === 'github') trackerHeartbeat(run, item);
  console.log(JSON.stringify({ id: itemId, assumptions: item.assumptions.length }));
  return 0;
}

// `paused` (task-17) is a finish like any other as far as this command is
// concerned — the run stops writing, the file stops being `running`, and
// `init` will archive it. What makes it different is only that it has an
// exit: `unpause` below, which no other finished status has.
const FINISH_USAGE = 'usage: orchestrate.mjs finish --status <done|aborted|failed|paused>';
const FINISH_STATUSES = ['done', 'aborted', 'failed', 'paused'];

function cmdFinish(argv) {
  let status;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status') status = argv[++i];
  }
  if (!FINISH_STATUSES.includes(status)) {
    throw new OrchestrateError(FINISH_USAGE, 1);
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  assertDriver(run);

  run.status = status;
  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);
  console.log(JSON.stringify({ status }));
  return 0;
}

// The one exit a `paused` run has, and a `--resume` session's FIRST write
// (task-17). Separate from `heartbeat` on purpose: heartbeat is a pure
// `updatedAt` re-stamp that a run makes hundreds of times and that must
// never change a status — folding "and also un-pause if paused" into it
// would mean every routine heartbeat carried the power to resurrect a run,
// including one a person paused deliberately thirty seconds ago.
//
// The single clock reading is load-bearing: `unpausedAt` and `updatedAt` are
// the SAME instant, because the first is what the pause-effectiveness
// predicate compares a request against and the second is what freshness is
// measured from. Two readings would open a window in which a request landing
// between them is judged against the wrong one.
// **It TAKES the lease rather than asserting it** (review round 1) — the one
// writing command besides `claim` and `abort` that does.
//
// A paused run carries the lease of the session that paused it, and that
// session is by definition gone: `finish --status paused` is the last thing it
// did before exiting. Asserting the lease here made a board Resume of a paused
// run exit `7` on its very first write and stop there per SKILL.md, abandoning
// the rest of that run's queue — task-17's whole pause → resume round trip,
// broken.
//
// Taking it, rather than merely skipping the check, is what makes this
// independent of the order `references/recovery.md` prints. `claim` refuses a
// run that is `running`, FRESH and led by another session, and an `unpause`
// that left the old lease in place produces exactly that state — so
// unpause-then-claim would have died one command later than it used to. Now
// either order works: whichever of the two this session runs first, it is the
// driver afterwards.
//
// It costs the guarantee nothing. Two racing resume sessions both reach
// `unpause`; the first succeeds and the second exits `1` ("this run is running,
// not paused"), which is a message, not a divergence — nothing is staged,
// dispatched or merged on the strength of an unpause. The one that got through
// holds the lease until the other's `claim` takes it, and then last-writer-wins
// settles it exactly as it does for two resumers of a crashed run.
function cmdUnpause() {
  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);

  if (run.status !== 'paused') {
    throw new OrchestrateError(`this run is ${run.status}, not paused — nothing to unpause`, 1);
  }

  const at = nowISO();
  const me = sessionIdentity();
  run.status = 'running';
  run.unpausedAt = at;
  run.updatedAt = at;
  // Same single clock reading as the two stamps above, and the same rule
  // `takeOverRun` follows for an unidentified caller: no id, no lease, rather
  // than a made-up one that would lock out the session that comes next.
  run.driver = me === null ? null : { sessionId: me, at };
  writeRunAtomic(dir, run);
  if (me === null) {
    console.error('warning: CLAUDE_CODE_SESSION_ID is not set — this run is now unclaimed, and the lease cannot be enforced');
  }
  console.log(JSON.stringify({ status: 'running', unpausedAt: at, driver: run.driver }));
  return 0;
}

// The human-readable "queue: N/M merged" line's mode-aware replacement.
// Under `merge` mode the headline count is still `merged`, byte-identical
// to what this line has always printed when nothing has branched — that is
// the task-3 brief's case-2 regression guard. Under `branch` mode the
// headline flips to `branched`, because that is THIS run's own definition
// of "finished successfully" (design §4's `branched` is the branch-mode
// success exit, same terminal position `merged` occupies).
//
// The secondary count is never folded away, in either direction: a run
// that degraded mid-queue via `merge-mode` (see that command's own
// comment) carries items that reached `merged` before the degrade AND
// items that reached `branched` after it, and hiding either number would
// make a partially-degraded run's history unreadable — exactly the kind of
// silent loss the design doc's own post-mortem (§ "Why this exists")
// complains about. So whichever count is not the mode's own headline is
// still named, in parentheses, whenever it is nonzero.
function queueSummaryLine(run) {
  const total = run.queue.length;
  const merged = run.queue.filter((q) => q.stage === 'merged').length;
  const branched = run.queue.filter((q) => q.stage === 'branched').length;

  if (run.mergeModeEffective === 'branch') {
    const mergedBefore = merged > 0 ? ` (${merged} merged before the mode changed)` : '';
    return `${branched}/${total} branched${mergedBefore}`;
  }
  const branchedSince = branched > 0 ? ` (${branched} branched)` : '';
  return `${merged}/${total} merged${branchedSince}`;
}

function cmdStatus(argv) {
  const json = argv.includes('--json');

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);

  if (json) {
    console.log(JSON.stringify(run));
  } else {
    console.log(`${run.runId}  ${run.project}  ${run.status}`);
    console.log(`updated: ${run.updatedAt}`);
    // Only when EFFECTIVE, not merely present: a stale control file naming a
    // previous run would otherwise make every `status` call of the next run
    // read as "about to pause", which is the opposite of what it means.
    // `--json` above deliberately says nothing about it — that branch is a
    // verbatim print of the run file, and the request is not part of the run.
    const control = readPauseRequest(run.project);
    if (pauseRequestEffective(control, run)) {
      console.log(`pause requested at ${control.requestedAt}`);
    }
    console.log(`queue: ${queueSummaryLine(run)}`);
    console.log(`attention: ${run.attention.length}`);
  }
  return 0;
}

// --- watch ------------------------------------------------------------
// Blocks synchronously for up to `--budget-ms`, polling once every
// `--interval-ms`: heartbeat, look for the child's session id in its own
// jsonl transcript (once — see findSessionIdInJsonl below), check whether
// the pid is still alive. Exits the moment the pid is gone (0 — the caller
// inspects what actually happened next), or once the budget elapses with
// the child still alive (3 — see OrchestrateError's own comment for why
// reusing "3" here is deliberate: the orchestrator loop's reaction to
// either "no run exists yet" or "still running, try again" is the same
// shape of retry, so this file does not mint a fresh number for a
// distinction no caller needs to act on differently). Budget default
// 540000ms (9 minutes) stays under a 10-minute Bash-tool ceiling with
// slack, which is the entire reason this command loops internally instead
// of blocking for the child's whole lifetime in one call — a caller whose
// own tool call has a wall-clock cap survives an item that runs longer than
// that cap simply by calling `watch` again.

// A synchronous sleep via `Atomics.wait` on a throwaway SharedArrayBuffer —
// Node (unlike a browser main thread) allows blocking the main thread this
// way. Chosen over shelling out to a `sleep` binary (not portable) or an
// async setTimeout loop (would require every cmdXxx function in this file,
// and `main` itself, to become promise-aware for the sake of this one
// command); this keeps cmdWatch a plain synchronous function like every
// other command here, at the cost of genuinely blocking the process for
// `ms` — which is exactly what a dedicated watch-loop child process is FOR.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A zombie (defunct — already exited, but not yet reaped by its parent)
// process reports state `Z` from `ps -o stat=`, sometimes with a modifier
// suffix (`Z+` in the foreground process group is the common shape). Pulled
// out as its own tiny, dependency-free string check — and exported — so it
// can be unit-tested directly against known `ps` output without having to
// deterministically manufacture a real zombie process in a test. A real one
// IS constructible (this file's own test suite hit one by accident early in
// Task 5: a child reaped by a parent whose event loop was itself blocked —
// see that test's own comment), but only by relying on exactly the kind of
// timing window this fallback exists to defend against, which makes it a
// racy, platform-sensitive thing to pin a test to on purpose. Testing the
// classification directly is deterministic and just as convincing that the
// STRING CHECK itself is right; see this file's test suite for where that
// trade-off is made explicitly.
export function isZombieStatState(stat) {
  return stat.trim().startsWith('Z');
}

// `process.kill(pid, 0)` sends no signal at all, just probes whether the
// pid could be signaled — but succeeding only proves the pid is still an
// ENTRY in the process table. It does NOT distinguish a genuinely running
// process from an unreaped ZOMBIE, and `watch` is never the parent of the
// pid it polls (that pid belongs to a `claude -p` child spawned by whatever
// invoked this tool — a shell, or a later task's own supervising process —
// not by this Node process itself), so whether, and when, that pid
// actually gets reaped depends on a process tree this file has no control
// over. A zombie reading as "alive" would hang a watch loop at its own
// budget every single call, forever — the caller just keeps re-invoking
// `watch` on a pid that can never again become "not alive" by this check
// alone, since the OS keeps the table entry until something reaps it.
//
// The fallback: once `kill(pid, 0)` confirms the pid exists, confirm its
// process STATE via `ps -o stat= -p <pid>` and treat a leading `Z` (see
// isZombieStatState above) as actually dead. `ps` itself failing — not
// installed, the pid raced away between the two checks, unexpected output —
// is treated as "still alive," never as "dead": the bias is deliberately
// one-directional. Worst case on a flaky `ps` probe, a truly-dead zombie
// gets reported alive for one more `watch` interval (the run just waits a
// little longer before declaring the item done) — but this function must
// NEVER report a genuinely LIVE child as dead, which would make the
// orchestrator loop move on and merge or park an item whose session is
// still actually running. Losing time is recoverable; a false "gone" is not.
//
// Residual risk this does not close: a pid can be reused by an unrelated
// process by the time this check runs (a classic TOCTOU on any pid-based
// liveness probe, not specific to this function), and a live-but-hung
// process (state `S`/`D`, not `Z`) is indistinguishable from a live-and-
// working one — this function answers "does the OS still consider this pid
// occupied by a real process," not "is the claude session making progress."
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code !== 'ESRCH';
  }
  const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || !probe.stdout) return true;
  return !isZombieStatState(probe.stdout);
}

// Pulls the session id out of the FIRST `{"type":"system","subtype":
// "init",...}` event in a `claude -p --output-format stream-json`
// transcript, tolerating a partial trailing line: the file is being
// appended to live by the very child process this command is watching, so
// the last "line" in it at any given instant may not have its trailing
// newline yet. `text.split('\n')` always puts that in-progress tail (or, if
// the file happens to currently end in a newline, a harmless empty string)
// in the array's last slot, so dropping it via `slice(0, -1)` is correct
// either way — a genuinely complete file's last real line is never the one
// being discarded. A line that fails to parse as JSON is skipped, not
// fatal — the one deliberately lenient spot in this parse, since an
// interleaved non-JSON line some future `claude` version might emit is not
// this tool's problem to solve. An outright failure to READ the file at all
// (see the caller, which is the thing that decides what counts as a wedge)
// is different from a bad line and is never swallowed here.
function findSessionIdInJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const completeLines = text.split('\n').slice(0, -1);
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event && event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
      return event.session_id;
    }
  }
  return null;
}

// Pulls `permission_denials` off the LAST `{"type":"result",...}` event in
// the same kind of transcript findSessionIdInJsonl reads, and shares that
// function's two disciplines for the same two reasons: `slice(0, -1)` drops
// a possibly-partial trailing line (this file is appended to live), and an
// unparseable line is skipped rather than fatal.
//
// Why this reader exists at all: the dispatch runs under
// `--permission-mode auto` rather than `--dangerously-skip-permissions`, so
// a call the classifier refuses is now a thing that can happen. Measured on
// this machine against CLI 2.1.250, a refused call is invisible in every
// signal an orchestrator would naturally check — the tool_result comes back
// `is_error: true`, the session reads it and carries on, and the run's final
// result event still reports `subtype: "success"` and `is_error: false`
// while the process exits `0`. The ONLY machine-readable trace is this
// array. Without it, step 5 would happily merge a diff the session built
// around a command that never ran.
//
// The LAST result event, not the first, because a `--resume` retry appends
// a second one to the same transcript: reading the first would clear a run
// whose retry was the half that got refused.
//
// An absent `permission_denials` key reads as `[]` — that is a transcript
// from a CLI that predates the field, or simply a run with nothing to
// report, and neither is a reason to treat the run as unreadable. A
// transcript with no result event at all is also `[]`: that is the crashed
// session watch already has a shape for, judged by the item file as it
// always has been. Failing to READ the file, by contrast, is never
// swallowed — see cmdDenials, which turns it into an exit 1 rather than
// letting "unreadable" masquerade as "clean".
export function readPermissionDenials(file) {
  const text = fs.readFileSync(file, 'utf8');
  const completeLines = text.split('\n').slice(0, -1);
  let denials = [];
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event && event.type === 'result') {
      denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    }
  }
  return denials;
}

const DENIALS_USAGE = 'usage: orchestrate.mjs denials --jsonl <file>';

// Deliberately run-independent: it takes no item id, reads no run.json, and
// needs no lock. A crashed run whose run file is in whatever state a crash
// left it in must still be able to answer "did the session get refused
// anything?", and the transcript on disk is the whole of the evidence.
function cmdDenials(argv) {
  let jsonlFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jsonl') jsonlFile = argv[++i];
  }
  if (jsonlFile === undefined) {
    throw new OrchestrateError(DENIALS_USAGE, 1);
  }
  let denials;
  try {
    denials = readPermissionDenials(jsonlFile);
  } catch (e) {
    // An unreadable transcript answering "no denials" would be
    // indistinguishable from a clean run, and step 5 merges on clean. Exit
    // 1 instead, so the caller has to look.
    throw new OrchestrateError(`--jsonl ${jsonlFile}: could not be read (${e.message})`, 1);
  }
  console.log(JSON.stringify({ count: denials.length, denials }));
  return 0;
}

// --- task-27: what each dispatched session cost --------------------------
//
// The same transcript readPermissionDenials reads, asked a different
// question, and sharing that function's two disciplines for the same two
// reasons: `slice(0, -1)` drops a possibly-partial trailing line, and an
// unparseable line is skipped rather than fatal. The LAST result event, not
// the first, for readPermissionDenials' own reason — a `--resume` can append
// a second one to the same transcript, and the last is the one that
// describes the segment that just ended.
//
// Returns `null` when the transcript carries no result event at all. That is
// a killed session, and it is NOT the same thing as a session that cost
// nothing — see cmdUsage, which writes no entry for it.
//
// Every number is read through `finiteOrNull`: a field a future CLI renames
// leaves a hole rather than a `0`, because a `0` would claim the session was
// free (shared/types.ts, RunSessionUsage's own doc comment).
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readSessionUsage(file) {
  const text = fs.readFileSync(file, 'utf8');
  const completeLines = text.split('\n').slice(0, -1);
  let result = null;
  // The init event's session id is the fallback for a result event that
  // carries none — read in the same pass rather than by a second call to
  // findSessionIdInJsonl, which would re-read and re-parse the whole file
  // (these transcripts run to tens of megabytes).
  let initSessionId = null;
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string' && initSessionId === null) {
      initSessionId = event.session_id;
    }
    if (event.type === 'result') result = event;
  }
  if (result === null) return null;

  const usage = result.usage && typeof result.usage === 'object' ? result.usage : {};
  // One key -> that model; several -> all of them joined, since a session
  // that spanned two models is honestly described by neither alone. No key
  // at all -> null, the same hole every numeric field leaves.
  const models = result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [];

  return {
    sessionId: typeof result.session_id === 'string' ? result.session_id : initSessionId,
    costUsd: finiteOrNull(result.total_cost_usd),
    turns: finiteOrNull(result.num_turns),
    inputTokens: finiteOrNull(usage.input_tokens),
    outputTokens: finiteOrNull(usage.output_tokens),
    cacheReadTokens: finiteOrNull(usage.cache_read_input_tokens),
    cacheCreationTokens: finiteOrNull(usage.cache_creation_input_tokens),
    durationMs: finiteOrNull(result.duration_ms),
    model: models.length === 0 ? null : models.join(', ')
  };
}

// Which dispatch a transcript belongs to, from its FILE NAME and never from
// its content — SKILL.md names all three shapes (`<id>.jsonl`,
// `<id>-retry-<n>.jsonl`, `<id>-fix-<n>.jsonl`) and the content genuinely
// cannot tell them apart: `claude -p --resume` keeps the session id it was
// handed, so an item's first transcript and its fix loop's report the same
// session (verified against this machine's own task-22 pair, 2026-09-07).
//
// `null` for a name matching none of the three, which cmdUsage turns into an
// exit 1. Deliberately strict rather than defaulting to `execute`: the
// realistic way to get here is passing ANOTHER item's transcript, and a
// silent default would file that item's cost against this one forever.
function transcriptSlot(itemId, file) {
  const base = path.basename(file).replace(/\.jsonl$/, '');
  if (base === itemId) return { kind: 'execute' };
  const retry = new RegExp(`^${escapeForRegExp(itemId)}-retry-(\\d+)$`).exec(base);
  if (retry) return { kind: 'retry', loop: Number(retry[1]) };
  const fix = new RegExp(`^${escapeForRegExp(itemId)}-fix-(\\d+)$`).exec(base);
  if (fix) return { kind: 'fix', loop: Number(fix[1]) };
  return null;
}

// Item ids are `^[a-z]+-\d+$` (backlog.mjs enforces it), so nothing that
// reaches here can carry a metacharacter today. Escaped anyway, because the
// alternative is a regex whose safety depends on a rule enforced in another
// tool's file.
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An entry's identity: the transcript slot, not the session id. See
// transcriptSlot above and RunSessionUsage's own doc comment for why the
// obvious key does not work.
function usageSlotKey(entry) {
  return `${entry.kind}#${entry.loop ?? ''}`;
}

// Named `usage` for the command, which collides awkwardly with this file's
// `<CMD>_USAGE` convention for help strings. Kept anyway: the command name a
// person types matters more than the constant name nobody does.
const USAGE_USAGE = 'usage: orchestrate.mjs usage <itemId> --jsonl <file>';

// The one writer of RunQueueItem.usage. Run at inspect time (SKILL.md §5),
// on the same Bash invocation as `stage <id> inspecting`, so it costs the
// driver no extra turn — which is the whole reason it is a command of its
// own rather than something `stage` grew a flag for: `stage` is called from
// a dozen places that have no transcript to point at.
//
// Subject to the driver lease like every other mutating command (exit 7).
// Unlike `denials`, which is deliberately run-independent because a crashed
// run must still be able to answer "was anything refused", this one WRITES
// the run file — so it is exactly as bound by the lease as `stage` is.
function cmdUsage(argv) {
  const itemId = argv[0];
  let jsonlFile;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--jsonl') jsonlFile = argv[++i];
  }
  if (!itemId || jsonlFile === undefined) {
    throw new OrchestrateError(USAGE_USAGE, 1);
  }

  // Before the run file is opened: a bad file name is a problem with this
  // call, and the caller has to be told which of the three shapes it should
  // have used rather than being told the item is fine and the entry landed.
  const slot = transcriptSlot(itemId, jsonlFile);
  if (slot === null) {
    throw new OrchestrateError(
      `--jsonl ${jsonlFile}: a transcript for ${itemId} must be named ` +
        `${itemId}.jsonl, ${itemId}-retry-<n>.jsonl or ${itemId}-fix-<n>.jsonl — ` +
        `the file name is what says which dispatch this is, and the transcript itself cannot`,
      1
    );
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());
  const run = readRun(dir);
  assertDriver(run);
  const item = findQueueItem(run, itemId);

  let parsed;
  try {
    parsed = readSessionUsage(jsonlFile);
  } catch (e) {
    // An unreadable transcript is exit 1 for cmdDenials' reason restated:
    // "could not read it" must never be recorded as, or mistaken for, "there
    // was nothing to record".
    throw new OrchestrateError(`--jsonl ${jsonlFile}: could not be read (${e.message})`, 1);
  }

  // A killed session: the transcript stops mid-flight and never reaches its
  // result event. Nothing is written and the run file is left byte-identical
  // — an absent entry is the honest record, where a zero-valued one would
  // claim the session was free. Exit 0 rather than 1 because the caller did
  // nothing wrong and has nothing to retry: the inspect step that follows is
  // already about to notice the session died.
  if (parsed === null) {
    console.error(`no result event in ${jsonlFile}: nothing recorded for ${itemId} (the session did not finish)`);
    return 0;
  }

  const entry = { ...parsed, kind: slot.kind, endedAt: nowISO() };
  if (slot.loop !== undefined) entry.loop = slot.loop;

  // `?? []` covers a queue item written before this field existed, which a
  // `--resume` against an older run file genuinely produces. Replace-by-slot
  // rather than append-always, so a resumed driver re-running this over a
  // transcript it already recorded (references/recovery.md) leaves one entry
  // rather than two; every OTHER slot is copied through untouched, which is
  // what keeps a fix loop's entry beside the first session's.
  const existing = item.usage ?? [];
  const key = usageSlotKey(entry);
  const replaced = existing.some((e) => usageSlotKey(e) === key);
  item.usage = replaced ? existing.map((e) => (usageSlotKey(e) === key ? entry : e)) : [...existing, entry];

  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);
  // task-47: a command that changed the item's fields publishes them. After
  // the write, best-effort, and a no-op for a files project.
  if (projectSource(run.project) === 'github') trackerHeartbeat(run, item);
  console.log(JSON.stringify({ id: itemId, usage: entry }));
  return 0;
}

const WATCH_USAGE = 'usage: orchestrate.mjs watch <itemId> --pid <p> --jsonl <file> [--interval-ms 30000] [--budget-ms 540000]';

function cmdWatch(argv) {
  const itemId = argv[0];
  let pidArg;
  let jsonlFile;
  let intervalMs = 30_000;
  let budgetMs = 540_000;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--pid') pidArg = argv[++i];
    else if (argv[i] === '--jsonl') jsonlFile = argv[++i];
    else if (argv[i] === '--interval-ms') intervalMs = Number(argv[++i]);
    else if (argv[i] === '--budget-ms') budgetMs = Number(argv[++i]);
  }

  if (!itemId || pidArg === undefined || jsonlFile === undefined) {
    throw new OrchestrateError(WATCH_USAGE, 1);
  }
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new OrchestrateError(`--pid must be a positive integer: ${pidArg}`, 1);
  }
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new OrchestrateError(`--interval-ms must be a positive integer: ${intervalMs}`, 1);
  }
  if (!Number.isInteger(budgetMs) || budgetMs <= 0) {
    throw new OrchestrateError(`--budget-ms must be a positive integer: ${budgetMs}`, 1);
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());

  // Fail fast, before any sleeping happens: an unknown item (or no run at
  // all — readRun's own code-3 "no run exists") is a problem with THIS
  // call, independent of how long the loop below would otherwise run.
  findQueueItem(readRun(dir), itemId);

  let sessionId = null;
  let elapsed = 0;
  let checks = 0;
  for (;;) {
    const jsonlExists = fs.existsSync(jsonlFile);
    let newlyFoundSessionId = null;
    if (jsonlExists) {
      if (sessionId === null) {
        try {
          newlyFoundSessionId = findSessionIdInJsonl(jsonlFile);
        } catch (e) {
          // Anything but ENOENT here (existsSync above already ruled that
          // out) — e.g. `--jsonl` naming a directory — is the "parse
          // wedge" the exit-code contract names: fatal on whichever check
          // hits it, unlike a merely MISSING file below, which gets one
          // interval of grace.
          throw new OrchestrateError(`--jsonl ${jsonlFile}: could not be read (${e.message}) — this is a parse wedge, not a transient miss`, 1);
        }
        if (newlyFoundSessionId !== null) sessionId = newlyFoundSessionId;
      }
    } else if (checks > 0) {
      throw new OrchestrateError(`--jsonl file not found after the first interval: ${jsonlFile}`, 1);
    }
    checks++;

    // One read-modify-write per tick: the heartbeat's updatedAt bump and a
    // freshly-discovered session id (if any) land in the SAME write, via
    // applyQueueItemFields — the exact function `stage --session` itself
    // uses (see that function's own header comment for why that reuse
    // matters, not just that it is convenient).
    const run = readRun(dir);
    assertDriver(run);
    if (newlyFoundSessionId !== null) {
      applyQueueItemFields(findQueueItem(run, itemId), { session: newlyFoundSessionId });
    }
    run.updatedAt = nowISO();
    writeRunAtomic(dir, run);

    /* task-47: the tick that keeps the RUN alive keeps the CLAIM alive too.
       This is the one heartbeat that matters most — a dispatched session can
       run for an hour with nothing else calling a command, and a claim with no
       heartbeat is retired by the next contestant after fifteen minutes. Every
       other caller in this file publishes state because the item changed; this
       one publishes it because time passed.

       Still best-effort, and still after the local write. A tick that cannot
       reach the API prints one line and keeps watching the child, which is
       what it is actually for. */
    if (projectSource(run.project) === 'github') trackerHeartbeat(run, findQueueItem(run, itemId));

    if (!pidAlive(pid)) return 0;

    elapsed += intervalMs;
    if (elapsed >= budgetMs) return 3;

    sleepSync(intervalMs);
  }
}

// --- verify -------------------------------------------------------------
// Resolves the project's own proof commands (backlog/verify.json, else
// package.json's test/typecheck/build scripts) plus the item's own fenced
// `## Done when` commands (Task 4's own extractDoneWhenCommands, reused
// verbatim rather than re-parsed — see that function's own comment for the
// convention it recognizes), runs every one of them in `--cwd` regardless
// of an earlier failure (a red command must never hide a second one), and
// records `{cmd, ok, tail}` rows onto the queue item's `verification`
// array. `--cwd` names the WORKTREE to run in and to read
// `backlog/verify.json` / `package.json` / the item file from; it is a
// completely separate directory from the one resolveProjectRoot() walks up
// from (this process's own cwd, always the project root) — see
// resolveProjectRoot's own long comment for exactly why that split exists,
// and why `verify` takes `--cwd` explicitly instead of being run from
// inside the worktree the way a naive port of `stage`'s style might do.

function isPnpmManaged(cwd, pkg) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return true;
  return typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('pnpm');
}

// The "obvious" package.json scripts, in the fixed order the brief names:
// test, typecheck, build. Only scripts that actually exist are included —
// a project with just a `test` script gets exactly one command, never two
// more that are guaranteed to fail as "missing script."
function packageJsonVerifyCommands(cwd) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const runner = isPnpmManaged(cwd, pkg) ? 'pnpm run' : 'npm run';
  return ['test', 'typecheck', 'build'].filter((name) => scripts[name] !== undefined).map((name) => `${runner} ${name}`);
}

// The item's own `## Done when` fenced commands, read from `cwd`'s copy of
// the item file (open/ or done/ — see findItemFilePath's own comment for
// why both are searched). A missing item file, or a body with no `## Done
// when` section at all, both resolve to "nothing extra" rather than an
// error — mirroring findUnresolvedCommands' own tolerant style in the gate
// section above.
// `snapshotPath` (task-47) is where a TRACKER item's text is: there is no item
// file in the worktree to find, so the `## Done when` block is read from the
// snapshot `snapshot <n>` wrote under the run-state directory. `null` — every
// files call — keeps the search exactly as it was.
//
// A missing snapshot resolves to "nothing extra" rather than an error, the
// same tolerance a missing item file already gets: the caller's own exit `5`
// ("nothing resolvable to verify with") is the right answer for an item that
// has no proof commands anywhere, and it says so far better than a throw here
// would.
function itemDoneWhenCommands(cwd, itemId, snapshotPath = null) {
  let body;
  if (snapshotPath !== null) {
    if (!fs.existsSync(snapshotPath)) return [];
    // The WHOLE file is the body. A snapshot has no frontmatter fence — an
    // issue has no frontmatter to snapshot — so running it through
    // `parseItemForGate` would answer `body: ''` for every well-formed one.
    body = fs.readFileSync(snapshotPath, 'utf8');
  } else {
    const found = findItemFilePath(cwd, itemId);
    if (!found) return [];
    ({ body } = readItemForGate(found.path));
  }
  const doneWhen = extractSection(body, 'Done when');
  if (doneWhen === undefined) return [];
  return extractDoneWhenCommands(doneWhen);
}

// Base commands (verify.json's own `commands` array when it resolves to
// one, else the package.json fallback) unioned with the item's own
// Done-when commands, de-duplicated while preserving first-occurrence
// order — a Done-when block routinely repeats the project's own baseline
// command (`pnpm test` is the obvious one), and running the identical
// command twice would only double the wall-clock cost of every verify call
// for zero extra proof.
function resolveVerifyCommands(cwd, itemId, snapshotPath = null) {
  let base;
  const verifyJsonPath = path.join(cwd, 'backlog', 'verify.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(verifyJsonPath, 'utf8'));
    if (Array.isArray(parsed.commands)) {
      // Every entry must be a string BEFORE it ever reaches runVerifyCommand
      // below — that function hands `cmd` straight to `spawnSync(cmd, ...)`,
      // which throws a raw, uncaught TypeError ("The argument must be of
      // type string") for anything else. That would blow straight through
      // main()'s own try/catch (it only converts OrchestrateError instances
      // to a clean exit code — see main's own comment) and dump a Node
      // stack trace at whoever ran this command, for what is really just a
      // malformed project file. Same "validate before mutate" ordering as
      // everywhere else in this file: this check runs before verify has
      // touched run.json at all, so a bad verify.json still writes nothing.
      const badEntry = parsed.commands.find((c) => typeof c !== 'string');
      if (badEntry !== undefined) {
        throw new OrchestrateError(`${verifyJsonPath}: "commands" must be an array of strings, found ${JSON.stringify(badEntry)}`, 1);
      }
      base = parsed.commands;
    } else {
      base = packageJsonVerifyCommands(cwd);
    }
  } catch (e) {
    // Our OWN deliberate throw above must escape this catch untouched — it
    // is not "verify.json doesn't parse," it is "verify.json parses fine
    // and is wrong," and those two need different outcomes (a clean error
    // vs. a silent fallback to package.json).
    if (e instanceof OrchestrateError) throw e;
    // no backlog/verify.json here, or it doesn't parse at all — package.json
    // scripts is the only other place a baseline command can come from.
    base = packageJsonVerifyCommands(cwd);
  }

  const seen = new Set();
  const all = [];
  for (const cmd of [...base, ...itemDoneWhenCommands(cwd, itemId, snapshotPath)]) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    all.push(cmd);
  }
  return all;
}

// 64 MiB, against Node's own 1 MiB default — see runVerifyCommand for the
// measured failure that number exists to prevent. Generous rather than
// unbounded on purpose: a bound this far past any real test suite's console
// output still stops a runaway command from taking this process's memory
// down with it, which `maxBuffer: Infinity` would not.
const VERIFY_MAX_BUFFER = 64 * 1024 * 1024;

// "Last 20 lines" stops bounding anything when a command emits no newlines —
// a progress bar rewriting itself with \r, or a single enormous JSON blob, is
// ONE line, and with the buffer above raised to 64 MiB that one line could
// now be 64 MiB long in a file the board loads on every poll. So the row is
// clamped by characters as well as by lines, from the END (a failure's last
// words are the diagnostic ones). 8 KiB is roughly 20 lines of very long
// output — wide enough that no realistic 20-line tail is touched by this,
// narrow enough that run.json stays a state file rather than a log.
const VERIFY_TAIL_MAX_CHARS = 8 * 1024;

// Runs one command through a shell (so a plain string like `pnpm run test`
// or a `## Done when` line works exactly as typed, with no argv-splitting
// of this tool's own to get wrong), captures combined stdout+stderr, and
// keeps only the last 20 lines and at most VERIFY_TAIL_MAX_CHARS of them —
// shared/types.ts's own RunVerification doc comment: "enough to diagnose,
// not the whole log."
//
// `maxBuffer` is passed explicitly because Node's default is 1 MiB and what
// it does at that limit is not an error but a lie. Measured on this machine,
// on a command that exits 0 and prints ~1.6 MiB:
//
//   default : {"status":null,"signal":"SIGTERM","err":"ENOBUFS","len":1049598}
//   64 MiB  : {"status":0,"signal":null,"len":1620000}
//
// The child is KILLED, so `result.status === 0` evaluates `null === 0` and a
// green suite is recorded red — with a tail of perfectly ordinary passing
// output. Unattended that is worse than a crash: backlog-orchestrate's §8
// feeds the "failure" into a fix loop, asks the executor session to fix tests
// that were never broken, spends the second loop the same way, and parks the
// item on a healthy tree. And it would do that to EVERY item in the queue,
// because the cause is the project's output volume, not the item's code.
//
// `result.error` is then its own outcome, never folded into "the command
// failed". ENOENT/EACCES (the shell itself could not be spawned), E2BIG (a
// command string past the OS argument limit) and a still-conceivable ENOBUFS
// all mean *we could not run this command*, which is a different thing to
// hand a fix loop than *the command ran and reported failure*. Both stay
// `ok: false` — neither is proof the item works, and the merge gate must be
// shut for either — but the recorded row now says which one happened, so
// nobody is sent to debug a suite that never executed.
function runVerifyCommand(cmd, cwd) {
  const result = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', maxBuffer: VERIFY_MAX_BUFFER });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const lines = combined.split('\n');
  const trimmedLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const tail = trimmedLines.slice(-20).join('\n').slice(-VERIFY_TAIL_MAX_CHARS);
  if (result.error) {
    const why = `could not run this command (${result.error.code ?? 'spawn failed'}): ${result.error.message}`;
    return { cmd, ok: false, tail: tail === '' ? why : `${why}\n${tail}` };
  }
  return { cmd, ok: result.status === 0, tail };
}

const VERIFY_USAGE = 'usage: orchestrate.mjs verify <itemId> --cwd <dir> [--json]';

function cmdVerify(argv) {
  const itemId = argv[0];
  let cwd;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--json') json = true;
  }
  if (!itemId || cwd === undefined) {
    throw new OrchestrateError(VERIFY_USAGE, 1);
  }

  const dir = projectDir(orchHome(), resolveProjectRoot());
  // Validated here and the object then DISCARDED: no run at all (readRun's
  // code 3) and an unknown item id (findQueueItem's code 1) must both fail
  // before a single command is spawned, exactly like every other command in
  // this file — but nothing is held across the suite. See the re-read below
  // for why that distinction is not pedantry.
  const checked = readRun(dir);
  findQueueItem(checked, itemId);

  // task-47: in a tracker project the item's `## Done when` block is in the
  // snapshot `snapshot <n>` wrote, not in any file under the worktree's
  // `backlog/` — there is none. Everything else about verify is unchanged:
  // the commands still run in `--cwd`, the rows still land on the queue item.
  const snapshotPath = projectSource(checked.project) === 'github' ? snapshotFilePath(dir, itemId) : null;
  const commands = resolveVerifyCommands(cwd, itemId, snapshotPath);
  if (commands.length === 0) {
    // Exit 5: nothing this tool could find to prove the item works — no
    // backlog/verify.json, no package.json test/typecheck/build script, and
    // no fenced command under the item's own `## Done when`. Nothing is
    // written: an item that cannot prove itself has nothing to record, and
    // the caller (the orchestrator loop) parks it rather than merging code
    // nobody has verified — see the design spec's own "Verify" step.
    if (json) console.log(JSON.stringify([]));
    else console.log('nothing to verify: no backlog/verify.json, no package.json test/typecheck/build script, and no fenced command under ## Done when');
    return 5;
  }

  // Every command runs regardless of an earlier one failing — a red first
  // command must never hide a second, independent failure. The overall
  // exit is 1 the moment any row is red, computed after every row has run.
  const rows = commands.map((cmd) => runVerifyCommand(cmd, cwd));

  // Re-read HERE, after the commands, instead of reusing the object from the
  // validation above. `verify` is the one command in this tool whose middle
  // can last many minutes, and backlog-orchestrate's §8 now runs it detached
  // with `watch` heartbeating the SAME run file every 30s alongside it —
  // holding a run object across the whole suite would make this write quietly
  // revert every heartbeat that landed while the tests ran. Re-reading
  // collapses the read-modify-write to the microseconds either side of this
  // line, which is the window every other writer in this file already has.
  // Still one atomic write of all the rows at once, never a row at a time:
  // an interrupted verify must leave the run file exactly as it found it, so
  // the merge gate can never read a half-written verification.
  const run = readRun(dir);
  assertDriver(run);
  const item = findQueueItem(run, itemId);
  item.verification = item.verification.concat(rows);
  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);
  // task-47, as in `stage`, `usage` and `assume`. The verification rows are
  // the one part of a queue item another machine most wants to see — they are
  // the evidence behind a merge — so publishing them is the point rather than
  // completeness for its own sake.
  if (projectSource(run.project) === 'github') trackerHeartbeat(run, item);

  if (json) {
    console.log(JSON.stringify(rows));
  } else {
    for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.cmd}`);
  }
  return rows.every((row) => row.ok) ? 0 : 1;
}

// --- reconcile ----------------------------------------------------------
// Read-only crash-recovery report: for every queue item still IN the
// pipeline (not one of the terminal stages below), compares the run file's
// own record against what is actually on disk/in git right now, and prints
// one of a fixed set of suggested next actions. Never writes run.json — a
// human, or the backlog-orchestrate skill's own `--resume` flow (Task 7),
// decides what to actually DO with each suggestion; this command's only job
// is to tell them accurately what it found.

// RunStage's own doc comment (shared/types.ts — restated here since this
// file cannot import it): "`merged` and `branched` are the two success
// exits — one per MergeMode, and a queue item reaches exactly one of them,
// never both — and `failed`, `skipped`, `needs-answers`, `ungroomed`, and
// `parked` are the five ways an item leaves the pipeline without merging."
// An item already in one of these seven has already left the pipeline by
// definition — reconciling it against a possibly-gone worktree would tell
// a human nothing they don't already know from its stage alone.
//
// `branched` belongs here for the exact reason `merged` always has: a
// branch-mode run that finished the item successfully has let go of it
// just as completely as a merge-mode run that reached `main` has (the same
// argument shared/types.ts's `RUN_HELD_STAGES`/`runHoldsItem` make on the
// server/client side of this same feature). Leaving it out would be a real
// bug, not a cosmetic one: `--resume`'s whole job is telling a crashed run
// apart from one that finished cleanly, and without `branched` here it
// would read an already-delivered branch as unfinished work and dispatch
// straight back into it — redoing an item whose result is already sitting
// on disk as the deliverable.
const RECONCILE_TERMINAL_STAGES = new Set(['merged', 'branched', 'failed', 'skipped', 'needs-answers', 'ungroomed', 'parked']);

// The fixed suggestion vocabulary the brief names, in priority order:
//   1. Neither the worktree directory nor the branch survive at all —
//      nothing to resume, redispatch onto, or even inspect. `park`: a
//      human decides whether this item re-enters the queue from scratch.
//   2. The branch survives but the worktree directory does not — no live
//      file to read a marker from, and no checkout to resume a session
//      inside even with a known session id. `inspect`: a human decides
//      whether to re-create the worktree from the branch tip or abandon it.
//   3. The worktree is here and its own copy of the item file is mid-
//      activity (see itemHasPhaseMarker's own comment for why `phase:`
//      specifically, not `started:` alone, is what "in progress" means). A
//      known session id means the SAME claude session can be resumed in
//      place (`resume-session`); no session id means dispatch crashed
//      before ever getting far enough to have one recorded, so the skill's
//      job is `backlog.mjs stop` (bill the dead interval) followed by a
//      FRESH dispatch on the same worktree/branch (`redispatch-after-stop`).
//   4. Worktree present, no in-progress marker: either it never started
//      real work, or it finished and stopped cleanly but the orchestrator
//      itself died before committing/reviewing/merging. Reconcile cannot
//      tell those two apart from the outside, so a human looks (`inspect`).
function suggestReconcileAction({ worktreeExists, itemBranchExists, marker, sessionId }) {
  if (!worktreeExists && !itemBranchExists) return 'park';
  if (!worktreeExists) return 'inspect';
  if (marker) return sessionId ? 'resume-session' : 'redispatch-after-stop';
  return 'inspect';
}

function cmdReconcile(argv) {
  const json = argv.includes('--json');

  const projectRoot = resolveProjectRoot();
  const dir = projectDir(orchHome(), projectRoot);
  const run = readRun(dir); // never written back — see this function's own header comment

  const report = run.queue
    .filter((item) => !RECONCILE_TERMINAL_STAGES.has(item.stage))
    .map((item) => {
      const worktreeExists = !!item.worktree && fs.existsSync(item.worktree);
      const itemBranchExists = branchExists(projectRoot, item.branch);
      let itemFileLocation = null;
      let started = false;
      let marker = false;
      if (worktreeExists) {
        const found = findItemFilePath(item.worktree, item.id);
        if (found) {
          itemFileLocation = `${found.section}/${found.state}`;
          started = itemFrontmatterHasKey(found.path, 'started');
          marker = itemHasPhaseMarker(found.path);
        }
      }
      return {
        id: item.id,
        stage: item.stage,
        worktreeExists,
        branchExists: itemBranchExists,
        itemFileLocation,
        started,
        marker,
        sessionId: item.sessionId,
        suggestion: suggestReconcileAction({ worktreeExists, itemBranchExists, marker, sessionId: item.sessionId })
      };
    });

  if (json) {
    console.log(JSON.stringify(report));
  } else {
    for (const row of report) {
      console.log(
        `${row.id}  stage=${row.stage}  worktree=${row.worktreeExists}  branch=${row.branchExists}  ` +
          `marker=${row.marker}  session=${row.sessionId ?? '(none)'}  -> ${row.suggestion}`
      );
    }
  }
  return 0;
}

// --- abort ----------------------------------------------------------------
// Tears down every queue item's worktree and branch (best-effort — a
// worktree/branch git has never heard of, or already removed, just fails
// these calls harmlessly; abort does not treat that as fatal, since it is
// exactly the state abort is trying to reach anyway), then finishes the run
// as `aborted` via the SAME cmdFinish this file's own `finish` command
// uses.
//
// ONE exemption to that teardown, and it is deliberate: an item whose
// worktree copy still carries an in-progress `phase:` marker has its
// worktree AND branch left COMPLETELY ALONE — neither `git worktree
// remove` nor `git branch -D` runs for that item at all. Three reasons, all
// pointing the same direction:
//   1. Item files have exactly ONE writer family (CLAUDE.md's own
//      invariant): the backlog skills, via `backlog.mjs start`/`stop`. This
//      tool is not one of them and never will be — it cannot clear the
//      marker itself before discarding the worktree that carries it.
//   2. A live `phase:` marker means a real `claude -p` session was working
//      when whatever holds this worktree stopped updating it, and its most
//      recent work is very likely NOT yet committed — `backlog-execute`
//      never commits; the orchestrator does, as a LATER pipeline step (see
//      the design spec's per-item loop). `git worktree remove --force`
//      does not ask; it deletes the working directory outright, uncommitted
//      changes included, with no undo — nothing was ever a commit for `git
//      revert` (or a reflog entry) to reach.
//   3. An earlier version of this function recorded the marker in
//      `attention` with instructions to run `backlog.mjs stop` "before the
//      worktree is discarded" and then discarded the worktree in the SAME
//      loop iteration — making that instruction impossible to follow by the
//      time anyone could read it. An abort that quietly destroys unbilled
//      time AND uncommitted code, while telling a human to do something it
//      already made impossible, is worse than one that leaves a directory
//      behind: a leftover worktree is an annoyance a human can clean up by
//      hand; destroyed uncommitted work has no recovery path at all.
//
// A SECOND, narrower exemption, added once branch mode made the existing
// unconditional `git branch -D` destructive in a way it never was before:
// an item that has already reached the `branched` terminal stage (design
// §5.3) keeps its branch. Before branch mode existed, deleting a completed
// item's branch here was always safe — a `merged` item's commits already
// live on `main`, so the branch is redundant by the time abort runs, and
// deleting it destroys nothing. Branch mode broke that assumption: a
// `branched` item's branch is never folded into anything, `main` is never
// touched (§5.3, "no `git branch -d`. The branch is the deliverable."), so
// this file's own single unconditional `branch -D` call would, for a
// `branched` item, be the ONLY copy of that item's work anywhere — force-
// deleted with `-D`, which bypasses git's "not fully merged" safety check
// with no reflog-reachable backup, exactly the class of loss CLAUDE.md's
// own `git revert -m 1` (never `reset --hard`) invariant exists to head
// off for the merge side of this same file. Unlike the phase:-marker
// exemption above, the worktree teardown itself is NOT skipped here — the
// directory serves no further purpose once the branch exists as a ref, and
// leaving `git worktree remove` ungated also still clears a stale
// `.git/worktrees/` admin entry for a `branched` item exactly as it does
// for every other stage. Only the `branch -D` call is gated, and the kept
// branch gets its own `attention` entry (same reasoning as the marker
// case: a human may never see this process's own stdout, so the run file
// is the only durable record that this branch still exists and where).
// Every OTHER terminal stage keeps today's behaviour exactly — most
// notably `merged`, whose branch was already deleted by the run itself at
// merge time (§9), so attempting `branch -D` again here is a harmless
// no-op, not a second case needing a guard.
//
// This does NOT stop abort from finishing overall: every OTHER item's
// worktree and branch still get torn down, `run.status` still becomes
// `aborted`, and the run still ends — only the marked item's own git
// objects are skipped. Its attention entry names the exact worktree path
// and the exact `backlog.mjs stop <id>` command a human (or a resumed
// skill run — Task 7) needs, so nothing is left silently untracked either.
function cmdAbort() {
  const projectRoot = resolveProjectRoot();
  const dir = projectDir(orchHome(), projectRoot);
  const run = readRun(dir);
  // A takeover, not an assertion — see `takeOverRun` for why abort of all
  // commands may not be refused on a dead session's lease. It also has to be a
  // real write rather than an in-memory pass: `cmdFinish` below re-reads the
  // file and runs `assertDriver` on what it finds, so a takeover that never
  // landed on disk would refuse this run's own ending.
  takeOverRun(dir, run);

  const removedIds = [];
  const preservedIds = [];
  const keptBranchIds = [];

  for (const item of run.queue) {
    let marker = false;
    if (item.worktree && fs.existsSync(item.worktree)) {
      const found = findItemFilePath(item.worktree, item.id);
      marker = !!(found && itemHasPhaseMarker(found.path));
    }

    if (marker) {
      // See this function's own header comment for why this item's git
      // teardown is skipped entirely rather than run "before" recording
      // this — there is no "before" once the worktree is gone. The
      // attention entry is this item's only durable record of what
      // happened; it has to stand alone (a human may never see this
      // process's own stdout), so it carries the absolute path and the
      // exact command, not just the item id.
      run.attention.push({
        id: item.id,
        kind: 'parked',
        detail:
          `worktree ${item.worktree} still carries an in-progress phase: marker — LEFT IN PLACE (not removed), ` +
          `since removing it would destroy uncommitted work this tool has no way to save first. Run ` +
          `\`backlog.mjs stop ${item.id}\` in ${item.worktree} to bill the dead interval and clear the marker, ` +
          `then remove the worktree (\`git -C ${projectRoot} worktree remove ${item.worktree}\`) and branch ` +
          `(\`git -C ${projectRoot} branch -D ${item.branch}\`) by hand or via a fresh abort.`
      });
      preservedIds.push(item.id);
      continue;
    }

    if (item.worktree) {
      // Always attempted, not gated on fs.existsSync above — this also
      // cleans up a worktree whose directory was already deleted
      // out-of-band (a stale admin entry under .git/worktrees/). Never
      // `git reset --hard` anywhere in this teardown: Task 1 proved
      // empirically that `reset --hard` silently destroys unrelated
      // uncommitted modifications, a risk `worktree remove`/`branch -D`
      // (which only ever touch THIS item's own worktree/branch, never the
      // main tree's own working copy) simply do not carry.
      spawnSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', item.worktree]);
    }
    if (item.branch) {
      if (item.stage === 'branched') {
        // See this function's own header comment (the SECOND exemption)
        // for why this branch — and only this branch — survives abort's
        // otherwise-unconditional `branch -D`: it is the item's whole
        // deliverable under branch mode (design §5.3), never merged into
        // `main`, so deleting it here would be the one and only copy of
        // that item's work gone for good. Recorded in `attention`, not
        // just this function's own console summary below, for the same
        // "a human may never see this process's own stdout" reason the
        // marker exemption above already gives.
        run.attention.push({
          id: item.id,
          kind: 'parked',
          detail:
            `branch ${item.branch} was KEPT by abort (not deleted) — this item finished as 'branched', ` +
            `branch mode's own terminal stage (design §5.3), so its branch is the deliverable and was never ` +
            `merged into main. The worktree at ${item.worktree ?? '(none recorded)'} was still removed since it ` +
            `serves no further purpose once the branch exists as a ref; the branch itself needs no action — it ` +
            `is simply waiting to be reviewed or merged by hand.`
        });
        keptBranchIds.push(item.id);
      } else {
        // Every other terminal (or non-terminal) stage's branch is
        // genuinely disposable here — most notably `merged`, whose branch
        // was already deleted by the run itself at merge time (§9), which
        // makes this call a harmless no-op for that stage rather than a
        // second case needing its own guard.
        spawnSync('git', ['-C', projectRoot, 'branch', '-D', item.branch]);
      }
    }
    if (item.worktree || (item.branch && item.stage !== 'branched')) removedIds.push(item.id);
  }

  run.updatedAt = nowISO();
  writeRunAtomic(dir, run);

  // A one-line human-readable summary, printed BEFORE cmdFinish's own
  // `{"status":"aborted"}` JSON line, so a human watching this run does not
  // have to separately run `status --json` and cross-reference `attention`
  // by hand just to learn what abort actually did. A THIRD clause joined
  // the original two once branch mode gave abort something else worth
  // calling out on its own: a `branched` item's kept branch is neither a
  // full "removed" (its worktree went, its branch didn't) nor the marker
  // case's "left completely alone" (its worktree DID go) — silently
  // folding it into either existing count would misreport what abort
  // actually did to it.
  console.log(
    `abort: removed ${removedIds.length} item(s)${removedIds.length ? ` (${removedIds.join(', ')})` : ''}; ` +
      `kept ${keptBranchIds.length} branch(es) already staged 'branched'${keptBranchIds.length ? ` (${keptBranchIds.join(', ')} — see attention)` : ''}; ` +
      `left ${preservedIds.length} in place with an in-progress marker${preservedIds.length ? ` (${preservedIds.join(', ')} — see attention)` : ''}`
  );

  return cmdFinish(['--status', 'aborted']);
}

const USAGE = `usage: orchestrate.mjs <command>

commands:
  init         create and lock a new run for a project
  claim        take a crashed run over as its driver, and heartbeat it
  plan         preview the gated queue init would build, without writing
  stage        move a queue item to a new stage
  merge-mode   record a merge mode downgrade (merge -> branch only)
  heartbeat    re-stamp the run's updatedAt
  attention    record something a human should look at
  assume       record a question this run answered itself (decide mode only)
  finish       set the run's final status
  unpause      mark a paused run running again (a --resume session's first write)
  status       print the current run
  watch        survive a long headless child across the loop's own Bash cap
  denials      list the permission denials a session's transcript recorded
  usage        record what one dispatched session cost, from its transcript
  verify       run the project's proof commands and record them
  snapshot     write a tracker item + its Outcome to one file (tracker projects only)
  reconcile    read-only crash-recovery report
  abort        tear down worktrees/branches and end the run`;

// --- CLI dispatch --------------------------------------------------------
// Thin by design (see the "commands" section comment above): main only maps
// a command name to its cmdXxx function and turns any OrchestrateError it
// throws into the matching exit code. Every cmdXxx function validates
// everything it can before its first write, so an error thrown from inside
// one is, by construction, thrown before that command has touched
// run.json — which is what makes "errors must write nothing at all" true
// without main having to enforce it itself.
//
// The full exit-code contract, in one place — the backlog-orchestrate
// SKILL's own prose quotes this verbatim, so it must stay accurate here
// first:
//   0  success.
//   1  bad args, an unknown item id, an unknown stage/kind string, or
//      missing required input — a problem with THIS call, independent of
//      run state. Nothing is ever written when a command exits 1. Three
//      exit 1s are the deliberate exceptions to "independent of run state":
//      `stage <id> merged` under a branch-mode run (see cmdStage's own
//      comment) and `merge-mode` refusing anything but a merge -> branch
//      move (see cmdMergeMode's own comment) both depend on the run file's
//      own mergeModeEffective, and `assume` under a park-mode run (see
//      cmdAssume's own comment) depends on its questionMode — none of the
//      three on the call's args alone. Listed here so this contract doc
//      doesn't quietly go stale on the cases where it isn't quite true. The
//      "nothing written" half of the guarantee still holds for all three.
//   3  no run exists for this project (readRun's own refusal) — EXCEPT for
//      `watch`, which also exits 3 when its own `--budget-ms` elapses with
//      the child still alive. That second meaning is a deliberate reuse of
//      the same number, not a collision this file failed to notice: see
//      cmdWatch's own comment for why "no run yet" and "still running, try
//      again" are the same shape of retry from the caller's point of view.
//   4  lock held — a fresh OR stale `status: "running"` run.json refusing a
//      plain `init` (see cmdInit's own long comment on why both refuse
//      identically).
//   5  `verify` found nothing it could resolve to prove the item works —
//      that command's own exit alone; no other command ever returns it.
//   6  `stage <id> preflight` and `stage <id> dispatched` alone: a pause
//      request is effective for this run and the call is a transition into
//      one of those two stages (see cmdStage's own comment for why exactly
//      those, and why a re-stamp is exempt). Nothing is written. It is not a
//      `1` because a `1` means "fix this call and retry" and this one must
//      never be retried: the reaction is a DIFFERENT command entirely,
//      `finish --status paused` — SKILL.md §10, "Pausing".
//   7  another session holds this run's driver lease (bug-19): every mutating
//      command refuses it, and `claim`/`abort` refuse to take over a run that
//      is `running`, FRESH and already led. Nothing is written. Its own number
//      rather than a `1` for the same reason `6` is: the reaction is not "fix
//      this call and retry" but STOP — another session is driving this run, so
//      write nothing more and exit (references/recovery.md). `unpause` is the
//      one writing command exempt from it; see cmdUnpause for why.
//   8  the backlog-manager API is not running (task-47), on a TRACKER project
//      only — a files project makes no request on any path and can never see
//      this. Nothing is written. Its own number rather than a `1` for the
//      reason backlog.mjs's own exit `5` has one: "the store said no" and
//      "there is no store reachable at all" are different things, and the
//      second has the same fix every time (`pnpm run dev`, `pnpm run
//      docker:up`). It is `8` rather than `5` only because `5` and `3` were
//      already taken here and SKILL.md branches on both.
//   9  an API refusal this command could not absorb (task-47) — a 503 with no
//      token, a 502 from GitHub, a 400 naming a field this tool composed.
//      Nothing is written. Distinct from `1`, which means "this call was
//      wrong": a `9` means the call was right and the other side would not do
//      it, so the reaction is a park rather than a fix. Refusals a command CAN
//      absorb never reach it — a `claim` 409 naming another run is exit `0`
//      and a `skipped` item, because a refusal is information.
export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'init') return cmdInit(rest);
    if (cmd === 'claim') return cmdClaim(rest);
    if (cmd === 'plan') return cmdPlan(rest);
    if (cmd === 'stage') return cmdStage(rest);
    if (cmd === 'merge-mode') return cmdMergeMode(rest);
    if (cmd === 'heartbeat') return cmdHeartbeat(rest);
    if (cmd === 'attention') return cmdAttention(rest);
    if (cmd === 'assume') return cmdAssume(rest);
    if (cmd === 'finish') return cmdFinish(rest);
    if (cmd === 'unpause') return cmdUnpause();
    if (cmd === 'status') return cmdStatus(rest);
    if (cmd === 'watch') return cmdWatch(rest);
    if (cmd === 'denials') return cmdDenials(rest);
    if (cmd === 'usage') return cmdUsage(rest);
    if (cmd === 'verify') return cmdVerify(rest);
    if (cmd === 'snapshot') return cmdSnapshot(rest);
    if (cmd === 'reconcile') return cmdReconcile(rest);
    if (cmd === 'abort') return cmdAbort();
    console.error(`unknown command: ${cmd ?? '(none)'}\n\n${USAGE}`);
    return 1;
  } catch (e) {
    if (!(e instanceof OrchestrateError)) throw e;
    console.error(e.message);
    return e.code;
  }
}

// `process.exitCode`, NOT `process.exit()` — the same rule all three skill
// CLIs follow; retro.mjs's own entry guard carries the full record of the
// incident (a `--json` payload silently cut at exactly 65,536 bytes, because
// writing to a PIPE is asynchronous and `process.exit()` never drains it,
// while a `> file.json` redirect is synchronous on POSIX and always looked
// fine). `status --json` prints the run file verbatim, so this tool has a
// payload that outgrows the buffer as soon as a queue is long.
//
// This file looks like the one that might need the forced exit and does not:
// every child process is `spawnSync` (reaped before the call returns), and
// `watch`'s polling sleep is `sleepSync`, an `Atomics.wait` that BLOCKS the
// thread rather than scheduling a timer. There is no `setTimeout`, no
// `setInterval`, no async/await, no server and no stdin read here, so `main`
// returning leaves no live handle. A future edit that introduces one must
// close it rather than restore `process.exit()`, which would bring the
// truncation back with it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
