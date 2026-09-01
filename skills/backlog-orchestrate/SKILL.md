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

## Where commands run, and why it is not negotiable

**This session's cwd must be the project root every time `orchestrate.mjs`
is called — whatever put it somewhere else.** Never a worktree this run
created. The tool resolves *which project it is acting on* by walking up
from its own cwd to the first `.git` it finds, and a linked worktree has its
own `.git` (a file, not a directory), so a worktree cwd used to resolve to
the worktree itself and key the run file under a directory nothing else ever
reads — the run appeared to vanish, quietly, with `status` reporting "no run
exists" for a live run.

Since bug-2 the tool refuses that outright: a cwd inside a linked worktree
(and a `--project` pointed at one) exits `1` with a message naming both the
worktree and the project root to re-run from. The failure is loud now, but
the rule is unchanged and still yours to keep — a refusal mid-run is still a
run that stopped. Note the scope: **anything** that leaves the shell inside a
worktree arms it, not just the `cd`s this file prescribes. The run that
surfaced this was broken by a one-off `pnpm exec jest --version` probe.

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
`cd`.** Still mandatory, and now one instance of the wider rule above rather
than its whole extent. A bare `cd` persists as the session's working
directory for every later command, and from there every `orchestrate.mjs`
call refuses with exit `1` until something changes back — an unattended run
stops dead. (Before the tool refused, it did something worse: `watch` exited
`3`, "no run exists", §4 told you to call `watch` again as many times as it
takes, and the run looped until somebody killed it.) The parentheses keep the
move inside one child shell that exits with the command. The two `sh -c 'cd … && exec claude …'`
dispatch lines below are the same discipline by another spelling: `sh -c` is
already its own process, so the `cd` inside it never reaches this session.

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
refuses both, identically and deliberately: a stale `running` run is not an
idle lock, it is the last surviving record of a run that died mid-item, with
possibly a worktree on disk, a branch, and an item file still carrying an
in-progress marker that is billing time to nobody. Do not retry `init`, and
never delete the run file to get past this. Run `status`, show the user, then
take the run over with `--resume` or end it with `--abort` (both below).

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
more than that gate can: a project root the gate could not read as a git work
tree at all (it falls back to the working copy there, deliberately), a main
tree not actually on `main`, an item committed only on some other branch, a
race between the gate and this checkout, and any future drift between the ref
`worktree add` uses on the line above and the one the gate defaults to.

What it prevents is not a crash. A session dropped into a worktree with no
item file does not fail — `backlog.mjs show` exits `1` there, the session
reads that as a lookup problem, searches, finds the one copy that does exist
in the main tree, and works *that* one: the branch ends up carrying code with
no lifecycle move on it, the item gets archived as a loose uncommitted change
in somebody else's tree, and every stage of this run reports success.

Then keep the new directory out of everybody's `git status`, idempotently:

```bash
EXCLUDE="$(git rev-parse --git-common-dir)/info/exclude"
grep -qxF '.worktrees/' "$EXCLUDE" 2>/dev/null || printf '.worktrees/\n' >> "$EXCLUDE"
```

Run that from the project root (the path `git rev-parse` prints is relative
to cwd). Three details in those two lines, all load-bearing:

- **`--git-common-dir`, and the check-before-append.** `info/exclude` lives in
  the repository's *shared common* git directory — it is one file for the
  repo and every worktree of it, not one per worktree. Appending blindly on
  each item would grow duplicate lines in a file the user owns, and change
  `git status` output repo-wide, including in their main tree.
- **`grep -qxF`** — whole line (`-x`), fixed string (`-F`). A substring or
  regex match would either miss an existing entry or match an unrelated one
  and skip an append that was actually needed.
- **`info/exclude`, never `.gitignore`.** `.gitignore` is tracked: editing it
  would be an uncommitted change in the user's repo at best, and a stray
  commit riding a merge into `main` at worst. `info/exclude` is local,
  untracked, and reversible by deleting a line.

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
CLI refuses the stream-json format without it — verified on this machine
rather than assumed:

```
$ printf '' | claude -p --output-format stream-json --input-format stream-json
Error: When using --print, --output-format=stream-json requires --verbose
```

In `-p` mode `--verbose` is what *produces* the event stream at all, so this
is one flag doing the job of both. Leaving it off is the quietest failure in
this whole file, and it fires on the first item of the first run: the shell
redirect creates the `.jsonl` before `claude` is even exec'd, so `watch`'s
missing-file check never fires; the error goes to the `.err` that nothing on
this path reads; the process is gone inside a second, so `watch` returns `0`
("the child is gone"); no `system`/`init` event ever lands, so the session id
stays null. Step 5 then reads exactly the shape it calls a crashed session,
parks the item, and moves on — for every item in the queue. The run merges
nothing and reports that the sessions kept dying.

