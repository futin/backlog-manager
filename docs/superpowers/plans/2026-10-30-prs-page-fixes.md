# GitHub › PRs page fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, on purpose (user's global CLAUDE.md):** this plan specifies behaviour, signatures, exact values and exact test
> CASES — never literal code, test scaffolding included. Handed code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch with
> nobody positioned to catch it. Each test step names the case and its exact assertions; the implementer writes the test and the body, and may disagree
> with a value here when the spec says otherwise (the spec wins). Size budgets anywhere below are soft.

**Goal:** Give every pull request on GitHub › PRs the same four keys in the same place in every layout, one foot under the row for the merge Confirm and
the outcome, Matrix at every width, Cards only for repos with open PRs, and a fast `update-branch` that ends in `branch updated` (closes #397).

**Architecture:** The derivations move first (`lib/prs.ts`, `lib/pr-layouts.ts`), then the two primitives the layouts share (`PrActions` as one key strip,
a new `PrFoot` holding the Confirm and the outcome line), then each layout rewrites its row around them, then the page takes the one-Confirm key, the
payload-judging timer and the three-option switcher. No server change; the payload shapes stand.

**Tech Stack:** React 18 + TypeScript SPA under `client/src/`, jest + @testing-library/react (jsdom) suites flat in `test/`, pnpm. Vite on 5177, API on 4322.

**Spec:** `docs/superpowers/specs/2026-10-30-prs-page-fixes-design.md` — read it whole before any task; it supersedes, where they differ, the named
sections of `docs/superpowers/specs/2026-10-29-prs-layouts-design.md`.

## Global Constraints

- **Worktree:** work in `/Users/andrejajevtic/Documents/custom-projects/backlog-manager/.claude/worktrees/prs-page-fixes` on branch `fix/prs-page-fixes`
  cut from `main` (`git worktree add -b fix/prs-page-fixes .claude/worktrees/prs-page-fixes main`, run from the main checkout once, before Task 1). Never
  edit the main checkout, never switch its branch, never `git add -A` — stage files by name. Run `pnpm install --frozen-lockfile` once in the worktree
  if `node_modules` is missing. Commit messages end with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **No server change.** `PR_UPDATING_MS` stays 30 s on the server; `UPDATING_MS` stays 30 s on the client. `PullRequestsPayload`, `PrRepoView`,
  `PullRequestRow` and the three request shapes in `shared/types.ts` are untouched.
- **Where things live.** Every derivation in `client/src/lib/`; every look more than one surface draws in `client/src/components/ui/`; the page may add
  CSS to `client/src/styles.css` under `.prs-*` names only — `test/design-guards.test.ts` refuses a page rule on a `.ui-*` class, every font size is
  11 px or more, and no uppercase text outside `.rail-kicker`. Every new or rewritten component file opens with a header comment citing
  `.claude/DESIGN.md` §8.11.
- **Copy, exact** (the only words the keys, lines and notes may use): keys `Merge`, `Auto-merge`, `Auto-merge ✓`, `Update`, `Open ↗`; Confirm text
  `Merge #N into <base>?` with `Merge` / `Cancel`; outcomes `merged`, `already merged`, `auto-merge armed`, `auto-merge off`, `no auto-merge was armed`,
  `updating…`, `branch updated`; reasons `sync off`, `draft`, `not mergeable`, `checks failing`, `no merge method allowed`,
  `auto-merge not enabled on the repo`, `fork does not allow edits`, `no permission to update`, `already up to date`, `updating…`; the why-line joins
  reasons with ` · `; notes `Can't read · <repo> — <detail>` (`<detail>` is `repo.detail ?? repo.access`), `<repo>: showing N of M`,
  `no open pull requests`, `1 repo with no open PRs`, `N repos with no open PRs`.
- **Keys and reasons.** A blocked key is `aria-disabled="true"` with a click guard, its reason as `title` and in a hidden `aria-describedby` span
  (`.sr-only`, the `GatedChip` pattern) — never the `disabled` attribute. A key in flight is `disabled` outright, all but `Open ↗`. `Open ↗` is a link,
  never disabled, never the primary.
- **Updating = mark presence.** A PR is updating while `marks` holds its key; the clock in `UpdateMark.until` decides nothing any more. The 30 s timer
  judges the payload `refresh()` resolves, never `data` state.
- **One Confirm per page**, keyed by `<repo>#<number>` in `PrLayoutProps.confirming`; the page owns the key.
- **Tests:** run one suite with `pnpm exec jest --runInBand test/<name>.test.tsx`; types with `pnpm run typecheck`. Never run the whole `pnpm test` —
  CI is the full-suite gate. Fixtures discriminate: every asserted field gets a distinct value per PR (distinct `headSha`, `number`, repo), and anything
  keyed per PR is exercised with two repos that share a number (`a/x#7`, `a/y#7`).
- **Line width** 160 columns for authored prose and comments; commit bodies 72.
- **Typecheck** is run at the end of Task 5 and from Task 9 on. Between, a task runs only its own suite.

## Review Focus

Five inputs the spec implies and no spec test case exercises; each gets its test in the task named.

1. The 30 s timer fires after the page unmounted (the person left for Runs): nothing is set on an unmounted component and no warning is logged —
   Task 10, `prs-view`.
2. The timer's own re-read fails (`refresh()` resolves `null`): the mark drops and the `updating…` outcome clears, exactly as a same-head read would —
   Task 10, `prs-view`.
3. A re-read turns `canUpdateBranch` false while the mark still holds: the key reads `updating…`, not `no permission to update`, until the mark drops —
   Task 2, `prs-lib`.
4. Two repos each with #7: `Merge` on `a/x#7` opens one Confirm, under `a/x#7`, and `a/y#7` draws none — Task 7, `prs-inbox`.
5. An error outcome lands while the mark holds (auto-merge refused mid-update): the why-line carries `updating…` and the outcome line carries the
   error, both drawn — Task 7, `prs-inbox`.

---

### Task 1: `Chip` can be a link

**Files:**
- Modify: `client/src/components/ui/Chip.tsx` (props type at the top; the `label` branch at 69–75 and the `button` branch at 76–80 gain an `a` sibling)
- Modify: `docs/subsystems/board.md:98` (the `Chip` row of the primitives table: `as?: button|label|a`, `href?`)
- Test: `test/ui-chip.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ChipProps.as?: 'button' | 'label' | 'a'` and `ChipProps.href?: string`. With `as="a"` the chip is an `<a>` carrying the same `ui-chip
  ui-chip-<variant> ui-chip-<size>` classes, `href`, `target="_blank"`, `rel="noreferrer"`, `title`, `onClick`, the data-* and aria-* passthroughs; it
  draws no `type`, no `aria-pressed`, no `disabled`. The forwarded ref still types as the button's; the anchor branch does not take it (no caller
  anchors a Popover to a link chip).

