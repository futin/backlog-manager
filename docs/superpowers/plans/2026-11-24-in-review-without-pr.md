# `in-review` without an open PR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour, names, exact values and exact test cases — never literal code.** It overrides the writing-plans template's code blocks:
> the implementer writes every body. Where a step names a test, the assertions listed are the test; write them in the suite's own style. If the code
> disagrees with a fact stated here, trust the code, say so in the report, and keep the behaviour this plan asks for.

**Goal:** a tracker item whose `in-review` label is on while no open PR references it says so on the board and in the server's ladder, and the item modal
offers a confirm-gated **Lift review** that shows what this machine can prove about leftover `execute/<n>` work.

**Architecture:** the poller already indexes PRs by the issues they reference (`decidingPull`); a new poller question feeds `mapIssue` a new trailing
parameter, which sets a new true-or-absent flag on `BacklogItem`. `inReviewBlock` reads that flag to pick between two shared sentences. A new unguarded GET
reports local `execute/<n>` branch/tree presence; the client's new `ReviewLift` reads it and posts the existing `POST /api/items/review`. `GithubSource.review`
gains `planReview`'s absorb tail so the board's re-read sees the lift at once.

**Tech Stack:** NestJS (server), React + Testing Library (client), Jest (jsdom for `.tsx`), supertest via `listenLoopback`.

**Spec:** `docs/superpowers/specs/2026-11-24-in-review-without-pr-design.md`

## Global Constraints

- New reason, exact: `in review, but no open PR references this item`. `IN_REVIEW_REASON` (`a PR is open for this item`) is unchanged.
- The skills' copies of `IN_REVIEW_REASON` (`skills/backlog-orchestrate/tools/orchestrate.mjs`, `skills/backlog-execute/**`, `skills/backlog/**`) are NOT edited.
  No file under `skills/` changes in this plan.
- Never lift the label automatically. The only write is a person's click past the confirm.
- Files items are untouched: they never carry `inReview` or the new flag.
- Route: `GET /api/items/held?project=<abs project path>&id=<id>` → `{ branch: boolean | null, tree: boolean }`. Unguarded GET, per request, memoised
  nowhere, never mapped onto an item.
- Branch probe: `runGit(['-C', <project path>, 'for-each-ref', '--format=%(refname)', 'refs/heads/execute/<n>'])` — non-empty → `true`, `''` → `false`,
  `null` → `null`. Never `show-ref`. Tree probe: `existsSync(<project path>/.worktrees/execute-<n>)`.
- Chip text `Lift review`; chip `title` `remove the in-review label so this item can be executed again`; confirm `acceptLabel="Lift review"`,
  `dismissLabel="Keep in review"`; note after success `review lifted`.
- Confirm copy, with `<id>` the item id (e.g. `#214`) and `<n>` the issue number (e.g. `214`):
  - pending: `Checking this machine for execute/<n>…`
  - held (branch or tree `true`): `execute/<n> still holds work for <id> on this machine — push it and open a PR instead. Lift anyway?`
  - not found (branch `false`, tree `false`): `No execute/<n> branch or worktree here. Work left uncommitted in a checkout, or on another machine, does not show up — lift only once you know it is gone or pushed.`
  - unknown (branch `null` with tree `false`, or the GET failed): `Could not check this machine for execute/<n>. Lift only once you know the work is gone or pushed.`
- Accept is enabled in every state, pending included, and always posts `POST /api/items/review` `{ project, id, inReview: false }`.
- New text wraps at 160 columns. Comments explain why, at this repo's density.
- Run only the touched suites plus every `grep -l <symbol> test/` hit for each symbol the diff adds a caller of (CLAUDE.md). CI runs the full suite.

## Review Focus

1. **A referencing PR is open** — item keeps `a PR is open for this item`, the modal draws no Lift. Pinned in Task 1 (poller + mapper) and Task 2 (dispatch).
2. **A merged PR into a feature base, or a merge whose base is not learned yet** — `reviewLifted` false, no PR open → new flag set, new reason. Task 1.
3. **`runGit` timing out on the branch probe** — `branch: null`, never `false`, and the confirm shows the unknown copy. Task 4 (`git-run.test.ts`) and Task 5.
4. **An `id` that is a URN for another repo, or not a number** — 400, and nothing runs git. Task 4.
5. **A Lift on an issue whose label is already gone** — `review`'s 404-as-success path still answers success and the re-read still absorbs. Task 3.

---

### Task 1: Poller question and mapper flag

