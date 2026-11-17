# Jira Run gate: a quiet Run no longer blocks the next one

Short design (small change). Status: draft, awaiting approval.

## Intent

Today a Jira ticket holds one live board-started Run at a time (the one-run gate). A Run's link ends only after the dashboard has reported it not busy for
two minutes (`JIRA_QUIET_MS`), and the dashboard's own hook holds a finished session for ~10 minutes until someone presses Stop. So after a Run finishes
its turn, `Run ▾` stays disabled — `Next session takes over once this one ends.` — for 2–3 minutes or until Stop. The user wants to start the next Run the
moment the current one is idle, without stopping it and without waiting out the timer.

## Goals, non-goals, anti-goals

- **Goal:** a new Run on a key is allowed as soon as every live `run` link on that key is Quiet; the quiet session stays live (still answerable, ends the
  usual way).
- **Non-goal:** truly parallel Runs (two sessions working at once on one ticket). Considered and declined for now (see Approaches).
- **Non-goal:** changing the reconciler's timers (`JIRA_LIVE_GRACE_MS`, `JIRA_QUIET_MS`) or how/when a link ends.
- **Anti-goal:** a second Run starting while the first is still mid-turn — `working`, waiting on a question / plan / permission / remote reply, inside its
  2-minute grace, or unknowable because the dashboard is unreachable. Every unknown blocks, as today.

## Approaches

1. **Quiet-only gate (picked by the user).** The gate refuses while any live `run` link on the key is busy or unknown, and lets the Start through when all
   are quiet. Runs take turns; no wait for the link to end. Smallest change; no concurrent edits in one worktree.
2. **Deliberate parallel join.** Lift the gate; the launch sheet marks a Run as joining the live one(s), and the composed prompt adds a stay-in-scope /
   no-transition / no-push paragraph. Real parallelism, but several sessions committing in one shared worktree. Declined by the user for now.
3. **Drop the gate entirely.** Every Start spawns. Rejected: a double-click or an unnoticed live Run becomes a second session in the same checkout.

The user also chose, should parallelism come back later, one shared branch and worktree per ticket rather than a branch per Run.

## Design

- **One predicate, both sides.** A new function in `shared/jira-sessions.ts` — call it `runYields(link, row, reachable)` — is true when the link is a live
  `run` link whose `quietSince` is set (the reconciler sets it only past the 2-minute grace, on a row that is neither `working` nor `question`) **and**
  `sessionState(link, row, reachable) === 'quiet'` (so `lost`, `plan`, `permission`, `reply`, `answer`, `working` all block). The server gate and the
  client's `Run ▾` state both read it; neither re-derives "quiet".
- **Server — `JiraLiveService.reserve(key, repo, 'run')`:** still refuses a `run` reservation already on the key (two Starts never race), and refuses a live
  `run` link on the key unless `runYields` holds for every one of them, reading the rows and reachability the reconciler already keeps in the service
  (`setRows` / `markUnreachable`). A key may therefore hold several live `run` links; `confirm`, `get`, `snapshot` and `confirmed` must cope with that (the
  builder decides each one's answer for "several" — `get` and the `session` fact read the newest, as the band already does).
- **Refusal text:** the 409 names why — e.g. `<KEY> has a Run still working` (or `… waiting on you`, `… just started`, `… dashboard unreachable`). The wording
  is the builder's; the reason must come from the same state the chip shows.
- **Client — `runChipState`:** `live` (disabled) only while a reservation is `starting` or some live `run` link on the key fails `runYields`. While the
  sessions payload has not landed, `status.live[key]` alone keeps it `live`, as today (it carries no row). The disabled chip's title names the blocking
  state.
- **Band copy (`JiraDetail.tsx`):** `Next session takes over once this one ends.` becomes conditional — while blocked, something like `Next Run can start
  once this one is quiet.`; while every live Run is quiet, the line says a new Run can start now (or is omitted). Exact copy is the builder's, per
  `.claude/DESIGN.md`.
- **Unchanged:** reply reservations; `branch`/`manual` links (still block nothing); the review action's gates (`reviewGate` on the client, `branchBusy` on the
  server) keep treating any live `run` link as blocking — a review is a different flow and this change does not widen it.

## Constraints

- Every rule in `.claude/rules/jira.md` (the link store, the reconciler, `reserve`'s synchronous check-and-set) stays true except the one-run gate's
  wording, which the builder updates there, in `docs/subsystems/invariants.md` and in the code comments that state it (`JiraDetail.tsx` header, `live.service.ts`,
  `jira-dispatch.service.ts`).
- The rows the gate reads are 15–60 s old by design (the reconciler's period). A session that has just begun a new turn may not block yet; a session that has
  just gone idle may stay blocked for one tick. Accepted.

## Left to the builder

Exact refusal and copy wording; how `get`/`snapshot` answer for several live Runs on a key; test layout (the shared predicate's table, `reserve`'s new cases,
`runChipState`'s cases, the band copy).
