# Tracker-backed backlog — design

Date: 2026-09-17 Status: approved (user-reviewed via remote decision session the same day: three section cards, eight picks, recorded in §14 beside two calls
of the author's own; the phase-1 plan lives in the task idea-12 promoted to). Grooms
`backlog/ideas/open/idea-12-…md`, whose body is the long-form problem statement and the 2026-09-15 direction this spec turns into a design; where the two
disagree, this file wins and §14 says why.

## Why this exists

Every project's items are files under its `backlog/`, and every run's state is a file under one machine's home directory. One writer per file and no server
dependency is exactly why that has worked for one person on one machine, and exactly why it stops there: a second machine's board is blind to the first
machine's run, "one run per project" is enforced per machine, and nobody without the plugin can see or file work. The Postgres re-platform (2026-09-09) and the
git-remote lease (2026-09-10) were both designed and both rejected — the first for hosting a store, the second for bolting a lock onto a substrate that has none.

The direction chosen on 2026-09-15 and designed here: **the projects' own issue trackers own the items.** GitHub Issues first, because four of the five
registered projects live under `github.com/futin`; GitLab and Jira later, behind the same seam. backlog-manager becomes an aggregator over N trackers plus a
write-back client for the lifecycle, and the board merges every connected source into the one kanban-by-type it draws today. Identity, permissions,
notifications, mobile and search come with the tracker; colleagues participate with zero install; `Fixes #31` puts provenance beside the code.

What changed between the direction and this design, and moved it:

- **The FE redesign is built and on `main`** (2026-09-16), so the "FE first" gate the idea imposed is already open.
- **Settings became two pages** (task-42): Local is this browser's `localStorage`, Shared is the host the API runs on. Every host-side thing in this design lands
  on the Shared page, tagged "this machine", beside the Claude Agents card that already works that way.
- **The orchestrator has never pushed.** Multi-machine visibility of *code*, not just items, makes push-after-merge and pull-before-next its job (§7.5).

## Non-goals

- **No hosted store, no database, no webhook receiver.** The tailnet-only server has no inbound URL and Funnel is never used; polling with conditional requests
  is the whole sync mechanism.
- **No GitLab or Jira adapter in this spec's plan.** §10 says what the seam must leave room for; neither is designed here.
- **No bot identity.** Every write is the token's user. A GitHub App is a later refinement (§15), not a phase.
- **No change to what a groomed item IS.** Groomed stays derived from the body headings (`## Cause` + `## Fix` filled, `## Plan` non-empty) by the same
  `deriveGroomed`, now over an issue body instead of a file body.
- **No redesign of the Runs page.** Its input contract, `OrchestratorRun`, survives as a derived shape (§7.3). The page is not redrawn.
- **The orchestrator base-branch feature is dropped, not built.** It was never implemented; the FE run went straight onto `main`; and its main stated cost —
  an item must exist at `<base>` — has no meaning once items are not in git.

## 1. Vocabulary

- **Source** — where a project's items live: `files` (today's `backlog/` directory) or `github` (a repo's issues). One per project, declared in the repo (§3).
- **Tracker project / files project** — a project whose source is a tracker / is `files`. The board draws both the same way.
- **Connection** — a source the running server can actually read: a tracker project plus a token on this machine that can see its repo.
- **Claim** — the one comment a session posts on an issue to hold it; the protocol in §6.3 decides which of two claims holds. The claim comment is also the
  item's machine-state record for that session (§7.1) — there is one comment kind, not two.
- **Live claim** — a claim that is not `released` and whose heartbeat is younger than `RUN_STALE_MS`. Only live claims contest.
- **Driver** — the orchestrator session leading a run; identity `CLAUDE_CODE_SESSION_ID`, as today.
- **Poll age** — how long ago the server last successfully synced a repo. A rendered value, never hidden.
- **URN** — `gh:<owner>/<repo>#<n>`, an item's identity across projects. Inside a project it is `#<n>`.

## 2. What is per browser, per machine, per project

The question the whole design turns on is which of three scopes owns each fact. Getting one wrong is what made the first draft of §3 wrong (§14, decision 4).

### 2.1 Per browser — nothing new

The Local Settings page gains nothing. There is no per-browser fact in this design.

### 2.2 Per machine — the registry, unchanged, and the token

- **The registry** stays `{ name, path, createdAt }` per project, written only by `backlog.mjs` (`init`/`new` upsert, `unregister`), read by the server per
  request. Which projects a machine's board shows is already a per-machine fact — someone ran `init` in that clone on that machine — and stays one.
- **The token** is `BM_GITHUB_TOKEN` in the server's `.env`, one per platform, read by the server process and by nothing else. A fine-grained personal access
  token with **Issues: read and write** and **Metadata: read** on the chosen repos, nothing more — labels are created through the Issues permission and the
  issue forms `connect` installs are committed files, so no Contents permission is needed. Every participant sets their own; two machines of one person hold two
  tokens. A registered tracker project the token cannot see shows on that board as `no access`, never disappears (§5.4).
- A token change is a server restart: `@nestjs/config` loads `.env` once. The Trackers card says so beside the `no token` state.

### 2.3 Per project — the source marker, committed in the repo

Whether a project is tracker-backed, and by which repo, is a property of the project, not of any machine: once its items have been imported and its
`backlog/` files deleted, every clone everywhere must read issues and none may fall back to files. So the marker is a committed file (§3), the same way the
committed `backlog/` directory is today's marker for "this project has a file backlog". A clone on a new machine is tracker-backed the moment it is registered
there; the only per-machine step is having a token.

## 3. The source marker — `backlog/source.json`

### 3.1 Shape

```json
{ "kind": "github", "repo": "futin/backlog-manager" }
```

`kind` is one of the sources the server knows (`github` in this spec; `gitlab` and `jira` later, each with its own fields — a Jira marker names a site and a
project key, which is how a repo says which Jira project it belongs to and two repos may name the same one). `repo` is validated as `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
No token, no URL, nothing per machine ever goes in this file.

### 3.2 Resolution — `resolveSource(projectPath)`

Read per request, never cached — one `stat` and one small parse, the same cost class as re-reading the registry.

| On disk                                                     | Result                              |
| ----------------------------------------------------------- | ----------------------------------- |
| no `backlog/`                                               | `missing` — as today                |
| `backlog/` present, no `backlog/source.json`                | `files`                             |
| `source.json` parses and `kind` is one the server knows     | that kind                           |
| `source.json` present but malformed, missing `kind`, or an unknown kind | `unsupported` — items none, error surfaced on `/api/projects` and in `ItemsIndex.errors` |

**`unsupported` never falls back to `files`.** A tracker project whose marker the server cannot read would otherwise render whatever stale files a clone still
carries, as ghosts beside the real items on another machine's board.

### 3.3 Writers

Two, both in `backlog.mjs`: `connect` (phase 2) writes it for a project that is being connected, `import` (phase 5) writes it as the FIRST step of moving a
files project over (§8.2 — the write routes refuse a `files` project, so nothing could be imported before the marker exists). Neither commits — no skill
but `backlog-orchestrate` touches git history — so both end by printing the files to commit, the way `backlog-groom` prints its `Groomed on disk only`
line. It stays under `backlog/` rather than at the repo root so `backlog.mjs root`, the `missing` check and
every "where is this project's backlog" answer keep one home; after phase 6 the directory holds this one file.

## 4. The adapter seam — phase 1

### 4.1 `ItemSource`

One interface in `server/src/items/sources/`, one implementation per `kind`:

- `kind` — the marker value it serves.
- `list(project)` → `{ items: BacklogItem[]; errors: string[] }` for one registered project. Asynchronous, because a tracker adapter reads a cache that a poller
  fills; the `files` adapter wraps today's synchronous `scanProject` and resolves immediately.
- `body(ref)` → the item's body text or `null`. For `files` the ref is a filesystem path checked against the registry-built allowlist exactly as today; for a
  tracker the ref is a URN and the body comes from the cache.
- `summary(project)` → what `ProjectSummary` needs beyond the registry entry for a tracker: the connection state (§5.4). Added by phase 2, which is the first
  phase with a value for it; phase 1 derives counts from `list` in the service, as today.

`list` takes the resolved marker beside the project (`null` for `files`), because a tracker adapter reads its repo off the marker and the seam's signature
should not change when the first tracker arrives. `ItemsService` resolves each registered project's source (§3.2) and dispatches over a map keyed by `kind`,
built from the registered adapters and refusing a duplicate kind at construction; the `unsupported` case is handled in the service, not in an adapter. The
controller's three read routes keep their paths and payloads; `index()`, `projects()` and `body()` become asynchronous.

### 4.2 What phase 1 changes in the shared shapes

Two additions, nothing removed:

- `RegistryProject` — unchanged.
- `SourceKind` — the closed list of adapters this build ships, so it is `'files'` in phase 1 and widens to `'files' | 'github'` when phase 2 registers the
  adapter: a kind named in the type without an adapter behind it would be a lie the resolver could not keep.
- `ProjectSummary.source: SourceKind | 'unsupported' | null` — `null` exactly when `missing` (no store, no source), `'unsupported'` for a marker the server
  cannot honour (§3.2), the reason travelling in `ItemsIndex.errors`.
- `BacklogItem.source: SourceKind`, required — a total shape, so every fixture literal in `test/` names its source and the compiler is the checklist.

In phase 1 every value is `'files'`. The client ignores the field until phase 2 has something to draw with it. Everything else a tracker item needs — `url`,
`assignee`, `untyped` — is added by the phase that first fills it (§5.3), so no field ships ahead of its first real value.

### 4.3 Visible result

Nothing. Phase 1 is a seam: the fixture the existing scanner tests run against must produce byte-identical `/api/items` and `/api/projects` payloads through
the `files` adapter, plus the new `source` fields. The tests that pin the seam are in §12.1.

## 5. The GitHub adapter, read side — phase 2

### 5.1 Polling

A poller per connected repo, in-process, a `setTimeout` chain in the watchdog's shape: armed while at least one registered project resolves to `github` and a
token is present, disarmed when neither holds. Interval `TRACKER_POLL_MS = 15_000`. Each tick makes two conditional requests:

1. `GET /repos/{owner}/{repo}/issues?state=all&per_page=100&sort=updated&direction=asc&since=<hwm>` with `If-None-Match`.
2. `GET /repos/{owner}/{repo}/issues/comments?per_page=100&sort=updated&direction=asc&since=<hwm>` with `If-None-Match` — one call for every comment change in
   the repo, including edits (an edit moves `updated_at`), which is what makes §6–7's per-item claim comments cheap to watch. Phase 2 makes the call and caches
   the result; nothing reads it until phase 3.

The first sync has no `since` and paginates to the end. `hwm` is the newest `updated_at` seen; `since` is inclusive, so re-seeing an issue is an upsert, not a
duplicate. A `304` costs nothing against the rate limit. Pull requests come back from the issues endpoint too; anything carrying `pull_request` is dropped.

**The cache is in memory, per repo, lost on restart, rebuilt by the first sync.** It is the one cache in the server whose age is a rendered value — `polledAt`
travels in `ProjectSummary` and the board shows it (§5.5). The registry's "re-read per request, never cache" rule is untouched; this cache exists because the
rate limit makes a per-request fetch impossible, and its age being visible is what keeps it honest.

**Rate limit.** Every response's `x-ratelimit-remaining` and `x-ratelimit-reset` are recorded. On `403`/`429` with `retry-after` or `remaining: 0` the poller
sleeps until the reset and the project's state reads `rate-limited until <time>`. A secondary-limit response backs off sixty seconds. Budget: four repos at two
requests per fifteen seconds is 1,920 requests an hour before `304`s against a 5,000-per-hour limit; the heartbeat edits phase 4 adds are 120 an hour per
active item.

### 5.2 The label set, ensured on first sync

Nine labels, created by the poller the first time a repo syncs successfully and any is missing, idempotently: `type:bug`, `type:idea`, `type:task`,
`type:refactor`, `kind:chore`, `kind:debt`, `runner-fix`, `in-progress`, `orchestrator:queued` (the ninth, added by task-52 — see
[the orchestrator:queued spec](2026-09-23-orchestrator-queued-label-design.md) §1). This is phase 2's one write to GitHub, and it is a bootstrap, not a lifecycle write:
the mapping below cannot work without the set, and the poller is the first thing that touches a repo with a token in hand. `connect` therefore needs no server
running (§5.6).

### 5.3 Issue → `BacklogItem`

| Field                                        | From                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                         | `#<number>`                                                                                                                          |
| `path`                                       | the URN `gh:<owner>/<repo>#<n>` — what `/api/items/body` and, from phase 3, the dispatch request carry                               |
| `url` (new, `string \| null`)                | `html_url`; `null` for a files item                                                                                                  |
| `title`                                      | `title`                                                                                                                              |
| `section`                                    | the one `type:*` label; none → `ideas` with `untyped: true` (new, default `false`); two → the first alphabetically, and a scan error  |
| `kind`                                       | the one `kind:*` label's value, else `''`                                                                                            |
| `tags`                                       | every other label                                                                                                                    |
| `queued` (new, `true` or absent)             | `true` when `orchestrator:queued` is on the issue, the key absent otherwise; consumed like `runner-fix`, never a tag — advisory, read by the card alone ([orchestrator:queued spec](2026-09-23-orchestrator-queued-label-design.md) §4.1) |
| `status`                                     | open → `open`; closed with `state_reason` `completed` or none → `done`; closed with any other reason (`not_planned`, `duplicate`) → `terminal`, and `section` becomes `out-of-scope` — the type label stays on the issue so the original type is recoverable |
| `created`                                    | `created_at`, date part                                                                                                              |
| `updated`                                    | `updated_at`, verbatim — the client's `lastTouched` precedence is unchanged; `lastCommit` is `''` so the middle rung falls through   |
| `lastCommit`                                 | `''` always                                                                                                                          |
| `assignee` (new, `string \| null`)           | first assignee's login                                                                                                               |
| `started`, `phase`                           | `''` in phase 2; from phase 3 the live claim's `at` and `phase` (§6.3)                                                               |
| the four counters                            | `0` in phase 2; from phase 3 the newest claim comment's totals, live or released — each release writes the running totals (§6.5)     |
| `groomed`                                    | `deriveGroomed(section, body)` on the issue body, unchanged                                                                          |
| `project`, `projectPath`                     | the registry entry, as today                                                                                                         |
| `source`                                     | `'github'`                                                                                                                           |

A `runner-fix` label maps to the same `runnerFix` the gate reads today (§7.2). `untyped` is a rendered badge (§5.5) and nothing derived reads it: an untyped
issue is an idea to every predicate until someone labels it.

### 5.4 Connection state — `ProjectSummary`

Four fields, present only for tracker projects: `repo`, `polledAt` (ISO, `null` before the first sync), `access` (`ok | no-token | forbidden | not-found |
rate-limited | error`) and `detail` (the rate-limit reset time, or the error text). `counts` is over the cache. `missing` keeps its meaning — no `backlog/` at
all — and a tracker project with no token is `access: 'no-token'`, not missing.

### 5.5 The client

- **Cards**: the id string is already rendered, so `#31` is free; a link-out control appears when `url` is set; `untyped` draws a badge; `assignee` draws a login
  beside the in-progress bar once phase 3 gives the bar a claim to stand on.
- **The band**: per connected project, the poll age (`polled 12 s ago`), and in place of it the `access` reason when it is not `ok`. The band is where the run
  chip lives, so it is already the board's status line; the exact drawing is the FE task's call under `.claude/DESIGN.md` §8.
- **The item modal**: the cached body by URN, with the poll age beside it. No per-open fetch: the body is at most one interval old and the age says so.
- **Archive**: closed issues by `closed_at`; `terminal` renders as out-of-scope, as today.
- **The Orchestrate sheet's `uncommitted` chip**: `GET /api/items/uncommitted` answers `known: false` for a tracker project — the question has no meaning there —
  and the chip's existing `known` gate keeps it off.
- **Dispatch**: hidden for tracker projects in phase 2, the environment-level way (no buttons), because a spawned session would run file-writing skills against
  a project that has no files. Phase 3 lifts it.

### 5.6 The Trackers card — Shared Settings page, `scope="this machine"`

Read-only, beside Claude Agents. One row per platform: `GitHub — as futin, issues read/write, 4,812 of 5,000 left, resets 14:32`, or `no token — set
BM_GITHUB_TOKEN in .env and restart`. One row per registered project: name, source (`files` / `github futin/x`), poll age, access state. For a files project
whose `origin` is on GitHub, the row also shows the exact command to connect it — `backlog.mjs connect github futin/x`, with the repo read off `origin` per
request, the way `uncommitted` reads git per request — as copyable text. Nothing on this card POSTs; there is no connections file; the token never leaves the
server process.

### 5.7 `backlog.mjs connect github [owner/repo]`

Refuses inside a linked worktree and outside a git repo, like every other command. Defaults `owner/repo` from `origin`; refuses if there is none and none was
given. Refuses a project that still has item files under `backlog/` — that is `import`'s job (§8); `connect` is for a project with an empty or absent store.
Writes `backlog/source.json` and, unless `--no-forms`, the four issue forms under `.github/ISSUE_TEMPLATE/` (one per type, each pre-applying its `type:*`
label and carrying the section's headings as form fields, so a bug filed in the web UI has the skeleton `deriveGroomed` reads; blank issues stay enabled — the
`untyped` badge exists for those). Prints the files to commit. Needs no server: the label set is the poller's job (§5.2).

## 6. Write-back through the API — phase 3

### 6.1 Why through the API

The token lives in one process. `backlog.mjs` and `orchestrate.mjs`, for a tracker project, call the local API instead of GitHub, so a headless session never
holds the secret while it runs a repo's own code, and the board can gain write actions later without a second client. The cost is that **the stack must be
running for any skill on a tracker project** — today every skill works with nothing running. `backlog.mjs` detects a refused connection to
`http://127.0.0.1:${BM_API_PORT ?? 4322}` and says exactly that, naming `pnpm run dev` and `pnpm run docker:up`. Files projects are unaffected until phase 6.

### 6.2 Routes

All under `/api/items/`, all POST, each guarded by content-type and origin the way the agents POSTs are (`test/agents-origin-guard.test.ts`'s route list grows
by these), and each refused with `400` for a `files` project. A CLI sends no `Origin` and passes, as the guard already allows; a browser must match.

| Route                | Body                                              | Does                                                                                        |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `create`             | `project, section, title, body, kind?, runnerFix?` | creates the issue with its labels; returns `{ id, url }`                                    |
| `state`              | `project, id, status: done \| out-of-scope, outcome?` | closes with `completed` / `not_planned`; `outcome` is posted as the closing comment first  |
| `claim`              | `project, id, phase, session, run?`               | runs §6.3; `200 { commentId }` won, `409 { holder }` lost                                  |
| `release`            | `project, id, commentId, reason, counters?`       | edits the claim `released`, clears `in-progress`                                            |
| `heartbeat`          | `project, id, commentId, state?`                  | edits the claim's heartbeat and, when given, its machine state (§7.1)                       |
| `body`               | `project, id, body, ifUpdatedAt`                  | patches the body; `409` if `updated_at` has moved — groom's route, nobody else's           |
| `comment`            | `project, id, body`                               | appends a comment — attention and outcome, the human events                                 |
| `queue`              | `project, id, queued: boolean`                    | adds or removes `orchestrator:queued`; a removal's 404 is success — the eighth, added by task-52 ([orchestrator:queued spec](2026-09-23-orchestrator-queued-label-design.md) §2) |

Each is a thin pass-through to the adapter's write method; the server validates shapes and serialises §6.3 per item in-process so two local sessions never
race each other on the network — the protocol still covers other machines.

### 6.3 The claim protocol

None of the three trackers offers compare-and-swap on an issue: assign-if-unassigned is check-then-act with both writers told they won. Comments are
append-only and server-ordered, which is the property the protocol leans on.

1. Post a comment carrying `<!-- bm:claim -->` and a fenced JSON block: `{ v: 1, session, phase, at, heartbeat, run? }`. Its id is server-assigned.
2. List the issue's comments twice, one second apart, and take the union — the settle that closes most of the read-replica window the 2026-09-15 direction named.
3. Live claims are those with the marker, no `released`, and a heartbeat younger than `RUN_STALE_MS`. **Lowest live comment id wins.** The lowest id is fixed the
   moment it exists and cannot be undercut; the loser's list, made after its own later post, necessarily contains the winner's.
4. Won: set the token's user as assignee and add `in-progress`. Lost: delete the own comment, return the holder.
5. A dead claim found in step 3 — stale heartbeat, never released — is edited `released: { reason: 'stale', by }` by the winner. Never deleted: a claim is
   evidence, and the counters it carries are history (§7.1).

The remaining hole is a list served by a replica that has not seen the winner's comment after two reads a second apart — milliseconds, not the poll interval.
Downstream, two live heartbeats on one item are an attention entry, and a second merge of one item conflicts or parks. Every claim notifies watchers; that is
accepted as a human event ("a session took #31"), and the edits that carry machine state never notify.

**Human-visible state**: the assignee says who, the `in-progress` label says a session holds it — a hand self-assignment in the web UI would otherwise be
indistinguishable from a running session. On release the label goes and the assignee stays, as the record of who last worked it.

### 6.4 Body rules

Last write wins on a body, and a human may be editing it in the web UI. So: **the tool appends comments; only groom patches a body**, through the `body` route,
read-modify-write with `ifUpdatedAt`, human-triggered and rare. Capture composes the whole body before `create`. `## Outcome` becomes the closing comment.
Counters live in the claim comment, never the body. The one exception is `import`'s second pass (§8), which patches bodies nobody has seen yet.

### 6.5 `backlog.mjs` in API mode

A project resolving to `github` routes every command through §6.2; a `files` project runs today's code unchanged.

| Command   | Tracker behaviour                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `new`     | `new <section> <title> --body <file> [--from <id>]` → `create`; prints the URN and the url. Today's `new` prints a path and writes nothing; here there is no path to print, so the body arrives with the call |
| `show`    | prints the URN, a frontmatter-shaped summary **and the body**, since there is no file for the skill to read                                |
| `board`   | `GET /api/items` filtered to the project                                                                                                   |
| `move`    | `state`                                                                                                                                    |
| `start`   | `claim` with `--as`'s phase; exit `1` "already in progress" names the holder's session and its heartbeat age, so the skill's "whose marker" step has what it needs |
| `stop`    | `release` with the four running totals — the newest claim's totals as `show` returned them, plus this session's bill — so the newest comment always carries the whole history; `--abandon` releases without billing, as today |
| `init`    | refuses: a new tracker project is `connect`ed, and `init` stays the files-store creator until phase 6 removes it                            |

Ids: inside a project `31`, `#31` and — since the type is a label, not part of the id — `task 31` all mean `#31`; across projects the URN. `isItemId`
(`shared/agent.ts`) accepts `#\d+` and the URN beside the file forms until phase 6. The four skills' prose gains one paragraph each: how to name an item in a
tracker project, and that the stack must be running.

### 6.6 Plan and spec documents stay in the repo, and the issue links them

Item-level plans are not what this section is about: §6.4's body rules already carry them, because `## Plan` **is** the plan artifact and `backlog-groom`
produces no standalone file for a promoted item. This is about the other kind — a multi-phase design spec and the `superpowers:writing-plans` output beside it,
the pair under `docs/superpowers/` that this very document is a member of.

Those stay committed files in the repo. An issue that needs one carries a link and never the text. The link is pinned to a commit SHA
(`https://github.com/<owner>/<repo>/blob/<sha>/docs/superpowers/plans/<file>.md`) rather than to `blob/main`, because `main` moves and the issue must keep
pointing at the document that was approved when it was written.

Three shapes were weighed and lost:

- **As an issue attachment.** GitHub has no REST endpoint for issue attachments at all — `github.com/user-attachments` is a browser-only upload against session
  cookie auth — so a headless skill cannot produce one. Jira's `POST /rest/api/3/issue/{key}/attachments` can, which is worse rather than better: the planning
  path would work on one tracker and silently not on the other, and §4.1's seam would have to carry a capability only some adapters have.
- **As the issue body, or split across comments.** GitHub caps a body and each comment at 65,536 characters. Three of this repo's own plans are already over
  that cap (89 KB, 114 KB, 121 KB), so the shape does not merely strain, it fails — and splitting one document across comments costs it its diff.
- **Mirrored into a gist or a tracker wiki.** That buys a reader with no repo access, at the price of a second home for one document, which is the failure
  every single-writer rule in `CLAUDE.md` exists to prevent. Deferred (§15) until a reader who cannot clone the repo actually exists.

What the repo buys beyond avoiding those: the orchestrator has the tree checked out at `<base>` in every worktree, so a plan is read from disk with no request
and no spend against the hourly rate limit §5.1's cache exists to protect; the reviewer reads it the same way; and the document is versioned, so a plan revised
mid-phase leaves a diff instead of silently replacing itself. `runner-fix:` being read at `<base>` is the same rule already in force for a different piece of
run-relevant text.

## 7. The orchestrator on a tracker project — phase 4

> **Landed in task-47 (phase 4a), 2026-09-19 — one machine orchestrating.** Phase 4 was split on the user's call: 4a is a run draining a tracker project
> from one machine, and task-48 (4b) is making that run visible from others. The annotations below record what each subsection actually became; the original
> text above and beneath them is never rewritten. §7.3 is 4b's whole subject and landed nothing here.
>
> **Extended 2026-09-23 by [the orchestrator:queued spec](2026-09-23-orchestrator-queued-label-design.md)**: a run's not-yet-claimed queue items carry the
> advisory `orchestrator:queued` label — added at `init`, removed by the claim, a skip, `finish`, the board's Stop and `--abort` — so a teammate on another
> machine can see the plan. It is never a claim; §6.3 stays the only exclusion.

### 7.1 The claim comment is the item's machine state

One comment per session per item, edited in place: the claim posted at `stage <id> preflight` gains a `state` object holding what `RunQueueItem` holds today —
`stage`, `stageAt`, `worktree`, `branch`, `sessionId`, `fixLoops`, `verification`, `usage`, `assumptions`, `note` — plus `run: { runId, startedAt, mergeMode,
questionMode, maxItems }` so a run can be reassembled from its items alone. `stage`, `heartbeat`, `usage`, `verify` and `assume` each edit it through the
`heartbeat` route; `watch`'s thirty-second tick heartbeats it. Comment edits do not notify. A terminal stage releases it (§6.3 step 5's shape, with the
stage as reason); `merged` also closes the issue with the `## Outcome` text as the closing comment. The merge commit carries `Fixes #<n>` too — free provenance,
and GitHub's own close on push is idempotent with the tool's. Under branch mode `branched` releases and leaves the issue **open**: nothing has landed on `main`,
and the pushed branch's merge commit closes it whenever a human merges it, through the same `Fixes #<n>`.

