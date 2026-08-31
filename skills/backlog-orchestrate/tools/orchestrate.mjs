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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// --- errors -------------------------------------------------------------
// Carries the intended process exit code so `main`'s one try/catch (see the
// bottom of this file) never has to re-classify an error after the fact —
// the same pattern backlog.mjs's BacklogError uses, duplicated rather than
// imported for the standalone reason above. The contract other tasks quote
// verbatim: 0 success, 1 bad args / unknown item / unknown stage / missing
// input, 3 no run exists, 4 lock held (a fresh OR stale `status: "running"`
// run.json — see cmdInit's own long comment on why both refuse
// identically), 5 `verify` found nothing resolvable to prove itself with
// (that command's own "cannot verify" exit, never used anywhere else). One
// number is deliberately overloaded: `watch` also exits 3 when its own
// budget elapses with the child still alive — see cmdWatch's own comment
// for why reusing "3" there (rather than minting a new code) is
// intentional, not a collision this file failed to notice.
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
//
// That safety depends entirely on the orchestrator loop actually honoring
// its own contract, and the failure mode if it doesn't is worth spelling
// out: if any `orchestrate.mjs` command were ever invoked with a per-item
// worktree as its cwd, this walk would NOT error. A linked worktree has its
// own `.git` (a file, not a directory, pointing at the shared gitdir), so
// `existsSync` finds it immediately and happily returns the WORKTREE's own
// path as "the project" — `projectDir` then keys the run under
// `encodeURIComponent(<worktree path>)`, a directory nobody else ever
// looks at, since every other command (and the server, Task 8) reads
// state keyed by the registered project's own path. The run would appear
// to vanish — no error, no crash, just state silently written to the
// wrong key — which is far harder to notice and debug than the loud "no
// .git found" refusal above. This is exactly why the skill (Task 7) must
// always invoke this tool from the project root and never from inside a
// worktree it created: per-item paths (`--worktree`, `--branch` on
// `stage`) are passed as explicit flag values instead of being implied by
// cwd.
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
const GATE_SECTIONS = { bugs: 'bug', tasks: 'task' }

// The placeholder backlog-capture writes for a bug nobody has diagnosed yet
// (`## Cause`/`## Fix` both start as this), and the value a task's own
// `## Plan` is treated as equivalent to "nothing here" when it's all that is
// present — matching the brief's own wording for the task rule ("non-empty
// content ... that is not just unknown/whitespace").
const PLACEHOLDER = 'unknown'

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
  const dir = path.join(backlogDir, section, 'open')
  if (!fs.existsSync(dir)) return []
  const prefix = GATE_SECTIONS[section]
  const idPattern = new RegExp(`^(${prefix}-(\\d+))-`)
  const items = []
  for (const name of fs.readdirSync(dir)) {
    const m = idPattern.exec(name)
    if (m) items.push({ id: m[1], num: Number(m[2]), section, path: path.join(dir, name) })
  }
  return items
}

// A narrow read: just `title` off the frontmatter fence and the raw body
// text after it, via the same `key:` line-splitter parseFrontmatter uses
// (see this section's own header comment for why a full parse is not worth
// duplicating here). A file that doesn't even open the fence the way
// backlog.mjs always writes one is treated as titleless and bodyless rather
// than thrown on — this tool never refuses to gate the REST of a store over
// one file some other process wrote badly; that item just reads as
// ungroomed by construction (no recognizable `## Plan`/`## Fix` will ever be
// found in a body of `''`).
function readItemForGate(absPath) {
  const text = fs.readFileSync(absPath, 'utf8')
  const lines = text.split('\n')
  if (lines[0] !== '---') return { title: '', body: '' }
  let i = 1
  let title = ''
  for (; i < lines.length; i++) {
    if (lines[i] === '---') break
    const sep = lines[i].indexOf(':')
    if (sep === -1) continue
    if (lines[i].slice(0, sep).trim() === 'title') title = lines[i].slice(sep + 1).trim()
  }
  if (i === lines.length) return { title, body: '' }
  return { title, body: lines.slice(i + 1).join('\n') }
}

