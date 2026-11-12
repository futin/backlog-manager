# GitLab Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read every Jira-mapped repository's GitLab merge requests with a read-only server token and show each ticket's delivery state on the Jira board's
Detail, cards, List, filters and the Sources card.

**Architecture:** A new outbound module `server/src/gitlab/` holds an env reader, a remote parser, a fetch client that refuses redirects, and a poller that
maps `jira.json` repos to GitLab projects, sweeps their MRs every 2 minutes into an in-memory cache, and serves it from `GET /api/gitlab`. The client reads
that one payload through a shell-level provider; a pure `client/src/lib/delivery.ts` turns it into per-ticket delivery (lead MR, words, tones, track,
filters) that every surface draws.

**Tech Stack:** NestJS 10 (server), React 18 + Vite (client), jest + Testing Library (jsdom), supertest, plain global `fetch`.

**Spec:** `docs/superpowers/specs/2026-11-12-gitlab-connection-design.md` — read it whole before Task 1. Section numbers below (§5.2, §7.2 …) are the spec's.

**How to read this plan.** It fixes behaviour, names, signatures, exact values and test cases. It carries **no literal code**: write every body yourself,
and where the code you find disagrees with a line here, the code wins — say so in your report instead of transcribing the plan. Size figures (lines,
widths) are soft targets, never a reason to drop a rule.

## Global Constraints

- Env names: `BM_GITLAB_SITE` (hostname only, no scheme/path/port/query; same rule as `isJiraHostname`), `BM_GITLAB_TOKEN` (`read_api`). Both or neither.
  Read from `process.env` per call, trimmed, whitespace-only = absent. Never cached, logged, returned or written to disk.
- The server builds every GitLab URL as `https://<BM_GITLAB_SITE>/api/v4/...`. A remote's host is compared, never dialled. Every fetch passes
  `redirect: 'manual'`; any 3xx is a failed call ("unreachable"). Pages are requested by `page=N` on a URL the server built — never via `Link`/`next`.
- Remote userinfo is dropped at parse time and never stored, logged or returned.
- The server never writes GitLab and never writes git; the only git call is `runGit(['-C', repo, 'remote', 'get-url', 'origin'], …)` (a read).
- `GITLAB_POLL_MS = 120_000`, `setTimeout` chain, immediate sweep on arm. `GITLAB_SWEEP_WAIT_MS = 20_000`. `GITLAB_RATE_LIMIT_DEFAULT_MS = 60_000`. MRs
  merged/closed are read when updated in the last 30 days.
- `gitlab/` never imports from `jira/`'s poller and `jira/` never imports `gitlab/`. `gitlab/` may import `jira/config.util` (`readJiraConfig`) and
  `JiraLiveService` (via `JiraModule`'s exports).
- Every route under `/api`. Client: no inline `style=`/`<style>` (CSP — CSSOM only), no uppercase text (`test/design-guards.test.ts` guard 4), no
  browser-zone date reads outside `lib/time-zone.ts`, no restyled ui-kit primitives (`test/ui-kit-guard.test.ts`), reuse `client/src/components/ui/*`.
- Copy strings are the spec's, verbatim (§5.2 table, §7 table, §7.1–§7.4). `via <PARENT-KEY>` and `GitLab: …` exactly as written there.
- Comments explain *why*, at this repo's existing density. Tests flat in `test/` (jest). Commits: one per task, conventional type, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `git add <paths>` (never `-A`).
- Before each push-ready point, `grep -l <symbol> test/` for every shared hook/helper a task adds a caller of, and run those suites too (CLAUDE.md,
  "Touched includes the source guards").
- Every task that draws a view cites its mock under `docs/superpowers/specs/2026-11-12-gitlab-connection-mockups/`. The mock is the reference for words and
  placement; DESIGN.md wins on type sizes, colours (tokens in `shared/theme.css`) and primitives; the live layouts (deck + shelves, live Sources row) stay.

## Review Focus

1. **A remote carrying a PAT** (`https://oauth2:glpat-abc@www.gitlab.timify.io/ns/repo.git`) — nothing of `oauth2`/`glpat-abc` reaches the payload, an error
   string or a log line. Tests: Task 2 (parser output), Task 6 (route JSON).
2. **A 301/302 from GitLab** (the bare `gitlab.timify.io` answers 301) — never followed, the token header goes nowhere else, the row reads `unreachable`.
   Tests: Task 3 (client), Task 5 (state).
3. **Key boundaries** — an MR on `timify-1234-x` or titled `TIMIFY-1234 | x` never shows on `TIMIFY-123`; `hotfix/timify-123` and title `timify-123 | x`
   do. Tests: Task 4 and Task 8.
4. **GitLab down or slow while the Jira board loads** — the board, List and Detail render all their Jira content as today, nothing waits on GitLab, and
   delivery reads unknown (`—`) or is absent; `/api/gitlab` failing in the browser draws no delivery at all. Tests: Task 7 (provider error), Task 11 (List
   with a rejected payload).
5. **A stored `Pipeline failing` filter after GitLab is unconfigured** — every ticket shows; the filter count badge does not count it. Test: Task 12.

---

### Task 1: Env reader, compose passthrough, `.env.example`

**Files:**
- Create: `server/src/gitlab/env.util.ts`
- Modify: `docker-compose.yml:109-117` (after the `BM_JIRA_*` lines), `.env.example:139` (new block after the Jira block, before `BM_MACHINE_NAME`),
  `test/helpers/env.ts:113-115` (set `BM_GITLAB_SITE` and `BM_GITLAB_TOKEN` to `''` — plain `=`, not `||=` — beside the Jira trio, with its comment's
  reasoning: `ConfigModule.forRoot` loads `.env`, and from Task 6 on every `AppModule` suite's bootstrap would otherwise send the developer's real token to
  the real site)
- Test: `test/gitlab-env.test.ts` (new), `test/compose-env.test.ts` (extend, beside `describe('docker-compose BM_JIRA_SITE / …')` at `:119`)

**Interfaces:**
- Consumes: `isJiraHostname(value: string): boolean` (`server/src/jira/env.util.ts:30`) — reuse it, do not copy the regex.
- Produces: `GITLAB_ENV = { site: 'BM_GITLAB_SITE', token: 'BM_GITLAB_TOKEN' } as const`;
  `type GitlabEnv = { configured: true; site: string; token: string } | { configured: false; malformedSite: boolean; detail: string }`;
  `gitlabEnv(env: NodeJS.ProcessEnv = process.env): GitlabEnv` (site lower-cased).

- [ ] **Step 1: Write the failing tests** — `test/gitlab-env.test.ts`, `describe('gitlabEnv')`:
  - `{}` → `{ configured: false, malformedSite: false, detail: 'set BM_GITLAB_SITE and BM_GITLAB_TOKEN in .env and restart' }`.
  - site only, token only, token `'   '` → each `configured: false`, `malformedSite: false`, same detail.
  - `{ BM_GITLAB_SITE: ' WWW.GitLab.Timify.io ', BM_GITLAB_TOKEN: ' t0k ' }` → `{ configured: true, site: 'www.gitlab.timify.io', token: 't0k' }`.
  - each of `https://www.gitlab.timify.io`, `www.gitlab.timify.io/x`, `www.gitlab.timify.io:443`, `gitlab` (no dot) with a token →
    `{ configured: false, malformedSite: true, detail: 'BM_GITLAB_SITE must be a hostname, like gitlab.example.com' }`.
  - the detail string of every case above never contains the token value.
  - `test/compose-env.test.ts`, new `describe('docker-compose BM_GITLAB_SITE / BM_GITLAB_TOKEN')`, `it.each(Object.values(GITLAB_ENV))`: passthrough with an
    empty default (`'${NAME:-}'`), no literal value, spelled exactly as the server reads it — the three assertions the Jira describe makes.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-env.test.ts test/compose-env.test.ts` — FAIL (module not found / missing compose entries).
- [ ] **Step 3: Implement** `gitlabEnv` in `server/src/gitlab/env.util.ts` with a header comment in `token.util.ts:1-19`'s vein (why per call, why never
  cached, why the token never leaves the server). Add the two compose lines under the Jira block with a comment in the Jira block's style. Add the
  `.env.example` block in the GitHub/Jira house style: scope `read_api`, where to create it (GitLab › User settings › Access tokens), per machine, absent is
  supported (the board simply has no delivery marks), and a separate paragraph: the `mr-review-loop` skill a session runs needs its **own** token with
  `api` scope as `GITLAB_TOKEN` in `~/.zshenv` — the server's token is never handed to a session. Both lines commented out (`# BM_GITLAB_SITE=`).
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): read BM_GITLAB_SITE and BM_GITLAB_TOKEN from env`.

### Task 2: Remote parser

**Files:**
- Create: `server/src/gitlab/remote.util.ts`
- Test: `test/gitlab-remote.test.ts`

**Interfaces:**
- Consumes: nothing. Model on `parseGithubRemote` (`server/src/tracker/origin.util.ts:49-52`, `URL_LIKE`/`SCP_LIKE`) but keep the port, keep nested
  namespaces, never strip `www.`.
- Produces: `type ParsedRemote = { host: string; port: number | null; scheme: 'https' | 'http' | 'ssh' | 'scp'; path: string }` (host lower-cased,
  path without leading `/` or trailing `.git`/`/`, case kept);
  `parseGitRemote(url: string): ParsedRemote | null`; `remoteOnSite(remote: ParsedRemote, site: string): boolean`;
  `gitlabProjectId(path: string): string` (URL-encoded namespace path).

- [ ] **Step 1: Write the failing tests** — `describe('parseGitRemote')` with `it.each` rows (input → `{host, port, scheme, path}`):
  - `git@www.gitlab.timify.io:development/backend/microservice.git` → `www.gitlab.timify.io`, `null`, `scp`, `development/backend/microservice`.
  - `ssh://git@www.gitlab.timify.io:2222/development/backend/microservice.git` → port `2222`, `ssh`, same path.
  - `https://www.gitlab.timify.io/development/dev-api-graphql-proxy.git` → `null`, `https`, `development/dev-api-graphql-proxy`.
  - `https://oauth2:glpat-abc@www.gitlab.timify.io/ns/repo.git` → host `www.gitlab.timify.io`, path `ns/repo`, and `JSON.stringify(result)` contains
    neither `oauth2` nor `glpat-abc`.
  - `https://WWW.GitLab.Timify.io:443/NS/Repo/` → host `www.gitlab.timify.io`, port `443`, path `NS/Repo`.
  - `''`, `not a url`, `https://host-only.example`, `/local/path/repo.git` → `null`.
  - `describe('remoteOnSite')` with site `www.gitlab.timify.io`: true for the scp, ssh-on-2222 (ssh ports are not https ports — any ssh port is on the
    site), https no-port and https `:443` rows; false for `https://www.gitlab.timify.io:8443/ns/r`, `git@gitlab.timify.io:ns/r.git` (no `www.` aliasing),
    `git@github.com:o/r.git`, and `http://www.gitlab.timify.io/ns/r.git` (an `http://` remote is never on the site: the server only speaks https, and
    ssh/scp remotes on any port and https remotes with no port or 443 are the only ones spec §6.1 admits).
  - `gitlabProjectId('development/backend/microservice')` → `'development%2Fbackend%2Fmicroservice'`.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-remote.test.ts` — FAIL.
- [ ] **Step 3: Implement.** One comment line on why userinfo is never captured (a remote on this machine can be `https://oauth2:<PAT>@…`, spec §4).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): parse git remotes into host and namespace path`.

