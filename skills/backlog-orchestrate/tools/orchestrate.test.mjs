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

// Writes one ready-gated task item straight into `project`'s own backlog/
// store. Task 4 replaced the old --queue-json escape hatch with the real
// gate, so every test below that just needs SOME item in the queue — and
// does not care about gating itself, that is what the "plan / gate" section
// further down is for — reaches for this instead of a synthetic queue file.
// A real, non-placeholder `## Plan` is what keeps these tests honest: an
// item built by this helper must never accidentally read as ungroomed or
// needs-answers, or every stage/heartbeat/attention/finish test that seeds
// one would start depending on gate behaviour it isn't testing.
function seedReadyTask(project, id, title) {
  const dir = path.join(project, 'backlog', 'tasks', 'open')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}-fixture.md`)
  fs.writeFileSync(
    file,
    `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-08-01\n---\n\n## Goal\n\nSomething worth doing.\n\n## Plan\n\nDo the actual work described here, in enough detail that it counts as groomed.\n\n## Test cases\n\n## Done when\n`,
  )
  return file
}

// The bug twin of seedReadyTask above, for the handful of tests that seed a
// bug id instead of a task id.
function seedReadyBug(project, id, title) {
  const dir = path.join(project, 'backlog', 'bugs', 'open')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}-fixture.md`)
  fs.writeFileSync(
    file,
    `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-08-01\n---\n\n## Symptom\n\nSomething is wrong.\n\n## Repro\n\nSteps to reproduce it.\n\n## Affects\n\nsomefile.ts\n\n## Cause\n\nThe real, diagnosed cause.\n\n## Fix\n\nThe real fix — not the placeholder.\n`,
  )
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
  seedReadyBug(project, 'bug-14', 'Fix duplicate heartbeat write on a resumed run')

  const out = run(project, home, 'init', '--project', project)

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

test('init with no backlog store and no --ids writes an empty queue — a run with nothing gated yet is valid', (t) => {
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

// Fix round 1 (Important #1): the fresh-lock case above was the only lock
// coverage — the stale branch (a crashed run: status still "running" but
// the heartbeat is old) is the highest-stakes branch in this file, since it
// is the one a human is most likely to hit for real, and it had zero test
// coverage. Simulates a crash by hand-editing updatedAt to well past
// RUN_STALE_MS while leaving status "running", exactly the shape a killed
// orchestrator process would leave behind.
test('init over a stale "running" run also refuses (exit 4), names --resume/--abort, and leaves the file and directory untouched', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const file = runFile(home, project)
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'))
  stale.updatedAt = new Date(Date.now() - RUN_STALE_MS - 60_000).toISOString()
  fs.writeFileSync(file, JSON.stringify(stale, null, 2) + '\n')
  const before = fs.readFileSync(file)

  const out = run(project, home, 'init', '--project', project)

  assert.equal(out.status, 4)
  assert.match(out.stderr, /--resume/)
  assert.match(out.stderr, /--abort/)
  assert.match(out.stderr, /stale|crash/i)
  assert.ok(before.equals(fs.readFileSync(file)), 'a stale-but-running run.json was modified even though init was refused')
  const dir = path.join(home, encodeURIComponent(project))
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
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

// --- Fix round 1 (Critical + Important #2): the validate-before-mutate
// ordering fix, re-expressed against the real gate now that --queue-json is
// gone. Each case runs against a project that already has a `done` run on
// disk — the exact setup that exposed the original bug, where validating
// the queue too late archived the done run away and then threw, leaving no
// run.json at all (status would wrongly report exit 3). buildGatedQueue
// throwing on a bad --ids entry (or the pre-existing --max check failing)
// is now the thing that has to run BEFORE any of that archiving — these
// cases should touch neither the existing run.json nor create a runs/
// directory; the failure must be confined to "nothing written," full stop.

test('init --ids naming an unknown item exits 1 and leaves an existing done run.json completely untouched', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const out = run(project, home, 'init', '--project', project, '--ids', 'ghost-1')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /ghost-1/)
  assert.equal(fs.existsSync(runFile(home, project)), true)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'the done run.json was modified')
  assert.equal(fs.existsSync(runsDir(home, project)), false, 'nothing should have been archived')
  // This is the exact symptom the critical bug produced: status wrongly
  // reporting "no run exists" because the done run had already been
  // archived away with nothing put back in its place.
  assert.equal(run(project, home, 'status').status, 0)
})

test('init --max given a negative number exits 1 and leaves an existing done run.json completely untouched', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const out = run(project, home, 'init', '--project', project, '--max', '-1')

  assert.equal(out.status, 1)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'the done run.json was modified')
  assert.equal(fs.existsSync(runsDir(home, project)), false, 'nothing should have been archived')
  assert.equal(run(project, home, 'status').status, 0)
})

