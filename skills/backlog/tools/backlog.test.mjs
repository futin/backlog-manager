import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BacklogError, SECTIONS, resolveRoot, slugify, init, parseFrontmatter, renderFrontmatter, nextId, readItem, listOpen, registerProject, unregisterProject, registryFile, linkedWorktreeInfo, registryRoot, startItem, stopItem, transcriptFiles, sumFreshTokens, sessionTokensSince, parseOriginRepo, isValidRepo, backlogItemFiles } from './backlog.mjs'
import { IMPORT_BODY_CAP } from './import-lib.mjs'

const SCRIPT = fileURLToPath(new URL('./backlog.mjs', import.meta.url))
const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd })
// The same spawn with the child's environment named outright, for the two
// Task 11 cases that are ABOUT the environment (a session id and a config dir
// pointing at a fixture transcript). A sibling rather than an extra parameter
// on `run` so that every existing `run(dir, ...)` call site stays byte-
// identical — those tests care about the tool, not about what it inherits.
const runWithEnv = (cwd, env, ...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd, env })

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

// The same hazard again, for Task 11's token counting, and it only appears in
// one environment: run this suite from inside a Claude Code session and every
// fixture `stop --as groom` below would resolve the DEVELOPER'S LIVE
// TRANSCRIPT — `run` spawns the real CLI as a child that inherits this
// process's env, CLAUDE_CODE_SESSION_ID included — and bill real tokens into
// throwaway items, turning several round-trip assertions red for reasons that
// have nothing to do with the change. Deleting the session id is what makes
// the ambient case deterministic; pointing CLAUDE_CONFIG_DIR at an empty
// throwaway directory covers the same hazard from the other side, so even a
// child that somehow acquires a session id has no transcript to find. The two
// tests that WANT a transcript opt in explicitly by passing an env to
// `runWithEnv` above.
delete process.env.CLAUDE_CODE_SESSION_ID
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-config-test-'))

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

test('init creates all nine leaf directories plus a non-empty README', () => {
  const { backlog } = backlogFixture()

  const created = init(backlog)

  assert.equal(created.length, 10)
  for (const rel of [
    'bugs/open',
    'bugs/done',
    'ideas/open',
    'ideas/done',
    'tasks/open',
    'tasks/done',
    'refactors/open',
    'refactors/done',
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

// The value `start` writes contains colons, and the split is on the FIRST one.
// Asserted rather than reasoned about, because the whole in-progress timer
// rests on this one line surviving a parse/render cycle intact.
test('parseFrontmatter keeps a timestamped started value whole, colons included', () => {
  const doc = '---\nid: bug-1\nstarted: 2026-08-28T14:03:07Z\n---\nbody\n'

  const { data } = parseFrontmatter(doc)

  assert.equal(data.started, '2026-08-28T14:03:07Z')
  assert.match(renderFrontmatter(data), /^started: 2026-08-28T14:03:07Z$/m)
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

test('CLI board --json prints a parseable array of items with all seven fields', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'board', '--json')

  assert.equal(out.status, 0)
  const items = JSON.parse(out.stdout)
  assert.equal(items.length, 1)
  for (const key of ['id', 'section', 'title', 'created', 'ageDays', 'started', 'path']) {
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

// --- start / stop ------------------------------------------------------------
// `start` and `stop` are the only commands that rewrite an EXISTING item's
// content: `new` writes a file that did not exist, and `move` renames without
// ever opening one. So most of what follows is about what they must not
// disturb — the body, unknown keys, and every byte of a file they refuse to
// touch — rather than about the one line they add.

const TODAY = new Date().toISOString().slice(0, 10)

// writeItem's items have no body at all, which is exactly the case where a
// body-preserving bug hides. Anything asserting on the body uses this.
function writeItemWithBody(backlog, rel, id, title, body) {
  const filePath = path.join(backlog, rel, `${id}-${slugify(title)}.md`)
  fs.writeFileSync(filePath, `${renderFrontmatter({ id, title, created: '2026-01-02' })}\n${body}`)
  return filePath
}

// Second-precision UTC, `Z`-suffixed, no milliseconds. The shape is asserted
// rather than a literal value because the CLI runs in a child process with its
// own clock — what matters is that the line is a timestamp and not a bare date,
// since the card's minutes-and-hours label has nothing to read otherwise.
const STAMP_LINE = /^started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m
// Same shape as STAMP_LINE, but for asserting against a parsed value (e.g.
// `parseFrontmatter(...).data.started`) rather than a raw frontmatter line.
const STAMP_LINE_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

test('CLI start bug-7 adds a started: line stamped to the second in UTC and prints the item path', () => {
  const { dir, openBugPath } = boardFixture()

  const out = run(dir, 'start', 'bug-7')

  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.split('\n')[0], openBugPath)
  const text = fs.readFileSync(openBugPath, 'utf8')
  assert.match(text, STAMP_LINE)
  // The date the CLI ran is still in there — the timestamp is a refinement of
  // the old value, not a different fact.
  assert.match(text, new RegExp(`^started: ${TODAY}T`, 'm'))
})

// The injected stamp is what the tool writes, verbatim: `startItem`'s third
// parameter is the seam every caller-supplied time goes through, and a test
// that only ever checks a regex cannot tell a passthrough from a re-derivation.
test('startItem writes the stamp it is handed, unchanged', () => {
  const { backlog, openBugPath } = boardFixture()

  startItem(backlog, 'bug-7', '2026-08-28T14:03:07Z')

  assert.match(fs.readFileSync(openBugPath, 'utf8'), /^started: 2026-08-28T14:03:07Z$/m)
})

// Every file stamped before `start` wrote a time carries a bare date, and
// nothing rewrites an existing item's frontmatter — so both shapes are on disk
// permanently. The refusal must name whichever one it found, or a re-run
// silently moves the value forward and erases the age the value exists to carry.
test('CLI start refuses an item already started with a legacy date-only value, naming that value', () => {
  const { dir, openBugPath } = boardFixture()
  const { data, body } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  fs.writeFileSync(openBugPath, `${renderFrontmatter({ ...data, started: '2026-08-26' })}\n${body}`)
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'start', 'bug-7')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-7 is already in progress/)
  assert.match(out.stderr, /2026-08-26/)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('CLI start leaves the body byte-for-byte identical, fences and blank lines included', () => {
  const { dir, backlog } = boardFixture()
  const body = '\n## Cause\n\nThe cache never invalidates.\n\n```js\nconst a = 1\n```\n\n\n## Fix\n\nunknown\n'
  const itemPath = writeItemWithBody(backlog, 'tasks/open', 'task-4', 'Rework the cache', body)

  const out = run(dir, 'start', 'task-4')

  assert.equal(out.status, 0, out.stderr)
  const text = fs.readFileSync(itemPath, 'utf8')
  assert.equal(text.slice(text.indexOf('---', 3) + 4), body)
})

test('CLI start preserves an unknown frontmatter key such as from:', () => {
  const { dir, backlog } = boardFixture()
  const itemPath = path.join(backlog, 'tasks/open', 'task-4-promoted.md')
  fs.writeFileSync(itemPath, `${renderFrontmatter({ id: 'task-4', title: 'Promoted', created: '2026-01-02', from: 'idea-9' })}\n`)

  const out = run(dir, 'start', 'task-4')

  assert.equal(out.status, 0, out.stderr)
  assert.match(fs.readFileSync(itemPath, 'utf8'), /^from: idea-9$/m)
})

test('CLI start bug-7 twice refuses, names the date already there, and leaves the file untouched', () => {
  const { dir, openBugPath } = boardFixture()
  assert.equal(run(dir, 'start', 'bug-7').status, 0)
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'start', 'bug-7')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-7 is already in progress/)
  assert.match(out.stderr, new RegExp(TODAY))
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('CLI start bug-3 refuses because a done item has nothing left to start', () => {
  const { dir, doneBugPath } = boardFixture()
  const before = fs.readFileSync(doneBugPath, 'utf8')

  const out = run(dir, 'start', 'bug-3')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-3 is done/)
  assert.equal(fs.readFileSync(doneBugPath, 'utf8'), before)
})

test('CLI start oos-2 refuses because out-of-scope is terminal', () => {
  const { dir, oosPath } = boardFixture()
  const before = fs.readFileSync(oosPath, 'utf8')

  const out = run(dir, 'start', 'oos-2')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /oos-2 is out of scope/)
  assert.equal(fs.readFileSync(oosPath, 'utf8'), before)
})

// Grooming an idea — promoting it to a task, or rejecting it outright — is
// itself the active work a started: marker exists to describe, so start no
// longer refuses ideas. backlog-groom is the skill that now owns the
// marker's whole lifecycle on an idea: start on the way in, stop on the way
// out (its own refusal is unaffected — this only removes start's).
test('CLI start idea-5 succeeds, because grooming an idea is the active work the marker describes', () => {
  const { dir, backlog } = boardFixture()
  // A real body — fence and blank lines included, same shape as the
  // byte-for-byte precedent above for a task — so the round-trip assertion
  // below has something to actually corrupt if start ever touched the body.
  const body = '\n## Notes\n\nWorth spiking once the API settles.\n\n```js\nconst rows = fetchRows()\n```\n\n\nSee also idea-2.\n'
  const ideaPath = writeItemWithBody(backlog, 'ideas/open', 'idea-5', 'Maybe a graph view', body)

  const out = run(dir, 'start', 'idea-5')

  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.split('\n')[0], ideaPath)
  const text = fs.readFileSync(ideaPath, 'utf8')
  assert.match(text, STAMP_LINE)
  assert.equal(parseFrontmatter(text).body, body)
})

test('CLI start bug-99 exits 1 and names the unknown id', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'start', 'bug-99')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /unknown id: bug-99/)
})

test('CLI start with no id exits 1 and prints a usage line naming both verbs, each flag on its own line only', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'start')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /usage: backlog\.mjs start <id>/)
  // `--as` is start's own flag and `--abandon` is stop's own flag: stop reads
  // phase off the file instead of taking it as a flag (see the "phase"
  // section below), and start has no dead marker to walk away from, so
  // neither line should suggest the other verb takes its flag. Asserted
  // line-by-line rather than with one regex so a future edit that moved a
  // flag onto the wrong line fails clearly instead of just failing to match
  // at all.
  const lines = out.stderr.trim().split('\n')
  assert.match(lines[0], /^usage: backlog\.mjs start <id> \[--as groom\|execute\]$/)
  assert.match(lines[1], /^\s*backlog\.mjs stop <id> \[--abandon\] \[--keep-started\]$/)
  assert.doesNotMatch(lines[0], /--abandon/)
  assert.doesNotMatch(lines[1], /--as/)
})

test('CLI start exits 3 and names init when there is no backlog/ store yet', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'start', 'bug-1')

  assert.equal(out.status, 3)
  assert.match(out.stderr, /init/)
})

// Pre-dates the updated: stamp, back when stop really did restore the whole
// file byte-for-byte: start and stop were the only two writes, and stop's
// write undid start's. That is no longer literally true — writeItemFile now
// stamps `updated:` on every write it makes, stop's included, so the second
// write does not undo the first one's effect on that one line; it only ever
// refreshes it. What still holds, and is what this asserts now: the body is
// untouched, `started` is gone again, and every OTHER key is back to
// exactly what it was — `updated` is the one line allowed, and expected, to
// differ from `before`.
test('CLI stop bug-7 removes the started: line, leaving the body and every other key as they were', () => {
  const { dir, openBugPath } = boardFixture()
  const beforeText = fs.readFileSync(openBugPath, 'utf8')
  const before = parseFrontmatter(beforeText)
  assert.equal(run(dir, 'start', 'bug-7').status, 0)
  assert.notEqual(fs.readFileSync(openBugPath, 'utf8'), beforeText)

  const out = run(dir, 'stop', 'bug-7')

  assert.equal(out.status, 0, out.stderr)
  const after = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(after.body, before.body)
  assert.equal('started' in after.data, false)
  const { updated, ...afterRest } = after.data
  assert.deepEqual(afterRest, before.data)
  assert.match(updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

// stop's job is clearing a marker, and it must not learn to care which of the
// two shapes it is clearing — a legacy date-only value on an item someone
// abandoned is precisely a marker worth being able to remove. Same
// updated:-is-the-one-exception adjustment as the test above.
test('CLI stop bug-7 removes a legacy date-only started: line as readily as a timestamp', () => {
  const { dir, openBugPath } = boardFixture()
  const before = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  fs.writeFileSync(openBugPath, `${renderFrontmatter({ ...before.data, started: '2026-08-26' })}\n${before.body}`)

  const out = run(dir, 'stop', 'bug-7')

  assert.equal(out.status, 0, out.stderr)
  const after = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(after.body, before.body)
  assert.equal('started' in after.data, false)
  const { updated, ...afterRest } = after.data
  assert.deepEqual(afterRest, before.data)
  assert.match(updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('CLI stop bug-7 refuses when the item was never started, leaving the file untouched', () => {
  const { dir, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'stop', 'bug-7')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-7 is not in progress/)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

// The whole point of keeping `started` out of move's way: an archived item
// keeps the moment it was picked up, so "started 01-02, done today" survives in
// the file. move never reads content, so this is really a test that start
// wrote something move can carry.
test('CLI move bug-7 done after a start keeps the started: line in the archived file', () => {
  const { dir, backlog, openBugPath } = boardFixture()
  assert.equal(run(dir, 'start', 'bug-7').status, 0)

  const out = run(dir, 'move', 'bug-7', 'done')

  assert.equal(out.status, 0, out.stderr)
  const movedPath = path.join(backlog, 'bugs/done', path.basename(openBugPath))
  assert.match(fs.readFileSync(movedPath, 'utf8'), STAMP_LINE)
})

test('CLI board marks a started item with the » column', () => {
  const { dir } = boardFixture()
  assert.equal(run(dir, 'start', 'bug-7').status, 0)

  const out = run(dir, 'board')

  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /»\s*Deck scroll chains/)
})

// The column is conditional so that a board with no work in progress prints
// exactly the bytes it printed before this feature existed — the `backlog`
// skill shows this output to a human, and every unstarted board is the
// common case.
test('CLI board with nothing started prints no » column at all', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'board')

  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stdout, /»/)
})

test('CLI board --json carries started, empty for an item nobody has started', () => {
  const { dir, backlog } = boardFixture()
  writeItem(backlog, 'tasks/open', 'task-4', 'Untouched task')
  assert.equal(run(dir, 'start', 'bug-7').status, 0)

  const out = run(dir, 'board', '--json')

  assert.equal(out.status, 0, out.stderr)
  const items = JSON.parse(out.stdout)
  // Verbatim, timestamp and all: consumers age this value themselves (the
  // board's own card reads it down to the minute), so anything truncated here
  // is information they cannot get back.
  assert.match(items.find((i) => i.id === 'bug-7').started, new RegExp(`^${TODAY}T\\d{2}:\\d{2}:\\d{2}Z$`))
  assert.equal(items.find((i) => i.id === 'task-4').started, '')
})

// --- updated: stamp -----------------------------------------------------------
// `updated` is stamped by writeItemFile itself (see the comment there), so
// both start and stop refresh it as a side effect of the one thing they
// already do — rewrite the file. move is the deliberate exception: it never
// calls writeItemFile at all (see moveItem's own comment), so the regression
// guard at the end of this section pins that down directly rather than
// relying on it staying true by omission.

test('startItem on an item with no updated: key adds one, as the last key, holding the stamp it was handed', () => {
  const { backlog, openBugPath } = boardFixture()

  startItem(backlog, 'bug-7', '2026-08-30T12:00:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  // `tags` is excluded from this order check on purpose: renderFrontmatter
  // never writes a `tags:` line when it's empty (see renderFrontmatter's own
  // comment), so it is not a real line in the file at all — re-parsing puts
  // it back at the very end regardless of where it started, which would
  // make this assertion about the file's real key order say something false
  // about `tags` specifically. `updated` must land after every key the file
  // ACTUALLY HAD and after the `started` this same call just added.
  assert.deepEqual(Object.keys(data).filter((k) => k !== 'tags'), ['id', 'title', 'created', 'started', 'updated'])
  assert.equal(data.updated, '2026-08-30T12:00:00Z')
})

test('startItem on an item that already has updated: overwrites it in place, keeping title right after it', () => {
  const { backlog, openBugPath } = boardFixture()
  const { body } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  fs.writeFileSync(
    openBugPath,
    `${renderFrontmatter({ id: 'bug-7', updated: '2026-01-01T00:00:00Z', title: 'Deck scroll chains out of the phone overlay' })}\n${body}`,
  )

  startItem(backlog, 'bug-7', '2026-08-30T12:00:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  // A spread preserves an existing key's position — `updated` must still be
  // the second key, with `title` immediately after it, exactly as before
  // start ran. Only the VALUE changes. `tags` is excluded from the order
  // check for the same reason as the sibling test above: it never renders
  // when empty, so a fresh re-parse always puts it last regardless of where
  // it actually started.
  assert.deepEqual(Object.keys(data).filter((k) => k !== 'tags'), ['id', 'updated', 'title', 'started'])
  assert.equal(data.updated, '2026-08-30T12:00:00Z')
})

test('stopItem stamps updated: too, to the exact value it is handed', () => {
  const { backlog, openBugPath } = boardFixture()
  startItem(backlog, 'bug-7')

  stopItem(backlog, 'bug-7', '2026-08-30T12:00:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data.updated, '2026-08-30T12:00:00Z')
})

test('CLI start then stop preserve unknown frontmatter keys unchanged and in their original relative order', () => {
  const { dir, backlog } = boardFixture()
  const itemPath = path.join(backlog, 'tasks/open', 'task-4-promoted.md')
  fs.writeFileSync(
    itemPath,
    `${renderFrontmatter({ id: 'task-4', title: 'Promoted', created: '2026-01-02', from: 'idea-3', 'promoted-to': 'task-9' })}\n`,
  )

  assert.equal(run(dir, 'start', 'task-4').status, 0)
  assert.equal(run(dir, 'stop', 'task-4').status, 0)

  const text = fs.readFileSync(itemPath, 'utf8')
  assert.match(text, /^from: idea-3$/m)
  assert.match(text, /^promoted-to: task-9$/m)
  assert.ok(text.indexOf('from:') < text.indexOf('promoted-to:'), 'from: must still precede promoted-to:')
  // The point of the round trip: stop's own rewrite must not have dropped
  // the stamp start's rewrite just added.
  assert.match(text, /^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m)
})

test('CLI start then stop leave a body byte-for-byte identical, even one containing its own --- line', () => {
  const { dir, backlog } = boardFixture()
  // A `---` line inside the body, trailing whitespace on a real content
  // line, and a trailing newline at the very end — three ways a naive
  // byte-preservation bug could show up, all in one fixture.
  const body = '\n## Notes\n\n---\n\nTrailing spaces on this line.   \n'
  const itemPath = writeItemWithBody(backlog, 'tasks/open', 'task-4', 'Rework the cache', body)

  assert.equal(run(dir, 'start', 'task-4').status, 0)
  assert.equal(run(dir, 'stop', 'task-4').status, 0)

  const text = fs.readFileSync(itemPath, 'utf8')
  // The stamp lands somewhere in the frontmatter — the assertion below is
  // what actually matters here, but confirming it exists first keeps a
  // future regression from passing this test for the wrong reason (an
  // `updated:` line that itself corrupted the body would still slice out
  // the same bytes below if the fence-finding logic broke in just the
  // wrong way).
  assert.match(text, /^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m)
  assert.equal(text.slice(text.indexOf('---', 3) + 4), body)
})

// The regression guard: move must gain no updated: key of its own. This
// passes already, before writeItemFile stamps anything — moveItem never
// calls writeItemFile at all, only fs.renameSync — so it proves the
// exclusion rather than target it.
test('CLI move does not add an updated: key and leaves the file byte-for-byte unchanged', () => {
  const { dir, backlog, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath)

  const out = run(dir, 'move', 'bug-7', 'done')

  assert.equal(out.status, 0, out.stderr)
  const newPath = path.join(backlog, 'bugs', 'done', path.basename(openBugPath))
  const after = fs.readFileSync(newPath)
  assert.ok(before.equals(after))
  assert.doesNotMatch(after.toString('utf8'), /^updated:/m)
})

// --- phase ---------------------------------------------------------------
// `phase` names which activity currently holds the started: marker — the
// value `--as` writes. It is layered strictly on top of everything above:
// omit `--as` and start behaves exactly as it did before this section
// existed (no phase: key at all, not even an empty one), and every existing
// refusal (done, out-of-scope, already-started) fires the same way whether
// or not `--as` was given. Task 3 is what makes `stop` read this key back
// to bill elapsed time; these tests only cover start writing and refusing
// it, and stop refusing the flag outright.

test('CLI start --as groom writes phase: groom alongside started:', () => {
  const { dir, openBugPath } = boardFixture()

  const out = run(dir, 'start', 'bug-7', '--as', 'groom')

  assert.equal(out.status, 0, out.stderr)
  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data.phase, 'groom')
  assert.match(data.started, STAMP_LINE_VALUE)
})

test('CLI start --as execute writes phase: execute', () => {
  const { dir, openBugPath } = boardFixture()

  const out = run(dir, 'start', 'bug-7', '--as', 'execute')

  assert.equal(out.status, 0, out.stderr)
  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data.phase, 'execute')
})

test('CLI start with no --as writes started: and no phase: key at all', () => {
  const { dir, openBugPath } = boardFixture()

  const out = run(dir, 'start', 'bug-7')

  assert.equal(out.status, 0, out.stderr)
  const text = fs.readFileSync(openBugPath, 'utf8')
  assert.match(text, STAMP_LINE)
  assert.doesNotMatch(text, /^phase:/m)
})

// An unrecognised value is a refusal naming both accepted ones, not a bare
// "invalid phase" the caller would have to guess at — and it must not write
// anything, so a mistyped --as can never leave started: set with no
// matching phase.
test('CLI start --as reviewing refuses, names both accepted values, and leaves the file untouched', () => {
  const { dir, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'start', 'bug-7', '--as', 'reviewing')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /groom/)
  assert.match(out.stderr, /execute/)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

// `--as` with nothing after it is a usage error, not "no phase" — silently
// falling back to the no-flag behavior here would make a truncated command
// line (a missing shell-quoted argument, say) succeed quietly instead of
// telling the caller their flag had no value.
test('CLI start --as with no value refuses with the start/stop usage text', () => {
  const { dir } = boardFixture()

  const out = run(dir, 'start', 'bug-7', '--as')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /^usage: backlog\.mjs start <id> \[--as groom\|execute\]$/m)
  assert.match(out.stderr, /^\s*backlog\.mjs stop <id> \[--abandon\] \[--keep-started\]$/m)
})

// stop reads the phase off the file (Task 3); a --as flag here could name
// something different from what is actually stored, so it is refused
// outright rather than accepted and ignored.
test('CLI stop rejects --as with the usage text and leaves the file untouched', () => {
  const { dir, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'stop', 'bug-7', '--as', 'groom')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /^usage: backlog\.mjs start <id> \[--as groom\|execute\]$/m)
  assert.match(out.stderr, /^\s*backlog\.mjs stop <id> \[--abandon\] \[--keep-started\]$/m)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

// start has no dead marker of its own to walk away from — --abandon only
// ever means something to stop, which is reading a marker back off the file
// to decide whether to bill it. Refused the same way stop already refuses
// --as: a usage error on the command line itself, before anything is read
// or written.
test('CLI start rejects --abandon with the usage text and leaves the file untouched', () => {
  const { dir, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'start', 'bug-7', '--abandon')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /^usage: backlog\.mjs start <id> \[--as groom\|execute\]$/m)
  assert.match(out.stderr, /^\s*backlog\.mjs stop <id> \[--abandon\] \[--keep-started\]$/m)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

// The groom skill's stale-marker takeover (SKILL.md) runs exactly this: stop
// --abandon, then start --as groom, to clear a marker nobody has been
// actively holding without billing the dead interval as if it were work. The
// existing bucket must survive completely untouched — --abandon skips the
// billing block entirely rather than billing zero, so it can never disagree
// with a corrupt or merely-inconvenient existing value either.
test('CLI stop --abandon clears the marker and stamps updated:, without billing the existing bucket at all', () => {
  const { dir, openBugPath } = boardFixture()
  run(dir, 'start', 'bug-7', '--as', 'groom')
  // Backdated well past "now" rather than left at the real start's stamp: if
  // --abandon failed to suppress billing, the seconds between this stale
  // marker and "now" would be enormous and unmistakably wrong, not a
  // coincidental near-zero gap that could pass whether or not the skip
  // actually works.
  withFrontmatter(openBugPath, { started: '2020-01-01T00:00:00Z', 'groom-elapsed': 90 })

  const out = run(dir, 'stop', 'bug-7', '--abandon')

  assert.equal(out.status, 0)
  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-elapsed'], '90')
  assert.equal('started' in data, false)
  assert.equal('phase' in data, false)
  assert.match(data.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

// --abandon changes what stop does with a live marker, not whether one has
// to exist first: an item with nothing to clear is exactly as much a refusal
// with --abandon as without it.
test('CLI stop --abandon on an item that was never started still refuses with the existing message', () => {
  const { dir, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'stop', 'bug-7', '--abandon')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-7 is not in progress/)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('CLI start --as groom twice refuses on the second call with the existing already-in-progress message', () => {
  const { dir } = boardFixture()
  assert.equal(run(dir, 'start', 'bug-7', '--as', 'groom').status, 0)

  const out = run(dir, 'start', 'bug-7', '--as', 'groom')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-7 is already in progress/)
  assert.match(out.stderr, new RegExp(TODAY))
})

// --- elapsed billing (stop) ---------------------------------------------------
// stopItem bills the wall-clock time between `started:` and the stamp it is
// handed into whichever of `groom-elapsed:` / `execute-elapsed:` the item's
// `phase:` key names (see PHASES's own comment for why there are exactly
// two). Every case below drives stopItem directly with a pinned `stamp` —
// the same seam startItem's own "writes the stamp it is handed" test above
// uses — because the CLI never exposes a way to pin the clock, and seconds
// arithmetic is exactly the kind of assertion a real clock would make flaky.
//
// T0 is the one `started:` value every case shares, so each test states only
// what actually varies: the phase, any pre-existing bucket value, and the
// stamp stop is handed.
const T0 = '2026-08-30T10:00:00Z'

// The one `stamp` value the Task 7 (`--keep-started`) cases below share —
// 7860 seconds (2h11m) after T0 — so each of those states only what varies:
// the phase, any pre-existing bucket value, and whether `started:` survives.
const STAMP = '2026-08-30T12:11:00Z'

// Overwrites just the named frontmatter fields on an already-written item,
// keeping every other key and the body exactly as boardFixture/writeItem (or
// writeItemWithBody) left them — the same read-modify-write shape the
// legacy-date test earlier in this file uses, pulled out here because every
// case below needs it.
function withFrontmatter(itemPath, fields) {
  const { data, body } = parseFrontmatter(fs.readFileSync(itemPath, 'utf8'))
  fs.writeFileSync(itemPath, `${renderFrontmatter({ ...data, ...fields })}\n${body}`)
}

test('stopItem bills a first groom session into groom-elapsed and clears started/phase', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', '2026-08-30T10:01:30Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-elapsed'], '90')
  assert.equal('started' in data, false)
  assert.equal('phase' in data, false)
})

test('stopItem accumulates onto an existing groom-elapsed rather than overwriting it', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom', 'groom-elapsed': 90 })

  stopItem(backlog, 'bug-7', '2026-08-30T10:00:30Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-elapsed'], '120')
})

test('stopItem bills execute into its own bucket, leaving groom-elapsed untouched', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'execute', 'groom-elapsed': 90 })

  stopItem(backlog, 'bug-7', '2026-08-30T10:00:10Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['execute-elapsed'], '10')
  assert.equal(data['groom-elapsed'], '90')
})

test('stopItem with no phase: key bills nothing, but still clears started and stamps updated', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0 })

  stopItem(backlog, 'bug-7', '2026-08-30T10:05:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-elapsed' in data, false)
  assert.equal('execute-elapsed' in data, false)
  assert.equal('started' in data, false)
  assert.match(data.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('stopItem never bills a legacy bare-date started:, though it still clears it', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: '2026-08-30', phase: 'groom' })

  stopItem(backlog, 'bug-7', '2026-08-30T10:05:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-elapsed' in data, false)
  assert.equal('started' in data, false)
  assert.equal('phase' in data, false)
  assert.match(data.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

// FULL_TIMESTAMP is a shape test, not a validity test: `2026-08-30T25:00:00Z`
// matches its digit pattern exactly but names an hour that does not exist, so
// Date.parse returns NaN for it. Before this guard, that NaN flowed straight
// into the arithmetic and out to disk as the literal string "NaN" — and
// because DIGITS_ONLY (a few lines above) then refuses to touch that value on
// any later stop, the item was permanently wedged: stop could never bill
// again, and start could never re-stamp a file that still carried the old
// started:. Treated exactly like the legacy bare-date case just above: cleared,
// never billed.
test('stopItem never bills an unparseable started: that still matches the timestamp shape, and writes no bucket at all', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: '2026-08-30T25:00:00Z', phase: 'groom' })

  stopItem(backlog, 'bug-7', '2026-08-30T10:05:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-elapsed' in data, false)
  assert.equal('started' in data, false)
  assert.equal('phase' in data, false)
  assert.match(data.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  // The point of this test: no matter what, "NaN" must never reach the file.
  assert.doesNotMatch(fs.readFileSync(openBugPath, 'utf8'), /NaN/)
})

// A hand-edited phase: value outside PHASES (e.g. a typo, or a value from
// some future version) falls through the PHASES.includes guard exactly like
// no phase: at all — nothing to bill against, but the marker still clears.
// This is the same "cleared but not billed" shape as the bare-date and
// unparseable-timestamp cases above; unlike those two, this one is reachable
// only by hand-editing the file, since startItem itself never writes a phase
// outside PHASES.
test('stopItem bills nothing for an unrecognized phase:, but still clears both keys', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'intake' })

  stopItem(backlog, 'bug-7', '2026-08-30T10:05:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-elapsed' in data, false)
  assert.equal('execute-elapsed' in data, false)
  assert.equal('started' in data, false)
  assert.equal('phase' in data, false)
  assert.match(data.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('stopItem floors a stamp earlier than started to 0 rather than a negative number', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', '2026-08-30T09:59:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-elapsed'], '0')
})

test('stopItem bills 0 seconds when the stamp equals started exactly', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', T0)

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-elapsed'], '0')
})

