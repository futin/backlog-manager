# Plan review 1 — `backlog-orchestrate` PR mode

Reviewed: `docs/superpowers/plans/2026-10-15-orchestrate-pr-mode.md` (252 lines) against `docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md`
and the code in the `orchestrate-pr-mode` worktree. Reviewer: Fable 5.1, fresh session, paths and checklist only. `<doc>` below is the plan unless named.

## Verdict: APPROVE WITH FIXES

No Critical findings. Seven Important ones, each a place where an implementer building from the text as written would either hit a red gate the plan
calls green, or has to guess a fact the plan does not state. All are local edits to the plan; none changes the design.

## Coverage (checklist 1)

Every spec section maps to a task: §1 → Tasks 1, 2, 3 (3.1, 3.10); §2 → Task 3; §3 → Task 7; §4 (steps, Title, Body) → Task 4 and Task 7; §4 *Nothing
merged* → Task 5; §5 → Tasks 1 and 6; §6's eight rows → 2.2/3.5, 3.7, Task 7 (collision), 3.10/4.6, unchanged §9, Task 7 (denied `gh`), 4.8, Task 5;
§7's cases are all present (see Important 7 for the one that cannot pass as written); Rollout and Out of scope → *Not in this plan*.

One spec §8 item has no task: `references/recovery.md`'s abort order-of-operations must say `finish` now runs a branch delete in PR mode (spec:235-236).
Task 7 lists recovery.md for "abort summary line; resume never re-opens a PR" only (plan:233-234). See Important 6.

## Important

1. **plan:56-57, 73-74, 79 — Task 1's green gate cannot be met without a file Task 1 does not modify.** Case 1.8 asserts the Settings picker lists three
   options in `MERGE_MODES` order; Step 4 says "the five suites green". But `client/src/components/settings/SettingsView.tsx:388-391` hand-builds the
   option list (`{ value: 'merge' }, { value: 'branch' }`) and its hint at `:383` restates both modes in prose; it is not `MERGE_MODES`-driven, so
   `settings-view` stays red after Task 1's listed edits. Task 6 lists SettingsView only conditionally ("if its option list is not already
   `MERGE_MODES`-driven", plan:207-208). → Move `SettingsView.tsx` (option list over `MERGE_MODES`, hint rewritten for three modes) into Task 1's
   *Files*, or move case 1.8 to Task 6 and drop `settings-view` from Task 1's suite list. Either way, remove the "if" from Task 6.

2. **plan:87, 94-99 — Task 2's tracker cases (2.1, 2.2, 2.5) need a harness the named suite does not have.** `test/merge-mode.test.ts:1-18` builds one
   files project with `makeProject('alpha', …)` and no marker; it has no fake GitHub client, no token env and no dashboard on `fetch`. A tracker project
   that reaches `spawn` must pass `this.poller.syncOffBlock` (`server/src/agents/agents.service.ts:91`, `poller.service.ts:488-493`), which resolves the
   marker through the poller; the harness that already POSTs `/api/agents/orchestrate` on a github project is `test/tracker-dispatch.test.ts:39-145`
   (`GITHUB_MARKER`, `GITHUB_TOKEN_ENV`, `GithubClient(gh.fetch)`, dashboard on `global.fetch`; see its `:354-355`). → Name that harness: either put 2.1,
   2.2 and 2.5 in `tracker-dispatch.test.ts` beside its orchestrate cases, or state that Task 2 ports its `beforeEach` into `merge-mode.test.ts`.

