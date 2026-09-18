---
id: task-46
title: Tracker-backed phase 3: write-back through the API - seven write routes, the claim protocol, backlog.mjs API mode, dispatch for tracker items and the skills prose
created: 2026-09-18
from: idea-12
tags: architecture, multi-machine, tracker, github, api, claim, skills, dispatch
---

## Goal

Phase 3 of the tracker-backed direction ([spec §6](../../../docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)). Phase 1 (task-43) landed the
adapter seam, phase 2 (task-45) the GitHub read side: issues render on the board, from every machine, and nothing can be done to one from this app. This phase
is the first WRITE side. Its visible result is the spec's own sentence: **capture, groom, start, stop work against GitHub** — from a terminal in the project,
through the four skills, and (this item's one addition to §6, decided 2026-09-18) from the board's groom/execute buttons, which phase 2 hid for tracker items
and this phase lifts.

Three things move at once and only make sense together, which is why they are one item and one run:

1. **Seven POST routes under `/api/items/`** (§6.2), each a thin pass-through to a write method on the GitHub adapter, guarded exactly as the agents POSTs are
   and refused for a `files` project. The token stays in the server process; a skill never sees it.
2. **The claim protocol** (§6.3) — the one comment a session posts to hold an issue, lowest live comment id wins — implemented once, server-side, and read back
   by the mapper so a live claim is what the board's in-progress bar and the dispatch button's per-item block stand on for a tracker item.
3. **`backlog.mjs` in API mode** (§6.5): a project resolving to `github` routes every command through those routes; a `files` project runs today's code
   byte-for-byte unchanged. Plus one paragraph in each of the four skills' prose on how to name an item in a tracker project and that the stack must be running.

Two decisions taken with the user on 2026-09-18, both outside §6's literal text: the **dispatch lift** (task-45's plan and `invariants.md` both promised "phase
3 lifts exactly this branch"), and settling the **`304`/`polledAt` disagreement** task-45 left open, in the spec's favour — a `304` now MOVES `polledAt`.

Not `runner-fix: true`, deliberately, although this touches `server/src/agents/`: `backlog-groom`'s rule is a judgement, not a path match, and nothing here
repairs machinery an orchestrator run depends on — the orchestrate spawn route, the watchdog and `orchestrate.mjs` are untouched. Flip it if you disagree; it is
one frontmatter line.

## Plan

**How to read this plan.** It specifies behaviour, signatures and exact expected values — deliberately **not** literal code, including for the tests. This is a
standing override of `writing-plans`' "code blocks required" rule: handed code gets transcribed verbatim, so a defect in the plan becomes a defect in the branch
with nobody positioned to catch it, and test scaffolding is the worst offender because it reads as boilerplate. The **`## Test cases` section is
authoritative** — implement against those expected values and disagree with anything here that contradicts them. Any size figure below is a **soft target**,
never a rule to compress a load-bearing behaviour away. Where this plan departs from the spec's wording, the departure is named in **Decisions this plan
takes** at the end of the Plan; record each one in `## Outcome` as task-45 did, so phase 4 reads them rather than rediscovering them.

Read before touching anything: `docs/subsystems/invariants.md`'s three tracker sections and "Every agents POST is guarded by content-type and origin";
`server/src/tracker/github.client.ts`'s header (the three rules every write method must keep); `skills/backlog/tools/backlog.mjs`'s `startItem`/`stopItem`
(the billing semantics API mode reproduces); `shared/agent.ts`'s `deriveAction` and the paragraph above its first line.

### Step 1 — vocabulary and shared shapes

`shared/types.ts`:

- `ClaimRecord` — the fenced JSON inside a claim comment, the one machine-readable shape phases 3 and 4 share: `{ v: 1, session: string, phase: 'groom' |
  'execute', at: string, heartbeat: string, counters: ClaimCounters, released?: { at: string, reason: string, by: string }, run?: unknown, state?: unknown }`.
  `run` and `state` are phase 4's (§7.1) and are carried opaque here so the phase-4 shape does not force a second version. `ClaimCounters` is `{ groomElapsed,
  executeElapsed, groomTokens, executeTokens }`, four non-negative integers — the four frontmatter counters, in the claim because a tracker item has no
  frontmatter (§6.4: counters never live in the body).
- `CLAIM_MARKER = '<!-- bm:claim -->'`, one constant, one home; a comment IS a claim iff its body contains it. `CLAIM_STALE_MS = RUN_STALE_MS` — a named
  alias, not a second number, so the liveness window can move for skill-phase claims later without touching run semantics (see Decisions, 8).
- The seven request/response shapes (`ItemCreateRequest` … `ItemCommentRequest`, `ClaimResult`, `ClaimRefused`), so the CLI's expectations and the server's
  validation are checked against one declaration. The CLI cannot import them (plugin boundary) — it reads the fields by name, and the API-mode suite pins them.
- `BacklogItem` gains nothing. Its `started`, `phase` and four counters are now FILLED for a tracker item, from the newest claim (Step 6). `untyped`, `url`,
  `assignee` unchanged.

`shared/agent.ts`:

- `isItemId` accepts, beside `[a-z]+-\d+`: `#\d+` and the URN `gh:<owner>/<repo>#\d+` (owner/name in GitHub's character set, the same regex `parseUrn` uses).
  Still no whitespace, no path separator, no shell metacharacter but `#` — which reaches no shell anywhere in this build: the dispatch prompt is prose, and the
  orchestrate prompt refuses a tracker project outright (Step 8). Update the doc comment's "what survives this predicate" paragraph to say so.
