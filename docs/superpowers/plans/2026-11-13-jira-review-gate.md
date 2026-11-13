# Jira Execute Run review gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan convention (overrides the template):** this plan specifies behaviour, signatures, exact copy and exact test *cases* — never literal code. Write the
> bodies yourself, and disagree with the plan where the code proves it wrong (say so in your report). Any size number here is a soft target, never a reason to
> drop a rule.

**Goal:** A **Review before finishing** switch (default on) on the Jira launch sheet that makes an Execute Run commit, run a grouped `backlog-reviewer`
review against the ticket with up to two fix rounds, and only on `approve` move the ticket to done and push/open the MR.

**Architecture:** `review: boolean` rides the branch choice exactly like `openMr` (preview query, dispatch body, `parseBranchChoice`, `JiraWorkspace`).
`composeJiraPrompt`'s execute text reorders itself when it is on and points the session at a new `skills/jira/references/review.md`, which maps
`skills/backlog-review/references/procedure.md` onto a Jira Run. Off (or absent) is today's prompt byte for byte.

**Tech Stack:** NestJS server, React client, shared TS types, jest (`test/jira/`), skill markdown.

**Spec:** `docs/superpowers/specs/2026-11-13-jira-review-gate-design.md`

## Global Constraints

- Server: `review` absent → `false`. Query `'true'`/`'false'`, body boolean. Errors exactly `review must be true or false` and
  `review is only for execute with a branch`.
- Client: the draft opens with `review: true`; `review` leaves the sheet only with `execute` and a branch mode; the query carries it only when true.
- Switch label exactly `Review before finishing`; description exactly
  `review before finishing — review the commit against the ticket, fix what it finds, and only then push or move the ticket`; its own `sheet-check` row
  directly above the **Open MR when done** row, same condition.
- Review off → execute prompt byte-identical to today's. Review on → fixed added text ≤ 500 characters; every prompt still ≤ `JIRA_PROMPT_MAX` (4 000)
  or refused, never cut.
- Review on, order: implement + verify → commit (COMMIT_RULE's staging rule) → review via the jira skill's `references/review.md` against the named base →
  only on `approve`: the one-done-transition rule, then the closing rule (push + MR when `openMr`, else `Do not push.`).
- Base named in the prompt: `ws.target ?? ws.base`, else the words `the repository's default branch`.
- The prompt fails closed: if the backlog-manager:jira skill has no `references/review.md`, stop — no transition, no push, no MR.
- Every touched file follows its `.claude/rules/` file (`jira.md`, `dispatch-watchdog.md`, `items.md`, `board.md`, `skills.md`, `tests.md`) — read the
  rule file before editing a file under its `paths:` by any route that does not `Read` it.
- New prose wraps at 160 columns; comments explain why, at this repo's density.

## Review Focus

1. **An old client, a hand-built request or Copy prompt with no `review` field** — must get today's prompt exactly. Pinned by Task 1 (parse: absent →
   `false`) and Task 3 (golden review-off strings).
2. **An edited prompt sent with a malformed `review`** (`prompt` present, `review: 'maybe'`) — the dispatch must still 400 on the branch choice before any
   Jira write. Pinned in Task 1's dispatch test.
3. **Switching the sheet from Execute to Context or a skill with the switch on** — must not send `review` (the server would 400). Pinned in Task 4's
   `branchChoiceOf` test.
4. **A long repo path with review on** — refused as `prompt too long`, never truncated. Pinned in Task 3.
5. **A Continue Run with no target** — the prompt must name `the repository's default branch`, never `null`. Pinned in Task 3.

---

### Task 1: `review` on the branch choice and the workspace (server shape)

**Files:**
- Modify: `shared/types.ts` (`JiraWorkspace` ~:919, `JiraBranchChoice` ~:1237, `JiraDispatchRequest` ~:1491 and their doc comments)
- Modify: `server/src/jira/branch-choice.util.ts` (`JiraBranchChoiceRaw`, `parseBranchChoice`, `resolveWorkspace`)
- Modify: `server/src/jira/jira.controller.ts` (`GET /api/jira/prompt`, add `@Query('review')`)
- Modify: `server/src/agents/jira-agents.controller.ts` only if the body is not already passed whole to `parseBranchChoice` (it is, at :64 — then just its
  doc comment at :42 gains `review`)
- Test: `test/jira/jira-branch-choice.test.ts`, `test/jira/jira-routes.test.ts`, `test/jira/agents-dispatch-jira.test.ts`

