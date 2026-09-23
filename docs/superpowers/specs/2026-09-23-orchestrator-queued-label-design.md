# `orchestrator:queued` — marking a tracker run's queue on the issues

Status: approved in brainstorming 2026-09-23, awaiting spec review. Extends [the tracker-backed backlog design](2026-09-17-tracker-backed-backlog-design.md)
§5.2 (label set), §5.3 (mapping), §6.2 (routes) and §7 (the orchestrator on a tracker project).

## Why this exists

An orchestrator run on a tracker project claims one issue at a time. Every other item in its queue looks, to a teammate browsing github.com or another
machine's board, exactly like an unplanned open issue — so a person picks one up, the run reaches it an hour later, its `claim` is refused at preflight and
the item is skipped. Nobody did anything wrong and both sides lost time.

The fix is a signal, not a lock: every issue a live run intends to work carries a label saying so, visible in GitHub's own UI and filterable there
(`-label:orchestrator:queued`), and drawn as a badge on every machine's board.

## Non-goals

- **Not a claim.** The label reserves nothing. Anyone may still claim a queued item; the claim protocol (§6.3) is unchanged and remains the only mutual
  exclusion. A human claim simply wins, and the run skips the item at preflight exactly as it does today.
- **Not the assignee.** The assignee already means "who last worked this" (§6.3: set on claim, kept on release). Setting it for a plan would make a queued item
  indistinguishable from a worked one.
- **No file-project equivalent.** A `files` project's queue is already visible on the one machine that can see its run; there is nobody else to tell.
- **No per-run attribution on the label.** One label name for every run. Which run holds the item is already derivable from the claim comments (§7.3).

## 1. The label

`orchestrator:queued` joins `TRACKER_LABELS` (`server/src/tracker/labels.ts`) as the ninth entry — "the closed eight" of §5.2 becomes nine. Description:
`In a live orchestrator run's queue, not yet picked up — a plan, not a claim`. Created by the poller's existing bootstrap. A repo whose bootstrap already ran in
this process gets it on the next server start; until then GitHub creates the label on first use with its default colour, which is cosmetic only.

## 2. The write route — the eighth

`POST /api/items/queue`, body `{ project, id, queued: boolean }`, in `items-write.controller.ts` beside the seven. Everything the seven are, it is: guarded by
content-type and origin, refused for a `files` project, serialised per item through the same per-item lock.

- `queued: true` → add the label (`client.addLabels`).
- `queued: false` → remove it (`client.removeLabel`). A 404 — the label was not on the issue — is success: every caller of `false` is a sweep, and a sweep's
  contract is "the label is not there", which it is not.
- A closed issue is not refused: removing a stale label from a closed issue is a legitimate cleanup, and adding one to a closed issue never happens because the
  queue builder only reads open items.

The driver reaches GitHub only through this route — the headless session never sees the token (§11). The CLAUDE.md headline "The seven `/api/items/*` write
routes" becomes "eight", and `invariants.md`'s entry under that anchor gains the route.

## 3. Lifecycle — who adds it, who removes it

| Event                                   | Writer                         | Effect                                                                                                    |
| --------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `init` on a tracker project             | `orchestrate.mjs` (driver)     | add to every queue item the run will attempt — the queue as built, already bounded by `--max`             |
| claim won (`GithubSource.claim`)        | server                         | `+in-progress` and `−orchestrator:queued` in the same step, whoever claimed — a run or a human            |
| item skipped (claim refused, gate fail) | driver                         | remove                                                                                                    |
| `finish`                                | driver                         | sweep: remove from every queue item that was never claimed                                                |
| board **Stop**                          | server, inside `AgentsService.stop` | sweep immediately, before the abort spawn, from the run file's queue: every item never claimed        |
| `--abort` (the session Stop spawns)     | `orchestrate.mjs cmdAbort`     | the same sweep again — the backstop when the server's sweep partly failed. Idempotent by §2's 404 rule    |
| pause                                   | nobody                         | kept — a paused run still plans these items                                                               |
| resume                                  | nobody                         | nothing re-added: a resumable run's labels were never removed                                             |
| crash, never stopped                    | nobody                         | the label stays; §4 draws it as stale, and a Stop on the crashed run (still `running` on disk) clears it  |

### 3.1 Why the server sweeps at Stop, not only the driver

