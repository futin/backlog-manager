import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { RUN_STALE_MS, isZombieStatState, readPermissionDenials } from './orchestrate.mjs'

const SCRIPT = fileURLToPath(new URL('./orchestrate.mjs', import.meta.url))

// Task 5's own fixtures: a realistic `claude -p --output-format stream-json`
// transcript head that DOES carry the init event (and therefore the session
// id), and one that never does — see watch's own test cases 1 and 3.
const STREAM_INIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-init.jsonl')
const STREAM_NOINIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-noinit.jsonl')
// Fix round 1 (Minor): a leading line that isn't valid JSON at all, ahead of
// a real init event — pins findSessionIdInJsonl's malformed-line-skip branch
// (a bad line is swallowed and parsing continues, it is never a wedge).
const STREAM_MALFORMED_THEN_INIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-malformed-then-init.jsonl')

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

// --- Task 5 fixtures: real child processes and real git worktrees ----------
// watch's contract is about a real pid and a real (possibly live-appended)
// file, and abort/reconcile's contract is about real git worktrees/branches
// — the brief bans stubbing any of this out, so these helpers all shell out
// for real rather than mocking process liveness or git state.

// A real, short-lived child for watch's pid-liveness tests. t.after kills it
// defensively (SIGKILL, errors ignored) so a test that asserts before the
// child would have exited on its own never leaves an orphan node process
// running past this file's own test run.
function spawnChild(t, ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' })
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // already dead — nothing to clean up
    }
  })
  return child
}

// Runs the CLI asynchronously rather than through `run()`'s blocking
// spawnSync — required for any test that ALSO owns a short-lived
// `spawnChild` expected to die WHILE the CLI call is in flight. `spawnSync`
// blocks this test file's own event loop for the whole call, which stops
// Node from reaping ITS OWN already-exited child in the meantime — a
// zombie process still answers `kill(pid, 0)` as "alive" until its parent
// reaps it (a real POSIX rule, not a bug in cmdWatch), so a test using
// `run()` here would see watch's pid check spuriously stay true for the
// zombie's entire lifetime. Using `spawn`+`await once(..., 'exit')` instead
// keeps this process's event loop free to reap that child the moment it
// actually exits, exactly like a real caller (a shell driving `claude -p
// … &` and `orchestrate.mjs watch` as separate, unrelated processes) would
// never have this problem in the first place.
async function runAsync(cwd, home, ...args) {
  const proc = spawn('node', [SCRIPT, ...args], { cwd, env: { ...process.env, BM_ORCH_HOME: home } })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (d) => {
    stdout += d
  })
  proc.stderr.on('data', (d) => {
    stderr += d
  })
  const [status] = await once(proc, 'exit')
  return { status, stdout, stderr }
}

