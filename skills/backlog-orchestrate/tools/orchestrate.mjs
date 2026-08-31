#!/usr/bin/env node
// orchestrate: the run-state core for backlog-orchestrate. This tool owns
// EVERY write to a project's run file — the same single-writer discipline
// skills/backlog/tools/backlog.mjs keeps for the registry and for item
// files, applied here to `~/.backlog-manager/orchestrator/<project
// key>/run.json`. Task 3 builds init/lock, stage, heartbeat, attention,
// finish and status; Task 4 wires the real refusal gate into `init`'s queue
// builder (see the `--queue-json` escape hatch below); Task 5 adds watch,
// verify, resume-reconcile and abort on top of the same run file.
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// --- errors -------------------------------------------------------------
// Carries the intended process exit code so `main`'s one try/catch (see the
// bottom of this file) never has to re-classify an error after the fact —
// the same pattern backlog.mjs's BacklogError uses, duplicated rather than
// imported for the standalone reason above. The contract other tasks quote
// verbatim: 0 success, 1 bad args / unknown item / unknown stage, 3 no run
// exists, 4 lock held (a fresh OR stale `status: "running"` run.json — see
// cmdInit's own long comment on why both refuse identically).
export class OrchestrateError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'OrchestrateError'
    this.code = code
  }
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
export const RUN_STALE_MS = 15 * 60 * 1000

// True when `updatedAt` is within RUN_STALE_MS of `now` — the one freshness
// check every "is this run still alive" decision in this file reads,
// rather than five call sites each re-deriving the comparison.
function isFresh(updatedAt, now = Date.now()) {
  const t = Date.parse(updatedAt)
  return Number.isFinite(t) && now - t < RUN_STALE_MS
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
  return new Date().toISOString()
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
  const d = new Date(stamp)
  const pad = (n) => String(n).padStart(2, '0')
  return `run-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

// --- where state lives ---------------------------------------------------

// `$BM_ORCH_HOME` when set, else `~/.backlog-manager/orchestrator/` — the
// override exists solely so a test process (or a developer poking at the
// tool by hand) never touches a real machine's orchestrator state, the same
// escape hatch backlog.mjs's own BM_REGISTRY_FILE provides for the
// registry.
export function orchHome() {
  return process.env.BM_ORCH_HOME || path.join(os.homedir(), '.backlog-manager', 'orchestrator')
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
  return path.join(root, encodeURIComponent(project))
}

function runFilePath(dir) {
  return path.join(dir, 'run.json')
}

function runsArchiveDir(dir) {
  return path.join(dir, 'runs')
}

// Picks the archive path for a finished run, `<archiveDir>/<runId>.json`
// unless that name is already taken — which makeRunId's second-precision
// shape makes a real possibility, not a theoretical one: `finish` followed
// immediately by `init` (a human clearing a done run and starting the next
// one, or a test doing the same two calls back to back) can easily land two
// runs' worth of archiving in the same wall-clock second. Falling through
// to `-2`, `-3`, … on a collision means the second archive can never
// silently overwrite the first and destroy a finished run's only surviving
// record — the alternative, a bare renameSync straight to `<runId>.json`,
// would make that data loss possible on nothing more exotic than a fast
// human or a fast test.
function archivePath(archiveDir, runId) {
  let candidate = path.join(archiveDir, `${runId}.json`)
  for (let suffix = 2; fs.existsSync(candidate); suffix++) {
    candidate = path.join(archiveDir, `${runId}-${suffix}.json`)
  }
  return candidate
}

// Walks up from `startDir` looking for a `.git` entry (a directory for a
// normal clone, a file for a linked worktree or submodule — existsSync
// covers both), exactly the git-root walk backlog.mjs's own resolveRoot
// does. Duplicated rather than imported for the standalone reason in this
// file's header comment.
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
// from inside one). Task 1's own spike confirmed backlog.mjs's identical
// walk resolves each worktree to itself rather than chasing the worktree
// pointer back to the main tree, which is exactly why this walk is safe to
// reuse verbatim: the orchestrator's own cwd is the main tree throughout,
// so there is no worktree-vs-main ambiguity for this file to worry about.
export function resolveProjectRoot(startDir = process.cwd()) {
  const resolvedStart = path.resolve(startDir)
  let dir = resolvedStart
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new OrchestrateError(
        `no .git found in ${resolvedStart} or any parent directory — orchestrate.mjs resolves "which project" from its own cwd for every command except init, so this must run from inside the project being orchestrated`,
        1,
      )
    }
    dir = parent
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
  const file = runFilePath(dir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new OrchestrateError(
        'no run exists for this project — run `orchestrate.mjs init --project <path>` first',
        3,
      )
    }
    throw e
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new OrchestrateError(`${file}: exists but does not parse as JSON (${e.message}) — nothing this tool can act on`, 3)
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
  fs.mkdirSync(dir, { recursive: true })
  const file = runFilePath(dir)
  const tmp = path.join(dir, `.run.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// --- queue items -------------------------------------------------------

// The full RunStage vocabulary, verbatim from shared/types.ts's own
// RunStage union — duplicated for the same standalone reason as
// RUN_STALE_MS above (see that constant's comment). `stage` validates
// against this list; an unrecognized string is a code-1 usage error, never
// silently accepted.
const RUN_STAGES = [
  'pending', 'preflight', 'dispatched', 'inspecting', 'reviewing',
  'fixing', 'verifying', 'merging', 'merged',
  'failed', 'skipped', 'needs-answers', 'ungroomed', 'parked',
]

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
    note: null,
  }
}

