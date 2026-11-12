import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// #453: every run-as-main guard compared `path.resolve(process.argv[1])`, which keeps the spelling it was given, with `import.meta.url`, which node builds from
// the realpath of the main module. Started through any path that crosses a symlink the two never matched, so main() was skipped and the process exited 0 having
// done nothing — the same silent shape as #346, which fixed the percent-encoding half of this guard. Each script carries its own `isMain`, so each is driven
// here on its own: a copy that lost the fix fails its own row, and no row can pass by accident, since the broken state is exit 0 with no output at all.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Without NODE_TEST_CONTEXT: this file itself runs as a node:test child, and an inherited value makes the nested runner in the `test-tmpdir.mjs` row speak the
// parent protocol on stdout instead of printing the probe's line.
const { NODE_TEST_CONTEXT, ...cleanEnv } = process.env

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'run-as-main-'))
after(() => fs.rmSync(work, { recursive: true, force: true }))

const PROBE = path.join(work, 'probe.test.mjs')
fs.writeFileSync(PROBE, "import { test } from 'node:test'\ntest('probe-through-a-link', () => {})\n")

// `sync-plugin.mjs` is the tenth copy and has no row: its main() reinstalls the plugin, so no test may ever start it. The source guards below are its coverage.
const ROWS = [
  { script: 'skills/backlog/tools/backlog.mjs', args: ['zzz-nope'], status: 1, output: 'unknown command: zzz-nope' },
  { script: 'skills/backlog-orchestrate/tools/orchestrate.mjs', args: ['zzz-nope'], status: 1, output: 'unknown command: zzz-nope' },
  { script: 'skills/backlog-retro/tools/retro.mjs', args: ['zzz-nope'], status: 1, output: 'unknown command: zzz-nope' },
  { script: 'skills/jira/tools/jira.mjs', args: ['zzz-nope'], status: 1, output: 'unknown command: zzz-nope' },
  { script: 'skills/backlog-review/tools/review.mjs', args: ['zzz-nope'], status: 1, output: 'unknown command: zzz-nope' },
  { script: 'scripts/tailnet.mjs', args: ['nope'], status: 2, output: 'unknown command: nope' },
  { script: 'skills/backlog-orchestrate/tools/api-call.mjs', args: [], status: 3, output: 'usage: api-call.mjs' },
  { script: 'scripts/ci-scope.mjs', args: ['--dry-run', '--files', 'README.md'], status: 0, output: 'ci-scope: docs-only' },
  { script: 'scripts/test-tmpdir.mjs', args: [PROBE], status: 0, output: 'probe-through-a-link' }
]

const TEN = [...ROWS.map((row) => row.script), 'scripts/sync-plugin.mjs'].sort()

function run(argv) {
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: work, env: { ...cleanEnv, TMPDIR: work } })
  return { status: result.status, output: result.stdout + result.stderr }
}

function linkDirectoryOf(script) {
  const link = fs.mkdtempSync(path.join(work, 'dir-link-')) + '/tools'
  fs.symlinkSync(path.dirname(path.join(REPO, script)), link, 'dir')
  return path.join(link, path.basename(script))
}

for (const { script, args, status, output } of ROWS) {
  test(`${path.basename(script)} runs its main() when started through a symlinked directory`, () => {
    const result = run([linkDirectoryOf(script), ...args])
    assert.equal(result.status, status, result.output)
    assert.ok(result.output.includes(output), result.output)
  })
}

test('backlog.mjs runs its main() when started through a symlink to the file itself', () => {
  const link = path.join(fs.mkdtempSync(path.join(work, 'file-link-')), 'linked-backlog.mjs')
  fs.symlinkSync(path.join(REPO, 'skills/backlog/tools/backlog.mjs'), link, 'file')
  const result = run([link, 'zzz-nope'])
  assert.equal(result.status, 1, result.output)
  assert.ok(result.output.includes('unknown command: zzz-nope'), result.output)
})

// The catch in `isMain` is load-bearing, not defensive: `node -e … some-arg` hands argv[1] a word that is no file, and an uncaught ENOENT at the top level of a
// module would crash every process that merely imports it. `sync-plugin.mjs` sits out for the reason its row does.
for (const { script } of ROWS) {
  for (const [label, trailing] of [['no argv[1]', []], ['an argv[1] that is no file', ['nonexistent']]]) {
    test(`importing ${path.basename(script)} stays inert with ${label}`, () => {
      const href = pathToFileURL(path.join(REPO, script)).href
      const result = run(['-e', `import(${JSON.stringify(href)})`, ...trailing])
      assert.equal(result.status, 0, result.output)
      assert.ok(!result.output.includes('unknown command'), result.output)
      assert.ok(!result.output.includes('usage:'), result.output)
      assert.ok(!result.output.includes('ENOENT'), result.output)
    })
  }
}

function sourcesUnder(dir) {
  return fs
    .readdirSync(path.join(REPO, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs'))
    .map((entry) => path.join(dir, entry.name))
}

// Every non-test `.mjs` a guard could live in: directly under scripts/, and under each skill's tools/ and tools/lib/. A guard added in a tenth file, or a copy
// reverted in `sync-plugin.mjs`, shows up here and nowhere else.
function everySource() {
  const files = sourcesUnder('scripts')
  for (const skill of fs.readdirSync(path.join(REPO, 'skills'))) {
    for (const dir of [`skills/${skill}/tools`, `skills/${skill}/tools/lib`]) {
      if (fs.existsSync(path.join(REPO, dir))) files.push(...sourcesUnder(dir))
    }
  }
  return files
}

test('no script still compares an unresolved argv[1] with its own module path', () => {
  const stale = everySource().filter((file) => {
    const source = fs.readFileSync(path.join(REPO, file), 'utf8')
    return source.includes('process.argv[1]') && source.includes('resolve(process.argv[1]) ===')
  })
  assert.deepEqual(stale, [])
})

test('exactly the ten scripts guard with isMain(import.meta.url)', () => {
  const using = everySource().filter((file) => fs.readFileSync(path.join(REPO, file), 'utf8').includes('isMain(import.meta.url)'))
  assert.deepEqual(using.sort(), TEN)
})

test('every isMain resolves both sides and treats a failure as not main', () => {
  for (const file of TEN) {
    const source = fs.readFileSync(path.join(REPO, file), 'utf8')
    const body = source.slice(source.indexOf('function isMain(url)'), source.indexOf('isMain(import.meta.url)'))
    assert.match(body, /realpathSync\(process\.argv\[1\]\) === (fs\.)?realpathSync\(fileURLToPath\(url\)\)/, file)
    assert.match(body, /catch \{\s*return false/, file)
  }
})
