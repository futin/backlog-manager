# backlog-groom — the `pr` finish mode

Read this file **in full, once**, when the trigger says `--finish pr` — before Pick an item. An `in-place` session (no `--finish`, or `--finish in-place`)
never opens it, and neither does a session under a `[backlog-tick]` marker: a tick never passes a finish, and its groom stays on disk as "Am I inside a tick?"
says.

The groom itself is unchanged — pick, claim, brainstorm, plan, write the item, `stop`, with every judgement SKILL.md asks for. What `pr` mode changes is
**where** every write lands and what happens after the last one: the groom works in a worktree of its own cut from the base, commits what it wrote there in
one commit, pushes that worktree's branch and opens one PR into the base, so the spec and the plan reach the base the way code does — through a PR a person
reads — instead of sitting uncommitted in the main checkout. It never merges: a person (or GitHub) does that, and `backlog-orchestrate` stays the only skill
that runs a merge into a base. With `--auto-merge` it arms GitHub auto-merge on that PR and waits for GitHub to merge it (§8;
`skills/backlog-execute/references/auto-merge.md`) — still GitHub's merge, never this skill's. It never asks "should I push / open a PR?": the trigger already
answered that.

**No reviewer.** `backlog-manager:backlog-reviewer` is never dispatched: it reviews code against the repository's invariants, and a groom PR is a spec and a
plan, which the person reads in the PR itself. `/doc-review` is not run either — it is interactive, and belongs to the person.

Numbered sections follow the flow in order. Everything SKILL.md says that this file does not replace still holds and is done inside the tree §2 cuts. A
reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace it in any command copied from here with the absolute path
SKILL.md's own commands show. The names below are settled once and used everywhere after:

- `<id>` — the item's id **with any leading `#` stripped**: `bug-7`, `idea-3`, or in a tracker project the bare issue number (`31`, never `#31`).
  `backlog.mjs` accepts `31` and `#31` alike; the tree and branch names need the bare form, because `tick.mjs` looks for exactly that spelling.
- `<base>` — the PR's base (§1). `<root>` — the main working tree (§2). `<tree>` — `<root>/.worktrees/groom-<id>` (§2). `<branch>` — `groom/<id>` (§2).
- `<tmp>` — this session's own temp directory (§2). `<pr>` — the number `gh pr create` printed, the last path segment of the PR URL (§6), never an issue.
- `<issue>` — tracker only: the issue that holds the plan once §6 has written it — the new task's number on a promote, the bug's own number on a bug.

## 1. Resolve the mode

Once, right after the trigger, before `show`, from the tree the session started in. SKILL.md's Finish mode section has already read `--finish pr` out of the
trigger and refused an unknown or doubled `--finish`, and a flag that arrived without the ones it needs; this section settles `<base>`.

- **`<base>` is the trigger's `--base <ref>`.** With no `--base`, it is the remote's default branch, read exactly as `backlog-execute`'s pr-mode §1 reads it:

  ```bash
  git symbolic-ref --quiet --short refs/remotes/origin/HEAD
  ```

  It prints `origin/<branch>`: strip the `origin/` prefix, and that is `<base>`. It prints nothing — no `origin`, or a clone that never recorded its `HEAD`
  — and `<base>` is `main`. A local git read, so it works with the stack down. §2's first check is what proves a local `<base>` branch exists.
- **It is read once, from the trigger, and never re-read in the new worktree.**
- **State the mode in one line and ask nothing:** `finish mode: pr → PR into <base>`, followed by `, auto-merge` and `, fix` for each of those flags the
  trigger carries — `finish mode: pr → PR into <base>, auto-merge, fix` with both.
- **A board-dispatched groom in `pr` mode ends with**
  ``Finish with `--finish pr --base <base>`: the skill commits, pushes and opens the PR into <base>, and never merges.``
  — the real base in place of `<base>`. It is execute's sentence without "reviews", because no reviewer runs on a groom. That sentence is the trigger's flag,
  composed server-side from the launch sheet's pickers: its `--finish pr` is the same one signal a typed trigger carries, and its `--base` is `<base>`.
- **With the sheet's Auto-merge and Fix if it fails ticked, it ends instead with**
  ``Finish with `--finish pr --base <base> --auto-merge --fix`: the skill commits, pushes, opens the PR into <base> and arms GitHub auto-merge if the repository allows it, then waits for GitHub to merge it, fixing failing checks and conflicts with <base> meanwhile; the skill never merges itself.``
  — and with Auto-merge alone, the same sentence without ` --fix` inside the backticks and without the ", fixing … meanwhile" clause. The flags count only
  inside the backticks, exactly like `--finish pr`; the prose after the colon describes `auto-merge.md` and is no signal of its own. A board prompt ending
  in `COMMIT_RULE`'s "commit … Do not push." sentence is an `in-place` launch, untouched by this file, and generic commit, PR or merge wording elsewhere in a
  prompt switches nothing.

