---
id: bug-27
title: Every item stays hand-dispatchable for the whole spawn-to-init window of a board-started run
created: 2026-09-06
tags: orchestrator, dispatch
updated: 2026-09-06T18:11:50Z
started: 2026-09-06T18:04:04Z
execute-elapsed: 466
execute-tokens: 41663
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

## Outcome

2026-09-06 — **Already fixed. No code change, and deliberately none.** The gap this item
describes was closed by bug-21 (`8555cd7`, "fix(board): make a starting run block dispatch,
orchestrate and the toolbar"), merged into `main` as `5f48dce` at 20:02 the same day this
bug was captured. The worktree this session was given is branched off that merge, so the
`## Cause` above — "every gate in the app still reads `runs` alone" — no longer holds
against the code as it is.

What bug-21 shipped, checked against this item's own Fix section:

- The predicate lives in `shared/agent.ts` as bug-27 asked, but as a **third required
  parameter on `runClaimBlock`** (`starting: OrchestratorRunsPayload['starting']`) rather
  than as a separate fourth block ranked below it. Observable behaviour is what this item
  specified: the per-item claim wording is returned first and the coarse
  `'an orchestrator run is starting for this project'` only when no fresh run holds the
  item — the same precedence a fourth rung would have produced. It matches on
  `projectPath` alone and blocks every open bug and task in the project.
- Required, no `[]` default, for the reason this item's Fix predicted the shape of: the
  compile error at each of the four call sites is what forced every one of them to decide.
  All four are wired — `BoardView.tsx:522`, `ArchiveView.tsx:201`, `plan()`'s `blocked`
  (`agents.service.ts:314`) and dispatch's own 409 (`agents.service.ts:383`).
- The block is therefore **not client-only**: `POST /api/agents/dispatch` answers 409 with
  the identical string, uncoded like every other dispatch 409.

The one structural difference — one three-argument function instead of two functions and a
fifth ladder rung — was left as bug-21 built it rather than re-split to match this item's
wording. `runClaimBlock`'s three-argument shape is now written into CLAUDE.md as an
invariant ("A starting entry blocks what a run file blocks, on every surface"), and the
argument for one function is the one that file already makes everywhere else: the question
a caller asks is "why does a run forbid dispatching this item", and a starting run is a
run. Splitting it would create two predicates that must agree, which is the exact shape
`watchdogStoodDown` and `isStale` each exist to avoid.

**The narrowed-run cost, recorded as this item requires.** A run launched with `--ids`
naming a subset still blocks hand dispatch on every other open bug and task in that
project, for as long as the window lasts. Nothing can narrow it: a `StartingRun` is
`{ project, requestedAt }`, and even if it carried the launch's `ids`, which items a run
actually queues is `buildGatedQueue`'s verdict inside the spawned session, over `<base>`,
minutes later. The asymmetry settles it — a wrong allow costs a duplicated execution in two
trees, a wrong block costs a wait bounded by the run file landing, or `RUN_STALE_MS`
(15 min) at the very worst, after which the entry expires and dispatch is live again. This
bug's own measurement of the window is the sharp end of that cost: `run-20260906-115323`
took **11m26s** from session boot to `init`, more than double the 1–5 minutes CLAUDE.md
documents.

### Verification

All five of this item's test cases already have a covering test. Confirmed by red-green
rather than by reading them: replacing the starting clause in `runClaimBlock` with
`return null;` failed 7 tests across 5 suites (`agents-shared`, `agents-dispatch`,
`starting-strip`, `archive`, `agents-plan`), then passed again on restore.

| test case | covering test |
|---|---|
| starting entry, no run file → disabled, reason names it | `agents-shared.test.ts:616`, `starting-strip.test.tsx` "disables every card dispatch control with the starting reason" |
| run file with a queue arrives → run-claim reason wins | `agents-shared.test.ts:645` "prefers the per-item wording when a fresh run holds the item AND the project is starting" |
| a different project is unaffected | `agents-shared.test.ts:636` "ignores a starting entry naming a different project" |
| `POST /api/agents/dispatch` refuses the same way | `agents-dispatch.test.ts:433` and `:454` |
| the entry expires at `RUN_STALE_MS` → dispatch live again | `orchestrator-starting.test.ts:155` "drops the entry once it is older than RUN_STALE_MS, and keeps it right up to the boundary" |

Both "Done when" commands, run fresh on an unmodified tree (only this item file differs):

```
$ pnpm run typecheck
$ tsc --noEmit
typecheck exit: 0
```

```
$ pnpm test
$ jest --runInBand

Test Suites: 76 passed, 76 total
Tests:       1469 passed, 1469 total
Snapshots:   0 total
Time:        93.622 s, estimated 113 s
Ran all test suites.
test exit: 0
```

One incidental note for whoever reads the branch: the worktree had no `node_modules`, so
`pnpm install --frozen-lockfile` ran first. It changed no tracked file.
