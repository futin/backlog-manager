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

## 2. Scopes — what lives where

- **Per browser** (`client/src/lib/settings.ts`, clamped like every other key): the picked board id (`backlog-manager.jira-board`, `usePersistedState`), the
  Jira page (`backlog-manager.jira-page`, a module store like `useRunsMode`), and `jiraDefaultAction` on Settings › Local › Dispatch — `execute`, `context`
  or a skill id, seeding the launch sheet's Action and never the last launch. `clampSettings` keeps it a non-empty string; which ids exist is only known where
  the skills list is, so `resolveJiraAction(setting, skills)` in `lib/jira.ts` is what falls back to `execute`.
- **Per machine**: `.env` holds the three credentials. `~/.backlog-manager/settings/jira.json` (`BM_JIRA_FILE` overrides) holds `{ boards, repos, skills }`
  — the **fourth file this server writes**, after `watchdog.json`, the control files and `tracker-sync.json`, and it follows `tracker-sync.json`'s contract to
  the letter: read fresh per use, each malformed part falls back on its own, the write is temp-file-plus-rename of the WHOLE file, and a file that exists but
  cannot be read or parsed is refused (409) and left alone. The server is its only writer, through the guarded POSTs in §5.
- **Per project: nothing.** No marker, no registry entry. A mapped repository is a path in `jira.json` and never enters `registry.json`; a Jira board has no
  `backlog/` and no `source.json`. This is the one thing that keeps A a parallel subsystem rather than a third source.

## 3. Server — `server/src/jira/`, the third outbound-calling module

`tracker/` and `agents/` are today the ONLY two modules that call out; `jira/` becomes the third, and the CLAUDE.md layout line says so.

- `jira.client.ts` — one `fetch` wrapper: Basic auth from the env, `https://<site>/rest/api/3/…`, JSON in and out, `AbortSignal.timeout`. Maps 401 →
  `unauthorized`, 403 → `forbidden`, 429 → `rate-limited` carrying the `Retry-After` instant, network/timeout → `unreachable`. Counts calls per sweep and
  stamps the last 429, for the chip.
- `config.util.ts` — `readJiraConfig()` / `writeJiraConfig(next)` over `jira.json`, plus `JiraConfigUnreadableError`. Ids are server-minted (`b_<8 hex>`,
  `s_<8 hex>`); a board's or skill's identity is its id, never its name.
- `poller.service.ts` — one 15 s ticker, armed only while the site is configured AND some board's interval is not `off` (the GitHub poller's
  armed/idle/off rule). A board is due when `now − polledAt ≥ SYNC_INTERVALS[interval]`; the default interval is **`1m`**, not GitHub's `15s`, because a
  sweep is several calls deep. Per due board: each query runs through `POST search/jql` with a fixed field list, following `nextPageToken`, capped at
  **200** issues per query; roots are fetched with `key in (…)`, then their descendants with `parent in (…)` repeated to **depth 3** (epic → story → subtask),
  capped at 200 per root; results are deduplicated by key and the board is capped at **500** after dedupe, with `truncated: true` in its status. The cache is
  `Map<boardId, { issues, polledAt, access, detail, truncated }>`. Descriptions, children detail and transitions are never swept — they are read on modal open.
- `map-issue.ts` — Jira JSON → `JiraIssue`: `status.statusCategory.key` → the column, `issuetype.hierarchyLevel` → `type.level`, `issuetype.subtask`,
  `parent.key`, the sprint from the one custom field whose schema is `gh-sprint`, discovered once per boot from `GET field`. The **Done window** lives here:
  an issue whose `resolutiondate` is older than `JIRA_DONE_WINDOW_DAYS` (14) is dropped at map time, because a root's done children would otherwise pile up
  forever and a query author has JQL for the rest.
- `adf.ts` — Atlassian Document Format → Markdown, read side only. Nothing in v1 writes text to Jira, so there is no Markdown → ADF.
- `identity.ts` — `GET myself` once per boot (and again after a 401), giving `accountId` and `displayName`; assign-to-me uses the `accountId`.
- `block.ts` — the **ticket block**: facts, the Markdown description and the subtasks list as one text, the SAME text `jira.mjs show` prints and every Run
  prompt ends with. One renderer, two readers.
