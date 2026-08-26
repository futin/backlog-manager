import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BacklogError, resolveRoot, slugify, init, parseFrontmatter, renderFrontmatter, nextId, readItem, listOpen, registerProject, registryFile } from './backlog.mjs'

const SCRIPT = fileURLToPath(new URL('./backlog.mjs', import.meta.url))
const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd })

// `run` spawns the real CLI as a child process, which inherits this process's
// env by default. Task 4 wires registerBestEffort into `init` and `new`, so
// without this, every CLI-driven test below (there are a dozen `new` calls)
// would upsert its own throwaway tmpdir into a developer's REAL
// ~/.backlog-manager/registry.json every time this suite runs — exactly the
// file this tool must not touch outside of real usage. One throwaway file for
// the whole test process keeps that write off the real registry. The
// registryFile test below still exercises BM_REGISTRY_FILE handling correctly
// on top of this default, since it saves and restores whatever value it finds.
process.env.BM_REGISTRY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-registry-test-')), 'registry.json')

// Every later task (ids, board+show, move) reuses this: a fresh tmpdir that
// is already a git repo, plus the backlog/ path resolveRoot would compute
// for it. Nothing is exported from this file — later tests here call it
// directly.
//
// realpathSync matters on macOS: os.tmpdir() hands back a path through the
// /var -> /private/var symlink, but a child process's own process.cwd() (via
// getcwd(2)) reports the resolved physical path. Without this, any test that
// spawns the CLI and compares its output against a path built from the raw
// mkdtemp string fails on a string mismatch that has nothing to do with the
// tool's behavior.
function backlogFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-')))
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' })
  return { dir, backlog: path.join(dir, 'backlog') }
}

test('resolveRoot finds the repo root above the cwd and computes backlog/', () => {
  const { dir, backlog } = backlogFixture()
  const nested = path.join(dir, 'a', 'b')
  fs.mkdirSync(nested, { recursive: true })

  assert.deepEqual(resolveRoot(nested), { root: dir, backlog })
})

test('resolveRoot throws a code-2 BacklogError when no ancestor has a .git', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-no-git-')))

  assert.throws(() => resolveRoot(dir), (e) => e instanceof BacklogError && e.code === 2)
})

