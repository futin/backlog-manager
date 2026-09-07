// End-to-end cases for `retro.mjs`: the CLI is always spawned as a real
// child process with all four homes pinned to this test's own throwaway
// directories, so nothing here can read — let alone write — a developer's
// real `~/.backlog-manager` or `~/.claude/projects`. The pattern is
// orchestrate.test.mjs's `orchFixture`, widened from one home to four.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./retro.mjs', import.meta.url))

// The jest-side fixture is the authority for the run/queue-item key set
// (shared/types.ts). Read rather than copied, for the reason
// orchestrate.test.mjs gives: a copy drifts the moment either side is
// edited alone.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'orchestrator-run.json',
)
export function runTemplate() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
}

// Four throwaway homes per test, removed unconditionally in `t.after` so a
// failed assertion mid-test still leaves nothing behind.
export function retroFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-orch-')))
  const retro = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-home-')))
  const projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-cc-')))
  const regDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-reg-')))
  const registry = path.join(regDir, 'registry.json')
  t.after(() => {
    for (const d of [home, retro, projects, regDir]) fs.rmSync(d, { recursive: true, force: true })
  })
  return { home, retro, projects, registry }
}

export function run(fx, ...args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BM_ORCH_HOME: fx.home,
      BM_RETRO_HOME: fx.retro,
      BM_CLAUDE_PROJECTS: fx.projects,
      BM_REGISTRY_FILE: fx.registry,
      // Pinned so `record`'s `recordedBy` is deterministic unless a test
      // sets it deliberately.
      CLAUDE_CODE_SESSION_ID: '',
    },
  })
}

export function seedRegistry(fx, entries) {
  fs.writeFileSync(
    fx.registry,
    JSON.stringify({ projects: entries.map((e) => ({ ...e, createdAt: '2026-01-01T00:00:00.000Z' })) }),
  )
}

// --- Task 1: usage and dispatch -----------------------------------------

test('retro.mjs with no arguments prints usage and exits 1', (t) => {
  const fx = retroFixture(t)
  const r = run(fx)
  assert.equal(r.status, 1)
  assert.ok(r.stderr.startsWith('usage: retro.mjs'), r.stderr)
})

test('retro.mjs rejects an unknown command', (t) => {
  const fx = retroFixture(t)
  const r = run(fx, 'bogus')
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes('unknown command: bogus'), r.stderr)
})

// --- Task 2: run files ---------------------------------------------------

// Writes a run file exactly where orchestrate.mjs would: `run.json` for the
// live run, `runs/<runId>.json` once archived. Built from the jest-side
// fixture so the key set is the real one and a test only states the fields
// it actually cares about.
export function seedRun(fx, project, overrides, { archived = false } = {}) {
  const base = runTemplate()
  const run = { ...base, ...overrides, project }
  const dir = path.join(fx.home, encodeURIComponent(project))
  const file = archived ? path.join(dir, 'runs', `${run.runId}.json`) : path.join(dir, 'run.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(run, null, 2))
  return file
}

// A queue item with only the fields a case names; `stageAt` defaults to a
// dispatched-and-merged shape so most cases need not spell one out.
export function queueItem(id, overrides = {}) {
  const base = runTemplate().queue[0]
  return { ...base, id, title: `title ${id}`, ...overrides }
}

export function sweepJson(fx, ...args) {
  const r = run(fx, 'sweep', '--json', ...args)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const PROJECT_A = '/Users/dev/code/alpha'
const PROJECT_B = '/Users/dev/code/beta'

test('sweep reads current and archived run files across projects', (t) => {
  const fx = retroFixture(t)
  seedRegistry(fx, [{ name: 'alpha', path: PROJECT_A }])
  seedRun(fx, PROJECT_A, { runId: 'R-now', status: 'running', queue: [queueItem('bug-1'), queueItem('bug-2')] })
  seedRun(fx, PROJECT_A, { runId: 'R-old', status: 'done', queue: [queueItem('bug-3')] }, { archived: true })
  seedRun(fx, PROJECT_B, { runId: 'R-b', status: 'done', queue: [queueItem('task-9')] })

  const sweep = sweepJson(fx)
  assert.equal(sweep.projects.length, 2)
  assert.equal(sweep.runs.length, 3)
  assert.equal(sweep.items.length, 4)
  assert.equal(sweep.runs.find((r) => r.runId === 'R-old').current, false)
  assert.equal(sweep.runs.find((r) => r.runId === 'R-now').current, true)

  const a = sweep.projects.find((p) => p.path === PROJECT_A)
  assert.equal(a.name, 'alpha')
  assert.equal(a.runs, 2)
  assert.equal(a.items, 3)
  // An unregistered project is swept all the same, labelled by its decoded
  // directory name — the registry is decoration, not an allowlist.
  const b = sweep.projects.find((p) => p.path === PROJECT_B)
  assert.equal(b.name, null)
  assert.equal(b.path, PROJECT_B)
})

test('sweep carries the driver lease when a run recorded one', (t) => {
  const fx = retroFixture(t)
  seedRun(fx, PROJECT_A, { runId: 'R1', driver: { sessionId: 'abc', at: '2026-09-01T10:00:00Z' }, queue: [] })
  seedRun(fx, PROJECT_B, { runId: 'R2', driver: null, queue: [] })
  const sweep = sweepJson(fx)
  assert.equal(sweep.runs.find((r) => r.runId === 'R1').driverSessionId, 'abc')
  assert.equal(sweep.runs.find((r) => r.runId === 'R2').driverSessionId, null)
})

test('sweep extracts failures from a failing verification entry only', (t) => {
  const fx = retroFixture(t)
  const tail = [
    '\x1b[31mFAIL\x1b[0m test/agents-origin-guard.test.ts',
    '  ● the agents POST guard › 403s an Origin: null POST to plan',
    'sh: jest: command not found',
  ].join('\n')
  seedRun(fx, PROJECT_A, {
    runId: 'R1',
    queue: [queueItem('bug-1', {
      verification: [
        { cmd: 'pnpm run test', ok: false, tail },
        { cmd: 'pnpm run test', ok: true, tail: '' },
      ],
    })],
  })
  const item = sweepJson(fx).items[0]
  assert.equal(item.verification.length, 2)
  assert.deepEqual(item.verification[0].failures, {
    files: ['test/agents-origin-guard.test.ts'],
    tests: ['the agents POST guard › 403s an Origin: null POST to plan'],
    errors: ['sh: jest: command not found'],
  })
  assert.ok(!('failures' in item.verification[1]))
})

test('sweep of an empty home is a success with nothing in it', (t) => {
  const fx = retroFixture(t)
  const sweep = sweepJson(fx)
  assert.deepEqual(sweep.runs, [])
  assert.deepEqual(sweep.items, [])
  assert.deepEqual(sweep.projects, [])
})

test('sweep of a home that is a regular file exits 1', (t) => {
  const fx = retroFixture(t)
  const file = path.join(fx.home, 'not-a-home')
  fs.writeFileSync(file, 'x')
  const r = run(fx, 'sweep', '--home', file)
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes('unreadable'), r.stderr)
})

// --- Task 3: the session join -------------------------------------------

// A transcript in the sidecar directory the orchestrator writes it to.
// `under` names the storage location: the project directory's own `logs/`
// for the live run, or `runs/<stem>/logs/` once `init` has archived it
// (task-31). Both are swept — see lib/paths.mjs's `sidecarRoots`.
export function seedLog(fx, project, basename, { contexts = [], result, sessionId = 'sess-x', under = '' } = {}) {
  const dir = path.join(fx.home, encodeURIComponent(project), under, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })]
  for (const total of contexts) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: total - 1002,
          output_tokens: 10,
        },
      },
    }))
  }
  if (result) lines.push(JSON.stringify({ type: 'result', session_id: sessionId, ...result }))
  const file = path.join(dir, basename)
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

