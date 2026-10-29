// `watch`, `verify`, `reconcile` and `abort` over real child processes and real worktrees, and the run lock serialising verify's and watch's writes.
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
// The namespace import is for exports a later case reaches for by name, so a missing export fails ITS case rather
// than the whole file's link step.
import * as orch from './orchestrate.mjs';
import {
  CLI_MAX_BUFFER,
  SCRIPT,
  STREAM_INIT,
  TEST_SESSION_ID,
  branchList,
  commitEverything,
  orchFixture,
  run,
  runFile,
  seedReadyTask
} from './orchestrate-test-lib.mjs';

const STREAM_NOINIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-noinit.jsonl');
// Fix round 1 (Minor): a leading line that isn't valid JSON at all, ahead of
// a real init event — pins findSessionIdInJsonl's malformed-line-skip branch
// (a bad line is swallowed and parsing continues, it is never a wedge).
const STREAM_MALFORMED_THEN_INIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-malformed-then-init.jsonl');

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

// #294: verify's children used to inherit the driver's environment verbatim, and a driver launched under a parent `pnpm` (the dashboard's) carries
// `COREPACK_ROOT`, which makes a non-corepack pnpm earlier on PATH refuse the `packageManager` pin instead of switching — every check red before it ran. The
// unit case pins exactly which keys go (a parent's identity) and which stay (the user's own configuration, PATH included); `orch.verifyEnv` through the
// namespace import, so a missing export fails this case alone.
test('verifyEnv drops COREPACK_ROOT and a parent run\'s npm_* identity keys, keeps PATH and the user\'s own config, and does not mutate its argument', () => {
  const env = {
    PATH: 'p',
    COREPACK_ROOT: 'c',
    COREPACK_HOME: 'h',
    PNPM_HOME: 'ph',
    npm_execpath: 'x',
    npm_config_user_agent: 'u',
    npm_lifecycle_event: 'test',
    npm_package_name: 'n',
    npm_config_registry: 'r'
  };
  const before = { ...env };
  assert.deepEqual(orch.verifyEnv(env), { PATH: 'p', COREPACK_HOME: 'h', PNPM_HOME: 'ph', npm_config_registry: 'r' });
  assert.deepEqual(env, before, 'verifyEnv mutated the env it was given');
});

test('verify runs every check without the driver\'s COREPACK_ROOT or npm_lifecycle_* keys in its environment', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-9', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-verify-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true });
  const probe = 'node -e "process.exit(process.env.COREPACK_ROOT || process.env.npm_lifecycle_event ? 1 : 0)"';
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: [probe] }));

  // `run()` with two extra keys, the shape a driver spawned under a parent `pnpm run` inherits.
  const out = spawnSync('node', [SCRIPT, 'verify', 'task-9', '--cwd', worktree, '--json'], {
    encoding: 'utf8',
    cwd: project,
    maxBuffer: CLI_MAX_BUFFER,
    env: {
      ...process.env,
      BM_ORCH_HOME: home,
      BM_ORCH_CONTROL_HOME: `${home}-control`,
      CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID,
      COREPACK_ROOT: '/x',
      npm_lifecycle_event: 'test'
    }
  });

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true, 'the check saw the driver\'s COREPACK_ROOT or npm_lifecycle_event');
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

