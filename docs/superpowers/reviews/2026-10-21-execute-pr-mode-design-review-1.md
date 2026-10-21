# Review 1 — `docs/superpowers/specs/2026-10-21-execute-pr-mode-design.md`

Reviewer: Fable 5.1, fresh subagent, checklist review. Date: 2026-10-21.
Every claim below was checked against the code at the worktree's HEAD (`19daad1`); `file:line` references are to that tree.

## Verdict: REVISE

One Critical: the board's own dispatch prompt forbids exactly what `pr` mode does, so "typed and board-dispatched execute behave identically" with
"nothing on the board changes" cannot both be true as written. Nine Important findings, most of them edge cases the builder would otherwise have to
guess at (reused worktree on `<base>`, leftovers from a refused run, `Closes #n` on a non-default base, the re-execution window while a PR is in review,
the tracker-mode routing rule for the new subcommands, dependencies in the fresh worktree, verification after a fix round) and two false or incomplete
statements about existing text (the invariant headline, the reviewer's input contract).

## Critical

### C1. The board's dispatch prompt contradicts `pr` mode, and the spec's own override rule makes every board dispatch an override

Spec lines 22, 27, 45. Code: `shared/agent.ts:827-830`, `server/src/agents/prompt.util.ts:26-29`.

The spec says the board's Run on a card "spawns the same skill" and "typed and board-dispatched execute behave identically, because the skill itself reads
the config" (line 45), that "nothing on the board changes, no new route" (line 27), and that a one-off override is possible "only by saying so in the
trigger's own words" (line 22). But every board-dispatched prompt ends in `COMMIT_RULE`:

```
'When the job is done, commit the work: stage only the files this session changed, never `git add -A` or `git add .` — the tree may hold unrelated
uncommitted work of the user's. Do not push.'
```

(`shared/agent.ts:827-830`, appended unconditionally by `composePrompt` at `server/src/agents/prompt.util.ts:29`). So in a `pr` project a board-dispatched
session receives a trigger whose own words forbid step 6's `git add -A` and step 8's push, and by line 22's rule those words ARE an in-place override.
Either outcome is wrong: the session obeys the prompt (no PR, scoped commit in the worktree — and line 45 is false) or it obeys the config (and ignores the
most specific instruction it was given, which `shared/agent.ts:819-825` explicitly names as the seam to reconcile). The spec's "Why" (lines 7-8) is also
incomplete on this point: a board-dispatched execute already commits today (scoped), it does not "stop".

Fix: decide and state it. Either (a) the server reads `backlog/config.json` when composing the prompt and drops/rewrites `COMMIT_RULE` for a `pr` project
— then line 27's "no board change" must admit a server read and `test/agents-prompt.test.ts` gains a case; or (b) SKILL.md states that a `pr` config outranks
the dispatch prompt's commit rule, and line 22 names the exact override phrase (e.g. `in place`) so `COMMIT_RULE`'s wording never counts as one. Either way,
list `shared/agent.ts:819-825` among the sites the change touches.

## Important

### I1. The invariant headline is misquoted; its push clause, and three further sites, are not addressed

Spec lines 97-101. Code: `CLAUDE.md:175`, `.claude/rules/orchestrator.md:33-40`, `docs/subsystems/invariants.md:434-454`,
`skills/backlog-orchestrate/SKILL.md:9`, `docs/subsystems/skills.md:34`.

The headline is not "`backlog-orchestrate` is the only skill that commits or merges"; it is "`backlog-orchestrate` is the only skill that commits or merges
— and, for a TRACKER project only, the only one that pushes." (`CLAUDE.md:175`, byte-equal at `.claude/rules/orchestrator.md:33`). The spec rewrites the
commit half and leaves the push half standing, but `pr` mode pushes in files projects too, so the push clause is false after the change. The mechanism
text at `orchestrator.md:35-37` ("No other skill touches git history at all", "exactly three commands, none of them ever run for a files project") and the
reasoning at `invariants.md:451-454` ("For a files project nothing changed and publishing remains the user's call") go false with it. Two more sites carry
the old contract and are not in the spec's "all three move together": the orchestrate skill description `skills/backlog-orchestrate/SKILL.md:9` ("It is the
only skill that commits or merges — execute ...") and `docs/subsystems/skills.md:34` ("`backlog-execute` never commits and never pushes").

Fix: quote the headline in full, rewrite both clauses (merge stays exclusive; commit and push become "outside `pr` mode"), and list every site:
`CLAUDE.md:175`, `.claude/rules/orchestrator.md:33-40`, `invariants.md:434-454`, `skills/backlog-orchestrate/SKILL.md:9`, `docs/subsystems/skills.md:34`,
`shared/agent.ts:819-825`.

### I2. The reviewer dispatch omits `base`, which the reviewer's contract requires

Spec line 87, 115-118. Code: `agents/backlog-reviewer.md:62-63, 72-73, 81-88`; `skills/backlog-orchestrate/SKILL.md:787-795`.

The spec hands the reviewer "the worktree, branch, item, and a report path". The reviewer's input contract has a fifth field, `base`, and every diff it
takes is `<base>...<branch>` (`backlog-reviewer.md:62-63, 81-88`); the orchestrator passes it and pins the pair by test (`SKILL.md:791-793`). Without it the
reviewer substitutes `main`, which on a non-`main` base reviews the whole divergence. The reviewer also states its report path "is inside the run's state
directory under `~/.backlog-manager/orchestrator/`" (`backlog-reviewer.md:72-73`); the spec's `$TMPDIR` path contradicts that sentence, and line 116 widens
only the description.

Fix: add `base` (the effective config base) to the dispatch list at line 87, and name `backlog-reviewer.md:72-73` as text to widen beside the description.

### I3. A clean linked worktree checked out on `<base>` itself, or detached, passes the reuse test

Spec lines 49-50, 74. Code: `skills/backlog-orchestrate/SKILL.md:1005, 1121` (the orchestrator's `.worktrees/_base-<base>` tree).

"A clean linked worktree whose `HEAD` has no commits not in `<base>` → use it, on its existing branch" is satisfied by a worktree that has `<base>` checked
out (the orchestrator leaves exactly such a tree at `.worktrees/_base-<sanitised base>`, `SKILL.md:1005`, and says it may be left behind, `:1121-1127`) and by
a detached-HEAD worktree. In the first case the session commits on `main`, pushes `main` and runs `gh pr create --base main` from `main`, which fails; in the
second there is no "existing branch" to push.

Fix: require the reused worktree's HEAD to be a named branch other than `<base>`; everything else gets a new worktree.

### I4. Every pre-work refusal leaves a worktree and branch that line 77 then refuses to reuse

Spec lines 73-80, 77. Code: `skills/backlog-execute/SKILL.md:63-75, 140-143, 162-171` (the refusals that happen after `show`).

Step 2 cuts `.worktrees/execute-<id>` on `execute/<id>` before `show`. The item-absent refusal (line 79-80), the wrong-section and already-done refusals
(`SKILL.md:74-75`), the refusal gate (`:140-143`) and a lost claim race (`:168-171`) all happen after that, with nothing committed. Line 77 then says: "If
the branch or path already exists, stop and say so — do not reuse or delete it." So one refused run blocks every later attempt on that id until a person
removes the tree and branch by hand, and the spec gives no message naming the cleanup.

Fix: state what happens to a worktree this session created and never committed in — remove it (and its branch) on any refusal before step 3's `start`, or
extend decision 5's clean-reuse test to a worktree on `execute/<id>` at `<base>` — and have the refusal's final message name the path and branch.

### I5. `Closes #<n>` closes the issue only when the PR's base is the repository's default branch

Spec lines 58, 91, 122-125. Source: GitHub docs, "Linking a pull request to an issue" — keyword auto-close applies only to a PR merged into the default
branch.

`base` is configurable (line 58) and decision 8 removes `move <id> done` for a tracker project, so with any non-default base the issue is never closed by
anything: the PR merges, the issue stays open and unclaimed, and the next drain works it again (see I6).

Fix: state that the `Closes` line is the closer only when `base` is the default branch, and say what closes the issue otherwise (the final message tells
the user to close it, or the PR body says so) — or restrict `pr` mode's tracker variant to a default-branch base.

### I6. Nothing stops a second run working the item while its PR is in review

Spec lines 82-84, 122-125; Non-goals lines 24-32. Code: `skills/backlog-orchestrate/tools/orchestrate.mjs:4195-4209` (the probe checks `backlog/<id>`
and `.worktrees/<id>` only); `skills/backlog/tools/backlog.mjs:2855-2875` (`stop` releases the claim).

After step 8 a tracker issue is open and unclaimed (the spec says so, line 124), and in a files project the item is still in `<section>/open/` on `<base>`
(line 83). An orchestrator run on the project, or an execute on another machine, sees a groomed open item with no claim and works it a second time; the
orchestrator's leftover probe cannot see `execute/<id>` (`orchestrate.mjs:4195-4209`). Only a second hand execute on this machine is blocked, by line 77's
branch check. The checklist's "concurrent use" case is not named anywhere.

Fix: name this in Non-goals as accepted, or add a guard the gates can read (for a tracker project, a comment the claim lookup treats as "PR open"; for a files
project, a frontmatter key the refusal gate refuses on) — and say which.

### I7. The new config subcommands must bypass tracker-mode API routing, and the spec does not say so

Spec lines 63-64. Code: `.claude/rules/skills.md:19-22`; `skills/backlog/tools/backlog.mjs:849-860` (`requireStore`).

The rule scoped to `skills/**` says a `{"kind":"github"}` marker "routes every command through `http://127.0.0.1:${BM_API_PORT || 4322}`" and that
`backlog.mjs` in a tracker project "needs the stack up, and says so with exit `5`". `requireStore` (`backlog.mjs:849-860`) is "every command that acts on an
item". The config reader is run at step 1 of every execute, before anything else; if it goes through `requireStore` it needs the stack up in a tracker
project, and if it does not, the rules bullet's "every command" is false. Either way the builder has to guess.

Fix: state that the config reader and setter are local-file commands in both modes (the way `jira.mjs worktree` is git-only, `rules/skills.md:23-27`), and
list the rules bullet among the texts to amend.

### I8. The fresh worktree's dependencies and the main tree's `info/exclude` are not mentioned

Spec lines 75-78. Code: `skills/backlog-orchestrate/SKILL.md:541-544`; `skills/backlog-orchestrate/tools/orchestrate.mjs:4255-4273`.

"Every later command (`backlog.mjs`, tests, git) runs against that tree" — but a worktree cut by `git worktree add` has no `node_modules`, and the
orchestrator has a whole paragraph on this (`SKILL.md:541-544`: `.worktrees/` and `node_modules` into the common `info/exclude`, `node_modules` bare because a
worktree gets a symlink). The spec's `.worktrees/execute-<id>` also shows up as untracked in the main tree's `git status` unless excluded. An implementer
has to invent both steps.

Fix: say how dependencies reach the worktree (symlink or install) and that `.worktrees/` is added to the common `info/exclude` the way `orchestrate.mjs:4255-4273`
does — or that execute reuses that helper.

### I9. A fix round changes the diff after verification; the spec does not re-verify

Spec lines 38, 87-89. Code: `skills/backlog-orchestrate/SKILL.md:829-835` (the fix-loop prompt re-runs the Outcome's verification commands and appends a
`### Fix loop <n>` record).

Step 7 says "Fix those, commit the fixes, re-review". The Outcome's pasted verification output (step 5) predates those commits, and the anti-goal at line 38
is "a PR opened for work that failed verification". The orchestrator's fix prompt re-runs "the verification commands to re-run, copied from the item's
`## Outcome`" and records the result (`SKILL.md:833-835`); the spec does not.

Fix: state that each fix round re-runs the Outcome's verification commands and appends a `### Fix loop <n>` record before the re-review, and that a red
re-run takes the failure path.

## Minor

- Line 63-64: "the file keeps one writer, like the registry does" sits beside "Hand-editing the committed file is also fine". The registry invariant means
  exactly one writer (`CLAUDE.md:92`); say "one tool-side writer" or drop the comparison.
- Line 86: the PR-title regex is not in this repo — `ci.yml:21` delegates to `futin/release-kit/.github/workflows/ci-node.yml@v1`; `CLAUDE.md` states the
  rule. "this repo's `ci / pr-title`" is accurate as a check name, misleading as a source.
- Line 116: the reviewer description is paraphrased, not quoted — actual text at `agents/backlog-reviewer.md:4-7` says "before the orchestrator merges it
  into the run's base branch" and "committed an item's work on backlog/<id>".
- Line 117: `$TMPDIR` is frequently unset outside macOS; say "the system temp dir (`os.tmpdir()`)" with `$TMPDIR` as the example.
- Line 123: `stop --keep-started` is correct for the release, and the flag is inert in tracker mode (`backlog.mjs:2858`) — fine, worth a parenthesis so the
  builder does not look for an effect.
- Line 102: beside the description and the first Hard-limits bullet (`SKILL.md:343-345`), the marker section's "Unchanged: never commits, never pushes"
  (`SKILL.md:32`) stays true and should be left, and `SKILL.md:257` ("In a hand session that same tree may hold unrelated in-flight changes") gains a `pr`
  clause — the tree is clean by construction. Contract-sweep material; listing it saves a fix loop.
- Line 40: verified — `probeLeftover` checks branch `backlog/<id>`, a registered worktree at `.worktrees/<id>` and the directory (`orchestrate.mjs:4195-4209`);
  `execute/<id>` and `.worktrees/execute-<id>` do not collide.
- Line 88: "at most two fix rounds, mirroring the orchestrator's loop" — verified, `skills/backlog-orchestrate/SKILL.md:873`.
- Lines 9-11: the Jira "Open MR when done" claim is verified — `server/src/jira/prompt.util.ts:76-87`, `client/src/components/jira/JiraBranchSection.tsx:225`.
- Line 130: the 15-minute stale window is verified — `shared/types.ts:1566`, `server/src/tracker/claim.ts:202`.
- Line 32 (no GitLab): consistent with the Jira prompt supporting `glab` for a mapped repo; worth one clause saying why execute does not borrow that branch
  of `prompt.util.ts:86-87`, since the spec cites the Jira Run as precedent.
