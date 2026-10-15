# Review 2 — `docs/superpowers/specs/2026-10-15-jira-integration-design.md`

**Date:** 2026-10-15 · **Reviewer:** fresh subagent, checklist-driven, after `6cee5be docs: address spec review 1` · **Companions read:**
`2026-10-15-jira-mockups/00-mock-audit.md` and all ten HTML mocks · **Also read:** review 1, the code each claim names, the dashboard's `spawn.ts` and
`scan.ts`, and Atlassian's API-token page.

## Verdict: REVISE

Review 1's findings are mostly fixed, and the numbers that were checked hold: `PROMPT_CAP = 4000` (`claude-agents-dashboard/server/lib/spawn.ts:66`, 400
over it at `:169-170`), `NAME_RE` rejects `:` (`spawn.ts:91`), `SYNC_INTERVALS` is a record keyed `15s | 1m | 5m | off` (`shared/types.ts:516-521`), the
tracker-sync write contract is as described (`server/src/tracker/sync-config.util.ts:94-133`), `settings/` is the one read-write mount
(`docker-compose.yml:166`), `SameOriginPostGuard` lets an Origin-less CLI through (`server/src/agents/origin.guard.ts:80-83`), `BM_API_PORT || 4322` on
`127.0.0.1` is what `backlog.mjs` dials (`skills/backlog/tools/backlog.mjs:730-733`), and `board.md`'s `client/src/**` scope covers the new Jira client files.

One Critical remains, and it is new: the live map's reconciliation keys on the wrong fact about the dashboard's session list, so a finished session stays
"live" for the full 8 h. Thirteen Important findings follow. The most serious are a path that unassigns a ticket when the user asked to assign it, a
token type the Connection card recommends that cannot reach the URL the client calls, and an error mapping with no rows for Jira's 400 and 404.

Line numbers are the spec's unless a file is named.

---

## Critical

**C1 — L105–108, P12 (L385): the live map is reconciled by presence in the dashboard's list, but finished sessions stay in that list for 48 h.**
§3 drops "entries whose session the list no longer carries". The list behind `dashboardSessionStatus` is "a scan of `~/.claude/projects/`"
(`server/src/agents/agents.service.ts:1961`). It carries every transcript inside the dashboard's `LOOKBACK_HOURS` (48 in
`claude-agents-dashboard/.env.example:31`), and an exited session is still in it, marked `idle` (`claude-agents-dashboard/server/lib/scan.ts:620`, `:629`).
So a session that ended after five minutes is never dropped by this rule. For the full 8 h expiry:
- its card keeps the `board-card-live hatch` strip;
- `runChipState` reads `live`, so Run ▾ is disabled;
- `dispatch-jira` answers 409 for the key.

The opposite failure happens too. A transcript with no messages yet is skipped (`scan.ts:560`), so a session spawned seconds ago is absent from the list.
A `starting` reservation (`sessionId: null`) has no id to match at all. A reconcile that runs right after Start (L260–261 reload `GET /api/jira` "at once")
can therefore drop a live or starting entry and reopen the double-Start window the reservation exists to close.

The existing code already reads liveness from the status, not from presence: the abort route treats only `working` / `question` as running
(`server/src/agents/items-abort.service.ts:109`).
→ Reconcile on the session's status (name which statuses mean gone; `idle` is the dead-process arm). Never reconcile a `starting` entry, and skip an entry
younger than a stated grace. Add these cases to `agents-dispatch-jira` or a `jira-live` suite: finished → dropped, just spawned → kept, starting → kept.

---

## Important

**I1 — L153, L254–256, L88–89, L250: an assign while `me` is null has no server-side refusal, and Jira reads `{ accountId: null }` as "unassign".**
`me: null` disables the modal's `Assign to me` (L88–89). The launch sheet's switch is disabled only "when already me" (L250). Server-side, only
`unauthorized` turns issue writes into 503s (L87, L277–278). `me` can be null under `unreachable`, which is retried on a ticker that may not be armed (I6).
In that state, Jira can be reachable again while `PUT issue/{key}/assignee { accountId: me }` sends `null`, and Jira's assign-issue endpoint treats a null
`accountId` as unassign. The ticket the user asked to take is then taken away from whoever held it.
→ Make both the assign route and `dispatch-jira` answer 503 `no identity` while `me` is null, and disable the sheet's switch on that state too.

**I2 — L64, L230, L374 (P1): the Connection card names scopes for a scoped token, but a scoped token cannot call `https://<site>/rest/api/3`.**
Atlassian's page on managing API tokens says API tokens with scopes must call `https://api.atlassian.com/ex/jira/{cloudId}`. Only unscoped tokens use the
site URL. §3 always builds `https://<site>/rest/api/3/…`. Meanwhile §6.4's Connection row, P1 and the Setup mock ("a scoped API token") steer the user
toward exactly the token type that answers 401 there. A user who follows the card lands in `unauthorized` on every call.
→ Either state that v1 takes an unscoped (classic) API token and drop the scopes line from Connection, or resolve the cloud id and call the gateway. Record
the answer in P1 either way.

