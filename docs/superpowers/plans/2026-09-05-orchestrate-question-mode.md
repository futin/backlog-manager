# Orchestrate Question Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an orchestrator run a declared, recorded choice about what to do with an item's open questions when nobody can answer them, and restructure the Orchestrate sheet into three steps so the queue can be hand-ordered.

**Architecture:** One new run-scoped enum, `QuestionMode = 'decide' | 'park'`, travelling the exact route `MergeMode` already travels — Settings seed → sheet picker → `POST /api/agents/orchestrate` → server-composed prompt → `orchestrate.mjs init` → `run.json`. `park` is the default and appends nothing to the prompt, so a default run is byte-identical to today. What a run decided is recorded as `assumptions` pairs on the queue item, written by one new tool command that the tool itself refuses under `park`. The sheet's restructure is client-only: `--ids` is already executed in the order given.

**Tech Stack:** TypeScript, NestJS (server), React + Vite (client), Node's own test runner for `skills/*/tools/*.test.mjs`, jest `--runInBand` for everything in `test/`.

**Spec:** [docs/superpowers/specs/2026-09-05-orchestrate-question-mode-design.md](../specs/2026-09-05-orchestrate-question-mode-design.md)

## Global Constraints

**PLAN CONVENTION OVERRIDE — read this before any task.** This plan
deliberately does **not** follow the writing-plans template's "code blocks
required / repeat the code" rule, and an implementer must not treat its
absence as an omission to fill in from the template. Handed code gets
transcribed verbatim, so a defect in a plan's code becomes a defect on the
branch with nobody positioned to catch it — test scaffolding worst of all,
because it reads as boilerplate. Instead:

- **Tests are authoritative and given as exact cases**: input, expected
  output, expected exit code or expected rendered text. Write the test from
  the case table in this repo's own idiom.
- **Implementation is described by behaviour**, with exact identifier names,
  signatures and file locations. Choose the code yourself, and **disagree with
  this plan** where the codebase tells you something different — say so in the
  task's report rather than following it off a cliff.
- **The spec is the argument**; this plan is the sequence. Read the spec
  section each task names before starting it.

Other constraints, all verbatim from the spec:

- Values are `'decide'` and `'park'`. Absent means `park`; **present-but-invalid is a 400 on the wire and exit `1` in the tool — never a clamp.**
- `park` appends **nothing** to the spawn prompt. `decide` appends exactly `' --question-mode decide'`, positioned **after** `--merge-mode branch` when both are present, and after any ids.
- `orchestrate.mjs` remains the run file's **only writer**; `server/src/orchestrator/` remains its only reader. No task adds a second writer.
- `ATTENTION_KINDS` stays the closed set of three. No task adds a fourth.
- `1` is the tool's general failure exit code; `3` is "no run exists", `4` is "lock held". Nothing in this plan introduces a new code.
- Comments explain *why*, at length. Match the surrounding density — this repo's comments are load-bearing and stripping them is a review rejection.
- Size guidance in any task below is a **soft target**, never a rule. If a load-bearing comment or case pushes a file past it, keep the comment.

---

### Task 1: Vocabulary in `shared/`

**Spec:** §1, §4.

**Files:**
- Modify: `shared/types.ts` (beside `MergeMode`/`MERGE_MODES` at ~344-352; `RunQueueItem` at ~487; `OrchestratorRun` at ~592)
- Modify: `shared/agent.ts` (beside `isMergeMode` at ~50)
- Test: `test/agents-shared.test.ts`

**Interfaces:**
- Produces: `type QuestionMode = 'decide' | 'park'`; `const QUESTION_MODES: readonly QuestionMode[]`; `function isQuestionMode(value: unknown): value is QuestionMode`; `RunQueueItem.assumptions: { question: string; answer: string }[]`; `OrchestratorRun.questionMode: QuestionMode`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing guard tests**

Cases for `isQuestionMode` — each returns exactly the boolean shown:

| input | result |
|---|---|
| `'decide'` | `true` |
| `'park'` | `true` |
| `'Decide'` | `false` |
| `'merge'` | `false` |
| `''` | `false` |
| `null` | `false` |
| `undefined` | `false` |
| `42` | `false` |
| `{}` | `false` |

