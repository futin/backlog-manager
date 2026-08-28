#!/usr/bin/env node
// backlog: a repo-local bugs/ideas/tasks/out-of-scope store, driven from the
// CLI or from a skill. Lives under skills/backlog/tools/ of the backlog-manager
// plugin repo; nothing is installed into the repos it manages — the backlog/
// directory itself is the only thing that lands in a project.
//
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" init
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" root

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Section name -> id prefix. Fixed and exported so every later command (ids,
// board, move) keys off this one map instead of re-deriving prefixes.
export const SECTIONS = {
  bugs: 'bug',
  ideas: 'idea',
  tasks: 'task',
  'out-of-scope': 'oos',
}

// --- board registry ----------------------------------------------------------
// The board app in this repo reads ~/.backlog-manager/registry.json to know
// which projects have a backlog at all. This tool is that file's ONLY writer —
// the same one-writer invariant guide-manager keeps for its registry. `init`
// and `new` both upsert the current repo, so any project a capture ever
// touches appears on the board without a separate registration step.
//
// Upsert is keyed on the project's absolute root path (two checkouts of one
// repo are two projects); the name is the root's basename, refreshed on every
// upsert so a renamed directory heals itself; createdAt is set once, on first
// insert, and never rewritten.
export function registryFile() {
  return process.env.BM_REGISTRY_FILE || path.join(os.homedir(), '.backlog-manager', 'registry.json')
}

export function registerProject(root, file = registryFile()) {
  let registry = { projects: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(parsed.projects)) registry = parsed
  } catch {
    // first write, or a corrupt file — start fresh rather than fail the capture
  }
  const existing = registry.projects.find((p) => p.path === root)
  if (existing) {
    existing.name = path.basename(root)
  } else {
    registry.projects.push({ name: path.basename(root), path: root, createdAt: new Date().toISOString() })
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n')
}

// Registration must never fail the command that triggered it: a capture that
// exits non-zero because a dashboard's bookkeeping file was unwritable would
// teach people not to capture. stderr and move on.
function registerBestEffort(root) {
  try {
    registerProject(root)
  } catch (e) {
    console.error(`registry update failed (board will not list this project): ${e.message}`)
  }
}

// Carries the intended process exit code so `main` never has to re-classify
// an error after the fact: 1 usage error / unknown id / refused operation,
// 2 no .git ancestor, 3 no backlog/ store (message names `init`).
export class BacklogError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BacklogError'
    this.code = code
  }
}

// Walks up from `startDir` looking for a `.git` entry (a directory for a
// normal clone, a file for a worktree or submodule — existsSync covers
// both). Throws rather than falling back to `startDir` when none is found:
// a silent cwd-fallback here has twice made this kind of tool operate on
// the wrong project.
export function resolveRoot(startDir = process.cwd()) {
  const resolvedStart = path.resolve(startDir)
  let dir = resolvedStart
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return { root: dir, backlog: path.join(dir, 'backlog') }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new BacklogError(`no .git found in ${resolvedStart} or any parent directory`, 2)
    }
    dir = parent
  }
}

const DIACRITICS = /[\u0300-\u036f]/g
const NON_SLUG_RUN = /[^a-z0-9]+/g
const EDGE_DASHES = /^-+|-+$/g

// Lowercase, strip accents via NFD decomposition (so "Émigré" loses its
// combining marks instead of losing the letters under them), collapse every
// run of characters outside [a-z0-9] to one dash, then trim leading and
// trailing dashes. A title with no [a-z0-9] left over (e.g. "#$%") has no
// slug to give it — that is a usage error, not a silently-empty id.
export function slugify(title) {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(NON_SLUG_RUN, '-')
    .replace(EDGE_DASHES, '')
  if (slug === '') {
    throw new BacklogError(`title has no usable characters for a slug: ${JSON.stringify(title)}`, 1)
  }
  return slug
}

// The seven leaf directories the store is defined to have. out-of-scope is
// flat — items land there and stay there; bugs/ideas/tasks each split into
// open/done as items move through their lifecycle.
const LEAF_DIRS = [
  'bugs/open',
  'bugs/done',
  'ideas/open',
  'ideas/done',
  'tasks/open',
  'tasks/done',
  'out-of-scope',
]

