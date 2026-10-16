# Jira

The server half of the Jira Cloud integration ([spec](../superpowers/specs/2026-10-15-jira-integration-design.md)): a parallel subsystem beside the item
sources, not a third source. A Jira board is a set of issue keys and saved JQL defined in one per-machine file; it has no `backlog/`, no `source.json` and no
registry entry, and nothing in `items/` knows it exists. This doc describes **phase 1** (spec §12) — the client, the config reader, the poller and its
caches, the issue mapping, the ADF converter, the ticket block and six read routes. Phase 1 has no write path at all and no UI: everything here is reachable
through `/api/jira` and nothing draws it yet.

`server/src/jira/` is the third outbound-calling module, after `agents/` and `tracker/`, and the only one that talks to Atlassian.

## Scopes — what lives where

- **Per machine, in `.env`**: `BM_JIRA_SITE` (a hostname only, `acme.atlassian.net`), `BM_JIRA_EMAIL` and `BM_JIRA_TOKEN`. A scoped API token needs
  `read:jira-work`, `write:jira-work` and `read:jira-user`; a classic token works as it is. All three or none: any one missing (or blank) is
  `configured: false`, and every route but `GET /api/jira` answers 503. Compose passes each through as `'${BM_JIRA_<NAME>:-}'`, never a literal.
- **Per machine, in `~/.backlog-manager/settings/jira.json`** (`BM_JIRA_FILE` overrides): `{ boards, repos, skills }`. Phase 1 reads it; phase 2 adds the
  server's writers, and until then it is edited by hand.
- **Per project: nothing.** A mapped repository is a path in `jira.json` and never enters `registry.json`.
- **Per browser**: nothing yet — the board pick, the page and `jiraDefaultAction` arrive with the client in phase 2 and phase 5.

## The module, file by file

| file                 | what it holds                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.util.ts`        | `jiraEnv()` — the three variables, read per call, trimmed, never cached; `JIRA_ENV` is their one spelling and `isJiraHostname` the site check    |
| `config.util.ts`     | `readJiraConfig()` and the per-entry readers (`readBoard`, `readQuery`, `readRepos`, `readSkill`); `isJiraId`, `JIRA_JQL_MAX_CHARS`             |
| `jira.client.ts`     | `JiraClient` — one `fetch` wrapper over the dozen endpoints read; the gateway, the one auth header, the call counter, the deadline; `jqlString` |
| `errors.util.ts`     | `accessOf` and `jiraHttpError` — the one mapping from a Jira response to an access state and to an HTTP error (spec §8)                        |
| `identity.ts`        | `JiraBootState` — the four boot answers, the token kind, the site-level `access`/`detail`, the 429 window and the 15 s → 5 min back-off        |
| `map-issue.ts`       | `mapJiraIssue`, `pickSprintField`, `categoryOf`, `JIRA_ISSUE_FIELDS` and the Done window (`JIRA_DONE_WINDOW_DAYS`)                             |
| `adf.ts`             | `adfToMarkdown` — Atlassian Document Format to Markdown, read side only; `ADF_PLACEHOLDER_RE`                                                  |
| `block.ts`           | `renderTicketBlock` — one issue as plain text: the facts, the description, the subtasks (capped at `JIRA_BLOCK_CHILDREN_CAP`, 30)              |
| `poller.service.ts`  | `JiraPollerService` — the ticker, the boot sequence, the per-board caches, and every fresh read the routes make                                |
| `jira.controller.ts` | the six read routes                                                                                                                            |
| `jira.module.ts`     | `JiraModule` — the poller and the client (a factory value, the one place a suite swaps in a fake `fetch`), both exported                       |

Not there yet, by phase: **2** — the `jira.json` writers and their guarded POSTs (boards, repos), the whole client section; **3** — the assign and transition
writes and the cache splice that follows them; **4** — `skills/jira/` and `jira.mjs`; **5** — `prompt.util.ts`, the skills routes, `GET /api/jira/prompt`,
`dispatch-jira`, `jira-stop` and the live-session map (`JiraStatusPayload.live` is always `{}` and `JiraIssueDetail.session` always `null` until then).

## Shapes

All in `shared/types.ts`: `JiraIssue` (one issue as the board draws it — key, url, summary, project, type with its hierarchy `level`, status with its
category, priority, assignee, reporter, parent, a subtask count, labels, sprint, created/updated/resolved), `JiraQuery`, `JiraBoard` (`interval` is the existing
`SyncInterval`; `DEFAULT_JIRA_INTERVAL` is `1m`), `JiraSkill`, `JiraBoardFailure`, `JiraBoardStatus` (a board plus `polledAt`, `count`, `truncated`,
`failures`), `JiraTransition`, `JiraIssueDetail` (an issue plus the Markdown description, children, transitions and the ids of the boards holding it) and
`JiraStatusPayload`. `JiraAccess` is `ok | unconfigured | unsupported | unauthorized | forbidden | rate-limited | unreachable`; `JiraTokenKind` is
`classic | scoped`. `isJiraKey` (`^[A-Z][A-Z0-9_]+-\d+$`) and `JIRA_KEY_RE` live there too, beside the existing `SYNC_INTERVALS`.

## Routes

Every route is under `/api/jira` and behind the global Host allowlist. Inside each method the order is fixed: validate the parameter, then refuse when
unconfigured, then ask the poller — so a malformed request never reads as an environment problem.

| route                             | answers                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/jira`                   | `JiraStatusPayload`, from memory, the env and `jira.json` — no outbound call; 200 with `configured: false` when unconfigured     |
| `GET /api/jira/boards/:id/issues` | `{ issues, polledAt }` from the cache; 404 `unknown board` for an id that is not a `b_` id or not in `jira.json`                 |
| `GET /api/jira/issue/:key`        | `JiraIssueDetail`, read fresh (issue, children, transitions); `?format=text` → the ticket block as `text/plain`; 400 bad key/format |
| `GET /api/jira/search?q=`         | ≤ 20 issues for the roots picker; `q` required (400), trimmed, blank → `[]` with no call, over 100 characters → 400            |
| `GET /api/jira/projects`          | every project the credentials see, `{ key, name }[]` sorted by key, paged by `startAt`                                          |
| `GET /api/jira/jql/check?jql=`    | `{ ok: true, count }` or `{ ok: false, message }` (Jira rejected it — still a 200); `jql` required, over 2 000 characters → 400  |