**Files:**
- Modify: `server/src/tracker/poller.service.ts` (beside `reviewLifted`, ~line 592)
- Modify: `server/src/tracker/map-issue.ts` (`mapIssue` at 162, `inReview` at 191, spread at 302)
- Modify: `shared/types.ts` (`BacklogItem.inReview` at 327 — the new flag goes beside it)
- Modify: `server/src/items/sources/github.source.ts` (the two `mapIssue` callers, ~145 and ~205)
- Test: `test/tracker/tracker-review-lift.test.ts`, `test/tracker/tracker-map.test.ts`

**Interfaces:**
- Produces: `TrackerPollerService.reviewPullOpen(repo: string, number: number): boolean` — `true` iff `decidingPull(...) === 'open'`; `true` for a repo the
  poller never synced (the conservative answer: today's sentence, no Lift).
- Produces: `mapIssue(issue, repo, project, claims, reviewLifted = false, reviewPullOpen = true)`.
- Produces: `BacklogItem.inReviewNoPr?: true` — true-or-absent, never `false`; set only when `inReview` is set AND `reviewPullOpen` is `false`. Its doc
  comment says what it means and that `inReviewBlock` reads it.

- [ ] **Step 1: Failing tests in `tracker-review-lift.test.ts`** — new `describe('reviewPullOpen')`, using that file's `poller(...)`, `issue`, `pr`, `pull`, `MERGED`
  helpers:
  - true when a referencing PR is open (`pr(370, 'Refs #266', null)` beside `issue(266)`).
  - false with no referencing PR at all.
  - false when the only referencing PR closed unmerged (`pr(362, 'Refs #266', null, 'closed')`).
  - false when the latest referencing PR merged into a feature base (`pull(362, 'feature/x')`).
  - false for a referencing PR in the SAME number of another repo — copy the existing "another repo" case's fixture at ~309.
  - true for a repo that never synced.
- [ ] **Step 2: Failing tests in `tracker-map.test.ts`** (beside the case at 183):
  - `in-review` label, `reviewLifted=false`, `reviewPullOpen=false` → `item.inReview === true` and `item.inReviewNoPr === true`.
  - same label, `reviewPullOpen=true` → `inReview === true`, `'inReviewNoPr' in item` is `false`.
  - same label, `reviewLifted=true`, `reviewPullOpen=false` → neither key present.
  - no label, `reviewPullOpen=false` → neither key present.
  - the five-argument call (default) on a labelled issue → `inReview` true, no `inReviewNoPr` key.
- [ ] **Step 3: Run both suites; the new cases fail.** `pnpm exec jest test/tracker/tracker-review-lift.test.ts test/tracker/tracker-map.test.ts`
- [ ] **Step 4: Implement.** Add the poller method (doc comment: same index as `reviewLifted`, the new reason's source, the conservative unsynced answer);
  widen `mapIssue` and its doc comment; add the flag to `BacklogItem`; pass `this.poller.reviewPullOpen(repo, number)` at both `github.source.ts` callers.
- [ ] **Step 5: Run both suites; all pass.** Also `pnpm run typecheck`.
- [ ] **Step 6: Commit** — `feat(tracker): flag in-review items that no open PR references`.

### Task 2: The shared reason and `inReviewBlock`

**Files:**
- Modify: `shared/agent.ts` (`IN_REVIEW_REASON` at 518, `inReviewBlock` beside it, the "ONE string everywhere" comment at ~514-516)
- Test: `test/agents/agents-shared.test.ts` (825-845, ladder table at 1245), `test/tracker/tracker-dispatch.test.ts` (258-320), `test/agents/dispatch-button.test.tsx` (241-255)

**Interfaces:**
- Consumes: `BacklogItem.inReviewNoPr` (Task 1).
- Produces: `export const IN_REVIEW_NO_PR_REASON = 'in review, but no open PR references this item';` and `inReviewBlock(item)` returning `null` when
  `item.inReview !== true`, `IN_REVIEW_NO_PR_REASON` when `item.inReviewNoPr === true`, else `IN_REVIEW_REASON`. `itemLadderBlock`'s order is unchanged.

- [ ] **Step 1: Failing tests.**
  - `agents-shared.test.ts` `describe('inReviewBlock')`: `{source:'github', inReview:true, inReviewNoPr:true}` → `'in review, but no open PR references this item'`;
    `{source:'github', inReviewNoPr:true}` (no `inReview`) → `null`; the existing 827 case stays `'a PR is open for this item'`. The twin checks at 839 and 845
    (skills' copies) stay as they are — they pin `IN_REVIEW_REASON`, which the skills keep.
  - Ladder table at 1245: add a row `in-review-no-pr over unvetted and plan-review`, `{ inReview: true, inReviewNoPr: true, unvetted: true, planReview: true }`,
    `null`, `IN_REVIEW_NO_PR_REASON`.
  - `tracker-dispatch.test.ts`: the fake repo has no PR referencing #31, so the three cases that expect `'a PR is open for this item'` (plan, 409 dispatch,
    both-labels) now expect `'in review, but no open PR references this item'`; rename them to say "with no open PR". Add one case where an OPEN PR whose
    body says `Fixes #31` is in the fake's issues list (as the poller reads PRs: an issue entry with `pull_request` set), ticked in, and the plan answers
    `'a PR is open for this item'`. If the fake cannot serve a PR through the issues list, say so in the report and leave the open-PR case to Task 1's
    poller/mapper tests.
  - `dispatch-button.test.tsx` 241-255: keep the existing case (an item with `inReview` only still says `a PR is open for this item`); add one where the item
    also has `inReviewNoPr: true` and the title and the `aria-describedby` text contain the new reason.
- [ ] **Step 2: Run the four suites; the new expectations fail.**
- [ ] **Step 3: Implement** the constant and `inReviewBlock`. Rewrite the "ONE string everywhere" comment: the board and server say the precise sentence; the
  skills' copies keep `IN_REVIEW_REASON` because they read only the label and cannot tell the two cases apart.
- [ ] **Step 4: Run the four suites; all pass.** Then `grep -l "inReviewBlock\|IN_REVIEW_REASON\|itemLadderBlock" test/` and run every hit not yet run.
- [ ] **Step 5: Commit** — `feat(board): say when an in-review item has no open PR`.

### Task 3: `GithubSource.review` absorbs its result

**Files:**
- Modify: `server/src/items/sources/github.source.ts` (`review` at 1049; its doc comment; `planReview`'s comment line "Unlike `review` and `queue`" at ~1074)
- Test: `test/tracker/tracker-write.test.ts` — `describe('review')` at 735 (its `post('review', …)` helper and `trackerPath` fixture).

**Interfaces:** none new. Behaviour: after a landed change (200, or a removal's 404), re-read the issue with `this.client.issue(repo, number, { token })`
and, on a 200 with data, `this.poller.absorbIssue(repo, reread.data)` — exactly `planReview`'s tail. A failed re-read is not a refusal.

- [ ] **Step 1: Failing tests** in that suite:
  - remove `in-review` from a labelled issue via the route → `GET /api/items` immediately (no poller tick) shows the item without `inReview`.
  - removal when the label is already gone (GitHub 404) → 201 success as today (the existing case at ~760), and the item reads without `inReview`.
  - the re-read failing (fake answers the issue GET with 500 once) → the route still answers success.
- [ ] **Step 2: Run; the first case fails.**
- [ ] **Step 3: Implement**, and update both comments: `review`'s says it absorbs like `planReview`; `planReview`'s "Unlike `review` and `queue`" becomes
  "Unlike `queue`".
- [ ] **Step 4: Run; all pass.**
- [ ] **Step 5: Commit** — `fix(tracker): absorb the issue after an in-review write`.

### Task 4: `GET /api/items/held`

**Files:**
- Create: `server/src/items/held.util.ts`
- Modify: `server/src/items/items.service.ts` (new method beside `readClaim`, ~362), `server/src/items/items.controller.ts` (new route after `claim`, ~106),
  `shared/types.ts` (new `ItemHeld`)
- Modify: `.claude/rules/items.md` — the `runGit` call-site list (bullet at ~82: `localHold` → `null` is `branch: null`) and the "one READ beside them"
  sentence at ~39, which becomes two reads (`claim` and `held`). Read `.claude/rules/items.md` and `.claude/rules/security.md` first.
- Create: `test/tracker/tracker-held.test.ts` (route; copy the app setup of `test/tracker/tracker-cold-cache.test.ts`, which already drives
  `GET /api/items/claim` on a tracker project, and its `listenLoopback` use)
- Modify: `test/server/git-run.test.ts` — one case in `describe('a timeout lands in each call site’s existing failure branch')` (184)

**Interfaces:**
- Produces: `export interface ItemHeld { branch: boolean | null; tree: boolean }` in `shared/types.ts`.
- Produces: `localHold(projectPath: string, n: number): Promise<ItemHeld>` in `held.util.ts` — the two probes from Global Constraints, run per call.
- Produces: `ItemsService.held(projectPath: string, id: string): Promise<ItemHeld>` — `writable(this.writerFor(projectPath))` (so unregistered 404, files 400
  with `writable`'s sentence, unsupported 400); then `issueNumberFor(id, lookup.marker.repo)`; `null` → 400 `{ error: '<id> does not name an issue in <repo>' }`
  (the sentence `review` already uses); then `localHold(lookup.project.path, n)`.
- Produces: `GET items/held` in `ItemsController` — blank `project` → 400 `project is required`, blank `id` → 400 `id is required`, as `claim` does. Doc comment
  in `claim`'s style: why unguarded, why per request, why it never decides (spec Non-goals), why `for-each-ref`.

- [ ] **Step 1: Failing route tests** in `tracker-held.test.ts`, on a fixture tracker project whose path is a real `git init`ed temp dir:
  - nothing there → `{ branch: false, tree: false }`.
  - `git branch execute/214` made in the fixture → `{ branch: true, tree: false }`; with id `#214`, `214`, and `gh:<repo>#214` — all three the same answer.
  - a branch `execute/2140` only → `branch: false` for id `214` (the ref is matched exactly, not as a prefix).
  - `mkdir .worktrees/execute-214` only → `{ branch: false, tree: true }`.
  - blank `project` → 400 `{ error: 'project is required' }`; blank `id` → 400 `{ error: 'id is required' }`.
  - unregistered path → 404; a files project → 400 with `this project's items are files — the skills write them directly`.
  - id `gh:other/repo#214` → 400 naming the id and the repo; id `abc` → 400.
  - a `POST` to the same path is not a route (404) — it is a read only.
- [ ] **Step 2: Failing case in `git-run.test.ts`**: `localHold: branch null, never false` — `__setGitTimeoutMs(100)`, `fakeOn({ sleep: 3 })`, call
  `localHold(root, 1)` → `{ branch: null, tree: false }`.
- [ ] **Step 3: Run both suites; new cases fail.**
- [ ] **Step 4: Implement** util, type, service method, route; update `.claude/rules/items.md`.
- [ ] **Step 5: Run both suites, plus `test/guards/claude-rules.test.ts` and `test/guards/vite-proxy.test.ts`, and every
  `grep -l "runGit\|readClaim\|writerFor" test/` hit.** All pass.
- [ ] **Step 6: Commit** — `feat(items): report local execute/<n> leftovers for a tracker item`.

### Task 5: `ReviewLift` in the item modal

**Files:**
- Create: `client/src/components/board/ReviewLift.tsx`
- Modify: `client/src/lib/agents.ts` (two helpers beside `approvePlan`, ~415)
- Modify: `client/src/components/board/ItemModal.tsx` (prop beside `onApproved` at 110; render between the dispatch control and `PlanApprove` at ~232; header
  comment at ~35-38 names the third write)
- Modify: `client/src/components/board/BoardView.tsx` (~799: pass `onLifted={refetch}` beside `onApproved`)
- Create: `test/agents/review-lift.test.tsx` (jsdom; model on `test/agents/plan-approve.test.tsx`, fixture dates via `daysAgoDate`)
- Read first: `.claude/rules/board.md`, `.claude/DESIGN.md` §8.7, and `client/src/components/board/PlanApprove.tsx` — `ReviewLift` is its shape.

**Interfaces:**
- Consumes: `ItemHeld` (Task 4), `BacklogItem.inReviewNoPr` (Task 1).
- Produces: `readHeld(project: string, id: string): Promise<ItemHeld>` — `GET /api/items/held` with both as query params (URL-encoded), through `unwrap`.
- Produces: `liftReview(project: string, id: string): Promise<{ id: string; inReview: boolean }>` — `POST /api/items/review` `{ project, id, inReview: false }`
  through `unwrap`, doc comment in `approvePlan`'s style.
- Produces: `ReviewLift({ item, onLifted }: { item: BacklogItem; onLifted: () => void })`; `ItemModal` prop `onLifted?: () => void`.

Behaviour: rendered only when `onLifted` is passed, `item.status === 'open'`, `item.source === 'github'` and `item.inReviewNoPr === true`. Stages
`idle → confirm → done` with `useAction`, as `PlanApprove`. Chip (same `Chip` and `size` as `PlanApprove`, `data-testid="review-lift"`) → inline `ui/Confirm`
(`testId="review-lift-confirm"`, `label="confirm lift review"`). Opening the confirm fires `readHeld` once (not again on re-render); the confirm's text is the
Global Constraints copy for pending / held / not found / unknown. Accept posts `liftReview` once per click (double-click sends one), then shows the note
`review lifted` (`className="item-claim-note"`) and calls `onLifted`. Dismiss brings the chip back and posts nothing. A refusal prints the server's sentence
verbatim, brings the chip back, and does not call `onLifted`. `<n>` in the copy comes from the item id with its leading `#` dropped.

- [ ] **Step 1: Failing tests** in `review-lift.test.tsx` (tracker fixture `#214`, `inReview: true`, `inReviewNoPr: true`; `fetch` mocked per URL):
  - no chip for: `inReviewNoPr` absent; a files item; a done item; `onLifted` not passed.
  - chip text `Lift review`, `title` `remove the in-review label so this item can be executed again`.
  - opening shows `Checking this machine for execute/214…` while the GET hangs, and Accept (`Lift review`) is enabled in that state.
  - GET `{branch:true,tree:false}` → `execute/214 still holds work for #214 on this machine — push it and open a PR instead. Lift anyway?`; same text for
    `{branch:false,tree:true}`.
  - GET `{branch:false,tree:false}` → the not-found sentence, verbatim.
  - GET `{branch:null,tree:false}` → the unknown sentence; GET answering 500 → the unknown sentence.
  - exactly one GET per opening of the confirm.
  - Accept → one POST to `/api/items/review` with body `{ project: '/abs/alpha', id: '#214', inReview: false }` (match the fixture's `projectPath`), then
    `review lifted` and `onLifted` called once.
  - double-click on Accept → one POST.
  - Dismiss (`Keep in review`) → chip back, no POST.
  - POST refused with `{ error: 'sync is off for futin/x' }` → that sentence printed, chip back, `onLifted` not called.
  - in `ItemModal`: the chip sits after the dispatch control and before `PlanApprove`'s chip (model on plan-approve.test.tsx's case at 185).
- [ ] **Step 2: Run; new cases fail.** `pnpm exec jest test/agents/review-lift.test.tsx`
- [ ] **Step 3: Implement** the helpers, the component, the modal prop and position, the BoardView wire-up.
- [ ] **Step 4: Run** `review-lift.test.tsx`, `plan-approve.test.tsx`, and every `grep -l "ItemModal\|approvePlan\|onApproved\|BoardView" test/` hit, plus
  `test/guards/fixture-clock.test.ts`. All pass. `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(board): lift a stale in-review label from the item modal`.

### Task 6: Docs and rules text

**Files (Modify):**
- `.claude/rules/board.md` — the `ui/Confirm` openers list (~23) gains `ReviewLift`; any passage stating the in-review reason names both sentences.
- `.claude/rules/tracker.md`, `.claude/rules/skills.md` — passages stating the in-review reason: board/server say the precise one, skills keep `IN_REVIEW_REASON`.
  Do not change any skill file.
- `docs/subsystems/invariants.md`, `docs/subsystems/api.md`, `docs/subsystems/board.md`, `docs/subsystems/skills.md` — the in-review reason statements; `api.md`
  lists `GET /api/items/held` beside `GET /api/items/claim` and says `review` now absorbs.
- `.claude/DESIGN.md` §8.7 (~575) — beside the `Approve plan` sentence: the `Lift review` chip, its position, its four confirm texts and the `review lifted` note.

- [ ] **Step 1:** `grep -rn "a PR is open for this item\|IN_REVIEW_REASON\|inReviewBlock\|items/claim" .claude docs/subsystems CLAUDE.md` and edit each hit that
  states the reason or lists the read routes. Leave `docs/superpowers/specs/` history untouched.
- [ ] **Step 2:** Run `test/guards/claude-rules.test.ts` and every other `test/guards/*` suite that reads `.claude/` or `docs/` (`grep -l "DESIGN.md\|docs/subsystems\|\.claude/rules" test/guards/`). All pass.
- [ ] **Step 3: Commit** — `docs: in-review without an open PR, and the item modal's Lift review`.

### Task 7: `/ui-verify`

- [ ] Invoke `/ui-verify` against the running board (`pnpm run docker:up` or `pnpm run dev` + `pnpm run dev:web`; a pid-owned server). There are no picked
  mocks; the reference is this plan's Global Constraints copy and `.claude/DESIGN.md` §8.7. Check: the card's disabled Execute title on an item with the new
  flag (fixture or a real labelled issue with no PR), the modal chip's position, each confirm state's text (force via the GET), the `review lifted` note, and
  no overflow at the modal's 700 px width. Fix defects on the branch; the report goes to the final reviewer.
