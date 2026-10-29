# GitHub › PRs layouts (Inbox | Matrix | Cards) and Settings › Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, on purpose (user's global CLAUDE.md):** this plan specifies behaviour, signatures, exact values and exact test
> CASES — never literal code, test scaffolding included. Write the code and the tests yourself from these; if a case here is wrong against the code, say so
> and fix the case, do not transcribe it. Size budgets anywhere below are soft.

**Goal:** Give GitHub › PRs a persisted Inbox | Matrix | Cards switcher (Inbox default), hide repos the token cannot read, and list them on a new GitHub ›
Settings › Access card.

**Architecture:** Every derivation (reach, level, problems, rank, layout key, compact keys, matrix cells) lives in one new pure module
`client/src/lib/pr-layouts.ts`. `PullRequestsView` keeps owning the read, outcomes, `updating…` marks, timers and `write`, filters out no-access repos, draws
the toolbar, and hands one props bundle to whichever layout component is drawn. The actions strip is extracted from `PrRow` into one `PrActions` component
(full or compact) used by every layout; the outcome line is its own `PrOutcomeLine`.

**Tech Stack:** React 18 + TypeScript (client), jest + @testing-library/react under jsdom, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-29-prs-layouts-design.md` — read it whole before Task 1; this plan argues from it and does not repeat its prose.

## Global Constraints

- Worktree: `/Users/andrejajevtic/Documents/custom-projects/backlog-manager/.claude/worktrees/prs-layouts`, branch `feat/prs-layouts`. Never touch the main
  checkout, never switch branches, never `git add -A` — add files by name. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No server change, no new route, no new write (spec Non-goals). `shared/types.ts` gains nothing.
- Every derivation in `client/src/lib/`; every look more than one surface draws in `components/ui/`; new CSS is `.prs-*` / `.set-*` layout classes only —
  design guard 7 (`test/design-guards.test.ts`) forbids restyling a `.ui-*` primitive.
- Every new component carries a header comment citing its `.claude/DESIGN.md` subsection (§8.11 for PRs pieces, §8.6 for the Access card). Comments explain
  *why*, at the density of the neighbouring files (`PrRow.tsx`, `PullRequestsView.tsx`).
- Authored prose wraps at 160 columns (repo has no narrower config).
- Storage key: `backlog-manager.prs-layout` (the repo's `backlog-manager.` prefix; `usePersistedState` stores JSON).
- Narrow breakpoint is `useNarrow()` only — never a px literal in TS.
- The GitHub token value never appears in any text, test or fixture.
- Test commands: one suite `pnpm exec jest --runInBand <path>`; types `pnpm run typecheck`. Do NOT run the whole `pnpm test` (CI does).
- Exact copy fixed by the spec: tiles `Needs you` / `Worth a look` / `Quiet`; `No pull request at this level.`; `no open pull requests`;
  `no repo this token can read`; `no GitHub repo registered`; `Can't read`; `N repos hidden — no access`; link text `GitHub › Settings`; Access card title
  `Access`, pill `N without access`, footer `N repos readable.`; env var `BM_GITHUB_TOKEN`; permissions **Pull requests: Read and write** and **Contents:
  Read and write**. Singular forms: `1 repo hidden — no access`, `1 without access`, `1 repo readable.`.

## Review Focus

1. **A no-access repo that starts reading again** (Goal 7) — a later poll answering `ok` must put it back on every layout and drop it from the hidden note,
   with no click. Test in Task 6.
2. **The same PR number in two repos** — every key is `<repo>#<number>`; expanding Matrix row `a/x#7` must not expand `a/y#7`, and Inbox draws both. Tests
   in Tasks 4 and 5.
3. **A tile filter whose level empties after a re-read** — the filter stays selected and the page shows `No pull request at this level.`, never stale rows.
   Test in Task 4.
