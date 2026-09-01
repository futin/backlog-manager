---
id: task-6
title: Archive view: four columns, month groups, and the two promotion paths
created: 2026-08-30
tags: client, board, archive
updated: 2026-09-01T16:18:50Z
started: 2026-09-01T15:58:59Z
execute-elapsed: 1191
---

## Goal

Archive becomes a real surface: Refactoring · Ideas · Bugs · Out of scope,
grouped by month, with both ways back to the Board. Chunk D of
docs/superpowers/specs/2026-08-30-board-growth-design.md. Depends on task-3
for the nav slot and task-5 for the staleness rule.

Archive is a parking lot, not a graveyard — nothing in it is finished, and
everything in it can come back.

## Plan

Contents: stale open Refactoring, Ideas and Bugs (task-5's predicate, read
from the other side), plus every out-of-scope item regardless of age. No
Tasks column — tasks never archive. No done items anywhere; there is no
action to take on them.

Archive carries no status filter: its contents are defined by staleness and
rejection, not by status. Project filter and search only.

Within each column, items group under sticky month subheaders keyed on
`updated ?? created`, newest month first. This is the one place month
grouping earns itself — a column of six-week-old items with no temporal
structure is a list, not a view.

Two promotion paths, deliberately different:

- **A stale item** promotes by dispatching a groom session. Groom's own
  `start`/`stop` refreshes `updated:` and the item is back on the Board at
  the next load. Nothing new is needed: `deriveAction` already returns groom
  for these, and the board still never writes — the spawned agent does.
- **An out-of-scope item** promotes by capturing a **new** item that cites it
  (`from: oos-N`). The original stays rejected; `moveItem` refuses every move
  out of out-of-scope, deliberately, and this does not lift that.

**The risky part, to settle before building:** dispatch derives its action and
never accepts one, and `deriveAction` currently has no answer for an
out-of-scope item. Reviving therefore needs either a third derived action or a
separate path that is not dispatch at all. Whichever is chosen, `deriveAction`
must stay the single implementation shared by the board's label and the
server's validation — two copies is the failure this rule exists to prevent.

**Settled, 2026-09-01, by the user during the orchestrator run that built
this: the third derived action.** `AgentAction` gains `'capture'`, and
`deriveAction` returns it for an out-of-scope item and for nothing else — a
`done/` item still derives `null`, because history genuinely has no next step
while a rejection does. Dispatch keeps its existing shape end to end: the
board labels the control off the same `deriveAction`, the server re-scans the
file, re-derives, and 409s on disagreement exactly as it does for groom and
execute, and `composePrompt` grows a capture arm that spawns
`/backlog-capture` citing `from: oos-N`. The original stays rejected;
`moveItem` still refuses every move out of `out-of-scope/`, and this does not
lift that.

The cost, accepted knowingly: `deriveAction`'s opening
`if (item.status !== 'open') return null` no longer covers both archives in
one line, so the comment above it that says so is now wrong and must be
rewritten rather than left standing — the comment is the thing that explains
why `done` and out-of-scope used to share a branch, and it has to explain why
they no longer do.

## Test cases

- An out-of-scope item renders in Archive and nowhere else.
- A done item renders in neither Archive column nor the Board's default view.
- A stale task appears on the Board, not in Archive.
- A fresh bug appears on the Board, not in Archive.
- Archive renders no status select.
- Month subheaders appear newest-first and an item with neither date sorts
  predictably rather than into a NaN group.
- A stale card's dispatch control offers groom.
- Whatever revive turns out to be, the server still derives the action and
  409s on disagreement with the client.

## Done when

`pnpm test` is green, and a rejected item can be revived and a stale item
groomed back onto the Board without the client ever writing a file.

## Outcome

2026-09-01 — built. Archive is a real surface, and the settled decision (the
third derived action) landed exactly as written.