// `git worktree add <path> -b <branch> HEAD` needs an actual commit for HEAD
// to resolve to — orchFixture's repo is `git init -q` with no commits at
// all, which every OTHER test in this file is fine with (orchestrate.mjs
// only ever needs a `.git` entry to exist, never a commit). Only the abort/
// reconcile tests below exercise real worktree/branch plumbing, so only
// they call this. A throwaway local identity (`-c user.email=…`) keeps this
// independent of whatever global git config this machine happens to have.
function commitEverything(project, message) {
  spawnSync('git', ['-C', project, 'add', '-A'], { encoding: 'utf8' })
  const result = spawnSync(
    'git',
    ['-C', project, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`)
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

// --- Fix round 1 (Task 6+7 review): `stage --fix-loop` ---------------------
// The SKILL enforces "at most two fix loops per item," and before this flag
// existed there was nothing on disk to enforce it against: `fixLoops` was
// minted as 0 by makeQueueItem and never written again, so the ceiling lived
// only in the orchestrator session's memory — which a crash plus a `--resume`
// wipes, letting an item loop forever two at a time. These two tests pin the
// counter's whole contract: it accumulates across separate CLI invocations
// (each one a fresh process re-reading the file, which is what "survives a
// resume" means mechanically), and it is strictly opt-in.

test('stage --fix-loop increments fixLoops, accumulates across a re-read, and leaves every other field alone', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-4', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  const beforeItem = before.queue.find((q) => q.id === 'task-4')
  assert.equal(beforeItem.fixLoops, 0)

  const out = run(project, home, 'stage', 'task-4', 'fixing', '--fix-loop')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout), { id: 'task-4', stage: 'fixing', fixLoops: 1 })

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  const item = after.queue.find((q) => q.id === 'task-4')
  assert.equal(item.fixLoops, 1)
  // Everything else on the item is exactly as init minted it: only the three
  // fields this call is allowed to move (fixLoops, stage, and stage's own
  // first-arrival stamp) are normalized away before the comparison, so a
  // stray write to sessionId/worktree/branch/verification/questions/note
  // would fail here.
  assert.deepEqual({ ...item, fixLoops: beforeItem.fixLoops, stage: beforeItem.stage, stageAt: beforeItem.stageAt }, beforeItem)
  // And nothing outside the queue moved except the heartbeat.
  assert.deepEqual({ ...after, queue: before.queue, updatedAt: before.updatedAt }, before)

  // A second, separate process: the count is read back off disk and advanced,
  // never recomputed from scratch.
  assert.equal(run(project, home, 'stage', 'task-4', 'fixing', '--fix-loop').status, 0)
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-4').fixLoops, 2)
})

test('stage without --fix-loop never touches fixLoops, and prints its usual two-key line', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-4', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const out = run(project, home, 'stage', 'task-4', 'fixing')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout), { id: 'task-4', stage: 'fixing' })
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-4').fixLoops, 0)
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

// --- bug-5: the gate reads the ref the worktree is built from, not the disk -
// The defect this section pins: an item groomed but not yet committed on
// `main` gated `ready`, got a worktree created from `main`'s commit, and was
// dispatched into a tree whose `backlog/` did not contain it — the session
// then found the only copy that existed (the main tree's) by absolute path
// and archived the item there, splitting one item across two trees while
// every stage reported success. `plan`/`init` gated the working copy; the
// worktree is built from a commit. These cases pin the fix: the gate now
// reads each candidate's blob at `--base` (default `main`), which is the
// only content the dispatched session will ever see.
//
// `planGitFixture` is `planFixture` plus a real repository: the trunk is
// pinned to `main` with `symbolic-ref` rather than `init -b main` so the
// branch name is this suite's own choice and not whatever
// `init.defaultBranch` happens to be on the machine running it, and a
// README.md rides along in the first commit purely so case 7 has a tracked
// NON-item file it can dirty. Every non-git `planFixture` case above stays
// exactly as it is — those are the fallback's regression test.
function planGitFixture(t) {
  const { home, project } = planFixture(t)
  spawnSync('git', ['-C', project, 'init', '-q'], { encoding: 'utf8' })
  spawnSync('git', ['-C', project, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture store\n')
  commitEverything(project, 'fixture store')
  return { home, project }
}

// The one uncommitted item cases 2, 4 and 5 share. Its repo-relative path is
// a literal rather than something derived, because case 2 asserts the gate's
// reason names that exact path — a derived value on both sides could agree
// with itself while both were wrong.
const TASK_9_REL = 'backlog/tasks/open/task-9-uncommitted-when-the-run-starts.md'
const TASK_9_BODY = `---
id: task-9
title: Uncommitted when the run starts
created: 2026-09-01
---

## Plan

A real plan, groomed in the working copy and committed nowhere.
`

function writeTask9(project) {
  fs.writeFileSync(path.join(project, TASK_9_REL), TASK_9_BODY)
}

function git(project, ...args) {
  return spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' })
}

// Case 1: the ordinary path is unchanged — an item that is both committed
// and groomed still reads ready. Without this, every case below could pass
// on a gate that had simply started refusing everything.
test('plan on a git store: a task committed on main with a real ## Plan is ready, with empty reasons', (t) => {
  const { home, project } = planGitFixture(t)

  const out = plan(project, home, '--ids', 'task-1', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ready')
  assert.deepEqual(item.reasons, [])
})

// Case 2: the defect itself. A groomed item that exists only in the working
// copy is refused, and the reason names the path the worktree would not
// contain — that path is the whole point of the message, since "not
// committed" alone leaves the reader guessing which of their items it means.
test('plan on a git store: an item groomed only in the working copy is ungroomed, and the reason names the path the worktree would lack', (t) => {
  const { home, project } = planGitFixture(t)
  writeTask9(project)

  const out = plan(project, home, '--ids', 'task-9', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ungroomed')
  assert.equal(item.reasons.length, 1, `expected exactly one reason, got ${JSON.stringify(item.reasons)}`)
  assert.match(item.reasons[0], /not committed/i)
  assert.ok(item.reasons[0].includes(TASK_9_REL), `reason should name ${TASK_9_REL}: ${item.reasons[0]}`)
})

// Case 3: the sibling defect the same root cause implies. bug-2 is committed
// with `## Fix` still the `unknown` placeholder; grooming it in the working
// copy alone used to read `ready` and dispatch into a worktree holding the
// UNGROOMED version, where backlog-execute refuses it and the whole item is
// spent for nothing. This is the case that proves the gate reads the
// committed blob rather than the file on disk — the disk copy here is
// perfectly groomed.
test('plan on a git store: a bug groomed only in the working copy still gates on the committed placeholder', (t) => {
  const { home, project } = planGitFixture(t)
  const file = path.join(project, 'backlog', 'bugs', 'open', 'bug-2-settings-hue-swatch-preview-lags-one-theme-change-behind.md')
  const groomed = fs.readFileSync(file, 'utf8').replace(
    /## Fix\n\nunknown/,
    '## Fix\n\nSubscribe the swatch to the theme store instead of reading the hue once at mount.',
  )
  assert.ok(groomed.includes('Subscribe the swatch'), 'fixture bug-2 no longer has the "## Fix\\n\\nunknown" shape this case rewrites')
  fs.writeFileSync(file, groomed)

  const out = plan(project, home, '--ids', 'bug-2', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ungroomed', 'the worktree would hold the committed placeholder, not the working copy')
  assert.ok(item.reasons.some((r) => /fix/i.test(r)), `expected the ordinary placeholder reason, got ${JSON.stringify(item.reasons)}`)
})

// Case 4: --base is honoured, and the coupling it exists for is real — the
// same item reads differently depending on which ref the worktree would be
// created from. task-9 is committed on `trunk` only; `main` never sees it.
test('plan --base gates against the named ref: an item committed on trunk alone is ready there and uncommitted on main', (t) => {
  const { home, project } = planGitFixture(t)
  writeTask9(project)
  assert.equal(git(project, 'checkout', '-q', '-b', 'trunk').status, 0)
  commitEverything(project, 'task-9 on trunk only')
  assert.equal(git(project, 'checkout', '-q', 'main').status, 0)
  // `checkout main` took the file back off disk; the working copy has to
  // hold it again for it to be a candidate at all (the candidate list is a
  // directory read — only the GATE moved to the ref).
  writeTask9(project)

  const onMain = plan(project, home, '--ids', 'task-9', '--json')
  const onTrunk = plan(project, home, '--ids', 'task-9', '--base', 'trunk', '--json')

  assert.equal(onMain.status, 0, onMain.stderr)
  assert.equal(onTrunk.status, 0, onTrunk.stderr)
  assert.equal(JSON.parse(onMain.stdout)[0].gate, 'ungroomed')
  assert.equal(JSON.parse(onTrunk.stdout)[0].gate, 'ready')
})

// Case 5: init queues by membership exactly as before, and the knock-on the
// fix has on --max is the correct one — an uncommitted item is not ready, so
// it no longer consumes the single ready slot and task-1 lands inside the
// cap instead of being pushed past it. The cap bounds how many items a run
// will DISPATCH.
test('init on a git store: an uncommitted item stays in the queue and no longer consumes a --max slot', (t) => {
  const { home, project } = planGitFixture(t)
  writeTask9(project)

  const out = run(project, home, 'init', '--project', project, '--ids', 'task-9,task-1', '--max', '1')

  assert.equal(out.status, 0, out.stderr)
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(written.queue.map((q) => q.id), ['task-9', 'task-1'])
})

// Case 6: `plan` still writes nothing — now including git state, since the
// gate reads git for the first time. A `cat-file`/`show` read must never
// touch the index or the working tree. The tree snapshot deliberately covers
// `backlog/` rather than the whole project: `.git`'s own internals move for
// reasons that have nothing to do with this tool, and `status --porcelain` +
// `rev-parse HEAD` are the two observations that actually matter here.
test('plan on a git store writes nothing: the store, the state dir, git status and HEAD are all unchanged', (t) => {
  const { home, project } = planGitFixture(t)
  writeTask9(project)
  const before = snapshotTree(path.join(project, 'backlog'))
  const homeBefore = fs.readdirSync(home)
  const statusBefore = git(project, 'status', '--porcelain').stdout
  const headBefore = git(project, 'rev-parse', 'HEAD').stdout

  const out = plan(project, home, '--json')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(snapshotTree(path.join(project, 'backlog')), before)
  assert.deepEqual(fs.readdirSync(home), homeBefore)
  assert.equal(git(project, 'status', '--porcelain').stdout, statusBefore)
  assert.equal(git(project, 'rev-parse', 'HEAD').stdout, headBefore)
})

// Case 7: a dirty main tree is normal, not an error. Uncommitted changes to
// something that is not an item file say nothing about whether any item is
// committed, and the gate must not read them as a reason to refuse.
test('plan on a git store: an unrelated dirty tracked file changes no verdict', (t) => {
  const { home, project } = planGitFixture(t)
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture store, edited and not committed\n')

  const out = plan(project, home, '--ids', 'task-1', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ready')
  assert.deepEqual(item.reasons, [])
})

// Case 8: the fallback is silent. A store that is not a git work tree at all
// (this tool's own fixtures/store is precisely that) gates the working copy
// exactly as it always did, and says nothing about commits — otherwise every
// non-git case above would start carrying a reason it never asked for.
test('plan against a store that is not a git work tree falls back to the working copy and mentions no commit', (t) => {
  const { home, project } = planFixture(t)

  const out = plan(project, home, '--ids', 'task-1', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [item] = JSON.parse(out.stdout)
  assert.equal(item.gate, 'ready')
  assert.deepEqual(item.reasons, [])
  assert.ok(!/commit/i.test(out.stdout + out.stderr), `fallback should say nothing about commits: ${out.stdout}${out.stderr}`)
})

// --- Fix round 1 (Important): pidAlive's zombie fallback ------------------
// `process.kill(pid, 0)` alone can't tell a live process from an unreaped
// zombie (see pidAlive's own long comment for the full reasoning and the
// deliberately one-directional bias). Rather than deterministically
// manufacturing a real zombie process here — possible in principle, but
// only via a racy, platform-sensitive timing window (this file's own watch
// tests hit one BY ACCIDENT earlier in Task 5, before the zombie-reaping
// bug in the test harness itself was diagnosed and fixed — see the
// `runAsync` helper's own comment) — this pins the deterministic half of
// the fix: the pure string classification `isZombieStatState` reads real
// `ps -o stat=` output correctly. `pidAlive` itself stays covered
// end-to-end by the existing watch tests below, all of which exercise a
// REAL, non-zombie child process going through this exact function on
// every tick.
test('isZombieStatState treats a leading Z (zombie/defunct) as dead, everything else as alive', () => {
  assert.equal(isZombieStatState('Z'), true)
  assert.equal(isZombieStatState('Z+'), true)
  assert.equal(isZombieStatState('Z+\n'), true, 'ps output routinely carries a trailing newline')
  assert.equal(isZombieStatState('  Z+  '), true, 'leading/trailing whitespace must not defeat the check')
  assert.equal(isZombieStatState('S'), false)
  assert.equal(isZombieStatState('S+'), false)
  assert.equal(isZombieStatState('Ss'), false)
  assert.equal(isZombieStatState('R+'), false)
  assert.equal(isZombieStatState('D'), false)
  assert.equal(isZombieStatState(''), false)
})

// --- Task 5: watch --------------------------------------------------------
// Every case here uses a real `node -e` child (never a mock of process
// liveness) and the two checked-in stream-json fixture heads — see this
// file's own header comment for why, and the brief's own ban on ever
// invoking the real `claude` binary from an automated test.

// Test case 1: a short-lived child + stream-init.jsonl → exits 0 the moment
// the child dies, the fixture's session id landed in run.json via the same
// field cmdStage's own `--session` writes, and updatedAt strictly advanced.
test('watch exits 0 the moment a short-lived child dies, with the fixture session id landed in run.json and updatedAt moved', async (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-9', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))

  const child = spawnChild(t, 200)

  // runAsync, not the blocking `run()` — see that helper's own comment:
  // this test's own event loop must stay free to reap `child` the moment
  // it actually exits, or `child.pid` looks "alive" to watch's pid check
  // for as long as this test's process is blocked, zombie or not.
  const out = await runAsync(
    project, home, 'watch', 'task-9',
    '--pid', String(child.pid), '--jsonl', STREAM_INIT,
    '--interval-ms', '30', '--budget-ms', '5000',
  )

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  const item = after.queue.find((q) => q.id === 'task-9')
  assert.equal(item.sessionId, 'a1b2c3d4-5e6f-4a1b-8c2d-9f0e1a2b3c4d')
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt), 'updatedAt did not strictly advance')
})

// Test case 2: a long-lived child with a tiny budget → exits 3 (child still
// alive; the test kills it), having heartbeated at least twice along the
// way — sampled by polling run.json from a SEPARATE process while watch's
// own blocking loop runs, since watch itself is synchronous end-to-end (see
// orchestrate.mjs's own sleepSync comment for why that is safe here).
test('watch heartbeats at least twice before its budget elapses, then exits 3 with the child still alive', async (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-11', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const child = spawnChild(t, 60_000)
  const watchProc = spawn(
    'node',
    [SCRIPT, 'watch', 'task-11', '--pid', String(child.pid), '--jsonl', STREAM_NOINIT, '--interval-ms', '100', '--budget-ms', '300'],
    { cwd: project, env: { ...process.env, BM_ORCH_HOME: home } },
  )
  t.after(() => {
    try {
      watchProc.kill('SIGKILL')
    } catch {
      // already exited
    }
  })

  const file = runFile(home, project)
  const seen = new Set()
  const poll = setInterval(() => {
    try {
      seen.add(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt)
    } catch {
      // a transient read racing writeRunAtomic's rename — try again next tick
    }
  }, 20)

  const [code] = await once(watchProc, 'exit')
  clearInterval(poll)

  assert.equal(code, 3)
  assert.ok(seen.size >= 2, `expected at least two distinct heartbeats, saw ${seen.size}`)
  child.kill('SIGKILL')
})

// Test case 3: stream-noinit.jsonl (no init-type event anywhere in it) never
// crashes and never picks up the OTHER lines' own `session_id` fields —
// only a `type:"system","subtype":"init"` event counts. Exit is still
// governed purely by the pid rule.
test('watch with stream-noinit.jsonl never finds a session id, and still exits cleanly once the child dies', async (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-12', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const child = spawnChild(t, 200)

  // runAsync — see test case 1's own comment on why the blocking `run()`
  // would risk seeing a zombie `child` as falsely "alive."
  const out = await runAsync(
    project, home, 'watch', 'task-12',
    '--pid', String(child.pid), '--jsonl', STREAM_NOINIT,
    '--interval-ms', '30', '--budget-ms', '5000',
  )

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(after.queue.find((q) => q.id === 'task-12').sessionId, null)
})

// Fix round 1 (Minor): a leading line that isn't valid JSON at all must be
// skipped, not treated as a wedge — findSessionIdInJsonl's own lenient
// branch, pinned directly rather than only implied by stream-noinit.jsonl
// (which never has a bad line, only a plain absence of an init event).
test('watch skips a malformed leading line and still finds the session id on the line after it', async (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-15', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const child = spawnChild(t, 200)

  const out = await runAsync(
    project, home, 'watch', 'task-15',
    '--pid', String(child.pid), '--jsonl', STREAM_MALFORMED_THEN_INIT,
    '--interval-ms', '30', '--budget-ms', '5000',
  )

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(after.queue.find((q) => q.id === 'task-15').sessionId, 'deadbeef-1111-4fff-8fff-222222222222')
})

// Supplementary: a `--jsonl` file that never gets created is tolerated for
// exactly one interval (the child may not have opened it yet) but is a
// hard exit-1 the moment a SECOND check still finds it missing.
test('watch exits 1 when the jsonl file is still missing after the first interval', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-13', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const child = spawnChild(t, 60_000)
  const missingJsonl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-jsonl-')), 'never-written.jsonl')

  const out = run(
    project, home, 'watch', 'task-13',
    '--pid', String(child.pid), '--jsonl', missingJsonl,
    '--interval-ms', '30', '--budget-ms', '5000',
  )

  assert.equal(out.status, 1)
  assert.match(out.stderr, /never-written\.jsonl/)
  child.kill('SIGKILL')
})

// Supplementary: a "parse wedge" — `--jsonl` naming something that is not
// even readable as a file (here, a directory) — is a hard exit-1 on the
// very FIRST check, distinct from the missing-file grace period above.
test('watch exits 1 when --jsonl names something unreadable as a file at all (a parse wedge)', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-14', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const child = spawnChild(t, 60_000)
  const dirAsJsonl = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-wedge-'))
  t.after(() => fs.rmSync(dirAsJsonl, { recursive: true, force: true }))

  const out = run(
    project, home, 'watch', 'task-14',
    '--pid', String(child.pid), '--jsonl', dirAsJsonl,
    '--interval-ms', '30', '--budget-ms', '5000',
  )

  assert.equal(out.status, 1)
  child.kill('SIGKILL')
})

test('watch with no run exits 3 before ever touching the pid or jsonl file', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'watch', 'ghost-1', '--pid', '999999', '--jsonl', '/nonexistent')

  assert.equal(out.status, 3)
})

