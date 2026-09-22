---
id: bug-55
title: A losing claim deleted by another machine lingers in the comment cache as a phantom remote run
created: 2026-09-22
tags: tracker, claims, remote-runs
updated: 2026-09-22T21:08:49Z
groom-elapsed: 36
groom-tokens: 6114
started: 2026-09-22T20:41:25Z
execute-elapsed: 1644
execute-tokens: 123738
---

## Symptom

A claim comment that lost the race and was deleted by ANOTHER machine's server stays in this server's tracker comment cache, and `GET /api/orchestrator/runs`
keeps deriving a remote run from it. Observed live on 2026-09-22, two-machine test on `futin/guide-manager` #5:

- Mac run `run-20260922-201553` held claim `c5783449315` (dispatched, heartbeating).
- Linux run `run-20260922-201615` posted `c5783457040`, lost to the lower live id, and deleted it — GitHub answers 404 for that comment id.
- The Mac's `/api/orchestrator/runs` still lists `remote: run-20260922-201615`, `status: running`, `fresh: true`, #5 at `preflight`,
  `claim.commentId: 5783457040` — after a successful tracker poll at 20:19:24Z, several minutes after the deletion.

- Verified 20:29Z — the ghost reaches two more surfaces. The board card for #5 renders `executing · 11m` (`/api/items` maps `started:
  2026-09-22T20:16:34.526Z`, `phase: execute` off the ghost), and `GET /api/items/claim?id=5` answers `commentId: 5783457040` (session `9539ec37`, the Linux
  run) as the item's claim, while GitHub's own `issues/5/comments` lists only `c5783385738` and `c5783449315`, both released.

- Reproduced a second time at 20:31Z in a true race (both claims posted within the same second, after a server restart had cleared the first ghost): Mac
  `c5783676790` won and proceeded, Linux `c5783676872` (`run-20260922-203126`) lost and was deleted by the Linux server within ~10 s — and the Mac's
  `/api/orchestrator/runs` immediately listed that Linux run as `running`, `fresh`, holding the deleted id. So every lost race leaves one ghost on the WINNER's
  board; the protocol itself arbitrated correctly both times.

Expected to age into a stale — i.e. crashed-looking — remote run that never goes away until the server restarts.

## Repro

1. Two machines, one tracker project, both dashboards up with tokens.
2. Machine A starts a run; wait for its claim on issue N to be live.
3. Machine B starts a run; its claim on N loses and is deleted by B's server.
4. On A: `curl -s 127.0.0.1:4322/api/orchestrator/runs | jq '.remote'` — B's run is still there, holding a comment that no longer exists.

## Affects

- `server/src/tracker/poller.service.ts:317` — `forgetComment`, the only path that drops a comment from the cache, called only for deletions THIS process made
- `server/src/tracker/poller.service.ts:502` — the comment sync: conditional and incremental (`since` = high-water mark, plus ETag), upserting at `:555`
- `server/src/orchestrator/remote-runs.util.ts:292` — `deriveRemoteRuns`, which builds the phantom run from the cached ghost
- the board's claim-derived mapping (`started` / `phase` read off any unreleased claim in the same cache) — verified, card shows `executing`
- `server/src/items/sources/github.source.ts:847` — `readClaim` answers `newestClaim(claimsFor(number, this.poller.comments(repo)))` from the cache FIRST and
  falls back to the network only on a miss, so the read-only claim lookup returns the ghost too

## Cause

The comment read is incremental: `?since=<hwm>` returns comments created or edited since then, and a deleted comment is simply never mentioned again by any later
response. `forgetComment`'s own doc comment names exactly this hole ("without this, a losing claim would sit in the cache being counted as a live claim by the
mapper until the process restarted") but closes it only for the local writer — a loser deleted by another machine's server never reaches this process's
`forgetComment`, so the ghost is permanent. Three directions were weighed on 2026-09-22 (see `## Fix` for the chosen one): a periodic full, non-`since` resync
of the whole comment bag was rejected because a ghost would live up to a whole resync period and its cost scales with the repo's total comment count; a
mapper-side filter ("ignore a claim that has a lower live rival") was rejected because once the winner releases, the ghost becomes the lowest UNRELEASED claim
and is rendered again until it goes stale — and it would leave the cache itself wrong for `readClaim`.

## Fix

