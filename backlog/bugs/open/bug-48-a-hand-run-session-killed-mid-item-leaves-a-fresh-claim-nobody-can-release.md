---
id: bug-48
title: a hand-run session killed mid-item leaves a fresh claim nobody can release, and there is no human equivalent of the orchestrator's abort
created: 2026-09-21
tags: tracker, claim, cli
updated: 2026-09-21T20:37:35Z
groom-elapsed: 215
groom-tokens: 24442
---

## Symptom

The Linux machine was stopped by hand while a `backlog-execute` session held https://github.com/futin/guide-manager/issues/5. The session passed through no
terminal stage, so it released nothing:

```
id=5766769179  session=f51e844e-…  hb=2026-09-21T20:06:22Z  released=false
labels: ["type:bug", "in-progress"]
```

For the next fifteen minutes the item reads as in progress on every machine and its dispatch control is disabled everywhere. Under the release triple — holder
always, the run that owns the claim, anyone once the claim is dead — nobody qualifies: the holder is gone, there is no run, and the claim is fresh. There is no
command to run. The only options are to wait out the window or delete the comment by hand on GitHub, which destroys the record of work that was done and the
counters that prove it.

## Repro

1. From machine A, `backlog.mjs start #5 --as execute`. A holds the claim.
2. Kill A — close the session, stop the machine, anything that is not a terminal stage.
3. From any machine, try to clear it. `stop 5 --abandon` is refused: the caller is not the holder and the claim is not dead. There is no `--force`, and there is
   no run id to assert.

## Evidence

The orchestrator has exactly this path and it works: `orchestrate.mjs abort` releases with `reason: 'aborted'` (bug-40), because a torn-down run passes through
no terminal stage and an unreleased claim is not repaired by going stale — the mapper reads `started`/`phase` off any unreleased claim, fresh or stale. Every
word of that reasoning applies to a hand-run session. What a hand-run session does not have is `abort`: `backlog.mjs`'s vocabulary is `start` / `stop` /
`heartbeat`, and `stop` is the holder's own verb.

The asymmetry is the finding. A run gets a documented, one-command teardown. A person who closes a session gets a fifteen-minute lockout on every machine and an
invitation to fix it by hand on the tracker — which is how the earlier stuck claim on this same issue got cleared, and hand-clearing is the thing the protocol
is supposed to make unnecessary.

## Affects

- `skills/backlog/tools/backlog.mjs` — the missing verb.
- `server/src/items/sources/github.source.ts` — `release`'s triple, if the answer is a fourth clause rather than a new caller-side assertion.
- `server/src/items/items-write.controller.ts` — the `release` route's validation, same condition.

## Cause

**The release triple has no clause for the one party who actually knows.** `GithubSource.release` refuses when the claim is live, the caller is not the holder,
and no `runId` matches (`server/src/items/sources/github.source.ts:551`). A hand-run session that is killed satisfies all three: the holder is gone, `run` is
absent by construction (a hand claim carries none, deliberately, so a run can never evict a person at a terminal), and `isLive` is true because `heartbeat` was
re-stamped seconds before the kill. Every clause holds and every clause is answering about somebody who no longer exists.

**The claim's own repair path does not reach it either.** `claim`'s step 5 releases every OTHER unreleased claim that has gone STALE, and `start` retires a dead
claim for the next contender — so the protocol does have a self-healing path, and this claim is simply too young for it. The fifteen minutes are not a grace
period anybody chose for this case; they are `CLAIM_STALE_MS` doing its ordinary job on a claim whose holder died between beats.

**What the item calls an asymmetry is really a missing fact, not a missing permission.** The orchestrator's teardown works because a run has a `runId` — a
durable name for the thing that is gone, published in the claim, checkable by a process that is not the dead one. A hand-run session publishes only `session`,
which is exactly the identifier bug-46 shows cannot be resolved by anybody but the machine it was minted on. So the reason there is no `abort` verb is not that
nobody wrote one: there has been nothing for it to assert.

