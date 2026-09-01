# Archive view: four columns, month groups, and the two promotion paths

Implementation plan for `task-6` — Chunk D of
[docs/superpowers/specs/2026-08-30-board-growth-design.md](../specs/2026-08-30-board-growth-design.md).

**This plan deliberately carries no literal code blocks.** It names behaviour,
signatures, and exact test *cases* with exact expected values; the implementer
writes the code and is expected to disagree with anything here that turns out
wrong against the real files. Handed-down code gets transcribed verbatim, so a
bug in a plan becomes a bug on the branch with nobody positioned to catch it.
Any size figure below is a rough target, never a budget: nothing load-bearing
gets compressed away to hit one.

The risky part the item flagged is already settled, by the user, in the item
file itself: `AgentAction` grows a third member, `capture`, and dispatch keeps
its existing derive-never-accept shape end to end. That decision is the spine
of steps 1–3.

---

## 1. `shared/agent.ts` — the third derived action

- `AgentAction` becomes `'groom' | 'execute' | 'capture'`.
- `deriveAction` answers `'capture'` for an item in `out-of-scope`, **and for
  nothing else**. The section check runs FIRST, ahead of the
  `status !== 'open'` line — an out-of-scope item's status is `terminal`, so
  the old opening line would swallow it.
- A `done/` item still derives `null`. History has no next step; a rejection
  does. That asymmetry is the whole reason the two archives stop sharing a
  branch.
- **Rewrite the doc comment above `deriveAction`.** It currently says
  `status !== 'open'` "covers both archives in one line". That sentence
  becomes false in this change and must not be left standing: the replacement
  has to explain why `done` and out-of-scope used to share a branch and why
  they no longer do. The item file records this as the knowingly-accepted cost
  of the decision.
- `actionLabel` becomes a `Record<AgentAction, string>` lookup rather than the
  current `action === 'execute' ? … : 'groom'` ternary. Every label equals its
  action string today (`groom`, `execute`, `capture`), so the record buys one
  thing: the compiler refuses a fourth action that nobody labelled. Keep the
  `item` parameter — its doc comment already explains why.
- New exports for the controller's shape check: `AGENT_ACTIONS`, a
  `readonly AgentAction[]` of the three, and `isAgentAction(value: unknown)`
  as a type guard over it. The controller must not restate the union by hand;
  that duplication is exactly what this module exists to prevent.

Callers that need **no** change, verified by reading them, and worth stating so
the next reader does not re-verify:

- `dispatchGate` / `dispatchBlock` / `projectDispatchGate` never read the
  action.
- `runClaimBlock` matches on item id against a run queue.
- `OrchestrateSheet`'s queue preview already filters to
  `status === 'open' && (bugs | tasks)` **before** it calls `deriveAction`, so
  `capture` can never reach it and no out-of-scope row can appear in an
  orchestrate preview.

## 2. `shared/types.ts` — stop restating the union

`AgentPlan.action` and `AgentDispatchRequest.action` are both spelled
`'groom' | 'execute'` by hand. Both become `AgentAction`, imported from
`./agent` with a **type-only** import. `shared/agent.ts` already imports a
value (`RUN_CLAIMED_STAGES`) from `shared/types.ts`, so this closes a cycle on
paper — but a type-only import is erased before any bundler or runtime sees it,
so there is no runtime cycle. Say that in a comment at the import, because it
is the kind of thing a later reader "fixes" by re-duplicating the union.

## 3. Server — one prompt arm, one widened check

- `server/src/agents/agents.controller.ts`: the dispatch body's `action` check
  becomes `isAgentAction`. Error message must name all three:
  `action must be groom, execute or capture`.
- `server/src/agents/prompt.util.ts`: `SKILL` gains
  `capture: 'backlog-manager:backlog-capture'`. A capture arm sits beside the
  existing `execute` arm — keyed on the ACTION, before the section branches,
  because like `execute` it is decided by the action and not by which directory
  the item sits in.
  The capture sentence must say three things: file a **new** item, cite the
  original with `from: <id>` in its frontmatter, and leave the original where
  it is because the rejection is the record.
  **No slash command.** `test/agents-prompt.test.ts` asserts none ever appears,
  and the skills' own descriptions trigger on the natural-language phrasing.
  The item file's settled note writes this as "spawns `/backlog-capture`"; that
  names the skill, it does not license the slash spelling, and this module's
  own invariant wins.