`run.json` is still written, locally, unchanged in shape: the journal of the machine that ran, what the watchdog and retro's transcript lookup read. It is no
longer what another machine sees.

> **§7.1 — landed, with four deviations.**
>
> 1. **`run` is a first-class field (`ClaimRecord.run`), not nested inside `state`** as the prose above puts it. Task-46 had already reserved `run` beside
>    `state`, and the same-run takeover needs `runId` somewhere the SERVER can read without parsing an opaque blob — a field a decision depends on cannot stay
>    opaque. `state` is still carried opaque, and the asymmetry is the rule: nothing in 4a reads a field of `state`.
> 2. **`base` joins the `run` list.** 4b cannot say where a run's work landed without it: the merge commits are on the base branch and in no file this app
>    keeps. `mergeMode` is the EFFECTIVE one, so a reader learns whether the item will be merged rather than what was hoped for before a classifier said no.
> 3. **The driver's claim uses `phase: 'execute'`.** `ClaimRecord.phase` has two values and the counters it bills are the execute pair. A run is execution.
> 4. **Close happens at `stage <n> merged`, not at the merge.** The tool cannot see a push, so the SKILL calls that stage only after the push succeeds and the
>    close is tied to the stage. `stage <n> merged --outcome <file>` is required in a tracker project and refused in a files one.
>
> Two more shapes worth recording because 4b reads them: the state is published by every command that CHANGES an item (`stage`, `usage`, `verify`, `assume`,
> and `watch`'s tick), and **a failed heartbeat or release is one stderr line and never fails the command** — `run.json` stays the journal of record on the
> machine that ran, and the claim is a published copy of it. A failed CLOSE is the exception: exit `9`, nothing written.

### 7.2 The gate

`init` and `plan` read a tracker project's candidates from `GET /api/items` — groomed derived server-side, `runner-fix` read as a label, hoisting unchanged. There
is no `<base>` read, so the `not committed on main` skip has nothing to skip: the item is not in git. `backlog-groom`'s `Groomed on disk only` line is printed
for files projects only. A `claim` refusal at `preflight` skips the item with the reason `claimed elsewhere` — a reason inside `skipped`, not a new stage.

> **§7.2 — landed as written, plus one refusal the prose does not name.** Candidates come from `GET /api/items` filtered to the project, bodies from
> `GET /api/items/body`, and the verdicts come from the UNCHANGED `gateItem`. There is no `<base>` read, so the `not committed on main` skip has nothing to
> skip; `runner-fix` is read as a label through the new optional `BacklogItem.runnerFix`, set by the tracker mapper alone. A `claim` refusal at `preflight`
> puts the item at `skipped` with the reason `claimed elsewhere (session <s>, heartbeat <age> ago)` — a note inside `skipped`, not a new stage — and exits `0`.
>
> **The refusal: inside a run a tracker item is its BARE issue number (`31`), and `--ids` accepts nothing else.** `#31`, a URN and a files id are each exit `1`
> naming the shape wanted. `#` opens a comment in every shell SKILL.md's fenced blocks use, and the id is substituted into dozens of them. The server's
> `resolveIds` therefore normalises all three spellings to bare digits before composing the spawn prompt.

### 7.3 Runs are derived from claims

The server assembles `OrchestratorRun` from the cached claim comments grouped by `run.runId`: `status` is `running` while any claim in the group has a live
heartbeat and none carries `finished`, else the last-touched claim's recorded outcome; `queue` is the group's items; `startedAt`, `mergeMode`, `questionMode`
ride in every claim redundantly. `finish` edits the run's last-touched claim with `finished: { at, status }`. Attention entries are comments carrying
`<!-- bm:attention kind=… -->` and an `@mention` of the token's user — a phone notification beats a strip badge.

**Controls render only on the machine whose run-state directory holds the run's `run.json`.** Pause, resume, abort and the watchdog are all local mechanisms
— the pause file is server-owned on one host, the watchdog resumes with a local spawn — so a run seen from another machine is read-only, and the Runs page says
so instead of drawing controls that would do nothing. A run whose queue never claimed an item has no comment and is invisible cross-machine; the local journal
has it.

> **§7.3 — landed nothing. This is task-48's whole subject.** 4a keeps attention entries in `run.json` and the Runs page reading the local run-state
> directory, exactly as before. What 4a DID settle is the shape 4b builds from: `ClaimRun` and `ClaimState` (`shared/types.ts`), both exported and both read
> by nothing in this build.
>
> **§7.3 — landed in task-48 (phase 4b), 2026-09-19, with two deviations.** The server assembles each run another machine drove from the poller's cached
> claim comments (`deriveRemoteRuns`, `server/src/orchestrator/remote-runs.util.ts`) and serves it in `OrchestratorRunsPayload.remote` — a separate array,
> never a member of `runs`, so this machine's `RUN_IN_PROGRESS_CODE` lock, `runClaimBlock` and watchdog stay local-only and two machines draining one project
> never block each other (§7.4). A derived run whose `runId` any local run file carries is dropped, never merged: the local journal wins whole. A remote row is
> read-only — the Runs page draws `Remote run: its controls are on the machine that ran it.` where the controls would be — and attention entries become
> `<!-- bm:attention kind=… run=… -->` comments with an `@mention`, parsed by a strict line-1 regex that a source-reading guard holds together with the CLI.
>
> 1. **Status does not fall back to "the last-touched claim's recorded outcome".** It is the newest `finished` stamp's status when no OTHER claim in the group
>    heartbeated after it, and otherwise `running`, fresh or not by the newest heartbeat. The prose's rule would report a crashed run — every heartbeat stale,
>    never finished — as finished; this one keeps it `running && !fresh`, which the Runs page already draws as crashed. The stamped claim's own heartbeat is
>    excluded because `finish` on an unreleased claim moves it to the server's clock, just after the CLI's `at`.
> 2. **`finished` rides the existing `heartbeat` route, accepted on a released claim**, where it sets `finished` and nothing else — by the time a run finishes
>    its last item's terminal stage has normally released that claim. An eighth write route would have changed the "seven routes" rule for one field.

### 7.4 One executor per item

"One run per project" is what a local file could enforce. Two machines draining one project now take disjoint items: each `preflight` claims, and the loser
skips. `init`'s exit `4` and the server's `RUN_IN_PROGRESS_CODE` stay as they are — they still guard *this machine* against two of its own runs.

> **§7.4 — landed as written.** Each `preflight` claims and the loser skips; `init`'s exit `4` and the server's `RUN_IN_PROGRESS_CODE` are untouched.

### 7.5 Push and pull

Before `init` builds a queue, and again before each item's worktree is created: `git pull --ff-only` in the main tree. At `init` a failure is a new refusal and
no run starts; mid-run it parks the run, because another machine has pushed something this tree cannot fast-forward onto. After each `--no-ff` merge to
`main`: `git push origin main`. A rejected push means another machine merged meanwhile; the run **parks** with an attention entry naming it, and `--resume`
re-pulls and re-pushes.
Under branch mode, `branched` also does `git push -u origin backlog/<n>` — a branch left on one machine is invisible to every other, and the claim comment
records the branch name. This is not the rejected lease design: nothing locks through git and nothing syncs server-side; a session pushes what it merged.

> **§7.5 — landed, with two deviations.**
>
> 1. **The pull runs in the tree that HOLDS `<base>`, not "the main tree".** Those are the same directory only while the base is `main`; on a `--base` run they
>    are not, and a `pull` typed in the wrong one fast-forwards the wrong branch. It is skipped outright when no tree holds the base (there is nothing checked
>    out to fast-forward) and when the project has no `origin` (there is nothing to pull from). `init`'s pull is a refusal (exit `1`, nothing written); the
>    per-item one parks the run.
> 2. **A classifier-denied PUSH parks, and never degrades to branch mode.** The prose above does not cover it, and the existing rule points the wrong way: a
>    denied MERGE degrades the run because nothing landed, while a denied PUSH follows a merge that HAS landed, so `branched` would be a falsehood written
>    into the run file and into the summary a person reads afterwards. This is stated in SKILL.md beside the push, and pinned by a prose case.

### 7.6 Recovery

A resumed driver re-`claim`s each in-flight item before touching it and skips any another live claim now holds — today's driver lease, relocated to the issue.
A takeover from another machine starts the item over: the dead machine's worktree and branch are unreachable, and its claim is `released: stale` by the winner.
`reconcile` reads claims for a tracker project where it reads `run.json` for a files one.

> **§7.6 — landed by half, deliberately.** A resumed driver re-claims each in-flight item at `orchestrate.mjs claim`, and the SERVER makes that succeed
> against its own run's live claim: a live claim carrying the same `run.runId` is dropped from the live set before the lowest-id rule runs, and then released
> `resumed` rather than deleted, with its counters carried forward. A claim a DIFFERENT run holds moves the item to `skipped`.
>
> **The deviation is what happens to the work.** The prose above says a takeover "starts the item over"; 4a does not remove or restart anything — the item's
> worktree and branch are left in place and named in the note. The run did not lose them, it lost the item, and deleting a session's work on the strength of
> somebody else's claim is not a call an unattended run gets to make.
>
> **`reconcile` still reads `run.json` for a tracker project.** Reading claims is 4b's, alongside §7.3.
>
> **`reconcile` reads claims — landed in task-48 (4b).** In a tracker project each row gains `claim` (`this-run` / `other` / `released` / `none` /
> `unknown`, read from `GET /api/items/claim`), and `other` — another run's LIVE claim — turns the suggestion into `skip`. It still reads `run.json` as well:
> the claim says who holds the item, the journal says what this machine left on disk, and a resume needs both. A files run's output is byte-identical.

## 8. Import — phase 5

Revised 2026-09-21, ahead of the first real migration (guide-manager), against the code phases 3 and 4 left behind. The 2026-09-17 draft of this section
wrote the marker LAST and kept the counters in a footer nothing reads; both fell to the survey below. `git log` on this file has the draft.

`backlog.mjs import github [owner/repo] [--no-forms]` in a files project, one shot per project, through the local API like every other tracker command —
the token stays in the server, the writes are serialised per item, and every response lands in the poller's cache. Not a server route (the server would
have to read item files it may not write around, and delete them) and not `gh api` from the CLI (a second token path that bypasses both).