// Overwriting a corrupt bucket would destroy a number nobody can recover, so
// stop refuses outright rather than resetting it to 0 — the same "a refusal
// must not also be the thing that does the damage" guarantee move's own
// occupied-destination refusal makes for a file it might otherwise clobber.
test('stopItem refuses a non-numeric groom-elapsed, naming the key and the bad value, and writes nothing', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom', 'groom-elapsed': 'abc' })
  const before = fs.readFileSync(openBugPath, 'utf8')

  assert.throws(
    () => stopItem(backlog, 'bug-7', '2026-08-30T10:01:00Z'),
    (e) => e instanceof BacklogError && e.code === 1 && /groom-elapsed/.test(e.message) && /abc/.test(e.message),
  )
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('stopItem refuses a negative groom-elapsed just as it refuses a non-numeric one, writing nothing', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom', 'groom-elapsed': -5 })
  const before = fs.readFileSync(openBugPath, 'utf8')

  assert.throws(
    () => stopItem(backlog, 'bug-7', '2026-08-30T10:01:00Z'),
    (e) => e instanceof BacklogError && e.code === 1,
  )
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('stopItem removes phase: unconditionally, whichever phase it names', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'execute' })

  stopItem(backlog, 'bug-7', '2026-08-30T11:00:00Z')

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('phase' in data, false)
})

test('stopItem on an item never started still refuses with the existing message, file untouched', () => {
  const { backlog, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  assert.throws(
    () => stopItem(backlog, 'bug-7', '2026-08-30T10:05:00Z'),
    (e) => e instanceof BacklogError && e.code === 1 && /bug-7 is not in progress/.test(e.message),
  )
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('stopItem bills groom time and round-trips an unknown key and the body byte-for-byte', () => {
  const { backlog } = boardFixture()
  const body = '\n## Notes\n\n---\n\nSome content.\n'
  const itemPath = writeItemWithBody(backlog, 'tasks/open', 'task-4', 'Promoted task', body)
  withFrontmatter(itemPath, { started: T0, phase: 'groom', from: 'idea-3' })

  stopItem(backlog, 'task-4', '2026-08-30T10:01:00Z')

  const { data, body: afterBody } = parseFrontmatter(fs.readFileSync(itemPath, 'utf8'))
  assert.equal(data.from, 'idea-3')
  assert.equal(data['groom-elapsed'], '60')
  assert.equal(afterBody, body)
})

// --- --keep-started (Task 7) --------------------------------------------------
// Closes the gap the whole-branch review found: backlog-execute's successful
// archive moved a fix or task to done/ without ever calling `stop`, so the
// headline number — how long the execution actually took — was never
// recorded for a task that finished, only for one that was abandoned. `stop
// --keep-started` bills exactly as a plain `stop` does and still drops
// `phase:`, but leaves `started:` on the file instead of clearing it, so an
// archived item ends up with all three facts: when work began (`started`),
// how long it took (`execute-elapsed`), and when it ended (`updated`).
//
// Every billing-shape case below is the direct `opts.keepStarted: true`
// counterpart of an existing plain-`stop` case above — same T0, same STAMP
// (7860s later) — so a diff between the two proves `--keep-started` changes
// nothing about the gate or the arithmetic, only whether `started:` survives.

test('stopItem --keep-started bills execute-elapsed and leaves started: in place', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'execute' })

  stopItem(backlog, 'bug-7', STAMP, { keepStarted: true })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['execute-elapsed'], '7860')
  assert.equal(data.started, T0)
  assert.equal('phase' in data, false)
  assert.equal(data.updated, STAMP)
})

test('stopItem --keep-started accumulates onto an existing execute-elapsed rather than overwriting it', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'execute', 'execute-elapsed': 100 })

  stopItem(backlog, 'bug-7', STAMP, { keepStarted: true })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['execute-elapsed'], '7960')
})

test('stopItem --keep-started bills groom-elapsed just as readily, and still keeps started:', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', STAMP, { keepStarted: true })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-elapsed'], '7860')
  assert.equal(data.started, T0)
})

// Regression guard: the two existing behaviours below must survive the
// signature change from a lone `abandon` boolean to `opts.{abandon,
// keepStarted}` unchanged — a lone `stop`, and `stop --abandon`, must still
// clear `started:` exactly as they did before `keepStarted` existed.
test('stopItem with no opts still removes started: on an execute phase — regression guard', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'execute' })

  stopItem(backlog, 'bug-7', STAMP)

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['execute-elapsed'], '7860')
  assert.equal('started' in data, false)
})

test('stopItem with { abandon: true } bills nothing and still removes started: — regression guard', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'execute' })

  stopItem(backlog, 'bug-7', STAMP, { abandon: true })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('execute-elapsed' in data, false)
  assert.equal('started' in data, false)
})

// `--abandon` and `--keep-started` together have no meaning worth inventing
// (see the CLI's own comment on this refusal): abandoning already leaves
// nothing dated for `--keep-started` to preserve. Refused as a usage error,
// at the CLI layer, before the file is ever opened.
test('CLI stop --abandon --keep-started together is a usage error, file untouched', () => {
  const { dir, openBugPath } = boardFixture()
  assert.equal(run(dir, 'start', 'bug-7', '--as', 'execute').status, 0)
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'stop', 'bug-7', '--abandon', '--keep-started')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /^usage: backlog\.mjs start <id> \[--as groom\|execute\]$/m)
  assert.match(out.stderr, /^\s*backlog\.mjs stop <id> \[--abandon\] \[--keep-started\]$/m)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

// start has no dead marker of its own to preserve `started:` on — refused
// the same way it already refuses --abandon.
test('CLI start rejects --keep-started with the usage text and leaves the file untouched', () => {
  const { dir, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'start', 'bug-7', '--keep-started')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /^usage: backlog\.mjs start <id> \[--as groom\|execute\]$/m)
  assert.match(out.stderr, /^\s*backlog\.mjs stop <id> \[--abandon\] \[--keep-started\]$/m)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

// `--keep-started` changes what a live marker's stop leaves behind; it does
// not change whether one has to exist first.
test('CLI stop --keep-started on an item never started still refuses with the existing message', () => {
  const { dir, openBugPath } = boardFixture()
  const before = fs.readFileSync(openBugPath, 'utf8')

  const out = run(dir, 'stop', 'bug-7', '--keep-started')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /bug-7 is not in progress/)
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('stopItem --keep-started never bills a legacy bare-date started:, but keeps it verbatim', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: '2026-08-30', phase: 'groom' })

  stopItem(backlog, 'bug-7', STAMP, { keepStarted: true })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-elapsed' in data, false)
  assert.equal(data.started, '2026-08-30')
  assert.equal('phase' in data, false)
  assert.match(data.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('stopItem --keep-started never bills an unparseable started:, writes no NaN, and keeps it verbatim', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: '2026-08-30T25:00:00Z', phase: 'groom' })

  stopItem(backlog, 'bug-7', STAMP, { keepStarted: true })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-elapsed' in data, false)
  assert.equal(data.started, '2026-08-30T25:00:00Z')
  assert.equal('phase' in data, false)
  // The point of this test, same as the plain-stop precedent above: no
  // matter what, "NaN" must never reach the file.
  assert.doesNotMatch(fs.readFileSync(openBugPath, 'utf8'), /NaN/)
})

test('stopItem --keep-started still refuses a corrupt bucket, naming the key and the bad value, writing nothing', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom', 'groom-elapsed': 'abc' })
  const before = fs.readFileSync(openBugPath, 'utf8')

  assert.throws(
    () => stopItem(backlog, 'bug-7', STAMP, { keepStarted: true }),
    (e) => e instanceof BacklogError && e.code === 1 && /groom-elapsed/.test(e.message) && /abc/.test(e.message),
  )
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('stopItem --keep-started bills execute time and round-trips an unknown key and the body byte-for-byte', () => {
  const { backlog } = boardFixture()
  const body = '\n## Notes\n\n---\n\nSome content.\n'
  const itemPath = writeItemWithBody(backlog, 'tasks/open', 'task-4', 'Promoted task', body)
  withFrontmatter(itemPath, { started: T0, phase: 'execute', from: 'idea-3' })

  stopItem(backlog, 'task-4', STAMP, { keepStarted: true })

  const { data, body: afterBody } = parseFrontmatter(fs.readFileSync(itemPath, 'utf8'))
  assert.equal(data.from, 'idea-3')
  assert.equal(data['execute-elapsed'], '7860')
  assert.equal(data.started, T0)
  assert.equal(afterBody, body)
})

// The real archive path end to end: this is the sequence backlog-execute's
// SKILL.md now documents (append ## Outcome -> stop --keep-started -> move
// ... done), and it is the regression test for the defect Task 7 closes — an
// executed-to-done task must carry its execute-elapsed, not just an
// abandoned one. `move` is a renameSync that never opens the file (see
// moveItem's own comment), so everything `stop --keep-started` wrote must
// come through into done/ byte-for-byte; comparing the pre-move and
// post-move values (rather than asserting a literal timestamp, which the
// CLI gives no way to pin) is what actually proves that.
test('CLI start --as execute, stop --keep-started, then move done carries started/execute-elapsed/updated through the archive', () => {
  const { dir, backlog, openBugPath } = boardFixture()
  assert.equal(run(dir, 'start', 'bug-7', '--as', 'execute').status, 0)

  const stopOut = run(dir, 'stop', 'bug-7', '--keep-started')
  assert.equal(stopOut.status, 0, stopOut.stderr)
  const afterStop = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8')).data
  assert.match(afterStop.started, STAMP_LINE_VALUE)
  assert.match(afterStop['execute-elapsed'], /^\d+$/)
  assert.match(afterStop.updated, STAMP_LINE_VALUE)
  assert.equal('phase' in afterStop, false)

  const moveOut = run(dir, 'move', 'bug-7', 'done')
  assert.equal(moveOut.status, 0, moveOut.stderr)

  const movedPath = path.join(backlog, 'bugs', 'done', path.basename(openBugPath))
  const afterMove = parseFrontmatter(fs.readFileSync(movedPath, 'utf8')).data
  assert.equal(afterMove.started, afterStop.started)
  assert.equal(afterMove['execute-elapsed'], afterStop['execute-elapsed'])
  assert.equal(afterMove.updated, afterStop.updated)
  assert.equal('phase' in afterMove, false)
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

// --- bug-17: a linked worktree must never be registered as its own project ---
// The registry stores absolute host paths and every consumer keys on them: the
// board lists them, the item-body allowlist is built from them, the orchestrator
// keys a run under one. A per-item orchestrator worktree is none of those things
// — it is deleted the moment its item merges — yet one was registered as a
// standalone project named "bug-13" and outlived the directory it pointed at.
//
// resolveRoot is NOT the bug and is deliberately not changed: an execute session
// running inside a worktree MUST resolve backlog/ to that worktree's own copy,
// which is exactly why its walk accepts a `.git` file. The registry is the one
// consumer of that root for which the worktree is the wrong answer, so the
// mapping lives at that seam alone.
//
// Every fixture below drives real git plumbing rather than hand-rolling a `.git`
// file, because the entire claim under test is what git itself writes: a linked
// worktree's gitdir carries a `commondir` entry and a submodule's does not. A
// future git that changes that layout must fail here loudly instead of silently
// rewriting every submodule's registry entry.

const GIT_IDENT = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test']

function seedCommit(repo) {
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n')
  assert.equal(spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['-C', repo, ...GIT_IDENT, 'commit', '-qm', 'seed'], { encoding: 'utf8' }).status, 0)
}

// A real repo plus a real linked worktree under it, the same shape
// backlog-orchestrate builds per item. `git worktree add` needs HEAD to
// resolve, hence the seed commit.
function worktreeFixture(name = 'bug-13') {
  const { dir } = backlogFixture()
  seedCommit(dir)
  const worktree = path.join(dir, '.worktrees', name)
  const added = spawnSync('git', ['-C', dir, 'worktree', 'add', worktree, '-b', `backlog/${name}`, 'HEAD'], { encoding: 'utf8' })
  assert.equal(added.status, 0, added.stderr)
  return { project: dir, worktree }
}

// A real submodule working tree. `protocol.file.allow=always` is required for a
// local-path submodule on git >= 2.38.
function submoduleFixture() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-submodule-')))
  const inner = path.join(scratch, 'inner')
  const superRepo = path.join(scratch, 'super')
  for (const repo of [inner, superRepo]) {
    fs.mkdirSync(repo)
    assert.equal(spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8' }).status, 0)
    seedCommit(repo)
  }
  const added = spawnSync(
    'git',
    ['-C', superRepo, '-c', 'protocol.file.allow=always', ...GIT_IDENT, 'submodule', 'add', '-q', inner, 'sub'],
    { encoding: 'utf8' },
  )
  assert.equal(added.status, 0, added.stderr)
  const submodule = path.join(superRepo, 'sub')
  assert.equal(fs.statSync(path.join(submodule, '.git')).isFile(), true, 'fixture sanity: a submodule .git is a file')
  return { superRepo, submodule }
}

// Spawns the real CLI with its registry pointed at one throwaway file. The
// module-level BM_REGISTRY_FILE at the top of this suite already keeps every
// spawn off the developer's real registry; this narrows it to one file per test
// so the assertions below can read the WHOLE file rather than search it.
function runWithRegistry(cwd, file, ...args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, BM_REGISTRY_FILE: file },
  })
}

test('linkedWorktreeInfo returns null for an ordinary clone, where .git is a directory', () => {
  const { dir } = backlogFixture()

  assert.equal(fs.statSync(path.join(dir, '.git')).isDirectory(), true, 'fixture sanity')
  assert.equal(linkedWorktreeInfo(dir), null)
})

test('linkedWorktreeInfo identifies a real linked worktree and names its main working tree', () => {
  const { project, worktree } = worktreeFixture()

  const info = linkedWorktreeInfo(worktree)

  assert.ok(info, 'a linked worktree must be recognised')
  assert.equal(info.worktree, worktree)
  assert.equal(info.projectRoot, project)
})

test('linkedWorktreeInfo returns null for a real submodule working tree — commondir, not ".git is a file", is the discriminator', () => {
  const { submodule } = submoduleFixture()

  assert.equal(linkedWorktreeInfo(submodule), null)
})

test('registryRoot passes an ordinary repo root through unchanged', () => {
  const { dir } = backlogFixture()

  assert.equal(registryRoot(dir), dir)
})

test('registryRoot maps a linked worktree onto the main tree, never the worktree', () => {
  const { project, worktree } = worktreeFixture()

  assert.equal(registryRoot(worktree), project)
})

test('registryRoot returns a submodule working tree as itself', () => {
  const { submodule } = submoduleFixture()

  assert.equal(registryRoot(submodule), submodule)
})

test('CLI init run from inside a linked worktree registers the main tree, not the worktree', () => {
  const { project, worktree } = worktreeFixture()
  const file = tmpRegistry()

  const out = runWithRegistry(worktree, file, 'init')

  assert.equal(out.status, 0, out.stderr)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(written.projects.map((p) => p.path), [project], 'the worktree path must never reach the registry')
  assert.equal(written.projects[0].name, path.basename(project), 'the name follows the main tree, not the item branch')
})

test('CLI new run from inside a linked worktree registers the main tree too — the other upsert call site', () => {
  const { project, worktree } = worktreeFixture('bug-14')
  const file = tmpRegistry()

  const out = runWithRegistry(worktree, file, 'new', 'bugs', 'Something broke')

  assert.equal(out.status, 0, out.stderr)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(written.projects.map((p) => p.path), [project])
})

test('CLI init run inside a real submodule registers the submodule itself', () => {
  const { submodule } = submoduleFixture()
  const file = tmpRegistry()

  const out = runWithRegistry(submodule, file, 'init')

  assert.equal(out.status, 0, out.stderr)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(written.projects.map((p) => p.path), [submodule])
})

// --- unregister: the registry's only removal path ---------------------------
// The upsert has no undo and this tool is the registry's only writer, so the
// repair for an entry that should never have been written has to live here too
// — not in the server, which is read-only by invariant, and not in a text
// editor. Every case below runs from a cwd that is NOT a git repo on purpose:
// unregister names its target explicitly and must never consult one.

test('unregisterProject removes exactly the named entry and leaves the others byte-identical', () => {
  const file = tmpRegistry()
  registerProject('/abs/one', file)
  registerProject('/abs/two', file)
  registerProject('/abs/three', file)
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).projects

  assert.equal(unregisterProject('/abs/two', file), true)

  const after = JSON.parse(fs.readFileSync(file, 'utf8')).projects
  assert.deepEqual(after.map((p) => p.path), ['/abs/one', '/abs/three'])
  assert.deepEqual(after, before.filter((p) => p.path !== '/abs/two'), 'createdAt and name must survive untouched')
})

test('unregisterProject reports false and rewrites nothing for a path that is not registered', () => {
  const file = tmpRegistry()
  registerProject('/abs/one', file)
  const before = fs.readFileSync(file)

  assert.equal(unregisterProject('/abs/nope', file), false)

  assert.ok(before.equals(fs.readFileSync(file)))
})

test('CLI unregister removes the entry and exits 0', () => {
  const file = tmpRegistry()
  registerProject('/abs/one', file)
  registerProject('/abs/two', file)

  const out = runWithRegistry(path.dirname(file), file, 'unregister', '/abs/one')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects.map((p) => p.path), ['/abs/two'])
})

test('CLI unregister exits 1 on a path that is not registered and rewrites nothing', () => {
  const file = tmpRegistry()
  registerProject('/abs/one', file)
  const before = fs.readFileSync(file)

  const out = runWithRegistry(path.dirname(file), file, 'unregister', '/abs/nope')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /not registered/)
  assert.ok(before.equals(fs.readFileSync(file)), 'a miss must never rewrite the file')
})

test('CLI unregister with no path prints usage and exits 1 — there is deliberately no cwd default', () => {
  const file = tmpRegistry()
  registerProject('/abs/one', file)
  const before = fs.readFileSync(file)

  const out = runWithRegistry(path.dirname(file), file, 'unregister')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /usage: backlog\.mjs unregister/)
  assert.ok(before.equals(fs.readFileSync(file)))
})

// --- refactors section ----------------------------------------------------
// Refactoring is a peer section, not a facet on ideas. Everything below either
// proves the new section behaves like its peers, or pins the one thing about it
// that is genuinely new (`kind:`). What these tests deliberately do NOT do is
// re-test the generic machinery per section — nextId, PREFIX_TO_SECTION,
// QUEUE_SECTIONS and compareOpenItems all derive from the one SECTIONS map, and
// asserting each of them once for `refactors` is what proves that derivation
// held, not that a fourth copy of each rule was written correctly.

test('CLI new refactors mints ref-1 and puts it under refactors/open', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)

  const out = run(dir, 'new', 'refactors', 'Split the item scanner')

  assert.equal(out.status, 0, out.stderr)
  const printedPath = out.stdout.split('\n')[0]
  assert.equal(printedPath, path.join(backlog, 'refactors', 'open', 'ref-1-split-the-item-scanner.md'))
  assert.match(out.stdout, /^id: ref-1$/m)
})

// The `ref` prefix rather than `refactor` is a UI constraint (the card's meta
// line), so it is worth an assertion of its own: a rename here silently breaks
// every id already written into a from: line or a commit message.
test('the refactors id prefix is ref, not refactor', () => {
  assert.equal(SECTIONS.refactors, 'ref')
})

// nextId's contract is max+1 across THREE directories, not two: a rejected
// refactor keeps its ref-N id inside out-of-scope/ and must not have that id
// handed out again. Asserted here for refactors specifically because the
// section is new — the rule itself is generic and tested for bugs above.
test('nextId for refactors scans open/, done/ and out-of-scope/', () => {
  const { backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'refactors/open', 'ref-2', 'Still open')
  writeItem(backlog, 'refactors/done', 'ref-5', 'Already done')
  writeItem(backlog, 'out-of-scope', 'ref-9', 'Rejected but keeps its id')

  assert.equal(nextId(backlog, 'refactors'), 10)
})

test('readItem resolves a ref id from refactors/open and from refactors/done', () => {
  const { backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'refactors/open', 'ref-1', 'Open refactor')
  writeItem(backlog, 'refactors/done', 'ref-2', 'Done refactor')

  const open = readItem(backlog, 'ref-1')
  const done = readItem(backlog, 'ref-2')

  assert.equal(open.section, 'refactors')
  assert.equal(open.state, 'open')
  assert.equal(done.section, 'refactors')
  assert.equal(done.state, 'done')
})

// The same defect the bare `bug` test above pins, for the new prefix: without
// a shape check, `ref` matches `ref-` against every file in the directory and
// the tool acts on whichever readdirSync listed first.
test('CLI show ref refuses the bare prefix, suggesting ref-1', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'refactors/open', 'ref-4', 'Some refactor')

  const out = run(dir, 'show', 'ref')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /ref is a section prefix, not an id/)
  assert.match(out.stderr, /ref-1/)
  assert.equal(out.stdout, '')
})

test('CLI board prints a refactors header and lists an open refactor', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'refactors/open', 'ref-1', 'Split the item scanner')

  const out = run(dir, 'board')

  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^refactors \(1 open\)$/m)
  assert.match(out.stdout, /ref-1/)
})

test('CLI board --section refactors prints only that section', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'bugs/open', 'bug-1', 'A bug')
  writeItem(backlog, 'refactors/open', 'ref-1', 'A refactor')

  const out = run(dir, 'board', '--section', 'refactors')

  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /ref-1/)
  assert.doesNotMatch(out.stdout, /bug-1/)
})

test('CLI move ref-1 done archives it into refactors/done', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'refactors/open', 'ref-1', 'Split the item scanner')

  const out = run(dir, 'move', 'ref-1', 'done')

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.existsSync(path.join(backlog, 'refactors', 'done', 'ref-1-split-the-item-scanner.md')), true)
  assert.equal(fs.existsSync(path.join(backlog, 'refactors', 'open', 'ref-1-split-the-item-scanner.md')), false)
})

// A refactor is rejectable exactly as an idea is, and rejection keeps the id.
test('CLI move ref-1 out-of-scope keeps the ref id in the flat directory', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  writeItem(backlog, 'refactors/open', 'ref-1', 'Split the item scanner')

  const out = run(dir, 'move', 'ref-1', 'out-of-scope')

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.existsSync(path.join(backlog, 'out-of-scope', 'ref-1-split-the-item-scanner.md')), true)
})