test('watch with an unknown item id exits 1', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const out = run(project, home, 'watch', 'ghost-1', '--pid', '999999', '--jsonl', '/nonexistent')

  assert.equal(out.status, 1)
})

test('watch missing --pid or --jsonl exits 1', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-1', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  assert.equal(run(project, home, 'watch', 'task-1', '--jsonl', STREAM_INIT).status, 1)
  assert.equal(run(project, home, 'watch', 'task-1', '--pid', '123').status, 1)
})

// --- Task 5: verify ---------------------------------------------------------
// verify's own `--cwd` is a SEPARATE directory from the project root
// resolveProjectRoot() finds from the CLI's own process cwd — exactly the
// worktree-vs-project-root split this file's header comment on
// resolveProjectRoot documents. Every test below spawns the CLI with `cwd:
// project` (so run.json resolves normally) while pointing `--cwd` at an
// unrelated throwaway directory standing in for "the item's worktree."

// Test case 4: backlog/verify.json with one passing, one failing command.
test('verify runs backlog/verify.json commands in order, capturing pass/fail and tails; exit 1 on any failure', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-1', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true })
  fs.writeFileSync(
    path.join(worktree, 'backlog', 'verify.json'),
    JSON.stringify({ commands: ['node -e "process.exit(0)"', 'node -e "console.error(\'boom\'); process.exit(1)"'] }),
  )

  const out = run(project, home, 'verify', 'task-1', '--cwd', worktree, '--json')

  assert.equal(out.status, 1, out.stderr)
  const rows = JSON.parse(out.stdout)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].cmd, 'node -e "process.exit(0)"')
  assert.equal(rows[0].ok, true)
  assert.equal(rows[1].ok, false)
  assert.match(rows[1].tail, /boom/)
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.deepEqual(written.queue[0].verification, rows)
})

