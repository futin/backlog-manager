---
id: bug-41
title: A tracker id the cache has not polled yet is refused as unknown
created: 2026-09-20
tags: tracker, github, orchestrator, cache
runner-fix: true
updated: 2026-09-20T12:05:54Z
groom-elapsed: 33
groom-tokens: 5903
started: 2026-09-20T11:43:05Z
execute-elapsed: 1369
execute-tokens: 135227
---

## Symptom

An issue created outside this server — in GitHub's web UI, or with `gh issue create` — does not exist for `orchestrate.mjs` until the tracker poller's next
tick. Two different failures follow, and the second is the worse one:

- With `--ids <n>`: `unknown item id: <n>`, exit `1`. The message names the id and says nothing about the cache, so it reads as "that issue does not exist"
  when the issue plainly does.
- With no `--ids` (the whole-queue case): the issue is simply **not in the queue**, with no error at all. A run drains what it believes is the backlog and
  silently leaves the newest item out.

Both clear on their own at the next poll, so the window is bounded by the poll interval rather than permanent — but nothing tells the user that, and the
whole-queue case leaves no trace that anything was skipped.

Observed on 2026-09-20 during the two-machine check for task-48: two issues created with `gh issue create`, then
`orchestrate.mjs init --project <root> --ids 2,3` about 20 seconds later → `unknown item id: 2`. The identical command succeeded, unchanged, after the next
tick.

**This does not affect an item filed through the skills.** `backlog-capture` in a tracker project files with `backlog.mjs new`, which goes through the server's
write routes, and every write response is absorbed into the poller's cache. The gap is for issues that arrive at GitHub without passing through this server.

## Repro

1. A registered tracker project with the stack up.
2. `gh issue create -R <owner>/<repo> --title "..." --label "type:task" --body "## Goal ... ## Plan ..."` — note the number it prints.
3. Within the poll interval, from the project root: `orchestrate.mjs init --project <root> --ids <n>`.
4. → `unknown item id: <n>`, exit `1`.
5. Same window, no `--ids`: the run is created and the new issue is absent from its queue, with no message about it.
6. Wait for the next tick (`GET /api/trackers` shows `polledAt` moving), re-run step 3 unchanged → succeeds.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `trackerCandidates`, which builds `byId` from `GET /api/items` and refuses at
  `if (!found) throw new OrchestrateError(\`unknown item id: ${id}\`, 1)`; the else-branch of the same function is the silent whole-queue case.
- `server/src/tracker/poller.service.ts` and the tracker cache generally — `GET /api/items` is served from the cache for a tracker project, by design (the
  hourly rate limit makes a per-request fetch impossible).
- Not `server/src/agents/agents.service.ts`'s `resolveTrackerIds`: that one proves an id against `ItemsService` for the SPAWN path and has the same cache
  underneath, so it shares the cause — but the refusal seen here is the CLI's own.

## Cause

`trackerCandidates` builds its whole candidate set from one `GET /api/items`, and for a tracker project that route is served from the poller's cache — which is
the deliberate design (the hourly rate limit makes a per-request fetch impossible; `polledAt` is what keeps the age honest). `byId` therefore contains exactly
the issues the last tick returned, and an issue GitHub accepted after that tick is absent from it. The `--ids` branch turns that absence into
`unknown item id: <n>`; the whole-queue branch turns it into nothing at all.

The window is bounded by `TRACKER_POLL_MS`, which is **15 seconds** — so this is a message problem and a silence problem, not a staleness problem. The write
path already states the rule this read path is missing: `GithubSource.issueNow`'s comment reads "A cache miss is the ordinary case for an issue filed on
another machine in the last fifteen seconds, so a miss must not read as 'no such issue'." Nothing in the read path says that to the user.

## Fix

Two changes in `trackerCandidates`, both in `skills/backlog-orchestrate/tools/orchestrate.mjs`. Neither adds a route, an adapter method or a request to GitHub.

**1. A named id that misses gets one bounded retry before it is refused.** On a miss, sleep past one poll interval and re-read `GET /api/items` once; refuse
only if the second read misses too. The sleep is the `Atomics.wait` form `watch` already uses — `orchestrate.mjs` holds no asynchronous work and must stay on
`process.exitCode = main(...)`, so do not reach for a timer or an `await`. One retry, never a loop: two misses 15 seconds apart is a genuinely unknown id.

**2. The refusal and the queue preview both name the cache.** The refusal becomes something a user can act on — the id, the poll age read from
`GET /api/trackers`, and the fact that an issue filed seconds ago is not visible yet — rather than `unknown item id: <n>`. And the whole-queue branch prints
the poll age beside the queue it built, so "this run's queue came from a cache polled 12 s ago" is visible at `init` and `plan` rather than inferred from an
item that is quietly missing.

Part 2 is the one that matters, and it is worth doing even if part 1 is dropped: the silent whole-queue omission has no error message to improve, so the poll
age IS the fix there.