export function okResult(costUsd, turns = 10, extra = {}) {
  return {
    total_cost_usd: costUsd,
    num_turns: turns,
    duration_ms: 1000,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 100000,
      output_tokens: 500,
    },
    modelUsage: { 'claude-opus-5[1m]': {} },
    permission_denials: [],
    is_error: false,
    result: 'ok',
    ...extra,
  }
}

const STAMPS = (start) => ({
  pending: start,
  preflight: start,
  dispatched: start,
  merged: start,
})

test('a session joins the latest run that dispatched its item, and the collision is a caveat', (t) => {
  const fx = retroFixture(t)
  seedRun(fx, PROJECT_A, {
    runId: 'R1',
    startedAt: '2026-09-01T10:00:00Z',
    queue: [queueItem('bug-1', { stageAt: STAMPS('2026-09-01T10:00:00Z') })],
  }, { archived: true })
  seedRun(fx, PROJECT_A, {
    runId: 'R2',
    startedAt: '2026-09-02T10:00:00Z',
    queue: [queueItem('bug-1', { stageAt: STAMPS('2026-09-02T10:00:00Z') })],
  })
  seedLog(fx, PROJECT_A, 'bug-1.jsonl', { contexts: [1000], result: okResult(1) })

  const sweep = sweepJson(fx)
  assert.equal(sweep.sessions.length, 1)
  assert.equal(sweep.sessions[0].runId, 'R2')
  assert.equal(sweep.sessions[0].kind, 'execute')
  const collision = sweep.caveats.filter((c) => c.kind === 'collision')
  assert.equal(collision.length, 1)
  assert.ok(collision[0].detail.includes('bug-1'), collision[0].detail)
  assert.ok(collision[0].detail.includes('R1'), collision[0].detail)
  assert.ok(collision[0].detail.includes('R2'), collision[0].detail)
  // The item the session was attributed to carries it back.
  const later = sweep.items.find((i) => i.runId === 'R2')
  assert.deepEqual(later.sessionKeys, [sweep.sessions[0].key])
})

