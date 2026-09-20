---
id: task-48
title: Tracker-backed phase 4b: runs visible from every machine - runs derived from claim comments, read-only remote runs, attention comments, reconcile from claims
created: 2026-09-19
from: idea-12
tags: architecture, multi-machine, tracker, github, orchestrator, runs
runner-fix: true
updated: 2026-09-20T06:42:00Z
groom-elapsed: 275
groom-tokens: 86036
started: 2026-09-19T20:36:31Z
execute-elapsed: 36329
execute-tokens: 805253
---

## Goal

The second half of phase 4 of the tracker-backed direction ([spec §7.3, §7.6](../../../docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)).
Phase 4 was split on 2026-09-19. task-47 (4a) lets one machine orchestrate a tracker project and writes each item's machine state into its claim comment.
This item makes that state **visible from every machine**, which is the spec's §13 visible result for phase 4: "Runs visible from every machine".

Scope, from spec §7.3 and §7.6:

- **Runs are built from claims.** The server assembles `OrchestratorRun` from cached claim comments grouped by `state.run.runId`. `status` is `running`
  while any claim in the group has a live heartbeat and none carries `finished`; otherwise it is the last-touched claim's recorded outcome.
  `orchestrate.mjs finish` stamps `finished: { at, status }` on the run's last-touched claim. Decide here how a derived run and a local `run.json` for the
  same `runId` merge. The local journal is the richer record; the derived one is what another machine sees.
- **A remote run is read-only.** Controls render only on the machine whose run-state directory holds the run's `run.json`. Pause, resume, abort and the
  watchdog are local mechanisms. The Runs page says a run is remote instead of drawing controls that would do nothing.
- **Attention becomes a comment.** `<!-- bm:attention kind=… -->` plus an `@mention` of the token's user, so a phone notification replaces the strip
  badge. In 4a attention stays in `run.json` only.
- **`reconcile` reads claims** for a tracker project where it reads `run.json` for a files one.
- A run whose queue never claimed an item has no comment and is invisible from other machines. The local journal still has it; state this on the page
  rather than hiding it.

**Plan against the code as it stands once task-47 has merged**, per spec §13. task-47's `## Outcome` records the claim `state` shape it shipped and every
deviation it took. Read that first.

## Plan

Groomed 2026-09-19, after task-47 merged (`c1c0851`), against the code on `main` at `31e2971`. **The user was away and no question channel was available.
Every "Decision" below is the groomer's assumption, not the user's ruling.** Each one names the alternative it rejected, so it can be overturned without
re-reading the code. The plan gives behaviour, signatures and test cases. It does not give literal code: where this plan and your reading of the code
disagree, the code wins, and you record the disagreement in `## Outcome`.

### What exists today (read before starting)

- `ClaimRecord` (`shared/types.ts`) carries `run?: ClaimRun` (typed) and `state?: unknown` (opaque). `ClaimState` is exported and nothing reads it yet.
- `server/src/tracker/claim.ts` is pure: `parseClaim`, `claimsByIssue` (the whole repo in one pass), `isLive`, `newestClaim`, `winner`.
- `TrackerPollerService.comments(repo)` gives the cached repo-wide comments. `issue(repo, n)` gives a cached issue.
- `OrchestratorService.runs()` is a pure read of the run-state directory, with ONE entry per project. `AgentsService` calls it directly for the
  `RUN_IN_PROGRESS_CODE` lock and for `resume()`. `WatchdogStateService.observe(payload)` reads `payload.runs`.
- `GithubSource.heartbeat` refuses a RELEASED claim (`… is released — nothing to heartbeat`). By the time `finish` runs, the last-touched item's claim is
  normally released already, because a terminal stage released it. So "stamp `finished` on the last-touched claim" (spec §7.3) needs a route change.
