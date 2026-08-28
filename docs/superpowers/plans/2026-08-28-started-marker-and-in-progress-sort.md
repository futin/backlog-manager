# `started` Marker for Grooming + In-Progress-First Board Sort — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grooming an item marks it in progress for the duration of the groom session, and the
board grows an **In progress** status filter plus an in-progress-first sort that keeps the
selected sort as the tiebreak.

**Architecture:** No new frontmatter key and no new `ItemStatus` member — `started:` stays the
one lifecycle key and "in progress" stays derived (`status === 'open' && started !== ''`). The
change is three-sided: `backlog.mjs` stops refusing to `start` an idea; `backlog-groom` runs
`start` when it picks an item up and `stop` on its way out of every verdict; and the board
lifts the already-inlined in-progress rule into one helper that now feeds the card, a fourth
status filter option, and a primary sort key.

**Tech Stack:** Node ESM + node:test (skills), NestJS (untouched here), React + TypeScript,
jest + @testing-library/react (board), pnpm.

**Spec:** None — this was brainstormed as a **bounded** task and approved in chat on 2026-08-28.
The approved design is restated in full under *Approved design* below; that section is the spec.

## HOW TO READ THIS PLAN — overrides the writing-plans template

- **Test cases are authoritative; code is illustrative.** Where a step shows code, it is a
  sketch of intent, not text to transcribe. The **test cases and expected values are the
  contract** — implement whatever makes them pass, in the surrounding file's own idiom. This
  deliberately overrides writing-plans' "No Placeholders … code blocks required" rule: handed
  code gets transcribed verbatim, so a bug in this document would become a bug on the branch
  with nobody positioned to catch it.
- **Disagree with this plan when it is wrong.** If a step contradicts the code you are looking
  at, stop and say so rather than forcing it through.
- **Any size figure below is a soft target**, never a reason to drop a rule or a comment.

## Global Constraints

- **Comments explain *why*, at length.** This repo's comment density is deliberate — every
  file you touch here is heavily commented and your additions must match, not thin it out.
  A new branch in `matches` or `sortItems` needs a comment saying what breaks without it.
- **`started:` remains the only lifecycle key in frontmatter.** No `groomed-at:`, no
  `activity:`, no `status:`. Do not add a fourth `ItemStatus` member — `'started'` is a
  *filter* value in the client, not an item state.
- **`skills/backlog/tools/backlog.mjs` stays the registry's and the item files' only writer.**
- **`start`/`stop` must round-trip unknown frontmatter keys and the body byte-for-byte.**
- **Skill edits are inert** until committed, pushed, and `pnpm run plugin:sync` has run.
  Nothing in Tasks 4–6 takes effect in a live Claude Code session before that.
- Commands: `pnpm test` (jest, `--runInBand`), `pnpm run test:skills` (node test runner),
  `pnpm run typecheck`.

## Approved design (the spec)

Four decisions were settled with the user before this plan was written:

1. **Groom stops when it finishes.** `backlog-groom` runs `start` at pickup and `stop` on the
   way out, so the marker is live only while a groom session is actually running. A
   groomed-but-not-executed item returns to plain open, and `backlog-execute` later stamps its
   own `start`. Rejected alternative: stamp-and-leave, which would make the marker mean "was
   ever touched" instead of "someone is on this right now".
2. **Ideas become startable.** Grooming an idea is the main groom case, so `startItem`'s
   `ideas` refusal is dropped. The `done` / `out-of-scope` / already-started refusals stay.
3. **The Status select gains a fourth option**, `Open / In progress / Done / All`, derived from
   the same rule the card already renders — no new stored field.
4. **In-progress cards sort first within each column**, with the selected sort applied as the
   tiebreak between them.

## File Structure

| File | Change | Responsibility after the change |
|---|---|---|
| `client/src/lib/item-progress.ts` | **create** | The single definition of "is this item in progress". One exported predicate; no rendering, no formatting. Deliberately not folded into `item-age.ts`, which owns *how long ago*, not *whether*. |
| `test/item-progress.test.ts` | **create** | Truth table for that predicate. |
| `client/src/components/board/ItemCard.tsx` | modify (~line 34) | Renders a card. Stops owning the in-progress rule; imports it. |
| `client/src/components/board/BoardView.tsx` | modify | Adds `'started'` to `StatusFilter`, the fourth `<option>`, the filter branch, and the in-progress-first primary sort key. Also swaps its `hasLive` expression onto the shared predicate. |
| `test/board.test.tsx` | modify | Gains a fetch-stub helper for purpose-built item lists, plus filter and sort tests. |
| `skills/backlog/tools/backlog.mjs` | modify (~line 625) | Drops `startItem`'s `ideas` refusal. |
| `skills/backlog/tools/backlog.test.mjs` | modify (~line 970) | The idea case flips from refusal to success. |
| `skills/backlog-groom/SKILL.md` | modify | Gains the start/stop lifecycle around every verdict. |
| `skills/backlog/SKILL.md` | modify (~line 47–51) | The `»` marker's prose names groom as well as execute. |
| `shared/types.ts` | modify (~line 32–46) | `BacklogItem.started`'s doc comment names both writers. |
| `CLAUDE.md`, `docs/invariants.md` | modify | The `started:` invariant records the widened caller set and that `'started'` is a filter, never an `ItemStatus`. |

