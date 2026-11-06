# Review 1 — `docs/superpowers/plans/2026-11-06-github-restyle-fixes.md`

Reviewer: fresh subagent (Fable), 2026-11-06. Source treated as the spec: `docs/superpowers/reviews/2026-11-06-github-restyle-ui-reverify.md`.
Mocks: `docs/superpowers/specs/2026-11-05-jira-restyle-mockups/{Board,PRs,PRsLayouts}.dc.html`. Every claim below was checked against the code at
`6e2b2e19`; file:line references are to the repo, `plan:N` to the plan.

## Verdict: REVISE

One Critical (the plan asks for a monospace face the design guards forbid), and enough Important value mismatches against the mocks that Task 8 — the plan's
own gate — could not pass as written. None of the fixes is large; most are one sentence each.

## Checklist coverage

1. **Coverage.** Every defect id in the source has a task: B1, B2 → Task 1; I5 → Task 2; I2, I3, I4, I8 → Task 3; I1, I6, I7 → Task 4; I9 → Task 5; C1, C2 →
   Task 6; M1 → Task 7. The source's two recorded deviations (counts `2 of 9`, the Matrix auto-merge cell) have no task, correctly — but see I-9: Task 8 does
   not list them as accepted.
2. **Values.** Several differ from the mock — see C-1, I-4, I-5, I-6, I-7, I-9, I-10, I-13.
3. **Reality.** Paths and lines named exist: `GlyphTile.tsx:9` (size union `18 | 28 | 32`), `Pill.tsx:25`, `PrMatrix.tsx:181`, `BoardColumn.tsx:24/74`,
   `styles.css:1126`, all nine test files. One stated fact is false — I-1 (`LEVEL_DOT` is already shared). `--card` exists (`shared/theme.css:247`).
4. **Interfaces.** `GlyphTile` `40` (Task 3) is consumed only in Task 3; the `Pill` `glyph` prop likewise; the short-name rule is produced in Task 3 and consumed
   in Tasks 6 and 7 by reference ("as Task 3") — fine, but it has no named home (I-7).
5. **Order.** No task depends on a later one.
6. **Tests.** Task 5's tests already pass today (I-3); Task 2's expected value does not match the suite's fixture (I-2); Task 6's "grid class present" names no
   element (I-11); Task 1's "renders the ground" is not observable in jsdom as written (M-7).
7. **Conventions.** Behaviour-not-code is followed throughout; size budgets are not stated, which is fine.

## Critical

**C-1 — plan:50 "branch names in mono" fails design guard 2.** `test/design-guards.test.ts:152-162` allows exactly one `font-family` declaration in
`styles.css` — `body { font-family: var(--font) }` — and every other one must be `inherit`; `.claude/DESIGN.md:16` says "no monospace … numerals are set in
the same face". The mock's `.mono` (PRs.dc.html:65, `ui-monospace`) is exactly what §8.2 deleted. Building plan:50 as written goes red on the suite the
plan's own ground rule (plan:12) says to run. → Say the branch names stay in the one face, distinguished the way the repo already draws a command (§8.4.3:
an inline code-span look, `--ink` on `--steel`, 4 px corner, face inherited) or simply at 500 weight `--ink`, and record it as the guard-backed deviation
Task 8 needs.

## Important

**I-1 — plan:65 "move `LEVEL_DOT` to a shared module rather than copy it" is a false fact.** `LEVEL_DOT` is declared in `client/src/lib/pr-layouts.ts:380`
and `PrMatrix.tsx:13` imports it from there; `PrMatrix.tsx:181` only draws it. → "import `LEVEL_DOT` from `lib/pr-layouts.ts`, as `PrMatrix` does".

**I-2 — plan:37 `7 open in 2 repos` is not what `prs-view.test.tsx`'s fixture yields.** The suite's base payload is `futin/x` (total 2) and `futin/y`
(total 1) — `test/prs-view.test.tsx:128-129` — and `:835` already asserts `3 open`. The "fixture shape above" is the report's 7-PR harness fixture, which is
not in any suite. → `3 open in 2 repos` for the base payload, and name the three assertions Task 2 breaks that must be rewritten rather than deleted:
`:270` (`2 open` pill — that one is the Cards head and stays), `:821-823` (toolbar polled age moves to the band), `:835` (`3 open` pill becomes sub-line text).