4. **A merge `Confirm` open in Inbox when the 60 s poll lands** — the confirm stays open on the same PR (state keyed by PR, not by list index). Test in Task 4.
5. **A stored `matrix` read on a narrow window, then widened** — Inbox is drawn while narrow, Matrix again once wide, and the stored value was never
   overwritten by the narrow draw. Tests in Tasks 1 (lib) and 6 (view).

---

### Task 1: Triage derivations — reach, level, problems, rank, layout key

**Files:**
- Create: `client/src/lib/pr-layouts.ts`
- Modify: `client/src/lib/prs.ts` — move `PrOutcome` (from `PrRow.tsx`) and `UpdateMark` (from `PullRequestsView.tsx`) here as exports, and re-point those
  two files' imports. No behaviour change.
- Test: `test/pr-layouts-lib.test.ts` (new, node environment — no docblock)

**Interfaces:**
- Produces (all exported from `lib/pr-layouts.ts`):
  - `type PrLevel = 'needs-you' | 'worth-a-look' | 'quiet'`; `LEVELS: readonly PrLevel[]` in that order; `LEVEL_LABEL: Record<PrLevel, string>` =
    `Needs you` / `Worth a look` / `Quiet`.
  - `isNoAccess(repo: PrRepoView): boolean` — `access` is `forbidden` or `not-found`.
  - `splitReach(repos: readonly PrRepoView[]): { shown: PrRepoView[]; hidden: PrRepoView[] }` — order preserved.
  - `prLevel(pr: PullRequestRow): PrLevel` and `prSeverity(pr: PullRequestRow): number | null` (null for Quiet) — the spec's "Level of a PR" and "Rank"
    sections exactly, `draft → quiet` checked first.
  - `interface PrProblem { text: string; calm: boolean }`; `prProblems(pr: PullRequestRow, warning: string | null): PrProblem[]` — level-driving facts in
    severity order across both levels (failure, conflicting, changes-requested, behind, review-required, pending-unless-armed, unknown, blocked/unstable-
    unnamed), then the run warning verbatim (calm), then `Approved.` / `Checks are passing.` when true (calm). Sentences: `Checks are failing.`,
    `Conflicts with <base>.`, `Changes were requested.`, `Behind its base.`, `Waiting for a review.`, `Checks are still running.`, `GitHub is still working
    out whether it can merge.`, and for the unnamed block `GitHub reports it blocked.` / `GitHub reports it unstable.`.
  - `prVerdict(problems): { verdict: string | null; steps: PrProblem[] }` — first problem's text, the rest.
  - `quietFacts(pr: PullRequestRow): string` — `prChips(pr)` labels joined with ` · ` (one vocabulary with Cards).
  - `interface RankedPr { key: string; repo: PrRepoView; pr: PullRequestRow; level: PrLevel; severity: number | null }`;
    `rankPrs(repos: readonly PrRepoView[]): RankedPr[]` — level, then severity ascending, then `updatedAt` newest first, then `key` ascending (determinism).
  - `levelCounts(ranked: readonly RankedPr[]): Record<PrLevel, number>`.
  - `type PrLayout = 'inbox' | 'matrix' | 'cards'`; `PR_LAYOUT_KEY = 'backlog-manager.prs-layout'`; `parseLayout(v: unknown): PrLayout` (unknown → `inbox`);
    `drawableLayout(stored: PrLayout, narrow: boolean): PrLayout` (narrow + matrix → inbox, else stored); `layoutOptions(narrow: boolean):
    { value: PrLayout; label: string }[]` (wide: Inbox, Matrix, Cards; narrow: Inbox, Cards).
  - `transientFailures(shown: readonly PrRepoView[]): PrRepoView[]` — shown repos whose `access !== 'ok'`.
  - `newestPolledAt(shown: readonly PrRepoView[]): string | null`.
  - `departedOutcomes(outcomes: Record<string, PrOutcome>, shown: readonly PrRepoView[]): { key: string; outcome: PrOutcome }[]` — keys whose repo is shown
    and whose PR is not listed, `kind !== 'updating'` (the rule `RepoSheet` applies today, lifted for page-level use).

