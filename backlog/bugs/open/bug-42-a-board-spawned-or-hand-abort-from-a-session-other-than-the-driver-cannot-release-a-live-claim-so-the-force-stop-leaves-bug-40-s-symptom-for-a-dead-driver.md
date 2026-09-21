---
id: bug-42
title: A board-spawned or hand --abort from a session other than the driver cannot release a live claim, so the force stop leaves bug-40's symptom for a dead driver
created: 2026-09-21
tags: tracker, github, orchestrator, claims, abort, stop
runner-fix: true
updated: 2026-09-21T10:36:21Z
groom-elapsed: 295
groom-tokens: 76286
---

## Symptom

`POST /api/agents/stop` (bug-39) records the stop and spawns a fresh `/backlog-orchestrate --abort` session. That session runs `orchestrate.mjs abort`, which
(since bug-40) releases every claim the run still holds — but the server refuses each release while the claim is LIVE: `release of 6 was refused: #6 is held
by session 7e91416e-…`. The abort session still removes the worktree and writes `status: aborted`, so the run ends with the issue keeping an unreleased claim,
the `in-progress` label and `started`/`phase` on every machine's board — bug-40's symptom, on the exact path bug-39 built for a driver that is dead or hung.

Observed 2026-09-21 on `futin/test-claude-issues` issue #6, run `run-20260921-091645` (see
`docs/superpowers/specs/2026-09-21-tracker-phase4-live-verification.md`, Test 3). The claim WAS released in that run, but only because the still-live driver
`7e91416e` got exit `10` from its next `stage`, read `recovery.md` and ran `abort` itself ten seconds after the spawned session's refused one. With the driver
dead — the case a force stop exists for — nothing releases the claim: it goes stale after `CLAIM_STALE_MS` but stays unreleased, and the mapper fills
`started` from any unreleased claim, fresh or stale, so the item's dispatch control stays disabled until a person edits the comment by hand.

The same refusal hits a hand `/backlog-orchestrate --abort` typed in a new session after a crash, for the same reason.

## Repro

1. Register and connect a tracker project; start a run from the board for one open groomed issue `<n>`.
2. Wait for `stage <n> dispatched`; kill the driver session (`kill <driver pid>`) so no live driver remains.
3. `POST /api/agents/stop { project }` → 200, `abortSession` set. The spawned session runs `orchestrate.mjs abort`.
4. Its stderr: `release of <n> was refused: #<n> is held by session <driver session id>`. `run.json` says `aborted`; the claim comment has no `released`;
   the issue keeps `in-progress`; `GET /api/items` keeps `started`/`phase: execute` for `#<n>`. Waiting past 15 minutes changes none of the three.

## Affects

- `server/src/items/sources/github.source.ts` — `release()`, the `isLive(existing, now) && existing.session !== req.session` refusal ("the holder always; ANYONE
  once the claim is dead").
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `cmdAbort`, which takes the run's driver lease through `takeOverRun` and then releases each held claim
  as ITS OWN session, and treats a refused release as one stderr line.
- `server/src/agents/agents.service.ts` — `stop()`, which spawns the abort as a new session by design.

## Cause

`release` authorises by claim-holder session only. `claim` already knows a second authority — a live claim carrying the same `run.runId` is a takeover by the
resumed driver (task-47, §7.6) — but `release` never learned it, so a session that legitimately holds the RUN (the abort took the lease) is a stranger to the
CLAIM. bug-40 was verified with the driver releasing its own claims, which is the one caller the check admits.

Two details confirm the shape rather than only the symptom. **`release` is the one route in this protocol that authorises by session at all** — `heartbeat`
refuses a released claim and nothing else, which is why the abort session's later `finish` stamp lands on the same comment without complaint, and why this is
a one-line hole rather than a missing concept. And **`cmdAbort` has already taken the run's driver lease** (`takeOverRun(dir, run, stopRequestEffective(...))`,
before it walks the queue) by the time it sends the refused release, so that session demonstrably holds the RUN — it simply has no field in which to say so:
`ItemReleaseRequest` carries `project, id, commentId, session, reason, counters?` and nothing that names a run.