// Finds one `## <heading>` section's own content: everything between that
// heading line and the next line that opens another `##` heading (or end of
// file). Returns `undefined` when the heading isn't present at all — kept
// distinct from an empty string, because "the heading is missing" and "the
// heading is there with nothing under it" are two different reasons in the
// gate below, and backlog-execute's own prose calls out both ("the heading
// is missing entirely, ... or if all that's there is a placeholder").
function extractSection(body, heading) {
  const lines = body.split('\n')
  const idx = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (idx === -1) return undefined
  const rest = lines.slice(idx + 1)
  const end = rest.findIndex((l) => l.trimStart().startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

// The task half of the gate: `## Plan` must exist and hold something beyond
// whitespace or the `unknown` placeholder. Each reason is its own string
// (rather than one combined message) so a caller — `plan`'s own human-
// readable printer, or a future UI — can list them as separate bullets.
// `questionSection` carries the section text forward for detectQuestions
// below, so that function never has to re-derive "which section did this
// item's own gate actually look at."
function gateTask(body) {
  const plan = extractSection(body, 'Plan')
  if (plan === undefined) {
    return { reasons: ['## Plan heading is missing — nothing for backlog-execute to work'], questionSection: undefined }
  }
  const trimmed = plan.trim()
  if (trimmed === '') {
    return { reasons: ['## Plan has no content under it — it is still empty'], questionSection: plan }
  }
  if (trimmed === PLACEHOLDER) {
    return { reasons: [`## Plan is still the "${PLACEHOLDER}" placeholder`], questionSection: plan }
  }
  return { reasons: [], questionSection: plan }
}

// The bug half: `## Fix` must not be exactly the `unknown` placeholder.
// Mirrors backlog-execute's own wording precisely ("Refuse if its content is
// still exactly `unknown`") — that skill does not separately call out a
// missing `## Fix` heading, because backlog-capture's bug template always
// writes one; a heading that is missing anyway is refused here too, rather
// than silently read as "ready," since there is equally nothing there for
// backlog-execute to work.
function gateBug(body) {
  const fix = extractSection(body, 'Fix')
  if (fix === undefined) {
    return { reasons: ['## Fix heading is missing'], questionSection: undefined }
  }
  if (fix.trim() === PLACEHOLDER) {
    return { reasons: [`## Fix is still the "${PLACEHOLDER}" placeholder — nobody has diagnosed this yet`], questionSection: fix }
  }
  return { reasons: [], questionSection: fix }
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
  const commands = []
  let inFence = false
  for (const line of doneWhenText.split('\n')) {
    const t = line.trim()
    if (t.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence || t === '') continue
    commands.push(t.startsWith('$ ') ? t.slice(2).trim() : t)
  }
  return commands
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
  const commands = extractDoneWhenCommands(doneWhenText)
  if (commands.length === 0) return []

  let verifyCommands = []
  try {
    const verifyJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'backlog', 'verify.json'), 'utf8'))
    if (Array.isArray(verifyJson.commands)) verifyCommands = verifyJson.commands
  } catch {
    // no backlog/verify.json here, or it doesn't parse — package.json
    // scripts (below) is the only other place a command can be "known"
  }

  let scripts = {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    if (pkg.scripts && typeof pkg.scripts === 'object') scripts = pkg.scripts
  } catch {
    // no package.json here, or it doesn't parse
  }

  return commands.filter((cmd) => {
    if (verifyCommands.includes(cmd)) return false
    const m = /^(?:pnpm|npm|yarn)\s+(?:run\s+)?([\w:-]+)$/.exec(cmd)
    return !(m && scripts[m[1]] !== undefined)
  })
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
  const questions = []
  if (body.includes('TBD')) {
    questions.push('There is a TBD in this item — what still needs deciding before it can run?')
  }
  if (questionSection) {
    for (const line of questionSection.split('\n')) {
      const t = line.trim()
      if (t.endsWith('?')) questions.push(t)
    }
  }
  const doneWhen = extractSection(body, 'Done when')
  if (doneWhen !== undefined) {
    for (const cmd of findUnresolvedCommands(doneWhen, projectRoot)) {
      questions.push(`## Done when references \`${cmd}\` — is that command actually runnable (not found in verify.json or package.json)?`)
    }
  }
  return questions
}