Plus: `QUESTION_MODES` contains exactly `['decide', 'park']`, and every member satisfies `isQuestionMode`.

- [ ] **Step 2: Write the failing exhaustiveness test**

A `Record<QuestionMode, true>` object literal listing both members, asserted non-empty. This is a compile-time device, not a runtime assertion: it exists so the build fails the day a third member is added and nobody classifies it. `test/agents-shared.test.ts` already uses this mechanism for `RunStage` — follow that one's shape and its comment's reasoning.

- [ ] **Step 3: Run the tests, confirm they fail**

`pnpm test -- agents-shared` — expected: TypeScript cannot resolve `QuestionMode`/`isQuestionMode`.

- [ ] **Step 4: Add the type, the constant and the guard**

`isQuestionMode` mirrors `isMergeMode`'s implementation exactly. Its doc comment must say why it is a guard rather than an inline comparison chain — the chain is a second copy of the vocabulary and it is the copy that goes stale.

- [ ] **Step 5: Add the two run-file fields**

`OrchestratorRun.questionMode: QuestionMode` — doc comment states: written once by `init`, never moved, and **why there is no `questionModeEffective`** (nothing degrades this mid-run, unlike a classifier denial moving merge→branch; a second field would record a divergence that cannot occur).

`RunQueueItem.assumptions: { question: string; answer: string }[]` — doc comment states: pairs not bare strings, because the archive's job is "what was asked *and* what did the runner decide"; and that `ArchiveQueueItem` is `Omit<RunQueueItem, 'verification'> & {…}`, so this field reaches the archive payload with no second declaration.

- [ ] **Step 6: Run tests, confirm pass**

`pnpm test -- agents-shared orchestrator-shapes` and `pnpm run typecheck`.

- [ ] **Step 7: Commit**

`feat(shared): QuestionMode vocabulary and the assumptions record`

---

### Task 2: `orchestrate.mjs init --question-mode`

**Spec:** §2.5.

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` (`INIT_USAGE` ~1075, `cmdInit` ~1077-1300)
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 — this file may not import from `shared/`. It carries its own `QUESTION_MODES` literal beside its existing `MERGE_MODES` one, the same deliberate duplication that constant already is.
- Produces: `run.json` with a top-level `questionMode` string.

- [ ] **Step 1: Write the failing tool tests**

Run under node's own test runner (`pnpm run test:skills`), not jest.

| invocation | expected |
|---|---|
| `init --project <p>` (no flag) | exit `0`; `run.json.questionMode === 'park'` |
| `init --project <p> --question-mode park` | exit `0`; `questionMode === 'park'` |
| `init --project <p> --question-mode decide` | exit `0`; `questionMode === 'decide'` |
| `init --project <p> --question-mode auto` | exit `1`; stderr names both legal values; **no `run.json` written** |
| `init --project <p> --question-mode` (no value) | exit `1`; stderr says "no value"; no `run.json` written |
| `init --project <p> --merge-mode branch --question-mode decide` | exit `0`; both fields set independently |

The "no `run.json` written" assertions are the load-bearing ones: `cmdInit` validates everything before it archives an existing run file, so a bad call can never destroy state that already existed.

- [ ] **Step 2: Run, confirm failure**

`pnpm run test:skills` — expected: the flag is unrecognised, so the new cases see `questionMode === undefined`.

- [ ] **Step 3: Parse and validate the flag**

Add to `cmdInit`'s argv loop beside `--merge-mode`; default `'park'`. Validate with `QUESTION_MODES.includes(...)`, throwing `OrchestrateError` with exit `1` — matching the `--merge-mode` check's own message shape, including its `(got no value)` branch for a flag with no argument.

Validation must sit **before** the archive/rename of any existing `run.json`, with the rest of the pre-write validation.

- [ ] **Step 4: Write the field**

One line in the `newRun` object literal beside `mergeMode`. Comment states it is written once here and never moved, pointing at `OrchestratorRun.questionMode` in `shared/types.ts` for the fuller rationale this file may not import but must uphold byte for byte — the same phrasing `mergeMode`'s own comment uses.

- [ ] **Step 5: Extend `INIT_USAGE`**

Append `[--question-mode <decide|park>]`.

- [ ] **Step 6: Run tests, confirm pass**

`pnpm run test:skills`

- [ ] **Step 7: Commit**

`feat(orchestrate): init --question-mode writes the run's question policy`

