// PR mode — the run branch, pr-draft, pr --url, finish — and the stale-plan mark.
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
// The namespace import is for exports a later case reaches for by name, so a missing export fails ITS case rather
// than the whole file's link step.
import * as orch from './orchestrate.mjs';
import {
  GROOMED_TASK_BODY,
  INSPECT_ID,
  MC_ID,
  SCRIPT,
  TEST_SESSION_ID,
  apiItem,
  basedFixture,
  claimRoutes,
  commitEverything,
  gateRoutes,
  git,
  gitOk,
  inspectCmd,
  inspectFixture,
  inspectOut,
  mergeCheck,
  mergeCheckFixture,
  orchFixture,
  plan,
  planGitFixture,
  projStateDir,
  queueItem,
  readRunJson,
  run,
  runApi,
  runFile,
  runsDir,
  seedReadyTask,
  seedSidecar,
  sleepPastRunIdSecond,
  stageOf,
  trackerFixture,
  trackerInspect,
  withApi
} from './orchestrate-test-lib.mjs';

// --- PR mode, task 3: `init` mints the run branch ------------------------------------------------------------------------
//
// Spec §2 (docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md): under `--merge-mode pr`, `--base` names the PR's
// TARGET and the run's own `base` is a branch `init` mints, `backlog/run-<local date>-<n>`, cut at the target's tip as the last
// git write before the run file. Numbered after the task-3 brief's cases so a red one maps straight back to the row that
// specifies it.

/** The local calendar date, computed here rather than through the tool's own formatter so a wrong formatter cannot agree
 *  with itself. A case that straddles local midnight can still flake; nothing here runs long enough to make that likely. */
function todayLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A tracker fixture with one commit, so `main` is a real ref a run branch can be cut from. No `origin`. */
function prFixture(t) {
  const fx = trackerFixture(t);
  fs.writeFileSync(path.join(fx.project, 'README.md'), 'pr fixture\n');
  commitEverything(fx.project, 'pr fixture');
  return fx;
}

