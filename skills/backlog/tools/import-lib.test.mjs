// Task 1 of task-50 (tracker phase 5): the table cases for `import-lib.mjs`, the pure half of `backlog.mjs import`.
//
// Every export here is a text transformation with no filesystem and no network, which is why it is a module of its own and why these cases are a table: a
// truncation rule, an id-rewrite boundary and an outcome split are all decided by exactly where a character sits, and the only honest way to pin one is to
// state the input and the expected output side by side. The CLI cases in `backlog.test.mjs` prove the requests; these prove the strings inside them.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IMPORT_BODY_CAP, splitOutcome, renderImportFooter, parseImportFooter, blobLink, fitBody, rewriteOldIds, importOrder, countersOf } from './import-lib.mjs'

// --- splitOutcome ------------------------------------------------------------
// The Outcome leaves the body because on a tracker the outcome is the CLOSING COMMENT (spec §8.3 step 1), so an imported done item reads like a natively
// closed one rather than one carrying its own epitaph in the description.

test('splitOutcome lifts a middle ## Outcome section out of the body', () => {
  const { rest, outcome } = splitOutcome('# T\n\n## Plan\nx\n\n## Outcome\nShipped.\n\n## Notes\ny\n')
  assert.equal(rest, '# T\n\n## Plan\nx\n\n## Notes\ny\n')
  assert.equal(outcome, 'Shipped.')
})

test('splitOutcome handles an Outcome that is the last section', () => {
  const { rest, outcome } = splitOutcome('## Plan\nx\n\n## Outcome\nDone\nand more\n')
  assert.equal(outcome, 'Done\nand more')
  assert.equal(rest, '## Plan\nx\n')
})

test('splitOutcome leaves a body with no Outcome heading identical', () => {
  const body = '## Plan\nx\n\nsome prose about task-1\n'
  const { rest, outcome } = splitOutcome(body)
  assert.equal(rest, body)
  assert.equal(outcome, '')
})

test('splitOutcome reads an empty Outcome section as an empty outcome', () => {
  const { rest, outcome } = splitOutcome('## Outcome\n\n')
  assert.equal(outcome, '')
  assert.equal(rest, '')
})

test('splitOutcome ignores a level-three ### Outcome', () => {
  const body = '## Plan\nx\n\n### Outcome\nnot the heading\n'
  const { rest, outcome } = splitOutcome(body)
  assert.equal(rest, body)
  assert.equal(outcome, '')
})

// --- renderImportFooter / parseImportFooter ----------------------------------
// Two lines doing two different jobs: the HTML comment is the idempotency key a resume reads (§8.6) and the readable line is for a human scrolling the issue.
// Keeping them separate is what lets the parser match only the marker, so a body that merely mentions an old id is never mistaken for an imported one.

test('renderImportFooter renders the marker comment and the readable line', () => {
  assert.equal(
    renderImportFooter({ id: 'task-1', created: '2026-08-30', tags: ['a', 'b'], relPath: 'tasks/open/task-1-foo.md' }),
    '<!-- bm:imported from=task-1 created=2026-08-30 tags=a,b -->\n_Imported from backlog/tasks/open/task-1-foo.md_',
  )
})

test('renderImportFooter omits the tags key entirely when there are no tags', () => {
  const footer = renderImportFooter({ id: 'bug-2', created: '2026-01-01', tags: [], relPath: 'bugs/open/bug-2-two.md' })
  assert.ok(!footer.includes('tags='), footer)
  assert.equal(footer, '<!-- bm:imported from=bug-2 created=2026-01-01 -->\n_Imported from backlog/bugs/open/bug-2-two.md_')
})

test('parseImportFooter reads the marker and never the readable line', () => {
  const footer = renderImportFooter({ id: 'task-1', created: '2026-08-30', tags: ['a', 'b'], relPath: 'tasks/open/task-1-foo.md' })
  assert.equal(parseImportFooter(footer), 'task-1')
  assert.equal(parseImportFooter('_Imported from backlog/tasks/open/task-1-foo.md_'), null)
  assert.equal(parseImportFooter(''), null)
})

test('parseImportFooter answers the marker id, not the first old id the body mentions', () => {
  const footer = renderImportFooter({ id: 'task-1', created: '2026-08-30', tags: [], relPath: 'tasks/open/task-1-foo.md' })
  assert.equal(parseImportFooter(`## Plan\n\nBlocked on bug-3.\n\n${footer}`), 'task-1')
})