- In `orchestrate.mjs`: `cmdFinish` and `cmdAttention` touch only `run.json`. `cmdHeartbeat` stamps only `run.json`, so during a long review no claim is
  heartbeated. `cmdReconcile` reads `run.json` plus the worktree's item file, and a tracker item has no item file, so `marker` is always `false`.
  `item.claim` stays set after a release, so "holds a claim" means `item.claim !== undefined && !CLAIM_RELEASE_STAGES.has(item.stage)`.
- The client Runs page (`client/src/components/runs/RunsView.tsx`) builds rows with `mergeRuns(archiveRuns, liveRuns)` and splits them with `splitLive`.
  `RunDetail` draws `RunControls` in its head.

### Decisions (the groomer's assumptions)

1. **Remote runs ride a separate top-level `remote` array on `OrchestratorRunsPayload`. They are never members of `runs`.** This is the precedent `starting`
   set. `runs` stays "this machine's run files, one per project", so three things stay local-only without any change: the `RUN_IN_PROGRESS_CODE` lock,
   `runClaimBlock`, and the watchdog. §7.4 requires this: two machines draining one project must NOT block each other; the claims keep them disjoint.
   Rejected: `runs` entries with a `remote: true` flag. That puts a remote run inside every reader that assumes one run per project, and it would 409 a
   local Orchestrate because another machine is running.
2. **The derivation lives in a new `RemoteRunsService` in `server/src/orchestrator/`, with its pure half in `remote-runs.util.ts`.**
   `OrchestratorController.runs()` sets `payload.remote`. `OrchestratorService.runs()` stays exactly as it is, the run-state directory's one reader.
   `OrchestratorModule` imports `TrackerModule` and `RegistryModule`. There is no cycle: `TrackerModule` imports only `RegistryModule`.
3. **The same `runId` locally and remotely: the local one wins, and the derived one is dropped.** A derived run is dropped when its `runId` equals the
   `runId` of any run file on this machine: the current `run.json` of any project, or any archived `runs/*.json`. Use `archivedRunFiles` for the second
   set. Do not glob the directory yourself (invariant: `archivedRunFiles` is the one implementation). The local journal is the richer record, and it is
   the one this machine's controls act on. Nothing merges field by field. Rejected: overlaying claim state onto the local run. That creates two sources
   for one field and makes "which one is right" a per-field question.
4. **A remote run's `project` is THIS machine's registry path for the repo, never the path the claim came from.** A claim carries no path, and the other
   machine's path means nothing here. Group by `(repo, runId)`. Map the repo to the registered project whose `resolveSource` answers `tracker` with that
   repo. A repo that no registered project resolves to contributes nothing (the poller would not be polling it anyway).
5. **Derived status does NOT follow spec §7.3's "else the last-touched claim's outcome". Rule:**
   - Take `F`, the newest `finished` stamp in the group, by `finished.at`.
   - If `F` exists and no claim in the group has a `heartbeat` later than `F.at`, then `status = F.status`.
   - Otherwise `status = 'running'`, with `fresh` = the newest heartbeat in the group is younger than `RUN_STALE_MS`.

   The spec's rule would report a crashed run (all heartbeats stale, never finished) as a finished outcome. This rule keeps it `running && !fresh`, which
   the Runs page already renders as crashed. That keeps the rule "a crashed run renders as crashed, never as nothing". The "heartbeat later than `F.at`"
   clause handles a paused run that was later resumed: its re-claims heartbeat after the `paused` stamp, so it reads as running again.
6. **`finished` is stamped through the EXISTING heartbeat route, so there are still seven write routes.** `ItemHeartbeatRequest` gains
   `finished?: { at: string; status: 'done' | 'aborted' | 'failed' | 'paused' }`, and `ClaimRecord` gains the same optional field.
   - A heartbeat carrying `finished` is accepted on a released claim too.
   - When the claim is released, that heartbeat sets `finished` ONLY. It moves neither `heartbeat` nor `state`, and never un-releases anything.
   - On an unreleased claim it sets `finished` and otherwise behaves like any heartbeat.
   - A released claim with no `finished` in the request is still refused exactly as today.

   Rejected: an eighth route. Adding one would change the "seven write routes" count in CLAUDE.md, invariants.md, the origin-guard route list and the
   docs, for one field.
