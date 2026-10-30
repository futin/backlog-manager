# backlog-execute — the `pr` finish mode

Read this file **in full, once**, when the trigger says `--finish pr` — before Pick an item. An `in-place` session (no `--finish`, or `--finish in-place`)
never opens it, and neither does a session under an `[orchestrator-run` marker: the run owns the worktree, the branch and every git step, so no finish mode is
read there.

In `pr` mode execute works the item in a worktree that holds this item's work and nothing else, and on verified success commits it, has
`backlog-manager:backlog-reviewer` review the commit, pushes the branch and opens one PR into the base. It never merges — a person (or GitHub) does that, and
`backlog-orchestrate` stays the only skill that merges into a base. With `--auto-merge` it arms GitHub auto-merge on that PR and waits for GitHub to merge it
(§8, last; `references/auto-merge.md`) — still GitHub's merge, never this skill's. It never asks "should I push / open a PR?": the trigger already answered
that, and asking is the exact step this mode exists to remove.

Numbered sections follow the flow in order. Everything SKILL.md says that this file does not replace still holds — the refusal gate, dispatch, verification,
both pre-review checks — and is done inside the tree §2 picks. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in:
replace it in any command copied from here with the absolute path SKILL.md's own commands show. `<root>`, `<tree>`, `<base>` and `<id>` are defined where
they are first used; in a tracker project `<id>` is the bare issue number (`31`, never `#31`).

## 1. Resolve the mode

Once, right after the trigger, before `show`, from the tree the session started in. SKILL.md's Finish mode section has already read `--finish pr` out of the
trigger and refused an unknown or doubled `--finish`; this section settles `<base>`.

- **`<base>` is the trigger's `--base <ref>`.** With no `--base`, it is the remote's default branch:

  ```bash
  git symbolic-ref --quiet --short refs/remotes/origin/HEAD
  ```

  It prints `origin/<branch>`: strip the `origin/` prefix, and `<branch>` is `<base>`. It prints nothing — no `origin`, or a clone that never recorded its
  `HEAD` — and `<base>` is `main`. A local git read, in a files and a tracker project alike: no `backlog.mjs` call, so it works with the stack down. Whatever
  the value, §2's first check is what proves a local `<base>` branch exists. That `<base>` is `<base>` everywhere below.
- **An unknown or doubled `--finish` never falls back to either mode:** a quiet `in-place` would skip the PR the person asked for, and a quiet `pr` would
  commit and push where nobody asked for it.
- **It is read once, from the trigger, and never re-read in the new worktree.**
- **State the mode in one line and ask nothing:** `finish mode: pr → PR into <base>`, followed by `, auto-merge` and `, fix` for each of those flags the
  trigger carries — `finish mode: pr → PR into <base>, auto-merge, fix` with both. SKILL.md's Finish mode section has already refused a flag that arrived
  without the ones it needs (`--auto-merge` needs `--finish pr`; `--fix` needs both).
- **A board-dispatched prompt in `pr` mode ends with**
  ``Finish with `--finish pr --base <base>`: the skill commits, reviews, pushes and opens the PR into <base>, and never merges.``
  — the real base in place of `<base>`. That sentence is the trigger's flag, composed server-side from the launch sheet's pickers: its `--finish pr` is the
  same one signal a typed trigger carries, and its `--base` is `<base>`. A board prompt ending in `COMMIT_RULE`'s "commit … Do not push." sentence is an
  `in-place` launch, untouched by this file. Nothing else is a signal: generic commit or PR wording elsewhere in a prompt switches nothing.
- **With the sheet's Auto-merge and Fix if it fails ticked, it ends instead with**
  ``Finish with `--finish pr --base <base> --auto-merge --fix`: the skill commits, reviews, pushes, opens the PR into <base> and arms GitHub auto-merge if the repository allows it, then waits for GitHub to merge it, fixing failing checks and conflicts with <base> meanwhile; the skill never merges itself.``
  — and with Auto-merge alone, the same sentence without ` --fix` inside the backticks and without the ", fixing … meanwhile" clause. The flags count only
  inside the backticks, exactly like `--finish pr`; the prose after the colon describes `references/auto-merge.md` and is no signal of its own. "The skill
  never merges itself" holds: arming auto-merge asks GitHub to merge, and GitHub performs the merge into `<base>`.

