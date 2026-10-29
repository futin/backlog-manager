// The run file and its writers — init, stage, attention, assume, finish — and `plan`'s queue builder and refusal gate, runner-fix hoisting included.
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUN_STALE_MS,
  archiveStem,
  isZombieStatState
} from './orchestrate.mjs';
import {
  TASK_9_BODY,
  TASK_9_REL,
  commitEverything,
  git,
  leftover,
  orchFixture,
  plan,
  planFixture,
  planGitFixture,
  projStateDir,
  run,
  runFile,
  runsDir,
  seedReadyTask,
  seedSidecar,
  sleepPastRunIdSecond
} from './orchestrate-test-lib.mjs';

// The jest-side fixture is the authority for the run/queue-item key set —
// see shared/types.ts's RunStage/RunQueueItem/RunAttention/OrchestratorRun
// block, which this fixture was hand-built to satisfy. Path-referenced
// rather than copied, per the brief: a copy could drift from the original
// the moment either side is edited without touching the other; reading the
// exact same file both suites already depend on means there is only ever
// one fixture to keep in sync with shared/types.ts.
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'orchestrator-run.json');

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

function writeTask9(project) {
  fs.writeFileSync(path.join(project, TASK_9_REL), TASK_9_BODY);
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
