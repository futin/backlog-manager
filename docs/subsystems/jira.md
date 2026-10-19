# Jira

The Jira Cloud integration ([spec](../superpowers/specs/2026-10-15-jira-integration-design.md)): a parallel subsystem beside the item
sources, not a third source. A Jira board is a set of issue keys and saved JQL defined in one per-machine file; it has no `backlog/`, no `source.json` and no
registry entry, and nothing in `items/` knows it exists. This doc describes **phases 1 to 4** (spec §12). Phase 1 is the server's read half — the Jira
client, the config reader, the poller and its caches, the issue mapping, the ADF converter, the ticket block and six read routes. Phase 2 adds `jira.json`'s
writers behind three guarded write routes and the whole client section: a rail entry with two pages (Board and Setup), the issue modal, the shell chip and
the Trackers row. Phase 3 adds the first two writes to Jira itself — assign the issue to me and transition it — behind two more guarded routes, each followed
by a re-read of the issue that is spliced into the board caches, and the modal's two controls that call them. Phase 4 adds the `jira` skill and its CLI,
`jira.mjs`, which reach those same routes from any Claude session on this machine — and changes nothing in the server.

`server/src/jira/` is the third outbound-calling module, after `agents/` and `tracker/`, and the only one that talks to Atlassian.

## Scopes — what lives where

- **Per machine, in `.env`**: `BM_JIRA_SITE` (a hostname only, `acme.atlassian.net`), `BM_JIRA_EMAIL` and `BM_JIRA_TOKEN`. A scoped API token needs
  `read:jira-work`, `write:jira-work` and `read:jira-user`; a classic token works as it is. All three or none: any one missing (or blank) is
  `configured: false`, and every route but `GET /api/jira` answers 503. Compose passes each through as `'${BM_JIRA_<NAME>:-}'`, never a literal.
- **Per machine, in `~/.backlog-manager/settings/jira.json`** (`BM_JIRA_FILE` overrides): `{ boards, repos, skills }`. The server is its one writer
  since phase 2 — the Setup page's boards and repository map, through the three config write routes below — and a hand edit still lands, because every reader
  reads it fresh and every writer merges one entry into the RAW file. `skills` has no writer until phase 5.
- **Per project: nothing.** A mapped repository is a path in `jira.json` and never enters `registry.json`.
- **Per browser**: `backlog-manager.jira-board` (the board pick, `usePersistedState`) and `backlog-manager.jira-page` (`board | setup`, a module store) since
  phase 2; `jiraDefaultAction` arrives with phase 5. The Board page's filters and summary search are per mount and never persisted.

## The module, file by file

