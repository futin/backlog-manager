---
id: bug-38
title: On a --base run the orchestrator's branch -d refuses from the project root, and the SKILL tells it to read that refusal as a failed merge
created: 2026-09-18
---

## Symptom

On run `run-20260918-081422` (`--base feature/tracker-backed`, item task-45) the merge into the base succeeded — `Merge made by the 'ort' strategy`, 72 files —
and the very next line of §9's cleanup failed:

```
$ git -C "$PWD" branch -d backlog/task-45
error: the branch 'backlog/task-45' is not fully merged
hint: If you are sure you want to delete it, run 'git branch -D backlog/task-45'
```

The branch was fully merged. It was merged into `feature/tracker-backed`, and the command was run in the project root, which is on `main`.

What makes this worse than a leftover branch is the instruction attached to it. §9 says a `branch -d` refusal "is real information — the merge you think
happened did not, and that _is_ worth stopping to understand before the next item builds on a base you may have misread." On a `--base` run that reading is
exactly wrong, and it is wrong in the direction that stops a healthy run: a driver that believes the merge did not happen has every reason to stop, re-merge, or
park an item that is already in the base. In this run the refusal was diagnosed by hand and the delete re-issued in the base tree; an unattended run has no such
step, and the failure recurs on every item of every `--base` run.

## Repro

Any `--base` run with more than zero merged items reaches it. Minimal:

```
git branch feature/x main
git worktree add .worktrees/x feature/x
git worktree add .worktrees/item -b backlog/probe feature/x
# ... commit something on backlog/probe ...
git -C .worktrees/x merge --no-ff --no-edit backlog/probe    # succeeds
git -C "$PWD" branch -d backlog/probe                        # error: not fully merged
git branch --merged feature/x | grep backlog/probe           # prints it — the merge is real
git -C .worktrees/x branch -d backlog/probe                  # Deleted branch backlog/probe
```

A default `main`-based run never sees it, because there the project root and the tree holding the base are the same directory — which is why this survived every
run before base branches existed.

## Affects

- `skills/backlog-orchestrate/SKILL.md` §9, the "On success" block — `git -C "$PWD" branch -d backlog/<id>`. `$PWD` is the project root; every other command in
  that block was already re-pointed at `<base tree>` when run-scoped bases landed, and this one was not.
- `skills/backlog-orchestrate/SKILL.md` §9, the paragraph immediately below it — "Likewise `branch -d` (safe delete) rather than `-D`: it only succeeds for a
  branch that is actually merged, so a refusal here is real information". True of the verb, false of this invocation, and it is the sentence that turns a stale
  command into a wrong instruction.
- The same shape, unverified, in §9's classifier-denial path and §10: anywhere the run cleans up a branch or names a tree by `$PWD` rather than by the resolved
  base tree is worth re-reading in the same pass. The branch-mode path is deliberately exempt — it keeps the branch on purpose.

## Cause

`git branch -d` tests whether the branch is reachable from **HEAD of the repository the command runs in**, plus its upstream — it has no `--merged-into`, so the
invoking tree *is* the parameter. The project root's HEAD is `main`; the merge commit lives on `feature/tracker-backed`; `backlog/<id>` is unreachable from
`main`, so the safe delete correctly refuses.

This is the same root cause as the invariant already recorded for the merge itself — "**The main tree and the tree holding `main` are not synonyms**" — reaching
one command further than the fix did. §9 resolves the merge site per merge into three exhaustive outcomes and routes `symbolic-ref`, the dirty-path probe and the
merge itself into `<base tree>`; the branch delete kept the pre-base-branch spelling, where `$PWD` was correct because the base was always `main`.

## Fix

In `skills/backlog-orchestrate/SKILL.md` §9's "On success" block, run the delete in the resolved base tree:

```bash
git -C "<base tree>" branch -d backlog/<id>
```

and rewrite the "a refusal here is real information" paragraph so the information it carries is stated against the right tree: a refusal from the base tree means
the merge did not happen and is worth stopping for; a refusal from anywhere else means the command was pointed at the wrong tree. Worth stating the general rule
alongside it — every cleanup command that follows a merge belongs in the tree that merge happened in — since the same mistake is available to the next command
someone adds to that block.

`git branch --merged <base> | grep backlog/<id>` is the check that settles which of the two a refusal is, and is cheap enough to name in the SKILL as the thing
to run before believing either reading.

Not `-D`. The safe delete is doing its job here; the argument it is given is wrong, and forcing past a refusal would discard the real signal the same line is
supposed to preserve.

This item is a candidate for `runner-fix: true` at grooming time — it repairs the runner itself, and until it lands every `--base` run leaves a merged branch
behind and hands its driver a false reading of why. That marker is a human's call during grooming, so it is named here rather than written.
