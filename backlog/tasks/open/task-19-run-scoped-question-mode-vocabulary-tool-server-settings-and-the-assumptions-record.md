---
id: task-19
title: Run-scoped question mode: vocabulary, tool, server, settings and the assumptions record
created: 2026-09-05
tags: orchestrate, skills, server, client, settings
---

## Goal

Give an orchestrator run a declared, recorded choice about what to do with an
item's open questions when nobody can answer them — `park` (today's behaviour:
record the questions, skip the item, keep draining) or `decide` (answer them
itself, write the answers into the item, record what it assumed, and execute) —
carried spawn → prompt → `init` → run file exactly the way `mergeMode` already
is.

This task is everything except the sheet. It ends with the field reachable
through `POST /api/agents/orchestrate`, honoured by the tool, recorded in
`run.json`, rendered in the run surfaces, and documented in the skill. **task-20
adds the picker that lets a person choose it from the board** and depends on
this one for `QuestionMode` and the settings key — land this first.

## Plan

The full argument is in
`docs/superpowers/specs/2026-09-05-orchestrate-question-mode-design.md`; the
step-by-step sequence, with each step's exact expected values, is
`docs/superpowers/plans/2026-09-05-orchestrate-question-mode.md`. **Read the
plan's Global Constraints section before writing anything** — it carries a
deliberate convention override (tests are authoritative and given as exact
cases; implementation is described by behaviour, not handed as literal code)
that an implementer must not "correct" back to the template.

This task is that plan's **Tasks 1, 2, 3, 4, 5, 8 and 9**, in that order.
Tasks 6 and 7 are task-20 and are deliberately excluded.

1. **Vocabulary** (plan T1) — `QuestionMode = 'decide' | 'park'`,
   `QUESTION_MODES` and the `RunQueueItem.assumptions` /
   `OrchestratorRun.questionMode` fields in `shared/types.ts`; `isQuestionMode`
   in `shared/agent.ts` beside `isMergeMode`. One field, not three: nothing
   moves `questionMode` mid-run, so there is no `questionModeEffective`.
2. **`init --question-mode`** (plan T2) — parsed and validated in
   `cmdInit` against the tool's own `QUESTION_MODES` literal (it may not import
   from `shared/`), validated **before** any existing `run.json` is archived,
   written as one field beside `mergeMode`. Unrecognised value exits `1` with
   nothing written.
3. **`assume <id> --json <file>`** (plan T3) — the one writer of
   `assumptions`, appending rather than replacing, going through the existing
   shared queue-item lookup rather than a second walk. **Refuses under
   `questionMode: 'park'`** — exit `1`, run file byte-identical — the same
   division of labour `stage <id> merged` under branch mode already keeps,
   because SKILL.md is re-read on every one of a run's several hundred turns
   and prose drifts where a tool refusal does not. The converse is deliberately
   not enforced: `attention --kind needs-answers` stays legal under `decide`.
4. **Server** (plan T4) — `resolveQuestionMode` mirroring `resolveMergeMode`
   (absent and `''` → `park`; anything unrecognised → **400, never a clamp**);
   one field on the controller's rebuild; the prompt gaining exactly
   `' --question-mode decide'`, after `--merge-mode branch` and after any ids,
   with `park` appending nothing so a default run's prompt stays byte-identical
   to what ships today.
5. **Settings** (plan T5) — `orchestrateDefaultQuestionMode`, default `park`,
   clamped by `pickOne`; a new `Orchestrator · this device` group above the
   watchdog group, into which `Default merge mode` **moves** out of
   `Claude Agents · this machine`. `Default model` and `Default effort` stay
   where they are.
6. **Render the record** (plan T8) — assumptions per item in `RunDrawer` and
   `RunDetail`; nothing in `RunStrip`, which states run-level facts.
7. **Prose** (plan T9) — SKILL.md's trigger grammar, §2's `init` passthrough,
   and §3's unanswered branch rewritten to three outcomes; plus the two rules
   that must carry their reasons (never restate an unanswered question in
   prose, because ending the turn kills a headless run; a decided answer is
   written as an assumption attributed to the runner). Then the CLAUDE.md
   invariant.

## Test cases

Every case below is stated with its exact expected value in the plan document;
these are the groupings, not a second copy of the table.

- **Guards** (`test/agents-shared.test.ts`) — `isQuestionMode` over both
  members and over `'Decide'`, `'merge'`, `''`, `null`, `undefined`, `42`, `{}`;
  a `Record<QuestionMode, true>` literal so the build fails the day a third
  member lands unclassified.
- **Tool** (`skills/backlog-orchestrate/tools/orchestrate.test.mjs`, node's own
  runner via `pnpm run test:skills`) — `init` with no flag, `park`, `decide`, an
  unrecognised value, a valueless flag, and alongside `--merge-mode branch`;
  every failure asserted to leave **no `run.json` written**. `assume` appending,
  appending twice, rejecting a malformed file, rejecting an id not in the queue,
  and **refusing under `park` with the run file byte-identical before and
  after**. `attention --kind needs-answers` still exits `0` under `decide`.
- **Server** (`test/agents-prompt.test.ts`, `test/orchestrator-start.test.ts`) —
  the six-row resolution table; the five prompt compositions asserted as **exact
  strings**, not substrings, with the three pre-existing shapes as the
  byte-identity regression guard; and the lock (`RUN_IN_PROGRESS_CODE`, 409)
  winning over an invalid `questionMode` (400).
- **Settings** (`test/settings.test.ts`, `test/settings-view.test.tsx`) — the
  clamp falling back to `park` for every unrecognised stored value; the new
  group rendering above the watchdog group; `Default merge mode` present in it
  and absent from the Agents group, which still has model and effort.
- **Render** (`test/orchestrator-drawer.test.tsx`, `test/run-detail.test.tsx`) —
  two assumptions render in both surfaces; `[]` renders no section rather than
  an empty heading; an archived run whose queue items have **no `assumptions`
  key at all** renders no section and does not throw.
- **In the browser (playwright MCP tools):** open the app at
  `http://127.0.0.1:5177`, click Settings in the side rail, and confirm a group
  headed `Orchestrator · this device` is visible above `Orchestrator watchdog ·
  this server`, containing both a `Default merge mode` and a `Default question
  mode` control, and that the `Claude Agents · this machine` group above it no
  longer shows `Default merge mode`.

## Done when

- `pnpm test`, `pnpm run test:skills` and `pnpm run typecheck` all pass.
- A run started with `questionMode: 'decide'` has `"questionMode": "decide"` in
  its `run.json`, and one started without the field has `"questionMode":
  "park"`.
- `POST /api/agents/orchestrate` with `questionMode: 'auto'` answers 400 with no
  `code`, and the spawn never happens.
- `assume` writes under `decide` and refuses under `park`.
- The prompt for a request carrying no `mergeMode` and no `questionMode` is
  exactly `/backlog-orchestrate`, unchanged from before this task.
- SKILL.md §3 states all three outcomes and the two reasoned rules, and
  CLAUDE.md carries the invariant.
