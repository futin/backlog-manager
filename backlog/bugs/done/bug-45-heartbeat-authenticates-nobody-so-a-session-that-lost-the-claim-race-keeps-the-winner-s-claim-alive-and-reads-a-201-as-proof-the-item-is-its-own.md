---
id: bug-45
title: heartbeat authenticates nobody, so a session that lost the claim race keeps the winner's claim alive and reads a 201 as proof the item is its own
created: 2026-09-21
tags: tracker, claim, heartbeat, api
---

## Symptom

Two machines were pointed at the same tracker issue (https://github.com/futin/guide-manager/issues/5) by hand — two `backlog-groom` sessions, no orchestrator,
which is a supported thing to do. The claim protocol worked exactly as designed: one session won, the loser's comment was deleted within a second or two. Both
machines then kept working the issue, two minutes and more after the claim comment existed. Neither ever learned it had lost.

## Repro

1. In a tracker project, `backlog.mjs start #5 --as groom` from session A. It wins and holds comment `C`.
2. From session B on another machine, `backlog.mjs start #5 --as groom`. It loses, deletes its own comment, and prints
   `#5 is already in progress (session <A>, heartbeat 0m ago)`.
3. From session B, `backlog.mjs heartbeat #5`. Before the fix this exits `0` and re-stamps A's claim. B concludes the claim is its own, and A's claim can now
   never go stale as long as B keeps beating.

## Cause

Two separate holes, both in the same direction.

**`heartbeat` authenticated nobody.** `ItemHeartbeatRequest` had no `session` field, the controller read none, and `GithubSource.heartbeat` asked only whether
the claim was released. It was the one write route with no notion of a caller — `claim` takes a session, `release` takes a session and enforces a triple
(holder / same run / anyone once dead), and `heartbeat` took neither. So a rival's beats keep the holder's claim live forever, which disables the
fifteen-minute staleness repair for the one issue that has two sessions on it; and a `201` reads as proof of ownership to whoever asked.

**Nothing printed this session's own identity.** `sessionIdentity()` has existed since task-46 and no command had ever printed it. The 409 named the holder
(`session e33d0074`) and stopped there, so a reader had a string with nothing to compare it against. The losing session spent its next minute searching
`~/.claude` for its own session id, probed the wrong variable (`CLAUDE_SESSION_ID`, unset), found nothing, and fell back to `heartbeat` as an ownership
oracle — which answered `0`.

## Affects

- `shared/types.ts` — `ItemHeartbeatRequest`.
- `server/src/items/items-write.controller.ts` — the `heartbeat` route.
- `server/src/items/sources/github.source.ts` — `GithubSource.heartbeat`.
- `skills/backlog/tools/backlog.mjs` — `start`, `heartbeat`, `show`.
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `trackerHeartbeat`, `trackerFinish`.

## Fix

`session` is required on `heartbeat` (a 400 without it, like `release`'s) and `runId` is the same optional same-run assertion. Who may beat is **`release`'s
triple minus its last clause**: the holder always, the run that owns the claim, and NOT anyone once the claim is dead — reviving a dead claim is the harm,
while retiring one stays `claim`'s business. The check runs before the released branch, `finished` included.

The identity half: `start`'s lost-race line and `heartbeat`'s refusal both end `— this session is <id>`, `show` prints `claim-session:` (empty, never absent,
when unheld) and `this-session:`, and `show --json` carries `session`.