**Why `--permission-mode auto`, and not the rung above it.** This is the
design's most load-bearing trade, and it is stated out loud rather than
buried. What makes running an unattended session tolerable at all is not
trust in the session, it is the four walls around it: the session can only
write inside a **disposable worktree** created seconds ago from `main`; its
output faces an **independent review** before anything moves; it faces
**verification commands** that must come back green; and the **merge is the
only door back to `main`**, walked by this skill, never by the session.
Remove any one of those four and dispatching unattended stops being
defensible at any rung.

Those four walls are what the run is safe *because of* — they were never an
argument for reaching the top of the ladder specifically, and `auto` already
clears an execute session's entire real workload. Measured on this machine
against CLI 2.1.250: of twelve probed actions under headless `auto`, eleven
ran unprompted — `pnpm test`, arbitrary `node`, `git commit`, `git reset
--hard`, `git push --force`, recursive deletes, writes outside the cwd — and
exactly one was denied: uploading a local file's contents to an external
host, a class `backlog-execute` has no business performing. `acceptEdits`,
the rung below, is genuinely not enough (arbitrary `pnpm test` and `git`
still prompt there), so this is the lowest rung that works, not the mildest
one available.

**A denial is silent in every signal but one.** There is no hang to fear
here — a refused call comes back as an ordinary `tool_result` with
`is_error: true`, the session reads it and improvises around it. That is the
actual hazard, and it is quieter than a hang: the run's final result event
still reports `subtype: "success"` and `is_error: false`, and the process
still exits `0`, **even when every tool call in the session was refused**.
The one machine-readable trace is `permission_denials` on that same result
event, which is why step 5 reads it before it judges anything else (see
Inspect). Read the eleven-of-twelve above as what `auto` typically permits,
never as a contract: the boundary is a classifier's judgment weighing cwd and
context, not a fixed list, so the same mode name can return different
verdicts on different days. The design has to tolerate a denial happening,
which is exactly what that check is for.

