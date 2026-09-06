---
id: task-29
title: backlog-groom closes by saying the item is groomed on disk only and must be committed before a run reads it
created: 2026-09-06
tags: skills, groom, orchestrate
---

## Goal

An orchestrator run reads each item at `<base>` — the commit its worktree is created
from — never from the working tree, and `parseItemForGate` says so in its own comment.
A bug groomed in the working tree and not committed therefore arrives at the gate as
ungroomed and is skipped with the note "not committed on main — the worktree this run
creates from main would not contain …". That note fired five times across three
projects in the 2026-09-06 sweep: bug-12 twice in this repo (`run-20260901-203305`,
`run-20260902-081119`), bug-13 in claude-agents-dashboard, bug-16 in ixray, and bug-7
in the dashboard, whose `## Fix` was still a list of candidates. Each cost a run slot
and a person a second trip.

`backlog-groom` is the skill that produces the uncommitted state and it ends without a
word about it; its SKILL.md mentions committing once, about something else (line 199).
Committing is the user's act — no skill but orchestrate touches git history — so the fix
is the sentence, said at the moment the state is created.

## Plan

1. `skills/backlog-groom/SKILL.md`'s closing step (the one that prints the groomed item's
   id and path, after `stop`) gains one fixed line, printed for every groom that leaves
   an item executable — a bug with Cause and Fix filled, a task promoted with a plan:

   > Groomed on disk only. A run reads `<path>` at the commit it starts from, so commit
   > it before `/backlog-orchestrate` — uncommitted, the gate skips it as ungroomed.

   The line names the path `groom` just wrote, so a `git add` can be pasted from it. It
   is not printed for a rejection (`out-of-scope/`) or an idea left as an idea, where no
   run would pick the item up anyway.
2. The same sentence, shortened, goes into the skill's description of what groom does
   and does not do (the paragraph that already says filing is capture's job and doing
   the work is execute's), so a reader of the skill's front matter learns the boundary
   before running it.
3. `skills/backlog-orchestrate/SKILL.md` §1's explanation of the "not committed on main"
   verdict points back at groom's line in one clause, so the two skills describe the
   same seam in the same words.
4. No tool change: `backlog.mjs` does not know whether a file is committed, and giving it
   git would make the registry's writer a git reader for a message groom can print on
   its own.

## Test cases

Prose only; the checks that stand in for tests:

- `skills/backlog-groom/SKILL.md` ends its groom path with the line, containing the
  literal `Groomed on disk only` and the item path placeholder.
- The rejection and idea-stays-idea paths do not carry it.
- `skills/backlog-orchestrate/SKILL.md` §1 references the line.
- `pnpm run test:skills` and `pnpm test` unchanged and green.

## Done when

- A groom session in this repo ends by printing the line with the real path.
- Published (`push` + `pnpm run plugin:sync`).
- The next cross-run sweep counts "not committed on main" verdicts against 5 of 83.
