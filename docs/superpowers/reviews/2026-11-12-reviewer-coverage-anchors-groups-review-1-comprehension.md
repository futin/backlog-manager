## Verdict: REVISE

Plan under review: `docs/superpowers/plans/2026-11-12-reviewer-coverage-anchors-groups.md` (cited as `plan:<line>`).
Spec: `docs/superpowers/specs/2026-11-12-reviewer-coverage-anchors-groups-design.md` (cited as `spec:<line>`).
Pass: comprehension (paraphrase, undefined terms, unstated setup, "handled automatically" with no how). Code claims were checked by reading the code.

## What this proposes

A new `/backlog-review` skill and one shared review procedure (`skills/backlog-review/references/procedure.md`) that orchestrate §7 and execute pr-mode §7
also follow, so all three review the same way. A deterministic node CLI, `review.mjs`, has three jobs. `config` resolves the reviewer model and effort.
`scope` snapshots the tree as a git tree object, lists and classifies the changed files, groups them, and picks the mode (full or incremental from a
per-branch state file). `merge` checks that every file was covered, resolves each finding's quoted-code anchor to a real line, removes duplicates, works out
the verdict, and writes the merged report and the state file. The callers only dispatch one `backlog-reviewer` per group in a single message and feed the
reports to `merge`. The reviewer config lives in a server-owned `~/.backlog-manager/settings/review.json`, edited in Settings → Shared → Reviewer, and can be
overridden per launch through new request fields that the server turns into `--review-*` trigger flags.

## How the existing system works, per this document

Today `agents/backlog-reviewer.md` is one Opus agent. Orchestrate §7 and execute pr-mode §7 each dispatch it with fixed fields (worktree, branch, base,
item, report path), and it diffs `git diff <base>...<branch>` as a whole. A pinned base-pairing test in `backlog.test.mjs` asserts that diff string. Skill CLIs
end with `process.exitCode = main(...)` behind an `isMain` twin and are listed in `CLI_SOURCES`. Skill tools import nothing from `server/` or `shared/`, so
shared rules are hand-kept twins. The server is the only writer of `settings/*.json` (the timezone/watchdog precedent: GET unguarded, POST behind
`SameOriginPostGuard`). The orchestrate trigger is composed server-side from validated fields in a fixed order, and execute's finish clause is appended
server-side inside backticks. An execute or groom body that spells a finish flag is refused with a 400.

All sections could be paraphrased. No section-level Critical for comprehension.

## Critical

- **plan:361 (with plan:214–217): the second fix-loop re-review uses round-1 findings, not the previous round's.** Task 3 says `--previous <manifest>` reads
  its earlier findings from `<manifest>.findings.json`. Task 4 (plan:252) says `merge` writes that file beside the manifest it was given. Task 7 tells the
  driver to run `scope --previous <first manifest>` on every fix-loop re-review. So the review after the second fix loop (the `<id>-3` pass, which happens
  because two loops are allowed — `skills/backlog-orchestrate/SKILL.md:875–886`) gets round 1's open findings as earlier findings. Any new
  Critical/Important that round 2 raised is lost: it is not handed to a group to mark, so `merge` cannot count it as open. That breaks spec:265–267 ("every
  finding from the previous round is handed to a re-run group") and the anti-goal at spec:62 (approving with a known open finding). `rerun` is also measured
  against round 1's `to`, so groups that only fix 1 touched are re-dispatched again. → Pass the latest manifest to `--previous` (its partition, models and
  efforts are already copied from the first, so the partition stays fixed). Or say that `findings.json` is written beside the first manifest and replaced
  each round. Pin it with a three-round case in the `--previous` test (plan:231–232).

## Important

- **plan:130 (and plan:103–104): "the `CLI_SOURCES` loop picks up `review.mjs` (its existing assertions apply unchanged)" is false.** The loop reads
  `ENTRY_SHAPES[name]` (`skills/backlog/tools/backlog.test.mjs:3447`, `:3459`) and calls `accepted.some(...)`. A `CLI_SOURCES` entry without a matching
  `ENTRY_SHAPES` entry throws a TypeError. → Add `ENTRY_SHAPES['review.mjs'] = ['process.exitCode = main(']` to Task 1's file list and Step 1.
- **plan:355, plan:370: `init` refusing a non-object `--review-config` with exit 2 does not match the tool's exit-code contract.** `orchestrate.mjs` documents
  "1 bad args" (`skills/backlog-orchestrate/tools/orchestrate.mjs:46–47`), and no command in it exits 2. `INIT_USAGE` refusals throw code 1
  (`orchestrate.mjs:3357`). → Use exit 1, or state that a new code 2 is being added to that contract comment, and why.