### Task 3: GitLab client — redirect refused, deadline, paging by number

**Files:**
- Create: `server/src/gitlab/gitlab.client.ts`, `test/helpers/gitlab.ts`
- Test: `test/gitlab-client.test.ts`

**Interfaces:**
- Consumes: `gitlabProjectId` (Task 2). Model on `JiraClient` (`server/src/jira/jira.client.ts:31,44,55,75-79,184-206`): injected `FetchLike`, own
  `setTimeout` + `AbortController` deadline (not `AbortSignal.timeout`, so fake timers work), transport failure → status `0`.
- Produces:
  - `GITLAB_TIMEOUT_MS = 10_000`; `GITLAB_PER_PAGE = 100`.
  - `type GitlabResponse<T> = { status: number; data: T | null; message: string | null; retryAfter: number | null }` — `status: 0` for no HTTP answer
    **and** for a refused 3xx, with `message` `redirect refused (<code>)`; `message` for a non-2xx is GitLab's `message`/`error` field when present,
    else `null`; `retryAfter` in seconds from `Retry-After`.
  - `class GitlabClient { constructor(fetchImpl: FetchLike = fetch) }` with `currentUser(site, token): Promise<GitlabResponse<{ username: string; name: string }>>`,
    `listMergeRequests(site, token, projectPath, q: { state: 'opened' | 'merged' | 'closed'; updatedAfter?: string; page: number }): Promise<GitlabResponse<RawMr[]>>`,
    `mergeRequest(site, token, projectPath, iid: number): Promise<GitlabResponse<RawMr>>`. `RawMr` = the subset of GitLab's MR JSON Task 5 reads (`iid,
    title, web_url, state, draft, source_branch, target_branch, created_at, updated_at, merged_at, head_pipeline?: { status } | null`).
  - `test/helpers/gitlab.ts`: `class FakeGitlab` with a `fetch` property (a `FetchLike`) that records every call (`url`, `init`), serves `/user`, the MR list
    per project/state/page, MR detail, and lets a test script a status, a `Retry-After`, a 3xx, a delay or a thrown network error per path. Model on
    `test/helpers/jira.ts` `FakeJira` (`:100`).

- [ ] **Step 1: Write the failing tests** (`describe('GitlabClient')`):
  - `currentUser('www.gitlab.timify.io', 'tok')` fetches exactly `https://www.gitlab.timify.io/api/v4/user` with header `PRIVATE-TOKEN: tok` and
    `redirect: 'manual'`; a 200 answers `{ status: 200, data: { username, name } }`.
  - `listMergeRequests(site, tok, 'development/backend/microservice', { state: 'merged', updatedAfter: '2026-10-13T00:00:00.000Z', page: 2 })` fetches a URL
    whose path is `/api/v4/projects/development%2Fbackend%2Fmicroservice/merge_requests` and whose query has `state=merged`, `updated_after=` that ISO,
    `order_by=updated_at`, `sort=desc`, `per_page=100`, `page=2`.
  - a fake answering 302 with `Location: https://evil.example/` → `{ status: 0, message: 'redirect refused (302)' }`, and the fake saw exactly one call (to
    the site).
  - a fake answering an opaque-redirect response (`type: 'opaqueredirect'`, `status: 0`) → the same `redirect refused` shape (undici's `manual` mode can
    return either; handle both).
  - 429 with `Retry-After: 30` → `{ status: 429, retryAfter: 30 }`. 401 with `{"message":"401 Unauthorized"}` → `message: '401 Unauthorized'`.
  - a thrown `TypeError('fetch failed')` → `{ status: 0, message: 'fetch failed' }`; a fake that never resolves → after `GITLAB_TIMEOUT_MS` (jest fake
    timers) `{ status: 0, message: 'timed out after 10000 ms' }`.
  - for every call above, no `message` contains the token.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-client.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Comment why `manual` and not `follow` (a followed redirect carries `PRIVATE-TOKEN` to wherever it points — spec §4) and why
  not `error` (the row needs the code).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): read-only GitLab client that refuses redirects`.

### Task 4: Repo → project mapping and MR keys

**Files:**
- Create: `server/src/gitlab/mapping.util.ts`
- Test: `test/gitlab-mapping.test.ts`

**Interfaces:**
- Consumes: `parseGitRemote`, `remoteOnSite` (Task 2); `runGit` (`server/src/git-run.util.ts:70`); `keysInBranch(branch, projectKeys)`
  (`shared/jira-branch.ts:77`).
- Produces:
  - `type GitlabProjectTarget = { path: string; repo: string; jiraKeys: string[] }` — `repo` is the basename of the first `jira.json` path that resolved
    to this project; `jiraKeys` sorted, distinct.
  - `type GitlabMapping = { projects: GitlabProjectTarget[]; foundHosts: string[]; originFailures: string[] }` — `foundHosts`: distinct, sorted hosts of
    remotes that parsed but are not on the site; `originFailures`: basenames whose `origin` read answered `null` or did not parse.
  - `resolveGitlabProjects(repos: Record<string, string[]>, site: string, readOrigin: (repoPath: string) => Promise<string | null> = <runGit get-url origin>): Promise<GitlabMapping>`
    — reads origins concurrently; one GitLab project mapped from two Jira keys (or two paths) is one target.
  - `mrKeys(sourceBranch: string, title: string, jiraKeys: readonly string[]): string[]` — `keysInBranch(source)` ∪ `keysInBranch(title)`, upper-case,
    distinct, sorted.
  - `type GitlabPipeline = 'success' | 'failed' | 'running' | 'canceled' | 'none'` (put it in `shared/types.ts`, Task 5 adds the rest of the payload
    types there); `foldPipeline(status: string | null | undefined): GitlabPipeline` — §6.3's fold; `foldMrState(state: string): 'opened' | 'merged' | 'closed' | null`
    (`locked` → `opened`, unknown → `null`, row dropped).

- [ ] **Step 1: Write the failing tests:**
  - `resolveGitlabProjects({ TIMIFY: ['/r/microservice', '/r/proxy', '/r/gh'], PAY: ['/r/microservice', '/r/none'] }, 'www.gitlab.timify.io', fake)` where
    the fake answers scp for microservice, https-with-`oauth2:glpat-x@` for proxy, `git@github.com:o/r.git` for gh, `null` for none → projects
    `[{ path: 'development/backend/microservice', repo: 'microservice', jiraKeys: ['PAY','TIMIFY'] }, { path: 'development/dev-api-graphql-proxy', repo: 'proxy', jiraKeys: ['TIMIFY'] }]`
    (sorted by path), `foundHosts: ['github.com']`, `originFailures: ['none']`; `JSON.stringify(result)` has no `glpat-x`.
  - an empty `repos` → `{ projects: [], foundHosts: [], originFailures: [] }` and the fake was never called.
  - `mrKeys('hotfix/timify-123', 'x', ['TIMIFY'])` → `['TIMIFY-123']`; `mrKeys('feature/x', 'timify-123 | Export', ['TIMIFY'])` → `['TIMIFY-123']`;
    `mrKeys('timify-1234-x', 'TIMIFY-1234 | y', ['TIMIFY'])` → `['TIMIFY-1234']` (and so never `TIMIFY-123`); `mrKeys('xtimify-123', 'z', ['TIMIFY'])` →
    `[]`; `mrKeys('timify-123-a', 'TIMIFY-140 | b', ['TIMIFY'])` → `['TIMIFY-123','TIMIFY-140']`; `mrKeys('pay-7', 'q', ['TIMIFY'])` → `[]`.
  - `foldPipeline`: `success`→`success`; `failed`→`failed`; each of `running pending created waiting_for_resource preparing canceling`→`running`;
    `canceled`→`canceled`; each of `skipped manual scheduled`, `null`, `undefined`, `'brand_new_status'`→`none`.
  - `foldMrState`: `opened`/`locked`→`opened`, `merged`, `closed`, `'weird'`→`null`.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-mapping.test.ts` — FAIL.
