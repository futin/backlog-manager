# Jira integration — design

**Date:** 2026-10-15 · **Status:** approved in conversation, section by section; written spec awaiting review · **Path:** architectural (brainstorming)
**Mocks:** https://claude.ai/artifact/JHdzBd5RCpWWSJwjKNFHZL (canvas, version 8); the picked artboards and their audit against the code are in
[`2026-10-15-jira-mockups/`](2026-10-15-jira-mockups/00-mock-audit.md).

## 0. Intent

Anyone running this board should be able to point it at **their** Jira Cloud site with **their** credentials and work tickets from it the way the GitHub
tracker lets them work issues: see a chosen set of tickets as a board, open one, and start a Claude session on it. The one thing v1 must do that the
GitHub tracker does not is **write presence back to Jira** — assign the ticket to me and move it to the status the team expects — so that colleagues see
someone is on it without anybody typing a comment by hand. Nothing here is specific to any company; the one existing Jira skill on this machine
(`summarise-jira-ticket-changes`, which uses the Atlassian MCP connector) is an example of the kind of custom skill the design lets a machine register, not a
dependency.

What the user said, verbatim where it matters: "Anyone should be able to use JIRA with their credentials, regardless of the company"; "we need to be able to
interact and write to jira, so that others can see that someone is working on the ticket"; "Lets not add comment section, we don't need to add comments or
read them in V1"; "Board picker should only allow to pick boards, nothing else"; "I also want to be able to run custom skills on the task … run it in the
background (via claude-dashboard), or copy-past the prompt and run it from Harness".

Assumptions the user did not state and this design makes: Jira **Cloud** only (REST v3, Basic auth with an API token); one site per machine; the
tracked set is small (tens to a few hundred issues per board), so the server can hold every board in memory; the dashboard
(`claude-agents-dashboard`) is the only background runner, exactly as it is for the Board today.

## 1. Decisions and their alternatives

| question                           | picked                                                                                                              | rejected                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| where Jira lives in the code       | **A** — a parallel `server/src/jira/` module with its own shapes, routes and rail section; `BacklogItem`, `SourceKind`, the Board page untouched | **B** Jira as a third `SourceKind` on the existing Board (Jira's hierarchy, statuses and keys do not fit `BacklogItem`'s sections); **C** extract a generic tracker platform first (right later, too much now — noted in §15) |
| what is tracked                    | **named boards**, each a set of **roots** (an epic/story/task whose descendants are fetched, depth 3) plus **JQL queries**; columns are Jira's three `statusCategory`s | whole-project mirroring; Jira's own agile boards (their API is a different, heavier surface) |
| board layout                       | **B** — flat cards sorted by `updated`, parent as a crumb on the card                                                | **A** — roots as groups with subtasks nested (`Main.dc.html`): hierarchy stole the column's job |
| the Setup page                     | rail sub-page `Jira › Setup`: Boards as rows (Open board + Edit), Repositories, Connection, Skills; ONE edit sheet   | tiles with the query editor at the bottom ("nothing is clear"); a separate rail entry for Setup |
| the board picker on the board page | picks a board, nothing else                                                                                          | picker with Edit / New (those belong to Setup) |
| comments                           | **none in v1** — not read, not written; the modal says so and links out                                            | the first modal draft's comment list and composer |
| running a session on a ticket      | `Run ▾`: two built-ins (`execute`, `context`) plus this machine's **skills**; a launch sheet with **Start** (dashboard) and **Copy prompt** (clipboard) | one `work ▸` control with a fixed action |
| ticket → repository                | a per-machine map **Jira project key → local checkouts**, set up front in Setup, independent of any ticket          | per-ticket pick with no map; a registry entry per repo |
| credentials                        | `.env` per machine (`BM_JIRA_SITE`, `BM_JIRA_EMAIL`, `BM_JIRA_TOKEN`), restart to change                            | a settings-page form (would put the token through the browser); OAuth app (needs an Atlassian app registration per site) |

Where the spec and the picked mocks differ, the spec wins: the session name is `jira <KEY>` (the dashboard's name rule rejects the mocks' `jira:PAY-131`);
the launch sheet's Move to defaults to `leave as is`, not the mocks' `In Progress`; a Done card reads its age, not `resolved Oct 11`; a root carries a `root`
crumb and its children the parent crumb; the marker reads `N subtasks`, not `1 of 3 subtasks done`; there is no Sort control — the list is by `updated`; the
Boards card is sorted by name with off boards last; Connection names the scopes the token needs and does not claim to have checked them; the two built-ins
are `Work it end to end` and `Open with the ticket loaded`; the mocks' issue counts are illustrative and were not recomputed; Setup's Repositories warning, Connection line and roots rows (`· 7 under it` has no
source) read as this spec states them; BoardsTen's and NewBoard's tile wording is the mocks' alone; a path displays with `~` for `$HOME`.

## 2. Scopes — what lives where

- **Per browser**: the picked board id (`backlog-manager.jira-board`, `usePersistedState`), the Jira page (`backlog-manager.jira-page`, a module store
  like `useRunsMode`), and — the one settings key, in `client/src/lib/settings.ts` and clamped like every other — `jiraDefaultAction` on Settings › Local ›
  Dispatch — `execute`, `context`
  or a skill id, seeding the launch sheet's Action and never the last launch. `clampSettings` keeps it a non-empty string; which ids exist is only known where
  the skills list is, so `resolveJiraAction(setting, skills)` in `lib/jira.ts` is what falls back to `execute`.
