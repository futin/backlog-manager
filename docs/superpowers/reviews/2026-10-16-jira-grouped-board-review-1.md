# Review 1 — `docs/superpowers/plans/2026-10-16-jira-grouped-board.md` against its spec and the code

**Verdict: APPROVE WITH FIXES.** Three Important findings, none Critical. The plan covers every spec section and every §9 case, its copy and look values
match the spec byte for byte, every path and symbol it names was checked against the tree, and every Consumed name is Produced earlier with the same
spelling. The fixes are about three things an implementer would otherwise trip on: a test render the plan's prop change breaks but the plan does not name,
an indent assertion jsdom cannot make from a stylesheet, and a verification claim in Task 6 that is false.

Reviewed at `5cb6296` on `feat/jira-grouped-board`. Reviewer: Fable 5.1, fresh session, paths and checklist only.

## 1. Coverage — spec section → task

| spec | task(s) | §9 case → task |
| --- | --- | --- |
| §3 the fold (`foldBoard`, cycles, four "on the board" cases, column, sort) | T1; the board's use in T3 | depth 1/2/3, parent off board, Done-window parent, query hit, self-parent, two-cycle, cycle child, `sortTops`, progress, wording → T1 (plan 150–181) |
| §4 the card (fold block, bar, caption, no subtasks marker), column pill, band `M cards`, loading band | T2 primitives, T3 board | tops only, column counts, band line, loading band, nothing-folds band → T3 (238–255) |
| §5 F1 (ring, `match` marker, `1 match: KEY` / `N matches`, options from every issue, nothing ringed idle) | T4 | ringed top, `1 match: KEY`, self-match no ring, Sub-task offered, `N matches` → T4 (278–285) |
| §6 the modal (Children head, bar, tree, each key once, snapshot prop, row swap, no context, absent child) | T1 `modalTree`, T2, T5 | indent, swap leaves one dialog, absent child counts once, no `childrenOf`, reparent once → T5 (312–329) |
| §7 what does not change | Global Constraints line 1 (48) | — |
| §8 goals / anti-goals | Global Constraints 50–52 | — |
| §10 docs | T6 | — |
| §4 phase-5 note (live strip, `Run ▾`) | deliberately none (367) — correct, the spec says "not built here" | — |

Review Focus 1–5 each have a case: RF1 → T1 cycle cases + T3 two-cycle board (255); RF2 → T4 `ledger` (279–280); RF3 → T3 Done column empty (247–248);
RF4 → T5 (327–328); RF5 → T4 band unchanged (283). No spec section and no §9 case is without a task.

## 2. Values — plan against spec

Checked one by one: `C children · D below them` / `C children` / `1 child` (plan 53, spec 57); `2 done · 4 in progress · 3 to do`, zeros omitted (53, spec
60); `1 match: PAY-162`, `N matches` with keys in `title` (54, spec 79–80); `Children`, direct-children pill, `N in all` (54, spec 87); `M cards` as its own
` · ` part after the sources (55, spec 63–68); 4 px bar, `--fill-progress` / `--fill-live` / `--ink3`, 2 px gaps, 12 px `--ink3` caption (56–57, spec 59–60
and 143); 2 px `--amber-solid` inset ring, `--amber-text` marker (57, spec 77–78); 22 px per level (58, spec 90). The T3 fixture arithmetic was re-derived:
7 issues, tops PAY-120/180/190 → `2 · 1 · 0`, PAY-120 `2 children · 2 below them`, `2 done · 1 in progress · 1 to do`, `under[PAY-120]` in `sortForBoard`
order `[162, 161, 160, 170]` so the Sub-task title is `PAY-162, PAY-161`, `childrenOf[PAY-160]` = `[162, 161]`, To Do order PAY-120 before PAY-180 through
PAY-162's 0 d — all as the plan states. The band's `polled 10m ago` holds because the `/issues` mock returns the board's own `polledAt`
(`test/jira-board.test.tsx:165`), 630 s old (`:120`). All match.

## 3. Reality — paths and names