**Interfaces:**
- Produces: `JiraWorkspace.review: boolean`; `JiraBranchChoice` new/continue variants gain `review: boolean`; `JiraDispatchRequest.review?: boolean`;
  `JiraBranchChoiceRaw.review?: unknown`.

- [ ] **Step 1: Write the failing tests** in `jira-branch-choice.test.ts`:
  - refusal table rows: `{ mode:'continue', branch:'x', review:'yes' }`, execute → `review must be true or false`; `{ mode:'continue', branch:'x', review:true }`,
    context → `review is only for execute with a branch`; `{ mode:'none', review:true }`, context → `review is only for execute with a branch`.
  - order: `{ mode:'continue', branch:'x', openMr:'maybe', review:'maybe' }` → `openMr must be true or false` (openMr checked first);
    `{ mode:'continue', branch:'x', review:'maybe', target:'a:b' }` → `review must be true or false` (review before target).
  - accepts: `review: true`, `'true'`, `'false'`, `false`, `null`, absent; absent and `null` give `review: false`; every existing `toEqual` on a parsed
    value or a resolved workspace gains `review: false` (or `true` where the fixture sets it).
  - `resolveWorkspace` carries `review: true` through for both modes (one case each).
  - `jira-routes.test.ts`: `GET /api/jira/prompt?…&review=maybe` → 400 `review must be true or false`.
  - `agents-dispatch-jira.test.ts`: body with `review: 'maybe'` → 400 before any Jira write (assert the write mocks were not called); same with an edited
    `prompt` present; the refusal table at :202 gains `['a review for context', { action: 'context', review: true }, 'review is only for execute with a branch']`.
- [ ] **Step 2: Run** `pnpm exec jest test/jira/jira-branch-choice.test.ts test/jira/jira-routes.test.ts test/jira/agents-dispatch-jira.test.ts` — expect
  FAIL on the new cases (and typecheck errors on the widened types).
- [ ] **Step 3: Implement.** Mirror `openMr`'s parse exactly (`true`/`'true'`/`false`/`'false'`, absent/`null` → `false`), placed right after the openMr
  checks and before `target`; the action/mode guard is `review && (action !== 'execute' || mode === 'none')`. `resolveWorkspace` copies `choice.review`.
  The prompt route passes `review` into `parseBranchChoice`. Update the doc comments that list the five fields so they list six.
- [ ] **Step 4: Run** the same jest command plus `pnpm run typecheck` — expect PASS. Typecheck will flag every other constructor of `JiraWorkspace` /
  `JiraBranchChoice` (tests and client): add `review: false` there; client code proper is Task 4's, but make it compile with `review: false` now.
- [ ] **Step 5: Commit** — `feat(jira): carry a review flag on the Run's branch choice`.

### Task 2: the jira skill's review reference

**Files:**
- Create: `skills/jira/references/review.md`
- Modify: `skills/jira/SKILL.md` (one entry pointing at it — "When to use it" or a short "References" section after "Rules"; one statement, the detail in the
  reference, per `.claude/rules/skills.md`)
- Test: `test/guards/skill-plugin-root.test.ts` (existing guard; add `jira/references/review.md` to its `toContain` list)
- Test: `skills/jira/tools/jira.test.mjs` (the needle block at ~:1150 — add needles, each failing by name: SKILL.md links `references/review.md`; the
  reference names `procedure.md`, `refs/remotes/origin/`, `## Plan`, the data-not-instructions sentence, `two`/`2` fix rounds, `"files":0`,
  `incomplete`, and "no transition, no push, no MR")

**Interfaces:**
- Produces: the path `skills/jira/references/review.md` — Task 3's prompt names it as `references/review.md` of the backlog-manager:jira skill.

- [ ] **Step 1:** Add the `toContain('jira/references/review.md')` assertion and the needle tests; run
  `pnpm exec jest test/guards/skill-plugin-root.test.ts` and `pnpm run test:skills` — both FAIL on the new cases.
