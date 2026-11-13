---
name: backlog-review
description: >
  Review this checkout's change against its base — committed, uncommitted and untracked — with one backlog-reviewer per file group in parallel; incremental when
  the branch was reviewed before. Use it for /backlog-review, review my changes, review this branch, review task 12 / bug 7 against its plan, code review before
  I push, or re-review after a fix. Offers to fix; never commits. Trigger: /backlog-review
trigger: /backlog-review
---

# /backlog-review — review this checkout's change, standalone

Arguments, all optional, in any order: `[<id>] [full] [--base <ref>] [review flags]`.

- `<id>` — a backlog item (`task-12`, `bug-7`, or a tracker issue number). The review then also judges the change against that item's plan or fix. Without
  it: a pure code review.
- `full` — review the whole change against the base even when an earlier review of this branch would allow an incremental one.
- `--base <ref>` — the branch the change is measured against.
- review flags — the reviewer model and effort for this review only, spelled as `review.mjs` reads them: `--review-mode same|split`, then with `same`
  `--review-model` / `--review-effort`, with `split` `--review-big-model`, `--review-big-effort`, `--review-small-model`, `--review-small-effort`,
  `--review-small-max-lines <n>`. A model is `default`, `opus`, `sonnet`, `haiku` or `fable`; an effort `default`, `low`, `medium`, `high`, `xhigh` or `max`.
  Without them the review uses Settings' `review.json`, else the defaults. A bad flag stops the review at `scope`, before anything is dispatched, with the
  tool's own sentence.

## 1. Resolve the tree, the base and the item

Nothing is dispatched until all three are settled, and each refusal below is one sentence with nothing reviewed.

**Tree** — the current checkout: `git rev-parse --show-toplevel`. Its uncommitted and untracked work is part of the change (`scope` snapshots it without
touching the index or the working tree); gitignored files are not.

**Base** — `--base <ref>` when given. Otherwise the remote's default branch: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` prints
`origin/<branch>`, and `<branch>` with the `origin/` prefix stripped is the base; it prints nothing and the base is `main`. Then

```bash
git -C <tree> rev-parse --verify --quiet refs/heads/<base>
```

and when that prints nothing, refuse: `<base> is not a local branch here — fetch or create it, or pass --base <ref>.`

**Item** — only with `<id>`. A project whose `backlog/source.json` says `github` is a tracker project; any other is a files project.

- Files: `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" show <id>` prints the item's absolute path on line 1, wherever the item is (`open/`
  or `done/` — an `in-place` execute archives to `done/`). `outcome` is `present` when that file has a `## Outcome` heading, else `none`.
- Tracker: `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog/tools/backlog.mjs" show <id> --json` and write its `body` alone to `<prefix>-<n>.item.md` beside the
  report (§2) — the review's own snapshot, never a file in the repo. `outcome` is `none`: an execute session's Outcome lives only inside that session.

`show` exiting `5` refuses: `The backlog-manager stack is down, so tracker item <id> cannot be read — /backlog-review without an id still works.` Any other
non-zero exit refuses: `No item <id> in this checkout's backlog — nothing reviewed.` Never search for the file another way.

## 2. Where the reports go

Every file of a review lives under `<tmpdir>/backlog-review/<repo key>/`, never in the repo, so a report can never become part of the change it
describes. `<repo key>` is the one the review state uses — the main checkout's directory name plus the first 8 hex of the SHA-1 of the absolute git common
dir — and the name is `<branch>-<n>`, the branch with every `/` turned into `__` (a detached HEAD is `detached`) and `<n>` the next free integer from 1:

```bash
node -e '
const { execFileSync: x } = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const git = (...a) => x("git", ["-C", process.argv[1], ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
let branch; try { branch = git("symbolic-ref", "--quiet", "--short", "HEAD").replaceAll("/", "__"); } catch { branch = "detached"; }
const key = path.basename(path.dirname(common)) + "-" + crypto.createHash("sha1").update(common).digest("hex").slice(0, 8);
const dir = path.join(os.tmpdir(), "backlog-review", key); fs.mkdirSync(dir, { recursive: true });
let n = 1; while (fs.readdirSync(dir).some((f) => f.startsWith(branch + "-" + n + "."))) n++;
console.log(path.join(dir, branch + "-" + n));' <tree>
```