**Reconcile every claimed issue against GitHub once per poll tick, and let the fresh per-issue list be the truth for that issue's comments.** Fixing it in the
cache — the one bag all three readers (`deriveRemoteRuns`, the item mapper's `started`/`phase`, `readClaim`) consult — rather than in each reader.

Behaviour, in `TrackerPollerService.syncRepo` (`server/src/tracker/poller.service.ts`), after the repo-wide comments read succeeds:

- **Which issues:** every issue number for which the cache holds at least one UNRELEASED claim comment (`claimsByIssue` over `state.comments`, a claim with no
  `released` key). Released and non-claim comments never trigger a re-check. Issues with no unreleased claim cost no request — the steady state of a repo
  with nothing running is zero extra requests.
- **The read:** that issue's comments via `GithubClient.issueComments`, paginated to the end the way the other two loops are, sent CONDITIONALLY with a
  per-issue ETag kept in `RepoState` (a new `Map<number, string>`; `issueComments` gains the optional `etag` its siblings already take — `request()` already
  sends `if-none-match`). A `304` changes nothing. The ETag of an issue that stops being re-checked is dropped with it, so the map cannot grow without bound.
- **The reconcile:** on a `200`, every cached comment on THAT issue whose id is absent from the fresh list is deleted from `state.comments`, and every comment
  in the list is upserted — the same upsert `absorbComments` does, but WITHOUT moving `commentsHwm`, which belongs to the repo-wide stream alone (the task-46
  incident that field's doc describes is exactly what a shared mark would re-open).
- **The one exception to "absent means deleted":** a cached comment whose `created_at` is newer than the moment the per-issue request was sent, minus a grace
  of a few seconds (name the constant; reuse the claim protocol's settle figure if it fits), is kept even when absent. GitHub's comment listing is eventually
  consistent — the reason the protocol unions two lists — so a claim this process `absorbComment`-ed a second ago can legitimately be missing from a list
  made now, and dropping it would make the board show the item free while a session holds it.
- **Failures:** every response goes through `handleFailure`, exactly like the other two reads, and a failure leaves that issue's cached comments untouched and
  stops the per-issue loop for this tick (a rate limit must not be hammered by the remaining issues). A `404` on the issue (deleted/transferred) is treated as a
  successful empty list for reconcile purposes — its claims are gone too.
- `forgetComment` stays: it is still the zero-latency path for a loser this process deleted itself; the reconcile is what covers every other machine's.
- Doc updates in the same change: `forgetComment`'s and `RepoState.comments`' comments stop implying the cache only goes wrong for local deletions;
  `.claude/rules/tracker.md` (the tracker-cache bullet) and `docs/subsystems/invariants.md#the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value`
  gain one sentence each for the per-issue reconcile and why the repo-wide `since` read can never see a deletion.

Test cases (jest, flat in `test/`, against the fake GitHub in `test/helpers/github.ts`; extend `test/tracker-poll.test.ts`):

1. **The bug, red first:** cache primed with two unreleased claims on #5 (ids 100 and 200); GitHub then deletes 200. After one tick, `comments(repo)` no longer
   yields 200, still yields 100, and `deriveRemoteRuns` over it returns no run for 200's `runId`. Must fail on today's code (200 survives).
2. Winner releases AFTER the ghost appeared (100 edited to `released: aborted`, 200 deleted): after one tick neither is unreleased and the item maps
   `started: ''` — the case the mapper-side filter would have got wrong.
3. A repo whose cached claims are all released, or that has none: the tick makes NO `issues/<n>/comments` request (assert on the fake's request log).
4. Conditional: second tick sends `if-none-match` with the first tick's per-issue ETag; a `304` leaves the cache byte-identical.
5. Grace: a claim absorbed via `absorbComment` with `created_at` = now, absent from the per-issue listing, survives the tick; the same claim with `created_at`
   older than the grace is dropped.
6. Failure isolation: the per-issue read answers 403 with `x-ratelimit-remaining: 0` → cache for that issue unchanged, `access` is `rate-limited`, and no
   further per-issue request is made that tick.
7. `commentsHwm` is unchanged by a reconcile that upserted a comment newer than it.
8. `GET /api/items/claim` for #5 after the tick in case 1 answers claim 100, not 200 (the cache-first `readClaim` path, `server/src/items/sources/github.source.ts:847`).

Done when: `pnpm test` and `pnpm run typecheck` are green; case 1 was seen red before the fix. Live check, once both machines run the fixed build: repeat the
2026-09-22 race on a tracker issue — within ~15 s of the loser deleting its comment, the winner's `/api/orchestrator/runs` has no remote run for the loser's
`runId`, and the card for the issue shows only the winner's claim.

## Outcome

2026-09-22 — Fixed in the cache, as groomed. `TrackerPollerService.syncRepo` now ends (after both repo-wide reads succeed, before the label bootstrap) with
`reconcileClaimedIssues`: every issue the cache holds an UNRELEASED claim on is re-read through `GithubClient.issueComments` (which gained the optional
`etag`), paginated to the end before anything is deleted, and that list is the truth for the issue — absent cached comments dropped, listed ones upserted
without moving `commentsHwm`. `RepoState.issueChecks` keeps, per re-checked issue, the ETag AND the ids the list held, so a `304` is reconciled against the
remembered list rather than skipped (otherwise a comment the cache gained between two unchanged lists — a grace-kept one, or one the repo-wide read caught in
the ms between its creation and deletion — would be frozen in by every later `304`); the map is pruned each tick to the issues still claimed. A comment younger
than `RECONCILE_GRACE_MS` (new, 10 s — not the protocol's 1 s `settleMs`, because it compares GitHub's `created_at` against this machine's clock and has to
absorb skew as well as replication lag) survives being absent. A failure goes through `handleFailure`, leaves that issue untouched and ends the reconcile (and
the label bootstrap) for the tick; a `404` on the issue reconciles as an empty list and leaves `access` alone. `forgetComment` stays as the zero-latency local
path.

Tests: new flat jest suite `test/tracker-reconcile.test.ts` (13 cases, real app + `FakeGithub`) covering the groomed cases 1–8 plus: no-request for a repo
with no claims, pruning once the last unreleased claim is gone, and a grace-kept comment dropped by a later `304` once the grace lapses. Put in its own suite
rather than extending `test/tracker-poll.test.ts` as the item suggested: that file's rule-table fake cannot delete a comment, and the item's own cases need
`FakeGithub` and the `/api/items` + `/api/items/claim` routes, which is `tracker-cold-cache.test.ts`'s harness. `test/helpers/github.ts` gained an ETag/`304`
on the per-issue comments endpoint only (the repo-wide reads stay untagged so no other suite's request counts move), `hideFromIssueLists`,
`hideFromRepoStream`, and a one-shot `failNext`.

Verification (`env -u BM_MACHINE_NAME pnpm test`, then `pnpm run typecheck`):

```
Test Suites: 130 passed, 130 total
Tests:       2208 passed, 2208 total
# tests 794
# pass 794
# fail 0
pnpm test: both runners passed.
typecheck exit 0
```

Plain `pnpm test` in this shell fails 8 node cases (`orchestrate.test.mjs` 346, `backlog.test.mjs` 688/689/692/698–701), all host-identity assertions
reading `actual: 'aj_macbook'`: `BM_MACHINE_NAME` is exported from `~/.zshenv` on this machine and those tests do not isolate it. Pre-existing and unrelated —
this change touches no file under `skills/` — and 794/794 with the variable unset, above.

Live check, 2026-09-22 — passed. Both machines raced `futin/guide-manager#5` from their boards. The Mac run `run-20260922-213302` claimed first
(`c5784526438`) and kept it; the Linux run `run-20260922-213421` posted `c5784546034` at 21:34:38, lost (`#5 skipped`) and deleted its comment — GitHub no
longer listed it at 21:34:44. The Mac board still showed the loser as a remote run, and `/api/items/claim` still answered with it, until 21:35:00, then dropped
both, and the claim route answered `c5784526438`. That is ~16 s from the first 5 s monitor sample, which fits the 10 s `RECONCILE_GRACE_MS` plus one poll tick
and is within the item's "~15 s" at that sampling granularity. The Linux board stayed consistent throughout. One setup note: the Mac stack's `nest start --watch`
had not picked up the merge (the bind-mounted watcher missed git's writes), so the first attempt ran the old build; `docker compose restart server` fixed it,
checked by `reconcileClaimedIssues` appearing in `/app/dist/server/src/tracker/poller.service.js`.

Contract sweep: 4 sites updated (`docs/subsystems/api.md` — "two conditional requests per connected repo" per tick; `.claude/rules/tracker.md` tracker-cache
bullet; `docs/subsystems/invariants.md` tracker-cache section; `forgetComment`'s and `RepoState.comments`' doc comments in `server/src/tracker/poller.service.ts`,
plus `issueComments`' in `github.client.ts`). Left standing on purpose: `docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md` §5.1's "two
requests per fifteen seconds" budget — a dated design spec, not reference docs; the reconcile adds only budget-free `304`s plus one read per tick a claim moves,
which the new method's doc comment states.

Red proof: 10 tests went red with the change reverted (the `reconcileClaimedIssues` call removed from `syncRepo`); the other 3 guard the fix's own shape and
are green on the old code by construction, so each was proven against a targeted mutation instead — "all released → no request" red when released claims are
re-checked too, "no claims → no request" red when #5 is always checked, "keeps a just-absorbed claim" red with the grace check removed.
