# backlog-orchestrate — recovery: `--resume` and `--abort`

Read this file **in full** before running either path, and before any other
command. It is the whole of what `/backlog-orchestrate --resume` and
`/backlog-orchestrate --abort` do; the skill body carries only a pointer to it
and the two rules most expensive to get wrong.

Section and step numbers below name sections of `SKILL.md` — "step 4" is its
dispatch line, "step 5" is Inspect, "step 6" is Commit.

### `--resume`

Read `mergeModeEffective` out of `status --json` first: a run downgraded to
branch mode before the crash stays downgraded, and §9 then takes its branch
path for every remaining item.

Then, before reconcile, before Inspect, before anything else this file
describes, close the gap the board's watchdog is timing:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" status
```

`status` has three outcomes here, not two.

**`running`** — claim the run immediately, before doing anything else:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" claim
```

`claim` *is* the heartbeat this step used to stamp — it writes `updatedAt`
from the same clock reading — and it also records that **this** session is the
one driving the run. Do not follow it with a separate `heartbeat`.

If `claim` exits non-zero, **another session has taken this run over. Stop
immediately: write nothing, and exit.** The same is true of a refusal from any
later `heartbeat`, `stage`, `attention`, `merge-mode`, `verify`, `watch` or
`finish` in this run: exit `7` means a different session claimed the run after
you did, so it — not you — is the one carrying the queue forward. (`unpause`
and `abort` are the two commands that TAKE the lease rather than checking it,
for reasons this file gives at each of them; every other write checks it.) Two sessions
past this point both stage-write one `run.json` and both end in a merge to
`main`; that is the failure the lease exists to make impossible, and it only
works if the loser stops on the first refusal instead of retrying.

**`paused`** — this run was not crashed, it was stopped on purpose at an item
boundary (SKILL.md §10, *Pausing*). Put it back to `running` first:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" unpause
```

The run is `running` again from this instant, and the request that paused it
is retired by that same stamp — so the first `stage <id> preflight` of the
rest of the queue will not exit `6` all over again. No separate heartbeat is
needed: `unpause` writes `updatedAt` itself, and it takes the driver lease in
that same write: a paused run carries the lease of whichever session paused it
and then exited, and this is a different session. Then `claim` the run exactly
as the `running` path above does — it is a no-op re-claim by the session that
already holds it, and running it keeps this branch identical to the other one —
and continue, `reconcile` next.

**Anything else** — `done`, `aborted`, `failed` — is not this path's to
touch. Refuse and say which.

`status` runs first for exactly that reason, and it is the guard, not a
formality: a finished run is not this step's to re-stamp, and `status` is
what tells the difference before `claim` ever touches the file. On a
`running` run, though, this one call is what turns a crashed strip back into
a live one — the board's watchdog stands down the instant the run file reads
fresh, so a heartbeat stamped here cancels a second spawn that grace alone
would only delay, it does not merely postpone it. It also shrinks the
window in which a human's resume and the watchdog's own resume can land on
the same crashed run at once: on the incident's own resume
(`run-20260903-112622`), the session spawned at 18:57:44 and did not reach
its first heartbeat until 18:59:11 — about ninety seconds in which the run
file still read stale. Stamping one here, before reconcile or any
inspection, shrinks that window to the few seconds `status` and `claim`
themselves take.

Shrinking is not closing, which is why `claim` records a driver rather than
only re-stamping the clock (bug-19). Two resumes that both land inside those
few seconds both see a stale run and both proceed; the lease is what decides
between them afterwards, deterministically and without either of them having
to coordinate with the other. The later `claim` wins — that is the one place
in this system where last-writer-wins is the mechanism rather than the hazard,
because exactly one claim survives the write and every subsequent write is
checked against it. The loser finds out on its very next command, and its
whole job then is to stop.

Then re-derive the runner-fix switch, before the first item is taken over.
A run that picked up its own merged fix (§9, "After a runner-fix item lands")
switched to following this repo's copy of `SKILL.md` and `orchestrate.mjs`
for the rest of the run — but that switch is *session* state, and this is a
fresh session, handed the installed copy again exactly as the crashed one
was. Nothing on disk carries the switch itself; the note does. So read the
queue and look for any item staged `merged` or `branched` whose note says the
remainder of the run follows the repo copy:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" status --json
```

If one is there, take the switch again — **both halves or neither**, per §9:
re-read `skills/backlog-orchestrate/SKILL.md` from this repo's working tree
and invoke the repo's `orchestrate.mjs` for the rest of this run. If none is,
change nothing. Doing this here rather than later matters because the whole
value of the marker is that the *remaining* queue is not executed by the
broken version, and a crash is most likely at precisely the moment the runner
is broken.

