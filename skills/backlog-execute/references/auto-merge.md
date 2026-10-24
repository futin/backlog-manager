# backlog-execute — arm GitHub auto-merge, wait, and fix (`--auto-merge`, `--fix`)

Read this file **in full, once**, when the trigger carries `--auto-merge` — and only after the PR is open and any claim on the item is released. Two
callers reach it: `backlog-execute`'s `references/pr-mode.md` (§8, last) and `backlog-groom`'s `references/pr-mode.md` (its auto-merge step). A session
whose trigger has no `--auto-merge` never opens it, and neither does a session under an `[orchestrator-run` marker: no finish mode is read there.

**The skill never merges.** It asks GitHub to merge the PR it opened, once the repository's own requirements are met, and GitHub performs the only merge into
`<base>` — `backlog-orchestrate` stays the only skill that runs a merge into a base. The one `git merge` this file ever runs (Fix, "a conflict with the base")
is a merge of `origin/<base>` INTO the PR's own branch, never into a base.

Names used below, all already settled by the caller: `<tree>` is the PR's worktree and every command runs as `cd <tree> && …`; `<branch>` is the PR's head
branch; `<base>` is the PR's base; `<pr>` is the number `gh pr create` printed (the last path segment of the PR URL) — not an issue number. A reference file
is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace it in any command copied from here with the absolute path the calling
SKILL.md's own commands show.

## Bounds — soft defaults, stated here so a session never has to choose one

- **45 minutes** of wall clock from the moment auto-merge is armed. Every outcome below that is not a merge leaves auto-merge armed, so a person's later push
  or approval still merges the PR without this session.
- **3 fix rounds** at most, all inside those 45 minutes, and only with `--fix`. A round is one pushed attempt to turn the PR mergeable: a fix commit for a
  failing check, a merge of `<base>` into the branch, or one re-run of a check judged flaky (Fix, "Not this PR's failure").

## Rules that hold throughout

- **Foreground only, never background.** Every `gh`, `git` and verification call runs in the foreground — no Bash `run_in_background: true`, no `&`, no
  polling a background task's output file — and the whole wait runs inside the turn that opened the PR. A board-dispatched session is `claude -p`: it exits
  when its turn ends, and a wait handed to a notification has no session left to wake. The Bash tool caps one call at 10 minutes, so the wait is a sequence
  of bounded calls, never one long one.
- **Nothing is held.** The claim was released before this file was opened (execute: pr-mode §8's `stop --keep-started`; groom: its plain `stop`), so no
  `heartbeat`, `start` or `comment` runs here. The one `backlog.mjs` call this file makes is groom's `plan-review <issue> off`, on a merge (Wait, `MERGED`).
- **Never rebase, never force-push** — in any spelling (`--force`, `-f`, `--force-with-lease`, a `+` refspec). Every fix is a new commit on top of the branch,
  pushed with a plain `git push`. A push the remote rejects is reported with git's own words and ends the procedure.
- **Never merge, never bypass.** No `gh pr merge` without `--auto`, no `--admin`, no `gh api` merge call, no disabling a check or a branch rule.
- **A refused step ends the procedure.** The permission layer refusing a `git` or `gh` call (a denial, as opposed to a rejection by GitHub or the remote) stops
  every later step here, and it is never retried another way — another command, a wrapper shell, the API. This is execute pr-mode §8 "When a step is
  refused", applied to this file. Whatever is done stays done: an armed auto-merge stays armed, a local commit stays committed. The final message lists the
  exact remaining commands, in order, for a person to run.

## 1. Arm

1. **Is auto-merge allowed on the repository?** GitHub's repository setting "Allow auto-merge":

   ```bash
   cd <tree> && gh api repos/{owner}/{repo} --jq .allow_auto_merge
   cd <tree> && gh repo view --json nameWithOwner,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
   ```

   The literal `{owner}/{repo}` is filled in by `gh` itself from the tree's remote — type it as written. (`gh repo view --json` has no auto-merge field in
   gh 2.102.0, which is why the first read is `gh api`.) `<owner>/<repo>` below is the second read's `nameWithOwner`.

2. **Anything but `true`** — `false`, `null`, an empty answer — and the final message says exactly one line about it:

   `auto-merge: not allowed on <owner>/<repo> — PR left open`

   No wait, no fix: stop here and finish as a plain `--finish pr` session would. `--fix` changes nothing about this — it only ever runs inside a wait.

3. **The merge method**, from the second read: `--squash` if `squashMergeAllowed` is `true`, else `--merge` if `mergeCommitAllowed` is `true`, else
   `--rebase` if `rebaseMergeAllowed` is `true`. None of the three `true` → treat it as a refusal (step 5), reason `no merge method allowed`.

