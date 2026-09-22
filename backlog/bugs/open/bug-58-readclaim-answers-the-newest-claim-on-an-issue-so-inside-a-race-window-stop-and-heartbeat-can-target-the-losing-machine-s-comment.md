---
id: bug-58
title: readClaim answers the newest claim on an issue, so inside a race window stop and heartbeat can target the losing machine's comment
created: 2026-09-22
tags: tracker, claim
---

## Symptom

While two machines' claims are both live on one issue (the race window, before the loser deletes its comment), `GET /api/items/claim` answers with the
NEWEST claim, which is the loser's, not the winner's. Seen 2026-09-22 during the bug-55 race: the Mac board's claim route answered the Linux loser's
`c5784546034` until it cleared, then `c5784526438`.

## Repro

1. Two machines claim the same tracker issue within a poll tick of each other.
2. Before the loser deletes its comment, call `/api/items/claim?project=<p>&id=<n>` on the winner's server.
3. The answer is the loser's comment id.

## Affects

- `server/src/items/sources/github.source.ts:839-858` (`readClaim`, both the cache path at `:847` and the fresh fallback at `:856`)
- `newestClaim` in `server/src/tracker/claim.ts`
- callers that act on the answer: `backlog.mjs` `stop` / `heartbeat` in a tracker project

## Cause

`readClaim` picks `newestClaim(...)` over every claim on the issue, with no filter by session or host. Its doc comment says the route exists so `stop` and
`heartbeat` learn their own `start`'s comment id, but the newest claim is only this session's own when nobody else has claimed since. Inside the race window
the winner's `stop` or `heartbeat` can patch the LOSER's comment, which the claim protocol ("one comment per session per issue, lowest live id wins") says it
does not own.

## Fix

unknown — candidates: filter by the calling session (the CLI knows it) before taking the newest, or answer `winner(...)` (the lowest live id) the way the
protocol resolves every other read. Groom should check which of `stop`, `heartbeat` and the board card each needs.
