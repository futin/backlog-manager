# Plan review 1 — `docs/superpowers/plans/2026-11-02-claude-md-floor.md`

Reviewer: Fable 5.1 (fresh subagent, paths + checklist only). Date: 2026-11-02.
Spec: `docs/superpowers/specs/2026-11-02-claude-md-floor-design.md`. Repo: the `claude-md-floor` worktree at `ccc98056`.

## Verdict: APPROVE WITH FIXES

The plan covers every spec section, its values match the spec, every file and line it cites exists where it says (checked: `test/helpers/rule-tiers.ts:4-9,124`,
`test/claude-rules.test.ts:323,340`, `test/dialog-count-docs.test.ts:76-78`, `agents/backlog-reviewer.md:129`, `scripts/test-all.mjs:33`,
`server/src/jira/env.util.ts:59`, `test/runs-view.test.tsx:2653,2679`, `docs/overview.md:16,30-33`, the eleven `.claude/rules/*.md` and their `paths:`, the
Invariants numbering #1/2/13/15/18/20/25/26/42/46/47/51/60/64/74-80/101/104-108, and `~/.claude/skills/preload-audit/tools/floor.mjs`). Only two suites read
`CLAUDE.md` as a file (`test/claude-rules.test.ts:31`, `test/dialog-count-docs.test.ts:24`), so the local run scope at plan:30 is right. Three Important gaps,
all in Task 1 and Task 3's test specification; none ships wrong behaviour on its own, but each would leave the implementer guessing or red.

## Important

### I1 — plan:48-49, 58-70: the existing `compareTiers` fixture is not in the edit list, and it asserts the key Task 1 removes

`test/claude-rules.test.ts:267-284` (`compareTiers names what is missing on either side and an anchor homed twice`) asserts `missingInClaude` in all three of its
`toEqual` calls. Task 1's Interfaces (plan:52-53) remove that key, so the case goes red the moment Step 3 lands, yet the Files block names only the cases at
`:323` and `:340`, Step 2 predicts that "the first three FAIL" (the fourth, existing one fails too), and Step 6 predicts PASS without any step that touches
`:267`. The "anchor-homed-twice (existing behaviour, kept)" bullet at plan:64 hints at a rewrite but never says the old case is replaced.

Fix: add `:267` to the Files block and make Step 1 explicit — rewrite that case to the new shape (drop every `missingInClaude` expectation; its third
subcase, `H1` vs `H1 `, becomes `missingInRules: ['X\tH1']` only). Then Step 2's prediction is "four fail".

### I2 — plan:68-70: the subset case does not say which tier-one bullets it passes, and the wrong choice makes the keep-list fail

Seven keep-list rules have no rule-file home and never will (#1, #18, #25, #42, #74, #76, #80 — confirmed: none of their headlines appears under
`.claude/rules/`; spec:68-81 marks them "no home"). They are unlinked bold-led bullets in `CLAUDE.md`. Task 1 introduces an unlinked key `-\t${headline}`
(plan:53-54) without saying whether it applies to tier one. If the implementer passes `tierOne(CLAUDE_MD).unlinked` alongside `.linked` — the natural reading
of "a bullet keys on …" — every one of those seven is reported as `missingInRules` and Task 3 Step 4 can never pass. Spec:140 is explicit: "every LINKED
`CLAUDE.md` headline appears byte-equal … tier one is a SUBSET of tier two", and the unlinked tier-one bullets are governed by the word cap alone.

Fix: state in the Interfaces block and in Step 4 that `one` is `tierOne(CLAUDE_MD).linked` only (as `test/claude-rules.test.ts:341` already does), and that the
`-\t${headline}` key exists so tier TWO's unlinked bullets can be caught multi-homed — it is never compared against tier one.

### I3 — plan:40 vs plan:119-122: Review Focus 4 promises "Task 3 fixtures" for the table guard, but Task 3 only fixtures the parser

Task 3 Step 1 fixtures `pathTableOf` (parsing one row and ignoring other tables) and then asserts the both-directions comparison on the real tree only. A
real-tree-only comparison is exactly the vacuous shape the suite's own header warns about (`test/claude-rules.test.ts:11-13`: a parser that produced nothing
"would match nothing against nothing and pass every guard"), and spec:148-149 asks that the fixtures proving each guard bites be "extend[ed] for the subset and
table assertions". The subset side has its fixtures (Task 1 Step 1); the table side has none — a comparison written as `expect(missing).toEqual([])` inline
over `RULES` cannot be shown to go red in either direction.

