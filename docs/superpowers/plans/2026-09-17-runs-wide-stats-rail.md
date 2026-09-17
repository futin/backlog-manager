# Runs › History on a wide screen: the statistics stand as a right rail

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a board wide enough for it — in practice `contentWidth: full` on a ≥ 1920 px window — Runs › History lays out as three columns: the 420 px list and
the detail sheet on the left, exactly as today, and the figure strip standing as a **320 px right rail**, its five figures stacked over the range's machine-time
bars. Below that width nothing changes. In the detail sheet, whatever the width, the selected run's own statistics (`Machine time by stage`) move to the foot of
the body and **Attention goes last**, because it only matters when there is something in it and the chip row above already carries the count.

**Picked 2026-09-17** from three live prototypes over the real page at 1920 × 1080 (CSS injected, every figure real): **A**, the stats rail, over **B** (a 480 px
panel, figures in a 2-col grid, the run's machine time moved beside the range's for comparison) and **C** (B plus the run's facts and count chips moved right,
the detail left with head, attention and items). A was chosen with the two detail-body moves above added to it. The three screenshots are session artefacts, not
committed; this paragraph is the record, the way `03-runs-shape.html`'s unpicked options are theirs.

**Architecture:** Pure layout. No derivation, hook, payload or reading changes; nothing new is computed and nothing shown today disappears. The switch is a
**container query** on a measuring wrapper the History page alone renders — not a media query, because the board's width is what matters and a media query cannot
see the rail, the `.wrap` cap, the density gutters or `.shell`'s `zoom` (at 120 % text a 1920 px window has 1112 CSS px of board, which is not room for three
columns). The wrapper is the container rather than `.wrap` or `.main` because `container-type: inline-size` applies layout containment, and a layout-contained
element becomes the containing block for `position: fixed` descendants — the item modal and the form sheets are fixed and render inside `.wrap` with no portal, so
a container there would pin them to the section instead of the viewport. Nothing under Runs positions itself fixed, and the stylesheet comment says that whoever
adds one must portal it.

**Tech stack:** React 18 + TypeScript, Vite, plain CSS with theme tokens, jest + `@testing-library/react` (jsdom via docblock), Playwright MCP for the one visual
check.

**Spec:** none. `.claude/DESIGN.md` §8.4.1 is the design authority for this page and is edited in Task 3 to carry the new layout and body order.

## Global constraints

- **This plan states behaviour and exact test *cases*. It deliberately does NOT hand you literal code, and that overrides the writing-plans template's "code blocks
  required".** Handed code gets transcribed verbatim, so a defect in the plan becomes a defect on the branch with nobody positioned to catch it. Expected values,
  names and selectors below are exact and binding; how you satisfy them is yours, and if a case looks wrong, say so rather than implementing it.
- **Comments explain _why_, at length.** The existing density in `client/src/` is deliberate — match it. `RunsView.tsx` and `RunDetail.tsx` already cite §8.4.1 in
  their headers; the comments that move in Task 1 move with their blocks and are rewritten where they now state the opposite of the truth.
- **Wrap new prose and comments at 160 columns.** Never reflow existing text to widen it.
- **No literal colours in `client/src/styles.css`** — tokens only; no `px` font-size under 11; no selector outside the ui-primitives block may *start* with a
  family name (`test/design-guards.test.ts` guards 3 and 7). The new rules select `.runs-board > .ui-figure-strip` — a page placing a primitive, the same
  relationship `.runs-figure-bars` already has — and start with `.runs-board`.
- **`pnpm test` is the union of both runners** (`scripts/test-all.mjs`). `pnpm run typecheck` and `pnpm run build` must also print green before the merge.
- **Nothing derived may be re-decided here.** `splitLive`, `pickAuthority`, `aggregateRuns`, `runStageTotals` and the selection rule are untouched; the strip
  still hides with the list when the range or project filter empties it; the 1100 px stack and the 700 px full-width sheets are untouched.
- **Branch and merge.** Work in a linked worktree on `backlog/runs-wide-stats-rail`, one commit per task; merge into `main` from the main tree with `--no-ff`
  only after the user's go and only with `main` checked out there. No run is live at the time of writing; re-check `~/.backlog-manager/orchestrator/*/run.json`
  for `status: "running"` before the merge.
- Target ≤ 4 tasks, ~60 lines of CSS and ~40 lines of TSX moved rather than written — a **soft** budget. If a load-bearing comment makes it longer, it gets longer.

---

### Task 1: The detail body's new order

**Files:**
- Modify: `client/src/components/runs/RunDetail.tsx` (the JSX after the chip row)
- Test: `test/run-detail.test.tsx`

**Behaviour.** The body after the chip row renders, in this order: `Branches to merge` (when any) → `Items` → `Machine time by stage` → `Attention`. Today it is
`Attention` → `Machine time by stage` → `Branches to merge` → `Items`. Every block's contents, test ids, headings, the `queue wait excluded` caveat, the
`nothing needs a look` empty state and the `open`-when-failed disclosures are byte-identical; only the order moves. The chip row (merged, branched, skipped,
attention, fix loops, active/queued) stays where it is, under the facts — "the run's statistics" in the pick means the machine-time section, and the chips are
the count a reader needs before deciding whether to scroll to Attention.

