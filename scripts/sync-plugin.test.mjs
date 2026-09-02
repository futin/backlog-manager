import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  MARKETPLACE,
  PLUGIN_ID,
  PUBLISHED_PATHS,
  driftedPaths,
  hashTree,
  missingSparsePaths,
  publishBlocker,
  publishedDigests,
  readInstall,
} from './sync-plugin.mjs'

const clean = { dirty: [], ahead: 0, behind: 0 }

test('publishBlocker passes a committed, pushed tree', () => {
  assert.equal(publishBlocker(clean), undefined)
})

test('publishBlocker names the uncommitted files rather than just refusing', () => {
  const blocker = publishBlocker({ ...clean, dirty: [' M skills/backlog/SKILL.md'] })
  assert.match(blocker, /skills\/backlog\/SKILL\.md/)
  assert.match(blocker, /commit these first/)
})

test('publishBlocker refuses an unpushed HEAD — the marketplace clones from GitHub', () => {
  assert.match(publishBlocker({ ...clean, ahead: 2 }), /git push/)
})

test('publishBlocker refuses a stale HEAD, so a sync never installs backwards', () => {
  assert.match(publishBlocker({ ...clean, behind: 3 }), /git pull --ff-only/)
})

// Dirty beats unpushed: committing is the first step of pushing, so the
// message that comes out has to be the one the user can act on now.
test('publishBlocker reports the dirty tree before the unpushed commits', () => {
  assert.match(publishBlocker({ dirty: ['?? skills/new.md'], ahead: 4, behind: 0 }), /commit these first/)
})

test('hashTree notices content, renames and deletions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-plugin-'))
  const empty = mkdtempSync(join(tmpdir(), 'sync-plugin-empty-'))
  try {
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', 'one.md'), 'hello')
    const base = hashTree(dir)

    writeFileSync(join(dir, 'a', 'one.md'), 'hello!')
    assert.notEqual(hashTree(dir), base, 'edited content must change the digest')

    // Same bytes under a different name: a rename has to register, which is
    // why the digest eats the relative path and not just the file contents.
    writeFileSync(join(dir, 'a', 'one.md'), 'hello')
    writeFileSync(join(dir, 'a', 'two.md'), 'hello')
    rmSync(join(dir, 'a', 'one.md'))
    assert.notEqual(hashTree(dir), base, 'a rename must change the digest')

    rmSync(join(dir, 'a', 'two.md'))
    assert.equal(hashTree(dir), hashTree(empty), 'a deletion must change the digest back')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test('hashTree treats a missing tree as empty rather than throwing', () => {
  assert.equal(hashTree(join(tmpdir(), 'sync-plugin-does-not-exist')), '')
})

test('readInstall picks the user-scoped entry and tolerates a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-plugin-installed-'))
  try {
    const path = join(dir, 'installed_plugins.json')
    writeFileSync(path, JSON.stringify({
      plugins: {
        [PLUGIN_ID]: [
          { scope: 'project', installPath: '/project/copy', version: '0.1.0' },
          { scope: 'user', installPath: '/user/copy', version: '0.1.1', gitCommitSha: 'abc' },
        ],
      },
    }))
    assert.equal(readInstall(path).installPath, '/user/copy')

    writeFileSync(path, JSON.stringify({ plugins: {} }))
    assert.equal(readInstall(path), undefined)
    assert.equal(readInstall(join(dir, 'nope.json')), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The bug this pair of helpers exists for: the short-circuit used to hash
// `skills` alone, so an install whose `agents/` had never been checked out at
// all was byte-for-byte indistinguishable from a complete one and the sync
// declined to reinstall — forever, since the one path it measured never moved.
test('publishedDigests keys every published path, missing ones included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-plugin-surface-'))
  try {
    mkdirSync(join(dir, 'skills'))
    writeFileSync(join(dir, 'skills', 'one.md'), 'hello')
    mkdirSync(join(dir, '.claude-plugin'))
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{}')
    // `agents` deliberately absent — the bug's own shape.
    const digests = publishedDigests(dir)

    assert.deepEqual(Object.keys(digests).sort(), [...PUBLISHED_PATHS].sort())
    assert.equal(digests.agents, '', 'a path that is not on disk digests as empty')
    assert.notEqual(digests.skills, '')
    assert.notEqual(digests['.claude-plugin'], '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('driftedPaths reports nothing when the two surfaces agree', () => {
  const same = { skills: 'a', '.claude-plugin': 'b', agents: 'c' }
  assert.deepEqual(driftedPaths(same, { ...same }), [])
})

test('driftedPaths reports a published path the install never checked out', () => {
  const repo = { skills: 'a', '.claude-plugin': 'b', agents: 'c' }
  const install = { skills: 'a', '.claude-plugin': 'b', agents: '' }
  assert.deepEqual(driftedPaths(repo, install), ['agents'])
})

test('driftedPaths sees .claude-plugin too, and answers in PUBLISHED_PATHS order', () => {
  const repo = { skills: 'a', '.claude-plugin': 'b', agents: 'c' }
  assert.deepEqual(driftedPaths(repo, { ...repo, '.claude-plugin': 'x' }), ['.claude-plugin'])
  // Order is the list's, not the object's, so the message reads the same way
  // every run regardless of which key happened to be inserted first.
  assert.deepEqual(
    driftedPaths(repo, { skills: 'z', '.claude-plugin': 'y', agents: '' }),
    PUBLISHED_PATHS,
  )
})

// The other half of the bug: the machine-local declaration. `settings.json` →
// extraKnownMarketplaces is the control; known_marketplaces.json is a cache
// reconciled from it, so what this helper reads is the thing that persists.
const settingsWith = (sparsePaths) => ({
  extraKnownMarketplaces: {
    [MARKETPLACE]: { source: { source: 'github', repo: 'futin/backlog-manager', ...(sparsePaths ? { sparsePaths } : {}) } },
  },
})

test('missingSparsePaths names the published paths a declaration leaves out', () => {
  assert.deepEqual(missingSparsePaths(settingsWith(['.claude-plugin', 'skills']), MARKETPLACE), ['agents'])
})

test('missingSparsePaths passes a declaration covering the whole surface', () => {
  assert.deepEqual(missingSparsePaths(settingsWith(['.claude-plugin', 'skills', 'agents']), MARKETPLACE), [])
})

// No sparsePaths key at all clones the whole repo, which carries every
// published path by definition. Warning about that would be warning about a
// correct machine.
test('missingSparsePaths passes a declaration with no sparsePaths at all', () => {
  assert.deepEqual(missingSparsePaths(settingsWith(undefined), MARKETPLACE), [])
})

// A machine can declare at any settings tier, or via `marketplace add --sparse`.
// The tier this script can read is one of several, so what it cannot see it
// must not warn about.
test('missingSparsePaths stays quiet when it cannot see a declaration', () => {
  assert.deepEqual(missingSparsePaths(undefined, MARKETPLACE), [])
  assert.deepEqual(missingSparsePaths({}, MARKETPLACE), [])
  assert.deepEqual(missingSparsePaths({ extraKnownMarketplaces: {} }, MARKETPLACE), [])
  assert.deepEqual(missingSparsePaths(settingsWith(['skills']), 'some-other-marketplace'), [])
})
