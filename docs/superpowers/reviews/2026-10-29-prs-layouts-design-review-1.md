# Review 1 — `docs/superpowers/specs/2026-10-29-prs-layouts-design.md`

Reviewer: Fable 5.1, fresh session, 2026-10-29. Checklist: facts vs code, internal consistency, edge cases, copy, scope, CLAUDE.md / `.claude/rules/board.md`.
Repo: `.claude/worktrees/prs-layouts` (branch adds only the spec, so the main worktree's CodeGraph index is current).

## Verdict: APPROVE WITH FIXES

No Critical finding. The data story, the server facts and the rule-text change are accurate; what remains are gaps an implementer would have to guess at, one
false user-facing fact, and a test-compatibility claim that cannot hold as written.

## Facts verified (no finding)

- Spec:50 payload chain `PullRequestsPayload → PrRepoView[] → PullRequestRow[]` — `shared/types.ts:599,635,660`.
- Spec:51 live fact — `curl /api/prs` on this machine today: `futin/ixray`, `futin/brickwright`, `futin/lookout` answer `access: 'forbidden'`, `detail:
  'Resource not accessible by personal access token'`; eight repos registered.
- Spec:52 `FORBIDDEN → 403 → forbidden` — `server/src/tracker/github.client.ts:98` (`GRAPHQL_STATUS`), `poller.service.ts:199` (401/403 → `forbidden`,
  `sleepUntil: null`), `:204` (404 → `not-found`, no sleep).
- Spec:53 a failed read counts against the TTL — `pulls.service.ts:401-404` (`last = max(polledAt, attemptedAt)`), `:417` (`attemptedAt = now` on every read).
- Spec:56 a failed read keeps the last rows — `pulls.service.ts:422-431` sets `access`/`detail` only; `entry.prs` untouched.
- Spec:171 `PrRepoView` has `polledAt` only, no attempt time — `shared/types.ts:639`; `attemptedAt` is on the entry (`pulls.service.ts:417`), not the view
  (`:481-505`).
- Spec:89-90 `usePersistedState` (`client/src/hooks/usePersistedState.ts`), `backlog-manager.` prefix (`lib/runs-mode.ts:37` and six more), `useNarrow` at 700 px
  (`hooks/useNarrow.ts:22`).
- Spec:96 the threaded link — `App.tsx:284` `onOpenGithubPage` sets the page store then changes section; today it reaches `SettingsView` only (`:395`), and
  `PullRequestsView` gets only `onWorking` (`:373`), so the builder adds the prop.
- Spec:148-150 `PrRow` owns select / Merge+`Confirm` / auto-merge / Update branch / `why` / `busy` (`PrRow.tsx:60-181`); the page owns `outcomes`, `marks`,
  timers, `write` (`PullRequestsView.tsx:77-137`).
- Spec:155 Settings folds at 1100 px — `client/src/styles.css:899`. Spec:159 `--red` — `shared/theme.css:32`. Spec:157 `bad` tone — `ui/Pill.tsx:3`.
- Spec:166-167 the three named texts do say it: `.claude/rules/board.md:145` ("mounted only by GitHub › PRs … the only thing that ever reads PRs"),
  `docs/subsystems/invariants.md:4709` ("an eighth on the same terms for GitHub › PRs"), `hooks/usePullRequests.ts:16` ("Mounted ONLY by that page").
- Spec:14-16 dashboard reference files and `drawableGitLayout` (`claude-agents-dashboard/client/src/lib/gitLayouts.ts:43`), spec §4.3 at line 128 and §4.4 at
  line 143 — all present.
- Spec:7 "#394" — `git log`: `1dc3565 feat(client): per-source rail sections and GitHub › PRs page (#394)`.
- Spec:198 "DESIGN guard 7" — `test/design-guards.test.ts:308`.
- Spec:116-117 a rate-limited repo's writes refused server-side — `pulls.service.ts:306-307` (429 while asleep); an `error` repo sets no sleep so its writes
  go through, as the spec implies by "nothing new is blocked client-side".

## Important

### I1. Spec:160 — the fix note names the wrong permission for merge
The note says the token needs **Pull requests: Read and write** and that "write is what the three writes need". GitHub's fine-grained-token permission table
(docs.github.com, *Permissions required for fine-grained personal access tokens*, fetched today) lists `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`
under **Contents: write** only, and `…/update-branch` under **Pull requests: write**. The server merges through exactly that REST call
(`server/src/tracker/github.client.ts:356`). A person who follows the note as written regains the PR list and then gets
`502 the token lacks permission for this — …` (`pulls.service.ts:334`) on every Merge. The repo has no other doc stating the token's permission set
(grep for `fine-grained`/`Contents` finds only `invariants.md:3826` and `pulls.service.ts:322`, both saying write permissions cannot be read back), so this
note would be the only one.
→ Name both: **Pull requests: Read and write** (list, update branch, auto-merge) and **Contents: Read and write** (merge). Keep "never shows the token's value".

### I2. Spec:68-73 and :205 — the level rules contradict "drafts always Quiet"
Lines 68-73 say "first match wins" and list Worth a look as `behind` / `review-required` / `pending` / `unknown` / `blocked`-`unstable` with no draft
exclusion; only Needs you says "A draft is never Needs you". A draft with `review: 'review-required'` or `checks: 'pending'` (both GitHub reports on drafts;
`shared/types.ts:622-624`) therefore lands in Worth a look under the rules as written, while line 73 ("drafts (whatever their checks say)") and line 205
("drafts always Quiet") say Quiet. The test case at line 183 covers only draft + failing checks, so the gap would not be caught.
→ Make `draft → Quiet` the first rule of the ordered list (before Needs you), and add the test case "draft + review-required is Quiet".

### I3. Spec:118, :101-134 — no empty state when every shown repo has zero PRs
Line 118 says a shown `ok` repo with no PRs draws nothing in Inbox, and Cards is where `no open pull requests` is read. With every shown repo empty — the
state the live payload is in today (eight repos, zero open PRs) — Inbox is three `0` tiles over nothing, and Matrix is a header row and a legend. Nothing in
the page section names this state, and the anti-goal at line 41 ("a layout that loses something Cards shows today") lists readings Cards gives but this is
one it gives too (`PullRequestsView.tsx:171` `no open pull requests` per repo).
→ State the empty copy for Inbox and Matrix when the shown repos hold no PR at all (one sentence under the tiles / in place of the table), distinct from the
filtered-empty `No pull request at this level.`

### I4. Spec:63, :95, :137 — what the page says when every repo is no-access
`PullRequestsView.tsx:155` draws `no GitHub repo registered` when `repos.length === 0`. Once no-access repos are filtered out of the layouts
(spec:63 "every layout … read this one function"), a machine whose every repo is forbidden has zero shown repos and would print that sentence — false, since
repos are registered. The toolbar's `N repos hidden — no access` (spec:95) would stand beside it. The spec does not say which list `no GitHub repo registered`
tests against.
→ State that `no GitHub repo registered` tests the payload's repo list, not the shown list, and what the layout area draws when shown repos are zero but hidden
repos are not (the hidden note alone is enough; say so).

### I5. Spec:141-144 — where a still-listed PR's outcome line sits in Inbox and Matrix
Today the outcome line for a PR that is still on the list (`auto-merge armed`, `updating…`, a 409's `Head branch was modified…`, a 502's `the token lacks
permission…`) is drawn by `PrRow` under its actions (`PrRow.tsx:71`, `:175-179`); the page only takes over the line for a PR the re-read removed
(`PullRequestsView.tsx:200-203`). Spec:141 says every layout carries "the outcome line", and :143-144 place only the *departed* lines ("PRs a write took off
the list"). In Inbox the actions strip is open only after `Merge…` (spec:108-110) and a quiet line's actions are collapsed (spec:111-112); in Matrix the row is
collapsed by default (spec:129). An auto-merge toggled from a compact key, or a refusal, has no stated home in either layout — and the test at :193 (an
`updating…` mark survives a layout switch) needs one to assert against.
→ State where a listed PR's outcome line is drawn in Inbox (on the item, under the keys, whether or not the strip is open) and in Matrix (in the row's sub-line
or in the expansion, and whether a refusal opens the expansion), and whether the extracted actions component owns the line or each layout places it.

### I6. Spec:192 — "existing write tests pass unchanged" cannot hold with Inbox as the default
`test/prs-view.test.tsx` renders `PullRequestsView` and asserts Cards' anatomy throughout: `pr-repo-*` order (:181-182), `polled 12 s ago` in a repo card
(:207), `showing 100 of 140` in a repo card (:215), `no open pull requests` (:222), `pr-head-*` (:315), and the write cases find `pr-outcome` *inside*
`pr-row-<key>` (:254, :289, :366) and the departed `#12 merged` inside `pr-repo-futin/y` (:265). With `inbox` the default (spec:20, :89) and jsdom's
`matchMedia` absent (`useNarrow.ts:41` → wide), none of those elements exist on first render, so the suite goes red before a single new case is written. The
spec says nothing about seeding the layout in those tests, and "driven from Inbox and Matrix" presumes the new layouts emit the same test ids and place the
outcome where :254 looks for it (see I5).
→ State that the existing Cards cases pin the layout to `cards` through the storage key before render (a helper, not a rewrite), and that the write cases
are re-run under Inbox and Matrix against test ids the shared actions component owns (`pr-merge-confirm`, `pr-outcome` — name them).

### I7. Spec:166-167, :178-179 — the "mounted only by GitHub › PRs" fact lives in five texts, not three
Besides `.claude/rules/board.md:145`, `invariants.md:4709` and `usePullRequests.ts:16`, the same claim is in `client/src/components/github/PullRequestsView.tsx:43`
("this page is its only mount — leaving the page is what stops PR reads") and `docs/subsystems/board.md:483` ("mounted by this page alone"). The Docs section
(:176) lists `board.md`'s PRs paragraph for the layouts rewrite, but not for this fact, and the view's comment is named nowhere; the spec calls the three
"all" (:167).
→ List all five, or say "every text that states it (grep `only mount` / `mounted only` / `this page alone`)" so the plan's edit map is complete.

### I8. Spec:85 — "problem severity within the level" has no definition
Rank is "level, then problem severity within the level, then newest `updatedAt`". Severity is not defined anywhere: the level rules (:70-72) list facts in an
order, and :77 says problems are "an ordered list", but neither says that order is the rank key, nor how a PR with two Needs-you facts (failing checks AND
conflicting) ranks against one with one. The test at :184 asserts "rank (level, then severity, then newest)" and so needs a value.
→ Define severity as the index of the PR's first problem in the level's listed order (ties by `updatedAt`), or as the count of level-driving facts — one rule,
stated once.

## Minor

- M1. Spec:106-108 — the compact-key pick names the primary key and `Open ↗` but not which second key is drawn (auto-merge toggle? `Update branch` when not
  primary?). "Two or three keys" leaves the table to the builder; a 3×N table (verdict → keys) would make :185-186 testable without guessing.
- M2. Spec:132 — the Matrix's muted failure row for a transient-failure repo has no stated position (top, bottom, beside that repo's first row).
- M3. Spec:162 — `N repos readable.` does not say whether a rate-limited or `error` repo counts as readable (by the reach rule at :63 it does; say so, or
  count `ok` only).