// Comma-separated --ids, trimmed and emptied of blanks, then capped to
// --max entries when one was given. Order is preserved as given: Task 4
// owns actually deciding what order the gate should queue items in
// (bugs-oldest-first, then tasks-oldest-first, per the plan) — this
// function is only ever reached today via the CLI's own literal --ids
// list, with no gate behind it yet.
function idsFromArg(idsArg, maxItems) {
  if (idsArg === undefined) return []
  const ids = idsArg.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return maxItems === null ? ids : ids.slice(0, maxItems)
}

// --queue-json <file> — a TEMPORARY test-only escape hatch. Task 4 wires
// the real refusal gate into `init` (reading each candidate item's own
// groomed/ungroomed state out of the project's backlog/ directory and
// deciding what belongs in the queue and in what order); until that
// exists, this is the only way a test can hand `init` a queue with actual
// content to exercise `stage`/`attention`/`finish` against. Task 4 deletes
// this flag once the gate makes it unnecessary — do not build anything
// else on top of it.
//
// The file's own contract is intentionally the narrowest thing that could
// work: a JSON array of `{id, title}` pairs. Each entry is normalized
// through the exact same makeQueueItem() every other queue item goes
// through — nothing from the input file is trusted or copied through
// as-is beyond those two strings — so a queue seeded this way is
// shape-identical to one the real gate will eventually build, and a test
// asserting the contract fixture's key set is really testing this tool's
// own construction, not the fixture file's honesty.
function queueFromFile(file, stamp) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new OrchestrateError(`--queue-json ${file}: ${e.message}`, 1)
  }
  if (!Array.isArray(parsed)) {
    throw new OrchestrateError(`--queue-json must be a JSON array of {id, title} objects: ${file}`, 1)
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.title !== 'string') {
      throw new OrchestrateError(`--queue-json entries must each have a string id and a string title, got ${JSON.stringify(entry)}`, 1)
    }
    return makeQueueItem(entry.id, entry.title, stamp)
  })
}

// --- commands ----------------------------------------------------------
// Each cmdXxx function is the CLI's own contract for one command: parse
// this command's flags, validate everything that can be validated before
// touching disk, then do the one thing this command does. `main` (bottom of
// file) is deliberately thin — a plain command-name dispatch plus one
// try/catch around all of them — rather than backlog.mjs's inline-per-
// command style, so the contract for "what does `stage` do" lives entirely
// inside cmdStage and not spread across a bigger switch.

const INIT_USAGE = 'usage: orchestrate.mjs init --project <abs path> [--ids a,b,c] [--max N]'

