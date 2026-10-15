# Review 2 — `backlog-orchestrate` PR mode design

Document: `docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md` at `9afb040` on `docs/orchestrate-pr-mode` (worktree
`.claude/worktrees/orchestrate-pr-mode`). Round 1: `docs/superpowers/reviews/2026-10-15-orchestrate-pr-mode-design-review-1.md`, its fixes in `9afb040`.
Outside source: `claude-agents-dashboard` `ci/phase-a-gate:docs/superpowers/specs/2026-10-15-release-pipeline-design.md`. Reviewer: Fable 5.1, fresh session,
checklist as dispatched. Code references are to this worktree's tree, which is `main` plus the two docs commits.

## Verdict

**APPROVE WITH FIXES.** No Critical findings. Every round-1 fix was checked against the code and lands correctly (list at the end); none of them introduces a
contradiction on its own. Four Important findings remain: one fact about the tool that both rounds missed (the tool keeps its own copy of the merge-mode
vocabulary, so `init` does not accept `pr` "without further change"), one vocabulary slip the round-1 rename introduced (`<base>` in the PR body now means
the target, against the rule the same section just set), one sentence that contradicts the step it sits beside (gh's output is "never passed to a tool
argument", but step 3 passes gh's printed URL to `pr --url`), and one edge the degrade row and the nothing-merged paragraph leave between them (a run that
degrades before any merge has `finish` delete the branch the §10 merge list then names).

## Important

**[I] L41-45 — "Every surface that validates a merge mode against that list accepts `pr` without further change: … `init`'s `--merge-mode` …" is false for
the tool.** `orchestrate.mjs` does not import `shared/types.ts`; it keeps its own `const MERGE_MODES = ['merge', 'branch']`
(`skills/backlog-orchestrate/tools/orchestrate.mjs:1052`, whose comment at `:1040` says it is a deliberate duplicate), and `init` validates against that copy
(`:2784-2785`: `if (!MERGE_MODES.includes(mergeMode)) throw … --merge-mode must be one of …`). `cmdMergeMode`'s target check (`:3423`) and the `INIT_USAGE`
string (`:2707`, `<merge|branch>`) read the same copy. An implementer who follows §1 literally — edit `shared/types.ts`, then the two server sites — ships an
`init` that exits `1` on `--merge-mode pr`; §7's first node case catches it, but the spec names no edit, and §1's "two server sites do need an edit, because
each restates the vocabulary by hand" is the sentence that would have named the third. → Add the tool's copy to the hand-restated sites: `MERGE_MODES` at
`orchestrate.mjs:1052` gains `'pr'`, and `INIT_USAGE` follows. (A node test pinning the tool's copy against the shared one would be the forcing function the
other copies have; §7 may say so.)

**[I] L154 vs L111 — the body template reads "`<runId>` drained onto `<head>` from `<base>`", and L111 has just ruled that `base` "in every SKILL.md command
means the run branch".** `head` IS the run branch, so by the document's own vocabulary the line says "drained onto `backlog/run-…-1` from
`backlog/run-…-1`". The round-1 rename of the JSON key (`base` → `target`) did not reach the body template, and L166's `<prTarget>..<base>` shows the spec
does use `<base>` for the run branch elsewhere in the same section. → Write the template as `drained onto <head> from <target>` (or `<prTarget>`), so one
word keeps one meaning across §4.

**[I] L119-121 vs L113-116 — "`gh`'s output and the classifier's `Reason:` are read and never passed to a tool argument" contradicts steps 2-3, which exist
to pass gh's output to a tool argument.** Step 2 reads `gh pr view <head> --json url --jq .url` (or `gh pr create`'s stdout, which is the PR URL) and step
3 runs `orchestrate.mjs pr --url <url>` with exactly that value. The regex at L116 is the right guard for it, but the sentence as written tells the SKILL.md
author the opposite of the steps, and a driver on turn 300 reading "never" will not know which to obey. → Narrow L120 to gh's FAILURE output (the error
text of a refused or denied `gh pr create`), and say the one value that does travel — the URL — travels only through `pr --url`'s pattern.