- [ ] **Step 3: Implement.** One line on why the existing matcher is reused (an MR and a session must agree on a branch's ticket, spec §6.2).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): map Jira repos to GitLab projects and MRs to ticket keys`.

### Task 5: Poller service, cache and status

**Files:**
- Create: `server/src/gitlab/poller.service.ts`
- Modify: `shared/types.ts` (new block after `PullRequestsPayload`, `:676`)
- Test: `test/gitlab-poller.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `readJiraConfig()` (`server/src/jira/config.util.ts:239`, `.repos`); `JiraLiveService.onReposChanged(listener)`
  (`server/src/jira/live.service.ts:348`). Shape after `TrackerPollerService` (`server/src/tracker/poller.service.ts:376-504,794-851`): `timer`,
  `inFlight`, `stopped`, `arm()`, `disarm()`, `tick()` joining `inFlight`, `schedule()` with `unref`. 429 window after the Jira poller
  (`server/src/jira/poller.service.ts:632-641,815-827`): one stored `retryAt`, expired where read.
- Produces (types in `shared/types.ts`):
  - `GitlabMr = { project: string; iid: number; title: string; webUrl: string; state: 'opened' | 'merged' | 'closed'; draft: boolean; sourceBranch: string; targetBranch: string; createdAt: string; updatedAt: string; mergedAt: string | null; pipeline: GitlabPipeline | null; keys: string[] }`
    — `pipeline` `null` for merged/closed (not read).
  - `GitlabProjectView = { path: string; repo: string; polledAt: string | null; capped: boolean; failed: boolean }`.
  - `GitlabRepoProblem = { kind: 'cannot-read'; path: string; status: 403 | 404 } | { kind: 'origin'; repo: string } | { kind: 'capped'; path: string; shown: number }`.
  - `GitlabState = 'unconfigured' | 'checking' | 'rejected' | 'unreachable' | 'idle' | 'connected'`.
  - `GitlabStatus` (`mappedRepos` = distinct GitLab projects on the site) `= { state: GitlabState; site: string | null; malformedSite: boolean; user: { username: string; name: string } | null; httpStatus: number | null; reason: string | null; armed: boolean; retryAt: string | null; mappedRepos: number; foundHosts: string[]; problems: GitlabRepoProblem[] }`.
  - `GitlabPayload = { status: GitlabStatus; jiraProjects: Record<string, GitlabProjectView[]>; mrs: GitlabMr[] }` — `jiraProjects` keyed by Jira project
    key, each the views of the projects that key maps on the site.
  - `GITLAB_POLL_MS = 120_000`, `GITLAB_SWEEP_WAIT_MS = 20_000`, `GITLAB_RATE_LIMIT_DEFAULT_MS = 60_000`, `GITLAB_PAGES_PER_PROJECT = 5`,
    `GITLAB_FINISHED_DAYS = 30`, `GITLAB_IDENTITY_RETRY_MS = 60_000`.
  - `class GitlabPollerService implements OnApplicationBootstrap, OnApplicationShutdown` — constructor
    `(client: GitlabClient, live: JiraLiveService, deps?: { repos?: () => Record<string, string[]>; readOrigin?: (p: string) => Promise<string | null>; env?: () => NodeJS.ProcessEnv; now?: () => number })`
    (defaults: `readJiraConfig().repos`, the runGit read, `process.env`, `Date.now`); subscribes `live.onReposChanged(() => this.arm())` in the constructor.
    Members: `get armed(): boolean` (true while a timer is pending **or** a sweep is in flight — unlike the tracker's `timer !== null`, which reads false
    for the whole of a sweep and would drop every delivery surface during each one); `arm(): void`; `disarm(): void`; `tick(): Promise<void>`; `sweepNow(): Promise<GitlabSweepResult>` with
    `GitlabSweepResult = { kind: 'done' } | { kind: 'not-armed' } | { kind: 'wait'; retryAt: number }`; `payload(): GitlabPayload`.

**Behaviour the tests pin** (spec §5.2, §6.1, §6.3):
- Identity: read at bootstrap, and again when a **fingerprint** of (site, token) changes — a SHA-256 of the pair held in memory, never the token itself —
  noticed by `payload()` or a sweep; `payload()` then answers `checking` and starts the read without awaiting it. Identity read status → state: 200 →
  working token; 401/403 → `rejected` (`httpStatus`, `reason` = GitLab's message); status 0 (incl. refused 3xx) or 5xx → `unreachable` (`reason`).
  Independent of arming. While the identity is unanswered or `unreachable`, it is retried at the top of each sweep and by `payload()` at most once per
  `GITLAB_IDENTITY_RETRY_MS = 60_000` (the tracker's `IDENTITY_RETRY_MS` precedent, `server/src/tracker/poller.service.ts:95`), un-awaited. Both callers
  share one pace, measured from the last identity read's start, and an identity read in flight is never duplicated (callers join it). A `rejected`
  identity is re-read only on a fingerprint change or a 401 (spec §5.2).
- `arm()`: returns if stopped, if unconfigured, if a timer or sweep exists; else starts `tick()`. A sweep re-derives the mapping; zero projects on the
  site → no successor, timer cleared (disarmed), state `idle` once identity is good. A successful identity read with ≥ 1 project → `connected`.
- Sweep per project, in order, within `GITLAB_PAGES_PER_PROJECT` page requests: `opened` pages until a page shorter than 100; then `merged` and then
  `closed`, each with `updated_after` = now − 30 days. Budget spent while the last page was full → `capped: true`, problem
  `{ kind: 'capped', path, shown: <rows kept> }`. Each MR's `keys` = `mrKeys(source, title, target.jiraKeys)`; MRs with no keys are dropped. Then one
  `mergeRequest` call per kept (keyed) **opened** MR for `head_pipeline` (none for merged/closed or keyless ones). A detail call that fails (any non-200
  other than 401/429, which follow their own rules) leaves that MR's `pipeline` at the last good value for the same project + iid, else `none`; it does
  not mark the project `failed`.
- A project's list answering 403/404 → that project `failed: true`, problem `cannot-read`, its previous MRs kept. Any call answering 401 → identity re-read
  at once (state turns `rejected` within the sweep). Status 0 (incl. a refused 3xx) or 5xx on a project → `failed: true`, previous MRs and `polledAt`
  kept, **and the state turns `unreachable`** with `reason` = the first such call's message (spec §5.2: "the identity read or a sweep gets no HTTP
  answer"); the next sweep in which no call fails that way restores `connected`. Success → MRs replaced, `polledAt` = now, `failed: false`. A
  **detail** call answering 0/5xx/3xx also turns the state `unreachable` (the project stays `failed: false`); a detail 403/404 does neither.
- **State precedence** (one function, read by `payload()`): `unconfigured` if the env is; else the identity verdict while it is not a working token
  (`checking`, `rejected`, or `unreachable` from the identity read); else `unreachable` while the last finished sweep had a 0/5xx/3xx call; else `idle`
  (no project on the site) or `connected`.
- 429 anywhere → `retryAt = now + (Retry-After s × 1000 or GITLAB_RATE_LIMIT_DEFAULT_MS)`; the sweep stops; `status.retryAt` is the ISO instant while
  `now < retryAt`, else `null`; `sweepNow()` inside the window → `{ kind: 'wait', retryAt }`; the next timer sweep waits it out.
- `sweepNow()`: not armed (no timer, no sweep in flight, after `arm()` found nothing) → `not-armed`; otherwise joins or starts `tick()` and awaits it
  raced against `GITLAB_SWEEP_WAIT_MS` (unref'd), answering `done` either way.

- [ ] **Step 1: Write the failing tests** (`test/gitlab-poller.test.ts`, over `FakeGitlab` and injected `repos`/`readOrigin`/`env`/`now`; a stub
  `JiraLiveService`-shaped object with `onReposChanged`):
  - unconfigured env → `payload().status` = `{ state: 'unconfigured', site: null, armed: false, … }`; `arm()` makes no fetch.
  - configured with a mapped repo: while the first sweep's list call is pending (fake holds it), `armed` is `true` and `payload().status.armed` is `true`.
  - configured, identity 200, repos map microservice only → after `await svc.tick()`: state `connected`, `user.username` from the fake, `mappedRepos: 1`,
    `armed: true`, `jiraProjects.TIMIFY[0]` `{ path: 'development/backend/microservice', repo: 'microservice', capped: false, failed: false }` with
    `polledAt` = the injected now as ISO.
  - MR fixture with distinct values per field: open `!412` (branch `timify-123-export`, pipeline `success`), open draft `!419` (title `TIMIFY-150 | split`,
    pipeline `failed`), merged `!398` (`fix/timify-118`), closed `!390` (`timify-117`), open `!500` with branch `chore/deps` → `mrs` holds 412, 419, 398,
    390 with keys `['TIMIFY-123']`, `['TIMIFY-150']`, `['TIMIFY-118']`, `['TIMIFY-117']`; 412 `pipeline: 'success'`, 419 `pipeline: 'failed'`, 398 and 390
    `pipeline: null`; `!500` absent. Detail calls were made for 412 and 419 only — none for 398/390 (finished) or `!500` (keyless).
  - pipeline survives a failed detail read: second sweep, the detail call for 412 answers 500 → 412 still `pipeline: 'success'`, project `failed: false`;
    a brand-new opened MR whose detail call answers 500 → `pipeline: 'none'`; in both, state `unreachable` after that sweep (precedence rule), and a detail
    call answering 404 instead leaves the state `connected`.
  - the merged/closed list URLs carry `updated_after` = injected now − 30 days.
  - two Jira keys: repos `{ TIMIFY: [microservice, proxy], PAY: [microservice] }`; proxy holds an open MR on `pay-7` and microservice one on
    `pay-8-fix` → `jiraProjects.PAY` lists microservice only, `jiraProjects.TIMIFY` both; the microservice MR has keys `['PAY-8']`, and the proxy MR is
    absent (proxy maps TIMIFY only, so `pay-7` yields no key).
  - cap: the fake answers 100 opened rows on each of pages 1–5 → `capped: true`, problem `{ kind: 'capped', path, shown: 500 }`, and no merged/closed page
    was requested.
  - repos map microservice and proxy; proxy's list answers 404 → microservice `failed: false`, proxy `failed: true`, problem
    `{ kind: 'cannot-read', path: 'development/dev-api-graphql-proxy', status: 404 }`, state still `connected`.
  - identity 401 → `rejected`, `httpStatus: 401`; identity 403 → `rejected`; identity 302 → `unreachable`, `reason: 'redirect refused (302)'`; identity
    503 → `unreachable`.
  - bootstrap with a healthy identity and a mapped repo → after the first sweep, exactly one `/user` call was made.
  - identity 503 at bootstrap with a mapped repo, first sweep's MR calls healthy → still `unreachable`, `user: null` (precedence).
  - `payload()` retry: identity 503 → `unreachable`; the fake then answers 200; `now` + 30 s → `payload()` makes no `/user` call; `now` + 60 s →
    `payload()` re-reads it and the state becomes `connected`.
  - sweep retry: identity 503, no `payload()` calls; `now` + 60 s and a sweep → the sweep re-reads `/user` and the state becomes `connected`; a repo-less
    variant ends `idle`.
  - good identity, then a project list answers 401 on the next sweep → identity is re-read during that sweep and state is `rejected` after it.
  - failure keeps last good: first sweep returns `!412`; second sweep gets status 0 (`fetch failed`) on that project → `mrs` still holds `!412`,
    `polledAt` unchanged, `failed: true`, state `unreachable`, `reason: 'fetch failed'`; a third sweep whose list answers 302 → `unreachable`,
    `reason: 'redirect refused (302)'`, and the fake saw no call to the `Location` host; a fourth, healthy sweep → `connected`, `failed: false`.
  - 429 with `Retry-After: 30` → `status.retryAt` = now + 30 000 as ISO; `sweepNow()` → `{ kind: 'wait', retryAt }`; with `now` advanced past it,
    `status.retryAt` is `null`.
  - no repo on the site (only github remote) and identity 200 → state `idle`, `armed: false`, `foundHosts: ['github.com']`; a later `onReposChanged`
    listener call with a mapped repo arms it (a fetch to the MR list happens).
  - one sweep in flight: two `sweepNow()` calls and a `tick()` while the fake's list call is pending → exactly one `/merge_requests?state=opened&page=1`
    request for the project.
  - `sweepNow()` against a fake that never answers resolves `{ kind: 'done' }` after `GITLAB_SWEEP_WAIT_MS` (fake timers).
  - env token changes between two `payload()` calls → the second answers `checking` and a new `/user` call is made; `JSON.stringify(payload())` never
    contains the token in any test.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-poller.test.ts` — FAIL.
- [ ] **Step 3: Implement**, with a header comment on why the poller is decoupled from the Jira boards (spec §6.3) and why failure keeps the last answer.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): poll mapped GitLab projects into an in-memory MR cache`.

### Task 6: Routes and module

**Files:**
- Create: `server/src/gitlab/gitlab.controller.ts`, `server/src/gitlab/gitlab.module.ts`
- Modify: `server/src/app.module.ts:5-13,17-31` (import and register `GitlabModule`)
- Test: `test/gitlab-routes.test.ts`

**Interfaces:**
- Consumes: `GitlabPollerService`, `GitlabClient` (Tasks 3, 5); `SameOriginPostGuard` (`server/src/agents/origin.guard`, as `settings.module.ts` uses it);
  `JiraModule` exports `JiraLiveService` (`server/src/jira/jira.module.ts:38`).
- Produces: `GET /api/gitlab` → `GitlabPayload` (from memory; no outbound call awaited). `POST /api/gitlab/sweep` (guarded) → 200 `{ ok: true }` on
  `done`; 409 `{ message: 'GitLab is not being polled' }` on `not-armed`; 429 `{ message: 'rate limited', retryAt: <ISO> }` on `wait` — the shapes of
  `jira-write.controller.ts:106-116`. `POST /api/gitlab/sweep` calls `arm()` first (spec §6.3 "What arms it"). `GitlabModule` = `imports: [JiraModule]`,
  `controllers: [GitlabController]`, `providers: [GitlabPollerService (factory), { provide: GitlabClient, useFactory: () => new GitlabClient() }, SameOriginPostGuard]`.
  Bootstrap calls `arm()` and the identity read.

- [ ] **Step 1: Write the failing tests** (model: `test/github-sweep-route.test.ts:51,88-90`, `Test.createTestingModule({ imports: [AppModule] })` +
  supertest; set `BM_GITLAB_*` in `process.env` per test and restore):
  - unconfigured: `GET /api/gitlab` → 200, `status.state: 'unconfigured'`, `mrs: []`; `POST /api/gitlab/sweep` (same-origin headers as the GitHub test) →
    409 `{ message: 'GitLab is not being polled' }`.
  - a cross-origin `POST /api/gitlab/sweep` → 403 (the guard).
  - with `BM_GITLAB_TOKEN=glpat-SECRET-123` and `BM_GITLAB_SITE=www.gitlab.example.com` set, the `GitlabClient` provider overridden with one on a
    `FakeGitlab`, and `BM_JIRA_FILE` pointed at a temp `jira.json` (the shape `readJiraConfig` reads) mapping `TIMIFY` to a temp repo made with `git init` +
    `git remote add origin https://oauth2:glpat-abc@www.gitlab.example.com/ns/repo.git`: after `POST /api/gitlab/sweep`, the `GET /api/gitlab` body text
    contains none of `glpat-SECRET-123`, `glpat-abc`, `oauth2` — run once with identity 200 (and assert `jiraProjects.TIMIFY[0].path === 'ns/repo'`, so
    the remote really was read) and once with identity 401.
  - armed, healthy: `POST /api/gitlab/sweep` → 200 `{ ok: true }`; inside a 429 window (`Retry-After: 30`) → 429 `{ message: 'rate limited', retryAt }`
    with `retryAt` an ISO string.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-routes.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it plus `test/vite-proxy.test.ts` and `test/github-sweep-route.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): serve GitLab status and MRs at /api/gitlab`.

