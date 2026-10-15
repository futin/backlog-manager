# backlog-orchestrate — the github-source (tracker) path

Read this file **in full, once**, when the project's committed `backlog/source.json` says `github` — before §1 on a fresh run, or on `--resume` after `claim` and
before `reconcile` (`references/recovery.md`). A files project never opens it. Everything here is
the tracker-only part of the steps in `SKILL.md`; each heading names the step it belongs to, and the body leaves a one-line `Tracker:` marker at every site that
moved. Where the body keeps a literal git call (the §2 probe, the §4 pull, the §9 push, the merge), only its explanation lives here.

A project whose committed `backlog/source.json` says `github` has **no item files**: its items are GitHub issues, and the run reads and writes them through the
backlog-manager API on this machine. **Every step of `SKILL.md` is otherwise unchanged** — the gate, the questions hunt, the worktree, the dispatch, the review,
the verification and the merge are all the same work, and the paragraphs that describe them are the ones to follow.

Section and step numbers below name sections of `SKILL.md`. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace
it in any command copied from here, as `SKILL.md` says to for its own re-reads.

## Overview — what differs, by step

What differs is gathered here, and each item names the section it belongs to. A files project takes none of it.

- **Ids are bare issue numbers inside a run: `31`, never `#31`.** Every `<id>` placeholder in `SKILL.md` is that number, in every command and in the dispatch
  prompt. `#` opens a comment in a shell, and a `#31` substituted into one of these fenced blocks would swallow the rest of the line.
