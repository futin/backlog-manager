# `orchestrator:queued` Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan deliberately contains no literal code** (the user's standing rule, overriding writing-plans' "code blocks required"): it gives behaviour,
> signatures, exact test cases and expected values. Write the code yourself, and disagree with the plan where the code shows it is wrong — say so in the
> task's report rather than transcribing around it.

**Goal:** Every open issue a live tracker orchestrator run intends to work carries the `orchestrator:queued` label, removed when it is claimed, skipped, the
run finishes, or the run is stopped — and every machine's board draws it as a live or stale badge.

**Architecture:** One ninth label in the tracker label set; one eighth guarded write route (`POST /api/items/queue`) backed by a new `ItemWriter.queue` on
`GithubSource`; the won-claim path swaps `orchestrator:queued` for `in-progress`; `AgentsService.stop` sweeps the run's never-claimed items before spawning
the abort; the driver adds at `init` and removes at skip/finish/abort through the route; the mapper exposes `BacklogItem.queued`, and a derivation in
`client/src/lib/tracker.ts` decides `'live' | 'stale' | null` for the card.

**Tech Stack:** NestJS (server), React + Vite (client), plain Node ESM (skill tool), jest (`test/`) and `node --test` (beside the tool).

**Spec:** [docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md](../specs/2026-09-23-orchestrator-queued-label-design.md) — read it
before any task. Its parent is [the tracker design](../specs/2026-09-17-tracker-backed-backlog-design.md) (§5.2, §5.3, §6.2, §6.3, §7).

## Global Constraints

- Label name is exactly `orchestrator:queued`; description exactly `In a live orchestrator run's queue, not yet picked up — a plan, not a claim`.
- The label is advisory. No reader anywhere treats it as exclusion; no gate, queue builder or claim reads it.
- Removing the label when it is absent (GitHub 404) is success, everywhere.
- A label write failure in the driver prints one stderr line and never changes a command's exit code or a run's status.
- The Stop sweep never fails the stop: failures land in `StopResult.unqueueFailed` and the abort still spawns.
- A `files` project makes no label call on any path.
- Comments explain _why_ at the repo's existing density; prose wraps at 160 columns (commit bodies at 72).
- Before editing a file, open the `.claude/rules/*.md` whose `paths:` covers it (a `Write`/`codegraph_explore` route does not inject it).
- Every skill CLI still ends with `process.exitCode = main(...)`.

## Review Focus

1. **A paused run's labels must read `'live'`, not `'stale'`.** `runIsLive` (`client/src/lib/run-time.ts:231`) is `false` for `paused`; the derivation must
   accept `paused` explicitly. Pinned in Task 5.
