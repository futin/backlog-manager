# Jira Run gate: a quiet Run no longer blocks the next one

Short design (small change). Status: draft, awaiting approval.

## Intent

Today a Jira ticket holds one live board-started Run at a time (the one-run gate). A Run's link ends only after the dashboard has reported it not busy for
two minutes (`JIRA_QUIET_MS`), and the dashboard's own hook holds a finished session for ~10 minutes until someone presses Stop. So after a Run finishes
its turn, `Run ▾` stays disabled — `Next session takes over once this one ends.` — for 2–3 minutes or until Stop. The user wants to start the next Run the
moment the current one is idle, without stopping it and without waiting out the timer.

Observed 2026-11-17 (the user's screenshot of the Detail band): a finished Run held by the dashboard reads `Quiet` (the orange band) while the chip says
`Running · 10m` — so the held state is `quiet`, not `question`, and the predicate below yields for it. The dispatch's comment that a session "holding in the
dashboard's reply window … would read `question`" (`jira-dispatch.service.ts`, the `oneShot` line) is about a different hold; a Run that IS in that state
wants a person and keeps blocking, by design. The builder confirms the held-Run row once against the live dashboard (`GET /api/jira/sessions`) during
verification.

That check ran before the build (2026-11-17, against this machine's live API and dashboard): of 23 ended `run` links in `jira-links.json`, 22 ended
`idle` — the reconciler ends a link only on a row that is neither `working` nor `question`, so a held Run reads idle — and the dashboard's own list showed
43 `idle`, 4 `working` and 3 `question` rows, every `question` one carrying `remoteReply` or `permissionWait`. Expected row for a finished, held Run:
`status: 'idle'`, `remotePlan`, `permissionWait` and `remoteReply` all false. If verification finds held Runs reading `question` instead, the build
stops and returns to the user: the gate would never open in exactly the case it exists for.

## Goals, non-goals, anti-goals

- **Goal:** a new Run on a key is allowed as soon as every live `run` link on that key is Quiet; the quiet session stays live (still answerable, ends the
  usual way).
- **Non-goal:** truly parallel Runs (two sessions working at once on one ticket). Considered and declined for now (see Approaches).
- **Non-goal:** changing the reconciler's timers (`JIRA_LIVE_GRACE_MS`, `JIRA_QUIET_MS`) or how/when a link ends.
- **Anti-goal:** a second Run starting while the first is still mid-turn — `working`, waiting on a question / plan / permission / remote reply, inside its
  2-minute grace, or unknowable because the dashboard is unreachable. Every unknown blocks, as today.

## Approaches

1. **Quiet-only gate (picked by the user).** The gate refuses while any live `run` link on the key is busy or unknown, and lets the Start through when all
   are quiet. Runs take turns; no wait for the link to end. Smallest change. It does not stop two sessions sharing a checkout: the quiet session stays
   answerable, and answering it while the new Run is mid-turn puts both to work in one worktree (the reconciler then un-quiets it). Accepted — it takes the
   user's own reply to a session they can see, and the user chose the shared tree.
2. **Deliberate parallel join.** Lift the gate; the launch sheet marks a Run as joining the live one(s), and the composed prompt adds a stay-in-scope /
   no-transition / no-push paragraph. Real parallelism, but several sessions committing in one shared worktree. Declined by the user for now.
3. **Drop the gate entirely.** Every Start spawns. Rejected: a double-click or an unnoticed live Run becomes a second session in the same checkout.

The user also chose, should parallelism come back later, one shared branch and worktree per ticket rather than a branch per Run.

## Design

- **One predicate, both sides.** A new function in `shared/jira-sessions.ts` — call it `runYields(link, row, reachable)` — is true when the link is a live
  `run` link whose `quietSince` is set (the reconciler sets it only past the 2-minute grace, on a row that is neither `working` nor `question`) **and** the
  dashboard's latest good read carries a row for it (`row !== null`) **and** `sessionState(link, row, reachable) === 'quiet'` (so `lost`, `plan`,
  `permission`, `reply`, `answer`, `working` all block). The row requirement is what makes "every unknown blocks" true: `quietSince` is persisted while the
  rows are memory only and empty after a restart, `sessionState` reads a null row as `quiet`, and a row that fell off a full 50-row list leaves `quietSince`
  standing (`jira-live.service.ts`, `row === undefined && answer.full`) — each of those is a link the server knows nothing current about, and it blocks.
  (A link with no row in a SHORT list is `gone` and ends within `JIRA_QUIET_MS` anyway.) The server gate and the client's `Run ▾` state both read it;
  neither re-derives "quiet".
- **Server — `JiraLiveService.reserve(key, repo, 'run')`:** still refuses a `run` reservation already on the key (two Starts never race), and refuses a live
  `run` link on the key unless `runYields` holds for every one of them, reading the rows and reachability the reconciler already keeps in the service
  (`setRows` / `markUnreachable`). A key may therefore hold several live `run` links; `confirm`, `get`, `snapshot` and `confirmed` must cope with that (the
  builder decides each one's answer for "several" — `get` and the `session` fact read the newest, as the band already does).
- **Refusal text.** `reserve` stays a boolean; the dispatch's `busy(key)` words the 409 from a second shared function beside `runYields` — call it
  `runBlockPhrase(link, row, reachable)`, `null` when the link yields — applied to the newest live `run` link on the key that does not yield. Its phrase,
  first match wins:

  | Blocking state | Phrase |
  | --- | --- |
  | `lost`, or no row in the latest good read | `not seen by the dashboard` |
  | `plan`, `permission`, `reply`, `answer` | `waiting on you` |
  | `working` | `still working` |
  | anything else (`quiet` without `quietSince` yet — inside the grace, or idle since less than one reconcile tick) | `not quiet yet` |

  The 409 is `<KEY> has a Run <phrase>` (e.g. `PAY-131 has a Run still working`). The client applies the same `runBlockPhrase` to the same link (the newest
  live `run` link on the key that does not yield) and the disabled chip's title is `a Run on <KEY> is <phrase>` — lower-case, like the chip's other titles.
  The three disabled cases with no such link have their own titles: a `starting` reservation → `a Run on <KEY> is starting`; a confirmed `status.live`
  entry the payload has not seen, or no sessions payload at all → `a Run on <KEY> is not quiet yet`. `blockTitle` (`JiraRunMenu.tsx`) is where these
  replace `a session is running on <KEY>`, so a parent's rows, which reuse it, follow. The two
  existing refusals for a reservation stay word for word: `<KEY> is starting` and `too many Jira sessions are starting — try again in a moment`. `<KEY>
  already has a session` goes for a Run; a review's strict refusal keeps it.
- **Band line (`JiraDetail.tsx`, the `.jira-detail-next` span):** `Next session takes over once this one ends.` is replaced. While the chip is disabled it
  follows `runChipState`'s answer for the issue: `live` → `Next Run can start once this one is quiet.`; `ready` with at least one live `run` link on the
  key → `Quiet — a new Run can start now.`; anything else — `ready` with only `branch`/`manual`/`reply` links live (they never gated a Run), or `no-repo`
  — draws no line. The band itself still shows while `liveCount > 0`, as today; only the line is conditional.
- **Client — `runChipState`:** keeps today's union of two sources (the header comment's ruling 95), narrowed by the predicate. `live` (disabled) while any
  of: a `status.live[key]` entry that is `starting`; a confirmed `status.live[key]` entry whose `sessionId` is not a live `run` link in the sessions payload
  (a Run the server just confirmed and the 15 s sessions poll has not seen — it has no row, so it cannot be judged quiet); or a live `run` link on the key in
  the payload that fails `runYields`. With no sessions payload, any `status.live[key]` entry keeps it `live`, as today. `snapshot()` reports one entry per key
  (today the last in store order); with several live Runs per key it reports the NEWEST by `startedAt` — the builder makes that explicit — and the chip's
  union rule above holds whichever one it is, because every live `run` link is in the payload too. The disabled chip's title names the blocking state.
- **Unchanged:** reply reservations; `branch`/`manual` links (still block nothing); the review action's gates. A review reserves through the same
  `reserve(key, repo, 'run')` (`jira-dispatch.service.ts`), and `branchBusy` checks only the MR's branch, so a review would otherwise pass over a quiet Run on
  another branch while the client's `reviewGate` still blocks. So `reserve` takes the quiet rule only for a non-review Run (an explicit argument, the
  dispatch passing it from the action), and a review keeps today's strict key check: any live `run` link or reservation on the key refuses it.

## Constraints

- Every rule in `.claude/rules/jira.md` (the link store, the reconciler, `reserve`'s synchronous check-and-set) stays true except the one-run gate's
  wording, which the builder updates there, in `docs/subsystems/invariants.md` and in the code comments that state it (`JiraDetail.tsx` header, `live.service.ts`,
  `jira-dispatch.service.ts`, the `runChipState` header in `client/src/lib/jira.ts`), and in `.claude/rules/board.md` — the `Run ▾` bullet's "a live key a
  disabled one" and the CodeRabbit bullet's `reviewGate` wording (which stays strict, but must say so against the new Run rule); `.claude/DESIGN.md`'s Run
  chip entry (`a session is running on <KEY>`); and `docs/subsystems/jira.md`'s one-run-per-key gate and its 409 table.
- The rows the gate reads are 15–60 s old by design (the reconciler's period). A session that has just begun a new turn may not block yet; a session that has
  just gone idle may stay blocked for one tick. Accepted.

## Left to the builder

How `get` answers for several live Runs on a key (`busy` needs the newest blocking one; the `session` fact reads the newest); the argument's name on `reserve`; test layout (the shared predicate's table, `reserve`'s new cases,
`runChipState`'s cases, the band line's three cases as test targets).
