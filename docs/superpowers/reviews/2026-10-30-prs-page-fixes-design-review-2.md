# Review — `2026-10-30-prs-page-fixes-design.md`, round 2

Document: `docs/superpowers/specs/2026-10-30-prs-page-fixes-design.md` (292 lines). Kind: spec. Reviewed against the tree at `4060b76d` (main), with the
round-1 report (`2026-10-30-prs-page-fixes-design-review-1.md`) used only to avoid re-reporting what is fixed. Line numbers `doc:N` are the spec's as it
stands now; every claim about the code cites the file and line it was checked at.

## Verdict: APPROVE WITH FIXES

Round 1's Critical (`updateBlock`'s last rung) and its Important findings are fixed: the ladder now gates both words on `canUpdateBranch` (doc:65-66), Chip's
`as="a"` is stated as an addition (doc:98-99), the GatedChip pattern is `aria-disabled` (doc:102-103), the Docs list names the DESIGN paragraphs and the
board.md lines, Matrix's sticky geometry has a container and a cap, and an open Confirm whose PR turns merge-blocked closes (doc:115-116). No Critical
remains. Six Important findings: one mechanism the spec asserts but the code cannot do as described (the 30 s timer judging its own re-read), one gap that
re-opens anti-goal doc:42, one empty state left undefined, one write path the in-flight rule does not cover, one CSS instruction that does nothing on a table
cell, and one wrong test value. Each fix is a sentence.

## Critical

None.

## Important

### I1 — The 30 s timer cannot "judge its own re-read" with the `refresh` it has (doc:90-94, test doc:247-248)

The spec: the timer "re-reads FIRST and judges its own re-read by that same rule — a new head is `branch updated`, the same head drops the mark … a re-read
that fails is judged 'same head'". The timer has no way to see what its re-read returned:

- `refresh` is `useRefreshing(load, …)` (`client/src/hooks/usePullRequests.ts:42`), typed `() => Promise<unknown>` (`usePullRequests.ts:26`), and resolves
  `load`'s return value (`client/src/hooks/useRefreshing.ts:23`, `() => Promise<T>`). `load` returns nothing: it calls `setData(fresh)` and swallows its own
  failure into `setError` (`usePullRequests.ts:31-40`). So the timer gets `undefined` for a new head, for the same head and for a failure alike.
- It cannot read `data` either: the timer's closure holds the `data` of the render that armed it, and `setData` from a fetch continuation is a batched,
  scheduled update — the `await refresh()` continuation runs before React renders it, so a ref or state read right after the `await` is still the old payload.
- The only code that compares heads is the data effect (`client/src/components/github/PullRequestsView.tsx:124-132`), which runs after that render. A timer
  that drops the mark after `await refresh()` and before that effect runs (the natural reading of "judges … the same head drops the mark") removes the mark
  first, and the effect then finds no mark to turn into `branch updated` — #397's common case is blank again, the exact failure doc:92-93 warns about.

The builder must invent the mechanism, and the obvious one ships the bug. → Say how the timer learns the answer: e.g. `refresh` (or `load`) resolves the
fresh payload, or `null` on a failure, and the timer compares that payload's head with the mark's `sha` itself; or the timer drops nothing and leaves both
verdicts to the data effect, which then needs a "timer fired" flag to drop a same-head mark. Either way `usePullRequests` changes, so add it to the Data
section and add `use-pull-requests` and `github-settings` (the two suites that name `usePullRequests`, by `grep -l`) to the source-guard list at doc:270-274.

### I2 — In Inbox and Cards a write during the mark leaves `Update` greyed with no visible reason (doc:76-78, doc:149-150, doc:280-281; anti-goal doc:42)