// #264: a `parked` or `failed` item's branch holds committed work that never reached the base — a merge conflict, an exhausted fix loop — and in merge mode
// that branch is never pushed, so it is the only copy. Such an item has already run `stop --keep-started`, so it carries no `phase:` marker, and before this
// fix the teardown read "no marker" as "disposable" and force-removed both. One run, three items: the parked and the failed one keep worktree AND branch, and
// a plain in-flight item without a marker is still torn down, so the new gate is pinned from both sides.
test('abort keeps a parked and a failed item\'s worktree and branch, and still tears down an in-flight item without a marker (#264)', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-63', 'A parked task');
  seedReadyTask(project, 'task-64', 'A failed task');
  seedReadyTask(project, 'task-65', 'An in-flight task');
  commitEverything(project, 'seed');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const trees = {};
  for (const id of ['task-63', 'task-64', 'task-65']) {
    trees[id] = path.join(project, '.worktrees', id);
    assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', trees[id], '-b', `backlog/${id}`, 'HEAD'], { encoding: 'utf8' }).status, 0);
    assert.equal(run(project, home, 'stage', id, 'dispatched', '--worktree', trees[id], '--branch', `backlog/${id}`).status, 0);
  }
  // The parked item's work is a real commit on its branch, never merged — the exact shape the bug destroyed.
  fs.writeFileSync(path.join(trees['task-63'], 'work.txt'), 'unmerged work\n');
  assert.equal(spawnSync('git', ['-C', trees['task-63'], 'add', 'work.txt'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', trees['task-63'], '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'work'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'stage', 'task-63', 'parked').status, 0);
  assert.equal(run(project, home, 'stage', 'task-64', 'failed').status, 0);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 0, out.stderr);
  for (const id of ['task-63', 'task-64']) {
    assert.equal(fs.existsSync(trees[id]), true, `${id}'s worktree must survive abort`);
    const kept = spawnSync('git', ['-C', project, 'branch', '--list', `backlog/${id}`], { encoding: 'utf8' });
    assert.match(kept.stdout, new RegExp(`backlog/${id}`), `${id}'s branch must survive abort`);
  }
  assert.equal(fs.readFileSync(path.join(trees['task-63'], 'work.txt'), 'utf8'), 'unmerged work\n');
  assert.equal(fs.existsSync(trees['task-65']), false);
  assert.equal(spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/task-65'], { encoding: 'utf8' }).stdout.trim(), '');

  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(after.status, 'aborted');
  const kept = after.attention.filter((a) => /KEPT by abort/.test(a.detail)).map((a) => a.id).sort();
  assert.deepEqual(kept, ['task-63', 'task-64']);
  assert.match(out.stdout, /removed 1 item\(s\) \(task-65\)/);
  assert.match(out.stdout, /kept 2 parked\/failed item\(s\) \(task-63, task-64/);
});

test('abort with no run exits 3', (t) => {
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'abort');

  assert.equal(out.status, 3);
});

// --- #349: the run lock serialising verify's and watch's read-modify-writes -------------------------------------------------------------------------------
//
// `verify` runs detached beside a `watch` heartbeating the same run.json (SKILL.md §8), and both used to be blind read-modify-writes: a tick that read before
// verify's write and wrote after it put back the old `verification` array. Both now go through `mutateRun`, behind `<dir>/run.json.lock`.

function runLockFile(home, project) {
  return path.join(home, encodeURIComponent(project), 'run.json.lock');
}

// `runAsync` with extra environment — the lock's deadline is overridable so the timeout case stays fast.
async function runAsyncEnv(cwd, home, extraEnv, ...args) {
  const proc = spawn('node', [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, BM_ORCH_HOME: home, CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID, ...extraEnv }
  });
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

function verifyWorktree(t, commands) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-lock-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands }));
  return worktree;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('verify waits on a run lock held by a live pid, writing nothing, and writes its rows once the lock is released', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const worktree = verifyWorktree(t, ['node -e "process.exit(0)"']);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  // This test process's own pid: alive for the whole case, so the lock is never broken as dead.
  fs.writeFileSync(runLockFile(home, project), `${process.pid}\n${new Date().toISOString()}\n`);
  const pending = runAsyncEnv(project, home, {}, 'verify', 'task-1', '--cwd', worktree, '--json');
  await delay(600);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before, 'verify wrote run.json while the lock was held');
  fs.rmSync(runLockFile(home, project));

  const out = await pending;
  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].verification, rows);
  assert.equal(fs.existsSync(runLockFile(home, project)), false);
});

