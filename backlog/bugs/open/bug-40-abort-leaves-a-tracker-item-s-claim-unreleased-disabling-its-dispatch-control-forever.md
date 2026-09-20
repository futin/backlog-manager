---
id: bug-40
title: abort leaves a tracker item's claim unreleased, disabling its dispatch control forever
created: 2026-09-20
tags: tracker, github, orchestrator, claims, abort
runner-fix: true
updated: 2026-09-20T10:04:22Z
groom-elapsed: 68
groom-tokens: 15974
---

## Symptom

`orchestrate.mjs abort` tears down a run's worktrees and branches and ends the run, but it never releases the claims of the tracker items it tore down. The
issue keeps an unreleased claim comment, the `in-progress` label and the assignee. Because the mapper fills `BacklogItem.started` from an unreleased claim
regardless of that claim's freshness ("any stamp, fresh or stale"), and `progressBlock` is `status === 'open' && started !== ''`, the item's dispatch control
stays disabled on **every** machine's board indefinitely — not for `CLAIM_STALE_MS` (15 minutes) and then clear, but until a person intervenes by hand.

task-48 records "`abort` releasing claims" as an explicit non-goal, on the stated rationale that leftover claims "go stale on their own in 15 minutes". That
rationale holds for the claim protocol's own contest rule — another run may take a stale claim over — but not for the board: going stale does not remove the
`started` stamp, does not release the claim, and does not clear the label or the assignee. So the non-goal is under-stated rather than wrong, and the visible
cost is permanent, not bounded.

Observed during the two-machine check for task-48 on 2026-09-20, on `futin/test-claude-issues`.

## Repro

1. Register and connect a tracker project (`backlog.mjs init` + a committed `backlog/source.json` naming a GitHub repo).
2. `orchestrate.mjs init --project <root> --ids <n>` for an open issue `<n>`.
3. `orchestrate.mjs stage <n> preflight` — the driver claims the issue; GitHub now carries the claim comment, the `in-progress` label and the assignee.
4. `orchestrate.mjs abort`. It reports `abort: removed 1 item(s) (<n>)` and writes `{"status":"aborted"}`.
5. Read the issue's claim comment: `released` is absent. `gh issue view <n> --json labels,assignees` still shows `in-progress` and the assignee.
6. `GET /api/items` still reports `started` and `phase: execute` for that item, and the board draws its execute button disabled. Waiting past
   `CLAIM_STALE_MS` changes none of the three.

Verified at step 5/6 on 2026-09-20 with issue `#3`: `released= undefined`, `{"assignees":["futin"],"labels":["type:task","in-progress"]}`,
`#3 status=open started=2026-09-20T09:43:26.890Z phase=execute assignee=futin`.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `cmdAbort`; the only caller of `trackerRelease` is the `stage` path
  (`if (CLAIM_RELEASE_STAGES.has(stage)) trackerRelease(run, item, stage, mergedCounters)`), and `CLAIM_RELEASE_STAGES` is the six terminal stages, which an
  abort never passes through.
- `client/src/lib/item-progress.ts` — `progressBlock`, `item.status === 'open' && item.started !== ''`: presence, never freshness. This is deliberate and is
  not the thing to change.
- `server/src/items/sources/github.source.ts` — the mapper that fills `started`/`phase` from an unreleased claim.
- `backlog/tasks/done/task-48-*.md`, Decision 11's non-goal list — the rationale recorded there is the one this bug corrects.

## Cause

`trackerRelease` has exactly one caller: the `stage` path, `if (CLAIM_RELEASE_STAGES.has(stage)) trackerRelease(run, item, stage, mergedCounters)`. A claim is
therefore released only by an item reaching one of the six terminal stages. `cmdAbort` ends the RUN rather than each item — it removes worktrees, deletes
branches, pushes `attention` entries and delegates to `cmdFinish(['--status', 'aborted'])` — and never walks its queue looking for claims to give back. Nothing
else does either: `cmdFinish` stamps `finished` on the last-touched claimed item (task-48) and deliberately does not release, because on the ordinary path the
terminal stage already released it.

Two things then make the consequence permanent rather than bounded:

- The release is what edits the claim comment to carry `released` and takes the `in-progress` label off (`GithubSource.release`; the assignee is left alone on
  purpose). Without it, all three stay on the issue.
- The mapper reads `started`/`phase` off an **unreleased** claim without consulting its heartbeat — "any stamp, fresh or stale" — and `progressBlock` gates on
  the presence of `started`, not on its age. So `CLAIM_STALE_MS` elapsing changes nothing the board reads: it only entitles another run to contest the claim.

`cmdAbort`'s one branch that skips an item's teardown — a worktree still carrying an in-progress `phase:` marker — cannot fire for a tracker item, because
`findItemFilePath` has no item file to find and `marker` is therefore always `false`. So on a tracker project every queue item takes the teardown path, and
every claimed one is stranded.

## Fix

Release every claim the run still holds, in `cmdAbort`, before it delegates to `cmdFinish`.

- **Where:** in `cmdAbort`'s existing `for (const item of run.queue)` loop, or a second pass over the same queue before `writeRunAtomic`. It must run before
  `cmdFinish`, so that `finish`'s `finished` stamp lands on a claim that is already released — the case `GithubSource.heartbeat` explicitly accepts, where it
  sets `finished` and nothing else. `item.claim` survives a release, so `finish` still finds its last-touched claimed item.
- **Which items:** the same predicate `cmdHeartbeat` already uses for "still holds" — `item.claim !== undefined && !CLAIM_RELEASE_STAGES.has(item.stage)`. Do
  not add a branch for the preserved-marker case: that branch is unreachable for a tracker item, and an item left in place with a live marker still needs its
  claim back, because the run that held it is over either way.
- **Reason:** `'aborted'`. It must NOT be a `RunStage`, and `'aborted'` is not one — `remote-runs.util.ts` reads a release reason as the item's stage when it
  happens to be a `RunStage` and otherwise falls through to `state.stage` (task-48 deviation 2), so this spelling leaves the item's last reported stage intact
  on every other machine's Runs page.
- **Counters:** bill them the ordinary way — pass no `counters` argument and let `trackerRelease` read them through `claimCountersFor`. The session did the work
  it did up to the abort; this is not `backlog.mjs stop --abandon`'s dead-interval case.
- **Failure handling:** unchanged from `trackerRelease`'s own contract — one stderr line, never a failed command. `abort` must still exit `0` and still write
  `{"status":"aborted"}`, because `run.json` is the journal of record and the claim is a published copy.
- **Files project:** byte-identical output. `trackerRelease` returns immediately when `item.claim === undefined`, which is every item of a files run, so no HTTP
  request is made on any path.

No migration is needed for items already stranded by a past abort: `backlog.mjs stop <id> --abandon` releases a tracker item's claim by hand, and that is the
documented recovery to name in the run's output if it is worth naming at all.

Two things this fix deliberately does not do. It does not clear the assignee — `GithubSource.release` leaves it on purpose, as the record of who last worked the
item. And it does not touch `progressBlock` or the mapper: reading `started` off any unreleased claim, fresh or stale, is the invariant, and the defect is the
missing release rather than the way the stamp is read.

Then correct task-48's Decision 11 where it says a leftover claim "goes stale on its own in 15 minutes": that is true of the claim protocol's contest rule and
false of the board, which is what made this a non-goal in the first place.