**Comments.** The Attention block's leading comment today says it "moves AHEAD of the machine-time rollup … where it used to sit last". Rewrite it: it sits
**last again** since 2026-09-17, by the user's call — an empty list is the common case, the chip row already counts the entries, and a section that is usually
`nothing needs a look` was costing every reader a screen before the items. The machine-time block's comment moves with its block unchanged.

- [ ] **Step 1: Write the failing cases** in `test/run-detail.test.tsx`, in a new `describe('RunDetail · body order (2026-09-17)')` before the controls describe:
  - `renders items, then this run's machine time, then attention last` — render `primarySummary()` with `live={null}` and `CONTROL_PROPS`; read every
    `.run-detail-heading`'s text (the `Machine time by stage` heading also contains its `run-detail-sub` caveat, so compare with `startsWith` or strip it) and
    expect exactly `['Items', 'Machine time by stage', 'Attention']` in that order. Then, with `compareDocumentPosition`, expect
    `run-detail-items` precedes `run-detail-machine`, and `run-detail-machine` precedes `run-detail-attention-a-2`.
  - `puts branches to merge first when the run has any` — reuse the branched fixture the existing case `lists every branched item with its literal git merge
    --no-ff command` builds (extract it into a helper if it is inline) and expect the headings `['Branches to merge', 'Items', 'Machine time by stage',
    'Attention']`.
  - `keeps the empty attention state at the foot` — a summary with `attention: []`: `nothing needs a look` is present and its `.drawer-empty` element follows
    `run-detail-machine` in document order.
- [ ] **Step 2: Run** `pnpm run test:jest -- run-detail` and confirm the three new cases fail on order while every existing case passes.
- [ ] **Step 3: Move the two blocks** in `RunDetail.tsx` and rewrite the Attention comment as described. Nothing else in the file changes.
- [ ] **Step 4: Run** `pnpm run test:jest -- run-detail run-view runs-view` — all green. Check no existing case asserted the old order (none is expected to; if one
  does, it was pinning what this task changes on purpose — update it and say so in the commit).
- [ ] **Step 5: Commit** `feat(runs): detail body ends with this run's machine time, then attention`.

---

### Task 2: The wide layout — a measuring frame, a container query, a 320 px rail

**Files:**
- Modify: `client/src/components/runs/RunsView.tsx` (the History return only)
- Modify: `client/src/styles.css` (the Runs section, beside `.runs-split` and its 1100 px block)
- Test: `test/runs-list-scroll-style.test.ts` (new describe), `test/runs-view.test.tsx` (one case)

**Behaviour.**
- History renders `<div class="runs-frame">` around today's `<div class="board runs-board">`. The Watchdog branch is unchanged and renders no frame. The frame
  is a block with no padding, margin, background or border — a measuring element and nothing else.
- `.runs-frame { container-type: inline-size }`.
- Under `@container (min-width: 1400px)` and only there: `.runs-board` becomes a grid — `grid-template-columns: minmax(0, 1fr) 320px`,
  `grid-template-rows: auto minmax(0, 1fr)`, `gap: var(--group-gap)`; `.runs-board > .ui-band` spans both columns (`grid-column: 1 / -1`); `.runs-board >
  .ui-figure-strip` takes column 2, row 2, becomes one column (`grid-template-columns: minmax(0, 1fr)`), lets its `.ui-figure-wide` cell fall in line
  (`grid-column: auto`), aligns to the top (`align-self: start`) and scrolls itself when taller than the board (`max-height: 100%`, `overflow-y: auto`,
  `overscroll-behavior: contain`); `.runs-board > .runs-split` takes column 1, row 2; the rail's `.run-bars-row` columns narrow to `72px 1fr 56px` so the
  track keeps ~140 px at the cell's 280 px inner width. The existing `.runs-board` height, `.runs-split`'s `flex: 1; min-height: 0` and the 1100 px stacking block
  are untouched — under 1400 px of board width the sheet is byte-identical in effect.
