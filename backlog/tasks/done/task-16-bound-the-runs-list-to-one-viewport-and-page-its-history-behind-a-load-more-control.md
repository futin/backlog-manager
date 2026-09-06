---
id: task-16
title: Bound the runs list to one viewport and page its history behind a load-more control
created: 2026-09-05
from: idea-6
updated: 2026-09-05T22:55:27Z
started: 2026-09-05T22:36:22Z
execute-elapsed: 1145
execute-tokens: 148374
---

## Goal

The Runs section stops growing the page. Two independent problems from idea-6, both
closed by this task:

1. **The controls scroll away.** `.runs-list` is a plain flex column, so every day group
   in range lays out at full height and the only way to reach an older run is to scroll
   the whole document — by the time you are looking at a run from three weeks ago the
   stat tiles, the range control and the project select are all off the top, and you can
   no longer see which range or project you are reading.
2. **The detail pane goes off-screen.** `.runs-split` is `align-items: start`, so the
   pane — the reason that layout exists at all — stays pinned at the top of a list that
   may be several screens tall. Select a run near the bottom and the thing describing it
   is not on screen.

After this task the Runs section occupies exactly one viewport on the wide layout: the
bar, the tiles and the split stay put, the run list scrolls inside its own bounded box,
and the detail pane is always fully visible beside it. History is additionally paged —
the list renders a window of the newest runs with a `load more` control at its foot —
so the initial render is a window rather than the whole corpus.

Both halves are user-visible client work. **No server change**; see the ruling in
`## Plan` §0.

## Plan

### §0 — Rulings that close idea-6's five open questions

These were settled during grooming. They are decisions, not suggestions: an
implementer who wants to overturn one should say so and re-groom rather than quietly
build the other thing.

**0.1 Client-side window, not a server-side page.** Measured rather than assumed, which
is what idea-6 asked for. Over the 19 real runs in this machine's run-state directory
(3 projects, `run.json` plus `runs/*.json`), an archive entry with its verification
tails stripped the way `toArchiveEntry` strips them averages **2,698 bytes**, max 5,273.
A year of daily orchestrator runs is therefore ≈**960 KB** of JSON and a thousand runs
≈2.6 MB — over loopback, fetched on mount and window focus only, that is not a cost
worth reshaping a read-only endpoint for. `GET /api/orchestrator/archive`,
`useOrchestratorArchive` and the run-state single-writer/single-reader invariant are all
**untouched**. The window is a render decision over a corpus the client already holds
whole, exactly as `staleDays` is a view decision over a corpus the server already
returns whole.

**0.2 The unit of "more" is a run, not a day group.** Three reasons. The pinned live
region is not a day group at all (§0.4), so group-based counting starts with an
exception baked in. Day groups are lumpy — a heavy orchestrator day holds eight runs and
a quiet one holds one — so the same click would reveal anywhere from 1 to 8 rows.
And the range control already owns the calendar axis; paging by calendar duplicates it.

The "paging by run splits a day across the boundary" objection dissolves on
**order of operations**: window first, group second. `groupByDay` runs on the *windowed*
slice of `history`, so a partially-revealed day renders its own heading over exactly the
rows revealed, and the next `load more` extends that same group rather than emitting a
second heading for it. This is why the slice must land between `splitPinned` and
`groupByDay` and nowhere else.

**0.3 Range and project changes reset the window to its first page.** Both narrow the
corpus. Carrying a raised window across a change would mean All → Today → All leaves the
list taller than a first visit to All did — the same view with two different heights
depending on the path taken to it. Reset via an effect keyed on `[range, projectFilter]`,
**not** by remounting the list with a changing `key`: a remount would also destroy the
selection, which §0.5 requires survive.

**0.4 Pinned live runs are never windowed.** The slice applies to `history` only;
`pinned` always renders whole. `splitPinned` exists precisely because a run still going
since three days ago must render first regardless of its `startedAt` — paging that run
away is the exact failure that split was written to prevent. This does not leave a hole
in the bound: the "one run per project" invariant caps the pinned region at one row per
registered project, so it cannot grow the way history can.

