// The guards over SKILL.md, references/ and the composed dispatch prompts: text the run depends on, checked without running a run.
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readPermissionDenials
} from './orchestrate.mjs';
import {
  SCRIPT,
  STREAM_DENIAL,
  STREAM_NO_RESULT,
  addWorktree,
  orchFixture,
  run,
  runFile,
  seedReadyTask
} from './orchestrate-test-lib.mjs';

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
const STREAM_NO_DENIALS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-no-denials.jsonl');
const STREAM_DENIAL_PARTIAL_TAIL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-denial-partial-tail.jsonl');
const STREAM_TWO_RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-two-results.jsonl');

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
    ['**`unset COREPACK_ROOT;` opens the `sh -c \'…\'` body of every launch line', 'every launch line unsets COREPACK_ROOT inside its sh -c body'],
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
    ['`null` means unknown, never clean', 'an item with no transcript in this run reports denials unknown, never a clean zero'],
    // PR mode: each statement the body gained, its story and rare branches in references/tracker.md (§2 PR mode's run branch, §4, §9, §10 The pull request).
    ['**from here on every `<base>` in this file is the run branch**', 'a pr run records its run branch as base, so every <base> command targets it'],
    ['**Skip both commands when `status --json` shows `mergeMode` `pr`**', "a pr run skips §4's pull, keyed on the requested mode"],
    ['parking this item, then §10\'s _Finishing_', 'stopping the run goes through §10, so a failed finish opens the PR as a done one does'],
    ["gh pr list --head <head> --state open --json url --jq '.[0].url // empty'", 'the finish asks whether an OPEN PR already exists before creating one'],
    ['**When `status --json` shows `mergeMode` `pr`, some item is `merged`', 'the PR gate keys on the requested mergeMode: a degraded pr run opens its PR'],
    ['gh pr create --base <target> --head <head> --title "<title>" --body-file "<bodyFile>"', "the PR is opened by the driver, from pr-draft's head and target"],
    ['pr --url "<url>"', "the PR's url is recorded on the run"],
    ['is not a park and changes no finish status', 'a failed or denied gh pr create is not a park'],
    ['the local run branch is kept and nothing deletes it', 'an opened PR leaves the local run branch in place'],
    ['**In a `pr` run that branch is `prTarget`, never the run branch**', "a pr run's merge list names prTarget, never the run branch"],
    ['PR mode adds no fourth git command', "the push hard limit names gh pr create as PR mode's one extra remote write"],
    // Groom drift: the one statement §5 gained; the story is references/rationale.md §5.
    ['`stage <id> ungroomed --plan-stale` — no `--note`, the tool reads that line itself — then skip review, verify, retry and park', 'a plan-stale Outcome is staged ungroomed with its mark, and nothing else runs on it']
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

  // A prefix, not the whole bold label: since execute's `pr` finish mode the label goes on to name its one exception, and the marker clause is what this pins.
  const bulletStart = text.indexOf('- **Never commits, never pushes');
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

test('every launch line unsets COREPACK_ROOT first thing inside its sh -c body', () => {
  // #294: a driver started under a parent `pnpm` inherits COREPACK_ROOT, and the execute session it spawns runs pnpm through its own Bash tool, where the
  // variable makes a non-corepack pnpm refuse the packageManager pin. It opens the body — never a prefix on `exec`, where its `;` would detach `exec` from the
  // `cd … &&` and `test -s … &&` guards — and never sits in front of `nohup`.
  const lines = execClaudeLines(fs.readFileSync(SKILL_MD, 'utf8'));
  assert.equal(lines.length, 3, `expected exactly 3 headless launch lines, found ${lines.length}`);
  for (const line of lines) {
    const body = line.slice(line.indexOf("sh -c '") + "sh -c '".length, line.lastIndexOf("'"));
    assert.ok(body.startsWith('unset COREPACK_ROOT; '), `launch line does not open its sh -c body with \`unset COREPACK_ROOT;\`: ${line}`);
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