3. **plan:90-91 — `resolveMergeMode(…, project)` has no stated way to resolve the project's source.** The plan says the service "already imports
   (`resolveSource`)". It does (`agents.service.ts:12`) but never calls it, and `resolveSource(projectPath, known: ReadonlySet<string>)`
   (`server/src/items/sources/resolve.util.ts:72`) needs a `known` set the service does not hold: `KNOWN` is module-private in
   `server/src/tracker/tracker.controller.ts:97`, `ItemsService.known` is private (`items.service.ts:41`), and the poller's only public source-aware
   method is `syncOffBlock` (`poller.service.ts:488`). An implementer must guess between a fourth `KNOWN` copy, a new poller/items method, or exporting
   one. → State the mechanism: e.g. "add `PollerService.sourceKind(projectPath): ResolvedSource['kind']` beside `syncOffBlock` (same `resolveSource(…,
   KNOWN)` call) and have `resolveMergeMode` ask it", and name the test that pins it.

4. **plan:129-130 (case 3.7) — the expected exit `0` is wrong under the existing `pullBaseAtInit`.** The plan orders `init` as pull → queue → exit-4 →
   mint (plan:140-142). With `origin` set to a non-existent path, `pullBaseAtInit` (`orchestrate.mjs:2684-2696`) finds `remote get-url origin` succeeds,
   finds the root holds `main`, runs `git pull --ff-only origin main`, and throws exit `1` — before the mint ever runs. The `ls-remote` fallback is only
   reachable when `origin` is **absent** (the `get-url` early return at `:2685`), which is what `trackerFixture` (`orchestrate.test.mjs:7262-7267`)
   already is. → Rewrite 3.7 as "no `origin` remote (the fixture's default): exit 0, mint from local refs, one stderr line". If the timeout itself is to
   be pinned, it needs a remote that accepts the pull and then stalls `ls-remote`, which a path remote cannot do; otherwise say the timeout is asserted by
   reading the `spawnSync` options, or drop "assert the case finishes under 15 s" (a dead path fails instantly, so the bound proves nothing). Review
   Focus 3 (plan:41) should say the same.

5. **plan:205-207 — the sheet's `source` prop type and what `BoardView` passes do not agree.** Spec §5 types the prop `source: SourceKind`
   (`'files' | 'github'`, `shared/types.ts:65`); the plan has `BoardView` pass `ProjectSummary.source`, whose type is `SourceKind | 'unsupported' |
   null` (`shared/types.ts:388`). `BoardView.tsx:969-985` has `registered` in scope (`projectName(registered, orchestrating)`), so the value is
   reachable, but the narrowing is unspecified and `null`/`'unsupported'` have no stated outcome. → State it: the prop is typed
   `ProjectSummary['source']`, the `pr` option is offered iff `source === 'github'`, and 6.5's "files project" case is joined by one for
   `null`/`'unsupported'` (both: two options, fallback to `merge`).

6. **plan:233-234 — spec §8's recovery.md item is not covered.** Spec:235-236: "`references/recovery.md`'s abort order: `finish` now runs one … delete in
   PR mode". `recovery.md:184-186` ("Run `abort` first … The order is the whole safety property") is the section. Task 7 lists recovery.md for the abort
   summary line and the resume/`prUrl` rule only. → Add "the `--abort` order-of-operations notes that `finish --status aborted` deletes an empty run
   branch (§4 *Nothing merged*)" to Task 7's recovery.md entry. (Note spec:235 says `git branch -d`; spec §4:170-171 and plan:197 say `update-ref -d` —
   the plan follows §4, which is right; the spec author should fix §8.)

7. **plan:170 (case 4.9) — the backtick case has no expected value.** "A title containing `\n`, a backtick, or a leading `## ` renders as one list line:
   newlines collapsed to a space, the line still starting `- `" gives an expectation for the newline and the heading but none for the backtick (escape
   it? leave it? what does the line read?). Review Focus 2 (plan:40) names the backtick as a pinned risk. → State the backtick expectation (e.g. "left
   as-is: a backtick cannot leave a `- ` list line, so the assertion is that the line is unchanged apart from the prefix") or drop it from 4.9 and
   Review Focus 2.

## Minor

- plan:181 and spec:235 — the "pure status write" comment at `orchestrate.mjs:5786` is inside `cmdAbort` (starts `:5713`), not `cmdFinish` (`:4313`).
  The line is right; the attribution is wrong. Say "`cmdAbort`'s comment at `:5786`, which describes `cmdFinish`".
- plan:108-109 — there is no "`merge-mode` exit-1 note in the exit-code contract comment": the contract at `orchestrate.mjs:38-52` lists `1` as "bad args
  / unknown item / unknown stage / missing input" and never names `merge-mode`. The comment that does need the third mode is the `MERGE_MODES` one at
  `:1039-1051` ("`merge` is today's behaviour … `branch` … main is never touched"), which the implementer will be sitting on anyway. Point at that.
- plan:110 — `trackerFixture` is at `orchestrate.test.mjs:7262`; `:7192` is `fakeApi`. Cite `:7192-7267` as "`fakeApi` … `trackerFixture`" or just
  `:7262`.
- plan:122 (3.4, bare-origin case) — once the fixture gains an `origin`, `pullBaseAtInit` runs `git pull --ff-only origin main` (`:2689`) and fails on a
  bare repo with no `main`. The case must push `main` into the bare origin before `init`. A one-line setup note saves a red-then-debug round.
- plan:230 — SKILL.md's sentence is "Stopping the run is `finish --status failed` after parking this item." (`SKILL.md:745-746`); the plan quotes it
  truncated. Fine, but cite the line.
- plan:238-239 — there is no "`git -C "$PWD"` allowlist" test by that name; the SKILL.md text guards are the fenced-command assertions at
  `orchestrate.test.mjs:3916-3958`. Say "the §9 fenced-command guards at `:3916-3958`".
- plan:80 — Task 1's interim-gap note names only the sheet. The other gap: after Task 1, `resolveMergeMode` accepts `pr` (`isMergeMode` is the guard) and
  the prompt at `agents.service.ts:749` appends nothing for it, so a `pr` request spawns a plain `merge` run until Task 2 (spec:47-49 says exactly
  this). Name both gaps in one sentence.
- plan:215-221 — Task 6's cases are numbered 6.2, 6.4–6.8; 6.1 and 6.3 are missing. Renumber.
- plan:244 — `docs/workflows/ci.md:50-54` currently says "Phase B's `--pr` mode"; Task 7 should say that wording becomes the `pr` merge mode (there is no
  `--pr` flag, spec P1 rejected it).
- plan:27 — `[\w.-]+` for the owner segment is looser than GitHub's owner rules (no `.`), harmless for a `pull/\d+` URL from `gh`; no change needed.
- Review Focus 5 / case 3.12 — `merge-check` outcome 2 is at `orchestrate.mjs:3673-3705` (`_base-` prefix, `created = true`); the case needs an item
  staged to `merging` with a branch and worktree, which the existing merge-check fixtures already build. Worth a pointer to one of them.

## What was verified and is right

- `MERGE_MODES` lives at `shared/types.ts:729` and `orchestrate.mjs:1052`; `isMergeMode` at `shared/agent.ts:47`; `sanitizeMergeFields` at
  `orchestrator.service.ts:109-117` resolves `base` once, as the plan says; `remote-runs.util.ts:365-368` is the one field-by-field run literal.
- `mergeModeOptionLabels` returns `Record<MergeMode, string>` (`merge-mode.ts:38`), so Task 1 is the right home for the `pr` label; `mergeModeLabel`
  (`run-stage.ts:190-193`) returns `null` unless effective is `branch`, so 6.2's three values are the right pins.
- `agents-shared.test.ts:152` and `settings-view.test.tsx:459` are the two red-until-classified assertions the spec names; `merge-mode.test.ts:168-179`
  holds the `--merge-mode branch` prompt cases; the prompt order at `agents.service.ts:749-766` is merge-mode, question-mode, base, as 2.1 says; the lock
  wins over `resolveMergeMode` (`:712-719`), as 2.5 says.
- `cmdInit`'s existing order (pull `:2855`, queue `:2873`, exit-4 `:2935`, run file `:3025`) is the order the plan inserts the mint into.
- `cmdMergeMode` allows only `merge → branch` once (`:3434`); `stage merged` refusal is tied to `mergeModeEffective === 'branch'` (`:3197`);
  `cmdAbort` ends through `cmdFinish` (`:5713` comment at its `:248`); `FINISH_STATUSES` takes `aborted`/`failed`/`paused`/`done`.
- `archiveSidecars` is a denylist (`run.json`, `runs/` — `:2257-2258`), so Task 4's new `<dir>/pr/` is archived with the run without a code change.
- The claim route builds its 400 from `MERGE_MODES` (`items-write.controller.ts:411-412`), so Rollout step 2's "rebuild before `plugin:sync`" is right.
- `.claude/rules/orchestrator.md:24` (push bullet) and `:75` (merge-mode bullet) exist; `docs/workflows/ci.md:46` is §The ruleset;
  `references/tracker.md:199` is *Hard limits — the three pushes* and `:173` the "`--resume` pulls and pushes again" sentence Task 7 must qualify.
- `test/claude-rules.test.ts:323-349` pins exactly what Task 7 Step 2 claims (anchored once, one home, headline byte-equal).
- The plan's own convention (behaviour and cases, no literal code; soft budgets; 160 columns) is followed throughout.