**[I] L165-169 with L194-195 — a PR run that degrades before any merge has `finish` delete the run branch, and §10's merge list then names it.** Sequence:
§2's probe is denied → `merge-mode branch` → every item ends `branched`, cut from `<base>` = the run branch at the target's tip (§6 row 4) → nothing
`merged`, so no PR → `finish` sees `rev-list --count <prTarget>..<base>` = `0` and deletes the local run branch → the driver then "summarise[s] … from
`status --json`" (`skills/backlog-orchestrate/SKILL.md:1115-1117`) and §10's "Any item that finished `branched` owes the user a merge list … say which branch to
run it on when the base is not `main`" (`SKILL.md:1121-1124`) names `<base>`, the branch `finish` just removed. Row 4's fix ("merged only after the PR lands,
rebased onto `<prTarget>`") assumes a PR exists and does not cover this case; the *Nothing merged* paragraph does not mention branched items. The branches are
harmless (their refs survive the delete and they sit at the target's tip), only the instruction is wrong. → One sentence in *Nothing merged*: when no PR is
opened, the merge list names `<prTarget>` as the branch to run it on, because every branched item was cut from its tip and the run branch is gone (or defer
the delete until after the summary; the spec picks).

## Minor

- L94 — the hard limit is "exactly three commands", not "three push commands": `pull --ff-only`, `push origin <base>`, `push -u origin backlog/<n>`
  (`SKILL.md:1205-1207`, `references/tracker.md:201`, `.claude/rules/orchestrator.md:26-28`). `gh pr create` is a fourth remote-writing command under that
  bullet, and §8 names only `orchestrator.md`'s push bullet as the doc that moves; the SKILL.md hard-limit bullet and `tracker.md:201` restate it and need
  the same clause.
- L173-174 — "offered only when the selected project's `ProjectSummary.source` is `github`": the sheet's prop is `project: string`
  (`client/src/components/board/OrchestrateSheet.tsx:127`) and it holds no summary; `BoardView.tsx:969-985` passes `project`, `projectName`, `items`. Name
  the new prop (`source: SourceKind`, from `registered`) so the implementer does not read it off `items[0].source`, which is empty on an empty queue.
- L180 — `mergeModeLabel` lives in `client/src/lib/run-stage.ts:190-192`, not `merge-mode.ts`, and today returns `null` for every non-`branch` effective
  mode; worth naming the file beside the `merge-mode.ts` reference at L220 so the two edits are not looked for in one place.
- L230-233 — `test/claude-rules.test.ts` requires each rules bullet anchored exactly once and its headline byte-equal with CLAUDE.md. L230 extends the
  EXISTING merge-mode bullet (`orchestrator.md:75`), L232 adds a NEW invariants anchor with a matching CLAUDE.md headline. A new anchor needs a new rules
  bullet of its own; say whether one is added or the existing bullet's anchor is kept and the new section is reached from it.
- L101-104 — "for an aborted run the summary … gives the exact `gh pr create` line": the title and body file come only from `pr-draft`, which refuses on
  status nowhere (L111 checks `mergeMode`, a `merged` item and `prUrl`). Say the aborted path runs `pr-draft` for that line (it writes only under `<dir>`,
  so it is not the publish step L103 keeps out of `recovery.md`), or the line cannot be "exact".
- L165-169 — `git branch -d` also refuses when the project root's HEAD does not contain the target's tip (the root has some other branch checked out, the
  run branch has no upstream to be checked against). The "stderr line, keep, never fail" rule covers it; the sentence names only the `_base-` tree as the
  cause, so a reader may think the count-0 check makes the delete certain.
- L113 — `gh pr view <head>` resolves the branch against the repo it runs in; say "from the project root", as step 2's `create` does.
- L26 — "the one files project here (`finance-manager`)": true today (`~/.backlog-manager/registry.json`, seven projects, six with `source.json`); fine.

## Round-1 fixes, verified

- L10-11, L26: seven registered projects, six tracker, `finance-manager` files — matches the registry. ✓
- L47-50: `agents.service.ts:749` appends only for `'branch'`; `:1805` hard-codes "merge or branch"; no test pins that text (`grep` over `test/`). ✓
- L52, L55: `cmdMergeMode` allows only `merge → branch` (`orchestrate.mjs:3432`); `stage merged` refused only on effective `branch` (`:3197`). ✓
- L57-58: `resolveSource` is already imported in `agents.service.ts:12`; `init` reads `projectSource(project)` at `:2854`. ✓
- L67, L70-72: gate at `:2871` reads `base`; exit-4 check at `:2934-2938`; both precede the run-file write. ✓
- L80-81: `ITEM_ID_SHAPE = /^[a-z]+-\d+$/` (`shared/agent.ts:586`); sections are `bugs/ideas/tasks/refactors(ref)/out-of-scope` (`backlog.mjs:37`). ✓
- L87-92: §4 pull is `SKILL.md:452`, tracker-only, parks on non-zero; §2 probe `:269-282` runs in `merge` mode with a tracker shape and is skipped in
  `branch` (`:306`). ✓
- L106-108: `finish --status failed` appears once in SKILL.md (`:746`, §5) and nowhere in `references/`. ✓
- L111-117: `cmdAbort` ends through `cmdFinish(['--status','aborted'])` (`:5988`), so "every finish but `paused`" covers abort; `FINISH_STATUSES` `:4311`. ✓
- L129-130: tracker merge subject `Merge backlog/<n>: <title>` (`SKILL.md:1020`); `--no-ff` at `:1010/:1020`. ✓
- L154, L159: `RunStage`'s terminal members are exactly merged, branched, failed, skipped, needs-answers, ungroomed, parked (`shared/types.ts:800-815`). ✓
- L175-177: hint guards at `OrchestrateSheet.tsx:329` (effect) and `:1184` (render). ✓
- L183-186: `remote-runs.util.ts:365-369` builds the run literal field by field; `cmdInit` skeleton `:2991-3013`. ✓
- L219-220: `test/agents-shared.test.ts:152`, `test/settings-view.test.tsx:459`, `client/src/lib/merge-mode.ts` `Record<MergeMode, string>`. ✓
- L225: `cmdFinish` is a pure status write (`:4313-4330`); the "pure status write" comment is at `:5786`. ✓
- L244-245: claim route 400 text `run.mergeMode must be one of ${MERGE_MODES.join(', ')}` (`items-write.controller.ts:412`). ✓
- Release spec: D8 (L36), D9 (L37), three contexts (L56-58), `pr-title` regex with `!` only on `feat|fix|perf` (L51), squash-only + `PR_BODY` + delete head
  branch (L69-70), Phase B's `backlog-orchestrate` paragraph (L89-92: "at the end pushes the branch", which P2 names as a deliberate deviation), `## What's new`
  taken verbatim up to `^## ` (L146, L155). ✓ The release spec writes the title summary as "<N> items"; this spec's singular `1 item` is a harmless refinement.
- §7 feasibility: `orchestrate.test.mjs:7262` has `trackerFixture` with a stub API on `127.0.0.1` (`:7192-7226`), so the tracker-fixture node cases are
  buildable. ✓