## 2. Pick the tree

Before `show`, because `show` resolves the item from the cwd's tree and the item has to be read from the tree the groom writes in. With no id in the trigger,
run `board` from the starting tree — a read — and settle the item with the user as Pick an item says; then cut the tree, and run `show` in it.

**There is no reuse of the tree you started in**, unlike execute's pr mode: a groom has no prior commits to continue, and one rule is easier to keep true than
two. Every pr-mode groom cuts a new tree.

### First check — a local `<base>`

```bash
git rev-parse --verify --quiet refs/heads/<base>
```

In the starting tree. It prints nothing → stop and say there is no local `<base>` branch to cut the tree from. Do not fetch one into existence.

### Cut it

`<root>` is the main working tree — `git worktree list --porcelain | sed -n '1s/^worktree //p'` — and the tree is cut from **local** `<base>`, not
`origin/<base>`: local is where a freshly captured item is committed, the same reason execute and the orchestrator cut from local base.

```bash
git -C <root> show-ref --verify --quiet refs/heads/groom/<id>
test -e <root>/.worktrees/groom-<id>
git -C <root> worktree add <root>/.worktrees/groom-<id> -b groom/<id> <base>
```

- **Either of the first two succeeds — the branch `groom/<id>` or the path `.worktrees/groom-<id>` already exists → stop and say so, naming which. Never
  reuse it and never delete it**: it is an earlier groom of this item, whose PR may still be open or whose work may never have been pushed. The person
  decides what becomes of it.
- **The spelling is exact: tree `<root>/.worktrees/groom-<id>`, branch `groom/<id>`, `<id>` with no `#`.** `tick.mjs` depends on it: it skips that tree when
  it scans linked worktrees for a `started:` marker, and treats either name as "this item's groom is taken", so a tick neither blocks on this session's marker
  nor re-grooms an item whose plan sits on an open PR. A tree under any other name breaks both. The names also never collide with the orchestrator's
  `.worktrees/<id>` / `backlog/<id>` or execute's `.worktrees/execute-<id>` / `execute/<id>`.

### Set it up

The setup execute's pr-mode §2 "Set the new tree up" gives its trees, copied here because it is two commands:

1. **`.worktrees/` and `node_modules` go into the COMMON git dir's `info/exclude`**, each as a whole line, only when absent — never `.gitignore`, and never
   committed. `node_modules` is bare, with no trailing slash, because the tree gets a symlink and a directory-only pattern cannot match one:

   ```bash
   EXCL="$(git -C <root> rev-parse --path-format=absolute --git-common-dir)/info/exclude"
   mkdir -p "$(dirname "$EXCL")"; touch "$EXCL"
   [ -s "$EXCL" ] && [ -n "$(tail -c1 "$EXCL")" ] && echo >> "$EXCL"
   for p in '.worktrees/' 'node_modules'; do grep -qxF "$p" "$EXCL" || printf '%s\n' "$p" >> "$EXCL"; done
   ```

   Nothing else goes on that list: it lives in the common git dir, so a line there hides that path in every checkout of the repository, for good.
2. **A `node_modules` symlink to the main tree's directory**, so a check §8's fix loop runs locally can find the project's dependencies:

   ```bash
   [ -d <root>/node_modules ] && [ ! -e <tree>/node_modules ] && ln -s <root>/node_modules <tree>/node_modules
   ```

3. **`<tmp>`, this session's temp directory**, outside every repository so no commit can ever carry a file written there:

   ```bash
   T="$(node -p 'require("os").tmpdir()')/backlog-groom"; mkdir -p "$T"
   mktemp -d "$T/<id>-XXXXXX"
   ```

   The path `mktemp` prints is `<tmp>`. Every `/tmp/<file>.md` SKILL.md's tracker commands show — `/tmp/item.md`, `/tmp/task.md`, `/tmp/promoted.md`,
   `/tmp/rejection.md` — is `<tmp>/<file>.md` in this mode, and the PR body is `<tmp>/pr.md`.

### Every command runs in that tree