test('CLI root exits 2 with no .git ancestor and creates no directory', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-no-git-')))

  const out = run(dir, 'root')

  assert.equal(out.status, 2)
  assert.match(out.stderr, /\.git/)
  assert.equal(out.stdout, '')
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('CLI root prints the resolved backlog/ path and exits 0', () => {
  const { dir, backlog } = backlogFixture()
  const nested = path.join(dir, 'a', 'b')
  fs.mkdirSync(nested, { recursive: true })

  const out = run(nested, 'root')

  assert.equal(out.status, 0)
  assert.equal(out.stdout, backlog + '\n')
})

test('slugify lowercases and dashes punctuation', () => {
  assert.equal(slugify('Deck Scroll Chains!'), 'deck-scroll-chains')
})

test('slugify collapses and trims surrounding whitespace', () => {
  assert.equal(slugify('  Trailing  spaces  '), 'trailing-spaces')
})

test('slugify strips diacritics via NFD normalization', () => {
  assert.equal(slugify('Émigré café'), 'emigre-cafe')
})

test('slugify collapses a run of dashes and spaces to one dash', () => {
  assert.equal(slugify('a --- b'), 'a-b')
})

test('slugify refuses a title with no [a-z0-9] characters left', () => {
  assert.throws(() => slugify('#$%'), (e) => e instanceof BacklogError && e.code === 1)
})

test('init creates all seven leaf directories plus a non-empty README', () => {
  const { backlog } = backlogFixture()

  const created = init(backlog)

  assert.equal(created.length, 8)
  for (const rel of [
    'bugs/open',
    'bugs/done',
    'ideas/open',
    'ideas/done',
    'tasks/open',
    'tasks/done',
    'out-of-scope',
  ]) {
    assert.equal(fs.statSync(path.join(backlog, rel)).isDirectory(), true)
  }
  assert.ok(fs.readFileSync(path.join(backlog, 'README.md'), 'utf8').length > 0)
})

test('init run twice creates nothing new and never truncates a hand-edited README', () => {
  const { backlog } = backlogFixture()
  init(backlog)
  const readmePath = path.join(backlog, 'README.md')
  const handEdited = '# Hand-edited\n\nDo not overwrite me.\n'
  fs.writeFileSync(readmePath, handEdited)

  const second = init(backlog)

  assert.deepEqual(second, [])
  assert.equal(fs.readFileSync(readmePath, 'utf8'), handEdited)
})

// --- nextId ---------------------------------------------------------------

test('nextId returns 1 for a section with no items yet (store not even initialized)', () => {
  const { backlog } = backlogFixture()

  assert.equal(nextId(backlog, 'bugs'), 1)
})

test('nextId returns max+1 across open/ and done/, preserving the gap', () => {
  const { backlog } = backlogFixture()
  fs.mkdirSync(path.join(backlog, 'bugs', 'open'), { recursive: true })
  fs.mkdirSync(path.join(backlog, 'bugs', 'done'), { recursive: true })
  fs.writeFileSync(path.join(backlog, 'bugs', 'open', 'bug-1-a.md'), '')
  fs.writeFileSync(path.join(backlog, 'bugs', 'done', 'bug-3-b.md'), '')

  assert.equal(nextId(backlog, 'bugs'), 4)
})

test('nextId for out-of-scope counts only oos- ids, ignoring rejected items kept under their original prefix', () => {
  const { backlog } = backlogFixture()
  fs.mkdirSync(path.join(backlog, 'out-of-scope'), { recursive: true })
  fs.writeFileSync(path.join(backlog, 'out-of-scope', 'bug-7-x.md'), '')
  fs.writeFileSync(path.join(backlog, 'out-of-scope', 'oos-2-y.md'), '')

  assert.equal(nextId(backlog, 'out-of-scope'), 3)
})

// Complement of the case above: a bug-2 rejected into out-of-scope/ keeps
// its original id (see moveItem), so nextId('bugs') must count it too, or a
// freshly captured bug would reuse the rejected item's id.
test('nextId for bugs counts a bug rejected into out-of-scope/, not just open/ and done/', () => {
  const { backlog } = backlogFixture()
  fs.mkdirSync(path.join(backlog, 'bugs', 'open'), { recursive: true })
  fs.mkdirSync(path.join(backlog, 'out-of-scope'), { recursive: true })
  fs.writeFileSync(path.join(backlog, 'bugs', 'open', 'bug-1-first-bug.md'), '')
  fs.writeFileSync(path.join(backlog, 'out-of-scope', 'bug-2-second-bug.md'), '')

  assert.equal(nextId(backlog, 'bugs'), 3)
})

test('nextId for bugs ignores an idea rejected into out-of-scope/ — the prefix filter still discriminates', () => {
  const { backlog } = backlogFixture()
  fs.mkdirSync(path.join(backlog, 'bugs', 'open'), { recursive: true })
  fs.mkdirSync(path.join(backlog, 'out-of-scope'), { recursive: true })
  fs.writeFileSync(path.join(backlog, 'bugs', 'open', 'bug-1-first-bug.md'), '')
  fs.writeFileSync(path.join(backlog, 'out-of-scope', 'idea-9-rejected-idea.md'), '')

  assert.equal(nextId(backlog, 'bugs'), 2)
})

test('nextId throws a code-1 BacklogError for an unknown section', () => {
  const { backlog } = backlogFixture()

  assert.throws(() => nextId(backlog, 'nope'), (e) => e instanceof BacklogError && e.code === 1)
})

// --- CLI new ----------------------------------------------------------------

test('CLI new on an empty store prints the path to write and writes nothing', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'new', 'bugs', 'Deck Scroll Chains!')

  assert.equal(out.status, 0)
  const path1 = out.stdout.split('\n')[0]
  assert.match(path1, /backlog\/bugs\/open\/bug-1-deck-scroll-chains\.md$/)
  assert.equal(fs.existsSync(path1), false)
})

test('CLI new stdout carries exactly id/title/created, no from, no tags', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'new', 'bugs', 'Deck Scroll Chains!')
  const lines = out.stdout.split('\n')

  // The created line's own date, pulled straight from CLI output: must match
  // the YYYY-MM-DD shape and equal today's date computed the same way here,
  // rather than a hardcoded date that will rot.
  const createdMatch = lines[4].match(/^created: (\d{4}-\d{2}-\d{2})$/)
  assert.ok(createdMatch, `expected a created: line, got ${JSON.stringify(lines[4])}`)
  assert.equal(createdMatch[1], new Date().toISOString().slice(0, 10))

  assert.deepEqual(lines.slice(1, -1), [
    '---',
    'id: bug-1',
    'title: Deck Scroll Chains!',
    lines[4],
    '---',
  ])
})