- `prompt.util.ts` — composes every Run prompt: a built-in's text (`execute`: branch, implement, verify, then move the issue with `jira.mjs transition`;
  `context`: load the ticket and wait), or a skill's template with `{key} {summary} {url} {repo} {description}` filled in, then the ticket block. Trimmed to
  the existing `PROMPT_MAX` (8 000) by cutting the description with a `[description truncated — open in Jira]` marker. One function, used by Start and by Copy
  prompt, so the preview is byte-for-byte what the session receives.
- `jira.controller.ts` (reads) and `jira-write.controller.ts` (writes, behind `SameOriginPostGuard`). Dispatch and stop stay in `agents/`, which already
  owns the dashboard calls; `AgentsModule` imports `JiraModule` (agents → jira, never back). `JiraService` owns the **live map** `key → { sessionId, name,
  repo, startedAt }`: memory only, capped at 100, entries expire after 8 h, and a Stop clears one early. A restart forgets it — a card then shows no strip,
  which is accepted for v1 (`DispatchRecordsService` makes the same trade for the same reason).

## 4. Shared shapes — `shared/types.ts`, all new, nothing existing changes

Shapes, not code: the implementer owns the exact TypeScript.

- `JiraStatusCategory` = `new | indeterminate | done`.
- `JiraIssue`: `key, id, url, summary, project { key, name }, type { name, level, subtask }, status { name, category }, priority | null,
  assignee { accountId, name } | null, reporter name | null, parent key | null, labels[], sprint | null, created, updated, resolved | null`.
- `JiraQuery`: `id, label, jql`. `JiraBoard`: `id, name, roots: key[], queries: JiraQuery[], interval: SyncInterval` (the existing type; `DEFAULT_JIRA_INTERVAL
  = '1m'`).
- `JiraSkill`: `id, name, prompt` (the template). `JiraAction` = `'execute' | 'context' | { skill: id }`.
- `JiraStatusPayload`: `configured, site, me { accountId, name } | null, access, detail, boards: (JiraBoard & { polledAt, count, access, detail, truncated })[],
  repos: Record<projectKey, path[]>, projects { key, name }[], skills: JiraSkill[], calls { sweep, last429At }, live: Record<key, { name, startedAt, repo }>`.
  `access` is one of `ok | unconfigured | unauthorized | forbidden | rate-limited | unreachable`.
- `JiraIssueDetail extends JiraIssue`: `description` (Markdown), `children: JiraIssue[]`, `transitions { id, name, to { name, category } }[]`,
  `boards: id[]` (which boards hold it), `session | null`.
- `JiraDispatchRequest`: `key, repo, action: JiraAction, assign: boolean, transitionId | null, model, effort, permissionMode, remoteControl`; the result is
  `AgentDispatchResult & { assigned: boolean, transitioned: string | null }`.

## 5. Routes — all under `/api/jira`, all behind the Host allowlist

Reads:

| route                                   | answers                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/jira`                         | `JiraStatusPayload`; `configured: false` when any of the three env vars is absent — the client draws nothing Jira then   |
| `GET /api/jira/boards/:id/issues`       | the board's cached list, with `polledAt`; 404 for an unknown board                                                      |
| `GET /api/jira/issue/:key`              | `JiraIssueDetail`, read fresh (issue, children, transitions); `?format=text` returns the ticket block as `text/plain`    |
| `GET /api/jira/search?q=`               | ≤ 20 issues for the roots picker: `key = Q` when `q` is a key, else `summary ~ "q*"`                                     |
| `GET /api/jira/projects`                | the projects the token can see, for the Repositories select                                                             |
| `GET /api/jira/jql/check?jql=`          | Jira's own parse errors, or the approximate count — the sheet's check line                                              |
| `GET /api/jira/prompt?key&action&repo`  | `text/plain`: exactly what Copy prompt copies and Start sends                                                            |

Writes (`application/json` + same origin via `SameOriginPostGuard`; 503 while unconfigured; 400 malformed; 409 when `jira.json` is unreadable):

| route                            | body                                  | effect                                                                                       |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/jira/boards`          | a `JiraBoard` (no id → create)        | upsert; roots validated by `isJiraKey`; the poller is re-aimed                               |
| `POST /api/jira/boards/delete`   | `{ id }`                              | delete; the browser whose pick it was falls to the first board                               |
| `POST /api/jira/repos`           | `{ project, paths[] }`                | replaces one project's list; each path absolute and an existing directory at save time       |
| `POST /api/jira/skills`          | a `JiraSkill` (no id → create)        | upsert; `name` and `prompt` non-empty                                                        |
| `POST /api/jira/skills/delete`   | `{ id }`                              | delete                                                                                       |
| `POST /api/jira/issue/assign`    | `{ key }`                             | `PUT issue/{key}/assignee { accountId: me }`; then the splice of §8                          |
| `POST /api/jira/issue/transition`| `{ key, transitionId }`               | re-reads the offered transitions, 400 for an id not offered, else `POST issue/{key}/transitions`; then the splice |

