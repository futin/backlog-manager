---
id: task-33
title: Verify the three moved subsystem docs against the code and stamp them
created: 2026-09-07
---

## Goal

`docs/subsystems/api.md`, `board.md` and `skills.md` carry `sources:` and `kind:` but no
`verified:` baseline, so `docs-sync` reports all three `unstamped`. That is accurate
rather than an oversight: their prose was moved out of `README.md`'s Architecture section
and `CLAUDE.md`'s Layout section in a5f2eb5, and a stamp asserts someone read a doc's
claims against the code at that commit — moving a sentence is not reading it.

Close that: read each doc against the tree it names, correct whatever the move left stale
or mis-registered, and stamp it. Three `unstamped` lines that nobody ever clears become a
report people learn to skim, which is the failure mode the whole mechanism exists to
avoid.

## Plan

Work one doc at a time; each is its own read, its own correction and its own stamp
commit, because a batch of three stamped after one reading is three chances to have been
confidently wrong in the same way.

1. **`docs/subsystems/api.md`** — sources `server/src`. Read every module it describes:
   `items/` (including `git-dates.util.ts` and `uncommitted.util.ts`, whose opposite
   caching postures the doc asserts), `agents/` (the route list, the `BM_AGENTS` gate,
   which routes never call the dashboard, `origin.guard.ts`), `orchestrator/` (the three
   endpoints, the two in-memory services, the two files the server writes), `registry/`,
   `health/`, `static.ts`, `security.ts`. Check the route paths and the claims about what
   is cached, since those are the sentences most likely to have drifted before the move.
2. **`docs/subsystems/board.md`** — sources `client/src`, `shared/types.ts`. Read the four
   section components, the `OrchestrateSheet` three-step description, `RunStrip` /
   `RunDrawer` / `RunControls`, the hook cadences it lists, and the `lib/` derivations it
   claims have one home each. The staleness prose came from README and describes behaviour
   the tests pin, so `test/item-stale.test.ts` and friends are the better source for it
   than the components.
3. **`docs/subsystems/skills.md`** — sources `skills`, `agents`. Read the five `SKILL.md`
   files plus `agents/backlog-reviewer.md`. The table of what each skill does and the
   "only orchestrate touches git" claim are the load-bearing ones.
4. For each: fix what is wrong, then
   `node ~/.claude/skills/docs-sync/tools/provenance.mjs --repo . --stamp <doc>`, then
   commit the prose and the stamp per the skill's own ordering rule (prose committed
   first, so the baseline is a real ancestor of `HEAD`).
5. Re-run the checker and confirm nine docs, none `unstamped`, exit 0.

Then answer the deferred structural question, in the same session but as a separate
decision:

6. **Should `docs/subsystems/invariants.md` stay one doc?** It holds every seam's
   rationale in one file while the three docs above now hold each seam's mechanism, so the
   symmetric shape would be one rationale doc per seam. Deliberately not done in the
   session that created these three, for a reason worth weighing rather than inheriting:
   `CLAUDE.md`'s Invariants section is auto-loaded context for every session and every
   headless orchestrator run in this repo, that section is the index of these rationale
   entries, and ~90 lines of layout detail already left `CLAUDE.md` in 07169eb. Splitting
   the rationale doc changes what a run reads next, so decide it with that in view. A
   defensible answer is "leave it" — the doc is linked from ~89 places and the split buys
   symmetry rather than a fixed failure.

## Test cases

Prose has no unit tests; the checker is the gate, and these are the observable states.

- `node ~/.claude/skills/docs-sync/tools/provenance.mjs --repo .` exits `0` and reports
  nine tracked docs with no `unstamped`, no `stale`, no layout violation and no dead link.
- Each of the three docs' `verified:` sha is an ancestor of `HEAD` (an amend or rebase
  under a stamp reports `baseline-missing`, which is the one state worse than `unstamped`).
- `pnpm test` still passes — no test reads these files, so a failure here means something
  other than the docs changed.
- Spot-check that no claim was invented: every corrected sentence traces to a file read
  during the pass, and anything the code did not settle is left out rather than guessed.

## Done when

All nine tracked docs report `current`, the three stamps name a commit that is an
ancestor of `HEAD`, and the `invariants.md` split question has an answer recorded — either
in `docs/subsystems/invariants.md` itself or as its own backlog item, not left implicit.
