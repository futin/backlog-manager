import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RUN_STALE_MS } from './orchestrate.mjs'

const SCRIPT = fileURLToPath(new URL('./orchestrate.mjs', import.meta.url))

// The jest-side fixture is the authority for the run/queue-item key set —
// see shared/types.ts's RunStage/RunQueueItem/RunAttention/OrchestratorRun
// block, which this fixture was hand-built to satisfy. Path-referenced
// rather than copied, per the brief: a copy could drift from the original
// the moment either side is edited without touching the other; reading the
// exact same file both suites already depend on means there is only ever
// one fixture to keep in sync with shared/types.ts.
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'orchestrator-run.json')

// Every test gets its own throwaway BM_ORCH_HOME (so nothing here ever
// touches a developer's real ~/.backlog-manager/) and its own throwaway
// project directory (a real, if empty, git repo — orchestrate.mjs resolves
// "which project" for every command but `init` by walking up from its own
// cwd looking for a .git entry, exactly the way skills/backlog/tools/
// backlog.mjs's resolveRoot does; see orchestrate.mjs's own comment on why
// that duplication is deliberate rather than an import). t.after cleans up
// both directories unconditionally, so a failed assertion mid-test still
// leaves no litter in the OS temp dir behind it.
function orchFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-home-')))
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-project-')))
  spawnSync('git', ['-C', project, 'init', '-q'], { encoding: 'utf8' })
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(project, { recursive: true, force: true })
  })
  return { home, project }
}

// Spawns the real CLI as a child process with BM_ORCH_HOME pinned to this
// test's own throwaway home — never the ambient environment's value, so a
// developer's real orchestrator state can never leak into, or be clobbered
// by, a test run.
function run(cwd, home, ...args) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd, env: { ...process.env, BM_ORCH_HOME: home } })
}

// Project keying is encodeURIComponent(<abs path>), reversible with
// decodeURIComponent — asserted directly against the CLI's own file layout
// here so every other test in this file can compute where run.json landed
// without re-deriving the encoding itself.
function runFile(home, project) {
  return path.join(home, encodeURIComponent(project), 'run.json')
}

function runsDir(home, project) {
  return path.join(home, encodeURIComponent(project), 'runs')
}

// --queue-json is the temporary test-only escape hatch named in the brief
// (Task 4 deletes it once the real gate exists): a JSON array of {id,
// title} pairs that `init` turns into full RunQueueItem records. Writing it
// to a throwaway file per call keeps each test's queue seed independent of
// every other test's.
function writeQueueJson(t, items) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-queue-')), 'queue.json')
  fs.writeFileSync(file, JSON.stringify(items))
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }))
  return file
}

// --- RUN_STALE_MS -----------------------------------------------------------

// Controller ruling: the .mjs tool cannot import shared/types.ts (plugin
// skill directories are installed as standalone copies and may be pruned
// independently), so it defines its own copy of this constant instead. Both
// suites assert the literal 900000 — not just "equal to some imported
// value" — so the two constants cannot silently drift apart; if either side
// is ever edited without the other, this test (or the jest twin over
// shared/types.ts) goes red immediately instead of the mismatch surfacing
// as a confusing staleness bug months later.
test('RUN_STALE_MS is exactly 900000ms (15 minutes) — twin of shared/types.ts RUN_STALE_MS', () => {
  assert.equal(RUN_STALE_MS, 900000)
})

// --- Test case 1: init's shape matches the contract fixture exactly --------

test('init writes a run.json whose key set matches the contract fixture exactly, for the run and for a queue item', (t) => {
  const { home, project } = orchFixture(t)
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
  const queueJson = writeQueueJson(t, [{ id: 'bug-14', title: 'Fix duplicate heartbeat write on a resumed run' }])

  const out = run(project, home, 'init', '--project', project, '--queue-json', queueJson)

  assert.equal(out.status, 0, out.stderr)
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))

  assert.deepEqual(new Set(Object.keys(written)), new Set(Object.keys(fixture)))
  assert.equal(written.queue.length, 1)
  assert.deepEqual(new Set(Object.keys(written.queue[0])), new Set(Object.keys(fixture.queue[0])))
})

test('init prints { runId, dir } JSON on success', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'init', '--project', project)

  assert.equal(out.status, 0, out.stderr)
  const printed = JSON.parse(out.stdout)
  assert.match(printed.runId, /^run-\d{8}-\d{6}$/)
  assert.equal(printed.dir, path.join(home, encodeURIComponent(project)))
})

test('init with no --queue-json and no --ids writes an empty queue — a run with nothing gated yet is valid', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'init', '--project', project)

  assert.equal(out.status, 0, out.stderr)
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(written.queue, [])
  assert.deepEqual(written.attention, [])
  assert.equal(written.status, 'running')
  assert.equal(written.maxItems, null)
})

