## Verdict: REVISE

Document: `docs/superpowers/specs/2026-11-12-reviewer-coverage-anchors-groups-design.md` (cited below as `spec:<line>`), at `bf0e3367`.

## What this proposes

A new `/backlog-review` skill runs the existing `backlog-reviewer` agent on any checkout, uncommitted and untracked work included, and by default re-reviews
only what changed since the last review of the branch. A deterministic tool, `review.mjs`, snapshots the tree, decides which files are reviewed or skipped,
splits a large diff into groups that are each reviewed by their own dispatch, checks that every file was covered, resolves each finding's quoted line to a
real line number, and merges the group reports into one report and one verdict. Orchestrate §7 and execute pr-mode §7 switch to the same procedure. The
reviewer's model and effort per group come from a server-written settings file, editable on Settings › Shared and overridable per launch. A standalone run
offers to fix the findings in the same session and commits nothing.

## How the existing system works, per this document

Today the reviewer is one Opus agent, dispatched only from orchestrate §7 and execute pr-mode §7, that reads `git diff <base>...<branch>` whole, writes its
report outside the repo and returns a verdict plus one line per Critical/Important finding. Orchestrate keeps reports at `<dir>/reviews/<id>-<k>.md`, names
that path in the merge commit, and `backlog-retro` parses those files by name, `verdict:` line and the Critical/Important headings. Both flows allow two fix
loops. Agents and skills reach a running Claude Code only after commit, push and `pnpm run plugin:sync`; a sub-agent cannot dispatch sub-agents; settings
files under `~/.backlog-manager/settings/` have the server as their only writer.

All sections could be paraphrased.

## Critical

### C1. A zero-reviewable increment approves a branch that still has open earlier findings

`spec:126-127`: when every file in the diff is skipped and there is no item, "no dispatch and verdict `approve`". Nothing limits this to full mode. In an
incremental review that state file can hold open Critical/Important findings. Example: a review returns `fix`; the next commit changes only a lockfile; the
user runs `/backlog-review` again. Per `spec:126-127` nobody is dispatched and the verdict is `approve`.

That contradicts four other lines:

- `spec:62` (anti-goal): an incremental review must not approve a branch with a known open finding.
- `spec:153`: group 1 is "always dispatched" and owns unanchored and out-of-increment findings.
- `spec:155-156`: `approve` only when every earlier finding is marked resolved; an unmarked finding stays open.
- `spec:174`: `fix` if any earlier finding is still open.

It is also undefined whether `merge` runs in this case, and so whether the state file is rewritten and the open findings survive in it.

Suggested fix: in `spec:126-127`, say that the no-dispatch `approve` holds only when there are no open earlier findings; otherwise group 1 is dispatched to
mark them (or, with no dispatch, the verdict is computed from the still-open list and stays `fix`).

## Important

### I1. The fix-loop re-review has no tool interface, and two `merge` rules contradict it

`spec:241-245` says a re-review re-runs only the touched groups plus group 1, keeps the groups of the first `scope`, puts a new file into group 1, and
computes the verdict "never from a carried report's verdict line". The tool as specified cannot do that:

- `scope` (`spec:98`) has no input for an earlier manifest, so it cannot keep the first partition. But `scope` must run again, because the first manifest's
  `to` is the pre-fix tree and every diff and anchor is taken against `to` (`spec:108`, `spec:166`).
- Who decides which groups the fix touched is not stated. `spec:42` rules out an LLM for scoping.
- `merge` requires every `review` file to be listed in its group's report (`spec:165`). A group that was not re-run has no new report. If its old report is
  passed, `spec:174` ("`fix` if any group says `fix`") brings back the carried verdict that `spec:244-245` forbids. If it is not passed, its files are
  uncovered and the review fails.
- Where the previous round's findings come from (state file or previous merged report) is not stated.

Suggested fix: give `scope` a `--previous <manifest>` input that keeps the partition and prints the groups to re-run, and say how `merge` takes carried
reports (coverage only, verdict line ignored).

### I2. Acceptance tests still describe the rules review 1 replaced

- `spec:331`: "earlier finding in an untouched file → carried and still open". `spec:151-153` now says a finding is never kept or closed by which files the
  increment touched; `merge` has no such input. The case that exists now is "a finding no report marks stays open" (`spec:156`).
- `spec:328`: "state + same base + resolvable snapshot → incremental" is no longer sufficient. `spec:144-146` also requires an unchanged merge-base and the
  recorded HEAD as an ancestor. The list has no case for `base moved` or `history rewritten`.