- **The stack must be up.** Exit `8` from any command means it is not; start it and retry the same call. There is no offline mode on purpose.
- **The driver holds the item's claim, not the execute session** (§3, §9). The run claims the issue at `stage <n> preflight`, before the worktree exists, and
  releases it at the item's terminal stage — or at `finish`, which releases everything the run still holds (a `needs-answers` item's claim, say) on every
  status but `paused`, `abort` included (§10). A `parked` item carried forward by hand (`stage <n> inspecting` and on) claims again on that first
  `stage` out of `parked`, because the park released it (#250); a refusal there skips it, leaving its worktree and branch in place. The dispatched session
  never runs `start`, `stop`, `move` or `heartbeat` on the item — its SKILL.md says so.
- **A claim refusal naming another run is a skip, not a failure** (§3). Another machine is draining the same project and got there first.
- **The session's `## Outcome` goes to a file, and the file becomes the closing comment** (§4, §5, §9).
- **The reviewer and `verify` read a snapshot** (§5, §7) — `orchestrate.mjs snapshot <n>`, which writes the issue's body plus that Outcome to one file.
- **The run pushes** (§9). Pull before each item's worktree, push after each merge, close the issue only once the push succeeded.
- **The queue comes from a cache, and every preview says how old it is** (§1, §2). A tracker project's items are read from the poller's cache — the hourly rate
  limit makes a per-request fetch impossible — so `plan` and `init` print `queue built from the tracker cache (polled 12 s ago) …` beside the queue they built.
  An issue filed at GitHub since that poll is not in it yet. A `--ids` entry the cache has not seen is re-read once, after the next tick is due, and refused
  only if it misses twice; that refusal names the age. If an issue you just filed is missing from a preview, re-run the preview rather than doubting the number.

## Exit codes `8` and `9` — the exit-code table

- **`8`** — **tracker projects only**: the backlog-manager API is not running. **Nothing is written.** Start the stack (`pnpm run dev` or `pnpm run docker:up`) and
  retry the same command; a files project can never see this code.
- **`9`** — **tracker projects only**: an API refusal this command could not absorb (no token, a 502 from GitHub, a 400 naming a field). **Nothing is written.**
  Not a call to fix and retry: park the item with `attention <n> --kind parked --detail "the API refused this step — <what the API refused, your words>"`,
  then `stage <n> parked`. The server's sentence is composed from what GitHub said, so it is read in this session's output and summarised — never pasted into
  the detail, which is published on the issue.

## §2 Start the run — the merge-mode probe

The probe's literal call stays in the body, under "Merge mode, and the probe before item 1". The tracker's shape is used **because §9's merge there carries three
`-m` messages rather than `--no-edit`, and a probe of the other shape asks the classifier a different question** (#222). Same effect as the files probe —
`Already up to date.`, exit `0`, no commit — and it pushes nothing, deliberately: a denied push parks rather than degrades (§9), so there is nothing for a push
probe to decide.

## §2 Start the run — PR mode's run branch

`--merge-mode pr` is a tracker-only mode: `init` refuses it with exit `1` and nothing written on any project whose committed `backlog/source.json` is not
`github`, and the server refuses it with a 400 before spawning. A files project has no remote ruleset to route around, and opening a PR is a publish, which a
files project never gets.

**What `init` does, in order.** It validates `--base` as it always does — here it names the PR's target, default `main` — pulls it (the same pull every
tracker `init` makes), runs every refusal it has (the queue gate, the exit-`4` existing-run check), and only then mints the run branch and creates it at the
target's tip with `git branch --no-track <run branch> refs/heads/<target>`, the last git write before the run file. So a refused `init` leaves no branch behind,
and an `init` whose run-file write then fails leaves an empty one, which is harmless: the next mint steps over its number.

The name is `backlog/run-<YYYY-MM-DD>-<n>`, the machine's local date, `<n>` one more than the highest already used that day (starting at `1`), read from this
repo's local refs **and** from `git ls-remote --heads origin 'backlog/run-<date>-*'`. The remote read is there because a tracker project is multi-machine by
definition: two machines starting a run the same day must not mint one name. Only refs shaped exactly `backlog/run-<date>-<digits>` count, so a stray
`backlog/run-<date>-wip` never moves the number. The name cannot collide with an item branch, since no item id is `run-…`.

**A failed `ls-remote` is not a refusal.** No `origin`, offline, an `origin` that wants credentials (git is run with `GIT_TERMINAL_PROMPT=0` and a timeout, so
it fails instead of prompting or hanging) — any of them prints one stderr line, `warning: git ls-remote origin failed … minting the run branch from local refs
only …`, and the mint goes on from local refs. Read the line, mention it in the summary, and carry on.

**Two machines can still mint one name** — a failed `ls-remote` on one of them, or two `init`s inside the same second. The second machine finds out at its first
merge: the push of the run branch is rejected and that item parks, exactly as §9 says. The usual recovery for a rejected push — `--resume` pulls and pushes
again — does **not** hold here, because §4's pull is skipped in PR mode and the remote branch is another run's. The recovery is `--abort` and a fresh `init`,
which mints the next number; the parked item's merge stays on the abandoned local run branch, and the summary names that branch.

**Why the run branch is `base`, and the target is a new field.** The run file records `base: <run branch>` and `prTarget: <target>`. Everything downstream
already reads `base` — §1's gate, §4's worktree cut, `merge-check`'s base-tree resolution, `cleanup`'s commands, `--resume`, the claim's `ClaimRun.base` — and
each one does the right thing once `base` names the run branch, so nothing there had to learn a second field. Only the pull request reads `prTarget`. No tree
has the run branch checked out, so `merge-check` takes its "none does" outcome: it creates `.worktrees/_base-<sanitised run branch>`, merges there, and §10
removes that tree because `baseTree.created` is true.

## §3 Pre-flight, per item — the claim

**In a tracker project the `stage <n> preflight` call is where the run takes the issue** — it posts the claim comment that stops a second machine working this
item, before a worktree exists and before anything is spent on it. Three outcomes, and the tool prints which:

- **`{"id":"<n>","stage":"preflight"}`** — the run holds it. Carry on.
- **`{"id":"<n>","stage":"skipped","note":"claimed elsewhere …"}`**, exit `0` — another run holds it. **This is information, not a failure**: another machine is
  draining the same project and reached this item first. Do not retry, do not create a worktree, do not park. Move to the next item.
- **exit `9`** — the claim was refused for some other reason (no token, a 502 from GitHub). Nothing was written and the run cannot know whether it holds the
  item, so it must not proceed: `attention <n> --kind parked --detail "the claim for this item was refused — <what the API refused, your
  words>"`, `stage <n> parked`, and continue with the next item.

## §3 Pre-flight, per item — Hunt for open questions: `attention` becomes a comment

**In a tracker project every `attention` call also becomes a comment on the item's issue** — a `<!-- bm:attention kind=… run=… -->` line, then an `@mention`
of the token's user and your `--detail`, so the notification reaches a phone rather than only the board's strip. Best-effort: a comment the API refuses is one
stderr line and the command still exits `0`, because the entry is already in the run file. It does mean `--detail` is now **published text on somebody's
issue**, which is one more reason it is always your own words and never a quote from a report or a log.

## §4 The loop — Pull the base first

The two literal commands stay in the body, under "Pull the base first — tracker projects only".

**Before every item's worktree, not once per run.** A tracker project is shared by definition, and another machine draining the same queue pushes its merges to
the same base; an item cut from a stale base is verified against a commit nobody else's base matches, and its own push is rejected at the end of the pipeline
after the whole item has been spent. `<base tree>` is the first command's output, re-resolved every time and never read back from the run file: a recorded
`baseTree.path` can go stale between items, and a pull in a tree somebody has since switched to another branch fast-forwards that branch instead. On an ordinary
`main` run the output is the project root, and on a `--base` run it is not. Never rewrite the scan as `awk` over `$0`: slash-command substitution rewrites `$0`
to the run's first argument, so a run started as `/backlog-orchestrate 172` read `substr(172,10)` and always printed nothing (#238).

A non-zero exit **parks the run**, because what cannot fast-forward is the branch every remaining item would be cut from:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <n> --kind parked --detail "<base> cannot fast-forward onto origin — another machine pushed something this tree cannot take; resolve it by hand, then resume"
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <n> parked
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" finish --status paused
```

`init` ran the same pull once, before it built the queue, so on the ordinary path this never fires for the first item. It is here because a run lasts hours and
the other machine does not stop pushing while it does.

**In PR mode both commands are skipped**, keyed on `mergeMode` — the requested mode — so a PR run degraded to branch mode skips them too. The run branch is this
run's alone: no other machine merges into it, so there is nothing to pull. And before the first merge's push the remote branch does not exist at all, so the
pull would fail and park the run on its first item. (`init`'s own pull is unaffected: it freshens the PR target before the run branch is cut from it.)

## §4 The loop — Create the worktree: the `show` probe

The probe that proves the item survived the checkout is `backlog.mjs show <id>` from inside the new worktree; it is **skipped in a tracker project**, where an
item is an issue and no tree holds a file to wander off to.

## §4 The loop — Dispatch the headless session: the `outcome` clause

**In a tracker project the marker gains one clause, and it is not optional**: `outcome <dir>/outcomes/<n>.md`, an absolute path, immediately before the closing
`.]`. Create the file empty first — `mkdir -p "<dir>/outcomes" && : > "<dir>/outcomes/<n>.md"` — so the session has somewhere to write and §5 can tell "wrote
nothing" from "was never given a path".

```
[orchestrator-run <runId> item <n> of <m> branch backlog/<n> outcome <dir>/outcomes/<n>.md: you are dispatched by …]
```

That clause is the session's only way to report: a tracker item has no file to append `## Outcome` to, and the session must not write the issue itself — the
driver holds the claim and the driver closes the issue. `backlog-execute`'s own tracker bullet reads that path out of this marker, so the two files agree on
one spelling and a test pins it.

