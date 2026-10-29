# Review 1 — PRs layouts implementation plan

- Document: `docs/superpowers/plans/2026-10-29-prs-layouts.md` (315 lines, commit `f1789e5`)
- Spec: `docs/superpowers/specs/2026-10-29-prs-layouts-design.md` (229 lines)
- Reviewer: Fable 5.1, fresh subagent, worktree `.claude/worktrees/prs-layouts` on `feat/prs-layouts` (differs from `main` only in the three docs, so
  CodeGraph's main-checkout index is accurate for every code claim below)
- Rules read: `CLAUDE.md`, `.claude/rules/board.md` (`client/src/**`), `.claude/rules/tests.md` (`test/**`, `.claude/rules/**`)

## Verdict: APPROVE WITH FIXES

One Critical (a Quiet PR's run warning is lost in Inbox — an anti-goal), two Important (per-item test ids the view cases need are never named; Task 3's
write assertion has no fetch stub), and a list of Minor wording and pointer fixes. Coverage, copy strings, file reality, interfaces and task order all check
out; the test design pins behaviour with discriminating fixtures. Fix the three and the plan is executable as written.

## Checklist

| # | Item | Result |
|---|------|--------|
| 1 | Coverage — every spec section and test case has a task | PASS. Reach/level/rank/layout key/compact keys/matrix cells → Task 1 (plan:55–111); actions + outcome line → Task 3 (149–176); Inbox + notes → Task 4 (178–207); Matrix → Task 5 (209–233); Cards + view + switcher + hidden note + Access group → Tasks 6–7 (235–292); docs → Task 8 (294–306); the five "only mount" texts → Task 9 (308–315). Spec:199–216's cases map one-to-one (see §Tests below). |
| 2 | Values — copy strings match the spec | PASS. Checked every quoted string in Tasks 1, 4, 5, 6, 7 against spec:59–108, 110–143, 168–190: `Checks are failing.`, `Conflicts with <base>.`, `Changes were requested.`, `Behind its base.`, `Waiting for a review.`, `Checks are still running.`, `GitHub is still working out whether it can merge.`, `GitHub reports it blocked.`/`unstable.`, `Approved.`, `Checks are passing.`, `No pull request at this level.`, `no open pull requests`, `no repo this token can read`, `no GitHub repo registered`, `<n> repo(s) hidden — no access`, `Can't read`, `Access`, `checks failing`, the `backlog-manager.prs-layout` key and the `inbox`/`matrix`/`cards` values all agree. |
| 3 | Reality — Modify paths exist, Create paths don't | PASS. All Create targets missing (`client/src/lib/pr-layouts.ts`, `components/github/PrActions.tsx`, `PrOutcomeLine.tsx`, `PrInbox.tsx`, `PrRepoNotes.tsx`, `pr-layout-props.ts`, `PrMatrix.tsx`, `PrCards.tsx`, `GithubAccessGroup.tsx`, `test/pr-layouts-lib.test.ts`, `test/prs-actions.test.tsx`, `test/prs-inbox.test.tsx`, `test/prs-matrix.test.tsx`); all Modify targets exist (`PrRow.tsx`, `PullRequestsView.tsx`, `GithubSettingsView.tsx`, `App.tsx`, `styles.css`, `shared/types.ts`, `usePullRequests.ts`, `test/prs-view.test.tsx`, `test/github-settings.test.tsx`, `test/source-sections.test.tsx`, `.claude/rules/board.md`, `docs/subsystems/board.md`, `docs/subsystems/invariants.md`, `.claude/DESIGN.md`, `CLAUDE.md`). Symbols the plan consumes exist at the cited spots: `prChips` `lib/prs.ts:26`, `mergeBlock` `:46`, `updateBlock` `:60`, `autoMergeBlock` `:71`, `defaultMethod` `:78`, `isUpdating` `:90`, `groupRepos` `:102`, `outcomeLine` `:110`; `prRunWarning`/`PrRunContext` `lib/pr-run.ts:34`/`:23`; `PrOutcome` `PrRow.tsx:13`; `usePersistedState`, `useNarrow`, `Segmented`, `Dot`, `Ledger`, `Chip`, `Confirm`, `SettingsGroup`/`SettingsRow` (`ui/SettingsRow.tsx:76`/`:40`); `onOpenGithubPage` `App.tsx:284`; `PullRequestsView` mount `App.tsx:373`. |
| 4 | Interfaces — Consumes match an earlier Produces | PASS. `PrLayoutProps` (Task 4) is consumed by Tasks 5 and 6 with the same field names; `PrActions`'s `variant`/`onWrite`/`busy`/`disabledReason` spelling is the same in Tasks 3, 4, 5, 6; `rankPrs`/`levelCounts`/`transientFailures`/`departedOutcomes`/`compactKeys`/`matrixCells`/`columnCounts`/`LEVEL_DOT` from Task 1 are consumed with the same names and types. One note: the plan says `PrRunContext` comes from Task 1's Consumes; it lives in `lib/pr-run.ts:23`, not `lib/prs.ts` — no behavioural effect, the import path is just the implementer's lookup. |
| 5 | Order — each task's inputs exist when it runs | PASS. lib → actions → Inbox (needs lib + actions) → Matrix → Cards/view → Settings → docs → only-mount texts. Task 6 modifies `test/prs-view.test.tsx` to pin `cards` BEFORE adding Inbox/Matrix cases (plan:254–255), so the existing suite never goes red for the wrong reason. |
| 6 | Tests — fail first, pin behaviour, Review Focus covered, fixtures discriminate | PASS with the Important findings below. Every task has a Step 1 failing test then Step 3 implement. Review Focus 1 (no-access hidden, then reappears) → Task 6 (plan:258–260) + Task 1 reach cases; RF2 (same `#n` in two repos) → Tasks 4 and 5 (`a/x#7` / `a/y#7`); RF3 (filter kept when its level empties) → Task 4 (plan:201); RF4 (confirm survives a poll re-render) → Task 4 (plan:202–203); RF5 (narrow + stored `matrix` → Inbox, storage untouched) → Task 1 (`drawableLayout`) and Task 6 (plan:256–257). Fixtures carry ≥2 keys for every per-key derivation (`columnCounts` over three rows, `rankPrs` with ties on level, severity and `updatedAt`, two `#7`s). |
| 7 | Plan's own conventions — behaviour and test cases, not code; soft size budget | PASS. No literal code blocks; signatures and expected values only. Plan:36–39 copies exact strings as the spec told it to. No size budget stated, so nothing to mark soft. |

## Findings

### Critical

**[C] plan:194–196 — Inbox's quiet line drops a Quiet PR's run-in-progress warning.** The quiet line carries only `quietFacts(pr)`, which is `prChips(pr)`
labels (plan:76; `client/src/lib/prs.ts:26` — draft / checks / review / mergeable / auto-merge chips, no warning). The run warning enters the plan's data
model only through `prProblems(pr, warning)` (plan:71–74), which the quiet line never calls; Matrix gets it through its sub-line (plan:222) and Cards
through `PrRow.tsx:110`'s warn `Pill`. So the very case the warning was built for — an orchestrator `backlog/<id>` or `backlog/run-*` PR
(`client/src/lib/pr-run.ts:34` matches those heads) that is clean and approved, hence **Quiet** by spec:67–71 — shows no warning in the default layout. That
is spec:41–42's first anti-goal ("a layout that loses ... the run-in-progress warning", "failure even if it works") and spec:149 ("every layout carries ...
the run warning"). The spec's own Inbox paragraph (spec:117–118) lists the quiet line's anatomy without the warning, so the plan inherited the gap rather
than invented it — but the plan is where it must be closed. → In Task 4's Behaviour line, draw `prRunWarning(...)`'s text on the quiet line when non-null
(a warn `Pill` or an extra fact before `quietFacts`, the builder's pick), and add a Step 1 case: a clean, approved PR whose head is `backlog/42` with a
`PrRunContext` holding a running run → the quiet line's text contains `run in progress on this machine`. Also fold the same assertion into Task 6's
"survives a layout switch" family (plan:261) so the three-layout parity is pinned once.

### Important

**[I] plan:199–205, 227–231, 255–261 — no per-item test id for Inbox items, quiet lines or Matrix rows.** Task 4's cases locate "the behind item", "the
quiet line", "two repos each with `#7`", and "an outcome ... under that item"; Task 5's locate "a row", "the first's expansion", "`a/x#7` and `a/y#7`"; Task
6's locate "`futin/z` appears in no layout". The only item id the plan names is `pr-row-<key>` and that is Cards' (`client/src/components/github/PrRow.tsx:91`,
kept by Task 6's `PrCards`). Without a stated id the implementer picks one per file, and Task 8's Step 1 (plan:304, "every component name and test id they
mention must exist") has nothing to grep for. Text-only lookup is not enough once two `#7`s are on the page (Review Focus 2). → In Task 4's and Task 5's
Interfaces, name the ids (e.g. `pr-item-<key>` on an Inbox item and quiet line, `pr-mrow-<key>` on a Matrix row, `pr-expand-<key>` on an expansion) and
say each test case uses them; mention them in the Task 8 docs edit so the grep has targets.

**[I] plan:169–171 — Task 3 asserts a POST was sent once but names no fetch stub.** "clicking it sends `/api/prs/update-branch` once" and "no POST is made
until `Confirm` is accepted" can only be asserted against a `global.fetch` stub, and `PrActions` is rendered "directly with a `jest.fn` `onWrite`" — so
either `onWrite` is the thing asserted (then the URL is not observable; the write functions `mergePr`/`setAutoMerge`/`updateBranch` live in
`client/src/lib/prs-api.ts:57–59` and are called by the page's `write`, `PullRequestsView.tsx:128–142`, not by the strip) or the component calls the api
itself (then it needs the stub). The plan's own Task 6 says the page keeps owning `write` (plan:243, spec:163–165). → State which: if `PrActions` only calls
`onWrite(kind, pr, repo, method)`, rewrite the two cases as "`onWrite` is called once with `kind: 'update'`" / "`onWrite` not called until `Confirm` is
accepted"; if it is meant to POST, say so and point at `test/prs-view.test.tsx:141`'s stub shape to copy.

### Minor

- plan:25 — commit trailer reads `Co-Authored-By: Claude Opus 5.5`; the session that executes this plan should use its own model's trailer (this review's
  is `Claude Fable 5.1`). Not blocking; attribution only.
- plan:194 and 221 — "`author ?? 'ghost' · head → base · age`" names no helper for `age`. The one age helper in the client is `pollAge`
  (`client/src/lib/tracker.ts:37`, `${n} s` under a minute, else `elapsedSince`), used by `PolledAge` (`PullRequestsView.tsx:33`). Say `pollAge(updatedAt, now)` or
  name a new one in Task 1 so the three layouts do not drift on format.
- plan:270 — Task 7 adds the Access group but leaves `GithubSettingsView.tsx`'s header comment ("One card, `Sync`") and band sub-line ("how often this machine
  asks GitHub about each repo") in place; both go stale. Add "rewrite the header comment and the band sub to cover both cards" to Task 7's Modify line.
- plan:300–302 — the 80-word cap (`test/claude-rules.test.ts:30–56`, `tierOneOffenders`) is measured by `tierOne`, which reads "from ## Invariants to the end
  of the file" (`test/claude-rules.test.ts:244`); CLAUDE.md's Layout bullet for `client/src/` sits above `## Invariants`, is 281 words today and is green. The
  parenthetical "check that bullet's kind first" is harmless but the cap simply does not bind here; drop the sentence or say "Layout bullets are outside
  `tierOne`".
- plan:197 — `Can't read` line renders `<repo> — <detail>`; `PrRepoView.detail` is nullable (`shared/types.ts:635–657`) and today's `RepoSheet` guards it
  (`PullRequestsView.tsx:222`). Say "`detail` when present, else the `access` word".
- plan:256–257 — "with `matchMedia` answering narrow": point at the stub already in the repo, `installMatchMedia` in `test/ui-use-narrow.test.tsx:14`, so the
  implementer does not write a second one (`useNarrow` reads `matchMedia('(max-width: 700px)')` and treats absence as wide, `client/src/hooks/useNarrow.ts`).
- plan:71–75 — `prProblems` on a draft is unspecified: a draft with failing checks is Quiet (spec:66–68) but the problem list would still start with
  `Checks are failing.`. Harmless for Inbox (quiet lines use `quietFacts`), but Matrix's sub-line (plan:222) calls `prProblems`; say whether a draft's
  list is the facts (consistent with the Matrix `failing` cell, plan:227) or empty.
- plan:247–251 — whether the layout switcher is drawn in the `no token` / `no repo this token can read` / `repos: []` states is not stated. The spec's Page
  section (spec:97–108) draws the toolbar only "while a shown repo exists"; add that clause to Task 6's Behaviour line.
- plan:294–306 — Task 8 should add `lib/pr-layouts.ts` to the `lib/` roster in `docs/subsystems/board.md:660` and `.claude/rules/board.md:145`'s derivation
  list, since both enumerate every derivation home and `test/claude-rules.test.ts` / docs readers rely on them.
- plan:63 — "Consumes: ... `PrRunContext` (`lib/prs.ts`)": it is exported from `client/src/lib/pr-run.ts:23`.

## Tests — spec case → plan case

| Spec case (spec:199–216) | Plan |
|---|---|
| reach per `access` value | Task 1 (plan:85) |
| level per driving fact; draft+failing Quiet; draft+review-required Quiet; armed+pending Quiet; behind+approved Worth a look | Task 1 (plan:86–89) |
| verdict/steps order; rank (level, severity, newest) | Task 1 (plan:90–92) |
| layout parse, drawable, switcher options | Task 1 (plan:93–95) |
| compact-key pick (behind/ready/failing) | Task 1 (plan:96–98) + Task 3 (plan:169–171) |
| Matrix cell tone (draft+failing red Checks, Quiet dot; blocked) | Task 1 (plan:99–100) + Task 5 (plan:227) |
| rate-limited repo keeps rows AND gets `Can't read` / muted row | Task 4 (plan:204), Task 5 (plan:231) |
| no-access absent from all three; `N open` excludes; note count + link | Task 6 (plan:258–260) |
| switch persists, survives reload | Task 6 (plan:255–256) |
| tile filter and clear | Task 4 (plan:200–201) |
| Matrix toggle by click and Enter; `#n` link does not toggle | Task 5 (plan:228–229) |
| `updating…` mark survives switch | Task 6 (plan:261) |
| empty states | Task 4 (plan:205), Task 6 (plan:260) |
| existing suite pins `cards`; write cases re-run from Inbox and Matrix | Task 6 (plan:254–255, 261–262) |
| Settings Access card: absent / exact list / no token value | Task 7 (plan:282–286) |

## Not verified

- `tierOne`'s scope was read from its test title (`test/claude-rules.test.ts:244`), not from `test/helpers/rule-tiers.ts` itself; the 281-word Layout bullet
  passing today is the corroboration.
- The dashboard's `drawableGitLayout` rule (`~/Documents/custom-projects/claude-agents-dashboard/client/src/lib/gitLayouts.ts:43`) was read once to confirm
  Review Focus 5's shape; the plan's `drawableLayout` matches it.