**0.5 Selection is resolved against the full filtered list, never the window.**
`load more` only ever adds, so it can never drop the selected row — nothing to do there.
A window *reset* (§0.3) can, and that is the case to get right. Keep `orderedRows`
(`[...pinned, ...history]`, unwindowed) as the lookup and default-fallback list exactly
as it is today, and window only what feeds `groupByDay`. Consequences, all intended:

- `load more` → selection untouched.
- window reset with the selected run still in range → selection survives and the pane
  keeps describing it, even while its row sits below the current window. The pane
  describes a *run*; the list is a *window*. The load-more label states the remaining
  count, so a reader can see there is more list below.
- the selected run leaves the filter entirely → today's existing fallback to
  `orderedRows[0]` fires unchanged.

Do **not** add an "auto-grow the window until the selected row is included" rule: pick a
run 400 rows deep, switch range and back, and the window silently re-inflates to 400,
defeating the paging.

### §1 — Layout: bound the section to one viewport (`client/src/styles.css`)

Reject the obvious `max-height: calc(100vh - <chrome>px)` on `.runs-list`. It needs a
magic constant for the tiles row's height, and that constant is *wrong in the 700–900px
band*, where `.runs-tile-wide` peels onto its own full-width row and the tiles block gets
markedly taller. Derive the bound from layout instead:

- `.board` in the Runs section gains a modifier class (`RunsView` renders
  `className="board runs-board"`; `BoardView`/`ArchiveView` are untouched). `.board` is
  already `display: flex; flex-direction: column`, so the chain works with no structural
  change.
- `.runs-board` gets a definite height of one viewport minus the two `--body-pad`
  gutters. **Divide `100vh` by `var(--font-scale, 1)`** — this is not optional and not a
  flourish: `.shell` carries `zoom: var(--font-scale, 1)`, which leaves `100vh` resolving
  against the *unzoomed* viewport, so at 120% a plain `100vh` box is drawn 20% taller
  than the screen. `.rail` already solves this exact problem the same way
  (`client/src/styles.css:87`); copy that idiom rather than inventing a second one, and
  say in a comment that it is the same one.
- `.runs-split` becomes the flex child that absorbs the remainder: `flex: 1` plus
  `min-height: 0` (without `min-height: 0` a flex item refuses to shrink below its
  content and the whole mechanism silently does nothing). Because the remainder is
  computed by layout, this adapts to whatever height the tiles row happens to have at
  every breakpoint — which is the entire reason for taking this route over a constant.
- `.runs-list` and `.runs-detail` each cap at `max-height: 100%` and scroll their own
  overflow (`overflow-y: auto`). `.runs-split` keeps `align-items: start`, so a short
  list still sizes to its content instead of stretching to a tall pane — the cap only
  bites once content exceeds it.
- Both get `overscroll-behavior: contain`, so reaching the end of the inner box does not
  chain the scroll to the document. A nested scroll box without this is worse than the
  status quo.
- Both get a `min-height` floor (~240px). This is the graceful degrade for a viewport so
  short (or a `--font-scale` so large) that the bar and tiles alone exceed it: the boxes
  keep a usable height and the *page* scrolls again, rather than the list collapsing to
  zero.
