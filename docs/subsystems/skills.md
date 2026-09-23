# The skills

Six skills under `skills/`, one agent under `agents/`, and three CLIs beneath the skills — two of which do all the writing to items, the registry and the run
file, and a third that only reads them — plus one single-purpose helper `orchestrate.mjs` runs as a child (`api-call.mjs`, task-47). This is the plugin's
skill root — never duplicated under `.claude/skills/`, which would load the same skills twice and drift.

## Mechanism

### The six

| skill                 | what it does                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backlog`             | prints the board and nothing else; it never writes                                                                                                                                                                                          |
| `backlog-capture`     | files one new item, creating the store if the repo has none                                                                                                                                                                                 |
| `backlog-groom`       | promotes an idea or refactor into a task with a plan, fills a bug's cause and fix, or closes something out as decided against                                                                                                               |
| `backlog-execute`     | does the work on a groomed bug or task, then archives it once verification proves it worked                                                                                                                                                 |
| `backlog-orchestrate` | drains a project's groomed queue unattended, one item per git worktree, each reviewed and verified before it merges                                                                                                                         |
| `backlog-retro`       | sweeps every orchestrator run on the machine into a report of what the pipeline cost, where the time went and how much was rework, proposes backlog items from what it finds, and records the sweep for the next one to be measured against |

`backlog-orchestrate` is the largest of the six and the only one that touches git. Told to drain a queue, it works every ready bug and task one at a time — each
in its own worktree and its own headless `backlog-execute` session — then commits that item, has it reviewed and verified, and merges it into the run's base
branch before the next one starts. The base is `main` unless the run was started with `--base <ref>`, and it is the ref items are gated at, worktrees are cut
from and merges land in. Told to leave branches instead, it stops at a reviewed `backlog/<id>` branch per item and merges nothing at all.

`backlog-execute` never commits and never pushes; `backlog-groom` lands on disk only, so an item has to be committed before an orchestrator run can read it.

### The CLIs

- `skills/backlog/tools/backlog.mjs` — the CLI every skill calls, and the registry's only writer. Since task-45 it also carries `connect github [owner/repo]`,
  which writes a project's committed `backlog/source.json` marker (and, by default, four GitHub issue forms) and touches the registry not at all — the marker is
  the project's, not the machine's. Since task-50 it also carries `import github [owner/repo] [--no-forms]`, which moves a files project's items onto issues
  through the local API and deletes the files last. Since task-46 it has **two modes**, chosen by that marker and nothing else (see below).
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `backlog-orchestrate`'s own CLI, and the run file's only writer. Since task-47 it has two modes of its
  own, chosen by the same committed marker `backlog.mjs` reads (see below).
- `skills/backlog-orchestrate/tools/api-call.mjs` — one HTTP request and nothing else, run by `orchestrate.mjs` with `spawnSync` (task-47). It exists so the
  parent can stay synchronous: `fetch` is asynchronous and `orchestrate.mjs`'s entry guard rests on nothing holding the event loop open, so the asynchrony is
  exiled into a child that is reaped before the parent's call returns. Its exit codes are private (`0`/`3`/`5`) and `apiCall` maps them onto the tool's own
  `8` (the stack is down) and `9` (a refusal this command cannot absorb).
- `skills/backlog-retro/tools/retro.mjs` — `backlog-retro`'s own CLI, and the only writer of `~/.backlog-manager/retro/` (`$BM_RETRO_HOME`). It is the one of
  the three that writes nothing anybody else reads at runtime: it reads the run-state directory (`$BM_ORCH_HOME`), the registry (`$BM_REGISTRY_FILE`) and, by
  recorded lease id, a run's driver transcript (`$BM_CLAUDE_PROJECTS`), and its `record` command writes a sweep, the session's labels and the report beside
  them, once, refusing to overwrite.

No skill's tools may import another skill's: one skill's `tools/` directory is not on another's path once installed, so a helper two of them need exists
twice, on purpose. No helper is shared by all of them, and the two pairs are different pairs — `backlog.mjs` and `orchestrate.mjs` each carry the
linked-worktree discriminator (the `commondir` entry in a `gitdir:` target, never "`.git` is a file"), while `orchestrate.mjs` and `retro.mjs` each carry
`orchHome()` and `projectDir()`.
`retro.mjs` has no discriminator at all — it needs no git root, because its subject is every project at once — and `backlog.mjs` has neither path helper,
because the run-state directory is none of its business. Each copy is pinned by its own tool's suite.

#### `backlog.mjs`'s two modes (task-46, spec §6.5)

No marker, or `{"kind":"files"}`, is **files mode** — today's synchronous code, byte for byte, making no HTTP request on any verb. `{"kind":"github"}` with a
valid repo is **API mode**: the project has no item files, so every command routes through `http://127.0.0.1:${BM_API_PORT ?? 4322}`, where the server holds
`BM_GITHUB_TOKEN` and does the writing. Anything else is exit `1` naming the marker — never a fallback to files, which would write item files into a project
whose items live on GitHub.