## Fix

Give `release` the **same-run authority `claim` already has**, and make the run's CLI prove it on every release. The rule stops being a pair and becomes a
triple: **the holder always, the RUN that owns the claim, ANYONE once the claim is dead.** The middle clause is not a new concept — it is task-47 §7.6's
same-run takeover, which `claim` has enforced since phase 4a and `release` never learned, so this is the second half of one rule rather than a second rule.

### Server

1. `ItemReleaseRequest` (`shared/types.ts`) gains `runId?: string` — the run asserting it owns this claim. Nothing writes it into the record; one line
   compares it. Deliberately a bare `runId` rather than the whole `ClaimRun` that `claim` takes: `claim` STORES the object, `release` only asks a question
   about one already stored, and a second validated blob would be a second place `ClaimRun`'s shape has to be kept true.
2. `items-write.controller.ts`'s `release` parses it through a new `runIdOf(value)` helper beside `commentIdOf`/`countersOf`: absent → `undefined`, a
   non-empty trimmed string → itself, anything else → 400 `runId must be a non-empty string`. A 400 rather than a dropped field for exactly the reason
   `claimRunOf`'s comment gives about `run`: this is a field the SERVER branches on, and a silently dropped one turns an authorised release into a refusal
   nobody can explain.
3. `GithubSource.release`'s live-claim refusal gains the third escape. Today:

   `if (isLive(existing, now) && existing.session !== req.session)` → `conflict`.

   After: the refusal also requires that the caller is not the claim's own run —

   - same-run is `typeof req.runId === 'string' && req.runId.length > 0 && existing.run?.runId === req.runId`;
   - refuse when `isLive(existing, now) && existing.session !== req.session && !sameRun`.

   **The `length > 0` and `typeof` guards are load-bearing, not ceremony.** Written as the tempting `existing.run?.runId !== req.runId`, a request with no
   `runId` against a hand claim with no `run` compares `undefined !== undefined` → `false` → the refusal disappears, and any session on the machine could
   rip a live hand `backlog.mjs start` out from under the person holding it. That is the exact shape `claim`'s own same-run filter already guards with
   `typeof c.record.run?.runId === 'string'`, and the two should read alike.

   A claim with no `run` is therefore never same-run with anything — the same sentence `claim` makes about a hand claim, and for the same reason: a run has no
   standing to evict somebody working the item at a terminal.

### CLI

4. `trackerRelease` (`orchestrate.mjs`) adds `runId: run.runId` to the payload, **unconditionally** — not only on the abort path. Every release this function
   sends is a run releasing its own run's claim, so the assertion is always true, and a conditional would leave the resumed-driver case (an item released at a
   terminal stage whose claim comment was posted by the session that crashed) quietly on the broken path. One key, no branch.
5. `cmdAbort` needs no other change, but the ORDER it already has becomes load-bearing and should be said so in its comment: `takeOverRun` runs before the
   release loop, so the session claiming run authority demonstrably holds the run's lease when it claims it. A future edit that moved the releases above
   the lease take would make the assertion a lie.

### What deliberately does not change

- **`heartbeat`** — it never checked the session, so the takeover session's `finish` stamp already works; adding a symmetric check "for consistency" would
  break it.
- **`backlog.mjs stop`** — it sends no `runId` and gains no authority. Its own client-side refusal (`held by session … — not this one`) stays as it is,
  and a hand stop still cannot touch a live claim that is not its own.
- **The dead-claim rule** — "anyone once the claim is dead" outranks the new clause and is reached first by `isLive`, so a stale claim carrying a foreign
  `runId` still releases to anybody.