### 8.1 Preconditions — refusals, nothing written

Project root, never a linked worktree (the `orchestrate.mjs` refusal, same discriminator). Server up, else exit `5`. `origin` on GitHub or `owner/repo`
given. **`backlog/` is tracked, clean, and HEAD is reachable from an `origin/*` ref**: §8.3's truncation link pins a blob at HEAD, and "the repo keeps the
deleted files in its own history" is only true of a history that is on GitHub. No OPEN item carries `started:`; a `started:` left on a `done/` item is a
stamp nobody `stop`ped and is ignored. The marker decides the mode: absent → fresh import; present beside item files → resume (§8.6); present with no item
files → refuse, the project is already tracker-backed.

### 8.2 Begin — marker and forms first

Step one writes `backlog/source.json` and, unless `--no-forms`, the issue forms — the same code `connect` runs. **The marker goes first because
`ItemsService.writerFor` refuses every write route while the marker says `files`** (§6.2); the draft's "write the marker last" could not have made a
single request. The marker is the transaction's begin and the file deletion (§8.5) its commit; between the two the board shows the tracker's items and
ignores the files, exactly as it does for any tracker project.

### 8.3 Pass 1 — one issue per item, open first in `created` order, then `done/`, then `out-of-scope/`

Per item, in this order:

