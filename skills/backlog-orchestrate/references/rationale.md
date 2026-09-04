# backlog-orchestrate — why the rules are what they are

Every rule in `SKILL.md` still states itself there, in full, as a rule. What
lives here is the *evidence*: the run that broke, the command that was measured,
the failure that was watched happening. None of it changes what you type.

Read a section of this file when you are about to argue with the rule it
explains — when a rule looks like overcaution, or like something a tidier edit
could simplify away. Every one of these was written after the failure, not
before it.

Headings match the section of `SKILL.md` the rule lives in.

---

## Where commands run

**The run that appeared to vanish.** The tool resolves *which project it is
acting on* by walking up from its own cwd to the first `.git` it finds. A linked
worktree has its own `.git` (a file, not a directory), so a worktree cwd used to
resolve to the worktree itself and key the run file under a directory nothing
else ever reads. `status` then reported "no run exists" for a run that was very
much alive.

Since bug-2 the tool refuses that outright rather than resolving it. The failure
is loud now, but the rule is unchanged and still yours to keep — a refusal
mid-run is still a run that stopped.

**The scope is wider than the `cd`s this file prescribes.** *Anything* that
leaves the shell inside a worktree arms it. The run that surfaced this was
broken by a one-off `pnpm exec jest --version` probe — not by any command the
skill told anyone to run.

**Why a bare `cd` was worse than it looked, before the refusal existed.**
`watch` exited `3`, which §4 documents as "still running, call me again"; §4
duly told the session to call `watch` again as many times as it takes; and the
run looped until somebody killed it. The exit code that means "no run exists"
and the exit code that means "call me again" are the same `3`, which is
survivable everywhere except here.

---

## §4 — Dispatch the headless session

### Why `--verbose` is required rather than advisable

With `--print`, the installed CLI refuses the stream-json format without it —
verified on this machine rather than assumed:

```
$ printf '' | claude -p --output-format stream-json --input-format stream-json
Error: When using --print, --output-format=stream-json requires --verbose
```

In `-p` mode `--verbose` is also what *produces* the event stream at all, so the
one flag does both jobs.

Leaving it off is the quietest failure in the whole skill, and it fires on the
first item of the first run. The shell redirect creates the `.jsonl` before
`claude` is even exec'd, so `watch`'s missing-file check never fires. The error
goes to the `.err` that nothing on this path reads. The process is gone inside a
second, so `watch` returns `0` — "the child is gone". No `system`/`init` event
ever lands, so the session id stays null. Step 5 then reads exactly the shape it
calls a crashed session, parks the item, and moves on — for every item in the
queue. The run merges nothing and reports that the sessions kept dying.

### Why `--permission-mode auto`, and not the rung above it

What makes running an unattended session tolerable is not trust in the session,
it is the four walls around it: the session can only write inside a
**disposable worktree** created seconds ago from `main`; its output faces an
**independent review** before anything moves; it faces **verification commands**
that must come back green; and the **merge is the only door back to `main`**,
walked by this skill, never by the session. Remove any one of those four and
dispatching unattended stops being defensible at any rung.

Those four walls are what the run is safe *because of*. They were never an
argument for reaching the top of the ladder specifically, and `auto` already
clears an execute session's entire real workload. Measured on this machine
against CLI 2.1.250: of twelve probed actions under headless `auto`, eleven ran
unprompted — `pnpm test`, arbitrary `node`, `git commit`, `git reset --hard`,
`git push --force`, recursive deletes, writes outside the cwd — and exactly one
was denied: uploading a local file's contents to an external host, a class
`backlog-execute` has no business performing.

`acceptEdits`, the rung below, is genuinely not enough — arbitrary `pnpm test`
and `git` still prompt there — so `auto` is the lowest rung that works, not the
mildest one available.

Read the eleven-of-twelve as what `auto` typically permits, never as a contract.
The boundary is a classifier's judgment weighing cwd and context, not a fixed
list, so the same mode name can return different verdicts on different days. The
design has to tolerate a denial happening, which is what the denials check
exists for.

### Why a denial is silent in every signal but one

There is no hang to fear. A refused call comes back as an ordinary `tool_result`
with `is_error: true`, and the session reads it and improvises around it. That
is the actual hazard, and it is quieter than a hang: the run's final result
event still reports `subtype: "success"` and `is_error: false`, and the process
still exits `0` — **even when every tool call in the session was refused**. The
one machine-readable trace is `permission_denials` on that same result event,
which is why step 5 reads it before it judges anything else.

