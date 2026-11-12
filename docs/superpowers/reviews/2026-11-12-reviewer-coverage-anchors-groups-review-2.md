## Verdict: APPROVE WITH FIXES

Narrow re-check of `docs/superpowers/plans/2026-11-12-reviewer-coverage-anchors-groups.md`, diff `5fe060f0..8591bb8d` only. "plan:N" is a line of the plan
at `8591bb8d`; "spec:N" a line of `docs/superpowers/specs/2026-11-12-reviewer-coverage-anchors-groups-design.md`.

One Critical and three Important findings, all small text fixes. Everything else the diff changed checks out against the code.

## Critical

1. **plan:366–367, pinned by plan:379–380 — a headless `/backlog-review` now fixes code unasked.** The changed text says the fix offer is made whenever the
   verdict is `fix` or `minor` > 0, "and when AskUserQuestion is unavailable or denied the Recommended option is taken". spec:237–238 makes the offer only
   when "the session can ask (AskUserQuestion available — not a headless `claude -p`)", and spec:242 takes the Recommended option only "under an autopilot
   run", and logs it. The plan merges the two cases, so a headless run edits the working tree with nobody having chosen that, and the new test needle
   `unavailable or denied` pins the wrong behaviour. The "log it" half of spec:242 is also gone.
   Fix: no offer when AskUserQuestion is unavailable (headless); when it is denied under autopilot, take the Recommended option and log it. Pin both
   sentences in the `backlog-review offers to fix and commits nothing` test instead of `unavailable or denied`.

## Important

1. **plan:344 — the reviewer's helper `log --oneline <from>..HEAD` fails in incremental mode.** plan:230 sets incremental `from` to the state file's `to`,
   which plan:164 defines as a `git write-tree` object. `git log <tree>..HEAD` is an error, not an empty list. The manifest already carries `mergeBase`
   (plan:160), a commit.
   Fix: `log --oneline <merge-base>..HEAD`, merge-base from the manifest, as the item checks at plan:340 already read it.

2. **plan:166–167 — the gitlink drop has no test and is not listed as an author call.** Task 2 Step 1 (plan:185–211) has no case for a mode-`160000`
   entry, so an implementation that keeps it (and ends every such review `incomplete`) passes. It also leaves a changed path that is neither reviewed nor
   skipped for a stated reason, which spec:33 promises for every file in scope; the author-calls list (plan:600–603) does not record that departure.
   Fix: add a Task 2 case (a nested git checkout in the tree → absent from `files`, stdout counts unchanged) and add the drop to the author calls.

3. **plan:512–514 and plan:529–531 — the execute path never says `review` is validated, and no test sends an invalid one.** The orchestrate bullet
   (plan:509) names `parseReviewConfig` and its 400; the rewritten execute bullet only checks the derived finish. spec:320 requires a 400 "on any invalid
   member" for both sheets, and plan:520–521 writes into `.claude/rules/dispatch-watchdog.md` that the flags come "from a validated `ReviewConfig`, never
   caller text". As written, `finishClause` → `reviewFlags` can format an unvalidated object from the wire (`agents.controller.ts:93–99` forwards fields
   unvalidated by design).
   Fix: state that an execute's `review` goes through `parseReviewConfig` with the same error text, before the clause is built, and add an
   `agents-dispatch.test.ts` case: execute `finish: 'pr'` with `review.smallMaxLines: "300"` and with a model `gpt` → 400, nothing spawned.

## Minor

