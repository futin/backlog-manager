# Review 1 — PRs page fixes implementation plan

- Plan: `docs/superpowers/plans/2026-10-30-prs-page-fixes.md`
- Spec: `docs/superpowers/specs/2026-10-30-prs-page-fixes-design.md`
- Date: 2026-10-30
- Verdict: **APPROVE WITH FIXES**

No Critical finding: nothing ships wrong behaviour once all ten tasks land. Seven Important findings: one plan-internal contradiction that a literal
implementation cannot satisfy (the Cards count note), one derivation that lets the why-line and the keys disagree, one broken intermediate state the plan
mis-describes, two test-list gaps that will surface as unexplained red suites, and two tests that do not discriminate the behaviour they name.

## Important

### I1 — `whyLine` reads the repo, not the blocks, so the line and the key can disagree

Plan 115–120 derives `no merge method allowed` from `repo.methods.length === 0` and `auto-merge not enabled on the repo` from `!repo.autoMergeAllowed`
directly. The blocks are first-match: `mergeBlock` checks sync off → draft → not mergeable → checks failing → no merge method allowed
(`client/src/lib/prs.ts:61–68`), and `autoMergeBlock` (plan 113–114) puts the repo setting last. For a draft PR on a repo with no allowed method, the `Merge`
key's `title` says `draft` while the line says `no merge method allowed`; the same for a failing PR on a repo without auto-merge. Spec 83–84 requires "the
line and the keys read the same source", and spec 83 that "every reason, line or not, is on its key" — the line's reason is then on no key.

None of the `whyLine` cases at plan 130–134 combines a PR fact with a repo reason, so the divergence is untested.

Fix: derive `whyLine` from the three blocks' outputs (keep each block's answer, filter to the repo/permission reasons), or tag reasons in the blocks; add a
case "draft PR, `methods: []`" asserting the line and `Merge`'s `title` agree (both the repo reason absent from the line, or both present — whichever the
builder picks, the two must match).

### I2 — `emptyRepoNote` contradicts the plan's own Task 10 case and spec 246

Plan 165–167 counts every ok, polled, rowless, departure-free repo. Plan 448–449 draws the note whenever `layout === 'cards'` and it is non-null. Plan 456 then
asserts "every shown repo clean and listing nothing → no count note", which is spec 246 verbatim. With two clean empty repos, `emptyRepoNote` returns
`2 repos with no open PRs` and the toolbar draws it — the Task 10 case cannot pass against Task 3's definition. Task 3's own cases (plan 178–180) never test
the all-empty payload, so the contradiction lands only in Task 10.

Fix: state the rule once — the note is `null` when no card is drawn (`cardRepos(...)` empty), beside `no open pull requests` — in `emptyRepoNote` (or at
plan 448), and add the all-empty case to Task 3's list.

### I3 — Tasks 2 and 3 leave `PrActions.tsx` not compiling, and plan 184 says only one case goes red

- Plan 102: Task 2 deletes `PrKey` from `pr-layouts.ts` and moves it to `prs.ts` with a fourth member `open` (plan 135). `PrActions.tsx:7` imports
  `type PrKey` from `../../lib/pr-layouts`, and `PrActions.tsx:103` declares `Record<PrKey, …>` with only `merge`, `update`, `auto-merge`. Plan 100–101
  lists `PrActions.tsx` for the third `updateBlock` argument only.
- Plan 146–150: Task 3 deletes `compactKeys`, imported at `PrActions.tsx:7` and called at `PrActions.tsx:102`; `PrActions.tsx` is not in Task 3's files.

The jest preset is `ts-jest` with full type-checking, so every suite that imports `PrActions` (directly or through `PrInbox`/`PrMatrix`/`PrCards`/
`PullRequestsView`: `prs-actions`, `prs-inbox`, `prs-matrix`, `prs-view`) fails to compile from Task 2 until Task 5 replaces the file. Plan 184's "`prs-view`'s
narrow-switcher case at 544 goes red here" is false — the whole suite is red — and plan 51's "between, a task runs only its own suite" hides it. An executor
told one case goes red will either chase the other failures or wave them through.