The why-line omits `updating…` because "the outcome line or the Base cell already says" it (doc:77-78), and Inbox and Cards, having no Base cell, rely on
the `updating` outcome line (doc:280-281). That line is the OUTCOME, not the mark: `PrOutcomeLine` draws `outcome.text` and only hides an `updating` one
once the mark ends (`client/src/components/github/PrOutcomeLine.tsx:14-16`). `write` deletes the key's outcome before every call and sets the new one after
(`PullRequestsView.tsx:139-144`, `:154`), and neither `Auto-merge` nor `Merge` is blocked by the mark (`autoMergeBlock` and `mergeBlock`, doc:64, doc:69-71). So a
person who clicks `Update` and then `Auto-merge` within 30 s sees `auto-merge armed` as the row's only line while the mark holds; `Update` stays
`aria-disabled` with `updating…` on hover and to a screen reader only, the row still shows `behind base`, and nothing visible says why the key is grey —
exactly what anti-goal doc:42 forbids ("a phone has no hover"). → Either draw `updating…` on the why-line while the mark holds and the outcome line is not
the `updating` one (Inbox and Cards only), or have the outcome line say `updating…` from the mark rather than from the outcome kind; add an Inbox case:
Update, then Auto-merge during the mark → a visible `updating…` remains.

### I3 — Cards' empty state is undefined, and the 10-29 rule it replaces is not listed as superseded (doc:170-178, doc:3-4)

Cards now draws "a card per repo that holds at least one open PR" (doc:170). When no shown repo has an open PR — every repo read cleanly and empty, or every
repo not yet read (doc:173-174) — Cards draws no card and the spec does not say what the layout area shows: nothing, `no open pull requests`, or the toolbar
note alone. Today Cards needs no page-level sentence because every card carries its own `no open pull requests` (`PrCards.tsx:31`), and that is why the
10-29 spec's "Empty states" exempts it: "Inbox and Matrix say `no open pull requests` (Cards keeps its per-repo line)" (`2026-10-29-prs-layouts-design.md`,
"The page", "Empty states"; mirrored in `.claude/DESIGN.md:540`). This spec removes the per-repo line but doc:3-4 does not list "The page" among the
superseded sections, so the 10-29 rule "still holds" and is now wrong. → State Cards' empty state (Recommended: the same `no open pull requests` as Inbox and
Matrix, under the same clean-read condition, with the toolbar note beside it), name "The page" / "Empty states" in doc:3's superseded list, and add a
prs-view case: Cards with every repo ok and empty → `no open pull requests` and `2 repos with no open PRs`.

### I4 — The in-flight rule covers the keys only, so an open Confirm can still send a merge while another write on the row is in flight (doc:104-106, doc:108-111)

"While the row's write is in flight every key but `Open ↗` is `disabled` outright." The Confirm's accept is not a key, and the Confirm now outlives a
keypress elsewhere on the row: `Merge` opens it, then `Auto-merge` (enabled, not blocked by an open Confirm) sends a write; the Confirm stays drawn
(doc:114-119 closes it only on another row's Merge, a departure, a merge block, a filter, a collapse or a layout switch), and its `Merge` accept sends a
second POST on the same key. `write` then has two flights on one key: the first `finally` deletes the key from `inFlight` (`PullRequestsView.tsx:156-161`)
while the second is still running, freeing the keys early, and the later outcome overwrites the earlier one. Today's code has the same hole (the Confirm's
accept is unguarded; only the method `Select` is `disabled={busy || confirming}`, `client/src/components/github/PrActions.tsx:150`), but this spec rewrites
the Confirm's home and restates the in-flight rule, so it is the place to close it. → One sentence: while the row's write is in flight the Confirm's accept is
disabled too (or a write leaving on the row closes its Confirm); one prs-actions case.

### I5 — `max-width: 60cqw` on the PR cell does nothing, and the fallback is a sticky column that can hide every evidence cell (doc:164-167)

