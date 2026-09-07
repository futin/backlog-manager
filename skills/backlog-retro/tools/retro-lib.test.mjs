// Module-level cases for backlog-retro's lib/. These live at the `tools/`
// level rather than beside the modules they cover because `pnpm run
// test:skills` globs `skills/*/tools/*.test.mjs` — a file under `tools/lib/`
// would never be run, which is the same as not existing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  claudeProjectKey, decodeProjectDir, projectDir, readRegistryNames, retroHome,
} from './lib/paths.mjs'

// --- Task 1: paths -------------------------------------------------------

test('claudeProjectKey mirrors Claude Code’s own project directory key', () => {
  // Both spellings observed on this machine: a plain project root, and a
  // linked worktree under `.worktrees/`, whose leading dot becomes a second
  // dash — which is why the key is a replacement of BOTH `/` and `.` and
  // not a `split('/').join('-')`.
  assert.equal(
    claudeProjectKey('/Users/a/Documents/custom-projects/backlog-manager'),
    '-Users-a-Documents-custom-projects-backlog-manager',
  )
  assert.equal(claudeProjectKey('/Users/a/x/.worktrees/bug-26'), '-Users-a-x--worktrees-bug-26')
})

test('projectDir and decodeProjectDir round-trip a project path', () => {
  const dir = projectDir('/h', '/Users/a/p')
  assert.ok(dir.endsWith('%2FUsers%2Fa%2Fp'), dir)
  assert.equal(decodeProjectDir(path.basename(dir)), '/Users/a/p')
})

test('retroHome honours $BM_RETRO_HOME and falls back under the home directory', (t) => {
  const before = process.env.BM_RETRO_HOME
  t.after(() => {
    if (before === undefined) delete process.env.BM_RETRO_HOME
    else process.env.BM_RETRO_HOME = before
  })
  process.env.BM_RETRO_HOME = '/tmp/retro-here'
  assert.equal(retroHome(), '/tmp/retro-here')
  delete process.env.BM_RETRO_HOME
  assert.equal(retroHome(), path.join(os.homedir(), '.backlog-manager', 'retro'))
})

test('readRegistryNames maps every registered path to its name, and never throws', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-reg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'registry.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      projects: [
        { name: 'alpha', path: '/Users/a/alpha', createdAt: '2026-01-01T00:00:00.000Z' },
        { name: 'beta', path: '/Users/a/beta', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
    }),
  )
  const names = readRegistryNames(file)
  assert.equal(names.size, 2)
  assert.equal(names.get('/Users/a/alpha'), 'alpha')
  assert.equal(names.get('/Users/a/beta'), 'beta')
  // A registry that is missing, or garbage, must not stop a sweep: the names
  // are decoration beside a path the sweep already knows.
  assert.equal(readRegistryNames(path.join(dir, 'nope.json')).size, 0)
  fs.writeFileSync(path.join(dir, 'bad.json'), 'not json {')
  assert.equal(readRegistryNames(path.join(dir, 'bad.json')).size, 0)
})

// --- Task 2: run files ---------------------------------------------------

const T0 = Date.parse('2026-09-01T10:00:00Z')
const at = (min) => new Date(T0 + min * 60000).toISOString()

test('stageSpans differences consecutive stamps and keeps queue wait out of the pipeline', async () => {
  const { stageSpans } = await import('./lib/run-files.mjs')
  const { stages, queueWaitMin } = stageSpans({
    pending: at(0),
    preflight: at(2),
    dispatched: at(2.5),
    inspecting: at(22.5),
    reviewing: at(23),
    fixing: at(29),
    verifying: at(51),
    merging: at(53),
    merged: at(53.2),
  })
  // `pending` is queue wait, never pipeline time, and the TERMINAL stamp
  // opens no span at all — so nine stamps yield seven from-stage keys.
  assert.equal(queueWaitMin, 2)
  assert.deepEqual(
    Object.keys(stages).sort(),
    ['dispatched', 'fixing', 'inspecting', 'merging', 'preflight', 'reviewing', 'verifying'],
  )
  assert.equal(stages.dispatched, 20)
  assert.equal(stages.fixing, 22)
  assert.equal(stages.merging, 0.2)
})