### Task 7: Client provider, hook and Read again

**Files:**
- Create: `client/src/hooks/useGitlab.ts`, `client/src/hooks/GitlabContext.tsx`
- Modify: `client/src/App.tsx:84-99` (mount `GitlabProvider` inside `JiraProvider`, wrapping what `PullRequestsProvider` wraps), `client/src/lib/sweep.ts`
  (`SweepService` gains `'gitlab'`: URL `/api/gitlab/sweep`, name `GitLab`), `test/poll-coalescing.test.tsx:88-140` (`SUBJECTS` entry appended last, `GATED` exclusion)
- Test: `test/gitlab-context.test.tsx`, `test/poll-coalescing.test.tsx`

**Interfaces:**
- Consumes: `useRefreshing(task, { armed, intervalMs })` (`client/src/hooks/useRefreshing.ts:23`); `GitlabPayload` (Task 5). Model:
  `client/src/hooks/usePullRequests.ts:13,31,51` and `PullRequestsContext.tsx` (minus its enable gate — GitLab's status is always read, the Sources row
  needs it).
- Produces: `GITLAB_CLIENT_POLL_MS = 30_000`; `useGitlab(): { data: GitlabPayload | null; error: string | null; refresh: () => Promise<GitlabPayload | null> }`;
  `GitlabProvider({ children })`; `useGitlabContext()` (throws outside the provider, like `usePullRequestsContext`).

