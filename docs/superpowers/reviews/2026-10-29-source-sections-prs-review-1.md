# Review 1 — `docs/superpowers/plans/2026-10-29-source-sections-prs.md` against the spec and the code

Reviewer: fresh subagent (Fable), 2026-10-29. Spec: `docs/superpowers/specs/2026-10-29-source-sections-design.md` (the GitHub › PRs parts). Every code claim
below was checked in the worktree at `92dae5a`.

## Verdict: APPROVE WITH FIXES

Three Important findings, all local to Tasks 1–2; no Critical. Coverage is complete, the interfaces chain in order, the fixtures discriminate, and the plan keeps
its own "behaviour, not code" convention throughout.

## 1. Coverage — spec section → task

| Spec section (PR parts) | Task |
| --- | --- |
| Decided: "GitHub › PRs lists all open PRs … forks and other authors included" | T2 (`states: OPEN`, no author filter), T3 |
| Decided: "warned about, not refused" + the branch-naming derivation, ONE `lib/` function | T5 `prRunWarning`, T7 warning chip with actions enabled |
| Decided: "GitHub-registered projects only" | T3 (`github`-source projects of the registry) |
| Goal 2 (state visible before acting; merge / auto-merge / update branch) | T2 `toRow`, T5 `prChips`, T4 writes, T7 |
| Constraint: outbound calls in `server/src/tracker/` only | Global constraints :28, T2–T4 file paths |
| Constraint: the server's writes are enumerated; new headline in three homes | T4 :250-253 |
| Constraint: guarded POSTs, serialised per PR, `agents-origin-guard` set | T4 :37, :225, :248 |
| Constraint: the token never leaves the server | Global :28-29 |
| Constraint: the poller is armed only while something is connected | Global :30, T3 `no read without a request` |
| Constraint: rendered cache ages headline becomes three | T3 :189-191 |
| Constraint: sync-off refuses writes, list still read, `syncOffBlock` the one home | Global :39, T3 :183, T4 :241 |
| Constraint: token permissions, docs and `.env.example` | T4 :204-205 |
| Constraint: tailnet allowed | T4 :246 |
| Constraint: the server never writes git | T4 :252 |
| Constraint: `DESIGN.md`, Escape owner, `--main-gap` | T7 :337, :371-372 |
| Left to builder: PR list freshness (60 s TTL, no sweep, one GraphQL query, separate pools, per-repo sleep, client 60 s poll) | T2, T3, T6 |
| Left to builder: write outcomes (`updating…` 30 s, 422 fork, 405/409, already merged, auto-merge noop, lacks-permission) | T4 :214-224, T5 `outcomeLine`, T7 :366 |
| Left to builder: merge method order and default | T2 `MERGE_METHODS`, T5 `defaultMethod` |
| Left to builder: update-branch is merge-base-into-head | Global :34-35 |
| Left to builder: layout (grouped by repo, newest first, disabled reason says why) | T5 `groupRepos`, T7 |

The spec has no enumerated test cases; every named behaviour above has a test in the task that owns it. The plan's five Review Focus items each name a test
that exists in the plan (:53-65 → :129, :181, :174-175, :231, :299, :293, :241, :362).

## 2. Values

Every copy string checked against the spec: `sync is off for <repo> — turn it on in GitHub › Settings` (spec :121, code `poller.service.ts:523`), `fork does
not allow edits`, `already up to date`, `auto-merge not enabled on the repo`, `draft`, `checks failing`, `not mergeable` (spec :181-182), `updating…` (spec
:171), `already merged` (spec :175), `the token lacks permission for this` + GitHub's message (spec :178), 30 s window, 60 s TTL, 60 s poll, squash/merge/rebase
order (spec :179). All match.

## 3. Reality

Every Create path is absent and every Modify path exists (checked by `ls`). Cited lines: `handleFailure` :927-983 ✓, `SECONDARY_BACKOFF_MS = 60_000` :74 ✓,
`syncOffBlock` :518 ✓, `platform()` :346 ✓, `GUARDED` :146-170 ✓, `bodyFor` :100-141 ✓, `allowed-hosts.test.ts:151-168` ✓, CLAUDE.md :45, :59-60, :137-139,
:160-161, :174 ✓, `rules/tracker.md` :84, :105 ✓, `invariants.md` :3508, :3718 ✓, `overview.md` :86 ✓ (see Minor), `api.md` :115 ✓, `.env.example` :94-116 ✓,
`source-page.ts` reserves `prs` ✓, `SideRail.tsx` :213-222, :472 ✓, `App.tsx` :32, :188-196, :369-371 ✓, `source-page.test.ts` :33-35 ✓, `rail.test.tsx` :344-350
✓, `DESIGN.md` last is §8.10 so §8.11 is next ✓, `UNLINKED_WORD_CAP = 80` ✓, `useRefreshing(task, { armed, intervalMs })` ✓, `pollAge`, `claimReading`,
`queueItemIs`, `errorOf`, `postJson`, `PillTone`, `Confirm`, `Select`, `Band` all exported ✓, `RemoteStarting { kind, project, machine, itemId }` ✓,
`StartingRun { project, requestedAt }` ✓ (ruling :380 correct), `RemoteRun extends OrchestratorRun` with `repo` ✓, `ItemHolder.heartbeat` ✓.