7. **`finish` stamps the run's LAST-TOUCHED claimed item.** That is the queue item carrying `claim` whose newest `stageAt` value is latest. The stamp is
   best-effort, exactly like `trackerHeartbeat`: a failure is one stderr line and `finish` still exits `0`, because `run.json` is the journal of record.
   A run with no claimed item stamps nothing and prints nothing.
8. **An attention entry is a COMMENT on the item's issue, posted by `orchestrate.mjs attention` through the existing `POST /api/items/comment` route.** It
   is also still written to `run.json`, unchanged. The comment body is:
   - line 1: `<!-- bm:attention kind=<kind> run=<runId> -->`;
   - then a blank line and `@<login> ` followed by the detail text.

   `<login>` comes from `GET /api/trackers` (the platform's `login`). If no login is available, omit the mention and keep the rest. Posting is best-effort:
   a failure is one stderr line and the command still exits `0`. The server parses the marker with a strict regex (kind from `ATTENTION_KINDS`, run id
   shaped `run-YYYYMMDD-HHMMSS`). Anything else is not an attention comment. The CLI cannot import the server's TypeScript, so the marker literal lives in
   two places. They agree through a SOURCE-READING guard test, the way `labels.ts` and `connect`'s issue forms already agree, never through an import.
   - **Known risk, stated rather than solved:** the token is the user's own, and GitHub may not notify a user of their own `@mention`. The comment is still
     the record, and the Runs page still shows it. Whether the phone actually buzzes is part of the live check in Done when. If it does not, the fix is a
     GitHub App identity (spec §15, deferred), not something this item works around.
9. **`heartbeat` (the command) also heartbeats every claim the run still holds.** Today it stamps only `run.json`, so a review or merge longer than 15
   minutes lets the in-flight item's claim go stale. Another machine then sees the run as crashed, and may contest and retire the claim. "Still holds"
   means: an item with `claim` whose stage is not in `CLAIM_RELEASE_STAGES` (so `needs-answers` IS included, per task-47 deviation 5). Each heartbeat is
   best-effort through `trackerHeartbeat`. A files run is byte-identical: no HTTP request.
10. **`reconcile` in a tracker project adds a `claim` field to each row, read from `GET /api/items/claim`.** The value is one of:
    - `'this-run'`: the newest claim is unreleased and carries this run's `runId`, stale or not;
    - `'other'`: the newest claim is LIVE and carries another `runId`, or none (a hand `start`);
    - `'released'`;
    - `'none'`: no claim ever;
    - `'unknown'`: the API is unreachable (one stderr line; the other columns are computed as today).

    On `'other'` the suggestion becomes `'skip'`, which `references/recovery.md` maps to `stage <n> skipped --note "claimed elsewhere …"`. Every other
    value leaves today's suggestion logic unchanged. A files run's output is byte-identical (no `claim` key at all). The only write is still none:
    `reconcile` remains read-only.
11. **Out of scope, recorded so nobody thinks it was forgotten:**
    - releasing a finished run's leftover `needs-answers` claims, which go stale on their own in 15 minutes;
    - `abort` releasing claims;
    - cross-machine pause/resume (spec §15);
    - showing remote runs on the Board's run chip. The Runs page is the §13 visible result; the Board already shows a remote claim on the card through
      `started`/`phase`.

### Steps

1. **Types (`shared/types.ts`).**
   - Add `ClaimRecord.finished?` and `ItemHeartbeatRequest.finished?`, with the shape from Decision 6.
   - Add `RemoteRun = OrchestratorRun & { fresh: boolean; remote: true; repo: string }`.
   - Add a REQUIRED `remote: RemoteRun[]` on `OrchestratorRunsPayload`. Required, so the compiler finds every fixture that builds a payload.
   - `ClaimRecord.state` stays `unknown` on the wire. The reader narrows it (step 2).
   - Update the `state` doc comment: it now has a reader, and the comment must say the reader is TOLERANT rather than typed.
2. **`server/src/orchestrator/remote-runs.util.ts`: pure, no Nest, no clock of its own.**
   - `readClaimState(raw: unknown): ClaimState` keeps each field only if it has the right primitive or array shape and drops the rest. It never throws. A
     claim from a newer build must "say less", not crash.
   - `parseAttention(comment): { kind; runId; detail } | null`.
   - `deriveRemoteRuns({ repo, project, comments, issueTitle(n), localRunIds, nowMs }): RemoteRun[]`:
     - Group claims that carry `run` by `run.runId`. Claims without `run` (hand claims) are ignored.
     - Queue: one item per issue number, from that issue's NEWEST claim in the group. `id` is the bare issue number as a string (the inside-a-run
       spelling). `title` comes from the cached issue, or `#<n>` when the issue is not cached. `stage` is `state.stage`, or `'preflight'` when the state
       has none. The other `RunQueueItem` fields come from the tolerant state, defaulted as `makeQueueItem` defaults them.
     - Order the queue by claim `at`, ascending.
     - `startedAt`, `base`, `mergeMode`, `questionMode` and `maxItems` come from `run`. Both `mergeMode` and `mergeModeEffective` take `run.mergeMode`,
       which is the effective one. `mergeModeNote` is `null`. `driver` is `null`.
     - `updatedAt` is the latest of every `heartbeat`, `released.at` and `finished.at` in the group.
     - `status` and `fresh` follow Decision 5.
     - `attention` holds the attention comments whose `runId` matches, `id` = their issue number.
     - Drop every group whose `runId` is in `localRunIds`.
