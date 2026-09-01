---
name: backlog-orchestrate
description: >
  Drain a project's groomed backlog unattended: every ready bug and task, one at a time,
  each in its own git worktree and its own headless backlog-execute session, then
  committed, reviewed, verified and merged to main before the next item starts. Use it to
  drain the backlog, work the whole queue, run the backlog while I'm away, orchestrate
  tasks 3-7, or to --resume or --abort a run that was interrupted. It is the only skill
  that commits or merges — execute still does the work, groom still writes the plans, and
  neither of them ever touches git. Trigger: /backlog-orchestrate
trigger: /backlog-orchestrate
---

# /backlog-orchestrate — drain the queue, one merged item at a time

Orchestrate is the loop around `backlog-execute`, and only the loop. For every
groomed bug and task in a project's backlog it creates a worktree, runs one
fresh headless `backlog-execute` session inside it, commits what that session
produced, has it reviewed, proves it with real commands, and merges it to
`main` — then starts the next item from the updated `main`. Execute keeps
doing the work, groom keeps writing the plans, capture keeps filing new items.

Two things make this skill different from its three siblings, and both are
worth having in mind before the first command runs:

- **It commits and merges.** No other backlog skill touches git at all;
  execute's "never commits, never pushes" hard limit is unchanged and still
  holds *inside* the sessions this skill spawns. The orchestrator is the
  committer, on `backlog/<id>` branches and on `main`, by merge commit only.
- **It runs unattended.** The person who started it is usually not watching.
  So every rule below that looks paranoid — park rather than merge, ask
  best-effort rather than block, never `reset --hard` — is there because the
  failure it prevents would otherwise happen silently, hours after anyone
  could have caught it.

The trigger carries the whole invocation surface:
`/backlog-orchestrate [ids…] [--max N] [--resume] [--abort]`. Ids and
`--max` shape the queue (section 1); `--resume` takes over a run that was
interrupted and `--abort` ends one (section 10). With none of them, the run
is every ready item in the project's backlog, in the board's own order.

The run's state lives in a machine-local run file, and
`skills/backlog-orchestrate/tools/orchestrate.mjs` is its **only** writer —
the same single-writer discipline `backlog.mjs` keeps for the registry and for
item files. This skill never edits that file by hand, and never writes item
files either, except for one narrow case in pre-flight (see below).

Two reference files sit beside this one and are **not** loaded with it. Read
them at the moment they apply, not up front:

- **`references/recovery.md`** — the whole of `--resume` and `--abort`. Read it
  **in full** before running either, before any other command.
- **`references/rationale.md`** — the measurements and the failures behind the
  rules here. Read the matching section before arguing with a rule, or before
  simplifying one away.

## Where commands run, and why it is not negotiable

**This session's cwd must be the project root every time `orchestrate.mjs`
is called — whatever put it somewhere else.** Never a worktree this run
created. A cwd inside a linked worktree (and a `--project` pointed at one)
exits `1` with a message naming both the worktree and the project root to
re-run from.

**The scope is wider than the `cd`s this file prescribes: *anything* that
leaves the shell inside a worktree arms it.** The refusal is loud, but a
refusal mid-run is still a run that stopped. (What it used to do instead, and
the stray command that first triggered it, are in
`references/rationale.md` under "Where commands run".)

Everything that genuinely concerns a worktree takes its path as an explicit
flag instead of implying it from cwd: `stage --worktree`, `verify --cwd`, and
plain `git -C <path>` for git. There are exactly two exceptions in this whole
skill, both `backlog.mjs` rather than `orchestrate.mjs`, and both called out
where they happen: `backlog.mjs stop` in the resume and abort paths runs
*inside* the worktree, because the item file it clears the marker on is the
worktree's own copy; and §4's post-checkout probe runs `backlog.mjs show`
inside the worktree for the same reason in reverse — asking *that* tree, and
only that tree, whether the item is in it is the entire point of the call.

**That exception runs in a subshell — `( cd <worktree> && … )` — never a bare
`cd`.** Still mandatory, and one instance of the wider rule above rather than
its whole extent. A bare `cd` persists as the session's working directory for
every later command, and from there every `orchestrate.mjs` call refuses with
exit `1` until something changes back — an unattended run stops dead. The
parentheses keep the move inside one child shell that exits with the command.
The two `sh -c 'cd … && exec claude …'` dispatch lines below are the same
discipline by another spelling: `sh -c` is already its own process, so the
`cd` inside it never reaches this session.

The tool's exit codes, which the rest of this file quotes constantly:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | bad args, an unknown item id, an unknown stage or kind, missing required input, or a cwd (or `--project`) inside a linked worktree — **nothing is ever written on a `1`** |
| `3` | no run exists for this project — and, for `watch` only, "budget elapsed, child still alive" |
| `4` | lock held: a `run.json` still marked `running` (fresh *or* stale) refusing a plain `init` |
| `5` | `verify` only: nothing resolvable to verify with |

That `3` carries two meanings for `watch` deliberately: "no run yet" and
"still running, call me again" are the same shape of retry from here. And
unlike `backlog.mjs`, this tool has no exit `2` — running it outside a git
repository is a `1` whose message says `no .git found`.

## 1. Preview the queue — `plan` first, always

Before anything is created, spawned, or locked, print the queue that a run
*would* work. `plan` writes nothing at all: no run file, no directories, no
state. It is safe to run as many times as it takes to agree on the queue.

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" plan --project "$PWD"
```

`--project` must be an **absolute** path (a relative one exits `1`) and must
be the project root — the same string every later command will derive from
its own cwd. Real output looks like this:

```
ungroomed     bug-2  Settings hue swatch preview lags one theme change behind
    - ## Fix is still the "unknown" placeholder — nobody has diagnosed this yet
ready         bug-7  Dispatch launch sheet drops the selected model on a fast double-click
ready         task-1  Show a queue preview before an orchestrator run starts
needs-answers task-5  Let the run drawer jump straight to a parked item's worktree
    ? There is a TBD in this item — what still needs deciding before it can run?
```

Three gate verdicts, and they mean exactly what `backlog-execute`'s own
refusal gate means — this is the same rule, applied up front so a whole
session spawn is not spent on an item execute would refuse in its first
minute:

- **`ready`** — a task with real content under `## Plan`, or a bug whose
  `## Fix` is no longer the `unknown` placeholder. These are the only items
  that ever get dispatched.