| file                 | what it holds                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.util.ts`        | `jiraEnv()` — the three variables, read per call, trimmed, never cached; `JIRA_ENV` is their one spelling and `isJiraHostname` the site check    |
| `config.util.ts`     | `readJiraConfig()` and the per-entry readers (`readBoard`, `readQuery`, `readRepos`, `readSkill`); `isJiraId`, `JIRA_JQL_MAX_CHARS`; since phase 2 the write half — `parseBoardWrite`, `parseReposWrite`, `normaliseRepoPath`, `mintJiraId`, the three writers `writeBoard`, `deleteBoard`, `writeRepos`, and their two refusals `JiraConfigUnreadableError`, `JiraUnknownIdError` |
| `jira.client.ts`     | `JiraClient` — one `fetch` wrapper over the endpoints read and, since phase 3, the two it writes (`assign`, `transition`); the gateway, the one auth header, the call counter, the deadline; `jqlString` |
| `errors.util.ts`     | `accessOf` and `jiraHttpError` — the one mapping from a Jira response to an access state and to an HTTP error (spec §8)                        |
| `identity.ts`        | `JiraBootState` — the four boot answers, the token kind, the site-level `access`/`detail`, the 429 window and the 15 s → 5 min back-off        |
| `map-issue.ts`       | `mapJiraIssue`, `pickSprintField`, `categoryOf`, `JIRA_ISSUE_FIELDS` and the Done window (`JIRA_DONE_WINDOW_DAYS`)                             |
| `adf.ts`             | `adfToMarkdown` — Atlassian Document Format to Markdown, read side only; `ADF_PLACEHOLDER_RE`                                                  |
| `block.ts`           | `renderTicketBlock` — one issue as plain text: the facts, the description, the subtasks (capped at `JIRA_BLOCK_CHILDREN_CAP`, 30)              |
| `poller.service.ts`  | `JiraPollerService` — the ticker, the boot sequence, the per-board caches, every fresh read the routes make, and since phase 3 `assignToMe`, `transitionIssue`, the splice and the sweep's newest-wins rule |
| `unwrap.util.ts`     | `unwrapJira` — a poller outcome as its value or its §8 error, shared by both controllers so a failure means the same on every route (phase 3)   |
| `jira.controller.ts` | the six read routes                                                                                                                            |
| `jira-write.controller.ts` | the five write routes — three config writes (phase 2) and the two issue writes (phase 3), each behind `SameOriginPostGuard`            |
| `jira.module.ts`     | `JiraModule` — the poller and the client (a factory value, the one place a suite swaps in a fake `fetch`), both exported                       |

Not there yet, by phase: **5** —
`prompt.util.ts`, the skills routes, `GET /api/jira/prompt`, `dispatch-jira`, `jira-stop` and the live-session map (`JiraStatusPayload.live` is always `{}` and
`JiraIssueDetail.session` always `null` until then).

## Shapes

All in `shared/types.ts`: `JiraIssue` (one issue as the board draws it — key, url, summary, project, type with its hierarchy `level`, status with its
category, priority, assignee, reporter, parent, a subtask count, labels, sprint, created/updated/resolved), `JiraQuery`, `JiraBoard` (`interval` is the existing
`SyncInterval`; `DEFAULT_JIRA_INTERVAL` is `1m`), `JiraSkill`, `JiraBoardFailure`, `JiraBoardStatus` (a board plus `polledAt`, `count`, `truncated`,
`failures`), `JiraTransition`, `JiraIssueDetail` (an issue plus the Markdown description, children, transitions and the ids of the boards holding it) and
`JiraStatusPayload`; phase 3 adds `JiraIssueWriteResult`, `{ ok: true, reread: boolean }`, the answer of both issue writes. Phase 2 widened the payload by two fields: `armed`, the poller's `armed` getter — the Connection card's `every 15 s` / `idle`
has no other source — and `home`, `os.homedir()` read per call, `null` while unconfigured, because the Repositories card shows a path under `$HOME` as `~`
and the browser has no other way to know `$HOME` (compose passes the host's `HOME` through, so the container's `homedir()` is the host's). `JiraAccess` is `ok |
unconfigured | unsupported | unauthorized | forbidden | rate-limited | unreachable`; `JiraTokenKind` is `classic | scoped`. `isJiraKey`
(`^[A-Z][A-Z0-9_]+-\d+$`) and `JIRA_KEY_RE` live there too, beside the existing `SYNC_INTERVALS`.

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

Every route but the first answers 503 `Jira is not configured` while unconfigured. `GET /api/jira/prompt` is a 404 until phase 5. A failed Jira call is mapped
once, by `jiraHttpError`, to a body `{ error, access?, retryAt? }`:

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

### The config write routes (phase 2)

Three POSTs in `jira-write.controller.ts`, the only callers of the writers — POSTs because the app has no PUT or DELETE route anywhere. Each carries
`SameOriginPostGuard` (`application/json` and a same-origin `Origin`, 403 otherwise), and inside each the order is fixed: guard → validate (400, naming the
field) → configured (503 `Jira is not configured`) → write (404 / 409) → re-aim the poller. Every error body is `{ error }`. They are not gated on `access`:
a save while the credential is rejected or the site `unsupported` touches only `jira.json`, and the sweep that follows is the poller's to skip.

| route                           | body                                    | answers                                                                                           |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /api/jira/boards`         | `{ id?, name, interval, roots, queries }` | the board as stored, ids server-minted; waits for `boardSaved` (below); 404 for an `id` the file does not hold |
| `POST /api/jira/boards/delete`  | `{ id }`                                | `{ ok: true }`; drops the board's cache at once (`boardDeleted`) and re-`arm()`s; 404 for an unknown id, a second delete included |
| `POST /api/jira/repos`          | `{ project, paths }`                    | `{ project, paths }` as stored, normalised and deduplicated; `[]` removes the project's key; re-aims nothing |

