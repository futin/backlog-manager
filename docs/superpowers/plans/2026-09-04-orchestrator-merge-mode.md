# Orchestrator Merge Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a board-started orchestrator run be told whether to merge each verified item into `main` or stop at a reviewed branch, and make a run that was refused a merge degrade to that same outcome instead of parking work that is green.

**Architecture:** A two-valued enum chosen in the client, validated server-side, appended to the server-composed spawn prompt as one of exactly two compile-time literals, parsed by `orchestrate.mjs init` into three run-level fields, and enforced by the tool refusing `stage <id> merged` under branch mode. A new terminal `RunStage` — `branched` — sits in `merged`'s position so the run history never claims something reached `main` that did not.

**Tech Stack:** NestJS (server), React + Vite (client), plain ESM node scripts (skills), jest `--runInBand` for server/client/shared, node's own test runner for `skills/*/tools/*.test.mjs`.

**Spec:** [docs/superpowers/specs/2026-09-04-orchestrator-merge-mode-design.md](../specs/2026-09-04-orchestrator-merge-mode-design.md) — read it before Task 1. Every "why" in this plan is short because the spec carries the long version.

## PLAN CONVENTION — READ THIS FIRST

**This plan deliberately contains no literal implementation code, and no
literal test code.** That is an intentional override of the writing-plans
template, not an omission, and it is not a defect to be "fixed" by filling
code in.

Each step states **behaviour, exact signatures, and exact expected values**.
Test steps give a **table of cases**: the input, the exact assertion, and the
exact expected value. You write the test body and the implementation.

Why: handed code gets transcribed verbatim, so a bug in the plan becomes a bug
in the branch with nobody positioned to catch it — test scaffolding worst of
all, because it reads as boilerplate. You are expected to disagree with this
plan where it is wrong. Say so rather than transcribing it.

Line-number references are from HEAD at `d7a43c7` and will drift; treat them
as "look here first", not as coordinates.

## Global Constraints

- **`orchestrate.mjs` is the run file's only writer.** The server reads, never writes, never caches. No task changes that.
- **The spawn prompt is composed server-side.** `POST /api/agents/orchestrate` has no `prompt` field and gains none. The only caller-influenced text remains `ids` plus, after Task 3, one of two compile-time literals.
- **`merge` must stay byte-identical to today.** A run launched with no `mergeMode`, or with `'merge'`, composes the bare `/backlog-orchestrate` constant and behaves exactly as it does at HEAD. Every task is regression-first on this point.
- **Absent `mergeMode` → `'merge'`. Present-but-invalid → HTTP 400, uncoded.** Never clamp an unrecognised value to the default: the default is the irreversible direction.
- **`RUN_IN_PROGRESS_CODE` stays the only coded 409** from the orchestrate endpoint.
- **`ATTENTION_KINDS` stays exactly `needs-answers`, `parked`, `fix-exhausted`.** No task adds a fourth.
- **Comments explain *why*, at length.** Match the surrounding density; do not strip it, and do not write comments that only restate the line below them.
- **Tests are flat in `test/`**, `*.test.ts` / `*.test.tsx`; component suites need a `@jest-environment jsdom` docblock. Skill tests live beside their tool and run under node's runner.
- **pnpm only.** `pnpm test`, `pnpm run test:skills`, `pnpm run typecheck`.
- **Editing `skills/` changes nothing** until committed, pushed, and `pnpm run plugin:sync` has run. Task 9 is not verifiable in an install before that.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `server/src/agents/merge-check.util.ts` | Read the three `.claude` settings files for a project and answer whether any `permissions.allow` entry covers `Bash(git merge:*)`. Pure filesystem read, degrades to "not found" on every failure. |
| `test/merge-check.test.ts` | Covers that util and the endpoint. |
| `test/merge-mode.test.ts` | Covers request validation and prompt composition for `mergeMode`. |

**Modified**

