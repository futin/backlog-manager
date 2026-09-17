---
id: task-42
title: Correct the surviving --magenta prose and pin the token's one reader with a source guard
created: 2026-09-17
from: ref-4
updated: 2026-09-17T21:22:00Z
started: 2026-09-17T20:38:27Z
execute-elapsed: 2613
execute-tokens: 90541
---

## Goal

Every statement this repo still makes about `--magenta` is true, and the failure `ref-4` was really about — someone reads "this token has no job", deletes it
from `shared/theme.css`, and silently unstyles the capture dispatch control in all five themes — becomes a red test rather than a thing a reader has to notice.

**The stylesheet comment `ref-4` was filed against is already fixed.** `ref-4` was captured on 2026-09-15 against `client/src/styles.css:678-683`, quoting a
comment that claimed `--magenta` had "no job on this screen" while four `.dispatch-tab.capture` / `.dispatch-chip.capture` rules read it. Since then `task-37`
collapsed those four rules into one (`.dispatch-word.capture`, the tone paints the word), `task-39` moved Archive onto `BoardColumn` and took the whole
`.board-col-tick` family with it, and the comment was rewritten in the same pass. As of 2026-09-17 `client/src/styles.css:785-793` reads "That leaves
`--magenta` with no **column** job at all — the capture dispatch control (`.dispatch-word.capture`) is now its one reader", which is correct, and
`.claude/DESIGN.md:233` (landed in `bc955c2`) records the same thing correctly and at length. **Do not rewrite either of those.** This task is only what
survived that fix, verified by grep on 2026-09-17.

## Plan

Line numbers below are as of 2026-09-17 and are hints only — anchor every edit on the quoted TEXT, because the redesign branch moves these files often.

### Step 0 — re-verify the premise before editing anything

The half of `ref-4` this task drops was resolved between the item being filed and being groomed, so assume the same can happen again. Run a repo-wide grep for
`magenta` across `client/src`, `shared`, `server/src`, `test`, `.claude`, `docs` and `scripts` (exclude `node_modules`, `client/dist`, `.git`, and `backlog/` —
`ref-4` and this file both QUOTE the false claim on purpose and must not be edited to satisfy a grep). Compare what you find against the four work items below.
If a step's target text is already gone, say so in `## Outcome` and skip it; do not invent replacement work. If a NEW occurrence has appeared, fix it the way
the nearest step here fixes its own.

The single source of truth for what is true, re-checked at execution time rather than trusted from this file:

- `var(--magenta)` has exactly **one** reader in application CSS: `client/src/styles.css:1322`, `.dispatch-word.capture { color: var(--magenta) }`.
- `shared/theme.css:55` additionally aliases it as `--pink` in the legacy-alias run of the default block. That alias has no reader anywhere in `client/src`; it
  is not a job, and this task does not remove it (an unused legacy alias is a separate question nobody has asked).
- `shared/theme.css` declares `--magenta` in all five theme blocks: lines 33, 65, 79, 92, 117.
- The sibling app's claim still holds: `claude-agents-dashboard/client/src/styles.css` reads `--magenta` for the Task-tool markers (`.act-line .act .tool.task`,
  `.act-full .tool.task`, `.cmsg-tool .tool.task`), the plan badge `.qpanel.plan .qp-badge`, and `.ag-pill.surface.dashboard`. So "its documented owner is
  another app" is TRUE and must survive every rewrite below — what was false was only the "so it has no job HERE" half.

### Step 1 — the live spec's Column ramp paragraph

`docs/superpowers/specs/2026-09-15-fe-redesign-design.md:154`, §2.2, currently ends:

> `--magenta` loses its only job on this screen and stays in the palette for the app that shares it.

