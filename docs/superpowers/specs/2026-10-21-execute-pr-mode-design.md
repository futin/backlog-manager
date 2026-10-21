# backlog-execute: a per-project finish mode that ends in a pull request

Date: 2026-10-21. Status: draft, awaiting approval.

## Why

`backlog-execute` does the work, verifies it, archives the item — and stops, because its hard limit says "never commits, never pushes". In practice almost every
hand-run execute is followed by the same request typed by hand: commit it, push it, open a PR. The stop is no longer protecting anything the user wants
protected; it is a step they repeat every time. The orchestrator already proves the shape that makes committing safe (a worktree cut from the base that holds
one item's work and nothing else), and the Jira Run's **Open MR when done** switch already proves a session can push and open a merge request when a person
asked for it up front.

The ask: make "run in a worktree from the base, commit, push, open a PR" a committed per-project config, and have execute do it every time, with no extra
question.

## Goals

- A project can set its execute **finish mode** to `pr`. From then on every execute in that project — typed `/backlog-execute` in a session, or the board's
  Run on a card, which spawns the same skill — works in a worktree cut from the base, and on verified success commits, runs the reviewer, pushes the branch and
  opens one PR into the base. No question is asked; the mode is stated in one line when the session starts.
- `in-place` stays the default and behaves exactly as today. A project with no config, or with `in-place`, sees no change at all.
- A one-off override is possible only by the person saying so in the trigger's own words, with the exact phrase "in place this time" (e.g. "execute task 12,
  in place this time"). Generic commit wording elsewhere in a prompt is not an override. The skill never offers one.

## Non-goals

- No third mode (worktree + push branch, no PR). Two modes only: `in-place`, `pr`.
- No new board UI: no Settings control, no new card badge. Server and shared changes are limited to the tracker `in-review` guard (decision 9: a label, one
  write route, the gates that read it) and the prompt change below. **The prompt change is required** (review 1, Critical): the board's execute prompt ends
  in `COMMIT_RULE` (`shared/agent.ts:827-830`, appended unconditionally by `composePrompt`, `server/src/agents/prompt.util.ts:29`), which says "commit … stage
  only the files this session changed … Do not push." — the opposite of steps 6 and 8, and the most specific instruction the spawned session gets. My call:
  `composePrompt` reads the project's effective finish mode (a read of the committed config, never a write) and, for an `execute` in a `pr` project, appends a
  pr-mode sentence instead of `COMMIT_RULE` ("Finish in this project's `pr` mode: the skill commits, reviews, pushes and opens the PR."). Groom and capture,
  and execute in an `in-place` project, keep `COMMIT_RULE` byte for byte. The "known seam" comment above `COMMIT_RULE` (`shared/agent.ts:819-825`) is the
  place it says the reconciliation starts, and is rewritten with it.
- No machine-wide default. The config is per project and committed, so a team shares it and each repo can differ.
- No merging. Execute opens the PR; a human (or GitHub) merges it. `backlog-orchestrate` stays the only skill that merges.
- No change under an `[orchestrator-run` marker. The run owns the worktree, the branch and every git step; the config is ignored there, and execute still
  never commits or pushes inside a run.
- No GitLab/`glab` support. Projects with a backlog store are GitHub today (Timify work repos have none).

## Anti-goals (failure even if it technically works)

- A commit that sweeps in work unrelated to the item. The whole reason execute never committed was an unscoped `git add` in a tree it does not own; `pr` mode
  must only ever commit in a tree that holds this item's work and nothing else.
- A PR opened for work that failed verification, or before the reviewer's Critical/Important findings were dealt with.
- Asking the user "should I push / open a PR?" when the config says `pr`. That is the exact step this exists to remove.
- Breaking the orchestrator: its leftover-worktree probe parks an item when `.worktrees/<id>` or `backlog/<id>` already exists, so execute must not use those
  names.

## Decided by the user

1. **Entry points:** both — typed and board-dispatched execute behave identically, because the skill itself reads the config.
2. **Modes:** `in-place` (today) and `pr` (worktree → commit → review → push → PR).
3. **Config home:** per project, committed in the repo.
4. **Never asks** when the config says `pr`; it states the mode in one line and proceeds.
5. **Already in a worktree:** reuse it when it is clean — a linked worktree with no uncommitted changes and no commits beyond the base — and work and commit
   right there, opening the PR from that tree's existing branch. The main checkout, or a dirty or diverged worktree, gets a new worktree cut from the base.
6. **Review before push:** yes. The `backlog-manager:backlog-reviewer` agent reviews the committed diff; Critical/Important findings are fixed in a bounded loop
   before the push; the report is linked or summarised in the PR body.
7. **Verification fails:** nothing is committed, nothing is pushed, no PR — the same "no proof, no archive" rule as today. The worktree is left as it is for the
   user to look at, and the final message says where it is.

## The config

A committed file in the project's `backlog/` directory (my call: `backlog/config.json`, shape `{ "execute": { "finish": "pr", "base": "main" } }`). Both keys
optional: `finish` defaults to `in-place`, `base` to the remote's default branch (`origin/HEAD`), falling back to `main`. A malformed file or an unknown
`finish` value is an error execute reports and stops on — never a silent fall back to either mode, for the same reason an `unsupported` source never falls back
to `files`.

My call: `backlog.mjs` gets the reader (one subcommand that prints the effective config as JSON, validated) and a setter, so the skill never parses the file
itself and the file has one tool-side writer. Both are **local-file commands in both modes** (review 1): they never go through `requireStore`'s
tracker routing (`skills/backlog/tools/backlog.mjs:849-860`) and never need the stack, because the config is a committed file and the mode is read before
anything else. The rules bullet that says a github marker routes every command through the API (`.claude/rules/skills.md:19-22`, its CLAUDE.md headline and
its `invariants.md` section) is amended to name these two as the exception, the same way it already names `jira.mjs worktree`. Hand-editing the committed file is also fine — the reader validates whatever is there.
`source.json` is deliberately not reused: it is the tracker source marker with its own guarded semantics.

## The `pr` flow, end to end

Order relative to today's skill sections (Pick an item → refusal gate → mark in progress → dispatch → verify → archive):

1. **Resolve the mode** right after the trigger, before `show`: read the effective config from the tree the session starts in. Under an `[orchestrator-run`
   marker skip all of this. State the mode in one line ("finish mode: pr → PR into main").
2. **Pick the tree** (before `show`, because `show` resolves the item from the cwd's tree and the item must be read from the tree the work happens in):
   - Current tree is a clean linked worktree, `HEAD` on a **named branch other than `<base>`** (not detached, not the orchestrator's `_base-<base>` tree or
     any tree holding `<base>` itself), with no commits not in `<base>` → use it, on its existing branch.
   - Otherwise → cut a new worktree from local `<base>` (local, not `origin/<base>`: that is where a freshly groomed item is committed, the same reason the
     orchestrator cuts from local base). My call on names: `.worktrees/execute-<id>` on branch `execute/<id>`, chosen so they never collide with the
     orchestrator's `.worktrees/<id>` / `backlog/<id>`. If the branch or path already exists, stop and say so — do not reuse or delete it.
   - A new worktree gets the same setup the orchestrator gives its own (review 1): `.worktrees/` and `node_modules` (bare, no trailing slash) appended to the
     **common** git dir's `info/exclude` when absent, never `.gitignore` (`orchestrate.mjs` `ensureExcludeLines`, ~line 4260, and orchestrate SKILL.md
     §541-544), and dependencies made available before verification the way the orchestrator does it. Reuse that logic rather than a second copy where the
     builder can.
   - **A refusal before any work leaves nothing behind** (review 1): if `show`, the refusal gate or the claim race refuses after this session cut a new tree,
     the session removes that tree and deletes that branch — only those it made, and only while the branch has no commits beyond `<base>` — and the refusal
     message says it did. A reused tree is never removed.
   - Every later command (`backlog.mjs`, tests, git) runs against that tree by absolute path.
3. **Pick an item, refusal gate, mark in progress, dispatch, verify** — unchanged, inside the chosen tree. The existing "item absent from this tree → refuse"
   rule now also catches a groomed-but-uncommitted item in `pr` mode, which is correct: commit the groom first.
4. **Verification fails** → today's failure path, nothing more. No commit, no push, no PR. Final message names the worktree path and branch.
5. **Verification passes** → in a files project, today's archive step (Outcome written, `stop --keep-started`, `move … done`) — those writes land in the tree
   and so in the commit; the item moves to `done/` on the base only when the PR merges. In a tracker project, the archive is replaced by comment + release,
   with no `move` (decision 8 below).
6. **Commit** in the chosen tree: `git add -A` is safe here for the same reason it is safe in the orchestrator's tree — the tree holds this item's work only
   (step 2 guarantees it). One conventional commit; the subject must satisfy the target repo's PR-title rule where one exists (this repo's `ci / pr-title`).
