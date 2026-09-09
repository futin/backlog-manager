---
id: bug-34
title: question-mode prompt-composition test flakes with a 400 under the full suite
created: 2026-09-07
tags: tests, flaky, agents, question-mode
---

## Symptom

`test/question-mode.test.ts`'s case `composes ids, then the merge-mode flag,
then the question-mode flag` fails intermittently under a full `pnpm test`
run, with:

```
expected 201 "Created", got 400 "Bad Request"
```

The 400 is the shape `POST /api/agents/orchestrate` returns for a malformed
`ids` list or a malformed mode — so the request the test built was rejected as
invalid rather than spawning. Which of the three 400 paths it took is not
recorded; the assertion fires on the status code before anything reads the
body.

## Repro

Intermittent, not deterministic. Observed during task-30's execute session:
**1 failure in 4 consecutive full `pnpm test` runs** on the task-30 worktree.
The suite passes **3 of 3 in isolation** (`pnpm run test:jest -- question-mode`),
which is what makes a full-suite-only interaction the first thing to look at
rather than the case itself.

Nothing in task-30's diff is read by jest — it touched `skills/`, `CLAUDE.md`,
`README.md`, `docs/` and `.claude-plugin/plugin.json`, none of which any jest
test opens — so this is pre-existing and not that branch's doing.

Note `jest --runInBand` is already the configured runner (`pnpm run
test:jest`), so plain cross-file parallelism is not the explanation; shared
mutable module state, a leaked env var, or a per-suite mock left installed by
an earlier file are the shapes that survive `--runInBand`.

## Affects

- `test/question-mode.test.ts:230` — the failing case.
- `server/src/agents/agents.controller.ts` — the 400s on the orchestrate
  route: a malformed `ids` list, an invalid `mergeMode`, an invalid
  `questionMode`. CLAUDE.md's invariant is that a present-but-invalid mode is
  a 400 and never a clamp, so the 400 itself is correct behaviour — the
  question is why the request arrived invalid.
- `server/src/agents/agents.service.ts` — `ORCHESTRATE_PROMPT` and the
  `orchestrate()` composition the case is pinning.

## Cause

unknown

## Fix

unknown
