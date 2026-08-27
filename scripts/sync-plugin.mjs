#!/usr/bin/env node
// Reinstalls this repo's own plugin into ~/.claude/plugins so the installed
// copy of the skills matches the working tree.
//
// It exists because the marketplace source here is `directory` pointing at
// this repo, and a directory install is a *copy*, not a link: editing
// skills/ in the repo changes nothing for the running Claude Code until the
// plugin is reinstalled. That gap is silent and it bites — the `started`
// marker shipped in fcd3d16 and the installed plugin never grew it.
//
// The cache path is keyed by the version in .claude-plugin/plugin.json, so
// a bump is not cosmetic: it is what makes `claude plugin update` land in a
// new directory instead of trusting the one already there. Hence bump first,
// update second.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ID = 'backlog-manager@backlog-manager-marketplace'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(REPO_ROOT, '.claude-plugin', 'plugin.json')
const INSTALLED = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')

// Only the patch digit moves. A directory-source install has no release
// meaning attached to it — the number's whole job is to be a fresh cache key
// — so anything cleverer would be pretending the version says something it
// doesn't.
export function bumpPatch(version) {
  const parts = version.split('.')
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`version "${version}" is not major.minor.patch — bump it by hand`)
  }
  parts[2] = String(Number(parts[2]) + 1)
  return parts.join('.')
}

// Hashes path + bytes, not just bytes, so a rename or a deletion changes the
// digest too. Sorted, because readdir order is not a promise.
export function hashTree(root) {
  if (!existsSync(root)) return ''
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
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

// The installed record is the only thing that knows where the copy landed;
// the cache path embeds the version, so it can't be reconstructed from the
// repo alone once the two have drifted.
export function readInstall(installedPath = INSTALLED) {
  if (!existsSync(installedPath)) return undefined
  const entries = JSON.parse(readFileSync(installedPath, 'utf8'))?.plugins?.[PLUGIN_ID]
  if (!Array.isArray(entries)) return undefined
  return entries.find((entry) => entry.scope === 'user') ?? entries[0]
}

function du(dir) {
  try {
    return execFileSync('du', ['-sh', dir], { encoding: 'utf8' }).split('\t')[0].trim()
  } catch {
    return '?'
  }
}

// Every install leaves a full copy of this repo behind — node_modules, dist
// and all, ~200MB a time — and nothing reaps the old ones. The CLI has no
// ignore file (checked against 2.1.246: no .claudeignore, no .pluginignore),
// so the copy size is not ours to shrink; the count of copies is. Anything
// that is not the version we just installed goes.
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
      console.log(`  kept ${entry.name} (.in_use — a session still has it open)`)
      continue
    }
    const size = du(stale)
    rmSync(stale, { recursive: true, force: true })
    removed.push(`${entry.name} (${size})`)
  }
  return removed
}

function main() {
  const force = process.argv.includes('--force')
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const repoHash = hashTree(join(REPO_ROOT, 'skills'))

  const install = readInstall()
  if (!install) {
    console.error(`${PLUGIN_ID} is not installed. Install it once, then this script keeps it current:`)
    console.error(`  claude plugin install ${PLUGIN_ID}`)
    process.exit(1)
  }

  const installedHash = hashTree(join(install.installPath, 'skills'))
  if (installedHash === repoHash && !force) {
    console.log(`in sync — installed ${PLUGIN_ID} v${install.version} already carries these skills`)
    console.log(`  ${install.installPath}`)
    return
  }

  const from = manifest.version
  manifest.version = bumpPatch(from)
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`skills changed → plugin.json ${from} → ${manifest.version}`)

  // A directory-source marketplace reads straight from the repo, so this is
  // usually a no-op — run anyway, because a marketplace that has cached the
  // old version number would otherwise refuse the update it can't see.
  const run = (args) => execFileSync('claude', args, { stdio: 'inherit' })
  run(['plugin', 'marketplace', 'update', 'backlog-manager-marketplace'])
  run(['plugin', 'update', PLUGIN_ID, '-y'])

  const after = readInstall()
  if (!after || after.version !== manifest.version) {
    console.error(`update did not land: expected v${manifest.version}, installed reports v${after?.version ?? 'none'}`)
    process.exit(1)
  }
  if (hashTree(join(after.installPath, 'skills')) !== repoHash) {
    console.error(`installed skills still differ from the repo at ${after.installPath}`)
    process.exit(1)
  }

  console.log(`installed v${after.version} → ${after.installPath} (${du(after.installPath)})`)
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
