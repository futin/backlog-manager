---
id: ref-3
title: backlog.mjs and orchestrate.mjs still exit through process.exit and carry the 64KB pipe truncation
created: 2026-09-07
kind: debt
tags: skills, cli, json, stdout
---

## What exists today

Two of the three skill CLIs end the same way:

- `skills/backlog/tools/backlog.mjs:1853` — `process.exit(main(process.argv.slice(2)))`
- `skills/backlog-orchestrate/tools/orchestrate.mjs:3389` — same line

`skills/backlog-retro/tools/retro.mjs:408` is the odd one out and the reason
this item exists: it sets `process.exitCode = main(...)` and lets node drain
and exit on its own, with the reasoning written at `retro.mjs:396-398`.

That difference was not a style choice. During task-30's verification,
`retro.mjs sweep --json` was found **silently truncated at exactly 65,536
bytes whenever stdout was a pipe**: `process.stdout.write` to a pipe is
asynchronous, and `process.exit()` tears the process down without draining it.
A redirect to a file (`> out.json`) is a synchronous write on POSIX and was
always fine — which is exactly why every hand check and every small fixture
passed. A real sweep of that machine was 442,757 bytes and arrived as 65,536
bytes and a JSON parse error.

## Why it should change

The two remaining tools carry the identical defect, latent rather than live:
neither emits 64KB today — `backlog.mjs board --json` measures ~4.5KB on this
repo — so nothing is broken right now. What is being paid is that the
threshold is invisible and the failure is silent. Both tools are read
machine-side by the server and by this repo's own skills, both have `--json`
surfaces whose size grows with the number of items and runs in a project, and
a truncation produces a parse error at the reader with nothing at the writer
to point at. `orchestrate.mjs status --json` in particular grows with queue
length, per-item `usage` entries and verification rows, which is the direction
task-27 and task-31 both pushed it.

The three tools also now disagree on a mechanism with a written rationale in
only one of them, so the next person reading `backlog.mjs`'s exit line has no
signal that the other spelling is the correct one.

## Rough shape

Move both to `process.exitCode = main(...)`, matching `retro.mjs:408`, and
carry its comment across so the reason travels with the line rather than
living in one tool.

The safety condition is the same one `retro.mjs` documents and it must be
re-checked per tool rather than assumed: letting node exit on its own is only
equivalent when nothing is holding the event loop open. `retro.mjs` qualifies
because every read is synchronous `fs` with no server, timer or child process.
`backlog.mjs` looks the same shape and needs confirming. **`orchestrate.mjs`
is the one that genuinely differs** — `watch` polls on timers and spawns
nothing but does sleep, and `verify` runs child processes — so that tool needs
checking command by command before the line changes, and a command that would
hang on a live handle is an argument for an explicit drain rather than for
keeping `process.exit()`.

Pin it the way task-30 did: a test that seeds enough output to exceed the pipe
buffer, runs the CLI with stdout as a **pipe** (not a file), and asserts the
captured bytes exceed 65,536 and parse. A test that redirects to a file cannot
fail on this bug and would be worse than no test.
