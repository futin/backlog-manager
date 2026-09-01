---
id: bug-8
title: Merge precondition misses a dirty main tree overlapping the branch
created: 2026-09-01
tags: orchestrate, skill, git
---

## Symptom

An item that passed review and passed verification reached step 9, cleared the one
precondition the step actually checks, and then had its merge refused outright:

```
$ git -C "$PWD" symbolic-ref HEAD
refs/heads/main
$ git -C "$PWD" merge --no-ff --no-edit backlog/bug-4
error: Your local changes to the following files would be overwritten by merge:
	client/src/components/board/ItemCard.tsx
Please commit your changes or stash them before you merge.
Aborting
Merge with strategy ort failed.
```

Exit `2`. Observed live during run-20260901-112815, item bug-4, after a clean review
verdict and a green `test`/`typecheck`/`build`.

## Repro

1. Start a run. Let an item reach step 9 with its branch touching some path `P`.
2. Between the run starting and that merge, modify `P` in the main working tree and leave
   it uncommitted (a person working in their own repo while a run drains the queue — the
   ordinary case, not a contrived one).
3. `symbolic-ref HEAD` still prints `refs/heads/main`, so the precondition passes.
4. The merge refuses before it starts.

## Affects

- `skills/backlog-orchestrate/SKILL.md:939` — the step 9 precondition, which checks only
  that `HEAD` is `refs/heads/main`.
- `skills/backlog-orchestrate/SKILL.md:980` — the `git merge --abort` in the **On
  conflict** branch, which is the wrong command for this failure and errors with
  `fatal: There is no merge to abort` when reached from it.
- The prose at step 9 that says *"A dirty main tree is fine as long as the dirt does not
  overlap the branch's paths"* — true, and the step never checks it.

## Cause

Two gaps, one of omission and one of misclassification.

**The precondition is incomplete.** Step 9 verifies *which branch* the main tree is on and
nothing about *what is in it*. The prose one paragraph later states the real requirement —
the dirt must not overlap the branch's paths — as an aside, and no command tests it. The
reasoning behind the pre-flight rule ("only ever edit the item file inside the worktree")
is exactly this hazard, applied to one file; every other path the branch touches has the
same exposure and no equivalent rule.

**A pre-merge refusal is not a conflict, and step 9 has only a conflict branch.** The two
are different states:

- A **conflict** means the merge started, wrote conflict markers, and left `MERGE_HEAD`
  behind. `git merge --abort` is correct and necessary.
- A **pre-merge refusal** means git declined before touching anything. There is no
  `MERGE_HEAD`, nothing was modified, and `--abort` errors. The tree is already in the
  state `--abort` would have restored.

Reading the second as the first sends an unattended run to a command that fails, and the
failure is at the merge gate where the run has the least margin for an unhandled state.

## Fix

Three edits to step 9.

1. **Test the overlap, not just the branch.** After the `symbolic-ref` check, compare the
   branch's changed paths against the main tree's dirty ones and refuse early if they
   intersect:

   ```bash
   git -C "$PWD" diff --name-only main...backlog/<id> | sort > /tmp/branch-paths
   { git -C "$PWD" diff --name-only; git -C "$PWD" diff --cached --name-only; } | sort -u > /tmp/dirty-paths
   comm -12 /tmp/branch-paths /tmp/dirty-paths
   ```

   Non-empty output means the merge will refuse. Naming the overlapping paths *before*
   attempting the merge is what makes the park detail actionable — "merge refused" alone
   sends the user looking, "`ItemCard.tsx` is uncommitted and this branch also touches it"
   does not. Scratch files belong under the run's `<dir>`, not `/tmp` and not the repo.

2. **Give the refusal its own branch, distinct from the conflict.** Do not call
   `git merge --abort` on it. The item parks exactly as a conflict parks — worktree and
   branch kept — but the detail names the overlapping paths and says the tree needs
   committing or stashing, which is a thing the user can act on in one command.

3. **Document the resolve-on-the-branch-side recovery, which currently has no home.**
   When `main` has moved under the run — whether it conflicts or merely overlaps — parking
   is not the only correct answer, and it was not the one taken in the run that found this
   bug. What worked, and what should be written down:

   ```bash
   git -C "$PWD/.worktrees/<id>" merge --no-edit main   # resolve here, not in the user's tree
   # re-run step 8's verification against the combined content
   git -C "$PWD" merge --no-ff --no-edit backlog/<id>   # now conflict-free
   ```

   This keeps the merge gate meaningful: the suite runs on `branch + main` rather than on
   `branch` alone, which is the content that will actually land. Merging into a `main` that
   moved after verification means merging content nothing green ever ran against — a hole
   in the "never merges red" hard limit that is invisible because every individual step
   was green.

   The re-verification is **not optional** and must clear the stale `.status` first, per
   step 8's own `rm -f` rule; this is precisely the second-attempt case that rule exists
   for.

   Park remains the answer when the worktree-side merge conflicts, because resolving a
   real content conflict is a human judgement — the same reasoning step 9 already gives.

