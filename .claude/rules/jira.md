---
paths: ["server/src/jira/**", "server/src/agents/jira-*.ts", "skills/jira/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

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
  write a temp file in the same directory and `rename` it over. A file that exists and cannot be read or parsed throws `JiraConfigUnreadableError`, which the
  route answers as a 409 carrying its message (`… nothing was written`) with the file byte-identical; an update or delete naming an id the file does not hold
  throws `JiraUnknownIdError`, which carries the entry kind and is a 404 `unknown board` or `unknown skill`. A handler runs guard (`SameOriginPostGuard`) → validate (400) → configured (503) → write → re-aim, and
  config writes stay open under `access: unauthorized`, because they touch only `jira.json`. A saved board then awaits `boardSaved` (sweeps that board,
  bounded by `JIRA_SAVE_SWEEP_WAIT_MS`, never rejects, so the route adds no second timer); a deleted one calls `boardDeleted` and `arm()`; repos and skills re-aim
  nothing, since no sweep reads them. `repoDefaults` (absolute normalised path → `{ base?, namePattern? }`) falls back per VALUE: a base failing
  `branchNameProblem` or a pattern failing `patternProblem` costs only itself; `/repo-defaults` takes `null` for unset (both `null` deletes the entry) and adds
  one check after the 409, a 400 `<path> is not mapped` unless SOME project maps the path. Why:
  [invariants.md](docs/subsystems/invariants.md#jirajson-has-exactly-one-writer-and-a-file-that-cannot-be-read-is-never-replaced)
- **The Jira token never leaves the server: the browser and `jira.mjs` both go through `/api/jira`, and the poller is armed only while a board syncs.**
  `jiraEnv()` (`env.util.ts`) reads `BM_JIRA_SITE`, `BM_JIRA_EMAIL`, `BM_JIRA_TOKEN` (spelled once, in `JIRA_ENV`) per call, trimmed, never cached; whitespace
  is absent, the site is lower-cased and must pass `isJiraHostname`, and `detail` names the first problem — emptiness first, in site/email/token order, then the
  hostname shape. Every call is `JiraClient.request`'s: the gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3` (`GATEWAY_HOST`, not configurable),
  except the unauthenticated `tenant_info` (no `authorization` header at all) and the one `myselfAtSite` probe, sent once and only after the gateway `myself`
  answered 200 (spec §3).
  `authorization: Basic …` is built there and nowhere else, and every `message` is Jira's sentence or the transport error's, never the request.
  `JiraStatusPayload` carries `site`, `me.name`, `me.accountId` and `tokenKind` — never the email or the token. Compose passes all three as
  `'${BM_JIRA_<NAME>:-}'`, pinned through `JIRA_ENV` by `test/compose-env.test.ts`. `JiraPollerService` is a `setTimeout` chain on `JIRA_POLL_MS`, `unref`'d,
  armed at bootstrap while the site is configured AND some board's interval is not `off`, OR some board is still owed its one cold sweep, OR the boot
  (`cloudId`, `serverInfo`, `me`, the sprint field) is unanswered — except `unsupported`, which is final and disarms. The rule is judged at the end of every
  sweep against `jira.json` read again there. `skills/jira/tools/jira.mjs` dials `http://127.0.0.1:${BM_API_PORT || 4322}` and nothing else, reads no
  `BM_JIRA_*` and sends no `authorization` header; the source guard in `jira.test.mjs` (comment lines stripped) holds all three. Its one allowed `BM_JIRA_` name
  is `BM_JIRA_FETCH_RETRY_MS`, `worktree`'s pause before its one fetch retry (default 1 000 ms) — a test knob, carrying nothing of Jira's. Why:
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
  `test/jira-branch.test.ts`: a change to one is a change to both, in one commit. The repo path is the one value that can hold anything, so it alone is
  `shellQuote`d. Why: [invariants.md](docs/subsystems/invariants.md#a-jira-branch-name-obeys-one-rule-and-jiramjs-carries-its-one-hand-kept-copy)
- **A Jira session is remembered in server memory only; a restart forgets it, and Stop is the one hand that clears it early.** `JiraLiveService`
  (`server/src/jira/live.service.ts`, NOT `JiraService`) is a `Map<key, { sessionId, repo, startedAt }>` with no file and no I/O, provided by `JiraModule` and
  read by `GET /api/jira` (`live`, filled by the controller from `snapshot()` — the poller never sees it, and an unconfigured server keeps `{}`) and
  `GET /api/jira/issue/:key` (`session`). Capped at `JIRA_LIVE_CAP` (100): one more evicts the oldest CONFIRMED entry by `startedAt`, never a `starting` one
  (its spawn will `confirm` or `release` it), and when every slot is starting `reserve` refuses, which the dispatch answers as 409 `too many Jira sessions are
  starting`. An entry older than `JIRA_LIVE_TTL_MS` (8 h, strictly) is dropped lazily at the top of every call — no timer — and time is `Date.now()`. The
  dispatch RESERVES the key (`sessionId: null`, `starting`) before its first Jira write — `reserve` is a synchronous check-and-set, so of two Starts exactly
  one passes, the other 409s `<KEY> is starting` / `already has a session` — and every failure after the reservation runs through one `catch` that
  `release`s it; `release` touches only a `starting` entry, so it can never drop a session that did start, and a refused `reserve` releases nothing (it
  would drop the other request's entry). `confirm` follows the spawn; a key cleared meanwhile is not resurrected. Stop is `POST /api/agents/jira-stop`
  (`JiraDispatchService.stop`): agents off 409, no entry 409, `starting` 409, then `stopDashboardSession` (`session-stop.util.ts`, shared with the item
  abort) — a 200 or the dashboard's `no live session` 404 clears the entry, any other answer is a 502 and the entry STAYS, since the session may still run;
  Jira is never called. The reconciler (`server/src/agents/jira-live.service.ts`, `JiraLiveReconciler`) is the other early clear, and it clears only what
  the dashboard has stopped reporting as busy: one `GET /api/sessions` per tick (`JIRA_RECONCILE_MS`, 60 s, a `setTimeout` chain armed by `confirm` and only
  while some entry holds a session id, `unref`'d, never in a request's path, never throwing), an entry stays only while its session is `working` or
  `question` (the list keeps an exited session as `idle`), a `starting` entry and one younger than `JIRA_LIVE_GRACE_MS` (2 min) are never judged, an unreadable
  list or agents off leaves the map as it was, and a verdict clears only if the entry still holds the session id it was judged for. The edge runs agents →
  jira and never back: `jira/` imports nothing from `agents/` except `SameOriginPostGuard`, which is why the dispatch, the stop and the reconciler live in
  `agents/` while the map does not. Why:
  [invariants.md](docs/subsystems/invariants.md#a-jira-session-is-remembered-in-server-memory-only-and-stop-is-the-one-hand-that-clears-it-early)