| File | Change |
|---|---|
| `shared/types.ts` | `MergeMode`, `MERGE_MODES`, `branched` in `RunStage`, three run-level fields on `OrchestratorRun`, `mergeMode` on the orchestrate request type. |
| `shared/agent.ts` | `isMergeMode` guard; `branched` classified as a true exit. |
| `client/src/lib/run-stage.ts` | `STAGE_TONE` entry for `branched`. |
| `client/src/lib/run-time.ts` | `STEPPER_STAGES` becomes mode-aware; `stepperDots` takes the terminal stage. |
| `client/src/lib/run-stats.ts` | `branched` counts as completed; stays out of `MACHINE_STAGES`. |
| `client/src/lib/settings.ts` | `orchestrateDefaultMergeMode` key, default, clamp. |
| `client/src/components/settings/SettingsView.tsx` | One row for it. |
| `client/src/components/board/OrchestrateSheet.tsx` | Picker, merge-check warning, request field. |
| `client/src/lib/agents.ts` | `mergeMode` on `StartOrchestrateRequest`; `fetchMergeCheck`. |
| `client/src/components/runs/StageTrack.tsx` | Terminal node label from the run's effective mode. |
| `client/src/components/board/RunStrip.tsx`, `client/src/components/runs/RunsView.tsx`, `RunDetail.tsx` | Show the mode; show the note when the run degraded. |
| `server/src/agents/agents.controller.ts` | Pass `mergeMode` through; new `merge-check` route. |
| `server/src/agents/agents.service.ts` | Validate `mergeMode`; compose the prompt. |
| `server/src/orchestrator/orchestrator.service.ts` | Carry the three run-level fields through the sanitiser. |
| `skills/backlog-orchestrate/tools/orchestrate.mjs` | `branched` in `RUN_STAGES`; `init --merge-mode`; run skeleton fields; `stage merged` refusal; a command to record a downgrade; mode-aware `status` summary. |
| `skills/backlog-orchestrate/tools/orchestrate.test.mjs` | Cases for all of the above. |
| `skills/backlog-orchestrate/SKILL.md` | §2 probe, §9 branch path, denial degrade, mode-aware finish summary. |
| `skills/backlog-orchestrate/references/rationale.md` | The three-run measurement. |
| `CLAUDE.md`, `docs/invariants.md` | The new invariants. |

---

### Task 1: The `branched` stage and the `MergeMode` vocabulary

Everything the compiler forces, in one commit, so the tree is green at the end of it. Adding a `RunStage` member breaks every `Record<RunStage, …>` immediately — that is the mechanism working, not a problem to defer.

**Files:**
- Modify: `shared/types.ts` (`RunStage` ~319-322, `RUN_CLAIMED_STAGES` ~354, `ATTENTION_RUN_STAGES` ~388, `OrchestratorRun` ~522)
- Modify: `shared/agent.ts` (`runHoldsItem` ~458 and its `RUN_HELD_STAGES`)
- Modify: `client/src/lib/run-stage.ts` (`STAGE_TONE`)
- Test: `test/agents-shared.test.ts` (the `Record<RunStage, true>` literal ~478)

**Interfaces produced:**
- `type MergeMode = 'merge' | 'branch'`
- `const MERGE_MODES: readonly MergeMode[]`
- `function isMergeMode(v: unknown): v is MergeMode`
- `RunStage` gains `'branched'`
- `OrchestratorRun` gains `mergeMode: MergeMode`, `mergeModeEffective: MergeMode`, `mergeModeNote: string | null`

- [ ] **Step 1: Extend the partition test first**

Add `branched: true` to the `Record<RunStage, true>` literal in `test/agents-shared.test.ts` and add assertions:

| Assertion | Expected |
|---|---|
| `RUN_CLAIMED_STAGES.includes('branched')` | `false` |
| `ATTENTION_RUN_STAGES.includes('branched')` | `false` |
| `runHoldsItem(item, runs)` where the run's entry for that item is stage `branched` | `false` |
| `STAGE_TONE.branched` | `'done'` |

- [ ] **Step 2: Run it and watch it fail for the right reason**

`pnpm test -- agents-shared`

Expected: a TypeScript error that `'branched'` is not assignable to `RunStage`. If it fails any other way, stop and find out why before continuing.

- [ ] **Step 3: Add the vocabulary to `shared/types.ts`**

- `MergeMode`, `MERGE_MODES`, declared next to `RunStage` with a comment saying what each value means in terms of outcome (`merge` merges to `main` and deletes the branch; `branch` keeps the branch and never touches `main`).
- `'branched'` added to the `RunStage` union, positioned beside `merged`, with a comment: it is the branch-mode success exit, it occupies the same terminal position, and it is a true exit the run does not hold.
- Both partition constants get their comment extended rather than replaced — each already explains why membership is decided next to the union, and a new member is exactly the case those comments were written for.

- [ ] **Step 4: Add the three run-level fields to `OrchestratorRun`**

`mergeMode` is what was asked for and is never rewritten; `mergeModeEffective` is what the run is doing and only ever moves `merge` → `branch`; `mergeModeNote` says why they differ, or is `null`. Document the two-field split: the archive has to distinguish a run that chose branches from a run that was denied merges.

- [ ] **Step 5: Add `isMergeMode` and classify `branched` in `shared/agent.ts`**

