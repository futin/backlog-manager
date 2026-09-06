---
id: bug-27
title: Every item stays hand-dispatchable for the whole spawn-to-init window of a board-started run
created: 2026-09-06
tags: orchestrator, dispatch
---

## Symptom

Click Orchestrate on the board. The `StartingStrip` appears at once — the server knows a
run was requested for this project. Every item's dispatch control stays **enabled** anyway,
for the whole stretch between the spawn and the moment the spawned session runs
`orchestrate.mjs init`. Click one and a hand `backlog-execute` session starts on an item the
inbound run is about to claim.

Measured on `run-20260906-115323` (this repo, task-25):

| event | time (UTC) |
|---|---|
| spawned session boot (first transcript row) | 11:41:57 |
| `init` wrote `run.json` | 11:53:23 |
| window in which items are dispatchable but claimed | **11m26s** |

That gap is the boot + a 1360-line SKILL.md read + the §1 `plan` turn. CLAUDE.md already
documents it as 1–5 minutes; this measurement says it can be more than double that.

## Repro

1. Board, a project with at least one groomed bug or task, agents enabled.
2. Click Orchestrate, Start.
3. `StartingStrip` renders. The dispatch button on every queued item is still live.
4. Click one before `run.json` appears — a second session starts on the same item.

## Affects

- `client/src/components/board/DispatchButton.tsx` — the four-way block ladder.
- `client/src/components/board/BoardView.tsx:513` — `runBlockFor`.
- `server/src/orchestrator/starting-runs.service.ts` — the knowledge that is not being used.
- `shared/agent.ts` — `runClaimBlock`, the block this needs a sibling to.

## Cause

The block is `runClaimBlock` (`shared/agent.ts`), which reads the run payload's `runs`
array — a verbatim view of `run.json`. That file does not exist until SKILL.md §2, so for
the whole spawn→init window there is no queue, no `pending` stage, and nothing for the
predicate to find. Correct, given its inputs.

`StartingRunsService` holds exactly the missing fact — `Map<project, requestedAt>`, marked
from `AgentsController` after the awaited spawn — and rides the payload as the separate
top-level `starting` array. That array is deliberately scoped: it renders `StartingStrip`
and nothing else. The scoping decision (CLAUDE.md, task-14) was about not putting a
synthetic member into `runs`, where it would reach `aggregateRuns`, `ArchiveView`,
`RunsView` and every exhaustiveness site. It was *not* a decision that dispatch may proceed
during the window — that consequence was simply never separated out.

Not a polling fault: `useOrchestratorRuns` polls every `POLL_MS` (5s) for as long as
`starting.length > 0`, and a `starting` entry lives `RUN_STALE_MS` (15 min), which covered
the 11m26s here. Once `init` lands the button does disable within one tick with no refresh.
The observed "had to refresh" was a refresh that happened to fall after `init`.

## Fix

Add a **fourth** per-item block, fed by `starting`, ranked LAST — below the run claim, for
the same reason the run claim ranks below the file-derived `progressBlock`: it is the least
fundamental and the most volatile of the four. Ladder becomes environment → project
visibility → in progress → run claim → run inbound.

Shape, matching what is already there:

- A named predicate in `shared/agent.ts` beside `runClaimBlock` — one implementation, since
  `AgentsService` must refuse the same dispatch server-side or the block is cosmetic. It
  takes `OrchestratorRunsPayload['starting']` and the item, and matches on `projectPath`
  alone; there is no queue yet, so it cannot be per-item and must block **every** open bug
  and task in that project.
- `BoardView` threads it to `DispatchButton` as a prop next to `runBlock`, optional and
  defaulted `null` so existing callers and tests are unchanged.
- The reason string names the state honestly: a run is starting on this project and has not
  reported its queue yet. It must not claim to know this item is in the queue — a narrowed
  `--ids` run may not include it, which is the one real cost of blocking by project.

That cost is the judgement call in this item and should be stated in the outcome: a
narrowed run blocks hand dispatch on items it will never touch, for minutes. It is the
right trade against a double-dispatch, and it is bounded by the `RUN_STALE_MS` expiry the
`starting` entry already has, but do not fix it by guessing which items the run will claim.

Do NOT reach for the alternative of having the server call `init` itself to close the
window — CLAUDE.md rejects it explicitly: the spawned session would then hit `init` exit `4`
(lock held), whose documented answer is "never retry".

## Test cases

- An item whose project has a `starting` entry and no `running` run: dispatch disabled,
  reason names the starting run.
- Same item once a `run.json` with a queue arrives: the run-claim reason wins, not the
  starting one (ladder order).
- An item in a *different* project with the `starting` entry: unaffected.
- `POST /api/agents/dispatch` for a blocked item answers the same refusal shape the run
  claim already produces — the block cannot be client-only.
- The starting entry expires (`RUN_STALE_MS`) with no run file: dispatch is live again.

## Done when

```
pnpm test
```

```
pnpm run typecheck
```

- The gap is closed at both layers, and the narrowed-run cost is recorded in the outcome.