`parseBoardWrite` holds spec §5's bounds: a trimmed `name` of 1–80; an `interval` in `SYNC_INTERVALS`; at most 20 roots, each passing `isJiraKey`,
deduplicated; at most 10 queries, each a trimmed `label` of 1–80 and a `jql` of 1–`JIRA_JQL_MAX_CHARS`; at least one root or query. A non-string, non-null
board `id` is a 400 naming `id`; `null` or absent is a create, whose client ids are ignored. On an update a query keeps its id only when the stored board
holds it, and every other query is minted a fresh `q_` id — a query's identity is never inferred from its label or JQL. `parseReposWrite` takes a
`JIRA_PROJECT_KEY_RE` key and at most 10 paths after `normaliseRepoPath`: trimmed, `~` and a leading `~/` expanded to `homedir()`, `~user/…` refused,
absolute with no empty, `.` or `..` segment (400 `path must be absolute and normalised: <path>`), one trailing `/` dropped, duplicates removed after
normalising — the dashboard compares paths as raw strings, so the server stores exactly one spelling.

The two refusals are the writers' own, mapped once: `JiraConfigUnreadableError` is a 409 carrying its message (the file exists and does not read; nothing
was written), `JiraUnknownIdError` a 404 `unknown board`. Why the writers read the raw file, merge one entry and write by temp-file-and-rename is
[invariants.md](invariants.md#jirajson-has-exactly-one-writer-and-a-file-that-cannot-be-read-is-never-replaced).

### The issue writes (phase 3)

Two more POSTs in the same controller, the first calls this server makes that change anything in Jira: `POST /api/jira/issue/assign` `{ key }` and
`POST /api/jira/issue/transition` `{ key, transitionId }`. The key travels in the body, not the path. They are the board's ONLY Jira writes — a third is a new
rule, not another route ([invariants.md](invariants.md#the-boards-jira-writes-are-assign-and-transition-nothing-else)). The order is the config writes'
(guard → validate → configured → the poller), and the controller maps what comes back through `unwrapJira` (§8's table above, `retryAt` verbatim) plus its two
own sentences.

| route                             | body                      | what the poller does                                                                                                                            |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/jira/issue/assign`     | `{ key }`                 | `PUT issue/{key}/assignee` with `{ accountId: <me> }` — the poller's own identity, never one from the request — then the splice                  |
| `POST /api/jira/issue/transition` | `{ key, transitionId }`   | a fresh `GET issue/{key}/transitions`, the id checked against it, then `POST issue/{key}/transitions` `{ transition: { id } }`, then the splice    |

Validation answers 400: `invalid issue key` (`isJiraKey`) and `transitionId must be a non-empty string` (a string of 1–64 characters; nothing more is asked
of its shape, because the offered-list check is the real validation). Unconfigured is 503 `Jira is not configured`. The refusals that send no call to Jira:

| refusal                                                                  | answer                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `access` is `unauthorized` — assign and transition both, `me` set or not | 503 `Jira rejected the credentials`, with `access: unauthorized`                          |
| assign, `me` unknown (the boot's `myself` has not answered)              | 503 `no identity` — `{ accountId: null }` would be an UNASSIGN, so it is never sent       |
| inside a 429 window                                                      | 503 with the STORED `retryAt`, as every read; a transition checks it again after its read |
| transition, the id not in the fresh offered list                         | 400 `transition not offered` — this server's own sentence, Jira is not asked              |

Assign is refused under `unauthorized` even while `me` is still set from before the 401; a transition needs no identity and is refused ONLY under
`unauthorized`, which the read gate alone would not do (a 401 keeps the `cloudId`). Jira's own refusals map through `jiraHttpError` unchanged — 403 → 502,
400 → 409 `Jira refused: <message>`, 404 → 404 `issue not found`. A 401 on the write itself is a route-met 401 like any other: it resets `me`, `GET /api/jira`
then says `unauthorized`, and the next issue write is refused with no call.

**The answer.** `200 { ok: true, reread }`. `reread` is true when the re-read of the issue after the write came back as an issue — even if the Done window then
dropped it, which is a good read this server would not show — and false when its 2xx body was not an issue or the call failed (its 401 or 429 still moves the
site state). A failed re-read after a landed write is NOT an error: the write cannot be un-happened, and a 4xx/5xx would invite a retry of a write that stood.
The next sweep corrects the cache.

**The splice.** After the write lands the poller reads `GET issue/{key}` with the sweep's fields, maps it with the sweep's context (`now: Date.now()`, the
window on) and replaces the issue AT ITS INDEX in every board cache that already holds the key. It never adds the key to a board (membership is the board's
queries' and roots'), leaves each cache's `polledAt` alone (the age is the list's), and touches nothing when the re-read does not map to an issue. A re-read and
not a local patch because Jira's workflow can run post-functions that change more than the field written.

**Newest `updated` wins.** `sweepBoard` ends in `keepNewer`: for a swept issue whose key the board's cache NOW holds with a strictly newer `Date.parse(updated)`,
the cached copy is kept — so a sweep that was in flight across the write, or that Jira's search index answered before it caught up, cannot put the pre-write
copy back over the splice. Equal or unparseable on either side keeps the sweep's copy. **The accepted lag:** the rule only replaces, so a key the sweep did not
return is dropped as before — a lagging index can make a just-assigned issue vanish from an `assignee = currentUser()` board for ONE sweep, until the index
catches up and the next sweep returns it again. That is by design (plan R5), not a bug to file.

**No per-key queue** (R6): two browsers racing the same issue are Jira's last-write-wins and the rule above keeps the caches on the newest answer; the one-at-a-time
guard is the modal's.

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

**A save (phase 2).** `boardSaved(id)` forces that board due — `forced`, a map from board id to the generation of the save, NOT a reset of its
`polledAt`, which would empty the last good list — waits out a sweep already in flight (it read `jira.json` before the save, so it cannot spend the force),
runs one that started after the call, and resolves when it is done or after `JIRA_SAVE_SWEEP_WAIT_MS` (20 s), whichever is first; it never rejects. The
force is spent only by a sweep that SUCCEEDS on the board, so a boot still unanswered, a 429 window or a failing Jira leaves it owed and retried on the next
tick — for an `off` board that is the only thing that would ever replace the list swept from the pre-edit definition. Past the cap the save has still landed
and the sweep still runs to its end; the client's next status poll catches the list up. `boardDeleted(id)` drops the cache and the force at once, so a board
re-created under the same id starts cold.

**The cache.** `Map<boardId, { issues, polledAt, truncated, failures }>`, in memory, lost on restart; a board removed from `jira.json` is pruned on the next
sweep, unless the file is unreadable. Since phase 3 the one other thing that changes a cache between sweeps is an issue write's splice — one issue replaced in
place, `polledAt` unmoved — and the sweep that follows keeps the newer copy (above). The issue detail, the roots search, the project list and the JQL check are fresh reads, never cached. The Jira board
caches are the second cache in this server whose age is a rendered value; that widened rule's mechanism stays in `.claude/rules/tracker.md` beside the
tracker cache's, which this doc points to rather than restates.

## `jira.json`'s reader and writers

Read fresh on every use. Missing, or a parsed non-object: empty. Exists but cannot be read or parsed: empty with `unreadable` set, carried on the payload as
`configUnreadable`, and never replaced. Everything else falls back per entry — a board needs a `b_` id and a name; a root must pass `isJiraKey`; a query
needs a `q_` id, a label and JQL; a repos key must be a project key and each path a non-empty string; a skill needs an `s_` id, a name and a prompt — and each
dropped entry is warned once. An `interval` that is missing or not one of `15s`, `1m`, `5m`, `off` reads `1m`.

The three writers (phase 2) follow `writeSyncInterval`'s shape: read the RAW file; ENOENT starts from `{}`; a file that cannot be read or does not parse
throws `JiraConfigUnreadableError` and writes nothing; a parsed non-object is replaced; otherwise merge ONE entry — a board by id (keeping its position in
`boards`), one project's path list by key — and keep everything else, malformed entries and unknown top-level keys included, then write
`JSON.stringify(next, null, 2) + '\n'` to a temp file in the same directory and `rename` it over. Ids are `b_`/`q_` plus eight lower-case hex digits,
minted against every id the file already holds, malformed entries' included, so a minted id never collides.

## The client (phase 2, the modal's controls phase 3)

The look is [`.claude/DESIGN.md`](../../.claude/DESIGN.md) §8.9; this is the mechanism. The browser never talks to Jira: every request is to
`/api/jira…`, a person is initials on a disc rather than Jira's `avatarUrls`, and every link out is `JiraIssue.url` as the server built it.

- **The section.** `jira` is in `SECTIONS` (`client/src/lib/sections.ts`) between `archive` and `settings`, unconditionally, and `RAIL_LABEL.jira` is `Jira`.
  The rail draws the row only while the status says `configured: true` (or while a stored `jira` section is held for the first answer), `App` falls a `jira`
  section to Board on `configured: false` and on nothing else, and Settings' `Opens on` offers `Jira` only while configured. `JiraView` (lazy, like every
  section) picks the page and holds the open issue. The two pages, `JIRA_PAGES` in `lib/jira-page.ts`, are held by `hooks/useJiraPage.ts`, a module store
  with `useRunsMode`'s shape, and switched by the rail's tree or by `onOpenJiraPage` — the tree's own pair, built in `App` and handed down — never by an
  in-page control. The rule and its reasons are
  [invariants.md](invariants.md#the-jira-sections-two-pages-are-switched-by-the-rails-tree-and-the-section-is-drawn-only-when-configured).
- **The provider and the hooks.** `JiraProvider` (`hooks/JiraContext.tsx`) holds the shell's ONE `useJira`, beside `TrackersProvider`, so the rail, the chip,
  both pages and the Trackers row read one answer on one clock. `useJira` (`hooks/useJira.ts`) is `useTrackers`' shape: one read on mount and focus, a timer
  aimed at the soonest syncing board's `polledAt + interval + TRACKER_FETCH_SLACK_MS` with a `JIRA_STATUS_FLOOR_MS` (15 s) floor, no timer while
  unconfigured or with no syncing board, only the newest read allowed to write, and the last payload kept through a failed read — it is the second
  deliberate exception to the `useCoalescedFetch` rule
  ([invariants.md](invariants.md#a-client-poller-built-on-usecoalescedfetch-never-has-two-of-its-own-requests-in-flight)). `useJiraBoard(id, interval, nudge)`
  (`hooks/useJiraBoard.ts`) IS on `useCoalescedFetch`: it polls `boards/:id/issues` every `BOARD_TRACKER_POLL_MS` while the board syncs, once and then only on
  `reload` for an `off` one, and only an answer for the current id may write. A CHANGE of `nudge` — a counter `JiraView` owns and bumps when the issue modal
  reports a landed write — asks at once through the same coalesced request, whatever the interval, `off` included (spec §6.1).
- **`lib/jira.ts`** is the one home of every derivation the five surfaces print — the columns (`JIRA_COLUMNS`, `columnOf`, `sortForBoard`), the card's crumb
  (`crumbOf`/`crumbText`), initials, age (`cardAgeStamp`), the fold (`foldBoard` — the one walk of the parent chain, into `tops`, `under` and the
  `childrenOf` index — `sortTops`, `foldProgress`, `cardFold`, `foldMatches`, the modal's `modalTree`) and its sentences (`progressLine`, `childrenLine`,
  `matchMarker`), the band line (`bandSub`, whose issue and card counts come from the fold once the list has loaded), a Setup row's sentence (`boardRowLine`), the
  failure phrase, the chip's CALLS reading (`callsReading`, against `JIRA_SWEEP_CALL_CEILING` = 100, red inside `JIRA_429_RED_MS` = 15 min of the last 429),
  the Connection card's `sweepLine` and `accessPhrase`, the board pick (`JIRA_BOARD_KEY`, `pickBoard`, `boardsByName`), the filters, `JIRA_QUERY_PRESETS`,
  `unmappedProjects` and `displayPath`. Nothing in it reads a clock: `now` is a required parameter, and every poll or check age goes through `pollAge` (a card's age is `elapsedSince`'s own reading).
- **Jira › Board** (`components/jira/JiraBoardView.tsx`, `JiraCard.tsx`). The stored pick is a preference: `pickBoard` resolves it against the status's live
  list on every render, and `useJiraBoard` is handed only the id that resolution returns — a deleted or hand-edited pick falls to the first board by name and
  never becomes a request for `/boards/<that id>/issues`. Filters (type, assignee, sprint, the summary search) are read off the loaded list, per mount.
  `configUnreadable` draws `jira.json cannot be read — <reason>`, never `No boards yet`. The board draws the fold's tops only, each column sorted by
  `sortTops` and counting cards, and a filter that matches only a folded issue still shows its top, ringed. A card click lands in `JiraView`'s open-issue
  slot with the fold's `childrenOf` beside the issue.
- **The issue modal** (`components/jira/JiraIssueModal.tsx`) composes `ui/Modal` and `ui/Fact` as `ItemModal` does, draws every fact the card carried at
  once, and reads `GET /api/jira/issue/:key` fresh on open for the description (through `renderMarkdown`, `lib/markdown.ts`, the sanitising `marked` config
  `ItemModal` also uses), the children and the boards holding it. The held answer is stamped with its key, so a late answer for an issue the modal has left
  is dropped. The children draw as a tree: the detail's direct children with their descendants from the `childrenOf` snapshot the card click carried, each
  key once; a row click swaps the one modal's issue through the same `JiraView` setter, never a second `Modal`.
  **The controls row (phase 3)** sits under the facts: an `Assign to me` chip and a `Move to…` select (DESIGN.md §8.9.2). Assign posts `{ key }` to
  `/api/jira/issue/assign`; a pick in the select posts `{ key, transitionId }` to `/issue/transition` at once, the select staying controlled at its
  placeholder. Both go through ONE `useAction`, so its ref guard holds across them — a double click, or a Move picked while Assign is out, sends one POST — and
  both are disabled while a write is out. A write carries the key it was sent for: a refusal, or a detail re-read, arriving after the modal swapped to another
  issue is dropped rather than drawn under it. A failure is the server's sentence (else `HTTP <status>`, else the network's) in a `role="alert"` line under
  the row, and the modal stays open. A landed write reloads three things: the shell's status (`useJiraContext().reload()`), the board's list (`onWrote`, the
  nudge above) and the modal's own detail — which keeps showing the last detail of the SAME key meanwhile, so the body does not flash `loading…` and the
  controls do not blink to disabled. A `reread: false` answer is a success like any other: the modal does not read the body.
- **Jira › Setup** (`components/jira/JiraSetupView.tsx`) makes the page's ONE `/api/jira/projects` read per mount and hands it to the board sheet and the
  Repositories card. The Boards card's `Open board` writes the pick straight to `localStorage` (the page unmounts in the commit that navigates, so a
  `usePersistedState` effect would never run) and calls `onOpenJiraPage('board')`. `JiraBoardSheet` composes `ui/FormSheet`, seeds its fields once at
  mount, debounces the root search (`JIRA_ROOT_SEARCH_DEBOUNCE_MS`, 300 ms) and the JQL check (`JIRA_JQL_CHECK_DEBOUNCE_MS`, 500 ms), leaves validation to the
  server, and on any answer but a 200 stays open with the server's sentence. `JiraReposGroup` sends a project's whole list per write, the typed path trimmed
  but otherwise as typed — the server alone normalises. `JiraConnectionGroup` is a read-only report. Every landed write reloads the shell's status, even if
  the page has gone.
- **The chip and the Trackers row.** `JiraChip` (`components/JiraChip.tsx`) sits beside `TrackerChip` in the one home `App` picks with `useNarrow` — the
  strip at desktop width, the rail bar's `chipSlot` below 700 px — and wears its `.tracker-chip*` classes; it draws only while configured. Its popover is a
  `Popover` reading with no links or buttons. With both chips in the rail bar neither draws its meters (a CSS rule in the 700 px block). The Settings ›
  Shared › Trackers card (`components/settings/TrackersGroup.tsx`) closes on one read-only Jira row from the same `useJira`.

## The skill (phase 4)

`skills/jira/` is the plugin's seventh skill, and `skills/jira/tools/jira.mjs` its CLI. Every command is a request to the routes above, on
`127.0.0.1:${BM_API_PORT || 4322}` — the CLI carries no Jira credential, reads no `BM_JIRA_*` and sends no `authorization` header, so the server stays Jira's
one caller (spec §10), and a source guard in `jira.test.mjs` holds all three.

| command                     | route(s)                                                                      | stdout                                              |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `show <KEY>`                | `GET /api/jira/issue/:key?format=text`                                        | the ticket block, verbatim                          |
| `transitions <KEY>`         | `GET /api/jira/issue/:key`                                                    | `<id>\t<label>\t<category>`, one per transition     |
| `transition <KEY> <id\|name>` | `GET /api/jira/issue/:key`, then `POST /api/jira/issue/transition`            | `<KEY>: <label>`                                    |
| `assign <KEY>`              | `POST /api/jira/issue/assign`                                                 | `<KEY> assigned to you`                             |
| `status`                    | `GET /api/jira`                                                               | `site:`, `signed in as:`, `access:`, `boards:` lines |

- **Keys** are trimmed and upper-cased, then checked against a copy of `JIRA_KEY_RE` before any request — a miss is exit `1` and sends nothing, so no raw
  argument ever reaches a URL path.
- **`transition`'s argument** is every word after the key, matched against the offered transitions in three steps, stopping at the first that matches
  anything: the exact id, then the transition's name, then its target status (case-insensitive). Ambiguous or not offered is exit `2`, naming what is
  offered, and nothing is posted; the server re-checks the id against a fresh read of its own, and a workflow that moved between the two reads is its 400.
- **`status` exits `0` only when `access` is `ok` and `me` is set**, and `3` otherwise — the code every issue command would meet in that state — so
  `jira.mjs status && …` reads as "the next call can work". `access: ok` with no identity is a boot still connecting, whose every issue call is the server's
  `connecting` 502 until `me` lands. Not configured is stderr and `3`. An answer the tool cannot read — a body cut off mid-read, a transition with no target —
  is `3` too, never `1`: a request may already have landed.
- **Exit codes:** `0` success, `1` usage, `2` a 4xx (the server's `error` printed verbatim), `3` a 5xx or a 2xx whose body cannot be read, `5` the stack is
  down — a sentence naming the backlog-manager checkout, because the CLI runs in a mapped repository where `pnpm run dev` means something else.

## The probe facts the code encodes

Spec §14's phase-0 probe, against a real Cloud site with a scoped token, and where each one landed:

- **P1** — a scoped token is 401 at `https://<site>` and 200 on the gateway → every authenticated call goes through `api.atlassian.com/ex/jira/<cloudId>`, bar
  the one `myself` at the site that tells `tokenKind`.
- **P2** — `search/jql` pages by a string `nextPageToken`, present only while `isLast: false`, with no `total`; unbounded JQL is a 400 → `pages` follows the
  token and stops on a page with none; every query the server builds is bounded.
- **P3** — `hierarchyLevel` is on every type and an unknown key is 200 with no issues → `type.level` decides hierarchy; an empty root is a `failures` row.
- **P4** — exactly one `gh-sprint` field, and its value is an array of sprints → `pickSprintField` by schema; the active sprint wins, else the last by id.
- **P5** — `statusCategory.key` can be `undefined` → `categoryOf` maps it, and anything unknown, to `new`.
- **P6** — `transitions[]` carries `to.statusCategory` → the detail read maps each to `{ id, name, to: { name, category } }`.
- **P7** — assign was not probed (a write; `write:jira-work` covers it) → phase 1 depended on nothing here; phase 3 sends `PUT issue/{key}/assignee { accountId }`
  as §8 states it and expects a 204.
- **P8** — `jql/parse?validation=strict` passes unbounded JQL and `approximate-count` refuses it → the check route asks both, in that order.
- **P9** — no 429 was met → `Retry-After` is read and 60 s is the default.
- **P10** — the ADF node inventory, `taskList` included → `adf.ts`'s table; everything else is a placeholder or its text.
- **P11** — `project/search` is paged → the route pages by `startAt`, never by the `nextPage` URL Jira returns.
- **P12** — the dashboard's session answers (phase 5's) → nothing here.
- **P13** — `serverInfo.deploymentType` is `Cloud` → anything else is `unsupported`.
- **P14** — the cloud id comes from the unauthenticated `tenant_info` → the first boot call, with no `authorization` header.

## Tests

jest, flat in `test/`, none reaching a real Jira: `jira-env`, `jira-config`, `jira-client`, `jira-adf`, `jira-map-issue`, `jira-block`, `jira-poller` and
`jira-routes` (supertest through `listenLoopback`); phase 2 adds `jira-config-write` (the writers), `jira-write-routes` (the three POSTs, supertest), the pure
`jira-lib` (`lib/jira.ts`), and the jsdom suites `use-jira`, `jira-sections`, `jira-board`, `jira-modal`, `jira-setup` and `jira-chip`, which mock `fetch`. Phase 3 adds `jira-issue-writes` (the two routes, supertest: the guard, validation, the refusals, the 429 window, a 401 on the
write, the identity gate) and widens `jira-client` (the two calls), `jira-poller` (the splice, in-place-never-add, newest-wins) and `jira-modal` (the controls row, the
in-flight guard, the key stamp, the held detail).
`test/helpers/jira.ts` is `FakeJira`, an in-memory Jira over the endpoints above with a call log and a per-request failure hook; `test/helpers/env.ts` blanks
the three keys so no suite inherits a developer's credentials. `test/compose-env.test.ts` pins the compose passthrough.

<!-- docs-sync:
  sources:
    - server/src/jira
  kind: subsystem
  verified: 9cbf5e1a207d009e9fcf01f9f1b79804ed1742da
-->
