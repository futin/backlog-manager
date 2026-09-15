---
id: task-37
title: Board: cards in columns, the run chip, runs off the board (DESIGN.md 8.3)
created: 2026-09-15
tags: fe-redesign, board
---

## Goal

Redraw the Board at the design's scale: a band (not a card) over four ramp-
coloured columns of `ItemCard`s, with the run strip, the starting strip and
the run drawer all replaced by one chip — `RunChip` — that opens the Runs
section instead of rendering a run in place. "Redesigned" for this surface
means the band, the columns, the card and the chip read in the new type
scale, tokens and rail this task inherits, and that nothing about *which*
run or item state the Board can show is lost in the process — only where it
is shown moves.

**Depends on `task-36`** (Foundation), which must already be merged to
`main`: this task composes `task-36`'s `Band`, `Chip`, `Pill`, `Dot` and
`Marker` primitives from `client/src/components/ui/`, and reads its rewritten
tokens (the column ramp's four colours, `--fill-live`/`--fill-progress`,
the type scale). Do not start this task against a `main` that does not yet
have `task-36` merged.

## Plan

Authority: `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §3
(lines 294–364, subsections 3.1–3.5) and `.claude/DESIGN.md` §8.3. Read both
in full; what follows names the files and the composition, not a restatement
of the numbers.

### 1. The band — spec §3.1, DESIGN.md §8.3 "The band"

Compose `Band` (from `task-36`) in `BoardView.tsx`: title 19/500, the 13 px
`--ink2` count line (`21 open across 3 projects`), then right-aligned the
36 px search field and the filter chips as `Chip` (`variant: outline`).
Orchestrate becomes the page's one `Chip` at `variant: ink`. **Its
hide/disable rules are unchanged** — this task redraws the control, it does
not touch `projectDispatchGate`/`resumeGate`/`runClaimBlock` or any of the
three blocks a dispatch control already honours.

### 2. The run chip — spec §3.2, DESIGN.md §8.3 "The run chip"

New file, `client/src/components/board/RunChip.tsx` (a page-level
composition per spec §12.3, not a `ui/` primitive — it is Board-specific).
Reads the same `useOrchestratorRuns` payload `BoardView` already holds
(`runs`, `starting`) — no new request. Its `Dot` takes the **worst** state
present: `--fill-progress` for live, `--fill-live` for paused or starting,
`--red` for crashed — precedence exactly crashed > (paused or starting) >
live. Beside it a 12/500 count line names every state present:
`2 runs · 1 live ›`, `1 run · crashed ›`, `1 starting ›` are the three
worked examples in both the spec and DESIGN.md. It renders the payload's
`starting` array **with no client-side filter** — the same rule `StartingStrip`
follows today; carry that rule forward rather than re-deriving it. It is a
`<button>` whose click calls the same section setter the rail uses
(`resolveSection`/`SECTIONS`, unchanged since `task-36`). It renders nothing
— not an empty chip — when the payload carries no run and no starting entry.

### 3. Columns — spec §3.3, DESIGN.md §8.3 "Columns"

Extract a `BoardColumn` component (spec §12.3 lists it as a Board
composition) from the inline column markup `BoardView.tsx` renders today
(`board-columns` / `board-col` / `board-col-h`, around line 848). Grid:
`repeat(4, minmax(0, 1fr))` at 16 px gaps, two columns under 1100 px, one
under 700 px — explicit steps, not `auto-fit`. Header: an 8 px `Dot` in the
column's ramp hue (task-36's tokens: refactors `--amber`, ideas
`--mustard`, bugs `--red`, tasks `--green` — replacing today's
magenta/mustard/red/cyan), the name at 15/500, then a `Pill`
(`tone: neutral`, 22×20, 11/500 on `--strip-hi`) carrying the count, pushed
right. No rule drawn under the header — the cards' own ground gap is the
only separation (the "nothing on `--board` uses `--strip-hi` as its only
separator" rule from DESIGN.md's intro to §8 does not apply here, since the
separator is a gap, not a stroke).

### 4. The card — spec §3.4, DESIGN.md §8.3 "The card"

`ItemCard.tsx` — `--strip` fill, 12 px radius, no stroke, no shadow; hover
changes the cursor and nothing else, a card being a button by role rather
than a hover target. Face padding 14/16/12, 10 px internal gap.

- Title 14/500, 1.35, wraps.
- Foot row: 8 px `Dot` (`hue`) + project name 12/400 `--ink2` (ellipsised),
  then `id · date` 12/400 `--ink3` pushed right, `flex: none`.
- Marker row, drawn only when a `Marker` applies **or** dispatch is
  available: `groomed` `--green`, `chore`/`debt` `--ink3`, `done` `--ink2`,
  `stale` `--mustard`. Same words, same tokens as today — this is a
  re-skin of `REFACTOR_KINDS` and the existing marker logic
  (`ItemCard.tsx`), not a new derivation.
- **The live strip.** 24 px across the card's top edge, `--fill-live` with
  `.hatch`, 11/500 `--ink` text — stage word left, elapsed reading right.
  `liveBarFor` (`ItemCard.tsx`) is the existing pure function that already
  derives this bar's label/tone/anchor from `ACTIVE_RUN_STAGES` /
  `ATTENTION_RUN_STAGES` / `isInProgress`; **this task restyles its output,
  it does not rederive it.** The two-tone precedence it already encodes
  (attention → active → hand-session → none) is untouched; only the CSS
  changes, from whatever cyan/amber split exists today to the single
  `--fill-live` hatched fill DESIGN.md §8.3 specifies — the word carries the
  distinction now, not the fill's colour. Read DESIGN.md §8.3's own note on
  why `reviewing` (a `RunStage`) and the hand-session's three words
  (`client/src/lib/item-progress.ts:39-43`) are deliberately not merged into
  one list before touching either.
- **The dispatch chip.** `DispatchButton` now composes `Chip` at 28 px,
  right end of the marker row, **always drawn** whenever the environment
  allows dispatch at all — never hover-revealed (a disabled control a user
  can click to re-ask its status, bug-13, has to be visible to be clicked).
  Its three disabled blocks (`dispatchGate`, `progressBlock`,
  `runClaimBlock`) and the re-ask click through `useReverify` are unchanged
  — this task never touches `DispatchButton`'s logic, only its shell.

### 5. What leaves the Board — spec §3.5, DESIGN.md §8.3 "What leaves"

Delete `client/src/components/board/RunStrip.tsx`,
`client/src/components/board/StartingStrip.tsx`,
`client/src/components/board/RunDrawer.tsx` and their CSS. **What must
survive, unchanged, in `BoardView.tsx`:** `useOrchestratorRuns` keeps
polling while any run is `running`, fresh or not; `runClaimBlock` and
`runHoldsItem` (`shared/agent.ts`) keep exactly the inputs they take today —
the Board still needs both to draw the card's live strip and to block
dispatch on a claimed item. The toolbar Orchestrate control's hide-on-
`starting` rule is unchanged. Everything `RunStrip`/`StartingStrip`/
`RunDrawer` used to render that is not the card's own live strip or this
chip moves to Runs — that is `task-38`'s job (the moved-rules table lives
in DESIGN.md §8.4.1 and CLAUDE.md's invariants; do not attempt to preserve
any of it here beyond what §§1–4 above already describe for the Board
itself).

## Test cases

Authority: spec §9. Existing Board suites — `board.test.tsx`,
`orchestrator-strip.test.tsx`, `starting-strip.test.tsx` if it exists,
`run-drawer*` suites — are rewritten with this task per spec §9's
"Component suites… rewritten with their task" line; do not leave a suite
green by accident against deleted markup.

1. **Band renders and composes `Chip`/`Band`** — title, count line, search,
   filter chips, the one ink Orchestrate chip; its hide/disable behaviour
   under `BM_AGENTS` off and under a starting/claimed project is unchanged
   from today's existing cases.
2. **`RunChip` precedence** — a payload with one crashed, one paused and one
   live run renders the crashed (`--red`) dot and a count line naming all
   three states; a payload with only a paused and a live run renders
   `--fill-live` (paused outranks live); a payload with only live runs
   renders `--fill-progress`.
3. **`RunChip` renders `starting` with no filter** — a `starting` entry with
   no matching `run.json` yet still produces `1 starting ›` (or combined
   with other states), mirroring `StartingStrip`'s existing "no client-side
   filter" test.
4. **`RunChip` absent** — an empty payload (no runs, no starting) renders no
   chip at all — not a chip with placeholder text.
5. **`RunChip` click opens Runs** — clicking it calls the same section
   setter the rail's Runs entry calls; assert against the setter, not the
   rendered Runs page.
6. **Column header** — the four columns render the new ramp hues and dot
   order (refactors amber, ideas mustard, bugs red, tasks green), the count
   pill, and no rule under the header.
7. **Card — live strip unchanged in substance.** Every existing
   `liveBarFor`/`.board-card-live*` case (`board.test.tsx`, including the
   attention/active/hand-session precedence and the 13 cases task-9 already
   pinned) still passes, asserting the new class names/tokens
   (`--fill-live` + `.hatch`) rather than the old cyan/amber split — update
   the *selectors* these cases check, not the *behaviour*.
8. **Dispatch chip always drawn.** With dispatch available and no markers on
   an item, the marker row still renders, carrying only the dispatch chip —
   regression guard for "the marker row renders whenever dispatch is
   available, markers or not."
9. **`RunStrip`/`StartingStrip`/`RunDrawer` are gone.** No import of any of
   the three remains anywhere in `client/src`; their test files are removed
   or repointed, not left red.
10. **`runClaimBlock`/`runHoldsItem` inputs unchanged.** A regression test
    (or the existing one, kept) asserts `BoardView` still calls both with
    the same shape of arguments as today — guards against a refactor that
    quietly narrows what the Board passes.
11. **No new derivation.** `client/src/lib/` is untouched by this task; if a
    diff touches any file there, it went further than this task allows.

## Done when

- `pnpm test` green on both runners, including every case above.
- `pnpm run typecheck` and `pnpm run build` pass.
- The Board renders as bands over four ramp-coloured columns of cards, with
  one `RunChip` replacing the old strip/starting-strip/drawer trio, in all
  five themes, at 1400 px and 400 px wide.
- Screenshot the Board at 1400 px and 400 px, daylight and midnight (spec
  §9), through a pid-owned static server killed by pid.
- `git diff --stat` against `main` touches
  `client/src/components/board/BoardView.tsx`,
  `client/src/components/board/ItemCard.tsx`,
  `client/src/components/board/DispatchButton.tsx`,
  new `client/src/components/board/RunChip.tsx` and `BoardColumn.tsx`,
  removed `RunStrip.tsx`/`StartingStrip.tsx`/`RunDrawer.tsx`,
  `client/src/styles.css`, and test files. No server route, no skill, no
  `shared/` change beyond what `task-36` already landed.
