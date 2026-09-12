---
id: bug-32
title: After a clean merge, worktree remove is refused by the ignored dist/ that verify's build left behind, and the merged item is parked
created: 2026-09-06
tags: skills, orchestrate
runner-fix: true
updated: 2026-09-12T16:14:26Z
groom-elapsed: 626
groom-tokens: 106432
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

**§9 treats "the removal refused" as one state with one response, and it is two states
that need opposite responses.** Neither occurrence was the state the current prose is
written for, and the fix the bug's own `## Repro` implies (`--force`) could not have
cleaned up either one.

What the two runs actually recorded — driver transcripts
`5cc699d1-08ca-4f95-9355-4ae4f29593df` (bug-14) and
`309af058-c96d-44e6-b40c-34d34d80bb42` (task-19), identical in both:

```
{"id":"task-19","stage":"merged"}
error: failed to delete '/…/.worktrees/task-19': Directory not empty
remove_exit=255
Deleted branch backlog/task-19 (was 838048d).
```

That is not git's clean-check refusal. Re-measured here on `git version 2.50.1 (Apple
Git-155)`, `git worktree remove` has two distinct failures:

- **The clean check refuses** — `fatal: '<path>' contains modified or untracked files,
  use --force to delete it`, exit `128`. **Nothing is deleted**, the worktree is still
  registered, and the leftovers include something that was never committed. This is the
  state §9's "plain `remove`, not `--force`" rule exists for, and it is the one state in
  which `--force` is both available and dangerous.
- **The recursive delete itself fails** — `error: failed to delete '<path>': <errno>`,
  exit `255` (`Directory not empty` in both runs). The clean check **passed** before this
  ran, so git had already certified the tree carried no modified and no untracked files.
  git then deletes in a fixed order: the admin entry `.git/worktrees/<id>` **first**, the
  working directory second. So by the time this error is printed the worktree is already
  **unregistered** — `git worktree list` no longer names it, a `--force` retry answers
  `fatal: '<path>' is not a working tree` (exit `128`), and `git worktree prune` has
  nothing left to prune. Both recorded attention details told a human to run
  `git worktree prune`; both instructions were no-ops.

Ignored build output alone does **not** refuse: a worktree holding nothing but an ignored
`dist/` removes cleanly, exit `0`, dist deleted with it (measured). The bug's `## Repro`
premise — "`git worktree remove` without `--force` declines any worktree that holds
untracked *or ignored* files" — is therefore wrong for this git, and `--force` is a fix
for a failure that never happened here.

Why only `dist/` survived is the ordinary shape of a partially-failed recursive delete,
not a property of ignored files: git deletes the admin entry, walks the tree, and ends
with `rmdir` on the root, which reports `ENOTEMPTY` if the walk missed or could not
remove any entry (a child it cannot unlink, or an entry the readdir/unlink interleave
skipped while something was still writing into the tree). The surviving set is whatever
the pass missed — in the reproduction here a tracked `src/` survived alongside the
ignored `dist/`. So the response must key on **git's own message**, which is exact, and
never on inspecting what is left, which is not.

The consequence is the reported one: every real occurrence (2 of 2) has been the second
failure, where nothing is uncommitted, nothing needs judgement and the worktree is already
deregistered — and §9's single response pages a human with `attention … --kind parked`
over build output, on an item that merged green.

## Fix

**One home for the split: §9's "What happens to the item when that removal refuses"
paragraph (~1466–1481).** The branch-mode cleanup (~1257) and the classifier-denial
cleanup (~1370) already delegate to that paragraph — keep them delegating; do not restate
the split in three places.

Rewrite that paragraph to branch on git's own output, not on a single "it refused":

1. **The first attempt is unchanged and is never forced**, and its status is captured the
   way §9 already captures statuses elsewhere:

   ```bash
   git -C "$PWD" worktree remove "$PWD/.worktrees/<id>"; echo "remove=$?"
   ```

2. **`fatal: … contains modified or untracked files, use --force to delete it`** — today's
   behaviour, kept verbatim: nothing was deleted, the worktree is still registered,
   something in there was never committed, never reviewed and never merged. Park it —
   `attention <id> --kind parked` with the existing "would not remove cleanly —
   uncommitted leftovers to look at" detail — leave the directory and the branch alone,
   the item stays `merged` (or `branched`), and **never** `--force`.