Tasks 1–3 (board) and Tasks 4–5 (skills) are independent of each other; Task 6 depends on all
of them. Task 2 and Task 3 both depend on Task 1.

---

### Task 1: The `isInProgress` predicate

**Files:**
- Create: `client/src/lib/item-progress.ts`
- Modify: `client/src/components/board/ItemCard.tsx` (the `inProgress` const, ~line 34)
- Test: `test/item-progress.test.ts` (create)

**Interfaces:**
- Consumes: `BacklogItem` from `shared/types`.
- Produces: `export function isInProgress(item: BacklogItem): boolean` — Tasks 2 and 3 both
  import this exact name from `client/src/lib/item-progress`.

**Why it moves.** The rule is two conditions, not one, and the second is the non-obvious one:
`move` never rewrites content, so an archived item keeps its `started` stamp as history. Drop
the `status === 'open'` half and every item ever shipped reads as in progress forever. That
reasoning currently lives in a comment above one `const` inside `ItemCard`; after this task
three call sites depend on it, so it needs one home. Carry the existing comment's substance
into the new file rather than paraphrasing it away.

- [ ] **Step 1: Write the failing test**

`test/item-progress.test.ts`. Plain node/jest, no jsdom docblock needed — this is a pure
function. Build items with a small local `fakeItem` helper in the same spirit as the one in
`test/board.test.tsx` (do not import that file's helper; it is not exported).

Cases, all asserting `isInProgress(item)`:

| `status` | `started` | expected | why this case exists |
|---|---|---|---|
| `'open'` | `'2026-08-28T14:03:07Z'` | `true` | the ordinary live item |
| `'open'` | `'2026-08-26'` | `true` | the permanent bare-date shape must count too |
| `'open'` | `''` | `false` | nobody picked it up |
| `'done'` | `'2026-08-28T14:03:07Z'` | `false` | **the regression guard** — an archived item keeps its stamp as history |
| `'terminal'` | `'2026-08-28T14:03:07Z'` | `false` | same, for a rejected item |

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test -- item-progress`
Expected: FAIL — cannot resolve `client/src/lib/item-progress`.

- [ ] **Step 3: Write the predicate**

One exported function, both conditions, with the comment explaining why the `status` half is
load-bearing.

- [ ] **Step 4: Point `ItemCard` at it**

Replace the inlined `const inProgress = …` with the import. `elapsed` still keys off
`inProgress` exactly as it does today; nothing about the card's rendering changes.

- [ ] **Step 5: Run the full suite plus types**

Run: `pnpm test && pnpm run typecheck`
Expected: PASS, including the untouched card and drawer suites — this step is a pure
refactor and any card-suite failure means the predicate does not match what was inlined.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/item-progress.ts test/item-progress.test.ts client/src/components/board/ItemCard.tsx
git commit -m "refactor(board): lift the in-progress rule into one predicate"
```

---

### Task 2: **In progress** as a fourth status filter

**Files:**
- Modify: `client/src/components/board/BoardView.tsx` (`StatusFilter` type ~line 21, the
  `matches` predicate, the `hasLive` expression, the Status `<select>`)
- Test: `test/board.test.tsx`

**Interfaces:**
- Consumes: `isInProgress` from Task 1.
- Produces: `type StatusFilter = 'open' | 'started' | 'done' | 'all'` — Task 3 does not depend
  on it, but the option order below is asserted by a test.

**The out-of-scope subtlety — read before writing the filter.** Today's predicate reads
`i.section === 'out-of-scope' || status === 'all' || i.status === status`. That leading
bypass exists because out-of-scope is flat and terminal, so the open/done select has no
opinion about it. Under `'started'` the bypass is **wrong**: it would show every rejected card
in a view whose heading promises live work. So the `'started'` branch must be tested *before*
the out-of-scope bypass, not after it. Comment this, because the ordering looks arbitrary and
is not.

- [ ] **Step 1: Write the failing tests**

In `test/board.test.tsx`, inside the existing `describe('BoardView')`:

1. *the Status select offers open, in progress, done and all, in that order* — read the
   options of `screen.getByLabelText('Status')` (the select carries `aria-label="Status"`) and
   assert the visible labels are exactly `['Open', 'In progress', 'Done', 'All']`.
2. *selecting In progress narrows to open items carrying a started stamp* — with the existing
   `ITEMS` fixture, only `bug-2` ("groomed bug", `started` 3h ago, status open) qualifies.
   After `userEvent.selectOptions` on the Status select, the four `col-count` values must read
   `['1', '0', '0', '0']`, and `screen.getByText('groomed bug')` must be present while
   `screen.queryByText('a bug')` is null.
3. *In progress hides out-of-scope items even though they bypass open and done* — the
   regression guard for the ordering above. `task-9` is done-with-a-stamp and `oos-1` is
   terminal; under **In progress** assert `queryByText('declined thing')` and
   `queryByText('finished task')` are both null. Assert this separately from case 2 even
   though the counts there already imply it: a future edit that re-adds the bypass should
   fail a test whose *name* says what broke.

Follow the file's existing idiom for driving the selects — `userEvent.selectOptions`, and
`await renderBoard()` first.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm test -- board`
Expected: FAIL — no `In progress` option; the selection either throws or leaves the board
unchanged.

- [ ] **Step 3: Implement**

Widen `StatusFilter`, add the `<option value="started">In progress</option>` between Open and
Done, and restructure `matches`'s status half into an ordered set of branches with the
`'started'` case first. Swap `hasLive` onto `isInProgress` while you are in the file — it is
the same rule spelled out a second time.

Do **not** add clamping for a stale stored `status` value; the project filter fails open and
the status filter does not, and that asymmetry is pre-existing and out of scope here.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm test -- board && pnpm run typecheck`
Expected: PASS, with the pre-existing default-open and All-filter tests still green.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/board/BoardView.tsx test/board.test.tsx
git commit -m "feat(board): filter the board down to what is in progress"
```

---

### Task 3: In-progress cards first, selected sort as the tiebreak

**Files:**
- Modify: `client/src/components/board/BoardView.tsx` (`sortItems`, ~lines 32–48)
- Test: `test/board.test.tsx`

**Interfaces:**
- Consumes: `isInProgress` from Task 1.
- Produces: `sortItems` keeps its current signature — `(items: BacklogItem[], sort: SortKey) => BacklogItem[]`.
  It stays module-private; nothing outside `BoardView` imports it.

**Shape.** Keep the three existing comparators *exactly* as they are — `name` by title,
`project` by project then newest-created, default by newest-created — and give them a primary
key in front: in-progress items rank 0, everything else ranks 1, ties fall through to the
selected comparator. Extracting the three into a `SortKey`-keyed record and running one sort
is the clean way to do that; the existing if/else chain, which sorts three different ways in
three branches, cannot express a shared primary key without repeating it three times. Keep the
existing comment about lexicographic `YYYY-MM-DD` ordering — it still explains why string
compare is correct here.

- [ ] **Step 1: Add a fetch-stub helper to `test/board.test.tsx`**

The suite's `beforeEach` installs one `global.fetch` mock over the fixed `ITEMS` fixture, and
several existing tests assert exact `col-count` values against it — so the sort tests must not
add items to `ITEMS`. Add a small helper alongside `renderBoard` that re-installs the same mock
shape over a caller-supplied `BacklogItem[]` (same `/api/agents/status` → `/api/projects` →
items branching, `errors: []`), and call it before `renderBoard()` in the two tests below.

- [ ] **Step 2: Write the failing tests**

1. *an in-progress card sorts above a newer one under Newest first* — three bugs in one
   project: `old-live` created 10 days ago with a `started` stamp, `new-idle` created today
   with `started: ''`, `mid-idle` created 5 days ago with `started: ''`. Under the default
   sort, read the bugs column's card titles in DOM order and assert
   `['old-live', 'new-idle', 'mid-idle']` — the live card jumps the newer ones, and the two
   idle cards keep newest-first between themselves.
2. *two in-progress cards keep the selected sort between them* — the tiebreak case the user
   asked for. Four bugs: `zulu-live` and `alpha-live` both stamped, `beta-idle` and
   `yankee-idle` not. Select **By name**, then assert the column reads
   `['alpha-live', 'zulu-live', 'beta-idle', 'yankee-idle']`: both live cards on top, and
   alphabetical order holding inside each group rather than only inside the idle one.

Read card order via `within(bugsColumn).getAllByTestId(...)` or the `.board-card` elements the
existing count assertion already queries — match whichever the file already uses; do not add a
new test id to `ItemCard`.

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm test -- board`
Expected: FAIL — test 1 reports `['new-idle', 'mid-idle', 'old-live']`.

- [ ] **Step 4: Implement the primary key**

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm run typecheck`
Expected: PASS. Confirm the Task 2 filter tests are still green — the counts there are
order-independent, so a green filter suite and a green sort suite together mean the two
changes compose.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/board/BoardView.tsx test/board.test.tsx
git commit -m "feat(board): float in-progress cards to the top of every column"
```

---

### Task 4: `start` accepts an idea

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` (`startItem`, the `ideas` refusal ~line 625)
- Test: `skills/backlog/tools/backlog.test.mjs` (~line 968–983)

**Interfaces:**
- Produces: `startItem(backlog, id, stamp?)` — signature unchanged; the refusal set shrinks by
  one. Task 5's skill prose depends on this succeeding for an idea.

**Why the refusal existed and why it goes.** Its comment says an idea is the one open section
with nothing to execute, so a hand-typed `start idea-5` would put a marker on a card no skill
would ever clear. Task 5 is exactly the skill that clears it. Replace the comment rather than
deleting it — the new one should say that grooming an idea *is* the active work the marker
describes, and that `backlog-groom` owns the clear.

`startItem` keeps refusing `done`, `terminal`, and an item that already carries a stamp.

- [ ] **Step 1: Flip the existing test**

Rewrite `CLI start idea-5 refuses and names backlog-groom…` into a success case: same
`boardFixture()` + `writeItem(backlog, 'ideas/open', 'idea-5', …)` setup, then assert
`out.status === 0` and that the file now carries a `started:` line it did not have before.
Also assert the item's **body is byte-identical** to what was written — the round-trip rule
applies to ideas as much as to bugs. Rewrite the comment block above it too; leaving prose
that says the tool refuses ideas is worse than no comment.

Leave every neighbouring refusal test (`bug-3` done, `oos-2` terminal, unknown id, missing id,
already-started) untouched — they must all still pass.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm run test:skills`
Expected: FAIL — exit 1 with `is an idea, not work`.

- [ ] **Step 3: Drop the refusal**

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm run test:skills`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add skills/backlog/tools/backlog.mjs skills/backlog/tools/backlog.test.mjs
git commit -m "feat(backlog): let an idea be started, because grooming one is work"
```

---

### Task 5: `backlog-groom` owns a marker for the length of its session

**Files:**
- Modify: `skills/backlog-groom/SKILL.md`
- Test: none — this file is prose read by a model, and the repo has no harness for it. Its
  correctness check is Step 3.

**Interfaces:**
- Consumes: `start` / `stop` from `backlog.mjs`, including Task 4's widened `start`.

**What to add.** Four things, written in the file's existing register (direct second person,
`$CLAUDE_PLUGIN_ROOT`-prefixed bash blocks, prose that says *why* a rule exists):