The guard lives beside `isAgentAction` and exists for the same stated reason: a hand-written comparison chain is a second copy of the vocabulary and it is the copy that goes stale. `RUN_HELD_STAGES` gains nothing — `branched` is an exit — but its doc comment names four true exits today and must now name five.

- [ ] **Step 6: Add the `STAGE_TONE` entry**

`branched: 'done'`. The comment on `merged` in that record calls it "the one success exit, per RunStage's own doc comment" — that sentence is now false and must be corrected in the same edit.

- [ ] **Step 7: Green**

`pnpm run typecheck && pnpm test -- agents-shared`

Expected: typecheck clean, suite passes. Other suites may still fail — Task 2 handles them.

- [ ] **Step 8: Commit**

```bash
git add shared/types.ts shared/agent.ts client/src/lib/run-stage.ts test/agents-shared.test.ts
git commit -m "feat(runs): add the branched terminal stage and the MergeMode vocabulary"
```

---

### Task 2: Client stage-derived state understands `branched`

**Files:**
- Modify: `client/src/lib/run-time.ts` (`STEPPER_STAGES` ~46, `stepperDots` ~458)
- Modify: `client/src/lib/run-stats.ts` (`MACHINE_STAGES` ~264, `aggregateRuns`)
- Modify: `client/src/components/runs/StageTrack.tsx`
- Test: `test/run-time.test.ts`, `test/run-stats.test.ts`, `test/stage-track.test.tsx`

**Interfaces consumed:** `MergeMode`, `'branched'` from Task 1.
**Interfaces produced:** `stepperStages(terminal: 'merged' | 'branched'): readonly RunStage[]`; `stepperDots(item, live, terminal: 'merged' | 'branched')` — the third parameter is **required, with no default**. A default is how the next caller silently reintroduces the wrong terminal node, the same argument `runHoldsItem`'s required `runs` parameter already makes.

- [ ] **Step 1: Write the failing tests**

| Case | Assertion | Expected |
|---|---|---|
| `stepperStages('merged')` | equals | today's `STEPPER_STAGES` array, unchanged, 7 entries ending `merged` |
| `stepperStages('branched')` | equals | same 7 entries, last one `branched` |
| `stepperDots(item, live, 'branched')` for an item at `branched` | length, and last dot's `stage` | `7`, `'branched'` |
| same, last dot | is marked visited, and is not "current" | visited `true`, current `false` (a terminal stage is never the current node) |
| `runStageTotals` for a run whose items ended `branched` | contains a `branched` key | `false` — terminal arrivals open no span |
| `aggregateRuns` over one run of 3 `branched` + 1 `parked` | completed count | `3` |
| `aggregateRuns` over one run of 2 `merged` + 2 `branched` | completed count | `4` |
| `StageTrack` for a run with `mergeModeEffective: 'branch'` | text of the seventh node | `branched` |
| `StageTrack` for a run with `mergeModeEffective: 'merge'` | text of the seventh node | `merged` |

- [ ] **Step 2: Run them and confirm they fail**

`pnpm test -- run-time run-stats stage-track`

- [ ] **Step 3: Make `STEPPER_STAGES` mode-aware**

Replace the exported constant with `stepperStages(terminal)`. Its existing doc comment explains why terminal *failures* get no dot — that reasoning is unchanged and must survive the edit; add to it that the seventh dot is the run's success exit and that which word that is depends on the run's effective mode, not on the item.

- [ ] **Step 4: Thread the terminal stage through `stepperDots` and `StageTrack`**

`StageTrack` reads it from the run's `mergeModeEffective`. Update every call site the compiler finds; there is no default to fall back on.

- [ ] **Step 5: Count `branched` as completed in `run-stats.ts`**

`MACHINE_STAGES` is unchanged and its doc comment already explains why terminal stages cannot contribute a span — check that the explanation still reads correctly with two terminal success stages and extend it if not.

- [ ] **Step 6: Green**

`pnpm run typecheck && pnpm test`