test('a task-27 usage entry takes the join, and a disagreement is a caveat the run file wins', (t) => {
  const fx = retroFixture(t)
  seedRun(fx, PROJECT_A, {
    runId: 'R1',
    startedAt: '2026-09-01T10:00:00Z',
    queue: [queueItem('bug-1', {
      stageAt: STAMPS('2026-09-01T10:00:00Z'),
      usage: [{ sessionId: 's1', kind: 'execute', costUsd: 5.0, turns: 60 }],
    })],
  })
  seedLog(fx, PROJECT_A, 'bug-1.jsonl', { sessionId: 's1', contexts: [1000], result: okResult(5.0, 66) })

  const sweep = sweepJson(fx)
  assert.equal(sweep.sessions[0].joinedBy, 'usage')
  const mismatch = sweep.caveats.filter((c) => c.kind === 'usage-mismatch')
  assert.equal(mismatch.length, 1)
  assert.ok(mismatch[0].detail.includes('turns'), mismatch[0].detail)
  // The run file is the authority on disagreement — the log is the copy.
  assert.equal(sweep.items[0].usage[0].turns, 60)
})

test('a session for an item no run holds is reported, not dropped', (t) => {
  const fx = retroFixture(t)
  seedRun(fx, PROJECT_A, { runId: 'R1', startedAt: '2026-09-01T10:00:00Z', queue: [] })
  seedLog(fx, PROJECT_A, 'bug-99.jsonl', { contexts: [1000], result: okResult(1) })
  const sweep = sweepJson(fx)
  assert.equal(sweep.sessions.length, 1)
  assert.equal(sweep.sessions[0].joinedBy, 'none')
  assert.equal(sweep.sessions[0].runId, null)
})

test('a transcript with no result event is a killed session and a caveat', (t) => {
  const fx = retroFixture(t)
  seedRun(fx, PROJECT_A, {
    runId: 'R1',
    startedAt: '2026-09-01T10:00:00Z',
    queue: [queueItem('bug-1', { stageAt: STAMPS('2026-09-01T10:00:00Z') })],
  })
  seedLog(fx, PROJECT_A, 'bug-1.jsonl', { contexts: [1000] })
  const sweep = sweepJson(fx)
  assert.equal(sweep.sessions[0].result, null)
  const killed = sweep.caveats.filter((c) => c.kind === 'killed')
  assert.equal(killed.length, 1)
  assert.ok(killed[0].detail.includes('bug-1.jsonl'), killed[0].detail)
})

test('sweep finds transcripts archived under runs/<stem>/ as well as the live ones', (t) => {
  const fx = retroFixture(t)
  seedRun(fx, PROJECT_A, {
    runId: 'R1',
    startedAt: '2026-09-01T10:00:00Z',
    queue: [queueItem('bug-1', { stageAt: STAMPS('2026-09-01T10:00:00Z') })],
  })
  seedLog(fx, PROJECT_A, 'bug-1.jsonl', { contexts: [1000], result: okResult(1) })
  // task-31 moves a finished run's sidecars beside its run file; the sweep
  // must read both places or it sees only the newest run's sessions.
  seedLog(fx, PROJECT_A, 'bug-7.jsonl', { contexts: [1000], result: okResult(3), under: 'runs/run-20260831-101010' })
  const sweep = sweepJson(fx)
  assert.equal(sweep.sessions.length, 2)
  const keys = sweep.sessions.map((s) => s.key).sort()
  assert.deepEqual(keys, [
    `${PROJECT_A}/logs/bug-1.jsonl`,
    `${PROJECT_A}/runs/run-20260831-101010/logs/bug-7.jsonl`,
  ])
})

// --- Task 4: totals ------------------------------------------------------

const FAIL_TAIL = [
  '\x1b[31mFAIL\x1b[0m test/agents-origin-guard.test.ts',
  '  ● the agents POST guard › 403s an Origin: null POST to plan',
  'sh: jest: command not found',
].join('\n')

