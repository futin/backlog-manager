#!/usr/bin/env node
// backlog: a repo-local bugs/ideas/tasks/refactors/out-of-scope store, driven
// from the CLI or from a skill. Lives under skills/backlog/tools/ of the backlog-manager
// plugin repo; nothing is installed into the repos it manages — the backlog/
// directory itself is the only thing that lands in a project.
//
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" init
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" root

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// `connect` asks git for the origin remote rather than hand-parsing `.git/config`, and spawnSync is the only way to do that. It is SYNCHRONOUS on purpose:
// see this file's closing entry-guard comment for why nothing here may hold the event loop open, and CLAUDE.md's "all three skill CLIs exit through
// process.exitCode" invariant, which names `spawnSync` children as one of the three shapes that stay safe under that rule (a spawnSync child is reaped before
// the call returns, so it never keeps a handle open past main()).
import { spawnSync } from 'node:child_process'

// `import`'s text half (task-50), in a module of its own so each transformation is provable from a table rather than through a fake API and a git fixture. One
// direction only: `import-lib.mjs` imports nothing from this file, and nothing from node at all.
import {
  IMPORT_BODY_CAP,
  splitOutcome,
  renderImportFooter,
  parseImportFooter,
  blobLink,
  fitBody,
  rewriteOldIds,
  importOrder,
  countersOf,
} from './import-lib.mjs'