- `.runs-day-heading` becomes `position: sticky; top: 0` with an **opaque**
  `background: var(--board)`. Once the list scrolls independently, a day heading
  scrolling out of its own box is exactly the problem `.archive-month`
  (`client/src/styles.css:711`) already solves; reuse that idiom and its reasoning —
  including *why* the background must be opaque (rows scroll under it, and anything less
  shows a row's text through the heading meant to be labelling it). Sticky works here
  because a sticky element positions against its nearest scrolling ancestor
  (`.runs-list`) while un-sticking at the end of its own containing block (`.runs-day`),
  which is precisely the wanted behaviour.
- The existing `@media (max-width: 700px)` block for `.runs-split` **also un-bounds all
  of this**: `.runs-board` back to `height: auto`, `.runs-list`/`.runs-detail` back to
  `max-height: none; overflow: visible`. idea-6's own reasoning stands — a scroll box
  nested inside a scrolling page is worse than the status quo on a phone, and the layout
  is already one column there.

### §2 — Paging (`client/src/components/runs/RunsView.tsx`)

- Export a named `RUNS_PAGE_SIZE` module constant, value **25**. Exported so the test
  suite asserts the *relation* ("renders exactly `RUNS_PAGE_SIZE` rows") rather than
  pinning a magic 25 in two places that can drift apart. 25 is roughly a week and a half
  of history at the ~2–3 runs/day this machine's busiest project actually produces —
  enough that a first visit to `All` reads as complete, short enough that the bounded box
  scrolls a few times over rather than dozens.
- `const [windowSize, setWindowSize] = useState(RUNS_PAGE_SIZE)`, component state like
  `range` and `projectFilter` beside it, and **not persisted**, for the reason those two
  already state in their own comments: a saved window would silently reopen the section
  at whatever height someone last left it.
- Slice between `splitPinned` and `groupByDay` (§0.2): `groupByDay` consumes
  `history.slice(0, windowSize)`. `orderedRows`, `selectedRow`, `filtered`, the
  aggregate tiles and the wide machine-time tile all keep reading the **unwindowed**
  lists — a window is a rendering decision and must not move a single number in the
  tiles. This is the same class of mistake as fix rounds 2/3 already documented in that
  file (a call site quietly reading a different source than its neighbours), so it is
  worth a comment saying which lists are windowed and which are deliberately not.
- Reset effect on `[range, projectFilter]` → `setWindowSize(RUNS_PAGE_SIZE)` (§0.3).
- Render the load-more control at the foot of `.runs-list`, **inside** the scroll
  container (it is the end of the list, not a fixture beside it), only when
  `history.length > windowSize`. Its label states the remaining count — e.g.
  `load more (12 older)` — so the button says what it will do rather than "more".
  `data-testid="runs-load-more"`. Clicking raises `windowSize` by `RUNS_PAGE_SIZE`.
- **Focus on the exhausting click.** The click that reveals the last rows unmounts the
  button under the pointer, dropping focus to `<body>`. Give the `.runs-list` container
  `tabIndex={-1}` and move focus to it in the handler when the click exhausts the list.
  `tabIndex={-1}` earns its place independently: a scrollable region needs a
  programmatic focus target, and its interactive row buttons are what keep the region
  keyboard-operable via Tab.
- The range-empty branch (`runs-empty-range`) renders no load-more control — it is
  already inside the `filtered.length === 0` arm, so this falls out for free; assert it
  anyway (§ test cases) so a later refactor cannot move the button above that branch.

### §3 — Docs

Update the `client/src/` bullet in `CLAUDE.md` describing RunsView so it names the
bounded scroll container and the paged history alongside the range control and project
filter it already names. Nothing in `## Invariants` changes — no rule here is new
doctrine, and §0.1 explicitly leaves the run-state single-writer/single-reader rule
untouched.

## Test cases

Jest render cases go in `test/runs-view.test.tsx`, reusing its existing `item()`,
`liveQueueItem()` and `run()` fixture factories — do not duplicate them into a new file.
Split to a new file only if the suite becomes unwieldy, and export the fixtures rather
than copying them if you do.

**Paging (jsdom, `test/runs-view.test.tsx`)**

1. 30 archived runs, no live run → exactly `RUNS_PAGE_SIZE` `.runs-row` elements render,
   and `runs-load-more` is present with a label containing the remaining count `5`.
2. Clicking `runs-load-more` in case 1 → all 30 rows render and `runs-load-more` is gone.
3. 3 archived runs → no `runs-load-more` at all.
4. **Window boundary falls mid-day.** Build history so the `RUNS_PAGE_SIZE`th run is not
   the last run of its calendar day (e.g. 24 runs across earlier days, then 4 runs on one
   older day). Assert: the boundary day's group renders only the revealed rows; there is
   exactly one `runs-day-<key>` element for that key; after `load more`, that same group
   has grown and there is still exactly one element for that key.
5. **Pinned is outside the window.** One fresh live run plus 30 archived runs → the
   `runs-day-live` region renders its row, and the history region still renders exactly
   `RUNS_PAGE_SIZE` rows (the live run consumes no slot).
6. **Reset on range change.** 30 runs all inside the current month; `load more` to full,
   click `runs-range-today`, click `runs-range-all` → exactly `RUNS_PAGE_SIZE` rows again.
7. **Reset on project change.** Same shape, driving the project `<select>` to a project
   and back to `all`.
8. **`load more` preserves selection.** Select a row, click `load more`, assert the same
   row still carries `aria-current="true"` and the detail slot still names that run.
9. **A window reset preserves a selection still in range.** 60 runs, one project, all
   inside the current month. `load more` once, select the run at index 30, then toggle
   range All → This month → All. Assert the detail pane still names that `runId` while
   exactly `RUNS_PAGE_SIZE` rows render (i.e. selection survived a reset that pushed its
   row out of the window).
10. **The existing fallback is intact.** Select a run, then filter to a *different*
    project → the pane re-defaults to that project's newest visible run, exactly as
    before this task.
11. **No control in the range-empty state.** A range/project combination that empties
    `filtered` renders `runs-empty-range` and no `runs-load-more`.
12. **Focus after the exhausting click** lands on the `runs-list` container
    (`document.activeElement`).

**Stylesheet (`test/runs-list-scroll-style.test.ts`, new)**

jsdom evaluates no media queries and performs no layout, so no render test can stand in
for these — the same gap `test/run-track-style.test.ts` documents. Read the sheet's own
text via `readStyles`/`ruleBlocks` (`test/helpers/css-rule.ts`) and assert:

13. `.runs-board` declares a height built from `100vh` **divided by**
    `var(--font-scale, 1)` — the division is the assertion, since a plain `100vh` is the
    bug this guards.
14. `.runs-split` declares both `flex: 1` and `min-height: 0` (the second is the one a
    cleanup silently deletes, taking the whole mechanism with it).
15. `.runs-list` and `.runs-detail` each declare `max-height: 100%`, `overflow-y: auto`,
    `overscroll-behavior: contain` and a `min-height`.
16. `.runs-day-heading` declares `position: sticky`, `top: 0`, and an opaque
    `background: var(--board)`.
17. The `@media (max-width: 700px)` block un-bounds the section: `.runs-board` height
    `auto`, and `.runs-list`/`.runs-detail` `max-height: none` with visible overflow.
    Use brace-depth counting to extract the at-rule body (`run-track-style.test.ts`
    has the helper pattern) — `ruleBlocks` alone stops at the first nested `}`.

**Browser**

18. In the browser (playwright MCP tools): with the stack up (`pnpm run docker:up`, or
    `pnpm run dev` + `pnpm run dev:web`), open `http://localhost:5177`, click **Runs**
    in the left rail, leave the range on **All** and the project on **All projects**,
    and scroll inside the run list. The stat tiles, the range control and the project
    select must stay fixed on screen, the detail pane must stay fully visible beside the
    list, the day heading of the group being scrolled through must stick to the top of
    the list box, and the document itself must not scroll. Then select the last run in
    the list and confirm the detail pane for it is fully on screen.
19. In the browser (playwright MCP tools): this machine's real history is only ~19 runs,
    fewer than `RUNS_PAGE_SIZE`, so seed a fixture to see the control at all. Generate
    40 plausible run files into a temp directory laid out as the run-state directory
    (`<tmp>/<uriEncodedProjectPath>/runs/run-YYYYMMDD-HHMMSS.json`, copies of an existing
    archived run with `runId`/`startedAt`/`updatedAt` varied across several days), start
    the API with `BM_ORCH_HOME=<tmp>` (`server/src/orchestrator/orchestrator.service.ts`
    reads that env var), open `http://localhost:5177`, click **Runs**, and confirm: 25
    rows render, a `load more (15 older)` control sits at the foot of the list inside the
    scroll box, clicking it reveals the remaining 15 and removes the control, and the
    tiles' numbers are identical before and after the click (the window must move no
    aggregate).

