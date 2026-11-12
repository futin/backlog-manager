## Verdict: REVISE

Document: `docs/superpowers/specs/2026-11-12-reviewer-coverage-anchors-groups-design.md` (cited below as `spec:<line>`), at `87d2ef91`.

## What this proposes

A new `/backlog-review` skill that runs the existing `backlog-reviewer` agent on any checkout, including uncommitted and untracked work, and by default
re-reviews only what changed since the last review of the branch. A deterministic tool, `review.mjs`, decides which files must be reviewed, splits a large
diff into groups that are each reviewed by a separate dispatch, checks that every file was covered, resolves each finding's quoted code line to a real line
number, and merges the group reports into one report and one verdict. Orchestrate §7 and execute `--finish pr` §7 switch to the same procedure and tool. The
reviewer's model and effort per group come from a server-side settings file, editable in Settings and overridable per launch. A standalone run offers to fix
the findings in the same session and commits nothing.

## How the existing system works, per this document

Today the reviewer is one Opus agent dispatched only from orchestrate §7 and execute pr-mode §7. It reads `git diff <base>...<branch>` whole, writes a full
report to a path outside the repo and returns a verdict plus one line per Critical/Important finding. Orchestrate keeps its reports at
`<dir>/reviews/<id>-<k>.md` and names that path in the merge commit; both flows allow two fix loops. Agents and skills reach a running Claude Code only after
commit, push and `pnpm run plugin:sync`; a sub-agent cannot dispatch sub-agents; server-owned settings files under `~/.backlog-manager/settings/` have the
server as their only writer.

All sections could be paraphrased.

## Critical

### C1. A finding whose fix lands in a different file can never be closed — in orchestrate that parks a correctly fixed item

`spec:211-214` re-runs only the groups whose files the fix changed (plus group 1) and carries the other groups' reports into `merge` unchanged, "their
findings still count". `spec:153` makes the verdict `fix` if any group says `fix`. So a carried-forward report that said `fix` in round 1 says `fix` in
round 2 no matter what the fix did.

That is wrong whenever the fix is not in the finding's own group:

- Group 2 raises "no test pins this behaviour" anchored in `foo.mjs`. The fix adds `bar.test.mjs`, a file outside the first manifest, which joins group 1
  (`spec:212`). Group 2 is not re-run and its report still says `fix`.
- Group 3 raises a finding about a file group 1 owns, or about a file the diff never touched (`spec:166-168` allows both). The fix changes that file;
  group 3 is not re-run.

Both fix loops are spent and the item goes to the exhausted-loop path, although the defect is fixed.