// Test case 5: no verify.json, package.json with only a `test` script.
test('verify with no verify.json falls back to the package.json test script only', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-2', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))

  const out = run(project, home, 'verify', 'task-2', '--cwd', worktree, '--json')

  assert.equal(out.status, 0, out.stderr)
  const rows = JSON.parse(out.stdout)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].cmd, 'npm run test')
  assert.equal(rows[0].ok, true)
})

test('verify prefers pnpm run when pnpm-lock.yaml is present, and orders test/typecheck/build', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-3', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  fs.writeFileSync(path.join(worktree, 'pnpm-lock.yaml'), '')
  fs.writeFileSync(
    path.join(worktree, 'package.json'),
    JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"' } }),
  )

  const out = run(project, home, 'verify', 'task-3', '--cwd', worktree, '--json')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout).map((r) => r.cmd), ['pnpm run test', 'pnpm run typecheck', 'pnpm run build'])
})

// Test case 6: nothing resolvable at all → exit 5, zero rows written.
test('verify with nothing resolvable exits 5 and writes zero verification rows', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-4', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))

  const out = run(project, home, 'verify', 'task-4', '--cwd', worktree, '--json')

  assert.equal(out.status, 5)
  assert.deepEqual(JSON.parse(out.stdout), [])
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json must be untouched when nothing was resolved')
})

