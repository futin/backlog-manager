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
  Prefer giving `BoardColumn` the ground unconditionally over inventing a GitHub `tone`; the `data-tone` hook keeps only the dot colour.
- Every column in a board is the same height: the grid stretches its items, and the board fills the well down to its foot when there are few cards, so an empty
  column is a full-height ground with its head, never a 40 px strip. With many cards the page still scrolls as today.
- DESIGN.md: drop "Jira only" from the column-ground sentence (spec §4.3 reversed by the user).

Tests:
- `test/board-column.test.tsx`: a column without `tone` (GitHub) renders the ground; a toned (Jira) column still carries its `data-tone` and its
  `.board-col-dot`. The toneless column keeps its ramp `Dot` (`BoardColumn.tsx:24`) — only the ground is shared. Update the `tone` prop's comment
  (`BoardColumn.tsx:74`, "only `JiraShelves` passes it … gives the column a `--steel` ground") so it no longer claims the ground.
- Guard-style test pinning `.board-columns` does not use `align-items: start` (read the stylesheet as other guards do), so the cut ground cannot return.

## Task 2 — Shared PR head for all three layouts (I5) — mocks `PRs.dc.html` and `PRsLayouts.dc.html`, the head

Behaviour:
- Band sub-line reads `N open in M repos · polled <age>` led by the live dot; `M` counts shown repos with ≥1 open PR. One repo: `in 1 repo`.
- The layout `Segmented` moves into the band's trailing slot (right of the title); the separate `N open` pill and the toolbar's right-side `polled` go.
- The toolbar row keeps only the notes (`N repos hidden — no access`, Cards' `N repos with no open PRs`) and disappears when it has none.
- Narrow (<700 px): the switch wraps under the title, full width — check it is still reachable without sideways scroll.

Tests (`prs-view.test.tsx`): `7 open in 2 repos` for the fixture shape above; `1 open in 1 repo`; the switch is inside the band; no `N open` pill;
toolbar absent when there is no note; hidden-repo note still rendered.

## Task 3 — PR row anatomy (I2, I3, I4, I8) — mock `PRs.dc.html`, a row; `PRsLayouts.dc.html`, a Cards row

`PrRow` is shared by Inbox and Cards, so both change together.

Behaviour:
- Status tile 40 px in Inbox, 32 px in Cards (mock draws Cards smaller) — through `GlyphTile`'s `size` prop, whose union is `18 | 28 | 32` today
  (`client/src/components/ui/GlyphTile.tsx:9`): add `40` there, with its CSS size rule, and cover it in `test/ui-glyph-tile.test.tsx`.
- Checks and mergeability pills lead with their glyph (failing ✕, passing ✓, pending clock, conflicts ✕). `Pill` has no icon slot
  (`client/src/components/ui/Pill.tsx:25`): add an optional `glyph` prop (a `GlyphName`, drawn `aria-hidden` before the text) and cover it in
  `test/ui-pill.test.tsx` — present when passed, absent otherwise.
- Pills and meta share ONE wrapping line: pills, then `author · head → base · age`, branch names in mono; the run-warning pill stays at the meta's end.
- Inbox's repo name moves from beside the title to the start of the meta line, short form (`backlog-manager`, owner dropped unless two shown repos share a
  name — then full).
- `auto-merge · <method>` is a tinted pill (the `done` tone, as the mock's `auto-merge on`), not the solid `live` fill. `.ui-pill-live` itself is untouched.

Tests (`prs-inbox.test.tsx`, `prs-view.test.tsx` for Cards, `prs-lib.test.ts` for `prPills`): tile size 40 / 32 per layout; pill glyph present for `failure`, `success`, `pending`,
`conflicting`; meta and pills inside one container; repo short name `backlog-manager`, full name when two repos named `ui-kit` under different owners;
auto-merge pill tone `done`.

## Task 4 — Inbox rows as cards, triage dots, Quiet section (I1, I6, I7) — mock `PRs.dc.html`

Behaviour:
- Each Inbox row is its own card: `--card` ground, hairline border, radius 14, padding ~14×16, 8 px between rows, no divider rule. Cards layout rows stay
  boxless inside their repo card — so the card skin belongs to the Inbox list, not to `PrRow`.
- Each triage option carries its level dot before the label (needs you red, worth a look amber, quiet grey) — the same `Dot` + `LEVEL_DOT` mapping
  Matrix draws (`client/src/components/github/PrMatrix.tsx:181`); move `LEVEL_DOT` to a shared module rather than copy it. `Segmented` options take a
  label only today: if it needs a leading-node slot, add it as a prop (guard 7) and cover it in its suite.
- `Quiet` becomes a section label with space above (≥16 px) matching the triage's type, not a bare word between cards.
- DESIGN §8.11 "Row anatomy": Inbox rows are boxed; Cards rows stay boxless. Remove the recorded "no level dot" deviation.

Tests: Inbox list items carry the boxed class; Cards rows do not; triage option has a dot with the level's class for all three levels; `Quiet` heading still
an `h3` and still absent when no quiet PRs.

## Task 5 — Merge menu rows (I9) — mock `PRs.dc.html`, the open menu

Behaviour: each menu row's icon sits in a 28 px tinted `GlyphTile` (merge green, auto-merge neutral, update neutral); the primary row shows its tick at the
trailing edge and a soft hover ground. Text unchanged (`Merge`, method stays in the Confirm — §4.8/§6 still hold). No `Open on GitHub` row: the icon button
beside the split already does it (deviation, keep).

Tests (`prs-actions.test.tsx`): three rows each with a tile; tick on `primaryKey`'s row only; disabled rows still `aria-disabled` with their reason.

## Task 6 — Cards grid and head (C1, C2) — mock `PRsLayouts.dc.html`, Cards

Behaviour:
- Repo cards flow two-up when the pane is ≥ ~1100 px wide (container query or grid `auto-fill, minmax(520px, 1fr)`), one column below. Cards align to top.
- Card head: dark repo glyph tile, short repo name, `N open` pill right after the name, `polled <age>` at the head's trailing edge.
- DESIGN §8.11 "Grouping (Cards)": two-up replaces one column.

Tests: card head order (tile, name, pill, age); short name rule as Task 3; grid class present.

## Task 7 — Matrix title (M1) — mock `PRsLayouts.dc.html`, Matrix

Behaviour: title stays on one line with ellipsis (full title in `title` attribute), sub-line shows repo short name · `head → base`. Sticky PR cell at narrow
widths unchanged.

Tests (`prs-matrix.test.tsx`): title element carries the full title as its `title`; sub-line starts with the short repo name.

## Task 8 — `/ui-verify` against the three mocks

Re-run the scratchpad harness (or rebuild it once) with the 7-PR fixture from the report: Board (GitHub + Jira, a board with an empty column), Inbox (menu
open on a pending row), Matrix, Cards — 1440×1000, 600×1000, 390×844, light theme. Every region in the report's tables must read **match** or a deviation
backed by a design guard — not by this plan or DESIGN.md. Report to `docs/superpowers/reviews/2026-11-06-github-restyle-fixes-ui-verify.md`.