1. **Split the body.** `## Outcome` comes out — on a tracker project the outcome is the closing comment (§6.2's `state`), and an imported item should read
   like a natively closed one. The rest is the issue body, plus a footer: `<!-- bm:imported from=<id> created=<date> tags=<a,b> -->` and one readable line,
   `_Imported from backlog/<section>/<status>/<file>.md_`. Free-text `tags:` live in that footer and become no label — the label set stays the closed nine
   (§5.2). `created` dates become the import time; the footer keeps the original.
2. **Fit the cap.** GitHub caps a body and each comment at 65,536 characters, and the survey found a real item over it (guide-manager `task-1`, 69,883
   bytes, one section of 58 KB). Keep whole `##` sections from the top while they fit, then append
   `_Truncated. Full text: https://github.com/<owner>/<repo>/blob/<HEAD sha>/backlog/<section>/<status>/<file>.md_` — §6.6's SHA-pinned link, which is
   why §8.1 requires HEAD to be pushed.
3. **`POST create`** with section, title, body, `kind` and `runnerFix`. `from` is NOT sent here: its target's issue number may not exist yet (a promoted
   idea is `done/`, imported after the open task that cites it), so it is pass 2's job.
4. **Counters, if any is non-zero:** `POST claim` (`phase: execute`, `session: import-<stamp>`) then `POST release` (`reason: 'imported'`, the four
   counters verbatim). The mapper reads counters off the newest claim regardless of release (§5.3), so this needs no mapper change and no footer parser.
   It MUST precede step 5 — `claim` refuses a closed issue — and it leaves the assignee set, as every release does. Only for items that have counters:
   an item without them gets no synthetic comment.