- `deriveAction` loses its first line (`item.source !== 'files' → null`) and the paragraph above it. Order after: out-of-scope → `capture`, non-open → `null`,
  ideas → `groom`, else groomed → `execute` / `groom`. The `capture` derivation for a closed `not_planned` issue is correct as it stands — a revive spawns
  `backlog-capture` for a new item citing `from: #<n>`, which API mode's `new --from` writes.

### Step 2 — the claim module, pure

`server/src/tracker/claim.ts`, no Nest, no client, no clock of its own — the protocol's readable half, tested row by row:

- `renderClaim(record)` → the comment body: `CLAIM_MARKER`, a blank line, a fenced ```` ```json ```` block with the record, and one human line under it
  (`session <id> holds this issue (<phase>) since <at>` / `released <reason> at <at>`), because a person reading the issue in the web UI is the whole reason
  the state is a comment and not a hidden field.
- `parseClaim(comment: GithubComment)` → `ClaimRecord | null`. `null` for a comment without the marker, without a fenced JSON block, with JSON that does not
  parse, or with `v !== 1`. Tolerant like `mapIssue`: a malformed claim is not a claim, never a throw.
- `claimsFor(issueNumber, comments: Iterable<GithubComment>)` → the issue's parsed claims, ascending by comment id. Membership is `issue_url` ending
  `/issues/<n>` — the one field the comments endpoint gives for it.
- `isLive(record, nowMs)` — no `released`, and `nowMs - Date.parse(heartbeat) < CLAIM_STALE_MS`. An unparseable heartbeat is NOT live.
- `newestClaim(claims)` — highest comment id, released or not; `liveClaims(claims, nowMs)`; `winner(live)` — the LOWEST comment id among live claims.

### Step 3 — the client's write methods

`server/src/tracker/github.client.ts`, keeping its three rules (one constant host, rate headers recorded from every response, nothing throws on a status):

`createIssue(repo, { title, body, labels }, opts)` → `POST /repos/{repo}/issues`, 201 with the issue; `updateIssue(repo, n, patch, opts)` → `PATCH
/repos/{repo}/issues/{n}` with any of `state`, `state_reason`, `body`, `assignees`, `labels`; `issue(repo, n, opts)` → `GET` one issue (the `body` route's
fresh `updated_at` read); `issueComments(repo, n, opts)` → `GET /repos/{repo}/issues/{n}/comments?per_page=100`, paginated by `Link` like `issues` is;
`createComment(repo, n, body, opts)` → 201 with the comment; `updateComment(repo, commentId, body, opts)` → `PATCH /repos/{repo}/issues/comments/{id}`;
`deleteComment(repo, commentId, opts)` → 204; `addLabels(repo, n, names, opts)` → `POST /repos/{repo}/issues/{n}/labels`; `removeLabel(repo, n, name, opts)`
→ `DELETE /repos/{repo}/issues/{n}/labels/{name}`, where a 404 means "already gone" and is a success for a caller whose contract is "the label is not there".
`GithubComment` gains `html_url: string`. `repo` is validated by `isRepo` before every interpolation, as today; the label name is URL-encoded.

### Step 4 — the writer seam

`server/src/items/sources/source.ts` gains `ItemWriter` — `create`, `state`, `claim`, `release`, `heartbeat`, `body`, `comment`, each taking the resolved
`RegistryProject` + marker and the validated request, answering a result or a typed refusal (`{ refused: 'no-token' | 'not-found' | 'conflict' | 'upstream' |
'rate-limited', ... }`) — values, never thrown, the same posture as the client. `ItemSource` gains `find(ref, registry): Promise<BacklogItem | null>` (the
dispatch lift's lookup, Step 8) and an optional `writer?: ItemWriter`. `FilesSource` has no writer and its `find` is today's `AgentsService.findItem` body
moved: allowlist, `.md`, scan, `samePath`. `GithubSource` implements `find` (URN → registry gate exactly as `body` → cache → `mapIssue` with the issue's
claims) and IS its own writer.

`ItemsService`: `find(ref)` dispatches on the ref's shape the way `body` does — ONE home, `AgentsService.findItem` becomes a one-line delegate.
`writerFor(projectPath)` — raw string compare against the registry (the `uncommitted` rule), `resolveSource` per request, then the adapter's `writer`;
answers `{ kind: 'unregistered' } | { kind: 'files' } | { kind: 'unsupported', reason } | { kind: 'writer', writer, project, marker }` and the controller maps
those to 404 / 400 / 400 / the call.

**Serialisation.** `GithubSource` keeps a `Map<urn, Promise<unknown>>` chain: every write to one item awaits the previous write to that item (spec §6.2's
"serialises §6.3 per item in-process so two local sessions never race each other on the network"). Across machines the protocol itself is the guard.

**Cache absorption.** Every write's response is upserted into the poller's cache — the created/updated issue by number, the created/edited comment by id, a
deleted comment removed — through two new poller methods (`absorbIssue`, `absorbComment`, `forgetComment`) that share `absorbIssues`' PR-dropping and
high-water-mark rules. A capture shows on the next board read, not the next poll; `polledAt` is NOT moved by a write (nothing was polled).

### Step 5 — the seven routes

`server/src/items/items-write.controller.ts`, `@Controller('api/items')`, every method `@UseGuards(SameOriginPostGuard)` — imported from `agents/`, which is
fine: the guard has no agents-specific dependency and moving it is not this phase's job. Bodies are rebuilt field by field the way `AgentsController.dispatch`
does (`typeof … === 'string' ? .trim() : ''`), never spread. Common refusals, in this order: malformed body 400 · unregistered `project` 404 · `files` project
400 `this project's items are files — the skills write them directly` · `unsupported` 400 carrying `resolveSource`'s reason · no token 503
`BM_GITHUB_TOKEN is not set on this machine` · issue not found (fresh `GET` 404 after a cache miss) 404 · GitHub rate-limited 429 `{ error, resetAt }` ·
any other non-2xx from GitHub 502 `{ error: <GitHub's message>, status }`. `id` accepts `#<n>`, `<n>` and the project's own URN; another repo's URN is 400.