The stack has to be running: there is no offline queue, because a write parked on one laptop would be a second source of truth invisible to every other machine.
A refused connection is **exit `5`**, a new code, naming the port and both ways to start the stack.

What each verb does differently, and the four that exist only here:

| Verb             | API mode                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`           | registers and prints `already connected: <root> → github <repo>`; creates no directories; exit `0`                                                 |
| `new`            | `--body <file>` REQUIRED (and refused in files mode); `--kind`, `--from` ride along; prints the id, the url and the URN                            |
| `show`           | prints the URN, a frontmatter-shaped block, `---`, and **the body** — there is no file to read afterwards. `--json` adds `updatedAt` and the claim |
| `board`          | `GET /api/items`, filtered to this project's open rows, printed by the same code path                                                              |
| `move`           | `state`; `--outcome <file>` becomes the closing comment (refused in files mode)                                                                    |
| `start` / `stop` | the claim protocol. `--as` REQUIRED on `start`; `stop` rediscovers the claim, bills the counters and releases                                      |
| `heartbeat`      | new — says this session still holds the item; refused (exit `1`) on another session's claim, naming both sessions and, when the claim recorded one, both machines (bug-45, bug-46). Files mode: exit `1` |
| `abort`          | new — releases a LIVE claim this machine's own dead session left behind (bug-48): refused unless the claim's `host` equals `hostIdentity()` and Claude Code's session registry (`<configDir>/sessions/*.json`) holds no running entry for the holder — and refused as `cannot tell` when that registry is unreadable, malformed, or has no running entry for the aborting session itself (bug-49); a board-dispatched `claude -p` session between turns has no entry either, and reads as gone; releases with `reason: 'aborted'` and no `counters`. A dead claim exits `0` saying the next `start` retires it. Files mode: exit `1`, naming `stop <id> --abandon` |
| `comment`        | new — appends a comment. Files mode: exit `1`                                                                                                      |
| `body`           | new — groom's body patch, behind `--if-updated-at`. Files mode: exit `1`                                                                           |
| `import`         | files mode ONLY — the command that moves a project INTO API mode; refused (already tracker-backed) once there                                      |

Ids are `31`, `#31` or this project's own URN, all meaning one issue; a file-shaped id and another repo's URN are each refused with their own sentence. Session
identity is `CLAUDE_CODE_SESSION_ID`, falling back to `<user>@<host>` — stable across the two processes `start` and `stop` run in.

What every one of them _does_ share is how it ends: `process.exitCode = main(...)`, never `process.exit(main(...))`. Writing to a pipe is asynchronous, so
`process.exit()` tears the process down before stdout drains and a `--json` payload is silently cut at exactly 65,536 bytes — while a `> file.json` redirect,
synchronous on POSIX, stays perfectly fine, which is why the shipped instance (a 442,757-byte `retro.mjs sweep --json` that arrived through `| jq` as 65,536
bytes and a parse error) survived every hand check. Setting the code instead lets node flush and exit on its own. That is only safe because none of the three
holds the event loop open: all reads are synchronous `fs`, every child is `spawnSync`, and `orchestrate.mjs watch` sleeps by blocking on `Atomics.wait` rather
than on a timer. Whoever adds a timer, a server or an async child closes its handle — restoring `process.exit()` would restore the truncation. One rule, one
comment per file; `retro.mjs`'s is the long-form copy the others point at, and `backlog.test.mjs`'s source guard reads every one of them.

`backlog.mjs` (task-46) and `api-call.mjs` (task-47) end `process.exitCode = await main(...)`, and the rule is untouched by the `await`: it is
`process.exit()` that truncates a pipe, and what the rule actually requires is that nothing hold the event loop open when `main` returns. Each awaits every
`fetch` to completion and sends `connection: close`, so no pooled socket outlives the call; the source guard accepts the awaited form for those two files and
still requires the synchronous one of `orchestrate.mjs` and `retro.mjs`, which hold no asynchronous work at all. `backlog.test.mjs`'s `CLI_SOURCES` is where
the list of files lives, never a count in prose.

#### `orchestrate.mjs`'s two modes (task-47, spec §7)

The same marker decides, read per call and cached nowhere. **Files mode is byte for byte what it always was** — no command spawns `api-call.mjs` at all, which
the suite pins by driving a whole stage sequence with `BM_API_PORT` pointed at a closed port. **`github` mode** changes these things and nothing else:

| Where                | Tracker behaviour                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the queue            | candidates from `GET /api/items` filtered to this project; bodies from `GET /api/items/body`; the UNCHANGED `gateItem` verdicts. No `<base>` read, so no "not committed on `<base>`" skip. `hoisted` reads the `runner-fix` LABEL. That index is the poller's CACHE, so (bug-41) a `--ids` entry it has not polled yet buys one re-read timed off `polledAt` before the refusal, and a whole-queue preview prints the cache's age on stderr |
| ids                  | the BARE issue number (`31`). `--ids` accepts nothing else, naming the shape it wants                                                                 |
| `init`               | `git pull --ff-only origin <base>` in the tree holding the base, BEFORE the queue is built. A failure refuses the init, nothing written                |
| the claim            | `stage <n> preflight` claims; every field-changing command heartbeats the state; a terminal stage releases with this run's bill, and so does `abort` for everything the run still holds (reason `aborted`, bug-40); `stage <n> merged --outcome <file>` closes the issue |
| publishing (task-48) | `finish` stamps `finished` on the last-touched claimed item; `attention` posts a `bm:attention` comment with an `@mention`; `heartbeat` heartbeats every held claim — all best-effort, one stderr line on failure |
| `reconcile`          | each row gains `claim` (`this-run`/`other`/`released`/`none`/`unknown`, from `GET /api/items/claim`); `other` makes the suggestion `skip` |

Two commands exist only here: `snapshot <n>` (the issue body plus the session's Outcome, as one file the reviewer and `verify` read) and `stage`'s `--outcome`
flag, which is required for `merged` in a tracker project and refused in a files one. `docs/subsystems/invariants.md`'s
"the driver owns a tracker item's claim for the whole item" carries the reasoning.

### `references/`

`skills/backlog-orchestrate/references/` holds the two parts its `SKILL.md` deliberately does **not** carry inline, because a run re-reads its whole body on
every one of its several hundred turns: `recovery.md` (all of `--resume`/`--abort`, read in full before either) and `rationale.md` (the measurements behind the
rules).

`skills/backlog-retro/references/rationale.md` is the same idea: why a tool computes and a session labels, why the label set is closed, and the 2026-09-06
baseline the first record is measured against.

### `agents/`

The plugin's own agents, one file each, discovered from this root-level directory by Claude Code's own convention — no `.claude-plugin/plugin.json` declaration
needed. Currently one: `backlog-reviewer.md`, the read-only reviewer `backlog-orchestrate` dispatches before every merge. It is published only because
`PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) names it alongside `skills/`.

## Interfaces

- **The registry** — `backlog.mjs` upserts on `init`/`new` and removes on `unregister`; everything else in this repo only reads it.
- **Each project's store** — the skills are its only writers, one Markdown file per item.
- **The run file** — `orchestrate.mjs` writes it; the API reads it. The control file travels the other way, server → tool, and is the one file that does: one
  per project, holding either a PAUSE (stop at the next item boundary) or a STOP (end the run now, bug-39), never both.
- **The retro home** — `retro.mjs record` writes `~/.backlog-manager/retro/` (`$BM_RETRO_HOME`) and nothing else does, once per sweep and refusing to overwrite
  an existing record; `retro.mjs sweep` only reads it back for the deltas. Nothing in the server or the client reads it at all — a board view over the newest
  record is a separate design, once records exist.
- **The plugin install** — a run resolves its own skill files through `$CLAUDE_PLUGIN_ROOT`, a copy of the pushed `HEAD`. Getting an edit there is
  [workflows/publishing.md](../workflows/publishing.md).

**Every command in a SKILL.md spells the plugin root `${CLAUDE_PLUGIN_ROOT}`, braces included.** Claude Code substitutes that exact braced form into a plugin
skill's text when it loads the skill, and exports no such variable to the Bash tool — so the bare `$CLAUDE_PLUGIN_ROOT` survives loading untouched, expands to
the empty string in the shell, and every `node` line becomes `node "/skills/…"`. Sessions noticed and fell back to guessing the plugin cache path by hand.
A file read with `Read` (the `references/` files, a SKILL.md re-read from the repo after a runner fix) is never substituted; `backlog-orchestrate` says what
to replace the placeholder with there. Guarded by `test/skill-plugin-root.test.ts`.

**Start orchestrator runs from the board, not by typing the trigger into a terminal** — the board spawns `claude -p`, and headless sessions were measured
flooring well below an interactive session's context.

## Invariants

The rules the tools enforce rather than the prose — the single-writer relationships, what `start`/`stop` may write into frontmatter, the worktree refusal, the
driver lease and the exit codes, the `runner-fix:` hoist, which merge failures park and which degrade to a branch — are in [invariants.md](invariants.md). Each
skill's own `SKILL.md` is the authority on how that skill behaves; this doc is the map, not a second copy of it.

<!-- docs-sync:
  sources:
    - skills
    - agents
  kind: subsystem
  verified: d3dbf8855e78b4ae70c792eeb7696167a44ce8a4
-->