**I-3 — plan:79 Task 5's tests pass before the task.** "Tick on `primaryKey`'s row only" is pinned at `test/prs-actions.test.tsx:195-207`, and every menu
row already carries a `GlyphTile` (`PrActions.tsx:163`, `size={18}`), so "three rows each with a tile" passes today. The source's I9 is about the tile size
and the tick's visibility at 1440, which these tests do not touch. → Pin `data-size="28"` on all three tiles and the tones (merge `green`, the other two
`neutral` — mock `tile g` / `tile`, PRs.dc.html:131-133); the tick's trailing position and the primary row's ground are CSS, so pin them by a stylesheet read
or leave them to Task 8.

**I-4 — plan:17-18 "give `BoardColumn` the ground unconditionally" also grounds Archive, which the plan never mentions.** `ArchiveView.tsx:308` renders
`BoardColumn` under `.board-columns`, and its sticky month heading paints `background: var(--board)` (`styles.css:1197-1200`) precisely so cards scroll
under it — inside a `--steel` column that becomes a wrong-coloured strip. B2's `align-items: start` removal also stretches Archive's columns. → Decide and
state it: either scope the ground to the Board and Jira (a page rule on `.board-columns`'s children, or a `ground` prop the two boards pass) and leave Archive
as §8.5 describes, or include Archive and change `.archive-month`'s ground to `--steel` in the same task, with a test either way.

**I-5 — plan:45 Cards tile 32 px: the mock draws 28.** PRsLayouts.dc.html:124-130 draws Cards rows with `.tile` (28 px, `:59`); `.tile.lg` (40) is the Inbox's
alone. The Cards head tile is also 28 px there (`:123`), where `PrCards.tsx:48` draws 32 and plan:85 names no size. → 28 for both (already in `GlyphTile`'s
union), or record 32 as a deviation Task 8 may accept.

**I-6 — plan:64/70 a grey dot on `Quiet`: the mock draws none.** PRs.dc.html:108 gives `Needs you` a `dot r`, `Worth a look` a `dot a`, and `Quiet` no dot.
The source's I6 says "red / amber / grey", so the plan follows the source against the mock; `LEVEL_DOT.quiet` is already `undefined` (`pr-layouts.ts:383`),
which `Dot` draws as toneless grey. → Pick one and say so: no dot for `quiet` (option carries a node only when `LEVEL_DOT[level]` is defined), and the test
pins "dot on two levels, none on the third"; or keep the grey one and list it under Task 8's accepted deviations.

**I-7 — plan:51 the repo name at the start of the meta line is not in the mock or the source.** PRs.dc.html:114/126 draw `futin · execute/468 → main · 1h ago`
with no repo; the source's I4 asks for the same. The placement is sensible (Inbox lists across repos) but it is the plan's invention, and `repo.repo` is
`owner/name` today (`PrRow.tsx:38`, fixtures `a/x`). → State it as a deliberate deviation with the reason, so Task 8 can accept it; give the short-name rule
one named home in `lib/prs.ts` or `lib/pr-layouts.ts` (Tasks 6 and 7 consume it "as Task 3" with no name) and its exact rule: last `/` segment, full name
when two SHOWN repos share that segment.

**I-8 — plan:92 Matrix sub-line `short name · head → base`: the mock shows the short name alone.** PRsLayouts.dc.html:110-114: `<div class="xs muted">
backlog-manager</div>` under the title, nothing else; the source's M1 says "repo short name beneath". → Drop `head → base` (the `base` column already names
the base) or record the deviation.

**I-9 — plan:99-101 Task 8's acceptance rule contradicts the deviations the plan itself keeps.** "Every region must read match or a deviation backed by a
design guard — not by this plan or DESIGN.md" would fail on: no `Open on GitHub` row and `Merge` instead of `Squash and merge` (plan:76 vs PRs.dc.html:131,135;
the app-restyle spec §6 chose both), counts `2 of 9` (source I3), the Matrix auto-merge cell (source), plus I-5/I-6/I-7/I-8 above. → Give Task 8 an explicit
list of accepted deviations with their reason (spec §6, data the payload lacks, a design guard), and have it fail only on anything not on that list.

**I-10 — plan:62 "8 px between rows": the mock's gap is 10 px.** PRs.dc.html:109 `<div class="col" style="gap:10px">`. → 10.