Then start from what is actually on disk, not from what the run file hoped —
and what is on disk is still exactly where the crashed session left it. `init`
refuses any run whose status still reads `running`, fresh or stale, with exit
`4`, and archiving a run's sidecars is something only `init` ever does. So no
later run can sweep this run's `<dir>/logs`, `<dir>/reviews`, `<dir>/verify`
or `<dir>/questions` into `<dir>/runs/<runId>/` while a resume is still owed
one — the exit-`4` lock is what makes it safe for that sweep to move a live
child's `logs/<id>.pid` or `verify/<id>.pid` at all, because by the time it
can run, no live child exists. The flat paths below are the same paths the
crashed session wrote to.

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
  idle hours into `execute-elapsed:` too — and whatever tokens fell inside that
  window into `execute-tokens:` — permanently, since neither counter resets. `start` refuses to stamp a file that already carries a marker, so
  the clear has to come before the fresh dispatch. Then dispatch again on the
  same worktree and branch, from the project root — **step 4's dispatch line
  unchanged**, `--verbose` included, for the reason `resume-session` above
  gives.
- **`inspect`** — either the worktree is gone but the branch survives, or the
  worktree is there with no marker at all (it may have finished cleanly just
  before the crash, or never started). Reconcile cannot tell those apart from
  outside; look, then re-enter the loop at the right step — often Commit or
  Review, because the work is already done and only the plumbing died.

  An `inspect` on an item whose **stage is `preflight`**, worktree present, no
  marker, is a paused run's dispatch-gate leftover: SKILL.md §4's exit `6`
  lands exactly there, with the worktree built and the pre-flight answer
  possibly written into it, and nothing dispatched. Re-enter §4 at "record the
  worktree on the run" — `stage <id> dispatched --worktree … --branch …` onto
  the existing pair — and dispatch. Not a leftover to ask about, and not a
  worktree to unwind: the pre-flight answer in it is the reason it was kept.
- **`park`** — neither worktree nor branch survives. Nothing to resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "resume: worktree and branch both gone — nothing to take over"
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

  `--detail` is mandatory on every `attention` call — omitting it exits `1`
  with the usage line, and an attention row with no detail would be a
  drawer entry that says nothing anyway. Then let the next run pick the item
  up from the top.

**Then pick up the usage the crashed driver never recorded.** SKILL.md §5
stamps what each dispatched session cost onto its queue item, and a run that
died between a session finishing and that call landing has the number sitting
in `logs/` with nothing pointing at it — and the logs are pruned long before
the run history is. Compare `status --json`'s `usage` array on each item
against the transcripts actually on disk, and run it for any that is missing:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" usage <id> --jsonl "<dir>/logs/<id>.jsonl"
```

One entry per transcript — `<id>.jsonl`, each `<id>-retry-<n>.jsonl`, each
`<id>-fix-<n>.jsonl` — and re-running it over one already recorded is
harmless: an entry's identity is the transcript slot, so a second call
replaces that slot rather than doubling it. Being unsure whether the crashed
driver got to it is therefore not a reason to skip it. A transcript whose
session was killed mid-flight has no result event, and that call writes
nothing and exits `0` saying so; that is the honest record, not a failure to
chase.

### `--abort`

**Run `abort` first. Clear markers afterwards, and only for the items abort
names.** The order is the whole safety property of this section, so it comes
before the commands:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" abort
```

No `claim` before it, deliberately: `abort` takes the run over itself, as its
first write. A crashed run's driver lease belongs to the session that died, and
abort is the command whose whole premise is that that session is gone — so the
lease may not be allowed to refuse it (a refused abort leaves the run `running`
forever, and `init` refuses a `running` run file with exit `4`, which locks the
project out of the orchestrator entirely). The one thing abort still refuses is
a run that is `running`, FRESH and led by another session, which is not a
crashed run at all but a live one somebody else is driving: pause it from the
board first — a pause needs no lease — and abort the paused run.

`abort` walks the queue, and for each item it asks one question of the disk:
does this item's worktree copy still carry an in-progress `phase:` marker?

- **No marker** → it tears the item down: `git worktree remove --force` on the
  worktree, `git branch -D` on the branch, best-effort (a worktree or branch
  git has never heard of just fails harmlessly — that is the state abort is
  trying to reach anyway).
- **No marker, but the item finished `branched`** → the worktree still goes,
  and the **branch is kept**. Under branch mode that branch was never merged
  into anything, so it is the only copy of that item's work; `-D` would force
  past git's "not fully merged" check and leave nothing to recover from. Abort
  records the kept branch in `attention` — it needs no action, it is simply
  waiting to be merged by hand. A `merged` item is the opposite case and keeps
  today's behaviour: the run already deleted that branch at the merge, so the
  `-D` is a harmless no-op.
- **Marker present** → it leaves that item **completely alone**, worktree
  *and* branch, and pushes an `attention` entry naming the absolute worktree
  path, the exact `backlog.mjs stop <id>` to run, and the exact
  `worktree remove` / `branch -D` commands to finish with afterwards.

Then it sets the run to `aborted` and prints a one-line summary of three
counts: what it removed, how many branches it kept because their items were
`branched`, and what it left in place with a marker.

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
   anywhere, so a safe delete would always refuse it. These are the *preserved*
   items only — never run `-D` on a branch abort reported as **kept**, which is
   a finished `branched` item's whole deliverable.

Everything the run had already merged before the abort stays merged — abort
ends a run, it does not undo one.