1. **Pickup.** After the user confirms the item *and* the verdict — i.e. after the "Three
   verdicts" table's "wait for the user to confirm" instruction, not before it, because an
   unconfirmed item is not being worked — run
   `node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" start <id>`.
2. **The ownership rule.** If that command exits `1` saying the item is **already in
   progress**, do not treat it as an error and **do not run `stop` at the end** — some other
   session owns that marker and clearing it would tell the board that session had finished.
   Groom clears only a marker it set itself. Any *other* exit-1 from `start` is a real refusal
   and should be relayed the way the existing Refusals section relays refusals.
3. **The release.** Every verdict ends with
   `node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id>`, on the item that
   was groomed — not on a task Promote created, which nobody is working yet. Place it **before
   the final `move`** in Promote (step 6) and in Reject, so the move is the last thing that
   runs; note in the prose that `stop` is location-permissive and would work after the move
   too, so a resumed session that already moved the item can still clear the stamp. Plan the
   fix has no `move`, so its `stop` is simply its last step.
4. **Abandonment.** If the user walks away from the groom without a verdict, run `stop` before
   ending the turn. A stamp left behind reads on the board as a session still running, and the
   next `backlog-execute start` on that item will refuse with *already in progress*.

Also touch the two prose lines that currently describe the marker as execute's alone:
`skills/backlog/SKILL.md` ~line 47–51 says `»` means "backlog-execute marks it when it picks
the item up" — it is now groom as well. That file is otherwise unchanged.

