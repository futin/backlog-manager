---
id: bug-41
title: A tracker id the cache has not polled yet is refused as unknown
created: 2026-09-20
tags: tracker, github, orchestrator, cache
runner-fix: true
updated: 2026-09-20T10:10:23Z
groom-elapsed: 33
groom-tokens: 5903
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