### Why "tighten it to `dontAsk` plus an allowlist" is dead on arrival

It was probed. Under `--permission-mode dontAsk` with no allowlist, `pnpm test`
was refused outright — *"Permission to use Bash has been denied because Claude
Code is running in don't ask mode"* — and the run still finished
`subtype: "success"`. Making it work means enumerating every command the session
will ever need before the work starts, which is the one thing a session doing
unenumerated work cannot have. Tighter is not better when the tightening has to
be guessed ahead of the work.

---

## §8 — Verify

### Why the verification is detached rather than run inline

A project's whole baseline suite is the one step in this loop with no upper
bound — `pnpm test` plus a typecheck plus a build is minutes on a small repo and
much more on a large one — and a Bash call cannot outlive ten minutes even with
its timeout at the maximum. Run inline, a suite that outruns the call is killed
mid-flight, and `verify` has then written nothing and returned no exit code this
section has a branch for: an undefined state at the merge gate, in an unattended
loop, which is the one place this design cannot afford one. Detached, the
ceiling stops applying to the suite and applies only to the polling, which is
built to be re-called.

### Why `rm -f` is a merge-gate rule rather than housekeeping

`<dir>` belongs to the *run*, not to the attempt: nothing removes those three
files afterwards, and `finish` does not clean `<dir>` at all — so a second
attempt on the same item would inherit the first attempt's `.status` verbatim.
Both "the verification did not finish" branches are predicated on that file
being **absent**, so from the second attempt onward neither of them could fire.

The failure that produces is precise, and it is the worst one this skill can
produce: attempt one passes and writes `0`; attempt two is killed mid-suite and
writes nothing; the probe reads the stale `0`; the section says *merge*. A green
merge gate on a verification that never finished — the one thing this whole
design exists to make impossible.

It is reachable unattended without anybody doing anything unusual. §9 parks an
item *after* a green verify when the main tree is not on `main` or the merge
conflicts; the item stays open with its branch; the next run resumes it at
Inspect — where its verify is the second attempt.

`.out` and `.pid` are cleared on the same rule: a stale `.pid` would be polled
as though it were this attempt's child (and pids are recycled), and a stale
`.out` would satisfy `watch`'s missing-file check for a run that never started.

Step 4 needs no equivalent line because its transcripts are already scoped per
attempt — `<id>.jsonl`, then `<id>-retry-1.jsonl` — and because nothing there is
read as a gate.

### Why the launcher carries named env variables and never a positional

The quotes have to stay single so `$?` reaches the inner shell instead of being
expanded by the outer one, which rules out writing `$CLAUDE_PLUGIN_ROOT` in
there directly; `env` sets both names for the child without the outer shell
touching anything.

The obvious alternative — pass them positionally and read the first and second
arguments — is the one thing that must not be done, and the reason is not style.
**Slash-command argument substitution rewrites positional parameters in a
SKILL.md before the session ever reads it, fenced code included.** Invoked as
`/backlog-orchestrate bug-2 bug-3 …`, an earlier version of that very line
arrived in a live session as `node "bug-3/skills/…"`, with the bullet explaining
it rewritten to match, so it read as deliberate rather than corrupt. That
failure was loud by luck; a substitution producing a readable path would fail
silently, and this is the launcher the merge gate depends on.

`$PWD` needs none of this care — every shell sets it and no substitution pass
touches it, which is why step 4's line uses it directly.

---

## §9 — Merge

### Why undoing a completed merge is `git revert -m 1`, never `git reset --hard`

Proved empirically before this skill was written, not reasoned out.
`reset --hard` resets the working tree and index in full, and it silently
discarded an *unrelated, uncommitted* modification in the main tree along with
the merge it was meant to undo — with no reflog recovery, because that
modification had never been staged or committed. The identical scenario undone
with `git revert -m 1 --no-edit <merge-sha>` left that modification
byte-for-byte intact.

An unattended run can never rule out that the user has uncommitted work sitting
in their main tree, so the noisier history a revert commit leaves behind is the
price, knowingly paid, of never destroying something nobody backed up.

---

## §4 — Create the worktree

### What the post-checkout probe actually prevents

