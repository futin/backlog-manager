import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RUN_STALE_MS,
  TRACKER_POLL_WINDOW_MS,
  archiveStem,
  controlFilePath,
  controlHome,
  isZombieStatState,
  pauseRequestEffective,
  readPermissionDenials,
  readSessionUsage,
  stopRequestEffective,
  trackerPollAgeText,
  trackerRetryDelayMs
} from './orchestrate.mjs';

// The namespace import is for exports a later case reaches for by name, so a missing export fails ITS case rather
// than the whole file's link step.
import * as orch from './orchestrate.mjs';

const SCRIPT = fileURLToPath(new URL('./orchestrate.mjs', import.meta.url));

// Task 5's own fixtures: a realistic `claude -p --output-format stream-json`
// transcript head that DOES carry the init event (and therefore the session
// id), and one that never does — see watch's own test cases 1 and 3.
const STREAM_INIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-init.jsonl');
const STREAM_NOINIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-noinit.jsonl');
// Fix round 1 (Minor): a leading line that isn't valid JSON at all, ahead of
// a real init event — pins findSessionIdInJsonl's malformed-line-skip branch
// (a bad line is swallowed and parsing continues, it is never a wedge).
const STREAM_MALFORMED_THEN_INIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-malformed-then-init.jsonl');

// The jest-side fixture is the authority for the run/queue-item key set —
// see shared/types.ts's RunStage/RunQueueItem/RunAttention/OrchestratorRun
// block, which this fixture was hand-built to satisfy. Path-referenced
// rather than copied, per the brief: a copy could drift from the original
// the moment either side is edited without touching the other; reading the
// exact same file both suites already depend on means there is only ever
// one fixture to keep in sync with shared/types.ts.
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'orchestrator-run.json');

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
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-home-')));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-project-')));
  spawnSync('git', ['-C', project, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  // task-17: the pause-request directory, derived from `home` rather than
  // mkdtemp'd separately so `run()` below can pin it from the one argument
  // every existing call already passes — the alternative was a signature
  // change on every call site in this file, which would have made the
  // harness change visible to (and therefore capable of breaking) tests that
  // have nothing to do with pausing. Pinned for exactly the reason
  // BM_ORCH_HOME is: this directory is one the SERVER writes for real, under
  // a developer's `~/.backlog-manager/settings/`, and a test that reached it
  // could pause a real run.
  const control = `${home}-control`;
  fs.mkdirSync(control, { recursive: true });
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(control, { recursive: true, force: true });
  });
  return { home, project, control };
}

// Spawns the real CLI as a child process with BM_ORCH_HOME pinned to this
// test's own throwaway home — never the ambient environment's value, so a
// developer's real orchestrator state can never leak into, or be clobbered
// by, a test run.
//
// `maxBuffer` is raised off spawnSync's 1MB default because task-34 made the
// CLI's stdout arrive WHOLE: the entry guard used to `process.exit()`, which
// truncated every pipe write at 65,536 bytes, so no test could ever reach the
// default. The E2BIG case below echoes a deliberately 3MB-long command back in
// its human-readable output, and over the default spawnSync SIGTERMs the child
// and reports `status: null` — a killed process rather than the exit code the
// case is about. A shell, which is what really runs this tool, has no such
// limit; the ceiling here exists only so the harness stops being the narrower
// pipe of the two.
const CLI_MAX_BUFFER = 64 * 1024 * 1024;

// #246: the session identity is pinned too, for the same reason BM_ORCH_HOME
// is — the ambient value must not decide what a test sees. The driver lease is
// keyed on CLAUDE_CODE_SESSION_ID, and inheriting it meant `run()` behaved as a
// leased session inside Claude Code and as a hand-run terminal everywhere else:
// `unpause`'s case asserted on `driver.at` and passed in a session, then read
// `driver: null` from a plain terminal and threw. Every `run()` caller is now one
// fixed session wherever the suite runs; a case that wants the terminal (or a
// second session) says so through `runAs` below.
const TEST_SESSION_ID = 'sess-test';

function run(cwd, home, ...args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd,
    maxBuffer: CLI_MAX_BUFFER,
    env: { ...process.env, BM_ORCH_HOME: home, BM_ORCH_CONTROL_HOME: `${home}-control`, CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID }
  });
}

// Project keying is encodeURIComponent(<abs path>), reversible with
// decodeURIComponent — asserted directly against the CLI's own file layout
// here so every other test in this file can compute where run.json landed
// without re-deriving the encoding itself.
function runFile(home, project) {
  return path.join(home, encodeURIComponent(project), 'run.json');
}

function runsDir(home, project) {
  return path.join(home, encodeURIComponent(project), 'runs');
}

// The control file's own path, mirroring `runFile` above: one file per
// project, keyed the same encodeURIComponent way, but FLAT under the control
// root rather than inside a per-project directory — there is only ever one
// control fact per project, so there is nothing for a directory to hold.
function controlFile(home, project) {
  return path.join(`${home}-control`, `${encodeURIComponent(project)}.json`);
}

// Writes a pause request exactly as the server's `writePauseRequest` does.
// Hand-written here rather than imported: the tool and the server keep two
// copies of this shape on purpose (a skill's tools/ may never import from
// the server), and a test that reached across for the server's writer would
// hide a drift between them instead of catching it.
function writeControl(home, project, body) {
  fs.mkdirSync(`${home}-control`, { recursive: true });
  fs.writeFileSync(controlFile(home, project), typeof body === 'string' ? body : JSON.stringify(body));
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
  const dir = path.join(project, 'backlog', 'tasks', 'open');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-fixture.md`);
  fs.writeFileSync(
    file,
    `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-08-01\n---\n\n## Goal\n\nSomething worth doing.\n\n## Plan\n\nDo the actual work described here, in enough detail that it counts as groomed.\n\n## Test cases\n\n## Done when\n`
  );
  return file;
}

// The bug twin of seedReadyTask above, for the handful of tests that seed a
// bug id instead of a task id.
function seedReadyBug(project, id, title) {
  const dir = path.join(project, 'backlog', 'bugs', 'open');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-fixture.md`);
  fs.writeFileSync(
    file,
    `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-08-01\n---\n\n## Symptom\n\nSomething is wrong.\n\n## Repro\n\nSteps to reproduce it.\n\n## Affects\n\nsomefile.ts\n\n## Cause\n\nThe real, diagnosed cause.\n\n## Fix\n\nThe real fix — not the placeholder.\n`
  );
  return file;
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
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead — nothing to clean up
    }
  });
  return child;
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
  const proc = spawn('node', [SCRIPT, ...args], { cwd, env: { ...process.env, BM_ORCH_HOME: home, CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID } });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    stdout += d;
  });
  proc.stderr.on('data', (d) => {
    stderr += d;
  });
  const [status] = await once(proc, 'exit');
  return { status, stdout, stderr };
}

// `git worktree add <path> -b <branch> HEAD` needs an actual commit for HEAD
// to resolve to — orchFixture's repo is `git init -q` with no commits at
// all, which every OTHER test in this file is fine with (orchestrate.mjs
// only ever needs a `.git` entry to exist, never a commit). Only the abort/
// reconcile tests below exercise real worktree/branch plumbing, so only
// they call this. A throwaway local identity (`-c user.email=…`) keeps this
// independent of whatever global git config this machine happens to have.
function commitEverything(project, message) {
  spawnSync('git', ['-C', project, 'add', '-A'], { encoding: 'utf8' });
  const result = spawnSync('git', ['-C', project, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message], {
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`);
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
  assert.equal(RUN_STALE_MS, 900000);
});

// --- Test case 1: init's shape matches the contract fixture exactly --------

test('init writes a run.json whose key set matches the contract fixture exactly, for the run and for a queue item', (t) => {
  const { home, project } = orchFixture(t);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  seedReadyBug(project, 'bug-14', 'Fix duplicate heartbeat write on a resumed run');

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));

  assert.deepEqual(new Set(Object.keys(written)), new Set(Object.keys(fixture)));
  assert.equal(written.queue.length, 1);
  assert.deepEqual(new Set(Object.keys(written.queue[0])), new Set(Object.keys(fixture.queue[0])));
});

test('init prints { runId, dir } JSON on success', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  const printed = JSON.parse(out.stdout);
  assert.match(printed.runId, /^run-\d{8}-\d{6}$/);
  assert.equal(printed.dir, path.join(home, encodeURIComponent(project)));
});

test('init with no backlog store and no --ids writes an empty queue — a run with nothing gated yet is valid', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(written.queue, []);
  assert.deepEqual(written.attention, []);
  assert.equal(written.status, 'running');
  assert.equal(written.maxItems, null);
});

test('init --project must be an absolute path — a relative one is a usage error, nothing written', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', 'not/absolute');

  assert.equal(out.status, 1);
  assert.equal(fs.existsSync(runFile(home, project)), false);
});

// --- Test case 2: a fresh running lock refuses a second init, untouched ----

test('init twice in a row: the second call exits 4 while the first is still fresh, and the first file is byte-identical after', (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(runFile(home, project));

  const second = run(project, home, 'init', '--project', project);

  assert.equal(second.status, 4);
  // The lock refusal must name the way forward — a stale run's recovery
  // path — so a human staring at this message is never left guessing.
  assert.match(second.stderr, /--resume/);
  assert.match(second.stderr, /--abort/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json changed even though init was refused');
});

// Fix round 1 (Important #1): the fresh-lock case above was the only lock
// coverage — the stale branch (a crashed run: status still "running" but
// the heartbeat is old) is the highest-stakes branch in this file, since it
// is the one a human is most likely to hit for real, and it had zero test
// coverage. Simulates a crash by hand-editing updatedAt to well past
// RUN_STALE_MS while leaving status "running", exactly the shape a killed
// orchestrator process would leave behind.
test('init over a stale "running" run also refuses (exit 4), names --resume/--abort, and leaves the file and directory untouched', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  stale.updatedAt = new Date(Date.now() - RUN_STALE_MS - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stale, null, 2) + '\n');
  const before = fs.readFileSync(file);

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 4);
  assert.match(out.stderr, /--resume/);
  assert.match(out.stderr, /--abort/);
  assert.match(out.stderr, /stale|crash/i);
  assert.ok(before.equals(fs.readFileSync(file)), 'a stale-but-running run.json was modified even though init was refused');
  const dir = path.join(home, encodeURIComponent(project));
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    []
  );
});

// --- Test case 3: init over a done run archives it and starts fresh --------

test('init over a status:"done" run archives the old file to runs/<runId>.json and writes a fresh running run', (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const firstRunId = JSON.parse(first.stdout).runId;
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  const second = run(project, home, 'init', '--project', project);

  assert.equal(second.status, 0, second.stderr);
  const archived = fs.readdirSync(runsDir(home, project));
  assert.deepEqual(archived, [`${firstRunId}.json`]);
  const archivedRun = JSON.parse(fs.readFileSync(path.join(runsDir(home, project), `${firstRunId}.json`), 'utf8'));
  assert.equal(archivedRun.status, 'done');

  const current = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(current.status, 'running');
});

// A second archive after the resumed run also finishes proves pastRuns is
// counted off the archive directory, not carried on the run file itself.
// (Since task-31 that count is the listing filtered to `.json`; no sidecars
// are seeded here, so this case's runs/ holds two files and nothing else.)
test('a second done-then-init cycle grows runs/ to two archived files', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'aborted').status, 0);

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readdirSync(runsDir(home, project)).length, 2);
});

// --- task-31: a run's SIDECAR directories are archived beside its run file --
//
// Before this, `init` archived `run.json` alone and left `<dir>/logs`,
// `<dir>/reviews`, `<dir>/verify`, `<dir>/questions` (and whatever else a
// driver invented) flat and project-scoped, keyed by item id — so an item
// dispatched in two runs had its first transcript, reviewer report and
// verify output silently overwritten by its second. Every case below seeds
// the sidecars by hand, because nothing in this suite creates them: the
// directories are made by drivers following SKILL.md prose (`mkdir -p
// "<dir>/logs"`), never by the tool, which is also why the archiver uses a
// DENYLIST of two rather than an allowlist of the five names known today.

// The per-project state directory itself — the parent `runFile`/`runsDir`
// above both point into. Sidecar seeding needs the parent, not either child.
function projStateDir(home, project) {
  return path.join(home, encodeURIComponent(project));
}

// Writes one sidecar file at `<dir>/<rel>`, creating its parents. `rel` is
// a POSIX-ish relative path ('logs/bug-1.jsonl'); joined a segment at a time
// so this reads the same on any platform the suite runs on.
function seedSidecar(home, project, rel, body) {
  const target = path.join(projStateDir(home, project), ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

// Two runs in the same wall-clock second get the SAME runId (makeRunId is
// second-precision), and archiveStem then files the second one under
// `<runId>-2`. That collision is correct behaviour with its own unit case
// above — but a test that wants to talk about "run 1's archive" and "run 2's
// archive" BY RUN ID needs the two ids to actually differ, so it waits out
// the second rather than asserting against two names that turn out to be
// one. Only the cases that name both ids pay this second; nothing else does.
function sleepPastRunIdSecond() {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}

test("init archives the previous run's sidecar directories into runs/<runId>/ beside its run file", (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const firstRunId = JSON.parse(first.stdout).runId;
  seedSidecar(home, project, 'logs/bug-1.jsonl', 'first');
  seedSidecar(home, project, 'reviews/bug-1-1.md', '# review');
  seedSidecar(home, project, 'verify/bug-1.out', 'ok');
  seedSidecar(home, project, 'questions/bug-1.json', '[]');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  const second = run(project, home, 'init', '--project', project);
  assert.equal(second.status, 0, second.stderr);

  const archived = path.join(runsDir(home, project), firstRunId);
  assert.equal(fs.readFileSync(path.join(archived, 'logs', 'bug-1.jsonl'), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(archived, 'reviews', 'bug-1-1.md'), 'utf8'), '# review');
  assert.equal(fs.readFileSync(path.join(archived, 'verify', 'bug-1.out'), 'utf8'), 'ok');
  assert.equal(fs.readFileSync(path.join(archived, 'questions', 'bug-1.json'), 'utf8'), '[]');
  // Nothing but the fresh run file and the archive folder is left flat —
  // the whole point is that the new run starts with empty sidecar paths.
  assert.deepEqual(fs.readdirSync(projStateDir(home, project)).sort(), ['run.json', 'runs']);
});

// The case that fails against any ALLOWLIST implementation. `prompts/` is
// real: one driver on this machine invented it unprompted, and bug-31 then
// made `prompts/<id>-fix-<n>.txt` SKILL.md §7's own prescription. A stray top-level file
// rides along for the same reason — the set of things a driver leaves under
// <dir> is open by construction, so the archiver names only what it must NOT
// move.
test('init archives sidecar names the tool has never heard of, including a stray top-level file', (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const firstRunId = JSON.parse(first.stdout).runId;
  seedSidecar(home, project, 'prompts/bug-1-fix-1.txt', 'findings');
  seedSidecar(home, project, 'notes.txt', 'scratch');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const archived = path.join(runsDir(home, project), firstRunId);
  assert.equal(fs.readFileSync(path.join(archived, 'prompts', 'bug-1-fix-1.txt'), 'utf8'), 'findings');
  assert.equal(fs.readFileSync(path.join(archived, 'notes.txt'), 'utf8'), 'scratch');
  assert.deepEqual(fs.readdirSync(projStateDir(home, project)).sort(), ['run.json', 'runs']);
});

// The denylist is exactly two names, and both halves matter: sweeping
// `runs/` into itself would bury every earlier run inside the latest one,
// and sweeping `run.json` would archive the file twice under two names.
test('the archive never sweeps runs/ into itself and never sweeps run.json', async (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const firstRunId = JSON.parse(first.stdout).runId;
  seedSidecar(home, project, 'logs/bug-1.jsonl', 'one');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);
  await sleepPastRunIdSecond();

  const second = run(project, home, 'init', '--project', project);
  assert.equal(second.status, 0, second.stderr);
  const secondRunId = JSON.parse(second.stdout).runId;
  assert.notEqual(secondRunId, firstRunId);
  seedSidecar(home, project, 'logs/bug-1.jsonl', 'two');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const secondArchive = path.join(runsDir(home, project), secondRunId);
  assert.equal(fs.existsSync(path.join(secondArchive, 'runs')), false, 'runs/ was swept into its own archive');
  for (const runId of [firstRunId, secondRunId]) {
    assert.equal(fs.existsSync(path.join(runsDir(home, project), runId, 'run.json')), false, `run.json was swept into runs/${runId}/`);
  }
  assert.equal(fs.statSync(path.join(runsDir(home, project), `${firstRunId}.json`)).isFile(), true, "the first run's archived file left the top of runs/");
});

// The whole point of the item, stated as one assertion: two runs that both
// dispatch the same item each keep their own transcript. Against the
// pre-change tool the first one is simply gone.
test("a second run cannot overwrite the first run's evidence for the same item", async (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const run1 = JSON.parse(first.stdout).runId;
  seedSidecar(home, project, 'logs/bug-2.jsonl', 'first');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);
  await sleepPastRunIdSecond();

  const second = run(project, home, 'init', '--project', project);
  assert.equal(second.status, 0, second.stderr);
  const run2 = JSON.parse(second.stdout).runId;
  assert.notEqual(run2, run1);
  seedSidecar(home, project, 'logs/bug-2.jsonl', 'second');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  assert.equal(fs.readFileSync(path.join(runsDir(home, project), run1, 'logs', 'bug-2.jsonl'), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(runsDir(home, project), run2, 'logs', 'bug-2.jsonl'), 'utf8'), 'second');
});

// An empty `runs/<runId>/` would claim evidence exists where none does, and
// would break every existing case in this file that asserts the exact
// listing of runs/. The directory is created only when there is something
// to put in it.
test('a run with no sidecars leaves no empty runs/<runId>/ behind', (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const firstRunId = JSON.parse(first.stdout).runId;
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  assert.deepEqual(fs.readdirSync(runsDir(home, project)), [`${firstRunId}.json`]);
});

// The exit-4 lock is what makes moving a live child's pid file safe at all:
// a crashed run still reads status "running", so `init` refuses it outright
// and the sidecars a --resume session is about to read stay exactly where
// that session expects them. Same stale-lock setup as the case above.
test('an init refused by the stale "running" lock (exit 4) moves no sidecars at all', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  stale.updatedAt = new Date(Date.now() - RUN_STALE_MS - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stale, null, 2) + '\n');
  const logPid = seedSidecar(home, project, 'logs/bug-1.pid', '4242');
  const verifyPid = seedSidecar(home, project, 'verify/bug-1.pid', '4243');

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 4);
  assert.equal(fs.readFileSync(logPid, 'utf8'), '4242');
  assert.equal(fs.readFileSync(verifyPid, 'utf8'), '4243');
  assert.equal(fs.existsSync(runsDir(home, project)), false, 'a refused init created runs/');
});

// --- archiveStem, unit --------------------------------------------------
//
// Exported so the collision branch is reachable without racing two inits
// into the same wall-clock second. The second half is the load-bearing one:
// the check is on `<stem>.json` ALONE, so a leftover `<stem>/` directory
// from an interrupted archive does NOT push the run file to `<stem>-2.json`
// and split one run's evidence across two names forever.
test('archiveStem bumps past a taken <stem>.json but ignores a bare <stem>/ directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-stem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(archiveStem(dir, 'run-20260101-000000'), 'run-20260101-000000');

  fs.writeFileSync(path.join(dir, 'run-20260101-000000.json'), '{}');
  assert.equal(archiveStem(dir, 'run-20260101-000000'), 'run-20260101-000000-2');

  fs.writeFileSync(path.join(dir, 'run-20260101-000000-2.json'), '{}');
  assert.equal(archiveStem(dir, 'run-20260101-000000'), 'run-20260101-000000-3');

  // The repair case: a directory under the unsuffixed name, with that name's
  // .json free — an archive interrupted between its two moves. Reusing the
  // stem is the fix, not a collision.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-stem-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir2, 'run-20260101-000000'));
  assert.equal(archiveStem(dir2, 'run-20260101-000000'), 'run-20260101-000000');
});

// The crash window between the two moves, simulated by hand: sidecars
// already under runs/<runId>/, run.json still flat and still done, more
// sidecars still flat. The next init must finish the job into the SAME
// directory rather than mint a <runId>-2 sibling.
test('an archive interrupted between its two moves is repaired into one directory, not split', (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const firstRunId = JSON.parse(first.stdout).runId;
  seedSidecar(home, project, 'logs/a.jsonl', 'log bytes');
  seedSidecar(home, project, 'reviews/a-1.md', 'review bytes');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  // Hand-simulate the interruption: logs/ moved, run.json and reviews/ not.
  const partial = path.join(runsDir(home, project), firstRunId);
  fs.mkdirSync(partial, { recursive: true });
  fs.renameSync(path.join(projStateDir(home, project), 'logs'), path.join(partial, 'logs'));

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(path.join(partial, 'logs', 'a.jsonl'), 'utf8'), 'log bytes');
  assert.equal(fs.readFileSync(path.join(partial, 'reviews', 'a-1.md'), 'utf8'), 'review bytes');
  assert.equal(fs.existsSync(path.join(runsDir(home, project), `${firstRunId}.json`)), true);
  assert.deepEqual(fs.readdirSync(runsDir(home, project)).sort(), [firstRunId, `${firstRunId}.json`]);
});

// Reachable only through that same interrupted-archive path, and the one
// thing the mover must never do: renameSync onto an existing name is an
// error on some platforms and a silent replace on others, and neither is a
// thing to do to archived evidence. Skip, warn, keep going, exit 0.
test('a sidecar name already present in the archive is skipped with a warning, never overwritten', (t) => {
  const { home, project } = orchFixture(t);
  const first = run(project, home, 'init', '--project', project);
  assert.equal(first.status, 0, first.stderr);
  const firstRunId = JSON.parse(first.stdout).runId;
  seedSidecar(home, project, 'logs/a.jsonl', 'original');
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  const partial = path.join(runsDir(home, project), firstRunId);
  fs.mkdirSync(partial, { recursive: true });
  fs.renameSync(path.join(projStateDir(home, project), 'logs'), path.join(partial, 'logs'));
  // A flat logs/ recreated under the same name, holding different bytes.
  seedSidecar(home, project, 'logs/a.jsonl', 'later');

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(path.join(partial, 'logs', 'a.jsonl'), 'utf8'), 'original');
  assert.match(out.stderr, /logs/);
  assert.equal(fs.existsSync(path.join(runsDir(home, project), `${firstRunId}.json`)), true);
});

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
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'init', '--project', project, '--ids', 'ghost-1');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /ghost-1/);
  assert.equal(fs.existsSync(runFile(home, project)), true);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'the done run.json was modified');
  assert.equal(fs.existsSync(runsDir(home, project)), false, 'nothing should have been archived');
  // This is the exact symptom the critical bug produced: status wrongly
  // reporting "no run exists" because the done run had already been
  // archived away with nothing put back in its place.
  assert.equal(run(project, home, 'status').status, 0);
});

test('init --max given a negative number exits 1 and leaves an existing done run.json completely untouched', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'init', '--project', project, '--max', '-1');

  assert.equal(out.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'the done run.json was modified');
  assert.equal(fs.existsSync(runsDir(home, project)), false, 'nothing should have been archived');
  assert.equal(run(project, home, 'status').status, 0);
});

// Fix round 1 (Minor): confirms the reordering also kills the stray-empty-
// directory symptom on a project with no PRIOR run at all — there is
// nothing to archive here, so this is a distinct assertion from the two
// above (which exercise the archive-then-throw ordering specifically).
test('init --ids naming an unknown item on a brand-new project creates no directory at all', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--ids', 'ghost-1');

  assert.equal(out.status, 1);
  assert.equal(fs.existsSync(path.join(home, encodeURIComponent(project))), false, 'a stray project directory was created despite init failing');
});

// --- Test case 4: stage sets fields, first-arrival stageAt, fresh updatedAt

test('stage task-5 dispatched sets session/worktree/branch, stamps stageAt.dispatched, and strictly advances updatedAt', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));

  const out = run(project, home, 'stage', 'task-5', 'dispatched', '--session', 'abc', '--worktree', '/tmp/w', '--branch', 'backlog/task-5');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const item = after.queue.find((q) => q.id === 'task-5');
  assert.equal(item.sessionId, 'abc');
  assert.equal(item.worktree, '/tmp/w');
  assert.equal(item.branch, 'backlog/task-5');
  assert.equal(item.stage, 'dispatched');
  assert.ok(Number.isFinite(Date.parse(item.stageAt.dispatched)), `stageAt.dispatched did not parse: ${item.stageAt.dispatched}`);
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt), 'updatedAt did not strictly advance');
});

test('stage only stamps stageAt on first arrival — revisiting a stage does not move its timestamp', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-9', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-9', 'reviewing').status, 0);
  const firstVisit = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stageAt.reviewing;

  // A revisit must land strictly later by the clock, so this only proves
  // the first-arrival timestamp survives if it is provably NOT re-stamped —
  // i.e. it must equal firstVisit even though real time has moved on.
  assert.equal(run(project, home, 'stage', 'task-9', 'fixing').status, 0);
  assert.equal(run(project, home, 'stage', 'task-9', 'reviewing').status, 0);

  const secondVisit = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stageAt.reviewing;
  assert.equal(secondVisit, firstVisit);
});

// --- Test case 5: stage with an unknown stage string is refused whole -----

test('stage task-5 nonsense exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'stage', 'task-5', 'nonsense');

  assert.equal(out.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

test('stage with an unknown item id exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'stage', 'ghost-1', 'dispatched');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /ghost-1/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

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
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-4', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const beforeItem = before.queue.find((q) => q.id === 'task-4');
  assert.equal(beforeItem.fixLoops, 0);

  const out = run(project, home, 'stage', 'task-4', 'fixing', '--fix-loop');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { id: 'task-4', stage: 'fixing', fixLoops: 1 });

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const item = after.queue.find((q) => q.id === 'task-4');
  assert.equal(item.fixLoops, 1);
  // Everything else on the item is exactly as init minted it: only the three
  // fields this call is allowed to move (fixLoops, stage, and stage's own
  // first-arrival stamp) are normalized away before the comparison, so a
  // stray write to sessionId/worktree/branch/verification/questions/note
  // would fail here.
  assert.deepEqual({ ...item, fixLoops: beforeItem.fixLoops, stage: beforeItem.stage, stageAt: beforeItem.stageAt }, beforeItem);
  // And nothing outside the queue moved except the heartbeat.
  assert.deepEqual({ ...after, queue: before.queue, updatedAt: before.updatedAt }, before);

  // A second, separate process: the count is read back off disk and advanced,
  // never recomputed from scratch.
  assert.equal(run(project, home, 'stage', 'task-4', 'fixing', '--fix-loop').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-4').fixLoops, 2);
});

test('stage without --fix-loop never touches fixLoops, and prints its usual two-key line', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-4', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'stage', 'task-4', 'fixing');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { id: 'task-4', stage: 'fixing' });
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-4').fixLoops, 0);
});

// --- Test case 6: no *.tmp litter survives any successful command ---------

test('no *.tmp file survives in the project run dir after init, stage, heartbeat, attention, and finish all succeed', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-6', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-6', 'dispatched').status, 0);
  assert.equal(run(project, home, 'heartbeat').status, 0);
  assert.equal(run(project, home, 'attention', 'task-6', '--kind', 'parked', '--detail', 'merge conflict').status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);

  const dir = path.join(home, encodeURIComponent(project));
  const leftover = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});

// --- Test case 7: heartbeat touches updatedAt only -------------------------

test('heartbeat changes updatedAt and nothing else', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));

  const out = run(project, home, 'heartbeat');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const { updatedAt: beforeUpdatedAt, ...beforeRest } = before;
  const { updatedAt: afterUpdatedAt, ...afterRest } = after;
  assert.deepEqual(afterRest, beforeRest);
  assert.ok(Date.parse(afterUpdatedAt) > Date.parse(beforeUpdatedAt));
});

test('heartbeat with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'heartbeat');

  assert.equal(out.status, 3);
});

// --- Test case 8: attention appends and mirrors questions -------------------

test('attention task-6 --kind needs-answers --detail appends an attention row and the run still parses as the contract shape', (t) => {
  const { home, project } = orchFixture(t);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  seedReadyTask(project, 'task-6', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'attention', 'task-6', '--kind', 'needs-answers', '--detail', 'which column?');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(after.attention, [{ id: 'task-6', kind: 'needs-answers', detail: 'which column?' }]);
  assert.deepEqual(new Set(Object.keys(after)), new Set(Object.keys(fixture)));
  assert.deepEqual(new Set(Object.keys(after.attention[0])), new Set(Object.keys(fixture.attention[0])));
});

test('attention --kind needs-answers --questions-json mirrors the questions onto the queue item', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-21', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const questionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-questions-')), 'questions.json');
  fs.writeFileSync(questionsFile, JSON.stringify(['Does archiving move it to the Archive view immediately?']));
  t.after(() => fs.rmSync(path.dirname(questionsFile), { recursive: true, force: true }));

  const out = run(project, home, 'attention', 'task-21', '--kind', 'needs-answers', '--detail', 'needs a decision', '--questions-json', questionsFile);

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(after.queue[0].questions, ['Does archiving move it to the Archive view immediately?']);
});

// A kind other than needs-answers must never pick up --questions-json, even
// if the caller passes one — the field's whole meaning ("unanswered
// preflight questions") only applies to that one kind.
test('attention --kind parked ignores --questions-json entirely', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-16', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const questionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-questions-')), 'questions.json');
  fs.writeFileSync(questionsFile, JSON.stringify(['should never appear']));
  t.after(() => fs.rmSync(path.dirname(questionsFile), { recursive: true, force: true }));

  const out = run(project, home, 'attention', 'task-16', '--kind', 'parked', '--detail', 'merge conflict', '--questions-json', questionsFile);

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(after.queue[0].questions, []);
});

test('attention with an unknown kind exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-6', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'attention', 'task-6', '--kind', 'bogus', '--detail', 'x');

  assert.equal(out.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// --- Test case 9: status with no run exits 3 --------------------------------

test('status with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'status');

  assert.equal(out.status, 3);
});

test('status --json prints the run file verbatim as parseable JSON', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'status', '--json');

  assert.equal(out.status, 0, out.stderr);
  const printed = JSON.parse(out.stdout);
  const onDisk = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(printed, onDisk);
});

// --- Task 3: merge mode in the run file ---------------------------------
// Numbered per the task-3 brief's own table (task-3-brief.md, Step 1) so a
// failing case here maps straight back to the row that specifies it.

// Case 1.
test('init --merge-mode branch writes mergeMode/mergeModeEffective "branch" and a null note', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--merge-mode', 'branch');

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.mergeMode, 'branch');
  assert.equal(written.mergeModeEffective, 'branch');
  assert.equal(written.mergeModeNote, null);
});

// Case 2 — the regression guard: a run started with no --merge-mode flag
// must behave exactly as it does at HEAD, key set included.
test('init with no --merge-mode flag writes "merge" for both fields and a null note, key set unchanged from the contract fixture', (t) => {
  const { home, project } = orchFixture(t);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.mergeMode, 'merge');
  assert.equal(written.mergeModeEffective, 'merge');
  assert.equal(written.mergeModeNote, null);
  assert.deepEqual(new Set(Object.keys(written)), new Set(Object.keys(fixture)));
});

// Case 3 — "validate first, mutate last": an invalid --merge-mode must
// write nothing at all, not merely exit nonzero, so this asserts the whole
// BM_ORCH_HOME directory tree stays empty rather than just checking the
// exit code.
test('init --merge-mode nonsense exits 1, names the two valid values, and writes nothing at all', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--merge-mode', 'nonsense');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /merge/);
  assert.match(out.stderr, /branch/);
  assert.deepEqual(fs.readdirSync(home), [], 'init must write nothing anywhere under BM_ORCH_HOME when --merge-mode is invalid');
});

// Case 4 — the same guarantee for a --merge-mode flag with no value at all
// (the flag consumes the next argv slot; here there isn't one).
test('init --merge-mode with no value exits 1 and writes nothing', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--merge-mode');

  assert.equal(out.status, 1);
  assert.deepEqual(fs.readdirSync(home), [], 'init must write nothing anywhere under BM_ORCH_HOME when --merge-mode has no value');
});

// --- task-19: question mode in the run file -----------------------------
// The same six-case shape the merge-mode block above uses, because the flag
// is the same kind of thing: a run-scoped enum validated before anything is
// written. The one asymmetry worth noticing while reading these is which
// value is the silent default — `merge` there, `park` here — which is why
// the "no flag" case below asserts `park` rather than mirroring its
// neighbour's `merge`.

test('init --question-mode decide writes questionMode "decide"', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--question-mode', 'decide');

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.questionMode, 'decide');
});

test('init --question-mode park writes questionMode "park"', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--question-mode', 'park');

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.questionMode, 'park');
});

// The regression guard, the twin of the merge-mode block's Case 2: a run
// started with no flag at all must be the run this tool has always written,
// key set included — and its question behaviour must be the behaviour every
// run had before the flag existed, which is `park`.
test('init with no --question-mode flag writes "park", key set unchanged from the contract fixture', (t) => {
  const { home, project } = orchFixture(t);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.questionMode, 'park');
  assert.deepEqual(new Set(Object.keys(written)), new Set(Object.keys(fixture)));
});

// "Validate first, mutate last" again, and it matters more here than the
// exit code does: `cmdInit` archives any existing run.json before it writes
// the new one, so a validation that ran late would destroy a real run's
// file on behalf of a call that was never going to succeed.
test('init --question-mode auto exits 1, names both legal values, and writes nothing at all', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--question-mode', 'auto');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /decide/);
  assert.match(out.stderr, /park/);
  assert.deepEqual(fs.readdirSync(home), [], 'init must write nothing anywhere under BM_ORCH_HOME when --question-mode is invalid');
});

test('init --question-mode with no value exits 1, says so, and writes nothing', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--question-mode');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /no value/);
  assert.deepEqual(fs.readdirSync(home), [], 'init must write nothing anywhere under BM_ORCH_HOME when --question-mode has no value');
});

// The two flags are independent run-scoped facts and neither reads the
// other; this is the case that would catch a parse loop where one flag's
// argv slot swallowed the other's.
test('init --merge-mode branch --question-mode decide sets both fields independently', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--merge-mode', 'branch', '--question-mode', 'decide');

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.mergeMode, 'branch');
  assert.equal(written.mergeModeEffective, 'branch');
  assert.equal(written.questionMode, 'decide');
});

// --- task-19: `assume`, the one writer of RunQueueItem.assumptions -------
// A local helper rather than a shared one: only these tests need a JSON
// file of pairs, and the temp directory is torn down per test the same way
// the --questions-json tests above do it.
function assumptionsFile(t, pairs) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-assume-')), 'assumptions.json');
  fs.writeFileSync(file, JSON.stringify(pairs));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return file;
}

function decideRun(t, id = 'bug-1', title = 'An ordinary bug') {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, id, title);
  assert.equal(run(project, home, 'init', '--project', project, '--question-mode', 'decide').status, 0);
  return { home, project };
}

test('assume writes the pairs onto the queue item, in file order', (t) => {
  const { home, project } = decideRun(t);
  const file = assumptionsFile(t, [
    { question: 'Which column does a rejected item land in?', answer: 'Out of scope — Archive renders it there.' },
    { question: 'Does the fix need a migration?', answer: 'No; the field is derived, never stored.' }
  ]);

  const out = run(project, home, 'assume', 'bug-1', '--json', file);

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(after.queue.find((q) => q.id === 'bug-1').assumptions, [
    { question: 'Which column does a rejected item land in?', answer: 'Out of scope — Archive renders it there.' },
    { question: 'Does the fix need a migration?', answer: 'No; the field is derived, never stored.' }
  ]);
});

// Appends, never replaces: an item's pre-flight can decide a second
// question after the first has already been recorded, and a replace would
// erase the earlier decision with no trace it ever happened.
test('a second assume on the same item appends rather than replacing', (t) => {
  const { home, project } = decideRun(t);
  assert.equal(
    run(
      project,
      home,
      'assume',
      'bug-1',
      '--json',
      assumptionsFile(t, [
        { question: 'q1', answer: 'a1' },
        { question: 'q2', answer: 'a2' }
      ])
    ).status,
    0
  );

  const out = run(project, home, 'assume', 'bug-1', '--json', assumptionsFile(t, [{ question: 'q3', answer: 'a3' }]));

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(after.queue.find((q) => q.id === 'bug-1').assumptions, [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' }
  ]);
});

test('assume with no --json exits 1 and prints the usage', (t) => {
  const { home, project } = decideRun(t);

  const out = run(project, home, 'assume', 'bug-1');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /--json/);
});

test('assume --json naming a file that does not exist exits 1 and names the path', (t) => {
  const { home, project } = decideRun(t);
  const missing = path.join(os.tmpdir(), 'bm-orch-assume-does-not-exist', 'nope.json');

  const out = run(project, home, 'assume', 'bug-1', '--json', missing);

  assert.equal(out.status, 1);
  assert.match(out.stderr, /nope\.json/);
});

test('assume --json holding an object rather than an array exits 1 and says an array was expected', (t) => {
  const { home, project } = decideRun(t);

  const out = run(project, home, 'assume', 'bug-1', '--json', assumptionsFile(t, {}));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /array/);
});

test('assume --json holding an entry with no answer key exits 1 and names the missing key', (t) => {
  const { home, project } = decideRun(t);

  const out = run(project, home, 'assume', 'bug-1', '--json', assumptionsFile(t, [{ question: 'q' }]));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /answer/);
});

test("assume for an id that is not in this run's queue exits 1", (t) => {
  const { home, project } = decideRun(t);

  const out = run(project, home, 'assume', 'nope-9', '--json', assumptionsFile(t, [{ question: 'q', answer: 'a' }]));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /nope-9/);
});

// THE case this whole command exists to be constrained by. A run told to
// park an unanswerable item and found writing assumptions about it is a run
// whose SKILL.md prose has drifted across several hundred turns — which is
// exactly the failure a tool refusal makes impossible and a prose reminder
// only discourages. Byte-identical, not "the item's assumptions are still
// empty": the refusal must land before any write at all, so nothing else in
// the file can have moved either.
test('assume is refused under a park-mode run, naming the mode, leaving run.json byte-identical', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-1', 'An ordinary bug');
  assert.equal(run(project, home, 'init', '--project', project, '--question-mode', 'park').status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'assume', 'bug-1', '--json', assumptionsFile(t, [{ question: 'q', answer: 'a' }]));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /park/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// A run started with no flag at all is a park run, and gets the same
// refusal — the default has to be the enforced default, not just the
// written one.
test('assume is refused on a run started with no --question-mode flag at all', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-1', 'An ordinary bug');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'assume', 'bug-1', '--json', assumptionsFile(t, [{ question: 'q', answer: 'a' }]));

  assert.equal(out.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// The converse is deliberately NOT enforced: `decide` is permission to
// answer, never an obligation to invent. An item whose questions genuinely
// cannot be answered — a plan citing a section nobody wrote, an either/or
// between two products — must still be able to park.
test('attention --kind needs-answers still succeeds under a decide-mode run', (t) => {
  const { home, project } = decideRun(t);

  const out = run(project, home, 'attention', 'bug-1', '--kind', 'needs-answers', '--detail', 'genuinely undecidable');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(after.attention, [{ id: 'bug-1', kind: 'needs-answers', detail: 'genuinely undecidable' }]);
});

// Case 5 — the enforcement point design §3 calls for: a tool refusal, not a
// SKILL.md reminder, because the reminder has to survive several hundred
// turns of a headless session re-reading its own body and the refusal
// doesn't need to. Checked against the WHOLE file, not just the item's
// stage, since the refusal fires before any write at all.
test('stage <id> merged is refused under a branch-mode run, naming the mode and the stage to use, and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-40', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project, '--merge-mode', 'branch').status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'stage', 'task-40', 'merged');

  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /branch/);
  assert.match(out.stderr, /branched/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// Case 6.
test('stage <id> branched under branch mode succeeds and stamps stageAt.branched', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-41', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project, '--merge-mode', 'branch').status, 0);

  const out = run(project, home, 'stage', 'task-41', 'branched');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const item = after.queue.find((q) => q.id === 'task-41');
  assert.equal(item.stage, 'branched');
  assert.ok(Number.isFinite(Date.parse(item.stageAt.branched)), `stageAt.branched did not parse: ${item.stageAt.branched}`);
});

// Case 7 — the converse of case 5 is deliberately NOT enforced: staging an
// item 'branched' under plain merge mode is exactly what a merge denied
// mid-queue degrades an item to (design §5.2), so it must stay legal here
// even before any `merge-mode` call has moved the run's own effective mode.
test('stage <id> branched under merge mode is legal too — the degrade path', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-42', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'stage', 'task-42', 'branched');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.queue.find((q) => q.id === 'task-42').stage, 'branched');
});

// Case 8.
test('merge-mode branch --note records a downgrade: mergeMode stays merge, mergeModeEffective becomes branch, note stored verbatim', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'merge-mode', 'branch', '--note', 'classifier denied the merge on bug-14');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.mergeMode, 'merge');
  assert.equal(after.mergeModeEffective, 'branch');
  assert.equal(after.mergeModeNote, 'classifier denied the merge on bug-14');
});

// Case 9 — the downgrade is one-way: a run already effective-branch must
// refuse a call trying to move it back to merge, changing nothing.
test('merge-mode merge on a run already effective-branch is refused, changing nothing', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'merge-mode', 'branch', '--note', 'denied once already').status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'merge-mode', 'merge', '--note', 'x');

  assert.notEqual(out.status, 0);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// Task-3 review fix round (Minor) — the one-way-transition logic is covered
// above only for a run that REACHED branch mode via a downgrade (`init`
// plain, then `merge-mode branch`). That covers the guard by construction
// (it only ever checks `mergeModeEffective`, not how the run got there), but
// the path where a run started in branch mode from `init --merge-mode
// branch` directly was never exercised by any test — this pins it: a
// `merge-mode branch --note x` call against a run that was ALREADY
// effective-branch from its very first write must be refused exactly like
// case 9's downgrade-then-re-record scenario, changing nothing.
test('merge-mode branch on a run that started in branch mode via init is refused, changing nothing', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project, '--merge-mode', 'branch').status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'merge-mode', 'branch', '--note', 'x');

  assert.notEqual(out.status, 0);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// Case 10 — the status summary must not report a branch-mode run's
// progress as "N/M merged": that wording is only true under merge mode.
test('status reads in branch-mode wording for a branch-mode run, not "N/M merged"', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-50', 'A');
  seedReadyTask(project, 'task-51', 'B');
  seedReadyTask(project, 'task-52', 'C');
  seedReadyTask(project, 'task-53', 'D');
  assert.equal(run(project, home, 'init', '--project', project, '--merge-mode', 'branch').status, 0);
  assert.equal(run(project, home, 'stage', 'task-50', 'branched').status, 0);
  assert.equal(run(project, home, 'stage', 'task-51', 'branched').status, 0);
  assert.equal(run(project, home, 'stage', 'task-52', 'branched').status, 0);
  // task-53 is left pending, so the total stays 4.

  const out = run(project, home, 'status');

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /3\/4 branched/);
  assert.doesNotMatch(out.stdout, /3\/4 merged/);
});

// Final whole-branch review, finding 9: case 10 above pins `queueSummaryLine`'s
// PURE branch-mode wording (a run that started `--merge-mode branch` and never
// merged anything) — but its OTHER arm, a run that started in `merge` mode and
// downgraded mid-queue (design §5.2, the real 2026-09-03 shape this whole
// feature traces back to), had no coverage at all. That degraded-run string is
// the one line a post-mortem actually reads, and `queueSummaryLine`'s own doc
// comment is explicit that the secondary count is "never folded away, in
// either direction" — so this pins both numbers appearing together, not just
// the headline `branched` count that case 10 already covers.
test('status names both counts for a run that downgraded mid-queue, not just the branched headline', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-70', 'A');
  seedReadyTask(project, 'task-71', 'B');
  seedReadyTask(project, 'task-72', 'C');
  seedReadyTask(project, 'task-73', 'D');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  // Two items merge while the run is still in `merge` mode...
  assert.equal(run(project, home, 'stage', 'task-70', 'merged').status, 0);
  assert.equal(run(project, home, 'stage', 'task-71', 'merged').status, 0);
  // ...then the classifier denies a merge, degrading the rest of the queue.
  assert.equal(run(project, home, 'merge-mode', 'branch', '--note', 'classifier denied the merge on task-72').status, 0);
  assert.equal(run(project, home, 'stage', 'task-72', 'branched').status, 0);
  assert.equal(run(project, home, 'stage', 'task-73', 'branched').status, 0);

  const out = run(project, home, 'status');

  assert.equal(out.status, 0, out.stderr);
  // The headline flips to `branched` (this run's own definition of
  // "finished successfully" once mergeModeEffective moved), and the two
  // items that reached `main` before the denial are still named, not
  // silently dropped from the summary a post-mortem reads.
  assert.match(out.stdout, /2\/4 branched/);
  assert.match(out.stdout, /2 merged before the mode changed/);
});

// Cleanup pass, mirroring the degraded-run case above from the other side:
// that test covers a run that STARTED merge and DEGRADED to branch mid-queue
// (`mergeModeEffective` ends the run at `'branch'`). The arm this pins is the
// one `queueSummaryLine` reaches when `mergeModeEffective` never moves at
// all — a run that stays in `merge` for its entire life yet still stages an
// item `branched`, which `cmdStage`'s own comment says is deliberately legal
// ("`stage <id> branched` stays legal under `merge` mode too"): §3's
// pre-flight recognises a branch already sitting on disk from an earlier,
// interrupted run (branch present, worktree gone — see the "recognise a
// carried-over branched item" doc fix this same review wave made) and stages
// that item `branched` without ever calling `merge-mode branch`, because
// nothing about THIS run decided to give up on merging; one specific item
// just already finished the other way before this run picked the queue back
// up. `queueSummaryLine`'s headline therefore stays `merged` (the run's own
// mode never changed), with the carried-over item named in parentheses
// instead — the mirror image of the degraded run's "N/M branched (K merged
// before the mode changed)" wording, and previously the only one of the two
// non-pure arms with no test at all.
test('status names both counts for a run that stayed in merge mode but carried over a branched item', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-80', 'A');
  seedReadyTask(project, 'task-81', 'B');
  seedReadyTask(project, 'task-82', 'C');
  seedReadyTask(project, 'task-83', 'D');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  // Two items merge, exactly as `merge` mode always allows...
  assert.equal(run(project, home, 'stage', 'task-80', 'merged').status, 0);
  assert.equal(run(project, home, 'stage', 'task-81', 'merged').status, 0);
  // ...and a third is staged `branched` directly, with no `merge-mode`
  // call anywhere in this test: this run's own mode never degrades, it
  // simply carries an item that already finished on a branch before this
  // run reached it.
  assert.equal(run(project, home, 'stage', 'task-82', 'branched').status, 0);
  // task-83 is left pending, so the total stays 4.

  const out = run(project, home, 'status');

  assert.equal(out.status, 0, out.stderr);
  // The headline stays `merged` — unlike the degraded-run case, this run's
  // `mergeModeEffective` never moved off `merge` — with the carried-over
  // item named alongside it rather than silently dropped.
  assert.match(out.stdout, /2\/4 merged/);
  assert.match(out.stdout, /1 branched/);
  assert.doesNotMatch(out.stdout, /2\/4 branched/);

  const json = run(project, home, 'status', '--json');
  assert.equal(json.status, 0, json.stderr);
  // Confirms this really is the non-degraded arm, not a false positive that
  // happens to print the same numbers: `mergeModeEffective` stayed `merge`
  // for this run's entire life, which is the one fact `queueSummaryLine`
  // branches on to pick this wording over the degraded run's.
  assert.equal(JSON.parse(json.stdout).mergeModeEffective, 'merge');
});

// Case 11 — ATTENTION_KINDS gains no fourth member: a green branch is not a
// thing a human needs to look at, so `branched` must stay an unknown kind
// exactly like any other made-up string.
test('attention --kind branched is refused as an unknown kind — ATTENTION_KINDS gains no fourth member', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-60', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'attention', 'task-60', '--kind', 'branched', '--detail', 'x');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /unknown kind/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// --- finish ------------------------------------------------------------

test('finish --status done sets run status and re-stamps updatedAt', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));

  const out = run(project, home, 'finish', '--status', 'done');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'done');
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt));
});

test('finish with an unrecognized --status exits 1 and leaves run.json byte-unchanged', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'finish', '--status', 'bogus');

  assert.equal(out.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

test('finish with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'finish', '--status', 'done');

  assert.equal(out.status, 3);
});

// --- misc CLI shape ----------------------------------------------------

test('an unknown command exits 1', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'bogus-command');

  assert.equal(out.status, 1);
});

test("stage, heartbeat, attention, finish, and status all resolve the project from cwd via the nearest .git ancestor, not from init's --project argument alone", (t) => {
  const { home, project } = orchFixture(t);
  const nested = path.join(project, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  // Run from a subdirectory of the same repo — resolveProjectRoot must walk
  // up to the same root `init` was given, or this would 404 the run.
  const out = run(nested, home, 'heartbeat');

  assert.equal(out.status, 0, out.stderr);
});

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
const FIXTURE_STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'store');

function planFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-plan-home-')));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-plan-project-'));
  const project = path.join(scratch, 'project');
  fs.cpSync(FIXTURE_STORE, project, { recursive: true });
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  return { home, project: fs.realpathSync(project) };
}

function plan(project, home, ...extra) {
  return run(project, home, 'plan', '--project', project, ...extra);
}

// A recursive {relative path -> base64 content} snapshot, used by case 8 to
// prove `plan` really writes nothing — byte content rather than just names
// or mtimes, so even a same-size, same-timestamp rewrite would be caught.
function snapshotTree(dir) {
  const entries = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else entries.push([path.relative(dir, p), fs.readFileSync(p).toString('base64')]);
    }
  };
  walk(dir);
  return entries;
}

// Case 1: a real ## Plan reads as ready, with nothing to complain about.
test('plan: a task with a real ## Plan is ready, with empty reasons', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'task-1', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.id, 'task-1');
  assert.equal(item.gate, 'ready');
  assert.deepEqual(item.reasons, []);
});

// Case 2: the heading is there, but nothing under it — ungroomed, and the
// reason has to actually say so, not just fail silently.
test('plan: a task whose ## Plan heading has only whitespace under it is ungroomed, and the reason names the empty Plan', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'task-3', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ungroomed');
  assert.ok(
    item.reasons.some((r) => /plan/i.test(r) && /empty|no content/i.test(r)),
    `expected a reason naming the empty Plan, got ${JSON.stringify(item.reasons)}`
  );
});

// Case 3: no ## Plan heading at all — also ungroomed, distinct reason.
test('plan: a task with no ## Plan heading at all is ungroomed', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'task-4', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ungroomed');
  assert.ok(
    item.reasons.some((r) => /plan/i.test(r) && /missing/i.test(r)),
    `expected a reason naming the missing Plan heading, got ${JSON.stringify(item.reasons)}`
  );
});

// Case 4: a bug's ## Fix still exactly "unknown" — the backlog-capture
// placeholder — is ungroomed.
test('plan: a bug whose ## Fix is exactly "unknown" is ungroomed', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'bug-2', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ungroomed');
  assert.ok(
    item.reasons.some((r) => /fix/i.test(r)),
    `expected a reason naming ## Fix, got ${JSON.stringify(item.reasons)}`
  );
});

// Case 5: a TBD in an otherwise-real Plan is needs-answers, not ungroomed —
// and, critically, still shows up in the output rather than being dropped.
test('plan: a task with TBD in its Plan is needs-answers, with non-empty questions, and is still listed rather than dropped', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'task-5', '--json');

  assert.equal(out.status, 0, out.stderr);
  const items = JSON.parse(out.stdout);
  assert.equal(items.length, 1, 'a needs-answers item must still be listed, not dropped');
  assert.equal(items[0].gate, 'needs-answers');
  assert.ok(items[0].questions.length > 0);
});

// Case 6: the default order (no --ids) is bugs oldest-first then tasks
// oldest-first, by id NUMBER — and --ids restricts and re-orders to exactly
// the given sequence.
test('plan orders bugs oldest-first then tasks oldest-first, by id number rather than file mtime', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const ids = JSON.parse(out.stdout).map((i) => i.id);
  assert.deepEqual(ids, ['bug-2', 'bug-7', 'task-1', 'task-3', 'task-4', 'task-5']);
});

test('plan --ids restricts and re-orders to exactly the given sequence', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'task-1,bug-2', '--json');

  assert.equal(out.status, 0, out.stderr);
  const ids = JSON.parse(out.stdout).map((i) => i.id);
  assert.deepEqual(ids, ['task-1', 'bug-2']);
});

test('plan --ids naming an unknown id exits 1 and names it', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'task-1,ghost-9', '--json');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /ghost-9/);
});

// Case 7: --max 2 marks everything after the 2nd READY item as beyondMax —
// bug-2 is ungroomed and sits before either ready item, so it stays false;
// task-3/4/5 sit after task-1 (the 2nd ready item) and are all beyond,
// regardless of their own gate.
test('plan --max 2 marks every item after the second ready one as beyondMax, regardless of its own gate', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--max', '2', '--json');

  assert.equal(out.status, 0, out.stderr);
  const byId = Object.fromEntries(JSON.parse(out.stdout).map((i) => [i.id, i.beyondMax]));
  assert.deepEqual(byId, {
    'bug-2': false,
    'bug-7': false,
    'task-1': false,
    'task-3': true,
    'task-4': true,
    'task-5': true
  });
});

// Case 8: plan is side-effect free — the fixture store and the state dir
// are byte-identical before and after.
test('plan writes nothing at all: the fixture store and the state dir are byte-identical before and after', (t) => {
  const { home, project } = planFixture(t);
  const before = snapshotTree(project);
  const homeBefore = fs.readdirSync(home);

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(snapshotTree(project), before);
  assert.deepEqual(fs.readdirSync(home), homeBefore);
});

// --- supplementary: the other two question-detection triggers ---------------
// Not among the brief's eight authoritative cases (which pin TBD detection
// specifically), but the same interface line documents two more triggers
// for needs-answers, and untested logic in a refusal gate is exactly the
// kind of thing that quietly rots. Both build their own throwaway project
// via orchFixture rather than touching fixtures/store/, keeping that
// checked-in directory to exactly the six items the brief names.

test('plan: a trailing "?" line inside ## Plan triggers needs-answers, using that line verbatim as the question', (t) => {
  const { home, project } = orchFixture(t);
  const dir = path.join(project, 'backlog', 'tasks', 'open');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task-1-q.md'),
    '---\nid: task-1\ntitle: Ask before building\ncreated: 2026-08-01\n---\n\n## Plan\n\nBuild the thing. Should it default to dark mode?\n\n## Done when\n'
  );

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'needs-answers');
  assert.ok(item.questions.some((q) => q.includes('dark mode?')));
});

test('plan: a ## Done when command not found in verify.json or package.json is a warning question, never a gate failure', (t) => {
  const { home, project } = orchFixture(t);
  const dir = path.join(project, 'backlog', 'tasks', 'open');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task-1-dw.md'),
    '---\nid: task-1\ntitle: Ship it\ncreated: 2026-08-01\n---\n\n## Plan\n\nReal, groomed plan content with nothing left to decide.\n\n## Done when\n\n```bash\npnpm run this-script-does-not-exist\n```\n'
  );

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'needs-answers');
  assert.equal(item.reasons.length, 0, 'an unresolved Done-when command is a question, never a gate failure');
  assert.ok(item.questions.some((q) => q.includes('this-script-does-not-exist')));
});

// --- init wires the same gate in ---------------------------------------
// Not one of the eight `plan` cases either, but the brief's whole point is
// that `init`'s queue builder and `plan`'s preview are the SAME code path —
// this is the one test that would catch `cmdInit` silently diverging from
// buildGatedQueue (e.g. reintroducing its own copy of the ordering or the
// --max cutoff) even though every `plan`-specific case above is green.
test('init builds its queue from the real gate: bugs oldest-first then tasks oldest-first, and --max excludes items beyond the cap', (t) => {
  // task-44: `planGitFixture`, not `planFixture`. `init` now resolves its base
  // against the repository, and `planFixture`'s project is deliberately NOT a
  // git repo — that is the working-copy fallback's own regression fixture and
  // must stay that way. Every item in the store is committed by this fixture,
  // so the gate reads identical bytes from `main` and the ordering/--max
  // verdicts this case asserts are unchanged.
  const { home, project } = planGitFixture(t);

  const out = run(project, home, 'init', '--project', project, '--max', '2');

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(
    written.queue.map((q) => q.id),
    ['bug-2', 'bug-7', 'task-1']
  );
  assert.ok(
    written.queue.every((q) => q.stage === 'pending'),
    'every queued item should start pending regardless of its own gate result'
  );
});

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
  const { home, project } = planFixture(t);
  spawnSync('git', ['-C', project, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  spawnSync('git', ['-C', project, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture store\n');
  commitEverything(project, 'fixture store');
  return { home, project };
}

// The one uncommitted item cases 2, 4 and 5 share. Its repo-relative path is
// a literal rather than something derived, because case 2 asserts the gate's
// reason names that exact path — a derived value on both sides could agree
// with itself while both were wrong.
const TASK_9_REL = 'backlog/tasks/open/task-9-uncommitted-when-the-run-starts.md';
const TASK_9_BODY = `---
id: task-9
title: Uncommitted when the run starts
created: 2026-09-01
---

## Plan

A real plan, groomed in the working copy and committed nowhere.
`;

function writeTask9(project) {
  fs.writeFileSync(path.join(project, TASK_9_REL), TASK_9_BODY);
}

function git(project, ...args) {
  return spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' });
}

// Case 1: the ordinary path is unchanged — an item that is both committed
// and groomed still reads ready. Without this, every case below could pass
// on a gate that had simply started refusing everything.
test('plan on a git store: a task committed on main with a real ## Plan is ready, with empty reasons', (t) => {
  const { home, project } = planGitFixture(t);

  const out = plan(project, home, '--ids', 'task-1', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ready');
  assert.deepEqual(item.reasons, []);
});

// Case 2: the defect itself. A groomed item that exists only in the working
// copy is refused, and the reason names the path the worktree would not
// contain — that path is the whole point of the message, since "not
// committed" alone leaves the reader guessing which of their items it means.
test('plan on a git store: an item groomed only in the working copy is ungroomed, and the reason names the path the worktree would lack', (t) => {
  const { home, project } = planGitFixture(t);
  writeTask9(project);

  const out = plan(project, home, '--ids', 'task-9', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ungroomed');
  assert.equal(item.reasons.length, 1, `expected exactly one reason, got ${JSON.stringify(item.reasons)}`);
  assert.match(item.reasons[0], /not committed/i);
  assert.ok(item.reasons[0].includes(TASK_9_REL), `reason should name ${TASK_9_REL}: ${item.reasons[0]}`);
});

// Case 3: the sibling defect the same root cause implies. bug-2 is committed
// with `## Fix` still the `unknown` placeholder; grooming it in the working
// copy alone used to read `ready` and dispatch into a worktree holding the
// UNGROOMED version, where backlog-execute refuses it and the whole item is
// spent for nothing. This is the case that proves the gate reads the
// committed blob rather than the file on disk — the disk copy here is
// perfectly groomed.
test('plan on a git store: a bug groomed only in the working copy still gates on the committed placeholder', (t) => {
  const { home, project } = planGitFixture(t);
  const file = path.join(project, 'backlog', 'bugs', 'open', 'bug-2-settings-hue-swatch-preview-lags-one-theme-change-behind.md');
  const groomed = fs
    .readFileSync(file, 'utf8')
    .replace(/## Fix\n\nunknown/, '## Fix\n\nSubscribe the swatch to the theme store instead of reading the hue once at mount.');
  assert.ok(groomed.includes('Subscribe the swatch'), 'fixture bug-2 no longer has the "## Fix\\n\\nunknown" shape this case rewrites');
  fs.writeFileSync(file, groomed);

  const out = plan(project, home, '--ids', 'bug-2', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ungroomed', 'the worktree would hold the committed placeholder, not the working copy');
  assert.ok(
    item.reasons.some((r) => /fix/i.test(r)),
    `expected the ordinary placeholder reason, got ${JSON.stringify(item.reasons)}`
  );
});

// Case 4: --base is honoured, and the coupling it exists for is real — the
// same item reads differently depending on which ref the worktree would be
// created from. task-9 is committed on `trunk` only; `main` never sees it.
test('plan --base gates against the named ref: an item committed on trunk alone is ready there and uncommitted on main', (t) => {
  const { home, project } = planGitFixture(t);
  writeTask9(project);
  assert.equal(git(project, 'checkout', '-q', '-b', 'trunk').status, 0);
  commitEverything(project, 'task-9 on trunk only');
  assert.equal(git(project, 'checkout', '-q', 'main').status, 0);
  // `checkout main` took the file back off disk; the working copy has to
  // hold it again for it to be a candidate at all (the candidate list is a
  // directory read — only the GATE moved to the ref).
  writeTask9(project);

  const onMain = plan(project, home, '--ids', 'task-9', '--json');
  const onTrunk = plan(project, home, '--ids', 'task-9', '--base', 'trunk', '--json');

  assert.equal(onMain.status, 0, onMain.stderr);
  assert.equal(onTrunk.status, 0, onTrunk.stderr);
  assert.equal(JSON.parse(onMain.stdout)[0].gate, 'ungroomed');
  assert.equal(JSON.parse(onTrunk.stdout)[0].gate, 'ready');
});

// Case 5: init queues by membership exactly as before, and the knock-on the
// fix has on --max is the correct one — an uncommitted item is not ready, so
// it no longer consumes the single ready slot and task-1 lands inside the
// cap instead of being pushed past it. The cap bounds how many items a run
// will DISPATCH.
test('init on a git store: an uncommitted item stays in the queue and no longer consumes a --max slot', (t) => {
  const { home, project } = planGitFixture(t);
  writeTask9(project);

  const out = run(project, home, 'init', '--project', project, '--ids', 'task-9,task-1', '--max', '1');

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(
    written.queue.map((q) => q.id),
    ['task-9', 'task-1']
  );
});

// Case 6: `plan` still writes nothing — now including git state, since the
// gate reads git for the first time. A `cat-file`/`show` read must never
// touch the index or the working tree. The tree snapshot deliberately covers
// `backlog/` rather than the whole project: `.git`'s own internals move for
// reasons that have nothing to do with this tool, and `status --porcelain` +
// `rev-parse HEAD` are the two observations that actually matter here.
test('plan on a git store writes nothing: the store, the state dir, git status and HEAD are all unchanged', (t) => {
  const { home, project } = planGitFixture(t);
  writeTask9(project);
  const before = snapshotTree(path.join(project, 'backlog'));
  const homeBefore = fs.readdirSync(home);
  const statusBefore = git(project, 'status', '--porcelain').stdout;
  const headBefore = git(project, 'rev-parse', 'HEAD').stdout;

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(snapshotTree(path.join(project, 'backlog')), before);
  assert.deepEqual(fs.readdirSync(home), homeBefore);
  assert.equal(git(project, 'status', '--porcelain').stdout, statusBefore);
  assert.equal(git(project, 'rev-parse', 'HEAD').stdout, headBefore);
});

// Case 7: a dirty main tree is normal, not an error. Uncommitted changes to
// something that is not an item file say nothing about whether any item is
// committed, and the gate must not read them as a reason to refuse.
test('plan on a git store: an unrelated dirty tracked file changes no verdict', (t) => {
  const { home, project } = planGitFixture(t);
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture store, edited and not committed\n');

  const out = plan(project, home, '--ids', 'task-1', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ready');
  assert.deepEqual(item.reasons, []);
});

// Case 8: the fallback is silent. A store that is not a git work tree at all
// (this tool's own fixtures/store is precisely that) gates the working copy
// exactly as it always did, and says nothing about commits — otherwise every
// non-git case above would start carrying a reason it never asked for.
test('plan against a store that is not a git work tree falls back to the working copy and mentions no commit', (t) => {
  const { home, project } = planFixture(t);

  const out = plan(project, home, '--ids', 'task-1', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [item] = JSON.parse(out.stdout);
  assert.equal(item.gate, 'ready');
  assert.deepEqual(item.reasons, []);
  assert.ok(!/commit/i.test(out.stdout + out.stderr), `fallback should say nothing about commits: ${out.stdout}${out.stderr}`);
});

// --- task-13: a runner-fix item is hoisted to the front of the queue -------
// The defect this section pins: an item that repairs the machinery a run
// depends on (backlog-orchestrate's own SKILL.md, its CLI, the reviewer
// agent, the dispatch route) used to sit wherever bugs-then-tasks-oldest-
// first put it — idea-5 records run-20260901-112035 queueing the
// permission-flag fix as item 3 of 5, where item 1's very first dispatch was
// refused by exactly the flag item 3 existed to replace. A `runner-fix:`
// frontmatter key now hoists it, read off the SAME bytes the gate reads.
//
// The marker is seeded by rewriting a seeded item's frontmatter rather than
// by adding a fourth seeder: what these cases vary is one line, and a
// seeder that took a marker would let a future reader think the marker is
// something the fixtures own rather than something a human writes.
function markRunnerFix(file, value = 'true') {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('---\n'), `expected a frontmatter fence in ${file}`);
  fs.writeFileSync(file, text.replace('---\n', `---\nrunner-fix: ${value}\n`));
}

// Case 1 of the plan's own list, and case 11 with it: orchFixture's project
// is a git repo with NO commits, so `main` resolves to nothing, blobReaderAt
// returns null and the whole section below reads the working copy — the
// documented fallback, exercised by every case here that isn't explicitly a
// planGitFixture one.
test('plan: a runner-fix item is hoisted to the front of the default bugs-then-tasks order', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyBug(project, 'bug-3', 'Repairs the runner'));
  seedReadyTask(project, 'task-1', 'An ordinary task');

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const queue = JSON.parse(out.stdout);
  assert.deepEqual(
    queue.map((q) => q.id),
    ['bug-3', 'bug-2', 'task-1']
  );
  assert.deepEqual(Object.fromEntries(queue.map((q) => [q.id, q.hoisted])), { 'bug-3': true, 'bug-2': false, 'task-1': false });
});

// Case 2: a stable partition, not a sort. Both halves keep the order they
// already had — the hoisted items stay oldest-first among themselves.
test('plan: hoisting is stable — each half keeps the order it already had', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyBug(project, 'bug-3', 'Repairs the runner'));
  markRunnerFix(seedReadyBug(project, 'bug-5', 'Also repairs the runner'));
  seedReadyTask(project, 'task-1', 'An ordinary task');

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((q) => q.id),
    ['bug-3', 'bug-5', 'bug-2', 'task-1']
  );
});

// Case 3: the partition OUTRANKS the bugs-then-tasks rule rather than
// sorting inside it. Without this, a marked task would hoist only as far as
// the front of the tasks — behind every bug, which is exactly the position
// the incident this marker exists for was in.
test('plan: a marked task hoists ahead of an unmarked bug', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyTask(project, 'task-1', 'Repairs the runner'));

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((q) => q.id),
    ['task-1', 'bug-2']
  );
});

// Case 4: `--ids` is hoisted too — a deliberate narrowing of SKILL.md §1's
// "in the order given". OrchestrateSheet sends `ids` for any strict subset
// of its checkboxes, so that list is a selection and not an ordering;
// exempting it would defeat the hoist on the one surface CLAUDE.md tells you
// to start runs from. The caller's relative order survives among the rest.
test('plan: --ids is hoisted too, and the caller order survives among the unmarked items', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyBug(project, 'bug-3', 'Repairs the runner'));
  seedReadyTask(project, 'task-1', 'An ordinary task');

  const out = plan(project, home, '--ids', 'bug-2,bug-3,task-1', '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((q) => q.id),
    ['bug-3', 'bug-2', 'task-1']
  );
});

// Case 5: the hoist happens BEFORE `--max` is counted, which is most of the
// point — a runner fix that was going to fall outside the cap now lands
// inside it. Asserted on the written run file rather than on `plan`, so the
// cap's effect on real queue membership is what gets pinned.
test('init: the hoist precedes the --max cap, so a marked item inside a cap of 1 is the one item queued', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  seedReadyTask(project, 'task-1', 'An ordinary task');
  markRunnerFix(seedReadyTask(project, 'task-5', 'Repairs the runner'));

  const out = run(project, home, 'init', '--project', project, '--max', '1');

  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(
    written.queue.map((q) => q.id),
    ['task-5']
  );
});

// Case 6: `false` is the one opt-out, because "considered, and it is not a
// runner fix" is worth being able to write down.
test('plan: runner-fix: false does not hoist', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyBug(project, 'bug-3', 'Considered, and not a runner fix'), 'false');
  seedReadyTask(project, 'task-1', 'An ordinary task');

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const queue = JSON.parse(out.stdout);
  assert.deepEqual(
    queue.map((q) => q.id),
    ['bug-2', 'bug-3', 'task-1']
  );
  assert.ok(
    queue.every((q) => q.hoisted === false),
    `nothing should be hoisted: ${out.stdout}`
  );
});

// Case 7: the typo case, and the reason presence hoists rather than the
// literal `true`. A key that hoisted on `true` alone would let this exact
// line silently not hoist — a queue in the wrong order with nobody told,
// which is the failure class this marker exists to remove.
test('plan: any non-false value hoists, so runner-fix: yes is not a silent no-op', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyBug(project, 'bug-3', 'Repairs the runner'), 'yes');
  seedReadyTask(project, 'task-1', 'An ordinary task');

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const queue = JSON.parse(out.stdout);
  assert.deepEqual(
    queue.map((q) => q.id),
    ['bug-3', 'bug-2', 'task-1']
  );
  assert.equal(queue.find((q) => q.id === 'bug-3').hoisted, true);
});

// Case 8: the load-bearing half. The marker is read at `<base>`, exactly
// like the gate verdict beside it — a `runner-fix:` present only in the
// working copy must not reorder a run whose worktree, created from `<base>`,
// would not contain it. Both halves in sequence, because the uncommitted one
// passes trivially against an implementation that never reads the marker at
// all; it is the commit that proves the assertion has teeth.
test('plan on a git store: the runner-fix marker is read at <base>, not off the working copy', (t) => {
  const { home, project } = planGitFixture(t);
  const file = path.join(project, 'backlog', 'tasks', 'open', 'task-5-let-the-run-drawer-jump-straight-to-a-parked-items-worktree.md');
  const naturalOrder = ['bug-2', 'bug-7', 'task-1', 'task-3', 'task-4', 'task-5'];

  markRunnerFix(file);

  const uncommitted = plan(project, home, '--json');
  assert.equal(uncommitted.status, 0, uncommitted.stderr);
  const before = JSON.parse(uncommitted.stdout);
  assert.deepEqual(
    before.map((q) => q.id),
    naturalOrder
  );
  assert.ok(
    before.every((q) => q.hoisted === false),
    `an uncommitted marker must not hoist: ${uncommitted.stdout}`
  );

  commitEverything(project, 'mark task-5 as a runner fix');

  const committed = plan(project, home, '--json');
  assert.equal(committed.status, 0, committed.stderr);
  const after = JSON.parse(committed.stdout);
  assert.deepEqual(
    after.map((q) => q.id),
    ['task-5', 'bug-2', 'bug-7', 'task-1', 'task-3', 'task-4']
  );
  assert.equal(after.find((q) => q.id === 'task-5').hoisted, true);
});

// Case 9: an item absent from `<base>` never hoists, even though the row's
// TITLE does come off the working copy. An item the run cannot see the
// content of is not an item whose frontmatter gets to reorder the queue —
// and the existing "not committed" verdict is untouched by the marker.
test('plan on a git store: an item absent from <base> never hoists, and still gates ungroomed naming its path', (t) => {
  const { home, project } = planGitFixture(t);
  fs.writeFileSync(path.join(project, TASK_9_REL), TASK_9_BODY.replace('---\nid: task-9', '---\nrunner-fix: true\nid: task-9'));

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const queue = JSON.parse(out.stdout);
  const item = queue.find((q) => q.id === 'task-9');
  assert.equal(item.hoisted, false);
  assert.equal(item.gate, 'ungroomed');
  assert.ok(item.reasons[0].includes(TASK_9_REL), `reason should name ${TASK_9_REL}: ${item.reasons[0]}`);
  assert.notEqual(queue[0].id, 'task-9', 'an item the run cannot read must not be hoisted to the front');
});

// Case 10: the gate is untouched by the hoist — an ungroomed marked item
// hoists too, and is skipped at pre-flight like any other ungroomed item.
// "The thing that would fix your runner is not groomed" is information, and
// the top of the list is where it will actually be read.
test('plan: an ungroomed runner-fix item still hoists, and init queues it first', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  const dir = path.join(project, 'backlog', 'bugs', 'open');
  const file = path.join(dir, 'bug-3-ungroomed.md');
  fs.writeFileSync(
    file,
    '---\nid: bug-3\nrunner-fix: true\ntitle: Repairs the runner, ungroomed\ncreated: 2026-08-01\n---\n\n## Symptom\n\nSomething is wrong.\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n'
  );

  const previewed = plan(project, home, '--json');
  assert.equal(previewed.status, 0, previewed.stderr);
  const queue = JSON.parse(previewed.stdout);
  assert.deepEqual(
    queue.map((q) => q.id),
    ['bug-3', 'bug-2']
  );
  assert.equal(queue[0].gate, 'ungroomed');

  const out = run(project, home, 'init', '--project', project);
  assert.equal(out.status, 0, out.stderr);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(
    written.queue.map((q) => q.id),
    ['bug-3', 'bug-2']
  );
});

// Case 12: the human-readable printer names the hoist, and both suffixes
// concatenate rather than exclude each other — `--max 0` puts even the
// hoisted row beyond the cap, and that row has to say both things.
test('plan without --json: the hoisted row names the hoist, and carries (beyond --max) alongside it', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyBug(project, 'bug-3', 'Repairs the runner'));
  seedReadyTask(project, 'task-1', 'An ordinary task');

  const plain = plan(project, home);
  assert.equal(plain.status, 0, plain.stderr);
  const rows = plain.stdout.split('\n');
  const hoistedRow = rows.find((l) => l.includes('bug-3'));
  const ordinaryRow = rows.find((l) => l.includes('bug-2'));
  assert.match(hoistedRow, /runner fix/i);
  assert.ok(!/runner fix/i.test(ordinaryRow), `an unmarked row must not claim a hoist: ${ordinaryRow}`);

  const capped = plan(project, home, '--max', '0');
  assert.equal(capped.status, 0, capped.stderr);
  const cappedRow = capped.stdout.split('\n').find((l) => l.includes('bug-3'));
  assert.match(cappedRow, /runner fix/i);
  assert.ok(cappedRow.includes('(beyond --max)'), `both suffixes should appear: ${cappedRow}`);
});

// Case 13: the twin of the plan section's own "writes nothing" case, with a
// marked item present — the new frontmatter read must not have introduced a
// write of any kind.
test('plan writes nothing at all with a runner-fix item present: store and state dir are byte-identical after', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyBug(project, 'bug-2', 'An ordinary bug');
  markRunnerFix(seedReadyBug(project, 'bug-3', 'Repairs the runner'));
  const before = snapshotTree(path.join(project, 'backlog'));
  const homeBefore = fs.readdirSync(home);

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(snapshotTree(path.join(project, 'backlog')), before);
  assert.deepEqual(fs.readdirSync(home), homeBefore);
});

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
  assert.equal(isZombieStatState('Z'), true);
  assert.equal(isZombieStatState('Z+'), true);
  assert.equal(isZombieStatState('Z+\n'), true, 'ps output routinely carries a trailing newline');
  assert.equal(isZombieStatState('  Z+  '), true, 'leading/trailing whitespace must not defeat the check');
  assert.equal(isZombieStatState('S'), false);
  assert.equal(isZombieStatState('S+'), false);
  assert.equal(isZombieStatState('Ss'), false);
  assert.equal(isZombieStatState('R+'), false);
  assert.equal(isZombieStatState('D'), false);
  assert.equal(isZombieStatState(''), false);
});

// --- Task 5: watch --------------------------------------------------------
// Every case here uses a real `node -e` child (never a mock of process
// liveness) and the two checked-in stream-json fixture heads — see this
// file's own header comment for why, and the brief's own ban on ever
// invoking the real `claude` binary from an automated test.

// Test case 1: a short-lived child + stream-init.jsonl → exits 0 the moment
// the child dies, the fixture's session id landed in run.json via the same
// field cmdStage's own `--session` writes, and updatedAt strictly advanced.
test('watch exits 0 the moment a short-lived child dies, with the fixture session id landed in run.json and updatedAt moved', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-9', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));

  const child = spawnChild(t, 200);

  // runAsync, not the blocking `run()` — see that helper's own comment:
  // this test's own event loop must stay free to reap `child` the moment
  // it actually exits, or `child.pid` looks "alive" to watch's pid check
  // for as long as this test's process is blocked, zombie or not.
  const out = await runAsync(
    project,
    home,
    'watch',
    'task-9',
    '--pid',
    String(child.pid),
    '--jsonl',
    STREAM_INIT,
    '--interval-ms',
    '30',
    '--budget-ms',
    '5000'
  );

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const item = after.queue.find((q) => q.id === 'task-9');
  assert.equal(item.sessionId, 'a1b2c3d4-5e6f-4a1b-8c2d-9f0e1a2b3c4d');
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt), 'updatedAt did not strictly advance');
});

// Test case 2: a long-lived child with a tiny budget → exits 3 (child still
// alive; the test kills it), having heartbeated at least twice along the
// way — sampled by polling run.json from a SEPARATE process while watch's
// own blocking loop runs, since watch itself is synchronous end-to-end (see
// orchestrate.mjs's own sleepSync comment for why that is safe here).
test('watch heartbeats at least twice before its budget elapses, then exits 3 with the child still alive', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-11', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const child = spawnChild(t, 60_000);
  const watchProc = spawn(
    'node',
    [SCRIPT, 'watch', 'task-11', '--pid', String(child.pid), '--jsonl', STREAM_NOINIT, '--interval-ms', '100', '--budget-ms', '300'],
    { cwd: project, env: { ...process.env, BM_ORCH_HOME: home, CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID } }
  );
  t.after(() => {
    try {
      watchProc.kill('SIGKILL');
    } catch {
      // already exited
    }
  });

  const file = runFile(home, project);
  const seen = new Set();
  const poll = setInterval(() => {
    try {
      seen.add(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt);
    } catch {
      // a transient read racing writeRunAtomic's rename — try again next tick
    }
  }, 20);

  const [code] = await once(watchProc, 'exit');
  clearInterval(poll);

  assert.equal(code, 3);
  assert.ok(seen.size >= 2, `expected at least two distinct heartbeats, saw ${seen.size}`);
  child.kill('SIGKILL');
});

// Test case 3: stream-noinit.jsonl (no init-type event anywhere in it) never
// crashes and never picks up the OTHER lines' own `session_id` fields —
// only a `type:"system","subtype":"init"` event counts. Exit is still
// governed purely by the pid rule.
test('watch with stream-noinit.jsonl never finds a session id, and still exits cleanly once the child dies', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-12', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const child = spawnChild(t, 200);

  // runAsync — see test case 1's own comment on why the blocking `run()`
  // would risk seeing a zombie `child` as falsely "alive."
  const out = await runAsync(
    project,
    home,
    'watch',
    'task-12',
    '--pid',
    String(child.pid),
    '--jsonl',
    STREAM_NOINIT,
    '--interval-ms',
    '30',
    '--budget-ms',
    '5000'
  );

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.queue.find((q) => q.id === 'task-12').sessionId, null);
});

// Fix round 1 (Minor): a leading line that isn't valid JSON at all must be
// skipped, not treated as a wedge — findSessionIdInJsonl's own lenient
// branch, pinned directly rather than only implied by stream-noinit.jsonl
// (which never has a bad line, only a plain absence of an init event).
test('watch skips a malformed leading line and still finds the session id on the line after it', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-15', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const child = spawnChild(t, 200);

  const out = await runAsync(
    project,
    home,
    'watch',
    'task-15',
    '--pid',
    String(child.pid),
    '--jsonl',
    STREAM_MALFORMED_THEN_INIT,
    '--interval-ms',
    '30',
    '--budget-ms',
    '5000'
  );

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.queue.find((q) => q.id === 'task-15').sessionId, 'deadbeef-1111-4fff-8fff-222222222222');
});

// Supplementary: a `--jsonl` file that never gets created is tolerated for
// exactly one interval (the child may not have opened it yet) but is a
// hard exit-1 the moment a SECOND check still finds it missing.
test('watch exits 1 when the jsonl file is still missing after the first interval', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-13', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const child = spawnChild(t, 60_000);
  const missingJsonl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-jsonl-')), 'never-written.jsonl');

  const out = run(project, home, 'watch', 'task-13', '--pid', String(child.pid), '--jsonl', missingJsonl, '--interval-ms', '30', '--budget-ms', '5000');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /never-written\.jsonl/);
  child.kill('SIGKILL');
});

// Supplementary: a "parse wedge" — `--jsonl` naming something that is not
// even readable as a file (here, a directory) — is a hard exit-1 on the
// very FIRST check, distinct from the missing-file grace period above.
test('watch exits 1 when --jsonl names something unreadable as a file at all (a parse wedge)', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-14', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const child = spawnChild(t, 60_000);
  const dirAsJsonl = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-wedge-'));
  t.after(() => fs.rmSync(dirAsJsonl, { recursive: true, force: true }));

  const out = run(project, home, 'watch', 'task-14', '--pid', String(child.pid), '--jsonl', dirAsJsonl, '--interval-ms', '30', '--budget-ms', '5000');

  assert.equal(out.status, 1);
  child.kill('SIGKILL');
});

test('watch with no run exits 3 before ever touching the pid or jsonl file', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'watch', 'ghost-1', '--pid', '999999', '--jsonl', '/nonexistent');

  assert.equal(out.status, 3);
});

test('watch with an unknown item id exits 1', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'watch', 'ghost-1', '--pid', '999999', '--jsonl', '/nonexistent');

  assert.equal(out.status, 1);
});

test('watch missing --pid or --jsonl exits 1', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  assert.equal(run(project, home, 'watch', 'task-1', '--jsonl', STREAM_INIT).status, 1);
  assert.equal(run(project, home, 'watch', 'task-1', '--pid', '123').status, 1);
});

// --- Task 5: verify ---------------------------------------------------------
// verify's own `--cwd` is a SEPARATE directory from the project root
// resolveProjectRoot() finds from the CLI's own process cwd — exactly the
// worktree-vs-project-root split this file's header comment on
// resolveProjectRoot documents. Every test below spawns the CLI with `cwd:
// project` (so run.json resolves normally) while pointing `--cwd` at an
// unrelated throwaway directory standing in for "the item's worktree."

// Test case 4: backlog/verify.json with one passing, one failing command.
test('verify runs backlog/verify.json commands in order, capturing pass/fail and tails; exit 1 on any failure', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, 'backlog', 'verify.json'),
    JSON.stringify({ commands: ['node -e "process.exit(0)"', 'node -e "console.error(\'boom\'); process.exit(1)"'] })
  );

  const out = run(project, home, 'verify', 'task-1', '--cwd', worktree, '--json');

  assert.equal(out.status, 1, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cmd, 'node -e "process.exit(0)"');
  assert.equal(rows[0].ok, true);
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].tail, /boom/);
  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(written.queue[0].verification, rows);
});

// Test case 5: no verify.json, package.json with only a `test` script.
test('verify with no verify.json falls back to the package.json test script only', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-2', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));

  const out = run(project, home, 'verify', 'task-2', '--cwd', worktree, '--json');

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cmd, 'npm run test');
  assert.equal(rows[0].ok, true);
});

test('verify prefers pnpm run when pnpm-lock.yaml is present, and orders test/typecheck/build', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-3', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.writeFileSync(path.join(worktree, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(
    path.join(worktree, 'package.json'),
    JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"' } })
  );

  const out = run(project, home, 'verify', 'task-3', '--cwd', worktree, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => r.cmd),
    ['pnpm run test', 'pnpm run typecheck', 'pnpm run build']
  );
});

// Test case 6: nothing resolvable at all → exit 5, zero rows written.
test('verify with nothing resolvable exits 5 and writes zero verification rows', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-4', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));

  const out = run(project, home, 'verify', 'task-4', '--cwd', worktree, '--json');

  assert.equal(out.status, 5);
  assert.deepEqual(JSON.parse(out.stdout), []);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json must be untouched when nothing was resolved');
});

// Reuses Task 4's own extractDoneWhenCommands rather than a second parser —
// this is the test proving that reuse actually happened: a fenced `## Done
// when` block in the item's WORKTREE copy adds its own commands after the
// baseline, and an exact repeat of a baseline command collapses to one row.
test('verify appends the item\'s own fenced "## Done when" commands after the baseline, de-duplicating an exact repeat', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  // Placed under done/, not open/ — by the time verify runs, backlog-execute
  // has typically already moved the item there (see the design spec's own
  // per-item loop, step 2), so verify's own item-file search must look in
  // both, not just open/ the way listOpenItems (the gate's own reader) does.
  fs.mkdirSync(path.join(worktree, 'backlog', 'tasks', 'done'), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, 'backlog', 'tasks', 'done', 'task-5-fixture.md'),
    '---\nid: task-5\ntitle: Some task\ncreated: 2026-08-01\n---\n\n## Plan\n\nDone.\n\n## Done when\n\n```bash\nnode -e "process.exit(0)"\necho only-in-done-when\n```\n'
  );
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: ['node -e "process.exit(0)"'] }));

  const out = run(project, home, 'verify', 'task-5', '--cwd', worktree, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => r.cmd),
    ['node -e "process.exit(0)"', 'echo only-in-done-when']
  );
});

// Fix round 1 (Minor): a non-string entry in verify.json's own `commands`
// array must be a clean, code-1 OrchestrateError — not a raw exception from
// handing a number/object straight to `spawnSync` inside runVerifyCommand.
// Also pins that this is a HARD failure, never silently treated as "no
// verify.json" and quietly falling back to package.json scripts.
test('verify.json with a non-string commands entry exits 1 with a clean message, and writes nothing', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-6', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: ['node -e "process.exit(0)"', 42] }));

  const out = run(project, home, 'verify', 'task-6', '--cwd', worktree, '--json');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /commands.*string/i);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json must be untouched on a malformed verify.json');
});

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
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-7', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true });
  const chatty = `node -e "for (let i=0;i<20000;i++) console.log('x'.repeat(80))"`;
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: [chatty] }));

  const out = run(project, home, 'verify', 'task-7', '--cwd', worktree, '--json');

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true, `a command that exits 0 must be recorded ok: ${rows[0].tail}`);
  // The row is still a TAIL, not the whole 1.6 MiB — the bigger buffer buys
  // an honest exit status, it does not widen what gets stored on the run.
  assert.ok(rows[0].tail.split('\n').length <= 20);
});

// Same finding, the other half: `result.error` is "we could not run this
// command", which must never be recorded as if the command had run and
// reported a failure. E2BIG is the one such error a test can provoke without
// touching the environment — a command string past the OS argument limit —
// and spawnSync returns it with `status: null` and `signal: null`, i.e. the
// exact shape the old `status === 0` line silently reduced to "failed".
test('verify distinguishes "could not run this command" from a command that ran and failed', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-8', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true });
  const unspawnable = `true # ${'a'.repeat(3 * 1024 * 1024)}`;
  fs.writeFileSync(
    path.join(worktree, 'backlog', 'verify.json'),
    JSON.stringify({ commands: [unspawnable, 'node -e "console.error(\'real failure\'); process.exit(1)"'] })
  );

  const out = run(project, home, 'verify', 'task-8', '--cwd', worktree);

  // Rows read back from the run file, not from stdout, and deliberately
  // without `--json`: run.json is written before anything is printed, so the
  // file is the whole and honest record either way — which is the thing worth
  // asserting on.
  //
  // Both rows are red — an unrunnable command is no more proof the item works
  // than a failing one — but they do not read the same.
  assert.equal(out.status, 1);
  const rows = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].verification;
  assert.equal(rows[0].ok, false);
  assert.match(rows[0].tail, /could not run this command \(E2BIG\)/);
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].tail, /real failure/);
  assert.doesNotMatch(rows[1].tail, /could not run this command/);
});

test('verify with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));

  const out = run(project, home, 'verify', 'task-1', '--cwd', worktree);

  assert.equal(out.status, 3);
});

test('verify with an unknown item id exits 1 and writes nothing', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));

  const out = run(project, home, 'verify', 'ghost-1', '--cwd', worktree);

  assert.equal(out.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

test('verify without --cwd exits 1', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'verify', 'task-1');

  assert.equal(out.status, 1);
});

// --- Task 5: reconcile -------------------------------------------------
// Read-only, always — every test below either asserts run.json is
// byte-identical before/after, or (like the plan section's own case 8)
// simply never gives reconcile a reason its file would need writing in the
// first place. Real git worktrees throughout, per this file's own
// commitEverything/spawnChild header comment.

test('reconcile suggests redispatch-after-stop when the worktree survives with an in-progress phase: marker but no recorded session id', (t) => {
  const { home, project } = orchFixture(t);
  const itemFile = seedReadyTask(project, 'task-20', 'Some task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktreePath = path.join(project, '.worktrees', 'task-20');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-20', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-20', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-20').status, 0);

  // Simulate a crashed execute session: `start --as execute` wrote
  // started:/phase: onto the WORKTREE's own copy, uncommitted (execute
  // never commits — see the design spec's per-item loop) — and no session
  // id, because the crash happened before watch's own jsonl parse ever
  // caught the init event.
  const worktreeItemFile = path.join(worktreePath, 'backlog', 'tasks', 'open', path.basename(itemFile));
  const original = fs.readFileSync(worktreeItemFile, 'utf8');
  fs.writeFileSync(worktreeItemFile, original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---'));

  const before = fs.readFileSync(runFile(home, project));
  const out = run(project, home, 'reconcile', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-20');
  assert.equal(row.suggestion, 'redispatch-after-stop');
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'reconcile must never write to run.json');
});

test('reconcile suggests resume-session when a session id is already recorded and the marker is still live', (t) => {
  const { home, project } = orchFixture(t);
  const itemFile = seedReadyTask(project, 'task-21', 'Some task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktreePath = path.join(project, '.worktrees', 'task-21');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-21', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(
    run(project, home, 'stage', 'task-21', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-21', '--session', 'sess-abc').status,
    0
  );
  const worktreeItemFile = path.join(worktreePath, 'backlog', 'tasks', 'open', path.basename(itemFile));
  const original = fs.readFileSync(worktreeItemFile, 'utf8');
  fs.writeFileSync(worktreeItemFile, original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---'));

  const out = run(project, home, 'reconcile', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-21');
  assert.equal(row.suggestion, 'resume-session');
});

// Test case 7: the recorded worktree was deleted out-of-band (a plain
// `rm -rf`, never `git worktree remove` — exactly what a crash or a human
// cleaning up by hand leaves behind: git's own admin entry and the branch
// survive, the working directory does not). No file survives to read a
// marker from, so the only honest suggestion is `inspect`, never a
// redispatch that would silently skip billing a marker nobody can see.
test('reconcile suggests inspect when the recorded worktree was deleted out-of-band, since no marker can be read', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-22', 'Some task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktreePath = path.join(project, '.worktrees', 'task-22');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-22', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-22', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-22').status, 0);
  fs.rmSync(worktreePath, { recursive: true, force: true });

  const before = fs.readFileSync(runFile(home, project));
  const out = run(project, home, 'reconcile', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-22');
  assert.equal(row.suggestion, 'inspect');
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'reconcile must never write to run.json');
});

test('reconcile suggests park when neither the worktree directory nor the branch ever actually exist', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-23', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(
    run(project, home, 'stage', 'task-23', 'dispatched', '--worktree', path.join(project, '.worktrees', 'task-23'), '--branch', 'backlog/task-23').status,
    0
  );

  const out = run(project, home, 'reconcile', '--json');

  assert.equal(out.status, 0, out.stderr);
  const [row] = JSON.parse(out.stdout).filter((r) => r.id === 'task-23');
  assert.equal(row.suggestion, 'park');
});

test('reconcile only reports non-terminal queue items, skipping merged/etc', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-24', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-24', 'merged').status, 0);

  const out = run(project, home, 'reconcile', '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), []);
});

// Controller ruling on top of the task-3 brief (spec §4's classification
// table lists `branched` in RECONCILE_TERMINAL_STAGES explicitly): an item
// already at this exit has left the pipeline exactly as completely as a
// `merged` one has, so --resume's own reconcile pass must not treat an
// already-delivered branch as unfinished work to redispatch into.
test('reconcile also skips a branched item — branched is a true exit like merged', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-25', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project, '--merge-mode', 'branch').status, 0);
  assert.equal(run(project, home, 'stage', 'task-25', 'branched').status, 0);

  const out = run(project, home, 'reconcile', '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), []);
});

test('reconcile with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'reconcile');

  assert.equal(out.status, 3);
});

// --- Task 5: abort -------------------------------------------------------

// Test case 8.
test('abort removes a real worktree and its branch, then finishes the run as aborted', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-26', 'Some task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktreePath = path.join(project, '.worktrees', 'task-26');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-26', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-26', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-26').status, 0);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.existsSync(worktreePath), false);
  const branchList = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-26'], { encoding: 'utf8' });
  assert.equal(branchList.stdout.trim(), '');
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted');
  // Fix round 1 (Minor): the one-line human-readable summary — this is the
  // simple "everything torn down cleanly" case, so it names the removed id
  // and reports nothing preserved.
  assert.match(out.stdout, /removed 1 item\(s\) \(task-26\)/);
  assert.match(out.stdout, /left 0 in place/);
});

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
  const { home, project } = orchFixture(t);
  const itemFile = seedReadyTask(project, 'task-10', 'Some task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktreePath = path.join(project, '.worktrees', 'task-10');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-10', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-10', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-10').status, 0);

  const worktreeItemFile = path.join(worktreePath, 'backlog', 'tasks', 'open', path.basename(itemFile));
  const original = fs.readFileSync(worktreeItemFile, 'utf8');
  const marked = original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---');
  fs.writeFileSync(worktreeItemFile, marked);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  // The worktree, its branch, AND its (uncommitted) marked item file all
  // survive byte-for-byte — this tool never touched any of it.
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(fs.readFileSync(worktreeItemFile, 'utf8'), marked);
  const branchList = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-10'], { encoding: 'utf8' });
  assert.match(branchList.stdout, /backlog\/task-10/);

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted', 'abort must still finish the run overall');
  assert.equal(after.attention.length, 1);
  assert.equal(after.attention[0].id, 'task-10');
  assert.match(after.attention[0].detail, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'attention must name the absolute worktree path');
  assert.match(after.attention[0].detail, /backlog\.mjs stop task-10/, 'attention must name the exact recovery command');

  assert.match(out.stdout, /left 1 in place with an in-progress marker \(task-10/);
});

// Fix round 1 (Important) — the exact scenario the review asked to pin: a
// mixed run with ONE clean item and ONE marker-carrying item. Abort must
// still complete for everything else — the clean item's worktree/branch are
// torn down exactly as before, only the marked item's survive.
test('abort tears down a clean item normally while leaving a marker-carrying item in the same run untouched', (t) => {
  const { home, project } = orchFixture(t);
  const cleanItemFile = seedReadyTask(project, 'task-17', 'A clean task');
  const markedItemFile = seedReadyTask(project, 'task-18', 'A marked task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const cleanWorktree = path.join(project, '.worktrees', 'task-17');
  const markedWorktree = path.join(project, '.worktrees', 'task-18');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', cleanWorktree, '-b', 'backlog/task-17', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', markedWorktree, '-b', 'backlog/task-18', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-17', 'dispatched', '--worktree', cleanWorktree, '--branch', 'backlog/task-17').status, 0);
  assert.equal(run(project, home, 'stage', 'task-18', 'dispatched', '--worktree', markedWorktree, '--branch', 'backlog/task-18').status, 0);

  const markedWorktreeItemFile = path.join(markedWorktree, 'backlog', 'tasks', 'open', path.basename(markedItemFile));
  const original = fs.readFileSync(markedWorktreeItemFile, 'utf8');
  fs.writeFileSync(
    markedWorktreeItemFile,
    original.replace('created: 2026-08-01\n---', 'created: 2026-08-01\nstarted: 2026-08-30T10:00:00Z\nphase: execute\n---')
  );
  void cleanItemFile; // seeded only so task-17 gates into the queue; not otherwise inspected

  const out = run(project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);

  // The clean item: torn down exactly as before the fix.
  assert.equal(fs.existsSync(cleanWorktree), false);
  const cleanBranch = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-17'], { encoding: 'utf8' });
  assert.equal(cleanBranch.stdout.trim(), '');

  // The marked item: worktree AND branch both survive, exactly as seeded.
  assert.equal(fs.existsSync(markedWorktree), true);
  const markedBranch = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-18'], { encoding: 'utf8' });
  assert.match(markedBranch.stdout, /backlog\/task-18/);

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted', 'abort must complete for the whole run, not just the clean item');
  assert.equal(after.attention.length, 1);
  assert.equal(after.attention[0].id, 'task-18');
  assert.match(after.attention[0].detail, new RegExp(markedWorktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'attention must name the surviving worktree path');

  assert.match(out.stdout, /removed 1 item\(s\) \(task-17\)/);
  assert.match(out.stdout, /left 1 in place with an in-progress marker \(task-18/);
});

test('abort on a run with a never-dispatched pending item does nothing destructive and still finishes aborted', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-25', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted');
  assert.deepEqual(after.attention, []);
});

// Task-3 review fix round (Important) — the data-destroying defect: before
// this fix, abort's teardown loop decided "preserve vs. remove" purely from
// the phase:-marker check above, so a `branched` item (branch mode's own
// terminal stage — design §5.3, "no `git branch -d`. The branch is the
// deliverable.") had its branch force-deleted (`branch -D`, which bypasses
// git's own not-fully-merged safety check) exactly like any other finished
// item, with `main` never having touched its commits at all. This test pins
// the fix: a `branched` item's worktree is still removed (§5.3 already has
// the run do that at the moment the item is staged; leaving the call
// ungated also still clears a stale worktree admin entry, same as before
// this fix), but its branch survives, and the survival is recorded in
// `attention` — not just this command's own stdout — so an operator who
// aborts the rest of a queue after several items have already completed as
// `branched` can find every kept branch from the run file alone.
test("abort removes a branched item's worktree but keeps its branch, recording the kept branch in attention", (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-60', 'A branch-mode task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project, '--merge-mode', 'branch').status, 0);

  const worktreePath = path.join(project, '.worktrees', 'task-60');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', 'backlog/task-60', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-60', 'dispatched', '--worktree', worktreePath, '--branch', 'backlog/task-60').status, 0);
  assert.equal(run(project, home, 'stage', 'task-60', 'branched').status, 0);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  // Worktree gone...
  assert.equal(fs.existsSync(worktreePath), false);
  // ...but the branch itself is the surviving deliverable.
  const branchList = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-60'], { encoding: 'utf8' });
  assert.match(branchList.stdout, /backlog\/task-60/);

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted');
  assert.equal(after.attention.length, 1);
  assert.equal(after.attention[0].id, 'task-60');
  assert.equal(after.attention[0].kind, 'parked');
  assert.match(after.attention[0].detail, /backlog\/task-60/, 'attention must name the kept branch');
  assert.match(after.attention[0].detail, /branched/, 'attention must say why the branch was kept');

  assert.match(out.stdout, /kept 1 branch\(es\).*\(task-60/);
});

// Task-3 review fix round (Important) — the converse pin the finding calls
// for: the fix above must not be over-broad. A `merged` item's branch was
// already deleted by the run itself at merge time (§9) — abort attempting
// `branch -D` on it again is a pre-existing, harmless no-op, and this test
// proves the new `stage === 'branched'` gate did not accidentally widen to
// catch `merged` (or any other stage) too. One run, two items: a `merged`
// item torn down exactly as before this fix, and a `branched` item whose
// branch survives — so the same abort call demonstrates both halves at
// once, the same "mixed run" shape the marker tests above already use.
test("abort still deletes a merged item's branch normally — only a branched item's branch is exempt", (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-61', 'A merged task');
  seedReadyTask(project, 'task-62', 'A branched task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const mergedWorktree = path.join(project, '.worktrees', 'task-61');
  const branchedWorktree = path.join(project, '.worktrees', 'task-62');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', mergedWorktree, '-b', 'backlog/task-61', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', branchedWorktree, '-b', 'backlog/task-62', 'HEAD'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-61', 'dispatched', '--worktree', mergedWorktree, '--branch', 'backlog/task-61').status, 0);
  assert.equal(run(project, home, 'stage', 'task-62', 'dispatched', '--worktree', branchedWorktree, '--branch', 'backlog/task-62').status, 0);
  assert.equal(run(project, home, 'stage', 'task-61', 'merged').status, 0);
  assert.equal(run(project, home, 'stage', 'task-62', 'branched').status, 0);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);

  // The merged item: torn down exactly as before this fix — worktree AND
  // branch both gone.
  assert.equal(fs.existsSync(mergedWorktree), false);
  const mergedBranch = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-61'], { encoding: 'utf8' });
  assert.equal(mergedBranch.stdout.trim(), '');

  // The branched item: worktree gone, branch kept.
  assert.equal(fs.existsSync(branchedWorktree), false);
  const branchedBranch = spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-62'], { encoding: 'utf8' });
  assert.match(branchedBranch.stdout, /backlog\/task-62/);

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.attention.length, 1, 'only the branched item gets an attention entry, not the merged one');
  assert.equal(after.attention[0].id, 'task-62');
});

test('abort with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 3);
});

// --- bug-3: the dispatch flag, and the denial check that makes it safe ----
// Two halves of one fix. The guard below pins the flag itself, because a
// flag is the kind of thing that gets quietly pasted back in by anyone
// debugging a stuck dispatch; the reader tests below pin the check that
// exists precisely because a milder flag can now refuse a call, and a
// refused call is invisible in every other signal the run produces (exit
// code 0, result subtype "success", is_error false — all three measured on
// this machine against CLI 2.1.250).

const SKILL_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');
const SKILLS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test("all three of SKILL.md's headless dispatch lines carry --permission-mode auto", () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  // Every line that actually launches a headless session — the step 4
  // dispatch, step 5's --resume retry and §7's fresh fixer (#226). Matched by `claude -p` rather
  // than by line number so the assertion survives the file growing, which
  // it already did once between this bug being filed and being fixed.
  const dispatchLines = text.split('\n').filter((l) => l.includes('exec claude -p'));
  assert.equal(dispatchLines.length, 3, `expected exactly 3 headless dispatch lines, found ${dispatchLines.length}`);
  for (const line of dispatchLines) {
    assert.ok(line.includes('--permission-mode auto'), `dispatch line is missing --permission-mode auto: ${line}`);
  }
});

test('no command anywhere under skills/ passes --dangerously-skip-permissions', () => {
  // A whole-tree sweep rather than a check on the dispatch lines above:
  // the point is not that those lines are clean, it is that nothing in the
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
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile()) {
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes('--dangerously-skip-permissions')) continue;
        for (const line of text.split('\n')) {
          if (line.includes('--dangerously-skip-permissions') && /\bclaude\b/.test(line)) {
            offenders.push(`${full}: ${line.trim()}`);
          }
        }
        if (full.endsWith('.md')) {
          // Fenced blocks are executable content in a SKILL.md, prose is
          // not — so inside a fence the flag is an offence wherever it sits,
          // continuation line included.
          let inFence = false;
          for (const line of text.split('\n')) {
            if (line.startsWith('```')) {
              inFence = !inFence;
              continue;
            }
            if (inFence && line.includes('--dangerously-skip-permissions')) {
              offenders.push(`${full} (in a fenced block): ${line.trim()}`);
            }
          }
        }
      }
    }
  };
  walk(SKILLS_ROOT);
  assert.deepEqual(offenders, [], `--dangerously-skip-permissions is back in:\n${offenders.join('\n')}`);
});

// --- bug-9: no positional parameters in a published skill body --------------

test('no fenced block under skills/ reads a positional parameter', () => {
  // Slash-command argument substitution rewrites `$0`..`$9` in a SKILL.md
  // BEFORE the session reads it, and it does not exempt fenced code. Invoked
  // as `/backlog-orchestrate bug-2 bug-3 …`, step 8's verify launcher once
  // arrived in a live session as `node "bug-3/skills/…"` — with the bullet
  // explaining the positional rewritten to match, so it read as deliberate.
  //
  // That corruption never touches disk, so no amount of reading the file
  // finds it; this guard is the only thing standing between a future edit and
  // a silent recurrence. Carry paths in named `env` variables instead.
  //
  // Fenced blocks only. Prose has to be able to say `$1` in order to explain
  // why it must not be used — the same allowance the flag guard above makes,
  // for the same reason.
  //
  // Do not retire this as a one-bug relic: bug-18 made it load-bearing a
  // second time, for an unrelated reason. The orchestrator's dispatch prompt
  // now carries a run marker after the id, so those words reach the dispatched
  // session as `$2`..`$N` and are substituted into backlog-execute/SKILL.md
  // before it is read. That substitution is only safe while no fenced block
  // under skills/ reads a positional — i.e. while this test passes.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile() && full.endsWith('.md')) {
        let inFence = false;
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (line.startsWith('```')) {
            inFence = !inFence;
            continue;
          }
          // `$0` is included (#238). The substitution is 0-indexed: `$0` is
          // the FIRST argument and `$1` the second — which is why bug-9's
          // `/backlog-orchestrate bug-2 bug-3` turned `$1` into `bug-3`. An
          // earlier version of this guard skipped `$0` as "the shell itself",
          // and §9's base-tree awk program, which reads `$0` twice, arrived in
          // a run started as `/backlog-orchestrate 172` as `substr(172,10)` —
          // printing nothing, so a reviewed item parked instead of merging.
          // awk's `$0` is the record, not a shell positional, and it is
          // rewritten all the same: the pass knows nothing about languages.
          if (inFence && /\$\{?[0-9]\b/.test(line)) {
            offenders.push(`${full}: ${line.trim()}`);
          }
        }
      }
    }
  };
  walk(SKILLS_ROOT);
  assert.deepEqual(offenders, [], `a positional parameter is back in a fenced block:\n${offenders.join('\n')}`);
});

// --- bug-8: the merge gate's two failures are not the same failure --------

// RE-POINTED (task 5 of the body-shrink plan): the conflict branch moved to references/merge-failures.md, so this reads body + references. The count it pinned —
// exactly one executable `merge --abort` under the conflict branch — is now exactly one that targets the BASE tree: the worktree-side resolve gained its own
// abort in the item's worktree (the gap this task closed), which `merge-failures.md aborts the worktree-side merge …` (below) pins by itself.
test('SKILL.md keeps merge --abort under the conflict branch only', () => {
  // A pre-merge refusal ("your local changes would be overwritten") and a
  // conflict are different states: the first never started, has no MERGE_HEAD,
  // and answers `git merge --abort` with `fatal: There is no merge to abort`.
  // Collapsing the two branches back into one is the plausible future edit —
  // they sit adjacent and read alike — and it would send an unattended run to
  // a failing command at the one gate with no margin for an unhandled state.
  const text = skillText();
  const aborts = text.split('\n').filter((l) => l.includes('merge --abort') && !l.trimStart().startsWith('*'));
  // One in a fenced block that targets the base tree (the conflict recovery), and prose references that
  // explain when it does NOT apply. The fenced base-tree occurrence is the one pinned.
  const fenced = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence && line.includes('-C "<base tree>" merge --abort')) fenced.push(line.trim());
  }
  assert.equal(fenced.length, 1, `expected exactly 1 executable base-tree merge --abort, found ${fenced.length}:\n${fenced.join('\n')}`);
  assert.ok(aborts.length >= 1);
  // And the refusal must be named as its own case somewhere in step 9, so the
  // distinction survives a reader who only skims the fences.
  assert.ok(text.includes('would be overwritten by merge'), 'step 9 no longer names the pre-merge refusal as a distinct failure');
});

// RETIRED: 'step 9 probes the base tree for paths the branch also touches' pinned the three-line diff / diff --cached / comm
// probe as prose. The probe is `merge-check`'s now, and `merge-check 6`, `7` and `8` (the end of this file) EXECUTE it: an
// unstaged overlap, the STAGED-only overlap this test existed to protect (`diff --cached` is the half most likely to be dropped
// as redundant, and a `git diff`-only probe reads clean over it), and a dirty file the branch does not touch. The `-C
// <base tree>` half — the dirt that can refuse a merge is the dirt in the tree being WRITTEN to — is `merge-check 1` and `2`.

test('step 9 documents resolving on the branch side before parking', () => {
  // Merging into a base that moved after step 8 puts content into it that
  // nothing green ever ran — every step green, the combination untested. The
  // recovery (merge the base INTO the worktree, re-verify there, merge out) is
  // what keeps "never merges red" true, so it has to stay written down.
  //
  // task-44: the ref pulled into the worktree is `<base>`, not the literal
  // `main`. A `--base` run that pulled `main` here would verify the item
  // against a branch it is not merging into — the exact hole this recovery
  // exists to close, reopened.
  const text = skillText();
  assert.ok(text.includes('.worktrees/<id>" merge --no-edit <base>'), 'step 9 lost the worktree-side merge of the base');
  assert.ok(/re-run \*\*all of step 8\*\*/.test(text), 'step 9 no longer requires re-verification after the worktree-side merge');
});

test("step 8's verify launcher carries its paths in named env variables", () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const launcher = text.split('\n').filter((l) => l.includes('orchestrate.mjs" verify'));
  assert.equal(launcher.length, 1, `expected exactly 1 verify launcher line, found ${launcher.length}`);
  const line = launcher[0];
  assert.ok(line.includes('BM_PLUGIN_ROOT'), `verify launcher lost BM_PLUGIN_ROOT: ${line}`);
  assert.ok(line.includes('BM_RUN_DIR'), `verify launcher lost BM_RUN_DIR: ${line}`);
  // The single quotes are the whole reason env is needed rather than plain
  // interpolation: `$?` must reach the inner shell, not this one. A rewrite
  // that switched them to double quotes would capture the OUTER shell's exit
  // code into .status — a merge gate reading the wrong command's answer.
  assert.ok(line.includes("sh -c 'node"), `verify launcher's script body is no longer single-quoted: ${line}`);
});

const STREAM_DENIAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-denial.jsonl');
const STREAM_NO_DENIALS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-no-denials.jsonl');
const STREAM_DENIAL_PARTIAL_TAIL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-denial-partial-tail.jsonl');
const STREAM_TWO_RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-two-results.jsonl');
const STREAM_NO_RESULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-no-result.jsonl');

test('readPermissionDenials returns the denial recorded on the result event', () => {
  const denials = readPermissionDenials(STREAM_DENIAL);
  assert.equal(denials.length, 1);
  assert.equal(denials[0].tool_name, 'Bash');
  assert.match(denials[0].tool_input.command, /^curl -X POST/);
});

test('readPermissionDenials reads an absent permission_denials field as no denials', () => {
  assert.deepEqual(readPermissionDenials(STREAM_NO_DENIALS), []);
});

test('readPermissionDenials finds a denial ahead of a partial trailing line', () => {
  const denials = readPermissionDenials(STREAM_DENIAL_PARTIAL_TAIL);
  assert.equal(denials.length, 1);
  assert.equal(denials[0].tool_use_id, 'toolu_01PartialTailProbe');
});

test('readPermissionDenials takes the LAST result event when a resumed transcript holds several', () => {
  // First result clean, second refused. A reader that stopped at the first
  // would clear a resumed run whose retry never ran the command it needed.
  const denials = readPermissionDenials(STREAM_TWO_RESULTS);
  assert.equal(denials.length, 1);
  assert.equal(denials[0].tool_use_id, 'toolu_01ResumedRunDenial');
});

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
  assert.deepEqual(readPermissionDenials(STREAM_NO_RESULT), []);
});

test('denials --jsonl prints the denial count and the denials themselves', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'denials', '--jsonl', STREAM_DENIAL);

  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.denials[0].tool_name, 'Bash');
});

test('denials on a missing --jsonl exits 1 rather than reporting a clean run', (t) => {
  // The failure mode worth spending an exit code on: an unreadable
  // transcript answering "no denials" is indistinguishable from a clean run,
  // and step 5 would merge on it.
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'denials', '--jsonl', path.join(project, 'nope.jsonl'));

  assert.equal(out.status, 1);
});

test('stage <id> dispatched --permission-mode records the mode on the queue item', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-7', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'stage', 'task-7', 'dispatched', '--worktree', '/tmp/w', '--branch', 'backlog/task-7', '--permission-mode', 'auto');

  assert.equal(out.status, 0, out.stderr);
  const item = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-7');
  assert.equal(item.permissionMode, 'auto');
});

test('a queue item starts with a null permissionMode, before any dispatch has chosen one', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-8', 'Some task');

  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const item = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-8');
  assert.equal(item.permissionMode, null);
});

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
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const sections = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.slice(3).trim();
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  // Step 5 may satisfy this with `inspect <id>`, which counts the denials as one of its four steps (its behaviour is pinned by the `inspect` cases
  // below); step 7's fix loop reaches Commit without passing back through step 5, so it keeps the literal `denials` line.
  const MUST_CHECK = ['5. Inspect what the session left behind', '7. Review'];
  for (const title of MUST_CHECK) {
    assert.ok(sections.has(title), `section not found (renamed?): ${title}`);
    const body = sections.get(title).join('\n');
    assert.ok(
      body.includes('orchestrate.mjs" denials --jsonl') || (title.startsWith('5.') && body.includes('orchestrate.mjs" inspect <id>')),
      `section "${title}" runs a session and then commits, but never checks its transcript for denials`
    );
  }
});

// --- bug-2: a cwd inside a linked worktree must refuse loudly, never resolve --
// The whole point of these cases is the DIFFERENCE between the two ways a
// `.git` entry can be a file. A linked worktree's gitdir carries a
// `commondir`; a submodule's does not — verified empirically against real
// git plumbing, not assumed, which is why case 6 below builds an actual
// submodule rather than hand-rolling a `.git` file. Sniffing "`.git` is a
// file" alone would refuse inside a submodule, where resolving the working
// tree to itself is the correct answer.
//
// The refusal must exit 1, never 3: 3 is the ordinary "no run yet" answer,
// and an unattended loop that reads 3 as "nothing to do" would read a
// perfectly healthy run as absent. That conflation IS the bug.

// A real linked worktree of `project`, on its own branch, with a real
// commit behind it (git worktree add needs HEAD to resolve).
function addWorktree(project, name, branch) {
  commitEverything(project, 'seed');
  const worktreePath = path.join(project, '.worktrees', name);
  const added = spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', branch, 'HEAD'], { encoding: 'utf8' });
  if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
  return worktreePath;
}

test('a command run from inside a linked worktree refuses with exit 1 and names both the worktree and the project root', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-30', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const worktreePath = addWorktree(project, 'task-30', 'backlog/task-30');
  const before = fs.readFileSync(runFile(home, project));

  const out = run(worktreePath, home, 'heartbeat');

  assert.equal(out.status, 1, `expected the worktree refusal, got status ${out.status}: ${out.stderr}`);
  assert.match(out.stderr, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'refusal must name the worktree it was run from');
  assert.match(out.stderr, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'refusal must name the project root to re-run from');
  // The live run is untouched, and nothing was keyed under the worktree.
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'the refusal must never write to the real run.json');
  assert.equal(fs.existsSync(path.join(home, encodeURIComponent(worktreePath))), false, 'nothing may be keyed under the worktree path');
});

test('the worktree refusal fires from a subdirectory of the worktree too — the walk reaches its .git before any parent', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-31', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const worktreePath = addWorktree(project, 'task-31', 'backlog/task-31');
  const nested = path.join(worktreePath, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });

  const out = run(nested, home, 'heartbeat');

  assert.equal(out.status, 1, `expected the worktree refusal, got status ${out.status}: ${out.stderr}`);
  assert.match(out.stderr, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('init --project pointed at a linked worktree refuses with exit 1 and writes nothing at all', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-32', 'Some task');
  const worktreePath = addWorktree(project, 'task-32', 'backlog/task-32');

  const out = run(project, home, 'init', '--project', worktreePath);

  assert.equal(out.status, 1, `expected the worktree refusal, got status ${out.status}: ${out.stderr}`);
  assert.match(out.stderr, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(fs.readdirSync(home), [], 'init must write nothing anywhere under BM_ORCH_HOME when it refuses');
});

test('a directory in no git repository at all still exits 1 with the original "no .git found" message — the new refusal must not reword it', (t) => {
  const { home } = orchFixture(t);
  // A temp directory with no .git anywhere up its chain. macOS /tmp is
  // itself inside no repository, so the walk runs to / and refuses there.
  const orphan = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-orphan-')));
  t.after(() => fs.rmSync(orphan, { recursive: true, force: true }));

  const out = run(orphan, home, 'heartbeat');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /no \.git found/);
});

test('a submodule working tree resolves to itself and is never refused — commondir, not "\.git is a file", is the discriminator', (t) => {
  const { home } = orchFixture(t);
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-submodule-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  // A real submodule, because the entire claim under test is what git's own
  // plumbing writes: a submodule gitdir (<super>/.git/modules/<name>) has no
  // `commondir` entry, a worktree gitdir (<main>/.git/worktrees/<name>) does.
  // `protocol.file.allow=always` is required for a local-path submodule on
  // git >= 2.38.
  const inner = path.join(scratch, 'inner');
  const superRepo = path.join(scratch, 'super');
  fs.mkdirSync(inner);
  fs.mkdirSync(superRepo);
  const ident = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];
  for (const repo of [inner, superRepo]) {
    // `-b main` because the run's default base is `main` and this machine's git may default to `master`; every other fixture here pins it the same way.
    assert.equal(spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { encoding: 'utf8' }).status, 0);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' });
    assert.equal(spawnSync('git', ['-C', repo, ...ident, 'commit', '-qm', 'seed'], { encoding: 'utf8' }).status, 0);
  }
  const added = spawnSync('git', ['-C', superRepo, '-c', 'protocol.file.allow=always', ...ident, 'submodule', 'add', '-q', inner, 'sub'], { encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  const submodule = path.join(superRepo, 'sub');
  assert.equal(fs.statSync(path.join(submodule, '.git')).isFile(), true, 'fixture sanity: a submodule .git is a file');

  // init keys the run under the submodule's own path (no refusal), and a
  // later command run from inside it finds that same run.
  assert.equal(run(submodule, home, 'init', '--project', submodule).status, 0);
  const out = run(submodule, home, 'heartbeat');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.existsSync(runFile(home, submodule)), true, 'the submodule must resolve to itself, exactly as before');
});

test('verify --cwd pointed at a real linked worktree is untouched by the refusal — the flag names a worktree deliberately', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-33', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const worktreePath = addWorktree(project, 'task-33', 'backlog/task-33');
  fs.writeFileSync(path.join(worktreePath, 'backlog', 'verify.json'), JSON.stringify({ commands: ['node -e "process.exit(0)"'] }));

  const out = run(project, home, 'verify', 'task-33', '--cwd', worktreePath, '--json');

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
});

// --- the references split: what left the body must stay reachable ----------
// SKILL.md is injected in full into every turn of a run, and a run is several
// hundred turns long — 60,168 chars of it, measured off a real run's
// transcript, against backlog-execute's 10,736. So the two parts a *clean* run
// never reads (the recovery path, and the evidence behind the rules) live in
// references/ and are read on demand. These cases pin the two ways that split
// can go wrong: a rule that lost its story also losing itself, and a reference
// nothing points at.

const REFERENCES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'references');

test("the body's recovery stub points at references/recovery.md", () => {
  // The failure this guards is narrow and expensive: §10 gets moved out and
  // the pointer does not follow, leaving an unattended run with no instruction
  // at the one moment it is already in trouble.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(text.includes('references/recovery.md'), 'SKILL.md no longer names references/recovery.md');
  assert.ok(fs.existsSync(path.join(REFERENCES, 'recovery.md')), 'references/recovery.md is gone');
});

test('references/recovery.md keeps all five reconcile verdicts', () => {
  // `reconcile` prints exactly one of five suggestions per item (`skip` since
  // task-48, tracker projects only). A recovery doc missing one strands a run
  // on the case it dropped, with no other file saying what that word means.
  const text = fs.readFileSync(path.join(REFERENCES, 'recovery.md'), 'utf8');
  for (const verdict of ['resume-session', 'redispatch-after-stop', 'inspect', 'park', 'skip']) {
    assert.ok(text.includes(verdict), `recovery.md no longer explains the "${verdict}" verdict`);
  }
});

test('references/recovery.md still bills a resumed session rather than abandoning it', () => {
  // This is the ruling that deliberately contradicts backlog-groom, which
  // prescribes `stop --abandon` for a marker that looks identical. A
  // re-layout is exactly how a surprising rule gets "corrected" back to the
  // sibling skill's version by someone reading only one of them.
  const text = fs.readFileSync(path.join(REFERENCES, 'recovery.md'), 'utf8');
  assert.ok(text.includes('`--abandon` is not used'), 'recovery.md no longer states that a resumed session is billed, not abandoned');
});

test('the body keeps the rules whose stories moved to references/', () => {
  // One assertion per rule, each naming the rule rather than the string, so a
  // failure says which rule was lost instead of "substring not found". Every
  // one of these had a paragraph of evidence moved out from under it.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const RULES = [
    ['git revert -m 1', 'undoing a completed merge is a revert'],
    ['reset --hard', 'and never a hard reset'],
    ['--no-ff', 'every item merges as its own merge commit'],
    ['( cd ', 'worktree-scoped backlog.mjs calls run in a subshell'],
    ['--permission-mode auto', 'the dispatch rung'],
    ['BM_PLUGIN_ROOT', "step 8's launcher carries its paths in named env variables"],
    // Task 6 of the body shrink: each rule below had a paragraph of evidence moved to references/rationale.md; the needle is a phrase of the one statement
    // the body kept.
    ['`--model opus` stays on the line', 'every launch line carries --model opus, the retry and fix-loop lines included'],
    ['never run this body under zsh', 'the --settings expansion is correct only under sh'],
    ['never in front of `nohup`', 'BM_ORCH_RUN is a prefix on exec inside the sh -c body'],
    ['and no `:` or `/` in it', "the session's -n name is the item id, with a space separator and no : or /"],
    ['retry names itself `orch <id> retry 1`**', "the retry's -n name carries the retry counter"],
    ['If this call exits `10` a stop landed in the gap', 'a refused pid record is not retried or worked around'],
    ['`<dir>/logs/<id>.pid` — `--abort` reads that file first', 'the echo $! line writes exactly the path abort reads'],
    ['No apostrophes" above governs only the fixed marker text', 'prose this run did not compose is the general form of the no-apostrophes rule'],
    ['**`test -s "<file>" &&` ahead of the assignment**', "the retry launcher guards its prompt file so an empty one spawns nothing"],
    ['**The Write tool, never a heredoc and never `printf`.**', 'retry and fix prompts are written with the Write tool'],
    ['retry is the session most tempted to background', 'the retry prompt ends with the fresh dispatch background rule'],
    ['**That note is fixed text, not the classifier\'s message.**', 'the merge-mode probe note is fixed text'],
    ['do **not** "tighten" it to `dontAsk`', '`auto` is not tightened to dontAsk plus an allowlist'],
    ['Substitute `<dir>` once, into `env`', "step 8's launcher substitutes <dir> once"],
    ['`branch -d` runs in the base tree, never `$PWD`', 'cleanup commands that follow a merge run in the tree the merge happened in'],
    ['The entries are **never committed**', "the runner's own exclude entries are never committed"],
    ['`node_modules` is listed **bare**', 'the node_modules exclude entry is bare, so it matches a symlink'],
    ['walked by this skill and', 'the merge, the only door back into the base, is walked by the orchestrator and never by the session'],
    ['`fix-mode` decides fresh or resume', 'the fix loop mode is the tool\'s decision, not the driver\'s'],
    // Final-review fixes: the retry's own transcript is inspected, and a null denial count is unknown rather than clean.
    ['inspect <id> --jsonl "<dir>/logs/<id>-retry-1.jsonl"', "after a retry the run inspects the RETRY's transcript, never the first session's again"],
    ['`null` means unknown, never clean', 'an item with no transcript in this run reports denials unknown, never a clean zero']
  ];
  for (const [needle, rule] of RULES) {
    assert.ok(text.includes(needle), `SKILL.md lost the rule: ${rule} (${needle})`);
  }
});

// The scan behind the no-history guard below, factored out so its pattern is proved on synthetic text (the self-tests after it) rather than only on whatever
// SKILL.md happens to contain today — a guard whose only input is the file it guards cannot show it would catch the next offender. Returns each offending line
// as `"<lineNo>: <trimmed line>"`, 1-based. A fence opens and closes on a line whose first non-blank characters are three backticks or three tildes; the
// fence lines and everything between them are exempt. History is `bug-N` / `task-N`, `#N` with one digit or more (a single-digit `#3` is the same backstory as
// `#226`), or a run id, `run-` + 8 digits + `-` + 6 digits — the full shape only, so `run-2026` or `run-id` prose stays clean. A line containing any
// allowlisted substring is exempt.
function historyOffenders(text, allowed) {
  const offenders = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (/\b(bug|task)-[0-9]+|#[0-9]+|\brun-[0-9]{8}-[0-9]{6}\b/.test(line) && !allowed.some((a) => line.includes(a))) {
      offenders.push(`${i + 1}: ${line.trim().slice(0, 140)}`);
    }
  });
  return offenders;
}

test('historyOffenders flags bug-N, task-N, #N of any width and full run ids, and nothing shaped like them but shorter', () => {
  assert.deepEqual(historyOffenders('see bug-7 for why', []), ['1: see bug-7 for why']);
  assert.deepEqual(historyOffenders('task-12 moved', []), ['1: task-12 moved']);
  assert.deepEqual(historyOffenders('(#3)', []), ['1: (#3)']);
  assert.deepEqual(historyOffenders('(#226;', []), ['1: (#226;']);
  assert.deepEqual(historyOffenders('in run-20260923-154625 it failed', []), ['1: in run-20260923-154625 it failed']);
  assert.deepEqual(historyOffenders('a run-2026 note', []), []);
  assert.deepEqual(historyOffenders('the run-id field', []), []);
});

test('historyOffenders exempts backtick and tilde fences, indented openers included, and only until the fence closes', () => {
  const json = ['```json', '{ "runId": "run-20260831-123118" }', '```', '{ "runId": "run-20260831-123118" }'].join('\n');
  assert.deepEqual(historyOffenders(json, []), ['4: { "runId": "run-20260831-123118" }']);
  const tilde = ['~~~', 'bug-4', '~~~', 'bug-4'].join('\n');
  assert.deepEqual(historyOffenders(tilde, []), ['4: bug-4']);
  const indented = ['   ```bash', 'echo bug-4', '   ```'].join('\n');
  assert.deepEqual(historyOffenders(indented, []), []);
});

test('historyOffenders honours the allowlist and reports 1-based line numbers with the line trimmed', () => {
  const line = 'Ids are `31`, never `#31` (`#` opens a shell comment).';
  assert.deepEqual(historyOffenders(line, ['never `#31`']), []);
  assert.deepEqual(historyOffenders(line, []), [`1: ${line}`]);
  assert.deepEqual(historyOffenders(['clean', '', '   bug-9 here  '].join('\n'), []), ['3: bug-9 here']);
});

test('the SKILL.md body carries no bug-N / task-N / #N / run-id history outside fenced blocks; history lives in references/rationale.md', () => {
  // A backstory that names the defect it came from is evidence, not instruction: it costs every turn of every run for a sentence the run never acts on. The
  // body keeps the rule as one imperative statement and `references/rationale.md` keeps the story. Fenced blocks — ``` or ~~~ — are exempt because they hold
  // text the run TYPES or is shown (the `plan` sample board, example ids, the sample `init` output's run id), and an id there is data, not history. ALLOWED
  // lists any prose line that must keep a number anyway, each with the reason it is an instruction. The pattern is `#` plus one or more digits, not only the
  // parenthesised `(#N)` form: `(#226;` slipped past a narrower one once. A run id (`run-YYYYMMDD-HHMMSS`) is history too — it names the run an incident
  // happened in, which is exactly the story rationale.md exists to hold (#247). The scan itself is `historyOffenders`, above.
  const ALLOWED = [
    // "Ids inside a run are bare issue numbers, `31`, never `#31`" — an instruction about what to type (`#` opens a shell comment), not a backstory; the
    // number is an example id, not a reference to a defect.
    'never `#31`'
  ];
  const offenders = historyOffenders(fs.readFileSync(SKILL_MD, 'utf8'), ALLOWED);
  assert.deepEqual(offenders, [], `history is back in the SKILL.md body (move it to references/rationale.md):\n${offenders.join('\n')}`);
});

test('the SKILL.md body size is reported against its baselines — informational, it can never fail', (t) => {
  // INFORMATIONAL ONLY, and it must never become an assertion. The body is resident for every turn of a run, so its growth is a cost nobody sees in a diff;
  // this line makes it visible in every test run instead. A hard budget was the rejected alternative: a size cap is how a load-bearing rule gets compressed
  // away to fit, which has already happened twice on this machine. When the size and a rule disagree, the rule wins and the number moves — edit
  // AFTER_SHRINK to the new measurement, do not turn the comparison into a check.
  //
  // Units: the 2026-09-01 baseline is CHARACTERS (read off a transcript's injected skill text), the 2026-10-05 "before" figure is BYTES (`wc -c`, em dashes
  // count three), and AFTER_SHRINK is characters (`wc -m`) — so each baseline is compared in its own unit, and both sizes are printed.
  const BASELINE_2026_09_01_CHARS = 60168;
  const BEFORE_SHRINK_2026_10_05_BYTES = 151246;
  const AFTER_SHRINK_CHARS = 104745; // `wc -m skills/backlog-orchestrate/SKILL.md` when the body-shrink plan landed
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const chars = text.length;
  const bytes = Buffer.byteLength(text, 'utf8');
  const fmt = (n) => n.toLocaleString('en-US');
  const delta = (now, from) => `${now >= from ? '+' : '-'}${fmt(Math.abs(now - from))}`;
  t.diagnostic(
    `SKILL.md body: ${fmt(chars)} chars (${fmt(bytes)} bytes) — ${delta(chars, BASELINE_2026_09_01_CHARS)} chars vs the 2026-09-01 trim (${fmt(BASELINE_2026_09_01_CHARS)}), ` +
      `${delta(bytes, BEFORE_SHRINK_2026_10_05_BYTES)} bytes vs before the 2026-10-05 shrink (${fmt(BEFORE_SHRINK_2026_10_05_BYTES)}), ` +
      `${delta(chars, AFTER_SHRINK_CHARS)} chars vs when the shrink landed (${fmt(AFTER_SHRINK_CHARS)})`
  );
});

// The whole text a tracker run reads: the body, then every `references/*.md`. Read from the directory rather than a list, so a reference added later is
// picked up by every case that calls this without anybody remembering to add it here. A case whose needle may live in either place reads it; a case whose
// needle must stay in the body (a literal git call, a launch line) keeps reading `SKILL_MD` on its own.
function skillText() {
  const files = fs
    .readdirSync(REFERENCES)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return [fs.readFileSync(SKILL_MD, 'utf8'), ...files.map((f) => fs.readFileSync(path.join(REFERENCES, f), 'utf8'))].join('\n');
}

test('the body and recovery.md both send a github-source run to references/tracker.md, in a sentence that names github', () => {
  // The trigger is the point, not the filename: a body that names the file but not WHEN to read it leaves a tracker run working from the files-project
  // text alone, and a files run opening a file it never needed. The run file has no `source` field, so the predicate is the committed marker. There are
  // TWO entry paths and each has to carry it: a fresh run reads the file before §1, but a `--resume` or unpaused run goes recovery.md -> `reconcile` ->
  // the loop and never executes §1, so recovery.md must say it too — after `claim`, before `reconcile`.
  const sentenceNaming = (text) => {
    const at = text.indexOf('references/tracker.md');
    assert.ok(at !== -1, 'the text never names references/tracker.md');
    // A paragraph, cut at the nearest blank line or bullet, so a neighbouring bullet cannot lend its words to the sentence.
    const start = Math.max(text.lastIndexOf('\n\n', at), text.lastIndexOf('\n- ', at)) + 1;
    const ends = [text.indexOf('\n\n', at), text.indexOf('\n- ', at)].filter((i) => i !== -1);
    const end = ends.length ? Math.min(...ends) : text.length;
    const paragraph = text.slice(start, end).replace(/\s*\n\s*/g, ' ');
    return paragraph.split(/(?<=[.!?])\s+(?=[A-Z*`])/).find((s) => s.includes('references/tracker.md'));
  };
  const bodySentence = sentenceNaming(fs.readFileSync(SKILL_MD, 'utf8'));
  const recoverySentence = sentenceNaming(fs.readFileSync(path.join(REFERENCES, 'recovery.md'), 'utf8'));
  for (const [name, sentence] of [
    ['SKILL.md', bodySentence],
    ['recovery.md', recoverySentence]
  ]) {
    assert.match(sentence, /`github`/, `${name}: the sentence naming references/tracker.md does not say github: ${sentence}`);
    assert.match(sentence, /backlog\/source\.json/, `${name}: the trigger is not the committed source marker`);
    assert.match(sentence, /in full/, `${name}: the trigger does not say to read the file in full`);
  }
  assert.match(bodySentence, /before §1/, 'SKILL.md: the fresh-run trigger does not say before §1');
  assert.match(bodySentence, /--resume/, 'SKILL.md: the trigger does not cover a resumed run');
  assert.match(recoverySentence, /after `claim`/, 'recovery.md: the trigger does not say when, relative to `claim`');
  assert.match(recoverySentence, /before `reconcile`/, 'recovery.md: the trigger does not say it comes before `reconcile`');
  assert.ok(fs.existsSync(path.join(REFERENCES, 'tracker.md')), 'references/tracker.md does not exist');
});

test('the tracker rules that left the body are still in body + references, and the body keeps a marker at every site', () => {
  // Move, never delete: each needle is a rule or a `--detail` template that now lives in references/tracker.md. The body half is the marker, which has to
  // name the file so a tracker run that skipped the up-front read still finds it at the step.
  const all = skillText();
  const flatAll = all.replace(/\s*\n\s*/g, ' ');
  for (const [rule, needle] of [
    ['the attention comment marker', '<!-- bm:attention kind=… run=… -->'],
    ['a claim elsewhere is a skip', '"stage":"skipped"'],
    ['the claim-refused park', 'the claim for this item was refused'],
    ['the pull-failure park', 'cannot fast-forward onto origin'],
    ['the outcome clause of the dispatch marker', 'outcome <dir>/outcomes/<n>.md'],
    ['the snapshot the reviewer reads', 'snapshot <n>'],
    ['the rejected-push park', 'merge landed locally but the push was rejected'],
    ['the refused-close park', 'merged and pushed; the issue was not closed'],
    ['finish stamps the last-touched claim', 'finished: { at, status }'],
    ['abort releases every claim', 'gives every claim the run still holds back']
  ]) {
    assert.ok(flatAll.includes(needle), `the tracker rule is gone from body + references: ${rule} (${needle})`);
  }
  const body = fs.readFileSync(SKILL_MD, 'utf8');
  const markers = body.match(/references\/tracker\.md/g) ?? [];
  assert.ok(markers.length >= 12, `only ${markers.length} references/tracker.md pointers in the body — a moved site lost its marker`);
});

test('every file under references/ is named by the body', () => {
  // An unreferenced reference is a file no session will ever open. Reading
  // them is not automatic — the body has to say when.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const files = fs.readdirSync(REFERENCES).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'references/ has no .md files');
  for (const f of files) {
    assert.ok(text.includes(`references/${f}`), `references/${f} is never named in SKILL.md`);
  }
});

// Task 5 of the body-shrink plan: four rare-path sections left the body. Each is read on an OBSERVABLE event inside the loop (an exit code, a merge result, a
// `merge-check`/`cleanup`/`verify` output, a found question), and the loop is the one place a fresh run and a resumed run both pass through — a resumed run goes
// recovery.md -> `claim` -> `reconcile` -> the loop, never §1, so a trigger phrased on "before §1" would miss it. These cases pin that the trigger is in the
// SAME SENTENCE as the file's name, never a "see also".

// Every sentence of `text` that names `needle`, each cut from its own paragraph (a blank line, a bullet or a table row bounds it) so a neighbour cannot lend
// its words.
function sentencesNaming(text, needle) {
  const found = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const start = Math.max(text.lastIndexOf('\n\n', at), text.lastIndexOf('\n- ', at), text.lastIndexOf('\n|', at)) + 1;
    const ends = [text.indexOf('\n\n', at), text.indexOf('\n- ', at), text.indexOf('\n|', at)].filter((i) => i !== -1);
    const end = ends.length ? Math.min(...ends) : text.length;
    const paragraph = text.slice(start, end).replace(/\s*\n\s*/g, ' ');
    for (const s of paragraph.split(/(?<=[.!?])\s+(?=[A-Z*`|])/)) if (s.includes(needle)) found.push(s);
  }
  return found;
}

const RARE_PATH_REFERENCES = [
  ['questions.md', [/question/i]],
  ['stopping.md', [/exits `6` or `10`/]],
  ['merge-failures.md', [/merge call does not succeed/, /`overlap`/, /`runnerFix`/]],
  ['check-failures.md', [/`verify` exits non-zero/, /second review says/]]
];

test('the body names each rare-path reference in the sentence that states its trigger', () => {
  const body = fs.readFileSync(SKILL_MD, 'utf8');
  for (const [file, triggers] of RARE_PATH_REFERENCES) {
    assert.ok(fs.existsSync(path.join(REFERENCES, file)), `references/${file} does not exist`);
    const sentences = sentencesNaming(body, `references/${file}`);
    assert.ok(sentences.length > 0, `SKILL.md never names references/${file}`);
    for (const trigger of triggers) {
      assert.ok(
        sentences.some((s) => trigger.test(s)),
        `no sentence naming references/${file} carries the trigger ${trigger}: ${sentences.join(' | ')}`
      );
    }
  }
});

test('the body no longer carries the rare-path prose, and the four references hold it', () => {
  // Flattened, so a needle that prose wrapping splits across two lines still matches.
  const flatten = (s) => s.replace(/\s*\n\s*/g, ' ');
  const body = flatten(fs.readFileSync(SKILL_MD, 'utf8'));
  const read = (f) => flatten(fs.readFileSync(path.join(REFERENCES, f), 'utf8'));
  // Moved, not deleted: each needle is a rule or a template that now lives in exactly one reference, and is absent from the body.
  for (const [file, needle, rule] of [
    ['questions.md', 'assume <id> --json', 'a decided answer is recorded with `assume`'],
    ['questions.md', 'A decided answer is an assumption', 'a decided answer is written as an assumption, never as a human ruling'],
    ['stopping.md', 'You are here because `stage <id> preflight` or `stage <id> dispatched` exited `6`', 'the pause path'],
    ['stopping.md', 'You are here because a command exited `10`', 'the stop path'],
    ['stopping.md', 'inspect any worktree', 'an abort refused with 7 inspects no worktree'],
    ['merge-failures.md', 'Blocked by classifier.', 'the classifier denial'],
    ['merge-failures.md', 'would be overwritten by merge', 'the pre-merge refusal'],
    [
      'merge-failures.md',
      '--detail "merge refused before it started: local changes in the base tree would be overwritten — worktree and branch kept"',
      'a pre-merge refusal the overlap probe cannot see (untracked files) is parked by hand with fixed words, never looped on merge-check'
    ],
    [
      'recovery.md',
      'rm -rf "$PWD/.worktrees/<id>"',
      'an abort whose worktree removal fails with "failed to delete" finishes the delete by hand on the literal path — cleanup refuses an aborted item'
    ],
    ['merge-failures.md', 'merge --no-edit <base>', 'the worktree-side resolve'],
    ['merge-failures.md', 'runner fix — the remainder of this run follows the repo copy', 'the runner-fix switch'],
    ['check-failures.md', '2 fix loops, still:', 'the exhausted review loop'],
    ['check-failures.md', '2 fix loops, verification still red', 'the exhausted verify loop'],
    ['check-failures.md', 'could not run this command', 'a verify row that never executed']
  ]) {
    assert.ok(read(file).includes(needle), `references/${file} lost ${rule} (${needle})`);
    assert.ok(!body.includes(needle), `SKILL.md still carries ${rule} (${needle}) — it should now live only in references/${file}`);
  }
  // What stays in the body, each with the reason it cannot leave.
  for (const [needle, rule] of [
    ['git -C "<base tree>" merge --no-ff --no-edit backlog/<id>', 'the literal merge — the classifier judges the call it sees'],
    ['git revert -m 1', 'undoing a completed merge is a revert'],
    ['At most two fix loops per item', 'the fix-loop ceiling, counted in the run file'],
    ['Never merge red', 'a red verification never merges'],
    ['Never restate an unanswered question in prose', 'a prose question ends the turn']
  ]) {
    assert.ok(body.includes(needle), `SKILL.md lost ${rule} (${needle})`);
  }
});

test('merge-failures.md aborts the worktree-side merge in the worktree before parking, and the base-tree abort stays the one fenced base-side command', () => {
  // The gap this closes: the worktree-side resolve said "on conflicts, park per the conflict branch", and that branch's `merge --abort` targets the BASE tree
  // — so the half-merged worktree was never aborted, and a parked item kept the markers and MERGE_HEAD in the tree a human opens first.
  const text = fs.readFileSync(path.join(REFERENCES, 'merge-failures.md'), 'utf8');
  const fenced = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence && line.includes('merge --abort')) fenced.push(line.trim());
  }
  assert.equal(fenced.filter((l) => l.includes('-C "<base tree>"')).length, 1, `expected exactly 1 base-tree merge --abort: ${fenced.join(' | ')}`);
  assert.equal(fenced.filter((l) => l.includes('-C "$PWD/.worktrees/<id>"')).length, 1, `expected exactly 1 worktree-side merge --abort: ${fenced.join(' | ')}`);
  assert.equal(fenced.length, 2, `an unexpected extra executable merge --abort: ${fenced.join(' | ')}`);
  // Ordered: the worktree abort comes after the worktree-side merge that can conflict and before the park that follows it.
  const resolveAt = text.indexOf('merge --no-edit <base>');
  const worktreeAbortAt = text.indexOf('-C "$PWD/.worktrees/<id>" merge --abort');
  assert.ok(resolveAt !== -1 && worktreeAbortAt > resolveAt, 'the worktree-side abort does not follow the worktree-side merge');
  const parkAfter = text.indexOf('attention', worktreeAbortAt);
  assert.ok(parkAfter !== -1, 'nothing parks after the worktree-side abort');
  // And the body keeps no executable `merge --abort` of its own: both live in the reference now.
  const body = fs.readFileSync(SKILL_MD, 'utf8');
  let bodyFence = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      bodyFence = !bodyFence;
      continue;
    }
    assert.ok(!(bodyFence && line.includes('merge --abort')), `SKILL.md still carries an executable merge --abort: ${line}`);
  }
});

test('the body sends every exit 6 and exit 10 to references/stopping.md, never to a §10 heading that no longer exists', () => {
  const body = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(!/§10,? _?(Pausing|Stopping)/.test(body) && !/§10 "Stopping"/.test(body), 'SKILL.md still points at a §10 Pausing/Stopping heading');
  assert.ok(sentencesNaming(body, 'references/stopping.md').length >= 5, 'a site that said "go to §10, Pausing/Stopping" lost its pointer');
  const stopping = fs.readFileSync(path.join(REFERENCES, 'stopping.md'), 'utf8');
  assert.ok(stopping.includes('### Pausing') && stopping.includes('### Stopping'));
});

// --- bug-18: the dispatch prompt has to say the session is inside a run ------
// A dispatched execute session had nothing in its context saying so: its
// prompt was the bare trigger, its cwd a worktree (which a human also makes
// by hand) and its branch `backlog/<id>` (which a *previous* run also leaves
// behind for a hand-merge). So when the user messaged it through the
// dashboard — a channel the run never gave it and did not know it had — it
// answered the user, and the queue sat idle for three round-trips.
//
// The prompt is the only string both the model and the human reading the
// dashboard drawer see, which is why the fix lives there rather than in
// `--append-system-prompt` or an env var. These cases pin the shape of that
// string and the coupling between the two SKILL.md files that read it.

const EXECUTE_SKILL_MD = path.join(SKILLS_ROOT, 'backlog-execute', 'SKILL.md');

// One constant, both halves. The marker is worthless if orchestrate emits one
// token and execute recognises a different one that merely reads alike — the
// same posture test/watchdog-coupling.ts takes for the board and the sweeper.
const RUN_MARKER_TOKEN = '[orchestrator-run';

test('exactly one dispatch line carries the run marker, and it is the fresh dispatch', () => {
  // The --resume retry deliberately does NOT repeat the marker: a resumed
  // session still carries its original prompt, so a second copy would be
  // noise in the one string a human reads in the dashboard drawer. Nor does
  // §7's fresh fixer (#226): it is not a /backlog-execute session at all —
  // execute refuses an item already in done/ — and its prompt file carries
  // the marker's constraints in its own words.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const dispatchLines = text.split('\n').filter((l) => l.includes('exec claude -p'));
  const marked = dispatchLines.filter((l) => l.includes(RUN_MARKER_TOKEN));
  assert.equal(marked.length, 1, `expected exactly 1 dispatch line carrying ${RUN_MARKER_TOKEN}, found ${marked.length}`);
  assert.ok(!marked[0].includes('--resume'), 'the run marker landed on the --resume retry line rather than the fresh dispatch');
  // The three launchers, told apart: the marked execute dispatch, the one
  // --resume line, and a fresh fixer carrying neither and no trigger.
  const resumed = dispatchLines.filter((l) => l.includes('--resume'));
  assert.equal(resumed.length, 1, `expected exactly 1 --resume launcher, found ${resumed.length}`);
  const fresh = dispatchLines.filter((l) => !l.includes('--resume') && !l.includes(RUN_MARKER_TOKEN));
  assert.equal(fresh.length, 1, `expected exactly 1 fresh fix launcher, found ${fresh.length}`);
  assert.ok(!fresh[0].includes('/backlog-execute'), `the fresh fix launcher invokes /backlog-execute, which refuses a done item: ${fresh[0]}`);
  assert.ok(fresh[0].includes('-n "orch <id> fix <n>"'), `the launcher with neither --resume nor the marker is not the fix loop's: ${fresh[0]}`);
});

test('the marker follows the id rather than preceding it', () => {
  // backlog-execute's "Pick an item" reads the trigger's own words for an id.
  // Putting the marker between the trigger and the id is how this fix would
  // teach that section to guess.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const line = text.split('\n').find((l) => l.includes('exec claude -p') && l.includes(RUN_MARKER_TOKEN));
  assert.ok(line, 'no dispatch line carries the run marker at all');
  const trigger = line.indexOf('/backlog-execute');
  const marker = line.indexOf(RUN_MARKER_TOKEN);
  assert.ok(trigger !== -1, 'the marked dispatch line no longer invokes /backlog-execute');
  assert.ok(marker > trigger, 'the marker sits before the trigger');
  // `<id>` is the placeholder the section substitutes; it must still be the
  // first token after the trigger, i.e. before the marker opens.
  const id = line.indexOf('<id>', trigger);
  assert.ok(id !== -1 && id < marker, 'the item id no longer sits between the trigger and the marker');
});

test('no dispatch line contains an apostrophe', () => {
  // The dispatch is `nohup sh -c '…'`: a single-quoted body with the prompt
  // double-quoted inside it. One apostrophe closes the outer quote and the
  // whole line becomes a syntax error — on the one line whose failure mode is
  // "every item in the queue parks". Asserted on the line, never on prose
  // promising the line is clean.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const dispatchLines = text.split('\n').filter((l) => l.includes('exec claude -p'));
  assert.equal(dispatchLines.length, 3, `expected exactly 3 headless dispatch lines, found ${dispatchLines.length}`);
  for (const line of dispatchLines) {
    const body = line.slice(line.indexOf("sh -c '") + "sh -c '".length, line.lastIndexOf("'"));
    assert.ok(!body.includes("'"), `an apostrophe is back inside the single-quoted dispatch body: ${line}`);
  }
});

test('the marker orchestrate emits is the one backlog-execute recognises', () => {
  // Read out of orchestrate's own dispatch line rather than hard-coded twice,
  // so the two files cannot drift into two markers that look alike.
  const orchestrate = fs.readFileSync(SKILL_MD, 'utf8');
  const execute = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8');
  const line = orchestrate.split('\n').find((l) => l.includes('exec claude -p') && l.includes(RUN_MARKER_TOKEN));
  assert.ok(line, 'no dispatch line carries the run marker at all');
  assert.ok(line.includes(RUN_MARKER_TOKEN), `the dispatch line no longer opens its marker with ${RUN_MARKER_TOKEN}`);
  assert.ok(
    execute.includes(RUN_MARKER_TOKEN),
    `backlog-execute/SKILL.md does not name ${RUN_MARKER_TOKEN}, so a dispatched session cannot recognise the marker it is handed`
  );
});

test('backlog-execute keeps the rules a dispatched session runs on', () => {
  // One assertion per rule, naming the rule rather than the string, so a
  // failure says which rule was compressed away. This section is injected on
  // every turn of every execute session, so it is under constant pressure to
  // shrink — and the rule most likely to go is the one whose absence produced
  // the bug.
  const text = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8');
  const RULES = [
    ['Never escalate to the user', 'a dispatched session never escalates to the user'],
    ['not an instruction', 'a user message that arrives mid-run is not an instruction'],
    ['orchestrate.mjs', 'orchestrate.mjs is unreachable from inside a worktree, so the session cannot park itself'],
    ['final assistant message', 'the escalation channel is the final assistant message and the item Outcome']
  ];
  for (const [needle, rule] of RULES) {
    assert.ok(text.includes(needle), `backlog-execute/SKILL.md lost the rule: ${rule} (${needle})`);
  }
});

test('backlog-execute recognises the marker by presence, never by position', () => {
  // The marker is deliberately NOT the first thing in the trigger words — the
  // id is, and a sibling case pins that. A recognition rule phrased as "if the
  // trigger words open with the token" therefore describes a string the
  // orchestrator never emits, and every rule under it silently never fires.
  const text = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8');
  assert.ok(text.includes('anywhere after the id'), 'backlog-execute no longer says the marker is recognised anywhere after the id');
  assert.ok(!/open(s)? with the token/.test(text), 'backlog-execute is back to requiring the marker to come first, which the dispatch line never does');
});

test('backlog-execute redirects its user-facing exits when the marker holds', () => {
  // Two sentences in the body name the user as the channel, and both are on
  // paths a dispatched session reaches: the verification-failure exit, and the
  // never-commits hard limit. A new section elsewhere saying "never escalate"
  // does not reach a session already reading one of those sentences — each has
  // to carry the exception itself.
  const text = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8');

  const failure = text.slice(text.indexOf('## If verification fails'));
  const failureSection = failure.slice(0, failure.indexOf('\n## ', 1));
  assert.ok(failureSection.length > 0, 'the verification-failure section is gone');
  assert.ok(
    failureSection.includes(RUN_MARKER_TOKEN),
    `the verification-failure path still hands the decision to a user with no exception for ${RUN_MARKER_TOKEN}`
  );

  const bulletStart = text.indexOf('- **Never commits, never pushes.**');
  assert.ok(bulletStart !== -1, 'the never-commits hard limit is gone');
  const bullet = text.slice(bulletStart, text.indexOf('\n- ', bulletStart + 1));
  assert.ok(bullet.includes(RUN_MARKER_TOKEN), `the never-commits hard limit still tells the user what changed with no exception for ${RUN_MARKER_TOKEN}`);
});

// --- #221: a headless session never backgrounds its test runs --------------
//
// An execute session dispatched under `claude -p` ran its suite with Bash
// `run_in_background: true` and ended its turn to wait for the notification.
// Headless, there is no next turn: the process exits when the turn ends, so no
// Outcome was written, the final message said only "waiting", and the driver
// parked the item with its edits uncommitted. The rule lives in three places a
// dispatched session reads — the fresh prompt, the retry prompt, and execute's
// marker section — and each is pinned here, because each is prose under
// constant pressure to be compressed away.
//
// #242 narrowed it. The blanket ban also forbade the one legitimate background
// process — a dev server kept up across several Playwright calls inside ONE
// turn — so a UI change went unverified and was handed to a human. The
// exception is pinned with its two guard rails: the server dies by the pid
// recorded when it started (never a pattern kill), and it dies before the turn
// ends, so the #221 failure — a turn that ends with something still running —
// stays banned outright.

const BACKGROUND_RULE =
  'Never run a command in the background, and never end a turn with one still running; run tests, typecheck and build in the foreground. ' +
  'One exception: a dev server for Playwright browser verification, its pid recorded in the call that starts it and killed by that pid, never by pattern, ' +
  'before the turn ends.';

test('the background rule names its one exception with the recorded-pid kill and the turn-end deadline', () => {
  assert.ok(BACKGROUND_RULE.includes('never end a turn with one still running'), 'the rule no longer bans ending a turn with a background process alive');
  assert.ok(BACKGROUND_RULE.includes('killed by that pid, never by pattern'), 'the exception no longer names the recorded-pid kill');
  assert.ok(BACKGROUND_RULE.includes('before the turn ends'), 'the exception no longer says the server dies before the turn ends');
});

test('the fix-loop prompt file is told to carry the same background rule', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const start = text.indexOf('**`mode: "fresh"`**');
  assert.ok(start !== -1, 'the fresh fix-loop instructions are gone');
  const paragraph = text.slice(start, text.indexOf('```', start));
  assert.ok(paragraph.includes(BACKGROUND_RULE), `the fix-loop prompt instructions no longer carry the background rule: ${BACKGROUND_RULE}`);
});

test('the fresh dispatch prompt forbids backgrounded commands', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const line = text.split('\n').find((l) => l.includes('exec claude -p') && l.includes(RUN_MARKER_TOKEN));
  assert.ok(line, 'no dispatch line carries the run marker at all');
  assert.ok(line.includes(BACKGROUND_RULE), `the fresh dispatch prompt lost the background rule: ${BACKGROUND_RULE}`);
});

test('the retry prompt file is told to carry the same background rule', () => {
  // The retry line reads its prompt out of a file the driver writes, so the
  // rule cannot sit on the line itself — it sits in the instruction for what
  // that file must say, which is the prose between "Retry resumes" and the
  // retry's own code fence.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const start = text.indexOf('Retry resumes');
  assert.ok(start !== -1, 'the retry instructions are gone');
  const paragraph = text.slice(start, text.indexOf('```', start));
  assert.ok(paragraph.includes(BACKGROUND_RULE), `the retry prompt instructions no longer carry the background rule: ${BACKGROUND_RULE}`);
});

test('backlog-execute forbids backgrounding inside its marker section, with the reason', () => {
  // Inside the marker section specifically: a hand session may background a
  // suite and wait on the notification, because it has a next turn.
  const text = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8');
  const section = text.slice(text.indexOf('## Am I inside an orchestrator run?'), text.indexOf('No marker means a human started this session'));
  assert.ok(section.length > 0, 'the marker section is gone');
  assert.ok(section.includes('run_in_background'), 'the marker section no longer names run_in_background');
  assert.ok(section.includes('Never run anything in the background'), 'the marker section lost the no-background rule');
  assert.ok(section.includes('600000'), 'the marker section no longer names the foreground alternative: raising the Bash timeout');
  assert.ok(/exits the moment a turn ends/.test(section), 'the marker section lost the reason: headless -p exits when the turn ends');
});

test('backlog-execute allows exactly one background process — a browser-verification server killed by its recorded pid before the turn ends', () => {
  const text = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8');
  const section = text.slice(text.indexOf('## Am I inside an orchestrator run?'), text.indexOf('No marker means a human started this session'));
  assert.ok(section.includes('never end a turn with one still running'), 'the marker section no longer bans ending a turn with a background process alive');
  assert.ok(section.includes('One exception'), 'the marker section lost the browser-verification exception');
  assert.ok(section.includes('echo $!'), 'the exception no longer records the pid in the call that starts the server');
  assert.ok(section.includes('kill <pid>'), 'the exception no longer kills by the recorded pid');
  assert.ok(/never by pattern/.test(section), 'the exception no longer forbids a pattern kill');
  assert.ok(/before the turn ends/.test(section), 'the exception no longer says the server dies before the turn ends');
  assert.ok(/Tests, typecheck and build stay foreground-only/.test(section), 'the exception no longer keeps tests, typecheck and build in the foreground');
});

test('backlog-execute verifies a visible UI change in the browser, and "needs a human" only when no Playwright tool is loaded', () => {
  const text = fs.readFileSync(EXECUTE_SKILL_MD, 'utf8');
  const section = text.slice(text.indexOf('## Before you call it done'), text.indexOf('Verification proves the _work_'));
  assert.ok(section.includes('Playwright'), 'the verification step no longer names browser verification with Playwright');
  for (const what of ['layout', 'narrow width', 'light theme']) assert.ok(section.includes(what), `browser verification no longer checks the ${what}`);
  assert.ok(/only when no Playwright tool is\s+loaded/.test(section), 'the verification step no longer limits "needs a human" to a session with no Playwright tool');
});

// --- bug-20: the environment marker the Stop hook reads ---------------------
//
// Every orchestrator-owned headless session used to finish its work and then
// sit for up to ten minutes doing nothing. The dashboard's Stop hook holds a
// finished turn open at POST /api/messages/wait so a remote answer can still
// arrive, and it deliberately skips the idle gate for a headless session —
// there is no terminal to type into, so the dashboard window is that session's
// only channel. An orchestrator-dispatched session is headless and nobody is
// ever going to answer it, so the hold was pure wall-clock: per item, not per
// run, plus a guaranteed extra `watch` round-trip past the one that would have
// caught the exit.
//
// The hook already reads `BM_ORCH_RUN` and takes its notify-and-exit path when
// it is set (claude-agents-dashboard, scripts/stop-notify-hook.sh — a symlink
// target, tracked source, not a loose machine-local file). That half is inert
// until something sets the variable, which is what these cases pin.
//
// This is the SECOND marker on the same dispatch line and it does not replace
// the first: bug-18's `[orchestrator-run …]` lives in the prompt because its
// reader is the model and the human reading the dashboard drawer, and neither
// can see an environment. This one lives in the environment because its reader
// is a hook, and a hook cannot see a prompt. The channel follows the reader.

// One constant, read into every case below, so SKILL.md and any future
// consumer cannot drift into two spellings of the same variable.
const ORCH_RUN_ENV = 'BM_ORCH_RUN';

test('every dispatch line exports the run id to the session it spawns', () => {
  // All three lines, unlike the prompt marker above, which is deliberately on
  // the fresh dispatch only. A resumed session or a fresh fixer is owned by the
  // run exactly as much as the original was, and each is a separate `exec
  // claude -p` process with a separate environment — the first line's
  // assignment does not reach it.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const dispatchLines = text.split('\n').filter((l) => l.includes('exec claude -p'));
  assert.equal(dispatchLines.length, 3, `expected exactly 3 headless dispatch lines, found ${dispatchLines.length}`);
  for (const line of dispatchLines) {
    assert.ok(line.includes(`${ORCH_RUN_ENV}=<runId> exec claude -p`), `dispatch line does not assign ${ORCH_RUN_ENV} immediately before exec claude: ${line}`);
  }
});

test('the run id assignment sits inside the sh -c body, not in front of nohup', () => {
  // `VAR=x nohup sh -c '…'` would export the variable to nohup and thence to
  // the shell, and the shell would pass it on — but the run composes this line
  // by substituting into a template, and an assignment outside the quoted body
  // is one whose value a stray space or an unquoted substitution can detach
  // from the command entirely. Inside the body it is a plain simple-command
  // prefix on `exec`, which POSIX places in the exec'd program's environment.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const dispatchLines = text.split('\n').filter((l) => l.includes('exec claude -p'));
  for (const line of dispatchLines) {
    const body = line.slice(line.indexOf("sh -c '") + "sh -c '".length, line.lastIndexOf("'"));
    assert.ok(body.includes(ORCH_RUN_ENV), `${ORCH_RUN_ENV} is outside the single-quoted dispatch body: ${line}`);
  }
});

test('SKILL.md names no environment variable but the three it owns', () => {
  // A closed allowlist rather than a search for near-misses: the failure this
  // guards is a second spelling of the run-ownership marker (BM_ORCH_RUN_ID,
  // BM_ORCHESTRATOR_RUN, …), which no pattern can tell from a legitimate new
  // variable, and the hook tests one name only — prose naming another is how
  // this dispatch line gets "fixed" into inertness. BM_PLUGIN_ROOT and
  // BM_RUN_DIR are the verify line's own two, passed in through `nohup env`
  // because its body dereferences them; this one is substituted at compose
  // time instead, so it is a plain assignment on the command.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const ALLOWED = new Set([ORCH_RUN_ENV, 'BM_PLUGIN_ROOT', 'BM_RUN_DIR']);
  const unexpected = [...new Set([...text.matchAll(/BM_[A-Z_]+/g)].map((m) => m[0]))].filter((n) => !ALLOWED.has(n));
  assert.deepEqual(unexpected, [], `SKILL.md names an environment variable nothing reads: ${unexpected.join(', ')}`);
  assert.ok(text.includes(ORCH_RUN_ENV), `SKILL.md no longer names ${ORCH_RUN_ENV} at all`);
});

// --- bug-31: a run-composed prompt travels in a file, never in argv --------
// The retry launcher spelled its prompt `"<what to do differently>"` — double
// quoted, but INSIDE the single-quoted `sh -c '…'` body, which is a command
// position: a double-quoted word still undergoes command substitution. §7 then
// ordered the one text most certain to contain backticks pasted into exactly
// that position ("paste the findings as the reviewer wrote them"), so a
// reviewer quoting `rowId` had the driver's shell run `rowId`. Three `.err`
// files on this machine caught it, in three different projects.
//
// The last two cases EXECUTE the line out of SKILL.md rather than asserting
// about its text, because the property at stake — "sh does not expand this" —
// is a property of sh, not of a string, and only sh can be asked.

const RETRY_PROMPT_FILE = '<dir>/prompts/<id>-retry-1.txt';
const FIX_PROMPT_FILE = '<dir>/prompts/<id>-fix-<n>.txt';

// The three `nohup sh -c '… exec claude -p …'` launchers, read off SKILL.md.
// Named apart from `dispatchNames()` below, which parses the same three lines
// for a different field.
function execClaudeLines(text) {
  return text.split('\n').filter((l) => l.includes('exec claude -p'));
}

function retryLineOf(text) {
  const line = execClaudeLines(text).find((l) => l.includes('--resume'));
  assert.ok(line, 'SKILL.md no longer carries a `--resume` retry launcher at all');
  return line;
}

// §7's fresh fixer (#226): the one launcher with neither `--resume` nor the
// run marker. Its prompt is the most hostile text in the system — reviewer
// findings verbatim — so it is held to bug-31's rules exactly as the retry is.
function freshFixLineOf(text) {
  const line = execClaudeLines(text).find((l) => !l.includes('--resume') && !l.includes('[orchestrator-run'));
  assert.ok(line, "SKILL.md no longer carries §7's fresh fix launcher at all");
  return line;
}

test('the fresh fix launcher takes its prompt from the fix prompt file, behind a test -s guard', () => {
  const fresh = freshFixLineOf(fs.readFileSync(SKILL_MD, 'utf8'));
  assert.ok(fresh.includes(`$(cat "${FIX_PROMPT_FILE}")`), `the fresh fix launcher does not read its prompt back from ${FIX_PROMPT_FILE}: ${fresh}`);
  assert.ok(fresh.includes(`test -s "${FIX_PROMPT_FILE}" &&`), `the fresh fix launcher has no \`test -s\` guard on its prompt file: ${fresh}`);
  assert.ok(
    fresh.includes('> "<dir>/logs/<id>-fix-<n>.jsonl" 2> "<dir>/logs/<id>-fix-<n>.err"'),
    `the fresh fixer writes somewhere usage will not look: ${fresh}`
  );
  for (const flag of ['--output-format stream-json', '--verbose', '--permission-mode auto', '--model opus', '${LOCAL:+--settings "$LOCAL"}']) {
    assert.ok(fresh.includes(flag), `the fresh fix launcher dropped ${flag}: ${fresh}`);
  }
});

// The §7 ordering a driver follows: ask the tool, then pick a launcher. Both
// must still follow the verb — dropping either leaves one mode with nothing to run.
test('§7 runs fix-mode before either fix launcher', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const review = text.slice(text.indexOf('## 7. Review'), text.indexOf('## 8. Verify'));
  const verbAt = review.indexOf('orchestrate.mjs" fix-mode <id>');
  assert.ok(verbAt !== -1, '§7 never runs `orchestrate.mjs fix-mode <id>`');
  const after = review.slice(verbAt);
  assert.match(after, /step 5's retry line/, 'no resume launcher follows fix-mode in §7');
  assert.ok(after.includes(freshFixLineOf(text)), 'the fresh fix launcher does not sit in §7 after fix-mode');
});

test('recovery.md says which session resume-session resumes after a fresh fix loop', () => {
  const text = fs.readFileSync(path.join(path.dirname(SKILL_MD), 'references', 'recovery.md'), 'utf8');
  const bullet = text.slice(text.indexOf('- **`resume-session`**'), text.indexOf('- **`redispatch-after-stop`**'));
  assert.match(bullet, /fix-mode|fresh fix loop/, "recovery.md's resume-session bullet says nothing about a fresh fix loop");
});

test('the retry launcher takes its prompt from a file, not from argv', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  assert.equal(execClaudeLines(text).length, 3, 'expected exactly 3 headless dispatch lines');
  const retry = retryLineOf(text);
  assert.ok(retry.includes(`$(cat "${RETRY_PROMPT_FILE}")`), `the retry launcher does not read its prompt back from ${RETRY_PROMPT_FILE}: ${retry}`);
  assert.ok(!retry.includes('<what to do differently>'), `the retry launcher still interpolates prose into a command position: ${retry}`);
  // The guard: without it a missing or empty prompt file degrades to `""` and
  // the run spends its one fix loop on a session resumed with no instruction.
  assert.ok(retry.includes(`test -s "${RETRY_PROMPT_FILE}"`), `the retry launcher has no \`test -s\` guard on its prompt file: ${retry}`);
});

test('the prompt file is written before the launcher, and by the Write tool', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(text.includes(FIX_PROMPT_FILE), `SKILL.md never names ${FIX_PROMPT_FILE}, so §7's fix loop has no prompt file`);
  const launcherAt = text.indexOf(retryLineOf(text));
  const writeAt = text.indexOf(RETRY_PROMPT_FILE);
  assert.ok(writeAt !== -1, `SKILL.md never names ${RETRY_PROMPT_FILE}`);
  assert.ok(writeAt < launcherAt, 'the prompt file is named for the first time on the launcher line itself — nothing has written it yet');
  assert.match(text.slice(writeAt, launcherAt), /Write tool/, 'nothing between naming the prompt file and launching says to write it with the Write tool');
  // Mechanical, because this is the half a later edit "simplifies": a heredoc
  // delimiter that happens to appear in the findings ends the document early,
  // and `printf '%s' '…'` re-introduces the apostrophe problem the whole fix
  // exists to remove.
  const shellWrites = text.split('\n').filter((l) => l.includes('prompts/') && (l.includes('printf') || l.includes('<<')));
  assert.deepEqual(shellWrites, [], 'a prompt file is being written through the shell rather than with the Write tool');
});

test('the no-prose-in-argv rule is stated once, and §3 obeys it too', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  // The rule itself, in §4's dispatch rules, so it covers the family rather
  // than only the two lines bug-31 happened to find.
  assert.match(text, /never rides a shell command line/, "§4's dispatch rules no longer state the rule that prose this run did not compose goes in a file");
  // §3's two payload writes were the remaining inline ones: an apostrophe
  // inside a question was a syntax error there too.
  const printfPayloads = text.split('\n').filter((l) => l.includes('printf') && l.includes('questions/'));
  assert.deepEqual(printfPayloads, [], 'a questions payload is still being written with printf');
  // The second half, which the first round of this fix left out: the values
  // that stay inline are safe because they are PARAPHRASES, and the rule has
  // to say so or the three sites that take one have no rule over them.
  assert.match(
    text,
    /never a verbatim quote of\s+text this run did not compose/,
    '§4 states the rule for argv payloads but not for the --detail/--note values that stay inline'
  );
});

// A payload with one of each hazard the Cause names: a backtick-quoted
// identifier, a `$(…)` that leaves visible evidence when it runs, and CSS
// whose `var(--ink)` is what produced bug-15-fix-1.err's `syntax error near
// unexpected token`.
const HOSTILE_SUBST = 'Fix `rowId` here, then $(touch OWNED), and `.run-track-name-stalled { color: var(--ink) }`';
// Plus the second failure mode: an apostrophe closes the single-quoted body.
const HOSTILE = `${HOSTILE_SUBST} — it's wrong\n`;

// Composes a runnable command out of SKILL.md's own retry line: every
// placeholder substituted, `claude` swapped for a stub that dumps its argv,
// and nothing else touched. Retyping the line here would prove something
// about this test instead of about the file a run actually reads.
//
// `inline: true` reproduces the PRE-fix shape through the same harness —
// prompt interpolated into the command, no `test -s` guard — which is what
// makes a green result mean anything.
function retryHarness(t, { prompt, inline = false, writePrompt = true, launcher = 'retry' }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-shell-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'runstate');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  const cwd = path.join(root, 'project');
  // The line's first act is `cd "$PWD/.worktrees/<id>"`, so the substitution
  // below runs with THAT as its cwd — which is where a `touch` would land.
  fs.mkdirSync(path.join(cwd, '.worktrees', 'bug-1'), { recursive: true });

  const argvFile = path.join(root, 'argv');
  const stub = path.join(root, 'stub.sh');
  fs.writeFileSync(stub, `#!/bin/sh\n: > ${argvFile}\nfor a in "$@"; do printf '%s\\0' "$a" >> ${argvFile}; done\n`);
  fs.chmodSync(stub, 0o755);

  // `launcher: 'fix'` drives §7's fresh fixer (#226) through the same
  // harness; its prompt file and logs carry the loop's `<n>`, substituted 1.
  const slot = launcher === 'fix' ? 'fix-1' : 'retry-1';
  const promptFile = path.join(dir, 'prompts', `bug-1-${slot}.txt`);
  if (writePrompt) fs.writeFileSync(promptFile, prompt);

  const text = fs.readFileSync(SKILL_MD, 'utf8');
  let line = (launcher === 'fix' ? freshFixLineOf(text) : retryLineOf(text))
    .replaceAll('<dir>', dir)
    .replaceAll('<id>', 'bug-1')
    .replaceAll('<runId>', 'run-1')
    .replaceAll('<sessionId>', 's1')
    .replaceAll('<n>', '1')
    .replace('exec claude ', `exec ${stub} `);
  if (inline) {
    line = line.replace(`test -s "${promptFile}" && `, '').replace(`"$(cat "${promptFile}")"`, `"${prompt.trimEnd()}"`);
    assert.ok(!line.includes('$(cat'), 'the inline variant still reads the prompt from a file');
  }
  // `wait` for the backgrounded `nohup … &`: the line detaches on purpose, and
  // a test that did not wait would assert against a process still starting.
  const result = spawnSync('sh', ['-c', `${line}\nwait`], { cwd, encoding: 'utf8' });

  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1) : null;
  const owned = fs.readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith('OWNED'));
  const errFile = path.join(dir, 'logs', `bug-1-${slot}.err`);
  return { root, argv, owned, result, err: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : null };
}

test('bug-31 red proof: a file-carried prompt reaches argv intact and executes nothing', (t) => {
  const fixed = retryHarness(t, { prompt: HOSTILE });
  assert.ok(fixed.argv, `the launcher spawned nothing at all: ${fixed.result.stderr}`);
  // `-p --resume s1 <prompt> --output-format …` — the prompt is argv[3].
  // `$(cat …)` strips trailing newlines, which is the only difference allowed.
  assert.equal(fixed.argv[3], HOSTILE.trimEnd());
  assert.deepEqual(fixed.owned, [], 'the substitution in the prompt was executed');
  assert.equal(fixed.err, '', `stderr from the launcher: ${fixed.err}`);

  // The same harness on the pre-fix shape — if this stayed green the case
  // above would be pinning nothing.
  const pre = retryHarness(t, { prompt: `${HOSTILE_SUBST}\n`, inline: true });
  assert.ok(pre.argv, 'the pre-fix shape spawned nothing, so this comparison is vacuous');
  assert.ok(pre.owned.length > 0, 'the pre-fix shape did not execute the substitution, so this harness cannot go red');
  assert.notEqual(pre.argv[3], HOSTILE_SUBST, 'the pre-fix shape delivered the prompt intact');

  // Second failure mode, unseen in the wild only because it destroys the
  // dispatch before anything can log it: one apostrophe ends the body.
  const quoted = retryHarness(t, { prompt: HOSTILE, inline: true });
  assert.equal(quoted.argv, null, 'an apostrophe in an inline prompt still managed to spawn a session');
});

// Review focus 5 of #226: the fresh fixer is a third launcher carrying
// reviewer findings, so bug-31's hazard gets its own proof on it.
test('the fresh fix launcher delivers hostile findings byte-identical and executes nothing', (t) => {
  const fresh = retryHarness(t, { prompt: HOSTILE, launcher: 'fix' });
  assert.ok(fresh.argv, `the fresh fix launcher spawned nothing at all: ${fresh.result.stderr}`);
  // `-p <prompt> --output-format …` — no --resume, so the prompt is argv[1].
  assert.equal(fresh.argv[0], '-p');
  assert.equal(fresh.argv[1], HOSTILE.trimEnd());
  assert.ok(!fresh.argv.includes('--resume'), 'the fresh fixer resumed a session');
  assert.deepEqual(fresh.owned, [], 'the substitution in the findings was executed');
  assert.equal(fresh.err, '', `stderr from the launcher: ${fresh.err}`);

  const empty = retryHarness(t, { prompt: '', launcher: 'fix' });
  assert.equal(empty.argv, null, 'an empty fix prompt file still spawned a fresh session');
});

test('an absent or empty prompt file spawns nothing', (t) => {
  const absent = retryHarness(t, { prompt: HOSTILE, writePrompt: false });
  assert.equal(absent.argv, null, 'the launcher resumed a session with no instruction at all');
  const empty = retryHarness(t, { prompt: '' });
  assert.equal(empty.argv, null, 'an empty prompt file still resumed the session');
});

// --- the main tree's settings.local.json reaches the worktree session --------
// A per-item worktree is a checkout, and `.claude/settings.local.json` is
// gitignored, so the session `cd`-ed into it ran without every rule the user
// had granted the project locally while the driver one directory up had them
// all. Every launcher now resolves the file BEFORE the `cd` and passes it through
// `--settings`, omitting the flag when there is no file. Executed out of
// SKILL.md for the same reason bug-31's cases are: "this splits into two argv
// words and keeps a spaced path whole" is a property of sh, and zsh — the
// shell a person would retype the line into — gets it wrong.
function launchHarness(t, line, { settingsLocal }) {
  // A space in the root, so a path that word-split would show up as a third argv word rather than passing by luck.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch settings-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'runstate');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts', 'bug-1-retry-1.txt'), 'do it differently\n');
  fs.writeFileSync(path.join(dir, 'prompts', 'bug-1-fix-1.txt'), 'fix what the review found\n');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, '.worktrees', 'bug-1'), { recursive: true });
  const local = path.join(cwd, '.claude', 'settings.local.json');
  if (settingsLocal) {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, '{"permissions":{"allow":[]}}\n');
  }
  // A worktree-side copy the flag must NOT point at: the line resolves the path before `cd`, and this is what resolving it after would find.
  fs.mkdirSync(path.join(cwd, '.worktrees', 'bug-1', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.worktrees', 'bug-1', '.claude', 'settings.local.json'), '{}\n');

  const argvFile = path.join(root, 'argv');
  const stub = path.join(root, 'stub.sh');
  fs.writeFileSync(stub, `#!/bin/sh\n: > "${argvFile}"\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argvFile}"; done\n`);
  fs.chmodSync(stub, 0o755);

  const composed = line
    .replaceAll('<dir>', dir)
    .replaceAll('<id>', 'bug-1')
    .replaceAll('<runId>', 'run-1')
    .replaceAll('<sessionId>', 's1')
    .replaceAll('<n>', '1')
    .replaceAll('<m>', '1')
    .replace('exec claude ', `exec "${stub}" `);
  const result = spawnSync('sh', ['-c', `${composed}\nwait`], { cwd, encoding: 'utf8' });
  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1) : null;
  return { argv, local, result };
}

test("every launcher passes the main tree's settings.local.json to the worktree session", (t) => {
  const lines = execClaudeLines(fs.readFileSync(SKILL_MD, 'utf8'));
  assert.equal(lines.length, 3, 'expected exactly 3 headless dispatch lines');
  for (const line of lines) {
    const { argv, local, result } = launchHarness(t, line, { settingsLocal: true });
    assert.ok(argv, `the launcher spawned nothing: ${result.stderr}`);
    const at = argv.indexOf('--settings');
    assert.ok(at !== -1, `no --settings reached the session: ${JSON.stringify(argv)}`);
    // The very next word is the whole root-side path — not split at the space, and not the worktree's own copy.
    assert.equal(argv[at + 1], local);
    assert.equal(argv.filter((a) => a === '--settings').length, 1);
  }
});

test('a project with no settings.local.json gets no --settings flag at all', (t) => {
  for (const line of execClaudeLines(fs.readFileSync(SKILL_MD, 'utf8'))) {
    const { argv, result } = launchHarness(t, line, { settingsLocal: false });
    assert.ok(argv, `the launcher spawned nothing: ${result.stderr}`);
    // Absent, not `--settings ""` and not the worktree's copy found after the `cd`.
    assert.ok(!argv.includes('--settings'), `a --settings flag was passed with no local file at the project root: ${JSON.stringify(argv)}`);
    assert.ok(argv.includes('--permission-mode'), 'the stub did not receive the rest of the line');
  }
});

// The other half of the same rule, and the half the first round of this fix
// missed: `attention --detail`, `stage --note` and `merge-mode --note` stay
// inline arguments, so what protects them is that their VALUES are the
// driver's own words. §2 and §9 both used to say `--note "<the classifier's
// own message, verbatim>"` — model-written free text (`Reason: …`) in a
// double-quoted argument, which is the identical defect to the one the retry
// launcher had, in the file that now forbids it.
//
// A closed allowlist rather than a pattern, for the reason the environment
// variable case above uses one: no regex can tell "a placeholder the driver
// fills with its own summary" from "a placeholder the driver fills with
// somebody else's prose". Adding a spelling here is meant to be a decision.
const NOTE_PLACEHOLDERS = new Map([
  // Substituted by the run from its own state: an item id proven by
  // `isItemId`, and paths/refs it read out of git. None can carry a
  // backtick or an apostrophe by construction.
  ['<id>', 'a validated item id'],
  ['<dir>', 'the run-state directory this run resolved'],
  ['<path>', 'a worktree path this run created'],
  // task-44. Read out of git, never composed by a model: `<base>` is the run's
  // own recorded base, which `assertUsableBase` proved is a legal ref name
  // before `init` wrote it. (`<paths>`, `<ref>`, `<base tree>` and `<message>`
  // left this list when `merge-check` took over the park details that used
  // them: the tool composes those from git's own output now, and its cases pin
  // the exact wording — including git's quoted refusal, merge-check 12.)
  ['<base>', "the run's own recorded base branch"],
  // Composed by the tool in this repo, not by a model: `plan --json`'s own
  // fixed refusal strings.
  ["<the gate's own reason>", "the ungroomed gate's own fixed wording"],
  // `leftover`'s own `detail`: fixed words around the item id and two paths this
  // run derived from its own project root, composed in `probeLeftover` and pinned
  // by leftover/worktree 5, 5b and 5c (5c is the archive-diff failure, whose git
  // error rides in a separate `gitError` field the body never quotes).
  // Nothing a model or a person wrote.
  ["<the leftover verdict's detail>", "`leftover`'s own fixed wording for an unexpected branch/worktree/directory combination"],
  // Spelled to say whose words they are. The verbatim text each of these
  // summarises lives where the same string points — the reviewer's report,
  // the rows in `status --json`, this session's transcript.
  ['<what happened, your words>', "the driver's summary of a dead session"],
  ['<verdict summary, your words>', "the driver's summary of a review verdict"],
  ['<the failing command names>', 'command names, never their output'],
  ['<why, your words>', "the driver's reason for skipping an item"],
  // task-47, and spelled the same way as the three above it for the same
  // reason. An API refusal's sentence is composed by the SERVER out of what
  // GitHub said — prose this run did not compose, carrying whatever
  // punctuation GitHub felt like — so it is exactly the text this rule exists
  // to keep off a command line. The copy of record is the tool's own stderr in
  // the run's log; the detail is a summary in the driver's voice.
  ['<what the API refused, your words>', "the driver's summary of an API refusal"]
]);

// Values can wrap across lines in prose (`--detail\n"<what happened…>"`), so
// the text is flattened first: a line-by-line scan silently misses those, and
// a missed site is exactly how this class survived round one.
function noteValues(file) {
  const flat = fs.readFileSync(file, 'utf8').replace(/\s*\n\s*/g, ' ');
  return [...flat.matchAll(/--(?:note|detail)\s+"([^"]*)"/g)].map((m) => m[1]);
}

test("every --detail and --note value is the driver's own words", () => {
  // `invariants.md` is in this list because leaving it out is how the rule
  // drifted: fix loop 1 changed both `merge-mode branch --note` sites in
  // SKILL.md and left this file — the one CLAUDE.md sends a reader to before
  // touching merge mode — still prescribing the value it had just removed. The
  // canonical statement of a command and the command itself are two copies of
  // one contract, so one scan reads both.
  const FILES = [
    SKILL_MD,
    path.join(SKILLS_ROOT, 'backlog-orchestrate', 'references', 'recovery.md'),
    path.join(SKILLS_ROOT, 'backlog-orchestrate', 'references', 'rationale.md'),
    path.join(SKILLS_ROOT, 'backlog-orchestrate', 'references', 'tracker.md'),
    // The four rare-path references (task 5 of the body-shrink plan) carry `--detail` templates that left the body with their prose.
    path.join(SKILLS_ROOT, 'backlog-orchestrate', 'references', 'questions.md'),
    path.join(SKILLS_ROOT, 'backlog-orchestrate', 'references', 'stopping.md'),
    path.join(SKILLS_ROOT, 'backlog-orchestrate', 'references', 'merge-failures.md'),
    path.join(SKILLS_ROOT, 'backlog-orchestrate', 'references', 'check-failures.md'),
    path.join(SKILLS_ROOT, '..', 'docs', 'subsystems', 'invariants.md')
  ];
  const seen = new Set();
  let count = 0;
  for (const file of FILES) {
    for (const value of noteValues(file)) {
      count += 1;
      assert.doesNotMatch(
        value,
        /verbatim|word for word|as the reviewer wrote|as written/i,
        `a --detail/--note value asks for a verbatim quote of prose the run did not compose: "${value}" (${path.basename(file)})`
      );
      for (const [placeholder] of value.matchAll(/<[^>]*>/g)) {
        seen.add(placeholder);
        assert.ok(
          NOTE_PLACEHOLDERS.has(placeholder),
          `${placeholder} appears in a --detail/--note value in ${path.basename(file)} and is not on the list of values the driver composes itself. ` +
            'Either spell it so it says whose words it is, or add it here with the reason it is safe.'
        );
      }
    }
  }
  // The file is the authority, not this list: a spelling that disappears from
  // the prose has to disappear from here too, or the next reader takes the
  // list for a description of a file it no longer matches.
  const unused = [...NOTE_PLACEHOLDERS.keys()].filter((k) => !seen.has(k));
  assert.deepEqual(unused, [], `these placeholders are on the list but no longer appear in any --detail/--note value: ${unused.join(', ')}`);
  // A guard on the scan itself: a regex that quietly stopped matching would
  // make every assertion above vacuous.
  assert.ok(count >= 15, `only ${count} --detail/--note values found — the scan is no longer reaching them`);
});

// #244. The scan above checks the --detail values a file spells out; it cannot see a park instruction that spells out no value at all and
// tells the driver, in prose, to fill one with text a tool wrote — "naming git's message", "with the classifier's message quoted", "that row
// quoted in the detail". Three such sentences survived the body shrink verbatim, each an instruction to put git's error line, the auto-mode
// classifier's `Reason:` or a check's captured output inside a double-quoted argument. So each park site is pinned to its fixed template here,
// and the prose shape that produced them is refused across every file the scan above reads.
test('every park instruction gives fixed --detail words and never quotes tool text', () => {
  const read = (rel) => fs.readFileSync(path.join(SKILLS_ROOT, 'backlog-orchestrate', rel), 'utf8').replace(/\s*\n\s*/g, ' ');
  const RULES = [
    [
      'SKILL.md',
      '--detail "push of the item branch to origin failed — branch and worktree kept, nothing merged"',
      'a failed branch-mode push parks with fixed words, not git\'s message'
    ],
    [
      'references/tracker.md',
      '--detail "push of the item branch to origin failed — branch and worktree kept, nothing merged"',
      'tracker.md restates the branch-mode push park with the same fixed words as the body'
    ],
    [
      'references/tracker.md',
      '--detail "merge landed locally but the auto-mode classifier denied the push to <base> — push it by hand"',
      'a classifier-denied push parks with fixed words, not the classifier\'s message'
    ],
    [
      'references/check-failures.md',
      '--detail "a check could not run: <the failing command names> — fix the command or the environment"',
      'a check that never ran parks naming the command, not quoting its row'
    ],
    // Fix loop 1: the exit-9 row and its tracker.md restatement said "park the item with the server's own sentence in the detail" — the same defect in a
    // phrasing the first guard did not know.
    [
      'SKILL.md',
      '--detail "the API refused this step — <what the API refused, your words>"',
      "an unabsorbed API refusal (exit 9) parks with the driver's summary, not the server's sentence"
    ],
    [
      'references/tracker.md',
      '--detail "the API refused this step — <what the API refused, your words>"',
      'tracker.md restates the exit-9 park with the same fixed words as the body'
    ]
  ];
  for (const [file, needle, rule] of RULES) {
    assert.ok(read(file).includes(needle), `${file} lost the rule: ${rule} (${needle})`);
  }
  const FILES = ['SKILL.md', ...fs.readdirSync(REFERENCES).filter((name) => name.endsWith('.md')).map((name) => `references/${name}`)];
  for (const file of FILES) {
    const text = read(file);
    assert.doesNotMatch(
      text,
      // The last alternative is the general shape — somebody else's text "in the detail" — so a new phrasing of the same instruction is caught by its
      // grammar, not only by the three spellings that already happened.
      /naming git's message|the classifier's message quoted|quoted in the detail|(?:server|git|classifier|tool|check|row)'s (?:own )?[a-z]+ in the detail/i,
      `${file} tells the driver to put tool text into a park detail — give fixed --detail words instead`
    );
  }
});

test('the classifier denial records the run fact, not the classifier prose', () => {
  // Both denial sites — §2's pre-flight probe and §9's real merge — and the
  // note has to name which one asked, because that IS the answer
  // `mergeModeNote` exists to give.
  const flat = skillText().replace(/\s*\n\s*/g, ' ');
  const notes = [...flat.matchAll(/merge-mode branch --note "([^"]*)"/g)].map((m) => m[1]);
  assert.equal(notes.length, 2, `expected exactly 2 \`merge-mode branch --note\` sites, found ${notes.length}`);
  assert.deepEqual(notes.sort(), ['auto mode classifier denied the merge of <id>', 'auto mode classifier denied the merge probe']);
});

// --- task-17: the pause gates, finish paused, unpause ----------------------
// The whole feature's load-bearing half lives in this tool rather than in
// SKILL.md, for the same reason the branch-mode `merged` refusal does: a run
// re-reads its own prose on every one of several hundred turns and prose
// drifts across them, while a non-zero exit code does not. These cases are
// what pin that refusal to the two stages that actually START work on an
// item — and, just as importantly, pin that it never fires on a re-stamp of
// a stage the item is already at, which would strand a run that had already
// spawned a child.

// A pause request that satisfies the predicate against the run just created:
// this run's own id, stamped now (necessarily after `startedAt`).
function effectiveControl(home, project, over = {}) {
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  writeControl(home, project, { runId: run.runId, requestedAt: new Date().toISOString(), ...over });
  return run;
}

test('an effective pause request refuses stage <id> preflight with exit 6, writing nothing', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  effectiveControl(home, project);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'stage', 'task-5', 'preflight');

  assert.equal(out.status, 6, out.stderr);
  // The stderr has to carry the reaction, not just the refusal: a run reading
  // this is mid-loop and its next move is a DIFFERENT finish, not a retry.
  assert.match(out.stderr, /finish --status paused/);
  assert.match(out.stderr, /task-5/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json was modified by a refused stage');
});

test('an effective pause request refuses stage <id> dispatched with exit 6, writing nothing', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0);
  effectiveControl(home, project);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b');

  assert.equal(out.status, 6, out.stderr);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json was modified by a refused stage');
});

// The transition rule, and the reason the gate reads the item's CURRENT
// stage at all: once a child session exists, its session id has to be
// recordable. Refusing this call would leave a live `claude -p` process the
// run file has no id for — strictly worse than letting the item finish.
test('a re-stamp of an already-dispatched item is not a transition and still succeeds under a pause request', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  effectiveControl(home, project);

  const out = run(project, home, 'stage', 'task-5', 'dispatched', '--session', 's1');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.queue.find((q) => q.id === 'task-5').sessionId, 's1');
});

// Every stage past `dispatched` is an item already in flight: pausing must
// never strand it half-worked, so the gate is exactly two stages wide.
test('a pause request never blocks a stage past dispatched', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  effectiveControl(home, project);

  assert.equal(run(project, home, 'stage', 'task-5', 'inspecting').status, 0);
});

test('a pause request pinned to another runId is not effective', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  effectiveControl(home, project, { runId: 'run-19990101-000000' });

  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0);
});

// A request older than the run it names belongs to a PREVIOUS run under the
// same runId-less reading — the timestamp is what makes "this run" mean this
// start of it.
test('a pause request dated before startedAt is not effective', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const runFileBody = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  writeControl(home, project, {
    runId: runFileBody.runId,
    requestedAt: new Date(Date.parse(runFileBody.startedAt) - 3600_000).toISOString()
  });

  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0);
});

// `unpausedAt` is the later of the two clocks the predicate compares: a
// resumed run must not immediately re-pause itself on the very file that
// paused it, and must still honour a request made AFTER the resume.
test('unpausedAt, not startedAt, is what a pause request must post-date once a run has resumed', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const file = runFile(home, project);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const unpausedAt = new Date(Date.parse(body.startedAt) + 60_000).toISOString();
  body.unpausedAt = unpausedAt;
  fs.writeFileSync(file, JSON.stringify(body, null, 2));

  writeControl(home, project, { runId: body.runId, requestedAt: new Date(Date.parse(unpausedAt) - 1000).toISOString() });
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0, 'a request older than the resume still paused the run');

  // Back to `pending`: that first probe SUCCEEDED, so the item now sits at
  // `preflight` and the second call would not be a transition — the gate
  // would answer 0 for the wrong reason and this case would prove nothing.
  assert.equal(run(project, home, 'stage', 'task-5', 'pending').status, 0);
  writeControl(home, project, { runId: body.runId, requestedAt: new Date(Date.parse(unpausedAt) + 1000).toISOString() });
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 6, 'a request newer than the resume did not pause the run');
});

// Every unreadable shape reads as "no request". A malformed control file must
// never wedge a run — the file is written by another process entirely, and a
// half-written or hand-edited one is not a reason to stop working.
test('a missing or malformed control file is never an effective pause request', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const runId = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).runId;

  assert.equal(run(project, home, 'stage', 'task-5', 'pending').status, 0, 'no control file at all');

  for (const body of [
    'not json',
    { runId },
    { runId, requestedAt: 'yesterday' },
    { requestedAt: new Date().toISOString() },
    { runId: 7, requestedAt: new Date().toISOString() }
  ]) {
    writeControl(home, project, body);
    const out = run(project, home, 'stage', 'task-5', 'preflight');
    assert.equal(out.status, 0, `${JSON.stringify(body)} was treated as an effective request: ${out.stderr}`);
    // Put the item back so the next iteration is a transition again.
    assert.equal(run(project, home, 'stage', 'task-5', 'pending').status, 0);
  }
});

test('finish --status paused sets the status and leaves the run archivable by a later init', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));

  const out = run(project, home, 'finish', '--status', 'paused');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), JSON.stringify({ status: 'paused' }));
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'paused');
  assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt), 'updatedAt did not strictly advance');

  // `init` refuses only a `running` file, so a paused one archives like a
  // done one — a person who gives up on resuming can still start fresh.
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(fs.readdirSync(runsDir(home, project)).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'running');
});

test('unpause returns a paused run to running and stamps unpausedAt', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'paused').status, 0);

  const out = run(project, home, 'unpause');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'running');
  // One clock reading, not two: the stamp that retires the pause request and
  // the heartbeat have to be the same instant, or a request landing between
  // them would be judged against the wrong one.
  assert.equal(after.unpausedAt, after.updatedAt);
  // bug-19 review round 1: `unpause` also takes the driver lease, in that same
  // single write and off that same clock reading — a paused run's lease belongs
  // to the session that paused it and exited, so a resume session that left it
  // in place would be refused by its own next `claim`.
  assert.equal(after.driver.at, after.unpausedAt);
  assert.deepEqual(JSON.parse(out.stdout), {
    status: 'running',
    unpausedAt: after.unpausedAt,
    driver: after.driver
  });
});

// #246: the other branch of the same write, pinned on purpose. A hand-run
// terminal has no session to lease to, so `unpause` leaves `driver: null` —
// and must still resume the run and stamp `unpausedAt`, since that terminal is
// exactly who recovers a paused run when no board is up.
test('unpause from a hand-run terminal resumes the run and leaves driver null', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs(null, project, home, 'init', '--project', project).status, 0);
  assert.equal(runAs(null, project, home, 'finish', '--status', 'paused').status, 0);

  const out = runAs(null, project, home, 'unpause');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'running');
  assert.equal(after.unpausedAt, after.updatedAt);
  assert.equal(after.driver, null);
  assert.deepEqual(JSON.parse(out.stdout), { status: 'running', unpausedAt: after.unpausedAt, driver: null });
});

test('unpause refuses any status but paused, writing nothing', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');

  for (const status of ['running', 'done', 'aborted', 'failed']) {
    assert.equal(run(project, home, 'init', '--project', project).status, 0);
    if (status !== 'running') assert.equal(run(project, home, 'finish', '--status', status).status, 0);
    const before = fs.readFileSync(runFile(home, project));

    const out = run(project, home, 'unpause');

    assert.equal(out.status, 1, `unpause on a ${status} run: ${out.stderr}`);
    assert.match(out.stderr, new RegExp(status));
    assert.ok(before.equals(fs.readFileSync(runFile(home, project))), `run.json was modified by unpause on a ${status} run`);
    // Leave the file non-running so the next iteration's init can archive it.
    if (status === 'running') assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);
  }
});

test('unpause with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);
  assert.equal(run(project, home, 'unpause').status, 3);
});

// The spec's "the resume retires the request that paused it", end to end:
// without this the first `stage <id> preflight` of a resumed run would read
// the same file and pause the run again, forever.
test('a resumed run is not re-paused by the request that paused it', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  effectiveControl(home, project);
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 6);
  assert.equal(run(project, home, 'finish', '--status', 'paused').status, 0);
  assert.equal(run(project, home, 'unpause').status, 0);

  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0, 'the retired request paused the resumed run again');
});

test('status names an effective pause request, and says nothing when there is none', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  assert.doesNotMatch(run(project, home, 'status').stdout, /pause requested/);

  const runId = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).runId;
  const requestedAt = new Date().toISOString();
  writeControl(home, project, { runId, requestedAt });

  assert.match(run(project, home, 'status').stdout, new RegExp(`pause requested at ${requestedAt}`));
  // `--json` stays a verbatim print of the run file — the request is not part
  // of the run, and a synthetic key here would make this command the second
  // thing claiming to describe run state.
  assert.equal(Object.hasOwn(JSON.parse(run(project, home, 'status', '--json').stdout), 'pauseRequested'), false);
});

test('controlHome and controlFilePath are the paths the server writes', () => {
  const withoutEnv = { ...process.env };
  delete withoutEnv.BM_ORCH_CONTROL_HOME;
  const probe = spawnSync('node', ['-e', `import('${pathToFileURL(SCRIPT).href}').then((m) => console.log(m.controlHome()))`], {
    encoding: 'utf8',
    env: withoutEnv
  });
  assert.equal(probe.stdout.trim(), path.join(os.homedir(), '.backlog-manager', 'settings', 'orchestrator-control'));
  assert.equal(controlHome(), process.env.BM_ORCH_CONTROL_HOME ?? path.join(os.homedir(), '.backlog-manager', 'settings', 'orchestrator-control'));
  assert.equal(controlFilePath('/r', '/a/b'), path.join('/r', '%2Fa%2Fb.json'));
});

test('pauseRequestEffective refuses every malformed shape rather than throwing', () => {
  const run = { runId: 'run-1', startedAt: '2026-09-05T10:00:00Z' };
  assert.equal(pauseRequestEffective(null, run), false);
  assert.equal(pauseRequestEffective(undefined, run), false);
  assert.equal(pauseRequestEffective({ runId: 'run-2', requestedAt: '2026-09-05T11:00:00Z' }, run), false);
  assert.equal(pauseRequestEffective({ runId: 'run-1', requestedAt: '2026-09-05T09:00:00Z' }, run), false);
  assert.equal(pauseRequestEffective({ runId: 'run-1', requestedAt: 'yesterday' }, run), false);
  assert.equal(pauseRequestEffective({ runId: 'run-1' }, run), false);
  assert.equal(pauseRequestEffective({ runId: 'run-1', requestedAt: '2026-09-05T11:00:00Z' }, { runId: 'run-1', startedAt: 'nonsense' }), false);
  assert.equal(pauseRequestEffective({ runId: 'run-1', requestedAt: '2026-09-05T11:00:00Z' }, run), true);
  assert.equal(pauseRequestEffective({ runId: 'run-1', requestedAt: '2026-09-05T11:00:00Z' }, { ...run, unpausedAt: '2026-09-05T12:00:00Z' }), false);
});

// --- bug-19: the driver lease ---------------------------------------------
//
// The layer BOTH resume shapes reach, and therefore the only one that can
// refuse a resume this app never asked for. `--resume` is not a command: it is
// a prose flow in references/recovery.md carried out with the ordinary
// commands, and every one of those is a blind read-modify-write. `init` is the
// only command that takes a lock at all, and a resume never calls it. So two
// drivers each read a copy of run.json, mutate their own and write over each
// other — last-writer-wins across processes, with `writeRunAtomic`'s atomicity
// guaranteeing only that neither ever reads a torn file.
//
// The lease makes the survivor deterministic without any cross-process locking
// primitive: on a crashed run both resumers may claim, the later write wins,
// and the loser's very next write refuses and stops it. That is why
// last-writer-wins is safe for `claim` specifically where it is dangerous for
// `stage` — exactly one claim is visible afterwards, and every subsequent
// write is checked against it.

// `run()` with an explicit session identity, since the lease is keyed on
// CLAUDE_CODE_SESSION_ID. `null` unsets it — the hand-run terminal case, which
// must still work.
function runAs(sessionId, cwd, home, ...args) {
  const env = { ...process.env, BM_ORCH_HOME: home, BM_ORCH_CONTROL_HOME: `${home}-control` };
  if (sessionId === null) delete env.CLAUDE_CODE_SESSION_ID;
  else env.CLAUDE_CODE_SESSION_ID = sessionId;
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd, env });
}

function makeStale(home, project) {
  const file = runFile(home, project);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  body.updatedAt = new Date(Date.now() - RUN_STALE_MS - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return body;
}

test('init stamps the initiating session as the run driver', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');

  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);

  const body = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(body.driver.sessionId, 'sess-a');
  assert.equal(body.driver.at, body.startedAt, 'the driver stamp and the run start are one clock reading');
});

test('claim takes an unclaimed crashed run and heartbeats it in the same write', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  const stale = makeStale(home, project);
  // No driver at all — every run file written before this feature existed.
  const file = runFile(home, project);
  const noDriver = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete noDriver.driver;
  fs.writeFileSync(file, JSON.stringify(noDriver, null, 2));

  const out = runAs('sess-b', project, home, 'claim');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.driver.sessionId, 'sess-b');
  // The heartbeat recovery.md already requires at this point, not a second
  // call: claim IS that heartbeat, and it records who as well.
  assert.ok(Date.parse(after.updatedAt) > Date.parse(stale.updatedAt));
  assert.equal(after.updatedAt, after.driver.at);
});

test('a second claim on a crashed run evicts the first, whose next writes then refuse', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  makeStale(home, project);

  assert.equal(runAs('sess-a', project, home, 'claim').status, 0, 'the original driver may re-claim its own run');
  // That re-claim heartbeated the run, so it reads fresh again — and a fresh
  // run another session leads is exactly what `claim` refuses. Back to crashed,
  // which is the state a resume actually arrives into.
  makeStale(home, project);
  const evicting = runAs('sess-b', project, home, 'claim');
  assert.equal(evicting.status, 0, evicting.stderr);

  const file = runFile(home, project);
  const afterClaim = fs.readFileSync(file, 'utf8');

  for (const args of [['heartbeat'], ['stage', 'task-5', 'preflight'], ['finish', '--status', 'done']]) {
    const refused = runAs('sess-a', project, home, ...args);
    assert.notEqual(refused.status, 0, `${args[0]} was not refused for the evicted session`);
    assert.match(refused.stderr, /sess-b/, `${args[0]}'s refusal does not name the session holding the run`);
    // Byte-for-byte: a refused command must write nothing at all, or the
    // loser's own stage-write is the very thing the lease exists to prevent.
    assert.equal(fs.readFileSync(file, 'utf8'), afterClaim, `${args[0]} wrote to the run file it was refused`);
  }

  // And the winner still drives it.
  assert.equal(runAs('sess-b', project, home, 'heartbeat').status, 0);
});

test('claim refuses a fresh run another session is driving, and writes nothing', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const before = fs.readFileSync(file, 'utf8');

  const out = runAs('sess-b', project, home, 'claim');

  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /sess-a/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a run file with no driver key accepts every command exactly as before', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete body.driver;
  fs.writeFileSync(file, JSON.stringify(body, null, 2));

  // Absent means unclaimed, never locked: every run file already on disk when
  // this shipped lacks the key, and a missing field must not strand a run.
  assert.equal(runAs('sess-b', project, home, 'heartbeat').status, 0);
  assert.equal(runAs('sess-b', project, home, 'stage', 'task-5', 'preflight').status, 0);
  assert.equal(runAs('sess-c', project, home, 'attention', 'task-5', '--kind', 'parked', '--detail', 'x').status, 0);
});

test('an unidentified session runs every command and warns that the lease cannot be enforced', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  // A hand-run terminal: no CLAUDE_CODE_SESSION_ID anywhere.
  const init = runAs(null, project, home, 'init', '--project', project);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).driver, null);
  assert.match(init.stderr, /lease/i);

  // And it is not locked out by somebody else's lease either — refusing here
  // would strand the one person recovering a run by hand.
  assert.equal(runAs('sess-a', project, home, 'claim').status, 0);
  const beat = runAs(null, project, home, 'heartbeat');
  assert.equal(beat.status, 0, beat.stderr);
  assert.match(beat.stderr, /lease/i);
});

// --- bug-19 review round 1: the lease must never strand a run --------------

test('abort takes a crashed run over from its dead driver, and init can then start a new run', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  // The shape that was bricked: `init` stamped the lease, that session died,
  // and the run file still names it. A person's `--abort` is a NEW session
  // with a new id, and `--abort` never claims — recovery.md's abort section
  // opens with the bare command.
  assert.equal(runAs('sess-dead', project, home, 'init', '--project', project).status, 0);
  makeStale(home, project);

  const out = runAs('sess-human', project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted');
  assert.equal(after.driver.sessionId, 'sess-human', 'abort did not record the session that ended the run');
  // The second half of the brick: a run stuck at `running` refuses every
  // later `init` with exit 4, so a lease that refuses abort locks the project
  // out of the orchestrator entirely.
  assert.equal(runAs('sess-next', project, home, 'init', '--project', project).status, 0);
});

test('abort still refuses a fresh run another session is actively driving, and writes nothing', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const before = fs.readFileSync(file, 'utf8');

  const out = runAs('sess-b', project, home, 'abort');

  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /sess-a/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused abort wrote to the run file');
});

test('unpause is exempt from the lease, so a fresh session can resume a paused run', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  // A run paused by the session that was driving it, which then exited —
  // task-17's own shape. `run.json` keeps that session's lease.
  assert.equal(runAs('sess-paused', project, home, 'init', '--project', project).status, 0);
  assert.equal(runAs('sess-paused', project, home, 'finish', '--status', 'paused').status, 0);

  // recovery.md's paused branch, in its documented order: unpause first (a run
  // has to be `running` before there is anything to drive), claim second.
  const unpaused = runAs('sess-resume', project, home, 'unpause');
  assert.equal(unpaused.status, 0, unpaused.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'running');

  const claimed = runAs('sess-resume', project, home, 'claim');
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.equal(runAs('sess-resume', project, home, 'stage', 'task-5', 'preflight').status, 0);

  // The exemption is `unpause` alone — every other write by a session that is
  // not the driver still refuses.
  assert.equal(runAs('sess-paused', project, home, 'heartbeat').status, 7);
});

// --- bug-39: the STOP request -------------------------------------------
// A stop is a second `kind` of control-file request, and the three readers
// below are three genuinely different refusals: `stage` refuses every
// transition, `watch` kills the child it holds the pid of, and `abort` takes
// the lease from a driver the run file still believes in. The pause cases
// further up this file are the control group for every one of them — a
// `pause` file must go on doing exactly what it did before this key existed.

// The stop counterpart of `effectiveControl` above: same run, same clock,
// `kind: 'stop'`.
function effectiveStop(home, project, over = {}) {
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  writeControl(home, project, { runId: run.runId, requestedAt: new Date().toISOString(), kind: 'stop', ...over });
  return run;
}

test('stopRequestEffective and pauseRequestEffective are disjoint, and an absent kind reads as pause', () => {
  const run = { runId: 'run-1', startedAt: '2026-09-05T10:00:00Z' };
  const at = { requestedAt: '2026-09-05T11:00:00Z' };

  // Absent: every control file written before bug-39, and every one of them
  // meant a pause.
  assert.equal(pauseRequestEffective({ runId: 'run-1', ...at }, run), true);
  assert.equal(stopRequestEffective({ runId: 'run-1', ...at }, run), false);

  // Explicit pause: identical to absent.
  assert.equal(pauseRequestEffective({ runId: 'run-1', ...at, kind: 'pause' }, run), true);
  assert.equal(stopRequestEffective({ runId: 'run-1', ...at, kind: 'pause' }, run), false);

  // A stop is NOT a stronger pause — the pause predicate must answer false,
  // or the run would take the cooperative path for a request whose whole
  // point is that the cooperative path is not reaching it.
  assert.equal(pauseRequestEffective({ runId: 'run-1', ...at, kind: 'stop' }, run), false);
  assert.equal(stopRequestEffective({ runId: 'run-1', ...at, kind: 'stop' }, run), true);

  // An unrecognised kind is not a stop. It reads as the absent case, which is
  // the safe direction: the worst a misread stop can do is stop at the next
  // boundary instead of immediately.
  assert.equal(stopRequestEffective({ runId: 'run-1', ...at, kind: 'halt' }, run), false);
  assert.equal(pauseRequestEffective({ runId: 'run-1', ...at, kind: 'halt' }, run), true);
});

test('a stop is refused by the same two clauses a pause is — wrong runId, or older than the run', () => {
  const run = { runId: 'run-1', startedAt: '2026-09-05T10:00:00Z' };
  const stop = (over) => stopRequestEffective({ runId: 'run-1', requestedAt: '2026-09-05T11:00:00Z', kind: 'stop', ...over }, run);

  assert.equal(stop({}), true);
  assert.equal(stop({ runId: 'run-2' }), false, 'a request naming another run stopped this one');
  assert.equal(stop({ requestedAt: '2026-09-05T09:00:00Z' }), false, 'a request older than the run was effective');
  assert.equal(stop({ requestedAt: 'yesterday' }), false);
  assert.equal(stopRequestEffective(null, run), false);
  assert.equal(stopRequestEffective(undefined, run), false);
  // `unpausedAt` is the later clock for a stop exactly as it is for a pause.
  assert.equal(stopRequestEffective({ runId: 'run-1', requestedAt: '2026-09-05T11:00:00Z', kind: 'stop' }, { ...run, unpausedAt: '2026-09-05T12:00:00Z' }), false);
});

test('a stop refuses EVERY stage transition with exit 10, writing nothing — where a pause refuses only two', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  effectiveStop(home, project);
  const before = fs.readFileSync(runFile(home, project));

  // `merged` is the case the pause gate deliberately lets through: an item
  // already in flight must not be stranded half-worked by a PAUSE. A stop is
  // allowed to abandon it, which is the difference between the two.
  const merged = run(project, home, 'stage', 'task-5', 'merged');
  assert.equal(merged.status, 10, merged.stderr);
  assert.match(merged.stderr, /stop was requested/);
  assert.match(merged.stderr, /--abort/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json was modified by a refused stage');

  // And the two the pause gate does cover.
  assert.equal(run(project, home, 'stage', 'task-5', 'inspecting').status, 10);
  assert.equal(run(project, home, 'stage', 'task-5', 'reviewing').status, 10);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json was modified by a refused stage');
});

test('under a PAUSE, stage still exits 6 at the two gates and 0 everywhere else — bug-39 changed nothing here', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'preflight').status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  effectiveControl(home, project);

  // Past `dispatched`: a pause never blocks an item already in flight.
  assert.equal(run(project, home, 'stage', 'task-5', 'inspecting').status, 0);
  // And the gate itself, on a transition into one of the two stages.
  assert.equal(run(project, home, 'stage', 'task-5', 'pending').status, 0);
  const gated = run(project, home, 'stage', 'task-5', 'preflight');
  assert.equal(gated.status, 6, gated.stderr);
  assert.match(gated.stderr, /finish --status paused/);
});

test('abort takes the lease from a FRESH run another session drives when a stop is on file, and still refuses without one', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const before = fs.readFileSync(file, 'utf8');

  // No stop: today's refusal, unchanged. This is the control group — the
  // lease must not become a suggestion.
  const refused = runAs('sess-b', project, home, 'abort');
  assert.equal(refused.status, 7, refused.stderr);
  assert.match(refused.stderr, /request a stop from the board/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused abort wrote to the run file');

  // With a stop: the run is still `running` and still FRESH — nothing about
  // the file changed — and the abort goes through anyway, because the
  // evidence it acts on is the human act the control file records, not the
  // heartbeat.
  effectiveStop(home, project);
  const out = runAs('sess-b', project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.status, 'aborted');
  assert.equal(after.driver.sessionId, 'sess-b');
  // bug-54: a plain driver lease is still one abort may take, and the lease it takes is an abort's.
  assert.equal(after.driver.aborting, after.driver.at);
});

test('a stop un-strands the hand-run terminal, whose session identity is null', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);

  // `me === null` compares unequal to any driver, so a person typing the
  // command was refused where `assertDriver` — same file, same lease —
  // deliberately warns and proceeds.
  assert.equal(runAs(null, project, home, 'abort').status, 7);

  effectiveStop(home, project);
  const out = runAs(null, project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'aborted');
});

test('claim still exits 7 on a fresh run another session drives, stop on file or not', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);

  assert.equal(runAs('sess-b', project, home, 'claim').status, 7);
  effectiveStop(home, project);
  // The escape hatch is abort's alone. A resume taking a live run over on the
  // strength of a stop would be the resume fighting the stop.
  assert.equal(runAs('sess-b', project, home, 'claim').status, 7);
});

// --- bug-54: an abort marks the lease it takes, and a second abort respects it --
// One board Stop reaches a run twice: the server spawns an `--abort` session (the only thing that ends a run whose driver is dead), and a live driver's
// `watch` returns `10` and runs its own. Before this, nothing reconciled the two — the spawned session read the other abort's teardown in progress as
// evidence about the child's work. The first abort now writes `aborting` on the lease it takes, and a second, identified abort refuses on a fresh mark
// with `7` before it writes anything, or — once the first has finished — reads `aborted` and does nothing at all.

// A `running` run leased to `sessionId`, with one dispatched item whose worktree and branch really exist, so a refused abort can be seen to have run no
// teardown.
function abortFixture(t, sessionId) {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-26', 'Some task');
  commitEverything(project, 'seed');
  assert.equal(runAs(sessionId, project, home, 'init', '--project', project).status, 0);
  const worktree = path.join(project, '.worktrees', 'task-26');
  assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', worktree, '-b', 'backlog/task-26', 'HEAD'], { encoding: 'utf8' }).status, 0);
  const staged = runAs(sessionId, project, home, 'stage', 'task-26', 'dispatched', '--worktree', worktree, '--branch', 'backlog/task-26');
  assert.equal(staged.status, 0, staged.stderr);
  return { home, project, worktree, file: runFile(home, project) };
}

// The lease an abort in progress leaves behind, written by hand so a case can put it on any session with any age.
function markAborting(file, sessionId, at) {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  body.driver = { sessionId, at, aborting: at };
  body.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
}

function branchExists(project, branch) {
  return spawnSync('git', ['-C', project, 'branch', '--list', branch], { encoding: 'utf8' }).stdout.trim() !== '';
}

test('bug-54: abort marks the lease it takes with aborting, and claim never does', (t) => {
  const { home, project, file } = abortFixture(t, 'sess-a');

  const out = runAs('sess-a', project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.driver.sessionId, 'sess-a');
  // One clock reading for both: the mark names the instant the lease was taken.
  assert.equal(after.driver.aborting, after.driver.at);

  // A paused run whose lease still carries a mark: claim writes a lease of its own, and that lease is a driver's, never an abort's.
  const other = orchFixture(t);
  seedReadyTask(other.project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', other.project, other.home, 'init', '--project', other.project).status, 0);
  assert.equal(runAs('sess-a', other.project, other.home, 'finish', '--status', 'paused').status, 0);
  const pausedFile = runFile(other.home, other.project);
  const paused = JSON.parse(fs.readFileSync(pausedFile, 'utf8'));
  paused.driver = { ...paused.driver, aborting: paused.driver.at };
  fs.writeFileSync(pausedFile, JSON.stringify(paused, null, 2));

  const claimed = runAs('sess-b', other.project, other.home, 'claim');

  assert.equal(claimed.status, 0, claimed.stderr);
  const lease = JSON.parse(fs.readFileSync(pausedFile, 'utf8')).driver;
  assert.equal(lease.sessionId, 'sess-b');
  assert.equal('aborting' in lease, false, 'claim wrote an abort mark');
});

test('bug-54: a live abort mark refuses a second identified abort with 7, writing nothing and running no git', (t) => {
  const { home, project, worktree, file } = abortFixture(t, 'sess-a');
  markAborting(file, 'sess-a', new Date().toISOString());
  const before = fs.readFileSync(file, 'utf8');

  const out = runAs('sess-b', project, home, 'abort');

  assert.equal(out.status, 7, out.stderr);
  assert.match(out.stderr, /sess-a/);
  assert.match(out.stderr, /already being aborted/);
  assert.match(out.stderr, /worktree/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused abort wrote to the run file');
  assert.equal(fs.existsSync(worktree), true, 'a refused abort removed the worktree');
  assert.equal(branchExists(project, 'backlog/task-26'), true, 'a refused abort deleted the branch');
});

test('bug-54: a stop on file does not let abort override an ABORT lease — only a driver lease', (t) => {
  const { home, project, worktree, file } = abortFixture(t, 'sess-a');
  markAborting(file, 'sess-a', new Date().toISOString());
  effectiveStop(home, project);
  const before = fs.readFileSync(file, 'utf8');

  const out = runAs('sess-b', project, home, 'abort');

  assert.equal(out.status, 7, out.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused abort wrote to the run file');
  assert.equal(fs.existsSync(worktree), true);
  assert.equal(branchExists(project, 'backlog/task-26'), true);
});

test('bug-54: an abort mark older than RUN_STALE_MS is a dead abort, and the next one takes over', (t) => {
  const { home, project, file } = abortFixture(t, 'sess-a');
  markAborting(file, 'sess-a', new Date(Date.now() - RUN_STALE_MS - 60_000).toISOString());
  effectiveStop(home, project);

  const out = runAs('sess-b', project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.status, 'aborted');
  assert.equal(after.driver.sessionId, 'sess-b');
});

test('bug-54: a hand-run abort is never refused by the abort mark', (t) => {
  const { home, project, file } = abortFixture(t, 'sess-a');
  markAborting(file, 'sess-a', new Date().toISOString());
  effectiveStop(home, project);

  const out = runAs(null, project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /lease/i);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'aborted');
});

test('bug-54: the session whose abort holds the mark can re-run its own abort to the end', (t) => {
  const { home, project, file } = abortFixture(t, 'sess-a');
  markAborting(file, 'sess-a', new Date().toISOString());
  effectiveStop(home, project);

  const out = runAs('sess-a', project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'aborted');
});

test('bug-54: abort on an already-aborted run is a no-op — one line, exit 0, nothing written, no git', (t) => {
  const { home, project, file } = abortFixture(t, 'sess-a');
  assert.equal(runAs('sess-a', project, home, 'abort').status, 0);
  // Re-create the branch the first abort deleted: a second abort that re-ran the teardown would delete it again, so its survival is the proof that no
  // git command ran.
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'backlog/task-26', 'HEAD'], { encoding: 'utf8' }).status, 0);
  const before = fs.readFileSync(file, 'utf8');
  const runId = JSON.parse(before).runId;

  const out = runAs('sess-b', project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim().split('\n').length, 1, out.stdout);
  assert.match(out.stdout, new RegExp(`${runId}.*already aborted`));
  assert.match(out.stdout, /sess-a/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a no-op abort wrote to the run file');
  assert.equal(branchExists(project, 'backlog/task-26'), true, 'a no-op abort ran the teardown');
});

test('bug-54: spawned abort first — the driver then stands down on watch (7) and its own abort is the no-op', (t) => {
  const { home, project, file } = abortFixture(t, 'sess-d');
  effectiveStop(home, project);
  assert.equal(runAs('sess-s', project, home, 'abort').status, 0);
  const before = fs.readFileSync(file, 'utf8');

  const watched = runAs('sess-d', project, home, 'watch', 'task-26', '--pid', '999999', '--jsonl', path.join(home, 'none.jsonl'), '--interval-ms', '10', '--budget-ms', '50');
  assert.equal(watched.status, 7, watched.stderr);
  const aborted = runAs('sess-d', project, home, 'abort');
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.match(aborted.stdout, /already aborted/);

  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the stood-down driver wrote to the run file');
});

test('bug-54: references/stopping.md\'s Stopping and recovery.md\'s --abort both tell an abort refused with 7 to inspect no worktree', () => {
  // The tool refuses the second abort; it cannot refuse a `git status` made before that abort is called, which is the read the observed run made. Only
  // the prose reaches that, so the prose is pinned.
  // RE-POINTED (task 5): `### Stopping` moved to references/stopping.md, where it is the last section, so the slice runs from its heading to the end of the file.
  const skillStopping = fs.readFileSync(path.join(REFERENCES, 'stopping.md'), 'utf8');
  const stopping = skillStopping.slice(skillStopping.indexOf('### Stopping'));
  assert.match(stopping, /exits `7` saying the run is already being aborted/);
  assert.match(stopping, /inspect any worktree/);
  const recovery = fs.readFileSync(path.join(REFERENCES, 'recovery.md'), 'utf8');
  const abortSection = recovery.slice(recovery.indexOf('### `--abort`'));
  assert.match(abortSection, /exits `7` saying the run is already being aborted/);
  assert.match(abortSection, /Inspect no worktree/);
  assert.match(abortSection, /Nothing under `\.worktrees\/` is read before `abort` has returned/);
});

test('bug-54: spawned abort still running — the driver\'s abort and its stage both exit 7, not 10', (t) => {
  const { home, project, worktree, file } = abortFixture(t, 'sess-d');
  effectiveStop(home, project);
  markAborting(file, 'sess-s', new Date().toISOString());
  const before = fs.readFileSync(file, 'utf8');

  const aborted = runAs('sess-d', project, home, 'abort');
  assert.equal(aborted.status, 7, aborted.stderr);
  assert.match(aborted.stderr, /sess-s/);
  // The lease is checked before the stop, so the driver learns it is no longer the driver rather than that a stop is on file.
  const staged = runAs('sess-d', project, home, 'stage', 'task-26', 'reviewing');
  assert.equal(staged.status, 7, staged.stderr);

  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the stood-down driver wrote to the run file');
  assert.equal(fs.existsSync(worktree), true);
  assert.equal(branchExists(project, 'backlog/task-26'), true);
});

test('watch returns 10 and signals the pid it was given, rather than the budget elapsing', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);

  // A process THIS TEST started, never a pattern — the same rule the tool
  // itself follows. `sleep` so it is alive when watch looks and observable
  // afterwards; it is killed in `t.after` whatever this case proves.
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone — that is this case's success path */
    }
  });

  const jsonl = path.join(home, 'watch.jsonl');
  fs.writeFileSync(jsonl, '');
  effectiveStop(home, project);

  const out = run(project, home, 'watch', 'task-5', '--pid', String(child.pid), '--jsonl', jsonl, '--interval-ms', '1000', '--budget-ms', '30000');

  assert.equal(out.status, 10, out.stderr);
  assert.match(out.stderr, /stop was requested/);
  // The child took the signal. `once('exit')` rather than a poll: the process
  // is this test's own, so its exit is observable directly.
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGTERM');
});

// bug-50, the sibling of bug-43's null pid: the stop branch sits deliberately ABOVE the heartbeat write, so the tick that notices a stop does not push
// `updatedAt` forward. A freshly-read session id is not a freshness signal though, and returning with it in a local variable threw away a fact already read off
// disk, with no later tick to re-read it — `stage --session` is the only other writer and the run is over. STREAM_INIT's FIRST line is the init event, so this
// watch's very first tick both discovers the id and sees the stop: exactly the one-tick window no hand-timed abort ever managed to land in.
test('a stop on the tick that first reads the session id persists that id, without bumping updatedAt (bug-50)', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);

  const before = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const queued = (state) => state.queue.find((q) => q.id === 'task-5');
  assert.equal(queued(before).sessionId, null, 'the fixture already carried a session id, so this case would pass without the fix');

  // A process THIS TEST started, never a pattern, and alive so the stop has a real pid to signal.
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone — the SIGTERM the stop sent got there first */
    }
  });

  effectiveStop(home, project);

  const out = run(project, home, 'watch', 'task-5', '--pid', String(child.pid), '--jsonl', STREAM_INIT, '--interval-ms', '1000', '--budget-ms', '30000');
  assert.equal(out.status, 10, out.stderr);

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(queued(after).sessionId, 'a1b2c3d4-5e6f-4a1b-8c2d-9f0e1a2b3c4d', 'the discovered session id was dropped with the stack frame');
  // The property the early return exists to protect, and the whole reason this rescue is its own write: `takeOverRun` reads this freshness to decide whether
  // an abort from elsewhere is refused, so the write must leave `updatedAt` exactly where the stop found it.
  assert.equal(after.updatedAt, before.updatedAt, 'the stop tick pushed updatedAt forward');
  // Nothing else moved — a stop is not a transition, and the item is still the dispatched one `--abort` will finalise.
  assert.equal(queued(after).stage, 'dispatched');
});

test('stage <id> dispatched --pid records the pid, and a later stage without the flag leaves it alone', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const queued = () => JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-5');

  // Null until a dispatch records one — `init` writes the key, so an older
  // run file's absent one is the only other shape a reader ever sees.
  assert.equal(queued().pid, null);

  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b', '--pid', '4242').status, 0);
  assert.equal(queued().pid, 4242);

  // Every later stage re-stages the item without the flag, and clearing the
  // pid there would take the child's address away from an abort at exactly
  // the point the child is most likely to still be running.
  assert.equal(run(project, home, 'stage', 'task-5', 'inspecting').status, 0);
  assert.equal(queued().pid, 4242);

  // A malformed pid is refused rather than dropped: the one thing worse than
  // no recorded pid is a wrong one.
  const bad = run(project, home, 'stage', 'task-5', 'reviewing', '--pid', 'nope');
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /--pid must be a positive integer/);
  assert.equal(queued().stage, 'inspecting', 'a refused stage was written anyway');
});

/**
 * A live process whose `ps -o args=` line names `claude` — a shell script of
 * that name, spawned by this test and killed by it. It stands in for the
 * dispatched session because the guard under test reads the COMMAND LINE,
 * which is the only thing distinguishing "the child this run started" from
 * "whatever now owns a recycled pid". Nothing here is found by pattern: the
 * pid is the one `spawn` returned.
 */
function spawnFakeClaude(t, home) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, 'claude');
  fs.writeFileSync(script, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(script, 0o755);
  const child = spawn(script, [], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone — that is the success path of the case that kills it */
    }
  });
  return child;
}

test('abort signals a live recorded pid whose process is a claude session', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const child = spawnFakeClaude(t, home);

  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b', '--pid', String(child.pid)).status, 0);

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /signalled 1 live session\(s\)/);
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGTERM');
});

test('abort refuses to signal a live pid whose process is NOT a claude session — the pid-reuse guard', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  // A pid the OS handed to something else between the dispatch and this
  // abort. Signalling it would end somebody's unrelated work, which is the
  // one outcome this guard exists to make impossible — so the refusal, not
  // the kill, is what this case asserts.
  const stranger = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    try {
      stranger.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  });
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b', '--pid', String(stranger.pid)).status, 0);

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /signalled 0 live session\(s\)/);
  assert.equal(stranger.killed, false);
});

test('abort leaves a TERMINAL item\'s recorded pid alone, however alive that pid now is', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const child = spawnFakeClaude(t, home);

  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b', '--pid', String(child.pid)).status, 0);
  // `merged` — the item is finished with, so its child exited long ago and
  // the recorded number has had every chance to be handed to something else.
  assert.equal(run(project, home, 'stage', 'task-5', 'merged').status, 0);

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /signalled 0 live session\(s\)/);
  assert.equal(child.killed, false);
});


// --- bug-43: abort's SECOND pid source, `<dir>/logs/<id>.pid` -------------
// The window bug-39 left open: a stop landing after the first `stage <id>
// dispatched` and before the `--pid` call completes leaves `RunQueueItem.pid`
// null while a `claude -p` child is running, because the stop gate refuses
// every call — and `cmdAbort` had exactly one pid source, the run file. The
// number was never lost: SKILL.md's launcher writes it to `<dir>/logs/<id>.
// pid` in the same Bash invocation that backgrounds the child, before the
// refusable call. These cases pin that abort now reads that file, prefers it,
// and subjects it to the same three guards a recorded pid gets.

// The pid file SKILL.md's dispatch line writes, at the name the tool now
// reads. Written through `seedSidecar` so the path is composed exactly the
// way every other sidecar in this suite is, rather than by a second copy of
// the `<dir>/logs/` convention.
function seedPidFile(home, project, itemId, body) {
  return seedSidecar(home, project, `logs/${itemId}.pid`, body);
}

test('abort signals a pid that reached only the log file, never the run file', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const child = spawnFakeClaude(t, home);

  // The FIRST of SKILL.md's two dispatch calls, and the only one that
  // survived the window: no `--pid` anywhere, so the run file's copy is null.
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  seedPidFile(home, project, 'task-5', `${child.pid}\n`);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].pid, null, 'the run file was supposed to have no pid');

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /signalled 1 live session\(s\)/);
  assert.match(out.stdout, new RegExp(`task-5 \\(pid ${child.pid}\\)`));
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGTERM');
});

test('the whole of bug-43: the stop gate refuses the --pid call and abort reaches the child anyway', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const child = spawnFakeClaude(t, home);

  // Exactly the observed sequence: first call, then the stop lands, then the
  // `--pid` call. The gate and the fallback have to be proved to COMPOSE —
  // either half alone is green on the shipped code for the wrong reason.
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  seedPidFile(home, project, 'task-5', String(child.pid));
  effectiveStop(home, project);

  const refused = run(project, home, 'stage', 'task-5', 'dispatched', '--pid', String(child.pid));
  assert.equal(refused.status, 10, refused.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].pid, null, 'a refused stage wrote the pid anyway');

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /signalled 1 live session\(s\)/);
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGTERM');
});

test('the log file wins over a stale recorded pid, and the run file records what was signalled', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  // A: the child the run file knows about, recorded through `--pid` and then
  // dead — the shape a relaunch leaves behind when the `stage --pid` after it
  // was refused. B: the live child the relaunch actually started, whose
  // number is in the file the launcher rewrote.
  const a = spawnFakeClaude(t, home);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b', '--pid', String(a.pid)).status, 0);
  a.kill('SIGKILL');
  await once(a, 'exit');

  const b = spawnFakeClaude(t, home);
  seedPidFile(home, project, 'task-5', String(b.pid));

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`task-5 \\(pid ${b.pid}\\)`));
  const [, signal] = await once(b, 'exit');
  assert.equal(signal, 'SIGTERM');
  assert.equal(
    JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].pid,
    b.pid,
    'the journal of record still names the pid that was not signalled'
  );
});

test("abort leaves a TERMINAL item's log-file pid alone, however alive it is", (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const child = spawnFakeClaude(t, home);

  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'merged').status, 0);
  seedPidFile(home, project, 'task-5', String(child.pid));

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /signalled 0 live session\(s\)/);
  assert.equal(child.killed, false);
});

test('the pid-reuse guard still binds a pid that came out of the log file', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  // A live process the OS handed this number to after the child exited. A
  // file-sourced pid gets the `ps -o args=` guard for exactly the reason a
  // recorded one does — the file is no fresher than the last relaunch.
  const stranger = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    try {
      stranger.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  });
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  seedPidFile(home, project, 'task-5', String(stranger.pid));

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /signalled 0 live session\(s\)/);
  assert.equal(stranger.killed, false);
});

test('unreadable contents in the pid file are no answer, never an error', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');

  // Every shape a half-written, hand-cleared or truncated file can take. None
  // is a throw: the posture the rest of abort takes toward sidecar evidence.
  for (const body of ['nope', '', '   \n', '0', '-1', '12.5']) {
    assert.equal(run(project, home, 'init', '--project', project).status, 0, `init failed for ${JSON.stringify(body)}`);
    assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
    seedPidFile(home, project, 'task-5', body);

    const out = run(project, home, 'abort');
    assert.equal(out.status, 0, `${JSON.stringify(body)}: ${out.stderr}`);
    assert.match(out.stdout, /signalled 0 live session\(s\)/, `${JSON.stringify(body)} was treated as a pid`);
  }
});

test('a recorded pid is still signalled when the log file holds garbage — the fallback', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const child = spawnFakeClaude(t, home);

  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b', '--pid', String(child.pid)).status, 0);
  seedPidFile(home, project, 'task-5', 'nope');

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`task-5 \\(pid ${child.pid}\\)`));
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGTERM');
});

test('SKILL.md still writes the pid to the file abort reads, on every launch line', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  // A prose edit that renamed this file would blind `abort` silently — no
  // behavioural test in this suite reads SKILL.md's launcher, and the tool
  // now depends on the name. Three occurrences: §4's dispatch, §5's retry and
  // §7's fresh fixer, the same three `dispatchNames()` asserts for `exec claude -p`.
  // `logs/` only: §8's `verify/<id>.pid` is a DIFFERENT file holding a
  // deliberately different thing (the wrapper `sh`, not a `claude` process),
  // and abort's `ps` guard refuses it by construction — see the item's own
  // non-goals.
  const lines = text.split('\n').filter((l) => l.trim().startsWith('echo $!') && l.includes('logs/'));
  assert.equal(lines.length, 3, `expected three \`echo $! > .../logs/<id>.pid\` lines, found ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /echo \$! > "<dir>\/logs\/<id>\.pid"/, `launcher does not write the pid file abort reads: ${line}`);
  }
});

// --- bug-52: abort's session-id source, `<dir>/logs/<id>.jsonl` -----------
// The same hole bug-43 closed for the pid, one sidecar over. A stop that lands inside the dispatch block refuses the second `stage --pid` with `10`, so `watch`
// never runs, and `watch` was the only reader of the child's init event — `abort` finalised the run with `sessionId: null` while the id sat in the log the
// launcher had already written. These cases pin that abort now reads that file, never overwrites a recorded id with it, and treats every bad shape as no
// answer rather than an error.

// The child's stream-json log, at the name SKILL.md's launcher redirects stdout to. Through `seedSidecar` for the reason `seedPidFile` is.
function seedDispatchLog(home, project, itemId, body) {
  return seedSidecar(home, project, `logs/${itemId}.jsonl`, body);
}

// The shape observed on run-20260922-144041: a few `system` lines, the init event among them, each newline-terminated because the child had closed the file.
function initLog(sessionId) {
  return (
    [
      { type: 'system', subtype: 'hook_started' },
      { type: 'system', subtype: 'init', session_id: sessionId },
      { type: 'assistant', message: { content: [] } }
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n'
  );
}

test('abort harvests the session id a dispatched child wrote only to its log (bug-52)', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
  seedDispatchLog(home, project, 'task-5', initLog('6924d9fa-4f8b-4d9e-b644-2b36b55efa54'));
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].sessionId, null, 'the run file was supposed to have no session id');

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted');
  assert.equal(after.queue[0].sessionId, '6924d9fa-4f8b-4d9e-b644-2b36b55efa54', 'the id on disk was left unread');
});

test('a missing, empty or init-less log leaves sessionId null and abort still ends the run (bug-52)', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');

  // `null` is "no file at all"; the rest are every shape a log a child died early in can take, including a directory where the file should be (a read that
  // throws, not one that returns nothing) and an init line with no trailing newline, which `findSessionIdInJsonl` reads as a partial write and skips.
  for (const body of [null, 'dir', '', 'not json\n', `${JSON.stringify({ type: 'system', subtype: 'hook_started' })}\n`, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'partial' })]) {
    const label = JSON.stringify(body);
    assert.equal(run(project, home, 'init', '--project', project).status, 0, `init failed for ${label}`);
    assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b').status, 0);
    if (body === 'dir') fs.mkdirSync(path.join(projStateDir(home, project), 'logs', 'task-5.jsonl'), { recursive: true });
    else if (body !== null) seedDispatchLog(home, project, 'task-5', body);

    const out = run(project, home, 'abort');
    assert.equal(out.status, 0, `${label}: ${out.stderr}`);
    const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
    assert.equal(after.status, 'aborted', label);
    assert.equal(after.queue[0].sessionId, null, `${label} produced a session id`);
  }
});

test('a session id the run file already carries is not overwritten by the log (bug-52)', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w', '--branch', 'b', '--session', 'recorded-by-watch').status, 0);
  seedDispatchLog(home, project, 'task-5', initLog('a-different-id'));

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].sessionId, 'recorded-by-watch');
});

test('SKILL.md still sends the dispatched child\'s stdout to the log abort reads (bug-52)', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  // The session-id twin of the pid-file seam test above. ONE line, not two: §5's retry redirects to `<id>-retry-<n>.jsonl`, and a retry's id reaches the run
  // file through that retry's own `watch`, so abort reads only the first dispatch's log.
  const lines = text.split('\n').filter((l) => l.includes('exec claude -p') && l.includes('> "<dir>/logs/<id>.jsonl"'));
  assert.equal(lines.length, 1, `expected one launch line redirecting to "<dir>/logs/<id>.jsonl", found ${lines.length}`);
});

test("aborting a later item harvests its id and leaves an earlier item's recorded id alone (bug-52)", (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'First task');
  seedReadyTask(project, 'task-6', 'Second task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  // task-5 ran its whole course and `watch` recorded its id; task-6 is the item the stop landed in. task-5's log is seeded with a DIFFERENT id so a harvest
  // that ran over every item regardless of what it already held would show up here, not only a harvest that skipped task-6.
  assert.equal(run(project, home, 'stage', 'task-5', 'dispatched', '--worktree', '/w5', '--branch', 'b5', '--session', 'early-session').status, 0);
  assert.equal(run(project, home, 'stage', 'task-5', 'merged').status, 0);
  seedDispatchLog(home, project, 'task-5', initLog('not-the-early-session'));
  assert.equal(run(project, home, 'stage', 'task-6', 'dispatched', '--worktree', '/w6', '--branch', 'b6').status, 0);
  seedDispatchLog(home, project, 'task-6', initLog('late-session'));

  const out = run(project, home, 'abort');
  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const byId = (id) => after.queue.find((q) => q.id === id);
  assert.equal(byId('task-5').sessionId, 'early-session', "the earlier item's id did not survive");
  assert.equal(byId('task-6').sessionId, 'late-session', "the stopped item's id was left in its log");
});


// --- bug-28: the per-item execute session is named ------------------------
// Every other session this system spawns carries a `-n` display name
// (`orchestrate <project>`, `bl <project> <id>`, `resume <project>`,
// `watchdog resume <project>` — all composed server-side and sent to the
// dashboard's POST /api/spawn). The per-item execute session is the one that
// never goes through that route: the running orchestrator spawns it itself
// from the line written into SKILL.md, and that line passed no `-n` at all, so
// its dashboard row read as a bare project name — indistinguishable from a
// session someone started in a terminal, for the one session actually doing
// the work.
//
// Pinned as a text assertion because the fix IS prose: there is no function to
// unit-test. Measured end-to-end before it was written, on CLI 2.1.250:
// `claude -p … -n "orch bug-28"` appends a `{"type":"custom-title",
// "customTitle":"orch bug-28"}` record to the transcript, which is exactly the
// record the dashboard reads (`titleFromRecord`, title-cache.ts). Repeating it
// with `--resume <id> -n "orch bug-28 retry 1"` exits 0 and appends a second
// such record to the SAME file — and the dashboard's own reader scans
// newest-first, so the row renames to the retry rather than gaining a second
// entry. That is why both lines carry the flag and why the retry name is
// allowed to differ from the dispatch one.
//
// NAME_RE and NAME_CAP are COPIES of the dashboard's own
// (../claude-agents-dashboard/server/lib/spawn.ts), for the reason
// test/agents-prompt.test.ts states for its copy: importing from a sibling
// repo would make this suite depend on a checkout of another one. They are
// checked here even though this spawn path never touches the dashboard's
// validator — the CLI accepts any string — because the three server-side
// helpers all concluded the same charset, and a name that agrees with them is
// one that keeps working if this line ever does grow a server hop.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const NAME_CAP = 60;

/** The `-n "…"` argument of every headless dispatch line, in file order. */
function dispatchNames() {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const lines = text.split('\n').filter((l) => l.includes('exec claude -p'));
  assert.equal(lines.length, 3, `expected exactly 3 headless dispatch lines, found ${lines.length}`);
  return lines.map((line) => {
    const m = /-n "([^"]*)"/.exec(line);
    assert.ok(m, `dispatch line passes no -n "<name>": ${line}`);
    return { line, name: m[1] };
  });
}

test('every dispatch line names the session it spawns', () => {
  for (const { line, name } of dispatchNames()) {
    // Double-quoted, and inside the single-quoted sh -c body: the name holds a
    // space, so an unquoted one would split into `-n orch` plus a stray word
    // the CLI would read as another argument, and a flag outside the body
    // would be handed to `nohup` instead of to `claude`. Same failure shape
    // BM_ORCH_RUN's own placement test guards, for the same reason.
    const body = line.slice(line.indexOf("sh -c '") + "sh -c '".length, line.lastIndexOf("'"));
    assert.ok(body.includes(`-n "${name}"`), `-n is outside the single-quoted dispatch body: ${line}`);
  }
});

test('the three names are the documented spellings, and none carries the run id', () => {
  const [dispatch, retry, fix] = dispatchNames();
  // Exact spellings rather than a pattern: this is where bug-28's one open
  // judgement is recorded. The run id is deliberately absent — the worktree
  // already gives the row its own project (`…--worktrees-<id>`), `run.json`
  // maps session id to run for anything machine-side, `BM_ORCH_RUN` carries it
  // in the environment for the hook, and a `run-20260906-151336` in the name
  // would eat a third of the cap to repeat what a reader is not looking for.
  // The id is what a reader IS looking for, so the id is what the name says.
  assert.equal(dispatch.name, 'orch <id>');
  // `retry 1` and not `retry <n>`: the log file this same block writes is
  // `<id>-retry-1.jsonl`, so one counter is substituted into both and a reader
  // comparing the row to the transcript sees the same number. `<n>` is also
  // already spent on the dispatch prompt's `item <n> of <m>`, and two meanings
  // for one placeholder on adjacent lines is how a substitution goes wrong.
  assert.equal(retry.name, 'orch <id> retry 1');
  // §7's fresh fixer (#226) keeps the name the resumed fix loop always had,
  // so a row reads the same whichever mode `fix-mode` picked.
  assert.equal(fix.name, 'orch <id> fix <n>');
});

test('every composed name satisfies the dashboard charset and cap', () => {
  // Rendered, not asserted as templates: `<id>` and `<n>` are placeholders the
  // run substitutes, and `<`/`>` are outside NAME_RE — so the raw line can
  // never be tested against the regex directly, and a test that did would
  // either be red forever or quietly weakened until it passed.
  for (const { name } of dispatchNames()) {
    const rendered = name.replace('<id>', 'bug-28').replace('<n>', '2');
    assert.match(rendered, NAME_RE, `composed name is outside the dashboard charset: ${rendered}`);
    assert.ok(rendered.length <= NAME_CAP, `composed name is over the ${NAME_CAP}-char cap: ${rendered}`);
  }
});

test('a pathologically long id still composes a name under the cap', () => {
  // The cap matters because going over it is SILENT on the server-side route
  // (parseSpawnRequest drops the name and the row falls back to the project),
  // and nothing here can slice: the name is composed by substitution into
  // prose, so headroom is the only mechanism available. 40 characters is far
  // past anything backlog.mjs mints (`^[a-z]+-\d+$`); leaving the project and
  // the run id out of the name is what buys the room.
  const id = 'x'.repeat(40);
  for (const { name } of dispatchNames()) {
    const rendered = name.replace('<id>', id).replace('<n>', '2');
    assert.ok(rendered.length <= NAME_CAP, `a ${id.length}-char id overflows the cap: ${rendered.length} chars`);
  }
});

test('the retry name differs from the dispatch name for the same item', () => {
  // `-n` on a `--resume` renames the existing row rather than adding one
  // (measured; see this section's head), so the two names are not independent:
  // the retry must stay recognisable as the same item — same `orch <id>`
  // prefix — while still reading as the retry it now is, or the row silently
  // claims the first dispatch is still the thing running.
  const [dispatch, retry] = dispatchNames();
  assert.notEqual(retry.name, dispatch.name);
  assert.ok(retry.name.startsWith(dispatch.name), `retry name no longer extends the dispatch name: ${retry.name}`);
});

// --- task-27: `usage`, the one writer of RunQueueItem.usage ---------------
//
// Every dispatched session's own `result` event already carries what the run
// cost; nothing copied it anywhere, so "what did this run cost" meant parsing
// 43MB of transcripts with a purpose-written script. These tests pin the copy.

const STREAM_USAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage.jsonl');
const STREAM_USAGE_FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-fix.jsonl');
const STREAM_MALFORMED_THEN_USAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-malformed-then-usage.jsonl');
const STREAM_USAGE_TWO_MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-two-models.jsonl');

// The command reads which dispatch a transcript belongs to out of its FILE
// NAME, so every test here needs the fixture sitting under a name the real
// logs directory would have produced. Copied into a throwaway directory per
// call rather than renamed in place — the fixtures are shared and read-only.
function transcriptAs(t, fixture, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-usage-'));
  const file = path.join(dir, name);
  fs.copyFileSync(fixture, file);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function usageRun(t, id = 'task-5', title = 'Some task') {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, id, title);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  return { home, project };
}

function queueItem(home, project, id) {
  return JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === id);
}

test('usage copies the result event onto the queue item and echoes the entry', (t) => {
  const { home, project } = usageRun(t);
  const file = transcriptAs(t, STREAM_USAGE, 'task-5.jsonl');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  const entries = queueItem(home, project, 'task-5').usage;
  assert.equal(entries.length, 1);
  const [entry] = entries;
  // The exact key set, not a spot-check: this shape is written into an
  // archive read months later, and a field silently dropped by a future edit
  // is invisible in every other assertion here. `loop` is the thirteenth
  // field and is deliberately ABSENT on an `execute` entry — there is no loop
  // to count — which is why this list has twelve names; the fix-loop test
  // below is where the thirteenth appears.
  assert.deepEqual(Object.keys(entry).sort(), [
    'cacheCreationTokens',
    'cacheReadTokens',
    'costUsd',
    'durationMs',
    'endedAt',
    'inputTokens',
    'kind',
    'model',
    'outputTokens',
    'peakContextTokens',
    'sessionId',
    'turns'
  ]);
  assert.equal(entry.kind, 'execute');
  assert.equal(entry.sessionId, '7c3d9a10-2b48-4e6f-9a01-5d8e3f2c7b64');
  assert.equal(entry.costUsd, 2.641441);
  assert.equal(entry.turns, 34);
  assert.equal(entry.inputTokens, 208);
  assert.equal(entry.outputTokens, 52893);
  assert.equal(entry.cacheReadTokens, 15_155_855);
  assert.equal(entry.cacheCreationTokens, 204_362);
  assert.equal(entry.durationMs, 812_345);
  assert.equal(entry.model, 'claude-opus-5[1m]');
  assert.ok(Date.parse(entry.endedAt) > 0, 'endedAt is a parseable stamp');
  // The echo is what SKILL.md §5 reads back on the same Bash invocation.
  assert.deepEqual(JSON.parse(out.stdout), { id: 'task-5', usage: entry });
});

// The case the plan's own "idempotent by sessionId" rule would have got
// wrong: `claude -p --resume` keeps the session id it was handed, so a fix
// loop's transcript reports the SAME session as the first dispatch (verified
// against this machine's task-22/task-22-fix-1 pair). Keying on the session
// would have made this second call overwrite the first entry instead of
// sitting beside it — identity is the transcript slot, `kind` + `loop`.
test('a fix loop adds a second entry beside the first, same session id and all', (t) => {
  const { home, project } = usageRun(t);
  assert.equal(run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE, 'task-5.jsonl')).status, 0);
  const first = queueItem(home, project, 'task-5').usage[0];

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE_FIX, 'task-5-fix-1.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  const entries = queueItem(home, project, 'task-5').usage;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], first, 'the execute entry was rewritten by the fix loop');
  assert.equal(entries[1].kind, 'fix');
  assert.equal(entries[1].loop, 1);
  assert.equal(entries[1].costUsd, 1.612241);
  assert.equal(entries[1].sessionId, entries[0].sessionId, 'the fixture pins the real shape: a resumed session keeps its id');
});

test('a retry transcript records its own kind and loop number', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE_FIX, 'task-5-retry-2.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  const [entry] = queueItem(home, project, 'task-5').usage;
  assert.equal(entry.kind, 'retry');
  assert.equal(entry.loop, 2);
});

// recovery.md tells a resumed driver to re-run this for any transcript whose
// entry is absent, and "absent" is a judgement it makes from a run file it
// did not write. Running it over one already recorded has to be harmless.
test('the same transcript twice leaves exactly one entry for that slot', (t) => {
  const { home, project } = usageRun(t);
  const file = transcriptAs(t, STREAM_USAGE, 'task-5.jsonl');
  assert.equal(run(project, home, 'usage', 'task-5', '--jsonl', file).status, 0);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  const entries = queueItem(home, project, 'task-5').usage;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].costUsd, 2.641441);
});

// A killed session. An absent entry is the honest record; a zero-valued one
// would claim the session was free, which is the reading a cost rollup would
// then print as fact.
test('a transcript with no result event writes nothing, says so, and exits 0', (t) => {
  const { home, project } = usageRun(t);
  const file = transcriptAs(t, STREAM_NO_RESULT, 'task-5.jsonl');
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /task-5\.jsonl/);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
  assert.equal(queueItem(home, project, 'task-5').usage, undefined);
});

test('usage on an unreadable transcript exits 1 and writes nothing', (t) => {
  const { home, project } = usageRun(t);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', path.join(project, 'task-5.jsonl'));

  assert.equal(out.status, 1);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

test('a line that is not JSON at all, ahead of the result event, is skipped rather than fatal', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_MALFORMED_THEN_USAGE, 'task-5.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  assert.equal(queueItem(home, project, 'task-5').usage[0].costUsd, 2.641441);
});

test('two models in one session join into one label, and the init event supplies a missing session id', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE_TWO_MODELS, 'task-5.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  const [entry] = queueItem(home, project, 'task-5').usage;
  assert.equal(entry.model, 'claude-opus-5[1m], claude-haiku-4-5-20251001');
  assert.equal(entry.sessionId, '7c3d9a10-2b48-4e6f-9a01-5d8e3f2c7b64');
});

// The realistic way to name a file wrong is to hand this command ANOTHER
// item's transcript, which a silent default to `execute` would file against
// this item forever.
test('a transcript whose name matches none of the three shapes exits 1 and names the shapes', (t) => {
  const { home, project } = usageRun(t);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE, 'task-6.jsonl'));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /task-5-fix-<n>\.jsonl/);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

test('usage with no --jsonl exits 1 and prints the usage line', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /usage: orchestrate\.mjs usage/);
});

test("usage for an id that is not in this run's queue exits 1", (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'nope-9', '--jsonl', transcriptAs(t, STREAM_USAGE, 'nope-9.jsonl'));

  assert.equal(out.status, 1);
});

// It writes the run file, so it is bound by the lease exactly as `stage` is —
// unlike `denials`, which is deliberately run-independent because it writes
// nothing at all.
test('usage is refused with exit 7 when another session holds the driver lease', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  const file = transcriptAs(t, STREAM_USAGE, 'task-5.jsonl');
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = runAs('sess-b', project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 7);
  assert.match(out.stderr, /sess-a/);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

// The structural half of task-27, and the same shape as the denials check
// above for the same reason: the two paths that run a headless session are
// step 5 and step 7's fix loop, and a call added to the first and forgotten
// on the second loses exactly the number this feature exists to keep — a fix
// loop is routinely the more expensive half of an item.
test('every step that runs a headless session records what it cost', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const sections = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.slice(3).trim();
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  for (const title of ['5. Inspect what the session left behind', '7. Review']) {
    assert.ok(sections.has(title), `section not found (renamed?): ${title}`);
    const body = sections.get(title).join('\n');
    assert.ok(
      body.includes('orchestrate.mjs" usage <id> --jsonl') || (title.startsWith('5.') && body.includes('orchestrate.mjs" inspect <id>')),
      `section "${title}" runs a headless session but never records what it cost`
    );
  }
});

// recovery.md, not SKILL.md: a resumed driver inherits a run file it did not
// write, and the usage entries the crashed one never got to are the one piece
// of a crashed run that decays on its own — the transcripts are pruned long
// before the run history is.
test('recovery.md tells a resumed driver to pick up the usage the crashed one missed', () => {
  const text = fs.readFileSync(path.join(path.dirname(SKILL_MD), 'references', 'recovery.md'), 'utf8');
  assert.ok(text.includes('orchestrate.mjs" usage <id> --jsonl'), 'recovery.md never re-runs `usage`');
});

// The reader on its own, the way readPermissionDenials is tested beside its
// own command: these two cases are about the transcript, not about the run
// file, and driving them through the CLI would make every assertion depend
// on a run existing first.
const STREAM_USAGE_TWO_RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-two-results.jsonl');
const STREAM_USAGE_NO_NUMBERS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-no-numbers.jsonl');

test('readSessionUsage reads the LAST result event, so a resumed segment is not read as the whole session', () => {
  // readPermissionDenials' own reason restated: a `--resume` can append a
  // second result to the same transcript, and the first describes a segment
  // that already ended.
  const usage = readSessionUsage(STREAM_USAGE_TWO_RESULTS);
  assert.equal(usage.costUsd, 9.5);
  assert.equal(usage.turns, 40);
});

test('readSessionUsage returns null for a transcript with no result event, and holes for one with no numbers', () => {
  // The two shapes cmdUsage branches on. `null` means "write nothing" —
  // a killed session was not free. A result event whose fields a future CLI
  // renamed still earns an entry, with `null` in every slot it could not
  // fill: the session demonstrably ran, and a `0` would price it.
  assert.equal(readSessionUsage(STREAM_NO_RESULT), null);

  const holes = readSessionUsage(STREAM_USAGE_NO_NUMBERS);
  assert.equal(holes.sessionId, '7c3d9a10-2b48-4e6f-9a01-5d8e3f2c7b64');
  for (const field of ['costUsd', 'turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'durationMs', 'model']) {
    assert.equal(holes[field], null, `${field} was filled with something rather than left a hole`);
  }
});

// --- #226: each session's peak context, the number `fix-mode` gates on ------
//
// Defined exactly as the retro defines a session's `context.peak`
// (skills/backlog-retro/tools/lib/sessions.mjs): the largest input + cache
// read + cache creation over every assistant event carrying usage. One
// definition, so the runner and the retro can never disagree about which
// sessions were long.

// A transcript written line by line, so each case states its own numbers
// rather than leaning on a shared fixture nobody reads. `turns` are
// [input, cacheRead, cacheCreation] triples; `undefined` leaves a key out.
function peakTranscript(t, turns, name = 'task-5.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-peak-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [{ type: 'system', subtype: 'init', session_id: 'peak-sess' }];
  for (const [input, cacheRead, cacheCreation] of turns) {
    const usage = { output_tokens: 1 };
    if (input !== undefined) usage.input_tokens = input;
    if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
    if (cacheCreation !== undefined) usage.cache_creation_input_tokens = cacheCreation;
    lines.push({ type: 'assistant', message: { content: [], usage } });
  }
  lines.push({ type: 'result', subtype: 'success', session_id: 'peak-sess', total_cost_usd: 1, num_turns: turns.length, usage: {} });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('usage records the peak context over every assistant turn, not the last one', (t) => {
  const { home, project } = usageRun(t);
  const file = peakTranscript(t, [
    [10, 1000, 200],
    [5, 90000, 100],
    [3, 50000, 0]
  ]);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(queueItem(home, project, 'task-5').usage[0].peakContextTokens, 90105);
  assert.equal(JSON.parse(out.stdout).usage.peakContextTokens, 90105, 'the echo line carries it too');
});

test('readSessionUsage counts a missing cache_creation_input_tokens as 0', (t) => {
  assert.equal(readSessionUsage(peakTranscript(t, [[7, 100, undefined]])).peakContextTokens, 107);
});

test('readSessionUsage leaves peakContextTokens null when no assistant event carries usage', () => {
  // The shared fixture's one assistant event has no `usage` at all — the
  // shape every transcript written before the CLI reported per-turn usage has.
  const usage = readSessionUsage(STREAM_USAGE);
  assert.equal(usage.peakContextTokens, null);
  assert.equal(usage.costUsd, 2.641441, 'every other field reads as it always did');
});

// --- #226: `fix-mode`, resume the last session or start a fresh fixer ----
//
// The decision SKILL.md §7 copies rather than computes. Every case here seeds
// the queue item's `usage` by hand, because what is under test is the choice
// over whatever `usage` recorded, not the recording (which the block above pins).

function fixModeRun(t, { usage, sessionId } = {}, sessionAs = 'sess-a') {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs(sessionAs, project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const item = body.queue.find((q) => q.id === 'task-5');
  if (usage !== undefined) item.usage = usage;
  if (sessionId !== undefined) item.sessionId = sessionId;
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return { home, project };
}

function usageEntry(kind, sessionId, peak, loop) {
  const entry = {
    sessionId,
    kind,
    costUsd: 1,
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 1,
    cacheCreationTokens: 1,
    durationMs: 1,
    model: null,
    endedAt: '2026-09-25T00:00:00.000Z'
  };
  if (peak !== undefined) entry.peakContextTokens = peak;
  if (loop !== undefined) entry.loop = loop;
  return entry;
}

function fixMode(t, seed) {
  const { home, project } = fixModeRun(t, seed);
  const out = run(project, home, 'fix-mode', 'task-5');
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test('fix-mode resumes an execute session that peaked below the threshold', (t) => {
  assert.deepEqual(fixMode(t, { usage: [usageEntry('execute', 's1', 120000)] }), {
    id: 'task-5',
    mode: 'resume',
    from: 'execute',
    loop: null,
    sessionId: 's1',
    peak: 120000,
    threshold: 150000
  });
});

test('fix-mode starts fresh at exactly the threshold, and still echoes the session it declined', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', 's1', 150000)] });
  assert.equal(answer.mode, 'fresh');
  assert.equal(answer.sessionId, 's1');
  assert.equal(answer.peak, 150000);
});

// Review focus 2: after a fresh first loop the thing to resume is the first
// fixer, whose context is small — not the long execute session behind it.
test('fix-mode picks the last recorded entry, so a second loop resumes a fresh first fixer', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', 's1', 240000), usageEntry('fix', 's2', 40000, 1)] });
  assert.equal(answer.mode, 'resume');
  assert.equal(answer.sessionId, 's2');
  assert.equal(answer.from, 'fix');
  assert.equal(answer.loop, 1);
});

// Review focus 1, assumption A2: an entry written before #226 has no peak,
// and the answer must be today's behaviour rather than a guess in the
// expensive direction.
test('fix-mode resumes when the entry predates peakContextTokens', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', 's1')] });
  assert.equal(answer.mode, 'resume');
  assert.equal(answer.peak, null);
  assert.equal(answer.sessionId, 's1');
});

test('fix-mode starts fresh when the entry has no session id to resume', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', null, 90000)] });
  assert.equal(answer.mode, 'fresh');
  assert.equal(answer.sessionId, null);
});

test("fix-mode with no usage entries falls back to the item's own session id", (t) => {
  assert.deepEqual(fixMode(t, { sessionId: 's9' }), {
    id: 'task-5',
    mode: 'resume',
    from: 'execute',
    loop: null,
    sessionId: 's9',
    peak: null,
    threshold: 150000
  });
});

test('fix-mode with no usage and no session id starts fresh', (t) => {
  const answer = fixMode(t, {});
  assert.equal(answer.mode, 'fresh');
  assert.equal(answer.sessionId, null);
});

test('fix-mode refuses an unknown id, a missing id and a missing run', (t) => {
  const { home, project } = fixModeRun(t, {});

  const unknown = run(project, home, 'fix-mode', 'nope-9');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /nope-9/);

  const bare = run(project, home, 'fix-mode');
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: orchestrate\.mjs fix-mode/);

  const empty = orchFixture(t);
  assert.equal(run(empty.project, empty.home, 'fix-mode', 'task-5').status, 3);
});

// Read-only, so no lease: a driver must be able to ask on a run another
// session leads (review focus 3 — a resumed driver gets the crashed one's answer).
test('fix-mode writes nothing and is not refused by another session holding the lease', (t) => {
  const { home, project } = fixModeRun(t, { usage: [usageEntry('execute', 's1', 200000)] }, 'sess-a');
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = runAs('sess-b', project, home, 'fix-mode', 'task-5');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).mode, 'fresh');
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

// --- bug-32: `git worktree remove` fails in two ways, not one -----------
//
// Two runs of this repo (run-20260903-112622 bug-14, run-20260905-213627
// task-19) paged a human over build output: the item merged green, the
// worktree removal printed `error: failed to delete '<path>': Directory not
// empty`, and §9's single refusal response recorded `attention … --kind
// parked`. That message is NOT git's clean check. Measured on git 2.50.1
// (Apple Git-155), and pinned by the last test in this block: the clean check
// refuses with `fatal: … contains modified or untracked files` and exit 128,
// having deleted nothing and unregistered nothing; a failed recursive delete
// exits 255 AFTER the clean check passed and AFTER the admin entry is gone,
// so the leftover directory is no longer a worktree at all. The two states
// need opposite responses — park the first, finish the second — and these
// cases exist to stop them collapsing back into one.

// Every line inside a ``` fence, trimmed: what a session actually runs, as
// opposed to prose that mentions a command in order to forbid it.
function fencedLinesOf(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push(line.trim());
  }
  return out;
}

// RETIRED with `cleanup` (see its block at the end of this file): the three pinned-text tests that stated the removal split in §9 and its one `rm -rf`.
// Their failure is now a behaviour test: cleanup 2, 3a, 3b and 3c.

test('`worktree remove --force` never enters a fenced block in any skill', () => {
  // §10's `--abort` mention is prose explaining why marker order matters,
  // and the forced form is legal there only because that path acts on a
  // worktree that is still registered. Nothing in the cleanup path may copy
  // it: after `failed to delete` the registration is already gone, so
  // `--force` answers `is not a working tree` and deletes nothing.
  const skills = fs.readdirSync(path.join(path.dirname(SKILL_MD), '..'));
  let checked = 0;
  for (const name of skills) {
    const file = path.join(path.dirname(SKILL_MD), '..', name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    checked += 1;
    const bad = fencedLinesOf(fs.readFileSync(file, 'utf8')).filter((l) => /worktree remove.*--force/.test(l));
    assert.deepEqual(bad, [], `${name}/SKILL.md runs a forced worktree remove:\n${bad.join('\n')}`);
  }
  assert.ok(checked >= 6, `expected to have read every skill body, read ${checked}`);
});

test('no attention detail template offers `worktree prune`', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');

  // Both recorded occurrences told a human to run `git worktree prune` on a
  // worktree git had already deregistered. The instruction was a no-op twice.
  // (The other half of this test — that the failed-delete branch records no
  // attention entry — is cleanup 3b/3c now.)
  const prune = text.split('\n').filter((l) => l.includes('--kind parked') && l.includes('worktree prune'));
  assert.deepEqual(prune, [], `an attention detail template still advises worktree prune:\n${prune.join('\n')}`);
});

test('ATTENTION_KINDS is still exactly needs-answers, parked, fix-exhausted — no cleanup kind was invented', () => {
  // The fix is prose-only: no new kind, no new stage, no new run-file field.
  // Case 11 above proves the tool refuses a fourth kind; this proves the
  // list itself was not widened to admit one.
  const tool = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(
    tool.includes("const ATTENTION_KINDS = ['needs-answers', 'parked', 'fix-exhausted']"),
    'ATTENTION_KINDS is no longer the exact three-member list SKILL.md is written against'
  );
});

test('git worktree remove: ignored build output alone removes cleanly, and a failed delete deregisters first', (t) => {
  // The two assumptions the §9 prose rests on, measured rather than asserted,
  // because the prose tells an unattended session which commands are pointless
  // (`--force`, `prune`) in a state it cannot inspect afterwards.
  if (process.getuid?.() === 0) return; // root ignores the 0555 bit the second case needs

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-wt-')));
  const repo = path.join(root, 'main');
  t.after(() => {
    // Restore the mode first or the temp tree itself cannot be deleted.
    fs.chmodSync(path.join(repo, 'wt-locked', 'src'), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  // 1. Nothing but ignored build output — the shape the bug report blamed.
  //    It removes cleanly: `--force` was never the fix for what was observed.
  git('worktree', 'add', '-q', 'wt-dist', '-b', 'b-dist');
  fs.mkdirSync(path.join(repo, 'wt-dist', 'dist'));
  fs.writeFileSync(path.join(repo, 'wt-dist', 'dist', 'bundle.js'), 'x'.repeat(1000));
  const clean = git('worktree', 'remove', 'wt-dist');
  assert.equal(clean.status, 0, `ignored output blocked a plain remove: ${clean.stderr}`);
  assert.equal(fs.existsSync(path.join(repo, 'wt-dist')), false);

  // 2. A tracked, unmodified tree git cannot finish deleting: the clean check
  //    passes, the delete fails, and the admin entry is already gone.
  git('worktree', 'add', '-q', 'wt-locked', '-b', 'b-locked');
  fs.chmodSync(path.join(repo, 'wt-locked', 'src'), 0o555);
  const failed = git('worktree', 'remove', 'wt-locked');
  assert.notEqual(failed.status, 0, 'the locked child did not stop the delete');
  assert.match(failed.stderr, /failed to delete/, `expected a delete failure, got: ${failed.stderr}`);
  assert.doesNotMatch(failed.stderr, /contains modified or untracked files/, 'this is the clean check, not the delete');

  const listed = git('worktree', 'list', '--porcelain').stdout;
  assert.ok(!listed.includes('wt-locked'), `the worktree is still registered after a failed delete:\n${listed}`);

  const forced = git('worktree', 'remove', '--force', 'wt-locked');
  assert.equal(forced.status, 128, `a --force retry should be refused outright, got ${forced.status}: ${forced.stderr}`);
  assert.match(forced.stderr, /is not a working tree/);
});

// --- task-34: a --json payload larger than the pipe buffer -------------------

test('a status --json larger than the pipe buffer arrives whole', (t) => {
  const { home, project } = orchFixture(t);
  // `process.stdout.write` to a PIPE is asynchronous, so `process.exit()` in
  // the entry guard drops everything past the 64KB pipe buffer — silently, and
  // only through a pipe (a `> file.json` redirect is a synchronous write on
  // POSIX and never shows it). `run` is spawnSync, i.e. a real pipe, which is
  // the whole point of driving the CLI here instead of calling cmdStatus.
  // retro.mjs:396-407 carries the long-form record of the shipped incident.
  const count = 250;
  const title = (i) => `Queued item ${i} with a deliberately long ASCII title so that the printed run file comfortably outgrows the pipe buffer`;
  for (let i = 1; i <= count; i += 1) seedReadyTask(project, `task-${i}`, title(i));
  // Load-bearing: the gate reads each item at `<base>` through `git show`, so
  // an uncommitted item is skipped as ungroomed and would never reach the
  // queue — leaving a fixture that is small, green, and proves nothing.
  commitEverything(project, 'seed a queue big enough to outgrow the pipe buffer');

  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const out = run(project, home, 'status', '--json');

  assert.equal(out.status, 0, out.stderr);
  const bytes = Buffer.byteLength(out.stdout, 'utf8');
  assert.ok(bytes > 65536, `only ${bytes} bytes reached the pipe`);
  assert.equal(JSON.parse(out.stdout).queue.length, count);
});

// --- task-44: the run-scoped base -------------------------------------------
// `--base` used to be a queue gate and nothing else; it is now the ref item
// worktrees are cut from and finished items are merged INTO, so `init` has to
// prove it is a branch that can actually receive a merge, and has to record it
// where every later command (and every resumed session) reads it back.
//
// `basedFixture` is `orchFixture` plus one commit, because a base check needs
// real refs to resolve against. Kept separate rather than folded into
// orchFixture: a commit there would give every OTHER test in this file a
// `blobReaderAt` that resolves, flipping the whole suite's gating from
// working-copy content to committed content.
function basedFixture(t) {
  const fx = orchFixture(t);
  fs.writeFileSync(path.join(fx.project, 'README.md'), 'base fixture\n');
  commitEverything(fx.project, 'base fixture');
  return fx;
}

test('init --base records an existing local branch in the run file', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feature/x'], { encoding: 'utf8' }).status, 0);

  const out = run(project, home, 'init', '--project', project, '--base', 'feature/x');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'feature/x');
});

test('init with no --base records "main"', (t) => {
  const { home, project } = basedFixture(t);

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'main');
});

test('init --base accepts a branch with slashes and records it verbatim', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feature/a/b'], { encoding: 'utf8' }).status, 0);

  const out = run(project, home, 'init', '--project', project, '--base', 'feature/a/b');

  assert.equal(out.status, 0, out.stderr);
  // Verbatim: nothing sanitises the RECORDED value. The sanitising in SKILL.md
  // §9 names a directory, and a base that came back as `feature-a-b` here
  // would be a ref that does not exist.
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'feature/a/b');
});

// One case per refusal rather than a loop, so a failure names which input
// regressed. All six share the same three assertions: exit 1, the value echoed
// back, and — the half that matters most — NO run file written, because
// `cmdInit` archives any existing run before writing and a check that ran
// after that point would destroy a real run for a call that never succeeds.
for (const [label, value, why] of [
  ['a tag', 'v1.0.0', 'a tag cannot move, and a run merges into its base'],
  ['a 40-hex SHA', '0123456789012345678901234567890123456789', 'a commit is not a branch'],
  ['a remote-tracking ref', 'origin/main', 'passes check-ref-format and is caught only by show-ref'],
  ['a branch that does not exist', 'no-such-branch', 'a typo is a refusal, never a create'],
  ['an empty string', '', 'a flag whose argv slot is empty is a different mistake from a misspelled one'],
  ['a leading dash', '-x', 'must never reach git as an option']
]) {
  test(`init --base refuses ${label} — exit 1, nothing written (${why})`, (t) => {
    const { home, project } = basedFixture(t);
    // The tag is real, so this case proves the REF KIND is refused rather than
    // merely that the name is unknown — the trap a nonexistent-name-only test
    // would fall into.
    if (label === 'a tag') assert.equal(spawnSync('git', ['-C', project, 'tag', value], { encoding: 'utf8' }).status, 0);

    const out = run(project, home, 'init', '--project', project, '--base', value);

    assert.equal(out.status, 1, `expected exit 1, got ${out.status}: ${out.stdout}${out.stderr}`);
    assert.ok(out.stderr.includes(JSON.stringify(value)), `the refusal does not name the offending value: ${out.stderr}`);
    assert.equal(fs.existsSync(runFile(home, project)), false, 'init wrote a run file for a base it refused');
  });
}

test('init --base refuses a base that is neither a branch nor the branch HEAD is on, even in a repo with no commits', (t) => {
  // The narrow half of the unborn-HEAD allowance: a commitless repo accepts
  // the branch HEAD points at, and nothing else. Without this case the
  // allowance could widen to "any base in a commitless repo" and no test
  // would notice.
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--base', 'feature/x');

  assert.equal(out.status, 1, `expected exit 1, got ${out.status}: ${out.stdout}${out.stderr}`);
  assert.equal(fs.existsSync(runFile(home, project)), false);
});

test('a run file written before task-44 has no base, and stage/heartbeat/attention neither need one nor add one', (t) => {
  const { home, project } = basedFixture(t);
  seedReadyTask(project, 'task-1', 'An item');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  // Strip `base` back off, reproducing a run file this tool wrote before the
  // field existed — the state every archived run on every machine is in.
  const file = runFile(home, project);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete before.base;
  fs.writeFileSync(file, JSON.stringify(before));

  for (const args of [
    ['stage', 'task-1', 'preflight'],
    ['heartbeat'],
    ['attention', 'task-1', '--kind', 'parked', '--detail', 'a detail']
  ]) {
    const out = run(project, home, ...args);
    assert.equal(out.status, 0, `${args[0]} failed on a run file with no base: ${out.stderr}`);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Neither invents one. Resolving an absent base is the SERVER reader's job
    // and happens in exactly one place (`sanitizeMergeFields`); a tool that
    // wrote `main` back into the file would be a second writer of that
    // decision, and would rewrite history for a run that never chose it.
    assert.equal('base' in after, false, `${args[0]} wrote a base into a run file that had none`);
  }
});

test('claim leaves a recorded base alone — a resumed run does not fall back to main', (t) => {
  // `--resume` is a prose flow rather than a command (SKILL.md §10), and
  // `claim` is the one write it opens with, so this is where "a resumed run
  // keeps its base" is actually testable. Asserting the VALUE in the file
  // afterwards, not `claim`'s own output, is the point: the failure this
  // guards against is a later command re-deriving BASE_REF_DEFAULT.
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feature/x'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'init', '--project', project, '--base', 'feature/x').status, 0);

  const out = run(project, home, 'claim');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'feature/x');
});

// --- task-44: the base-tree resolution ---------------------------------------
// The scan, the create and both preconditions are `merge-check`'s now, and its cases (the end of this file) execute them.
// What stays pinned as prose is what stays in SKILL.md: the merge line, and the removal boundary.
//
// RETIRED, each replaced by a `merge-check` case in the same commit:
//   - 'step 9 states all three base-tree outcomes, including the one the scan cannot see' -> merge-check 1 (a tree holds it),
//     2 (none does: created), 3 (the path is taken: park) and 12 (a mid-rebase tree reports `detached`, so the scan cannot see
//     it and `worktree add` refuses with `is already used by worktree at` — a REAL rebase, not a quotation of git's message).
//   - 'step 9 states the sanitisation of a base worktree name exactly, not vaguely' -> merge-check 2 and 10, which run it on
//     `feature/tracker-backed` and require the second call to reuse the path rather than create a second worktree.
//   - 'step 9 resolves the merge site from git ...' kept only its merge-line needle, below. Its `worktree list --porcelain` and
//     `symbolic-ref HEAD` needles are merge-check 1-5.

test('step 9 merges in the base tree explicitly, never wherever cwd happens to be', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  // The merge itself must carry `-C`. Without it the command lands wherever
  // cwd happens to be — correct only while the base is `main`, which is why
  // this would pass every default run and fail exactly the runs the feature
  // exists for.
  assert.ok(text.includes('git -C "<base tree>" merge --no-ff --no-edit backlog/<id>'), 'the merge no longer names the base tree explicitly');
  // The merge stays a literal Bash call in the body and `merge-check` never runs it: one classifier verdict per call.
  assert.ok(text.includes('merge-check <id>'), 'step 9 no longer calls merge-check before the merge');
  assert.doesNotMatch(
    fs.readFileSync(SCRIPT, 'utf8').replace(/\/\/.*$/gm, ''),
    /spawnSync\('git',\s*\[[^\]]*'(merge|push)'/,
    'orchestrate.mjs runs git merge or git push itself — those stay literal Bash calls in the skill body'
  );
});

test('step 9 and the hard limits both say the run removes only a base worktree it created', () => {
  // The boundary that keeps an unattended run from deleting someone's working
  // tree. Asserted in BOTH places because §9 is read during a run and the hard
  // limits are what a skimming reader stops at — a rule that survived in only
  // one of them would be half a rule.
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(/removes a base worktree \*\*only if it created it\*\*|removes a base worktree only if it created it/.test(text), '§9 lost the removes-only-what-it-created rule');
  assert.ok(/remove only a base worktree this run created/.test(text), 'the hard limits lost the removes-only-what-it-created rule');
  // Tied back to the existing sentence rather than standing as a new rule —
  // the two must read as one boundary, not two that could drift apart.
  assert.ok(text.includes('authority stops at worktrees it created itself'), 'the base-worktree rule is no longer tied to the existing authority sentence');
});

test('step 10 removes a run-created base worktree without failing the run', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(text.includes('worktree remove "$PWD/.worktrees/_base-'), 'finishing no longer removes the base worktree this run created');
  // Re-pointed: the decision to remove is read from the run file (merge-check 11 pins that the field is there and true),
  // never from the driver's memory of which outcome it took — a resumed session has none.
  assert.ok(text.includes('baseTree.created: true'), 'finishing no longer reads baseTree.created from status --json');
  // Flattened before matching, for the reason `noteValues` above already
  // gives: this sentence wraps mid-phrase in the prose, and a raw scan misses
  // it — a missed site reads as a missing rule.
  const flat = text.replace(/\s*\n\s*/g, ' ');
  assert.ok(/does not fail the run/.test(flat), 'a failed base-worktree removal is no longer explicitly non-fatal');
});

// --- bug-37: the runner's own scaffolding is excluded, never committed -------
// A per-item worktree has no `node_modules` of its own, so on this machine the
// runner links one in before the verify step can resolve anything. `.gitignore`
// carried `node_modules/` — directory-only — and git stores a symlink as a blob
// with mode 120000, so the link was neither ignored nor reported by
// `git status`, and §6's `git add -A` committed it onto `backlog/task-45` as a
// root-level path resolving outside every clone but the one that made it.
//
// `.gitignore` is fixed separately (test/gitignore-node-modules.test.ts). This
// half is the one that generalises: §4 already writes a local exclude for
// `.worktrees/`, and anything else the runner puts in a tree to make
// verification possible belongs in that same file — so a run is safe in a repo
// whose own `.gitignore` has the identical gap, and safe for the next such file,
// which will not be called `node_modules` either.
//
// The executable half of this block moved with the mechanism: `worktree <id>` appends the two lines, and its cases
// (leftover/worktree 6 and 7, plus the ensureExcludeLines unit case) run it for real. The three tests that executed
// SKILL.md's fenced `info/exclude` block are retired in the same commit that took the block out of the body. What stays
// below is the rule as prose, which no behaviour test can pin.

test('§4 states the rule as a rule, not as one file name', () => {
  // Naming `node_modules` alone would be fixed the day the runner needs a pnpm
  // shim or a scratch config instead, and nothing in the file would say what to
  // do with it.
  const text = fs.readFileSync(SKILL_MD, 'utf8').replace(/\s*\n\s*/g, ' ');
  assert.ok(
    text.includes('writes into a worktree to make verification possible'),
    '§4 no longer states the general rule about the runner\'s own scaffolding'
  );
  assert.ok(text.includes('never committed'), '§4 no longer says the scaffolding is excluded locally rather than committed');
});

// --- bug-38: every post-merge command runs in the tree the merge happened in -
// `git branch -d` has no `--merged-into`: it tests reachability from the HEAD
// of the repository the command runs in, so the invoking tree *is* the
// parameter. Before run-scoped bases that was invisible, because the project
// root and the tree holding the base were the same directory. On a `--base`
// run they are not, and the project root's HEAD is `main` while the merge
// commit sits on `<base>` — so the safe delete correctly refuses a branch that
// is genuinely merged. Measured on run-20260918-081422 (task-45, base
// feature/tracker-backed): `error: the branch 'backlog/task-45' is not fully
// merged` one line after `Merge made by the 'ort' strategy`.
//
// The leftover branch is the small half. The large half is that §9 told the
// driver to read that refusal as proof the merge did not happen — which is
// wrong in the direction that stops a healthy run, on every item of every
// `--base` run.
//
// These guards are over the SKILL's text rather than over behaviour because
// the SKILL body *is* the runner: no code executes these commands, a headless
// driver does, and the only way a wrong `-C` can be caught before it reaches
// a run is by reading the file.

// RETIRED with `cleanup`: 'no branch delete in SKILL.md runs in the project root' and "the runner-fix pickup diffs the merge commit, which is the
// base tree's HEAD". The body no longer holds either command, because `cleanup` runs both from the recorded base tree by construction; cleanup 1
// and 4 run the delete, cleanup 6-7 the diff, and cleanup 10 runs both on a `--base` run where the project root would give the wrong answer.

test('SKILL.md reads a branch -d refusal against the tree it was run in', () => {
  // The sentence that turned a stale command into a wrong instruction. A
  // refusal is only evidence of a missing merge when the delete ran in the
  // base tree; from anywhere else it is evidence the command was pointed at
  // the wrong tree. `git branch --merged <base>` is what settles which, and
  // is named here so a driver has something cheap to run before believing
  // either reading.
  //
  // RE-POINTED (body shrink, Task 6): the two readings and the command that settles them moved to references/rationale.md §9, so those three needles
  // read the body + references; the general rule stays one statement in the body and keeps its own body-only assertion. Needles unchanged.
  const text = skillText();
  for (const [rule, needle] of [
    ['the refusal is stated against the base tree', 'a refusal from the base tree'],
    ['the wrong-tree reading is stated too', 'pointed at the wrong tree'],
    ['the check that settles it is named', 'git branch --merged <base>'],
    [
      'the general rule is stated for the next command someone adds',
      'every cleanup command that follows a merge belongs in the tree that merge happened in',
    ],
  ]) {
    assert.ok(text.includes(needle), `SKILL.md §9 lost the rule: ${rule} (${needle})`);
  }
  assert.ok(
    fs.readFileSync(SKILL_MD, 'utf8').includes('every cleanup command that follows a merge belongs in the tree that merge happened in'),
    'the body no longer states the general rule: every cleanup command that follows a merge belongs in the tree that merge happened in',
  );
  assert.ok(
    !text.includes('so a refusal here is real information'),
    'SKILL.md still carries the unqualified "a refusal here is real information" reading',
  );
});

test('every project-root git command in SKILL.md is on the HEAD-independent allowlist', () => {
  // The general guard, and it is an ALLOWLIST rather than a search for the
  // bad shape — because the property that matters cannot be seen in the
  // string.
  //
  // The first version of this guard looked for lines that both named `$PWD`
  // and mentioned `HEAD`, on the theory that "names HEAD" marked the
  // commands that must follow the merge into the base tree. That is wrong
  // for the exact command bug-38 is about: `git branch -d backlog/<id>`
  // contains no `HEAD` anywhere, yet it tests reachability from the HEAD of
  // the repository it runs in, because it has no `--merged-into` and so the
  // invoking tree IS the parameter. The reverted bug would have passed that
  // guard. So would `branch --merged`, `branch --contains`, a bare `diff`
  // and a `status`.
  //
  // "Depends on the HEAD of the tree it runs in" is a fact about git's
  // semantics, not about the text, and no regex over a markdown file can
  // decide it. What a text guard CAN do honestly is fail closed: enumerate
  // the command shapes somebody has already checked are HEAD-independent,
  // and refuse everything else. A new `git -C "$PWD" …` line then goes red
  // until its author comes here, works out whether it depends on the
  // invoking tree's HEAD, and either moves it to `<base tree>` or adds it
  // below with the reason it is safe.
  //
  // That is the whole claim. This guard does not detect HEAD-dependence and
  // is not a substitute for the `cleanup` cases, which run the two specific
  // commands bug-38 moved, and the test above it, which pins the prose that reads their refusals.
  const allowed = [
    // A ref lookup by full name. Reads `refs/heads/…` directly; HEAD is not
    // consulted, and refs are shared by every tree in the repository.
    { why: 'ref lookup by full name', re: /^show-ref --verify\b/ },
    // Worktree administration is repo-wide by definition — the list, and the
    // directories added and removed, belong to the repository rather than to
    // whichever tree the command was typed in.
    { why: 'repo-wide worktree administration', re: /^worktree (list|add|remove)\b/ },
    // Given an explicit two-ref range, so no endpoint is resolved through
    // HEAD. The range is part of the allowlisted shape, not incidental to
    // it: `git -C "$PWD" diff --name-only` with the range dropped would be
    // HEAD-relative and must fail this guard.
    { why: 'diff over an explicit <base>...branch range', re: /^diff --name-only <base>\.\.\.backlog\/<id>(?=\s|$)/ },
    { why: 'log over an explicit <base>..branch range', re: /^log --oneline <base>\.\.backlog\/<id>(?=\s|$)/ },
  ];

  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const marker = 'git -C "$PWD" ';
  const offenders = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const at = line.indexOf(marker);
    // Command lines only — `^git` for a plain invocation, and the `(` and
    // `&&` forms a fenced block uses when it wraps one in a subshell.
    if (at === -1 || !/^[(\s]*(git|.*&&\s*git)\b/.test(line.slice(0, at + 4))) continue;
    const rest = line.slice(at + marker.length);
    if (!allowed.some((a) => a.re.test(rest))) offenders.push(line);
  }
  assert.deepEqual(
    offenders,
    [],
    'a git command runs in the project root without being on the HEAD-independent allowlist.\n' +
      'Work out whether it depends on the HEAD of the tree it runs in: if it does, point it at "<base tree>";\n' +
      'if it does not, add its shape to the allowlist in this test with the reason.\n' +
      offenders.join('\n'),
  );
});

// --- task-47: a tracker project's queue, claim and close ---------------------
//
// A project whose committed `backlog/source.json` says `github` has no item
// files: the queue comes from `GET /api/items`, and the claim that stops a
// second machine working an issue is a comment the API writes. Every case
// below spawns the REAL tool against a fake API on an ephemeral port, exactly
// as the cases above spawn it against a real store — the tool is the subject,
// and stubbing its transport would test the stub.
//
// Two shapes of the harness are load-bearing and neither is a preference:
//
//   * **The fake API runs in THIS process, so the tool must be spawned
//     ASYNCHRONOUSLY.** `spawnSync` blocks this process's event loop until the
//     child exits, and a child that connects to the fake would wait for an
//     accept that cannot happen until it has already exited — a five-minute
//     hang reported as exit `5`, which reads exactly like a stack that is not
//     running. `backlog.test.mjs`'s API-mode suite records the same deadlock.
//   * **`127.0.0.1`, never the wildcard**, for the reason `test/helpers/app.ts`
//     gives on the jest side: a bare `listen(0)` binds `::` and the kernel
//     picks a port against that address alone, so another process holding the
//     same number on IPv4 loopback answers instead.

import http from 'node:http';

const API_CALL_SCRIPT = fileURLToPath(new URL('./api-call.mjs', import.meta.url));

/** The fake API: records every request and answers from a per-route table. */
function fakeApi(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

      const answer = routes[url.pathname];
      const resolved = typeof answer === 'function' ? answer(body, url, req.method) : answer;
      if (resolved === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no fake route for ${url.pathname}` }));
        return;
      }
      const payload = resolved.body;
      // text/plain for the body route, which answers Markdown rather than
      // JSON — the same content type the real one uses.
      const type = typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      res.writeHead(resolved.status ?? 200, { 'content-type': type });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null));
    });
  });
  return { server, requests };
}

async function withApi(routes, fn) {
  const { server, requests } = fakeApi(routes);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return { out: await fn(port), requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** `runAsync` plus a `BM_API_PORT` and the control home every `run()` pins. */
function runApi(cwd, home, port, ...args) {
  return new Promise((resolve) => {
    const proc = spawn('node', [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, BM_ORCH_HOME: home, BM_ORCH_CONTROL_HOME: `${home}-control`, BM_API_PORT: String(port), CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** A port nothing is listening on — a closed one, for the two cases that are
 *  about the API being absent. Opened and immediately closed so the number is
 *  real and free rather than guessed. */
async function closedPort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** `orchFixture` plus a committed tracker marker. */
function trackerFixture(t, marker = { kind: 'github', repo: 'futin/x' }) {
  const fixture = orchFixture(t);
  fs.mkdirSync(path.join(fixture.project, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(fixture.project, 'backlog', 'source.json'), `${JSON.stringify(marker, null, 2)}\n`);
  return fixture;
}

const GROOMED_TASK_BODY = '## Goal\n\nSomething.\n\n## Plan\n\nDo the real work, described in enough detail to count as groomed.\n\n## Done when\n';
const GROOMED_BUG_BODY = '## Symptom\n\nx\n\n## Cause\n\na real diagnosed cause\n\n## Fix\n\nthe real fix\n';
const UNGROOMED_TASK_BODY = '## Goal\n\nSomething.\n\n## Plan\n\n## Done when\n';

/** One issue as `GET /api/items` returns it. Only the fields the gate reads
 *  are spelled out; a `BacklogItem` carries more, and none of the rest reaches
 *  `trackerCandidates`. */
function apiItem(projectPath, number, over = {}) {
  return {
    id: `#${number}`,
    title: `issue ${number}`,
    section: 'tasks',
    status: 'open',
    projectPath,
    path: `gh:futin/x#${number}`,
    source: 'github',
    ...over,
  };
}

/** The three read routes a tracker gate makes, as a route table. `bodies` is
 *  keyed by issue number.
 *
 *  `/api/trackers` is here because bug-41's retry times itself off this
 *  project's `polledAt`: the default is OLDER than one poll window, so the
 *  next tick reads as already due and a miss re-reads immediately rather than
 *  blocking this suite for fifteen seconds. A case that wants the wait itself
 *  measured drives `trackerRetryDelayMs` directly instead — a real sleep in a
 *  spawned child proves nothing a pure function does not. */
function gateRoutes(items, bodies, { projectPath = items.find((i) => i && i.projectPath)?.projectPath ?? '', polledAt = new Date(Date.now() - 60_000).toISOString() } = {}) {
  return {
    '/api/items': { body: { items, errors: [] } },
    // `init` on a tracker project marks its queue `orchestrator:queued`, and a
    // case that is not about the label wants those writes answered rather than
    // filling stderr with the fake's 404.
    '/api/items/queue': (body) => ({ body: { id: body?.id, queued: body?.queued } }),
    '/api/items/body': (_body, url) => {
      const number = String(url.searchParams.get('path') ?? '').replace(/^.*#/, '');
      return { body: bodies[number] ?? '' };
    },
    '/api/trackers': {
      body: {
        platforms: [{ kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4999, reset: null }],
        projects: [{ name: 'x', path: projectPath, source: 'github', repo: 'futin/x', polledAt, access: 'ok', detail: null, connect: null }],
      },
    },
  };
}

// --- O-1: a files run never touches the API ---------------------------------

test('a files run makes no API request at any stage, with the port closed', async (t) => {
  // The whole point of the marker check: `projectSource` answers `files` for a
  // project with no `source.json`, and not one command may then spawn the
  // helper. Pinned by making the API UNREACHABLE rather than by counting
  // requests — a count can only see the calls a test happens to drive, while a
  // closed port fails every one of them.
  const { home, project } = orchFixture(t);
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');
  // A second item left `pending`, so `reconcile` has a row to report.
  seedReadyTask(project, 'task-2', 'another task');

  const init = await runApi(project, home, port, 'init', '--project', project);
  assert.equal(init.status, 0, init.stderr);

  for (const args of [
    ['stage', 'task-1', 'preflight'],
    ['stage', 'task-1', 'dispatched', '--session', 's1'],
    ['stage', 'task-1', 'inspecting'],
    ['stage', 'task-1', 'merged'],
    // task-48's four: each publishes to the issue in a tracker run, and none
    // may so much as try in a files one.
    ['attention', 'task-2', '--kind', 'parked', '--detail', 'x'],
    ['heartbeat'],
  ]) {
    const out = await runApi(project, home, port, ...args);
    assert.equal(out.status, 0, `${args.join(' ')}: ${out.stderr}`);
  }

  const reconcile = await runApi(project, home, port, 'reconcile', '--json');
  assert.equal(reconcile.status, 0, reconcile.stderr);
  const rows = JSON.parse(reconcile.stdout);
  assert.deepEqual(rows.map((r) => r.id), ['task-2']);
  assert.equal('claim' in rows[0], false, 'a files run reports no claim column at all');

  const finish = await runApi(project, home, port, 'finish', '--status', 'done');
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(finish.stderr, '');

  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(run.queue[0].stage, 'merged');
  assert.equal(run.status, 'done');
  // No claim was ever taken, which is the other half of "no request was made".
  assert.equal(run.queue[0].claim, undefined);
});

// --- O-2: projectSource, through `plan` -------------------------------------

test('an unsupported source marker refuses the plan by name, and never falls back to files', async (t) => {
  const { home, project } = trackerFixture(t, { kind: 'jira', repo: 'futin/x' });
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /source\.json/);
  assert.match(out.stderr, /jira/);
  // The load-bearing negative: the item on disk is NOT reported.
  assert.doesNotMatch(out.stdout, /task-1/);
});

test('an explicit files marker runs the files walk, with the port closed', async (t) => {
  const { home, project } = trackerFixture(t, { kind: 'files' });
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((row) => row.id),
    ['task-1'],
  );
});

test('a github marker with no usable repo is refused, never treated as files', async (t) => {
  const { home, project } = trackerFixture(t, { kind: 'github', repo: 'not a repo' });
  const port = await closedPort();

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /valid "repo"/);
});

// --- A-1: the helper's own exit codes ---------------------------------------

test('api-call.mjs exits 5 with both start commands named when nothing is listening', async () => {
  const port = await closedPort();
  const out = await new Promise((resolve) => {
    const proc = spawn('node', [API_CALL_SCRIPT, 'GET', '/api/items'], { env: { ...process.env, BM_API_PORT: String(port) } });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (status) => resolve({ status, stderr }));
  });

  assert.equal(out.status, 5);
  assert.match(out.stderr, /pnpm run dev/);
  assert.match(out.stderr, /pnpm run docker:up/);
});

test('api-call.mjs exits 3 for a non-2xx and still writes the body to stdout', async () => {
  const { out } = await withApi({ '/api/items/claim': { status: 409, body: { error: 'held', holder: { session: 'B' } } } }, (port) =>
    new Promise((resolve) => {
      const proc = spawn('node', [API_CALL_SCRIPT, 'POST', '/api/items/claim', '{}'], { env: { ...process.env, BM_API_PORT: String(port) } });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    }),
  );

  assert.equal(out.status, 3);
  assert.deepEqual(JSON.parse(out.stdout), { error: 'held', holder: { session: 'B' } });
  assert.match(out.stderr, /409/);
});

// --- G-1 / G-2: the tracker gate --------------------------------------------

test('plan on a tracker project orders bugs then tasks, hoists the runner fix, and never mentions "not committed"', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [
    apiItem(project, 1),
    apiItem(project, 2),
    apiItem(project, 3, { section: 'bugs' }),
    apiItem(project, 5, { runnerFix: true }),
    // Two rows that must not reach the queue at all: another project's item,
    // and a closed one.
    apiItem('/somewhere/else', 9),
    apiItem(project, 10, { status: 'done' }),
  ];
  const bodies = { 1: GROOMED_TASK_BODY, 2: UNGROOMED_TASK_BODY, 3: GROOMED_BUG_BODY, 5: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['5', '3', '1', '2'],
  );
  assert.deepEqual(
    rows.map((r) => r.gate),
    ['ready', 'ready', 'ready', 'ungroomed'],
  );
  assert.deepEqual(
    rows.map((r) => r.hoisted),
    [true, false, false, false],
  );
  // There is no `<base>` read for a tracker project, so the skip that exists
  // for one has nothing to skip.
  assert.doesNotMatch(out.stdout, /not committed/);
});

test('--ids on a tracker project takes bare numbers only, and names the shape it wants', async (t) => {
  const { home, project } = trackerFixture(t);
  const routes = gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY });

  const hashed = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '#3', '--json'));
  assert.equal(hashed.out.status, 1);
  assert.match(hashed.out.stderr, /tracker items are named by issue number inside a run — got #3/);

  const absent = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '99', '--json'));
  assert.equal(absent.out.status, 1);
  assert.match(absent.out.stderr, /unknown item id: 99/);
});

// --- G-2a … G-2e: the cache a tracker queue is built from (bug-41) ----------
//
// `GET /api/items` is served from the poller's cache for a tracker project,
// by design — the hourly rate limit makes a per-request fetch impossible. So
// an issue GitHub accepted since the last tick is absent from the queue this
// tool builds, for at most one poll interval. Two failures followed from that
// silently: a named id read as `unknown item id: <n>`, which sounds permanent,
// and a whole-queue run simply left the newest issue out with no message at
// all. The fix is a bounded retry on the first and the cache's age printed on
// the second — never a fresh GET to GitHub, which is the groomer's explicitly
// rejected design.

test('the retry waits for the next poll to be due, and never longer than one window', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  // Never polled: there is nothing to time from, so wait one whole window.
  assert.equal(trackerRetryDelayMs(null, now), TRACKER_POLL_WINDOW_MS);
  // Polled this instant: the next tick is a whole window away.
  assert.equal(trackerRetryDelayMs(now, now), TRACKER_POLL_WINDOW_MS);
  // Mid-window: only the remainder is worth waiting for.
  assert.equal(trackerRetryDelayMs(now - 10_000, now), TRACKER_POLL_WINDOW_MS - 10_000);
  // Overdue: the tick this read is waiting for is already late, so re-read at
  // once — a poller that has stopped is not going to answer a longer wait.
  assert.equal(trackerRetryDelayMs(now - 60_000, now), 0);
  // A stamp in the future (clock skew between this process and the server's)
  // must not buy a wait longer than a fresh poll would.
  assert.equal(trackerRetryDelayMs(now + 60_000, now), TRACKER_POLL_WINDOW_MS);
});

test('the poll age reads as whole seconds, and says so when there has never been a poll', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(trackerPollAgeText(null, now), 'never polled');
  assert.equal(trackerPollAgeText(now - 12_000, now), 'polled 12 s ago');
  // Skew again: an age is never negative on the page that reads it.
  assert.equal(trackerPollAgeText(now + 5_000, now), 'polled 0 s ago');
});

test('a named tracker id the cache has not polled yet gets one retry and then runs', async (t) => {
  const { home, project } = trackerFixture(t);
  const item = apiItem(project, 7, { section: 'bugs' });
  let reads = 0;
  const routes = {
    ...gateRoutes([item], { 7: GROOMED_BUG_BODY }, { projectPath: project }),
    // The issue exists at GitHub throughout; the cache only learns about it on
    // the tick between these two reads.
    '/api/items': () => {
      reads++;
      return { body: { items: reads === 1 ? [] : [item], errors: [] } };
    },
  };

  const { out } = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '7', '--json'));

  assert.equal(out.status, 0, out.stderr);
  assert.equal(reads, 2, 'a first miss must re-read the index exactly once');
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => r.id),
    ['7'],
  );
});

test('a tracker id missing from both reads is refused, and the refusal names the cache and its age', async (t) => {
  const { home, project } = trackerFixture(t);
  const routes = gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }, { projectPath: project, polledAt: new Date(Date.now() - 42_000).toISOString() });

  const { out, requests } = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '99', '--json'));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /unknown item id: 99/);
  assert.match(out.stderr, /tracker cache/);
  assert.match(out.stderr, /polled \d+ s ago/);
  assert.equal(requests.filter((r) => r.path === '/api/items').length, 2, 'two reads a poll apart, then the refusal');
});

test('a tracker queue preview says how old the cache it was built from is', async (t) => {
  const { home, project } = trackerFixture(t);
  const routes = gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }, { projectPath: project, polledAt: new Date(Date.now() - 12_000).toISOString() });

  const { out } = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /tracker cache \(polled \d+ s ago\)/);
  // The line is stderr, so `--json` stdout stays exactly as parseable as it was.
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => r.id),
    ['3'],
  );
});

test('a files queue preview says nothing about a tracker cache', async (t) => {
  // The files branch of buildGatedQueue never reaches trackerCandidates, so
  // bug-41's two changes must be invisible here — with the API unreachable, as
  // O-1 pins it.
  const { home, project } = orchFixture(t);
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /tracker cache/);
});

// --- G-3 / G-4: init's pull, and the API being down -------------------------

test('init refuses when the base cannot fast-forward onto origin, and writes nothing', async (t) => {
  const { home, project } = trackerFixture(t);
  // A real diverged remote: a bare repo with one commit the project does not
  // have, and a project with one commit of its own.
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-remote-')));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });

  const seed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-seed-')));
  t.after(() => fs.rmSync(seed, { recursive: true, force: true }));
  spawnSync('git', ['clone', '-q', remote, seed], { encoding: 'utf8' });
  fs.writeFileSync(path.join(seed, 'theirs.txt'), 'theirs\n');
  commitEverything(seed, 'theirs');
  spawnSync('git', ['-C', seed, 'push', '-q', 'origin', 'main'], { encoding: 'utf8' });

  fs.writeFileSync(path.join(project, 'mine.txt'), 'mine\n');
  commitEverything(project, 'mine');
  spawnSync('git', ['-C', project, 'remote', 'add', 'origin', remote], { encoding: 'utf8' });

  const { out } = await withApi(gateRoutes([], {}), (port) => runApi(project, home, port, 'init', '--project', project));

  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stderr, /cannot fast-forward/);
  assert.equal(fs.existsSync(runFile(home, project)), false);
});

test('init and stage exit 8 with nothing written when the API is down', async (t) => {
  const { home, project } = trackerFixture(t);
  const port = await closedPort();

  const init = await runApi(project, home, port, 'init', '--project', project);
  assert.equal(init.status, 8);
  assert.match(init.stderr, /pnpm run dev/);
  assert.equal(fs.existsSync(runFile(home, project)), false);

  // Now with a run file on disk, so `stage` reaches its own request.
  const seeded = await withApi(gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }), (p) =>
    runApi(project, home, p, 'init', '--project', project),
  );
  assert.equal(seeded.out.status, 0, seeded.out.stderr);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const staged = await runApi(project, home, port, 'stage', '3', 'preflight');
  assert.equal(staged.status, 8);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

// --- P-1 … P-12: the claim as this machine's state --------------------------
//
// The driver owns a tracker item's claim for the whole item: it takes the
// issue at `stage <n> preflight`, publishes the queue item onto that claim
// from every command that changes it, and releases at the terminal stage. The
// dispatched session never touches the issue at all.
//
// Two asymmetries these cases exist to pin, because both are decisions that
// look like oversights from the code alone:
//
//   * **A failed heartbeat is never a failure of the command** (P-4). The run
//     file is the journal of record on this machine and the claim's `state` is
//     a published copy of it; failing a `stage` call over a copy would cost
//     this machine an item mid-flight for a write nothing local depends on.
//   * **A failed CLOSE is fatal** (P-8). That one is not a copy — it is the
//     only record anywhere that the item is done — so the stage is not written
//     and no release is sent, and the SKILL parks the item.

/** A tracker run whose queue holds one bug, `3`, claimed at `preflight`.
 *  Returns the route table (so a case can rewrite one answer) alongside it. */
function claimRoutes(project, over = {}) {
  let nextComment = 500;
  return {
    ...gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }),
    '/api/items/claim': (body, _url, method) =>
      method === 'GET'
        ? { body: { commentId: 500, record: { v: 1, counters: { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 } } } }
        : { status: 201, body: { commentId: (nextComment += 1), record: { v: 1, session: body?.session, run: body?.run } } },
    '/api/items/heartbeat': { status: 201, body: { commentId: 500, record: { v: 1 } } },
    '/api/items/release': { status: 201, body: { commentId: 500, record: { v: 1 } } },
    '/api/items/state': { status: 201, body: { id: '#3', status: 'done', url: 'https://example.invalid/3' } },
    ...over,
  };
}

const posts = (requests, route) => requests.filter((r) => r.method === 'POST' && r.path === `/api/items/${route}`);

test('stage preflight claims the issue for this run and records the comment id', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    const out = await runApi(project, home, port, 'stage', '3', 'preflight');
    assert.equal(out.status, 0, out.stderr);
  });

  const claims = posts(requests, 'claim');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].body.phase, 'execute');
  assert.equal(claims[0].body.id, '#3');
  assert.equal(claims[0].body.session, 'sess-test');

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(claims[0].body.run.runId, written.runId);
  assert.deepEqual(Object.keys(claims[0].body.run).sort(), ['base', 'maxItems', 'mergeMode', 'questionMode', 'runId', 'startedAt']);
  assert.deepEqual(written.queue[0].claim, { commentId: 501 });
});

test('a claim held by another run skips the item and says whose it is, exit 0', async (t) => {
  const { home, project } = trackerFixture(t);
  const held = {
    '/api/items/claim': (_body, _url, method) =>
      method === 'GET'
        ? { body: null }
        : { status: 409, body: { error: '#3 is already in progress', holder: { session: 'other-machine', heartbeat: '…', ageMs: 42_000, commentId: 7 } } },
  };

  const { requests } = await withApi(claimRoutes(project, held), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    const out = await runApi(project, home, port, 'stage', '3', 'preflight');
    // A refusal is information about the world, not a failure of this call.
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /"stage":"skipped"/);
  });

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.queue[0].stage, 'skipped');
  assert.match(written.queue[0].note, /^claimed elsewhere \(session other-machine, heartbeat 42s ago\)/);
  assert.equal(written.queue[0].claim, undefined);
  // No release for a claim this run never held.
  assert.equal(posts(requests, 'release').length, 0);
});

/* bug-46. The driver is a CLI like `backlog.mjs`, and it publishes claims other machines read: a session id names a transcript on exactly one host, so a
   claim carrying only that tells a reader elsewhere nothing they can check. The host rides beside it — sent by the CLI, never derived by the server, which
   may be in the compose stack where `os.hostname()` is a container id. */
test('the preflight claim carries the machine it was taken on, and a refusal names the holder-s', async (t) => {
  const { home, project } = trackerFixture(t);
  // `runApi` hands the child this process's environment, and a machine that has been given a claim-host nickname exports `BM_MACHINE_NAME` from
  // `~/.zshenv` — which the tool prefers, so the `<user>@<host>` default asserted below would never be computed. Unset here, restored after, the same way
  // the next case sets it.
  const before = process.env.BM_MACHINE_NAME;
  delete process.env.BM_MACHINE_NAME;
  t.after(() => {
    if (before !== undefined) process.env.BM_MACHINE_NAME = before;
  });

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
  });
  assert.match(posts(requests, 'claim')[0].body.host, /^[^@\s]+@\S+$/);

  const held = {
    '/api/items/claim': (_body, _url, method) =>
      method === 'GET'
        ? { body: null }
        : {
            status: 409,
            body: { error: '#3 is already in progress', holder: { session: 'other-machine', host: 'futin@mac', heartbeat: '…', ageMs: 42_000, commentId: 7 } },
          },
  };
  const { home: home2, project: project2 } = trackerFixture(t);
  await withApi(claimRoutes(project2, held), async (port) => {
    assert.equal((await runApi(project2, home2, port, 'init', '--project', project2)).status, 0);
    assert.equal((await runApi(project2, home2, port, 'stage', '3', 'preflight')).status, 0);
  });
  const written = JSON.parse(fs.readFileSync(runFile(home2, project2), 'utf8'));
  assert.match(written.queue[0].note, /^claimed elsewhere \(session other-machine on futin@mac, heartbeat 42s ago\)/);
});

/* The driver publishes the same machine name `backlog.mjs` does, because the server's release clause compares the two strings for equality: a run that
   claimed as `<user>@<host>` while a hand `abort` on the same box claimed as the nickname could not release its own item. Set in the environment, read in
   both tools, and blank reads as unset in both. */
test('the preflight claim carries BM_MACHINE_NAME when the machine has been given a name', async (t) => {
  const { home, project } = trackerFixture(t);
  const before = process.env.BM_MACHINE_NAME;
  process.env.BM_MACHINE_NAME = 'linux-box';
  t.after(() => {
    if (before === undefined) delete process.env.BM_MACHINE_NAME;
    else process.env.BM_MACHINE_NAME = before;
  });

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
  });

  assert.equal(posts(requests, 'claim')[0].body.host, 'linux-box');
});

test('every stage after preflight publishes the queue item onto the claim', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1')).status, 0);
  });

  const beats = posts(requests, 'heartbeat');
  assert.equal(beats.length, 2, 'one for preflight, one for dispatched');
  assert.equal(beats[1].body.commentId, 501);
  assert.equal(beats[1].body.state.stage, 'dispatched');
  assert.equal(beats[1].body.state.sessionId, 's1');
});

test('a heartbeat the API refuses is one stderr line and never fails the stage', async (t) => {
  const { home, project } = trackerFixture(t);
  const broken = { '/api/items/heartbeat': { status: 500, body: { error: 'boom' } } };

  const { out } = await withApi(claimRoutes(project, broken), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    return runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1');
  });

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /heartbeat for 3 was refused/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'dispatched');
});

test('usage publishes the new entry onto the claim', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    const out = await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE, '3.jsonl'));
    assert.equal(out.status, 0, out.stderr);
  });

  const beats = posts(requests, 'heartbeat');
  const last = beats[beats.length - 1];
  assert.equal(last.body.state.usage.length, 1);
  assert.equal(last.body.state.usage[0].kind, 'execute');
  assert.equal(last.body.state.usage[0].outputTokens, 52893);
});

test('stage merged in a tracker project requires --outcome, and writes nothing without it', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests, out } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    return runApi(project, home, port, 'stage', '3', 'merged');
  });

  assert.equal(out.status, 1);
  assert.match(out.stderr, /--outcome/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'preflight');
  assert.equal(posts(requests, 'state').length, 0);
  assert.equal(posts(requests, 'release').length, 0);
});

test('--outcome is refused for a files project, where the item file already carries the Outcome', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'a task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'stage', 'task-1', 'merged', '--outcome', '/tmp/whatever.md');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /--outcome is only for/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'pending');
});

test('stage merged reads the counters, closes the issue, then releases — in that order', async (t) => {
  const { home, project } = trackerFixture(t);
  const outcomeText = '## Outcome\n\n2026-09-19. It worked.\n';

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE, '3.jsonl'))).status, 0);

    const file = path.join(project, 'outcome.md');
    fs.writeFileSync(file, outcomeText);
    const out = await runApi(project, home, port, 'stage', '3', 'merged', '--outcome', file);
    assert.equal(out.status, 0, out.stderr);
  });

  // The three requests this path makes, in order and with nothing between.
  const tail = requests.filter((r) => ['/api/items/claim', '/api/items/state', '/api/items/release'].includes(r.path)).slice(-3);
  assert.deepEqual(
    tail.map((r) => `${r.method} ${r.path}`),
    ['GET /api/items/claim', 'POST /api/items/state', 'POST /api/items/release'],
  );
  assert.equal(tail[1].body.status, 'done');
  assert.equal(tail[1].body.outcome, outcomeText);
  assert.equal(tail[2].body.reason, 'merged');
  // bug-42: EVERY release this run sends asserts the run that owns the claim, not only abort's. `trackerRelease` adds the key unconditionally, because a
  // conditional would leave the resumed-driver case — an item released at a terminal stage whose claim comment was posted by the session that crashed —
  // quietly on the path the server refuses.
  assert.equal(tail[2].body.runId, JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).runId);
  // Read counters (1/2/3/4) plus this run's bill: 812345 ms floors to 812 s,
  // and 208 + 52893 + 204362 tokens are billed while the 15,155,855 CACHE
  // READS are not — the same set `backlog.mjs stop` bills for a files item.
  assert.deepEqual(tail[2].body.counters, { groomElapsed: 1, executeElapsed: 2 + 812, groomTokens: 3, executeTokens: 4 + 257_463 });
});

test('a refused close exits 9, writes no stage and sends no release', async (t) => {
  const { home, project } = trackerFixture(t);
  const broken = { '/api/items/state': { status: 502, body: { error: 'github said no' } } };

  const { requests, out } = await withApi(claimRoutes(project, broken), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    const file = path.join(project, 'outcome.md');
    fs.writeFileSync(file, 'x\n');
    return runApi(project, home, port, 'stage', '3', 'merged', '--outcome', file);
  });

  assert.equal(out.status, 9);
  assert.match(out.stderr, /github said no/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'preflight');
  assert.equal(posts(requests, 'release').length, 0);
});

test('stage branched releases the claim and never closes the issue', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project, '--merge-mode', 'branch')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    const out = await runApi(project, home, port, 'stage', '3', 'branched', '--branch', 'backlog/3');
    assert.equal(out.status, 0, out.stderr);
  });

  const released = posts(requests, 'release');
  assert.equal(released.length, 1);
  assert.equal(released[0].body.reason, 'branched');
  // The issue stays open under branch mode: nothing has landed on the base.
  assert.equal(posts(requests, 'state').length, 0);
});

test('usage entries with no numbers at all bill nothing, and the read counters go back unchanged', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE_NO_NUMBERS, '3.jsonl'))).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'failed')).status, 0);
  });

  const released = posts(requests, 'release');
  assert.equal(released.length, 1);
  // Not zeros: "nothing was recorded" is not "it cost zero", and zeros would
  // erase every earlier session's work on the item.
  assert.deepEqual(released[0].body.counters, { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 });
});

test('a resumed driver re-claims its own run-s in-flight items under the same runId', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1')).status, 0);
    const out = await runApi(project, home, port, 'claim');
    assert.equal(out.status, 0, out.stderr);
  });

  const claims = posts(requests, 'claim');
  assert.equal(claims.length, 2, 'the preflight claim, and the resume re-claim');
  assert.equal(claims[1].body.run.runId, claims[0].body.run.runId, 'the same run takes its own item back');

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(written.queue[0].claim, { commentId: 502 }, 'the new comment id replaces the old one');
  assert.equal(written.queue[0].stage, 'dispatched');
});

test('a resumed driver skips an item another run now holds, and leaves its worktree alone', async (t) => {
  const { home, project } = trackerFixture(t);
  const worktree = path.join(project, '.worktrees', '3');
  fs.mkdirSync(worktree, { recursive: true });
  let calls = 0;

  // The FIRST claim wins (the preflight), the second is refused — the shape a
  // resume meets when another machine picked the item up meanwhile.
  const contested = {
    '/api/items/claim': (body, _url, method) => {
      if (method === 'GET') return { body: null };
      calls += 1;
      return calls === 1
        ? { status: 201, body: { commentId: 501, record: { v: 1, session: body?.session, run: body?.run } } }
        : { status: 409, body: { error: 'held', holder: { session: 'other-machine', heartbeat: '…', ageMs: 30_000, commentId: 9 } } };
    },
  };

  await withApi(claimRoutes(project, contested), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1', '--worktree', worktree)).status, 0);
    const out = await runApi(project, home, port, 'claim');
    assert.equal(out.status, 0, out.stderr);
  });

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.queue[0].stage, 'skipped');
  assert.match(written.queue[0].note, /claimed elsewhere/);
  assert.match(written.queue[0].note, /worktree .* left in place/);
  // The run lost the item, not the work: nothing on disk is removed.
  assert.equal(fs.existsSync(worktree), true);
});

// --- I-1 … I-3: the snapshot, and the sidecars ------------------------------

test('snapshot writes the issue body and the session-s Outcome to one file', async (t) => {
  const { home, project } = trackerFixture(t);

  const { out } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    const dir = path.join(home, encodeURIComponent(project));
    fs.mkdirSync(path.join(dir, 'outcomes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outcomes', '3.md'), 'Contract sweep: none found\nRed proof: 1 test went red\n');
    return runApi(project, home, port, 'snapshot', '3');
  });

  assert.equal(out.status, 0, out.stderr);
  const written = fs.readFileSync(path.join(home, encodeURIComponent(project), 'items', '3.md'), 'utf8');
  assert.match(written, /## Cause/);
  assert.match(written, /## Outcome\n\nContract sweep: none found/);
});

test('snapshot is refused for a files project', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'a task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'snapshot', 'task-1');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /snapshot is for a tracker project/);
});

test('verify reads a tracker item-s Done when out of the snapshot, not out of any backlog file', async (t) => {
  const { home, project } = trackerFixture(t);
  const marker = path.join(project, 'verify-ran.txt');
  const body = `## Symptom\n\nx\n\n## Cause\n\nreal\n\n## Fix\n\nreal\n\n## Done when\n\n\`\`\`\nnode -e "require('fs').writeFileSync('${marker}','ran')"\n\`\`\`\n`;

  const { out } = await withApi({ ...claimRoutes(project), '/api/items/body': { body } }, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'snapshot', '3')).status, 0);
    return runApi(project, home, port, 'verify', '3', '--cwd', project, '--json');
  });

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  assert.deepEqual(
    JSON.parse(out.stdout).map((row) => row.ok),
    [true],
  );
});

test('a tracker run-s outcomes/ and items/ are archived beside its run file by the next init', async (t) => {
  const { home, project } = trackerFixture(t);
  const dir = path.join(home, encodeURIComponent(project));

  await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    fs.mkdirSync(path.join(dir, 'outcomes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outcomes', '3.md'), 'outcome\n');
    assert.equal((await runApi(project, home, port, 'snapshot', '3')).status, 0);
    assert.equal((await runApi(project, home, port, 'finish', '--status', 'done')).status, 0);
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
  });

  // The mover is a denylist of two (`run.json`, `runs/`), so a new sidecar
  // directory needs no change to it at all — which is exactly what this
  // asserts.
  const stems = fs.readdirSync(runsDir(home, project)).filter((name) => !name.endsWith('.json'));
  assert.equal(stems.length, 1);
  assert.equal(fs.readFileSync(path.join(runsDir(home, project), stems[0], 'outcomes', '3.md'), 'utf8'), 'outcome\n');
  assert.ok(fs.existsSync(path.join(runsDir(home, project), stems[0], 'items', '3.md')));
  assert.equal(fs.existsSync(path.join(dir, 'outcomes')), false);
});

// --- W-1 / W-2: the push-and-pull prose (task-47) ---------------------------

test('SKILL.md carries the tracker push and pull, and leaves the files merge line alone', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  for (const [rule, needle] of [
    ['the per-item pull', 'pull --ff-only origin <base>'],
    ['the push after a merge', 'push origin <base>'],
    ['the branch-mode push', 'push -u origin backlog/<n>'],
    ['the merge commit names the issue', 'Fixes #<n>'],
    ['the close rides the stage', 'stage <n> merged --outcome'],
  ]) {
    assert.ok(text.includes(needle), `SKILL.md lost the tracker rule: ${rule} (${needle})`);
  }
  // The files path is untouched, which is the other half of the claim: a
  // tracker-shaped edit that also rewrote the ordinary merge would pass every
  // assertion above.
  assert.ok(text.includes('git -C "<base tree>" merge --no-ff --no-edit backlog/<id>'), 'the files merge line changed');
  assert.ok(!/files[^\n]*\bgit push\b/i.test(text), 'a files-path push appeared in SKILL.md');
});

test('SKILL.md says a classifier-denied PUSH parks, in the push paragraph itself', () => {
  // The one place the classifier-denial rule does NOT apply, and it has to be
  // stated beside the push rather than somewhere in the file: a denied MERGE
  // degrades the run to branch mode because nothing landed, while a denied
  // PUSH follows a merge that HAS landed, so `branched` would be a falsehood
  // written into the run file and into the summary a person reads afterwards.
  const flat = fs.readFileSync(SKILL_MD, 'utf8').replace(/\s*\n\s*/g, ' ');
  const at = flat.indexOf('push origin <base>');
  assert.ok(at !== -1, 'the push command is gone');
  const paragraph = flat.slice(at, at + 1600);
  assert.match(paragraph, /denied by the auto-mode classifier/i);
  assert.match(paragraph, /park/i);
  assert.match(paragraph, /branch mode|branched/i);
});

// --- #222: the merge is one Bash call of its own, and the probe asks what it will ask ---
//
// run-20260923-154625 (claude-agents-dashboard) chained `git merge …; git push
// origin main` into ONE Bash call. The classifier judges a call as a whole, so
// a reviewed, green merge was denied as "[Merge Without Review]" and the run
// degraded to branch mode — the push question had turned into a merge denial.
// The tracker snippet had also lost its branch argument, which is what invited
// the driver to improvise the command in the first place.

const fencedLines = (text) => {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push(line.trim());
  }
  return out;
};

test('the tracker merge snippet names its branch and carries the review provenance', () => {
  const lines = fencedLines(fs.readFileSync(SKILL_MD, 'utf8'));
  const tracker = lines.filter((l) => l.startsWith('git -C "<base tree>" merge --no-ff -m "Merge backlog/<n>'));
  assert.equal(tracker.length, 1, `expected exactly one tracker merge snippet, found ${tracker.length}`);
  const [merge] = tracker;
  assert.ok(merge.endsWith(' backlog/<n>'), `the tracker merge does not name the branch it merges: ${merge}`);
  assert.ok(merge.includes('-m "Fixes #<n>"'), 'the tracker merge lost its Fixes line');
  assert.match(merge, /-m "Reviewed: approve \(reviews\/<n>-<k>\.md\)"/, 'the tracker merge does not show the classifier the review it passed');
});

test('no snippet chains a git merge with anything else, and the rule says why', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const merges = fencedLines(text).filter((l) => /^git\b.*\bmerge --no-ff\b/.test(l));
  assert.ok(merges.length >= 4, `only ${merges.length} merge snippets found — the scan is no longer reaching them`);
  for (const line of merges) {
    // Quotes stripped first: a `;` or `|` inside a -m message is text, not a chain.
    const bare = line.replace(/"[^"]*"/g, '""');
    assert.ok(!/;|&&|\|\||\|/.test(bare), `a merge snippet chains another command: ${line}`);
    assert.ok(!/\bpush\b/.test(bare), `a merge snippet pushes: ${line}`);
  }
  const flat = text.replace(/\s*\n\s*/g, ' ');
  assert.match(flat, /never chains `git merge` with anything else/, 'the one-call rule is not stated');
  assert.match(flat, /one classifier verdict per (Bash )?call/i, 'the one-call rule lost its reason');
});

test('the probe has the tracker merge\'s shape, and a resumed run probes before its first merge', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const lines = fencedLines(text);
  const mFlags = (l) => (l.replace(/"[^"]*"/g, '""').match(/ -m ""/g) ?? []).length;
  const [trackerMerge] = lines.filter((l) => l.startsWith('git -C "<base tree>" merge --no-ff -m "Merge backlog/<n>'));
  const trackerProbe = lines.filter((l) => /^git merge --no-ff -m .* HEAD$/.test(l));
  assert.equal(trackerProbe.length, 1, `expected exactly one tracker-shaped probe, found ${trackerProbe.length}`);
  assert.equal(mFlags(trackerProbe[0]), mFlags(trackerMerge), 'the tracker probe does not carry as many -m messages as the tracker merge');
  assert.ok(lines.includes('git merge --no-ff --no-edit HEAD'), 'the files probe changed');
  const flat = text.replace(/\s*\n\s*/g, ' ');
  assert.match(flat, /resumed or unpaused[^.]*probes? before its first merge/i, 'SKILL.md does not make a resumed run probe');
  const recovery = fs.readFileSync(path.join(path.dirname(SKILL_MD), 'references', 'recovery.md'), 'utf8').replace(/\s*\n\s*/g, ' ');
  assert.match(recovery, /before this session's first merge: run SKILL\.md §2's merge probe/, 'recovery.md does not send a resumed run to the probe');
});

// --- C-1 … C-5: task-48, what the rest of the run publishes -----------------
//
// Phase 4b makes a run VISIBLE from other machines, and the only thing another
// machine can read is the issue. So three more commands publish there —
// `finish` stamps the outcome on the last-touched claim, `attention` posts a
// comment, and `heartbeat` keeps every held claim alive — and `reconcile`
// reads who holds each item before it suggests anything. Every publish is
// best-effort for the reason P-4 gives: `run.json` is the journal of record.

/** A tracker run whose queue is rewritten to `items` after `init` — each
 *  `{ id, stage, at, claim }` — so a case states exactly the stages and claims
 *  it is about without driving a merge to get there. */
async function seededTrackerRun(t, items) {
  const fixture = trackerFixture(t);
  const { home, project } = fixture;
  const gate = gateRoutes(
    items.map((i) => apiItem(project, Number(i.id), { section: 'bugs' })),
    Object.fromEntries(items.map((i) => [i.id, GROOMED_BUG_BODY])),
  );
  const { out } = await withApi(gate, (port) => runApi(project, home, port, 'init', '--project', project));
  assert.equal(out.status, 0, out.stderr);
  const file = runFile(home, project);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  run.queue = run.queue.map((q) => {
    const want = items.find((i) => i.id === q.id);
    // `pending` pinned before every case's stamps: `init` stamped it with the
    // real clock, which would otherwise be every item's newest arrival.
    const next = { ...q, stage: want.stage, stageAt: { pending: '2026-09-19T09:00:00.000Z', [want.stage]: want.at ?? '2026-09-19T10:00:00.000Z' } };
    if (want.claim !== undefined) next.claim = { commentId: want.claim };
    return next;
  });
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  return { ...fixture, runId: run.runId };
}

const TRACKERS = (login) => ({ body: { platforms: [{ kind: 'github', hasToken: true, login }], projects: [] } });

test('C-1: finish stamps finished on the last-touched claimed item, and only that one', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '3', stage: 'merged', at: '2026-09-19T10:00:00.000Z', claim: 503 },
    { id: '5', stage: 'skipped', at: '2026-09-19T10:05:00.000Z', claim: 505 },
  ]);

  const { out, requests } = await withApi({ '/api/items/heartbeat': { status: 201, body: { commentId: 505, record: { v: 1 } } } }, (port) =>
    runApi(project, home, port, 'finish', '--status', 'done'),
  );

  assert.equal(out.status, 0, out.stderr);
  const beats = posts(requests, 'heartbeat');
  assert.equal(beats.length, 1);
  assert.equal(beats[0].body.commentId, 505);
  assert.equal(beats[0].body.id, '#5');
  assert.equal(beats[0].body.finished.status, 'done');
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  /* bug-45: the route refuses a heartbeat from anyone but the holder, and `finish` normally runs in a DIFFERENT session from the one that took the claim —
     a resumed driver, or the abort session a force stop spawns. `runId` is what makes it the same RUN, exactly as it is on `release`. */
  assert.equal(beats[0].body.session, 'sess-test');
  assert.equal(beats[0].body.runId, run.runId);
  assert.equal(beats[0].body.finished.at, run.updatedAt, 'the stamp and the journal name one instant');
});

test('C-2: finish with the API down exits 0, says so once, and the run file still reads done', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '3', stage: 'merged', claim: 503 }]);
  const port = await closedPort();

  const out = await runApi(project, home, port, 'finish', '--status', 'done');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr.trim().split('\n').length, 1, out.stderr);
  assert.match(out.stderr, /finished stamp on 3 could not be sent/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'done');
});

test('C-3: attention posts one marker comment mentioning the token-s user, and still records the entry', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [{ id: '5', stage: 'parked', claim: 505 }]);
  const routes = (login) => ({
    '/api/trackers': TRACKERS(login),
    '/api/items/comment': { status: 201, body: { commentId: 900, url: 'https://example.invalid/5#c900' } },
  });

  const withLogin = await withApi(routes('futin'), (port) => runApi(project, home, port, 'attention', '5', '--kind', 'parked', '--detail', 'x'));
  assert.equal(withLogin.out.status, 0, withLogin.out.stderr);
  const comments = posts(withLogin.requests, 'comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body.id, '#5');
  const lines = comments[0].body.body.split('\n');
  assert.equal(lines[0], `<!-- bm:attention kind=parked run=${runId} -->`);
  assert.match(comments[0].body.body, /@futin x/);
  assert.deepEqual(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).attention, [{ id: '5', kind: 'parked', detail: 'x' }]);

  const noLogin = await withApi(routes(null), (port) => runApi(project, home, port, 'attention', '5', '--kind', 'parked', '--detail', 'y'));
  assert.equal(noLogin.out.status, 0, noLogin.out.stderr);
  const bare = posts(noLogin.requests, 'comment');
  assert.equal(bare.length, 1);
  assert.doesNotMatch(bare[0].body.body, /@/);
});

test('C-4: heartbeat keeps every claim the run still holds alive, and none it released', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '3', stage: 'reviewing', claim: 503 },
    { id: '5', stage: 'needs-answers', claim: 505 },
    { id: '7', stage: 'merged', claim: 507 },
  ]);

  const { out, requests } = await withApi({ '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } } }, (port) =>
    runApi(project, home, port, 'heartbeat'),
  );

  assert.equal(out.status, 0, out.stderr);
  const beats = posts(requests, 'heartbeat');
  assert.deepEqual(
    beats.map((r) => r.body.commentId).sort(),
    [503, 505],
  );
  // Every beat names its author and its run (bug-45) — see C-1 for why the run is the load-bearing half.
  const runId = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).runId;
  for (const beat of beats) {
    assert.equal(beat.body.session, 'sess-test');
    assert.equal(beat.body.runId, runId);
  }
});

// --- bug-40: abort gives every claim it still holds back ---------------------
//
// Before this, `trackerRelease` had exactly one caller — the `stage` path's
// `CLAIM_RELEASE_STAGES` check — so a run torn down by `abort` never passed
// through a terminal stage and never gave its issues back. The cost is not
// bounded by `CLAIM_STALE_MS` the way the claim protocol's own contest rule
// is: the mapper reads `started`/`phase` off any UNRELEASED claim, fresh or
// stale, and `progressBlock` gates on the presence of `started` rather than
// its age, so the item's dispatch control stayed disabled on every machine's
// board until a person ran `backlog.mjs stop <id> --abandon` by hand.
//
// The two halves this case pins are the release set ("still holds", the same
// predicate `heartbeat` uses) and the ORDER: the releases must land before
// `cmdFinish`'s own `finished` stamp, which `GithubSource.heartbeat` accepts
// on an already-released claim and which would otherwise be stamping a claim
// this run was about to hand back.

test('bug-40: abort releases every claim the run still holds, reason aborted, before it finishes the run', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [
    { id: '3', stage: 'reviewing', claim: 503 },
    { id: '5', stage: 'needs-answers', claim: 505 },
    { id: '7', stage: 'merged', claim: 507 },
    { id: '9', stage: 'pending' },
  ]);

  const { out, requests } = await withApi(
    {
      '/api/items/claim': {
        body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 } } },
      },
      '/api/items/release': { status: 201, body: { commentId: 0, record: { v: 1 } } },
      '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
    },
    (port) => runApi(project, home, port, 'abort'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"status":"aborted"/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'aborted');

  const released = posts(requests, 'release');
  assert.deepEqual(
    released.map((r) => r.body.commentId).sort(),
    [503, 505],
    'abort released the wrong set of claims — "still holds" is claim set and the stage not one that already released it',
  );
  for (const r of released) {
    // NOT a `RunStage`: `remote-runs.util.ts` reads a release reason as the
    // item's stage when it happens to be one, and otherwise leaves the last
    // reported stage alone. `aborted` is deliberately not a stage name.
    assert.equal(r.body.reason, 'aborted');
    assert.equal(r.body.id, `#${r.body.commentId === 503 ? 3 : 5}`);
    // Billed the ordinary way, through `claimCountersFor` — an abort is not
    // `backlog.mjs stop --abandon`'s dead-interval case.
    assert.deepEqual(r.body.counters, { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 });
    // bug-42: the assertion that makes the release AUTHORISED. This session is not the claim's holder — the driver that posted the comment is, and on
    // the path this exists for it is dead — so without a `runId` naming the run whose lease `takeOverRun` just took, the server refuses every one of
    // these and the item keeps its unreleased claim, its `in-progress` label and its disabled dispatch control on every machine.
    assert.equal(r.body.runId, runId);
    // …and it claims run authority WITHOUT impersonating the holder: `session` stays this session's, so `released.by` records who actually did it.
    assert.equal(r.body.session, 'sess-test');
  }

  const order = requests.filter((r) => r.method === 'POST' && ['/api/items/release', '/api/items/heartbeat'].includes(r.path)).map((r) => r.path);
  assert.deepEqual(order, ['/api/items/release', '/api/items/release', '/api/items/heartbeat'], 'the finished stamp must land after every release');
});

test('bug-40: a refused release is one stderr line and abort still exits 0 with the run aborted', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '3', stage: 'reviewing', claim: 503 }]);

  const { out, requests } = await withApi(
    {
      '/api/items/claim': { body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } },
      '/api/items/release': { status: 502, body: { error: 'github said no' } },
      '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
    },
    (port) => runApi(project, home, port, 'abort'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"status":"aborted"/);
  assert.match(out.stderr, /release of 3 was refused/);
  assert.equal(posts(requests, 'release').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'aborted');
});

// --- #240: finish gives back what a finished run still holds ---------------
//
// `needs-answers` stays out of `CLAIM_RELEASE_STAGES` because a LIVE run comes
// back to the item. A run that finishes `done` or `failed` never does, so
// before #240 a parked question's claim outlived its run — and with it the
// disabled dispatch control on every board, which going stale does not clear
// (bug-40). `paused` is the one status that keeps them: a resume returns.

const FINISH_ROUTES = {
  '/api/items/claim': { body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } },
  '/api/items/release': { status: 201, body: { commentId: 0, record: { v: 1 } } },
  '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
  '/api/items/queue': (body) => ({ body: { id: body?.id } }),
};

test('#240: finish --status done releases a needs-answers claim, reason finished, before the finished stamp', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [
    { id: '3', stage: 'merged', claim: 503 },
    { id: '5', stage: 'needs-answers', claim: 505 },
  ]);

  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'finish', '--status', 'done'));

  assert.equal(out.status, 0, out.stderr);
  const released = posts(requests, 'release');
  assert.deepEqual(released.map((r) => r.body.commentId), [505], 'exactly the claim the run still holds — the merged one was released at its stage');
  assert.equal(released[0].body.id, '#5');
  // Not a `RunStage`, so the item's last reported stage stays `needs-answers` on every other machine's Runs page.
  assert.equal(released[0].body.reason, 'finished');
  assert.equal(released[0].body.runId, runId);
  const order = requests.filter((r) => r.method === 'POST' && ['/api/items/release', '/api/items/heartbeat'].includes(r.path)).map((r) => r.path);
  assert.deepEqual(order, ['/api/items/release', '/api/items/heartbeat'], 'the finished stamp must land after the release');
});

test('#240: finish --status failed releases too', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '5', stage: 'needs-answers', claim: 505 }]);
  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'finish', '--status', 'failed'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(posts(requests, 'release').map((r) => [r.body.commentId, r.body.reason]), [[505, 'finished']]);
});

test('#240: finish --status paused keeps every claim, because a resume returns to them', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '5', stage: 'needs-answers', claim: 505 },
    { id: '7', stage: 'reviewing', claim: 507 },
  ]);
  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'finish', '--status', 'paused'));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(posts(requests, 'release').length, 0);
});

test('#240: abort releases each held claim once, not once in abort and again in the finish it ends with', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '5', stage: 'needs-answers', claim: 505 }]);
  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'abort'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(posts(requests, 'release').map((r) => [r.body.commentId, r.body.reason]), [[505, 'aborted']]);
});

test('bug-40: a files run-s abort makes no API request on any path', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-26', 'Some task');
  commitEverything(project, 'seed');

  const { out, requests } = await withApi({}, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    return runApi(project, home, port, 'abort');
  });

  assert.equal(out.status, 0, out.stderr);
  assert.equal(requests.length, 0, `a files run reached the API: ${requests.map((r) => r.path).join(', ')}`);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'aborted');
});

test('C-5: reconcile reads who holds each item, and another run-s live claim means skip', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [
    { id: '3', stage: 'reviewing', claim: 503 },
    { id: '5', stage: 'reviewing', claim: 505 },
  ]);
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 20 * 60_000).toISOString();
  const claimRoute = (_body, url) =>
    url.searchParams.get('id') === '#5'
      ? { body: { commentId: 9, record: { v: 1, session: 'B', heartbeat: fresh, run: { runId: 'run-20260101-000000' } } } }
      : { body: { commentId: 503, record: { v: 1, session: 'sess-test', heartbeat: stale, run: { runId } } } };

  const { out } = await withApi({ '/api/items/claim': claimRoute }, (port) => runApi(project, home, port, 'reconcile', '--json'));
  assert.equal(out.status, 0, out.stderr);
  const rows = Object.fromEntries(JSON.parse(out.stdout).map((r) => [r.id, r]));
  assert.equal(rows['5'].claim, 'other');
  assert.equal(rows['5'].suggestion, 'skip');
  assert.equal(rows['3'].claim, 'this-run');
  // Unchanged from before task-48: no worktree and no branch is `park`.
  assert.equal(rows['3'].suggestion, 'park');

  const down = await runApi(project, home, await closedPort(), 'reconcile', '--json');
  assert.equal(down.status, 0, down.stderr);
  assert.deepEqual(JSON.parse(down.stdout).map((r) => r.claim), ['unknown', 'unknown']);
});

// --- Q-1 … Q-7: `orchestrator:queued`, the driver's half (task-55) -----------
//
// The label is the run's PLAN, published: `init` adds it to every item the run
// will attempt, and the driver takes it off each item that leaves the plan
// without being claimed — a skip at `preflight`, and `finish`'s sweep. A WON
// claim sends nothing, because the server's claim swap already removed it.
// Every write is advisory: a refusal is a stderr line and never an exit code.

const queueBodies = (requests) => posts(requests, 'queue').map((r) => ({ id: r.body.id, queued: r.body.queued }));

test('Q-1: init on a tracker project marks exactly the queue --max builds, in queue order', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [31, 32, 33].map((n) => apiItem(project, n));
  const bodies = { 31: GROOMED_TASK_BODY, 32: GROOMED_TASK_BODY, 33: GROOMED_TASK_BODY };

  const { out, requests } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'init', '--project', project, '--max', '2'));

  assert.equal(out.status, 0, out.stderr);
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(run.queue.length, 2);
  assert.deepEqual(
    queueBodies(requests),
    run.queue.map((q) => ({ id: `#${q.id}`, queued: true })),
  );
  // The issue numbers that reached the fake, not only the count: queue ids are bare, the route takes `#n` (Review Focus 5).
  assert.deepEqual(queueBodies(requests).map((b) => b.id).sort(), ['#31', '#32']);
  for (const r of posts(requests, 'queue')) assert.equal(r.body.project, project);
});

test('Q-2: init on a files project makes no queue request', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'a task');
  commitEverything(project, 'seed');

  const { out, requests } = await withApi({}, (port) => runApi(project, home, port, 'init', '--project', project));

  assert.equal(out.status, 0, out.stderr);
  assert.equal(posts(requests, 'queue').length, 0);
});

test('Q-3: a refused add at init is one stderr line naming the item, and init still exits 0 with the run written', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [31, 32].map((n) => apiItem(project, n));
  const routes = {
    ...gateRoutes(items, { 31: GROOMED_TASK_BODY, 32: GROOMED_TASK_BODY }),
    '/api/items/queue': (body) => (body?.id === '#32' ? { status: 502, body: { error: 'github said no' } } : { body: { id: body?.id, queued: true } }),
  };

  const { out, requests } = await withApi(routes, (port) => runApi(project, home, port, 'init', '--project', project));

  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(runFile(home, project)));
  assert.match(out.stderr, /orchestrator:queued: add failed for 32 — github said no/);
  assert.doesNotMatch(out.stderr, /failed for 31/);
  // A refusal is per item: the loop went on past it rather than stopping.
  assert.equal(posts(requests, 'queue').length, 2);
});

test('Q-4: a claim lost at preflight skips the item and takes its label off; a won claim sends nothing', async (t) => {
  const { home, project } = trackerFixture(t);
  const held = {
    '/api/items/claim': (_body, _url, method) =>
      method === 'GET'
        ? { body: null }
        : { status: 409, body: { error: '#3 is already in progress', holder: { session: 'other-machine', heartbeat: '…', ageMs: 42_000, commentId: 7 } } },
  };

  const lost = await withApi(claimRoutes(project, held), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    return runApi(project, home, port, 'stage', '3', 'preflight');
  });
  assert.equal(lost.out.status, 0, lost.out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'skipped');
  // The add from `init`, then the removal the skip makes — and the fake's 200 for it prints nothing.
  assert.deepEqual(queueBodies(lost.requests), [
    { id: '#3', queued: true },
    { id: '#3', queued: false },
  ]);
  assert.doesNotMatch(lost.out.stderr, /orchestrator:queued/);

  const { home: home2, project: project2 } = trackerFixture(t);
  const won = await withApi(claimRoutes(project2), async (port) => {
    assert.equal((await runApi(project2, home2, port, 'init', '--project', project2)).status, 0);
    return runApi(project2, home2, port, 'stage', '3', 'preflight');
  });
  assert.equal(won.out.status, 0, won.out.stderr);
  // Only `init`'s add: the server's claim swap owns the removal on a won claim.
  assert.deepEqual(queueBodies(won.requests), [{ id: '#3', queued: true }]);
});

test('Q-4b: an item staged skipped before it was ever claimed takes its label off then, not at finish', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '33', stage: 'pending' }]);

  const { out, requests } = await withApi({ '/api/items/queue': (body) => ({ body: { id: body?.id } }) }, (port) =>
    runApi(project, home, port, 'stage', '33', 'skipped', '--note', 'gate failed'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(queueBodies(requests), [{ id: '#33', queued: false }]);
});

test('Q-5: finish sweeps the label off every item the run never claimed, and paused sweeps nothing', async (t) => {
  const seed = () =>
    seededTrackerRun(t, [
      { id: '31', stage: 'merged', claim: 531 },
      { id: '32', stage: 'skipped' },
      { id: '33', stage: 'pending' },
    ]);
  const routes = { '/api/items/heartbeat': { status: 201, body: { commentId: 531, record: { v: 1 } } }, '/api/items/queue': (body) => ({ body: { id: body?.id } }) };

  const done = await seed();
  const { out, requests } = await withApi(routes, (port) => runApi(done.project, done.home, port, 'finish', '--status', 'done'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(queueBodies(requests), [
    { id: '#32', queued: false },
    { id: '#33', queued: false },
  ]);

  // A paused run still means to reach those items, and a resume re-adds nothing — so the pause must not take them off.
  const paused = await seed();
  const p = await withApi(routes, (port) => runApi(paused.project, paused.home, port, 'finish', '--status', 'paused'));
  assert.equal(p.out.status, 0, p.out.stderr);
  assert.equal(posts(p.requests, 'queue').length, 0);
});

test('Q-6: abort makes the same sweep, once, after its claim releases', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '31', stage: 'reviewing', claim: 531 },
    { id: '32', stage: 'skipped' },
    { id: '33', stage: 'pending' },
  ]);

  const { out, requests } = await withApi(
    {
      '/api/items/claim': { body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } },
      '/api/items/release': { status: 201, body: { commentId: 0, record: { v: 1 } } },
      '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
      '/api/items/queue': (body) => ({ body: { id: body?.id } }),
    },
    (port) => runApi(project, home, port, 'abort'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(queueBodies(requests), [
    { id: '#32', queued: false },
    { id: '#33', queued: false },
  ]);
  const order = requests.filter((r) => r.method === 'POST' && ['/api/items/release', '/api/items/queue'].includes(r.path)).map((r) => r.path);
  assert.deepEqual(order, ['/api/items/release', '/api/items/queue', '/api/items/queue'], 'the sweep must follow the in-flight release');
});

test('Q-7: finish with the API down warns once for the whole sweep and exits as a files finish does', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '32', stage: 'skipped' },
    { id: '33', stage: 'pending' },
    { id: '34', stage: 'pending' },
  ]);

  const out = await runApi(project, home, await closedPort(), 'finish', '--status', 'done');

  const files = orchFixture(t);
  seedReadyTask(files.project, 'task-1', 'a task');
  commitEverything(files.project, 'seed');
  assert.equal(run(files.project, files.home, 'init', '--project', files.project).status, 0);
  const filesFinish = run(files.project, files.home, 'finish', '--status', 'done');

  assert.equal(out.status, filesFinish.status, out.stderr);
  const down = out.stderr.split('\n').filter((line) => /API down/.test(line));
  assert.deepEqual(down, ['orchestrator:queued: API down — label not removed on 3 item(s)']);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'done');
});

// --- merge-check: the base tree and both merge preconditions -----------------
//
// SKILL.md §9 used to spell out finding the tree that holds the base, creating
// one when none does, and the two preconditions on it, as ~7.6k chars of prose a
// model re-read every turn. `merge-check <id>` runs that sequence. The cases
// below ARE the behaviour the prose used to describe, run against real temp git
// repos — including the three outcomes of the base-tree scan, which no test
// could execute while they lived in markdown.

const MC_ID = 'task-1';

/** Runs `git -C <cwd> <args>` and throws on failure, so a fixture that cannot be built says so rather than testing nothing. */
function gitOk(cwd, ...args) {
  const out = spawnSync('git', ['-C', cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${out.stderr}`);
  return out.stdout;
}

/**
 * A committed project with `src/a.ts`, `README.md` and one groomed task per id in `ids`, each with a `backlog/<id>`
 * worktree whose branch changes `src/a.ts`; a run initialised on `base` (a branch name that is created off `main` when
 * it is not `main`). The project root stays on `main` unless the case moves it.
 */
function mergeCheckFixture(t, { base = 'main', ids = [MC_ID], branchTouches = ['src/a.ts'] } = {}) {
  const fx = basedFixture(t);
  fs.mkdirSync(path.join(fx.project, 'src'));
  fs.writeFileSync(path.join(fx.project, 'src', 'a.ts'), 'one\n');
  for (const id of ids) seedReadyTask(fx.project, id, `Item ${id}`);
  commitEverything(fx.project, 'seed src and tasks');
  if (base !== 'main') gitOk(fx.project, 'branch', base);
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project, '--base', base).status, 0);
  for (const id of ids) {
    const worktree = path.join(fx.project, '.worktrees', id);
    gitOk(fx.project, 'worktree', 'add', worktree, '-b', `backlog/${id}`, 'main');
    for (const rel of branchTouches) fs.writeFileSync(path.join(worktree, rel), `${id} changed ${rel}\n`);
    gitOk(worktree, 'add', '-A');
    gitOk(worktree, 'commit', '-q', '-m', `${id} work`);
  }
  return fx;
}

function mergeCheck(fx, ...args) {
  return run(fx.project, fx.home, 'merge-check', ...args);
}

function readRunJson(fx) {
  return JSON.parse(fs.readFileSync(runFile(fx.home, fx.project), 'utf8'));
}

function stageOf(fx, id = MC_ID) {
  return readRunJson(fx).queue.find((q) => q.id === id).stage;
}

function treeListing(project) {
  return gitOk(project, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

test('merge-check 1: base checked out in the project root and clean — merge, root is the base tree, nothing created, stage merging', (t) => {
  const fx = mergeCheckFixture(t);

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  const verdict = JSON.parse(out.stdout.trim());
  assert.equal(verdict.verdict, 'merge');
  assert.equal(verdict.baseTree, fx.project);
  assert.equal(verdict.created, false);
  assert.equal(stageOf(fx), 'merging');
  assert.deepEqual(readRunJson(fx).baseTree, { path: fx.project, created: false });
  // The two scratch files go under the run's own directory, as the prose always put them.
  const verifyDir = path.join(path.dirname(runFile(fx.home, fx.project)), 'verify');
  assert.equal(fs.readFileSync(path.join(verifyDir, `${MC_ID}.branch-paths`), 'utf8').trim(), 'src/a.ts');
  assert.equal(fs.readFileSync(path.join(verifyDir, `${MC_ID}.dirty-paths`), 'utf8').trim(), '');
});

test('merge-check 2: a base held by no tree gets .worktrees/_base-<sanitised> — created true on stdout and in the run file, merge', (t) => {
  const fx = mergeCheckFixture(t, { base: 'feature/tracker-backed' });

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  const expected = path.join(fx.project, '.worktrees', '_base-feature-tracker-backed');
  const verdict = JSON.parse(out.stdout.trim());
  assert.equal(verdict.verdict, 'merge');
  assert.equal(verdict.baseTree, expected);
  assert.equal(verdict.created, true);
  assert.deepEqual(readRunJson(fx).baseTree, { path: expected, created: true });
  assert.equal(gitOk(expected, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/feature/tracker-backed');
  assert.ok(treeListing(fx.project).includes(expected));
  assert.equal(stageOf(fx), 'merging');
});

test('merge-check 3: _base-<x> already exists and holds another branch — park naming that path, no new worktree', (t) => {
  const fx = mergeCheckFixture(t, { base: 'x' });
  const squatter = path.join(fx.project, '.worktrees', '_base-x');
  gitOk(fx.project, 'worktree', 'add', squatter, '-b', 'something-else', 'main');
  const before = treeListing(fx.project);

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  const verdict = JSON.parse(out.stdout.trim());
  assert.equal(verdict.verdict, 'park');
  assert.ok(verdict.detail.includes(squatter), `the detail does not name the path: ${verdict.detail}`);
  assert.ok(verdict.detail.includes('kept for a manual merge'));
  assert.equal(stageOf(fx), 'parked');
  assert.deepEqual(readRunJson(fx).attention, [{ id: MC_ID, kind: 'parked', detail: verdict.detail }], 'the park is the same attention entry the prose wrote');
  assert.deepEqual(treeListing(fx.project), before, 'a worktree was created');
  assert.equal(readRunJson(fx).baseTree, undefined, 'nothing was created or found, so no base tree is recorded');
});

// Cases 4-5 are NOT reachable through the full command: treeHoldingBranch only matches
// `branch refs/heads/<base>`, so a detached or switched tree is never chosen as the base tree and the tool creates
// `_base-<base>` instead, as the prose did. Precondition 1 now guards the window inside one process, which is why it
// is exercised here as an exported function on a prepared tree.
test('merge-check 4 (precondition-1 function, not the full command): a base tree on a detached HEAD parks, with the template filled as "a detached HEAD"', (t) => {
  const fx = mergeCheckFixture(t);
  const tree = path.join(fx.project, '.worktrees', 'detached-tree');
  gitOk(fx.project, 'worktree', 'add', '--detach', tree, 'main');

  const result = orch.baseTreePrecondition(tree, 'main', MC_ID);

  assert.equal(result.verdict, 'park');
  assert.equal(result.detail, `base tree ${tree} is on a detached HEAD, not refs/heads/main — branch backlog/${MC_ID} kept for a manual merge`);
  assert.ok(result.detail.includes('is on a detached HEAD, not refs/heads/main'));
});

test('merge-check 5 (precondition-1 function, not the full command): a base tree on refs/heads/other parks naming that ref', (t) => {
  const fx = mergeCheckFixture(t);
  const tree = path.join(fx.project, '.worktrees', 'other-tree');
  gitOk(fx.project, 'worktree', 'add', tree, '-b', 'other', 'main');

  const result = orch.baseTreePrecondition(tree, 'main', MC_ID);

  assert.equal(result.verdict, 'park');
  assert.equal(result.detail, `base tree ${tree} is on refs/heads/other, not refs/heads/main — branch backlog/${MC_ID} kept for a manual merge`);
  assert.equal(orch.baseTreePrecondition(fx.project, 'main', MC_ID), null, 'a tree on the base passes');
});

test('merge-check 6: an unstaged edit the branch also touches is an overlap — nothing parked; --park-on-overlap parks with the exact template', (t) => {
  const fx = mergeCheckFixture(t);
  fs.writeFileSync(path.join(fx.project, 'src', 'a.ts'), 'edited by a person\n');

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  const verdict = JSON.parse(out.stdout.trim());
  assert.equal(verdict.verdict, 'overlap');
  assert.deepEqual(verdict.paths, ['src/a.ts']);
  assert.equal(stageOf(fx), 'merging', 'an overlap parks nothing — the body may still resolve on the worktree side');
  assert.deepEqual(readRunJson(fx).attention, []);

  const parked = mergeCheck(fx, MC_ID, '--park-on-overlap');

  assert.equal(parked.status, 0, parked.stderr);
  const parkVerdict = JSON.parse(parked.stdout.trim());
  assert.equal(parkVerdict.verdict, 'park');
  assert.equal(
    parkVerdict.detail,
    `merge would be refused: src/a.ts are uncommitted in ${fx.project} and this branch also touches them — commit or stash them, then merge backlog/${MC_ID} by hand`
  );
  assert.equal(stageOf(fx), 'parked');
  assert.deepEqual(readRunJson(fx).attention, [{ id: MC_ID, kind: 'parked', detail: parkVerdict.detail }]);
});

test('merge-check 7: a STAGED-only edit the branch also touches is an overlap (a git-diff-only probe reads clean over it)', (t) => {
  const fx = mergeCheckFixture(t);
  fs.writeFileSync(path.join(fx.project, 'src', 'a.ts'), 'staged by a person\n');
  gitOk(fx.project, 'add', 'src/a.ts');
  assert.equal(gitOk(fx.project, 'diff', '--name-only'), '', 'the fixture must be staged-only');

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  const verdict = JSON.parse(out.stdout.trim());
  assert.equal(verdict.verdict, 'overlap');
  assert.deepEqual(verdict.paths, ['src/a.ts']);
});

test('merge-check 8: a dirty file the branch does not touch is not an overlap — merge', (t) => {
  const fx = mergeCheckFixture(t);
  fs.writeFileSync(path.join(fx.project, 'README.md'), 'a person is editing this\n');

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout.trim()).verdict, 'merge');
  const verifyDir = path.join(path.dirname(runFile(fx.home, fx.project)), 'verify');
  assert.equal(fs.readFileSync(path.join(verifyDir, `${MC_ID}.dirty-paths`), 'utf8').trim(), 'README.md');
});

test('merge-check 9: no run exits 3, a foreign lease 7, an unknown id 1, a missing backlog/<id> 1 — and none of them writes the run file', (t) => {
  // No run at all.
  const bare = basedFixture(t);
  assert.equal(run(bare.project, bare.home, 'merge-check', MC_ID).status, 3);
  assert.equal(fs.existsSync(runFile(bare.home, bare.project)), false);

  const fx = mergeCheckFixture(t, { ids: [MC_ID, 'task-2'] });
  // task-2 is queued but its branch is deleted.
  gitOk(fx.project, 'worktree', 'remove', '--force', path.join(fx.project, '.worktrees', 'task-2'));
  gitOk(fx.project, 'branch', '-D', 'backlog/task-2');
  const file = runFile(fx.home, fx.project);
  const before = fs.readFileSync(file);

  assert.equal(run(fx.project, fx.home, 'merge-check').status, 1, 'no id is a usage error');
  assert.equal(run(fx.project, fx.home, 'merge-check', MC_ID, '--bogus').status, 1, 'an unknown flag is a usage error');
  assert.equal(run(fx.project, fx.home, 'merge-check', 'task-99').status, 1, 'an unknown id');
  const missing = run(fx.project, fx.home, 'merge-check', 'task-2');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /backlog\/task-2/);
  assert.ok(before.equals(fs.readFileSync(file)), 'a refusal wrote the run file');

  // A foreign driver: the run is led by sess-a, so sess-b is refused.
  const led = basedFixture(t);
  seedReadyTask(led.project, MC_ID, 'Item');
  commitEverything(led.project, 'seed');
  assert.equal(runAs('sess-a', led.project, led.home, 'init', '--project', led.project).status, 0);
  gitOk(led.project, 'branch', `backlog/${MC_ID}`);
  const ledBefore = fs.readFileSync(runFile(led.home, led.project));
  assert.equal(runAs('sess-b', led.project, led.home, 'merge-check', MC_ID).status, 7);
  assert.ok(ledBefore.equals(fs.readFileSync(runFile(led.home, led.project))), 'a foreign lease refusal wrote the run file');
});

test('merge-check 10: a second item on a run that created the base tree reuses it — same path, created still true, one worktree', (t) => {
  const fx = mergeCheckFixture(t, { base: 'feature/tracker-backed', ids: [MC_ID, 'task-2'] });
  const first = JSON.parse(mergeCheck(fx, MC_ID).stdout.trim());
  assert.equal(first.created, true);
  const trees = treeListing(fx.project);

  const out = mergeCheck(fx, 'task-2');

  assert.equal(out.status, 0, out.stderr);
  const second = JSON.parse(out.stdout.trim());
  assert.equal(second.verdict, 'merge');
  assert.equal(second.baseTree, first.baseTree);
  assert.equal(second.created, true, 'once true, created stays true — the run still owns that worktree');
  assert.deepEqual(readRunJson(fx).baseTree, { path: first.baseTree, created: true });
  assert.deepEqual(treeListing(fx.project), trees, 'a second base worktree was created');
});

test('merge-check 11: status --json after a created base tree carries baseTree.created true (what §10 and a resumed run read)', (t) => {
  const fx = mergeCheckFixture(t, { base: 'feature/tracker-backed' });
  assert.equal(mergeCheck(fx, MC_ID).status, 0);

  const status = run(fx.project, fx.home, 'status', '--json');

  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).baseTree.created, true);
  assert.equal(JSON.parse(status.stdout).baseTree.path, path.join(fx.project, '.worktrees', '_base-feature-tracker-backed'));
});

test('merge-check 12: a base held only by a worktree mid-rebase is invisible to the scan, `worktree add` refuses, and it parks quoting git — nothing created, created not set', (t) => {
  const fx = mergeCheckFixture(t, { base: 'feature/x' });
  // A REAL mid-rebase tree: feature/x conflicts with main, so `rebase` stops and leaves HEAD detached.
  const holder = path.join(fx.project, '.worktrees', 'rebasing');
  gitOk(fx.project, 'worktree', 'add', holder, 'feature/x');
  fs.writeFileSync(path.join(holder, 'src', 'a.ts'), 'feature side\n');
  gitOk(holder, 'commit', '-q', '-am', 'feature side');
  fs.writeFileSync(path.join(fx.project, 'src', 'a.ts'), 'main side\n');
  gitOk(fx.project, 'commit', '-q', '-am', 'main side');
  const rebase = spawnSync('git', ['-C', holder, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'rebase', 'main'], { encoding: 'utf8' });
  assert.notEqual(rebase.status, 0, 'the fixture needs a rebase that stops on a conflict');
  assert.ok(gitOk(fx.project, 'worktree', 'list', '--porcelain').includes('detached'), 'the holder must report detached, or this is not outcome 3');
  const before = treeListing(fx.project);

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  const verdict = JSON.parse(out.stdout.trim());
  assert.equal(verdict.verdict, 'park');
  assert.equal(
    verdict.detail,
    `feature/x is checked out at ${holder} but not cleanly (git: fatal: 'feature/x' is already used by worktree at '${holder}') — branch backlog/${MC_ID} kept for a manual merge`
  );
  assert.equal(stageOf(fx), 'parked');
  assert.equal(verdict.created, false);
  assert.equal(readRunJson(fx).baseTree, undefined, 'a refused add must not record a base tree');
  assert.deepEqual(treeListing(fx.project), before, 'a worktree was created');
});

test('merge-check 13: a stop request exits 10 from the `stage merging` step — no baseTree written, no worktree created', (t) => {
  const fx = mergeCheckFixture(t, { base: 'feature/x' });
  effectiveStop(fx.home, fx.project);
  const file = runFile(fx.home, fx.project);
  const before = fs.readFileSync(file);
  const trees = treeListing(fx.project);

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 10, out.stderr);
  assert.match(out.stderr, /stop was requested/);
  assert.ok(before.equals(fs.readFileSync(file)), 'the refused call wrote the run file');
  assert.equal(readRunJson(fx).baseTree, undefined);
  assert.deepEqual(treeListing(fx.project), trees);
});

// --- leftover and worktree: §3's leftover probe and §4's worktree creation ---
//
// SKILL.md §3 and §4 each spelled out the same three-probe block (branch, registered worktree, directory) as shell a
// model ran and read, then §4 went on to create the worktree, prove the item survived the checkout and append two
// lines to `info/exclude`. `leftover <id>` is the read-only classification; `worktree <id>` re-runs it, refuses
// anything but `none` or `reattach`, and does the rest. The cases below ARE the behaviour that prose described, run
// against real temp git repos — including the `node_modules_old` input no happy path exercises.

const LW_ID = 'task-1';

/** A committed project with groomed tasks `ids` on `main`, and a run initialised on it. No item branch or worktree exists yet. */
function leftoverFixture(t, { ids = [LW_ID] } = {}) {
  const fx = basedFixture(t);
  for (const id of ids) seedReadyTask(fx.project, id, `Item ${id}`);
  commitEverything(fx.project, 'seed tasks');
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project).status, 0);
  return fx;
}

function leftover(fx, ...args) {
  return run(fx.project, fx.home, 'leftover', ...args);
}

function worktreeCmd(fx, ...args) {
  return run(fx.project, fx.home, 'worktree', ...args);
}

function verdictOf(out) {
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim());
}

/** Makes `backlog/<id>` with one extra commit via a throwaway worktree. `keep` leaves that worktree at `.worktrees/<id>`. */
function seedItemBranch(fx, id, { keep = false, archive = false } = {}) {
  const tree = path.join(fx.project, '.worktrees', id);
  gitOk(fx.project, 'worktree', 'add', tree, '-b', `backlog/${id}`, 'main');
  if (archive) {
    fs.mkdirSync(path.join(tree, 'backlog', 'tasks', 'done'), { recursive: true });
    gitOk(tree, 'mv', path.join('backlog', 'tasks', 'open', `${id}-fixture.md`), path.join('backlog', 'tasks', 'done', `${id}-fixture.md`));
  } else {
    fs.writeFileSync(path.join(tree, 'extra.txt'), `${id} extra\n`);
    gitOk(tree, 'add', '-A');
  }
  gitOk(tree, 'commit', '-q', '-m', `${id} work`);
  if (!keep) gitOk(fx.project, 'worktree', 'remove', tree);
  return tree;
}

function branchList(project) {
  return gitOk(project, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
}

test('leftover/worktree unit: the verdict table covers every probe combination, and the archive check only matters for a branch alone', () => {
  const v = (branch, worktree, dir, archived = null) => orch.classifyLeftover({ branch, worktree, dir, archived });
  assert.equal(v(false, false, false), 'none');
  assert.equal(v(true, false, false, true), 'archived');
  assert.equal(v(true, false, false, false), 'reattach');
  assert.equal(v(true, true, true), 'resume-or-park');
  assert.equal(v(true, true, true, true), 'resume-or-park', 'the archive check is not applied once a worktree exists');
  for (const combo of [
    [false, true, true],
    [false, false, true],
    [false, true, false],
    [true, true, false],
    [true, false, true]
  ]) {
    assert.equal(v(...combo), 'park', `branch=${combo[0]} worktree=${combo[1]} dir=${combo[2]}`);
  }
});

test('leftover/worktree unit: ensureExcludeLines appends only absent whole lines, and a file with no trailing newline does not glue the first one on', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-exclude-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'info', 'exclude');
  assert.deepEqual(orch.ensureExcludeLines(dir, ['.worktrees/', 'node_modules']), ['.worktrees/', 'node_modules'], 'a missing file and directory are created');
  assert.equal(fs.readFileSync(file, 'utf8'), '.worktrees/\nnode_modules\n');
  assert.deepEqual(orch.ensureExcludeLines(dir, ['.worktrees/', 'node_modules']), [], 'a second call appends nothing');

  fs.writeFileSync(file, 'keep-me');
  assert.deepEqual(orch.ensureExcludeLines(dir, ['.worktrees/']), ['.worktrees/']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep-me\n.worktrees/\n');
});

test('leftover/worktree 1: a fresh item is `none`; worktree creates .worktrees/<id> on a new backlog/<id> cut from the base, absolute, created "new"', (t) => {
  const fx = leftoverFixture(t);
  const file = runFile(fx.home, fx.project);
  const before = fs.readFileSync(file);

  const probe = verdictOf(leftover(fx, LW_ID));

  assert.deepEqual(probe, { branch: false, worktree: false, dir: false, archived: null, verdict: 'none' });
  assert.ok(before.equals(fs.readFileSync(file)), 'leftover wrote the run file');
  assert.deepEqual(branchList(fx.project), ['main'], 'leftover touched the repo');

  const out = verdictOf(worktreeCmd(fx, LW_ID));

  const tree = path.join(fx.project, '.worktrees', LW_ID);
  assert.deepEqual(out, { worktree: tree, branch: `backlog/${LW_ID}`, created: 'new' });
  assert.ok(path.isAbsolute(out.worktree));
  assert.equal(gitOk(tree, 'symbolic-ref', 'HEAD').trim(), `refs/heads/backlog/${LW_ID}`);
  assert.equal(gitOk(tree, 'rev-parse', 'HEAD').trim(), gitOk(fx.project, 'rev-parse', 'main').trim(), 'the branch is cut from the base');
  assert.ok(treeListing(fx.project).includes(tree));
  assert.ok(fs.existsSync(path.join(tree, 'backlog', 'tasks', 'open', `${LW_ID}-fixture.md`)), 'the item is in the new worktree');
});

test('leftover/worktree 1b: on a --base run the new branch is cut from that base, not from main', (t) => {
  const fx = basedFixture(t);
  seedReadyTask(fx.project, LW_ID, 'Item');
  commitEverything(fx.project, 'seed');
  gitOk(fx.project, 'branch', 'feature/x');
  gitOk(fx.project, 'checkout', '-q', 'feature/x');
  fs.writeFileSync(path.join(fx.project, 'only-on-feature.txt'), 'x\n');
  commitEverything(fx.project, 'feature work');
  gitOk(fx.project, 'checkout', '-q', 'main');
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project, '--base', 'feature/x').status, 0);

  verdictOf(worktreeCmd(fx, LW_ID));

  assert.ok(fs.existsSync(path.join(fx.project, '.worktrees', LW_ID, 'only-on-feature.txt')), 'the worktree was cut from main, not from the run base');
});

test('leftover/worktree 2: a branch alone is `reattach`; worktree checks the existing branch out (extra commit present), created "reattached"', (t) => {
  const fx = leftoverFixture(t);
  seedItemBranch(fx, LW_ID);
  const tip = gitOk(fx.project, 'rev-parse', `backlog/${LW_ID}`).trim();

  const probe = verdictOf(leftover(fx, LW_ID));
  assert.deepEqual(probe, { branch: true, worktree: false, dir: false, archived: false, verdict: 'reattach' });

  const out = verdictOf(worktreeCmd(fx, LW_ID));

  const tree = path.join(fx.project, '.worktrees', LW_ID);
  assert.deepEqual(out, { worktree: tree, branch: `backlog/${LW_ID}`, created: 'reattached' });
  assert.equal(fs.readFileSync(path.join(tree, 'extra.txt'), 'utf8'), `${LW_ID} extra\n`);
  assert.equal(gitOk(tree, 'rev-parse', 'HEAD').trim(), tip, 'the branch was not recreated');
});

test('leftover/worktree 3: branch, worktree and dir all present is `resume-or-park`; worktree exits 1 and changes nothing', (t) => {
  const fx = leftoverFixture(t);
  const tree = seedItemBranch(fx, LW_ID, { keep: true });
  fs.writeFileSync(path.join(tree, 'uncommitted.txt'), 'precious\n');
  const file = runFile(fx.home, fx.project);
  const before = fs.readFileSync(file);
  const trees = treeListing(fx.project);
  const excludeFile = path.join(fx.project, '.git', 'info', 'exclude');
  const excludeBefore = fs.readFileSync(excludeFile, 'utf8');

  const probe = verdictOf(leftover(fx, LW_ID));
  assert.deepEqual(probe, { branch: true, worktree: true, dir: true, archived: null, verdict: 'resume-or-park' });

  const out = worktreeCmd(fx, LW_ID);

  assert.equal(out.status, 1);
  assert.match(out.stderr, /resume-or-park/);
  assert.ok(before.equals(fs.readFileSync(file)), 'the refusal wrote the run file');
  assert.deepEqual(treeListing(fx.project), trees);
  assert.equal(fs.readFileSync(path.join(tree, 'uncommitted.txt'), 'utf8'), 'precious\n');
  assert.equal(fs.readFileSync(excludeFile, 'utf8'), excludeBefore, 'the refusal appended to info/exclude');
});

test('leftover/worktree 4: a branch alone whose diff moves the item to done/ is `archived`; with its worktree and dir too it is `resume-or-park`', (t) => {
  const fx = leftoverFixture(t);
  const tree = seedItemBranch(fx, LW_ID, { keep: true, archive: true });

  assert.equal(verdictOf(leftover(fx, LW_ID)).verdict, 'resume-or-park', 'the archive check is not applied once the worktree exists');

  gitOk(fx.project, 'worktree', 'remove', tree);
  const probe = verdictOf(leftover(fx, LW_ID));
  assert.deepEqual(probe, { branch: true, worktree: false, dir: false, archived: true, verdict: 'archived' });

  const refused = worktreeCmd(fx, LW_ID);
  assert.equal(refused.status, 1, 'an archived branch is staged `branched` by the body, never given a worktree');
  assert.match(refused.stderr, /archived/);
  assert.equal(fs.existsSync(tree), false);
});

test('leftover/worktree 5: a directory with no branch is `park`, the detail names the directory, and worktree refuses', (t) => {
  const fx = leftoverFixture(t);
  const dir = path.join(fx.project, '.worktrees', LW_ID);
  fs.mkdirSync(dir, { recursive: true });

  const probe = verdictOf(leftover(fx, LW_ID));

  assert.equal(probe.verdict, 'park');
  assert.deepEqual([probe.branch, probe.worktree, probe.dir], [false, false, true]);
  assert.ok(probe.detail.includes(dir), `the detail must name the directory: ${probe.detail}`);
  assert.equal(worktreeCmd(fx, LW_ID).status, 1);
  assert.ok(fs.existsSync(dir), 'nothing was removed');
});

test('leftover/worktree 5b: a registered worktree whose directory is gone is `park` too, and the detail names what each probe found', (t) => {
  const fx = leftoverFixture(t);
  const tree = seedItemBranch(fx, LW_ID, { keep: true });
  fs.rmSync(tree, { recursive: true, force: true });

  const probe = verdictOf(leftover(fx, LW_ID));

  assert.equal(probe.verdict, 'park');
  assert.deepEqual([probe.branch, probe.worktree, probe.dir], [true, true, false]);
  assert.match(probe.detail, /branch/);
  assert.match(probe.detail, /worktree/);
  assert.match(probe.detail, /directory/);
});

test('leftover/worktree 6: info/exclude holding node_modules_old still gets node_modules and .worktrees/ lines, once — a second item adds neither', (t) => {
  const fx = leftoverFixture(t, { ids: [LW_ID, 'task-2'] });
  const excludeFile = path.join(fx.project, '.git', 'info', 'exclude');
  fs.appendFileSync(excludeFile, 'node_modules_old\n');

  verdictOf(worktreeCmd(fx, LW_ID));

  const lines = fs.readFileSync(excludeFile, 'utf8').split('\n');
  assert.ok(lines.includes('node_modules_old'), 'an existing line was lost');
  assert.equal(lines.filter((l) => l === 'node_modules').length, 1, 'a substring match skipped the node_modules append');
  assert.equal(lines.filter((l) => l === '.worktrees/').length, 1);
  assert.ok(!lines.includes('node_modules/'), 'a trailing slash cannot match the symlink a worktree gets');
  const afterFirst = fs.readFileSync(excludeFile, 'utf8');

  verdictOf(worktreeCmd(fx, 'task-2'));

  assert.equal(fs.readFileSync(excludeFile, 'utf8'), afterFirst, 'a second worktree run appended again');
});

test('leftover/worktree 7: the exclude lines land in the main repo’s .git/info/exclude, not in the worktree’s own gitdir', (t) => {
  const fx = leftoverFixture(t);

  verdictOf(worktreeCmd(fx, LW_ID));

  const main = fs.readFileSync(path.join(fx.project, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.ok(main.includes('.worktrees/') && main.includes('node_modules'));
  const own = path.join(fx.project, '.git', 'worktrees', LW_ID, 'info', 'exclude');
  assert.equal(fs.existsSync(own), false, 'a per-worktree exclude was written');
  assert.equal(gitOk(fx.project, 'status', '--porcelain').includes('.worktrees'), false, '.worktrees/ shows up in git status');
});

test('leftover/worktree 8: an item that is not committed on the base parks with the post-checkout template, stage parked, worktree and branch kept', (t) => {
  const fx = leftoverFixture(t);
  gitOk(fx.project, 'rm', '-q', '-r', 'backlog');
  gitOk(fx.project, 'commit', '-q', '-m', 'item no longer on base');
  // Present in the MAIN tree, uncommitted: the state grooming leaves. A probe run from the project root would find it, so
  // only a probe whose cwd is the new worktree parks here.
  seedReadyTask(fx.project, LW_ID, `Item ${LW_ID}`);

  const out = verdictOf(worktreeCmd(fx, LW_ID));

  const detail = `${LW_ID} is not present in the worktree checked out from main — commit backlog/ on main, then re-run`;
  assert.equal(out.verdict, 'park');
  assert.equal(out.detail, detail);
  const state = readRunJson(fx);
  assert.equal(stageOf(fx), 'parked');
  assert.deepEqual(state.attention.filter((a) => a.id === LW_ID).map((a) => [a.kind, a.detail]), [['parked', detail]]);
  const tree = path.join(fx.project, '.worktrees', LW_ID);
  assert.ok(treeListing(fx.project).includes(tree), 'the worktree must be kept');
  assert.ok(branchList(fx.project).includes(`backlog/${LW_ID}`), 'the branch must be kept');
});

test('leftover/worktree 5c: when the archive diff fails the park detail is fixed wording, and git\'s own line rides in gitError', (t) => {
  const fx = basedFixture(t);
  seedReadyTask(fx.project, LW_ID, 'Item');
  commitEverything(fx.project, 'seed');
  gitOk(fx.project, 'branch', 'feature/x');
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project, '--base', 'feature/x').status, 0);
  seedItemBranch(fx, LW_ID);
  gitOk(fx.project, 'branch', '-D', 'feature/x');

  const probe = verdictOf(leftover(fx, LW_ID));

  assert.equal(probe.verdict, 'park');
  assert.equal(probe.archived, null);
  assert.equal(probe.detail, `could not tell whether backlog/${LW_ID} is a finished item: the comparison with feature/x failed`);
  assert.match(probe.gitError, /feature\/x|fatal|unknown revision/);
  assert.ok(!probe.detail.includes(probe.gitError), 'git\'s line must not be inside the detail the body puts on a command line');
  assert.equal(worktreeCmd(fx, LW_ID).status, 1);
});

test('leftover/worktree 9: a tracker project has no item file, so no presence probe runs and nothing parks', async (t) => {
  const fx = trackerFixture(t);
  fs.writeFileSync(path.join(fx.project, 'README.md'), 'tracker fixture\n');
  commitEverything(fx.project, 'seed');
  const gate = gateRoutes([apiItem(fx.project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY });
  const { out: init } = await withApi(gate, (port) => runApi(fx.project, fx.home, port, 'init', '--project', fx.project));
  assert.equal(init.status, 0, init.stderr);

  // `init` above ran as `sess-test` (runApi pins it), so this call must be the same driver.
  const out = verdictOf(runAs('sess-test', fx.project, fx.home, 'worktree', '3'));

  assert.equal(out.created, 'new');
  assert.equal(out.verdict, undefined, 'a tracker worktree must not park for a missing item file');
  assert.ok(treeListing(fx.project).includes(path.join(fx.project, '.worktrees', '3')));
  assert.deepEqual(readRunJson(fx).attention ?? [], []);
});

test('leftover/worktree 10: no run exits 3, a foreign lease 7, a usage error or an unknown id 1 — and none of them touches the run file or git', (t) => {
  for (const cmd of ['leftover', 'worktree']) {
    const bare = basedFixture(t);
    assert.equal(run(bare.project, bare.home, cmd, LW_ID).status, 3, `${cmd}: no run`);
    assert.equal(fs.existsSync(runFile(bare.home, bare.project)), false);

    const fx = leftoverFixture(t);
    const file = runFile(fx.home, fx.project);
    const before = fs.readFileSync(file);
    const trees = treeListing(fx.project);
    const branches = branchList(fx.project);
    assert.equal(run(fx.project, fx.home, cmd).status, 1, `${cmd}: no id is a usage error`);
    assert.equal(run(fx.project, fx.home, cmd, LW_ID, '--bogus').status, 1, `${cmd}: an unknown flag is a usage error`);
    assert.equal(run(fx.project, fx.home, cmd, 'task-99').status, 1, `${cmd}: an unknown id`);
    assert.ok(before.equals(fs.readFileSync(file)));
    assert.deepEqual(treeListing(fx.project), trees);
    assert.deepEqual(branchList(fx.project), branches);

    const led = basedFixture(t);
    seedReadyTask(led.project, LW_ID, 'Item');
    commitEverything(led.project, 'seed');
    assert.equal(runAs('sess-a', led.project, led.home, 'init', '--project', led.project).status, 0);
    const ledBefore = fs.readFileSync(runFile(led.home, led.project));
    const ledTrees = treeListing(led.project);
    assert.equal(runAs('sess-b', led.project, led.home, cmd, LW_ID).status, 7, `${cmd}: foreign lease`);
    assert.ok(ledBefore.equals(fs.readFileSync(runFile(led.home, led.project))));
    assert.deepEqual(treeListing(led.project), ledTrees);
  }
});

// --- cleanup: what follows a merge or a branch-mode stop ---------------------
//
// SKILL.md §9's tail ran, as prose, a plain `worktree remove` and its two-way exit-code split, `branch -d` from the base tree
// and the runner-fix `diff HEAD^1 HEAD`. `cleanup <id>` runs all three. The cases below ARE that behaviour, against real temp
// repos, and every one that pins a tree builds the fixture so the project root would give a DIFFERENT answer than the right tree.
//
// RETIRED, each replaced by the case named in the same commit:
//   - '§9 names both worktree-removal failures as distinct cases, and the park template sits under the clean-check one'
//     -> cleanup 2 (the clean-check refusal: exactly the template, stage unmoved) and cleanup 3a/3b (the classification, on the
//     recorded 128 and 255 pairs) and 3c (the delete that cannot finish, run for real).
//   - 'the removal split has exactly one home, and the other two cleanups still delegate to it' -> the same cases: the split
//     now has one home, `classifyWorktreeRemove`, and the body no longer states it at all.
//   - 'exactly one `rm -rf` is executable in SKILL.md ...' -> cleanup 3b/3c: the one destructive verb is `finishFailedDelete`,
//     reached only through `classifyWorktreeRemove` saying 'failed-delete', and it is exercised on a real directory.
//   - 'the finished-cleanup branch pages nobody' (first assertion only; the `worktree prune` guard stays) -> cleanup 3b/3c: a
//     directory that is gone records nothing, and one that survives records an attention entry.
//   - 'no branch delete in SKILL.md runs in the project root' and "the runner-fix pickup diffs the merge commit ..." -> cleanup 1,
//     4 and 6-7, which run both commands, and cleanup 10, which runs them on a `--base` run where the root gives the wrong answer.

const CL_ID = 'task-1';
const RUNNER_SKILL = 'skills/backlog-orchestrate/SKILL.md';
const RUNNER_CLI = 'skills/backlog-orchestrate/tools/orchestrate.mjs';

function cleanupCmd(fx, ...args) {
  return run(fx.project, fx.home, 'cleanup', ...args);
}

/**
 * A `merge-check`-ed item on a real merge: the item branch also commits `touches` (any extra paths), `merge-check` records the
 * base tree, the branch is merged into that tree with `--no-ff`, and the item is staged `merged`. `merge: false` leaves the
 * branch unmerged (a refusal case); `check: false` skips `merge-check`, so the run file carries no `baseTree`.
 */
function mergedFixture(t, { base = 'main', touches = [], merge = true, check = true } = {}) {
  const fx = mergeCheckFixture(t, { base });
  const worktree = path.join(fx.project, '.worktrees', CL_ID);
  for (const rel of touches) {
    fs.mkdirSync(path.dirname(path.join(worktree, rel)), { recursive: true });
    fs.writeFileSync(path.join(worktree, rel), `${rel} changed\n`);
  }
  if (touches.length > 0) {
    gitOk(worktree, 'add', '-A');
    gitOk(worktree, 'commit', '-q', '-m', 'touch runner files');
  }
  fx.baseTree = fx.project;
  if (check) {
    const verdict = JSON.parse(mergeCheck(fx, CL_ID).stdout.trim());
    assert.equal(verdict.verdict, 'merge');
    fx.baseTree = verdict.baseTree;
  }
  if (merge) gitOk(fx.baseTree, 'merge', '--no-ff', '--no-edit', `backlog/${CL_ID}`);
  assert.equal(run(fx.project, fx.home, 'stage', CL_ID, 'merged').status, 0);
  return fx;
}

const cleanupOut = (out) => {
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim());
};

test('cleanup 1: a clean worktree after a merge — removed ok, the directory is gone, the branch is deleted, no runner fix, stage still merged', (t) => {
  const fx = mergedFixture(t);

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.deepEqual(out, { removed: 'ok', branchDeleted: true, runnerFix: { skill: false, cli: false } });
  assert.equal(fs.existsSync(path.join(fx.project, '.worktrees', CL_ID)), false);
  assert.ok(!treeListing(fx.project).some((p) => p.endsWith(`/.worktrees/${CL_ID}`)));
  assert.deepEqual(branchList(fx.project), ['main']);
  assert.equal(stageOf(fx), 'merged');
  assert.deepEqual(readRunJson(fx).attention, []);
});

test('cleanup 1b: ignored build output alone removes cleanly and takes the output with it — nothing recorded', (t) => {
  const fx = mergedFixture(t);
  const tree = path.join(fx.project, '.worktrees', CL_ID);
  // `dist/` is ignored through the repo's own info/exclude, the way the project's `.gitignore` ignores a real build directory.
  fs.appendFileSync(path.join(fx.project, '.git', 'info', 'exclude'), 'dist/\n');
  fs.mkdirSync(path.join(tree, 'dist'));
  fs.writeFileSync(path.join(tree, 'dist', 'bundle.js'), 'x'.repeat(1000));

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.equal(out.removed, 'ok');
  assert.equal(fs.existsSync(tree), false);
  assert.deepEqual(readRunJson(fx).attention, []);
});

test('cleanup 2: an untracked file in the worktree — leftovers, the §9 template verbatim, stage still merged, nothing deleted, branch kept', (t) => {
  const fx = mergedFixture(t);
  const tree = path.join(fx.project, '.worktrees', CL_ID);
  fs.writeFileSync(path.join(tree, 'never-committed.txt'), 'scratch\n');

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.deepEqual(out, { removed: 'leftovers', branchDeleted: false, runnerFix: { skill: false, cli: false } });
  assert.deepEqual(readRunJson(fx).attention, [
    { id: CL_ID, kind: 'parked', detail: `merged; worktree ${tree} would not remove cleanly — uncommitted leftovers to look at` }
  ]);
  assert.equal(stageOf(fx), 'merged', 'a park here would tell the board an item that merged did not');
  assert.equal(fs.readFileSync(path.join(tree, 'never-committed.txt'), 'utf8'), 'scratch\n', 'the leftover was deleted');
  assert.ok(treeListing(fx.project).includes(tree), 'the worktree was unregistered');
  assert.ok(branchList(fx.project).includes(`backlog/${CL_ID}`), 'the branch was deleted over an unfinished worktree');
});

test('cleanup 2b: the leftovers entry says `branched` on a branch-mode item, and the branch is never touched', (t) => {
  const fx = mergeCheckFixture(t);
  const tree = path.join(fx.project, '.worktrees', CL_ID);
  fs.writeFileSync(path.join(tree, 'never-committed.txt'), 'scratch\n');
  assert.equal(run(fx.project, fx.home, 'stage', CL_ID, 'branched').status, 0);

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.equal(out.removed, 'leftovers');
  assert.deepEqual(readRunJson(fx).attention, [
    { id: CL_ID, kind: 'parked', detail: `branched; worktree ${tree} would not remove cleanly — uncommitted leftovers to look at` }
  ]);
  assert.equal(stageOf(fx), 'branched');
});

test("cleanup 3a (classification only): git's two recorded refusals are told apart by their message, and the exit status decides nothing", () => {
  // The pair T:6303's comment records for both real occurrences: the clean check refuses with 128 and deletes nothing; a failed
  // recursive delete exits 255 AFTER the clean check passed and AFTER the admin entry is gone. Opposite responses, so they must
  // never collapse into one.
  const cleanCheck = "fatal: '/p/.worktrees/task-1' contains modified or untracked files, use --force to delete it\n";
  const failedDelete = "error: failed to delete '/p/.worktrees/task-1': Directory not empty\n";
  assert.equal(orch.classifyWorktreeRemove({ status: 128, stderr: cleanCheck }), 'leftovers');
  assert.equal(orch.classifyWorktreeRemove({ status: 255, stderr: failedDelete }), 'failed-delete');
  assert.equal(orch.classifyWorktreeRemove({ status: 0, stderr: '' }), 'ok');
  // The message is the evidence: swap the codes and the answers do not move.
  assert.equal(orch.classifyWorktreeRemove({ status: 255, stderr: cleanCheck }), 'leftovers');
  assert.equal(orch.classifyWorktreeRemove({ status: 128, stderr: failedDelete }), 'failed-delete');
  // Anything git says that this tool has no response for gets no licence to delete.
  assert.equal(orch.classifyWorktreeRemove({ status: 128, stderr: "fatal: '/p/.worktrees/task-1' is not a working tree\n" }), 'other');
  assert.equal(orch.classifyWorktreeRemove({ status: 1, stderr: '' }), 'other');
});

test('cleanup 3b (remove-then-verify, real directories): a finished delete is proved by the path being gone; a survivor is reported with its error', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-finish-')));
  t.after(() => {
    try {
      fs.chmodSync(path.join(dir, 'locked', 'inner'), 0o755);
    } catch {
      // the locked case did not run (root)
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const half = path.join(dir, 'half-deleted');
  fs.mkdirSync(path.join(half, 'node', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(half, 'node', 'deep', 'left-behind.txt'), 'x\n');

  assert.deepEqual(orch.finishFailedDelete(half), { gone: true, error: null });
  assert.equal(fs.existsSync(half), false);
  assert.deepEqual(orch.finishFailedDelete(half), { gone: true, error: null }, 'an already-absent path is already finished');

  if (process.getuid?.() === 0) return; // root ignores the 0555 bit the survivor needs
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(locked, 'inner', 'file.txt'), 'x\n');
  fs.chmodSync(path.join(locked, 'inner'), 0o555);
  const survivor = orch.finishFailedDelete(locked);
  assert.equal(survivor.gone, false);
  assert.match(survivor.error, /EACCES|EPERM|permission/i);
});

test('cleanup 3c: a delete git cannot finish, run for real — unregistered, the directory survives, the entry quotes the error, the branch still goes', (t) => {
  if (process.getuid?.() === 0) return; // root ignores the 0555 bit that makes git's delete fail
  const fx = mergedFixture(t, { touches: ['locked/file.txt'] });
  const tree = path.join(fx.project, '.worktrees', CL_ID);
  // Tracked and unmodified, so git's clean check passes; the 0555 directory is what the delete cannot finish — and what `rm`
  // cannot finish either, which is the "survivor" half of the rule. (`git worktree remove` does the same to a real race.)
  // Unlocked in a `finally`, not an `after` hook: the fixture's own cleanup was registered first and would run first.
  fs.chmodSync(path.join(tree, 'locked'), 0o555);
  try {
    const out = cleanupOut(cleanupCmd(fx, CL_ID));

    assert.equal(out.removed, 'failed');
    assert.equal(fs.existsSync(path.join(tree, 'locked', 'file.txt')), true, 'the survivor is still there');
    assert.ok(!treeListing(fx.project).includes(tree), 'git unregistered it first, so nothing is still registered');
    const attention = readRunJson(fx).attention;
    assert.equal(attention.length, 1);
    assert.equal(attention[0].id, CL_ID);
    assert.equal(attention[0].kind, 'parked');
    assert.ok(attention[0].detail.startsWith(`merged; worktree ${tree} would not remove`), attention[0].detail);
    assert.match(attention[0].detail, /EACCES|EPERM|permission/i, 'the entry does not quote the error');
    assert.equal(stageOf(fx), 'merged');
    assert.equal(out.branchDeleted, true, 'the registration is gone, so the merged branch is deletable');
  } finally {
    fs.chmodSync(path.join(tree, 'locked'), 0o755);
  }
});

test('cleanup 4: a branch with a commit the base lacks — branchDeleted false, branchMergedIntoBase false, the branch survives, nothing paged', (t) => {
  const fx = mergedFixture(t, { merge: false });

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.equal(out.removed, 'ok');
  assert.equal(out.branchDeleted, false);
  assert.equal(out.branchMergedIntoBase, false);
  assert.match(out.branchError, /not fully merged/, "git's own line rides in its own field");
  assert.ok(branchList(fx.project).includes(`backlog/${CL_ID}`));
  assert.deepEqual(readRunJson(fx).attention, [], "reading the refusal is the body's call, not an attention entry");
});

test('cleanup 4b: a refusal that --merged does not back up is reported as merged-into-base true — the misaimed-command reading', (t) => {
  const fx = mergedFixture(t);
  // A held ref lock makes `branch -d` fail on a branch that IS in the base, so the two answers disagree, which is exactly what the
  // `branchMergedIntoBase` field exists to expose.
  fs.writeFileSync(path.join(fx.project, '.git', 'refs', 'heads', 'backlog', `${CL_ID}.lock`), '');

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.equal(out.branchDeleted, false);
  assert.equal(out.branchMergedIntoBase, true);
});

test('cleanup 5: branch mode — the worktree goes, the branch stays, no `branch -d` is attempted and no runner-fix diff is read', (t) => {
  const fx = mergeCheckFixture(t);
  // The base's last commit touches SKILL.md, so a diff that DID run in branch mode would report `skill: true` off it.
  fs.mkdirSync(path.join(fx.project, 'skills', 'backlog-orchestrate'), { recursive: true });
  fs.writeFileSync(path.join(fx.project, RUNNER_SKILL), 'a runner edit on the base\n');
  commitEverything(fx.project, 'edit the runner on main');
  assert.equal(run(fx.project, fx.home, 'stage', CL_ID, 'branched').status, 0);
  assert.equal(readRunJson(fx).baseTree, undefined, 'branch mode never runs merge-check');

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.deepEqual(out, { removed: 'ok', branchDeleted: false, runnerFix: { skill: false, cli: false } });
  assert.equal(fs.existsSync(path.join(fx.project, '.worktrees', CL_ID)), false);
  assert.ok(branchList(fx.project).includes(`backlog/${CL_ID}`), 'the branch is the deliverable');
  assert.equal(stageOf(fx), 'branched');
});

test('cleanup 6: a merge commit that touches SKILL.md — runnerFix.skill true, cli false', (t) => {
  const fx = mergedFixture(t, { touches: [RUNNER_SKILL] });

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.deepEqual(out.runnerFix, { skill: true, cli: false });
});

test('cleanup 7: a merge commit that touches only orchestrate.mjs — skill false, cli true (each is its own flag)', (t) => {
  const fx = mergedFixture(t, { touches: [RUNNER_CLI] });

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.deepEqual(out.runnerFix, { skill: false, cli: true });
});

test('cleanup 7b: both files, and look-alike paths that must not match — the comparison is exact', (t) => {
  const both = mergedFixture(t, { touches: [RUNNER_SKILL, RUNNER_CLI] });
  assert.deepEqual(cleanupOut(cleanupCmd(both, CL_ID)).runnerFix, { skill: true, cli: true });

  const lookalikes = mergedFixture(t, {
    touches: ['skills/backlog-orchestrate/SKILL.md.bak', 'skills/backlog-execute/SKILL.md', 'docs/skills/backlog-orchestrate/tools/orchestrate.mjs']
  });
  assert.deepEqual(cleanupOut(cleanupCmd(lookalikes, CL_ID)).runnerFix, { skill: false, cli: false });
});

test('cleanup 8: stage inspecting — exit 1, and nothing is removed', (t) => {
  const fx = mergeCheckFixture(t);
  assert.equal(run(fx.project, fx.home, 'stage', CL_ID, 'inspecting').status, 0);
  const before = fs.readFileSync(runFile(fx.home, fx.project), 'utf8');

  const out = cleanupCmd(fx, CL_ID);

  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /inspecting/);
  assert.equal(fs.existsSync(path.join(fx.project, '.worktrees', CL_ID)), true);
  assert.ok(branchList(fx.project).includes(`backlog/${CL_ID}`));
  assert.equal(fs.readFileSync(runFile(fx.home, fx.project), 'utf8'), before, 'the run file changed');
});

test('cleanup 9: merge mode with no recorded base tree — exit 1, the worktree and the branch untouched (no fallback to the project root)', (t) => {
  const fx = mergedFixture(t, { check: false });
  assert.equal(readRunJson(fx).baseTree, undefined);

  const out = cleanupCmd(fx, CL_ID);

  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /base tree/);
  assert.equal(fs.existsSync(path.join(fx.project, '.worktrees', CL_ID)), true, 'the worktree was removed before the refusal');
  assert.ok(branchList(fx.project).includes(`backlog/${CL_ID}`));
  assert.equal(stageOf(fx), 'merged');
  assert.deepEqual(readRunJson(fx).attention, []);
});

test('cleanup 9b: a recorded base tree that no longer exists — exit 1, nothing removed', (t) => {
  const fx = mergedFixture(t, { base: 'feature/x' });
  gitOk(fx.project, 'worktree', 'remove', '--force', fx.baseTree);
  assert.equal(fs.existsSync(fx.baseTree), false);

  const out = cleanupCmd(fx, CL_ID);

  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /no longer exists/);
  assert.equal(fs.existsSync(path.join(fx.project, '.worktrees', CL_ID)), true);
  assert.ok(branchList(fx.project).includes(`backlog/${CL_ID}`));
});

test('cleanup 10: a --base run whose base tree is .worktrees/_base-…, not the project root — branch -d and the runner-fix diff both read that tree', (t) => {
  const fx = mergedFixture(t, { base: 'feature/x', touches: [RUNNER_SKILL] });
  const baseTree = path.join(fx.project, '.worktrees', '_base-feature-x');
  assert.equal(fx.baseTree, baseTree, 'merge-check did not create the base worktree this case is about');
  // The fixture's whole point: the project root is on `main`, which the merge never touched. Run there, `branch -d` refuses a
  // branch that merged perfectly, and `diff HEAD^1 HEAD` reads the root's own last commit (which does not touch SKILL.md).
  assert.equal(gitOk(fx.project, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
  assert.equal(spawnSync('git', ['-C', fx.project, 'branch', '--merged', 'main'], { encoding: 'utf8' }).stdout.includes(`backlog/${CL_ID}`), false);
  assert.ok(!gitOk(fx.project, 'diff', '--name-only', 'HEAD^1', 'HEAD').split('\n').includes(RUNNER_SKILL));

  const out = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.equal(out.removed, 'ok');
  assert.equal(out.branchDeleted, true, 'the delete ran in the project root, where main lacks the merge');
  assert.deepEqual(out.runnerFix, { skill: true, cli: false }, 'the diff read the project root, not the merge commit');
  assert.ok(treeListing(fx.project).includes(baseTree), 'cleanup removed a base worktree it has no authority over');
  assert.equal(fs.existsSync(path.join(fx.project, '.worktrees', CL_ID)), false);
});

test('cleanup 11: a second call over a finished cleanup is a no-op — removed ok, the branch already gone, nothing paged', (t) => {
  const fx = mergedFixture(t);
  cleanupOut(cleanupCmd(fx, CL_ID));

  const again = cleanupOut(cleanupCmd(fx, CL_ID));

  assert.deepEqual(again, { removed: 'ok', branchDeleted: true, runnerFix: { skill: false, cli: false } });
  assert.deepEqual(readRunJson(fx).attention, []);
});

test('cleanup 12: argv and item refusals — exit 1 with nothing written', (t) => {
  const fx = mergedFixture(t);
  const before = fs.readFileSync(runFile(fx.home, fx.project), 'utf8');

  for (const args of [[], ['--force'], [CL_ID, 'extra'], ['task-99']]) {
    const out = cleanupCmd(fx, ...args);
    assert.equal(out.status, 1, `cleanup ${args.join(' ')}: ${out.stdout}${out.stderr}`);
  }
  assert.equal(fs.readFileSync(runFile(fx.home, fx.project), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(fx.project, '.worktrees', CL_ID)), true);
});

test('cleanup never forces a removal and never merges or pushes — the tool runs no `--force`, `git merge` or `git push` of its own on this path', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const start = source.indexOf('function cmdCleanup(');
  const body = source.slice(start, source.indexOf('\nconst ASSUME_USAGE', start)).replace(/\/\/.*$/gm, '');
  assert.ok(body.includes("'worktree', 'remove', target"), 'the plain removal is no longer where this guard looks');
  assert.doesNotMatch(body, /--force|'-D'|'merge'|'push'|'prune'|'reset'/);
});

/* --- inspect: §5's four steps as one call ------------------------------------------------------------------------
   `stage <id> inspecting`, `usage`, `denials` and the item-file location check, in that order. The tests pin the three things
   a body-prose version could not: the file is read in the WORKTREE (the main tree carries the opposite state in every case, so
   a wrong tree is a red test), a refusal writes nothing, and a transcript that cannot be read is exit 1 rather than a clean run. */

const INSPECT_ID = 'task-5';

function inspectLogs(fx) {
  return path.join(fx.home, encodeURIComponent(fx.project), 'logs');
}

// A files-project run with a real linked worktree for `task-5`, a transcript at `<dir>/logs/task-5.jsonl`, and the item file in
// the worktree in the requested shape. The MAIN tree's copy is always put in the opposite shape, so reading it gives the wrong answer.
function inspectFixture(t, { state, outcome, transcript = STREAM_USAGE }) {
  const fx = orchFixture(t);
  seedReadyTask(fx.project, INSPECT_ID, 'Some task');
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project).status, 0);
  fx.worktree = addWorktree(fx.project, INSPECT_ID, `backlog/${INSPECT_ID}`);
  fx.logs = inspectLogs(fx);
  fs.mkdirSync(fx.logs, { recursive: true });
  if (transcript !== null) fs.copyFileSync(transcript, path.join(fx.logs, `${INSPECT_ID}.jsonl`));

  const shape = (tree, wantState, wantOutcome) => {
    const open = path.join(tree, 'backlog', 'tasks', 'open', `${INSPECT_ID}-fixture.md`);
    const done = path.join(tree, 'backlog', 'tasks', 'done', `${INSPECT_ID}-fixture.md`);
    if (wantState === 'done') {
      fs.mkdirSync(path.dirname(done), { recursive: true });
      fs.renameSync(open, done);
    }
    if (wantOutcome) fs.appendFileSync(wantState === 'done' ? done : open, '\n## Outcome\n\nVerification: pnpm test — 12 passed\n');
  };
  shape(fx.worktree, state, outcome);
  // The opposite shape in the main tree, so a read of the wrong tree is caught.
  shape(fx.project, state === 'done' ? 'open' : 'done', !outcome);
  return fx;
}

function inspectCmd(fx, ...args) {
  return run(fx.project, fx.home, 'inspect', ...args);
}

function inspectOut(out) {
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  return JSON.parse(out.stdout.trim());
}

test('inspect 1: a done item with an Outcome — item "done", the worktree path, usage recorded, no denials, stage inspecting', (t) => {
  const fx = inspectFixture(t, { state: 'done', outcome: true });

  const result = inspectOut(inspectCmd(fx, INSPECT_ID));

  assert.equal(result.item, 'done');
  assert.equal(result.itemPath, path.join(fx.worktree, 'backlog', 'tasks', 'done', `${INSPECT_ID}-fixture.md`));
  assert.equal(result.usage, 'recorded');
  assert.equal(result.denials, 0);
  const queued = queueItem(fx.home, fx.project, INSPECT_ID);
  assert.equal(queued.stage, 'inspecting');
  assert.equal(queued.usage.length, 1);
  assert.equal(queued.usage[0].kind, 'execute');
});

test('inspect 2: an open item with an Outcome — "open-with-outcome" (execute\'s own failure path)', (t) => {
  const fx = inspectFixture(t, { state: 'open', outcome: true });

  const result = inspectOut(inspectCmd(fx, INSPECT_ID));

  assert.equal(result.item, 'open-with-outcome');
  assert.equal(result.itemPath, path.join(fx.worktree, 'backlog', 'tasks', 'open', `${INSPECT_ID}-fixture.md`));
});

test('inspect 3: an open item with no Outcome, and a done item with none — both "no-outcome"', (t) => {
  const open = inspectFixture(t, { state: 'open', outcome: false });
  assert.equal(inspectOut(inspectCmd(open, INSPECT_ID)).item, 'no-outcome');

  const done = inspectFixture(t, { state: 'done', outcome: false });
  const result = inspectOut(inspectCmd(done, INSPECT_ID));
  assert.equal(result.item, 'no-outcome', 'a lifecycle move with no Outcome is not execute succeeding on its own terms');
});

test('inspect 4: no worktree directory at all — "no-outcome" with a null itemPath, and nothing else is refused', (t) => {
  const fx = inspectFixture(t, { state: 'done', outcome: true });
  assert.equal(spawnSync('git', ['-C', fx.project, 'worktree', 'remove', '--force', fx.worktree], { encoding: 'utf8' }).status, 0);

  const result = inspectOut(inspectCmd(fx, INSPECT_ID));

  assert.equal(result.item, 'no-outcome');
  assert.equal(result.itemPath, null);
});

test('inspect 5: a transcript with a permission denial — denials 1, the refused call is listed, exit 0', (t) => {
  const fx = inspectFixture(t, { state: 'done', outcome: true, transcript: STREAM_DENIAL });

  const result = inspectOut(inspectCmd(fx, INSPECT_ID));

  assert.equal(result.denials, 1);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].tool_name, 'Bash');
});

test('inspect 6: a transcript with no result event — usage "no-result", exit 0, nothing recorded, the stage still written', (t) => {
  const fx = inspectFixture(t, { state: 'open', outcome: false, transcript: STREAM_NO_RESULT });

  const result = inspectOut(inspectCmd(fx, INSPECT_ID));

  assert.equal(result.usage, 'no-result');
  assert.equal(result.denials, 0);
  const queued = queueItem(fx.home, fx.project, INSPECT_ID);
  assert.equal(queued.usage, undefined, 'a killed session must record nothing');
  assert.equal(queued.stage, 'inspecting');
});

test('inspect 7: an unreadable transcript — exit 1 naming the file, and nothing written (not even the stage)', (t) => {
  // An EXPLICITLY named transcript that is missing: the caller said which file, so its absence is a problem, never a clean run.
  const missing = inspectFixture(t, { state: 'done', outcome: true, transcript: null });
  const before = fs.readFileSync(runFile(missing.home, missing.project), 'utf8');
  const out = inspectCmd(missing, INSPECT_ID, '--jsonl', path.join(missing.logs, `${INSPECT_ID}-retry-1.jsonl`));
  assert.equal(out.status, 1, `${out.stdout}${out.stderr}`);
  assert.match(out.stderr, /could not be read/);
  assert.equal(fs.readFileSync(runFile(missing.home, missing.project), 'utf8'), before, 'the run file changed');

  // A directory where the DEFAULT transcript should be: it exists but cannot be read — never a clean run either.
  const dirAt = inspectFixture(t, { state: 'done', outcome: true, transcript: null });
  fs.mkdirSync(path.join(dirAt.logs, `${INSPECT_ID}.jsonl`));
  const beforeDir = fs.readFileSync(runFile(dirAt.home, dirAt.project), 'utf8');
  assert.equal(inspectCmd(dirAt, INSPECT_ID).status, 1);
  assert.equal(fs.readFileSync(runFile(dirAt.home, dirAt.project), 'utf8'), beforeDir);
});

test('inspect 7b: no default transcript and no --jsonl — a reattached item: stage inspecting, usage "no-transcript", denials null, item still read', (t) => {
  // `init` archived the previous run's logs/, so on a reattach the default file is simply not there. The item is seeded with an Outcome so
  // `item: "done"` can only come from the worktree read — a version that bailed before reading the item would fail here.
  const fx = inspectFixture(t, { state: 'done', outcome: true, transcript: null });
  const result = inspectOut(inspectCmd(fx, INSPECT_ID));

  assert.equal(result.usage, 'no-transcript');
  assert.equal(result.denials, null);
  assert.equal(result.refused, null);
  assert.equal(result.item, 'done');
  assert.equal(result.itemPath, path.join(fx.worktree, 'backlog', 'tasks', 'done', `${INSPECT_ID}-fixture.md`));
  const queued = queueItem(fx.home, fx.project, INSPECT_ID);
  assert.equal(queued.stage, 'inspecting');
  assert.equal((queued.usage ?? []).length, 0, 'usage was recorded with no transcript');
});

test('inspect 7c: no default transcript, but a stop request — still exit 10 and nothing written', (t) => {
  const fx = inspectFixture(t, { state: 'done', outcome: true, transcript: null });
  effectiveStop(fx.home, fx.project);
  const before = fs.readFileSync(runFile(fx.home, fx.project));
  assert.equal(inspectCmd(fx, INSPECT_ID).status, 10);
  assert.ok(before.equals(fs.readFileSync(runFile(fx.home, fx.project))), 'run.json was modified after the refusing step');
});

test('inspect 8: a stop request — exit 10 from the stage step it composes, and nothing is written', (t) => {
  const fx = inspectFixture(t, { state: 'done', outcome: true });
  effectiveStop(fx.home, fx.project);
  const before = fs.readFileSync(runFile(fx.home, fx.project));

  const out = inspectCmd(fx, INSPECT_ID);

  assert.equal(out.status, 10, `${out.stdout}${out.stderr}`);
  assert.match(out.stderr, /stop was requested/);
  assert.ok(before.equals(fs.readFileSync(runFile(fx.home, fx.project))), 'run.json was modified after the refusing step');
});

test("inspect 9: refusals — another session's lease is 7, an unknown item and bad argv are 1, each with nothing written", (t) => {
  const fx = orchFixture(t);
  seedReadyTask(fx.project, INSPECT_ID, 'Some task');
  assert.equal(runAs('sess-a', fx.project, fx.home, 'init', '--project', fx.project).status, 0);
  fx.logs = inspectLogs(fx);
  fs.mkdirSync(fx.logs, { recursive: true });
  fs.copyFileSync(STREAM_USAGE, path.join(fx.logs, `${INSPECT_ID}.jsonl`));
  const before = fs.readFileSync(runFile(fx.home, fx.project), 'utf8');

  const leased = runAs('sess-b', fx.project, fx.home, 'inspect', INSPECT_ID);
  assert.equal(leased.status, 7, leased.stderr);
  assert.match(leased.stderr, /sess-a/);

  for (const args of [[], ['--jsonl', 'x'], [INSPECT_ID, 'extra'], ['task-99'], [INSPECT_ID, '--jsonl'], [INSPECT_ID, '--jsonl', path.join(fx.logs, 'other-1.jsonl')]]) {
    const out = runAs('sess-a', fx.project, fx.home, 'inspect', ...args);
    assert.equal(out.status, 1, `inspect ${args.join(' ')}: ${out.stdout}${out.stderr}`);
  }
  assert.equal(fs.readFileSync(runFile(fx.home, fx.project), 'utf8'), before);
});

test("inspect 10: --jsonl names a retry transcript — usage is recorded in the retry slot, beside the first session's", (t) => {
  const fx = inspectFixture(t, { state: 'open', outcome: true });
  assert.equal(run(fx.project, fx.home, 'usage', INSPECT_ID, '--jsonl', path.join(fx.logs, `${INSPECT_ID}.jsonl`)).status, 0);
  const retry = path.join(fx.logs, `${INSPECT_ID}-retry-1.jsonl`);
  fs.copyFileSync(STREAM_USAGE, retry);

  const result = inspectOut(inspectCmd(fx, INSPECT_ID, '--jsonl', retry));

  assert.equal(result.usage, 'recorded');
  const kinds = queueItem(fx.home, fx.project, INSPECT_ID).usage.map((u) => `${u.kind}#${u.loop ?? ''}`);
  assert.deepEqual(kinds, ['execute#', 'retry#1']);
});

test('inspect 11: the same entry `usage` would have written, and the same count `denials` would have printed', (t) => {
  const viaInspect = inspectFixture(t, { state: 'done', outcome: true, transcript: STREAM_DENIAL });
  const viaParts = inspectFixture(t, { state: 'done', outcome: true, transcript: STREAM_DENIAL });
  const strip = (entry) => ({ ...entry, endedAt: undefined });

  const result = inspectOut(inspectCmd(viaInspect, INSPECT_ID));
  const transcript = path.join(viaParts.logs, `${INSPECT_ID}.jsonl`);
  const denials = JSON.parse(run(viaParts.project, viaParts.home, 'denials', '--jsonl', transcript).stdout);
  assert.equal(run(viaParts.project, viaParts.home, 'usage', INSPECT_ID, '--jsonl', transcript).status, 0);

  assert.equal(result.denials, denials.count);
  assert.deepEqual(
    queueItem(viaInspect.home, viaInspect.project, INSPECT_ID).usage.map(strip),
    queueItem(viaParts.home, viaParts.project, INSPECT_ID).usage.map(strip)
  );
});

// --- inspect, tracker project: the outcome file is the evidence, and the snapshot is written in the same call -----------

async function trackerInspect(t, outcomeText) {
  const { home, project } = trackerFixture(t);
  const dir = path.join(home, encodeURIComponent(project));
  const { out } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    fs.mkdirSync(path.join(dir, 'outcomes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.copyFileSync(STREAM_USAGE, path.join(dir, 'logs', '3.jsonl'));
    if (outcomeText !== null) fs.writeFileSync(path.join(dir, 'outcomes', '3.md'), outcomeText);
    return runApi(project, home, port, 'inspect', '3');
  });
  return { out, dir, home, project };
}

test('inspect 12: tracker, an EMPTY outcome file — "no-outcome", and <dir>/items/<n>.md is written anyway', async (t) => {
  const { out, dir } = await trackerInspect(t, '');

  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout.trim());
  assert.equal(result.item, 'no-outcome');
  assert.equal(result.usage, 'recorded');
  const snapshot = path.join(dir, 'items', '3.md');
  assert.equal(result.snapshot, snapshot);
  assert.match(fs.readFileSync(snapshot, 'utf8'), /## Cause/);
});

test('inspect 13: tracker, an absent outcome file — "no-outcome" as well, the snapshot still written', async (t) => {
  const { out, dir } = await trackerInspect(t, null);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout.trim()).item, 'no-outcome');
  assert.equal(fs.existsSync(path.join(dir, 'items', '3.md')), true);
});

test("inspect 14: tracker, a non-empty outcome file — \"outcome\" with the file as itemPath; success or failure is the body's judgement", async (t) => {
  const { out, dir } = await trackerInspect(t, 'Verification: pnpm test — 12 passed\n');

  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout.trim());
  assert.equal(result.item, 'outcome');
  assert.equal(result.itemPath, path.join(dir, 'outcomes', '3.md'));
  assert.match(fs.readFileSync(path.join(dir, 'items', '3.md'), 'utf8'), /## Outcome\n\nVerification: pnpm test/);
});

test('inspect composes the existing internals and runs no git of its own', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const start = source.indexOf('function cmdInspect(');
  assert.ok(start !== -1, 'cmdInspect is gone');
  const body = source.slice(start, source.indexOf('\nconst ASSUME_USAGE', start)).replace(/\/\/.*$/gm, '');
  for (const needle of ['cmdStage(', 'applyUsageEntry(', 'readPermissionDenials(', 'findItemFilePath(', 'writeSnapshot(']) {
    assert.ok(body.includes(needle), `cmdInspect no longer calls ${needle}`);
  }
  assert.doesNotMatch(body, /spawnSync|'merge'|'push'/);
});