// Reuses Task 4's own extractDoneWhenCommands rather than a second parser —
// this is the test proving that reuse actually happened: a fenced `## Done
// when` block in the item's WORKTREE copy adds its own commands after the
// baseline, and an exact repeat of a baseline command collapses to one row.
test("verify appends the item's own fenced \"## Done when\" commands after the baseline, de-duplicating an exact repeat", (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-5', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  // Placed under done/, not open/ — by the time verify runs, backlog-execute
  // has typically already moved the item there (see the design spec's own
  // per-item loop, step 2), so verify's own item-file search must look in
  // both, not just open/ the way listOpenItems (the gate's own reader) does.
  fs.mkdirSync(path.join(worktree, 'backlog', 'tasks', 'done'), { recursive: true })
  fs.writeFileSync(
    path.join(worktree, 'backlog', 'tasks', 'done', 'task-5-fixture.md'),
    '---\nid: task-5\ntitle: Some task\ncreated: 2026-08-01\n---\n\n## Plan\n\nDone.\n\n## Done when\n\n```bash\nnode -e "process.exit(0)"\necho only-in-done-when\n```\n',
  )
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: ['node -e "process.exit(0)"'] }))

  const out = run(project, home, 'verify', 'task-5', '--cwd', worktree, '--json')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout).map((r) => r.cmd), ['node -e "process.exit(0)"', 'echo only-in-done-when'])
})

// Fix round 1 (Minor): a non-string entry in verify.json's own `commands`
// array must be a clean, code-1 OrchestrateError — not a raw exception from
// handing a number/object straight to `spawnSync` inside runVerifyCommand.
// Also pins that this is a HARD failure, never silently treated as "no
// verify.json" and quietly falling back to package.json scripts.
test('verify.json with a non-string commands entry exits 1 with a clean message, and writes nothing', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-6', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = fs.readFileSync(runFile(home, project))

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: ['node -e "process.exit(0)"', 42] }))

  const out = run(project, home, 'verify', 'task-6', '--cwd', worktree, '--json')

  assert.equal(out.status, 1)
  assert.match(out.stderr, /commands.*string/i)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json must be untouched on a malformed verify.json')
})

// Final-review Important 4: Node's default spawnSync maxBuffer is 1 MiB, and
// a PASSING command that prints more than that is SIGTERMed — `status` comes
// back `null`, so `status === 0` is false and a green suite is recorded red.
// This test pins the fix by asserting the honest outcome (exit 0, `ok: true`)
// for a command that exits 0 after ~1.6 MiB of stdout; against the old code
// it fails on both the exit status (1) and the row (`ok: false`). The volume
// is generated by the command itself rather than by a fixture file, so the
// 1 MiB threshold is crossed by the CHILD's output — the thing maxBuffer
// actually bounds — and not by anything on disk.
test('verify records a passing command that prints more than 1 MiB as passing, not as a failure', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-7', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true })
  const chatty = `node -e "for (let i=0;i<20000;i++) console.log('x'.repeat(80))"`
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: [chatty] }))

  const out = run(project, home, 'verify', 'task-7', '--cwd', worktree, '--json')

  assert.equal(out.status, 0, out.stderr)
  const rows = JSON.parse(out.stdout)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ok, true, `a command that exits 0 must be recorded ok: ${rows[0].tail}`)
  // The row is still a TAIL, not the whole 1.6 MiB — the bigger buffer buys
  // an honest exit status, it does not widen what gets stored on the run.
  assert.ok(rows[0].tail.split('\n').length <= 20)
})

// Same finding, the other half: `result.error` is "we could not run this
// command", which must never be recorded as if the command had run and
// reported a failure. E2BIG is the one such error a test can provoke without
// touching the environment — a command string past the OS argument limit —
// and spawnSync returns it with `status: null` and `signal: null`, i.e. the
// exact shape the old `status === 0` line silently reduced to "failed".
test('verify distinguishes "could not run this command" from a command that ran and failed', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-8', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true })
  const unspawnable = `true # ${'a'.repeat(3 * 1024 * 1024)}`
  fs.writeFileSync(
    path.join(worktree, 'backlog', 'verify.json'),
    JSON.stringify({ commands: [unspawnable, 'node -e "console.error(\'real failure\'); process.exit(1)"'] }),
  )

  const out = run(project, home, 'verify', 'task-8', '--cwd', worktree)

  // Rows read back from the run file, not from stdout, and deliberately
  // without `--json`: the megabyte-long command string is echoed inside every
  // row, and main()'s `process.exit(...)` truncates a pipe write that large
  // (a pre-existing property of the CLI, unrelated to this test's subject).
  // run.json is written before anything is printed, so the file is the whole
  // and honest record either way — which is the thing worth asserting on.
  //
  // Both rows are red — an unrunnable command is no more proof the item works
  // than a failing one — but they do not read the same.
  assert.equal(out.status, 1)
  const rows = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].verification
  assert.equal(rows[0].ok, false)
  assert.match(rows[0].tail, /could not run this command \(E2BIG\)/)
  assert.equal(rows[1].ok, false)
  assert.match(rows[1].tail, /real failure/)
  assert.doesNotMatch(rows[1].tail, /could not run this command/)
})

test('verify with no run exits 3', (t) => {
  const { home, project } = orchFixture(t)
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))

  const out = run(project, home, 'verify', 'task-1', '--cwd', worktree)

  assert.equal(out.status, 3)
})

test('verify with an unknown item id exits 1 and writes nothing', (t) => {
  const { home, project } = orchFixture(t)
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  const before = fs.readFileSync(runFile(home, project))
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))

  const out = run(project, home, 'verify', 'ghost-1', '--cwd', worktree)

  assert.equal(out.status, 1)
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))))
})

test('verify without --cwd exits 1', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-1', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const out = run(project, home, 'verify', 'task-1')

  assert.equal(out.status, 1)
})

// --- Task 5: reconcile -------------------------------------------------
// Read-only, always — every test below either asserts run.json is
// byte-identical before/after, or (like the plan section's own case 8)
// simply never gives reconcile a reason its file would need writing in the
// first place. Real git worktrees throughout, per this file's own
// commitEverything/spawnChild header comment.