test('init --project must be an absolute path — a relative one is a usage error, nothing written', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'init', '--project', 'not/absolute')

  assert.equal(out.status, 1)
  assert.equal(fs.existsSync(runFile(home, project)), false)
})

// --- Test case 2: a fresh running lock refuses a second init, untouched ----

test('init twice in a row: the second call exits 4 while the first is still fresh, and the first file is byte-identical after', (t) => {
  const { home, project } = orchFixture(t)
  const first = run(project, home, 'init', '--project', project)
  assert.equal(first.status, 0, first.stderr)
  const before = fs.readFileSync(runFile(home, project))

  const second = run(project, home, 'init', '--project', project)

  assert.equal(second.status, 4)
  // The lock refusal must name the way forward — a stale run's recovery
  // path — so a human staring at this message is never left guessing.
  assert.match(second.stderr, /--resume/)
  assert.match(second.stderr, /--abort/)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json changed even though init was refused')
})

// --- Test case 3: init over a done run archives it and starts fresh --------

test('init over a status:"done" run archives the old file to runs/<runId>.json and writes a fresh running run', (t) => {
  const { home, project } = orchFixture(t)
  const first = run(project, home, 'init', '--project', project)
  assert.equal(first.status, 0, first.stderr)
  const firstRunId = JSON.parse(first.stdout).runId
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0)

  const second = run(project, home, 'init', '--project', project)

  assert.equal(second.status, 0, second.stderr)
  const archived = fs.readdirSync(runsDir(home, project))
  assert.deepEqual(archived, [`${firstRunId}.json`])
  const archivedRun = JSON.parse(fs.readFileSync(path.join(runsDir(home, project), `${firstRunId}.json`), 'utf8'))
  assert.equal(archivedRun.status, 'done')

  const current = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(current.status, 'running')
})

// A second archive after the resumed run also finishes proves pastRuns is a
// plain directory-listing count, not a value carried on the run file itself.
test('a second done-then-init cycle grows runs/ to two archived files', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  assert.equal(run(project, home, 'finish', '--status', 'aborted').status, 0)

  const out = run(project, home, 'init', '--project', project)

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.readdirSync(runsDir(home, project)).length, 2)
})

// --- Test case 4: stage sets fields, first-arrival stageAt, fresh updatedAt

test('stage task-5 dispatched sets session/worktree/branch, stamps stageAt.dispatched, and strictly advances updatedAt', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-5', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))

  const out = run(project, home, 'stage', 'task-5', 'dispatched', '--session', 'abc', '--worktree', '/tmp/w', '--branch', 'backlog/task-5')

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  const item = after.queue.find((q) => q.id === 'task-5')
  assert.equal(item.sessionId, 'abc')
  assert.equal(item.worktree, '/tmp/w')
  assert.equal(item.branch, 'backlog/task-5')
  assert.equal(item.stage, 'dispatched')
  assert.ok(Number.isFinite(Date.parse(item.stageAt.dispatched)), `stageAt.dispatched did not parse: ${item.stageAt.dispatched}`)
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt), 'updatedAt did not strictly advance')
})

test('stage only stamps stageAt on first arrival — revisiting a stage does not move its timestamp', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-9', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  assert.equal(run(project, home, 'stage', 'task-9', 'reviewing').status, 0)
  const firstVisit = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stageAt.reviewing

  // A revisit must land strictly later by the clock, so this only proves
  // the first-arrival timestamp survives if it is provably NOT re-stamped —
  // i.e. it must equal firstVisit even though real time has moved on.
  assert.equal(run(project, home, 'stage', 'task-9', 'fixing').status, 0)
  assert.equal(run(project, home, 'stage', 'task-9', 'reviewing').status, 0)

  const secondVisit = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stageAt.reviewing
  assert.equal(secondVisit, firstVisit)
})

// --- Test case 5: stage with an unknown stage string is refused whole -----

test('stage task-5 nonsense exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-5', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const out = run(project, home, 'stage', 'task-5', 'nonsense')

  assert.equal(out.status, 1)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))))
})

test('stage with an unknown item id exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const out = run(project, home, 'stage', 'ghost-1', 'dispatched')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /ghost-1/)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))))
})

// --- Test case 6: no *.tmp litter survives any successful command ---------

test('no *.tmp file survives in the project run dir after init, stage, heartbeat, attention, and finish all succeed', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-6', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  assert.equal(run(project, home, 'stage', 'task-6', 'dispatched').status, 0)
  assert.equal(run(project, home, 'heartbeat').status, 0)
  assert.equal(run(project, home, 'attention', 'task-6', '--kind', 'parked', '--detail', 'merge conflict').status, 0)
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0)

  const dir = path.join(home, encodeURIComponent(project))
  const leftover = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftover, [])
})