// `start`/`stop` were never section-aware and must stay that way: grooming a
// refactor is real work and the board's amber bar is how anyone sees it.
test('CLI start ref-1 --as groom stamps the refactor and stop bills groom-elapsed', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const refPath = writeItem(backlog, 'refactors/open', 'ref-1', 'Split the item scanner')

  const started = run(dir, 'start', 'ref-1', '--as', 'groom')
  assert.equal(started.status, 0, started.stderr)
  const stamped = fs.readFileSync(refPath, 'utf8')
  assert.match(stamped, STAMP_LINE)
  assert.match(stamped, /^phase: groom$/m)

  const stopped = run(dir, 'stop', 'ref-1')
  assert.equal(stopped.status, 0, stopped.stderr)
  const cleared = fs.readFileSync(refPath, 'utf8')
  assert.doesNotMatch(cleared, /^started:/m)
  assert.doesNotMatch(cleared, /^phase:/m)
  assert.match(cleared, /^groom-elapsed: \d+$/m)
})

// `kind` is not a key this tool knows: it is written by backlog-capture into
// the block `new` printed, and every later start/stop rewrites that block. So
// what actually protects it is the unknown-key round trip — the same guarantee
// `from:` and `promoted-to:` rely on. Both a known and an unrecognised value
// are asserted, because "preserved verbatim" is the whole contract: nothing in
// this tool validates `kind`, and a third value added later must survive a
// groom session untouched without any change here.
test('a kind: line round-trips through parse and render untouched', () => {
  for (const kind of ['chore', 'debt', 'whatever-comes-next']) {
    const doc = `---\nid: ref-1\ntitle: Split it\ncreated: 2026-08-30\nkind: ${kind}\n---\nbody\n`
    const { data } = parseFrontmatter(doc)

    assert.equal(data.kind, kind)
    assert.equal(parseFrontmatter(`${renderFrontmatter(data)}\nbody\n`).data.kind, kind)
  }
})

test('CLI start and stop leave a refactor kind: line exactly where it was', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const refPath = path.join(backlog, 'refactors', 'open', 'ref-1-split-it.md')
  fs.writeFileSync(refPath, `${renderFrontmatter({ id: 'ref-1', title: 'Split it', created: '2026-08-30', kind: 'debt' })}\n## What exists today\n`)

  run(dir, 'start', 'ref-1', '--as', 'groom')
  run(dir, 'stop', 'ref-1')

  assert.match(fs.readFileSync(refPath, 'utf8'), /^kind: debt$/m)
})

// The upgrade path, not the fresh-install one: a store initialised before this
// section existed has seven leaves and quite possibly a hand-edited README.
// Re-running init has to add exactly the two missing directories and touch
// nothing else — the README especially, since `init` returning "already
// initialized" is what every capture relies on being harmless.
test('init on a pre-refactors store adds only the two new directories and spares a hand-edited README', () => {
  const { backlog } = backlogFixture()
  for (const rel of ['bugs/open', 'bugs/done', 'ideas/open', 'ideas/done', 'tasks/open', 'tasks/done', 'out-of-scope']) {
    fs.mkdirSync(path.join(backlog, rel), { recursive: true })
  }
  const readmePath = path.join(backlog, 'README.md')
  const handEdited = '# Hand-edited\n\nDo not overwrite me.\n'
  fs.writeFileSync(readmePath, handEdited)

  const created = init(backlog)

  assert.deepEqual(created, [
    path.join(backlog, 'refactors', 'open'),
    path.join(backlog, 'refactors', 'done'),
  ])
  assert.equal(fs.readFileSync(readmePath, 'utf8'), handEdited)
})

test('the README init writes documents the refactors row and the two kinds', () => {
  const { backlog } = backlogFixture()
  init(backlog)

  const readme = fs.readFileSync(path.join(backlog, 'README.md'), 'utf8')

  assert.match(readme, /^\| refactors\s+\| ref\s+\| open -> done\s+\|$/m)
  assert.match(readme, /kind: chore/)
  assert.match(readme, /kind: debt/)
})

// --- token accounting (Task 11) ---------------------------------------------
// The measured usage shape of one real API turn, reused by every case below so
// each states only what it varies. The fresh total is deliberately NOT the sum
// of all four fields: cache_read_input_tokens is excluded, so
// 2 + 38041 + 370 = 38413.
const BASE_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 38041,
  cache_read_input_tokens: 37538,
  output_tokens: 370,
}
const FRESH = 38413

// The window every sumFreshTokens case below counts against. `TOKEN_TO` is
// second-truncated exactly as a real `started:`/`stamp` pair is, which is what
// the sub-second upper-bound case turns on.
const TOKEN_FROM = Date.parse('2026-08-30T09:00:00Z')
const TOKEN_TO = Date.parse('2026-08-30T09:51:50Z')

// One assistant record as the transcript actually writes them. `usage` is
// spread fresh per call so a case that mutates its own copy cannot leak into
// the next.
function assistantRecord(fields = {}) {
  const { usage = {}, ...rest } = fields
  return {
    type: 'assistant',
    requestId: 'req_1',
    uuid: 'uuid-1',
    timestamp: '2026-08-30T09:30:00.000Z',
    message: { usage: { ...BASE_USAGE, ...usage } },
    ...rest,
  }
}

// The three records one API turn is actually split into: same requestId, same
// usage byte-for-byte, one content block each. Summing them per-record gives
// 115239 — three times the right answer — which is why every case that uses
// this asserts the exact deduped value rather than "greater than zero".
function splitTurn(overrides = {}) {
  return ['thinking', 'text', 'tool_use'].map((_, i) =>
    assistantRecord({ apiBlockIndex: i, uuid: `uuid-${i}`, ...overrides }),
  )
}

test('sumFreshTokens counts one API turn once, however many content blocks it was split across', () => {
  assert.equal(sumFreshTokens(splitTurn(), TOKEN_FROM, TOKEN_TO), FRESH)
})

test('sumFreshTokens excludes cache_read_input_tokens entirely', () => {
  const records = splitTurn({ usage: { cache_read_input_tokens: 999999 } })

  assert.equal(sumFreshTokens(records, TOKEN_FROM, TOKEN_TO), FRESH)
})

test('sumFreshTokens does not add thinking_tokens, which are a subset of output_tokens', () => {
  const record = assistantRecord({ usage: { output_tokens_details: { thinking_tokens: 281 } } })

  assert.equal(sumFreshTokens([record], TOKEN_FROM, TOKEN_TO), FRESH)
})

test('sumFreshTokens does not add usage.iterations, which is a breakdown of the top-level fields', () => {
  const record = assistantRecord({ usage: { iterations: [{ ...BASE_USAGE }] } })

  assert.equal(sumFreshTokens([record], TOKEN_FROM, TOKEN_TO), FRESH)
})

test('sumFreshTokens ignores a record timestamped before the window opened', () => {
  const records = [
    assistantRecord({ requestId: 'req_before', timestamp: '2026-08-30T08:59:00.000Z' }),
    assistantRecord({ requestId: 'req_inside' }),
  ]

  assert.equal(sumFreshTokens(records, TOKEN_FROM, TOKEN_TO), FRESH)
})

// The turn that issued the `stop` call itself lands inside the second the
// stamp names but after its .000 — without the upper bound covering the whole
// second, a stop would never count its own final turn.
test('sumFreshTokens counts a record in the same second as the upper bound, milliseconds and all', () => {
  const record = assistantRecord({ timestamp: '2026-08-30T09:51:50.900Z' })

  assert.equal(sumFreshTokens([record], TOKEN_FROM, TOKEN_TO), FRESH)
})

test('sumFreshTokens counts a record landing exactly on the lower bound', () => {
  const record = assistantRecord({ timestamp: '2026-08-30T09:00:00.000Z' })

  assert.equal(sumFreshTokens([record], TOKEN_FROM, TOKEN_TO), FRESH)
})

test('sumFreshTokens skips every non-assistant record type and an assistant record with no usage', () => {
  const records = [
    { type: 'user', timestamp: '2026-08-30T09:30:00.000Z', message: { usage: { ...BASE_USAGE } } },
    { type: 'attachment', timestamp: '2026-08-30T09:30:00.000Z' },
    { type: 'last-prompt', timestamp: '2026-08-30T09:30:00.000Z' },
    { type: 'assistant', requestId: 'req_x', timestamp: '2026-08-30T09:30:00.000Z', message: {} },
  ]

  assert.equal(sumFreshTokens(records, TOKEN_FROM, TOKEN_TO), 0)
})

test('sumFreshTokens dedupes on uuid when a record carries no requestId', () => {
  const { requestId, ...noRequestId } = assistantRecord()

  assert.equal(sumFreshTokens([noRequestId, { ...noRequestId }], TOKEN_FROM, TOKEN_TO), FRESH)
})

test('sumFreshTokens returns 0 for no records at all', () => {
  assert.equal(sumFreshTokens([], TOKEN_FROM, TOKEN_TO), 0)
})

// A throwaway CLAUDE_CONFIG_DIR-shaped tree: <root>/projects/<dir>/... Returns
// the projects root, which is what transcriptFiles takes.
function transcriptFixture() {
  const config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-transcripts-')))
  const projects = path.join(config, 'projects')
  fs.mkdirSync(projects, { recursive: true })
  return { config, projects }
}

function writeTranscript(projects, dirName, name, records) {
  const dir = path.join(projects, dirName)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

const SID = '61710af2-900c-4026-b79d-c819f3e5c919'

test('transcriptFiles finds the session transcript by scanning project directories, not by slug', () => {
  const { projects } = transcriptFixture()
  for (const other of ['proj-b', 'proj-c', 'proj-d']) {
    writeTranscript(projects, other, 'someone-elses-session.jsonl', [])
  }
  const main = writeTranscript(projects, 'proj-a', `${SID}.jsonl`, [])

  assert.deepEqual(transcriptFiles(projects, SID), [main])
})

test('transcriptFiles returns the subagent transcripts too, main file first', () => {
  const { projects } = transcriptFixture()
  const main = writeTranscript(projects, 'proj-a', `${SID}.jsonl`, [])
  const x = writeTranscript(projects, 'proj-a', path.join(SID, 'subagents', 'agent-x.jsonl'), [])
  const y = writeTranscript(projects, 'proj-a', path.join(SID, 'subagents', 'agent-y.jsonl'), [])

  assert.deepEqual(transcriptFiles(projects, SID), [main, x, y])
})

test('transcriptFiles ignores tool-results/ and non-jsonl files sitting beside the subagent transcripts', () => {
  const { projects } = transcriptFixture()
  const main = writeTranscript(projects, 'proj-a', `${SID}.jsonl`, [])
  const x = writeTranscript(projects, 'proj-a', path.join(SID, 'subagents', 'agent-x.jsonl'), [])
  writeTranscript(projects, 'proj-a', path.join(SID, 'subagents', 'agent-x.meta.json'), [])
  writeTranscript(projects, 'proj-a', path.join(SID, 'tool-results', 'foo.txt'), [])

  assert.deepEqual(transcriptFiles(projects, SID), [main, x])
})

test('transcriptFiles returns every copy when one session id appears under two project directories', () => {
  const { projects } = transcriptFixture()
  const a = writeTranscript(projects, 'proj-a', `${SID}.jsonl`, [])
  const b = writeTranscript(projects, 'proj-b', `${SID}.jsonl`, [])

  assert.deepEqual(transcriptFiles(projects, SID), [a, b])
})

test('transcriptFiles returns [] when no project directory holds that session', () => {
  const { projects } = transcriptFixture()
  writeTranscript(projects, 'proj-a', 'another-session.jsonl', [])

  assert.deepEqual(transcriptFiles(projects, SID), [])
})

test('transcriptFiles returns [] for a projects root that does not exist, rather than throwing', () => {
  assert.deepEqual(transcriptFiles(path.join(os.tmpdir(), 'bm-no-such-root-12345', 'projects'), SID), [])
})

// Collects the stderr notes instead of printing them, so a unit test asserting
// a `null` can also assert that the reason was stated.
function collector() {
  const lines = []
  return { lines, warn: (m) => lines.push(m) }
}

const STARTED_ISO = '2026-08-30T09:00:00Z'
const STOPPED_ISO = '2026-08-30T09:51:50Z'

test('sessionTokensSince returns null and says so when CLAUDE_CODE_SESSION_ID is unset', () => {
  const { lines, warn } = collector()

  assert.equal(sessionTokensSince(STARTED_ISO, STOPPED_ISO, {}, warn), null)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /CLAUDE_CODE_SESSION_ID/)
})

test('sessionTokensSince returns null and names the session when no transcript matches it', () => {
  const { config } = transcriptFixture()
  const { lines, warn } = collector()

  const env = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: config }

  assert.equal(sessionTokensSince(STARTED_ISO, STOPPED_ISO, env, warn), null)
  assert.equal(lines.length, 1)
  assert.match(lines[0], new RegExp(SID))
})

test('sessionTokensSince reads the transcript CLAUDE_CONFIG_DIR names and sums the window', () => {
  const { config, projects } = transcriptFixture()
  writeTranscript(projects, 'proj-a', `${SID}.jsonl`, splitTurn())
  const { lines, warn } = collector()

  const env = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: config }

  assert.equal(sessionTokensSince(STARTED_ISO, STOPPED_ISO, env, warn), FRESH)
  assert.deepEqual(lines, [])
})

// Proves CLAUDE_CONFIG_DIR is actually consulted rather than ignored in favour
// of a hard-coded ~/.claude: the same transcript is on disk, and pointing the
// fallback somewhere empty is enough to make the answer null.
test('sessionTokensSince falls back to HOME/.claude, and finds nothing there', () => {
  const { projects } = transcriptFixture()
  writeTranscript(projects, 'proj-a', `${SID}.jsonl`, splitTurn())
  const emptyHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-empty-home-')))
  const { warn } = collector()

  const env = { CLAUDE_CODE_SESSION_ID: SID, HOME: emptyHome }

  assert.equal(sessionTokensSince(STARTED_ISO, STOPPED_ISO, env, warn), null)
})

test('sessionTokensSince returns null when the transcript path is a directory rather than a file', () => {
  const { config, projects } = transcriptFixture()
  fs.mkdirSync(path.join(projects, 'proj-a', `${SID}.jsonl`), { recursive: true })
  const { warn } = collector()

  const env = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: config }

  assert.equal(sessionTokensSince(STARTED_ISO, STOPPED_ISO, env, warn), null)
})

// A transcript being written by a session that is still running routinely ends
// mid-line, and a log this tool does not own may hold shapes it has never
// seen. Neither may fail a stop, and neither may cost the records around it.
test('sessionTokensSince skips a line that is not valid JSON and still counts the records around it', () => {
  const { config, projects } = transcriptFixture()
  const dir = path.join(projects, 'proj-a')
  fs.mkdirSync(dir, { recursive: true })
  const first = assistantRecord({ requestId: 'req_a', uuid: 'uuid-a' })
  const second = assistantRecord({ requestId: 'req_b', uuid: 'uuid-b' })
  fs.writeFileSync(
    path.join(dir, `${SID}.jsonl`),
    `${JSON.stringify(first)}\n{"type":"assistant","mess\n${JSON.stringify(second)}\n`,
  )
  const { warn } = collector()

  const env = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: config }

  assert.equal(sessionTokensSince(STARTED_ISO, STOPPED_ISO, env, warn), FRESH * 2)
})

test('sessionTokensSince sums a subagent transcript alongside the main one, deduping across both', () => {
  const { config, projects } = transcriptFixture()
  writeTranscript(projects, 'proj-a', `${SID}.jsonl`, splitTurn())
  writeTranscript(projects, 'proj-a', path.join(SID, 'subagents', 'agent-x.jsonl'), [
    ...splitTurn(),
    assistantRecord({ requestId: 'req_sub', uuid: 'uuid-sub' }),
  ])
  const { warn } = collector()

  const env = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: config }

  assert.equal(sessionTokensSince(STARTED_ISO, STOPPED_ISO, env, warn), FRESH * 2)
})

test('stopItem writes a first groom session token count into groom-tokens', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', STAMP, { tokens: 1234 })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-tokens'], '1234')
})

test('stopItem accumulates onto an existing groom-tokens rather than overwriting it', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom', 'groom-tokens': 1000 })

  stopItem(backlog, 'bug-7', STAMP, { tokens: 234 })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-tokens'], '1234')
})

test('stopItem bills execute tokens into their own bucket, leaving groom-tokens untouched', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'execute', 'groom-tokens': 1000 })

  stopItem(backlog, 'bug-7', STAMP, { tokens: 500 })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['execute-tokens'], '500')
  assert.equal(data['groom-tokens'], '1000')
})

// The token count rides the elapsed gate rather than carrying a second one of
// its own, so every case that bills no seconds bills no tokens either — the
// three below are that gate's three arms.
test('stopItem with no phase: key writes no token key, exactly as it bills no seconds', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0 })

  stopItem(backlog, 'bug-7', STAMP, { tokens: 999 })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-tokens' in data, false)
  assert.equal('execute-tokens' in data, false)
  assert.equal('groom-elapsed' in data, false)
})

test('stopItem writes no token key for a legacy bare-date started:, though it still clears it', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: '2026-08-30', phase: 'groom' })

  stopItem(backlog, 'bug-7', STAMP, { tokens: 999 })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-tokens' in data, false)
  assert.equal('groom-elapsed' in data, false)
  assert.equal('started' in data, false)
})

test('stopItem --abandon bills no tokens either, but still clears the marker and stamps updated', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', STAMP, { abandon: true, tokens: 999 })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-tokens' in data, false)
  assert.equal('groom-elapsed' in data, false)
  assert.equal('started' in data, false)
  assert.equal(data.updated, STAMP)
})

test('stopItem --keep-started bills tokens exactly as it bills seconds', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', STAMP, { keepStarted: true, tokens: 777 })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal(data['groom-tokens'], '777')
  assert.equal(data.started, T0)
  assert.equal('phase' in data, false)
})

// "Cannot attribute" is a different fact from "attributed, and it was tiny",
// and only the second one is a number worth writing down.
test('stopItem writes no token key for a null count, and bills the seconds as normal', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom' })

  stopItem(backlog, 'bug-7', '2026-08-30T10:01:30Z', { tokens: null })

  const { data } = parseFrontmatter(fs.readFileSync(openBugPath, 'utf8'))
  assert.equal('groom-tokens' in data, false)
  assert.equal(data['groom-elapsed'], '90')
})

test('stopItem refuses a non-numeric groom-tokens, naming the key and the bad value, and writes nothing', () => {
  const { backlog, openBugPath } = boardFixture()
  withFrontmatter(openBugPath, { started: T0, phase: 'groom', 'groom-tokens': '12x' })
  const before = fs.readFileSync(openBugPath, 'utf8')

  assert.throws(
    () => stopItem(backlog, 'bug-7', STAMP, { tokens: 5 }),
    (e) => e instanceof BacklogError && e.code === 1 && /groom-tokens/.test(e.message) && /12x/.test(e.message),
  )
  assert.equal(fs.readFileSync(openBugPath, 'utf8'), before)
})

test('stopItem writing a token key still round-trips an unknown key and the body byte-for-byte', () => {
  const { backlog } = boardFixture()
  const body = '\n## Plan\n\n---\n\nA literal fence in the body.\n'
  const itemPath = writeItemWithBody(backlog, 'tasks/open', 'task-4', 'Ship it', body)
  withFrontmatter(itemPath, { started: T0, phase: 'groom', from: 'idea-2' })

  stopItem(backlog, 'task-4', STAMP, { tokens: 4200 })

  const { data, body: afterBody } = parseFrontmatter(fs.readFileSync(itemPath, 'utf8'))
  assert.equal(afterBody, body)
  assert.equal(data.from, 'idea-2')
  assert.equal(data['groom-tokens'], '4200')
})

// The one case that proves the whole chain the seam above skips: a real child
// process, a real environment, a real transcript file, a real frontmatter
// write. The records are stamped between the two spawns so they land inside
// whatever window the tool's own clock produces, rather than at a fixed date
// that would age out of it.
test('CLI stop reads the session transcript named by the environment and writes groom-tokens', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const itemPath = writeItem(backlog, 'bugs/open', 'bug-7', 'Board drops an item')
  const { config, projects } = transcriptFixture()

  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: SID }

  const started = runWithEnv(dir, env, 'start', 'bug-7', '--as', 'groom')
  assert.equal(started.status, 0, started.stderr)

  const now = new Date().toISOString()
  writeTranscript(projects, 'proj-a', `${SID}.jsonl`, splitTurn({ timestamp: now }))

  const stopped = runWithEnv(dir, env, 'stop', 'bug-7')
  assert.equal(stopped.status, 0, stopped.stderr)
  assert.equal(stopped.stdout, itemPath + '\n')

  const { data } = parseFrontmatter(fs.readFileSync(itemPath, 'utf8'))
  assert.equal(data['groom-tokens'], String(FRESH))
})

test('CLI stop with no CLAUDE_CODE_SESSION_ID still exits 0, writes no token key, and says why on stderr', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const itemPath = writeItem(backlog, 'bugs/open', 'bug-7', 'Board drops an item')

  const started = run(dir, 'start', 'bug-7', '--as', 'groom')
  assert.equal(started.status, 0, started.stderr)

  const stopped = run(dir, 'stop', 'bug-7')

  assert.equal(stopped.status, 0)
  assert.equal(stopped.stdout, itemPath + '\n')
  assert.deepEqual(stopped.stderr.trim().split('\n'), [
    'backlog: CLAUDE_CODE_SESSION_ID is not set — recording no token count for this session',
  ])

  const { data } = parseFrontmatter(fs.readFileSync(itemPath, 'utf8'))
  assert.equal('groom-tokens' in data, false)
  assert.match(data['groom-elapsed'], /^\d+$/)
})

// --- bug-30: the prose that decides WHEN `start` is called -----------------
// `start`/`stop` are the single writer of `started:`, `groom-elapsed:` and
// `groom-tokens:`, and every case above tests what they write once called.
// What they cannot test from inside the tool is *when* a caller calls them,
// which is the one thing that decides whether those counters are true: `start`
// cannot know how long a session ran before it, and `stop` bills the interval
// it is handed. So the rule lives in `backlog-groom`'s prose, and that prose
// is pinned here — beside the counters it governs — rather than in a suite of
// its own, because backlog-groom publishes no tool to hang one off.
//
// The failure: SKILL.md gated the stamp on "Only once both are confirmed — the
// item and the verdict", which a directed prompt ("groom bug-23, fill in Cause
// and Fix, leave it in bugs/open/") satisfies on turn one — but the prose read
// as a *sequence* ("once you have worked out the verdict"), so a session
// investigated first and stamped minutes later. Two costs: the item is
// unlocked for that whole window (`start`'s "already in progress" refusal is
// the only mutex an item has), and both counters bill only the cheapest minute
// of the session, permanently, since nothing ever resets them. Grooming bug-23
// on 2026-09-06 left `groom-elapsed: 57` on a groom several times that.
const GROOM_SKILL_MD = fileURLToPath(new URL('../../backlog-groom/SKILL.md', import.meta.url))