5. **Close.** A `done/` item: `POST state done` with the Outcome text as `outcome` (comment, then close `completed`). An `out-of-scope/` item: `create`
   already closed it `not_planned`.
6. Record `<old id> → <n>` in memory. Content-creating requests are paced at one per second — GitHub's secondary limit is roughly eighty a minute.

### 8.4 Pass 2 — cross-links

For every imported issue whose body cites an old id — `from:` or a word-bounded `(bug|task|idea|ref)-\d+` anywhere in the text, code fences included —
rewrite it to `#<n>` from the map; an id the map does not know is left as it was. `from: <id>` becomes the `_From #<n>._` line `create` would have prepended.
Each rewrite is one `POST body` with `ifUpdatedAt` read from `GET /api/items` (the cache is current: `create` and `state` absorb their own responses) and
no `runnerFix` key, so the label stays exactly as pass 1 set it. This is the one wholesale body patch in the design, made before any human has seen the
issues.

### 8.5 Commit — delete the item files

Only once every pass-2 patch has succeeded: the item files are deleted, `backlog/README.md` is left alone, and the tool prints the commit instruction
naming `source.json`, the forms and the deletions. It never commits — no skill but `backlog-orchestrate` touches git history.

### 8.6 Failure and resume

Any refusal or non-2xx is one stderr line naming the item and the status (a `429` names the reset time) and a non-zero exit with the files and the marker
both still in place; there is no partial-delete path. A re-run lists the repo's issues once, rebuilds the map from `bm:imported from=<id>` footers, skips
those items in pass 1 and runs pass 2 over everything — the footer is the idempotency key, and it is why the readable line and the marker are two
different things.