3. **`RemoteRunsService.list(): RemoteRun[]`.** For each registered project that resolves to a `github` tracker, call `deriveRemoteRuns` over
   `poller.comments(repo)`, then concatenate. It makes no network request and has no cache of its own: every call re-derives from the poller's cache,
   which is the one cache. `localRunIds` = every project's current `run.json` `runId` plus `archivedRunFiles`' ids. `OrchestratorController.runs()` sets
   `payload.remote = this.remoteRuns.list(...)`. `OrchestratorService.runs()` fills `remote: []` so the service's own return type holds. The controller
   overwrites it. `AgentsService`'s direct `runs()` callers therefore see `remote: []`, which is Decision 1.
4. **The heartbeat route: `GithubSource.heartbeat` accepts `finished` (Decision 6).** Validate `finished` in `items-write.controller.ts`, field by field,
   exactly as the controller already rebuilds bodies: `at` must be a parseable ISO string, and `status` must be one of the four. Anything else is a 400.
5. **`orchestrate.mjs`, tracker mode only.** Each behaviour below goes through the existing `projectSource` branch, and a files run makes no HTTP request
   (task-47's closed-port proof O-1 must stay green and gain the three new commands).
   - `finish` stamps `finished` (Decision 7).
   - `attention` posts the comment (Decision 8). The marker literal is one `const` near `ATTENTION_KINDS`.
   - `heartbeat` heartbeats every claim the run still holds (Decision 9).
   - `reconcile` adds `claim` and `'skip'` (Decision 10).
   - Keep `process.exitCode = main(...)`. `api-call.mjs` stays the child that makes the HTTP call.
6. **Client.**
   - `useOrchestratorRuns` exposes `remote`. It polls while any local run OR any remote run is `running`.
   - In `RunsView`, `mergeRuns` also takes the remote runs. A remote run becomes a `MergedRun` whose `run` is the derived run (it has no archive entry),
     whose `live` is the remote entry, and which carries `remote: true`. `splitLive` is unchanged: a remote running run is a Live row and a finished one
     is a History row.
   - Each remote row shows a `remote` tag (one reading, `components/ui/`'s existing tag look; cite `.claude/DESIGN.md` §8 in the header comment).
   - `RunDetail` for a remote row:
     - renders from the payload entry and never calls `GET /api/orchestrator/archive/run`, because there is no file;
     - draws NO `RunControls`, and in their place one line: `Remote run: its controls are on the machine that ran it.`;
     - under the queue, one line: `Items this run has not claimed yet are not visible from here.`
   - `RunDetail` for a LOCAL run of a tracker project in which no queue item carries `claim` shows one line: `Not visible from other machines: this run
     has not claimed an issue yet.` The project's `source` comes from the projects payload the page already has.
   - Every derivation goes in `client/src/lib/` (one home per derivation). Name the new predicate `isRemoteRun` or similar, and keep it out of the
     components.
7. **Skills prose.**
   - `skills/backlog-orchestrate/SKILL.md`, beside `attention`: in a tracker project the entry also becomes a comment on the issue, best-effort, and
     `--detail` is now published text on somebody's issue. That is one more reason it is the driver's own words, never a quote.
   - Beside `finish`: in a tracker project it stamps the last-touched claim.
   - Beside `heartbeat`: it also heartbeats held claims.
   - `references/recovery.md`: the `claim` column and the `'skip'` suggestion.
   - The `[orchestrator-run` marker and every existing prose guard stay as they are.
8. **Docs, as a contract sweep.** Update:
   - CLAUDE.md's invariants on the run file (the payload's `remote` array comes from the tracker cache, never from a file, and never joins `runs`), the
     tracker-cache entry (a second reader of the comments), and the "tracker project has no item files" entry, where reconcile now reads claims;
   - `docs/subsystems/invariants.md` (new anchor: "remote runs ride beside `runs`, never in it"), `api.md`, `board.md`, `skills.md`;
   - `.claude/rules/` pointer files, if a new anchor is added;
   - the spec's §7.3 and §7.6 get a `> **landed**` annotation in task-47's style, recording Decision 5 and Decision 6 as deviations. Never rewrite the
     original prose.

## Test cases

Hermetic throughout: the in-memory GitHub behind a real `GithubClient` that `test/tracker-write.test.ts` already uses, and the fake API on loopback that
`orchestrate.test.mjs` already uses. No test touches `api.github.com`.

**`test/remote-runs.test.ts` (pure, `deriveRemoteRuns` / `readClaimState` / `parseAttention`), with `nowMs` fixed:**

- R-1: two claims on #3 and #5 with the same `runId`, both heartbeats 1 min old, no `finished` → one run, `status: 'running'`, `fresh: true`, queue ids
  `['3','5']` in claim-`at` order.
- R-2: the same claims with heartbeats 20 min old → `status: 'running'`, `fresh: false` (crashed, NOT done).
- R-3: one claim released `merged` carrying `finished: { status: 'done', at: T }`, and no heartbeat later than T → `status: 'done'`.
- R-4: `finished: { status: 'paused', at: T }` on one claim, and a later claim in the same run with a heartbeat at T+5 min, 1 min old → `status: 'running'`,
  `fresh: true` (resumed after the pause).
- R-5: two claims on #3 in one run (an older one released `resumed`, a newer one live) → one queue item, whose state comes from the newer claim.
- R-6: a claim with no `run` (a hand `start`) → contributes no run.
- R-7: a group whose `runId` is in `localRunIds` → dropped.
- R-8: `state` of `{ stage: 'reviewing', fixLoops: 'two', usage: 5, extra: {} }` → `stage: 'reviewing'`, and `fixLoops`/`usage` default. No throw.
  `state: 'garbage'` and `state` absent → `stage: 'preflight'`.
- R-9: `parseAttention` accepts `<!-- bm:attention kind=parked run=run-20260919-120000 -->\n\n@futin detail text` → `{ kind: 'parked', runId: …,
  detail: 'detail text' }`. It refuses `kind=bogus`, a run id of the wrong shape, and the marker anywhere but line 1.
- R-10: an attention comment on #5 whose `runId` matches → it appears in `attention` with `id: '5'`. One carrying another `runId` does not.
- R-11: `updatedAt` is the max over heartbeat, `released.at` and `finished.at`.
- R-12: `project` is the local path passed in, never anything from the claim.

**Server wiring (supertest through `listenLoopback`):**

- S-1: `GET /api/orchestrator/runs` with a connected fixture repo holding a remote run's claims → `remote` has one entry, and `runs` does not contain it.
- S-2: the same fixture plus a local `run.json` with the same `runId` → `remote` is empty.
- S-3: a remote `running`, fresh run on project P → `POST /api/agents/orchestrate` for P is NOT refused with `RUN_IN_PROGRESS_CODE`.
- S-4: no tracker project registered → `remote: []`, and zero outbound requests (assert on the fake client's call log).

**Heartbeat route (`test/tracker-write.test.ts`):**

- H-1: `finished` on a released claim → 200. The record gains `finished`. `heartbeat`, `state` and `released` are unchanged.
- H-2: no `finished` on a released claim → still the existing 409 wording.
- H-3: `finished` on a live claim → 200. `finished` is set and `heartbeat` moves.
- H-4: `finished.status: 'bogus'` or `at: 'yesterday'` → 400, and nothing is edited.

**CLI (`skills/backlog-orchestrate/tools/orchestrate.test.mjs`, fake API):**

- O-1 (extended): a files fixture with `BM_API_PORT` on a CLOSED port → `attention`, `finish`, `heartbeat` and `reconcile` all exit `0`, and the
  `reconcile` rows have no `claim` key.
- C-1: tracker `finish --status done` after items 3 (`merged` at T1) and 5 (`skipped` at T2 > T1) → exactly one heartbeat request, for #5's comment, with
  `finished.status: 'done'`.
- C-2: tracker `finish` with the API down → exit `0`, one stderr line, and `run.json` reads `done`.
- C-3: tracker `attention 5 --kind parked --detail "x"` → one `POST /api/items/comment` whose body line 1 is exactly
  `<!-- bm:attention kind=parked run=<runId> -->` and which contains `@<login>`. `run.json` also gains the attention entry. With the trackers route
  answering no login → the body has no `@`.
- C-4: tracker `heartbeat` with items at `reviewing`, `needs-answers` and `merged`, all claimed → heartbeat requests for the first two only.
- C-5: tracker `reconcile --json`, where the claim route answers another run's live claim for item 5 → row 5 has `claim: 'other'` and
  `suggestion: 'skip'`. Own run's stale claim → `'this-run'`, with the suggestion unchanged from today. API down → `'unknown'`, exit `0`.
- G-1 (guard, `test/tracker-labels.test.ts` or a sibling): the attention marker literal in `orchestrate.mjs` and the regex source in
  `remote-runs.util.ts` agree, checked by reading both files as text.

**Client (jsdom):**

- U-1: a payload with one remote running run → a Live row carrying the `remote` tag. Selecting it shows the "controls are on the machine that ran it" line,
  no Pause/Resume/Abort button, and no fetch to `/api/orchestrator/archive/run`.
- U-2: a remote `done` run → a History row with the tag.
- U-3: a local run of a tracker project whose queue has no `claim` → the "not visible from other machines" line. The same run of a files project → no line.
- U-4: `useOrchestratorRuns` keeps polling while only a remote run is `running`.
- `test/watchdog-coupling.test.tsx`'s exact reader set is unchanged. `RunControls` stays the one caller of `watchdogStoodDown`.

- In the browser (playwright MCP tools): open `http://127.0.0.1:5177/`, go to Runs → History, and select any local run. Expected: the detail sheet renders
  exactly as before, with its controls. No row shows a `remote` tag (this machine has no remote runs), and the console has no errors.

## Done when

```
pnpm run typecheck
pnpm test
pnpm run build
```

All three are green, and every test case above exists and fails with its production change reverted. Record the red proof in `## Outcome`, as task-47 did.

**Still to be done by a person with a token (not gating the merge, as for task-45/46/47):** on `futin/test-claude-issues`, orchestrate two groomed issues
from machine A. On machine B, open Runs and confirm the run appears with the `remote` tag, as running and then done. Force one item to park and confirm the
attention comment lands on the issue. Record whether the `@mention` produced a phone notification (Decision 8's known risk).

## Outcome

Executed 2026-09-19/20, on `main` in the main tree (a hand session; the orchestrator run that had been queued for this item crashed at `preflight` before
creating a worktree, and was aborted so the watchdog could not resume it alongside this session).

Phase 4b landed as planned: the server derives other machines' runs from the tracker cache's claim comments and serves them in a new
`OrchestratorRunsPayload.remote`; `finish` stamps the run's outcome on its last-touched claim through the existing heartbeat route; `attention` posts a marker
comment with an `@mention`; `heartbeat` keeps every held claim alive; `reconcile` reads each item's claim and suggests `skip` for another run's live one; and
the Runs page draws a remote run as a read-only, tagged row.

### Deviations from the plan, and why

1. **The status rule excludes the finished claim's OWN heartbeat.** Decision 5 says `status = F.status` when "no claim in the group has a `heartbeat` later
   than `F.at`". `finish` stamps through the heartbeat route, and on an UNRELEASED claim (a `needs-answers` item keeps its claim) that request also moves the
   heartbeat — to the server's clock, milliseconds after the `at` the CLI chose. The plan's rule as written reads every such run as resumed the instant it
   finished. The claim carrying `F` is therefore excluded from that comparison; nothing is lost, because a resume re-claims through a takeover that posts a NEW
   comment. Pinned by the second R-3 case.
2. **A released claim's `reason` is read as the item's stage.** The plan's step 2 says `stage` is `state.stage`. The driver releases at a terminal stage
   WITHOUT a final state heartbeat (`stage <n> merged` → `release … merged`), so `state.stage` is the stage BEFORE the terminal one and every finished item
   would have rendered as `merging`/`reviewing`. When a release reason is a `RunStage` it is the stage; any other reason (`resumed`, `stale`) falls through to
   `state`. Pinned by R-3.
3. **`reconcile`'s `claim` column answers `released` for a STALE claim held by another run.** Decision 10's list has no value for that state: it is unreleased,
   but the protocol lets the next contestant retire it, so reporting `other` would stop a resume that is entitled to take the item. `other` is reserved for a
   LIVE claim, which is what changes the suggestion.
4. **The Runs page reads `/api/projects` itself.** Step 6 says the project's `source` "comes from the projects payload the page already has" — `RunsView` has
   no such payload (it reads the archive, the runs poll and `useAgents`). Added `hooks/useProjectSources.ts`: one `fetch` on mount, failing soft to an empty
   map, which reads as "do not know" and draws no line. Plain `fetch` rather than a `lib/agents` helper so the suites that mock that module are untouched.
5. **`OrchestratorService.localRunIds()` reads archived ids from FILE NAMES**, never by opening them (`archiveStem` makes a name `<runId>.json` or
   `<runId>-<n>.json`). This endpoint polls and an archive grows without bound.

### Test cases

Every case in the plan exists: R-1…R-12 plus `readClaimState`/`parseAttention` and the G-1 source guard in `test/remote-runs.test.ts` (18 cases); S-1…S-4 in
the new `test/remote-runs-routes.test.ts`; H-1…H-4 in `test/tracker-write.test.ts`; O-1 (extended with `attention`/`heartbeat`/`reconcile`/`finish` against a
closed port) and C-1…C-5 in `orchestrate.test.mjs`; U-1…U-3 in `test/runs-view.test.tsx` and U-4 in `test/orchestrator-hook.test.tsx`.
`test/watchdog-coupling.test.tsx`'s reader set is unchanged.

### Verification

```
$ pnpm test
Test Suites: 3 failed, 124 passed, 127 total
Tests:       5 failed, 2064 passed, 2069 total
ℹ pass 661
ℹ fail 1
```

**All six failures reproduce on an untouched HEAD checkout** (`git worktree add --detach /tmp/bm-head… HEAD`, same `node_modules`), and none of them touches
code this branch changed:

- `board-live-cards.test.tsx` ("gives a needs-answers card its own strip…") and `dispatch-button.test.tsx`'s two "board wiring" cases — fixture items created
  `2026-08-20` against the 30-day stale window. They expired when the date rolled to 2026-09-20 during this session: the item leaves the Board, so the card
  the case looks for is not rendered. A date-bomb in the fixtures, worth its own bug.
- `supertest-bind.test.ts`'s two "platform behaviour this helper exists for" probes — `listen EADDRINUSE` on a wildcard bind under this kernel.
- `orchestrate.test.mjs`'s "a submodule working tree resolves to itself" — the `commondir` discriminator case.

```
$ pnpm run typecheck   # tsc --noEmit: no diagnostics from this branch
$ npx tsc -p tsconfig.build.json --outDir /tmp/bm-dist-check   # exit 0
$ npx vite build                                               # ✓ built in 3.75s
```

`pnpm run build` itself cannot run on this machine: `dist/` is owned by `root` (written by an earlier Docker build), so `nest build` fails with
`EACCES: permission denied, rmdir '…/dist/server'` before compiling anything. `tsc --noEmit` reports the same `TS5033` for its build-info file. Both halves of
the build were therefore run explicitly — the server compiled to a temp `--outDir`, the client normally — and both pass. Fixing the ownership needs `sudo` and
is not this item's work.

**The browser check in Test cases was NOT run.** A Vite dev server was started on 5177 and answered `200`, but the Playwright MCP browser is not installed on
this machine (`Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`), and installing one is a machine-wide change this session did not
make unasked. The dev server was killed by its recorded pid afterwards and 5177 is free. The "still to be done by a person with a token" live check on
`futin/test-claude-issues` is also still outstanding, as it is for task-45/46/47.

Contract sweep: 12 sites updated (CLAUDE.md — the run-file, write-routes, tracker-cache, driver-claim, poll and layout entries plus a new remote-runs entry;
docs/subsystems/invariants.md — a new `Remote runs ride beside runs, never in it` section, a new `What the rest of the run publishes` subsection, and the
`ClaimState`-has-no-reader sentence corrected; docs/subsystems/api.md, board.md, skills.md; .claude/rules/orchestrator.md and board.md; SKILL.md's attention,
finish and heartbeat paragraphs plus its "one of four suggestions" line; references/recovery.md's verdict list; `orchestrate.test.mjs`'s "all four reconcile
verdicts" guard, now five; the spec's §7.3 and §7.6 annotations; and `ClaimState`'s own doc comment in shared/types.ts). Nothing was left standing on purpose.

Red proof: 35 tests went red with the change reverted — one mutation per production change, each applied to a file copy and restored afterwards (never
`git stash`). Not proved, with reasons: **S-3** (a fresh remote run does not 409 a local Orchestrate) and **S-4** (`remote: []` and zero outbound requests with
no tracker project) pin structural guarantees — remote runs never enter `runs`, and the derivation reads a cache rather than the network — so there is no line
whose reversion makes them fail; S-3 asserts its own precondition (`[['running', true]]`) first so it cannot pass vacuously. **H-2** pins the pre-existing 409
wording, which this change deliberately leaves alone.

Follow-ups for a person, not filed by this session: the fixture date-bomb above, and `dist/` being root-owned.
