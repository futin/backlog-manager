# GitLab

The read-only GitLab connection ([spec](../superpowers/specs/2026-11-12-gitlab-connection-design.md), mocks under
[`2026-11-12-gitlab-connection-mockups/`](../superpowers/specs/2026-11-12-gitlab-connection-mockups/)): the board shows, per Jira ticket, the merge requests
that carry its key and where each one stands — open, its pipeline, merged or closed. It is not a source and not a third tracker. It owns no file, writes
nothing to GitLab and nothing to disk, and it adds no setting of its own: what it polls is derived from the repos Jira › Setup › Repositories already maps.

`server/src/gitlab/` is the fourth outbound-calling module, after `agents/`, `tracker/` and `jira/`, and the only one that talks to GitLab. The rules it
answers to are in [`.claude/rules/gitlab.md`](../../.claude/rules/gitlab.md); the reasoning is in
[invariants](invariants.md#the-gitlab-token-never-leaves-the-server-never-follows-a-redirect-and-the-poller-is-armed-only-while-a-mapped-repo-is-on-the-site)
and, for the cache, in [the four caches](invariants.md#the-tracker-jira-pull-request-and-gitlab-caches-are-the-four-caches-in-this-server-whose-age-is-a-rendered-value).

## Configuration

Two variables in `.env`, both or neither: `BM_GITLAB_SITE` (a hostname, `gitlab.example.com`) and `BM_GITLAB_TOKEN` (a `read_api` personal access token).
`docker-compose.yml` passes both with the empty-default form every optional variable uses. `gitlabEnv()` (`env.util.ts`) reads them per call, never caches,
and checks the site with `isJiraHostname` — a scheme, a path or a port is `malformedSite`, which the Sources row says without quoting the value. The token
the server holds is never handed to a session: `mr-review-loop` carries its own `api`-scoped `GITLAB_TOKEN`.

## The module, file by file

| file                    | what it owns                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `env.util.ts`           | `gitlabEnv()`, `GITLAB_ENV` — the pair, read per call; the not-set and malformed-site sentences; `gitlabReviewBot()`, `GITLAB_REVIEW_PAGES`  |
| `remote.util.ts`        | `parseGitRemote` (scp-style and URL remotes; drops userinfo, keeps a port and nested groups), `remoteOnSite`, `gitlabProjectId`, `isGitlabProjectPath` |
| `gitlab.client.ts`      | `GitlabClient` — `GET /user`, `GET /projects/:id/merge_requests`, `…/merge_requests/:iid`, `…/merge_requests/:iid/discussions`; `redirect: 'manual'`, 10 s |
| `review.util.ts`        | `foldReview` — discussions into `GitlabReview` facts; `isTrigger`, `parseSeverity`, `countAddedCommits`. Pure, no clock                 |
| `mapping.util.ts`       | `resolveGitlabProjects` (Jira repos → GitLab projects via `origin`, and per Jira key the checkouts that did: `repos`), `mrKeys`, `foldPipeline`, `foldMrState` |
| `poller.service.ts`     | `GitlabPollerService` — the MR cache, the identity, the state, the 429 window, `payload()`, `sweepNow()`, `findMr`, `reposFor`             |
| `gitlab.controller.ts`  | `GET /api/gitlab`, `POST /api/gitlab/sweep`                                                                                             |
| `gitlab.module.ts`      | imports `JiraModule` for `JiraLiveService`'s `onReposChanged` listener list                                                             |

## Mapping

Each sweep reads `readJiraConfig().repos` (`{ JIRA_KEY: [repo paths] }`) fresh, reads every repo's `origin` with `runGit remote get-url` — the module's one
git call, a read — and keeps the remotes on the site. Two Jira keys on one repo, or two checkouts of one project, collapse to one target carrying both keys,
so a project is polled once. A remote that parsed but is on another host lands in `foundHosts` (the Sources row's "no mapped repository is on <site> —
found github.com"); one that could not be read or parsed is an `origin` problem, named by the repo's basename only.

An MR belongs to the tickets `mrKeys` finds in its source branch and its title, through `keysInBranch` — the function a Jira session's branch is matched
with, so the two can never disagree. An MR that names none of its project's keys is dropped.

## The poller

A `setTimeout` chain every `GITLAB_POLL_MS` (2 min), the tracker poller's shape, with an immediate sweep on `arm()`. `arm()` runs at bootstrap, on every
repos save (`JiraLiveService.onReposChanged`, never awaited by the save) and from the sweep route; a sweep that maps zero projects on the site disarms, and
an `arm()` that lands mid-sweep re-arms after it. One sweep is in flight at a time and every caller joins it; `armed` is a timer or a flight.

**Per project, per sweep**: the opened MRs, then merged and closed MRs updated within `GITLAB_FINISHED_DAYS` (30), each `order_by=updated_at&sort=desc`, at
`GITLAB_PER_PAGE` (100) rows a page and at most `GITLAB_PAGES_PER_PROJECT` (5) pages — a spent budget after a full page sets `capped`, and the order means it
cuts the oldest finished MRs, never an open one. Then one detail read per kept open MR, for its head pipeline, and — when it is due — its review. So a sweep's
request count is bounded by `1 + projects × 5 + open MRs × (1 + 3)` (the `1` being an identity read when one is due; the `3` the review's discussion pages).

**Failure keeps the last answer.** A failed list keeps the project's MRs and `polledAt` and sets `failed` (a 403/404 is `cannot-read`, that project's
problem line); a failed detail read keeps that MR's last pipeline, and a failed review read keeps its last good review flagged `failed`. One 429 stores one `retryAt` (`Retry-After`, else `GITLAB_RATE_LIMIT_DEFAULT_MS`),
expired where it is read. A refused token stops a sweep before any project is asked, so while the state is `rejected`, `payload()` marks every project never
read as `failed` too — its tickets read "could not be read", not "not read yet" (spec §7.2).

**Identity** (`GET /user`) is asked at bootstrap and whenever the SHA-256 fingerprint of (site, token) changes, independent of arming, so a refused token
shows even when no repo is mapped; a 401 inside a sweep forces a re-read, and an unanswered identity is retried after `GITLAB_IDENTITY_RETRY_MS`.

**State**, in precedence: `unconfigured`; `checking` (identity not answered for this pair); `rejected` (401/403 on `/user`); `unreachable` (no answer, a
5xx or a refused redirect, from the identity or the last sweep); then `idle` with zero mapped projects, else `connected`.

## CodeRabbit review state

The review project ([spec](../superpowers/specs/2026-11-13-coderabbit-review-design.md), mocks under
[`2026-11-13-coderabbit-review-mockups/`](../superpowers/specs/2026-11-13-coderabbit-review-mockups/)) adds one field to a cached open MR, `review:
GitlabReview | null`, and one action to Jira — `review`, which starts a session that asks CodeRabbit for a review or fixes what it found. The server stays
read-only toward GitLab: the trigger comment and the fixes are the session's, through `mr-review-loop` and its own `api` token.

**What is read.** After an open MR's detail read, `GET …/merge_requests/:iid/discussions?per_page=100&page=N`, at most `GITLAB_REVIEW_PAGES` (3) pages. It is
read when it never was, when the MR's `updated_at` differs from the one stored at the last successful read (`ProjectCache.reviewSeen`, server-only), or — GitLab
need not bump `updated_at` when a thread is resolved — when the state is `reviewing` or `open` and the facts are over `REVIEW_REREAD_MS` (10 min) old. A page
that does not answer 200 fails the whole read, so a fold is never built from a partial set; a full third page sets `capped`. A 429, a 401 and an unanswered
call behave exactly as in the detail read. Merged and closed MRs are not read and carry `null`, meaning not read — never "no review".

**Facts, not a state.** `foldReview` reads the bot's username from `BM_GITLAB_REVIEW_BOT` (default `coderabbitai`). A trigger is a person's note with a line
beginning `@<bot> review` or `@<bot> full review`; a finding is a discussion opened by the bot with a resolvable note, open until every resolvable note in it is
resolved; its severity is the bold badge on the note's first line. A round lands on the bot's `Actionable comments posted:` note or on the bot's edited reply in
the trigger's own discussion, whichever is earlier; `commitsSince` sums the `added N commit(s)` system notes after the landing. The state — `none`, `reviewing`,
`open`, `stale`, `clean`, `unknown` — is `reviewState(review, now)` in `shared/review.ts`, derived where it is drawn, so a trigger that never lands stops reading
`reviewing` after 30 minutes without any sweep noticing. `reviewHalf(state)` maps it to what a button may do: `open` fixes, `none` and `stale` request, the rest
offer nothing.

**Dispatch reads the cache.** `findMr` and `reposFor` answer review dispatch from memory (see [jira.md](jira.md#the-review-action)); no request is made for a
click, so a review is decided on the age of the last read and the sheet's half is re-derived and refused with a 409 when it moved.

## Routes

- **`GET /api/gitlab`** → `GitlabPayload { status, jiraProjects, mrs }`, built from memory. `status` is `GitlabStatus` (state, site, user, `armed`,
  `retryAt`, `mappedRepos`, `foundHosts`, `problems`); `jiraProjects` maps each Jira key to its `GitlabProjectView`s (`path`, `repo`, `polledAt`,
  `capped`, `failed`, `repos` — the review candidates); `mrs` is every cached `GitlabMr` with its `keys` and `review`.
- **`POST /api/gitlab/sweep`** (`SameOriginPostGuard`) → `arm()`, then `sweepNow()`: 200 `{ ok: true }`, 409 when not armed, 429 with `retryAt` inside the
  window. It waits for the sweep up to `GITLAB_SWEEP_WAIT_MS`, then answers 200 and lets the sweep finish behind it. The Sources row's Read again calls it
  beside the GitHub and Jira sweeps (`lib/sweep.ts`).

## The client half

`useGitlab` (`hooks/useGitlab.ts`) is the one read of `GET /api/gitlab`, every 30 s through `useRefreshing`, armed constant `true`. `GitlabProvider`
(`hooks/GitlabContext.tsx`) mounts it once, in `App.tsx` inside the Jira provider subtree around the shell; `useGitlabContext` reads it.
`useDeliveryIndex` (`hooks/useDeliveryIndex.ts`) turns the payload into a `DeliveryIndex` once per payload (a `WeakMap`), or `null` when
`deliveryShown` says no surface draws — unconfigured, unarmed, or a payload the browser could not fetch.

`lib/delivery.ts` holds every derivation: `ticketDelivery` (`hidden`, `unknown`, `none` or `mrs`; a sub-task inherits its parent's MRs, one level),
`leadMr`, `deliveryLook` (the chip text, the word, the tone and the track), `bandTotals`, and the `DeliveryFilter` values. The surfaces — the Sources row
(`SourcesGroup.tsx`, `lib/service-status.ts`), `MrChip` on the cards, `GitlabBandLine` under the band, the List's Delivery column, `DeliveryPane` in Detail
with `DeliveryTrack` (`components/ui/`), and the Delivery quick filter — are drawn as [`.claude/DESIGN.md` §8.9.6](../../.claude/DESIGN.md) specifies.

## Room for project 2

Spec §9's room for a second project was used by the CodeRabbit review work above: `GitlabMr` grew a `review` field, the track a `Review` step, and the server
stayed read-only toward GitLab — the notes and the fixes are the session's, with its own `api` token.

## Tests

`gitlab-env`, `gitlab-remote`, `gitlab-client`, `gitlab-mapping`, `gitlab-poller`, `gitlab-review-fold`, `review-state` and `gitlab-routes` cover the server; `compose-env` pins the compose
pass-through; `delivery-lib` covers `lib/delivery.ts` and `review-copy` `lib/review-copy.ts`; `gitlab-context`, `sources-group`, `jira-delivery-pane`, `jira-delivery-surfaces`, `jira-list` and
`jira-board` cover the client. `test/helpers/gitlab.ts` builds payloads, and `test/helpers/no-gitlab.tsx` hands a pending answer through the raw context, for
suites that mount `SettingsView` (whose Sources card needs the provider) without stubbing `/api/gitlab`.
