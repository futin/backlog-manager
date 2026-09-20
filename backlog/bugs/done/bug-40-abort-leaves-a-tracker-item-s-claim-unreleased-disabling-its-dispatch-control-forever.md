---
id: bug-40
title: abort leaves a tracker item's claim unreleased, disabling its dispatch control forever
created: 2026-09-20
tags: tracker, github, orchestrator, claims, abort
runner-fix: true
updated: 2026-09-20T11:19:03Z
groom-elapsed: 68
groom-tokens: 15974
started: 2026-09-20T11:01:00Z
execute-elapsed: 1083
execute-tokens: 106828
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


## Outcome

2026-09-20 — fixed as the `## Fix` section specified, with no deviation.

`cmdAbort` (`skills/backlog-orchestrate/tools/orchestrate.mjs`) now walks its queue a second time, after the git teardown loop and before `writeRunAtomic` /
`cmdFinish`, and calls `trackerRelease(run, item, 'aborted')` for every item the run still holds — `item.claim !== undefined && !CLAIM_RELEASE_STAGES.has(item.stage)`,
the same predicate `cmdHeartbeat` uses. The whole pass is gated on `projectSource(projectRoot) === 'github'`, so a files run's path is unchanged. No `counters`
argument is passed, so `trackerRelease` bills the ordinary way through `claimCountersFor`. `trackerRelease` gained a second caller and nothing else changed in it.

The four things the plan singled out all hold, and each has a case:

- the reason is `'aborted'`, which is deliberately not a `RunStage`, so `deriveRemoteRuns` falls through to `state.stage` and another machine's Runs page keeps
  the item's last reported stage;
- the releases land before `cmdFinish`'s `finished` stamp (asserted as an exact request order);
- a refused release is one stderr line and `abort` still exits `0` having written `{"status":"aborted"}`;
- a files run makes no API request on any path.

`progressBlock`, the `GithubSource` mapper and `GithubSource.release`'s decision to leave the assignee alone are all untouched, as the plan required.

### Verification

`node --test --test-name-pattern "bug-40" skills/backlog-orchestrate/tools/orchestrate.test.mjs`:

```
✔ bug-40: abort releases every claim the run still holds, reason aborted, before it finishes the run (1584.372161ms)
✔ bug-40: a refused release is one stderr line and abort still exits 0 with the run aborted (1109.142689ms)
✔ bug-40: a files run-s abort makes no API request on any path (175.838705ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

`pnpm test` (both runners) — the node runner:

```
ℹ tests 665
ℹ pass 664
ℹ fail 1

✖ failing tests:
✖ a submodule working tree resolves to itself and is never refused — commondir, not ".git is a file", is the discriminator
```

and jest:

```
Test Suites: 3 failed, 124 passed, 127 total
Tests:       5 failed, 2064 passed, 2069 total
```

**All six failures are pre-existing and none is reachable from this change**, each proved rather than assumed:

- the submodule case was run against `git show HEAD:…/orchestrate.mjs` copied over the working file and failed identically (it is an environment/`git submodule`
  fixture problem, not a `resolveProjectRoot` one);
- the five jest failures (`board-live-cards`, `dispatch-button`, `supertest-bind`) were re-run with every file of this diff reverted to `HEAD` — `Tests: 5
  failed, 60 passed, 65 total`, the same five — and none of those suites reads any file this diff touches. This diff changes no TypeScript at all; `pnpm run
  typecheck` is clean.

Contract sweep: 7 sites updated (CLAUDE.md's tracker-claim invariant; docs/subsystems/invariants.md — the claim section's lead sentence, the "a failed release
is one stderr line too" posture whose "goes stale, which is the protocol's own repair" rationale was the false half, and a new sub-entry under "What the rest of
the run publishes"; docs/subsystems/skills.md's tracker table row; skills/backlog-orchestrate/SKILL.md's tracker bullet and §10; skills/backlog-orchestrate/
references/recovery.md's description of what `abort` walks; backlog/tasks/done/task-48-*.md Decision 11; and `trackerRelease`'s own doc comment in
orchestrate.mjs, which carried the same "goes stale on its own — the protocol's own repair" sentence).

Two sites left standing on purpose. `docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md` §6.4 still says "a terminal stage releases it", and the
`.worktrees/task-47/` copies of several of the files above still carry the old text. The specs and plans under `docs/superpowers/` are dated design records of
what was decided at the time — CLAUDE.md describes them as what the repo "was built from" — and editing one to match a later fix would destroy the record the
bug's own history depends on; `.worktrees/task-47` is another tree entirely and this skill writes only under the root `show` resolved.

Red proof: 2 tests went red with the change reverted (the release-set/order case failed with `actual: []` against `expected: [503, 505]`; the refusal case
failed on an empty stderr). The third — "a files run's abort makes no API request on any path" — stays green with the change reverted, and deliberately so:
it pins the invariant's "byte-identical output" half, which is a statement that this change did **not** reach the files path, so there is no production change
for it to go red without. It would go red only if a future edit dropped the `projectSource` gate *and* `trackerRelease`'s `item.claim === undefined` early
return, which is exactly the regression worth a standing guard.