- [ ] **Step 1: Write the failing tests** — `test/gitlab-context.test.tsx` (jsdom, mocked `fetch`): a 200 payload reaches a consumer's `data`; a 500 or a
  network error leaves `data: null` and sets `error`, and a consumer rendered beside it still renders its own content (Review Focus 4); `useGitlabContext`
  outside the provider throws. `poll-coalescing`: append a `useGitlab` entry **last** in `SUBJECTS` (index lookups below it must keep pointing at their
  hooks), modelled on the `useTicks` entry (`:126-131`) — a POLLER with nothing in its answer that disarms it — and add it to the `GATED` exclusion
  (`:140`) beside `useWatchdog` and `useTicks`, with a comment saying why (the Sources row needs the status whatever GitLab answers).
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-context.test.tsx test/poll-coalescing.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Then `grep -l 'useRefreshing\|postSweep\|SweepService' test/` and add each hit to the run.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): one shell-level GitLab reader for the client`.

### Task 8: Delivery logic (pure)

**Files:**
- Create: `client/src/lib/delivery.ts`
- Test: `test/delivery-lib.test.ts`

**Interfaces:**
- Consumes: `GitlabPayload`, `GitlabMr` (Task 5); `JiraIssue` (`shared/types.ts:767`: `key`, `project.key`, `type.subtask`, `parent`, `status.category`);
  `polledPhrase(polledAt, now)` (`client/src/lib/jira.ts:466`).
- Produces:
  - `type DeliveryIndex` (opaque to callers) and `deliveryIndex(payload: GitlabPayload): DeliveryIndex` — MRs by key plus `jiraProjects`.
  - `deliveryShown(payload: GitlabPayload | null): boolean` — `status.state !== 'unconfigured'` and `status.armed` (spec §7, "the surfaces exist" while
    configured and armed — a `rejected` or `unreachable` row that is still armed keeps the surfaces, so unknown tickets can say `GitLab could not be read`).
  - `type TicketDelivery = { kind: 'hidden' } | { kind: 'unknown'; why: 'not-read' | 'failed' | 'capped' } | { kind: 'none'; repos: string[] } | { kind: 'mrs'; lead: GitlabMr; also: GitlabMr[]; via: string | null; notMerged: boolean; polledAt: string | null }`.
  - `ticketDelivery(issue: JiraIssue, index: DeliveryIndex): TicketDelivery` — `hidden` when the issue's `project.key` maps no project on the site; own
    MRs if any; else, for `type.subtask && parent`, the parent key's own MRs with `via: parent.key` (one level); `unknown` when no MR and any mapped project
    has `polledAt: null` (`not-read`; `failed` if that project is `failed`) or is `capped`; else `none` with the mapped `repo` basenames. `notMerged` =
    `status.category === 'done'` and lead `opened` and `via === null`. `polledAt` = the lead MR's project's.
  - `leadMr(mrs: GitlabMr[]): { lead: GitlabMr; also: GitlabMr[] }` — newest `opened` by `updatedAt`, else newest `merged`, else newest `closed`; ties →
    project path ascending, then higher iid.
  - `type DeliveryTone = 'green' | 'red' | 'amber' | 'magenta' | 'grey'`; `type TrackStep = { step: 'pushed' | 'open' | 'pipeline' | 'merged' | 'closed'; mark: 'on' | 'off' | DeliveryTone }`;
    `deliveryLook(mr: GitlabMr): { chip: string; word: string; tone: DeliveryTone; track: TrackStep[] }` — §7's table exactly; the step list is data
    (an array the surfaces map over), so project 2 can insert `review`.
  - `bandTotals(tops: JiraIssue[], index: DeliveryIndex, now: number): string | null` — §7.2's line, `null` when no top draws delivery.
  - `type DeliveryFilter = 'all' | 'has-mr' | 'failing' | 'done-not-merged'`; `DELIVERY_FILTER_LABELS: Record<DeliveryFilter, string>` = `All`, `Has MR`,
    `Pipeline failing`, `Done, not merged`; `matchesDelivery(filter: DeliveryFilter, d: TicketDelivery): boolean` — §7.4 (`all` always true; `hidden` and
    `unknown` match no other value).

- [ ] **Step 1: Write the failing tests** (`test/delivery-lib.test.ts`; fixture MRs with distinct iids, branches, `updatedAt`s and projects):
  - `deliveryLook`, `it.each` over §7's eight rows — exact `chip`, `word`, `tone`, and `track` marks, e.g. opened+success →
    `{ chip: '!412 · ✓ pipeline', word: 'pipeline passed', tone: 'green', track: on, on, green, off }`; opened draft with pipeline `failed` →
    `!419 · draft`/`draft`/grey/`on, grey, off, off`; merged → `!398 · merged`/`merged`/magenta/four magenta; closed → `!390 · closed`/`closed`/grey with
    steps `pushed on, open on, pipeline off, closed grey` (a `closed` end replaces `merged`).
  - `leadMr`: opened(updated 10:00) beats merged(updated 12:00); two opened with equal `updatedAt` in projects `a/x` and `b/y` → `a/x`'s; same project,
    equal time, iids 7 and 9 → 9; no opened, merged(09:00) vs closed(11:00) → merged.
  - `ticketDelivery`: own MRs; sub-task (`subtask: true`, parent `TIMIFY-100`) with none of its own → parent's lead, `via: 'TIMIFY-100'`; sub-task with
    its own → own, `via: null`; a story under an epic (`subtask: false`, parent set) with none → `none`, not the epic's; grandparent never consulted;
    project `PAY` with no mapped project → `hidden`; mapped project `polledAt: null` → `unknown`/`not-read`; `failed` and never read → `unknown`/`failed`;
    capped and no MR → `unknown`/`capped`; `failed: true` but `polledAt` set
    (read once, failing now) and no MR → `none`, not `unknown` (spec §7: a known ticket stays known); read and none → `{ kind: 'none', repos: ['microservice'] }`; `done` + own opened → `notMerged: true`; `done` +
    inherited opened → `notMerged: false`; `done` + own merged → `false`.
  - key boundary through the index: an MR keyed `TIMIFY-1234` never appears for `TIMIFY-123`.
  - `bandTotals` over tops: leads `!412` opened/success, `!415` opened/failed, `!419` draft/failed, `!398` merged, `!390` closed, and two tops both
    leading with `!398` → `GitLab: 3 open · 1 failing · 1 merged · polled …` (draft counts in `open`, not `failing`; `!398` once; closed uncounted); all
    leads closed → `GitLab: no merge requests · polled …`; a top whose project has `polledAt: null` → `GitLab: not read yet`; the age is the **oldest**
    `polledAt` among the tops' projects (two projects polled 1 m and 5 m ago → the `polledPhrase` of the 5 m one).
  - `matchesDelivery`: `has-mr` true for own opened, inherited merged; false for closed-only and `unknown`; `failing` true for lead opened non-draft
    `failed` (own or inherited), false for a draft `failed`; `done-not-merged` mirrors `notMerged`; every non-`all` value false for `hidden`/`unknown`.
  - `deliveryShown`: `connected`+armed and `rejected`+armed true; `unconfigured`, `idle` (unarmed), `connected`+unarmed, `null` false.
- [ ] **Step 2: Run** `pnpm exec jest test/delivery-lib.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): derive each ticket's delivery state from the MR cache`.

