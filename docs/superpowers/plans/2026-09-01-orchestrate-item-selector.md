# Plan — orchestrate item selector (ids only)

**Date:** 2026-09-01
**Scope:** let the board choose *which* groomed items an orchestrate run drains,
instead of always draining the whole queue.

> **How to read this plan.** It specifies *behaviour* and *exact test cases*, and
> deliberately contains **no literal implementation code** — handed code gets
> transcribed verbatim, and a bug in the plan becomes a bug in the branch with
> nobody positioned to catch it. Signatures, expected values and edge cases are
> authoritative; how they are satisfied is the implementer's call, and
> disagreeing with this document (in writing, before implementing) is a valid
> outcome. Any size figure below is a soft target, never a reason to compress a
> load-bearing comment away.

---

## 1. What exists today

Clicking **Orchestrate** on the board runs this chain:

1. `BoardView` renders the toolbar button only when a single project is selected,
   `projectDispatchGate` is not `hidden`, and that project has no fresh run
   (`client/src/components/board/BoardView.tsx:266`).
2. The button opens `OrchestrateSheet`, which shows a **read-only** preview list
   — open items in `bugs` + `tasks` whose `deriveAction` is non-null — plus
   permission-mode / model / effort pickers.
3. `start` → `POST /api/agents/orchestrate` with `{ project, model?, effort?,
   permissionMode }`. There is no ids field anywhere in the chain.
4. `AgentsService.orchestrate()` gates (enabled → `projectDispatchGate` →
   fresh-run lock → dashboard `dirName`), then spawns a headless session whose
   prompt is the bare constant `ORCHESTRATE_PROMPT = '/backlog-orchestrate'`.
5. That session runs `orchestrate.mjs init --project "$PWD"` with **no `--ids`**,
   so the queue is every ready bug and task, bugs-then-tasks, oldest first.

**The tool layer already supports the feature.** `plan` and `init` both accept
`--ids a,b,c` and parse it identically (`parseIdsArg`,
`skills/backlog-orchestrate/tools/orchestrate.mjs:592`); `--ids` restricts the run
to those ids **in the order given**, overriding the bugs-then-tasks ordering, and
an id matching no open item exits `1` naming it. `SKILL.md` documents the trigger
as `/backlog-orchestrate [ids…] [--max N] [--resume] [--abort]`. Nothing in the
skill or the tool needs to change.

## 2. What this adds

Checkboxes on the sheet's existing preview rows. When the selection is a strict
subset of the previewed queue, the request carries `ids: string[]` and the server
composes the spawn prompt as `/backlog-orchestrate <id> <id> …`.

Explicitly **out of scope** (chosen against, 2026-09-01): a `--max N` control, and
drag-to-reorder. `--ids` honours the order given, but this feature sends board
order only; reordering is a separate task if it is ever wanted.

## 3. The invariant this has to respect