// Section name -> id prefix. Fixed and exported so every later command (ids,
// board, move) keys off this one map instead of re-deriving prefixes.
export const SECTIONS = {
  bugs: 'bug',
  ideas: 'idea',
  tasks: 'task',
  // `ref`, not `refactor`: the board card's meta line is nowrap-with-ellipsis
  // in roughly 118px at real column width, and `refactor-12` does not fit
  // beside a date there — it renders as `refactor-1…` and names nothing. The
  // prefix is load-bearing UI, not just a namespace.
  //
  // Refactors are their own section rather than a flavour of idea because the
  // distinction is real: ideas are NEW (a feature, an optimisation); refactors
  // are EXISTING things that should be improved — not new, not broken, so
  // neither an idea nor a bug.
  refactors: 'ref',
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

// The registry's only removal path, and the exact counterpart to
// registerProject's upsert: same file, same single writer, same raw
// absolute-path key. Returns true when an entry was removed, false when the
// path was not registered at all.
//
// Removal exists because the upsert has no undo and this tool is the registry's
// ONLY writer (CLAUDE.md's hard invariant), so the repair for an entry that
// should never have been written has to live here too — not in the server,
// which is read-only over this file by the same invariant, and not in a text
// editor, which is not a path anything can test. bug-17 is what made that
// concrete: a per-item worktree registered as a phantom project, still on the
// board after the directory it named was gone.
//
// Keyed on an exact string compare against `path`, deliberately not a realpath
// and not a basename match: that is precisely how registerProject keys its
// upsert, and a removal that resolved paths differently from the insert could
// delete an entry the caller never named. It also means an entry pointing at a
// directory that no longer exists — the common case, since a worktree is
// deleted the moment its item merges — is still removable.
//
// An unreadable or corrupt registry is `false`, not a throw: there is nothing
// to remove from a file that holds no entries this function can see, and the
// caller's "not registered" message says exactly that.
export function unregisterProject(root, file = registryFile()) {
  let registry
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  if (!Array.isArray(registry.projects)) return false

  const remaining = registry.projects.filter((p) => p.path !== root)
  if (remaining.length === registry.projects.length) return false

  // Assigning back into the parsed object rather than writing a fresh
  // `{ projects }` keeps any other top-level key a future version of the file
  // might carry, exactly as registerProject's own read-modify-write does.
  registry.projects = remaining
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n')
  return true
}

// Is `dir` the top of a LINKED GIT WORKTREE? Returns a
// `{ worktree, gitdir, projectRoot }` description if so, or null for anything
// else — an ordinary clone, a main working tree, a submodule working tree, or a
// directory with no `.git` at all.
//
// This is the SECOND copy of this function in the plugin; the first is
// `linkedWorktreeInfo` in skills/backlog-orchestrate/tools/orchestrate.mjs,
// where it backs that tool's refusal to run from inside a worktree at all.
// Duplicated rather than imported for the reason that file's header states:
// plugin skill directories are installed as independent copies of whatever
// shipped at sync time, and a later prune of one skill's tools/ must never
// break another's — so one skill's tool may never import another's. The two
// copies must stay behaviourally identical; a change to git's own layout
// invalidates both at once, and both suites build a real submodule so it fails
// loudly in both places rather than quietly in one.
//
// The whole discriminator is what `<dir>/.git` IS, and it takes two small reads
// rather than a `git rev-parse` subprocess:
//
//   - a DIRECTORY — ordinary clone or main tree. Not a worktree.
//   - a FILE whose `gitdir:` target contains a `commondir` entry — a linked
//     worktree. This is the case the registry must never key on.
//   - a FILE whose target has NO `commondir` — a submodule working tree. Not a
//     worktree, and registering it under its own path is the correct answer.
//
// That last case is why "`.git` is a file" is not on its own a sufficient test,
// and it is the reason this discriminator exists here at all rather than a
// cheap statSync in registryRoot below: resolveRoot's own comment says its
// existsSync covers "a directory for a normal clone, a file for a worktree or
// submodule", which is exactly right for finding a backlog/ store and exactly
// wrong for deciding what to write into the registry. The distinction was
// verified against real git plumbing rather than assumed: a worktree gitdir
// (`<main>/.git/worktrees/<name>`) carries `HEAD commondir gitdir index logs
// refs`, a submodule gitdir (`<super>/.git/modules/<name>`) carries `HEAD
// config description hooks index info logs objects packed-refs refs`.
// `commondir` is present in exactly one of them.
//
// Both pointers can be relative, and both are resolved against the right base:
// the `.git` file's `gitdir:` against the directory holding that file (a
// submodule's is written relative, and git can be configured to write relative
// worktree pointers too), and `commondir` against the gitdir itself (`../..` in
// practice). `projectRoot` — the main working tree, i.e. the common git dir's
// parent — is best-effort and may come back null: a bare main repo has no
// working tree to name.
export function linkedWorktreeInfo(dir) {
  const gitEntry = path.join(dir, '.git')
  let stat
  try {
    stat = fs.statSync(gitEntry)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  let pointer
  try {
    pointer = fs.readFileSync(gitEntry, 'utf8')
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
  if (!match) return null
  const gitdir = path.resolve(dir, match[1])

  let commonRaw
  try {
    commonRaw = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()
  } catch {
    // No commondir — a submodule (or a gitdir this process cannot read, in
    // which case rewriting the registry on a guess would be worse than the
    // status quo).
    return null
  }
  const commonDir = path.resolve(gitdir, commonRaw)

  // The main tree is the common git dir's parent, but only when that common dir
  // actually IS a `.git` directory inside a working tree. A bare main repo's
  // common dir is the repository itself (`/srv/foo.git`), whose parent is not a
  // checkout of anything.
  let projectRoot = null
  if (path.basename(commonDir) === '.git') {
    try {
      if (fs.statSync(commonDir).isDirectory()) projectRoot = path.dirname(commonDir)
    } catch {
      projectRoot = null
    }
  }

  return { worktree: dir, gitdir, projectRoot }
}

// Maps a root resolved by `resolveRoot` onto the path that belongs in the
// registry, or null for "register nothing".
//
// These are the same path in every ordinary case and differ in exactly one,
// which is bug-17: a per-item orchestrator worktree got registered as a
// standalone project — `.worktrees/bug-13`, name "bug-13" — a phantom sixth
// project on the board that outlived the worktree itself, since a worktree is
// deleted the moment its item merges.
//
// resolveRoot is not at fault and is deliberately unchanged: an execute session
// running inside a worktree MUST resolve backlog/ to that worktree's own copy,
// which is the whole reason its walk accepts a `.git` file. The registry is the
// one consumer of that root for which the worktree is the wrong answer — it
// stores absolute host paths that the board, the item-body allowlist and the
// orchestrator all key on — so the mapping lives at this seam alone rather than
// in the walk every other command shares.
//
// The main tree is the answer rather than a flat refusal because the worktree's
// items merge back into it: the main tree IS the project this capture belongs
// to, and it is almost always already registered, so the upsert degrades to a
// harmless name refresh. Null is reserved for the one case where no main-tree
// path can be named at all (a bare main repo), where refusing to write beats
// inventing a path nothing else will ever read.
export function registryRoot(root) {
  const worktree = linkedWorktreeInfo(root)
  if (!worktree) return root
  return worktree.projectRoot
}

// Registration must never fail the command that triggered it: a capture that
// exits non-zero because a dashboard's bookkeeping file was unwritable would
// teach people not to capture. stderr and move on. The one refusal registryRoot
// can hand back gets the same treatment for the same reason — a linked worktree
// off a bare main repo is a real place to work, just not a place whose path
// belongs in the registry, and the capture itself is still perfectly valid.
function registerBestEffort(root) {
  const target = registryRoot(root)
  if (target === null) {
    console.error(`registry update skipped (board will not list this project): ${root} is a linked git worktree whose main working tree could not be determined`)
    return
  }
  try {
    registerProject(target)
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

// The nine leaf directories the store is defined to have. out-of-scope is
// flat — items land there and stay there; bugs/ideas/tasks/refactors each
// split into open/done as items move through their lifecycle.
//
// Spelled out rather than derived from SECTIONS, even though every entry but
// out-of-scope is mechanically `<section>/open` + `<section>/done`: the one
// exception is exactly what a derivation would have to special-case, and this
// list is also the thing `init` promises. A reader checking "what does a store
// contain" should find the answer, not a rule for computing it.
const LEAF_DIRS = [
  'bugs/open',
  'bugs/done',
  'ideas/open',
  'ideas/done',
  'tasks/open',
  'tasks/done',
  'refactors/open',
  'refactors/done',
  'out-of-scope',
]

const README_TEXT = `# Backlog

A lightweight, file-based backlog for this repo. Every item is a single
Markdown file living under one of the sections below. Bugs, ideas, tasks and
refactors move from open/ to done/ as they are worked; out-of-scope holds items
that were considered and declined, and has no open/done split of its own. Each
section has a fixed id prefix used when naming its items.

| Section       | Prefix | Lifecycle     |
|---------------|--------|---------------|
| bugs          | bug    | open -> done  |
| ideas         | idea   | open -> done  |
| tasks         | task   | open -> done  |
| refactors     | ref    | open -> done  |
| out-of-scope  | oos    | flat          |

Ideas are new; refactors are existing things that should be improved. A refactor
may also carry \`kind: chore\` or \`kind: debt\` in its frontmatter, saying which
of the two it is; any other value is preserved but means nothing to the board.

An item's status is the directory it lives in, never a frontmatter key. The one
exception is not a status: a \`started:\` line — a second-precision UTC timestamp
like \`2026-08-28T14:03:07Z\` — means someone is working that item right now. It
is still an open item in \`<section>/open/\`; the stamp only says when it was
picked up. Set it with \`start <id>\`, clear it with \`stop <id>\`.
Archiving keeps it, so a done item records when the work began. \`start --as
groom\` or \`--as execute\` also writes a \`phase:\` line alongside \`started:\`,
naming which of the two \`stop\` bills the elapsed time to. \`stop\` always
clears \`started:\` and \`phase:\` together, and adds the seconds in between to
\`groom-elapsed:\` or \`execute-elapsed:\` — one running total per phase, kept
separate because grooming and executing are different work. It adds the tokens
that session spent over the same interval to \`groom-tokens:\` or
\`execute-tokens:\` alongside them: four totals, two per phase, saying how long
the work took and roughly how much model work it took. All four are never
cleared, only added to, session after session.
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

// --- connect: pointing a project at a tracker --------------------------------
// `connect github [owner/repo]` writes the project's OWN committed source marker — `backlog/source.json` — which is what the server's `resolveSource` reads per
// request to decide whether this project's items come from files on disk or from a tracker's API. It is the marker's first writer (`import`, phase 5, is the
// second and the one that moves a populated store across); both live here rather than in the server because the marker is committed in the project, and the
// tool is the only thing that writes inside a project's `backlog/`.
//
// Three things this command deliberately does NOT do:
//
//   - it does not touch `~/.backlog-manager/registry.json`. That file's one-writer relationship with this tool stands, but registration answers "does this
//     machine's board know about this project at all", which is per machine and unchanged by connecting; the marker answers "where do this project's items
//     come from", which is per project and committed. Conflating the two would make connecting a project on one machine silently re-register it there;
//   - it makes no network call and needs no server running. The nine labels the issue→item mapping depends on are created by the board's poller on its first
//     successful sync (spec §5.2), so a `connect` run on a laptop with no token still produces a correct, committable marker;
//   - it does not create the labels' issue forms' *labels*, only forms that REQUEST them. A form naming a label that does not exist yet is not an error on
//     GitHub's side — the label is applied once it exists, and the poller creates it before anyone can file through the form in anger.
const SOURCE_MARKER = 'source.json'

// `owner/repo`, the same shape the spec pins (§3.1) and the server validates before interpolating it into an `api.github.com` URL path. Validated HERE as well,
// on the way in, because a marker is committed and then read on every machine: a value that only fails at request time on someone else's laptop is a defect
// this side had every chance to refuse. Exactly one slash, and each half limited to the characters GitHub actually allows in a login or a repository name —
// notably no whitespace, no `..`, no `%`, nothing that could change the shape of the URL path it lands in.
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export function isValidRepo(value) {
  return typeof value === 'string' && REPO_SHAPE.test(value)
}

// The two URL shapes git writes for a GitHub remote, parsed rather than pattern-matched loosely, because the answer becomes a committed identity:
//
//   git@github.com:owner/repo.git          the scp-like shape `git clone git@…` produces (and `ssh://git@github.com/owner/repo.git`, its explicit-scheme form)
//   https://github.com/owner/repo.git      the shape `git clone https://…` produces, with or without the `.git` suffix and with or without a trailing slash
//
// A remote pointing anywhere but github.com answers null, which the caller reports as the same refusal as "no origin at all": a GitLab origin means this
// project is not connectable to GitHub by derivation, and guessing `owner/repo` off a different host would write a marker naming a repository that does not
// exist. `www.github.com` is accepted as the one host alias, since a hand-typed clone URL occasionally carries it and it names the same repository.
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/
const SCP_LIKE = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/

export function parseOriginRepo(url) {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (trimmed === '') return null

  const match = URL_LIKE.exec(trimmed) ?? SCP_LIKE.exec(trimmed)
  if (!match) return null

  const host = match[1].toLowerCase().replace(/^www\./, '')
  if (host !== 'github.com') return null

  // Strip the leading slash an ssh:// path carries, the `.git` suffix and any trailing slash, then let REPO_SHAPE decide. A path with more than two segments
  // (a Gist, a deep link someone pasted into the remote) fails the shape check rather than being truncated to its first two, because truncating would invent
  // a repository name out of a URL that never named one.
  const repo = match[2].replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  return isValidRepo(repo) ? repo : null
}

// `git remote get-url origin`, asked of git rather than read out of `.git/config` by hand. The config file is not the whole answer — git resolves the value
// through `url.<base>.insteadOf` rewrites and, in a worktree, through the shared config one directory over — and this file already carries two hand-written
// git-plumbing parsers (`resolveRoot`'s walk and `linkedWorktreeInfo`'s gitdir chase), each of which exists only because there was no cheap way to ask git
// instead. There is one here, so it is used.
//
// Every failure is null, never a throw: git missing from PATH (status null and `error` set), no origin configured (exit 2), a repository git refuses to read.
// The caller turns all of them into one refusal that tells the operator to pass `owner/repo` explicitly, which is a working answer in every one of those cases.
function originRemoteUrl(root) {
  const out = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const url = (out.stdout ?? '').trim()
  return url === '' ? null : url
}

// Every `*.md` under the nine leaf directories, repo-relative to `backlog/` and sorted, for the refusal that keeps `connect` off a populated store.
//
// Scoped to LEAF_DIRS rather than "every .md under backlog/" so the store's own furniture does not read as content: `README.md` at the store root is written by
// `init` and says nothing about whether this project has items, and `source.json` is the very file being written. A project that has been `init`ed and never
// captured into is exactly the case `connect` is for, and it must not have to be deleted first.
export function backlogItemFiles(backlog) {
  const found = []
  for (const rel of LEAF_DIRS) {
    let entries
    try {
      entries = fs.readdirSync(path.join(backlog, rel))
    } catch {
      // An absent leaf directory is not an error here: `connect` accepts a project with no `backlog/` at all, so "the directory is missing" and "the directory
      // is empty" have to give the same answer.
      continue
    }
    for (const entry of entries) {
      if (entry.endsWith('.md')) found.push(`${rel}/${entry}`)
    }
  }
  return found.sort()
}

// The git facts `import` refuses on, read in one place because all three of them are about the same thing: whether the files this command is about to delete are
// recoverable from the repository afterwards.
//
// `dirty` and `untracked` are the two halves of "committed". A modification is caught by `status --porcelain -- backlog`; a file git has never been told about
// is NOT — the interesting case is one excluded by `.gitignore` or `.git/info/exclude`, where the status is clean and the file would still be deleted at the end
// with no commit anywhere carrying it. The tracked set is read with one `ls-files -- backlog` and subtracted, rather than one `--error-unmatch` call whose
// refusal has to be scraped back out of git's stderr: the same fact, one child process either way, and the list of paths is exact instead of parsed.
//
// `sha` and `pushed` are about the truncation link. A body over `IMPORT_BODY_CAP` keeps its first whole sections and links the rest at this exact commit, so a
// commit no remote has is a link that 404s for everybody but this machine — and by then the file it pointed at is deleted. `branch -r --contains HEAD` is the
// question "does some remote-tracking ref contain this commit", asked of git's own refs rather than of the network, so it costs nothing and works offline.
function gitImportState(root, files) {
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', 'backlog'], { encoding: 'utf8' })
  const dirty = (status.stdout ?? '').replace(/\n+$/, '')

  const listed = spawnSync('git', ['-C', root, 'ls-files', '--', 'backlog'], { encoding: 'utf8' })
  const tracked = new Set(
    (listed.stdout ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.replace(/^backlog\//, '')),
  )
  const untracked = files.filter((rel) => !tracked.has(rel))

  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const sha = head.status === 0 ? (head.stdout ?? '').trim() : null
  let pushed = false
  if (sha !== null) {
    const contains = spawnSync('git', ['-C', root, 'branch', '-r', '--contains', 'HEAD'], { encoding: 'utf8' })
    pushed = (contains.stdout ?? '')
      .split('\n')
      .map((line) => line.replace(/^[*+ ]+/, '').trim())
      .some((line) => line.startsWith('origin/'))
  }

  return { dirty, untracked, sha, pushed }
}

// Where an item file sits, as the two values every request about it needs: `section` is what `create` maps to a `type:*` label, `status` is what decides whether
// the issue is closed and how. Read off the relative path rather than off the frontmatter, because the directory IS the status in a files store (CLAUDE.md:
// "status is the directory, never frontmatter") and `out-of-scope/` is flat, with no open/done pair of its own.
function importPlace(rel) {
  const [section, leaf] = rel.split('/')
  return section === 'out-of-scope' ? { section: 'out-of-scope', status: 'out-of-scope' } : { section, status: leaf }
}

// The four GitHub issue forms, one per type section, each pre-applying that section's `type:*` label so an issue filed through the web UI arrives already
// mapped to a section — and carrying that section's headings, verbatim from `backlog-capture`'s table, so the issue body is the same skeleton a captured file
// has and `deriveGroomed` reads the same answer off both.
//
// Why ONE textarea per form holding the whole skeleton, rather than one field per heading, which is the obvious shape: GitHub renders a form's answers by
// emitting `### <field label>` above each response. A field per heading would therefore produce `### Cause`, and `deriveGroomed` reads `## Cause` — level two,
// via `sectionText`, which matches `## ` exactly. The headings have to live INSIDE a field's value to survive into the body at the level the server reads, so
// the form pre-fills one textarea with the skeleton and the reporter types between the headings. The single `### ` line GitHub puts above it is inert: it is
// not a `## ` line, so it neither opens nor closes a section.
//
// `type:*` is spelled out per entry rather than derived from SECTIONS' id prefixes: the prefix for refactors is `ref` (a board-column width constraint, see
// SECTIONS) while the label is `type:refactor` (the spec's set, §5.2, which the poller creates and the adapter reads). Deriving one from the other would tie a
// GitHub label to a CSS measurement.
const ISSUE_FORMS = [
  {
    file: 'bug.yml',
    name: 'Bug',
    description: 'Something in shipped code behaves wrong',
    label: 'type:bug',
    field: 'Bug',
    headings: ['Symptom', 'Repro', 'Affects', 'Cause', 'Fix'],
    // `unknown` under Cause and Fix, which is exactly what `backlog-capture` writes for a freshly filed bug and exactly what makes it read as UNGROOMED. A
    // reporter filing through the web UI does not know the cause, and a form that left those two headings empty would produce the same `deriveGroomed` answer
    // by accident rather than by statement — worse, an empty Cause invites a reporter to delete the heading, and then the item has no skeleton at all.
    prefilled: { Cause: 'unknown', Fix: 'unknown' },
  },
  {
    file: 'idea.yml',
    name: 'Idea',
    description: 'Future work whose shape is not settled yet',
    label: 'type:idea',
    field: 'Idea',
    headings: ['Problem', 'Rough shape', 'Open questions'],
    prefilled: {},
  },
  {
    file: 'task.yml',
    name: 'Task',
    description: 'Future work whose plan is already known',
    label: 'type:task',
    field: 'Task',
    headings: ['Goal', 'Plan', 'Test cases', 'Done when'],
    prefilled: {},
  },
  {
    file: 'refactor.yml',
    name: 'Refactor',
    description: 'Existing code that works but should be improved',
    label: 'type:refactor',
    field: 'Refactor',
    headings: ['What exists today', 'Why it should change', 'Rough shape'],
    prefilled: {},
  },
]

// Repo-relative and spelled with forward slashes on purpose: this string is printed (in the "commit these files" list) and pasted into a `git add`, where the
// posix spelling is what git itself wants on every platform. The absolute path is built with path.join below.
const ISSUE_TEMPLATE_DIR = '.github/ISSUE_TEMPLATE'

function issueSkeleton(headings, prefilled) {
  return headings.map((heading) => (prefilled[heading] ? `## ${heading}\n\n${prefilled[heading]}` : `## ${heading}`)).join('\n\n')
}

// Indents a block for embedding under a YAML `|` literal scalar. Blank lines stay genuinely blank — trailing whitespace on them is legal YAML but shows up as
// trailing whitespace in every issue body the form produces, and in the diff of the form file itself.
function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : pad + line))
    .join('\n')
}

function issueFormText(form) {
  return `# Written by \`backlog.mjs connect github\`. Safe to edit: nothing re-reads this file, and \`connect\` never overwrites one that already exists.
#
# The \`## \` headings in the textarea below are the skeleton the board reads — a bug's \`## Cause\` and \`## Fix\` and a task's \`## Plan\` are what decide
# whether an item shows as groomed. Keep them at level two; GitHub's own \`### \` field heading above them is ignored.
name: ${form.name}
description: ${form.description}
labels:
  - "${form.label}"
body:
  - type: textarea
    id: item
    attributes:
      label: ${form.field}
      description: Fill in each section. Leave \`unknown\` where the answer is not known yet — that is a real answer, and the board reads it as ungroomed.
      value: |
${indentBlock(issueSkeleton(form.headings, form.prefilled), 8)}
    validations:
      required: true
`
}

// Writes any of the four forms that are absent and reports both halves. An existing file is never overwritten and never silently skipped either — the caller
// prints the skip — because these are hand-editable files that a project may well have written its own version of, and a tool that quietly replaced one would
// destroy work nobody asked it to touch. The skipped ones are also kept OUT of the "commit these files" list: they are not this run's output, and a path in
// that list that turns out to be unchanged teaches the operator to ignore the list.
function writeIssueForms(root) {
  const written = []
  const skipped = []
  const dir = path.join(root, '.github', 'ISSUE_TEMPLATE')
  fs.mkdirSync(dir, { recursive: true })
  for (const form of ISSUE_FORMS) {
    const abs = path.join(dir, form.file)
    const rel = `${ISSUE_TEMPLATE_DIR}/${form.file}`
    if (fs.existsSync(abs)) {
      skipped.push(rel)
      continue
    }
    fs.writeFileSync(abs, issueFormText(form))
    written.push(rel)
  }
  return { written, skipped }
}

// Pretty-printed with a trailing newline, the same shape every other JSON this file writes has, because this one is committed and read in diffs.
function writeSourceMarker(backlog, repo) {
  fs.mkdirSync(backlog, { recursive: true })
  fs.writeFileSync(path.join(backlog, SOURCE_MARKER), JSON.stringify({ kind: 'github', repo }, null, 2) + '\n')
}

// --- API mode ---------------------------------------------------------------
//
// A project whose committed marker says `github` has NO ITEM FILES (spec §6.5). Every command below that would have read or written one instead speaks to the
// backlog-manager API on this machine, which holds the credential and does the writing. `files` mode runs today's code byte for byte: the branch is taken on
// the marker alone, and a project with no marker never reaches any of this.
//
// Three properties worth stating before the code, because each one is a decision rather than an accident:
//
//   * **The token is never here.** It lives in the server process (`BM_GITHUB_TOKEN`) and no response carries it. A skill therefore needs no credential of its
//     own, on any machine, which is the whole point of routing writes through the API rather than calling GitHub from here.
//   * **The stack must be running.** There is no offline fallback and there deliberately is not one: a queued write would be a second source of truth for an
//     item's state, on one laptop, invisible to every other machine. A refused connection is exit `5` with the two commands that start the stack named.
//   * **Nothing is cached.** Every command makes its calls fresh, the same posture the server takes toward the registry and the marker.
//
// `BM_API_PORT` is the same variable compose reads, so a stack on a non-default port needs no second setting for the skills.

// The one place the default port is written. `4322` is this app's API port (CLAUDE.md, Ports); `BM_API_PORT` moves the HOST side only, exactly as compose
// reads it, so a `.env` that moves the port moves the skills with it.
function apiBase() {
  const port = process.env.BM_API_PORT || '4322'
  return `http://127.0.0.1:${port}`
}

// Exit 5, and its sentence. A new code rather than reusing 1: "the store said no" and "there is no store reachable at all" are different things to a caller,
// and the second one has a fix that is the same every time — start the stack. Named here so both the message and the code have one home.
const API_DOWN_CODE = 5

// How long a claim stays live without a heartbeat, mirroring the server's `CLAIM_STALE_MS` (`shared/types.ts`), which is itself a named alias of
// `RUN_STALE_MS`. The CLI genuinely cannot import it — a plugin skill's `tools/` is a standalone copy of what was pushed, with no path back into the repo —
// so this is the second copy, and it is NAMED for the reason the server's is: the invariant says the window exists as an alias precisely so phase 4 can give
// a skill claim a longer one, and an unnamed literal buried in `stop` is the copy that would silently disagree when it moves. Only `stop` reads it, to decide
// whether another session's claim is still somebody's property or merely litter; the authority on that question is the server, which re-decides it on every
// `claim`.
const CLAIM_STALE_MS = 15 * 60 * 1000

function apiDownMessage() {
  return `the backlog-manager API is not running on ${apiBase().replace('http://', '')} — start it with \`pnpm run dev\` or \`pnpm run docker:up\`; a tracker project needs the stack up for every command`
}

// One request, and the only place this file touches the network.
//
// `connection: close` so no socket is kept alive past the call: this file's entry guard requires that nothing hold the event loop open (see its comment, and
// CLAUDE.md's "all three skill CLIs exit through process.exitCode" invariant), and an agent-pooled keep-alive socket is exactly the handle that would.
//
// No `Origin` header at all, deliberately. `SameOriginPostGuard` allows an absent origin — a non-browser caller cannot forge its way past a check a browser
// enforces — and sending a made-up one would be this file claiming to be a page it is not.
//
// A transport failure is exit 5 and is the ONLY failure translated here; every HTTP status is handed back as a value for the caller to read, the same posture
// `GithubClient` takes on the server side.
async function apiRequest(method, path, body) {
  let res
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: body === undefined ? { connection: 'close' } : { 'content-type': 'application/json', connection: 'close' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // Every transport failure reads the same: ECONNREFUSED for nothing listening, a `TypeError` from `fetch` for a malformed base, EHOSTUNREACH for a
    // half-configured port. All three mean "there is no API here", which is one thing to fix.
    throw new BacklogError(apiDownMessage(), API_DOWN_CODE)
  }
  const text = await res.text()
  let payload = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    // A body that is not JSON is not a body this file can act on. Left null; the caller reports the status. `text` is still carried, because one route —
    // `/api/items/body` — answers `text/plain` and IS the item's Markdown.
  }
  return { status: res.status, body: payload, text }
}

// A write, or a BacklogError carrying the server's own sentence. The server composes every refusal (it is the only side that knows what GitHub said), so this
// copies the sentence rather than inventing a second wording for the same fact.
async function apiPost(route, payload) {
  const res = await apiRequest('POST', `/api/items/${route}`, payload)
  if (res.status >= 200 && res.status < 300) return res.body
  const message = res.body && typeof res.body.error === 'string' ? res.body.error : `the API answered ${res.status}`
  const err = new BacklogError(message, 1)
  err.status = res.status
  err.payload = res.body
  throw err
}

async function apiGet(path) {
  const res = await apiRequest('GET', path, undefined)
  if (res.status >= 200 && res.status < 300) return res.body
  const message = res.body && typeof res.body.error === 'string' ? res.body.error : `the API answered ${res.status}`
  throw new BacklogError(message, 1)
}

// `GET /api/items/body` answers `text/plain`, because the payload IS the Markdown and wrapping it would make every caller unwrap it. Its own reader for that
// reason: routing it through `apiGet` would hand back `null` for every well-formed body that is not also valid JSON.
async function apiGetText(path) {
  const res = await apiRequest('GET', path, undefined)
  if (res.status >= 200 && res.status < 300) return res.text
  const message = res.body && typeof res.body.error === 'string' ? res.body.error : `the API answered ${res.status}`
  throw new BacklogError(message, 1)
}

// Which mode a resolved store is in, read from the committed marker and nothing else — the CLI's copy of the server's `resolveSource`, restated rather than
// imported for the reason `labels.ts` documents at length: a plugin skill's `tools/` is installed as a standalone copy of what was pushed, with no build step
// and no path back into the repo.
//
// Three answers. `files` for no marker and for an explicit `{"kind":"files"}` — the implicit case is every project on this machine today. `api` for a `github`
// marker with a usable repo. `bad` for everything else, INCLUDING a `github` marker whose repo is malformed: the load-bearing negative is the same one
// `resolveSource` carries, that an unreadable marker must never fall back to files. Falling back would make this tool write item files into a project whose
// items live on GitHub, on one machine, where nothing would ever report them.
function sourceMode(backlog) {
  const marker = path.join(backlog, SOURCE_MARKER)
  if (!fs.existsSync(marker)) return { kind: 'files' }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(marker, 'utf8'))
  } catch (e) {
    return { kind: 'bad', message: `${marker}: cannot be read as JSON (${e.message})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'bad', message: `${marker}: expected an object with a string "kind"` }
  }
  if (parsed.kind === 'files') return { kind: 'files' }
  if (parsed.kind === 'github') {
    if (!isValidRepo(parsed.repo)) return { kind: 'bad', message: `${marker}: names kind "github" with no valid "repo" (expected "owner/name")` }
    return { kind: 'api', repo: parsed.repo }
  }
  return { kind: 'bad', message: `${marker} names source kind ${JSON.stringify(String(parsed.kind))}, which this tool cannot write to` }
}

// `requireBacklog` plus the mode. Every command that acts on an item goes through this one function, so "which mode am I in" is asked once per command and in
// one place — a second resolution path is how one verb ends up writing a file in a project every other verb treats as a tracker.
function requireStore() {
  const r = requireBacklog()
  if (!r.ok) return r
  const mode = sourceMode(r.resolved.backlog)
  if (mode.kind === 'bad') {
    console.error(mode.message)
    return { ok: false, code: 1 }
  }
  return { ...r, mode }
}

// The id a tracker project's routes take, from whatever the caller typed. `31`, `#31` and this project's own URN all mean `#31`.
//
// A FILE-shaped id is refused with its own sentence rather than falling through to "not an issue": `task-31` in a tracker project is somebody carrying a habit
// across from a files project, and naming that is more use than a shape complaint. A URN for another repo is refused too — this project's credential does not
// write to somebody else's repository.
function trackerId(id, repo) {
  if (/^[a-z]+-\d+$/.test(id)) {
    throw new BacklogError(`in a tracker project an item is #<n> — ${id} is a file id`, 1)
  }
  if (id.startsWith('gh:')) {
    const m = /^gh:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)$/.exec(id)
    if (m === null) throw new BacklogError(`not an item id: ${JSON.stringify(id)}`, 1)
    if (m[1] !== repo) throw new BacklogError(`${id} names ${m[1]}, but this project is connected to ${repo}`, 1)
    return `#${m[2]}`
  }
  const digits = id.startsWith('#') ? id.slice(1) : id
  if (!/^\d+$/.test(digits) || Number(digits) <= 0) throw new BacklogError(`not an item id: ${JSON.stringify(id)}`, 1)
  return `#${digits}`
}

// Who this session is, for the claim protocol. `CLAUDE_CODE_SESSION_ID` when there is one — the same identity `sessionTokensSince` reads a transcript by, so a
// claim and its token bill name the same session. Otherwise `<user>@<host>`, which is stable across the two PROCESSES `start` and `stop` run in and honest
// about who it names: a person at a terminal, on one machine, rather than a session that does not exist.
function sessionIdentity(env = process.env) {
  const id = env.CLAUDE_CODE_SESSION_ID
  if (typeof id === 'string' && id.trim() !== '') return id.trim()
  return `${os.userInfo().username}@${os.hostname()}`
}

// WHERE this session is, for the claim protocol (bug-46). `<user>@<host>` — the identifier a reader on ANOTHER machine can act on, which a session id is
// precisely not: it names a transcript under `~/.claude/projects` on exactly one host, so the only check a remote reader can run ("is there a session by that
// id here?") answers no for every foreign claim, live or dead, and that no gets read as proof of death.
//
// Deliberately NOT folded into `sessionIdentity`, whose return value is compared for equality in three places (`stop`'s holder check, and the server's
// heartbeat and release author tests): a composite identity would stop matching across a version gap, so a new build could not release a claim an old build
// wrote. The host rides BESIDE the identity, never inside it.
// `BM_MACHINE_NAME` overrides both halves, and it is a PRIVACY setting before it is a cosmetic one: a claim comment on a PUBLIC repository publishes this
// string to everybody, and the default spells out the OS username and the machine's real hostname — which on this author's laptop is a router-assigned UUID
// that says nothing to a person and plenty to a stranger. A name the owner of the box chose reads better to the next person AND discloses only what they
// picked. Hashing would hide the same thing and cost the readability bug-46 added the field for; a digest is a word no reader can act on.
//
// Blank reads as unset, deliberately: `ClaimRecord.host` says absence means "the machine was not recorded", so an empty setting has to degrade to the default
// rather than put a claim on the board held by the empty string.
//
// Read from the environment and nowhere else, exactly as `BM_API_PORT` and `BM_REGISTRY_FILE` are. `orchestrate.mjs`'s own `hostIdentity` reads the SAME
// variable and must keep doing so: the two tools write claims on one machine, and the server's release clause compares those strings for equality, so a
// machine that answered two different names could not release its own driver's claim by hand.
function hostIdentity(env = process.env) {
  const nickname = env.BM_MACHINE_NAME
  if (typeof nickname === 'string' && nickname.trim() !== '') return nickname.trim()
  return `${os.userInfo().username}@${os.hostname()}`
}

// The two halves of a refusal that names a holder, decided in one place so the three sites cannot drift apart (bug-46).
//
// When the claim recorded a machine, both sides are named — that comparison is the whole answer a reader needs. When it did not, the line degrades to the one
// it always printed, INCLUDING this session's half: a sentence that says where we are beside a blank where they are invites exactly the inference this bug is
// made of, that a claim nothing local can account for is litter. Absence has to read as "the machine was not recorded", and the only way to say that is to
// say nothing about machines at all.
function refusalSides(holderHost, session) {
  if (typeof holderHost !== 'string' || holderHost.trim() === '') return { theirs: '', mine: session }
  return { theirs: ` on ${holderHost}`, mine: `${session} on ${hostIdentity()}` }
}

// Read a file the caller named, as bytes, for the flags that carry an item's text (`--body`, `--outcome`). Its own helper so every one of them reports a
// missing file the same way — and so none of them silently sends an empty body, which for `body` would blank an issue.
function readTextFile(file, flag) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new BacklogError(`cannot read ${flag} file ${file}: ${e.message}`, 1)
  }
}

// `4m`, `2h`, `36s` — the age a refusal prints for a holder's heartbeat. Rough on purpose: the question it answers is "is that session plausibly still alive",
// and a caller deciding whether to wait does not need seconds past a minute.
function roughAge(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
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
// rather than filled). For every queue section (bugs, ideas, tasks,
// refactors) that "every place" is THREE
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
// the same way every queue section is each two states (open, done).
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

// bugs, ideas, tasks, refactors — the queue sections listOpen/board ever look
// at. Derived from SECTIONS by exclusion rather than listed, which is why
// adding `refactors` to that one map was enough to put it on the board: the
// only section that is not a queue is out-of-scope, because it has no
// open/done split (see LEAF_DIRS and README_TEXT above).
const QUEUE_SECTIONS = Object.keys(SECTIONS).filter((section) => section !== 'out-of-scope')

// Every item currently sitting in an open/ directory, across every queue
// section, in section order — each as its id plus the absolute path it was
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

// Every open item across the queue sections, sorted by the fixed section
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
//
// `updated:` is stamped HERE, inside the one function both of writeItemFile's
// callers funnel through, rather than by startItem and stopItem each writing
// it themselves. writeItemFile is the only place an item's frontmatter is
// actually rewritten, so a stamp added at this seam covers every caller by
// construction — present and future. Two callers writing the same line
// individually is exactly the setup where a third caller, added later,
// forgets to; centralizing it here removes that failure mode entirely rather
// than relying on every new caller remembering the convention.
//
// `move` is deliberately NOT a caller of writeItemFile and gets no
// `updated:` stamp of its own — see moveItem above, which is a renameSync
// that never opens the file at all, on purpose: an item's content must be
// untouched by the act of filing it into done/ or out-of-scope/, the same
// guarantee that already protects `started` and every unknown key across a
// move. Making move stamp `updated` would mean either opening the file just
// to change one line — reintroducing the exact risk renameSync exists to
// avoid — or leaving the stamp to describe a moment that isn't the actual
// last edit. Nothing is lost by leaving it out: every skill path that moves
// an item calls `stop` on it immediately beforehand — backlog-groom's own
// moves (an idea promoted to done/, anything rejected to out-of-scope/),
// backlog-execute's abandonment path, and (Task 7) backlog-execute's own
// successful archive too — and `stop` already refreshes `updated` through
// this same function, so an archived item's `updated:` is never more than
// one function call older than its move. That last case used to be the one
// exception: backlog-execute's successful archive (`move <id> done` once a
// fix or task is verified) held the marker all the way through instead of
// stopping first, so `execute-elapsed:` was never billed for a task that
// actually finished — only for one that was abandoned. Task 7 closed that
// gap by having the archive path call `stop --keep-started` first, which
// bills the session into `execute-elapsed:` and drops `phase:` exactly like
// a plain `stop`, but leaves `started:` in place — so the absolute above
// holds without exception again, and the archived item still records
// *when* the work began even though `updated:` now sits right next to it as
// the moment it ended. See the paragraph beginning "Two skills call
// `start`/`stop`" in docs/subsystems/invariants.md for the full reasoning.
//
// The fourth parameter exists so a caller — real or test — can pin the exact
// value written, mirroring startItem's own third parameter. startItem and
// stopItem both resolve their own `stamp` (a real call site never supplies
// one, so it defaults to `nowISO()` right there) and hand that SAME value
// down here, rather than letting this default fire independently. The two
// operations already write a lifecycle stamp of their own — `started` here,
// nothing there — and `updated` is meant to record that exact instant, not a
// microseconds-later recomputation of "now" that could round to the next
// second and disagree with it. In production the two are the same call's
// result either way; pinning both to one value only matters for a test that
// wants to assert an exact literal timestamp instead of a shape.
function writeItemFile(absPath, data, body, stamp = nowISO()) {
  fs.writeFileSync(absPath, `${renderFrontmatter({ ...data, updated: stamp })}\n${body}`)
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

// The two activities that can hold the in-progress marker. Exported so
// Task 3's stop — which reads this same key back off the file to decide
// which of groom-elapsed:/execute-elapsed: to bill time into — validates
// against this one list instead of a second copy that could drift from it.
//
// `phase` is deliberately NOT a status, and does not loosen the `status:`
// ban in parseFrontmatter above. A status answers "where does this item
// live" — the directory it is in, and only the directory, per that ban.
// `phase` answers a narrower, shorter-lived question: which activity
// currently holds the started: marker. It has no meaning without started:
// and no lifespan beyond it — the two are written together here, and
// (Task 3) will be cleared together too — so it can never become a fourth
// place an item "is", the way a real status key would.
export const PHASES = ['groom', 'execute']

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
export function startItem(backlog, id, stamp = nowISO(), phase = undefined) {
  // Validated first, before locateItem even runs — same order moveItem
  // checks `dest` against MOVE_DESTS in. A bad --as is a shape problem with
  // the call itself, not something that depends on which item or state it
  // names, so it is refused before any of that is even looked up, and
  // before anything is written. The message names both accepted values
  // rather than saying "invalid phase" — the CLI is the only caller today,
  // but this same throw is what a future in-process caller gets too, and
  // "invalid phase" would make either one guess.
  if (phase !== undefined && !PHASES.includes(phase)) {
    throw new BacklogError(`unknown phase: ${phase} (expected ${PHASES.join(' or ')})`, 1)
  }

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

  // No `phase` key at all when the caller didn't pass one — not `phase: ''`
  // or some other placeholder — so an older caller (or a plain `start` with
  // no --as) produces a file Task 3's stop can tell apart from one it should
  // bill time against: nothing to key the billing off of.
  const next = phase === undefined ? { ...data, started: stamp } : { ...data, started: stamp, phase }

  // `stamp` is forwarded as writeItemFile's own fourth argument rather than
  // left for writeItemFile's default to recompute — see the comment on
  // writeItemFile for why: `started` and `updated` are two readings of the
  // exact same instant here, and passing the one value through both keeps
  // them identical instead of risking a second's drift between two separate
  // `nowISO()` calls a few statements apart.
  writeItemFile(item.path, next, body, stamp)
  return item.path
}

// stop's own reading of PHASES: which frontmatter key accumulates the time
// billed under each phase. A lookup keyed by PHASES's own values rather than
// a second parallel array of key names, so a third phase added to PHASES
// without a matching entry here fails loudly (undefined key, TypeError on
// the property access below) instead of silently billing into "undefined-
// elapsed" or dropping the time on the floor.
const ELAPSED_KEYS = { groom: 'groom-elapsed', execute: 'execute-elapsed' }

// `started:` in its billable shape: a full second-precision timestamp, the
// one `nowISO()` writes. Deliberately excludes the legacy bare-date shape —
// see the comment inside stopItem below for why a bare date is cleared but
// never billed.
const FULL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

// The only shape an elapsed bucket is ever allowed to already hold: an
// unsigned integer with no sign, decimal point, or stray whitespace. This is
// also the only shape stopItem itself ever writes there (a non-negative
// integer, stringified by renderFrontmatter), so anything else on disk is
// necessarily a hand-edit or corruption — never a value this function wrote
// itself in some earlier, valid run.
const DIGITS_ONLY = /^\d+$/

// --- session token accounting -----------------------------------------------
// The token-shaped sibling of the elapsed buckets above: `stop` bills not only
// the seconds a session spent on an item but roughly how much model work it
// took, read out of the calling session's OWN transcript. Elapsed time and
// tokens are two independent reads on the same interval — a session can idle
// for an hour or burn a million tokens in ten minutes, and neither number
// implies the other.
//
// There is deliberately NO hook and nothing new on the plugin's publish
// surface. `CLAUDE_CODE_SESSION_ID` is present in the environment of every
// Bash tool call and names the session's own transcript, and the transcript is
// flushed mid-session rather than at exit — measured 317,222 bytes and 14
// completed turns on disk while the session that wrote them was still running.
// So a `stop` running INSIDE the session it is measuring can read that
// session's own history, which is the whole premise. (`CLAUDE_CODE_HOST_
// SESSION_ID` is a different variable and is the wrong one; do not reach for
// it.)
//
// The caveat, stated on purpose because it decides who should trust the
// number: this bills every token the session spent inside the window, not the
// item alone. Under backlog-orchestrate it is very nearly exact — each item
// gets its own headless backlog-execute session, so the window covers that
// session and nothing else — and that is the consumer that matters, since it
// is where the expensive items are. For hand grooming in a shared terminal it
// is noisy by exactly as much as the unrelated work in the window. There is no
// tighter mechanism available: nothing in a transcript marks a turn as being
// about item X, so start/stop is already the finest bracket that exists. Do
// not invent a heuristic to narrow it.

// stop's second reading of PHASES, exactly parallel to ELAPSED_KEYS above and
// for the identical reason: a lookup keyed by PHASES's own values, so a third
// phase added without an entry here fails loudly instead of billing into
// "undefined-tokens".
const TOKEN_KEYS = { groom: 'groom-tokens', execute: 'execute-tokens' }

// True only for a path that exists AND is a regular file. Both callers below
// treat "it is there but is a directory" exactly as they treat "it is not
// there" — a session id that names a directory is not a transcript, and the
// alternative is an EISDIR thrown out of a `stop` that has nothing wrong with
// it.
function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// Every transcript file belonging to one session: the main transcript first,
// then its subagents in name order. Absolute paths.
//
// The main file is found by TESTING EACH PROJECT DIRECTORY for
// `<sessionId>.jsonl`, never by deriving the directory name from cwd. The slug
// rule (a cwd with its separators replaced) is undocumented and Claude Code
// owns it, and — the part that actually bites — a backlog-execute session runs
// with its cwd inside a per-item worktree, whose slug is not the main tree's.
// A scan is slug-rule-free and costs one stat per project directory (measured
// 77 of them on the machine this was written against) for a function that runs
// once per `stop`.
//
// Subagent turns are NOT in the main transcript: they live in a sibling
// `<sessionId>/subagents/agent-*.jsonl`. Measured, `isSidechain: true` appears
// on zero records across all 703 transcripts in all 77 project directories
// while a subagent file carried 20 of them — so filtering the main file finds
// nothing and skipping these files loses every subagent's cost outright. This
// repo's own history has a run that spent ~2M tokens on reviewer subagents; a
// number that excluded them would be worse than no number. The same
// `<sessionId>/` directory also holds `tool-results/`, which is not token
// accounting and is ignored, as is anything in `subagents/` that is not
// `.jsonl` (agent-*.meta.json sits right beside the transcripts).
//
// If the same `<sessionId>.jsonl` somehow appears under two project
// directories, both are returned and the counting sums across them. A session
// id is a uuid so this should not happen; summing is the answer that cannot
// silently drop half the history if it does.
//
// A missing or unreadable root is `[]`, never a throw: this whole feature is
// bookkeeping riding along on a `stop`, and no shape of a directory nobody
// here owns may fail one.
export function transcriptFiles(projectsRoot, sessionId) {
  let entries
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const files = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    const main = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`)
    if (!isFile(main)) continue
    files.push(main)

    const subagents = path.join(projectsRoot, entry.name, sessionId, 'subagents')
    let names = []
    try {
      names = fs.readdirSync(subagents).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) files.push(path.join(subagents, name))
    }
  }
  return files
}

// This machine's Claude Code config directory — `CLAUDE_CONFIG_DIR` first, the same rule Claude Code itself follows. One derivation for the two trees read
// out of it — `projects/` (transcripts, which `sessionTokensSince` bills from) and `sessions/` (the process registry `holdingSessionEvidence` reads) —
// because a second spelling of the same path is how one reader silently stops looking where the other looks.
function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')
}

function claudeProjectsRoot(env) {
  return path.join(claudeConfigDir(env), 'projects')
}

// Field 22 of `/proc/<pid>/stat` — the process's start time in clock ticks since boot, which is what Claude Code records as `procStart` on Linux. The
// command name in field 2 is parenthesised and may itself hold spaces or parens, so the split starts after the LAST `)`: field 3 is then index 0, and
// field 22 is index 19. `null` wherever there is no `/proc` (macOS) or the process is not readable — the caller then has only the pid to go on.
function procStartOf(pid) {
  let stat
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return fields[19] ?? null
}

// Is the process a registry entry was written for still running? `kill(pid, 0)` answers for the pid — `EPERM` means it exists and belongs to somebody
// else, which is still alive. Where `/proc` can say when that pid started, the entry's `procStart` must match it too, so a pid the kernel has since handed
// to an unrelated process does not read as the session. Compared only when the entry's value is all digits, the Linux shape; macOS writes a date string
// and has no `/proc`, and there a reused pid reads as alive — the safe direction, since the cost is a refusal rather than a seizure.
function registryEntryRunning(entry) {
  try {
    process.kill(entry.pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return false
  }
  const recorded = String(entry.procStart ?? '')
  if (!/^\d+$/.test(recorded)) return true
  const actual = procStartOf(entry.pid)
  return actual === null || actual === recorded
}

// Evidence about the session holding a claim on THIS machine (bug-48, bug-49) — the proof `abort` needs before it releases a claim that is not its own, and
// the reason the SERVER's half of that clause is `sameHost` alone: a process on another host can see neither this registry nor this process table.
//
// The evidence is Claude Code's own process registry, `<configDir>/sessions/<pid>.json`: one file per running `claude` process, headless `-p` sessions
// included, written at start and kept for the whole life of the process however quiet it is. A graceful exit REMOVES the file; a hard kill leaves it, with a
// pid that no longer answers. So an entry naming the holder whose process is still running (`registryEntryRunning`) is `alive`; a registry that was read
// and understood with no such entry is `gone`.
//
// bug-48 read transcript mtimes instead, and that could never fire for the case it was written for: the `start`/`heartbeat` that stamped the beat is a tool
// call INSIDE the holding session, whose `tool_result` is appended to the transcript after the server stamps it — so every session killed after its last
// heartbeat has a transcript newer than the beat, and `abort` refused all of them as "still writing here". A transcript answers "did this session write
// after the beat", which every session did; only the registry answers "is the process still there".
//
// **Three answers, not two, and the third fails closed.** `unknown` when the directory is missing or unreadable, when any `*.json` in it lacks a string
// `sessionId` or a numeric `pid`, or — when the aborting process has a `CLAUDE_CODE_SESSION_ID` — when no running entry names the aborting session ITSELF.
// That last is the self-check: a session that cannot find itself is reading a registry whose shape or location changed, and its "nothing names the holder"
// means nothing. A misread in this direction turns every live neighbour into a dead one, so anything the reader does not understand is `unknown`, and
// `abort` refuses on it. The sibling `<pid>.<hash>.key` files are not `*.json` and are not read.
//
// **The asymmetry with bug-46 is the whole point.** The absence of a local entry is MEANINGLESS on a machine that did not mint the session — that is exactly
// bug-46's false negative. It becomes meaningful here only because `abort`'s first refusal has already established that this machine is the one the claim
// was made on, so a running holder would have to be in this registry.
//
// A claim whose `session` is the `<user>@<host>` fallback (no `CLAUDE_CODE_SESSION_ID` when it was taken) has no registry entry by construction and so reads
// `gone`. That is bug-48's reading kept on purpose: such a claim is a person at a terminal on this host, and the person at that terminal is who runs `abort`.
//
// **`gone` means "no process now", not "stopped".** A board-dispatched session is one `claude -p` process per turn (`--session-id`, then `--resume` for each
// reply), and a `-p` process exits normally at the end of its turn, removing its file — so a dispatched session waiting on a reply still holds its claim and
// reads `gone` here. Nothing in the registry tells the two apart. That is acceptable for `abort` only because a person runs it, at the machine whose
// dashboard shows whether the session is idle-and-resumable, and the skills tell them to look first; it is exactly why bug-49's automatic server-side sweep
// over this same signal was withdrawn in review.
//
// `{ state: 'alive', file, pid }`, `{ state: 'gone' }` or `{ state: 'unknown', why }`.
export function holdingSessionEvidence(session, env = process.env) {
  const dir = path.join(claudeConfigDir(env), 'sessions')
  let names
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return { state: 'unknown', why: `${dir} could not be read` }
  }

  const entries = []
  for (const name of names) {
    const file = path.join(dir, name)
    let entry
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { state: 'unknown', why: `${file} could not be read as JSON` }
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.sessionId !== 'string' || !Number.isInteger(entry.pid)) {
      return { state: 'unknown', why: `${file} carries no sessionId and pid this build understands` }
    }
    entries.push({ file, entry })
  }

  const self = env.CLAUDE_CODE_SESSION_ID
  if (typeof self === 'string' && self.trim() !== '') {
    const found = entries.some(({ entry }) => entry.sessionId === self.trim() && registryEntryRunning(entry))
    if (!found) return { state: 'unknown', why: `${dir} holds no running entry for this session (${self.trim()})` }
  }

  for (const { file, entry } of entries) {
    if (entry.sessionId === session && registryEntryRunning(entry)) return { state: 'alive', file, pid: entry.pid }
  }
  return { state: 'gone' }
}

// One transcript file's records, or `null` if the file could not be read at
// all. The null is load-bearing and different from `[]`: a file that exists but
// cannot be read means the count would be an undercount, and an undercount
// silently written to disk is worse than no number (see sessionTokensSince,
// which turns it into a whole-resolution `null`).
//
// A line that is not valid JSON is skipped, not fatal. A transcript is a log
// this tool does not own and does not version with; a half-flushed final line
// is the ordinary case while the session writing it is still running, which is
// exactly when this runs.
function readRecords(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // Not a record. See above.
    }
  }
  return records
}

// A usage field, coerced to a number that can be added: anything missing or
// non-numeric contributes 0 rather than turning the whole total into NaN, and
// a NaN would reach disk as the literal string "NaN" — a value DIGITS_ONLY
// then refuses on every later stop, wedging the item shut exactly as the
// elapsed arithmetic's own NaN guard describes.
function usageNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// The counting rule. Pure: no filesystem, no environment, already-parsed
// records in, one number out — so every rule below is testable against literal
// fixtures.
//
// DEDUPE ON requestId. This is the single most important rule here. One API
// turn is written as one record PER CONTENT BLOCK — apiBlockIndex 0, 1, 2 for
// thinking, text, tool_use — and each of those records repeats the same
// `usage` object verbatim. Measured: 25 of 28 turns in one transcript were
// split this way, all 25 groups carrying byte-identical usage, and 2,638 such
// groups across 77 project directories. A naive per-record sum inflates a
// typical turn 2-3x, and the wrong number still looks entirely plausible in
// isolation, which is what makes this easy to get wrong and hard to notice.
// `uuid` is the fallback key for a record with no requestId. One set spans
// every file the caller concatenated, main and subagents alike — request ids
// are unique per API call, so deduping globally is safe and is what makes the
// main file's and a subagent's records comparable at all.
//
// THE NUMBER IS input + cache_creation + output. `cache_read_input_tokens` is
// excluded, and the exclusion is the substance of the answer rather than an
// oversight — do not quietly re-add it. Measured on one live session: 89,210
// fresh against 804,246 cache_read, a 9:1 ratio. A raw total is ~90% re-read
// context floor, which scales with turn count and prompt size and is close to
// identical for a trivial item and a hard one; it would swamp the signal this
// number exists to carry. Cache CREATION stays in — that is new material
// genuinely pulled into context (files read, tool output) and does track how
// much an item demanded. Output stays in as the model's own work. Output alone
// was the other candidate and is rejected: it ignores the reading an item
// required, which for a debugging item is most of the work.
//
// Deliberately NOT added: `output_tokens_details.thinking_tokens` (measured 281
// inside an output_tokens of 370 — a subset, so adding it double-counts
// thinking) and `usage.iterations[]` (measured as a per-iteration breakdown
// whose single entry equalled the top-level fields, which are already the
// aggregate).
//
// WINDOW: at or after `fromMs`, strictly before `toMs + 1000`. Both `started:`
// and stop's `stamp` are truncated to the second while record timestamps carry
// milliseconds, so the upper bound has to cover the whole second the stamp
// names — otherwise the turn that issued the `stop` call itself, landing at
// :50.900Z against a stamp of :50Z, falls outside its own window.
//
// Records of every other `type` (user, attachment, last-prompt, custom-title,
// atis-latch, queue-operation — all observed), assistant records with no
// usage, and records with no parseable timestamp are skipped without throwing.
export function sumFreshTokens(records, fromMs, toMs) {
  const upper = toMs + 1000
  const seen = new Set()
  let total = 0

  for (const record of records) {
    if (!record || record.type !== 'assistant') continue
    const usage = record.message && record.message.usage
    if (!usage || typeof usage !== 'object') continue

    const at = Date.parse(record.timestamp)
    if (!Number.isFinite(at) || at < fromMs || at >= upper) continue

    const key = record.requestId ?? record.uuid
    if (key !== undefined && key !== null) {
      if (seen.has(key)) continue
      seen.add(key)
    }

    total += usageNumber(usage.input_tokens)
      + usageNumber(usage.cache_creation_input_tokens)
      + usageNumber(usage.output_tokens)
  }
  return total
}

// The default `warn` below: the non-fatal stderr note pattern this repo
// already uses for a registration it could not make. Stdout is untouched —
// `stop` prints the item path there and existing callers parse it.
function warnToStderr(message) {
  console.error(message)
}

// The glue: environment -> files -> records -> number. Returns `null`, never
// throws and never partially succeeds, for every failure alike — no session
// id, no matching transcript, a file that cannot be read. `null` means "cannot
// attribute", which is a different fact from `0` ("attributed, and it was
// tiny"), and stopItem writes no key at all for it.
//
// Every failure also emits one line through `warn`, because the alternative is
// a feature that silently records nothing forever. Every measurement behind
// this code came from a headless `sdk-cli` session; whether an INTERACTIVE
// session exports CLAUDE_CODE_SESSION_ID was never observed, so the first
// interactive `stop` after this ships either records a number or says out loud
// why it could not. `warn` is a parameter so tests can collect those lines
// instead of printing them; no real call site passes one.
//
// `env` is the whole source of truth, HOME included, rather than a mix of the
// passed object and process-level state — that is what lets a test point the
// fallback at a fixture instead of the developer's real ~/.claude.
export function sessionTokensSince(startedISO, stampISO, env = process.env, warn = warnToStderr) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID
  if (!sessionId) {
    warn('backlog: CLAUDE_CODE_SESSION_ID is not set — recording no token count for this session')
    return null
  }

  const files = transcriptFiles(claudeProjectsRoot(env), sessionId)
  if (files.length === 0) {
    warn(`backlog: no transcript found for session ${sessionId} — recording no token count`)
    return null
  }

  const records = []
  for (const file of files) {
    const parsed = readRecords(file)
    if (parsed === null) {
      warn(`backlog: could not read transcript ${file} — recording no token count`)
      return null
    }
    records.push(...parsed)
  }

  return sumFreshTokens(records, Date.parse(startedISO), Date.parse(stampISO))
}

// Deliberately permissive about WHERE the item is, unlike startItem: the one
// thing stop is for is clearing a marker, and a stale `started` on an
// archived item is precisely a marker worth being able to clear. Only
// "there is nothing to clear" is refused.
//
// Takes a third `stamp` parameter for the same reason startItem does: it is
// the only seam through which a caller can pin the `updated` value
// writeItemFile is about to write, so a test can assert an exact literal
// timestamp rather than a shape. A real call site never supplies it.
//
// `stamp` now does double duty as the elapsed-seconds billing clock too,
// rather than taking a separate `now` parameter for that. A second timing
// parameter would break the (backlog, id, stamp) shape startItem and
// stopItem otherwise share, and buys nothing in return: elapsed seconds are
// floored to whole seconds regardless (see the Math.floor below), so the one
// second of precision `stamp` already truncates to could never change a
// billed total anyway. `updated` and the billing clock are the same instant
// in every real call, exactly as `started` and the first `updated` already
// are in startItem — this just extends that equivalence to stop's own
// write.
//
// The fourth parameter is an options object rather than a second and third
// positional boolean. `abandon` was a lone boolean until Task 7 added a
// second one (`keepStarted`) alongside it; `stopItem(b, id, stamp, false,
// true)` is a call site nobody could read back correctly without opening
// this file to check which position means what, and every future flag would
// make that worse. `opts.abandon` and `opts.keepStarted` name themselves at
// every call site instead, at the cost of the destructuring line below —
// a trade this file already makes the other way for `phase` (a plain fourth
// positional on startItem) precisely because `phase` has no sibling to be
// confused with; `abandon` now does.
//
// `opts.abandon` is a switch that turns the billing block below off
// entirely — mirroring startItem's own `phase` in position, not in shape.
// When true, clearing `started`/`phase` and stamping `updated` still happen
// exactly as they do on an ordinary stop — the marker is still stale and
// still needs to go — but the debit against whichever bucket `phase` would
// have named is skipped outright, whatever `phase` and `started` actually
// say, and however corrupt or fine the existing bucket value is: an
// abandoned session has nothing to bill, so there is nothing for the
// corrupt-bucket refusal below to even check. The interval between a stale
// `started:` and this stop is not work anyone did, and there is no safe way
// to guess how much of it was — a duration cap was considered and rejected
// for the same reason DIGITS_ONLY refuses rather than resets a corrupt
// bucket: a wrong guess silently corrupts a real session's total, where an
// obviously-fake one is easy to reason about instead. See the `--abandon`
// CLI flag below, which is the only thing that ever sets this true; a real
// call site otherwise leaves it at the default.
//
// `opts.keepStarted` (Task 7) bills exactly as an ordinary stop does and
// still removes `phase:`, but leaves `started:` on the file instead of
// clearing it too. It exists for exactly one caller: backlog-execute's
// successful archive, which used to hold the marker straight through to
// `move ... done` — recording *that* work happened but never *how long* —
// and now calls this instead, so the archived item ends up with all three
// facts: when work began (`started`), how long it took (the elapsed
// bucket), and when it ended (`updated`). It goes through the exact same
// billability gate as an ordinary stop below — not abandoning, a
// recognized `phase:`, a full timestamp that actually parses — because
// keeping `started:` around is a decision about what the file records
// afterward, not a second opinion on whether this session's time was real:
// a legacy bare date or an unparseable timestamp is still cleared-but-
// unbilled with `--keep-started` exactly as without it, just with
// `started:` itself surviving that clearing. `abandon` and `keepStarted`
// together is refused as a usage error at the CLI (see below) rather than
// given a meaning here: abandonment already clears `started:` same as a
// plain stop, so there would be nothing left for `keepStarted` to preserve.
//
// `opts.tokens` is a test seam and nothing else, mirroring exactly what
// `stamp` already does for the clock: `undefined` means "resolve it yourself
// from this session's transcript", and any other value — a number, or `null`
// for "cannot attribute" — is taken as given. A real call site never supplies
// it; it exists so the integration cases can assert exact literals without
// building a transcript on disk for each one.
export function stopItem(backlog, id, stamp = nowISO(), opts = {}) {
  const { abandon = false, keepStarted = false } = opts
  const item = locateItem(backlog, id)

  const { data, body } = readItemFile(item.path)
  if (!data.started) {
    throw new BacklogError(`${id} is not in progress`, 1)
  }

  // `phase` always comes off — see PHASES's own comment for why it has no
  // meaning and no lifespan beyond `started`. `started` comes off too unless
  // `keepStarted` says otherwise (see this function's own comment above for
  // why exactly one caller ever asks for that). `base` is what every branch
  // below builds on: the billing branch adds one more key to it, the
  // non-billing branches leave it exactly as is. Billing itself still reads
  // `existing` off `rest`, not `base` — the bucket key is unrelated to
  // `started`, so whether `started` survives this stop has no bearing on
  // what was already banked in `execute-elapsed:`/`groom-elapsed:` before it.
  const { started, phase, ...rest } = data
  const base = keepStarted ? { ...rest, started } : rest
  let next = base

  // Billable only when the caller isn't abandoning (see stopItem's own
  // comment above for what that means and why), there is a phase to bill
  // the time to (an item merely `start`ed with no `--as` has nothing for
  // stop to key the billing off of), `started` is the full timestamp shape
  // `start` actually writes today — never the legacy bare `YYYY-MM-DD` a
  // pre-timestamp `start` left behind, since UTC midnight is not the hour
  // anyone began work and treating a bare date as billable would fabricate
  // up to 24 hours nobody worked — AND that timestamp actually parses.
  // FULL_TIMESTAMP only checks shape: `2026-08-30T25:00:00Z` matches it
  // digit-for-digit but names an hour that does not exist, and Date.parse
  // returns NaN for a string like that. Without this last check, that NaN
  // would flow straight into the arithmetic below and out to disk as the
  // literal string "NaN" — a value DIGITS_ONLY (above) then refuses to
  // touch on any later stop, which would wedge the item shut for good: the
  // next stop refuses the corrupt bucket, and the next start refuses
  // because started: is still set, and neither can undo the other. Every
  // case that fails this check still clears the marker above like any
  // other started: value; only the billing itself is skipped. `keepStarted`
  // changes none of this gate — see this function's own comment above for
  // why keeping `started:` around is orthogonal to whether this session's
  // time is billable.
  if (!abandon && phase !== undefined && PHASES.includes(phase) && FULL_TIMESTAMP.test(started) && Number.isFinite(Date.parse(started))) {
    const key = ELAPSED_KEYS[phase]
    const existing = rest[key]

    // A corrupt bucket — anything already there that isn't a plain unsigned
    // integer — is refused outright rather than reset to 0. Resetting would
    // silently destroy whatever real total was recorded there; nothing about
    // "the file was hand-edited" or "an older, buggier version wrote this"
    // should be allowed to erase time that may be the only record of it. A
    // refusal at least leaves the number in the file for a human to recover
    // by hand, and the whole write is skipped (nothing else about this stop
    // — not even clearing `started:` — should land while the one field that
    // depends on `existing` cannot be trusted).
    if (existing !== undefined && !DIGITS_ONLY.test(existing)) {
      throw new BacklogError(`${id}: ${key} is not a whole number: ${existing}`, 1)
    }

    const previous = existing === undefined ? 0 : Number(existing)
    // Floored at zero to cover clock skew between the machine that wrote
    // `started` and the machine calling `stop` — two machines a few seconds
    // apart must never bill negative time just because stop's clock reads
    // slightly behind start's.
    const seconds = Math.max(0, Math.floor((Date.parse(stamp) - Date.parse(started)) / 1000))
    next = { ...base, [key]: previous + seconds }

    // Token billing rides this same gate rather than adding a second one, and
    // that is the whole design: the token window IS the interval the seconds
    // above are computed from, so if that interval is not billable then
    // neither is the window over it. Every case the comments above already
    // argue falls out for free — an --abandon bills no tokens (the interval
    // was not work anyone did, so neither were the tokens in it), a plain
    // `start` with no --as bills nothing (no phase to key either bucket off),
    // a legacy bare-date `started:` bills nothing (UTC midnight is not when
    // work began, so the window is fiction), and --keep-started bills tokens
    // exactly as it bills seconds.
    //
    // Resolved lazily, here inside the branch, so a non-billable stop never
    // goes looking through the transcript directory for a file it has no use
    // for.
    const tokens = opts.tokens === undefined ? sessionTokensSince(started, stamp) : opts.tokens

    // A `null` count — the transcript could not be resolved, for any of the
    // reasons sessionTokensSince names on stderr — writes no key at all and
    // disturbs nothing beside it. An unattributable stop is still a
    // successful stop, and the elapsed seconds it did bill are unaffected.
    if (typeof tokens === 'number' && Number.isFinite(tokens)) {
      const tokenKey = TOKEN_KEYS[phase]
      const banked = rest[tokenKey]

      // The DIGITS_ONLY refusal, reused verbatim and for reasoning that
      // transfers without change: a bucket already holding something that is
      // not a plain unsigned integer is refused rather than reset, because
      // resetting would silently destroy a real recorded total and nothing
      // about "this was hand-edited" should be allowed to erase it. The whole
      // write is skipped — `started:` included — exactly as the elapsed
      // refusal above already behaves.
      if (banked !== undefined && !DIGITS_ONLY.test(banked)) {
        throw new BacklogError(`${id}: ${tokenKey} is not a whole number: ${banked}`, 1)
      }

      // Floored to a non-negative integer for the same reason the seconds
      // above are: renderFrontmatter stringifies whatever it is handed, and a
      // fractional or negative value written here is one DIGITS_ONLY refuses
      // on every later stop, wedging the item shut for good.
      const previousTokens = banked === undefined ? 0 : Number(banked)
      next = { ...next, [tokenKey]: previousTokens + Math.max(0, Math.floor(tokens)) }
    }
  }

  writeItemFile(item.path, next, body, stamp)
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
  init        create the backlog/ store in the current repo
  root        print the resolved backlog/ directory
  new         print a new item's path and frontmatter (writes nothing)
  board       print the board of open items (bugs, ideas, tasks, refactors)
  show        print an item's absolute path and frontmatter
  move        move an item into done or out-of-scope
  start       mark an open bug or task as in progress
  stop        clear the in-progress marker
  connect     point this project's backlog at a tracker (github)
  import      move this project's item files onto a tracker (github)
  unregister  drop a project from the board registry by path

tracker projects only (backlog/source.json names github):
  heartbeat   say this session still holds an item
  abort       release a live claim this machine's own dead session left behind
  comment     append a comment to an item
  body        replace an item's body (groom's only write)`

const NEW_USAGE = `usage: backlog.mjs new <section> <title> [--from <id>]
       backlog.mjs new <section> <title> --body <file> [--from <id>] [--kind chore|debt] [--runner-fix]   (tracker projects)

sections: bugs, ideas, tasks, refactors, out-of-scope`

const BOARD_USAGE = `usage: backlog.mjs board [--section <bugs|ideas|tasks|refactors>] [--json]`

const SHOW_USAGE = `usage: backlog.mjs show <id> [--json]`

const MOVE_USAGE = `usage: backlog.mjs move <id> done|out-of-scope
       backlog.mjs move <id> done|out-of-scope [--outcome <file>]   (tracker projects)`

// The path is spelled out in the usage line because it is mandatory: see the
// CLI block below for why this verb has no cwd default when every other one
// resolves its target from where it stands.
const UNREGISTER_USAGE = `usage: backlog.mjs unregister <project path>`

// One constant for both verbs: they are a pair, and someone who mistyped one
// of them is the person most likely to want the other named right there.
// `--as` is shown on the start line only, and `--abandon`/`--keep-started`
// on the stop line only — each flag belongs to exactly one verb (see the CLI
// block below for why: stop reads phase off the file rather than taking it
// as a flag, and start has no dead marker of its own to walk away from or
// preserve), and showing a flag on the wrong line would tell the caller the
// opposite of what that verb actually accepts.
const START_STOP_USAGE = `usage: backlog.mjs start <id> [--as groom|execute]
       backlog.mjs stop <id> [--abandon] [--keep-started]`

// `github` is spelled out as a positional rather than accepted implicitly, even though it is the only value this build knows: the marker's `kind` names a
// platform, GitLab and Jira are named as later platforms in the same spec, and a command that has to grow a second one later would otherwise have to break its
// own call shape to do it. `owner/repo` is optional (derived from `origin` when absent) and shown in brackets to say so.
const CONNECT_USAGE = `usage: backlog.mjs connect github [owner/repo] [--no-forms]`

// `import`'s sibling, and the two differ in exactly one thing: `connect` points an EMPTY store at a tracker, `import` moves a populated one onto it. The extra
// two lines are here because both of this command's surprising properties are things a caller wants to know before it starts rather than after: it needs the
// stack up for every request it makes, and it deletes item files — at the very end, once every issue exists, but it does delete them.
const IMPORT_USAGE = `usage: backlog.mjs import github [owner/repo] [--no-forms]

moves every item file under backlog/ onto GitHub issues through the local API, which must be running.
the item files are deleted only after every issue exists and every cross-reference has been rewritten, and nothing is committed for you.`

// The three verbs that exist only in a tracker project. Each names the routes it needs, which is why they are not in files mode: there is no item file to
// heartbeat, no timeline to comment on, and a files body is edited by whoever is holding the file.
const HEARTBEAT_USAGE = `usage: backlog.mjs heartbeat <id>`
// `abort`'s only argument is the item, deliberately: there is no `--force`, and no flag naming the holder. Everything this verb is allowed to assert it
// works out for itself from the claim and from this machine — see the command block below for why an assertion a caller could type would be the shape
// bug-46 exists to stop being persuasive.
const ABORT_USAGE = `usage: backlog.mjs abort <id>`
const COMMENT_USAGE = `usage: backlog.mjs comment <id> --body <file>`
const BODY_USAGE = `usage: backlog.mjs body <id> --body <file> --if-updated-at <iso> [--runner-fix | --no-runner-fix]`

// `async` since task-46: a tracker project routes every command through the local API, and `fetch` is asynchronous. `files` mode makes no call at all, so a
// project with no marker runs exactly the synchronous code it always did — the `await`s below are never reached.
//
// The entry guard at the bottom of this file becomes `process.exitCode = await main(...)`, which is safe for the identical reason the synchronous form was:
// every asynchronous thing this file starts is awaited to completion before `main` returns, and the one socket it opens is closed by `connection: close`. See
// that guard's own comment.
export async function main(argv) {
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

    // A connected project is already initialised, and `init` says so and stops rather than creating nine empty directories beside a marker that says the
    // items are somewhere else. It still REGISTERS, which is the one thing a fresh clone needs before the board can serve it — and is why this is exit 0
    // rather than a refusal: `backlog-capture` runs `init` unconditionally as its first step, on every project, and a refusal here would make capturing into
    // a tracker project impossible. (Spec §6.5 says `init` refuses; the deviation is recorded in the task item's Outcome.)
    const mode = sourceMode(r.resolved.backlog)
    if (mode.kind === 'bad') {
      console.error(mode.message)
      return 1
    }
    if (mode.kind === 'api') {
      console.log(`already connected: ${r.resolved.root} → github ${mode.repo}`)
      registerBestEffort(r.resolved.root)
      return 0
    }

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
    let bodyFile
    let kind
    // Valueless, so it consumes no argv slot — unlike the three above, which all take the `argv[i + 1]` step.
    let runnerFix = false
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === '--from') {
        from = argv[i + 1]
        i++
      } else if (argv[i] === '--body') {
        bodyFile = argv[i + 1]
        i++
      } else if (argv[i] === '--kind') {
        kind = argv[i + 1]
        i++
      } else if (argv[i] === '--runner-fix') {
        runnerFix = true
      }
    }

    const r = resolveRootOrFail()
    if (!r.ok) return r.code

    const mode = sourceMode(r.resolved.backlog)
    if (mode.kind === 'bad') {
      console.error(mode.message)
      return 1
    }

    /* A tracker project has no path for a caller to write to, so `new` stops being "print what to write" and becomes the write itself — which is why `--body`
       is REQUIRED here and REFUSED in files mode. The two modes' contracts are opposites and deliberately so: in files mode the skill composes the body and
       writes the file, and a `--body` flag would be a second writer of item files; in API mode there is no file, so the body has to travel with the request. */
    if (mode.kind === 'api') {
      if (!bodyFile) {
        console.error(NEW_USAGE)
        return 1
      }
      try {
        const body = readTextFile(bodyFile, '--body')
        // `--from` accepts whatever `<id>` spelling the caller has; the server prepends `_From #<n>._` to the body.
        const payload = { project: registryRoot(r.resolved.root), section, title, body }
        if (from) payload.from = trackerId(from, mode.repo)
        /* A refactor's flavour, which a files capture writes as a `kind:` frontmatter line and a tracker carries as a `kind:*` label. It needs a flag because
           there is no file for the caller to add the line to. An unknown value is REFUSED by the server rather than dropped — GitHub creates an unknown label
           silently on first use, so a dropped one would surface as a mystery grey label instead of a complaint. */
        if (kind) payload.kind = kind
        /* The `runner-fix` marker (task-47), which a files capture writes as a frontmatter line and a tracker carries as a label. It needs a flag for the
           same reason `--kind` does — there is no file for the caller to add the line to — and the key is SENT ONLY WHEN SET: the route reads it with a
           strict `=== true`, so an absent key and `false` mean the same thing there, and sending `false` on every unmarked capture would put a field in
           every request body for a fact the absence already states. */
        if (runnerFix) payload.runnerFix = true
        const created = await apiPost('create', payload)
        console.log(created.id)
        console.log(created.url)
        console.log(created.urn)
      } catch (e) {
        if (!(e instanceof BacklogError)) throw e
        console.error(e.message)
        return e.code
      }
      registerBestEffort(r.resolved.root)
      return 0
    }

    if (bodyFile || kind) {
      console.error(NEW_USAGE)
      return 1
    }

    /* Its own sentence rather than the usage block the two flags above take, because the mistake is a different one. `--body` and `--kind` in files mode are
       a caller using the tracker CALL SHAPE — the usage text is the right answer, since it shows both shapes side by side. `--runner-fix` in files mode is a
       caller who knows exactly what they want and is asking the wrong writer for it: the marker is a frontmatter line, and `backlog-capture` (not this tool)
       is what composes a files item's frontmatter. Saying so is more use than reprinting two call shapes neither of which mentions frontmatter. */
    if (runnerFix) {
      console.error('--runner-fix is a tracker flag: in a files project the marker is a `runner-fix: true` frontmatter line, written into the item file')
      return 1
    }

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

    const r = requireStore()
    if (!r.ok) return r.code

    // Tolerant on purpose (see readOpenItems): a malformed item is reported
    // on stderr rather than aborting the whole board, so it never hides the
    // items that ARE readable. `problems` is checked once at the very end,
    // after whatever output below could still be produced.
    //
    // A tracker project reads the same board off `GET /api/items` and lands in the SAME rows: `{ id, section, title, created, ageDays, started }` is what the
    // printer below takes, and building it in two places keeps one printer rather than two that drift. The API's own `errors` array is this mode's
    // `problems`, which is the same tolerant contract one layer up — each entry is already subject-prefixed.
    let openItems
    let problems
    if (r.mode.kind === 'api') {
      const project = registryRoot(r.resolved.root)
      let index
      try {
        index = await apiGet('/api/items')
      } catch (e) {
        if (!(e instanceof BacklogError)) throw e
        console.error(e.message)
        return e.code
      }
      openItems = (index.items ?? [])
        .filter((it) => it.projectPath === project && it.status === 'open')
        .map((it) => ({ id: it.id, section: it.section, title: it.title, created: it.created, path: it.path, data: { started: it.started } }))
      problems = index.errors ?? []
    } else {
      ;({ items: openItems, problems } = readOpenItems(r.resolved.backlog))
    }
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
    const json = argv.includes('--json')

    const r = requireStore()
    if (!r.ok) return r.code

    /* In a tracker project `show` prints the BODY as well, and that is the one place its contract differs between the two modes — for the reason spec §6.5
       gives: there is no file for the skill to read afterwards. In files mode `show` deliberately prints the path and the frontmatter only, and the skill
       reads the file itself; here the three reads this makes (the item, its body, its claim) are the whole of what a skill can learn about an item. */
    if (r.mode.kind === 'api') {
      try {
        const project = registryRoot(r.resolved.root)
        const wanted = trackerId(id, r.mode.repo)
        const index = await apiGet('/api/items')
        const item = (index.items ?? []).find((it) => it.projectPath === project && it.id === wanted)
        if (item === undefined) throw new BacklogError(`no item ${wanted} in ${project}`, 1)

        const body = await apiGetText(`/api/items/body?path=${encodeURIComponent(item.path)}`)
        const claim = await apiGet(`/api/items/claim?project=${encodeURIComponent(project)}&id=${encodeURIComponent(wanted)}`)

        /* Who is asking, printed beside who holds the claim (bug-45). `show` was already reading the claim and showing it to nobody: the block said
           `started:` and `phase:` whether this session held the item or a machine two rooms away did, and the one variable that could tell them apart —
           `sessionIdentity()` — was never printed by any command. Two sessions on one issue is now the ordinary case, so the answer has to be readable
           without knowing the protocol exists: compare the two lines. */
        const session = sessionIdentity()

        if (json) {
          console.log(JSON.stringify({ urn: item.path, item, body, updatedAt: item.updated, claim, session }))
          return 0
        }

        // A frontmatter-SHAPED block rather than real frontmatter: an issue has none, and this is the one rendering that lets a skill written against the
        // files store read a tracker item without learning a second format. The keys are the ones a skill actually reads.
        console.log(item.path)
        console.log('---')
        console.log(`id: ${item.id}`)
        console.log(`title: ${item.title}`)
        console.log(`created: ${item.created}`)
        console.log(`updated: ${item.updated}`)
        console.log(`started: ${item.started}`)
        console.log(`phase: ${item.phase}`)
        // Empty rather than absent when nobody holds the issue: a key that disappears is a second shape for every reader to handle, and `claim-session:` with
        // nothing after it says "unheld" as plainly as a sentence would.
        const heldClaim = claim === null || claim.record.released !== undefined ? null : claim.record
        console.log(`claim-session: ${heldClaim === null ? '' : heldClaim.session}`)
        // And WHERE, when the claim recorded it (bug-46) — empty for a claim written before that field existed, which means "the machine was not recorded"
        // and never "this one". `this-host:` is always filled: a session always knows its own machine.
        console.log(`claim-host: ${heldClaim === null ? '' : (heldClaim.host ?? '')}`)
        console.log(`this-session: ${session}`)
        console.log(`this-host: ${hostIdentity()}`)
        console.log(`groom-elapsed: ${item.groomElapsed}`)
        console.log(`execute-elapsed: ${item.executeElapsed}`)
        console.log(`groom-tokens: ${item.groomTokens}`)
        console.log(`execute-tokens: ${item.executeTokens}`)
        console.log(`assignee: ${item.assignee ?? ''}`)
        console.log(`labels: ${(item.tags ?? []).join(', ')}`)
        console.log('---')
        console.log('')
        process.stdout.write(body)
      } catch (e) {
        if (!(e instanceof BacklogError)) throw e
        console.error(e.message)
        return e.code
      }
      return 0
    }

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

    let outcomeFile
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === '--outcome') {
        outcomeFile = argv[i + 1]
        i++
      }
    }

    const r = requireStore()
    if (!r.ok) return r.code

    /* `--outcome` is API-mode only, and refused in files mode for the same reason `new --body` is: in a files project the Outcome is already IN the file the
       caller wrote before calling `move`, and accepting a second copy of it here would make this command a writer of item bodies. On a tracker there is no
       file, so the closing comment is the only place that text can live. */
    if (r.mode.kind === 'api') {
      try {
        const payload = { project: registryRoot(r.resolved.root), id: trackerId(id, r.mode.repo), status: dest }
        if (outcomeFile) payload.outcome = readTextFile(outcomeFile, '--outcome')
        const moved = await apiPost('state', payload)
        console.log(moved.url)
      } catch (e) {
        if (!(e instanceof BacklogError)) throw e
        console.error(e.message)
        return e.code
      }
      return 0
    }

    if (outcomeFile) {
      console.error(MOVE_USAGE)
      return 1
    }

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

    // `--as` is start's flag; `--abandon` and `--keep-started` are both
    // stop's. All three are parsed here (not left for startItem/stopItem
    // alone) so each verb can refuse a flag that isn't its own before ever
    // touching the file. stop reads the phase off the file instead of
    // taking it as a flag: the file is the one place that can't disagree
    // with itself, and a --as here could name something other than what
    // start actually stored, which would leave no way to tell whether the
    // flag or the file was telling the truth. start, in turn, has no marker
    // of its own yet to walk away from or preserve — --abandon and
    // --keep-started only ever mean something to a stop that is about to
    // clear (or not clear) one. `new` and `board`, both above, scan their
    // own flags the same way.
    let phase
    let sawAsFlag = false
    let sawAbandonFlag = false
    let sawKeepStartedFlag = false
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--as') {
        sawAsFlag = true
        phase = argv[i + 1]
        i++
      } else if (argv[i] === '--abandon') {
        sawAbandonFlag = true
      } else if (argv[i] === '--keep-started') {
        sawKeepStartedFlag = true
      }
    }

    // The refusals below all print the shared usage text rather than a
    // phase-specific message: a missing value, a flag on the wrong verb, and
    // (Task 7) stop being handed two flags that fight each other are all
    // shape problems with the command line itself, the same class of error
    // the missing-id check above already reports this way — an unrecognised
    // (but present) value is the different case, and reaches startItem's own
    // validation below instead, which names the two accepted values
    // explicitly.
    if (cmd === 'stop' && sawAsFlag) {
      console.error(START_STOP_USAGE)
      return 1
    }
    if (cmd === 'start' && sawAbandonFlag) {
      console.error(START_STOP_USAGE)
      return 1
    }
    if (cmd === 'start' && sawKeepStartedFlag) {
      console.error(START_STOP_USAGE)
      return 1
    }
    if (sawAsFlag && phase === undefined) {
      console.error(START_STOP_USAGE)
      return 1
    }
    // Nobody needs `stop --abandon --keep-started` together, and inventing
    // semantics for it is speculative: abandoning already clears `started:`
    // same as a plain stop, so there is nothing left for `keep-started` to
    // preserve. Refused here, at the same command-line-shape level as the
    // flag-on-the-wrong-verb refusals above, rather than letting stopItem
    // silently decide which of the two flags wins.
    if (cmd === 'stop' && sawAbandonFlag && sawKeepStartedFlag) {
      console.error(START_STOP_USAGE)
      return 1
    }

    const r = requireStore()
    if (!r.ok) return r.code

    /* The tracker's start/stop is the claim protocol (spec §6.3), and it reproduces `startItem`/`stopItem`'s billing semantics exactly — the same four
       accumulating counters behind the same one gate — with the claim comment standing in for frontmatter, since a tracker item has none.
       Three differences from files mode, each of them forced rather than chosen:

         * `--as` is REQUIRED. The route needs a phase to bill against, where a files `start` can legitimately stamp `started:` with nothing to bill.
         * `stop` has to REDISCOVER the claim, because `start` and `stop` are two processes and the comment id is what identifies it. `GET /api/items/claim`
           is that read.
         * The CLI is the biller and sends totals. The server seeds a new claim from the newest prior one, so one comment is a whole history, and the side
           holding the clock and the transcript is the side that computes — exactly where `stopItem` already is. */
    if (r.mode.kind === 'api') {
      try {
        const project = registryRoot(r.resolved.root)
        const wanted = trackerId(id, r.mode.repo)
        const urn = `gh:${r.mode.repo}${wanted}`

        if (cmd === 'start') {
          if (phase === undefined) {
            console.error(`${START_STOP_USAGE}\n\nin a tracker project start needs --as: the claim records which phase is running`)
            return 1
          }
          const session = sessionIdentity()
          let claimed
          try {
            // `host` beside the session, never inside it (bug-46): the server must not derive one, because it may be running in the compose stack where
            // `os.hostname()` is a container id rather than the machine anybody is sitting at.
            claimed = await apiPost('claim', { project, id: wanted, phase, session, host: hostIdentity() })
          } catch (e) {
            /* A lost race is reported with the AGE of the holder's heartbeat, which the server computed on its own clock and put in the payload — the CLI
               must not subtract two clocks to get it. The age is the evidence a reader decides on: fresh means somebody is working it right now, stale past
               fifteen minutes means claim again and let the protocol retire it. Evidence alone was not enough — see the rule appended below. */
            if (e instanceof BacklogError && e.status === 409 && e.payload && e.payload.holder) {
              const h = e.payload.holder
              /* Both sides named, always (bug-45). The holder's id alone is unreadable: a session cannot tell whether `e33d0074` is somebody else or
                 itself, and the one that could not tell went on to groom an issue another machine was executing. */
              const sides = refusalSides(h.host, session)
              /* The rule rides on the line, not in the skill's prose alone (bug-47): this is the one sentence a losing session reliably reads, whatever
                 skill is driving it or none, and an age with no rule beside it reads as a countdown to when the item becomes takeable. */
              console.error(
                `${wanted} is already in progress (session ${h.session}${sides.theirs}, heartbeat ${roughAge(h.ageMs)} ago) — this session is ${sides.mine}` +
                  ` — losing the race ends this session's work on this item`,
              )
              return 1
            }
            throw e
          }
          console.log(urn)
          console.log(`claim ${claimed.commentId}`)
          // Said every time rather than in the skill's prose alone, because the failure it prevents is silent: a claim that stops answering is retired by the
          // next session that contests it, and the work carries on believing it still holds the item.
          console.log(`a claim reads stale after 15 min without a heartbeat — run backlog.mjs heartbeat ${wanted} between long steps`)
          return 0
        }

        const held = await apiGet(`/api/items/claim?project=${encodeURIComponent(project)}&id=${encodeURIComponent(wanted)}`)
        if (held === null || held.record.released !== undefined) {
          console.error(`${wanted} is not in progress`)
          return 1
        }

        const session = sessionIdentity()
        const ageMs = Math.max(0, Date.now() - Date.parse(held.record.heartbeat))
        if (held.record.session !== session && ageMs < CLAIM_STALE_MS) {
          console.error(
            `${wanted} is held by session ${held.record.session}${refusalSides(held.record.host, session).theirs} (heartbeat ${roughAge(ageMs)} ago) — not this one`,
          )
          return 1
        }

        const payload = { project, id: wanted, commentId: held.commentId, session, reason: sawAbandonFlag ? 'abandoned' : 'stopped' }
        /* `--abandon` sends NO counters at all, which is not the same as sending zeros: the server keeps whatever the claim was seeded with, and zeros would
           erase every earlier session's work on the item. Same reasoning `stopItem`'s own abandon branch carries — the interval was not work anyone did.
           `--keep-started` is accepted and inert here: a claim's `at` is permanent, so there is nothing for it to preserve. */
        if (!sawAbandonFlag) {
          const stamp = new Date().toISOString()
          const seconds = Math.max(0, Math.floor((Date.parse(stamp) - Date.parse(held.record.at)) / 1000))
          const counters = { ...held.record.counters }
          const elapsedKey = held.record.phase === 'execute' ? 'executeElapsed' : 'groomElapsed'
          const tokenKey = held.record.phase === 'execute' ? 'executeTokens' : 'groomTokens'
          counters[elapsedKey] = (counters[elapsedKey] ?? 0) + seconds
          // An unattributable count adds nothing rather than zero, the same rule `stopItem` follows: absence is a value, and `0` would read as a session that
          // spent nothing.
          const tokens = sessionTokensSince(held.record.at, stamp)
          if (typeof tokens === 'number' && Number.isFinite(tokens)) {
            counters[tokenKey] = (counters[tokenKey] ?? 0) + Math.max(0, Math.floor(tokens))
          }
          payload.counters = counters
        }

        await apiPost('release', payload)
        console.log(urn)
      } catch (e) {
        if (!(e instanceof BacklogError)) throw e
        console.error(e.message)
        return e.code
      }
      return 0
    }

    let itemPath
    try {
      itemPath = cmd === 'start'
        ? startItem(r.resolved.backlog, id, undefined, phase)
        : stopItem(r.resolved.backlog, id, undefined, { abandon: sawAbandonFlag, keepStarted: sawKeepStartedFlag })
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }

    console.log(itemPath)
    return 0
  }

  /* `abort <id>` — the human sibling of `orchestrate.mjs abort` (bug-48), and the fourth verb that exists only in a tracker project.
     It sits beside `start`/`stop` rather than with the three below because it is a claim verb: it releases, and it releases somebody else's claim.

     A hand-run session killed mid-item — the machine stopped, the terminal closed, anything that is not a terminal stage — passes through NO terminal stage,
     so it releases nothing. Every clause of the release rule then answers about somebody who no longer exists: the holder is gone, a hand claim carries no
     `run` by construction (deliberately, so a run can never evict a person at a terminal), and the claim is LIVE because `heartbeat` was re-stamped seconds
     before the kill. The item reads as in progress on every machine for a full fifteen minutes, its dispatch control disabled everywhere, with nothing to do
     but wait or delete the comment by hand — which destroys the record of the work and the counters that prove it.

     The server's new clause is `sameHost`, and **the PROOF behind it is this command's**. The server can see neither this filesystem nor this process table,
     so the refusals below are where the narrowness lives; they run in the order the evidence gets cheaper to trust, and the HOST check comes before the
     session-registry check because the registry check is meaningless without it (see `holdingSessionEvidence`).

     There is deliberately no `--force`, no flag naming the holder and no remote path. The first two are the fourth clause with no proof attached, assertable
     from a machine that cannot possibly know — the shape bug-46 exists to stop being persuasive. The third is honest about its limit: a machine that is
     switched off cannot prove anything, and the fifteen-minute window is the protocol's own repair for exactly that case. */
  if (cmd === 'abort') {
    const id = argv[1]
    if (!id) {
      console.error(ABORT_USAGE)
      return 1
    }

    const r = requireStore()
    if (!r.ok) return r.code

    // Refused in files mode the way the three verbs below are, and for the same reason: the command IS known, it just has no meaning against a store on
    // disk. There is no claim there to release — the marker is a `started:` line in the item file — and the files store's equivalent already exists.
    if (r.mode.kind !== 'api') {
      console.error(`files projects have no claim to abort: the marker is a \`started:\` line in the item file, and \`stop ${id} --abandon\` already clears it`)
      return 1
    }

    try {
      const project = registryRoot(r.resolved.root)
      const wanted = trackerId(id, r.mode.repo)

      const held = await apiGet(`/api/items/claim?project=${encodeURIComponent(project)}&id=${encodeURIComponent(wanted)}`)
      // A released claim has nothing to abort, and neither has an issue nobody holds. Same sentence `stop` prints for the same state.
      if (held === null || held.record.released !== undefined) {
        console.error(`${wanted} is not in progress`)
        return 1
      }

      /* A DEAD claim needs no abort at all: the next `start` retires it, which is the protocol's own repair path and the one `claim`'s step 5 already runs.
         Exit 0 and no request, because the caller's actual goal — the item is not blocking anybody — is already true, and a release nobody needed would
         only add a second record of a session that did nothing. */
      const ageMs = Math.max(0, Date.now() - Date.parse(held.record.heartbeat))
      if (ageMs >= CLAIM_STALE_MS) {
        console.log(`${wanted} was last beaten ${roughAge(ageMs)} ago, so the claim is already dead — the next start retires it and there is nothing to abort`)
        return 0
      }

      /* Refusal 1: this machine has to be the one the claim was made on. A claim that recorded no machine at all is the pre-bug-46 shape, and absence there
         means "the machine was not recorded" and never "this one" — so there is nothing to compare and nothing this command may conclude. Both refusals name
         what failed, and the cross-machine one names BOTH hosts, because "held elsewhere" with only one side printed is the reading bug-46 is made of. */
      const claimHost = typeof held.record.host === 'string' ? held.record.host.trim() : ''
      if (claimHost === '') {
        console.error(
          `${wanted} recorded no machine (a claim taken before claims carried one) — abort cannot tell whether its session is gone: wait out the 15 min window`,
        )
        return 1
      }
      if (claimHost !== hostIdentity()) {
        console.error(
          `${wanted} is held on ${claimHost} and this session is on ${hostIdentity()} — run abort there, or wait out the 15 min window`,
        )
        return 1
      }

      /* Refusal 2: nothing may show the holding session still running here. Without this, `abort` is a seizure rather than a repair — a second session on
         this same laptop could take an item out from under the person holding it at a terminal, which is the one thing host equality alone cannot stop. */
      const evidence = holdingSessionEvidence(held.record.session)
      if (evidence.state === 'alive') {
        console.error(
          `${wanted} is held by session ${held.record.session}, which is still running here: ${evidence.file} names it, and pid ${evidence.pid} is alive` +
            ` — not aborting a session that is running`,
        )
        return 1
      }
      /* Refusal 3 (bug-49): the registry could not be read, or reads in a shape this build does not understand. Fail closed — a misread there is what
         would turn a live neighbour into a dead one — and say the honest thing: nothing here can tell, so the protocol's own window is the answer. */
      if (evidence.state === 'unknown') {
        console.error(`${wanted}: abort cannot tell whether session ${held.record.session} is gone (${evidence.why}) — wait out the 15 min window`)
        return 1
      }

      /* `reason: 'aborted'` — the word `orchestrate.mjs abort` settled on in bug-40, because this is the same event: a session torn down without passing
         through a terminal stage. `host` is the assertion the server's fourth clause is decided on, and NO `counters` key is sent at all — `--abandon`'s
         rule, for `--abandon`'s reason: the stretch between the last heartbeat and the kill is not work anybody did, and zeros would erase what every
         earlier session on this item accumulated. No `runId` either: a person at a terminal has no run to speak for. */
      await apiPost('release', {
        project,
        id: wanted,
        commentId: held.commentId,
        session: sessionIdentity(),
        reason: 'aborted',
        host: hostIdentity(),
      })

      console.log(`gh:${r.mode.repo}${wanted}`)
      console.log(`claim ${held.commentId} released as aborted — its counters are left exactly as they were`)
      return 0
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }
  }

  /* Three more verbs that exist only in a tracker project (task-46, Decision 2 of the item) — `abort` directly above is the fourth, and stands apart
     because it is a claim verb rather than a route with no caller. Each of these three exists because one of §6.2's routes needs a caller:
     execute's failure-path Outcome (`comment`), groom's body patch (`body`), and liveness (`heartbeat`).

     In files mode each is exit 1 with its own sentence rather than a shared "unknown command", because the command IS known — it just has no meaning against a
     store on disk, and saying which is more use than pretending the verb does not exist. */
  if (cmd === 'heartbeat' || cmd === 'comment' || cmd === 'body') {
    const id = argv[1]
    const usage = cmd === 'heartbeat' ? HEARTBEAT_USAGE : cmd === 'comment' ? COMMENT_USAGE : BODY_USAGE
    if (!id) {
      console.error(usage)
      return 1
    }

    let bodyFile
    let ifUpdatedAt
    // Two valueless flags naming one tri-state field (task-47). Tracked as two booleans rather than one `runnerFix` variable so that "neither was passed"
    // and "both were passed" stay distinguishable — the first sends no key at all and the second is a usage error, and a single variable could express
    // neither.
    let wantRunnerFix = false
    let wantNoRunnerFix = false
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--body') {
        bodyFile = argv[i + 1]
        i++
      } else if (argv[i] === '--if-updated-at') {
        ifUpdatedAt = argv[i + 1]
        i++
      } else if (argv[i] === '--runner-fix') {
        wantRunnerFix = true
      } else if (argv[i] === '--no-runner-fix') {
        wantNoRunnerFix = true
      }
    }
    if ((cmd === 'comment' || cmd === 'body') && !bodyFile) {
      console.error(usage)
      return 1
    }
    if (cmd === 'body' && !ifUpdatedAt) {
      console.error(usage)
      return 1
    }
    /* Both flags together is a usage error rather than a last-one-wins, and it is refused HERE — before `requireStore`, before the mode is even resolved, so
       no request is made on any path. The two flags are opposite instructions about one label; picking one of them for the caller would silently add or
       remove a marker that decides whether an item hoists to the front of a run's queue. */
    if (wantRunnerFix && wantNoRunnerFix) {
      console.error('--runner-fix and --no-runner-fix are opposites: pass one or neither')
      return 1
    }

    const r = requireStore()
    if (!r.ok) return r.code

    if (r.mode.kind !== 'api') {
      const why =
        cmd === 'heartbeat'
          ? 'files projects have no heartbeat: a `started:` stamp in the item file is the marker, and nothing expires it'
          : cmd === 'comment'
            ? 'files projects have no comment timeline: write the text into the item file instead'
            : "files projects have no body route: edit the item file, which is the store's only writable surface"
      console.error(why)
      return 1
    }

    try {
      const project = registryRoot(r.resolved.root)
      const wanted = trackerId(id, r.mode.repo)

      if (cmd === 'heartbeat') {
        const held = await apiGet(`/api/items/claim?project=${encodeURIComponent(project)}&id=${encodeURIComponent(wanted)}`)
        if (held === null || held.record.released !== undefined) {
          console.error(`${wanted} is not in progress`)
          return 1
        }
        /* The session is sent and the SERVER decides (bug-45), rather than this reproducing `stop`'s local ownership test one command over: a heartbeat is an
           assertion about a comment on GitHub, and the process holding the token is the only one that can settle it against what is actually there. The
           refusal is rendered here, naming both sides, because a bare 409 from a command a skill runs between long steps tells the reader nothing. */
        const session = sessionIdentity()
        try {
          await apiPost('heartbeat', { project, id: wanted, commentId: held.commentId, session })
        } catch (e) {
          if (e instanceof BacklogError && e.status === 409 && e.payload && e.payload.holder) {
            const h = e.payload.holder
            const sides = refusalSides(h.host, session)
            console.error(`${wanted} is held by session ${h.session}${sides.theirs} (heartbeat ${roughAge(h.ageMs)} ago) — this session is ${sides.mine}`)
            return 1
          }
          throw e
        }
        console.log(`gh:${r.mode.repo}${wanted}`)
        return 0
      }

      const body = readTextFile(bodyFile, '--body')
      if (cmd === 'comment') {
        const posted = await apiPost('comment', { project, id: wanted, body })
        console.log(posted.url)
        return 0
      }

      /* Groom's write, and the ONE route that rewrites a body (§6.4). A 409 means somebody edited the issue between the `show --json` this caller read and
         this call — re-read and re-apply is the only safe answer, and the message says so rather than offering a force. */
      try {
        const payload = { project, id: wanted, body, ifUpdatedAt }
        /* Sent only when a flag said so, so a groom with no opinion leaves the label exactly as it is (task-47). That is the third state
           `ItemBodyRequest.runnerFix` declares, and it is the common one: most body patches are re-grooms and plan rewrites that have nothing to say about
           whether the item repairs the runner. */
        if (wantRunnerFix) payload.runnerFix = true
        else if (wantNoRunnerFix) payload.runnerFix = false
        const patched = await apiPost('body', payload)
        console.log(patched.updatedAt)
      } catch (e) {
        if (e instanceof BacklogError && e.status === 409) {
          const now = e.payload && typeof e.payload.updatedAt === 'string' ? e.payload.updatedAt : 'unknown'
          console.error(`${wanted} changed since you read it (now ${now}) — show it again and re-apply`)
          return 1
        }
        throw e
      }
      return 0
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }
  }

  // `connect github [owner/repo] [--no-forms]` — the first writer of the committed source marker.
  //
  // The refusals below run in a fixed order, and the order is the point: each one is cheaper and more certain than the next, and every one of them happens
  // BEFORE anything is written, so a refused connect leaves the project byte-identical. Nothing here is a partial write that a later refusal has to undo.
  //
  //   1. no git root            resolveRootOrFail, exit 2 — reused rather than re-worded, so "you are not in a repo" reads the same from every command
  //   2. a linked worktree      exit 1 — the marker belongs to the main tree the worktree merges back into; see below
  //   3. no repo and no origin  exit 1 — the one refusal with an obvious fix, so it names it
  //   4. item files on disk     exit 1 — `import`'s job, phase 5
  //   5. a marker already here  exit 1 — overwriting one silently changes a project's identity on every machine that pulls it
  if (cmd === 'connect') {
    const platform = argv[1]

    // Flags are scanned out of the tail rather than read positionally because `--no-forms` may legitimately appear where `owner/repo` would (`connect github
    // --no-forms` is the derive-from-origin spelling of it), and reading argv[2] blindly would take the flag for a repository name and then refuse it as a
    // malformed one — a refusal naming the wrong problem. More than one positional is a usage error rather than a "last one wins": two repo arguments mean the
    // caller believes something about this command that is not true, and picking one would write a marker they did not ask for.
    let forms = true
    const positional = []
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--no-forms') forms = false
      else positional.push(argv[i])
    }
    if (platform !== 'github' || positional.length > 1) {
      console.error(CONNECT_USAGE)
      return 1
    }

    const r = resolveRootOrFail()
    if (!r.ok) return r.code
    const { root, backlog } = r.resolved

    // The same refusal orchestrate.mjs makes, for a sibling reason and in its wording: a linked worktree is not a project root. The marker is committed and
    // read by every machine that clones this repo, and a per-item worktree is a temporary checkout that is deleted the moment its item merges — writing the
    // marker there would connect a directory that stops existing, while the project everyone else pulls stays on files. `linkedWorktreeInfo` is this file's
    // own helper and the discriminator is a `commondir` entry in the gitdir the `.git` file points at, never "`.git` is a file" (a submodule's is a file too,
    // and a submodule working tree IS a project root).
    const worktree = linkedWorktreeInfo(root)
    if (worktree) {
      const where = worktree.projectRoot
        ? `its project root is ${worktree.projectRoot} — re-run this command from there`
        : `its shared git dir is ${worktree.gitdir}, whose main working tree could not be determined (a bare main repo?) — re-run this command from the project root`
      console.error(
        `${worktree.worktree} is a linked git worktree, not a project root; ${where}. connect writes the project's own committed source marker, which belongs to the main tree a worktree merges back into`,
      )
      return 1
    }

    let repo = positional[0]
    if (repo === undefined) {
      const url = originRemoteUrl(root)
      if (url === null) {
        console.error(`no owner/repo given and ${root} has no origin remote to derive one from — pass it: backlog.mjs connect github <owner>/<repo>`)
        return 1
      }
      repo = parseOriginRepo(url)
      if (repo === null) {
        console.error(`no owner/repo given and origin (${url}) is not a github.com remote to derive one from — pass it: backlog.mjs connect github <owner>/<repo>`)
        return 1
      }
    }
    // Validated whichever way it arrived — a derived value has already passed REPO_SHAPE inside parseOriginRepo, so in practice this catches the hand-typed
    // one, and it is left covering both because the marker it writes is interpolated into an api.github.com URL path on every machine that reads it.
    if (!isValidRepo(repo)) {
      console.error(`not an owner/repo pair: ${JSON.stringify(repo)} — expected one slash, and only letters, digits, dot, dash and underscore either side`)
      return 1
    }

    // The populated-store refusal. `connect` is for an empty or absent store; a project whose items are already files needs them MOVED to the tracker, which is
    // `import`'s job — it writes this same marker itself, as its first step, and deletes the files as its last. Refusing outright rather than
    // connecting-and-leaving-the-files is the safe direction: the server reads the marker per request and a connected project contributes no file items at all,
    // so the files would not be deleted, they would simply stop being visible anywhere — the worst possible failure for a backlog, since nothing would report
    // them missing.
    const items = backlogItemFiles(backlog)
    if (items.length > 0) {
      const shown = items.slice(0, 3).join(', ')
      console.error(
        `${root} still has ${items.length} item file(s) under backlog/ (${shown}${items.length > 3 ? ', …' : ''}) — connect is for an empty or absent store; moving a populated one onto a tracker is \`import\`'s job: run \`backlog.mjs import github\` instead`,
      )
      return 1
    }

    // An existing marker is never overwritten, by this command or any other. The marker IS the project's source identity, committed and pulled by every
    // machine; rewriting it in place would move a project between sources with no record of the change beyond a diff nobody was told to look at, and the one
    // legitimate case (a repository that was renamed) is a one-line hand edit the operator can see and commit deliberately.
    const marker = path.join(backlog, SOURCE_MARKER)
    if (fs.existsSync(marker)) {
      console.error(`already connected: ${marker} exists — edit or delete it by hand to change this project's source`)
      return 1
    }

    writeSourceMarker(backlog, repo)
    const committable = [`backlog/${SOURCE_MARKER}`]
    let skipped = []
    if (forms) {
      const result = writeIssueForms(root)
      committable.push(...result.written)
      skipped = result.skipped
    }

    console.log(`connected ${root} to github ${repo}`)
    for (const rel of committable) console.log(`  wrote ${rel}`)
    for (const rel of skipped) console.log(`  skipped ${rel} (already present, left untouched)`)
    // The marker takes effect on the machine running the board, which is not necessarily this one and in the multi-machine case is the whole point — so it
    // does nothing at all until it is committed and pulled there. That makes the file list the actual last step of this command rather than a courtesy, which
    // is why it gets its own header and why the paths are printed bare: they are meant to be pasted into a `git add`.
    console.log('')
    console.log('commit these files — the marker does nothing until the machine running the board has pulled it:')
    for (const rel of committable) console.log(rel)
    return 0
  }

  // `import github [owner/repo] [--no-forms]` — `connect`'s sibling for a POPULATED store, and the one command in this file that moves a project between
  // sources (§8). It is also the only one that deletes item files.
  //
  // The shape is forced by the server rather than chosen here: the seven item write routes refuse a `files` project (`ItemsService.writerFor`), so the marker
  // has to be written BEFORE the first `create`. From that moment the board reads the tracker and ignores the files, which is what makes deleting them LAST
  // free — they are already invisible — and deleting them any earlier unrecoverable, since a pass that never ran is a file nothing has a copy of.
  //
  // Nine checks run before anything is written, and the order is the point: cheapest and most local first, the API probe LAST, because the probe is the only
  // one of them with an effect on anybody outside this process.
  //
  //   1. usage                    exit 1 — a platform this build cannot write to, or two repositories
  //   2. no git root              exit 2 — reused from `resolveRootOrFail`, so "you are not in a repo" reads the same from every command
  //   3. a linked worktree        exit 1 — the marker belongs to the main tree, exactly as `connect` says
  //   4. the marker               exit 1 — unreadable, an explicit `files` one, or a `github` one with nothing left to import
  //   5. an empty store           exit 1 — that is `connect`'s job, and saying so is more use than writing a marker nobody needed
  //   6. the repo                 exit 1 — positional or derived from `origin`, proved either way: the server interpolates it into an api.github.com path
  //   7. git state                exit 1 — `backlog/` committed, every item file tracked, HEAD on some `origin/*` ref (see `gitImportState`)
  //   8. the item files           exit 1 — every one parses, no OPEN item is in progress, no `kind:` the tracker has no label for
  //   9. the probe                exit 5 — `GET /api/items`, which is how "the stack is up" is decided before the marker goes down
  if (cmd === 'import') {
    const platform = argv[1]

    // Flags scanned out of the tail rather than read positionally, for `connect`'s reason: `import github --no-forms` is the derive-from-origin spelling, and
    // reading argv[2] blindly would refuse the flag as a malformed repository name — a refusal naming the wrong problem.
    let forms = true
    const positional = []
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--no-forms') forms = false
      else positional.push(argv[i])
    }
    if (platform !== 'github' || positional.length > 1) {
      console.error(IMPORT_USAGE)
      return 1
    }

    const r = resolveRootOrFail()
    if (!r.ok) return r.code
    const { root, backlog } = r.resolved

    // `connect`'s refusal, in its words, with this command's name in it: a linked worktree is a temporary checkout that is deleted when its item merges, and
    // the marker this command writes is committed and pulled by every machine that clones the repository.
    const worktree = linkedWorktreeInfo(root)
    if (worktree) {
      const where = worktree.projectRoot
        ? `its project root is ${worktree.projectRoot} — re-run this command from there`
        : `its shared git dir is ${worktree.gitdir}, whose main working tree could not be determined (a bare main repo?) — re-run this command from the project root`
      console.error(
        `${worktree.worktree} is a linked git worktree, not a project root; ${where}. import writes the project's own committed source marker, which belongs to the main tree a worktree merges back into`,
      )
      return 1
    }

    const marker = path.join(backlog, SOURCE_MARKER)
    const mode = sourceMode(backlog)
    if (mode.kind === 'bad') {
      console.error(mode.message)
      return 1
    }
    const itemFiles = backlogItemFiles(backlog)

    // Three answers out of the marker, and the middle one is the whole of resume mode: a `github` marker WITH item files left is an import that stopped part
    // way through, which is a state this command is required to be able to finish rather than a state anybody has to repair by hand.
    let repo
    let resuming = false
    if (mode.kind === 'api') {
      if (itemFiles.length === 0) {
        console.error(`${root} is already tracker-backed (${marker} names github ${mode.repo}) — nothing to import`)
        return 1
      }
      resuming = true
      repo = mode.repo
      // A positional repo that disagrees with the marker is refused rather than preferred: one of the two is wrong, and guessing which would either import into
      // somebody else's repository or re-import items that already exist in this one.
      if (positional[0] !== undefined && positional[0] !== repo) {
        console.error(`${marker} names ${repo}, not ${positional[0]}`)
        return 1
      }
    } else if (fs.existsSync(marker)) {
      // `files` with the file present is the EXPLICIT `{"kind":"files"}` marker. Never overwritten in place, by this command or any other: the marker is the
      // project's committed source identity, and a hand edit is a change the operator can see in a diff.
      console.error(`already has a source marker: ${marker} — delete it by hand first`)
      return 1
    } else {
      if (itemFiles.length === 0) {
        console.error(`no item files under ${backlog} — use \`backlog.mjs connect github\` for an empty store`)
        return 1
      }
      repo = positional[0]
      if (repo === undefined) {
        const url = originRemoteUrl(root)
        if (url === null) {
          console.error(`no owner/repo given and ${root} has no origin remote to derive one from — pass it: backlog.mjs import github <owner>/<repo>`)
          return 1
        }
        repo = parseOriginRepo(url)
        if (repo === null) {
          console.error(`no owner/repo given and origin (${url}) is not a github.com remote to derive one from — pass it: backlog.mjs import github <owner>/<repo>`)
          return 1
        }
      }
      if (!isValidRepo(repo)) {
        console.error(`not an owner/repo pair: ${JSON.stringify(repo)} — expected one slash, and only letters, digits, dot, dash and underscore either side`)
        return 1
      }
    }

    const git = gitImportState(root, itemFiles)
    if (git.dirty !== '') {
      console.error(`backlog/ has uncommitted changes — commit or stash them first:\n${git.dirty}`)
      return 1
    }
    if (git.untracked.length > 0) {
      console.error(`these item files are not tracked by git: ${git.untracked.join(', ')}`)
      return 1
    }
    if (git.sha === null) {
      console.error(`${root} has no commits yet — commit backlog/ and push before importing`)
      return 1
    }
    if (!git.pushed) {
      console.error(`HEAD ${git.sha.slice(0, 7)} is not on any origin/* branch — push first; the truncation link pins files at HEAD`)
      return 1
    }

    // Everything the two passes need, read once. A file that cannot be parsed, an item somebody is working and a `kind:` the tracker has no label for are all
    // refused HERE rather than discovered mid-pass: by then the marker is down, and the fix for each of the three is one line of frontmatter.
    const plan = []
    const inProgress = []
    for (const rel of itemFiles) {
      const abs = path.join(backlog, rel)
      let parsed
      try {
        parsed = readItemFile(abs)
      } catch (e) {
        if (!(e instanceof BacklogError)) throw e
        console.error(e.message)
        return e.code
      }
      const { section, status } = importPlace(rel)
      // The FILENAME is the id, not the frontmatter: `locateItem` resolves every id in this store by matching `<id>-` against directory entries, so the name is
      // what the rest of the store already agrees on, and a frontmatter `id:` that disagrees with it is a file nothing could find in the first place.
      const named = /^([a-z]+-\d+)-/.exec(path.basename(rel))
      const id = named === null ? (typeof parsed.data.id === 'string' && parsed.data.id !== '' ? parsed.data.id : rel) : named[1]
      const kind = typeof parsed.data.kind === 'string' ? parsed.data.kind.trim() : ''
      if (kind !== '' && kind !== 'chore' && kind !== 'debt') {
        console.error(`${id}: kind ${JSON.stringify(kind)} is not chore or debt — fix the frontmatter first`)
        return 1
      }
      // An open item with a stamp is somebody's live session, and the import would delete the file out from under it. The same stamp on a `done/` or
      // `out-of-scope/` file is history — the item is closed and nobody is holding it — so it is read past deliberately.
      if (status === 'open' && typeof parsed.data.started === 'string' && parsed.data.started.trim() !== '') inProgress.push(id)
      // A done item's `## Outcome` becomes the closing comment rather than part of the issue body (§8.3): GitHub renders a closing comment as the answer to
      // "what happened", which is exactly what that section is, and leaving it in the body would say it twice.
      const split = status === 'done' ? splitOutcome(parsed.body) : { rest: parsed.body, outcome: '' }
      plan.push({ id, relPath: rel, section, status, created: parsed.data.created, data: parsed.data, body: split.rest, outcome: split.outcome })
    }
    if (inProgress.length > 0) {
      console.error(`${inProgress.length} open item(s) are in progress — stop them first: ${inProgress.join(', ')}`)
      return 1
    }

    // The probe, last. It is how "the stack is up" is decided BEFORE the marker goes down — every request after this one needs the API, and a marker written
    // against a server that is not running is a project whose items are nowhere.
    let index
    try {
      index = await apiGet('/api/items')
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      console.error(e.message)
      return e.code
    }

    // --- the marker, then the writes (§8.2) ---------------------------------
    //
    // The marker goes down FIRST because the seven item write routes refuse a `files` project, and it is not rewritten on a resume: it is already this
    // project's committed identity, and re-writing a file to the bytes it already holds is a diff somebody has to read.
    if (!resuming) writeSourceMarker(backlog, repo)
    const committable = [`backlog/${SOURCE_MARKER}`]
    if (forms) {
      const result = writeIssueForms(root)
      committable.push(...result.written)
    }
    // The write routes gate `project` against the registry by a raw string compare, so a project nobody has registered cannot be written to at all. Best effort
    // for the reason `init` and `new` use it: a registry this command cannot update is not a reason to refuse an import, and the refusal it would cause instead
    // arrives from the server with its own sentence.
    registerBestEffort(root)
    const project = registryRoot(root)

    const ordered = importOrder(plan)
    const map = new Map()
    // What a resume already found on the tracker, keyed by OLD id: the issue's number, and the status the index reports for it.
    const resumedStatus = new Map()

    // --- the resume map (§8.6) ----------------------------------------------
    //
    // A resume rebuilds the map from the TRACKER, never from anything a previous run wrote down locally: the run that stopped half way through may have died
    // between two requests, so the only record that survived is the `bm:imported` footer on each issue it managed to create. Every body is read for it, because
    // the footer is the one place the old id appears — a title, a section and a label all belong to more than one item.
    if (resuming) {
      for (const row of (index.items ?? []).filter((it) => it.projectPath === project)) {
        const oldId = parseImportFooter(await apiGetText(`/api/items/body?path=${encodeURIComponent(row.path)}`))
        // An issue with no footer is somebody's own issue, filed on the tracker by hand — this import neither created it nor owns it, and reading a number off
        // it would map an item onto a stranger's work.
        if (oldId === null) continue
        map.set(oldId, Number(String(row.id).replace('#', '')))
        resumedStatus.set(oldId, row.status)
      }
      console.log(`resuming: ${map.size} of ${ordered.length} item(s) already imported`)
    }
    // One stamp for the whole command, so every synthetic claim this import takes carries the same session identity — they are one session's work, and a claim
    // per timestamp would read as a different importer for every item.
    const stamp = new Date().toISOString()
    const session = `import-${stamp}`
    // One request a second by default, which is what keeps a whole-store import inside GitHub's secondary rate limits (§8.3). Read once, so the suite can set
    // `0` and a slow repository can be given more. Reads are not paced — they cost a different budget and this command makes few of them.
    const paceRaw = Number(process.env.BM_IMPORT_PACE_MS ?? '1000')
    const paceMs = Number.isFinite(paceRaw) && paceRaw >= 0 ? paceRaw : 1000
    const pace = () => (paceMs === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, paceMs)))

    // Which item the next failure names. The operator's copy of this store is still FILES at this point, so the old id is the only name they can act on — an
    // issue number they have never seen would send them to a tracker to find out what broke.
    let at = null
    try {
      for (const item of ordered) {
        at = item.id

        // Already on the tracker, so this item's `create` is not made a second time — the footer said so, and a duplicate issue is the one failure a resume
        // exists to prevent. One repair happens here and nothing else: a `done/` file whose issue is still open is a run that died between `create` and
        // `state done`, and the close is idempotent from the operator's point of view because the issue carries neither the comment nor the closed state yet.
        // The counters are deliberately NOT re-billed — `claim`/`release` would add a second copy of them, and a doubled record of work is worse than one that
        // is merely missing a repair this command cannot detect.
        if (map.has(item.id)) {
          const mapped = `#${map.get(item.id)}`
          if (item.status === 'done' && resumedStatus.get(item.id) === 'open') {
            const repair = { project, id: mapped, status: 'done' }
            if (item.outcome !== '') repair.outcome = item.outcome
            await apiPost('state', repair)
            await pace()
          }
          console.log(`${item.id} → ${mapped} (already imported)`)
          continue
        }

        const footer = renderImportFooter({ id: item.id, created: item.data.created, tags: item.data.tags, relPath: item.relPath })
        // The cap is spent on the body, so the footer's length is taken out of it first: the footer is the idempotency key a resume reads, and a body that lost
        // it to truncation would be re-imported as a second issue.
        const fitted = fitBody(item.body.trimEnd(), IMPORT_BODY_CAP - footer.length - 2, blobLink(repo, git.sha, item.relPath))
        const issueBody = fitted.text === '' ? footer : `${fitted.text}\n\n${footer}`

        // `from:` is deliberately NOT sent. The route writes it as a `_From #<n>._` line composed from the OTHER item's issue number, and that number does not
        // exist yet for half the store — pass 2 writes the line itself, once every id is known.
        const payload = { project, section: item.section, title: item.data.title, body: issueBody }
        const kind = typeof item.data.kind === 'string' ? item.data.kind.trim() : ''
        if (kind !== '') payload.kind = kind
        // Presence, not truth, exactly as `parseItemForGate` reads the same marker: a `runner-fix:` key with any value but `false` means the human who groomed
        // the item said it repairs the runner.
        if ('runner-fix' in item.data && String(item.data['runner-fix']).trim() !== 'false') payload.runnerFix = true

        const created = await apiPost('create', payload)
        const number = created.number
        map.set(item.id, number)
        const ref = `#${number}`
        await pace()

        // The four counters are a permanent record of work somebody did, and the tracker keeps them in a claim comment (§6.4) — so an item that has any is
        // given one synthetic claim and that claim is released immediately with the counters billed onto it. Before the close, always: `claim` refuses a closed
        // issue, and a `done/` item is about to be closed two requests from here.
        const counters = countersOf(item.data)
        if (counters !== null) {
          const claimed = await apiPost('claim', { project, id: ref, phase: 'execute', session })
          await pace()
          await apiPost('release', { project, id: ref, commentId: claimed.commentId, session, reason: 'imported', counters })
          await pace()
        }

        // Two closed shapes and only one of them needs a request: `create` with `section: 'out-of-scope'` already closed a rejected item `not_planned`, and an
        // open item is not closed at all. `state done` is what posts the Outcome comment and then closes `completed`, in that order, inside the adapter.
        if (item.status === 'done') {
          const closing = { project, id: ref, status: 'done' }
          if (item.outcome !== '') closing.outcome = item.outcome
          await apiPost('state', closing)
          await pace()
        }

        console.log(`${item.id} → ${ref}${fitted.truncated ? ' (truncated)' : ''}`)
      }
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      // A 429 carries the reset TIME as its own field, so the line prints what the server said rather than a duration this file worked out — the two disagree
      // the moment anything is slow, and the operator is going to wait against a clock either way. No retry and no skip: an import that skipped an item would
      // delete its file at the end with nothing on the tracker carrying it.
      const resetAt = e.payload && typeof e.payload.resetAt === 'string' ? ` — retry after ${e.payload.resetAt}` : ''
      console.error(`import stopped at ${at}: ${e.message}${resetAt}`)
      return e.code
    }

    // --- pass 2: the cross-links (§8.4) -------------------------------------
    //
    // A separate pass because a rewrite needs the WHOLE map: `task-1` cites `bug-2`, whose issue did not exist when `task-1`'s body was composed, and an import
    // that patched as it went would leave every backward reference unresolved. The bodies are read back from the tracker rather than re-composed from the files,
    // so this pass patches what is actually there — including, on a resume, an issue a previous run created.
    try {
      const after = await apiGet('/api/items')
      const rows = (after.items ?? []).filter((it) => it.projectPath === project)
      for (const item of ordered) {
        at = item.id
        const ref = `#${map.get(item.id)}`
        const row = rows.find((it) => it.id === ref)
        // The index is the server's cached view of the repository, so an issue this command just created can be missing from it if the poller has not caught up.
        // A refusal rather than a re-read: the marker is down and every issue exists, so a re-run resumes from the footers and finishes the job.
        if (row === undefined) throw new BacklogError(`${ref} is not in the index yet — re-run import to resume`, 1)

        const current = await apiGetText(`/api/items/body?path=${encodeURIComponent(row.path)}`)
        let next = rewriteOldIds(current, map)
        // `from:` has no field on an issue, so it becomes the first line of the body. An unmapped source keeps its old id: the FACT that this item came from
        // something is worth more than the link, and an id somebody can grep the repository's history for is not a dead end.
        //
        // Only when the body does not already open with it: a resume re-patches every issue a previous pass 2 reached, and prepending unconditionally stacks
        // one more `_From_` line on each of them per re-run.
        const from = typeof item.data.from === 'string' ? item.data.from.trim() : ''
        if (from !== '' && !next.startsWith('_From ')) next = `${map.has(from) ? `_From #${map.get(from)}._` : `_From ${from}._`}\n\n${next}`

        // An unchanged body is not patched. The route posts no comment, but an edit is still an event on somebody's timeline and a new `updatedAt` for every
        // reader; a no-op edit would say something changed when nothing did.
        if (next !== current) {
          await apiPost('body', { project, id: ref, body: next, ifUpdatedAt: row.updated })
          await pace()
        }
      }
    } catch (e) {
      if (!(e instanceof BacklogError)) throw e
      const resetAt = e.payload && typeof e.payload.resetAt === 'string' ? ` — retry after ${e.payload.resetAt}` : ''
      console.error(`import stopped at ${at}: ${e.message}${resetAt}`)
      return e.code
    }

    // --- the deletion (§8.5) ------------------------------------------------
    //
    // Last, and outside both `try` blocks on purpose: every issue exists and every body is final, so the files are now a second copy of items the tracker owns.
    // A `try/finally` around either pass would be exactly wrong — a failure must leave the files, because the file is the only copy of anything the failed pass
    // never created. `README.md` and the marker are not item files and are never touched (`backlogItemFiles` is scoped to the nine leaf directories).
    const deleted = []
    for (const item of ordered) {
      fs.unlinkSync(path.join(backlog, item.relPath))
      deleted.push(`backlog/${item.relPath}`)
    }

    console.log(`imported ${ordered.length} item(s) into github ${repo}`)
    // The marker takes effect on the machine running the board, which is not necessarily this one, and the deletions are what stop the files from being read
    // there — so both halves have to be committed together, and the list is printed bare to be pasted into a `git add`.
    console.log('')
    console.log('commit these files — the marker does nothing until the machine running the board has pulled it:')
    for (const rel of committable) console.log(rel)
    for (const rel of deleted) console.log(rel)
    return 0
  }

  // The registry's one removal path, and the only command in this file that
  // takes a project path instead of deriving one. That is deliberate: every
  // other verb here acts on the repo you are standing in, but a bare
  // `unregister` that silently dropped whatever project that happened to be is
  // an accident the registry has no undo for — and the entry most likely to
  // need removing names a directory you cannot stand in, because it no longer
  // exists. Resolved against cwd so a relative argument works, which leaves an
  // absolute one byte-identical apart from normalisation; the compare against
  // the stored path is exact either way, matching the upsert's own key.
  //
  // A path that is not registered is exit 1, never a silent success: the
  // overwhelmingly likely cause is a typo, and reporting "unregistered" for a
  // no-op would hide it behind the very reassurance the caller was looking for.
  if (cmd === 'unregister') {
    const target = argv[1]
    if (!target) {
      console.error(UNREGISTER_USAGE)
      return 1
    }

    const resolved = path.resolve(target)
    let removed
    try {
      removed = unregisterProject(resolved)
    } catch (e) {
      console.error(`registry update failed: ${e.message}`)
      return 1
    }

    if (!removed) {
      console.error(`not registered: ${resolved}`)
      return 1
    }
    console.log(`unregistered ${resolved}`)
    return 0
  }

  console.error(`unknown command: ${cmd ?? '(none)'}\n\n${USAGE}`)
  return 1
}