- No case for: state file not written on a coverage failure (`spec:140`), `--retry` (`spec:172`), distinct texts kept and unanchored findings not
  de-duplicated (`spec:170-171`), the `minor` count (`spec:178`), the three edge inputs (`spec:124-129`).

### I3. How the reviewer flags reach an execute dispatch is not stated

`spec:298-302` appends the flags "to the spawned trigger" and gives their order relative to `ids`, the mode flags and `--base`. That is the orchestrate
composition. An execute dispatch has no such trigger: its prompt is the sheet's text, and the only server-composed part is the finish clause, a sentence in
which flags count only inside the backticks (`skills/backlog-execute/references/pr-mode.md:38-47`, `server/src/agents/agents.service.ts:414`). The spec does
not say whether the `--review-*` flags join that clause, in what order, or with what sentence. `.claude/rules/dispatch-watchdog.md:58-61` enumerates exactly
what dispatch appends, so this needs a stated rule.

### I4. Who resolves the effective config for the orchestrate run file is not stated

`spec:305` says that with no flags `review.mjs` reads `review.json`. `spec:307` says `orchestrate.mjs init` records the effective config. `init` runs before
any `scope`, so `init` must read and validate `review.json` and the flags itself. A skill tool imports nothing from another skill's `tools/` and a shared
rule is a twin whose comment names the original, pinned by a test (`.claude/rules/skills.md:24-26`, `:61-62`). The spec names no twin, no pin, and does not
say that the driver then passes the recorded config to `scope` through `--review-config` (`spec:98`).

### I5. `merge`'s verdict on a coverage failure is undefined, and retro reads it

`spec:178` puts `verdict` and `uncovered` in one stdout line; `spec:218` says no verdict is claimed. `spec:238` says the merged report is still written at
the canonical path, where `skills/backlog-retro/tools/lib/reviews.mjs:24` and `:60` read its first `verdict:` line. The value `merge` prints and writes when
`uncovered` is non-empty is not given.

### I6. The empty-diff park uses a detail that points at a report that does not exist

`spec:124-125` handles an empty diff in orchestrate "like a coverage failure". The only detail given is the fixed text at `spec:234-235`, "review incomplete
— uncovered files are listed in the merged review report". With an empty diff there are no uncovered files and `merge` never ran. On a tracker project that
text is posted on the issue (`skills/backlog-orchestrate/SKILL.md:418`). Give the empty-diff case its own fixed words.

### I7. Failures of the calls the procedure makes are not covered

- A group dispatch that ends without writing its report file: `merge --reports` gets a missing or unparseable file. Presumably all its files are uncovered,
  but `spec:165` does not say so.
- Standalone: `--base` or the fallback `main` does not resolve to a ref (`spec:209`). pr-mode stops on this (`pr-mode.md:54-55`).
- Standalone with `<id>`: the id is not found, or the project is a tracker and the stack is down (`backlog.mjs` exit `5`, `.claude/rules/skills.md:65`)
  (`spec:211-212`).

### I8. Two user-facing strings are missing

- `spec:124` prints `nothing to review` for an empty diff; `spec:149` says an incremental scope with no changes "says so" and that the earlier verdict
  stands. Both are `from` equal to `to`. The incremental wording is not given, and whether it repeats the earlier verdict and open findings is not stated.
- `spec:307-309` gives Run detail's text only for an old run file (`Reviewer: default`). The text for a recorded `same` or `split` config is not given.

## Minor

- `spec:336` calls the Settings group "Review"; `spec:289` and `spec:375` name it `Reviewer`.
- `spec:131` says `scope` prints one line with a fixed shape; `spec:146` says the fall-back reason is printed and `spec:216` needs it. Add a `reason` field.
- `spec:295` says "Saving replaces it"; the spec does not say whether the card saves per change (as `TimeZoneGroup` does) or has a Save control.
- `spec:318` "most non-first groups run on Sonnet" is a guess (small is at most 300 lines, a group holds up to 800). Carried from review 1.
- `spec:135` and `spec:215` build file names from `<branch>`, which contains `/` here. Carried from review 1.
- State-file write: no temp file plus rename, no word on two sessions reviewing one branch. Every other tool-owned directory under `~/.backlog-manager`
  states this (`.claude/rules/skills.md:10`, `:23`). Carried from review 1.
- A ninth skill and a new CLI change contract statements the spec does not list: "eight skills" (`CLAUDE.md:3`, `:50`), `CLI_SOURCES` and `ENTRY_SHAPES`
  (`skills/backlog/tools/backlog.test.mjs:3408`, `:3443`), the `RULES` needle for what orchestrate's body keeps (`.claude/rules/skills.md:131-132`), and the
  guarded-route list in `test/agents-origin-guard.test.ts`. `spec:335` ("no other existing assertion changed") should allow these additions.
