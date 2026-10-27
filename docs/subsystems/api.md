# The API

Nest, one process, every route under `/api`. It owns nine things: reading the registry, listing each registered project's items through whichever source owns
them (the files on disk, or a polled GitHub repo), reading the orchestrator's run state, polling the trackers projects are connected to, polling the Jira
boards `~/.backlog-manager/settings/jira.json` defines (`jira/`), serving the Hub's three read-only Lookout widgets (`hub/`), reading this app's own release tags (`releases/`), deriving the tick breaker's board from the tick home (`tick/`), and — behind a switch that is off
by default — asking another local process to start a Claude Code session, which since multi-dashboard may be a process on another machine. It writes no item
file and no run file; the only bytes it owns are six files under `~/.backlog-manager/settings/` — the watchdog config, the per-project control file,
`tracker-sync.json`, since Jira phase 2 `jira.json`, for the tick breaker `tick.json` and, for the machine list, `dashboards.json`. Its writes to
Jira itself (phase 3's issue assign and transition) are calls, not files.

## Modules

### `items/`

`GET /api/items` — the whole index, every registered project scanned fresh on each request; every row carries a `source` naming the adapter that produced it.
`GET /api/projects` — one row per registered project, with open-item counts, a `missing` flag for a project whose `backlog/` disappeared, and that project's
`source`. `GET /api/items/body?path=` — one item's Markdown body, resolved through an allowlist built from the registry, so a path outside every registered
project's `backlog/` 404s. `GET /api/items/uncommitted?project=&base=` — which of one project's item files differ from `base` (an existing local branch, proved by
`resolveBaseBranch` as the orchestrate route proves its own; absent, blank or `main` all mean `main`, anything else unproven is a 400 — #254; `main` below
reads as that base), so the Orchestrate sheet can flag the
rows whose bytes on disk are not the bytes a run will read: `{ paths, absent, known }`, where `absent` is the subset of `paths` that `main` does not hold at all
(the run skips those; every other flagged row is stale and runs on `main`'s copy), `known: false` for every git failure alike — and for a tracker project, where
the question has no meaning — 404 for an unregistered project, and nothing cached.

A project's source is resolved per request from its own committed `backlog/source.json` (`sources/resolve.util.ts`), never cached and never stored — the same
rule the registry read follows, for the same reason. No marker means `files`, the implicit source, which never has to be registered for that to work; a
`{"kind":"github","repo":"owner/name"}` marker resolves to the GitHub adapter (task-45). A marker that is present and cannot be honoured — malformed, no string
`kind`, or a kind with no adapter here — resolves `unsupported`: the project contributes **no items** and exactly one error (prefixed with the marker's path,
like every scan error), and its `/api/projects` row reads `source: 'unsupported'` with zero counts and `missing: false`. It never reads as `files`; a tracker
project whose marker this build cannot read would otherwise render a stale clone's files as ghosts. A project with no store at all still reads `missing: true`
and `source: null`. `ItemsService` dispatches over the registered adapters and refuses two claiming one kind at boot.

Two git-backed reads live here and they cache differently on purpose. The last commit touching an item file (`git-dates.util.ts`) is memoised per project
against the mtimes of `index` and `logs/HEAD` — the files git rewrites whenever the answer can change. The uncommitted read (`uncommitted.util.ts`) is memoised
**nowhere**: a working-tree edit, the exact event it reports, moves neither of those files, so the same key would answer "clean" forever after its first hit.

Both are async and time-bounded since #277: every git spawn in this server goes through `runGit` (`git-run.util.ts`) with a 10 s timeout, so a slow repository
makes the routes that need git slow and leaves every other route (`/api/health` included) answering normally. A timeout lands in each site's existing failure
branch — the date read falls back to `created`, the uncommitted read answers `known: false`, `originRepo` answers `null`, an unprovable base is the 400 a
missing branch gets, an unreadable branch list is empty. The date read also shares one in-flight spawn between concurrent misses for the same project and
fingerprint; the uncommitted read shares nothing. No `*Sync` spawn exists under `server/src`; the reasoning is in
[invariants.md](invariants.md#the-server-never-spawns-git-synchronously-in-a-request-path).

Two adapters are registered (`sources/files.source.ts`, `sources/github.source.ts`). `GET /api/items/body` dispatches on the ref's SHAPE, in `ItemsService` and
nowhere else: a `gh:<owner>/<repo>#<n>` URN goes to the GitHub adapter, anything else is a filesystem path and goes to files. `ItemsService.find` makes the
identical dispatch for the agents routes (task-46), which is why `AgentsService.findItem` is now a one-line delegate rather than a private second copy of the
files adapter. The GitHub adapter answers both from the poller's cache and makes no network call of its own; a URN naming a repo no registered project is
connected to answers `null`, so the route 404s. Each adapter also answers `summary(project, marker)` — the four connection fields (`repo`, `polledAt`, `access`,
`detail`) on `ProjectSummary`, four `null`s from files. `GET /api/items/uncommitted` answers `known: false` for a tracker project: the question has no meaning
where there are no item files.

#### The write side (task-46, spec §6.2)

Ten POST routes under `/api/items/`, in `items-write.controller.ts`, each a thin pass-through to one `ItemWriter` method:

| Route       | Body                                                      | Does                                                                                                                                                 | Answers                                        |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `create`    | `project, section, title, body, kind?, runnerFix?, from?` | labels from the section (`type:*`), `kind:*` and `runner-fix`; `from` prepends `_From #n._`; `out-of-scope` creates untyped and closes `not_planned` | 201 `{ id, urn, url, number }`                 |
| `state`     | `project, id, status, outcome?`                           | posts `outcome` as a comment FIRST, then closes `completed`/`not_planned`. Labels and claims untouched                                               | 200 `{ id, status, url }`                      |
| `claim`     | `project, id, phase, session, host?, run?`                | the claim protocol (§6.3); `run` is a `ClaimRun` validated field by field, and a live claim carrying the SAME `run.runId` is taken over, not contested. `host` (bug-46) is the claiming machine, a non-empty string or a 400, CLI-sent and never derived here — this server may be in the compose stack, where `os.hostname()` is a container id. Written into the record only when sent, and echoed in the `holder` of all three 409s | 200 `{ commentId, record }` / 409 `{ holder }` |
| `release`   | `project, id, commentId, session, reason, counters?, runId?, host?` | edits `released` into the claim, writes `counters` verbatim, removes `in-progress`; `runId` (bug-42) is the RUN asserting it owns the claim, which is what lets an abort session release a live claim it does not hold. `host` (bug-48) is the MACHINE asserting the same — a live claim whose recorded `host` matches may be released, which is how `backlog.mjs abort` clears a hand session killed mid-item; the proof that the holder is gone lives in the CLI, and a claim with no recorded `host` matches nothing. Reason `aborted`, and only that reason, also clears the issue's assignees | 200 `{ commentId, record }`                    |
| `heartbeat` | `project, id, commentId, session, runId?, state?, finished?` | re-stamps `heartbeat`; carries the opaque `ClaimState` (read tolerantly by the remote-run assembly). `finished` (task-48) is also accepted on a RELEASED claim, where it sets `finished` alone. `session` is required and only the holder or the claim's own run may beat — `release`'s triple minus its dead-claim clause, since reviving a dead claim is the harm (bug-45) | 200 `{ commentId, record }`                    |
| `body`      | `project, id, body, ifUpdatedAt, runnerFix?, session?`    | one fresh `GET`, then `PATCH` only if the stamp matches, or the body the cache recorded at exactly that stamp equals the fresh body (a claim's own label/comment writes move the stamp — bug #220; the per-stamp record survives a poll — bug #234); `runnerFix` adds/removes the `runner-fix` label AFTER the patch, and ABSENT leaves it alone. `session` (#341) is the caller's own session id: when it holds a LIVE claim on the issue, the claim comment gains `pin` — `bodyHash` of the body GitHub's PATCH answered — inside the same per-URN chain; no session, or no live claim held by it, pins nothing and the write still lands. A pin that was due and failed is `pinWarning`, never a refusal | 201 `{ id, updatedAt, pinWarning? }` / 409 `{ updatedAt }`  |
| `comment`   | `project, id, body`                                       | appends a comment                                                                                                                                    | 201 `{ commentId, url }`                       |
| `queue`     | `project, id, queued`                                     | adds (`true`) or removes (`false`) `orchestrator:queued` (task-52); `queued` must be a literal boolean or a 400, and a removal's GitHub 404 is SUCCESS — every `false` caller is a sweep | 201 `{ id, queued }`                           |
| `review`    | `project, id, inReview`                                   | adds (`true`) or removes (`false`) `in-review` (execute `pr` mode, decision 9); `queue`'s twin — a literal boolean or a 400, a removal's 404 is SUCCESS | 201 `{ id, inReview }` |
| `plan-review` | `project, id, planReview`                               | adds (`true`) or removes (`false`) `plan-review` (backlog-tick); `review`'s twin — a literal boolean or a 400, a removal's 404 is SUCCESS. `create` and `body` carry the same mark as an optional `planReview`, so it lands in the same write as the plan | 201 `{ id, planReview }` |

Every one carries `@UseGuards(SameOriginPostGuard)`, imported from `agents/` — these create and close issues with a credential the browser never sees, which is
a larger consequence than the dispatch route the guard was written for. A JSON POST with no `Origin` still passes, because `backlog.mjs` in API mode is exactly
that caller.

`ItemsService.writerFor(projectPath)` is the one gate: registry compare (raw string, never realpath), `resolveSource` per request, then the adapter's `writer` —
answering `unregistered` (404), `files` (400, `this project's items are files — the skills write them directly`), `unsupported` (400, `resolveSource`'s own
reason) or the call. None of those four makes a network request. `FilesSource` has no writer at all. Refusals travel as values (`WriteRefusal`) and one
function maps them — `answer` (`write-answer.util.ts`), shared by every write route and by `GET /api/items/claim` (#270): `no-token` 503 · `not-found` 404 · `conflict` 409 · `sync-off` 409 · `rate-limited` 429 · anything else 502.

Writes to one item are serialised in-process (`Map<urn, Promise>`), and every response is absorbed into the poller's cache so the next board read shows it —
`polledAt` is NOT moved, because nothing was polled. `GET /api/items/claim?project=&id=` is the one READ beside them, unguarded like every other GET,
answering who holds one item out of the cache; `backlog.mjs stop` needs it because `start` ran in a different process.

`queue` is the only way the orchestrator driver reaches the advisory `orchestrator:queued` label ([spec](../superpowers/specs/2026-09-23-orchestrator-queued-label-design.md)): `orchestrate.mjs` adds it at `init` and removes
it on a skip, at `finish` and at `--abort`, while two server paths remove it on their own — a WON `claim` swaps it for `in-progress` in the same step, whoever
claimed, and `POST /api/agents/stop` sweeps the run's never-claimed items (below). Nothing on this side reads the label as exclusion: the claim is still the
only lock.

`review` is one of the eleven item writes, and its label IS read as exclusion, unlike `queue`'s: `backlog.mjs review <id> on|off` is its one caller, run by
`backlog-execute` in `pr` mode right after it pushes an item's branch (the claim is released then, and the issue stays open until the PR merges) and by a person
when a PR closes unmerged. `plan`/`dispatch` refuse a mapped `inReview` item with `a PR is open for this item` (`inReviewBlock`, `shared/agent.ts`), and the
orchestrator gate turns it `ungroomed` with the same sentence.

`plan-review` is the label a tick's unattended groom leaves on the plan it writes, and it is read as exclusion exactly as `in-review` is: `planReviewBlock`
(`shared/agent.ts`) makes `plan`/`dispatch` refuse a mapped `planReview` item with `this plan awaits review`, always AFTER `inReviewBlock`, and the orchestrator
gate turns it `ungroomed` with the same sentence. `backlog.mjs plan-review <id> on|off` is the one caller of the route, and `off` is how a person approves.

`unvetted` (#341) is the one rung between those two, and it is no label: `mapIssue` derives `BacklogItem.unvetted` (`true` or absent) for a bug or task whose
issue author's `author_association` is not `OWNER`/`MEMBER`/`COLLABORATOR` (`trustedAssociation`, `tracker/claim.ts`) and whose body does not hash to the newest
well-formed `pin` a parsed claim carries. `unvettedBlock` makes `plan`/`dispatch` refuse it with `filed from outside the repo — groom it to vet the plan`, AFTER
`inReviewBlock` and BEFORE `planReviewBlock`, and the orchestrator gate turns it `ungroomed` with the same sentence. Removing `plan-review` does not lift it;
only a `body` write by a session holding a live claim does, because that is what writes the pin
([invariants.md](invariants.md#an-outsiders-tracker-issue-is-executable-only-while-its-body-matches-a-pin-a-groom-of-ours-wrote)).

The eleventh write route, `POST /api/items/abort` (#225, body `project, id`), is not in this file: it calls the dashboard, so it lives in
`agents/items-abort.controller.ts` and borrows `writable`, `answer` and `required` from this one. It releases a live, non-run claim with `reason: 'aborted'` and
`authority: 'board'` (a field `release` never parses) once one proof holds — the holder is a session this server dispatched, which it stops through the
dashboard first (`POST /api/sessions/:id/stop`; a 200 or the `no live session` 404 proceeds, anything else is a 502 and the claim is untouched), or the claim's
`host` equals `BM_MACHINE_NAME` and `GET /api/sessions` reports the holder neither `working` nor `question`. Every other case is a 409 naming what failed.
A STALE non-run claim this server did not dispatch (#227) is released with `reason: 'stale'` and no `authority`, answering `stopped: false`, unless the claim was
taken on this machine and `GET /api/sessions` reports the holder `working` or `question` — every unknown, agents off included, proceeds. `POST
/api/agents/dispatch` re-checks a tracker item's claim with the same probe: a run's claim, a live one, or one held by a session this server dispatched is a 409.
Answers `{ id, released: true, stopped }`. The dispatch record is `DispatchRecordsService` (`items/`, in memory, 24 h / 200 entries), written by
`AgentsService.dispatch` and read by `GithubSource.list` to set `BacklogItem.holder.dispatched` — the mapper fills the rest of `holder` from the live claim.

### `tracker/`

The second of three outbound-calling modules (`jira/` is the third): `github.client.ts` is a thin client over `fetch`, no Nest decorators — one constant host
(`api.github.com`), rate-limit headers recorded from every response including a `304`, and no throw on any status: every failure is a value the poller turns
into an `access` state. `poller.service.ts` is a `setTimeout` chain in the watchdog's shape, armed only while a registered project resolves to `github` and
`BM_GITHUB_TOKEN` is set; each tick makes two conditional requests per connected repo (issues, then every comment in the repo, each paginated to the end and
each with its OWN high-water mark — sharing one mark was a task-46 defect that hid every claim older than the newest issue — the second had no reader at all in
phase 2 and is what the claim protocol maps from since task-46), paginates the first sync to the end, upserts by issue number against an inclusive `since` sent five minutes behind each mark (`SINCE_OVERLAP_MS` — the
listing is eventually consistent, so a `since` equal to the mark lost brickwright#28 for good),
drops pull requests, and sleeps a rate-limited repo until its reset. A repo's first successful sync in a process logs one line,
`tracker <repo>: cold sync <status> — <n> issues cached, <pages> page(s)`, and no later sync logs anything (#332). Since bug-55 a tick also makes one conditional per-issue comments read for every issue the
cache holds an UNRELEASED claim on — none at all when nothing is held — and lets that list be the truth for that issue, because the repo-wide `since` read can
never report a deletion and a loser deleted by another machine's server otherwise stayed cached as a phantom claim. Every absorbed issue — polled or taken off a write — also records the sha256 of its body under its
`updated_at` (32 stamps per issue, a stamp seen with two bodies poisoned), which is what lets `body` forgive a stamp a poll has moved past (bug #234). The eleven labels in `labels.ts` are created on a repo's first successful sync if any is
missing — the module's one write to GitHub. `map-issue.ts` is the pure issue → `BacklogItem` mapping (spec §5.3). `GET /api/trackers` is read-only and carries
the platform's `hasToken`/`login`, its rate limit, and one row per registered project — **never the token**, which is read per call from the environment and
leaves this process in no payload, log line or URL.

**Each repo on its own interval** (#17, [spec](../superpowers/specs/2026-09-22-tracker-sync-interval-design.md)). `sync-config.util.ts` owns
`~/.backlog-manager/settings/tracker-sync.json` (`BM_TRACKER_SYNC_FILE` overrides it): a map `owner/name → '15s' | '1m' | '5m' | 'off'` (`SYNC_INTERVALS`,
`shared/types.ts`), read fresh per call, every missing or invalid entry reading `15s`, written temp-file-plus-rename by `writeSyncInterval` alone. The tick stays
`TRACKER_POLL_MS`; `sweep` syncs only the repos that are DUE — a `15s` repo every tick with no clock check, a slower one once its interval has elapsed since
its last sync (success or failure), an `off` one never, except the one cold-boot sync a never-filled cache is owed. `shouldPoll` narrows to "a token, and some
connected repo that is not `off` or still owes that cold sync". `TrackerPollerService.syncOffBlock(projectPath)` is the ONE server home of the refusal
sentence, `sync is off for <owner/name> — turn it on in Settings › Shared › Trackers`, and `RemoteRunsService` derives nothing for an `off` repo. Both
`ProjectSummary` and `TrackerProjectRow` carry `interval` — the effective token for a `github` row, `null` for every other.

`POST /api/trackers/sync` (`{ repo, interval }`) is `orchestrator/tracker-sync.controller.ts`, in `OrchestratorModule` rather than beside `GET /api/trackers`
because its 409 needs the run files and the starting entries and `TrackerModule` hosting it would be a module cycle. Guarded like the agents POSTs; 400 for a
repo that fails `isRepo` or an interval outside the four; 404 for a repo no registered project is connected to; 409 for `off` while a run file on any project
of that repo reads `running` or `paused`, or a starting entry exists for one; otherwise write, `arm()`, and 200 with the repo's `summary()`. It calls nothing
outbound. The write answers one more 409, for any interval (#270): a `tracker-sync.json` that exists but does not parse is left exactly as it is and refused
(`SyncConfigUnreadableError`), because rewriting it from `{}` would drop every other repo's setting back to `15s`; a missing file is written fresh.

While a repo is `off`, every write path refuses with 409 `{ error: <the sentence> }` before any request to GitHub or the dashboard: the ten
`GithubSource` writes (through `writeChain`, inside the per-item serialisation, after the no-token 503 and the id check), `dispatch`, `orchestrate` and
`resume` in `AgentsService`, and `ItemsAbortService.abort` as its first check after the files refusal — before its dashboard stop, not only before its release. `plan()` names the same sentence as its `blocked`, so the launch sheet never offers what dispatch refuses. `backlog.mjs` prints
the `error` verbatim and exits `1` through its generic non-2xx path — not `5`: the stack is up, the setting is the refusal.

### `jira/`

The third outbound-calling module (Jira integration phase 1): a `fetch` client on Atlassian's API gateway, a poller armed only while the three `BM_JIRA_*`
keys are set and a board is owed a sweep, the per-board issue caches it fills (the second cache in this server whose age is rendered, as `polledAt`), the
`jira.json` reader, the ADF converter and the ticket block. Nine read routes under `/api/jira` — the status payload, a board's cached issues, one issue read
fresh (`?format=text` for the ticket block), the roots search, the project list, the JQL check and (phase 5a) `/prompt`, the composed Run prompt as `text/plain` — and
eight guarded POSTs: six config writes that touch only `jira.json` (since phase 2 `/boards`, `/boards/delete`, `/repos`; since 5a `/skills`, `/skills/delete`;
since the repo/branch work `/repo-defaults`) and
two writes to Jira itself (since phase 3, `/issue/assign` and `/issue/transition`), each followed by a re-read of the issue that is spliced into every board cache
holding it. Since 5a the module also owns `JiraLiveService`, the in-memory map behind the status payload's `live` and an issue's `session`; the two POSTs that
fill and clear it live in `agents/`, below, because they call the dashboard. The credentials are read per call and reach no payload. → [jira.md](jira.md),
the full doc.

The repo/branch work (spec `2026-10-20-jira-repo-branch-design.md`) added the module's one reader of git, `refs.util.ts`, and three routes around it — all of
them reads of git, never writes ([invariants](invariants.md#the-server-never-writes-git)):

- `GET /api/jira/refs?repo=<path>&key=<KEY>` — one mapped repo's branches as of its last fetch (`JiraRepoRefs`: each branch with its local and `origin/` twin
  folded into one entry, its sync against `origin`, the tree holding it and whether it carries the key; the mapped checkout's own branch, the default base, and
  `FETCH_HEAD`'s mtime as the last fetch). 400 for a missing `repo` or a malformed key, 503 unconfigured, 409 an unreadable `jira.json`, 400 `<repo> is not
  mapped`; a repo that cannot be read is a 200 with `available: false` and its reason — `not mounted into the board`, `does not exist` or `not a git
  repository`.
- `GET /api/jira/worktrees` — every working tree of every distinct mapped repo (`git worktree list`, the main tree flagged), as `{ worktrees, unavailable: [{
  repo, reason }] }`; the client matches branches to tickets for the cards' worktree chip and the modal's Worktrees list.
- `POST /api/jira/repo-defaults` — `{ path, base, namePattern }`, `null` meaning unset and both `null` deleting the path's entry in `jira.json`'s
  `repoDefaults`. Guard → validate (400) → configured (503) → readable (409) → mapped (400 `<path> is not mapped`) → write; no re-aim, since no sweep reads it.

`GET /api/jira/prompt` and `POST /api/agents/dispatch-jira` both take the Run's branch choice — `mode` (`new`, `continue` or `none`), `branch`, `base`,
`openMr`, `target` — through one parser, `parseBranchChoice` (`branch-choice.util.ts`), whose refusals are 400s (`mode must be new, continue or none`, `execute
needs a branch (mode new or continue)`, `branch must carry <KEY>`, …), and then one comparison with the repo's refs, `resolveWorkspace`, whose refusals are 409s
(`<branch> exists — switch to Continue`, `<branch> is checked out in the mapped checkout <repo>`). A repo the server cannot read skips the 409s; `jira.mjs
worktree` makes the same checks on the host.

### `registry/`

Read-only view of the registry file, re-read on every request so a capture made mid-session shows up on the next fetch.

### `agents/`

One of the three modules that call outbound, and every POST in it is guarded by content-type and origin. Since multi-dashboard its `dashboards/` folder widens
WHERE it calls — not how many modules do: home's dashboard (`BM_AGENTS_URL`) as ever, plus any remote dashboard and any remote board that
`~/.backlog-manager/settings/dashboards.json` names, each read per request with a token that is env-only. With no such file every route below is what it was:
the machine is `home`.

- `GET /api/agents/status` — whether dispatch is on and whether `../claude-agents-dashboard` answered.
- `POST /api/agents/plan` — this item's next step, derived from the file, plus a composed default prompt. An execute plan's and a groom plan's prompt have no
  closing clause: the finish clause is the sheet's picker, not editable text (only a capture's keeps its commit rule in the text).
- `POST /api/agents/dispatch` — spawns the session in that dashboard. An execute or a home groom dispatch also takes `finish` (`in-place` | `pr`, absent
  meaning in-place), `base` (a local branch, proved server-side, legal only with `pr` and required by it) and, only with `pr`, the booleans `autoMerge` and
  `fix` (`fix` needs `autoMerge`; each a 400 otherwise, `autoMerge and fix apply only to finish pr` / `fix requires autoMerge`); the server appends the finish
  clause from those validated fields after the body, and a body that spells `--finish`, `--base`, `--auto-merge` or `--fix` is a 400. `finish` on a capture, or
  on a groom sent to a remote machine, is a 400. Both `dispatch` and `orchestrate` take an optional
  `machine`: absent or `home` is the launch above, byte for byte, and a remote's `name` sends it to that machine's dashboard — see "Launching on another
  machine".
- `POST /api/agents/orchestrate` — spawns a headless `/backlog-orchestrate` run for one project. The prompt is composed server-side, so a caller can influence
  which items, which modes and which base branch, and nothing else. A TRACKER project is accepted since task-47: `resolveIds` proves its ids against
  `ItemsService` rather than against a directory scan, accepts `#31` / the URN / a bare `31`, and **emits bare digits alone**, so the prompt never carries a
  `#`. A URN must name the project's own repository, compared case-insensitively, or the id is a 400 (#270) — the digits after the `#` are never read alone.
  `mergeMode: 'pr'` is accepted only for a project whose source resolves to `github`; any other project is a 400.
- `POST /api/agents/resume` — re-spawns a run that crashed or was paused.
- `POST /api/agents/pause` — writes the pause request a live run reads back at its dispatch gates.
- `POST /api/agents/stop` — writes a STOP request to the same one control file (`kind: 'stop'`) and then attempts one `/backlog-orchestrate --abort` spawn.
  Accepts a `running` run fresh or stale alike, and a `paused` one (#305) — a paused run still holds what an abort clears; the body says what landed
  (`stopRequested`) and, separately, what became of the spawn (`abortSession` / `abortRefused`), because only the first of the two is guaranteed. `cancel: true`
  is a 409 (bug-53): a stop cannot be withdrawn — the spawn has already
  been awaited by the time one could arrive — and ignoring the flag instead would read an old client's `Cancel stop` as a second stop. On a tracker project
  it also sweeps `orchestrator:queued` off every never-claimed queue item, after the stop is on file and before the spawn; a refused removal is listed in an
  optional `unqueueFailed` (ids as `run.json` spells them) and never fails the stop — the spawned `--abort` repeats the sweep.
- `POST /api/agents/dispatch-jira` — a Jira ticket's Run (`jira-agents.controller.ts` → `JiraDispatchService.dispatch`): reserve the key in the live map, optionally
  assign and transition in Jira, then spawn a session in the mapped repository. The action is a pick from the body, never derived; the prompt is composed server-side
  by `composeJiraPrompt`. A failure after a Jira write says the write stands. Since the repo/branch work the body also carries the branch choice (`mode`,
  `branch`, `base`, `openMr`, `target`, above), checked before anything is reserved or written. → [jira.md](jira.md#run-phase-5a)
- `POST /api/agents/jira-stop` — stops that key's live session through the dashboard (`session-stop.util.ts`, shared with the item abort) and clears its map entry;
  never calls Jira. `JiraLiveReconciler` clears entries whose session the dashboard no longer lists as working.
- `GET /api/agents/watchdog`, `POST /api/agents/watchdog/config` — the run watchdog's live state, read out of this process's own memory and the settings file it
  owns, plus the four server-side knobs behind it.
- `GET /api/agents/merge-check` — a local, read-only look at whether a project's main tree is in a state that can receive a merge.
- `GET /api/agents/branches?project=` — that project's local branch names, for the Orchestrate sheet's base picker. Read per request, cached nowhere, and
  deliberately not annotated with which tree holds which branch: the sheet needs names, and where a branch is checked out is a question the run answers at merge
  time.

#### `agents/dashboards/` — the machine list and where a launch goes

`GET /api/dashboards` answers the `DashboardsView`: home's presentation and every remote (`name`, `url`, `bmUrl`, `host`, optional `account`, `models`,
`efforts`), the prefer `order`, the `strategy` and `threshold`, a `source` of `file`, `default` (no file) or `unreadable` (with the reason), and per machine
`tokenSet` and `tokenVar` — never a token. Four POSTs edit it, each behind `SameOriginPostGuard`, each answering the fresh view, and each a `409` naming the
file while it is unreadable: `/api/dashboards/entries` (add or replace a remote), `/entries/delete`, `/home` (home's account, models and efforts) and
`/settings` (order, strategy, threshold). An entry may leave `bmUrl` and `host` blank, and the server stores their defaults — `http://<url's host>:5177`
(`defaultBoardUrl`, `shared/agent.ts`) and the entry's name. A malformed body is a `400`, an unknown entry to delete a `404`. The file's rules are in
[invariants.md](invariants.md#dashboardsjson-has-exactly-one-writer-the-server-and-a-file-that-cannot-be-read-is-never-replaced).

`GET /api/dashboards/offers?project=<abs path>` answers which machines can run that project, in prefer order, each with `offered` (and, when not, the one
reason), its usage and what it can run, plus the `suggestion` among the offered ones. It is always a `200` once the query is well formed — a machine that cannot
be reached is an answer, never an error. A files project, or a setup with no remote, gets home alone with no usage fetched. Otherwise every machine is judged at
once, and a remote is offered only if its dashboard answers, its board (`GET <bmUrl>/api/projects`, no `Authorization`) lists the same GitHub repo — identity is
`owner/name`, never a disk path — with sync on, and that dashboard lists the project's path on its own disk. Usage comes from the dashboard's own `account` and
`usage/profile` routes, cached 60 s per dashboard and read as none once older than ten minutes; the suggestion never picks on usage a machine does not have.

`GET /api/dashboards/machines` answers `MachinesStatus { machines: MachineStatus[] }` — each machine's health (`enabled`, `reachable`, `remoteAnswer`,
`spawnAvailable`, `spawnMaxPermission`, and `error` when the probe failed) plus its `usage` and `usageAgeMs` — for Settings › Dashboards, which has no project
to ask the offers about. Home first, then the remotes in FILE order (an unreadable file is home alone); read-only, unguarded and always a `200`, because an
unreachable machine is `reachable: false` with its error, never an error. It carries no URL and no token: a `MachineStatus` is built field by field. Each
machine is asked `GET /api/health` only (never `/api/configs`, so a remote's dot never depends on a project) within home's 4 s budget or a remote's 5 s, and its
usage — the same 60 s cache the offers share, 5 s budget — only when that answer says `enabled && reachable`, so `BM_AGENTS` off makes no outbound call at all,
home included. Machines are asked in parallel and health-then-usage within one, so the worst case is about 10 s for a remote. Unlike the offers, home's usage is
read under a `default` source as well, since the page draws home's meters either way.

##### Launching on another machine

A remote launch is for a GitHub tracker project only (a files project is a `400`) and goes to the dashboard of the machine named in `machine`: an id the file no
longer holds is a `400` (`unknown machine`), `finish` and `mergeMode` are held to `pr` (absent means `pr`, another value is a `400`), `model` and `effort` must
be on that machine's list (else `400`; no model sent means `DEFAULT_MODEL` if it is listed, else the first listed), the offer is judged again at launch time,
and the session starts at the project's path on THAT machine, read from its board. The `409`s, in the order a launch meets them: `<id> is already starting on
<label>`, `<project> is already starting on <label>`, `a run of <repo> is live on <label>` and `<label> is not offered for <project>: <reason>`. A remote run
never blocks a local one, and a live remote run blocks only a second orchestrate to the same machine. A launch is remembered in `RemoteStartingService` (see
`orchestrator/`) until that machine shows it landed: a card dispatch, once a claim by its host newer than the launch is on the item, released or not (a capture
is never remembered); an orchestrate, once a run on its host shows.

`POST /api/items/abort` routes by where the work is: a dispatch record names its machine and the stop goes to that dashboard; with no record, a claim whose
`host` equals a configured remote's `host` stops there; otherwise the stop is today's, checked against `BM_MACHINE_NAME`. Either way the release follows the
stop, and a record whose machine has since left the file is a `409` (`<id> was dispatched to <machine>, which is no longer configured`). `resume`, `pause` and
the run `stop` stay home-only: they act on a run file, and a remote run has none here — the board draws a remote run read-only.

Every new outbound read — the offers' dashboard and board reads, usage, and a remote's status — is held to 5 s. Home keeps its 4 s health and 15 s management
reads, and every spawn and stop keeps 10 s.

`BM_AGENTS` off turns away `dispatch`, `dispatch-jira`, `orchestrate` and `resume` — the four that spawn something (`jira-stop` answers 409 with the same sentence). `status` exists to report that gate, so it answers either
way, and `pause`, `watchdog`, `watchdog/config` and `merge-check` never call the dashboard at all: two read this process's own state, one writes its own
settings file, one looks at local git. `pause` being independent of the switch is deliberate rather than incidental — a pause is a fact on this machine's own
disk about a run that is already going, so gating it would mean a run started while dispatch was on could never be stopped after somebody turned it off.

The run watchdog lives here too (`watchdog.service.ts`), armed only while some `run.json` says `running`.

### `orchestrator/`

A read-only view of the orchestrator's run-state directory:

- `GET /api/orchestrator/runs` — every project's current `run.json`, re-read fresh on every request, which is what lets the board watch a run's heartbeat live;
  plus the runs this server has itself just asked for and whose run file does not exist yet (`starting`); plus, in a separate `remote` array (task-48), the
  runs other machines drove on a tracker project, derived from the poller's cached claim comments by `remote-runs.service.ts` — never members of `runs`, so
  this machine's lock and watchdog never see them, and dropped whenever a local run file carries the same `runId`. A third array, `remoteStarting`, holds the
  launches this server sent to a remote dashboard that no claim shows yet (below); like `starting`, it is in memory only and is never a member of `runs`.
- `GET /api/orchestrator/archive` — every run a project has ever produced, current and archived alike.
- `GET /api/orchestrator/archive/run` — one run file verbatim, gated by an id pattern and an allowlist built the same way item bodies are.

`orchestrate.mjs` is that directory's only writer; this module never writes it and never caches it. Beside those endpoints sit three pieces of state this module
owns: `watchdog-state.service.ts` (in memory — what the watchdog did, annotated onto `/api/orchestrator/runs` as `watchdog` on crashed runs only),
`remote-starting.service.ts` (in memory — a launch sent to a remote machine's dashboard — a card dispatch keyed by (project, item), blocking that item on every
machine, a remote orchestrate keyed by (project, machine), blocking only a second one to that machine — surfaced as `remoteStarting` and NEVER in `starting`,
because `starting` blocks home's own lock and a remote launch must block none of it; it clears on a claim by the host above the floor recorded at mark time
(live or released), on a remote run of that project on
that host starting at or after `requestedAt`, or past `RUN_STALE_MS`, and is swept whenever the payload is read), `remote-runs.service.ts` with its pure half
`remote-runs.util.ts` (no state at all — other machines' runs, re-derived per request from the poller's cached
claim comments into the payload's separate `remote` array), `starting-runs.service.ts` (in memory — a spawn this server itself requested, surfaced as the payload's separate `starting` array so a board-started run is
visible before `init` writes a run file), and two files it genuinely writes: `watchdog-config.util.ts`, the first file the server ever wrote, and
`pause-control.util.ts`, the second — the pause request `orchestrate.mjs` reads back at its two dispatch gates, the one file in this system travelling server →
tool. The third, `settings/tracker-sync.json` (#17), is written through `tracker-sync.controller.ts` here and owned by `tracker/sync-config.util.ts` — see
"Each repo on its own interval" under `tracker/` for why the route lives in this module.

### `hub/` — Hub widgets

`/api/hub/widgets` serves Lookout's widget catalog contract v1 through the `lookout-widgets` package (#249): `hub.controller.ts` hands every method and path
under that prefix to the package's handler, which owns the contract's routing and answers 404 for anything not declared. `hub-widgets.ts` declares three tiles,
the first two opening `/`, and since #328 the `run` tile `/?section=runs&runs=history` — a deep link `client/src/lib/deep-link.ts` reads,
because the client has no URL routing and otherwise opens on whatever section localStorage holds:

- **`open-total`** (stat, 60 s) — open bugs plus open tasks across every registered project; `warn` while any bug is open. Ideas and refactors are not work
  until promoted.
- **`projects`** (list, 60 s) — one row per registered project, keyed by path, its non-zero open sections as the subtitle; a missing store is `error`, an
  unsupported source `warn`.
- **`run`** (status, 15 s) — this machine's run files reduced to one state, worst wins: crashed, then paused or needing a person, then running. A finished run
  is `idle`. `remote` is ignored, the posture the watchdog takes. `lines` gives each non-idle run one line, worst first (ties in run order): its project,
  `<finished>/<total>` (queue items past every claimed stage, over the queue) and that run's own state. No `detail`.

Read-only by construction: no widget declares an action, so every POST is the package's 404. The package does no authentication and Lookout's POST carries no
`Origin`, so an action could not pass the guard every other POST here carries — that is why there are none, not an omission. `hub.module.ts` reads
`OrchestratorService.runs()`, the pure read, never `OrchestratorController.runs()`, so a hub poll neither arms the watchdog nor sweeps starting entries.

The package declares its types only through `package.json#exports`, which this repo's `moduleResolution: "node"` ignores. `hub/lookout-widgets.d.ts` is an
ambient shim that re-exports the dist types; `compilerOptions.paths` was the other option, and is wrong here because `nest build` rewrites any import matching a
`paths` entry into a relative path to the mapped file — a `.d.ts`, at runtime. The shim's header has the detail.

### `releases/` — this app's own versions

`GET /api/releases` answers `{ current, releases }` (`shared/types.ts`'s `ReleasesResponse`) from the annotated `vX.Y.Z` tags in this server's own checkout —
the ones the release workflow cuts (docs/workflows/ci.md §Releases) — for the side rail's version chip and its What's new drawer. Read-only, git only — not an
outbound-calling module: four `runGit` reads and nothing else. The root is `BM_RELEASES_ROOT` when set (the test seam), else the first ancestor of the server's
own files holding a `.git` entry, never `process.cwd()`.

The read is release-kit's memoised `createReleasesReader` (spec D3 of release-kit's `docs/superpowers/specs/2026-10-18-shared-releases-ui-design.md`),
handed `runGit` as its git port, so every launch — the memo key's `rev-parse` included — is async and bounded at 10 s rather than release-kit's own `execFile`;
`test/api-releases.test.ts` pins that every one of the four goes through `runGit`. Every failure is a shape, never a status: `for-each-ref` failing is the empty shape, `describe` failing is
`current: null` with the releases kept, an origin that is not GitHub (or none) drops `url`. The memo is keyed by HEAD and the mtimes of `packed-refs` and
`refs/tags` under the common git dir — a linked worktree's own git dir holds no tags — and a read in which a deciding call failed is never memoised.

### `tick/` — the tick breaker's board

`GET /api/ticks` answers `{ config, projects }` (`shared/types.ts`'s `TicksPayload`). It reads `$BM_TICK_HOME` (else `~/.backlog-manager/tick/`) fresh on every
call and caches nothing, and it writes nothing there: the tick home's one writer is `skills/backlog-tick/tools/tick.mjs`. One row per project directory; the
name is the directory's `decodeURIComponent` (the project's absolute main-checkout path), and a directory whose name does not decode, decodes to a relative path
or does not re-encode to itself is skipped rather than failing the list. A row is `{ root, name, streak, halted, haltedSince?, resetAt?, lock, recent, lastDecide?,
error? }`
— `name` is the registry's, else the path's basename; `lock` is the lock file's `{ kind, id, host, at }` or `null`; `recent` is `state.json`'s records newest
first; `lastDecide` (#367) is `last-decide.json`'s `{ at, verdict, caps: { openPrs, maxPrs, planReview, maxPlans } }`, rebuilt field by field and absent when
the file is missing or any field is the wrong shape — it rides on an errored row too, since it is a separate file; `error` is set, with `recent` empty, when
`state.json` exists and cannot be read. `streak`, `halted` and `haltedSince` come from `streakOf` in
`tick-breaker.util.ts`, the server's copy of the rule `tick.mjs decide` applies, and `config` is `{ haltAfter, source: 'file' | 'default' | 'unreadable', error?
}` — `unreadable` reports `haltAfter` 3 for display only. `tick/` is not an outbound-calling module: files only, no network.

Two POSTs, both behind `SameOriginPostGuard` (content-type and origin, like every agents POST) and the only writes this module makes. `POST /api/ticks/config`
`{ haltAfter }` is a `400` for anything but an integer, clamps to `TICK_HALT_LIMITS` (1–10), and answers the new `TicksPayload`. `POST /api/ticks/reset` `{
project }` is a `400` for anything but an absolute-path string, a `404` when the tick home has no directory for it, and otherwise stamps `resetAt[project] =
max(now, the newest parseable at in its recent)` into `settings/tick.json` and answers the new payload; it is allowed in every state and touches no lock. Both
are a `409` naming the file when `tick.json` exists and cannot be read — `TickFileUnreadable`, thrown before any write, so the file is left byte-identical. The
write itself (`writeTickFile`) is a temp file in the same directory plus a `rename`, with `resetAt` merged key by key. The invariants are
[`tick.json`'s](invariants.md#tickjson-has-exactly-one-writer-the-server-and-a-file-that-cannot-be-read-is-never-replaced) and [the
halt's](invariants.md#a-tick-halt-is-derived-from-the-records-and-the-reset-time-never-stored-and-only-a-persons-reset-clears-it).

### `settings/` — the shared time zone

`GET /api/settings/timezone` answers `{ timeZone }` (`shared/types.ts`'s `TimeZoneSetting`) — the IANA zone every device draws the board in (#241), or `null`
when nobody has chosen one and each browser keeps its own. It reads `~/.backlog-manager/settings/timezone.json` (`$BM_TIMEZONE_FILE` to override) fresh on
every call and caches nothing; every way the file can fail to name a zone — missing, not JSON, not an object, an id the platform rejects — reads as `null`,
the parse and shape failures with a warning. The default is `null` and NOT this host's zone: the API runs in a container whose zone is `UTC` unless `TZ` is
set, so defaulting to it would move every reading by hours for a person who never opened Settings.

`POST /api/settings/timezone` `{ timeZone }` is behind `SameOriginPostGuard` and is the file's one writer (`writeTimeZone`, temp file plus `rename`). A zone the
platform accepts is canonicalised through `Intl.DateTimeFormat`'s `resolvedOptions()` — `etc/utc` is written and answered as `UTC` — `null` unsets it, and
anything else (an unknown id, a non-string, a missing key, a non-object body) is a `400`, file untouched. Unlike `tick.json` and `jira.json`, a file that
cannot be read is replaced by the next write: it holds one value and the write replaces that value whole, so there is nothing in it a write could lose. The
server never formats or buckets a date itself; every reading is the client's (`client/src/lib/time-zone.ts`). Not an outbound-calling module.

### `health/`, `static.ts`, `security.ts`, `allowed-hosts.ts`

`GET /api/health` is a plain liveness check. `static.ts` serves `client/dist` only when it has been built — registering the static module against a missing
bundle would install a catch-all with nothing behind it. `security.ts` is the one applier of both pieces of request-and-response middleware this app has
(`applySecurityMiddleware`): the Host gate first, then the CSP whose `script-src` pins the pre-paint theme script by hash. It is configured on the root module
so every app built from `AppModule` carries both, the tests' included, and ahead of the static module so both reach the served `index.html`.

`allowed-hosts.ts` is that gate: `isAllowedHost` refuses any `Host` header that is not an IP literal, `localhost`, a `.ts.net` name or an entry in
`BM_ALLOWED_HOSTS`, with 403 and `{ error }`. It answers the question the origin guard cannot — which host was this request _addressed_ to — and so closes DNS
rebinding, which satisfies that guard with two matching lies. Global rather than scoped to `agents/`, because the read routes are exposed to the same page.

## Interfaces

- **The registry file** — read per request, never written, never cached. Its only writer is `skills/backlog/tools/backlog.mjs`.
- **Each project's store** — read-only, always. Every write goes through the skills. Its `backlog/source.json`, when present, names the tracker that owns its
  items ([spec](../superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)).
- **The run-state directory** — read fresh per request. Its only writer is `skills/backlog-orchestrate/tools/orchestrate.mjs`; the server re-derives the
  directory path with its own copy of the same function rather than importing the `.mjs` tool.
- **`../claude-agents-dashboard`** — reached only from `agents/`, at an env-only URL, and never by the browser: every call goes board → this API → dashboard.
- **Remote dashboards and remote boards** — reached only from `agents/dashboards/`, at the `url` and `bmUrl` of an entry in `settings/dashboards.json`, with the
  dashboard's token read per call from `BM_AGENTS_TOKEN_<NAME uppercased>` and no token ever sent to a board, and never by the browser. The same module as
  the line above, not a fourth outbound-calling one.
- **`api.github.com`** — reached only from `tracker/`, with a token read per call from `BM_GITHUB_TOKEN`, and never by the browser: every call goes board → this
  API → GitHub, and the token reaches no payload.
- **`api.atlassian.com`** — reached only from `jira/`, through the gateway path `/ex/jira/<cloudId>/rest/api/3`, with Basic credentials read per call from
  `BM_JIRA_EMAIL` and `BM_JIRA_TOKEN`, and never by the browser. Two calls go to the site itself (`https://<BM_JIRA_SITE>`): the unauthenticated `tenant_info`
  that yields the `cloudId`, and the one `myself` probe that tells a classic token from a scoped one.
- **The tick home** — `~/.backlog-manager/tick/`, read fresh per request by `tick/` and never written by this server; its only writer is `tick.mjs`. The one
  file this server writes for the breaker is `~/.backlog-manager/settings/tick.json`, beside the watchdog config.
- **The client** — same-origin `fetch` against these routes, plus the built bundle when `static.ts` finds one.
- **A Lookout hub** — polls `/api/hub/widgets` server-side over the tailnet, read-only; the existing `.ts.net` Host allowance is what admits it.

## Invariants

The rules these modules are held to, and the failures behind them, are in [invariants.md](invariants.md) — the single-writer relationships, the allowlist, the
origin guard, the derive-never-accept rule for dispatch, and the watchdog's arming conditions. They are not restated here; one home per fact.

<!-- docs-sync:
  sources:
    - server/src
  kind: subsystem
  verified: 5a74ebf0f276cf9103c7a744f913c01f02e178f5
-->