const README_TEXT = `# Backlog

A lightweight, file-based backlog for this repo. Every item is a single
Markdown file living under one of the sections below. Bugs, ideas, and tasks
move from open/ to done/ as they are worked; out-of-scope holds items that
were considered and declined, and has no open/done split of its own. Each
section has a fixed id prefix used when naming its items.

| Section       | Prefix | Lifecycle     |
|---------------|--------|---------------|
| bugs          | bug    | open -> done  |
| ideas         | idea   | open -> done  |
| tasks         | task   | open -> done  |
| out-of-scope  | oos    | flat          |

An item's status is the directory it lives in, never a frontmatter key. The one
exception is not a status: a \`started: YYYY-MM-DD\` line means someone is working
that item right now. It is still an open item in \`<section>/open/\`; the date only
says when it was picked up. Set it with \`start <id>\`, clear it with \`stop <id>\`.
Archiving keeps it, so a done item records when the work began.
`

// Creates whatever is missing and returns only what it actually created, so
// a second run against an already-initialized store is silent and — this is
// the part that matters — never touches an existing README even if someone
// hand-edited it since.
export function init(backlog) {
  const created = []
  for (const rel of LEAF_DIRS) {
    const abs = path.join(backlog, rel)
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true })
      created.push(abs)
    }
  }
  const readme = path.join(backlog, 'README.md')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, README_TEXT)
    created.push(readme)
  }
  return created
}

// Frontmatter is a `key: value` line splitter, not a YAML subset: one fenced
// block of scalar lines between two `---` markers. `tags` is the one key
// that becomes a list, by splitting its scalar value on commas — it never
// gets array syntax of its own, precisely so this stays a line splitter
// instead of growing into a YAML parser. Every other key, known or not, is
// preserved as a trimmed string: Task 7 adds `promoted-to:` and `rejected:`
// keys this function has never heard of, and they must survive a round trip
// through parse + render untouched.
//
// A file's directory is its status (open/ vs done/ vs out-of-scope/), so a
// `status:` key in the frontmatter itself would be a second, competing
// source of truth. Reject it outright rather than silently ignoring or
// preserving it.
export function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') {
    throw new BacklogError('frontmatter must start with a --- line', 1)
  }

  const data = {}
  let i = 1
  for (; i < lines.length; i++) {
    if (lines[i] === '---') break
    const sep = lines[i].indexOf(':')
    if (sep === -1) continue
    const key = lines[i].slice(0, sep).trim()
    const value = lines[i].slice(sep + 1).trim()
    if (key === 'status') {
      throw new BacklogError('frontmatter must not carry a status: key — the directory a file lives in is its status', 1)
    }
    if (key === 'tags') {
      data.tags = value === '' ? [] : value.split(',').map((t) => t.trim()).filter((t) => t !== '')
    } else {
      data[key] = value
    }
  }
  if (i === lines.length) {
    throw new BacklogError('frontmatter has no closing --- line', 1)
  }
  if (!('tags' in data)) data.tags = []

  return { data, body: lines.slice(i + 1).join('\n') }
}

// The inverse of parseFrontmatter's `data`: renders just the fenced block (no
// body), so callers compose it with whatever body they have. `tags` is
// skipped entirely when empty — parseFrontmatter treats "no tags line" and
// an empty `tags:` line identically (both come back as `[]`), so omitting it
// loses nothing and keeps a tagless item's frontmatter free of a dangling
// `tags:` line.
//
// A value carrying a newline does not render one long line — it renders
// EXTRA frontmatter lines. A title of "Broken\nstatus: open" emits a real
// `status:` line, which parseFrontmatter then refuses outright: the item is
// captured and from that moment permanently unreadable. Refused here rather
// than stripped, because a truncated title is a different item than the
// caller asked for, filed under a name they never chose.
const FRONTMATTER_BREAK = /[\r\n]/

export function renderFrontmatter(data) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (key === 'tags' && value.length === 0) continue
    const scalar = key === 'tags' ? value.join(', ') : `${value}`
    if (FRONTMATTER_BREAK.test(scalar)) {
      throw new BacklogError(`${key} must not contain a newline or carriage return: ${JSON.stringify(scalar)}`, 1)
    }
    lines.push(`${key}: ${scalar}`)
  }
  lines.push('---')
  return lines.join('\n')
}

