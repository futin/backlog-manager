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
export const PUBLISHED_PATHS = ['skills', '.claude-plugin']

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLED = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')

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
  const repoHash = hashTree(join(REPO_ROOT, 'skills'))
  const installedHash = hashTree(join(install.installPath, 'skills'))

  if (installedHash === repoHash && install.gitCommitSha === head) {
    console.log(`in sync — installed v${install.version} is ${head.slice(0, 7)}, same skills as the working tree`)
    return
  }

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

  const run = (args) => execFileSync('claude', args, { stdio: 'inherit' })
  run(['plugin', 'marketplace', 'update', MARKETPLACE])
  run(['plugin', 'update', PLUGIN_ID, '-y'])

  const after = readInstall()
  if (!after) {
    console.error('the plugin is no longer installed after the update')
    process.exit(1)
  }
  if (hashTree(join(after.installPath, 'skills')) !== repoHash) {
    // The cache directory is keyed by the version in plugin.json, so an
    // update that carries new skills under an unchanged version has to
    // overwrite in place. When it doesn't, a version bump is the lever.
    console.error(`installed skills still differ from the repo at ${after.installPath}`)
    console.error(`installed commit ${after.gitCommitSha?.slice(0, 7) ?? 'unknown'}, repo HEAD ${head.slice(0, 7)}`)
    console.error('bump the patch version in .claude-plugin/plugin.json, commit, push, and run this again')
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
