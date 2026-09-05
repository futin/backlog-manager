---
id: task-20
title: Three-step orchestrate sheet with a hand-ordered queue
created: 2026-09-05
tags: orchestrate, client, board
---

## Goal

Split `OrchestrateSheet` into three steps — pick items, arrange them, choose
modes — and give the run's queue a hand order for the first time. The fifth
picker (question mode) is what forces the restructure; the restructure earns
itself by taking Start out from under a scroll region whose length is the size
of the project's queue.

**Depends on task-19**, which adds `QuestionMode`, `QUESTION_MODES` and
`settings.orchestrateDefaultQuestionMode`. Do not start this one first — the
picker in step 3 has nothing to seed from or send until that lands.

Client-only. No server, tool or wire change: `--ids` is **already** executed in
the order given, by both `resolveIds` (*"Order is load bearing … this loop must
never reorder what it was handed"*) and `buildGatedQueue`
(`ordered = ids.map(...)`).

## Plan

The argument is
`docs/superpowers/specs/2026-09-05-orchestrate-question-mode-design.md` §7; the
sequence with exact expected values is
`docs/superpowers/plans/2026-09-05-orchestrate-question-mode.md`, **Tasks 6 and
7**. Read that plan's Global Constraints section first — it carries a
deliberate convention override (tests authoritative and given as exact cases;
implementation described by behaviour, not handed as literal code) that must
not be "corrected" back to the template.

1. **Step chrome and the fifth picker** (plan T6). A `step` state of
   `1 | 2 | 3`, a step indicator, Back/Next, and Start rendered only on step 3.
   Step 1 is the existing queue list and checkboxes, with Next disabled on the
   existing `emptySelection` condition — reuse it, do not restate it. Step 2
   renders the selected rows in natural order with **no controls yet**; making
   it interactive is stage 2 below, and the split exists so a reviewer can
   reject the chrome without rejecting reordering. Step 3 takes the existing
   four-picker row unchanged, plus the question-mode picker, the merge-check
   hint, the error slot and the existing 409/`RUN_IN_PROGRESS_CODE` handling.

   The picker is driven by a `QUESTION_MODES`-keyed label record, the same
   device `MERGE_MODE_LABELS` is, so the file stops compiling if a third member
   is ever added and nobody names it. Labels name the outcome: `decide` →
   "Decide and continue", `park` → "Skip the item for me". Its hint carries the
   doctrine — *want control over a question, start the run from a harness that
   has `AskUserQuestion`; start it from the board and you are choosing between
   skipping the item and letting the runner answer.*

2. **Step 2 becomes a reorder control** (plan T7). `order: string[] | null`,
   `null` meaning natural order, derived against the live queue every render —
   never a stored resolved list — the same discipline `selected` already uses,
   so a stale id can never reach the request. ↑/↓ buttons per row plus a reset
   control; **not** drag-and-drop, which jsdom cannot assert and which is a much
   larger build on the last screen before a multi-hour unattended operation.

   The request condition changes from `narrowed` to `narrowed || order !== null`.
   Extend `narrowed`'s existing comment rather than replacing it: it currently
   explains why a strict-subset test beats a touched-flag, and an order **is** a
   membership decision, so this reintroduces the sheet-open snapshot on purpose
   — which is why step 2 has to say so on screen.

   Two notes on step 2: arranging the queue pins the run to these items; and a
   `runner-fix:` item may still hoist above the chosen order. The second must
   **not** claim to know which item that is — the preview is client-side off
   `BacklogItem`, which carries no `runnerFix`, and the marker's authority is
   the blob at `<base>`, so a derived badge would be confidently wrong for an
   item marked but not yet committed.

## Test cases

In `test/orchestrator-start-ui.test.tsx` unless noted. Exact expected values
are in the plan document.

- **Steps** — the sheet opens on step 1 with no Start control; Next is disabled
  with nothing ticked but rows present; an **empty queue** is not that state and
  still reaches Start; Next shows step 2 listing exactly the selected ids in
  queue order, then step 3; Back returns through both with the selection intact.
- **The picker** — seeds from `settings.orchestrateDefaultQuestionMode`; both
  labels render; `questionMode` is sent on **every** launch, for both values.
- **Reordering** — ↑ on the first row and ↓ on the last are disabled; ↓ on the
  first of three gives `[2,1,3]` and ↑ on the last gives `[1,3,2]`; the reset
  control returns to queue order.
- **Pinning** — everything selected and no reorder sends **no** `ids`;
  everything selected with any reorder sends the **full id list in the chosen
  order**; deselect-all-then-select-all with no reorder returns to sending no
  `ids`.
- **Reconciliation** — re-render with a changed `items` prop: an id that leaves
  the queue drops out of the order, one that joins appends at the end.
- **Notes** — step 2 renders both the pinning note and the runner-fix note.
- **Style suites** — `test/dispatch-busy-style.test.ts` already asserts against
  this sheet's class names and must stay green; run `pnpm test` whole rather
  than only this file, since the style suites are easy to miss when filtering.
- **In the browser (playwright MCP tools):** open the app at
  `http://127.0.0.1:5177`, pick a single project in the board's project filter,
  click Orchestrate in the toolbar, and confirm the sheet opens on a step 1
  showing the queue with checkboxes and no Start button; click Next and confirm
  step 2 lists the selected items with ↑/↓ controls and a note saying the run is
  pinned to these items; click Next again and confirm step 3 shows five pickers
  — Permission mode, Model, Effort, Merge mode, Question mode — and the Start
  button.

## Done when

- `pnpm test` and `pnpm run typecheck` pass.
- An untouched sheet still starts a whole-queue run, sending no `ids` — verified
  by test, because this is the behaviour the strict-subset rule exists to
  protect and the one this task is most likely to break.
- Reordering with everything selected sends every id, in the chosen order.
- Start appears only on step 3, and the sheet's 409 handling still works from
  there.
- No file under `server/`, `skills/` or `shared/` is modified by this task.
