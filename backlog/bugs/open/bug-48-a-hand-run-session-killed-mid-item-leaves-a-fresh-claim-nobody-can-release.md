---
id: bug-48
title: a hand-run session killed mid-item leaves a fresh claim nobody can release, and there is no human equivalent of the orchestrator's abort
created: 2026-09-21
tags: tracker, claim, cli
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

## Notes

The shape of the fix is the open question and grooming's to settle. A fourth clause in the triple ("anyone, when the caller names the holder explicitly") weakens
a rule that exists to stop exactly that; a `--force` flag is the same thing spelled differently. The alternative is that this is not a claim problem at all but a
liveness one — the claim is only unreleasable because nothing on the tracker can tell a reader that the holding machine is gone, which is
[bug-46](bug-46-a-claim-names-a-session-id-and-no-host-so-another-machines-live-claim-reads-as-litter.md)'s missing host by another route. Groom the two together.