**And the triple is a mistake boundary, not a security one.** `stop` already sends `session: sessionIdentity()` and the server compares it to the record, so a
caller that wanted to release somebody else's claim could always have sent the holder's id — it is printed in the refusal. Likewise the claim is a comment on a
repository anyone with write access can edit by hand. This matters for the fix: the objection in the item's Notes — that a fourth clause weakens a rule that
exists to stop exactly that — overstates what the rule can do. It stops an accidental release, not a determined one. The question a fourth clause has to answer
is therefore not "can this be forged" but "is the caller in a position to KNOW", and that is a question about which machine it is running on.

## Fix

A fourth clause in the release rule, narrowly stated, plus the human sibling of the orchestrator's teardown verb:

> **the holder always, the RUN that owns the claim, the HOST that holds the claim once it can show the session is gone, ANYONE once the claim is dead.**

**Prerequisite: [bug-46](bug-46-a-claim-names-a-session-id-and-no-host-so-another-machines-live-claim-reads-as-litter.md) lands first.** The new clause is
`ClaimRecord.host`; without that field there is nothing to compare and this item is not executable. bug-46 is marked `runner-fix: true` and so is hoisted to the
front of any run's queue, which makes the ordering the default rather than a thing anybody has to arrange. If it has not landed, **refuse this item rather than
adding a host field here** — one field specified in two places is how the two specifications drift.

1. **`ItemReleaseRequest.host?: string`** — the assertion, the exact shape `runId` already has and validated the same way: a 400 on a present non-string, and
   `typeof`/`length` guards at the comparison so a request with no `host` against a claim with no `host` never compares `undefined === undefined` into a match.
   **A claim with no `host` is never same-host with anything** — the same sentence `run` already carries, for the same reason and worth writing out beside it.

2. **`GithubSource.release`** — the live-claim guard gains the clause:
   `if (isLive(existing, now) && existing.session !== req.session && !sameRun && !sameHost)`, with
   `const sameHost = typeof req.host === 'string' && req.host.length > 0 && existing.host === req.host`. Nothing else in `release` moves: the release is still
   permanent, still carries `reason` and `by`, still leaves the assignee alone and still ignores the label removal's status.

3. **`backlog.mjs abort <id>`** — a new verb, named for `orchestrate.mjs abort` and releasing with the same `reason: 'aborted'` that bug-40 settled on, because
   it is the same event: a session torn down without passing through a terminal stage. It reads the claim (`GET /api/items/claim`, which already gives the
   `commentId` `stop` uses), runs the refusal checks below, and POSTs `release` with `host: hostIdentity()` and **no `counters` key at all** — `--abandon`'s
   rule, and for `--abandon`'s reason: the stretch between the last heartbeat and now is not work anybody did, and zeros would erase what earlier sessions
   accumulated.

4. **`abort` refuses unless all three hold**, each with its own message naming what failed:
   - **The claim's `host` is non-empty and equals this machine's `hostIdentity()`.** Cross-machine is refused and the message says the honest thing: wait out
     the window, or run `abort` on that machine. There is deliberately no remote path — see the rejected alternatives below.
   - **The claim is unreleased and live.** A released claim has nothing to abort; a dead one needs no `abort` at all, since the next `start` retires it — say
     so and exit `0`-adjacent rather than performing a release nobody needed.
   - **Nothing shows the holding session still running here.** The evidence is a transcript for `claim.session` under `<configDir>/projects/` — the directory
     `transcriptFiles` already reads — whose mtime is at or after the claim's `heartbeat` stamp. Present means a session on this host wrote to its transcript no
     earlier than the beat, i.e. it is the one beating: refuse, naming the file and its mtime. Absent, or older than the beat, means the session that wrote that
     heartbeat is not writing here any more.

   **The asymmetry with bug-46 is the whole point and must be stated in the code comment**: the absence of a local transcript is meaningless on a machine that
   did not mint the session — that is bug-46's false negative — and becomes meaningful here only because the first check has already established that this
   machine is the one the claim was made on. A session with no `CLAUDE_CODE_SESSION_ID` has no transcript at all and so passes this check trivially; that is
   correct, because such a claim is `<user>@<host>` — a person at a terminal on this host — and the person at that terminal is who is running `abort`.