function cmdInit(argv) {
  let project
  let idsArg
  let maxArg
  let queueJsonFile
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') project = argv[++i]
    else if (argv[i] === '--ids') idsArg = argv[++i]
    else if (argv[i] === '--max') maxArg = argv[++i]
    else if (argv[i] === '--queue-json') queueJsonFile = argv[++i]
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
    throw new OrchestrateError(INIT_USAGE, 1)
  }

  let maxItems = null
  if (maxArg !== undefined) {
    const n = Number(maxArg)
    if (!Number.isInteger(n) || n < 0) {
      throw new OrchestrateError(`--max must be a non-negative integer: ${maxArg}`, 1)
    }
    maxItems = n
  }

  const root = orchHome()
  const dir = projectDir(root, project)
  fs.mkdirSync(dir, { recursive: true })

  const file = runFilePath(dir)
  let existing = null
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'))
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
      throw new OrchestrateError(`${file} exists but does not parse as JSON — resolve or remove it by hand before running init again: ${e.message}`, 1)
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
      : `this project's run.json is still marked "running" but its last heartbeat (${existing.updatedAt}) is stale — this looks like a crashed run, not an active lock`
    throw new OrchestrateError(
      `${reason}. Use \`orchestrate.mjs status\` to inspect it, then --resume or --abort (never plain init) to take it over.`,
      4,
    )
  }

  const stamp = nowISO()

  // A non-running existing run (done/aborted/failed) is archived rather
  // than discarded: `runs/<runId>.json` is the only place a finished run's
  // full history survives once run.json itself is about to be replaced,
  // and `pastRuns` (the server payload, Task 8) is nothing more than a
  // directory listing over exactly this folder.
  if (existing) {
    const archiveDir = runsArchiveDir(dir)
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.renameSync(file, archivePath(archiveDir, existing.runId))
  }

  // The gate Task 4 wires in is what will normally decide queue content and
  // order; until it exists, --queue-json (test-only, see its own comment)
  // takes priority when given, and a bare --ids list (with an optional
  // --max cap) is the fallback used by a real, gate-less `init` today. Both
  // paths funnel through makeQueueItem so every item in the result has the
  // exact same shape regardless of which one built it.
  const queue = queueJsonFile !== undefined
    ? queueFromFile(queueJsonFile, stamp)
    : idsFromArg(idsArg, maxItems).map((id) => makeQueueItem(id, id, stamp))

  const runId = makeRunId(stamp)
  const newRun = {
    runId,
    project,
    status: 'running',
    startedAt: stamp,
    updatedAt: stamp,
    maxItems,
    queue,
    attention: [],
  }

  writeRunAtomic(dir, newRun)
  console.log(JSON.stringify({ runId, dir }))
  return 0
}

const STAGE_USAGE = 'usage: orchestrate.mjs stage <itemId> <stage> [--session S] [--worktree W] [--branch B] [--note S]'

function cmdStage(argv) {
  const itemId = argv[0]
  const stage = argv[1]
  let session
  let worktree
  let branch
  let note
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--session') session = argv[++i]
    else if (argv[i] === '--worktree') worktree = argv[++i]
    else if (argv[i] === '--branch') branch = argv[++i]
    else if (argv[i] === '--note') note = argv[++i]
  }

  if (!itemId || !stage) {
    throw new OrchestrateError(STAGE_USAGE, 1)
  }
  // Validated before the run is even read: an unrecognized stage name is a
  // problem with the command line itself, independent of whether a run
  // exists at all, so it is refused the same way regardless of run state.
  if (!RUN_STAGES.includes(stage)) {
    throw new OrchestrateError(`unknown stage: ${stage} (expected one of ${RUN_STAGES.join(', ')})`, 1)
  }

  const dir = projectDir(orchHome(), resolveProjectRoot())
  const run = readRun(dir)

  const item = run.queue.find((q) => q.id === itemId)
  if (!item) {
    throw new OrchestrateError(`unknown item id: ${itemId}`, 1)
  }

  item.stage = stage
  // First-arrival only — shared/types.ts's own RunQueueItem.stageAt comment
  // is explicit that a fix-and-re-review loop revisiting `reviewing`/
  // `fixing` must not move that stage's timestamp forward a second time;
  // stageAt is a shape record of which stages this item has ever visited,
  // not a full event log. Guarding the write with `in` (not overwriting
  // unconditionally) is what makes a stage's very first visit permanent.
  if (!(stage in item.stageAt)) {
    item.stageAt[stage] = nowISO()
  }
  if (session !== undefined) item.sessionId = session
  if (worktree !== undefined) item.worktree = worktree
  if (branch !== undefined) item.branch = branch
  if (note !== undefined) item.note = note

  run.updatedAt = nowISO()
  writeRunAtomic(dir, run)
  console.log(JSON.stringify({ id: itemId, stage }))
  return 0
}

function cmdHeartbeat() {
  const dir = projectDir(orchHome(), resolveProjectRoot())
  const run = readRun(dir)
  run.updatedAt = nowISO()
  writeRunAtomic(dir, run)
  console.log(run.updatedAt)
  return 0
}

const ATTENTION_USAGE = 'usage: orchestrate.mjs attention <itemId> --kind <needs-answers|parked|fix-exhausted> --detail <text> [--questions-json <file>]'
const ATTENTION_KINDS = ['needs-answers', 'parked', 'fix-exhausted']

