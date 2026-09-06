---
id: task-25
title: Mock: stamp an orchestration smoke-test marker in backlog README
created: 2026-09-06
tags: mock, smoke-test
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