Every Modify path exists; `client/src/components/ui/SpreadBar.tsx`, `JiraTypeIcon.tsx` and `test/ui-spread-bar.test.tsx` do not (Create). Existing symbols
the plan leans on, verified: `sortForBoard` (`client/src/lib/jira.ts:75`), `columnOf` (:66), `cardAgeStamp` (:94), `crumbOf`/`crumbText` (:116/:127),
`initialsOf` (:138), the `count` helper's noun union `'root' | 'query' | 'issue'` (:150), `bandSub(board, site, now)` (:183), `boardFilterOptions` (:335),
`matchesBoardFilters` (:375), `subtasksMarker` (:385, read only by `JiraCard.tsx:1,44` — not by `test/jira-lib.test.ts`, so R11's delete breaks no
suite); `Marker({ children, tone, title })` with `MarkerTone` lacking `match` (`Marker.tsx:3,18`); `Pill` default tone `neutral` (`Pill.tsx:19`); the private
`TypeIcon` (`JiraCard.tsx:114`); `.jira-card-type svg` (`styles.css:627`); `.jira-modal-subtasks/-subkey/-substatus` (:1232–1234); the `/* ── ui primitives`
block header and `/* ── end ui primitives` footer (:2682, :3176); guard 7's `FAMILIES` (`test/design-guards.test.ts:322–341`); the `ago` helper
(`test/jira-lib.test.ts:48`) and `daysAgoStamp` (`test/helpers/dates.ts:33`); the one direct `bandSub` call in `jira-board` (`:259`); `PAY_131.parent` =
PAY-120 (`:64`), which is why T3's fixture change is needed; `JiraView`'s `setOpenIssue` slot (`JiraView.tsx:42,53–54`); the modal's `[issue.key]` effect
(`JiraIssueModal.tsx:92`), which is what lets the row swap refetch without a remount. The spec's own line refs (`JiraBoardView.tsx:81`,
`JiraIssueModal.tsx:154`, `JiraView.tsx:54`) are current. The suites T2–T6 run all exist (`dialog-escape`, `ui-modal`, `daylight-contrast`,
`claude-rules`, `design-guards`, `fixture-clock`).

## 4. Interfaces and 5. Order

T3 consumes `foldBoard`, `sortTops`, `cardFold`, `JiraFold`, `JiraChildrenIndex`, `bandSub`'s fold (T1) and `SpreadBar`, `JiraTypeIcon` (T2) — all
Produced with the same spelling. T4 consumes `foldMatches`, `matchMarker` (T1) and the `match` tone (T2). T5 consumes `modalTree`, `progressLine` (T1),
the two primitives (T2) and `onOpenIssue(issue, childrenOf)` (T3). The two claims about TypeScript assignability hold: T3's "`JiraView` compiles unchanged"
(a one-parameter `Dispatch<SetStateAction<JiraIssue | null>>` is assignable to the two-parameter callback), and T5's one setter typed
`(issue, childrenOf: JiraChildrenIndex | null) => void` serving both the board's non-null and the modal's nullable signature (parameter contravariance).
No task depends on a later one; the branch and the carried `090ede5` are as stated (`git log`).

## 6. Tests and 7. Conventions