### Task 9: Sources card GitLab row — mock `Settings.dc.html`

**Files:**
- Modify: `client/src/components/settings/SourcesGroup.tsx` (row after Jira `:148-158`; `readAgain` `:86-103` adds `postSweep('gitlab')`; foot age
  `answers` `:55` adds GitLab's), `test/sources-group.test.tsx`
- Test: `test/sources-group.test.tsx`

**Interfaces:**
- Consumes: `useGitlabContext()` (Task 7); `postSweep('gitlab')` (Task 7); `SettingsRow`, `StatusPill`, `CARD_WORD`, `Lines` (same file);
  `ageText`/`polledPhrase` for `<age>`.
- Produces: `gitlabLines(status: GitlabStatus, now: number): string[]` and `gitlabTone(status): StateTone` (export from the component file or
  `client/src/lib/service-status.ts`, beside `jiraTone`'s helpers).

- [ ] **Step 1: Write the failing tests** — one `it` per §5.2 row, asserting the pill word and every hint line verbatim:
  - unconfigured → grey `not configured`, `set BM_GITLAB_SITE and BM_GITLAB_TOKEN in .env and restart`; malformed →
    `BM_GITLAB_SITE must be a hostname, like gitlab.example.com`.
  - checking → grey `checking…`, `www.gitlab.timify.io`.
  - rejected 401 with reason `401 Unauthorized` → red `down`, `www.gitlab.timify.io refused the token (401) — 401 Unauthorized`; with no reason → the line
    ends at `(401)`.
  - unreachable `redirect refused (301)` → red `down`, `www.gitlab.timify.io did not answer — redirect refused (301)`.
  - idle with `foundHosts: ['gitlab.timify.io']` → grey `not polled yet`, `andreja · www.gitlab.timify.io`,
    `no mapped repository is on www.gitlab.timify.io — found gitlab.timify.io`; with `[]` → no ` — found` suffix.
  - connected, 2 repos, problems `cannot-read 403`, `origin`, `capped 500` → green `connected`, `andreja · www.gitlab.timify.io`,
    `2 repos mapped via Jira › Setup › Repositories`, `cannot read development/dev-api-graphql-proxy (403)`, `proxy: could not read origin`,
    `development/backend/microservice: first 500 shown`.
  - connected + `retryAt` 90 s ahead → amber `late`, connected lines then `rate limited — next read in …` (the age helper's text).
  - Read again posts to `/api/github/sweep`, `/api/jira/sweep` and `/api/gitlab/sweep`; a 409 from GitLab adds no notice.
- [ ] **Step 2: Run** `pnpm exec jest test/sources-group.test.tsx` — FAIL.
- [ ] **Step 3: Implement**, live row shape (no `new` tag, no scope word — spec §5.2).
- [ ] **Step 4: Run** — PASS (plus any `grep -l 'SourcesGroup\|CARD_WORD' test/` hits).
- [ ] **Step 5: Commit** `feat(gitlab): GitLab row on Settings › Sources`.

### Task 10: Detail Delivery pane — mock `OptionC.dc.html`

**Files:**
- Create: `client/src/components/jira/DeliveryTrack.tsx` (the track dots + words, shared by Tasks 10–11), `client/src/components/jira/DeliveryPane.tsx`
- Modify: `client/src/components/jira/JiraDetail.tsx` (between the sessions band's end `:400` and History `:401`), `client/src/styles.css` (near
  `.jira-detail-pane` `:1482-1510`)
- Test: `test/jira-delivery-pane.test.tsx`

**Interfaces:**
- Consumes: `ticketDelivery`, `deliveryLook`, `TrackStep`, `polledPhrase` (Task 8); `useGitlabContext()`; `.jira-detail-lbl`/`.jira-detail-pane` styles.
- Produces: `DeliveryTrack({ track, words?, compact }: { track: TrackStep[]; words?: Partial<Record<TrackStep['step'], string>>; compact: boolean })` —
  `compact` draws dots only (List); otherwise dots with step labels and words. `DeliveryPane({ issue, now }: { issue: JiraIssue; now: number })`.

- [ ] **Step 1: Write the failing tests** (jsdom; render `DeliveryPane` under a `GitlabContext` value):
  - opened/success own MR `!412` in `development/backend/microservice` targeting `develop`: label `Delivery`; link text `!412` with `href` = `webUrl`,
    `target="_blank"`, `rel` containing `noreferrer`; text `microservice → develop`; `polled …`; track labels `Pushed`, `MR open`, `Pipeline`, `Merged`,
    with `pipeline passed` at Pipeline and the created-at age at Pushed and MR open; no `Review` and no `CodeRabbit` text anywhere.
  - merged MR → Merged step carries the merged-at age; Pipeline has no word.
  - also MRs `!415`, `!420` → an `Also:` line with both links, each with its state word and `<repo> · <age>`.
  - inherited → `via TIMIFY-100` after the link.
  - known none, TIMIFY mapping both repos → `no merge request for TIMIFY-144 in microservice, dev-api-graphql-proxy in the last 30 days` (basenames joined
    with `, ` in `jiraProjects` order — by project path); with one repo → `… in microservice in the last 30 days`; `unknown/not-read` → `GitLab not read yet`; `unknown/failed` →
    `GitLab could not be read — Settings › Shared › Sources`; `unknown/capped` → `more merge requests than were read — some may be missing`.
  - `hidden` or `deliveryShown` false → renders nothing.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-delivery-pane.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Agent column keeps its current width (spec §7.1); tones via `shared/theme.css` tokens; layout from the mock, sizes from
  DESIGN.md §8.9.2.
- [ ] **Step 4: Run** it plus `grep -l 'JiraDetail' test/` hits — PASS.
- [ ] **Step 5: Commit** `feat(gitlab): Delivery pane in Jira Detail`.

### Task 11: Board MR chip, band line and List column — mocks `Cards.dc.html`, `List.dc.html`

**Files:**
- Create: `client/src/components/jira/MrChip.tsx`
- Modify: `client/src/components/jira/JiraCard.tsx` (markers row `:162-179`: chip(s) after the worktree chip `:175-178`, before `JiraRunMenu` `:179`),
  `client/src/components/jira/JiraAgentDeck.tsx` (`DeckCard`: own line between the crumb `:84` and the `Meter` `:85`),
  `client/src/components/jira/JiraBoardView.tsx` (band `sub` `:182-185`: a second line from `bandTotals` over the shown tops),
  `client/src/components/jira/JiraIssueList.tsx` (`<th>Delivery</th>` after Status `:62`; `<td>` after Status `:153-158`),
  `client/src/styles.css` (`:1693-1715`: new 6th column width, shift `nth-child(6..10)` → `(7..11)`, raise `min-width` and the `@container` threshold by the
  new width; chip rules beside `.jira-card-tree` `:715`)
- Test: `test/jira-delivery-surfaces.test.tsx` (new — no suite renders `JiraIssueList`, `JiraAgentDeck` or `JiraCard` alone today; render each directly
  under a `GitlabContext` value), `test/jira-board.test.tsx` (band line)

**Interfaces:**
- Consumes: Task 8 (`ticketDelivery`, `deliveryLook`, `bandTotals`, `deliveryShown`), Task 10 (`DeliveryTrack` compact), `useGitlabContext()`.
- Produces: `MrChip({ delivery }: { delivery: TicketDelivery })` — draws nothing unless `kind: 'mrs'`; the lead's chip text and tone, `title` =
  `via <PARENT-KEY>` when inherited; a second amber `not merged` chip when `notMerged`.

- [ ] **Step 1: Write the failing tests:**
  - shelf card for a top with own `!415` opened/failed → chip text `!415 · ✕ pipeline failed` inside `[data-testid="marker-row"]`, positioned before the
    Run menu's button (DOM order); a `done` top with own opened `!401` → `!401 · ✓ pipeline` and `not merged`; inherited → chip `title` `via TIMIFY-100`,
    no `not merged`; a top with `kind: 'none'` → no chip and no `no MR` text; a folded top whose child has an MR and the top none → no chip on the card.
  - deck card whose session issue is a folded child `TIMIFY-131` with `!415` → chip shows `!415` (the child's, not the top's).
  - board band shows `GitLab: …` from `bandTotals` when `deliveryShown`; GitLab unconfigured → no `GitLab:` text anywhere on the board.
  - List: header cells in order `Session, Key, Summary, Type, Status, Delivery, Priority, Assignee, Sprint, Updated, Run`; a row with own opened/success
    `!412` and also `!420` → link `!412`, word `pipeline passed`, `+1 MR`; `done` + own opened → `not merged` after the word; known none → `no MR`; unknown →
    `—`; a `PAY` row (hidden) → empty cell; an `unconfigured` payload → no `Delivery` header; a `rejected`, armed payload whose projects were never read →
    every Jira row and column still rendered, each TIMIFY Delivery cell `—` (Review Focus 4).
- [ ] **Step 2: Run** `pnpm exec jest test/jira-delivery-surfaces.test.tsx test/jira-board.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Chip ellipsises before `Run ▾` loses width (the worktree chip's rule, `styles.css:715`); List cell reuses `DeliveryTrack`
  compact; update DESIGN.md §8.9.1's table widths in Task 13, not here.
- [ ] **Step 4: Run** the same — PASS; then `grep -l 'JiraCard\|JiraIssueList\|JiraAgentDeck\|JiraBoardView' test/` and run those.
- [ ] **Step 5: Commit** `feat(gitlab): MR chip on cards, GitLab band line and List Delivery column`.

### Task 12: Delivery quick filter — mock `List.dc.html` (segmented control)

**Files:**
- Modify: `client/src/lib/jira.ts` (`JiraPanelFilters` `:688`, `NO_JIRA_PANEL_FILTERS` `:690`, `clampJiraPanelFilters` `:704`, `boardFilterCount` `:762`),
  `client/src/components/jira/JiraBoardView.tsx` (Filters panel: a `Delivery` section after Sprint, inside `<FilterBar>` `:199-243`; the `foldMatches`
  keep callback `:150` ANDs `matchesDelivery`; List mode draws `Segmented` above the table), `test/jira-lib.test.ts`, `test/jira-board.test.tsx`
- Test: same two files

**Interfaces:**
- Consumes: `DeliveryFilter`, `DELIVERY_FILTER_LABELS`, `matchesDelivery`, `ticketDelivery`, `deliveryShown` (Task 8); `Segmented`
  (`client/src/components/ui/Segmented.tsx:19`); `foldMatches(fold, keep)` (`client/src/lib/jira.ts:373`).
- Produces: `JiraPanelFilters.delivery: DeliveryFilter` (default `'all'`); `effectiveDeliveryFilter(stored: DeliveryFilter, shown: boolean): DeliveryFilter`
  (`'all'` when not shown).

- [ ] **Step 1: Write the failing tests:**
  - `clampJiraPanelFilters({ …valid, delivery: 'failing' }).delivery === 'failing'`; `delivery: 'bogus'` or missing → `'all'`; existing clamp/equality
    expectations updated for the new key.
  - `boardFilterCount` counts `delivery !== 'all'` as one, and the count the panel shows uses the effective value (stored `failing`, not shown → not
    counted).
  - board: picking `Pipeline failing` in the panel's Delivery section shows only the top whose lead fails, and the List's segmented control shows
    `Pipeline failing` selected (one value, two controls); picking `All` in the segmented control restores every row; the value survives a remount via
    `JIRA_FILTERS_KEY`.
  - folded: a top with no MR whose folded child's own MR fails is shown under `Pipeline failing` (F1).
  - Review Focus 5: stored `{ delivery: 'failing' }`, payload `unconfigured` → every ticket rendered, no Delivery section, no segmented control, badge
    count unaffected.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-lib.test.ts test/jira-board.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, plus `grep -l 'JIRA_FILTERS_KEY\|clampJiraPanelFilters\|NO_JIRA_PANEL_FILTERS' test/` hits.
- [ ] **Step 5: Commit** `feat(gitlab): Delivery quick filter on the Jira board and List`.

### Task 13: Docs, invariants and rule files

**Files:**
- Create: `.claude/rules/gitlab.md` (`paths: ["server/src/gitlab/**"]`), `docs/subsystems/gitlab.md`
- Modify: `docs/subsystems/invariants.md` (`:3506`, `:3509`, `:3569` heading, `:4067`; new section after `:3722`'s Jira-token section), `CLAUDE.md` (rule
  table, `:108` headline, outbound-modules bullet `:159`, new GitLab headline beside the GitHub token's), `.claude/rules/tracker.md:84,121`,
  `.claude/rules/security.md:2` (add `"server/src/gitlab/**"` to `paths:`), `docs/overview.md:88,93,171` and its API bullets `:66-93` and seams `:152-171`,
  `docs/subsystems/api.md:131,207,494`, `docs/subsystems/jira.md:26`, `.claude/DESIGN.md` (§8.6 Sources `:479-519`, §8.9.1 `:580-596` table widths and
  chip, §8.9.2 `:616` Delivery pane; a new `#### 8.9.6 Delivery` subsection), `.env.example` (already done in Task 1 — check only),
  `.claude/rules/jira.md:24` (a repos save now also re-arms the GitLab poller through `onReposChanged` — the "re-aims no poller work" wording becomes false),
  `.claude/rules/board.md:153-155` (the `useRefreshing` poller list gains `useGitlab`), `CLAUDE.md:44-45` (Layout's module list gains `gitlab/`; counts
  against the byte budget below)
- Test: `test/claude-rules.test.ts`, `test/design-guards.test.ts`, `test/dialog-count-docs.test.ts`

**Behaviour:**
- Four-caches rename, in the three places at once: headline **"The tracker, Jira, pull-request and GitLab caches are the four caches in this server whose
  age is a rendered value."** — CLAUDE.md `:108`, `.claude/rules/tracker.md:84` (byte-equal), `invariants.md:3569` heading; then every link to the old
  anchor (`grep -rn 'three-caches-in-this-server' -- ':!docs/superpowers'`; known: `CLAUDE.md:109`, `.claude/rules/tracker.md:121`) points to
  `#the-tracker-jira-pull-request-and-gitlab-caches-are-the-four-caches-in-this-server-whose-age-is-a-rendered-value`. The section body gains a GitLab
  paragraph (per GitLab project, `polledAt`, lost on restart, failure keeps the last answer).
- New `invariants.md` section **"The GitLab token never leaves the server, never follows a redirect, and the poller is armed only while a mapped repo is on
  the site"**, written like the Jira-token section at `:3722` (the why: §4's anti-goals, the 301 from `gitlab.timify.io`, the PAT-in-remote case,
  identity independent of arming). Every `gitlab.md` bullet cites that anchor or is unanchored and ≤ 80 words. CLAUDE.md gets its headline + `Why:` link
  beside the GitHub-token bullet.
- Outbound modules: "`agents/`, `tracker/`, `jira/` and `gitlab/` are the server's only outbound-calling modules" in CLAUDE.md `:159` and
  `invariants.md:4067`; "three" → "four" in `docs/overview.md:171` and the other listed lines.
- CLAUDE.md rule-file table gains `gitlab.md | server/src/gitlab/**` and `security.md`'s glob list gains `server/src/gitlab/**` — equal to the files'
  `paths:` (`test/claude-rules.test.ts:420`).
- **CLAUDE.md byte budget** (`test/claude-rules.test.ts:99,430`, 19 456 B; 19 107 B today). Measure with `wc -c CLAUDE.md` after the edits. If over, free the
  bytes by moving a rule **down a tier** as the test's own message says — never by compressing wording and never by raising the cap. Candidate, in order:
  the CSP bullet (its mechanism is code under `.claude/rules/security.md` and `board.md` `paths:` — move the full text to the rule file that fences
  `server/src/security.ts`, and keep a one-line pointer only if another rule's test requires it). Say which bullet moved, and why, in the commit body.
- `docs/subsystems/gitlab.md`: the seam (env, mapping, client, poller, payload, routes), the request bound per sweep, and the room left for project 2 (spec
  §9). `docs/overview.md` lists `gitlab/` in The API bullets and the seams.
- DESIGN.md: §8.6 gains the GitLab row's states; §8.9.1 the chip, band line and Delivery column (with the new widths); §8.9.2 the Delivery pane; written the
  way §8.9 and §8.11 are, lowercase.

- [ ] **Step 1: Run** `pnpm exec jest test/claude-rules.test.ts` before editing — PASS (baseline).
- [ ] **Step 2: Edit** all files above.
- [ ] **Step 3: Run** `pnpm exec jest test/claude-rules.test.ts test/design-guards.test.ts test/dialog-count-docs.test.ts` — PASS; `wc -c CLAUDE.md` ≤ 19456;
  `grep -rn 'three caches\|three-caches' CLAUDE.md .claude docs/subsystems docs/overview.md` → no hits; `grep -rn 'only outbound-calling' CLAUDE.md docs`
  → every hit names `gitlab/`.
- [ ] **Step 4: Commit** `docs(gitlab): invariants, rule files, DESIGN.md and subsystem page for GitLab`.

### Task 14: `/ui-verify` against the four mocks

**Files:**
- Modify: only what the check finds.
- Mocks: `docs/superpowers/specs/2026-11-12-gitlab-connection-mockups/OptionC.dc.html`, `Cards.dc.html` (chip + band line only), `List.dc.html`,
  `Settings.dc.html`.

- [ ] **Step 1: Run the skill** `/ui-verify` with fixture data: live data may hold no MRs, so serve the board with a `FakeGitlab`-backed payload or a dev
  fixture that covers every row of §7's table, an inherited MR, a `Done, not merged` ticket, an unknown and a known-none ticket, and each Sources state.
  Start any server by recorded pid and kill only that pid.
- [ ] **Step 2: Assert** at 1440 px: no sideways page scroll on the Jira board (Board and List) and in Detail (`document.documentElement.scrollWidth <=
  innerWidth`); the List's own scroll box takes the Delivery column; the deck card's chip line and the shelf card's chip ellipsise before `Run ▾`; no
  `Review`/`CodeRabbit` step drawn; no uppercase.
- [ ] **Step 3: Fix** each defect on the branch with a test where jsdom can see it; re-run the affected suites.
- [ ] **Step 4: Commit** `fix(gitlab): match the picked mocks` (only if anything changed) and attach the ui-verify report path to the final review.