The standalone incremental mode has the same rule at `spec:134-137` ("each open finding whose anchored file the incremental diff does not touch is carried
forward unchanged and still open"). There `full` is an escape; in orchestrate there is none, because `spec:202` fixes the mode.

Three cases the rule does not cover at all:

- a finding with no file to anchor to (a `## Plan` promise not kept, a missing `Contract sweep:` line);
- a finding anchored in a file that is now deleted, so it is `skip: deleted` (`spec:110`) and no group owns it;
- a finding anchored in a file outside the manifest that the next diff does touch.

Suggested fix: on a re-review, hand every still-open earlier finding to a reviewer for a `resolved`/`open` mark — the owning group if it is re-run,
otherwise group 1 — and compute the verdict from those marks, not from a carried report's old verdict line. State who judges unanchored, item-level and
deleted-file findings.

### C2. "Existing tests pass unchanged, including the `base` pairing test" contradicts the changes the same document requires

`spec:215-216` and `spec:271` say the base-pairing test keeps passing unchanged. That test is
`skills/backlog/tools/backlog.test.mjs:3215-3238` (not an orchestrate suite), and it asserts four things the spec changes:

| Assertion | Line | Spec change that breaks it |
| --- | --- | --- |
| orchestrate SKILL.md contains ``- `base` — this run's base branch`` | `backlog.test.mjs:3219` | `spec:215` replaces §7's dispatch text with the procedure |
| reviewer contains `git -C <worktree> diff <base>...<branch>` | `backlog.test.mjs:3224` | `spec:105` — every diff is `diff <from> <to>`, "three dots no longer apply" |
| reviewer says `Five fields, always` | `backlog.test.mjs:3236` | `spec:163-165` — item file path optional, four new optional inputs |
| reviewer says `If any of the five is missing` | `backlog.test.mjs:3237` | same |

The builder must either leave the pinned strings in place beside text that contradicts them, or change the test and break the acceptance line.

Suggested fix: name the test by file, say which assertions are retired or rewritten, and state what replaces the guard (the pairing it protects — the
reviewer never diffing against a literal `main` — still needs a pin, now on `from`/`to`).

### C3. The coverage-failure park puts diff file names on a shell command line, which the skill's own rule and guard forbid

`spec:206-207` gives the command `attention <id> --kind parked --detail "review incomplete — not covered: <paths>"`.

- `skills/backlog-orchestrate/SKILL.md:642` and `:651-655`: prose the run did not compose never rides a command line, and `--detail` takes "the driver's
  own short words … a pointer plus a sentence". The uncovered paths are file names a headless execute session created; a name carrying a backtick or
  `$(…)` executes inside that double-quoted argument.
- `skills/backlog-orchestrate/tools/orchestrate-prompts.test.mjs:1476-1512` is the closed list of placeholders allowed in a `--detail` value. `<paths>` is
  not on it, and the comment at `:1485-1488` records that it was deliberately removed. The guard at `:1523` goes red on the template as written, which
  also contradicts `spec:271`.

Suggested fix: fixed words plus a pointer, for example `--detail "review incomplete — files not covered, see <dir>/reviews/<id>-<k>.md"`, with the uncovered
list in the merged report only.

## Important

### I1. Three different rules for an invalid reviewer value, and the cited file says two of them are opposites

- `spec:231-232`: an unrecognised value "falls through to the default, as dispatch `model`/`effort` already do".
- `spec:243`: the server validates the launch override "as `resolveMergeMode` validates merge mode" — which is a 400
  (`server/src/agents/orchestrate-args.service.ts:447-469`).
- `spec:269`: the settings route "rejects an invalid config".

The comment at `server/src/agents/orchestrate-args.service.ts:417-422` states that `resolveMergeMode` is deliberately not `pickFrom`'s drop-on-unknown
rule. Suggested fix: say per surface (settings route, launch request, trigger flag, `review.json` read by the tool) whether an invalid value is dropped or
refused, and with what status.

### I2. `smallMaxLines` is not a compile-time literal, and the flags' place in the composed prompt is not stated

`spec:243` says the server "appends compile-time-literal flags to the spawned trigger". The line threshold is a caller-supplied number. The dispatch rule
(`.claude/rules/dispatch-watchdog.md`, "The orchestrate and Jira spawn prompts are composed server-side") enumerates what a caller can influence, in order,
with ids first, and separates literals from proved values. Missing: the threshold's bounds (zero, negative, non-integer, maximum), how it is proved, where
the reviewer flags sit relative to `ids` and `--base`, and — for an execute dispatch, whose prompt is taken outright — whether a body spelling a
`--review-*` flag is a 400 as `--finish`/`--base`/`--auto-merge`/`--fix` are.

### I3. The stated readers of the canonical report path are not the ones in the code

`spec:52-53` says "the board and `references/recovery.md` read `<dir>/reviews/<id>-<k>.md`".

- `skills/backlog-orchestrate/references/recovery.md:93` only names `<dir>/reviews` as a directory a later run sweeps; it reads no report.
- `server/src/orchestrator/orchestrator.service.ts:165` mentions `reviews/` in a comment only; I found no board read of a report file.
- The reader that does parse these files is not mentioned: `skills/backlog-retro/tools/lib/reviews.mjs:19` (`REVIEW_NAME`), which also reads the report's
  section headings (`:38-43`).

The conclusion (keep the path) holds, and `<id>-<k>.g<n>.md` does not match `REVIEW_NAME`, so group reports are ignored. Suggested fix: correct the reader
list, and state that the merged report keeps the headings retro parses and that the added sections do not break it.

### I4. Whether a coverage failure writes the state file is not stated

`spec:127` says `merge` writes the state file "at the end of every review". `spec:89` and `spec:190` define a review that ends as a coverage failure with
no verdict. If that run records its `to` snapshot, the next incremental review starts from it and the uncovered files are never reviewed. Suggested fix:
state that a review with uncovered files does not advance the snapshot.

### I5. "Its `base` matches" does not protect an incremental review after a rebase or a merge of the base

`spec:130-131` picks incremental when the state's `base` matches and its snapshot resolves. If `base` is compared by name, then after `git merge <base>`
or a rebase the diff from the old snapshot to the new one contains everything the base brought — other people's work, the fault
`agents/backlog-reviewer.md:99-104` exists to prevent. A branch deleted and re-created under the same name within the prune window is the same case.
Suggested fix: record the merge-base commit in the state and fall back to `full` (reason printed) when it changed, or when the old snapshot's commit is
not an ancestor of HEAD.

### I6. De-duplication by quoted text can drop a distinct finding

`spec:151` collapses findings that share path plus quoted line. Two different defects anchored to lines with identical text in one file (`});`,
`return null;`) collapse into one and the other's description is lost; so are two different defects on the same line. Suggested fix: key on the resolved
`path:line`, and keep both descriptions when the texts differ.

### I7. The offer to fix depends on Minor findings the session is never told about

`spec:191-192` offers a fix "when the verdict is `fix` or there are Minor findings" and offers "fix all including Minor". `spec:157-158` defines stdout —
"the only thing a caller reads into context" — as a JSON line with no Minor count plus Critical/Important lines only. Suggested fix: add a `minor` count
to the stdout JSON, and say that a "fix all" choice is the one case where the session reads the report's Minor section.

### I8. Empty and oversized inputs to `scope` are undefined

- Zero reviewable files in full mode (the diff is only a lockfile, or only the item file), and a full diff with no changes at all: `spec:132` covers
  only the incremental no-change case. Is it zero groups, is anyone dispatched, what is the verdict, do item checks still run?
- One file, or one unsplittable test/source pair, above the cap of 10 files / 800 lines (`spec:113-117`).
- The coverage retry (`spec:89`): which model and effort, the retry report's file name, and how `merge` takes two reports for one group.

### I9. The Settings group has no copy, no page, and a scope word the repo does not use

`spec:238-240` adds a Settings "Review" group "marked per-server". No row name, hint, option label or picker label is given, and the page is not named.
The repo's rule (`.claude/rules/board.md`, "Settings is three pages, the page is the scope") gives each card the pill `this browser` or `this machine`
(`client/src/components/settings/SettingsView.tsx:153`); "per-server" is neither. Also missing for the route: the POST guard, and what a save does when
`review.json` exists but cannot be parsed (`dashboards.json` refuses to replace such a file; `tick.json` refuses to default).

### I10. The Agent tool taking `effort` and `fable` is asserted, not shown

`spec:222` and `spec:230` rely on the Agent tool accepting `model` and `effort` per dispatch, with `fable` among the models. Nothing in the repo passes
either to an agent dispatch today — `agents/backlog-reviewer.md:11` sets `model: opus` in frontmatter only — so the code cannot confirm it. The list
matches `shared/agent.ts:210` and `:221`, but those are the dashboard's spawn lists, not the Agent tool's. Suggested fix: confirm it against the installed
Claude Code and say what happens to the effort half if it is not supported.

### I11. A standalone review of a tracker item has no `## Outcome` to check

`spec:185-186` builds the tracker item as "a temp snapshot of the issue body (pr-mode §7's shape)". That shape is the issue body plus `<tmp>/outcome.md`
(`skills/backlog-execute/references/pr-mode.md:215-216`), a file that exists only inside the execute session. In a standalone run it is absent, so check
4 (`agents/backlog-reviewer.md:138-143`) reports a missing `Contract sweep:` / `Red proof:` pair as Important on every such review. The same holds for
any `<id>` whose branch was written by hand. Suggested fix: say where the Outcome comes from, or that check 4 is skipped when none exists.

### I12. Old run files and remote launches are not covered by the config's travel path

`spec:246-247` records the effective config in the run file and shows it in Run detail. Missing: what a run file written before this change shows and
resumes with (compare `sanitizeMergeFields` resolving an absent `base` once, `.claude/rules/orchestrator.md`). `spec:241-243` adds the override to the
launch request; a launch sent to another machine takes `model`/`effort` only from that machine's lists
(`server/src/agents/agents.service.ts:686-687`), and the spec does not say whether the reviewer override follows that rule or which machine's
`review.json` applies.

## Minor

- `spec:231-232` cites `server/src/agents/orchestrate-args.service.ts` for the drop rule; that file only describes it in a comment (`:417-422`). The code
  is `pickFrom` at `server/src/agents/agents.service.ts:686-687` and `:1076-1077`.
- `spec:215` quotes "the four fields" from `skills/backlog-orchestrate/SKILL.md:792`; that text lists five bullets (`:794-800`) and the agent file says
  five. Worth fixing when the text is replaced.
- `spec:123` and `spec:187` build file names from `<branch>`; branch names here contain `/` (`backlog/<id>`, `feat/…`). Left to the builder, but say so.
- State-file writes: no mention of temp file plus rename, or of two sessions reviewing one branch at once. Every other tool-owned file under
  `~/.backlog-manager` states this (`.claude/rules/skills.md`).
- The spec does not list the contract statements a ninth skill changes: "eight skills" in `CLAUDE.md:3` and `:50`, `CLI_SOURCES` in `backlog.test.mjs`
  for the `process.exitCode` rule, and the `RULES` needle for the statement orchestrate's SKILL.md body keeps (`.claude/rules/skills.md`, last bullet).
- `spec:254` "most non-first groups run on Sonnet" is a guess: `small` applies at or below 300 lines and a group can hold 800.
- `spec:67` cites `watchdog.json` and `timezone.json` as precedent for a server-written file a tool reads; neither is read by a tool. `settings/tick.json`
  and the orchestrator-control file are the precedents that fit.

## Checked and true

- `agents` and `skills` are in `PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`, `['skills', '.claude-plugin', 'agents']`).
- Reviewer frontmatter is `model: opus` with no effort (`agents/backlog-reviewer.md:10-11`); the agent has no `Edit`/`Write`.
- Execute pr-mode's base rule is `--base`, else the remote's default branch, else `main` (`pr-mode.md:23-30`); its failure shape is §4 (`:167-171`).
- Orchestrate's report paths and the `Reviewed: approve (reviews/<n>-<k>.md)` merge line (`SKILL.md:800`, `:1038`); two fix loops in both flows.
- `ATTENTION_KINDS` is closed at three and includes `parked` (`orchestrate.mjs:4175`).
- Full mode's `from` (merge base of base and HEAD) diffed to HEAD's tree equals today's three-dot diff.
- Group reports named `<id>-<k>.g<n>.md` do not match retro's `REVIEW_NAME` and are ignored.
- No server git write is introduced; the snapshot is written by the skill tool, not the server.

