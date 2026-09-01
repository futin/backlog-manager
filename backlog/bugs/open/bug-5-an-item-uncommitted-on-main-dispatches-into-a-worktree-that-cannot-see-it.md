---
id: bug-5
title: An item uncommitted on main dispatches into a worktree that cannot see it
created: 2026-09-01
tags: orchestrator, skills
---

## Symptom

An item that has been groomed but whose file is not yet committed on `main` passes
`plan` and `init` as `ready`, gets a worktree, and is dispatched — into a worktree
whose `backlog/` does not contain it. `git worktree add … main` checks out `main`'s
*commit*, and the item exists only in the main tree's working copy.

The headless session does not fail. It finds the item by absolute path in the main
tree and works there: on run-20260901-073202 (task-7) it appended `## Outcome` to
`/…/backlog-manager/backlog/tasks/open/task-7-….md` with `cat >>` and moved that file
to `tasks/done/`, then filed a new capture (bug-4) into the main tree's `backlog/`
too. Meanwhile the code changes landed correctly in the worktree.

The result is one item split across two trees: its code on `backlog/<id>`, its
lifecycle uncommitted in the main tree. The branch carries no archive move, so the
merge commit for that item does not close it out; the item's own archive arrives
later as a loose working-tree change with no commit of its own, and anyone reading
`main`'s history sees a merge that changed only source files.

Nothing warns. Every stage — plan, init, execute, review, verify, merge — reports
success, and the run summary reads 1/1 merged.

## Repro

1. Groom an item so it reads `ready`, but do not commit its file.
2. `orchestrate.mjs plan --project "$PWD" --ids <id>` → `ready`. `init` accepts it.
3. `git worktree add .worktrees/<id> -b backlog/<id> main`.
4. `ls .worktrees/<id>/backlog/tasks/open/` — the item is absent.
5. Dispatch `claude -p "/backlog-execute <id>"` in that worktree. The session
   completes; `git -C .worktrees/<id> status` shows code changes and no item file,
   while `git -C "$PWD" status` shows the item archived in the main tree.

## Affects

- skills/backlog-orchestrate/tools/orchestrate.mjs — `buildGatedQueue` and the
  `plan`/`init` commands read the item store from the working tree, which is the
  right store for a board and the wrong one for deciding what a worktree will
  contain.
- skills/backlog-orchestrate/SKILL.md:§4 — `git worktree add … main` is the step
  where the two views diverge; nothing between it and dispatch re-checks that the
  item survived the checkout.
- skills/backlog/tools/backlog.mjs:94 — `resolveRoot` is *not* at fault and should
  not be changed: its `existsSync` walk handles a worktree's `.git` file correctly
  and would have resolved to the worktree. The session bypassed it entirely by
  operating on an absolute path it found by searching.

## Cause

`plan`/`init` gate on the working copy; the worktree is built from `HEAD`. The two
disagree for exactly as long as an item is uncommitted, which is the normal state of
an item the moment grooming finishes — so the window is not an edge case, it is the
default one for "groom, then immediately run".

Why it degrades into a cross-tree write rather than a clean refusal: the item is
genuinely missing inside the worktree, so `backlog.mjs show <id>` there exits 1, and
a capable session treats that as a lookup problem rather than a stop condition. It
searches, finds the only copy that exists — the main tree's — and proceeds. Every
guarantee the worktree exists to provide (isolation, one item's diff, a reviewable
branch) is silently out of scope for those writes, and
`--dangerously-skip-permissions` means nothing prompts.

What a fix has to choose between, for whoever grooms this:

- refuse at the gate — `plan`/`init` compare each candidate's path against
  `git ls-files`/`HEAD` and mark an uncommitted item `ungroomed` (or a new verdict)
  with "not committed on main" as the reason;
- verify after the checkout — the loop re-checks that the item file exists inside the
  freshly created worktree and parks it if not, which also catches an item committed
  on a different branch;
- commit it first — the orchestrator stages and commits pending `backlog/` changes on
  `main` before starting, which contradicts "the only thing this skill commits is a
  worktree branch" and would need that invariant amended deliberately, not quietly.

The second is the cheapest and catches strictly more cases than the first; the third
is the only one that lets a just-groomed run proceed without a manual step.

## Fix

unknown