**Regression**

20. `pnpm test` and `pnpm run typecheck` both clean. In particular the pre-existing
    `RunsView` cases in `test/runs-view.test.tsx` must pass unmodified except where a
    fixture genuinely now exceeds `RUNS_PAGE_SIZE` — if one does, raise its expectation
    deliberately rather than reaching for the page size to make a test go green.

## Done when

- The Runs section fits one viewport on the wide layout: bar, tiles, range control and
  project select all stay put while the run list scrolls in its own bounded box, and the
  detail pane is fully visible for any selected run.
- History renders a `RUNS_PAGE_SIZE` window with a counted `load more` control at the
  foot of the list; the pinned live region is never paged.
- Range and project changes reset the window; `load more` never disturbs the selection;
  a reset never blanks a pane whose run is still in range.
- Below 700px the section is exactly as it is today — no nested scroll box.
- No server file changed, and `GET /api/orchestrator/archive` /
  `useOrchestratorArchive` are byte-identical.
- Cases 1–20 pass, `pnpm test` and `pnpm run typecheck` are clean, and `CLAUDE.md`'s
  RunsView bullet describes the new behaviour.

## Outcome

2026-09-05 — Done. The Runs section is bounded to one viewport on the wide layout
and its history is paged behind a counted `load more`, exactly as `## Plan` §0's
rulings describe. No server file changed; `GET /api/orchestrator/archive` and
`useOrchestratorArchive` are byte-identical.

