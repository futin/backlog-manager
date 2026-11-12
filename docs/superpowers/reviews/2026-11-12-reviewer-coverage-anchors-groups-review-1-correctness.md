## Verdict: APPROVE WITH FIXES

Review 1 (correctness) of `docs/superpowers/plans/2026-11-12-reviewer-coverage-anchors-groups.md` against
`docs/superpowers/specs/2026-11-12-reviewer-coverage-anchors-groups-design.md` and the repo at `5fe060f0`.

No Critical finding. Twelve Important findings: each is a false statement about the repo, a file or guard the plan omits so a listed test run or the full
suite goes red, or a spec requirement with no task. None needs a redesign; all are plan-text fixes. `plan:N` is a line of the plan; `spec:N` a line of
the spec.

## Critical

None.

## Important

1. **plan:130 (also 31–32, 74) — "the `CLI_SOURCES` loop picks up `review.mjs` (its existing assertions apply unchanged)" is false.**
   `skills/backlog/tools/backlog.test.mjs:3447–3454` keeps a second table, `ENTRY_SHAPES`, keyed by file name, and line 3459 does
   `const accepted = ENTRY_SHAPES[name]` then `accepted.some(...)`. A `CLI_SOURCES` entry with no `ENTRY_SHAPES['review.mjs']` throws a TypeError.
   Fix: name both edits — the `CLI_SOURCES` entry and an `ENTRY_SHAPES` entry holding the synchronous form `process.exitCode = main(`.

2. **plan:104 (also 32–33) — "the nine → ten count and its test name" understates the `run-as-main` edit.**
   `scripts/run-as-main.test.mjs:26–37` builds `NINE` from `ROWS` plus `sync-plugin.mjs`; each row is `{ script, args, status, output }` and is run as a
   subprocess, asserting the exact exit status and output of an unknown command. The plan never states `review.mjs`'s exit status or message for an
   unknown subcommand (plan:113 covers only an invalid flag, exit 2). Lines 113–120 of the test also require the literal `function isMain(url)` body with
   the `realpathSync` pair and `catch { return false`.
   Fix: specify the new `ROWS` row (args, status, output text) and the unknown-subcommand behaviour in Task 1's Produces; say the `isMain` body is copied
   verbatim from an existing tool.

3. **plan:349, 371 (also 79) — the list is misnamed and the edit mis-described.** `['check-failures.md', [...]]` at
   `skills/backlog-orchestrate/tools/orchestrate-prompts.test.mjs:752–757` belongs to `RARE_PATH_REFERENCES`, not `RULES` (`RULES` is at ≈516–563, the
   "body keeps the rules" case). Its test (759–772) requires every trigger regex to match inside a SKILL.md sentence that names
   `references/check-failures.md`. The plan's "RULES ≈753" sends the implementer to the wrong list for the SKILL.md pair, and never says the two new
   regexes must appear in one sentence beside the file name.
   Fix: write "append `/"verdict":"incomplete"/` and `/"files":0/` to the `check-failures.md` entry of `RARE_PATH_REFERENCES` (≈756); add the SKILL.md
   pair to `RULES` (≈516)".

