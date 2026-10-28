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

// #346: the run-as-main guard once compared argv[1] with `new URL(import.meta.url).pathname`, which stays percent-encoded — so from a checkout whose path
// held a space or a non-ASCII character the launcher never called main(), spawned no `node --test`, and exited 0: `test:skills` and the node half of
// `pnpm test` reported PASS having run nothing. The launcher has no relative imports, so a copy of it runs standalone from such a directory. The passing
// probe must exit 0 AND name its test, so this case cannot pass merely because the launcher crashed; the failing probe must exit non-zero.
//
// `realpathSync` because node resolves the main module through symlinks before it builds `import.meta.url`, while argv[1] keeps the spelling it was given:
// on macOS `os.tmpdir()` sits under `/var`, a symlink to `/private/var`, so an unresolved copy would miss the guard for that reason instead of this one —
// and every other run-as-main guard in the repo makes the same unresolved comparison.
test('the launcher runs its files from a directory whose path holds a space and a non-ASCII character', () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-')))
  const dir = path.join(work, 'dir with space é')
  fs.mkdirSync(dir)
  const copy = path.join(dir, 'test-tmpdir.mjs')
  fs.copyFileSync(LAUNCHER, copy)
  const file = path.join(dir, 'probe.test.mjs')
  fs.writeFileSync(file, "import { test } from 'node:test'\ntest('probe-under-space', () => { if (process.env.PROBE_FAIL) throw new Error('x') })\n")
  const ok = spawnSync(process.execPath, [copy, file], { encoding: 'utf8', env: { ...cleanEnv, TMPDIR: work } })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /probe-under-space/)
  const bad = spawnSync(process.execPath, [copy, file], { encoding: 'utf8', env: { ...cleanEnv, TMPDIR: work, PROBE_FAIL: '1' } })
  assert.notEqual(bad.status, 0, bad.stdout + bad.stderr)
  assert.match(bad.stdout, /probe-under-space/)
})