---

### Task 3: `orchestrate.mjs assume`, and its refusal under `park`

**Spec:** §4, §5.

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` (new `ASSUME_USAGE` + `cmdAssume`, placed beside `cmdAttention`; register in the command dispatch switch)
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs`

**Interfaces:**
- Consumes: `run.json.questionMode` from Task 2.
- Produces: CLI `assume <itemId> --json <file>`; appends to `RunQueueItem.assumptions`.

- [ ] **Step 1: Write the failing tests**

Given a run initialised with `--question-mode decide` and a queue containing `bug-1`:

| invocation | expected |
|---|---|
| `assume bug-1 --json <file with two pairs>` | exit `0`; `bug-1.assumptions` has both pairs, in file order |
| a second `assume bug-1 --json <file with one pair>` | exit `0`; **three** pairs — appends, never replaces |
| `assume bug-1` (no `--json`) | exit `1`; usage on stderr |
| `assume bug-1 --json <missing file>` | exit `1`; message names the path |
| `assume bug-1 --json <file containing `{}`>` | exit `1`; message says an array was expected |
| `assume bug-1 --json <file containing `[{"question":"q"}]`>` | exit `1`; message names the missing `answer` key |
| `assume nope-9 --json <valid file>` | exit `1`; the "not in this run's queue" path `stage` already uses |

Given a run initialised with `--question-mode park` (or with no flag at all):

| invocation | expected |
|---|---|
| `assume bug-1 --json <valid file>` | **exit `1`; message names the run's mode; `run.json` byte-identical to before the call** |

The byte-identical assertion is the point of the whole task — read the file before and after and compare.

Also: `attention bug-1 --kind needs-answers --detail "…" --questions-json <file>` still exits `0` under `decide`. `decide` is permission to answer, never an obligation to invent, and an item whose questions genuinely cannot be answered must still be able to park.

- [ ] **Step 2: Run, confirm failure**

`pnpm run test:skills` — expected: unknown command.

- [ ] **Step 3: Implement `cmdAssume`**

Reuse the existing shared queue-item lookup helper (the one `cmdStage` and `watch` both go through) rather than re-walking the queue — that factoring exists precisely so a new writer does not become a second code path.

Read and parse the `--json` file with the same posture `--questions-json` takes: a file rather than inline argv, because the content is prose the run composed and prose must not go through shell quoting.

The `park` refusal is checked **before** any parse or write, so a refused call cannot also report a file problem.

- [ ] **Step 4: Register the command and its usage**

Add to the dispatch switch and to whatever top-level usage listing the file already prints for an unknown command.

- [ ] **Step 5: Run tests, confirm pass**

`pnpm run test:skills`

- [ ] **Step 6: Commit**

`feat(orchestrate): assume records a decided answer, refused under park`

---

### Task 4: Server — resolution, controller field, prompt

**Spec:** §2.3, §2.4.

**Files:**
- Modify: `server/src/agents/agents.service.ts` (`AgentOrchestrateRequest` ~line 100-180; `orchestrate()` ~382-540; new `resolveQuestionMode` beside `resolveMergeMode` ~927)
- Modify: `server/src/agents/agents.controller.ts` (`orchestrate()` field-by-field rebuild ~136-160)
- Test: `test/agents-prompt.test.ts`, `test/orchestrator-start.test.ts`

**Interfaces:**
- Consumes: `isQuestionMode`, `QuestionMode` (Task 1).
- Produces: `AgentOrchestrateRequest.questionMode?: string`; private `resolveQuestionMode(questionMode: string | undefined): QuestionMode`.

- [ ] **Step 1: Write the failing resolution tests**

| `questionMode` in body | result |
|---|---|
| absent | prompt has no `--question-mode`; run starts |
| `''` | same as absent |
| `'park'` | same as absent (park appends nothing) |
| `'decide'` | prompt ends with `--question-mode decide` |
| `'Decide'` | **400**, uncoded, body echoes `"Decide"` |
| `'auto'` | **400**, uncoded |
| `42` | **400**, uncoded, body renders `42` (not `"42"`) |

Uncoded means: no `code` property. `RUN_IN_PROGRESS_CODE` stays the one machine-readable answer this route gives.

