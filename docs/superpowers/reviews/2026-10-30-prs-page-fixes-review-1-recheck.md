# Review 1 re-check — PRs page fixes implementation plan

- Plan: `docs/superpowers/plans/2026-10-30-prs-page-fixes.md` (only the hunks of `d7d6e040 → HEAD`)
- Spec: `docs/superpowers/specs/2026-10-30-prs-page-fixes-design.md`
- Date: 2026-10-30
- Verdict: **APPROVE WITH FIXES**

The revision closes I1 (the why-line now reads the blocks), I2's contradiction with Task 10, I4 (the kept inbox/matrix cases), I6 (spec 249 asserted) and
I7 (the page's write closes the Confirm, asserted in `prs-view`), and every Minor from round 1. Three things are still wrong. I3's compile gap is only half
closed: moving `PrKey` breaks `PrActions.tsx:103`. I5's test still cannot fail. The new `emptyRepoNote` rule goes further than the spec and gives a reason that
is false in one case. One more gap is next to the changed lines: Task 5's new required props break the typecheck that Tasks 5 and 6 say is green. No finding is
Critical, because Task 5 rewrites `PrActions` and the branch's end state compiles and behaves as the spec says.

## Important

### I1 — Task 2's `PrKey` move breaks `PrActions.tsx` from Task 2 to Task 5, and Tasks 3's "every suite keeps compiling" is false

Plan 100–101 moves `PrActions.tsx`'s `type PrKey` import to `../../lib/prs`. Plan 109 defines that `PrKey` as `(typeof PR_KEYS)[number]`, so it now
includes `'open'`. `client/src/components/github/PrActions.tsx:103` declares `const spec: Record<PrKey, { … }> = { merge, update, 'auto-merge' }` with no
`open` entry, so this is TS2741 under the strict root `tsconfig.json`. ts-jest type-checks every file it compiles (`jest.config.ts` preset, no
`isolatedModules`). So every suite that loads `PrActions` fails to compile from Task 2 until Task 5 rewrites the file: `prs-actions`, `prs-inbox`,
`prs-matrix` and `prs-view` (through `PrInbox` / `PrMatrix` / `PrRow`).

Plan 148–150 ("so every suite keeps compiling under ts-jest") and plan 188–189 ("every other suite still compiles, because `compactKeys` and `PrKey` are
still exported") therefore state something false. Narrowing the `Record` alone does not fix it. `compactKeys` returns `PrKey[]`
(`client/src/lib/pr-layouts.ts:253`), so `spec[key]` at `PrActions.tsx:119` would then index with `'open'`.

Fix: in Task 2, leave `pr-layouts.ts`'s three-member `PrKey` (`pr-layouts.ts:237`) and `PrActions.tsx:7`'s import alone. `compactKeys` keeps its own type,
and Task 5 deletes both together. Alternatively, give `compactKeys` and `PrActions:103` an explicit three-member type, such as `Exclude<PrKey, 'open'>`.
Then plan 100–101, 102–103 and 148–150 must say which option applies.

### I2 — `emptyRepoNote` is `null` in a case where the spec says the toolbar counts, and the plan's reason does not hold there

Plan 170–171 makes the note `null` "whenever `cardRepos(repos, outcomes)` is empty", because "the page says `no open pull requests` instead (spec 246)".
Task 9 draws `no open pull requests` only when `cardRepos` is empty AND `transientFailures(repos)` is empty (plan 415). The plan's reason therefore does not
hold when every repo is empty and one of them failed (one ok-empty repo plus one rate-limited repo with no rows). In that case Cards draws no card, no
`no open pull requests` and no count, so the ok-empty repo appears nowhere on the page. Spec 180–182 says such a repo "is not drawn, and the toolbar says how
many". Spec 246 removes the count only in the all-clean case, which is the case that draws `no open pull requests`.

Fix: return `null` when `cardRepos` is empty and `transientFailures(repos)` is empty, which is exactly when Task 9 draws `no open pull requests`. Add a
Task 3 case: one ok-empty repo plus one `rate-limited` repo with no rows → `1 repo with no open PRs`. If suppressing the count in the mixed case is
intended, record it as an author's call and correct the reason.

### I3 — The new rule changes what the unchanged `emptyRepoNote` cases need from their fixtures

Under plan 170, any fixture with no row-bearing repo returns `null`. Read literally, plan 182's "one empty ok repo → `1 repo with no open PRs`" and "two, one
of them sync-off → `2 repos with no open PRs`" now expect the wrong value. The negative cases at plan 183–184 (`polledAt` null, departed outcome,
`rate-limited`) become `null` whatever the count rule says, so they pass without testing anything. Only the new case at plan 184 says "and nothing else", and
the reader has to infer that the others need a repo with a row.

Fix: state at plan 182 that every `emptyRepoNote` case except the all-empty one also carries a repo with one row (the `a/x` of the `cardRepos` case), so
`cardRepos` is non-empty and the count rule is what each case tests.

### I4 — Review Focus 1's revised case still cannot fail

Plan 483–485 now targets the right window: the timer has fired, its re-read is pending, and the page unmounts. Its assertions still cannot tell a
`mountedRef`-guarded timer from one without a guard, and they pass on today's code too:

- After the await, the unguarded branch (plan 456–458) only calls `dropMark` and `setOutcomes`. Neither sends a request
  (`client/src/components/github/PullRequestsView.tsx:87–97`), so "no GET or POST is sent after the unmount" holds either way.
- React is `^18.3.1` (`package.json:36`). It has no "state update on an unmounted component" warning, and a state update on an unmounted fiber schedules
  nothing, so it triggers no `act` warning either. `console.error` stays silent either way.
- Under Task 4, `load` resolves `null` once the page is unmounted (plan 202–203; today's `client/src/hooks/usePullRequests.ts:34`). The "answer with a new
  head" never reaches the timer, so the case exercises the same-head branch whatever the stub answers.

Task 10 Step 2 (plan 490) says "the new cases fail". This one will be green before Task 10 is implemented.

Fix: call it what it is, a guard that the timer path makes no request after unmount and throws nothing, expected green before and after. Exclude it from
Step 2's "fail" claim, and stop claiming it proves "nothing is set on an unmounted component". The `mountedRef` guard is then a review item, not a tested
one. Drop the "new head" wording or note that `load` resolves `null` there.

### I5 — Task 5's required `PrLayoutProps` fields break `pnpm run typecheck` at Tasks 5 and 6, and Task 5's lists omit the fix

Plan 220 makes `confirming` and `setConfirming` required on `PrLayoutProps`. `test/prs-inbox.test.tsx:64–66` and `test/prs-matrix.test.tsx:64` each build a
`PrLayoutProps` object from `{ repos, outcomes, marks, now, ctx, write, inFlight, ...over }`, where `over` is `Partial<PrLayoutProps>`. With two new
required fields this is TS2322, and `pnpm run typecheck` (`tsc --noEmit` over `tsconfig.json`, whose `include` has `test/**/*`) covers those files.

Plan 281 (Task 5 Step 4: "`pnpm run typecheck`; both green") and plan 303 (Task 6 Step 2, changed this round: "`pnpm run typecheck`; green") cannot both
hold. Under ts-jest, `prs-inbox` and `prs-matrix` then fail to compile as whole suites, not only "on their compact-strip and full-strip cases" (plan 281–282).
Task 5's Files list and commit list, both edited this round, name neither test file.

Fix: in Task 5, give both helpers the defaults `confirming: null` and `setConfirming: jest.fn()`, and add the two files to Task 5's Files and `git add`. Or
make the two props optional, but the spec puts them in `PrLayoutProps` as page state.

## Minor

- Plan 435 vs plan 432–433: the Spec 249 case is a guard. Today's `PrCards` draws no `PrRepoNotes` at all (`client/src/components/github/PrCards.tsx:83–91`),
  and its head already reads `showing N of M` (`PrCards.tsx:30`). Once the departed state is reachable, the case passes before Task 9. Whether it can be
  reached at Task 9 Step 2 depends on how Task 5 patches `PrRow`'s call site (plan 227–228 leaves that open). Say that the guard may already pass at Step 2
  and must stay green, so an executor does not bend it to fail.
- Plan 422: "add three beside them" is now four (the Spec 249 case was added); Step 2's "six" (plan 435) counts 2 rewritten + 4 added, so only 422 is stale.
- Plan 433: "no `pr-departed-*` outside `pr-repo-futin/y`" — `pr-departed-<key>` exists only in `PrRepoNotes` `above`
  (`client/src/components/github/PrRepoNotes.tsx:41`); the card's own departed lines carry no testid (`PrCards.tsx:72–76`). "no `pr-departed-*` anywhere"
  says the same thing more simply.
- Plan 303–304: Task 6's red note names `test/prs-inbox.test.tsx` 279–291, but 118–124 goes red too. Line 122 is `getByTestId('pr-cantread-a/y')`, and
  after Task 6 both Inbox's own list (`PrInbox.tsx:217`) and `PrRepoNotes` `below` (`PrInbox.tsx:224`) draw that testid. 118–124 recovers in Task 7 with no
  edit: `toHaveTextContent('a/y — slow down')` is a substring of `Can't read · a/y — slow down`. Of 279–291, only 279–285 goes red; 287–291 stays green.
- Plan 328–329: the mechanical pass lists `pr-item-`/`pr-quiet-` lookups at 127–148, 180–197 and 213–221. It misses `test/prs-inbox.test.tsx:80` and 93–99
  in the tiles describe (75–100). "Every" covers them, but the parenthetical list should include them.
- Plan 327 vs 342: 149–163 is on the rewrite list and also "stands with the harness". 236–252 (the Confirm stays on the same quiet PR when the ranking shifts)
  is on the rewrite list, but no bullet says what it becomes. With `confirming` held as page state that case matters less, but a remount would still reset
  `PrFoot`'s picked method.
- Plan 392–393: 206–213, after its pass, clicks `Merge` and then the `combobox` inside `pr-merge-confirm`, so it opens a Confirm and needs the harness too.
  The harness list names only 155–168 and 237–251.
- Plan 117: `REPO_REASONS` holds `updating…`, which is not a repo reason, and no later task uses the export (Task 5's `omitUpdatingReason` filters the
  literal). A name like `LINE_REASONS`, or a module-private set, would fit better. Taste only.

## Checked and fine

- Plan 88: `test/ui-chip.test.tsx` has seven cases (lines 11, 19, 27, 40, 50, 65, 77).
- Plan 100–103: `PrActions.tsx:7` is the `compactKeys, type PrKey` import, and `:102` is the only `compactKeys` call in `client/src`.
  `pr-layouts.ts:237` is `PrKey`, and `:253–262` is `compactKeys`. `prs.ts` imports nothing from `pr-layouts.ts`, so moving `PrKey` creates no import cycle.
- Plan 113–120 (`whyLine` from the blocks): this agrees with spec 76–84. The order is merge, auto-merge, update, which is `PR_KEYS`. `sync off` appears once.
  `updating…` is dropped only for outcome kind `updating`, as spec 80–82 says. The new draft case discriminates against round 1's repo-field rule. The
  `test/prs-lib.test.ts:32–40` fixture defaults (`methods: ['squash','merge']`, `autoMergeAllowed: true`) make every listed `whyLine` case resolve to the value
  the plan states.
- Plan 136: spec 218's "a PR with the mark → `[]`" vs spec 81–82: the prose reading is recorded.
- Plan 225–226: the props object is at `PullRequestsView.tsx:177`, and the state is at 82–85.
- Plan 254–257 and 473–475: the harness clears `confirming` before the call, as the page's `write` does (plan 459). The `prs-view` Merge case's "gone before
  the POST is answered" and the 409 case's "no `pr-merge-confirm`" both fail between Task 5 and Task 10 (Task 5 adds the state with no closing rule), so they
  test the page's own rule. Spec 111–113 is covered.
- Plan 392–393: `test/prs-matrix.test.tsx:231` is `Update branch`, `:206–213` clicks the `Merge method` combobox in the expansion, and 155–168 and 237–251
  open a Confirm.
- Plan 418: today's `PrRow` meta has no age (`client/src/components/github/PrRow.tsx:50–54`). The plan's "deliberate" note covers the addition, and spec
  190 does not forbid it.
- Plan 506–508: `.claude/rules/board.md:19` holds `` `Merge` (`PrRow`) ``, and the Escape bullet starts at 11.
