// The control file and the lease: pause and unpause, the driver lease, the stop request, and the sources an abort reads a session from.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RUN_STALE_MS,
  controlFilePath,
  controlHome,
  pauseRequestEffective,
  stopRequestEffective
} from './orchestrate.mjs';
import {
  SCRIPT,
  STREAM_INIT,
  commitEverything,
  effectiveStop,
  orchFixture,
  projStateDir,
  run,
  runAs,
  runFile,
  runsDir,
  seedReadyTask,
  seedSidecar,
  writeControl
} from './orchestrate-test-lib.mjs';

// A copy, not an import from orchestrate-test-lib.mjs: scripts/ci-scope.mjs picks the suites a docs-only PR runs by the doc paths each
// SUITE names, so a doc path only the lib spelled would let a docs PR skip the guards in this file that read it.
const SKILL_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');
const REFERENCES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'references');

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

// #305 — the board can now stop a PAUSED run, so a stop can be on file for a run whose driver has already exited. `unpause` stamps `unpausedAt`, which
// is exactly what retires a control request: an unpause that went through would move the run's start past the stop's `requestedAt` and silently
// cancel it. So `unpause` refuses an effective stop with `10`, the stop code — the reaction is `--abort` (references/stopping.md), never a retry.
function pausedRunWithControl(t, control) {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'paused').status, 0);
  const body = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  // A second after the start, explicitly: `new Date()` here could tie with `startedAt` at millisecond resolution, and a tie is not timely.
  writeControl(home, project, { runId: body.runId, requestedAt: new Date(Date.parse(body.startedAt) + 1000).toISOString(), ...control(body) });
  return { home, project };
}

test('unpause refuses a paused run with a stop on file, exit 10, writing nothing', (t) => {
  const { home, project } = pausedRunWithControl(t, () => ({ kind: 'stop' }));
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'unpause');

  assert.equal(out.status, 10, out.stderr);
  assert.match(out.stderr, /stop request on file — nothing resumes a stopped run/);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))), 'run.json was modified by an unpause refused on a stop');
  assert.equal(JSON.parse(before.toString()).status, 'paused');
});

test('unpause still resumes a paused run whose control file is a pause, or a stop for another run', (t) => {
  for (const control of [() => ({}), () => ({ kind: 'pause' }), () => ({ kind: 'stop', runId: 'run-someone-else' })]) {
    const { home, project } = pausedRunWithControl(t, control);

    const out = run(project, home, 'unpause');

    assert.equal(out.status, 0, `${JSON.stringify(control({}))}: ${out.stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'running');
  }
});

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
