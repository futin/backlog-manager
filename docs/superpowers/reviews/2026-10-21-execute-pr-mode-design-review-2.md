# Review 2 — `docs/superpowers/specs/2026-10-21-execute-pr-mode-design.md`

Reviewer: Fable 5.1, fresh subagent, checklist review. Date: 2026-10-21.
Every claim below was checked against the code at the worktree's HEAD (`82937fb`); `file:line` references are to that tree. Review 1's findings
(C1, I1–I9) were re-checked against the revised text: all nine are addressed in the document, and none is re-reported here.

## Verdict: REVISE

One Critical: the tracker-project ordering the revision introduced (decision 8) releases the claim at step 5 and adds the `in-review` guard only at step 8,
so the whole review loop runs with the item open, unclaimed and unguarded — the exact window decision 9 says it closes — and that order contradicts the
"heartbeat across the review loop" note at the end of the document. Six Important findings: the reviewer's item-file input in a tracker project, a reused
worktree that is behind `<base>`, an incomplete list of the sites that state the old invariant, the server's behaviour on a malformed config, the label when
the push succeeds but the PR does not open, and the per-item dispatch gate named at the wrong function.

What checked out (not findings, recorded so the author need not re-verify): `shared/agent.ts:819-830` (seam comment and `COMMIT_RULE`),
`server/src/agents/prompt.util.ts:29` (unconditional append), `skills/backlog/tools/backlog.mjs:851-860` (`requireStore`), `.claude/rules/skills.md:19-28`
(the `jira.mjs worktree` exception), `orchestrate.mjs:4260` (`ensureExcludeLines`) and `:4297` (the worktree is cut from local `<base>`),
`orchestrate.mjs:4194-4235` (`probeLeftover` checks `.worktrees/<id>` and `backlog/<id>` and parks on an unexpected state), orchestrate SKILL.md `:9`,
`:541-544`, `:830-835`, `agents/backlog-reviewer.md:58-75` (five inputs, `:62` branch, `:72-73` report path), execute SKILL.md `:32`, `:90-96`
(item-absent rule), `:110-111` (archive order), `:119` (15-minute stale window), `:257`, `:341`, `:352`, `CLAUDE.md:175`, `.claude/rules/orchestrator.md:33-37`,
`invariants.md:434-454`, `docs/subsystems/skills.md:34`, `server/src/tracker/labels.ts:61-74` (`QUEUED_LABEL`, nine labels), `map-issue.ts:148` and `:249`
(`queued`), `backlog.mjs comment --body` (`:2310`, `:2339`), `stop` releasing the claim in a tracker project (`:2875`), the `Open MR when done` switch
(`client/src/components/jira/JiraBranchSection.tsx:225`), and that `backlog/config.json` is invisible to both scanners (`server/src/items/scan.util.ts:50-53`
reads `.md` under the leaf directories only; `backlog.mjs:520` the same).

## Critical

### C1. In a tracker project the claim is released at step 5, the guard is added at step 8, and the review loop runs in between

Spec lines 101-103 (step 5), 106-110 (step 7), 111-113 (step 8), 150-153 (decision 8), 154-156 (decision 9), 165, 182.
Code: `skills/backlog/tools/backlog.mjs:2875` (`stop` → `POST /api/items/release`), `skills/backlog-execute/SKILL.md:110-111`, `:119`.