- [ ] **Step 1: Write the prose**

- [ ] **Step 2: Re-read the whole verdict section end to end**

Every one of the three verdicts must have exactly one `start` before it and exactly one `stop`
after it, and the ownership rule must be findable from each. A verdict that starts and never
stops is the bug this task exists to avoid.

- [ ] **Step 3: Dry-run it against this repo's own backlog**

This repo is self-registered, so it has real items. Pick an open idea and walk the commands by
hand:

```bash
node skills/backlog/tools/backlog.mjs start <idea-id>
node skills/backlog/tools/backlog.mjs show <idea-id>
node skills/backlog/tools/backlog.mjs stop <idea-id>
node skills/backlog/tools/backlog.mjs show <idea-id>
```

Expected: the second `show` carries a `started:` line, the fourth does not, and
`git diff` on that item file is empty at the end. If the diff is non-empty, `start`/`stop` is
not round-tripping and that is a Task 4 bug, not a prose bug — stop and report it.

- [ ] **Step 4: Commit**

```bash
git add skills/backlog-groom/SKILL.md skills/backlog/SKILL.md
git commit -m "feat(groom): hold an in-progress marker for the groom session"
```

---

### Task 6: Sync the documented invariant

**Files:**
- Modify: `shared/types.ts` (`BacklogItem.started` doc comment, ~lines 32–46)
- Modify: `CLAUDE.md` (the `started:` invariant bullet)
- Modify: `docs/invariants.md` (§ "`started:` is the one lifecycle key in frontmatter, and it
  is not a status")
- Test: none; `pnpm test && pnpm run test:skills && pnpm run typecheck` is the gate.

**What has to change, and what deliberately has not.** Three facts moved:

1. `started` is written by `backlog-execute` **and** `backlog-groom` now — execute holds it
   until the item is archived, groom holds it only for the length of a groom session. The
   `types.ts` comment currently says "when the item was picked up"; that is still true, but it
   should now say what *picked up* covers.
2. Ideas can carry a stamp. The `types.ts` comment and `docs/invariants.md` should both say so,
   because "an idea has nothing to execute" was the stated reason it could not.
3. `'started'` is a **filter value in the client**, never an `ItemStatus`. `shared/types.ts:22`
   already says "In progress is deliberately NOT a member here" — extend that sentence to also
   rule out the new filter option being mistaken for a fourth state, since a reader who has
   just seen `Open / In progress / Done / All` in the UI will come looking.

Unchanged on purpose, and worth saying so in the invariant text: the single-writer rule
(`backlog.mjs`), the byte-for-byte round-trip rule, the two permanent `started` shapes, and
the fact that "is this in progress" is answered in the client. Only the caller set widened.

- [ ] **Step 1: Update all three, in one pass**

Keep each edit local — this is not a rewrite of the invariant, it is three facts moving.
`CLAUDE.md`'s bullet is a summary that points at `docs/invariants.md` for the rationale; keep
that split (see commit `03497d9`, which created it deliberately).

- [ ] **Step 2: Full verification**

Run: `pnpm test && pnpm run test:skills && pnpm run typecheck`
Expected: all PASS. Report the actual output; do not claim green without it.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts CLAUDE.md docs/invariants.md
git commit -m "docs: record that grooming also holds the started marker"
```

- [ ] **Step 4: Publish the skill changes**

Tasks 4 and 5 are inert until the plugin is reinstalled from the pushed HEAD. After the branch
is merged:

```bash
pnpm run plugin:sync
```

`plugin:sync` refuses a dirty, unpushed, or behind working tree by design — if it refuses, the
push has not landed yet. Skill files reload on the next Claude Code restart.

---

## Self-review

**Spec coverage.** Decision 1 (groom starts and stops) → Task 5. Decision 2 (ideas startable) →
Task 4. Decision 3 (fourth filter option) → Task 2. Decision 4 (in-progress first, selected
sort as tiebreak) → Task 3. Task 1 is the shared predicate all of the board work needs; Task 6
is the documentation the repo's own invariant rules require.

**Type consistency.** `isInProgress` is the name in Tasks 1, 2, and 3. `StatusFilter` gains
exactly `'started'` — the same string in the type, the `<option value>`, and the filter branch.
`sortItems` keeps its signature. `startItem`'s signature is untouched.

**Known non-goals.** No clamping of a stale stored `status`; no distinguishing *grooming* from
*executing* on the card (that would need a second frontmatter key, which the invariant forbids);
no server-side change at all — `/api/items` already serves `started` verbatim.
