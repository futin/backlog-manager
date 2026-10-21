# Review 1 — `docs/superpowers/specs/2026-10-21-execute-finish-picker-design.md`

Reviewer: fresh subagent (Fable), 2026-10-21. Checklist: facts vs code, internal consistency, edge cases, copy, scope, CLAUDE.md / `.claude/rules/` hard rules.
Every code claim below was read in this worktree (`feat/execute-finish-picker` at `54f645a`), not taken from the document.

## Verdict

**REVISE** — one Critical: the design's own first anti-goal (line 35) is reachable through the mechanism the design chooses (line 82), because the `in-place`
closing clause carries no `--finish` token and the body is still sent as typed. Seven Important findings, most of them under-specified removals that
`test/claude-rules.test.ts` or the doc sweep would otherwise catch late.

## Facts checked and found true

- Line 3: PR #326 is `959e1c1 feat(skills): backlog-execute pr finish mode (#326)` (`git log`).
- Line 9–10, 31: nine registered projects in `~/.backlog-manager/registry.json`; none has `backlog/config.json` (checked by script, 2026-10-21).
- Line 13–14: `--merge-mode` is appended from a guarded literal at `server/src/agents/agents.service.ts:793-794`; `orchestrateDefaultMergeMode` is a `pickOne`
  clamp at `client/src/lib/settings.ts:328`; the Orchestrate sheet seeds from it and always sends `mergeMode` (`OrchestrateSheet.tsx:604-613`).
- Line 36–37: the base picker is seeded to the literal `'main'` with the "stored one would outlive that experiment" comment at `OrchestrateSheet.tsx:222-232`.
- Line 61: today's `dispatch` takes `req.prompt` as typed (`agents.service.ts:430`, `:514-515`), and `composePrompt` puts the closing rule inside that text
  (`server/src/agents/prompt.util.ts:31-33`).
- Line 77–79: orchestrate appends nothing for `main` (`agents.service.ts:811`).
- Line 83: the board-prompt bullet is `skills/backlog-execute/SKILL.md:81-82`; `pr-mode.md` §1's keyed lines are `references/pr-mode.md:38-40`.
- Line 95–96: `GET /api/agents/branches` (`agents.controller.ts:524-529`) is a registry-path lookup; the launch sheet has that path as `item.projectPath`
  (`shared/types.ts:141`), so no new plan field is needed.
- Line 103, 105: `config`, `parseExecuteConfig`, `remindToCommitConfig`, `CONFIG_FILE` exist at `skills/backlog/tools/backlog.mjs:2193-2359`;
  `server/src/agents/finish-mode.util.ts` is imported only by `agents.service.ts:35` and `prompt.util.ts:2`; tests in `test/agents-prompt.test.ts:318-350`
  and `backlog.test.mjs:6194-6340`.