// One item's full gate result: `reasons` is non-empty only for `ungroomed`,
// `questions` only for `needs-answers` — the two never overlap, because an
// item whose primary gate already failed has nothing further worth asking:
// its plan or fix isn't real yet, so whether it ALSO contains a TBD is not
// the more useful thing to tell whoever is looking at this queue.
function gateItem(section, body, projectRoot) {
  const { reasons, questionSection } = section === 'tasks' ? gateTask(body) : gateBug(body)
  if (reasons.length > 0) {
    return { gate: 'ungroomed', reasons, questions: [] }
  }
  const questions = detectQuestions(body, questionSection, projectRoot)
  if (questions.length > 0) {
    return { gate: 'needs-answers', reasons: [], questions }
  }
  return { gate: 'ready', reasons: [], questions: [] }
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
  if (idsArg === undefined) return undefined
  return idsArg.split(',').map((s) => s.trim()).filter((s) => s !== '')
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
function buildGatedQueue(projectRoot, { ids, maxItems = null } = {}) {
  const backlogDir = path.join(projectRoot, 'backlog')
  const bugs = listOpenItems(backlogDir, 'bugs').sort((a, b) => a.num - b.num)
  const tasks = listOpenItems(backlogDir, 'tasks').sort((a, b) => a.num - b.num)
  const byId = new Map([...bugs, ...tasks].map((item) => [item.id, item]))

  let ordered
  if (ids !== undefined) {
    ordered = ids.map((id) => {
      const found = byId.get(id)
      if (!found) throw new OrchestrateError(`unknown item id: ${id}`, 1)
      return found
    })
  } else {
    ordered = [...bugs, ...tasks]
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
  let readyCount = 0
  return ordered.map((entry) => {
    const { title, body } = readItemForGate(entry.path)
    const { gate, reasons, questions } = gateItem(entry.section, body, projectRoot)
    const beyondMax = maxItems !== null && readyCount >= maxItems
    if (gate === 'ready') readyCount++
    return { id: entry.id, title, gate, reasons, questions, beyondMax }
  })
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
  const item = run.queue.find((q) => q.id === itemId)
  if (!item) {
    throw new OrchestrateError(`unknown item id: ${itemId}`, 1)
  }
  return item
}

function applyQueueItemFields(item, { stage, session, worktree, branch, note, fixLoop = false } = {}) {
  if (stage !== undefined) {
    item.stage = stage
    // First-arrival only — see shared/types.ts's own RunQueueItem.stageAt
    // comment: a fix-and-re-review loop revisiting `reviewing`/`fixing`
    // must not move that stage's timestamp forward a second time.
    if (!(stage in item.stageAt)) {
      item.stageAt[stage] = nowISO()
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
    item.fixLoops = Number.isInteger(item.fixLoops) ? item.fixLoops + 1 : 1
  }
  if (session !== undefined) item.sessionId = session
  if (worktree !== undefined) item.worktree = worktree
  if (branch !== undefined) item.branch = branch
  if (note !== undefined) item.note = note
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
  const idPattern = new RegExp(`^${itemId}-`)
  for (const section of ['bugs', 'tasks']) {
    for (const state of ['open', 'done']) {
      const sectionDir = path.join(dir, 'backlog', section, state)
      if (!fs.existsSync(sectionDir)) continue
      const found = fs.readdirSync(sectionDir).find((name) => idPattern.test(name))
      if (found) return { path: path.join(sectionDir, found), section, state }
    }
  }
  return null
}

// True when the item file at `absPath` carries a `<key>:` line inside its
// frontmatter fence — a one-key version of readItemForGate's own line
// splitter, reused below for both `started` (reconcile reports it, purely
// as information) and `phase` (reconcile/abort's actual decision signal —
// see itemHasPhaseMarker's own comment for why the two are not
// interchangeable).
function itemFrontmatterHasKey(absPath, key) {
  const lines = fs.readFileSync(absPath, 'utf8').split('\n')
  if (lines[0] !== '---') return false
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break
    const sep = lines[i].indexOf(':')
    if (sep === -1) continue
    if (lines[i].slice(0, sep).trim() === key) return true
  }
  return false
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
  return itemFrontmatterHasKey(absPath, 'phase')
}

// `git show-ref` rather than `git branch --list` — a plumbing command with
// a stable, script-friendly exit code (0 found, 1 not found) instead of
// parsing porcelain output for presence. Run against `projectRoot` (the
// MAIN tree, always — see resolveProjectRoot's own comment on why every
// command in this file runs from there): a linked worktree's branch is a
// branch in the SAME repository, visible from the main tree regardless of
// whether the worktree directory itself still exists on disk.
function branchExists(projectRoot, branch) {
  if (!branch) return false
  return spawnSync('git', ['-C', projectRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
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
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') project = argv[++i]
    else if (argv[i] === '--ids') idsArg = argv[++i]
    else if (argv[i] === '--max') maxArg = argv[++i]
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
  // a stray empty directory (see writeRunAtomic/archivePath below, both of
  // which now create their own directories on demand instead of this
  // function pre-creating one). Validating first — today that means
  // buildGatedQueue throwing on an --ids entry this store doesn't have —
  // means a bad call can never destroy or hide state that already existed;
  // the failure is confined to "nothing written," the same guarantee every
  // other error path in this file already gives.
  const stamp = nowISO()
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
  const gated = buildGatedQueue(project, { ids: parseIdsArg(idsArg), maxItems })
  const queue = gated.filter((item) => !item.beyondMax).map((item) => makeQueueItem(item.id, item.title, stamp))

  const root = orchHome()
  const dir = projectDir(root, project)

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

  // A non-running existing run (done/aborted/failed) is archived rather
  // than discarded: `runs/<runId>.json` is the only place a finished run's
  // full history survives once run.json itself is about to be replaced,
  // and `pastRuns` (the server payload, Task 8) is nothing more than a
  // directory listing over exactly this folder. By the time execution
  // reaches here, `queue` above has already been built and validated
  // successfully — so this rename can never run only to be followed by a
  // throw that leaves the project without any run.json at all.
  if (existing) {
    const archiveDir = runsArchiveDir(dir)
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.renameSync(file, archivePath(archiveDir, existing.runId))
  }

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

const PLAN_USAGE = 'usage: orchestrate.mjs plan --project <abs path> [--ids a,b,c] [--max N] [--json]'

// Previews a run without starting one: the exact queue `init` would build
// for these flags, printed rather than written. This is what lets a human
// (or the board's own launch UI, later) see which items are ready, which
// are ungroomed, and which are flagged with open questions BEFORE
// committing to a run — and what lets `init` itself stay a thin wrapper
// around buildGatedQueue instead of duplicating its own copy of the gate.
function cmdPlan(argv) {
  let project
  let idsArg
  let maxArg
  let json = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') project = argv[++i]
    else if (argv[i] === '--ids') idsArg = argv[++i]
    else if (argv[i] === '--max') maxArg = argv[++i]
    else if (argv[i] === '--json') json = true
  }

  // Same absolute-path requirement as init, for the same reason: whatever
  // this prints must describe the identical project a matching `init` call
  // would act on, and a relative path here could silently mean a different
  // directory than the one a human typing the same string into `init`
  // right after would get.
  if (!project || !path.isAbsolute(project)) {
    throw new OrchestrateError(PLAN_USAGE, 1)
  }

  let maxItems = null
  if (maxArg !== undefined) {
    const n = Number(maxArg)
    if (!Number.isInteger(n) || n < 0) {
      throw new OrchestrateError(`--max must be a non-negative integer: ${maxArg}`, 1)
    }
    maxItems = n
  }

  // Side-effect free by construction, not just by convention: everything
  // above is argument validation and everything below is buildGatedQueue's
  // own read-only walk of <project>/backlog — this function never calls
  // orchHome(), never resolves a run directory, and never opens a file for
  // writing. That is what lets a caller (a UI's queue preview, or a human
  // sanity-checking a run before committing to it) call this as many times
  // as it wants without ever risking a run's own state.
  const queue = buildGatedQueue(project, { ids: parseIdsArg(idsArg), maxItems })

  if (json) {
    console.log(JSON.stringify(queue))
  } else {
    for (const item of queue) {
      const flag = item.beyondMax ? '  (beyond --max)' : ''
      console.log(`${item.gate.padEnd(13)} ${item.id}  ${item.title}${flag}`)
      for (const reason of item.reasons) console.log(`    - ${reason}`)
      for (const question of item.questions) console.log(`    ? ${question}`)
    }
  }
  return 0
}

const STAGE_USAGE = 'usage: orchestrate.mjs stage <itemId> <stage> [--session S] [--worktree W] [--branch B] [--note S] [--fix-loop]'

function cmdStage(argv) {
  const itemId = argv[0]
  const stage = argv[1]
  let session
  let worktree
  let branch
  let note
  // The one valueless flag on this command: it consumes no argv slot, so it
  // never does the `argv[++i]` step the four above all take.
  let fixLoop = false
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--session') session = argv[++i]
    else if (argv[i] === '--worktree') worktree = argv[++i]
    else if (argv[i] === '--branch') branch = argv[++i]
    else if (argv[i] === '--note') note = argv[++i]
    else if (argv[i] === '--fix-loop') fixLoop = true
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

  const item = findQueueItem(run, itemId)
  applyQueueItemFields(item, { stage, session, worktree, branch, note, fixLoop })

  run.updatedAt = nowISO()
  writeRunAtomic(dir, run)
  // The new count is echoed back only when this call actually incremented it,
  // so the caller enforcing the two-loop ceiling reads it straight off the
  // command that spent the loop rather than making a second `status --json`
  // round trip (and rather than counting in its own head, which a crash and
  // a `--resume` would reset). Every other stage call keeps the exact
  // two-key line it has always printed.
  console.log(JSON.stringify(fixLoop ? { id: itemId, stage, fixLoops: item.fixLoops } : { id: itemId, stage }))
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
  return stat.trim().startsWith('Z')
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
    process.kill(pid, 0)
  } catch (e) {
    return e.code !== 'ESRCH'
  }
  const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0 || !probe.stdout) return true
  return !isZombieStatState(probe.stdout)
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
  const text = fs.readFileSync(file, 'utf8')
  const completeLines = text.split('\n').slice(0, -1)
  for (const line of completeLines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event && event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
      return event.session_id
    }
  }
  return null
}

const WATCH_USAGE = 'usage: orchestrate.mjs watch <itemId> --pid <p> --jsonl <file> [--interval-ms 30000] [--budget-ms 540000]'

function cmdWatch(argv) {
  const itemId = argv[0]
  let pidArg
  let jsonlFile
  let intervalMs = 30_000
  let budgetMs = 540_000
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--pid') pidArg = argv[++i]
    else if (argv[i] === '--jsonl') jsonlFile = argv[++i]
    else if (argv[i] === '--interval-ms') intervalMs = Number(argv[++i])
    else if (argv[i] === '--budget-ms') budgetMs = Number(argv[++i])
  }

  if (!itemId || pidArg === undefined || jsonlFile === undefined) {
    throw new OrchestrateError(WATCH_USAGE, 1)
  }
  const pid = Number(pidArg)
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new OrchestrateError(`--pid must be a positive integer: ${pidArg}`, 1)
  }
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new OrchestrateError(`--interval-ms must be a positive integer: ${intervalMs}`, 1)
  }
  if (!Number.isInteger(budgetMs) || budgetMs <= 0) {
    throw new OrchestrateError(`--budget-ms must be a positive integer: ${budgetMs}`, 1)
  }

  const dir = projectDir(orchHome(), resolveProjectRoot())

  // Fail fast, before any sleeping happens: an unknown item (or no run at
  // all — readRun's own code-3 "no run exists") is a problem with THIS
  // call, independent of how long the loop below would otherwise run.
  findQueueItem(readRun(dir), itemId)

  let sessionId = null
  let elapsed = 0
  let checks = 0
  for (;;) {
    const jsonlExists = fs.existsSync(jsonlFile)
    let newlyFoundSessionId = null
    if (jsonlExists) {
      if (sessionId === null) {
        try {
          newlyFoundSessionId = findSessionIdInJsonl(jsonlFile)
        } catch (e) {
          // Anything but ENOENT here (existsSync above already ruled that
          // out) — e.g. `--jsonl` naming a directory — is the "parse
          // wedge" the exit-code contract names: fatal on whichever check
          // hits it, unlike a merely MISSING file below, which gets one
          // interval of grace.
          throw new OrchestrateError(`--jsonl ${jsonlFile}: could not be read (${e.message}) — this is a parse wedge, not a transient miss`, 1)
        }
        if (newlyFoundSessionId !== null) sessionId = newlyFoundSessionId
      }
    } else if (checks > 0) {
      throw new OrchestrateError(`--jsonl file not found after the first interval: ${jsonlFile}`, 1)
    }
    checks++

    // One read-modify-write per tick: the heartbeat's updatedAt bump and a
    // freshly-discovered session id (if any) land in the SAME write, via
    // applyQueueItemFields — the exact function `stage --session` itself
    // uses (see that function's own header comment for why that reuse
    // matters, not just that it is convenient).
    const run = readRun(dir)
    if (newlyFoundSessionId !== null) {
      applyQueueItemFields(findQueueItem(run, itemId), { session: newlyFoundSessionId })
    }
    run.updatedAt = nowISO()
    writeRunAtomic(dir, run)

    if (!pidAlive(pid)) return 0

    elapsed += intervalMs
    if (elapsed >= budgetMs) return 3

    sleepSync(intervalMs)
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
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return true
  return typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('pnpm')
}