test('CLI new run twice on the same section allocates sequential ids without writing files', () => {
  const { dir } = backlogFixture()

  const out1 = run(dir, 'new', 'bugs', 'Same Title')
  assert.equal(out1.status, 0)
  const path1 = out1.stdout.split('\n')[0]
  assert.match(path1, /bug-1-same-title\.md$/)
  assert.equal(fs.existsSync(path1), false)

  // Simulate the skill completing the write, as real usage would — nextId
  // must see this file on disk to hand out bug-2 on the next call.
  fs.mkdirSync(path.dirname(path1), { recursive: true })
  fs.writeFileSync(path1, out1.stdout.split('\n').slice(1).join('\n'))

  const out2 = run(dir, 'new', 'bugs', 'Same Title')
  assert.equal(out2.status, 0)
  const path2 = out2.stdout.split('\n')[0]
  assert.match(path2, /bug-2-same-title\.md$/)
  assert.notEqual(path1, path2)
})

test('CLI new --from carries the from: key in stdout', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'new', 'tasks', 'Panel minimise', '--from', 'idea-3')

  assert.equal(out.status, 0)
  assert.match(out.stdout, /^from: idea-3$/m)
})

test('CLI new with no section exits 1 and names the four sections in usage', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'new')

  assert.equal(out.status, 1)
  for (const name of ['bugs', 'ideas', 'tasks', 'out-of-scope']) {
    assert.match(out.stderr, new RegExp(name))
  }
})

// A newline in a value does not make one long frontmatter line — it makes
// EXTRA lines, so a title can inject `status:` and parseFrontmatter refuses
// the file it lands in forever after. Refused, not stripped: the truncated
// title would be a different item under a name nobody chose.
test('CLI new refuses a title carrying a newline, names the offending title, and prints nothing', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'new', 'bugs', 'Injected\nstatus: open')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /title must not contain a newline/)
  assert.match(out.stderr, /status: open/)
  assert.equal(out.stdout, '')
})

test('CLI new refuses a --from carrying a newline, names the offending value, and prints nothing', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'new', 'tasks', 'Panel minimise', '--from', 'idea-3\nid: bug-1')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /from must not contain a newline/)
  assert.match(out.stderr, /id: bug-1/)
  assert.equal(out.stdout, '')
})

// --- parseFrontmatter / renderFrontmatter ------------------------------------

test('parseFrontmatter splits tags on commas into trimmed strings', () => {
  const doc = '---\nid: bug-1\ntags: guides, mobile\n---\nbody\n'

  const { data } = parseFrontmatter(doc)

  assert.deepEqual(data.tags, ['guides', 'mobile'])
})

test('parseFrontmatter defaults tags to an empty array when there is no tags line', () => {
  const doc = '---\nid: bug-1\ntitle: Something\n---\nbody\n'

  const { data } = parseFrontmatter(doc)

  assert.deepEqual(data.tags, [])
})

test('parseFrontmatter refuses a status: key because the directory is the state', () => {
  const doc = '---\nid: bug-1\nstatus: open\n---\nbody\n'

  assert.throws(() => parseFrontmatter(doc), (e) => e instanceof BacklogError && e.code === 1)
})

test('parseFrontmatter preserves an unknown key verbatim', () => {
  const doc = '---\nid: bug-1\nowner: me\n---\nbody\n'

  const { data } = parseFrontmatter(doc)

  assert.equal(data.owner, 'me')
})

test('renderFrontmatter round-trips through parseFrontmatter', () => {
  const doc = '---\nid: bug-1\ntitle: Something\ncreated: 2026-08-23\ntags: guides, mobile\nowner: me\n---\nbody\n'
  const { data } = parseFrontmatter(doc)

  const rendered = renderFrontmatter(data)
  const reparsed = parseFrontmatter(`${rendered}\nbody\n`)

  assert.deepEqual(reparsed.data, data)
})

test('parseFrontmatter throws a code-1 BacklogError when there is no opening --- fence at all', () => {
  const doc = 'just some text\nno frontmatter here\n'

  assert.throws(() => parseFrontmatter(doc), (e) => e instanceof BacklogError && e.code === 1)
})