4. **plan:371–372, 377 — one `RULES` pair for at least six new SKILL.md statements.** `.claude/rules/skills.md` ("Each statement the body keeps gets a
   `[needle, rule]` pair in the `RULES` list") is a per-statement rule. Task 7 adds: the trigger accepts review flags; `review.mjs config` runs before
   `init`; every `scope` gets `--review-config` from the run file; an older run file reviews on `config --defaults`; the fix-loop re-review uses
   `scope --previous` with `--carried`; the fix prompt holds `merge`'s resolved lines. Only the `procedure.md` pair is planned, so a later trim of the
   other five passes silently.
   Fix: list one `[needle, rule]` pair per statement in Step 1.

5. **plan:358–360 — the older-run-file branch has no stated home, so its `--resume` reachability is unspecified.** `.claude/rules/skills.md` requires a
   rare branch's trigger to be reachable on both a fresh run and a `--resume`, "which skips the sections a fresh run finds the pointer in". The plan says
   "the resumed driver runs `review.mjs config --defaults`" but not which section holds the statement or what observable trigger names it (the run file
   has no `reviewConfig` key). A fresh run never takes this branch, so by the same rule it belongs in `references/` with a one-statement pointer.
   Fix: name the section (§7, which every review passes through on both paths), the trigger ("the run file has no `reviewConfig`"), and its `RULES` pair.

6. **plan:355–356 with plan:492, 501 — an unvalidated `reviewConfig` reaches `reviewerLabel`.** `init` accepts any JSON object. The server spreads the run
   file through `sanitizeMergeFields` (`server/src/orchestrator/orchestrator.service.ts:115–122`), which sanitizes only known keys, so `{}` or
   `{"mode":"x"}` reaches the client as `reviewConfig`. `reviewerLabel(c: ReviewConfig | null | undefined)` (plan:416–419) is specified only for a valid
   config, `null` and `undefined`; on `{}` it reads `c.big.model` and throws in Run detail. The tests (plan:501) cover a valid config and an absent one
   only. The repo's rule for every other run-file field is degrade, never throw (`.claude/rules/orchestrator.md`, `prUrl`, `base`).
   Fix: have `runDetailModel` (or the server's sanitize step) pass the value through `parseReviewConfig` and treat `null` as absent; add a test with a
   malformed object expecting `Reviewer: default`.

7. **plan:87, 438–439 — `server/src/agents/agents.controller.ts` is missing from Task 10's files.** The controller rebuilds both request bodies field by
   field: dispatch at `agents.controller.ts:93–102` (`finish`, `base`, `autoMerge`, `fix`, `machine`), orchestrate at 161–205 (`mergeMode`,
   `questionMode`, `base`). A `review` field never reaches the service unless it is added there. Task 10's tests go through HTTP
   (`test/agents-dispatch.test.ts:153, 525`), so they fail until the implementer finds this unaided.
   Fix: add the controller to the file table and Task 10, with "passes `body.review` through unvalidated, as `mergeMode`".

8. **plan:402–403, 420–421 — `test/server-write-paths.test.ts` is not in the plan and goes red.** Its case "every server module that writes a file is in
   the table above" (lines 88–95) scans `server/src` for `writeJsonAtomic(` and compares the result to the `WRITERS` table (lines 27–36), which lists
   `settings/timezone-config.util.ts`. The new `settings/review-config.util.ts` writes through `atomic-write.util.ts` and is not in the table. No Task 9
   run command includes this suite (plan:431–433), and plan:46–47 leaves the full suite to CI.
   Fix: add the file to Task 9's Modify list with a `'settings/review-config.util.ts': [reviewFile({})]` row, and the suite to Step 2/4.

9. **plan:451–452 — the `REVIEW_FLAG` body guard has no title defuser, recreating a documented bug.** `shared/agent.ts:934–949` explains that
   `FINISH_FLAG` has two uses on purpose: the 400 in `agents.service.ts:478–482` and `defuseFinishFlags`, applied to the item title, because "the board's
   own untouched execute or groom prompt would trip rule 8 on its quoted title and 400 the default dispatch". The plan adds only the 400. An item whose
   title spells `--review-mode` (likely in this repo once the feature exists) then refuses every default execute and groom dispatch, and without the
   defuser the execute skill's Finish-mode parse can also read a flag out of a title.
   Fix: state that the title defuser covers `REVIEW_FLAG` too (one pattern, two uses), and add a dispatch test with such a title expecting 201 and a
   defused title.

10. **plan:319–320 against spec:197 (§7) — the model/effort fallback is recorded nowhere.** The spec says "the caller re-dispatches that group once
    without the refused field and the merged report says so". The plan says "the caller notes it"; `merge` (plan:238–256) takes no input that could carry
    it, the merged report's content list (plan:251–253) omits it, and it is not among the author calls (plan:521–524).
    Fix: either give `merge` a way to record it (for example the caller rewrites the group's `model`/`effort` in the manifest before `merge`, with the
    groups table showing the fallback) and test it, or list the deviation as an author call.

11. **plan:304–312 against spec:207–209 (§4 "Scope of a group") — one agent-file change has no task.** The spec requires the agent to state that a
    group's coverage duty is its own files, that it may read any file and the full manifest, and that it may raise a finding at full severity about any
    file, another group's included. The plan's agent edits list every other §4 change but not this one, and no prose pin covers it (plan:327–328).
    Without it, a grouped reviewer has no licence to report a missed call site outside its group — the spec's stated reason for the sentence.
    Fix: add the edit to Task 6 and one needle to the `backlog-reviewer reports coverage…` test.

12. **plan:322–326 against spec:132–133 (§2 Edge inputs) — the standalone empty-diff sentence is missing.** The spec fixes the words
    `nothing to review — no changes against <base>`, with no dispatch and no state written. The plan's SKILL.md paragraph lists refusals, display and the
    fix offer but not this branch; the procedure only "return[s] that to the caller" (plan:317). The plan prints the sibling no-change sentence from the
    tool "so the three callers cannot word it differently" (plan:213–214) and leaves this one to nobody. No test pins it.
    Fix: name the sentence in Task 6's SKILL.md paragraph (or have `scope` print it on stderr, as it does the no-change line) and pin it in a test.

## Minor

- **plan:56–57** — Review Focus 3 points to "Task 4, test `an unparseable state file is treated as no earlier review`"; that test is in Task 3
  (plan:225). The atomic-write half has no test beyond "is valid JSON after the write" (plan:271); a test that no temp file is left beside the state file
  would pin temp + rename.
- **plan:60–61** — Review Focus 5 names the settings route and the launch request, but the controller test says only "POST invalid" (plan:429–430) and
  the launch test uses `smallMaxLines: 0` (plan:457). Both go through `parseReviewConfig`, which is tested with `"300"` and `300.5`; naming those two
  values in the route tests would make the mapping literal.
- **plan:185 against spec:138–139 and the Acceptance scope list** — the spec's case is "one file **or pair** over the cap → its own group"; the plan
  tests a file only. Add a pair fixture.
- **plan:187–188 against the Acceptance scope list** — "per-group model/effort … from flags overriding the file" is tested at `config` (plan:120–121) but
  not at `scope`, where only an invalid flag is run (plan:189).
- **plan:216–218, 230–231** — Task 3's `--previous` test reads `<manifest>.findings.json`, which Task 4 produces (plan:253). The test has to hand-write
  that file, and its shape (an array of `finding`?) is stated only as "the merged open findings". State the shape in Task 3's Produces.
- **plan:359, 374, 377** — `config --defaults` is added to a Task 1 CLI in Task 7. Correctly listed as an author call (plan:523); moving it to Task 1
  would keep the CLI's surface in one place.
- **plan:182** — "13 one-line files → >1 group; 2 files totalling 1201 lines → >1 group unless one file alone is over the cap" is a conditional
  expectation. Fix the fixture (for example 700 + 501) so the assertion is unconditional.
- **plan:121** — the `config reads review.json` fixture (`same` / `fable` / `high`) leaves the split pairs at defaults; a file with distinct `big` and
  `small` values would show all five keys are read.
- **plan:302, 341–342** — `plugin.json`, `CLAUDE.md`, `docs/subsystems/skills.md`, `docs/overview.md` are edited with no test named besides the byte
  budget. `test/skills-plugin-root.test.ts:40` lists the eight skills in a non-vacuity `it.each`; adding `backlog-review` there is the repo's habit if
  the new SKILL.md names `${CLAUDE_PLUGIN_ROOT}`.
- **plan:392–394** — the pr-mode test asserts the old string is gone and two new strings exist; nothing pins "Coverage failure or empty diff → do not
  push" (plan:388–389), the one behavioural rule Task 8 adds.
- **plan:445** — "exact text the builder's, but one sentence naming the member" leaves a 400 message unpinned while the two beside it (plan:447, 451)
  are fixed; consistent either way, but the test at plan:457 can then assert only the status.

## Checklist results

1. **Coverage.** §1 → Tasks 1–6; §2 → Task 2 (gap: finding 12; pair-over-cap Minor); §3 → Tasks 3–4; §4 → Tasks 4–6 (gaps: findings 10, 11); §5 → Task 6
   (gap: finding 12); §6 → Tasks 6–8; §7 → Tasks 1, 7, 9–11 (gaps: findings 6, 9); §8 needs no task. Acceptance: every listed case has a test except the
   two Minor ones above; `/ui-verify` → Task 11 Step 6; hand run → Task 12.
2. **Values.** Default config JSON, `reviewFlags` array, label strings, Settings copy, fallback reasons, skip reasons, the two `--detail` strings, the
   no-change sentence and thresholds all match the spec. Model and effort lists match `shared/agent.ts:210, 221`.
3. **Reality.** All Create paths are absent and all Modify paths exist. Line references checked: `backlog.test.mjs` 3215–3238 and 3408; SKILL.md §7
   786–885; `orchestrate.mjs` `cmdInit` 3308 and run object ≈3628; `agents.service.ts` 404–483 and 1017–1043; `pr-mode.md` §7 at 208 with
   `it diffs \`<base>...<branch>\`` at 214; retro's patterns at `skills/backlog-retro/tools/lib/reviews.mjs:19, 24`. False or incomplete: findings 1, 2,
   3, 7, 8.
4. **Interfaces.** Names and spellings are consistent across tasks. Forward references: `<manifest>.findings.json` (Minor), `config --defaults` (Minor).
5. **Order.** No task depends on a later one apart from the two forward references above; Tasks 9 → 10 → 11 are ordered correctly.
6. **Tests.** Fail-first holds for every task. Review Focus 1, 2, 4 have named tests; 3 and 5 are partly covered (Minor). Rule conformance gaps:
   findings 4 and 5 (`.claude/rules/skills.md`), 6 (`.claude/rules/orchestrator.md`), 9 (`.claude/rules/dispatch-watchdog.md`, the body-flag rule).
7. **Conventions.** The plan describes behaviour, not code, throughout. Task 6 (agent, procedure, skill, four doc files) and Task 11 (group, two sheets,
   run detail) are the two largest; both are still one reviewable unit each.