// The shared fixture Tasks 4 to 7 all measure against: one project, one run,
// three items with hand-computed stage arithmetic, four sessions, three
// reviews and one verify status. Every expected number below is derivable
// from these stamps with a clock and nothing else.
export function totalsFixture(t, { extraMerged = 0 } = {}) {
  const fx = retroFixture(t)
  seedRegistry(fx, [{ name: 'proj', path: PROJECT_A }])

  const queue = [
    // bug-1: merged, no fix loop. preflight 10:05 -> merged 10:35 = 30 min
    // wall; dispatched 10:10 -> reviewing 10:30 = 20 min dispatched.
    queueItem('bug-1', {
      stage: 'merged',
      fixLoops: 0,
      stageAt: {
        pending: '2026-09-01T10:00:00Z',
        preflight: '2026-09-01T10:05:00Z',
        dispatched: '2026-09-01T10:10:00Z',
        reviewing: '2026-09-01T10:30:00Z',
        merged: '2026-09-01T10:35:00Z',
      },
      verification: [{ cmd: 'pnpm test', ok: true, tail: '' }],
    }),
    // bug-2: merged after one fix loop. preflight 11:00 -> merged 12:00 =
    // 60 min wall; fixing 11:20 -> verifying 11:42 = 22 min in the loop.
    queueItem('bug-2', {
      stage: 'merged',
      fixLoops: 1,
      stageAt: {
        preflight: '2026-09-01T11:00:00Z',
        dispatched: '2026-09-01T11:05:00Z',
        fixing: '2026-09-01T11:20:00Z',
        verifying: '2026-09-01T11:42:00Z',
        merged: '2026-09-01T12:00:00Z',
      },
      verification: [
        { cmd: 'pnpm test', ok: false, tail: FAIL_TAIL },
        { cmd: 'pnpm test', ok: true, tail: '' },
      ],
    }),
    // bug-3: dispatched and parked — no terminal stamp, so no wall time and
    // no contribution to itemWallMin at all.
    queueItem('bug-3', {
      stage: 'parked',
      fixLoops: 0,
      stageAt: {
        pending: '2026-09-01T12:00:00Z',
        preflight: '2026-09-01T12:05:00Z',
        dispatched: '2026-09-01T12:10:00Z',
      },
      verification: [],
    }),
  ]
  for (let i = 0; i < extraMerged; i += 1) {
    queue.push(queueItem(`task-${i + 1}`, {
      stage: 'merged',
      fixLoops: 0,
      stageAt: {
        preflight: '2026-09-02T10:00:00Z',
        dispatched: '2026-09-02T10:05:00Z',
        merged: '2026-09-02T10:45:00Z',
      },
      verification: [],
    }))
  }

  seedRun(fx, PROJECT_A, { runId: 'R1', status: 'done', startedAt: '2026-09-01T09:59:00Z', queue })

  seedLog(fx, PROJECT_A, 'bug-1.jsonl', { sessionId: 's-a', contexts: [50000, 60000, 70000], result: okResult(4) })
  seedLog(fx, PROJECT_A, 'bug-2.jsonl', { sessionId: 's-b', contexts: [60000, 70000, 80000], result: okResult(6) })
  seedLog(fx, PROJECT_A, 'bug-2-fix-1.jsonl', { sessionId: 's-b', contexts: [40000], result: okResult(2) })
  seedLog(fx, PROJECT_A, 'bug-3.jsonl', { sessionId: 's-c', contexts: [30000], result: okResult(3) })

  const reviews = path.join(fx.home, encodeURIComponent(PROJECT_A), 'reviews')
  fs.mkdirSync(reviews, { recursive: true })
  const review = (name, verdict, important = 'None.') => fs.writeFileSync(
    path.join(reviews, name),
    `# Review\n\nverdict: ${verdict}\n\n## Critical\n\nNone.\n\n## Important\n\n${important}\n`,
  )
  review('bug-1-1.md', 'approve')
  review('bug-2-1.md', 'fix', '- lib/x.ts:1 — the comment says the opposite')
  review('bug-2-2.md', 'approve')

  const verify = path.join(fx.home, encodeURIComponent(PROJECT_A), 'verify')
  fs.mkdirSync(verify, { recursive: true })
  fs.writeFileSync(path.join(verify, 'bug-1.status'), '0\n')

  return fx
}

test('totals fold the fixture into the exact headline numbers', (t) => {
  const fx = totalsFixture(t)
  const sweep = sweepJson(fx)
  const totals = sweep.totals

  assert.equal(totals.merged, 2)
  assert.equal(totals.costUsd.measured, 15)
  assert.equal(totals.costPerMerged.measured, 7.5)
  assert.deepEqual(totals.fixLoops, { count: 1, itemsAffected: 1, costUsd: 2, minutes: 22 })
  assert.deepEqual(totals.verdicts, {
    approve: 2,
    fix: 1,
    byPass: { 1: { approve: 1, fix: 1 }, 2: { approve: 1, fix: 0 } },
  })
  assert.deepEqual(totals.items.byStage, { merged: 2, parked: 1 })
  assert.equal(totals.items.dispatched, 3)
  assert.deepEqual(totals.sessions.byKind, { execute: 3, fix: 1 })
  assert.deepEqual(totals.sessions.byTerminated, { ok: 4 })
  assert.equal(totals.sessions.killed, 0)
  assert.deepEqual(totals.itemWallMin, { median: 45, p90: 60, withFix: 60, withoutFix: 30 })
  assert.deepEqual(totals.runs, { total: 1, byStatus: { done: 1 } })

  // Queue wait is reported and never summed into pipeline time.
  assert.equal(totals.queueWaitMin.total, 10)
  assert.equal(totals.queueWaitMin.median, 5)
  assert.equal(totals.stageMinutes.pending, undefined)
  assert.equal(totals.stageMinutes.fixing, 22)

  const one = sweep.items.find((i) => i.id === 'bug-1')
  const two = sweep.items.find((i) => i.id === 'bug-2')
  assert.equal(one.verifyStatus, 0)
  assert.equal(two.verifyStatus, null)

  assert.equal(totals.firstVerifyFailures.length, 1)
  assert.equal(totals.firstVerifyFailures[0].itemId, 'bug-2')
  assert.deepEqual(totals.firstVerifyFailures[0].tests, [
    'the agents POST guard › 403s an Origin: null POST to plan',
  ])

  // Context medians are per project and over EXECUTE sessions only — a fix
  // loop resumes a session whose context is already grown, so folding it in
  // would report a floor nobody ever paid at turn one.
  assert.equal(totals.context.byProject[PROJECT_A].floorMedian, 50000)
  assert.equal(totals.context.byProject[PROJECT_A].peakMedian, 70000)
})