## 2. Pick the tree

Before `show`, because `show` resolves the item from the cwd's tree and the item has to be read from the tree the work happens in. With no id in the trigger,
choose one first with `board` from the starting tree — a read — then pick the tree; `show` and everything after it run in that tree.

**First check, ahead of both paths below:** `git rev-parse --verify --quiet refs/heads/<base>` in the starting tree. No local `<base>` branch → stop and
say so, and do not fetch one into existence: the reuse check's `git rev-list --count <base>..HEAD` errors without it, and a new tree is cut from it.

### Reuse the tree you started in — only when every one of these holds

```bash
git rev-parse --path-format=absolute --git-dir --git-common-dir
git symbolic-ref --quiet --short HEAD
git status --porcelain
git rev-list --count <base>..HEAD
```

- It is a **linked worktree**: the first two paths differ. The main checkout is never reused, however clean it is.
- `HEAD` is on a **named branch** — `git symbolic-ref` printed one. A detached `HEAD` is never reused: there is no branch to commit onto, push, or open a PR
  from.
- That branch is not `<base>`. A tree checked out on `<base>` is never reused — the orchestrator's `_base-<base>` tree included — because committing there
  commits to the base, the one branch this mode never writes.
- That branch is not a `backlog/<…>` branch. That namespace is the orchestrator's: its leftover probe reads it, and a commit there turns a run's leftover into
  this session's work.
- `git status --porcelain` prints nothing — no modified, staged or untracked path.
- `git rev-list --count <base>..HEAD` prints `0` — no commits of its own, so everything a later commit carries is this item's work.

All of them → work right there, on its existing branch; `<tree>` is this tree's top level (`git rev-parse --show-toplevel`). If it is **behind** `<base>`
(`git rev-list --count HEAD..<base>` is not `0`), fast-forward it first with `git merge --ff-only <base>` — safe, because it is clean and has nothing of its
own — so the work runs on the current base and a groom committed after the tree was cut is visible.

Any one of them fails → cut a new tree, below. Never "clean up" a tree to make it qualify.

### Otherwise, cut a new one

`<root>` is the main working tree — `git worktree list --porcelain | sed -n '1s/^worktree //p'` — and the new tree is cut from **local** `<base>`, not
`origin/<base>`: local is where a freshly groomed item is committed, the same reason the orchestrator cuts from local base.

```bash
git -C <root> show-ref --verify --quiet refs/heads/execute/<id>
test -e <root>/.worktrees/execute-<id>
git -C <root> worktree add <root>/.worktrees/execute-<id> -b execute/<id> <base>
```

- **The branch `execute/<id>` or the path `.worktrees/execute-<id>` already exists → stop and say so. Never reuse it from here and never delete it** — it may
  hold an earlier session's work. (A person who wants that tree worked can start a session inside it; the reuse rule above then decides.)
- The names are chosen so they never collide with the orchestrator's `.worktrees/<id>` / `backlog/<id>`, whose leftover probe parks an item that has either.
- `<tree>` is `<root>/.worktrees/execute-<id>`.

### Set the new tree up

The same setup the orchestrator gives its own trees (orchestrate SKILL.md §4, _Create the worktree_; `WORKTREE_EXCLUDES` in `orchestrate.mjs`).
`ensureExcludeLines` itself has no verb any tool exposes — its one caller is `orchestrate.mjs init` — so here it is prose:

1. **`.worktrees/` and `node_modules` go into the COMMON git dir's `info/exclude`**, each as a whole line, only when absent — never `.gitignore`, which is
   tracked, and never committed. `node_modules` is **bare**, no trailing slash: the tree gets a symlink, and a directory-only pattern cannot match one, so
   `git add -A` would commit the link as a blob.

   ```bash
   EXCL="$(git -C <root> rev-parse --path-format=absolute --git-common-dir)/info/exclude"
   mkdir -p "$(dirname "$EXCL")"; touch "$EXCL"
   [ -s "$EXCL" ] && [ -n "$(tail -c1 "$EXCL")" ] && echo >> "$EXCL"
   for p in '.worktrees/' 'node_modules'; do grep -qxF "$p" "$EXCL" || printf '%s\n' "$p" >> "$EXCL"; done
   ```