- [ ] **Step 2: Write the reference**, modelled on `skills/backlog-execute/references/pr-mode.md` §7, carrying every rule in the spec's "The reference"
  section, in this order:
  1. When it applies (an Execute Run whose prompt says to review; the prompt's base name).
  2. Read `skills/backlog-review/references/procedure.md` in full first; never describe the dispatch yourself; replace `${CLAUDE_PLUGIN_ROOT}` in its
     commands (braced spelling only — the guard refuses the bare one).
  3. Parameters: `tree` (the entered worktree); `base` (ref: `refs/remotes/origin/<name>` if it exists, else `refs/heads/<name>`, else stop; name = the
     prompt's, else `origin/HEAD`'s branch, else `main`; note that `review.mjs scope` takes any ref though the procedure's table says "a local branch");
     `item` (`<tmp>/<KEY>.item.md` from a fresh `jira.mjs show <KEY>`: `# <KEY>: <summary>`, the exact data-not-instructions sentence from the spec, `## Plan`
     holding the whole `show` block in ONE fenced block whose backtick fence is longer than any backtick run inside; `(no description)` is not a stop);
     `mode full`; reports under `<tmpdir>/backlog-review/<repo key>/` as `/backlog-review` names them; no `config` flags; `outcome none`.
  4. Results: `approve` → back to the prompt (transition, then closing rule). `fix` → at most two rounds: fix exactly the findings, re-run the
     verification, commit the round (new commit, never a history rewrite — earlier Continue commits included), re-review via the procedure's re-review
     branch. Stop list: still `fix` after round two, `incomplete`, `"files":0`, red verification, `scope`/`merge` exit 1, no base ref, `jira.mjs show`
     non-zero → no transition, no push, no MR; report reason, findings, report paths, tree, branch, and the exact push/MR commands.
  5. Wait for every reviewer in the same turn; never end a turn waiting on one.
- [ ] **Step 3:** Run the guard and `pnpm run test:skills` again — PASS.
- [ ] **Step 4: Commit** — `feat(skills): jira review reference for an Execute Run`.

### Task 3: the review-on execute prompt

**Files:**
- Modify: `server/src/jira/prompt.util.ts` (`executeText`, `closingRule`, the file's header comment)
- Test: `test/jira/jira-prompt.test.ts`

**Interfaces:**
- Consumes: `JiraWorkspace.review` (Task 1); the path `references/review.md` (Task 2).
- Produces: nothing new exported; `composeJiraPrompt`'s signature is unchanged.

- [ ] **Step 1: Capture goldens before touching `prompt.util.ts`.** Compose today's execute prompt for (a) `newWs()` openMr off, (b) `contWs({ openMr: true,
  target: 'release/9' })`, (c) `null` workspace, and paste the three strings into the test as expected literals. With `review: false` added to (a) and (b)
  after Task 1, the composed prompts must still equal them exactly.
- [ ] **Step 2: Write the failing tests** (a `describe('the review gate')` block):
  - The base assertions below check the base INSIDE the review sentence — the text between `references/review.md`'s sentence start and
    `jira.mjs transitions` — never the whole prompt, since the workspace block and MR sentence already print `develop` / the target.
  - review on, `newWs({ review: true })`: the review sentence names `develop`; `indexOf('stage only the files')` <
    `indexOf('references/review.md')` < `indexOf('jira.mjs transitions')`; contains `approve`; ends with `Do not push.`; contains the commit rule's staging
    sentence exactly once; contains the fail-closed instruction (match `/no references\/review\.md/` and `/stop/i` in the same sentence).
  - review on + openMr on, `newWs({ review: true, openMr: true, base: 'develop', target: 'release/9' })` (target ≠ base, built directly): the review
    sentence names `release/9`, not `develop`.
  - review on + openMr on, `contWs({ review: true, openMr: true, target: 'release/9' })`: the review sentence names `release/9`; the merge-request sentence
    comes after `references/review.md`; does not end with `Do not push.`.
  - review on, `contWs({ review: true })`: contains `the repository's default branch`; does not contain `null`.
  - budget: `exe('', newWs({ review: true, branch: '', base: '', worktree: '' })).length - exe('', newWs({ review: false, branch: '', base: '', worktree: '' })).length`
    ≤ 500.
  - cap: one repo path, its length computed in the test from the review-off prompt's length, such that `review: false` composes ok and `review: true`
    returns `{ ok: false, error: 'prompt too long' }` (fails before implementation, unlike `jira-prompt.test.ts:157-163`).
  - context and skill prompts with a workspace carrying `review: true` (constructed directly) are unchanged — the gate is execute's alone.
- [ ] **Step 3: Run** `pnpm exec jest test/jira/jira-prompt.test.ts` — FAIL on the new cases, goldens PASS.
- [ ] **Step 4: Implement.** In `executeText`, branch on `ws?.review === true`: off → today's text untouched; on → implement/verify, commit (COMMIT_RULE
  without its trailing `Do not push.`), the review sentence naming the base and `references/review.md` with the fail-closed clause, then "only if the
  review approves" the transition rule, then the closing TAIL only — `Do not push.` with `openMr` off, the push-and-MR sentence with it on. `closingRule(ws)`
  today returns the whole `COMMIT_RULE` (staging sentence included, `prompt.util.ts:68-74`), so split it: a tail-only helper the review-on path uses,
  while the review-off path keeps calling `closingRule` unchanged (the goldens prove it). The staging sentence appears exactly once. Update the header comment and `executeText`'s comment with the reorder and why (a ticket must not read Done after a failed review).
