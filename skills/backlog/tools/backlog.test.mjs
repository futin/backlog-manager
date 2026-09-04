import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BacklogError, SECTIONS, resolveRoot, slugify, init, parseFrontmatter, renderFrontmatter, nextId, readItem, listOpen, registerProject, unregisterProject, registryFile, linkedWorktreeInfo, registryRoot, startItem, stopItem, transcriptFiles, sumFreshTokens, sessionTokensSince } from './backlog.mjs'

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