- **plan:439, plan:442: Task 10 never touches `server/src/agents/agents.controller.ts`.** The controller rebuilds both request bodies field by field
  (`agents.controller.ts:80–105` for dispatch, `:180–205` for orchestrate), so a new `review` field is dropped before `AgentsService` ever sees it. Every
  override would be silently lost. → Add the controller to Task 10's files: forward `review: body.review` (unvalidated, like `mergeMode`) on both routes.
- **plan:402, plan:416: the new server writer is missing from the write-path guard.** `test/server-write-paths.test.ts:26–35` fails on any `server/src` file
  that writes through `writeJsonAtomic` and has no row in `WRITERS`. `review-config.util.ts` would go red in CI. → Add the `WRITERS` row
  (`'settings/review-config.util.ts': [reviewFile({})]`) to Task 9's files and its run list.
- **plan:451–452: a `REVIEW_FLAG` body guard will 400 the untouched default execute prompt when the item's title spells a `--review-…` token.** The default
  prompt quotes the item title. Only `FINISH_FLAG` tokens are defused there (`server/src/agents/prompt.util.ts:31`, `shared/agent.ts:939–949`), which is
  exactly the failure that defuser exists to prevent. Items about this very feature are likely to carry such titles. → Extend `defuseFinishFlags` (or add a
  sibling used in `composePrompt`) to cover `--review-`, and add a dispatch test: an item titled with `--review-model`, default prompt, returns 200.