// Distinct from the case above: this doc DOES open with `---`, it just never
// closes. A skill writing an item file could plausibly produce this (a
// truncated write), and the alternative to guarding it is silently walking
// into the body treating prose lines as key: value pairs.
test('parseFrontmatter throws a code-1 BacklogError when the opening --- fence is never closed', () => {
  const doc = '---\nid: bug-1\ntitle: Something\n'

  assert.throws(() => parseFrontmatter(doc), (e) => e instanceof BacklogError && e.code === 1)
})

// --- board / show -----------------------------------------------------------

// Writes one item file directly (bypassing CLI `new`, which only ever prints
// what a caller should write) and returns its absolute path, so callers can
// assert against the exact path instead of re-deriving a slug by hand.
function writeItem(backlog, rel, id, title, created = new Date().toISOString().slice(0, 10)) {
  const filePath = path.join(backlog, rel, `${id}-${slugify(title)}.md`)
  fs.writeFileSync(filePath, renderFrontmatter({ id, title, created }) + '\n')
  return filePath
}

// Shared by every board/show test below: one open bug, one done bug, one
// out-of-scope item — enough to prove "board shows only the open one" and
// "show resolves an id no matter which of the three it lives in."
function boardFixture() {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const openBugPath = writeItem(backlog, 'bugs/open', 'bug-7', 'Deck scroll chains out of the phone overlay')
  const doneBugPath = writeItem(backlog, 'bugs/done', 'bug-3', 'Old bug already fixed')
  const oosPath = writeItem(backlog, 'out-of-scope', 'oos-2', 'Considered and declined')
  return { dir, backlog, openBugPath, doneBugPath, oosPath }
}

test('CLI board names the open bug and omits the done bug and the oos item', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'board')

  assert.equal(out.status, 0)
  assert.match(out.stdout, /bug-7/)
  assert.doesNotMatch(out.stdout, /bug-3/)
  assert.doesNotMatch(out.stdout, /oos-2/)
})

test('CLI board prints every section header, including a zero-item one', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'board')

  assert.match(out.stdout, /^bugs \(1 open\)$/m)
  assert.match(out.stdout, /^tasks \(0 open\)$/m)
})

test('CLI board --section prints only the requested section', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'board', '--section', 'bugs')

  assert.equal(out.status, 0)
  assert.match(out.stdout, /bugs/)
  assert.doesNotMatch(out.stdout, /ideas/)
  assert.doesNotMatch(out.stdout, /tasks/)
})

test('CLI board --json prints a parseable array of items with all six fields', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'board', '--json')

  assert.equal(out.status, 0)
  const items = JSON.parse(out.stdout)
  assert.equal(items.length, 1)
  for (const key of ['id', 'section', 'title', 'created', 'ageDays', 'path']) {
    assert.ok(key in items[0], `missing key ${key}`)
  }
})

test('board --json computes ageDays as whole days since created', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  writeItem(backlog, 'bugs/open', 'bug-1', 'Seven days old', sevenDaysAgo)

  const out = run(dir, 'board', '--json')

  const items = JSON.parse(out.stdout)
  assert.equal(items[0].ageDays, 7)
})

test('board --json gives an item created today an ageDays of 0', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'bugs/open', 'bug-1', 'Brand new')

  const out = run(dir, 'board', '--json')

  const items = JSON.parse(out.stdout)
  assert.equal(items[0].ageDays, 0)
})

test('CLI board exits 3 and names init when there is no backlog/ store yet', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'board')

  assert.equal(out.status, 3)
  assert.match(out.stderr, /init/)
})

test('CLI board exits 2 before the store check when there is no .git ancestor', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-no-git-')))

  const out = run(dir, 'board')

  assert.equal(out.status, 2)
  assert.match(out.stderr, /\.git/)
})

test('CLI show prints the absolute path then the frontmatter for an open item', () => {
  const { dir, openBugPath } = boardFixture()

  const out = run(dir, 'show', 'bug-7')

  assert.equal(out.status, 0)
  const lines = out.stdout.split('\n')
  assert.equal(lines[0], openBugPath)
  assert.match(out.stdout, /title:/)
})

test('CLI show resolves an id that lives in done/', () => {
  const { dir, doneBugPath } = boardFixture()

  const out = run(dir, 'show', 'bug-3')

  assert.equal(out.status, 0)
  assert.equal(out.stdout.split('\n')[0], doneBugPath)
})