In `agents/` (behind the agents guard, like every agents POST):

| route                          | body                 | effect                                                                                                                                        |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/agents/dispatch-jira` | `JiraDispatchRequest` | 400 for a repo not in the key's project map or an unknown skill id; `projectDispatchGate(status, repo)` decides 409/502 exactly as `dispatch` does; 409 for a live session on the key; then assign → transition → spawn (§7) |
| `POST /api/agents/jira-stop`   | `{ key }`            | `POST <dashboard>/api/sessions/<id>/stop` through the same call `ItemsAbortService.stopSession` makes today (hoisted to `agents/session-stop.util.ts` so both use one); 200 or the dashboard's "no live session" 404 both clear the live entry; Jira untouched |

The `/api/trackers` payload and the nine item write routes are untouched.

## 6. Client

### 6.1 Rail and pages

- `jira` joins `SECTIONS` between `archive` and `settings`; `RAIL_LABEL.jira = 'Jira'`. The rail draws the entry only while `GET /api/jira` says
  `configured`; `resolveSection` treats `jira` as unrecognised (→ `board`) while it is not, so an `Opens on: Jira` preference cannot land on nothing.
- Two pages, **Board** and **Setup**, switched by the rail's sub-nav tree ALONE — the Runs/Settings rule. `lib/jira-page.ts` holds `JIRA_PAGES`, the storage
  key and `isJiraPage`; `hooks/useJiraPage.ts` is the module store (`useRunsMode`'s shape, for the same two-readers reason). No in-page control switches
  them, at any width.
- `JiraProvider` (over `useJira`, `useTrackers`'s shape: one fetch of `GET /api/jira` on mount and focus, a timer aimed at the soonest board's next poll with a
  15 s floor, only the newest read may write) sits beside `TrackersProvider` in `App`, so the chip, the rail and both pages read one answer on one clock.
  `useJiraBoard(id)` polls `boards/:id/issues` through `useCoalescedFetch` at `BOARD_TRACKER_POLL_MS` while the Board page is mounted and the board's
  interval is not `off`. The browser never talks to Jira.
- `lib/jira.ts` is the ONE home of every derivation: category → column, card age, crumb text, `runChipState` (`no-repo | live | ready`, composing
  `projectDispatchGate(status, repoPath)` for whether Start can draw), the Band's summary line, `resolveJiraAction`, the Done-window predicate for tests,
  the CALLS reading (`calls / 100` of the track, red when a 429 landed in the last 15 min).

### 6.2 Jira › Board — `BoardB.html`

- `Band`: title = board name; sub = `<site> · N issues from R roots and Q queries · polled Xs ago`, red with Jira's message when a query or root failed in the
  last sweep, and `showing 500 of more` when truncated. Right slot: the picker `Chip` (a `Popover` listing boards — pick only) and the summary search.
- `FilterBar` with three `FilterSection`s: type, assignee (anyone / me / unassigned), sprint — derived from the loaded list, per browser, not persisted.
- Three `BoardColumn`s (`BoardColumnSlug` widened with `todo | doing | done`, plain dot), flat `JiraCard`s sorted by `updated` descending. A card: type icon,
  key, crumb (`↳ PAY-120 Refund flows` for a parent, `Assigned to me`, or nothing); title; avatar + assignee, the RAW status name as a pill, age; a marker row
  with priority, `N subtasks`, and `Run ▾`. A card with a live session carries the `board-card-live hatch` strip: `session · <repo basename>` and the elapsed
  reading. Empty states: no boards → `No boards yet` with a chip to Setup; a board with no issues → its three empty columns.
- Below 700 px the columns stack as the Board's do; the chip moves into the rail bar as the tracker chip does.

### 6.3 The issue modal — `IssueModal.html`

`JiraIssueModal` on `ui/Modal` (the §8.7 sidecar: facts column, body). Facts: key with `open in Jira ↗`, type · parent, status with its category, priority ·
sprint, assignee · reporter, labels, created · updated, on boards, repository (from the project map, or the no-repo hint), session. Controls under the facts:
`Assign to me` (disabled with a title when already me), `Move to…` (a `Select` over the transitions Jira offers this issue now, applied on pick), `Run ▾`,
and `Stop session` through `ui/Confirm`. Body: the description as Markdown through `lib/markdown.ts` (the sanitising `marked` config hoisted out of
`ItemModal`, which switches to the same function — the one targeted improvement to existing code), a Subtasks list, and the line "Comments stay in Jira — v1
neither reads nor writes them" with the link. `Fact` is hoisted to `ui/Fact.tsx` for the same one-home reason. The detail is fetched on open; a write's
Jira error is shown inline under the controls and the modal stays open.

### 6.4 Jira › Setup — `Setup.html`, `BoardSheet.html`, `NewBoard.html`, `BoardsTen.html`

Four cards composed from `SettingsGroup` / `SettingsRow`, promoted to `components/ui/` because a second surface now draws them:

- **Boards** — rows always: name, `R roots · Q queries · N issues · every <interval> · polled <age>` (red with the failure when the last sweep failed; `sync
  off` pill), `Open board` (switches the Jira page to Board with this board picked) and `Edit`; a `New board` chip in the head; a filter field from the sixth
  board. One `JiraBoardSheet` (`FormSheet`) serves new and edit: **Name & sync** (name, interval as a `Segmented` over `SYNC_INTERVALS`, default `1m`);
  **Roots** (rows with ×, a search field whose `Popover` lists `/api/jira/search` results); **Queries** (preset chips `+ Assigned to me`, `+ Open in current
  sprint`, `+ Unresolved in a project…`, `+ Custom JQL` add rows; a row is label + JQL textarea + the check line from `/api/jira/jql/check`, debounced 500 ms:
  `4 issues match · checked 3 s ago`, or Jira's parse error in red); footer `Delete board` (edit only, through `Confirm`) / `Cancel` / `Save` (`Create board`
  disabled until a name and at least one root or query).
- **Repositories** — one row per mapped path (`PAY · Payments`, the path, ×), a warning row for a project with none (`no repository yet — PAY cards draw no
  dispatch control`), and an add row: project `Select` from `/api/jira/projects`, path field, `Add`. The hint states the dashboard rule: a path the dashboard
  cannot see is refused at dispatch, not here.
- **Connection** — read-only rows off `GET /api/jira`: site, signed in as (name from `myself`, never the email), token scopes required, last sweep (`every
  15 s · N calls · no 429 today`). `restart the server to change it`.
- **Skills** (phase 5) — the two built-ins as locked rows, one row per skill (name, the template in mono, ×), an add row (name + template + `Add`), and the
  placeholder hint. A skill has to exist in the repo or the Claude install; this list only names it.

### 6.5 Shell chip and Settings — `Trackers.html`

`JiraChip` beside `TrackerChip`, on the same `.tracker-chip*` classes: initial, `Jira · <name>`, `POLL` (soonest board, `pollProgress`) and `CALLS` meters,
a red pip when `access` is not `ok`. Its popover is a reading — site, per-board lines, calls, last 429 — with no links or buttons (the rail rule). Settings ›
Shared › Trackers gains one read-only Jira row; Settings › Local › Dispatch gains `Jira default action`.

## 7. Run ▾ and dispatch — `RunMenu.html`, `Dispatch.html`

- The chip draws on every card and in the modal. `no-repo` → dashed with the title `no repository mapped for OPS — Jira › Setup › Repositories`; `live` →
  disabled with the title; otherwise it opens the menu: the two built-ins, a rule, this machine's skills, a note. **Run ▾ is never hidden for the dashboard's
  sake**: with agents off or the dashboard unreachable the sheet draws Copy prompt alone and hides Start. This is the one deliberate departure from "an
  environment-level block hides the dispatch control", and the reason is that Copy prompt is a second exit the Board's control never had.
- `JiraLaunchSheet` (`FormSheet`): **Action** (`Select`, seeded from `jiraDefaultAction` or the menu pick); the **prompt preview** (`GET /api/jira/prompt`,
  re-fetched when the action or repository changes, in a read-only `.sheet-prompt`); **Repository** (the project's mapped paths, preselected when there is
  one); **Assign to me** (`Switch`, off and disabled when already me); **Move to** (`Select` over the offered transitions, default `leave as is`); **Model ·
  effort** (seeded from Settings, never the last launch); **Permissions** (`modesUpTo` the dashboard's ceiling); **Remote control**. Footer: **Copy prompt**
  (`navigator.clipboard.writeText`; the chip reads `Copied` for 2 s; the preview is selectable text as the fallback where the clipboard API is unavailable)
  and **Start**.
- **Start, server side, in this order**: assign (if asked) → transition (if asked) → spawn through the dashboard in the chosen repository, session name `jira
  <KEY>` (`sessionName`'s 60-char rule). A Jira write that fails is a 502 naming the step, and nothing spawns. A spawn that fails after the writes is a 502
  whose text says the writes stand; the sheet keeps Copy prompt so the work can still start in a terminal. On success the live map gets the key and the card's
  strip appears on the next poll; the sheet shows `sessionUrl(linkBase, sessionId)`.
- **Stop session**: `Confirm` → `POST /api/agents/jira-stop`. The dashboard session is stopped; Jira is not touched — the ticket keeps its assignee and
  status, which is right because the person is still on it.

## 8. Writes and ADF

- **Assign**: `PUT issue/{key}/assignee` with the identity's `accountId`. **Transition**: a fresh `GET issue/{key}/transitions`; an id not in the answer is a
  400 (`transition not offered`); else `POST issue/{key}/transitions`. After either, the server does `GET issue/{key}` and **splices** the mapped issue into
  every board cache holding the key, so the board reflects the change on the next client poll rather than the next sweep.
- **ADF → Markdown** on the server, read side only: paragraph, heading, bulletList/orderedList/listItem, codeBlock (with language), inlineCode, strong, em,
  strike, link, hardBreak, rule, blockquote, mention → `@name`, date and status → their text, emoji → its shortname. Everything else becomes a one-line
  placeholder — `[attachment: name]`, `[table omitted]`, `[panel omitted]`, `[expand omitted]` — and a description that had any is followed by `open in Jira ↗`.
  An unknown node renders its text content.
- **Errors**: 401 → `access: unauthorized` (chip red, Connection row red, every write 503 until the next successful `myself`); 403 → the modal's inline
  `Jira refused: <message>`; 429 → the sweep pauses until `Retry-After`, a write answers 503 with the retry instant.

## 9. The `jira` skill — `skills/jira/`

- `SKILL.md` + `tools/jira.mjs` with `show <key>` (the ticket block, verbatim from `GET /api/jira/issue/:key?format=text`), `transitions <key>`,
  `transition <key> <name|id>`, `assign <key>`, `status`. Every subcommand goes through `/api/jira` on `http://127.0.0.1:${BM_API_PORT:-4322}` (the one port setting the skills already dial)
  — never Jira directly — so the token stays in the server process and the server stays the one caller. Stack down → exit `5` with the two start commands
  named, the contract `backlog.mjs` has in a tracker project; a Jira refusal (the server's 4xx) → exit `2` with the message; usage → exit `1`.
- The built-in `execute` prompt ends with "move the issue with `jira.mjs transition`"; `context` ends with "wait". A custom skill names its own slash
  command; the server appends the ticket block to every prompt, built-in or not.
- `process.exitCode = main(...)`; `tools/jira.test.mjs` beside the tool (the node runner's globs do not descend); publish is commit → push → `pnpm run
  plugin:sync`; `agents/` is untouched; `.claude-plugin/plugin.json`'s description names the seventh skill.

## 10. Security

- The token and the email live in `.env` and nowhere else; `JiraStatusPayload` carries `site`, `me.name` and `me.accountId`, never either. No route returns
  the token; the browser never talks to Jira; `jira.mjs` goes through the server.
- `BM_JIRA_SITE` is validated at boot: `https`, a hostname with no path or query. Jira Cloud only; a Server/DC site is reported in `detail` as unsupported.
- Every `:key`, every root and every search-by-key passes `isJiraKey` (`^[A-Z][A-Z0-9_]+-\d+$`), and the server quotes keys into JQL (`key in ("PAY-1",
  "PAY-2")`). A person's JQL is passed verbatim for Jira to parse — the server never edits it.
- Reads sit behind the global Host allowlist (`applySecurityMiddleware`); writes add `SameOriginPostGuard`; `dispatch-jira` and `jira-stop` sit under the
  agents guard like every agents POST. The prompt is composed server-side (the existing invariant, widened to "every spawn prompt"). Repository paths must be
  absolute and exist at save; the dashboard must list them at dispatch (409 otherwise — the Board's own rule). `/browse/` links are built server-side from the
  validated site. The CSP is untouched: no new inline script.
- The client polls the server only; the sweep caps (200 per query and per root, 500 per board, depth 3) and the 429 back-off bound what the server asks of
  Jira.

## 11. Testing

- **jest** (flat in `test/`): `jira-config` (per-part fallbacks, atomic write, unreadable → 409 through supertest), `jira-map-issue` (category, level, sprint
  discovery, the Done window relative to the clock), `jira-adf` (one fixture per node, placeholders, unknown nodes), `jira-poller` (a fake client: dedupe,
  depth and size caps, due intervals, armed/idle/off, 429 back-off, the splice after a write), `jira-routes` (supertest through `listenLoopback`: 503
  unconfigured, Host gate, the guard, key validation, transition not offered → 400, `?format=text`), `jira-prompt` (placeholders, the block, the 8 000 cut),
  `agents-dispatch-jira` (unmapped repo 400, dashboard-blind 409, live 409, write-then-spawn order, spawn failure keeps the writes, the live map), `jira-lib`
  (jsdom: column, `runChipState`, `resolveJiraAction`, the CALLS reading), `jira-sections` (no rail entry while unconfigured, the tree switches the page),
  `jira-board` / `jira-modal` / `jira-setup` (render suites in the style of `tracker-board` and `settings-trackers`), and `claude-rules` picks up the new rule
  file by itself. `test/helpers/jira.ts` is an in-memory Jira over the dozen endpoints this touches, the shape `test/helpers/github.ts` has.
- **node** (`test:skills`): `skills/jira/tools/jira.test.mjs` against a stub server — every subcommand, exit `5`, exit `2`, the exitCode idiom.
- Phase 0 is a hand-run probe (§14), not a suite; its answers are written into this spec before phase 1's plan is written.

## 12. Phases — one plan and one PR each

0. **Probe** — verify the API facts in §14 against a real site; amend this spec.
1. **Server read** — client, config, poller, map, ADF, identity, block, the read routes, `GET /api/jira`; `.env.example`; `docs/subsystems/jira.md`;
   `.claude/rules/jira.md`; CLAUDE.md and invariants entries for §13's server rules.
2. **Jira section** — rail entry and tree, `JiraProvider`, Board page, read-only modal (the `Fact` and `marked` hoists land here), Setup with the board
   sheet, Repositories and Connection, the chip, the Trackers row; board/docs entries for §13's client rules.
3. **Writes** — assign and transition routes, the modal controls, the splice.
4. **Skill** — `skills/jira`, `?format=text`, docs, publish.
5. **Run** — Skills card, `jiraDefaultAction`, the menu, the launch sheet, the prompt route, `dispatch-jira`, `jira-stop`, the live map and the strip.

Every phase lands its own docs (CLAUDE.md line, rule bullets, invariants anchors, `docs/subsystems/*`) with the mechanism it introduces, so
`test/claude-rules.test.ts` and `/docs-sync` stay green at every merge.

## 13. Invariants this design adds — headline, mechanism home, reasoning anchor

Each gets its headline in CLAUDE.md, its mechanism bullet in the named `.claude/rules/` file, and a section in `docs/subsystems/invariants.md`; the
claude-rules suite enforces that all three exist and agree.

| headline                                                                                                                                    | rules file     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `~/.backlog-manager/settings/jira.json` has exactly one writer, the server, and a file that cannot be read is never replaced.                 | `jira.md` (new, `paths: ["server/src/jira/**"]`) |
| The Jira token never leaves the server: the browser and `jira.mjs` both go through `/api/jira`, and the poller is armed only while a board syncs. | `jira.md`  |
| The board's Jira writes are assign and transition, nothing else; each re-reads the issue and splices it into every board cache holding the key. | `jira.md`  |
| Jira's Done column is a window, not a store: an issue resolved more than 14 days ago is dropped at map time.                                 | `jira.md`      |
| Every key the server puts into JQL passes `isJiraKey` and is quoted; a person's JQL is passed verbatim for Jira to parse.                     | `jira.md`      |
| A Jira session is remembered in server memory only; a restart forgets it, and Stop is the one hand that clears it early.                     | `jira.md`      |
| The Jira section's two pages are switched by the rail's tree alone, and the section is drawn only when `GET /api/jira` says configured.      | `board.md`     |
| Run ▾ on a Jira card is never hidden for the dashboard's sake: Copy prompt is its second exit, and only Start hides.                          | `board.md`     |

Widened, not added: "`backlog.mjs` in a tracker project needs the stack up, and says so with exit `5`" gains `jira.mjs` (always) in the same bullet;
"The orchestrate spawn prompt is composed server-side" becomes "every spawn prompt"; the CLAUDE.md layout line names `jira/` as the third outbound module.

## 14. Phase-0 probe — the facts this spec assumes and has not verified

Each is to be run by hand with `curl` against the user's site (token from `.env`), and the answer recorded in the right-hand column before phase 1's plan.

| #   | assumption                                                                                                                  | finding |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| P1  | `GET /rest/api/3/myself` with Basic `email:token` returns `accountId` and `displayName`; scoped tokens need `read:jira-work write:jira-work read:jira-user` | |
| P2  | `POST /rest/api/3/search/jql` takes `{ jql, fields, maxResults, nextPageToken }` and answers `issues[]`, `nextPageToken`, `isLast`                    | |
| P3  | `parent in (K1, K2)` follows epic → story → subtask on both company-managed and team-managed projects; `issuetype.hierarchyLevel` is present         | |
| P4  | the sprint field is discoverable from `GET /rest/api/3/field` by `schema.custom = com.pyxis.greenhopper.jira:gh-sprint`; its value shape in a search  | |
| P5  | `status.statusCategory.key` is exactly `new`, `indeterminate` or `done`                                                                              | |
| P6  | `GET issue/{key}/transitions` shape; `POST issue/{key}/transitions { transition: { id } }` → 204; the error shape when a transition needs a screen     | |
| P7  | `PUT issue/{key}/assignee { accountId }` → 204                                                                                                       | |
| P8  | `POST /rest/api/3/jql/parse?validation=strict { queries }` returns per-query errors; `POST /rest/api/3/search/approximate-count { jql }` returns `count` | |
| P9  | a 429 carries `Retry-After` in seconds; whether `X-RateLimit-*` headers exist                                                                        | |
| P10 | the ADF node inventory on a real description: media, mention, table, panel, expand, emoji, inlineCard, date, status                                  | |
| P11 | `GET /rest/api/3/project/search` lists the projects the token sees, with paging                                                                     | |
| P12 | the dashboard's `POST /api/sessions/<id>/stop` answers 404 `no live session` for a gone session (known from code); whether a session STATUS endpoint exists — if so, phase 5 reconciles the live map against it instead of relying on the 8 h expiry alone | |

## 15. Out of scope, and what comes after

- Comments (reading or writing), attachments, worklogs, creating issues, editing descriptions — nothing in v1 writes text to Jira.
- Jira Server / Data Center (REST v2, different auth), more than one site, OAuth.
- Jira's own agile boards and sprint management; this design tracks issues, not boards.
- Approach C — extracting a generic tracker platform under both the GitHub tracker and this module (shared chip, shared poller schedule, shared sync config)
  — is the right second step once two concrete implementations exist to generalise from. The four text-input class families the audit found are drift of the
  same kind and are also left alone.
- The existing tracker spec's "Timify rule" note (`2026-09-17-tracker-backed-backlog-design.md` §10) predates this design: Jira is generic now.
