# GitHub › PRs: Inbox, Matrix and Cards layouts, and a Settings › Access card

Date: 2026-10-29. Status: approved (autopilot gate, after doc-review round 1 — `docs/superpowers/reviews/2026-10-29-prs-layouts-design-review-1.md`). Mockups (sample rows, daylight theme): https://claude.ai/artifact/JGHYN5bT7oaU8uute4W82h

## Intent

GitHub › PRs (`.claude/DESIGN.md` §8.11, shipped in #394) draws one card per registered GitHub repo. With eight repos and a handful of PRs, the page is mostly
empty cards and red error cards; the question a person brings to it — *which PR needs me, and what is wrong with it* — has to be answered by reading every
card. The dashboard's Management › Git page already solved the same shape of problem for repos and branches with an **Inbox** (count tiles that filter, then
one ranked list where loud things get a full item and quiet things a line) and a **Matrix** (one row per thing, one column per check, colour only where a check
fails). This work ports those two layouts to PRs, keeps today's cards as a third layout, and moves repos the token cannot read off the page and into GitHub ›
Settings, where the fix lives.

Reference implementation to port FROM (behaviour and visual language, not code to import): `~/Documents/custom-projects/claude-agents-dashboard/`
`client/src/components/management/GitView.tsx`, `GitInbox.tsx`, `GitMatrix.tsx`, `client/src/lib/gitLayouts.ts`, `lib/gitLevels.ts`, and its spec
`docs/superpowers/specs/2026-10-13-management-redesign-design.md` §4.3 (Inbox) and §4.4 (Matrix).

## Goals

1. A layout switcher on GitHub › PRs: **Inbox | Matrix | Cards**, Inbox the default, choice persisted per device.
2. **Inbox**: three count tiles (Needs you / Worth a look / Quiet) that filter; loud PRs as full items with a verdict, further problems as steps, and the PR's
   actions; quiet PRs as one line each; ranked across all repos, worst first.
3. **Matrix**: one row per PR, a column per check, colour only where a check fails, a failure count on each header, the row the toggle that opens the PR's
   actions beneath it. Wide windows only.
4. **Cards**: today's page, unchanged apart from Goal 5.
5. Repos the token **cannot read** — last PR read `access: 'forbidden'` or `'not-found'` — are drawn by no layout. The toolbar says how many are hidden and
   links to GitHub › Settings.
6. GitHub › Settings gets an **Access** card beside Sync listing those repos, the error GitHub gave, and how to fix it (no age — see the Access card).
7. A hidden repo comes back on its own: the next read that answers `ok` puts it back on every layout and takes it off the Access card, with no button.

## Non-goals