| Route       | Body                                                         | Does                                                                                                      | Answers                                     |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `create`    | `project, section, title, body, kind?, runnerFix?, from?`    | labels: `type:<singular>` for the four sections; `kind:<kind>` when given (`chore`\|`debt` only, else 400); `runner-fix` when `runnerFix === true`. `from` prepends `_From #<n>._` + blank line to the body (the GitHub-native cross-link; nothing reads it). `section: 'out-of-scope'` creates with NO type label and closes `not_planned` in the same call | 201 `{ id: '#<n>', urn, url, number }`      |
| `state`     | `project, id, status: 'done' \| 'out-of-scope', outcome?`    | non-empty `outcome` is posted as a comment FIRST; then `PATCH state: closed, state_reason: completed \| not_planned`. Labels and claims untouched — release is the only thing that clears `in-progress` | 200 `{ id, status, url }`                   |
| `claim`     | `project, id, phase, session`                                | Step 6's protocol. A closed issue refuses before any write (`#<n> is done — nothing to start`, 409). Counters seeded from the newest prior claim so one comment is a complete history | 200 `{ commentId, record }` / 409 `{ holder: { session, heartbeat, ageMs, commentId } }` |
| `release`   | `project, id, commentId, session, reason, counters?`         | the claim must exist and be unreleased; live and held by another session → 409 naming the holder; dead → anyone may release it. Edits `released: { at, reason, by: session }` and, when given, `counters` verbatim (the CLI is the biller); removes `in-progress`; assignee stays | 200 `{ commentId, record }`                 |
| `heartbeat` | `project, id, commentId, state?`                             | edits `heartbeat` to now and, when given, `state` verbatim (phase 4's reader). Refuses a released claim, 409 | 200 `{ commentId, record }`                 |
| `body`      | `project, id, body, ifUpdatedAt`                             | ONE fresh `GET` of the issue; `updated_at !== ifUpdatedAt` → 409 `{ updatedAt }`; else `PATCH body`. Groom's route (§6.4) | 200 `{ id, updatedAt }`                     |
| `comment`   | `project, id, body`                                          | appends a comment                                                                                         | 201 `{ commentId, url }`                    |

`test/agents-origin-guard.test.ts`'s route list is where the guarded set lives; it grows by the seven, as full paths, and the loop posts to them as it does
today. Each also gets the "still answers a JSON POST with no Origin at all" case, because the CLI is exactly that caller.

### Step 6 — the protocol and the mapper

**`claim`, inside the per-item chain:**

1. `viewer` login from the poller's identity (fetched once per token — reuse, do not re-request). No login yet → fetch it now, once.
2. Post the claim comment: `renderClaim({ v: 1, session, phase, at: now, heartbeat: now, counters: <newest prior claim's counters or four zeros> })`.
3. List the issue's comments; wait one second (`setTimeout`, injectable for the tests, `unref`'d); list again; union by id.
4. `liveClaims` over the union (now = after the second list). `winner` = lowest live comment id.
5. Own id wins → `PATCH issue assignees: [login]` (replace, not append), `addLabels ['in-progress']`; every OTHER unreleased claim in the union whose heartbeat
   is stale is edited `released: { at, reason: 'stale', by: session }` — never deleted (§6.3 step 5). Answer 200.
6. Own id loses → `deleteComment(own)`; answer 409 with the winner's `session`, `heartbeat`, `ageMs`, `commentId`. A live claim by the SAME session is a loss
   too, with `holder.session === session` — the CLI words it `already in progress (this session)`.

**The mapper** — `mapIssue(issue, repo, project, claims: ClaimRecord[])`, fourth argument required; `GithubSource.list` and `find` supply `claimsFor(n,
poller.comments(repo))`. From `newestClaim(claims)`: unreleased → `started = at`, `phase = phase` (heartbeat age deliberately NOT consulted — the board's rule
for a files item is "ANY stamp, fresh or stale", and the protocol is what retires a stale claim, at the moment someone contests it); released or none →
`started ''`, `phase ''`. Counters from the newest claim regardless of release, zeros with none. `in-progress` is now CONSUMED from `tags` — it has a reader;
the comment in `map-issue.ts` that said phase 3 would do this comes out with it. `assignee` unchanged.

### Step 7 — a `304` moves `polledAt`

`poller.service.ts`'s `304` branch stamps `polledAt` like the `200` branch does; the comment recording the disagreement is replaced by one sentence saying the
age means "since we last successfully checked", settled 2026-09-18. Flip `test/tracker-poll.test.ts`'s `leaves the cache and polledAt untouched on a 304` to
"leaves the cache untouched and moves polledAt on a 304". Update CLAUDE.md's tracker-cache invariant sentence and `invariants.md`'s paragraph; the item modal's
and band's age text needs no change — the sentence they draw already reads as an age.

