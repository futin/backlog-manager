# backlog-orchestrate — recovery: `--resume` and `--abort`

Read this file **in full** before running either path, and before any other
command. It is the whole of what `/backlog-orchestrate --resume` and
`/backlog-orchestrate --abort` do; the skill body carries only a pointer to it
and the two rules most expensive to get wrong.

Section and step numbers below name sections of `SKILL.md` — "step 4" is its
dispatch line, "step 5" is Inspect, "step 6" is Commit.

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