test('reconcile suggests redispatch-after-stop when the worktree survives with an in-progress phase: marker but no recorded session id', (t) => {
  const { home, project } = orchFixture(t)
  const itemFile = seedReadyTask(project, 'task-20', 'Some task')
  commitEverything(project, 'seed')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktreePath = path.join(project, '.worktrees', 'task-20')
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-20', 'HEAD'], { encoding: 'utf8' }).status, 0)
  assert.equal(run(project, home, 'stage', 'task-20', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-20').status, 0)

  // Simulate a crashed execute session: `start --as execute` wrote
  // started:/phase: onto the WORKTREE's own copy, uncommitted (execute
  // never commits — see the design spec's per-item loop) — and no session
  // id, because the crash happened before watch's own jsonl parse ever
  // caught the init event.
  const worktreeItemFile = path.join(worktreePath, 'backlog', 'tasks', 'open', path.basename(itemFile))
  const original = fs.readFileSync(worktreeItemFile, 'utf8')
  fs.writeFileSync(worktreeItemFile, original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---'))

  const before = fs.readFileSync(runFile(home, project))
  const out = run(project, home, 'reconcile', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-20')
  assert.equal(row.suggestion, 'redispatch-after-stop')
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'reconcile must never write to run.json')
})

test('reconcile suggests resume-session when a session id is already recorded and the marker is still live', (t) => {
  const { home, project } = orchFixture(t)
  const itemFile = seedReadyTask(project, 'task-21', 'Some task')
  commitEverything(project, 'seed')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktreePath = path.join(project, '.worktrees', 'task-21')
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-21', 'HEAD'], { encoding: 'utf8' }).status, 0)
  assert.equal(
    run(project, home, 'stage', 'task-21', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-21', '--session', 'sess-abc').status,
    0,
  )
  const worktreeItemFile = path.join(worktreePath, 'backlog', 'tasks', 'open', path.basename(itemFile))
  const original = fs.readFileSync(worktreeItemFile, 'utf8')
  fs.writeFileSync(worktreeItemFile, original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---'))

  const out = run(project, home, 'reconcile', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-21')
  assert.equal(row.suggestion, 'resume-session')
})

// Test case 7: the recorded worktree was deleted out-of-band (a plain
// `rm -rf`, never `git worktree remove` — exactly what a crash or a human
// cleaning up by hand leaves behind: git's own admin entry and the branch
// survive, the working directory does not). No file survives to read a
// marker from, so the only honest suggestion is `inspect`, never a
// redispatch that would silently skip billing a marker nobody can see.
test('reconcile suggests inspect when the recorded worktree was deleted out-of-band, since no marker can be read', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-22', 'Some task')
  commitEverything(project, 'seed')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktreePath = path.join(project, '.worktrees', 'task-22')
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-22', 'HEAD'], { encoding: 'utf8' }).status, 0)
  assert.equal(run(project, home, 'stage', 'task-22', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-22').status, 0)
  fs.rmSync(worktreePath, { recursive: true, force: true })

  const before = fs.readFileSync(runFile(home, project));
  const out = run(project, home, 'reconcile', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-22')
  assert.equal(row.suggestion, 'inspect')
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'reconcile must never write to run.json')
})

test('reconcile suggests park when neither the worktree directory nor the branch ever actually exist', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-23', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  assert.equal(
    run(
      project, home, 'stage', 'task-23', 'dispatched',
      '--worktree', path.join(project, '.worktrees', 'task-23'), '--branch', 'backlog/task-23',
    ).status,
    0,
  )

  const out = run(project, home, 'reconcile', '--json')

  assert.equal(out.status, 0, out.stderr)
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-23')
  assert.equal(row.suggestion, 'park')
})

test('reconcile only reports non-terminal queue items, skipping merged/etc', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-24', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)
  assert.equal(run(project, home, 'stage', 'task-24', 'merged').status, 0)

  const out = run(project, home, 'reconcile', '--json')

  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout), [])
})

test('reconcile with no run exits 3', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'reconcile')

  assert.equal(out.status, 3)
})

// --- Task 5: abort -------------------------------------------------------