- [ ] **Step 1: Write the failing tests** — `test/pr-layouts-lib.test.ts`, a `row()`/`repo()` fixture builder with every field set. Cases:
  - `isNoAccess`: true for `forbidden`, `not-found`; false for `ok`, `rate-limited`, `error`. `splitReach` keeps order on both sides.
  - `prLevel`: checks `failure` → needs-you; `conflicting` → needs-you; `changes-requested` → needs-you; `behind` → worth-a-look; `review-required` →
    worth-a-look; checks `pending` → worth-a-look; checks `pending` + `autoMerge` armed → quiet; mergeable `unknown` → worth-a-look; mergeState `blocked`
    with clean facts → worth-a-look; draft + checks `failure` → quiet; draft + `review-required` → quiet; behind + approved → worth-a-look; clean approved
    success → quiet.
  - `prSeverity`: failure 0, conflicting 1, changes-requested 2; behind 0, review-required 1, pending 2, unknown 3, blocked 4; quiet → null; a PR with both
    conflicting and changes-requested → 1 (first fact wins).
  - `prProblems` + `prVerdict`: failing + behind + approved with warning `run 3 is working this branch` → verdict `Checks are failing.`, steps texts in
    order `Behind its base.`, `run 3 is working this branch`, `Approved.`; steps 2 and 3 `calm: true`. Conflicting on base `main` → `Conflicts with main.`.
  - `quietFacts`: draft + approved + checks success → `draft · approved · checks passing`.
  - `rankPrs`: across two repos, needs-you before worth-a-look before quiet; within needs-you, failure before changes-requested even when older; equal
    severity → newer `updatedAt` first; same number `#7` in `a/x` and `a/y` gives two entries with keys `a/x#7` and `a/y#7`.
  - `parseLayout`: `'cards'` → cards, `'bogus'` → inbox, `null` → inbox, `3` → inbox. `drawableLayout('matrix', true)` → inbox; `('matrix', false)` → matrix;
    `('cards', true)` → cards. `layoutOptions(true)` values `['inbox','cards']`; `(false)` `['inbox','matrix','cards']`.
  - `transientFailures` keeps `rate-limited` and `error`, drops `ok`. `newestPolledAt` ignores `null`s; all null → null.
  - `departedOutcomes`: an outcome for a listed PR is excluded; for an unlisted one included; `updating` kind excluded; a key on a hidden repo excluded.