5. **The proof is the CLI's, not the server's**, and the Fix says so rather than leaving it implied. The server cannot see the caller's filesystem or process
   table, so its clause is `sameHost` alone; the liveness check lives where the evidence is, exactly as billing lives on the CLI side because that is where the
   clock and the transcript are. A caller could send `host` without doing the check — and a caller could always have sent the holder's `session`. This is the
   mistake boundary the Cause describes, not a hole the fix opens.

6. **The docs move with it.** CLAIM.md's claim-protocol bullet says "Who may release is a triple" in as many words, and
   `docs/subsystems/invariants.md#the-claim-protocol-lowest-live-comment-id-wins` carries the reasoning. Both become a quadruple, with the new clause's
   condition — the host assertion plus the CLI-side proof — written down, or the next reader takes the triple as current.

7. **One line of skill prose each.** `backlog-groom`'s "Already in progress" section and `backlog-execute`'s lost-race subsection both split a claim into stale
   and live; they gain the third reading — **live, but held by a session on THIS machine that is gone** — naming `abort`. `backlog-execute`'s subsection is
   written by [bug-47](bug-47-a-refusal-that-prints-heartbeat-age-reads-as-a-countdown-and-execute-has-no-stop-clause.md), so if that has landed this composes
   onto it; if it has not, add the line to today's text and bug-47 will find it there.

Rejected, each for its own reason:

- **A `--force` flag, or a clause that lets any caller name the holder.** It is the fourth clause with no proof attached, assertable from a machine that cannot
  possibly know — which is the shape bug-46 exists to stop being persuasive.
- **Host equality with no liveness check.** Cheaper, and it would let a second session on the same laptop take an item out from under the person holding it at
  a terminal. The check is what makes `abort` a repair rather than a seizure.
- **Shortening `CLAIM_STALE_MS` for hand claims.** Backwards: the constant's own comment says the alias exists so a hand claim can be given a LONGER window,
  because nothing heartbeats a hand groom automatically.
- **A remote path for a machine that is switched off.** The honest answer is the fifteen minutes. A machine that cannot answer cannot prove anything, and the
  window is the protocol's own repair for exactly that case.

Test cases:

- `test/tracker-write.test.ts` — a `release` carrying a `host` matching a live claim's, from a session that is not the holder and with no `runId`, releases; a
  mismatched `host` is a 409 with the `holder` payload; a claim with **no** `host` plus any request `host` is a 409 (never same-host); a present non-string or
  empty `host` is a 400 naming the field.
- `test/tracker-write.test.ts` — the released record still carries `reason: 'aborted'`, `by` the aborting session, and the claim's ORIGINAL counters when the
  request sent no `counters` key.
- `skills/backlog/tools/backlog.test.mjs` — `abort` refuses a claim whose host is another machine's, naming both hosts; refuses when a transcript for the
  holding session has an mtime at or after the claim's heartbeat, naming the file; refuses a released claim; on a dead claim says the next `start` retires it
  and makes no request; on the repair case POSTs `release` with `host` set, `reason: 'aborted'` and **no `counters` key present in the body** (assert the key's
  absence, not that it is zero).
- `skills/backlog/tools/backlog.test.mjs` — `abort` in a files project is a usage refusal: there is no claim to release, and the files store's equivalent is
  `stop <id> --abandon`, which already exists.

No browser check: nothing here is rendered.

## Notes

The shape of the fix is the open question and grooming's to settle. A fourth clause in the triple ("anyone, when the caller names the holder explicitly") weakens
a rule that exists to stop exactly that; a `--force` flag is the same thing spelled differently. The alternative is that this is not a claim problem at all but a
liveness one — the claim is only unreleasable because nothing on the tracker can tell a reader that the holding machine is gone, which is
[bug-46](bug-46-a-claim-names-a-session-id-and-no-host-so-another-machines-live-claim-reads-as-litter.md)'s missing host by another route. Groom the two together.