- **Per machine**: `.env` holds the three credentials. `~/.backlog-manager/settings/jira.json` (`BM_JIRA_FILE` overrides) holds `{ boards, repos, skills }`
  — the **fourth file this server writes**, after `watchdog.json`, the control files and `tracker-sync.json`, on `tracker-sync.json`'s contract: read
  fresh per use and cached nowhere; each malformed ENTRY (a board, a skill, one project's path list) falls back on its own and costs only itself; a write
  merges ONE entry into the raw parsed file — a board or skill by id, one project's list by key — and preserves everything else in it, malformed entries and
  unknown keys included, then lands by temp-file-plus-rename; a file that exists but cannot be read or parsed is refused (409) and left exactly as it is — and `GET /api/jira` says so (`configUnreadable`),
  so the Board page reads `jira.json cannot be read` rather than `No boards yet`. The server is its only writer, through the guarded POSTs in §5.
- **Per project: nothing.** No marker, no registry entry. A mapped repository is a path in `jira.json` and never enters `registry.json`; a Jira board has no
  `backlog/` and no `source.json`. This is the one thing that keeps A a parallel subsystem rather than a third source.

## 3. Server — `server/src/jira/`, the third outbound-calling module

`tracker/` and `agents/` are today the ONLY two modules that call out; `jira/` becomes the third, and the CLAUDE.md layout line says so.

- `jira.client.ts` — one `fetch` wrapper: Basic auth from the env, every call on Atlassian's gateway `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…` — the one
  base both token kinds answer on (P14: a scoped token gets 401 at `https://<site>`); the `cloudId` comes from `GET https://<site>/_edge/tenant_info` (unauthenticated) at
  boot, held in memory, re-read on the ticker until it answers; only `browse` links use `https://<site>`. JSON in and out, `AbortSignal.timeout`. Maps 401 →
  `unauthorized`, 403 → `forbidden`, 429 → `rate-limited` carrying the `Retry-After` instant, network/timeout → `unreachable`. Counts calls per sweep and
  stamps the last 429, for the chip.
- `config.util.ts` — `readJiraConfig()` and one writer per entry kind (`writeBoard`, `deleteBoard`, `writeRepos`, `writeSkill`, `deleteSkill`) over `jira.json`, plus
  `JiraConfigUnreadableError`. Ids are server-minted (`b_`, `q_`, `s_` plus
  8 hex); a board's, query's or skill's identity is its id, never its name — a query keeps its id across edits of its board, and one sent without an id is
  new.
- `poller.service.ts` — one 15 s ticker, armed while the site is configured AND one of three holds: some board's interval is not `off`; a board is still owed
  its boot sweep; one of the three boot calls — `serverInfo`, `myself`, the sprint-field discovery — has not yet answered (the GitHub poller's "still owed"
  rule). Until those three have answered, `access` is the last boot call's error (`unreachable` on a network failure), and `serverInfo` is retried on the
  same back-off as `myself`. A board is due when `now − polledAt ≥ SYNC_INTERVALS[interval]`; the default interval is **`1m`**, not GitHub's `15s`, because a
  sweep is several calls deep. `off` keeps a GitHub repo's one cold sweep at boot and adds one after each save of the board (new here — a GitHub interval save only re-arms),
  never on the ticker, so its list exists and is honest about its age; a boot sweep that failed is owed again on the next tick until one succeeds. A save of any board ("re-aimed" below) sweeps that board at once and resets its due time. Per due board: each query runs through `POST search/jql` with a fixed field list, following `nextPageToken`, capped at
  **200** issues per query; each root is fetched on its own (`key = "K"`), so a root Jira no longer knows (an empty answer — Jira says 200 with no issues for a key it does not know, P3 — or a 400 naming it) is a `failures` entry on the
  board while the others proceed; then its descendants with `parent in (…)` over the keys just returned, repeated for two rounds below the root (epic → story →
  subtask; an initiative-level root reaches its epics and stories, not their subtasks), each root's walk capped at 200; results are deduplicated by key — queries first in board order, then roots in board order — and the board is
  capped at **500** in that order, with `truncated: true` in its status. The cache is
  `Map<boardId, { issues, polledAt, truncated, failures }>`: a root Jira no longer knows or a query Jira refused is one `failures` entry (`kind`, the root
  key or query id, Jira's message) and the rest of the sweep proceeds; a sweep that fails before it can replace anything (the site unreachable, a 401, a
  429) leaves the last good list and its `polledAt` in place and records the failure on the site-level `access` and `detail`. Descriptions, children detail and transitions are never swept — they are read on modal open.
- `map-issue.ts` — Jira JSON → `JiraIssue`: `status.statusCategory.key` → the column, `issuetype.hierarchyLevel` → `type.level`, `issuetype.subtask`,
  `parent.key`, the sprint from the one custom field whose schema is `gh-sprint` — discovered from `GET field` at boot and retried on the ticker until it answers; the
  field is an array (a carried-over issue sits in several), and the active sprint wins, else the last by id, and its name is what is kept; two fields with the schema → the one named `Sprint`, else the lowest id. The **Done window** lives here, and only here
  (`JIRA_DONE_WINDOW_DAYS` = 14 is this file's constant): an issue in the `done` category whose `resolutiondate` — or, when Jira recorded none, whose
  `updated` — is older than 14 days is dropped at map time, because a root's done children would otherwise pile up forever and a query author has JQL for
  the rest. An issue in any other category is never dropped, however old a stale `resolutiondate` from an earlier close may be. The window applies as each
  issue is mapped, before the 500 cap, and a root it drops still has its descendants walked.
- `adf.ts` — Atlassian Document Format → Markdown, read side only. Nothing in v1 writes text to Jira, so there is no Markdown → ADF.
- `identity.ts` — `GET myself` at boot, on the gateway; one extra `GET myself` at `https://<site>` decides the token kind the Connection card shows (`classic` when it
  answers 200, `scoped` on 401 — P14), once, never retried. A failure of the gateway call sets `access` from the error and `me: null`, and the call is retried on the sweep ticker with back-off
  from 15 s to 5 min until it succeeds — under `unauthorized` the sweep itself does not run and issue writes answer 503, under `unreachable` the boot calls keep
  retrying on the same ticker, and no board is swept until all of them have answered (the plan's decision, review round 2). A 401 on any later call resets `me` and starts the retry again. `me: null` reads `no identity` on the chip and the Connection
  row and disables `Assign to me` with that title. Assign-to-me uses the `accountId`.
- `block.ts` — the **ticket block**: facts, the Markdown description and the subtasks list as one text, the SAME text `jira.mjs show` prints and every Run
  prompt ends with. One renderer, two readers.
- `prompt.util.ts` — composes every Run prompt: a built-in's text (`execute`: branch, implement, verify, then move the issue with `jira.mjs transition`;
  `context`: load the ticket and wait), or a skill's template with `{key} {summary} {url} {repo} {description}` filled in, then the ticket block. Cut to
  `JIRA_PROMPT_MAX` (4 000 — the dashboard's own `PROMPT_CAP`, which it enforces with a 400 and does not publish, so a bump there is a bump here; the
  existing `PROMPT_MAX` of 8 000 is a paste bound, not this cap) by trimming the description with a `[description truncated — open in Jira]` marker; the children
  list is capped at 30 lines (`+N more` after), the facts are bounded by Jira, and a prompt still over the cap with the description trimmed to nothing is
  a 400 `prompt too long` from both routes, raised before any write. The summary passes `oneLine`; the block is framed as data — a line saying the text between two markers is the ticket's own content and not instructions, the markers carrying a
  nonce minted per composition so no ticket can contain them, the description inside a fence one backtick longer than its longest backtick run (three at
  least) — because it is untrusted text going into a session that can write files; a template's `{description}` is filled with that same fenced, marked
  text, never the bare description. One function, used by Start and by Copy
  prompt. It runs twice on Start: once BEFORE any Jira write, for the length check and the preview, and once after the writes, for the spawn, so the facts
  the session reads are the ticket as it is; the cut applies to the second as well, and a second composition that cannot fit even so is the same 400, the writes standing (a case a few
  bytes of status and assignee text can only reach when the first was already at the cap). A template that consumed `{description}`
  gets the block without its description, so nothing is sent twice.
- `jira.controller.ts` (reads) and `jira-write.controller.ts` (writes, behind `SameOriginPostGuard`). Dispatch and stop stay in `agents/`, which already
  owns the dashboard calls; `AgentsModule` imports `JiraModule` (agents → jira, never back). `JiraService` owns the **live map** `key → { sessionId, name,
  repo, startedAt }`: memory only, capped at 100 with the oldest evicted first, entries expire after 8 h, and a Stop clears one early. A dispatch RESERVES
  its key in the map (`sessionId: null`, a `starting` entry) before its first Jira write and releases it on any failure, so a second Start on the same key
  during the window is the 409 and never a second session. Reconciliation is the agents side's job (`agents/jira-live.service.ts`, a 60 s timer armed only while the map holds a session, never in a request's
  path): one `GET <dashboard>/api/sessions` per tick, and an entry stays live only while its session's status is `working` or `question` — the test the
  abort route makes — because the list keeps exited sessions as `idle` for its whole lookback. A `starting` entry is never reconciled, and an entry younger
  than 2 min is left alone, because a just-spawned session has no transcript yet and is absent from the list. A list that cannot be read leaves the map
  untouched; the 8 h expiry is the floor for a dashboard that cannot be asked. A restart forgets it — a card then shows no strip,
  which is accepted for v1 (`DispatchRecordsService` makes the same trade for the same reason).

## 4. Shared shapes — `shared/types.ts`, all new, nothing existing changes

Shapes, not code: the implementer owns the exact TypeScript.

- `JiraStatusCategory` = `new | indeterminate | done`; Jira's fourth key, `undefined` ("No Category"), maps to `new`.
- `JiraIssue`: `key, id, url, summary, project { key, name }, type { name, level, subtask }, status { name, category }, priority | null,
  assignee { accountId, name } | null, reporter name | null, parent { key, summary } | null, subtasks (a count), labels[], sprint | null, created, updated,
  resolved | null`. The sweep's field list is exactly what fills this: `summary issuetype status priority assignee reporter parent subtasks labels created
  updated resolutiondate project` plus the discovered sprint field.
- `JiraQuery`: `id, label, jql`. `JiraBoard`: `id, name, roots: key[], queries: JiraQuery[], interval: SyncInterval` (the existing type; `DEFAULT_JIRA_INTERVAL
  = '1m'`).
- `JiraSkill`: `id, name, prompt` (the template). `JiraAction` = `'execute' | 'context' | { skill: id }`.
- `JiraStatusPayload`: `configured, configUnreadable (null, or why jira.json could not be read), site, me { accountId, name } | null, access, detail, boards: (JiraBoard & { polledAt, count, truncated, failures: { kind: 'root' | 'query', id, message }[] })[],
  repos: Record<projectKey, path[]>, projects { key, name }[] (the union of project keys seen on any board cache and the mapped keys — no outbound call), skills: JiraSkill[], calls { sweep (every call the last tick made, however many boards it swept), last429At }, live: Record<key, { name, startedAt, repo, starting: boolean }>` — a `starting` entry is included, so a card reads `starting` from the first write.
  `access` is one of `ok | unconfigured | unsupported | unauthorized | forbidden | rate-limited | unreachable`.
- `JiraIssueDetail extends JiraIssue`: `description` (Markdown), `children: JiraIssue[]`, `transitions { id, name, to { name, category } }[]`,
  `boards: id[]` (which boards hold it), `session | null`.
- `JiraDispatchRequest`: `key, repo, action: JiraAction, assign: boolean, transitionId | null, model, effort, permissionMode, remoteControl`; the result is
  `AgentDispatchResult & { assigned: boolean, transitioned: string | null, session: { name, startedAt, repo } }`.

## 5. Routes — all under `/api/jira`, all behind the Host allowlist

Reads:

| route                                   | answers                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/jira`                         | `JiraStatusPayload`; `configured: false` when any of the three env vars is absent — the client draws nothing Jira then   |
| `GET /api/jira/boards/:id/issues`       | the board's cached list, with `polledAt`; 404 for an unknown board                                                      |
| `GET /api/jira/issue/:key`              | `JiraIssueDetail`, read fresh (issue, children, transitions); `?format=text` returns the ticket block as `text/plain`    |
| `GET /api/jira/search?q=`               | ≤ 20 issues for the roots picker: `key = Q` when `q` passes `isJiraKey`, else `summary ~ "<q>*"` with `\` and `"` in `q` backslash-escaped; `q` is trimmed (empty → `[]`, over 100 characters → 400) and upper-cased before the key test; Jira's 400 on a reserved character is §8's 409, shown under the field                                     |
| `GET /api/jira/projects`                | Jira's full project list (`project/search`, paged), fetched when the Setup page opens — never on the poll — for the Repositories select            |
| `GET /api/jira/jql/check?jql=`          | `jql/parse?validation=strict`, then `search/approximate-count`: the parse errors, else the count call's error (an unbounded query passes parse and is refused only there — P8), else the count — the sheet's check line |
| `GET /api/jira/prompt?key&action&repo`  | `text/plain`: exactly what Copy prompt copies, and what Start sends but for the status and assignee lines (§7); `action` is `execute`, `context` or `skill:<id>`                                        |

Writes (`application/json` + same origin via `SameOriginPostGuard`; 503 while unconfigured; 400 malformed; 409 when `jira.json` is unreadable):

| route                            | body                                  | effect                                                                                       |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/jira/boards`          | a `JiraBoard` (no id → create)        | upsert; roots validated by `isJiraKey`; the poller is re-aimed                               |
| `POST /api/jira/boards/delete`   | `{ id }`                              | delete (unknown id → 404); the browser whose pick it was falls to the first board by name                               |
| `POST /api/jira/repos`           | `{ project, paths[] }`                | replaces one project's list; each path absolute (existence is not checked — under `docker:up` only `BM_PROJECT_ROOT` is mounted, so the server cannot see every path the dashboard can); stored with `~` expanded and a trailing slash removed, so it compares raw against the dashboard's list, and shown with `$HOME` as `~`       |
| `POST /api/jira/skills`          | a `JiraSkill` (no id → create)        | upsert; `name` and `prompt` non-empty                                                        |
| `POST /api/jira/skills/delete`   | `{ id }`                              | delete                                                                                       |
| `POST /api/jira/issue/assign`    | `{ key }`                             | `PUT issue/{key}/assignee { accountId: me }`; then the splice of §8                          |
| `POST /api/jira/issue/transition`| `{ key, transitionId }`               | re-reads the offered transitions, 400 for an id not offered, else `POST issue/{key}/transitions`; then the splice |

Validation, per route, on the server: a board has a trimmed `name` of 1–80 characters, an `interval` in `SYNC_INTERVALS`, at most 20 roots each passing
`isJiraKey`, at most 10 queries each with a trimmed `label` of 1–80 and a `jql` of 1–2 000 characters, and at least one root or query; ids are server-minted
(`b_…`, `q_…`, `s_…`), a client-supplied id on create is ignored, and an upsert naming an id the file does not hold is a 404. A repos write names a project
key matching `^[A-Z][A-Z0-9_]+$` and at most 10 absolute, deduplicated paths; an empty list removes the key. A skill has a trimmed `name` of 1–60 and a
`prompt` of 1–2 000 characters. Anything else is a 400 naming the field.

In `agents/` (behind the agents guard, like every agents POST):

| route                          | body                 | effect                                                                                                                                        |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/agents/dispatch-jira` | `JiraDispatchRequest` | 400 for a repo not in the key's project map or an unknown skill id; `projectDispatchGate(status, repo)` decides 409/502 exactly as `dispatch` does; 409 for a live session on the key; then assign → transition → spawn (§7) |
| `POST /api/agents/jira-stop`   | `{ key }`            | `POST <dashboard>/api/sessions/<id>/stop` through the same call `ItemsAbortService.stopSession` makes today (hoisted to `agents/session-stop.util.ts` so both use one, its claim-specific error tail becoming a parameter); 200 or the dashboard's "no live session" 404 both clear the live entry; a key not in the map, or a `starting` entry with no session yet, is a 409; Jira untouched |

The `/api/trackers` payload and the nine item write routes are untouched.

## 6. Client

### 6.1 Rail and pages

- `jira` joins `SECTIONS` between `archive` and `settings`; `RAIL_LABEL.jira = 'Jira'`. The rail draws the entry only while `GET /api/jira` says
  `configured`. `resolveSection` accepts `jira` like any section (it runs in a `useState` initializer, before `/api/jira` has answered), the shell holds it
  while the status is unknown (a status read that fails leaves the section drawn in the Board's own `unavailable` shape), and the first status that says `configured: false` moves the shell to `board`. Settings › Local offers `Opens on: Jira` only
  while the status says configured; a stored `jira` landing on a machine that later lost its credentials takes the same fall to `board`.
- Two pages, **Board** and **Setup**, switched by the rail's sub-nav tree ALONE — the Runs/Settings rule. `lib/jira-page.ts` holds `JIRA_PAGES`, the storage
  key and `isJiraPage`; `hooks/useJiraPage.ts` is the module store (`useRunsMode`'s shape, for the same two-readers reason). No in-page control restates
  that choice, at any width; `Open board` on Setup and the empty board's chip to Setup are the rail's own navigation threaded down through `App`
  (`onOpenJiraPage`), exactly as Settings' `Live view` link is `onOpenWatchdog` — a link that means the same thing as the tree entry by construction, not a
  second control.
- `JiraProvider` (over `useJira`, `useTrackers`'s shape: one fetch of `GET /api/jira` on mount and focus, a timer aimed at the soonest board's next poll with a
  15 s floor, only the newest read may write) sits beside `TrackersProvider` in `App`, so the chip, the rail and both pages read one answer on one clock.
  `useJiraBoard(id)` polls `boards/:id/issues` through `useCoalescedFetch` at `BOARD_TRACKER_POLL_MS` while the Board page is mounted and the board's
  interval is not `off`. Every write (assign, transition, Start, Stop) and every Setup save reloads both the board and `GET /api/jira` at once, whatever the
  interval, so an `off` board shows the splice too. The browser never talks to Jira.
- `lib/jira.ts` is the ONE home of every derivation: category → column, card age, crumb text, `runChipState` (`no-repo | live | ready`; `ready` needs one mapped path — the sheet evaluates `projectDispatchGate(status, path)` per path for
  whether Start can draw, disabling Start with the gate's reason for a `disabled` gate as `DispatchButton` does and hiding it for a `hidden` one), the Band's
  summary line, `resolveJiraAction`, and the CALLS reading (the track is `calls / JIRA_SWEEP_CALL_CEILING`, a 100-call constant past which the meter reads
  full — a reading, not a limit — red when a 429 landed in the last 15 min). The Done window is not derived here: the server drops those issues before they
  are served.

### 6.2 Jira › Board — `BoardB.html`

- `Band`: title = board name; sub = `<site> · N issues from R roots and Q queries · polled Xs ago`, red with Jira's message when a query or root failed in the
  last sweep, and `first 500 shown` when truncated; counts read `1 query` / `2 queries` and a zero is omitted. Right slot: the picker `Chip` (a `Popover` listing boards — pick only) and the summary search.
- `FilterBar` with three `FilterSection`s: type, assignee (anyone / me / unassigned), sprint — derived from the loaded list, per browser, not persisted.
- Three `BoardColumn`s (`BoardColumnSlug` widened with `todo | doing | done`, plain dot), flat `JiraCard`s sorted by `updated` descending. A card: type icon,
  key, crumb — in precedence: `root` for one of the board's roots, else `↳ PAY-120 Refund flows` for a parent, else `Assigned to me`, else nothing; title; the assignee's initials and name (initials, never Jira's `avatarUrls` — an image would be a browser request to Atlassian), the RAW status name as a
  pill, the age of `updated` (of `resolved` on a Done card that has one); a marker row
  with priority, `N subtasks` (`1 subtask`, nothing at zero), and `Run ▾`. A card with a live session carries the `board-card-live hatch` strip: `session · <repo basename>` and the elapsed
  reading. Empty states: no boards → `No boards yet` with a chip to Setup; a board with no issues → its three empty columns.
- Below 700 px the columns stack as the Board's do; the chip moves into the rail bar as the tracker chip does.

### 6.3 The issue modal — `IssueModal.html`

`JiraIssueModal` on `ui/Modal` (the §8.7 sidecar: facts column, body). Facts: key with `open in Jira ↗`, type · parent, status with its category, priority ·
sprint, assignee · reporter, labels, created · updated, on boards, repository (from the project map, or the no-repo hint), session. Controls under the facts:
`Assign to me` (disabled with a title when already me, or while `me` is null), `Move to…` (a `Select` over the transitions Jira offers this issue now, applied on pick), `Run ▾`,
and `Stop session` through `ui/Confirm`, drawn only while agents are enabled (there is no session to reach otherwise). Body: the description as Markdown through `lib/markdown.ts` (the sanitising `marked` config hoisted out of
`ItemModal`, which switches to the same function — one of this design's few touches to existing code, beside the `Fact` hoist, the `SettingsRow` promotion, the `stopSession` hoist and the two
widenings of `SECTIONS` and `BoardColumnSlug`), a Subtasks list, and the line "Comments stay in Jira — v1
neither reads nor writes them" with the link. `Fact` is hoisted to `ui/Fact.tsx` for the same one-home reason. The detail is fetched on open; a write's
Jira error is shown inline under the controls and the modal stays open.

### 6.4 Jira › Setup — `Setup.html`, `BoardSheet.html`, `NewBoard.html`, `BoardsTen.html`

Four cards composed from `SettingsGroup` / `SettingsRow`, promoted to `components/ui/` because a second surface now draws them:

- **Boards** — rows always, sorted by name with `off` boards last: name, `R roots · Q queries · N issues · every <interval> · polled <age>` — zero counts omitted as in the Band, an `off` board reading `sync off · last
  polled <age>` in place of the interval, and the failure in red when the last sweep had one, `Open board` (switches the Jira page to Board with this board picked) and `Edit`; a `New board` chip in the head; a filter field from the sixth
  board. One `JiraBoardSheet` (`FormSheet`) serves new and edit: **Name & sync** (name, interval as a `Segmented` over `SYNC_INTERVALS`, default `1m`);
  **Roots** (rows with ×, a search field whose `Popover` lists `/api/jira/search` results); **Queries** (preset chips `+ Assigned to me`, `+ Open in current
  sprint`, `+ Unresolved in a project…`, `+ Custom JQL` add rows; a row is label + JQL textarea + the check line from `/api/jira/jql/check`, debounced 500 ms:
  `4 issues match · checked 3 s ago`, or Jira's parse error in red); footer `Delete board` (edit only, through `Confirm`) / `Cancel` / `Save` (`Create board`
  disabled until a name and at least one root or query).
- **Repositories** — one row per mapped path (`PAY · Payments`, the path, ×), a warning row for a project that has issues on some board and no path (`no repository yet — PAY cards cannot Start until a path is mapped`), and an add row: project `Select` from `/api/jira/projects`, path field, `Add`. The hint states the dashboard rule: a path the dashboard
  cannot see is refused at dispatch, not here.
- **Connection** — read-only rows off `GET /api/jira`: site, signed in as (name from `myself`, never the email), the token kind (`classic` or `scoped`, as `identity.ts` found it; a scoped token needs `read:jira-work`, `write:jira-work` and `read:jira-user`, and the row's
  hint says so — both kinds are called through the gateway, §3), last sweep (`every 15 s` while the ticker is armed, `idle` otherwise, then `· N calls · last 429 <age>` or `· no 429 since start`). `restart the server to change it`.
- **Skills** (phase 5) — the two built-ins as locked rows, one row per skill (name, the template in mono, ×), an add row (name + template + `Add`), and the
  placeholder hint. A skill has to exist in the repo or the Claude install; this list only names it.

### 6.5 Shell chip and Settings — `Trackers.html`

`JiraChip` beside `TrackerChip`, on the same `.tracker-chip*` classes: initial, `Jira · <name>`, `POLL` (soonest board, `pollProgress`) and `CALLS` meters,
a red pip when `access` is not `ok`. Its popover is a reading — site, per-board lines, calls, last 429 — with no links or buttons (the rail rule). Settings ›
Shared › Trackers gains one read-only Jira row (`<site> · N boards · intervals live on Jira › Setup`); Settings › Local › Dispatch gains `Jira default action`.

## 7. Run ▾ and dispatch — `RunMenu.html`, `Dispatch.html`

- The chip draws on every card and in the modal. `no-repo` → dashed with the title `no repository mapped for OPS — Jira › Setup › Repositories`; `live` →
  disabled with the title; otherwise it opens the menu: the two built-ins, a rule, this machine's skills, a note. **Run ▾ is never hidden for the dashboard's
  sake**: with agents off or the dashboard unreachable the sheet draws Copy prompt alone and hides Start. This is the one deliberate departure from "an
  environment-level block hides the dispatch control", and the reason is that Copy prompt is a second exit the Board's control never had.
- `JiraLaunchSheet` (`FormSheet`): **Action** (`Select`, seeded from `jiraDefaultAction` or the menu pick); the **prompt preview** (`GET /api/jira/prompt`,
  re-fetched when the action or repository changes, in a read-only `.sheet-prompt`; its status and assignee lines are the ticket as it is now, and Start's
  own prompt is composed after its writes, so those two lines are the one thing that can differ); **Repository** (the project's mapped paths, preselected when there is
  one); **Assign to me** (`Switch`, off and disabled when already me or while `me` is null); **Move to** (`Select` over the offered transitions, default `leave as is`); **Model ·
  effort** (seeded from Settings, never the last launch); **Permissions** (`modesUpTo` the dashboard's ceiling, defaulting to `acceptEdits` for `execute` and a skill, `plan` for `context`); **Remote control**. Footer: **Copy prompt**
  (`navigator.clipboard.writeText`; the chip reads `Copied` for 2 s; the preview is selectable text as the fallback where the clipboard API is unavailable)
  and **Start**.
- **Start, server side, in this order**: assign (if asked) → transition (if asked) → spawn through the dashboard in the chosen repository, session name `jira
  <KEY>` (`sessionName`'s 60-char rule). Before the first write the request is checked whole: 400 for a bad body, an unmapped repo, an unknown skill or a transition not offered (a fresh
  read — a workflow whose offered transitions depend on the assignee can refuse a pairing the sheet could not offer; v1 accepts that, and the person
  assigns first and moves from the modal); the dashboard gate's 409/502; 409 for a key already live or starting; a prompt over the cap. Then each Jira write maps as §8's errors line does
  (401 → 503, 429 → 503 with the retry instant, 403 → 502 `Jira refused: <message>`, network → 502), the answer names the step, and an earlier write stands
  — an assign that landed before a failed transition is not undone. A spawn that fails after the writes is a 502 whose text says the writes stand; the sheet
  keeps Copy prompt so the work can still start in a terminal. On success the live map gets the key, the result carries
  `session`, the sheet shows `sessionUrl(linkBase, sessionId)`, and the client reloads `GET /api/jira` at once — the status poll alone runs on the boards' own
  clock and not at all while no board syncs — so the strip appears without waiting; a Stop reloads the same way.
- **Stop session**: `Confirm` → `POST /api/agents/jira-stop`. The dashboard session is stopped; Jira is not touched — the ticket keeps its assignee and
  status, which is right because the person is still on it.

## 8. Writes and ADF

- **Assign**: `PUT issue/{key}/assignee` with the identity's `accountId`; while `me` is null the assign route and `dispatch-jira`'s assign answer 503
  `no identity` and never send the call, because Jira reads `{ accountId: null }` as unassign. **Transition**: a fresh `GET issue/{key}/transitions`; an id not in the answer is a
  400 (`transition not offered`); else `POST issue/{key}/transitions`. After either, the server does `GET issue/{key}` and **splices** the mapped issue into
  every board cache holding the key, so the board reflects the change on the next client poll rather than the next sweep. Newest `updated` wins: a sweep
  that lands afterwards (one already in flight, or a search index that still lags the write — P2) never replaces a cached issue whose `updated` is newer
  than the one it brought.
- **ADF → Markdown** on the server, read side only: paragraph, heading, bulletList/orderedList/listItem, codeBlock (with language), inlineCode, strong, em,
  strike, link, inlineCard → a link to its url, hardBreak, rule, blockquote, mention → `@name`, date and status → their text, emoji → its shortname, taskList/taskItem →
  `- [ ]` / `- [x]` lines (P10 found them on real descriptions); text
  nodes have Markdown's specials escaped, so a literal `snake_case_name` or `*` renders as written. Everything else becomes a one-line
  placeholder — `[attachment: name]`, `[table omitted]`, `[panel omitted]`, `[expand omitted]` — and a description that had any is followed by `open in Jira ↗`.
  An unknown node renders its text content.
- **Errors**, one mapping for every Jira call the server makes: 401 → `access: unauthorized`, the chip and the Connection row red, every ISSUE write (assign,
  transition, the two inside Start) a 503 until the next successful `myself` — config writes (boards, repos, skills) touch only `jira.json` and stay open;
  403 → 502 with `Jira refused: <message>`, shown inline in the modal; 429 → the sweep pauses until `Retry-After` (60 s when the header is absent) and an issue write — or the detail read — inside that window is
  refused up front with a 503 carrying the retry instant, not sent to be refused again; network or timeout → 502; a Jira 400 on a write (`user not
  assignable`, a transition that needs a screen) → 409 `Jira refused: <message>`, a state in Jira the reader can change; 404 → 404 `issue not found`; any
  other 5xx → 502 `Jira answered <status>`. The same mapping serves the read routes: a detail read that fails leaves the modal open on the card's own
  facts with `could not read the ticket — <message>` where the body would be, and `jira.mjs`'s exit `2` covers every 4xx of this mapping.

## 9. The `jira` skill — `skills/jira/`

- `SKILL.md` + `tools/jira.mjs` with `show <key>` (the ticket block, verbatim from `GET /api/jira/issue/:key?format=text`), `transitions <key>`,
  `transition <key> <name|id>`, `assign <key>`, `status`. Every subcommand goes through `/api/jira` on `http://127.0.0.1:${BM_API_PORT:-4322}` (the one port setting the skills already dial)
  — never Jira directly — so the token stays in the server process and the server stays the one caller. Stack down → exit `5` with the two start commands
  named, the contract `backlog.mjs` has in a tracker project; a refusal the server answers with a 4xx (not offered, unknown key) → exit `2` with the message;
  a 5xx (unconfigured, unauthorized, rate-limited, Jira unreachable, a write Jira refused) → exit `3` with the message; usage → exit `1`.
- The built-in `execute` text (`Work it end to end` in the menu) says: branch, implement, verify, then — when `jira.mjs transitions` offers exactly one transition whose target category is `done` — move the
  issue through it, and otherwise leave the status alone and say so in the report; then the same
  commit rule item dispatch carries (stage only what the session changed, never `git add -A`, do not push); `context` (`Open with the ticket loaded`) says:
  read the ticket and wait. Those are the built-ins' own texts; the WHOLE prompt, built-in or custom, ends with the ticket block the server appends.
- `process.exitCode = main(...)`; `tools/jira.test.mjs` beside the tool (the node runner's globs do not descend); publish is commit → push → `pnpm run
  plugin:sync`; `agents/` is untouched; `.claude-plugin/plugin.json`'s description names the seventh skill.

## 10. Security

- The token and the email live in `.env` and nowhere else; `JiraStatusPayload` carries `site`, `me.name` and `me.accountId`, never either. No route returns
  the token; the browser never talks to Jira; `jira.mjs` goes through the server.
- `BM_JIRA_SITE` is a hostname (`acme.atlassian.net`) — no scheme, path or query; anything else is `configured: false` with the reason in `detail`, like an absent key. The
  server always speaks `https://` to it. Jira Cloud only: `GET /rest/api/3/serverInfo` is asked once at boot beside `myself`, and a `deploymentType` other
  than `Cloud` (or a 404 there) sets `access: unsupported` with `detail: Jira Server/DC is not supported`.
- Every `:key`, every root and every search-by-key passes `isJiraKey` (`^[A-Z][A-Z0-9_]+-\d+$`); every value the server itself puts into JQL — a key
  (`key = "PAY-1"`) or the search term — is double-quoted with `\` and `"` escaped. A person's JQL is passed verbatim for Jira to parse — the server never
  edits it.
- Reads sit behind the global Host allowlist (`applySecurityMiddleware`); writes add `SameOriginPostGuard`; `dispatch-jira` and `jira-stop` sit under the
  agents guard like every agents POST. The prompt is composed server-side, as orchestrate's is (the existing invariant widened to "the orchestrate and Jira spawn prompts" — item dispatch
  takes the sheet's edited prompt and stays as it is). Repository paths must be
  absolute; the dashboard must list them at dispatch (409 otherwise — the Board's own rule, and the only existence check, because the server container sees
  only `BM_PROJECT_ROOT`). `/browse/` links are built server-side from the
  validated site. The CSP is untouched: no new inline script.
- The client polls the server only; the sweep caps (200 per query and per root, 500 per board, depth 3) and the 429 back-off bound what the server asks of
  Jira.

## 11. Testing

- **jest** (flat in `test/`): `jira-config` (per-part fallbacks, atomic write, unreadable → 409 through supertest), `jira-map-issue` (category, level, sprint
  discovery and the active-sprint pick, the Done window relative to the clock: done with a resolution, done without one, not-done with a stale resolution), `jira-adf` (one fixture per node, placeholders, unknown nodes), `jira-poller` (a fake client: dedupe, depth and size caps, due intervals, armed/idle/off and the boot calls keeping it armed, identity retry and
  back-off, `serverInfo` → `unsupported`, 429 back-off, a `failures` entry per failed root or query with the last good list kept, the splice after a write
  and newest-`updated`-wins), `jira-routes` (supertest through `listenLoopback`: 503
  unconfigured, Host gate, the guard, key validation, transition not offered → 400, `?format=text`, search trimming and escaping and the reserved-character 409), `jira-prompt` (placeholders, the block, the 4 000 cut and the children cap, 400 when nothing fits, the data framing against a description holding a
  longer backtick run than three and a ticket carrying the marker text, the description-once rule),
  `agents-dispatch-jira` (unmapped repo 400, dashboard-blind 409, live and starting 409, the length check before any write, write-then-spawn order, a
  failed transition after a landed assign, spawn failure keeps the writes, the reservation released on failure), `agents-jira-stop` (200 and the 404 both
  clear the entry, a `starting` or unknown key 409, agents off), `agents-jira-live` (an `idle` session dropped, `working` and `question` kept, `starting`
  and sub-2-min entries untouched, an unreadable list leaving the map alone), `use-jira` (the timer aimed at the soonest board, none while every board is off, the reload after Start and Stop), `jira-lib`
  (jsdom: column, `runChipState`, `resolveJiraAction`, the CALLS reading), `jira-sections` (no rail entry while unconfigured, the tree switches the page),
  `jira-board` / `jira-modal` / `jira-setup` (render suites in the style of `tracker-board` and `settings-trackers`), and `claude-rules` picks up the new rule
  file by itself. `test/helpers/jira.ts` is an in-memory Jira over the dozen endpoints this touches, the shape `test/helpers/github.ts` has.
- **node** (`test:skills`): `skills/jira/tools/jira.test.mjs` against a stub server — every subcommand, exit `5`, exit `2`, the exitCode idiom.
- Phase 0 is a hand-run probe (§14), not a suite; its answers are written into this spec before phase 1's plan is written.

## 12. Phases — one plan and one PR each

0. **Probe** — verify the API facts in §14 against a real site; amend this spec.
1. **Server read** — client, config reader, poller, map, ADF, identity, block, the read routes, `GET /api/jira`; `.env.example` and the compose
   passthrough of the three keys (as `BM_GITHUB_TOKEN` has); `docs/subsystems/jira.md`; `.claude/rules/jira.md` with the rules this phase builds: the
   `jira.json` reader half, the token (its `jira.mjs` half waits for phase 4), the JQL quoting, the Done window, and the widened cache-age and
   outbound-modules lines of §13.
2. **Jira section** — rail entry and tree, `JiraProvider`, Board page, read-only modal (the `Fact` and `marked` hoists land here), Setup with the board
   sheet, Repositories and Connection — so the boards and repos write routes and the `jira.json` writers land here — the chip, the Trackers row; the section-and-tree
   rule of §13 (the Run ▾ rule waits for phase 5); DESIGN.md gains §8.9 for the Jira surfaces (every component cites its subsection), and §8.7's composer count and its two "only modal" / "not by two" sentences, `board.md`'s Escape
   bullet, `invariants.md`'s Escape section and `test/dialog-count-docs.test.ts` move from three composers to five (the issue modal and the board sheet).
3. **Writes** — assign and transition routes, the modal controls, the splice; the write rule of §13.
4. **Skill** — `skills/jira`, `?format=text`, docs, publish; the widened exit-5 bullet and the token rule's `jira.mjs` half.
5. **Run** — Skills card and its two routes, `jiraDefaultAction`, the menu, the launch sheet, the prompt route, `dispatch-jira`, `jira-stop`, the live map, its agents-side
   reconciler and the strip; the Run ▾ rule, the live-map rule, the dispatch and spawn-prompt widenings of §13; the composer count moves to six (the launch sheet).

Every phase lands its own docs (CLAUDE.md line, rule bullets, invariants anchors, `docs/subsystems/*`) with the mechanism it introduces, so
`test/claude-rules.test.ts` and `/docs-sync` stay green at every merge.

## 13. Invariants this design adds — headline, mechanism home, reasoning anchor

Each gets its headline in CLAUDE.md, its mechanism bullet in the named `.claude/rules/` file, and a section in `docs/subsystems/invariants.md`; the
claude-rules suite enforces that all three exist and agree.

| headline                                                                                                                                    | rules file     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `~/.backlog-manager/settings/jira.json` has exactly one writer, the server, and a file that cannot be read is never replaced.                 | `jira.md` (new, `paths: ["server/src/jira/**", "skills/jira/**"]` — the tenth rule file; CLAUDE.md's count follows) |
| The Jira token never leaves the server: the browser and `jira.mjs` both go through `/api/jira`, and the poller is armed only while a board syncs. | `jira.md`  |
| The board's Jira writes are assign and transition, nothing else; each re-reads the issue and splices it into every board cache holding the key. | `jira.md`  |
| Jira's Done column is a window, not a store: a done issue whose resolution — or, lacking one, whose last update — is older than 14 days is dropped at map time.                                 | `jira.md`      |
| Every value the server puts into JQL — a key or the search term — is quoted and escaped, and a person's JQL is passed verbatim for Jira to parse.                     | `jira.md`      |
| A Jira session is remembered in server memory only; a restart forgets it, and Stop is the one hand that clears it early.                     | `jira.md`      |
| The Jira section's two pages are switched by the rail's tree, or a link threaded down from it, never by an in-page control; the section is drawn only when `GET /api/jira` says configured.      | `board.md`     |
| Run ▾ on a Jira card is never hidden for the dashboard's sake: Copy prompt is its second exit, and only Start hides.                          | `board.md`     |

Widened, not added: "`backlog.mjs` in a tracker project needs the stack up, and says so with exit `5`" gains `jira.mjs` (always) in the same bullet;
"The orchestrate spawn prompt is composed server-side" becomes "the orchestrate and Jira spawn prompts" (item dispatch still takes the sheet's prompt);
"Dispatch derives the action; it never accepts one" gains its Jira clause — a Jira issue has no file state to derive from, so `dispatch-jira`'s `action` is a
PICK from a closed set (the two built-ins and the skills in `jira.json`), validated on the server and refused with a 400 otherwise; the CLAUDE.md layout line names `jira/` as the third outbound module; "The tracker cache is the one cache in this server whose age is a rendered value"
becomes "the tracker and Jira caches are the two"; "An environment-level block hides the dispatch control; the per-item ones disable it" and `board.md`'s
"with `BM_AGENTS` off the board shows no dispatch buttons" gain "on the Board", the Jira card's Run ▾ being the stated exception; "A TRACKER project's items
are the one thing this server writes" gains "and a Jira issue's assignee and status"; and the two sentences saying `agents/` and `tracker/` are the only
outbound modules — in `docs/subsystems/invariants.md`'s item-write-routes section and under `docs/subsystems/api.md`'s `tracker/` heading — are edited in
phase 1.

## 14. Phase-0 probe — the facts this spec assumes and has not verified

Run on 2026-10-16 with a read-only scratch probe (`node`, Basic auth from `.env`) against `timify.atlassian.net` with a **scoped** token; the writes (P6's POST, P7) run only
against a ticket the user names. A finding that changed the spec is applied in §3, §5, §6 or §8 and cites the row's number there.

| #   | assumption                                                                                                                  | finding |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| P1  | `GET /rest/api/3/myself` with Basic `email:token` returns `accountId` and `displayName` for a classic (unscoped) API token against `https://<site>`; whether a scoped token answers there at all, or only through `api.atlassian.com/ex/jira/<cloudId>` | **scoped token: 401 at `https://<site>`** (`Client must be authenticated to access this resource.`), 200 on `api.atlassian.com/ex/jira/<cloudId>`; `myself` carries `accountId`, `displayName`, `emailAddress`, `avatarUrls`, `accountType`, `timeZone`. Classic token not probed (none available) — Atlassian documents it as answering on both bases. → §3 client and identity, §6 Connection, P14 |
| P2  | `POST /rest/api/3/search/jql` takes `{ jql, fields, maxResults, nextPageToken }` and answers `issues[]`, `nextPageToken`, `isLast`; whether a search run right after an assign or transition can still return the old issue (the index lags the write) | shape confirmed: `issues[]`, `nextPageToken` (a string, present only while `isLast: false`), no `total`; `maxResults: 200` accepted. **Unbounded JQL is a 400** (`Unbounded JQL queries are not allowed here. Please add a search restriction to your query.`) — `order by` alone counts as unbounded; every v1 query is bounded (`key =`, `parent in`, a project or sprint clause). Index lag after a write: not probed (write) |
| P3  | `parent in (K1, K2)` follows epic → story → subtask on both company-managed and team-managed projects; `issuetype.hierarchyLevel` is present         | `parent in (…)` from an epic (`hierarchyLevel: 1`) returned 10 level-0 children and 0 grandchildren on a company-managed project; team-managed not probed (none on this site). `hierarchyLevel` is on every type: epic 1, standard 0, subtask −1 — and oddly named subtask types (`Project`, `Testing`, `Story Bug`) are level −1, so the level, never the name, decides. An unknown key (`key = "ZZZZ-999999"`) is **200 with no issues**, not a 400. → §3 roots |
| P4  | the sprint field is discoverable from `GET /rest/api/3/field` by `schema.custom = com.pyxis.greenhopper.jira:gh-sprint`; its value shape in a search  | `GET field` (223 fields) has exactly one `gh-sprint` field (`customfield_10020`, `Sprint`); in a search it is an array of `{ id, name, state, boardId, goal, startDate, endDate }` with `state: active | closed | future`. `parent.fields` carries `summary`, `status`, `priority`, `issuetype` |
| P5  | `status.statusCategory.key` is `new`, `indeterminate` or `done`, and whether `undefined` ever appears on a real status                                | `GET statuscategory` lists four keys — `undefined`, `new`, `indeterminate`, `done` — so `undefined` exists (id 1) as assumed; §4's mapping to `new` stands |
| P6  | `GET issue/{key}/transitions` shape; `POST issue/{key}/transitions { transition: { id } }` → 204; the error shape when a transition needs a screen     | GET shape: `transitions[]` of `{ id, name, to { id, name, statusCategory }, hasScreen, isGlobal, isInitial, isAvailable, isConditional, isLooped }` — 5 offered on the sampled issue, all `isAvailable: true`, `hasScreen: false`. The POST and the screen error: not probed (write) |
| P7  | `PUT issue/{key}/assignee { accountId }` → 204                                                                                                       | not probed (write) — `write:jira-work` ("create and edit issues") is the scope that covers it, and the token has it |
| P8  | `POST /rest/api/3/jql/parse?validation=strict { queries }` returns per-query errors; `POST /rest/api/3/search/approximate-count { jql }` returns `count` | both 200 as assumed: parse answers `queries[].errors[]` strings (`Field 'sprnt' does not exist or you do not have permission to view it.`) but **passes an unbounded query**; `approximate-count` answers `{ count }` and is the call that refuses unbounded JQL (400, P2's message). → §5 check route |
| P9  | a 429 carries `Retry-After` in seconds; whether `X-RateLimit-*` headers exist                                                                        | no 429 met. Every normal answer carries `x-ratelimit-limit`, `x-ratelimit-remaining`, `ratelimit`, `ratelimit-policy`; the client keeps counting its own calls for the CALLS meter (the headers are per gateway bucket, not per sweep) and reads only `Retry-After` on a 429 — unverified, the 60 s default stands |
| P10 | the ADF node inventory on a real description: media, mention, table, panel, expand, emoji, inlineCard, date, status                                  | over 10 descriptions: `doc, paragraph, text, heading, bulletList, orderedList, listItem, codeBlock, panel, table, tableRow, tableHeader, tableCell, taskList, taskItem, media, mediaSingle, mention, emoji, inlineCard, rule`; marks `strong, em, code, link, underline`. No `expand`, `date` or `status` seen. A description is an ADF object, never a string. → §8 taskList |
| P11 | `GET /rest/api/3/project/search` lists the projects the token sees, with paging                                                                     | 200, paged: `values[]`, `isLast`, `nextPage` (a URL), `startAt`, `maxResults`, `total` (8 here) — the route follows `nextPage` until `isLast` |
| P12 | answered from code, no probe needed: `POST /api/sessions/<id>/stop` answers 404 `no live session` for a gone session (`items-abort.service.ts`), and `GET /api/sessions` carries each session's status (`dashboardSessionStatus`, `agents.service.ts`) — §3 reconciles the live map against it | known |
| P13 | `GET /rest/api/3/serverInfo` answers `deploymentType: "Cloud"` on a Cloud site, and is absent or says otherwise on Server/DC                       | `deploymentType: "Cloud"`, `version: 1001.0.0-SNAPSHOT`; Server/DC not probed |
| P14 | (found, not assumed) the token kind decides the base URL                                                                   | scoped token → gateway only; cloudId from `GET https://<site>/_edge/tenant_info` (200, unauthenticated, `{ cloudId }`). → §3 client, §6 Connection |

## 15. Out of scope, and what comes after

- Comments (reading or writing), attachments, worklogs, creating issues, editing descriptions — nothing in v1 writes text to Jira.
- Jira Server / Data Center (REST v2, different auth), more than one site, OAuth.
- Jira's own agile boards and sprint management; this design tracks issues, not boards.
- Approach C — extracting a generic tracker platform under both the GitHub tracker and this module (shared chip, shared poller schedule, shared sync config)
  — is the right second step once two concrete implementations exist to generalise from. The four text-input class families the audit found are drift of the
  same kind and are also left alone.
- The existing tracker spec's "Timify rule" note (`2026-09-17-tracker-backed-backlog-design.md` §10) predates this design: Jira is generic now.
