# The skills

Eight skills under `skills/` — seven backlog skills and `jira` — one agent under `agents/`, and five CLIs beneath the skills — two of which do all the writing
to items, the registry and the run file, a third that only reads them, `tick.mjs`, which owns the one directory a scheduled tick keeps its lock and its failure
record in, and `jira.mjs`, which writes no file of its own and reaches Jira only through the local
API, its one git command (`worktree`) aside — plus one single-purpose helper `orchestrate.mjs` runs as a child (`api-call.mjs`, task-47). This is the plugin's
skill root — never duplicated under `.claude/skills/`, which would load the same skills twice and drift.

## Mechanism

### The eight

| skill                 | what it does                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backlog`             | prints the board and nothing else; it never writes                                                                                                                                                                                          |
| `backlog-capture`     | files one new item, creating the store if the repo has none                                                                                                                                                                                 |
| `backlog-groom`       | promotes an idea or refactor into a task with a plan, fills a bug's cause and fix, or closes something out as decided against                                                                                                               |
| `backlog-execute`     | does the work on a groomed bug or task, then archives it once verification proves it worked — or, when its trigger says `--finish pr`, commits it in its own worktree, has it reviewed, pushes and opens a pull request |
| `backlog-orchestrate` | drains a project's groomed queue unattended, one item per git worktree, each reviewed and verified before it merges                                                                                                                         |
| `backlog-retro`       | sweeps every orchestrator run on the machine into a report of what the pipeline cost, where the time went and how much was rework, proposes backlog items from what it finds, and records the sweep for the next one to be measured against |
| `backlog-tick`        | one unattended unit of work per scheduled tick, started by a dashboard job: only when the project is idle, it executes a ready bug or task to a PR, or grooms an ungroomed bug or a refactor into a plan marked `plan-review` |
| `jira`                | reads one Jira ticket and moves it — prints it, lists and applies its transitions, assigns it to me, checks the connection — all through `/api/jira`; on a Jira Run, makes the ticket's git worktree in a mapped repo (git only)           |

`backlog-orchestrate` is the largest of the seven and the only one that merges. Told to drain a queue, it works every ready bug and task one at a time —
each in its own worktree and its own headless `backlog-execute` session — then commits that item, has it reviewed and verified, and merges it into the run's
base branch before the next one starts. The base is `main` unless the run was started with `--base <ref>`, and it is the ref items are gated at, worktrees are
cut from and merges land in. Told to leave branches instead, it stops at a reviewed `backlog/<id>` branch per item and merges nothing at all.

Told `--merge-mode pr` — tracker projects only; `init` refuses any other with exit `1` and nothing written — it merges the same way, but onto a run branch of
its own, `backlog/run-<date>-<n>`, which `init` creates at the tip of the branch `--base` named. The run file's `base` is then the run branch and the new
`prTarget` is what `--base` named, so every command that reads `base` needs no change. The tool makes no GitHub call: at the finish the driver runs
`orchestrate.mjs pr-draft` (writes the body, prints the title and the two branch names), opens the pull request with `gh pr create`, and records the URL with
`orchestrate.mjs pr --url`. A run that merged nothing has its empty run branch deleted by `finish`. The mechanism and its reasoning are in
[invariants.md](invariants.md#pr-mode-drains-onto-a-run-branch-and-opens-one-pr-per-run).

`backlog-execute` has a per-run **finish mode**, read from its trigger: `--finish in-place|pr`, with `--base <ref>` beside `pr`. `in-place` — the default, and
what an absent flag means — is execute as it always was: it works in the tree it starts in and never commits or pushes. `pr` makes execute the one other skill
that writes git: it works in its own
worktree (`.worktrees/execute-<id>` on `execute/<id>`, cut from local `base`, or a clean reused linked worktree), commits there, has `backlog-reviewer` review
the diff (at most two fix rounds), pushes that branch and opens a pull request into `base` with `gh pr create`. It never merges, never pushes `base`, never
force-pushes, and under an `[orchestrator-run` marker ignores the mode entirely — inside a run the orchestrator still owns git. `base` is the trigger's
`--base`, else the remote's default branch (`origin/HEAD`), else `main`. An unknown or doubled `--finish` stops execute rather than falling back to either mode.
In a tracker project nothing is archived: the claim is held through the review, and after the push
`backlog.mjs review <id> on` puts the `in-review` label on, so every gate reads the open issue as `a PR is open for this item` until the PR merges and closes
it. The board's execute launch sheet is where the flag normally comes from: its Finish picker (seeded from the `executeDefaultFinish` setting) and Base select
make the server append the clause, and a typed trigger carries the same flag by hand.
`skills/backlog-execute/references/pr-mode.md` is the whole flow, and
[invariants.md](invariants.md#backlog-orchestrate-is-the-only-skill-that-merges-and-execute-commits-and-pushes-only-in-pr-mode) the reasoning.
`backlog-groom` lands on disk only, so an item has to be committed before an orchestrator run can read it.

### The CLIs

- `skills/backlog/tools/backlog.mjs` — the CLI every skill calls, and the registry's only writer. Since task-45 it also carries `connect github [owner/repo]`,
  which writes a project's committed `backlog/source.json` marker (and, by default, four GitHub issue forms) and touches the registry not at all — the marker is
  the project's, not the machine's. Since task-50 it also carries `import github [owner/repo] [--no-forms]`, which moves a files project's items onto issues
  through the local API and deletes the files last. Since task-46 it has **two modes**, chosen by that marker and nothing else (see below).
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `backlog-orchestrate`'s own CLI, and the run file's only writer. Since task-47 it has two modes of its
  own, chosen by the same committed marker `backlog.mjs` reads (see below).
- `skills/backlog-tick/tools/tick.mjs` — `backlog-tick`'s own CLI, and the tick home's only writer (through `tick-state.mjs`, the one file that writes). Four
  subcommands: `decide` (reads the project and prints ONE JSON verdict — `execute`, `groom`, `recover`, `busy` or `idle` — taking the lock only for the first
  two), `record <id> ok|failed --kind groom|execute`, `status` and `forget <id>`. See [`backlog-tick`](#backlog-tick) below.
- `skills/backlog-orchestrate/tools/api-call.mjs` — one HTTP request and nothing else, run by `orchestrate.mjs` with `spawnSync` (task-47). It exists so the
  parent can stay synchronous: `fetch` is asynchronous and `orchestrate.mjs`'s entry guard rests on nothing holding the event loop open, so the asynchrony is
  exiled into a child that is reaped before the parent's call returns. Its exit codes are private (`0`/`3`/`5`) and `apiCall` maps them onto the tool's own
  `8` (the stack is down) and `9` (a refusal this command cannot absorb).
- `skills/jira/tools/jira.mjs` — the `jira` skill's CLI (Jira phase 4): `show`, `transitions`, `transition`, `assign` and `status`, each one to three requests to
  `/api/jira` on `127.0.0.1`. API-only except `worktree`, which runs git in the mapped repo (below); the API commands have no files mode and write no file,
  and none of it carries a Jira credential, the server being Jira's one caller.
  Exit `0` success, `1` usage (a key that is not one included — nothing is sent), `2` a 4xx, `3` a 5xx, `5` the stack is down.
  Since the repo/branch work it has one more command, `worktree <KEY> --repo <path> --mode new|continue --branch <name> [--base <name>]`, and it is the
  exception to all of that: git only, no request, so it works with the stack down. It fetches (one retry on a lock, `BM_JIRA_FETCH_RETRY_MS` apart; each
  attempt killed after 60 s, `BM_JIRA_FETCH_TIMEOUT_MS`, and ssh run with `BatchMode=yes` unless something already configures it), re-checks
  the Run's choice against the fresh refs, enters or makes the tree at `<repo>/.worktrees/<branch with / as ->`, fast-forwards a clean tree with `--ff-only`,
  writes `.worktrees/` and `node_modules` to `info/exclude` and links `node_modules` for a tree it made, and prints one JSON line
  (`{ worktree, branch, created, notes }`). It never runs `--force`, `-D`, `prune` or `reset`. Exit `0`, `1` usage, or `4` — git refused, or a re-check
  stopped the Run, and nothing changed — never `2`, `3` or `5`.
- `skills/backlog-retro/tools/retro.mjs` — `backlog-retro`'s own CLI, and the only writer of `~/.backlog-manager/retro/` (`$BM_RETRO_HOME`). It is the one
  writer among them whose files nothing else reads at runtime: it reads the run-state directory (`$BM_ORCH_HOME`), the registry (`$BM_REGISTRY_FILE`) and, by
  recorded lease id, a run's driver transcript (`$BM_CLAUDE_PROJECTS`), and its `record` command writes a sweep, the session's labels and the report beside
  them, once, refusing to overwrite.

No skill's tools may import another skill's: one skill's `tools/` directory is not on another's path once installed, so a helper two of them need exists
twice, on purpose. No helper is shared by all of them, and the two pairs are different pairs — `backlog.mjs` and `orchestrate.mjs` each carry the
linked-worktree discriminator (the `commondir` entry in a `gitdir:` target, never "`.git` is a file"), while `orchestrate.mjs` and `retro.mjs` each carry
`orchHome()` and `projectDir()`.
The Jira repo/branch work added two more pairs, each across a different border: `orchestrate.mjs` and `jira.mjs` each carry `ensureExcludeLines` (the
idempotent append to `<common dir>/info/exclude` that keeps `.worktrees/` and the `node_modules` link out of `git status`), and `jira.mjs` carries Tables A
and B — `branchNameProblem` and `branchCarriesKey` — whose other home is not a tool at all but `shared/jira-branch.ts`, which the server and the client import
and no skill can. `jira.test.mjs` pins the same Table A and B rows as `test/jira-branch.test.ts`.
`tick.mjs` carries the most, in `tick-lib.mjs` and its own source — `orchHome()` and `projectDir()` among them, so that pair has a third copy — each with a
comment naming its original ([`backlog-tick`](#backlog-tick)).
`retro.mjs` has no discriminator at all — it needs no git root, because its subject is every project at once — and `backlog.mjs` has neither path helper,
because the run-state directory is none of its business. Each copy is pinned by its own tool's suite.

#### `backlog.mjs`'s two modes (task-46, spec §6.5)

No marker, or `{"kind":"files"}`, is **files mode** — today's synchronous code, byte for byte, making no HTTP request on any verb. `{"kind":"github"}` with a
valid repo is **API mode**: the project has no item files, so every command routes through `http://127.0.0.1:${BM_API_PORT || 4322}`, where the server holds
`BM_GITHUB_TOKEN` and does the writing. Anything else is exit `1` naming the marker — never a fallback to files, which would write item files into a project
whose items live on GitHub.

The stack has to be running: there is no offline queue, because a write parked on one laptop would be a second source of truth invisible to every other machine.
A refused connection is **exit `5`**, a new code, naming the port and both ways to start the stack.

What each verb does differently, and the five that exist only here:

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
| `body`           | new — groom's body patch, behind `--if-updated-at`; a bug's or task's body gets exactly one `bm:groomed-at` footer (#322). Files mode: exit `1`     |
| `drift`          | both modes — files reads the item file, API mode the body and its footer; GET requests only (#322)                                               |
| `import`         | files mode ONLY — the command that moves a project INTO API mode; refused (already tracker-backed) once there                                      |
| `review`         | new — `review <id> on\|off` sets or clears the `in-review` label through `POST /api/items/review` (execute `pr` mode). Files mode: exit `1`         |
| `plan-review`    | new — `plan-review <id> on\|off` sets or clears the `plan-review` label through `POST /api/items/plan-review` (backlog-tick); `review`'s twin, and `off` is how a plan is approved. `new` and `body` also take `--plan-review`, so the mark lands in the same write as the plan. Files mode: exit `1`, naming the `plan-review: true` line to delete |

Ids are `31`, `#31` or this project's own URN, all meaning one issue; a file-shaped id and another repo's URN are each refused with their own sentence. Session
identity is `CLAUDE_CODE_SESSION_ID`, falling back to `<user>@<host>` — stable across the two processes `start` and `stop` run in. The MACHINE a claim records
(`hostIdentity()`, bug-46) rides beside the session, never inside it: `BM_MACHINE_NAME` when set and not blank, else `<user>@<host>`. `orchestrate.mjs` reads
the same variable, because the server's release clause compares the two tools' strings for equality — and on a public repository the claim comment publishes
that string, so the variable is a privacy setting first.

What every one of them _does_ share is how it ends: `process.exitCode = main(...)`, never `process.exit(main(...))`. Writing to a pipe is asynchronous, so
`process.exit()` tears the process down before stdout drains and a `--json` payload is silently cut at exactly 65,536 bytes — while a `> file.json` redirect,
synchronous on POSIX, stays perfectly fine, which is why the shipped instance (a 442,757-byte `retro.mjs sweep --json` that arrived through `| jq` as 65,536
bytes and a parse error) survived every hand check. Setting the code instead lets node flush and exit on its own. That is only safe because none of them
holds the event loop open: all reads are synchronous `fs`, every child is `spawnSync`, and `orchestrate.mjs watch` sleeps by blocking on `Atomics.wait` rather
than on a timer. Whoever adds a timer, a server or an async child closes its handle — restoring `process.exit()` would restore the truncation. One rule, one
comment per file; `retro.mjs`'s is the long-form copy the others point at, and `backlog.test.mjs`'s source guard reads every one of them.

`backlog.mjs` (task-46), `api-call.mjs` (task-47), `jira.mjs` (Jira phase 4) and `tick.mjs` (backlog-tick) end `process.exitCode = await main(...)`, and the
rule is untouched by the `await`: it is `process.exit()` that truncates a pipe, and what the rule actually requires is that nothing hold the event loop open
when `main` returns. Each awaits every `fetch` to completion and sends `connection: close`, so no pooled socket outlives the call — `tick.mjs`'s request
timeout is an `AbortSignal.timeout`, an unref'd timer, and every child it runs is `spawnSync`; the source guard accepts the awaited form for those four files
and still requires the synchronous one of `orchestrate.mjs` and `retro.mjs`, which hold no asynchronous work at all. `backlog.test.mjs`'s
`CLI_SOURCES` is where the list of files lives, never a count in prose.

#### `orchestrate.mjs`'s two modes (task-47, spec §7)

The same marker decides, read per call and cached nowhere. **Files mode is byte for byte what it always was** — no command spawns `api-call.mjs` at all, which
the suite pins by driving a whole stage sequence with `BM_API_PORT` pointed at a closed port. **`github` mode** changes these things and nothing else:

| Where                | Tracker behaviour                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the queue            | candidates from `GET /api/items` filtered to this project; bodies from `GET /api/items/body`; the UNCHANGED `gateItem` verdicts. No `<base>` read, so no "not committed on `<base>`" skip. `hoisted` reads the `runner-fix` LABEL. That index is the poller's CACHE, so (bug-41) a `--ids` entry it has not polled yet buys one re-read timed off `polledAt` before the refusal, and a whole-queue preview prints the cache's age on stderr |
| ids                  | the BARE issue number (`31`). `--ids` accepts nothing else, naming the shape it wants                                                                 |
| `init`               | `git pull --ff-only origin <base>` in the tree holding the base, BEFORE the queue is built. A failure refuses the init, nothing written                |
| the claim            | `stage <n> preflight` claims, and so does the first `stage` out of `parked` to a non-release stage (#250); every field-changing command heartbeats the state; a terminal stage releases with this run's bill, and so does `finish` for everything the run still holds on any status but `paused` — a `needs-answers` item's claim, say (reason `finished`, #240; `aborted` when `abort` ends the run, bug-40); `stage <n> merged --outcome <file>` closes the issue |
| publishing (task-48) | `finish` stamps `finished` on the last-touched claimed item; `attention` posts a `bm:attention` comment with an `@mention`; `heartbeat` heartbeats every held claim — all best-effort, one stderr line on failure |
| `orchestrator:queued` (task-52) | `init` adds the label to every queue item as built, within `--max`; a skip removes it from an item never claimed; `finish` and `--abort` sweep every never-claimed item. All through `POST /api/items/queue`, all advisory: a refusal is one stderr line per item, the API down is ONE line for the batch, and no exit code moves. A won claim removes it server-side, so a claimed item needs nothing here |
| `reconcile`          | each row gains `claim` (`this-run`/`other`/`released`/`none`/`unknown`, from `GET /api/items/claim`); `other` makes the suggestion `skip` |

Two commands exist only here: `snapshot <n>` (the issue body plus the session's Outcome, as one file the reviewer and `verify` read) and `stage`'s `--outcome`
flag, which is required for `merged` in a tracker project and refused in a files one. `docs/subsystems/invariants.md`'s
"the driver owns a tracker item's claim for the whole item" carries the reasoning.

#### A fix loop resumes, or starts fresh past 150k (#226)

A reviewer's `fix` verdict used to resume the item's last session every time, and that session had already read everything the execute pass read.
`orchestrate.mjs fix-mode <id>` now decides, read-only: it reads the last `usage` entry's `peakContextTokens` (the largest context any one turn carried,
recorded by `usage`) and answers `fresh` at or above 150,000 tokens, or when there is no session id to resume, and `resume` otherwise — an entry without the
field resumes, so a run from before the change behaves as it did. `SKILL.md` §7 copies the verdict into one of two launchers: `--resume` as before, or a new
`claude -p` handed the findings and pointers in a prompt file. `retro.mjs` splits `totals.fixLoops` into `byMode.resumed` and `byMode.fresh`, derived from
session ids alone (a resumed session keeps the id it was handed), each with its cost, median peak and the next review pass's verdicts, so the threshold can
be tuned from what each mode came to. Design: `docs/superpowers/specs/2026-09-25-fresh-session-fix-loop-design.md`.

#### Groom drift: the anchor, `drift`, the marker and the mark (#322)

A plan is written against one commit and executed against a later one. Four pieces close that gap, and only the last one is stored:

- **The anchor.** `backlog.mjs new` stamps `groomed-at: <HEAD sha>` into a bug's or task's frontmatter — or, in a tracker project, a
  `<!-- bm:groomed-at <sha> -->` footer on the body's last line, which `body` keeps to exactly one — and a groom `stop` re-stamps it. An abandon, an execute
  stop and an idea or refactor never do. A repository with no commits yet writes no key.
- **`backlog.mjs drift <id> [--base <ref>] [--json]`.** Derived per call from `skills/*/tools/drift-lib.mjs` — two byte-identical copies, one beside each tool,
  because `orchestrate.mjs` imports nothing from `skills/backlog/tools/`, and `drift-lib.test.mjs` pins them equal. The anchor is `groomed-at` (or its
  merge-base with the base, off a side branch), else the last commit before `created:` (a bare date read as UTC midnight), else nothing. The paths are the
  plan's backticked tokens that look like paths and that git knows at the anchor or the base; the answer is `none`, `drifted` (commits since the anchor touching
  them, counted distinct, or a path gone) or `unknown` with a reason. `orchestrate.mjs plan` prints it as a `~` line under each row that is not `none`, and
  `--json` carries it as `drift`. Drift is never a verdict.
- **The marker.** `backlog-execute`'s Task path runs `drift` before `executing-plans`. On `drifted`/`unknown` it checks every step: minor drift is adapted and
  listed under `Plan adapted:` in the Outcome; a plan that no longer holds changes no code and writes an Outcome whose first line is exactly
  `Plan no longer holds: <what broke>`, on the existing "nothing moves" path.
- **The mark.** `orchestrate.mjs inspect` reports that line as `planStale`; the driver runs `stage <id> ungroomed --plan-stale`, which re-reads the line from
  the same Outcome — the session's prose never rides a command line — and files `{ planHash, detail, runId, at }` in `<projectDir>/stale-plans.json`. Every
  later `plan`/`init` gate turns the item `ungroomed` while the plan's hash still
  matches; a re-groom changes the hash and so clears it. `archiveSidecars` never moves the file. `docs/subsystems/invariants.md`'s "a stale-plan mark is keyed
  by the plan's hash" carries the reasoning.

### `backlog-tick`

Spec: [2026-10-22-backlog-tick-design.md](../superpowers/specs/2026-10-22-backlog-tick-design.md). A dashboard job fires the skill on a schedule, and every
firing asks `tick.mjs decide` one question — is there a unit of work worth starting, and is the project idle? — and does exactly what the answer says, then
reports `record`. The skill never runs by hand and never decides anything itself: the verdict is data from a tool, and the session only carries it out.

**`decide` prints one JSON line.** `execute <id>` (the next ready bug or task, off the working tree, while fewer than `--max-prs` `execute/*` pull requests are
open), `groom <id>` (an ungroomed bug's fix, or a refactor promoted to a task, while fewer than `--max-plans` items carry `plan-review`), `recover` (a lock
older than `--lock-ttl` minutes was found and claimed), `busy` (the project is occupied — a `running` or `paused` run, a board-started run with no run file, a
`started:` marker anywhere in the main checkout or a linked worktree, a live claim or a fresh remote run) or `idle` (nothing worth starting, or a tracker
project whose stack is down — or whose tracker cache the tool cannot trust yet, #332). Execute wins over groom.

**A tracker project's index is believed only once the poller has read its repo.** The server's cache is in memory and per repo, so after every restart
`/api/items` lists no rows for a project until that repo's first sync lands — and an empty list read as it stands is `nothing to do`. So `decide` also reads
`GET /api/trackers` and finds the project's row by `path`: no row, or a `null` `polledAt`, is `idle: tracker not polled yet: <repo>`; an `access` other than
`ok` is `idle: tracker <access>: <detail ?? repo>` (checked first, since a failed first sync leaves both); and a polled repo with not one row of any status for
this project is `idle: tracker cache holds no items for <repo> (polled <polledAt>)`. All three come before the busy check, lock nothing and record nothing; the
next tick is the retry. `trackerPolledAt` in `orchestrate.mjs` is the precedent, not a twin — the orchestrator re-reads on the stamp, the tick never waits.
The server's half is one log line per repo per process, `tracker <repo>: cold sync <status> — <n> issues cached, <pages> page(s)`, at the end of its first
successful sync, so an empty cache can be told from one that filled and was emptied. `--dry-run` writes nothing, not even the lock. Defaults: 2 open PRs, 3 plans awaiting review, a
180-minute lock.

**The breaker is `decide`'s step 3b.** After the lock step (`busy` for a held lock, `recover` for a stale one) and before any API read, `decide` derives a
streak from `state.json`'s `recent` and answers `idle`, reason `halted: N failures in a row (halt after M) — reset on the board, Runs › Ticks`, once the streak
reaches `haltAfter` (`~/.backlog-manager/settings/tick.json`, `$BM_TICK_FILE`; an integer 1–10, default 3). The walk is newest first: an unparseable `at` or one
at or before the project's `resetAt` stops it, `ok` stops it, `failed` counts. A halt is never stored — lowering `haltAfter` below a streak halts at the next
`decide`, raising it un-halts — and only a person's Reset clears it: the board stamps `resetAt` into `tick.json`, and the tool never writes that file. A halted
project costs one call and no API traffic, a stale lock is still recovered while halted, and `forget <id>` leaves the streak alone. An unreadable `tick.json` is
`idle` too, reason `<path> unreadable — fix or remove it by hand`, never a default. The streak rule is `tools/tick-breaker.mjs`;
`server/src/tick/tick-breaker.util.ts` carries the second copy, and one `streakOf` table is pinned on each side
([invariants.md](invariants.md#a-tick-halt-is-derived-from-the-records-and-the-reset-time-never-stored-and-only-a-persons-reset-clears-it)). `status` prints the
reading as one line — `breaker: N of M failures in a row` or `breaker: HALTED — N failures in a row (halt after M) since <at>`, with ` (reset <resetAt>)`
appended when a Reset is on file — and `status --json` carries it as `breaker: { streak, haltAfter, halted, resetAt, settings }`.

**Unattended means a gate.** A groom a tick runs lands the plan in the same write as the `plan-review` mark (a label, or a `plan-review: true` frontmatter
line), and every gate that could execute the item refuses it with `this plan awaits review` until a person removes the mark — `backlog.mjs plan-review <id>
off`, or delete-and-commit on a files project. A tick's groom never promotes an idea, never rejects, never commits and never asks a question. Why it is built
this way: [invariants.md](invariants.md#a-tick-does-one-unit-only-when-idle-and-never-executes-a-plan-that-awaits-review).

**State lives in `~/.backlog-manager/tick/<project-key>/`** (`$BM_TICK_HOME`): a `lock` and a `state.json` recording each item the tick failed on by content
hash, so an item that cannot be done is skipped until it changes — by the same kind of unit, except that a failed groom holds back execute too, because its
plan may be one nobody reviewed; a person who has reviewed it runs `forget`. `decide` refuses a linked worktree; `record`, `status` and `forget` follow one
to its main checkout, because an execute's `--finish pr` leaves the session inside its own tree, and `record` exits `3` when the lock names another id. The tool
is self-contained — it imports from no other skill, `server/` or `shared/`, runs
neither `orchestrate.mjs` nor `backlog.mjs`, and writes no git — and the twins it carries name their originals. A killed tick's lock is recovered by the next
one, and the only marker it ever clears is the groom `started:` its own stale lock proves was its own
([invariants.md](invariants.md#the-only-started-marker-a-tick-clears-is-the-one-a-killed-tick-left)); the ownership rule is
[invariants.md](invariants.md#backlog-managertick-has-exactly-one-writer-and-the-tick-never-writes-run-state).

### `references/`

`skills/backlog-orchestrate/references/` holds the parts its `SKILL.md` deliberately does **not** carry inline, because a run re-reads its whole body on
every one of its several hundred turns: `recovery.md` (all of `--resume`/`--abort`, read in full before either), `rationale.md` (the measurements and the
incident stories behind the rules), `tracker.md` (the github-source path, read only when the committed `backlog/source.json` says `github`, on a fresh and on a
resumed run), and four failure paths a clean run never takes, each read on an observable trigger: `questions.md`, `stopping.md` (pause and stop),
`merge-failures.md` and `check-failures.md`. The convention that keeps the body that way — a rule enters it as one statement, its story and its rare branches
go here — is [invariants.md](invariants.md#a-new-orchestrate-rule-enters-skillmd-as-one-statement-its-story-and-its-rare-branches-go-to-references); the body's
size is printed as a `t.diagnostic` line by every `pnpm run test:skills` run, as information and never as a budget.

`skills/backlog-retro/references/rationale.md` is the same idea: why a tool computes and a session labels, why the label set is closed, and the 2026-09-06
baseline the first record is measured against.

`backlog-execute` and `backlog-groom` keep the same split for the paths an ordinary session never takes. `skills/backlog-execute/references/pr-mode.md` is the
whole `--finish pr` flow, read in full once the trigger chose `pr`; `skills/backlog-execute/references/backlog-tick.md` is the reasoning and the stops behind a
session dispatched under a `[backlog-tick]` marker, read when a stop happens; and `skills/backlog-groom/references/backlog-tick.md` is read in full, before
`show`, by a groom carrying that marker — the two verdicts a tick may groom, the `## Assumptions (unattended)` heading and the `plan-review` mark's spelling per
source.

### `agents/`

The plugin's own agents, one file each, discovered from this root-level directory by Claude Code's own convention — no `.claude-plugin/plugin.json` declaration
needed. Currently one: `backlog-reviewer.md`, the read-only reviewer `backlog-orchestrate` dispatches before every merge and `backlog-execute` before a
`pr`-mode push. It is published only because
`PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) names it alongside `skills/`.

## Interfaces

- **The registry** — `backlog.mjs` upserts on `init`/`new` and removes on `unregister`; everything else in this repo only reads it.
- **Each project's store** — the skills are its only writers, one Markdown file per item.
- **The run file** — `orchestrate.mjs` writes it; the API reads it. The control file travels the other way, server → tool, and is the one file that does: one
  per project, holding either a PAUSE (stop at the next item boundary) or a STOP (end the run now, bug-39), never both.
- **The retro home** — `retro.mjs record` writes `~/.backlog-manager/retro/` (`$BM_RETRO_HOME`) and nothing else does, once per sweep and refusing to overwrite
  an existing record; `retro.mjs sweep` only reads it back for the deltas. Nothing in the server or the client reads it at all — a board view over the newest
  record is a separate design, once records exist.
- **The tick home** — `tick.mjs` writes `~/.backlog-manager/tick/` (`$BM_TICK_HOME`), one directory per project, and nothing else does; it reads the run-state
  directory, the registry and the project's items to say `busy`, and writes none of them. The server reads it, per request and never writes it — `GET
  /api/ticks` and the board's Runs › Ticks page ([api.md](api.md#tick--the-tick-breakers-board)); the one file the server writes for the breaker is
  `settings/tick.json`, which `decide` and `status` read.
- **The plugin install** — a run resolves its own skill files through the plugin-root path its skill text was loaded with,
  a copy of the pushed `HEAD`. Getting an edit there is
  [workflows/publishing.md](../workflows/publishing.md).

**Every command in a SKILL.md spells the plugin root `${CLAUDE_PLUGIN_ROOT}`, braces included.** Claude Code substitutes that exact braced form into a plugin
skill's text when it loads the skill, and exports no such variable to the Bash tool — so the bare `$CLAUDE_PLUGIN_ROOT` survives loading untouched, expands to
the empty string in the shell, and every `node` line becomes `node "/skills/…"`. Sessions noticed and fell back to guessing the plugin cache path by hand.
A file read with `Read` (the `references/` files, a SKILL.md re-read from the repo after a runner fix) is never substituted; `backlog-orchestrate` says what
to replace the placeholder with there, and those files spell it braced too, so there is one placeholder to recognise. Guarded by
`test/skill-plugin-root.test.ts`, which refuses the bare spelling in every `.md` and `.mjs` under `skills/` — prose and usage headers included.

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
  verified: 5a74ebf0f276cf9103c7a744f913c01f02e178f5
-->