Fix: have Task 3 produce a pure `compareTable(table: Map<string, string[]>, rules: { name: string; paths: string[] }[]): { missingInTable: string[];
missingOnDisk: string[]; mismatched: string[] }` in `test/helpers/rule-tiers.ts` and fixture it with: a file only on disk, a file only in the table, and one
file whose globs differ in order or content (`['a/**', 'b.ts']` vs `['b.ts', 'a/**']` — order matters since the row is "in frontmatter order"). The real-tree
case then calls it, like the subset case calls `compareTiers`.

## Minor

- plan:29 — the `Co-Authored-By` line is hardcoded to "Claude Opus 5.5"; the executing session's attribution reminder names the model (this review's says
  Fable 5.1). Say "the attribution line the session's reminder gives" rather than a model name.
- plan:56 — `UNLINKED_WORD_CAP` moves to `rule-tiers.ts`; its four-line doc comment at `test/claude-rules.test.ts:42-46` (the "tests are flat" history) should
  move with it, or Task 1 Step 5 should say the comment stays beside the predicate.
- plan:99-100 — a Layout sentence that links an existing `invariants.md` anchor must land in the rule file that ALREADY homes that anchor (e.g. the `runGit`
  sentence → `items.md`, where #46's bullet is), or the kept one-home-per-anchor guard reports it. Worth one clause, since Step 5 says "fix the rule-file copy"
  as if drift were the only red.
- plan:115 vs spec:118 — the route list under the table differs (`Grep`, `Glob` vs "a subagent"). The spec is inconsistent with itself (spec:129 says a
  subagent's `Read` DOES load the rule file; spec:130 lists `Grep`, `Glob`); the plan's list is the correct one. Note the deliberate departure in the plan
  so a later reader does not "fix" it back.
- plan:116-117 — say where the `## Rule files` section ends for `pathTableOf` (the next `## ` heading), since `tierOne` uses the same convention and the two
  must agree about `## Invariants` being outside the table.
- plan:127 — "dialog-count passes until the delete": once the case is renamed and pointed at `.claude/rules/board.md` (which already holds the Escape headline,
  `board.md` confirmed), it passes before and after the delete. Only true if the rename is deferred to Step 3.
- plan:138 — `docs/overview.md:30-32` is the paragraph at `:30-33`.
- plan:79 — the audit record goes under `docs/superpowers/reviews/`, which holds review reports; a decision-log home under `docs/superpowers/` reads more
  naturally. Builder's call.
- plan:128-129 — `docs/overview.md` is docs-sync tracked (`docs/.docs-sync.yml:6-7`, kind `overview`). Moving ~6 KB of Layout prose into it may need the doc's
  baseline refreshed; a one-line note in Task 3 saves the next `/docs-sync` a false drift report.
- spec:186 ("confirmed in the context panel of a fresh session") and spec:166-167 (tell the user `~/.claude/skills/preload-audit/references/three-tier.md`
  now describes a stale layout) have no task. Both are hand-off notes, not code; add them to Task 5 so the run's final message carries them.
- plan:36 — Review Focus 1 is stated as "not by a test"; acceptable, since criterion (b) is a judgement over governed paths, and Task 2's row format pins
  the judgement in a reviewable record.
- plan:151-154 — the token-survival check is word-level, so a headline reworded during the move of an UNLINKED bullet (the five homeless + the Layout
  sentences) would pass it if its words survive elsewhere; the linked ones are already proven byte-equal by Task 2 Step 5 (CLAUDE.md untouched, subset
  guard green). Cheap extra evidence: in Task 5, `grep -F` each of the five homeless headlines against `.claude/rules/` and record the hit.

## Coverage map (spec → task)

| Spec section                              | Task                       |
| ----------------------------------------- | -------------------------- |
| Goals: ~11 KB, regrowth guard, lose no rule | 3 (budget), 1/3 (guards), 5 (survival) |
| Cross-cutting criterion, keep-list        | 2 (audit), 3 (Invariants)  |
| New homes for #26/75/78/79/101            | 2 Step 3 (unlinked, decided plan:31-32) |
| Fence audit, #13 widening, test-location  | 2 Steps 1-4                |
| `## Layout` trim, overview.md             | 3 Step 3                   |
| Path → rule-file table + read-before-edit | 3                          |
| `## Conventions`                          | 2 (audit), 3 Step 3        |
| `## Invariants` heading stays             | Global constraints plan:26 |
| CodeGraph/Write gap                       | 3 (sentence), 1 Step 5     |
| Guard tests: subset / table / budget / headline-home / kept | 1 / 3 / 3 / 1 / 1 Step 4 |
| `dialog-count-docs` moves to board.md     | 3 Step 1                   |
| Other surfaces (tests.md, invariants.md, overview.md, rule headers, test comments) | 4 |
| Done: survival, re-measure, CI            | 5                          |
| Done: context panel, three-tier.md mention | none (Minor above)        |
