---
id: bug-4
title: Dispatch buttons stay enabled for items an orchestrator run owns
created: 2026-09-01
tags: ui, board, orchestrator
updated: 2026-09-01T12:39:42Z
groom-elapsed: 127
started: 2026-09-01T12:27:04Z
execute-elapsed: 758
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

## Outcome

2026-09-01 — fixed as the `## Fix` describes, in four layers with the shared
lookup as the single implementation.

- `shared/types.ts` — `RUN_CLAIMED_STAGES`, the eight non-terminal `RunStage`
  members, placed next to the union it partitions. `pending`/`preflight` are in
  it; the six exits are out. Its doc comment states outright that this is NOT
  `ACTIVE_RUN_STAGES` and must not be unified with it.
- `shared/agent.ts` — `runClaimBlock(item, runs)`, one function doing the
  project match, the id match and the `fresh` filter together, returning
  `an orchestrator run is working this item (<stage>)` or null.
- `server/src/agents/agents.service.ts` — `plan()` folds it into `blocked`
  after `dispatchBlock`; `dispatch()` throws 409 with the reason, no `code`
  field, so `RUN_IN_PROGRESS_CODE` stays the only coded 409 in the app.
- Client — `DispatchButton` gained an optional `runBlock` prop folded in after
  the gate (environment-hidden → project-visibility → run claim, so the
  hide-vs-disable invariant is untouched); `BoardView.runBlockFor` feeds it to
  both the card tab and the drawer chip from the full `runs` list.

Three stale comments in `DispatchButton.tsx` were corrected in the same edit —
it now has two per-item disabled states, not one.

The one deviation from the plan: the client cases live in
`test/dispatch-button.test.tsx` rather than being split across `board.test.tsx`
and `drawer.test.tsx`. That file already renders `BoardView`, `ItemDrawer` and
the bare button, and already stubs `/api/items/body` for the drawer, so it is
the one place all three render sites could be pinned against a single run
payload. `board.test.tsx`'s own stub does not answer
`/api/orchestrator/runs` at all.

Both board-level cases were confirmed red-green by hand beyond the initial
compile failure: with the two `runBlock={runBlockFor(...)}` lines removed from
`BoardView.tsx`, `disables the tab of a card a fresh run has claimed` and
`disables the drawer chip for a claimed item` both fail; restored, both pass.

`pnpm run typecheck`:

```
$ tsc --noEmit
```

(no output, exit 0)

`pnpm test`:

```
Test Suites: 33 passed, 33 total
Tests:       493 passed, 493 total
Snapshots:   0 total
Time:        38.531 s
Ran all test suites.
```

The 20 new cases, from the same run:

```
  ✓ names the stage for every stage a run still owns the item at
  ✓ allows dispatch once the run has left the item at a terminal stage
  ✓ allows dispatch when the only run holding the item has gone stale
  ✓ ignores a run for a different project holding the same id
  ✓ allows dispatch when the right project's fresh run does not mention this item
  ✓ allows dispatch when there are no runs at all
  ✓ partitions every RunStage member into exactly one of claimed or terminal
  ✓ refuses to dispatch an item a fresh run is working, naming the stage (58 ms)
  ✓ sends no machine-readable code on the run-claim refusal (101 ms)
  ✓ dispatches an item the run has already merged (62 ms)
  ✓ dispatches an item held only by a stale run (150 ms)
  ✓ reports the dashboard block, not the run claim, when both apply (129 ms)
  ✓ reports a run claim as the reason the launch is blocked (105 ms)
  ✓ leaves the launch unblocked for an item the run has merged (78 ms)
  ✓ disables with the run's reason when a run has claimed the item (4 ms)
  ✓ dispatches nothing when a run-claimed button is clicked (19 ms)
  ✓ still renders nothing when the environment hides the control, run claim or not
  ✓ disables the tab of a card a fresh run has claimed, leaving an unqueued sibling live (25 ms)
  ✓ disables the drawer chip for a claimed item, from the same run payload (36 ms)
  ✓ leaves the tab live when the run holding the item has gone stale (13 ms)
```

Not done manually against a live board: the `## Done when` line asks for a
disabled control on a running board with a live run in flight, and starting a
real orchestrator run to see it would have that run commit and merge into
`main` — not something to do for a screenshot. Both halves of that sentence are
pinned by automated cases at the layer that decides them instead: the board
cases render the real `BoardView` against the real
`GET /api/orchestrator/runs` payload shape, and the dispatch cases drive the
real Nest route end to end through supertest and assert the 409 and its reason.

Two incidental findings, neither fixed here (each is a `backlog-capture`, not
an edit to this item):

- `test/agents-plan.test.ts` and `test/agents-dispatch.test.ts` had no
  `BM_ORCH_HOME` override. They did not need one until now, but as soon as
  either route read the run file they would have read the developer's real
  `~/.backlog-manager/orchestrator/`. Both now set a `mkdtemp` root per case,
  as `orchestrator-start.test.ts` already did.
- This worktree had no `node_modules`, so the jsdom suites failed on
  `moduleNameMapper`'s `<rootDir>/node_modules/marked/...` path until
  `pnpm install` ran in it. Worth knowing for `backlog-orchestrate`, which
  creates these worktrees.

### Review round 1 — one Important finding, fixed

The fix added a second per-item *disabling* block, and the stale comment inside
`DispatchButton.tsx` was corrected in the same pass — but the two documents
that state the same rule were not. Both now match the code:

- `CLAUDE.md` — the bullet read "only the per-item (project-visibility) one
  disables it". Now "the per-item ones disable it", naming both (project
  visibility via `dispatchGate`, the run claim via `runClaimBlock`) and the
  order `DispatchButton` reads them in.
- `docs/invariants.md:408` — "This is the one block that leaves a control on
  screen" → "one of the two blocks that leave a control on screen", pointing at
  the other.
- `docs/invariants.md` heading — "…; per-item disables it" → "…; per-item ones
  disable it", and its closing line ("The project-visibility block is the
  opposite case and keeps its button") is replaced by a two-item list of the
  per-item blocks: what `RUN_CLAIMED_STAGES` is and why `pending`/`preflight`
  are in it, why it is not `ACTIVE_RUN_STAGES`, why the item file cannot carry
  the fact, and why `dispatch()`'s re-check is the layer that holds. Closes by
  naming bug-4 as the failure it encodes, matching how the rest of that file
  reads.
- `test/dispatch-button.test.tsx:157` — a comment quoting the invariant
  verbatim, so it went stale with it. Re-quoted against the new wording.

Deliberately left alone: `docs/superpowers/specs/2026-08-27-agents-dispatch-design.md:61`
carries the same sentence, but it is a dated design spec — a record of what that
pass decided, not a live statement of current behaviour. Editing it would
rewrite history rather than fix a claim.

Re-verified after the doc edits.

`pnpm run typecheck`:

```
$ tsc --noEmit
```

(no output, exit 0)

`pnpm test`:

```
Test Suites: 33 passed, 33 total
Tests:       493 passed, 493 total
Snapshots:   0 total
Time:        25.949 s, estimated 38 s
Ran all test suites.
```