- `spec:167`: two matches equally near the claimed line, and a quoted line that itself contains ` | `, are not decided.
- `spec:279`: the default `small` = `sonnet` is not in "Calls made by the author" (`spec:351-366`).
- How the client reads `GET /api/settings/review` is not named; board pollers enter through `useRefreshing` (`.claude/rules/board.md:151-155`).
- The Agent tool accepting `effort` and `fable` (`spec:267-269`) cannot be checked from the repo; the stated values equal `shared/agent.ts:210` and `:221`.

## Checked and true

- Reviewer today: five fields, `git -C <worktree> diff <base>...<branch>`, `model: opus`, no effort, "Never review the main tree"
  (`agents/backlog-reviewer.md:11`, `:64`, `:96`, `:231`).
- Orchestrate §7 says "the four fields" and lists `base` as pinned (`skills/backlog-orchestrate/SKILL.md:792-800`); the pairing test is at
  `skills/backlog/tools/backlog.test.mjs:3215-3238` and the kept/rewritten split at `spec:249-251` matches its assertions.
- The `missing or half-present pair` pin (`backlog.test.mjs:3038`) survives the `outcome: none` exception.
- Retro's name pattern, verdict line and section parsing (`reviews.mjs:19`, `:24`, `:36-44`); `.g<n>.md` and `.retry.md` do not match the pattern.
- `Reviewed: approve (reviews/<n>-<k>.md)` (`SKILL.md:1038`); `recovery.md:93` sweeps the `reviews` directory.
- The fixed `--detail` at `spec:234-235` has no placeholder and passes the guard (`orchestrate-prompts.test.mjs:1482-1512`); `<paths>` was removed on
  purpose (`:1485-1488`); `ATTENTION_KINDS` is closed at three (`orchestrate.mjs:4175`).
- `timezone.controller.ts:14-27`: GET unguarded, POST behind `SameOriginPostGuard` with `@HttpCode(200)`. The whole `settings/` directory is mounted
  read-write (`docker-compose.yml:182`).
- Shared page and `TimeZoneGroup` (`SettingsView.tsx:169-189`); pill `this machine` (`TimeZoneGroup.tsx:38`).
- Drop versus reject reasoning in `server/src/agents/orchestrate-args.service.ts:417-422`.
- pr-mode's base rule and tracker item shape (`pr-mode.md:23-30`, `:215-217`).
- `client/src/components/board/orchestrate/` and `client/src/hooks/useOrchestrateDraft.ts` exist.
- Hard rules: no server git write, every route under `/api`, the review skill commits and merges nothing, session-created text stays off command lines.

## Review 1 findings

All fifteen Critical/Important findings of review 1 are addressed in the text. I1 and I2 above are what the C1 fix of review 1 left open in the tool
interface and the acceptance list.

## Rulings

Carry-over: round 1's rulings were all FIX; none re-raised at the same scope.

| id | outcome | evidence |
| --- | --- | --- |
| 2-1 [C] all-skipped no-item approve ignores open earlier findings | FIX | §2 Edge inputs: group 1 dispatched for open earlier findings; `merge` runs with no reports and rewrites state |
| 2-2 [I] fix-loop re-review has no tool interface | FIX | `scope --previous` (partition, rerun marks, earlier findings); `merge --carried` counts for coverage only; §6 says who runs what |
| 2-3 [I] acceptance tests the replaced rule | FIX | Acceptance rewritten to §2–§4: mode-selection reasons, coverage-failure state, `--retry`, `--carried`, de-dup texts, `minor`, edge inputs, `config` |
| 2-4 [I] execute flag placement unstated | FIX | `pr-mode.md:38-47` read; flags inside the finish clause's backticks after `--base`/`--auto-merge --fix`; pr mode only |
| 2-5 [I] `init` would need to read review.json | FIX | `.claude/rules/skills.md` self-contained tools; `review.mjs config` → `init --review-config` (opaque object check) → `scope --review-config` |
| 2-6 [I] verdict on coverage failure undefined | FIX | `verdict: incomplete`; `skills/backlog-retro/tools/lib/reviews.mjs:24,60-75` records any word and excerpts only `fix` |
| 2-7 [I] empty-diff park detail points at missing report | FIX | own fixed words `review not run — the item's committed diff is empty`; failure branch in `references/check-failures.md` per skills.md |
| 2-8 [I] uncovered failure paths | FIX | missing group report → its files uncovered; §5 refusals: unresolved base (`pr-mode.md:54-55`), unknown id, exit 5 |
| 2-9 [I] missing user-facing strings | FIX | incremental no-change line and Run detail `same`/`split` text given |