// Fix round 1 (Minor): confirms the reordering also kills the stray-empty-
// directory symptom on a project with no PRIOR run at all — there is
// nothing to archive here, so this is a distinct assertion from the two
// above (which exercise the archive-then-throw ordering specifically).
test('init --ids naming an unknown item on a brand-new project creates no directory at all', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'init', '--project', project, '--ids', 'ghost-1')

  assert.equal(out.status, 1)
  assert.equal(fs.existsSync(path.join(home, encodeURIComponent(project))), false, 'a stray project directory was created despite init failing')
})

// --- Test case 4: stage sets fields, first-arrival stageAt, fresh updatedAt

test('stage task-5 dispatched sets session/worktree/branch, stamps stageAt.dispatched, and strictly advances updatedAt', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-5', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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
  seedReadyTask(project, 'task-9', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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
  seedReadyTask(project, 'task-5', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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
  seedReadyTask(project, 'task-6', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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
  seedReadyTask(project, 'task-1', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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
  seedReadyTask(project, 'task-6', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const out = run(project, home, 'attention', 'task-6', '--kind', 'needs-answers', '--detail', 'which column?')

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(after.attention, [{ id: 'task-6', kind: 'needs-answers', detail: 'which column?' }])
  assert.deepEqual(new Set(Object.keys(after)), new Set(Object.keys(fixture)))
  assert.deepEqual(new Set(Object.keys(after.attention[0])), new Set(Object.keys(fixture.attention[0])))
})

test('attention --kind needs-answers --questions-json mirrors the questions onto the queue item', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-21', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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
  seedReadyTask(project, 'task-16', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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
  seedReadyTask(project, 'task-6', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
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

// --- Task 4: `plan` — the queue builder + refusal gate ----------------------
// These are the brief's own eight authoritative cases, run against the
// checked-in fixtures/store/ — six items, three gate outcomes among them,
// picked so the same six items also pin ordering (case 6) and --max (case
// 7). See that directory for each item's actual `## Plan`/`## Fix` content;
// this section only asserts what `plan` computes FROM it.
//
// `planFixture` copies the checked-in store into a disposable project per
// test rather than pointing `--project` at the checked-in path directly —
// `plan` is supposed to write nothing at all (case 8 below is exactly that
// promise), but a bug that broke it should never be able to corrupt the
// very fixtures this suite depends on to catch the bug in the first place.
const FIXTURE_STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'store')

function planFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-plan-home-')))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-plan-project-'))
  const project = path.join(scratch, 'project')
  fs.cpSync(FIXTURE_STORE, project, { recursive: true })
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(scratch, { recursive: true, force: true })
  })
  return { home, project: fs.realpathSync(project) }
}

function plan(project, home, ...extra) {
  return run(project, home, 'plan', '--project', project, ...extra)
}

// A recursive {relative path -> base64 content} snapshot, used by case 8 to
// prove `plan` really writes nothing — byte content rather than just names
// or mtimes, so even a same-size, same-timestamp rewrite would be caught.
function snapshotTree(dir) {
  const entries = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else entries.push([path.relative(dir, p), fs.readFileSync(p).toString('base64')])
    }
  }
  walk(dir)
  return entries
}

// Case 1: a real ## Plan reads as ready, with nothing to complain about.
test('plan: a task with a real ## Plan is ready, with empty reasons', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'task-1', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.id, 'task-1')
  assert.equal(item.gate, 'ready')
  assert.deepEqual(item.reasons, [])
})

// Case 2: the heading is there, but nothing under it — ungroomed, and the
// reason has to actually say so, not just fail silently.
test('plan: a task whose ## Plan heading has only whitespace under it is ungroomed, and the reason names the empty Plan', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'task-3', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ungroomed')
  assert.ok(
    item.reasons.some((r) => /plan/i.test(r) && /empty|no content/i.test(r)),
    `expected a reason naming the empty Plan, got ${JSON.stringify(item.reasons)}`,
  )
})

// Case 3: no ## Plan heading at all — also ungroomed, distinct reason.
test('plan: a task with no ## Plan heading at all is ungroomed', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'task-4', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ungroomed')
  assert.ok(
    item.reasons.some((r) => /plan/i.test(r) && /missing/i.test(r)),
    `expected a reason naming the missing Plan heading, got ${JSON.stringify(item.reasons)}`,
  )
})

// Case 4: a bug's ## Fix still exactly "unknown" — the backlog-capture
// placeholder — is ungroomed.
test('plan: a bug whose ## Fix is exactly "unknown" is ungroomed', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'bug-2', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ungroomed')
  assert.ok(item.reasons.some((r) => /fix/i.test(r)), `expected a reason naming ## Fix, got ${JSON.stringify(item.reasons)}`)
})

// Case 5: a TBD in an otherwise-real Plan is needs-answers, not ungroomed —
// and, critically, still shows up in the output rather than being dropped.
test('plan: a task with TBD in its Plan is needs-answers, with non-empty questions, and is still listed rather than dropped', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'task-5', '--json')

  assert.equal(out.status, 0, out.stderr)
  const items = JSON.parse(out.stdout)
  assert.equal(items.length, 1, 'a needs-answers item must still be listed, not dropped')
  assert.equal(items[0].gate, 'needs-answers')
  assert.ok(items[0].questions.length > 0)
})

