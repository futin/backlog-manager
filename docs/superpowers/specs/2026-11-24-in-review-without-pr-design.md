# `in-review` with no open PR: its own reason, and a Lift on the board

Short design, a small change. Approved approach: "new reason + Lift button".

## Why

ixray #214 (2026-11-24): the board refused Execute with `a PR is open for this item`, and no PR existed. An in-place execute on 2026-11-20 had put
`in-review` on the issue — `skills/backlog-execute/SKILL.md` does that on purpose, so nothing executes the item twice while its commit waits to be pushed —
and its commit, branch `execute/214` and worktree `.worktrees/execute-214` were later lost. The label lifts by itself only when a referencing PR merges into
the default branch (#411, `TrackerPollerService.reviewLifted`), so with no PR it never lifts, and the only way out was a terminal (`backlog.mjs review 214
off`) that nothing on the board names. Two faults: the sentence is false whenever no PR is open, and the board offers no way out.

## Goals

- A tracker item whose `in-review` label is on while **no open PR references it** shows a reason that says so, on the card's disabled Execute and in the
  server's plan/dispatch ladder.
- The item modal offers **Lift review** for such an item: a confirm, then `POST /api/items/review` with `inReview: false` (the route already exists; its
  remover is documented as "a person saying that PR is gone").
- The confirm says whether this machine still holds the work: an `execute/<n>` branch or a `.worktrees/execute-<n>` tree in the project's checkout.

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
  no referencing PR is open: no PR references it, or the latest closed one did not merge into the default branch. A poll's lag can show a just-opened PR's item
  with the new reason for up to one poll; acceptable, the item stays blocked either way.
- **Reason (shared).** A new constant beside `IN_REVIEW_REASON` in `shared/agent.ts`, wording roughly `in review, but no open PR references this item`
  (builder may tune, must stay one sentence). `inReviewBlock` returns it when the new flag is set, else `IN_REVIEW_REASON`; `itemLadderBlock`'s order is
  unchanged.
- **Local hold (server).** A read-only, unguarded GET under `/api/items/...` answering whether `refs/heads/execute/<n>` or `.worktrees/execute-<n>` exists in
  the project's checkout — the `executeHeldBlock` names, via `runGit`, per request, memoised nowhere, never mapped onto the item. A git failure or timeout
  answers "unknown", never "not held". Tracker items only.
- **Lift (client).** A component in the item modal beside `PlanApprove`, same shape (#367): shown only for an open item carrying the new flag; `Lift review` →
  `ui/Confirm` inline, whose text carries the local-hold answer ("execute/214 is still on this machine — push it first" vs "no execute branch or worktree for
  this item here; lift only if the work is gone or lives on another machine") → the POST → a `review lifted` note and a board re-read. A refusal prints the
  server's sentence. The card's chip stays a disabled Execute with the new reason (no second control on the card).

## Left to the builder

Flag and component names, exact wording of the reason and confirm text, the GET route's path and payload shape, and where the poller question lives (a new
method or a widened `reviewLifted`). Update `.claude/rules/` and `docs/subsystems/` text that states the in-review reason, and the tests that pin
`IN_REVIEW_REASON`'s readers.