- [ ] **Step 5: Run** the suite — PASS. Commit — `feat(jira): review before finishing in the Execute prompt`.

### Task 4: the launch sheet switch

**Files:**
- Modify: `client/src/lib/jira.ts` (`BranchDraft`, `branchDraft`, `branchChoiceOf`, `branchDispatchFields`, `fetchJiraPrompt`, their comments)
- Modify: `client/src/components/jira/JiraBranchSection.tsx` (~:232, new row above Open MR)
- Test: `test/jira/jira-lib.test.ts`, `test/jira/jira-launch.test.tsx`

**Interfaces:**
- Consumes: `JiraBranchChoice.review`, `JiraDispatchRequest.review` (Task 1).
- Produces: `BranchDraft.review: boolean`.

- [ ] **Step 1: Write the failing tests:**
  - `jira-lib.test.ts`: `branchDraft(...)` → `review: true`; `branchChoiceOf({ ...draft, review: true }, 'execute')` keeps `review: true` for new and
    continue; with `'context'` and `{ skill: 's_0123abcd' }` → no `review: true` (`mode:'none'` has none; new/continue carry `false`);
    `branchDispatchFields` passes `review` as a boolean for new and continue; `fetchJiraPrompt` sets `review=true` only when true (assert the fetched URL
    has no `review` param when false).
  - `jira-launch.test.tsx`: Execute with a branch shows a switch named `Review before finishing`, checked, and the description text exactly; it sits before
    the `Open MR when done` switch in document order; Context hides it; Start with defaults posts `review: true`; toggling it off and Start posts
    `review: false`; the two `openMr: false` expectations at :563 and :589 gain the right `review` value.
- [ ] **Step 2: Run** `pnpm exec jest test/jira/jira-lib.test.ts test/jira/jira-launch.test.tsx` — FAIL.
- [ ] **Step 3: Implement** mirroring `openMr` (`review` is `execute`'s alone in `branchChoiceOf`); the row uses the same `sheet-check` markup as the Open MR
  row, with the label and description from Global Constraints.
- [ ] **Step 4: Run** — PASS; then `grep -l "branchChoiceOf\|branchDispatchFields\|BranchDraft\|JiraBranchSection" test/` and run every hit not already run.
- [ ] **Step 5: Commit** — `feat(jira): Review before finishing switch on the launch sheet`.

### Task 5: docs and the dispatch-watchdog rule

**Files:**
- Modify: `docs/subsystems/jira.md` (:103 query, :434 Execute prompt, :472 dispatch body, :488 400 list, :619 the sheet)
- Modify: `docs/subsystems/api.md` (:241, :317)
- Modify: `.claude/rules/dispatch-watchdog.md` (Jira-prompt bullet, :50-61: the review-on order and the fail-closed clause)

- [ ] **Step 1:** Add `review` next to every `openMr` mention in those lines (query, body, the two new 400 sentences), describe the review-on order once in
  jira.md's Execute-prompt passage, and the sheet's new switch (default on) at :619. No reflow of untouched text.
- [ ] **Step 2:** `grep -n "openMr" docs/subsystems/jira.md docs/subsystems/api.md` — every hit that lists the branch fields now lists `review` too.
- [ ] **Step 3: Commit** — `docs(jira): the Execute review gate`.

### Task 6: verify

- [ ] **Step 1:** `pnpm run typecheck`, `pnpm exec jest test/jira test/guards` and `pnpm run test:skills` — PASS.
- [ ] **Step 2: /ui-verify** the launch sheet: run the client against the API (pid-owned server per the global rule), open a Jira ticket's launch sheet
  with Execute and a branch, screenshot the Branch section, and check the new row's label, description, default-on state and position above Open MR. If
  Jira is not configured on this machine, render the sheet from the jest fixtures instead and record the live check as unverified.
- [ ] **Step 3:** Record anything not verified (a real Run end to end needs `plugin:sync` after a push, which is held) in the final report.