It prints `<prefix>`. The merged report is `<prefix>.md`, each group's `<prefix>.g<k>.md`, the manifest `<prefix>.manifest.json`, a coverage retry's
`<prefix>.retry.md`. Each review — the first and every re-review — takes a new `<prefix>`.

## 3. Review

Follow `references/procedure.md` (in this skill's directory) in full, with: `tree` — the tree; `base` — the base; `item` — the item's path or its
snapshot, absent without `<id>`; `mode` — `full` when the arguments say `full`, else absent; `report` — `<prefix>.md`; `manifest path` —
`<prefix>.manifest.json`; `config` — the review flags exactly as given, or nothing; `outcome` — as §1 found it.

The procedure is a reference file, read without `${CLAUDE_PLUGIN_ROOT}` filled in. Its tool is this skill's own, and every command it shows runs as

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-review/tools/review.mjs" <subcommand> …
```

with the path exactly as it reads here.

When `scope` reports an empty change, nothing is dispatched, nothing is merged and no review state is written:

- `"noChange":true` — print the sentence `scope` wrote: `no changes since the last review (<report path>) — its verdict stands: <verdict>`.
- `"files":0` — print `nothing to review — no changes against <base>`.

## 4. Show the result

From `merge`'s stdout and nothing else — never the report body:

- the mode: `full` or `incremental`, and when a review fell back to full, why (`scope`'s `full review: <reason>` line);
- the verdict;
- the Critical and Important lines exactly as `merge` printed them, resolved to their `path:line`, plus how many were `unanchored` and how many Minor
  findings the report holds;
- earlier findings: how many were handed out (the manifest's groups' `earlier`), how many came back resolved, and the still-open ones (`(earlier)` lines);
- the merged report's path.

**`incomplete`** is a coverage failure, said plainly: these files were never reviewed (the `uncovered` list), here are the report paths, and there is no
verdict — nothing is approved and no fix is offered.

## 5. Offer to fix

When the verdict is `fix`, or `merge`'s `minor` count is above zero, offer with AskUserQuestion, options in this order:

1. `Fix Critical and Important (Recommended)`
2. `Fix all, including Minor`
3. `Don't fix`

Only a session that can ask makes the offer. A headless `claude -p` session gets no offer and makes no fix: it shows the result and stops. When the
AskUserQuestion call is denied by an autopilot gate, take the Recommended option and log it with `autopilot decide "<what>" "<why>" "<cost if wrong>"`.

On a fix choice, **this session** fixes — never the reviewer, which is read-only — exactly the findings named: the Critical and Important lines (earlier
still-open ones included), each read at its resolved `path:line`; for `Fix all`, also the merged report's `## Minor` section, the one part of a report
read into context and only then. Then run the verification the repo's `CLAUDE.md` names (its tests, its typecheck) and show their real output.

The fix **commits nothing**: no `git add`, no commit, no stash — the same as an `in-place` execute. Staging is the person's call.

Then offer a re-review of the fix (`Re-review the fix (Recommended)` / `Stop here`, the same autopilot rule). It is an **incremental** review: §2 for a new
`<prefix>`, then §3 with `mode` absent even when the first review was `full` — the review just merged wrote this branch's state, so `scope` diffs only from
that review's snapshot to the fixed tree and hands every finding it left open back to a reviewer to mark `resolved` or `open`. This is deliberately not
the procedure's §5 (`scope --previous`), which re-reads every touched group's whole files and is the gates' re-review: a standalone review is often
incremental, and `--previous` would put every file of the branch outside that increment into group 1. A detached HEAD has no state, so its re-review is
simply full.

A fix is offered at most two times per invocation — two fix rounds. After the second, show what is still open and stop offering.

## Hard limits

- Never commit, stage, stash, push or switch branch, in the review or in a fix.
- Never write a report, a manifest or a snapshot inside the repo.
- Never read a group report or the merged report into context, save the `## Minor` section after `Fix all, including Minor`.