Fix: in Task 2 keep `PrKey` exported from `pr-layouts.ts` (re-export) or patch `PrActions.tsx`'s import and `Record` to the three keys it draws; in Task 3
either keep `compactKeys` until Task 5 deletes its last caller, or patch `PrActions.tsx:7,102` in Task 3 and list the file. Correct plan 184's red-suite note.

### I4 — Kept `prs-inbox` and `prs-matrix` cases break on the testid and label moves, and the plan says they stand

Plan 310 renames the row testids to `pr-row-<key>` (today `pr-item-<key>` at `client/src/components/github/PrInbox.tsx:81` and `pr-quiet-<key>` at `:124`);
plan 313–314 removes the quiet `Actions` toggle; Task 5 renames `Update branch` → `Update`, `Merge…` → `Merge`, and moves the method `Select` into the
Confirm. Plan 319 says "rewrite 165–179, 223–235, 254–277, 279–291; keep the rest", but these kept cases query the old names:

- `test/prs-inbox.test.tsx` 127–147, 149–163 (`pr-item-` / `pr-quiet-`), 180–196 (`Update branch`, `pr-quiet-`), 213–221 (`pr-item-`), 236–252 (the quiet
  row's `Actions` toggle and `Merge…`).
- `test/prs-matrix.test.tsx` 206–213 (clicks the `Merge method` combobox in the expansion — the `Select` is now inside `pr-merge-confirm`, only after `Merge`)
  and 226–233 (`Update branch`); plan 381 says "every toggle, link and key case at 155–261 stands". These also need the `confirming` props from plan 215–216
  in their harness.

Fix: add these line ranges to Task 7's and Task 8's rewrite lists, and state the testid policy (rename `pr-item-`/`pr-quiet-` → `pr-row-` in every kept case).

### I5 — Review Focus 1's test cannot fail

Plan 57–58 / 467–468: "unmount before 30 s, then advance the timers: no state update warning (`console.error` spy stays unused) and no fetch beyond the ones
already counted". React 18.3.1 removed the setState-on-unmounted warning, so the spy is silent whatever the code does; and the unmount cleanup already clears
every mark timer (`client/src/components/github/PullRequestsView.tsx:116–122`), so neither assertion distinguishes the new code from today's. The real risk
the new timer adds (plan 441–443) is the window AFTER the timer fired and BEFORE `await refresh()` resolves: an unmount there runs `dropMark`/`setOutcomes`
on an unmounted page unless `mountedRef` guards it.

Fix: drive that window — advance 30 s so the timer fires, hold the re-read's fetch, unmount, then resolve it — and assert on something observable (no
`dropMark` side effect, e.g. no further fetch scheduled, or a spy on the guarded branch); drop the `console.error` assertion as non-discriminating.

### I6 — Spec 249's "no departed line and no `showing N of M` from `PrRepoNotes`" is not asserted

Spec 249: in Cards, "a repo whose only PR departed keeps its `pr-repo-*` with `#12 merged` inside, and Cards draws no departed line and no `showing N of M`
from `PrRepoNotes`". Plan 417–418 asserts `#12 merged` inside the sheet and that the sheet reads neither `showing` nor `no open pull requests` — but nothing
asserts that no `pr-departed-<key>` (`PrRepoNotes` `above`) and no `pr-truncated-<repo>` (`below`) is drawn by Cards, which is what `part="failures"`
(plan 290–292, 402) exists to guarantee. Task 6's `failures` cases do not cover Cards' call site either. A Cards that passed `above`/`below` would pass every
listed case.

Fix: in Task 9 add a truncated repo (`total > prs.length`) plus a departed outcome to one Cards case and assert no `pr-departed-*` and no `pr-truncated-*`
testid outside the sheet.

### I7 — The page's "a write closes the Confirm" rule is tested only through a harness that mirrors it, in a different order

