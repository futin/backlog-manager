---
id: bug-4
title: Dispatch buttons stay enabled for items an orchestrator run owns
created: 2026-09-01
tags: ui, board, orchestrator
updated: 2026-09-01T07:45:31Z
groom-elapsed: 127
---

## Symptom

While an orchestrator run is live, the items sitting in its queue keep their normal
Groom/Execute dispatch control on the board — enabled, full tone, no explanation. Clicking
one opens the launch sheet and spawns a second Claude session against an item the
orchestrator has already claimed (or is about to claim), in the main tree, while the run
holds that item in its own worktree on `backlog/<id>`. Two sessions then write the same
item file, and the manual one can archive or move the item out from under the run's next
stage.

The run strip above the columns knows the queue perfectly well — the cards below it do not.

## Repro

1. Start a run: `/backlog-orchestrate` on a project with two or more groomed items (or the
   toolbar Orchestrate control).
2. With the run strip showing `running`, look at a card whose id is in the queue at
   `pending`, `dispatched`, or any mid-pipeline stage.
3. The card's tear-off dispatch tab and the drawer's dispatch chip are both enabled.
4. Click either — the launch sheet opens and the dispatch goes through.

## Affects

- client/src/components/board/DispatchButton.tsx:56 — the gate call; `dispatchGate(item,
  status)` is the whole decision, and `AgentsStatus` carries nothing about runs.
- shared/agent.ts:253 — `dispatchGate` / `projectDispatchGate`: five ladder lines, none of
  them run-aware.
- client/src/components/board/ItemCard.tsx:203, client/src/components/board/ItemDrawer.tsx:258
  — the two render sites, neither of which passes run data down.
- client/src/components/board/BoardView.tsx:130 — already holds `runs` from
  `useOrchestratorRuns`, so the data is present one level above both render sites.
- shared/types.ts — `RunQueueItem.stage` / `RunStage` is the vocabulary any new check would
  read: the mid-pipeline stages are the claimed ones, `merged` / `failed` / `skipped` /
  `needs-answers` / `ungroomed` / `parked` are not.

## Cause

`dispatchGate` (shared/agent.ts:253) reads exactly two things: a `BacklogItem` and an
`AgentsStatus`. Neither carries any notion of an orchestrator run, and neither can — the
run file is a separate payload served by a separate module (`GET /api/orchestrator/runs`),
and an item's *file* deliberately says nothing about being in a run.

That last part is the non-obvious half, and it is why no existing signal already covers
this. An orchestrator run works each item inside its own git worktree and nothing reaches
`main` until the item merges, so while a run has `task-7` at `reviewing`, the `task-7` file
that `/api/items` scans on `main` looks untouched: no `started:` stamp, no `phase:` key,
nothing `isInProgress` (client/src/lib/item-progress.ts:13) could key off. The item is not
lying — it is telling the truth about `main`. RunStrip.tsx:47 already documents this for its
own reason. So "this item is claimed by a run" exists in exactly one place, the run payload,
and every surface that needs it has to be handed it explicitly.

Half that plumbing already exists and was built for display only: BoardView.tsx:289 builds
`runStagesByProject` from `freshRuns` and passes `runStage` into each ItemCard, which renders
it as a badge (ItemCard.tsx:192). Nothing feeds that stage into the gate beside it, the
drawer's `DispatchButton` (BoardView.tsx:546) is passed no run data at all, and the server's
own `dispatch()` re-check (agents.service.ts:233) is `dispatchBlock` alone — also run-blind.
The result is three independent surfaces that all say "go ahead".

## Fix

A run claim becomes a fourth kind of dispatch block, one implementation in `shared/`, checked
on the board and again on the server — the same "one implementation, every side imports it"
shape `environmentBlock` / `projectDispatchGate` already have, and for the same reason.

**1. `shared/types.ts` — the stage partition.**

Export `RUN_CLAIMED_STAGES`, the eight non-terminal `RunStage` members: `pending`,
`preflight`, `dispatched`, `inspecting`, `reviewing`, `fixing`, `verifying`, `merging`.
Placed next to `RunStage` and `RUN_STALE_MS` because it is a partition of that union, and a
new stage added to the union has to be classified here in the same edit.

`pending` and `preflight` are in the list deliberately. A pending item is already claimed —
the run will reach it without asking anyone, and a manual session that grooms or archives it
first leaves the run dispatching into an item that moved under it. The six terminal exits
(`merged`, `failed`, `skipped`, `needs-answers`, `ungroomed`, `parked`) are all out: the run
is finished with that item and a human picking it up by hand is the intended next move.
`parked` especially — a park exists to hand the item back to a person.

**Do not reuse `ACTIVE_RUN_STAGES` (ItemCard.tsx:25) for this and do not unify the two.**
That list answers a different question ("does this card show a live stage badge") and
correctly excludes `pending`/`preflight`, which this one must include. They overlap by six
members today and are not the same rule.

**2. `shared/agent.ts` — the one lookup and the one reason string.**

