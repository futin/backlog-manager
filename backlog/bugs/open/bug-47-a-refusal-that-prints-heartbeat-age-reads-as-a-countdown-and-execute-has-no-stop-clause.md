---
id: bug-47
title: a refusal that prints heartbeat age reads as a countdown, and backlog-execute has no stop clause for a live foreign claim
created: 2026-09-21
tags: tracker, claim, skills, backlog-execute
updated: 2026-09-21T20:30:26Z
groom-elapsed: 268
groom-tokens: 53957
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

## Cause

The item names three contributing facts and they all hold. Grooming's addition is which of them is the defect, and it is the third — but not for the reason
stated.

**The clause is not missing; it is the wrong shape.** `skills/backlog-execute/SKILL.md:148` already says it:

> Exit `1` here means the item can't be started, and the message says which: already in progress (someone is on it — say so and stop rather than working it
> twice), already done, or out of scope. Don't work around it.

That is the rule, and the session read past it anyway. Three things about its form explain how. It is a **parenthetical inside a run-on sentence** listing three
unrelated exit-`1` causes, so it carries no more weight than "already done". Its stated reason is **duplicated work** — which a session that has concluded the
holder is dead does not believe applies to it, so the rule reads as inapplicable rather than as violated. And it says nothing about **waiting**: "say so and
stop" is advice about what to report, and a session that reports the block and then schedules a retry has, on a literal reading, done exactly that. There is no
sentence anywhere in the skill that a scheduled re-claim contradicts.

**The enabling belief came from bug-46.** B did not decide to override a live holder; it decided there was no holder, from a local-transcript check that cannot
answer that question for a foreign claim. A clause whose only stated harm is working twice does not bind a session that believes nobody else is working — which
is why these two are groomed together and why the prose fix alone would have left the hole half-closed.

**The age in the refusal is a contributor, not the defect.** `#5 is already in progress (session …, heartbeat 12s ago)` plus `CLAIM_STALE_MS` in a readable file
does make the deadline computable to the second. But it is genuinely useful to a person deciding whether to wait thirty seconds or walk away, and removing it
does not stop a determined session recomputing the same deadline from `show --json`'s `heartbeat`. What makes it dangerous is that it is the *only* sentence a
losing session reliably reads, and it currently carries a deadline and no rule.

## Fix

Three edits. The first is load-bearing; the third is the one that reaches a session whose skill prose was never loaded.

1. **`skills/backlog-execute/SKILL.md`, "Mark it in progress"** — lift the parenthetical out into its own subsection for the lost race, and split the other two
   exit-`1` causes (done, out of scope) into their own sentence so the three stop sharing one. The subsection states, in these terms:
   - Losing the race **ends this session's work on this item**. Report the holder and stop.
   - Do **not** schedule a retry, do not wait out the staleness window, and do not do read-only work "while waiting" — in the run that produced this bug the
     wait was two full test-suite runs and three drafted files, all discarded. The next attempt is a person's decision, not the session's.
   - Say why the obvious reasoning fails: **a session id you cannot find on this machine is not evidence the holder is dead.** It is the expected reading of a
     claim held on another machine (bug-46), and the only liveness evidence that exists is the heartbeat age the refusal already printed.
   - State that this holds under a completion-shaped prompt too. "Work it through to verification" is an instruction about the item, and a lost claim means the
     item is not this session's to work.

2. **The same subsection reads the tracker refusal explicitly**, since a tracker is where two machines meet:
   `#5 is already in progress (session <s> on <host>, heartbeat 12s ago) — this session is <mine>`. Fresh heartbeat means somebody is working it right now:
   stop. Stale past fifteen minutes means the protocol retires it on your next `start`, so re-run `start` alone — **do not `stop --abandon` first**. That is the
   same two-case reading `backlog-groom`'s "Already in progress" section already prints, deliberately worded to match, so the two skills say one thing about one
   refusal.

3. **`skills/backlog/tools/backlog.mjs`** — `start`'s tracker refusal ends with the rule itself:
   `… — losing the race ends this session's work on this item`. One string, read by every losing session regardless of which skill (or none) is driving it. The
   age stays.

Deliberately unchanged, each for its own reason:

- **`skills/backlog-groom/SKILL.md` needs no sibling sentence.** The item guessed it would; it does not. Groom's "Already in progress" section already stops on
  a live holder, already distinguishes stale from live, and already makes the live case the user's call.
- **`orchestrate.mjs` is already correct.** `trackerClaim`'s lost race returns `claimed elsewhere` and the item is skipped at exit `0`; a run never waits. This
  bug is a hand-run session's, and the fix should not imply otherwise.
- **`CLAIM_STALE_MS` stays a readable constant.** Hiding it would stop nothing and it is load-bearing elsewhere.

Ordering note: edit 3 touches the same refusal string bug-46's fix rewrites. bug-46 is marked `runner-fix: true` and is hoisted to the front of a run's queue,
so
it normally lands first and this edit composes onto its version of the line; if it has not landed, edit 3 stands alone against today's line.

Test cases:

- `skills/backlog/tools/backlog.test.mjs` — `start`'s tracker refusal ends with the rule clause and still carries the heartbeat age.
- `skills/backlog/tools/backlog.test.mjs` — a skill-prose case reading `skills/backlog-execute/SKILL.md` (that suite is where prose cases already live, beside
  `backlog-groom`'s stamp order and `backlog-execute`'s pre-review checks): the lost-race subsection exists as its own heading, forbids waiting and a scheduled
  retry in as many words, and is not a parenthetical inside the exit-`1` list. It reads the file's text; it never imports it.

No browser check: nothing here is rendered.

## Notes

Whether the age should go is a real question for grooming, not a foregone one. It is genuinely useful to a person deciding whether to wait thirty seconds or
walk away, and removing it does not stop a determined session recomputing the deadline from `show --json`'s `heartbeat`. The likelier fix is the skill clause:
losing the claim ends the session's work on that item, and the next attempt is a person's decision, not the session's. Related:
[bug-46](bug-46-a-claim-names-a-session-id-and-no-host-so-another-machines-live-claim-reads-as-litter.md) — B only felt entitled to wait because it had
concluded the holder was dead.