test('reviews land on the sweep with the key labels.json uses', (t) => {
  const fx = totalsFixture(t)
  const sweep = sweepJson(fx)
  assert.equal(sweep.reviews.length, 3)
  const fixed = sweep.reviews.find((r) => r.verdict === 'fix')
  assert.equal(fixed.file, `${PROJECT_A}/reviews/bug-2-1.md`)
  assert.equal(fixed.important, '- lib/x.ts:1 — the comment says the opposite')
  assert.equal(fixed.critical, '')
})

// --- Task 5: rates, drivers and their caveats ----------------------------

test('with enough measured sessions the sweep fits rates and prices the driver', (t) => {
  // Five extra merged items, each with its own execute log, take the
  // measured-session count past the eight-session floor `fitRates` needs.
  const fx = totalsFixture(t, { extraMerged: 5 })
  for (let i = 0; i < 5; i += 1) {
    seedLog(fx, PROJECT_A, `task-${i + 1}.jsonl`, {
      sessionId: `s-t${i}`,
      contexts: [40000 + i * 1000],
      // Each column scaled by a DIFFERENT factor. Scaling all four
      // together would make every row a multiple of one vector, the normal
      // equations singular, and `fitRates` correctly return null — which
      // is a different test (retro-lib.test.mjs has it).
      result: okResult(1 + i, 10 + i, {
        usage: {
          input_tokens: 100 * ((i % 4) + 1),
          cache_creation_input_tokens: 1e5 * ((i % 3) + 1),
          cache_read_input_tokens: 1e6 * (i + 1),
          output_tokens: 1e4 * ((i % 5) + 1),
        },
      }),
    })
  }
  // A driver lease pointing at a transcript under Claude Code's own key.
  const key = PROJECT_A.replace(/[/.]/g, '-')
  const ccDir = path.join(fx.projects, key)
  fs.mkdirSync(ccDir, { recursive: true })
  fs.writeFileSync(path.join(ccDir, 'drv.jsonl'), `${JSON.stringify({
    type: 'assistant',
    message: { usage: { cache_read_input_tokens: 500000, cache_creation_input_tokens: 20000, input_tokens: 20, output_tokens: 3000 } },
  })}\n`)
  seedRun(fx, PROJECT_A, {
    runId: 'R2',
    status: 'done',
    startedAt: '2026-09-03T09:00:00Z',
    driver: { sessionId: 'drv', at: '2026-09-03T09:00:00Z' },
    queue: [],
  }, { archived: true })

  const sweep = sweepJson(fx)
  assert.ok(sweep.rates, 'expected a fit')
  assert.ok(sweep.rates.sessions >= 8, String(sweep.rates.sessions))

  const measuredDriver = sweep.drivers.find((d) => d.runId === 'R2')
  assert.equal(measuredDriver.estimated, true)
  assert.ok(measuredDriver.estimatedCostUsd > 0)
  assert.equal(sweep.totals.costUsd.driverEstimated, Math.round(measuredDriver.estimatedCostUsd * 100) / 100)
  assert.equal(
    sweep.totals.costUsd.allIn,
    Math.round((sweep.totals.costUsd.measured + sweep.totals.costUsd.driverEstimated) * 100) / 100,
  )
  assert.equal(
    sweep.totals.costPerMerged.allIn,
    Math.round((sweep.totals.costUsd.allIn / sweep.totals.merged) * 100) / 100,
  )

  // One `no-lease` caveat carrying a COUNT, never one caveat per run — the
  // pre-bug-19 runs are the majority and would drown every other note.
  const noLease = sweep.caveats.filter((c) => c.kind === 'no-lease')
  assert.equal(noLease.length, 1)
  assert.ok(noLease[0].detail.includes('1'), noLease[0].detail)
})

test('too few measured sessions leave every derived dollar null, with a caveat saying so', (t) => {
  const fx = totalsFixture(t)
  const sweep = sweepJson(fx)
  assert.equal(sweep.rates, null)
  assert.equal(sweep.totals.costUsd.driverEstimated, null)
  assert.equal(sweep.totals.costUsd.allIn, null)
  assert.equal(sweep.totals.costPerMerged.allIn, null)
  // Measured spend is unaffected: it never needed a fit.
  assert.equal(sweep.totals.costUsd.measured, 15)
  const rates = sweep.caveats.filter((c) => c.kind === 'rates')
  assert.equal(rates.length, 1)
  assert.ok(/8|fit/i.test(rates[0].detail), rates[0].detail)
})

test('a session whose context crossed the long-context tier is named in a caveat', (t) => {
  const fx = totalsFixture(t)
  seedLog(fx, PROJECT_A, 'bug-4.jsonl', { sessionId: 's-d', contexts: [250000], result: okResult(1) })
  const sweep = sweepJson(fx)
  const long = sweep.caveats.filter((c) => c.kind === 'long-context')
  assert.equal(long.length, 1)
  assert.ok(long[0].detail.includes('bug-4.jsonl'), long[0].detail)
})

// --- Task 6: --text, --project and deltas end to end ---------------------

