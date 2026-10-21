# Review 1 re-check — `docs/superpowers/plans/2026-10-21-execute-pr-mode.md`

Date: 2026-10-21. Reviewer: fresh subagent (Fable), given the diff of the review-1 fixes, the plan, the spec and the repo. Scope: the changed hunks only
(Global Constraints, Review Focus, Task 2 step 1, Task 3 files/interfaces/steps, Task 4 files/tests/interfaces, Task 6 interfaces/behaviour/steps).

## Verdict

**APPROVE WITH FIXES** — no Critical finding. Two Important: one test case the plan does not list breaks on the tenth label, and one stated fact about
`orchestrate.mjs` is false (harmless to the decision it justifies, but false). Everything else checked in the changed hunks is accurate against the code.

## Checked and found correct

- Global Constraints :30-31 — the pr-mode sentence carries backticks around `pr` exactly as the spec writes it (spec :33); `COMMIT_RULE` itself carries
  backticks (`shared/agent.ts:827-830`), so the test "ends with `PR_FINISH_RULE` exactly" is well-formed. `COMMIT_RULE` ends `Do not push.`, so the
  Task 2 negative assertion discriminates.
- Global Constraints :32-33 — `shared/agent.ts:460` (`an orchestrator run is working this item (...)`) and `client/src/lib/item-progress.ts:106`
  (`a session is already working this item (...)`) are both lowercase fragments; the new reason's casing matches its neighbours.
- Task 2 :90 — the comment "The commit rule rides on EVERY action" is at `test/agents-prompt.test.ts:107-113` and does become false.
- Task 3 :104 — `ItemWriter` is implemented by `GithubSource` alone (`server/src/items/sources/github.source.ts:63`); a `files` project is answered
  by `ItemsService.writerFor` (`server/src/items/items.service.ts:325`, `{ kind: 'files' }`) and refused by `writable()` in the controller before any
  writer is reached.
- Task 3 :110 — `server/src/tracker/labels.ts:63` ("The nine, in the order…") and `:95` ("The nine names alone") are the two "nine" sites in that file;
  `test/tracker-poll.test.ts:467` is the "all nine" title, and `LABELS_PRESENT` (`:120`) is derived from `TRACKER_LABELS`, so that case stays green.
- Task 3 :111-112, :116 — no `@HttpCode` anywhere in `items-write.controller.ts`; `test/tracker-write.test.ts:515` pins `201` for `queue`. `201` is right.
- Task 3 :106-107 (unchanged, re-read for :119) — `test/agents-origin-guard.test.ts:92-132` is the one-body-for-every-route block; adding
  `inReview: true` there is the right edit, and the route list (`:134+`) is where the new path joins.
- Task 4 :132-133 — `trackerCandidates` is at `:1918`, `buildGatedQueue` at `:1627`, `applyStaleMarks` at `:1756`; tracker entries DO pass through
  `applyStaleMarks` (`:1640`), so they carry `gate`/`reasons`/`questions` and the "prepend the reason, gate `ungroomed`, no new gate value" shape is the
  one the code already uses (`:1760`).
- Task 4 :135-136 — `test/tracker-dispatch.test.ts` imports `FakeGithub` (`:13`) and has a `dispatch` describe posting `/api/agents/dispatch`
  (`:205-253`); `test/agents-dispatch.test.ts` has no `FakeGithub`, so it is indeed files-only. `test/agents-shared.test.ts` exists.
- Task 6 :183 — orchestrate SKILL.md §541-544 is the exclude paragraph; `WORKTREE_EXCLUDES = ['.worktrees/', 'node_modules']` is at
  `orchestrate.mjs:4176`; `ensureExcludeLines` is exported at `:4260`.
- Task 6 :201 — `executeSection` is defined at `skills/backlog/tools/backlog.test.mjs:3064` and used at `:3095`/`:3116`; it reads
  `EXECUTE_SKILL_MD`, so the new cases need their own path constant for `references/pr-mode.md` (the plan says "reading … pr-mode.md", which is enough).
  `skills/backlog-execute/references/pr-mode.md` does not exist yet (Create is correct), so "FAIL (file absent)" holds.
- Task 6 Interfaces :174-175 — every Consumed name is Produced by an earlier task with the same spelling (`backlog.mjs config` T1, `PR_FINISH_RULE` T2,
  `review <id> on|off` + the reason T4, reviewer inputs T5). Order holds.
- Review Focus :41-43 — now point at a test (Task 6 step 1) rather than a manual check; the test cases named match the two Review Focus items.
- Task 6 :194-197 — each added sentence traces to the spec: rejected push (spec :123), `gh` missing/not authenticated (spec :122), failed label write
  (spec :180), findings' one-line summaries in the PR body (spec :157), PR-title rule (spec :110), "names the PR when it can" (spec :182), heartbeat
  across the review loop (spec :197, left to the builder — the plan pins the 15-minute window, which is the right thing to pin).

## Findings

### Important

