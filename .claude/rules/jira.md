---
paths: ["server/src/jira/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **`~/.backlog-manager/settings/jira.json` has exactly one writer, the server, and a file that cannot be read is never replaced.** `readJiraConfig`
  (`server/src/jira/config.util.ts`; `BM_JIRA_FILE` overrides the path) is read fresh on every use and cached nowhere. A MISSING file and a parsed non-object
  both read as empty; a file that exists and cannot be read or parsed returns `unreadable` (`cannot be read` / `does not parse as JSON`), which `GET /api/jira`
  carries as `configUnreadable` — and the sweep prunes no board cache while it says so. The fallback is per ENTRY, one level finer than spec §2 by design:
  `readBoard`, `readQuery`, `readRepos` and `readSkill` each drop only the entry that fails (a board whose id is not a `b_` id or whose name is empty, a root
  that fails `isJiraKey`, a query, a repos key or path, a skill), with one `console.warn` naming the file and the entry; a missing or unknown `interval` reads
  `DEFAULT_JIRA_INTERVAL`. Phase 1 has NO write path: the writers land in phase 2 on `writeSyncInterval`'s contract — merge one entry into the raw parsed file,
  temp-file-plus-rename, and refuse (409) rather than replace a file that is unreadable — validating with these same four functions. Why:
  [invariants.md](docs/subsystems/invariants.md#jirajson-has-exactly-one-writer-and-a-file-that-cannot-be-read-is-never-replaced)
- **The Jira token never leaves the server: the browser goes through `/api/jira`, and the poller is armed only while a board syncs.** `jiraEnv()`
  (`env.util.ts`) reads `BM_JIRA_SITE`, `BM_JIRA_EMAIL`, `BM_JIRA_TOKEN` (spelled once, in `JIRA_ENV`) per call, trimmed, never cached; whitespace is absent,
  the site is lower-cased and must pass `isJiraHostname`, and `detail` names the first problem — emptiness first, in site/email/token order, then the hostname
  shape. Every call is `JiraClient.request`'s: the gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3` (`GATEWAY_HOST`, not configurable), except
  the unauthenticated `tenant_info` (no `authorization` header at all) and the one `myselfAtSite` probe, sent once and only after the gateway `myself` answered
  200 (spec §3).
  `authorization: Basic …` is built there and nowhere else, and every `message` is Jira's sentence or the transport error's, never the request.
  `JiraStatusPayload` carries `site`, `me.name`, `me.accountId` and `tokenKind` — never the email or the token. Compose passes all three as
  `'${BM_JIRA_<NAME>:-}'`, pinned through `JIRA_ENV` by `test/compose-env.test.ts`. `JiraPollerService` is a `setTimeout` chain on `JIRA_POLL_MS`, `unref`'d,
  armed at bootstrap while the site is configured AND some board's interval is not `off`, OR some board is still owed its one cold sweep, OR the boot
  (`cloudId`, `serverInfo`, `me`, the sprint field) is unanswered — except `unsupported`, which is final and disarms. The rule is judged at the end of every
  sweep against `jira.json` read again there. Why:
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
