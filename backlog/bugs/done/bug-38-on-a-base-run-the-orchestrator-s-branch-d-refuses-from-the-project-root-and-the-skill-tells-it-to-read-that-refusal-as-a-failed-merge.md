---
id: bug-38
title: On a --base run the orchestrator's branch -d refuses from the project root, and the SKILL tells it to read that refusal as a failed merge
created: 2026-09-18
updated: 2026-09-18T12:00:53Z
started: 2026-09-18T11:42:57Z
execute-elapsed: 1076
execute-tokens: 92149
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

## Outcome

2026-09-18 — fixed. The cause in `## Cause` was re-confirmed against a live repo before anything was changed, and the repro in `## Repro` reproduces exactly as
written (one correction: the item worktree has to be removed first, or git refuses earlier still with `cannot delete branch … used by worktree at`, which is
what §9's ordering already does):

```
--- merge into base tree ---
Merge made by the 'ort' strategy.
--- branch -d from project root (HEAD=main) ---
error: the branch 'backlog/probe' is not fully merged
hint: If you are sure you want to delete it, run 'git branch -D backlog/probe'
--- branch --merged <base> settles it ---
  backlog/probe
--- branch -d in base tree ---
Deleted branch backlog/probe (was 7536935).
```

Three changes to `skills/backlog-orchestrate/SKILL.md` §9:

1. The "On success" block's delete now runs in the base tree — `git -C "<base tree>" branch -d backlog/<id>`.
2. The paragraph below it is rewritten so the refusal is read against the tree the delete ran in: from the base tree it is real evidence the merge did not
   happen, from anywhere else it is evidence only that the command was pointed at the wrong tree, and `git branch --merged <base> | grep backlog/<id>` settles
   which before either is believed. The general rule — every cleanup command that follows a merge belongs in the tree that merge happened in — is stated
   alongside it, as `## Fix` asked, for the next command someone adds to that block.
3. The third `## Affects` bullet asked for the same shape to be looked for elsewhere in §9 and §10, and it found one: `git -C "$PWD" diff --name-only HEAD^1
   HEAD`, the runner-fix pickup. It is HEAD-relative for the same reason and was reading `main` on a `--base` run — measured as `fatal: ambiguous argument
   'HEAD^1'` on a root whose HEAD has no second parent, and silently as some unrelated earlier merge's file list where it does. A merged runner fix would go
   unnoticed for the rest of the run. Now `git -C "<base tree>" diff --name-only HEAD^1 HEAD`.

Every other `git -C "$PWD"` command in the file was checked and none is affected: `show-ref --verify refs/heads/…`, every `worktree` verb (`add`, `remove`,
`list`) and the `diff`/`log` calls given an explicit `<base>...backlog/<id>` range are all HEAD-independent, so the project root is the right place for them.
The line between the two kinds is whether a command **depends on** the invoking tree's HEAD, which is not the same as naming it — see the re-review below,
where that distinction was got wrong first time round. The branch-mode path keeps its branch on
purpose and was not touched, and `references/recovery.md`'s abort path uses `-D`, which does not test reachability and so is not affected either.

Four guards added to `skills/backlog-orchestrate/tools/orchestrate.test.mjs`. They read the SKILL's text rather than exercising behaviour because the SKILL body
*is* the runner — no code executes these commands, a headless driver does, so reading the file is the only place a wrong `-C` can be caught before a run:

- `no branch delete in SKILL.md runs in the project root`
- `the runner-fix pickup diffs the merge commit, which is the base tree's HEAD`
- `SKILL.md reads a branch -d refusal against the tree it was run in`
- `every project-root git command in SKILL.md is on the HEAD-independent allowlist` — the general guard (rewritten at re-review; see below)

Verification (`node scripts/test-all.mjs`, both runners):

```
Test Suites: 118 passed, 118 total
Tests:       1878 passed, 1878 total

# tests 582
# pass 582
# fail 0

PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
```

Contract sweep: 3 sites updated (CLAUDE.md, docs/subsystems/invariants.md ×2)
Red proof: 4 tests went red with the change reverted

The sweep's one deliberate omission: `backlog/tasks/done/task-13-hoist-a-runner-fix-item-to-the-front-of-an-orchestrator-run.md:141` still quotes
`git -C "$PWD" diff --name-only HEAD^1 HEAD`. It is an archived item's record of what task-13 shipped at the time, which was true then; rewriting a `done/`
item's history to match a later fix would make the archive a worse record, not a better one.

Not fixed here, and out of this item's scope: this is inert for the *next* run until this repo's HEAD is pushed and `pnpm run plugin:sync` has run — the run
that merges it can pick it up within-run through §9's runner-fix path, which is itself one of the two things repaired above.

### Re-review — 2026-09-18, three Important findings, all accepted

The reviewer returned `verdict: fix` on one defect stated in three places, and it was a real one. The criterion I wrote into `CLAUDE.md`,
`docs/subsystems/invariants.md` and the fourth guard was **syntactic** — "the commands that may stay at the project root are the ones that never name HEAD" —
where the property that decides it is **semantic**: does the command depend on the HEAD of the tree it runs in. `git branch -d backlog/<id>` contains no
`HEAD` anywhere and is wholly HEAD-relative, so the rule as written licensed the exact command this item exists to move. Measured, old criterion against the
reviewer's four counterexamples:

```
### the OLD guard's criterion, applied to the counterexamples:
PASSES   git -C "$PWD" branch -d backlog/<id>
PASSES   git -C "$PWD" branch --merged <base>
PASSES   git -C "$PWD" branch --contains backlog/<id>
PASSES   git -C "$PWD" status --short

### the NEW guard, same counterexamples injected into SKILL.md one at a time:
CAUGHT   git -C "$PWD" branch -d backlog/<id>
CAUGHT   git -C "$PWD" branch --merged <base>
CAUGHT   git -C "$PWD" branch --contains backlog/<id>
CAUGHT   git -C "$PWD" status --short
```

`CLAUDE.md` and `invariants.md` now state the criterion as *depends on* HEAD, naming `branch -d` as the case that depends on it without naming it, and keep the
three permitted shapes as a list of things that are HEAD-independent by construction rather than as an instance of the wrong rule.

The fourth guard is rewritten as a **closed allowlist**, which is the honest answer to what a text guard can pin here. "Depends on the invoking tree's HEAD" is
a fact about git's semantics, not about the string, so no regex over a markdown file can detect it; what a text guard can do is fail closed. Every
`git -C "$PWD"` line in SKILL.md must now match one of four shapes — `show-ref --verify`, the `worktree` verbs, and `diff`/`log` given an explicit
`<base>...backlog/<id>` range — each recorded in the test with the reason it is HEAD-independent, and anything else is red until whoever adds it decides which
side of the line it falls on. Its comment says exactly that and no longer claims to detect HEAD-dependence. The three earlier guards are unchanged, and
SKILL.md §9 is untouched by this pass — the reviewer did not object to it and it is already committed in `af3c115`.

Also taken from the review's Minor notes: two lines this diff had left over `printWidth: 160` were rewrapped (`invariants.md`'s runner-fix paragraph, which I
had widened by inserting into an existing line, and the `CLAUDE.md` bullet). The `<base tree>`-under-branch-mode ambiguity the reviewer raised is left alone
deliberately — it is pre-existing, `§9` reads as unreachable in branch mode, and widening this item into it is not what it was groomed for.

Verification after the re-review, both runners (`node scripts/test-all.mjs`):

```
Test Suites: 118 passed, 118 total
Tests:       1878 passed, 1878 total

# tests 582
# pass 582
# fail 0

PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
```

Contract sweep: 3 sites updated (CLAUDE.md, docs/subsystems/invariants.md ×2) — the same three sites as the first pass, restated with the corrected criterion
Red proof: 4 tests went red with the change reverted — and the fourth additionally goes red on `git -C "$PWD" branch -d backlog/<id>`, which is the case the
version the reviewer rejected let through