// The whole point is the ORDER of instructions inside one section, so every
// case below reads that section alone. A needle that drifted out of it into,
// say, the "already in progress" section would still be in the file and would
// still pass a whole-file search, while a session reading top-to-bottom would
// meet it after the stamp it was supposed to precede.
// Returned with every run of whitespace collapsed to one space, because this
// file is hard-wrapped prose: the phrases below are sentence fragments, and a
// re-wrap that pushed one across a line break would fail every case here while
// changing nothing a session reads. The needles are what the section SAYS, not
// how it is laid out.
const markInProgressSection = () => {
  const text = fs.readFileSync(GROOM_SKILL_MD, 'utf8')
  const at = text.indexOf('### Mark it in progress')
  assert.notEqual(at, -1, 'backlog-groom/SKILL.md no longer has a "### Mark it in progress" section')
  const rest = text.slice(at)
  const end = rest.slice(1).search(/\n#{2,4} /)
  const section = end === -1 ? rest : rest.slice(0, end + 1)
  return section.replace(/\s+/g, ' ')
}

test('backlog-groom names the directed-prompt case and stamps before investigating', () => {
  // One assertion per rule, each naming the rule rather than the string, so a
  // failure says which half of the fix was lost instead of "substring not
  // found". The directed groom is the common case and had no sentence of its
  // own anywhere in the document.
  const section = markInProgressSection()
  const RULES = [
    ['already named the item and the verdict', 'a directed prompt IS the confirmation'],
    ['before any investigation', 'in that case `start` runs as the very next command'],
  ]
  for (const [needle, rule] of RULES) {
    assert.ok(section.includes(needle), `backlog-groom/SKILL.md lost the rule: ${rule} (${needle})`)
  }
})

test('backlog-groom argues both directions of the stamp, not just too-early', () => {
  // A paragraph that argues one direction reads as the only direction there is
  // a cost in — which is exactly how the too-late failure survived a rule that
  // technically already forbade it.
  const section = markInProgressSection()
  assert.ok(
    section.includes("let's not"),
    'backlog-groom/SKILL.md dropped the too-early cost (stamping ahead of consent)',
  )
  const RULES = [
    ['unlocked', 'stamping late leaves the item unlocked for a second session to claim'],
    ['groom-tokens', 'stamping late under-bills the counters'],
    ['permanent', 'and does so permanently, because nothing ever resets them'],
  ]
  for (const [needle, rule] of RULES) {
    assert.ok(section.includes(needle), `backlog-groom/SKILL.md lost the rule: ${rule} (${needle})`)
  }
})

test('backlog-groom carries the show-to-start invariant verbatim', () => {
  // The sentence a session applies to a case nobody enumerated. Pinned as a
  // whole sentence rather than by keyword: its value is that it is total, and
  // a paraphrase that admits one exception is how it stops being.
  const section = markInProgressSection()
  assert.ok(
    section.includes('Nothing sits between `show` and `start` but the verdict decision itself.'),
    'backlog-groom/SKILL.md lost the invariant tying `show` directly to `start`',
  )
})

test('backlog-groom still gates the stamp on confirmation, and the gate still precedes the command', () => {
  // The fix is additive. A test that checked only the new text would pass a
  // rewrite that dropped the consent rule — trading this bug for the
  // stamp-before-consent one the current order exists to prevent.
  const section = markInProgressSection()
  const gate = section.indexOf('Only once both are confirmed')
  const command = section.indexOf('start <id> --as groom')
  assert.notEqual(gate, -1, 'backlog-groom/SKILL.md lost the "Only once both are confirmed" gate')
  assert.notEqual(command, -1, 'backlog-groom/SKILL.md lost the `start <id> --as groom` command')
  assert.ok(gate < command, 'the confirmation gate no longer precedes the `start` command')
})

// --- task-28: the executor's pre-review checks, and the reviewer that reads them
//
// The 2026-09-06 cross-run sweep classified every fix-verdict review this
// machine had produced (29 reviews, four projects): 14 were "another statement
// of the old contract left standing" and 5 were "a new test that still passes
// with the change reverted" — 19 of 29, against 8 genuine defects. Both are
// mechanical checks over the executing session's own diff, so backlog-execute
// now runs them before it writes `## Outcome`, records the result in two fixed
// lines, and backlog-reviewer treats a missing pair as an Important finding.
//
// Pinned here for the same reason the backlog-groom cases above are: this is
// prose that a headless session obeys, in files no compiler and no other test
// reads, and the whole mechanism is one skill and one agent agreeing on two
// literal line shapes. If either side re-words its half, the agreement is gone
// and nothing else in this repo would notice.
//
// In THIS file rather than beside the skill it covers, like those cases and for
// the same reason: `test:skills`'s glob is `skills/*/tools/*.test.mjs`, and
// `backlog-execute` has no `tools/` directory to put a suite in — it publishes
// prose only. `agents/backlog-reviewer.md` is further still from any tool, and
// is read here because the contract is between the two files, so one suite
// asserting both halves is the only shape that can catch them drifting apart.
// A file read, never an import: the "one skill's tools/ may never import
// another's" rule is untouched.
const EXECUTE_SKILL_MD = fileURLToPath(new URL('../../backlog-execute/SKILL.md', import.meta.url))
const REVIEWER_MD = fileURLToPath(new URL('../../../agents/backlog-reviewer.md', import.meta.url))

// Whitespace-collapsed for markInProgressSection's reason: both files are
// hard-wrapped prose, and a re-wrap that pushed a phrase across a line break
// changes nothing a session reads.
const flat = (file) => fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ')

test('backlog-execute runs the two checks after verification and before it writes ## Outcome', () => {
  // The ORDER is the rule, not the presence: a sweep run before the work is
  // finished sweeps a diff that is not the diff, and a red proof written into
  // `## Outcome` after `move` has already archived the item proves nothing to
  // anyone. Positions are asserted against the document, so a section that
  // drifts below the archive steps fails here rather than being "still in the
  // file".
  const text = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8')
  const step = text.indexOf('## Before you call it done')
  const verification = text.indexOf('superpowers:verification-before-completion')
  const outcome = text.indexOf('## Archive when verification proves it')
  assert.notEqual(step, -1, 'backlog-execute/SKILL.md lost the "Before you call it done" step')
  assert.notEqual(verification, -1, 'backlog-execute/SKILL.md no longer invokes verification-before-completion')
  assert.notEqual(outcome, -1, 'backlog-execute/SKILL.md lost the archive section')
  assert.ok(step < verification, 'the two checks no longer sit with the verification step')
  assert.ok(verification < outcome, 'verification no longer precedes the `## Outcome` write')
})

test('backlog-execute states both checks, and why each one cannot be done by reading the diff', () => {
  // One assertion per rule, naming the rule rather than the string, so a
  // failure says which half was lost. The two "why" needles are the load-
  // bearing halves: a sweep scoped to the diff finds nothing (the stale
  // sentence is always in a file the diff did not touch), and a red proof
  // that never reverts anything is a test run, not a proof.
  const text = flat(EXECUTE_SKILL_MD)
  const RULES = [
    ['Contract sweep', 'the sweep itself'],
    ['Red proof', 'the red proof itself'],
    ['not over the diff', 'the sweep is over the repository text, not the diff'],
    ['confirm it fails', 'the red proof actually reverts and re-runs'],
    ['does not pin the change', 'a test that stays green is the finding, not a pass'],
    ['Never `git stash`', 'the stash stack is shared across worktrees and must not be used here'],
  ]
  for (const [needle, rule] of RULES) {
    assert.ok(text.includes(needle), `backlog-execute/SKILL.md lost the rule: ${rule} (${needle})`)
  }
})

// The two line shapes are the entire contract between the skill that writes
// them and the agent that reads them. Pinned verbatim, from one table both
// suites below iterate, so neither side can be re-worded alone: that is the
// failure mode this whole mechanism exists to catch, applied to itself.
const OUTCOME_LINES = ['Contract sweep:', 'Red proof:']

test('backlog-execute writes the two fixed ## Outcome lines', () => {
  const text = flat(EXECUTE_SKILL_MD)
  for (const line of OUTCOME_LINES) {
    assert.ok(text.includes(line), `backlog-execute/SKILL.md lost the \`${line}\` Outcome line`)
  }
  // Both branches of each line, so a rewrite cannot drop the "nothing to
  // report" wording and leave a session with no honest way to say so — which
  // is how a fixed shape turns into a line nobody writes.
  const BRANCHES = ['Contract sweep: none found', 'Red proof: skipped']
  for (const branch of BRANCHES) {
    assert.ok(text.includes(branch), `backlog-execute/SKILL.md lost the empty-case branch: ${branch}`)
  }
})

test('backlog-reviewer reads both lines and calls a missing pair Important', () => {
  // Without this half the step is unenforced: a headless run has nobody to
  // notice it was skipped, and the reviewer is the only reader the executor's
  // `## Outcome` gets before the merge.
  const text = flat(REVIEWER_MD)
  for (const line of OUTCOME_LINES) {
    assert.ok(text.includes(line), `backlog-reviewer.md no longer names the \`${line}\` line`)
  }
  assert.ok(
    /missing or half-present pair is an Important finding\*\*/.test(text),
    'backlog-reviewer.md no longer treats a missing pair as an Important finding',
  )
})

// --- bug-47: losing the claim race ends this session's work on the item ------
//
// The clause was never missing. `## Mark it in progress` carried it as a
// parenthetical inside a run-on sentence listing three unrelated exit-`1`
// causes, so it read with no more weight than "already done" — and a hand-run
// session read straight past it: it computed when the holder's claim would go
// stale, queued a re-claim for that moment, and filled the wait with two full
// test-suite runs and three drafted files, all discarded.
//
// So these pin SHAPE, not presence. The whole defect was a rule that was
// present and unreadable, and a suite asserting only `includes` would have
// passed over the bug it exists to catch: the first test below asserts the rule
// has left the list it was buried in, and the list still names the two causes
// that genuinely are one-liners.
const LOST_RACE_HEADING = "### Losing the claim race ends this session's work on this item"

// Heading to the next level-2 heading: the subsection sits under `## Mark it in
// progress`, so `## Dispatch` terminates it. Whitespace-collapsed for `flat`'s
// reason — the file is hard-wrapped prose and a re-wrap changes nothing a
// session reads.
const executeSection = (heading) => {
  const raw = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8')
  const at = raw.indexOf(heading)
  assert.notEqual(at, -1, `backlog-execute/SKILL.md no longer has a "${heading}" section`)
  const end = raw.indexOf('\n## ', at)
  return raw.slice(at, end === -1 ? raw.length : end).replace(/\s+/g, ' ')
}

test('backlog-execute gives the lost claim race its own subsection, out of the exit-1 list', () => {
  const raw = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8')
  const exit1 = raw.indexOf('Exit `1` here means')
  const heading = raw.indexOf(LOST_RACE_HEADING)
  assert.notEqual(exit1, -1, 'backlog-execute/SKILL.md lost the exit `1` reading of `start`')
  assert.notEqual(heading, -1, `backlog-execute/SKILL.md lost "${LOST_RACE_HEADING}"`)
  assert.ok(exit1 < heading, 'the lost-race subsection no longer follows the exit `1` sentence it was lifted out of')

  // The exit-`1` sentence keeps the two causes that are genuinely one-liners
  // and hands the third to the subsection. If the parenthetical comes back,
  // the rule is back to carrying the weight of "already done".
  const sentence = raw.slice(exit1, heading).replace(/\s+/g, ' ')
  assert.ok(!/working it twice/.test(sentence), 'the lost-race rule is a parenthetical inside the exit `1` list again')
  for (const cause of ['already done', 'out of scope']) {
    assert.ok(sentence.includes(cause), `the exit \`1\` sentence no longer names its "${cause}" cause`)
  }
})

test('backlog-execute forbids waiting out a foreign claim, in as many words', () => {
  // One assertion per rule, naming the rule rather than the string, so a
  // failure says which half was lost. Every needle here is a thing the session
  // in the bug actually did, or the belief that let it: a rule that does not
  // name the behaviour by name is the rule that was already there.
  const section = executeSection(LOST_RACE_HEADING)
  const RULES = [
    ["ends this session's work on this item", 'the rule itself — a lost race is terminal for this session'],
    ['Report the holder and stop', 'what to do instead'],
    ['schedule a retry', 'the retry the losing session queued for the staleness deadline'],
    ['wait out the staleness window', 'the wait itself, named'],
    ['read-only work', 'the work the wait was filled with'],
    ["a person's decision, not the session's", 'who owns the next attempt'],
    ['is not evidence the holder is dead', 'the enabling belief, from bug-46'],
    ['heartbeat age', 'the only liveness evidence that exists for a foreign claim'],
    ['Work it through to verification', 'the completion-shaped prompt this holds under'],
  ]
  for (const [needle, rule] of RULES) {
    assert.ok(section.includes(needle), `backlog-execute/SKILL.md lost the rule: ${rule} (${needle})`)
  }
})

test('backlog-execute reads the tracker refusal the same two ways backlog-groom does', () => {
  // One refusal, one reading. Groom's half is pinned by its own suite above;
  // this asserts execute states the same two cases with the same verdicts, so
  // a session that loaded either skill acts the same way on the same line.
  const section = executeSection(LOST_RACE_HEADING)
  const RULES = [
    ['heartbeat 12s ago', 'the refusal quoted, so a reader matches it to the line they just saw'],
    ['fifteen minutes', 'the staleness window the two cases split on'],
    ['`stop --abandon`', 'the stale case names the takeover it must NOT do first'],
    ['re-run `start`', 'the stale case names what it does instead'],
  ]
  for (const [needle, rule] of RULES) {
    assert.ok(section.includes(needle), `backlog-execute/SKILL.md lost the rule: ${rule} (${needle})`)
  }
})

// --- task-44: the orchestrator hands the reviewer its base -------------------
//
// Another two-files-one-contract seam, the same shape as the pair above and
// living here for the same reason: `backlog-orchestrate/SKILL.md` §7 composes
// the dispatch and `agents/backlog-reviewer.md` declares what it expects, and
// a suite reading only one half cannot catch them drifting apart.
//
// What makes this one worth pinning rather than trusting: if the orchestrator
// stops handing `base`, or the reviewer goes back to a literal `main`, nothing
// fails and nothing errors. The reviewer simply diffs against the wrong ref on
// a `--base` run and reviews that branch's entire divergence from `main` as
// though it were one item's work — a much larger diff that still reads like a
// legitimate one, approved or rejected on content this item's author never
// wrote. Silent, and only on the runs the feature exists for.

test('backlog-orchestrate hands the reviewer a base and the reviewer diffs against it', () => {
  const skill = flat(ORCHESTRATE_SKILL_MD)
  const reviewer = flat(REVIEWER_MD)

  assert.ok(/- `base` — this run's base branch/.test(skill), 'backlog-orchestrate/SKILL.md §7 no longer hands the reviewer a base')
  assert.ok(/\*\*`base`\*\* —/.test(reviewer), 'backlog-reviewer.md no longer declares a base among the fields the dispatch gives it')

  // The diff commands are the whole point of the field, so they are asserted
  // directly rather than inferred from the field being mentioned.
  assert.ok(reviewer.includes('git -C <worktree> diff <base>...<branch>'), 'backlog-reviewer.md no longer takes its diff against the base')
  assert.ok(
    !/git -C <worktree> diff main\.\.\.<branch>/.test(reviewer),
    'backlog-reviewer.md still has a diff hardcoded against main — on a --base run that reviews the wrong change set',
  )
  assert.ok(
    !/git -C <worktree> log --oneline main\.\./.test(reviewer),
    'backlog-reviewer.md still has a log hardcoded against main',
  )

  // Both halves must agree on the count, or the reviewer's own "if any is
  // missing, stop" rule silently stops checking for one of them.
  assert.ok(/Five fields, always/.test(reviewer), 'backlog-reviewer.md no longer says how many fields the dispatch gives it')
  assert.ok(/If any of the five is missing/.test(reviewer), "backlog-reviewer.md's missing-field rule no longer matches its own field count")
})

// --- backlog-groom's closing "on disk only" line -----------------------------
//
// The seam: `backlog-orchestrate`'s gate reads each candidate at the ref its
// worktree is created from, so an item groomed in the working tree and never
// committed reaches the gate as ungroomed and is skipped with "not committed on
// main". That verdict fired five times across three projects in the 2026-09-06
// sweep (bug-12 twice here, bug-13 in claude-agents-dashboard, bug-16 in ixray,
// bug-7 in the dashboard), each one a spent run slot and a second trip for a
// person. `backlog-groom` is the skill that creates the uncommitted state, the
// commit is the user's own act — no skill but orchestrate touches git history —
// and `backlog.mjs` has no notion of whether a file is committed, so the whole
// fix is one sentence said where the state is made.
//
// Pinned here for the reason the two prose blocks above are: no compiler and no
// other test reads these files, and this rule is two skills agreeing on one
// literal sentence. Read, never imported.
const ORCHESTRATE_SKILL_MD = fileURLToPath(new URL('../../backlog-orchestrate/SKILL.md', import.meta.url))

// The line is printed, so it is quoted in SKILL.md as a blockquote and hard
// wrapped across three source lines. Strip the `>` markers before collapsing
// whitespace: the needle is what a session prints, and neither the marker nor
// the wrap column is part of that.
const flatQuoted = (file) =>
  fs.readFileSync(file, 'utf8').replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ')

const ON_DISK_LINE =
  'Groomed on disk only. A run reads `<path>` at the commit it starts from, ' +
  'so commit it before `/backlog-orchestrate` — uncommitted, the gate skips it as ungroomed.'

// Same shape as markInProgressSection, generalised: these cases care which
// section a phrase is in, because "the rejection path does not carry it" is a
// statement about one section and would pass trivially against the whole file.
const groomSectionText = (heading) => {
  const text = fs.readFileSync(GROOM_SKILL_MD, 'utf8')
  const at = text.indexOf(heading)
  assert.notEqual(at, -1, `backlog-groom/SKILL.md no longer has a "${heading}" section`)
  const rest = text.slice(at)
  const end = rest.slice(1).search(/\n#{2,4} /)
  return (end === -1 ? rest : rest.slice(0, end + 1)).replace(/\s+/g, ' ')
}

test('backlog-groom carries the on-disk-only line verbatim, path placeholder and all', () => {
  // The placeholder is half the point: the line names the path groom just
  // wrote, so a `git add` can be pasted off it. A line that dropped `<path>`
  // would still read as advice and would no longer be actionable.
  const text = flatQuoted(GROOM_SKILL_MD)
  assert.ok(
    text.includes(ON_DISK_LINE),
    'backlog-groom/SKILL.md lost the verbatim "Groomed on disk only" line',
  )
})

test('both executable verdicts end by pointing at that line', () => {
  // Promote and plan-the-fix are the two verdicts that leave something a run
  // would pick up. The line lives in one place; each verdict's last step has to
  // send a session there, or a session reading only its own verdict never
  // reaches it.
  for (const heading of ['### Promote — an idea or a refactor becomes a task', '### Plan the fix — bug stays a bug']) {
    assert.ok(
      groomSectionText(heading).includes('Groomed on disk only'),
      `backlog-groom/SKILL.md's "${heading}" no longer ends by printing the on-disk-only line`,
    )
  }
})

test('the rejection and no-verdict paths do not carry it', () => {
  // A rejected item is closed and an idea left as an idea is not a candidate:
  // no run would pick either up, so committing changes nothing about them and
  // the line would be noise attached to the wrong state.
  for (const heading of ['### Reject — out of scope, open items only', '## If the session ends without a verdict']) {
    assert.ok(
      !groomSectionText(heading).includes('Groomed on disk only'),
      `backlog-groom/SKILL.md's "${heading}" should not print the on-disk-only line`,
    )
  }
})

test('backlog-groom states which grooms do not print the line', () => {
  // Stated as a rule rather than left to the two absences above, because a
  // session decides per groom and cannot see what other sections omit.
  const text = flatQuoted(GROOM_SKILL_MD)
  assert.ok(
    /Not printed for a rejection/.test(text),
    'backlog-groom/SKILL.md no longer says which grooms leave the line out',
  )
})

test('backlog-groom says the boundary in its own description of what it does not do', () => {
  // Front matter and the opening paragraph are what a reader meets before
  // running the skill; the boundary belongs there too, not only in the step
  // that prints it.
  const text = flatQuoted(GROOM_SKILL_MD)
  const head = text.slice(0, text.indexOf('## Pick an item'))
  assert.ok(
    /on disk only/.test(head),
    'backlog-groom/SKILL.md no longer names the on-disk-only boundary up front',
  )
})

test('backlog-orchestrate points its "not committed" verdict back at groom line', () => {
  // The two skills describe one seam, and the whole value of the line is that
  // the person reading either file meets the same words.
  // task-44 made the ref the gate reads run-scoped, so the verdict names
  // `<base>` rather than the literal `main`. BOTH skills are read here, not
  // just orchestrate's: this case exists because the two files state one
  // sentence, and a version that checked only one half would have let
  // task-44 update orchestrate and leave groom quoting a verdict the tool no
  // longer prints — which is exactly what it caught.
  const text = flatQuoted(ORCHESTRATE_SKILL_MD)
  const groom = flatQuoted(GROOM_SKILL_MD)
  assert.ok(
    text.includes('not committed on <base>'),
    'backlog-orchestrate/SKILL.md no longer explains the "not committed on <base>" verdict',
  )
  assert.ok(
    groom.includes('not committed on <base>'),
    'backlog-groom/SKILL.md quotes a different "not committed" verdict from backlog-orchestrate/SKILL.md — one sentence, two skills, one wording',
  )
  assert.ok(
    /Groomed on disk only/.test(text),
    'backlog-orchestrate/SKILL.md no longer points at backlog-groom\'s "Groomed on disk only" line',
  )
})

// --- task-34: the entry guard exits through process.exitCode ----------------
// `process.stdout.write` to a PIPE is asynchronous, so `process.exit()` in an
// entry guard tears the process down without draining it and everything past
// the 64KB pipe buffer is silently dropped. retro.mjs shipped that bug for an
// afternoon (a 442,757-byte sweep arrived through `| jq` as exactly 65,536 and
// a parse error, while `> file.json` — a synchronous write on POSIX — was
// always fine); retro.mjs:396-407 is the long-form record. These three cases
// are the other two tools' half of it.

test('a board larger than the pipe buffer arrives whole', () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  // The fixture has to actually exceed 65,536 bytes or this case is vacuous —
  // it would pass just as well against the bug. 250 items with ~120-character
  // titles clears it with room to spare (this repo's own board measured 2,745
  // bytes for 8 items on 2026-09-13, and a tmpdir's paths are shorter than
  // this repo's, so the count is deliberately generous rather than fitted),
  // and the byte assertion below is what actually enforces the sizing.
  const count = 250
  const title = (i) => `Item ${i} with a deliberately long ASCII title so the rendered board comfortably outgrows the pipe buffer`
  for (let i = 1; i <= count; i += 1) writeItem(backlog, 'tasks/open', `task-${i}`, title(i))

  // `run` is spawnSync, i.e. a REAL pipe — the entire point. A test that
  // redirected stdout to a file could not fail on this bug at all, because a
  // file write is synchronous on POSIX and `process.exit()` never truncates it.
  const out = run(dir, 'board', '--json')

  assert.equal(out.status, 0, out.stderr)
  // `run` decodes with encoding: 'utf8', so measure bytes explicitly rather
  // than trusting `.length` (characters) to be the same number.
  const bytes = Buffer.byteLength(out.stdout, 'utf8')
  assert.ok(bytes > 65536, `only ${bytes} bytes reached the pipe`)
  const board = JSON.parse(out.stdout)
  assert.equal(board.length, count)
})

// Read as text, never imported: these are three separate skills' tools, and
// the rule is one agreement spanning all three — the same shape as the
// GROOM_SKILL_MD / EXECUTE_SKILL_MD cross-skill cases above, and the same
// reason (a suite that reads only its own half cannot catch the halves
// drifting apart). This guard is why the two behaviour cases are not enough on
// their own: they drive two surfaces, and a new CLI or a second entry point
// would reintroduce the bug green.
const CLI_SOURCES = {
  'backlog.mjs': fileURLToPath(new URL('./backlog.mjs', import.meta.url)),
  'orchestrate.mjs': fileURLToPath(new URL('../../backlog-orchestrate/tools/orchestrate.mjs', import.meta.url)),
  'retro.mjs': fileURLToPath(new URL('../../backlog-retro/tools/retro.mjs', import.meta.url)),
  // task-47's fourth entry point, and the reason this list is not named after
  // the three skills: `api-call.mjs` is a CHILD of orchestrate.mjs, spawned
  // per request so the asynchrony of `fetch` never reaches the parent's own
  // synchronous `main`. It is still a process whose stdout is a pipe the
  // parent reads, so the truncation this guard exists for applies to it
  // exactly as it does to the three above.
  'api-call.mjs': fileURLToPath(new URL('../../backlog-orchestrate/tools/api-call.mjs', import.meta.url)),
}

// Comment lines are stripped before matching because retro.mjs's own note
// quotes the literal `process.exit()` twice while being the CORRECT file — a
// naive whole-file substring search goes red on the reference copy.
const codeLines = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('//'))

// `= await main(` is accepted for backlog.mjs ALONE (task-46). The invariant is about `process.exit()` truncating a pipe, which asynchrony has nothing to do
// with; what it actually requires is that nothing be left holding the event loop open when main returns. API mode keeps that — every `fetch` is awaited to
// completion and each one sends `connection: close`, so no pooled socket outlives the call — and the API-mode cases assert it behaviourally, by expecting each
// child process to EXIT rather than hang. The other two CLIs hold no asynchronous work at all and stay on the synchronous form, so a stray `await` appearing
// in either of them still goes red here.
//
// `api-call.mjs` takes the awaited shape too (task-47), and its safety argument is its own rather than a copy of backlog.mjs's: it makes exactly ONE `fetch`,
// awaits it to completion, sends `connection: close`, and holds no timer, server or child of its own. A-1 asserts it behaviourally from the other side — the
// child is expected to EXIT with a code, not to hang.
const ENTRY_SHAPES = {
  'backlog.mjs': ['process.exitCode = main(', 'process.exitCode = await main('],
  'orchestrate.mjs': ['process.exitCode = main('],
  'retro.mjs': ['process.exitCode = main('],
  'api-call.mjs': ['process.exitCode = await main('],
}

test('every skill CLI ends through process.exitCode, never process.exit', () => {
  for (const [name, file] of Object.entries(CLI_SOURCES)) {
    const lines = codeLines(file)
    const accepted = ENTRY_SHAPES[name]
    assert.ok(
      lines.some((line) => accepted.some((shape) => line.includes(shape))),
      `${name} no longer sets process.exitCode from main() in its entry guard (accepted: ${accepted.join(' or ')})`,
    )
    const offenders = lines.filter((line) => line.includes('process.exit('))
    assert.deepEqual(
      offenders,
      [],
      `${name} calls process.exit(), which truncates a --json payload larger than the pipe buffer`,
    )
  }
})

// --- task-45 step 8: connect github ------------------------------------------
// `connect` writes the project's own committed source marker — `backlog/source.json` — which is what the server's `resolveSource` reads per request to decide
// whether a project's items come from files or from a tracker's API. Two things make these cases worth their length. First, every refusal has to leave the
// project byte-identical: a marker is committed and pulled by every machine, so a half-connected project is a project whose items are invisible on somebody
// else's board with nothing to say why. Second, the marker is interpolated into an api.github.com URL path by the server, which is why the repo value is
// PROVED here on the way in rather than clamped or trusted.
//
// The CLI cases spawn the real tool exactly as every other CLI case here does; the parsing cases call the exported function directly, because origin URL
// shapes are a table and a table is cheaper to read than a dozen `git remote add`s.

// A repo with an optional origin remote. `backlogFixture` already gives a real `git init`, so the remote is a real remote and `git remote get-url` is really
// what answers — the point of the derive-from-origin cases is precisely that this tool asks git rather than parsing `.git/config` itself.
function connectFixture(originUrl) {
  const { dir, backlog } = backlogFixture()
  if (originUrl !== undefined) {
    const added = spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl], { encoding: 'utf8' })
    assert.equal(added.status, 0, added.stderr)
  }
  return { dir, backlog }
}

// The paths printed under the "commit these files" header, which is the command's actual last step: the marker does nothing until the board's machine has
// pulled it. Sliced off the header rather than matched line by line so a test that expects a file to be listed fails on the LIST, not on some other line of
// output that happens to mention the same path.
function commitList(stdout) {
  const lines = stdout.split('\n')
  const header = lines.findIndex((line) => line.startsWith('commit these files'))
  assert.notEqual(header, -1, `no "commit these files" header in:\n${stdout}`)
  return lines.slice(header + 1).filter((line) => line !== '')
}

const FORM_FILES = ['bug.yml', 'idea.yml', 'task.yml', 'refactor.yml']
const formPath = (dir, file) => path.join(dir, '.github', 'ISSUE_TEMPLATE', file)

test('parseOriginRepo reads both shapes git writes for a GitHub remote', () => {
  assert.equal(parseOriginRepo('git@github.com:futin/backlog-manager.git'), 'futin/backlog-manager')
  assert.equal(parseOriginRepo('ssh://git@github.com/futin/backlog-manager.git'), 'futin/backlog-manager')
  assert.equal(parseOriginRepo('https://github.com/futin/backlog-manager.git'), 'futin/backlog-manager')
  assert.equal(parseOriginRepo('https://github.com/futin/backlog-manager'), 'futin/backlog-manager')
  assert.equal(parseOriginRepo('https://github.com/futin/backlog-manager/'), 'futin/backlog-manager')
  // A token in the URL is a credential someone pasted into their remote; the repository it names is still the right answer, and the token is not carried into
  // anything this command writes.
  assert.equal(parseOriginRepo('https://x-access-token:secret@github.com/futin/backlog-manager.git'), 'futin/backlog-manager')
  assert.equal(parseOriginRepo('  git@github.com:futin/x.git  '), 'futin/x')
})

