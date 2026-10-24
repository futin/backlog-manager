# Plan review 1 — groom PR finish and auto-merge/fix

- Plan: `docs/superpowers/plans/2026-10-24-groom-pr-and-auto-merge.md` (358 lines)
- Spec: `docs/superpowers/specs/2026-10-24-groom-pr-and-auto-merge-design.md` (304 lines)
- Reviewed against: the worktree at `.claude/worktrees/groom-pr`, HEAD `34d3383`; `CLAUDE.md`, `.claude/rules/dispatch-watchdog.md`, `.claude/rules/skills.md`,
  `.claude/rules/orchestrator.md:45-57`, `.claude/rules/tests.md`.
- Reviewer: Fable 5.1 subagent, read-only. Every code claim below was checked against the files at the cited lines.

## Verdict: APPROVE WITH FIXES

No Critical finding. Three Important findings, all in the test and doc text of Tasks 2 and 8; the implementer can fix the plan in minutes, and the
code shape, task order and interfaces are sound.

## Checklist results

### 1. Coverage

Every spec section maps to a task:

| Spec section | Task |
| --- | --- |
| `finishClause` sentences, `FINISH_FLAG` tokens, `FinishAction`/`FinishFlags`, request shape | 1 |
| Dispatch rule ladder (rules 1–8), groom prompt composition (strip trailing `COMMIT_RULE`, append clause), old-tab compatibility | 2 |
| Settings keys `groomDefaultFinish`, `prAutoMergeDefault`, `prFixDefault`; three rows with hints | 3 |
| Launch sheet: Finish/Base for groom on home, toggles under `pr`, seeding, request body, remote groom | 4 |
| `tick.mjs`: `groomTaken`, `isSkippedTree` accepts `groom-`, tracker candidate skip | 5 |
| `auto-merge.md` (allow check, `gh pr merge --auto`, 45-minute wait, 3 fix rounds, no force-push, outcome lines), execute hooks | 6 |
| Groom `pr` flow steps 1–9, guard while the PR is open, no reviewer, refusals | 7 |
| Invariant headline (three tiers), anchor links, subsystem docs | 8 |
| Real-run verification against scratch repos | 9 (held for the user, correctly) |

Every "Tests the builder owes" item in the spec has a Step 1 bullet in a task. Review Focus 1–5 each have a named test (plan:141 for RF3; plan:132-133
for the old-tab body; plan:216-221 for the toggle seeding; plan:244-247 for the tick skip; plan:288-291 for the auto-merge bounds).

### 2. Values and copy strings

Checked against the spec: the five `finishClause` sentences (plan:74-79), the eight 400 bodies (plan:113-123), the three Settings hints, the two
toggle span texts and the `sheet-note` (plan:202-204), the `groom/<id>` / `.worktrees/groom-<id>` spelling (plan:313), the commit subject
`docs(groom): <item title>` and `Refs #<n>` (plan:316), the `auto-merge: not allowed on <owner>/<repo> — PR left open` line (plan:290). All match the
spec byte for byte. One gap: plan:137 names two 400 cases without their body text (finding I-2).

### 3. Reality — paths, names, line ranges

All Modify citations resolve to the claimed code:

- `shared/agent.ts:872-878` `FINISH_FLAG` doc + pattern (`/(?<![\w-])--(finish|base)(?![\w-])/` at :878); `:880-888` `defuseFinishFlags`; `:890-931`
  `COMMIT_RULE` doc; `finishClause(finish: ExecuteFinish, base: string)` at :936-939.
- `shared/types.ts:895-900` `AgentPlan.prompt` doc (plan says :893-899 — one line off, harmless); `AgentDispatchRequest` :917-948; `ExecuteFinish` :1137.
  `FinishAction`/`FinishFlags` do not exist (Create is right).
- `server/src/agents/agents.service.ts:410-455` is the rule block (remote forced-pr ~:419, rule 1, rule 2 `finish applies only to execute`, derived
  finish, base rules, rule 5 execute-only with the quoted message); base proof :564; `prompt: action === 'execute' ? \`${prompt} ${finishClause(finish, base)}\` : prompt` at :568.