4. **Arm it**, and record when:

   ```bash
   cd <tree> && gh pr merge <pr> --auto --<method>
   date +%s
   ```

   The second command's number is `<armed>`, the start of the 45 minutes. Never add `--delete-branch`: the worktree stays (pr-mode §9) and a deleted remote
   branch would strand a later fix push.

   **What the call does on a PR with nothing pending** — no required checks, no required review, already mergeable — was checked against the installed `gh`
   (gh 2.102.0, `gh pr merge --help`): the help documents only the arming path ("Automatically merge only after necessary requirements are met"), and the
   behaviour on an already-mergeable PR could not be settled offline. So read it as: **the call may merge at once.** That is still what the person ticked,
   and nothing here depends on which way it went — the first read of the Wait below sees `MERGED` and takes the merged path.

5. **Any refusal** — `gh` exits non-zero, GitHub answers with an error (auto-merge not permitted for this user, a protected branch, the PR not in a state
   that can be armed), or the permission layer denies the call — and the final message says `auto-merge: refused — <gh's own words> — PR left open`.
   No wait, no fix. A denial also follows "A refused step ends the procedure" above.

## 2. Wait — always, once armed

A loop of bounded reads in the foreground, until one of the exits below. Each pass, in order:

1. **The clock.** `echo $(( $(date +%s) - <armed> ))` — at `2700` or more (45 minutes) the bound is hit: stop, leave auto-merge armed, report what is still
   pending or red (exit "Bound hit").
2. **Read the PR:**

   ```bash
   cd <tree> && gh pr view <pr> --json state,mergeable,mergeStateStatus,statusCheckRollup
   ```

3. **Act on what it says**, first match wins:

   - **`state` is `MERGED`** → done (exit "Merged").
   - **`state` is `CLOSED`** → someone closed it without merging: stop, report (exit "Closed").
   - **A red check** — any `statusCheckRollup` entry whose `conclusion` is `FAILURE`, `TIMED_OUT`, `CANCELLED`, `STARTUP_FAILURE` or `ACTION_REQUIRED`, or
     whose `state` is `FAILURE` or `ERROR` — without `--fix`: the wait ends at once, because nothing in this session will change it (exit "Stopped"). With
     `--fix`: a fix round (§3, "A failing check"), then the next pass.
   - **`mergeable` is `CONFLICTING`** — without `--fix`: ends the wait at once (exit "Stopped"). With `--fix`: a fix round (§3, "A conflict with the base"),
     then the next pass.
   - **`mergeStateStatus` is `BEHIND`** — the base has a branch rule requiring an up-to-date branch. Without `--fix`: ends the wait (exit "Stopped"). With
     `--fix`: the same round as a conflict, which then has nothing to resolve.
   - **A check still running** — an entry whose `status` is not `COMPLETED`, or whose `state` is `PENDING` or `EXPECTED` — wait on them:

     ```bash
     cd <tree> && gh pr checks <pr> --watch --fail-fast --interval 30
     ```

     with the Bash tool's `timeout` at `540000` (9 minutes) — under the 10-minute cap, so the call always returns. A call the timeout ends is not an outcome:
     the checks are still running, and the next pass reads them again. Whatever it prints, the next pass's `gh pr view` is what decides.
   - **`mergeStateStatus` is `BLOCKED` with every check finished and green** — a required review or another rule only a person can satisfy: stop, auto-merge
     left armed, report what it is waiting on (exit "Stopped").
   - **`mergeable` is `UNKNOWN`, or every check is green and the PR is still `OPEN`** — GitHub is computing mergeability, or is about to merge. Pause, then
     the next pass:

     ```bash
     node -e "setTimeout(() => {}, 30000)"
     ```

     A foreground wait of 30 seconds, written as `node` because `node` is on every machine these skills run on. Also pause once right after every fix push,
     before the next read, so that read sees the new head's checks rather than none.

### The exits

- **Merged.** The PR is in `<base>`, merged by GitHub.
  - **groom, tracker project:** `cd <tree> && node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" plan-review <issue> off`, `<issue>` the issue
    that holds the plan (the new task's number on a promote, the bug's own number on a bug). The merge is the approval, so the mark comes off now. A failed
    write is reported with the command, never retried another way.
  - **groom, files project:** nothing — the merged item file is the plan on `<base>`.
  - **execute:** nothing on the issue. With `Closes #<n>` GitHub closes it and `in-review` goes with it; with `Refs #<n>` the issue stays open with
    `in-review` on, and the final message lists pr-mode §9's hand steps as it does without auto-merge. A files item reached `done/` on `<base>` with the
    merge, so §9's "merge this PR before draining the backlog" line is not printed.
- **Closed.** Stop and report. Auto-merge ended with the PR. Groom on a tracker project leaves `plan-review` on, and the final message says so with the
  `plan-review <issue> off` command.
- **Bound hit**, **Stopped** — stop and report: auto-merge left armed, every check still pending or red by name, `mergeable` and `mergeStateStatus` as last
  read, and why the wait ended (the bound; a red check or conflict without `--fix`; `BLOCKED` on a person; a fourth round needed; not this PR's failure; a
  refusal). Groom on a tracker project leaves `plan-review` on, and says so as for Closed.

## 3. Fix — only with `--fix`, inside the wait