**I3 — L64–66, L257, L277–280, L287: the error mapping has no rows for Jira's 400, 404 or 5xx.**
§3 and §8 map 401, 403, 429 and network failures only. Several common answers have no row:
- Jira 400 on an assign to a user who is not assignable;
- Jira 400 on a transition whose screen needs a field (P6 asks for its shape, but no outcome is specified);
- Jira 404 for an issue that was deleted or cannot be browsed;
- any Jira 5xx.

This affects the issue write routes, Start ("the answer names the step"), and every read route: modal open (`GET /api/jira/issue/:key`), search, projects,
and jql/check. §9 already depends on one of the missing rows: `jira.mjs show` reports an "unknown key" as exit `2` (a 4xx), but nothing makes the server
answer a 4xx for it.
→ Add the rows, for example: Jira 400 → 400 carrying Jira's message, 404 → 404, 5xx → 502. Say what the modal shows when the detail read fails.

**I4 — L96–100, L272, L306: the "framed as data" block can be broken out of three ways.**
- The description is ADF → Markdown, and `codeBlock` becomes a fenced block (L272). Inside "a fenced block" its first ``` closes the frame.
- The end marker is fixed text that anyone can type into a ticket.
- A skill template that consumes `{description}` (L100) puts the untrusted description into the instruction text, outside the markers altogether.

§10 relies on this framing as the protection for "a session that can write files".
→ Fence with more backticks than the longest run in the content (or indent the block). Use a marker the content cannot contain, for example a per-prompt
nonce or occurrences stripped. Wrap a `{description}` substitution in the same frame. Add a `jira-prompt` case for each.

**I5 — L93–100, L256: the 4 000 cut trims only the description, and the over-cap path is unspecified.**
The block's facts, its subtasks/children list and a template of up to 2 000 characters (L159–160) can exceed 4 000 with no description left. An epic's
children list has no bound. "A prompt over the cap" is listed among Start's refusals without a status code, and `GET /api/jira/prompt` (Copy prompt and the
preview) has no stated answer for it.

"The second fits whenever the first did" is also false when the description has no characters left to trim. The post-write status and assignee lines can be
longer than the pre-write ones: `unassigned` becomes a full name.
→ Bound the children list (for example, first N plus `and M more`). State the over-cap answer for both routes (400 with a message). Have the second
composition re-apply the cut instead of asserting that it fits.

**I6 — L70, L80–81, L86–89, L299–301: boot-time retries ride a ticker that is disarmed whenever no board syncs.**
The poller is "armed only while … some board's interval is not `off`" (L70). `myself` (L86–87) and the sprint-field discovery (L80–81) are retried "on the
ticker". So on first setup (no boards yet), or on a machine whose boards are all `off`, a boot-time failure is never retried before a restart. The result is
`me: null` (Assign disabled, "no identity") and no sprints.

`serverInfo` (L300–301) has no retry rule at all, and no stated outcome when it fails as `unreachable`: is the site then treated as Cloud or as unsupported?
The GitHub poller stays armed while a repo is "still owed" its cold attempt (`server/src/tracker/poller.service.ts:45-48`).
→ Keep the ticker armed until `myself`, the field discovery and `serverInfo` have all answered. Give `serverInfo` the same back-off. State what `access` is
while it has not answered.

**I7 — L92, L289–291: `execute` ends by moving the issue with `jira.mjs transition`, but names no target.**
An unattended session has to pick a status from whatever the workflow offers, for example `Done` where the team expects `In Review`. It then writes that
pick to a shared system. Writing that kind of status to Jira is the main thing v1 exists to do (§0).
→ State the rule for the built-in's text: either it moves to a named category or status, or it lists the transitions and leaves the issue alone when the
choice is ambiguous, or it does not transition at all and the person does.

**I8 — L74–78, L122–124, L196, L221: per-root and per-query failures have no field to live in.**
A root can be marked `gone`, and one query can fail with a JQL 400 while the rest of the board sweeps. The cache entry is `{ issues, polledAt, access,
detail, truncated }`. The `access` enum (`ok | … | unreachable`) has no "partly failed" value, and `gone` is not a member of it. Yet the Band and the Setup row
must show "a query or root failed" in red, with Jira's message.

Also unstated: what a board keeps when its whole sweep fails. Does it keep the last good list and the old `polledAt`, or empty out?
→ Add a per-board list (for example `failures: { kind: 'root' | 'query', ref, message }[]`), or define how `access` and `detail` encode a partial failure.
State that a failed sweep keeps the last good list and its age.

**I9 — L101–107: "agents → jira, never back", but the reconciliation sits on the jira side and calls into agents.**
`JiraService` owns the live map, and `GET /api/jira` (the jira controller) reconciles it through `dashboardSessionStatus` and the agents config
(`server/src/agents/agents.service.ts:1969`). That makes jira depend on agents. `DispatchRecordsService`'s header records why this repo will not build the
reverse edge (`server/src/items/dispatch-records.service.ts:17-19`). Two further problems:
- `dashboardSessionStatus` answers for ONE session per full list fetch, with a 15 s timeout, so reconciling N entries means N scans.
- It throws a 502 `HttpException`, which would fail the status route itself.

→ Put reconciliation on the agents side (or hoist a list-returning reader into a neutral util). Run it outside the request path. State that a failed read
leaves the map untouched and never fails `GET /api/jira`.

**I10 — L186–187, L268–269, L71–73: an `off` board's screen never refreshes after a write or a save.**
`useJiraBoard` does not poll a board whose interval is `off`. A modal Assign or Move splices the issue into the server's cache, and a save sweeps the board
at once. The card on screen still never changes until the page remounts or the window regains focus. "Reflects the change on the next client poll" assumes a
next poll that never comes.
→ Reload the board, and `GET /api/jira`, after every issue write and board save, whatever the interval.

**I11 — L123, L140, L228: which projects get a "no repository yet" row, and where `JiraStatusPayload.projects` comes from, are unstated.**
`/api/jira/projects` is "every project the token can see" (hundreds on a large site), and the payload's `projects { key, name }[]` has no stated source.
If the warning rows cover every visible project, Setup draws hundreds of them. If `projects` comes from `project/search`, every status poll makes an outbound
call.
→ Say that warning rows list only projects with issues on some board, and that the payload's `projects` is derived from the board caches.

**I12 — L333–342 vs L344–345: the phases land rules ahead of their mechanism.**
- Phase 2 lands "the two client rules of §13". One of them is "Run ▾ on a Jira card is never hidden…" (L361), and Run ▾ is built in phase 5.
- Phase 1's `jira.md` token headline (L355) names `jira.mjs`, which phase 4 builds.
- The "orchestrate and Jira spawn prompts" widening (L364) is assigned to no phase.

This contradicts L344's "every phase lands its own docs … with the mechanism it introduces".
→ Move the Run ▾ rule to phase 5. Word phase 1's token rule without `jira.mjs` until phase 4. Assign the prompt widening to phase 5.

**I13 — L77–78, L196, L363–366: a second cache with a rendered age contradicts a CLAUDE.md headline that §13 does not widen.**
CLAUDE.md:119 reads "The tracker cache is the one cache in this server whose age is a rendered value". Its reasoning in `invariants.md` starts from "Every
other read in this server is per request and uncached". The Jira board cache is a second cache, and its age is rendered (`polled Xs ago`). §13's "Widened,
not added" list names four widenings and not this one. The prose elsewhere that will also read false: `docs/subsystems/invariants.md:3053` ("`agents/` and
`tracker/` stay the only outbound-calling modules") and `docs/subsystems/api.md:96` ("the only other one").
→ Add the widening to §13, for example "the tracker and Jira caches are the only caches whose age is rendered". List the two prose lines in phase 1's docs.

---

## Minor

- **L73:** "repeated to depth 3 (epic → story → subtask)" can be read as three `parent in` rounds. The BoardSheet mock says "three levels deep, so an epic
  brings its stories and their subtasks", which is two rounds below the root. Say "two rounds below the root", and say what a root at hierarchy level 2 or
  higher (an initiative) loses.
- **L75–77, L82–84:** say whether the Done window is applied before or after the 500 cap, and whether a root dropped by the Done window still has its
  descendants walked.
- **L68–69 vs L158:** §3 lists the minted ids as `b_` and `s_`, while §5 adds `q_`. Say whether a query keeps its id across edits.
- **L71:** "`off` means what it means for a GitHub repo" is not quite true. A GitHub interval save does not sync (it only calls `arm()`), and an `off` repo's
  failed cold attempt counts as spent (`server/src/tracker/poller.service.ts:45-48`, `:234-236`). Say that "swept after each save" is new here, and whether a
  failed boot sweep of an `off` board is retried.
- **L80–81, L118:** `sprint`'s shape (name only, or `{ id, name, state }`) is unstated. So is the rule when two custom fields carry the `gh-sprint` schema.
- **L114, P5 (L378):** Jira also has a status category whose key is `undefined` ("No Category"). Name the fallback column.
- **L124, L299:** an invalid `BM_JIRA_SITE` "fails validation at boot and the status says so", but neither `configured` nor `access` has a value for it.
- **L139:** the search spec leaves four cases open: an empty `q`, a maximum length for `q`, a lowercase key (`pay-12` fails `isJiraKey` and falls into the
  summary search), and Lucene-reserved characters, which make Jira answer 400 with no mapping (I3).
- **L142 vs L248–249:** "exactly what … Start sends" is qualified two sections later (the status and assignee lines can differ). Say so in the route table.
- **L149:** say what deleting an unknown id answers, and what order "the first board" refers to (file order, or the card's name order).
- **L150:** paths are compared raw against the dashboard's list (`shared/agent.ts:360`), so `/a/b/` never matches `/a/b`. State a normalisation. The mocks
  show `~/work/…` paths, but `~` is not absolute; say whether the display abbreviates `$HOME`.
- **L128 vs L259:** "the result carries the entry" — `AgentDispatchResult & { assigned, transitioned }` carries no live entry.
- **L103, L167:** say what `jira-stop` answers for a `starting` entry (no `sessionId`) and for a key that is not in the map. Say whether `live` in the
  payload includes `starting` entries.
- **L179–183, L360:** the headline says "switched by the rail's tree alone", yet `Open board` and the empty board's chip switch the page. The spec argues
  this by construction, but the headline as written reads false. Put the carve-out in the headline or the mechanism bullet.
- **L199–201:** the crumb has no precedence. A root that has a parent: `root` or the parent crumb? An issue with a parent that is also assigned to me? The
  card's "age" has no stated basis (`updated`? `resolved` for Done?), and `N subtasks` has no singular form (the RunMenu mock reads `1 subtask`) and no rule
  for zero.
- **L221:** the Band omits zero counts (L197), but the Boards row does not say whether it does; the mocks omit `0 queries` there too. An `off` row would read
  `every off`; the mock reads `last polled 2 h ago`.
- **L231:** "every 15 s" is wrong while the ticker is disarmed. The spec's `no 429 since start` differs from the mock's `no 429 today`.
- **L237:** say what `calls.sweep` counts when one tick sweeps several due boards.
- **L244–246:** CLAUDE.md's "An environment-level block hides the dispatch control" and `.claude/rules/board.md:45` ("With `BM_AGENTS` off the board shows no
  dispatch buttons") are not scoped to the Board in §13's widened list, so the two headlines read as contradicting each other.
- **L251:** the default permission mode is unstated. Item dispatch takes it from `plan.defaultMode` (`.claude/rules/board.md:72-74`), and there is no Jira
  plan.
- **L255:** a transition is validated before the assign lands. In workflows with an assignee condition, the offered transitions change after the assign, so
  a valid "assign + Start Progress" is refused (and the sheet cannot offer that transition at all). Say whether this is accepted.
- **L279:** say whether reads inside a 429 window are also held back, and what the default wait is when `Retry-After` is missing (P9).
- **L52–56:** an unparsable `jira.json` reads as "no boards", so the board page shows `No boards yet` and the first save answers 409. Surface the
  unreadable state in `GET /api/jira`.
- **L337–338:** DESIGN.md §8.7 also says the item modal is "the only modal anywhere in this app" and that `Modal` is composed by one surface "and not by
  two" (`.claude/DESIGN.md:394`, `:398`). Phase 2's list names only the count.
- **L357:** the headline says "resolved more than 14 days ago", leaving out the `updated` fallback that §3 states.
- **L185:** if `GET /api/jira` fails, the status stays unknown and the shell "holds" `jira` indefinitely. Name the fallback.
- **CLAUDE.md:99** ("A TRACKER project's items are the one thing this server writes"): it is scoped to backlog items, so arguably still true, but a clause
  naming Jira issue writes would stop it reading as false.
- **§11:** no case is listed for search escaping (a §13 invariant), identity retry and back-off, `serverInfo` → `unsupported`, live-map reconciliation
  (C1), or the fence and marker collisions (I4).
- **Mock differences not called out in §1 or the audit:**
  - Setup's Repositories warning reads "OPS cards draw no dispatch control"; L228 has `cannot Start until a path is mapped`.
  - Setup's Connection reads "14 calls last sweep · no 429 today".
  - The Trackers mock's row copy, and its "1 refused today", need a count the payload does not carry.
  - The roots rows and roots search results show "· epic · 7 under it", and no route supplies a descendant count.
  - BoardsTen's head reads "10 boards, 2 off" and still says "rows instead of tiles once there are more than four"; NewBoard's hint still says "the picker
    and the tiles".
  - Repository paths are shown with `~`.
- **Audit drift:**
  - `00-mock-audit.md:23` calls the hoists "the one targeted improvement", where the spec (L212) now lists several touches.
  - `:43` says "14 days from `resolved`" without the done-only rule or the `updated` fallback.
  - `:44` says the description always ends with the open-in-Jira link, where L275 says only when it had a placeholder.
  - `:21` has `runChipState` composing `projectDispatchGate`, where L188–189 has the sheet evaluating it per path.