CLAUDE.md: *"The orchestrate spawn prompt is a server-side constant."*
`ORCHESTRATE_PROMPT` is a constant precisely because a caller-supplied prompt is
the one way an attacker-controlled request could make an unattended headless
session do anything at all (see the constant's own doc comment, and
`origin.guard.ts`'s reasoning).

**This feature must not weaken that.** The rule it follows instead is the one
dispatch already applies to `action`: *derive, never accept*. The server accepts
a list of **item ids**, not prompt text, validates every one of them against that
project's own backlog, and **builds** the prompt itself. A request can therefore
influence *which of this project's real items* run — and nothing else. No
request value ever reaches the prompt string unvalidated.

That invariant's wording in CLAUDE.md needs a follow-up edit (§8) so the next
reader does not find a prompt with arguments and conclude the rule rotted.

Second invariant, unchanged and worth stating: the queue preview stays an
approximation. `orchestrate.mjs`'s gate is still the only authority and still
re-gates every item when the run starts. Selecting an ungroomed item is allowed —
the run will report it as ungroomed, which is information, not a bug.

## 4. Changes, layer by layer

### 4.1 `shared/` — id validation, one implementation

Add a single exported predicate for "is this a syntactically valid backlog item
id" plus the derived list validator. Place it where both sides can import it
(`shared/agent.ts` alongside `deriveAction`, or `shared/types.ts` — implementer's
call, but **one** implementation, imported by both server and client, never two).

- Valid id shape: lowercase letters, a hyphen, digits — `bug-1`, `task-12`,
  `ref-3`. Anchored. No path separators, no whitespace, no shell metacharacters
  can survive it.
- The shape check is a *cheap first gate*, not the security boundary. The real
  boundary is §4.3's membership check against the project's scanned items.

### 4.2 `client/` — the sheet

`OrchestrateSheet` gains one piece of state: the set of selected ids.

- **Default: every previewed row selected.** The sheet's current meaning ("this
  starts a whole-queue drain") must survive someone opening it and pressing start
  without noticing the checkboxes.
- Each `run-drawer-item` row gets a checkbox, labelled by the item id so the
  accessible name is unique (`aria-label` naming the id, or a `<label>` wrapping
  the existing id span — either, as long as `getByRole('checkbox', { name: /task-1/ })`
  finds exactly one).
- A **select-all / select-none** affordance in the sheet body. A header checkbox
  reflecting all/none/indeterminate is fine; two buttons are fine. Keyboard
  reachable either way.
- Start is **disabled when the selection is empty**, with visible text saying so.
  Sending `ids: []` must never reach the wire — `parseIdsArg` deliberately
  distinguishes "no flag" from "an explicit empty selection", and an empty list
  would mean a run with nothing in it.
- The request carries `ids` **only when the selection is a strict subset**. When
  everything is selected, omit the key entirely, so a full-queue run stays
  byte-for-byte the request it is today and still picks up items filed between
  sheet-open and start. Follow the existing absent-not-empty convention in this
  file (`...(model === '' ? {} : { model })`) — `JSON.stringify` drops undefined,
  which is what lets the server read "no restriction".
- The existing `sheet-note` disclaimer stays and gains one clause: when a subset
  is selected, the run considers **only** those items.
- `StartOrchestrateRequest` (`client/src/lib/agents.ts:179`) gains `ids?: string[]`.

### 4.3 `server/` — validate, then compose

`AgentsController.orchestrate` rebuilds the body field by field (CLAUDE.md: "The
controller rebuilds the dispatch body field by field"). Add `ids` to that rebuild
as `body?.ids`, **unvalidated at the controller**, matching how `model`/`effort`/
`permissionMode` are left to the service — the service is where a junk value
becomes either `undefined` or a rejection.

`AgentsService.orchestrate` — new step, placed **after** the existing gates
(enabled → gate → fresh-run lock → `dirName`) so a request that was going to be
refused anyway is still refused for the same reason with the same status:

1. Absent `ids` → behave exactly as today. Prompt is the bare constant.
2. Present but not an array of strings → **400**, `ids must be an array of item
   ids`.
3. Present and empty → **400**. Same reasoning as the client's disabled Start:
   an explicit empty selection is a run with nothing in it, and silently treating
   it as "everything" would be the opposite of what the caller asked.
4. Any entry failing the §4.1 shape check → **400** naming the offending id.
5. Any entry not matching an **open** item in **this project's** backlog → **409**
   naming it. Resolution reuses the same machinery `findItem` already uses —
   `scanProject` over the registry entry whose path is `req.project`, filtered to
   `status === 'open'`. Do **not** reuse `resolveAllowed`/`buildAllowlist` here:
   that pair answers "is this path inside some registered store", and the question
   here is narrower — "is this id an open item of *this* project".
6. Duplicates: de-duplicate, preserving first-seen order. Not an error.
7. Sections: an id resolving to an item outside `bugs`/`tasks` → **409** naming
   it. `GATE_SECTIONS` in `orchestrate.mjs` is bugs+tasks only, so such an id
   would make `init` exit `1` inside an unattended session that has already been
   spawned — refuse it here, where there is still a human looking at an error.
8. Prompt composition: `ORCHESTRATE_PROMPT` followed by the validated ids,
   space-separated, in request order. Keep `ORCHESTRATE_PROMPT` itself a constant
   and compose around it; do not turn it into a template that takes caller text.
   Update its doc comment to explain that ids are the one thing that can vary,
   why that is not a hole (they are validated identifiers naming this project's
   own files, never free text), and that the "no `prompt` field" rule is unchanged.

`AgentOrchestrateRequest` gains `ids?: unknown` (or `string[] | undefined` with the
service doing the narrowing — implementer's call, as long as a non-array reaching
the service produces case 2's 400 rather than a 500).

A cap on list length is worth having as a cheap DoS/absurdity guard — the number
of open items in the project is a natural ceiling, and membership validation
already enforces it implicitly. No separate constant needed.

### 4.4 `skills/` — nothing

No change to `orchestrate.mjs` or `SKILL.md`. Worth noting for the implementer:
SKILL.md §1 says *"Show the user this table and get agreement on it before
starting a run, unless the trigger already named ids explicitly."* So a
board-started run that names ids skips the in-session agreement step — which is
correct here, because **the sheet was that agreement step**. A full-queue run
(no ids) keeps asking, exactly as today.

## 5. Test cases

New/extended suites. Test names are indicative; the *cases* are authoritative.

### `test/orchestrator-start.test.ts` (server, supertest against `AppModule`)

The suite already has `stubDashboard()` capturing every outbound call, so the
assertion target throughout is **the `prompt` field of the captured `/api/spawn`
body**.

| # | Request | Expected |
|---|---|---|
| 1 | no `ids` key | 200; spawn prompt is exactly `/backlog-orchestrate` (regression — today's behaviour must not move) |
| 2 | `ids: ['task-1']`, that item open in the project | 200; spawn prompt is exactly `/backlog-orchestrate task-1` |
| 3 | `ids: ['bug-2','task-1']`, both open | 200; prompt preserves **request order**: `/backlog-orchestrate bug-2 task-1` (not board order) |
| 4 | `ids: ['task-1','task-1']` | 200; prompt is `/backlog-orchestrate task-1` (de-duplicated) |
| 5 | `ids: []` | 400; no `/api/spawn` call recorded |
| 6 | `ids: 'task-1'` (string, not array) | 400; no spawn |
| 7 | `ids: ['../../etc/passwd']` | 400; no spawn |
| 8 | `ids: ['task-1; rm -rf /']` | 400; no spawn |
| 9 | `ids: ['task-99']` (well-formed, no such item) | 409 naming `task-99`; no spawn |
| 10 | `ids: ['task-1']` where `task-1` is `done`, not open | 409; no spawn |
| 11 | `ids: ['idea-1']` (open, but wrong section) | 409 naming `idea-1`; no spawn |
| 12 | `ids: ['task-1']` where `task-1` belongs to a *different* registered project | 409; no spawn |
| 13 | `ids: ['task-1']` **and** a fresh run exists for the project | 409 with `code: RUN_IN_PROGRESS_CODE`; no spawn — i.e. the lock still wins, ids are validated after it |
| 14 | `ids: ['task-1']` with `BM_AGENTS` off | 404 (unchanged); no spawn |

Case 13 exists because it is the one ordering mistake this change can make: an
ids-validation error must never mask the lock, since the lock is the one 409 the
client branches on.

### `test/orchestrator-start-ui.test.tsx` (jsdom, sheet)

Existing fixtures (`fakeItem`, `READY`, `PROJECTS`) extend to a multi-item
project. `startOrchestrate` is already mockable through the module boundary the
suite uses; the assertion target is the object it is called with.

| # | Scenario | Expected |
|---|---|---|
| 1 | sheet opens with 3 previewed items | 3 checkboxes, **all checked** |
| 2 | untouched, press start | `startOrchestrate` called with **no `ids` key at all** (regression: full-queue request is unchanged) |
| 3 | uncheck one of 3, press start | called with `ids` = the other two, in board order |
| 4 | uncheck all | start disabled; visible text explains why; `startOrchestrate` not called |
| 5 | uncheck all, then re-check one | start enabled again; `ids` = that one id |
| 6 | select-none then select-all, press start | back to case 2's behaviour — **no `ids` key** (all-selected must not degrade into an explicit full list, or a run would stop picking up items filed after the sheet opened) |
| 7 | ungroomed bug in the preview (labelled `groom`) | its checkbox is present and selectable — selecting it is allowed, per §3 |
| 8 | sheet shows a subset selected | the disclaimer text mentions the restriction |
| 9 | server answers 409 + `RUN_IN_PROGRESS_CODE` | unchanged: `refresh()` then `onClose()` (regression) |

Case 6 is the subtle one and the reason the "strict subset" rule is spelled out
in §4.2 rather than left as an optimisation.

### `test/agents-shared.test.ts` (or wherever §4.1's predicate lands)

Table test on the id predicate: accepts `bug-1`, `task-12`, `ref-3`; rejects ``
(empty), `task`, `task-`, `-1`, `Task-1`, `task-1.md`, `task 1`, `../task-1`,
`task-1;ls`, `task-1\n`, and a 500-char string.

### Unchanged suites that must stay green

`pnpm test` in full, and `pnpm run test:skills` — the latter proves the tool
layer was genuinely untouched.

## 6. Order of work

1. §4.1 predicate + its unit test (red → green).
2. §4.3 server validation + composition, with the §5 server table (red → green).
   Do the server before the client: the client is then written against a
   contract that already exists and is proven.
3. §4.2 sheet + its jsdom cases.
4. §8 docs.

## 7. Risks

- **Masking the lock.** Ordering mistake, caught by server case 13.
- **All-selected sending an explicit list.** Silently narrows a run to a stale
  snapshot of the queue. Caught by UI case 6.
- **Empty selection read as "everything".** The exact failure `parseIdsArg`'s own
  comment warns about, one layer up. Caught by server case 5 and UI case 4.
- **Invariant drift.** A future reader sees a prompt with arguments and assumes
  caller-supplied prompt text is now acceptable. Mitigated only by §8 — do not
  skip it.

## 8. Docs to update in the same change

- `CLAUDE.md`, the "orchestrate spawn prompt is a server-side constant"
  invariant: restate it as *the prompt is composed server-side; the only caller
  influence is a list of validated item ids naming this project's own open
  bugs and tasks; there is still no `prompt` field and free text is still never
  read.*
- `CLAUDE.md`'s `client/src/` layout line: `OrchestrateSheet` now selects a
  subset, not just previews.
- `ORCHESTRATE_PROMPT`'s own doc comment (§4.3).
- `docs/invariants.md` if it carries the long-form version of the prompt rule.
