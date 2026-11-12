## Verdict: APPROVE WITH FIXES

Zoom-out review of `docs/superpowers/plans/2026-11-12-reviewer-coverage-anchors-groups.md` against its spec, CLAUDE.md and the rule files named in the
brief. The shape of the plan is right: one deterministic tool, one procedure file, three callers, and the server change is the narrow settings and override
work the spec asks for. Nothing found contradicts the spec's behaviour or a CLAUDE.md hard rule, so there is no Critical finding. Eleven Important findings are
wrong test values, files missing from the plan, or interfaces that do not fit together. Each one needs only a local edit.

## Critical

None.

## Important

1. **plan:130 — `CLI_SOURCES` alone is not enough. The guard throws on a new entry.** The plan says "the `CLI_SOURCES` loop picks up `review.mjs` (its
   existing assertions apply unchanged)". The loop at `skills/backlog/tools/backlog.test.mjs:3457` reads `ENTRY_SHAPES[name]` (`:3445-3452`) and calls
   `accepted.some(...)`. A `CLI_SOURCES` entry without a matching `ENTRY_SHAPES` key gives a TypeError, not a pass. → Add `'review.mjs':
   ['process.exitCode = main(']` to `ENTRY_SHAPES` in Task 1's Files and Step 1. Also add the `ROWS` row in `scripts/run-as-main.test.mjs:26-35`, which
   needs an unknown-command `status` and `output` for `review.mjs` that the plan never states (see Minor 1).

2. **plan:182 — the "test/source pair is never split" test passes without testing anything.** Eleven files in one bucket fall below both thresholds. Step 1
   of the algorithm (plan:155, "count ≤ 12 and total ≤ 1200 → one group") puts them all in one group, so `x.mjs` and `x.test.mjs` share a group however
   pairing works. → Use 13 or more files in one bucket, with the pair sorting across the 10-file boundary, so the split actually runs.

3. **plan:355, plan:370 — `init --review-config` refusal "exit 2" goes against orchestrate's exit-code contract.**
   `skills/backlog-orchestrate/SKILL.md:109`: "this tool has no exit `2`… A `1` means 'this call was wrong'". `cmdInit` refuses every bad flag with `1`
   (`orchestrate.mjs:3383`, `:3409`, `INIT_USAGE` at `:3348`). → Exit `1` naming `--review-config`, and assert `1` in the `init refuses a non-object
   --review-config` test.

4. **plan:439 (and the File structure table, plan:87) — `server/src/agents/agents.controller.ts` is missing.** The controller rebuilds both request bodies
   field by field. Dispatch is at `agents.controller.ts:80-105` and orchestrate at `:170-215`, whose comment says "a new field reaches the service only when it
   is added here too". The `review` field never reaches `AgentsService` unless both rebuilds forward it (unvalidated, as `mergeMode` is). → Add
   `agents.controller.ts` (Modify) to Task 10 and the table.

5. **plan:416 (Task 9 Files, plan:402) — the new server writer fails `test/server-write-paths.test.ts`.** That suite scans `server/src` for any file calling
   `writeJsonAtomic`/`renameSync`/`writeFileSync` and fails on one missing from its `WRITERS` table (`test/server-write-paths.test.ts:19-37`).
   `review-config.util.ts` writes through `atomic-write.util.ts`, so it trips the guard. → Add `test/server-write-paths.test.ts` (Modify, a `WRITERS` row
   `'settings/review-config.util.ts': [reviewFile({})]`) to Task 9 and the table, and run it in Step 4.

6. **plan:451 — the `REVIEW_FLAG` body guard 400s the board's own untouched prompt when an item title spells `--review-…`.** The existing finish-flag guard
   has a twin, `defuseFinishFlags` (`shared/agent.ts:941-949`), applied to the quoted title in `composePrompt` (`server/src/agents/prompt.util.ts:31`). It
   exists because "Left as is, the board's own untouched execute or groom prompt would trip rule 8 on its quoted title and 400 the default dispatch". The plan
   adds the refusal but not the defuse, and this feature's own item titles are likely to spell `--review-`. → Extend the defuse to `REVIEW_FLAG`, either a
   second replace or one combined pattern, and add an `agents-prompt.test.ts` case where a title carrying `--review-model` composes a prompt that passes the
   guard.

