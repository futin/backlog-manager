# Source Sections — GitHub › PRs (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan states behaviour and exact test cases, never literal code** (the global CLAUDE.md overrides writing-plans' "code blocks required"). Signatures,
> values and edge cases are binding; bodies are the implementer's. Disagree with the plan where the code proves it wrong, and say so in the task's report.
> Size budgets anywhere in it are soft.

**Goal:** Spec Goal 2 — a `GitHub › PRs` page (between Board and Archive) that lists every open pull request on the registered GitHub repos, forks and other
authors included, shows each PR's draft / review / checks / mergeable / behind-base / auto-merge state, warns (never refuses) when a live or paused run, a
starting entry or a live claim is still working its branch, and lets a person merge, arm or disarm auto-merge, and update the branch.

**Architecture:** All GitHub traffic stays in `server/src/tracker/`. `GithubClient` gains one `graphql` call, whose rate is a separate pool from REST's. A new
`PullRequestsService` keeps a per-repo, on-demand cache (60 s TTL, no timers) filled by ONE GraphQL query per repo, sleeps a repo by the poller's own failure
rule (extracted as a pure `failureVerdict`), and runs the three writes serialised per `<repo>#<number>`, each followed by a single-PR re-read spliced into the
cache. A new `PullsController` exposes `GET /api/prs` and three guarded POSTs. The client adds a lazy `PullRequestsView` polled at 60 s while mounted; every
derivation (chips, disabled reasons, default method, the `updating…` window, grouping, and the run warning) is a pure function in `client/src/lib/`.

**Tech Stack:** NestJS server, React 18 + Vite client, jest (jsdom for `.tsx` suites), pnpm. GitHub GraphQL v4 for reads and auto-merge; REST for merge and
update-branch.

**Spec:** `docs/superpowers/specs/2026-10-29-source-sections-design.md` — "Decided by the person" (PRs list, warn-not-refuse), Goal 2, the PR parts of
"Constraints from the repo", and "Left to the builder" (PR list freshness, write outcomes, merge method, update-branch meaning, layout). Plan A
(`2026-10-29-source-sections-rail.md`) has landed: `GITHUB_PAGES` is `['board','archive','settings']` and its header comment reserves `prs` for this plan.

## Global Constraints

- GitHub calls live in `server/src/tracker/` only — no fourth outbound-calling module. The token is read per call through `githubToken()`
  (`token.util.ts`) and never appears in any answer.
- The PR cache has NO timer, interval or sweep. A read happens only inside a `GET /api/prs` or a write. Nothing reads PRs while nobody is on the page.
- One GraphQL query per repo for the list; GraphQL's primary rate limit is recorded apart from REST's, so `GithubClient.rate` (the Sources card's read-out via
  `poller.platform()`) never moves on a GraphQL answer. A secondary limit on either sleeps both the poller's repo and the PR cache's repo.
