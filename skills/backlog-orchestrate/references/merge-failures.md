# backlog-orchestrate — when the merge does not go cleanly

Read this file **in full** when any of these happens, before issuing another command for the item:

- **the merge call does not succeed** — `git -C "<base tree>" merge …` was denied before it reached git, refused by git before it touched anything, or left
  conflict markers behind;
- **`merge-check` prints `verdict: overlap`** — paths the branch touches are dirty in the base tree, so the merge would be refused;
- **`cleanup` prints `runnerFix` with `skill` or `cli` true** — the item that just merged changed the runner itself (the last section here).

Every trigger is an observable result inside the loop, so a fresh run and a `--resume`d or unpaused one reach this file the same way. The merge itself, the
merge-mode probe and every push stay in `SKILL.md` §9 and §2 as literal calls, each its own Bash call.

Section and step numbers below name sections of `SKILL.md`. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace
`${CLAUDE_PLUGIN_ROOT}` with the plugin root the body was loaded with before running any command here.

## A merge that does not succeed

**Three different failures, and they take different commands. Do not conflate them: only the first one degrades the run, and the other two park the item exactly
as they always have.**

**A permission denial** — the command never reached git at all:

```
Permission for this action was denied by the Claude Code auto mode
classifier. Reason: Blocked by classifier.
```

Nothing was attempted, the base is untouched, and **the work is fine** — every step before this one was green and the last step of the pipeline was refused. That
is not something a human must look at, so this item takes the _branch_ outcome instead of a park, and the rest of the queue stops attempting a merge that has
just been shown to fail:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> branched
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" merge-mode branch --note "auto mode classifier denied the merge of <id>"
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" cleanup <id>
```

Then continue with the next item, which now takes `SKILL.md` §9's branch path. `cleanup` keeps the branch on `branched` — no `branch -d`, for the
reason that path gives — and if it prints `removed` as anything but `ok`, handle it exactly as §9's branch path says: the item stays `branched`. (A `merge-mode` exit
`1` saying the run is already in branch mode is the right state, not a failure — a resumed, already-degraded run hits it, and the stage above has already
landed.)

**No `attention` entry here.** The attention list means "a human must look at _this item_", and a green, reviewed branch does not qualify; `ATTENTION_KINDS`
stays the three kinds it has always taken. One classifier verdict is one run-level fact and is recorded once, in `mergeModeNote` — N identical rows would be N
copies of it. The actionable part, the merge command per branch in order, belongs in `SKILL.md` §10's summary.

**A pre-merge refusal** — git declined before touching anything:

```
error: Your local changes to the following files would be overwritten by merge:
	client/src/components/board/ItemCard.tsx
