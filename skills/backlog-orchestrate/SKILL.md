---
name: backlog-orchestrate
description: >
  Drain a project's groomed backlog unattended: every ready bug and task, one at a time, each in its own git worktree and its own headless backlog-execute
  session, then committed, reviewed, verified and merged into the run's base branch before the next item starts — main unless the run was told otherwise, so a
  whole phased feature can be drained onto a branch without main being written at all — or, told to leave branches instead, stopped at a reviewed git branch per
  item with nothing merged. Use it to drain the backlog, work the whole queue, run the backlog while I'm away, orchestrate tasks 3-7, drain the backlog onto
  feature/x, work the queue on a branch instead of main, drain the backlog but leave me branches to merge by hand, or to --resume or --abort a run that was
  interrupted. It is the only skill that commits or merges — execute
  still does the work, groom still writes the plans, and neither of them ever touches git. Trigger: /backlog-orchestrate
trigger: /backlog-orchestrate
---

# /backlog-orchestrate — drain the queue, one verified item at a time

Orchestrate is the loop around `backlog-execute`, and only the loop. For every groomed bug and task in a project's backlog it creates a worktree, runs one fresh
headless `backlog-execute` session inside it, commits what that session produced, has it reviewed, proves it with real commands, and merges it into the run's
**base branch** — then starts the next item from the updated base. The base is `main` unless the run was started with `--base <ref>`, and it is the one ref this
whole file turns on: items are gated at it, worktrees are cut from it, and merges land in it (section 2). Under `--merge-mode branch` a verified item stops at
its reviewed branch instead and nothing is merged anywhere (section 2). Execute keeps doing the work, groom keeps writing the plans, capture keeps filing new items.

Two things make this skill different from its three siblings, and both are worth having in mind before the first command runs:

- **It commits and merges.** No other backlog skill touches git at all; execute's "never commits, never pushes" hard limit is unchanged and still holds _inside_
  the sessions this skill spawns. The orchestrator is the committer, on `backlog/<id>` branches and on the run's base, by merge commit only.
- **It runs unattended.** The person who started it is usually not watching. So every rule below that looks paranoid — park rather than merge, ask best-effort
  rather than block, never `reset --hard` — is there because the failure it prevents would otherwise happen silently, hours after anyone could have caught it.

The trigger carries the whole invocation surface:
`/backlog-orchestrate [ids…] [--max N] [--base <ref>] [--merge-mode branch] [--question-mode decide] [--resume] [--abort]`.
Ids and `--max` shape the queue (section 1); `--base` names the branch this run gates at, cuts worktrees from and merges into, defaulting to `main`
(section 2); `--merge-mode` decides whether a verified item is merged into that base or stops at its reviewed branch (section 2);
`--question-mode` decides what happens to an item whose open questions nobody is there to answer — `park` (the default: record them, skip the item, keep
draining) or `decide` (answer them yourself, write the answers into the item, record what you assumed, and execute it), section 3; `--resume` takes over a run
that was interrupted and `--abort` ends one (section 10). With none of them, the run is every ready item in the project's backlog, in the board's own order,
merged into `main`, parking anything it cannot get an answer for.

The run's state lives in a machine-local run file, and `skills/backlog-orchestrate/tools/orchestrate.mjs` is its **only** writer — the same single-writer
discipline `backlog.mjs` keeps for the registry and for item files. This skill never edits that file by hand, and never writes item files either, except for one
narrow case in pre-flight (see below).

Reference files sit beside this one and are **not** loaded with it. Read them at the moment they apply, not up front:

- **`references/tracker.md`** — the tracker path: if the project's committed `backlog/source.json` says `github`, read it **in full** before §1 — or, on
  `--resume`, in `references/recovery.md`'s step after `claim` and before `reconcile`, since a resumed run never executes §1; a files project never opens it.
- **`references/recovery.md`** — the whole of `--resume` and `--abort`. Read it **in full** before running either, before any other command.
- **`references/rationale.md`** — the measurements and the failures behind the rules here. Read the matching section before arguing with a rule, or before
  simplifying one away.

Every command in this file names the plugin root as `${CLAUDE_PLUGIN_ROOT}`, and Claude Code filled that in with the installed copy's path when it loaded this
skill — no shell here sets the variable, so an unfilled one expands to nothing and every `node` line becomes `node "/skills/…"`. A file read by hand is never
filled in: every reference file, and a SKILL.md re-read from the repo after a runner fix (below), still carry the unfilled placeholder — the
name `CLAUDE_PLUGIN_ROOT` inside `${…}`. Replace it with `${CLAUDE_PLUGIN_ROOT}` before running the line — or, once a runner fix has switched this run to the
repo copy, with this repo's root.

## Where commands run, and why it is not negotiable

**This session's cwd must be the project root every time `orchestrate.mjs` is called — whatever put it somewhere else.** Never a worktree this run created. A
cwd inside a linked worktree (and a `--project` pointed at one) exits `1` with a message naming both the worktree and the project root to re-run from.