`cd <tree> && …` on every later command — `backlog.mjs` (`show`, `start --as groom`, `heartbeat`, `body`, `new`, `move`, `stop`), git, `gh`, and any check
you run — never a `--root` flag, and never a path into another tree. `backlog.mjs` resolves its store from the cwd, so in a files project every item write
lands in `<tree>`, and the code you read while brainstorming and planning is `<base>`'s. Read code by its path under `<tree>`; a CodeGraph index found above
the tree describes the main checkout's files, which may differ from `<base>`, so confirm a `file:line` you cite against the file in `<tree>`. The only writes
this mode makes outside `<tree>` are the ones this section instructs: the tree and its `.git/worktrees/` entry, the common `info/exclude`, and `<tmp>`.

## 3. Pick an item, mark it in progress, brainstorm, plan — unchanged, in the tree

All of it as SKILL.md says, inside `<tree>`: the refusals, the verdict decided with the user, `start <id> --as groom` as the very next command after `show`
once item and verdict are confirmed, "Already in progress", the verdict's own judgements. Two things are new:

- **An item absent from `<tree>`** — `show` exits `1` naming an unknown id in a files project — is usually an item captured in the main checkout and never
  committed to `<base>`. Refuse it: say to commit the captured item to `<base>` first, then end through §7.
- **A spec goes into `<tree>`.** When the size is "a project with a written design", brainstorming's document is written at its usual path under `<tree>`
  (`<tree>/docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`), never under the starting tree. **Brainstorming's own "commit the spec" step is not run:**
  it is folded into §5, one commit for the whole groom, not one per document. `## Plan` still cites the spec — by its repository-relative path in a files
  project, by a commit-pinned permalink in a tracker one (§6).

## 4. Write the item — files before the commit, tracker after the push

- **Files project:** the verdict's steps exactly as SKILL.md gives them, every one in `<tree>` — the item file written, `promoted-to:` on a promoted idea,
  `stop`, `move` — **including its `stop`, which runs before §5's commit**: `stop` rewrites the item file (removes `started:` and `phase:`, re-stamps
  `groomed-at:`, bills the counters), and that rewrite belongs in the commit. **No `plan-review` mark** — the item is un-groomed on `<base>` until the PR
  merges, so no gate can execute it early; the merge is the approval. Then, instead of printing the `Groomed on disk only` line, go to §5.
- **Tracker project with a spec written:** the plan cannot cite the spec's final commit before that commit exists, so the issue write waits. Draft the body
  in `<tmp>/item.md` (a bug) or `<tmp>/task.md` (a promote), leaving the spec's permalink to be filled in, and go to §5 without writing to the issue. The
  claim stays held through §5 and §6: **run `heartbeat <id>` before §5's commit and before §6's push.** A refused heartbeat means another session took the
  item — stop right there, commit or push nothing more, and report the tree and the branch.
- **Tracker project with no spec written** — a quick or small groom whose plan is prose only, or a Reject, which writes no plan — has nothing to commit:
  §7.

## 5. Commit

```bash
cd <tree> && git status --short
cd <tree> && git add <path> [<path> …]
cd <tree> && git commit -m "docs(groom): <item title>" -m "<id>: <verdict>"
```

- **Stage only the files this groom wrote, each by name — never `git add -A` or `git add .`:** the spec (and a plan document, should one have been written),
  and in a files project every item path the verdict touched — the new task file, the rewritten bug, both the old and the new path of a moved idea or
  rejected item (`git add` on the removed path stages its removal). Read `git status --short` first; a path in it that this groom did not write is left
  unstaged, and the final message lists it with the tree.
- **`<item title>`** is the title of the item that holds the result: the new task's title on a promote (on a tracker project, the title you are about to pass
  to `new`), the bug's own title for Plan the fix, the item's title for a Reject. **`<verdict>`** is `promoted to <task>`, `plan the fix` or
  `rejected`. The subject passes `ci / pr-title` and becomes the PR's title in §6.
- **Nothing to stage** → §7.

## 6. Push, write the tracker issue, open the PR

**The order, per source** — every step `cd <tree> && …`, each run as a command of its own:

| Files project                         | Tracker project (a spec was committed)                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| §4's verdict steps, `stop` included   | §4's draft in `<tmp>`, claim held                                                                       |
| §5 commit                             | §5 commit                                                                                               |
| `git push -u origin groom/<id>`       | `git push -u origin groom/<id>`                                                                         |
| —                                     | the issue write, `--plan-review`, with `blob/<sha>` (below)                                             |
| —                                     | the rest of the verdict as SKILL.md orders it — plain `stop <id>`, then on a promote `move <id> done …` |
| `gh pr create`                        | `gh pr create`, body `Refs #<issue>`                                                                    |
| §8, with `--auto-merge`               | §8, with `--auto-merge`                                                                                 |

**Push** — `git push -u origin groom/<id>`. **Never force-push**, in any spelling.