test('stageSpans sorts by time, not by key order', async () => {
  const { stageSpans } = await import('./lib/run-files.mjs')
  const { stages, queueWaitMin } = stageSpans({
    merged: at(53.2),
    fixing: at(29),
    pending: at(0),
    preflight: at(2),
    verifying: at(51),
  })
  assert.equal(queueWaitMin, 2)
  assert.equal(stages.preflight, 27)
  assert.equal(stages.fixing, 22)
  assert.equal(stages.verifying, 2.2)
})

test('verificationFailures strips ANSI and extracts files, test names and error lines', async () => {
  const { verificationFailures } = await import('./lib/run-files.mjs')
  const tail = [
    '\x1b[31mFAIL\x1b[0m test/agents-origin-guard.test.ts',
    '  ● the agents POST guard › 403s an Origin: null POST to plan',
    'sh: jest: command not found',
  ].join('\n')
  assert.deepEqual(verificationFailures(tail), {
    files: ['test/agents-origin-guard.test.ts'],
    tests: ['the agents POST guard › 403s an Origin: null POST to plan'],
    errors: ['sh: jest: command not found'],
  })
})

// --- Task 3: session logs ------------------------------------------------

// A stream-json transcript in the shape `claude -p --output-format
// stream-json` actually writes, mirrored from this machine's own
// `logs/bug-10.jsonl`: hook events, an `init` event carrying the session
// id, one `assistant` event per turn with `message.usage`, and a final
// `result` event.
function writeLog(file, { contexts = [], result, sessionId = 'sess-x' } = {}) {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, cwd: '/tmp' }),
  ]
  for (const total of contexts) {
    // Split so cache_read + cache_creation + input adds up to the sample —
    // the three fields the tool sums for "context at this turn".
    const input = 2
    const cacheCreation = 1000
    const cacheRead = total - input - cacheCreation
    lines.push(JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: {
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: cacheCreation,
          cache_read_input_tokens: cacheRead,
          output_tokens: 10,
        },
      },
    }))
  }
  if (result) lines.push(JSON.stringify({ type: 'result', session_id: sessionId, ...result }))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

test('classifyLog reads the dispatch slot out of the file name', async () => {
  const { classifyLog } = await import('./lib/sessions.mjs')
  assert.deepEqual(classifyLog('bug-26.jsonl'), { itemId: 'bug-26', kind: 'execute', loop: null })
  assert.deepEqual(classifyLog('task-6-fix-2.jsonl'), { itemId: 'task-6', kind: 'fix', loop: 2 })
  assert.deepEqual(classifyLog('bug-4-retry-1.jsonl'), { itemId: 'bug-4', kind: 'retry', loop: 1 })
  // The sidecars beside a transcript are not transcripts.
  assert.equal(classifyLog('bug-26.err'), null)
  assert.equal(classifyLog('bug-26.pid'), null)
  assert.equal(classifyLog('notes.jsonl'), null)
})

test('readSession reads the result event, the context envelope and the session id', async (t) => {
  const { readSession } = await import('./lib/sessions.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = writeLog(path.join(dir, 'bug-26.jsonl'), {
    contexts: [60000, 55000, 70000, 40000, 120000],
    sessionId: 'sess-26',
    result: {
      total_cost_usd: 5.4632055,
      num_turns: 66,
      duration_ms: 824747,
      usage: {
        input_tokens: 126,
        cache_creation_input_tokens: 129875,
        cache_read_input_tokens: 6880201,
        output_tokens: 28949,
      },
      modelUsage: { 'claude-opus-5[1m]': { costUSD: 5.46 } },
      permission_denials: [{}, {}],
      is_error: false,
      result: 'done',
    },
  })
  const s = readSession(file, { itemId: 'bug-26', kind: 'execute', loop: null })
  assert.equal(s.result.costUsd, 5.4632055)
  assert.equal(s.result.turns, 66)
  assert.equal(s.result.durationMs, 824747)
  assert.equal(s.result.denials, 2)
  assert.equal(s.result.model, 'claude-opus-5[1m]')
  assert.equal(s.result.terminated, 'ok')
  assert.equal(s.result.cacheRead, 6880201)
  // `floor` is the smallest of the FIRST THREE samples — the session's
  // standing context once it has loaded, before the work grew it. The
  // fourth sample is DELIBERATELY lower than all three: a compaction drops
  // the window mid-session, and a floor taken over the whole run would
  // report that trough as the standing toll it never was.
  assert.deepEqual(s.context, { floor: 55000, peak: 120000, messages: 5 })
  assert.equal(s.sessionId, 'sess-26')
})