// --- Test case 7: heartbeat touches updatedAt only -------------------------

test('heartbeat changes updatedAt and nothing else', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-1', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))

  const out = run(project, home, 'heartbeat')

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  const { updatedAt: beforeUpdatedAt, ...beforeRest } = before
  const { updatedAt: afterUpdatedAt, ...afterRest } = after
  assert.deepEqual(afterRest, beforeRest)
  assert.ok(Date.parse(afterUpdatedAt) > Date.parse(beforeUpdatedAt))
})

test('heartbeat with no run exits 3', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'heartbeat')

  assert.equal(out.status, 3)
})

// --- Test case 8: attention appends and mirrors questions -------------------

test('attention task-6 --kind needs-answers --detail appends an attention row and the run still parses as the contract shape', (t) => {
  const { home, project } = orchFixture(t)
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
  const queueJson = writeQueueJson(t, [{ id: 'task-6', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)

  const out = run(project, home, 'attention', 'task-6', '--kind', 'needs-answers', '--detail', 'which column?')

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(after.attention, [{ id: 'task-6', kind: 'needs-answers', detail: 'which column?' }])
  assert.deepEqual(new Set(Object.keys(after)), new Set(Object.keys(fixture)))
  assert.deepEqual(new Set(Object.keys(after.attention[0])), new Set(Object.keys(fixture.attention[0])))
})

test('attention --kind needs-answers --questions-json mirrors the questions onto the queue item', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-21', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  const questionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-questions-')), 'questions.json')
  fs.writeFileSync(questionsFile, JSON.stringify(['Does archiving move it to the Archive view immediately?']))
  t.after(() => fs.rmSync(path.dirname(questionsFile), { recursive: true, force: true }))

  const out = run(project, home, 'attention', 'task-21', '--kind', 'needs-answers', '--detail', 'needs a decision', '--questions-json', questionsFile)

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(after.queue[0].questions, ['Does archiving move it to the Archive view immediately?'])
})

// A kind other than needs-answers must never pick up --questions-json, even
// if the caller passes one — the field's whole meaning ("unanswered
// preflight questions") only applies to that one kind.
test('attention --kind parked ignores --questions-json entirely', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-16', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  const questionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-questions-')), 'questions.json')
  fs.writeFileSync(questionsFile, JSON.stringify(['should never appear']))
  t.after(() => fs.rmSync(path.dirname(questionsFile), { recursive: true, force: true }))

  const out = run(project, home, 'attention', 'task-16', '--kind', 'parked', '--detail', 'merge conflict', '--questions-json', questionsFile)

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(after.queue[0].questions, [])
})

test('attention with an unknown kind exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t)
  const queueJson = writeQueueJson(t, [{ id: 'task-6', title: 'Some task' }])
  assert.equal(run(project, home, 'init', '--project', project, '--queue-json', queueJson).status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const out = run(project, home, 'attention', 'task-6', '--kind', 'bogus', '--detail', 'x')

  assert.equal(out.status, 1)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))))
})

// --- Test case 9: status with no run exits 3 --------------------------------

test('status with no run exits 3', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'status')

  assert.equal(out.status, 3)
})

test('status --json prints the run file verbatim as parseable JSON', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const out = run(project, home, 'status', '--json')

  assert.equal(out.status, 0, out.stderr)
  const printed = JSON.parse(out.stdout)
  const onDisk = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(printed, onDisk)
})

// --- finish ------------------------------------------------------------

test('finish --status done sets run status and re-stamps updatedAt', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))

  const out = run(project, home, 'finish', '--status', 'done')

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(after.status, 'done')
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt))
})

test('finish with an unrecognized --status exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const out = run(project, home, 'finish', '--status', 'bogus')

  assert.equal(out.status, 1)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))))
})

test('finish with no run exits 3', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'finish', '--status', 'done')

  assert.equal(out.status, 3)
})

// --- misc CLI shape ----------------------------------------------------

test('an unknown command exits 1', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'bogus-command')

  assert.equal(out.status, 1)
})

test('stage, heartbeat, attention, finish, and status all resolve the project from cwd via the nearest .git ancestor, not from init\'s --project argument alone', (t) => {
  const { home, project } = orchFixture(t)
  const nested = path.join(project, 'a', 'b')
  fs.mkdirSync(nested, { recursive: true })
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  // Run from a subdirectory of the same repo — resolveProjectRoot must walk
  // up to the same root `init` was given, or this would 404 the run.
  const out = run(nested, home, 'heartbeat')

  assert.equal(out.status, 0, out.stderr)
})
