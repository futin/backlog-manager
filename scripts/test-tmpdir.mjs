#!/usr/bin/env node
// `node scripts/test-tmpdir.mjs <test files…>` — runs `node --test` on those files with `TMPDIR` pointed at one directory for the whole run, and removes
// that directory when the run ends (#243). `test:skills` is the only caller.
//
// The skill and script suites call `fs.mkdtempSync(path.join(os.tmpdir(), …))` throughout and did not reliably remove what they made; together with the
// jest side that filled `/tmp`'s inode budget on 2026-10-03 and broke every `Bash` call on the machine with `ENOSPC`. Pointing `TMPDIR` at one root fixes
// the class instead of the sites — `os.tmpdir()` re-reads it per call — and removing the root removes everything.
//
// This is the jest mechanism in `test/helpers/tmp-root.ts` again, for the other runner; the reasoning (why a dead pid's root is swept and a live one never
// is) lives in that file's header. Keep the two in step.
//
// A launcher rather than a hook, because node's runner offers no portable place to run one: `--import` loads only in the per-file child processes, never in
// the runner's own (measured on 24.20 — each child claimed a root of its own and deleted it under its siblings), and `--test-global-setup` does not exist on
// the 22.x line `engines` still admits. The parent of the runner is the one process that sees the whole run start and end.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'bm-nodetest-'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists and is somebody else's — alive, so not ours to sweep.
    return err.code === 'EPERM'
  }
}

export function sweepDeadRoots(base) {
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue
    const pid = Number(name.slice(PREFIX.length).split('-')[0])
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) fs.rmSync(path.join(base, name), { recursive: true, force: true })
  }
}

function main(files) {
  const base = os.tmpdir()
  sweepDeadRoots(base)
  const root = fs.mkdtempSync(path.join(base, `${PREFIX}${process.pid}-`))
  try {
    const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, TMPDIR: root, BM_NODETEST_TMP_ROOT: root } })
    if (run.error) console.error(`test-tmpdir: could not run node --test — ${run.error.message}`)
    return run.status ?? 1
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) process.exitCode = main(process.argv.slice(2))