- **Deletion, counters, `released.by`** — untouched. `by` is the releasing session (the abort's), which is the honest record of who did it; `reason` stays
  `'aborted'` and stays deliberately not a `RunStage`.
- **bug-44's `pid` gap** — a stop landing between the two `stage dispatched` calls leaves `pid` null, so abort cannot signal the child. Separate item,
  separate fix; this one only releases the claim.

### Test cases

Jest, `test/tracker-write.test.ts`, in the existing `describe('release')` — seed with `gh.claim(record({ … }), 31, 100)` and assert through `claimIn(100)`:

- **R-1 — the run releases another session's LIVE claim.** Claim `{ session: 'A' }`, fresh heartbeat, `run: { runId: 'run-1', … }`. POST `release`
  `{ commentId: 100, session: 'B', runId: 'run-1', reason: 'aborted' }` → **201**; `claimIn(100).released` matches `{ reason: 'aborted', by: 'B' }`; the
  `in-progress` label removal was attempted (a DELETE recorded in `gh.matching`).
- **R-2 — a DIFFERENT runId is still refused.** Same live claim on `run-1`, release with `runId: 'run-2'` → **409**, `body.holder.session === 'A'`, and
  `gh.matching('/issues/comments/100', 'PATCH')` is `[]` (nothing patched). This is the case that keeps a second machine's run from releasing ours.
- **R-3 — a live claim with NO `run` is never same-run.** Claim `{ session: 'A' }` with no `run` key; release `{ session: 'B', runId: 'run-1' }` → **409**.
  The `undefined === undefined` trap; this case goes red against the naive predicate and green against the guarded one.
- **R-4 — no `runId` sent is exactly today's behaviour.** The existing `refuses another session-s LIVE claim and patches nothing` case stays, unedited, as the
  regression pin.
- **R-5 — a non-string `runId` is a 400.** `post('release', { …, runId: 7 })` → **400**, sibling of the existing `commentId: 1.5` case; nothing is sent to
  GitHub.
- **R-6 — dead outranks the run clause.** Claim `{ session: 'A' }` with `heartbeat` older than `CLAIM_STALE_MS` and `run: { runId: 'run-1' }`; release with
  `runId: 'run-2'`, session `'B'` → **201**, `released.by === 'B'`.

Node runner, `skills/backlog-orchestrate/tools/orchestrate.test.mjs`, reading the recorded `/api/items/release` request bodies from the existing tracker
fixtures:

- **O-1 — every release carries the runId.** A tracker run reaching `stage <n> merged` sends a release whose body has `runId === run.runId` alongside the
  existing `project`/`id`/`commentId`/`session`/`reason`/`counters`.
- **O-2 — abort releases with the run's id.** A tracker run with one claimed item at a non-terminal stage, then `abort`: the release body is
  `{ reason: 'aborted', runId: <run.runId>, session: <this session> }`, and the item's own `session` in the body is the ABORT session's, not the driver's —
  the fix must not impersonate the holder.
- **O-3 — a refused release is still one stderr line and exit 0.** Stub the release route as 409; `abort` still writes `{"status":"aborted"}` and exits `0`.
  Best-effort is unchanged by this fix and is the property most at risk from touching this path.

Node runner, `skills/backlog/tools/backlog.test.mjs`:

- **B-1 — a hand stop sends no `runId`.** The existing case that reads the `/api/items/release` body asserts `'runId' in body === false`, so the new authority
  can never be reached by `backlog.mjs stop`.

No browser check. The defect's visible face is a tracker item's dispatch control staying disabled on the board, which needs a live GitHub issue holding an
unreleased claim from a killed driver — there is no fixture path that renders that locally, so a Playwright step here would be theatre. The six jest cases
plus O-2 are what prove it.

### Docs

`runner-fix: true` is already set — this changes `orchestrate.mjs`. Three prose homes state the rule and all three move together:

- `docs/subsystems/invariants.md`, the **Who may release: the holder always, ANYONE once the claim is dead** paragraph under the claim-protocol anchor —
  becomes the triple, with the `undefined === undefined` trap named as the reason for the `typeof` guard.
- `CLAUDE.md`'s claim-protocol invariant gains the same one-sentence triple beside "A LOSER deletes its own comment".
- `docs/subsystems/api.md`'s `release` row gains `runId?` in its parameter list.

`docs/superpowers/specs/2026-09-21-tracker-phase4-live-verification.md` is a record of an observation and is **not** rewritten — it is where this bug came
from, and its "fix direction" paragraph is already the direction taken.