**What landed**

- `client/src/styles.css` — `.runs-board` (a definite
  `calc(100vh / var(--font-scale, 1) - var(--body-pad) * 2)`, the `.rail` idiom
  and not a second one), `.runs-split` as the `flex: 1; min-height: 0` child that
  absorbs the remainder, `max-height: 100%` + `overflow-y: auto` +
  `overscroll-behavior: contain` + a 240px floor on `.runs-list`/`.runs-detail`,
  a sticky opaque `.runs-day-heading`, a quiet `.runs-load-more`, and a 700px
  block that un-bounds all of it. `.runs-detail`'s own `min-height: 160px` moved
  into the shared rule rather than being left behind it — a later, more specific
  declaration would have silently beaten the 240px floor — and the phone block
  restates the 160px.
- `client/src/components/runs/RunsView.tsx` — exported `RUNS_PAGE_SIZE = 25`, a
  non-persisted `windowSize`, a reset effect on `[range, projectFilter]`, the
  slice between `splitPinned` and `groupByDay` and nowhere else, the counted
  control at the foot of the list inside the scroll box, and the
  focus-handoff on the exhausting click (`listRef` + `tabIndex={-1}`).
- `test/runs-view.test.tsx` — 13 paging cases appended, reusing the file's own
  `item()`/`liveQueueItem()`/`run()` factories. The 25 pre-existing cases are
  unmodified and still pass; none needed its expectation raised.
- `test/runs-list-scroll-style.test.ts` — new, 5 stylesheet cases. It strips CSS
  comments before reading the text, which is load-bearing rather than tidy: this
  sheet's comments quote the very declarations under test ("`min-height: 0` is
  not decoration…", "back to `height: auto`") and name neighbouring selectors in
  prose, and `ruleBlocks`' boundary check can tell a selector from a longer class
  name but not from English. Left in, a test could pass on the strength of a
  sentence describing a rule that had been deleted.
