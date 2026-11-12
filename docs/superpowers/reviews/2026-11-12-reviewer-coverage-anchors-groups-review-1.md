## Verdict: REVISE

Deep review, round 1, of `docs/superpowers/plans/2026-11-12-reviewer-coverage-anchors-groups.md` (at 5fe060f0). Three reviewers ran; none missing.

- Correctness (Fable, plan checklist): [review-1-correctness](2026-11-12-reviewer-coverage-anchors-groups-review-1-correctness.md) — APPROVE WITH FIXES
- Zoom-out (Opus): [review-1-zoom-out](2026-11-12-reviewer-coverage-anchors-groups-review-1-zoom-out.md) — APPROVE WITH FIXES
- Comprehension (Opus, with paraphrase): [review-1-comprehension](2026-11-12-reviewer-coverage-anchors-groups-review-1-comprehension.md) — REVISE

## Merged findings (deduped within ±3 lines; highest severity kept)

1-1 [C] plan:214, 361 — `scope --previous <first manifest>` reads round 1's `findings.json`, so a third round loses round 2's findings → pass the latest manifest.
1-2 [I] plan:31–33, 104 — `review.mjs` missing from `ENTRY_SHAPES` and from run-as-main `ROWS`; no unknown-command contract → add both, exit 1 `unknown command`.
1-3 [I] plan:116, 127, 190, 355, 370 — exit 2 for bad args; `orchestrate.mjs` has no exit 2 (SKILL.md:109) → exit 1 throughout.
1-4 [I] plan:439 — `agents.controller.ts` rebuilds both bodies field by field and would drop `review` → add it to Task 10.
1-5 [I] plan:402 — new writer `review-config.util.ts` missing from `test/server-write-paths.test.ts` `WRITERS` → add the row.
1-6 [I] plan:451 — titles pass `defuseFinishFlags`, which knows only the four finish flags; a title with `--review-mode` injects a flag → extend the defuser.
1-7 [I] plan:492 — the run file's `reviewConfig` reaches the board unvalidated (`sanitizeMergeFields` spreads it) → validate, invalid → `Reviewer: default`.
1-8 [I] plan:439 — `.claude/rules/dispatch-watchdog.md` and invariants.md state the composition order and "base is the one caller-supplied value" → Modify both.
1-9 [I] plan:320 — spec §7 says the merged report records a model/effort fallback; `merge` has no input for it → `--fallback <n>:<field>` + test.
1-10 [I] plan:323 — standalone empty diff (spec:132 `nothing to review — no changes against <base>`) not in SKILL.md's contract → state and pin it.
1-11 [I] plan:371 — check-failures triggers belong in `RARE_PATH_REFERENCES` (:752), not `RULES` → move, with the same-sentence requirement.
1-12 [I] plan:357–362, 371 — only one `RULES` pair for ~7 new SKILL.md statements → one pair per statement.
1-13 [I] plan:359 — the `config --defaults` branch has no named section or observable trigger → §7, "the run file has no `reviewConfig`", plus a pair.
1-14 [I] plan:308 — spec §4 "Scope of a group" agent edit absent → add the paragraph and pin it.
1-15 [I] plan:317–321 — procedure.md has no re-review branch; callers describe it separately → procedure owns `--previous`/`--carried`.
1-16 [I] plan:318 — dispatch omits `item file path` and `outcome: none` → include both, pin them.
1-17 [I] plan:34 — spawned `review.mjs` tests can touch the real `~/.backlog-manager` → every spawn sets `BM_REVIEW_HOME` and `BM_REVIEW_FILE`.
1-18 [I] plan:142, 356 — invalid `--review-config` JSON at `scope`/`config` unspecified though Task 7 relies on it → exit 1 naming the flag + test.
1-19 [I] plan:328 — "under autopilot the offer is a gate" is unobservable to the skill → when AskUserQuestion is unavailable or denied, take Recommended.
1-20 [I] plan:182 — pair-never-split fixture has 11 files, below the 12-file threshold, so no split happens → 14 files.
1-21 [I] plan:409, 445 — `parseReviewConfig` returns `null` and cannot name the member Task 10's 400 needs → return `{ ok, config } | { ok:false, member }`.
1-22 [I] plan:491 — LaunchSheet always sends `review`, overriding the target's `review.json` → send only when the pick differs from the seed; test it.
1-P paraphrase (comprehension report) — matches what the plan means; no edit.

## Rulings

