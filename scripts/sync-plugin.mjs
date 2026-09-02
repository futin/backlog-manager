#!/usr/bin/env node
// Reinstalls this repo's own plugin into ~/.claude/plugins so the installed
// copy of the skills matches what this repo has published.
//
// It exists because a plugin install is a *copy*, not a link: editing
// skills/ changes nothing for the running Claude Code until the plugin is
// reinstalled. That gap is silent and it bites — the `started` marker
// shipped in fcd3d16 and the installed plugin sat on the first commit for
// weeks.
//
// The marketplace source is the private GitHub repo (SSH), sparse-checked
// out to `.claude-plugin skills`, so what lands is ~400KB of tracked files
// rather than the ~215MB full-directory copy the old `directory` source
// made — node_modules, dist and all, since the CLI honours no ignore file.
// The price of that is git's own rule: the installer sees committed,
// pushed work and nothing else. So this script refuses to run on anything
// less rather than installing stale code and reporting success.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ID = 'backlog-manager@backlog-manager-marketplace'
export const MARKETPLACE = 'backlog-manager-marketplace'

// The paths the marketplace sparse-checkout carries. Anything a skill needs
// at runtime has to live under one of them, so the check below is not
// paranoia: a skill that reaches outside these is broken once installed,
// and broken in a way that only shows up on someone else's machine.
//
// `agents` joined this list once backlog-reviewer (agents/backlog-reviewer.md)
// existed to publish: Claude Code discovers a plugin's agents the same way it
// discovers skills, by walking a root-level directory in the installed copy,
// so an agent left out of this list is invisible post-install even though it
// sits right there in the repo. This list is only this script's half of that
// fix — the other half is each machine's own sparse checkout, declared in
// ~/.claude/settings.json under
// extraKnownMarketplaces.<marketplace>.source.sparsePaths (NOT in
// known_marketplaces.json, which is a cache reconciled from it on session
// start), and that declaration needs `agents` too before the agent resolves.
// missingSparsePaths warns about the gap; the post-install check fails on it.
export const PUBLISHED_PATHS = ['skills', '.claude-plugin', 'agents']

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLED = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
// The *declaration* of what the marketplace sparse-checks out. Its cache,
// ~/.claude/plugins/known_marketplaces.json, is re-materialized from this file
// on every session start, so this is the copy worth reading and the only one
// worth telling anyone to edit. Read-only here: see missingSparsePaths.
const SETTINGS = join(homedir(), '.claude', 'settings.json')

const git = (args, cwd = REPO_ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// Hashes path + bytes, not just bytes, so a rename or a deletion changes the
// digest too. Sorted, because readdir order is not a promise.
export function hashTree(root) {
  if (!existsSync(root)) return ''
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(root)
  const digest = createHash('sha256')
  for (const file of files.sort()) {
    digest.update(relative(root, file).split('\\').join('/'))
    digest.update('\0')
    digest.update(readFileSync(file))
    digest.update('\0')
  }
  return digest.digest('hex')
}

// One digest per published path, keyed by the path. This replaced a lone
// hashTree('skills') pair that was the whole of bug-10: `agents/` was never
// hashed on either side, so an install whose sparse checkout had never written
// it at all was indistinguishable from a complete one, and the short-circuit
// below declined to reinstall forever — the one path it measured never moved.
//
// hashTree answers '' for a root that is not there, so an absent path *is*
// drift here with no separate existence check to keep in sync. `gitCommitSha`
// cannot cover for this: it records which commit the install was cloned from,
// not which paths the sparse checkout wrote out of it, and the same sha
// legitimately yields an install with or without `agents/`.
export function publishedDigests(root) {
  return Object.fromEntries(PUBLISHED_PATHS.map((path) => [path, hashTree(join(root, path))]))
}

// The published paths whose digests disagree, in PUBLISHED_PATHS order rather
// than object-key order, so the reason a reinstall is happening reads the same
// way every run.
export function driftedPaths(repoDigests, installDigests) {
  return PUBLISHED_PATHS.filter((path) => repoDigests[path] !== installDigests[path])
}

// The published paths this machine's marketplace declaration leaves out of its
// sparse checkout — the reason an install can come up short of the repo even
// when the sync did everything right.
//
// Two silences are deliberate. No `sparsePaths` key at all clones the whole
// repo, which carries every published path by definition. And a declaration
// this script cannot see is not a declaration that is wrong: the lever
// legitimately lives at any settings tier (user, project, local, managed) or in
// `claude plugin marketplace add --sparse`, so an absent entry warns about
// nothing. The post-install check is the authoritative one; this is a hint.
export function missingSparsePaths(settings, marketplace = MARKETPLACE) {
  const declared = settings?.extraKnownMarketplaces?.[marketplace]?.source?.sparsePaths
  if (!Array.isArray(declared)) return []
  return PUBLISHED_PATHS.filter((path) => !declared.includes(path))
}

// Absent, unreadable or malformed settings all mean the same thing to the
// caller — nothing to hint from — so they collapse into one undefined.
export function readSettings(settingsPath = SETTINGS) {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return undefined
  }
}