Not a crash. A session dropped into a worktree with no item file does not fail:
`backlog.mjs show` exits `1` there, the session reads that as a lookup problem,
searches, finds the one copy that *does* exist — in the main tree — and works
**that** one. The branch ends up carrying code with no lifecycle move on it, the
item gets archived as a loose uncommitted change in somebody else's tree, and
every stage of the run reports success.

§1's gate refuses an uncommitted item before a run ever starts, so on the
ordinary path the probe never fires. It is there because it catches strictly
more than the gate can: a project root the gate could not read as a git work
tree at all (it falls back to the working copy there, deliberately), a main tree
not actually on `main`, an item committed only on some other branch, a race
between the gate and the checkout, and any future drift between the ref
`worktree add` uses and the one the gate defaults to.

### Why `info/exclude`, `--git-common-dir`, and a check before the append

- **`--git-common-dir`, and the check-before-append.** `info/exclude` lives in
  the repository's *shared common* git directory — one file for the repo and
  every worktree of it, not one per worktree. Appending blindly on each item
  would grow duplicate lines in a file the user owns, and change `git status`
  output repo-wide, including in their main tree.
- **`grep -qxF`** — whole line (`-x`), fixed string (`-F`). A substring or regex
  match would either miss an existing entry or match an unrelated one and skip
  an append that was actually needed.
- **`info/exclude`, never `.gitignore`.** `.gitignore` is tracked: editing it
  would be an uncommitted change in the user's repo at best, and a stray commit
  riding a merge into `main` at worst. `info/exclude` is local, untracked, and
  reversible by deleting a line.

---

## §2 — Merge mode, and why the probe cannot promise anything

**The three runs.** On 2026-09-03 a `claude-agents-dashboard` run finished four
items — reviewed, `test` + `typecheck` + `build` green on all four — and merged
none of them. Every merge attempt came back:

```
Permission for this action was denied by the Claude Code auto mode
classifier. Reason: Blocked by classifier.
```

| Run | Project | `permissions.allow` present | Merge |
|---|---|---|---|
| 2026-09-01 18:57 | claude-agents-dashboard | none | allowed ×3 |
| 2026-09-03 11:26 | backlog-manager | none | allowed ×4 |
| 2026-09-03 18:49 | claude-agents-dashboard | none | **denied ×4** |

All three were board-spawned (`custom-title: "orchestrate <project>"`),
headless, `claude -p --permission-mode auto`, issuing the identical
`git -C "$PWD" merge --no-ff --no-edit backlog/<id>`. The dashboard's
`.claude/settings.json` carrying `Bash(git merge:*)` is dated 2026-09-03
22:34 — written *after* the failure, staged, never committed. **Nothing about
permissions differed between the runs that merged and the run that did not.**

The denied run's own notes diagnosed that missing `Bash(git merge:*)` rule.
It is a valid *remedy* and a wrong *explanation*: an `allow` rule takes the
classifier out of the path for matching commands, so it is worth having and
worth telling the user about, but it is not what differed between these three
runs. Auto mode is a per-call model classifier, and its verdict on an
identical command varies between runs.

Two things follow, and they are the whole of merge mode:

1. Merging is a **choice**, not the only outcome. A run that stops at four
   reviewed branches is a successful run.
2. A run that *wanted* to merge and was refused **degrades to that outcome**
   rather than parking work that is perfectly good.

**What the probe buys, and what it does not.** It cannot promise the merge —
the table above is the proof — so it is not a gate and a passing probe is not
permission. It converts a denial discovered at item four's merge, after four
hours of a run that merges nothing, into one discovered in ten seconds before
item one. That is all of it, and it is enough on its own.

**Why a denial is not a park, and not a fourth attention kind.**
`ATTENTION_KINDS` stays the closed set of three (`needs-answers`, `parked`,
`fix-exhausted`). The attention list means "a human must look at *this item*",
and a green, reviewed branch does not qualify — four green branches reported
as four parks is exactly what made 2026-09-03 read as a failed run. One
classifier verdict is one run-level fact and is recorded once, in
`mergeModeNote`; N per-item rows would be N copies of the same sentence in a
list whose whole meaning is per item.

---

## §2 — Why a stale `running` run refuses `init` exactly like a live one

A stale `running` run is not an idle lock. It is the last surviving record of a
run that died mid-item, with possibly a worktree on disk, a branch, and an item
file still carrying an in-progress marker that is billing time to nobody.
Deleting the run file to get past the refusal throws that record away — and with
it the only map back to what is still on disk.
