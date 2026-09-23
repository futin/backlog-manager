---
id: task-52
title: orchestrator:queued — ninth tracker label and BacklogItem.queued
created: 2026-09-23
---

## Goal

Add `orchestrator:queued` as the ninth tracker label and expose it on items as `BacklogItem.queued?: true`, so later tasks can write it and the board can read
it. Spec: [docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md](docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §1, §4.1. Plan: [docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md](docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md) Task 1 — read both first, and read the Global Constraints and Review Focus sections of the plan.

## Plan

1. `server/src/tracker/labels.ts`: append `{ name: 'orchestrator:queued', color: <neutral, e.g. bfdadc>, description: "In a live orchestrator run's queue, not
   yet picked up — a plan, not a claim" }` to `TRACKER_LABELS`; export `QUEUED_LABEL = 'orchestrator:queued'` (later tasks import it, never spell the
   string); update the header comment's "eight" → "nine".
2. `shared/types.ts`: `BacklogItem.queued?: true` beside `runnerFix?: true` — `true | absent`, never `false`, for the reason `runnerFix`'s declaration gives.
3. `server/src/tracker/map-issue.ts`: `queued` from `names.includes(QUEUED_LABEL)`, key set only when true; add the label to the `tags` exclusion (~line
   157) and update its comment from four to five CONSUMED labels.
4. No literal code was planned on purpose — write it, and disagree with the plan where the code shows it is wrong.

## Test cases

- `test/tracker-labels.test.ts`: `TRACKER_LABELS.length === 9`; last entry is `orchestrator:queued`; `QUEUED_LABEL === 'orchestrator:queued'`.
- `test/tracker-map.test.ts`: `type:task` + `orchestrator:queued` → `queued: true`, and `tags` excludes the label; `type:task` alone → `'queued' in item === false`.
- A file-store item never has the `queued` key.
- `test/tracker-poll.test.ts` (bootstrap): a repo with the existing eight labels → exactly one `createLabel`, named `orchestrator:queued`; all nine present → none.

## Done when

The cases above pass, `pnpm test` and `pnpm run typecheck` are green, and no reader (gate, queue builder, claim) reads `queued`.