test('--text renders the headline, the stage table and a first-record note', (t) => {
  const fx = totalsFixture(t)
  const r = run(fx, 'sweep', '--text')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stdout.split('\n')[0].includes('{'), r.stdout.split('\n')[0])
  assert.ok(r.stdout.includes('merged 2 of 3'), r.stdout)
  const fixing = r.stdout.split('\n').find((l) => l.startsWith('fixing'))
  assert.ok(fixing && fixing.includes('22'), String(fixing))
  assert.ok(r.stdout.includes('first record'), r.stdout)
  // Nothing was estimated here, so the word must not appear anywhere — a
  // measured figure that reads as estimated is as wrong as the reverse.
  assert.ok(!r.stdout.includes('est.'), r.stdout)
})

test('--text marks the driver figure as estimated once there is a fit', (t) => {
  const fx = totalsFixture(t, { extraMerged: 5 })
  for (let i = 0; i < 5; i += 1) {
    seedLog(fx, PROJECT_A, `task-${i + 1}.jsonl`, {
      sessionId: `s-t${i}`,
      contexts: [40000],
      result: okResult(1 + i, 10 + i, {
        usage: {
          input_tokens: 100 * ((i % 4) + 1),
          cache_creation_input_tokens: 1e5 * ((i % 3) + 1),
          cache_read_input_tokens: 1e6 * (i + 1),
          output_tokens: 1e4 * ((i % 5) + 1),
        },
      }),
    })
  }
  const key = PROJECT_A.replace(/[/.]/g, '-')
  fs.mkdirSync(path.join(fx.projects, key), { recursive: true })
  fs.writeFileSync(path.join(fx.projects, key, 'drv.jsonl'), `${JSON.stringify({
    type: 'assistant',
    message: { usage: { cache_read_input_tokens: 500000, cache_creation_input_tokens: 20000, input_tokens: 20, output_tokens: 3000 } },
  })}\n`)
  seedRun(fx, PROJECT_A, {
    runId: 'R2', status: 'done', startedAt: '2026-09-03T09:00:00Z',
    driver: { sessionId: 'drv', at: '2026-09-03T09:00:00Z' }, queue: [],
  }, { archived: true })

  const r = run(fx, 'sweep', '--text')
  assert.equal(r.status, 0, r.stderr)
  const driverLine = r.stdout.split('\n').find((l) => l.includes('driver spend'))
  assert.ok(driverLine.includes('est.'), driverLine)
})

test('--project scopes the sweep, and refuses a path with no run state', (t) => {
  const fx = totalsFixture(t)
  seedRun(fx, PROJECT_B, { runId: 'RB', status: 'done', queue: [queueItem('task-9')] })

  const all = sweepJson(fx)
  assert.equal(all.projects.length, 2)

  const scoped = sweepJson(fx, '--project', PROJECT_A)
  assert.equal(scoped.projects.length, 1)
  assert.ok(scoped.runs.every((r) => r.project === PROJECT_A))
  assert.ok(scoped.items.every((i) => i.project === PROJECT_A))
  assert.equal(scoped.scope, PROJECT_A)

  const missing = run(fx, 'sweep', '--project', '/nowhere')
  assert.equal(missing.status, 1)
  assert.ok(missing.stderr.includes('no run state for /nowhere'), missing.stderr)
})

test('--json is the default and both spellings parse', (t) => {
  const fx = totalsFixture(t)
  const bare = run(fx, 'sweep')
  assert.equal(bare.status, 0, bare.stderr)
  assert.equal(JSON.parse(bare.stdout).totals.merged, 2)
  const explicit = run(fx, 'sweep', '--json')
  assert.equal(JSON.parse(explicit.stdout).totals.merged, 2)
})

test('a record in the retro home becomes the deltas of the next sweep', (t) => {
  const fx = totalsFixture(t)
  fs.writeFileSync(path.join(fx.retro, '2026-09-06T21-03-30-697Z.json'), JSON.stringify({
    sweep: {
      generatedAt: '2026-09-06T21:03:30.697Z',
      totals: {
        runs: { total: 1 },
        items: { total: 2, dispatched: 2 },
        merged: 1,
        costUsd: { measured: 10 },
        costPerMerged: { measured: 10 },
        fixLoops: { itemsAffected: 1 },
        verdicts: { byPass: { 1: { approve: 1, fix: 1 } } },
        itemWallMin: { median: 20 },
        queueWaitMin: { median: 3 },
      },
    },
    labels: {
      reviews: { 'P/reviews/B-1.md': 'drift' },
      candidates: [{ title: 'x', kind: 'bug', project: 'P', status: 'declined' }],
    },
    recordedBy: 't',
  }))
  const sweep = sweepJson(fx)
  assert.deepEqual(sweep.previous.deltas.merged, { then: 1, now: 2, delta: 1 })
  assert.equal(sweep.previous.deltas.costMeasured.delta, 5)
  assert.equal(sweep.previous.labelRates.drift, 1)
  assert.equal(sweep.previous.candidates[0].status, 'declined')
})

test('an empty retro home leaves previous null', (t) => {
  const fx = totalsFixture(t)
  assert.equal(sweepJson(fx).previous, null)
})

// --- Task 7: record and last --------------------------------------------

// Same child-process harness as `run`, with extra environment — used only
// for `recordedBy`, which is `$CLAUDE_CODE_SESSION_ID`.
function runWith(fx, env, ...args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BM_ORCH_HOME: fx.home,
      BM_RETRO_HOME: fx.retro,
      BM_CLAUDE_PROJECTS: fx.projects,
      BM_REGISTRY_FILE: fx.registry,
      CLAUDE_CODE_SESSION_ID: '',
      ...env,
    },
  })
}

