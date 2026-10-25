# Review 1 — `2026-10-24-groom-pr-and-auto-merge-design.md`

Reviewer: Fable 5.1, fresh session, checklist review. Document: `docs/superpowers/specs/2026-10-24-groom-pr-and-auto-merge-design.md` (273 lines).
Code read: `shared/agent.ts`, `server/src/agents/agents.service.ts`, `server/src/agents/prompt.util.ts`, `shared/types.ts`, `client/src/components/board/LaunchSheet.tsx`,
`client/src/lib/settings.ts`, `client/src/components/settings/SettingsView.tsx`, `skills/backlog-execute/references/pr-mode.md`, `skills/backlog-execute/SKILL.md`,
`skills/backlog-groom/SKILL.md`, `skills/backlog-tick/tools/tick.mjs`, `skills/backlog/tools/backlog.mjs`, `.claude/rules/{orchestrator,board,skills,dispatch-watchdog,items}.md`,
`test/agents-shared.test.ts`, `docs/subsystems/invariants.md`, the sibling repo's `server/lib/pending.ts` and `server/lib/spawn.ts`, superpowers 7.0.0 brainstorming, and
`gh` 2.102.0's own `--json` field lists. The code under `server/`, `client/`, `shared/`, `skills/` is identical to `main` on this branch (the diff is docs and `scripts/ci-scope*`).

## Verdict: REVISE

Two Criticals: the document contradicts itself on whether `--auto-merge` alone keeps the session waiting, and the one command the whole Arm step hangs on names a
`gh` field that does not exist, so every launch would take the "refusal" branch and never arm. The rest is Important gaps an implementer would have to guess at.

## Critical

### C1. Spec:49, 167 vs 137–138 — does `--auto-merge` without `--fix` wait for the merge?

- Goal 5 (line 49): "Fix if it fails: the same session **stays alive after arming**, watches the PR …" — i.e. staying alive is what `--fix` adds.
- Line 167: the Watch / Merged / Closed steps sit under "### Fix (**only with `--fix`**)", and the bounds (line 180) are "stated in the file" under that heading.
- Line 137–138: "with `--auto-merge`, the session **always waits for the merge** inside the bounds below (with or without `--fix`; `--fix` only adds the fix rounds)
  and on `MERGED` runs `backlog.mjs plan-review <id> off`."

Three readings are possible: auto-merge alone returns after arming (Goals), auto-merge alone waits for every PR finish (guard section), or only a tracker groom waits.
Each gives a different session length and a different final message, and for the tracker groom the `plan-review` mark comes off in different hands.
→ Pick one and say it in Goal 4, in "### Arm", and in the guard section with the same words. If auto-merge alone waits: move Watch / Merged / Closed / the wall-clock
bound out from under "only with `--fix`" into a "### Wait" section both flags share, and say what happens to `plan-review` when the bound is hit without a merge
(stays on; the person approves on the board). If it does not wait: the tracker groom's mark then only ever comes off by hand, and line 137's first bullet goes.

### C2. Spec:158 — `gh repo view --json autoMergeAllowed,…` names a field `gh` does not have

`gh repo view --json` (gh 2.102.0, 2026-09-30, the version on this machine) lists `mergeCommitAllowed`, `rebaseMergeAllowed`, `squashMergeAllowed`,
`deleteBranchOnMerge`, `viewerDefaultMergeMethod` — and no `autoMergeAllowed` (nor any `auto*` field). The call exits non-zero with "Unknown JSON field", and
line 163 says any `gh` error → "report it, leave the PR open, skip fix": every launch with the box ticked would silently never arm.
→ Read the setting through the REST field: `gh api repos/{owner}/{repo} --jq .allow_auto_merge` (or GraphQL `repository.autoMergeAllowed` via `gh api graphql`),
and keep `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed` for the method pick, which those fields do carry.

## Important

### I1. Spec:112–119 — on a tracker **promote**, step 4 runs after step 6, so `Refs #<n>` cannot name the task, and "the issue … stays open" is false