Expected: the whole suite passes.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/run-time.ts client/src/lib/run-stats.ts client/src/components/runs/StageTrack.tsx test/run-time.test.ts test/run-stats.test.ts test/stage-track.test.tsx
git commit -m "feat(runs): make the stage track and run stats aware of branched"
```

---

### Task 3: `orchestrate.mjs` — merge mode in the run file

The tool is the enforcement point. Everything here is testable without a server, a browser or a real run.

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` (`RUN_STAGES` ~385, run skeleton ~405-421, `cmdInit` ~1001, `cmdStage` ~1247-1290, `ATTENTION_KINDS` ~1307, `cmdStatus` ~1397)
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs`

**Interfaces consumed:** the `MergeMode` vocabulary from Task 1 — restated in the `.mjs` as a standalone constant, **not imported**. The skills are a published plugin with git as their publishing boundary, so they cannot import from `shared/`; `RUN_STAGES` is already duplicated for exactly this reason and carries the comment explaining it.

**Interfaces produced:**
- `init … --merge-mode <merge|branch>`
- `merge-mode <merge|branch> --note <text>` — records a downgrade
- run file fields `mergeMode`, `mergeModeEffective`, `mergeModeNote`

- [ ] **Step 1: Write the failing skill tests**

| # | Case | Expected |
|---|---|---|
| 1 | `init --merge-mode branch` | run file has `mergeMode: 'branch'`, `mergeModeEffective: 'branch'`, `mergeModeNote: null` |
| 2 | `init` with no flag | all three are `'merge'`, `'merge'`, `null`; the run's full key set is otherwise identical to the existing contract fixture |
| 3 | `init --merge-mode nonsense` | exit code `1`, message names the two valid values, **and no file is written at all** — assert the run directory is untouched, which is the "validate first, mutate last" guarantee |
| 4 | `init --merge-mode` with no value | exit `1`, nothing written |
| 5 | `stage <id> merged` under `mergeModeEffective: 'branch'` | non-zero exit; the item's stage is **unchanged** on disk; message names the mode and says to use `branched` |
| 6 | `stage <id> branched` under branch mode | exit `0`, stage `branched`, `stageAt.branched` stamped |
| 7 | `stage <id> branched` under merge mode | exit `0` — legal, this is the degrade path |
| 8 | `merge-mode branch --note "<text>"` on a merge-mode run | `mergeMode` still `'merge'`, `mergeModeEffective` now `'branch'`, note stored verbatim |
| 9 | `merge-mode merge --note x` on a run already effective-`branch` | non-zero exit, nothing changed — the downgrade is one-way |
| 10 | `status --json` on a branch-mode run with 3 branched of 4 | summary line reads in branch-mode wording, not `3/4 merged` |
| 11 | `attention <id> --kind branched` | exit `1`, "unknown kind" — the kind set is unchanged |

- [ ] **Step 2: Run and confirm failure**

`pnpm run test:skills`

- [ ] **Step 3: Add `branched` to `RUN_STAGES`**

Same position as in the union. Its comment already says it is verbatim from `shared/types.ts` — keep that true.

- [ ] **Step 4: Add the flag and the fields to `cmdInit`**

Parse `--merge-mode` alongside `--project` / `--ids` / `--max` / `--base`. Validate it **before** anything touches disk, in the same block as the `--project` absolute-path check and the linked-worktree refusal — case 3 is asserting exactly that ordering. Write the three fields into the run skeleton beside `maxItems`.

- [ ] **Step 5: Add the `stage merged` refusal**

In `cmdStage`, after the stage name is validated and before the item is written. The message must name the run's effective mode and the stage to use instead; a message that only says "refused" sends the reader into this file.

- [ ] **Step 6: Add the `merge-mode` command**

Takes the target mode and a required `--note`. Refuses any move other than `merge` → `branch`. Registered in the usage text and in the command dispatch table.

- [ ] **Step 7: Make the `status` summary mode-aware**

The `N/M merged` line counts `merged` today; under branch mode it should count `branched` and say so. A run that degraded mid-queue has both, and the line must not hide either.

- [ ] **Step 8: Green**

`pnpm run test:skills`

- [ ] **Step 9: Commit**

```bash
git add skills/backlog-orchestrate/tools/orchestrate.mjs skills/backlog-orchestrate/tools/orchestrate.test.mjs
git commit -m "feat(orchestrate): carry merge mode in the run file and enforce it in the tool"
```

---

### Task 4: Server — validate `mergeMode` and compose the prompt

**Files:**
- Modify: `shared/types.ts` (the orchestrate request type), `client/src/lib/agents.ts` (`StartOrchestrateRequest` ~255)
- Modify: `server/src/agents/agents.controller.ts` (~97-130)
- Modify: `server/src/agents/agents.service.ts` (`orchestrate` ~440-500)
- Test: `test/merge-mode.test.ts` (new), plus the existing orchestrate suite

**Interfaces consumed:** `MergeMode`, `MERGE_MODES`, `isMergeMode` (Task 1).

- [ ] **Step 1: Write the failing tests**

| # | Body | Expected spawn prompt / response |
|---|---|---|
| 1 | no `mergeMode` | prompt exactly `/backlog-orchestrate` |
| 2 | `mergeMode: 'merge'` | prompt exactly `/backlog-orchestrate` |
| 3 | `mergeMode: ''` | prompt exactly `/backlog-orchestrate` |
| 4 | `mergeMode: 'branch'` | prompt exactly `/backlog-orchestrate --merge-mode branch` |
| 5 | `mergeMode: 'branch'` with `ids: ['bug-1','bug-2']` | prompt exactly `/backlog-orchestrate bug-1 bug-2 --merge-mode branch` — ids first, flag last |
| 6 | `mergeMode: 'nope'` | HTTP 400; **nothing is spawned** — assert the spawn fetch was not called; no `code` field on the body |
| 7 | `mergeMode: 42` (non-string, which the `Partial` type cannot rule out) | HTTP 400, nothing spawned |
| 8 | a run already in progress **and** `mergeMode: 'nope'` | 409 with `RUN_IN_PROGRESS_CODE` — the existing lock ordering wins over the new validation, same reason ids are resolved last today |
| 9 | the existing field-by-field rebuild test | extended: a `mergeMode` on the body reaches the service, and an unlisted field still does not |

Case 8 is the one worth thinking about: the lock check must stay ahead of this validation for the same reason `resolveIds` is last — a stale board tab must be told a run is in progress, not that its enum is malformed.

- [ ] **Step 2: Run and confirm failure**

`pnpm test -- merge-mode agents-orchestrate`

- [ ] **Step 3: Add the field to both request types**

Server-side `AgentOrchestrateRequest` types it as `string | undefined` (it is validating a body it cannot trust); the client's `StartOrchestrateRequest` types it as `MergeMode | undefined`, narrower, for the reason its `permissionMode` comment already gives.

- [ ] **Step 4: Controller passes it through unvalidated**

With a comment in the register of the ones already there: the service is the one place a value is judged, and a shape check here would be a second, weaker copy.

- [ ] **Step 5: Validate in the service**

Absent (`undefined` or `''`) → `'merge'`. A member of `MERGE_MODES` → itself. Anything else → `HttpException` 400, uncoded. Comment must say why this does **not** follow `pickFrom`'s drop-on-unknown rule: dropping resolves to `'merge'`, and merging to `main` is the irreversible direction, so a caller bug must not be able to select it.

- [ ] **Step 6: Compose the prompt**

Append ` --merge-mode branch` for `'branch'` and nothing at all for `'merge'`. Extend `ORCHESTRATE_PROMPT`'s own comment: what a caller can influence is now a validated id list plus a two-valued enum, and the appended text is a compile-time constant with no caller string in it.

- [ ] **Step 7: Green**

`pnpm run typecheck && pnpm test`

- [ ] **Step 8: Commit**

```bash
git add shared/types.ts client/src/lib/agents.ts server/src/agents/agents.controller.ts server/src/agents/agents.service.ts test/merge-mode.test.ts
git commit -m "feat(agents): accept a merge mode and compose it into the orchestrate prompt"
```

---

### Task 5: Server — carry the run's merge fields to the board

`orchestrator.service.ts` rebuilds the run object field by field (~137-150). A field it does not name is silently dropped, so the board would render a mode the run file already has.

**Files:**
- Modify: `server/src/orchestrator/orchestrator.service.ts`
- Test: `test/orchestrator.test.ts` (or the existing orchestrator suite)

- [ ] **Step 1: Write the failing tests**

| Case | Expected |
|---|---|
| a run file with all three fields | all three present and equal in the `GET /api/orchestrator/runs` payload |
| a run file written before this change (fields absent) | `mergeMode` and `mergeModeEffective` read `'merge'`, `mergeModeNote` reads `null` — every archived run predates this feature and must not render as broken |
| a run file with `mergeMode: 'nonsense'` on disk | reads `'merge'`; the reader sanitises, it does not trust |
| `GET /api/orchestrator/archive/run` | same three fields, same defaults |

- [ ] **Step 2: Run and confirm failure**

`pnpm test -- orchestrator`

- [ ] **Step 3: Add the fields to the sanitiser**

Unknown values fall back to `'merge'` rather than 400ing: this is a reader of a file another process wrote, and its existing contract is to degrade rather than throw.

- [ ] **Step 4: Green, then commit**

```bash
pnpm test -- orchestrator
git add server/src/orchestrator/orchestrator.service.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): read the run's merge mode through to the board"
```

---

### Task 6: Server — `GET /api/agents/merge-check`

**Files:**
- Create: `server/src/agents/merge-check.util.ts`
- Modify: `server/src/agents/agents.controller.ts`, `agents.service.ts`
- Create: `test/merge-check.test.ts`

**Interfaces produced:** `mergeCheck(projectPath: string, homeDir: string): { covered: boolean; source: string | null }` — `source` is the absolute path of the file the covering entry came from, or `null`.

Precedence, highest first: `<project>/.claude/settings.local.json`, `<project>/.claude/settings.json`, `<homeDir>/.claude/settings.json`.

- [ ] **Step 1: Write the failing tests**

| # | Fixture | Expected |
|---|---|---|
| 1 | allow entry `Bash(git merge:*)` in project `settings.local.json` | `covered: true`, source is that file |
| 2 | same entry in project `settings.json` only | `covered: true`, source is that file |
| 3 | same entry in the home settings only | `covered: true`, source is that file |
| 4 | entries in two files | source is the higher-precedence one |
| 5 | no settings files at all | `covered: false`, `source: null` |
| 6 | a settings file containing malformed JSON | `covered: false`, does **not** throw |
| 7 | a settings file whose `permissions.allow` is a string, not an array | `covered: false`, does not throw |
| 8 | allow entry `Bash(git merge --no-ff:*)` | `covered: true` — a narrower prefix that still covers the command the run issues |
| 9 | allow entry `Bash(git:*)` | `covered: true` |
| 10 | allow entry `Bash(git status:*)` | `covered: false` |
| 11 | `GET /api/agents/merge-check?project=<registered>` | 200 with the shape above |
| 12 | `GET /api/agents/merge-check?project=<unregistered>` | 404, and assert **no filesystem read of that path was attempted** — the registry gate runs first, exactly as the item-body allowlist does |
| 13 | `project` absent | 400 |

Cases 8-10 are the substance of this task: decide the matching rule deliberately and write it down in the util's comment. A dumb equality check against one literal string is wrong and will tell users their working setup is broken.

- [ ] **Step 2: Run and confirm failure**

`pnpm test -- merge-check`

- [ ] **Step 3: Write the util**

Read-only. Every failure path — missing file, unreadable, malformed, unexpected shape — degrades to "not covered", never throws. Comment must say why: this answers a hint shown in a sheet, and an unreadable settings file must not 500 a launch dialog.

- [ ] **Step 4: Wire the route**

Registry-gated before the filesystem is touched. `GET` with a query parameter is acceptable here and differs from `fetchAgentPlan`'s POST-for-a-path rule only in that this path is already in the registry the client fetched — note that in a comment, or use POST for consistency and say so. Pick one and justify it.

- [ ] **Step 5: Green, then commit**

```bash
pnpm test -- merge-check
git add server/src/agents/merge-check.util.ts server/src/agents/agents.controller.ts server/src/agents/agents.service.ts test/merge-check.test.ts
git commit -m "feat(agents): report whether a project's settings cover git merge"
```

---

### Task 7: Client — the Settings default

**Files:**
- Modify: `client/src/lib/settings.ts` (`Settings` ~46-90, `DEFAULT_SETTINGS` ~92, `clampSettings` ~224)
- Modify: `client/src/components/settings/SettingsView.tsx` (beside the dispatch rows ~231-246)
- Test: `test/settings.test.ts`, `test/settings-view.test.tsx`

- [ ] **Step 1: Write the failing tests**

| Case | Expected |
|---|---|
| `clampSettings({})` | `orchestrateDefaultMergeMode === 'merge'` |
| `clampSettings({ orchestrateDefaultMergeMode: 'branch' })` | `'branch'` |
| `clampSettings({ orchestrateDefaultMergeMode: 'nonsense' })` | `'merge'` |
| `clampSettings({ orchestrateDefaultMergeMode: 7 })` | `'merge'` |
| the Settings row | renders both options and writes the chosen one through `update` |

Note the asymmetry with Task 4 and write it into the test's comment: a hand-edited localStorage value clamps to the default, while a malformed HTTP body 400s. The client value is a *preference* whose worst case is a sheet opening on the wrong preselection, which the user then sees; the request value is an *instruction* acted on unattended.

- [ ] **Step 2: Run, confirm failure, implement, green**

`pnpm test -- settings`

Use the existing `pickOne` against `MERGE_MODES`. The new interface field's doc comment should point at `dispatchDefaultModel`'s rather than restate it — same per-device reasoning, same "a default you set once, not the sheet remembering your last pick".

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/settings.ts client/src/components/settings/SettingsView.tsx test/settings.test.ts test/settings-view.test.tsx
git commit -m "feat(settings): default merge mode for orchestrator runs"
```

