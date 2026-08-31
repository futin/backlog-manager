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

**Every `orchestrate.mjs` command runs with the project root as its cwd.
Never from inside a worktree this run created.** The tool resolves *which
project it is acting on* by walking up from its own cwd to the first `.git`
it finds. A linked worktree has its own `.git` (a file, not a directory), so
running the tool from inside one does not error — it silently keys the run
file under the worktree's path, a directory nothing else ever reads. The run
appears to vanish: the board shows nothing, `status` reports "no run exists",
and the state you thought you were writing is intact somewhere nobody looks.
A loud failure would be safer; this one is quiet, which is exactly why the
rule belongs here rather than in the tool.

Everything that genuinely concerns a worktree takes its path as an explicit
flag instead of implying it from cwd: `stage --worktree`, `verify --cwd`, and
plain `git -C <path>` for git. There is exactly one exception in this whole
skill, called out where it happens: `backlog.mjs stop` in the resume and abort
paths runs *inside* the worktree, because the item file it clears the marker
on is the worktree's own copy.

The tool's exit codes, which the rest of this file quotes constantly:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | bad args, an unknown item id, an unknown stage or kind, or missing required input — **nothing is ever written on a `1`** |
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

```bash
git -C "$PWD" worktree add .worktrees/<id> -b backlog/<id> main
```

