# backlog-execute — the `pr` finish mode

Read this file **in full, once**, when `backlog.mjs config` printed `"finish":"pr"` and the trigger did not say `in place this time` — before Pick an item. An
`in-place` project never opens it, and neither does a session under an `[orchestrator-run` marker: the run owns the worktree, the branch and every git step,
so the config is not even read there.

In `pr` mode execute works the item in a worktree that holds this item's work and nothing else, and on verified success commits it, has
`backlog-manager:backlog-reviewer` review the commit, pushes the branch and opens one PR into the base. It never merges — a person (or GitHub) does that, and
`backlog-orchestrate` stays the only skill that merges. It never asks "should I push / open a PR?": the committed config already answered that, and asking is
the exact step this mode exists to remove.

Numbered sections follow the flow in order. Everything SKILL.md says that this file does not replace still holds — the refusal gate, dispatch, verification,
both pre-review checks — and is done inside the tree §2 picks. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in:
replace it in any command copied from here with the absolute path SKILL.md's own commands show. `<root>`, `<tree>`, `<base>` and `<id>` are defined where
they are first used; in a tracker project `<id>` is the bare issue number (`31`, never `#31`).

## 1. Resolve the mode

Once, right after the trigger, before `show`, from the tree the session started in:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" config
```

It prints the effective config, `{"execute":{"finish":"in-place"|"pr","base":"<branch>"}}`, with `base` already resolved (the file's value, else the remote's
default branch, else `main`). That `base` is `<base>` everywhere below.

- **Exit `1`** — `backlog/config.json` is malformed or names an unknown mode, and the message says which. Stop with that message. Never fall back to either
  mode: a quiet `in-place` would skip the PR the team configured, and a quiet `pr` would commit and push in a project that never asked for it.
- **It is read once, from the starting tree, and never re-read in the new worktree.** That is the tree the person (or the board's spawn) pointed at. A config
  that exists only uncommitted there still sets the mode for this session.
- **State the mode in one line and ask nothing:** `finish mode: pr → PR into <base>`.
- **The one override** is the person's own trigger words containing the exact phrase `in place this time` ("execute task 12, in place this time"). Then say
  `finish mode: in-place this time (project says pr)` and follow SKILL.md as an `in-place` project would — this file no longer applies. Nothing else is an
  override: not generic commit wording elsewhere in a prompt, and not the board's `COMMIT_RULE` sentence. This skill never offers the override.
- **A board-dispatched prompt in a `pr` project ends with** ``Finish in this project's `pr` mode: the skill commits, reviews, pushes and opens the PR.`` That
  sentence means "follow this file": it is the same config read, made server-side, in place of the "commit … Do not push." rule an `in-place` project's prompt
  ends with. A prompt that carries `COMMIT_RULE` in an `in-place` project is today's behaviour, untouched by this file.

## 2. Pick the tree

Before `show`, because `show` resolves the item from the cwd's tree and the item has to be read from the tree the work happens in. With no id in the trigger,
choose one first with `board` from the starting tree — a read — then pick the tree; `show` and everything after it run in that tree.

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
git -C <root> rev-parse --verify --quiet refs/heads/<base>
git -C <root> show-ref --verify --quiet refs/heads/execute/<id>
test -e <root>/.worktrees/execute-<id>
git -C <root> worktree add <root>/.worktrees/execute-<id> -b execute/<id> <base>
```

- No local `<base>` branch → stop and say so. Do not fetch one into existence.
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

2. **Dependencies: a `node_modules` symlink to the main tree's directory** — the orchestrator's mechanism, "the `node_modules` idiom"
   (`backlog-orchestrate/references/rationale.md` §4). A fresh checkout has none of its own, and the project's tests usually cannot run without one:

   ```bash
   [ -d <root>/node_modules ] && [ ! -e <tree>/node_modules ] && ln -s <root>/node_modules <tree>/node_modules
   ```

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
resolving its store from the cwd, so SKILL.md's "writes only under the repo root `show` resolved" holds as written: the resolved root simply is `<tree>`.

## 3. Pick an item, refusal gate, mark in progress, dispatch, verify — unchanged

All of it as SKILL.md says, inside `<tree>`. The "item absent from this tree → refuse" rule now also catches an item groomed but never committed — which is
correct: say to commit the groom first, then remove what §2 cut. An item carrying `inReview: true` is refused by the gate in either mode with
`a PR is open for this item`, naming the PR when it can.

**Tracker: heartbeat across everything below.** A claim reads stale after 15 minutes without one, and a review loop easily crosses that. Run
`heartbeat <id>` before §6's commit, before every reviewer dispatch, right after every verdict, and before §8's push. A refused heartbeat means another
session has taken the item: stop right there — commit nothing more, push nothing — and report the branch and the tree. Nothing is lost at either point:
before §6 the work sits uncommitted in `<tree>`, after it the work is committed on the branch.

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
cd <tree> && gh pr create --base <base> --title "<subject>" --body-file <tmp>/pr.md
```

`<branch>` is §7's. **Never force-push**, in any spelling. A push the remote rejects stops here and is reported with git's own words — nothing after it runs
except the tracker release in §7's shape (comment, plain `stop`), because there is still no pushed work to guard.

The PR body, written to `<tmp>/pr.md`:

- the Outcome summary — what was done, the verification command and the lines of its output that show it passing, the `Contract sweep:` and `Red proof:`
  lines;
- the review verdict, the number of fix rounds, and the one-line summary of every Critical/Important finding the rounds fixed — never a local report path;
- tracker only: `Closes #<n>` when `<base>` is the repository's default branch, otherwise `Refs #<n>` — GitHub only auto-closes from a PR into the default
  branch. The default branch is `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` with its `origin/` prefix stripped (it prints `origin/main`,
  which never equals a `<base>` of `main`; `remoteDefaultBranch` in `backlog.mjs` strips it the same way), else
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

## 9. Leave the tree, and the final message

The worktree stays where it is: the PR may need follow-up fixes there. The final message carries:

- the PR URL — or the exact `gh pr create` command and why it was not run;
- the branch and the absolute worktree path;
- **tracker:** that `in-review` is on `#<n>` and comes off by itself when the PR merges and closes the issue; that a PR closed without merging leaves it on an
  open issue, removed with `backlog.mjs review <n> off`; with `Refs #<n>`, that the issue must be closed by hand once the work reaches the default branch, and
  the label removed then. If the label write failed: that the guard is missing, and the command to add it;
- **files:** "merge this PR before draining the backlog" — until it merges the item is still in `open/` on `<base>`, and an orchestrator run would execute it
  again. That is a known limitation: a files project has no label to carry a guard.

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
  or by the person (§3, §8, §9).

And the calls the spec made itself: the config is read once from the starting tree (§1); commands reach the tree by `cd`, never a new flag (§2); a
permission denial stops the flow and hands over the remaining commands (§8); the reviewer is used as-is, with its report outside the repo and only one-line
summaries in the PR body (§7, §8); a tree behind the base is fast-forwarded (§2); a new tree's names are `execute/<id>` and `.worktrees/execute-<id>` (§2);
at most two fix rounds, mirroring the orchestrator's loop (§7); `Refs #<n>` for a non-default base (§8); and the worktree is left in place (§9).
