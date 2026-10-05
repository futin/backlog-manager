# backlog-orchestrate — the github-source (tracker) path

Read this file **in full, once, before §1**, when the project's committed `backlog/source.json` says `github`. A files project never opens it. Everything here is
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
  status but `paused`, `abort` included (§10). The dispatched session
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
  Not a call to fix and retry: park the item with the server's own sentence in the detail.

## §2 Start the run — the merge-mode probe

The probe's literal call stays in the body, under "Merge mode, and the probe before item 1". The tracker's shape is used **because §9's merge there carries three
`-m` messages rather than `--no-edit`, and a probe of the other shape asks the classifier a different question** (#222). Same effect as the files probe —
`Already up to date.`, exit `0`, no commit — and it pushes nothing, deliberately: a denied push parks rather than degrades (§9), so there is nothing for a push
probe to decide.

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

Then, in a tracker project only, write the snapshot the reviewer and `verify` both read:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" snapshot <n>
```

It writes `<dir>/items/<n>.md` — the issue's body, then `## Outcome`, then that outcome file — which is byte for byte what a files run's item file looks like at
this point in the loop. **Run it again after every fix loop**: the Outcome grows with each one, and a reviewer handed the first loop's snapshot would be reading
a report that no longer describes the branch.

## §7 Review — the item file path, and the fix loop's paths

- **The reviewer's `item file path` is `<dir>/items/<n>.md`** — the snapshot §5 just wrote, which is the issue's body with the session's `## Outcome` appended.
  The field is the same field and the reviewer reads it the same way; only the path moves.
- **A fresh fix session's prompt file** names `<dir>/items/<n>.md` as the item file path the reviewer read, and `<dir>/outcomes/<n>.md` as where to append the
  `### Fix loop <k>` record. In those two tracker paths `<n>` is the issue number, as in §5, not this loop's count.
- **Both fix modes then re-run §5's `snapshot <n>`** before reviewing again with a fresh report path (`<dir>/reviews/<id>-2.md`).

## §9 Merge — branch mode: the push before the worktree goes

The literal call stays in the body, at the top of §9. A branch left on one machine is invisible to every other, and the whole point of a tracker project is that
the work is not on one machine. The issue stays **open**: nothing has landed on the base, and the pushed branch's own merge commit closes it whenever a person
merges it, through the `Fixes #<n>` of the tracker merge. A failed push **parks** the item exactly as a failed merge does — `attention <n> --kind parked` naming
git's message, then `stage <n> parked` — and the worktree and branch stay where they are.

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
  `push --force` and do not reset.
- **It is denied by the auto-mode classifier** → **park it too.** This is the one place the classifier-denial rule does _not_ apply: a denied MERGE
  degrades the run to branch mode, because nothing landed and "branched" is then a true description. A denied PUSH is the opposite — the merge has already
  landed in the base tree, so staging the item `branched` would write a falsehood into the run file and into the summary a person reads afterwards. Park, with
  the classifier's message quoted, and leave the merge where it is.

The close is tied to the STAGE rather than to the merge because the tool cannot see the push: it has no way to know whether the commit it is recording ever left
this machine, so the driver calls `stage merged` only once the push has succeeded, and the tool closes the issue as part of that call.

`cleanup <id>` runs after the push in a tracker project, as it runs after the stage in both modes.

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

## Hard limits — the three pushes

**Never pushes a files project. A tracker project is the one exception, and it is exactly three commands** — `pull --ff-only origin <base>` before each item's
worktree, `push origin <base>` after each merge, `push -u origin backlog/<n>` under branch mode — because its items are issues every machine reads, so a merge
that stayed on one laptop would be a run reporting `merged` for work nobody else can see. A rejected or classifier-denied push **parks**, never degrades: the
merge has already landed, so `branched` would be a falsehood.
