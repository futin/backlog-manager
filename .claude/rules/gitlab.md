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
- **An MR's ticket keys come from `keysInBranch`, over its source branch and its title (`mrKeys`), never a pattern of its own**, because an MR and a Jira
  session must agree on which ticket a branch belongs to: `timify-1234-x` is never `TIMIFY-123`. An MR naming none of its project's mapped keys is dropped.
- **The state's precedence is identity first: `checking`, `rejected` (401/403 on `/user`), `unreachable`, then `idle` (zero projects) or `connected`.** A
  403/404 on one project is that project's problem line, not the state. One 429 `retryAt` is stored and expired where it is read, never by a timer.
- **`POST /api/gitlab/sweep` is `SameOriginPostGuard`ed, calls `arm()` and then `sweepNow()`**: `not-armed` is a 409, an open 429 window a 429 carrying
  `retryAt`, anything else a 200 — a 401 or 5xx inside the sweep is the status's to show, not the request's. `GET /api/gitlab` answers from memory.
