---
id: idea-13
title: Run-scoped base branch for the orchestrator: cut worktrees from it, merge into it, and let the board pick one
created: 2026-09-17
tags: orchestrator, runner-fix
updated: 2026-09-17T15:23:05Z
promoted-to: task-44
groom-elapsed: 692
groom-tokens: 84307
---

## Problem

`backlog-orchestrate` can only ever finish an item into `main`. `--base` already exists in `orchestrate.mjs`, but it is a **queue gate only** — it decides which
items are visible at a ref (`buildGatedQueue`, `BASE_REF_DEFAULT = 'main'`) and nothing else. Everything downstream of the gate says `main` outright:

- SKILL.md §9 merges each verified item into `main`, in the main tree, `--no-ff`, only after verifying the main tree has `main` checked out.
- SKILL.md §1 starts each item's worktree from `main`'s commit, and in `merge` mode each item starts from the **updated** `main`.
- CLAUDE.md's invariant states it as a rule: "merged into `main` in the main tree, `--no-ff` only, only once the main tree is verified to have `main` actually
  checked out."
- `POST /api/agents/orchestrate` composes the prompt server-side, and the enumerated list of what a caller can influence is `ids`, ` --merge-mode branch` and
  ` --question-mode decide`. There is no way for the board to ask for a different base at all.

So there is no way to drain a queue onto anything but `main`. The cost showed up twice on 2026-09-17:

- The tracker-backed backlog (idea-12 → task-43 → phases 2–6) is an experiment that should not touch `main` until it is proven end to end. Phase 1 had to be
  merged into a hand-made `feature/tracker-backed` branch by hand, and every later phase would have to be hand-driven too — against this repo's own rule that
  runs are started from the board.
- The FE redesign (`docs/superpowers/specs/2026-09-15-fe-redesign-design.md`) has been waiting on the same thing: a multi-item visual change wants one branch
  to look at as a whole, not a series of merges into `main`.

Branch mode is not the answer. It leaves every item on its own `backlog/<id>` branch with nothing integrating them, so the second item never sees the first —
which is exactly what a phased feature needs.

## Rough shape

Carry `base` the way `mergeMode` is already carried, because that seam is built and pinned: chosen per launch, defaulted from Settings, and travelling
spawn → prompt → `init` → run file (`MergeMode` / `isMergeMode` in `shared/types.ts`, `mergeMode` + `mergeModeEffective` + `mergeModeNote` in the run file). The
pieces that would have to move:

- **`orchestrate.mjs`** — `init` records the run's base in `run.json` so every later command and every reader agrees on one value, rather than each re-deriving
  a default. `--base` keeps its gate meaning; the question is whether `stage`/`verify` need it at all once it is recorded.
- **SKILL.md** — §1's worktree is cut from `<base>`, §9 merges into `<base>`, and the "main tree is on `main`" preflight becomes "the main tree is on
  `<base>`". The prose says `main` in a lot of places and each one has to be re-read rather than sed-ed: some of them mean "the main tree" (the checkout, not
  the branch) and must NOT change.
- **The server** — `POST /api/agents/orchestrate` gains `base` as a new member of the enumerated influence list, validated before it reaches a shell: a ref
  name, refused if it does not exist in that project, and appended as ` --base <ref>` off its own guard the way the two mode literals are. Absent means `main`.
- **The client** — the Orchestrate sheet picks a base; a run's base is visible on the Runs detail sheet, because "which branch did this run write to" is not
  recoverable afterwards from anything else.
- **The invariants** — CLAUDE.md's merge entry and `docs/subsystems/invariants.md`'s section both state `main` as the rule and would state `<base>` instead,
  with the main-tree check restated.

**This is a runner fix**: it changes `orchestrate.mjs` and `backlog-orchestrate/SKILL.md`, so it is inert until it is committed, pushed and
`pnpm run plugin:sync` has run — and per the invariant, a groomed item carrying `runner-fix:` is hoisted to the front of its queue.

## Open questions

- Does the base belong in Settings as a default, or is a per-launch pick the whole feature? `mergeMode` has both; a base default that silently outlives the
  experiment it was set for is a worse failure than re-picking it each launch.
- What happens when the base moves under a run — someone pushes to `feature/x` mid-run? `main` has the same exposure today and the answer is "the next item
  starts from the updated ref", but a feature branch is far more likely to be pushed to by a human mid-run.
- Does a run's base need to be *reconciled* on resume: a `--resume` reads the run file, so it would read the recorded base, but the main tree could have been
  switched to another branch in between. Probably the same refusal the existing main-tree check performs, against the recorded value rather than `main`.
- Should `merge-check` (`GET /api/agents/merge-check`) take the base too? It answers "can this project's main tree receive a merge", which is a question about
  a specific branch.
- Is a base outside the project's own branches (a remote-tracking ref, a tag, a SHA) worth refusing outright? A run that merges into a detached commit has
  nowhere to put the result.