// The installed record is the only thing that knows where the copy landed
// and which commit it came from; neither is reconstructable from the repo
// once the two have drifted.
export function readInstall(installedPath = INSTALLED) {
  if (!existsSync(installedPath)) return undefined
  const entries = JSON.parse(readFileSync(installedPath, 'utf8'))?.plugins?.[PLUGIN_ID]
  if (!Array.isArray(entries)) return undefined
  return entries.find((entry) => entry.scope === 'user') ?? entries[0]
}

// Returns the reason this tree cannot be published, or undefined when it
// can. Split out from main so the tests can drive it with fake git output
// rather than a real repo in a broken state.
export function publishBlocker({ dirty, ahead, behind }) {
  if (dirty.length > 0) {
    return `uncommitted changes under ${PUBLISHED_PATHS.join('/, ')}/:\n${dirty.map((f) => `  ${f}`).join('\n')}\n` +
      'The installer reads git, not the working tree — commit these first.'
  }
  if (ahead > 0) {
    return `HEAD is ${ahead} commit(s) ahead of origin/main. The marketplace clones from GitHub, so push first:\n  git push`
  }
  if (behind > 0) {
    return `HEAD is ${behind} commit(s) behind origin/main — pull before syncing, or the install will move backwards:\n  git pull --ff-only`
  }
  return undefined
}

function du(dir) {
  try {
    return execFileSync('du', ['-sh', dir], { encoding: 'utf8' }).split('\t')[0].trim()
  } catch {
    return '?'
  }
}

// The old `directory` source left a full ~215MB copy of the repo per
// version and nothing reaped them. The sparse git source makes new copies
// small, but the fat ones from before are still on disk, so the prune stays.
function pruneOldVersions(installPath, keptVersion) {
  const versionsDir = dirname(installPath)
  if (!existsSync(versionsDir)) return []
  const removed = []
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keptVersion) continue
    const stale = join(versionsDir, entry.name)
    // .in_use marks a copy some running session still has open. Leaving it
    // is the conservative call: a stale directory costs disk, a yanked one
    // costs somebody's session mid-command.
    if (existsSync(join(stale, '.in_use'))) {
      console.log(`  kept ${entry.name} (${du(stale)}, .in_use — a session still has it open)`)
      continue
    }
    const size = du(stale)
    rmSync(stale, { recursive: true, force: true })
    removed.push(`${entry.name} (${size})`)
  }
  return removed
}