What is lost: `created` becomes the import time (footer keeps the original), `lastCommit` and the file-level git log (the repo's history keeps the files),
free-text tags as labels (footer keeps them), and issue numbers never equal file ids — PRs consumed numbers (guide-manager's first import lands at `#4`).

## 9. Deleting the files path — phase 6

Only once every registered project resolves to a tracker. finance-manager, the one project without a remote, gets a private repo or is unregistered — the
user's call when the phase is planned. Then, in one item: the `files` adapter and `scan.util.ts`; `allow.util.ts` and the body allowlist; `git-dates.util.ts` and
its memo; `uncommitted.util.ts`, its route and the sheet chip; `backlog.mjs`'s file writers and `init`; `orchestrate.mjs`'s `<base>` read; `backlog-groom`'s
`Groomed on disk only` line and `backlog-orchestrate`'s half of it; the two id forms; and every CLAUDE.md and `invariants.md` entry that exists to protect a
file — "item files are read-only to the server", "the middle rung comes from git", "the `uncommitted` flag is read from git per request", "a run reads the item
at `<base>`". `deriveGroomed` and `sectionText` stay: they read issue bodies. `registry.json` stays: a machine still needs to know which clones are on its board.

## 10. Later — GitLab and Jira

Not designed here. What the seam must leave room for, so phases 1–6 do not close the door: a `kind` whose marker names a project rather than a repo (§3.1); a
body that is not Markdown (Jira's ADF — a conversion in the adapter, never in the skills); a close that is a resolution field, not a state reason; a comments
endpoint without `since`; and no compare-and-swap anywhere, which the comment protocol already assumes. The work Jira is off-limits to these skills regardless
(the timify rule); a personal Jira Cloud site is the target if one is ever built.

## 11. Security

The server now holds a credential, and it has no authentication of its own: loopback plus the Host allowlist is the access control, and the board is
published on the tailnet. So:

- **The token is process-only.** Read from the environment, never written to any file this app owns, never in a payload, a URL or a log line. The Trackers card
  shows the login, permissions and rate limit — never the value.
- **Outbound calls go to one constant host**, `api.github.com`; `repo` is validated (§3.1) before it is interpolated; nothing in a request shape names a host.
- **Write routes are guarded** by content-type and origin like the agents POSTs, and refused for `files` projects. The Host allowlist already gates every route.
- **A headless session never sees the token.** It reaches GitHub through the local API, which lets it do what the API allows — create, comment, label, close —
  on repos the token can see, as the token's user. That blast radius replaces today's "write item files in the repo", and is accepted on the same reasoning.
- **The threat model changes in one line** for `invariants.md`'s loopback entry: the server holds a credential, and that is why the write routes are guarded
  rather than trusting the bind.

## 12. Testing

### 12.1 Phase 1 — the seam

- `resolveSource` — the five rows of §3.2 as five cases; `unsupported` returns no items and one error naming the path, never `files`.
- The `files` adapter produces the same items and errors as today's `scanProject` on the existing fixture, plus `source: 'files'` on each.
- `/api/items` and `/api/projects` payloads are unchanged but for the two `source` fields; a project with an unknown `kind` appears on `/api/projects` as
  `source: 'unsupported'` with zero counts and is absent from `/api/items`.
- Every supertest suite listens once through `listenLoopback`; the source guard in `test/supertest-bind.test.ts` covers the new suite for free.

### 12.2 Phase 2 — read side

- The mapping table in §5.3, one case per row, driven by fixture issue JSON; the untyped, two-type-labels, `not_planned` and `duplicate` rows named explicitly.
- The poller against a fake `fetch`: first sync paginates; a `304` leaves the cache and moves `polledAt`; a `403` with `retry-after` sets `rate-limited` and
  the reset time; a missing label set triggers exactly one create per missing label, and a present one triggers none.
- `connect`: defaults from `origin`, refuses without one, refuses a store with items, writes exactly the files it prints.

### 12.3 Phases 3–6

Named when each phase is planned. The protocol's tests (two claimants, lowest id, stale claim released not deleted, holder named in the loser's error) and the
push-rejected parking case are the ones no later phase may drop.

### 12.4 Phase 5 — import

Node runner, `backlog.test.mjs`, the existing `fakeApi`. Refusals: linked worktree, no server (exit `5`), dirty `backlog/`, HEAD not on `origin/*`, an open
item with `started:`, a marker with no item files. Order: open → done → out-of-scope by `created`. Outcome split: the text reaches `state.outcome`, never
the body. Cap: a 70 KB fixture is cut at a `##` boundary and the link carries HEAD's sha and the file's path. Counters: `claim`+`release` only for a
non-zero item, before `state`. Pass 2: `task-1` → `#4` in the body, `from:` becomes the `_From #n._` line, `ifUpdatedAt` is sent, no `runnerFix` key. Resume:
a second run skips every footer-matched issue. Files are deleted only when every request answered 2xx.

## 13. Phases and the tasks they become

The user's pick: idea-12 promotes to the **phase-1 task now**; each later phase is captured as its own task `from: idea-12` when its turn comes, planned
against the code as it is by then. Each phase is one orchestrator run.

| Phase | Item                                                                                   | Visible result                                              |
| ----- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1     | `ItemSource` seam, `resolveSource`, `files` adapter, `source` on both shapes (§4)      | Nothing — a seam                                            |
| 2     | GitHub adapter read-only, poller, label bootstrap, Trackers card, card/band/modal, `connect` (§5) | Issues on the board beside file items, from every machine |
| 3     | Write routes, claim protocol, `backlog.mjs` API mode, skills prose (§6)                | Capture, groom, start, stop work against GitHub             |
| 4     | Claim comment as run state, derived runs, push/pull, gate via API (§7)                 | Runs visible from every machine                             |
| 5     | `import` (§8), then projects move one at a time                                        | The first project leaves files                              |
| 6     | Delete the files path (§9)                                                             | One code path                                               |

## 14. Decisions taken, and what they cost

1. **Connections are per machine through `.env`, not per browser.** The Trackers card is on the Shared page. Cost: a token change is a restart.
2. **Skills write through the local API**, never holding the token. Cost: the stack must be running for any skill on a tracker project.
3. **One token per platform.** Cost: a repo outside the token's scope needs a second token this design has no slot for (§15).
4. **The source marker is committed in the repo**, not in the registry — the first draft put it in the registry, which would have made each machine `connect`
   separately and let two disagree about one project. Cost: a repo you cannot commit to cannot be tracker-backed; a registry-side override is deferred (§15).
5. **Files are a migration adapter and are deleted at the end**, not kept forever and not skipped. Cost: two code paths for the length of the migration;
   offline capture dies with phase 6; finance-manager needs a remote or leaves.
6. **Claim by comment, kept over the git-ref compare-and-swap.** The ref primitive (create `refs/backlog-manager/claims/<n>`, `201` wins, `422` loses, no
   second read, invisible to clones) was explained in full and declined for now: one protocol for every tracker, and Jira would need the comment form anyway.
   Cost: the replica-lag window §6.3 narrows but cannot close, and a claim notifies watchers. Revisit only if the window bites in practice.
7. **Untyped issues sit in Ideas with a badge; `connect` installs issue forms** so they are rare. Cost: a colleague's bug report reads as an idea until
   labelled; a fifth column was declined.
8. **Assignee plus `in-progress` label** is the human-visible claim. Cost: two writes per claim and release beyond the comment.
9. **The claim comment and the state comment are one comment.** The 2026-09-15 direction had two; one is fewer notifications and one record per session per
   item. Cost: an item worked three times has three comments, each a complete record.
10. **Promote to the phase-1 task now; later phases as due.** Cost: the board shows one task for a six-phase direction; the spec is the map.
11. **Plan and spec documents stay on disk in the repo; the issue links them, pinned to a commit SHA** (§6.6). Taken 2026-09-20, ahead of phase 5, and
    deliberately provisional — first version, revisit on evidence. The case it does not serve is a reader whose access stops at the tracker. Cost: a dead link
    for that reader, and no plan text visible to anyone who cannot clone the repo.

12. **`import` writes the marker first and deletes the files last** (2026-09-21). The draft had them the other way round, which the write routes' `files`
    refusal made impossible. Cost: a resume rule (§8.6) instead of an all-or-nothing tool, and a window in which the marker is committed-in-waiting beside
    files the board no longer reads.
13. **Imported counters ride a synthetic released claim, not a footer** (2026-09-21). One `claim`+`release` pair per item that has counters, reason
    `imported`. Cost: two extra writes per such item and an assignee left on it; bought: no footer parser, no mapper change, the board reads them on the next
    poll.
14. **An over-cap body is truncated at a heading and links the file at HEAD** (2026-09-21), which is what makes "HEAD pushed" a precondition. Cost: one
    item's text lives in two places for the length of history; bought: no hand trimming per project and no `import` that fails on one file.
## 15. Deferred, on purpose

- A per-project token override for a repo the platform token cannot see.
- A registry-side source override for a repo one cannot commit a marker into (a read-only Jira mapping is the case that would want it).
- A GitHub App identity so machine writes are not the user's.
- A push-rejected retry (fetch, merge, push again) instead of parking.
- Cross-machine pause and resume — controls stay on the machine that owns the run.
- GitHub Enterprise (`BM_GITHUB_API_URL`).
- Usage-aware auto-pause (idea-7) is unaffected and stays filed.
