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

## In a tracker project

A project whose `backlog/source.json` says `github` has **no item files**: its items are GitHub issues, and every command above routes through the
backlog-manager API running on this machine, which holds the credential. Nothing about how you invoke them changes — `board`, `board --section bugs` and
`board --json` print the same thing off the same tool. What changes is what has to be true for them to work, and the vocabulary for naming an item.

**The stack must be running.** There is no offline mode and deliberately no queue: a write parked on one laptop would be a second source of truth for an item
nobody else can see. A refused connection is **exit `5`**, naming the port and both ways to start the stack (`pnpm run dev`, `pnpm run docker:up`). Treat it
exactly like exit `2` — a precondition to fix, not a backlog to report.

**An item is `#31`.** `31`, `#31` and the full URN `gh:<owner>/<repo>#31` all name the same issue, so use whichever the context hands you; a file-shaped id
(`task-31`) is refused with its own message, because in a tracker project there is no such thing. A URN naming a different repository is refused too.

The commands and flags that exist only here, one line each:

- `show <id>` prints the item's URN, a frontmatter-shaped block, `---`, and then **the body** — there is no file for a skill to read afterwards, so this is
  the whole of what an item says. `show <id> --json` adds `updatedAt` and the current claim, which `groom` and `stop` both need.
- `new <section> "<title>" --body <file>` — `--body` is REQUIRED here (and refused in a files project): with no file to write, the body travels with the
  request. Prints three lines: the id, the url, the URN.
- `move <id> done|out-of-scope [--outcome <file>]` — the outcome file becomes the issue's closing comment.
- `start <id> --as groom|execute` takes the item by posting a claim comment; `--as` is required, because the claim records which phase is running.
- `heartbeat <id>` says this session is still alive. **A claim reads stale after 15 minutes without one**, at which point the next session to contest the item
  retires it — so heartbeat between long steps.
- `comment <id> --body <file>` appends a comment without moving anything.
- `body <id> --body <file> --if-updated-at <iso>` replaces the item's body, refusing if the issue moved since you read it. Only `backlog-groom` uses it.

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

## Connecting a project to GitHub

`backlog.mjs` carries one command this skill does not print a board with, and it is here because this
file is where the tool's commands are documented:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" connect github [owner/repo] [--no-forms]
```

It writes `backlog/source.json` — the committed marker that tells every machine's board this project's
items are GitHub issues rather than files — and, unless `--no-forms`, four issue forms under
`.github/ISSUE_TEMPLATE/`, one per type, each pre-applying its `type:*` label and carrying that
section's `## ` headings so an issue filed in the web UI has the skeleton the board reads. It prints
the files to commit and writes nothing else: the registry is untouched, no network call is made, and
the marker does nothing until it is committed and the machine running the board has pulled it.

It refuses rather than guesses: inside a linked worktree, outside a git repository, with no
`owner/repo` argument and no GitHub `origin` to take one from, on a project that still has item files
under `backlog/` (importing those is a later phase's job), and on a project that already has a marker.

## Next

An item on the board is rarely done being planned:

- Shape not settled yet → **`backlog-groom`** turns it into something executable.
- Already planned and ready → **`backlog-execute`** builds it.
