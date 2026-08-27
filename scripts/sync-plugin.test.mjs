import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PLUGIN_ID, bumpPatch, hashTree, readInstall } from './sync-plugin.mjs'

test('bumpPatch moves only the patch digit', () => {
  assert.equal(bumpPatch('0.1.0'), '0.1.1')
  assert.equal(bumpPatch('1.4.9'), '1.4.10')
})

test('bumpPatch refuses a version it cannot reason about', () => {
  for (const bad of ['0.1', '1.2.3-rc1', 'v1.2.3', '']) {
    assert.throws(() => bumpPatch(bad), /not major\.minor\.patch/)
  }
})

test('hashTree notices content, renames and deletions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-plugin-'))
  try {
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', 'one.md'), 'hello')
    const base = hashTree(dir)

    writeFileSync(join(dir, 'a', 'one.md'), 'hello!')
    const edited = hashTree(dir)
    assert.notEqual(edited, base, 'edited content must change the digest')

    // Same bytes under a different name: a rename has to register, which is
    // why the digest eats the relative path and not just the file contents.
    writeFileSync(join(dir, 'a', 'one.md'), 'hello')
    writeFileSync(join(dir, 'a', 'two.md'), 'hello')
    rmSync(join(dir, 'a', 'one.md'))
    assert.notEqual(hashTree(dir), base, 'a rename must change the digest')

    rmSync(join(dir, 'a', 'two.md'))
    assert.equal(hashTree(dir), hashTree(mkdtempSync(join(tmpdir(), 'sync-plugin-empty-'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
          { scope: 'user', installPath: '/user/copy', version: '0.1.1' },
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