test('parseOriginRepo answers null for anything it cannot honestly name', () => {
  // Not github.com: deriving `owner/repo` off another host would write a marker naming a repository that does not exist on GitHub.
  assert.equal(parseOriginRepo('git@gitlab.com:futin/backlog-manager.git'), null)
  assert.equal(parseOriginRepo('https://bitbucket.org/futin/x.git'), null)
  // More than two path segments — truncating to the first two would invent a repository name out of a URL that never named one.
  assert.equal(parseOriginRepo('https://github.com/futin/x/tree/main'), null)
  assert.equal(parseOriginRepo('/srv/mirrors/backlog-manager.git'), null)
  assert.equal(parseOriginRepo(''), null)
  assert.equal(parseOriginRepo(undefined), null)
})

test('isValidRepo takes exactly one slash and the characters GitHub allows', () => {
  assert.equal(isValidRepo('futin/backlog-manager'), true)
  assert.equal(isValidRepo('futin.dev/my_repo.v2'), true)
  assert.equal(isValidRepo('futin'), false)
  assert.equal(isValidRepo('futin/x/y'), false)
  assert.equal(isValidRepo('futin/ x'), false)
  assert.equal(isValidRepo('futin/../etc'), false)
  assert.equal(isValidRepo(undefined), false)
})

test('backlogItemFiles counts items in the nine leaf directories and ignores the store furniture', () => {
  const { backlog } = backlogFixture()
  init(backlog)
  fs.writeFileSync(path.join(backlog, 'source.json'), '{}\n')

  // A freshly `init`ed store has a README and (here) a marker, and neither is an item — connecting a project that has been initialised and never captured into
  // is exactly the case this command is for.
  assert.deepEqual(backlogItemFiles(backlog), [])

  writeItem(backlog, 'bugs/open', 'bug-1', 'Something broke')
  writeItem(backlog, 'out-of-scope', 'oos-2', 'Declined')

  assert.deepEqual(backlogItemFiles(backlog), ['bugs/open/bug-1-something-broke.md', 'out-of-scope/oos-2-declined.md'])
})

test('backlogItemFiles answers empty for a project with no backlog/ at all', () => {
  const { backlog } = backlogFixture()

  assert.deepEqual(backlogItemFiles(backlog), [])
})

test('CLI connect refuses inside a linked worktree, naming the worktree and the project root', () => {
  const { project, worktree } = worktreeFixture('task-45-connect')

  const out = run(worktree, 'connect', 'github', 'futin/x')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /linked git worktree/)
  assert.ok(out.stderr.includes(worktree), `the refusal must name the worktree:\n${out.stderr}`)
  assert.ok(out.stderr.includes(project), `the refusal must name the project root to re-run from:\n${out.stderr}`)
  // Nothing written, in either tree: a worktree is deleted the moment its item merges, so a marker written there would connect a directory that stops existing
  // while the project everyone else pulls stays on files.
  assert.equal(fs.existsSync(path.join(worktree, 'backlog', 'source.json')), false)
  assert.equal(fs.existsSync(path.join(project, 'backlog', 'source.json')), false)
  assert.equal(fs.existsSync(path.join(worktree, '.github')), false)
})

test('CLI connect exits 2 outside a git repository and creates nothing', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-no-git-')))

  const out = run(dir, 'connect', 'github', 'futin/x')

  // Code 2 is resolveRootOrFail's, reused rather than re-worded: "you are not in a repo" reads the same from every command in this tool.
  assert.equal(out.status, 2)
  assert.match(out.stderr, /\.git/)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('CLI connect refuses with no argument and no origin to derive one from', () => {
  const { dir, backlog } = connectFixture()

  const out = run(dir, 'connect', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /origin/)
  assert.match(out.stderr, /connect github <owner>\/<repo>/)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
})

test('CLI connect refuses a non-GitHub origin the same way, naming the URL it found', () => {
  const { dir, backlog } = connectFixture('git@gitlab.com:futin/x.git')

  const out = run(dir, 'connect', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /github\.com remote/)
  assert.ok(out.stderr.includes('git@gitlab.com:futin/x.git'), `the refusal must name the origin it rejected:\n${out.stderr}`)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
})

test('CLI connect refuses a project that still has item files, naming import', () => {
  const { dir, backlog } = connectFixture('git@github.com:futin/x.git')
  init(backlog)
  writeItem(backlog, 'tasks/open', 'task-3', 'Still a file item')

  const out = run(dir, 'connect', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /import/)
  assert.ok(out.stderr.includes('task-3-still-a-file-item.md'), `the refusal must name at least one of the files blocking it:\n${out.stderr}`)
  // The whole reason this is a refusal rather than a connect-and-leave-them: a connected project contributes no file items, so these files would not be
  // deleted, they would simply stop being visible anywhere.
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
  assert.equal(fs.existsSync(path.join(dir, '.github')), false)
})

test('CLI connect writes the marker and the four forms, prints them to commit, and never touches the registry', () => {
  const { dir, backlog } = connectFixture('git@github.com:futin/backlog-manager.git')
  // An `init`ed but empty store: the README is store furniture, not an item, and must not read as one.
  init(backlog)
  const registry = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-connect-registry-'))), 'registry.json')

  const out = runWithRegistry(dir, registry, 'connect', 'github')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8')), { kind: 'github', repo: 'futin/backlog-manager' })
  // Pretty-printed with a trailing newline, like every other JSON this tool writes: the file is committed and read in diffs.
  assert.match(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8'), /^\{\n {2}"kind": "github",\n {2}"repo": "futin\/backlog-manager"\n\}\n$/)
  for (const file of FORM_FILES) {
    assert.ok(fs.existsSync(formPath(dir, file)), `${file} was not written`)
  }
  assert.deepEqual(commitList(out.stdout), [
    'backlog/source.json',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/idea.yml',
    '.github/ISSUE_TEMPLATE/task.yml',
    '.github/ISSUE_TEMPLATE/refactor.yml',
  ])
  // `connect` writes the project's own marker and nothing per machine. The registry's single-writer relationship with this tool stands, but registration
  // answers a different question ("does this machine's board know this project at all") and connecting must not silently re-answer it — so the file this run's
  // registry points at is never even created.
  assert.equal(fs.existsSync(registry), false, 'connect wrote to the registry')
})

test('CLI connect --no-forms writes the marker and no issue forms', () => {
  const { dir, backlog } = connectFixture('https://github.com/futin/backlog-manager.git')

  const out = run(dir, 'connect', 'github', '--no-forms')

  assert.equal(out.status, 0, out.stderr)
  // The https shape derives the same repo the ssh one does — asserted through the CLI as well as in the parsing table above, because this is the path where
  // the value actually comes back from git.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8')), { kind: 'github', repo: 'futin/backlog-manager' })
  assert.equal(fs.existsSync(path.join(dir, '.github')), false)
  assert.deepEqual(commitList(out.stdout), ['backlog/source.json'])
})

test('CLI connect takes an explicit owner/repo over the origin remote', () => {
  const { dir, backlog } = connectFixture('git@github.com:futin/from-origin.git')

  const out = run(dir, 'connect', 'github', 'futin/explicit', '--no-forms')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8')), { kind: 'github', repo: 'futin/explicit' })
})

test('CLI connect refuses a malformed owner/repo argument rather than writing it', () => {
  const { dir, backlog } = connectFixture('git@github.com:futin/x.git')

  const out = run(dir, 'connect', 'github', 'futin/../../etc')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /owner\/repo/)
  // The server interpolates this value into an api.github.com URL path on every machine that reads the marker, so a bad one is refused here rather than
  // committed and discovered on somebody else's laptop.
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
})

test('CLI connect refuses to overwrite an existing source.json and leaves it byte-identical', () => {
  const { dir, backlog } = connectFixture('git@github.com:futin/x.git')
  fs.mkdirSync(backlog, { recursive: true })
  const existing = '{ "kind": "github", "repo": "someone/else" }\n'
  fs.writeFileSync(path.join(backlog, 'source.json'), existing)

  const out = run(dir, 'connect', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /already connected/)
  assert.equal(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8'), existing)
})

test('CLI connect skips an issue form that already exists, leaves it untouched, and keeps it out of the commit list', () => {
  const { dir, backlog } = connectFixture('git@github.com:futin/x.git')
  fs.mkdirSync(path.join(dir, '.github', 'ISSUE_TEMPLATE'), { recursive: true })
  const mine = 'name: My own bug form\n'
  fs.writeFileSync(formPath(dir, 'bug.yml'), mine)

  const out = run(dir, 'connect', 'github')

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.readFileSync(formPath(dir, 'bug.yml'), 'utf8'), mine, 'a hand-written form must never be overwritten')
  assert.match(out.stdout, /skipped \.github\/ISSUE_TEMPLATE\/bug\.yml/)
  // A skipped file is not this run's output, and a path in the commit list that turns out to be unchanged teaches the operator to ignore the list.
  assert.deepEqual(commitList(out.stdout), [
    'backlog/source.json',
    '.github/ISSUE_TEMPLATE/idea.yml',
    '.github/ISSUE_TEMPLATE/task.yml',
    '.github/ISSUE_TEMPLATE/refactor.yml',
  ])
  assert.ok(fs.existsSync(path.join(backlog, 'source.json')))
})

test('each issue form pre-applies its type label and carries its section headings at level two', () => {
  const { dir } = connectFixture('git@github.com:futin/x.git')

  const out = run(dir, 'connect', 'github')
  assert.equal(out.status, 0, out.stderr)

  const expected = {
    'bug.yml': { label: 'type:bug', headings: ['## Symptom', '## Repro', '## Affects', '## Cause', '## Fix'] },
    'idea.yml': { label: 'type:idea', headings: ['## Problem', '## Rough shape', '## Open questions'] },
    'task.yml': { label: 'type:task', headings: ['## Goal', '## Plan', '## Test cases', '## Done when'] },
    'refactor.yml': { label: 'type:refactor', headings: ['## What exists today', '## Why it should change', '## Rough shape'] },
  }
  for (const [file, { label, headings }] of Object.entries(expected)) {
    const text = fs.readFileSync(formPath(dir, file), 'utf8')
    assert.match(text, new RegExp(`^ {2}- "${label}"$`, 'm'), `${file} does not pre-apply ${label}`)
    for (const heading of headings) {
      // Level TWO, inside the textarea's value. GitHub renders a form field's answer under `### <field label>`, so a field per heading would produce `### Cause`
      // and `sectionText` — which matches `## ` exactly — would read every bug as having no Cause at all. The headings have to survive into the issue body at
      // the level `deriveGroomed` reads, which is why they live in one pre-filled textarea.
      assert.match(text, new RegExp(`^ {8}${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${file} is missing ${heading}`)
    }
  }
  // The two headings `deriveGroomed` actually reads for a bug come pre-filled with `unknown`, exactly as backlog-capture writes them: a reporter filing through
  // the web UI does not know the cause, and a form that left them empty would derive the same "ungroomed" answer by accident rather than by statement.
  const bug = fs.readFileSync(formPath(dir, 'bug.yml'), 'utf8')
  assert.match(bug, /^ {8}## Cause\n\n {8}unknown$/m)
  assert.match(bug, /^ {8}## Fix\n\n {8}unknown$/m)
})

test('CLI connect refuses an unknown platform and two repo arguments with its usage line', () => {
  const { dir, backlog } = connectFixture('git@github.com:futin/x.git')

  const gitlab = run(dir, 'connect', 'gitlab', 'futin/x')
  assert.equal(gitlab.status, 1)
  assert.match(gitlab.stderr, /usage: backlog\.mjs connect github/)

  const two = run(dir, 'connect', 'github', 'futin/x', 'futin/y')
  assert.equal(two.status, 1)
  assert.match(two.stderr, /usage: backlog\.mjs connect github/)

  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
})

test('connect appears in the top-level usage block', () => {
  const { dir } = backlogFixture()

  const out = run(dir, 'nonsense')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /^ {2}connect {5}/m)
})

// --- task-46: backlog.mjs in API mode ----------------------------------------
//
// A project whose committed marker says `github` has NO ITEM FILES (spec §6.5): every command routes through the backlog-manager API on this machine, which
// holds the credential and does the writing. These cases spawn the REAL tool against a fake API on an ephemeral port, exactly as every other CLI case here
// spawns it against a real store — the tool is the subject, and stubbing its transport would test the stub.
//
// Two properties are asserted over and over and are the reason for the shape of this harness:
//
//   * **What goes on the wire.** The CLI cannot import the server's request types (a plugin skill's `tools/` is a standalone copy of what was pushed, with no
//     path back into the repo), so the agreement between the two sides is enforced mechanically instead: these cases assert the exact bodies, and
//     `shared/types.ts` declares the shapes the routes validate.
//   * **The child EXITS.** `main` is async in this mode, and the "all three CLIs exit through process.exitCode" invariant requires that nothing hold the event
//     loop open. Every case below is a `spawnSync` that has to return — a hanging socket would time the suite out rather than pass quietly.

import http from 'node:http'

/** The fake API: records every request and answers from a per-route table. */
function fakeApi(routes) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url, 'http://127.0.0.1')
      let body = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        body = raw
      }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body })

      const answer = routes[url.pathname]
      // A route function is given the REQUEST as well as the body, because one path answers two verbs: `GET /api/items/body` is an item's Markdown and
      // `POST /api/items/body` replaces it, and a fake that could not tell them apart would have to answer one of them wrongly.
      const resolved = typeof answer === 'function' ? answer(body, { method: req.method, query: Object.fromEntries(url.searchParams) }) : answer
      if (resolved === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `no fake route for ${url.pathname}` }))
        return
      }
      const status = resolved.status ?? 200
      const payload = resolved.body
      // text/plain for the body route, which answers Markdown rather than JSON — the same content type the real one uses.
      const type = typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json'
      res.writeHead(status, { 'content-type': type })
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null))
    })
  })
  return { server, requests }
}

/**
 * Stand a fake API up, run one command against it, tear it down.
 *
 * `async`, which makes the cases below the only asynchronous ones in this file — `listen` is resolved by the event loop and there is no synchronous way to
 * learn the ephemeral port it chose. The SPAWN inside is still `spawnSync`, exactly as every other CLI case here, so what each case asserts on is a completed
 * child process rather than a stream.
 *
 * `127.0.0.1`, never the wildcard, for the reason `test/helpers/app.ts` gives at length on the jest side: a bare `listen(0)` binds `::` and the kernel picks a
 * port against that address alone, so another process holding the same number on IPv4 loopback answers instead.
 */
/**
 * The same spawn every other CLI case here makes, ASYNCHRONOUSLY — and the difference is a deadlock, not a preference.
 *
 * The fake API runs in THIS process. `spawnSync` blocks this process's event loop until the child exits, so a child that connects to the fake would wait for
 * an accept that cannot happen until it has already exited: the first version of these cases sat for five minutes and then reported exit `5`, which reads
 * exactly like a stack that is not running. Every case that stands a server up therefore awaits its child instead.
 */
function runNode(cwd, env, ...args) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

async function withApi(routes, fn) {
  const { server, requests } = fakeApi(routes)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return { out: await fn(port), requests }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** A tracker fixture: a git repo whose `backlog/` holds the marker and nothing else. */
function trackerFixture(repo = 'futin/x') {
  const { dir, backlog } = backlogFixture()
  fs.mkdirSync(backlog, { recursive: true })
  fs.writeFileSync(path.join(backlog, 'source.json'), JSON.stringify({ kind: 'github', repo }, null, 2) + '\n')
  return { dir, backlog }
}

// `BM_MACHINE_NAME` blanked unless a case sets it: a machine that exports one (the claim host nickname lives in `~/.zshenv`) would otherwise leak it into
// every child, and each case that compares a claim's host against `THIS_HOST` would fail there and pass everywhere else. Blank reads as unset.
const apiEnv = (port, extra = {}) => ({ ...process.env, BM_MACHINE_NAME: '', BM_API_PORT: String(port), ...extra })

/** One issue as `/api/items` returns it, with only what a case is about spelled out. */
function apiItem(over = {}) {
  return {
    id: '#31',
    title: 'the board lies',
    created: '2026-09-01',
    started: '',
    updated: '2026-09-02T10:00:00Z',
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    tags: [],
    section: 'bugs',
    status: 'open',
    project: 'gamma',
    projectPath: '',
    groomed: true,
    path: 'gh:futin/x#31',
    source: 'github',
    url: 'https://github.com/futin/x/issues/31',
    assignee: null,
    untyped: false,
    ...over,
  }
}

test('API mode: nothing listening is exit 5, names the port and both start commands, and prints nothing to stdout', async () => {
  const { dir } = trackerFixture()
  // Port 1 is privileged and nothing listens there; the connection is refused rather than hanging.
  const out = await runNode(dir, apiEnv(1), 'board')

  assert.equal(out.status, 5)
  assert.match(out.stderr, /127\.0\.0\.1:1/)
  assert.match(out.stderr, /pnpm run dev/)
  assert.match(out.stderr, /pnpm run docker:up/)
  assert.equal(out.stdout, '')
})

test('API mode: a marker naming a kind this tool cannot write to is exit 1, and makes no request', async () => {
  const { dir, backlog } = trackerFixture()
  fs.writeFileSync(path.join(backlog, 'source.json'), JSON.stringify({ kind: 'gitlab', repo: 'a/b' }))

  const { out, requests } = await withApi({}, async (port) => await runNode(dir, apiEnv(port), 'board'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /gitlab/)
  assert.deepEqual(requests, [])
})

// The load-bearing negative, and the same one `resolveSource` carries on the server: a marker this tool cannot read must NEVER fall back to files. Falling
// back would write item files into a project whose items live on GitHub, on one machine, where nothing would ever report them.
test('API mode: a github marker with a malformed repo is exit 1, not a fallback to files', async () => {
  const { dir, backlog } = trackerFixture()
  fs.writeFileSync(path.join(backlog, 'source.json'), JSON.stringify({ kind: 'github', repo: 'not-a-repo' }))

  const out = run(dir, 'new', 'bugs', 'a title')
  assert.equal(out.status, 1)
  assert.match(out.stderr, /repo/)
  assert.deepEqual(fs.readdirSync(backlog), ['source.json'])
})

test('API mode: init registers the project, creates no directories, and says it is already connected', async () => {
  const { dir, backlog } = trackerFixture()
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-reg-')), 'registry.json')

  const out = await runNode(dir, { ...process.env, BM_REGISTRY_FILE: registry }, 'init')

  assert.equal(out.status, 0)
  assert.match(out.stdout, /already connected: .* → github futin\/x/)
  assert.deepEqual(fs.readdirSync(backlog), ['source.json'])
  assert.ok(JSON.parse(fs.readFileSync(registry, 'utf8')).projects.some((p) => p.path === dir))
})

test('API mode: new posts create and prints the id, the url and the urn', async () => {
  const { dir } = trackerFixture()
  const bodyFile = path.join(dir, 'body.md')
  fs.writeFileSync(bodyFile, '## Symptom\n\nit breaks\n')

  const { out, requests } = await withApi(
    { '/api/items/create': { status: 201, body: { id: '#77', urn: 'gh:futin/x#77', url: 'https://github.com/futin/x/issues/77', number: 77 } } },
    async (port) => await runNode(dir, apiEnv(port), 'new', 'bugs', 'a title', '--body', bodyFile),
  )

  assert.equal(out.status, 0)
  assert.deepEqual(out.stdout.trim().split('\n'), ['#77', 'https://github.com/futin/x/issues/77', 'gh:futin/x#77'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].path, '/api/items/create')
  assert.deepEqual(requests[0].body, { project: dir, section: 'bugs', title: 'a title', body: '## Symptom\n\nit breaks\n' })
})

// `--body` is REQUIRED here and REFUSED in files mode, and the two contracts are opposites on purpose: a files `new` prints what to write and the skill writes
// the file, so a `--body` flag there would make this command a second writer of item files.
test('API mode: new without --body is a usage error and makes no request', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi({}, async (port) => await runNode(dir, apiEnv(port), 'new', 'bugs', 'a title'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /--body <file>/)
  assert.deepEqual(requests, [])
})

test('files mode: new --body is refused and writes nothing', async () => {
  const { dir, backlog } = backlogFixture()
  run(dir, 'init')
  const bodyFile = path.join(dir, 'body.md')
  fs.writeFileSync(bodyFile, 'x\n')

  const out = run(dir, 'new', 'bugs', 'a title', '--body', bodyFile)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /usage: backlog.mjs new/)
  assert.deepEqual(fs.readdirSync(path.join(backlog, 'bugs', 'open')), [])
})

test('API mode: new --from sends the cited id in the tracker spelling', async () => {
  const { dir } = trackerFixture()
  const bodyFile = path.join(dir, 'body.md')
  fs.writeFileSync(bodyFile, 'x\n')

  const { requests } = await withApi({ '/api/items/create': { status: 201, body: { id: '#77', urn: 'gh:futin/x#77', url: 'u', number: 77 } } }, async (port) =>
    await runNode(dir, apiEnv(port), 'new', 'tasks', 't', '--body', bodyFile, '--from', '12'),
  )

  assert.equal(requests[0].body.from, '#12')
})

// Three spellings, one issue. A person types `31`, a skill's prose says `#31`, and the board posts the URN — and all three have to mean the same item or a
// skill written against one of them breaks against another.
test('API mode: show accepts a number, a #number and this project-s urn identically', async () => {
  const { dir } = trackerFixture()
  const routes = {
    '/api/items': { body: { items: [apiItem({ projectPath: dir, started: '2026-09-18T10:00:00Z', phase: 'groom', groomElapsed: 120, groomTokens: 4000 })], errors: [] } },
    '/api/items/body': { body: '## Symptom\n\nthe cached issue body\n' },
    '/api/items/claim': { body: null },
  }

  const outputs = []
  for (const id of ['31', '#31', 'gh:futin/x#31']) {
    const { out } = await withApi(routes, async (port) => await runNode(dir, apiEnv(port), 'show', id))
    outputs.push(out)
  }

  for (const out of outputs) assert.equal(out.status, 0)
  assert.equal(outputs[0].stdout, outputs[1].stdout)
  assert.equal(outputs[1].stdout, outputs[2].stdout)

  const printed = outputs[0].stdout
  assert.match(printed, /^gh:futin\/x#31\n/)
  assert.match(printed, /started: 2026-09-18T10:00:00Z/)
  assert.match(printed, /phase: groom/)
  assert.match(printed, /groom-elapsed: 120/)
  assert.match(printed, /groom-tokens: 4000/)
  // The body, byte for byte, after the closing `---` — spec §6.5: there is no file for the skill to read.
  assert.ok(printed.endsWith('## Symptom\n\nthe cached issue body\n'))
})

test('API mode: show refuses another repo-s urn and a file-shaped id, each with its own sentence', async () => {
  const { dir } = trackerFixture()
  const routes = { '/api/items': { body: { items: [], errors: [] } } }

  const { out: other } = await withApi(routes, async (port) => await runNode(dir, apiEnv(port), 'show', 'gh:other/y#31'))
  assert.equal(other.status, 1)
  assert.match(other.stderr, /other\/y/)

  const { out: fileId } = await withApi(routes, async (port) => await runNode(dir, apiEnv(port), 'show', 'task-31'))
  assert.equal(fileId.status, 1)
  assert.match(fileId.stderr, /file id/)
})

test('API mode: show --json carries the urn, the body, updatedAt and the claim', async () => {
  const { dir } = trackerFixture()
  const { out } = await withApi(
    {
      '/api/items': { body: { items: [apiItem({ projectPath: dir })], errors: [] } },
      '/api/items/body': { body: '# body\n' },
      '/api/items/claim': { body: { commentId: 100, record: { v: 1, session: 'A', phase: 'groom', at: '2026-09-18T10:00:00Z', heartbeat: '2026-09-18T10:05:00Z', counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } },
    },
    async (port) => await runNode(dir, apiEnv(port), 'show', '31', '--json'),
  )

  assert.equal(out.status, 0)
  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.urn, 'gh:futin/x#31')
  assert.equal(parsed.body, '# body\n')
  assert.equal(parsed.updatedAt, '2026-09-02T10:00:00Z')
  assert.equal(parsed.claim.commentId, 100)
})

/* bug-45, the readable half. `show` already READ the claim — it was in `--json` and nowhere a person or a skill reading the block would see it — so an item
   that says `started:` looked identical whether this session held it or another machine did. Two keys answer it by comparison, needing no knowledge of the
   protocol: who holds the claim, and who is asking. Both are always printed, empty when nobody holds it, because a key that disappears is a key a skill has
   to branch on. */
test('API mode: show names the claim-s holder and this session, and --json carries this session too', async () => {
  const { dir } = trackerFixture()
  const routes = {
    '/api/items': { body: { items: [apiItem({ projectPath: dir, started: '2026-09-18T10:00:00Z', phase: 'groom' })], errors: [] } },
    '/api/items/body': { body: '# body\n' },
    '/api/items/claim': { body: { commentId: 100, record: { v: 1, session: 'e33d0074', phase: 'groom', at: '2026-09-18T10:00:00Z', heartbeat: '2026-09-18T10:05:00Z', counters: {} } } },
  }

  const { out } = await withApi(routes, async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'show', '31'))
  assert.equal(out.status, 0)
  assert.match(out.stdout, /claim-session: e33d0074/)
  assert.match(out.stdout, /this-session: sess-mine/)

  const { out: json } = await withApi(routes, async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'show', '31', '--json'))
  assert.equal(JSON.parse(json.stdout).session, 'sess-mine')

  // Nobody holds it: both keys are still there, the holder's empty — an absent key would be a second shape for a skill to handle.
  const { out: free } = await withApi({ ...routes, '/api/items/claim': { body: null } }, async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'show', '31'),
  )
  assert.match(free.stdout, /claim-session: \n/)
  assert.match(free.stdout, /this-session: sess-mine/)
})