7. **plan:410 vs plan:445 — `parseReviewConfig` cannot name the bad member, but Task 10's 400 must name it.** Task 9 fixes the signature as `(value: unknown)
   => ReviewConfig | null`. Task 10 then requires `"review: <which member> is not a valid reviewer setting"`, and adds "exact text the builder's", which
   undoes the "exact". → Change the Task 9 interface to return which member failed (for example `{ config } | { error: string }`), state the error string
   once, and use it for the settings POST 400 too.

8. **plan:412-414, plan:492 — `reviewerLabel` can crash Run detail on a run file whose `reviewConfig` is any object.** `init` checks only "is a JSON object"
   (plan:355-356), and `sanitizeMergeFields` passes unknown keys through by spread (`server/src/orchestrator/orchestrator.service.ts:115-124`). So `{}`, or a
   partial object a driver wrote, reaches `reviewerLabel(source.reviewConfig)`, which reads `c.big.model` and throws in render. The server's own #349
   precedent (`orchestrator.service.ts:127-134`) is degrade, don't throw. → `reviewerLabel` runs the value through the validator and shows `Reviewer:
   default` when it is invalid. Add the case to `test/run-detail-model.test.ts`.

9. **plan:361, plan:391 (spec:262-263) — `scope --previous <first manifest>` is wrong for execute pr-mode's third review.** pr-mode reviews up to three times:
   it does not push "when the review after the second fix round still says `fix`" (`skills/backlog-execute/references/pr-mode.md`, §7). Round 3 scoped
   against round 1's manifest gets round 1's `findings.json` as its earlier findings, so round 2's new Critical/Important findings are never handed to a
   reviewer. That breaks the spec's anti-goal "an incremental review approves a branch with a known open finding". `rerun` is also computed against round 1's
   `to`. Each manifest copies the partition, so using the previous round's manifest keeps the first round's groups. → `--previous <the previous round's
   manifest>` in both callers. Flag the spec wording as the plan defect it causes.

10. **plan:489-491, plan:500 — the LaunchSheet override rule is unstated and conflicts with the Orchestrate sheet's.** The Orchestrate sheet sends `review`
    only when the pick differs from the seed (spec §7 item 5: no override → the target machine's `review.json` applies). For the execute LaunchSheet the plan
    says only that the preview shows the flags, and its test expects `--review-mode` in the preview of a PR finish, which suggests it is always sent. The
    preview must equal what is sent (`LaunchSheet.tsx:283` comment), so an always-sent override silently overrides a remote target's `review.json`. → Apply
    the Orchestrate sheet's rule to the LaunchSheet: preview and send `review` only when changed. Add the untouched-sheet case: the preview has no `--review-`
    and the request has no `review`.

11. **plan:87, plan:445-453 — the rule file that states the mechanism this task changes is not updated.** `.claude/rules/dispatch-watchdog.md:39-46` lists
    everything a caller can influence in the orchestrate prompt "in this order", ending at ` --base <ref>`. It says `base` "is the one member whose caller
    text is appended verbatim". `:17-18` and `:59-61` list the four flags whose presence in a body is a 400. After Task 10 all three statements are false:
    the review flags are appended after `--base`, `smallMaxLines` is a second caller-supplied value that is checked and then formatted, and `--review-` is a
    fifth refused flag. CLAUDE.md:157 makes the rule file "the one home of its rules' mechanism". → Add `.claude/rules/dispatch-watchdog.md` (Modify) and
    the matching `docs/subsystems/invariants.md` paragraph to Task 10 and the table.

## Minor

1. plan:65-97 — the File structure table leaves out `scripts/run-as-main.test.mjs`, although Task 1 (plan:104) modifies it. The plan also gives no
   unknown-command exit code or message for `review.mjs`, which the new `ROWS` row (`scripts/run-as-main.test.mjs:26-35`) needs. State both, for example
   exit 1 with `unknown command: <x>` as the other CLIs do.
2. plan:371 — the entry to extend is `RARE_PATH_REFERENCES` (`orchestrate-prompts.test.mjs:752-757`), not `RULES` (`:516`). "RULES ≈753" points at the
   wrong list name.
3. plan:61 — Review Focus 5 says `"300"` "from a typed flag" exits non-zero. A typed flag is always a string, and `--review-small-max-lines 300` is the
   valid case. Say "a non-integer typed value (`3.5`)" instead. Also say what `scope` does with an invalid `--review-config` JSON (exit 2, no manifest)
   and add a test for it. Task 7 relies on "scope validates it" (plan:356), but no test covers it.
4. plan:58 — Review Focus 4 promises robustness to "a trailing comment". Trimmed exact comparison (plan:284) does not provide that, and no test covers it.
   Drop the claim.
5. plan:107, plan:129 — "precedence `--review-config` JSON > flags" contradicts "together → error". The test name "JSON beats flags is an error" reads both
   ways. State it only as mutually exclusive.
6. plan:201-202 — reuse: the repo already keys per-project state on `encodeURIComponent(<absolute main-checkout path>)` (`orchestrate.mjs` `projectDir`,
   tick's twin, `.claude/rules/skills.md:21`). A third scheme (basename + sha1) is a new convention for no stated reason. Twin the existing one, or say why
   not.
7. plan:412 — placement: `reviewerLabel` is a display string only the client uses. Its sibling `mergeModeLabel` lives in `client/src/lib/run-stage.ts`
   (`run-detail.ts:3`), and `shared/agent.ts` is for predicates both sides must agree on. Put it in `client/src/lib/`.
8. plan:148 — `git add -A` through a temporary index adds an un-ignored nested git checkout (another worktree, a vendored clone) as a gitlink. The gitlink
   then becomes a "reviewable file" no reviewer can cover, which ends in `incomplete`. The closed skip-reason set has no slot for it. Exclude mode-160000
   entries from the file list, or state the behaviour.
9. plan:171 — asserting `.git/index` byte-identical around the run is fragile if the test's own `git status --porcelain` refreshes the index between the two
   reads. Capture the bytes before any `status` call, or set `GIT_OPTIONAL_LOCKS=0` for the test's own git calls.
10. plan:181 — "2 files totalling 1201 lines → >1 group unless one file alone is over the cap": every split of 1201 lines gives two groups unless the two
    files are a pair. Name the exact sizes and the expected group count.
11. plan:241, plan:272 — `merge --reports <g…>` is written as required, but the all-skipped/no-item case runs `merge` with no reports. Mark `--reports`
    optional.
12. plan:323 — `<branch>-<n>.md`: say that `/` in the branch becomes `__` as in the state path, and how `<n>` is chosen (next free number).
13. plan:317-321 — `procedure.md` is read with the Read tool, so `${CLAUDE_PLUGIN_ROOT}` is never filled in there. Say that it carries
    `skills/backlog-execute/references/pr-mode.md:14-15`'s instruction on resolving the root. Also add `backlog-review` to the eight-skill non-vacuity list in
    `test/skills-plugin-root.test.ts:38`.
14. plan:323-328 — SKILL.md's description leaves out the standalone empty-diff sentence `nothing to review — no changes against <base>` (spec:132). The spec
    wins, but list it with the other display strings.
15. plan:448 — "otherwise 400 …": for a remote execute the server derives `finish` as `pr` even when `req.finish` is absent (`agents.service.ts:438`). Say
    the `review` rule runs on the derived finish, as the base rules do. Also strike the author aside "(my call — …)".
16. plan:357-360 — say what the driver does when `review.mjs config` exits 2 on bad trigger flags (refuse the run before `init`). Say how a resumed driver
    reads `reviewConfig` (`status --json` prints the whole run, `orchestrate.mjs:5283`).
17. plan:518-524 — the "Author calls" list names each choice but not the alternative it rejected. For example `config --defaults` vs. having `init` record a
    default, or `findings.json` vs. reading the merged report. Optional, since the spec covers most of them.