- **plan:445–453: the mechanism changes in `.claude/rules/dispatch-watchdog.md` are not carried into that rule file.** The file states the composition order
  (ids, mode literals, `--question-mode decide`, `--base`) and the closed list of refused body flags (`--finish`/`--base`/`--auto-merge`/`--fix`). Spec:329
  says `--review-` "joins that rule file's … list". The rule file is the one home of the mechanism (CLAUDE.md "Every `.claude/rules/` file … is the one home
  of its rules' mechanism"). → Add `.claude/rules/dispatch-watchdog.md` (and the matching invariants.md text, if any) to Task 10's files, and run
  `test/claude-rules.test.ts`.
- **plan:492 (with plan:355–356): `reviewerLabel(source.reviewConfig)` is fed an unvalidated run-file value.** `init` checks only "is an object", so `{}` or
  a hand-edited value reaches the client. The server passes run-file fields through only after a degrade-don't-throw sanitize
  (`server/src/orchestrator/orchestrator.service.ts:28–43`, `sanitizeMergeFields` at `:115`). As specified, `reviewerLabel` dereferences `c.big.model` etc.
  and can throw in Run detail. → State that `reviewerLabel` (or the run-detail model) runs the value through `parseReviewConfig` first and shows
  `Reviewer: default` on `null`. Add a run-detail test with `reviewConfig: {}`.
- **plan:317–321 with plan:392: the fix-loop re-review (`--previous` plus `--carried`) is described only for orchestrate, and execute gets half of it.**
  Procedure.md is called "the only description of dispatch" (plan:317), yet its text has no re-review branch. Task 8 says only "Fix rounds use
  `scope --previous`". With no `--carried`, every `rerun: false` group's files are uncovered, so `merge` returns `incomplete` and execute never pushes after a
  fix. → Put the re-review sequence (scope `--previous`, dispatch the `rerun` groups, pass the others' latest reports as `--carried`) in procedure.md as a
  named mode, and have Tasks 7 and 8 both point to it.
- **plan:317–319: the dispatch list leaves out `item file path` and `outcome: none`.** Each group gets "the five fields, its `group` line, `item checks: yes`
  for group 1 only, its `earlier findings`, `manifest path`". The item path is now optional in the agent (plan:311), so group 1 dispatched as written gets
  `item checks: yes` with no item and silently skips the item checks orchestrate and execute rely on. → Add "`item file path` (when the procedure's `item` is
  set) and `outcome: none` (when `outcome` is `none`)" to the dispatch sentence, and pin `item file path` in the procedure test (plan:335–336).
- **plan:317, plan:323–328: the standalone empty-diff message from the spec is missing.** Spec:132 requires `nothing to review — no changes against <base>`
  with no dispatch and no state write. The procedure "returns that to the caller", but the SKILL.md bullet list never says what the standalone skill prints.
  The no-change incremental sentence, by contrast, is fixed in the tool (plan:209–211). → Add the sentence to Task 6's SKILL.md description, or have `scope`
  print it on stderr the way it prints the no-change line.
- **plan:319–320: the spec requires that the merged report records a model/effort fallback, and the plan gives `merge` no way to know about it.** Spec:291–292
  says the merged report states the fallback. The plan only says "the caller notes it", and `merge` has no flag or input that carries the fact. → Add a
  `merge` input (for example `--fallback <n>:<field>`) that writes a line into the merged report, or note in the plan that this is a deliberate deviation.
- **plan:34–35, plan:201, plan:253: nothing tells the tests to isolate the state home and settings file.** `scripts/test-tmpdir.mjs` points only `TMPDIR` at
  a private root. `HOME` is untouched, so any `scope`/`merge` test without `--state` or `BM_REVIEW_HOME` reads and writes the developer's real
  `~/.backlog-manager/reviews/`. Any test without `BM_REVIEW_FILE` reads the real `review.json`, which makes the Task 2 per-group-model expectations depend on
  the machine. → Make it a Global Constraint: every spawned `review.mjs` gets `BM_REVIEW_HOME` and `BM_REVIEW_FILE` under the test's temp dir. This follows
  how `orchestrate.test.mjs` uses `BM_ORCH_HOME`.
- **plan:107, plan:116, plan:356: what `scope`/`config` do with an invalid `--review-config` JSON is never specified.** Invalid flags exit 2, and an invalid
  `review.json` falls back to defaults with a warning. `--review-config` is neither, and Task 7 relies on "`scope` validates it". → State the behaviour
  (presumably exit 2 naming `--review-config`, nothing written) and add it to Task 1's "an invalid flag exits 2" case.
- **plan:328: "under autopilot the offer is a gate" uses a term the repo never defines.** "autopilot" appears nowhere in `skills/`, `agents/`, CLAUDE.md,
  `.claude/rules/` or `docs/subsystems/`, so the skill has no observable signal to detect it. → Name the signal (for example a `[backlog-tick]` or
  `[orchestrator-run` marker, or "AskUserQuestion unavailable"), or drop the clause.

## Minor

- plan:349, plan:371: "RULES ≈753" / "add … to the existing entry" — the `check-failures.md` entry lives in `RARE_PATH_REFERENCES`
  (`orchestrate-prompts.test.mjs:753–757`), not in a `RULES` list. The `RULES` list for the procedure needle is the one at `:516`. Name both arrays.
- plan:104: making the run-as-main count ten means adding a `ROWS` entry (`scripts/run-as-main.test.mjs:26–37`, since `NINE` is derived from `ROWS`), which
  needs `args`/`status`/`output` for an unknown subcommand. The plan never states `review.mjs`'s unknown-command exit code or text.
- plan:107 and plan:129: "precedence `--review-config` JSON > flags" contradicts "flags and `--review-config` together → error", and the test is named
  "`--review-config JSON beats flags is an error`". Drop the precedence wording.
- plan:181: "2 files totalling 1201 lines → >1 group unless one file alone is over the cap". With a 10-file/800-line cap, every split of 1201 lines into two
  separate files gives two groups, so the exception never fires unless the two files are a test/source pair. Say "unless the two are a pair".
- plan:172: `git status --porcelain` run before and after can itself rewrite `.git/index` (racy-git refresh), so the byte-equality check can flake. Read the
  index bytes before any `git status`, or run status with `GIT_OPTIONAL_LOCKS=0`.
- plan:144: how a group's `label` is derived is never stated (the bucket key? the first path?).
- plan:320: `<report>.retry.md`. With `<report>` = `<id>-<k>.md` this reads `<id>-<k>.md.retry.md`, while spec:55 says `<id>-<k>.retry.md`. Spell the
  stripped form, and do the same for `.g<n>.md`.
- plan:323: the `<n>` in `<branch>-<n>.md` (standalone report path) is undefined (next free integer?), as are the branch-name escaping and the detached-HEAD
  name.
- plan:202: `git rev-parse --git-common-dir` prints a relative `.git` in a main checkout. Say `--path-format=absolute` or "resolved".
- plan:308–315: the agent file has other `<base>`/`<branch>` sites the plan does not mention: the helper block `log --oneline <base>..<branch>` and
  `diff <base>...<branch> -- <path>` (`agents/backlog-reviewer.md:108–112`), and "The main tree is not yours to look at" in the `worktree` bullet (`:66`).
  Once `branch` leaves the required fields these lines reference an undefined input.
- plan:357–361: the plan does not say how a resumed driver reads `reviewConfig` from the run file. `status --json` prints the whole run
  (`orchestrate.mjs:5283`); name it.
- plan:360: Task 7 does not say that orchestrate passes `--mode full` (it is only implied through "spec §6 Orchestrate row"). Task 8 says it explicitly.
- plan:317, plan:357: nowhere does the plan spell how the three entry points invoke the tool
  (`node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-review/tools/review.mjs"`). `test/skills-plugin-root.test.ts:40` lists the skills whose SKILL.md must call a
  tool that way; adding `backlog-review` there keeps the new skill covered.
- plan:445: the 400 text must name "which member", but `parseReviewConfig` returns only `ReviewConfig | null`, so it cannot say which member failed. Either
  return a reason or relax the text.
- plan:448: "(my call — …)" is authorial voice inside an interface spec; move it to the Self-review notes.
- plan:168: the temp-repo fixtures commit, so they need a git identity (`-c user.name=… -c user.email=…` or the `GIT_AUTHOR_*` env vars) on CI machines that
  have no global config. Worth one sentence.