This is the sentence that fathered the whole chain, and the spec is still the live reference for the unfinished half of the redesign, so it gets a real rewrite
rather than a footnote. Replace that sentence with one that says the column ramp takes `--magenta`'s **column** job and names what it keeps: the capture
dispatch control's tone (`.dispatch-word.capture`), which is now the token's one reader in this app — and that it is additionally the Task-subagent marker in
`claude-agents-dashboard`, which is why it stays in every palette. Keep the rest of the paragraph (the four ramp assignments, "replacing today's
magenta/mustard/red/cyan ticks") exactly as it is: that half is accurate and has landed.

Match the surrounding prose — full sentences, the spec's own voice, no bullet list bolted onto a paragraph.

### Step 2 — the executed plan file gets a correction note, not a rewrite

`docs/superpowers/plans/2026-09-15-fe-redesign-task0-design-md.md:142` instructs, inside Step 3's "Required content" run-on:

> and that `--magenta` keeps no job on this screen;

That plan has been executed — `.claude/DESIGN.md` §8.2 exists and already contradicts this line. A plan under `docs/superpowers/plans/` is the record of what
was ASKED, so do not rewrite the instruction: a future reader comparing the plan to `bc955c2` would then find no trace of why §8.2 says something the plan
never asked for. Instead append one short dated note immediately under that step's paragraph, in the plan's own voice, saying: the claim was false when written
(`.dispatch-tab.capture` / `.dispatch-chip.capture` read the token at the time), the whole-branch review caught it by counting uses in source, and the shipped
§8.2 records the capture control's tone instead — see `ref-4`. Cite `ref-4` and `task-42` so the chain is walkable from either end.

If, at execution time, the surrounding file makes a correction note read worse than a struck-through phrase would, prefer the note anyway and explain the call
in `## Outcome`. The rule being protected is "do not falsify the record of what was instructed", not the exact shape of the annotation.

### Step 3 — `shared/theme.css` says what the token is for HERE

`shared/theme.css:33` is `--magenta:#cf6f9e;` with the trailing comment `/* Task subagent / kaizen */`. That comment is accurate about the sibling app and says
nothing about this one, which is precisely the reading that makes deleting the token look safe from inside this repo. Give the declaration this app's own job
too: the capture dispatch control's tone (`.dispatch-word.capture`), kept in all five palettes, plus the existing sibling-app owner.

Two constraints on how:

- The other token comments on lines 28-34 are single-line trailing comments in a hand-aligned column. A trailing comment cannot carry two clauses without
  breaking that column, so put the explanation in a short block comment ABOVE the accent run or immediately above `--magenta`, in the style of the `--on-fill`
  block further down the same file (lines 40-47), and leave the trailing comments themselves aligned as they are.
- `test/design-guards.test.ts` blanks comments before parsing, so prose here cannot break a guard — but check the file's own warning about `--mono` before
  assuming that of any guard you add in Step 4.

### Step 4 — the guard that makes deletion red

Add one new guard to `test/design-guards.test.ts`, as `guard 8`, using that file's existing `rules()` / `stripComments()` / `themeBlocks` helpers rather than
new parsing. Two assertions:

1. **The reader exists.** In `client/src/styles.css`, a rule whose selector is exactly `.dispatch-word.capture` declares `color: var(--magenta)`. Assert the
   rule's presence and its declared value — not a count of `var(--magenta)` occurrences in the sheet, which would go red the day someone legitimately adds a
   second use. The point is that the token is not orphaned, not that it is used exactly once.
2. **The token is declared in every theme block.** All five `themeBlocks` declare `--magenta`, and the failure message names which block is missing it. Guard 5
   already pins `--magenta: #6b52a8` in the daylight block alone, so four of the five are unguarded today; this closes them for the same reason guard 5's
   fill-token case gives — a token declared in four blocks out of five resolves to nothing in the fifth and paints whatever was inherited.

Then fix the file's own header docblock, which currently ends "Spec §9 heads this list 'six source guards' and then lists seven ... all seven are implemented
here." Guard 8 does not come from spec §9 — say so in one sentence naming `ref-4` as where it came from, and leave the existing seven-versus-six note intact.

Write both assertions test-first and prove each one red before the source is touched (see `## Test cases` for the exact mutations).

### Not a runner fix

This task touches `client/src/styles.css` comments, `shared/theme.css` comments, two docs and one test file — none of `backlog-orchestrate`'s SKILL.md, its
CLI, `agents/backlog-reviewer.md` or `server/src/agents/`. No `runner-fix:` key, deliberately.

### Assumptions this plan made without asking

`AskUserQuestion` was not available in the grooming session, so these four calls were made rather than parked. Any of them is cheap for a reviewer to overturn:

- **A1** — `ref-4` is still worth doing even though its headline defect self-resolved; the residual is the four steps above.
- **A2** — the live spec is rewritten (Step 1) but the executed plan is only annotated (Step 2), because the two documents have different jobs.
- **A3** — a test guard is in scope even though `ref-4`'s Rough shape said "comment fix", because a test is not a rule change and the hazard `ref-4` names is a
  deletion no comment can stop.
- **A4** — the new guard lives in `test/design-guards.test.ts` rather than a new file, since that file is already the one home for source-text guards over these
  two stylesheets.

## Test cases

Run from the repo root. The first three are the red-proofs; every mutation is reverted immediately, and the final state of the tree must contain none of them.

1. **Guard 8, assertion 1, the value case.** With guard 8 in place, change `.dispatch-word.capture`'s declared value from `var(--magenta)` to `var(--cyan)` and
   run `pnpm run test:jest -- test/design-guards.test.ts`. Expect guard 8's first case to FAIL, and the failure text to name `.dispatch-word.capture`. Revert,
   re-run, expect green.
2. **Guard 8, assertion 1, the deletion case.** Delete the whole `.dispatch-word.capture` rule from `client/src/styles.css` and re-run the same file. Expect a
   failure that says the rule is absent rather than a crash or an undefined-property error. Revert, re-run, expect green.
3. **Guard 8, assertion 2, a missing block.** Delete `--magenta` from the `graphite` theme block in `shared/theme.css` (leave the other four) and re-run. Expect
   guard 8's second case to FAIL and the message to name `graphite` specifically — a bare `expect(count).toBe(5)` that does not name the block fails this test
   case.  Revert, re-run, expect green.
4. **Guard 5 still passes untouched.** `pnpm run test:jest -- test/design-guards.test.ts` is green as a whole, with guard 5's daylight table unmodified — the
   new guard must not have been made to pass by editing `--magenta: #6b52a8` out of `DAYLIGHT`.
5. **The comment prose does not break the parser.** After Step 3's block comment lands in `shared/theme.css`, guards 1, 2, 5 and 8 are all still green. This is
   the specific trap the file's header warns about with `--mono`: a guard that read raw text instead of `stripComments()` output would go red on the new prose
   alone.
6. **No false claim survives outside `backlog/`.** `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -i 'magenta' client/src shared
   server/src test .claude docs scripts` returns zero lines asserting the token has no job / no use / loses its only job on this screen. `backlog/` is excluded
   because `ref-4` and `task-42` quote the false claim as evidence.
7. **Both runners.** `pnpm test` exits `0` — jest and `node --test` both, per the union rule in `CLAUDE.md`.
8. **Types.** `pnpm run typecheck` exits `0`.
9. **No browser case, deliberately.** Nothing rendered changes: Steps 1-3 edit comments and prose only, Step 4 adds a source-text test. There is no
   `In the browser (playwright MCP tools):` check here, and a headless session should not invent one — reaching the capture chip would need `BM_AGENTS` on and
   an out-of-scope item on the board, to observe a colour no edit in this task touches. If you find yourself needing a browser to prove one of these steps, the
   step has grown past its scope: stop and say so in `## Outcome`.

## Done when

- `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §2.2 names `.dispatch-word.capture` as `--magenta`'s remaining job in this app and the sibling app's
  Task-subagent marker as why it stays in every palette, with the four ramp assignments unchanged.
- `docs/superpowers/plans/2026-09-15-fe-redesign-task0-design-md.md` carries a dated correction note under Step 3 citing `ref-4` and `task-42`, with the
  original instruction text intact.
- `shared/theme.css`'s `--magenta` declaration states both jobs — this app's capture dispatch control and the sibling app's Task-subagent marker — without
  disturbing the aligned trailing-comment column on the accent run.
- `test/design-guards.test.ts` has a guard 8 with both assertions, each proved red by test cases 1-3, and a header docblock that says guard 8 is not from
  spec §9 and names `ref-4`.
- `client/src/styles.css:785-793` and `.claude/DESIGN.md` §8.2 are byte-for-byte unchanged — they were already right.
- `pnpm test` and `pnpm run typecheck` both exit `0`, and the working tree holds none of the red-proof mutations.

## Outcome

2026-09-17 — done. Step 0's grep re-confirmed the premise exactly as the plan states it: `.dispatch-word.capture` (`client/src/styles.css:1322`) is this app's one
reader of `var(--magenta)`, all five theme blocks declare the token, and the only false prose left outside `backlog/` was the spec sentence (Step 1) and the
executed plan's clause (Step 2). Nothing new had appeared, and no step's target text was gone, so all four steps were executed as written.

- **Step 1** — `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §2.2: the sentence "`--magenta` loses its only job on this screen and stays in the
  palette for the app that shares it" is replaced by three clauses saying the ramp takes the token's **column** job, that `.dispatch-word.capture` is the job it
  keeps and this app's only reader, and that the palette-wide declaration is for that as much as for the sibling app's Task-subagent marker. The four ramp
  assignments in the same paragraph are byte-for-byte unchanged.
- **Step 2** — `docs/superpowers/plans/2026-09-15-fe-redesign-task0-design-md.md`: the original Step 3 instruction is untouched; a dated correction note sits
  immediately under the paragraph, citing `ref-4` and `task-42`, naming the four rules that read the token when the clause was written and what §8.2 shipped
  instead. The note shape was preferable here as the plan predicted — the clause is buried mid-run-on, so a strike-through inside it would have been unreadable
  and would also have altered the record of what was asked.
- **Step 3** — `shared/theme.css`: a block comment above `--magenta` states this app's job (the capture dispatch control's tone, hence all five palettes) beside
  the sibling app's, and points at guard 8. The trailing-comment column on lines 28-34 is untouched; the `/* Task subagent / kaizen */` trailing comment stays
  exactly as it was.
