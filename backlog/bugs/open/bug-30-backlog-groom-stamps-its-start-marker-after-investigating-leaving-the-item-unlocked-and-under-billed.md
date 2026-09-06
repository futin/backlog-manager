---
id: bug-30
title: backlog-groom stamps its start marker after investigating, leaving the item unlocked and under-billed
created: 2026-09-06
tags: skills, backlog-groom
---

## Symptom

`backlog-groom`'s SKILL.md places `start <id> --as groom` behind "Only once both are
confirmed — the item and the verdict". When the invoking prompt *already* names both — the
ordinary case for a directed groom ("groom bug-23, fill in Cause and Fix, leave it in
`bugs/open/`") — that gate is satisfied on turn one, but the surrounding prose reads as
"after you have worked out what the verdict should be", so a session investigates first and
stamps the marker minutes later.

Two costs, and neither is cosmetic:

1. **The item is unlocked for the whole window.** `start`'s "already in progress" refusal
   is the only mutex on an item — nothing else stops a second groom or a `backlog-execute`
   from claiming it. An unmarked item shows nobody on it on the board, so a user launching
   grooming sessions in parallel gets silent double-work.
2. **`groom-elapsed:` and `groom-tokens:` under-report, permanently.** Both bill from
   `started:`, so every minute of investigation before the stamp is invisible. The four
   counters are documented as "permanent, accumulating" and are never reset, and
   `start`/`stop` are their single writer, so there is no supported repair after the fact.

## Repro

1. In a fresh session, invoke `/backlog-groom` with a prompt that names the item *and* the
   verdict: "groom bug-N, fill in ## Cause and ## Fix, leave it in bugs/open/".
2. Follow SKILL.md as written.
3. Observe the order of operations: `show <id>`, then investigation (codegraph, greps,
   reading the affected components, running a repro test), then `start <id> --as groom`.
4. While step 3 is running, `backlog.mjs show <id>` on the same item — no `started:` line,
   and a second `start <id> --as groom` from another session succeeds.
5. After `stop`, read the item's `groom-elapsed:` against the session's real wall time.

Observed on 2026-09-06 grooming bug-23 in this repo: 11 tool calls (including a scratch
jsdom repro and a full jest run) between `show` and `start`; `started: 20:26:25Z`,
`stop` at `20:27:22Z`, and the file now carries `groom-elapsed: 57` / `groom-tokens: 9497`
for a groom that took several times that. Those numbers are on bug-23 for good.

## Affects

- `skills/backlog-groom/SKILL.md` — the "Mark it in progress" section, and specifically its
  "Not any earlier:" paragraph, which argues only the one direction (don't stamp before the
  user has agreed) and never addresses the case where the agreement arrived in the opening
  prompt
- `skills/backlog/tools/backlog.mjs` — `start`/`stop`, the single writer of `started:`,
  `groom-elapsed:` and `groom-tokens:`, and therefore the reason a late stamp cannot be
  repaired afterwards
- `backlog/bugs/open/bug-23-one-escape-press-closes-the-launch-sheet-and-the-item-drawer-behind-it.md`
  — carries the under-counted totals from the occurrence above

## Cause

The rule and its rationale are about *consent*, but the wording is about *sequence*. "Only
once both are confirmed — the item and the verdict" is correct and should stay; what is
missing is that a directed prompt confirms both up front, so the reader has no signal that
the very next command is `start`. The paragraph immediately below it reinforces the wrong
reading by defending one direction only — stamping too early would "tell the board a
session is running when the conversation might still end in 'let's not'" — with nothing
said about the cost of stamping too late, which is the failure that actually happens on
every directed groom.

The `## Cause`/`## Fix` verdict makes this worse than it is for Promote or Reject.
Investigation *is* the work for that verdict, so the natural reading — investigate, then
you know the verdict, then stamp — inverts the whole marked window: the marker goes on just
before the file write and comes off a minute later, billing the cheapest part of the
session and leaving the expensive part unlocked and unrecorded.

Nothing in the tool detects this. `start` cannot know how long a session has been running
before it was called, and `stop` bills the interval it is given, so both behave exactly as
specified.

## Fix

unknown — the shape is to make "the prompt already gave the verdict" an explicit, named
branch that stamps immediately, rather than something a reader has to infer. Options worth
weighing before picking:

- **Reword "Mark it in progress" in place**: keep the confirmation rule, add the directed
  case as its own sentence ("if the invoking prompt already named the item and the verdict,
  that is the confirmation — run `start` now, before any investigation"), and extend the
  "Not any earlier" paragraph to state the opposite cost too. Smallest change; relies
  entirely on prose that a session re-reads once.
- **Move the step**: put `start` directly after the `show` in the shared preamble, with the
  confirmation gate expressed as "if you still need a verdict from the user, ask before
  stamping". Reorders the document rather than annotating it, so the default path is
  correct and the interactive path is the exception — but it inverts the existing structure
  and needs care not to reintroduce the stamp-before-consent failure the current order
  exists to prevent.
- **Make the tool observable instead**: have `stop` print the billed interval next to the
  session's own elapsed time when the two diverge sharply, so a late stamp is at least
  visible once. Does not prevent the unlocked window, and adds output to a command four
  skills call.

Whichever is chosen, the acceptance evidence is the same and is what this bug exists for: a
directed groom run against a fresh item leaves `started:` on disk before the first
investigation command, and the resulting `groom-elapsed:` is within a few seconds of the
session's real duration rather than a fraction of it. Note that any change here is inert
until committed, pushed and `pnpm run plugin:sync`'d — editing `skills/` changes nothing in
an installed plugin.
