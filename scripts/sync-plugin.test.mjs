import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PLUGIN_ID, hashTree, publishBlocker, readInstall } from './sync-plugin.mjs'

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