Every route but the first answers 503 `Jira is not configured` while unconfigured. `POST /api/jira/boards` and `GET /api/jira/prompt` are 404s until their
phases. A failed Jira call is mapped once, by `jiraHttpError`, to a body `{ error, access?, retryAt? }`:

| Jira                   | HTTP | `error`                                     |
| ---------------------- | ---- | ------------------------------------------- |
| 401                    | 503  | `Jira rejected the credentials`             |
| 403                    | 502  | `Jira refused: <message>`                   |
| 429                    | 503  | `Jira rate limit — retry after <instant>`   |
| transport, timeout (0) | 502  | `Jira unreachable: <message>`               |
| 400                    | 409  | `Jira refused: <message>`                   |
| 404                    | 404  | `issue not found`                           |
| any other status       | 502  | `Jira answered <status>`                    |

Only a 401 (which resets `me` and restarts the boot retry) and a 429 (which opens the window) met on a ROUTE move the site-level `access`; anything else
answers its mapping and leaves `access` to the sweep. A read inside an open 429 window is refused with the same 503 and the STORED `retryAt`, and no call is
sent. A read before the boot has a `cloudId` is refused from the boot state: the 401 mapping if that state is `unauthorized`, else 502 `Jira unreachable`.
A read against an `unsupported` site is refused the same way, as 502 `Jira unreachable: Jira Server/DC is not supported`, but with `access: 'unsupported'` —
what `GET /api/jira` says — rather than the `unreachable` its synthesised status would map to.

## The poller

**Boot.** Four answers make a site usable, asked in order until each comes back and then never again for the process: `cloudId` from the unauthenticated
`GET https://<site>/_edge/tenant_info`; `serverInfo` through the gateway, where a `deploymentType` other than `Cloud` (or a 404) is `unsupported` — final,
the poller disarms; the gateway `myself`, and once it has answered 200, one `myself` at the site itself to decide `tokenKind` (200 `classic`, 401 `scoped`,
anything else `null`, never asked again); and `GET field`, from which `pickSprintField` picks the sprint field. A failed boot call records `access`/`detail`
and backs off 15 s, doubling to 5 min; a 429 opens the window instead. No board is searched until all four are in, and `me` shows on the payload only then.

**Arming.** A `setTimeout` chain on `JIRA_POLL_MS` (15 s), `unref`'d, never overlapping: armed at bootstrap while the site is configured AND some board's
interval is not `off`, OR some board is still owed its one cold sweep, OR the boot is unanswered — `unsupported` excepted. Judged again at the end of every
sweep against `jira.json` re-read there, so a chain with nothing owed stops on the tick that finds it.

**Due.** A board never swept successfully is due at once, whatever its interval — `off` included, which is how an `off` board gets one honest list per
process. Otherwise it is due when `SYNC_INTERVALS[interval]` has passed since its `polledAt`; `off` is then never due.

**One board.** Its queries in board order, then its roots in board order, deduplicated by key (first occurrence wins), capped at `JIRA_BOARD_CAP` (500,
`truncated` when it bit) and swapped into the cache whole. A query is one JQL, paged by `nextPageToken` at `maxResults: 100`, kept to `JIRA_QUERY_CAP` (200).
A root is `key = "K"` and then `JIRA_DESCENDANT_ROUNDS` (2) rounds of `parent in (…)` over the keys the previous round returned, the whole walk kept to
`JIRA_ROOT_CAP` (200). The field list is `JIRA_ISSUE_FIELDS` plus the discovered sprint field. Only the 500 cap is reported; the other two are silent.

