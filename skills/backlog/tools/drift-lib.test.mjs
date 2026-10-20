// Groom drift (#322): `planDrift` and its helpers, cases 6–14 of the task's plan, each in a temp git repo with real commits.
//
// Every case runs against BOTH copies of the module — this one and `skills/backlog-orchestrate/tools/drift-lib.mjs` — and the first case asserts the two
// files are byte-identical. `orchestrate.mjs` is standalone by rule and imports the copy beside it (see the module's header), so the copies are the price
// of that rule and this file is what keeps them one function.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import * as here from './drift-lib.mjs'
import * as orchestrateCopy from '../../backlog-orchestrate/tools/drift-lib.mjs'

const HERE_FILE = fileURLToPath(new URL('./drift-lib.mjs', import.meta.url))
const COPY_FILE = fileURLToPath(new URL('../../backlog-orchestrate/tools/drift-lib.mjs', import.meta.url))

const COPIES = [
  ['backlog', here],
  ['backlog-orchestrate', orchestrateCopy],
]

test('the two drift-lib copies are byte-identical', () => {
  assert.equal(fs.readFileSync(COPY_FILE, 'utf8'), fs.readFileSync(HERE_FILE, 'utf8'), 'edit skills/backlog/tools/drift-lib.mjs, then copy it over the orchestrate copy')
})

// A repo whose every commit has a pinned committer date, so `created:` fallbacks (case 11) are deterministic.
function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-drift-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' })
  return dir
}