**Do not "tighten" this to `dontAsk` plus `--allowedTools`.** It was probed,
and it is dead on arrival: under `--permission-mode dontAsk` with no
allowlist, `pnpm test` was refused outright — *"Permission to use Bash has
been denied because Claude Code is running in don't ask mode"* — and the run
still finished `subtype: "success"`. Making it work means enumerating every
command the session will ever need before the work starts, which is the one
thing a session doing unenumerated work cannot have. Tighter is not better
when the tightening has to be guessed ahead of the work.

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
nohup sh -c 'node "$1/skills/backlog-orchestrate/tools/orchestrate.mjs" verify <id> --cwd "$PWD/.worktrees/<id>" > "<dir>/verify/<id>.out" 2>&1; echo $? > "<dir>/verify/<id>.status"' sh "$CLAUDE_PLUGIN_ROOT" > /dev/null 2>&1 &
echo $! > "<dir>/verify/<id>.pid"
```

**All four lines in one Bash call**, and the `rm -f` in particular must never
be skipped or split off — see the first detail below for what it is actually
preventing.

**Detached, for the same reason the session in step 4 is.** A project's whole
baseline suite is the one step in this loop with no upper bound — `pnpm test`
plus a typecheck plus a build is minutes on a small repo and much more on a
large one — and a Bash call cannot outlive ten minutes even with its timeout
at the maximum. Run inline, a suite that outruns the call is killed
mid-flight, and `verify` has then written nothing and returned no exit code
this section has a branch for: an undefined state at the merge gate, in an
unattended loop, which is the one place this design cannot afford one.
Detached, the ceiling stops applying to the suite and applies only to the
polling, which is built to be re-called.

Four details in those lines, none of them the same as step 4's:

- **`rm -f` first, and it is a merge-gate rule rather than housekeeping.**
  `<dir>` belongs to the *run*, not to the attempt: nothing removes these
  three files afterwards, and `finish` does not clean `<dir>` at all — so a
  second attempt on the same item would inherit the first attempt's
  `.status` verbatim. Both "the verification did not finish" branches at the
  end of this section are predicated on that file being **absent**, so from
  the second attempt onward neither of them could fire. The failure that
  produces is precise, and it is the worst one this file can produce:
  attempt one passes and writes `0`; attempt two is killed mid-suite and
  writes nothing; the probe reads the stale `0`; this section says *merge*.
  A green merge gate on a verification that never finished — the one thing
  this whole design exists to make impossible. And it is reachable
  unattended without anybody doing anything unusual: §9 parks an item
  *after* a green verify when the main tree is not on `main` or the merge
  conflicts, the item stays open with its branch, and the next run resumes
  it at Inspect — where its verify is the second attempt. `.out` and `.pid`
  are cleared on the same rule: a stale `.pid` would be polled as though it
  were this attempt's child (and pids are recycled), and a stale `.out`
  would satisfy `watch`'s missing-file check for a run that never started.
  If you ever find yourself reading a `.status` you did not clear moments
  earlier in the same call, it is not this attempt's answer — treat it as
  absent and start the block again. (Step 4 needs no equivalent line because
  its transcripts are already scoped per attempt — `<id>.jsonl`, then
  `<id>-retry-1.jsonl` — and because nothing there is read as a gate.)
- **No `exec`, unlike the dispatch line.** The pid recorded here is
  deliberately the wrapper `sh`, because the wrapper is what outlives `node`
  long enough to write `.status`. `exec` would replace it and the exit code —
  the one thing this whole step exists to produce — would be lost.
- **`$1`, not `$CLAUDE_PLUGIN_ROOT`, inside the quotes.** The quotes have to
  stay single so `$?` reaches the inner shell instead of being expanded by
  this one, and passing the plugin root as a positional argument keeps the
  path correct whether or not that variable is exported into a child. `$PWD`
  needs no such care — every shell sets it, which is why step 4's line can
  use it directly.
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

Otherwise merge:

```bash
git -C "$PWD" merge --no-ff --no-edit backlog/<id>
```

`--no-ff` so every item is one identifiable merge commit in `main`'s history
even when it could have fast-forwarded; `--no-edit` so no editor opens in a
session that has no terminal to open one in. A dirty main tree is fine as
long as the dirt does not overlap the branch's paths — which is why the
pre-flight amendment rule above insists the item file is only ever edited
inside the worktree.

**On conflict:**

```bash
git -C "$PWD" merge --abort
```

then `attention <id> --kind parked --detail "merge conflict with main — worktree and branch kept"`, `stage <id> parked`, keep the worktree and the
branch exactly as they are, and continue with the next item. A conflict means
`main` moved under the run (the user pushed, or an earlier item in this same
run touched the same lines); resolving it is a human's judgement call, and
the branch is the thing that makes that possible later.

**Undoing a merge that already completed is `git revert -m 1 <merge-sha>`,
never `git reset --hard`.** This was proved empirically before this skill was
written: `reset --hard` resets the working tree and index in full, and it
silently discarded an *unrelated, uncommitted* modification in the main tree
along with the merge — with no reflog recovery, because that modification was
never staged or committed. The same scenario undone with
`git revert -m 1 --no-edit <merge-sha>` left the unrelated modification
byte-for-byte intact. An unattended run can never rule out that the user has
uncommitted work sitting in their main tree, so the noisier history a revert
commit leaves behind is the price, knowingly paid, of never destroying
something nobody backed up. `-m 1` names the first parent — `main` as it was
before this merge — which is what "undo the branch I just merged" means.

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

### `--resume`

Start from what is actually on disk, not from what the run file hoped:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" reconcile
```

Read-only — it never writes the run file; deciding what to do is this skill's
job. For every item still in the pipeline it prints what it found and one of
four suggestions:

```
task-3  stage=dispatched  worktree=true  branch=true  marker=true  session=a1b2…  -> resume-session
```

- **`resume-session`** — worktree present, the item file still carries an
  in-progress `phase:` marker, and a session id is known. Resume that session
  in place with **step 5's retry line unchanged** — every flag it carries,
  `--verbose` among them, since a `claude -p --output-format stream-json`
  without it exits in under a second and this path would read that as another
  crash — then re-enter the loop at Inspect.