test('CLI show resolves an id that lives in out-of-scope/', () => {
  const { dir, oosPath } = boardFixture()

  const out = run(dir, 'show', 'oos-2')

  assert.equal(out.status, 0)
  assert.equal(out.stdout.split('\n')[0], oosPath)
})

test('CLI show exits 1 and names the id when it does not exist', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'show', 'bug-99')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-99/)
})

// A bare prefix used to resolve: the id was split on `-` and only its first
// segment checked, so `bug` matched `bug-` against the whole directory and
// came back with whatever readdirSync listed first. Refused now, with the
// shape as the suggestion — `bug` is the likely typo for `bug-1`.
test('CLI show bug refuses the bare prefix, suggesting bug-1', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'show', 'bug')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug is a section prefix, not an id/)
  assert.match(out.stderr, /bug-1/)
  assert.equal(out.stdout, '')
})

// The other half of the same defect: any id that is a proper prefix of a
// real filename used to resolve, because the scan matched on `${id}-`. So
// `bug-7-deck` silently answered as bug-7 — a partial name is not an id, and
// the tool must not guess which item it meant.
test('CLI show refuses a partial filename as an id, though it would prefix-match a real file', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'show', 'bug-7-deck')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /not an id: bug-7-deck/)
  assert.equal(out.stdout, '')
})

test('listOpen sorts by the fixed section order, then by numeric id ascending', () => {
  const { backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'ideas/open', 'idea-5', 'Backlog dashboard tab')
  writeItem(backlog, 'ideas/open', 'idea-3', 'Per-turn token usage')
  writeItem(backlog, 'bugs/open', 'bug-7', 'Deck scroll chains out of the phone overlay')

  const items = listOpen(backlog)

  assert.deepEqual(items.map((item) => item.id), ['bug-7', 'idea-3', 'idea-5'])
})

test('readItem reports state from the directory an item lives in: open, done, or terminal', () => {
  const { backlog } = boardFixture()

  assert.equal(readItem(backlog, 'bug-7').state, 'open')
  assert.equal(readItem(backlog, 'bug-3').state, 'done')
  assert.equal(readItem(backlog, 'oos-2').state, 'terminal')
})

// A malformed item (unclosed frontmatter fence) must not blind `board` to
// the rest of what's open: it should still print the well-formed items,
// name the broken file's own absolute path on stderr, and exit 1.
test('CLI board exits 1, names the malformed item file, and still prints the well-formed ones', () => {
  const { dir, backlog } = boardFixture()
  const brokenPath = path.join(backlog, 'bugs', 'open', 'bug-9-broken-fence.md')
  fs.writeFileSync(brokenPath, '---\nid: bug-9\ntitle: Missing its closing fence\ncreated: 2026-08-01\n')

  const out = run(dir, 'board')

  assert.equal(out.status, 1)
  assert.ok(out.stderr.includes(brokenPath), `expected stderr to name ${brokenPath}, got ${JSON.stringify(out.stderr)}`)
  assert.match(out.stdout, /bug-7/)
})

// Same tolerance under --json: the machine-readable output must still parse,
// carrying the items that were readable, with the failure on stderr only.
// A problem written into stdout would break every caller doing JSON.parse.
test('CLI board --json still emits parseable JSON for the readable items when one is malformed', () => {
  const { dir, backlog } = boardFixture()
  const brokenPath = path.join(backlog, 'bugs', 'open', 'bug-9-broken-fence.md')
  fs.writeFileSync(brokenPath, '---\nid: bug-9\ntitle: Missing its closing fence\ncreated: 2026-08-01\n')

  const out = run(dir, 'board', '--json')

  assert.equal(out.status, 1)
  const items = JSON.parse(out.stdout)
  assert.deepEqual(items.map((item) => item.id), ['bug-7'])
  assert.ok(out.stderr.includes(brokenPath), `expected stderr to name ${brokenPath}, got ${JSON.stringify(out.stderr)}`)
})