**Failures.** A transport failure, a 5xx, a 401 or a 429 on any search is WHOLE-BOARD: the cache keeps its last good list and `polledAt`, the site-level
`access` and `detail` say why, and the sweep ends there. A 400, 403 or 404 is PER-ENTRY: Jira answered, about that root or query, so it becomes a
`failures` row (`kind`, the root key or query id, Jira's sentence) and the board proceeds; a root Jira answers with no issue is a `failures` row too. A sweep
that finished every due board clears an earlier `unreachable`, and only that — a 401 or 429 a route recorded meanwhile stands.

**The window.** A 429 Jira sent stores its end (`Retry-After`, else `JIRA_RATE_LIMIT_DEFAULT_MS`, 60 s) once, and nothing moves it while it is in force
(P1): a second 429 inside it — two reads that passed the gate together, a boot call already out — restamps `calls.last429At` and nothing else, and the 429
the poller synthesises to refuse a call inside a window opens none. The sweep and the boot make no call inside it, a boot or sweep 5xx or transport failure that
lands inside it leaves `rate-limited` standing (a sweep 401 still records `unauthorized`), and every route read is refused up front. It expires where it is read
— the status payload, the read gate, the sweep — not by a timer, so a disarmed poller cannot leave a stale `rate-limited` standing; and if the boot is still
unanswered then, the verdict the window covered (an `unauthorized`, say) comes back rather than `ok`. `calls.sweep` is approximately what the last tick sent — a
route read made during the sweep is counted with it — and `calls.last429At` the last 429 met, by a sweep or a route.

**The cache.** `Map<boardId, { issues, polledAt, truncated, failures }>`, in memory, lost on restart; a board removed from `jira.json` is pruned on the next
sweep, unless the file is unreadable. The issue detail, the roots search, the project list and the JQL check are fresh reads, never cached. The Jira board
caches are the second cache in this server whose age is a rendered value; that widened rule's mechanism stays in `.claude/rules/tracker.md` beside the
tracker cache's, which this doc points to rather than restates.

## `jira.json`'s reader

Read fresh on every use. Missing, or a parsed non-object: empty. Exists but cannot be read or parsed: empty with `unreadable` set, carried on the payload as
`configUnreadable`, and never replaced. Everything else falls back per entry — a board needs a `b_` id and a name; a root must pass `isJiraKey`; a query
needs a `q_` id, a label and JQL; a repos key must be a project key and each path a non-empty string; a skill needs an `s_` id, a name and a prompt — and each
dropped entry is warned once. An `interval` that is missing or not one of `15s`, `1m`, `5m`, `off` reads `1m`.

## The probe facts the code encodes

Spec §14's phase-0 probe, against a real Cloud site with a scoped token, and where each one landed:

- **P1** — a scoped token is 401 at `https://<site>` and 200 on the gateway → every call goes through `api.atlassian.com/ex/jira/<cloudId>`.
- **P2** — `search/jql` pages by a string `nextPageToken`, present only while `isLast: false`, with no `total`; unbounded JQL is a 400 → `pages` follows the
  token and stops on a page with none; every query the server builds is bounded.
- **P3** — `hierarchyLevel` is on every type and an unknown key is 200 with no issues → `type.level` decides hierarchy; an empty root is a `failures` row.
- **P4** — exactly one `gh-sprint` field, and its value is an array of sprints → `pickSprintField` by schema; the active sprint wins, else the last by id.
- **P5** — `statusCategory.key` can be `undefined` → `categoryOf` maps it, and anything unknown, to `new`.
- **P6** — `transitions[]` carries `to.statusCategory` → the detail read maps each to `{ id, name, to: { name, category } }`.
- **P7** — assign is unverified (a write) → nothing in phase 1 depends on it.
- **P8** — `jql/parse?validation=strict` passes unbounded JQL and `approximate-count` refuses it → the check route asks both, in that order.
- **P9** — no 429 was met → `Retry-After` is read and 60 s is the default.
- **P10** — the ADF node inventory, `taskList` included → `adf.ts`'s table; everything else is a placeholder or its text.
- **P11** — `project/search` is paged → the route pages by `startAt`, never by the `nextPage` URL Jira returns.
- **P12** — the dashboard's session answers (phase 5's) → nothing here.
- **P13** — `serverInfo.deploymentType` is `Cloud` → anything else is `unsupported`.
- **P14** — the cloud id comes from the unauthenticated `tenant_info` → the first boot call, with no `authorization` header.

## Tests

jest, flat in `test/`, none reaching a real Jira: `jira-env`, `jira-config`, `jira-client`, `jira-adf`, `jira-map-issue`, `jira-block`, `jira-poller` and
`jira-routes` (supertest through `listenLoopback`). `test/helpers/jira.ts` is `FakeJira`, an in-memory Jira over the endpoints above with a call log and a
per-request failure hook; `test/helpers/env.ts` blanks the three keys so no suite inherits a developer's credentials. `test/compose-env.test.ts` pins the
compose passthrough.