- `agents.service.ts` needs **no** change: `plan()` and `dispatch()` are already
  generic over whatever `deriveAction` returns, and both already re-scan and
  409 on disagreement. That is the whole point of the settled decision — the
  new action rides the existing rails.

## 4. `client/src/lib/item-month.ts` — the grouping rule, on its own

A new module beside `item-age.ts` / `item-progress.ts` / `item-stale.ts`,
matching their shape: one question per file, delegating rather than re-parsing.

- `monthKey(item): string` — `YYYY-MM` derived from `updated` when non-empty,
  else `created`; `''` when neither is present or neither parses. Both stamp
  shapes must work (the permanent `YYYY-MM-DD` / second-precision-UTC fork
  documented in `item-age.ts` and `item-stale.ts`). UTC, like every other date
  read in this client.
- `monthLabel(key): string` — `aug 2026`. **Always with the year**, unlike
  `formatCreated`, which drops a current year: two Augusts a year apart are two
  groups, and headings that both read `aug` would present them as one. `''`
  labels as `undated`.
  Reuse `item-age.ts`'s `MONTHS` array — export it from there rather than
  copying it. Its comment (hardcoded, not `toLocaleString`, so a date does not
  render differently per locale) applies here verbatim and must not be
  duplicated.
- `groupByMonth(items): Array<{ key: string; label: string; items: BacklogItem[] }>`
  — newest key first; the `''` group always last regardless of sort. Within a
  group, newest-touched first by the parsed stamp, tie-broken on `id` so the
  order is stable rather than input-order-dependent, and so the `''` group
  (nothing to compare) still has a defined order.

## 5. `client/src/components/archive/ArchiveView.tsx` — the real view

Replaces the placeholder in the file that was written to become this view.

**Contents.** One predicate, `item.section === 'out-of-scope' || leavesBoard(item, staleDays, now)`.
It reuses `leavesBoard` (`lib/item-stale.ts`) — the same implementation
BoardView filters with, read from the other side, never a second copy. That is
what makes Board and Archive exactly complementary: `leavesBoard` already
exempts tasks and already answers `false` for anything not `open`, so done
items land in neither surface's columns and a stale task stays on the Board.

**Columns**, fixed, in this order: `Refactoring` (slug `refactors`), `Ideas`
(`ideas`), `Bugs` (`bugs`), `Out of scope` (`out-of-scope`). The first three
reuse the Board's own `.board-col-<slug>` tick colours for free; out-of-scope
falls through to the default grey tick, which is correct — the coloured ticks
are type identity and a rejection is not a type. Slug is the full section name:
`oos` was retired with the Board column and stays retired.

**Toolbar.** Title, search, project select. **No status select and no sort
select** — the design is explicit that the Status filter belongs to the Board,
because Archive's contents are defined by staleness and rejection rather than
by status. Sort is not offered either: month grouping is the ordering.