// Two branches can each mint bug-7 — nextId is max+1 per working tree — and
// the merge is clean because the filenames differ. Nothing can prevent that
// here, so board must at least refuse to hide it: every command resolves the
// FIRST match, which leaves the other file unreachable while board would
// otherwise print its twin twice and exit 0. Reported through the same
// problems channel a malformed item uses, so there is one way this tool says
// the store is broken.
test('CLI board reports a duplicated open id on stderr, exits 1, prints it once, and still prints the rest', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const oneBranch = writeItem(backlog, 'bugs/open', 'bug-7', 'Minted on one branch')
  const otherBranch = writeItem(backlog, 'bugs/open', 'bug-7', 'Minted on the other branch')
  writeItem(backlog, 'ideas/open', 'idea-1', 'Still perfectly readable')

  const out = run(dir, 'board')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /duplicate id bug-7/)
  assert.ok(
    out.stderr.includes(oneBranch) && out.stderr.includes(otherBranch),
    `expected stderr to name both bug-7 files, got ${JSON.stringify(out.stderr)}`,
  )
  assert.match(out.stdout, /idea-1/)
  assert.equal(out.stdout.match(/bug-7/g).length, 1)
})

// --- move --------------------------------------------------------------

test('CLI move bug-7 done moves an open bug into bugs/done/, prints the new path, and removes the old file', () => {
  const { dir, backlog, openBugPath } = boardFixture()

  const out = run(dir, 'move', 'bug-7', 'done')

  assert.equal(out.status, 0)
  const newPath = path.join(backlog, 'bugs', 'done', path.basename(openBugPath))
  assert.equal(out.stdout, newPath + '\n')
  assert.equal(fs.existsSync(newPath), true)
  assert.equal(fs.existsSync(openBugPath), false)
})

test('CLI move bug-7 done preserves the file content byte-for-byte', () => {
  const { dir, backlog, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath)

  const out = run(dir, 'move', 'bug-7', 'done')

  assert.equal(out.status, 0)
  const newPath = path.join(backlog, 'bugs', 'done', path.basename(openBugPath))
  assert.ok(before.equals(fs.readFileSync(newPath)))
})

test('CLI move bug-7 out-of-scope keeps the bug-7 id and filename unchanged — no oos- rename', () => {
  const { dir, backlog, openBugPath } = boardFixture()
  const filename = path.basename(openBugPath)

  const out = run(dir, 'move', 'bug-7', 'out-of-scope')

  assert.equal(out.status, 0)
  const newPath = path.join(backlog, 'out-of-scope', filename)
  assert.equal(out.stdout, newPath + '\n')
  assert.equal(fs.existsSync(newPath), true)
  assert.equal(fs.existsSync(openBugPath), false)
})

test('CLI move idea-5 out-of-scope succeeds — rejection is available from any section', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const ideaPath = writeItem(backlog, 'ideas/open', 'idea-5', 'Backlog dashboard tab')

  const out = run(dir, 'move', 'idea-5', 'out-of-scope')

  assert.equal(out.status, 0)
  const newPath = path.join(backlog, 'out-of-scope', path.basename(ideaPath))
  assert.equal(out.stdout, newPath + '\n')
  assert.equal(fs.existsSync(newPath), true)
})

test('CLI move task-2 done twice: the second call refuses because it is already done, leaving the file untouched', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const taskPath = writeItem(backlog, 'tasks/open', 'task-2', 'Some task')

  const first = run(dir, 'move', 'task-2', 'done')
  assert.equal(first.status, 0)
  const donePath = path.join(backlog, 'tasks', 'done', path.basename(taskPath))
  const before = fs.readFileSync(donePath)

  const second = run(dir, 'move', 'task-2', 'done')

  assert.equal(second.status, 1)
  assert.match(second.stderr, /already done/)
  assert.ok(before.equals(fs.readFileSync(donePath)))
})

test('CLI move oos-2 done refuses because out-of-scope is terminal, leaving the file untouched', () => {
  const { dir, oosPath } = boardFixture()
  const before = fs.readFileSync(oosPath)

  const out = run(dir, 'move', 'oos-2', 'done')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /terminal/)
  assert.ok(before.equals(fs.readFileSync(oosPath)))
})

test('CLI move bug-99 done exits 1 and names the unknown id', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'move', 'bug-99', 'done')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-99/)
})

// The same bare-prefix guard as `show bug` above, on the write path — where
// it did real damage: `move bug done` archived bug-1, an item the caller
// never named.
test('CLI move bug done refuses the bare prefix and leaves the open bug where it was', () => {
  const { dir, openBugPath } = boardFixture()

  const out = run(dir, 'move', 'bug', 'done')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug is a section prefix, not an id/)
  assert.match(out.stderr, /bug-1/)
  assert.equal(fs.existsSync(openBugPath), true)
})

