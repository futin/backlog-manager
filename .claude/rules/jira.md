---
paths: ["server/src/jira/**", "server/src/agents/jira-*.ts", "skills/jira/**", "docker-compose.yml", "shared/jira-branch.ts", "server/src/agents/session-stop.util.ts"]
---

# Rules scoped to these paths, mechanism included — CLAUDE.md repeats only the cross-cutting ones' headlines; the reasoning is in docs/subsystems/invariants.md

- **`~/.backlog-manager/settings/jira.json` has exactly one writer, the server, and a file that cannot be read is never replaced.** `readJiraConfig`
  (`server/src/jira/config.util.ts`; `BM_JIRA_FILE` overrides the path) is read fresh on every use and cached nowhere. A MISSING file and a parsed non-object
  both read as empty; a file that exists and cannot be read or parsed returns `unreadable` (`cannot be read` / `does not parse as JSON`), which `GET /api/jira`
  carries as `configUnreadable` — and the sweep prunes no board cache while it says so. The fallback is per ENTRY, one level finer than spec §2 by design:
  `readBoard`, `readQuery`, `readRepos`, `readRepoDefaults` and `readSkill` each drop only the entry that fails (a board whose id is not a `b_` id or whose name
  is empty, a root
  that fails `isJiraKey`, a query, a repos key or path, a skill), with one `console.warn` naming the file and the entry; a missing or unknown `interval` reads
  `DEFAULT_JIRA_INTERVAL`. The six writers are `writeBoard`, `deleteBoard`, `writeRepos`, `writeRepoDefaults`, `writeSkill` and `deleteSkill` (same file),
  called by `POST /api/jira/boards`, `/boards/delete`, `/repos`, `/repo-defaults`, `/skills` and `/skills/delete` (`jira-write.controller.ts`) and by nothing
  else. Each is `writeSyncInterval`'s contract: read the RAW file (ENOENT starts from `{}`; a parsed non-object is replaced), merge ONE entry — a board by id,
  one project's list by key, one path's defaults by path, a skill by id (`s_` ids, a name of
  at most 60 characters, a prompt of at most 2 000) — keeping every other entry, malformed ones and unknown top-level keys included, then
  write through `writeJsonAtomic`. A file that exists and cannot be read or parsed throws `JiraConfigUnreadableError`, which the
  route answers as a 409 carrying its message (`… nothing was written`) with the file byte-identical; an update or delete naming an id the file does not hold
  throws `JiraUnknownIdError`, which carries the entry kind and is a 404 `unknown board` or `unknown skill`. A handler runs guard (`SameOriginPostGuard`) → validate (400) → configured (503) → write → re-aim, and
  config writes stay open under `access: unauthorized`, because they touch only `jira.json`. A saved board then awaits `boardSaved` (sweeps that board,
  bounded by `JIRA_SAVE_SWEEP_WAIT_MS`, never rejects, so the route adds no second timer) — and so does `POST /api/jira/boards/sweep` `{ id }`, the chip's
  per-board `now`, which writes nothing: guard → 400 → 503 → 409 for an unreadable file → 404 `unknown board` → `boardSaved`, never a second sweep path; a deleted one calls `boardDeleted` and `arm()`; repos and skills re-aim
  no Jira poller work, since no Jira sweep reads them (a repos save only calls `JiraLiveService.reposChanged`, whose `onReposChanged` listeners arm the
  session reconciler and the GitLab poller, which re-derives its mapping from the saved repos; neither is awaited by the save). `repoDefaults` (absolute normalised path → `{ base?, namePattern? }`) falls back per VALUE: a base failing
  `defaultBaseProblem` (Table A, then `is a branch name, without origin/`) or a pattern failing `patternProblem` costs only itself;
  `/repo-defaults` takes `null` for unset (both `null` deletes the entry) and adds
  one check after the 409, a 400 `<path> is not mapped` unless SOME project maps the path. Why:
  [invariants.md](docs/subsystems/invariants.md#jirajson-has-exactly-one-writer-and-a-file-that-cannot-be-read-is-never-replaced)
- **The Jira token never leaves the server: the browser and `jira.mjs` both go through the server's own routes (`/api/jira`, and
  `/api/agents/jira-link|jira-unlink` for `link` and `unlink`), and the poller is armed only while a board syncs.**
  `jiraEnv()` (`env.util.ts`) reads `BM_JIRA_SITE`, `BM_JIRA_EMAIL`, `BM_JIRA_TOKEN` (spelled once, in `JIRA_ENV`) per call, trimmed, never cached; whitespace
  is absent, the site is lower-cased and must pass `isJiraHostname`, and `detail` names the first problem — emptiness first, in site/email/token order, then the
  hostname shape. Every call is `JiraClient.request`'s: the gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3` (`GATEWAY_HOST`, not configurable),
  except the unauthenticated `tenant_info` (no `authorization` header at all) and the one `myselfAtSite` probe, sent once and only after the gateway `myself`
  answered 200 (spec §3).
  `authorization: Basic …` is built there and nowhere else, and every `message` is Jira's sentence or the transport error's, never the request.
  `JiraStatusPayload` carries `site`, `me.name`, `me.accountId` and `tokenKind` — never the email or the token. Compose passes all three as
  `'${BM_JIRA_<NAME>:-}'`, pinned through `JIRA_ENV` by `test/guards/compose-env.test.ts`. `JiraPollerService` is a `setTimeout` chain on `JIRA_POLL_MS`, `unref`'d,
  armed at bootstrap while the site is configured AND some board's interval is not `off`, OR some board is still owed its one cold sweep, OR the boot
  (`cloudId`, `serverInfo`, `me`, the sprint field) is unanswered — except `unsupported`, which is final and disarms. The rule is judged at the end of every
  sweep against `jira.json` read again there. `skills/jira/tools/jira.mjs` dials `http://127.0.0.1:${BM_API_PORT || 4322}` and nothing else — `jira.mjs
  link|unlink <KEY>` POST `{ key, sessionId }` to `/api/agents/jira-link|jira-unlink`, the session id read from `CLAUDE_CODE_SESSION_ID` (unset is exit `1`,
  nothing sent) — reads no `BM_JIRA_*` and sends no `authorization` header; the source guard in `jira.test.mjs` (comment lines stripped) holds all three. Its
  one allowed `BM_JIRA_` name is `BM_JIRA_FETCH_RETRY_MS`, `worktree`'s pause before its one fetch retry (default 1 000 ms) — a test knob, carrying nothing of
  Jira's — and its second is `BM_JIRA_FETCH_TIMEOUT_MS`, the bound on each `worktree` fetch (default 60 s), a test knob too. Why:
  [invariants.md](docs/subsystems/invariants.md#the-jira-token-never-leaves-the-server-and-the-poller-is-armed-only-while-a-board-syncs)
- **Jira's Done column is a window, not a store: a done issue whose resolution — or, lacking one, whose last update — is older than 14 days is dropped at map
  time.** `JIRA_DONE_WINDOW_DAYS` lives in `map-issue.ts` and nowhere else; `mapJiraIssue` applies it to the `done` category alone, from `resolutiondate`, else
  `updated`, and keeps an issue exactly 14 days old. It runs as each issue is mapped, so a dropped issue counts against no cap — per query, per root walk or the
  board's 500 — and the walk still names its key in the next `parent in` round (`Pages.raw`), so a closed story's open subtask stays on the board. The sweep
  passes `now: Date.now()`; every fresh read — the issue detail, its children, the roots search — passes `now: null`, which turns the window off. Why:
  [invariants.md](docs/subsystems/invariants.md#jiras-done-column-is-a-window-not-a-store)
- **Every value the server puts into JQL — a key or the search term — is quoted and escaped, and a person's JQL is passed verbatim for Jira to parse.**
  `jqlString` (`jira.client.ts`) is the one way this code interpolates: double quotes, with `\` and `"` backslash-escaped — `key = "PAY-1"`, `parent in ("A-1",
  "A-2")`, `summary ~ "x*"`. Keys pass `isJiraKey` before they get there (a root on read, `:key` with a 400, the search's key test), and the keys Jira itself
  returned for a walk's next round are quoted the same way, never trusted bare. The search route trims `q` (blank is `[]` with no call, over
  `JIRA_SEARCH_MAX_CHARS` a 400), upper-cases it for the key test, and otherwise searches `summary ~ ` the escaped text plus `*`. A board query's `jql` is sent
  as `jira.json` holds it, and the check route sends the person's text untouched — bounded only by `JIRA_JQL_MAX_CHARS` (`config.util.ts`). Why:
  [invariants.md](docs/subsystems/invariants.md#every-value-the-server-puts-into-jql-is-quoted-and-escaped-and-a-persons-jql-is-passed-verbatim)
- **The board's Jira writes are assign and transition, nothing else; each re-reads the issue and splices it into every board cache holding the key.** The two
  routes are `POST /api/jira/issue/assign` `{ key }` and `/issue/transition` `{ key, transitionId }` in `jira-write.controller.ts`, each `SameOriginPostGuard` →
  validate (400: `invalid issue key`, `transitionId must be a non-empty string` — a string of at most `JIRA_TRANSITION_ID_MAX_CHARS`, 64) → configured (503) →
  `JiraPollerService.assignToMe` / `transitionIssue`, whose outcomes go through `jiraWriteOrThrow` (`unwrap.util.ts`, hoisted there beside `unwrapJira` so the read
  controller, these two routes and `dispatch-jira` share one mapping: §8's table and `retryAt` mean the same thing on every route) — its two own refusals are
  `no identity` (503) and `transition not offered` (400), every other failure `unwrapJira`'s. `POST /api/agents/dispatch-jira` is a SECOND CALLER of those same
  two poller methods through the same mapping, not a third write: it asks for neither unassign nor anyone else, skips an assign the ticket already carries
  (`assigned: false`, because a write that changes nothing still bumps `updated`), and prefixes the step's name onto whatever the mapping throws. Both refuse
  with no Jira call: through `gate()` (unconfigured, a 429 window, `unsupported`, no `cloudId`), then `unauthorizedRefusal()` — the 401 body whenever the
  boot's `access` is `unauthorized`, `me` still set or not — and, for assign alone, `me === null` → `no identity`. Assign is `PUT issue/{key}/assignee`
  with `me.accountId` and nothing else — never `{ accountId: null }`, which Jira reads as UNASSIGN, and never an accountId from the request. Transition is a
  FRESH `GET issue/{key}/transitions`, the id checked against it, the 429 window checked again, then `POST issue/{key}/transitions` `{ transition: { id } }`.
  After the write lands, `splice` reads `GET issue/{key}` with the sweep's fields, maps it with `now: Date.now()` (the Done window on), and replaces the issue
  AT ITS INDEX in every `caches` entry already holding the key — it never adds the key to a board, leaves each `polledAt` alone, and leaves every cache
  untouched when the body does not map to an issue. `sweepBoard` ends in `keepNewer`: a swept issue whose key the cache NOW holds with a strictly newer
  `Date.parse(updated)` keeps the cached copy; equal or unparseable on either side keeps the sweep's, and a key the sweep did not return is dropped as
  before. The answer is `200 { ok: true, reread }` (`JiraIssueWriteResult`): `reread` is true when the re-read's 2xx body was an issue — even if the Done
  window then dropped it — and false when it was not or the call failed (its 401 or 429 still moves the site state through `routeFailed`); a failed re-read
  never turns the 200 into an error. There is no per-key queue on the server: the modal's `useAction` is the one-at-a-time guard. Why:
  [invariants.md](docs/subsystems/invariants.md#the-boards-jira-writes-are-assign-and-transition-nothing-else)
- **A Jira branch name obeys one rule, in `shared/jira-branch.ts`, and `jira.mjs` carries its one hand-kept copy.** `branchNameProblem` (Table A: `git
  check-ref-format --branch`'s rules, at most `BRANCH_NAME_MAX` = 200 characters, and only `[A-Za-z0-9._/-]` — narrower than git, because the name is pasted
  bare into the `jira.mjs worktree` line of the prompt) and `branchCarriesKey` (Table B: the key case-insensitive, bounded on both sides by a non-alphanumeric
  or the end, every occurrence tried) live in `shared/jira-branch.ts`, beside `slugOf`, `renderBranchPattern`, `patternProblem`, `worktreePathFor` and
  `shellQuote`; the server's `parseBranchChoice` (`branch-choice.util.ts`), `readRepoDefaults`, `/repo-defaults` and the launch sheet all import them.
  `skills/jira/tools/jira.mjs` cannot import `shared/`, so it carries Tables A and B by hand, and `jira.test.mjs` pins the same rows as
  `test/jira/jira-branch.test.ts`: a change to one is a change to both, in one commit. The repo path is the one value that can hold anything, so it alone is
  `shellQuote`d. Why: [invariants.md](docs/subsystems/invariants.md#a-jira-branch-name-obeys-one-rule-and-jiramjs-carries-its-one-hand-kept-copy)
- **A Jira session is a persisted link, and Stop, a quiet dashboard or the 8-hour backstop each end it.** `JiraLiveService` (`server/src/jira/live.service.ts`,
  NOT `JiraService`) holds the link store in memory and writes it whole after every change but a `starting` reservation: `server/src/jira/links.store.ts`,
  `~/.backlog-manager/settings/jira-links.json` (`BM_JIRA_LINKS_FILE` overrides it), version 1, the server its one writer, through
  `writeJsonAtomic`. It holds `links` (`JiraLink`: key, session id, `how` — `run`, `branch` or `manual` — action, repo, branch, surface, model, effort, a ticket
  snapshot, `startedAt`, `endedAt` with an `endReason` of `idle`, `stopped`, `expired` or `gone`, `quietSince` and `reattachedAt`), plus the `suppressed` and
  `neverLink` pairs (each capped at 1,000, oldest out); `(key, sessionId)` is a link's identity, and a key may hold several. A file that does not parse, or
  whose `version` is not 1, loads EMPTY with one warning and is renamed `jira-links.json.bad-<ISO>` at the first save — never overwritten, and left alone by a
  boot that saves nothing — where `jira.json`'s writers refuse with a 409, because this is machine-written history; one unusable entry costs only itself. A save
  that throws is logged (once per distinct message) and costs nothing else: a launch never fails for it — but `saveError()` holds it, `{ message, at }`,
  until a save lands, and `GET /api/jira/sessions` carries it so the List warns that links are memory only. `JiraModule` provides the service; it is read by `GET /api/jira` (`live`, filled by
  the controller from `snapshot()`, the live `run` links only — the poller never sees it, and an unconfigured server keeps `{}`), `GET /api/jira/issue/:key`
  (`session`) and `GET /api/jira/sessions`.
  `GET /api/jira/sessions` is every link, live and ended, as `JiraSessionsPayload` (`{ links, reachable, rowsAt }`): each carries `state` (`sessionState`,
  `shared/jira-sessions.ts`, derived and never stored), the dashboard's `row` for a live one the dashboard lists (`null` for an ended or an unlisted one) and
  `stateSince`. It is memory only — it dials neither Jira nor the
  dashboard, so an unconfigured server answers it too, with no 503 — and `?open=1` (the Jira section's own read, never the rail badge's) tells the reconciler a
  page is open; a read that OPENS the page (`pageOpen` was false) fires `JiraLiveService.onPageOpened`, and the reconciler drops a pending 60 s timer for a 15 s one.
  The one-run gate is `run`-only. The dispatch RESERVES the key (`starting`, memory only, never written, dropped by a restart) before its first Jira write, and
  `reserve` is a synchronous check-and-set refusing while a live `run` link or a reservation holds the key — so of two Starts exactly one passes, the other 409s
  `<KEY> is starting` / `already has a session`; a live `branch` or `manual` link is the user's own and blocks nothing. Every failure after the reservation runs
  through one `catch` that `release`s it; `release` touches only a `starting` entry, so it can never drop a session that did start, and a refused `reserve`
  releases nothing (it would drop the other request's entry). `confirm` follows the spawn and turns the reservation into a `run` link (over a live `branch` or
  `manual` link for the same pair it upgrades that entry to `run`); a key released meanwhile
  is not resurrected, and a pair that has ended keeps its end — only the reconciler's re-attach revives one. Live links are capped at `JIRA_LIVE_CAP` (100,
  `starting` included): one more ENDS the oldest live link by `startedAt` as `expired` — it stays as history — and never a `starting` one, and when every slot
  is starting `reserve` refuses, which the dispatch answers as 409 `too many Jira sessions are starting`. A live link whose later of `startedAt` and
  `reattachedAt` is strictly older than `JIRA_LIVE_TTL_MS` (8 h) ends `expired` lazily at the top of every call — no timer, time is `Date.now()` — and a stale
  `starting` one is dropped. Retention runs on every save: per key every live link and the 20 newest ended ones, and a key whose newest end is over 90 days old
  with nothing live goes.
  Stop is `POST /api/agents/jira-stop` `{ key, sessionId }` (`JiraDispatchService.stop`), naming ONE session because a key can hold several: 400 `invalid issue
  key` or `invalid session id` (`isSessionId`, a shape check only), agents off 409, then 409 when the id is not a live link of the key — `<KEY> is still
  starting` for a reservation, `no live session for <KEY>` when nothing is live on it, else `<KEY> has no live session <first 8 of the id>` — then
  `stopDashboardSession` (`session-stop.util.ts`, shared with the item abort): a 200 or the dashboard's `no live session` 404 ENDS the link as `stopped` (a
  no-op if it ended meanwhile, so the first end stands), any other answer is a 502 and the link STAYS live, since the session may still run; Jira is never
  called.
  The reconciler (`server/src/agents/jira-live.service.ts`, `JiraLiveReconciler`) is the other hand, and it ends a link only once the dashboard has stopped
  reporting it busy for two minutes. One `GET /api/sessions?limit=50&lookback=168` per tick (`dashboardSessionRows`), its rows kept whole in the service
  (`setRows`, memory only; an unreadable list calls `markUnreachable`, agents off returns before any fetch; neither ends a link); the period is
  `JIRA_RECONCILE_FAST_MS` (15 s) while a
  Jira page was read in the last 30 s and `JIRA_RECONCILE_MS` (60 s) otherwise, a `setTimeout` chain armed by `confirm` and at boot, only while some link is
  live or Setup maps a repo, `unref`'d, never in a request's path, never throwing. For a live link with a session id and older than `JIRA_LIVE_GRACE_MS` (2
  min): a `working` or `question` row clears `quietSince`; anything else — any other status, or no row in a list shorter than 50 — marks `quietSince` on the
  first such tick and ends the link (`idle`, or `gone` for no row) once that mark is `JIRA_QUIET_MS` (2 min) old, so a session is Quiet for two minutes after
  every finished turn, not only its first; a full 50-row list proves nothing about an absent session, which stays live for the backstop. A `starting` entry is
  never judged, and a verdict applies only to its own `(key, sessionId)`. Then C5: an ENDED link whose row is `working` or `question` again is re-attached — its
  own entry re-opened, the 8-hour clock restarted — so history does not grow. The edge runs agents → jira and never back: `jira/` imports nothing from `agents/`
  except `SameOriginPostGuard`, which is why the dispatch, the stop and the reconciler live in `agents/` while the store does not. Why:
  [invariants.md](docs/subsystems/invariants.md#a-jira-session-is-a-persisted-link-and-stop-a-quiet-dashboard-or-the-8-hour-backstop-each-end-it)
- **`review` is a third built-in action, and it is built from the GitLab cache, never from the request's spelling.** `parseJiraAction` / `parseJiraActionParam`
  (`shared/types.ts`) accept `'review'`; `resolveJiraActionOrThrow` refuses a bare one (400 `review needs mr and half`), because a review is composed only with
  its MR and half: `{ kind: 'review', half, mr }` (`prompt.util.ts`, `reviewText`). The controller shapes `mr` (`parseReviewMr`: a project path through
  `isGitlabProjectPath` and a positive iid of at most nine digits — a JSON number on dispatch, a digit string on `GET /api/jira/prompt`'s `mrProject`/`mrIid`)
  and `half` (`parseReviewHalf`, exactly `request` or `fix`), 400 `mr must be { project, iid }` / `half must be request or fix`, before the branch choice.
  **`jira/` imports `gitlab/remote.util.ts` for `isGitlabProjectPath` and for nothing else** — a pure helper, no Nest, no poller, so the one `jira/` → `gitlab/`
  edge cannot drag `GitlabModule` in (`GitlabModule` imports `JiraModule`; the reverse would be a cycle). The prompt carries no finding text: it names the MR as
  `!<iid>` in its project, tells the session to use the `mr-review-loop` skill (`request` posts the `@coderabbitai review` trigger and changes nothing in the
  repository, `fix` fetches the open findings, fixes them and posts no trigger) and to stop if the skill is absent, so nothing a bot or a stranger wrote on the
  MR is in the prompt. The half is DERIVED, never accepted: dispatch (`reviewOrThrow`, step 3a) reads `findMr` and `reposFor` and answers 400 `!<iid> is not an
  open merge request of <KEY>` (not cached, not `opened`, or its `keys` carry neither the key nor — checked once the detail is read — its parent's), 400 `<repo>
  is not a review candidate for !<iid>`, 400 `a review continues <branch>` (anything but `continue` on the MR's source branch without `openMr`), then 409 `no
  review state for !<iid> yet` / `nothing to review on !<iid>` (`reviewing`, `clean`) / `!<iid> has too many threads to read` (`unknown`) / `the review on
  !<iid> moved on — reopen the sheet` when `reviewHalf(reviewState(...))` is not the sent half. The ticket gate's 409s keep their text; the branch has its own
  gate (spec 5.2). It is synchronous with the key reservation — no `await` between `live.reserve`, the gate's reads and the insert — so of two reviews racing
  for one branch exactly one holds it: a memory-only `branchHolds` map keyed `<candidate repo>\0<branch>`, never written, released by token on a failed spawn,
  on a desktop launch that answered no id, and at `confirm` (the stored link's `branch` then carries the gate). The gate (`branchBusy`) reads another review's
  hold, any live link of any `how` storing that branch in a candidate (a linked worktree folded to its main checkout by `mainCheckoutOf`), and
  `JiraLiveService.activeRows()` — `working` / `question` dashboard rows on that branch. Those rows come from the reconciler's list, 15–60 s old by design; the
  spec accepts that window, and a refusal is 409 `a session is live on <branch>`. `JIRA_BUILTIN_LABELS.review` (`Review the MR`) is a label for links and the
  List, never a menu row. Why: [invariants.md](docs/subsystems/invariants.md#a-review-dispatch-decides-from-the-cache-and-gates-the-branch)
- **`jira.mjs` writes no file of its own**; its one exception, `worktree`, is git only — it fetches and makes the ticket's worktree in a mapped repo.