- M4. Spec:95, :157 — `N repos hidden — no access` and `N without access` need their singular (`1 repo hidden`), as every count on this board has.
- M5. Spec:105 — the loud item's `author`: Cards prints `ghost` for a `null` author (`PrRow.tsx:97`, DESIGN §8.11); say Inbox/Matrix do the same.
- M6. Spec:97 — "the newest `polledAt` over shown repos" is the most recent read; with every repo read in one `Promise.all` (`pulls.service.ts:167`) the values
  are near-equal, but a repo added later or one just woken from a sleep makes the page age younger than most cards. Fine as a call; say it is the newest on
  purpose.
- M7. Spec:130-131 — `keyActivate` exists only in the dashboard (no match under `client/src`); the builder writes one here or inlines the two keys. Already
  implied by "as in the dashboard"; one word ("ported") would stop a search.
- M8. Spec:90-91 — under narrow, with `matrix` stored, the switcher shows Inbox selected; a click on Inbox then writes `inbox` and the stored `matrix` is
  gone. Not wrong, but :91 "the stored value survives" reads as absolute; qualify with "until a pick".
- M9. Spec:98 — the four status strings are paraphrased in backticks (`no token`, `refresh failed`); the exact copy is `no token — set BM_GITHUB_TOKEN in
  .env and restart`, `loading…`, `pull requests unavailable — <error>`, `refresh failed — <error>` (`PullRequestsView.tsx:18,145-152`). "Unchanged" covers it.
- M10. Spec:3 — the mockup link is a claude.ai artifact; the review did not open it, so differences between mock and spec (:172 says the age is dropped)
  are taken from the spec's own call-outs.

## Scope and rules (no finding)

- Non-goals are explicit (:31-37); nothing in scope depends on them. The server is untouched (:35) and the review found nothing that needs a route — the
  Access card's "no age" (:171) is the one place a server field would have helped, and the spec settles it the other way.
- CLAUDE.md: derivations in `lib/` (:46, :59), one actions component (:45), `useNarrow` not a literal (:90), link threaded from the rail (:96), no in-page
  page switch, DESIGN citation per component (:177), guard 7 (:198) — all respected. The `.claude/rules/board.md` bullet's headline is unchanged, so
  `test/claude-rules.test.ts` holds (:168).
- Escape: the Matrix expansion is not a dialog and binds no key; `Confirm` still joins `useDialogEscape` itself (`PrRow.tsx:31`). Fine.