Step 4 says the issue body is written after commit (5) and push (6) so it can carry the pushed sha. For a promote, "write the item" IS `backlog.mjs new … --plan-review`
(`skills/backlog-groom/SKILL.md:286–295`, the body with the permalink), which creates the task issue — so at step 6 (`gh pr create` … "`Refs #<n>`") the task's
number does not exist yet. And a promote then moves the idea to done (`SKILL.md:318–324`), so the issue that "stays open to be executed" is the new task, not the
groomed item. Only plan-the-fix (bug stays a bug, `body` on the same issue) matches the sentence as written.
→ Say which issue `Refs` cites — the groomed item's (`idea-N`/`ref-N`/`bug-N`, the one the claim is on) — and that for a promote the task's number reaches the PR
only via `gh pr edit --body` after step 4, or in the final message. Alternatively order it `new --plan-review` → commit → push → `body --if-updated-at` with the
permalink, noting the rule that the mark is written "in the SAME write as the plan" (`.claude/rules/skills.md:34–35`) is then satisfied by `new`, not `body`.

### I2. Spec:133–134 — a pr-mode groom killed mid-item blocks every tick of that files project for good

`tick.mjs`'s `startedMarker` (`skills/backlog-tick/tools/tick.mjs:502–528`) scans the main checkout AND every linked worktree for an open item carrying `started:`,
skipping only `.worktrees/<id>` and `.worktrees/execute-<id>` (`isSkippedTree`, `tick.mjs:531–536` — the name is tested against `FILE_ITEM_ID` after an optional
`execute-` prefix, so `groom-task-3` is not skipped). A pr-mode groom writes `started:` into `.worktrees/groom-<id>`'s item (step 2, `start --as groom` in the tree).
A groom that dies there leaves the marker, and every later tick on that project answers `started marker on <id> in <tree>` until a person removes the tree — the
exact failure the comment at `tick.mjs:503–504` says the execute exclusion exists to prevent ("a killed execute there would otherwise block the project for good").
The spec's "the final message says so" (line 134) never fires for a killed session.
→ Either extend `isSkippedTree`'s prefix to `groom-` (which means dropping "ticks stay byte-identical" from the non-goals, honestly), or name this as a known
limitation with the remedy (`git worktree remove .worktrees/groom-<id>`) in the "Guard" section — not in a final message that may never print.

### I3. Spec:120–122 — "A files project always has the item file to commit, so it always gets a PR" is false

A files groom can end after §2 cut the tree with nothing changed: a refusal at the gate (`skills/backlog-groom/SKILL.md:125`), a session that "ends without a
verdict" (`SKILL.md:438`), or an "Already in progress" stand-down (`SKILL.md:180`). Step 7 covers only "a tracker project groom that wrote no spec".
→ Make step 7 source-independent: "nothing staged after step 5 → say so, remove the worktree and branch this groom made, end as today", and keep the tracker
`the groom lives on #<n>` wording as one case of it. Execute's pr-mode §2 "A refusal before any work leaves nothing behind" (`pr-mode.md:113`) is the model to cite.

### I4. Spec:174, 187–191 — what the waiting **execute** does on `MERGED` for a tracker item is unstated

