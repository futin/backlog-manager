---
id: task-30
title: Build the backlog-retro skill: retro.mjs sweep, record and last, the skill prose, and the documents
created: 2026-09-06
tags: skills, retro, stats, docs
---

## Goal

A sixth plugin skill, `backlog-retro`, per
`docs/superpowers/specs/2026-09-06-backlog-retro-design.md`: a
deterministic tool sweeps every orchestrator run on the machine into one
JSON (cost, turns, context, stage durations, fix loops, verdicts, park
reasons, driver spend by lease id, fitted rates, deltas since the previous
record); the skill labels the fix-verdict reviews, writes the report,
proposes items for a pick, and records the sweep under
`~/.backlog-manager/retro/`, that directory's single writer. The
2026-09-06 hand sweep (27 runs, 83 items, ≈$800) is the baseline the first
record is measured against.

## Plan

Follow `docs/superpowers/plans/2026-09-06-backlog-retro.md` task by task —
read its "How to read this plan" section first: tests are the contract,
code fragments are shapes, there are no commit steps. The nine tasks, one
line each:

1. CLI skeleton and paths — `tools/retro.mjs` (`RetroError`, `main`,
   usage, exit codes) and `tools/lib/paths.mjs` (the four homes,
   `projectDir`, `decodeProjectDir`, `claudeProjectKey`,
   `readRegistryNames`).
2. Run files — `tools/lib/run-files.mjs`: projects, runs, items, stage
   spans with `fixing` split out and `pending` as queue wait, verification
   failure extraction; `sweep` prints a partial `RetroSweep`.
3. Session logs — `tools/lib/sessions.mjs`: filename classification,
   `result` event, context floor/peak/messages, the latest-run join with
   `collision`, `killed` and `usage-mismatch` caveats.
4. Reviews, verify status, totals — `tools/lib/reviews.mjs`,
   `tools/lib/totals.mjs` with the exact key set and the median/p90
   conventions.
5. Rate fit and driver transcript — `tools/lib/rates.mjs` (OLS over ≥ 8
   measured sessions, `estimated: true` on every priced figure),
   `tools/lib/driver.mjs` (by `driver.sessionId`, `no-lease | not-found |
   unreadable`).
6. Deltas, `--text`, `--project` — `newestRecord`, `computePrevious`,
   `renderText`, the unknown-project exit `1`.
7. `record` and `last` — validation of the closed label and status sets,
   filesystem-safe stem, refuse-to-overwrite exit `2`, `last` exit `3`.
8. `SKILL.md` (five steps, six hard limits, labels file shape, kaizen line
   shape) and `references/rationale.md` (baseline table).
9. Documents — `CLAUDE.md` line 3, the Layout skills bullet, one new
   Invariants bullet; `README.md` skill count and list.

Global constraints in the plan apply to every task: zero dependencies, no
import across skills' `tools/`, reads only through the four env-overridable
homes, writes only under the retro home from `record`, tests never touch
the real home.

## Test cases

The plan carries the exact cases and expected values per task; the suite
is `skills/backlog-retro/tools/retro.test.mjs` plus
`skills/backlog-retro/tools/retro-lib.test.mjs`, picked up by
`pnpm run test:skills`'s glob. Headline cases: `claudeProjectKey` on the
two observed paths; `stageSpans` yielding seven from-stage keys and
`queueWaitMin: 2`; `readSession` on a seeded stream-json log giving
`costUsd 5.4632055`, `turns 66`, `denials 2`, `terminated ok`, `context
{floor 55000, peak 120000, messages 5}`; the collision caveat for an item
dispatched in two runs; the Task 4 fixture totals (`merged 2`,
`costUsd.measured 15`, `costPerMerged.measured 7.5`, `fixLoops {1, 1, 2,
22}`, `verdicts {approve 2, fix 1}`, `itemWallMin {45, 60, 60, 30}`); exact
rate recovery from eight synthetic sessions and `null` from seven; driver
sums from three seeded usages with `subagents {2, 150000, 1}`; deltas
against a record fixture; `record` refusing a second write with identical
bytes; `last` exit `3` on an empty home.

## Done when

- `pnpm run test:skills`, `pnpm test` and `pnpm run typecheck` green.
- `node skills/backlog-retro/tools/retro.mjs sweep --text` against this
  machine's real run state prints a headline block whose measured spend
  agrees with the 2026-09-06 baseline ($540.71 over 92 sessions) and
  marks the driver figure `est.`; `--json` is parsable.
- `CLAUDE.md` says six skills and carries the new invariant; `README.md`
  lists `backlog-retro`.
- Published after merge: push and `pnpm run plugin:sync`; the first
  `/backlog-retro` run then produces the first record.