// The "obvious" package.json scripts, in the fixed order the brief names:
// test, typecheck, build. Only scripts that actually exist are included —
// a project with just a `test` script gets exactly one command, never two
// more that are guaranteed to fail as "missing script."
function packageJsonVerifyCommands(cwd) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  const runner = isPnpmManaged(cwd, pkg) ? 'pnpm run' : 'npm run'
  return ['test', 'typecheck', 'build'].filter((name) => scripts[name] !== undefined).map((name) => `${runner} ${name}`)
}

// The item's own `## Done when` fenced commands, read from `cwd`'s copy of
// the item file (open/ or done/ — see findItemFilePath's own comment for
// why both are searched). A missing item file, or a body with no `## Done
// when` section at all, both resolve to "nothing extra" rather than an
// error — mirroring findUnresolvedCommands' own tolerant style in the gate
// section above.
function itemDoneWhenCommands(cwd, itemId) {
  const found = findItemFilePath(cwd, itemId)
  if (!found) return []
  const { body } = readItemForGate(found.path)
  const doneWhen = extractSection(body, 'Done when')
  if (doneWhen === undefined) return []
  return extractDoneWhenCommands(doneWhen)
}

// Base commands (verify.json's own `commands` array when it resolves to
// one, else the package.json fallback) unioned with the item's own
// Done-when commands, de-duplicated while preserving first-occurrence
// order — a Done-when block routinely repeats the project's own baseline
// command (`pnpm test` is the obvious one), and running the identical
// command twice would only double the wall-clock cost of every verify call
// for zero extra proof.
function resolveVerifyCommands(cwd, itemId) {
  let base
  const verifyJsonPath = path.join(cwd, 'backlog', 'verify.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(verifyJsonPath, 'utf8'))
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
      const badEntry = parsed.commands.find((c) => typeof c !== 'string')
      if (badEntry !== undefined) {
        throw new OrchestrateError(`${verifyJsonPath}: "commands" must be an array of strings, found ${JSON.stringify(badEntry)}`, 1)
      }
      base = parsed.commands
    } else {
      base = packageJsonVerifyCommands(cwd)
    }
  } catch (e) {
    // Our OWN deliberate throw above must escape this catch untouched — it
    // is not "verify.json doesn't parse," it is "verify.json parses fine
    // and is wrong," and those two need different outcomes (a clean error
    // vs. a silent fallback to package.json).
    if (e instanceof OrchestrateError) throw e
    // no backlog/verify.json here, or it doesn't parse at all — package.json
    // scripts is the only other place a baseline command can come from.
    base = packageJsonVerifyCommands(cwd)
  }

  const seen = new Set()
  const all = []
  for (const cmd of [...base, ...itemDoneWhenCommands(cwd, itemId)]) {
    if (seen.has(cmd)) continue
    seen.add(cmd)
    all.push(cmd)
  }
  return all
}

