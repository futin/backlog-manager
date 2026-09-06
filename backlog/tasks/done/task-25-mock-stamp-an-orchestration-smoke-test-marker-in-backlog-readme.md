---
id: task-25
title: Mock: stamp an orchestration smoke-test marker in backlog README
created: 2026-09-06
tags: mock, smoke-test
updated: 2026-09-06T11:58:05Z
started: 2026-09-06T11:54:44Z
execute-elapsed: 201
execute-tokens: 8002
---

## Goal

A deliberately trivial item, filed to exercise the orchestrator end to end after the
recent orchestration fixes — worktree creation, headless execute session, commit on
`backlog/task-25`, review, verify, merge to `main`, archive. It carries no product
value and is safe to revert with a single `git revert -m 1`.

It touches exactly one file, and that file is documentation the app never reads, so a
failure anywhere in the pipeline cannot leave the running stack in a broken state.

## Plan

Append a single HTML-comment marker as the last line of `backlog/README.md`:

```
<!-- orchestration smoke test: task-25 -->
```

Nothing else. Do not reflow, reword or otherwise correct the surrounding README — that
file's real drift (missing `refactors` row, stale section list) is task-24's scope and
duplicating it here would put two items in conflict over the same file.

Leave the existing trailing newline intact; the marker goes on its own line after the
current last line.

## Test cases

- `backlog/README.md` ends with the marker line, exactly as written above.
- The section table and every existing line of the README are byte-identical to before.
- No file outside `backlog/README.md` is modified.

## Done when

```
pnpm test
```

```
pnpm run typecheck
```

- The diff for this item is one added line in `backlog/README.md` and nothing else.

## Outcome

2026-09-06 — Appended the single marker line `<!-- orchestration smoke test: task-25 -->`
as the last line of `backlog/README.md`. Nothing else in that file was touched: the
section table and every existing line are byte-identical, and the diff for the item is
one added line plus this item file's own lifecycle keys and this section.

The worktree had no `node_modules` (a fresh linked worktree does not inherit the main
tree's install), so `pnpm test` first failed with `sh: jest: command not found`;
`pnpm install --frozen-lockfile` fixed it. `pnpm run typecheck` resolved `tsc` from an
ancestor `node_modules/.bin` even before that and passed both times.

Diff:

```
diff --git a/backlog/README.md b/backlog/README.md
index c408b31..d173900 100644
--- a/backlog/README.md
+++ b/backlog/README.md
@@ -12,3 +12,4 @@ section has a fixed id prefix used when naming its items.
 | ideas         | idea   | open -> done  |
 | tasks         | task   | open -> done  |
 | out-of-scope  | oos    | flat          |
+<!-- orchestration smoke test: task-25 -->
```

`pnpm run typecheck`:

```
$ tsc --noEmit
typecheck exit=0
```

`pnpm test`:

```
$ jest --runInBand
Test Suites: 76 passed, 76 total
Tests:       1397 passed, 1397 total
Snapshots:   0 total
Time:        99.722 s
Ran all test suites.
```
