# GitHub views — close the gaps to the picked mocks (plan)

Source: `docs/superpowers/reviews/2026-11-06-github-restyle-ui-reverify.md` (FAIL, defect ids below are its ids). Mocks:
`docs/superpowers/specs/2026-11-05-jira-restyle-mockups/` — `Board.dc.html`, `PRs.dc.html`, `PRsLayouts.dc.html`.

**This plan specifies behaviour and test cases, never literal code** — it overrides `writing-plans`' "code blocks required". Size budgets are soft.

Ground rules for every task:
- Read `.claude/rules/board.md` before touching `client/src/**`. Design guards still win over a mock (`test/design-guards.test.ts`: 11 px floor, one uppercase
  rule, tint form, no `ui-*` token in a page selector, no `style=`). Restyle a primitive only through a prop, never from a page selector (guard 7).
- Where this plan reverses a DESIGN.md sentence, edit `.claude/DESIGN.md` §8.11 / board section in the same task and say the user's override (2026-11-06).
- Run the suites the task touches plus `test/design-guards.test.ts` and `test/daylight-contrast.test.ts`; `grep -l <symbol> test/` for any new caller.

## Task 1 — Board column grounds, both boards (B1, B2) — mock `Board.dc.html`, the columns

Behaviour:
- GitHub Board columns get the same ground Jira's have: `--steel`, radius 16, padding 12, cards white on it. Each column's existing colour dot stays.
  Give `BoardColumn` an opt-in ground (a `ground` prop, or `tone` implying it) that `BoardView` and `JiraShelves` pass and `ArchiveView` does NOT: Archive's
  sticky `.archive-month` paints `--board` (`styles.css:1197-1200`) and would read as a white band across a steel column. The `data-tone` hook keeps
  only the dot colour.
- Every column in a board is the same height: the grid stretches its items, and the board fills the well down to its foot when there are few cards, so an empty
  column is a full-height ground with its head, never a 40 px strip. With many cards the page still scrolls as today.
- DESIGN.md: drop "Jira only" from the column-ground sentence (spec §4.3 reversed by the user).

Tests:
- `test/board-column.test.tsx`: a GitHub Board column renders the ground, an Archive column does not; a toned (Jira) column still carries its `data-tone` and its
  `.board-col-dot`. The toneless column keeps its ramp `Dot` (`BoardColumn.tsx:24`) — only the ground is shared. Update the `tone` prop's comment
  (`BoardColumn.tsx:74`, "only `JiraShelves` passes it … gives the column a `--steel` ground") so it no longer claims the ground.
- Guard-style test pinning `.board-columns` does not use `align-items: start` (read the stylesheet as other guards do), so the cut ground cannot return.

## Task 2 — Shared PR head for all three layouts (I5) — mocks `PRs.dc.html` and `PRsLayouts.dc.html`, the head