- **`ungroomed`** — the gate refused it, with the reason on the `-` lines.
  Never dispatched, never a failure: it is a groom job, and the user should
  see it named here rather than discover it missing later.

  One of those reasons is not a grooming problem at all and reads
  differently: `not committed on main — the worktree this run creates from
  main would not contain backlog/…`. The gate reads each candidate's content
  **at the ref a worktree is created from**, not off the working copy,
  because that ref's bytes are the only ones a dispatched session will ever
  see. An item groomed a minute ago and not yet committed is therefore
  refused, and the fix is a `git commit` of `backlog/` on `main`, not a
  groom. The orchestrator will not make that commit for you: it commits
  inside a per-item worktree, on `backlog/<id>` alone, and nowhere else.
  (`plan` and `init` both take `--base <ref>` for a repository whose trunk is
  not called `main`; nothing in this file passes it, and the default is the
  same literal `main` §4's `worktree add` uses.)
- **`needs-answers`** — the gate passed, but the item still carries an open
  question (a `TBD`, a question line in the plan, a `## Done when` naming a
  command this project cannot resolve). Still a candidate; see pre-flight.

Only bugs and tasks are ever candidates, bugs first then tasks, oldest first
within each — ideas, refactors and out-of-scope items have nothing to execute
by definition. Two optional flags, and they pass through to `init`
identically, which is the point: whatever you previewed is what you get.

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" plan --project "$PWD" --ids task-3,bug-7 --max 2
```

- **`--ids a,b,c`** restricts the run to those ids **in the order given**,
  overriding the bugs-then-tasks ordering. An id no open item matches exits
  `1` naming it — relay that rather than guessing what was meant.
- **`--max N`** bounds how much of the queue this run will look at at all:
  counting from the top, once `N` ready items have been placed, every item
  after that is dropped from the run — including ones that would have read
  `ungroomed`. It is a cap on the run, not a cap on dispatches within a
  longer queue.

Show the user this table and get agreement on it before starting a run,
unless the trigger already named ids explicitly. A run is a long, expensive,
mostly-unattended thing; the preview is the last cheap moment to notice that
half the queue is ungroomed.

## 2. Start the run

**Prefer a run started from the board to one started by typing this trigger
into an interactive terminal.** A board-started run is spawned headless
(`claude -p`); an interactive one additionally carries every MCP server and
hook that terminal connects, and a run's context floor is re-read on every one
of its several hundred turns. Measured on this machine: interactive sessions
floor around 68k tokens before any work, headless ones around 50k. No
board-started *orchestrate* run existed when this was written, so treat that
~18k as the expected order for this path, not a measured result for it.

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" init --project "$PWD" --ids task-3,bug-7 --max 2
```

Same flags, same queue, now written down. `init` prints one JSON line:

```json
{"runId":"run-20260831-123118","dir":"/Users/you/.backlog-manager/orchestrator/%2FUsers%2Fyou%2Fprojects%2Ffoo"}
```

**Keep `dir`.** It is this run's own state directory, outside the repo, and
it is where every artifact this skill produces belongs: session transcripts,
pid files, question payloads, reviewer reports. Nothing this skill generates
is ever written into the repo — an artifact inside the tree would land in the
very diff being reviewed and ride the merge into `main`. Create the
subdirectories as you need them (`mkdir -p "<dir>/logs"`), and stay out of
`<dir>/runs/`, which is the tool's own archive of finished runs.

**Exit `4` means a run already exists for this project** — either one is live
right now, or one crashed and left its `running` status behind. Plain `init`
refuses both, identically and deliberately: a stale `running` run is the last
surviving record of a run that died mid-item, and possibly of a worktree, a
branch and an in-progress marker still on disk (`references/rationale.md`, §2).
Do not retry `init`, and **never delete the run file to get past this.** Run
`status`, show the user, then take the run over with `--resume` or end it with
`--abort` — both of which begin at `references/recovery.md`.

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" status
```

Then work the queue **strictly one item at a time**, in the order `status
--json` lists it. Sequential is not a performance compromise to be optimised
away later: merging to `main` between items is what keeps each item's
worktree isolated and each session's context clean, and two items in flight
forfeit both.

## 3. Pre-flight, per item

### Re-check the gate

`init` used the gate to decide *membership and order only* — it deliberately
did not bake the verdict into the run file, because a run can span hours and
a human may groom an item mid-run. So re-gate this one item immediately
before dispatching it:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" plan --project "$PWD" --ids <id> --json
```

- **`ungroomed`** → record it and move to the next item:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> ungroomed --note "<the gate's own reason>"
  ```

  `stage`, not `attention`: the attention list takes exactly three kinds —
  `needs-answers`, `parked`, `fix-exhausted` — and anything else exits `1`.
  An ungroomed item is not something that went wrong in this run, it is work
  waiting on `/backlog-groom`, and the drawer reads it off the stage.
- **exit `1`, "unknown item id"** → the item is no longer open (somebody
  archived or rejected it since `init`). Not an error worth stopping for:
  `stage <id> skipped --note "no longer open"` and continue.
- **`ready` or `needs-answers`** → carry on below.

Then say so on the record before doing anything slow:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> preflight
```

### Hunt for open questions

Read the item file in the **main tree** (read-only — no worktree exists yet)
and look for what would stop a headless session cold: a `TBD`, an unresolved
either/or in the plan, a section the plan refers to that is empty, a
`## Done when` naming a command this repo does not have. The gate's own
`questions` array from the `plan --json` above is a starting point, not the
whole hunt — it reads three mechanical signals; you are reading the item.

No questions → skip straight to the loop.

### With questions: ask, best-effort

Use `AskUserQuestion`, once, with the questions as written in the item. If a
channel exists (an interactive terminal, or a spawned session whose host
carries asks to the user's phone) the answer comes back and the run keeps its
momentum. **Treat the ask as best-effort:** if the tool is unavailable in
this session, errors, or returns without an answer, take the no-channel path
below immediately. Never re-ask, never poll, never wait in a loop — a
stalled unattended run is the exact failure this whole design exists to
avoid, and an item skipped with its question recorded costs one groom edit
and one re-run.

**Answered** → the answer is written into the item body, but *not yet* and
*not here*; see "Writing an answer into the item" below.

**Not answered** → record the questions verbatim and move on:

```bash
mkdir -p "<dir>/questions"
printf '%s' '["question one","question two"]' > "<dir>/questions/<id>.json"
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind needs-answers --detail "asked, no channel — skipped" --questions-json "<dir>/questions/<id>.json"
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> needs-answers
```

`--questions-json` takes a file holding a JSON array of strings, and its
content is only ever applied for `--kind needs-answers` — the other two kinds
read the flag and validate it, then ignore its content. Both lines: the
`attention` entry is what the run drawer surfaces to the user, the `stage` is
what stops this item being treated as still in flight. Then continue with the
next item; a `needs-answers` item is not a failed run.

### Writing an answer into the item

Orchestrate is a plugin skill and therefore a legitimate writer of item
files — but only here, only for a pre-flight answer, and under
`backlog-groom`'s write rules, which exist because the file is round-tripped
by tools that must not lose what they did not understand:

- round-trip every frontmatter key you did not come to change, byte-for-byte,
  including ones you have never seen before;
- leave the rest of the body byte-for-byte identical — write the answer under
  the section it clarifies, do not reflow, retitle, or tidy anything else;
- write before any move (nothing here moves a file, but the rule is the same
  one, and it is what keeps a half-written item from ever existing).

**Write it inside the worktree, after the worktree exists — not in the main
tree.** Two reasons, both hard-won: a worktree checks out `main`'s *commit*,
so an uncommitted amendment sitting in the main tree would never reach the
session that needs it; and worse, that same uncommitted change to the item's
own path is what makes `git merge` refuse later ("your local changes would be
overwritten"), because the item file is exactly the path the branch also
touches when execute archives it. Amending inside the worktree instead means
the answer rides the branch and reaches `main` through the merge, like every
other change this item makes. So: hunt and ask here, write in step 4.

## 4. The loop — worktree, dispatch, watch

### Create the worktree

**Probe for leftovers before creating anything.** Every park path in this
file keeps the item's branch *and* its worktree on purpose — fix-exhausted
(§7), nothing to verify with (§8), a merge conflict and a main tree not on
`main` (§9) — and `finish` cleans up none of it. The item most likely to be
queued by the *next* run is therefore exactly the one that already has both
on disk, because parking is what leaves it open. `worktree add` fails on
either: the directory is already there, and the branch answers
`fatal: a branch named 'backlog/<id>' already exists`.

```bash
git -C "$PWD" show-ref --verify --quiet refs/heads/backlog/<id>; echo "branch=$?"
git -C "$PWD" worktree list --porcelain | grep -qxF "worktree $PWD/.worktrees/<id>"; echo "worktree=$?"
[ -e "$PWD/.worktrees/<id>" ]; echo "dir=$?"
```

`0` means it is there, `1` means it is not. All three swallow their own exit
status so the call itself always succeeds — a `1` from `show-ref` is an
answer, not a failure. The directory is probed *separately* from the worktree
registration because the two can disagree: a pruned registration leaves a
plain directory git no longer knows about, and `worktree add` refuses that
just as hard as one it does know about. Then:

- **All three `1`** — nothing left over. Create it, below.
- **`branch=0 worktree=0 dir=0`** — a previous run's work is sitting there.
  **Never delete either to make room.** That is the same rule §10's abort
  path spells out, for the same reason: an unmerged worktree can hold
  uncommitted work that no commit and no reflog can bring back, and this run
  cannot know from outside that it doesn't. Look first —

  ```bash
  git -C "$PWD/.worktrees/<id>" status
  git -C "$PWD" log --oneline main..backlog/<id>
  ```

  — then ask, best-effort, exactly as pre-flight does, and take one of two
  answers:
  - **Resume onto it.** Record the existing pair and re-enter the loop at
    **Inspect** (step 5), *not* at dispatch: the tree already carries a
    previous session's work, and a fresh execute session dropped on top of it
    would produce a diff nobody can attribute, which the reviewer and the
    committer would then treat as this run's.

    ```bash
    node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> dispatched --worktree "$PWD/.worktrees/<id>" --branch backlog/<id>
    ```
  - **Park it again** — the only answer with no channel, and the honest one
    either way: the item is parked because a human decision was already asked
    for and not given, and a new run does not change that.

    ```bash
    node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "leftover worktree $PWD/.worktrees/<id> and branch backlog/<id> from an earlier run — resume or clear them by hand before the next run"
    node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
    ```
- **`branch=0 worktree=1 dir=1`** — the branch outlived its directory. Same
  two answers as above; to resume, check the branch out into a fresh worktree
  *without* `-b`:

  ```bash
  git -C "$PWD" worktree add .worktrees/<id> backlog/<id>
  ```

  then `stage <id> dispatched --worktree … --branch …` and Inspect, because
  the branch may already carry commits.
- **Any other combination** — a registered worktree whose directory is gone,
  a directory git has no record of, a worktree sitting on a detached HEAD.
  These are states this skill never creates, so it does not get to guess what
  they mean: park, with the detail naming exactly what the three probes said.
  Do not `worktree prune`, do not `branch -D`, do not `--force` anything —
  this run's authority stops at worktrees it created itself.

```bash
git -C "$PWD" worktree add .worktrees/<id> -b backlog/<id> main
```

The main working tree is never touched by this, and a dirty main tree does
not block it: the new worktree checks out `main`'s HEAD commit, not the
working copy. Creating a worktree on a *new* branch while `main` itself is
checked out in the main tree is legal — the branches differ, so nothing is
locked.

**Then prove the item survived the checkout, before writing any pre-flight
answer and before dispatching anything.** That same sentence — the worktree
checks out `main`'s *commit*, not the working copy — is also how an item can
be missing from the tree the session is about to run in: an item groomed but
never committed, which is the normal state of an item the moment grooming
finishes, exists only in the main tree. Ask `backlog.mjs` from inside the new
worktree, so its own `.git`-ancestor walk resolves to the worktree and not to
the main tree (a subshell, per the rules at the top of this file):

```bash
( cd "$PWD/.worktrees/<id>" && node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" show <id> ); echo "present=$?"
```

- **`present=0`** — the item is in the worktree. Carry on below.
- **`present=1`** — it is not. Park, and keep the worktree and the branch
  exactly as every other park path in this file does: delete nothing, `prune`
  nothing, `-D` nothing.

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "<id> is not present in the worktree checked out from main — commit backlog/ on main, then re-run"
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

§1's gate refuses an uncommitted item before a run ever starts, so on the
ordinary path this probe never fires. It is here because it catches strictly
more than that gate can — and because what it prevents is not a crash but a
*silent success*: a session with no item file in its tree finds the main
tree's copy, works that one, and every stage of the run reports success over a
branch carrying code with no lifecycle move on it. (`references/rationale.md`,
§4, lists everything the probe catches that the gate cannot.)

Then keep the new directory out of everybody's `git status`, idempotently:

```bash
EXCLUDE="$(git rev-parse --git-common-dir)/info/exclude"
grep -qxF '.worktrees/' "$EXCLUDE" 2>/dev/null || printf '.worktrees/\n' >> "$EXCLUDE"
```

Run that from the project root (the path `git rev-parse` prints is relative
to cwd). Three details, all load-bearing, all explained in
`references/rationale.md` (§4):

- **`--git-common-dir`, and the check before the append** — `info/exclude` is
  one shared file for the repo and every worktree of it, so a blind append
  grows duplicates in a file the user owns and changes `git status` repo-wide.
- **`grep -qxF`** — whole line, fixed string. Anything looser either misses an
  existing entry or matches an unrelated one and skips a needed append.
- **`info/exclude`, never `.gitignore`.** `.gitignore` is tracked: editing it
  is an uncommitted change in the user's repo at best, and a stray commit
  riding a merge into `main` at worst.

Now write any pre-flight answer into the worktree's copy of the item file
(see above), and record the worktree on the run:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> dispatched --worktree "$PWD/.worktrees/<id>" --branch backlog/<id> --permission-mode auto
```

Pass the worktree as an **absolute** path: `reconcile` and `abort` both test
it with a plain existence check from wherever they happen to be running, and
a relative path that resolves for one of them may not for the other.

`--permission-mode auto` here records on the run what the dispatch below is
about to launch under. It must match that dispatch line's own flag — the
field exists so that a denial found in a transcript has the mode that
produced it recorded beside it, and a field recording the wrong mode is
worse than no field.

### Dispatch the headless session

```bash
mkdir -p "<dir>/logs"
nohup sh -c 'cd "$PWD/.worktrees/<id>" && exec claude -p "/backlog-execute <id>" --output-format stream-json --verbose --permission-mode auto' > "<dir>/logs/<id>.jsonl" 2> "<dir>/logs/<id>.err" &
echo $! > "<dir>/logs/<id>.pid"
```

Both lines in **one** Bash invocation — each invocation gets its own shell,
so `$!` is only readable in the call that backgrounded the child; that is why
the pid goes straight into a file. `exec` matters too: it makes the pid you
recorded the `claude` process itself rather than a wrapper shell around it,
and `watch` polls exactly that pid. `nohup` and the redirects are what let
the session outlive the single tool call that started it. stdout is the
stream-json transcript and goes to the `.jsonl` that `watch` reads; stderr
goes to its own file, so a warning printed by the CLI never lands in the
middle of the transcript.

**`--verbose` is required, not a contingency.** With `--print`, the installed
CLI refuses the stream-json format without it, and in `-p` mode `--verbose` is
also what *produces* the event stream at all. Leaving it off is the quietest
failure in this whole file: every item in the queue parks as a crashed
session, and the run merges nothing. `references/rationale.md` has the exact
error and the full chain.

**`--permission-mode auto`, and not the rung above it.** What makes an
unattended session tolerable is not trust in the session, it is four walls:
a **disposable worktree** created seconds ago from `main`, an **independent
review** before anything moves, **verification commands** that must come back
green, and the **merge as the only door back to `main`**, walked by this skill
and never by the session. Remove any one and dispatching unattended stops
being defensible at any rung.

`auto` is the lowest rung that clears an execute session's real workload —
`acceptEdits` below it still prompts on `pnpm test` and on `git`. Do **not**
"tighten" it to `dontAsk` plus `--allowedTools`: that was probed and it is dead
on arrival, because it requires enumerating every command before the work
starts. The measurements behind both claims are in `references/rationale.md`.

**A denial is silent in every signal but one.** A refused call comes back as an
ordinary `tool_result` the session improvises around; the run still reports
`subtype: "success"`, `is_error: false`, and exit `0` **even when every call was
refused**. The one machine-readable trace is `permission_denials` on the result
event — which is why step 5 checks it before judging anything else, and why
that check is not optional in the fix loop either. Never read what `auto`
permitted on one day as a contract: it is a classifier's judgment, not a list.

### Watch until it exits

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" watch <id> --pid "$(cat '<dir>/logs/<id>.pid')" --jsonl "<dir>/logs/<id>.jsonl"
```

**Make this call with the Bash tool's timeout raised to its maximum:
`timeout: 600000`.** The default is `120000` — two minutes — and nothing
raises it for you. Left at the default, every `watch` call is cut off two
minutes into a nine-minute budget. That is survivable rather than fatal (the
child is `nohup`ed and unaffected, and the heartbeat has already landed on
the call's first tick), but it turns one designed call into five, each ending
in a tool error the loop has to read past instead of an exit code it has a
branch for. Ten minutes is the ceiling the tool will accept, and it is
exactly the number `--budget-ms`'s default was chosen to sit a minute under.

`watch` blocks for up to `--budget-ms` (default `540000`, nine minutes),
polling every `--interval-ms` (default `30000`). Each tick it heartbeats the
run, and the first time it finds the `system`/`init` event in the transcript
it records the session id onto the queue item for you — which is why this
skill never parses that file itself, and why `status --json` is where the
session id is read back from.

- **exit `0`** — the child is gone. Move to Inspect.
- **exit `3`** — the budget elapsed and the child is still alive. **Call
  `watch` again**, unchanged, as many times as it takes. That is the entire
  reason the command exists: nine minutes stays under a ten-minute tool-call
  ceiling with slack, so a two-hour item survives as thirteen calls instead
  of one call that gets cut off.
- **exit `1`** — a problem with this call: a missing `.jsonl` after the first
  interval, or one that cannot be read at all. The session may still be
  running; do not assume it died. Inspect the worktree and the `.err` file
  before deciding anything.

## 5. Inspect what the session left behind

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> inspecting
```

**First, before the item file: did the session get refused anything?**

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" denials --jsonl "<dir>/logs/<id>.jsonl"
```

Prints `{"count":N,"denials":[…]}`. A non-zero `count` means the session ran
`auto` into a call the classifier refused (see step 4's rationale) — and
because a denied run reports `success` and exits `0` like any other, this is
the only place it shows. **A non-zero count means the item is not clean even
if it looks done**: whatever the session built, it built around a command
that never ran. Treat it exactly like the two failure shapes below — ask the
user, and do not merge the diff. Exit `1` here is an unreadable transcript,
not a clean run; look at it before deciding anything. On the retry path
below, re-run this against the *retry's* transcript.

Then look at the item file **in the worktree**, not in the main tree — the
main tree's copy has not changed and will not until the merge, which is
exactly what the board shows and exactly what the run strip exists to
compensate for.

- **Moved to `backlog/<section>/done/`, with an `## Outcome` carrying real
  verification output** → execute succeeded on its own terms. Continue to
  Commit.
- **Still open, with a failure `## Outcome`** → execute's own failure path:
  it tried, verification failed, and it deliberately left the item where it
  was. That record is the most useful thing you have.
- **Neither** (no `## Outcome` at all, item still open, session gone) → the
  session died: a crash, a usage cap, a dropped connection.

For both failure shapes, ask the user — best-effort, exactly like pre-flight
— which of three they want: **retry**, **skip**, or **stop the run**. Retry
resumes that item's own session so its context is not paid for twice:

```bash
nohup sh -c 'cd "$PWD/.worktrees/<id>" && exec claude -p --resume <sessionId> "<what to do differently>" --output-format stream-json --verbose --permission-mode auto' > "<dir>/logs/<id>-retry-1.jsonl" 2> "<dir>/logs/<id>-retry-1.err" &
echo $! > "<dir>/logs/<id>.pid"
```

Then `watch` again exactly as in step 4, with `--jsonl` pointed at the new
transcript and `--pid` at the pid you just recorded, and come back to this
step when it exits.

The session id comes from `status --json` (recorded by `watch`); a null there
means the session died before its init event ever landed, and there is
nothing to resume — a fresh dispatch is the only retry available. With no
channel to ask through, do not guess: `attention <id> --kind parked --detail
"<what happened>"` plus `stage <id> parked`, keep the worktree and branch, and
continue with the next item. Skipping is `stage <id> skipped --note "…"`.
Stopping the run is `finish --status failed` after parking this item.

## 6. Commit — the orchestrator's job, still never execute's

Execute's hard limit is unchanged and still true inside the session: it never
commits and never pushes, because staging inside a tree it does not own can
sweep up work it knows nothing about. Here that reasoning does not apply —
the worktree contains this item's work and nothing else, which is the whole
point of creating one — so the orchestrator commits, and says so in the
commit body:

```bash
git -C "$PWD/.worktrees/<id>" add -A
git -C "$PWD/.worktrees/<id>" commit -m "fix(board): stop the launch sheet dropping a fast model change" -m "Item: bug-7
Committed by backlog-orchestrate on behalf of the headless backlog-execute session."
```

Conventional-commit subject, derived from the item's own title, in the type
that matches the item (`fix:` for a bug, usually `feat:`/`refactor:`/`chore:`
for a task). The body names the item id and names the orchestrator as the
committer, so `git log` never implies a human read this diff before it
existed — a reviewer, and the user reading history next month, both need to
know which commits arrived unattended.

`add -A` is safe *here specifically*: the worktree is a fresh checkout that
nothing else has written to. Never run it in the main tree.

## 7. Review

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> reviewing
```

Dispatch the plugin's own reviewer, `backlog-manager:backlog-reviewer`, with
the four fields its input contract requires and nothing else:

- `worktree` — `"$PWD/.worktrees/<id>"`
- `branch` — `backlog/<id>`
- `item file path` — the item's absolute path *inside the worktree*
- `report path` — `<dir>/reviews/<id>-1.md` (`-2` on the second loop)

That agent writes its full report to the report path and returns only
`verdict: approve` or `verdict: fix` plus its Critical/Important findings, one
line each. Do not re-state that contract in the dispatch prompt as if it were
optional, and do not ask for a summary in the message — the contract lives in
the agent definition precisely because prompt-side copies of it have
historically lost to generic reviewer templates, and a run of ten items
cannot afford ten full reports in this session's context.

- **`verdict: approve`** → straight to Verify.
- **`verdict: fix`** → one fix loop. Spend it on the run file first, and read
  the count back:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> fixing --fix-loop
  ```

  `--fix-loop` is the only valueless flag on `stage`; it increments this
  item's `fixLoops` and echoes the new value back, so the line prints
  `{"id":"<id>","stage":"fixing","fixLoops":1}`. Then resume the item's own
  executor session with the findings pasted in — step 5's retry line
  unchanged, every flag included and `--verbose` among them, writing to this
  loop's own transcript (`<dir>/logs/<id>-fix-<n>.jsonl`, `<n>` matching the
  `fixLoops` you just read back, so a second loop never overwrites the first
  one's evidence) — then `watch` it out as in step 4, **check that transcript
  for denials before committing anything**, commit again (step 6), and review
  again with a fresh report path (`<dir>/reviews/<id>-2.md`). Paste the
  findings as the reviewer wrote them — they name `file:line`, and
  paraphrasing them into "fix the review comments" hands the session a puzzle
  instead of a task.

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" denials --jsonl "<dir>/logs/<id>-fix-<n>.jsonl"
  ```

  **This is the same gate step 5 runs, and it is not optional here.** A fix
  loop is a headless session under `--permission-mode auto` exactly like the
  first one, so it can be refused a call exactly like the first one — and this
  path reaches Commit without passing through step 5, so nothing else on it
  would ever look. A refused fix session is the worst-placed denial in the
  whole loop: it has already been told what is wrong, so whatever it produced
  instead of the refused command looks like a response to the review, and the
  next reviewer reads a diff that was shaped by a command that never ran. A
  non-zero `count` means **do not commit this loop's work** — treat it as the
  fix loop failing, and take it to the fix-exhausted menu below rather than
  spending the second loop on a session that was not actually able to work.

**At most two fix loops per item, counted in the run file — not in your own
head.** `fixLoops` is what `--fix-loop` maintains, and reading the ceiling off
it (from the echoed value, or from `status --json`) is what makes it survive
the thing most likely to break it: a crash and a `--resume`, after which the
session that was counting is gone and a fresh one takes over an item that has
already burned both its loops. A ceiling held in a session's memory silently
resets there; one held in the run file does not. It is also the number the run
drawer renders, so an item that took two loops says so afterwards.

After the second `fix` verdict (`fixLoops` is now `2`), stop looping and hand
it to a human:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind fix-exhausted --detail "2 fix loops, still: <verdict summary> — report at <dir>/reviews/<id>-2.md"
```

Then, **with a channel**, ask: merge anyway, keep fixing, skip, or stop the
run — their call, on their repo. **With no channel**, `stage <id> parked` and
continue to the next item, keeping the branch and worktree for them to look
at. Never merge unreviewed-through changes silently just because the loop ran
out: "merge anyway" is a decision a person makes, not a default.

**That menu belongs to an unresolved review verdict and to nothing else.** A
reviewer's findings are a judgement, and a person is entitled to read the
report and decide they do not block a merge. A failing verification is not a
judgement — it is a command that came back red — so when the shared ceiling
runs out with `verify` still failing, this paragraph is *not* the paragraph
that applies: §8 says what happens there, and what happens there is always a
park. Arriving here from §8 and reading "merge anyway" as still on offer is
the one way to talk this system into breaking its own Hard limit, so the
offer is scoped here rather than left to be inferred.

## 8. Verify

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> verifying
mkdir -p "<dir>/verify"
rm -f "<dir>/verify/<id>.status" "<dir>/verify/<id>.out" "<dir>/verify/<id>.pid"
nohup env BM_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT" BM_RUN_DIR="<dir>" sh -c 'node "$BM_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" verify <id> --cwd "$PWD/.worktrees/<id>" > "$BM_RUN_DIR/verify/<id>.out" 2>&1; echo $? > "$BM_RUN_DIR/verify/<id>.status"' > /dev/null 2>&1 &
echo $! > "<dir>/verify/<id>.pid"
```

**All four lines in one Bash call**, and the `rm -f` in particular must never
be skipped or split off — see the first detail below for what it is actually
preventing.

**Detached, for the same reason the session in step 4 is.** A baseline suite
is the one step in this loop with no upper bound, and a Bash call cannot
outlive ten minutes. Run inline, a suite that outruns the call is killed
mid-flight and `verify` writes no exit code at all — an undefined state at the
merge gate, unattended. Detached, the ten-minute ceiling applies only to the
polling, which is built to be re-called. (`references/rationale.md`, §8.)

Five details in those lines, none of them the same as step 4's:

- **`rm -f` first, and it is a merge-gate rule rather than housekeeping.**
  `<dir>` belongs to the *run*, not to the attempt: nothing removes these three
  files afterwards, so a second attempt would inherit the first attempt's
  `.status` verbatim. Both "the verification did not finish" branches at the end
  of this section are predicated on that file being **absent**, so from the
  second attempt onward neither could fire — and the failure that produces is a
  green merge gate on a verification that never finished. Second attempts are
  ordinary here, not exotic: §9 parks an item *after* a green verify, and the
  next run resumes it at Inspect. `.out` and `.pid` are cleared on the same
  rule. **If you ever find yourself reading a `.status` you did not clear
  moments earlier in the same call, it is not this attempt's answer — treat it
  as absent and start the block again.** (`references/rationale.md`, §8, has
  the full chain and why step 4 needs no equivalent.)
- **No `exec`, unlike the dispatch line.** The pid recorded here is
  deliberately the wrapper `sh`, because the wrapper is what outlives `node`
  long enough to write `.status`. `exec` would replace it and the exit code —
  the one thing this whole step exists to produce — would be lost.
- **Named `env` variables inside the quotes, never a positional.** The quotes
  must stay single so `$?` reaches the inner shell rather than this one, which
  rules out interpolating `$CLAUDE_PLUGIN_ROOT` directly; `env` sets both names
  for the child instead. **Never pass them positionally.** Slash-command
  argument substitution rewrites positional parameters in this file before the
  session reads it, fenced code included — it has corrupted this exact line in a
  live run. Keep the plugin root and the run directory in `BM_PLUGIN_ROOT` /
  `BM_RUN_DIR`, and do not reintroduce a positional anywhere in this file.
  `$PWD` needs none of this care, which is why step 4's line uses it directly.
  (`references/rationale.md`, §8.)
- **`BM_RUN_DIR` also retires the `<dir>` placeholder inside this command.**
  Every other `<dir>` in this file is pasted once; here it was pasted three
  times into one line, and each paste was a chance to redirect an attempt's
  output at the wrong run's directory. Substitute it once, into `env`.
- **The tool still runs from the project root.** `nohup` inherits this
  session's cwd and there is no `cd` anywhere in the line; the worktree is
  named by `--cwd`, which is exactly what that flag is for (see "Where
  commands run" at the top of this file).

Then poll it out, with the same maximum Bash timeout step 4's `watch` needs
(`timeout: 600000`), as many times as it takes — exit `3` means "still
running, call me again", exactly as it does there:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" watch <id> --pid "$(cat '<dir>/verify/<id>.pid')" --jsonl "<dir>/verify/<id>.out"
```

Yes, `watch` — the same command, doing the same three jobs: sleeping inside
node rather than in the shell, returning `0` the moment the pid is gone, and
heartbeating the run every interval, which is what stops a long suite making
the board call a perfectly healthy run stale. Its `--jsonl` is a required
flag whose only purpose is finding a session's `system`/`init` event;
`verify`'s log has none, so that lookup finds nothing and writes nothing.
Pointing it at the log satisfies the flag with a file that genuinely exists,
which is all its missing-file check (exit `1`) is really testing for.

Then read the exit code out of the file, never off the poll:

```bash
cat "<dir>/verify/<id>.status"
```

`verify` resolves the project's baseline commands from
`<worktree>/backlog/verify.json`'s `commands` array, or failing that from the
obvious `package.json` scripts (`test`, `typecheck`, `build`, only the ones
that exist, run with `pnpm` when the project is pnpm-managed), unions them
with the fenced commands under the item's own `## Done when`, runs every one
of them in the worktree, and records `{cmd, ok, tail}` rows onto the queue
item. Every command runs even after one fails — a red first command must
never hide a second, independent failure.

This re-runs checks execute already ran, on purpose: a fix loop may have
changed the code after execute's own verification, and green *here* is the
merge gate.

Both of the first two branches below read "the file is not there", which is
only ever true because the `rm -f` above made it true. That is why it is in
the same call as the launch.

- **no `.status` file yet** — the verification has not finished. Either
  `watch` came back `3` and the suite is still going, or the poll itself was
  cut short. Poll again. **This is never a merge**, and it is never a
  failure either: it is the absence of a result.
- **the pid is gone and there is still no `.status`** — something killed the
  verification (the machine slept, a human `kill`ed it, the OS ran out of
  memory). Nothing was proved, so nothing is merged. Re-run the whole block
  above from the top, `rm -f` included — that line is what makes the next
  attempt's answer its own. It is both safe and the only recovery. `verify`
  writes its rows in a single atomic write *after* every command has
  finished, so an interrupted run leaves the run file exactly as it found it
  and a fresh attempt simply appends a fresh set of rows — the merge gate
  never sees a half-written verification, only a complete one or none.
  **The gate is the exit code of the last attempt that produced one**, and no
  `.status` means there is none.
- **exit `0`** — every command passed. Merge.
- **exit `1`** — something is red. Treat the failing rows exactly like review
  findings: feed them into a fix loop, spent the same way
  (`stage <id> fixing --fix-loop`, then resume, commit, re-review). The
  ceiling is the same two loops and it is *shared* with review — an item does
  not get two review loops *and* two verify loops, which is exactly what one
  counter per item, incremented by whoever spends the loop, enforces.

  **When that shared ceiling runs out with verification still red, the item
  parks — with a channel or without one.** Do not fall through to §7's
  exhaustion paragraph: its "merge anyway" is an offer about an unresolved
  review *verdict*, and there is no equivalent judgement to make here. A red
  command is not an opinion.

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind fix-exhausted --detail "2 fix loops, verification still red: <the failing commands> — rows in status --json"
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

  With a channel you may still say so and ask whether to keep fixing, skip,
  or stop the run — three of §7's four options. Never the fourth. Never merge
  red: nothing green-lights a merge except the commands passing.
- **exit `5`** — nothing resolvable to verify with: no `verify.json`, no
  `test`/`typecheck`/`build` script, no fenced `## Done when` command. Nothing
  was written, and this item cannot prove itself. **Park it**:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "nothing to verify with — add backlog/verify.json or a ## Done when block"
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

  Annoying on an unconfigured repo, and correct anyway: "merged, verified by
  nothing" is the false-done this entire system exists to prevent.

On an exit `1`, read the rows themselves (`status --json`) before spending a
loop, because one of them is not what it looks like. A row whose `tail`
begins **`could not run this command (…)`** never executed at all — a missing
binary, a command string the OS refused, output too large to capture. It is
red like any other red row and it gates the merge identically, but sending a
fix loop after the *code* over it wastes a session on an item nothing was
ever tested against. Fix the command or the environment, or park the item
with that row quoted in the detail.

## 9. Merge — the only door to `main`

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> merging
git -C "$PWD" symbolic-ref HEAD
```

**Precondition: the main tree must actually have `main` checked out** — that
command must print `refs/heads/main`, and it must succeed. Two distinct
failures, and both mean the same thing here:

- it prints another ref (`refs/heads/some-feature`) — the user switched
  branches mid-run;
- it prints **nothing at all and exits non-zero**, with
  `fatal: ref HEAD is not a symbolic ref` on stderr — the main tree is on a
  detached HEAD (mid-rebase, mid-bisect, or checked out at a tag). Check the
  exit status, not just the output: a bare "does it equal `refs/heads/main`"
  comparison reads an empty string here and, written carelessly, can look
  like a mismatch you handled rather than a command that failed.

In either case do **not** check out `main` yourself: their working tree is
theirs, and this run's authority stops at its own worktrees. Park instead and
continue:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "main tree is on <ref>, not refs/heads/main — branch backlog/<id> kept for a manual merge"
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
```

**Second precondition: the main tree's uncommitted paths must not overlap the
branch's.** A dirty main tree is fine — this run does not get to demand a
clean one — but only as long as the dirt sits somewhere the branch does not
touch. Test that rather than assuming it, because the answer changes during a
run: the person whose repo this is may edit anything at any moment, and the
item most likely to collide is the one whose subsystem they are working in.

```bash
git -C "$PWD" diff --name-only main...backlog/<id> | sort > "<dir>/verify/<id>.branch-paths"
{ git -C "$PWD" diff --name-only; git -C "$PWD" diff --cached --name-only; } | sort -u > "<dir>/verify/<id>.dirty-paths"
comm -12 "<dir>/verify/<id>.branch-paths" "<dir>/verify/<id>.dirty-paths"
```

Empty output means merge. Non-empty output names the exact files that will
refuse, and it is what makes the park detail actionable — "merge refused"
sends the user hunting, "`ItemCard.tsx` is uncommitted and this branch also
touches it" does not. Both scratch files go under the run's `<dir>`, never
`/tmp` and never the repo. `diff --cached` is not optional: a *staged*
uncommitted change refuses the merge exactly as an unstaged one does, and a
`git diff`-only probe reads clean over it.

On a non-empty intersection, do not stash, commit, or check anything out on
the user's behalf — their uncommitted work is theirs, and this is the same
boundary abort's preservation branch draws. Take the worktree-side resolve
below if it applies, otherwise park with the overlapping paths named:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "merge would be refused: <paths> are uncommitted in the main tree and this branch also touches them — commit or stash them, then merge backlog/<id> by hand"
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
```

Otherwise merge:

```bash
git -C "$PWD" merge --no-ff --no-edit backlog/<id>
```

`--no-ff` so every item is one identifiable merge commit in `main`'s history
even when it could have fast-forwarded; `--no-edit` so no editor opens in a
session that has no terminal to open one in.

**Two different failures, and they take different commands. Do not conflate
them.**

**A pre-merge refusal** — git declined before touching anything:

```
error: Your local changes to the following files would be overwritten by merge:
	client/src/components/board/ItemCard.tsx
Please commit your changes or stash them before you merge.
```

Nothing was modified, there is no `MERGE_HEAD`, and **`git merge --abort` is
the wrong command** — it errors with `fatal: There is no merge to abort`. The
tree is already in the state an abort would have restored. This is what the
overlap probe above is for; reaching it means the probe was skipped or the
tree changed in the seconds since. Handle it exactly as the probe's non-empty
branch does — park with the paths named, or resolve worktree-side — and issue
no `--abort`.

**A conflict** — the merge started and left markers behind:

```bash
git -C "$PWD" merge --abort
```

then `attention <id> --kind parked --detail "merge conflict with main — worktree and branch kept"`, `stage <id> parked`, keep the worktree and the
branch exactly as they are, and continue with the next item. A conflict means
`main` moved under the run (the user pushed, or an earlier item in this same
run touched the same lines); resolving it is a human's judgement call, and
the branch is the thing that makes that possible later.

**When `main` moved under the run, resolving on the *branch* side is better
than parking — and it is the only option that keeps the merge gate honest.**
Both failures above have the same root cause: `main` is no longer the commit
this item was verified against. Merging into it anyway would put content into
`main` that nothing green ever ran — every individual step was green, and the
combination was never tested. That is a hole in the "never merges red" hard
limit which is invisible precisely because nothing reports red.

So bring `main` into the worktree, prove the combination there, and only then
merge out:

```bash
git -C "$PWD/.worktrees/<id>" merge --no-edit main
```

- **It merges cleanly** — re-run **all of step 8** against the combined
  content, starting with its `rm -f`. This is exactly the second-attempt case
  that rule exists for, and skipping it reads the first attempt's `0` for a
  suite that never saw `main`'s changes. Green, then merge to `main` as above,
  which is now conflict-free. Red, then it is an ordinary §8 failure: a fix
  loop if the shared ceiling allows one, a park if it does not.
- **It conflicts** — park, per the conflict branch above. Resolving real
  content conflicts is a human judgement call and that has not changed;
  what changed is that this is now the *second* thing tried, not the first.

Nothing here touches the user's working tree: the merge, the resolution and
the verification all happen inside a worktree this run created, which is the
same reason the pre-flight amendment rule insists the item file is only ever
edited there.

**Undoing a merge that already completed is `git revert -m 1 <merge-sha>`,
never `git reset --hard`.** `reset --hard` was measured destroying an unrelated,
uncommitted modification in the main tree along with the merge, unrecoverably;
the same undo by revert left it byte-for-byte intact. An unattended run can
never rule out that the user has uncommitted work in their main tree, so the
noisier history is the price, knowingly paid. `-m 1` names the first parent —
`main` as it was before this merge. (`references/rationale.md`, §9, has the
measurement.)

**On success**, record it and clean up:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> merged
git -C "$PWD" worktree remove "$PWD/.worktrees/<id>"
git -C "$PWD" branch -d backlog/<id>
```

Plain `remove`, not `--force`: if git refuses because the worktree is not
clean, something is in there that was never committed, never reviewed and
never merged, and forcing would delete it with no undo.

**What happens to the item when that removal refuses: nothing. It stays
`merged`.** The `stage <id> merged` above already landed and it was true —
the branch is in `main` — so do not re-stage it to `parked`, which would tell
the board and the run summary that an item which actually merged did not. The
leftover is a cleanup problem, not a pipeline state: record it with
`attention <id> --kind parked --detail "merged; worktree <path> would not
remove cleanly — uncommitted leftovers to look at"` (the `parked` kind is the
attention list's closest fit, and the detail is what disambiguates it), leave
the directory and branch alone, and carry on to the next item. A human deletes
it after looking; nothing in the run depends on it being gone.

Likewise `branch -d` (safe delete) rather than `-D`: it only succeeds for a
branch that is actually merged, so a refusal here is real information — the
merge you think happened did not, and that *is* worth stopping to understand
before the next item builds on a `main` you may have misread.

Then the next item starts from the updated `main`, so later items build on
earlier ones.

## 10. Finishing, resuming, aborting

### Finishing

When the queue is drained:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" finish --status done
```

`--status` takes `done`, `aborted` or `failed`; anything else exits `1`. Then
summarise for the user from `status --json`: what merged, what parked and why,
what was skipped as `ungroomed` or `needs-answers` and therefore wants a
groom pass before the next run. A clean item — no fix loops, no retries,
green first try — should have produced no ping at all along the way; the
summary is where it finally gets mentioned.

Long steps in between deserve a heartbeat. `watch` stamps one every interval
— through the dispatched session in step 4 and through the detached
verification in step 8, which is precisely why neither of those two can make
a healthy run read as stale any more — but review and merge still can outlast
the fifteen-minute freshness threshold on their own, and a run whose
heartbeat goes stale reads to the board (and to a later `init`) as crashed:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" heartbeat
```

### `--resume` and `--abort`

**Both begin by reading `references/recovery.md` in full, before any other
command.** That file carries the whole of both paths: `reconcile`'s four
verdicts and what each one means, the ruling that a resumed session's dead
marker is billed with a plain `stop` rather than `--abandon` (deliberately the
opposite of what `backlog-groom` prescribes for a marker that looks identical),
and abort's order-of-operations, which is its entire safety property.

Two rules stay here, because a reader who stops at this line still has to know
them:

- **`--resume` starts from what is on disk, not from what the run file hoped.**
  `orchestrate.mjs reconcile` is read-only and prints one of four suggestions
  per item; deciding what to do with each is this skill's job, not the tool's.
- **`--abort` runs before any marker is cleared, never after.** Clearing a
  mid-flight item's marker first makes `abort` classify that item as safe and
  `git worktree remove --force` it — which deletes uncommitted work that was
  never committed and never staged, with no reflog entry to recover it from.

`--abort` ends a run; it never undoes one. Everything already merged stays
merged.

## Hard limits

- **Sequential, always.** One item in flight, start to merge, before the next
  begins. No flag enables parallel items; merging between items is the
  isolation, and parallelism forfeits it.
- **Never merges red.** Verification failure parks the item exactly like a
  conflict does. Nothing green-lights a merge except the commands passing —
  not a clean review, not a confident `## Outcome`, not "the failure looks
  unrelated."
- **Never force-pushes, never rewrites `main`'s history, never pushes at all.**
  Merge commits only; undoing one is `git revert -m 1`, never
  `git reset --hard` (step 9). Publishing anything is the user's call.
- **Never writes the registry.** `~/.backlog-manager/registry.json` keeps its
  single writer (`backlog.mjs` `init`/`new`), untouched by anything here.
- **Item bodies: pre-flight answers only.** Nothing else in the item
  lifecycle belongs to this skill — `start`, `## Outcome`, and the archive
  move all belong to `backlog-execute`, inside the session, and the plan
  belongs to `backlog-groom`. The single exception is the dead-marker
  `backlog.mjs stop` in the resume and abort paths, which clears a marker the
  session that set it is no longer alive to clear; it goes through the tool,
  never through an edit of the file.
- **The run file is written only through `orchestrate.mjs`.** Never hand-edit
  it, never `rm` it to get past an exit `4`, never write it from the server or
  the client. One writer, one reader — the same relationship the registry has.
- **`orchestrate.mjs` runs from the project root, always** (see the top of
  this file). Worktree-scoped work goes through `--worktree`, `--cwd` and
  `git -C`.

## Next

`/backlog` shows the board with every merged item archived. Items left as
`ungroomed` or `needs-answers` are a `/backlog-groom` pass away from being
ready for the next run; parked items are a human decision, and their branches
are still there. Anything the work surfaced along the way — a new bug, a
follow-on idea — is a `/backlog-capture`, not an edit to an item this run
already merged.