| id | outcome | evidence |
| --- | --- | --- |
| 1-1 | FIX | Task 3 copies earlier findings from `<manifest>.findings.json`; the first manifest's holds only round 1's. `--previous` now takes the latest manifest; three-round test added; spec §6 wording deviation noted in Self-review. |
| 1-2 | FIX | `backlog.test.mjs:3447` `ENTRY_SHAPES`; `scripts/run-as-main.test.mjs:26–37` `ROWS` derive the NINE count. Row and exit-1 contract added to Global Constraints and Task 1. |
| 1-3 | FIX | `skills/backlog-orchestrate/SKILL.md:109` "this tool has no exit `2`". All `review.mjs` and `init` bad-arg exits are 1. |
| 1-4 | FIX | `server/src/agents/agents.controller.ts` ≈80–105, ≈170–215 rebuild bodies by field. Added to Task 10 and file table, with an HTTP-route test. |
| 1-5 | FIX | `test/server-write-paths.test.ts:26–36` lists every writer. Row added to Task 9. |
| 1-6 | FIX | `shared/agent.ts:939` `FINISH_FLAG` covers four flags; `prompt.util.ts:31` defuses titles with it. Defuser extended; title test added. |
| 1-7 | FIX | `orchestrator.service.ts:115` spreads unknown fields. `sanitizeMergeFields` now drops an invalid `reviewConfig`; `{}` test added. |
| 1-8 | FIX | `.claude/rules/dispatch-watchdog.md` ≈17–18, 39–46, 59–61. Both docs in Task 10 as Modify. |
| 1-9 | FIX | spec:291 "the merged report says so". `--fallback` on `merge`, procedure passes it, test added. |
| 1-10 | FIX | spec:132. SKILL.md sentence and pin added. |
| 1-11 | FIX | `orchestrate-prompts.test.mjs:752` `RARE_PATH_REFERENCES`. Triggers moved there. |
| 1-12 | FIX | `RULES` ≈516–563 is one pair per kept statement. Seven pairs listed. |
| 1-13 | FIX | §7 now states the trigger; it is one of the seven `RULES` pairs. |
| 1-14 | FIX | spec:207–209. Scope-of-a-group paragraph in agent edits, pinned in Task 6. |
| 1-15 | FIX | Procedure gains the re-review branch; Tasks 7 and 8 point to it. |
| 1-16 | FIX | spec §4 optional inputs. Dispatch includes both; Task 6 pins them. |
| 1-17 | FIX | Global Constraints line added. |
| 1-18 | FIX | `resolveConfig` contract and `config`/`scope` tests added. |
| 1-19 | FIX | Reworded to an observable condition; pinned with `unavailable or denied`. |
| 1-20 | FIX | Threshold is 12 (plan Global Constraints). Fixture now 14 files. |
| 1-21 | FIX | `parseReviewConfig` returns `{ ok, config } | { ok:false, member }`; 400 text fixed; test asserts the body. |
| 1-22 | FIX | Same seed rule as the Orchestrate sheet; untouched-sheet test added. |
| 1-P | — | Paraphrase correct. |
| m: correctness RF3 task pointer + atomic test | FIX | Review Focus 3 now points to Task 3; "no temp file left" added. |
| m: correctness RF5 route values | FIX | Controller test names `"300"` and `300.5`. |
| m: correctness pair over cap | FIX | Pair fixture added. |
| m: correctness scope flags over file | FIX | Added to `per-group model and effort`. |
| m: correctness `--previous` shape | FIX | `findings.json` is an array of `finding`. |
| m: correctness `config --defaults` in Task 1 | DECLINE | Task 7 is the only consumer; listed as an author call. |
| m: correctness 1201 fixture / zoom-out 10 / comprehension | FIX | 700 + 501 → exactly 2 groups. |
| m: correctness review.json fixture | FIX | Distinct big/small pairs. |
| m: correctness/zoom-out 13/comprehension skills-plugin-root | FIX | `backlog-review` joins the `it.each` list; procedure carries the root-resolution sentence. |
| m: correctness pr-mode do-not-push pin | FIX | Test added in Task 8. |
| m: zoom-out 1 file table | FIX | run-as-main row added. |
| m: zoom-out 3 RF5 typed flag | FIX | Reworded to `3.5`. |
| m: zoom-out 4 trailing comment | FIX | Claim dropped. |
| m: zoom-out 5 / comprehension precedence | FIX | Mutually exclusive, test renamed. |
| m: zoom-out 6 repo-key reuse | DECLINE | `orchestrate.mjs:280` `projectDir` keys a registered project name; a standalone review runs in unregistered repos with no such name. |
| m: zoom-out 7 `reviewerLabel` placement | DECLINE | Keeps every reviewer-config helper beside its twin-commented siblings; no behaviour difference. |
| m: zoom-out 8 gitlinks | FIX | Mode 160000 entries dropped from the file list. |
| m: zoom-out 9 / comprehension index flake | FIX | Read bytes first or `GIT_OPTIONAL_LOCKS=0`. |
| m: zoom-out 11 `--reports` optional | FIX | Bracketed. |
| m: zoom-out 12 / comprehension `<n>` and escaping | FIX | `/` → `__`, `detached`, next free integer. |
| m: zoom-out 15 derived finish + aside | FIX | Rule runs on the derived finish; aside struck. |
| m: zoom-out 16 / comprehension resumed driver | FIX | `config` exit 1 refuses before `init`; `status --json` named. |
| m: zoom-out 17 rejected alternatives | DECLINE | Optional; the spec carries most alternatives. |
| m: comprehension label | FIX | Bucket key of first file. |
| m: comprehension `.retry.md` stripped form | FIX | `<id>-<k>.retry.md`, `<id>-<k>.g2.md`. |
| m: comprehension `--path-format=absolute` | FIX | Added. |
| m: comprehension other agent sites | FIX | Helper block and `worktree` bullet named; pinned as absent. |
| m: comprehension orchestrate `--mode full` | FIX | Stated in §7. |
| m: comprehension git identity | FIX | Global Constraints line. |