## Test cases

`skills/backlog-orchestrate/tools/orchestrate.test.mjs` has fixtures that build real
worktrees and real commits, so this is testable rather than prose-only:

1. Branch touching `a.txt`, main tree with `a.txt` modified and uncommitted → the overlap
   probe reports `a.txt`.
2. Branch touching `a.txt`, main tree with an unrelated `b.txt` modified → the probe
   reports nothing and the merge succeeds (the "dirty main tree is fine" case must stay
   true; over-tightening this into "refuse any dirty tree" would park items for no reason).
3. Branch touching `a.txt`, main tree with `a.txt` **staged** → the probe reports it
   (`diff --cached`, which a `git diff`-only check would miss).
4. Untracked file in the main tree at a path the branch **adds** → the merge refuses too;
   decide deliberately whether the probe covers this and state the answer either way.
5. Worktree-side `git merge main` on a branch whose changes do not conflict → exit `0`,
   and a following merge to main succeeds.
6. A guard asserting step 9's conflict branch and its refusal branch are distinct, and
   that `merge --abort` appears only under the conflict one.

## Done when

`pnpm test` and `pnpm run typecheck` pass, step 9 names the overlapping paths before
attempting a merge, a pre-merge refusal no longer routes to `git merge --abort`, and the
worktree-side resolve path is written down with its mandatory re-verification.

## Outcome

2026-09-01 — Fixed, by hand rather than through `backlog-execute`, in the same session
that hit it (run-20260901-112815, item bug-4) and filed it.

All three edits in `## Fix` landed in step 9:

1. **The overlap probe** — `diff --name-only main...backlog/<id>` against the union of
   `diff --name-only` and `diff --cached --name-only`, intersected with `comm -12`, both
   lists written under the run's `<dir>`. Non-empty output names the exact files that will
   refuse, which is what makes the park detail actionable.
2. **The pre-merge refusal is now its own branch**, with git's actual message quoted, and
   it explicitly does not issue `git merge --abort` — that command answers
   `fatal: There is no merge to abort` in this state, because nothing was modified and
   there is no `MERGE_HEAD`. The conflict branch keeps `--abort`, unchanged.
3. **The worktree-side resolve is documented**, with its re-verification made mandatory:
   `git -C .worktrees/<id> merge --no-edit main`, then all of step 8 again starting with
   its `rm -f`, then merge out. The reasoning is spelled out because it is the part that
   is easy to skip — merging into a `main` that moved after step 8 puts content into main
   that nothing green ever ran, and every individual step still reports green. Park
   remains the answer when the worktree-side merge itself conflicts.

Three guards in `orchestrate.test.mjs`, all **mutation-checked**: the probe was pointed at
a bogus ref and the staged half deleted; the worktree-side merge was rewritten; a second
fenced `merge --abort` was inserted. Each mutation went red and was restored:

```
not ok 89 - SKILL.md keeps merge --abort under the conflict branch only
not ok 90 - step 9 probes the main tree for paths the branch also touches
not ok 91 - step 9 documents resolving on the branch side before parking
```

**Test cases 1–5 were deliberately not implemented, and this is a real deviation from the
plan rather than an oversight.** They proposed real-worktree fixtures asserting that a
dirty overlapping path refuses a merge, an unrelated dirty path does not, a staged change
counts, and so on. Every one of those assertions tests **git's** behaviour, not this
repo's: the probe is shell in a skill body, not code this project owns, so the fixtures
would have encoded git's contract and gone red on a git upgrade rather than on a
regression here. What can regress is the skill body, and that is what the three guards
pin. Test case 4 (an untracked main-tree file at a path the branch adds) was the one worth
answering rather than testing: git refuses that too, and the probe does **not** cover it,
because neither `diff` lists untracked files. Left uncovered knowingly — the merge still
refuses safely, the refusal branch handles it, and widening the probe to
`ls-files --others` would flag every scratch file in the tree.

Verified: 108 orchestrate tests green, full skill suite 261 green, `pnpm test` 515/515
across 35 suites, `pnpm run typecheck` clean.
