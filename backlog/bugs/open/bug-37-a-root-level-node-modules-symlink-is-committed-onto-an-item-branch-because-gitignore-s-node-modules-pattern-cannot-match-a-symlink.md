---
id: bug-37
title: A root-level node_modules symlink is committed onto an item branch, because gitignore's node_modules/ pattern cannot match a symlink
created: 2026-09-18
---

## Symptom

An orchestrator run committed `node_modules` — mode `120000`, target `../../node_modules` — at the repo root of the item branch, and `git status` in the worktree
never showed it as untracked at any point, so nothing before the reviewer had a chance to notice. The reviewer caught it as a Critical on `backlog/task-45`
(run `run-20260918-081422`) and named both consequences: merging that blob into a tree that has a real untracked `node_modules/` **directory** at that path makes
git refuse to clobber it — the merge fails, or leaves the base tree mid-checkout, which is a run-level failure rather than a code defect — and if it does land,
every clone of this repo gets a dangling root symlink resolving outside the repository entirely (`/Users/andrejajevtic/Documents/node_modules` on this machine,
nothing at all elsewhere), breaking module resolution and `pnpm install` for anyone who pulls.

The symlink itself is not the defect and is not going away: an orchestrator worktree has no `node_modules` of its own, and on this machine the verify step cannot
resolve `pnpm`'s dependencies without one (see the standing corepack/pnpm-pin problem this repo also carries). The defect is that the repo's own ignore rule
silently fails to cover it, so a workaround every run on this machine has to apply becomes a commit nobody asked for.

## Repro

In any clone of this repo:

```
git worktree add .worktrees/probe -b probe main
ln -sfn ../../node_modules .worktrees/probe/node_modules
git -C .worktrees/probe status --short        # empty — nothing reports the symlink
git -C .worktrees/probe add -A
git -C .worktrees/probe status --short        # A  node_modules
git -C .worktrees/probe ls-files -s node_modules
                                              # 120000 <sha> 0	node_modules
```

The `add -A` there is exactly what `backlog-orchestrate` §6 runs to commit an item's work, so no unusual step is needed to reach this — an ordinary run on this
machine reaches it every time.

## Affects

- `.gitignore:2` — the pattern is `node_modules/`. A trailing slash matches directories only, and git records a symlink as a blob with mode `120000`, so the
  pattern cannot match one. Nothing else in the file covers it.
- `skills/backlog-orchestrate/SKILL.md` §6 — `git -C "$PWD/.worktrees/<id>" add -A`, whose safety argument is "the worktree is a fresh checkout that nothing else
  has written to". That argument is true of the item's own work and silently untrue of anything the runner itself put in the tree to make verification possible.
- `skills/backlog-orchestrate/SKILL.md` §4's `info/exclude` block — the mechanism that would fix this already exists one section earlier and is applied to
  `.worktrees/` alone.

## Cause

`.gitignore`'s `node_modules/` is a directory-only pattern (gitignore(5): "If there is a separator at the end of the pattern then the pattern will only match
directories"). Git stores a symbolic link as a blob with mode `120000` — a file, not a directory — so the ignore never fires for the link form, and `git add -A`
stages it like any other untracked file. Real `node_modules/` directories are matched correctly, which is why the gap has never shown up before: nothing but an
orchestrator worktree puts a `node_modules` *symlink* at the root of a tree this repo is about to commit from.

Two facts make it invisible rather than merely wrong. `git status` is quiet because the file is untracked and — to a reader — apparently ignored, so the usual
"did anything unexpected come along?" check passes. And the blob's content is a path that resolves correctly *in the worktree that created it*, so nothing about
the branch looks broken until it is merged or cloned somewhere else.

## Fix

Two changes, and the second is the one that generalises:

1. `.gitignore` — replace `node_modules/` with a bare `node_modules`, which matches the directory and the symlink both. It is a one-character deletion and it
   costs nothing: no file in this repo is legitimately named `node_modules`. Worth a comment saying why the slash is absent, since a later tidy-up would
   otherwise "restore" it.
2. `skills/backlog-orchestrate/SKILL.md` — §4 already appends `.worktrees/` to `$(git rev-parse --git-common-dir)/info/exclude`, idempotently, for exactly this
   class of problem. Anything the runner writes into a worktree to make verification possible belongs in that same local exclude before the first dispatch, so a
   run is protected even in a repo whose `.gitignore` has the same gap. State the rule as the rule — the runner's own scaffolding is excluded locally, never
   committed — rather than naming `node_modules` alone, because the next such file will not be called `node_modules` either.

Whether §6's `add -A` should additionally be narrowed is a real question and probably the wrong trade: the reason it is `-A` is that the executor's own work is
not enumerable in advance, which is the whole point of the worktree. The exclude is the cheaper guard.

This item is a candidate for `runner-fix: true` at grooming time — it repairs machinery a run itself depends on, and a run that queues it behind other items will
keep committing the symlink until it lands. That marker is a human's call during grooming, so it is named here rather than written.
