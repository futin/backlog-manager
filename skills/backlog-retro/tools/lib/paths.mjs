// Where backlog-retro reads from, and the one directory it writes to.
//
// Every function here is a second copy of something another file in this
// repository already has. That is deliberate and it is the rule, not an
// oversight: a plugin skill's `tools/` may never import another skill's
// `tools/` (CLAUDE.md Invariants) — an install is a copy of whatever
// shipped, and a prune of one skill must never break another — and neither
// may import from the server. So `orchHome()` and `projectDir()` exist here
// AND in `skills/backlog-orchestrate/tools/orchestrate.mjs` AND in
// `server/src/orchestrator/`, each with a comment naming its twins.
//
// The four homes are all env-overridable for one reason: a test process
// must never be able to read, and `record` must never be able to write,
// a real machine's state.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Twin: orchestrate.mjs's `orchHome()` and the server's own copy in
// server/src/orchestrator/. Read-only from here — this tool never writes a
// byte under the run-state directory (spec §3.6).
export function orchHome() {
  return process.env.BM_ORCH_HOME || path.join(os.homedir(), '.backlog-manager', 'orchestrator')
}

// The one directory this tool owns, and `record` is its only writer — the
// same relationship `registry.json` has with backlog.mjs and `run.json`
// has with orchestrate.mjs. `sweep` opens it read-only, for deltas.
export function retroHome() {
  return process.env.BM_RETRO_HOME || path.join(os.homedir(), '.backlog-manager', 'retro')
}

// Twin: backlog.mjs's registry path. Read-only, and only ever to put a
// human-readable name beside a project path in the report.
export function registryFile() {
  return process.env.BM_REGISTRY_FILE || path.join(os.homedir(), '.backlog-manager', 'registry.json')
}

// Claude Code's own transcript root. The ONLY transcript this tool opens is
// a run's driver, by the session id the run file recorded (spec §3.6);
// execute transcripts are a non-goal — their headless logs already carry
// cost.
export function claudeProjectsRoot() {
  return process.env.BM_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects')
}

// Twin: orchestrate.mjs's `projectDir()`. encodeURIComponent turns every
// `/` into `%2F`, which is what makes an absolute path safe as a single
// path SEGMENT — `path.join` of the raw path would recreate the project's
// whole directory tree under `root` instead.
export function projectDir(root, project) {
  return path.join(root, encodeURIComponent(project))
}

// The inverse, so a run-state directory whose project is not registered is
// still swept and labelled by its decoded path rather than skipped.
// Returns null for a name that is not a valid encoding at all, because a
// stray directory under the home must not throw the sweep.
export function decodeProjectDir(name) {
  try {
    return decodeURIComponent(name)
  } catch {
    return null
  }
}

// Claude Code's own key for a project's transcript directory: the absolute
// path with every `/` and `.` replaced by `-`. Both replacements matter —
// a linked worktree lives under `.worktrees/`, whose leading dot becomes
// the second dash in `…--worktrees-bug-26`. Derived from the two spellings
// observed on this machine rather than from documentation, so if Claude
// Code's own scheme ever changes this is the one line to correct.
export function claudeProjectKey(absPath) {
  return absPath.replace(/[/.]/g, '-')
}

// path -> name, for every registered project. A missing, unreadable or
// unparsable registry yields an EMPTY MAP rather than an error: the names
// are decoration, and a broken registry must never stop a sweep that has
// perfectly good run state to report.
export function readRegistryNames(file) {
  const names = new Map()
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return names
  }
  if (!parsed || !Array.isArray(parsed.projects)) return names
  for (const entry of parsed.projects) {
    if (entry && typeof entry.path === 'string' && typeof entry.name === 'string') {
      names.set(entry.path, entry.name)
    }
  }
  return names
}

// Every directory under one project's run state that may hold sidecars —
// `logs/`, `reviews/`, `verify/`, `questions/`, `prompts/`.
//
// There are two, and the spec this tool was written from only knew about
// one. task-31 ("a run's sidecars are archived beside its run file") landed
// between the design and this build: `init` now moves the accumulated
// sidecar directories into `runs/<archiveStem>/` beside the run file it
// archives. So a sweep that read only the project directory's own `logs/`
// would see the CURRENT run's sessions and nothing else — on this machine,
// 36 of 116 logs.
//
// Note what an archive directory is NOT: it is not "that run's sessions".
// The move sweeps whatever had accumulated flat, which for the first
// archive after task-31 was 74 logs belonging to a dozen runs. So the
// archive stem is a STORAGE location and never an attribution; sessions and
// reviews are still joined to items by `(project, itemId)` exactly as the
// spec specifies, and the `collision` caveat still reports an item that two
// runs dispatched.
//
// Ordered project-directory-first so a caller that de-duplicates by
// basename prefers the live run's copy.
export function sidecarRoots(projectDirPath) {
  const roots = [projectDirPath]
  const runsDir = path.join(projectDirPath, 'runs')
  let entries
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
  } catch {
    return roots
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) roots.push(path.join(runsDir, entry.name))
  }
  return roots
}

// Every `<root>/<sub>/<file>` across `sidecarRoots`, as
// `{ file, rel }` — `rel` being the path relative to the PROJECT directory
// (`logs/bug-1.jsonl`, `runs/run-…/logs/bug-1.jsonl`). The relative path is
// what keys a session, because two archives can each hold a `bug-1.jsonl`
// and a bare basename would collapse them into one row.
export function sidecarFiles(projectDirPath, sub, predicate) {
  const found = []
  for (const root of sidecarRoots(projectDirPath)) {
    const dir = path.join(root, sub)
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue
      if (predicate && !predicate(entry.name)) continue
      const file = path.join(dir, entry.name)
      found.push({ file, rel: path.relative(projectDirPath, file), name: entry.name })
    }
  }
  return found
}