**The tracker issue write**, after a successful push only:

1. **The permalink.** `<sha>` is `git -C <tree> rev-parse HEAD` — the commit just pushed. `<owner>/<repo>` is parsed from `git -C <tree> remote get-url origin`
   (strip `https://github.com/` or `git@github.com:`, and a trailing `.git`). The link is `https://github.com/<owner>/<repo>/blob/<sha>/<spec path>`, the
   spec path relative to the repository root. Fill it into the draft's `## Plan`. A `blob/<sha>` link survives a squash merge: GitHub keeps a PR's commits
   reachable through `refs/pull/<n>/head`.
2. **Write the plan with the `plan-review` mark**, in the one write SKILL.md's tracker section gives the verdict:

   ```bash
   cd <tree> && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" body <id> --body <tmp>/item.md --if-updated-at <updatedAt> --plan-review
   cd <tree> && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" new tasks "<title>" --body <tmp>/task.md --from #<id> --plan-review
   ```

   The first for Plan the fix (`<updatedAt>` from a fresh `show <id> --json`), the second for a promote; add `--runner-fix` exactly where SKILL.md says
   to. A refused `body` is re-read and re-applied as SKILL.md says, with the claim still held. **Why the mark:** an issue body is live on every machine the
   moment it is written, while its spec is still on an unmerged PR — the mark keeps every gate (the board's Run, the server's dispatch ladder, the
   orchestrator, `tick.mjs`) from executing a plan nobody has approved. It comes off when the PR merges and this session saw it (§8), or when a person
   approves it on the board.
3. **Then the rest of the verdict**, as SKILL.md orders it, only after the write exits `0`: a plain `stop <id>`; on a promote, after it,
   `move <id> done --outcome <tmp>/promoted.md` naming the new task. `<issue>` is the new task's number (`new` printed it) on a promote, `<id>` on a bug.

**Open the PR:**

```bash
cd <tree> && gh pr create --base <base> --head groom/<id> --title "$(git log -1 --format=%s)" --body-file <tmp>/pr.md
```

The PR body, written to `<tmp>/pr.md`: what was groomed — the verdict and the item id (on a promote, both the original's id and the new task's); the spec's
repository-relative path, if one was written; the first lines of `## Plan`; and on a tracker project `Refs #<issue>`. **Never `Closes`:** that issue is the
item, and it stays open to be executed once the plan is approved.

### When a step is refused

- **The permission layer refuses a `git add`, `git commit`, `git push` or `gh` call** (a denial, as opposed to a rejection by the remote): stop the git and
  `gh` steps right there, and never retry it another way — another command, a wrapper shell, the API. Whatever is done stays done; a local commit stays
  committed. The final message lists the exact remaining commands, in order, for a person to run.