7. **Review**: dispatch `backlog-manager:backlog-reviewer` with all five inputs its contract requires (`agents/backlog-reviewer.md:58-75`): worktree,
   branch, **base**, item, report path — it diffs `<base>...<branch>`, and a missing input makes it stop. It returns a verdict plus Critical/Important findings.
   Fix those, **re-run the Outcome's verification commands and append a `### Fix loop <n>` record with their output** (as the orchestrator's fix loop does,
   orchestrate SKILL.md ~830-835), commit, re-review — bounded (my call: at most two fix rounds, mirroring the orchestrator's loop). Verification red after a
   fix, or still failing review after the cap → do not push; report like a verification failure.
8. **Push and open the PR**: `git push -u origin <branch>`, then `gh pr create --base <base>` with a body carrying the Outcome summary, the review verdict and,
   for a tracker project, `Closes #<n>` — then, tracker only, add the `in-review` label (decision 9). No `gh`, not authenticated, or not a GitHub remote → the branch is still pushed and the final message says the PR was
   not opened and why. A rejected push stops there and is reported; never force-push.
9. **Leave the worktree in place** (my call): the PR may need follow-up fixes there. Final message: PR URL, branch, worktree path.

## Invariants this changes (deliberately)

- **"`backlog-orchestrate` is the only skill that commits or merges — and, for a TRACKER project only, the only one that pushes."** Both clauses go false:
  `pr` mode commits, and pushes in files projects too. New meaning: orchestrate is the only skill that **merges**; `backlog-execute` commits and pushes its
  own branch only in `pr` mode, only in a tree that holds the item's work alone, never to `<base>`, never under an `[orchestrator-run` marker. Every site
  that states the old rule moves together: `CLAUDE.md:175` and `.claude/rules/orchestrator.md:33` (byte-equal headlines, guarded by
  `test/claude-rules.test.ts`) plus that rules bullet's body (`orchestrator.md:35-37`, "No other skill touches git history at all"), `invariants.md`
  §"`backlog-orchestrate` is the only skill that commits or merges" (~434-454, incl. the push paragraph), `skills/backlog-orchestrate/SKILL.md:9`, and
  `docs/subsystems/skills.md:34`. The reasoning paragraph should say why: the original limit was about trees execute does not own; `pr` mode only commits in
  one it cut (or verified clean) for this item.
- `agents/backlog-reviewer.md`: the description and the `branch` / `report path` input lines (`:62`, `:72-73`) are widened so `execute/<id>` (or a reused
  tree's branch) and a report outside `~/.backlog-manager/orchestrator/` are legitimate inputs.
- execute's skill description ("never commits or pushes on its own") and its `## Hard limits` first bullet are rewritten to the conditional form. The
  marker section's "Unchanged: never commits, never pushes" (`SKILL.md:32`) stays as is — true under the marker — and the contract sweep's "in a hand session
  that same tree may hold unrelated in-flight changes" (`SKILL.md:257`) gains a `pr` clause: there the tree is clean by construction.
- `docs/subsystems/skills.md` documents the config file and the mode.

## Settled after the builder check (my calls)

- **Which tree the config is read from.** The starting tree, once, at step 1 — that is the tree the person (or the board's spawn) pointed at. It is not
  re-read in the new worktree. A config that exists only uncommitted in the starting tree still works for the mode, but the setter prints a one-line reminder
  to commit it, because a teammate's checkout will not see it. A groom that is uncommitted is still refused by the existing item-absent rule in step 2's tree.
- **How commands reach the worktree.** `cd <worktree> && …` on every command, never a new `--root` flag on `backlog.mjs`. The tool keeps resolving its store
  from cwd, so "writes only under the repo root `show` resolved" stays true as written — the resolved root simply is the worktree.
- **Permission denied (headless or board-dispatched runs).** A `git add`/`commit`/`push`/`gh` call refused by the permission layer — as opposed to rejected by
  the remote — stops the flow there and is reported, never retried another way. Whatever was already done stays (a local commit stays committed), and the final
  message gives the exact remaining commands to run by hand. SKILL.md says this explicitly; the board's spawn permissions are not changed.
- **The reviewer outside a run.** `backlog-reviewer` is used as-is with this session's worktree, branch and item; its description is widened from
  "`backlog/<id>` before the orchestrator merges" to cover execute's `pr` mode too. The report path is outside the repo (the system temp dir, e.g.
  `os.tmpdir()/backlog-execute/<id>-review.md`) so `git add -A` can never commit it; the PR body carries the verdict and the findings' one-line summaries, not a
  local path.

## Decided by the user after review

8. **Tracker project: the issue closes when the PR merges, not at verification.** In `pr` mode step 5's archive differs for a tracker project: write the
   Outcome to a temp file, `comment <id> --body <file>`, then `stop <id> --keep-started` to release the claim — and **no `move <id> done`**. The PR body
   carries `Closes #<n>`, so GitHub closes the issue on merge. The issue stays open, unclaimed, while the PR is in review. A files project is unaffected: its
   `move … done` lands in the commit and reaches the base with the merge.
9. **While the PR is in review, a tracker item is guarded by a label** (review 1 finding on concurrent use). Without it, an open, unclaimed issue looks
   ready to every gate, and an orchestrator run on any machine would execute it again. Files projects get no guard: the item stays in `open/` on `<base>` until
   the PR merges, and that is a named known limitation (the final message says "merge this PR before draining the backlog").

   The mechanism, modelled on `orchestrator:queued` (`server/src/tracker/labels.ts:61`, the eighth write route `POST /api/items/queue`,
   `orchestrate.mjs` `trackerQueueLabel` ~2327):
   - **A tenth tracker label, `in-review`** (my name; description along the lines of "A PR for this item is open — the work lands when it merges"), appended
     to `TRACKER_LABELS` so the poller's `ensureLabels` creates it, and its name exported as one constant the way `QUEUED_LABEL` is.
   - **One new guarded write route** that adds or removes it, held to the same guards as the other item write routes (content-type, origin, refused for a
     `files` project, serialised per item), and a `backlog.mjs` verb that calls it (my name: `review <id> on|off`). The "nine `/api/items/*` write routes"
     count in `CLAUDE.md`, the rules file and `invariants.md` becomes ten — every site that states the count moves.
   - **Writer:** execute in `pr` mode adds it right after the PR is opened (after the push, so a failed push never leaves an item guarded with no PR behind it).
     A failed label write does not undo the PR; the final message says the guard is missing.
   - **Readers — the gates that must skip it:** the issue→item mapping exposes it as a flag beside `queued` (`server/src/tracker/map-issue.ts:148-249`);
     the orchestrator's queue excludes such items; execute's refusal gate refuses one ("a PR is open for this item"), naming the PR when it can; and the
     board's per-item dispatch gate (`shared/agent.ts` `dispatchGate`) disables Run on it with that reason. No new card badge — the disabled Run's reason is the
     surface (my call).
   - **Removal:** a merged PR with `Closes #<n>` closes the issue, and a closed issue is outside every gate, so the label needs no removal on the happy path. A
     PR closed **without** merging, or a non-default-base PR (`Refs #<n>`), leaves the label on an open issue: removing it is the person's
     (`backlog.mjs review <id> off`), and execute's final message says so whenever it adds the label.

   - My call (review 1): `Closes #<n>` only auto-closes when the PR targets the repository's **default** branch. With a configured non-default `base`, the
     PR body says `Refs #<n>` instead, the issue stays open, and the final message says it must be closed by hand once the work reaches the default branch —
     that is when it is actually done.

## Left to the builder

- Exact `backlog.mjs` subcommand names and output shape for the config reader/setter, and their node tests beside the tool.
- How a tracker-project heartbeat interleaves with the review loop (a long review can cross the 15-minute stale window).
- Commit/PR title derivation from the item (bug → `fix:`, task → `feat:` is the obvious default).
- Where SKILL.md text goes versus a `references/` file, following the repo's "one statement in SKILL.md, story in references/" habit for orchestrate.
