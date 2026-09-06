---
id: bug-32
title: After a clean merge, worktree remove is refused by the ignored dist/ that verify's build left behind, and the merged item is parked
created: 2026-09-06
tags: skills, orchestrate
---

## Symptom

An item merges to `main` cleanly, then the run's `attention` list gains a `parked` entry
for it anyway, and the run strip and Runs view show a merged item as needing a human:

> merged; worktree /…/.worktrees/task-19 would not remove cleanly (Directory not empty —
> an untracked dist/ from the verify build is all that is left) — delete it by hand after
> looking, then `git worktree …`

Two occurrences in two different runs of this repo, both after a green merge:
`run-20260903-112622` bug-14 and `run-20260905-213627` task-19. In both, the only
content left in the worktree was `dist/` (~404K), which is git-ignored and was produced
by the item's own `pnpm run build` verification command minutes earlier.

## Repro

1. Verify an item whose verification list includes a build that writes an ignored
   output directory into the worktree (`pnpm run build` → `client/dist` / `dist/` here).
2. Merge it (§9). `git -C "$PWD" worktree remove "$PWD/.worktrees/<id>"` (SKILL.md ~1228,
   1341, 1431) refuses with "Directory not empty" because `git worktree remove` without
   `--force` declines any worktree that holds untracked *or ignored* files.
3. The skill's refusal path records the item with `attention … --kind parked` and leaves
   the directory, so a person is paged for build output.

`git status --porcelain` in that worktree is empty at that moment — the item is
committed and merged, nothing uncommitted exists — so `--force` there can only delete
ignored files. §10's "--force deletes uncommitted work" warning (~1630) is about a
different state.

## Affects

- `skills/backlog-orchestrate/SKILL.md` §9 "Merge" cleanup (~1228, ~1341–1350, ~1431): plain `git worktree remove`, refusal → `parked`
- `skills/backlog-orchestrate/tools/orchestrate.mjs` ~2949: the abort path already uses `worktree remove --force`, so the tool has a precedent for the forced form
- Every project whose verification builds into the worktree (this one, claude-agents-dashboard)

## Cause

unknown

## Fix

unknown