Decision 8 moves the tracker archive to "comment + `stop <id> --keep-started` to release the claim" at step 5, i.e. before the commit (6), the bounded
review loop (7, up to two fix rounds, each re-running the item's verification commands) and the push/PR/label (8). Decision 9 then says the `in-review`
label exists because "without it, an open, unclaimed issue looks ready to every gate, and an orchestrator run on any machine would execute it again" — but
line 165 adds the label only "right after the PR is opened". So for the whole of steps 6-7 the issue is open, unclaimed and unlabelled: exactly the state
decision 9 was written to prevent, for as long as a review and two fix rounds take. A run's `stage <n> preflight` claim, or another person's `start`, succeeds
in that window and the item is worked twice.

The same ordering contradicts two other places in the document:

- Line 182 ("How a tracker-project heartbeat interleaves with the review loop — a long review can cross the 15-minute stale window") presupposes the claim
  is still HELD during the review loop. Under step 5 as written there is no claim to heartbeat.
- Line 108 ("append a `### Fix loop <n>` record" to the Outcome) has no home in a tracker project: the Outcome was already posted as the closing comment at
  step 5, before any fix round ran, so the record either goes to a second comment or nowhere — the spec does not say.

Suggested fix: in a tracker project, hold the claim through step 8. Order the tracker finish as: verification passes → commit → review loop (fix-loop records
appended to the temp Outcome file) → push → `gh pr create` → `review <id> on` → `comment <id> --body <outcome>` → `stop <id> --keep-started`. The claim
then covers the window, line 182's heartbeat concern becomes real, and the Outcome comment carries the fix-loop records. A files project keeps step 5 where it
is (its archive is in the diff under review, which the reviewer expects — `agents/backlog-reviewer.md:65-66`).

## Important

### I1. The reviewer's `item file path` input has no source in a tracker project outside a run

Spec lines 106-107, 143-146. Code: `agents/backlog-reviewer.md:65-70`, `:74-75`.

The reviewer contract requires an **item file path** and says that in a tracker project it is "a SNAPSHOT under the run-state directory … written by
`orchestrate.mjs snapshot`" (`:67-70`); a missing input makes it stop (`:74-75`). The spec says the reviewer is "used as-is with this session's worktree, branch
and item" (line 143), and only widens the `branch` and `report path` lines (line 126-127). In a tracker project in `pr` mode nothing writes a snapshot —
`orchestrate.mjs` refuses every command but `init` outside a run (`skills/backlog-execute/SKILL.md:30`) — so execute has no file to hand over and the reviewer
stops. Suggested fix: say that execute writes the issue body plus the `## Outcome` to a file beside the report (e.g. `os.tmpdir()/backlog-execute/<id>-item.md`)
and widens the reviewer's item-file line (`:67-70`) to accept it beside the run-state snapshot.

### I2. A clean, reused worktree that is BEHIND `<base>` passes the reuse test and works on a stale base

Spec lines 57-58 (decision 5), 85-86 (step 2 reuse), 98-99 (step 3).

The reuse test is "clean, named branch other than `<base>`, no commits not in `<base>`". A linked worktree cut a week ago satisfies all three while `<base>`
has moved on. Two consequences the spec does not address: the work and its verification run against an old base, and a groom committed to `<base>` after the
worktree was cut is absent from that tree, so step 3's item-absent rule refuses it with "commit the groom first" although it IS committed. Suggested fix: add
to the reuse rule either "and `HEAD` is at `<base>` (fast-forward the tree to `<base>` first — it is clean, so `git merge --ff-only <base>` cannot lose
anything)" or "a tree behind `<base>` is not reused". Say which.

### I3. The list of sites that state the old invariant is incomplete

