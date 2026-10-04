import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { sweepDeadRoots } from './test-tmpdir.mjs'

// #243, node-runner half: `test:skills` runs through scripts/test-tmpdir.mjs, which points TMPDIR at one root for the run and removes it afterwards. These
// cases guard that the redirect reaches a test file, that the sweep only takes dead runs' roots, and that the launcher leaves nothing behind.
const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-tmpdir.mjs')

test('a test file under test:skills sees a bm-nodetest-<pid>- root as its tmpdir', () => {
  assert.match(path.basename(os.tmpdir()), /^bm-nodetest-\d+-/)
  assert.equal(process.env.BM_NODETEST_TMP_ROOT, os.tmpdir())
})

test('sweepDeadRoots removes a dead pid root and keeps a live one and an unrelated dir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'))
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  for (const name of [`bm-nodetest-${dead}-a`, `bm-nodetest-${process.pid}-b`, 'bm-registry-c']) fs.mkdirSync(path.join(base, name))
  sweepDeadRoots(base)
  assert.deepEqual(fs.readdirSync(base).sort(), [`bm-nodetest-${process.pid}-b`, 'bm-registry-c'])
})

// Without NODE_TEST_CONTEXT: this file itself runs as a node:test child, and an inherited value makes the nested runner speak the parent protocol on stdout
// instead of printing the probe's line.
const { NODE_TEST_CONTEXT, ...cleanEnv } = process.env

test('the launcher runs the files under its root, passes the exit code through, and removes the root afterwards', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'))
  const file = path.join(work, 'probe.test.mjs')
  fs.writeFileSync(
    file,
    "import { test } from 'node:test'\nimport fs from 'node:fs'\nimport os from 'node:os'\nimport path from 'node:path'\n" +
      "test('p', () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-alpha-')); console.log('MADE=' + d); if (process.env.PROBE_FAIL) throw new Error('x') })\n"
  )
  const ok = spawnSync(process.execPath, [LAUNCHER, file], { encoding: 'utf8', env: { ...cleanEnv, TMPDIR: work } })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const made = /MADE=(\S+)/.exec(ok.stdout)[1]
  assert.match(path.basename(path.dirname(made)), /^bm-nodetest-\d+-/)
  assert.equal(path.dirname(path.dirname(made)), work)
  assert.equal(fs.existsSync(path.dirname(made)), false)
  const bad = spawnSync(process.execPath, [LAUNCHER, file], { encoding: 'utf8', env: { ...cleanEnv, TMPDIR: work, PROBE_FAIL: '1' } })
  assert.notEqual(bad.status, 0)
  assert.deepEqual(fs.readdirSync(work), ['probe.test.mjs'])
})
