# `in-review` with no open PR: its own reason, and a Lift on the board

Short design, a small change. Approved approach: "new reason + Lift button".

## Why

ixray #214 (2026-11-24): the board refused Execute with `a PR is open for this item`, and no PR existed. An execute on 2026-11-20 had put `in-review` on
the issue and left an Outcome comment saying its work was "committed as `8eabe0d` on branch `execute/214` in the worktree `.worktrees/execute-214`. It is not
pushed." (`skills/backlog-execute/SKILL.md` puts the label on in `in-place` mode on purpose, so nothing executes the item twice while its fix waits to be
pushed; in-place mode commits only when its prompt asks, and cuts no branch or tree of its own — this session's prompt evidently asked for both.) By
2026-11-24 that commit, branch and tree no longer existed in the ixray checkout. The label lifts by itself only when a referencing PR merges into
the default branch (#411, `TrackerPollerService.reviewLifted`), so with no PR it never lifts, and the only way out was a terminal (`backlog.mjs review 214
off`) that nothing on the board names. Two faults: the sentence is false whenever no PR is open, and the board offers no way out.

## Goals

- A tracker item whose `in-review` label is on while **no open PR references it** shows a reason that says so, on the card's disabled Execute and in the
  server's plan/dispatch ladder.
- The item modal offers **Lift review** for such an item: a confirm, then `POST /api/items/review` with `inReview: false` (the route already exists; its
  remover is documented as "a person saying that PR is gone").
- The confirm says what this machine can prove: whether an `execute/<n>` branch or a `.worktrees/execute-<n>` tree exists in the project's checkout. Those
  names prove PRESENCE only. Their absence proves nothing: an in-place execute that ran in the main checkout leaves its fix uncommitted there under no name,
  and work on another machine leaves nothing here at all. The confirm says so in its "not found" text, and Lift stays available in every state — the person
  decides, the probe only informs.

## Non-goals and anti-goals

- **Never lift automatically.** The label is the one guard that works across machines: in-place work sitting unpushed on another machine, or in another clone,
  has nothing on this machine to show for it. "Nothing local" informs the person; it never decides. This is why `executeHeldBlock` (#427) skips tracker items.
- An item whose referencing PR is OPEN keeps `a PR is open for this item` and gets no Lift.
- The skills' hand-kept copies of `IN_REVIEW_REASON` (`orchestrate.mjs`, `backlog-execute`'s SKILL.md and references, `backlog/SKILL.md`) are unchanged:
  they still refuse the item, and the change would need a plugin sync for no gain in what they do. The new sentence is a board and server surface.
- Files items: untouched. They never carry `inReview`.

## Approaches considered

1. **New reason + Lift (picked).** Derived reason, person-driven lift with a local-holding hint. Keeps the cross-machine guard; one click out.
2. **Auto-lift when nothing local holds it.** Zero clicks, but re-executes work that waits unpushed on another machine — exactly what the label exists to stop.
3. **Reason text only**, naming `backlog.mjs review <n> off`. Smallest, but leaves the board with no way out.

## Design

- **Derivation (server).** `TrackerPollerService` gains the question "is a PR referencing this issue open?" — `decidingPull(...) === 'open'`, the same index
  `reviewLifted` reads. `mapIssue` sets a new optional flag on `BacklogItem` (true-or-absent, like `inReview`; name is the builder's) when `inReview` holds and
  no referencing PR is open. That covers every non-open `decidingPull` answer: no PR references it (`null`), the latest closed one did not merge, merged into
  a non-default branch, or merged with its base not learned yet (`reviewLifted` is false there, so `inReview` holds, and no PR is open, so the flag is set).
  `mapIssue` takes the answer as a new trailing parameter whose default is "a PR is open" — a caller with no poller keeps today's sentence and draws no Lift —
  and both callers in `github.source.ts` (the list mapping and the single-item find) pass the poller's answer.
- **Lag.** The PR index is the poller's, so a PR opened after the last sync shows the new reason and the Lift until the repo's next sync — its interval
  (15 s / 1 m / 5 m), and never while sync is off or the repo sleeps on a rate limit. A normal `pr`-mode execute does not pass through it: `pr-mode.md` §8
  pushes, runs `gh pr create`, and only then adds the label, so the PR is already listed by the time the label is. The window is a PR opened after the label —
  by hand, after §8 reported that `gh` was missing or refused — and not yet synced. A Lift inside it removes the guard while a PR is in fact open. Accepted,
  because it takes a person's click past a confirm, and a re-execute on the same machine still stops at `pr-mode.md` §2's refusal of an existing
  `execute/<n>` branch or tree.
- **Reason (shared).** A new constant beside `IN_REVIEW_REASON` in `shared/agent.ts`, exactly `in review, but no open PR references this item`.
  `inReviewBlock` returns it when the new flag is set, else `IN_REVIEW_REASON`; `itemLadderBlock`'s order is unchanged. `IN_REVIEW_REASON`'s "ONE string
  everywhere" comment (`shared/agent.ts`) and `docs/subsystems/invariants.md`'s statement of it become "the board and server say the precise one; the skills'
  copies keep `IN_REVIEW_REASON`" — the skills read only the label and cannot tell the two cases apart.
- **Local hold (server).** `GET /api/items/held?project=<name>&id=<id>`, read-only and unguarded like `GET /api/items/claim`, answering
  `{ branch: boolean | null, tree: boolean }` for `refs/heads/execute/<n>` and `<project path>/.worktrees/execute-<n>` — the `executeHeldBlock` names, per
  request, memoised nowhere, never mapped onto the item. Input gate: blank `project` or `id` is a 400 naming it; the project goes through
  `ItemsService.writerFor` + `writable` like `claim` (unregistered 404, files 400, unsupported 400); `id` (`#214`, `214` or the project's URN) becomes `<n>`
  through `issueNumberFor`, a 400 when it does not parse. The branch read is `runGit(['-C', path, 'for-each-ref', '--format=%(refname)',
  'refs/heads/execute/<n>'])`: non-empty output is `true`, `''` is `false`, `null` (git failed or timed out) is `null` — never "not held". `show-ref --verify
  --quiet` cannot be used: it exits non-zero on a missing ref, which `runGit` cannot tell from a failure. The tree is `existsSync`. The new call site joins
  `.claude/rules/items.md`'s `runGit` call-site list (`null` → `branch: null`) and gets a case in `test/server/git-run.test.ts`.
- **Lift (client).** A component in the item modal in `PlanApprove`'s shape (#367), placed after the dispatch control and before `PlanApprove` and
  `ClaimRelease` (`ItemModal.tsx`'s facts column) — it explains the dispatch control's refusal, so it sits right under it. Shown only for an open item
  carrying the new flag. Chip
  `Lift review` (title `remove the in-review label so this item can be executed again`) → `ui/Confirm` inline, `acceptLabel="Lift review"`,
  `dismissLabel="Keep in review"`. Opening the confirm fires the GET once; its text is one of, with `<id>` the item id and `<n>` its number:
  - pending: `Checking this machine for execute/<n>…`
  - held (branch or tree true): `execute/<n> still holds work for <id> on this machine — push it and open a PR instead. Lift anyway?`
  - not found (branch false, tree false): `No execute/<n> branch or worktree here. Work left uncommitted in a checkout, or on another machine, does not show
    up — lift only once you know it is gone or pushed.`
  - unknown (branch null with tree false, or the GET failed): `Could not check this machine for execute/<n>. Lift only once you know the work is gone or
    pushed.`

- **The `review` write absorbs its result (server).** `GithubSource.review` today writes the label and returns, so the poller cache — and every board read —
  keeps the label until the next sync. It gains `planReview`'s tail for a REMOVAL (an add would land the label in the cache before the next sync indexes
  the PR §8 just opened, showing the new reason for one interval): after a landed removal, re-read the issue and `absorbIssue` it; a failed re-read is not a
  refusal (the label write landed, the next poll catches up). Without it the board's re-read after a Lift still shows the item blocked and the modal offers
  Lift again. `.claude/rules/items.md`'s `review` sentence and `GithubSource.review`'s comment ("Unlike `review` and `queue`") change with it.
- **Lift, continued.** Accept is enabled in every state, pending included, and always does the same thing: `POST /api/items/review` `{ project, id, inReview: false }` → the note
  `review lifted` in place of the chip and a board re-read (`onLifted`, as `onApproved`). A refusal prints the server's sentence verbatim and the chip comes
  back. The card's chip stays a disabled Execute with the new reason (no second control on the card).

## Left to the builder

Flag and component names, and where the poller question lives (a new method or a widened `reviewLifted`). Text to update besides code: the
`.claude/rules/` and `docs/subsystems/` passages that state the in-review reason; `.claude/DESIGN.md` §8.7's item-modal facts paragraph (the new chip, its
position, confirm copy and note, beside its `Approve plan` sentence); `.claude/rules/board.md`'s list of `ui/Confirm` openers;
`ItemModal.tsx`'s header comment on the modal's writes; `.claude/rules/items.md`'s `runGit` call-site list and its note on the one read beside the write
routes; the "ONE string everywhere" statements named above; and the tests that pin `IN_REVIEW_REASON`'s readers (`test/agents/agents-shared.test.ts`,
`test/tracker/tracker-dispatch.test.ts`, `test/tracker/tracker-map.test.ts`, `test/tracker/tracker-review-lift.test.ts`).