test('readSession separates a spend limit from any other error', async (t) => {
  const { readSession } = await import('./lib/sessions.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const limit = writeLog(path.join(dir, 'a-1.jsonl'), {
    contexts: [10],
    result: { is_error: true, result: "You've hit your individual spend limit for this period." },
  })
  assert.equal(readSession(limit, {}).result.terminated, 'spend-limit')
  const other = writeLog(path.join(dir, 'a-2.jsonl'), {
    contexts: [10],
    result: { is_error: true, result: 'API error 500' },
  })
  assert.equal(readSession(other, {}).result.terminated, 'error')
})

test('readSession reports a killed session as result: null but still measures its context', async (t) => {
  const { readSession } = await import('./lib/sessions.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = writeLog(path.join(dir, 'a-3.jsonl'), { contexts: [10000, 20000, 30000] })
  const s = readSession(file, {})
  assert.equal(s.result, null)
  assert.deepEqual(s.context, { floor: 10000, peak: 30000, messages: 3 })
  // The id still comes off the init event — a killed session is still a
  // session somebody can go and read.
  assert.equal(s.sessionId, 'sess-x')
})

test('readSession skips a malformed line rather than giving up on the file', async (t) => {
  const { readSession } = await import('./lib/sessions.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'a-4.jsonl')
  writeLog(file, { contexts: [1000], result: { total_cost_usd: 1, num_turns: 2, is_error: false } })
  fs.writeFileSync(file, `not json at all {\n${fs.readFileSync(file, 'utf8')}`)
  assert.equal(readSession(file, {}).result.costUsd, 1)
})

// --- Task 4: reviews and totals -----------------------------------------

test('readReviews pulls the verdict, the pass number and the two excerpts', async (t) => {
  const { readReviews } = await import('./lib/reviews.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-rev-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true })
  const write = (name, body) => fs.writeFileSync(path.join(dir, 'reviews', name), body)

  write('bug-21-2.md', [
    '# Review — bug-21 (backlog/bug-21)',
    '',
    'verdict: fix',
    '',
    '## Critical',
    '',
    'None.',
    '',
    '## Important',
    '',
    '- x:1 — the comment says the opposite',
    '',
    '## Minor',
    '',
    '- y',
    '',
  ].join('\n'))
  write('bug-22-1.md', ['# Review', '', 'verdict: approve', '', '## Critical', '', 'None.', ''].join('\n'))
  write('bug-23-1.md', ['# Review', '', '## Critical', '', 'None.', ''].join('\n'))
  write('notes.md', 'ignored')

  const reviews = readReviews(dir, '/P')
  assert.equal(reviews.length, 3)

  const fixed = reviews.find((r) => r.itemId === 'bug-21')
  assert.equal(fixed.pass, 2)
  assert.equal(fixed.verdict, 'fix')
  // A section reading `None.` is EMPTY, not the literal word — otherwise
  // every approving review would look like it carried a finding.
  assert.equal(fixed.critical, '')
  assert.equal(fixed.important, '- x:1 — the comment says the opposite')
  // The key is the shape labels.json uses: `<project>/reviews/<file>`.
  assert.equal(fixed.file, '/P/reviews/bug-21-2.md')

  // Excerpts exist for a `fix` verdict alone — there is nothing to label on
  // an approving review, and carrying its (empty) sections would put a row
  // in front of the session that has no judgement to make.
  const approved = reviews.find((r) => r.itemId === 'bug-22')
  assert.equal(approved.verdict, 'approve')
  assert.ok(!('critical' in approved))
  assert.ok(!('important' in approved))

  assert.equal(reviews.find((r) => r.itemId === 'bug-23').verdict, null)
})

test('readVerifyStatus reads the exit code the run recorded, or null', async (t) => {
  const { readVerifyStatus } = await import('./lib/reviews.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-ver-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'verify'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'verify', 'bug-1.status'), '0\n')
  fs.writeFileSync(path.join(dir, 'verify', 'bug-2.status'), '1')
  assert.equal(readVerifyStatus(dir, 'bug-1'), 0)
  assert.equal(readVerifyStatus(dir, 'bug-2'), 1)
  assert.equal(readVerifyStatus(dir, 'bug-3'), null)
})

test('median and p90 follow one convention everywhere, and are null on nothing', async () => {
  const { median, p90 } = await import('./lib/totals.mjs')
  // Even length: the mean of the two middle values, so two 30-minute items
  // and two 60-minute ones report 45 rather than an arbitrary one of them.
  assert.equal(median([30, 60]), 45)
  assert.equal(median([1, 2, 3]), 2)
  // Nearest rank at ceil(0.9n) - 1: with two values that is the larger.
  assert.equal(p90([30, 60]), 60)
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9)
  // `null`, never `0` — "nothing was measured" and "it measured zero" are
  // different facts and a report that conflates them is lying.
  assert.equal(median([]), null)
  assert.equal(p90([]), null)
})

// --- Task 5: rates and the driver transcript -----------------------------

const TEST_RATES = { cacheRead: 0.5e-6, cacheCreation: 10e-6, output: 24.8e-6, input: 82e-6 }

// Eight token mixes whose four columns are mutually non-proportional — if
// `input` also followed `i + 1` it would duplicate the `cacheRead` column
// and the normal equations would be singular, which is a different test.
function syntheticSessions(n) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    const t = {
      cacheRead: 1e6 * (i + 1),
      cacheCreation: 1e5 * ((i % 3) + 1),
      output: 1e4 * ((i % 5) + 1),
      input: 100 * ((i % 4) + 1),
    }
    const costUsd = t.cacheRead * TEST_RATES.cacheRead
      + t.cacheCreation * TEST_RATES.cacheCreation
      + t.output * TEST_RATES.output
      + t.input * TEST_RATES.input
    out.push({ result: { costUsd, ...t } })
  }
  return out
}

test('fitRates recovers known per-token rates from eight measured sessions', async () => {
  const { fitRates } = await import('./lib/rates.mjs')
  const rates = fitRates(syntheticSessions(8))
  assert.ok(rates, 'expected a fit')
  for (const key of ['cacheRead', 'cacheCreation', 'output', 'input']) {
    const rel = Math.abs(rates[key] - TEST_RATES[key]) / TEST_RATES[key]
    assert.ok(rel < 1e-6, `${key}: ${rates[key]} vs ${TEST_RATES[key]}`)
  }
  assert.equal(rates.sessions, 8)
  assert.ok(rates.maxResidualUsd < 1e-6, String(rates.maxResidualUsd))
})

test('fitRates refuses to fit too little, or a singular system', async () => {
  const { fitRates } = await import('./lib/rates.mjs')
  // Seven is one short of the floor: four unknowns fitted from seven points
  // is a number, but not one worth putting a dollar sign on.
  assert.equal(fitRates(syntheticSessions(7)), null)
  // Eight identical mixes carry one row of information, not eight.
  const identical = Array.from({ length: 8 }, () => ({
    result: { costUsd: 1, cacheRead: 1e6, cacheCreation: 1e5, output: 1e4, input: 100 },
  }))
  assert.equal(fitRates(identical), null)
})

test('priceTokens multiplies each token count by its own rate', async () => {
  const { priceTokens } = await import('./lib/rates.mjs')
  assert.equal(
    priceTokens({ cacheRead: 2e6, cacheCreation: 0, output: 0, input: 0 }, TEST_RATES),
    1.0,
  )
})

test('readDriver measures the orchestrating session from its own transcript', async (t) => {
  const { readDriver } = await import('./lib/driver.mjs')
  const { claudeProjectKey } = await import('./lib/paths.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-cc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = '/Users/a/p'
  const dir = path.join(root, claudeProjectKey(project))
  fs.mkdirSync(dir, { recursive: true })

  const samples = [
    { cache_read_input_tokens: 90000, cache_creation_input_tokens: 9990, input_tokens: 10, output_tokens: 1000 },
    { cache_read_input_tokens: 100000, cache_creation_input_tokens: 19990, input_tokens: 10, output_tokens: 1000 },
    { cache_read_input_tokens: 110000, cache_creation_input_tokens: 29990, input_tokens: 10, output_tokens: 1000 },
  ]
  const lines = samples.map((usage) => JSON.stringify({ type: 'assistant', message: { usage } }))
  lines.push(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Agent', input: {} }, { type: 'tool_use', name: 'Agent', input: {} }] },
  }))
  lines.push(JSON.stringify({
    type: 'user',
    message: { content: 'task done <subagent_tokens>150000</subagent_tokens>' },
  }))
  fs.writeFileSync(path.join(dir, 'd1.jsonl'), `${lines.join('\n')}\n`)

  const d = readDriver({ runId: 'R1', project, driverSessionId: 'd1' }, root, TEST_RATES)
  assert.equal(d.turns, 3)
  assert.deepEqual(d.context, { avg: 120000, max: 140000 })
  assert.deepEqual(d.tokens, { input: 30, output: 3000, cacheRead: 300000, cacheCreation: 59970 })
  // Two Agent dispatches, one of which reported its tokens: the other is
  // UNMEASURED, never zero — a subagent that ran and did not report still
  // cost money.
  assert.deepEqual(d.subagents, { count: 2, tokens: 150000, unmeasured: 1 })
  assert.equal(d.estimated, true)
  const { priceTokens } = await import('./lib/rates.mjs')
  assert.equal(d.estimatedCostUsd, priceTokens(d.tokens, TEST_RATES))
})

