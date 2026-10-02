# Final whole-branch review — band filter track and shared Popover

Range `cb98630..7fca6c0` on `feat/band-filter-popover`, reviewed against the spec (`docs/superpowers/specs/2026-10-01-band-filter-popover-design.md`), the
plan's Global Constraints and Review Focus, the ledger (`progress.md`) and the five per-task reviews. Read: the full `-U10` diff, `CLAUDE.md`,
`.claude/rules/board.md` and `tests.md` (the two rule files whose `paths:` cover changed files), DESIGN.md §5/§8.0/§8.3/§8.5/§8.7, and — to settle specific
doubts — `BoardView.tsx` around the count line and `orchestrateProject`, `Segmented.tsx`/`Chip.tsx` for their aria, `styles.css` for `.ui-band-right` and
`container-type`, `lib/settings.ts` for the `fontScale` bounds, and `.prettierrc.yaml`/`.prettierignore`. No tests re-run (the controller holds the full run),
no git state touched.

### Strengths

- **`ui/Popover` is a genuinely minimal primitive with the two hard-won behaviours lifted intact.** Dismissal keeps its two owners (the stack for the key, its
  own `pointerdown` for the pointer); the anchor is excluded from "outside" so the toggle lives in one click handler — and `test/tracker-chip.test.tsx`'s new
  "closes on a second click of the chip rather than closing and reopening" case pins the exact failure that exclusion prevents. The width travels as
  `--ui-popover-width`, never inline, and the `it.each` desktop/narrow case guards the inline-width trap the plan called out as invisible to jsdom.
- **`resolveSortKey` goes further than the plan's `?? COMPARATORS.created` and is better for it.** One resolution feeds the order, the label, the ticked row
  and the natural direction; the own-property test rejects `'constructor'`; the fix-round tests (`Sort: newest ()`, `42`, `{}` as a React child) were proved
  red against the plan's form before landing (task-4-rereview-1). The ledger records the deviation and the spec pointer was retargeted.
- **The direction is a `sign` parameter, not a negated result.** `project`'s newest-first tie-break therefore survives `Descending`, exactly as spec §3 asks,
  and the `Project descending orders projects Z→A and keeps newest first inside each project` case would fail under the naive negation.
- **Every Review Focus item has a real test**, each with a fixture that can only pass if the named behaviour ran: the stored-key-no-direction upgrade path
  (`null` fallback resolved per key), twin checkouts keyed by path (`stubItems` grew a `projects` parameter for it), the stale path failing open on badge,
  pressed chip and count line at once, the popover surviving a pick as the *same element* (`toBe(before)` — a remount that reopened would still fail), and
  Clear all leaving search and sort alone.
- **`FilterBar` is one stable element in both bands**, never keyed on a filter value or behind a condition, and both views say why in their JSX comments.
- **Guard 7 is respected without contortion**: `.filter-bar-section-fill [role="group"] button` reaches the Status switch with no family token; `.ui-popover`
  joined `FAMILIES`; the phone shape is a `useNarrow` class rather than a second media block.
- **The docs moved with the code**: the Escape-stack sentence in `.claude/rules/board.md`, `invariants.md`, `useDialogEscape.ts`, `board.md` and DESIGN §8.7
  all now name `Popover` with "three dialogs" intact; §8.0 records the tracker panel's visible change; §8.3/§8.5 describe the track; `view-keys.ts` names the
  direction key among the local ones; every `.board-filter*` reference is gone (`grep` over `client/src/ test/` is empty).
- **`test/helpers/filter-bar.ts` is the one home for the accessible names** five suites drive through, and its header says exactly why no helper closes
  the panel.
- The task reviews were applied rather than filed: every Important from the per-task rounds is fixed on the branch, and the deferrals in `progress.md`
  match what is actually still open (listed under Minor below).

### Issues

**Critical** — none.

**Important** — none.

**Minor**

1. `docs/subsystems/board.md:115-116` and `:137` — 161, 163 and 163 columns. `.prettierrc.yaml` sets `printWidth: 160` with `proseWrap: always` and board.md
   is not in `.prettierignore`, so an editor's format-on-save rewraps these three lines and nothing else. Re-wrap the new text at 160; leave neighbours.
   (The 227-column table row at `:56` is a table row, which the convention exempts.)
2. `.claude/DESIGN.md` §8.7 (~line 391) — "the tooltip's small `0 8px 24px` lift (§7)". The tooltip shadow is §5 "Elevation & strokes" (line 137); §7 is
   "Reusable patterns". The spec itself says "DESIGN.md §5's tooltip lift". Change to `(§5)`. (Task-1 Minor, still open; line 391 is in the editable §8.)
3. Stale pointers to the comment that moved from `sortItems` to `resolveSortKey`: `client/src/components/board/BoardView.tsx:559` — "`?? 'items'` for the
   same reason `COMPARATORS` above has a fallback" (`COMPARATORS` no longer has one); `test/board.test.tsx:685` — "see the comment over `sortItems`'
   fallback in BoardView.tsx". Retarget both to `resolveSortKey`. (Task-4 Minor 1; the third pointer at board.test.tsx:806 was fixed.)
4. `client/src/components/board/BoardView.tsx:583` — the count line's `registered.find((p) => p.path === projectValue)?.name ?? projectValue` repeats
   `orchestrateProject` (`:634`) and `orchestrateProjectName` (`:648`), which derive the same thing from the same inputs 50 lines later. Hoist the lookup above
   the count line and read `.name` from it. `ArchiveView.tsx:693` builds the same expression; two surfaces is not yet a `lib/` module, but if a third appears
   it becomes one `projectName(registered, path)`.