- [ ] **Step 1: Write the failing cases in `test/ui-chip.test.tsx`**

  - `as="a"` with `href` draws an `<a>` (role `link`) whose class list is exactly the three chip classes for `variant="outline"` and `size={28}`, with
    `href` equal to the one given, `target` `_blank`, `rel` `noreferrer`.
  - The anchor passes `title` and a `data-testid` through and carries no `type` and no `aria-pressed`, even with `pressed`.
  - The existing eight cases stand.

- [ ] **Step 2: Run the suite; the two new cases fail (an anchor is not drawn)**
- [ ] **Step 3: Add the `a` branch in `Chip.tsx` and the two props; edit the `Chip` row in `board.md:98`**
- [ ] **Step 4: Run the suite; all green**
- [ ] **Step 5: Commit** — `git add client/src/components/ui/Chip.tsx docs/subsystems/board.md test/ui-chip.test.tsx`,
  `git commit -m "feat(ui): Chip draws as a link with as=\"a\""`

### Task 2: The blocks, the key set and the why-line

**Files:**
- Modify: `client/src/lib/prs.ts` (`updateBlock` 75–80, `autoMergeBlock` 86–90; add `PR_KEYS`, `PrKey`, `whyLine` beside them)
- Modify: `client/src/components/github/PrActions.tsx` (the one `updateBlock(pr, repo)` call gains a third argument `false` for now — Task 5 replaces
  this file's body)
- Modify: `client/src/lib/pr-layouts.ts:237` (`PrKey` is deleted here and imported from `./prs`; `compactKeys`'s `updateBlock` call gains `false` — Task 3
  deletes `compactKeys`)
- Test: `test/prs-lib.test.ts`

**Interfaces:**
- Consumes: `mergeBlock(pr, repo)` unchanged; `PullRequestRow`, `PrRepoView` from `shared/types.ts`; `PrOutcome['kind']`.
- Produces:
  - `PR_KEYS = ['merge', 'auto-merge', 'update', 'open'] as const` and `type PrKey = (typeof PR_KEYS)[number]` — the strip's order.
  - `updateBlock(pr: PullRequestRow, repo: PrRepoView, updating: boolean): string | null` — in order: `sync off`; `updating…` while `updating`;
    `fork does not allow edits` when `crossRepository && !maintainerCanModify`; when `!canUpdateBranch`, `no permission to update` if `mergeState ===
    'behind'` else `already up to date`; else `null`.
  - `autoMergeBlock(pr, repo): string | null` — unarmed (`pr.autoMerge === null`): `sync off`, `draft`, `not mergeable` (conflicting), `checks failing`,
    `auto-merge not enabled on the repo`, first match; armed: `sync off` only, else `null`.
  - `whyLine(pr: PullRequestRow, repo: PrRepoView, updating: boolean, outcomeKind: PrOutcome['kind'] | undefined): string[]` — the row's repo and
    permission reasons, in key order, each once: when `repo.syncOff !== null` the whole answer is `['sync off']`; else merge's
    `no merge method allowed` when `repo.methods.length === 0`, then auto-merge's `auto-merge not enabled on the repo` when unarmed and
    `!repo.autoMergeAllowed`, then update's one reason: `updating…` when `updating` and `outcomeKind !== 'updating'`, else (when not updating) the
    `fork does not allow edits` / `no permission to update` answer `updateBlock` gives, else nothing. `draft`, `not mergeable`, `checks failing`,
    `already up to date` never appear: the row's facts say them.

- [ ] **Step 1: Write the failing cases in `test/prs-lib.test.ts`** (rewrite the two `updateBlock` cases at 98–111 to the three-argument signature; add)

  - `updateBlock`: behind + `canUpdateBranch` true + updating → `updating…`; behind + `canUpdateBranch` false + updating → `updating…` (Review Focus 3);
    not behind + `canUpdateBranch` false, not updating → `already up to date`; up to date + updatable, not updating → `null`; `syncOff` set + updating →
    `sync off`.
  - `autoMergeBlock` unarmed: a fixture that is at once draft, conflicting, failing, on a repo with the setting off, under sync off — then peeling one
    condition at a time proves the order `sync off`, `draft`, `not mergeable`, `checks failing`, `auto-merge not enabled on the repo`; armed: failing +
    conflicting + draft on a repo with the setting off → `null`; armed under sync off → `sync off`.
  - `whyLine`: sync-off repo with no methods and no auto-merge → `['sync off']` only; quiet clean PR on a repo with `autoMergeAllowed` false →
    `['auto-merge not enabled on the repo']`; `methods: []` and `autoMergeAllowed` false → both, merge's first; fork with `maintainerCanModify` false →
    `['fork does not allow edits']`; behind, `canUpdateBranch` false, own repo → `['no permission to update']`; failing checks on a clean repo → `[]`;
    behind updatable PR, updating, outcome kind `updating` → `[]`; same with outcome kind `ok` → `['updating…']`; same with outcome `undefined` →
    `['updating…']`.
  - `PR_KEYS` is exactly `['merge', 'auto-merge', 'update', 'open']`.

- [ ] **Step 2: Run `test/prs-lib.test.ts`; the new cases fail**
- [ ] **Step 3: Implement the signatures above in `prs.ts`; patch the two callers' `updateBlock` calls with `false`; move `PrKey`**
- [ ] **Step 4: Run `test/prs-lib.test.ts`; green**
- [ ] **Step 5: Commit** — `git add client/src/lib/prs.ts client/src/lib/pr-layouts.ts client/src/components/github/PrActions.tsx test/prs-lib.test.ts`,
  `git commit -m "feat(client): one why-line per PR row, and the key set in order"`

### Task 3: Layout derivations — the primary key, the options, the counts, Cards' repo set

**Files:**
- Modify: `client/src/lib/pr-layouts.ts` (`drawableLayout` 179–181 and `layoutOptions` 184–191 go; `compactKeys` 253–262 goes; `columnCounts` 329–336
  loses its callback; add `PR_LAYOUT_OPTIONS`, `primaryKey`, `cardRepos`, `emptyRepoNote`)
- Modify: `client/src/components/github/PullRequestsView.tsx:176,202` and `client/src/components/github/PrMatrix.tsx:40,151–154` only as far as the
  deleted names force it: the page's `layout` becomes `parseLayout(stored)` and the switcher's options `PR_LAYOUT_OPTIONS` (the `useNarrow` call at 175
  and its import go with them); Matrix's `counts` becomes `columnCounts(ranked)`. The page's behaviour cases are Task 10's.
- Test: `test/pr-layouts-lib.test.ts`

**Interfaces:**
- Consumes: `updateBlock(pr, repo, updating)`, `mergeBlock`, `PrKey` from Task 2; `prLevel`, `RankedPr`, `matrixCells`, `departedOutcomes`,
  `transientFailures` already here.
- Produces:
  - `PR_LAYOUT_OPTIONS: ReadonlyArray<{ value: PrLayout; label: string }>` — three entries, `inbox` `Inbox`, `matrix` `Matrix`, `cards` `Cards`, in that
    order; the `Segmented` takes it as is.
  - `primaryKey(pr, repo, updating: boolean): 'merge' | 'update' | null` — `update` when `mergeState === 'behind'`, not updating, and
    `updateBlock(pr, repo, updating) === null`; else `merge` when `prLevel(pr) === 'quiet'`, not draft, `checks !== 'pending'` and
    `mergeBlock(pr, repo) === null`; else `null`. A behind PR that is updating has no primary.
  - `columnCounts(ranked: readonly RankedPr[]): Record<MatrixColumn, number>` — counts from `matrixCells(pr, false)`: behind counts even while marked.
  - `cardRepos(repos: readonly PrRepoView[], outcomes: Record<string, PrOutcome>): PrRepoView[]` — in the given (`groupRepos`) order, the repos with
    at least one row or at least one departed outcome (`departedOutcomes(outcomes, [repo])`).
  - `emptyRepoNote(repos: readonly PrRepoView[], outcomes: Record<string, PrOutcome>): string | null` — counts the repos with `access === 'ok'`,
    `polledAt !== null`, no rows and no departed outcome (a sync-off empty repo counts; an unread one does not); `null` for 0, `1 repo with no open PRs`
    for 1, `N repos with no open PRs` above.

- [ ] **Step 1: Write the failing cases in `test/pr-layouts-lib.test.ts`** (the `compactKeys` describe at 301–356 becomes `primaryKey`; the two layout cases
  at 239–251 go; the `columnCounts` describe at 402–412 loses its callback)

  - `primaryKey`: every case of today's `compactKeys` describe, asserting the primary alone (`update`, `merge` or `null`) with the same fixtures; plus
    behind + updatable + updating → `null`.
  - `PR_LAYOUT_OPTIONS` has three entries whose values are `inbox`, `matrix`, `cards` in order and whose labels are `Inbox`, `Matrix`, `Cards`.
  - `parseLayout` cases at 231–238 stand.
  - `columnCounts`: two behind rows, one of them marked — the harness no longer passes a callback — `base` is 2; the bad/meh counting case stands.
  - `cardRepos`: `[a/x with one row, a/y empty ok, a/z empty with a departed outcome a/z#4]` → `[a/x, a/z]`.
  - `emptyRepoNote`: no empty repo → `null`; one empty ok repo → `1 repo with no open PRs`; two, one of them sync-off → `2 repos with no open PRs`; an
    empty repo whose `polledAt` is `null` is not counted; an empty repo with a departed outcome is not counted; an empty repo with `access`
    `rate-limited` is not counted.

- [ ] **Step 2: Run `test/pr-layouts-lib.test.ts`; the new cases fail**
- [ ] **Step 3: Implement the signatures above; delete the three functions; patch the page and Matrix call sites**
- [ ] **Step 4: Run `test/pr-layouts-lib.test.ts`; green** (`prs-view`'s narrow-switcher case at 544 goes red here and is rewritten in Task 10)
- [ ] **Step 5: Commit** — `git add client/src/lib/pr-layouts.ts client/src/components/github/PullRequestsView.tsx client/src/components/github/PrMatrix.tsx
  test/pr-layouts-lib.test.ts`, `git commit -m "feat(client): primaryKey, the three-option switcher and Cards' repo set"`

### Task 4: `refresh()` resolves the payload

**Files:**
- Modify: `client/src/hooks/usePullRequests.ts` (`load` 31–40, the return type at 26)
- Test: `test/use-pull-requests.test.tsx`

**Interfaces:**
- Consumes: `useRefreshing<T>(task: () => Promise<T>, opts)` returns `() => Promise<T>` (`client/src/hooks/useRefreshing.ts:23`), so the hook's `refresh`
  resolves whatever `load` resolves.
- Produces: `usePullRequests(): { data; error; refresh: () => Promise<PullRequestsPayload | null> }` — `load` resolves the fresh payload it also stores,
  and `null` when the fetch rejected (after setting `error`) or the component is unmounted.

- [ ] **Step 1: Write the failing cases in `test/use-pull-requests.test.tsx`**

  - `refresh()` resolves the payload the stub fetch answered, equal to the hook's `data` after the act.
  - `refresh()` resolves `null` when the fetch rejects, and `error` holds the rejection's message.
  - The existing cases at 64–136 stand.

- [ ] **Step 2: Run the suite; the two fail (`undefined` is resolved)**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the suite; green**
- [ ] **Step 5: Commit** — `git add client/src/hooks/usePullRequests.ts test/use-pull-requests.test.tsx`,
  `git commit -m "feat(client): usePullRequests refresh resolves the payload"`

### Task 5: One key strip, and the foot

**Files:**
- Modify: `client/src/components/github/pr-layout-props.ts` (`PrLayoutProps` gains `confirming: string | null` and `setConfirming: (key: string | null)
  => void`)
- Modify: `client/src/components/github/PrActions.tsx` (whole body: one variant; the `compact` branch 101–140 and the `full` branch 142–188 go)
- Create: `client/src/components/github/PrFoot.tsx`
- Modify: `client/src/components/github/PullRequestsView.tsx` (a `confirming` state beside `outcomes`/`marks`/`inFlight` at 82–85, handed down with its
  setter in the props object at 222–230; nothing more — Task 10 adds the closing rules)
- Modify, call sites only: `client/src/components/github/PrRow.tsx`, `PrInbox.tsx` (`LoudItem` 73–116, `QuietLine` 118–155), `PrMatrix.tsx`
  (`MatrixRow` 130–141) — each `<PrActions variant=… onOpen=…>` becomes the new props so typecheck stays green; their own rewrites are Tasks 7–9.
- Test: `test/prs-actions.test.tsx` (rewrite: the `compact` and `full` describes go)

**Interfaces:**
- Consumes: `Chip` `as="a"` (Task 1); `PR_KEYS`, `updateBlock(pr, repo, updating)`, `autoMergeBlock`, `mergeBlock`, `whyLine`, `defaultMethod`,
  `outcomeLine` from `lib/prs.ts`; `primaryKey` (Task 3); `mergePr`, `setAutoMerge`, `updateBranch` from `lib/prs-api.ts`; `Confirm`, `Select`, `Chip`
  from `components/ui/`; `PrOutcomeLine` and `hasOutcomeLine` unchanged.
- Produces:
  - `PrActions(props: { repo: PrRepoView; pr: PullRequestRow; updating: boolean; outcome: PrOutcome | undefined; busy: boolean; onMerge: () => void;
    onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>; omitUpdatingReason?: boolean })` — draws, in `PR_KEYS` order, four `Chip size={28}`
    keys: the primary (`primaryKey(pr, repo, updating)`) in `ink`, the rest `outline`; `Open ↗` is `Chip as="a" href={pr.url}`. `Merge` calls
    `onMerge()` and sends nothing. `Auto-merge` has `pressed={pr.autoMerge !== null}`; armed it reads `Auto-merge` plus an `aria-hidden` ` ✓` so its
    accessible name stays `Auto-merge`; a click sends one `setAutoMerge` with `enable: true` and `method: defaultMethod(repo.methods)` (the `method` key
    absent when that is `null`) or `enable: false` when armed. `Update` sends one `updateBranch({ repo, number, headSha })`. Each key's block
    (`mergeBlock`, `autoMergeBlock`, `updateBlock(pr, repo, updating)`) non-null → `aria-disabled="true"`, click guard, `title` = reason, and
    `aria-describedby` to a `.sr-only` span holding the reason (ids from `useId`). `busy` → `disabled` on the three buttons. Under the keys, when
    `whyLine(pr, repo, updating, outcome?.kind)` is non-empty, one `<p className="prs-why">` of the reasons joined with ` · `; with
    `omitUpdatingReason` the `updating…` reason is left out of that line (Matrix's Base cell already says it). The strip's root is
    `<div className="prs-keys-side" data-testid="pr-keys-<repo>#<number>">`, keys in `<div className="prs-keys">`.
  - `PrFoot(props: { repo; pr; outcome: PrOutcome | undefined; updating: boolean; confirming: boolean; onDismiss: () => void; onWrite })` — the row's foot,
    `<div className="prs-foot">`: when `confirming` and `mergeBlock(pr, repo) === null`, a `Confirm` (`label` `Confirm merge of #<number>`, `testId`
    `pr-merge-confirm`, `acceptLabel` `Merge`, `dismissLabel` `Cancel`, `onDismiss`) whose children are a `Select` (`label` `Merge method`, options =
    `repo.methods`, the picked one honoured while the repo still allows it, else `defaultMethod(repo.methods)`) and the text `Merge #<number> into
    <base>?`; accept calls `onWrite(() => mergePr({ repo, number, method, headSha }))` once and nothing else (the page's `write` closes the Confirm).
    Then `PrOutcomeLine` when `hasOutcomeLine(outcome, updating)`. Renders nothing at all when neither is drawn.

- [ ] **Step 1: Write the failing cases in `test/prs-actions.test.tsx`** — a harness component holding `confirming: string | null` in state and drawing
  `PrActions` with `onMerge={() => setConfirming(key)}` and `PrFoot` with `confirming={confirming === key}` and `onDismiss={() => setConfirming(null)}`; its
  `onWrite` runs the call and then clears `confirming` when it matches (the page's rule, mirrored); the fetch stub records `posts: { url; body }[]`.

  - Four keys in `PR_KEYS` order by accessible name: `Merge`, `Auto-merge`, `Update`, `Open ↗`; `Open ↗` is a link to `pr.url` with `target` `_blank`.
  - On a behind updatable PR `Update` has `ui-chip-ink` and the other three `ui-chip-outline`; on a failing PR no key has `ui-chip-ink`.
  - `Merge` opens `pr-merge-confirm` holding a `Select` whose options are the repo's methods and the text `Merge #5 into main?`; accept posts once to
    `/api/prs/merge` with the picked method (`merge`, after picking it) and the PR's `headSha`; dismiss posts nothing and the Confirm is gone; Escape
    dismisses it.
  - Failing checks: `Merge` has `aria-disabled` `true`, `title` `checks failing`, and `aria-describedby` resolving to an element whose text is `checks
    failing`; no `.prs-why`; clicking it opens nothing.
  - Repo with `autoMergeAllowed` false: `.prs-why` reads `auto-merge not enabled on the repo`; `Auto-merge` is `aria-disabled`.
  - `syncOff` set: the three buttons are `aria-disabled` with `title` `sync off`; `.prs-why` reads `sync off` once; `Open ↗` is still a link.
  - Unarmed `Auto-merge` has `aria-pressed` `false` and a click posts `{ enable: true, method: 'squash' }` (repo methods `['squash', 'merge']`); armed it
    reads `Auto-merge ✓`, has `aria-pressed` `true`, accessible name `Auto-merge`, posts `{ enable: false }`, and is enabled on a failing PR.
  - `Update` on a behind PR posts once to `/api/prs/update-branch`; with `updating` true it is `aria-disabled` with `title` `updating…`.
  - `busy` true: `Merge`, `Auto-merge`, `Update` have the `disabled` attribute and `Open ↗` has not; `busy` false again frees them.
  - Confirm open, then `Auto-merge` clicked: no `pr-merge-confirm` afterwards, one auto-merge post, no merge post.
  - `Merge` clicked twice: one `pr-merge-confirm`.
  - `omitUpdatingReason` with `updating` true and outcome `undefined`: no `.prs-why`; without it, `.prs-why` reads `updating…`.
  - `PrFoot` with an `ok` outcome and no Confirm draws `pr-outcome` under the row; with an `updating` outcome and `updating` false draws nothing.
  - The `PrOutcomeLine` describe at 152–166 stands.

- [ ] **Step 2: Run `test/prs-actions.test.tsx`; the cases fail**
- [ ] **Step 3: Implement `PrActions` and `PrFoot` per the Interfaces; add the two props to `PrLayoutProps`; add the page state and pass-through; patch
  the four call sites**
- [ ] **Step 4: Run `test/prs-actions.test.tsx` and `pnpm run typecheck`; both green** (`prs-inbox` and `prs-matrix` go red on their compact-strip and
  full-strip cases until Tasks 7 and 8)
- [ ] **Step 5: Commit** — `git add client/src/components/github/pr-layout-props.ts client/src/components/github/PrActions.tsx
  client/src/components/github/PrFoot.tsx client/src/components/github/PullRequestsView.tsx client/src/components/github/PrRow.tsx
  client/src/components/github/PrInbox.tsx client/src/components/github/PrMatrix.tsx test/prs-actions.test.tsx`,
  `git commit -m "feat(client): one key strip and one foot for every PR row"`

### Task 6: `PrRepoNotes` carries the `Can't read` lines

**Files:**
- Modify: `client/src/components/github/PrRepoNotes.tsx` (the `below` branch; a third `part`)
- Test: `test/prs-inbox.test.tsx` and `test/prs-matrix.test.tsx` assert its lines through the layouts in Tasks 7 and 8; this task has no suite of its own
  beyond typecheck.

**Interfaces:**
- Consumes: `transientFailures(repos)` from `lib/pr-layouts.ts`.
- Produces: `PrRepoNotes({ repos, outcomes, part: 'above' | 'below' | 'failures' })` — `above` unchanged (departed outcomes, then sync-off sentences);
  `below` = the truncated lines (`pr-truncated-<repo>`, text `<repo>: showing N of M`) then, for each of `transientFailures(repos)`, a
  `<p className="prs-notes-line" data-testid="pr-cantread-<repo>">` reading `Can't read · <repo> — <detail ?? access>`; `failures` = those `Can't read`
  lines alone (Cards). Renders `null` when its part has nothing.

- [ ] **Step 1: Implement the third part and the `Can't read` lines**
- [ ] **Step 2: `pnpm run typecheck`; green**
- [ ] **Step 3: Commit** — `git add client/src/components/github/PrRepoNotes.tsx`, `git commit -m "feat(client): PrRepoNotes draws the Can't read lines"`

### Task 7: Inbox

**Files:**
- Modify: `client/src/components/github/PrInbox.tsx` (`LoudItem` 73–116 and `QuietLine` 118–155 become one row; the `Can't read` heading and list at
  212–223 go; the `isUpdating` import goes)
- Modify: `client/src/styles.css` (the `.prs-*` block at 2922–3052: the row classes below, `.prs-why` to `--ink2`; dead Inbox rules deleted)
- Test: `test/prs-inbox.test.tsx`

**Interfaces:**
- Consumes: `PrActions`, `PrFoot` (Task 5); `PrRepoNotes` `below` (Task 6); `rankPrs`, `levelCounts`, `prVerdict`, `prProblems`, `quietFacts`,
  `LEVEL_DOT`, `ageText`, `prRunWarning` unchanged.
- Produces: one `InboxRow` per ranked PR, loud or quiet — `<li className="prs-row" data-testid="pr-row-<key>">`: the level `Dot`; `<div
  className="prs-row-main">` holding the title (`#n` as the one link, `.prs-num`, then the title, then the repo name at the end), the fact line (loud:
  verdict and the steps `prProblems(pr, null)` gives; quiet: `quietFacts`; none when empty), the meta line `author · head → base · age` with the run
  warning as one `Pill tone="warn"` after it (never as a step), then `PrFoot`; and `<PrActions>` as the row's side. `updating` =
  `props.marks[key] !== undefined`. An effect clears `confirming` when it names a row the tile filter hides. No toggle, no `aria-expanded`. Shared row
  CSS, used by Cards too: `.prs-row` (flex, 16 px gap, top-aligned), `.prs-row-main` (`flex: 1 1 320px; min-width: 0`), `.prs-keys-side` (column,
  `align-items: flex-end`), `.prs-keys` (8 px gap), `.prs-why` (12 px, `--ink2`), `.prs-foot` (8 px above); under `NARROW_QUERY` (the 700 px media
  block) the side wraps under the main at full width, keys left-aligned.

- [ ] **Step 1: Write the failing cases in `test/prs-inbox.test.tsx`** (rewrite 165–179, 223–235, 254–277, 279–291; keep the rest)

  - A loud row and a quiet row each draw four keys; the quiet row has one link (`#n`) and no `aria-expanded` anywhere.
  - A row draws `.prs-why` only when a repo reason holds: a clean PR on a repo with `autoMergeAllowed` false draws it; the same PR on a repo with it true
    draws none.
  - A row whose key is in `marks` with outcome `{ text: 'auto-merge armed', kind: 'ok' }`: `.prs-why` reads `updating…` and `pr-outcome` reads
    `auto-merge armed`; the same with outcome `{ text: 'updating…', kind: 'updating' }`: no `.prs-why`, `pr-outcome` reads `updating…`.
  - Review Focus 5: a marked row with outcome `{ text: 'refused', kind: 'error' }`: `.prs-why` reads `updating…` and `pr-outcome` reads `refused` in the
    error class.
  - A loud row under a live run: the warning is one `Pill` in the meta line, not a step; the meta reads `futin · feat/x → main · 2h ago` before it.
  - `Merge` on the second row: one `pr-merge-confirm` on the page, inside the second row's `.prs-row-main` and not inside its `.prs-keys-side`.
  - Review Focus 4: `a/x#7` and `a/y#7` listed; `Merge` on `a/x#7` → one Confirm, within `pr-row-a/x#7`; none within `pr-row-a/y#7`.
  - The case at 149 (`a/x#7` leaves, Confirm on `a/y#7` stays) stands with the harness holding `confirming` as the page does.
  - Outcome lines draw under a loud and under a quiet row.
  - Departed outcomes above the list; `pr-cantread-<repo>` and `pr-truncated-<repo>` below it, no `Can't read` heading.
  - Sync-off repo: the sentence once above the list, and `sync off` on each of its rows' `.prs-why`.
  - Tile filter hiding the confirming row closes the Confirm (harness `confirming` becomes `null`).

- [ ] **Step 2: Run `test/prs-inbox.test.tsx`; the new cases fail**
- [ ] **Step 3: Implement `InboxRow`, delete the old two and the heading; write the row CSS**
- [ ] **Step 4: Run `test/prs-inbox.test.tsx` and `test/design-guards.test.ts`; green**
- [ ] **Step 5: Commit** — `git add client/src/components/github/PrInbox.tsx client/src/styles.css test/prs-inbox.test.tsx`,
  `git commit -m "fix(client): Inbox rows carry the four keys, the why-line and the foot"`

### Task 8: Matrix

**Files:**
- Modify: `client/src/components/github/PrMatrix.tsx` (`MatrixRow` 75–144: the expansion 130–141 and the outcome row 123–129; `PrMatrix` 146–214: the
  scroll box, the failure rows 190–197 go, the empty state)
- Modify: `client/src/styles.css` (`.prs-matrix-table` 3017, `.prs-matrix-pr` 3035, `.prs-matrix-fail` 3046 goes; add `.prs-matrix-scroll`,
  `.prs-matrix-sticky`, `.prs-matrix-pinned`, `.prs-matrix-pr-inner`)
- Test: `test/prs-matrix.test.tsx`

**Interfaces:**
- Consumes: `PrActions` with `omitUpdatingReason`, `PrFoot` (Task 5); `columnCounts(ranked)` (Task 3); `PrRepoNotes` `below` (Task 6).
- Produces: the table inside `<div className="prs-matrix-scroll">` (`overflow-x: auto; container-type: inline-size`, page-owned, inside the `Ledger`);
  `.prs-matrix-table` is `width: max-content; min-width: 100%`; the dot and PR `<th>`/`<td>` carry `prs-matrix-sticky` (`position: sticky; left`, the
  dot at 0 and the PR cell after it, each carrying the row's ground: plain, `--strip-hi` on hover, `--strip-hi` plus the inset ink bar when open);
  `.prs-matrix-pr` loses `width: 100%` and its content sits in `<div className="prs-matrix-pr-inner">` with `max-width: 60cqw` so the title wraps. The
  open row's expansion is ONE `<tr className="prs-matrix-expand">` with one `<td colSpan>` across every column whose content is a `<div
  className="prs-matrix-pinned">` (`width: 100cqw; position: sticky; left: 0`) holding `PrActions` (`omitUpdatingReason`) and then `PrFoot`; the
  block is tinted `--strip-hi` with the inset ink bar. A collapsed row's outcome keeps its own `<tr className="prs-matrix-outcome">`, same pinned cell.
  The `updating` outcome draws no row either way: the foot and the outcome row get `outcome?.kind === 'updating' ? undefined : outcome`. `updating`
  = `props.marks[key] !== undefined` (Base cell and keys alike). Collapsing a row (toggle, or a second row opening) whose Confirm is open calls
  `setConfirming(null)`. Failed repos draw no row; `ranked.length === 0` → `no open pull requests` only when `transientFailures(repos)` is empty, and
  then no table and no legend; `<PrRepoNotes part="below">` after the table.

- [ ] **Step 1: Write the failing cases in `test/prs-matrix.test.tsx`** (rewrite 143–154, 263–271, 299–321; keep the rest)

  - The expansion holds four keys by accessible name and `.prs-why` when a repo reason holds.
  - An `ok` outcome on the OPEN row draws `pr-outcome` inside `.prs-matrix-expand` and no `.prs-matrix-outcome` row; the same outcome collapsed draws
    one `.prs-matrix-outcome` row.
  - An `updating` outcome with the key in `marks`: no `.prs-matrix-outcome` and no `pr-outcome` collapsed or open; the Base cell reads `updating…`; the
    expansion's `Update` is `aria-disabled` with `title` `updating…`; no `.prs-why` mentions `updating…`.
  - `branch updated` (`kind: 'ok'`) collapsed draws a `.prs-matrix-outcome` row reading `branch updated`.
  - Two behind rows, one marked: the Base header count reads 2.
  - A rate-limited repo with rows keeps its rows, draws no `.prs-matrix-fail` and no `pr-mfail-*`, and `pr-cantread-<repo>` sits below the table.
  - A rate-limited repo without rows: the line and nothing else for it.
  - The only shown repo failed and holds nothing: no table, no `no open pull requests`, no legend, the line.
  - The table's parent is `.prs-matrix-scroll`; the dot and PR cells of a row carry `prs-matrix-sticky`; the expansion's cell content and the outcome
    row's cell content carry `prs-matrix-pinned`.
  - Opening a row, clicking `Merge`, then toggling the row closed: no `pr-merge-confirm`, and the harness's `confirming` is `null`.
  - Every toggle, link and key case at 155–261 stands.

- [ ] **Step 2: Run `test/prs-matrix.test.tsx`; the new cases fail**
- [ ] **Step 3: Implement; write the CSS**
- [ ] **Step 4: Run `test/prs-matrix.test.tsx` and `test/design-guards.test.ts`; green**
- [ ] **Step 5: Commit** — `git add client/src/components/github/PrMatrix.tsx client/src/styles.css test/prs-matrix.test.tsx`,
  `git commit -m "fix(client): Matrix at every width, one expansion block, failures as lines"`

### Task 9: Cards

**Files:**
- Modify: `client/src/components/github/PrCards.tsx` (`RepoSheet` 27–80; `PrCards` 82–91)
- Delete: `client/src/components/github/PrRow.tsx` (its only caller was `PrCards`)
- Modify: `client/src/styles.css` (any `.prs-row-*` rule only `PrRow` used goes; the card row uses Task 7's row classes)
- Test: `test/prs-view.test.tsx` — the `grouping and the rows` describe (199–262) mounts in Cards and holds the Cards cases; run it alone with
  `pnpm exec jest --runInBand test/prs-view.test.tsx -t 'grouping and the rows'` (the rest of the suite stays red until Task 10). Also
  `test/design-guards.test.ts`.

**Interfaces:**
- Consumes: `cardRepos` (Task 3); `PrActions`, `PrFoot` (Task 5); `PrRepoNotes` `failures` (Task 6); `prChips`, `prRunWarning`, `ageText`,
  `departedOutcomes`, `PolledAge` unchanged.
- Produces: `PrCards` draws one `RepoSheet` per repo of `cardRepos(props.repos, props.outcomes)`, then `<PrRepoNotes part="failures">`; when
  `cardRepos` is empty and `transientFailures(repos)` is empty, `<p className="prs-status">no open pull requests</p>`. `RepoSheet` keeps `pr-repo-<repo>`
  and `pr-head-<repo>`, the repo name, `polled N ago`, `showing N of M`, the `sync off` pill and sentence; the red `detail` line (51) and the
  `no open pull requests` reading go. Each row is `<li className="prs-row" data-testid="pr-row-<key>">` with `.prs-row-main` (title with `#n` linked,
  meta `author · head → base · age`, the chips from `prChips(pr)` with the run warning as a `Pill tone="warn"` among them, then `PrFoot`) and
  `<PrActions>` as the side. Departed outcomes stay the card's last lines (72–76).

- [ ] **Step 1: Write the failing Cards cases in `test/prs-view.test.tsx`** (rewrite 242 and 255 in place and add three beside them; the describe's other
  cases stand, and 266 onward is Task 10's)

  - 242 → an ok repo listing nothing (`futin/z`, `prs: []`, `total: 0`) draws no `pr-repo-futin/z`; `pr-repo-futin/x` and `pr-repo-futin/y` are drawn.
  - Every shown repo ok and listing nothing → `no open pull requests` once, and no `pr-repo-*`.
  - 255 → `futin/y` `rate-limited` with `detail: 'rate limited — retrying at 12:30'` and its rows kept: `pr-repo-futin/y` is drawn and does not contain
    `rate limited`; `pr-cantread-futin/y` reads `Can't read · futin/y — rate limited — retrying at 12:30`; `pr-repo-futin/x` is drawn.
  - The same repo `rate-limited` with `prs: []` → no `pr-repo-futin/y`, `pr-cantread-futin/y` drawn, `pr-repo-futin/x` drawn.
  - A repo whose only PR departed: merge `futin/y#12` through the Confirm's accept, as 314 does, with the re-read listing `futin/y` with `prs: []` →
    `pr-repo-futin/y` stays, reads `#12 merged`, and reads neither `showing` nor `no open pull requests`.

- [ ] **Step 2: Run the describe; the five cases fail**
- [ ] **Step 3: Implement; delete `PrRow.tsx`**
- [ ] **Step 4: Run the describe, `pnpm run typecheck` and `test/design-guards.test.ts`; green**
- [ ] **Step 5: Commit** — `git add client/src/components/github/PrCards.tsx client/src/styles.css test/prs-view.test.tsx`,
  `git rm client/src/components/github/PrRow.tsx`, `git commit -m "fix(client): Cards draw only repos with open PRs, with the one row vocabulary"`

### Task 10: The page — the Confirm key, the timer, the switcher, the count

**Files:**
- Modify: `client/src/components/github/PullRequestsView.tsx` (`markUpdating` 99–113, the head-moved effect 125–132, `write` 134–165, the switcher and
  toolbar 174–218)
- Modify: `client/src/lib/prs.ts` (`isUpdating` 104–107 and `UpdateMark.until` go once no caller remains; `markUpdating` stores `{ sha }`)
- Test: `test/prs-view.test.tsx`, `test/prs-lib.test.ts` (the `isUpdating` describe at 131–142 goes)

**Interfaces:**
- Consumes: `refresh(): Promise<PullRequestsPayload | null>` (Task 4); `PR_LAYOUT_OPTIONS`, `parseLayout`, `emptyRepoNote`, `cardRepos` (Task 3);
  `mergeBlock`; `UPDATING_MS`.
- Produces:
  - `UpdateMark = { sha: string }`; `marks[key]` present = updating.
  - The head-moved effect over `data`: for each mark, the PR gone → `dropMark`; the PR present with `headSha !== mark.sha` → `dropMark` and
    `outcomes[key] = { text: 'branch updated', kind: 'ok' }` replacing whatever was there.
  - `markUpdating(key, sha)`'s timer: `const payload = await refresh()`, then judge that payload: the PR absent → `dropMark`; the PR present with the same
    `headSha` as `sha`, or `payload === null` → `dropMark` and delete `outcomes[key]` when its kind is `updating`; a new `headSha` → `dropMark` and set
    `branch updated` (idempotent with the effect). Guarded by `mountedRef`.
  - `write(key, …)`: when `confirming === key`, `setConfirming(null)` first; the rest as today.
  - An effect over `data` and `confirming`: the confirming PR absent from the payload, or `mergeBlock(pr, repo) !== null`, → `setConfirming(null)`.
  - `setStored(next)` also calls `setConfirming(null)`.
  - `layout = parseLayout(stored)`; the `Segmented` takes `PR_LAYOUT_OPTIONS`; no `useNarrow`.
  - Toolbar: when `layout === 'cards'` and `emptyRepoNote(shown, outcomes)` is non-null, a second `<span className="prs-toolbar-note">` after the hidden-repos
    note (or in its place), before `prs-toolbar-age`.

- [ ] **Step 1: Write the failing cases in `test/prs-view.test.tsx`** (rewrite 266–280, 328–339, 365–394, 421–436, 438–474, 544–553;
  keep the rest; every case that drove `Merge…` / `Update branch` / `Enable auto-merge` now drives `Merge` / `Update` / `Auto-merge`)

  - Cards toolbar (the sheets themselves are Task 9's cases): one ok repo with no rows → a `prs-toolbar-note` reading `1 repo with no open PRs`, after the
    hidden-repos note when one is drawn and before `prs-toolbar-age`; two such repos → `2 repos with no open PRs`; the note is absent in Inbox and Matrix
    for the same payload; every shown repo clean and listing nothing → no count note; a repo not yet read (`polledAt` null, no rows) is not counted.
  - Stored `matrix` on a narrow window draws `pr-matrix` and the switcher offers three options.
  - Merge: `Merge` opens `pr-merge-confirm` with a `Select` inside it; dismiss sends nothing; accept sends one POST with the picked method; the 409 and
    502 cases stand.
  - Blocked actions: a PR-fact reason (failing checks) is on `Merge`'s `title` and `aria-describedby` and not on `.prs-why`; a repo reason
    (`autoMergeAllowed` false) is on `.prs-why`; sync-off disables all three buttons with `sync off`.
  - Armed PR reads `Auto-merge ✓` and a click sends `enable: false`.
  - A re-read listing the marked PR with a new `headSha` → `pr-outcome` reads `branch updated`, still after 30 s and one more re-read.
  - The timer's own re-read answers a new head → `branch updated`, and the mark is dropped after that re-read (the `Update` key is enabled again).
  - Review Focus 2: the timer's re-read rejects → the mark drops and `updating…` clears.
  - Same-head after 30 s clears `updating…` with one extra read (today's case, with `refresh` judged by its payload).
  - Review Focus 1: unmount before 30 s, then advance the timers: no state update warning (`console.error` spy stays unused) and no fetch beyond the ones
    already counted.
  - Layout switch keeps marks and in-flight keys (today's two cases) and closes an open Confirm.
  - A re-read that turns the confirming PR's `checks` to `failure` closes the Confirm; nothing is sent.
  - `Merge` on a second PR closes the first's Confirm; one `pr-merge-confirm` on the page.

- [ ] **Step 2: Run `test/prs-view.test.tsx`; the new cases fail**
- [ ] **Step 3: Implement; delete `isUpdating` and the `until` field**
- [ ] **Step 4: Run `test/prs-view.test.tsx`, `test/prs-lib.test.ts`, `test/run-pulse.test.ts`, `test/source-sections.test.tsx`,
  `test/github-settings.test.tsx` and `pnpm run typecheck`; green**
- [ ] **Step 5: Commit** — `git add client/src/components/github/PullRequestsView.tsx client/src/lib/prs.ts test/prs-view.test.tsx test/prs-lib.test.ts`,
  `git commit -m "fix(client): one Confirm per page, branch updated on a fast update, Matrix at every width"`

### Task 11: Docs, guards and the branch's last check

**Files:**
- Modify: `.claude/DESIGN.md` §8.11 (532–562): rewrite the paragraphs "The toolbar and the layout switch" (536), "Hidden repos and the empty states" (538),
  "Inbox" (540), "Compact keys" (542 → "The key strip"), "Matrix" (544), "Cards" (546), "What every layout carries" (548), "Grouping (Cards)" (550),
  "The repo heading (Cards)" (552), "Row anatomy (Cards)" (554), "Actions and their reasons" (558), "The outcome line" (560), "`updating…`" (562) to
  what Tasks 5–10 built; "The warning chip" (556) only where the pill moved to the meta line.
- Modify: `docs/subsystems/board.md` 481–507 (the PRs paragraph, rewritten whole), 673–677 (the `lib/` paragraph: `compactKeys` → `primaryKey`,
  `whyLine`, `cardRepos`, `emptyRepoNote`, `PR_LAYOUT_OPTIONS`).
- Modify: `.claude/rules/board.md:19` — the Escape bullet names GitHub › PRs' `Merge` Confirm as opened by `PrActions` and drawn by `PrFoot`, no longer
  `PrRow`; the headline byte-equal with CLAUDE.md's stays.
- Modify: `docs/superpowers/specs/2026-10-29-prs-layouts-design.md:3` — one line after the status: superseded in the named sections by
  `2026-10-30-prs-page-fixes-design.md`.
- Test: `test/claude-rules.test.ts`, `test/design-guards.test.ts`, `test/csp.test.ts`, `test/vite-proxy.test.ts`.

- [ ] **Step 1: Write the doc edits**
- [ ] **Step 2: Source guards** — for every exported name the branch added a caller of or deleted (`PrActions`, `PrFoot`, `PrRepoNotes`, `PrRow`,
  `PullRequestsView`, `usePullRequests`, `compactKeys`, `drawableLayout`, `layoutOptions`, `primaryKey`, `whyLine`, `isUpdating`, `useNarrow`,
  `useDialogEscape`, `PrOutcomeLine`), run `grep -l <name> test/` and run every suite it names that has not run on this branch yet — at the time of
  writing: `test/run-pulse.test.ts`, `test/source-sections.test.tsx`, `test/github-settings.test.tsx`, `test/jira-chip.test.tsx`, `test/rail.test.tsx`,
  `test/releases-drawer.test.tsx`, `test/shell-strip.test.tsx`, `test/tracker-chip.test.tsx`, `test/ui-form-sheet.test.tsx`, `test/ui-popover.test.tsx`,
  `test/ui-modal.test.tsx`, `test/ui-use-narrow.test.tsx`, `test/dialog-count-docs.test.ts`, `test/dialog-escape.test.tsx`,
  `test/orchestrator-start-ui.test.tsx`, `test/runs-view.test.tsx`, `test/run-controls.test.tsx`. Expected: every one green.
- [ ] **Step 3: CSS agreement** — `grep -o 'prs-[a-z0-9-]*' client/src/styles.css | sort -u` and the same grep over `client/src/components/github/`; every
  class the CSS names is named by a component, and every `.prs-*` class a component names that needs a rule has one. Delete the orphans in the CSS.
- [ ] **Step 4: Run the four guard suites and `pnpm run typecheck`; green**
- [ ] **Step 5: Commit** — `git add .claude/DESIGN.md docs/subsystems/board.md .claude/rules/board.md docs/superpowers/specs/2026-10-29-prs-layouts-design.md
  client/src/styles.css`, `git commit -m "docs(prs): the key strip, the foot and the three layouts after the fixes"`

### After the last task

The pull request (held under autopilot; its command goes in the final report) is titled `fix(client): one key strip and one foot on every GitHub › PRs
layout`, and its body names `Closes #397`. The branch stays `fix/prs-page-fixes`; nothing is merged by this plan.