The path goes under the run-state directory, never in the worktree. §6 stages the worktree with `add -A`, so an Outcome written there would be committed into
the project's history — an execute session's report landing as a file on the item's branch, in a repository whose items are issues.

## §5 Inspect what the session left behind — the outcome file and the snapshot

**In a tracker project there is no item file to look at, and the evidence is `<dir>/outcomes/<n>.md` instead.** The three readings map one for one, and the
middle two take exactly the branches of the three readings in §5:

- **Non-empty, carrying real verification output** → succeeded on its own terms. Continue to Commit.
- **Non-empty, describing a failure** → execute's own failure path. Same branch as the second reading in §5.
- **Empty or absent** → the session died. An empty outcome file is the same evidence an unmoved item file is, and takes the same branch.

`orchestrate.mjs inspect <n>` reads that file for you: `item` is `"outcome"` for a non-empty one (which of the first two readings is yours to judge) and
`"no-outcome"` for an empty or absent one. In a tracker project it also writes the snapshot the reviewer and `verify` both read, which is the same command you
run by hand after a fix loop:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" snapshot <n>
```

The snapshot is `<dir>/items/<n>.md` — the issue's body, then `## Outcome`, then that outcome file — which is byte for byte what a files run's item file looks
like at this point in the loop. **Run it again after every fix loop**: the Outcome grows with each one, and a reviewer handed the first loop's snapshot would be
reading a report that no longer describes the branch.

