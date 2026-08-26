---
name: backlog-capture
description: >
  File a new item into the backlog — a bug, an idea, a task, or something already decided
  against — as its own file under backlog/, creating the store itself if this repo doesn't
  have one yet. Use to log a bug, note this idea, add to the backlog, capture that, or
  remember this for later. Never moves or reclassifies an existing item — filing only,
  nothing else. Trigger: /backlog-capture
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
| something already analysed and decided against | `out-of-scope` |

Anything genuinely ambiguous between rows is **asked**, not guessed.

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

   Never pass `--from <id>` here. That flag exists for promoting an existing item into a
   new section, and promotion is `backlog-groom`'s job — capture doesn't do it, even when
   the new item was clearly inspired by an existing one.

3. Write the file at the path `new` printed:
   - keep the printed `---`-delimited frontmatter block exactly as printed;
   - if the user gave tags, add a `tags:` line **inside** that block, before the closing
     `---` (comma-separated, e.g. `tags: ui, dashboard`) — `new` never emits this line
     itself, so add it or leave it out entirely, and never add a `status:` field: the tool
     rejects that outright, because the directory an item lives in is its status;
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
| out-of-scope | `## What was proposed`, `## Why rejected`, `## What would change the answer` |

`## Affects` holds a `file:line` list. On a freshly captured bug it's normal for
`## Cause` and `## Fix` to both say `unknown` — that's exactly what makes the bug
ungroomed, and `backlog-execute` will refuse to work it until `backlog-groom` fills them
in.

Once filed, `/backlog` shows it on the board.