// Ids are per-section, max+1 across every place that section's own prefix
// can appear, never reused (gaps from done/deleted items are preserved
// rather than filled). For bugs/ideas/tasks that "every place" is THREE
// directories, not two: <section>/open/, <section>/done/, AND out-of-scope/
// — because a rejected item keeps its ORIGINAL id (a rejected bug-2 is
// still "bug-2"; see readItem/moveItem) and leaves bugs/ entirely without
// freeing that id. Skipping out-of-scope/ here would let a freshly captured
// item reuse a rejected one's id — two items answering to the same "bug-2",
// which is exactly what a rejected item keeping its id was meant to
// prevent, since that id may already be cited by a from: line or a commit
// message.
//
// out-of-scope's OWN id space (the oos- prefix, minted when a capture is
// rejected straight to out-of-scope with no section of its own) stays
// exactly as before: only its own out-of-scope/ directory, and only oos-
// prefixed names in it — never the bug-N/idea-N/task-N items also sitting
// there under their original section's prefix. out-of-scope/ is a graveyard
// holding dead items from every section; a section's id space includes its
// own dead, but the oos- space is only the items that were born dead. Same
// idPattern-per-directory loop below serves both cases — the asymmetry is
// entirely in which directories `dirs` lists.
//
// max+1 is computed per working tree, so two branches can each mint bug-7
// and merge cleanly — the filenames differ, so git sees no conflict. Nothing
// here can prevent that without coordination this store does not have; the
// collision is reported after the fact instead, by board — see readOpenItems.
export function nextId(backlog, section) {
  const prefix = SECTIONS[section]
  if (!prefix) {
    throw new BacklogError(`unknown section: ${section}`, 1)
  }
  const dirs = section === 'out-of-scope'
    ? [path.join(backlog, 'out-of-scope')]
    : [path.join(backlog, section, 'open'), path.join(backlog, section, 'done'), path.join(backlog, 'out-of-scope')]

  const idPattern = new RegExp(`^${prefix}-(\\d+)-`)
  let max = 0
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const m = idPattern.exec(name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  return max + 1
}

// Reverse of SECTIONS: id prefix -> section key. readItem uses this to know
// which section's open/done to check first from an id's own prefix — see
// the out-of-scope fallback below for why that is only a starting point.
const PREFIX_TO_SECTION = Object.fromEntries(
  Object.entries(SECTIONS).map(([section, prefix]) => [prefix, section])
)

// Finds the one file named `<id>-*.md` in a directory, or undefined if the
// directory doesn't exist or has no such file. Matching on `${id}-` (not
// just `id`) keeps bug-7 from matching bug-70-whatever.md, since bug-7's
// digits end exactly where the next `-` begins.
//
// That prefix match assumes its caller has already checked the id's SHAPE
// (see ID_SHAPE below): a bare `bug` reaching here matches `bug-` against
// every bug in the directory and hands back whichever readdirSync happened
// to list first — which is how `move bug done` once archived an item the
// caller never named.
function findItemFile(dir, id) {
  if (!fs.existsSync(dir)) return undefined
  const prefix = `${id}-`
  return fs.readdirSync(dir).find((name) => name.startsWith(prefix) && name.endsWith('.md'))
}

// Reads and parses one item file, folding the file's own absolute path into
// a malformed-frontmatter error's message. parseFrontmatter is a pure text
// function with no notion of "which file" — so without this, a caller many
// layers up (board, reading every open item at once) has no way to say
// which one was broken.
function readItemFile(absPath) {
  try {
    return parseFrontmatter(fs.readFileSync(absPath, 'utf8'))
  } catch (e) {
    if (!(e instanceof BacklogError)) throw e
    throw new BacklogError(`${absPath}: ${e.message}`, e.code)
  }
}

// Resolves an id to its current absolute path, section, and state. Checks
// <section>/open, then <section>/done, then out-of-scope last — a rejected
// item keeps its original id prefix (a rejected bug-7 is still "bug-7") but
// moves out of bugs/ entirely, so not finding it in bugs/open or bugs/done
// does not yet mean it doesn't exist. An oos-prefixed id has no open/done of
// its own and goes straight to that last step. The returned section/state
// reflect where the file actually lives rather than the id's prefix:
// out-of-scope is a section in its own right with a single terminal state,
// the same way bugs/ideas/tasks are each two states (open, done).
//
// Deliberately stops short of parsing the file. readItem (below) layers
// readItemFile's frontmatter parse on top of this for its own return value;
// moveItem calls this directly and never parses at all, because move only
// needs to know where a file currently lives and what directory to rename
// it into — a broken frontmatter block must not stand between an item and
// getting rejected into out-of-scope or closed out as done. Both callers
// get the same "unknown id" BacklogError, with the same message, for an id
// whose prefix names no section or whose file exists in none of the
// candidates below.
//
// An id is a section prefix AND a number, nothing else — validated here,
// before any directory is scanned, because findItemFile matches on `${id}-`
// and a bare `bug` therefore matches every bug in the directory (see its
// comment above). A bare prefix gets its own message: it is the likely typo,
// and the useful answer is the shape, not "unknown id".
const ID_SHAPE = /^([a-z]+)-(\d+)$/

function locateItem(backlog, id) {
  const shape = ID_SHAPE.exec(id)
  if (!shape) {
    if (PREFIX_TO_SECTION[id]) {
      throw new BacklogError(`${id} is a section prefix, not an id — did you mean ${id}-1?`, 1)
    }
    throw new BacklogError(`not an id: ${id} — an id is a section prefix and a number, e.g. bug-7`, 1)
  }

  const section = PREFIX_TO_SECTION[shape[1]]
  if (!section) {
    throw new BacklogError(`unknown id: ${id}`, 1)
  }

  const candidates = section === 'out-of-scope'
    ? [[path.join(backlog, 'out-of-scope'), 'out-of-scope', 'terminal']]
    : [
        [path.join(backlog, section, 'open'), section, 'open'],
        [path.join(backlog, section, 'done'), section, 'done'],
        [path.join(backlog, 'out-of-scope'), 'out-of-scope', 'terminal'],
      ]

  for (const [dir, itemSection, state] of candidates) {
    const filename = findItemFile(dir, id)
    if (filename) return { section: itemSection, state, path: path.join(dir, filename) }
  }

  throw new BacklogError(`unknown id: ${id}`, 1)
}

// Resolves an id to the single Item it names, via locateItem above, then
// layers readItemFile's frontmatter parse on top. See locateItem's own
// comment for the candidate-walk order and the unknown-id error the two
// functions share.
export function readItem(backlog, id) {
  const { section, state, path: absPath } = locateItem(backlog, id)
  const { data, body } = readItemFile(absPath)
  return {
    id,
    section,
    state,
    path: absPath,
    title: data.title,
    created: data.created,
    tags: data.tags,
    data,
    body,
  }
}

// bugs, ideas, tasks — the queue sections listOpen/board ever look at.
// out-of-scope has no open/done split and is not a queue (see LEAF_DIRS and
// README_TEXT above), so it is deliberately excluded here.
const QUEUE_SECTIONS = Object.keys(SECTIONS).filter((section) => section !== 'out-of-scope')

// Every item currently sitting in an open/ directory, across all three queue
// sections, in section order — each as its id plus the absolute path it was
// found at, not yet resolved to Items and not yet sorted by numeric id.
// Shared by listOpen (resolve every id or throw trying) and board's own
// tolerant read (resolve what it can, report the rest) below, so the two
// never drift on which files count as "open." The path rides along because
// board has to be able to name the second file when two of them claim the
// same id — see readOpenItems.
function openEntries(backlog) {
  const entries = []
  for (const section of QUEUE_SECTIONS) {
    const dir = path.join(backlog, section, 'open')
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const m = /^([a-z]+-\d+)-/.exec(name)
      if (m) entries.push({ id: m[1], path: path.join(dir, name) })
    }
  }
  return entries
}