2. **Dependencies: a `node_modules` symlink to the main tree's directory** — set under "Every command runs in that tree" below, because a reused tree needs
   it as much as a new one.

   **Nothing else goes on that list** — not a shim, a scratch config, a build artifact. `info/exclude` lives in the common git dir, so a line added there
   also hides that path in the person's main checkout and in every other tree, and nothing ever takes it out again. A file this session writes into the tree
   only to make verification possible is deleted before §6's commit instead, and §6 stops on any untracked path it cannot attribute.

### A refusal before any work leaves nothing behind

If `show`, the refusal gate, the claim race at `start`, or any other stop before `start` succeeds ends the session after it cut a new tree, remove what it
cut — only the tree and the branch this session made, and only while the branch has no commits beyond `<base>`:

```bash
git -C <root> rev-list --count <base>..execute/<id>
git -C <root> worktree remove <root>/.worktrees/execute-<id>
git -C <root> branch -D execute/<id>
```

The first must print `0`, or nothing is removed. `worktree remove` runs without `--force`; if it refuses, leave both as they are. Either way the refusal message
says so — what was removed, or what was left and where. **A reused tree is never removed**, and its branch is never deleted: neither was this session's to
make. (A fast-forward §2 gave it stays; it moved the branch to a commit the base already has.)

### Every command runs in that tree

`cd <tree> && …` on every later command — `backlog.mjs`, tests, builds, git — never a `--root` flag, and never a path into another tree. `backlog.mjs` keeps
resolving its store from the cwd, so the `backlog.mjs`-writes clause of SKILL.md's "writes only under the repo root `show` resolved" is the one that holds: the
resolved root simply is `<tree>`. The three writes pr mode makes outside it are the ones this file instructs — the new tree and its `.git/worktrees/`
entry, the common `info/exclude`, and `<tmp>`.

**Dependencies, in a new tree and a reused one alike:** a `node_modules` symlink to the main tree's directory — the orchestrator's mechanism, "the
`node_modules` idiom" (`backlog-orchestrate/references/rationale.md` §4). A fresh checkout has none of its own, and the project's tests usually cannot run
without one. A guarded no-op when the link or the directory already exists, so it is safe to run on either path:

```bash
[ -d <root>/node_modules ] && [ ! -e <tree>/node_modules ] && ln -s <root>/node_modules <tree>/node_modules
```

(For a reused tree `<root>` is the main working tree, `git worktree list --porcelain | sed -n '1s/^worktree //p'`, as above.)

## 3. Pick an item, refusal gate, mark in progress, dispatch, verify — unchanged

All of it as SKILL.md says, inside `<tree>`. The "item absent from this tree → refuse" rule now also catches an item groomed but never committed — which is
correct: say to commit the groom first, then remove what §2 cut. An item carrying `inReview: true` is refused by the gate in either mode with
`a PR is open for this item`, naming the PR when it can.

**Tracker: heartbeat across everything below.** A claim reads stale after 15 minutes without one, and a review loop easily crosses that. Run
`heartbeat <id>` before §6's commit, before every reviewer dispatch, right after every verdict, and before §8's push. A refused heartbeat means another
session has taken the item: stop right there — commit nothing more, push nothing — and report the branch and the tree. Nothing is lost at either point:
before §6 the work sits uncommitted in `<tree>`, after it the work is committed on the branch.

The reviewer dispatch in §7 is one blocking call, so no heartbeat lands while it runs. That is accepted: the claim only goes stale (contestable), it is never
released, and the reviewer is bounded — the same race the orchestrator already accepts. Do not split the dispatch to squeeze one in.

## 4. Verification fails

