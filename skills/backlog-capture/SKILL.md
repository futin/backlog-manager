---
name: backlog-capture
description: >
  File a new item into the backlog — a bug, an idea, a task, a refactor, or something
  already decided against — as its own file under backlog/, creating the store itself if
  this repo doesn't have one yet. Use to log a bug, note this idea, flag code that should
  be cleaned up, add to the backlog, capture that, or remember this for later. Never moves
  or reclassifies an existing item — filing only, nothing else. Trigger: /backlog-capture
trigger: /backlog-capture
---

# /backlog-capture — file one new item

Every capture creates exactly one new file under `backlog/` and prints its id and path
back. It never moves, converts, or reclassifies anything that already exists — that's
`backlog-groom`'s job, not this skill's. To see what's already open instead, that's
`/backlog`.

## Classify first

| Input shape | Section |
|---|---|
| something in shipped code behaves wrong | `bugs` |
| future work whose shape is not settled | `ideas` |
| future work whose plan is already known — e.g. just designed in this session | `tasks` |
| existing code that works but should be improved | `refactors` |
| something already analysed and decided against | `out-of-scope` |

Anything genuinely ambiguous between rows is **asked**, not guessed.

The `ideas` / `refactors` line is the one worth stating outright, because it's the pair
that gets confused: **ideas are new** — a feature, a capability, an optimisation that
doesn't exist yet. **Refactors are existing things that should be improved** — the code
already does its job, so it isn't an idea, and it isn't misbehaving, so it isn't a bug
either. "Add caching to the item scan" is an idea; "the item scan has grown three
responsibilities and should be split" is a refactor. If it's genuinely both, ask.

## Two refusals that keep the sections honest

- **A `tasks` capture must contain a real `## Plan`.** If the plan isn't actually known
  yet, this is an **idea**, not a task — file it under `ideas` instead, and tell the user
  you downgraded it and why. `tasks/` means "the plan is known"; a task with no plan
  silently turns `tasks/` into a second `ideas/`.
- **An `out-of-scope` capture must carry a rejection reason.** If none was given, ask for
  one before filing anything. A rejection with no reason is a decision nobody can review
  later — don't create the file until you have one.

Capture only ever creates. It never moves, converts, or reclassifies an existing item —
that is groom's job.

## Procedure

1. Make sure the store exists — every time, unconditionally:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" init
   ```

   This is the one skill of the four allowed to create `backlog/`. Run it every time, not
   only when you think this is the "first" capture: `init` is idempotent — on an existing
   store it just prints `already initialized: <path>` and changes nothing. There's no
   missing-store signal to wait for instead: `new` (below) cannot tell you the store is
   missing — it only computes a hypothetical next id from the git root, so it still exits
   `0` with a clean result even when `backlog/` doesn't exist at all. Don't relay `init`'s
   own output to the user; it's setup, not the capture.

2. Pick the section from the table above (asking first if it's ambiguous), then:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" new <section> "<title>"
   ```

   Never pass `--from <id>` here, with the single exception below. That flag writes a
   `from: <id>` line into the new item's frontmatter, which is how a promotion records
   what it came from, and promotion is `backlog-groom`'s job — capture doesn't do it just
   because the new item was clearly inspired by an existing one. "This reminded me of
   bug-4" is not a promotion, and citing bug-4 would claim it was.

   **The one exception: reviving something already ruled out of scope.** If the request is
   to revive, un-reject or reconsider a specific `oos-N` — bring back a thing that was
   decided against — then the citation is required, not banned: pass `--from oos-N`, or
   add the same `from: oos-N` line by hand in step 3 the way `tags:` is added there. Two
   reasons it is capture's job and nobody else's. Rejection is terminal, so nothing comes
   back by being moved — `move` refuses every move out of `out-of-scope/`, deliberately,
   because the rejection is the record and it stays on it. And `backlog-groom` refuses an
   item already in `out-of-scope/` outright (its own first refusal), so there is no other
   skill that can file the reviving item at all. What comes back is a NEW item that cites
   the old one; the original stays rejected, where it is, untouched.

   **Filing several items in one request: finish each capture before starting the next.**
   `new` derives the id by looking at the files already on disk, so it hands out the *same*
   id every time until step 3 has actually written one. Running `new` six times up front
   yields six paths carrying three `bug-3`s and two `idea-7`s — duplicate ids that every
   other skill then cites ambiguously. Loop `new` → write → `new` → write, one item at a
   time, and the ids come out sequential on their own.

3. Write the file at the path `new` printed:
   - keep the printed `---`-delimited frontmatter block exactly as printed;
   - if the user gave tags, add a `tags:` line **inside** that block, before the closing
     `---` (comma-separated, e.g. `tags: ui, dashboard`) — `new` never emits this line
     itself, so add it or leave it out entirely, and never add a `status:` field: the tool
     rejects that outright, because the directory an item lives in is its status;
   - **for a `refactors` capture, add a `kind:` line to that same block**, with exactly
     one of two values: `kind: chore` for tidying nobody is owed — dead code, a rename, a
     file that should be three files — or `kind: debt` for a shortcut that was taken
     deliberately and is now due. Like `tags:`, `new` never emits it and you add it by
     hand. Ask if it isn't obvious from what the user said; the two are a real
     distinction, not a severity. Any other value survives on disk untouched but means
     nothing to the board, which badges the two known values and silently ignores the
     rest — so a guess spelled differently is the same as no kind at all;
   - after the closing `---`, add the section's headings from the table below, verbatim,
     filling in what you know and writing `unknown` where you don't.

4. Print the id and the path back so the user has something to cite.

### Worked example

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" new ideas "Backlog dashboard tab"
```

```
/abs/path/backlog/ideas/open/idea-1-backlog-dashboard-tab.md
---
id: idea-1
title: Backlog dashboard tab
created: 2026-08-23
---
```

Write that same path with the three `idea` headings appended:

```
---
id: idea-1
title: Backlog dashboard tab
created: 2026-08-23
---

## Problem

## Rough shape

## Open questions
```

## Section headings, verbatim

| Section | Headings |
|---|---|
| bug | `## Symptom`, `## Repro`, `## Affects`, `## Cause`, `## Fix` |
| idea | `## Problem`, `## Rough shape`, `## Open questions` |
| task | `## Goal`, `## Plan`, `## Test cases`, `## Done when` |
| refactor | `## What exists today`, `## Why it should change`, `## Rough shape` |
| out-of-scope | `## What was proposed`, `## Why rejected`, `## What would change the answer` |

A refactor's headings are not an idea's with different words. `## What exists today` names
the code as it actually is — a `file:line` or two, the way a bug's `## Affects` does —
because a refactor that doesn't say what it's refactoring cannot be picked up months later.
`## Why it should change` is the cost being paid now, not the benefit imagined later.

`## Affects` holds a `file:line` list. On a freshly captured bug it's normal for
`## Cause` and `## Fix` to both say `unknown` — that's exactly what makes the bug
ungroomed, and `backlog-execute` will refuse to work it until `backlog-groom` fills them
in.

Once filed, `/backlog` shows it on the board.