/** `runApi`, with extra environment for the one case that needs it (`TZ`). */
function runApiEnv(extraEnv, cwd, home, port, ...args) {
  return new Promise((resolve) => {
    const proc = spawn('node', [SCRIPT, ...args], {
      cwd,
      env: {
        ...process.env,
        BM_ORCH_HOME: home,
        BM_ORCH_CONTROL_HOME: `${home}-control`,
        BM_API_PORT: String(port),
        CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID,
        ...extraEnv
      }
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** `init --merge-mode pr` against an empty tracker queue, so the case is about the mint and nothing else. */
async function initPr(fx, extra = [], env = {}) {
  const { out } = await withApi(gateRoutes([], {}), (port) =>
    runApiEnv(env, fx.project, fx.home, port, 'init', '--project', fx.project, '--merge-mode', 'pr', ...extra)
  );
  return out;
}

/** `init`'s stderr minus the tracker gate's own cache-age line, which every whole-queue tracker `init` prints (bug-41) and
 *  which is not this feature's to count. What is left is what the mint said. */
function mintStderr(out) {
  return out.stderr.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('queue built from the tracker cache'));
}

/** Every local `backlog/run-*` branch, sorted. */
function runBranches(project) {
  return gitOk(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/backlog/')
    .split('\n')
    .filter((name) => name.startsWith('backlog/run-'))
    .sort();
}

function tipOf(project, ref) {
  return gitOk(project, 'rev-parse', '--verify', `${ref}^{commit}`).trim();
}

/** A files run hand-moved into `pr` mode, for the commands whose behaviour under `pr` does not depend on how the run got
 *  there (and a files fixture keeps `stage merged` from needing a fake close route). Returns the run's own fields.
 *  `items` seeds several tasks instead of one, and the queue is put in exactly that order — the gate's own ordering is not
 *  what a case about queue order should be depending on. */
function handPrRun(t, { id = 'task-1', items = [{ id, title: 'Some task' }] } = {}) {
  const fx = basedFixture(t);
  for (const item of items) seedReadyTask(fx.project, item.id, item.title);
  commitEverything(fx.project, 'seed task');
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project).status, 0);
  const runBranch = 'backlog/run-2026-10-15-1';
  gitOk(fx.project, 'branch', runBranch, 'main');
  const file = runFile(fx.home, fx.project);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(written, { mergeMode: 'pr', mergeModeEffective: 'pr', base: runBranch, prTarget: 'main', prUrl: null });
  written.queue = items.map((item) => written.queue.find((q) => q.id === item.id));
  fs.writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`);
  return { ...fx, runBranch, file };
}

// 3.1
test('pr 3.1: the tool’s MERGE_MODES copy equals shared/types.ts’s, read from both sources', () => {
  const listOf = (source, pattern) => {
    const m = pattern.exec(source);
    assert.ok(m, `no MERGE_MODES declaration matching ${pattern}`);
    return JSON.parse(m[1].replace(/'/g, '"'));
  };
  const tool = listOf(fs.readFileSync(SCRIPT, 'utf8'), /^const MERGE_MODES = (\[[^\]]*\]);$/m);
  const types = listOf(
    fs.readFileSync(path.join(path.dirname(SCRIPT), '..', '..', '..', 'shared', 'types.ts'), 'utf8'),
    /^export const MERGE_MODES: readonly MergeMode\[\] = (\[[^\]]*\]);$/m
  );
  assert.deepEqual(tool, types);
  assert.deepEqual(tool, ['merge', 'branch', 'pr']);
});

// 3.2
test('pr 3.2: init --merge-mode pr mints backlog/run-<today>-1 at main and records base, prTarget and a null prUrl', async (t) => {
  const fx = prFixture(t);
  const today = todayLocal();

  const out = await initPr(fx);

  assert.equal(out.status, 0, out.stderr);
  const runBranch = `backlog/run-${today}-1`;
  assert.deepEqual(runBranches(fx.project), [runBranch]);
  assert.equal(tipOf(fx.project, runBranch), tipOf(fx.project, 'main'));
  const written = readRunJson(fx);
  assert.equal(written.mergeMode, 'pr');
  assert.equal(written.mergeModeEffective, 'pr');
  assert.equal(written.base, runBranch);
  assert.equal(written.prTarget, 'main');
  assert.equal(written.prUrl, null);
});

// 3.3
test('pr 3.3: init --merge-mode pr --base feature/x targets feature/x and cuts the run branch at its tip', async (t) => {
  const fx = prFixture(t);
  gitOk(fx.project, 'branch', 'feature/x');
  // Move main on, so the two tips differ and "cut at feature/x" is distinguishable from "cut at main".
  fs.writeFileSync(path.join(fx.project, 'later.txt'), 'later\n');
  commitEverything(fx.project, 'later on main');
  assert.notEqual(tipOf(fx.project, 'main'), tipOf(fx.project, 'feature/x'));

  const out = await initPr(fx, ['--base', 'feature/x']);

  assert.equal(out.status, 0, out.stderr);
  const written = readRunJson(fx);
  assert.equal(written.prTarget, 'feature/x');
  assert.equal(tipOf(fx.project, written.base), tipOf(fx.project, 'feature/x'));
});

// 3.4
test('pr 3.4: a local backlog/run-<today>-1 already present mints -2', async (t) => {
  const fx = prFixture(t);
  const today = todayLocal();
  gitOk(fx.project, 'branch', `backlog/run-${today}-1`, 'main');

  const out = await initPr(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(readRunJson(fx).base, `backlog/run-${today}-2`);
});

test('pr 3.4: a backlog/run-<today>-1 present only on origin mints -2', async (t) => {
  const fx = prFixture(t);
  const today = todayLocal();
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-remote-')));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  gitOk(remote, 'init', '-q', '--bare', '-b', 'main');
  gitOk(fx.project, 'remote', 'add', 'origin', remote);
  // main first, or init's own `pull --ff-only origin main` refuses before the mint is reached.
  gitOk(fx.project, 'push', '-q', 'origin', 'main');
  gitOk(fx.project, 'push', '-q', 'origin', `main:refs/heads/backlog/run-${today}-1`);
  assert.deepEqual(runBranches(fx.project), [], 'the -1 must exist on origin only');

  const out = await initPr(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(readRunJson(fx).base, `backlog/run-${today}-2`);
  assert.doesNotMatch(out.stderr, /ls-remote/, 'a reachable origin must not print the fallback line');
});

test('pr 3.4: refs -1, -3 and -wip mint -4 — the highest number plus one, the non-numeric one ignored', async (t) => {
  const fx = prFixture(t);
  const today = todayLocal();
  for (const suffix of ['1', '3', 'wip']) gitOk(fx.project, 'branch', `backlog/run-${today}-${suffix}`, 'main');

  const out = await initPr(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(readRunJson(fx).base, `backlog/run-${today}-4`);
});

test('pr 3.4: nextRunBranchName starts at 1, ignores other dates and non-numeric suffixes, and takes the highest plus one', () => {
  assert.equal(orch.nextRunBranchName('2026-10-15', []), 'backlog/run-2026-10-15-1');
  assert.equal(orch.nextRunBranchName('2026-10-15', ['backlog/run-2026-10-14-7']), 'backlog/run-2026-10-15-1');
  assert.equal(
    orch.nextRunBranchName('2026-10-15', ['backlog/run-2026-10-15-1', 'backlog/run-2026-10-15-3', 'backlog/run-2026-10-15-wip']),
    'backlog/run-2026-10-15-4'
  );
  // Anchored at both ends: a longer name that merely contains a run branch's shape is not one.
  assert.equal(orch.nextRunBranchName('2026-10-15', ['backlog/run-2026-10-15-9/x', 'x/backlog/run-2026-10-15-8']), 'backlog/run-2026-10-15-1');
});

test('pr 3.4: localDate formats the local calendar date as YYYY-MM-DD, zero-padded', () => {
  assert.equal(orch.localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(orch.localDate(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
});

// 3.5
test('pr 3.5: init --merge-mode pr on a files project exits 1 naming the tracker requirement, and writes nothing', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  assert.equal(run(project, home, 'finish', '--status', 'done').status, 0);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = run(project, home, 'init', '--project', project, '--merge-mode', 'pr');

  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stderr, /tracker/);
  assert.deepEqual(runBranches(project), []);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before, 'the done run must be neither archived nor replaced');
  assert.equal(fs.existsSync(runsDir(home, project)), false);
});

test('pr 3.5: on a project with no run yet, the files refusal leaves no run file at all', (t) => {
  const { home, project } = basedFixture(t);

  const out = run(project, home, 'init', '--project', project, '--merge-mode', 'pr');

  assert.equal(out.status, 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

// 3.6
test('pr 3.6: the minted date is the local date in the child’s TZ, not UTC', async (t) => {
  const fx = prFixture(t);
  const now = new Date();
  const utc = now.toISOString().slice(0, 10);
  const inZone = (timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  // At any instant one of these two is on a different calendar day from UTC: Kiritimati is UTC+14, Etc/GMT+12 is UTC-12.
  const zone = ['Pacific/Kiritimati', 'Etc/GMT+12'].find((z) => inZone(z) !== utc);
  assert.ok(zone, 'one of the two zones must differ from UTC at any instant');

  const out = await initPr(fx, [], { TZ: zone });

  assert.equal(out.status, 0, out.stderr);
  assert.equal(readRunJson(fx).base, `backlog/run-${inZone(zone)}-1`);
});

// 3.7
test('pr 3.7: with no origin, init mints from local refs and prints exactly one stderr line naming the fallback', async (t) => {
  const fx = prFixture(t);

  const out = await initPr(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(readRunJson(fx).base, `backlog/run-${todayLocal()}-1`);
  const lines = mintStderr(out);
  assert.equal(lines.length, 1, out.stderr);
  assert.match(lines[0], /ls-remote/);
  assert.match(lines[0], /local refs/);
});

test('pr 3.7: an unreachable origin with a target no tree holds still mints, with the same one stderr line', async (t) => {
  const fx = prFixture(t);
  gitOk(fx.project, 'branch', 'feature/x');
  // A path that does not exist: `remote get-url` succeeds, so `pullBaseAtInit` reaches its tree scan — and returns there,
  // because no tree holds feature/x. The mint's `ls-remote` is the first call that talks to the remote, and it fails.
  gitOk(fx.project, 'remote', 'add', 'origin', path.join(fx.project, 'no-such-remote'));

  const out = await initPr(fx, ['--base', 'feature/x']);

  assert.equal(out.status, 0, out.stderr);
  const written = readRunJson(fx);
  assert.equal(written.base, `backlog/run-${todayLocal()}-1`);
  assert.equal(written.prTarget, 'feature/x');
  const lines = mintStderr(out);
  assert.equal(lines.length, 1, out.stderr);
  assert.match(lines[0], /ls-remote/);
});

test('pr 3.7: the mint’s ls-remote spawn carries a timeout, and asks for the date’s run branches on origin', () => {
  const { args, options } = orch.runBranchLsRemote('/some/root', '2026-10-15');
  assert.deepEqual(args, ['-C', '/some/root', 'ls-remote', '--heads', 'origin', 'backlog/run-2026-10-15-*']);
  assert.ok(Number.isFinite(options.timeout) && options.timeout > 0, `timeout must be a positive number, got ${options.timeout}`);
});

// 3.8
test('pr 3.8: init refused by an existing running run (exit 4) leaves no run branch behind', async (t) => {
  const fx = prFixture(t);
  const first = await withApi(gateRoutes([], {}), (port) => runApi(fx.project, fx.home, port, 'init', '--project', fx.project));
  assert.equal(first.out.status, 0, first.out.stderr);
  const before = fs.readFileSync(runFile(fx.home, fx.project), 'utf8');

  const out = await initPr(fx);

  assert.equal(out.status, 4, out.stderr);
  assert.deepEqual(runBranches(fx.project), []);
  assert.equal(fs.readFileSync(runFile(fx.home, fx.project), 'utf8'), before);
});

// 3.9
test('pr 3.9: init --merge-mode merge and branch write prTarget and prUrl as null, and mint nothing', (t) => {
  for (const mode of ['merge', 'branch']) {
    const { home, project } = basedFixture(t);

    const out = run(project, home, 'init', '--project', project, '--merge-mode', mode);

    assert.equal(out.status, 0, out.stderr);
    const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
    assert.equal(written.base, 'main');
    assert.equal(written.prTarget, null);
    assert.equal(written.prUrl, null);
    assert.deepEqual(runBranches(project), []);
  }
});

// 3.10
test('pr 3.10: merge-mode branch on a pr run degrades the effective mode only, and only once', async (t) => {
  const fx = prFixture(t);
  assert.equal((await initPr(fx)).status, 0);

  const out = run(fx.project, fx.home, 'merge-mode', 'branch', '--note', 'x');

  assert.equal(out.status, 0, out.stderr);
  const after = readRunJson(fx);
  assert.equal(after.mergeMode, 'pr');
  assert.equal(after.mergeModeEffective, 'branch');
  assert.equal(after.mergeModeNote, 'x');
  const before = fs.readFileSync(runFile(fx.home, fx.project));

  const again = run(fx.project, fx.home, 'merge-mode', 'branch', '--note', 'y');

  assert.equal(again.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(fx.home, fx.project))));
});

test('pr 3.10: merge-mode pr is never a target — the only move is to branch', async (t) => {
  const fx = prFixture(t);
  assert.equal((await initPr(fx)).status, 0);
  const before = fs.readFileSync(runFile(fx.home, fx.project));

  const out = run(fx.project, fx.home, 'merge-mode', 'pr', '--note', 'x');

  assert.equal(out.status, 1);
  assert.ok(before.equals(fs.readFileSync(runFile(fx.home, fx.project))));
});

test('pr 3.10: stage <id> merged is accepted on a pr run', (t) => {
  const fx = handPrRun(t);

  const out = run(fx.project, fx.home, 'stage', 'task-1', 'merged');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(readRunJson(fx).queue.find((q) => q.id === 'task-1').stage, 'merged');
});

// 3.11
test('pr 3.11: claim and reconcile on a pr run leave base, prTarget and prUrl byte-identical', (t) => {
  const fx = handPrRun(t);
  const fields = () => {
    const r = readRunJson(fx);
    return JSON.stringify({ base: r.base, prTarget: r.prTarget, prUrl: r.prUrl });
  };
  const before = fields();

  const claimed = run(fx.project, fx.home, 'claim');
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.equal(fields(), before);

  const reconciled = run(fx.project, fx.home, 'reconcile', '--json');
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.equal(fields(), before);
});

// 3.12
test('pr 3.12: merge-check on a pr run whose run branch no tree holds creates _base-<sanitised run branch>', (t) => {
  const fx = mergeCheckFixture(t);
  const runBranch = 'backlog/run-2026-10-15-1';
  gitOk(fx.project, 'branch', runBranch, 'main');
  const file = runFile(fx.home, fx.project);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(written, { mergeMode: 'pr', mergeModeEffective: 'pr', base: runBranch, prTarget: 'main', prUrl: null });
  fs.writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`);

  const out = mergeCheck(fx, MC_ID);

  assert.equal(out.status, 0, out.stderr);
  const expected = path.join(fx.project, '.worktrees', '_base-backlog-run-2026-10-15-1');
  const verdict = JSON.parse(out.stdout.trim());
  assert.equal(verdict.verdict, 'merge');
  assert.equal(verdict.baseTree, expected);
  assert.equal(verdict.created, true);
  assert.deepEqual(readRunJson(fx).baseTree, { path: expected, created: true });
  assert.notEqual(stageOf(fx), 'parked');
});

// --- pr mode: pr-draft and pr --url (Task 4) --------------------------------

/** A tree holding the run branch, made once per fixture — the merge site SKILL.md §9 merges in. */
function runBranchTree(fx) {
  const tree = path.join(fx.project, '.worktrees', '_base-backlog-run-2026-10-15-1');
  if (!fs.existsSync(tree)) gitOk(fx.project, 'worktree', 'add', '-q', tree, fx.runBranch);
  return tree;
}

/** One empty commit with `subject` — the subject is all `pr-draft` reads. */
function commitSubject(tree, subject) {
  gitOk(tree, 'commit', '-q', '--allow-empty', '-m', subject);
}

/**
 * Lands one item on the run branch the way SKILL.md §6 and §9 do: `backlog/<id>` is cut from the run branch's tip, takes
 * the §6 commit and then any fix-loop commits (`subjects`, in that order), and is merged `--no-ff` with
 * `Merge backlog/<id>: <title>`.
 */
function landItem(fx, id, title, subjects) {
  const tree = runBranchTree(fx);
  gitOk(tree, 'checkout', '-q', '-b', `backlog/${id}`);
  for (const subject of subjects) commitSubject(tree, subject);
  gitOk(tree, 'checkout', '-q', fx.runBranch);
  gitOk(tree, 'merge', '-q', '--no-ff', `backlog/${id}`, '-m', `Merge backlog/${id}: ${title}`);
}

/** Hand-edits the run file's queue: `stages` maps an id to the stage it ends on, `fields` to extra item fields. */
function setQueue(fx, stages, fields = {}) {
  const written = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  for (const item of written.queue) {
    if (stages[item.id] !== undefined) item.stage = stages[item.id];
    Object.assign(item, fields[item.id] ?? {});
  }
  fs.writeFileSync(fx.file, `${JSON.stringify(written, null, 2)}\n`);
}

function prDir(fx) {
  return path.join(path.dirname(fx.file), 'pr');
}

/** `pr-draft`, parsed: its exit, its one JSON line, and the body it wrote. */
function prDraft(fx) {
  const out = run(fx.project, fx.home, 'pr-draft');
  if (out.status !== 0) return { out };
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines.length, 1, out.stdout);
  const draft = JSON.parse(lines[0]);
  return { out, draft, body: fs.readFileSync(draft.bodyFile, 'utf8') };
}

