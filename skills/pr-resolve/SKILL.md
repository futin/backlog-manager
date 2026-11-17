---
name: pr-resolve
description: >
  Resolve a conflicting GitHub pull request unattended: merge its base into its head in a detached worktree, resolve only the mechanical conflicts, prove the
  result with the project's own checks and push the merge commit — or, when any conflict is a judgment call, push nothing and say why on the PR. Started by the
  board's Resolve conflicts, or typed. Never asks a question, never rebases and never force-pushes. Trigger: /backlog-manager:pr-resolve <owner>/<repo>#<number>
trigger: /backlog-manager:pr-resolve
---

# /backlog-manager:pr-resolve — merge the base into a conflicting PR

```
/backlog-manager:pr-resolve <owner>/<repo>#<number> [--reclaim <sessionId>]
```

Merges the PR's base into the PR's head — the direction `backlog-execute --fix` already takes, never into the base — resolves the conflicts that are mechanical,
proves the merge with the project's own checks, commits one merge commit and pushes the head. One conflict that needs a person's judgment stops the whole
resolve with nothing pushed. Run from the PR repo's main checkout (the board spawns it there). `--reclaim <sessionId>` is added only by the board's route, which
has proved that session dead — never type one, never invent one; pass it through unchanged. The design is
`docs/superpowers/specs/2026-11-17-pr-conflict-resolve-design.md`, "The skill".

## Rules

- **Never ask the user anything.** This is a headless dashboard session: nobody is there, and an unanswered question parks it. Every fork below has its answer.
- **Never run anything in the background, and never end a turn with something still running.**
- **The PR branch's history is only ever appended to.** One merge commit, one `git push origin HEAD:<head>`, never forced — no `--force`, no
  `--force-with-lease`, no rebase, no amend, no reset of anything already pushed. A rejected push is a stop, never a retry another way.
- **Never touch the main checkout or any local branch.** All the work happens in this session's own detached worktree; the main checkout's working tree, index
  and branches are left exactly as they were. The only writes outside the trees are the common `info/exclude` (step 3), the lock and the outcome file (both
  through the tool), and the temp files that carry the commit message and the comment. A lockfile case's install goes into the tree, never through the symlink
  (step 5).
- **A permission-layer denial is a stop.** A `git`, `gh`, install or check command the permission check refuses is never retried another way; the reason names
  the refused command.
- **The target holds a `#`, so single-quote it in the shell** (`'owner/repo#12'`) — unquoted, the shell reads `#12` as a comment.
- **Every tool call runs from the main checkout**, `cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" …`: the tool derives the
  worktree paths from its cwd, and a call made from inside a tree would name a lock and trees that do not exist. `<root>` is the main working tree,
  `git worktree list --porcelain | sed -n '1s/^worktree //p'`: step 1's first block prints it as its first line, and every later `<root>` is that line.
- **Shell variables do not survive between Bash calls.** Run each fenced block below as ONE call, and carry the values this session learns — `<root>`, `<head>`,
  `<base>`, `<fromSha>`, the tool's paths — as literal text in later commands, never as a variable set in an earlier call.
- **The tool's exit codes:** `0` ok, `2` usage (the stderr line says what), `3` lock refused. It prints one JSON line on stdout.

## Three kinds of stop

| Stop           | When                                                                                                              | Which of step 8's acts run                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Early stop** | before step 1's `gh pr view` succeeded: a malformed argument, `origin` is another repo, `gh` failed or was denied | (f) only — the final line. No outcome file (there is no PR to key it to, no head to record), no comment, no tree                                                                                       |
| **Lock stop**  | step 2 found another resolve holding the PR                                                                       | (f) only — the final line, reason `another resolve of #<N> is running`. It removes nothing, writes no outcome file and posts no comment: every one of those belongs to the resolve that holds the lock |
| **Stop**       | everything after step 2                                                                                           | the full step 8, (a)–(f)                                                                                                                                                                               |