3. **`error: failed to delete '<path>': <errno>`** — a cleanup git began and could not
   finish, on a tree git itself certified clean. State in the prose that the worktree is
   already unregistered, that `--force` answers `is not a working tree` here, and that
   `git worktree prune` is a no-op, so a session does not try any of the three. Finish
   the removal the run started:

   ```bash
   rm -rf "$PWD/.worktrees/<id>"; echo "rm=$?"
   [ ! -e "$PWD/.worktrees/<id>" ]; echo "gone=$?"
   ```

   Record **no attention entry** when `gone=0` — nothing here needs a human, and that is
   the whole point of the fix. Only if the directory survives, park it with the `rm`
   error quoted in the detail (a child git could not unlink is a child `rm` usually
   cannot either).

4. **Guards on the `rm -rf`, written into the prose** — this is the first destructive
   filesystem verb in this SKILL.md and the guards are its entire licence:
   - only in branch 3, i.e. only after git's own `failed to delete`, whose precondition
     is that git's clean check already passed;
   - only the literal `"$PWD/.worktrees/<id>"` path this run created — never a path read
     back from anywhere else, never a bare shell variable that can expand empty;
   - never as a substitute for the first attempt: `git worktree remove` always runs
     first, so dropping the registration stays git's job.

5. Drop `git worktree prune` from the attention detail templates (it was advice that did
   nothing), and keep everything else §9 already guarantees: the item is never re-staged
   to `parked` for a cleanup problem, `stage <id> merged`/`branched` stands, and
   `git branch -d backlog/<id>` still runs after the removal attempt — it succeeded after
   the failure in both recorded runs.

**No tool change.** `orchestrate.mjs` is untouched: `ATTENTION_KINDS` stays
`needs-answers, parked, fix-exhausted`, no new stage, no new run-file field. `--abort`'s
`git worktree remove --force` stays exactly as it is — that path acts on a worktree that
is still registered, which is the one state where `--force` means anything.

Put the measurement — git version, the three measured cases, the exit codes — in
`skills/backlog-orchestrate/references/rationale.md` under §9, not in SKILL.md: SKILL.md
is injected in full into every turn of a run.

### Test cases

`skills/backlog-orchestrate/tools/orchestrate.test.mjs` (node runner,
`pnpm run test:skills`; `pnpm test` runs both runners). Prose cases in the style of the
existing `SKILL.md keeps merge --abort under the conflict branch only`:

- **§9 names both removal failures as distinct cases** — SKILL.md contains both
  `contains modified or untracked files` and `failed to delete`, and the park template
  `would not remove cleanly` sits under the first one only.
- **The split has exactly one home** — `failed to delete` appears once in SKILL.md, and
  the branch-mode and classifier-denial cleanups still carry their cross-reference to it
  rather than a second copy of the rule.
- **Exactly one `rm -rf`, and it is the worktree path** — across all fenced blocks in
  SKILL.md exactly 1 line contains `rm -rf`, and that line is
  `rm -rf "$PWD/.worktrees/<id>"`.
- **`worktree remove --force` never enters a fenced block** in any `skills/*/SKILL.md`
  (the `--abort` mention in §10 is prose and must stay prose).
- **The finished-cleanup branch pages nobody** — the paragraph under `failed to delete`
  says no attention entry is recorded, and `worktree prune` no longer appears in either
  attention detail template.
- **`ATTENTION_KINDS` is still exactly `['needs-answers', 'parked', 'fix-exhausted']`** —
  no cleanup kind was invented.
- **The git assumptions this prose rests on, measured, not asserted** (deterministic; skip
  when `process.getuid?.() === 0`, since root ignores the permission bit). In a temp repo
  with `dist/` ignored and a `git worktree add`ed worktree:
  - only ignored build output present → `git worktree remove` exits `0` and the directory
    is gone (the normal path never needs `--force`);
  - a child directory inside the worktree set to mode `0555` so its files cannot be
    unlinked → `git worktree remove` exits non-zero with stderr matching `failed to
    delete`, `git worktree list --porcelain` no longer lists that worktree, and a
    follow-up `git worktree remove --force` fails with `is not a working tree` (exit
    `128`). Restore the mode in cleanup so the temp tree can be deleted.

Nothing here is user-visible in the browser, so there is no Playwright check.

### After it merges

This is a `runner-fix:` item (frontmatter carries `runner-fix: true`) because it changes
`skills/backlog-orchestrate/SKILL.md`: the run that merges it must follow §9's
"After a runner-fix item lands" rule — re-read the repo's SKILL.md and follow it for the
rest of the run — and the change is inert for the *next* run until it is pushed and
`pnpm run plugin:sync` has reinstalled the plugin.