**Rejected, and why — the groomer's call, made without a question channel.** Giving the READ path `issueNow`'s per-id fresh-`GET` fallback (in
`GithubSource.find`, plus a new `GET /api/items/find` route for the CLI to reach it) would close the window exactly rather than wait it out. It is rejected as
disproportionate: it adds a route, a second read path into the adapter and a new way for a render to spend rate limit, to save at most 15 seconds — and
`GET /api/items/claim` exists precisely because a claim cannot tolerate being one poll stale, which an item's existence plainly can. If this recurs somewhere
the wait is not tolerable, that is the design to revisit, and this paragraph is where to start.

A files project must be byte-identical: both changes live inside `trackerCandidates`, which the files branch of `buildGatedQueue` never reaches.


## Outcome

2026-09-20 — fixed as groomed, both parts, entirely inside `trackerCandidates`
(`skills/backlog-orchestrate/tools/orchestrate.mjs`). No new route, no adapter method, no request to GitHub; the rejected per-id fresh-`GET` design stays
rejected and is now recorded in `invariants.md` with its reasoning, so the next person to hit this starts from the argument rather than from scratch.

**Part 1 — one bounded retry for a named id.** `--ids` shape validation moved ahead of every lookup (a malformed list has nothing to wait for), and a miss now
sleeps until the next poll is due, re-reads `GET /api/items` once, and refuses only on a second miss. The wait is timed off this project's `polledAt`
(`GET /api/trackers`) rather than being a flat interval: `trackerRetryDelayMs` returns the remainder of one window, clamped to that window for a `null` or
future stamp and to **zero** for a stamp already overdue — a disarmed poller will not answer a longer wait, so the refusal arrives at once with the age that
explains it. The sleep is `sleepSync` (`watch`'s `Atomics.wait`), so the file stays synchronous and stays on `process.exitCode = main(...)`.

**Part 2 — both surfaces name the cache.** The refusal keeps its `unknown item id: <n>` opening (a `stage`-time refusal elsewhere shares the phrase and
SKILL.md §3's recovery bullet reads it) and gains the age, the project scope and the fact that two reads a poll apart were made. The whole-queue branch — the
half with no message to improve — prints `queue built from the tracker cache (polled 12 s ago) — an issue filed since that poll is not in it yet` on stderr at
`plan` and `init` alike, so `--json` stdout is untouched.

Extracted on the way: `trackerIndexItems` (the index read and its filter, now read twice) and `trackerById`, so the two reads cannot come to disagree about
what counts as a candidate.

A files project is untouched: everything above lives inside `trackerCandidates`, which the files branch of `buildGatedQueue` never enters, and a new case pins
it with the API port closed.

Files changed: `skills/backlog-orchestrate/tools/orchestrate.mjs`, `skills/backlog-orchestrate/tools/orchestrate.test.mjs`,
`skills/backlog-orchestrate/SKILL.md`, `docs/subsystems/invariants.md`, `docs/subsystems/skills.md`, `CLAUDE.md`.

### Verification

`pnpm run typecheck` → exit 0. The six new cases, run by name:

```
✔ the retry waits for the next poll to be due, and never longer than one window (9.480765ms)
✔ the poll age reads as whole seconds, and says so when there has never been a poll (0.31595ms)
✔ a named tracker id the cache has not polled yet gets one retry and then runs (717.99159ms)
✔ a tracker id missing from both reads is refused, and the refusal names the cache and its age (721.876797ms)
✔ a tracker queue preview says how old the cache it was built from is (595.017364ms)
✔ a files queue preview says nothing about a tracker cache (84.388203ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

Whole `pnpm run test:skills`:

```
ℹ tests 671
ℹ pass 670
ℹ fail 1
✖ a submodule working tree resolves to itself and is never refused — commondir, not ".git is a file", is the discriminator (235.215319ms)
```

**That one failure is pre-existing and environmental, not this change's.** The same fixture run by hand against `git show HEAD:…/orchestrate.mjs` fails
identically: this machine has no `init.defaultBranch`, so the test's `git init -q` fixture lands on `master` and `init` correctly refuses
`--base must be an existing local branch: "main" is not a branch in …`. Five jest cases also fail (`board-live-cards`, `dispatch-button`, `supertest-bind`) and
all five reproduce on a pristine `git worktree` at HEAD with this change absent — jest's `testMatch` cannot reach `skills/` at all, so nothing here could have
caused them. Neither was filed: both predate this item.

Contract sweep: 4 sites updated (CLAUDE.md, docs/subsystems/invariants.md, docs/subsystems/skills.md, skills/backlog-orchestrate/SKILL.md)
Red proof: 5 tests went red with the change reverted

Red proof detail, one revert at a time against a file copy (never `git stash`): removing the retry block reddened both `--ids` cases; removing the stderr line
reddened the queue-preview case; restoring the bare `unknown item id: ${id}` refusal reddened the refusal case; flattening `trackerRetryDelayMs` to a constant
reddened the delay case; dropping `trackerPollAgeText`'s `never polled` and its clamp reddened the age case. The sixth new case — a files preview saying
nothing about a tracker cache — is a negative guard with no production change to revert (the files branch never enters this function), so it is the one
skipped, deliberately.
