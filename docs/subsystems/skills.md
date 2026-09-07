# The skills

Six skills under `skills/`, one agent under `agents/`, and three CLIs beneath the skills
— two of which do all the writing to items, the registry and the run file, and a third
that only reads them. This is the plugin's skill root — never duplicated under
`.claude/skills/`, which would load the same skills twice and drift.

> Moved here from `README.md` and `CLAUDE.md` during the docs restructure, so the prose
> is the repo's own, but nobody has yet read it back against the code — this doc is
> deliberately `unstamped` until that pass happens.

## Mechanism

### The six

| skill | what it does |
| --- | --- |
| `backlog` | prints the board and nothing else; it never writes |
| `backlog-capture` | files one new item, creating the store if the repo has none |
| `backlog-groom` | promotes an idea or refactor into a task with a plan, fills a bug's cause and fix, or closes something out as decided against |
| `backlog-execute` | does the work on a groomed bug or task, then archives it once verification proves it worked |
| `backlog-orchestrate` | drains a project's groomed queue unattended, one item per git worktree, each reviewed and verified before it merges |
| `backlog-retro` | sweeps every orchestrator run on the machine into a report of what the pipeline cost, where the time went and how much was rework, proposes backlog items from what it finds, and records the sweep for the next one to be measured against |

`backlog-orchestrate` is the largest of the six and the only one that touches git. Told
to drain a queue, it works every ready bug and task one at a time — each in its own
worktree and its own headless `backlog-execute` session — then commits that item, has it
reviewed and verified, and merges it to `main` before the next one starts. Told to leave
branches instead, it stops at a reviewed `backlog/<id>` branch per item and never touches
`main` at all.

`backlog-execute` never commits and never pushes; `backlog-groom` lands on disk only, so
an item has to be committed before an orchestrator run can read it.

### The three CLIs

- `skills/backlog/tools/backlog.mjs` — the CLI every skill calls, and the registry's only
  writer.
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `backlog-orchestrate`'s own CLI,
  and the run file's only writer.
- `skills/backlog-retro/tools/retro.mjs` — `backlog-retro`'s own CLI, and the only writer
  of `~/.backlog-manager/retro/` (`$BM_RETRO_HOME`). It is the one of the three that
  writes nothing anybody else reads at runtime: it reads the run-state directory
  (`$BM_ORCH_HOME`), the registry (`$BM_REGISTRY_FILE`) and, by recorded lease id, a
  run's driver transcript (`$BM_CLAUDE_PROJECTS`), and its `record` command writes a
  sweep, the session's labels and the report beside them, once, refusing to overwrite.

None may import another: one skill's `tools/` directory is not on another's path once
installed, so a helper two of them need exists twice, on purpose. No helper is shared by
all three, and the two pairs are different pairs — `backlog.mjs` and `orchestrate.mjs`
each carry the linked-worktree discriminator (the `commondir` entry in a `gitdir:`
target, never "`.git` is a file"), while `orchestrate.mjs` and `retro.mjs` each carry
`orchHome()` and `projectDir()`. `retro.mjs` has no discriminator at all — it needs no
git root, because its subject is every project at once — and `backlog.mjs` has neither
path helper, because the run-state directory is none of its business. Each copy is
pinned by its own tool's suite.

### `references/`

`skills/backlog-orchestrate/references/` holds the two parts its `SKILL.md` deliberately
does **not** carry inline, because a run re-reads its whole body on every one of its
several hundred turns: `recovery.md` (all of `--resume`/`--abort`, read in full before
either) and `rationale.md` (the measurements behind the rules).

`skills/backlog-retro/references/rationale.md` is the same idea: why a tool computes and
a session judges, why the label set is closed, and the 2026-09-06 baseline the first
record is measured against.

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
- **The retro home** — `retro.mjs record` writes `~/.backlog-manager/retro/`
  (`$BM_RETRO_HOME`) and nothing else does; `retro.mjs sweep` reads it back for the
  deltas and refuses to overwrite a record. Nothing in the server or the client reads it
  at all — a board view over the newest record is a separate design, once records exist.
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