The cap's first option is "`max-width: 60cqw` on the PR cell". CSS leaves the effect of `min-width`/`max-width` on table cells undefined (CSS 2.1 §17.5.2),
and browsers ignore `max-width` on a `<td>` in automatic table layout. With the table `max-content` wide (doc:164-165) and the title no longer ellipsizing
(doc:166), an ignored cap gives the PR cell its title's full one-line width; on a phone that sticky cell is wider than the box, and the evidence columns
scroll underneath it and are never visible — the opposite of "keeps about 120 px of evidence cells in view" (doc:167). The arithmetic itself is right
(0.6 × 299 ≈ 179; 299 − 179 = 120). → Put the cap on a block inside the cell (e.g. `.prs-row-title`'s wrapper, `max-width: 60cqw` less the dot cell), whose
capped width is what the cell's intrinsic width then reads, or set the cell's `width`; drop "on the PR cell" from the suggestion.

### I6 — The prs-actions Confirm text pins `#12`, but that suite's fixture is `#5` (doc:227-228)

"`Merge` opens `pr-merge-confirm` holding … the text `Merge #12 into main?`". `test/prs-actions.test.tsx:21-31`'s `pr()` factory is `number: 5`,
`base: 'main'`; `#12` is prs-view's fixture (`test/prs-view.test.tsx:84`). → `Merge #5 into main?`, or say the case overrides `number: 12`.

## Minor

- **m1 — `defaultMethod(repo)` (doc:101).** The function takes the method list: `defaultMethod(methods: readonly MergeMethod[]): MergeMethod | null`
  (`client/src/lib/prs.ts:93`). Say `defaultMethod(repo.methods)`, and that a `null` result sends no `method` (as `runAutoMerge` does today).
- **m2 — Arming loses the method pick, and the Calls list does not say so (doc:101, doc:283).** Today `runAutoMerge` arms with the method the strip's `Select`
  shows (`PrActions.tsx:66-69`, `:93`). With the `Select` moved into the merge Confirm, a person can no longer choose the method auto-merge uses; it is always
  the default. Probably intended, but it is a behaviour removed, so one bullet under "Calls made by the author" would let the user check it.
- **m3 — `Chip` already has a pressed look (doc:253-254, doc:268).** `pressed` adds the `on` class (`client/src/components/ui/Chip.tsx:56`) and
  `.ui-chip.on` is styled (`client/src/styles.css:3154`). The "whether the `pressed` chip needs a look" item and the "if one is added" test can go, or say
  the existing look is the one used.
- **m4 — Contradiction: Matrix's scroll box (doc:255 vs doc:159-161, doc:288-289).** "Left to the builder: … whether Matrix's scroll box is `Ledger` or its
  own" contradicts the decided `.prs-matrix-scroll`, page-owned, because the DESIGN guard forbids a page rule on `.ui-ledger`. Drop it from the builder's list
  (or say: `Ledger` may stay as the outer frame, the scroll box is `.prs-matrix-scroll`).
- **m5 — The ink bar in a scrolled Matrix (doc:145, doc:158-159, doc:161-164).** The sticky dot and PR cells carry the open row's ink bar, but the expansion
  row's single spanning cell scrolls with the table; if the bar is drawn on that cell its left edge leaves the view while the pinned content stays. Say the
  expansion's bar rides the pinned block.
- **m6 — Two clocks on one mark (doc:67-68 vs doc:83, doc:149).** `updateBlock` reads the mark's presence, but the Base cell and `hasOutcomeLine` read
  `isUpdating(mark, pr, now)` (`prs.ts:105-107`; `PrMatrix.tsx:77-78`, `PrOutcomeLine.tsx:14-16`), which ends at `until`. Between `until` and the timer's
  verdict (a whole re-read later) the cell reads `behind` and the outcome line vanishes while `Update` is still grey with `updating…` on its title. Either say
  all three read presence, or accept the gap explicitly.
- **m7 — `disabled` vs `aria-disabled` in a test (doc:243).** prs-matrix: "the expansion's `Update` is disabled with `title` `updating…`" — the spec's own
  rule makes it `aria-disabled` (doc:102-103), and `disabled` is reserved for in-flight. Same wording as the prs-actions case at doc:229.
- **m8 — The prs-actions harness and the foot (doc:226, doc:252).** If the builder makes the foot its own component (allowed, doc:252), rendering `PrActions`
  alone draws no `pr-merge-confirm`. Say the harness renders `PrActions` plus the foot.
- **m9 — Anti-goal doc:44 vs non-goals doc:37 and doc:143.** "A word a cell uses, a chip uses, and a verdict uses must be the same word" — but today they
  differ (doc:76-77 itself lists `behind base` chip, `Behind its base.` step, `behind` cell), and the spec keeps cells, chips and verdicts unchanged. Narrow the
  anti-goal to "no NEW word" or to the keys and reasons.
- **m10 — "GitHub would never merge it" is false for failing checks (doc:70-71).** Auto-merge waits on required checks; a re-run can turn them green and
  GitHub then merges. The refusal can stand as the author's call (doc:271), but the reason should say "would not merge it as things stand".
- **m11 — An empty fact line (doc:130-131).** `quietFacts` can return nothing (`client/src/lib/pr-layouts.ts:126`); say a quiet row with no facts draws no
  fact line rather than an empty one.
- **m12 — No test id for `Can't read` (doc:122, doc:236, doc:244-246, doc:248).** Today Inbox's list has `pr-cantread-<repo>` (`PrInbox.tsx:217`) and Matrix's
  row `pr-mfail-<repo>` (`PrMatrix.tsx:191`); four test cases query "a `Can't read` line" with no anchor. Name it (e.g. keep `pr-cantread-<repo>` in
  `PrRepoNotes`, beside its `pr-truncated-`/`pr-syncoff-`, `PrRepoNotes.tsx:24`, `:47`).
- **m13 — DESIGN "The warning chip." is not in the Docs list (doc:184-188).** It says the warning "joins the chips as a warn `Pill`" (`.claude/DESIGN.md:558`);
  a loud Inbox row now draws it on the meta line (doc:131-132). Probably one clause; name the paragraph so it is not missed.
- **m14 — `Merge` while its own Confirm is open (doc:101-102, doc:114).** Opening `Merge` on a second row is specified; a second click on the same row's
  `Merge` (toggle closed, or no-op) is not.
- **m15 — `branch updated` replaces an error too (doc:89-90, doc:291).** "Whatever outcome the row carries" includes an error from a write sent during the
  mark (e.g. a refused auto-merge); the error's sentence disappears unseen if the head moves first. Fine as "latest event", but say errors are included.
- **m16 — The no-open-PRs note at zero (doc:171-173).** Implied but unstated: no note when N is 0.
- **m17 — A sync-off repo with no PRs in Cards (doc:121-124, doc:170).** Not drawn as a card, and Cards' `PrRepoNotes` draws only `Can't read` lines, so its
  sync-off sentence is shown nowhere in Cards (Inbox and Matrix draw it above). Harmless — there are no keys to block — but worth one clause.

## Checked and found sound

- Round 1's C1 and its Important findings: `updateBlock`'s ladder (doc:65-66) matches `prs.ts:75-80` plus the two new rungs; the test values at doc:220-221
  hold against `test/prs-lib.test.ts`'s fixture defaults (`mergeState: 'clean'`, `canUpdateBranch: true`).
- `autoMergeBlock` (doc:69-71) and its test order (doc:221-223); `whyLine`'s seven cases (doc:223-225) recomputed against the ladders.
- `primaryKey` (doc:57-60) keeps every `compactKeys` primary (`pr-layouts.ts:253-262`) plus the behind-and-marked case.
- `columnCounts` counting facts (doc:82-83): `pr-layouts.ts:329-336` takes the `updating` predicate today; the Base-header test (two behind, one marked →
  2) is right.
- Layout: `parseLayout` (`pr-layouts.ts:171`) is unchanged; `drawableLayout`/`layoutOptions` (`pr-layouts.ts:179-191`) and the page's `useNarrow`
  (`PullRequestsView.tsx:175-176`) are the things that go.
- The board.md references: line 98 (the `Chip` row), 481-507 (the PRs paragraph), 673-677 (`compactKeys`); the Escape-stack bullet in
  `.claude/rules/board.md` naming `PrRow` as `Merge`'s opener; dialog-count-docs is unaffected (a `Confirm` is not counted).
- DESIGN guard 7 forbids a page selector starting with a ui family name (`test/design-guards.test.ts:309-392`), so `.prs-matrix-scroll` rather than a rule on
  `.ui-ledger` is correct.
- The source-guard list at doc:270-274 matches `grep -l` today for the symbols it names.
- `NARROW_QUERY` is the 700 px breakpoint (doc:137).
- `.claude/rules/board.md` and `.claude/rules/tests.md` are the only rule files whose paths the spec touches; it respects both (no new dialog, fixture
  dates relative, suites flat in `test/`).
