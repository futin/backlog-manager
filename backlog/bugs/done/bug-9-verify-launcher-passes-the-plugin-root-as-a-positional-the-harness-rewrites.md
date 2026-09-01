---
id: bug-9
title: Verify launcher passes the plugin root as a positional the harness rewrites
created: 2026-09-01
tags: orchestrate, skill
---

## Symptom

The skill body that reaches the running session is not the skill body on disk. Step 8's
detached verify launcher reads, in the file:

```bash
nohup sh -c 'node "$1/skills/backlog-orchestrate/tools/orchestrate.mjs" verify <id> --cwd …' sh "$CLAUDE_PLUGIN_ROOT" …
```

Invoked as `/backlog-orchestrate bug-2 bug-3 bug-4 bug-6 bug-7`, the copy delivered into
the session had that `$1` replaced with one of the arguments:

```bash
nohup sh -c 'node "bug-3/skills/backlog-orchestrate/tools/orchestrate.mjs" verify <id> …'
```

The explanatory bullet below it was rewritten to match, so it read as a deliberate
instruction — **"`bug-3`, not `$CLAUDE_PLUGIN_ROOT`, inside the quotes"** — rather than as
corruption. Observed in run-20260901-112815; caught only by grepping the installed
`SKILL.md`, which still said `$1`.

## Repro

Invoke the skill with any positional arguments and compare the delivered body against the
file:

```bash
grep -n 'orchestrate.mjs" verify' \
  ~/.claude/plugins/cache/backlog-manager-marketplace/backlog-manager/*/skills/backlog-orchestrate/SKILL.md
# → $1/skills/...   (the file)
# the session's copy → bug-3/skills/...
```

Substitution reaches inside fenced code blocks; the fence does not protect it.

## Affects

- `skills/backlog-orchestrate/SKILL.md:777` — the only `$1` in the skill, and the only
  place a positional is used to carry a path into a child shell.
- The bullet immediately below it explaining why the positional is used, which the same
  substitution rewrites into an instruction to hard-code an item id.

No other skill in this repo uses `$N` in a fenced block; this is a single site.

## Cause

Slash-command argument substitution expands `$N` in the skill body before the session ever
sees it, and does not exempt fenced code. The skill chose a positional for a good reason —
the quotes around the `sh -c` script have to stay single so `$?` reaches the inner shell
rather than being expanded by the outer one, so `$CLAUDE_PLUGIN_ROOT` cannot appear inside
them — but the mechanism it reached for is exactly the one the harness rewrites.

**Why this one is worth fixing rather than tolerating:** the failure here was loud —
`node "bug-3/skills/…"` cannot resolve and dies immediately — but that is luck, not
design. A substitution that happens to produce a *readable* path fails silently, and this
particular command is the merge gate's launcher: a `verify` that never runs writes no
`.status`, and step 8's "no `.status` file yet" branch would poll a process that was never
going to appear. The correct behaviour of that branch (never merge on an absent `.status`)
contains the damage, but the run stalls on a step whose failure it cannot name.

Related but distinct from bug-2's cwd hazard: that one is about where a command runs, this
one is about the command text being rewritten in transit.

## Fix

Carry the path in a named environment variable instead of a positional. `env` sets it for
the child without the outer shell expanding anything inside the single quotes, and no
substitution pass rewrites a name:

```bash
nohup env BM_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT" BM_RUN_DIR="<dir>" \
  sh -c 'node "$BM_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" verify <id> --cwd "$PWD/.worktrees/<id>" > "$BM_RUN_DIR/verify/<id>.out" 2>&1; echo $? > "$BM_RUN_DIR/verify/<id>.status"' \
  > /dev/null 2>&1 &
```

`$?` still reaches the inner shell — single quotes are unchanged, which is the constraint
that drove the original design. Two further gains worth taking in the same edit:

- **`<dir>` stops being a hand-substituted placeholder** in the longest line of the skill.
  It is currently pasted four times into one command, and every paste is a chance to point
  a redirect at the wrong run directory.
- **The explanatory bullet survives delivery.** Rewritten to explain `env` rather than
  `$1`, it contains no `$N` for the substitution to touch, so the prose that justifies the
  construction cannot itself be corrupted into justifying something else.

Rewrite that bullet to say *why* a named variable and not a positional — naming this bug —
so the next person who finds `env` verbose does not "simplify" it back.

Check the rest of the skill for any other `$N`: at the time of filing there is exactly one,
and a guard test is cheaper than re-checking by hand.

## Test cases

In `skills/backlog-orchestrate/tools/orchestrate.test.mjs`, alongside the existing guards
that already assert things about `SKILL.md`'s own text (the `--permission-mode auto` pair
from bug-3 is the precedent):

1. Guard: no `$1`–`$9` appears anywhere in `skills/**/SKILL.md`. This is the regression
   that matters — the construction is easy to reintroduce and impossible to notice, since
   the corrupted copy never touches disk.
2. Guard: step 8's launcher passes `BM_PLUGIN_ROOT` and `BM_RUN_DIR` through `env`, and the
   `sh -c` script body is still single-quoted (the `$?` constraint).
3. Behavioural: run the launcher shape against a stub that exits non-zero and assert
   `.status` holds that code — proving `env` did not break the exit-code capture, which is
   the one thing this line exists to do.

## Done when

`pnpm test` and `pnpm run typecheck` pass, no `$N` remains in any `SKILL.md`, and step 8's
launcher resolves the plugin root and the run directory from named variables.

## Outcome

2026-09-01 — Fixed, by hand rather than through `backlog-execute`: the bug was found by
running the skill in run-20260901-112815 and fixed in the same session, at the user's
request, immediately after being filed.

Step 8's launcher now reads:

```bash
nohup env BM_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT" BM_RUN_DIR="<dir>" sh -c 'node "$BM_PLUGIN_ROOT/…" verify <id> --cwd "$PWD/.worktrees/<id>" > "$BM_RUN_DIR/verify/<id>.out" 2>&1; echo $? > "$BM_RUN_DIR/verify/<id>.status"' > /dev/null 2>&1 &
```

The `sh -c` body stays single-quoted, so `$?` still reaches the inner shell — the
constraint that drove the original positional. `<dir>` is substituted once into `env`
instead of three times into one line.

The explanatory bullet was rewritten to explain `env` and to name this bug, and the
"Four details" count above it became "Five" (the `<dir>` point is now its own bullet).

Two guards in `orchestrate.test.mjs`, both **mutation-checked rather than merely watched
to pass** — the launcher was reverted to `$1` and both went red, then restored:

```
not ok 88 - no fenced block under skills/ reads a positional parameter
not ok 89 - step 8's verify launcher carries its paths in named env variables
# pass 103
# fail 2
```

The first is the one that matters: it sweeps every `.md` under `skills/` for `$1`–`$9`
inside a fence, because the corrupted copy never touches disk and no amount of reading
the file finds it. `$0` is excluded deliberately (it names the shell, not an argument).
Prose may still say `$1` — this bug's own explanation has to be able to.

**Test case 3 from `## Test cases` was not implemented.** It proposed running the launcher
shape against a stub to prove `env` did not break the exit-code capture. The guard asserts
the single quotes are intact, which is the property that capture depends on, and a stub
test would have exercised `env` and `sh` rather than anything this repo owns. Named here
rather than silently dropped.

Verified: 261 → 108 orchestrate tests green (`node --test`), full skill suite green,
`pnpm test` 515/515 across 35 suites, `pnpm run typecheck` clean.