const GENERATED_AT = '2026-09-06T21:03:30.697Z'
const STEM = '2026-09-06T21-03-30-697Z'

function recordInputs(t, { labels } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-retro-in-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sweep = path.join(dir, 'sweep.json')
  fs.writeFileSync(sweep, JSON.stringify({ generatedAt: GENERATED_AT, totals: { merged: 2 } }))
  const labelsFile = path.join(dir, 'labels.json')
  fs.writeFileSync(labelsFile, JSON.stringify(labels ?? {
    reviews: { 'P/reviews/bug-2-1.md': 'drift' },
    candidates: [{ title: 'x', kind: 'bug', project: 'P', evidence: 'e', effect: 'f', status: 'filed', filedAs: 'bug-40' }],
  }))
  const report = path.join(dir, 'report.md')
  fs.writeFileSync(report, '# Retro\n\nheadline.\n')
  return { dir, sweep, labels: labelsFile, report }
}

test('record writes the record and the report beside it', (t) => {
  const fx = retroFixture(t)
  const inputs = recordInputs(t)
  const r = runWith(fx, { CLAUDE_CODE_SESSION_ID: 'sess-1' },
    'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report)
  assert.equal(r.status, 0, r.stderr)

  const jsonPath = path.join(fx.retro, `${STEM}.json`)
  const mdPath = path.join(fx.retro, `${STEM}.md`)
  const written = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.deepEqual(Object.keys(written).sort(), ['labels', 'recordedBy', 'sweep'])
  assert.equal(written.recordedBy, 'sess-1')
  assert.equal(written.sweep.generatedAt, GENERATED_AT)
  assert.equal(fs.readFileSync(mdPath, 'utf8'), fs.readFileSync(inputs.report, 'utf8'))

  const printed = JSON.parse(r.stdout)
  assert.equal(printed.record, jsonPath)
  assert.equal(printed.report, mdPath)
})

test('record without a session id in the environment says so rather than guessing', (t) => {
  const fx = retroFixture(t)
  const inputs = recordInputs(t)
  const r = runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.retro, `${STEM}.json`), 'utf8')).recordedBy, 'unknown')
})

test('record refuses to overwrite, and leaves both files byte-identical', (t) => {
  const fx = retroFixture(t)
  const inputs = recordInputs(t)
  assert.equal(
    runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report).status,
    0,
  )
  const jsonPath = path.join(fx.retro, `${STEM}.json`)
  const mdPath = path.join(fx.retro, `${STEM}.md`)
  const before = [fs.readFileSync(jsonPath), fs.readFileSync(mdPath)]

  fs.writeFileSync(inputs.report, '# Retro\n\nCOMPLETELY DIFFERENT.\n')
  const second = runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report)
  // A record is evidence: the fix for a wrong one is a new sweep, never an
  // edit, so this is its own exit code and not a 1.
  assert.equal(second.status, 2)
  assert.ok(second.stderr.includes(`record exists: ${jsonPath}`), second.stderr)
  assert.deepEqual([fs.readFileSync(jsonPath), fs.readFileSync(mdPath)], before)
})

test('record refuses a label outside the closed set, and writes nothing', (t) => {
  const fx = retroFixture(t)
  const inputs = recordInputs(t, {
    labels: { reviews: { 'P/reviews/bug-2-1.md': 'nit' }, candidates: [] },
  })
  const r = runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report)
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes('nit'), r.stderr)
  assert.ok(r.stderr.includes('P/reviews/bug-2-1.md'), r.stderr)
  assert.deepEqual(fs.readdirSync(fx.retro), [])
})

test('record refuses a candidate whose status is outside the three', (t) => {
  const fx = retroFixture(t)
  const inputs = recordInputs(t, {
    labels: { reviews: {}, candidates: [{ title: 'x', kind: 'bug', project: 'P', status: 'maybe' }] },
  })
  const r = runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report)
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes('maybe'), r.stderr)
  assert.deepEqual(fs.readdirSync(fx.retro), [])
})

test('record refuses a candidate whose kind is outside the three', (t) => {
  const fx = retroFixture(t)
  const inputs = recordInputs(t, {
    labels: { reviews: {}, candidates: [{ title: 'x', kind: 'refactor', project: 'P', status: 'filed' }] },
  })
  const r = runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report)
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes('refactor'), r.stderr)
})

test('record refuses a missing input path', (t) => {
  const fx = retroFixture(t)
  const inputs = recordInputs(t)
  const r = runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', path.join(inputs.dir, 'nope.json'), '--report', inputs.report)
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes('nope.json'), r.stderr)
  assert.deepEqual(fs.readdirSync(fx.retro), [])
  // And a flag left off entirely is the same refusal, not a default.
  assert.equal(runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--report', inputs.report).status, 1)
})