- **[I] plan:110 — `test/tracker-poll.test.ts` needs more than a retitled case; one of its label cases asserts the count and the created list.**
  `test/tracker-poll.test.ts:448-463` ("creates exactly orchestrator:queued for a repo that has the earlier eight") builds its fixture as
  `TRACKER_LABELS.filter((l) => l.name !== 'orchestrator:queued')`, asserts `expect(eight).toHaveLength(8)` and expects the POSTed names to
  `toEqual(['orchestrator:queued'])`. With a tenth label both assertions go red: the filter yields nine, and the poller creates `in-review` too. The plan's
  only word on this file is "the title at `test/tracker-poll.test.ts:467` becomes ten" (:110), and the `:467` case is the one that stays green on its own
  (`LABELS_PRESENT` derives from `TRACKER_LABELS`). An implementer reaches Step 4 with an unlisted red case and has to decide how to fix it; the cheap fix
  (drop the exact list) would lose the by-name assertion the case's own comment (`:445-447`) says is the point.
  → In Task 3 step 1, name the case: the "earlier eight" fixture excludes both `orchestrator:queued` and `in-review` (length `8` still holds — or keep the
  exclusion to `queued` and assert `9`), and the created list becomes exactly `['orchestrator:queued', 'in-review']` in `TRACKER_LABELS` order; add or
  retitle a case for a repo bootstrapped before `in-review` existed that creates exactly `['in-review']`. Then the FAIL run in step 2 fails for a stated
  reason.

- **[I] plan:175 — "`orchestrate.mjs` refuses every verb but `init` inside a linked worktree" is false, and it is not why `ensureExcludeLines` is out of
  reach.** `resolveProjectRoot` refuses a linked worktree for every cwd-resolving verb (`orchestrate.mjs:767-768`), and `init` — which takes the project
  path explicitly — refuses one too (`:3068-3069`, `linkedWorktreeInfo(project)` then `refuseLinkedWorktree`). So no verb is exempt. More to the point, a
  `pr`-mode execute usually starts in the MAIN checkout (spec D5: the main checkout gets a new tree), where nothing is refused at all; the real reason the
  exclude step is prose is that no `orchestrate.mjs` verb exposes `ensureExcludeLines` (it is an internal helper called once, from `init`'s worktree
  creation at `:4332`), and `backlog.mjs` importing across skill directories would be a second publish-boundary coupling. The decision (prose) is sound;
  the stated fact is not, and the next person who reads it will go looking for an `init`-only exemption that does not exist.
  → Rewrite :175-176 to: "no `orchestrate.mjs` verb exposes `ensureExcludeLines` (`:4260`, called only by `init` at `:4332`), and every verb — `init`
  included (`:767-768`, `:3068-3069`) — refuses a linked worktree, so the exclude step is prose; that is the decision."

### Minor

- plan:105 — "`items-write.controller.ts:29`" lands on a header-comment line ("here talks to GitHub, holds a token…"); the files gate is `writable()`
  (`:257+`, "The project gate, in one place for all nine") over `ItemsService.writerFor` (`items.service.ts:325`). Cite those.
- plan:184 — "`references/rationale.md:98`" is a passing mention of the symlink idiom inside the `--settings` comparison; the orchestrator's actual
  dependency story (the runner links the main tree's `node_modules` in, and why that needs the bare exclude line) is `rationale.md:394-400` and
  SKILL.md `:544`. Note too that no orchestrate SKILL.md step instructs the symlink — it is an idiom the runner used, not a codified mechanism — which is
  exactly why the plan's "stated explicitly" is right for execute; say so rather than calling it "the orchestrator's dependency mechanism".
- plan:181 — the behaviour bullet says "named branch ≠ `<base>`" but not "not detached"; the Task 6 step-1 test (a) at :202 asserts the reference refuses a
  detached `HEAD` (spec :87 says both). Add "not detached" to the bullet so the reference and its test come from the same sentence.
- plan:110 / Task 3 — the controller's own header counts ("Eight thin pass-throughs", `items-write.controller.ts:25`; "all nine", `:255`) and
  `source.ts:229` ("beside the eight writes") are code comments the ninth pass-through makes stale. Task 7 sweeps CLAUDE.md, rules and invariants but
  no task names these two files' comments. One clause in Task 3's file list covers it.
- plan:132-133 — gating an in-review item as `ungroomed` reuses the existing vocabulary (good: `RunStage` untouched), but a Runs-page reader will see
  "ungroomed" on an item that is groomed; the prepended reason is what explains it. Fine as decided — just make sure the orchestrator test at :147 asserts
  the reason string is FIRST in `reasons`, as `applyStaleMarks` places its own, so the explanatory line is the one a reader sees.
- plan:199 (adjacent, unchanged) — spec :190-192's `Refs #<n>` branch also requires the final message to say the issue "must be closed by hand once the
  work reaches the default branch"; the final-message bullet lists the label-removal sentence but not this one. Worth one clause while :196-197 is open.
- plan:30-31 — a double-backtick code span broken across a line is valid CommonMark (the newline renders as a space) but some renderers show it oddly;
  harmless.
