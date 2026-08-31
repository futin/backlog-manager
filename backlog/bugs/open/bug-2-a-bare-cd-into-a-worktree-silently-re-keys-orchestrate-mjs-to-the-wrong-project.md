---
id: bug-2
title: A bare cd into a worktree silently re-keys orchestrate.mjs to the wrong project
created: 2026-08-31
tags: orchestrate, cli
---

## Symptom

After any shell command leaves the session's cwd inside a per-item worktree, every
later `orchestrate.mjs` call resolves to the *worktree* rather than the project, and
reports that no run exists:

```
$ node .../orchestrate.mjs heartbeat
no run exists for this project — run `orchestrate.mjs init --project <path>` first
$ pwd
/Users/…/backlog-manager/.worktrees/task-3
```

Exit `3`. The live run is untouched and perfectly healthy — the tool is simply looking
in a directory nothing ever writes.

The failure is quiet in the way that matters: exit `3` is also the ordinary "no run
yet" answer, so an unattended loop that treats `3` as "nothing to do" reads a healthy
run as absent. Nothing is written, nothing is corrupted, and nothing says the project
was misidentified.

## Repro

Observed live during the first real `backlog-orchestrate` run (run-20260831-211011,
item task-3), not reconstructed afterwards:

```bash
# from the project root, with a run already live
cd "$PWD/.worktrees/task-3" && pnpm exec jest --version   # any ad-hoc probe
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" heartbeat
# → exit 3, "no run exists for this project"
cd /path/to/project-root
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" heartbeat
# → exit 0, run is intact
```

The probe does not have to be an `orchestrate.mjs` command, and that is the whole
point — it was a one-off `pnpm exec jest --version` run to check binary resolution.
Any command that leaves the shell inside the worktree arms the trap for every call
after it.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs` — the cwd walk to the nearest
  `.git` that resolves "which project". A linked worktree has its own `.git` (a file,
  not a directory), so the walk terminates there and produces a valid-looking,
  wrong answer.
- `skills/backlog-orchestrate/SKILL.md` — "Where commands run, and why it is not
  negotiable" already documents this hazard in full, and mandates the
  `( cd … && … )` subshell form. It scopes that rule to the two `cd` sites the skill
  itself prescribes (the resume and abort `backlog.mjs stop` calls). Nothing covers a
  `cd` the operator introduces for an unrelated reason.
- `CLAUDE.md` — the "`orchestrate.mjs` is always invoked from the project root"
  invariant, which reasons the same way and reaches the same scope.

## Cause

Known, and deliberate as far as it goes. `orchestrate.mjs` resolves the project by
walking up from its own cwd to the first `.git`, exactly as `backlog.mjs` does. Inside
a linked worktree that walk finds the worktree's own `.git` file first and keys the run
under the worktree's path — a location nothing else reads.

The repo already reasoned about this and chose to leave the tool quiet, putting the
rule in the skill instead: *"A loud failure would be safer; this one is quiet, which is
exactly why the rule belongs here rather than in the tool."*

What this bug adds is that the chosen mitigation does not cover the actual failure
surface. A prose rule can only bind the commands the prose knows about, and the trap is
armed by commands the skill never mentions — anything at all that lands the shell in
the worktree. The skill's own two `cd` sites were never the likely source; an operator
probing the worktree is.

## Fix

unknown — the shape is a decision, not a discovery.

Two candidates, and they are not exclusive:

1. **Detect and refuse.** On startup, if cwd resolves to a linked worktree (`.git` is a
   file, or `git rev-parse --git-common-dir` differs from `--git-dir`), exit `1` naming
   both paths and the project root to re-run from. This converts the quiet wrong answer
   into the loud failure the invariant already says would be safer, and it costs one
   `git rev-parse`. The argument against is that it puts a git call in front of every
   command, including the ones for which cwd is irrelevant.
2. **Resolve through the common dir.** Walk to `--git-common-dir` instead of the first
   `.git`, so a worktree resolves to the project that owns it and the command simply
   works. Friendlier, and strictly more dangerous: it silently makes a rule the skill
   spends three paragraphs enforcing stop mattering, and the `--worktree` / `--cwd`
   flags exist precisely because *which tree* is not always the same question as *which
   project*.

Whichever is chosen, the prose scope is worth widening too: the current wording reads
as "use a subshell at these two sites", when the rule it needs to convey is "this
session's cwd must be the project root whenever `orchestrate.mjs` is called, no matter
what put it elsewhere."