- `server/src/agents/prompt.util.ts:26-36` `composePrompt` — execute `[head, instruction]`, else `[head, instruction, COMMIT_RULE].join(' ')`.
- `client/src/components/board/LaunchSheet.tsx`: header 28-42, state 66-97 (`pickedFinish` :70, `base` :74, `isExecute` :86, `fetchedBranches` :97),
  body spread :124, clause line :206 (`isExecute && … finishClause(finish, base)`), Finish/Base row 208-225, remote-control `Switch` 261-265.
  `client/src/components/ui/Switch.tsx` takes `disabled` and `title`.
- `client/src/lib/settings.ts`: `executeDefaultFinish` :144/:185/:345, `pickOne` :230; no `pickBool` yet (Produce is right). `SettingsView.tsx:445-452`
  Execute finish row.
- Tests: `test/agents-shared.test.ts:846-849` (pr-mode quote, `finishClause('pr', '<base>')`), `finishClause` describe :1016 with three cases;
  `test/agents-dispatch.test.ts` `exec` :576, `spawnedPrompt` :575, `TOKEN_REFUSAL` :578, doubled case :586; `test/agents-dispatch-remote.test.ts:371-426`
  `groom32` + `'Groom #32. ' + COMMIT_RULE`; `test/agents-prompt.test.ts:327` the `it.each(['groom','capture'])` case; `test/agents-plan.test.ts:157`;
  `test/launch-sheet.test.tsx` :360 describe, :446 groom case, :515 remote groom case.
- `skills/backlog-tick/tools/tick.mjs`: groom call :450, `startedMarker` comment :502-504, `isSkippedTree` :531-536, `executeTaken` :538,
  `filesGroomCandidate({ root }, state)` :583, `trackerGroomCandidate(mine, state)` :600, `executeId` :231, `FILE_ITEM_ID` :80, ctx `{ root, tracker, repo }` :365.
  `tick.test.mjs`: loop :450 inside the test at :444; the sibling test is at :519 (plan:242 says :520 — one off); tracker test :532.
- Skills: `skills/backlog-execute/references/auto-merge.md` and `skills/backlog-groom/references/pr-mode.md` absent (Create is right). Execute SKILL.md
  description 1-8, Finish mode 73-87, hard limits :376-380; execute pr-mode.md §1 17-40, §8 224-270, §9 271-282. Groom SKILL.md "never commits" 18-21,
  `## Pick an item` :33, `## Groomed on disk only` :417, `## If the session ends without a verdict` :438.
- Invariant sites: `CLAUDE.md:195` (+ Why link :196), `.claude/rules/orchestrator.md:45-50` (+ link :57), `docs/subsystems/invariants.md:603` heading and
  :261 tick paragraph, `docs/overview.md:123`, `skills/backlog-orchestrate/SKILL.md:9`. The anchor is linked from `CLAUDE.md:196`, `docs/subsystems/skills.md:48`
  and `.claude/rules/orchestrator.md:57`; the phrase "only skill that merges" also sits in `skills/backlog-execute/references/pr-mode.md`.

Two reality mismatches that matter are findings I-1 (plan:136 miscalls a groom case a capture case) and I-3 (a COMMIT_RULE doc comment the plan does not
route to Task 8).

### 4. Interfaces

Every Consumed name is Produced earlier with the same spelling: `finishClause(action, finish, base, flags?)`, `FinishAction`, `FinishFlags`,
`AgentDispatchRequest.autoMerge/fix` (Task 1 → 2, 4); `groomDefaultFinish`, `prAutoMergeDefault`, `prFixDefault` (Task 3 → 4); `groomTaken`,
`trackerGroomCandidate({ root }, mine, state)` (Task 5, consumed in-file); `auto-merge.md` (Task 6 → 7); the tree spelling (Task 5 → 7).

### 5. Order

Sound. Task 1 widens the function with the call sites passing `'execute'` so behaviour holds; Task 2 then widens dispatch; Task 3 lands the Settings keys
before Task 4 reads them; Task 5 lands the tick skip before Task 7 teaches the groom skill the same tree spelling; Task 8 last, Task 9 held.

### 6. Tests

- Fail-before: each task's Step 1 adds cases that cannot pass on today's code (new signature arity, new 400 texts, new Settings keys, new toggles, new
  `groom-` tree, absent reference files). Step 2 runs them red.