The groom path says exactly what happens on `MERGED` (`plan-review <id> off`). The execute path says only "Merged → done; the final message says so". But a tracker
execute whose PR went into a non-default base carries `Refs #<n>` (`pr-mode.md:239–240`), so the issue stays open with `in-review` on, and pr-mode §9
(`pr-mode.md:277–278`) hands the close and the label removal to a person. With the session now watching the merge land, an implementer must guess whether it runs
`review <id> off` / closes the issue, or leaves §9's hand steps in place.
→ One sentence under "Merged": either "the session changes nothing on the issue; §9's hand steps are listed in the final message as today", or the exact commands
it runs. (Recommended: the former — the base may not be the default branch, and "closed when the work reaches the default branch" is §9's rule.)

## Minor

- **Spec:28** — `pending.ts` holds the hook's response for a clamped window, not "until" an answer: default 10 min, 5 s–30 min
  (`claude-agents-dashboard/server/lib/pending.ts:45–48, 69–73`), after which "the hooks fall back to the terminal dialog" (`pending.ts:11`). Context only, but the
  sentence overstates it.
- **Spec:209** — two pins, not one: `test/agents-shared.test.ts:1016–1029` pins the literal sentence, and `:844–848` pins that `pr-mode.md` §1 quotes
  `finishClause('pr', '<base>')`. Both call the two-argument form, so "takes the action" touches both call sites; the strings themselves keep passing as the spec says.
- **Spec:240–241** — the rule's home is `.claude/rules/orchestrator.md:45–50`, whose mechanism body also says "Execute is the one other skill that writes git" and
  "it never merges"; the body needs the groom and the auto-merge wording, not only the byte-equal headline.
- **Spec:224** — `clampSettings` (`client/src/lib/settings.ts:333–349`) has `pickOne`, `clampInt`, `clampOrigin`, `clampDays`, `clampBoundedString` and no boolean
  clamp; "like the other keys" means a new `clampBool`. Worth naming so the two booleans get one helper, not two inline ternaries.
- **Spec:56, 133** — tick code stays byte-identical, but a board pr-groom on a tracker project adds a `plan-review` label, and the tick's groom room is counted off
  those labels (`tick.mjs:425–448`, cap `--max-plans`). The observed tick behaviour on that project does change; one sentence would stop a later reader filing it
  as a bug.
- **Spec:110** — "run with the tree as the cwd": in a `-p` session the Bash tool's cwd persists per call, which is why execute's pr-mode runs every command as
  `cd <tree> && …` (`pr-mode.md:128–143`; `tick.mjs:114–116` records what went wrong when it did not). Say the groom does the same rather than "as the cwd".
- **Spec:205** — `composePrompt` joins with one space (`server/src/agents/prompt.util.ts:35`), so an untouched old-tab body ends in `COMMIT_RULE` exactly; an edited
  one may end in a newline. Say "after trimming trailing whitespace" so the strip is deterministic.
- **Spec:117** — `docs(groom): <item title>` as the PR title: a title longer than GitHub's 256-char limit or one containing a newline is `oneLine`d by the prompt but
  not by `git log -1 --format=%s`; harmless, but the builder may want `--title` from the one-line form.
- **Spec:8** — the quoted brainstorming wording is `skills/backlog-groom/SKILL.md:258`'s paraphrase; superpowers 7.0.0's own line is "in a software repo,
  `docs/superpowers/specs/…`, committed." (`brainstorming/SKILL.md:156–157`). Same meaning; fine as is.

## Checklist notes (verified true, no finding)

- Rule 2 "finish applies only to execute" (`agents.service.ts:433–435`), rule 5's `FINISH_FLAG` scope execute-only (`:453–455`, `shared/agent.ts:878`), remote
  execute forced to `pr` (`:419–420`), `finishClause` literal (`shared/agent.ts:936–939`), `composePrompt` keeping `COMMIT_RULE` for groom/capture
  (`prompt.util.ts:34–35`), `AgentDispatchRequest.finish/base` optional (`shared/types.ts:933–938`).
- LaunchSheet: `isExecute` gates Finish/Base and the branch fetch (`LaunchSheet.tsx:86, 97, 206–216`); `Switch` is the sheet's control (`:21, 265`); Jira's "Open MR
  when done" is a `Switch` (`JiraBranchSection.tsx:225`); finish seeds from `settings.executeDefaultFinish` (`:69`); remote lock derives `pr` (`:72`).
- Settings: `executeDefaultFinish` clamped by `pickOne` (`settings.ts:345`), drawn in the Dispatch group of the Local page (`SettingsView.tsx:416–450`).
- `backlog.mjs plan-review <id> on|off` is tracker-only, needs no claim (`backlog.mjs:3718–3745`); `--plan-review` on `new` and `body` (`:2194, 2244`).
- Execute releases its claim after the push with `stop --keep-started` and `in-review` guards (`pr-mode.md:248–256`); refusal rules (`:259–270`); §9 known
  limitation wording (`:271–282`).
- Orchestrate SKILL.md description's "only skill that merges" is on line 9; CLAUDE.md:195 and `.claude/rules/orchestrator.md:45` headlines are byte-equal today.
- `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup`, `gh pr checks --watch`, `gh pr merge --auto`, `gh run view --log-failed` all exist on gh 2.102.0.
- `spawn.ts` times out only its `--version` probe (`spawn.ts:240–254`); the other timers are stop escalation.
- Tick's groom never passes `--finish` (`tick.mjs:454`); its execute does (`:441`).