// This repo's own task-50 is the plan for `import`, and its body quotes the marker it specifies — `<!-- bm:imported from=<id> … -->` — well above its real
// footer. Read from the top, that quote won: every resume mapped `<id>` instead of `task-50`, missed the issue it had already made, and created task-50 again.
test('parseImportFooter answers the LAST marker, so a body quoting the footer format is not mistaken for it', () => {
  const footer = renderImportFooter({ id: 'task-50', created: '2026-09-20', tags: [], relPath: 'tasks/done/task-50-import.md' })
  const body = `## Plan\n\n6. **Resume**: rebuild the map from \`<!-- bm:imported from=<id> … -->\` footers.\n\n${footer}`
  assert.equal(parseImportFooter(body), 'task-50')
})

// --- blobLink / fitBody ------------------------------------------------------
// GitHub caps a body at 65,536 characters and the survey found a real item over it (guide-manager task-1, 69,883 bytes). The cut is at a `## ` boundary so
// what survives is whole sections rather than a sentence stopping mid-word, and the trailer links the file at HEAD — which is what makes "HEAD is on an
// origin/* ref" a precondition (§8.1).

const LINK = 'https://github.com/futin/x/blob/abc123/backlog/tasks/open/task-1-foo.md'

test('blobLink pins the file under backlog/ at a sha', () => {
  assert.equal(blobLink('futin/x', 'abc123', 'tasks/open/task-1-foo.md'), LINK)
})

test('fitBody leaves a text of exactly cap unchanged', () => {
  const text = 'x'.repeat(500)
  const fitted = fitBody(text, 500, LINK)
  assert.equal(fitted.text, text)
  assert.equal(fitted.truncated, false)
})

test('fitBody keeps whole ## sections from the top and appends the trailer', () => {
  // 400 characters each, heading line included, so two of them plus the trailer fit under 900 and three do not.
  const section = (heading) => `## ${heading}\n` + heading.toLowerCase().repeat(395)
  const a = section('A')
  const b = section('B')
  const c = section('C')
  assert.equal(a.length, 400)
  const fitted = fitBody([a, b, c].join('\n'), 900, LINK)
  assert.equal(fitted.truncated, true)
  assert.ok(fitted.text.includes('## A'), fitted.text)
  assert.ok(fitted.text.includes('## B'), fitted.text)
  assert.ok(!fitted.text.includes('## C'), 'the third section must not survive')
  assert.ok(!fitted.text.includes('ccc'), 'the third section’s text must not survive')
  assert.equal(fitted.text.endsWith(`_Truncated. Full text: ${LINK}_`), true)
  assert.ok(fitted.text.length <= 900, `${fitted.text.length} > 900`)
})

test('fitBody answers the trailer alone when the preamble itself is over cap', () => {
  const fitted = fitBody('p'.repeat(1000), 500, LINK)
  assert.equal(fitted.truncated, true)
  assert.ok(fitted.text.startsWith('_Truncated. Full text:'), fitted.text)
  assert.equal(fitted.text, `_Truncated. Full text: ${LINK}_`)
})

test('fitBody cuts a 70,000-character body to under IMPORT_BODY_CAP', () => {
  const fitted = fitBody('z'.repeat(70000), IMPORT_BODY_CAP, LINK)
  assert.equal(fitted.truncated, true)
  assert.ok(fitted.text.length <= IMPORT_BODY_CAP, `${fitted.text.length} > ${IMPORT_BODY_CAP}`)
})

// --- rewriteOldIds -----------------------------------------------------------
// Pass 2's whole job (§8.4). The lookbehind and lookahead are the load-bearing part: without them the readable footer line and the truncation link — both of
// which carry an item's FILENAME — would be rewritten into nonsense, and `sub-task-1` would become `sub-#4`.

const MAP = new Map([['task-1', 4], ['idea-12', 7]])

test('rewriteOldIds replaces a known id wherever it stands alone', () => {
  assert.equal(rewriteOldIds('see task-1 and (task-1).', MAP), 'see #4 and (#4).')
})