Each task's red step is genuine: T1's names are not exported; T2's files do not exist and guard 7 fails on `indexOf('\n.ui-spread {') === -1`; T3's GROUP
list draws seven cards under the flat board; T4's `.jira-card-match` is drawn by nothing; T5's `Children` heading does not exist. The cases pin behaviour
(rendered text, roles, call arguments), not structure, with one exception recorded as I2. The plan keeps its own conventions: no literal code anywhere,
header citations named per component (31–33), size budgets soft (29), rules files named for a hand read (34–37), 160-column prose.

## Findings

### Important

- **[I1] plan:312 — Task 5 makes `childrenOf` and `onOpenIssue` required props of `JiraIssueModal` (301–302) and says `mount` gains them, but
  `test/jira-modal.test.tsx:242–246` renders `<JiraIssueModal issue={other} onClose={() => {}} />` directly, bypassing `mount`.** The repo runs
  `preset: 'ts-jest'` with diagnostics on (`jest.config.ts:4`), so a missing required prop is a compile error that fails the whole suite — Step 2's FAIL is
  then a type error, not the behavioural red the plan intends, and Step 4 cannot go green until the implementer finds this render on their own.
  → Name that rerender in Step 1 ("the late-answer case's `rerender` passes `childrenOf={null}` and the same `onOpenIssue`"), or route it through `mount`'s
  returned `rerender` with the same defaults.

- **[I2] plan:318 (and R10, plan:83) — "the depth-1 rows indented 22 px" is asserted in a jsdom suite, but jest never loads `client/src/styles.css`, so an
  indent declared in the stylesheet (`.jira-tree li[data-depth="1"] { padding-left: 22px }`, the reading R10 invites by putting the indent beside
  `data-depth`) is invisible to the test.** The implementer must guess between an inline style and a stylesheet rule, and only one of them can pass the
  case as written. → State the mechanism: the `li` carries the indent inline (`style={{ paddingLeft: depth * 22 }}`, or a `--depth` custom property the
  stylesheet multiplies), and the case asserts that inline value; or drop "22 px" from the jsdom case and pin the pixel in a style-source guard the way
  `test/run-track-style.test.ts` does.

- **[I3] plan:357–358 — "`pnpm run test:jest -- test/claude-rules.test.ts test/design-guards.test.ts` — PASS (they read these files)" is false.**
  `design-guards` reads `styles.css`, `theme.css`, `main.tsx` and `package.json` (`test/design-guards.test.ts:29–30,286–287`); `claude-rules` reads
  `CLAUDE.md`, `.claude/rules/*.md` and `invariants.md`. Neither opens `.claude/DESIGN.md` or `docs/subsystems/jira.md`, and no suite in `test/` does
  (`grep -l DESIGN.md test/*` hits only comments). Task 6 therefore has no automated check at all, while the plan says it has two. → Replace the
  parenthetical with the truth — the Step 2 grep is the only guard for the prose, and the two suites are run because T6 may touch `SpreadBar.tsx`'s header
  (340–341) — or drop the suites from Step 2 and keep the grep.

### Minor

- **plan:206 — "never bare `--amber` (design-guards forbids it)".** The guard is `test/daylight-contrast.test.ts:393` ("client/src/styles.css reads bare
  var(--amber) nowhere"), not design-guards. Harmless, since Task 2 Step 4 runs `daylight-contrast` anyway; fix the name.
- **plan:119 vs 138–140 — `cardFold`'s `line: string; caption: string` are built from `childrenLine` and `progressLine`, both typed `string | null`.**
  They are non-null whenever `under` has an entry (an issue under the top implies a direct child, and one issue implies a non-zero bucket), but the plan
  should say so in one clause so the implementer narrows for a stated reason rather than with a bare `!` or `?? ''`.
- **plan:70–71 (R4) — "`SpreadBar` draws `.ui-spread…`".** Guard 7 requires the bare rule `\n.ui-spread {` inside the block and exactly one declaration
  (`test/design-guards.test.ts:364–366`), so the ROOT element's class must be exactly `ui-spread`; `ui-spread-bar` as the root would fail the family check.
  One word ("root class `ui-spread`") removes the guess.
- **plan:323 — "board list = Task 3's `GROUP` shape".** `GROUP` is a fixture inside `test/jira-board.test.tsx`; suites do not share fixtures, so it must be
  rebuilt in `jira-modal.test.tsx` (or moved to `test/helpers/`). Say which, or the second copy drifts from the first.
- **plan:192 — Task 2's `Marker.tsx` change says the header "says what the tone is for", but `Marker.tsx:14–16` also says "no marker passes [`title`]
  today".** Task 4 passes one (274). Add the sentence to T2's or T4's header edit so the comment does not go stale in the same PR that falsifies it.
- **plan:232–233 — between Task 3's commit and Task 4's, a filter that matches only a folded issue hides its top** (the tops are "filtered as today, per
  top"), a regression against the flat board that the next commit repairs. Fine inside one PR; worth a clause in T3's commit body so a bisect does not
  read it as a bug.
- **plan:111–124 — `under`/`childrenOf` typed `ReadonlyMap`** where spec §3 writes `Map`. A deliberate tightening, and a good one; note it as a ruling
  so the spec/plan diff is not mistaken for drift.

## What was checked and found sound (so the next review need not repeat it)

- The cycle algorithm (127–131) matches spec §3's definition in all three cases, including a chain hanging off a cycle member (`D → C → A ⇄ B` folds D
  under A), and the memo per key keeps it linear without changing the answer.
- R3's "the list has loaded" (68–69) is exactly `JiraBoardView.tsx:142–146`'s column condition, so band and columns cannot disagree.
- The row swap never mounts a second `Modal`: `JiraView.tsx:54` renders one conditional `JiraIssueModal`, and the modal refetches on `[issue.key]`
  (`JiraIssueModal.tsx:75–92`) with `setHeld(null)`, so `useDialogEscape`'s count and `test/ui-modal.test.tsx:97–102`'s composer list are untouched.
- `test/jira-sections.test.tsx:39–41` stubs `JiraBoardView` and `test/jira-setup.test.tsx` mounts `JiraView` through its unchanged one-prop signature, so
  no suite outside the three the plan names is reached by the prop changes.
- No fixture date in the plan is a literal; `resolved` is outside `fixture-clock`'s four keys, and the plan still derives it from `daysAgoStamp`.