- `CLAUDE.md` — the RunsView bullet now names the bound and the window.

**Deviations from the plan: none.** One thing it did not anticipate: this
worktree had no `node_modules`, so `pnpm test` failed with `jest: command not
found` while a bare `npx jest` quietly resolved the parent checkout's binaries.
`pnpm install --frozen-lockfile` in the worktree fixed it, and every number below
is from the pinned toolchain rather than a neighbouring tree's.

**Test-case coverage.** Cases 1–12 are the paging block, 13–17 the stylesheet
file, 18–19 the browser checks, 20 the regression run. Two extra cases were added
beyond the plan's list, both guarding rulings the plan states in prose but left
unasserted: "moves no aggregate number when the window grows" (§0.5's "a window
is a rendering decision") and the fallback case 10 phrased as a guard that
windowing has not become a second way for `selectedRow` to resolve.

**Both halves were mutation-checked, because a green suite proves nothing about
a test that cannot fail.**

```
# remove the slice entirely
-  const windowed = history.slice(0, windowSize);
+  const windowed = history.slice(0);
→ 17 failed

# resolve the selection against the window instead of the full ordered list
-  ? orderedRows.find(...)
+  ? [...pinned, ...windowed].find(...)
→ 1 failed — "keeps a selection whose row a window reset pushed out of view"
   (exactly the case written for it; nothing else moved)

# plain 100vh, and .runs-split without min-height: 0
→ 2 failed — the two runs-list-scroll-style cases written for them
```

**Cases 18–19, in the browser** (playwright MCP, Chromium at 1440x900). The
user's own docker stack held 4322/5177, so this ran on `PORT=4399` /
`WEB_PORT=5199` against `BM_ORCH_HOME=/tmp/task16-orch` seeded with 40 run files
copied from a real archived run with `runId`/`startedAt`/`updatedAt` varied 5h
apart across ~8 days. Everything was torn down afterwards and the user's stack
was never touched.

Case 19 — on load, and after clicking the control:

```
{ rows: 25, loadMoreLabel: "load more (15 older)", loadMoreInsideList: true,
  boardHeight: 852, viewportHeight: 900, listScrollable: true,
  listBox: { top: 267, h: 609, scrollH: 1468 },
  detailBox: { top: 267, bottom: 789 }, documentScrollable: false }

{ rows: 40, loadMoreGone: true, focusIsList: "runs-list",
  documentScrollable: false, detailFullyVisibleForLastRun: true }
```

and the tiles' text was byte-identical before and after that click — 40 runs,
40/40 completed, 31m avg item work, the whole machine-time row — which is the
number-level form of "the window must move no aggregate".

Case 18 — scrolling the list to 700px:

```
{ scrolledTo: 700, chromeMoved: { tiles: 0, range: 0, select: 0 },
  documentScrolledBy: 0, stuckHeadings: ["thu 3 sep"],
  detailFullyVisible: true }
```

Then selecting the last of the 40 rows: `selectedIsLastRow: true`,
`detailBox: { top: 267, bottom: 789, viewport: 900 }` — fully on screen.

Two bands beyond the plan's asks, since they are the ones §1's reasoning turns
on. At 820px, inside the 700–900 band where `.runs-tile-wide` peels onto its own
row and the tiles block grows to 356px tall — the exact width a
`calc(100vh - <chrome>px)` constant would have been wrong at — the section still
fits one viewport (`boardBottom: 876` of 900, list scrollable, document not,
detail fully visible). At 600px it un-bounds completely:
`max-height: none`, `overflow-y: visible`, `boardHeight: 3359px`, no nested
scroll box, page scrolls.

**Regression (case 20)** — `pnpm run typecheck` silent, and:

```
Test Suites: 70 passed, 70 total
Tests:       1197 passed, 1197 total
Snapshots:   0 total
Time:        54.007 s
```