test('rewriteOldIds keeps the punctuation around an id', () => {
  assert.equal(rewriteOldIds('task-1:', MAP), '#4:')
  assert.equal(rewriteOldIds('task-1,', MAP), '#4,')
  assert.equal(rewriteOldIds('`task-1`', MAP), '`#4`')
})

test('rewriteOldIds leaves an id inside a longer word, a slug or a path alone', () => {
  assert.equal(rewriteOldIds('sub-task-1', MAP), 'sub-task-1')
  assert.equal(rewriteOldIds('idea-12-tracker-backed', MAP), 'idea-12-tracker-backed')
  assert.equal(rewriteOldIds('backlog/tasks/open/task-1-foo.md', MAP), 'backlog/tasks/open/task-1-foo.md')
})

test('rewriteOldIds leaves an unknown id and a differently-cased one alone', () => {
  assert.equal(rewriteOldIds('task-99', MAP), 'task-99')
  assert.equal(rewriteOldIds('Task-1', MAP), 'Task-1')
})

test('rewriteOldIds rewrites inside a code fence too', () => {
  assert.equal(rewriteOldIds('```\ntask-1\n```', MAP), '```\n#4\n```')
})

test('rewriteOldIds rewrites every known id in one line', () => {
  assert.equal(rewriteOldIds('idea-12 → task-1', MAP), '#7 → #4')
})

// The footer's `from=<id>` is the idempotency key, and it carries a bare old id — word-bounded on both sides, exactly the shape pass 2 rewrites. Before `=`
// was excluded, pass 2 turned `from=task-1` into `from=#4`, so every issue it had already patched lost its key: the next resume recognised none of them and
// created all 72 again (this repo's own import, #146–#217).
test('rewriteOldIds leaves the footer marker alone, so a patched issue is still recognised on resume', () => {
  const footer = renderImportFooter({ id: 'task-1', created: '2026-08-30', tags: [], relPath: 'tasks/open/task-1-foo.md' })
  const patched = rewriteOldIds(`Blocked on idea-12.\n\n${footer}`, MAP)
  assert.equal(patched, `Blocked on #7.\n\n${footer}`)
  assert.equal(parseImportFooter(patched), 'task-1')
})

// --- importOrder -------------------------------------------------------------
// Open items first, in `created` order, so the issue numbers a reader sees most — the open queue — run in the same order the board does. Status rank beats
// `created` because an open item is the one somebody may be about to work.

const item = (id, section, status, created) => ({ id, section, status, created })

test('importOrder ranks status above created', () => {
  const ordered = importOrder([
    item('bug-1', 'bugs', 'done', '2026-01-01'),
    item('task-2', 'tasks', 'open', '2026-03-01'),
    item('bug-3', 'bugs', 'open', '2026-02-01'),
    item('oos-4', 'out-of-scope', 'out-of-scope', '2025-01-01'),
  ])
  assert.deepEqual(ordered.map((it) => it.id), ['bug-3', 'task-2', 'bug-1', 'oos-4'])
})

test('importOrder breaks a created tie by section then by numeric id', () => {
  const ordered = importOrder([
    item('task-1', 'tasks', 'open', '2026-01-01'),
    item('bug-10', 'bugs', 'open', '2026-01-01'),
    item('bug-2', 'bugs', 'open', '2026-01-01'),
  ])
  assert.deepEqual(ordered.map((it) => it.id), ['bug-2', 'bug-10', 'task-1'])
})

// --- countersOf --------------------------------------------------------------
// The four permanent counters, which ride a synthetic released claim rather than a footer (decision §14.13). `null` for an item that has none is what keeps
// `import` from posting a claim comment on every issue it creates.

test('countersOf answers null when every counter is absent or zero', () => {
  assert.equal(countersOf({}), null)
  assert.equal(countersOf({ 'groom-elapsed': '0', 'execute-tokens': '0' }), null)
})

test('countersOf fills every key, absent ones as zero', () => {
  assert.deepEqual(countersOf({ 'execute-elapsed': '120', 'execute-tokens': '3400' }), {
    groomElapsed: 0,
    executeElapsed: 120,
    groomTokens: 0,
    executeTokens: 3400,
  })
})

test('countersOf throws naming the key when a counter is not an integer', () => {
  assert.throws(() => countersOf({ 'groom-elapsed': 'abc' }), /groom-elapsed/)
})
