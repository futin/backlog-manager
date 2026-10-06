# backlog-orchestrate — pausing and stopping a run

Read this file **in full** when a CLI call exits `6` (a pause was requested) or `10` (a stop was requested). `6` comes only from `stage <id> preflight` and
`stage <id> dispatched`; `10` from any `stage` transition and from `watch`. The trigger is the exit code, so a fresh run and a `--resume`d or unpaused one reach
it the same way — both are inside the loop when it arrives. **Neither code is retried, worked around or asked about:** `6` ends the run `paused`, at the item
boundary; `10` ends it with `abort`, abandoning the item in flight.

Section and step numbers below name sections of `SKILL.md`. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace
`${CLAUDE_PLUGIN_ROOT}` with the plugin root the body was loaded with before running any command here.

### Pausing

You are here because `stage <id> preflight` or `stage <id> dispatched` exited `6`. Nothing was written by that call. Finish the run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" finish --status paused
```

Then summarise exactly as `SKILL.md` §10's _Finishing_ does — what merged or branched, what parked and why, the branch list and its conflict pairs if any item finished
`branched` — **plus the items still pending, by name**. Those are what a resume will pick up, and naming them is the difference between a summary and a receipt.

Close with one sentence: the run resumes from the board's Resume control, on the strip or in the Runs view, or by `/backlog-orchestrate --resume` in a terminal
at the project root.

Then end the turn. Do not ping, do not ask whether to continue, do not wait: the board's own control is what asked for this pause, so the person who asked is
already looking at the surface that will restart it.

### Stopping

You are here because a command exited `10`. A person asked for this run to **end**, from the board's Stop control. Nothing was written by the call that
refused.

**Do not finish the queue, and do not retry anything.** This is the one difference from _Pausing_ above and it is the whole difference: a pause stops at the
next item boundary and leaves the item in flight to complete, a stop abandons it. Every `stage` transition now refuses with `10`, so there is no path forward
even if you tried.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" abort
```

Read `references/recovery.md`'s abort section first, as always — abort's order of operations is its entire safety property, and it is unchanged here. Five
things are worth knowing before you run it:

- **It will not be refused on a driver's lease.** `abort` takes the run over on the strength of the stop request itself, even from a driver the run file still
  reads as alive. That is what a stop is for: the run file's freshness measures the FILE, never the process. The one lease it respects is another abort's —
  see the last bullet.
- **It signals the children.** Any item still in flight is sent `SIGTERM` first, at whichever pid `resolveItemPid` answers with — `<dir>/logs/<id>.pid` if
  the launcher wrote one, else the pid the run file recorded (§4). It is deliberately not "a pid this run recorded": a stop landing in §4's window refuses
  the `--pid` call, so the run file's field can be null for a child that is very much alive, which is the whole of bug-43. What is signalled is still only a
  live process whose command line names `claude` — never a pattern, and never a pid that has not passed all three checks first.
- **It recovers the session id the same way.** The same stop never reaches `watch`, the only other reader of the child's init event, so an item whose run file
  still says `sessionId: null` gets it from `<dir>/logs/<id>.jsonl` (bug-52). A recorded id is never replaced, and a missing or init-less log leaves it null.
- **A worktree carrying an in-progress marker is still left in place**, with an `attention` entry naming it. A stop may abandon an item; it may not destroy
  uncommitted work.
- **An `abort` that exits `7` saying the run is already being aborted means another session is ending this run** (bug-54). The board's Stop also spawns an
  `--abort` session, so one stop always reaches a live run twice, and the tool lets exactly one of them tear anything down. Do **not** read, `git status` or
  otherwise inspect any worktree — the other abort is emptying it, and what you would see is its teardown, not the child's work. Report that session's id,
  from the refusal, and end the turn. An `abort` that prints `already aborted` and exits `0` is the same fact arriving late: nothing was done, end the turn.

Then summarise as `SKILL.md` §10's _Finishing_ does — what merged or branched, what was abandoned mid-flight and where its worktree is — and end the turn. Do not ping and do
not ask whether to continue: the person who stopped the run is already looking at the surface they stopped it from.