// The fixed section order, then numeric id ascending within a section — the
// order both listOpen and board print in.
function compareOpenItems(a, b) {
  const sectionDelta = QUEUE_SECTIONS.indexOf(a.section) - QUEUE_SECTIONS.indexOf(b.section)
  if (sectionDelta !== 0) return sectionDelta
  return Number(a.id.split('-')[1]) - Number(b.id.split('-')[1])
}

// Every open item across bugs/ideas/tasks, sorted by the fixed section
// order and then by numeric id ascending within a section — the same order
// `board` prints in. All-or-nothing, like every other read in this file
// (readItem, nextId, parseFrontmatter): one malformed item throws, exactly
// as asking readItem for that id directly would. board deliberately uses
// readOpenItems below instead of this, precisely because it wants the
// other behaviour.
export function listOpen(backlog) {
  const items = openEntries(backlog).map(({ id }) => readItem(backlog, id))
  items.sort(compareOpenItems)
  return items
}

// Same scan as listOpen, but a malformed item is reported rather than
// fatal. board is the one command that reads every open item instead of a
// single named one, so it is the command most likely to meet a file some
// skill got wrong — and one bad fence should not blind it to the other
// nine items that are genuinely open. `problems` holds each failure's own
// message (already path-prefixed by readItemFile via readItem), in scan
// order.
//
// A duplicated id is reported through that same channel, for the same
// reason. Two branches can each mint bug-7 (nextId is max+1 per working
// tree) and merge without a conflict, because the two filenames differ.
// This function cannot undo that, and nothing here can prevent it — but
// every command that takes an id resolves the FIRST match, so the second
// file is unreachable while board would otherwise print its twin twice and
// call the store healthy. Naming it here means there is exactly one way
// this tool says "your store has a problem": items on stdout, problems on
// stderr, exit 1.
function readOpenItems(backlog) {
  const items = []
  const problems = []
  const firstPathById = new Map()
  for (const { id, path: itemPath } of openEntries(backlog)) {
    const firstPath = firstPathById.get(id)
    if (firstPath !== undefined) {
      problems.push(`${itemPath}: duplicate id ${id} — ${firstPath} already holds it, so this file is unreachable by show and move`)
      continue
    }
    firstPathById.set(id, itemPath)
    try {
      items.push(readItem(backlog, id))
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      problems.push(e.message)
    }
  }
  items.sort(compareOpenItems)
  return { items, problems }
}

