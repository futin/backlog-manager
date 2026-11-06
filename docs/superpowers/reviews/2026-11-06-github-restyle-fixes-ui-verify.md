# UI verify — GitHub views and board grounds vs the picked mocks (after the fix plan)

Plan: `docs/superpowers/plans/2026-11-06-github-restyle-fixes.md`. Mocks: `docs/superpowers/specs/2026-11-05-jira-restyle-mockups/` — `Board.dc.html`,
`PRs.dc.html`, `PRsLayouts.dc.html`. Branch `fix/github-views-mocks` at `09a4df52`, served by its own Vite on 5199 (client-only, proxying the stack's API).

**Verdict: FAIL (round 1), PASS (round 2)** — five small defects (D1–D5 below), fixed in `78708ec5`; everything else a match or an accepted deviation. Round 2 is at the end.

## Inventory

| View | Mock | How opened | Data | States the mock draws |
| ---- | ---- | ---------- | ---- | --------------------- |
| GitHub Board | `Board.dc.html` columns | rail → Board | live registry | grounded columns, an empty / short column |
| Jira Board | `Board.dc.html` | rail → Jira | live Jira | three columns, one nearly empty |
| Archive | — (must NOT ground) | rail → Archive | live | month bands |
| PRs Inbox | `PRs.dc.html` | rail → PRs (narrow: Menu → PRs) | fixture `prs-ui8.json`, 8 PRs / 2 repos | failing, passing, pending, conflicts, behind, draft, auto-merge armed, clean+approved |
| Merge menu | `PRs.dc.html` open menu | split chevron on #490 (clean, approved, passing) | same | primary row on, tick, two plain rows |
| PRs Matrix | `PRsLayouts.dc.html` Matrix | layout switch | same | long titles, every cell tone |
| PRs Cards | `PRsLayouts.dc.html` Cards | layout switch | same | two repo cards, 6 + 2 rows |
| Runs, Settings | — (regression only: `.main` became a flex column in Task 1) | rail | live | — |

Viewports: 1440×1000, 600×1000, 390×844, light theme. Harness: scratchpad `harness.mjs` with `s16.json`; every non-GET is answered 503.

## Geometry

No `page scrolls sideways` at any width. Every remaining overflow line is a deliberate ellipsis or scroll box:
- `SPAN.prs-title` (Matrix, all widths) — the one-line title ellipsis Task 7 asked for.
- `DIV.prs-matrix-scroll 741>504` (600) and `615>294` (390) — the Matrix table scrolls inside its own box below its natural width, by design (DESIGN §8.11).
- `SPAN.board-card-proj-name`, `SPAN.board-card-assignee`, `SPAN.runs-row-project`, `run-drawer-item-verify-tail` — existing ellipsis spans, unchanged by this branch.

Board grounds (geo.js): GitHub `board-col` 1626 px tall at 1440 on `rgb(237,237,236)` (`--steel`), every column the same height; Jira `board-col-todo` 928 px, filling the
well; Archive columns no ground; at 600/390 columns stack, each its own height (no fill under 700 px, as planned).

## Region by region

### Board (`Board.dc.html`)
- Column ground `--steel`, radius 16, padding 12, white cards — **match** (GitHub and Jira).
- Equal-height columns, an empty column a full-height ground — **match**.
- Column dot before the name, count at the right — **match**.
- Archive: no ground — **match** (plan Task 1).

### PRs head (both mocks)
- Title, live dot + `8 open in 2 repos · polled 6h ago` — **match** (`PRsLayouts.dc.html:107`; `PRs.dc.html`'s older sub-line lost to the newer mock, plan Task 2).
- Layout switch at the band's right, full width under the title at 390/600 — **match**.
- No `N open` pill, toolbar only for notes — **match**.

### Inbox (`PRs.dc.html`)
- Triage `Segmented`, track skin, counts, red dot on `Needs you`, none on `Quiet` — **match**.
- Triage with no option selected — **deviation**, DESIGN §8.11: the triage is a filter whose resting state is "all", and the mock drew it with a filter applied.
- `Worth a look` dot — **defect D1**: it paints `--mustard` (`#5f530b` in daylight, olive) through `Dot`'s `paused` tone; the mock's `.dot.a` is amber. Same dot on
  Matrix's worth-a-look rows. DESIGN's amber mark is `--amber-solid`.
- Rows as their own cards (`--card`, hairline, radius 14, 10 px apart) — **match**.
- 40 px status tile, tinted by state — **match**.
- Title line `#n` + title — **match**.
- Pills lead with their glyph (checks ✓ ✕ clock, conflicts ✕), auto-merge a tinted pill — **match**.
- Mergeability pending pill — **defect D2**: the mock draws `mergeability pending` (neutral, clock glyph) on rows whose mergeability GitHub has not computed;
  live draws nothing for `mergeable: 'unknown'` (#480), so the row says nothing about mergeability while Matrix's cell says `computing`.
- Meta line: author, `head → base`, age, one line with the pills — **match**. Repo short name at its start — **accepted deviation** (plan).
- Author initials disc before the author — **defect D3**: the mock draws a small initials disc (`F`); live has the bare login. Jira cards already draw an initials
  disc (`styles.css:687`), so this is the board's vocabulary, not a new one.
- Branch glyph before `head → base` — **defect D4**: the mock draws the branch glyph; `branch` exists in `Glyphs`.
- Branch names in the body face — **accepted deviation** (guard 2).
- `2 of 9 checks failing` counts, the `Checks` eye button — **accepted deviation**, data-backed: the payload has the rollup state only (`checksDetail: null`).
- Split key `Blocked` dashed on a blocked row, ink `Merge` on #490 — **match** (the mock's own Button rules note says a blocked PR shows the dashed half).
- Open-on-GitHub icon button — **match**.
- Quiet section label with space above — **match**.

### Merge menu (`PRs.dc.html`, open menu)
- 28 px tiles, merge tinted green, the others neutral — **match**.
- Primary row on `--strip-hi` at rest with its tick (#490: `rgb(242,242,241)` vs white for the others) — **match**.
- Row label `Merge` (mock `Squash and merge`) — **accepted deviation** (§4.8/§6, method in the Confirm).
- No `Open on GitHub` row — **accepted deviation** (plan).
- Update-branch glyph — **defect D5**: the mock draws an up arrow; live draws `refresh`. `up` exists in `Glyphs`. The auto-merge row keeps `clock` (the mock's bolt
  has no glyph, and `clock` is what the split's own Auto-merge key draws) — deviation.

### Matrix (`PRsLayouts.dc.html`)
- Title one line with ellipsis, full title in `title` — **match**.
- Sub-line `repoShortName · head → base` — **accepted deviation** (plan keeps the branches).
- Dots: red needs-you, grey quiet — **match**; amber worth-a-look — **D1**.
- Cell tones, header counts, pills only for bad/meh — **match**.
- Auto-merge cell reads the method as text (`squash`) — **accepted deviation** (DESIGN §8.11).

### Cards (`PRsLayouts.dc.html`)
- Two-up at 1440, one column at 600/390 — **match**.
- Head: dark 28 px repo tile, short name, `N open` pill, `polled` at the trailing edge — **match**; name at `SheetHead`'s 19/500 (mock 15/600) — **deviation**,
  DESIGN §7 (one title size per sheet head; a primitive is restyled only through a prop).
- Rows: 28 px tile, keys at each row's right inside a two-up card (titles wrap instead) — **match** (controller ruling during Task 6).
- `N repos with no open PRs` note above the grid — **match** (mock rules: a repo with nothing open gets no card).

### Regression
- Runs, Settings at 1440 — unchanged by the `.main` flex column (screenshots `v-runs-1440.jpg`, `v-settings-1440.jpg`).

## Screenshots

Scratchpad `shots/`: `v-{inbox,matrix,cards,board}-{1440,600,390}.jpg`, `v-menu-1440.jpg`, `v-jira-1440.jpg`, `v-archive-1440.jpg`, `v-runs-1440.jpg`,
`v-settings-1440.jpg`, mocks `m-Board.jpg`, `m-PRs.jpg`, `m-PRsLayouts.jpg`.

## Round 2 (after `78708ec5`)

**Verdict: PASS.** Re-shot with the same harness and fixture (`s17.json`, `s18.json`): Inbox 1440/390, merge menu on #490 and on #481, Matrix 1440, Cards
1440/600. No `page scrolls sideways`; the only overflow lines are Matrix's intended `SPAN.prs-title` ellipsis.

- D1 — `Worth a look` dot paints `--amber-solid` (Inbox triage, Matrix #480) — **match**.
- D2 — #480 carries `mergeability pending` (neutral, clock glyph) in Inbox and Cards — **match**.
- D3 — a 16 px initials disc before every author (`F`, `M`, `R`) — **match**.
- D4 — the branch glyph before `head → base` in Inbox and Cards meta — **match**.
- D5 — #481's menu: `Update branch` draws the up arrow, primary row on `rgb(242,242,241)` with its tick, the two disabled rows white — **match**.

One Minor, not a mock region: where the meta line wraps (Cards two-up at 1440, Inbox at 390) a ` · ` separator can end a line or start the next one
(`futin ·` / `· execute/468 → main`). Carried into the final review's fix dispatch.

Screenshots: scratchpad `shots/r2-{inbox-1440,inbox-390,menu-1440,menu481-1440,matrix-1440,cards-1440,cards-600}.jpg`.

## Round 3 (after the final-review fix `497e914a`)

Re-shot Inbox 1440/390, Cards 1440 and the #490 menu (`s19.json`): no overflow lines, no page errors. A wrapped meta line now ends on its separator
(`futin ·`) and never starts with one — the separator rides inside the item before it. At 390 the 40 px tile sits beside `#n` + title instead of alone
on the first line. Menu primary ground unchanged. Screenshots: scratchpad `shots/r3-{inbox-1440,inbox-390,cards-1440,menu-1440}.jpg`.