test('last prints the newest record, and exits 3 when there is none', (t) => {
  const fx = retroFixture(t)
  const empty = run(fx, 'last')
  assert.equal(empty.status, 3)
  assert.ok(empty.stderr.includes('no record yet'), empty.stderr)

  const inputs = recordInputs(t)
  runWith(fx, {}, 'record', '--sweep', inputs.sweep, '--labels', inputs.labels, '--report', inputs.report)
  assert.equal(run(fx, 'last').stdout.trim(), path.join(fx.retro, `${STEM}.json`))

  // Two records: the later stem wins, by lexical order of the stamp.
  fs.writeFileSync(path.join(fx.retro, '2026-09-07T09-00-00-000Z.json'), JSON.stringify({ sweep: {}, labels: {}, recordedBy: 'x' }))
  assert.equal(run(fx, 'last').stdout.trim(), path.join(fx.retro, '2026-09-07T09-00-00-000Z.json'))
})

// --- the two rules a weaker fixture would have left unpinned --------------

test('a usage entry is matched by kind and loop, never by session id', (t) => {
  const fx = retroFixture(t)
  // The trap this pins: `claude -p --resume` keeps the session id it was
  // handed, so an item's execute transcript and its fix loop's report the
  // SAME id (task-27's own note on RunSessionUsage.sessionId). A join by
  // session id would hand the fix log the execute entry — and would look
  // perfectly correct on any fixture where the item has only one entry.
  seedRun(fx, PROJECT_A, {
    runId: 'R1',
    startedAt: '2026-09-01T10:00:00Z',
    queue: [queueItem('bug-1', {
      stageAt: { pending: '2026-09-01T10:00:00Z', preflight: '2026-09-01T10:01:00Z', dispatched: '2026-09-01T10:02:00Z', merged: '2026-09-01T10:30:00Z' },
      usage: [
        { sessionId: 's1', kind: 'execute', costUsd: 4.0, turns: 40 },
        { sessionId: 's1', kind: 'fix', loop: 1, costUsd: 2.0, turns: 12 },
      ],
    })],
  })
  seedLog(fx, PROJECT_A, 'bug-1.jsonl', { sessionId: 's1', contexts: [1000], result: okResult(4.0, 40) })
  // The fix loop's own transcript: same session id, different turn count.
  seedLog(fx, PROJECT_A, 'bug-1-fix-1.jsonl', { sessionId: 's1', contexts: [1000], result: okResult(2.0, 12) })

  const sweep = sweepJson(fx)
  assert.equal(sweep.sessions.length, 2)
  assert.ok(sweep.sessions.every((s) => s.joinedBy === 'usage'), JSON.stringify(sweep.sessions.map((s) => s.joinedBy)))
  // Both matched their OWN slot, so neither cross-checks against the other's
  // figures and there is nothing to report as a mismatch.
  assert.deepEqual(sweep.caveats.filter((c) => c.kind === 'usage-mismatch'), [])
})

test('a branched item is a success exit, counted and timed like a merged one', (t) => {
  const fx = retroFixture(t)
  // `merged` stopped being the only success exit when branch mode landed;
  // a retro that counted merges alone would report every branch-mode run as
  // having achieved nothing.
  seedRun(fx, PROJECT_A, {
    runId: 'R1',
    status: 'done',
    startedAt: '2026-09-01T10:00:00Z',
    mergeMode: 'branch',
    mergeModeEffective: 'branch',
    queue: [queueItem('bug-1', {
      stage: 'branched',
      fixLoops: 0,
      stageAt: {
        preflight: '2026-09-01T10:00:00Z',
        dispatched: '2026-09-01T10:05:00Z',
        branched: '2026-09-01T10:40:00Z',
      },
      verification: [],
    })],
  })
  const totals = sweepJson(fx).totals
  assert.equal(totals.merged, 1)
  assert.deepEqual(totals.items.byStage, { branched: 1 })
  // preflight -> branched, exactly as preflight -> merged would be timed.
  assert.equal(totals.itemWallMin.median, 40)
  assert.equal(totals.itemWallMin.withoutFix, 40)
})

test('a sweep larger than the pipe buffer arrives whole', (t) => {
  const fx = retroFixture(t)
  // `process.stdout.write` to a pipe is ASYNCHRONOUS, so a `process.exit()`
  // in the entry guard drops everything past the 64KB pipe buffer. The
  // failure hides from every small fixture and from `> file.json` (a
  // synchronous write on POSIX) — it only shows on a real corpus through a
  // pipe, which is what `spawnSync` gives us here.
  const queue = []
  for (let i = 0; i < 300; i += 1) {
    queue.push(queueItem(`bug-${i + 1}`, {
      stage: 'merged',
      note: 'a note long enough that three hundred of these comfortably exceed the pipe buffer on their own',
      stageAt: {
        pending: '2026-09-01T10:00:00Z',
        preflight: '2026-09-01T10:01:00Z',
        dispatched: '2026-09-01T10:02:00Z',
        merged: '2026-09-01T10:30:00Z',
      },
    }))
  }
  seedRun(fx, PROJECT_A, { runId: 'R1', status: 'done', startedAt: '2026-09-01T09:00:00Z', queue })

  const r = run(fx, 'sweep', '--json')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.length > 65536, `only ${r.stdout.length} bytes reached the pipe`)
  const sweep = JSON.parse(r.stdout)
  assert.equal(sweep.items.length, 300)
})