- **Step 4** — `test/design-guards.test.ts`: `guard 8`, two `it`s, built on the existing `styleRules` / `themeBlocks` / `stripComments` helpers. The header
  docblock gains one paragraph saying guard 8 is not from spec §9 and names `ref-4`; the existing seven-versus-six note is intact.

Two deliberate calls worth a reviewer's eye. **New prose is wrapped at 160 columns** (the machine-wide convention for new text) even though the surrounding
comments in both files sit at ~75 — no existing comment was reflowed, per the same rule's "new text only" half. And **the plan file keeps its false clause on
purpose** (Step 2's whole point), so a grep for "keeps no job on this screen" still finds one line outside `backlog/`; the correction note two paragraphs below
it is what makes that line safe to read.

Verification. `pnpm test` and `pnpm run typecheck` could not be run through pnpm in this worktree for two environment reasons that predate this diff and are not
caused by it: the machine's pnpm is 11.13.0 against `package.json`'s `packageManager: pnpm@12.3.4` pin, which corepack refuses to switch (so every `pnpm`
invocation in this tree fails, `scripts/test-all.mjs`'s two children included), and the orchestrator worktree has no `node_modules`, which jest's
`moduleNameMapper` entry for `marked` resolves against `<rootDir>` and so fails 10 suites on resolution alone. Both runners were therefore invoked directly —
the same two commands `scripts/test-all.mjs` shells out to — with `node_modules` symlinked to the main tree's for the duration of the run and **removed again
afterwards**; `git status --short` below is the tree as this session leaves it.

```
$ npx jest --runInBand
Test Suites: 108 passed, 108 total
Tests:       1774 passed, 1774 total
Snapshots:   0 total
Time:        76.024 s, estimated 78 s
Ran all test suites.

$ node --test skills/*/tools/*.test.mjs scripts/*.test.mjs
tests 556
suites 0
pass 556
fail 0

$ npx tsc --noEmit
JEST_EXIT=0 TSC_EXIT=0 SKILLS_EXIT=0

$ git status --short
 M backlog/tasks/open/task-42-correct-the-surviving-magenta-prose-and-pin-the-token-s-one-reader-with-a-source-guard.md
 M docs/superpowers/plans/2026-09-15-fe-redesign-task0-design-md.md
 M docs/superpowers/specs/2026-09-15-fe-redesign-design.md
 M shared/theme.css
 M test/design-guards.test.ts
```

Test case 4 (guard 5's daylight table unmodified — `--magenta: '#6b52a8'` still in `DAYLIGHT`), case 5 (guards 1, 2, 5 and 8 green with the new `theme.css`
prose, which `stripComments()` blanks), case 6 (no line outside `backlog/` asserts the token has no job, the annotated plan clause excepted above), cases 7-8
(both runners, typecheck) all hold. Case 9's no-browser rule was followed: nothing rendered changes.

Contract sweep: none found
Red proof: 2 tests went red with the change reverted

The red proof ran the plan's three mutations, each reverted from a `/tmp` copy immediately (never `git stash`): `.dispatch-word.capture`'s value changed to
`var(--cyan)` gave assertion 1 red, the received string naming `.dispatch-word.capture { color: var(--cyan) }`; the whole rule deleted gave assertion 1 red with
`(no .dispatch-word.capture rule in client/src/styles.css)` rather than a crash; `--magenta` deleted from the graphite block gave assertion 2 red with
graphite's own selector in `missing`. The sweep found no site outside the diff still carrying an old form: `client/src/styles.css:785-793` and
`.claude/DESIGN.md` §8.2 were already correct and are byte-for-byte unchanged, and no doc states a guard COUNT that guard 8 would falsify — spec §9's "Six
source guards land with task 1" is a claim about task 1 and stays true, which the test file's header now says outright.