// renameSync overwrites its destination without a word, so this move used to
// destroy the done/ item — including the `## Outcome` recording how the work
// was verified. Both files must come out of the refusal byte-identical: a
// refusal that still truncates the victim is worse than the bug it replaced.
test('CLI move refuses when the destination filename is already taken, leaving both files byte-identical', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const openPath = writeItem(backlog, 'bugs/open', 'bug-7', 'Deck scroll chains')
  // What a clean merge of two branches that each minted bug-7 under the same
  // title looks like once one of them has been closed out.
  const donePath = path.join(backlog, 'bugs', 'done', path.basename(openPath))
  fs.writeFileSync(donePath, '---\nid: bug-7\ntitle: Deck scroll chains\ncreated: 2026-08-01\n---\n\n## Outcome\n\nnode --test: 66/66 green\n')
  const doneBefore = fs.readFileSync(donePath)
  const openBefore = fs.readFileSync(openPath)

  const out = run(dir, 'move', 'bug-7', 'done')

  assert.equal(out.status, 1)
  assert.ok(out.stderr.includes(donePath), `expected stderr to name ${donePath}, got ${JSON.stringify(out.stderr)}`)
  assert.ok(doneBefore.equals(fs.readFileSync(donePath)), 'the done/ item lost content')
  assert.ok(openBefore.equals(fs.readFileSync(openPath)), 'the open item lost content')
})

// The complement of "already done -> done is refused": done -> out-of-scope
// is permitted, because out-of-scope is reachable from any section and this
// command never touches the body. (The skill-level reject, which rewrites the
// body, is the one that must refuse a done item — see the design spec.)
test('CLI move bug-3 out-of-scope succeeds from done/, byte-for-byte', () => {
  const { dir, backlog, doneBugPath } = boardFixture()
  const before = fs.readFileSync(doneBugPath)

  const out = run(dir, 'move', 'bug-3', 'out-of-scope')

  assert.equal(out.status, 0)
  const newPath = path.join(backlog, 'out-of-scope', path.basename(doneBugPath))
  assert.equal(out.stdout, newPath + '\n')
  assert.equal(fs.existsSync(doneBugPath), false)
  assert.ok(before.equals(fs.readFileSync(newPath)))
})

// move resolves a location and renames; it never parses. That is deliberate —
// a broken frontmatter block must not stand between an item and getting
// closed out or rejected — so a malformed item moves like any other.
test('CLI move moves a malformed item without parsing it, byte-for-byte', () => {
  const { dir, backlog } = boardFixture()
  const brokenPath = path.join(backlog, 'bugs', 'open', 'bug-9-broken-fence.md')
  const broken = '---\nid: bug-9\ntitle: Missing its closing fence\ncreated: 2026-08-01\n'
  fs.writeFileSync(brokenPath, broken)

  const out = run(dir, 'move', 'bug-9', 'done')

  assert.equal(out.status, 0)
  const newPath = path.join(backlog, 'bugs', 'done', 'bug-9-broken-fence.md')
  assert.equal(out.stdout, newPath + '\n')
  assert.equal(fs.readFileSync(newPath, 'utf8'), broken)
  assert.equal(fs.existsSync(brokenPath), false)
})

test('CLI move bug-7 nowhere exits 1 with a usage line naming both valid destinations', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'move', 'bug-7', 'nowhere')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /done/)
  assert.match(out.stderr, /out-of-scope/)
})

test('CLI move bug-7 done recreates bugs/done/ when it was deleted from the store', () => {
  const { dir, backlog, openBugPath } = boardFixture()
  fs.rmSync(path.join(backlog, 'bugs', 'done'), { recursive: true })

  const out = run(dir, 'move', 'bug-7', 'done')

  assert.equal(out.status, 0)
  const newPath = path.join(backlog, 'bugs', 'done', path.basename(openBugPath))
  assert.equal(fs.statSync(path.join(backlog, 'bugs', 'done')).isDirectory(), true)
  assert.equal(fs.existsSync(newPath), true)
})