- [ ] **Step 2: Write the failing ordering and byte-identity tests**

| request | exact prompt |
|---|---|
| project only | `/backlog-orchestrate` |
| `ids: ['bug-1','task-2']` | `/backlog-orchestrate bug-1 task-2` |
| `mergeMode: 'branch'` | `/backlog-orchestrate --merge-mode branch` |
| `questionMode: 'decide'` | `/backlog-orchestrate --question-mode decide` |
| `ids: ['bug-1']`, `mergeMode: 'branch'`, `questionMode: 'decide'` | `/backlog-orchestrate bug-1 --merge-mode branch --question-mode decide` |

Assert the first four as exact strings, not substrings. Rows 1-3 are the regression guard: every prompt this endpoint composed before today must still be produced byte for byte.

- [ ] **Step 3: Write the failing precedence test**

A request carrying **both** an active fresh run and an invalid `questionMode` answers 409 with `RUN_IN_PROGRESS_CODE`, not 400 — the lock wins, the same way it already wins over a malformed `ids`.

- [ ] **Step 4: Run, confirm failure**

`pnpm test -- agents-prompt orchestrator-start`

- [ ] **Step 5: Implement `resolveQuestionMode`**

Mirror `resolveMergeMode` exactly, including its truncate-and-`JSON.stringify` echo convention (which is also what renders a non-string sensibly). Its doc comment must carry the **400-not-clamp** reasoning in this field's own terms: `model`/`effort` drop unknown values because "let the CLI decide" is coherent; this value is written verbatim into `run.json` and read out of the archive months later, so silently resolving a typo to `park` would put a claim in the archive no caller made. Absent is not a bug — it is every request written before the field existed — and that is the distinction a 400 preserves.

Call it beside `resolveMergeMode`, **after** the lock check.

- [ ] **Step 6: Add the controller field**

One line, `questionMode: body?.questionMode`, in the field-by-field rebuild, with the same "unvalidated here, the service is the one place a value is judged" comment its neighbours carry.

- [ ] **Step 7: Extend the prompt composition**

Append the compile-time literal selected by the resolved value. No caller substring reaches the string.

- [ ] **Step 8: Run tests, confirm pass**

`pnpm test -- agents-prompt orchestrator-start agents-origin-guard` and `pnpm run typecheck`.

- [ ] **Step 9: Commit**

`feat(server): carry questionMode from the board into the spawn prompt`

---

### Task 5: Settings — new key, new group, moved merge row

**Spec:** §2.1, §8.

**Files:**
- Modify: `client/src/lib/settings.ts` (`Settings` ~47, `DEFAULT_SETTINGS` ~108, `clampSettings` ~241)
- Modify: `client/src/components/settings/SettingsView.tsx` (`AgentsGroup` ~206-270; new group rendered above `<WatchdogGroup />` at ~194)
- Test: `test/settings.test.ts`, `test/settings-view.test.tsx`

**Interfaces:**
- Consumes: `QUESTION_MODES`, `QuestionMode` (Task 1).
- Produces: `Settings.orchestrateDefaultQuestionMode: QuestionMode`, default `'park'`.

- [ ] **Step 1: Write the failing clamp tests**

| stored value | clamped result |
|---|---|
| absent | `'park'` |
| `'decide'` | `'decide'` |
| `'park'` | `'park'` |
| `'auto'` | `'park'` |
| `42` | `'park'` |
| `null` | `'park'` |

Unlike `staleDays`, there is no nearest-bound behaviour to test — the union is closed, so `pickOne` falls back to the default and that is the whole rule.

- [ ] **Step 2: Write the failing view tests**

- A group titled `Orchestrator · this device` renders, and it renders **above** the watchdog group.
- It contains a control labelled `Default merge mode` and one labelled `Default question mode`.
- The group titled `Claude Agents · this machine` **no longer** contains `Default merge mode`, and **still** contains `Default model` and `Default effort`.
- Changing the question-mode control persists the new value (assert through the settings hook the other rows are tested through).

- [ ] **Step 3: Run, confirm failure**

`pnpm test -- settings settings-view`

- [ ] **Step 4: Add the key**

Type, default, and a `pickOne` clamp against `QUESTION_MODES` — identical in shape to `orchestrateDefaultMergeMode`. Comment: no `''`/"CLI default" third state, because the union is already closed and every run has some behaviour here whether or not anyone chose it.