- [ ] **Step 2: Run** `pnpm exec jest --runInBand test/pr-layouts-lib.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the Interfaces above in `lib/pr-layouts.ts`, with a header comment that names the spec and says why each rule is ordered as it is
  (draft first, armed auto-merge demotes pending). Move `PrOutcome`/`UpdateMark` into `lib/prs.ts`.
- [ ] **Step 4: Run** the new suite plus `test/prs-lib.test.ts` and `test/prs-view.test.tsx` — expect PASS (the move changes no behaviour). `pnpm run
  typecheck` clean.
- [ ] **Step 5: Commit** `feat(client): PR triage derivations for the PRs layouts`.

### Task 2: Presentation derivations — compact keys and matrix cells

**Files:**
- Modify: `client/src/lib/pr-layouts.ts`
- Test: `test/pr-layouts-lib.test.ts`

**Interfaces:**
- Consumes: Task 1's `prLevel`; `mergeBlock`, `updateBlock`, `autoMergeBlock` from `lib/prs.ts`.
- Produces:
  - `type PrKey = 'merge' | 'update' | 'auto-merge'`; `compactKeys(pr: PullRequestRow, repo: PrRepoView): { keys: PrKey[]; primary: PrKey | null }`. Rules:
    `merge` always; `update` when `mergeState === 'behind'`; `auto-merge` when `repo.autoMergeAllowed` or the PR has auto-merge armed. Primary: `update`
    when behind; else `merge` when `prLevel` is quiet, not a draft and `mergeBlock` is null; else null. `keys` lists the primary first, then the rest in
    `merge, update, auto-merge` order. (Whether a key is disabled and why stays `*Block`'s — this only picks.)
  - `type CellTone = 'ok' | 'bad' | 'meh' | 'live' | 'na'`; `interface MatrixCell { text: string; tone: CellTone }`;
    `MATRIX_COLUMNS = ['checks','review','mergeable','base','autoMerge'] as const`, `type MatrixColumn`, `MATRIX_LABEL: Record<MatrixColumn, string>` =
    `Checks`, `Review`, `Mergeable`, `Base`, `Auto-merge`;
    `matrixCells(pr: PullRequestRow, updating: boolean): Record<MatrixColumn, MatrixCell>`:
    - checks: success `passing` ok · failure `failing` bad · pending `running` live · none `—` na
    - review: approved `approved` ok · changes-requested `changes` bad · review-required `required` meh · null `—` na
    - mergeable: conflicting `conflicts` bad · unknown `computing` live · mergeState `blocked`/`unstable` with no other level-driving fact `blocked`/`unstable`
      meh · otherwise `mergeable` ok
    - base: updating `updating…` live · behind `behind` meh · otherwise `up to date` ok
    - autoMerge: armed → the method (`squash` etc.) live · else `—` na
    A cell ignores `draft` (spec: cells report their own fact).
  - `columnCounts(ranked: readonly RankedPr[], updating: (key: string) => boolean): Record<MatrixColumn, number>` — rows whose cell tone is `bad` or `meh`.
  - `LEVEL_DOT: Record<PrLevel, DotTone | undefined>` — needs-you `crashed`, worth-a-look `paused`, quiet `undefined` (toneless grey; `Dot`'s own rule).
    Import `DotTone` as a type from `components/ui/Dot`, the way `prs.ts` imports `PillTone`.
- [ ] **Step 1: Failing tests**: `compactKeys` — behind PR on an auto-merge repo → keys `['update','merge','auto-merge']`, primary `update`; ready quiet PR on
  a repo without auto-merge → `['merge']`, primary `merge`; checks failing → primary null and `mergeBlock` for it is `checks failing`; draft → primary
  null; armed auto-merge on a repo whose setting is now off still offers `auto-merge`. `matrixCells` — draft + failure → checks `failing`/bad; blocked with
  clean facts → mergeable `blocked`/meh; blocked + review-required → mergeable `mergeable`/ok (the reason has a name); unknown → `computing`/live; updating
  true → base `updating…`/live; armed squash → autoMerge `squash`/live. `columnCounts` over three rows (failing, required, clean) → checks 1, review 1,
  others 0.
- [ ] **Step 2: Run** the suite — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): compact keys and matrix cells for the PRs layouts`.

### Task 3: One actions component and one outcome line

**Files:**
- Create: `client/src/components/github/PrActions.tsx`, `client/src/components/github/PrOutcomeLine.tsx`
- Modify: `client/src/components/github/PrRow.tsx` (renders both; keeps its anatomy and `pr-row-<key>` id), `client/src/styles.css` (only if a class moves)
- Test: `test/prs-view.test.tsx` (unchanged cases must stay green), `test/prs-actions.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes: `PrOutcome`, `mergeBlock`/`updateBlock`/`autoMergeBlock`/`defaultMethod` (`lib/prs.ts`), `compactKeys` (Task 2), `mergePr`/`setAutoMerge`/
  `updateBranch` (`lib/prs-api.ts`).
- Produces:
  - `PrActions({ repo, pr, onWrite, variant }: { repo: PrRepoView; pr: PullRequestRow; onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
    variant: 'full' | 'compact' })` — owns `busy`, `confirming`, the picked method, the `why` reasons wired by `aria-describedby`, and all three writes:
    everything `PrRow` lines ~60–170 own today, moved, not rewritten. `full` draws today's strip byte-for-byte in behaviour (method `Select`, Merge →
    inline `Confirm` with `testId="pr-merge-confirm"` and text `Merge #<n> into <base> (<method>)?`, Update branch, Enable/Disable auto-merge). `compact`
    draws `compactKeys`' keys as chips — the primary `ink`, the others as today's secondary chips — where `merge` is labelled `Merge…` and opens the full
    strip in place (it does not merge), `update` and `auto-merge` run the same write functions the full strip runs; a disabled compact key shows its block
    reason as visible `.prs-why` text. Plus an `Open ↗` link (new tab, `rel="noreferrer"`) in compact mode only.
  - `PrOutcomeLine({ outcome, updating }: { outcome: PrOutcome | undefined; updating: boolean })` — today's `PrRow` outcome rule (an `updating` outcome shows
    only while `updating`), `data-testid="pr-outcome"`, `role="status"`, error class as today. Renders nothing when there is no line.