// `process.exitCode`, NOT `process.exit()` — the same rule all three skill
// CLIs follow, and retro.mjs's entry guard carries the full record of the
// incident behind it (see retro.mjs, just above its own guard): writing to a
// PIPE is asynchronous, so `process.exit()` tears the process down undrained
// and a `--json` payload is cut at exactly 65,536 bytes, while a `> file.json`
// redirect — synchronous on POSIX — stays perfectly fine, which is why every
// hand check passed. Safe for THIS file specifically because nothing in it
// holds the event loop open: every read is synchronous `fs`, its one child
// process (`connect`'s `git remote get-url`) is a `spawnSync` that is reaped
// before the call returns, and there is no timer and no server anywhere in it.
// A future edit that adds one must close its handle rather than restore
// `process.exit()`, which would bring the truncation back with it.
//
// `await main(...)` since task-46, and the invariant's reasoning is untouched by the `await` — it is `process.exit()` that truncates a pipe, not asynchrony.
// What the rule actually requires is that nothing be left holding the event loop open when `main` returns, and API mode keeps that: every `fetch` is awaited
// to completion before the value comes back, and each one sends `connection: close`, so no pooled socket outlives the call. Assert it rather than trust it —
// `backlog.test.mjs`'s API-mode children are expected to EXIT, not to hang.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