const MOVE_DESTS = ['done', 'out-of-scope']

// Renames an item's file into `dest`'s directory and returns the new
// absolute path. File content is never read or rewritten — renameSync moves
// the same bytes, so this is byte-for-byte a no-op on content by
// construction — and the filename (hence the id) never changes: a rejected
// bug-7 stays bug-7-<slug>.md inside out-of-scope/, because bug-7 may
// already be cited by a from: line or a commit message elsewhere. Only two
// transitions are ever refused (both BacklogError, code 1): an item already
// in out-of-scope moved anywhere at all (rejection is terminal), and an
// item already done moved to done again. Everything else goes through —
// including rejecting a done item — because out-of-scope is meant to be
// reachable from any section.
//
// A third refusal covers the destination itself: renameSync silently
// overwrites whatever is already at destPath, so moving bug-7 into a done/
// that already holds a file of that exact name destroys that file — which
// in practice means destroying the `## Outcome` recording how the work was
// verified. (Two branches that each minted bug-7 under the same title merge
// cleanly into exactly this state.) "move never rewrites an item's content"
// only means anything if it also means "and never destroys another item's",
// so an occupied destination is refused, named, and left alone.
//
// dest's own directory is recreated with mkdirSync if a partially-scaffolded
// store is missing it, rather than failing: a missing done/ under an
// initialized store is a repair, not a fatal error.
export function moveItem(backlog, id, dest) {
  if (!MOVE_DESTS.includes(dest)) {
    throw new BacklogError(`unknown destination: ${dest} (expected done or out-of-scope)`, 1)
  }

  const item = locateItem(backlog, id)

  if (item.state === 'terminal') {
    throw new BacklogError(`${id} is already out-of-scope — rejection is terminal`, 1)
  }
  if (item.state === 'done' && dest === 'done') {
    throw new BacklogError(`${id} is already done`, 1)
  }

  const destDir = dest === 'out-of-scope'
    ? path.join(backlog, 'out-of-scope')
    : path.join(backlog, item.section, 'done')
  fs.mkdirSync(destDir, { recursive: true })

  const destPath = path.join(destDir, path.basename(item.path))
  if (fs.existsSync(destPath)) {
    throw new BacklogError(`refusing to move ${id}: ${destPath} already exists`, 1)
  }
  fs.renameSync(item.path, destPath)
  return destPath
}