5. `test/helpers/filter-bar.ts:8` — "and Archive's from the next task" is a plan-timeline reference that went stale when Task 5 landed. Say "and Archive's".
6. `client/src/styles.css` ~374 (Board-section comment) — "put the project and status pickers behind the track's panel on both surfaces". Archive has the
   project picker only. (Task-5 Minor 2.)
7. `client/src/styles.css` `.filter-bar-section-fill` comment — "the four options' floors sum to ~260 px" while the test comment beside the same rule says
   "266 px content box" and the Task 3 report measured the floors at 266. Make the figures agree or drop the number. (Task-3 Minor 2.)
8. `docs/subsystems/board.md` ~75 — "`FilterBar.tsx` is three exports, not one": the module has five (`FilterBar`, `FilterSection`, `ProjectPicks`,
   `SortDir`, `FilterBarSort`). "Three components" is what is meant. (Task-3 Minor 1.)
9. `test/archive.test.tsx` band case — `within(dialog).getByText('Project')` is meant to pin the bare heading but passes with any hint present, because
   `FilterSection` puts the title in its own span. The real guard is the `/Orchestrate needs one/` absence check above it; if a stricter pin is wanted,
   assert the heading element's whole `textContent` is `Project`. (Task-5 Minor 3.)
10. `client/src/components/ui/Popover.tsx` — when Escape closes the panel while focus is inside it (a keyboard reader who tabbed to a pick), the panel
    unmounts and focus drops to `body`; the next Tab starts from the document's top. Same shape the tracker popover and `Confirm` already have, and the spec
    is silent; a reasonable keyboard user would expect focus back on the opening control. If addressed: on unmount, when `document.activeElement` is inside
    the panel, focus `anchor.current`. Polish, not a regression.
11. `.ui-popover-narrow { max-height: 70vh }` is the one viewport measure in the family not divided by `--font-scale` (the base rule's `max-width` is).
    `fontScale` ranges 80–130; at 130 the phone panel's cap is ~91 % of the zoomed viewport, so a panel opened below the band can run past the bottom edge.
    Inherited verbatim from `.tracker-pop`'s old rule and from the spec's eight declarations, so this is a nit with the spec, not the branch. Fix if wanted:
    `max-height: calc(70vh / var(--font-scale, 1))`.
12. `client/src/components/FilterBar.tsx` — `title="Filters"` on the filter button becomes its accessible *description* once the name reads
    `Filters, 2 set`, so a screen reader hears both. Ruled accepted in Task 3 for dashboard parity; recorded here only because it is the one addition a
    screen-reader user would notice. `title={count > 0 ? \`Filters, ${count} set\` : 'Filters'}` would remove the double-speak at no cost.
13. `client/src/components/archive/ArchiveView.tsx` ~186-198 — the count-line comment restates BoardView's paragraph nearly sentence for sentence while also
    pointing at it. Keep the pointer, drop the retelling, so the rule has one home. (Task-5 Minor 4.)

### Declined to judge

1. A popover opened by keyboard under the item modal's scrim (Tab reaches the band because nothing traps focus) — pre-existing for the tracker chip, and the
   Escape rule's own "knowingly out of scope" covers it; the spec explicitly accepts "whichever mounted last".
2. Tab order placing the panel after the sort button rather than after the filter button — spec §2 mandates the panel's DOM position after the track, in
   block flow, for the phone rule's `top: auto`.
3. The phone popover staying viewport-fixed while the page scrolls — any touch outside closes it, so it is unreachable in practice; the rule is the spec's.
4. A stale stored sort key staying in localStorage after re-picking `Created` (nothing is stored on a same-key pick) — harmless, every reader goes through
   `resolveSortKey`; the ledger's deferral holds.
5. No test for a two-digit badge (the `min-width` + padding pill path) — the count is at most 2 on Board and 1 on Archive, so the path is unreachable today.
6. The Runs page's own project `<select>` — spec "Out of scope".
7. `Chip`'s pressed look and `Segmented`'s pill skin — the primitives' own, untouched by this branch.
8. The Task 3 additions (`flex: none` on the wrapper, `max-width`/`overflow` on picks, `[aria-expanded]` ink, the divider's phone margin) — ruled accepted
   in the ledger; all commented and all parity with the dashboard.
9. Commit trailers naming the actual implementer model rather than the contract's line — ruled in Task 1.

### Recommendations

- Fix Minors 1–3, 5, 6 and 8 in one small docs/comments commit before merging: they are all stale text that will mislead the next reader of a file this
  branch otherwise got right, and none touches behaviour.
- Minor 4 (hoist the project lookup) is a two-line edit with a test already in place (`project filter narrows … and the count line names the project`).
- Minors 10 and 11 are worth a backlog item each rather than a fix here: both are shared with the pre-existing tracker popover, and 11 is a spec-level
  decision about the phone rule.
- The plan's "160-column wrap for new text" is met in the new files and the long new comments; the narrow-wrapped paragraphs the Task 4 review flagged
  were spliced into existing ~75-column blocks, which the convention allows, so I did not re-raise them.

### Assessment

**Ready to merge? Yes.** Every spec §4 test case and §5 doc edit is present, the five Review Focus inputs are pinned by fixtures that can only pass for the
right reason, the three task-review Importants were fixed on the branch, and what remains is thirteen Minors — stale pointers, three over-width doc lines, one
wrong section cross-reference and two polish items shared with the pre-existing popover — none of which changes behaviour a reader would hit.