## Findings

### Important

- **[I] plan:88 — Task 1's two-repo poller assertion cannot pass against today's fake.** `FakeGithub.route` pins every REST path to `FAKE_REPO`
  (`test/helpers/github.ts:238-243`) and answers `404 Not Found` for anything else (`test/helpers/github.ts:340`), so a sweep over `futin/y` records
  `not-found`, never `ok`, and Task 1's Files (:71-73) do not list the helper. → Add `test/helpers/github.ts` to Task 1's Modify list and say the REST
  issue/comment routes become per-repo (keyed by the path's `owner/name`), or keep Task 1's poller assertion single-repo and move the two-repo REST fixture to
  Task 2, where the fake is already being extended.
- **[I] plan:120 — "the caller treats `error !== undefined` as a failure" is always true.** `GithubResponse.error` is `string | null`
  (`server/src/tracker/github.client.ts:67`, set at :335-349), never `undefined`. → `error !== null`.
- **[I] plan:140 — "`refuseRepo` guards the repo argument as the REST calls do", but `graphql` has no repo argument.** The Produced signature at :117 is
  `graphql<T>(query, variables, opts: { token })`; an implementer must guess whether to add a `repo` parameter (changing what Task 3 consumes) or guard
  elsewhere. → State the home: the list and single-PR builders in `pulls.query.ts` take `repo`, refuse via `isRepo` (`github.client.ts:38`) before the
  owner/name split, and `graphql` itself stays repo-agnostic.

### Minor

- plan:225 — `GithubSource.serialise` is at `server/src/items/sources/github.source.ts:1281-1292` (correct line); the plan gives no directory and the task's
  other files are all under `server/src/tracker/`, so name the full path.
- plan:325 — the `useRefreshing` reader list is `.claude/rules/board.md:143-146`, not ≈ :121-124 (that is the `useOrchestratorRuns` bullet). The list does
  still name readers, so the step applies.
- plan:72 — `RepoState` opens at `poller.service.ts:158`; `sleepUntil` is :232. Cosmetic.
- plan:290 — "three repos" then lists four (`futin/x`, `futin/y`, `futin/a`, `futin/b`).
- plan:150 — `docs/overview.md` carries the two-caches wording twice, :86 ("one of the two caches") and :90 ("the second cache whose age is"); both need
  the edit.
- plan:219 — "repo asleep (PR cache or poller)": Task 1 exposes only `secondaryUntil`; the poller's primary `sleepUntil` stays private (`RepoState`,
  :232). Say "the PR cache's `sleepUntil` or the poller's `secondaryUntil`" as :163 does, or the ladder reads as needing a getter Task 1 never produces.
- plan:317-318 vs spec:167 — the spec names `useCoalescedFetch` at a fixed 60 s; `useRefreshing` adds mount + window-focus triggers. The repo rule
  (`.claude/rules/board.md:143-146`) makes `useRefreshing` the required entry layer, so the plan is right — say the focus refresh is deliberate, and keep
  Task 6's "none at 59 s" assertion away from a focus event.
- plan:175 — `no read without a request` passes against any implementation that lacks a timer; it pins the absence of a mechanism rather than a behaviour.
  Acceptable as a guard against a future sweep; it is not a behaviour test.
- plan:239 — a REST merge's primary rate limit sleeps the PR cache's repo, whose reads are GraphQL (a separate pool per :31). A deliberate choice, but the
  constraint only says secondary limits sleep both; give it one line in the Task 4 invariants entry.
- plan:37 — `jira-write.controller.ts` is POST-only (`server/src/jira/jira-write.controller.ts:64-134`); the per-route `@UseGuards` pattern holds, but the
  parenthetical "since the controller also has a GET" describes `PullsController`, not the pattern's source. Reword.
- plan:358 — `pollAge` returns `12 s` (`client/src/lib/tracker.ts:42`); `polled 12 s ago` is the view's composition around it. Fine, say so.

## 4. Interfaces, 5. Order, 6. Tests, 7. Conventions

- Interfaces: `failureVerdict`, `noteSecondary`, `secondaryUntil` (T1) → T3; `graphql`, `pulls.query.ts`, `MergeMethod`, `MERGE_METHODS`, `PullRequestRow`
  (T2) → T3, T5; `PrRepoView`, `PullRequestsPayload`, `PullRequestsService.list/splice` (T3) → T4, T6, T7; `PrWriteResult` (T4) → T5 `outcomeLine`, T6;
  `lib/prs.ts`, `lib/pr-run.ts` (T5) → T7; `usePullRequests` (T6) → T7. Spellings and types agree everywhere checked.
- Order: no task consumes a later task's output; each task's Step 4 runs the suites the task touched; typecheck before each commit.
- Tests: every Step 1 names a symbol or route that does not exist yet, so each suite fails red. Fixtures use two repos (`futin/x`, `futin/y`), distinct
  PR numbers, SHAs, authors and timestamps; per-repo logic (sleep, sync-off, methods, truncation) and per-PR logic (serialisation, splice, `isUpdating`) are
  each exercised with two keys. The one exception is the Important finding on Task 1's REST fixture.
- Conventions: behaviour and values only, no literal code; budgets stated soft (:7); prose wraps at 160 (:48); comment density named (:48).
