# Review 1 — Execute finish picker implementation plan

Plan: `docs/superpowers/plans/2026-10-21-execute-finish-picker.md`
Spec: `docs/superpowers/specs/2026-10-21-execute-finish-picker-design.md`
Reviewer: fresh subagent (Fable), 2026-10-21. Every code claim below was checked against the worktree at `99ccafe`.

## Verdict: APPROVE WITH FIXES

No Critical findings. Built as written the plan ships the spec's behaviour and breaks no hard rule in CLAUDE.md. Six Important findings are places where
an implementer would hit a red test or a compile error the plan did not predict, or where a cited line points at the wrong sentence; each has a one-line fix.

## Checklist results

1. **Coverage** — every spec section maps to a task: §1 trigger flag → Task 2; §2 server → Task 3; §3 Settings → Task 4; §4 launch sheet → Task 4;
   "What is removed" → Tasks 2 and 3; "Invariants this changes" → Task 5; "Left to the builder" bullets each land (fallback chain → Task 2 line 90; copy →
   Global Constraints; sweep → Task 5 Step 3; stale notes → Task 3 lines 119–121; `pr-mode.md` §1 quote and guard re-aim → Task 2 Step 1; "taken
   outright" exception → Task 5 line 211). Spec test list (lines 142–145): every server 400 has a case in Task 3 Step 1; "an execute plan's prompt carries
   no closing clause" → Task 3 line 141; "spawned prompt ends with `finishClause` for each mode" → lines 143–147; client seed/base-only-under-PR/clause
   line/finish-always → Task 4 Step 1. One gap, Minor: spec 145 says `finish` is never sent "on groom **or capture**"; the plan tests groom only (line 197).
2. **Values** — pr clause (plan 22 = spec 66–67), refusal message (plan 24 = spec 79–80), Settings row/labels/hint (plan 25 = spec 100–101), announcement
   `finish mode: pr → PR into <base>` (plan 92 = spec 55), the four 400 phrasings for `finish`/`base` are the plan's own (the spec names none) — all
   consistent. `COMMIT_RULE` unchanged (plan 23 = spec 65).
3. **Reality** — every Modify path exists; `server/src/agents/finish-mode.util.ts` exists for Delete; `proveBaseBranch`, `finishClause`,
   `isExecuteFinish`, `EXECUTE_FINISHES`, `ExecuteFinish` do not yet exist (grep empty). Line cites checked: `shared/types.ts` 883–919 and 1093–1103 ✓;
   `shared/agent.ts` 47, 845–865 ✓; `agents.service.ts` 35, 391, 429 ✓; `agents.controller.ts` 64–90 ✓; `backlog.mjs` 2177, 2188–2361, 3829–3830 ✓;
   `backlog.test.mjs` 8, 6193–6402 ✓; execute `SKILL.md` 6, 65–82, 369 ✓; `skills/backlog/SKILL.md` 105–118 ✓; `backlog-reviewer.md` 6, 54, 73 ✓;
   orchestrate `SKILL.md` 27, 764 ✓; `settings.ts` 116, 215, 328 ✓; `SettingsView.tsx` 510 ✓; `agents.ts:571` ✓; `CLAUDE.md:127` ✓; `.claude/rules/skills.md`
   19–24 ✓; `orchestrator.md` 35–36 ✓; `dispatch-watchdog.md` 16, 54 ✓; `invariants.md` 1456, 3944, 3972–3978 ✓; `docs/subsystems/skills.md` 17, 34–42,
   113 ✓; `overview.md:110` ✓; `api.md` 180–181 ✓; `board.md` 130, 143 ✓. One miss: `invariants.md` ~459–460 (finding I4). The sweep grep run today hits
   exactly the files the plan touches plus the three it excepts (`docker-compose.yml`, `docs/workflows/development.md`, `tsconfig.build.json`) — the Task 5
   expectation is right.
4. **Interfaces** — `finishClause`, `isExecuteFinish`, `EXECUTE_FINISHES`, `ExecuteFinish`, `AgentDispatchRequest.finish/base` are produced in Task 1 and
   consumed in Tasks 2–4 with the same spelling and types. `fetchBranches(project)` takes the registry path (`OrchestrateSheet.tsx:132` says
   `BacklogItem.projectPath`), so `fetchBranches(item.projectPath)` at plan 173 is right.
5. **Order** — no task consumes a later task's output. Task 2 deletes `backlog.mjs config` while the server still reads `finish-mode.util.ts` until Task 3;
   that intermediate state compiles and passes (`readFinishMode` reads a file, not the CLI). `test/claude-rules.test.ts` stays green through Tasks 1–4 because
   both headline homes change together only in Task 5.
6. **Tests** — Task 1's cases fail before implementation (imports missing). Task 2's guard fails until `pr-mode.md` quotes the clause. Task 3 and 4 cases
   fail on absent fields/controls. Fixtures discriminate: bases `main`/`develop`/`release/1.x`/`nope`, finishes both values plus `'merge'`/`'PR'`/`7`,
   settings `{}`/`'pr'`/junk. Every Review Focus item has a named test (RF1 → plan 143; RF2 → 195; RF3 → 150; RF4 → 194; RF5 → 186). Two existing
   assertions the plan did not predict will go red (I1, I3).
7. **Conventions** — "behaviour, never literal code" is held throughout (signatures, exact values, cases; no code blocks). 160-column wrap and "comments say
   why" are restated in Global Constraints. Commit messages fit the `ci / pr-title` grammar.

## Important

- **[I1] plan:142–154 — `test/agents-dispatch.test.ts:179–184` asserts the spawned `body.prompt` is `good.prompt` byte for byte ("not a `toContain`… a
  server-recomposed one would satisfy"), and `good` is an execute launch (line 161). Task 3's rule 8 appends `COMMIT_RULE` to every execute, so this case
  goes red and the plan names no rewrite.** → Add to Step 1: rewrite that case to `good.prompt + ' ' + COMMIT_RULE` and update its comment (the typed body is
  still byte-for-byte; the clause is the one server-composed suffix).
- **[I2] plan:146–153 — the dispatch suite's `projectPath` is `makeProject(...)` (`test/helpers/store.ts:25`), a plain directory with no `git init`
  anywhere in the suite; `proveBaseBranch` needs real local branches, so "a fixture repo whose `main` exists", `develop`, and a `master`-trunk repo have no
  source.** → State the fixture: per-case `git init -q -b <trunk>` + one commit on `projectPath` (as `test/base-branch.test.ts:73–76`'s `makeRepo` does),
  `git branch develop` for the develop case, `-b master` for the unproved-`main` case; note `rmSync` in `afterEach` already cleans it.
- **[I3] plan:99–100 and 109–122 — Task 2 replaces the `PR_FINISH_RULE` assertion but `test/agents-shared.test.ts:20` still imports the constant; Task 3
  deletes it from `shared/agent.ts` without listing that test file, so ts-jest fails the suite with "has no exported member" (tsconfig is `strict`, and a
  missing export is an error, not an unused-import warning).** → Task 2 Step 1: also drop `PR_FINISH_RULE` from the import at line 20 (it becomes unused
  there anyway); or add `test/agents-shared.test.ts` to Task 3's Files.
- **[I4] plan:213 — cites "~459–460 committed-file reasoning" to replace, but the sentence the spec (lines 123–125) says must be REPLACED, not word-swapped
  ("The mode is a committed file rather than a prompt switch…"), is `docs/subsystems/invariants.md:466–467`. Lines 458–460 hold a second sentence
  (`backlog/config.json` with `execute.finish: pr`, "read through `backlog.mjs config`") that also needs the rewrite.** → Cite both ranges: rewrite 458–460
  to the trigger flag, replace 466–467 with the spec's reasoning (trigger flag, composed server-side from a validated field like `--merge-mode`, an unknown
  or doubled `--finish` stops execute).
- **[I5] plan:189 — "mock `fetchAgentPlan`, `dispatchAgent`, `fetchBranches` as the suite already mocks the first two": the suite does not module-mock;
  `stub()` (`test/launch-sheet.test.tsx:47–60`) replaces `global.fetch` and answers `/plan` by suffix and EVERY other URL with the dispatch response. A
  `/api/agents/branches?project=…` call would today be answered `{ sessionId }`, which `fetchBranches` reads as `[]`.** → Say: extend `stub()` with a
  `branches?: string[] | { reject: true }` handler matched on `/api/agents/branches`, and keep the dispatch fallthrough for the rest; RF2 uses the reject form.
- **[I6] plan:155 — `test/base-branch.test.ts` is an HTTP suite of `POST /api/agents/orchestrate` (lines 63–250) that never imports the util; its one repo
  helper inits `-b main` (line 74), so `repoWithoutMain` does not exist there.** → Say the new cases import `proveBaseBranch`/`resolveBaseBranch` directly
  from `server/src/items/base-branch.util` and add a `makeRepo(root, trunk)` variant (or a second `mkdtemp` repo on `master`).

## Minor

- plan:121 — `test/agents-prompt.test.ts:5` also imports `PR_FINISH_RULE`; the rewrite of the `describe('finish mode')` block removes its uses, so say the
  import goes too, beside line 4's `readFinishMode`.
- plan:177–179 — ambiguous whether the branches fetch runs for every execute open or only once Finish reads PR (`useFetched` skips on `load === null`,
  `client/src/hooks/useFetched.ts:3`). Either works; pick one so the "`fetchAgentPlan` called once" and RF2 cases are written against the same behaviour.
  (If it is PR-only, the deps are `[item.projectPath, finish === 'pr']`, not `[item.projectPath]`.)
- plan:197 — spec 145 says never on groom **or capture**; add a capture-plan case, or say groom stands for both (the gate is `plan.action === 'execute'`).
- plan:74 — the deletion list omits `effectiveConfig` (`backlog.mjs:2256`) and `isPlainObject` (`backlog.mjs:2203`, used only inside the config block).
  Listing them avoids a dangling helper.
- plan:80 — the two orchestrate `SKILL.md` edits sit in the body that `.claude/rules/skills.md`'s "one statement, no `bug-N`/`#N` history" rule guards
  (`orchestrate.test.mjs`); say the reword must stay one statement and cite no incident id.
- plan:129–133 — the four `finish`/`base` 400 strings are the plan's own choices (the spec names none). Fine; note they are pinned by the Task 3 tests so a
  later reword is deliberate.
- plan:88–91 — the skill prose reads `--base` from the trigger; note that a board-composed clause always carries `--base`, so the `origin/HEAD` fallback is
  reached only from a typed trigger (spec 87–89) — worth one sentence in SKILL.md so nobody "fixes" the board to omit it at `main` like orchestrate.
- plan:66, 105, 161, 201, 226 — commit subjects all pass `ci / pr-title`; `feat(skills)!:` is the right marker for the removed verb.