test('API mode: board reads /api/items once and prints only this project-s open rows', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(
    {
      '/api/items': {
        body: {
          items: [
            apiItem({ projectPath: dir, started: '2026-09-18T10:00:00Z' }),
            apiItem({ id: '#32', title: 'somebody else-s', projectPath: '/abs/elsewhere' }),
            apiItem({ id: '#33', title: 'already done', projectPath: dir, status: 'done' }),
          ],
          errors: [],
        },
      },
    },
    async (port) => await runNode(dir, apiEnv(port), 'board'),
  )

  assert.equal(out.status, 0)
  assert.match(out.stdout, /the board lies/)
  assert.doesNotMatch(out.stdout, /somebody else-s/)
  assert.doesNotMatch(out.stdout, /already done/)
  // The in-progress marker, drawn from `started` exactly as it is for a files row.
  assert.match(out.stdout, /»\s*the board lies/)
  assert.equal(requests.filter((r) => r.path === '/api/items').length, 1)
})

test('API mode: board --section filters', async () => {
  const { dir } = trackerFixture()
  const { out } = await withApi(
    { '/api/items': { body: { items: [apiItem({ projectPath: dir }), apiItem({ id: '#40', title: 'an idea', section: 'ideas', projectPath: dir })], errors: [] } } },
    async (port) => await runNode(dir, apiEnv(port), 'board', '--section', 'ideas'),
  )

  assert.equal(out.status, 0)
  assert.match(out.stdout, /an idea/)
  assert.doesNotMatch(out.stdout, /the board lies/)
})

test('API mode: move posts state, carrying --outcome-s bytes', async () => {
  const { dir } = trackerFixture()
  const outcomeFile = path.join(dir, 'outcome.md')
  fs.writeFileSync(outcomeFile, '## Outcome\n\nit worked\n')

  const { out, requests } = await withApi({ '/api/items/state': { body: { id: '#31', status: 'done', url: 'https://github.com/futin/x/issues/31' } } }, async (port) =>
    await runNode(dir, apiEnv(port), 'move', '31', 'done', '--outcome', outcomeFile),
  )

  assert.equal(out.status, 0)
  assert.equal(out.stdout.trim(), 'https://github.com/futin/x/issues/31')
  assert.deepEqual(requests[0].body, { project: dir, id: '#31', status: 'done', outcome: '## Outcome\n\nit worked\n' })
})

test('API mode: move without --outcome sends no outcome key at all', async () => {
  const { dir } = trackerFixture()
  const { requests } = await withApi({ '/api/items/state': { body: { id: '#31', status: 'out-of-scope', url: 'u' } } }, async (port) =>
    await runNode(dir, apiEnv(port), 'move', '31', 'out-of-scope'),
  )

  assert.deepEqual(requests[0].body, { project: dir, id: '#31', status: 'out-of-scope' })
})

test('files mode: move --outcome is refused and the item does not move', async () => {
  const { dir, backlog } = backlogFixture()
  run(dir, 'init')
  const file = path.join(backlog, 'bugs', 'open', 'bug-1-x.md')
  fs.writeFileSync(file, '---\nid: bug-1\ntitle: x\ncreated: 2026-09-01\n---\n\nbody\n')
  const outcomeFile = path.join(dir, 'o.md')
  fs.writeFileSync(outcomeFile, 'x\n')

  const out = run(dir, 'move', 'bug-1', 'done', '--outcome', outcomeFile)
  assert.equal(out.status, 1)
  assert.ok(fs.existsSync(file))
})

test('API mode: start posts claim with the session identity and prints the urn, the comment id and the heartbeat hint', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(
    { '/api/items/claim': { status: 201, body: { commentId: 100, record: { v: 1, session: 'sess-abc', phase: 'groom', at: '2026-09-18T10:00:00Z', heartbeat: '2026-09-18T10:00:00Z', counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } } },
    async (port) =>
      await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-abc' }), 'start', '31', '--as', 'groom'),
  )

  assert.equal(out.status, 0)
  // `host` is bug-46's and is asserted for its SHAPE one test down; here the point is that the claim POST carries these keys and no others.
  const { host, ...rest } = requests[0].body
  assert.deepEqual(rest, { project: dir, id: '#31', phase: 'groom', session: 'sess-abc' })
  assert.equal(typeof host, 'string')
  assert.match(out.stdout, /^gh:futin\/x#31\n/)
  assert.match(out.stdout, /claim 100/)
  assert.match(out.stdout, /heartbeat #31 between long steps/)
})

test('API mode: start without --as is a usage error and makes no request', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi({}, async (port) => await runNode(dir, apiEnv(port), 'start', '31'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /--as/)
  assert.deepEqual(requests, [])
})

// Without a session id the identity is `<user>@<host>` — stable across the two PROCESSES `start` and `stop` run in, and honest about who it names.
test('API mode: start falls back to user@host when there is no session id', async () => {
  const { dir } = trackerFixture()
  const env = apiEnv(0)
  delete env.CLAUDE_CODE_SESSION_ID
  const { requests } = await withApi({ '/api/items/claim': { status: 201, body: { commentId: 1, record: {} } } }, async (port) =>
    await runNode(dir, { ...env, BM_API_PORT: String(port) }, 'start', '31', '--as', 'groom'),
  )

  assert.match(requests[0].body.session, /^[^@]+@.+$/)
})

test('API mode: start reports a lost race with the holder-s session and the age of its heartbeat', async () => {
  const { dir } = trackerFixture()
  const { out } = await withApi(
    {
      '/api/items/claim': {
        status: 409,
        body: { error: '#31 is already in progress (session A)', holder: { session: 'A', heartbeat: '2026-09-18T10:00:00Z', ageMs: 4 * 60 * 1000, commentId: 100 } },
      },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'start', '31', '--as', 'groom'),
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /session A/)
  assert.match(out.stderr, /heartbeat 4m ago/)
  // And who THIS session is (bug-45) — without it the reader has the holder's id and no way to tell it apart from their own.
  assert.match(out.stderr, /this session is sess-mine/)
})

/* bug-46. A claim published a session id and nothing else, and a session id names a transcript on exactly one machine — so the one check a reader on another
   machine can run ("is there a session by that id here?") answers no for every foreign claim, live or dead, and that no was read as proof of death. The host
   is what the CLI knows and the server must not derive: the server may be in the compose stack, where `os.hostname()` is a container id. */
test('API mode: start sends the host beside the session, as user@host', async () => {
  const { dir } = trackerFixture()
  const { requests } = await withApi({ '/api/items/claim': { status: 201, body: { commentId: 1, record: {} } } }, async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'start', '31', '--as', 'groom'),
  )

  assert.match(requests[0].body.host, /^[^@]+@.+$/)
  // The session stays the identity and is NOT widened into it: three sites compare it raw.
  assert.equal(requests[0].body.session, 'sess-mine')
})

test('API mode: start names both machines when the holder-s claim recorded one', async () => {
  const { dir } = trackerFixture()
  const { out } = await withApi(
    {
      '/api/items/claim': {
        status: 409,
        body: {
          error: '#31 is already in progress (session A)',
          holder: { session: 'A', host: 'futin@linux-box', heartbeat: '2026-09-18T10:00:00Z', ageMs: 4 * 60 * 1000, commentId: 100 },
        },
      },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'start', '31', '--as', 'groom'),
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /session A on futin@linux-box, heartbeat 4m ago/)
  assert.match(out.stderr, /this session is sess-mine on [^@\s]+@\S+/)
})

/* And degrades to the old line, whole, when the holder recorded no host — never to `on unknown`, and never to naming OUR host beside their blank. The reader
   is comparing two sides: a line that says where we are and says nothing about them invites exactly the inference this bug is made of. */
test('API mode: start prints today-s refusal line when the holder recorded no host', async () => {
  const { dir } = trackerFixture()
  const { out } = await withApi(
    {
      '/api/items/claim': {
        status: 409,
        body: { error: '#31 is already in progress (session A)', holder: { session: 'A', heartbeat: '2026-09-18T10:00:00Z', ageMs: 4 * 60 * 1000, commentId: 100 } },
      },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'start', '31', '--as', 'groom'),
  )

  assert.equal(out.status, 1)
  assert.equal(
    out.stderr.trim(),
    "#31 is already in progress (session A, heartbeat 4m ago) — this session is sess-mine — losing the race ends this session's work on this item",
  )
})

/* bug-47. This line is the ONE sentence a losing session reliably reads — whichever skill is driving it, or none — and it carried a heartbeat age and no
   rule. An age plus a readable `CLAIM_STALE_MS` is a deadline computable to the second, and a deadline with nothing said about it reads as a countdown: the
   session that produced this bug scheduled a re-claim for the moment the window closed and worked through the wait. The age STAYS — it is exactly what a
   person deciding whether to wait thirty seconds or walk away needs, and removing it stops nothing, since `show --json` prints the same heartbeat. What the
   line was missing is the rule, so the two now travel together and neither can be read without the other. */
test('API mode: start-s lost-race refusal ends with the rule, and still carries the age', async () => {
  const { dir } = trackerFixture()
  const { out } = await withApi(
    {
      '/api/items/claim': {
        status: 409,
        body: {
          error: '#31 is already in progress (session A)',
          holder: { session: 'A', host: 'futin@linux-box', heartbeat: '2026-09-18T10:00:00Z', ageMs: 4 * 60 * 1000, commentId: 100 },
        },
      },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'start', '31', '--as', 'execute'),
  )

  assert.equal(out.status, 1)
  // Both halves, asserted separately: the rule is worthless without the evidence, and the evidence is what this bug is made of without the rule.
  assert.match(out.stderr, /heartbeat 4m ago/)
  assert.match(out.stderr, /— losing the race ends this session's work on this item$/m)
})

test('API mode: show names the machine beside each session, empty when the claim recorded none', async () => {
  const { dir } = trackerFixture()
  const claim = (record) => ({
    '/api/items': { body: { items: [apiItem({ projectPath: dir, started: '2026-09-18T10:00:00Z', phase: 'groom' })], errors: [] } },
    '/api/items/body': { body: '# body\n' },
    '/api/items/claim': { body: { commentId: 100, record } },
  })
  const held = { v: 1, session: 'e33d0074', phase: 'groom', at: '2026-09-18T10:00:00Z', heartbeat: '2026-09-18T10:05:00Z', counters: {} }

  const { out } = await withApi(claim({ ...held, host: 'futin@linux-box' }), async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'show', '31'),
  )
  assert.equal(out.status, 0)
  assert.match(out.stdout, /claim-host: futin@linux-box/)
  assert.match(out.stdout, /this-host: [^@\s]+@\S+/)

  // Empty rather than absent, the rule `claim-session:` already follows: a key that disappears is a second shape for every skill to handle.
  const { out: hostless } = await withApi(claim(held), async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'show', '31'),
  )
  assert.match(hostless.stdout, /claim-host: \n/)
})

/* ---------------------------------------------------------------------------
 * `BM_MACHINE_NAME` — the name this machine publishes.
 *
 * `hostIdentity()` is written onto a claim comment, and on a PUBLIC repository that comment publishes the OS username and the hostname of every machine that
 * ever touches an item. The nickname is the machine's own answer to "who are you" — chosen by the person who owns the box, compared for equality exactly as
 * `<user>@<host>` was, and readable to the next person the way a digest would not be.
 *
 * It is read where `BM_API_PORT` and `BM_REGISTRY_FILE` are read, from the environment and nowhere else, and it changes NOTHING when it is unset.
 * --------------------------------------------------------------------------- */

test('API mode: BM_MACHINE_NAME is the machine a claim names, in place of <user>@<host>', async () => {
  const { dir } = trackerFixture()
  const claim = {
    '/api/items': { body: { items: [apiItem({ projectPath: dir })], errors: [] } },
    '/api/items/body': { body: '# body\n' },
    '/api/items/claim': { body: null },
  }

  const { out } = await withApi(claim, async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine', BM_MACHINE_NAME: 'laptop' }), 'show', '31'),
  )

  assert.equal(out.status, 0)
  assert.match(out.stdout, /this-host: laptop\n/)
  // The username must not survive anywhere in the output: publishing it is the whole thing the nickname exists to stop.
  assert.ok(!out.stdout.includes(os.userInfo().username), 'a nicknamed machine must not print its OS username')
})

test('API mode: a blank BM_MACHINE_NAME falls back to <user>@<host> rather than naming nobody', async () => {
  const { dir } = trackerFixture()
  const claim = {
    '/api/items': { body: { items: [apiItem({ projectPath: dir })], errors: [] } },
    '/api/items/body': { body: '# body\n' },
    '/api/items/claim': { body: null },
  }

  const { out } = await withApi(claim, async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine', BM_MACHINE_NAME: '   ' }), 'show', '31'),
  )

  assert.equal(out.status, 0)
  // An empty machine name is the state `ClaimRecord.host`'s own doc refuses to invent a word for: absence must mean "not recorded", so a blank setting has to
  // read as no setting at all rather than as a claim held by the empty string.
  assert.match(out.stdout, new RegExp(`this-host: ${os.userInfo().username}@`))
})

