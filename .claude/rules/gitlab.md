---
paths: ["server/src/gitlab/**"]
---

# Rules scoped to these paths, mechanism included — CLAUDE.md repeats only the cross-cutting ones' headlines; the reasoning is in docs/subsystems/invariants.md

- **The GitLab token never leaves the server, never follows a redirect, and the poller is armed only while a mapped repo is on the site.** `GitlabClient`
  (`gitlab.client.ts`) is the one place `BM_GITLAB_TOKEN` is sent: the `PRIVATE-TOKEN` header, built per call in `request`, never in a URL, a log, a message
  or a payload — `payload()` carries the user, the site and paths, nothing else. Every call passes `redirect: 'manual'`; a 3xx or undici's `opaqueredirect`
  becomes `status: 0`, `redirect refused (<code>)`, its body unread. Only `https://<BM_GITLAB_SITE>/api/v4` is dialled, the site checked by `gitlabEnv`
  through `isJiraHostname` (a malformed one is `malformedSite`, unconfigured); pages are asked for as `page=N` on a URL this file built, never by a
  `Link`/`next` header. A repo's `origin` is parsed by `parseGitRemote` (`remote.util.ts`), which drops the userinfo, and compared with the site by
  `remoteOnSite` — never dialled. `arm()` runs from bootstrap, from `JiraLiveService.onReposChanged` and from `POST /api/gitlab/sweep`; a sweep that maps
  zero projects on the site disarms. The identity (`GET /user`) is read apart from arming, keyed by a SHA-256 fingerprint of (site, token) held in memory —
  never the token itself. Why:
  [invariants.md](docs/subsystems/invariants.md#the-gitlab-token-never-leaves-the-server-never-follows-a-redirect-and-the-poller-is-armed-only-while-a-mapped-repo-is-on-the-site)
- **`gitlab/` never imports `jira/`'s poller.** It reads `readJiraConfig().repos` fresh per sweep, hears a repos save through
  `JiraLiveService.onReposChanged` (never awaited by the save), and keys its cache by the ticket keys its MRs carry, not by a board's keys — so a board edit
  never re-aims it and Detail can show an MR for a ticket no board holds. `GitlabModule` imports `JiraModule` for that listener list alone.
- **A failed read keeps the last good answer.** A project whose MR list read fails keeps its MRs and `polledAt` and records `failed` (or `cannotRead` on a
  403/404) beside them; a failed detail read keeps that MR's last pipeline. The cache is in memory, per GitLab project, lost on restart and rebuilt by the
  first sweep, and `polledAt` is what the board renders as its age.
- **One sweep reads at most `GITLAB_PAGES_PER_PROJECT` pages of `GITLAB_PER_PAGE` per project, then one detail read per kept open MR.** Opened first, then
  merged and closed updated within `GITLAB_FINISHED_DAYS`, each `order_by=updated_at&sort=desc`, so the budget cuts the oldest finished MRs, never an open one.
  A spent budget after a full page sets `capped`. An unrecognised pipeline folds to `none` (`foldPipeline`) — unknown never reads as green.
- **A review read is one more GET through `GitlabClient.request`, at most `GITLAB_REVIEW_PAGES` (3) pages of discussions per MR per read, and it is read-only.**
  `mergeRequestDiscussions` (`gitlab.client.ts`) asks `GET /projects/:id/merge_requests/:iid/discussions?per_page=100&page=N` by number, behind the same
  `redirect: 'manual'` and `PRIVATE-TOKEN` header as every other call. It runs after an open MR's detail read, under the same `run.stop` guard, and has three
  triggers (`reviewDue`, `poller.service.ts`): the MR's `updated_at` is not the one stored at the last SUCCESSFUL read (`ProjectCache.reviewSeen`, server-only,
  advanced only by a read that succeeded), its facts have never been read, or its state is `reviewing`/`open` and the facts are over `REVIEW_REREAD_MS` (10 min)
  old — GitLab need not bump `updated_at` when a thread is resolved. Every page must answer 200 or the whole read fails: a fold is never built from a partial
  set, and a third page that is still full sets `capped`. A merged or closed MR is never read and carries `review: null`, which means NOT READ, never "no
  review". Why: [invariants.md](docs/subsystems/invariants.md#a-review-is-read-as-facts-and-its-state-is-derived-where-it-is-drawn)
- **The fold is facts, never a state.** `foldReview` (`review.util.ts`, pure, no clock) turns discussions into `GitlabReview` (`open`, `resolved`, `worst`,
  `bySeverity`, `triggeredAt`, `landedAt`, `commitsSince`, `capped`, `readAt`, `failed`) for the bot named by `gitlabReviewBot()` (`env.util.ts`:
  `BM_GITLAB_REVIEW_BOT` trimmed, blank or unset is `coderabbitai`, read per call, passed by compose as `'${BM_GITLAB_REVIEW_BOT:-}'`). The state is
  `reviewState(review, now)` in `shared/review.ts`, derived where it is drawn so a trigger that never lands stops reading `reviewing` after `REVIEW_STUCK_MS`
  (30 min) by itself; the cache stores none. A failed review read keeps the last good facts with `failed: true` and `readAt` still the last success's, a stop
  leaves them untouched, and an MR never read successfully stays `null`. Every rule in the fold is an observation of how CodeRabbit behaves on Timify's GitLab,
  so each one is a small exported function (`isTrigger`, `parseSeverity`, `countAddedCommits`) a test pins.
  Why: [invariants.md](docs/subsystems/invariants.md#a-review-is-read-as-facts-and-its-state-is-derived-where-it-is-drawn)
- **The cache is readable by `agents/` through two methods and nothing else.** `findMr(project, iid)` (the GitLab path exact — `GRP/proj` is not `grp/proj`) and
  `reposFor(jiraProject, gitlabProject)` answer from memory, as copies, with no request: review dispatch must see what the board saw.
  `GitlabProjectTarget.repos` (mapping) is per Jira key, because a checkout mapped under `OPS` is no review candidate for a `PAY` ticket;
  `GitlabProjectView.repos` carries the same list to the client. `isGitlabProjectPath` (`remote.util.ts`) is the pure shape check `jira/`'s review prompt
  validates an MR's project with — see jira.md. Why:
  [invariants.md](docs/subsystems/invariants.md#a-review-is-read-as-facts-and-its-state-is-derived-where-it-is-drawn)
- **An MR's ticket keys come from `keysInBranch`, over its source branch and its title (`mrKeys`), never a pattern of its own**, because an MR and a Jira
  session must agree on which ticket a branch belongs to: `timify-1234-x` is never `TIMIFY-123`. An MR naming none of its project's mapped keys is dropped.
- **The state's precedence is identity first: `checking`, `rejected` (401/403 on `/user`), `unreachable`, then `idle` (zero projects) or `connected`.** A
  403/404 on one project is that project's problem line, not the state. One 429 `retryAt` is stored and expired where it is read, never by a timer.
- **`POST /api/gitlab/sweep` is `SameOriginPostGuard`ed, calls `arm()` and then `sweepNow()`**: `not-armed` is a 409, an open 429 window a 429 carrying
  `retryAt`, anything else a 200 — a 401 or 5xx inside the sweep is the status's to show, not the request's. `GET /api/gitlab` answers from memory.