- Per-key logic with ≥2 keys: `executeDefaultFinish:'pr'` vs `groomDefaultFinish:'in-place'` (plan:214-215); `prAutoMergeDefault`/`prFixDefault` crossed
  (plan:217-219); two bugs for the files groom skip and two issues for the tracker skip (plan:244-247). Good.
- Fixtures discriminate: the tracker skip test uses `groom/#12` (not skipped) against `groom/12` (skipped), the same discriminator the existing
  execute test at `tick.test.mjs:532-569` uses.
- Weak spots: the `3` needle in plan:291 (Minor M-3); two 400 cases with no pinned body (Important I-2).

### 7. The plan's own conventions

Behaviour and exact values, no literal code blocks — the plan honours the global rule. No hard size budgets stated. Test file placement follows
`.claude/rules/tests.md` (jest flat in `test/`, node beside the tool).

## Findings

### Important

**I-1 — plan:136 — the `:629` case is a groom body, not a capture one; under the new rule 2 it becomes 201, so "replacing the wording" cannot pass.**
`test/agents-dispatch.test.ts:622-630` posts `action: 'groom'` on `bug-1-a-fresh-bug.md` with `finish: 'pr', base: 'main'` and expects
`{ error: 'finish applies only to execute' }`. Task 2 rule 2 (plan:114) makes groom a legal finish action, so this body must dispatch 201 and end with
`finishClause('groom','pr','main')` — which is exactly the case plan:134 adds. → Say: convert the :622-630 case into the accepted groom-pr case
(plan:134), and ADD a new capture-body case (the file's `good` fixture at :162 is an execute; a capture needs an `out-of-scope` item) that expects
`finish applies only to execute or groom`. The implementer following plan:136 as written will reword the expectation, run it, and see a 201 where a 400
was promised.

**I-2 — plan:137 — two 400 cases carry no body text, so the test cannot pin it.** `autoMerge true with finish in-place → 400` and `fix true with no
finish → 400` name no expected body; rules 6–7 (plan:119-121) decide it (`autoMerge and fix apply only to finish pr` for both: a missing finish derives to
`in-place`, and rule 6 runs before rule 7). The spec's tests-owed list wants the exact bodies pinned, as every other 400 case in the same bullet is.
→ Write the body for each: `autoMerge true with finish in-place → 400 autoMerge and fix apply only to finish pr`; `fix true with no finish → 400
autoMerge and fix apply only to finish pr` (not `fix requires autoMerge`, because rule 6 fires first on the derived `in-place`). Also state that the
`fix true, no finish` case is the proof that rule 6 precedes rule 7.

**I-3 — plan:56 / plan:94-96 and plan:342-345 — `shared/agent.ts:912-915` quotes the OLD invariant headline inside `COMMIT_RULE`'s doc comment, and no
task routes the headline change there.** The comment at `shared/agent.ts:912-915` reproduces "`backlog-orchestrate` is the only skill that merges;
`backlog-execute` commits and pushes its own branch only in `pr` mode" verbatim, and :929-931 says "Groom and capture keep it in their editable text".
Task 1 Step 3 (plan:95-96) covers the second sentence but says nothing about the quoted headline, and Task 8 (plan:335-337) lists CLAUDE.md, the rule
file, invariants.md, overview.md and orchestrate SKILL.md but not `shared/agent.ts`. The Step 4 grep at plan:350 (`grep -rn "only skill that merges"
CLAUDE.md docs skills .claude`) does not search `shared/`, so the stale quote survives the plan's own check. `test/claude-rules.test.ts` does not read
`shared/`, so nothing goes red. → Add `shared/agent.ts:912-915` (the quoted headline) to Task 8's Modify list, or to Task 1 Step 3's doc-comment edits,
and widen the plan:350 grep to include `shared server client` so the sweep catches it.

### Minor

**M-1 — plan:197-198 — the remote-groom clause line shows `COMMIT_RULE`, which the spec does not ask for and the existing test forbids.**
`test/launch-sheet.test.tsx:446` is `draws no Finish, no clause line and no finish or base key for a groom launch`, and the spec says only that a remote
groom draws no Finish. Drawing the clause line for a remote groom is a new visual the spec is silent on. Acceptable as a design call, but plan:222-223
(the :515 remote-groom case "keeps passing") should then say the clause line IS drawn, or the implementer will keep the old `no clause line` assertion
and fail. → State the remote-groom clause-line expectation explicitly in the :515 bullet, or drop the clause line for a remote groom.

**M-2 — plan:201 — branches are fetched for every groom, including a remote one that draws no Base.** Today `fetchedBranches` (:97) is gated on execute;
the plan widens it to "execute or groom". A remote groom has no Base picker (plan:197-198), so the fetch is wasted. Cheap, once per open, so Minor. →
Gate the fetch on `hasFinish` rather than the action, which is the same condition the Base picker uses.

**M-3 — plan:289-291 — the needle `3` is trivially true.** A file that mentions `45 minutes` already contains a `3`? No — but any `3` anywhere (a step
number, "§3") satisfies it, so the bound is not pinned. → Pin the exact phrase the spec uses for the fix-round bound (e.g. `3 rounds` or `three fix
rounds`, whichever `auto-merge.md` will say) and state that phrase in Task 6's Content so the file and the test agree.

**M-4 — plan:242 — cites `tick.test.mjs:520`; the sibling test `existing execute branch or worktree skips the item` starts at :519.** One-off line
citation; harmless. plan:58's `shared/types.ts:893-899` is likewise two lines early (the doc is :895-900).

**M-5 — plan:143-144 — "the existing :375–426 expectations must keep passing unchanged" is true only because of the strip-then-append composition, and
the plan does not say so.** `test/agents-dispatch-remote.test.ts:416-422` expects the Pro-bound prompt to be `'Groom #32. ' + COMMIT_RULE`. Under Task 2
a remote groom has no finish (rule 3), derives `in-place`, and the composition strips the trailing `COMMIT_RULE` from the body and appends
`finishClause('groom','in-place',…)` = `COMMIT_RULE` — byte-identical, but only because the strip and the append cancel. → Add one clause: "unchanged
because the strip removes the one `COMMIT_RULE` the plan carried and the `in-place` clause puts the same bytes back".

**M-6 — plan:328-329 — the `test:skills` condition is already decided: `skills/backlog/tools/backlog.test.mjs:2861-2913` reads `backlog-groom/SKILL.md`
and asserts its `### Mark it in progress` section rule by rule.** `.claude/rules/tests.md` says the same. → Replace the conditional with "run
`pnpm run test:skills` — `backlog.test.mjs` reads groom's SKILL.md", so the implementer does not skip it. Task 7's edit to `## Groomed on disk only`
(:417) is also one of the sentences that suite pins (tests.md: "backlog-groom's … closing `Groomed on disk only` line"), so "not printed in `pr` mode"
must keep the sentence in the file and only change when it is printed.

**M-7 — Task 3 — "`title`-style reason" for the disabled Fix row is ambiguous.** `Switch.tsx` accepts a `title` prop, so the intent is reachable, but
"title-style" reads as either the `title` attribute or a visible label. → Name the prop: `title="Needs Auto-merge on"` (or the spec's sentence) on the
Fix `Switch` while disabled.

**M-8 — plan:350 — the grep's exclusion "a historical spec/plan" is not machine-checkable.** The sweep will hit the earlier specs under
`docs/superpowers/` and the implementer must judge each hit. → List the expected historical hits (the two design specs and this plan) so a new hit stands out.

## Not findings (checked and fine)

- `finishClause` has exactly two production call sites (`agents.service.ts:568`, `LaunchSheet.tsx:206`) plus two doc mentions (`prompt.util.ts:31`,
  `types.ts:897`); Task 1's "call sites only, mechanical" is accurate, and Task 2/4 widen them.
- The `good` fixture at `test/agents-dispatch.test.ts:162` is an execute on `bug-2`; the plan's "add a groom twin of `exec`" (plan:129) is the right move.
- `tick.mjs` tracker ctx carries `root` (:365), so `trackerGroomCandidate({ root }, mine, state)` is reachable without a new parameter upstream.
- `test/claude-rules.test.ts` compares headlines byte-equal and anchors by slug (`test/helpers/rule-tiers.ts:127-152`); the plan's "headlines byte-equal,
  anchors resolve once" (plan:348) matches the mechanism.
- Task 9 is correctly held: creating GitHub repositories and pushing to them is outside an unattended run.