// The billing semantics `stopItem` already has, reproduced against a claim comment instead of frontmatter: the seeded total plus this session's seconds, into
// the bucket the claim's own `phase` names.
test('API mode: stop bills the elapsed seconds on top of the claim-s seeded counters', async () => {
  const { dir } = trackerFixture()
  const at = new Date(Date.now() - 90_000).toISOString()
  const { out, requests } = await withApi(
    {
      '/api/items/claim': {
        body: { commentId: 100, record: { v: 1, session: 'sess-abc', phase: 'groom', at, heartbeat: new Date().toISOString(), counters: { groomElapsed: 10, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } },
      },
      '/api/items/release': { status: 201, body: { commentId: 100, record: {} } },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-abc' }), 'stop', '31'),
  )

  assert.equal(out.status, 0)
  assert.equal(out.stdout.trim(), 'gh:futin/x#31')
  const release = requests.find((r) => r.path === '/api/items/release')
  assert.equal(release.body.commentId, 100)
  assert.equal(release.body.reason, 'stopped')
  // bug-42 gave `release` a second authority — the RUN that owns the claim — and a hand stop is deliberately not in it. `backlog.mjs` sends no `runId`,
  // so the only claim it can ever release is one it holds itself or one that is already dead; its own client-side refusal above stays the first gate.
  assert.ok(!('runId' in release.body), 'a hand stop must never assert run authority')
  // 10 seeded + 90 this session, with a second of tolerance for the clock between the two lines above.
  assert.ok(Math.abs(release.body.counters.groomElapsed - 100) <= 1, `billed ${release.body.counters.groomElapsed}`)
})

// `--abandon` sends NO counters key, which is not the same as sending zeros: zeros would OVERWRITE the seeded totals and erase every earlier session's work.
test('API mode: stop --abandon releases with no counters at all', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(
    {
      '/api/items/claim': {
        body: { commentId: 100, record: { v: 1, session: 'sess-abc', phase: 'groom', at: new Date(Date.now() - 90_000).toISOString(), heartbeat: new Date().toISOString(), counters: { groomElapsed: 10, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } },
      },
      '/api/items/release': { status: 201, body: { commentId: 100, record: {} } },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-abc' }), 'stop', '31', '--abandon'),
  )

  assert.equal(out.status, 0)
  const release = requests.find((r) => r.path === '/api/items/release')
  assert.equal(release.body.reason, 'abandoned')
  assert.ok(!('counters' in release.body), 'counters must be absent, never zeroed')
})

test('API mode: stop on an item with no live claim is exit 1 and releases nothing', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi({ '/api/items/claim': { body: null } }, async (port) =>
    await runNode(dir, apiEnv(port), 'stop', '31'),
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /not in progress/)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

/* ---------------------------------------------------------------------------
 * bug-48 — `abort`, the human sibling of `orchestrate.mjs abort`.
 *
 * A hand-run session killed mid-item passes through no terminal stage, so it releases nothing, and the old release triple answered about nobody who still
 * exists: the holder is gone, a hand claim carries no `run` by construction, and the claim is fresh because `heartbeat` was re-stamped seconds before the
 * kill. The item then read as in progress on every machine for fifteen minutes with no command anywhere to clear it.
 *
 * The PROOF that the holder is gone is this CLI's, not the server's — the server can see neither the caller's filesystem nor its process table — so the
 * three refusals below are where the narrowness lives, and they are what these cases pin.
 * --------------------------------------------------------------------------- */

/** What `hostIdentity()` computes inside the child: the same `<user>@<host>` this process would compute, since the child runs here. */
const THIS_HOST = `${os.userInfo().username}@${os.hostname()}`

/** A live claim held by a session that is not this one, on a machine the case names. */
const abortableClaim = (over = {}) => ({
  '/api/items/claim': {
    body: {
      commentId: 100,
      record: {
        v: 1,
        session: 'sess-gone',
        host: THIS_HOST,
        phase: 'execute',
        at: new Date(Date.now() - 600_000).toISOString(),
        heartbeat: new Date().toISOString(),
        counters: { groomElapsed: 0, executeElapsed: 40, groomTokens: 0, executeTokens: 900 },
        ...over,
      },
    },
  },
  '/api/items/release': { status: 201, body: { commentId: 100, record: {} } },
})

/* Claude Code's own process registry, `<configDir>/sessions/<pid>.json` — the evidence `abort` reads since bug-49. A temp config dir per case, never the
   real one: the real registry holds this machine's live sessions, and none of them is `sess-aborting`, so every case would read the self-check as failed. */
function registryFixture(entries = [], { self = true } = {}) {
  const config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-registry-')))
  const sessions = path.join(config, 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  const all = self ? [{ pid: process.pid, sessionId: 'sess-aborting', procStart: selfProcStart() }, ...entries] : entries
  all.forEach((entry, i) => fs.writeFileSync(path.join(sessions, `${entry.pid ?? `x${i}`}-${i}.json`), JSON.stringify(entry)))
  return { config, sessions }
}

/** This process's start time the way the registry records it on Linux — field 22 of `/proc/<pid>/stat` — or a date string where there is no `/proc`,
 *  which is the shape macOS writes and which the CLI never compares. */
function selfProcStart() {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return new Date().toString()
  }
}

/** A pid that is certainly not running: a child spawned and reaped before the case reads it. */
const deadPid = () => spawnSync('node', ['-e', '']).pid

const abortEnv = (port, config, extra = {}) => apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-aborting', CLAUDE_CONFIG_DIR: config, ...extra })

test('API mode: abort releases a live claim whose holding session is gone from THIS machine', async () => {
  const { dir } = trackerFixture()
  const { config } = registryFixture()
  const { out, requests } = await withApi(abortableClaim(), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 0, out.stderr)
  const releases = requests.filter((r) => r.path === '/api/items/release')
  assert.equal(releases.length, 1, 'abort must release the claim exactly once')
  const release = releases[0]
  assert.equal(release.body.commentId, 100)
  // The same word `orchestrate.mjs abort` writes (bug-40), because it is the same event: a session torn down without passing through a terminal stage.
  assert.equal(release.body.reason, 'aborted')
  assert.equal(release.body.session, 'sess-aborting')
  // The assertion the server's fourth clause is decided on — and never a `runId`, which a person at a terminal has no standing to claim.
  assert.equal(release.body.host, THIS_HOST)
  assert.ok(!('runId' in release.body), 'a hand abort must never assert run authority')
  // `--abandon`'s rule, for `--abandon`'s reason: the stretch between the last heartbeat and the kill is not work anybody did, and zeros would erase what
  // every earlier session accumulated. The key's ABSENCE is the assertion, not that it is zero.
  assert.ok(!('counters' in release.body), 'counters must be absent, never zeroed')
})

/* The regression case, and the repro of bug-49: the heartbeat that stamped the claim was a tool call INSIDE the holding session, whose `tool_result` lands in
   its transcript after the beat — so every session killed after its last heartbeat has a transcript newer than that beat. bug-48's mtime check refused
   exactly this, which is why the repro had to be cleared with a raw `POST /api/items/release`. A transcript is not evidence of a process. */
test('API mode: abort releases when the holder-s transcript is NEWER than the heartbeat but no registry file names it', async () => {
  const { dir } = trackerFixture()
  const { config } = registryFixture()
  const projects = path.join(config, 'projects')
  const beat = new Date(Date.now() - 60_000).toISOString()
  const file = writeTranscript(projects, 'proj-a', 'sess-gone.jsonl', [])
  const fresh = Date.now()
  fs.utimesSync(file, fresh / 1000, fresh / 1000)

  const { out, requests } = await withApi(abortableClaim({ heartbeat: beat }), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(requests.filter((r) => r.path === '/api/items/release').length, 1)
})

/* The check that makes `abort` a repair rather than a seizure. Without it, a second session on the same laptop could take an item out from under the
   person holding it at a terminal. The registry file and its pid are named, because "something is still running" with no evidence attached is exactly the
   unanswerable refusal bug-48 was about. */
test('API mode: abort refuses while a registry file names the holding session and its pid is running', async () => {
  const { dir } = trackerFixture()
  const { config } = registryFixture([{ pid: process.pid, sessionId: 'sess-gone', procStart: selfProcStart() }])

  const { out, requests } = await withApi(abortableClaim(), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 1)
  assert.ok(out.stderr.includes(`${process.pid}-1.json`), `the registry file must be named: ${out.stderr}`)
  assert.ok(out.stderr.includes(`pid ${process.pid}`), `the pid must be named: ${out.stderr}`)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

// A hard kill leaves the registry file behind; its pid is what says the process is gone.
test('API mode: abort releases when the registry file naming the holder points at a pid that is not running', async () => {
  const { dir } = trackerFixture()
  const { config } = registryFixture([{ pid: deadPid(), sessionId: 'sess-gone', procStart: '1' }])

  const { out, requests } = await withApi(abortableClaim(), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(requests.filter((r) => r.path === '/api/items/release').length, 1)
})

// A reused pid: running, but not the process the file was written for. Only Linux can tell, from `/proc/<pid>/stat`; elsewhere the pid test stands alone.
test('API mode: abort releases when the holder-s pid is running but its procStart differs (Linux only)', { skip: !fs.existsSync('/proc/self/stat') }, async () => {
  const { dir } = trackerFixture()
  const { config } = registryFixture([{ pid: process.pid, sessionId: 'sess-gone', procStart: String(Number(selfProcStart()) + 1) }])

  const { out, requests } = await withApi(abortableClaim(), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(requests.filter((r) => r.path === '/api/items/release').length, 1)
})

/* Fail CLOSED on a registry this build cannot read or does not understand: a misread there turns every live neighbour into a dead one. Three shapes of
   "cannot tell", each exit 1 with no request. */
test('API mode: abort refuses when the session registry directory is absent', async () => {
  const { dir } = trackerFixture()
  const config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-registry-')))

  const { out, requests } = await withApi(abortableClaim(), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /cannot tell/)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

test('API mode: abort refuses when a registry file carries no sessionId', async () => {
  const { dir } = trackerFixture()
  const { config } = registryFixture([{ pid: deadPid(), procStart: '1' }])

  const { out, requests } = await withApi(abortableClaim(), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /cannot tell/)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

// The self-check: a session that cannot find ITSELF in the registry is reading a registry whose shape changed, and its "nothing names the holder" means
// nothing either.
test('API mode: abort refuses when the aborting session has no live entry of its own', async () => {
  const { dir } = trackerFixture()
  const { config } = registryFixture([], { self: false })

  const { out, requests } = await withApi(abortableClaim(), async (port) => await runNode(dir, abortEnv(port, config), 'abort', '31'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /cannot tell/)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

/* Cross-machine is refused and the message says the honest thing. There is deliberately no remote path: a machine that cannot answer cannot prove
   anything, and the fifteen-minute window is the protocol's own repair for exactly that case. */
test('API mode: abort refuses a claim held on another machine, naming both hosts', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(abortableClaim({ host: 'futin@other-box' }), async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-aborting' }), 'abort', '31'),
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /futin@other-box/)
  assert.ok(out.stderr.includes(THIS_HOST), `this machine must be named too: ${out.stderr}`)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

// A claim written before bug-46 recorded no machine, and absence means "the machine was not recorded", never "this one" — so there is nothing here to
// assert same-host on, and the server would refuse the release anyway.
test('API mode: abort refuses a claim that recorded no host at all', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(abortableClaim({ host: undefined }), async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-aborting' }), 'abort', '31'),
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /recorded no machine/)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

test('API mode: abort on a released claim is exit 1 and releases nothing', async () => {
  const { dir } = trackerFixture()
  const routes = abortableClaim()
  routes['/api/items/claim'].body.record.released = { at: new Date().toISOString(), reason: 'stopped', by: 'sess-gone' }

  const { out, requests } = await withApi(routes, async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-aborting' }), 'abort', '31'),
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /not in progress/)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

/* A dead claim needs no abort at all: the next `start` retires it, which is the protocol's own repair. Exit 0, because the caller's goal — the item is
   not blocking anybody — is already true, and a release nobody needed would only add a second record of a session that did nothing. */
test('API mode: abort on a DEAD claim makes no request and says the next start retires it', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(abortableClaim({ heartbeat: new Date(Date.now() - 16 * 60 * 1000).toISOString() }), async (port) =>
    await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-aborting' }), 'abort', '31'),
  )

  assert.equal(out.status, 0)
  assert.match(out.stdout, /start/)
  assert.deepEqual(requests.filter((r) => r.path === '/api/items/release'), [])
})

// The fourth verb that exists only in a tracker project, refused in files mode the way the other three are: the command IS known, it just has no meaning
// against a store on disk — and the files store's equivalent already exists.
test('files mode: abort is a usage refusal naming stop --abandon', async () => {
  const { dir, backlog } = backlogFixture()
  run(dir, 'init')
  fs.writeFileSync(path.join(backlog, 'bugs', 'open', 'bug-1-a.md'), '---\nid: bug-1\ntitle: a\ncreated: 2026-09-01\n---\n\nbody\n')

  const { out, requests } = await withApi({}, async (port) => await runNode(dir, apiEnv(port), 'abort', 'bug-1'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /stop <id> --abandon|stop bug-1 --abandon/)
  assert.deepEqual(requests, [])
})

test('API mode: heartbeat posts the claim-s comment id', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(
    {
      '/api/items/claim': { body: { commentId: 100, record: { v: 1, session: 'A', phase: 'groom', at: '2026-09-18T10:00:00Z', heartbeat: '2026-09-18T10:05:00Z', counters: {} } } },
      '/api/items/heartbeat': { status: 201, body: { commentId: 100, record: {} } },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-beat' }), 'heartbeat', '31'),
  )

  assert.equal(out.status, 0)
  // `session` is not decoration (bug-45): the route refuses a heartbeat from anyone but the holder, and a CLI that sent none could neither be refused nor
  // tell a session whether the claim it is beating is its own.
  assert.deepEqual(requests.find((r) => r.path === '/api/items/heartbeat').body, { project: dir, id: '#31', commentId: 100, session: 'sess-beat' })
})

/* bug-45. This is the case the incident turned on. A session that had already LOST the race ran `heartbeat` as an "is this claim mine?" oracle, got exit 0
   back, and groomed an issue another machine was executing. The answer has to be a refusal, and it has to name both sides — the holder, so the reader knows
   who to wait for, and THIS session, so "is it mine?" is answerable from the one line rather than from a variable nobody prints. */
test('API mode: heartbeat on another session-s claim is refused, naming the holder and this session', async () => {
  const { dir } = trackerFixture()
  const { out, requests } = await withApi(
    {
      '/api/items/claim': { body: { commentId: 100, record: { v: 1, session: 'e33d0074', phase: 'groom', at: '2026-09-18T10:00:00Z', heartbeat: '2026-09-18T10:05:00Z', counters: {} } } },
      '/api/items/heartbeat': {
        status: 409,
        body: { error: 'claim 100 on #31 belongs to session e33d0074', holder: { session: 'e33d0074', heartbeat: '2026-09-18T10:05:00Z', ageMs: 3 * 60 * 1000, commentId: 100 } },
      },
    },
    async (port) => await runNode(dir, apiEnv(port, { CLAUDE_CODE_SESSION_ID: 'sess-mine' }), 'heartbeat', '31'),
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /session e33d0074/)
  assert.match(out.stderr, /heartbeat 3m ago/)
  assert.match(out.stderr, /this session is sess-mine/)
  assert.equal(requests.find((r) => r.path === '/api/items/heartbeat').body.session, 'sess-mine')
})

test('API mode: comment posts the file-s bytes', async () => {
  const { dir } = trackerFixture()
  const file = path.join(dir, 'c.md')
  fs.writeFileSync(file, '## Outcome\n\nit failed\n')

  const { out, requests } = await withApi({ '/api/items/comment': { status: 201, body: { commentId: 101, url: 'https://github.com/futin/x/issues/31#issuecomment-101' } } }, async (port) =>
    await runNode(dir, apiEnv(port), 'comment', '31', '--body', file),
  )

  assert.equal(out.status, 0)
  assert.deepEqual(requests[0].body, { project: dir, id: '#31', body: '## Outcome\n\nit failed\n' })
})

test('API mode: body sends the caller-s ifUpdatedAt, and a 409 says to read it again', async () => {
  const { dir } = trackerFixture()
  const file = path.join(dir, 'b.md')
  fs.writeFileSync(file, '# new body\n')

  const ok = await withApi({ '/api/items/body': { status: 201, body: { id: '#31', updatedAt: '2026-09-18T11:00:00Z' } } }, async (port) =>
    await runNode(dir, apiEnv(port), 'body', '31', '--body', file, '--if-updated-at', '2026-09-18T10:00:00Z'),
  )
  assert.equal(ok.out.status, 0)
  assert.deepEqual(ok.requests[0].body, { project: dir, id: '#31', body: '# new body\n', ifUpdatedAt: '2026-09-18T10:00:00Z' })

  const stale = await withApi({ '/api/items/body': { status: 409, body: { error: 'changed', updatedAt: '2026-09-18T11:30:00Z' } } }, async (port) =>
    await runNode(dir, apiEnv(port), 'body', '31', '--body', file, '--if-updated-at', '2026-09-18T10:00:00Z'),
  )
  assert.equal(stale.out.status, 1)
  assert.match(stale.out.stderr, /show it again/)
  assert.match(stale.out.stderr, /2026-09-18T11:30:00Z/)
})

test('files mode: the three tracker-only verbs are each refused with their own reason', async () => {
  const { dir } = backlogFixture()
  run(dir, 'init')
  const file = path.join(dir, 'x.md')
  fs.writeFileSync(file, 'x\n')

  const heartbeat = run(dir, 'heartbeat', 'bug-1')
  assert.equal(heartbeat.status, 1)
  assert.match(heartbeat.stderr, /files projects have no heartbeat/)

  const comment = run(dir, 'comment', 'bug-1', '--body', file)
  assert.equal(comment.status, 1)
  assert.match(comment.stderr, /files projects have no comment timeline/)

  const body = run(dir, 'body', 'bug-1', '--body', file, '--if-updated-at', 'x')
  assert.equal(body.status, 1)
  assert.match(body.stderr, /files projects have no body route/)
})

// Every request the CLI makes is the shape `SameOriginPostGuard` allows: `application/json`, and NO `Origin` at all — the guard permits an absent origin
// precisely because a non-browser caller cannot forge its way past a check only a browser enforces, and this is that caller.
test('API mode: every request is application/json with no origin header', async () => {
  const { dir } = trackerFixture()
  const file = path.join(dir, 'b.md')
  fs.writeFileSync(file, 'x\n')

  const { requests } = await withApi(
    {
      '/api/items/create': { status: 201, body: { id: '#77', urn: 'gh:futin/x#77', url: 'u', number: 77 } },
      '/api/items/claim': { status: 201, body: { commentId: 1, record: {} } },
    },
    async (port) => {
      await runNode(dir, apiEnv(port), 'new', 'bugs', 't', '--body', file)
      return await runNode(dir, apiEnv(port), 'start', '31', '--as', 'groom')
    },
  )

  assert.ok(requests.length >= 2)
  for (const req of requests) {
    assert.equal(req.headers['content-type'], 'application/json')
    assert.equal(req.headers.origin, undefined)
  }
})

// The other half of "files mode runs today's code byte for byte": a files project must make NO http request at all, on any verb. A fake API that records
// nothing is the only way to state that as a property rather than as an absence of evidence.
test('files mode makes no HTTP request on any verb', async () => {
  const { dir, backlog } = backlogFixture()
  const { requests } = await withApi({}, async (port) => {
    const env = apiEnv(port)
    spawnSync('node', [SCRIPT, 'init'], { encoding: 'utf8', cwd: dir, env })
    spawnSync('node', [SCRIPT, 'new', 'bugs', 'a title'], { encoding: 'utf8', cwd: dir, env })
    fs.writeFileSync(path.join(backlog, 'bugs', 'open', 'bug-1-a-title.md'), '---\nid: bug-1\ntitle: a title\ncreated: 2026-09-01\n---\n\nbody\n')
    spawnSync('node', [SCRIPT, 'board'], { encoding: 'utf8', cwd: dir, env })
    spawnSync('node', [SCRIPT, 'show', 'bug-1'], { encoding: 'utf8', cwd: dir, env })
    spawnSync('node', [SCRIPT, 'start', 'bug-1', '--as', 'groom'], { encoding: 'utf8', cwd: dir, env })
    spawnSync('node', [SCRIPT, 'stop', 'bug-1'], { encoding: 'utf8', cwd: dir, env })
    return spawnSync('node', [SCRIPT, 'move', 'bug-1', 'done'], { encoding: 'utf8', cwd: dir, env })
  })

  assert.deepEqual(requests, [])
})

// `--kind` exists only in API mode, and only because a tracker has nowhere else to put a refactor's flavour: a files capture adds a `kind:` line to the
// frontmatter `new` printed, and on a tracker there is no file to add it to. An unknown value is refused by the SERVER rather than dropped here — GitHub
// creates an unknown label silently on first use, so a dropped one would become a mystery grey label instead of a complaint.
test('API mode: new --kind rides along as the label field', async () => {
  const { dir } = trackerFixture()
  const file = path.join(dir, 'b.md')
  fs.writeFileSync(file, 'x\n')

  const { requests } = await withApi({ '/api/items/create': { status: 201, body: { id: '#77', urn: 'gh:futin/x#77', url: 'u', number: 77 } } }, async (port) =>
    await runNode(dir, apiEnv(port), 'new', 'refactors', 't', '--body', file, '--kind', 'debt'),
  )

  assert.equal(requests[0].body.kind, 'debt')
})

test('files mode: new --kind is refused, the same way --body is', async () => {
  const { dir, backlog } = backlogFixture()
  run(dir, 'init')

  const out = run(dir, 'new', 'refactors', 't', '--kind', 'debt')
  assert.equal(out.status, 1)
  assert.match(out.stderr, /usage: backlog.mjs new/)
  assert.deepEqual(fs.readdirSync(path.join(backlog, 'refactors', 'open')), [])
})

// --- task-46: the four skills' tracker prose ---------------------------------
//
// One section per skill, titled identically so a reader who has found it in one file knows what to look for in the others. Asserted here rather than left to
// review for the same reason every other prose case in this file exists: the skills are the only place a session learns what to do, and a section that
// silently stops being true is a session doing the wrong thing with no error anywhere.

const CAPTURE_SKILL_MD = fileURLToPath(new URL('../../backlog-capture/SKILL.md', import.meta.url))
const BACKLOG_SKILL_MD = fileURLToPath(new URL('./../SKILL.md', import.meta.url))

const TRACKER_SECTION = '## In a tracker project'

test('all four skills carry an identically titled tracker section', () => {
  for (const [name, file] of Object.entries({
    'backlog': BACKLOG_SKILL_MD,
    'backlog-capture': CAPTURE_SKILL_MD,
    'backlog-groom': GROOM_SKILL_MD,
    'backlog-execute': EXECUTE_SKILL_MD,
  })) {
    assert.ok(fs.readFileSync(file, 'utf8').includes(TRACKER_SECTION), `${name}/SKILL.md has no "${TRACKER_SECTION}" section`)
  }
})

// Exit 5 is the one failure mode that is entirely new and entirely outside the tool: no amount of retrying fixes it, and the fix is the same every time. It is
// documented where the tool's exit codes are documented, which is `backlog`'s own SKILL.md.
test('backlog/SKILL.md documents exit 5 and both ways to start the stack', () => {
  const text = fs.readFileSync(BACKLOG_SKILL_MD, 'utf8')
  assert.match(text, /exit `5`/)
  assert.match(text, /pnpm run dev/)
  assert.match(text, /pnpm run docker:up/)
})

// The pair that has to stay in step, and the reason this case is in THIS file rather than only in groom's: the line is printed for a files project and must
// NOT be printed for a tracker one, so the skill has to carry both halves. Asserting only the verbatim line (above) would pass with the tracker exception
// silently dropped, and a session would send somebody looking for a file to `git add` that does not exist.
test('backlog-groom says the on-disk-only line is not printed for a tracker project', () => {
  const text = flatQuoted(GROOM_SKILL_MD)
  assert.ok(text.includes(ON_DISK_LINE), 'the verbatim files-project line is still required')
  assert.ok(
    /`Groomed on disk only` is NOT printed for a tracker project/.test(text),
    'backlog-groom/SKILL.md no longer says the on-disk-only line is skipped for a tracker project',
  )
})

// Groom is the ONLY skill that patches a body (§6.4), and the `--if-updated-at` check is what stops two machines overwriting each other. Both halves asserted:
// the command, and what a refusal means — a session told only the command would retry it with the same stale stamp forever.
test('backlog-groom documents the body patch and what a refusal means', () => {
  const text = flat(GROOM_SKILL_MD)
  assert.match(text, /--if-updated-at/)
  assert.match(text, /re-read and re-apply/i)
})

// Execute's two Outcome paths, both of which change in a tracker project and neither of which may quietly become the other: the archive path moves the item,
// the failure path does not.
test('backlog-execute documents both tracker Outcome paths', () => {
  const text = flat(EXECUTE_SKILL_MD)
  assert.match(text, /move <id> done --outcome/)
  assert.match(text, /comment <id> --body/)
  assert.match(text, /nothing moves/)
})

// The heartbeat, in the two skills that hold a claim for long enough to lose one. `backlog` documents the command; these two have to tell a session to USE it.
test('groom and execute both ask for a heartbeat between long steps', () => {
  for (const [name, file] of Object.entries({ 'backlog-groom': GROOM_SKILL_MD, 'backlog-execute': EXECUTE_SKILL_MD })) {
    assert.match(flat(file), /heartbeat between long steps/i, `${name}/SKILL.md no longer asks for a heartbeat between long steps`)
  }
})

// `--keep-started` is accepted and INERT in API mode: a claim's `at` is permanent, so there is nothing for it to preserve. Asserted rather than assumed
// (the review's gap) — "inert by construction" is a claim about the code, and the flag reaching a branch that behaved differently would be silent.
test('API mode: stop --keep-started is identical to a plain stop', async () => {
  const { dir } = trackerFixture()
  const at = new Date(Date.now() - 90_000).toISOString()
  const routes = {
    '/api/items/claim': {
      body: { commentId: 100, record: { v: 1, session: 'sess-abc', phase: 'groom', at, heartbeat: new Date().toISOString(), counters: { groomElapsed: 10, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } },
    },
    '/api/items/release': { status: 201, body: { commentId: 100, record: {} } },
  }
  const env = { CLAUDE_CODE_SESSION_ID: 'sess-abc' }

  const plain = await withApi(routes, async (port) => await runNode(dir, apiEnv(port, env), 'stop', '31'))
  const kept = await withApi(routes, async (port) => await runNode(dir, apiEnv(port, env), 'stop', '31', '--keep-started'))

  assert.equal(plain.out.status, 0)
  assert.equal(kept.out.status, 0)
  assert.equal(plain.out.stdout, kept.out.stdout)

  const bodyOf = (r) => r.requests.find((q) => q.path === '/api/items/release').body
  const a = bodyOf(plain)
  const b = bodyOf(kept)
  assert.equal(a.reason, b.reason)
  assert.equal(a.commentId, b.commentId)
  // The one number that could differ is the billed total, and it is computed from a clock — so compare it with the same tolerance the plain-stop case uses.
  assert.ok(Math.abs(a.counters.groomElapsed - b.counters.groomElapsed) <= 1)
})

// --- task-47: --runner-fix, the tracker spelling of a frontmatter marker -----
//
// A files capture writes `runner-fix: true` into the item's own frontmatter; a
// tracker item carries a `runner-fix` LABEL and has no file to write a line
// into. So the judgement travels as a flag — on `new` for a promotion, and on
// the one `body` call a groom makes.
//
// `create`'s `runnerFix` field has existed since task-46 with no caller at
// all, which is the carried item that Outcome names. These cases are the
// caller.

test('API mode: new --runner-fix sends runnerFix, and the key is absent without it', async () => {
  const { dir } = trackerFixture()
  const bodyFile = path.join(dir, 'body.md')
  fs.writeFileSync(bodyFile, '## Goal\n\nrepair the runner\n')
  const routes = { '/api/items/create': { status: 201, body: { id: '#77', urn: 'gh:futin/x#77', url: 'u', number: 77 } } }

  const marked = await withApi(routes, async (port) => await runNode(dir, apiEnv(port), 'new', 'tasks', 't', '--body', bodyFile, '--runner-fix'))
  assert.equal(marked.out.status, 0, marked.out.stderr)
  assert.equal(marked.requests[0].body.runnerFix, true)

  // Absent rather than `false`: the route reads it with a strict `=== true`,
  // so sending `false` on every unmarked capture would put a field in every
  // request body for a fact the absence already states.
  const plain = await withApi(routes, async (port) => await runNode(dir, apiEnv(port), 'new', 'tasks', 't', '--body', bodyFile))
  assert.equal(plain.out.status, 0, plain.out.stderr)
  assert.equal('runnerFix' in plain.requests[0].body, false)
})

/* Its own sentence rather than the usage block `--body` and `--kind` take, and
   the difference is which mistake was made: those two are a caller using the
   tracker CALL SHAPE, where showing both shapes side by side is the answer,
   while this is a caller who knows what they want and is asking the wrong
   writer for it. */
test('files mode: new --runner-fix is refused by name, and makes no request', async () => {
  const { dir, backlog } = backlogFixture()
  init(backlog)
  const { out, requests } = await withApi({}, async (port) => await runNode(dir, apiEnv(port), 'new', 'tasks', 'a title', '--runner-fix'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /frontmatter line/)
  assert.deepEqual(requests, [])
})

test('API mode: body --no-runner-fix sends false, and the two flags together are a usage error', async () => {
  const { dir } = trackerFixture()
  const bodyFile = path.join(dir, 'body.md')
  fs.writeFileSync(bodyFile, '## Plan\n\nreal work\n')
  const routes = { '/api/items/body': { status: 201, body: { id: '#7', updatedAt: '2026-09-19T10:00:00Z' } } }

  const off = await withApi(routes, async (port) =>
    await runNode(dir, apiEnv(port), 'body', '7', '--body', bodyFile, '--if-updated-at', '2026-09-19T09:00:00Z', '--no-runner-fix'),
  )
  assert.equal(off.out.status, 0, off.out.stderr)
  assert.equal(off.requests[0].body.runnerFix, false)

  // Opposite instructions about one label. Picking one for the caller would
  // silently add or remove the marker that decides whether an item hoists to
  // the front of a run's queue — so it is refused, before the store is even
  // resolved, with nothing sent.
  const both = await withApi(routes, async (port) =>
    await runNode(dir, apiEnv(port), 'body', '7', '--body', bodyFile, '--if-updated-at', 'x', '--runner-fix', '--no-runner-fix'),
  )
  assert.equal(both.out.status, 1)
  assert.match(both.out.stderr, /opposites/)
  assert.deepEqual(both.requests, [])
})

/* The third state, and the one a re-groom depends on: a body patch that says
   nothing about the marker must leave it exactly as it is. */
test('API mode: body with neither flag sends no runnerFix key at all', async () => {
  const { dir } = trackerFixture()
  const bodyFile = path.join(dir, 'body.md')
  fs.writeFileSync(bodyFile, '## Plan\n\nreal work\n')

  const { out, requests } = await withApi(
    { '/api/items/body': { status: 201, body: { id: '#7', updatedAt: '2026-09-19T10:00:00Z' } } },
    async (port) => await runNode(dir, apiEnv(port), 'body', '7', '--body', bodyFile, '--if-updated-at', 'x'),
  )

  assert.equal(out.status, 0, out.stderr)
  assert.equal('runnerFix' in requests[0].body, false)
})

// --- task-47: the prose halves of the phase-4a seams -------------------------
//
// Read as text and never imported, for the reason the `Groomed on disk only`
// pair above gives: each of these is one rule that two files have to agree on,
// and a suite reading only one half cannot catch them drifting apart.

test('backlog-execute names the outcome path and forbids the five item writes under an orchestrator run', () => {
  const text = flat(EXECUTE_SKILL_MD)
  // The clause the orchestrator's own dispatch line writes, so the two files
  // agree on one spelling of the marker.
  assert.match(text, /outcome <absolute path>/)
  for (const verb of ['`start`', '`stop`', '`heartbeat`', '`move`', '`comment`']) {
    assert.ok(text.includes(verb), `backlog-execute no longer names ${verb} among the writes a tracker run forbids`)
  }
  assert.match(text, /Never run `start`, `stop`, `heartbeat`, `move` or `comment` on the item/)
})

test('the orchestrator dispatch line and backlog-execute agree on the outcome clause', () => {
  // One seam, two files: the driver writes `outcome <dir>/outcomes/<n>.md`
  // into the prompt, and the session reads the path back out of it.
  const orch = flat(fileURLToPath(new URL('../../backlog-orchestrate/SKILL.md', import.meta.url)))
  assert.match(orch, /outcome <dir>\/outcomes\/<n>\.md/)
  assert.match(flat(EXECUTE_SKILL_MD), /\[orchestrator-run <runId> item <n> of <m> branch backlog\/<n> outcome <absolute path>/)
})

test('the reviewer is told a tracker item file is a snapshot under the run-state directory', () => {
  const text = flat(fileURLToPath(new URL('../../../agents/backlog-reviewer.md', import.meta.url)))
  assert.match(text, /SNAPSHOT under the run-state directory/)
  assert.match(text, /<dir>\/items\/<n>\.md/)
})

test('backlog-groom names --runner-fix as the tracker spelling of the marker', () => {
  const text = flat(GROOM_SKILL_MD)
  assert.match(text, /--runner-fix/)
  assert.match(text, /--no-runner-fix/)
  // The third state, stated where a groomer will read it.
  assert.match(text, /Passing neither leaves the label exactly as it is/)
})

// --- task-50: import github --------------------------------------------------
// `import` is the one command that moves a project between sources: it writes the marker, creates one issue per item file through the local API, rewrites every
// cross-reference, and only then deletes the files. Two properties shape every case below, and both are §8.1's.
//
// First, a refusal leaves the project BYTE-IDENTICAL — no marker, no issue forms, no request. Between the marker write and the deletion the project is in a
// state where the board reads the tracker and the files are ignored, so a refusal that got half way there would hide every item in the store with nothing to
// say why. Each refusal case therefore snapshots the whole tree and compares it afterwards, rather than asserting on the one file the check is about.
//
// Second, the checks run cheap-and-local first and the API probe LAST, because the probe is the only one with an effect on somebody else. The cases assert that
// ordering the only way it can be asserted from outside: a fixture that is wrong in one way reports THAT way, never the next check's sentence.

/** `---\n<front>\n---\n<body>` — the fixture's item files are hand-shaped strings, never produced by the tool under test. */
function itemText(front, body) {
  return `---\n${front.trim()}\n---\n\n${body.trim()}\n`
}

/**
 * A committed files-mode store with a GitHub origin, which is the shape every `import` precondition reads.
 *
 * `push` writes `refs/remotes/origin/main` by hand with `update-ref`: `git branch -r --contains HEAD` reads remote-tracking refs out of this repository and
 * nothing else, so a real one can be made without a network and without a second repository. `push: false` is how the "HEAD is not on any origin/* branch"
 * refusal is reached — the interesting case, since the truncation link in every truncated issue body pins `backlog/` files at that exact commit.
 */
function importFixture({ originUrl = 'git@github.com:futin/x.git', items = [], push = true } = {}) {
  const { dir, backlog } = backlogFixture()
  fs.mkdirSync(backlog, { recursive: true })
  fs.writeFileSync(path.join(backlog, 'README.md'), '# Backlog\n')
  for (const item of items) {
    const abs = path.join(backlog, item.relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, item.text)
  }
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t']
  assert.equal(spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' }).status, 0)
  const committed = spawnSync('git', ['-C', dir, ...ident, 'commit', '-qm', 'seed'], { encoding: 'utf8' })
  assert.equal(committed.status, 0, committed.stderr)
  if (originUrl !== null) {
    assert.equal(spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl], { encoding: 'utf8' }).status, 0)
  }
  const sha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  if (push) {
    assert.equal(spawnSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha], { encoding: 'utf8' }).status, 0)
  }
  return { dir, backlog, sha }
}

/** Every file under a fixture except git's own, as path → contents, so a refusal can be proved to have written nothing. */
function treeSnapshot(dir) {
  const seen = {}
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (rel === '' && entry.name === '.git') continue
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(abs, entry.name), next)
      else seen[next] = fs.readFileSync(path.join(abs, entry.name), 'utf8')
    }
  }
  walk(dir, '')
  return seen
}

const TASK_ONE = { relPath: 'tasks/open/task-1-one.md', text: itemText('id: task-1\ntitle: One\ncreated: 2026-08-01', '## Plan\n\nDo the thing.') }

test('import with no sub-command prints its own usage', () => {
  const { dir } = importFixture({ items: [TASK_ONE] })
  const before = treeSnapshot(dir)

  const out = run(dir, 'import')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /usage: backlog\.mjs import github/)
  assert.deepEqual(treeSnapshot(dir), before)
})

test('import names a platform this tool cannot write to rather than assuming github', () => {
  const { dir } = importFixture({ items: [TASK_ONE] })

  const out = run(dir, 'import', 'gitlab', 'a/b')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /usage: backlog\.mjs import github/)
})

test('import refuses a linked worktree, naming itself and the project root', () => {
  const { dir } = importFixture({ items: [TASK_ONE] })
  const worktree = path.join(dir, 'wt')
  const added = spawnSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'side', worktree], { encoding: 'utf8' })
  assert.equal(added.status, 0, added.stderr)

  const out = run(worktree, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /linked git worktree/)
  assert.match(out.stderr, /import writes the project's own committed source marker/)
  assert.ok(out.stderr.includes(dir), `the refusal must name the project root:\n${out.stderr}`)
})

test('import refuses an explicit files marker rather than overwriting it', () => {
  const { dir, backlog } = importFixture({
    items: [TASK_ONE, { relPath: 'source.json', text: '{ "kind": "files" }\n' }],
  })
  const before = treeSnapshot(dir)

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /delete it by hand/)
  assert.ok(out.stderr.includes(path.join(backlog, 'source.json')))
  assert.deepEqual(treeSnapshot(dir), before)
})

test('import refuses a tracker project that has no item files left', () => {
  const { dir } = importFixture({ items: [{ relPath: 'source.json', text: JSON.stringify({ kind: 'github', repo: 'futin/x' }, null, 2) + '\n' }] })
  const before = treeSnapshot(dir)

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /already tracker-backed/)
  assert.match(out.stderr, /nothing to import/)
  assert.deepEqual(treeSnapshot(dir), before)
})

test('import sends an empty store to connect, which is the command for it', () => {
  const { dir } = importFixture({ items: [] })
  const before = treeSnapshot(dir)

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /connect github/)
  assert.deepEqual(treeSnapshot(dir), before)
})

test('import with no origin and no positional names its own call shape', () => {
  const { dir } = importFixture({ items: [TASK_ONE], originUrl: null })

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  // The sentence names THIS command: a caller told to run `connect github <owner>/<repo>` here would connect the populated store this command exists to move.
  assert.match(out.stderr, /import github <owner>\/<repo>/)
})

test('import refuses a dirty backlog and prints the porcelain lines it read', () => {
  const { dir, backlog } = importFixture({ items: [TASK_ONE] })
  fs.appendFileSync(path.join(backlog, TASK_ONE.relPath), 'one more line\n')

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /uncommitted changes/)
  assert.match(out.stderr, / M backlog\/tasks\/open\/task-1-one\.md/)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
})

test('import refuses an item file git is not tracking, even when the status is clean', () => {
  const { dir, backlog } = importFixture({ items: [TASK_ONE] })
  // Excluded rather than merely new, because `status --porcelain` would otherwise catch it first and report the dirty-tree refusal: the case under test is the
  // one where git is silent and the file would still be deleted at the end with no commit anywhere carrying it.
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'backlog/bugs/open/bug-9-*.md\n')
  fs.mkdirSync(path.join(backlog, 'bugs', 'open'), { recursive: true })
  fs.writeFileSync(path.join(backlog, 'bugs/open/bug-9-nine.md'), itemText('id: bug-9\ntitle: Nine\ncreated: 2026-08-02', '## Fix\n\nfix it'))

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /not tracked by git/)
  assert.match(out.stderr, /bugs\/open\/bug-9-nine\.md/)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
})

test('import refuses a HEAD that is on no origin branch, naming the sha the truncation link would pin', () => {
  const { dir, backlog, sha } = importFixture({ items: [TASK_ONE], push: false })

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /not on any origin\/\* branch/)
  assert.ok(out.stderr.includes(sha.slice(0, 7)), `the refusal must name the sha7:\n${out.stderr}`)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
})

test('import refuses an open item somebody is working, and ignores a started stamp on a done one', () => {
  const inProgress = { relPath: 'tasks/open/task-2-two.md', text: itemText('id: task-2\ntitle: Two\ncreated: 2026-08-03\nstarted: 2026-09-20T10:00:00Z', '## Plan\n\nwork') }
  const { dir, backlog } = importFixture({ items: [TASK_ONE, inProgress] })

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /in progress/)
  assert.match(out.stderr, /task-2/)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)

  // The same stamp on a `done/` item is history, not a session: that item is closed and nobody is holding it.
  const done = importFixture({
    items: [TASK_ONE, { relPath: 'tasks/done/task-3-three.md', text: itemText('id: task-3\ntitle: Three\ncreated: 2026-08-04\nstarted: 2026-09-01T10:00:00Z', '## Plan\n\nwork\n\n## Outcome\n\ndone') }],
  })
  const past = runWithEnv(done.dir, { ...process.env, BM_API_PORT: '1' }, 'import', 'github')
  assert.equal(past.status, 5, past.stderr)
})

test('import stops at the probe when the stack is not running, and writes no marker', () => {
  const { dir, backlog } = importFixture({ items: [TASK_ONE] })

  const out = runWithEnv(dir, { ...process.env, BM_API_PORT: '1' }, 'import', 'github')

  assert.equal(out.status, 5)
  assert.match(out.stderr, /the backlog-manager API is not running/)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)
  assert.equal(fs.existsSync(path.join(dir, '.github', 'ISSUE_TEMPLATE', 'bug.yml')), false)
})

test('import refuses a malformed item file by absolute path', () => {
  const { dir, backlog } = importFixture({ items: [TASK_ONE, { relPath: 'bugs/open/bug-4-four.md', text: 'no frontmatter here\n' }] })

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.ok(out.stderr.includes(path.join(backlog, 'bugs/open/bug-4-four.md')), `the refusal must name the file:\n${out.stderr}`)
})

test('import refuses a refactor kind the tracker has no label for, and accepts debt', () => {
  const bad = { relPath: 'refactors/open/ref-4-x.md', text: itemText('id: ref-4\ntitle: X\ncreated: 2026-08-05\nkind: cleanup', 'why') }
  const { dir, backlog } = importFixture({ items: [TASK_ONE, bad] })

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /ref-4/)
  assert.match(out.stderr, /cleanup/)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), false)

  // `debt` is one of the two the server maps to a label, so the same file with that value reaches the probe.
  const ok = importFixture({ items: [TASK_ONE, { relPath: 'refactors/open/ref-4-x.md', text: itemText('id: ref-4\ntitle: X\ncreated: 2026-08-05\nkind: debt', 'why') }] })
  const reached = runWithEnv(ok.dir, { ...process.env, BM_API_PORT: '1' }, 'import', 'github')
  assert.equal(reached.status, 5, reached.stderr)
})

/**
 * The routes an import talks to, answering the shapes the real server answers.
 *
 * Issue numbers start at `4` and count up per `create`, so a case can name `#4` without first reading the response: the numbers a real repository hands out are
 * arbitrary, and a fake that mirrored that would make every assertion below a lookup. The fake also HOLDS each issue's Markdown, because pass 2 reads a body
 * back before patching it — `GET /api/items/body` answers what the `create` (or the last patch) recorded, which is the only way a cross-link rewrite can be
 * asserted end to end.
 */
function githubRoutes({ projectPath = '', repo = 'futin/x', seed = [], firstNumber = 4, overrides = {} } = {}) {
  const bodies = new Map()
  const numbers = []
  const statuses = new Map()
  let created = 0
  let claims = 0
  const numberOf = (ref) => Number(String(ref).replace(/^.*#/, ''))
  // Issues a PREVIOUS import created, for the resume cases: the fake holds their bodies, footers included, because the footer is what a resumed run reads to
  // decide which items already exist.
  for (const issue of seed) {
    numbers.push(issue.number)
    bodies.set(issue.number, issue.body)
    statuses.set(issue.number, issue.status ?? 'open')
  }
  const routes = {
    '/api/items': () => ({
      body: {
        items: numbers.map((n) =>
          apiItem({ id: `#${n}`, projectPath, path: `gh:${repo}#${n}`, updated: `2026-09-21T10:00:0${n}Z`, status: statuses.get(n) ?? 'open' }),
        ),
        errors: [],
      },
    }),
    '/api/items/create': (body) => {
      const number = firstNumber + created
      created += 1
      numbers.push(number)
      bodies.set(number, body.body)
      return { body: { id: `#${number}`, urn: `gh:${repo}#${number}`, url: `https://github.com/${repo}/issues/${number}`, number } }
    },
    '/api/items/claim': () => ({ body: { commentId: 900 + ++claims, record: {} } }),
    '/api/items/release': () => ({ body: { ok: true } }),
    '/api/items/state': () => ({ body: { ok: true, url: `https://github.com/${repo}/issues/1` } }),
    '/api/items/body': (body, { method, query }) => {
      if (method === 'GET') return { body: bodies.get(numberOf(query.path)) ?? '' }
      bodies.set(numberOf(body.id), body.body)
      return { body: { ok: true, updatedAt: '2026-09-21T10:00:00Z' } }
    },
    ...overrides,
  }
  return { routes, bodies, numbers }
}

const posts = (requests, route) => requests.filter((r) => r.method === 'POST' && r.path === `/api/items/${route}`)

/** The four items every pass-1 and pass-2 case works from: two open, one done with counters and an Outcome, one rejected. */
const importItems = () => [
  {
    relPath: 'tasks/open/task-1-one.md',
    text: itemText('id: task-1\ntitle: one\ncreated: 2026-01-01\ntags: x, y\nrunner-fix: true', 'Blocked on bug-2 and task-99.\n\n```\nsee task-3\n```'),
  },
  { relPath: 'bugs/open/bug-2-two.md', text: itemText('id: bug-2\ntitle: two\ncreated: 2026-02-01\nfrom: task-1', '## Cause\n\nc\n\n## Fix\n\nf') },
  {
    relPath: 'tasks/done/task-3-three.md',
    text: itemText('id: task-3\ntitle: three\ncreated: 2026-01-15\nfrom: idea-9\nexecute-elapsed: 120\nexecute-tokens: 3400', '## Plan\n\nplan text\n\n## Outcome\n\nShipped it.'),
  },
  { relPath: 'out-of-scope/oos-5-five.md', text: itemText('id: oos-5\ntitle: five\ncreated: 2025-12-01', 'no ids here') },
]

test('import writes the marker and the forms before its first request, and the probe is that first request', async () => {
  const { dir, backlog } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8'), JSON.stringify({ kind: 'github', repo: 'futin/x' }, null, 2) + '\n')
  for (const form of FORM_FILES) assert.equal(fs.existsSync(formPath(dir, form)), true, `${form} was not written`)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].path, '/api/items')
  assert.equal(requests[1].method, 'POST')
  assert.equal(requests[1].path, '/api/items/create')
})

test('import --no-forms writes the marker and no issue forms', async () => {
  const { dir, backlog } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github', '--no-forms'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), true)
  for (const form of FORM_FILES) assert.equal(fs.existsSync(formPath(dir, form)), false, `${form} was written under --no-forms`)
})

test('import creates issues open-first by created date, then done, then rejected', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(
    posts(requests, 'create').map((r) => r.body.title),
    ['one', 'two', 'three', 'five'],
  )
})