// Test case 8.
test('abort removes a real worktree and its branch, then finishes the run as aborted', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-26', 'Some task')
  commitEverything(project, 'seed')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktreePath = path.join(project, '.worktrees', 'task-26')
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-26', 'HEAD'], { encoding: 'utf8' }).status, 0)
  assert.equal(run(project, home, 'stage', 'task-26', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-26').status, 0)

  const out = run(project, home, 'abort')

  assert.equal(out.status, 0, out.stderr)
  assert.equal(fs.existsSync(worktreePath), false)
  const branchList = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-26'], { encoding: 'utf8' })
  assert.equal(branchList.stdout.trim(), '')
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(after.status, 'aborted')
  // Fix round 1 (Minor): the one-line human-readable summary — this is the
  // simple "everything torn down cleanly" case, so it names the removed id
  // and reports nothing preserved.
  assert.match(out.stdout, /removed 1 item\(s\) \(task-26\)/)
  assert.match(out.stdout, /left 0 in place/)
})

// Fix round 1 (Important): an earlier version of abort recorded the marker
// in `attention` with instructions to run `backlog.mjs stop` "before the
// worktree is discarded" and then discarded the worktree in the very same
// loop iteration — making that instruction impossible to follow by the time
// anyone could read it, and destroying whatever uncommitted work the live
// session had done. The fix: a marker-carrying item's worktree AND branch
// are left COMPLETELY ALONE (neither `git worktree remove` nor `git branch
// -D` ever runs for it) — see cmdAbort's own header comment for the full
// three-part reasoning. This test asserts the worktree, its item file, and
// its branch all survive byte-for-byte, and that the attention entry names
// both the absolute path and the exact `backlog.mjs stop` command.
test('abort leaves a marker-carrying worktree and its branch completely alone, and names the exact recovery command in attention', (t) => {
  const { home, project } = orchFixture(t)
  const itemFile = seedReadyTask(project, 'task-10', 'Some task')
  commitEverything(project, 'seed')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const worktreePath = path.join(project, '.worktrees', 'task-10')
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-10', 'HEAD'], { encoding: 'utf8' }).status, 0)
  assert.equal(run(project, home, 'stage', 'task-10', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-10').status, 0)

  const worktreeItemFile = path.join(worktreePath, 'backlog', 'tasks', 'open', path.basename(itemFile))
  const original = fs.readFileSync(worktreeItemFile, 'utf8')
  const marked = original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---')
  fs.writeFileSync(worktreeItemFile, marked)

  const out = run(project, home, 'abort')

  assert.equal(out.status, 0, out.stderr)
  // The worktree, its branch, AND its (uncommitted) marked item file all
  // survive byte-for-byte — this tool never touched any of it.
  assert.equal(fs.existsSync(worktreePath), true)
  assert.equal(fs.readFileSync(worktreeItemFile, 'utf8'), marked)
  const branchList = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-10'], { encoding: 'utf8' })
  assert.match(branchList.stdout, /backlog\/task-10/)

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(after.status, 'aborted', 'abort must still finish the run overall')
  assert.equal(after.attention.length, 1)
  assert.equal(after.attention[0].id, 'task-10')
  assert.match(after.attention[0].detail, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'attention must name the absolute worktree path')
  assert.match(after.attention[0].detail, /backlog\.mjs stop task-10/, 'attention must name the exact recovery command')

  assert.match(out.stdout, /left 1 in place with an in-progress marker \(task-10/)
})

// Fix round 1 (Important) — the exact scenario the review asked to pin: a
// mixed run with ONE clean item and ONE marker-carrying item. Abort must
// still complete for everything else — the clean item's worktree/branch are
// torn down exactly as before, only the marked item's survive.
test('abort tears down a clean item normally while leaving a marker-carrying item in the same run untouched', (t) => {
  const { home, project } = orchFixture(t)
  const cleanItemFile = seedReadyTask(project, 'task-17', 'A clean task')
  const markedItemFile = seedReadyTask(project, 'task-18', 'A marked task')
  commitEverything(project, 'seed')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const cleanWorktree = path.join(project, '.worktrees', 'task-17')
  const markedWorktree = path.join(project, '.worktrees', 'task-18')
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', cleanWorktree, '-b', 'backlog/task-17', 'HEAD'], { encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', markedWorktree, '-b', 'backlog/task-18', 'HEAD'], { encoding: 'utf8' }).status, 0)
  assert.equal(run(project, home, 'stage', 'task-17', 'dispatched', '--worktree', cleanWorktree, '--branch', 'backlog/task-17').status, 0)
  assert.equal(run(project, home, 'stage', 'task-18', 'dispatched', '--worktree', markedWorktree, '--branch', 'backlog/task-18').status, 0)

  const markedWorktreeItemFile = path.join(markedWorktree, 'backlog', 'tasks', 'open', path.basename(markedItemFile))
  const original = fs.readFileSync(markedWorktreeItemFile, 'utf8')
  fs.writeFileSync(markedWorktreeItemFile, original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---'))
  void cleanItemFile // seeded only so task-17 gates into the queue; not otherwise inspected

  const out = run(project, home, 'abort')

  assert.equal(out.status, 0, out.stderr)

  // The clean item: torn down exactly as before the fix.
  assert.equal(fs.existsSync(cleanWorktree), false)
  const cleanBranch = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-17'], { encoding: 'utf8' })
  assert.equal(cleanBranch.stdout.trim(), '')

  // The marked item: worktree AND branch both survive, exactly as seeded.
  assert.equal(fs.existsSync(markedWorktree), true)
  const markedBranch = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-18'], { encoding: 'utf8' })
  assert.match(markedBranch.stdout, /backlog\/task-18/)

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(after.status, 'aborted', 'abort must complete for the whole run, not just the clean item')
  assert.equal(after.attention.length, 1)
  assert.equal(after.attention[0].id, 'task-18')
  assert.match(after.attention[0].detail, new RegExp(markedWorktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'attention must name the surviving worktree path')

  assert.match(out.stdout, /removed 1 item\(s\) \(task-17\)/)
  assert.match(out.stdout, /left 1 in place with an in-progress marker \(task-18/)
})

test('abort on a run with a never-dispatched pending item does nothing destructive and still finishes aborted', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-25', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const out = run(project, home, 'abort')

  assert.equal(out.status, 0, out.stderr)
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'))
  assert.equal(after.status, 'aborted')
  assert.deepEqual(after.attention, [])
})

test('abort with no run exits 3', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'abort')

  assert.equal(out.status, 3)
})

// --- bug-3: the dispatch flag, and the denial check that makes it safe ----
// Two halves of one fix. The guard below pins the flag itself, because a
// flag is the kind of thing that gets quietly pasted back in by anyone
// debugging a stuck dispatch; the reader tests below pin the check that
// exists precisely because a milder flag can now refuse a call, and a
// refused call is invisible in every other signal the run produces (exit
// code 0, result subtype "success", is_error false — all three measured on
// this machine against CLI 2.1.250).

const SKILL_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md')
const SKILLS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('both of SKILL.md\'s headless dispatch lines carry --permission-mode auto', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8')
  // Every line that actually launches a headless session — the step 4
  // dispatch and step 5's --resume retry. Matched by `claude -p` rather
  // than by line number so the assertion survives the file growing, which
  // it already did once between this bug being filed and being fixed.
  const dispatchLines = text.split('\n').filter((l) => l.includes('exec claude -p'))
  assert.equal(dispatchLines.length, 2, `expected exactly 2 headless dispatch lines, found ${dispatchLines.length}`)
  for (const line of dispatchLines) {
    assert.ok(line.includes('--permission-mode auto'), `dispatch line is missing --permission-mode auto: ${line}`)
  }
})