test('verify breaks a run lock whose holder pid is dead, writes its rows, and leaves no lock behind', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const worktree = verifyWorktree(t, ['node -e "process.exit(0)"']);

  // A child that has already exited and been reaped by spawnSync: its pid names no process.
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
  fs.writeFileSync(runLockFile(home, project), `${dead}\n${new Date().toISOString()}\n`);

  const out = run(project, home, 'verify', 'task-1', '--cwd', worktree, '--json');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].verification.length, 1);
  // Neither the lock nor the temp stamp it was linked from, nor the aside a break renamed it to, is left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(runLockFile(home, project))).filter((n) => n.startsWith('run.json.lock')), []);
});

test('verify exits 1 naming run.json.lock when a live holder keeps the lock past BM_RUN_LOCK_TIMEOUT_MS, leaving run.json byte-identical', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const worktree = verifyWorktree(t, ['node -e "process.exit(0)"']);
  const before = fs.readFileSync(runFile(home, project), 'utf8');
  fs.writeFileSync(runLockFile(home, project), `${process.pid}\n${new Date().toISOString()}\n`);
  t.after(() => fs.rmSync(runLockFile(home, project), { force: true }));

  const out = await runAsyncEnv(project, home, { BM_RUN_LOCK_TIMEOUT_MS: '300' }, 'verify', 'task-1', '--cwd', worktree, '--json');
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /run\.json\.lock/);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
  // The holder's lock is still the holder's: a timed-out waiter never removes it.
  assert.equal(fs.readFileSync(runLockFile(home, project), 'utf8').split('\n')[0], String(process.pid));
});

test('watch waits on a held run lock before heartbeating, then heartbeats once it is released and leaves no lock behind', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-9', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project), 'utf8');
  const child = spawnChild(t, 30_000);

  fs.writeFileSync(runLockFile(home, project), `${process.pid}\n${new Date().toISOString()}\n`);
  const pending = runAsyncEnv(project, home, {}, 'watch', 'task-9', '--pid', String(child.pid), '--jsonl', STREAM_INIT, '--interval-ms', '50', '--budget-ms', '300');
  await delay(600);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before, 'watch heartbeated while the lock was held');
  fs.rmSync(runLockFile(home, project));

  const out = await pending;
  assert.equal(out.status, 3, out.stderr);
  const after = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.ok(Date.parse(after.updatedAt) > Date.parse(JSON.parse(before).updatedAt), 'updatedAt did not advance after the lock was released');
  assert.equal(fs.existsSync(runLockFile(home, project)), false);
});

test('verify beside a fast-ticking watch on the same item keeps every row it printed, run after run', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-9', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  // The watch's budget counts ticks, not wall time (elapsed += interval-ms), so 30 ticks of 20 ms each, every one a locked read-modify-write, overlap the
  // 800 ms suite without the round outliving the child it watches.
  const worktree = verifyWorktree(t, ['node -e "setTimeout(() => {}, 800)"', 'node -e "process.exit(0)"']);

  for (let round = 0; round < 4; round++) {
    const child = spawnChild(t, 120_000);
    const watching = runAsyncEnv(project, home, {}, 'watch', 'task-9', '--pid', String(child.pid), '--jsonl', STREAM_INIT, '--interval-ms', '20', '--budget-ms', '600');
    const out = await runAsyncEnv(project, home, {}, 'verify', 'task-9', '--cwd', worktree, '--json');
    const watched = await watching;
    child.kill('SIGKILL');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(watched.status, 3, watched.stderr);
    const printed = JSON.parse(out.stdout);
    const onDisk = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === 'task-9').verification;
    for (const row of printed) assert.ok(onDisk.some((r) => JSON.stringify(r) === JSON.stringify(row)), `round ${round}: a printed row is missing from run.json`);
    assert.equal(onDisk.length, printed.length * (round + 1), `round ${round}: run.json lost rows`);
  }
  assert.equal(fs.existsSync(runLockFile(home, project)), false);
});