- [ ] **Step 1: Failing tests** in `test/prs-actions.test.tsx` (render `PrActions` directly with a `jest.fn` `onWrite` that awaits the call):
  compact on a behind PR shows `Update branch` first and clicking it sends `/api/prs/update-branch` once; compact `Merge…` click shows the method select
  and Merge, and no POST is made until `Confirm` is accepted; compact on a failing-checks PR shows `Merge…` disabled with visible text `checks failing`;
  while a write is in flight every key is disabled; `PrOutcomeLine` with an `updating` outcome and `updating=false` renders nothing.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, moving code out of `PrRow` (keep its header comment's facts; move the actions paragraph to
  `PrActions`' header). **Step 4: Run** `test/prs-actions.test.tsx`, `test/prs-view.test.tsx`, `test/design-guards.test.ts` — all PASS with
  `prs-view` untouched; typecheck clean.
- [ ] **Step 5: Commit** `refactor(client): extract the PR actions strip and outcome line`.

### Task 4: Inbox layout

**Files:**
- Create: `client/src/components/github/PrInbox.tsx`, and `client/src/components/github/PrRepoNotes.tsx` (shared with Matrix)
- Modify: `client/src/styles.css` (`.prs-inbox*`, `.prs-tile*`, `.prs-notes*`)
- Test: `test/prs-inbox.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: the layout props every layout takes, exported from `PrInbox.tsx`'s sibling `client/src/components/github/pr-layout-props.ts`:
  `interface PrLayoutProps { repos: PrRepoView[]; outcomes: Record<string, PrOutcome>; marks: Record<string, UpdateMark>; now: number; ctx: PrRunContext;
  write: (key: string, sha: string, call: () => Promise<PrWriteResult>) => Promise<void> }` — `repos` are the SHOWN repos only; the view never hands a
  hidden one down. `PrInbox(props: PrLayoutProps)` default-free named export. `PrRepoNotes({ repos, outcomes })` draws, for Inbox and Matrix: departed
  outcome lines (`<repo>#<n> <text>`, above the list), each sync-off repo's `syncOff` sentence once, and each truncated repo's `<repo>: showing n of total`
  (under the list) — the builder may split it into above/below parts.
- Behaviour (spec §Inbox): three tiles as buttons with `aria-pressed`, each `Dot` (LEVEL_DOT) + count + label; click filters, click again clears. Loud
  items (needs-you, worth-a-look): dot, `#n` link, title, repo; verdict; steps (calm ones muted); `author ?? 'ghost' · head → base · age`; `PrActions
  variant="compact"` on the right; `PrOutcomeLine` under the item. Quiet heading then one line per quiet PR (dot, `#n`, title, repo, `quietFacts`); the
  line is a button-like toggle (`aria-expanded`) that opens `PrActions variant="compact"` beneath it; its `PrOutcomeLine` is always drawn. `Can't read`
  heading + one line per `transientFailures` repo (`<repo> — <detail>`). Empty: no ranked PR at all → `no open pull requests`; tile selected and empty →
  `No pull request at this level.`.
- [ ] **Step 1: Failing tests** (render `PrInbox` with fixture props and a `jest.fn` write): tiles read `1 Needs you`, `1 Worth a look`, `1 Quiet` for a
  failing / behind / clean trio; order of items is failing then behind then the quiet line; clicking `Needs you` hides the behind item and quiet line,
  clicking again restores; re-render with the failing PR now clean while the `Needs you` filter is on → `No pull request at this level.` (Review Focus 3);
  `Merge…` on the quiet PR (expand line first) opens `pr-merge-confirm` after Merge is clicked, then re-render with a fresh props object holding the same PR
  → the confirm is still there (Review Focus 4); two repos each with `#7` both drawn (Review Focus 2); a `rate-limited` repo with rows keeps its rows ranked
  AND draws a `Can't read` line with its detail; a ghost author renders `ghost`; zero PRs → `no open pull requests`; a departed outcome key renders
  `a/x#12 merged` above the list; an outcome for a listed PR renders as `pr-outcome` under that item.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the suite and `test/design-guards.test.ts` — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): Inbox layout for GitHub › PRs`.

### Task 5: Matrix layout

**Files:**
- Create: `client/src/components/github/PrMatrix.tsx`
- Modify: `client/src/styles.css` (`.prs-matrix*`, `.prs-cell-<tone>` using the existing colour tokens — `--red` bad, `--amber-ink` meh, `--live-ink` live,
  `--ink3` na, `--ink2` ok; check §8.2 for the right text token per tone)
- Test: `test/prs-matrix.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes: `PrLayoutProps`, `PrRepoNotes`, `PrActions`, `PrOutcomeLine`, Tasks 1–2.
- Behaviour (spec §Matrix): a real `<table>` (use `ui/Ledger` with `columns` if its API fits; otherwise own table inside Ledger's overflow box). Columns:
  dot · `Pull request` (`#n` link + title; sub-line `repo · head → base` plus the run warning when present; `draft` Pill on drafts) · the five
  `MATRIX_COLUMNS` with each header `<label> <count>` when count > 0 · `Updated` (age). Rows in `rankPrs` order. A row is focusable (`tabIndex=0`,
  `aria-expanded`), click or Enter/Space toggles ONE expansion row beneath (`colSpan` all) holding `PrActions variant="full"` and an `Open on GitHub ↗`
  link; opening another row closes the first; a click whose target is inside an `a`, `button`, `select` or `input` does not toggle. A `PrOutcomeLine` row
  sits beneath the PR row OUTSIDE the expansion whenever there is a line. A transient-failure repo draws one muted row: dot cell empty, `repo` in the PR
  column, its `detail` spanning the check columns. Legend under the table naming the five tones. `PrRepoNotes` above/below. Empty → `no open pull
  requests`.
- [ ] **Step 1: Failing tests**: header shows `Checks 1` for one failing row among three; a draft with failing checks has a `failing` cell while its row
  is still ranked with the quiet rows; click a row → `pr-merge-confirm` reachable via Merge in the expansion; click a second row → the first's expansion
  is gone; Enter on a focused row toggles; clicking the `#n` link does not toggle; `a/x#7` and `a/y#7` expand independently (Review Focus 2); an outcome
  line for a listed PR is visible while the row is collapsed; an `updating` mark shows `updating…` in the Base cell; rate-limited repo with rows keeps them
  AND has its muted row.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** suite + design guards — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): Matrix layout for GitHub › PRs`.

### Task 6: Wire the page — switcher, hidden repos, empty states, Cards

**Files:**
- Create: `client/src/components/github/PrCards.tsx` (today's `RepoSheet` and `PolledAge` moved out of the view, unchanged; `PolledAge` exported for the
  toolbar)
- Modify: `client/src/components/github/PullRequestsView.tsx`, `client/src/App.tsx` (pass `onOpenSettings={() => onOpenGithubPage('settings')}` to
  `PullRequestsView`), `client/src/styles.css` (`.prs-toolbar*`)
- Test: `test/prs-view.test.tsx`

**Interfaces:**
- Consumes: everything above; `Segmented` (`ui/Segmented`), `usePersistedState`, `useNarrow`.
- Produces: `PullRequestsView({ onWorking, onOpenSettings }: { onWorking?: …; onOpenSettings?: () => void })`.
- Behaviour: `splitReach(groupRepos(data.repos))`; `N open` = sum of `total` over shown. Toolbar: `Segmented` over `layoutOptions(narrow)` whose value is
  `drawableLayout(stored, narrow)` and whose change writes the stored value; when hidden > 0 the note `<N> repos hidden — no access · ` + a `set-link`-style
  button `GitHub › Settings` calling `onOpenSettings` (copy `SourcesGroup.tsx`'s pattern); at the right `PolledAge` of `newestPolledAt(shown)`. Empty
  states in spec order: payload `repos` empty → `no GitHub repo registered`; shown empty, hidden not → `no repo this token can read`; else the layout.
  Loading / no token / unavailable / refresh failed lines unchanged. The stored value is never written by a narrow draw.
- [ ] **Step 1: Update the existing suite first**: in `beforeEach`, `localStorage.clear()`; every existing Cards-anatomy case (`pr-repo-*`, `pr-head-*`,
  `pr-outcome` inside `pr-row-*`, the merged line in a repo card) writes `JSON.stringify('cards')` under `backlog-manager.prs-layout` before rendering —
  add one helper for it. Run — they stay green (the view still draws cards only).
- [ ] **Step 2: Failing tests (new cases in the same file)**: default render (no stored value) draws the Inbox tiles; switching to Matrix stores `"matrix"`
  and a fresh render draws Matrix; with `matchMedia` answering narrow and stored `matrix`, Inbox is drawn, the switcher has no Matrix option, and
  localStorage still holds `"matrix"` (Review Focus 5); a payload with `futin/z` `forbidden` → `futin/z` appears in no layout (check all three),
  `N open` excludes its `total`, note reads `1 repo hidden — no access`, clicking `GitHub › Settings` calls `onOpenSettings`; next poll answers `futin/z`
  `ok` with a PR → it appears and the note is gone (Review Focus 1); all repos forbidden → `no repo this token can read`; `repos: []` → `no GitHub repo
  registered`; an `updating…` mark set in Cards survives switching to Inbox and Matrix; the three write cases (merge confirm, auto-merge, update branch)
  re-run from Inbox and from Matrix produce the same POST bodies and `pr-outcome` text as from Cards.
- [ ] **Step 3: Implement.** **Step 4: Run** `test/prs-view.test.tsx`, `test/prs-inbox.test.tsx`, `test/prs-matrix.test.tsx`, `test/design-guards.test.ts` —
  PASS; typecheck clean. Also run `test/source-sections.test.tsx` (it mounts `App`'s GitHub pages, so the new prop and default layout reach it).
- [ ] **Step 5: Commit** `feat(client): PRs layout switcher and hidden no-access repos`.

### Task 7: GitHub › Settings › Access card, and the mount-fact rewrite

**Files:**
- Create: `client/src/components/github/GithubAccessGroup.tsx`
- Modify: `client/src/components/github/GithubSettingsView.tsx` (second `set-col` holding the card; update its header comment, which says "One card"),
  `client/src/hooks/usePullRequests.ts` (doc comment), `client/src/components/github/PullRequestsView.tsx` (header "this page is its only mount"),
  `.claude/rules/board.md` line ~145 (`usePullRequests` in the `useCoalescedFetch` bullet), `docs/subsystems/invariants.md` line ~4709 (same fact),
  `docs/subsystems/board.md` ~483 ("mounted by this page alone")
- Test: `test/github-settings.test.tsx`, `test/claude-rules.test.ts` (run only)

**Interfaces:**
- Consumes: `usePullRequests`, `splitReach`.
- Produces: `GithubAccessGroup()` — renders nothing until data arrives, when `token` is false, or when hidden is empty. Otherwise a card in §8.6's
  language matching `GithubSyncGroup` (same `SettingsGroup` / `SettingsRow` primitives from `ui/SettingsRow`, `scope="this machine"`): title `Access`, bad `Pill` `<N> without access`; lead (spec wording, builder's
  sentence); one row per hidden repo: name + `detail` in the `--red` text class; fix note naming fine-grained token repository access, **Pull requests:
  Read and write** (list, update branch, auto-merge) and **Contents: Read and write** (merge), and `BM_GITHUB_TOKEN`; muted `<N> repos readable.` (count
  of shown repos).
- Mount-fact rewrite: each of the five texts now names both mounts (GitHub › PRs and GitHub › Settings' Access card) and keeps the property that the PR
  cache has no timer, so PRs are read only while a page that shows them is open. Do not change any CLAUDE.md headline.
- [ ] **Step 1: Failing tests** in `test/github-settings.test.tsx` (its fetch stub must now answer `/api/prs`): every repo `ok` → no `Access` heading;
  `futin/z` forbidden with detail `Resource not accessible by personal access token` and `futin/w` not-found → card lists exactly those two with their
  details, pill `2 without access`, footer `1 repo readable.` for one shown repo; the card's text contains `BM_GITHUB_TOKEN`, `Pull requests: Read and
  write`, `Contents: Read and write` and does not match `/gh[pousr]_[A-Za-z0-9]{10,}|github_pat_/`; `token: false` → no card.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the card and the five text edits. **Step 4: Run** `test/github-settings.test.tsx`,
  `test/source-sections.test.tsx` (its fetch stub may need an `/api/prs` answer now that Settings reads it), `test/claude-rules.test.ts`,
  `test/design-guards.test.ts` — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): GitHub › Settings › Access card for repos the token cannot read`.