test('no command anywhere under skills/ passes --dangerously-skip-permissions', () => {
  // A whole-tree sweep rather than a check on the two dispatch lines above:
  // the point is not that those two are clean, it is that nothing in the
  // published skill surface hands the flag to a CLI. Reinstating it would be
  // a one-word edit nobody reviewing a diff would necessarily flag, and it
  // buys back the top of the permission ladder for a job that measurably
  // does not need it.
  //
  // Two matchers, because the flag can be reintroduced two ways. The first
  // catches an invocation on one line (`claude … --dangerously-skip-
  // permissions`). The second catches one split across a fenced block's
  // continuation lines, which is how a shell command in a SKILL.md would
  // most plausibly grow long enough to hide it. Prose *naming* the flag is
  // deliberately allowed — this fix's own explanation of why the flag is
  // gone has to be able to say the word, and a guard that forbade that
  // would push the reasoning out of the file it belongs in.
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
      } else if (entry.isFile()) {
        const text = fs.readFileSync(full, 'utf8')
        if (!text.includes('--dangerously-skip-permissions')) continue
        for (const line of text.split('\n')) {
          if (line.includes('--dangerously-skip-permissions') && /\bclaude\b/.test(line)) {
            offenders.push(`${full}: ${line.trim()}`)
          }
        }
        if (full.endsWith('.md')) {
          // Fenced blocks are executable content in a SKILL.md, prose is
          // not — so inside a fence the flag is an offence wherever it sits,
          // continuation line included.
          let inFence = false
          for (const line of text.split('\n')) {
            if (line.startsWith('```')) { inFence = !inFence; continue }
            if (inFence && line.includes('--dangerously-skip-permissions')) {
              offenders.push(`${full} (in a fenced block): ${line.trim()}`)
            }
          }
        }
      }
    }
  }
  walk(SKILLS_ROOT)
  assert.deepEqual(offenders, [], `--dangerously-skip-permissions is back in:\n${offenders.join('\n')}`)
})

const STREAM_DENIAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-denial.jsonl')
const STREAM_NO_DENIALS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-no-denials.jsonl')
const STREAM_DENIAL_PARTIAL_TAIL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-denial-partial-tail.jsonl')
const STREAM_TWO_RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-two-results.jsonl')
const STREAM_NO_RESULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-no-result.jsonl')

test('readPermissionDenials returns the denial recorded on the result event', () => {
  const denials = readPermissionDenials(STREAM_DENIAL)
  assert.equal(denials.length, 1)
  assert.equal(denials[0].tool_name, 'Bash')
  assert.match(denials[0].tool_input.command, /^curl -X POST/)
})

test('readPermissionDenials reads an absent permission_denials field as no denials', () => {
  assert.deepEqual(readPermissionDenials(STREAM_NO_DENIALS), [])
})

test('readPermissionDenials finds a denial ahead of a partial trailing line', () => {
  const denials = readPermissionDenials(STREAM_DENIAL_PARTIAL_TAIL)
  assert.equal(denials.length, 1)
  assert.equal(denials[0].tool_use_id, 'toolu_01PartialTailProbe')
})

test('readPermissionDenials takes the LAST result event when a resumed transcript holds several', () => {
  // First result clean, second refused. A reader that stopped at the first
  // would clear a resumed run whose retry never ran the command it needed.
  const denials = readPermissionDenials(STREAM_TWO_RESULTS)
  assert.equal(denials.length, 1)
  assert.equal(denials[0].tool_use_id, 'toolu_01ResumedRunDenial')
})

test('readPermissionDenials returns no denials for a transcript that has no result event at all', () => {
  // The crashed-session shape watch already knows about: the child died
  // before it could summarise anything. "No denials recorded" is the honest
  // answer — step 5 judges that run by the item file, as it always has.
  //
  // Its own fixture rather than the reused stream-noinit.jsonl, which was
  // the first thing this test pointed at and was wrong: that file DOES carry
  // a result event (one with no permission_denials key), so this test was a
  // second copy of the absent-field case above it and the branch it is named
  // for — the loop never matching a result event at all, so the initial []
  // is what comes back — went uncovered.
  assert.deepEqual(readPermissionDenials(STREAM_NO_RESULT), [])
})

test('denials --jsonl prints the denial count and the denials themselves', (t) => {
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'denials', '--jsonl', STREAM_DENIAL)

  assert.equal(out.status, 0, out.stderr)
  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.count, 1)
  assert.equal(parsed.denials[0].tool_name, 'Bash')
})

test('denials on a missing --jsonl exits 1 rather than reporting a clean run', (t) => {
  // The failure mode worth spending an exit code on: an unreadable
  // transcript answering "no denials" is indistinguishable from a clean run,
  // and step 5 would merge on it.
  const { home, project } = orchFixture(t)

  const out = run(project, home, 'denials', '--jsonl', path.join(project, 'nope.jsonl'))

  assert.equal(out.status, 1)
})

test('stage <id> dispatched --permission-mode records the mode on the queue item', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-7', 'Some task')
  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const out = run(project, home, 'stage', 'task-7', 'dispatched', '--worktree', '/tmp/w', '--branch', 'backlog/task-7', '--permission-mode', 'auto')

  assert.equal(out.status, 0, out.stderr)
  const item = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-7')
  assert.equal(item.permissionMode, 'auto')
})

test('a queue item starts with a null permissionMode, before any dispatch has chosen one', (t) => {
  const { home, project } = orchFixture(t)
  seedReadyTask(project, 'task-8', 'Some task')

  assert.equal(run(project, home, 'init', '--project', project).status, 0)

  const item = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-8')
  assert.equal(item.permissionMode, null)
})

test('every step that runs a headless session checks its transcript for denials before committing', () => {
  // The structural half of the denials gate, and the one a reading of step 5
  // alone misses. Two paths in this file run a session and then commit its
  // work: step 5 (dispatch → Inspect → Commit) and step 7's fix loop
  // (resume → watch → Commit, reaching Commit WITHOUT passing back through
  // step 5). The gate was added to the first and not the second, so a fix
  // loop's denial would have been committed and merged with every other
  // signal reporting success — which is exactly the shape of bug this whole
  // check exists to catch, reappearing one section over.
  //
  // Asserted by section rather than by line number so the file can keep
  // growing, which it does constantly. If a section is renamed, update the
  // titles here — do not delete the case.
  const text = fs.readFileSync(SKILL_MD, 'utf8')
  const sections = new Map()
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.slice(3).trim()
      sections.set(current, [])
    } else if (current !== null) {
      sections.get(current).push(line)
    }
  }
  const MUST_CHECK = ['5. Inspect what the session left behind', '7. Review']
  for (const title of MUST_CHECK) {
    assert.ok(sections.has(title), `section not found (renamed?): ${title}`)
    const body = sections.get(title).join('\n')
    assert.ok(
      body.includes('orchestrate.mjs" denials --jsonl'),
      `section "${title}" runs a session and then commits, but never checks its transcript for denials`
    )
  }
})