- [ ] **Step 5: Add the group and move the row**

New `OrchestratorGroup` component in `SettingsView.tsx` beside `AgentsGroup`. Move the `Default merge mode` row into it verbatim, hint text unchanged. Add the question-mode row, hint carrying the doctrine: **want control over a question, start the run from a harness that has `AskUserQuestion`; start it from the board and you are choosing between skipping the item and letting the runner answer.**

`Default model` and `Default effort` stay in `AgentsGroup` — they genuinely are dispatch defaults.

- [ ] **Step 6: Run tests, confirm pass**

`pnpm test -- settings settings-view`

- [ ] **Step 7: Commit**

`feat(settings): Orchestrator group with the question-mode default`

---

### Task 6: The sheet becomes three steps

**Spec:** §7 (excluding §7.2-§7.4, which are Task 7).

**Files:**
- Modify: `client/src/components/board/OrchestrateSheet.tsx`
- Modify: `client/src/index.css` or the sheet's existing stylesheet — follow whatever the file already uses for `sheet-*` classes
- Test: `test/orchestrator-start-ui.test.tsx`

**Interfaces:**
- Consumes: `settings.orchestrateDefaultQuestionMode` (Task 5); `QuestionMode`, `QUESTION_MODES` (Task 1).
- Produces: `questionMode` on the `POST /api/agents/orchestrate` body.

Step 2 renders in this task as the selected rows in natural order with no controls — Task 7 makes it interactive. This split exists so a reviewer can reject the wizard chrome without rejecting reordering, or the reverse.

- [ ] **Step 1: Write the failing step tests**

- The sheet opens on step 1, showing the queue list and a Next control; there is **no Start control** on step 1.
- With nothing ticked and rows available, Next is disabled. (Same condition the current `emptySelection` guard uses — reuse it, do not restate it.)
- With an **empty queue**, the sheet keeps its current behaviour: it is not the "nothing ticked" state, and it still reaches Start.
- Next from step 1 shows step 2 listing exactly the selected ids in queue order; Next again shows step 3.
- Step 3 shows all five pickers and Start; Back returns to step 2 then step 1 with the selection intact.
- A `QUESTION_MODES`-keyed label record drives the picker, so the file fails to compile if a third member is added and nobody names it. Labels: `decide` → "Decide and continue", `park` → "Skip the item for me".
- The picker seeds from `settings.orchestrateDefaultQuestionMode`.
- `questionMode` is sent on **every** launch, both values.
- An untouched sheet still sends **no** `ids`.

- [ ] **Step 2: Run, confirm failure**

`pnpm test -- orchestrator-start-ui`

- [ ] **Step 3: Add step state and chrome**

A `step` state of `1 | 2 | 3`, a step indicator, Back/Next, and Start rendered only on step 3. The error slot and the existing 409/`RUN_IN_PROGRESS_CODE` handling move to step 3 with Start.

- [ ] **Step 4: Move the pickers and add the fifth**

The existing four-picker `sheet-row` moves into step 3 unchanged. The question-mode picker joins it, with a hint carrying the same doctrine sentence Task 5 put in Settings.

- [ ] **Step 5: Send the field**

Add `questionMode` to the request body built in `start()`.

- [ ] **Step 6: Run tests, confirm pass**

`pnpm test -- orchestrator-start-ui` plus the full suite once (`pnpm test`) — this file has style tests elsewhere that assert on its class names.

- [ ] **Step 7: Commit**

`feat(board): three-step orchestrate sheet with a question-mode picker`

---

### Task 7: Step 2 becomes a reorder control

**Spec:** §7.1-§7.5.

**Files:**
- Modify: `client/src/components/board/OrchestrateSheet.tsx`
- Test: `test/orchestrator-start-ui.test.tsx`

**Interfaces:**
- Consumes: the `step` chrome from Task 6.
- Produces: nothing outside this file. No server, tool or wire change — `resolveIds` and `buildGatedQueue` already run `--ids` in the order given.

- [ ] **Step 1: Write the failing reorder tests**