- **Why 1400.** 420 (list) + ~600 (the detail's seven-node stage track stays legible) + 320 (rail) + two `--group-gap`s ≈ 1370. With the 1280 px cap the
  board never reaches it, so the rail appears only with `contentWidth: full`, and there only on a window of about 1728 px or more at 100 % text — which is
  the "fullscreen" the pick was drawn at.
- **Comment, in the stylesheet,** on the three things the code cannot say: why the frame is the container and not `.wrap`/`.main` (layout containment and the
  fixed overlays — and the standing rule that anything positioned `fixed` under Runs must portal to `body`), why a container query and not a media query
  (`zoom`, density gutters, the cap), and why the strip is placed by this section rather than given a primitive variant (a CSS state the component cannot know,
  same as `.runs-figure-bars`).

- [ ] **Step 1: Write the failing cases.** In `test/runs-list-scroll-style.test.ts`, a new `describe('runs wide layout — the stats rail (2026-09-17)')` reusing
  the file's `mediaBlocks` and `declares` helpers (lift them to the file's top scope if they are inside the first describe):
  - `the measuring frame is the container, and nothing above it is` — `.runs-frame` declares `container-type: inline-size`; none of `.wrap`, `.main`,
    `.shell` declares `container-type` anywhere in the sheet.
  - `the three-column grid lives only under the 1400 px container query` — exactly one `@container (min-width: 1400px)` block exists; inside it `.runs-board`
    declares `display: grid` and `grid-template-columns: minmax(0, 1fr) 320px`; outside it (the base) `.runs-board` declares no `display: grid`.
  - `the strip stands in column two, one figure wide, scrolling itself` — inside the block, `.runs-board > .ui-figure-strip` declares `grid-column: 2`,
    `grid-template-columns: minmax(0, 1fr)`, `max-height: 100%`, `overflow-y: auto`, `overscroll-behavior: contain`; `.runs-board > .ui-figure-strip
    .ui-figure-wide` declares `grid-column: auto`.
  - `the band spans and the split keeps the first column` — inside the block, `.runs-board > .ui-band` declares `grid-column: 1 / -1` and `.runs-board >
    .runs-split` declares `grid-column: 1`.
  In `test/runs-view.test.tsx`, beside the existing History render cases: `History renders inside the measuring frame` — `container.querySelector('.runs-frame
  > .board.runs-board')` is not null; and in the Watchdog mode case the file already has (or a new one using its mode helper), `container.querySelector('.runs-frame')`
  is null.
- [ ] **Step 2: Run** `pnpm run test:jest -- runs-list-scroll-style runs-view` and confirm the new cases fail and the old ones pass.
- [ ] **Step 3: Implement** the frame in `RunsView.tsx` and the stylesheet rules with their comment.
- [ ] **Step 4: Run** `pnpm run test:jest -- runs-list-scroll-style runs-view design-guards` — all green. Guard 7 must stay green with the new selectors.
- [ ] **Step 5: Commit** `feat(runs): figure strip stands as a 320 px right rail on a wide board`.

---

### Task 3: Docs follow the code

**Files:**
- Modify: `.claude/DESIGN.md` §8.4.1 (the shape paragraph, "The split", and the body list)
- Modify: `docs/subsystems/board.md` (Runs › History: the split paragraph and the detail-sheet bullet)
- Modify: `CLAUDE.md` (the Layout line describing Runs)

- [ ] **Step 1: DESIGN.md.** In the "shape" paragraph (the one naming option D), add one sentence recording the 2026-09-17 pick: on a wide board the strip stands as
  a 320 px right rail (A), drawn and picked against a 480 px 2-col panel with the run's machine time beside the range's (B) and that panel plus the run's facts
  and chips (C). After "**The split**", add a "**Wide**" paragraph: the 1400 px container threshold, what stands where, the container-on-the-frame rule and the
  fixed-overlay reason, and that nothing below the threshold changes. In the body list, move items 4 (attention) and 5 (machine time) to the end in the new order
  and renumber; state the reason the user gave. Keep §8.4.1's existing anchors; the `Rules that moved here` table is untouched.
- [ ] **Step 2: board.md.** Extend the "Under the strip, the **split**" paragraph with the wide layout in one sentence, and rewrite the detail-sheet bullet's order
  clause to `…the chip row, ``git merge --no-ff <branch>`` per branched item, the items in pipeline order — each with …— then machine time by stage for this run
  alone, and last the attention entries`.
- [ ] **Step 3: CLAUDE.md.** In the Layout line for Runs, after "one always-visible detail sheet", add `; on a board 1400 px or wider the strip stands as a 320 px
  right rail`.
- [ ] **Step 4: Commit** `docs(runs): the wide stats rail and the detail body's order`.

---

### Task 4: Verification

- [ ] `pnpm test`, `pnpm run typecheck`, `pnpm run build` — all green, output pasted in the report.
- [ ] Serve the branch (`WEB_PORT=5178 pnpm run dev:web` from the worktree, pid recorded, killed by that pid) against the running API on 4322 and screenshot Runs ›
  History with Playwright, **no CSS injected**, at: 1920 × 1080 with `contentWidth: full` (expect three columns, rail on the right, detail body ending with
  machine time then Attention); the same window with `contentWidth: fixed` (expect today's layout — the cap keeps the board at 1280); 1440 × 900 with `full`
  (expect today's layout); and 1920 × 1080 with `full` and `fontScale: 1.2` (expect today's layout — the container query sees 1112 CSS px, which a media query
  would not). Send the 1920/full screenshot.
- [ ] Ask the user for the merge; then, with `main` checked out in the main tree and no run live, `git merge --no-ff backlog/runs-wide-stats-rail` and remove the
  worktree.