Before each round, count it: a round that would be the fourth is not started — the wait stops instead (exit "Stopped", reason `3 fix rounds spent`), with
auto-merge left armed and what is still red and why in the report. `backlog-reviewer` is not re-dispatched for a fix round: the round is verified, and its
commit sits on a PR a person reads.

### A failing check

1. **Read why.** The red entry's `detailsUrl` carries the Actions run id (`…/actions/runs/<run>/job/<job>`):

   ```bash
   cd <tree> && gh run view <run> --log-failed
   ```

   A red entry with no Actions run behind it (an external status or app) has no log this session can read: not this PR's failure (below).
2. **Decide whose failure it is** — "Not this PR's failure" below. Only a failure this PR causes is fixed.
3. **Fix it in `<tree>`**, touching only what the failure needs — never unrelated code, never a test weakened to pass.
4. **Verify.** execute: the same verification command(s) the item's Outcome recorded, plus the failing job's own command run locally when it differs. groom:
   the command the failing job runs, run locally. Red locally → that is the round's result: commit nothing, and the next round (if one is left) starts from
   the log again.
5. **Commit and push**, staging narrowly — `git status --short` first, then each path this round changed, by name; never `git add -A` or `git add .`:

   ```bash
   cd <tree> && git add <path> [<path> …]
   cd <tree> && git commit -m "fix: <what was failing>"
   cd <tree> && git push
   ```

   Record the commit's short sha and subject for the final message. Then pause (Wait, the `node` line) and take the next pass.

### A conflict with the base (`CONFLICTING`, or `BEHIND`)

```bash
cd <tree> && git fetch origin <base>
cd <tree> && git merge origin/<base>
```

This merges `<base>` INTO `<branch>` — the PR's own branch. Never `git rebase`, never `git pull --rebase`, never a push with force.

- **Clean merge** → git made the merge commit itself.
- **Conflicts** → resolve every conflicted path so both sides' intent survives, verify (as for a failing check, step 4), then stage the resolved paths by
  name and `git commit --no-edit`. A conflict whose resolution needs a decision the item does not answer is not guessed at: `git merge --abort`, stop, and
  report the conflicted paths (exit "Stopped").
- Then `git push`, record the merge commit's short sha and subject, pause, and take the next pass.

### Not this PR's failure

A red check is outside the PR's diff — stop and report it, never edit unrelated code to turn it green — when any of these holds:

- **It never reached the project's own commands:** the log shows a runner, checkout, setup, dependency-download, network, rate-limit or disk failure, or the
  job was cancelled or timed out by the platform rather than by a command of the project.
- **It names a missing secret, token or permission** — something only a repository admin can grant.
- **It fails identically on `<base>`:** the same workflow's latest run on the base is red too —
  `gh run list --branch <base> --workflow "<workflow name>" --limit 1 --json conclusion,headSha` reports `failure`. The base is broken; this PR did not
  break it.
- **It passes locally and fails in CI** (step 4 green, the check red) — the signature of a flaky job or an environment difference. Re-run it once, which
  counts as a round:

  ```bash
  cd <tree> && gh run rerun <run> --failed
  ```

  Red a second time in a row, with no fix commit in between → flaky twice: stop and report.

In every case the report names the check, the run URL and the lines of the log that decided it.

## 4. The final message

The caller's own final message (execute pr-mode §9, groom's final message) carries, besides everything it already lists:

- **one auto-merge line**, exactly one of:
  - `auto-merge: not armed — no PR` (the caller never reached this file: no PR was opened)
  - `auto-merge: not allowed on <owner>/<repo> — PR left open`
  - `auto-merge: refused — <gh's own words> — PR left open`
  - `auto-merge: merged by GitHub (<method>)`
  - `auto-merge: armed (<method>), PR closed without merging`
  - `auto-merge: armed (<method>), still open after 45 minutes — <what is pending or red>`
  - `auto-merge: armed (<method>), stopped — <why>` (a red check or conflict without `--fix`, `BLOCKED` on a person, `3 fix rounds spent`, not this PR's
    failure, a refused step, a rejected push);
- **every fix commit**, one line each, `<short sha> <subject>` — the fix commits and the merge commits of §3, in order — or `fix commits: none`;
- **any `plan-review` left on** (groom, tracker), with the `plan-review <issue> off` command a person runs once they approve;
- **any command not run** because a step was refused, in order.

## Where each rule comes from

The design spec, `docs/superpowers/specs/2026-10-24-groom-pr-and-auto-merge-design.md`, "Auto-merge and fix (shared by groom and execute)": "allowed" is
GitHub's own repository setting read at runtime; squash › merge › rebase; 45 minutes and 3 fix rounds as soft defaults stated here; no reviewer re-dispatch
for a fix round; the claim released before the wait. Ruled while writing this file: `BEHIND` is handled as a conflict round, a `BLOCKED` PR with every check
green ends the wait (only a person can unblock it), the "outside the diff" test is the list above with one counted re-run for a check that passes locally,
and the pause between reads is a foreground `node` timer.