function cmdAttention(argv) {
  const itemId = argv[0]
  let kind
  let detail
  let questionsJsonFile
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--kind') kind = argv[++i]
    else if (argv[i] === '--detail') detail = argv[++i]
    else if (argv[i] === '--questions-json') questionsJsonFile = argv[++i]
  }

  if (!itemId || !kind || detail === undefined) {
    throw new OrchestrateError(ATTENTION_USAGE, 1)
  }
  if (!ATTENTION_KINDS.includes(kind)) {
    throw new OrchestrateError(`unknown kind: ${kind} (expected one of ${ATTENTION_KINDS.join(', ')})`, 1)
  }

  const dir = projectDir(orchHome(), resolveProjectRoot())
  const run = readRun(dir)

  const item = run.queue.find((q) => q.id === itemId)
  if (!item) {
    throw new OrchestrateError(`unknown item id: ${itemId}`, 1)
  }

  // --questions-json only ever means something for kind needs-answers — the
  // field it mirrors onto the queue item (RunQueueItem.questions) is
  // documented as "[] for every other stage," so a --parked or
  // --fix-exhausted call carrying the flag anyway is read and validated
  // (a bad file should still fail loudly) but its content is deliberately
  // never applied — see the `kind === 'needs-answers'` guard below.
  let questions
  if (questionsJsonFile !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(questionsJsonFile, 'utf8'))
    } catch (e) {
      throw new OrchestrateError(`--questions-json ${questionsJsonFile}: ${e.message}`, 1)
    }
    if (!Array.isArray(parsed) || !parsed.every((q) => typeof q === 'string')) {
      throw new OrchestrateError(`--questions-json must be a JSON array of strings: ${questionsJsonFile}`, 1)
    }
    questions = parsed
  }

  run.attention.push({ id: itemId, kind, detail })
  if (kind === 'needs-answers' && questions !== undefined) {
    item.questions = questions
  }

  run.updatedAt = nowISO()
  writeRunAtomic(dir, run)
  console.log(JSON.stringify({ id: itemId, kind }))
  return 0
}

const FINISH_USAGE = 'usage: orchestrate.mjs finish --status <done|aborted|failed>'
const FINISH_STATUSES = ['done', 'aborted', 'failed']

function cmdFinish(argv) {
  let status
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status') status = argv[++i]
  }
  if (!FINISH_STATUSES.includes(status)) {
    throw new OrchestrateError(FINISH_USAGE, 1)
  }

  const dir = projectDir(orchHome(), resolveProjectRoot())
  const run = readRun(dir)

  run.status = status
  run.updatedAt = nowISO()
  writeRunAtomic(dir, run)
  console.log(JSON.stringify({ status }))
  return 0
}

function cmdStatus(argv) {
  const json = argv.includes('--json')

  const dir = projectDir(orchHome(), resolveProjectRoot())
  const run = readRun(dir)

  if (json) {
    console.log(JSON.stringify(run))
  } else {
    const merged = run.queue.filter((q) => q.stage === 'merged').length
    console.log(`${run.runId}  ${run.project}  ${run.status}`)
    console.log(`updated: ${run.updatedAt}`)
    console.log(`queue: ${merged}/${run.queue.length} merged`)
    console.log(`attention: ${run.attention.length}`)
  }
  return 0
}

const USAGE = `usage: orchestrate.mjs <command>

commands:
  init       create and lock a new run for a project
  stage      move a queue item to a new stage
  heartbeat  re-stamp the run's updatedAt
  attention  record something a human should look at
  finish     set the run's final status
  status     print the current run`

// --- CLI dispatch --------------------------------------------------------
// Thin by design (see the "commands" section comment above): main only maps
// a command name to its cmdXxx function and turns any OrchestrateError it
// throws into the matching exit code. Every cmdXxx function validates
// everything it can before its first write, so an error thrown from inside
// one is, by construction, thrown before that command has touched
// run.json — which is what makes "errors must write nothing at all" true
// without main having to enforce it itself.
export function main(argv) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'init') return cmdInit(rest)
    if (cmd === 'stage') return cmdStage(rest)
    if (cmd === 'heartbeat') return cmdHeartbeat(rest)
    if (cmd === 'attention') return cmdAttention(rest)
    if (cmd === 'finish') return cmdFinish(rest)
    if (cmd === 'status') return cmdStatus(rest)
    console.error(`unknown command: ${cmd ?? '(none)'}\n\n${USAGE}`)
    return 1
  } catch (e) {
    if (!(e instanceof OrchestrateError)) throw e
    console.error(e.message)
    return e.code
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