**What changed.** `AgentAction` gained `capture`, and `deriveAction`
(`shared/agent.ts`) now checks the section BEFORE the `status !== 'open'` line
that would otherwise swallow a `terminal` item — a `done/` item still derives
`null`, a rejection derives `capture`. The comment that claimed one line
covered both archives was rewritten rather than left standing, as the item
required. `actionLabel` became a `Record<AgentAction, string>` so the compiler
refuses a fourth action nobody labelled; the ternary it replaced answered
`groom` for everything that was not `execute`, which would have shipped a
capture control reading as a groom control. `AGENT_ACTIONS`/`isAgentAction`
are new, and the controller's hand-written `!== 'groom' && !== 'execute'`
chain now goes through the guard. `AgentPlan.action` and
`AgentDispatchRequest.action` stopped restating the union and import
`AgentAction` type-only (erased before any runtime, so no cycle).
`composePrompt` grew a capture arm keyed on the action beside `execute`, not on
the section: a NEW item, citing `from: <id>`, original left where it is. It
names the skill in natural language — the item's note wrote it as
`/backlog-capture`, and prompt.util's no-slash-command rule wins over the
spelling. `agents.service.ts` needed no change at all, which was the point of
the decision: the new action rode the existing derive-re-derive-409 rails.

Client: `ArchiveView.tsx` replaced its placeholder with four columns
(Refactoring · Ideas · Bugs · Out of scope), filtered by the ONE predicate
`item.section === 'out-of-scope' || leavesBoard(...)` — `leavesBoard` reused,
never re-decided, which is what makes the two surfaces exactly complementary.
New `lib/item-month.ts` owns the grouping (newest month first, `undated` last
though `''` sorts first as a string, newest-touched first within a group with
an id tie-break). New `lib/view-keys.ts` holds the project-filter key both
surfaces read: exported from BoardView it would have pulled the Board's whole
module into Archive's chunk, and the build confirms it did not
(`ArchiveView-*.js` 3.99 kB, separate from `BoardView-*.js` 18.56 kB). Archive
takes `runClaimBlock` but renders no run strip, passes no `stale` prop (every
card in its stale columns is stale, so a marker on all of them says nothing),
and has a third empty state — `nothing archived yet` — that the Board has no
equivalent of.

**One thing the plan got wrong, found by a failing test.** The "an item with
neither date sorts predictably" case cannot happen in the three stale columns
at all: `isStale` reads an absent or unparseable stamp pair as FRESH, so such
an item never leaves the Board. It is reachable only through Out of scope,
which enters on the rejection and not on a date, and the test was moved there.

`pnpm run typecheck` and `pnpm run build` are clean; the CSS gained
`.archive-month`, `.archive-group` and the `capture` tone in both dispatch
shapes.

```
$ pnpm test
PASS test/item-stale.test.ts
PASS test/item-month.test.ts

Test Suites: 41 passed, 41 total
Tests:       635 passed, 635 total
Snapshots:   0 total
Time:        31.86 s, estimated 44 s
Ran all test suites.

$ pnpm run test:skills
1..264
# tests 264
# suites 0
# pass 264
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 46027.0245

$ pnpm run typecheck
$ tsc --noEmit
```

### Fix round 1 — the revive citation was banned by the skill it dispatches

Review found the capture prompt asking for a `from: <id>` line that
`backlog-capture`'s own SKILL.md forbade. Not a near-miss: `--from <id>` is
precisely what writes that frontmatter key (`backlog.mjs`'s `new`, `data.from`),
so the banned flag and the required citation were the same act, and the ban's
rationale — "capture doesn't do it, even when the new item was clearly inspired
by an existing one" — covered the substance rather than the spelling. A headless
session would very plausibly have filed the revived item with no link back to
the rejection, which is the one thing the settled decision requires.

Fixed on both sides. `skills/backlog-capture/SKILL.md` keeps the ban and carves
one explicit exception for reviving an `oos-N`, with the two reasons it is
capture's job and nobody else's: `move` refuses every move out of
`out-of-scope/`, so nothing comes back by being moved, and `backlog-groom`
refuses an item already there outright, so no other skill can file the reviving
item at all. `composePrompt` now names BOTH routes to the citation — the
`--from` flag and the hand-written frontmatter line — and that redundancy is
load-bearing rather than tidy: `skills/` is a publishing boundary, so until this
branch is committed, pushed and `pnpm run plugin:sync` has run, every session
the prompt reaches is still running the skill version that bans the flag. The
hand-written line is a route that old version already models for `tags:` and
`kind:` and never bans. A new test pins both routes so the second is not
"simplified" away once the skill catches up.

```
$ pnpm test
Test Suites: 41 passed, 41 total
Tests:       636 passed, 636 total

$ pnpm run typecheck
$ tsc --noEmit

$ pnpm run test:skills
# tests 264
# pass 264
# fail 0
```