// 64 MiB, against Node's own 1 MiB default — see runVerifyCommand for the
// measured failure that number exists to prevent. Generous rather than
// unbounded on purpose: a bound this far past any real test suite's console
// output still stops a runaway command from taking this process's memory
// down with it, which `maxBuffer: Infinity` would not.
const VERIFY_MAX_BUFFER = 64 * 1024 * 1024

// "Last 20 lines" stops bounding anything when a command emits no newlines —
// a progress bar rewriting itself with \r, or a single enormous JSON blob, is
// ONE line, and with the buffer above raised to 64 MiB that one line could
// now be 64 MiB long in a file the board loads on every poll. So the row is
// clamped by characters as well as by lines, from the END (a failure's last
// words are the diagnostic ones). 8 KiB is roughly 20 lines of very long
// output — wide enough that no realistic 20-line tail is touched by this,
// narrow enough that run.json stays a state file rather than a log.
const VERIFY_TAIL_MAX_CHARS = 8 * 1024

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
  const result = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', maxBuffer: VERIFY_MAX_BUFFER })
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = combined.split('\n')
  const trimmedLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const tail = trimmedLines.slice(-20).join('\n').slice(-VERIFY_TAIL_MAX_CHARS)
  if (result.error) {
    const why = `could not run this command (${result.error.code ?? 'spawn failed'}): ${result.error.message}`
    return { cmd, ok: false, tail: tail === '' ? why : `${why}\n${tail}` }
  }
  return { cmd, ok: result.status === 0, tail }
}