// --- in progress -------------------------------------------------------------
// `started` is the one lifecycle key an item's frontmatter is allowed to
// carry, and it is deliberately NOT a status. The directory still answers
// "where is this item in its lifecycle" — open, done, out-of-scope — and
// parseFrontmatter's outright refusal of a `status:` key stands untouched,
// because a second answer to THAT question is the competing source of truth
// the ban exists to prevent. `started` answers a different question: is
// someone on this right now. An item with a started date is still an open
// item; nothing about where its file lives changes.
//
// Storing it instead of deriving it (the way `groomed` is derived from the
// body) is forced: nothing inside a file can imply that a human picked it up
// five minutes ago. The value is a UTC timestamp rather than a boolean so the
// board and the card can age it — "in progress for eleven days" and "in
// progress for twenty minutes" are the signals worth surfacing, and a bare
// `true` cannot carry either.
//
// Files stamped before this wrote a time carry a bare `YYYY-MM-DD`, and nothing
// here rewrites an existing item's frontmatter, so both shapes are on disk
// permanently. Every reader accepts both; the client ages a bare date in days
// only, since UTC midnight is not the hour anyone started work.
//
// These two commands are the only ones that rewrite an EXISTING item's
// content: `new` writes a file that did not exist yet, and `move` renames
// without ever opening one. Both go through parseFrontmatter →
// renderFrontmatter, which round-trips unknown keys (`from:`, `promoted-to:`)
// by construction, and both re-attach the body as the exact string
// parseFrontmatter handed back — so the only bytes that can differ afterwards
// are inside the fence.
function writeItemFile(absPath, data, body) {
  fs.writeFileSync(absPath, `${renderFrontmatter(data)}\n${body}`)
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

// The stamp `start` writes: second-precision UTC ISO-8601. Milliseconds are
// sliced off rather than kept — nothing needs sub-second resolution, and three
// extra digits in a line a human reads are noise. UTC rather than local time
// for the reason ageDaysSince parses in UTC: the value is compared against
// `Date.now()` on whatever machine renders the board, and a local-time stamp
// would read hours off for anyone in another zone.
//
// A timestamp rather than todayISO()'s bare date because the useful resolution
// for "is anyone on this right now" is minutes and hours. A session started
// this morning and one started ninety seconds ago were both `0d` under a date,
// which is the one answer that made the marker worth ignoring.
function nowISO() {
  return `${new Date().toISOString().slice(0, 19)}Z`
}

// Refuses in the two cases the lifecycle makes meaningless, each with its
// own message rather than one shared "cannot start": done and out-of-scope
// have no work left to pick up. An idea carries no such refusal — grooming
// one (promoting it to a task, or rejecting it outright) is itself the
// active work a started: marker exists to describe, and backlog-groom is
// the skill that now owns clearing it again: start on the way in, stop on
// the way out.
//
// Starting an already-started item is refused rather than re-stamped: a
// second `start` is almost always a re-run, and silently moving the stamp
// forward would erase exactly the "this has been open for eleven days"
// signal the stamp exists to provide. The refusal names the value already
// there — in whichever of the two shapes it is — so the caller can see what
// it would have overwritten.
export function startItem(backlog, id, stamp = nowISO()) {
  const item = locateItem(backlog, id)

  if (item.state === 'terminal') {
    throw new BacklogError(`${id} is out of scope — nothing to start`, 1)
  }
  if (item.state === 'done') {
    throw new BacklogError(`${id} is done — nothing to start`, 1)
  }

  const { data, body } = readItemFile(item.path)
  if (data.started) {
    throw new BacklogError(`${id} is already in progress (started ${data.started})`, 1)
  }

  writeItemFile(item.path, { ...data, started: stamp }, body)
  return item.path
}

// Deliberately permissive about WHERE the item is, unlike startItem: the one
// thing stop is for is clearing a marker, and a stale `started` on an
// archived item is precisely a marker worth being able to clear. Only
// "there is nothing to clear" is refused.
export function stopItem(backlog, id) {
  const item = locateItem(backlog, id)

  const { data, body } = readItemFile(item.path)
  if (!data.started) {
    throw new BacklogError(`${id} is not in progress`, 1)
  }

  const { started, ...rest } = data
  writeItemFile(item.path, rest, body)
  return item.path
}

// Resolves the repo root for a CLI command and turns a BacklogError into the
// stderr message + exit code every command reports it with, so `root` and
// `init` below — and every command tasks 2-4 add — share this one place
// instead of each carrying its own copy of the try/catch.
//
// This resolves the root ONLY; it does not require backlog/ to already
// exist, because creating that store is `init`'s entire job. A command that
// DOES require an existing store (board/show/move, from Task 3 on) needs a
// second, separate check layered on top of this function's result — e.g. a
// requireBacklog() that calls this, then additionally checks fs.existsSync
// on the resolved backlog/ path and fails with code 3 if it's missing. That
// belongs to Task 3, not here: this function deliberately stays root-only
// and takes no flag for it, so adding that second check never means editing
// this one or its call sites below.
function resolveRootOrFail() {
  try {
    return { ok: true, resolved: resolveRoot() }
  } catch (e) {
    if (!(e instanceof BacklogError)) throw e
    console.error(e.message)
    return { ok: false, code: e.code }
  }
}

// The second, separate check resolveRootOrFail's own doc comment calls for:
// board/show (and move, later) all need an existing store, not just a
// resolvable root. Deliberately layered on top rather than folded into
// resolveRootOrFail, so that function and its two existing call sites
// (root, new) never change.
function requireBacklog() {
  const r = resolveRootOrFail()
  if (!r.ok) return r
  if (!fs.existsSync(r.resolved.backlog)) {
    console.error(`no backlog/ store in ${r.resolved.root} — run \`backlog.mjs init\` first`)
    return { ok: false, code: 3 }
  }
  return r
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Whole days from a `created` date (YYYY-MM-DD, always written in UTC by
// `new`) to right now, floored and never negative. Parsed as explicit UTC
// midnight so this gives the same answer regardless of the machine's local
// timezone.
function ageDaysSince(created) {
  const then = Date.parse(`${created}T00:00:00Z`)
  return Math.max(0, Math.floor((Date.now() - then) / MS_PER_DAY))
}

// The frontmatter block exactly as written on disk, for `show`'s "verbatim"
// promise. renderFrontmatter re-serializes from parsed data — same keys,
// but not guaranteed byte-identical to what is actually in the file (key
// order, spacing) — so this re-slices the raw text instead. Safe to assume
// a closing --- exists: callers only reach this after readItem has already
// parsed this same file successfully.
function frontmatterBlock(rawText) {
  const lines = rawText.split('\n')
  let i = 1
  while (lines[i] !== '---') i++
  return lines.slice(0, i + 1).join('\n')
}

const USAGE = `usage: backlog.mjs <command>

commands:
  init   create the backlog/ store in the current repo
  root   print the resolved backlog/ directory
  new    print a new item's path and frontmatter (writes nothing)
  board  print the board of open items (bugs, ideas, tasks)
  show   print an item's absolute path and frontmatter
  move   move an item into done or out-of-scope
  start  mark an open bug or task as in progress
  stop   clear the in-progress marker`

const NEW_USAGE = `usage: backlog.mjs new <section> <title> [--from <id>]

sections: bugs, ideas, tasks, out-of-scope`

const BOARD_USAGE = `usage: backlog.mjs board [--section <bugs|ideas|tasks>] [--json]`

const SHOW_USAGE = `usage: backlog.mjs show <id>`

const MOVE_USAGE = `usage: backlog.mjs move <id> done|out-of-scope`

// One constant for both verbs: they are a pair, and someone who mistyped one
// of them is the person most likely to want the other named right there.
const START_STOP_USAGE = `usage: backlog.mjs start <id>
       backlog.mjs stop <id>`

export function main(argv) {
  const [cmd] = argv

  if (cmd === 'root') {
    const r = resolveRootOrFail()
    if (!r.ok) return r.code
    console.log(r.resolved.backlog)
    return 0
  }

  if (cmd === 'init') {
    const r = resolveRootOrFail()
    if (!r.ok) return r.code
    const created = init(r.resolved.backlog)
    if (created.length === 0) {
      console.log(`already initialized: ${r.resolved.backlog}`)
    } else {
      console.log(`initialized ${r.resolved.backlog}`)
      for (const p of created) console.log(`  created ${p}`)
    }
    registerBestEffort(r.resolved.root)
    return 0
  }

  // `new` only ever prints the path + frontmatter a caller (the skill) is
  // meant to write — it never touches disk itself. That is what keeps
  // decisions like "does this need a body template" in the skill's prose
  // instead of hardcoded here. It deliberately calls resolveRootOrFail (not
  // a store-existence check): a store made only of open/ and done/
  // directories is exactly what `new` needs, and requiring `init` to have
  // run first would make this command depend on Task 3's exit-3 path for no
  // reason of its own.
  if (cmd === 'new') {
    const section = argv[1]
    const title = argv[2]
    if (!section || !title || !(section in SECTIONS)) {
      console.error(NEW_USAGE)
      return 1
    }

    let from
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === '--from') {
        from = argv[i + 1]
        i++
      }
    }

    const r = resolveRootOrFail()
    if (!r.ok) return r.code

    let fullId, filename
    try {
      const n = nextId(r.resolved.backlog, section)
      fullId = `${SECTIONS[section]}-${n}`
      filename = `${fullId}-${slugify(title)}.md`
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }

    const dir = section === 'out-of-scope'
      ? path.join(r.resolved.backlog, 'out-of-scope')
      : path.join(r.resolved.backlog, section, 'open')
    const absPath = path.join(dir, filename)

    const data = { id: fullId, title, created: new Date().toISOString().slice(0, 10) }
    if (from) data.from = from

    // Rendered before anything is printed, so a title or a --from value
    // carrying a newline — which renderFrontmatter refuses, since it would
    // emit extra frontmatter lines — fails with an empty stdout instead of a
    // path followed by an error.
    let block
    try {
      block = renderFrontmatter(data)
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }

    console.log(absPath)
    console.log(block)
    registerBestEffort(r.resolved.root)
    return 0
  }

  // Column widths (id, age) are computed once across whatever set is
  // actually being printed — the full open list, or just the --section
  // slice of it — so a short id/age in one section still lines up under a
  // longer one elsewhere on the same board.
  if (cmd === 'board') {
    let sectionFlag
    let json = false
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--section') {
        sectionFlag = argv[i + 1]
        i++
      } else if (argv[i] === '--json') {
        json = true
      }
    }
    if (sectionFlag !== undefined && !QUEUE_SECTIONS.includes(sectionFlag)) {
      console.error(`${BOARD_USAGE}\n\nunknown section: ${sectionFlag}`)
      return 1
    }

    const r = requireBacklog()
    if (!r.ok) return r.code

    // Tolerant on purpose (see readOpenItems): a malformed item is reported
    // on stderr rather than aborting the whole board, so it never hides the
    // items that ARE readable. `problems` is checked once at the very end,
    // after whatever output below could still be produced.
    const { items: openItems, problems } = readOpenItems(r.resolved.backlog)
    let items = openItems.map((item) => ({ ...item, ageDays: ageDaysSince(item.created), started: item.data.started ?? '' }))
    if (sectionFlag !== undefined) {
      items = items.filter((item) => item.section === sectionFlag)
    }

    if (json) {
      console.log(JSON.stringify(items.map(({ id, section, title, created, ageDays, started, path: itemPath }) => (
        { id, section, title, created, ageDays, started, path: itemPath }
      ))))
    } else {
      const idWidth = Math.max(0, ...items.map((item) => item.id.length))
      const ageWidth = Math.max(0, ...items.map((item) => `${item.ageDays}d`.length))
      // The in-progress column appears only when something on this board is
      // actually in progress, which keeps every unstarted board — the common
      // case, and the one the `backlog` skill prints to a human — byte-identical
      // to what it printed before the column existed. Computed over the same
      // post---section set the widths above are, so a --section slice never
      // indents for work happening in a section it isn't showing.
      const wipWidth = items.some((item) => item.started !== '') ? 2 : 0
      const sectionsToPrint = sectionFlag !== undefined ? [sectionFlag] : QUEUE_SECTIONS
      for (const s of sectionsToPrint) {
        const sectionItems = items.filter((item) => item.section === s)
        console.log(`${s} (${sectionItems.length} open)`)
        for (const item of sectionItems) {
          const idCol = item.id.padEnd(idWidth)
          const ageCol = `${item.ageDays}d`.padEnd(ageWidth)
          const wipCol = (item.started === '' ? '' : '»').padEnd(wipWidth)
          console.log(`  ${idCol}  ${ageCol}  ${wipCol}${item.title}`)
        }
      }
    }

    for (const problem of problems) console.error(problem)
    return problems.length === 0 ? 0 : 1
  }

  // Resolves in open/, done/, and out-of-scope/ alike (see readItem) —
  // "where is this item" is exactly the question asked about a finished one.
  if (cmd === 'show') {
    const id = argv[1]
    if (!id) {
      console.error(SHOW_USAGE)
      return 1
    }

    const r = requireBacklog()
    if (!r.ok) return r.code

    let item
    try {
      item = readItem(r.resolved.backlog, id)
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }

    console.log(item.path)
    console.log(frontmatterBlock(fs.readFileSync(item.path, 'utf8')))
    return 0
  }

  // Destination is validated before requireBacklog, the same order new uses
  // for its section check and board uses for its --section check: an
  // unrecognized destination is a usage error, not something that needs a
  // resolved store to diagnose.
  if (cmd === 'move') {
    const id = argv[1]
    const dest = argv[2]
    if (!id || !MOVE_DESTS.includes(dest)) {
      console.error(MOVE_USAGE)
      return 1
    }

    const r = requireBacklog()
    if (!r.ok) return r.code

    let newPath
    try {
      newPath = moveItem(r.resolved.backlog, id, dest)
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }

    console.log(newPath)
    return 0
  }

  // start and stop share one block: the only thing that differs is which
  // function runs, and duplicating the id check, the store check, and the
  // error-to-exit-code funnel twice over would be three chances for them to
  // drift apart. Both print the item's path on success — unchanged, unlike
  // move's, but it is what a skill needs next in order to read the file.
  if (cmd === 'start' || cmd === 'stop') {
    const id = argv[1]
    if (!id) {
      console.error(START_STOP_USAGE)
      return 1
    }

    const r = requireBacklog()
    if (!r.ok) return r.code

    let itemPath
    try {
      itemPath = cmd === 'start'
        ? startItem(r.resolved.backlog, id)
        : stopItem(r.resolved.backlog, id)
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }

    console.log(itemPath)
    return 0
  }

  console.error(`unknown command: ${cmd ?? '(none)'}\n\n${USAGE}`)
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