- No repo filter (decided: tiles only for now).
- No new write. Merge, auto-merge and update branch stay exactly the three writes, with the same blocks, confirm step and outcome lines.
- No server change is required (see "Data" below). If the builder finds one is needed, that is a signal to come back, not to add a route.
- No Inspector or Branches layout (the dashboard's other two).
- No change to the Sources card on Settings › Shared.

## Anti-goals (failure even if it works)

- A layout that loses something Cards shows today: the run-in-progress warning, the `updating…` mark, a disabled control's reason, the merge confirm, the
  outcome line a merged PR leaves, `sync off`, `showing n of total`, polled age, the merge-method select. The user wants 100% of functionality kept through a
  redesign; every layout must carry all of it, in its own form.
- Hiding a repo for a transient failure. Rate-limited and generic `error` repos stay on the page with their error (decided).
- Three copies of a PR's actions drifting apart. The actions are one component used by all three layouts.
- Deriving level, verdict or reach in a component. Per CLAUDE.md, every derivation has one home in `lib/`.

## Data

Everything needed is already on `GET /api/prs` (`PullRequestsPayload` → `PrRepoView[]` → `PullRequestRow[]`, `shared/types.ts`). Facts checked on this
machine on 2026-10-29: brickwright, ixray and lookout answer `access: 'forbidden'`, `detail: 'Resource not accessible by personal access token'` (GraphQL
`FORBIDDEN` → 403 → `forbidden`, `server/src/tracker/github.client.ts`, `poller.service.ts`'s `failureVerdict`). A forbidden read sets no sleep, and a failed
read still counts against the 60 s `PR_TTL_MS`, so a forbidden repo is re-read once a minute while something polls `/api/prs` — which is what makes Goal 7
free.

A `forbidden` repo may still carry rows from an earlier successful read (a failed read keeps the last rows). It is hidden anyway: rows the token can no longer
read are not rows to act on.

## The derivations (all in `client/src/lib/`)

### Reach of a repo

A repo is **no-access** when its `access` is `forbidden` or `not-found`; otherwise **shown**. Every layout, the `N open` pill and the hidden count read this
one function. `N open` becomes the sum of `total` over shown repos only.

### Level of a PR

Three levels, first match wins, and the first rule is `draft → Quiet` — before either list below, so a draft whose checks fail or whose review is required
is still Quiet:

- **Needs you** — checks `failure`; or mergeable `conflicting`; or review `changes-requested`.
- **Worth a look** — mergeState `behind`; or review `review-required`; or checks `pending` *unless auto-merge is armed* (GitHub will merge it on its own); or
  mergeable `unknown`; or mergeState `blocked` / `unstable` with none of the reasons above to name.
- **Quiet** — everything else: drafts (whatever their checks say), ready-and-clean PRs, armed auto-merge waiting on checks.

### Problems and the verdict

Each PR yields an ordered list of problems — the level-driving facts above plus, as calm steps, the run-in-progress warning (`prRunWarning`, unchanged) and
facts worth reading next to a problem (`approved`, `checks passing`). The **verdict** is the first problem as a sentence; the rest are **steps**. Wording, in
the mockup's register: `Checks are failing.`, `Conflicts with <base>.`, `Changes were requested.`, `Behind its base.`, `Waiting for a review.`, `Checks are
still running.`, `GitHub is still working out whether it can merge.`. The exact strings are the builder's, but they live in `lib/` and are tested, and a quiet
line's facts are the same vocabulary as `prChips` (it must not describe a PR two ways — `prChips` stays the one reading for Cards' chips).

### Rank

Across all shown repos: level (Needs you, Worth a look, Quiet), then problem severity within the level, then newest `updatedAt` first. **Severity** is the
index, in its level's list above, of the first fact that put the PR there (Needs you: checks failure 0, conflicting 1, changes-requested 2; Worth a look:
behind 0, review-required 1, checks pending 2, mergeable unknown 3, blocked/unstable 4); lower ranks first. Quiet PRs have no severity and sort by
`updatedAt` alone.

### Layout key

`'inbox' | 'matrix' | 'cards'`, default `inbox`, persisted per device with the existing `usePersistedState` under a `backlog-manager.`-prefixed key. Any
unknown stored value reads as `inbox`. Matrix is wide-only: under the board's narrow breakpoint (`useNarrow`, never a literal of its own) the switcher offers
Inbox and Cards, a stored `matrix` is drawn as Inbox, and the stored value survives for the next wide window — the dashboard's `drawableGitLayout` rule.

## The page

**Band** unchanged (`Pull requests`, sub, `N open` pill). **Toolbar** under it: the segmented switcher; when ≥1 repo is no-access, `N repos hidden — no
access · GitHub › Settings`, the last part a link threaded down from the rail the way Settings' Sources card opens GitHub pages (CLAUDE.md: a source's pages
are switched by the rail's tree or a link threaded down from it, never an in-page control of their own); the page's polled age at the right (the newest
`polledAt` over shown repos, on the existing one-second clock). The loading, `no token`, `pull requests unavailable` and `refresh failed` lines are unchanged
and sit where they are today, above or instead of the layout.

**Empty states**, the same in every layout and checked in this order: `no GitHub repo registered` tests the PAYLOAD's repo list (`data.repos`), never the
shown list, so it stays true; when the payload has repos but every one is no-access, the layout area says `no repo this token can read` (the toolbar's hidden
note carries the link); when shown repos exist but hold no open PR, Inbox and Matrix say `no open pull requests` (Cards keeps its per-repo line). That
sentence is distinct from the tile filter's `No pull request at this level.`, which is drawn only while a tile is selected.

### Inbox

- Three tiles: count and label with the level's dot. Clicking one filters to it; clicking it again clears the filter. Empty filter → `No pull request at this
  level.`
- **Loud list** (Needs you, Worth a look): one item per PR — dot, `#n` link, title, repo name; verdict; steps; `author · head → base · age`; and the PR's
  **compact keys** on the right (wrapping under on narrow). Decided by the user: two or three keys picked per PR by one `lib/` function, the primary key
  following the verdict (Update branch when behind, Merge… when ready, none primary when the verdict is something only GitHub or a reviewer can fix), plus
  `Open ↗`. A disabled key carries its block reason as visible text beside it, never hover-only (a phone has none). Clicking `Merge…` opens the full shared
  actions strip inline under the item — method select, Merge with its `Confirm` — so the compact keys are a front for the one actions component, never a
  second implementation of a write.
- **Quiet**: a `Quiet` heading, then one line per PR — dot, `#n`, title, repo, facts joined by ` · `. A quiet line's actions are reachable — the builder picks
  how (expand on click, as the dashboard's lines do with their keys, is the expected shape) — because a ready PR is exactly the one a person wants to merge.
- **Can't read** (transient failures): a heading, then one line per visible repo whose read is not `ok` — rate-limited or `error` — with its `detail`. This is
  the dashboard Inbox's `dead` group; no-access repos never appear here. Unlike the dashboard's `dead` level, the repo does NOT shrink to this line (my call):
  PR rows it still holds from an earlier read stay in the ranking, the tiles and the Matrix counts with their actions, exactly as Cards draws them today — a
  failed refresh is not a reason to stop offering a merge (anti-goal: lose nothing Cards has). The line is added on top. A rate-limited repo's writes are
  refused by the server as today; nothing new is blocked client-side.
- A shown repo read `ok` with no PRs draws nothing of its own in Inbox (Cards is where its per-repo line is read); when NO shown repo has a PR, see Empty
  states.

### Matrix

- Columns: dot · Pull request (`#n` title, sub-line `repo · head → base` plus the run warning when there is one, `draft` pill on drafts) · Checks · Review ·
  Mergeable · Base (up to date / behind / `updating…` while marked) · Auto-merge (method, live tone) · Updated (age).
- Cell tones: healthy, needs you, worth a look, in motion (pending / running / updating), not applicable (`—`). Colour only on failure; a header shows the
  count of rows whose cell in that column is needs-you or worth-a-look.
- A cell reports its own fact, independent of the row's level (my call): a draft with failing checks has a red Checks cell, counted in that header, while its
  dot says Quiet — the dot is the triage, the cells are the evidence. A `blocked` / `unstable` mergeState with no named reason shows in the **Mergeable**
  column as `blocked` / `unstable` in the worth-a-look tone; `unknown` mergeable shows `computing` in the in-motion tone.
- Rows in rank order. The whole row toggles one expansion beneath it holding the PR's actions (method select, Merge, Update branch, Auto-merge, Open on
  GitHub); one row open at a time; a click on a link or control inside the row does not toggle. Keyboard: the row is focusable and Enter/Space toggles, as
  in the dashboard (`keyActivate`).
- A visible repo with a transient failure draws one muted row spanning the check columns with its `detail`.
- A legend under the table.

### Cards

Today's `RepoSheet` list, minus no-access repos. Nothing else changes.

### What every layout carries

The `updating…` mark, the outcome line, the run warning, `sync off` (repo-level reason on every disabled action, and the sentence shown once — in Cards in the
repo head as today; in Inbox/Matrix the builder places it once per affected repo, e.g. as a step on each of that repo's PRs or a note row), and `showing n of
total` for a truncated repo (Inbox/Matrix: one note line under the list naming the repo). Outcome lines for PRs a write took off the list (merged) show in
Inbox/Matrix as status lines above the list, keyed `repo#n`, until the page is left — Cards keeps showing them in the repo's card.

The outcome line of a PR still ON the list (`auto-merge armed`, a 409/502 refusal) and its `updating…` mark are never inside a collapsed part: Inbox draws
them under the loud item or the quiet line, Matrix as a line beneath the row (outside its expansion) and the `updating…` in the Base cell. One small
component renders that line from `outcomeLine` (`lib/prs.ts`) and keeps the `pr-outcome` test id and `role="status"`; `PrRow` and both new layouts render it,
so the line is not part of the actions strip and is visible whether or not the strip is open.

## One actions component

Today `PrRow` owns the method select, Merge with its inline `Confirm`, Update branch, the auto-merge toggle, the `why` reasons and the busy state. Extract that
strip into one component that all three layouts render, fed by the same `onWrite` and `mergeBlock` / `updateBlock` / `autoMergeBlock` from `lib/prs.ts`.
`PrRow` keeps its row anatomy and renders it. The page (`PullRequestsView`) keeps owning `outcomes`, `marks`, timers and `write`, and hands them to whichever
layout is drawn — so switching layout mid-update keeps the mark.

## GitHub › Settings › Access

A second card in `GithubSettingsView`, beside `Sync` (DESIGN §8.6 card language; the mock puts it in a second column, folding at Settings' 1100 px).

- Drawn only when ≥1 repo is no-access. Title `Access` with a bad pill `N without access`.
- Lead: the token cannot read pull requests on these repos, so the PRs page leaves them out; each comes back on its own once it can.
- One row per no-access repo: name and `detail` in `--red` (no age, see below).
- A fix note naming the fine-grained token's repository access and two permissions: **Pull requests: Read and write** (the list, update branch and
  auto-merge) and **Contents: Read and write** (merge — the server merges through REST `PUT …/pulls/{n}/merge`, which GitHub files under Contents), and
  that the variable is `BM_GITHUB_TOKEN`. It never shows or hints at the token's value.
- A muted `N repos readable.` line.

**Where it reads from** (my call): the same `usePullRequests` hook, so it is the same request, the same 60 s cache and the same payload the PRs page reads;
mounting it on Settings costs at most one PR-list read per repo per minute while the page is open, the same as the PRs page. This changes a recorded fact:
five texts say `usePullRequests` is mounted only by GitHub › PRs and that this mount is the only thing that ever reads PRs: `.claude/rules/board.md` (the
`useCoalescedFetch` bullet), `docs/subsystems/invariants.md` (same section), the hook's own doc comment (`client/src/hooks/usePullRequests.ts`),
`PullRequestsView.tsx`'s header comment ("this page is its only mount") and `docs/subsystems/board.md`'s PRs paragraph ("mounted by this page alone"). The
plan rewrites all five to name both pages
(GitHub › PRs and GitHub › Settings); the bullet's headline is unchanged, so `test/claude-rules.test.ts` stays green, but the plan must run it. The property
the sentence protects — the PR cache has no timer, so PRs are read only while a page that shows them is open — still holds.

**No age on the rows** (settled): `PrRepoView` carries only `polledAt` (last *successful* read) and no attempt time, and this work adds no server field, so a
row shows the repo and its `detail` without a `checked … ago`. The mockup's age is dropped.

## Docs

`.claude/DESIGN.md` §8.11 rewritten for three layouts and the hidden-repo rule; §8 gains the Access card beside Sync's subsection; `docs/subsystems/board.md`'s
PRs paragraph; CLAUDE.md's Layout line for the GitHub section mentions the three layouts. Every new component cites its DESIGN subsection in a header comment
(CLAUDE.md). No invariant headline changes: the server is untouched and no new write exists. The one mechanism text that changes is the "`usePullRequests`
is mounted only by GitHub › PRs" fact, in the five texts the Access card section lists.

## Tests (cases, not code)

- `lib`: reach for each `access` value; level for each driving fact, a draft with failing checks is Quiet, a draft with `review-required` is Quiet, auto-merge
  armed + checks pending is Quiet, behind + approved is Worth a look; verdict and steps order; rank (level, then severity as defined, then newest);
  layout parse (unknown → inbox), drawable (narrow +
  matrix → inbox, stored value untouched), switcher options narrow vs wide; compact-key pick (behind → Update branch primary; ready → Merge… primary; failing
  checks → Merge disabled with `checks failing` shown); Matrix cell tone per fact (draft + failing → red Checks cell, Quiet dot; blocked → Mergeable
  `blocked`).
- View, failing repos: a rate-limited repo holding rows from an earlier read keeps those rows ranked with actions in Inbox and Matrix AND gets its
  `Can't read` line / muted row.
- View: no-access repos absent from all three layouts, `N open` excludes them, hidden note shows the right count and its link opens GitHub › Settings; a
  rate-limited repo still shows with its detail in each layout; switching layout persists and survives a reload; tile filter and clear; Matrix row toggle by
  click and by Enter, a click on the `#n` link does not toggle; an `updating…` mark survives a layout switch; empty states (no shown repo, no PR at all).
- Existing suite: jsdom is wide, so Inbox is drawn by default and `test/prs-view.test.tsx`'s Cards-anatomy cases (`pr-repo-*`, `pr-head-*`, `pr-outcome`
  inside `pr-row-<key>`, the merged line in the repo card) pin `cards` by writing the layout's storage key before render — they are not expected to pass
  untouched. The write cases (merge confirm `pr-merge-confirm`, auto-merge toggle, update branch, outcome `pr-outcome`) are re-run from Inbox and from Matrix;
  those test ids belong to the shared actions component and the shared outcome line, so they mean the same element in every layout.
- Settings: Access card absent when every repo reads; lists exactly the no-access repos with their detail; the fix note never contains a token value.

## Left to the builder

File split inside `components/github/`, CSS class names (`.prs-*` for layout only; every look a `ui/` primitive's, DESIGN guard 7), whether tiles/matrix
cells become `ui/` primitives (only if a second surface draws them), exact verdict strings, how a quiet line exposes its actions, where `sync off` sits in
Inbox/Matrix, the storage key name.

## Calls made by the author, not the user

Matrix row = one PR; levels Needs you / Worth a look / Quiet; hidden = `forbidden` + `not-found` only; tiles only, no repo filter; Inbox compact keys with
the full strip on `Merge…` — those five the user decided. These the author decided and the user should check: drafts always Quiet; armed auto-merge demotes
`checks pending` to Quiet; a failing-refresh repo keeps its rows ranked and actionable; cells report their own fact regardless of level; the Access card
mounts `usePullRequests` (rule text updated in three places); Access rows carry no age.