- Each row on step 2 has ↑ and ↓ controls; ↑ on the first row and ↓ on the last are disabled.
- ↓ on the first of three rows produces order `[2,1,3]`; ↑ on the last produces `[1,3,2]`.
- A "reset to natural order" control returns the list to queue order and returns the request to sending no `ids` (when nothing is deselected).
- **The pinning rule:** with every item selected and no reorder, the request sends **no** `ids`. With every item selected and *any* reorder applied, the request sends the **full id list in the chosen order**.
- Deselect-all-then-select-all with no reorder returns to sending no `ids` — the existing strict-subset rule must survive this task.
- **Reconciliation:** an id that leaves the queue while the sheet is open drops out of the order; an id that joins appends at the end. Drive this by re-rendering with a changed `items` prop.
- Step 2 renders a note that arranging the queue pins the run to these items, and a note that a `runner-fix:` item may still hoist above the chosen order.

- [ ] **Step 2: Run, confirm failure**

`pnpm test -- orchestrator-start-ui`

- [ ] **Step 3: Add order state**

`order: string[] | null`, `null` meaning natural. Derive the rendered list against the live queue every render — never store a resolved list — the same discipline `selected` already uses and for the same reason: a stale id can never then reach the request.

- [ ] **Step 4: Change the request condition**

From `narrowed` to `narrowed || order !== null`. The comment on `narrowed` currently explains why it is a strict-subset test and not a touched-flag; extend it rather than replacing it, stating that an order **is** a membership decision and that this reintroduces the sheet-open snapshot deliberately, which is why step 2 says so on screen.

- [ ] **Step 5: Add the two notes**

The runner-fix note must not claim to know *which* item hoists: the preview is client-side off `BacklogItem`, which carries no `runnerFix`, and the marker's authority is the blob at `<base>`, so a derived badge would be confidently wrong for an item marked but not yet committed.

- [ ] **Step 6: Run tests, confirm pass**

`pnpm test -- orchestrator-start-ui` then `pnpm test`.

- [ ] **Step 7: Commit**

`feat(board): hand-order the orchestrate queue in step 2`

---

### Task 8: Render assumptions

**Spec:** §4 (final paragraph).

**Files:**
- Modify: `client/src/components/board/RunDrawer.tsx`
- Modify: `client/src/components/runs/RunDetail.tsx`
- Test: `test/orchestrator-drawer.test.tsx`, `test/run-detail.test.tsx`

**Interfaces:**
- Consumes: `RunQueueItem.assumptions` (Task 1).
- Produces: nothing.

- [ ] **Step 1: Write the failing render tests**

- An item with two assumptions renders both question and answer text, in both surfaces.
- An item with `assumptions: []` renders **no section at all** — not an empty heading.
- An item whose `assumptions` key is **absent entirely** (an archived run from before this field) renders no section and does not throw.
- `RunStrip` renders nothing for assumptions — the strip states run-level facts, and this is per-item.

- [ ] **Step 2: Run, confirm failure**

`pnpm test -- orchestrator-drawer run-detail`

- [ ] **Step 3: Render in both surfaces**

In `RunDetail`, beside the stage track. Follow each file's existing per-item section idiom rather than inventing a third.

- [ ] **Step 4: Run tests, confirm pass**

`pnpm test -- orchestrator-drawer run-detail orchestrator-strip`

- [ ] **Step 5: Commit**

`feat(runs): surface what a run assumed on an item`

---

### Task 9: The skill's prose, and CLAUDE.md

**Spec:** §3, §5 (the non-enforced converse), and the doctrine sentence.