### Step 8 — the dispatch lift

- `AgentsService.plan`/`dispatch` look items up through `ItemsService.find` (Step 4): a URN reaches the GitHub adapter, a path reaches files. The prompt is
  `composePrompt` unchanged — `Use the backlog-groom skill on #31 — "…" — in this repo's backlog.` reads correctly, and the spawned session's skills detect the
  tracker project from the marker themselves. `sessionName` unchanged (`bl <project> #31`).
- Per-item blocks now work for tracker items for free: `progressBlock` reads the `started` a live claim fills; `runClaimBlock` reads runs (none for tracker
  projects until phase 4).
- **The Orchestrate control hides for a tracker project, and `POST /api/agents/orchestrate` 400s one**, with the sentence `orchestrating a tracker project
  arrives in phase 4`. Today both were covered by `deriveAction` answering `null` for every item; with the lift they need their own gate — one predicate,
  `projectIsFiles(summary)` or equivalent in `client/src/lib/tracker.ts`, read by the toolbar control and the sheet, and the server check in
  `orchestrate()` before `resolveIds` (which scans files and would otherwise 409 every tracker id with a misleading message).
- Client: no new control. `DispatchButton` appears for tracker items because `deriveAction` now answers; `LaunchSheet` already posts `item.path`, which is the
  URN. `test/tracker-board.test.tsx`'s "no dispatch button" case inverts (see Test cases).

### Step 9 — `backlog.mjs` in API mode

**Mode detection.** After `resolveRoot`, read `backlog/source.json`: absent → files (every command unchanged); `kind: 'github'` with a valid `repo` → API
mode; anything else → exit `1` naming the marker and the kind (`backlog/source.json names source kind "x", which this tool cannot write to`). `requireBacklog`
is satisfied by the directory holding the marker.