---

### Task 8: Client — the sheet picker and the setup hint

**Files:**
- Modify: `client/src/components/board/OrchestrateSheet.tsx` (state ~93-104, request body ~232-240)
- Modify: `client/src/lib/agents.ts` (`fetchMergeCheck`)
- Test: `test/orchestrate-sheet.test.tsx`

**Interfaces consumed:** `merge-check` (Task 6), the Settings key (Task 7), the request field (Task 4).

- [ ] **Step 1: Write the failing tests**

| # | Case | Expected |
|---|---|---|
| 1 | sheet opens with Settings default `'branch'` | picker shows the branch option selected |
| 2 | user switches to merge and launches | request body carries `mergeMode: 'merge'` |
| 3 | launch with the picker untouched | body carries the Settings value — sent on **every** launch, never omitted |
| 4 | merge selected, `merge-check` says not covered | the hint renders, names the file to create and shows the JSON to paste |
| 5 | merge selected, `merge-check` says covered | no hint |
| 6 | branch selected | no hint, and `merge-check` is not fetched at all |
| 7 | `merge-check` request fails outright | no hint, no error surfaced, launch still works — a hint is not worth blocking a run over |
| 8 | the existing "untouched sheet sends no `ids`" test | still passes — `mergeMode` must not change the strict-subset rule for `ids` |