**Files:**
- Modify: `skills/backlog-orchestrate/SKILL.md` (§2 init passthrough at ~264; §3 "With questions: ask, best-effort" at ~409-437; the trigger grammar at ~41)
- Modify: `CLAUDE.md` (Invariants)
- Test: `pnpm run test:skills` (regression only — this task's deliverable is prose)

**Interfaces:**
- Consumes: `assume` (Task 3), `init --question-mode` (Task 2).
- Produces: nothing code-visible.

- [ ] **Step 1: Extend the trigger grammar**

Line ~41's grammar gains `[--question-mode decide]`, and the sentence below it says what shapes what — the same way `--merge-mode` is described there today.

- [ ] **Step 2: Extend §2's init passthrough**

Line ~264 currently says: when the trigger carries `--merge-mode branch`, add that flag to the `init` command. Add the same instruction for `--question-mode decide`. Keep them as two sentences, not one merged one — a run reading this on turn 300 skims, and a compound sentence is where a flag gets dropped.

- [ ] **Step 3: Rewrite §3's unanswered branch**

Three outcomes, explicitly:

- **Answered**, either mode → unchanged, the existing "Writing an answer into the item" path.
- **Not answered, `park`** → unchanged, verbatim: the questions file, `attention --kind needs-answers --questions-json`, `stage <id> needs-answers`, next item.
- **Not answered, `decide`** → decide each question; write the answers into the item body through that **same** existing write path, so the answer rides the worktree's commit into `main` and shows up in the diff; then `assume <id> --json <file>`; then continue to dispatch.

Two rules must appear with their reasons attached, because a bare prohibition is what drifts:

1. **Never restate an unanswered question in prose, in either mode.** A prose question ends the turn; in a board-started run that exits the session, `watch` sees it die, and the whole run needs `--resume`. Want a question answered — start the run from a harness that has `AskUserQuestion`.
2. **A decided answer is written as an assumption**, attributed to the runner, never phrased as though a human settled it.

Also state that `attention --kind needs-answers` remains available under `decide`: permission to answer is not an obligation to invent.

- [ ] **Step 4: Add the CLAUDE.md invariant**

Under Invariants, in the house voice, covering: the two values and that `park` is the default; that the two modes are **identical whenever the tool is reachable**, so the mode only ever takes effect in a headless run; the harness-versus-board doctrine; that `assume` is refused under `park` by the tool rather than by prose, and why; and that no fourth `ATTENTION_KIND` was added, with the classifier-denial precedent named.

- [ ] **Step 5: Verify nothing regressed**

`pnpm run test:skills && pnpm test && pnpm run typecheck`

- [ ] **Step 6: Commit**

`docs(orchestrate): question mode in SKILL.md and the invariants`

---

### Task 10: The hook (outside this repo — no commit)

**Spec:** §9.

**Files:**
- Modify: `~/.claude/hooks/remote-decision.sh` (the heredoc's rule 1)

This file is machine-local and is **not** part of this repo. It produces no commit and no test. It is in this plan because it is the cause of the investigation and would otherwise be forgotten once the feature lands.

- [ ] **Step 1: Replace rule 1 in the heredoc**

Exact replacement text:

```
1. Put EVERY decision through the AskUserQuestion tool — approach choices,
   "should I proceed?", scope calls, and questions a skill tells you to ask.
   Never end a turn on a prose question WHILE THAT TOOL IS AVAILABLE.
   If AskUserQuestion is not available in this session, this rule does not
   apply: follow whatever the running skill says to do without a channel,
   and if it says nothing, ask in prose rather than deciding silently.
```

The final clause is as load-bearing as the conditional: without it, a session that lacks the tool is left with no instruction at all, which is the state that produced the original silent deciding.

- [ ] **Step 2: Verify the hook still runs**

The heredoc is quoted (`<<'EOF'`), so no shell expansion applies to the new text. Confirm with `bash -n ~/.claude/hooks/remote-decision.sh`, then start any session in an auto permission mode and confirm the banner still appears with the new wording.

---

## Self-Review

**Spec coverage.** §1 → T1. §2.1 → T5. §2.2 → T6. §2.3, §2.4 → T4. §2.5 → T2. §3 → T9. §4 → T1 (field), T3 (writer), T8 (render). §5 → T3. §6 → no task by design; it is the decision *not* to widen `ATTENTION_KINDS`, restated as a constraint above and pinned in T9's invariant. §7 → T6, T7. §8 → T5. §9 → T10. §10 → distributed as each task's case tables. §11 → no task; it is the rationale record.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every task names exact files, exact identifiers and exact expected values. The absence of literal implementation code is the deliberate override stated in Global Constraints, not an omission.

**Type consistency.** `QuestionMode`, `QUESTION_MODES`, `isQuestionMode`, `resolveQuestionMode`, `questionMode` (wire, run file and request field), `orchestrateDefaultQuestionMode` (settings key), `assumptions` and its `{ question, answer }` element, `RunQueueItem`, `ArchiveQueueItem` — each spelled identically in every task that mentions it. `assume` is the command name in T3, T9 and the constraints alike.