- plan:235–236 — `--previous` takes the latest manifest where spec:262–263 says "first manifest". The reasoning is sound (only the latest round's
  `findings.json` holds that round's findings) and it is listed at plan:602–603, but plan:22 says the spec wins on any disagreement. Amend spec §6 in the
  same change, or say at plan:22 that the listed author calls are the exceptions.
- plan:513 — cites `agents.service.ts:438` for the derived finish; the derivation is at `server/src/agents/agents.service.ts:441` (438 closes the `fix`
  boolean check).
- plan:96 — lists `server/src/agents/prompt.util.ts` as Modify, but it only calls `defuseFinishFlags` (`prompt.util.ts:31`) and needs at most a comment
  edit; Task 10's Files list (plan:499–504) leaves it out. Make the two agree.
- plan:37 — "every test that spawns `review.mjs` sets both `BM_REVIEW_HOME` and `BM_REVIEW_FILE`" cannot hold for the new `ROWS` row: `run()` passes a
  fixed env (`scripts/run-as-main.test.mjs:40`). Harmless as long as an unknown subcommand exits before any file read; say so, or exempt that row.
- plan:86 — the file table still says `RULES` pairs cover "the check-failures triggers"; plan:420 now puts them in `RARE_PATH_REFERENCES`
  (`orchestrate-prompts.test.mjs:752`).
- plan:356–357 — the shared procedure names the retry report `<id>-<k>.retry.md`, which is orchestrate's naming; the standalone and execute callers use
  `<branch>-<n>` and `review-<k>`. Phrase it as the merged report path with `.md` replaced, as plan:267–268 does.
- plan:382–383 and plan:385 — the `test/skills-plugin-root.test.ts` case is a jest suite, but Step 2 runs only `node --test`; it is first run in Step 4,
  so its red state is never observed. The suite's own comment also says "eight skills" (`test/skills-plugin-root.test.ts:38`).
- plan:467–468 — `member` is undefined for a pair with an extra or missing key (`big`? `review`?), and the `mode` case named there has no test at
  plan:479–480.
- plan:534 — the sanitize case uses only `reviewConfig: {}`; a second fixture with one bad member (`smallMaxLines: 0`) would show the check is
  `parseReviewConfig`, not "is non-empty".
- plan:223 and plan:480 run past the 160-column wrap the plan sets at plan:49.

## Checked and correct

- `CLI_SOURCES` at `skills/backlog/tools/backlog.test.mjs:3408` and `ENTRY_SHAPES` at `:3447`; the synchronous shape is right for a tool with no `fetch`.
- `scripts/run-as-main.test.mjs`: `ROWS` at :26, the count derived from `ROWS` plus `sync-plugin.mjs` at :37, the test name at :108; the new row's
  status and output match the other skill CLIs' rows.
- `orchestrate.mjs` has no exit 2 and prints `unknown command:` (:7264); `status --json` prints the whole run (:5282–5283).
- `test/skills-plugin-root.test.ts:40` list; `test/server-write-paths.test.ts:27–36` `WRITERS`; `agents.controller.ts` rebuilds at :80–107 and :161–215.
- `sanitizeMergeFields` at `server/src/orchestrator/orchestrator.service.ts:115`, covered by `test/orchestrator-runs.test.ts`; `FINISH_FLAG` and
  `defuseFinishFlags` at `shared/agent.ts:939` and `:947`; `StartOrchestrateRequest` exists (`shared/types.ts:1311`).
- `orchestrate-prompts.test.mjs`: `RULES` :516–562, `RARE_PATH_REFERENCES` :752–757, and the trigger test at :759 works as the plan describes.
- `agents/backlog-reviewer.md`: "The main tree is not yours" at :66, the helper block at :109–111; `pr-mode.md:14–15` holds the plugin-root sentence.
- `.claude/rules/dispatch-watchdog.md` line ranges (17–18, 39–46, 59–61) are the right bullets.
- Grouping fixtures: 700 + 501 lines gives exactly two groups whether or not the files share a bucket; 14 files now crosses the 12-file threshold, so
  the pair-split case can fail.
- Exit code 1 is consistent across Global Constraints, Review Focus 5 and Tasks 1, 2, 4 and 7, and satisfies the spec's "exits non-zero".
- Review Focus 3 and 4 now point at tests that exist under those names (Task 3, Task 4, Task 5).
- Rule conformance: the §7 "no `reviewConfig`" trigger is observable and reachable on `--resume` (`.claude/rules/skills.md`); the controller forwards
  `review` field by field (`.claude/rules/dispatch-watchdog.md`); both sheets seed from Settings (`.claude/rules/board.md`).

## Rulings

| id | outcome | evidence |
| --- | --- | --- |
| 2-1 [C] fix offer when AskUserQuestion unavailable | FIX | spec:237–242: offer only when the session can ask; autopilot takes Recommended and logs. Round-1 fix 1-19 over-reached; now: no offer headless, denied by an autopilot gate → Recommended + `autopilot decide`; test pins both. |
| 2-2 [I] helper `log --oneline <from>..HEAD` | FIX | Task 3: incremental `from` = state's `to`, a `write-tree` object. Helper uses `<merge-base>..HEAD`. |
| 2-3 [I] gitlink drop untested, not an author call | FIX | Task 2 case `a nested checkout is not listed`; added to Author calls. |
| 2-4 [I] execute `review` not validated | FIX | `agents.controller.ts:93–99` forwards unvalidated. Execute path runs `parseReviewConfig` with the same 400; two invalid-execute cases added. |
| m: spec-wins vs `--previous` deviation | FIX | "How to read" now exempts the listed author calls. |
| m: `agents.service.ts:438` → 441 | FIX | Citation corrected. |
| m: `prompt.util.ts` row | FIX | Row now names `shared/agent.ts` only; `prompt.util.ts:31` calls it unchanged. |
| m: `ROWS` env | FIX | Exempted with the reason. |
| m: file table `RULES` wording | FIX | Names `RARE_PATH_REFERENCES`. |
| m: retry report naming in procedure | FIX | Merged report path with `.md` → `.retry.md`. |
| m: skills-plugin-root red state | FIX | Step 2 runs the jest suite; its "eight skills" comment updated. |
| m: `member` for a pair with extra/missing key | FIX | Pair name (`big`). |
| m: sanitize second fixture | FIX | `smallMaxLines: 0` fixture added. |
| m: lines over 160 columns | DECLINE | Cosmetic; two lines in table/test text. |
