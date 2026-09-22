# Per-repo tracker sync interval — design

Date: 2026-09-22. Status: approved in chat (mock A), awaiting spec review.

## 1. Why

The tracker poller (`server/src/tracker/poller.service.ts`) walks every connected repo every `TRACKER_POLL_MS` (15 s), in series, two requests per repo per
tick. A repo nobody on this machine is working on still costs that — rate limit, tick time, and a board refetch every 15 s. The user wants to slow a repo's
sync down, or switch it off, per project, from Settings.

Only TRACKER projects sync on a timer. A `files` project reads disk and git per request and has nothing to switch off; this feature does not touch it.

## 2. Decisions taken in chat

- The unit is the tracker issue poll — not the board refetch, not the git reads for `files` projects.
- The control is a picker with four values: `15s` (the default, today's behaviour), `1m`, `5m`, `off`.
- `off` means **frozen and refusing writes**: the board keeps the last cached items, every write path for that project refuses until sync is on again.
- The UI is mock A: one `Segmented` pill per tracker row on the Shared › `Trackers · this machine` card. Rejected: B (a switch plus a select — two controls
  per row for one setting), C (a pause chip on the board band — on/off only, and it puts a control into a band that holds only readings).

## 3. Non-goals

- No committed setting. A repo's interval is a fact about THIS machine's attention, not about the project; two machines on one repo choose independently.
  That rules out a field in `backlog/source.json`, which the server must not write anyway.
- No env var. It could not vary per repo and has no UI.
- No "sync now" button. Turning a repo from `off` to any interval syncs it on the next tick, which is the same thing one click later.
- No change to `files` projects, the claim protocol, or the poller's existing backoff (`retryAfter`, secondary limits).

## 4. The setting's home

**File.** `~/.backlog-manager/settings/tracker-sync.json`, overridable by `BM_TRACKER_SYNC_FILE` for tests — the same directory and the same reason
`watchdog-config.util.ts` gives for `settings/`: `docker-compose.yml` mounts `~/.backlog-manager` read-only and `settings/` is the one read-write directory
carved out of it. This is the third file the server writes; the invariants entry that enumerates them grows by one.

**Shape.** An object keyed by `owner/name` repo, each value one of the four interval tokens. Keyed by repo rather than by project path because the repo is
the unit the poller syncs (`connectedRepos` already dedups by repo), so two registered projects on one repo cannot disagree.

**The enumeration has one home**: a constant in `shared/types.ts` mapping each token to its milliseconds (`off` to none), read by the server's validator,
the poller, and the client's picker. The picker's labels are that constant's keys, not a second list.

**Reading.** Fresh on every tick and every GET, never cached — the watchdog config's rule, for the same reasons. Every failure reads as the default, never
throws:

| Input                                           | Reads as                                   |
| ----------------------------------------------- | ------------------------------------------ |
| file missing                                    | every repo `15s`                           |
| file not JSON, or not an object                 | every repo `15s`                           |
| a repo with no key                              | `15s`                                      |
| a key whose value is not one of the four tokens | `15s` for that repo, the others unaffected |
| a key for a repo no longer connected            | ignored, kept in the file                  |

**Writing.** Only through the route in §6, which rewrites the whole file via temp file + rename — the watchdog writer's pattern. Keys for disconnected repos
survive a write, so reconnecting a repo restores its setting.

## 5. The poller

The base tick stays `TRACKER_POLL_MS`. All four intervals are multiples of it, so the tick is the resolution and nothing needs a timer per repo.

- **Per-repo last-sync time**, in `RepoState`, in memory — set when `syncRepo` completes, success or failure alike, so a failing repo is not retried faster
  than its interval.
- **`sweep` syncs only the repos that are due**: interval not `off`, and no last-sync time or at least one interval elapsed since it. A repo changed to a
  faster interval is due immediately if its last sync is already older than the new interval.
- **An `off` repo still gets exactly one sync per process** — the cold-boot sync — when its cache has never been filled. Without it, a restart leaves an
  `off` repo's board columns empty forever with `connecting…` beside them, which is a worse lie than a stale age. After that sync it is skipped.
- **`shouldPoll`** (the armed condition) becomes: a token, and at least one connected repo that is either not `off` or still owed its cold-boot sync. So a
  machine with every repo `off` disarms entirely after the cold syncs — the same "armed only while something is connected" invariant, with "connected"
  narrowed to "connected and on".
- **Changing a setting re-arms.** The route calls `arm()` after writing; `arm()` already no-ops when a chain is alive and disarms when `shouldPoll` is false.

**Remote runs** (`remote-runs.service.ts`) derive nothing for an `off` repo, the same "says nothing" a never-synced repo gets. A frozen comment cache would
otherwise show another machine's run as live for as long as sync stays off — the same phantom bug-55 fixes, arrived at by a different road.

## 6. The route

`POST /api/trackers/sync` with `{ repo, interval }`, in `tracker.controller.ts`, guarded like the agents POSTs (content type and origin — the existing guard,
not a new one). The tracker module stays one of the two outbound-calling modules; this route calls nothing outbound.

| Request                                                                                          | Answer                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `repo` not a string, or fails `isRepo`                                                           | 400                                            |
| `repo` not among `connectedRepos()`                                                              | 404                                            |
| `interval` not one of the four tokens                                                            | 400                                            |
| `interval: "off"` while a project on that repo has a run file reading `running`, or a `starting` entry | 409, `{ error }` naming the run            |
| anything else                                                                                    | 200 with the repo's new row (same shape as §7) |

The 409 exists because a live run's driver claims, releases and writes through this server, and every one of those refuses while `off` (§8) — switching a
repo off under a running drain would park it at its next write. Setting any non-`off` interval during a run is allowed; slowing a live run's sync is the
user's call and costs only latency.

## 7. The read

`GET /api/trackers` gains, on each `TrackerProjectRow` whose source is `github`, an `interval` field holding the effective token (after §4's defaults). Rows
for `files`, `unsupported` and store-less projects carry `null`. `ProjectSummary` gains the same field, because the board's band line and the dispatch gate
read the project payload, not the trackers route.

## 8. What `off` refuses

Every refusal names the repo and the fix: `sync is off for <owner/name> — turn it on in Settings › Shared › Trackers`.

- **The seven `/api/items/*` write routes**: 409 with that wording, checked after the project lookup and before any outbound call, inside the existing
  per-item serialisation.
- **Dispatch** (`POST /api/agents/dispatch`) and **orchestrate spawn**: the same 409, server-side.
- **The board**: a per-project dispatch block, `disabled` with that reason — NOT hidden. It is a project-scoped block like the starting-entry one, not an
  environment-level one (`environmentBlock`), so the invariant "environment-level blocks hide, per-item ones disable" puts it on the disabled side. The
  Orchestrate sheet lists the project as unavailable with the same reason. The derivation is one function in `lib/tracker.ts`, the one home tracker readings
  already have.
- **`backlog.mjs`** in that project: prints the route's `error` verbatim and exits non-zero through the tool's existing refusal path. It is not exit `5` —
  the stack is up, the setting is the refusal.

## 9. The UI

- **Shared › `Trackers · this machine`**: each `github` row gets the `Segmented` pill (`pill` prop, as the Settings rows already use it) in its right slot,
  the four tokens as its options. `files` rows keep no control. The card stops being a card that "reports and never sets"; its header comment and DESIGN.md
  §8.6's sentence saying so both change. Selecting a value POSTs; the pill shows the server's answer, not an optimistic one, and a 409 renders the refusal as
  the row's hint until the next read.
- **Poll-age wording** (`lib/tracker.ts`, the band line and the Trackers row alike): an `off` repo reads `futin/x · sync off · polled 3 h ago`. A slowed repo
  needs no new wording — its age simply grows larger between polls, which is true.
- **`useBoard`** arms its 15 s refetch only while some tracker project's interval is not `off`, derived from the same `projects` payload it already reads.
  Its interval stays `BOARD_TRACKER_POLL_MS` whatever the repos' intervals — a slow repo's refetch is a cheap cache read, not a GitHub call.

## 10. Docs and rules

- `docs/subsystems/invariants.md`: the entry listing the files the server writes gains `tracker-sync.json`; the poller-is-armed entry gains the narrowed
  condition and the cold-boot sync; a new entry for §8's refusals and the §6 409.
- CLAUDE.md: one new invariant headline for the refusal rule, linked to that entry; the existing token/poller headline is unchanged.
- `.claude/rules/tracker.md`: the mechanism bullets for the file, the due-check and the refusals — anchored per `test/claude-rules.test.ts`.
- `docs/subsystems/api.md`: the new route, the new field on both payloads.
- `.claude/DESIGN.md` §8.6: the Trackers card now sets one thing.

## 11. Tests

Jest, flat in `test/`, supertest suites through `listenLoopback`.

- **Config reader**: every row of §4's table, each as its own case; a write followed by a read round-trips; a write preserves a disconnected repo's key.
- **Scheduling** (`test/tracker-sync-interval.test.ts`, driving `tick()` with a controlled clock):
  - two repos at `15s` and `1m`: over four ticks the first syncs four times, the second once;
  - a repo at `off` with an empty cache syncs exactly once, then never, over the following ticks;
  - every repo `off` after their cold syncs: `armed` reads false;
  - `off` → `15s` through the route: the repo syncs on the next tick and `armed` reads true;
  - a repo whose sync fails still waits a full interval before the next attempt.
- **Route**: each row of §6's table, including the 409 for a `running` run file and for a `starting` entry, and the guard's refusal of a wrong content type
  and a foreign origin.
- **Refusals**: one write route and dispatch each answer 409 with the §8 wording for an `off` repo, and make no outbound call (the fake client records
  none).
- **Remote runs**: an `off` repo with a cached live claim derives no remote run.
- **Client** (jsdom): the Trackers row renders the pill with the effective value selected and none on a `files` row; the band line reads `sync off`; the
  dispatch control is disabled with the §8 reason; `useBoard` creates no interval when every tracker project is `off`.
- **Pins**: the client's picker options equal the shared constant's keys.

## 12. Sequencing

The uncommitted bug-55 work edits `poller.service.ts`, `github.client.ts` and `test/helpers/github.ts`, which this feature also touches. It lands first; this
branches from the commit that contains it.