A stop after step 1's read that is not a lock stop — the PR is closed, not conflicting, or from a fork — has no merge, no tree and no lock, so (a)–(c) have
nothing to do and `lock release` must NOT run (a lock that exists is another session's). It writes the outcome file, `stopped`, with the read's head SHA as both
`--from` and the head (d), and ends with the final message (f). It posts no comment: there was nothing to resolve.

**Every session ends with exactly one of these final lines, as the last line of its final message:**

> `pr-resolve: pushed`
>
> `pr-resolve: up to date — nothing pushed`
>
> `pr-resolve: stopped — <one-line reason>`

The outcome file says the same thing to the board — the server has no read of a session's text, so the file is how the board learns the outcome. The two must
agree.

## 1. Preflight

Parse the target. `parse` refuses anything not `owner/repo#N` (exit `2`), and prints the paths every later step uses:

```bash
ROOT="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
echo "$ROOT"
cd "$ROOT" && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" parse '<owner>/<repo>#<N>' [--reclaim <sessionId>]
```

The first line printed is `<root>` — an absolute path, written as literal text in every later command. The tool then prints
`{ repo, number, reclaim, tree, baseTree, lockFile, outcomeFile }`: `tree` is `<root>/.worktrees/pr-resolve-<N>`, `baseTree` is
`<root>/.worktrees/pr-resolve-<N>-base`. Exit `2`, or no git checkout at all, is an **early stop** naming the problem.

Confirm the checkout's `origin` is that repo: `git -C '<root>' remote get-url origin`, read as `owner/repo` whatever its form (`https://github.com/o/r.git`,
`git@github.com:o/r.git`, with or without `.git`), compared case-insensitively. Another repo is an **early stop**: `origin is <theirs>, not <owner>/<repo>`.

Read the PR:

```bash
gh pr view <N> --repo '<owner>/<repo>' --json state,mergeable,isCrossRepository,headRefName,baseRefName,headRefOid
```

A `gh` failure or denial is an **early stop** naming the error. From here on the read succeeded. Record `headRefName` as `<head>`, `baseRefName` as `<base>` and
`headRefOid` as `<fromSha>` — the head this resolve starts from, which every outcome file below records. Then stop (outcome file, final message, no comment —
"Three kinds of stop" above) unless the PR is open, `CONFLICTING` and not cross-repository, with the first reason that applies:

- `state` is not `OPEN` → `<owner>/<repo>#<N> is not open`
- `isCrossRepository` is `true` → `<owner>/<repo>#<N> is from a fork — the session cannot push to it`
- `mergeable` is `UNKNOWN` → `GitHub is still computing mergeability — try again in a moment`
- `mergeable` is anything else but `CONFLICTING` → `<owner>/<repo>#<N> has no conflicts`

The outcome write for such a stop:

```bash
cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" outcome '<owner>/<repo>#<N>' --outcome stopped --reason '<reason>' --from <fromSha>
```

## 2. One at a time

```bash
cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" lock take '<owner>/<repo>#<N>' [--reclaim <sessionId>]
```

The lock lives outside the trees, at `lockFile`, so nothing a merge stages can ever pick it up, and it is taken with an exclusive create — of two sessions
exactly one wins. A lock that already exists is stale when it is older than 3 hours, or when `--reclaim` names exactly the session it records; the tool claims a
stale lock atomically, removes both trees the dead resolve left (`git worktree remove --force`, `git worktree prune`) and takes the lock fresh.

- **Exit `0`** prints `{ taken: true, recovered }`, plus `cleanup` — the git errors of that removal, if any — when `recovered` is `true`. Carry a non-empty
  `cleanup` into the final message; a tree that would not go makes step 3's `worktree add` stop on its own. **From here on every exit releases the lock, in
  step 8.**
- **Exit `3`** prints `{ taken: false, reason }` — a live lock, or a stale-claim race this session lost. That is a **lock stop**: the final message ends
  `pr-resolve: stopped — another resolve of #<N> is running` and nothing else happens — no outcome file, no comment, nothing removed.
- **Any other exit** took no lock: a stop the way step 1's after-read stops are — outcome file `stopped` with the stderr line as the reason, final message, no
  comment, no `lock release`.

Liveness is by age plus the board's `--reclaim`, not by process: a skill CLI's pid dies with each call, and a terminal run has no dashboard to ask.

## 3. Worktree

First the excludes `backlog-execute` sets up for its own trees — `skills/backlog-execute/references/pr-mode.md`, "Set the new tree up", step 1: "`.worktrees/`
and `node_modules` go into the COMMON git dir's `info/exclude`", each as a whole line, only when absent, `node_modules` bare (the tree gets a symlink, and a
directory-only pattern cannot match one) — so the main checkout never shows the trees as untracked:

```bash
EXCL="$(git -C '<root>' rev-parse --path-format=absolute --git-common-dir)/info/exclude"
mkdir -p "$(dirname "$EXCL")"; touch "$EXCL"
[ -s "$EXCL" ] && [ -n "$(tail -c1 "$EXCL")" ] && echo >> "$EXCL"
for p in '.worktrees/' 'node_modules'; do grep -qxF "$p" "$EXCL" || printf '%s\n' "$p" >> "$EXCL"; done
```

