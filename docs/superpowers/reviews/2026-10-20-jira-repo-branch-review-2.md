# Review 2 — plan `2026-10-20-jira-repo-branch.md`, the hunks of `1a5361c..93de127` only

Reviewer: a fresh Fable session, 2026-10-20, given the two document paths, the diff range and the checklist. Scope is the hunks `git diff 1a5361c 93de127`
touches in the plan (the responses to review 1's C-1 and I-1..I-7 plus four of its Minors); surrounding plan text was read for context only. Code claims
were checked against the checkout at `93de127` (code byte-identical to `main`). Nothing was edited.

**Verdict: APPROVE WITH FIXES.** No Critical. Four Important, all local to the changed text; the design is unchanged and every review-1 finding is
addressed in substance. The C-1 fix (divergence refused in step 4, before any `worktree add`) is correct and complete — the `entered` path is covered too,
because a branch a sibling tree holds exists locally and so meets step 4's "local and `origin/<branch>` both exist" condition.

## Checklist results, for the changed hunks

1. **Coverage.** Nothing dropped. Step 7's divergence clause moved to step 4 and still covers spec §5.4's "a diverged branch stops the Run" for both the
   `attached` and the `entered` paths. The `sync` redefinition (T3) now covers spec §5.2's "behind, ahead or diverged" for the branches this feature creates
   (`--no-track`). T9 gains the file that actually holds the skills hint. No spec section or §7 test case lost its task.
2. **Values.** Copy strings in the changed text match the spec where the spec fixes them (`not a git repository`, `has diverged … never reset, never
   merged`'s intent, `fetch failed:`). Two strings are the plan's own and are marked or acceptable: the detached-tree rewrite (step 6, see I-2 and Minor)
   and `fetchAgeLine`'s buckets (now marked *my call*).
3. **Reality.** Verified: `USAGE`'s footer `every command needs the backlog-manager API running …` (`skills/jira/tools/jira.mjs:31`) and `apiDownMessage`'s
   `every jira.mjs command needs it` (`:57`); `orchestrate.mjs:3861-3867` is the note and regex `(?:already used by worktree|already checked out) at
   '([^']*)'` the hunk points at; `PLACEHOLDERS = ['{key}', '{url}', '{repo}']` at `client/src/components/jira/JiraSkillsGroup.tsx:14` and the hint at
   `:142-150`; `JiraSkillsGroup` is drawn by `JiraSetupView.tsx:77`, which `test/jira-setup.test.tsx` renders through `JiraView` (`:8`), so that suite can
   pin the hint (it already does, `:832`); `JIRA_ENV` exported at `server/src/jira/env.util.ts:21` and imported by `test/compose-env.test.ts:5`;
   `JiraDispatchRequest` at `shared/types.ts:844` with nine fields and no branch fields; `dispatchJira(req)` at `client/src/lib/jira.ts:852`; the service
   takes `JiraDispatchRequest` at `jira-dispatch.service.ts:64,97`; `test/agents-dispatch-jira.test.ts:35`'s `BODY` sends `action: 'execute'` with no
   `mode`. All test files named exist.
4. **Interfaces.** `JiraDispatchRequest` is now one shape (the wire), and the service's input is `JiraDispatchRequest & { choice }` — consistent with
   T8's "five flat fields on Start". One type/behaviour mismatch remains inside T6 (I-1).
5. **Order.** Unchanged; no task consumes a later one.
6. **Tests.** The lock fixture now fails the fetch for the right reason. Two of the changed behaviours have no case pinning them (I-2) or a case that does
   not pin the part that changed (I-3).
7. **Own conventions.** Behaviour and cases, no literal code; 160-column wrap kept.

## Findings

### Important

- **I-1 — plan:331-333 — `mode` is declared an optional wire field, but both routes refuse its absence.** The hunk: "`JiraDispatchRequest` gains the five
  flat optional fields `mode`, `branch`, `base`, `openMr`, `target`". Plan:362 (unchanged): "`/prompt` without `mode` → 400 `mode must be new, continue or
  none`; `dispatch-jira` body without `mode` → 400 same sentence", and plan:364 tells the implementer to add `mode` to every existing dispatch case. A
  type that lets the client omit `mode` compiles a body the server rejects, and `test/agents-dispatch-jira.test.ts:35`'s `BODY` is exactly such a body.
  → Say `mode: 'new' | 'continue' | 'none'` is REQUIRED on the wire and only `branch?`, `base?`, `openMr?`, `target?` are optional (absent `openMr` =
  false, as plan:344 already says).
- **I-2 — plan:159-161 — the detached-tree rewrite is new behaviour with no test case.** Step 6 now turns git's `already used by worktree at '<p>'` /
  `already checked out at '<p>'` into `<branch> is held by the worktree at <p> (detached, likely mid-rebase) — finish or abort there first`, but T2 Step 1
  (plan:166-191) lists no case for it, so the regex and the sentence ship unpinned (the pattern `orchestrate.mjs:3867` uses is the right one; a typo in
  the copy would go unnoticed). A plain `checkout --detach` in a sibling tree does NOT make git refuse — the tree must be mid-rebase (git reads
  `rebase-merge/head-name`). → Add one case: a sibling worktree on `<branch>` stopped inside a conflicting `git rebase` (two commits touching the same
  line), then `continue` on that branch → exit 4 containing `is held by the worktree at <sibling path>`; `worktree list` unchanged.
- **I-3 — plan:182 — the diverged case does not assert what the C-1 fix changed.** "continue, diverged → exit 4 containing `has diverged`" passes equally
  with the old step-7 placement (tree created, then exit 4) and the new step-4 one. The sibling `exists` case (plan:177) asserts "`git worktree list`
  unchanged"; this one should too, or the regression review 1 caught can return silently. → Add "`git worktree list` unchanged and `<repo>/.worktrees/`
  absent" to the diverged case, and a second variant where the diverged branch is held by a hand-made sibling tree → exit 4, that tree's HEAD unchanged.
- **I-4 — plan:419-420 — "once per repo when that repo's refs first arrive … never on a later refs reload" leaves one repo's choice in another repo's
  sheet.** The sheet refetches refs on every repo change (plan:412). Pick repo A (defaults computed), switch to B (computed), switch back to A: A's refs
  arrive a second time, which the rule calls a "later reload" and skips — so B's branch name and base stay in the form for A, where they may not exist,
  and the only reader of that mistake is `branchRefusal` at Start time. The rule also says nothing about a refs request that FAILS (network/500 rather
  than `available: false`), in which case no refs ever "arrive" and the previous repo's choice stays. → State it as: defaults recompute (a) when the
  action changes and (b) each time the SELECTED repo's refs transition from `null` to loaded after a repo change — however often that repo was seen before
  — and never while the repo stays the same; a failed refs request counts as unavailable refs (`defaults?.base ?? ''`, name from the pattern). The T8
  case list (plan:422-427) should carry the A→B→A switch: the name field shows A's rendered name again.

### Minor

- plan:211-214 — "`sync` … by name and never by upstream … for the rest from `%(upstream:track)` when the upstream is `origin/<name>`" contradicts itself
  in one sentence. Say: ticket branches by name (`rev-list`); the rest by upstream, `null` without one. Add the T3 case the rule implies: a NON-ticket
  branch on both sides with no upstream → `sync: null`.
- plan:154 — "So every exit 4 leaves nothing created" is not true of step 9 (`the worktree is on <other>, not <branch>`), which fires after creation. Word
  it as "every re-check exit 4 (steps 2–6)"; or make step 9 remove the tree it just made before exiting (then the sentence holds).
- plan:143 — `fs.realpath` of a `--repo` that does not exist throws before any git call. Say a missing path is also exit 4 `<repo> is not a git
  repository`, so the implementer does not invent a fourth sentence.
- plan:127-128 — the USAGE footer and `apiDownMessage` rewordings have no case in T2 Step 1; one `USAGE` substring assertion (`except worktree`, or
  whatever the wording becomes) keeps them from drifting back.
- plan:160-161 — spec §6 (spec:300) says an exit-4 sentence "comes from git or from the re-check"; the rewrite is neither. Append git's line in
  parentheses as `orchestrate.mjs:3869` does — `… — finish or abort there first (git: <fatal line>)` — so the spec's promise still holds.
- plan:447, 455-456 — `JiraSkillsGroup.tsx:13`'s header comment ("The three names the server substitutes … spec §6.4") and the existing case title at
  `test/jira-setup.test.tsx:832` ("names the three placeholders") both say three; say the comment and that case are rewritten, not just the array grown.
- plan:230-231 (T3 realpath) — fine as written; note that `rev-parse --show-toplevel` already prints a realpath, so only the given path needs resolving.