function main() {
  const install = readInstall()
  if (!install) {
    console.error(`${PLUGIN_ID} is not installed. Install it once, then this script keeps it current:`)
    console.error(`  claude plugin install ${PLUGIN_ID}`)
    process.exit(1)
  }

  const head = git(['rev-parse', 'HEAD'])
  const repoDigests = publishedDigests(REPO_ROOT)
  const drifted = driftedPaths(repoDigests, publishedDigests(install.installPath))

  if (drifted.length === 0 && install.gitCommitSha === head) {
    // Name what was compared. The old wording — "same skills as the working
    // tree" — was true and read as "the install is current", which is how an
    // install with no agents/ at all went unnoticed through repeated syncs.
    console.log(`in sync — installed v${install.version} is ${head.slice(0, 7)}, same ${PUBLISHED_PATHS.join(', ')} as the working tree`)
    return
  }

  console.log(drifted.length > 0
    ? `reinstalling — ${drifted.join(', ')} differ(s) from the working tree`
    : `reinstalling — installed commit ${install.gitCommitSha?.slice(0, 7) ?? 'unknown'}, repo HEAD ${head.slice(0, 7)}`)

  // origin is the marketplace's actual source, so its idea of main is what
  // gets installed. Fetch before comparing or a stale ref makes a pushed
  // tree look unpushed.
  git(['fetch', '--quiet', 'origin', 'main'])
  const blocker = publishBlocker({
    dirty: git(['status', '--porcelain', '--', ...PUBLISHED_PATHS]).split('\n').filter(Boolean),
    ahead: Number(git(['rev-list', '--count', 'origin/main..HEAD'])),
    behind: Number(git(['rev-list', '--count', 'HEAD..origin/main'])),
  })
  if (blocker) {
    console.error(blocker)
    process.exit(1)
  }

  // Before anything is removed, not after: the actionable line has to be
  // readable rather than buried under install output. It only ever warns —
  // aborting here is fine, but this check must never be able to abort between
  // the uninstall and the install, the one window that leaves the machine with
  // no plugin at all.
  const undeclared = missingSparsePaths(readSettings())
  if (undeclared.length > 0) {
    console.warn(`warning: ${SETTINGS} declares this marketplace without ${undeclared.join(', ')} —`)
    console.warn(`  extraKnownMarketplaces.${MARKETPLACE}.source.sparsePaths`)
    console.warn('  the install will come up short of the repo until those are added there.')
  }

  const run = (args) => execFileSync('claude', args, { stdio: 'inherit' })
  run(['plugin', 'marketplace', 'update', MARKETPLACE])

  // Not `plugin update`: that compares the version in plugin.json and stops
  // at "already at the latest version (0.1.1)" no matter how far the commit
  // behind it has moved. The cache directory is keyed by version, so the
  // only ways past it are a patch bump on every skills edit — which is
  // another commit and another push before anything installs — or this:
  // uninstall, install, and let the fresh clone carry whatever HEAD says.
  // The reinstall is cheap precisely because the source is sparse (~400KB).
  run(['plugin', 'uninstall', PLUGIN_ID])
  try {
    run(['plugin', 'install', PLUGIN_ID, '-y'])
  } catch (error) {
    // The uninstall already happened, so a failure here leaves the machine
    // with no plugin at all. Say so plainly and hand over the one command
    // that fixes it rather than letting a stack trace imply a smaller mess.
    console.error(`install failed after the uninstall — ${PLUGIN_ID} is NOT installed right now.`)
    console.error(`  claude plugin install ${PLUGIN_ID}`)
    throw error
  }

  const after = readInstall()
  if (!after) {
    console.error('the plugin is no longer installed after the update')
    process.exit(1)
  }
  const afterDigests = publishedDigests(after.installPath)
  const stillDrifted = driftedPaths(repoDigests, afterDigests)
  if (stillDrifted.length > 0) {
    // This is the load-bearing half of the bug-10 fix: it turns "the reviewer
    // agent silently is not there" into a red sync naming the file to edit.
    console.error(`installed ${stillDrifted.join(', ')} still differ(s) from the repo at ${after.installPath}`)
    console.error(`installed commit ${after.gitCommitSha?.slice(0, 7) ?? 'unknown'}, repo HEAD ${head.slice(0, 7)}`)

    // A reinstall that completed and still has *nothing* at a published path
    // is the sparse-checkout shortfall by elimination — the clone never
    // carried it, so no reinstall through any route can produce it.
    const absent = stillDrifted.filter((path) => afterDigests[path] === '')
    if (absent.length > 0) {
      console.error(`\n${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} absent from the install entirely, which is the sparse checkout, not this sync. Add ${absent.length === 1 ? 'it' : 'them'} here:`)
      console.error(`  ${SETTINGS} → extraKnownMarketplaces.${MARKETPLACE}.source.sparsePaths`)
      console.error('Not known_marketplaces.json — that file is a cache reconciled from the above on the next session start, so an edit to it is reverted (and is itself what triggers the revert).')
      console.error('Then start a Claude Code session so the marketplace clone is re-sparsed, and run this again.')
    } else {
      // The cache directory is keyed by the version in plugin.json, so an
      // update that carries new files under an unchanged version has to
      // overwrite in place. When it doesn't, a version bump is the lever.
      console.error('the install carries every published path but not the current bytes — a version bump in plugin.json is the lever.')
    }
    process.exit(1)
  }

  console.log(`installed v${after.version} @ ${after.gitCommitSha?.slice(0, 7) ?? '?'} → ${after.installPath} (${du(after.installPath)})`)
  const removed = pruneOldVersions(after.installPath, after.version)
  if (removed.length > 0) console.log(`pruned ${removed.length} stale copy/copies: ${removed.join(', ')}`)
  console.log('restart Claude Code for the new skills to load')
}

// Guarded so the test file can import the helpers without reinstalling
// anything as a side effect.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