Nothing else goes on that list. Then fetch both refs and cut a **detached** worktree at the PR's head on origin — detached so a local branch of the same name,
checked out elsewhere or ahead of or behind origin, is never touched:

```bash
git -C '<root>' fetch origin '<head>' '<base>'
git -C '<root>' worktree add --detach '<tree>' 'origin/<head>'
```

A failed fetch or `worktree add` is a stop; the reason names the git error. Only a tree whose `worktree add` succeeded is this session's to remove in step 8.

Dependencies: a `node_modules` symlink to the main tree's, exactly as execute's trees get (pr-mode.md, "Every command runs in that tree") — except in the
lockfile case of step 5:

```bash
[ -d '<root>/node_modules' ] && [ ! -e '<tree>/node_modules' ] && ln -s '<root>/node_modules' '<tree>/node_modules'
```

Every later git, install and check command runs `cd '<tree>' && …`; every tool call stays `cd '<root>' && …`.

## 4. Merge

```bash
cd '<tree>' && git merge --no-ff --no-commit origin/<base>
```

`--no-commit`, so the commit is always step 7's, made only after step 6 has proved it.

- **"Already up to date"** → outcome `up-to-date`, nothing pushed: no merge is in progress, go to step 8.
- **Exit `0`, no conflicts** (GitHub's `CONFLICTING` was stale) → the merge is staged and in progress; go to step 6.
- **Conflicts** → step 5.
- **Any other failure** → a stop naming the git error.

## 5. Classify every conflicted hunk

List the conflicted files (`git diff --name-only --diff-filter=U`) and read every hunk in each. **Read `references/classify.md` now, in full** — its worked
examples are where the line between the two classes is drawn, and that line is this skill's main content.

**Mechanical — the session resolves it:**

- both sides added independent entries to the same list, import block or registry (keep both, in the file's own order);
- non-overlapping edits that git could not align;
- a rename on one side and an unrelated edit on the other (the edit applied under the new name);
- formatting-only differences;
- a lockfile or a generated file — regenerated with the project's own package manager or generator, **never hand-merged**.

**Judgment — the session never guesses:** both sides changed the same logic; a deletion on one side and an edit on the other; a semantic choice between two
behaviours; or **any hunk the session is not confident about**.

**One judgment hunk aborts the whole resolve**: classify every hunk first, resolve nothing while one judgment hunk exists, and stop — go to step 8, whose (a)
aborts the merge and (b) removes the trees, with the list of each judgment file and hunk and why. A partly resolved merge is never pushed.

When every hunk is mechanical, resolve each one by editing the file (no conflict marker may remain), and keep a list — file, and how — for the commit body and
the comment.

**The lockfile case** — never hand-merged, regenerated in this order:

1. Resolve the manifest (`package.json`) first, like any other hunk.
2. Take either side's lockfile as the starting point: `git checkout --ours -- <lockfile>`.
3. REPLACE the tree's `node_modules` symlink with the tree's own install, because through the symlink the install would rewrite the main checkout's
   dependencies; the install then regenerates the lockfile from the merged manifest:

   ```bash
   cd '<tree>' && rm -f node_modules && pnpm install
   ```

   `rm -f node_modules` with no trailing slash removes the link and never follows it, and is a no-op when the main checkout had no `node_modules` to link. Use
   the project's own manager — the one its lockfile and `packageManager` name: `pnpm-lock.yaml` → `pnpm install`, `package-lock.json` → `npm install`,
   `yarn.lock` → `yarn install`. **An install that fails or is denied is a stop.**

A generated file is regenerated the same way, with the generator the repo's own scripts name — a generated file whose generator cannot be found is a hunk the
session is not confident about, so judgment.

## 6. Prove it

Run the project's checks that cover the files the merge touched (`git diff --name-only HEAD` in the tree), as the repo's own `CLAUDE.md` or `package.json`
defines them — the typecheck plus the affected test suites at minimum.

- **All pass** → step 7.
- **A check fails** → re-run that check only, on the base, in the second detached tree, and remove that tree as soon as the re-run ends:

  ```bash
  git -C '<root>' worktree add --detach '<baseTree>' 'origin/<base>'
  [ -d '<root>/node_modules' ] && [ ! -e '<baseTree>/node_modules' ] && ln -s '<root>/node_modules' '<baseTree>/node_modules'
  cd '<baseTree>' && <the failing check>
  git -C '<root>' worktree remove --force '<baseTree>'
  ```

  A failure the base has too is not the merge's: go on, and the comment names it. A failure only the merged tree has **aborts exactly as a judgment stop does**,
  with the failing output summarised in the comment. (The user's pick: push when the merge added no failure.)

Two cases that look alike and are not:

- **No check is defined** — no test or typecheck command in the repo's `CLAUDE.md` or `package.json` → the comment says so, and the session still pushes a
  mechanical-only resolution.
- **A check is defined but cannot run** — an install failed or was denied, a command was refused, or the base re-run could not run → a **stop**, never "push
  anyway".

## 7. Commit and push

Stage by path — the files step 5 resolved and any lockfile or generated file it regenerated, `git add -- <path>…` — **never `-A`**, never `.`, so no untracked
file (an install's leftovers, a check's output) can ride into the commit. Then `git diff --name-only --diff-filter=U` must print nothing.

Commit the merge with git's default merge subject — the first line of the merge message git prepared — and a body listing each resolved file and how:

```bash
MSG="$(mktemp)"
cd '<tree>' && head -n1 "$(git rev-parse --git-path MERGE_MSG)" > "$MSG"
cat >> "$MSG" <<'EOF'

<one line per resolved file: path — how>
EOF
cd '<tree>' && git commit -F "$MSG"
```

A merge with no conflicts (step 4's stale flag) has no resolved files: the body says so. A failed commit is a stop. Then push, never forced:

```bash
cd '<tree>' && git push origin HEAD:<head>
```

Record `git rev-parse HEAD` as `<headSha>`. A rejected or denied push — the head moved since step 1, or the permission check refused it — is a stop: nothing is
retried, and the comment says to click Resolve conflicts again.

## 8. Report

In this order, **each act attempted even when an earlier one failed**:

- **(a)** Abort the merge if one is still in progress — every stop after step 4, the install and cannot-run stops included, leaves nothing half-merged:
  `cd '<tree>' && if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git merge --abort; fi`.
- **(b)** Remove the trees THIS session created, and only those: `git -C '<root>' worktree remove --force '<path>'` for each, then
  `git -C '<root>' worktree prune`. A tree already gone (step 6 removes `<baseTree>` as soon as its re-run ends) is skipped, not a failure:
  `[ -d '<path>' ] && git -C '<root>' worktree remove --force '<path>'`; only a tree still present after its removal is one that would not go.
- **(c)** Release the lock:

  ```bash
  cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" lock release '<owner>/<repo>#<N>'
  ```

- **(d)** Write the outcome file — `pushed` with the pushed merge commit as `--head`; `stopped` or `up-to-date` with no `--head` (it equals `--from`):

  ```bash
  cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" outcome '<owner>/<repo>#<N>' --outcome pushed --reason '<one line>' --from <fromSha> --head <headSha>
  cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" outcome '<owner>/<repo>#<N>' --outcome stopped --reason '<one line>' --from <fromSha>
  cd '<root>' && node "${CLAUDE_PLUGIN_ROOT}/skills/pr-resolve/tools/pr-resolve.mjs" outcome '<owner>/<repo>#<N>' --outcome up-to-date --reason '<one line>' --from <fromSha>
  ```

  It writes `{ sessionId, outcome, reason, fromSha, headSha, at }` to `outcomeFile`, temp file plus `rename`; `sessionId` is `$CLAUDE_CODE_SESSION_ID`, or
  `null` outside Claude Code. Keep the reason ONE line and write every apostrophe in it as `’`, so the single quotes cannot break. The tool is the one writer of
  `~/.backlog-manager/pr-resolve/` — never write there any other way.

- **(e)** Post one comment, the body in a temp file written in the same call:

  ```bash
  BODY="$(mktemp)" && cat > "$BODY" <<'EOF'
  <the comment>
  EOF
  gh pr comment <N> --repo '<owner>/<repo>' --body-file "$BODY"
  ```

  On `pushed`: what was resolved, file by file, and which checks ran — naming any failure the base has too, or that no check is defined. On `stopped`: which
  files and hunks were judgment calls and why (or which checks failed, summarised, or what could not run or was rejected), and that nothing was pushed. On
  `up-to-date`: that the branch already had the base.

- **(f)** The final message: mirror the comment, then end with the one final line — `pr-resolve: pushed`, `pr-resolve: up to date — nothing pushed`, or
  `pr-resolve: stopped — <one-line reason>`.

A failure in (b), (d) or (e) — a tree that will not go, an outcome file that cannot be written, a comment that fails or is denied — **never changes the
outcome**: a push that landed is still `pushed`. The final message names each failed act, and a tree left behind is named by path.