The main working tree is never touched by this, and a dirty main tree does
not block it: the new worktree checks out `main`'s HEAD commit, not the
working copy. Creating a worktree on a *new* branch while `main` itself is
checked out in the main tree is legal — the branches differ, so nothing is
locked.

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
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> dispatched --worktree "$PWD/.worktrees/<id>" --branch backlog/<id>
```

Pass the worktree as an **absolute** path: `reconcile` and `abort` both test
it with a plain existence check from wherever they happen to be running, and
a relative path that resolves for one of them may not for the other.

### Dispatch the headless session

```bash
mkdir -p "<dir>/logs"
nohup sh -c 'cd "$PWD/.worktrees/<id>" && exec claude -p "/backlog-execute <id>" --output-format stream-json --dangerously-skip-permissions' > "<dir>/logs/<id>.jsonl" 2> "<dir>/logs/<id>.err" &
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
middle of the transcript. (If your `claude` refuses this flag combination,
add `--verbose` — the only thing that matters downstream is that the
transcript's `system`/`init` event lands in the `.jsonl`.)

**Why `--dangerously-skip-permissions` is acceptable here, and only here.**
This is the design's most load-bearing trade, and it is stated out loud
rather than buried: a headless session cannot answer a permission prompt, so
a prompt inside one is a hang — an unattended run that stops forever with
nobody to unstick it. What makes skipping them tolerable is not trust in the
session, it is the four walls around it: the session can only write inside a
**disposable worktree** created seconds ago from `main`; its output faces an
**independent review** before anything moves; it faces **verification
commands** that must come back green; and the **merge is the only door back
to `main`**, walked by this skill, never by the session. Remove any one of
those four and this flag stops being defensible. Never pass it to anything
running in the main tree, and never carry it into a skill that has no merge
gate behind it.

### Watch until it exits

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" watch <id> --pid "$(cat '<dir>/logs/<id>.pid')" --jsonl "<dir>/logs/<id>.jsonl"
```

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

Look at the item file **in the worktree**, not in the main tree — the main
tree's copy has not changed and will not until the merge, which is exactly
what the board shows and exactly what the run strip exists to compensate for.

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
nohup sh -c 'cd "$PWD/.worktrees/<id>" && exec claude -p --resume <sessionId> "<what to do differently>" --output-format stream-json --dangerously-skip-permissions' > "<dir>/logs/<id>-retry-1.jsonl" 2> "<dir>/logs/<id>-retry-1.err" &
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
- **`verdict: fix`** → one fix loop: `stage <id> fixing`, resume the item's
  own executor session with the findings pasted in verbatim (the same
  `claude -p --resume <sessionId>` shape as the retry above), `watch` it out
  as in step 4, commit again (step 6), then review again with a fresh report
  path (`<dir>/reviews/<id>-2.md`). Paste the findings as the reviewer wrote
  them — they name `file:line`, and paraphrasing them into "fix the review
  comments" hands the session a puzzle instead of a task.

**At most two fix loops per item.** After the second `fix` verdict, stop
looping and hand it to a human:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind fix-exhausted --detail "2 fix loops, still: <verdict summary> — report at <dir>/reviews/<id>-2.md"
```

Then, **with a channel**, ask: merge anyway, keep fixing, skip, or stop the
run — their call, on their repo. **With no channel**, `stage <id> parked` and
continue to the next item, keeping the branch and worktree for them to look
at. Never merge unreviewed-through changes silently just because the loop ran
out: "merge anyway" is a decision a person makes, not a default.

## 8. Verify

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> verifying
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" verify <id> --cwd "$PWD/.worktrees/<id>"
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

- **exit `0`** — every command passed. Merge.
- **exit `1`** — something is red. Treat the failing rows exactly like review
  findings: feed them into a fix loop (same two-loop ceiling, shared with
  review — an item does not get two review loops *and* two verify loops).
  Never merge red. Nothing green-lights a merge except the commands passing.
- **exit `5`** — nothing resolvable to verify with: no `verify.json`, no
  `test`/`typecheck`/`build` script, no fenced `## Done when` command. Nothing
  was written, and this item cannot prove itself. **Park it**:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "nothing to verify with — add backlog/verify.json or a ## Done when block"
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

  Annoying on an unconfigured repo, and correct anyway: "merged, verified by
  nothing" is the false-done this entire system exists to prevent.

## 9. Merge — the only door to `main`

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> merging
git -C "$PWD" symbolic-ref HEAD
```

**Precondition: the main tree must actually have `main` checked out** — that
command must print `refs/heads/main`. If it prints anything else (the user
switched branches mid-run, or is mid-rebase), do **not** check out `main`
yourself: their working tree is theirs, and this run's authority stops at its
own worktrees. Park instead and continue:

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
never merged, and forcing would delete it with no undo. Read what is there,
and park the item with an `attention` entry rather than forcing. Likewise
`branch -d` (safe delete) rather than `-D`: it only succeeds for a branch
that is actually merged, so a refusal here is real information — the merge
you think happened did not.

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

Long steps in between deserve a heartbeat. `watch` stamps one every interval,
but review, verify and merge can each outlast the fifteen-minute freshness
threshold on their own, and a run whose heartbeat goes stale reads to the
board (and to a later `init`) as crashed:

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
  in place (`claude -p --resume <sessionId>`, as in step 5) and re-enter the
  loop at Inspect.
- **`redispatch-after-stop`** — same, but no session id was ever recorded, so
  there is nothing to resume. **Clear the dead marker first**, and this is the
  one command in this skill that runs with the worktree as its cwd, because
  the item file it edits is the worktree's copy:

  ```bash
  cd "$PWD/.worktrees/<id>"
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id>
  ```

  A plain `stop` — it bills the elapsed interval into `execute-elapsed:` and
  clears `started:`/`phase:`, which is the tool's own job and not this
  skill's to second-guess. (`stop --abandon` exists for a marker nobody was
  ever behind; here a real execute session genuinely ran, and under-reporting
  that is the worse error of the two.) `start` refuses to stamp a file that
  already carries a marker, so the clear has to come before the fresh
  dispatch. Then dispatch again on the same worktree and branch, from the
  project root.
- **`inspect`** — either the worktree is gone but the branch survives, or the
  worktree is there with no marker at all (it may have finished cleanly just
  before the crash, or never started). Reconcile cannot tell those apart from
  outside; look, then re-enter the loop at the right step — often Commit or
  Review, because the work is already done and only the plumbing died.
- **`park`** — neither worktree nor branch survives. Nothing to resume:
  `attention <id> --kind parked` and `stage <id> parked`, and let the next run
  pick the item up from the top.

### `--abort`

Clear markers first, then tear down — in that order, because the tool
deliberately will not do the first part for you:

1. `reconcile --json` and note every item reporting `marker=true`.
2. For each, `cd` into its worktree and run
   `node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" stop <id>`.
   Item files have exactly one writer family — the backlog skills — and
   `orchestrate.mjs` is not one of them, so it cannot clear a marker itself.
3. From the project root:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" abort
   ```

   It removes every other item's worktree and branch (best-effort — already
   gone is fine), sets the run to `aborted`, and prints a one-line summary of
   what it removed and what it left.

**`abort` does not clean everything, by design.** Any item whose worktree
copy still carries an in-progress `phase:` marker is left completely alone —
worktree *and* branch — and gets an `attention` entry naming the exact
`backlog.mjs stop` command and the exact paths. That is deliberate:
`git worktree remove --force` deletes uncommitted work with no undo and
nothing to `git revert`, and a live marker is the strongest available signal
that a session was mid-flight with work not yet committed. A leftover
directory is an annoyance; destroyed uncommitted work has no recovery path.

So after `abort` returns, read `status --json`'s attention list. For each
preserved item: run the `backlog.mjs stop <id>` it names (inside that
worktree), check whether anything in there is worth keeping, and only then
remove the leftovers by hand:

```bash
git -C "$PWD" worktree remove "$PWD/.worktrees/<id>"
git -C "$PWD" branch -D backlog/<id>
```

`-D` here, unlike the merge path's `-d`: an aborted branch was never merged
anywhere, so a safe delete would always refuse it. Everything the run had
already merged before the abort stays merged — abort ends a run, it does not
undo one.

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