// Case 6: the default order (no --ids) is bugs oldest-first then tasks
// oldest-first, by id NUMBER — and --ids restricts and re-orders to exactly
// the given sequence.
test('plan orders bugs oldest-first then tasks oldest-first, by id number rather than file mtime', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--json')

  assert.equal(out.status, 0, out.stderr)
  const ids = JSON.parse(out.stdout).map((i) => i.id)
  assert.deepEqual(ids, ['bug-2', 'bug-7', 'task-1', 'task-3', 'task-4', 'task-5'])
})

test('plan --ids restricts and re-orders to exactly the given sequence', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'task-1,bug-2', '--json')

  assert.equal(out.status, 0, out.stderr)
  const ids = JSON.parse(out.stdout).map((i) => i.id)
  assert.deepEqual(ids, ['task-1', 'bug-2'])
})

test('plan --ids naming an unknown id exits 1 and names it', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'task-1,ghost-9', '--json')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /ghost-9/)
})

// Case 7: --max 2 marks everything after the 2nd READY item as beyondMax —
// bug-2 is ungroomed and sits before either ready item, so it stays false;
// task-3/4/5 sit after task-1 (the 2nd ready item) and are all beyond,
// regardless of their own gate.
test('plan --max 2 marks every item after the second ready one as beyondMax, regardless of its own gate', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--max', '2', '--json')

  assert.equal(out.status, 0, out.stderr)
  const byId = Object.fromEntries(JSON.parse(out.stdout).map((i) => [i.id, i.beyondMax]))
  assert.deepEqual(byId, {
    'bug-2': false,
    'bug-7': false,
    'task-1': false,
    'task-3': true,
    'task-4': true,
    'task-5': true,
  })
})

// Case 8: plan is side-effect free — the fixture store and the state dir
// are byte-identical before and after.
test('plan writes nothing at all: the fixture store and the state dir are byte-identical before and after', (t) => {
  const { home, project } = planFixture(t)
  const before = snapshotTree(project)
  const homeBefore = fs.readdirSync(home)

  const out = plan(project, home, '--json')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(snapshotTree(project), before)
  assert.deepEqual(fs.readdirSync(home), homeBefore)
})

// --- supplementary: the other two question-detection triggers ---------------
// Not among the brief's eight authoritative cases (which pin TBD detection
// specifically), but the same interface line documents two more triggers
// for needs-answers, and untested logic in a refusal gate is exactly the
// kind of thing that quietly rots. Both build their own throwaway project
// via orchFixture rather than touching fixtures/store/, keeping that
// checked-in directory to exactly the six items the brief names.

test('plan: a trailing "?" line inside ## Plan triggers needs-answers, using that line verbatim as the question', (t) => {
  const { home, project } = orchFixture(t)
  const dir = path.join(project, 'backlog', 'tasks', 'open')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'task-1-q.md'),
    '---\nid: task-1\ntitle: Ask before building\ncreated: 2026-08-01\n---\n\n## Plan\n\nBuild the thing. Should it default to dark mode?\n\n## Done when\n',
  )

  const out = plan(project, home, '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'needs-answers')
  assert.ok(item.questions.some((q) => q.includes('dark mode?')))
})

test('plan: a ## Done when command not found in verify.json or package.json is a warning question, never a gate failure', (t) => {
  const { home, project } = orchFixture(t)
  const dir = path.join(project, 'backlog', 'tasks', 'open')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'task-1-dw.md'),
    '---\nid: task-1\ntitle: Ship it\ncreated: 2026-08-01\n---\n\n## Plan\n\nReal, groomed plan content with nothing left to decide.\n\n## Done when\n\n```bash\npnpm run this-script-does-not-exist\n```\n',
  )

  const out = plan(project, home, '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'needs-answers')
  assert.equal(item.reasons.length, 0, 'an unresolved Done-when command is a question, never a gate failure')
  assert.ok(item.questions.some((q) => q.includes('this-script-does-not-exist')))
})

// --- init wires the same gate in ---------------------------------------
// Not one of the eight `plan` cases either, but the brief's whole point is
// that `init`'s queue builder and `plan`'s preview are the SAME code path —
// this is the one test that would catch `cmdInit` silently diverging from
// buildGatedQueue (e.g. reintroducing its own copy of the ordering or the
// --max cutoff) even though every `plan`-specific case above is green.
test('init builds its queue from the real gate: bugs oldest-first then tasks oldest-first, and --max excludes items beyond the cap', (t) => {
  const { home, project } = planFixture(t)

  const out = run(project, home, 'init', '--project', project, '--max', '2')

  assert.equal(out.status, 0, out.stderr)
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(written.queue.map((q) => q.id), ['bug-2', 'bug-7', 'task-1'])
  assert.ok(written.queue.every((q) => q.stage === 'pending'), 'every queued item should start pending regardless of its own gate result')
})
