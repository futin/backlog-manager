// `merge-check`, the leftover probe and worktree creation: what the run checks before it merges, and the tree it cuts for an item.
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
  GROOMED_BUG_BODY,
  MC_ID,
  apiItem,
  basedFixture,
  branchList,
  commitEverything,
  effectiveStop,
  gateRoutes,
  gitOk,
  leftover,
  mergeCheck,
  mergeCheckFixture,
  readRunJson,
  run,
  runApi,
  runAs,
  runFile,
  seedReadyTask,
  stageOf,
  trackerFixture,
  treeListing,
  withApi
} from './orchestrate-test-lib.mjs';

// --- merge-check: the base tree and both merge preconditions -----------------
//
// SKILL.md §9 used to spell out finding the tree that holds the base, creating
// one when none does, and the two preconditions on it, as ~7.6k chars of prose a
// model re-read every turn. `merge-check <id>` runs that sequence. The cases
// below ARE the behaviour the prose used to describe, run against real temp git
// repos — including the three outcomes of the base-tree scan, which no test
// could execute while they lived in markdown.

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
  // git's own wording is quoted verbatim, and it changed in 2.42: "is already checked out at" became "is already used by worktree at". Both are
  // accepted so the suite holds on an older git too — node:22's Debian image ships 2.39 (docs/workflows/ci.md's Linux repro), this Mac 2.50.
  const quoted = verdict.detail.match(/\(git: fatal: 'feature\/x' is already (?:used by worktree|checked out) at '(.*)'\)/);
  assert.ok(quoted, verdict.detail);
  assert.equal(
    verdict.detail,
    `feature/x is checked out at ${holder} but not cleanly (${quoted[0].slice(1, -1)}) — branch backlog/${MC_ID} kept for a manual merge`
  );
  assert.equal(quoted[1], holder);
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