Spec lines 118-123 ("Every site that states the old rule moves together: …").
Code: `skills/backlog-groom/SKILL.md:18` ("no skill but `backlog-orchestrate` touches git history at all"), `skills/backlog/SKILL.md:138` ("never commits and
never pushes"), `skills/backlog-orchestrate/SKILL.md:26` ("No other backlog skill touches git at all; execute's 'never commits, never pushes' …"),
`skills/backlog-orchestrate/references/recovery.md:253` ("because `backlog-execute` never commits"), `skills/backlog-orchestrate/tools/orchestrate.mjs:6127`
(a comment: "never commits; the orchestrator does").

The spec presents its list as exhaustive ("every site … moves together") and names six; the five above also state the rule and would be left saying the
opposite of the new skill. `orchestrate SKILL.md:763` ("unchanged and still true inside the session") stays true under the marker and need not move. Suggested
fix: add the five sites, or replace the list with "every site `grep -rn 'never commits\|touches git' skills docs CLAUDE.md .claude/rules shared` finds".

### I4. The server's behaviour on a malformed or unreadable config is unspecified

Spec lines 32-35 (prompt change), 66-69 (malformed config is an error execute stops on). Code: `server/src/agents/agents.service.ts:389` (`composePrompt`
feeds the launch sheet's `plan()`), `test/agents-prompt.test.ts`.

The spec defines the malformed case for the skill (report and stop) and the two valid cases for `composePrompt` (`pr` → pr-mode sentence, otherwise
`COMMIT_RULE`). It does not say what `composePrompt` appends when the file is unparseable, carries an unknown `finish`, or cannot be read — and that is a
test value the builder must choose (`agents-prompt.test.ts` asserts the tail of every prompt). Suggested fix: one sentence — e.g. "any config the reader would
reject reads as `in-place` to the server: `COMMIT_RULE` is appended, and the skill's own refusal is what the session reports" — and name it as a test case.

### I5. Push succeeded, PR not opened: whether the label is added is stated both ways

Spec lines 111-113 (step 8: "No `gh`, not authenticated, or not a GitHub remote → the branch is still pushed and the final message says the PR was not
opened"), 165 ("adds it right after the PR is opened (after the push, so a failed push never leaves an item guarded with no PR behind it)").

Line 165 gives two different triggers in one sentence — "after the PR is opened" and "after the push" — and they diverge exactly in the case line 112
describes: the push landed, `gh` did not. Under "after the PR is opened" the pushed branch's work is unguarded and a run re-executes the item; under
"after the push" the item is guarded with no PR behind it, which line 165 says must never happen. Suggested fix: pick one and say it. The purpose stated at
lines 154-155 (the guard protects work that is waiting to merge) argues for "after a successful push, PR or not", with the final message giving the `gh pr
create` command to run by hand.

### I6. The per-item dispatch gate is not `dispatchGate`

Spec line 169 ("the board's per-item dispatch gate (`shared/agent.ts` `dispatchGate`) disables Run on it with that reason").
Code: `shared/agent.ts:426-428` (`dispatchGate(item, status)` returns `projectDispatchGate(status, item.projectPath)` — environment and project visibility
only; its own comment, `:423-425`, promises every caller the same answer for the same inputs), `client/src/components/board/DispatchButton.tsx:145-160`
(the ladder: environment → project visibility → in progress → run claim; the last two are rungs outside `dispatchGate`), `server/src/agents/agents.service.ts:414`
and `:451-493` (the server's twin: `dispatchBlock(...) ?? runClaimBlock(...) ?? syncOffBlock(...) ?? the item-claim re-check`).

The per-item reasons (in progress, run claim, sync off, item claim) are rungs in `DispatchButton.tsx` and `agents.service.ts`, not in `dispatchGate`. A
builder who follows the spec adds an item rung to a project-level function whose contract says it has none. Suggested fix: name the two ladders and where the
rung goes in each (beside the in-progress rung in `DispatchButton.tsx:145-160`, and beside the item-claim re-check in `agents.service.ts:493`), so the sheet,
the card and the API refuse with one wording.

## Minor

- Lines 112 and 152 say the PR body carries `Closes #<n>` unconditionally; line 175-177 makes it `Refs #<n>` on a non-default base. Make 112 and 152 say
  "`Closes #<n>` or `Refs #<n>`, per decision 9".
- Line 164 says "the rules file" (singular) states the nine-route count. Two do: `.claude/rules/items.md:7` and `.claude/rules/skills.md:29`. The count also
  lives in `CLAUDE.md:30` ("the eight guarded write routes in `items-write.controller.ts`, which with the ninth, `abort`"), `server/src/items/items.service.ts:305`,
  `:366`, `shared/types.ts:2163`, `:2661` ("the eighth write route"), `test/tracker-cold-cache.test.ts:317`, `test/tracker-client-write.test.ts:4`. Renaming
  the `invariants.md:3404` heading ("The nine item-write routes …") changes its anchor, which `CLAUDE.md:121` and `items.md:7` link and
  `test/claude-rules.test.ts` guards — say the anchor moves with it.
- Line 160 adds a tenth label; `server/src/tracker/labels.ts:63`, `:95`, `:99` and `poller.service.ts:990` say "the nine". Same "every site moves" note.
- Line 66 calls the config "a committed file" and line 32 "a read of the committed config"; lines 135-136 say an uncommitted one still works. Say "a file
  under `backlog/`, meant to be committed" once, in the config section.
- Line 87-88 cuts from local `<base>`, which may be behind `origin/<base>`; the orchestrator's tracker push half pulls `--ff-only` first
  (`.claude/rules/orchestrator.md:35-36`). Not wrong — GitHub reports the conflict on the PR — but worth one sentence saying execute does not pull, and why.
- Line 89: "If the branch or path already exists, stop and say so" and line 100 (a failed verification leaves `.worktrees/execute-<id>` in place) together mean
  a second attempt at the same item from the main tree is always refused by its own leftovers. The exit is the override ("in place this time" inside that
  worktree) or removing the tree by hand; the final message at line 100 should name one.
- Line 89 does not say what happens when local `<base>` does not exist as a branch (`git worktree add … <base>` fails). Likely "stop and say so", but say it.
- Line 166: "A failed label write does not undo the PR; the final message says the guard is missing." Fine — but then line 173's "execute's final message says
  so whenever it adds the label" should also cover the case where it tried and failed (the removal instruction does not apply, the add-by-hand command does).
- Line 180 leaves the config subcommand names to the builder while lines 71-72 and 163 already fix `review <id> on|off`; name the config verb too, or move
  `review` to "left to the builder" as well, so the two are decided at the same level.