test('readDriver reports each way a transcript is missing with its own reason', async (t) => {
  const { readDriver } = await import('./lib/driver.mjs')
  const { claudeProjectKey } = await import('./lib/paths.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-cc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = '/Users/a/p'

  // Every run before bug-19's driver lease reads this one.
  assert.deepEqual(
    readDriver({ runId: 'R0', project, driverSessionId: null }, root, TEST_RATES),
    { runId: 'R0', project, driver: null, reason: 'no-lease' },
  )
  assert.equal(readDriver({ runId: 'R1', project, driverSessionId: 'gone' }, root, TEST_RATES).reason, 'not-found')

  const dir = path.join(root, claudeProjectKey(project))
  fs.mkdirSync(path.join(dir, 'dir.jsonl'), { recursive: true })
  assert.equal(readDriver({ runId: 'R2', project, driverSessionId: 'dir' }, root, TEST_RATES).reason, 'unreadable')
})

test('readDriver leaves the cost unpriced when there is no fit', async (t) => {
  const { readDriver } = await import('./lib/driver.mjs')
  const { claudeProjectKey } = await import('./lib/paths.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-cc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = '/Users/a/p'
  const dir = path.join(root, claudeProjectKey(project))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'd2.jsonl'), `${JSON.stringify({
    type: 'assistant',
    message: { usage: { cache_read_input_tokens: 10, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 1 } },
  })}\n`)
  const d = readDriver({ runId: 'R1', project, driverSessionId: 'd2' }, root, null)
  // Tokens are still measured; only the dollars are unknown.
  assert.equal(d.tokens.cacheRead, 10)
  assert.equal(d.estimatedCostUsd, null)
})

