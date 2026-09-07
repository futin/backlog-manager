---
id: bug-33
title: pnpm test intermittently reports one supertest failure that never reproduces
created: 2026-09-07
tags: tests, ci, orchestrator
---

## Symptom

A full `pnpm test` occasionally reports **exactly one** failed test out of ~1500, always a
supertest request assertion, and the same suite passes on the very next run of the same
command against the same tree. Nothing in the diffs that triggered it touches server code,
`shared/`, or the guard under test.

This is a merge-gate problem, not a cosmetic one. `backlog-orchestrate` §8 makes the exit
code of `pnpm test` the only thing that green-lights a merge, and "never merges red" is a
Hard limit with no unrelated-looking-failure escape hatch. So a one-in-N false red parks a
green, reviewed item — or, worse, trains whoever is driving the run to re-run the gate
until it passes, which is exactly the habit that would let a *real* regression through.

Four occurrences observed on 2026-09-06/07, all in run `run-20260906-214634`:

1. **bug-30, verify attempt 1** — `test/agents-resume.test.ts:305` › `502s naming the
   timeout budget when the resume spawn fetch times out`, failing with
   `Parse Error: Expected HTTP/, RTSP/ or ICE/` (a client-side HTTP parse error, not an
   assertion mismatch). `1 failed, 1498 passed`.
2. **task-23, verify attempt 1** — a supertest `_assertStatus` failure, `1 failed, 1515
   passed`. The test name fell outside the captured tail; the stack was
   `Test._assertStatus → Test.assert → localAssert → Server.<anonymous>`, identical in
   shape to 3 below.
3. **task-28, verify attempt 1** — same `_assertStatus` stack, `1 failed, 1531 passed`.
4. **The task-21 execute session, independently** — `test/agents-origin-guard.test.ts:102`
   › `403s a urlencoded POST to dispatch without any outbound call`, `expected 403, got
   400`, twice in roughly 9 full runs.

In every one of the four, re-running the identical command against the identical tree came
back green.

Two observations that belong with it, both from sessions that were not looking for this:

- The **task-21** session chased occurrence 4 deliberately: 11 consecutive green runs with
  its branch reverted, then 12 more green with the branch restored and the failing
  assertion instrumented to dump the response body — never reproduced once, so no body was
  ever captured. Its reading: `OriginGuard.canActivate` is a pure function of the
  `content-type` header, so a `400` means the body parser rejected the request *before* the
  guard ran, which points at process state shared across suites rather than at the guard.
- The **task-28** session saw a variant worth telling apart from the rest: one `pnpm test`
  printed `FAIL jest` while jest's own summary in the same output reported zero failures.
  If that is the same defect it is not merely a flaky test — it is `scripts/test-all.mjs`
  reading a jest exit code that disagrees with jest's own report.

## Repro

No reliable repro. 23 targeted runs by the task-21 session produced none; the four sightings
above all came from `pnpm test` invoked incidentally, three of them by
`orchestrate.mjs verify` inside a fresh per-item worktree.

What is known about the conditions:

- Always the full suite via `pnpm test` (`scripts/test-all.mjs` → `pnpm run test:jest` →
  `jest --runInBand`), never a single-suite run.
- Always exactly one failure, always a supertest request against a Nest test app.
- Two distinct surface errors (a client-side `Parse Error`, and a status mismatch where the
  body parser appears to have rejected first) which may or may not be one root cause — the
  shared factor is a socket or a shared Nest/supertest process resource under
  `--runInBand`, not any assertion's own logic.
- Frequency is roughly 3 in 12 full-suite runs during that window; the machine was loaded
  (an orchestrator run with a headless session, a verify suite and a dashboard dev server
  all live).

A grooming pass should start by trying to reproduce under deliberate load rather than on an
idle machine, and by running the suite in a loop rather than a fixed count.

## Affects

- `test/agents-origin-guard.test.ts:102` — the parametrized `403s a urlencoded POST to
  <route>` case, the only failure whose name was captured directly.
- `test/agents-resume.test.ts:305` — `502s naming the timeout budget when the resume spawn
  fetch times out`.
- `package.json:17` — `"test:jest": "jest --runInBand"`, the shared-process mode both
  suspicions point at.
- `scripts/test-all.mjs` — for the task-28 variant only: `FAIL jest` printed over a
  zero-failure jest summary would be this file's exit-code handling, not a flaky test.
- Consumers of the gate: `skills/backlog-orchestrate/SKILL.md` §8 and
  `resolveVerifyCommands` in `skills/backlog-orchestrate/tools/orchestrate.mjs`.

## Cause

unknown

## Fix

unknown