const VERIFY_USAGE = 'usage: orchestrate.mjs verify <itemId> --cwd <dir> [--json]'

function cmdVerify(argv) {
  const itemId = argv[0]
  let cwd
  let json = false
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--cwd') cwd = argv[++i]
    else if (argv[i] === '--json') json = true
  }
  if (!itemId || cwd === undefined) {
    throw new OrchestrateError(VERIFY_USAGE, 1)
  }

  const dir = projectDir(orchHome(), resolveProjectRoot())
  // Validated here and the object then DISCARDED: no run at all (readRun's
  // code 3) and an unknown item id (findQueueItem's code 1) must both fail
  // before a single command is spawned, exactly like every other command in
  // this file — but nothing is held across the suite. See the re-read below
  // for why that distinction is not pedantry.
  findQueueItem(readRun(dir), itemId)

  const commands = resolveVerifyCommands(cwd, itemId)
  if (commands.length === 0) {
    // Exit 5: nothing this tool could find to prove the item works — no
    // backlog/verify.json, no package.json test/typecheck/build script, and
    // no fenced command under the item's own `## Done when`. Nothing is
    // written: an item that cannot prove itself has nothing to record, and
    // the caller (the orchestrator loop) parks it rather than merging code
    // nobody has verified — see the design spec's own "Verify" step.
    if (json) console.log(JSON.stringify([]))
    else console.log('nothing to verify: no backlog/verify.json, no package.json test/typecheck/build script, and no fenced command under ## Done when')
    return 5
  }

  // Every command runs regardless of an earlier one failing — a red first
  // command must never hide a second, independent failure. The overall
  // exit is 1 the moment any row is red, computed after every row has run.
  const rows = commands.map((cmd) => runVerifyCommand(cmd, cwd))

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
  const run = readRun(dir)
  const item = findQueueItem(run, itemId)
  item.verification = item.verification.concat(rows)
  run.updatedAt = nowISO()
  writeRunAtomic(dir, run)

  if (json) {
    console.log(JSON.stringify(rows))
  } else {
    for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.cmd}`)
  }
  return rows.every((row) => row.ok) ? 0 : 1
}

// --- reconcile ----------------------------------------------------------
// Read-only crash-recovery report: for every queue item still IN the
// pipeline (not one of the terminal stages below), compares the run file's
// own record against what is actually on disk/in git right now, and prints
// one of a fixed set of suggested next actions. Never writes run.json — a
// human, or the backlog-orchestrate skill's own `--resume` flow (Task 7),
// decides what to actually DO with each suggestion; this command's only job
// is to tell them accurately what it found.

// RunStage's own doc comment: "`merged` is the only success exit; `failed`,
// `skipped`, `needs-answers`, `ungroomed`, and `parked` are the five ways
// an item leaves the pipeline without merging." An item already in one of
// these six has already left the pipeline by definition — reconciling it
// against a possibly-gone worktree would tell a human nothing they don't
// already know from its stage alone.
const RECONCILE_TERMINAL_STAGES = new Set(['merged', 'failed', 'skipped', 'needs-answers', 'ungroomed', 'parked'])

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
  if (!worktreeExists && !itemBranchExists) return 'park'
  if (!worktreeExists) return 'inspect'
  if (marker) return sessionId ? 'resume-session' : 'redispatch-after-stop'
  return 'inspect'
}

function cmdReconcile(argv) {
  const json = argv.includes('--json')

  const projectRoot = resolveProjectRoot()
  const dir = projectDir(orchHome(), projectRoot)
  const run = readRun(dir) // never written back — see this function's own header comment

  const report = run.queue
    .filter((item) => !RECONCILE_TERMINAL_STAGES.has(item.stage))
    .map((item) => {
      const worktreeExists = !!item.worktree && fs.existsSync(item.worktree)
      const itemBranchExists = branchExists(projectRoot, item.branch)
      let itemFileLocation = null
      let started = false
      let marker = false
      if (worktreeExists) {
        const found = findItemFilePath(item.worktree, item.id)
        if (found) {
          itemFileLocation = `${found.section}/${found.state}`
          started = itemFrontmatterHasKey(found.path, 'started')
          marker = itemHasPhaseMarker(found.path)
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
        suggestion: suggestReconcileAction({ worktreeExists, itemBranchExists, marker, sessionId: item.sessionId }),
      }
    })

  if (json) {
    console.log(JSON.stringify(report))
  } else {
    for (const row of report) {
      console.log(
        `${row.id}  stage=${row.stage}  worktree=${row.worktreeExists}  branch=${row.branchExists}  ` +
          `marker=${row.marker}  session=${row.sessionId ?? '(none)'}  -> ${row.suggestion}`,
      )
    }
  }
  return 0
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
// This does NOT stop abort from finishing overall: every OTHER item's
// worktree and branch still get torn down, `run.status` still becomes
// `aborted`, and the run still ends — only the marked item's own git
// objects are skipped. Its attention entry names the exact worktree path
// and the exact `backlog.mjs stop <id>` command a human (or a resumed
// skill run — Task 7) needs, so nothing is left silently untracked either.
function cmdAbort() {
  const projectRoot = resolveProjectRoot()
  const dir = projectDir(orchHome(), projectRoot)
  const run = readRun(dir)

  const removedIds = []
  const preservedIds = []

  for (const item of run.queue) {
    let marker = false
    if (item.worktree && fs.existsSync(item.worktree)) {
      const found = findItemFilePath(item.worktree, item.id)
      marker = !!(found && itemHasPhaseMarker(found.path))
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
          `(\`git -C ${projectRoot} branch -D ${item.branch}\`) by hand or via a fresh abort.`,
      })
      preservedIds.push(item.id)
      continue
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
      spawnSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', item.worktree])
    }
    if (item.branch) {
      spawnSync('git', ['-C', projectRoot, 'branch', '-D', item.branch])
    }
    if (item.worktree || item.branch) removedIds.push(item.id)
  }

  run.updatedAt = nowISO()
  writeRunAtomic(dir, run)

  // A one-line human-readable summary, printed BEFORE cmdFinish's own
  // `{"status":"aborted"}` JSON line, so a human watching this run does not
  // have to separately run `status --json` and cross-reference `attention`
  // by hand just to learn what abort actually did.
  console.log(
    `abort: removed ${removedIds.length} item(s)${removedIds.length ? ` (${removedIds.join(', ')})` : ''}; ` +
      `left ${preservedIds.length} in place with an in-progress marker${preservedIds.length ? ` (${preservedIds.join(', ')} — see attention)` : ''}`,
  )

  return cmdFinish(['--status', 'aborted'])
}

const USAGE = `usage: orchestrate.mjs <command>

commands:
  init       create and lock a new run for a project
  plan       preview the gated queue init would build, without writing
  stage      move a queue item to a new stage
  heartbeat  re-stamp the run's updatedAt
  attention  record something a human should look at
  finish     set the run's final status
  status     print the current run
  watch      survive a long headless child across the loop's own Bash cap
  verify     run the project's proof commands and record them
  reconcile  read-only crash-recovery report
  abort      tear down worktrees/branches and end the run`

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
//      run state. Nothing is ever written when a command exits 1.
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
export function main(argv) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'init') return cmdInit(rest)
    if (cmd === 'plan') return cmdPlan(rest)
    if (cmd === 'stage') return cmdStage(rest)
    if (cmd === 'heartbeat') return cmdHeartbeat(rest)
    if (cmd === 'attention') return cmdAttention(rest)
    if (cmd === 'finish') return cmdFinish(rest)
    if (cmd === 'status') return cmdStatus(rest)
    if (cmd === 'watch') return cmdWatch(rest)
    if (cmd === 'verify') return cmdVerify(rest)
    if (cmd === 'reconcile') return cmdReconcile(rest)
    if (cmd === 'abort') return cmdAbort()
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