// --- Task 6: deltas ------------------------------------------------------

// A record as `record` writes one: the sweep verbatim under `sweep`, the
// session's judgments under `labels`, and who wrote it.
function writeRecord(dir, generatedAt, totals, labels) {
  fs.mkdirSync(dir, { recursive: true })
  const stem = generatedAt.replace(/[:.]/g, '-')
  const file = path.join(dir, `${stem}.json`)
  fs.writeFileSync(file, JSON.stringify({ sweep: { generatedAt, totals }, labels, recordedBy: 't' }))
  return file
}

const RECORD_TOTALS = {
  runs: { total: 1 },
  items: { total: 2, dispatched: 2 },
  merged: 1,
  costUsd: { measured: 10 },
  costPerMerged: { measured: 10 },
  fixLoops: { itemsAffected: 1 },
  verdicts: { byPass: { 1: { approve: 1, fix: 1 } } },
  itemWallMin: { median: 20 },
  queueWaitMin: { median: 3 },
}

test('newestRecord picks the latest stem, and null on an empty home', async (t) => {
  const { newestRecord } = await import('./lib/totals.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-rec-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(newestRecord(dir), null)
  writeRecord(dir, '2026-09-06T21:03:30.697Z', RECORD_TOTALS, { reviews: {}, candidates: [] })
  writeRecord(dir, '2026-09-07T09:00:00.000Z', RECORD_TOTALS, { reviews: {}, candidates: [] })
  // Stems are filesystem-safe ISO stamps, so lexical order IS time order —
  // no parsing, and no clock skew between the name and the content.
  assert.ok(newestRecord(dir).file.endsWith('2026-09-07T09-00-00-000Z.json'))
  assert.equal(newestRecord(path.join(dir, 'nope')), null)
})

test('computePrevious differences every headline measure against the record', async (t) => {
  const { computePrevious, newestRecord } = await import('./lib/totals.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-rec-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  writeRecord(dir, '2026-09-06T21:03:30.697Z', RECORD_TOTALS, {
    reviews: { 'P/reviews/B-1.md': 'drift' },
    candidates: [{ title: 'x', kind: 'bug', project: 'P', status: 'declined' }],
  })
  const now = {
    totals: {
      runs: { total: 1 },
      items: { total: 3, dispatched: 3 },
      merged: 2,
      costUsd: { measured: 15 },
      costPerMerged: { measured: 7.5 },
      fixLoops: { itemsAffected: 1 },
      verdicts: { byPass: { 1: { approve: 1, fix: 1 } } },
      itemWallMin: { median: 45 },
      queueWaitMin: { median: 5 },
    },
  }
  const previous = computePrevious(now, newestRecord(dir))
  assert.deepEqual(previous.deltas.merged, { then: 1, now: 2, delta: 1 })
  assert.equal(previous.deltas.costMeasured.delta, 5)
  assert.equal(previous.deltas.fixLoopRate.then, 0.5)
  // One label out of one is the whole of that record's judgments.
  assert.equal(previous.labelRates.drift, 1)
  assert.equal(previous.labelRates.defect, 0)
  assert.equal(previous.candidates[0].status, 'declined')
  assert.equal(previous.generatedAt, '2026-09-06T21:03:30.697Z')
})

test('computePrevious leaves a delta null when either side is unmeasured', async (t) => {
  const { computePrevious, newestRecord } = await import('./lib/totals.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-rec-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  writeRecord(dir, '2026-09-06T21:03:30.697Z', { ...RECORD_TOTALS, itemWallMin: { median: null } }, {
    reviews: {}, candidates: [],
  })
  const previous = computePrevious({ totals: { ...RECORD_TOTALS, itemWallMin: { median: 40 } } }, newestRecord(dir))
  // `null`, not 40: there is nothing to have moved FROM, and printing a
  // delta of 40 would claim an improvement nobody measured.
  assert.equal(previous.deltas.itemWallMedianMin.delta, null)
  // A record with no labels at all has no rates, which is not "0% drift".
  assert.equal(previous.labelRates, null)
})