Case 8 is a regression guard, not a new feature: `ids` and `mergeMode` have deliberately opposite absent-value semantics and a shared code path is where that gets confused.

- [ ] **Step 2: Run, confirm failure, implement, green**

`pnpm test -- orchestrate-sheet`

The picker's labels describe the outcome, not the flag: "Merge to main" and "Leave branches for me". The hint's copy states the missing path as a fact and the effect as a likelihood — the same register `dispatchGate`'s reason string uses, and for the same reason: no reader of it is closer to the classifier than a settings file is.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/board/OrchestrateSheet.tsx client/src/lib/agents.ts test/orchestrate-sheet.test.tsx
git commit -m "feat(board): choose a run's merge mode when launching it"
```

---

### Task 9: Client — show the mode in the run surfaces

**Files:**
- Modify: `client/src/components/board/RunStrip.tsx`, `client/src/components/runs/RunsView.tsx`, `client/src/components/runs/RunDetail.tsx`
- Test: `test/board.test.tsx`, `test/runs-view.test.tsx`, `test/run-detail.test.tsx`, `test/orchestrator-drawer.test.tsx`

- [ ] **Step 1: Write the failing tests**

| Case | Expected |
|---|---|
| a branch-mode run in the strip | reads as branch mode, not as a failure or a park |
| a run where `mergeMode: 'merge'` but `mergeModeEffective: 'branch'` | shows the note text; the two-field distinction is visible, not collapsed |
| a run where both are `'merge'` | renders exactly as it does today — snapshot or explicit assertion, your call, but assert it |
| the detail pane for a branch-mode run | lists the branches with their `git merge --no-ff backlog/<id>` commands |
| a run with items in both `merged` and `branched` | both counted, neither hidden |

- [ ] **Step 2: Run, confirm failure, implement, green**

`pnpm test`

- [ ] **Step 3: Commit**

```bash
git add client/src/components/board/RunStrip.tsx client/src/components/runs/RunsView.tsx client/src/components/runs/RunDetail.tsx test/board.test.tsx test/runs-view.test.tsx test/run-detail.test.tsx test/orchestrator-drawer.test.tsx
git commit -m "feat(runs): surface a run's merge mode and any downgrade"
```

---

### Task 10: `SKILL.md` — the probe, the branch path, the degrade

Prose, and the part with no test harness. It is last because everything it instructs now exists and can be exercised by hand.

**Files:**
- Modify: `skills/backlog-orchestrate/SKILL.md` (§2 "Start the run" ~180, §9 "Merge" ~892-1062, §10 finish summary ~1063)
- Modify: `skills/backlog-orchestrate/references/rationale.md`
- Modify: `CLAUDE.md`, `docs/invariants.md`

- [ ] **Step 1: §2 — pass the flag and run the probe**

`init` gains `--merge-mode` when the trigger carried one. Then, **only when the effective mode is `merge`**, one probe:

```bash
git -C "$PWD" merge --no-ff --no-edit HEAD
```

Merging `HEAD` into itself prints `Already up to date.` and writes nothing — no commit, no index change, no reflog entry. What matters is that the command shape is byte-identical to §9's real merge, so the classifier is shown what it will be shown later.

- Allowed → carry on in merge mode.
- Denied → `merge-mode branch --note "<the classifier's own message>"`, then run the whole queue in branch mode. **The run does not stop.**

State plainly that the probe is early warning and not a guarantee: the verdict is per call, and §9's degrade path exists precisely because a passing probe can be followed by a denied merge.

- [ ] **Step 2: §9 — the branch-mode path**

When the effective mode is `branch`, the item skips the merge entirely: no `symbolic-ref` precondition and no dirty-path overlap probe (both exist to protect a write to the main tree, and there is no write), then `stage <id> branched`, then `git worktree remove` exactly as today — plain `remove`, never `--force`, with the same "a refusal is information" handling — and **no `git branch -d`**. The branch is the deliverable.

Say that the next item still starts from an unchanged `main`, so two branches touching the same files will conflict at hand-merge time. That is inherent to not merging; the run cannot fix it and must not pretend to.

- [ ] **Step 3: §9 — the denial degrade**

Narrow on purpose. Only when the merge is refused by the classifier:

- `stage <id> branched`, not `parked`;
- `merge-mode branch --note "<message>"`, so the rest of the queue skips a merge that has just been shown to fail;
- continue to the next item;
- **no attention entry** — the cause is one run-level fact, not N item-level ones, and `ATTENTION_KINDS` gains nothing.

Every other §9 failure keeps today's behaviour exactly: a conflict, a pre-merge refusal over overlapping dirty paths, a main tree not on `main`. Those are genuine "a human must decide" states and they still park, still keep the worktree, still say why. Write that contrast into the section — a reader skimming for "what do I do when the merge fails" must not take the degrade path for a conflict.

- [ ] **Step 4: §10 — the finish summary**

Under branch mode, list the branches in merge order with the literal `git merge --no-ff backlog/<id>` for each, and flag pairs whose diffs overlap. A degraded run says so, once, with the note.

- [ ] **Step 5: `references/rationale.md`**

Add the three-run measurement from the spec's opening table, with the exact denial text and the note that the dashboard's `.claude/settings.json` postdates the failure. This is the file that exists so a future session can argue with a rule from evidence rather than from memory.

- [ ] **Step 6: `CLAUDE.md` and `docs/invariants.md`**

New invariants, in the register of the existing ones:

- Merge mode is run-scoped, chosen per launch, defaulted from Settings, and carried spawn → prompt → `init` → run file. Absent means `merge`; a malformed value is a 400, never a clamp, because the default is the irreversible direction.
- `merged` is no longer the only success exit. `branched` is its branch-mode sibling in the same terminal position, and both are true exits `runHoldsItem` leaves out.
- The tool refuses `stage merged` under branch mode. Prose drifts across several hundred turns; a tool refusal does not.
- A classifier denial degrades a run to branch mode; every other merge failure still parks.

Correct the existing `AgentAction`/stage prose anywhere it says `merged` is the only success exit.

- [ ] **Step 7: Verify by hand, then commit**

`pnpm test && pnpm run test:skills && pnpm run typecheck`

Then a real end-to-end run of one small item in branch mode, started **from the board** and not by typing the trigger into a terminal — a headless session was measured flooring ~50k against an interactive one's ~68k, and this run is the first exercise of the whole path.

```bash
git add skills/backlog-orchestrate/SKILL.md skills/backlog-orchestrate/references/rationale.md CLAUDE.md docs/invariants.md
git commit -m "docs(orchestrate): merge mode, the preflight probe and the denial degrade"
```

- [ ] **Step 8: Publish**

Editing `skills/` changes nothing in an install until it is committed, pushed, and synced:

```bash
pnpm run plugin:sync
```

The sync refuses dirty, unpushed or behind states, and measures every entry of `PUBLISHED_PATHS` on both sides.

---

## Self-Review

**Spec coverage:** §1 vocabulary → Task 1. §2.1 Settings → Task 7. §2.2 sheet → Task 8. §2.3 validation → Task 4. §2.4 prompt → Task 4. §2.5 run file → Task 3. §3 enforcement → Task 3 step 5. §4 `branched` and its whole classification table → Tasks 1 and 2, plus Task 3 for the `.mjs` duplicate. §5.1 probe → Task 10 step 1. §5.2 degrade → Task 10 step 3 (recording it) and Task 3 (the `merge-mode` command it calls). §5.3 branch-mode §9 → Task 10 step 2. §6 merge-check → Task 6. §7 surfacing → Tasks 5 and 9. §8 test list → distributed across every task's Step 1. No gaps found.

**One thing the spec did not anticipate,** added here: `orchestrator.service.ts` sanitises the run field by field, so the three new fields need naming there or the board never sees them (Task 5), and `STEPPER_STAGES` hard-codes `merged` as its seventh node, so the track needs the mode threaded in (Task 2).

**Placeholder scan:** no TBD, no "handle edge cases", no "similar to Task N". Every test step names its cases and its expected values. Code blocks are commands and commit messages only, per the plan convention at the top.

**Type consistency:** `MergeMode`, `MERGE_MODES`, `isMergeMode`, `mergeMode`, `mergeModeEffective`, `mergeModeNote`, `branched`, `stepperStages`, `mergeCheck` are spelled identically in every task that mentions them. `stepperDots`' third parameter is required in both the task that introduces it and the task that calls it.
