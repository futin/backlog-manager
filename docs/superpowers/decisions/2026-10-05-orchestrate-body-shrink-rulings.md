# Orchestrate body shrink — execution rulings

Plan: [2026-10-05-orchestrate-body-shrink.md](../plans/2026-10-05-orchestrate-body-shrink.md) (no spec — the plan is its own record). Final whole-branch
review (Opus, `0f8e83a..5b96f99`, with fixes, 0 Critical / 4 Important / 11 Minor):
[2026-10-05-orchestrate-body-shrink-final-review.md](../reviews/2026-10-05-orchestrate-body-shrink-final-review.md).

Rulings made during subagent-driven execution, each as what was decided, why, and what it costs if wrong. The per-task ledger, reports and reviews lived
under the git-ignored `.superpowers/` and are not kept. Rulings without a spec are provisional against the plan's Why, Global constraints and Review focus.

## Size

`SKILL.md`, bytes: 151,246 (150,227 characters) at the plan commit → 146,409 (T1) → 144,619 (T2) → 140,622 (T3) → 131,282 (T4) → 114,875 (T5) → 106,012
(T6) → 105,465 (T7) → 105,951 after the final-review fixes. The ~60k target was soft by the plan's own terms and was not reached: what remains is the clean-run
path every run reads (dispatch, inspect, review, verify, merge). The acceptance measurement — the next real run's injected skill size, off its transcript —
is still to be recorded in the plan's Status line.

## Plan order and scope

- **`leftover`, `worktree` and `cleanup` stay three subcommands**, as the plan states. Each verdict table stays small. Cost if wrong: one extra CLI entry.
- **Tasks ran strictly 1 → 8; Task 7 (`inspect`) was conditional on the body staying over 65,000 after Task 6.** It was 106,477 characters, so Task 7 ran.
  Cost if wrong: one extra subcommand.

## Gaps filled during execution

- **§4's tracker-pull base-tree scan stays a literal one-liner in the body** (Task 1 fix round), not folded into `leftover`/`worktree`: re-resolving the
  base tree per item is the safety property, and a stale `baseTree.path` was the review's finding. Cost if wrong: ~300 characters.
- **`baseTree.created` is per-path, and a later `merge-check` in another tree overwrites it** — accepted. It only happens after the run's own `_base` tree
  stopped holding the base, so §10 not removing it errs toward a leftover directory, never toward deleting a tree the person made. Cost if wrong: one stale
  `.worktrees/_base-*` directory after a run.
- **`references/tracker.md` is read on both entry paths**: before §1 on a fresh run, and in `recovery.md` after `claim` and before `reconcile` on a
  resume/unpause. The plan said "before §1", which assumed one entry path; the intent was "a tracker run reads it once". Cost if wrong: one extra line in
  `recovery.md`.
- **Git or tool stderr never rides a `--detail`/`--note`.** `leftover`'s park detail is fixed wording with git's line in a separate `gitError` field (Task
  2 review). Every later dispatch carried this as a standing rule.

## Final-review fixes

One fix commit (`457cfc4`); a scoped re-review found all four fixed and no new Critical or Important. Full suite after it: jest 2631 pass / 1 skip, skills
925 pass / 1 skip, typecheck clean.

- **The retry is inspected on its own transcript** (`inspect <id> --jsonl "<dir>/logs/<id>-retry-1.jsonl"`). Before, "come back to this step" re-ran
  `inspect` on the first session's transcript, so a refused retry could merge.
- **`inspect` with no transcript in this run's `logs/` and no `--jsonl` still stages and reads the item**, printing `usage: "no-transcript"`,
  `denials: null`, and the body reads `null` as unknown, never clean. `init` archives the previous run's `logs/`, so the reattach and resume-onto-leftover
  paths hit this. An explicitly named missing `--jsonl` still exits 1 with nothing written. Cost if wrong: one more output value.
  - Superseding half of the same ruling: the ruling also said a malformed default transcript keeps exiting 1. It does not, and that is correct —
    `readPermissionDenials` skips unparseable lines by design, unchanged by this branch; an unreadable path (a directory at the path) still exits 1.
- **`recovery.md`'s abort path carries its own failed-delete instruction** (`rm -rf` the literal `"$PWD/.worktrees/<id>"`, then `test ! -e`; never
  `--force`, never `prune`). It used to point at `cleanup`, which refuses any stage but `merged`/`branched`, so no abort could reach it.
- **`merge-check`'s probe stays tracked-only; the pre-merge refusal gets a fixed-words hand-park fallback.** git also refuses over untracked files the probe
  cannot see, and `--park-on-overlap` then printed `merge` and parked nothing — a loop. Widening the probe is new scope. Cost if wrong: an item whose only
  overlap is an untracked file parks instead of merging.

## Process

- **The controller applied two one-line doc fixes itself** (Task 3's stale one-home pointer in `invariants.md`, Task 8's bytes-versus-characters unit)
  instead of resuming the implementer: no judgment involved, and the covering guards ran green after each. Cost if wrong: none.

## Deferred

The final review ruled each known Minor safe to defer (its "Rulings on Already known" table) and listed 11 Minors, M1-M11, in the review file linked above.
Out of this plan's scope and worth their own backlog items: the pre-existing `--detail` sites that quote git's or the classifier's message
(`references/tracker.md`, `SKILL.md` §9, `references/check-failures.md`), and extending the no-history guard to run ids.