test('import composes each create from the frontmatter the tracker has a field for, and puts the rest in the footer', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const creates = posts(requests, 'create')
  const [one, two, , five] = creates.map((r) => r.body)

  assert.equal(one.section, 'tasks')
  assert.equal(one.runnerFix, true)
  assert.equal('from' in one, false, 'a create never carries from — the link is a body line pass 2 writes')
  assert.equal('kind' in one, false)
  assert.ok(one.body.endsWith('<!-- bm:imported from=task-1 created=2026-01-01 tags=x,y -->\n_Imported from backlog/tasks/open/task-1-one.md_'), one.body.slice(-200))
  assert.equal('runnerFix' in two, false)
  assert.equal(five.section, 'out-of-scope')
  // The label set is the closed nine the poller bootstraps, so free-text tags reach GitHub in the footer or not at all.
  for (const create of creates) assert.equal('labels' in create.body, false)
  const tagsOutsideFooter = one.body.replace(/<!-- bm:imported[^]*$/, '')
  assert.equal(/\bx, y\b/.test(tagsOutsideFooter), false, 'the tags line must not survive anywhere but the footer')
})

test('import lifts a done item’s Outcome out of the body and sends it as the closing comment', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const three = posts(requests, 'create')[2].body
  assert.equal(three.body.includes('Shipped it.'), false, 'the Outcome belongs in the closing comment, not the issue body')
  const states = posts(requests, 'state')
  assert.equal(states.length, 1, 'exactly one state request: done closes with a comment, rejected was closed by create, open is not closed')
  assert.deepEqual(states[0].body, { project: dir, id: '#6', status: 'done', outcome: 'Shipped it.' })
})

test('import bills an item’s counters as a released claim, before the issue is closed', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const claims = posts(requests, 'claim')
  const releases = posts(requests, 'release')
  assert.equal(claims.length, 1, 'only the item with counters gets a claim')
  assert.equal(releases.length, 1)
  assert.equal(claims[0].body.id, '#6')
  assert.equal(claims[0].body.phase, 'execute')
  assert.match(claims[0].body.session, /^import-\d{4}-/)
  assert.equal(releases[0].body.session, claims[0].body.session)
  assert.equal(releases[0].body.reason, 'imported')
  assert.equal(releases[0].body.commentId, 901)
  assert.deepEqual(releases[0].body.counters, { groomElapsed: 0, executeElapsed: 120, groomTokens: 0, executeTokens: 3400 })
  // `claim` refuses a closed issue, so the pair has to land before the close — asserted as an ORDER, since both requests succeed either way.
  const writes = requests.filter((r) => r.method === 'POST').map((r) => r.path.replace('/api/items/', ''))
  assert.deepEqual(writes.slice(2, 7), ['create', 'claim', 'release', 'state', 'create'])
})

test('import cuts an over-cap body at a heading, links the rest at HEAD, and keeps the footer last', async () => {
  const big = '-'.repeat(500) + '\n\n## A\n' + 'a'.repeat(30000) + '\n\n## B\n' + 'b'.repeat(30000) + '\n\n## C\nCCC-MARKER\n' + 'c'.repeat(10000)
  const { dir, sha } = importFixture({ items: [{ relPath: 'tasks/open/task-7-big.md', text: itemText('id: task-7\ntitle: big\ncreated: 2026-03-01', big) }] })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const body = posts(requests, 'create')[0].body.body
  assert.ok(body.length <= IMPORT_BODY_CAP, `body is ${body.length} characters`)
  assert.ok(body.includes('## B'))
  assert.equal(body.includes('CCC-MARKER'), false)
  assert.ok(body.includes(`_Truncated. Full text: https://github.com/futin/x/blob/${sha}/backlog/tasks/open/task-7-big.md_`), 'the truncation link pins files at HEAD')
  assert.ok(body.endsWith('_Imported from backlog/tasks/open/task-7-big.md_'), 'the footer is appended after the trailer so it always survives')
  assert.match(out.stdout, /task-7 → #4 \(truncated\)/)
})

test('import prints the id map as it goes, one line per item', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const lines = out.stdout.split('\n').filter((line) => line.includes(' → #'))
  assert.deepEqual(lines, ['task-1 → #4', 'bug-2 → #5', 'task-3 → #6', 'oos-5 → #7'])
})

test('import stops at the first refused request, keeping the marker and every item file', async () => {
  const { dir, backlog } = importFixture({ items: importItems() })
  const before = treeSnapshot(dir)
  const { routes } = githubRoutes({ projectPath: dir })
  let creates = 0
  const created = routes['/api/items/create']
  routes['/api/items/create'] = (body, req) => {
    creates += 1
    return creates === 2 ? { status: 502, body: { error: 'GitHub answered 502' } } : created(body, req)
  }

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /import stopped at bug-2: GitHub answered 502/)
  // The marker is the one thing a failure leaves behind, and that is spec §8.2: it had to be written before the first create, and a re-run resumes from it.
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), true)
  for (const [rel, text] of Object.entries(before)) {
    if (rel.endsWith('.md')) assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), text, `${rel} changed`)
  }
  const last = requests[requests.length - 1]
  assert.equal(last.path, '/api/items/create', 'nothing ran after the refused create')
})

test('import names the reset time the server sent when a request is rate-limited', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })
  routes['/api/items/create'] = () => ({ status: 429, body: { error: 'GitHub rate limit', resetAt: '2026-09-21T11:05:00Z' } })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /import stopped at task-1: GitHub rate limit — retry after 2026-09-21T11:05:00Z/)
  assert.equal(posts(requests, 'create').length, 1)
  assert.equal(fs.existsSync(path.join(dir, 'backlog', 'tasks', 'open', 'task-1-one.md')), true)
})

test('the import pace defaults to one request a second', () => {
  // A source guard, the shape this repo already uses for the tailnet port: the default cannot be asserted behaviourally without making every case above ten
  // seconds slower, and the value is what keeps a whole-store import inside GitHub's secondary rate limits.
  const source = fs.readFileSync(SCRIPT, 'utf8')
  const line = source.split('\n').find((l) => l.includes('BM_IMPORT_PACE_MS') && l.includes('1000'))
  assert.ok(line !== undefined, 'no line reads BM_IMPORT_PACE_MS with a default of 1000')
})

test('import rewrites every cross-reference it can resolve, and leaves the ones it cannot', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const patch = posts(requests, 'body').find((r) => r.body.id === '#4')
  assert.ok(patch !== undefined, 'task-1 cites two ids and must be patched')
  assert.match(patch.body.body, /Blocked on #5 and task-99\./)
  assert.match(patch.body.body, /```\nsee #6\n```/)
  assert.equal(patch.body.ifUpdatedAt, '2026-09-21T10:00:04Z')
  assert.equal('runnerFix' in patch.body, false, 'a pass-2 patch says nothing about the runner-fix label')
  // The footer's readable line carries the item's FILENAME, which contains an id; a rewrite that reached it would rename a file nobody can look up.
  assert.ok(patch.body.body.endsWith('_Imported from backlog/tasks/open/task-1-one.md_'), patch.body.body.slice(-120))
})

test('import turns a from: key into a body line, linked when the source was imported too', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const bodies = posts(requests, 'body')
  assert.ok(bodies.find((r) => r.body.id === '#5').body.body.startsWith('_From #4._\n\n'))
  // idea-9 is not in this store, so the fact survives and only the link is missing.
  assert.ok(bodies.find((r) => r.body.id === '#6').body.body.startsWith('_From idea-9._\n\n'))
})

test('import patches nothing for an item whose body did not change', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(
    posts(requests, 'body').some((r) => r.body.id === '#7'),
    false,
    'oos-5 cites no id and has no from — a patch would be a no-op edit on somebody’s timeline',
  )
})

test('import deletes the item files last, keeps the store’s own furniture, and prints what to commit', async () => {
  const { dir, backlog } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(backlogItemFiles(backlog), [])
  assert.equal(fs.existsSync(path.join(backlog, 'README.md')), true)
  assert.equal(fs.existsSync(path.join(backlog, 'source.json')), true)
  assert.deepEqual(commitList(out.stdout), [
    'backlog/source.json',
    ...FORM_FILES.map((file) => `.github/ISSUE_TEMPLATE/${file}`),
    'backlog/tasks/open/task-1-one.md',
    'backlog/bugs/open/bug-2-two.md',
    'backlog/tasks/done/task-3-three.md',
    'backlog/out-of-scope/oos-5-five.md',
  ])
  assert.match(out.stdout, /imported 4 item\(s\) into github futin\/x/)
})

test('a pass-2 failure deletes nothing and names the old id', async () => {
  const { dir } = importFixture({ items: importItems() })
  const before = treeSnapshot(dir)
  const { routes } = githubRoutes({ projectPath: dir })
  const answer = routes['/api/items/body']
  routes['/api/items/body'] = (body, req) =>
    req.method === 'GET' ? answer(body, req) : { status: 409, body: { error: 'changed since read', updatedAt: '2026-09-21T12:00:00Z' } }

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /import stopped at task-1: changed since read/)
  for (const [rel, text] of Object.entries(before)) {
    if (rel.endsWith('.md')) assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), text, `${rel} changed`)
  }
})

test('pass 2 makes no write but body patches', async () => {
  const { dir } = importFixture({ items: importItems() })
  const { routes } = githubRoutes({ projectPath: dir })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const lastCreate = requests.map((r) => r.path).lastIndexOf('/api/items/create')
  for (const request of requests.slice(lastCreate + 1)) {
    const isWrite = request.method === 'POST'
    assert.equal(isWrite && request.path !== '/api/items/body' && request.path !== '/api/items/state', false, `${request.method} ${request.path} ran after pass 1`)
  }
})

/**
 * A store whose marker is already down and whose item files are still there: an import that stopped part way through, which is the state resume is for.
 *
 * The marker is written AFTER the seed commit by default, untracked, because that is exactly what a stopped run leaves: `import` writes it before the first
 * `create` and nothing commits it. The fixture used to commit it with the items, and so never saw a resume refuse on the tool's own file (#218).
 * `marker: 'staged'` is the same file after a `git add`; `marker: 'committed'` is the old shape, a marker some commit already carries.
 */
function resumeFixture({ marker = 'untracked' } = {}) {
  const markerItem = { relPath: 'source.json', text: JSON.stringify({ kind: 'github', repo: 'futin/x' }, null, 2) + '\n' }
  if (marker === 'committed') return importFixture({ items: [...importItems(), markerItem] })
  const fixture = importFixture({ items: importItems() })
  fs.writeFileSync(path.join(fixture.backlog, markerItem.relPath), markerItem.text)
  if (marker === 'staged') {
    assert.equal(spawnSync('git', ['-C', fixture.dir, 'add', 'backlog/source.json'], { encoding: 'utf8' }).status, 0)
  }
  return fixture
}

const seededBody = (id, relPath, text) => `${text}\n\n<!-- bm:imported from=${id} created=2026-01-01 -->\n_Imported from backlog/${relPath}_`

const RESUME_SEED = [
  { number: 4, status: 'open', body: seededBody('task-1', 'tasks/open/task-1-one.md', 'Blocked on bug-2 and task-99.') },
  // Its close failed last time: the issue exists and is still open, while the file is under `done/`.
  { number: 6, status: 'open', body: seededBody('task-3', 'tasks/done/task-3-three.md', '## Plan\n\nplan text') },
]

test('import resumes from the bm:imported footers and creates only what is missing', async () => {
  const { dir } = resumeFixture()
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /resuming: 2 of 4 item\(s\) already imported/)
  assert.deepEqual(
    posts(requests, 'create').map((r) => r.body.title),
    ['two', 'five'],
  )
})

test('import repairs a done item whose close failed, and claims nothing a second time', async () => {
  const { dir } = resumeFixture()
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const states = posts(requests, 'state')
  assert.equal(states.length, 1)
  assert.equal(states[0].body.id, '#6')
  assert.equal(states[0].body.outcome, 'Shipped it.')
  // The counters were billed by the run that created the issue; a second claim would double them, and a duplicate is worse than a missing one.
  assert.equal(posts(requests, 'claim').length, 0)
  assert.equal(posts(requests, 'release').length, 0)
})

test('import’s second pass patches issues an earlier run created', async () => {
  const { dir } = resumeFixture()
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  const patch = posts(requests, 'body').find((r) => r.body.id === '#4')
  assert.ok(patch !== undefined, 'the issue an earlier run created still cites an old id')
  assert.match(patch.body.body, /Blocked on #8 and task-99\./)
})

// A pass 2 that stopped part way leaves some issues already patched, `_From_` line included. The resume re-reads every body, and prepending unconditionally
// gave each of those issues a second `_From_` line per re-run.
test('a resumed second pass leaves an already-patched from: line alone', async () => {
  const { dir } = resumeFixture()
  const seed = [RESUME_SEED[0], { number: 6, status: 'closed', body: seededBody('task-3', 'tasks/done/task-3-three.md', '_From idea-9._\n\n## Plan\n\nplan text') }]
  const { routes } = githubRoutes({ projectPath: dir, seed, firstNumber: 8 })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(posts(requests, 'body').find((r) => r.body.id === '#6'), undefined, 'an unchanged body is not patched')
})

test('import leaves the marker exactly as it found it, and honours --no-forms on a resume', async () => {
  const { dir, backlog } = resumeFixture()
  const before = fs.readFileSync(path.join(backlog, 'source.json'), 'utf8')
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github', '--no-forms'))

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8'), before)
  for (const form of FORM_FILES) assert.equal(fs.existsSync(formPath(dir, form)), false)
})

// #218: the marker a stopped run wrote is the tool's own state, not an operator's change, so the dirty check exempts it on a resume — and only while no commit
// carries it (`??` or `A `). Everything else in `backlog/` still refuses, and the exempt line is left out of the message too.
test('import resumes over the untracked marker a stopped run left behind', async () => {
  const { dir, backlog } = resumeFixture({ marker: 'untracked' })
  const before = fs.readFileSync(path.join(backlog, 'source.json'), 'utf8')
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /resuming: 2 of 4 item\(s\) already imported/)
  assert.equal(fs.readFileSync(path.join(backlog, 'source.json'), 'utf8'), before)
})

test('import resumes over a staged-but-uncommitted marker', async () => {
  const { dir } = resumeFixture({ marker: 'staged' })
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /resuming: 2 of 4 item\(s\) already imported/)
})

test('a resume still refuses a modified item file, and does not list its own marker as the problem', () => {
  const { dir, backlog } = resumeFixture({ marker: 'untracked' })
  fs.appendFileSync(path.join(backlog, 'tasks/open/task-1-one.md'), 'one more line\n')

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /uncommitted changes/)
  assert.match(out.stderr, / M backlog\/tasks\/open\/task-1-one\.md/)
  assert.doesNotMatch(out.stderr, /backlog\/source\.json/)
})

test('a resume still refuses a committed files marker hand-edited to github', () => {
  const { dir, backlog } = importFixture({ items: [...importItems(), { relPath: 'source.json', text: JSON.stringify({ kind: 'files' }) + '\n' }] })
  fs.writeFileSync(path.join(backlog, 'source.json'), JSON.stringify({ kind: 'github', repo: 'futin/x' }) + '\n')

  const out = run(dir, 'import', 'github')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /uncommitted changes/)
  assert.match(out.stderr, / M backlog\/source\.json/)
})

test('import refuses a repo that disagrees with the marker, before any request', async () => {
  const { dir } = resumeFixture()
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out, requests } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github', 'futin/other'))

  assert.equal(out.status, 1)
  assert.match(out.stderr, /names futin\/x, not futin\/other/)
  assert.equal(requests.length, 0)
})

test('a resumed import still deletes every item file last', async () => {
  const { dir, backlog } = resumeFixture()
  const { routes } = githubRoutes({ projectPath: dir, seed: RESUME_SEED, firstNumber: 8 })

  const { out } = await withApi(routes, (port) => runNode(dir, apiEnv(port, { BM_IMPORT_PACE_MS: '0' }), 'import', 'github'))

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(backlogItemFiles(backlog), [])
  assert.deepEqual(commitList(out.stdout), [
    'backlog/source.json',
    ...FORM_FILES.map((file) => `.github/ISSUE_TEMPLATE/${file}`),
    'backlog/tasks/open/task-1-one.md',
    'backlog/bugs/open/bug-2-two.md',
    'backlog/tasks/done/task-3-three.md',
    'backlog/out-of-scope/oos-5-five.md',
  ])
})

// --- import's prose (task-50) ---------------------------------------------
//
// `import` is a one-shot, irreversible-by-hand migration: it deletes a project's whole item store once the issues exist. A session reaching for it reads
// SKILL.md, not this file, so the command line has to be there in a copyable fence — and the two sentences that said phase 5 did not exist yet have to be
// gone, because both of them send a reader looking for a command that is now right there.
const REPO_CLAUDE_MD = fileURLToPath(new URL('../../../CLAUDE.md', import.meta.url))

test('backlog/SKILL.md documents the import command in a copyable fence', () => {
  const text = fs.readFileSync(BACKLOG_SKILL_MD, 'utf8')
  const fences = text.split('```').filter((_, i) => i % 2 === 1)
  assert.ok(
    fences.some((fence) => fence.includes('import github [owner/repo] [--no-forms]')),
    'backlog/SKILL.md does not carry the import usage line inside a fenced block',
  )
})

test('neither backlog/SKILL.md nor backlog.mjs still calls import a later phase', () => {
  assert.ok(!fs.readFileSync(BACKLOG_SKILL_MD, 'utf8').includes("later phase's job"), 'backlog/SKILL.md still defers the import to a later phase')
  assert.ok(!fs.readFileSync(CLI_SOURCES['backlog.mjs'], 'utf8').includes('not built yet'), "backlog.mjs's connect refusal still says import is not built yet")
})

// The invariant bullet is where a session working anywhere in this repo meets the two rules that make the migration safe: the order the marker and the files
// are written in, and what makes a re-run resume instead of duplicating.
test('CLAUDE.md carries the import invariant bullet', () => {
  const bullets = fs
    .readFileSync(REPO_CLAUDE_MD, 'utf8')
    .split('\n- ')
    .filter((bullet) => bullet.includes('marker first') && bullet.includes('bm:imported'))
  assert.equal(bullets.length, 1, 'CLAUDE.md has no single invariant bullet naming both `marker first` and `bm:imported`')
})