The driver reads a stop request only at its dispatch gates (the stop invariant), so a stop pressed at the start of a long execute session would leave the
queue labelled for that whole session — the opposite of what the stop is for, which is telling everybody the plan is off. And a dead driver reads nothing. The
server holds the token and the run file's queue, so it can answer "the plan is off" within one request. The spawned `--abort` (bug-54: spawned on every Stop,
live driver or not) repeats the sweep, so a server sweep that failed halfway — rate limit, network — is still finished by a session that is already coming.

The server's sweep lives behind the item source, not in `AgentsService`: `AgentsService.stop` calls one method on the tracker write side
(`GithubSource.unqueue(project, ids)` or the equivalent) and never touches `GithubClient` itself, so the per-item lock and the refusal mapping stay in one
module. A `files` project's stop does not call it.

### 3.2 Failure is a warning, never a park

Every label write in the driver is advisory. A failed add at `init` or a failed remove at skip prints one stderr line naming the item and the error and the run
continues — the label is not state the run reads back, and parking a run because a cosmetic signal did not land would trade real work for a hint. The server's
Stop sweep likewise never fails the stop: a failed sweep is reported in `StopResult` (a new optional `unqueueFailed: string[]` of ids) and the stop proceeds.

### 3.3 The claim swap

`GithubSource.claim` already adds `in-progress` on a won claim. It also removes `orchestrator:queued` there, rather than the driver doing it after: the claim
is the moment the item stops being planned and starts being worked, and every claimant — a run, `backlog-execute` by hand, another machine — goes through that
one method. A lost claim removes nothing: the winner's claim already did.

## 4. Reading it

### 4.1 Mapper

`BacklogItem.queued?: boolean`, set by the tracker mapper alone, exactly as `runnerFix` is (§5.3): `true` when the label is present, the key absent otherwise.
The label is removed from `tags` like every other label the mapper consumes. A `files` item never carries the key.

### 4.2 Card

Derived in `client/src/lib/tracker.ts` beside the other tracker readings, as one three-way value: `'live' | 'stale' | null`.

- `null` — no label.
- `'live'` — the label is set and the item's project has a live run: a local run whose status is `running` or `paused` and is not crashed, or a remote run
  (`OrchestratorRunsPayload.remote`) for the same repo that is live by the same freshness rule the band already uses.
- `'stale'` — the label is set and no live run holds the project. A crashed run, a run on another machine that died without its Stop, or a label added by hand.

The card draws `queued` for `'live'`, and a dimmed `queued · stale` for `'stale'`, whose title says no live run holds it and it can be removed on GitHub (or by
stopping the crashed run, when it is this machine's). One badge look in `components/ui/`, cited against `DESIGN.md` §8 like every other badge. No new surface
and no new control: this is a reading, the fourth tracker reading on the card.

## 5. Testing

- **Route** (`test/tracker-write.test.ts` or a sibling): add, remove, remove-404-is-success, refused for a `files` project, guarded like the seven, serialised
  per item with a concurrent claim.
- **Claim swap**: a won claim adds `in-progress` and removes `orchestrator:queued`; a lost one removes neither.
- **Stop sweep**: removes from exactly the never-claimed queue items of a tracker run; a `files` run makes no call; a sweep failure lands in `unqueueFailed`
  and the stop still records and spawns.
- **Driver** (node, beside `orchestrate.mjs`): `init` adds for every queued item within `--max`; skip removes; `finish` and `cmdAbort` sweep; a failing route
  prints a warning and the command still exits `0`.
- **Mapper**: the label sets `queued`, is absent from `tags`; no label → key absent.
- **Labels**: `TRACKER_LABELS` has nine entries; the bootstrap creates the ninth when missing.
- **Card**: `'live'` with a local running run, `'live'` with a live remote run, `'stale'` with neither, `null` without the label.

## 6. Docs

- CLAUDE.md: the write-routes headline says eight; `.claude/rules/` and `invariants.md` gain the route and a new entry — **`orchestrator:queued` is a plan,
  never a claim: the driver adds it, the claim and the Stop remove it, and no reader treats it as exclusion.**
- The tracker spec: §5.2 nine labels, §5.3 the `queued` row, §6.2 the eighth route, §7 a pointer here.
- `docs/subsystems/skills.md` (driver lifecycle) and `docs/subsystems/board.md` (the card reading).