SKILL.md's failure path, nothing more: **no commit, no push, no PR.** The tree is left exactly as it is for the person to look at, and the final message names
the worktree path and the branch.

## 5. Verification passes — archive (files) or hold (tracker)

- **Files project:** SKILL.md's archive step, unchanged — `## Outcome` appended, `stop <id> --keep-started`, `move <id> done`. Those writes land in `<tree>`
  and so in the commit; the item reaches `done/` on `<base>` only when the PR merges.
- **Tracker project: nothing is archived here, and there is no `move` at any point.** The issue closes when the PR merges (`Closes #<n>`, §8). Write the whole
  `## Outcome` — contract-sweep and red-proof lines included — to `<tmp>/outcome.md`. **The claim is held**, heartbeats continuing, through §6-§8; the
  comment and the release come at the end of §8.

**`<tmp>` is this session's own temp directory**, made here in either mode, and every temp file below goes inside it:

```bash
T="$(node -p 'require("os").tmpdir()')/backlog-execute"; mkdir -p "$T"
mktemp -d "$T/<id>-XXXXXX"
```

The path `mktemp` prints is `<tmp>`. It is one directory per session because ids are not unique across projects — `#12` and `task-12` recur in every repo —
and two pr-mode sessions sharing a name would overwrite each other's Outcome, snapshot, review report and PR body. It is outside every repository on purpose,
so `git add -A` can never commit a file this flow writes there.

## 6. Commit

```bash
cd <tree> && git status --short
cd <tree> && git add -A && git commit -m "<subject>" -m "<id>: <one sentence from the Outcome>"
```

`git add -A` is safe here for the reason it is safe in the orchestrator's tree: §2 guarantees the tree holds this item's work and nothing else. Read
`git status --short` first anyway, and make every path in it this item's work: delete a file this session wrote only for verification, and **stop on any
untracked path that cannot be told apart from the work** (a build artifact the project does not ignore, a file another hand left). Stopping commits nothing
and never adds the path to `info/exclude` (§2): the final message lists each such path with the tree and the branch, and a tracker item is released in §7's
shape. `add -A` runs in `<tree>` only — never in a tree §2 did not pick.

**One conventional commit.** Subject: a bug is `fix:`, a task is `feat:`, an optional lowercase `(scope)`, then the item's title — one line. Where the
target repo has a PR-title rule (this repo's `ci / pr-title`; look in `.github/workflows/` and any contributing guide), the subject satisfies it, because it
becomes the PR's title in §8.

## 7. Review

Dispatch `backlog-manager:backlog-reviewer` with all five inputs its contract requires — a missing one makes it stop:

- `worktree` — `<tree>`
- `branch` — `execute/<id>`, or the reused tree's branch
- `base` — `<base>`; it diffs `<base>...<branch>`
- `item file path` — files: the item's absolute path inside `<tree>` (`show <id>` prints it, now under `done/`). Tracker: `<tmp>/item.md`, which this
  session writes — the issue body (`show <id> --json`, its `body`) followed by the contents of `<tmp>/outcome.md` — beside the report.
- `report path` — `<tmp>/review-<k>.md`, `<k>` counting reviews from `1`. Outside the repo, so the commit can never carry it.

Wait for its verdict inside the same turn, and never end a turn waiting on it: a board-dispatched session is `claude -p` and exits when its turn ends. It
returns `verdict: approve` or `verdict: fix` plus one line per Critical/Important finding.

**`verdict: fix` → a fix round, at most two.** Fix exactly what the findings name; run the two pre-review checks over what the fix changed; **re-run the
Outcome's verification commands** and append a `### Fix loop <n>` record — what changed and their real output — under `## Outcome` (files: the item file in
`<tree>`; tracker: `<tmp>/outcome.md`, rewriting `<tmp>/item.md` from it). Commit again in `<tree>` (`git add -A`, a conventional subject naming the
round), then review again with the next report path.

**Do not push** when verification is red after a fix (commit nothing more), or when the review after the second fix round still says `fix`. Report it the way
§4 reports a failure: what failed, the findings, the report paths, the tree and the branch, and the §8 commands for the person who decides the findings are
wrong. Tracker: post the Outcome — the reason it stopped included — with `comment <id> --body <tmp>/outcome.md`, then release with a plain `stop <id>`;
nothing was pushed, so there is nothing for a label to guard.