- Rate limits, `Retry-After` and secondary limits are VALUES in the response, never thrown, never slept on inside the client.
- The writes are exactly three: merge (`PUT /repos/{repo}/pulls/{n}/merge`, body `merge_method` + `sha`), update-branch (`PUT .../update-branch`, body
  `expected_head_sha`; GitHub's merge-base-into-head, not a rebase), and auto-merge (GraphQL `enablePullRequestAutoMerge` / `disablePullRequestAutoMerge`).
  The server never runs git for any of them.
- Every POST carries `@UseGuards(SameOriginPostGuard)` per route (the `jira-write.controller.ts` pattern, since the controller also has a GET) and passes the
  Host allowlist like every route — tailnet hosts included, no loopback-only rule.
- Sync-off comes from `poller.syncOffBlock(projectPath)` alone (the ONE home of the sentence `sync is off for <repo> — turn it on in GitHub › Settings`); a PR
  write resolves its repo to a registered github project's path and asks it. No copy of the sentence on the server.
- Write ids: `<repo>#<number>` is the serialisation key; the PR's GraphQL node id never leaves the server.
- Fixtures discriminate: two repos (`futin/x` = `FAKE_REPO`, `futin/y`), distinct numbers, titles, heads, SHAs, authors and timestamps per PR, so a swapped
  or unscoped field fails an assertion.
- Every new component cites its `.claude/DESIGN.md` subsection (§8.11, added in Task 7) in a header comment; derivations live in `client/src/lib/`, shared
  looks in `components/ui/` (reuse `Pill`, `Chip`, `Band`, `Select`, `Confirm` — no new ui piece unless a second surface draws it).
- A headline changed or added in CLAUDE.md is byte-equal in `docs/subsystems/invariants.md` (heading, no trailing period) and its `.claude/rules/*.md`
  bullet, in the SAME commit as the code it governs (`test/claude-rules.test.ts`). An unlinked CLAUDE.md bullet stays ≤ 80 words (`UNLINKED_WORD_CAP`).
- Comments explain why, at the repo's existing density; new prose wraps at 160 columns.
- Run only the suites a task touches (`pnpm run test:jest -- <files>`); CI runs the full suite. `pnpm run typecheck` before each commit.

## Review Focus

1. **A GraphQL rate exhaustion moves the REST read-out.** A GraphQL answer with `x-ratelimit-remaining: 0` must leave `client.rate` (REST) exactly as the
   last REST answer set it, and a secondary limit from a PR read must sleep the poller's repo too. → Task 2, test `graphql rate is its own pool`; Task 3,
   test `a secondary limit on a PR read sleeps the poller's repo`.
2. **Two tabs, or a burst of GETs, multiply GraphQL calls.** Three concurrent `GET /api/prs` with a stale entry make ONE query per repo; a fresh entry makes
   none; with the page closed nothing is read, ever. → Task 3, tests `concurrent reads share one query per repo` and `no read without a request`.
3. **A double-clicked or raced merge reads as an error.** Two concurrent merges of one PR run one after the other (never overlapping), and the second answers
   `200 already-merged`. → Task 4, test `a second merge of the same PR reads as already merged`.
4. **The run warning over-reaches.** An earlier run's still-open `backlog/run-*` PR is NOT warned while a later run is live, `backlog/42` on `futin/y` is not
   warned by a run on `futin/x`, and a fork head is never warned. → Task 5, tests `run branch warns only on the exact live base` and `ids are scoped to the
   repo`.
5. **A sync-off repo either vanishes or still writes.** Its PRs are still listed (with `syncOff` set and every action disabled `sync off`), and each POST on it
   answers `409` with the sentence and makes zero outbound calls, while the other repo's writes go through. → Task 4, test `sync off refuses every PR write
   and lists the PRs`; Task 7, test `sync-off repo disables all three actions`.

---

### Task 1: `failureVerdict` — the poller's failure rule as one pure function, plus a shared secondary sleep

**Files:**
- Modify: `server/src/tracker/poller.service.ts` (`handleFailure` ≈ :927-983 applies the new function; `RepoState` ≈ :200-240 gains `secondaryUntil`)
- Modify: `test/helpers/github.ts` — `FakeGithub.route` pins every REST path to `FAKE_REPO` (≈ :238-243) and 404s any other repo (≈ :340); add
  `addRepo(repo)` so a second registered repo's REST reads (`labels`, `issues`, `issues/comments`) answer `200` with empty lists — `FAKE_REPO` keeps its
  issues, an unregistered repo still 404s. Task 2 extends the same helper with PR routes.
- Test: `test/tracker-failure-verdict.test.ts` (new); `test/tracker-poll.test.ts` (unchanged; run to prove behaviour held)

**Interfaces:**
- Produces:
  - `failureVerdict(res: GithubResponse<unknown>, now: number): { access: Access; detail: string; sleepUntil: number | null; secondary: boolean } | null` —
    exported, pure; `null` for a 2xx/304. Carries today's rules unchanged: secondary limit → `sleepUntil = now + SECONDARY_BACKOFF_MS`, `secondary: true`;
    403/429 with `rate.remaining === 0` or a `retryAfter` → sleep until the reset / `now + retryAfter`; 401/403 otherwise → forbidden; 404 → not-found;
    anything else (status 0 included) → error. `access`/`detail` strings are byte-identical to what `handleFailure` writes today.
  - `TrackerPollerService.noteSecondary(repo: string, untilMs: number): void` and `secondaryUntil(repo: string): number | null` — the poller's sweep treats
    `secondaryUntil` like `sleepUntil` (no request before it); `noteSecondary` never shortens an existing sleep.

- [ ] **Step 1: Write the failing tests** — `failureVerdict` at `now = 1_700_000_000_000`: `200` → `null`; `304` → `null`; `secondary: true, status 403` →
  `sleepUntil = now + 60_000`, `secondary: true`; `403` with `rate {remaining: 0, reset: 1_700_000_900}` → `sleepUntil = 1_700_000_900_000`,
  `secondary: false`; `429` with `retryAfter: 30` → `sleepUntil = now + 30_000`; `403` with `remaining: 12` → forbidden, `sleepUntil: null`; `401` →
  forbidden; `404` → not-found; `502` → error; `status: 0` → error. For each non-null case, `access`/`detail` equal what a poller sweep records for the same
  response today (assert through a poller fed the same fake answer — two repos, `futin/x` failing, `futin/y` 200, so `futin/y`'s state must stay `ok`).
  `noteSecondary('futin/x', now + 60_000)` then a sweep at `now + 1_000` makes no request for `futin/x` and one for `futin/y`; a later
  `noteSecondary('futin/x', now + 10_000)` does not shorten the sleep.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/tracker-failure-verdict.test.ts` — FAIL.
- [ ] **Step 3: Implement** — move the rule's body into `failureVerdict`; `handleFailure` becomes "apply the verdict to the state" with its side effects
  (stamps, logging) unchanged. A secondary verdict in `handleFailure` also calls `noteSecondary` on its own repo, so both callers share one path.
- [ ] **Step 4: Run** the new suite and `test/tracker-poll.test.ts test/tracker-sync-interval.test.ts test/tracker-write.test.ts` — PASS. Typecheck clean.
- [ ] **Step 5: Commit** `refactor(server): extract the tracker failure rule as failureVerdict`.

### Task 2: `GithubClient.graphql`, the PR queries and mutations, and the fake GitHub's PR surface

**Files:**
- Modify: `server/src/tracker/github.client.ts`, `test/helpers/github.ts`
- Create: `server/src/tracker/pulls.query.ts` (the list query, the single-PR query, the two mutations, and `toRow` mapping a GraphQL PR node to
  `PullRequestRow`)
- Modify: `shared/types.ts` (PR shapes below)
- Test: `test/github-graphql.test.ts` (new)

**Interfaces:**
- Produces (`shared/types.ts`):
  - `type MergeMethod = 'squash' | 'merge' | 'rebase'`; `MERGE_METHODS: readonly MergeMethod[] = ['squash','merge','rebase']` (that order is the default
    order).
  - `PullRequestRow { number; title; url; author: string | null; draft: boolean; head: string; headSha: string; base: string; crossRepository: boolean;
    maintainerCanModify: boolean; updatedAt: string; mergeable: 'mergeable' | 'conflicting' | 'unknown'; mergeState: string /* lowercased
    mergeStateStatus */; review: 'approved' | 'changes-requested' | 'review-required' | null; checks: 'success' | 'failure' | 'pending' | 'none';
    autoMerge: { method: MergeMethod; enabledAt: string } | null; canUpdateBranch: boolean }`.
  - Mapping: `checks` from the last commit's `statusCheckRollup.state` — `SUCCESS`→`success`, `FAILURE`/`ERROR`→`failure`, `PENDING`/`EXPECTED`→`pending`,
    no rollup → `none`. `mergeable` `MERGEABLE`/`CONFLICTING`/`UNKNOWN`. `review` `APPROVED`/`CHANGES_REQUESTED`/`REVIEW_REQUIRED`/null. A deleted author
    (`author: null`) → `null`.
- Produces (server): `GithubClient.graphql<T>(query: string, variables: Record<string, unknown>, opts: { token: string }): Promise<GithubResponse<T>>` —
  POSTs `https://api.github.com/graphql`; never throws. A 200 whose body carries `errors` sets `error` to the first message joined; an error of
  `type: 'RATE_LIMITED'` is reported as `status: 429`; `type: 'FORBIDDEN'` as `403`; `type: 'NOT_FOUND'` as `404`; other typed errors keep `200` with
  `error` set (the caller treats `error !== null` as a failure — `GithubResponse.error` is `string | null`). `client.graphqlRate` holds GraphQL's `x-ratelimit-*`; `client.rate` is untouched by
  it.
- `FakeGithub` gains: `pulls: Map<repo, FakePr[]>` with an `addPr(repo, partial)` helper, a `/graphql` route answering the list query (open PRs of the
  requested repo, ordered by `updatedAt` desc, `first: 100`, `totalCount`), the single-PR query (any state), and both mutations; `PUT .../pulls/:n/merge`
  (moves the fake PR to `MERGED`; `405` when it is already merged or `sha` mismatches with `409`); `PUT .../update-branch` (`202`, moves `headSha` to a new
  value); `failNext` works on `/graphql` with an optional `graphqlError: { type, message }` (a 200 with `errors`); `calls` records `/graphql` with the
  operation name so a test can count list vs single reads; a `maxConcurrent` per `<repo>#<n>` write counter.

- [ ] **Step 1: Write the failing tests** —
  - `graphql rate is its own pool`: a REST `issues` answer with `remaining: 4000`, then a GraphQL answer with `remaining: 0` → `client.rate.remaining` is
    `4000`, `client.graphqlRate.remaining` is `0`.
  - `errors` mapping: `RATE_LIMITED` → `status 429`, `error` = its message; `FORBIDDEN` → `403`; `NOT_FOUND` → `404`; `UNPROCESSABLE` → `200` + `error`;
    a network failure → `status 0`; a `403` with the secondary-limit body → `secondary: true` (the REST detector applies).
  - `toRow` over two fixture nodes with every field distinct (e.g. #7 `futin/x` `alice`, draft, `CONFLICTING`, `BEHIND`, `CHANGES_REQUESTED`, rollup `ERROR`,
    auto-merge `SQUASH`; #12 `bob`, not draft, `MERGEABLE`, `CLEAN`, `APPROVED`, rollup `EXPECTED`, no auto-merge, cross-repository, maintainer edits off)
    — each field lands on its own row; a node with no commits/rollup → `checks: 'none'`; `author: null` → `null`.
  - The list query sent for `futin/y` names `futin/y` (owner/name split) and asks `first: 100` ordered by `UPDATED_AT` desc, `states: OPEN`.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/github-graphql.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Verify `viewerCanUpdateBranch` against GitHub's GraphQL schema before relying on it (parked question #2); if absent, derive
  `canUpdateBranch` as `mergeState === 'behind'` and say so in the task report. Record GraphQL headers in their own field; reuse `request()`'s
  normalisation so `retryAfter`/`secondary` arrive as values. `graphql` stays repo-agnostic (no repo argument); the list and single-PR builders in `pulls.query.ts` take `repo` and refuse a malformed one with `isRepo`
  (`github.client.ts` ≈ :38) before the owner/name split, as the REST calls refuse theirs.
- [ ] **Step 4: Run** — PASS; `test/tracker-client-write.test.ts` still PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(server): GitHub GraphQL call and pull-request queries`.

### Task 3: `PullRequestsService` — the per-repo, on-demand PR cache

**Files:**
- Create: `server/src/tracker/pulls.service.ts`
- Modify: `server/src/tracker/tracker.module.ts` (provider + export), `shared/types.ts`
- Docs (same commit — the caches headline changes here): `CLAUDE.md` (≈ :160-161 headline and link), `.claude/rules/tracker.md` (≈ :84 bullet, ≈ :105
  link), `docs/subsystems/invariants.md` (heading ≈ :3508 + one paragraph on the PR cache), `docs/overview.md` (≈ :86)
- Test: `test/prs-cache.test.ts` (new), `test/claude-rules.test.ts`

**Interfaces:**
- Consumes: `GithubClient.graphql`, `pulls.query.ts` (Task 2), `failureVerdict`, `poller.noteSecondary`/`secondaryUntil`, `poller.syncOffBlock`,
  `registryProjectsOr503` + `resolveSource` (as `tracker.controller.ts` uses them), `githubToken()`.
- Produces:
  - `PR_TTL_MS = 60_000`.
  - `PrRepoView { repo; polledAt: string | null; access: NonNullable<ProjectSummary['access']>; detail: string | null; syncOff: string | null;
    methods: MergeMethod[]; autoMergeAllowed: boolean; prs: PullRequestRow[]; total: number; truncated: boolean }` and
    `PullRequestsPayload { token: boolean; repos: PrRepoView[] }`.
  - `PullRequestsService.list(now?): Promise<PullRequestsPayload>` — every DISTINCT repo of the registered `github`-source projects (two checkouts of one repo
    → one view); no token → `{ token: false, repos: [] }` with no outbound call. Per repo: entry fresh (`now - polledAt < PR_TTL_MS`) → served; asleep
    (`sleepUntil` or the poller's `secondaryUntil` in the future) → served from the entry (or an empty view) with the sleep as `detail`; else one read.
  - `PullRequestsService.splice(repo, row | null, number)` — replace a cached row, add it when absent and open, remove it when the re-read says not open.
  - Entry fields: `polledAt` moves on success only; a failure keeps the previous `prs` and sets `access`/`detail`/`sleepUntil` from `failureVerdict`, and a
    secondary verdict calls `poller.noteSecondary`. `syncOff` = `poller.syncOffBlock(<first registered github project path for the repo>)`. `methods` keeps
    `MERGE_METHODS` order filtered by the repo's allowed flags. `truncated = total > prs.length`.
  - An in-flight read per repo is shared: a second `list()` arriving while repo X is being read awaits the same promise.

- [ ] **Step 1: Write the failing tests** (registry with three projects: `futin/x` twice — two checkouts — and `futin/y`; fake PRs #7, #9 on `futin/x`,
  #12 on `futin/y`, distinct titles/heads/SHAs/updatedAt):
  - `lists each repo once`: two views, `futin/x` with #7 and #9 (updatedAt desc), `futin/y` with #12; exactly two list queries.
  - `fresh entries are served`: a second `list()` at `now + 59_000` makes no call; at `now + 60_000` makes one per repo.
  - `concurrent reads share one query per repo`: three `list()` calls started together with the fake holding the answer → two list queries total.
  - `no read without a request`: construct the service, advance fake timers 10 minutes, assert zero `/graphql` calls (no timers exist).
  - `no token`: env unset → `{ token: false, repos: [] }`, zero calls.
  - `a failed read keeps the last answer`: success, then `failNext` `502` on `futin/x` past the TTL → `futin/x` still lists #7 and #9, `polledAt` unchanged,
    `access: 'error'`; `futin/y` refreshed normally.
  - `rate limit sleeps one repo`: `RATE_LIMITED` with reset `now + 900 s` on `futin/x` → its `access` is `rate-limited` and its `detail` names the sleep;
    a `list()` at `now + 120_000` makes a call for `futin/y` only.
  - `a secondary limit on a PR read sleeps the poller's repo`: secondary `403` on `futin/x`'s list → `poller.secondaryUntil('futin/x')` is set and the next
    poller sweep within 60 s makes no request for `futin/x`.
  - `sync off is a field, not a filter`: `futin/y` with sync `off` → its view carries `syncOff` = the exact sentence for `futin/y`, and #12 is still listed.
  - `truncated`: fake `totalCount: 140` with 100 nodes → `total: 140, truncated: true`.
  - `methods`: `futin/x` allows merge + rebase, auto-merge off → `methods: ['merge','rebase']`, `autoMergeAllowed: false`; `futin/y` all three →
    `['squash','merge','rebase']`.
  - `splice`: replace #7's title; add #20 (open); remove #9 (re-read `MERGED`); `futin/y` untouched.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/prs-cache.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Edit the caches headline to `The tracker, Jira and pull-request caches are the three caches in this server whose age is a
  rendered value` in its three homes + `docs/overview.md`, update both links to the new anchor, and add the paragraph: per-repo, on-demand, 60 s TTL, no
  sweep, `polledAt` rendered by the PRs page, a failure keeps the last answer.
- [ ] **Step 4: Run** the suite + `test/claude-rules.test.ts` — PASS. Typecheck clean.
- [ ] **Step 5: Commit** `feat(server): per-repo on-demand pull-request cache`.

### Task 4: The PR routes and the three writes

**Files:**
- Create: `server/src/tracker/pulls.controller.ts`
- Modify: `server/src/tracker/pulls.service.ts` (writes), `server/src/tracker/tracker.module.ts` (controller), `shared/types.ts`, `test/helpers/github.ts`
  (as needed), `test/agents-origin-guard.test.ts` (the three routes join `GUARDED` ≈ :146-170 with a `bodyFor` branch ≈ :100-141)
- Docs (same commit): `CLAUDE.md` (Layout `tracker/` text ≈ :45-46 gains the PR cache and `/api/prs`; the "Item files are read-only" bullet ≈ :137-139 gains
  the PR writes — keep it ≤ 80 words, e.g. by tightening its first clause; the new headline under Invariants beside the Jira-writes one),
  `docs/subsystems/invariants.md` (new entry modelled on "The board's Jira writes are assign and transition, nothing else" ≈ :3718), `.claude/rules/tracker.md`
  (new bullet with the mechanism), `docs/subsystems/api.md` (§`tracker/` ≈ :115: routes, refusal ladder, outcomes), `.env.example` (≈ :94-111: Issues write;
  Pull requests and Contents write; Checks and Statuses read; auto-merge via GraphQL; a fine-grained token's write permission cannot be read back)
- Test: `test/prs-write.test.ts` (new), `test/agents-origin-guard.test.ts`, `test/claude-rules.test.ts`

**Interfaces:**
- Routes:
  - `GET /api/prs` → `200 PullRequestsPayload`; registry unreadable → the `503` `registryProjectsOr503` gives today. Unguarded (a read).
  - `POST /api/prs/merge` `{ repo, number, method: MergeMethod, headSha }` → `200`.
  - `POST /api/prs/auto-merge` `{ repo, number, enable: boolean, method?: MergeMethod }` (`method` required when `enable`) → `200`.
  - `POST /api/prs/update-branch` `{ repo, number, headSha }` → `202`.
  - Answer: `PrWriteResult { ok: true; outcome: 'merged' | 'already-merged' | 'auto-merge-enabled' | 'auto-merge-disabled' | 'noop' | 'update-requested';
    pr: PullRequestRow | null; reread: boolean }` — `pr` is the re-read row, `null` when the PR is no longer open or the re-read failed; a failed re-read
    never turns the answer into an error (the Jira rule).
- Refusal ladder, in order: `400` malformed (`isRepo`, positive integer `number`, `method` in `MERGE_METHODS`, `headSha` 40 lowercase hex, `enable`
  boolean) · `404` repo is not a registered github project's repo · `503` no token · then inside `serialise('<repo>#<number>')`: `409` sync off (the
  `syncOffBlock` sentence verbatim) · `429` repo asleep (PR cache or poller) · the GitHub call: `405`/`409`/`422` (REST) or a typed GraphQL error → `409`
  with GitHub's message; `401`/`403` (not a rate limit) → `502` `the token lacks permission for this — <GitHub's message>`; a rate limit → `429` and the
  repo sleeps (`failureVerdict`); anything else → `502`.
- Merge: a failure whose re-read shows `MERGED` answers `200 already-merged`; a `409` (head moved) re-reads and splices before answering `409`.
- Auto-merge: read the single PR first (node id, armed state); `enable: false` with none armed → `200 noop`, no mutation; then the mutation; then re-read.
- Update-branch: GitHub's `202` → `202 update-requested` with the immediate re-read (which may still show the old SHA).
- `serialise` is the service's own chain map, the same shape as `GithubSource.serialise` (`github.source.ts:1281-1292`): `previous.then(fn, fn)`, entry
  dropped when it is the tail again.

- [ ] **Step 1: Write the failing tests** (two repos as in Task 3; PRs #7 `futin/x` head SHA `a…a`, #12 `futin/y` head SHA `b…b`):
  - `merge`: #7 squash with the right SHA → `200 merged`, `pr: null`, the next `GET` no longer lists #7 and makes no new list query (spliced, entry fresh);
    the PUT body carries `merge_method: 'squash'`, `sha`.
  - `a second merge of the same PR reads as already merged`: two concurrent merges of #7 → both `200`, outcomes `merged` then `already-merged`; the fake's
    `maxConcurrent` for `futin/x#7` is `1`. A concurrent merge of `futin/y#12` is NOT queued behind them (it starts before they finish).
  - `head moved`: wrong SHA → `409` with GitHub's message, and the cache now holds the re-read row.
  - `protection`: `405` "Required status check is expected" → `409` with that text.
  - `auto-merge`: enable `rebase` on #12 → `200 auto-merge-enabled`, `pr.autoMerge.method === 'rebase'`; disable → `auto-merge-disabled`; disable again →
    `noop` with zero mutation calls; enable on `futin/x` whose auto-merge is off → GraphQL error → `409` with its text.
  - `update-branch`: #12 → `202 update-requested`; the PUT body carries `expected_head_sha` = `b…b`; a `422` → `409` with GitHub's message.
  - `permission`: `403` (remaining > 0) on merge → `502`, error starts `the token lacks permission for this — ` and ends with GitHub's message.
  - `rate limit`: merge answered `429` + `retry-after: 60` → `429`; a second write on the same repo inside 60 s → `429` with no outbound call; a write on
    the other repo proceeds.
  - `sync off refuses every PR write and lists the PRs`: `futin/y` off → each of the three POSTs on #12 answers `409` with `sync is off for futin/y — turn it
    on in GitHub › Settings` and zero outbound calls; the same three on `futin/x#7` succeed; `GET` still lists #12 with `syncOff` set.
  - `refusals`: `repo: 'nope'` → `400`; `number: 0` → `400`; `method: 'fast'` → `400`; `headSha: 'abc'` → `400`; enable without `method` → `400`;
    `futin/z` → `404`; token unset → `503` — each with zero outbound calls.
  - `re-read failure`: the merge succeeds, the re-read `502`s → `200 merged`, `reread: false`.
  - `tailnet`: a merge with `host: mac.tail1234.ts.net:5177` and the matching origin → `200` (the app built with `AppModule` as
    `test/allowed-hosts.test.ts:151-168` does).
  - `agents-origin-guard.test.ts`: the three routes in `GUARDED` → `403` for urlencoded, cross-origin and `Origin: null`, no outbound fetch.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/prs-write.test.ts test/agents-origin-guard.test.ts` — FAIL.
- [ ] **Step 3: Implement** the controller and writes, then the docs. New headline, byte-equal in CLAUDE.md, the `invariants.md` heading (no trailing
  period) and the `rules/tracker.md` bullet: **The board's pull-request writes are merge, auto-merge and update-branch, nothing else, and each re-reads the
  PR.** The entry says: GitHub API calls, never local git (so "the server never writes git" holds); guarded like every write, tailnet allowed; serialised per
  `<repo>#<number>`; sync off through `syncOffBlock`; the refusal ladder and outcomes; why the second merge is `already-merged`.
- [ ] **Step 4: Run** both suites + `test/claude-rules.test.ts` + `test/allowed-hosts.test.ts` — PASS. Typecheck clean.
- [ ] **Step 5: Commit** `feat(server): merge, auto-merge and update-branch for open pull requests`.

### Task 5: Client derivations — `lib/prs.ts` and the run warning `lib/pr-run.ts`

**Files:**
- Create: `client/src/lib/prs.ts`, `client/src/lib/pr-run.ts`
- Test: `test/prs-lib.test.ts`, `test/pr-run.test.ts` (new)

**Interfaces:**
- `prs.ts` (pure, no React):
  - `prChips(pr): Array<{ label: string; tone: PillTone }>` — `draft` (neutral), review (`approved` done / `changes requested` bad / `review required`
    warn), checks (`checks passing` done / `checks failing` bad / `checks pending` warn / none → no chip), `conflicts` bad when `conflicting`, `behind base`
    warn when `mergeState === 'behind'`, `auto-merge · <method>` live when armed.
  - `mergeBlock(pr, repo): string | null`, `updateBlock(pr, repo)`, `autoMergeBlock(pr, repo)` — first match wins: `sync off` (repo `syncOff`) → merge:
    `draft` → `not mergeable` (conflicting) → `checks failing` → `no merge method allowed` (empty `methods`); update: `fork does not allow edits`
    (crossRepository and not maintainerCanModify) → `already up to date` (`!canUpdateBranch`); auto-merge: `auto-merge not enabled on the repo`
    (`!autoMergeAllowed`, enabling only — disabling an armed one is never blocked except by `sync off`).
  - `defaultMethod(methods): MergeMethod | null` — first of `MERGE_METHODS` present.
  - `UPDATING_MS = 30_000`; `isUpdating(mark: { sha: string; until: number } | undefined, pr, now): boolean` — true while `pr.headSha === mark.sha` and
    `now < mark.until`.
  - `groupRepos(repos: PrRepoView[]): PrRepoView[]` — repos with PRs first, by their newest `updatedAt` desc; then repos with none, by name; within a repo,
    PRs by `updatedAt` desc.
  - `outcomeLine(result: PrWriteResult): string` — `merged`, `already merged`, `auto-merge armed`, `auto-merge off`, `no auto-merge was armed`, `updating…`.
- `pr-run.ts`: `prRunWarning(pr: PullRequestRow, repo: string, ctx: { projects: ProjectSummary[]; items: BacklogItem[]; runs: OrchestratorRun[]; remote:
  RemoteRun[]; remoteStarting: RemoteStarting[] }, now: number): string | null` — the ONE function the spec names. Fork heads (`crossRepository`) → `null`.
  Head `^(backlog|execute)/(\d+)$` → bare id `N`; warns when a local run on that repo (run `project` → `ProjectSummary.path` → `.repo`) or a remote run
  (`run.repo`) with status `running` or `paused` (freshness ignored: a crashed `running` run still holds the branch) has a queue entry whose `id === N`; or
  a `github` item `#N` of a project on that repo has `claimReading(item, now) === 'live'`; or a `remoteStarting` entry of kind `dispatch` with `itemId ===
  '#N'` maps to that repo. Head `backlog/run-*` warns only when it equals EXACTLY the `base` of a running or paused local or remote run on that repo. Any
  other head → `null`. The string names the holder: `run in progress on <host or this machine>`, `claimed by a live session`, `launch pending`.

- [ ] **Step 1: Write the failing tests** —
  - `prs-lib`: each chip from a row with every field distinct; `checks: 'none'` gives no checks chip; each block reason in precedence order with a row
    that triggers two (draft + conflicting → `draft`; sync off + draft → `sync off`; fork + up to date → `fork does not allow edits`); disabling an armed
    auto-merge on a repo with auto-merge off → `null`; `defaultMethod(['rebase','merge'])` → `merge`, `([])` → `null`; `isUpdating` true at `until - 1` with
    the same SHA, false at `until`, false at `until - 1` with a new SHA, false with no mark; `groupRepos` over three repos (`futin/x` newest PR 10:05,
    `futin/y` newest 10:09, `futin/a` none, `futin/b` none) → `y, x, a, b`, and `x`'s PRs reordered newest first.
  - `pr-run` (`futin/x` project `/p/x`, `futin/y` project `/p/y`; `now` fixed; heartbeats relative to `now`):
    - `ids are scoped to the repo`: a running local run on `/p/x` with queue id `42` → `backlog/42` on `futin/x` warns, `backlog/42` on `futin/y` does not,
      `execute/42` on `futin/x` warns.
    - status: `paused` warns; `done`, `aborted`, `failed` do not; a `running` run with `fresh: false` still warns.
    - remote run `{ repo: 'futin/y', status: 'running', queue: [{ id: '42' }] }` → `backlog/42` on `futin/y` warns, `futin/x` does not.
    - claim: item `#42` on `/p/x` with a heartbeat `now - 10 s` → warns; with a stale heartbeat → `null`; a `files` item with id `42` never warns.
    - `remoteStarting` dispatch `itemId: '#42'` for `/p/y` → `futin/y` warns; kind `orchestrate` with `itemId: null` → no warning.
    - `run branch warns only on the exact live base`: run A `done` with base `backlog/run-a`, run B `running` with base `backlog/run-b`, both `futin/x` →
      `backlog/run-b` warns, `backlog/run-a` does not; `backlog/run-b` on `futin/y` does not.
    - never: `backlog/bug-3`, `feature/42`, `backlog/42x`, and a cross-repository `backlog/42` with a matching live run → `null`.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/prs-lib.test.ts test/pr-run.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Confirm `RemoteStarting.project`'s shape (path vs name) in `server/src/agents/dashboards/` and map it to a repo the same way
  the server fills it; use `queueItemIs`/`claimReading` rather than re-deriving id or claim rules.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): pull-request derivations and the run-in-progress warning`.

### Task 6: `prs-api.ts` and `usePullRequests`

**Files:**
- Create: `client/src/lib/prs-api.ts`, `client/src/hooks/usePullRequests.ts`
- Test: `test/use-pull-requests.test.tsx` (new)

**Interfaces:**
- `prs-api.ts`: `fetchPullRequests(): Promise<PullRequestsPayload>`, `mergePr(body)`, `setAutoMerge(body)`, `updateBranch(body)` — each POST through
  `postJson`, each failure an `Error` whose message is `errorOf(body, fallback)` (the server's sentence, verbatim).
- `usePullRequests(): { data: PullRequestsPayload | null; error: string | null; refresh: () => Promise<unknown> }` — `useRefreshing(fetchPullRequests,
  { armed: true, intervalMs: 60_000 })`; mounted only by the PRs page, so unmounting disarms it. After a success, a failure keeps the last `data` and sets
  `error`.

- [ ] **Step 1: Write the failing tests** — one fetch on mount; another at 60 s (fake timers), none at 59 s; unmount → no fetch at 120 s; two `refresh()`
  calls during one in-flight read → one follow-up; success then `500` → previous `data` kept, `error` set; `mergePr` against a `409` answer rejects with the
  server's `error` text verbatim.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/use-pull-requests.test.tsx` — FAIL.
- [ ] **Step 3: Implement**; add `usePullRequests` to the `useRefreshing` reader list in `.claude/rules/board.md` (≈ :121-124) if that list still names
  readers.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(client): pull-request fetchers and the 60-second page poll`.

### Task 7: `PullRequestsView` and `PrRow`, the `prs` page, and its docs

**Files:**
- Create: `client/src/components/github/PullRequestsView.tsx` (default export, lazy), `client/src/components/github/PrRow.tsx`
- Modify: `client/src/lib/source-page.ts` (`GITHUB_PAGES = ['board','prs','archive','settings']`, header comment), `client/src/components/SideRail.tsx`
  (`RAIL_SOURCE_LABEL.prs = 'PRs'` ≈ :472; the GitHub `RailTree` ≈ :213-222), `client/src/App.tsx` (lazy import beside `GithubSettingsView` ≈ :32;
  `report.githubPrs = reportFor('github:prs')` ≈ :188-196; render `section === 'github' && githubPage === 'prs'` ≈ :370)
- Docs (same commit): `.claude/DESIGN.md` (new `§8.11 GitHub › PRs`: grouping, row anatomy, chip tones, disabled-reason placement, outcome line, `updating…`,
  warning chip, `polled N s ago`, `showing 100 of N`), `docs/subsystems/board.md` (§"A connected tracker" ≈ :450: the PRs page), `CLAUDE.md` client bullet
  (≈ :59-60: GitHub's tree is Board, PRs, Archive, Settings)
- Test: `test/prs-view.test.tsx` (new), `test/source-page.test.ts` (≈ :33-35), `test/rail.test.tsx` (≈ :344-350), `test/source-sections.test.tsx`

**Interfaces:**
- Consumes: `usePullRequests`, `useBoard()` (items + projects), `useOrchestratorRuns()` (runs, remote, remoteStarting), every `lib/prs.ts` and
  `lib/pr-run.ts` export, `pollAge`, `Confirm`, `Pill`, `Select`, `Band`.
- `PullRequestsView({ onWorking })` — reports `true` while the first read is pending (the views' existing `onWorking` contract); per repo (in
  `groupRepos` order): a heading with the repo, `polled N s ago` (`pollAge`), a `sync off` chip when `syncOff` is set, the entry's `detail` when not `ok`,
  `showing 100 of N` when truncated, `no open pull requests` when empty. No token → the instruction `no token — set BM_GITHUB_TOKEN in .env and restart`.
- `PrRow` — `#<n>` link to `url` (new tab), title, author, `head → base`, chips, the warning chip (tone warn, its reason as text) with actions still
  enabled, a method `Select` (the repo's `methods`, seeded by `defaultMethod`), `Merge` behind an inline `Confirm` (`Merge #<n> into <base> (<method>)?`),
  `Enable auto-merge` / `Disable auto-merge`, `Update branch`; a blocked action is disabled with its reason shown beside it (not a tooltip only); one
  outcome line (`outcomeLine` or the error text); while a write is in flight its buttons are disabled; after `update-requested` the row shows `updating…`
  while `isUpdating`, and the view calls `refresh()` once at the mark's `until`.

- [ ] **Step 1: Write the failing tests** —
  - page list: `GITHUB_PAGES` equals `['board','prs','archive','settings']`; the rail's GitHub tree reads `Board, PRs, Archive, Settings`; picking `PRs`
    renders the PRs view and stores `prs` under `backlog-manager.github-page`.
  - `prs-view` (payload with `futin/x` #7, #9 and `futin/y` #12, all fields distinct; fixture dates relative to the test clock): repo order and PR order per
    `groupRepos`; each row's title/author/head land on its own row; `polled 12 s ago` per repo from distinct `polledAt`s.
  - merge: clicking `Merge` on #12 opens the confirm; dismiss → no POST; accept → one POST `/api/prs/merge` with `{ repo: 'futin/y', number: 12, method:
    <default>, headSha: <#12's sha> }`; a `200 merged` answer → outcome line `merged` and a `refresh()`.
  - method: `futin/x` allows only `merge`,`rebase` → the select offers those two and defaults to `merge`; picking `rebase` sends `rebase`.
  - `sync-off repo disables all three actions`: `futin/y` with `syncOff` → its three actions disabled with `sync off`, `futin/x`'s enabled.
  - blocks: draft #7 → Merge disabled `draft`; fork #9 without maintainer edits → Update branch disabled `fork does not allow edits`; `futin/x` auto-merge
    off → Enable auto-merge disabled `auto-merge not enabled on the repo`.
  - errors: a `409` answer → the server's text as the outcome line, verbatim; a `502` lacks-permission answer → that text.
  - update: `202 update-requested` → `updating…` shown; a refreshed payload with a new SHA clears it; with the same SHA it clears after 30 s (fake timers)
    and one extra fetch happened at that moment.
  - warning: a live run on `/p/y` with queue id `12` and #12's head `backlog/12` → warning chip on #12 only, its actions still enabled.
  - truncated `futin/x` (`total: 140`) → `showing 100 of 140`; no token → the instruction sentence.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/prs-view.test.tsx test/source-page.test.ts test/rail.test.tsx test/source-sections.test.tsx` — FAIL.
- [ ] **Step 3: Implement**, then the docs. One Escape owner: `Confirm` joins `useDialogEscape` already; the page adds no handler. The page reads the strip
  height through `--main-gap`, never a px literal.
- [ ] **Step 4: Run** those suites + `test/claude-rules.test.ts` + `test/csp.test.ts` — PASS. Typecheck clean.
- [ ] **Step 5: Commit** `feat(client): GitHub › PRs page`.

---

## Spec rulings made by this plan

- **"A starting entry names `#<id>`"**: home's `StartingRun` is `{ project, requestedAt }` — no item, no base — so only `remoteStarting` dispatch entries can
  name an id; a just-launched local dispatch warns once its claim lands (seconds later).
- **"Live" run**: `running` or `paused`, freshness ignored — a crashed `running` run still holds its branch, and the PRs page does not judge crashes.
- **Fork heads** are never warned: a fork's `backlog/42` is not one of this machine's branches.
- **Auto-merge enable** is disabled only on the repo setting (the layout's list); a draft or already-clean PR is left to GitHub's GraphQL error text — the
  Token-permissions clause forbids disabling actions on a guess.
- **"Behind base"** reads `mergeStateStatus === BEHIND`; Update branch's `already up to date` reads `viewerCanUpdateBranch` when GitHub's schema has it
  (parked).
- **Merge method** is validated against `MERGE_METHODS` only; a method the repo disallows comes back as GitHub's `405`, shown as `409` text — the client
  never offers one.
- **Write statuses**: GitHub's refusals become `409` and permission failures `502`, because `403` already means the origin and Host guards here.