Plan 444: the page's `write(key, …)` calls `setConfirming(null)` FIRST. Plan 248–250: Task 5's harness clears `confirming` AFTER the call, "the page's rule,
mirrored". The page's own rule then has no test: plan 458–459 says "the 409 and 502 cases stand", which assert the outcome text, not that
`pr-merge-confirm` is gone. A page that never cleared `confirming` would keep the Confirm open over the error outcome and pass every listed case.

Fix: add a `prs-view` case — `Merge`, accept, 409 → no `pr-merge-confirm` — and make the Task 5 harness clear before the call, as plan 444 says the page does.

## Minor

- Plan 219–220: the props object is built at `client/src/components/github/PullRequestsView.tsx:177`, not 222–230 (222–230 are the three layout branches that
  receive it). Fix the line reference.
- Plan 88: "The existing eight cases stand" — `test/ui-chip.test.tsx` has seven cases (lines 11, 19, 27, 40, 50, 65, 77).
- Plan 51 vs Task 6: plan 51 runs typecheck "at the end of Task 5 and from Task 9 on"; Tasks 6–8 then change `PrRepoNotes`/`PrInbox`/`PrMatrix` with no
  typecheck, and Task 6 has no fail-first step for the `Can't read` line moving out of `PrInbox` (`client/src/components/github/PrInbox.tsx:212–223`) — after
  Task 6 and before Task 7, Inbox can draw both its own failure list and `PrRepoNotes`' line with the same `pr-cantread-<repo>` testid. Say which task removes
  Inbox's copy, or run typecheck per task.
- Plan 133–134 vs spec 218: spec's test list says "a PR with the mark → `[]`"; plan 133 asserts `['updating…']` when the outcome kind is not `updating`. The
  plan follows spec 81–82 (prose) and the spec's test line is the ambiguous one; record in the plan that the prose wins, so a reviewer does not "fix" it back.
- Cards meta line (plan 406) adds the age; spec's Cards section names `author · head → base` only for Inbox's meta. Harmless; state it is deliberate.
- `.claude/rules/board.md`'s Escape bullet names "GitHub › PRs' `Merge` (`PrRow`)"; plan's doc task cites `rules/board.md:19` — confirm that line before
  editing, the bullet starts earlier (~line 10) and spans several lines. The anchor guard (`test/claude-rules.test.ts`) needs the headline unchanged.

## Checked and fine

- Order: every Consumes names something an earlier task Produces (Task 1 chip → Task 5; Task 2 blocks/`PR_KEYS` → Tasks 3, 5; Task 3 `cardRepos`/
  `emptyRepoNote` → Tasks 9, 10; Task 6 `failures` → Tasks 8, 9), apart from I3's compile gap.
- Values and copy match the spec: `PR_KEYS` order, key labels `Merge` / `Auto-merge` / `Update` / `Open ↗`, `Auto-merge ✓`, `Merge #<n> into <base>?`,
  `N repos with no open PRs` / `1 repo with no open PRs`, `Can't read · <repo> — <detail ?? access>`, block orders, 30 s mark, `branch updated`.
- Code facts verified: `prs.ts` (`UpdateMark` 25–28, `mergeBlock` 61–68, `updateBlock` 75–80, `autoMergeBlock` 86–90, `isUpdating` 105–107);
  `pr-layouts.ts` (`drawableLayout` 179–181, `layoutOptions` 184–191, `PrKey` 237, `compactKeys` 253–262, `columnCounts` 329–336); `PrInbox`, `PrMatrix`,
  `PrCards`, `PrRepoNotes`, `PullRequestsView` line ranges; `usePullRequests` `refresh` returns the follow-up's promise (`useCoalescedFetch`), so
  `await refresh()` reads a post-request answer as plan 441 assumes; `prRunWarning` (`client/src/lib/pr-run.ts:34`) unchanged as plan 309 says.
- The plan states behaviour and exact test cases, not literal code, and budgets are soft.
