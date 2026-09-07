---
id: task-29
title: backlog-groom closes by saying the item is groomed on disk only and must be committed before a run reads it
created: 2026-09-06
tags: skills, groom, orchestrate
updated: 2026-09-07T05:29:31Z
started: 2026-09-07T05:17:17Z
execute-elapsed: 734
execute-tokens: 56231
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

## Outcome

2026-09-07 — Done as planned, prose only, no tool change.

- `skills/backlog-groom/SKILL.md` gained a `## Groomed on disk only` section holding the
  fixed line verbatim, with the `<path>` placeholder and the reasoning behind it (the
  gate reads `<base>`, the five 2026-09-06 skips, why `backlog.mjs` is not given git).
  Promote gained step 8 (print it with the *new task's* path, not the idea's) and
  plan-the-fix step 4 (the bug's own path); the "not printed for a rejection or an idea
  left as one" rule is stated in the section itself.
- Plan step 2: the boundary is in both the front-matter `description:` and the opening
  paragraph — a groom lands on disk only, never commits, and a run reads the commit its
  worktree is created from.
- Plan step 3: `skills/backlog-orchestrate/SKILL.md` §1's "not committed on main"
  explanation now points back at groom's line by name.
- `## Next` no longer says a groomed item is simply ready — it is ready for execute, and
  for orchestrate *once committed*.

Deviations from the plan, both deliberate:

- The plan said "prose only; no tests". Six cases were added to
  `skills/backlog/tools/backlog.test.mjs` instead, which is where this repo already pins
  a skill's prose (`backlog-groom`'s stamp order, `backlog-execute`'s pre-review checks
  and the reviewer half that reads them). The plan's own "Test cases" list is exactly
  what they assert: the verbatim line with its placeholder, both executable verdicts
  pointing at it, the rejection and no-verdict paths NOT carrying it, the not-printed
  rule, the up-front boundary, and orchestrate's back-reference. Reading a file, never
  importing it.
- The orchestrate half is asserted in that same suite rather than in
  `skills/backlog-orchestrate/tools/orchestrate.test.mjs`, even though that tool has a
  suite of its own: the rule is two skills agreeing on one sentence, and a suite reading
  only one half cannot catch them drifting apart. Recorded in CLAUDE.md's Conventions
  entry, which also now lists these cases.

Contract sweep: the change alters one existing sentence (plan-the-fix's `stop` is now its
last *command*, since step 4 follows it) and adds the closing line. Swept `CLAUDE.md`,
`README.md`, `docs/`, `skills/**/*.md`, `agents/*.md` and the test names for the old
spellings ("stop is simply its last step", "Three verdicts", the duplicated groom
description). Two sites found: `CLAUDE.md`'s Conventions list of prose-pinning cases,
updated; and `docs/superpowers/plans/2026-08-28-started-marker-and-in-progress-sort.md`
line 373, left standing on purpose — a dated implementation plan is a record of what was
planned then, like an item's own `## Outcome`, not a live statement of the rule. The
front-matter description exists in exactly one place (no marketplace copy), verified by
grep.

Red proof: all six new cases were written before the prose and run red — 5 failed
outright, and the negative one ("the rejection and no-verdict paths do not carry it")
was proved able to fail by injecting `Groomed on disk only.` into the Reject section
(`not ok 208`), then restoring the file from a copy. No `git stash` used.

```
$ node --test skills/backlog/tools/backlog.test.mjs   # before the prose edits
not ok 206 - backlog-groom carries the on-disk-only line verbatim, path placeholder and all
not ok 207 - both executable verdicts end by pointing at that line
not ok 209 - backlog-groom states which grooms do not print the line
not ok 210 - backlog-groom says the boundary in its own description of what it does not do
not ok 211 - backlog-orchestrate points its "not committed" verdict back at groom line
# pass 206
# fail 5

$ node --test skills/backlog/tools/backlog.test.mjs   # negative case, line injected into Reject
not ok 208 - the rejection and no-verdict paths do not carry it
# fail 1

$ pnpm test
# tests 441
# pass 441
# fail 0
# duration_ms 59912.881708

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.

$ pnpm run test:jest
Test Suites: 80 passed, 80 total
Tests:       1532 passed, 1532 total
Time:        49.272 s

$ pnpm run typecheck
$ tsc --noEmit
(no output)

$ pnpm run build
✓ built in 1.63s
```

Not done here, and outside this session's remit: the item's "Done when" asks for
`push` + `pnpm run plugin:sync` (publishing is the user's act — an install is a copy of
the pushed HEAD) and for the next cross-run sweep to count "not committed on main"
verdicts against the 5 of 83 baseline.