- **The remote rejects the push:** stop, and report it with git's own words. Never force.
- **A tracker project with no pushed commit** — a denied `add`, `commit` or `push`, or a rejected push — writes **nothing** to the issue: a `blob/<sha>`
  link to a commit GitHub does not have is dead, and a plan without the mark would be executable while citing a spec nobody can read. Release the claim with
  a plain `stop <id>`, keep the draft in `<tmp>`, and the final message gives, in order: the remaining git commands, the issue write above with its
  `--plan-review` (and a fresh `show <id> --json` for `body`'s stamp), the `move` for a promote, and the `gh pr create`.
- **`gh` missing, not authenticated, or a denied `gh pr create`, after a successful push:** the branch is pushed and, on a tracker project, the issue write
  and `stop` still run — the mark is on and guards the plan. The final message says the PR was not opened and why, and gives the exact `gh pr create` above.

## 7. Nothing to commit — no PR

Whatever the source, when §5 would stage nothing — a tracker groom that wrote no spec (its groom already lives on GitHub), or any groom that ended without a
verdict after §2 cut the tree: a refusal, a stand-down on an item another session holds, an item absent from `<tree>`, no verdict reached.

1. **Finish the groom's own writes first, as an in-place groom would.** A tracker groom that reached a verdict writes its issue exactly as SKILL.md says —
   `body`/`new`/`move` with **no** `--plan-review` and no `blob/<sha>` link — and runs its `stop`: the deferred write of §4 is only for a groom with a commit
   to cite. A groom that ended without a verdict runs SKILL.md's "If the session ends without a verdict" `stop`, under that section's own test.
2. **Say it in one line:** `nothing to commit — no PR`, and the reason.
3. **Remove what §2 cut** — only that tree and that branch, and only while the branch has no commits beyond `<base>`:

   ```bash
   git -C <root> rev-list --count <base>..groom/<id>
   cd <tree> && git status --porcelain
   git -C <root> worktree remove <root>/.worktrees/groom-<id>
   git -C <root> branch -D groom/<id>
   ```

   The first must print `0`, or nothing is removed. In a files project where `start` and `stop` ran, they left the item file modified in `<tree>` with
   bookkeeping alone (`updated:`, the counters) — this groom produced nothing to keep, so restore that one file first:
   `cd <tree> && git restore --source=HEAD --staged --worktree -- <item path>`. Any other path `git status --porcelain` lists — a spec draft, a file you
   cannot attribute — is left: remove nothing, and the final message names the tree, the branch and the path, so the person decides. `worktree remove` runs
   without `--force`; if it refuses, leave both as they are and say so.
4. **End as SKILL.md's verdict ends**, without the `Groomed on disk only` line — nothing is on disk anywhere for it to describe.

## 8. With `--auto-merge`: arm it and wait

Only when the trigger carries `--auto-merge`, and only once the PR is open and — tracker — the issue write and `stop` of §6 have run, so no claim is held:
read `${CLAUDE_PLUGIN_ROOT}/skills/backlog-execute/references/auto-merge.md` in full and run it now, handing it these names, already settled above:
`<tree>` (`<root>/.worktrees/groom-<id>`, every command `cd <tree> && …`), `<branch>` (`groom/<id>`), `<base>`, `<pr>` (the PR §6 opened — not an issue),
and on a tracker project `<issue>`. It arms GitHub auto-merge if the repository allows it, waits for GitHub to merge, and with `--fix` repairs failing checks
and conflicts with `<base>` meanwhile — a groom's local verification for a fix round is the failing job's own command, run in `<tree>`. On `MERGED` it runs
`backlog.mjs plan-review <issue> off` on a tracker project — the merge is the approval — and nothing on a files project, where the merged item file is the
plan on `<base>`. It never merges itself. Do not restate or reorder its steps here.

No PR opened — `gh` missing, unauthenticated or refused, a refused or rejected step anywhere above — means there is nothing to arm: skip that file, and the
final message's auto-merge line says `auto-merge: not armed — no PR`.

## 9. Leave the tree, and the final message

The worktree stays where it is: the PR may need follow-up there. The final message ends the groom as SKILL.md's verdict ends it — what was groomed, and the
verdict — **without** the `Groomed on disk only` line: the commit exists, and once the PR merges an orchestrator run on `<base>` sees the item. It carries:

- the PR URL — or the exact `gh pr create` command and why it was not run;
- the branch `groom/<id>` and the absolute worktree path;
- **with `--auto-merge`:** the one `auto-merge:` line, every fix commit (or `fix commits: none`) and every red round, as `auto-merge.md` §4 lists them;
- **tracker:** where the `plan-review` mark stands on `#<issue>`. The wait saw the PR merge and `plan-review <issue> off` exited `0` → one line saying the
  mark is off. Every other case — no `--auto-merge`, auto-merge not allowed or refused, a wait that hit its bound, stopped, or ended `CLOSED`, a failed `off`
  — the mark is still on: say so, and give the command a person runs once they approve the plan, with the absolute path as everywhere in a final message:
  `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" plan-review <issue> off`;
- **files:** the known limitation — until this PR merges, `<base>` and the main checkout still show `<id>` un-groomed, so re-grooming it from the board
  before the merge grooms it again. Not printed when the auto-merge wait saw the PR merge;
- any path left unstaged in §5, and any command not run because a step was refused, in order.

## Where each rule comes from

The design spec, `docs/superpowers/specs/2026-10-24-groom-pr-and-auto-merge-design.md` — "The groom `pr` flow" steps 1–9, "The guard while the PR is open",
"No reviewer" and "Refusals" — records the decisions this file follows: no reuse of the starting tree (§2); the tree and branch spelled for `tick.mjs` (§2);
brainstorming's spec commit folded into one `docs(groom): <item title>` commit (§3, §5); `stop` before the commit on a files project and after the issue
write on a tracker one (§4, §6); a tracker plan written with `plan-review` whenever a PR opens, and `Refs`, never `Closes` (§6); no PR and no mark when
there is nothing to commit (§7); the shared auto-merge procedure (§8); and the files limitation stated in the final message (§9). Ruled while writing this
file: a tracker project whose commit never reached GitHub writes nothing to the issue and hands the write over (§6, "When a step is refused"); a no-verdict
files groom restores the item file's bookkeeping before removing the tree, and leaves the tree whenever anything else is in it (§7); the permalink's
`<owner>/<repo>` is read from `origin`, so it needs no `gh` (§6).