- **`redispatch-after-stop`** — same, but no session id was ever recorded, so
  there is nothing to resume. **Clear the dead marker first**, and this is the
  one command in this skill that runs with the worktree as its cwd, because
  the item file it edits is the worktree's copy:

  ```bash
  ( cd "$PWD/.worktrees/<id>" && node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id> )
  ```

  The subshell is mandatory, not tidiness — see "Where commands run" at the
  top: a bare `cd` would leave this session sitting in the worktree, and every
  later `orchestrate.mjs` call would resolve the project to the wrong place.

  A plain `stop`, deliberately — and it is worth being straight about the
  trade, because `backlog-groom` prescribes the opposite for a marker that
  looks exactly like this one. Groom's rule is that a stamp left behind by a
  crash, a `/clear`, or a weekend gets `stop --abandon`, because billing that
  dead stretch into the elapsed counter fabricates grooming nobody did. Here
  the ruling goes the other way: this run launched that session itself, knows
  it was a real execute session doing real work, and the elapsed interval is
  the only record of it — so the time is billed, and `--abandon` is not used.
  The cost is real and worth knowing: a crash noticed hours later bills those
  idle hours into `execute-elapsed:` too, permanently, since the counter never
  resets. `start` refuses to stamp a file that already carries a marker, so
  the clear has to come before the fresh dispatch. Then dispatch again on the
  same worktree and branch, from the project root — **step 4's dispatch line
  unchanged**, `--verbose` included, for the reason `resume-session` above
  gives.
- **`inspect`** — either the worktree is gone but the branch survives, or the
  worktree is there with no marker at all (it may have finished cleanly just
  before the crash, or never started). Reconcile cannot tell those apart from
  outside; look, then re-enter the loop at the right step — often Commit or
  Review, because the work is already done and only the plumbing died.
- **`park`** — neither worktree nor branch survives. Nothing to resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "resume: worktree and branch both gone — nothing to take over"
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

  `--detail` is mandatory on every `attention` call — omitting it exits `1`
  with the usage line, and an attention row with no detail would be a
  drawer entry that says nothing anyway. Then let the next run pick the item
  up from the top.

### `--abort`

**Run `abort` first. Clear markers afterwards, and only for the items abort
names.** The order is the whole safety property of this section, so it comes
before the commands:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" abort
```

`abort` walks the queue, and for each item it asks one question of the disk:
does this item's worktree copy still carry an in-progress `phase:` marker?

- **No marker** → it tears the item down: `git worktree remove --force` on the
  worktree, `git branch -D` on the branch, best-effort (a worktree or branch
  git has never heard of just fails harmlessly — that is the state abort is
  trying to reach anyway).
- **Marker present** → it leaves that item **completely alone**, worktree
  *and* branch, and pushes an `attention` entry naming the absolute worktree
  path, the exact `backlog.mjs stop <id>` to run, and the exact
  `worktree remove` / `branch -D` commands to finish with afterwards.

Then it sets the run to `aborted` and prints a one-line summary of what it
removed and what it left.

**That marker is the signal, and clearing markers *before* `abort` destroys
it.** Run `backlog.mjs stop` on a mid-flight item first and abort now sees no
marker, classifies the item as safe, and `worktree remove --force`s a
directory whose session was still working: `--force` deletes the working
directory outright, uncommitted changes included, and because
`backlog-execute` never commits and the orchestrator had not got there yet,
there is no commit to `git revert` and no reflog entry to recover from. The
work is simply gone. That failure is the reason abort's preservation branch
exists at all, and doing the stops first is exactly how to reintroduce it. A
leftover directory is an annoyance a human clears in two commands; destroyed
uncommitted work has no recovery path.

So, after `abort` returns, read the attention list it wrote:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" status --json
```

For each preserved item, in this order:

1. Clear the marker where the item file actually lives — in a subshell, so
   this session's cwd stays at the project root:

   ```bash
   ( cd "$PWD/.worktrees/<id>" && node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id> )
   ```

   `orchestrate.mjs` cannot do this itself: item files have exactly one writer
   family — the backlog skills — and it is not one of them. That is why abort
   preserves rather than cleans, instead of clearing the marker and carrying
   on.
2. **Look inside the worktree before deleting it.** `git -C <worktree> status`
   and `git -C <worktree> diff`: a marker means a session was mid-flight, so
   whatever is uncommitted in there is the work nobody has seen. If any of it
   is worth keeping, commit it on the branch (step 6's shape) and tell the
   user the branch is there — an abort is allowed to end a run, it is not
   licensed to throw away code on the user's behalf.
3. Only then remove the leftovers:

   ```bash
   git -C "$PWD" worktree remove "$PWD/.worktrees/<id>"
   git -C "$PWD" branch -D backlog/<id>
   ```

   Plain `remove` again, for the reason it is plain everywhere else in this
   file: a refusal means something is still uncommitted in there, and this is
   the one path where that is *likely* rather than surprising. `-D` on the
   branch, unlike the merge path's `-d`: an aborted branch was never merged
   anywhere, so a safe delete would always refuse it.

Everything the run had already merged before the abort stays merged — abort
ends a run, it does not undo one.

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