**Transport.** `apiBase()` = `http://127.0.0.1:${process.env.BM_API_PORT ?? 4322}` (the env var compose already reads; also what the suite points at a fake
server). `fetch` with `content-type: application/json`, `connection: close`, no `Origin`. A refused connection (`ECONNREFUSED`, or `fetch`'s `TypeError`)
→ exit **`5`**, new: `the backlog-manager API is not running on 127.0.0.1:<port> — start it with \`pnpm run dev\` or \`pnpm run docker:up\`; a tracker project
needs the stack up for every command`. `main` becomes `async`; the entry line becomes `process.exitCode = await main(process.argv.slice(2))`.
`backlog.test.mjs`'s source guard accepts `= await main(` for THIS file only — the invariant's reasoning is untouched (an awaited `fetch` with `connection:
close` leaves no handle open; assert it: the API-mode suite's child processes exit, they do not hang). Update the guard's message, CLAUDE.md's
"All three skill CLIs end with…" entry and `invariants.md`'s section to name the `await` form as legal for a CLI whose only asynchronous work is awaited to
completion before the return.

**`project`** sent on every request is `registryRoot(root)` — the same string `init` registers — so the server's raw compare matches.

**Ids.** `31`, `#31` and the project's URN all mean `#31`; a URN for another repo is exit `1`; a file-shaped id (`task-31`) in API mode is exit `1`: `in a
tracker project an item is #<n> — task-31 is a file id`. `locateItem`'s three messages stay for files mode.

| Command                                                           | API-mode behaviour                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`                                                            | registers the project (`registerBestEffort`) and prints `already connected: <root> → github <repo>`; creates NO directories; exit `0`. Deviation from §6.5's "refuses" — see Decisions, 1 |
| `new <section> <title> --body <file> [--from <id>]`               | `--body` REQUIRED (usage, exit `1`, without it; files mode refuses the flag with `NEW_USAGE`). `--from` accepts `#n`/`n`/a file id (a revive may cite `oos-3`? no — in a tracker project every id is `#n`). Prints three lines: `#<n>`, the url, the URN |
| `show <id> [--json]`                                              | line 1 the URN, then a frontmatter-shaped block (`id, title, created, updated, started, phase, groom-elapsed, execute-elapsed, groom-tokens, execute-tokens, assignee, labels`), a `---`, then **the body** (§6.5: there is no file for the skill to read). `--json`: `{ urn, item, body, updatedAt, claim: { commentId, record } \| null }` — `stop` and `body` need `updatedAt` and the claim |
| `board [--section <s>] [--json]`                                  | `GET /api/items`, rows with `projectPath === project`, printed by today's code path (same columns, `»` from `started`)                                |
| `move <id> done\|out-of-scope [--outcome <file>]`                 | `state`; `--outcome` API-mode only (files refuses with `MOVE_USAGE`). Prints the url                                                                   |
| `start <id> --as groom\|execute`                                  | `claim`. `--as` REQUIRED here (the route needs a phase); exit `1` `#<n> is already in progress (session <s>, heartbeat <age> ago)` on 409. Prints the URN and `claim <commentId>`, then one line: `a claim reads stale after 15 min without a heartbeat — run backlog.mjs heartbeat #<n> between long steps` |
| `stop <id> [--abandon] [--keep-started]`                          | `show --json` internally → the newest claim; none unreleased → exit `1` `#<n> is not in progress`; held by another session and live → exit `1` naming it. Totals = the claim's counters + this session's bill: elapsed `max(0, floor((now - at)/1000))` into the phase's bucket, tokens `sessionTokensSince(at, now)` into the phase's bucket when not `null`. `--abandon` bills nothing. `--keep-started` accepted and inert (a claim's `at` is permanent). `release` with `reason: 'abandoned' \| 'stopped'`. Prints the URN |
| `heartbeat <id>`                                                  | new. `show --json` → own live claim → `heartbeat`. Files mode: exit `1` `files projects have no heartbeat`                                            |
| `comment <id> --body <file>`                                      | new. `comment`. Files mode: exit `1`                                                                                                                   |
| `body <id> --body <file> --if-updated-at <iso>`                   | new, groom's. `body`; a 409 is exit `1` `#<n> changed since you read it (now <updatedAt>) — show it again and re-apply`. Files mode: exit `1`         |
| `connect`, `unregister`, `root`                                   | unchanged (`connect` already refuses an existing marker)                                                                                               |

Session identity is `CLAUDE_CODE_SESSION_ID`; absent, `${os.userInfo().username}@${os.hostname()}` — stable across the two processes `start` and `stop` run
in, and honest about who it names.

### Step 10 — the skills' prose

One section per skill, titled `## In a tracker project` (same title in all four so a reader finds it), placed after the skill's first command:

- **`backlog`**: the board reads `GET /api/items`; the stack must be running; exit `5`'s meaning; the new commands and flags one-liner each (`heartbeat`,
  `comment`, `body`, `show --json`, `new --body`, `move --outcome`), since this file is where the tool's commands are documented. Ids: `#31`/`31`/the URN.
- **`backlog-capture`**: `init` still runs first (it registers); compose the whole body — the section's headings, verbatim — into a temp file, then
  `new <section> "<title>" --body <file>`; there is no path to write; print `#<n>` and the url. Untyped issues filed in the web UI sit in Ideas with a badge.
- **`backlog-groom`**: `show` prints the body; **only groom patches a body** — through `body <id> --body <file> --if-updated-at <updatedAt from show --json>`,
  and a `409` means re-read and re-apply. Promote: `new tasks --body <file> --from #12`, then `move #12 done --outcome <file>` whose text is `Promoted to #45.`
  — the closing comment replaces `promoted-to:`. Reject: `move <id> out-of-scope --outcome <file>` carrying the three rejection headings; the body is NOT
  rewritten (§6.4). Plan-the-fix: `body`. **"Already in progress"** on a tracker project: the refusal names the holder's session and heartbeat age; a claim
  stale past 15 min is retired by the protocol when this session claims, so the takeover is `start` alone — no `stop --abandon` first; a live one is someone
  else's and the three-way question stays a question for the user. **`Groomed on disk only` is NOT printed** for a tracker project (§7.2): the groom is on
  GitHub the moment the call returns. Heartbeat between long steps.
- **`backlog-execute`**: `show` prints the body — read it there. `## Outcome` is written to a temp file and becomes the closing comment through
  `move <id> done --outcome <file>` after `stop --keep-started`; on the failure path the same text goes through `comment <id> --body <file>` and nothing
  moves. Hard limits: "writes only under the repo root `show` resolved" gains its tracker half — writes only to the issue the marker names. Heartbeat between
  long steps.

`skills/backlog/tools/backlog.test.mjs`'s prose cases: `Groomed on disk only` is still asserted in groom's SKILL.md AND the new paragraph saying it is not
printed for a tracker project; execute's `## Outcome` pair of shapes unchanged. `backlog-orchestrate`'s SKILL.md and `orchestrate.mjs` are NOT edited — phase 4.

### Step 11 — docs

`CLAUDE.md`: the tracker-cache invariant (`304` sentence); "A tracker project has no item files, and that shows up in four places" becomes three places plus
"dispatch is derived like any other item's, and its per-item block is the live claim"; the `deriveAction` invariant's "TWO checks run ahead" text loses the
first check; a new entry for the write routes (guarded like the agents POSTs, refused for `files`, the token never leaves, per-item serialisation); a new entry
for the claim protocol (lowest live comment id wins; a dead claim is released, never deleted; one implementation); `isItemId`'s widened shape; the CLIs' exit
line gains the `await` form; `backlog.mjs` API mode's one rule — a tracker project needs the stack up, exit `5`. `docs/subsystems/invariants.md`: the
reasoning for each, with anchors; `docs/subsystems/api.md` (the seven routes, the writer seam, absorption); `docs/subsystems/skills.md` (API mode, the new
commands, exit `5`); `docs/subsystems/board.md` (dispatch for tracker items, progress from claims); `docs/overview.md`; `README.md` (HTTP surface, the
`BM_API_PORT` sentence for skills); `.env.example` (`BM_API_PORT` is also what the skills dial); `.claude/rules/tracker.md` and `items.md` pointers for the new
anchors. Update every `phase 3` forward reference in code comments (`map-issue.ts`, `poller.service.ts`, `github.client.ts`, `shared/agent.ts`,
`invariants.md`) — a comment that says "phase 3 will" after phase 3 landed is the kind of drift the contract sweep exists to catch. The spec is a dated
document: do not edit it; record deviations in `## Outcome`.

### Decisions this plan takes that spec §6 does not spell out

1. **`init` on a tracker project registers and exits `0`** rather than refusing: `backlog-capture` runs `init` unconditionally first, and registration is the
   one thing a fresh clone needs before the API can serve it.
2. **Three CLI commands beyond §6.5's table** — `heartbeat`, `comment`, `body` — because §6.2's routes need callers: execute's failure-path Outcome, groom's
   body patch, and liveness.
3. **`move --outcome <file>`** carries `## Outcome` / the rejection reason to the closing comment; **Reject never rewrites the body** (§6.4's rule applied).
4. **`promoted-to:` becomes the closing comment `Promoted to #45.`**; `from:` becomes a `_From #n._` line the server prepends. Nothing derived reads either.
5. **The server seeds a new claim's counters from the newest prior claim; the CLI sends totals on release.** One comment is a whole history AND the CLI stays
   the biller, where `stopItem` already is.
6. **`release` takes `session`** and refuses another session's live claim — the mirror of `claim`'s own rule; a dead claim may be released by anyone.
7. **Write responses are absorbed into the cache; `polledAt` is not moved by a write.**
8. **A skill-phase claim goes stale after `CLAIM_STALE_MS` (= `RUN_STALE_MS`, 15 min) without a heartbeat.** Nothing heartbeats a hand groom automatically;
   the prose asks for `heartbeat` between long steps and the alias exists so phase 4 can give skill claims a longer window if this bites. Recorded as a known
   tension, not solved here.
9. **The Orchestrate control and route gain their own tracker gate** — a consequence of the lift, not a feature.
10. **`section: 'out-of-scope'` on `create`** makes an untyped issue and closes it `not_planned` in one call — the tracker spelling of `oos-N`.

## Test cases

Authoritative. Where this section and the Plan disagree, this section wins. Every server suite listens through `listenLoopback`; the network is faked at
`GithubClient` as `test/tracker-items.test.ts` does; the CLI suite spawns the real tool as a child with `BM_API_PORT` pointing at a fake `http.createServer`
on an ephemeral port that records every request and answers canned bodies.

**`claim.ts`** (pure; one case per row)

- `renderClaim` → `parseClaim` round-trips a record with and without `released`, `run`, `state`; the rendered body contains `CLAIM_MARKER` exactly once.
- `parseClaim` answers `null` for: no marker; marker but no fenced block; unparseable JSON; `v: 2`.
- `claimsFor(31, …)` keeps only comments whose `issue_url` ends `/issues/31` (not `/issues/310`), ascending by id.
- `isLive`: unreleased and heartbeat 1 ms younger than `CLAIM_STALE_MS` → `true`; exactly `CLAIM_STALE_MS` old → `false`; released with a fresh heartbeat →
  `false`; unparseable heartbeat → `false`.
- `winner` of live ids `[40, 12, 33]` is `12`.

**Client write methods** (fake `fetch`)

- each of the nine methods hits exactly the documented method + path on `https://api.github.com`, with `content-type: application/json` on those with a body,
  and returns the response as data with `status`; `removeLabel`'s 404 answers `status: 404` (the poller/writer treats it as success — assert THAT in the
  writer suite, not here). `repo` failing `isRepo` never reaches `fetch` (throws before, or returns `status: 0` — pick one and pin it).

**The writer, through the routes** (supertest, `ItemsModule` + `TrackerModule` with a fake client; one registry holding a `files` project `alpha` and a
`github` project `gamma` on `futin/x`)

- every one of the seven routes: urlencoded POST → 403; cross-origin JSON → 403; `Origin: null` → 403; JSON with no `Origin` → passes the guard (the CLI's
  shape). Asserted by the origin-guard suite's loop over its list, which now holds `items/create`, `items/state`, `items/claim`, `items/release`,
  `items/heartbeat`, `items/body`, `items/comment` beside the six agents routes.
- `project: <alpha's path>` → 400 whose `error` contains `files`; an unregistered path → 404; a project whose marker is `{"kind":"gitlab"}` → 400 carrying
  `unsupported source kind "gitlab"`; `BM_GITHUB_TOKEN` unset → 503 naming `BM_GITHUB_TOKEN`; **no `fetch` call is made in any of those four**.
- `create` `{ section: 'bugs', title, body }` → one `POST …/issues` whose JSON has `labels: ['type:bug']`, answers 201 `{ id: '#77', urn: 'gh:futin/x#77', url,
  number: 77 }`, and the next `GET /api/items` lists `#77` **without a poll tick**. `kind: 'debt'` on `refactors` → labels `['type:refactor','kind:debt']`;
  `kind: 'big'` → 400, no fetch. `runnerFix: true` → `'runner-fix'` in labels. `from: '#12'` → the posted body starts `_From #12._\n\n`. `section:
  'out-of-scope'` → a `POST` with `labels: []` then a `PATCH` `{ state: 'closed', state_reason: 'not_planned' }`, and the item maps to `out-of-scope`.
- `state` `{ status: 'done', outcome: 'text' }` → `POST …/comments` with `text` FIRST, then `PATCH { state: 'closed', state_reason: 'completed' }`; `status:
  'out-of-scope'` → `not_planned`; empty `outcome` → no comment request; the cached issue reads `closed` afterwards without a tick; the `in-progress` label, if
  present, is NOT touched by `state`.
- `body` `{ body, ifUpdatedAt }` → one `GET …/issues/31` first; `updated_at` equal → `PATCH { body }` and 200 `{ updatedAt: <new> }`; unequal → 409
  `{ updatedAt: <GitHub's> }` and **no PATCH**.
- `comment` → 201 `{ commentId, url }` and the comment is in the cache.
- `heartbeat` → `PATCH …/issues/comments/<id>` whose parsed record has a newer `heartbeat` and, when `state` was sent, `state` verbatim; on a released claim →
  409, no PATCH.

**The protocol** (same harness; the fake client assigns comment ids from a counter and lists whatever was posted; the one-second settle is injected as `0`)

- **uncontested**: `claim { phase: 'groom', session: 'A' }` → one `POST …/comments`, two `GET …/issues/31/comments`, `PATCH issue { assignees: ['futin'] }`,
  `POST …/labels ['in-progress']`; 200 with `record.session === 'A'`, `record.counters` all `0`; the item now maps `started === record.at`, `phase: 'groom'`,
  and `in-progress` is absent from `tags`.
- **two claimants, lowest id wins**: with A's live claim (id 100) in the fake, `claim` from `B` posts id 101, lists, sees 100 live → `DELETE …/comments/101`,
  409 `{ holder: { session: 'A', commentId: 100 } }` with `ageMs` a non-negative number; A's comment is untouched; no assignee/label write for B.
- **the loser's list may lag**: the fake answers the FIRST list without the winner's comment and the second WITH it → B still loses (the union is what decides).
- **a dead claim is released, never deleted**: A's claim has heartbeat `CLAIM_STALE_MS + 1` ago; B claims → B wins; A's comment is `PATCH`ed and parses with
  `released.reason === 'stale'`, `released.by === 'B'`; no `DELETE` of A's comment at all.
- **same session twice**: A live, A claims again → 409 with `holder.session === 'A'`, and A's original comment is still the only one (the second is deleted).
- **closed issue**: `claim` on a `closed` issue → 409 whose `error` contains `done`, no `POST`.
- **counters seed**: a released prior claim carries `{ groomElapsed: 120, … }`; a new claim's record carries the same four numbers.
- **release**: by the holder → `PATCH` comment (record has `released.reason === 'stopped'`, `counters` exactly the body's when given, the seeded ones when
  omitted), `DELETE …/labels/in-progress`, assignees NOT touched; the item now maps `started: ''`, `phase: ''`, counters = the released record's. By another
  session while live → 409 naming the holder, no PATCH. By another session when dead → 200, `released.by` is the requester.
- **in-process serialisation**: two `claim` requests for one item fired without awaiting → the fake sees the second `POST …/comments` only after the first
  request's final write; one wins and one gets 409. Two requests for two DIFFERENT items interleave (assert the second item's `POST` happens before the first
  item's last write).

**Mapper**

- `test/tracker-map.test.ts`'s `maps a type:bug issue whole, including the fields phase 3 will fill` is renamed and inverted: with a live unreleased claim
  `{ at: '2026-09-18T10:00:00Z', phase: 'execute', counters: { executeElapsed: 30, executeTokens: 4000, groomElapsed: 5, groomTokens: 10 } }` the item reads
  `started: '2026-09-18T10:00:00Z'`, `phase: 'execute'`, `executeElapsed: 30`, `executeTokens: 4000`, `groomElapsed: 5`, `groomTokens: 10`; with the same
  claim `released` → `started: ''`, `phase: ''`, the SAME four counters; with no claims → `''`, `''`, four zeros (the phase-2 values, still a case).
- a stale-but-unreleased claim still reads `started` set (the board's "any stamp" rule).
- labels `['type:bug', 'in-progress']` → `tags: []`.

**`304` / `polledAt`**

- `tracker-poll.test.ts`: a `304` leaves the cache unchanged, costs no budget, and `polledAt` is the tick's time (strictly newer than before).

**Dispatch lift**

- `deriveAction` on a tracker item: open ideas issue → `'groom'`; groomed open bug → `'execute'`; closed `not_planned` → `'capture'`; closed `completed` →
  `null`. `test/agents-shared.test.ts`'s existing table gains these rows.
- `POST /api/agents/plan { itemPath: 'gh:futin/x#31' }` → 200 with `action`, `prompt` containing `on #31`, `project: 'gamma'`; a URN for an unconnected repo →
  404; a file path still resolves exactly as today.
- `dispatch` with a URN and matching `action` spawns (the fake dashboard's `/api/spawn` is called with `name: 'bl gamma #31'`); a URN whose issue has a live
  claim → `plan.blocked` names the in-progress stamp (`progressBlock`) and `dispatch` 409s.
- `POST /api/agents/orchestrate { project: <gamma> }` → 400 whose `error` contains `phase 4`, before any id check and with no spawn.
- `test/tracker-board.test.tsx`: a tracker item in the same render as a files item shows a dispatch button too (the inverted phase-2 case); a tracker item
  with `started` set shows it DISABLED with `progressBlock`'s sentence; the board's Orchestrate control is absent while the selected project's `source` is
  `github` and present for `files`.
- `isItemId('#31')`, `isItemId('gh:futin/x#31')` → `true`; `isItemId('#')`, `isItemId('gh:futin#31')`, `isItemId('# 31')` → `false`; every existing case
  unchanged.

**CLI API mode** (`backlog.test.mjs`; fixture = a git repo with `backlog/source.json` `{"kind":"github","repo":"futin/x"}` and no item files; fake API on
`BM_API_PORT`)

- nothing listening → exit `5`, stderr names the port, `pnpm run dev` and `pnpm run docker:up`; **stdout empty**.
- marker `{"kind":"gitlab","repo":"a/b"}` → exit `1` naming `gitlab`, no request.
- `init` → exit `0`, stdout `already connected: <root> → github futin/x`, `backlog/` still holds ONLY `source.json`, and the registry file gained the root.
- `new bugs "t" --body f.md` → `POST /api/items/create` with `{ project: <root>, section: 'bugs', title: 't', body: <f.md's bytes> }`; stdout three lines
  `#77`, the url, `gh:futin/x#77`. Without `--body` → exit `1`, `NEW_USAGE`-shaped stderr, no request. `--from 12` → `from: '#12'` in the body sent. In a
  FILES fixture, `new bugs "t" --body f.md` → exit `1`, no file written (the flag is refused there).
- `show 31` and `show #31` and `show gh:futin/x#31` → identical stdout: URN line, the frontmatter-shaped block with `started`/`phase`/four counters from the
  fake's payload, `---`, the body byte-for-byte; `show gh:other/y#31` → exit `1`; `show task-31` → exit `1` whose message contains `file id`; `show 31 --json`
  parses and carries `updatedAt` and `claim.commentId`.
- `board` → one `GET /api/items`; prints only rows whose `projectPath` equals the fixture root; `--section bugs` filters; `»` drawn for a row with `started`.
- `move 31 done --outcome o.md` → `POST /api/items/state { status: 'done', outcome: <bytes> }`; `move 31 out-of-scope` → `status: 'out-of-scope'`, no
  `outcome` key; in a FILES fixture `--outcome` → exit `1`.
- `start 31 --as groom` → `POST /api/items/claim { phase: 'groom', session: <CLAUDE_CODE_SESSION_ID from the child's env> }`; stdout has the URN and
  `claim 100`; on a fake 409 → exit `1`, stderr `#31 is already in progress (session A, heartbeat 4m ago)` — assert the session and that an age is printed.
  `start 31` without `--as` → exit `1`, no request. Without `CLAUDE_CODE_SESSION_ID` the `session` sent matches `^[^@]+@.+$`.
- `stop 31` after the fake's `show` payload carries a claim `{ commentId: 100, at: <now − 90 s>, phase: 'groom', counters: { groomElapsed: 10, … } }` →
  `POST /api/items/release { commentId: 100, reason: 'stopped', counters.groomElapsed: 100 }` (10 + 90, ±1 s tolerance); with a fixture transcript via
  `runWithEnv` (the existing Task-11 pattern) `counters.groomTokens` is the transcript's fresh tokens plus the seeded value; `--abandon` → `reason:
  'abandoned'` and `counters` ABSENT from the body; `--keep-started` → identical to a plain stop; no unreleased claim in the payload → exit `1` `not in
  progress`, no release request.
- `heartbeat 31` → `POST /api/items/heartbeat { commentId: 100 }`; in a FILES fixture → exit `1`.
- `comment 31 --body c.md` → `POST /api/items/comment`; `body 31 --body b.md --if-updated-at 2026-09-18T10:00:00Z` → `POST /api/items/body` with that
  `ifUpdatedAt`; a fake 409 → exit `1` whose message contains `show it again`.
- every request carries `content-type: application/json` and NO `origin` header; each child process exits within 5 s of its last request (no hanging handle).
- **files mode byte-identical**: the whole existing suite is green unchanged; a files fixture makes zero HTTP requests across `init/new/show/board/move/start/
  stop` (the fake API records none).
- the source guard: `backlog.mjs` ends `process.exitCode = await main(`; `orchestrate.mjs` and `retro.mjs` still end `process.exitCode = main(`; no file
  calls `process.exit(`.

**Prose**

- `backlog.test.mjs`'s prose cases: each of the four SKILL.md files contains a `## In a tracker project` heading; groom's says `Groomed on disk only` is not
  printed for a tracker project AND still contains the verbatim line for files projects; execute's `Contract sweep:`/`Red proof:` shapes unchanged;
  `backlog/SKILL.md` documents exit `5`. `skills/backlog-orchestrate/SKILL.md` and `orchestrate.mjs` have no diff on this branch — assert with `git diff --quiet
  <base>...HEAD -- skills/backlog-orchestrate` in the Outcome, not in a test.

**Guards**

- `test/compose-env.test.ts` unchanged and green (no new env var); `test/claude-rules.test.ts` green with the pointer edits; the token appears in no response of
  the seven new routes (extend `never puts the token in a payload` to POST a `create` and a `claim` and scan both bodies).

## Done when

- `pnpm test` green — **both runners**; `pnpm run typecheck` clean; `pnpm run build` green.
- The seven routes are in `test/agents-origin-guard.test.ts`'s list; `items.service.ts`'s `index()`/`projects()` control flow is unchanged (diff it, say so).
- `deriveAction`'s first line is gone and `test/tracker-board.test.tsx` asserts a dispatch button on a tracker item.
- Every `phase 3` forward reference in `server/src`, `shared` and `docs/subsystems` is rewritten or gone (`grep -rn "phase 3"` in the Outcome).
- `skills/backlog-orchestrate/` has no diff.
- Contract sweep and red proof, per `backlog-execute`'s pre-review checks; the ten Decisions above each appear in `## Outcome` with what was done about them.
- **Live end to end, by a person with a token, after the merge**: on one real connected repo — `new`, `show`, `start --as groom`, `heartbeat`, `body`,
  `stop`, `move done --outcome` — and the issue's timeline shows one claim comment edited in place (never a second one), `in-progress` on then off, the
  assignee set, the closing comment carrying the Outcome. An unattended run cannot authorise writes to a real repository; record that the hermetic suites
  stand in, exactly as task-45's Outcome did, and name what a person must still do.

**Not in this phase, on purpose**: the claim comment as run state, derived runs, push/pull, the orchestrator gate via the API (phase 4 — the Orchestrate
control and route refuse a tracker project until then), `import` (phase 5), deleting the files path (phase 6), any GitLab or Jira writer, a GitHub App
identity, and any client control beyond the dispatch button that already exists.