**I-11 — plan:88 "grid class present" names no element, and `PrCards` has none.** `PrCards.tsx:93-99` returns a fragment — the repo sheets and then
`PrRepoNotes` sit directly in `.prs` (`styles.css:3302`, a flex column shared by all three layouts). → Say the grid is a new wrapper around the `RepoSheet`s
only, notes outside it, and the test asserts that wrapper's class; otherwise an implementer may put the grid on `.prs` and reflow Inbox and Matrix.

**I-12 — plan:75 "a soft hover ground" on the primary row: the mock's `.mi.on` is a ground at rest, not on hover.** PRs.dc.html:75 `.mi.on{background:
var(--strip-hi)}` marks the primary row; `.prs-keys-row:hover` already draws `--strip-hi` today (`styles.css:3336`), so the sentence as written changes
nothing. → "the primary row carries a `--strip-hi` ground at rest, hover unchanged".

**I-13 — plan:55 the auto-merge tone lives in `prChips` (`client/src/lib/prs.ts:84`), not in `prPills`.** `prPills` (`pr-layouts.ts:114`) only wraps it;
`test/prs-lib.test.ts:91` pins `{ label: 'auto-merge · rebase', tone: 'live' }`. → Name `prs.ts:84` as the edit and `:91` as the assertion that flips to `done`.

## Minor

**M-1 — plan:9** "no `style=`" is not a design guard: `test/design-guards.test.ts` has guards 1-9 and none reads markup; the rule is the CSP invariant in
`CLAUDE.md` (`style-src 'self'`) and `test/csp.test.ts`. Cite that instead.

**M-2 — plan:21** DESIGN.md has no literal "Jira only". The sentence is §8.9.1 "Columns" (`.claude/DESIGN.md:597`: "The Jira shelves pass `BoardColumn` its
`tone` prop … which gives the column a `--steel` ground … the Board's own columns, which pass no `tone`"), and §8.3 "Columns" (`:323`) must gain the ground.
Name both.

**M-3 — plan:68** §8.11 records no "no level dot" deviation (`grep -n "level dot" .claude/DESIGN.md` is empty); the Inbox paragraph only says the three
count tiles "with the level's `Dot`" were replaced. The edit is to the Inbox paragraph; there is nothing to remove.

**M-4 — plan:76** "§4.8/§6" are the app-restyle spec's sections (`docs/superpowers/specs/2026-11-05-app-restyle-design.md:162, :252`), while Task 1's "spec
§4.3" is the jira-restyle spec's (`2026-11-05-jira-restyle-design.md:159`). Two specs, two numberings — name the file each time.

**M-5 — plan:32** the Inbox mock's own sub-line is `open PRs on this machine's GitHub repos · polled 1m ago` (PRs.dc.html:107); only PRsLayouts' reads
`4 open in 2 repos` (`:107`, `:120`). The plan's choice follows the source; say that the PRsLayouts form wins for all three so Task 8 does not read the Inbox
mock literally.

**M-6 — plan:35** `.ui-band-right` already wraps with `margin-left: auto` (`styles.css:3485`), so "full width under the title" at <700 px needs a page rule on
the band's wrapper, not the primitive (guard 7). Worth one clause.

**M-7 — plan:24** "a column without `tone` renders the ground" is CSS, not markup, so jsdom cannot see it; the next line's guard-style stylesheet read is the
only way. Say the assertion: `.board-col`'s body carries `background: var(--steel)`, `border-radius: 16px`, `padding: 12px`, and `.board-col[data-tone]`
no longer restates them.

**M-8 — plan:46** the `GlyphTile` size rules sit inside the ui primitives block (`styles.css:4129-4131`); the new `[data-size='40']` rule must land inside it
or guard 7 reads it as a page restatement.

**M-9 — plan:54** source I8 is about the Inbox pill; the Matrix auto-merge cell (`squash` text) is a separate recorded deviation. Fine as is; noting so Task 8
treats them apart.

**M-10 — plan:99** the scratchpad harness and `shots/` from the previous session are session-scoped and may be gone; "rebuild it once" covers it, but the
fixture (7 PRs over 2 repos, the seven states in the source's header) should be restated in the plan so the rebuild reproduces the report's numbers.