// 4.1
test('pr 4.1: prTitle ranks feat > fix > perf > chore, folds every other type into chore, and counts the items', () => {
  const title = (...subjects) => orch.prTitle(subjects.map((subject) => ({ subject })));
  assert.equal(title('fix(a): x', 'feat(b): y'), 'feat(backlog): 2 items');
  assert.equal(title('fix(a): x', 'chore(b): y'), 'fix(backlog): 2 items');
  assert.equal(title('perf(a): x', 'chore(b): y'), 'perf(backlog): 2 items');
  assert.equal(title('refactor(a): x', 'docs(b): y'), 'chore(backlog): 2 items');
  assert.equal(title('fix(a): x'), 'fix(backlog): 1 item');
  // An unparseable subject and a missing one (no merge commit found) both rank as chore.
  assert.equal(title('not a conventional commit', null), 'chore(backlog): 2 items');
});

test('pr 4.1: pr-draft reads each item’s type from its real merge commit, and prints head and target', (t) => {
  const fx = handPrRun(t, {
    items: [
      { id: 'task-1', title: 'First thing' },
      { id: 'task-2', title: 'Second thing' }
    ]
  });
  landItem(fx, 'task-1', 'First thing', ['fix(a): x']);
  landItem(fx, 'task-2', 'Second thing', ['feat(b): y']);
  setQueue(fx, { 'task-1': 'merged', 'task-2': 'merged' });

  const { out, draft } = prDraft(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(draft, {
    title: 'feat(backlog): 2 items',
    bodyFile: path.join(prDir(fx), 'body.md'),
    head: fx.runBranch,
    target: 'main'
  });
});

// 4.2
test('pr 4.2: a breaking subject puts ! on a releasing type only', () => {
  const title = (...subjects) => orch.prTitle(subjects.map((subject) => ({ subject })));
  assert.equal(title('feat(b)!: y', 'fix(a): x'), 'feat(backlog)!: 2 items');
  assert.equal(title('refactor!: y'), 'chore(backlog): 1 item');
  assert.equal(title('fix!: y'), 'fix(backlog)!: 1 item');
});

// 4.3
test('pr 4.3: the §6 commit decides the type, not a later fix-loop commit', (t) => {
  const fx = handPrRun(t, { items: [{ id: 'task-1', title: 'Only thing' }] });
  // The fix loop's `fix` outranks the §6 `chore`, so reading the branch tip (M^2) instead of its first commit goes red here.
  landItem(fx, 'task-1', 'Only thing', ['chore(x): a', 'fix(x): b']);
  setQueue(fx, { 'task-1': 'merged' });

  const { out, draft } = prDraft(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(draft.title, 'chore(backlog): 1 item');
});

// 4.4
test('pr 4.4: an item staged merged with no Merge backlog/<id> commit ranks chore and still gets its line', (t) => {
  const fx = handPrRun(t, {
    items: [
      { id: 'task-1', title: 'Merged by hand' },
      { id: 'task-2', title: 'Merged by the run' }
    ]
  });
  landItem(fx, 'task-2', 'Merged by the run', ['chore(b): y']);
  setQueue(fx, { 'task-1': 'merged', 'task-2': 'merged' });

  const { out, draft, body } = prDraft(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(draft.title, 'chore(backlog): 2 items');
  assert.match(body, /^- Merged by hand \(#task-1\)$/m);

  // Alone, too: nothing on the run branch at all is still not a refusal.
  const lone = handPrRun(t, { items: [{ id: 'task-1', title: 'Merged by hand' }] });
  setQueue(lone, { 'task-1': 'merged' });
  const alone = prDraft(lone);
  assert.equal(alone.out.status, 0, alone.out.stderr);
  assert.equal(alone.draft.title, 'chore(backlog): 1 item');
});

// 4.5
test('pr 4.5: the body lists merged items in queue order, then the run line with every non-zero terminal count in order', (t) => {
  const fx = handPrRun(t, {
    items: [
      { id: 'task-1', title: 'First thing' },
      { id: 'task-2', title: 'Second thing' },
      { id: 'task-3', title: 'Parked one' },
      { id: 'task-4', title: 'Skipped one' },
      { id: 'task-5', title: 'Failed one' },
      { id: 'task-6', title: 'Unanswered one' },
      { id: 'task-7', title: 'Still pending' }
    ]
  });
  // Merged into git in the opposite order from the queue: the list must follow the queue.
  landItem(fx, 'task-2', 'Second thing', ['fix(b): y']);
  landItem(fx, 'task-1', 'First thing', ['feat(a): x']);
  setQueue(fx, { 'task-1': 'merged', 'task-2': 'merged', 'task-3': 'parked', 'task-4': 'skipped', 'task-5': 'failed', 'task-6': 'needs-answers' });
  const runId = readRunJson(fx).runId;

  const { out, body } = prDraft(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    body,
    [
      "## What's new",
      '',
      '- First thing (#task-1)',
      '- Second thing (#task-2)',
      '',
      '## Run',
      '',
      `\`${runId}\` drained onto \`${fx.runBranch}\` from \`main\`: 2 merged, 1 parked, 1 failed, 1 skipped, 1 needs-answers.`,
      ''
    ].join('\n')
  );
});

test('pr 4.5: prBody counts all seven terminal stages in the fixed order', () => {
  const stages = ['needs-answers', 'ungroomed', 'skipped', 'failed', 'parked', 'branched', 'merged'];
  const queue = stages.map((stage, i) => ({ id: String(i + 1), title: `t${i + 1}`, stage }));
  const body = orch.prBody({ runId: 'run-x', base: 'backlog/run-2026-10-15-1', prTarget: 'main', queue });
  assert.match(body, /: 1 merged, 1 branched, 1 parked, 1 failed, 1 skipped, 1 ungroomed, 1 needs-answers\.$/m);
});

// 4.6
test('pr 4.6: branched items add one line naming their branches, to merge only after this PR lands', (t) => {
  const fx = handPrRun(t, {
    items: [
      { id: 'task-1', title: 'Merged one' },
      { id: 'task-2', title: 'Branched one' },
      { id: 'task-3', title: 'Branched two' }
    ]
  });
  landItem(fx, 'task-1', 'Merged one', ['fix(a): x']);
  setQueue(fx, { 'task-1': 'merged', 'task-2': 'branched', 'task-3': 'branched' }, { 'task-2': { branch: 'backlog/task-2' } });

  const { out, body } = prDraft(fx);

  assert.equal(out.status, 0, out.stderr);
  assert.match(body, /: 1 merged, 2 branched\.$/m);
  const lines = body.split('\n').filter((line) => line.includes('only after this PR lands'));
  assert.equal(lines.length, 1, body);
  // The recorded branch where there is one, and backlog/<id> — the branch §6 made — where there is not.
  assert.match(lines[0], /`backlog\/task-2`/);
  assert.match(lines[0], /`backlog\/task-3`/);
  assert.doesNotMatch(body.split('## Run')[0], /task-2|task-3/, 'a branched item is not something this PR ships');
});

// 4.7
test('pr 4.7: pr-draft refuses a non-pr run, a run with nothing merged, and a run whose PR exists — exit 1, nothing written', (t) => {
  const patchRun = (fx, fields) => {
    const written = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
    Object.assign(written, fields);
    fs.writeFileSync(fx.file, `${JSON.stringify(written, null, 2)}\n`);
  };
  const cases = [
    [
      'mergeMode merge',
      (fx) => {
        patchRun(fx, { mergeMode: 'merge', mergeModeEffective: 'merge', base: 'main', prTarget: null });
        setQueue(fx, { 'task-1': 'merged' });
      }
    ],
    ['nothing merged', (fx) => setQueue(fx, { 'task-1': 'branched' })],
    [
      'prUrl set',
      (fx) => {
        setQueue(fx, { 'task-1': 'merged' });
        patchRun(fx, { prUrl: 'https://github.com/futin/backlog-manager/pull/275' });
      }
    ]
  ];
  for (const [name, arrange] of cases) {
    const fx = handPrRun(t);
    arrange(fx);
    const before = fs.readFileSync(fx.file);

    const out = run(fx.project, fx.home, 'pr-draft');

    assert.equal(out.status, 1, `${name}: ${out.stdout}`);
    assert.equal(out.stdout, '', name);
    assert.equal(fs.existsSync(prDir(fx)), false, `${name}: nothing may be written under <dir>/pr/`);
    assert.ok(before.equals(fs.readFileSync(fx.file)), `${name}: the run file must be unchanged`);
  }
});

// 4.8
test('pr 4.8: pr --url records a GitHub pull request URL, and refuses anything else with the run unchanged', (t) => {
  const fx = handPrRun(t);
  const before = fs.readFileSync(fx.file);
  const bad = [
    'http://github.com/a/b/pull/1',
    'https://github.com.evil.io/a/b/pull/1',
    'https://github.com/a/b/issues/1',
    'https://github.com/a/b/pull/1/files',
    'javascript:alert(1)',
    ''
  ];
  for (const url of bad) {
    const out = run(fx.project, fx.home, 'pr', '--url', url);
    assert.equal(out.status, 1, `${JSON.stringify(url)}: ${out.stdout}`);
    assert.ok(before.equals(fs.readFileSync(fx.file)), `${JSON.stringify(url)}: the run file must be unchanged`);
  }
  const missing = run(fx.project, fx.home, 'pr');
  assert.equal(missing.status, 1);
  assert.ok(before.equals(fs.readFileSync(fx.file)));

  const out = run(fx.project, fx.home, 'pr', '--url', 'https://github.com/futin/backlog-manager/pull/275');

  assert.equal(out.status, 0, out.stderr);
  const after = readRunJson(fx);
  assert.equal(after.prUrl, 'https://github.com/futin/backlog-manager/pull/275');
  assert.equal(after.base, fx.runBranch);
  assert.equal(after.prTarget, 'main');
});

test('pr 4.8: pr --url on a run that is not in pr mode exits 1 and writes nothing — prUrl stays null there', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const before = fs.readFileSync(runFile(home, project));

  const out = run(project, home, 'pr', '--url', 'https://github.com/futin/backlog-manager/pull/275');

  assert.equal(out.status, 1, out.stdout);
  assert.ok(before.equals(fs.readFileSync(runFile(home, project))));
});

// 4.9
test('pr 4.9: a title renders as one list line, with its Markdown kept verbatim', () => {
  const lineFor = (title) => {
    const body = orch.prBody({ runId: 'run-x', base: 'backlog/run-2026-10-15-1', prTarget: 'main', queue: [{ id: '7', title, stage: 'merged' }] });
    return body.split('\n').filter((line) => line.startsWith('- '));
  };
  assert.deepEqual(lineFor('a\nb'), ['- a b (#7)']);
  assert.deepEqual(lineFor('a\r\n  b'), ['- a b (#7)']);
  assert.deepEqual(lineFor('use `x`'), ['- use `x` (#7)']);
  assert.deepEqual(lineFor('## heading'), ['- ## heading (#7)']);
});

// 4.10
test('pr 4.10: the tool’s PR_URL_PATTERN source equals shared/agent.ts’s, read from both sources', () => {
  const sourceOf = (text, pattern) => {
    const m = pattern.exec(text);
    assert.ok(m, `no PR_URL_PATTERN declaration matching ${pattern}`);
    return m[1];
  };
  const tool = sourceOf(fs.readFileSync(SCRIPT, 'utf8'), /^const PR_URL_PATTERN = (\/.+\/[a-z]*);$/m);
  const shared = sourceOf(
    fs.readFileSync(path.join(path.dirname(SCRIPT), '..', '..', '..', 'shared', 'agent.ts'), 'utf8'),
    /^export const PR_URL_PATTERN = (\/.+\/[a-z]*);$/m
  );
  assert.equal(tool, shared);
  assert.equal(tool, String.raw`/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/`);
});

// --- pr mode: finish removes an empty run branch (Task 5) --------------------

/** Every local branch and its sha, for the cases that assert `finish` moved no ref it should not have. */
function allRefs(project) {
  return gitOk(project, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/');
}

/** `finish`'s stderr, split into its non-blank lines. */
function stderrLines(out) {
  return out.stderr.split('\n').filter((l) => l.trim() !== '');
}

/** Lands `task-1` on the run branch, then removes the tree that did it — a merge that landed with nothing staged `merged`. */
function landAndDropTree(fx) {
  landItem(fx, 'task-1', 'Some task', ['feat: some task']);
  gitOk(fx.project, 'worktree', 'remove', '--force', runBranchTree(fx));
}

// 5.1
test('pr 5.1: finish --status done on a pr run with nothing merged and an unchanged run branch deletes the branch', (t) => {
  const fx = handPrRun(t);
  const out = run(fx.project, fx.home, 'finish', '--status', 'done');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(runBranches(fx.project), []);
  assert.deepEqual(stderrLines(out), []);
  assert.equal(readRunJson(fx).status, 'done');
});

// 5.2
test('pr 5.2: a run branch with a commit beyond the target is kept, with one stderr line naming it', (t) => {
  const fx = handPrRun(t);
  landAndDropTree(fx);
  const before = allRefs(fx.project);

  const out = run(fx.project, fx.home, 'finish', '--status', 'done');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(allRefs(fx.project), before);
  assert.deepEqual(runBranches(fx.project), [fx.runBranch]);
  const lines = stderrLines(out);
  assert.equal(lines.length, 1, out.stderr);
  assert.ok(lines[0].includes(fx.runBranch), lines[0]);
});

// 5.3
test('pr 5.3: a _base- worktree still holding the run branch keeps it, with one stderr line, and exits 0', (t) => {
  const fx = handPrRun(t);
  const tree = runBranchTree(fx);

  const out = run(fx.project, fx.home, 'finish', '--status', 'done');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(runBranches(fx.project), [fx.runBranch]);
  assert.ok(fs.existsSync(tree), 'finish never removes a tree');
  const lines = stderrLines(out);
  assert.equal(lines.length, 1, out.stderr);
  assert.ok(lines[0].includes(fx.runBranch), lines[0]);
});

// 5.4
test('pr 5.4: paused never deletes; done, failed and aborted (directly and through abort) do', (t) => {
  const paused = handPrRun(t);
  const out = run(paused.project, paused.home, 'finish', '--status', 'paused');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(runBranches(paused.project), [paused.runBranch], 'paused keeps the branch');
  assert.deepEqual(stderrLines(out), []);

  for (const status of ['done', 'failed', 'aborted']) {
    const fx = handPrRun(t);
    const finished = run(fx.project, fx.home, 'finish', '--status', status);
    assert.equal(finished.status, 0, `${status}: ${finished.stderr}`);
    assert.deepEqual(runBranches(fx.project), [], `finish --status ${status} deletes the empty branch`);
  }

  const viaAbort = handPrRun(t);
  const aborted = run(viaAbort.project, viaAbort.home, 'abort');
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.equal(readRunJson(viaAbort).status, 'aborted');
  assert.deepEqual(runBranches(viaAbort.project), [], 'abort ends through finish, which deletes it');
});

// 5.5
test('pr 5.5: a pr run with an item merged keeps the run branch whatever the status', (t) => {
  for (const status of ['done', 'failed', 'aborted', 'paused']) {
    const fx = handPrRun(t);
    setQueue(fx, { 'task-1': 'merged' });

    const out = run(fx.project, fx.home, 'finish', '--status', status);

    assert.equal(out.status, 0, `${status}: ${out.stderr}`);
    assert.deepEqual(runBranches(fx.project), [fx.runBranch], status);
  }
});

// 5.6
test('pr 5.6: finish on a merge run and a branch run touches no branch', (t) => {
  for (const mode of ['merge', 'branch']) {
    const fx = basedFixture(t);
    assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project, '--merge-mode', mode).status, 0);
    const before = allRefs(fx.project);

    const out = run(fx.project, fx.home, 'finish', '--status', 'done');

    assert.equal(out.status, 0, `${mode}: ${out.stderr}`);
    assert.equal(allRefs(fx.project), before, mode);
    assert.deepEqual(stderrLines(out), [], mode);
  }
});

// 5.7
test('pr 5.7: the delete is HEAD-independent — a root on another branch than the target still deletes', (t) => {
  const fx = handPrRun(t);
  gitOk(fx.project, 'checkout', '-q', '-b', 'elsewhere');

  const out = run(fx.project, fx.home, 'finish', '--status', 'done');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(runBranches(fx.project), []);
  assert.equal(gitOk(fx.project, 'symbolic-ref', '--short', 'HEAD').trim(), 'elsewhere');
});

/* --- #322: the stale-plan mark ---------------------------------------------------------------------------------------
   An execute session whose Outcome opens `Plan no longer holds: …` is recognised by `inspect`, staged `ungroomed --plan-stale`,
   and the mark it files — keyed by the plan's own hash — refuses the item at every later `plan`/`init` until a re-groom changes
   that plan. The hash is computed here by hand, the way the mark's reader must compute it, so a tool that hashed something else
   (the working copy, the whole body, the untrimmed text) is a red test rather than a tool agreeing with itself. */

const STALE_ID = 'task-5';
const STALE_REL = `backlog/tasks/open/${STALE_ID}-fixture.md`;
const stalePlanHash = (planText) => createHash('sha256').update(planText.replace(/\r\n/g, '\n').trim()).digest('hex');
const staleMarks = (home, project) => path.join(projStateDir(home, project), 'stale-plans.json');

function writeStaleTask(project, plan, { id = STALE_ID, extra = '' } = {}) {
  const file = path.join(project, 'backlog', 'tasks', 'open', `${id}-fixture.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nid: ${id}\ntitle: Some task\ncreated: 2026-08-01\n${extra}---\n\n## Goal\n\nSomething.\n\n## Plan\n\n${plan}\n## Done when\n`);
  return file;
}

// A files run on a real git store whose one queue item is a ready task, committed on `main`.
function staleRun(t, plan = 'Edit the handler and add a case for it, in enough detail to count as groomed.\n') {
  const fx = orchFixture(t);
  writeStaleTask(fx.project, plan);
  commitEverything(fx.project, 'seed');
  const init = run(fx.project, fx.home, 'init', '--project', fx.project);
  assert.equal(init.status, 0, init.stderr);
  fx.runId = JSON.parse(init.stdout).runId;
  return fx;
}

// The session's half: an Outcome in the item's conventional worktree, `.worktrees/<id>`, which is where `inspect` and `stage --plan-stale` both
// read it when the run recorded no worktree of its own. Excluded from git so a later `commitEverything` never carries it onto `main`.
function writeStaleOutcome(fx, firstLine, id = STALE_ID) {
  fs.appendFileSync(path.join(fx.project, '.git', 'info', 'exclude'), '.worktrees/\n');
  const file = path.join(fx.project, '.worktrees', id, 'backlog', 'tasks', 'open', `${id}-fixture.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nid: ${id}\ntitle: Some task\ncreated: 2026-08-01\n---\n\n## Plan\n\nx\n\n## Outcome\n\n${firstLine}\n\nEvidence: abc1234\n`);
}

const markStale = (fx, id = STALE_ID) => run(fx.project, fx.home, 'stage', id, 'ungroomed', '--plan-stale');

function planJson(fx, id = STALE_ID) {
  const out = run(fx.project, fx.home, 'plan', '--project', fx.project, '--json');
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout).find((item) => item.id === id);
}

test('#322 inspect 15: a worktree Outcome whose first line is the marker reports planStale; any other Outcome reports null', (t) => {
  const stale = inspectFixture(t, { state: 'open', outcome: false });
  fs.appendFileSync(
    path.join(stale.worktree, 'backlog', 'tasks', 'open', `${INSPECT_ID}-fixture.md`),
    '\n## Outcome\n\nPlan no longer holds: the handler it edits was deleted in abc1234\n\nEvidence: git log -p …\n'
  );
  assert.equal(inspectOut(inspectCmd(stale, INSPECT_ID)).planStale, 'Plan no longer holds: the handler it edits was deleted in abc1234');

  // The main tree carries an ordinary Outcome in this fixture; a wrong-tree read would answer from it.
  const fine = inspectFixture(t, { state: 'done', outcome: true });
  assert.equal(inspectOut(inspectCmd(fine, INSPECT_ID)).planStale, null);
});

test('#322 inspect 15, tracker: the outcome file is read the same way, a leading ## Outcome heading skipped', async (t) => {
  const bare = await trackerInspect(t, 'Plan no longer holds: X\n\nevidence\n');
  assert.equal(bare.out.status, 0, bare.out.stderr);
  assert.equal(JSON.parse(bare.out.stdout.trim()).planStale, 'Plan no longer holds: X');

  const headed = await trackerInspect(t, '## Outcome\n\n  Plan no longer holds: Y\n');
  assert.equal(JSON.parse(headed.out.stdout.trim()).planStale, 'Plan no longer holds: Y');

  const ordinary = await trackerInspect(t, 'Verification: pnpm test — 12 passed\n\nPlan no longer holds: not first\n');
  assert.equal(JSON.parse(ordinary.out.stdout.trim()).planStale, null);
});

test('#322 stage 16: --plan-stale on any stage but ungroomed, with a --note, or with no marker line to read is exit 1 and writes nothing', (t) => {
  const fx = staleRun(t);
  const before = fs.readFileSync(runFile(fx.home, fx.project), 'utf8');

  // No Outcome yet: there is no marker for the tool to read, so there is no mark to file.
  const noMarker = markStale(fx);
  assert.equal(noMarker.status, 1);
  assert.match(noMarker.stderr, /does not open with a `Plan no longer holds:` line/);

  writeStaleOutcome(fx, 'Plan no longer holds: X');
  const merged = run(fx.project, fx.home, 'stage', STALE_ID, 'merged', '--plan-stale');
  assert.equal(merged.status, 1);
  assert.match(merged.stderr, /--plan-stale is only for `stage <id> ungroomed`/);

  // The marker is the session's prose, which never rides a command line: the tool reads it, and refuses to be handed it.
  const withNote = run(fx.project, fx.home, 'stage', STALE_ID, 'ungroomed', '--plan-stale', '--note', 'Plan no longer holds: X');
  assert.equal(withNote.status, 1);
  assert.match(withNote.stderr, /--plan-stale takes no --note/);

  assert.equal(fs.readFileSync(runFile(fx.home, fx.project), 'utf8'), before);
  assert.equal(fs.existsSync(staleMarks(fx.home, fx.project)), false);
});

test('#322 stage 17 + plan 18: the mark is the plan hash AT BASE, and plan then reads the task ungroomed with the reason', (t) => {
  const plan = 'Edit the handler and add a case for it, in enough detail to count as groomed.\n';
  const fx = staleRun(t, plan);
  // An uncommitted edit in the main tree: the mark must be filed against what `<base>` holds, which is what the gate reads.
  writeStaleTask(fx.project, 'A different plan nobody committed.\n');

  // An apostrophe, a backtick and a `$(…)`: everything that would break or run in a shell argument, harmless read from a file.
  writeStaleOutcome(fx, "Plan no longer holds: the handler's `$(gone)` was deleted");
  const out = markStale(fx);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(queueItem(fx.home, fx.project, STALE_ID).stage, 'ungroomed');
  assert.equal(queueItem(fx.home, fx.project, STALE_ID).note, "Plan no longer holds: the handler's `$(gone)` was deleted");

  const marks = JSON.parse(fs.readFileSync(staleMarks(fx.home, fx.project), 'utf8'));
  assert.deepEqual(Object.keys(marks), [STALE_ID]);
  assert.equal(marks[STALE_ID].planHash, stalePlanHash(plan));
  assert.equal(marks[STALE_ID].detail, "the handler's `$(gone)` was deleted");
  assert.equal(marks[STALE_ID].runId, fx.runId);
  assert.match(marks[STALE_ID].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  const item = planJson(fx);
  assert.equal(item.gate, 'ungroomed');
  assert.match(item.reasons[0], new RegExp(`^plan no longer holds \\(run ${fx.runId}, \\d{4}-\\d{2}-\\d{2}\\): `));
  assert.ok(item.reasons[0].endsWith("): the handler's `$(gone)` was deleted — re-groom it"), item.reasons[0]);
});

test('#322 plan 19: a re-groom that changes the plan clears the mark; a CRLF-to-LF rewrite of the same words does not', (t) => {
  const fx = staleRun(t, 'Line one of the plan.\r\nLine two of the plan.\r\n');
  writeStaleOutcome(fx, 'Plan no longer holds: X');
  assert.equal(markStale(fx).status, 0);
  assert.equal(planJson(fx).gate, 'ungroomed');

  writeStaleTask(fx.project, 'Line one of the plan.\nLine two of the plan.\n');
  commitEverything(fx.project, 'line endings only');
  assert.equal(planJson(fx).gate, 'ungroomed', 'the same words are the same plan');

  writeStaleTask(fx.project, 'A re-groomed plan that takes a different approach.\n');
  commitEverything(fx.project, 're-groom');
  const regroomed = planJson(fx);
  assert.equal(regroomed.gate, 'ready');
  assert.deepEqual(regroomed.reasons, []);
});

test('#322 plan 20: an absent, empty or malformed stale-plans.json is no marks, and plan creates no run-state directory', (t) => {
  const { home, project } = planGitFixture(t);
  const ready = () => {
    const out = plan(project, home, '--ids', 'task-1', '--json');
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout)[0].gate;
  };

  assert.equal(ready(), 'ready');
  assert.equal(fs.existsSync(projStateDir(home, project)), false, 'plan must not create the project state directory');

  for (const body of ['', '{garbage', '[]', 'null']) {
    seedSidecar(home, project, 'stale-plans.json', body);
    assert.equal(ready(), 'ready', `stale-plans.json = ${JSON.stringify(body)}`);
  }
});

test('#322 init 21: a new run leaves stale-plans.json in the project directory, and the new queue still reads the mark', (t) => {
  const fx = staleRun(t);
  writeStaleOutcome(fx, 'Plan no longer holds: X');
  assert.equal(markStale(fx).status, 0);
  const marks = fs.readFileSync(staleMarks(fx.home, fx.project), 'utf8');
  assert.equal(run(fx.project, fx.home, 'finish', '--status', 'done').status, 0);
  sleepPastRunIdSecond();

  const second = run(fx.project, fx.home, 'init', '--project', fx.project);
  assert.equal(second.status, 0, second.stderr);

  assert.equal(fs.readFileSync(staleMarks(fx.home, fx.project), 'utf8'), marks);
  const archived = path.join(runsDir(fx.home, fx.project), fx.runId);
  assert.equal(fs.existsSync(path.join(archived, 'stale-plans.json')), false, 'archived away with the previous run');
  assert.equal(planJson(fx).gate, 'ungroomed');
});

test('#322 plan 22: --json items carry drift, and the text output prints a ~ line only for a row whose drift is not none', (t) => {
  const fx = orchFixture(t);
  fs.mkdirSync(path.join(fx.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fx.project, 'src', 'a.ts'), '1\n');
  fs.writeFileSync(path.join(fx.project, 'src', 'b.ts'), '1\n');
  commitEverything(fx.project, 'C1');
  const c1 = git(fx.project, 'rev-parse', 'HEAD').stdout.trim();
  writeStaleTask(fx.project, 'Edit `src/a.ts` until it is right.\n', { id: 'task-5', extra: `groomed-at: ${c1}\n` });
  writeStaleTask(fx.project, 'Edit `src/b.ts` until it is right.\n', { id: 'task-6', extra: `groomed-at: ${c1}\n` });
  commitEverything(fx.project, 'items');
  fs.writeFileSync(path.join(fx.project, 'src', 'a.ts'), '2\n');
  commitEverything(fx.project, 'touch a');

  const json = JSON.parse(run(fx.project, fx.home, 'plan', '--project', fx.project, '--json').stdout);
  const byId = Object.fromEntries(json.map((item) => [item.id, item]));
  assert.equal(byId['task-5'].drift.status, 'drifted');
  assert.equal(byId['task-5'].drift.commits, 1);
  assert.equal(byId['task-5'].drift.anchor, c1);
  assert.equal(byId['task-6'].drift.status, 'none');
  assert.equal(byId['task-5'].gate, 'ready', 'drift is never a verdict');

  const lines = run(fx.project, fx.home, 'plan', '--project', fx.project).stdout.split('\n');
  const rowOf = (id) => lines.findIndex((line) => line.includes(` ${id}  `));
  assert.equal(lines[rowOf('task-5') + 1], `    ~ drifted — 1 commit since ${c1.slice(0, 7)} (groomed-at) touch: src/a.ts`);
  assert.ok(!lines[rowOf('task-6') + 1]?.startsWith('    ~'), `no ~ line under a none row: ${lines.join('\n')}`);
  assert.equal(fs.existsSync(staleMarks(fx.home, fx.project)), false);
});

test('#322 tracker: the mark is the API body\'s plan hash, a footer-only re-stamp keeps it, and a re-groomed body clears it', async (t) => {
  const { home, project } = trackerFixture(t);
  const groomed = `${GROOMED_TASK_BODY}\n<!-- bm:groomed-at ${'a'.repeat(40)} -->\n`;
  const bodies = { 3: groomed };
  const routes = claimRoutes(project, gateRoutes([apiItem(project, 3)], bodies));
  const gateOf = (out) => {
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout).find((item) => item.id === '3');
  };

  await withApi(routes, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    fs.mkdirSync(path.join(projStateDir(home, project), 'outcomes'), { recursive: true });
    fs.writeFileSync(path.join(projStateDir(home, project), 'outcomes', '3.md'), '## Outcome\n\nPlan no longer holds: X\n');
    const staged = await runApi(project, home, port, 'stage', '3', 'ungroomed', '--plan-stale');
    assert.equal(staged.status, 0, staged.stderr);
    const marks = JSON.parse(fs.readFileSync(staleMarks(home, project), 'utf8'));
    assert.equal(marks['3'].planHash, stalePlanHash('Do the real work, described in enough detail to count as groomed.\n'));

    const marked = gateOf(await runApi(project, home, port, 'plan', '--project', project, '--json'));
    assert.equal(marked.gate, 'ungroomed');
    assert.match(marked.reasons[0], /^plan no longer holds \(run .*\): X — re-groom it$/);

    bodies[3] = `${GROOMED_TASK_BODY}\n<!-- bm:groomed-at ${'b'.repeat(40)} -->\n`;
    assert.equal(gateOf(await runApi(project, home, port, 'plan', '--project', project, '--json')).gate, 'ungroomed', 're-stamp only');

    bodies[3] = GROOMED_TASK_BODY.replace('Do the real work', 'Do different real work');
    assert.equal(gateOf(await runApi(project, home, port, 'plan', '--project', project, '--json')).gate, 'ready');
  });
});