test('after CLI move bug-7 out-of-scope, CLI show bug-7 resolves to the new path', () => {
  const { dir, backlog, openBugPath } = boardFixture()
  const moveOut = run(dir, 'move', 'bug-7', 'out-of-scope')
  assert.equal(moveOut.status, 0)
  const newPath = path.join(backlog, 'out-of-scope', path.basename(openBugPath))

  const out = run(dir, 'show', 'bug-7')

  assert.equal(out.status, 0)
  assert.equal(out.stdout.split('\n')[0], newPath)
})

test('after CLI move bug-7 out-of-scope, CLI board no longer lists bug-7', () => {
  const { dir } = boardFixture()
  const moveOut = run(dir, 'move', 'bug-7', 'out-of-scope')
  assert.equal(moveOut.status, 0)

  const out = run(dir, 'board')

  assert.equal(out.status, 0)
  assert.doesNotMatch(out.stdout, /bug-7/)
})

// End-to-end regression for the nextId fix above: a unit test on nextId
// alone would not catch this, because the bug only shows up once new and
// move are chained through real files on disk exactly as a skill would.
// Before the fix, this reproduced with bug-2 handed out twice: new bugs
// 'First bug' -> bug-1, new bugs 'Second bug' -> bug-2, move bug-2
// out-of-scope, new bugs 'Third bug' -> bug-2 again (should be bug-3).
test('CLI new bugs allocates bug-3 after bug-2 is rejected into out-of-scope, not the freed-looking bug-2', () => {
  const { dir } = backlogFixture()

  const out1 = run(dir, 'new', 'bugs', 'First bug')
  assert.equal(out1.status, 0)
  const path1 = out1.stdout.split('\n')[0]
  fs.mkdirSync(path.dirname(path1), { recursive: true })
  fs.writeFileSync(path1, out1.stdout.split('\n').slice(1).join('\n'))

  const out2 = run(dir, 'new', 'bugs', 'Second bug')
  assert.equal(out2.status, 0)
  const path2 = out2.stdout.split('\n')[0]
  assert.match(path2, /bug-2-second-bug\.md$/)
  fs.writeFileSync(path2, out2.stdout.split('\n').slice(1).join('\n'))

  const moveOut = run(dir, 'move', 'bug-2', 'out-of-scope')
  assert.equal(moveOut.status, 0)

  const out3 = run(dir, 'new', 'bugs', 'Third bug')
  assert.equal(out3.status, 0)
  const path3 = out3.stdout.split('\n')[0]
  assert.match(path3, /bug-3-third-bug\.md$/)
})

// --- board registry ----------------------------------------------------------

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-registry-'))
  return path.join(dir, 'nested', 'registry.json') // nested: mkdir -p is part of the contract
}

test('registryFile honours BM_REGISTRY_FILE and falls back to the home default', () => {
  const prev = process.env.BM_REGISTRY_FILE
  try {
    process.env.BM_REGISTRY_FILE = '/tmp/somewhere/registry.json'
    assert.equal(registryFile(), '/tmp/somewhere/registry.json')
    delete process.env.BM_REGISTRY_FILE
    assert.equal(registryFile(), path.join(os.homedir(), '.backlog-manager', 'registry.json'))
  } finally {
    if (prev === undefined) delete process.env.BM_REGISTRY_FILE
    else process.env.BM_REGISTRY_FILE = prev
  }
})

test('registerProject inserts a new project with name = basename and an ISO createdAt', () => {
  const file = tmpRegistry()
  registerProject('/abs/path/my-project', file)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.projects.length, 1)
  assert.equal(written.projects[0].name, 'my-project')
  assert.equal(written.projects[0].path, '/abs/path/my-project')
  assert.ok(!Number.isNaN(Date.parse(written.projects[0].createdAt)))
})

test('registerProject upserts by path and never rewrites createdAt', () => {
  const file = tmpRegistry()
  registerProject('/abs/path/my-project', file)
  const first = JSON.parse(fs.readFileSync(file, 'utf8')).projects[0]
  registerProject('/abs/path/my-project', file)
  const again = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(again.projects.length, 1)
  assert.equal(again.projects[0].createdAt, first.createdAt)
})

test('registerProject keeps other projects and appends new ones', () => {
  const file = tmpRegistry()
  registerProject('/abs/one', file)
  registerProject('/abs/two', file)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(written.projects.map((p) => p.path), ['/abs/one', '/abs/two'])
})

test('registerProject starts fresh over a corrupt registry rather than failing', () => {
  const file = tmpRegistry()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'not json')
  registerProject('/abs/one', file)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.projects.length, 1)
})