## Rulings

| id | outcome | evidence |
| --- | --- | --- |
| 1-1 [C] carried reports keep verdict at fix | FIX | §3 and §6: every earlier finding handed to a re-run group (owner else group 1) for a resolved/open mark; verdict computed by `merge` from marks |
| 1-2 [C] base pairing test contradicted | FIX | `skills/backlog/tools/backlog.test.mjs:3216-3238` read; §6 names the test, kept/rewritten/added assertions; reviewer keeps five required fields |
| 1-3 [C] `<paths>` in `--detail` | FIX | `orchestrate-prompts.test.mjs:1476-1488` closed list, SKILL.md:642,651; detail now fixed words, list stays in `## Coverage` |
| 1-4 [I] invalid value rules disagree | FIX | `orchestrate-args.service.ts:417-422`; §7 now states the rule per surface |
| 1-5 [I] smallMaxLines not a literal | FIX | dispatch-watchdog.md:39-47 and :16-18; proved 1–10000, order after ids/modes/base, `--review-` in execute/groom body is a 400 |
| 1-6 [I] reader list wrong | FIX | `skills/backlog-retro/tools/lib/reviews.mjs:19,24` (name regex, `verdict:` line, Critical/Important sections); anti-goal rewritten |
| 1-7 [I] coverage failure advances state | FIX | §3: state written only when coverage complete |
| 1-8 [I] base matched by name only | FIX | §3: recorded merge-base commit + HEAD ancestry check |
| 1-9 [I] de-dup by quoted text | FIX | §4: key on resolved path:line, keep distinct texts, unanchored never merged |
| 1-10 [I] no Minor count on stdout | FIX | §4 stdout gains `minor`; §5 offer keys on it; report's `## Minor` read only on that choice |
| 1-11 [I] undefined scope inputs | FIX | §2 Edge inputs; §4 retry report `.retry.md`, big pair, `--retry` |
| 1-12 [I] Settings copy/page/guard missing | FIX | `SettingsView.tsx:148-156` scopes, pill `this machine` in WatchdogGroup/TickGroup; `timezone.controller.ts` guard pattern; copy given |
| 1-13 [I] Agent tool effort/fable unsourced | FIX | Agent tool schema of the installed Claude Code lists model opus/sonnet/haiku/fable and effort low…max; source and fallback stated |
| 1-14 [I] standalone tracker has no outcome.md | FIX | `pr-mode.md:215-216`, `backlog-reviewer.md:138-143`; `outcome: none` skips check 4 |
| 1-15 [I] old run files, remote launch | FIX | `agents.service.ts:686-687`; §7 items 4–5 |