Please commit your changes or stash them before you merge.
```

Nothing was modified, there is no `MERGE_HEAD`, and **`git merge --abort` is the wrong command** — it errors with `fatal: There is no merge to abort`. The tree
is already in the state an abort would have restored. This is what `merge-check`'s overlap verdict is for; reaching it means it was skipped or the tree changed
in the seconds since. Handle it exactly as that verdict does — `merge-check <id> --park-on-overlap` to park with the paths named, or resolve worktree-side — and
issue no `--abort`.

**A conflict** — the merge started and left markers behind:

```bash
git -C "<base tree>" merge --abort
```

then `attention <id> --kind parked --detail "merge conflict with <base> — worktree and branch kept"`, `stage <id> parked`, keep the worktree and the branch
exactly as they are, and continue with the next item. A conflict means the base moved under the run (the user pushed, or an earlier item in this same run
touched the same lines); resolving it is a human's judgement call, and the branch is the thing that makes that possible later.

## `merge-check` printed `overlap`, or the base moved under the run

On `verdict: overlap` the tool wrote nothing: the paths it names are dirty in `<base tree>` and the branch touches them, so the merge would be refused. Resolve
on the branch side as below, or park with `merge-check <id> --park-on-overlap`, which records the `parked` entry with those paths named and stages the item
`parked`.

**When the base moved under the run, resolving on the _branch_ side is better than parking — and it is the only option that keeps the merge gate honest.** Those
two failures — the refusal and the conflict, not the denial above them — have the same root cause: `<base>` is no longer the commit this item was verified
against. Merging into it anyway would put content into the base that nothing green ever ran — every individual step was green, and the combination was never
tested. That is a hole in the "never merges red" hard limit which is invisible precisely because nothing reports red. A `--base` run is *more* exposed to this,
not less: a feature branch is likelier to be touched by a human mid-run than `main` is.

So bring `<base>` into the worktree, prove the combination there, and only then merge out:

```bash
git -C "$PWD/.worktrees/<id>" merge --no-edit <base>
```

- **It merges cleanly** — re-run **all of step 8** against the combined content, starting with its `rm -f`. This is exactly the second-attempt case that rule
  exists for, and skipping it reads the first attempt's `0` for a suite that never saw the base's changes. Green, then merge into the base with `SKILL.md` §9's
  `git merge` call, which is now conflict-free. Red, then it is an ordinary §8 failure: a fix loop if the shared ceiling allows one, a park if it does not.
- **It conflicts** — **abort that merge in the worktree first, then park.** The merge ran in the _item's_ worktree, so the conflict branch's `--abort` (which
  targets the _base_ tree) never reaches it, and a worktree left holding markers and a `MERGE_HEAD` is the first thing a human opens:

  ```bash
  git -C "$PWD/.worktrees/<id>" merge --abort
  ```

  Then park exactly as the conflict branch does — `attention <id> --kind parked --detail "merge conflict with <base> — worktree and branch kept"`,
  `stage <id> parked`, worktree and branch kept as they are — and continue with the next item. Resolving real content conflicts is a human judgement call and that
  has not changed; what changed is that this is now the _second_ thing tried, not the first.

Nothing here touches the user's working tree: the merge, the resolution and the verification all happen inside a worktree this run created, which is the same
reason the pre-flight amendment rule insists the item file is only ever edited there.

## After a runner-fix item lands

A merged fix does **not** reach this run on its own. Every skill body and every `orchestrate.mjs` invocation here resolves through the plugin root filled in
at load (`${CLAUDE_PLUGIN_ROOT}`) — the _installed plugin copy_ — while the merge just landed in this repo's base branch. Hoisting the item to the front of the
queue (§1) buys ordering and nothing else unless the run is told, once, to follow the repo's copy for the rest of the run.

So after every merge, `SKILL.md` §9 has you read `runnerFix` from `cleanup`'s output — it diffs the merge commit in the base tree, where `HEAD` means that
commit; on a `--base` run the project root's `HEAD` is `main`, which the merge never touched, and a diff asked there reads some unrelated earlier merge or
nothing at all.

- If `skill` is `true` (`skills/backlog-orchestrate/SKILL.md` is in the merge), re-read that file from this repo's working tree and follow it for the remainder
  of the run. The body you were handed came from the installed copy and cannot know about the fix.
- If `cli` is **also** `true` (`skills/backlog-orchestrate/tools/orchestrate.mjs` is in it too), switch the CLI invocation to the repo copy for the remainder of
  the run as well. `cli` alone, with `skill` false, switches nothing: the switch hangs off the prose.

**Prose and tool move together or not at all.** Following freshly merged prose while still invoking the installed tool is the one genuinely dangerous
combination: the new body may name a flag the old tool refuses. Both come from the same checkout, so taking both keeps them consistent with each other, and
taking neither leaves the run exactly as it was. Never one.

Record the switch on the item that carried the fix, through the note channel that already exists rather than a new field:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> merged --note "runner fix — the remainder of this run follows the repo copy"
```

(or `branched` under branch mode, same note). **No `attention` entry** — `ATTENTION_KINDS` is the closed set of three and means "a human must look at this
item", which a run that successfully picked up its own fix does not warrant.

**A resumed session does not inherit the switch, and has to re-derive it.** The switch is session state; nothing on disk carries it. A run that crashes after
picking up its own fix is continued by a _fresh_ headless session — the board's Resume control, or the server's watchdog resuming it unattended — and that
session is handed the **installed** SKILL.md again, exactly as the first one was. Both halves revert together, so nothing becomes inconsistent; what lapses
silently is the whole point of the marker, at the one moment a broken runner makes a crash most likely. The note written just above is the durable record: a
resumed session that finds any queue item staged `merged` or `branched` carrying that note takes the switch again before it works the rest of the queue.
`references/recovery.md` carries that step for `--resume`.

**None of this substitutes for the sync.** A merged runner fix is inert for the _next_ run either way until this repo's HEAD is pushed and
`pnpm run plugin:sync` has run — git is the publishing boundary. This subsection is a within-run workaround for one run, nothing more.