- Line 113: the `config` verb paragraph is `docs/subsystems/invariants.md:3972-3978`. Line 128: `.claude/rules/dispatch-watchdog.md:16` ("The prompt is
  the only client field taken outright") and `:54` ("Item `dispatch` is the exception to both … taken outright"); reasoning at `invariants.md:1455-1456`.
- Line 29: the Jira prompt's closing rule is its own (`server/src/jira/prompt.util.ts:76-85`) and spawns Jira's skills, not `backlog-execute`; it imports
  `COMMIT_RULE` only, so replacing `PR_FINISH_RULE` does not touch it.

## Critical

### C1 — line 82–85 with 65–69 and 35: a typed `--finish pr` under an in-place pick pushes

Line 82 makes the `--finish pr` token the skill's one pr signal "wherever it appears in the trigger". Line 68 keeps the typed body as the prompt, and line 75
appends `finishClause(finish, base)` to it; for `in-place` that clause is `COMMIT_RULE` (line 65), which carries no `--finish` token
(`shared/agent.ts:854-857`). So: picker on In place, person types `--finish pr` anywhere in the textarea → the server sends body + `COMMIT_RULE` → the
prompt contains exactly one `--finish` token, `pr` → the skill enters pr mode and pushes. That is the first anti-goal, line 35, verbatim ("A launch that
pushes when the sheet showed in-place"). The test list at line 125–126 only covers the reverse case (typed `--finish in-place` under PR), which the
two-token rule at line 84–85 does catch; this direction has no second token to collide with.

Fix (pick one, state it in §2): (a) `AgentsService.dispatch` refuses an execute body that contains a `--finish` or `--base` token with a 400 ("pick the
finish mode with the picker"), making the picker the only channel — this also closes I7 below; or (b) `finishClause('in-place')` ends with an explicit
`--finish in-place` token so the two-token error at line 84–85 fires and the session halts instead of pushing. (a) is the one that keeps "what the sheet
shows at click time is what the session does" literally true.

## Important

### I1 — line 99 vs 71: "`finish` always sent" collides with "`finish` on a non-execute → 400"

Line 99: "The dispatch sends `finish` always (even when untouched …)". Line 71: `finish` "Present with an action other than `execute` → 400". The
`LaunchSheet` is one component for groom, execute and capture (`client/src/components/board/LaunchSheet.tsx:64-82` sends one body for all three). Read
literally, a groom launch sends `finish` and is refused. Say: `finish` is sent on every **execute** dispatch, and omitted (not `undefined`-spread, omitted)
for groom and capture; the test at line 124 ("finish on groom → 400") is then the server half of the same rule.

### I2 — line 72–73 with 77: `main` is appended under PR but the proof it points at skips `main`

Line 73 says `base` is "proved against the project's real local branches the way the orchestrate start's `base` is". That proof is `resolveBaseBranch`
(`server/src/items/base-branch.util.ts:36-52`), and its first line returns `'main'` unproved: `if (base === undefined || base === '' || base === 'main')
return 'main'` (`:37`). The comment at `agents.service.ts:1740-1760` justifies the short-circuit because orchestrate appends nothing for `main` — "there is
no caller text for the two checks to protect". Line 77 removes that premise for execute: `--base main` IS appended. In a project whose trunk is `master`,
the sheet offers `main` (unioned in, line 96 / `OrchestrateSheet.tsx:257-262`), the server accepts it unproved, and the skill stops at `pr-mode.md` §2's
`rev-parse` — so the behaviour is "halt in the skill" where line 73's "Unknown → 400" promises a 400 at dispatch. Decide and write it down: either call
the two checks for `main` too under `finish: 'pr'` (a new flag on `resolveBaseBranch`, or a direct `show-ref` after it), or state that `main` is the one
value the server does not prove and the skill's §2 check is where it fails.

### I3 — line 113–114: the `.claude/rules/skills.md` text is not a bullet, and its headline lives in two homes

Line 113 removes "`.claude/rules/skills.md`'s bullet that the verb is local-file in both modes". That text is two sentences inside the exit-5 bullet
(`.claude/rules/skills.md:19-27`), whose HEADLINE is "**`backlog.mjs` in a tracker project and `jira.mjs` always need the stack up, and say so with exit
`5` — save `backlog.mjs config` and `jira.mjs worktree`.**" — byte-equal at `CLAUDE.md:127` and anchored to `invariants.md:3942`. Removing "the bullet"
deletes the exit-5 rule; leaving the headline keeps naming a verb that no longer exists. The spec must say: rewrite the headline in BOTH `CLAUDE.md:127` and
`skills.md:19` (dropping "`backlog.mjs config` and"), drop the two `config` sentences inside the bullet, and rewrite the `invariants.md:3942` section's
`config` paragraph (3972–3978) — `test/claude-rules.test.ts` checks headlines byte-equal across the two homes (`test/claude-rules.test.ts:7-17`).

### I4 — line 122–123: the sweep grep misses the places that would ship a dead instruction

`git grep -n -i "config.json\|execute\.finish\|execute\.base\|parseExecuteConfig\|readFinishMode\|in place this time"` does not match: `backlog.mjs
config` (`skills/backlog-execute/references/pr-mode.md:3`, `:21-23`; `CLAUDE.md:127`; `.claude/rules/skills.md:19`), "the committed config already
answered that" (`pr-mode.md:9`), "the config is not read" (`SKILL.md:67`, `pr-mode.md:5`), `"finish":"pr"` (`SKILL.md:74-75`, `pr-mode.md:3`), or
`PR_FINISH_RULE` (`shared/agent.ts:848-865`, `test/agents-prompt.test.ts:5`). `pr-mode.md:3` in particular would keep telling the skill to read this file
"when `backlog.mjs config` printed …" — a verb the same change deletes. Add `backlog\.mjs config`, `committed config`, `the config`, `"finish":"`,
`PR_FINISH_RULE` and `finish-mode` to the grep, and note that `pr-mode.md`'s intro (lines 1–15, before §1) is rewritten too — line 26–27 says "§2 onward" is
untouched and line 83–84 names only §1, which leaves the intro in neither bucket.

### I5 — line 110–112: `invariants.md:466-467` argues for the design this spec deletes

The reasoning paragraph the spec says to re-word ("a project's committed config" → "the trigger's `--finish pr`") contains: "The mode is a committed file
rather than a prompt switch so a project's set of committers is visible in its own history, and a malformed file stops execute rather than falling back to
either mode" (`docs/subsystems/invariants.md:466-467`). A word swap leaves a sentence that argues against a prompt switch under a rule now implemented as
one. The spec should say the sentence is replaced with the new reasoning (the "Why" section: one mental model with orchestrate; the switch is composed
server-side from a validated field, so it is as trustworthy as `--merge-mode`; an unknown `--finish` value stops, never falls back) — and that
`invariants.md:459` ("A project that commits `backlog/config.json` …") is rewritten in the same pass (the grep in I4 catches that one).

### I6 — line 70–71: two readers of `finish`, and the controller is not named

`dispatch-watchdog.md:17` and `agents.controller.ts:64-90` make the controller rebuild the body field by field; a `finish`/`base` the controller does not
forward never reaches `AgentsService.dispatch`, so the 400s at line 71–73 would be unreachable and every launch would be `in-place`. Say in §2 that the
controller forwards `body.finish` and `body.base` unvalidated (like `model`/`effort`) and the service validates — the same two-layer shape `--merge-mode`
has (`agents.controller.ts:135` → `resolveMergeMode`).

### I7 — line 82–85: two `--base` values in one prompt are undefined

Line 84–85 defines the collision for `--finish` only. With PR picked and `main` in the base select, a body containing `--base develop` is sent as
`… --base develop … --finish pr --base main …`. Which base the skill honours is unspecified; `pr-mode.md` §2 cuts from `<base>`, so the PR could open into
`develop` while the sheet said `main`. Either state the same stop-on-two rule for `--base`, or take C1's option (a), which removes both tokens from the
body at the server.

## Minor

- Line 19 vs 90: the Settings row is written "**Execute finish: in-place | PR**" in Goals and "options **In place** and **PR**" in §3. Line 121 leaves exact
  copy to the builder, but the two sections should at least agree on the option label (`In place` matches the hint's register; `in-place` matches the
  flag). Also say whether the row's value labels come through a `*OptionLabels` helper like `mergeModeOptionLabels` (`client/src/lib/merge-mode.ts`).
- Line 73: "the long comment near `resolveMergeMode`" is `resolveBase`'s doc comment (`agents.service.ts:1740-1762`); the checks themselves are in
  `resolveBaseBranch`, `server/src/items/base-branch.util.ts:36-52`, shared with `GET /api/items/uncommitted`. Name the file so the implementer reuses it.
- Line 75: the 8 000 `PROMPT_MAX` check (`agents.service.ts:432`) runs on `req.prompt`; say whether the appended clause counts against it. Harmless either
  way (the dashboard's own 4 000 cap is relayed, `agents.service.ts:96-103`), but today the whole prompt is what the check sees and tomorrow it is not.
- Line 70–73: pr finish is legal in a files project (`invariants.md:455-456`, "in files and tracker projects alike"), unlike `--merge-mode pr`, which
  `resolveMergeMode` refuses outside a tracker project (`agents.service.ts:1899` doc). Say so, or an implementer copying `resolveMergeMode` adds the gate.
- Line 68: `AgentPlan.prompt`'s doc comment ("The composed default. The sheet may edit it before dispatching.", `shared/types.ts:883-890`) and
  `test/agents-prompt.test.ts:114` ("asserted … per action") describe the closing rule as part of the plan for every action; both need their note.
- Line 84–85 and 126: a typed `--finish in-place` under a PR pick makes the session halt with the two-token error — neither what the sheet showed nor the
  anti-goal. Say that halting is the intended outcome (fail loud), so the test at line 126 is not read as asserting a push.
- Line 53–54: the fallback "remote's default branch, else `main`" is `backlog.mjs:2237-2246` (`git symbolic-ref --short refs/remotes/origin/HEAD`). If it
  stays as a helper, note that it is a local git read in both modes — no stack, never exit `5` — or the exit-5 headline rewrite in I3 needs a new exception.
- Line 65–67: the example clause ends "and never merges" while `PR_FINISH_RULE` today ends at "opens the PR" (`shared/agent.ts:865`); fine, but
  `pr-mode.md` §1's rewritten bullet should quote whichever sentence ships, since the skill text and the constant drifted once already (#326 review 2).
- Line 97: for an in-place pick the read-only line shows `COMMIT_RULE` — 180 characters under a textarea that, for groom and capture, still holds that same
  sentence editable. Acceptable; call out that the two sheets look different on purpose so a UI review does not "fix" it.