2. **A human claims a queued item by hand.** Their won claim removes the label (Task 2's swap); the run later loses the claim at preflight, skips, and its skip
   removal answers 404 → success, no warning printed. Pinned in Tasks 2 and 4.
3. **The API is down when `finish` or `cmdAbort` sweeps.** `apiCall` throws `EXIT_API_DOWN`; the sweep helper must catch it, warn once (not once per item), and
   leave the exit code as it would have been. Pinned in Task 4.
4. **Stop on a crashed run while GitHub rate-limits.** The sweep's refusals go to `unqueueFailed`, `stopRequested` is still `true`, the abort still spawns.
   Pinned in Task 3.
5. **Id spelling.** Queue ids are `31`; the routes take `#31` (`claimItemId`). The server sweep reads ids off `run.json` and must resolve them the same way the
   routes do. Pinned in Tasks 3 and 4 by asserting the issue number that reached the fake.

---

### Task 1: The ninth label and the `queued` mapping

**Files:**
- Modify: `server/src/tracker/labels.ts` (append to `TRACKER_LABELS`; update the header comment's "eight" and its list of the non-type four → five)
- Modify: `server/src/tracker/map-issue.ts` (`MappedIssue` field, `tags` filter at ~line 157, the returned item)
- Modify: `shared/types.ts` (`BacklogItem`, beside `runnerFix?: true` at ~line 299)
- Test: `test/tracker-labels.test.ts`, `test/tracker-map.test.ts`, `test/tracker-poll.test.ts` (bootstrap)

**Interfaces:**
- Produces: `TRACKER_LABELS` has 9 entries, the ninth `{ name: 'orchestrator:queued', color: <pick a neutral, e.g. 'bfdadc'>, description: <Global Constraints> }`.
  Export a constant `QUEUED_LABEL = 'orchestrator:queued'` from `labels.ts` — Tasks 2 and 3 import it rather than spelling the string.
- Produces: `BacklogItem.queued?: true` — `true | absent`, never `false`, for the reason `runnerFix`'s declaration gives (`'queued' in item` must mean it).

- [ ] **Step 1: Failing tests.**
  - labels: `TRACKER_LABELS.length === 9`; the last entry's name is `orchestrator:queued`; `QUEUED_LABEL === 'orchestrator:queued'`.
  - map: an issue labelled `type:task` + `orchestrator:queued` maps to an item with `queued: true` and `tags` not containing `orchestrator:queued`.
  - map: an issue with only `type:task` maps to an item where `'queued' in item === false`.
  - map: a file-store item (any existing FilesSource fixture used by `tracker-items.test.ts`) never has the key.
  - poll/bootstrap: a repo listing the existing eight labels triggers exactly one `createLabel`, named `orchestrator:queued`; a repo listing all nine triggers
    none. (Extend whichever case already asserts "a missing label set triggers exactly one create per missing label".)
- [ ] **Step 2:** `pnpm run test:jest -- tracker-labels tracker-map tracker-poll` → the new cases FAIL.
- [ ] **Step 3:** Implement. Mapper: `queued = names.includes(QUEUED_LABEL)`; set the key only when true; add the label to the `tags` exclusion with the
  existing comment updated from "four" to "five CONSUMED".
- [ ] **Step 4:** Same command → PASS. Then `pnpm run typecheck`.
- [ ] **Step 5:** Commit `feat(tracker): orchestrator:queued label and BacklogItem.queued`.

### Task 2: `POST /api/items/queue` and the claim swap

**Files:**
- Modify: `server/src/items/sources/source.ts` (`ItemWriter` gains `queue`; a request type `ItemQueueRequest`)
- Modify: `server/src/items/sources/github.source.ts` (new `queue` method; the won-claim branch near line 474)
- Modify: `server/src/items/items-write.controller.ts` (the eighth route)
- Test: `test/tracker-write.test.ts`, `test/tracker-claim.test.ts`, `test/tracker-origin.test.ts` (guard)

**Interfaces:**
- Consumes: `QUEUED_LABEL` (Task 1); existing `GithubClient.addLabels(repo, number, names, { token })`, `removeLabel(repo, number, name, { token })`;
  `this.serialise(issueUrn(repo, number), fn)`; `refusalFor(res)`; `issueNumberFor(id, repo)`.
- Produces: `ItemQueueRequest = { project: string; id: string; queued: boolean }`.
- Produces: `ItemWriter.queue(project: RegistryProject, marker: SourceMarker, req: ItemQueueRequest): Promise<WriteOutcome<{ id: string; queued: boolean }>>`.
- Produces: route `POST /api/items/queue` → `200 { id, queued }`; 400 on missing `project`/`id` or a non-boolean `queued`; refusals mapped by the controller's
  existing `answer`/`writable` helpers exactly as the other seven.

- [ ] **Step 1: Failing tests** (use `FakeGithub` from `test/helpers/github`):
  - `queued: true` on `#31` → the fake records one add-labels call on issue 31 with `['orchestrator:queued']`; response `200 { id: '#31', queued: true }`.
  - `queued: false` when the label is present → one remove call; `200 { queued: false }`.
  - `queued: false` when the fake answers the remove with 404 → still `200 { queued: false }`.
  - `queued: false` on a CLOSED issue → `200` (not refused).
  - `queued: 'yes'` → `400`; missing `id` → `400`.
  - a `files` project → the same refusal status the other seven give a files project (read it off an existing case; do not invent one).
  - guard: missing JSON content-type, and a foreign `Origin`, are refused like `POST /api/items/claim` (extend the table in `tracker-origin.test.ts`).
  - serialisation: a `queue` and a `claim` fired concurrently on the same issue complete in issue order without interleaving — mirror the existing concurrent
    case for claim/release if one exists; if none does, assert only that both resolve and the final label set is `in-progress` without `orchestrator:queued`.
  - claim swap: a WON claim on an issue carrying `orchestrator:queued` ends with the label removed and `in-progress` added; a LOST claim leaves
    `orchestrator:queued` in place.
- [ ] **Step 2:** `pnpm run test:jest -- tracker-write tracker-claim tracker-origin` → FAIL.
- [ ] **Step 3:** Implement. `queue` resolves the number, serialises on the item's chain, calls add or remove, treats a remove 404 as success, maps other
  failures through `refusalFor`. Does NOT read the issue's state first. The claim swap: in the won branch, after `addLabels(['in-progress'])`, call
  `removeLabel(QUEUED_LABEL)` and ignore its result for the reason the neighbouring `in-progress` removal comments give.
- [ ] **Step 4:** Same command → PASS; `pnpm run typecheck`.
- [ ] **Step 5:** Commit `feat(items): the eighth write route — queue — and the claim swap`.

### Task 3: Stop sweeps the queue, server-side

**Files:**
- Modify: `server/src/agents/agents.service.ts` (`stop`, ~line 1152)
- Modify: `shared/types.ts` (`StopResult`, line 575)
- Test: `test/agents-stop.test.ts`

**Interfaces:**
- Consumes: `ItemsService.writerFor(project)` (already injected into agents via `ItemsModule`); `ItemWriter.queue` (Task 2).
- Produces: `StopResult.unqueueFailed?: string[]` — present only when at least one removal was refused, listing queue ids as `run.json` spells them (`'31'`).

- [ ] **Step 1: Failing tests:**
  - tracker run with queue `[31 claimed, 32 pending, 33 pending]` (claimed = has a `claim` field) → the fake records removals on 32 and 33 only, in queue
    order; `stopRequested: true`; the abort spawn is still attempted; no `unqueueFailed` key.
  - same, but the fake answers 32's removal with a 403 + `x-ratelimit-remaining: 0` → `unqueueFailed: ['32']`, 33 still removed, `stopRequested: true`,
    abort still spawned.
  - `files` run → zero calls to the item writer (spy on `writerFor`'s result or assert the fake saw no request); no `unqueueFailed` key.
  - no running run → the existing 409, and no sweep attempted.
  - the sweep runs AFTER the stop control file is written and BEFORE `spawnAbort` (assert via call order on the spies/fake) — the stop must be on file even
    if the sweep throws.
- [ ] **Step 2:** `pnpm run test:jest -- agents-stop` → FAIL.
- [ ] **Step 3:** Implement as a private `unqueue(project, run)` helper: `writerFor`; if not writable (files), return; for each queue item with no `claim`,
  `await writer.queue(..., { queued: false })` sequentially; collect refused ids; wrap each call so a thrown error is a refusal, never a propagated one.
- [ ] **Step 4:** Same command → PASS; `pnpm run typecheck`.
- [ ] **Step 5:** Commit `feat(agents): Stop clears orchestrator:queued from the run's unclaimed items`.

### Task 4: The driver adds and removes the label

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs`
  - new helper near the other `tracker*` helpers (~line 2048): `trackerQueueLabel(run, items, queued)`
  - `cmdInit` (~line 2584): after the run file is first written, for a github project
  - `cmdStage`'s preflight claim-lost branch (~line 3162)
  - `trackerFinish` (~line 3589)
  - `cmdAbort` (~line 5061, beside the in-flight release)
- Modify: `skills/backlog-orchestrate/SKILL.md` only if it enumerates the driver's tracker writes — add the label there, one line.
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (`fakeApi` / `withApi` / `runApi` / `apiItem`, ~line 6504)

**Interfaces:**
- Consumes: `apiCall(method, path, body)`; `claimProjectOf(run)`; `claimItemId(id)`; route from Task 2.
- Produces: `trackerQueueLabel(run, items, queued): void` — one `POST /api/items/queue` per item, sequential; never throws. A non-2xx answer prints
  `orchestrator:queued: <add|remove> failed for <id> — <error>` to stderr. An `EXIT_API_DOWN` throw prints ONE line
  `orchestrator:queued: API down — label not <added|removed> on <n> item(s)` and stops iterating.

- [ ] **Step 1: Failing tests** (node, `withApi` recording requests):
  - `init` on a tracker project with candidates `31, 32, 33` and `--max 2` → exactly two `POST /api/items/queue` bodies, `{ id: '#31', queued: true }` and
    `{ id: '#32', queued: true }` (whatever order the queue builder yields — assert against the run file's queue order); exit 0.
  - `init` on a files project → zero `/api/items/queue` requests.
  - `init` where the route answers 502 for `#32` → exit 0, run file written, stderr contains `orchestrator:queued: add failed for 32`.
  - `stage 32 preflight` where `/api/items/claim` loses → the item is `skipped` AND one `{ id: '#32', queued: false }` follows; a 404 from the queue route
    prints nothing to stderr (the route turns 404 into 200 — the fake should answer 200 here; the 404 case belongs to Task 2).
  - `stage 31 preflight` where the claim WINS → no `/api/items/queue` request (the server's swap owns it).
  - `finish` on a tracker run whose queue is `[31 merged, 32 skipped, 33 pending]` → removals for the items with no `claim` (32 and 33) and none for 31.
  - `cmdAbort` on a tracker run → the same sweep as `finish`, after the in-flight release.
  - `finish` with the API down (`withApi` not started / helper exit for no API) → exactly one stderr line matching `API down`, and the exit code equals what the
    same `finish` returns on a files project in the same state.
- [ ] **Step 2:** `node --test skills/backlog-orchestrate/tools/orchestrate.test.mjs` (or `pnpm run test:skills`) → the new cases FAIL.
- [ ] **Step 3:** Implement the helper and the four call sites. "Never claimed" = queue item with `claim === undefined` — the same test line 5061 uses.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(orchestrate): mark a tracker run's queue with orchestrator:queued`.

### Task 5: The card reading

**Files:**
- Modify: `client/src/lib/tracker.ts` (new derivation)
- Modify: `client/src/components/board/ItemCard.tsx` (render; its header comment cites the `DESIGN.md` subsection)
- Modify: `client/src/components/ui/Marker.tsx` only if a new `MarkerTone` is needed for the dimmed look; prefer an existing muted tone
- Test: `test/tracker-lib.test.ts`, `test/tracker-board.test.tsx`

**Interfaces:**
- Consumes: `BacklogItem.queued` (Task 1); `runIsLive` (`client/src/lib/run-time.ts`); `remoteAsLive` (`client/src/lib/remote-run.ts`); the runs payload the
  board already holds (local runs + `remote`).
- Produces: `queuedReading(item: Pick<BacklogItem, 'queued' | 'project'>, runs: readonly Pick<OrchestratorRun, 'project' | 'status' | 'updatedAt'>[], now: number): 'live' | 'stale' | null`.
  `runs` is the caller's concatenation of local runs and `remote.map(remoteAsLive)`. Match on `project` path — a remote run carries THIS machine's registry
  path for its repo (see `RemoteRunsService.list`), so the path is comparable.

- [ ] **Step 1: Failing tests** (fixture dates relative to the clock the assertion runs under — the jsdom convention):
  - no `queued` key → `null`, whatever the runs.
  - `queued` + a local run for the project, `running`, `updatedAt` 1 min ago → `'live'`.
  - `queued` + a local run `paused`, `updatedAt` 3 h ago → `'live'` (Review Focus 1).
  - `queued` + a local run `running`, `updatedAt` older than `RUN_STALE_MS` → `'stale'` (crashed).
  - `queued` + a remote run for the project, fresh → `'live'`.
  - `queued` + a live run for a DIFFERENT project only → `'stale'`.
  - `queued` + a `done` run → `'stale'`.
  - card: `'live'` renders the text `queued`; `'stale'` renders `queued · stale` with a `title` mentioning that no live run holds it; `null` renders neither.
- [ ] **Step 2:** `pnpm run test:jest -- tracker-lib tracker-board` → FAIL.
- [ ] **Step 3:** Implement the derivation and the badge.
- [ ] **Step 4:** Same command → PASS; `pnpm run typecheck`.
- [ ] **Step 5:** Commit `feat(board): draw orchestrator:queued as a live or stale badge`.

### Task 6: Docs and the rule tiers

**Files:**
- Modify: `CLAUDE.md` — the write-routes headline "The seven `/api/items/*` write routes" → "eight"; the Layout bullet's "the seven guarded write routes"; add
  one Invariants headline: **`orchestrator:queued` is a plan, never a claim: the driver adds it, the claim and the Stop remove it, and no reader treats it as
  exclusion.** with its `Why:` link.
- Modify: `docs/subsystems/invariants.md` — the new entry (reasoning: why advisory, why the server sweeps at Stop, why stale is drawn not hidden), and the
  write-routes entry gains `queue`.
- Modify: the `.claude/rules/*.md` whose `paths:` covers `server/src/items/**` and the one covering `skills/backlog-orchestrate/**` — the new rule's mechanism
  bullet, anchored exactly once; headlines byte-equal with CLAUDE.md.
- Modify: `docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md` — §5.2 nine labels, §5.3 a `queued` row, §6.2 the route, §7 a pointer to
  the new spec. Edit only the lines that change.
- Modify: `docs/subsystems/api.md`, `docs/subsystems/board.md`, `docs/subsystems/skills.md` — one paragraph each where the neighbouring tracker text sits.
- Test: `test/claude-rules.test.ts` (existing guard).

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `pnpm run test:jest -- claude-rules` → PASS (it is the guard; red means an anchor or headline drifted).
- [ ] **Step 3:** `pnpm test` (both runners) and `pnpm run typecheck` → all green.
- [ ] **Step 4:** Commit `docs: orchestrator:queued across CLAUDE.md, invariants, rules and the tracker spec`.

## After the last task

`skills/` changed, so nothing reaches a real run until it is committed, **pushed**, and `pnpm run plugin:sync` runs. Pushing is the user's call — ask
before pushing. After the sync, one live check on a connected repo: start a 2-item run from the board, confirm both issues gain the label on github.com, press
Stop, confirm both lose it within seconds.