## §7 Review — the item file path, and the fix loop's paths

- **The reviewer's `item file path` is `<dir>/items/<n>.md`** — the snapshot §5 just wrote, which is the issue's body with the session's `## Outcome` appended.
  The field is the same field and the reviewer reads it the same way; only the path moves.
- **A fresh fix session's prompt file** names `<dir>/items/<n>.md` as the item file path the reviewer read, and `<dir>/outcomes/<n>.md` as where to append the
  `### Fix loop <k>` record. In those two tracker paths `<n>` is the issue number, as in §5, not this loop's count.
- **Both fix modes then re-run §5's `snapshot <n>`** before reviewing again with a fresh report path (`<dir>/reviews/<id>-2.md`).

## §9 Merge — branch mode: the push before the worktree goes

The literal call stays in the body, at the top of §9. A branch left on one machine is invisible to every other, and the whole point of a tracker project is that
the work is not on one machine. The issue stays **open**: nothing has landed on the base, and the pushed branch's own merge commit closes it whenever a person
merges it, through the `Fixes #<n>` of the tracker merge. A failed push **parks** the item exactly as a failed merge does — `attention <n> --kind parked --detail
"push of the item branch to origin failed — branch and worktree kept, nothing merged"`, then `stage <n> parked` — and the worktree and branch stay where they
are. The detail is those fixed words and nothing of git's: git's refusal can carry a backtick, a `$` or a newline into a double-quoted argument, and it is not
this run's text to publish on the issue either — read it, then park.

## §9 Merge — the tracker merge's shape