### Task 8: Docs

**Files:**
- Modify: `.claude/DESIGN.md` §8.11 (rewrite for three layouts: switcher, toolbar, hidden note, Inbox, Matrix, Cards, shared actions/outcome line, empty
  states) and §8.6's paragraph that describes GitHub › Settings' `Sync` card (DESIGN.md ~line 396, "a `Settings` band with a `this machine` pill over one
  `Sync` card") — add the Access card beside it;
  `docs/subsystems/board.md` PRs paragraph (layouts, hidden repos, Access card); `CLAUDE.md` Layout line for `client/src/` — "PRs being the open pull
  requests of the registered GitHub repos, with merge, auto-merge and update branch" gains "drawn as Inbox, Matrix or Cards" (keep it one clause; CLAUDE.md
  bullets have an 80-word cap enforced by `test/claude-rules.test.ts` for unlinked bullets — check that bullet's kind first).
- Test: `test/claude-rules.test.ts`, `test/design-guards.test.ts` (run only)
- [ ] **Step 1: Edit** the docs; every component name and test id they mention must exist (`grep` each).
- [ ] **Step 2: Run** the two suites — PASS.
- [ ] **Step 3: Commit** `docs: PRs layouts and the Access card`.

### Task 9: Verify in the running app

- [ ] **Step 1:** `pnpm run typecheck` and every suite touched above, together, once.
- [ ] **Step 2:** Start the client against the running API if one is up on 4322 (`curl -s localhost:4322/api/health`); otherwise `pnpm run dev` and
  `pnpm run dev:web` in the background, recording each pid. Open `http://localhost:5177`, GitHub › PRs: check Inbox / Matrix / Cards draw, the hidden note
  counts brickwright, ixray, lookout (live facts on 2026-10-29), the link opens GitHub › Settings and the Access card lists the same three. Resize to a
  phone width: Matrix option gone. Screenshot each. Stop only the pids you recorded.
- [ ] **Step 3:** Anything that could not be checked live (no open PRs → loud items, Matrix rows) goes on the unverified list in the final report.