## 8. Push, open the PR, hand a tracker item to the label

```bash
cd <tree> && git push -u origin <branch>
cd <tree> && gh pr create --base <base> --title "$(git log -1 --format=%s)" --body-file <tmp>/pr.md
```

`<branch>` is §7's. **Never force-push**, in any spelling. A push the remote rejects stops here and is reported with git's own words — nothing after it runs
except the tracker release in §7's shape (comment, plain `stop`), because there is still no pushed work to guard.

The PR body, written to `<tmp>/pr.md`:

- first, a `## What's new` section: one to three lines in the target app's user terms saying what someone using it can now do — no file paths, flags or
  function names — or `None — <reason>` on its own line when the change has nothing user-visible. The commit is `feat:` or `fix:`, so the PR cuts a
  release and this section is its release note; a repo whose CI passes release-kit's `require-notes: true` fails `ci / pr-title` while it is missing or
  empty, which would leave an auto-merge PR waiting forever. Where the target repo's `.github/pull_request_template.md` carries its own guide in that
  section's comment, follow it. The section ends at the next `## ` heading, so everything below goes under a `## Outcome` heading;
- the Outcome summary — what was done, the verification command and the lines of its output that show it passing, the `Contract sweep:` and `Red proof:`
  lines;
- the review verdict, the number of fix rounds, and the one-line summary of every Critical/Important finding the rounds fixed — never a local report path;
- tracker only: `Closes #<n>` when `<base>` is the repository's default branch, otherwise `Refs #<n>` — GitHub only auto-closes from a PR into the default
  branch. The default branch is `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` with its `origin/` prefix stripped (it prints `origin/main`,
  which never equals a `<base>` of `main`; §1's `<base>` fallback strips it the same way), else
  `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.

**No `gh`, not authenticated, or not a GitHub remote** → the branch is still pushed; the final message says the PR was not opened and why, and gives the exact
`gh pr create` command above to run by hand.

**Tracker, after a successful push — whether or not the PR opened — in this order:**

```bash
cd <tree> && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" review <id> on
cd <tree> && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" comment <id> --body <tmp>/outcome.md
cd <tree> && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" stop <id> --keep-started
```

The claim covered the work and the review; the `in-review` label takes over the moment pushed work exists, so no gate — an orchestrator run on any machine,
the board's Run — executes the item again while its PR is open. `--keep-started` is inert in tracker mode; it is the archive spelling. **A failed label write
undoes nothing** — the comment and the release still run — and the final message says the guard is missing, with the `review <id> on` command.

### When a step is refused

- **The permission layer refuses a `git add`, `git commit`, `git push` or `gh` call** (a denial, as opposed to a rejection by the remote): stop the git and
  `gh` steps right there. Never retry it another way — another command, a wrapper shell, the API. Whatever is done stays done (a local commit stays
  committed). **A denial stops only those steps; a tracker item's `backlog.mjs` steps still run, in the shape the push decides.** Before a successful push —
  a denied `add`, `commit` or `push` — that is §7's release: the reason it stopped goes into `<tmp>/outcome.md`, then `comment <id> --body <tmp>/outcome.md`
  and a plain `stop <id>`. After one — a denied `gh` — it is §8's sequence, `review <id> on`, `comment`, `stop <id> --keep-started`, exactly as when `gh` is
  missing. The final message lists the exact remaining git and `gh` commands, in order, to run by hand — and, when the push is among them, `review <id> on`
  right after it, because nothing guards pushed work until the label is on. The board's spawn permissions are not this skill's to change.
- **The remote rejects the push:** stop and report; never force (above).
- **`gh` is missing or not authenticated:** report the command (above).

### Last, with `--auto-merge`: arm it and wait

Only when the trigger carries `--auto-merge`, and only once the PR is open and — tracker — the `review <id> on`, `comment` and `stop <id> --keep-started`
sequence above has run — whether or not the label write succeeded, since a failed one is already reported and undoes nothing — so no claim is held: read
`${CLAUDE_PLUGIN_ROOT}/skills/backlog-execute/references/auto-merge.md` in full and run it now, in `<tree>`, with `<pr>` the number of the PR this section
opened. It arms GitHub auto-merge if the repository allows it, waits for GitHub to merge, and with `--fix` repairs failing checks and conflicts with `<base>`
meanwhile; it never merges itself.

No PR opened — `gh` missing or unauthenticated, a refused or rejected step anywhere above — means there is nothing to arm: skip that file, and the final
message's auto-merge line says `auto-merge: not armed — no PR`.

## 9. Leave the tree, and the final message

The worktree stays where it is: the PR may need follow-up fixes there. The final message carries:

- the PR URL — or the exact `gh pr create` command and why it was not run;
- the branch and the absolute worktree path;
- **tracker:** that `in-review` is on `#<n>` and comes off by itself when the PR merges and closes the issue; that a PR closed without merging leaves it on an
  open issue, removed with `backlog.mjs review <n> off`; with `Refs #<n>`, that the guard stops blocking by itself once a referencing PR has merged into the
  default branch and none is open (the board derives it; the label stays), and that the issue must still be closed by hand when the work is complete. If the
  label write failed: that the guard is missing, and the command to add it;
- **files:** "merge this PR before draining the backlog" — until it merges the item is still in `open/` on `<base>`, and an orchestrator run would execute it
  again. That is a known limitation: a files project has no label to carry a guard. Not printed when the auto-merge wait saw the PR merge;
- **with `--auto-merge`:** the one `auto-merge:` outcome line and every fix commit (`<short sha> <subject>`, or `fix commits: none`), as
  `references/auto-merge.md` §4 lists them. A merged PR with `Closes #<n>` closed the issue and took `in-review` with it, so the tracker line above becomes
  "merged and closed"; with `Refs #<n>` the hand steps above still apply.

## Where each rule comes from

The design spec (`docs/superpowers/specs/2026-10-21-execute-pr-mode-design.md`) records the decisions this file follows:

- **Decision 5, reuse a clean worktree** — a linked worktree with no uncommitted change and no commits beyond the base is reused on its own branch; anything
  else gets a new tree from the base (§2).
- **Decision 6, review before push** — the reviewer reviews the committed diff, Critical/Important findings are fixed in a bounded loop, and the PR body
  summarises the verdict (§7, §8).
- **Decision 7, verification fails** — nothing committed, nothing pushed, no PR; the tree is left and named (§4).
- **Decision 8, the tracker issue closes when the PR merges** — no archive, the claim held through review and push, then comment and release, no `move` (§5,
  §8).
- **Decision 9, the `in-review` label guards a tracker item while its PR is open** — added after a successful push, read by every gate, removed by the merge
  or by the person (§3, §8, §9); since #411 also lifted, without a write, once a referencing PR merged into the default branch and none is open.

And the calls the spec made itself: the mode is read once and never re-read in the new tree (§1); commands reach the tree by `cd`, never a new flag (§2); a
permission denial stops only the git and `gh` steps — a tracker item's `backlog.mjs` steps still run — and hands over the remaining commands (§8); the
reviewer is used as-is, with its report outside the repo and only one-line
summaries in the PR body (§7, §8); a tree behind the base is fast-forwarded (§2); a new tree's names are `execute/<id>` and `.worktrees/execute-<id>` (§2);
at most two fix rounds, mirroring the orchestrator's loop (§7); `Refs #<n>` for a non-default base (§8); and the worktree is left in place (§9).

`--auto-merge` and `--fix` come from `docs/superpowers/specs/2026-10-24-groom-pr-and-auto-merge-design.md`: legal only beside `--finish pr` (and `--fix`
only beside `--auto-merge`), refused rather than dropped (§1, SKILL.md's Finish mode); run after the tracker guard is on and the claim released (§8, last);
the procedure, its bounds and its rulings live in `references/auto-merge.md`, shared with `backlog-groom`'s pr mode.