Behaviour:
- Band sub-line reads `N open in M repos · polled <age>` led by the live dot; `M` counts shown repos with ≥1 open PR. One repo: `in 1 repo`.
- The layout `Segmented` moves into the band's trailing slot (right of the title); the separate `N open` pill and the toolbar's right-side `polled` go.
- The toolbar row keeps only the notes (`N repos hidden — no access`, Cards' `N repos with no open PRs`) and disappears when it has none.
- Narrow (<700 px): the switch wraps under the title, full width — check it is still reachable without sideways scroll.

Tests (`prs-view.test.tsx`): `3 open in 2 repos` for the suite's existing fixture (`:128-129`, totals 2 + 1), rewriting the `3 open` pill assertion at
`:835` and the toolbar-polled assertions at `:821-823`; `1 open in 1 repo` for a one-repo fixture; the switch is inside the band; no `N open` pill;
toolbar absent when there is no note; hidden-repo note still rendered.

## Task 3 — PR row anatomy (I2, I3, I4, I8) — mock `PRs.dc.html`, a row; `PRsLayouts.dc.html`, a Cards row

`PrRow` is shared by Inbox and Cards, so both change together.

Behaviour:
- Status tile 40 px in Inbox, 28 px in Cards (`PRsLayouts.dc.html:59,124-130`) — through `GlyphTile`'s `size` prop, whose union is `18 | 28 | 32` today
  (`client/src/components/ui/GlyphTile.tsx:9`): add `40` there, with its CSS size rule, and cover it in `test/ui-glyph-tile.test.tsx`.
- Checks and mergeability pills lead with their glyph (failing ✕, passing ✓, pending clock, conflicts ✕). `Pill` has no icon slot
  (`client/src/components/ui/Pill.tsx:25`): add an optional `glyph` prop (a `GlyphName`, drawn `aria-hidden` before the text) and cover it in
  `test/ui-pill.test.tsx` — present when passed, absent otherwise.
- Pills and meta share ONE wrapping line: pills, then `author · head → base · age`; the run-warning pill stays at the meta's end. Branch names stay in the
  body face — the mock's mono loses to design guard 2 (`test/design-guards.test.ts:152-162`, one font-family, on body) — deviation, guard-backed.
- Inbox's repo name moves from beside the title to the start of the meta line, short form. **Deviation:** neither mock draws a repo in an Inbox row
  (`PRs.dc.html:114,126`), but the Inbox mixes repos and the row is the only place that names one. The short-name rule has one home, a `repoShortName`
  helper in `client/src/lib/pr-layouts.ts`: the last `/` segment, or the full `owner/name` when two shown repos share that segment. Tasks 6 and 7 consume it.
- `auto-merge · <method>` is a tinted pill (the `done` tone, as the mock's `auto-merge on`), not the solid `live` fill: the tone is set in `prChips`
  (`client/src/lib/prs.ts:84`), and `test/prs-lib.test.ts:91` flips from `live` to `done`. `.ui-pill-live` itself is untouched.

Tests (`prs-inbox.test.tsx`, `prs-view.test.tsx` for Cards, `prs-lib.test.ts` for `prChips` and `repoShortName`): tile `data-size` 40 / 28 per layout; pill glyph present for `failure`, `success`, `pending`,
`conflicting`; meta and pills inside one container; repo short name `backlog-manager`, full name when two repos named `ui-kit` under different owners;
auto-merge pill tone `done`.

## Task 4 — Inbox rows as cards, triage dots, Quiet section (I1, I6, I7) — mock `PRs.dc.html`

Behaviour:
- Each Inbox row is its own card: `--card` ground, hairline border, radius 14, padding ~14×16, 10 px between rows (`PRs.dc.html:109`), no divider rule. Cards layout rows stay
  boxless inside their repo card — so the card skin belongs to the Inbox list, not to `PrRow`.
- `Needs you` and `Worth a look` carry their level dot before the label (red, amber); `Quiet` carries none, as the mock (`PRs.dc.html:108`) — the same
  `Dot` + `LEVEL_DOT` mapping Matrix draws, imported from `client/src/lib/pr-layouts.ts:380` (its `quiet` entry is already `undefined`). `Segmented` options take a
  label only today: if it needs a leading-node slot, add it as a prop (guard 7) and cover it in its suite.
- `Quiet` becomes a section label with space above (≥16 px) matching the triage's type, not a bare word between cards.
- DESIGN §8.11 "Row anatomy": Inbox rows are boxed; Cards rows stay boxless. Remove the recorded "no level dot" deviation.

Tests: Inbox list items carry the boxed class; Cards rows do not; the `Needs you` and `Worth a look` options each hold a dot with their own level's tone, `Quiet` none; `Quiet` heading still
an `h3` and still absent when no quiet PRs.

## Task 5 — Merge menu rows (I9) — mock `PRs.dc.html`, the open menu

Behaviour: each menu row's icon sits in a 28 px tinted `GlyphTile` (merge green, auto-merge neutral, update neutral) — rows already draw a `GlyphTile`
(`PrActions.tsx:163`), so this is its size and tones; the primary row carries the `--strip-hi` ground at rest, not only on hover (mock `.mi.on`,
`PRs.dc.html:75`), beside its existing tick. Text unchanged (`Merge`, method stays in the Confirm — §4.8/§6 still hold). No `Open on GitHub` row: the icon button
beside the split already does it (deviation, keep).

Tests (`prs-actions.test.tsx`; tick-on-primary is already pinned at `:195-207`): each row's tile has `data-size="28"`; tones merge `done`/green,
auto-merge and update `neutral`; the primary row carries its at-rest ground class and no other row does; disabled rows still `aria-disabled`.

## Task 6 — Cards grid and head (C1, C2) — mock `PRsLayouts.dc.html`, Cards

Behaviour:
- Repo cards flow two-up when the pane is ≥ ~1100 px wide (container query or grid `auto-fill, minmax(520px, 1fr)`), one column below. Cards align to top.
  `PrCards` returns a fragment into `.prs` today (`PrCards.tsx:93-99`): wrap the repo sheets alone in a new `.prs-cards-grid` element; the `Can't read`
  notes stay outside it, under the grid.
- Card head: dark repo glyph tile, short repo name, `N open` pill right after the name, `polled <age>` at the head's trailing edge.
- DESIGN §8.11 "Grouping (Cards)": two-up replaces one column.

Tests (`prs-view.test.tsx`): card head order (tile, name, pill, age); the head tile is 28 px; name via `repoShortName`; every repo sheet is a child of
`.prs-cards-grid` and a `Can't read` note is not.

## Task 7 — Matrix title (M1) — mock `PRsLayouts.dc.html`, Matrix

Behaviour: title stays on one line with ellipsis (full title in `title` attribute), sub-line shows `repoShortName` · `head → base`. **Deviation:** the mock's
sub-line is the repo alone (`PRsLayouts.dc.html:110-114`); the branches stay because Matrix's Base column shows only `up to date`/`behind`, so dropping
them would leave the layout without the branch names Inbox and Cards carry. Sticky PR cell at narrow widths unchanged.

Tests (`prs-matrix.test.tsx`): title element carries the full title as its `title`; sub-line starts with the short repo name.

## Task 8 — `/ui-verify` against the three mocks

Re-run the scratchpad harness (or rebuild it once) with the 7-PR fixture from the report: Board (GitHub + Jira, a board with an empty column), Inbox (menu
open on a pending row), Matrix, Cards — 1440×1000, 600×1000, 390×844, light theme. Every region in the report's tables must read **match** or one of
these accepted deviations — nothing else counts as one:
- guard-backed: branch names in the body face (guard 2); every colour a token, no mock hex.
- data-backed: no `2 of 9` check counts (the payload has only the rollup state).
- kept by this plan: no `Open on GitHub` menu row (the icon button beside the split does it); the menu row reads `Merge`, method in the Confirm (§4.8/§6);
  Inbox meta line starts with the repo short name; Matrix sub-line keeps `head → base`; Matrix auto-merge cell reads the method as text (DESIGN §8.11).
Report to `docs/superpowers/reviews/2026-11-06-github-restyle-fixes-ui-verify.md`.