The literal call stays in the body, under "`--no-edit` gives way to three `-m` flags". Free provenance: `git log` then names the issue every merge came
from, and GitHub's own close-on-push is idempotent with the close the tool performs at `stage <n> merged --outcome`, so the two cannot disagree. `--no-edit` is
dropped because `-m` already supplies the message — no editor can open either way. The `Reviewed:` line names the approving report (`<k>` is the loop that
approved it, `1` or `2`), so the classifier sees the review inside the command it is judging; without it, "merge into the base" reads as an unreviewed publish
(#222).

The one-call rule (the driver never chains `git merge` with anything else, the push included) is not tracker-only and stays in the body, beside the merge.

## §9 Merge — the push, and its three outcomes

The literal call stays in the body, with a one-line version of each outcome. The order is not negotiable: merge, then push as its own Bash call, then the stage.

- **It succeeds** → `stage <n> merged --outcome "<dir>/outcomes/<n>.md"` in place of the plain `stage`. That flag is **required** here (a plain
  `stage <n> merged` exits `1` and writes nothing) and refused in a files project: it is what closes the issue, with the session's Outcome as the closing
  comment. If the close is refused the command exits `9` having written nothing — park the item with `attention <n> --kind parked --detail "merged and pushed; the
  issue was not closed — <what the API refused, your words> — close it by hand"`, then `stage <n> parked`, and carry on. The merge is real and pushed; only the bookkeeping is
  outstanding.
- **It is rejected** (non-fast-forward) → another machine merged into the base meanwhile. `attention <n> --kind parked --detail "merge landed locally but the
  push was rejected — another machine pushed to <base>"`, then `stage <n> parked`. The merge stays local and `--resume` pulls and pushes again. **Do not**
  `push --force` and do not reset. In PR mode a rejection means another run minted the same run branch name, and `--resume` cannot fix that (§2, _PR mode's
  run branch_, has the recovery).
- **It is denied by the auto-mode classifier** → **park it too.** This is the one place the classifier-denial rule does _not_ apply: a denied MERGE
  degrades the run to branch mode, because nothing landed and "branched" is then a true description. A denied PUSH is the opposite — the merge has already
  landed in the base tree, so staging the item `branched` would write a falsehood into the run file and into the summary a person reads afterwards. Park with
  `attention <n> --kind parked --detail "merge landed locally but the auto-mode classifier denied the push to <base> — push it by hand"`, then
  `stage <n> parked`, and leave the merge where it is. The classifier's `Reason:` is model-written prose, so it is read and never put in the detail — the same
  rule §2's `merge-mode branch --note` follows for a denied merge.

The close is tied to the STAGE rather than to the merge because the tool cannot see the push: it has no way to know whether the commit it is recording ever left
this machine, so the driver calls `stage merged` only once the push has succeeded, and the tool closes the issue as part of that call.

`cleanup <id>` runs after the push in a tracker project, as it runs after the stage in both modes.

**In PR mode the push is the same command, byte for byte** — `git -C "<base tree>" push origin <base>` — and `<base>` is the run branch, so the first merge's
push creates the remote branch and every later one moves it. Its three outcomes are unchanged, and so is the close: the issue closes at `stage <n> merged
--outcome`, at the item's merge into the run branch, not when the PR merges. Closing at PR merge would leave the item open after its claim was released, and
the next run would queue it again. The price is that a PR closed without merging leaves closed issues whose work never reached the target; that is a person's
decision, and reopening those issues by hand is its fix.

## §10 Finishing, resuming, aborting — what the tool publishes

- **`finish`** also stamps `--status` on the run's last-touched claim (`finished: { at, status }`), which is how another machine's Runs page tells a finished run
  from a crashed one; like every publish to the issue it is best-effort, one stderr line on failure and exit `0`. The tool also keeps `orchestrator:queued` — the
  run's plan, on the issues — by itself: `init` adds it to every queue item, a skip takes it off, and every `finish` but `paused` (and so every `abort`) sweeps it
  off each item the run never claimed; you run nothing for it, and a failed label write is a warning, never a park.
- **`heartbeat`** also heartbeats every claim the run still holds — `needs-answers` items included — so a long review cannot let the in-flight item's claim go
  stale and read to another machine as a crashed run it may contest. Nothing extra to run; the same one line does both.
- **`--abort` gives every claim the run still holds back**, with the reason `aborted`, before it ends the run. Nothing to do by hand: the tool does it,
  best-effort, and a refusal is one stderr line rather than a failed abort. It matters because a run torn down this way reaches no terminal stage, and an
  unreleased claim keeps the item's dispatch control disabled on every machine's board — going stale does not clear it.

## §10 Finishing — The pull request (PR mode)

The commands stay in the body, under _Finishing_. What they rest on:

- **Who opens it.** The driver, with `gh pr create`; the tool composes the title and body (`pr-draft`) and records the URL (`pr --url`), and makes no GitHub
  call itself. That keeps the one network write in the driver's own Bash call, where a refusal is seen and handled. `pr-draft` writes only
  `<dir>/pr/body.md`, and refuses with exit `1`, writing nothing, when the run is not `pr`, when no item is `merged`, or when `prUrl` is already set — the PR
  exists, and a resumed session must not draft a second one. The title can ride argv because the tool built it from a fixed vocabulary and a count:
  `<type>(backlog): <N> item(s)`, the type ranked `feat` > `fix` > `perf` > `chore` across the merged items' own commit subjects.
- **Why the open-PR lookup comes first, and why it matches OPEN PRs only.** A session that died between `gh pr create` and `pr --url` left a PR that the
  run file does not know about. A resumed session asks GitHub before creating, so it records that PR instead of failing on a duplicate. The lookup is
  `gh pr list --head <head> --state open`, never `gh pr view <head>`: `view` also matches a merged or closed PR, and a run branch name can be reused — GitHub
  deletes a merged PR's head branch, and a machine that never held the first run's branch locally mints the same name — so a second run would record the
  first run's merged PR as its own and never open one. An open PR from this head is this run's, because a name is minted only while no branch holds it.
- **The PR gate keys on the requested `mergeMode`, never `mergeModeEffective`** — the same key §4's pull skip, `pr-draft` and `finish` use. A PR run degraded
  to branch mode still merged its first items onto the run branch and closed their issues, and only the PR carries them to `prTarget`.
- **A failed or classifier-denied `gh pr create` is not a park and does not change the finish status.** Every merged item is merged, pushed and closed; only the
  PR is outstanding. `prUrl` stays `null`, and the summary names the pushed run branch and gives the exact `gh pr create --base <target> --head <head> --title
  "<title>" --body-file "<bodyFile>"` line, filled in, for a person to run. `gh`'s failure output and the classifier's `Reason:` are read and never put into
  any tool argument, the rule §2's `--note` follows; the one piece of `gh` output that travels is a PR URL, and only through `pr --url`, which refuses anything
  but `https://github.com/<owner>/<repo>/pull/<n>` and refuses a run that is not `pr` mode.
- **No PR on `paused` or `aborted`.** A paused run is resumed onto the same run branch later, so a PR then would be premature. An aborted run was torn down by
  a person's Stop or a `--abort`, neither of which should grow a publish step; its summary names the pushed run branch and gives the `gh pr create` line, built
  from `pr-draft`, which writes only under `<dir>` and so is not a publish.
- **Nothing merged: `finish` deletes the empty run branch.** On every finish but `paused`, a run whose `mergeMode` is `pr` with no item `merged` has its local
  run branch deleted by `finish` itself — but only when `git rev-list --count <prTarget>..<base>` is `0` and no worktree has the branch checked out. The delete
  is `git update-ref -d refs/heads/<base> <sha it just read>`, a compare-and-delete that depends on no tree's HEAD. Otherwise the branch is kept with one stderr
  line, and `finish`'s exit code never changes: a merge that landed locally with its push refused leaves commits there, and an aborted run can leave its
  `_base-` tree holding it. Name a kept branch in the summary. Nothing was pushed, so there is no remote branch to delete. A degraded run that branched every
  item and merged none goes the same way — its branched items were cut from the run branch while it still equalled `<prTarget>`, which is why §10's merge list
  names `prTarget` as the branch to merge them on.
- **After a PR opens, nothing deletes the local run branch.** The repo setting deletes only the remote head when the PR merges. That kept branch is why the
  mint reads local refs as well as `origin`: a second run the same day mints the next number even after the first one's remote head is gone. Leave them:
  a `backlog/run-*` branch deleted by hand on the day it was minted frees its name for the next run.

## Hard limits — the three pushes

**Never pushes a files project. A tracker project is the one exception, and it is exactly three commands** — `pull --ff-only origin <base>` before each item's
worktree, `push origin <base>` after each merge, `push -u origin backlog/<n>` under branch mode — because its items are issues every machine reads, so a merge
that stayed on one laptop would be a run reporting `merged` for work nobody else can see. A rejected or classifier-denied push **parks**, never degrades: the
merge has already landed, so `branched` would be a falsehood.

**PR mode adds no fourth git command.** Its `push origin <base>` is the same §9 push, with the run branch as `<base>`, and its `pull --ff-only` is skipped. It
adds exactly one remote write beside the three: the finish's `gh pr create`, which opens the run's pull request.
