---
id: bug-47
title: a refusal that prints heartbeat age reads as a countdown, and backlog-execute has no stop clause for a live foreign claim
created: 2026-09-21
tags: tracker, claim, skills, backlog-execute
---

## Symptom

A hand-run `backlog-execute` session that loses the claim race does not stop. It treats the refusal as a temporary condition, computes when the claim expires,
queues itself to re-claim at that moment, and fills the wait with real work that costs real tokens. On https://github.com/futin/guide-manager/issues/5:

```
20:06:35  #5 is already in progress (session f51e844e-…, heartbeat 12s ago) — this session is baa7212d-…
          EXIT=1
20:09:03  sed -n '680,720p' backlog.mjs ; grep -n "STALE|staleMs|15 \* 60|900000|retire"
20:09:10  "the protocol retires it at 20:21:22Z — no stealing needed … Doing read-only prep until then."
20:10:37  pnpm test test/progress.test.ts                      45 s
20:11:58  pnpm test  (full)                                    42 suites / 568 tests / 73 s
20:11:39  until [ "$(date -u +%s)" -ge <20:21:25Z> ]; do sleep 10; done; node "$BL" start 5 --as execute
20:13:52  drafted /tmp/provoke-progress-401.mjs                126 lines
20:15:10  drafted /tmp/patch-progress-test.py
20:15:34  drafted /tmp/provoke-script.test.ts
```

Nothing was written into the repo and the tree stayed clean, so the claim protocol held. What did not hold is the session's judgement about what a refusal means.

## Repro

1. Machine A claims an item and holds it.
2. On machine B, trigger `backlog-execute` on the same item with an ordinary completion-shaped prompt — "work it through to verification, then archive the item".
3. B's `start` exits 1. B does not report and stop; it schedules a retry for the staleness deadline and works in the meantime.

## Evidence

Three things combine, and each is independently reasonable:

**The refusal states the age.** `#5 is already in progress (session <id>, heartbeat 12s ago)` tells a reader exactly how much of the fifteen-minute window is
left. Paired with `CLAIM_STALE_MS`, which is a constant in a file the session can read, the refusal is a countdown with the finish time computable to the second.

**The prompt was a completion directive and the session was not in a run.** No `[orchestrator-run` marker, so `backlog-execute`'s four never-escalate rules were
off, and the user's own words were "work it through to verification, then archive the item". A temporary block plus an instruction to finish resolves to "wait".

**`backlog-execute` says nothing about this case.** The skill has a gate for an ungroomed item and a refusal for the wrong section. It has no sentence covering
"`start` refused because another session holds this item" — no instruction to report and stop, and no statement that waiting out a claim is not a thing a
session may decide to do on its own.

## Affects

- `skills/backlog-execute/SKILL.md` — the missing clause. `skills/backlog-groom/SKILL.md` likely needs the sibling sentence.
- `skills/backlog/tools/backlog.mjs` — `start`'s refusal text, if the age is to stop being printed.

## Notes

Whether the age should go is a real question for grooming, not a foregone one. It is genuinely useful to a person deciding whether to wait thirty seconds or
walk away, and removing it does not stop a determined session recomputing the deadline from `show --json`'s `heartbeat`. The likelier fix is the skill clause:
losing the claim ends the session's work on that item, and the next attempt is a person's decision, not the session's. Related:
[bug-46](bug-46-a-claim-names-a-session-id-and-no-host-so-another-machines-live-claim-reads-as-litter.md) — B only felt entitled to wait because it had
concluded the holder was dead.
