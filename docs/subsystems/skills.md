# The skills

Five skills under `skills/`, one agent under `agents/`, and two CLIs beneath the skills
that do all the writing. This is the plugin's skill root — never duplicated under
`.claude/skills/`, which would load the same skills twice and drift.

> Moved here from `README.md` and `CLAUDE.md` during the docs restructure, so the prose
> is the repo's own, but nobody has yet read it back against the code — this doc is
> deliberately `unstamped` until that pass happens.

## Mechanism

### The five

| skill | what it does |
| --- | --- |
| `backlog` | prints the board and nothing else; it never writes |
| `backlog-capture` | files one new item, creating the store if the repo has none |
| `backlog-groom` | promotes an idea or refactor into a task with a plan, fills a bug's cause and fix, or closes something out as decided against |
| `backlog-execute` | does the work on a groomed bug or task, then archives it once verification proves it worked |
| `backlog-orchestrate` | drains a project's groomed queue unattended, one item per git worktree, each reviewed and verified before it merges |

`backlog-orchestrate` is the largest of the five and the only one that touches git. Told
to drain a queue, it works every ready bug and task one at a time — each in its own
worktree and its own headless `backlog-execute` session — then commits that item, has it
reviewed and verified, and merges it to `main` before the next one starts. Told to leave
branches instead, it stops at a reviewed `backlog/<id>` branch per item and never touches
`main` at all.

`backlog-execute` never commits and never pushes; `backlog-groom` lands on disk only, so
an item has to be committed before an orchestrator run can read it.

### The two CLIs

- `skills/backlog/tools/backlog.mjs` — the CLI every skill calls, and the registry's only
  writer.
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `backlog-orchestrate`'s own CLI,
  and the run file's only writer.

Neither may import the other: one skill's `tools/` directory is not on another's path
once installed, which is why the two carry a deliberate second copy of the
linked-worktree discriminator, each pinned by its own suite.

### `references/`

`skills/backlog-orchestrate/references/` holds the two parts its `SKILL.md` deliberately
does **not** carry inline, because a run re-reads its whole body on every one of its
several hundred turns: `recovery.md` (all of `--resume`/`--abort`, read in full before
either) and `rationale.md` (the measurements behind the rules).

### `agents/`

The plugin's own agents, one file each, discovered from this root-level directory by
Claude Code's own convention — no `.claude-plugin/plugin.json` declaration needed.
Currently one: `backlog-reviewer.md`, the read-only reviewer `backlog-orchestrate`
dispatches before every merge. It is published only because `PUBLISHED_PATHS`
(`scripts/sync-plugin.mjs`) names it alongside `skills/`.

## Interfaces

- **The registry** — `backlog.mjs` upserts on `init`/`new` and removes on `unregister`;
  everything else in this repo only reads it.
- **Each project's store** — the skills are its only writers, one Markdown file per item.
- **The run file** — `orchestrate.mjs` writes it; the API reads it. The pause request
  travels the other way, server → tool, and is the one file that does.
- **The plugin install** — a run resolves its own skill files through
  `$CLAUDE_PLUGIN_ROOT`, a copy of the pushed `HEAD`. Getting an edit there is
  [workflows/publishing.md](../workflows/publishing.md).

**Start orchestrator runs from the board, not by typing the trigger into a terminal** —
the board spawns `claude -p`, and headless sessions were measured flooring well below an
interactive session's context.

## Invariants

The rules the tools enforce rather than the prose — the single-writer relationships, what
`start`/`stop` may write into frontmatter, the worktree refusal, the driver lease and the
exit codes, the `runner-fix:` hoist, which merge failures park and which degrade to a
branch — are in [invariants.md](invariants.md). Each skill's own `SKILL.md` is the
authority on how that skill behaves; this doc is the map, not a second copy of it.

<!-- docs-sync:
  sources:
    - skills
    - agents
  kind: subsystem
-->
