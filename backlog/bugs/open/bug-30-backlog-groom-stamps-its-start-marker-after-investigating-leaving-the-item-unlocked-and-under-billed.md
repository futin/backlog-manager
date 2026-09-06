---
id: bug-30
title: backlog-groom stamps its start marker after investigating, leaving the item unlocked and under-billed
created: 2026-09-06
tags: skills, backlog-groom
updated: 2026-09-06T20:47:08Z
groom-elapsed: 313
groom-tokens: 30988
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

The wording drops the verdict a second time, earlier. "Pick an item" opens with *If the
trigger already named one ("plan idea 3", "reject task 5"), use that id directly* — and
`reject task 5` plainly names a verdict as well as an id, yet the only thing that sentence
extracts from it is the id. So the one place in the document that looks directly at a
directed prompt already establishes the habit of reading the id out of it and discarding
the rest, two sections before the confirmation gate the discarded half would have
satisfied.

`backlog-execute` has the same marker, the same four counters and the same `start`/`stop`
writer, and does not have this defect — the contrast is what names the cause precisely.
Its pre-`start` window is a *refusal gate*: `show <id>`, read the file, check that
`## Plan` or `## Fix` is more than a placeholder, then `start --as execute`, and only then
Dispatch, where `superpowers:systematic-debugging` and `superpowers:test-driven-development`
do everything expensive. That gate is bounded by construction — it inspects one heading for
emptiness, never the code — and it has to precede the stamp, because an item about to be
refused should not be marked in progress. Groom's pre-`start` window is a *consent* gate
instead, and consent is the one gate a prompt can satisfy before the session starts. When
it has been, the gate is not bounded work that must happen first; it is no work at all, and
the sequence the prose implies has nothing left to hold the stamp back for.

## Fix

Reword "Mark it in progress" in place. Keep `start <id> --as groom` exactly where it sits
in the document and keep the confirmation rule as written — the ordering is correct for an
interactive groom, and moving the command earlier would trade this defect for the
stamp-before-consent one the current order exists to prevent. What is missing is prose, so
prose is what changes. Three edits to `skills/backlog-groom/SKILL.md`, all inside
`### Mark it in progress` (lines 76-90 as of `c69ba41`):

1. **Name the directed case as its own branch**, immediately after the existing "Only once
   both are confirmed" sentence: if the invoking prompt already named the item *and* the
   verdict — "groom bug-23, fill in Cause and Fix, leave it in `bugs/open/`" names both —
   that *is* the confirmation, and `start` runs now, as the next command, before any
   investigation. State it as a branch a reader lands in, not as a caveat: the directed
   groom is the common case, and it currently has no sentence of its own anywhere in the
   document.
2. **Argue both directions in the "Not any earlier" paragraph.** It keeps its existing
   half — stamping ahead of confirmation tells the board a session is running when the
   conversation might still end in "let's not" — and gains the symmetric one: stamping late
   leaves the item unlocked for a second groom or a `backlog-execute` to claim, and bills
   `groom-elapsed:`/`groom-tokens:` for the cheapest minute of the session, permanently,
   because nothing ever resets them. A paragraph that argues one direction reads as the
   only direction there is a cost in.
3. **Add the invariant**, as the paragraph's last line: nothing sits between `show` and
   `start` but the verdict decision itself. That is the sentence a session can apply to a
   case nobody enumerated — including the sharp one this bug is about, where the verdict is
   `## Cause`/`## Fix` and the investigation that *is* the work would otherwise slot itself
   into that gap.

Two things deliberately not done. **The tool is not touched**: `start` cannot know how long
a session ran before it was called, and a `stop` that printed billed-versus-real elapsed
would report the damage without preventing the unlocked window, at the cost of new output
on a command four skills call. **`backlog-execute` is not touched either** — the contrast
in `## Cause` is diagnostic, not a second site to repair; its bounded refusal gate already
puts every expensive step after the stamp. The one thing worth carrying across is the
invariant's phrasing, which describes what execute already does.

## Test cases

- `skills/*/tools/*.test.mjs` are node-runner tests over the tools, and this change is
  SKILL.md prose, so the pinning is a text assertion over
  `skills/backlog-groom/SKILL.md`: the `### Mark it in progress` section contains a
  sentence naming the directed-prompt case, the word "unlocked" (the too-late cost), and
  the literal invariant about `show` and `start`. A prose fix with no assertion is a fix
  the next edit silently reverts.
- The existing "Only once both are confirmed" sentence and the `start <id> --as groom`
  command are both still present and still in that order — the fix is additive, and a
  test that only checks the new text would pass a rewrite that dropped the consent rule.
- Live, once, against a synced plugin: a directed groom on a fresh item leaves `started:`
  on disk before the first investigation command. Read `backlog.mjs show <id>` from a
  second shell while that groom is still investigating — the `started:` line is present,
  and a second `start <id> --as groom` refuses with "already in progress". This is the
  only check that proves the prose changed a session's behaviour rather than just the
  file, which is what this bug is about.
- That same item's `groom-elapsed:` after `stop` is within a few seconds of the session's
  real wall time, not a fraction of it. Contrast bug-23's `groom-elapsed: 57`.

## Done when

```
pnpm run test:skills
```

```
pnpm test
```

- The live directed-groom check above has been run against a plugin synced from the
  pushed HEAD, not the working tree — editing `skills/` changes nothing in an installed
  plugin, so a check run before `pnpm run plugin:sync` proves nothing.