Export `runClaimBlock(item, runs): string | null`, taking the runs payload
(`OrchestratorRunsPayload['runs']`, the `fresh`-bearing shape both sides already hold).
It finds a run whose `project === item.projectPath` **and** `fresh === true`, then a queue
entry whose `id === item.id` whose `stage` is in `RUN_CLAIMED_STAGES`, and returns a reason
naming the stage — e.g. `an orchestrator run is working this item (reviewing)` — or `null`.

The `fresh` filter, not just `status === 'running'`: a stale run has stopped reporting, and
`freshRuns` is already the rule every other run-derived surface uses (RunStrip renders
nothing, `runStagesByProject` is built from it). A crashed run may still hold a worktree, so
blocking on staleness is arguable — but that is a recovery problem `--resume`/`--abort` owns,
and cards dead until someone runs one of those is a worse failure than the one this bug fixes.

One function doing the lookup, not a stage→reason helper each side calls after its own
lookup: the `fresh` filter and the project/id match are exactly the parts a second copy would
get subtly wrong, and `environmentBlock`'s own doc comment records that having already
happened once in this file.

**3. Server — `plan()` and `dispatch()`.**

`AgentsService` already has `this.orchestrator` injected (agents.service.ts:352 uses
`this.orchestrator.runs()` for the orchestrate lock), so no new wiring.

- `plan()` (agents.service.ts:196): `blocked: dispatchBlock(item, status) ?? runClaimBlock(item, this.orchestrator.runs().runs) ?? undefined`, so a sheet opened after the run claimed the item shows the reason instead of a launch button.
- `dispatch()`: after the existing `dispatchBlock` throw, `runClaimBlock` → 409 with the reason. **No `code` field** — `RUN_IN_PROGRESS_CODE` stays the one and only coded 409 in this app (see its doc comment); nothing needs to tell this refusal apart from dispatch's other 409s programmatically.

This second check is the one that actually holds: LaunchSheet fetches its plan once on mount,
so a sheet left open while a run starts still shows an enabled launch button, and only the
server sees the run as it is at click time. Same reasoning as the orchestrate lock's own
re-check.

**4. Client — thread the reason to both render sites.**

- `DispatchButton`: new optional prop `runBlock?: string | null`, folded into the existing `blocked` after the gate. Order is environment-hidden → project-visibility-disabled → run claim; the first still returns `null` (no control at all) and this one disables with a reason, per the invariant.
- `BoardView`: compute `runBlockFor(item)` from the full `runs` list (`runClaimBlock` does its own `fresh` filter, so it does not go through `runStagesByProject`), pass it to `ItemCard` and to `ItemDrawer`.
- `ItemCard`: pass `runBlock` through to its `DispatchButton`. Keep `runStage` as-is — the badge and the block are separate props answering separate questions.
- `ItemDrawer`: new optional `runBlock?: string | null` prop, passed to its `DispatchButton` (ItemDrawer.tsx:258).

### Test cases

`shared/agent.ts` (test/agents-shared.test.ts):

- fresh run, queue entry at each of the eight `RUN_CLAIMED_STAGES` → non-null reason naming that stage.
- fresh run, queue entry at each of the six terminal stages → `null`.
- stale run (`fresh: false`) with the item at `reviewing` → `null`.
- run for a different `project` with a queue entry of the same item id → `null` (two checkouts can both hold `task-1`).
- fresh run for the right project whose queue does not mention this item → `null`.
- no runs at all (`[]`) → `null`.
- `RUN_CLAIMED_STAGES` ∪ the six terminal stages covers every `RunStage` member exactly once — the test that fails when a new stage is added and left unclassified.

Server (test/agents-dispatch.test.ts, test/agents-plan.test.ts):

- `dispatch()` for an item at `reviewing` in a fresh run → 409, reason names the stage, body has **no** `code` key.
- `dispatch()` for the same item once its stage is `merged` → proceeds to spawn.
- `dispatch()` with only a stale run holding the item → proceeds to spawn.
- `plan()` for a claimed item → `blocked` is the run reason.
- precedence: an item that is BOTH claimed by a run and in a project the dashboard cannot see → the existing `dispatchBlock` reason wins (that check runs first).

Client (test/dispatch-button.test.tsx, test/board.test.tsx, test/drawer.test.tsx):

- `DispatchButton` with `runBlock` set → `aria-disabled="true"`, reason in `title` and in the `aria-describedby` span, and a click does not call `onDispatch`.
- `runBlock` set on an item whose environment gate is `hidden` → still renders nothing (order preserved).
- board with a fresh run at `reviewing` → that item's card tab is disabled while an unqueued sibling's is not.
- the same item's drawer chip is disabled too, from the same run payload.
- board with a stale run → card tab enabled.

### Done when

`pnpm test` and `pnpm run typecheck` pass, and on the running board an item in a live run's
queue shows a disabled dispatch control whose reason names the stage, while `POST
/api/agents/dispatch` for that item answers 409 with the same reason.
