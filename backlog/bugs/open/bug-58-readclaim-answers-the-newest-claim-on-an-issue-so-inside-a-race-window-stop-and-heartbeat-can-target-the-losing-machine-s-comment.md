---
id: bug-58
title: readClaim answers the newest claim on an issue, so inside a race window stop and heartbeat can target the losing machine's comment
created: 2026-09-22
tags: tracker, claim
updated: 2026-09-23T07:20:22Z
groom-elapsed: 142
groom-tokens: 51433
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

`readClaim` (`server/src/items/sources/github.source.ts:839`) answers `newestClaim(...)` over every claim on the issue, on both paths — the cache at `:847`
and the fresh fallback at `:856`. "Newest" is the highest comment id, and the claim protocol resolves the holder the opposite way: `claim` decides with
`winner(...)` over the live claims, the LOWEST live id (`:433`). The two agree only while one claim is live. Inside a race window the loser's comment is both live and
newer, so the route names the loser as the holder until the loser deletes it. `claim` leaves such a comment in place on two of its paths: a failed
`deleteComment` (result unchecked, `:438`), and the after-read failure at `:390`, which by design never deletes. In those cases the window lasts the full
15-minute `CLAIM_STALE_MS`, not a poll tick.

The route gives no wrong write. It gives a wrong ANSWER, and each caller fails on it differently. Checked caller by caller:

- **`backlog.mjs stop`** (`skills/backlog/tools/backlog.mjs:2631`). While the loser's comment is live, the winner is refused locally: "held by session
  <loser> — not this one". The winner cannot stop an item it holds. Once the loser's comment is stale, the local check passes, and `stop` releases the LOSER's
  comment (`release` lets anyone retire a dead claim, `:598`). It bills counters computed from the loser's `at`, and leaves the winner's own claim unreleased.
  After that release the route still answers the loser's comment, now released, so every later `stop` prints "not in progress". The winner's claim is
  orphaned: `in-progress` and the assignee stay set, and the board shows the item as held until somebody contests the issue.
- **`backlog.mjs heartbeat`** (`:2864`). The server's session check (`:697`) refuses the loser's comment with a 409 that names the loser as the holder. The
  winner's claim is never beaten, so it goes stale and the next contestant retires it while the winner is still working. `heartbeat` never patches the
  loser's comment. The title's "can target" is the request, and the refusal is the harm.
- **`backlog.mjs abort`** (`:2728`). It checks the loser's host. If the loser is on another machine, `abort` refuses with "run abort there", pointing at the
  wrong machine.
- **`backlog.mjs show`** (`:2379`). The `claim-session:` / `claim-host:` lines (bug-45) name the loser as the holder. That is exactly the reading `show`
  exists to prevent.
- **`orchestrate.mjs reconcile`** (`reconcileClaimOf`, `orchestrate.mjs:4663`). The winner run's own item reads as `other` during the window. Transient, and
  the same fix corrects it.
- **Unaffected:** `orchestrate.mjs`'s release and heartbeat use the `commentId` that its own `claim` returned (`item.claim.commentId`), not this route.
  `claimCountersFor` (`:1993`) only takes the counters base from the route. In a race both comments were seeded from the same prior claim (`:353`), so the
  totals agree. The board mapper (`server/src/tracker/map-issue.ts:183`) does not use this route. Its `started`/`phase` from the newest unreleased claim
  shows the loser's `at` for one poll tick at most, and a lingering loser comment reads as held under any rule, because the mapper's contract is "any stamp,
  fresh or stale". The mapper stays as it is.

## Fix

Answer the HOLDER the way the protocol resolves it, and fall back to the newest claim only when nobody holds the issue. One pure helper, used on both
`readClaim` paths. No CLI change is needed: every affected caller already reads `held.commentId` and `held.record` from the route, and each one now receives
the right comment.

1. `server/src/tracker/claim.ts`: add `currentClaim(claims, nowMs)`, which returns `winner(liveClaims(claims, nowMs)) ?? newestClaim(claims)`. Its doc
   comment says the rule: the lowest live id is the holder, the same answer `claim` reaches. With nothing live, return the newest claim, released or not,
   because the counters live there and because `stop`'s released and stale paths depend on getting that claim back. Leave `newestClaim` exactly as it is.
   `claim`'s counter seed (`github.source.ts:353`) and the mapper still want the newest claim.
2. `server/src/items/sources/github.source.ts` `readClaim`: replace both `newestClaim(...)` calls with `currentClaim(..., Date.now())`. Keep the cache-first
   gate as it is: a cache miss is still "no claims at all", and the fallback still runs only when the cache holds nothing for the issue. Rewrite the doc
   comment's first line ("The newest claim on one item") and add a paragraph on bug-58: name the race window, and name the two `claim` paths that leave a
   loser's comment behind for up to 15 minutes.
3. Correct the prose that describes the route as answering the newest claim. `ItemWriter.readClaim` in `server/src/items/sources/source.ts:213`. The comments
   at `orchestrate.mjs:1978` and `:4647`, which are comment-only, with no behaviour change in the CLI. `skills/backlog-orchestrate/references/recovery.md:94`
   (`this-run` is "the holder is unreleased and this run's"). Add one sentence to the claim-protocol section of `docs/subsystems/invariants.md`: the read
   route resolves the holder by the same lowest-live-id rule. Do not edit the mapper lines at `invariants.md:2994` or `.claude/rules/tracker.md:47`. They
   describe the mapper, which still uses the newest claim.

Not `runner-fix`: the orchestrator's own claim writes use their stored `commentId`, and its CLI changes in comments only.

Test cases:

- `test/tracker-claim.test.ts`, `currentClaim`:
  - live claims at ids 100 and 101 give 100.
  - live 101 with released 100 gives 101.
  - stale unreleased 100 with live 101 gives 101.
  - nothing live, with released 100 and released 101, gives 101, the newest.
  - nothing live, with released 100 and stale 101, gives 101.
  - `[]` gives `null`.
- `test/tracker-cold-cache.test.ts` (or whichever suite drives `readClaim` against a faked client): two live claims on one issue, the winner (lower id) and
  the loser (higher id), give `commentId` equal to the winner's id.
  - Run this once with the comments in the poller cache (cache path).
  - Run it once with an empty cache and the listing served by the fake (fallback path).
  - Red-proof: each of those cases fails on the current `newestClaim` line.
- `skills/backlog/tools/backlog.test.mjs` needs no new case, because the CLI is unchanged. Run the suite to confirm it stays green.
- `pnpm test` and `pnpm run typecheck` stay green. Two supertest-bind cases are a known red on WSL, so compare against a pristine worktree before chasing them.
