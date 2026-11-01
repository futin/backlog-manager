// `cleanup` after a merge or a branch-mode stop, and `inspect`, files and tracker.
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// The namespace import is for exports a later case reaches for by name, so a missing export fails ITS case rather
// than the whole file's link step.
import * as orch from './orchestrate.mjs';
import {
  INSPECT_ID,
  SCRIPT,
  STREAM_DENIAL,
  STREAM_NO_RESULT,
  STREAM_USAGE,
  branchList,
  commitEverything,
  effectiveStop,
  gitOk,
  inspectCmd,
  inspectFixture,
  inspectLogs,
  inspectOut,
  mergeCheck,
  mergeCheckFixture,
  orchFixture,
  queueItem,
  readRunJson,
  run,
  runAs,
  runFile,
  seedReadyTask,
  stageOf,
  trackerInspect,
  treeListing
} from './orchestrate-test-lib.mjs';

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

  if (process.getuid?.() === 0) return t.skip('root ignores the 0555 bit the survivor needs');
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(locked, 'inner', 'file.txt'), 'x\n');
  fs.chmodSync(path.join(locked, 'inner'), 0o555);
  const survivor = orch.finishFailedDelete(locked);
  assert.equal(survivor.gone, false);
  // Node 26 reports this delete as `ENOTEMPTY, Directory not empty` (the parent's rmdir, after the child's unlink failed); node 22/24 as EACCES (#294).
  assert.match(survivor.error, /EACCES|EPERM|ENOTEMPTY|permission|not empty/i);
});

test('cleanup 3c: a delete git cannot finish, run for real — unregistered, the directory survives, the entry quotes the error, the branch still goes', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores the 0555 bit that makes git’s delete fail');
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
    // Node 26 words this failure `ENOTEMPTY, Directory not empty`; node 22/24 `EACCES` (#294).
    assert.match(attention[0].detail, /EACCES|EPERM|ENOTEMPTY|permission|not empty/i, 'the entry does not quote the error');
    assert.equal(stageOf(fx), 'merged');
    assert.equal(out.branchDeleted, true, 'the registration is gone, so the merged branch is deletable');
  } finally {
    fs.chmodSync(path.join(tree, 'locked'), 0o755);
  }
});

test('under uid 0 the three tests that need the 0555 bit report skip, never a pass that checked nothing (#428)', () => {
  // Node's runner reports a bare `return` as a pass, so a root run looked like it had proved what it never ran. Each file runs in its own child with `getuid`
  // answering 0 — the child's own check is all this reads, so the case holds for a real root too — and NODE_TEST_CONTEXT goes, or a child under `node --test`
  // would answer in the parent's serialized protocol instead of TAP.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const cases = [
    ['orchestrate-cleanup.test.mjs', ['cleanup 3b', 'cleanup 3c']],
    ['orchestrate-usage.test.mjs', ['git worktree remove: ignored build output']]
  ];
  for (const [file, names] of cases) {
    const patterns = names.map((name) => `--test-name-pattern=^${name}`);
    const out = spawnSync(
      process.execPath,
      ['--import=data:text/javascript,process.getuid=()=>0', '--test-reporter=tap', ...patterns, path.join(path.dirname(SCRIPT), file)],
      { encoding: 'utf8', env }
    );
    assert.equal(out.status, 0, out.stderr);
    for (const name of names) {
      const line = out.stdout.split('\n').find((l) => /^\s*(not )?ok \d+ - /.test(l) && l.includes(name));
      assert.match(line ?? '', /^\s*ok \d+ - .* # SKIP root ignores the 0555 bit/, `${name} under uid 0:\n${out.stdout}`);
    }
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
  // #322: the Outcome read moved into `readItemOutcome`, shared with `stage --plan-stale`, so the item lookup is asserted there.
  for (const needle of ['cmdStage(', 'applyUsageEntry(', 'readPermissionDenials(', 'readItemOutcome(', 'writeSnapshot(']) {
    assert.ok(body.includes(needle), `cmdInspect no longer calls ${needle}`);
  }
  assert.doesNotMatch(body, /spawnSync|'merge'|'push'/);
  const reader = source.slice(source.indexOf('function readItemOutcome('), source.indexOf('\nfunction ', source.indexOf('function readItemOutcome(') + 1));
  assert.ok(reader.includes('findItemFilePath('), 'readItemOutcome no longer calls findItemFilePath(');
  assert.doesNotMatch(reader, /spawnSync/);
});
