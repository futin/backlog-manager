# backlog-execute `pr` finish mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures, exact values and exact test *cases* — never literal implementation
> or test code. Write the bodies yourself, and disagree with the plan where the code says otherwise (say so in the task's report). Size notes are soft.

**Goal:** A committed per-project config (`backlog/config.json`, `execute.finish: "pr"`) makes every `backlog-execute` — typed or board-dispatched — work in
a worktree from the base, commit, review, push and open a PR, with no extra question; tracker items under review are guarded by an `in-review` label.

**Architecture:** `backlog.mjs` gains a local-file `config` reader/setter and an API-backed `review` verb; the server gains one label, one guarded write route,
an `inReview` item flag, an `in-review` rung on both per-item dispatch ladders, and a prompt that swaps `COMMIT_RULE` for a pr-mode sentence; the orchestrator
gates `inReview` items out; the execute SKILL.md gets the pr flow; the "only skill that commits" invariant is rewritten everywhere it is stated.

**Tech Stack:** Node ESM CLI (`node --test`), NestJS + jest/supertest, React (jsdom jest), markdown skills.

**Spec:** [docs/superpowers/specs/2026-10-21-execute-pr-mode-design.md](../specs/2026-10-21-execute-pr-mode-design.md) — read it whole before any task;
decisions are numbered there and cited here as "spec D<n>".

## Global Constraints

- Config file: `backlog/config.json`, shape `{ "execute": { "finish": "in-place" | "pr", "base"?: string } }`. Missing file or key → `finish: "in-place"`.
  Missing `base` → the remote default branch (`origin/HEAD`), falling back to `main`.
- Malformed JSON, non-object `execute`, unknown `finish`, non-string/empty `base` → the CLI reader exits `1` with a message naming `backlog/config.json`;
  never a silent fall back. The SERVER's reader is the one exception: anything invalid reads as `in-place` (spec, Non-goals prompt paragraph).
- Label name: `in-review`. Write route: `POST /api/items/review`, body `{ project, id, inReview: boolean }`, a non-boolean `inReview` is a 400.
- Item flag: `inReview?: true` on `BacklogItem` — `true` or absent, never `false` (same contract as `queued`).
- Branch/worktree names for a new tree: `execute/<id>` at `<project root>/.worktrees/execute-<id>` (tracker `<id>` = bare issue number).
- The pr-mode prompt sentence, exact (backticks included, as `COMMIT_RULE` carries its own): ``Finish in this project's `pr` mode: the skill commits,
  reviews, pushes and opens the PR.``
- The in-review reason, exact, one string everywhere (dispatch ladders, orchestrator gate reason, execute's refusal): `a PR is open for this item` —
  lowercase like the ladder's other fragments (`shared/agent.ts:460`, `client/src/lib/item-progress.ts:106`).
- The one-off override phrase, exact: `in place this time`.
- Every skill CLI ends `process.exitCode = main(...)`. Node tests sit beside the tool; jest tests flat in `test/`. Supertest suites use `listenLoopback`.
- Comments explain *why* at the repo's existing density; new prose wraps at 160 columns; commit bodies at 72.
- `skills/` and `agents/` changes reach nothing until committed, pushed and `pnpm run plugin:sync` — the final task says so; it does not run the sync.

## Review Focus

1. **A reused desktop worktree that is detached or on `<base>`** — must not be reused; a new tree is cut instead. (Task 6 prose test.)
2. **Refusal after a new tree was cut** (item absent / ungroomed / claim lost) — the tree and `execute/<id>` branch are removed, a reused tree never is.
   (Task 6 prose test.)
3. **Board prompt with a malformed `backlog/config.json`** — prompt keeps `COMMIT_RULE`; no 500. (Task 2 test.)
4. **`in-review` set on an issue a running orchestrator would otherwise queue** — gated out of the queue with a reason, never silently dropped. (Task 4 test.)
5. **`config` run in a tracker project with the stack down** — still works (local file), never exit `5`. (Task 1 test.)

---

### Task 1: `backlog.mjs config` — local-file reader and setter

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` (new verb in `main`, ~line 2245; usage text)
- Test: `skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Produces: CLI `backlog.mjs config` → prints effective config JSON `{"execute":{"finish":"in-place"|"pr","base":"<branch>"}}` (base resolved), exit `0`;
  `backlog.mjs config set execute.finish <in-place|pr>` and `config set execute.base <branch>` → writes `backlog/config.json` (2-space JSON, trailing
  newline), preserves other keys, prints the new effective config, then on stderr one line reminding to commit the file when `git status --porcelain` shows
  it modified/untracked. An exported pure `parseExecuteConfig(text: string | null) → { ok: true, finish, base: string | null } | { ok: false, message }`
  for the tests.
- Must NOT go through `requireStore` (spec, "The config"). Resolves the root with the same `resolveRoot` every verb uses.

- [ ] **Step 1: Write failing tests** — cases: no file → `finish:"in-place"`; `{"execute":{"finish":"pr"}}` → `pr`; `base` set → that base echoed; no `base`
  in a repo whose `origin/HEAD` → `trunk` resolves to `trunk`; no remote → `main`; malformed JSON → exit `1`, stderr contains `backlog/config.json`;
  `finish:"merge"` → exit `1` naming the value; `base:""` → exit `1`; `set execute.finish pr` on no file creates it and keeps no other key; `set` on a file
  with an unrelated top-level key keeps that key; `set execute.finish bogus` → exit `1`, file unchanged; in a project whose `backlog/source.json` says
  `github` and no API is listening, `config` exits `0` (Review Focus 5).
- [ ] **Step 2: Run** `node --test skills/backlog/tools/backlog.test.mjs` — new cases FAIL.
- [ ] **Step 3: Implement** the verb and `parseExecuteConfig`; base resolution via `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`).
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(skills): backlog.mjs config — per-project execute finish mode`.

### Task 2: Board prompt follows the finish mode

**Files:**
- Create: `server/src/agents/finish-mode.util.ts`
- Modify: `server/src/agents/prompt.util.ts:26-30` (`composePrompt`), `server/src/agents/agents.service.ts:~389` (the call), `shared/agent.ts:807-830`
  (`COMMIT_RULE`'s "known seam" comment rewritten; add exported `PR_FINISH_RULE` holding the exact sentence from Global Constraints)
- Test: `test/agents-prompt.test.ts`

**Interfaces:**
- Produces: `readFinishMode(projectPath: string): 'in-place' | 'pr'` — synchronous file read of `<projectPath>/backlog/config.json`; any error or invalid
  shape → `'in-place'`. `composePrompt(item, action, finish: 'in-place' | 'pr' = 'in-place')` — appends `PR_FINISH_RULE` instead of `COMMIT_RULE` only when
  `action === 'execute' && finish === 'pr'`.
- The read is per request, memoised nowhere (same reason as the `uncommitted` flag: a committed config change must show on the next click).

- [ ] **Step 1: Failing tests** — for `execute`: no file / `in-place` / malformed JSON / `finish:"merge"` → prompt ends with `COMMIT_RULE` exactly; `pr` →
  ends with `PR_FINISH_RULE` exactly and contains no `Do not push`. For `groom` and `capture` in a `pr` project → still end with `COMMIT_RULE`. The existing
  tail assertions stay green; rewrite their comment "The commit rule rides on EVERY action" (`test/agents-prompt.test.ts:108-113`), now false for execute in
  a `pr` project. Use a temp project dir per case. `readFinishMode` never throws — that util test is the guard for Review Focus 3.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/agents-prompt.test.ts` — FAIL.
- [ ] **Step 3: Implement** reader, constant, the optional parameter, and pass `readFinishMode(item.projectPath)` at the call site.
- [ ] **Step 4: Run** same + `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(agents): execute prompt follows the project's finish mode`.

### Task 3: `in-review` label, item flag and write route

**Files:**
- Modify: `server/src/tracker/labels.ts` (export `IN_REVIEW_LABEL = 'in-review'`; append to `TRACKER_LABELS` after `QUEUED_LABEL`; color your call; description
  `A PR for this item is open — the work lands when it merges`), `shared/types.ts` (`inReview?: true` beside `queued`, doc comment saying gates DO read it —
  unlike `queued`; `ItemReviewRequest extends ItemWriteRequest { id: string; inReview: boolean }`), `server/src/tracker/map-issue.ts:~148-249` (flag from the
  label; exclude it from `tags` like `QUEUED_LABEL`), `server/src/items/sources/source.ts:~217` (`review(...)` beside `queue`), `server/src/items/sources/
  github.source.ts:~883` (impl, mirroring `queue`: add/remove the label, removal that 404s is success; `ItemWriter` has this one impl — the files refusal
  is the controller's, before any writer, `items-write.controller.ts:29`), `server/src/items/items-write.controller.ts:~254` (`@Post('review')`, same guards and per-item serialisation as `queue`)
- Test: `test/tracker-labels.test.ts`, `test/tracker-map.test.ts`, `test/tracker-write.test.ts`, `test/agents-origin-guard.test.ts` (it enumerates every
  write route and builds one body with every field they need, `:92-132` — add `review` and `inReview: true`, and fix its route-count comments)

**Interfaces:**
- Also: "nine" wording for the label list in `server/src/tracker/labels.ts:63,95` and the title at `test/tracker-poll.test.ts:467` becomes ten.
- Produces: `IN_REVIEW_LABEL`; `BacklogItem.inReview?: true`; `POST /api/items/review` → `201 { id, inReview }` (Nest's POST default, as the sibling
  `queue` suite pins, `test/tracker-write.test.ts:515`).

- [ ] **Step 1: Failing tests** — labels: `TRACKER_LABELS` has length `10`, last entry name `in-review`, describe title updated from "the nine labels";
  map: an issue labelled `in-review` maps with `inReview: true` and the label not in `tags`; an unlabelled issue has no `inReview` key at all; route:
  `{inReview:true}` adds the label (client fake records `addLabel(repo, n, 'in-review')`), `{inReview:false}` removes it, both `201`; a removal answered 404 is `201`,
  `inReview:"yes"` → `400 { error: 'inReview must be a boolean' }`, a `files` project → refused with the same status the `queue` route uses for one, a
  wrong content-type / foreign origin → refused like every write route.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/tracker-labels.test.ts test/tracker-map.test.ts test/tracker-write.test.ts test/agents-origin-guard.test.ts test/tracker-poll.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same + `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(tracker): in-review label and its write route`.

### Task 4: Gates read `inReview`, and `backlog.mjs review`

**Files:**
- Modify: `client/src/lib/item-progress.ts:95` (`progressBlock` — or a sibling the button reads right after it; your call, keep "in progress → in review →
  run claim" order), `server/src/agents/agents.service.ts` — the server's per-item ladder, both where it is composed for the plan/status answer (`:414`,
  `dispatchBlock(...) ?? runClaimBlock(...) ?? syncOffBlock(...)`) and where dispatch refuses (`~451-493`); add an exported helper beside `runClaimBlock` in
  `shared/agent.ts` (my name: `inReviewBlock(item: BacklogItem): string | null`) that both ladders call. `dispatchBlock`/`dispatchGate` are project-level
  (derived from `projectDispatchGate`) and stay untouched. `skills/backlog-orchestrate/tools/
  orchestrate.mjs` (`trackerCandidates` ~1918 / `buildGatedQueue` ~1627: an `inReview` item gets `gate: 'ungroomed'` with the in-review reason prepended to
  `reasons`, exactly as `applyStaleMarks` does (~1760) — no new gate value, so `RunStage` and its consumers are untouched), `skills/backlog/tools/backlog.mjs` (verb `review <id> on|off` → `apiPost('review', { project, id, inReview })`,
  tracker-only: a files project exits `1` with `review is for tracker projects`; stack down → exit `5` like every tracker verb)
- Test: `test/dispatch-button.test.tsx`, `test/agents-shared.test.ts` (`inReviewBlock`), `test/tracker-dispatch.test.ts` (the server refusal — a tracker
  suite with `FakeGithub`; `agents-dispatch.test.ts` is files-only and cannot produce an `inReview` item),
  `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (near the `trackerCandidates`
  cases ~7372), `skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: `BacklogItem.inReview` (Task 3), `POST /api/items/review` (Task 3).
- Produces: the in-review reason from Global Constraints, from `inReviewBlock`.

- [ ] **Step 1: Failing tests** — button: item `inReview:true` → Run disabled with that reason; `inReview` + `started` → the in-progress reason wins;
  `inReviewBlock` returns the reason for an `inReview` item and `null` for one without; `POST` dispatch of an `inReview` item → `409` with that reason (same
  status the run-claim refusal uses), and the plan/status answer carries it as `blocked`; orchestrator: a tracker cache with `#3` (inReview) and `#4`
  (plain) → queue holds only `4`, `#3` listed among gated items with the reason (Review Focus 4); `--ids 3` naming it → gated, not silently dropped;
  CLI: `review 7 on` posts `{inReview:true}` to `/api/items/review` (fake server), `off` posts `false`, `review 7 maybe` → exit `1`, files project → exit `1`.
- [ ] **Step 2: Run** the five suites — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the five suites + `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: gates skip in-review tracker items; backlog.mjs review`.

### Task 5: Reviewer agent accepts execute's inputs

**Files:**
- Modify: `agents/backlog-reviewer.md` — description (`:3-7`) and the input list (`:58-75`): `branch` may be `execute/<id>` or a reused tree's branch;
  `item file path` may be a temp snapshot (issue body + Outcome) written by execute; `report path` may be outside `~/.backlog-manager/orchestrator/` as long
  as it is outside the repo. The five-inputs-or-stop rule and the `<base>...<branch>` diff stay as they are.
- Test: none (prose); `pnpm run test:skills` stays green if any suite reads this file.

- [ ] **Step 1: Edit**, keeping the orchestrator case's wording intact and adding execute's as the second caller.
- [ ] **Step 2: Commit** `docs(agents): backlog-reviewer serves execute's pr mode too`.

### Task 6: execute SKILL.md — the `pr` flow

**Files:**
- Modify: `skills/backlog-execute/SKILL.md` — frontmatter description (`:6`, conditional form), a short new section after "Am I inside an orchestrator run?"
  stating the mode resolution and pointing to the reference, the contract sweep's hand-session sentence (`:257`, `pr` clause), Archive / failure sections
  (one sentence each pointing at the reference for `pr`), Hard limits first bullet (`:343-345`, conditional form). Leave `:32` as is.
- Create: `skills/backlog-execute/references/pr-mode.md` — the full flow, spec steps 1-9 in order, with decisions 5-9 and every "my call" from the spec.

**Interfaces:**
- Consumes: `backlog.mjs config` (Task 1), `PR_FINISH_RULE` (Task 2), `backlog.mjs review <id> on|off` and the in-review reason (Task 4), the reviewer's
  widened inputs (Task 5). `ensureExcludeLines` cannot be called from here (`orchestrate.mjs` refuses every verb but `init` inside a linked worktree), so the
  exclude step is prose — that is the decision.

**Behaviour the text must pin (each is one sentence or one short list in the reference):**
- Mode read once from the starting tree via `backlog.mjs config`; skipped entirely under `[orchestrator-run`; stated in one line; override only by the exact
  phrase; `PR_FINISH_RULE` in a prompt means "follow pr mode", `COMMIT_RULE` in an `in-place` project is today's behaviour.
- Tree choice (Review Focus 1): reuse only a clean linked worktree on a named branch ≠ `<base>`, no commits beyond `<base>`; fast-forward it if behind;
  else `git worktree add <root>/.worktrees/execute-<id> -b execute/<id> <base>`; existing path/branch → stop, never reuse/delete; new tree gets the
  `info/exclude` lines (`.worktrees/`, bare `node_modules` — orchestrate SKILL.md §541-544, `orchestrate.mjs` `WORKTREE_EXCLUDES` ~4174) and a
  `node_modules` **symlink** to the main tree's directory, the orchestrator's dependency mechanism (`references/rationale.md:98`), stated explicitly;
  every command `cd <tree> && …`.
- Refusal cleanup (Review Focus 2): only the tree and branch this session made, only while the branch has no commits beyond `<base>`; say so.
- Files project archive unchanged and committed; tracker: Outcome to a temp file, claim held with heartbeats through review and push, no `move`.
- Commit with `git add -A` (only in the chosen tree); conventional subject (bug → `fix:`, task → `feat:`, `(scope)` optional).
- Review: dispatch `backlog-manager:backlog-reviewer` with worktree, branch, base, item (tracker: temp snapshot beside the report), report path under
  `os.tmpdir()/backlog-execute/`; ≤ 2 fix rounds; after each fix re-run the Outcome's verification, append `### Fix loop <n>`; red or still failing → no push,
  failure report.
- Push `-u origin <branch>` (never force); `gh pr create --base <base>`, body = Outcome summary + review verdict + `Closes #<n>` (default-branch base) or
  `Refs #<n>`; no `gh` / not GitHub → report the exact command. Tracker, after a successful push: `review <id> on` → `comment` → `stop --keep-started`.
- Permission-denied git/gh call → stop there, keep what exists, print remaining commands. A push the remote rejects stops and is reported; `gh` missing or not
  authenticated → report the command. A failed label write undoes nothing; the final message says the guard is missing.
- PR body carries the review findings' one-line summaries; the subject satisfies the target repo's PR-title rule where it has one; the refusal of an
  `inReview` item names the PR when it can; a tracker session heartbeats across the review loop (15-minute stale window).
- Refusal gate gains: an `inReview` item is refused (`a PR is open for this item`).
- Final message: PR URL (or command), branch, worktree path; tracker: the label and how to remove it; files: "merge this PR before draining the backlog".

- [ ] **Step 1: Failing prose tests** in `skills/backlog/tools/backlog.test.mjs`, beside the existing `executeSection` cases (~3064-3116), reading
  `skills/backlog-execute/references/pr-mode.md`: (a) the reuse rule names a named branch, refuses a detached `HEAD`, and refuses a tree on `<base>`
  (Review Focus 1); (b) the refusal cleanup is limited to the tree and branch this session made and says a reused tree is never removed (Review Focus 2).
  Run `pnpm run test:skills` — FAIL (file absent).
- [ ] **Step 2: Write** the reference, then the SKILL.md edits (one statement each, story in the reference).
- [ ] **Step 3: Check** `pnpm run test:skills` and `pnpm run test:jest -- test/claude-rules.test.ts` — PASS.
- [ ] **Step 4: Commit** `feat(skills): backlog-execute pr finish mode`.

### Task 7: Invariants and docs sweep

**Files:**
- Modify: `CLAUDE.md:175` and `.claude/rules/orchestrator.md:33-37` (byte-equal new headline: orchestrate is the only skill that merges; execute commits and
  pushes its own branch only in `pr` mode; body drops "No other skill touches git history at all"), `docs/subsystems/invariants.md` §~434-454 (heading,
  reasoning per spec, push paragraph), `skills/backlog-orchestrate/SKILL.md:9,26`, `docs/subsystems/skills.md:34` (+ document `backlog/config.json`, the two
  verbs), `skills/backlog-groom/SKILL.md:18`, `skills/backlog/SKILL.md:138`; re-read `skills/backlog-orchestrate/references/recovery.md:253` and
  `orchestrate.mjs:6127`. Route count nine → ten in `CLAUDE.md:121-122`, `.claude/rules/items.md:7,27` and the `invariants.md` heading — renaming that heading
  changes its anchor, so update every `#the-nine-item-write-routes…` link (grep the repo). `.claude/rules/skills.md:19-22` + its CLAUDE.md headline +
  invariants section: `config` is the local-file exception beside `jira.mjs worktree`. If a heading's anchor changes, every `Why:` link to it moves too.
- Test: `test/claude-rules.test.ts`

- [ ] **Step 1: Edit** every site; then `grep -rn "never commits\|only skill that commits\|touches git\|nine .*write routes\|the-nine-item" skills agents docs CLAUDE.md .claude`
  and resolve every hit (true-under-the-marker hits may stay; say which in the report).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/claude-rules.test.ts` and `pnpm run test:skills` — PASS.
- [ ] **Step 3: Commit** `docs: execute may commit and push in pr mode — invariants follow`.
- [ ] **Step 4: Report** that the plugin needs commit → push → `pnpm run plugin:sync` before any session sees the new skill text, and that a project opts in
  with `backlog.mjs config set execute.finish pr` plus a commit.