**The scope is wider than the `cd`s this file prescribes: _anything_ that leaves the shell inside a worktree arms it.** The refusal is loud, but a refusal
mid-run is still a run that stopped. (What it used to do instead, and the stray command that first triggered it, are in `references/rationale.md` under "Where
commands run".)

Everything that genuinely concerns a worktree takes its path as an explicit flag instead of implying it from cwd: `stage --worktree`, `verify --cwd`, and plain
`git -C <path>` for git. There are exactly two exceptions in this whole skill, both `backlog.mjs` rather than `orchestrate.mjs`, and both called out where they
happen: `backlog.mjs stop` in the resume and abort paths runs _inside_ the worktree, because the item file it clears the marker on is the worktree's own copy;
and §4's post-checkout probe runs `backlog.mjs show` inside the worktree for the same reason in reverse — asking _that_ tree, and only that tree, whether the
item is in it is the entire point of the call.

**That exception runs in a subshell — `( cd <worktree> && … )` — never a bare `cd`.** Still mandatory, and one instance of the wider rule above rather than its
whole extent. A bare `cd` persists as the session's working directory for every later command, and from there every `orchestrate.mjs` call refuses with exit `1`
until something changes back — an unattended run stops dead. The parentheses keep the move inside one child shell that exits with the command. The two
`sh -c 'cd … && exec claude …'` dispatch lines below are the same discipline by another spelling: `sh -c` is already its own process, so the `cd` inside it
never reaches this session.

The tool's exit codes, which the rest of this file quotes constantly:

| Code | Meaning                                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                                                            |
| `1`  | bad args, an unknown item id, an unknown stage or kind, missing required input, a cwd (or `--project`) inside a linked worktree, or `assume` on a `park`-mode run — **nothing is ever written on a `1`**                                                                           |
| `3`  | no run exists for this project — and, for `watch` only, "budget elapsed, child still alive"                                                                                                                                                                                        |
| `4`  | lock held: a `run.json` still marked `running` (fresh _or_ stale) refusing a plain `init`                                                                                                                                                                                          |
| `5`  | `verify` only: nothing resolvable to verify with                                                                                                                                                                                                                                   |
| `6`  | `stage <id> preflight` and `stage <id> dispatched` only: a pause was requested for this run — **nothing is written**; read `references/stopping.md`                                                                                                                                |
| `7`  | another session holds this run's driver lease — **nothing is written**; stop immediately, write nothing more, and exit. `unpause` and `abort` take the lease instead of checking it, so neither can be refused this way except on a run another session is _actively heartbeating_ — or, for `abort`, one another session is **already aborting**, which a stop does not override: inspect no worktree, end the turn |
| `8`  | **tracker projects only** — the API is not running. **Nothing is written.** Start the stack and retry the same command (`references/tracker.md`)                                                                                                                      |
| `9`  | **tracker projects only** — an API refusal this command could not absorb. **Nothing is written.** Not a call to retry: park the item with the server's own sentence in the detail (`references/tracker.md`)                                                         |
| `10` | a **stop** was requested for this run: `stage` refuses **every** transition with it, and `watch` returns it after signalling the child. **Nothing is written** by the `stage` refusal; read `references/stopping.md`                                           |

`6`, `7` and `10` are the codes whose reaction is neither a fix nor a retry, which is exactly why none of them is a `1`. A `1` means "this call was wrong". A `6` means
"this call was right and the run is being asked to stop": never retry it, never work around it, read `references/stopping.md`. A `7` means "this call was right and this session is
no longer the one driving this run": another `--resume` session claimed it, and two sessions past that point both stage-write one `run.json` and both end in a
merge into the base. Stop — do not retry, do not re-claim, do not finish the run. (That prohibition is about a session refused mid-run. It does not stop `--abort` taking a
_driver's_ lease, which it opens by doing on purpose: see `references/recovery.md`. A live _abort's_ lease is the one lease `--abort` respects — one board Stop
reaches a live run twice, through this driver's `watch` and through the session the server spawns, and whichever `abort` comes second gets `7` while the first
runs, or a one-line no-op `0` once it has finished.) A `10` means "a person ended this run": it is `6`'s sibling and not `6` itself,
because a pause stops at the next item boundary and a stop stops **now**, abandoning whatever item is in flight. Never retry it, never work around it — read
`references/stopping.md` (_Stopping_), which is `--abort` and not `finish`. `references/recovery.md` has the whole of the lease, including the `claim` a
resume opens with.

That `3` carries two meanings for `watch` deliberately: "no run yet" and "still running, call me again" are the same shape of retry from here. And unlike
`backlog.mjs`, this tool has no exit `2` — running it outside a git repository is a `1` whose message says `no .git found`.

## In a tracker project

A project whose committed `backlog/source.json` says `github` has no item files — its items are GitHub issues — and its run takes the tracker path: **read
`references/tracker.md` in full before §1** (on `--resume`, after `claim` and before `reconcile`). Every site that differs from a files project carries a
one-line `Tracker:` marker below; the file holds the rest.
Ids inside a run are bare issue numbers, `31`, never `#31` (`#` opens a shell comment).

## 1. Preview the queue — `plan` first, always

Before anything is created, spawned, or locked, print the queue that a run _would_ work. `plan` writes nothing at all: no run file, no directories, no state. It
is safe to run as many times as it takes to agree on the queue.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" plan --project "$PWD"
```

`--project` must be an **absolute** path (a relative one exits `1`) and must be the project root — the same string every later command will derive from its own
cwd. Real output looks like this:

```
ready         task-4  Re-ask the dispatch route for a project it cannot see  (runner fix — hoisted)
ungroomed     bug-2  Settings hue swatch preview lags one theme change behind
    - ## Fix is still the "unknown" placeholder — nobody has diagnosed this yet
ready         bug-7  Dispatch launch sheet drops the selected model on a fast double-click
ready         task-1  Show a queue preview before an orchestrator run starts
needs-answers task-5  Let the run drawer jump straight to a parked item's worktree
    ? There is a TBD in this item — what still needs deciding before it can run?
```

Three gate verdicts, and they mean exactly what `backlog-execute`'s own refusal gate means — this is the same rule, applied up front so a whole session spawn is
not spent on an item execute would refuse in its first minute:

- **`ready`** — a task with real content under `## Plan`, or a bug whose `## Fix` is no longer the `unknown` placeholder. These are the only items that ever get
  dispatched.
- **`ungroomed`** — the gate refused it, with the reason on the `-` lines. Never dispatched, never a failure: it is a groom job, and the user should see it
  named here rather than discover it missing later.

  One of those reasons is not a grooming problem at all and reads differently:
  `not committed on <base> — the worktree this run creates from <base> would not contain backlog/…`. The gate reads each candidate's content **at the ref a
  worktree is created from**, not off the working copy, because that ref's bytes are the only ones a dispatched session will ever see. An item groomed a minute
  ago and not yet committed is therefore refused, and the fix is a `git commit` of `backlog/` on `<base>`, not a groom. This is the same seam `backlog-groom`
  closes on, in its own `Groomed on disk only` line — one sentence, two skills, one wording. The orchestrator will not make that commit for you: it commits
  inside a per-item worktree, on `backlog/<id>` alone, and nowhere else.

  `<base>` there is the run's base branch, `main` unless the trigger carried `--base <ref>` (section 2). Pass the same `--base` to `plan` that the run will be
  started with, or the preview gates at a different ref from the run and can disagree with it item for item — an item committed on `main` but not on
  `feature/x` reads `ready` in a default preview and `ungroomed` in the run that follows. This is the one place in this file where forgetting a flag produces a
  wrong answer rather than an error.

- **`needs-answers`** — the gate passed, but the item still carries an open question (a `TBD`, a question line in the plan, a `## Done when` naming a command
  this project cannot resolve). Still a candidate; see pre-flight.

Only bugs and tasks are ever candidates, bugs first then tasks, oldest first within each — ideas, refactors and out-of-scope items have nothing to execute by
definition.

**One thing outranks that ordering: a `runner-fix:` frontmatter key.** It means _executing this item repairs machinery this run itself depends on_ — this
SKILL.md, `orchestrate.mjs`, the reviewer agent, the dispatch route — and any item carrying it is hoisted to the front of the queue, ahead of every unmarked
item of either section, with `(runner fix — hoisted)` printed on its row. The reason is an observed run that queued a permission-flag fix as item 3 of 5 and had
item 1's very first dispatch refused by exactly the flag item 3 existed to replace. Four things about the key:

- **Presence hoists; only `false` opts out.** `runner-fix: true`, `runner-fix: yes` and a bare `runner-fix:` all hoist. A key that hoisted on `true` alone would
  let `runner-fix: yes` silently do nothing — a queue in the wrong order with nobody told, which is the failure this marker exists to remove.
- **It is read at `<base>`, exactly like the gate verdict beside it.** A marker present only in the working copy does not reorder the run, for the same reason a
  plan present only there does not pass the gate: the worktree this run creates would not contain it. An item absent from `<base>` altogether never hoists
  either.
- **The gate is untouched.** An ungroomed marked item hoists too, appears first labelled `ungroomed`, and is skipped at pre-flight like any other — "the thing
  that would fix your runner is not groomed" is information, at the top where it will be read.
- **A human writes it**, during grooming. There is no path heuristic: most `skills/` edits do not affect a running orchestrator, and a dispatch-route fix that
  does need not name any particular path.

Two optional flags, and they pass through to `init` identically, which is the point: whatever you previewed is what you get.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" plan --project "$PWD" --ids task-3,bug-7 --max 2
```

- **`--ids a,b,c`** restricts the run to those ids **in the order given, after any runner-fix item is hoisted to the front**, overriding the bugs-then-tasks
  ordering. An id no open item matches exits `1` naming it — relay that rather than guessing what was meant. (The hoist applies here too because the board sends
  `ids` for any strict subset of its checkbox list: that list is a _selection_, not an ordering — nobody chose the order it arrives in.)
- **`--max N`** bounds how much of the queue this run will look at at all: counting from the top, once `N` ready items have been placed, every item after that
  is dropped from the run — including ones that would have read `ungroomed`. It is a cap on the run, not a cap on dispatches within a longer queue.

Show the user this table and get agreement on it before starting a run, unless the trigger already named ids explicitly. A run is a long, expensive,
mostly-unattended thing; the preview is the last cheap moment to notice that half the queue is ungroomed.

## 2. Start the run

**Prefer a run started from the board to one started by typing this trigger into an interactive terminal.** A board-started run is spawned headless
(`claude -p`); an interactive one additionally carries every MCP server and hook that terminal connects, and a run's context floor is re-read on every one of
its several hundred turns. Measured on this machine: interactive sessions floor around 68k tokens before any work, headless ones around 50k. No board-started
_orchestrate_ run existed when this was written, so treat that ~18k as the expected order for this path, not a measured result for it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" init --project "$PWD" --ids task-3,bug-7 --max 2
```

Same flags, same queue, now written down. `init` prints one JSON line:

```json
{ "runId": "run-20260831-123118", "dir": "/Users/you/.backlog-manager/orchestrator/%2FUsers%2Fyou%2Fprojects%2Ffoo" }
```

**Keep `dir`.** It is this run's own state directory, outside the repo, and it is where every artifact this skill produces belongs: session transcripts, pid
files, question payloads, reviewer reports. Nothing this skill generates is ever written into the repo — an artifact inside the tree would land in the very diff
being reviewed and ride the merge into the base. Create the subdirectories as you need them (`mkdir -p "<dir>/logs"`), and stay out of `<dir>/runs/`, which is the
tool's own archive of finished runs.

Those flat subdirectories are always **this** run's, and always start empty: the `init` that opened this run swept the previous run's sidecars into
`<dir>/runs/<runId>/`, beside that run's archived `<runId>.json`. So an earlier run's transcripts, reviewer reports, verify output and question payloads live
there and are never overwritten by this one — and nothing you write under `<dir>` needs a run id in its name to stay distinct from theirs.

**Exit `4` means a run already exists for this project** — either one is live right now, or one crashed and left its `running` status behind. Plain `init`
refuses both, identically and deliberately: a stale `running` run is the last surviving record of a run that died mid-item, and possibly of a worktree, a branch
and an in-progress marker still on disk (`references/rationale.md`, §2). Do not retry `init`, and **never delete the run file to get past this.** Run `status`,
show the user, then take the run over with `--resume` or end it with `--abort` — both of which begin at `references/recovery.md`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" status
```

### The base branch

When the trigger carries `--base <ref>`, add that flag to the `init` above — and to every `plan` you ran to agree the queue (§1). Absent, the base is `main` and
the run behaves exactly as every run before this flag existed.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" init --project "$PWD" --base feature/tracker-backed
```

`init` refuses anything that is not an **existing local branch** — a tag, a commit SHA, a remote-tracking ref like `origin/main`, a branch that does not exist,
or a malformed name — with exit `1` and nothing written. It will not create the branch for you: a run merges *into* its base, only a local branch can move, and
inventing a ref is not something an unattended run should do on a guess. Create it yourself first, then start the run.

The base is recorded in the run file as `base` and **read from there by everything downstream**, which is what makes `--resume` safe: a resumed session takes
the base off the file rather than off whatever flag the person resuming happened to type. `status --json` carries it.

What the base changes, in one list, so a run reading this on turn 300 does not have to reconstruct it:

- §1's gate reads each candidate at `<base>`.
- §4 cuts each item worktree from `<base>`.
- §9 merges each verified item into `<base>`, **in whichever working tree has `<base>` checked out** — which is usually the main tree and is not always, and is
  the whole of that section's first half.
- §9's conflict recovery brings `<base>` into the item worktree.
- Each item starts from the updated `<base>`, so a phased feature builds on itself item by item. That is the reason this flag exists.

What it does **not** change: nothing is pushed, on any branch; the base is never merged into anything else — landing `feature/x` on `main` when the experiment
is proven is a human act, not this run's; and `branch` mode is unaffected, since it writes to no tree at all.

### Merge mode, and the probe before item 1

When the trigger carries `--merge-mode branch`, add that flag to the `init` above and change nothing else. Absent, the run is `merge` mode — today's behaviour
byte for byte.

When the trigger carries `--question-mode decide`, add that flag to the `init` above too, and change nothing else. Absent, the run is `park` mode — also today's
behaviour byte for byte. Kept as its own sentence rather than merged into the one above deliberately: a run reading this on turn 300 skims, and a compound
sentence about two flags is where one of them gets dropped. The mode is run-level — set at `init`, applied to the whole queue, and only ever moved one way
afterwards (`merge` → `branch`, below). `status --json` carries it as `mergeModeEffective`, which is where a resumed session reads it.

- **`merge`** — each verified item is merged into the run's base, then its worktree and branch are cleaned up (§9).
- **`branch`** — each verified item stops at its reviewed `backlog/<id>` branch and the base is never written. Review and verification are unchanged: the mode
  decides where a _successful_ item stops, nothing else.

**In `merge` mode only, probe once, here, before item 1:**

```bash
git merge --no-ff --no-edit HEAD
```

Merging `HEAD` into itself prints `Already up to date.`, exits `0`, and changes nothing that matters — no commit, no index change, no reflog entry, dirty tree
or clean (it does refresh `.git/ORIG_HEAD`, the same as any other `git merge` invocation, harmlessly). The point is not the merge; it is that the command shape
is byte-identical to §9's real one, so the permission classifier is asked now exactly what it will be asked at every merge later.

**In a tracker project the probe takes the tracker merge's shape instead** — three `-m` flags, as §9's merge (Tracker: `references/tracker.md` §2):

```bash
git merge --no-ff -m "Merge probe: <runId>" -m "Fixes nothing: merge-mode probe" -m "Reviewed: merge-mode probe, no item" HEAD
```

Same effect — `Already up to date.`, exit `0`, no commit — and it pushes nothing.

**A resumed or unpaused run that has not probed in this session probes before its first merge.** The verdict belongs to the session asking, and a run that was
paused before item 1 and unpaused by a later session reaches §9 having never asked at all.

- **Allowed** → carry on in merge mode.
- **Denied** (`Permission for this action was denied by the Claude Code auto mode classifier`) → record the downgrade and run the **whole queue** in branch
  mode. The run does not stop and nothing is parked:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" merge-mode branch --note "auto mode classifier denied the merge probe"
  ```

  `--note` is mandatory (omitting it exits `1`), and the command only ever moves `merge` → `branch`, only once per run — a second call exits `1` rather than
  overwriting the first note.

  **That note is fixed text, not the classifier's message.** The denial's `Reason:` is model-written, so §4's prose-in-argv rule keeps it off the command line;
  the full text stays in this session's transcript (`references/rationale.md`, §2).

**The probe is early warning, not a guarantee.** The verdict is per call, not per project: an identical merge command was allowed in one run and denied in the
next, with no permission rule anywhere in either (`references/rationale.md`, §2 — merge mode). So a probe that passes can still be followed by a denied merge,
which is precisely why §9 carries a degrade path of its own. Skip the probe in branch mode: there is no merge to ask about.

Then work the queue **strictly one item at a time**, in the order `status --json` lists it. Sequential is not a performance compromise to be optimised away
later: one worktree and one session in flight is what keeps each item's diff attributable and each session's context clean, and two items forfeit both. In
`merge` mode the merge between items adds a second reason — each item starts from the updated `<base>`. Branch mode gives up that half and only that half (§9);
the rule itself is unconditional.

## 3. Pre-flight, per item

### Recognise a leftover branched item, before anything else

**Run this before the gate and before hunting for questions.** An item that already finished under branch mode in a _previous_ run — worktree removed, branch
kept, waiting on a hand-merge — cannot be told apart from one that still needs pre-flight by reading its file: any pre-flight answer a prior run wrote went
**into that run's worktree** ("Writing an answer into the item", below), which rides the branch and is never merged back into the main-tree copy the hunt reads.
Skip this check and the hunt finds the same unresolved `TBD` on every subsequent run, staging a green, reviewed, verified branch as `needs-answers` forever —
the exact failure this mode exists to avoid, one layer up.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" leftover <id>
```

It only reads, and prints `{ branch, worktree, dir, archived, verdict }` with exit `0`: whether the branch exists, whether its worktree is registered, whether
its directory exists, and — for a branch alone — whether its `<base>...backlog/<id>` diff moves the item to `done/`. §4's "Create the worktree" asks the same
question again, and `worktree` re-asks it itself before it touches anything.

- **`archived`** (a branch and nothing else, whose diff archives the item — what a _finished_ branch-mode item leaves behind) — finished, waiting on a
  hand-merge. Stage it and move straight to the **next** item; do not re-gate, hunt, dispatch, review or verify it again — that would spend a whole item's
  budget re-proving what is already green.

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> branched --branch backlog/<id>
  ```

- **Any other verdict** — nothing to recognise yet. Continue below. `reattach` (a branch alone, whose diff does not archive the item) is a real leftover, not a
  finished item: a crash before this run re-checked the branch out. §4 resumes it.

### Re-check the gate

`init` used the gate to decide _membership and order only_ — it deliberately did not bake the verdict into the run file, because a run can span hours and a
human may groom an item mid-run. So re-gate this one item immediately before dispatching it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" plan --project "$PWD" --ids <id> --json
```

- **`ungroomed`** → record it and move to the next item:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> ungroomed --note "<the gate's own reason>"
  ```

  `stage`, not `attention`: the attention list takes exactly three kinds — `needs-answers`, `parked`, `fix-exhausted` — and anything else exits `1`. An
  ungroomed item is not something that went wrong in this run, it is work waiting on `/backlog-groom`, and the drawer reads it off the stage.

- **exit `1`, "unknown item id"** → the item is no longer open (somebody archived or rejected it since `init`). Not an error worth stopping for:
  `stage <id> skipped --note "no longer open"` and continue.
- **`ready` or `needs-answers`** → carry on below.

Then say so on the record before doing anything slow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> preflight
```

**Exit `6`** — the board asked this run to pause. Do not pre-flight the item, do not create anything: read `references/stopping.md` (_Pausing_). Nothing was written, the
item is still `pending`, and a resumed run picks it up from here as if this turn had never happened.

Tracker: that call also takes the issue's claim — `"stage":"skipped"` (exit `0`) means another run holds it, so move to the next item; exit `9` parks the item
(`references/tracker.md` §3, _the claim_).

### Hunt for open questions

Read the item file in the **main tree** (read-only — no worktree exists yet) and look for what would stop a headless session cold: a `TBD`, an unresolved
either/or in the plan, a section the plan refers to that is empty, a `## Done when` naming a command this repo does not have. The gate's own `questions` array
from the `plan --json` above is a starting point, not the whole hunt — it reads three mechanical signals; you are reading the item.

No questions → skip straight to the loop.

### With questions: ask, best-effort

Use `AskUserQuestion`, once, with the questions as written in the item. If a channel exists (an interactive terminal, or a spawned session whose host carries
asks to the user's phone) the answer comes back and the run keeps its momentum. **Treat the ask as best-effort:** if the tool is unavailable in this session,
errors, or returns without an answer, take the no-channel path below immediately. Never re-ask, never poll, never wait in a loop — a stalled unattended run is
the exact failure this whole design exists to avoid, and an item skipped with its question recorded costs one groom edit and one re-run.

There are three outcomes, not two, and which of the last two applies is the run's `questionMode` (`status --json` carries it; `park` if the field is absent,
which is every run file written before the mode existed).

**Answered**, in either mode → the answer is written into the item body, but _not yet_ and _not here_; see "Writing an answer into the item" below.

**Not answered, `questionMode: park`** → record the questions verbatim and move on:

Write `<dir>/questions/<id>.json` with the **Write tool** — a JSON array of the questions exactly as the item words them, `["question one","question two"]` —
and then record it. The Write tool rather than a shell line for §4's reason: a question containing an apostrophe is a syntax error inside `printf '%s' '…'`, and
a question is prose.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind needs-answers --detail "asked, no channel — skipped" --questions-json "<dir>/questions/<id>.json"
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> needs-answers
```

`--questions-json` takes a file holding a JSON array of strings, and its content is only ever applied for `--kind needs-answers` — the other two kinds read the
flag and validate it, then ignore its content. Both lines: the `attention` entry is what the run drawer surfaces to the user, the `stage` is what stops this
item being treated as still in flight. Then continue with the next item; a `needs-answers` item is not a failed run.

Tracker: every `attention` call also comments on the issue, so `--detail` is published text — your own words, never a quote (`references/tracker.md` §3,
_`attention` becomes a comment_).

**Not answered, `questionMode: decide`** → decide each question yourself, then record what you decided. When a question goes unanswered under `decide`, read
`references/questions.md` in full: it answers from the item, the repo's `CLAUDE.md`, its scoped rules and the code, writes each answer into the item through
"Writing an answer into the item" below (inside the worktree, in step 4), and records the pairs on the queue item with `assume`, which the tool refuses on a
`park` run. Then continue to the loop and dispatch the item like any other.

One rule goes with all three outcomes, and it carries its reason because a bare prohibition is exactly what drifts:

**Never restate an unanswered question in prose**, in either mode. A prose question ends the turn. In a board-started run that exits the session, `watch`
sees it die, and the whole run then needs `--resume` — so "ask in prose and wait" is not a milder park, it is stopping the entire run. Someone who wants a
question actually put to a human starts the run from a harness that has `AskUserQuestion`; a run started from the board is choosing between skipping the item
and answering it itself.

Under `decide` the answer is recorded as the runner's own assumption and never as a human ruling, and `attention <id> --kind needs-answers` stays legal for a
question that genuinely cannot be answered — `references/questions.md` has both.

### Writing an answer into the item

Orchestrate is a plugin skill and therefore a legitimate writer of item files — but only here, only for a pre-flight answer, and under `backlog-groom`'s write
rules, which exist because the file is round-tripped by tools that must not lose what they did not understand:

- round-trip every frontmatter key you did not come to change, byte-for-byte, including ones you have never seen before;
- leave the rest of the body byte-for-byte identical — write the answer under the section it clarifies, do not reflow, retitle, or tidy anything else;
- write before any move (nothing here moves a file, but the rule is the same one, and it is what keeps a half-written item from ever existing).

**Write it inside the worktree, after the worktree exists — not in the main tree.** Two reasons, both hard-won: a worktree checks out `<base>`'s _commit_, so
an uncommitted amendment sitting in the main tree would never reach the session that needs it; and worse, that same uncommitted change to the item's own path is
what makes `git merge` refuse later ("your local changes would be overwritten"), because the item file is exactly the path the branch also touches when execute
archives it. Amending inside the worktree instead means the answer rides the branch and reaches the base through the merge, like every other change this item
makes. So: hunt and ask here, write in step 4.

## 4. The loop — worktree, dispatch, watch

### Pull the base first — tracker projects only

Find the tree that has `<base>` checked out, then pull in it — both commands run before every item's worktree:

```bash
git -C "$PWD" worktree list --porcelain | grep -B2 -Fx "branch refs/heads/<base>" | sed -n 's/^worktree //p'
git -C "<base tree>" pull --ff-only origin <base>
```

**Before every item's worktree, not once per run**, with `<base tree>` re-resolved every time and never read back from the run file; never rewrite the scan as
`awk` over `$0`. A non-zero exit **parks the run** — Tracker: `references/tracker.md` §4, _Pull the base first_, has why and the three park commands.

### Create the worktree

**Probe for leftovers before creating anything.** Every park path in this file keeps the item's branch _and_ its worktree on purpose — fix-exhausted (§7),
nothing to verify with (§8), a merge conflict and a base tree not on `<base>` (§9) — and `finish` cleans up none of it. The item most likely to be queued by the
_next_ run is therefore exactly the one that already has both on disk, because parking is what leaves it open.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" leftover <id>
```

Act on `verdict`:

- **`none`** — nothing left over. Create it, below.
- **`reattach`** — a branch with no worktree. **A real leftover, not a finished item**: §3's own run of this probe already did the archive check for this exact
  shape, and would have staged the item `branched` and skipped straight to the next item had it found one. What's left is a run that committed the item's work
  and then crashed before re-checking the branch out. Create it, below: `worktree` checks the existing branch out into a fresh worktree _without_ `-b`.
- **`resume-or-park`** — branch, worktree and directory all exist: a previous run's work is sitting there. **Never delete either to make room.** That is the
  same rule §10's abort path spells out, for the same reason: an unmerged worktree can hold uncommitted work that no commit and no reflog can bring back, and
  this run cannot know from outside that it doesn't. Look first —

  ```bash
  git -C "$PWD/.worktrees/<id>" status
  git -C "$PWD" log --oneline <base>..backlog/<id>
  ```

  — then ask, best-effort, exactly as pre-flight does, and take one of two answers:
  - **Resume onto it.** Record the existing pair and re-enter the loop at **Inspect** (step 5), _not_ at dispatch: the tree already carries a previous session's
    work, and a fresh execute session dropped on top of it would produce a diff nobody can attribute, which the reviewer and the committer would then treat as
    this run's.

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> dispatched --worktree "$PWD/.worktrees/<id>" --branch backlog/<id>
    ```

  - **Park it again** — the only answer with no channel, and the honest one either way: the item is parked because a human decision was already asked for and
    not given, and a new run does not change that.

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "leftover worktree $PWD/.worktrees/<id> and branch backlog/<id> from an earlier run — resume or clear them by hand before the next run"
    node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
    ```

- **`park`** — any other combination: a registered worktree whose directory is gone, a directory git has no record of, a worktree sitting on a detached HEAD.
  These are states this skill never creates, so it does not get to guess what they mean. Park, with the verdict's own `detail`, which names what each probe
  found:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "<the leftover verdict's detail>"
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

- **`archived`** — §3 stages these `branched` and moves on, so none reaches here; if one does, stage it the same way.

**Never `worktree prune`, `branch -D` or `--force` a leftover** — this run's authority stops at worktrees it created itself.

For `none` and `reattach`, create it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" worktree <id>
```

It re-runs the probe itself and refuses (exit `1`, nothing changed) on any other verdict. Otherwise it creates `.worktrees/<id>` — on a new `backlog/<id>` cut
from the run's base branch (§2, `main` unless the run was started with `--base`) for `none`, on the existing branch for `reattach` — and prints `{ worktree,
branch, created }`: `worktree` is absolute, and `created` is `"new"` or `"reattached"`. The main working tree is never touched by this, and a dirty main tree
does not block it: the new worktree checks out `<base>`'s HEAD commit, not the working copy. Creating a worktree on a _new_ branch while `<base>` itself is
checked out somewhere is legal — the branches differ, so nothing is locked. (It is the _same branch_ twice that git refuses, which is why §9 has to find the
base rather than check it out again.)

It also proves the item survived the checkout, before anything is written into the worktree: the worktree holds `<base>`'s _commit_, so an item groomed but
never committed exists only in the main tree, and a session with no item file in its tree finds the main tree's copy, works that one, and every stage of the run
reports success over a branch with no lifecycle move on it. The probe is `backlog.mjs show <id>` from inside the new worktree; Tracker: skipped
(`references/tracker.md` §4, _the `show` probe_). (`references/rationale.md`, §4, lists everything it catches that §1's gate
cannot.)

And it keeps the new directory out of everybody's `git status`: `.worktrees/` and `node_modules` go into the **common** git dir's `info/exclude`, whole line,
only if absent — never `.gitignore`, which is tracked. The entries are **never committed**. Whatever else this run writes into a worktree to make verification
possible (a package-manager shim, a scratch config) goes on that list too, locally, before the first dispatch, so §6's `add -A` never stages it.
`node_modules` is listed **bare**, no trailing slash — a worktree gets a _symlink_, and a directory-only pattern cannot match one (`references/rationale.md`, §4).

What it printed decides the next step:

- **`created: "new"`** — carry on below.
- **`created: "reattached"`** — record it with the `stage <id> dispatched --worktree … --branch …` line below, then go to **Inspect** (§5), _not_ to dispatch:
  the branch may already carry commits.
- **`verdict: "park"`**, exit `0` — the item is not present in the worktree checked out from `<base>`. The tool has already recorded the attention entry and
  staged the item `parked`, and kept the worktree and the branch exactly as every other park path in this file does: delete nothing, `prune` nothing, `-D`
  nothing. Move on to the next item.
- **exit `1`** — nothing was changed. Either a leftover appeared since `leftover` ran (act on that verdict above), or `git worktree add` itself failed and
  stderr quotes git: park it, `attention <id> --kind parked --detail "worktree creation failed — <what happened, your words>"`, then `stage <id> parked`.

Now write any pre-flight answer into the worktree's copy of the item file (see above), and record the worktree on the run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> dispatched --worktree "$PWD/.worktrees/<id>" --branch backlog/<id> --permission-mode auto
```

Pass the worktree as an **absolute** path: `reconcile` and `abort` both test it with a plain existence check from wherever they happen to be running, and a
relative path that resolves for one of them may not for the other.

`--permission-mode auto` here records on the run what the dispatch below is about to launch under. It must match that dispatch line's own flag — the field
exists so that a denial found in a transcript has the mode that produced it recorded beside it, and a field recording the wrong mode is worse than no field.

**Exit `6` here** — the pause request arrived during pre-flight. Leave the worktree and the branch exactly as they are (the worktree may carry the pre-flight
answer you just wrote into it; nothing else has happened in it), leave the item at `preflight`, and read `references/stopping.md` (_Pausing_). A resumed run re-enters at this same
dispatch line onto that same worktree — `references/recovery.md` names the shape.

### Dispatch the headless session

```bash
mkdir -p "<dir>/logs"
nohup sh -c 'LOCAL="$PWD/.claude/settings.local.json"; [ -f "$LOCAL" ] || LOCAL=; cd "$PWD/.worktrees/<id>" && BM_ORCH_RUN=<runId> exec claude -p "/backlog-execute <id> [orchestrator-run <runId> item <n> of <m> branch backlog/<id>: you are dispatched by backlog-orchestrate inside an unattended run. There is no user to ask. Never commit, push or merge. Never run a command in the background, and never end a turn with one still running; run tests, typecheck and build in the foreground. One exception: a dev server for Playwright browser verification, its pid recorded in the call that starts it and killed by that pid, never by pattern, before the turn ends. Anything you cannot resolve goes in your final message, not to a person.]" ${LOCAL:+--settings "$LOCAL"} --output-format stream-json --verbose --permission-mode auto --model opus -n "orch <id>"' > "<dir>/logs/<id>.jsonl" 2> "<dir>/logs/<id>.err" &
echo $! > "<dir>/logs/<id>.pid"
```

**Then record that pid on the run:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> dispatched --pid "$(cat '<dir>/logs/<id>.pid')"
```

A re-stamp of the stage the item already occupies, exactly like the `--session` line further down, so the pause gate lets it through. It is the same number
`watch --pid` reads, put where `status --json` and anyone reading the run can see it. Run it on the retry line in §5 too.

If this call exits `10` a stop landed in the gap: do not retry it, do not work around it, read `references/stopping.md`. The `echo $!` line must write **exactly**
`<dir>/logs/<id>.pid` — `--abort` reads that file first, and renaming it blinds `abort` silently (`references/rationale.md`, §4).

Both lines in **one** Bash invocation — each invocation gets its own shell, so `$!` is only readable in the call that backgrounded the child; that is why the
pid goes straight into a file. `exec` matters too: it makes the pid you recorded the `claude` process itself rather than a wrapper shell around it, and `watch`
polls exactly that pid. `nohup` and the redirects are what let the session outlive the single tool call that started it. stdout is the stream-json transcript
and goes to the `.jsonl` that `watch` reads; stderr goes to its own file, so a warning printed by the CLI never lands in the middle of the transcript.

**`--model opus` stays on the line, and on the retry and fix-loop lines too.** A bare `claude -p` takes whatever model the host's CLI defaults to, and `--resume`
does not promise to carry one forward (`references/rationale.md`, §4).

**`${LOCAL:+--settings "$LOCAL"}` hands the session the main tree's `.claude/settings.local.json`, because the worktree has none.** `LOCAL` is resolved
**before** the `cd`, while `$PWD` is still the project root, and emptied when the file does not exist, so a project without one gets no flag at all. The
expansion is unquoted on purpose and correct only because the body runs under `sh` — never run this body under zsh. It is a flag, never a copy or a link into
the worktree. **The retry line carries it too**, and so does every fix loop, resumed or fresh (`references/rationale.md`, §4).

**`BM_ORCH_RUN=<runId>` is the second marker on this line, and it is not the prompt marker by another spelling.** It tells the machine's `Stop` hook that a run
owns the process, so the hook does not hold the finished turn open for a dashboard answer nobody will give. Substitute `<runId>` from this run, and put the
assignment **inside** the `sh -c '…'` body as a prefix on `exec`, never in front of `nohup`. **§5's `--resume` retry carries it too**, unlike the prompt marker:
a resumed session keeps its original prompt but gets a brand-new environment (`references/rationale.md`, §4).

**`-n "orch <id>"` is the third marker, and its reader is a person.** The name is the **item id** — never the project or the run id — with a space as the
separator and no `:` or `/` in it: the dashboard's `NAME_RE` is `/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/`, and a name that fails it is dropped silently. **§5's `--resume`
retry names itself `orch <id> retry 1`**, the same counter its own `<id>-retry-1.jsonl` carries; the name is double-quoted inside the single-quoted body because
it holds a space (`references/rationale.md`, §4).

**The prompt is spent on more than the trigger, and every word of the marker is load-bearing.** The prompt is the _entire_ channel from this run to that session,
and left as the bare trigger a dispatched session reads as a hand-started one (`references/rationale.md`, §4). Six constraints on that string:

- **The id stays the first token after the trigger**, marker after it. `backlog-execute`'s "Pick an item" reads the trigger's own words for an id. Putting
  anything between the two is how this line teaches it to guess.
- **One line, and no apostrophes.** The dispatch is `nohup sh -c '…'` — a single-quoted body with the prompt double-quoted inside it. One apostrophe closes the
  outer quote and the whole dispatch becomes a syntax error, on the one line whose failure mode is "every item in the queue parks". Write "you cannot", never
  the contraction.
- **The marker opens with `[orchestrator-run`,** a fixed, greppable token. `backlog-execute`'s own section names that exact literal, and a test reads it off
  this line and asserts it into that file, so the two cannot drift into two markers that merely look alike.
- **`<runId>`, `<n> of <m>` and the branch are substituted**, the standing rule is fixed text. Fill the first three from this run and this item's position in
  the queue; change none of the words after the colon.
- **The prompt, not `--append-system-prompt` and not an env var.** Both reach the model; neither reaches the dashboard drawer. The prompt is the only string the
  model and the _human_ reading that conversation both see, and the human not knowing a run owns the work is the other half of the same defect. This rules an
  env var out for _this_ marker and for nothing else — a marker whose reader is a hook belongs in the environment, because a hook cannot read a prompt. The
  channel follows the reader.
- **Merge mode is deliberately left out.** Nothing the session may do differs between `merge` and `branch` — it never merges either way — and a marker naming
  facts the session cannot act on trains it to skim the ones it must.

Tracker: the marker gains a mandatory clause, `outcome <dir>/outcomes/<n>.md` (absolute, under the run-state directory, file created empty first), immediately
before the closing `.]` (`references/tracker.md` §4, _the `outcome` clause_).

**Prose this run did not compose — reviewer findings, execute's `## Outcome`, a captured error — never rides a shell command line; it goes in a file and the
command names the file.** "No apostrophes" above governs only the fixed marker text this run writes itself; every `"…"` inside the single-quoted `sh -c` body is
still a command position, so a backtick, `$(…)` or apostrophe in somebody else's words breaks it. The tool takes its own payloads the same way —
`attention --questions-json <file>` and `assume --json <file>` — and §5's retry launcher, §7's fix loop and §3's two questions payloads match it
(`references/rationale.md`, §4).

The Write tool creates the directory on its way to the file, so none of those paths needs a `mkdir -p` ahead of it — unlike `<dir>/logs/` and `<dir>/verify/`,
which a shell redirect will not create for itself.

**The rule has a second half: `attention --detail`, `stage --note` and `merge-mode --note` take the driver's own short words — a summary in your voice,
never a verbatim quote of text this run did not compose.** Each value is a pointer plus a sentence: the copy of record is the reviewer's report at
`<dir>/reviews/<id>-<n>.md`, a verify attempt's rows in `status --json` or a session's `<dir>/logs/<id>.jsonl`, and the entry names it. Every placeholder in one
of those values is spelled to say whose words it is, and a test reads them out of this file against a closed list: a new placeholder there is a decision to
make, not a blank to fill.

The marker also arrives in that session as `$2`…`$N`, substituted into `backlog-execute`'s SKILL.md before it is read. That is safe only because no fenced block
under `skills/` reads a positional parameter (`references/rationale.md`, §4).

**`--verbose` is required, not a contingency.** With `--print`, the installed CLI refuses the stream-json format without it, and in `-p` mode `--verbose` is
also what _produces_ the event stream at all. Leaving it off is the quietest failure in this whole file: every item in the queue parks as a crashed session, and
the run merges nothing. `references/rationale.md` has the exact error and the full chain.

**`--permission-mode auto`, and not the rung above it.** The run is defensible because of four walls, not trust in the session: a **disposable worktree**, an
**independent review**, **verification commands** that must come back green, and the **merge as the only door back into the base**, walked by this skill and
never by the session. `auto` is the lowest rung
that clears an execute session's workload; do **not** "tighten" it to `dontAsk` plus `--allowedTools` (`references/rationale.md`, §4).

**A denial is silent in every signal but one.** A refused call comes back as an ordinary `tool_result` the session improvises around; the run still reports
`subtype: "success"`, `is_error: false`, and exit `0` **even when every call was refused**. The one machine-readable trace is `permission_denials` on the result
event — which is why step 5 checks it before judging anything else, and why that check is not optional in the fix loop either. Never read what `auto` permitted
on one day as a contract: it is a classifier's judgment, not a list.

### Watch until it exits

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" watch <id> --pid "$(cat '<dir>/logs/<id>.pid')" --jsonl "<dir>/logs/<id>.jsonl"
```

**Make this call with the Bash tool's timeout raised to its maximum: `timeout: 600000`.** The default is `120000` — two minutes — and nothing raises it for you.
Left at the default, every `watch` call is cut off two minutes into a nine-minute budget. That is survivable rather than fatal (the child is `nohup`ed and
unaffected, and the heartbeat has already landed on the call's first tick), but it turns one designed call into five, each ending in a tool error the loop has
to read past instead of an exit code it has a branch for. Ten minutes is the ceiling the tool will accept, and it is exactly the number `--budget-ms`'s default
was chosen to sit a minute under.

`watch` blocks for up to `--budget-ms` (default `540000`, nine minutes), polling every `--interval-ms` (default `30000`). Each tick it heartbeats the run, and
the first time it finds the `system`/`init` event in the transcript it records the session id onto the queue item for you — which is why this skill never parses
that file itself, and why `status --json` is where the session id is read back from.

- **exit `0`** — the child is gone. Move to Inspect.
- **exit `3`** — the budget elapsed and the child is still alive. **Call `watch` again**, unchanged, as many times as it takes. That is the entire reason the
  command exists: nine minutes stays under a ten-minute tool-call ceiling with slack, so a two-hour item survives as thirteen calls instead of one call that
  gets cut off.
- **exit `1`** — a problem with this call: a missing `.jsonl` after the first interval, or one that cannot be read at all. The session may still be running; do
  not assume it died. Inspect the worktree and the `.err` file before deciding anything.
- **exit `10`** — a stop was requested for this run. `watch` has already signalled the child by the pid you gave it, so the session is ending. Do
  **not** call `watch` again and do not stage anything: every `stage` transition now refuses with the same `10`. Read `references/stopping.md` (_Stopping_)
  straight away (`references/rationale.md`, §4, covers the session id this exit leaves on the run file).

## 5. Inspect what the session left behind

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" inspect <id>
```

One call: it stages `inspecting`, copies what the session cost onto the queue item (the only place that number survives once the logs are pruned), counts the
permission denials in the transcript, and reads the item file **in the worktree** — the main tree's copy has not changed and will not until the merge. It reads
`<dir>/logs/<id>.jsonl`; `--jsonl "<file>"` names another transcript, as on the retry line below. Step 7's fix loop keeps its own `denials` and `usage` lines.
It prints one JSON line:

- **`usage`** — `"recorded"`, or `"no-result"`: the transcript never reached a result event (a killed session) and nothing was recorded, which is the honest
  answer.
- **`usage: "no-transcript"`, `denials: null`** — this run has no transcript for the item (a reattached one): `null` means unknown, never clean. Go on to review
  as usual and say "denials unknown" wherever the run would report a denial count for this item.
- **`denials`**, the refused calls in `refused` — **non-zero means the item is not clean even if it looks done**: the session ran `auto` into a call the
  classifier refused (step 4's rationale), and a denied run reports `success` and exits `0` like any other, so this is the only place it shows. Whatever it
  built, it built around a command that never ran. Treat it exactly like the two failure shapes below — ask the user, and do not merge the diff. On the retry
  path it is the _retry's_ transcript that is read.
- **`item`**, **`itemPath`** — `"done"` (moved to `backlog/<section>/done/`, with an `## Outcome`), `"open-with-outcome"` (still open, with one: execute's own
  failure path — it tried, verification failed, and it left the item where it was, the most useful record you have) or `"no-outcome"` (neither: the session died
  — a crash, a usage cap, a dropped connection). **Whether an Outcome carries real verification output is still yours to judge**; `done` with one that does not
  is no success.

Exit `1` is an unreadable transcript, not a clean run — look at it before deciding anything. Exit `10` is a stop request, nothing written after it.

Tracker: `item` is `"outcome"` for a non-empty `<dir>/outcomes/<n>.md` (success or failure — you read which) and `"no-outcome"` for an empty or absent one
(died). `inspect` has also written `<dir>/items/<n>.md` (`snapshot` in the output) for the reviewer and `verify` — run `snapshot <n>` **again after every fix
loop** (`references/tracker.md` §5).

For both failure shapes, ask the user — best-effort, exactly like pre-flight — which of three they want: **retry**, **skip**, or **stop the run**. Retry resumes
that item's own session so its context is not paid for twice. **Write what to do differently into `<dir>/prompts/<id>-retry-1.txt` first, with the Write tool**,
and only then launch. §4's rule about prose in a command position covers this text: it quotes execute's failure `## Outcome`, which carries command output
verbatim. **End that file with the fresh dispatch's background rule, word for word: "Never run a command in the background, and never end a turn with one still running; run tests, typecheck and build in the foreground. One exception: a dev server for Playwright browser verification, its pid recorded in the call that starts it and killed by that pid, never by pattern, before the turn ends."** A
retry is the session most tempted to background, and a headless `-p` session that ends its turn waiting on a notification exits with no Outcome
(`references/rationale.md`, §4).

```bash
nohup sh -c 'LOCAL="$PWD/.claude/settings.local.json"; [ -f "$LOCAL" ] || LOCAL=; cd "$PWD/.worktrees/<id>" && test -s "<dir>/prompts/<id>-retry-1.txt" && BM_ORCH_RUN=<runId> exec claude -p --resume <sessionId> "$(cat "<dir>/prompts/<id>-retry-1.txt")" ${LOCAL:+--settings "$LOCAL"} --output-format stream-json --verbose --permission-mode auto --model opus -n "orch <id> retry 1"' > "<dir>/logs/<id>-retry-1.jsonl" 2> "<dir>/logs/<id>-retry-1.err" &
echo $! > "<dir>/logs/<id>.pid"
```

Three details on that line (`references/rationale.md`, §4):

- **`$(cat "<file>")`, and the prompt is the file's bytes** — the inner double quotes around the path stay, inside the single-quoted body.
- **`test -s "<file>" &&` ahead of the assignment**, so a missing or empty prompt file spawns nothing and `watch` sees a dead pid.
- **The Write tool, never a heredoc and never `printf`.**

Then `watch` again exactly as in step 4, with `--jsonl` pointed at the new transcript and `--pid` at the pid you just recorded. When it exits, inspect the
retry's own transcript — never the first session's, which this step's first call already read:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" inspect <id> --jsonl "<dir>/logs/<id>-retry-1.jsonl"
```

The session id comes from `status --json` (recorded by `watch`); a null there means the session died before its init event ever landed, and there is nothing to
resume — a fresh dispatch is the only retry available. With no channel to ask through, do not guess:
`attention <id> --kind parked --detail "<what happened, your words>"` plus `stage <id> parked`, keep the worktree and branch, and continue with the next item.
Skipping is `stage <id> skipped --note "<why, your words>"` — your own short reason, under the same rule as the detail beside it. Stopping the run is
`finish --status failed` after parking this item.

## 6. Commit — the orchestrator's job, still never execute's

Execute's hard limit is unchanged and still true inside the session: it never commits and never pushes, because staging inside a tree it does not own can sweep
up work it knows nothing about. Here that reasoning does not apply — the worktree contains this item's work and nothing else, which is the whole point of
creating one — so the orchestrator commits, and says so in the commit body:

```bash
git -C "$PWD/.worktrees/<id>" add -A
git -C "$PWD/.worktrees/<id>" commit -m "fix(board): stop the launch sheet dropping a fast model change" -m "Item: bug-7
Committed by backlog-orchestrate on behalf of the headless backlog-execute session."
```

Conventional-commit subject, derived from the item's own title, in the type that matches the item (`fix:` for a bug, usually `feat:`/`refactor:`/`chore:` for a
task). The body names the item id and names the orchestrator as the committer, so `git log` never implies a human read this diff before it existed — a reviewer,
and the user reading history next month, both need to know which commits arrived unattended.

`add -A` is safe _here specifically_: the worktree holds this item's work and nothing else. Never run it in the main tree. "Nothing else" is a claim §4 has to
keep true, not a property of a fresh checkout — this run may itself have written scaffolding into the tree to make verification possible, and §4's `info/exclude`
list is what keeps that scaffolding out of this `add -A`. A run that adds a new piece of scaffolding adds it to that list in the same edit.

## 7. Review

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> reviewing
```

Dispatch the plugin's own reviewer, `backlog-manager:backlog-reviewer`, with the four fields its input contract requires and nothing else:

- `worktree` — `"$PWD/.worktrees/<id>"`
- `branch` — `backlog/<id>`
- `base` — this run's base branch (`main` unless `--base` said otherwise). The reviewer takes every diff against it, so handing `main` to a `--base` run would
  have it review that branch's whole divergence instead of this item's work — a much larger diff that still looks legitimate. Both halves of this pair are
  pinned by a test; change neither alone.
- `item file path` — the item's absolute path _inside the worktree_. Tracker: `<dir>/items/<n>.md`, the snapshot §5 wrote (`references/tracker.md` §7).
- `report path` — `<dir>/reviews/<id>-1.md` (`-2` on the second loop)

That agent writes its full report to the report path and returns only `verdict: approve` or `verdict: fix` plus its Critical/Important findings, one line each.
Do not re-state that contract in the dispatch prompt as if it were optional, and do not ask for a summary in the message — the contract lives in the agent
definition precisely because prompt-side copies of it have historically lost to generic reviewer templates, and a run of ten items cannot afford ten full
reports in this session's context.

- **`verdict: approve`** → straight to Verify.
- **`verdict: fix`** → one fix loop. Spend it on the run file first, and read the count back:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> fixing --fix-loop
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" fix-mode <id>
  ```

  `--fix-loop` is the only valueless flag on `stage`; it increments this item's `fixLoops` and echoes the new value back, so the line prints
  `{"id":"<id>","stage":"fixing","fixLoops":1}`. The second line, on the same invocation so it costs no turn, decides how this loop is spent and prints
  `{"id":"<id>","mode":"resume"|"fresh","from":…,"loop":…,"sessionId":…,"peak":…,"threshold":150000}`. Copy its `mode` and `sessionId`; never compare the
  numbers yourself. It reads the item's last recorded session (the last entry `usage` wrote — execute, retry or an earlier fix loop) and answers `fresh` when
  that session peaked at or above the threshold or has no id to resume, `resume` otherwise, including when no peak was recorded.

  `fix-mode` decides fresh or resume, and the decision is the tool's so that a `--resume`d driver reaches the answer the crashed one would have, from the run file
  alone (`references/rationale.md`, §7).

  **`mode: "resume"`** → **write the reviewer's findings, verbatim, to `<dir>/prompts/<id>-fix-<n>.txt` with the Write tool** —
  `<n>` being the `fixLoops` value that line just echoed back, so a second loop keeps the first one's prompt beside its own rather than over it — and resume the
  session `fix-mode` named with step 5's retry line, its `<sessionId>` taken from the `fix-mode` line rather than from `status --json`: that is the session
  whose peak `fix-mode` just judged, so the id resumed is always the id the decision was about. Unchanged but for the names that carry this loop's `<n>`, and
  every one of them does: the prompt file it reads (`<dir>/prompts/<id>-fix-<n>.txt` in place of `<id>-retry-1.txt`, in the `test -s` guard and the `$(cat …)`
  alike), the transcript it writes
  (`<dir>/logs/<id>-fix-<n>.jsonl`), the stderr beside it (`<dir>/logs/<id>-fix-<n>.err`) and the session name (`-n "orch <id> fix <n>"`). The rule is one
  substitution, applied everywhere `retry 1` appears, so a second loop never overwrites the first one's evidence — the `.err` included, which is where this
  whole item's symptom was found. Every flag it carries comes too, `--verbose` among them.

  **`mode: "fresh"`** → a new headless session, not a resumed one, that starts from the findings instead of from the executor's whole context. Write
  `<dir>/prompts/<id>-fix-<n>.txt` with the Write tool, holding, in this order: one sentence saying this is a fix loop dispatched by `backlog-orchestrate` in an
  unattended run, with no user to ask; "Never commit, push or merge."; the reviewer's findings, verbatim; the full report path (`<dir>/reviews/<id>-<k>.md`, the
  one this verdict came from); the item file path the reviewer read (the worktree item file; Tracker: `<dir>/items/<n>.md`); this run's base
  branch, with the instruction to read `git diff <base>...HEAD` and the files the findings name before changing anything, and nothing wider; the verification
  commands to re-run, copied from the item's `## Outcome`; where to append a `### Fix loop <n>` record of what it changed and the command output that proves it
  (the worktree item file's `## Outcome`; Tracker: `<dir>/outcomes/<n>.md`); "Anything you cannot resolve goes in your final message, not to a
  person."; and last, word for word, "Never run a command in the background, and never end a turn with one still running; run tests, typecheck and build in the foreground. One exception: a dev server for Playwright browser verification, its pid recorded in the call that starts it and killed by that pid, never by pattern, before the turn ends." In those two tracker paths `<n>` is the issue
  number, not this loop's count (`references/tracker.md` §7). Never paste the diff into it — a large diff in the
  prompt is exactly the context this mode exists to avoid, and the findings name `file:line`, which is what a narrow read needs. Then launch:

  ```bash
  nohup sh -c 'LOCAL="$PWD/.claude/settings.local.json"; [ -f "$LOCAL" ] || LOCAL=; cd "$PWD/.worktrees/<id>" && test -s "<dir>/prompts/<id>-fix-<n>.txt" && BM_ORCH_RUN=<runId> exec claude -p "$(cat "<dir>/prompts/<id>-fix-<n>.txt")" ${LOCAL:+--settings "$LOCAL"} --output-format stream-json --verbose --permission-mode auto --model opus -n "orch <id> fix <n>"' > "<dir>/logs/<id>-fix-<n>.jsonl" 2> "<dir>/logs/<id>-fix-<n>.err" &
  echo $! > "<dir>/logs/<id>.pid"
  ```

  Step 5's retry line without `--resume`, and every one of step 5's three details holds for it unchanged. It carries no `[orchestrator-run` marker and no
  `/backlog-execute` trigger: in a files project execute has already moved the item to `done/` and refuses a done item, so the prompt file is the whole brief.
  The transcript, `.err` and session name are the resume mode's, so `usage` records it as `kind: 'fix'` exactly as before and `watch` overwrites the item's
  session id with the fixer's — which is what the next loop's `fix-mode`, and `references/recovery.md`'s `resume-session`, then resume.

  **Both modes continue identically.** `watch` it out as in step 4, **check that transcript for denials before committing anything**, commit again (step 6), in
  a tracker project re-run §5's `snapshot <n>`, and review again with a fresh report path (`<dir>/reviews/<id>-2.md`).

  **The findings reach that file as the reviewer wrote them** — they name `file:line`, and paraphrasing them into "fix the review comments" hands the session a
  puzzle instead of a task. That verbatim copy is the whole reason the prompt is a file rather than an argument: reviewer prose is the text most certain to carry
  the backticks, `$(…)` and apostrophes §4's rule is about.

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" denials --jsonl "<dir>/logs/<id>-fix-<n>.jsonl"
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" usage <id> --jsonl "<dir>/logs/<id>-fix-<n>.jsonl"
  ```

  The second line is the same usage write `inspect` does in step 5, on this loop's own transcript — one entry per transcript, so it lands beside the first
  session's rather than replacing it, and "the fix loop cost more than the item did" stays an answerable question. Both lines go in one invocation so they cost
  no extra turn.

  **This is the same gate step 5 runs, and it is not optional here.** A fix loop is a headless session under `--permission-mode auto` exactly like the first
  one, so it can be refused a call exactly like the first one — and this path reaches Commit without passing through step 5, so nothing else on it would ever
  look. A refused fix session is the worst-placed denial in the whole loop: it has already been told what is wrong, so whatever it produced instead of the
  refused command looks like a response to the review, and the next reviewer reads a diff that was shaped by a command that never ran. A non-zero `count` means
  **do not commit this loop's work** — treat it as the fix loop failing, and take it to the exhausted-loop path in `references/check-failures.md` rather than spending the second loop on a
  session that was not actually able to work.

**At most two fix loops per item, counted in the run file — not in your own head.** `fixLoops` is what `--fix-loop` maintains, and reading the ceiling off it
(from the echoed value, or from `status --json`) is what makes it survive the thing most likely to break it: a crash and a `--resume`, after which the session
that was counting is gone and a fresh one takes over an item that has already burned both its loops. A ceiling held in a session's memory silently resets there;
one held in the run file does not. It is also the number the run drawer renders, so an item that took two loops says so afterwards.

When a second review says `fix` (`fixLoops` is now `2`), stop looping and read `references/check-failures.md` in full: the item is handed to a human, never
merged silently because the loop ran out — "merge anyway" is a decision a person makes, not a default — and that menu belongs to an unresolved review verdict
and to nothing else.

## 8. Verify

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> verifying
mkdir -p "<dir>/verify"
rm -f "<dir>/verify/<id>.status" "<dir>/verify/<id>.out" "<dir>/verify/<id>.pid"
nohup env BM_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" BM_RUN_DIR="<dir>" sh -c 'node "$BM_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" verify <id> --cwd "$PWD/.worktrees/<id>" > "$BM_RUN_DIR/verify/<id>.out" 2>&1; echo $? > "$BM_RUN_DIR/verify/<id>.status"' > /dev/null 2>&1 &
echo $! > "<dir>/verify/<id>.pid"
```

**All four lines in one Bash call**, and the `rm -f` in particular must never be skipped or split off — see the first detail below for what it is actually
preventing.

**Detached, for the same reason the session in step 4 is.** A baseline suite is the one step in this loop with no upper bound, and a Bash call cannot outlive
ten minutes. Run inline, a suite that outruns the call is killed mid-flight and `verify` writes no exit code at all — an undefined state at the merge gate,
unattended. Detached, the ten-minute ceiling applies only to the polling, which is built to be re-called. (`references/rationale.md`, §8.)

Five details in those lines, none of them the same as step 4's:

- **`rm -f` first, and it is a merge-gate rule rather than housekeeping.** `<dir>` belongs to the _run_, not to the attempt: nothing removes these three files
  afterwards, so a second attempt would inherit the first attempt's `.status` verbatim. Both "the verification did not finish" branches at the end of this
  section are predicated on that file being **absent**, so from the second attempt onward neither could fire — and the failure that produces is a green merge
  gate on a verification that never finished. Second attempts are ordinary here, not exotic: §9 parks an item _after_ a green verify, and the next run resumes
  it at Inspect. `.out` and `.pid` are cleared on the same rule. **If you ever find yourself reading a `.status` you did not clear moments earlier in the same
  call, it is not this attempt's answer — treat it as absent and start the block again.** (`references/rationale.md`, §8, has the full chain and why step 4
  needs no equivalent.)
- **No `exec`, unlike the dispatch line.** The pid recorded here is deliberately the wrapper `sh`, because the wrapper is what outlives `node` long enough to
  write `.status`. `exec` would replace it and the exit code — the one thing this whole step exists to produce — would be lost.
- **Named `env` variables inside the quotes, never a positional.** The quotes must stay single so `$?` reaches the inner shell rather than this one, which rules
  out interpolating anything into them from this shell; `env` sets both names for the child instead. **Never pass them positionally.** Slash-command argument
  substitution rewrites positional parameters in this file before the session reads it, fenced code included — it has corrupted this exact line in a live run.
  Keep the plugin root and the run directory in `BM_PLUGIN_ROOT` / `BM_RUN_DIR`, and do not reintroduce a positional anywhere in this file. `$PWD` needs none of
  this care, which is why step 4's line uses it directly. (`references/rationale.md`, §8.)
- **`BM_RUN_DIR` also retires the `<dir>` placeholder inside this command.** Substitute `<dir>` once, into `env`, never into the quoted body. §5's retry
  launcher pastes `<dir>` several times and cannot take this treatment (its body is single-quoted so `$(cat …)` runs in the child); there the `test -s` guard
  and the `$(cat …)` name the same file, so a mismatched paste spawns **nothing** rather than reading the wrong prompt (`references/rationale.md`, §8).
- **The tool still runs from the project root.** `nohup` inherits this session's cwd and there is no `cd` anywhere in the line; the worktree is named by
  `--cwd`, which is exactly what that flag is for (see "Where commands run" at the top of this file).

Then poll it out, with the same maximum Bash timeout step 4's `watch` needs (`timeout: 600000`), as many times as it takes — exit `3` means "still running, call
me again", exactly as it does there:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" watch <id> --pid "$(cat '<dir>/verify/<id>.pid')" --jsonl "<dir>/verify/<id>.out"
```

Yes, `watch` — the same command, doing the same three jobs: sleeping inside node rather than in the shell, returning `0` the moment the pid is gone, and
heartbeating the run every interval, which is what stops a long suite making the board call a perfectly healthy run stale. Its `--jsonl` is a required flag
whose only purpose is finding a session's `system`/`init` event; `verify`'s log has none, so that lookup finds nothing and writes nothing. Pointing it at the
log satisfies the flag with a file that genuinely exists, which is all its missing-file check (exit `1`) is really testing for.

Then read the exit code out of the file, never off the poll:

```bash
cat "<dir>/verify/<id>.status"
```

`verify` resolves the project's baseline commands from `<worktree>/backlog/verify.json`'s `commands` array, or failing that from the obvious `package.json`
scripts (`test`, `typecheck`, `build`, only the ones that exist, run with `pnpm` when the project is pnpm-managed), unions them with the fenced commands under
the item's own `## Done when`, runs every one of them in the worktree, and records `{cmd, ok, tail}` rows onto the queue item. Every command runs even after one
fails — a red first command must never hide a second, independent failure.

This re-runs checks execute already ran, on purpose: a fix loop may have changed the code after execute's own verification, and green _here_ is the merge gate.

Both of the first two branches below read "the file is not there", which is only ever true because the `rm -f` above made it true. That is why it is in the same
call as the launch.

- **no `.status` file yet** — the verification has not finished. Either `watch` came back `3` and the suite is still going, or the poll itself was cut short.
  Poll again. **This is never a merge**, and it is never a failure either: it is the absence of a result.
- **the pid is gone and there is still no `.status`** — something killed the verification (the machine slept, a human `kill`ed it, the OS ran out of memory).
  Nothing was proved, so nothing is merged. Re-run the whole block above from the top, `rm -f` included — that line is what makes the next attempt's answer its
  own. It is both safe and the only recovery. `verify` writes its rows in a single atomic write _after_ every command has finished, so an interrupted run leaves
  the run file exactly as it found it and a fresh attempt simply appends a fresh set of rows — the merge gate never sees a half-written verification, only a
  complete one or none. **The gate is the exit code of the last attempt that produced one**, and no `.status` means there is none.
- **exit `0`** — every command passed. Merge.
- **exit `1` or `5`** — when `verify` exits non-zero, read `references/check-failures.md` in full. Red rows feed a fix loop that shares §7's two-loop ceiling;
  when the ceiling runs out with verification still red the item parks, with a channel or without one; exit `5` (nothing to verify with) parks at once. **Never
  merge red** — nothing green-lights a merge except the commands passing.

## 9. Merge — the only door into the base

**In `branch` mode this whole section collapses to two commands. Take them and skip the rest of it:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> branched
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" cleanup <id>
```

**In a tracker project, one command comes first** — the branch is pushed before the worktree that holds it is removed:

```bash
git -C "$PWD/.worktrees/<n>" push -u origin backlog/<n>
```

The issue stays **open**, and a failed push **parks** the item exactly as a failed merge does — `attention <n> --kind parked` naming git's message, then
`stage <n> parked`, worktree and branch left where they are (`references/tracker.md` §9, _branch mode_).

No `stage <id> merging` and no `merge-check` — nothing is merging. Everything `merge-check` does (the base tree, the `symbolic-ref` precondition, the dirty-path
probe) exists to protect a write to the tree holding the base, and there is no write. And **no `git branch -d`. The branch is the deliverable**, the only copy
of this item's work anywhere; `cleanup` runs none on this path. If it prints `removed` as anything but `ok` the item stays `branched` and is never re-staged —
the end of this section says what each value means — and carry on.

`branched` is a success exit in the same terminal position `merged` occupies: the item is finished and the run holds nothing. The pairing is enforced by the
tool, not by this sentence — `stage <id> merged` under a branch-mode run exits `1` and writes nothing.

The next item still branches from an **unchanged base**, so two items in this run that touch the same files produce two branches that will conflict with each
other at hand-merge time. That is inherent to not merging; the run cannot fix it and must not pretend to. §10's summary names the merge order and flags the
overlapping pairs, and that is the whole of what can be done here.

**Everything below is the `merge` path.**

### Find the base tree and test both preconditions — one call

The merge happens in whichever tree has `<base>` checked out, which on a `--base feature/x` run is not the main tree; merging in the wrong one writes an item
into a branch nobody asked for.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" merge-check <id>
```

It stages the item `merging`, finds the tree that has `<base>` checked out (creating `.worktrees/_base-<sanitised base>` when none does), tests both
preconditions there, and prints `{ verdict, baseTree, created, paths?, detail? }` with exit `0` for every verdict. **`<base tree>` below is that `baseTree`.** A
non-zero exit is no verdict: `10` is a stop request (`references/stopping.md`), `7` is another session driving the run (stop at once), the rest say what to fix.

| `verdict` | Meaning                                                                | You do                                                                 |
| --------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `merge`   | both preconditions hold                                                | merge, below                                                           |
| `park`    | one failed; the tool wrote the `parked` entry and the stage (`detail`) | nothing; next item                                                     |
| `overlap` | `paths` are dirty in `<base tree>` and the branch touches them         | read `references/merge-failures.md`                                    |

**Never check out `<base>` in the user's tree, and never stash, commit or check anything out on their behalf** — their uncommitted work is theirs, and this
run's authority stops at worktrees it created itself. **The run removes a base worktree only if it created it** (`created: true`); `merge-check` records
`baseTree: { path, created }` on the run so §10 and a resumed session read it from `status --json`, not from memory. (`references/rationale.md`, §9, has the
three outcomes and why `--force` is never the way round.)

On `merge`, merge:

```bash
git -C "<base tree>" merge --no-ff --no-edit backlog/<id>
```

`--no-ff` so every item is one identifiable merge commit in the base's history even when it could have fast-forwarded; `--no-edit` so no editor opens in a
session that has no terminal to open one in. The explicit `-C` is what makes this land in the base tree — the version of this command before run-scoped bases
had none and relied on the main tree being the cwd, which is true only while the base is `main`.

**In a tracker project the merge carries `Fixes #<n>`, and `--no-edit` gives way to three `-m` flags:**

```bash
git -C "<base tree>" merge --no-ff -m "Merge backlog/<n>: <title>" -m "Fixes #<n>" -m "Reviewed: approve (reviews/<n>-<k>.md)" backlog/<n>
```

`<k>` is the loop that approved it, `1` or `2`; the `Reviewed:` line is what shows the classifier the review (Tracker: `references/tracker.md` §9,
_the merge's shape_).

**The merge is one Bash call of its own: the driver never chains `git merge` with anything else** — not the push, not an `echo`, not the stage. There is one
classifier verdict per Bash call, judged over the whole call, and the failure it produces decides which path the item takes: a denied merge degrades the run,
a denied push parks the item. Chain them and the push's question is answered as a merge denial — in run-20260923-154625 (claude-agents-dashboard)
`git merge …; git push origin main` in one call was denied as `[Merge Without Review]` for an item whose review had approved it, and the run degraded to
branch mode for the rest of its queue. Read the merge's exit status from the tool result, then issue the push (tracker) as the next call.

**If the merge call does not succeed, read `references/merge-failures.md` in full before issuing anything else.** It tells three failures apart — a permission
denial of the call itself, a pre-merge refusal and a conflict — and gives each one its own commands. **Only the first degrades the run to branch mode; the other
two park the item**, with the worktree and the branch kept. The same file holds the worktree-side resolve, which brings a moved `<base>` into the item's
worktree and re-verifies there before merging out: when `merge-check` prints `verdict: overlap`, read `references/merge-failures.md` too.

**Undoing a merge that already completed is `git revert -m 1 <merge-sha>`, never `git reset --hard`.** `reset --hard` was measured destroying an unrelated,
uncommitted modification in the main tree along with the merge, unrecoverably; the same undo by revert left it byte-for-byte intact. An unattended run can never
rule out that the user has uncommitted work in the tree it is writing to, so the noisier history is the price, knowingly paid. `-m 1` names the first parent —
`<base>` as it was before this merge. (`references/rationale.md`, §9, has the measurement.)

**On success**, record it and clean up:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> merged
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" cleanup <id>
```

**In a tracker project the push comes between the merge and the stage, and the order is not negotiable** — as its own Bash call, never chained onto the
merge (above):

```bash
git -C "<base tree>" push origin <base>
```

- **It succeeds** → `stage <n> merged --outcome "<dir>/outcomes/<n>.md"` in place of the plain `stage` above; the flag is required here and is what closes the
  issue (a refused close exits `9`: park it).
- **It is rejected** (non-fast-forward) → park the item; never `push --force`, never reset.
- **It is denied by the auto-mode classifier** → **park it too**, never `branched`: unlike a denied merge, which degrades the run to branch mode, this one
  follows a merge that has already landed.

Tracker: `references/tracker.md` §9, _the push and its three outcomes_, has each outcome's `attention` detail and why the close rides the stage.

`cleanup <id>` runs after the stage (and, in a tracker project, after the push) in both modes. It removes the item's worktree with a plain `git worktree remove`
— **never `--force`**: the one state `--force` would work in, a tree holding something never committed, is the one state it must never be used in — and on the
merge path only it then deletes `backlog/<id>` with `branch -d` from the base tree and reads the merge commit there for the runner-fix pickup below. It prints
`{ removed, branchDeleted, branchMergedIntoBase?, runnerFix }`. A non-zero exit is no result: `1` says the item is not `merged` or `branched`, or that no
`merge-check` recorded a base tree, and nothing was changed.

**The item stays `merged` whatever `removed` says.** The `stage` above landed and was true — the branch is in the base — so never re-stage it to `parked`:
`removed` only says whether a human is paged.

- **`ok`** or **`deleted`** — nothing further, and say nothing about it. `deleted` is a delete git began and could not finish, which `cleanup` finished and
  checked; nothing here needs a human.
- **`leftovers`** — something never committed sat in the worktree. `cleanup` recorded the `parked` attention entry and left the directory and the branch alone;
  a human deletes it after looking. Carry on to the next item.
- **`failed`** — the worktree could not be removed and `cleanup` recorded the `parked` attention entry with the reason. Carry on.

`branch -d` runs in the base tree, never `$PWD`: a refusal says something only about the tree it ran in. When `branchDeleted` is `false` and `branchMergedIntoBase`
is present, `false` means the merge you think happened did not — stop and understand that before the next item builds on a base you may have misread — and
`true` means the merge is real and the refusal had another cause — `cleanup` asked `git branch --merged <base>` (`references/rationale.md`, §9). The general
rule: every cleanup command that follows a merge belongs in the tree that merge happened in.

Then the next item starts from the updated `<base>`, so later items build on earlier ones. On a `--base` run that is the whole point: item by item, a phased
feature accumulates on its own branch and `main` is never written until a human decides it should be.

### After a runner-fix item lands

After every merge, read `runnerFix` from `cleanup`'s output — it diffs the merge commit in the base tree. When `cleanup` prints `runnerFix` with `skill` or
`cli` true, the item that just merged changed the runner itself: read `references/merge-failures.md` in full. It says which copy of the prose and of the tool
the rest of this run follows, and the `--note` that records the switch. **Prose and tool move together or not at all**, and a resumed session re-derives the
switch from that note (`references/recovery.md`). Both false, with no `runnerFixError`: nothing to do. `runnerFixError` present means unknown, never "no
runner fix": run `git -C "<base tree>" diff --name-only HEAD^1 HEAD` by hand and read it the same way.

## 10. Finishing, resuming, aborting

### Finishing

When the queue is drained:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" finish --status done
```

**If `status --json` shows `baseTree.created: true` (§9's `merge-check` made it), remove that worktree first — and only if `created` is true.** It is read from
the run file, never from memory of the run's earlier turns: a resumed session reads it the same way.

```bash
git -C "$PWD" worktree remove "$PWD/.worktrees/_base-<sanitised ref>"; echo "remove=$?"
```

(`<sanitised ref>` spells `baseTree.path`'s last segment, which is the one `merge-check` made.)

Plain `remove`, never `--force`, exactly as the item worktree's own removal is. A removal that does not exit `0` is recorded in the summary and **does not fail
the run** — the items merged, the base holds their work, and a leftover directory is a tidying job rather than a reason to report a red run. Say the path out
loud in the summary so whoever tidies it knows which one it is. A base worktree the run did **not** create is never touched here, however convenient it looks:
it is someone's working tree, and this run's authority stops at worktrees it created itself.

`--status` takes `done`, `aborted`, `failed` or `paused`; anything else exits `1`. Tracker: `finish` also stamps that status on the last-touched claim and the tool
keeps `orchestrator:queued` by itself — best-effort, nothing to run (`references/tracker.md` §10). Then summarise for the user from `status --json`: what merged or branched,
what parked and why, what was skipped as `ungroomed` or `needs-answers` and therefore wants a groom pass before the next run. A clean item — no fix loops, no
retries, green first try — should have produced no ping at all along the way; the summary is where it finally gets mentioned.

**Any item that finished `branched` owes the user a merge list.** Name those branches in queue order — each was verified against the base its predecessor
started from, and one carried over from an earlier run (§3's own recognition step) against that run's — with the literal command per branch, and say which
branch to run it on when the base is not `main`:

```bash
git merge --no-ff backlog/<id>
```

Then flag the pairs that will fight: two branches that touch a common path mean a conflict for whichever is merged second, regardless of which base commit
each one actually started from — a carried-over branch (§3) can predate this run by days, and a run that downgraded mid-queue means the base itself moved (the
items that merged before the denial) before it froze. Write each branch's paths into the run's own `<dir>` and intersect them — the three-dot diff each file is built from
is merge-base relative, so it isolates each branch's own changes correctly regardless of any of that:

```bash
git -C "$PWD" diff --name-only <base>...backlog/<id> | sort > "<dir>/verify/<id>.branch-paths"
comm -12 "<dir>/verify/<a>.branch-paths" "<dir>/verify/<b>.branch-paths"
```

And when `mergeModeEffective` is `branch` while `mergeMode` is `merge`, say so **once**, run-level, quoting `mergeModeNote` verbatim: the run wanted to merge
and was refused, the work is green, and those branches are what it produced instead. Not per item — one classifier verdict is one fact. A downgraded run still
finishes `--status done`; nothing about it failed.

Long steps in between deserve a heartbeat. `watch` stamps one every interval — through the dispatched session in step 4 and through the detached verification in
step 8, which is precisely why neither of those two can make a healthy run read as stale any more — but review and merge still can outlast the fifteen-minute
freshness threshold on their own, and a run whose heartbeat goes stale reads to the board (and to a later `init`) as crashed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" heartbeat
```

Tracker: `heartbeat` also heartbeats every claim the run still holds; nothing extra to run (`references/tracker.md` §10).

### Pausing and stopping

When any call exits `6` or `10`, read `references/stopping.md` in full. `6` means a pause was requested: the run finishes `paused` at the item boundary. `10`
means a stop was requested: the run ends with `abort`, and nothing resumes a stopped run. Neither is retried, worked around or asked about; both end the turn
after the summary.

### `--resume` and `--abort`

**Both begin by reading `references/recovery.md` in full, before any other command.** That file carries the whole of both paths: `reconcile`'s four verdicts and
what each one means, the ruling that a resumed session's dead marker is billed with a plain `stop` rather than `--abandon` (deliberately the opposite of what
`backlog-groom` prescribes for a marker that looks identical), and abort's order-of-operations, which is its entire safety property.

The board may spawn `--resume` itself for a run whose heartbeat has gone stale, so this path is entered unattended and must stay safe to enter that way — which
it is, the only write before `reconcile`'s verdicts being `claim` re-stamping `updatedAt` on a run `status` has just confirmed is `running`, the identical stamp
the run's own loop writes on every turn, gated by `status` alone so a finished run is never re-stamped.

`claim` also records **which** session is driving the run, and that half is not optional: a resume can arrive from this app's own board and from the dashboard's
session-resume at once, and nothing outside the run file can see both. If `claim`, or any later write, exits `7`, another session took the run over — stop
immediately, write nothing more, and exit. `references/recovery.md` has the mechanism and why the loser stopping on the first refusal is the whole guarantee.

Two rules stay here, because a reader who stops at this line still has to know them:

- **`--resume` starts from what is on disk, not from what the run file hoped.** `orchestrate.mjs reconcile` is read-only and prints one of five suggestions per
  item (`skip` only in a tracker project, for an item another run's live claim now holds); deciding what to do with each is this skill's job, not the tool's.
- **A resumed run takes its base from the run file, and re-resolves the base tree before its next merge.** The base itself is fixed — `status --json` carries
  it, and it is never re-derived from a flag the person resuming happened to type — but *which tree holds it* is a fact about right now, and the interruption is
  exactly the gap in which someone checks the base out somewhere else, removes the worktree that had it, or leaves a rebase half-finished in it. Run
  `merge-check` as usual — it re-resolves rather than reusing a path from before the interruption — and the `baseTree` the interrupted run recorded stays in the
  run file for §10's cleanup (`references/recovery.md`).
- **`--abort` runs before any marker is cleared, never after.** Clearing a mid-flight item's marker first makes `abort` classify that item as safe and
  `git worktree remove --force` it — which deletes uncommitted work that was never committed and never staged, with no reflog entry to recover it from.

- **`--abort` in a tracker project gives every claim the run still holds back**, with the reason `aborted`, before it ends the run — the tool does it,
  best-effort (`references/tracker.md` §10).

`--abort` ends a run; it never undoes one. Everything already merged stays merged.

## Hard limits

- **Sequential, always.** One item in flight, start to finish, before the next begins. No flag enables parallel items; one worktree and one session at a time is
  the isolation, and parallelism forfeits it (§2).
- **Never merges red.** Verification failure parks the item exactly like a conflict does. Nothing green-lights a merge except the commands passing — not a clean
  review, not a confident `## Outcome`, not "the failure looks unrelated."
- **Branch mode never writes the base, and a denied merge never parks.** The mode is set at `init`, applies to the whole queue, and only ever moves one way
  afterwards (`merge` → `branch`, never back — §2, §9). `branched` is a success exit, not a failure — the tool refuses `stage <id> merged` under branch mode so
  the run file cannot say otherwise.
- **The merge site is derived, never assumed: merge in whichever tree has `<base>` checked out, and remove only a base worktree this run created.** git
  refuses one branch in two trees and `--force` is not the way round it (§9). A tree the person made is theirs — the same sentence as "this run's authority
  stops at worktrees it created itself", not a second rule beside it.
- **Never force-pushes and never rewrites the base's history.** Merge commits only; undoing one is `git revert -m 1`, never `git reset --hard` (step 9).
- **Never pushes a files project.** Publishing that is the user's call. **A tracker project is the one exception, and it is exactly three commands** —
  `pull --ff-only origin <base>` before each item's worktree, `push origin <base>` after each merge, `push -u origin backlog/<n>` under branch mode (why:
  `references/tracker.md`). A rejected or classifier-denied push **parks**, never degrades: the merge has already landed, so `branched` would be a falsehood.
- **Never writes the registry.** `~/.backlog-manager/registry.json` keeps its single writer (`backlog.mjs` `init`/`new`), untouched by anything here.
- **Item bodies: pre-flight answers only.** Nothing else in the item lifecycle belongs to this skill — `start`, `## Outcome`, and the archive move all belong to
  `backlog-execute`, inside the session, and the plan belongs to `backlog-groom`. The single exception is the dead-marker `backlog.mjs stop` in the resume and
  abort paths, which clears a marker the session that set it is no longer alive to clear; it goes through the tool, never through an edit of the file.
- **The run file is written only through `orchestrate.mjs`.** Never hand-edit it, never `rm` it to get past an exit `4`, never write it from the server or the
  client. One writer, one reader — the same relationship the registry has.
- **`orchestrate.mjs` runs from the project root, always** (see the top of this file). Worktree-scoped work goes through `--worktree`, `--cwd` and `git -C`.

## Next

`/backlog` shows the board with every merged item archived — but a `branched` item still reads as open there, because its archive move is committed on
`backlog/<id>` and lands only when that branch is merged. **Merge those branches before the next run**: until you do, those items stay open and the next run
queues them again (it recognises the shape and passes them through untouched, §3 — but that is a re-report, not progress). Items left as `ungroomed` or
`needs-answers` are a `/backlog-groom` pass away from being ready for the next run; parked items are a human decision, and their branches are still there.
Anything the work surfaced along the way — a new bug, a follow-on idea — is a `/backlog-capture`, not an edit to an item this run already merged.