The project filter shares the Board's persisted key so "which project am I
looking at" survives a surface switch. To share it without ArchiveView
importing BoardView (which would pull the Board's whole lazy chunk into
Archive's and undo the code split), move the key constant into a small module
both import — `client/src/lib/view-keys.ts`. `STATUS_KEY`/`SORT_KEY` stay local
to BoardView; they are Board-only questions.

Search is plain `useState`, not persisted — the same reasoning BoardView
states.

**Clock.** `useNow(false)`: nothing in Archive can be in progress (an
in-progress item is never stale, and an out-of-scope one is never live), so the
surface never needs a ticking clock — but it still needs a `now` to compare
ages against, which is what the hook returns when disabled.

**Empty states**, three, mirroring the Board's own discipline of never
collapsing distinct causes onto one message: `board unavailable` on a failed
fetch with nothing kept, `nothing registered yet` for an empty registry,
`no matches` when the filters emptied a non-empty archive, and — the one the
Board has no equivalent of — `nothing archived yet` when the corpus genuinely
holds nothing stale and nothing rejected. The last two must not be merged: one
is fixed by the controls above it, the other means the archive is simply empty,
which on this surface is good news rather than a narrowing accident.

**Registry warnings** render here too, same markup as the Board. A missing
`backlog/` is a fact about the corpus, not about a surface, and Archive can be
the landing section.

**Cards.** `ItemCard`, with `item`, `hues`, `onOpen`, `agents`, `onDispatch`,
`now`, `runBlock`. Deliberately **no `stale` prop**: on this surface every card
in the first three columns is stale by construction, and a marker that is
always on says nothing — the same argument the card already makes for not
badging `groomed` on tasks. The column heading carries the fact instead. Update
`ItemCard`'s own comment on the `stale` prop, which currently anticipates
Archive marking them.

`runBlock` comes from `useOrchestratorRuns` + `runClaimBlock`, exactly as the
Board does it. A stale open item can be `pending` in a run's queue, and a
dispatch control that stayed live on Archive while the Board's went dead would
be the same half-fixed bug the run-claim block already exists to close.
Archive renders no run strip and no run drawer — a run is queue work, and this
surface is what is not queue work.

**Promotion.** Both paths are the existing dispatch path, unchanged, and that
is the point:

- a stale item's control derives `groom` — the groom session's own
  `start`/`stop` refreshes `updated:` and the item is back on the Board at the
  next load;
- an out-of-scope item's control derives `capture` — a new item citing
  `from: oos-N`, with the original left rejected.

Neither writes anything from the client. `ItemDrawer` and `LaunchSheet` mount
exactly as on the Board, including `key={dispatching.path}` on the sheet (the
remount-not-prop-change reasoning BoardView documents at length). The
drawer-and-sheet coexistence is Board behaviour and is kept, not re-litigated.

## 6. `client/src/styles.css`

- `.archive-month` — the sticky month subheader inside a column's card list.
  `position: sticky; top: 0`, an opaque background so cards do not show
  through, and a register that reads as subordinate to `.board-col-name` rather
  than competing with it (mono, small, `--ink3`-ish). It must not out-shout the
  column heading above it.
- `.dispatch-tab.capture` / `.dispatch-chip.capture` — the third tone, built
  the same way the existing two are (`color-mix` against `--strip`, hover
  fill). `--magenta`: groom is mustard, execute is cyan, and magenta is the one
  remaining accent already in every palette. The action IS the tone class, so a
  new action without a tone renders an uncoloured control — which is why this
  is not optional.

## 7. Tests

New: `test/archive.test.tsx` (jsdom docblock) and `test/item-month.test.ts`.
Amended: `test/agents-shared.test.ts`, `test/agents-prompt.test.ts`,
`test/agents-dispatch.test.ts`, `test/agents-plan.test.ts`,
`test/nav.test.tsx`.

### `test/item-month.test.ts`

1. `monthKey` prefers `updated` over `created` — an item with
   `updated: 2026-08-15T…Z` and `created: 2026-03-01` keys `2026-08`.
2. `monthKey` falls back to `created` when `updated` is `''`.
3. `monthKey` reads a bare `YYYY-MM-DD` `updated` as well as a timestamp.
4. `monthKey` is `''` when both stamps are empty, and `''` when the only stamp
   present is unparseable (`not-a-date`).
5. `monthLabel('2026-08')` is `aug 2026`; `monthLabel('')` is `undated`.
6. `monthLabel` keeps the year even for the current year — assert
   `2026-08` and `2025-08` produce two different labels.
7. `groupByMonth` orders groups newest-first and puts the `''` group last even
   though `''` sorts first as a string.
8. Within a group, the most recently touched item comes first; two items with
   the same stamp order by `id`.

### `test/archive.test.tsx`

Fixture shape follows `test/board.test.tsx`: a `fakeItem` factory with a
derived unique `path`, clock-relative stamps (never literals — a literal date
silently changes meaning as the calendar moves), and a `fetch` stub answering
`/api/agents/status`, `/api/projects`, and the items index. Include a real
`AgentsStatus` with both project paths visible, so dispatch controls render.

1. Titles itself `Archive` and renders exactly four columns, named
   `['Refactoring', 'Ideas', 'Bugs', 'Out of scope']` in that order.
2. An out-of-scope item renders in the `Out of scope` column and in none of the
   other three.
3. A done bug, a done refactor and a done task render in no Archive column at
   all — however old their stamps are.
4. A stale task (`updated` well outside the window, `section: 'tasks'`) does
   not appear in Archive. It is the Board's, and `test/board.test.tsx` already
   asserts the other half.
5. A fresh bug (`updated` inside the window) does not appear in Archive.
6. A stale bug DOES appear in the Bugs column — the positive case that stops
   1–5 passing on an Archive that renders nothing.
7. No `Status` select and no `Sort` select; a `Project` select and a search box
   both present. Query by accessible name, not by DOM order.
8. Month subheaders: three stale bugs stamped in three different months plus
   one with neither stamp render four subheaders, newest month first, with
   `undated` last.
9. A stale bug's dispatch tab reads `groom`.
10. An out-of-scope card's dispatch tab reads `capture`.
11. The project filter narrows the columns; the search box narrows on title.
12. `nothing archived yet` when the index has items but none are stale or
    rejected; `no matches` when a filter empties a non-empty archive. Two
    distinct assertions — a single "empty" assertion would pass on a view that
    conflated them.

### `test/agents-shared.test.ts`

- Replace the existing `has nothing to dispatch for an archived item or an
  out-of-scope one` case. A done item still derives `null`. An out-of-scope
  item now derives `'capture'` — assert it explicitly against
  `{ section: 'out-of-scope', status: 'terminal', groomed: null }`, i.e. with
  the terminal status that the old opening line used to swallow, so the case
  pins the ordering and not just the return value.
- `actionLabel(item, 'capture')` is `'capture'`.
- `AGENT_ACTIONS` holds exactly the three, and `isAgentAction` accepts each of
  them while rejecting `'archive'`, `''`, `null` and a non-string.

### `test/agents-prompt.test.ts`

- `composePrompt(oosItem, 'capture')` names
  `backlog-manager:backlog-capture`, contains `from: oos-1`, and says the
  original is not moved.
- The existing "no slash command ever appears" assertion must cover the capture
  arm too.

### `test/agents-dispatch.test.ts`

- Add a `bugs/done` fixture, so the suite still has an item with genuinely no
  next step. The existing `409s an item with no next step at all` case moves
  onto it — the out-of-scope path is no longer that case.
- Dispatching `action: 'capture'` against `oos-1-declined.md` spawns: expect
  201, and assert the prompt actually sent to the dashboard names
  `backlog-manager:backlog-capture`.
- Dispatching `action: 'groom'` against that same item 409s with a message
  containing `capture` — the derive-never-accept rule, exercised on the new
  action.
- A body with `action: 'archive'` 400s with
  `action must be groom, execute or capture`.

### `test/agents-plan.test.ts`

- The existing `404s an item with no next step` case moves to the new
  `bugs/done` fixture.
- `plan` for `oos-1-declined.md` answers 201 with `action: 'capture'` and a
  prompt naming `backlog-manager:backlog-capture`.

### `test/nav.test.tsx`

Archive is deliberately left un-stubbed there, and it now fetches. Add a
`fetch` stub (items index + projects + agents status) and replace the
placeholder-copy regex with a marker unique to the real Archive — the
`Out of scope` column name, with the stub carrying one out-of-scope item so a
column exists to name.

## 8. Docs

- `CLAUDE.md`: the client bullet still says "Archive is a placeholder until its
  own chunk lands" — it lands here. The dispatch invariant
  ("Dispatch derives the action; it never accepts one") gains the third action
  and the reason a rejection has a next step where a done item does not.
- `README.md`: check whether it describes the board's surfaces; it was updated
  for the four-column reorder, so it may need the Archive columns too.

## Done when

`pnpm test` and `pnpm run typecheck` are both green, and the two promotion
paths are reachable from Archive without the client ever writing a file.
