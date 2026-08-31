---
name: backlog
description: >
  Print the current backlog board — the open bugs, ideas, tasks and refactors in this
  repo — and nothing else; it never writes. Use for /backlog, "what's open", "show my
  backlog", "what's on the board", or "what am I working on next". Filing something new is a
  different skill (backlog-capture), not this one. Trigger: /backlog
trigger: /backlog
---

# /backlog — the read-only board

One command, and it changes nothing on disk:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board
```

This skill only reads `backlog/` and prints what's open. No moves, no captures, no
edits — it never touches an item's file. If the ask is to log a bug, note an idea, or file
anything new, hand off to `backlog-capture` instead of doing it here.

## The command

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board
```

Prints four headers, in this fixed order, every time — `bugs`, `ideas`, `tasks`,
`refactors` — including `(0 open)` for a section with nothing in it. `out-of-scope/` never
appears here: those items were already decided against, not left open.

One section only:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board --section bugs
```

`--section` takes `bugs`, `ideas`, `tasks`, or `refactors` — not `out-of-scope`.

Machine-readable:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" board --json
```

Each row is `<id>  <age>d  <title>`. A `»` before a title means someone is on that item
right now — `backlog-execute` marks it when it picks the item up, and `backlog-groom`
marks it too, for as long as a groom session is actively deciding that item's verdict.
The column only appears when something on the board is in progress, so a board without
it isn't hiding anything.
`--json` carries the same thing as `started`, the UTC timestamp the work began (`""` when
nobody has started it; a bare `YYYY-MM-DD` on items picked up before it stamped a time).

## Print it as returned

Show the command's own output as-is. Don't re-summarise it, re-sort it, drop rows, or
turn it into prose — the tool's ordering and completeness are the contract. A board you've
reworded is a board the next reader can't trust to be complete.

## Exit codes

- **`0`** — normal. Show the board.
- **`2`** — not inside a git repository, so there is no backlog here to read. `cd` into
  the project first, then rerun.
- **`3`** — no `backlog/` store in this repo yet. Run **`backlog-capture`** — it creates
  the store on its own. Do not run `init` by hand: creating the store belongs to exactly
  one skill, and it isn't this one.
- **`1`** — the board still printed, but at least one open item's file is malformed (its
  path is named on stderr). Show whatever printed anyway — that's a real, partial board,
  not a failed command.

## Next

An item on the board is rarely done being planned:

- Shape not settled yet → **`backlog-groom`** turns it into something executable.
- Already planned and ready → **`backlog-execute`** builds it.
