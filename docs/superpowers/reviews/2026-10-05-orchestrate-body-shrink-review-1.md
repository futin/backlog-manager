# Review 1 — `docs/superpowers/plans/2026-10-05-orchestrate-body-shrink.md`

Reviewer: fresh subagent (Fable 5.1), 2026-10-05. Inputs: the plan, the repo at `19a33fe` (HEAD matches the plan's stated commit), the repo `CLAUDE.md`, the
prior plan `2026-09-01-orchestrate-skill-floor-trim.md`. No spec — the plan's Why / Global constraints / Review focus are the requirements.

**Verdict: REVISE.** One Critical (Task 8's CLAUDE.md line would fail `test/claude-rules.test.ts`) and eight Important findings. Everything checked in the
plan's Why section — the 151,246 total, every per-section size, the 17 tracker sites and their ~15k, the 60,168 baseline — reproduces exactly. Almost every
`S:`/`T:`/`O:` reference resolves to the content described. The problems are in the interfaces and the test re-pointing, not the measurement.

## What was verified and holds

- `wc -c SKILL.md` = 151,246 (plan:14). Per-section sizes (plan:29-30): §9 29,704; §4 30,987 (dispatch 16,519; create worktree 10,543); §3 12,378; §7 11,993;
  §10 11,762; §8 10,484; §2 9,432; §5 7,458; preconditions subsection 20,042. All match.
- The 17 tracker sites (plan:197-198) exist at the lines given and sum to 15,217 chars.
- 60,168 baseline (plan:283) matches `2026-09-01-orchestrate-skill-floor-trim.md:32`.
- Every cited test title at T:3148, 3273, 3300, 3334, 3437, 3641, 3660, 3925, 3939, 4321, 4364, 5182, 6022, 6303, 6325, 6341, 6351, 6369, 6618, 6629, 6641,
  6650, 6663, 6731, 6775, 6801, 6822, 6847, 7820, 7838, 7875, 7885, 7900 is the test the plan describes. T:6693-6760 is the exclude-block harness.
- `branchExists` O:2475, `isUnbornHead` O:2553, `USAGE` O:5278, `main` O:5374, `readRun` O:690, `assertDriver` O:822, `findQueueItem` O:2351,
  `writeRunAtomic` O:720, `OrchestrateError` O:53, `process.exitCode = main(...)` O:5422 — all present. `orchFixture` T:54, `addWorktree` T:3487,
  `basedFixture` T:6486, `trackerFixture` T:7011 exist. `stream-denial.jsonl`, `stream-no-result.jsonl` exist under `tools/fixtures/`.
- Exit codes `6`/`10` as the stopping trigger (plan:221) match S:84/S:88. The three `exec claude -p` lines (S:662, S:892, S:1002) are outside every moved range.
- The "gap to fix" (plan:225-228) is real: S:1399 says "park, per the conflict branch above" and the only fenced `merge --abort` targets the base tree.
- Task ordering is sound: Tasks 2 and 3 consume nothing from later tasks; Task 3 consumes `baseTree` from Task 1 (see I6 for the gap in *how*).
- `t.diagnostic` exists in `node:test`; the "never fails" size report (plan:283-285) is consistent with the user's global CLAUDE.md learning on hard budgets.

## Critical

**C1 — plan:279-282 (Task 8).** "one line in `CLAUDE.md`, beside the orchestrate entry … Why-link to a new short section in `docs/subsystems/skills.md`".
`test/claude-rules.test.ts:38` pins every linked bullet from `## Invariants` onward to
`^- \*\*(.+?)\*\* Why: \[invariants\.md\]\(docs\/subsystems\/invariants\.md#[\w-]+\)$` — a `Why:` link anywhere but `docs/subsystems/invariants.md` is an
offender, and `compareTiers` additionally requires a tier-two bullet with the same headline and anchor in a `.claude/rules/*.md` file. `CLAUDE.md:59-60`
states the convention the test enforces ("Each is the ONE home of the mechanism text … CLAUDE.md keeps each rule's headline, `docs/subsystems/invariants.md`
its reasoning"). As written, the commit in Task 8 turns jest red. "Beside the orchestrate entry" is also ambiguous — CLAUDE.md:52-56 (Layout, `→` links,
unchecked by the tier guard) or CLAUDE.md:127/131 (Invariants, checked).
→ Fix: state the three-tier shape explicitly. Headline bullet in `## Invariants` with `Why:` → a new section in `docs/subsystems/invariants.md`; the
mechanism bullet (one statement + where the story goes + where a rare branch goes) in `.claude/rules/skills.md` (paths `skills/**`, the natural scope);
the reasoning — including "references stay resident once read" — in that invariants.md section. The `docs/subsystems/skills.md` paragraph at :126-133 can
then *narrate* it with a plain link, not a `Why:`. Alternatively, if it is meant as a Layout note, say "Layout, line 52-56, `→` link, no `Why:`".

## Important

**I1 — plan:45.** "exit codes from the existing table only (0/1/3/7 — no new codes)". The table (O:44-52, O:87, O:758, O:767) is 0/1/3/4/5/6/7/8/9/10, and
the new subcommands compose steps that already own other codes: `merge-check` runs `stage <id> merging`, which refuses with `10` under an effective stop
request (O:3190-3194), and its `park` verdict runs `attention`, which in a tracker project posts to the API and exits `8`/`9` (O:3487, `trackerAttention`
→ `apiCall` → `EXIT_API_DOWN`/`EXIT_API_REFUSED`). Restricting to 0/1/3/7 either forces the tool to swallow a stop or contradicts itself.
→ Fix: "no new codes; a composed step's refusal propagates with its own code (`10` from `stage`, `8`/`9` from a tracker `attention`), and nothing is written
after it" — and add a case to Task 1: effective stop → `merge-check` exits `10`, run file unchanged (the same shape as T:5196's stop cases).

**I2 — plan:53 and plan:201.** The trigger "If `status --json` shows `source: github`" names a field the run file does not have. `OrchestratorRun`
(`shared/types.ts:1204-1380`) carries `project`, `base`, `mergeMode`, `questionMode`, `queue`, `attention`, … and no `source`; `status --json` prints the run
file verbatim (O:3815). The body's actual predicate today is "a project whose committed `backlog/source.json` says `github`" (S:106), and the tool resolves it
per call via `projectSource(run.project)` (O:3487).
→ Fix: phrase the trigger on `backlog/source.json` (observable, already how the body says it), or have Task 4 add an optional `source` to the run file
(written by `init`, typed in `shared/types.ts` in the same commit, per plan:49) and keep the `status --json` wording. Either way the global-constraint
example at plan:53 must match.

**I3 — plan:93, plan:103-104 (Task 1 verdict `park`, cases 3-5).** Two gaps in the same place.
(a) S:1240-1249 — outcome 3, "it prints nothing and `worktree add` refuses" (base held by a mid-rebase/detached tree, invisible to `--porcelain`), with the
S:1247 template — has no test case among 1-11. The plan retires T:6629 (plan:113), whose assertions at T:6633-6636 are that outcome's only pin. Under the
plan's own rule (plan:37-38: a rule leaves the body only if "the subcommand's test pins it") this rule would be pinned nowhere.
(b) Case 4 expects `detail` to contain `detached HEAD`, but the plan says park uses "the exact S:1247/S:1276 template". S:1276 is
`base tree <base tree> is on <ref>, not refs/heads/<base> — …`; when `symbolic-ref HEAD` exits non-zero there is no `<ref>`, and nothing says what fills it.
→ Fix: add case 12 — base held only by a detached tree (checkout a commit in a second worktree, then `worktree add` of the base refuses) → `park`, detail
equals S:1247 with git's message substituted, no base worktree created. State what `<ref>` becomes on a detached HEAD (e.g. the literal `a detached HEAD`)
so case 4's expected value is derivable from the template.

**I4 — plan:50-51 vs T:4321-4360.** `NOTE_PLACEHOLDERS` (T:4273) has an `unused` assertion (T:4352-4356): every listed placeholder must still appear in some
`--detail`/`--note` value in `FILES`. `<message>` appears in exactly one value (S:1247), `<ref>` in exactly one (S:1276), `<paths>` in exactly one (S:1302) —
all three templates move into `merge-check` in Task 1, and `orchestrate.mjs` is not in `FILES`. Task 1's commit turns T:4321 red, and the plan's
constraint only covers *new references files*, not templates that leave markdown altogether. `<path>` (S:1247, S:1452) needs the same check after Task 3.
→ Fix: in Task 1 (and Task 3 for `<path>` if it has no remaining site) remove the orphaned placeholders from `NOTE_PLACEHOLDERS` with a comment pointing at
the behaviour case that now pins the exact template, or add `orchestrate.mjs` to `FILES` and let `noteValues` scan the template constants.

**I5 — plan:127-133 (`leftover` verdicts).** `archived` is defined as "branch exists and its diff archives the item" with no shape constraint, and it is
listed before `resume-or-park`. The body applies the archive check only to `branch=0 worktree=1 dir=1` (S:348-366); for all-three-present the body asks or
parks regardless of the diff (S:537-562). An implementer following the list order would return `archived` for a branch+worktree+dir leftover whose diff
happens to archive the item, and the body would `stage branched` a tree that may hold uncommitted work — a behaviour change with no case.
→ Fix: define `archived` as "branch only (no worktree, no dir) *and* the diff archives the item"; `reattach` as "branch only and it does not"; state the
precedence explicitly.

**I6 — plan:167-174 (`cleanup` interface).** "In merge mode only, it runs `branch -d backlog/<id>` from the base tree" and "diffs `HEAD^1 HEAD` in the base
tree", but nothing says where `cleanup` gets the base tree. Task 1 records `baseTree: { path, created }`; Task 3 never names it, and does not say what
happens when it is absent (a `merged` item on a run file written before Task 1, or a tracker branch-mode item that never ran `merge-check`).
→ Fix: "`cleanup` reads `run.baseTree.path`; if the stage is `merged` and the field is absent, exit `1` and remove nothing" (or "resolve via
`treeHoldingBranch(run.base)` and say so"), plus a case for the absent field.

**I7 — plan:204-209 (T:7838's 1600-char window) vs plan:39/198/204.** T:7838 requires `denied by the auto-mode classifier`, `park` and `branch mode|branched`
within 1600 flattened chars *after* `push origin <base>` (S:1422). That text is the three-bullet paragraph at S:1424-1437, which plan:198 lists among the
tracker sites to move (1418-1439), while plan:39 and plan:204 keep the push line itself in the body. The plan's resolution — "move the whole paragraph rather
than widen the window" — would move the push line with it, which the global constraint forbids. These are not rationale either: "a denied PUSH parks" and
"a rejected push parks, do not `push --force`" change what the driver types.
→ Fix: keep the push line and a one-line version of each of the three outcomes (success → `stage … --outcome`; rejected → park; denied → park, never
`branched`) in the body under the push line; move only the explanatory prose. Say so in Task 4 and point T:7838 at the body as it is.

**I8 — Coverage: `.claude/rules/orchestrator.md:49-60` and `docs/subsystems/invariants.md:446-471`.** Both carry the §9 mechanism as prose — "resolved per
merge (`git worktree list --porcelain`) into three exhaustive outcomes", `.worktrees/_base-<sanitised ref>`, the `symbolic-ref` precondition, `branch -d` and
`diff HEAD^1 HEAD` from the base tree. `CLAUDE.md:59-60` makes the rule file "the ONE home of the mechanism text". After Tasks 1 and 3 the mechanism is
`merge-check` and `cleanup`, and no task touches either file (Task 1 Files, plan:82-83; Task 3 has no Files line). T:4321's `FILES` already includes
`invariants.md` precisely because that drift happened once before (T:4322-4327).
→ Fix: add `.claude/rules/orchestrator.md` and `docs/subsystems/invariants.md` to Task 1's and Task 3's Files, with the instruction "rewrite the mechanism
sentence to name the subcommand and its verdicts; the reasoning paragraphs stay".

## Minor

- plan:54 — `.prettierrc` is `.prettierrc.yaml` (`printWidth: 160`, `proseWrap: always`).
- plan:47 — `treeHoldingBranch` is defined at O:2574; 2575 is its first body line.
- plan:80 — "~20k → ~4k": S:1207-1303 is 7,621 chars. The 20,042 figure is the whole "two preconditions" subsection, which runs to S:1503 and includes the
  merge, the failure branches and the cleanup. The Task 1-3 aggregate still lands near 125k (7.6k + 10.8k + 8.1k ≈ 26.5k), so plan:74 holds; only the Task 1
  label is wrong.
- plan:66 — Review focus 4 says "Task 5's recovery.md edit"; the recovery.md edit (base-tree cleanup on resume) is in Task 1's Files (plan:83). Task 5 only
  checks a pointer (plan:232).
- plan:229 — "T:3328" is a comment line inside the test beginning at T:3317 ('step 9 documents resolving on the branch side before parking'). Name the test.
- plan:186 — case 7 "touching only `tools/orchestrate.mjs`": the body's path is `skills/backlog-orchestrate/tools/orchestrate.mjs` (S:1520). Spell it in full
  so the test and the tool agree.
- plan:140 — body keeps "`stage dispatched`"; for `reattach` the body goes to **Inspect** (§5), not dispatch (S:567-574). Say the body keeps that fork.
- plan:138-139 — `worktree`'s exit code on a failed presence probe is unstated (0 implied, as for `merge-check`'s `park`).
- plan:220-223 — S:84, S:88, S:395, S:654, S:829-830 say "go to §10, _Pausing_/_Stopping_"; after Task 5 each must say "read `references/stopping.md`".
  T:3660 only checks the filename appears once; the markers are where the trigger is actually read.
- plan:189 — T:6369's second assertion (no attention detail template offers `worktree prune`) is a body-wide guard, not a cleanup-split pin. Keep that
  assertion when retiring the rest.
- plan:114 — keeping T:6663's needle `worktree remove "$PWD/.worktrees/_base-` forces §10 to keep the literal spelling even though the path now comes from
  `baseTree.path`. Fine, but say which spelling §10 uses so the implementer does not re-point the needle by accident.
- plan:260 — the new no-history-reference case: S:141-146 (`task-4`, `bug-2`, …) is sample `plan` output and S:194/214/925 are fenced commands, so the
  fence exclusion covers them; the hard-limits list of id prefixes (`bug-`, `idea-`, …) has no digits. Nothing else to allowlist today — worth saying.
- plan:171 — Task 3 case 3 lets the implementer choose between a real repro and a classification-function test; T:6303's comment says the "failed to
  delete" shape was hit in 2 of 2 real occurrences with `Directory not empty`, so a recorded-stderr fixture is the honest minimum. Say which pair of
  (status, stderr) is pinned.