function commit(dir, files, message, date = '2026-05-01T12:00:00Z') {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    if (content === null) {
      fs.rmSync(abs, { force: true })
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }
  assert.equal(spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' }).status, 0)
  const out = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', message], { encoding: 'utf8', env })
  assert.equal(out.status, 0, out.stderr)
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
}

const taskBody = (plan) => `## Goal\n\nx\n\n## Plan\n\n${plan}\n\n## Test cases\n\n## Done when\n`

for (const [name, lib] of COPIES) {
  test(`[${name}] case 6: no later commit touches the planned path → none, commits 0`, (t) => {
    const dir = repo(t)
    const c1 = commit(dir, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }, 'c1')
    commit(dir, { 'src/b.ts': 'b2\n' }, 'touch b only')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('Edit `src/a.ts`.'), frontmatter: { 'groomed-at': c1 }, section: 'tasks', base: 'main' })

    assert.equal(r.status, 'none')
    assert.equal(r.commits, 0)
    assert.equal(r.anchor, c1)
    assert.equal(r.anchorSource, 'groomed-at')
    assert.deepEqual(r.paths, [{ path: 'src/a.ts', commits: 0, missing: false }])
    assert.equal(lib.driftLine(r), 'none')
  })

  test(`[${name}] case 7: two later commits touch the planned path → drifted, commits 2`, (t) => {
    const dir = repo(t)
    const c1 = commit(dir, { 'src/a.ts': 'a\n' }, 'c1')
    commit(dir, { 'src/a.ts': 'a2\n' }, 'a2')
    commit(dir, { 'src/a.ts': 'a3\n' }, 'a3')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('Edit `src/a.ts`.'), frontmatter: { 'groomed-at': c1 }, section: 'tasks', base: 'main' })

    assert.equal(r.status, 'drifted')
    assert.equal(r.commits, 2)
    assert.equal(r.paths[0].commits, 2)
    assert.equal(lib.driftLine(r), `drifted — 2 commits since ${c1.slice(0, 7)} (groomed-at) touch: src/a.ts`)
  })

  test(`[${name}] case 8: the planned path was deleted after the anchor → drifted, missing`, (t) => {
    const dir = repo(t)
    const c1 = commit(dir, { 'src/a.ts': 'a\n', 'keep.txt': 'k\n' }, 'c1')
    commit(dir, { 'src/a.ts': null }, 'delete a')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('Edit `src/a.ts`.'), frontmatter: { 'groomed-at': c1 }, section: 'tasks', base: 'main' })

    assert.equal(r.status, 'drifted')
    assert.equal(r.paths[0].missing, true)
    assert.match(lib.driftLine(r), /missing: src\/a\.ts$/)
  })

  test(`[${name}] case 9: a :line suffix is stripped, a command is not a path, and a path at neither ref is dropped`, (t) => {
    const dir = repo(t)
    const c1 = commit(dir, { 'src/a.ts': 'a\n' }, 'c1')

    assert.deepEqual(lib.pathTokens('See `src/a.ts:42`, `src/a.ts:4:2`, `orchestrate.mjs plan` and `src/gone.ts`.'), ['src/a.ts', 'src/gone.ts'])

    const r = lib.planDrift({
      projectRoot: dir,
      body: taskBody('See `src/a.ts:42`, run `orchestrate.mjs plan`, and mind `src/gone.ts`.'),
      frontmatter: { 'groomed-at': c1 },
      section: 'tasks',
      base: 'main',
    })
    assert.deepEqual(
      r.paths.map((p) => p.path),
      ['src/a.ts'],
    )
  })

  test(`[${name}] case 10: one commit touching two planned paths counts once`, (t) => {
    const dir = repo(t)
    const c1 = commit(dir, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }, 'c1')
    commit(dir, { 'src/a.ts': 'a2\n', 'src/b.ts': 'b2\n' }, 'both')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('`src/a.ts` and `src/b.ts`.'), frontmatter: { 'groomed-at': c1 }, section: 'tasks', base: 'main' })

    assert.equal(r.status, 'drifted')
    assert.equal(r.commits, 1)
    assert.deepEqual(
      r.paths.map((p) => p.commits),
      [1, 1],
    )
  })

  test(`[${name}] case 11: no groomed-at → the last commit before created: (UTC midnight), anchorSource created`, (t) => {
    const dir = repo(t)
    const before = commit(dir, { 'src/a.ts': 'a\n' }, 'before', '2026-05-01T23:00:00Z')
    // After midnight of the `created` day: a bare date read as "now, that day" — which is what git does with one — would pick THIS commit instead.
    commit(dir, { 'src/a.ts': 'a2\n' }, 'after', '2026-05-02T00:30:00Z')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('Edit `src/a.ts`.'), frontmatter: { created: '2026-05-02' }, section: 'tasks', base: 'main' })

    assert.equal(r.anchor, before)
    assert.equal(r.anchorSource, 'created')
    assert.equal(r.status, 'drifted')
    assert.equal(r.commits, 1)
  })

  test(`[${name}] case 12: groomed-at names a sha this repo lacks, and no created → unknown`, (t) => {
    const dir = repo(t)
    commit(dir, { 'src/a.ts': 'a\n' }, 'c1')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('Edit `src/a.ts`.'), frontmatter: { 'groomed-at': 'deadbeef'.repeat(5) }, section: 'tasks', base: 'main' })

    assert.equal(r.status, 'unknown')
    assert.equal(r.anchor, null)
    assert.match(lib.driftLine(r), /^unknown — /)
  })

  test(`[${name}] case 13: a plan naming no path → unknown, and the reason says so`, (t) => {
    const dir = repo(t)
    const c1 = commit(dir, { 'src/a.ts': 'a\n' }, 'c1')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('Think hard and do the right thing.'), frontmatter: { 'groomed-at': c1 }, section: 'tasks', base: 'main' })

    assert.equal(r.status, 'unknown')
    assert.match(r.reason, /names no path/)
  })

  test(`[${name}] case 14: groomed-at on a side branch → the anchor is its merge-base with base`, (t) => {
    const dir = repo(t)
    const fork = commit(dir, { 'src/a.ts': 'a\n' }, 'fork point')
    spawnSync('git', ['-C', dir, 'checkout', '-q', '-b', 'side'], { encoding: 'utf8' })
    const side = commit(dir, { 'side.txt': 's\n' }, 'side only')
    spawnSync('git', ['-C', dir, 'checkout', '-q', 'main'], { encoding: 'utf8' })
    commit(dir, { 'src/a.ts': 'a2\n' }, 'main moves a')

    const r = lib.planDrift({ projectRoot: dir, body: taskBody('Edit `src/a.ts`.'), frontmatter: { 'groomed-at': side }, section: 'tasks', base: 'main' })

    assert.equal(r.anchor, fork)
    assert.equal(r.anchorSource, 'groomed-at')
    assert.equal(r.commits, 1)
  })

  test(`[${name}] a bug measures ## Fix, not ## Plan`, (t) => {
    const dir = repo(t)
    const c1 = commit(dir, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }, 'c1')
    commit(dir, { 'src/b.ts': 'b2\n' }, 'b')

    const body = '## Cause\n\n`src/a.ts`\n\n## Fix\n\nPatch `src/b.ts`.\n'
    const r = lib.planDrift({ projectRoot: dir, body, frontmatter: { 'groomed-at': c1 }, section: 'bugs', base: 'main' })

    assert.deepEqual(
      r.paths.map((p) => p.path),
      ['src/b.ts'],
    )
    assert.equal(r.status, 'drifted')
  })

  // Case 22a's pure half: the footer is stripped before a section is read, so a re-stamp moves neither the hash nor the path list.
  test(`[${name}] case 22a: re-stamping only the footer of a body ending in ## Plan leaves planHash and the path list unchanged`, () => {
    const once = lib.stampGroomedAt('## Goal\n\nx\n\n## Plan\n\nEdit `src/a.ts`.\n', 'a'.repeat(40))
    const twice = lib.stampGroomedAt(once, 'b'.repeat(40))

    assert.equal(twice.match(/bm:groomed-at/g).length, 1)
    assert.equal(lib.parseGroomedAtFooter(twice), 'b'.repeat(40))
    assert.ok(twice.endsWith(`<!-- bm:groomed-at ${'b'.repeat(40)} -->\n`))
    assert.equal(lib.planHash(lib.planSection(once, 'tasks')), lib.planHash(lib.planSection(twice, 'tasks')))
    assert.deepEqual(lib.pathTokens(lib.planSection(twice, 'tasks')), ['src/a.ts'])
    assert.doesNotMatch(lib.planSection(twice, 'tasks'), /groomed-at/)
  })

  test(`[${name}] planHash ignores CRLF and surrounding whitespace, and nothing else`, () => {
    assert.equal(lib.planHash('one\r\ntwo\r\n'), lib.planHash('\none\ntwo'))
    assert.notEqual(lib.planHash('one\ntwo'), lib.planHash('one\nthree'))
  })

  test(`[${name}] headSha is null in a repo with no commits`, (t) => {
    const dir = repo(t)
    assert.equal(lib.headSha(dir), null)
    const c1 = commit(dir, { 'x.txt': 'x\n' }, 'c1')
    assert.equal(lib.headSha(dir), c1)
  })
}
