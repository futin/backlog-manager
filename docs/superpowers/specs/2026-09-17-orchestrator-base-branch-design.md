# Run-scoped base branch for the orchestrator

Status: approved 2026-09-17. Source item: idea-13.

## Why this exists

`backlog-orchestrate` can finish an item into `main` and nowhere else. `--base` already exists in `orchestrate.mjs`, but it is a **queue gate only** — it
decides which items are visible at a ref (`buildGatedQueue`, `BASE_REF_DEFAULT = 'main'`) and nothing downstream reads it. Everything past the gate names `main`
outright: §4's `worktree add .worktrees/<id> -b backlog/<id> main`, §9's `symbolic-ref HEAD` precondition against `refs/heads/main`, its
`diff --name-only main...backlog/<id>` probe, its bare `git merge --no-ff --no-edit` in the main tree, the conflict-recovery `merge --no-edit main` inside the
item worktree, and CLAUDE.md's invariant stating the rule as "merged into `main` in the main tree". `POST /api/agents/orchestrate` cannot express anything else
either: the enumerated list of what a caller may influence is `ids`, ` --merge-mode branch` and ` --question-mode decide`.

So a queue can only ever be drained onto `main`. Two pieces of work are blocked on that today:

- **The tracker-backed backlog** (idea-12 → task-43 → phases 2–6). It is an experiment that should not touch `main` until it is proven end to end. Phase 1 had
  to be merged onto a hand-made `feature/tracker-backed` branch by hand, and every later phase would have to be hand-driven too — against this repo's own rule
  that runs are started from the board.
- **The FE redesign** (`docs/superpowers/specs/2026-09-15-fe-redesign-design.md`). A multi-item visual change wants one branch to look at whole, not a series of
  merges into `main`.

Branch mode is not the answer to either. It leaves every item on its own `backlog/<id>` branch with nothing integrating them, so the second item never builds on
the first — SKILL.md §9 says so outright ("The next item still branches from an **unchanged `main`**"). A phased feature needs the opposite: each item starting
from the previous one's result, on a branch that is not `main`.

## Non-goals

- **Creating a branch.** The base must already exist. An endpoint that spawns runs is not an endpoint that invents refs.
- **A Settings default.** Absent means `main`, per launch, every time. A stored base outliving the experiment it was set for would silently send later runs onto
  a stale feature branch, which is a worse failure than re-picking it — and unlike `mergeMode`, whose two values are both permanently sensible, a base is
  temporary by construction.
- **Merging the base into anything.** Landing `feature/x` on `main` when the experiment is proven stays a human act.
- **Pushing.** Unchanged: this skill does not push, on any branch.
- **A second base per item.** The base is run-scoped, exactly as merge mode and question mode are.

## 1. Vocabulary

- **base** — the branch a run's items are gated at, cut from, and merged into. Default `main`.
- **the main tree** — the project's original checkout, the one the registry points at. It is the tree `orchestrate.mjs` refuses to run outside of, and it is
  **not** synonymous with "the tree holding `main`", which is the confusion this whole design turns on.
- **the base tree** — whichever working tree has `<base>` checked out at merge time. Usually the main tree; for a feature-branch run, a worktree.
- **the item worktree** — `.worktrees/<id>`, on `backlog/<id>`, created per item and removed when it merges.

## 2. Where the merge happens

This is the load-bearing section: everything else is plumbing.

A worktree dedicated to the base cannot be the uniform answer, because git refuses to check a branch out twice:

```
$ git worktree add /tmp/probe-main main
fatal: 'main' is already used by worktree at '/Users/andrejajevtic/Documents/custom-projects/backlog-manager'
```

Forcing it (`--force`) is off the table — two trees on one branch is exactly the state this skill's "authority stops at worktrees it created itself" rule exists
to avoid. So the rule is not "merge in a base worktree", it is:

> **Merge in whichever tree has `<base>` checked out. If no tree has it, create one; remove only what this run created.**

Three outcomes, resolved with `git worktree list --porcelain`, which lists the main tree and every linked worktree with the branch each holds:

1. **A tree holds `<base>`** — merge there. For a `main`-based run on an ordinary machine that is the main tree, so the whole path is byte-identical to today's.
   For `feature/tracker-backed` it is whatever worktree the human already made for it.
2. **No tree holds it** — the run creates `.worktrees/_base-<sanitised ref>` at `<base>`, merges there, and removes it at the end of the run. `_base-` is
   prefixed so it can never collide with an item worktree (`.worktrees/<id>`, and no item id starts with `_`), and the ref is sanitised because a branch name
   may contain `/`.
3. **The tree holding it is unusable** — detached HEAD, mid-rebase, mid-bisect — park, exactly as today's `symbolic-ref` failure path does.

The run removes a base worktree **only if it created it**. A worktree the human made is theirs, and the same sentence that keeps this run from
`worktree prune`-ing or `-D`-ing anything applies here.

### 2.1 What moves with it

Both of §9's preconditions are about the tree being written to, so both follow it there:

- `git -C "<base tree>" symbolic-ref HEAD` must print `refs/heads/<base>`, and must succeed. The two failure readings are unchanged — another ref means someone
  switched branches mid-run; a non-zero exit with `fatal: ref HEAD is not a symbolic ref` means a detached HEAD — and so is the refusal to check anything out on
  the user's behalf.
- The dirty-path overlap probe runs in the base tree: `git -C "<base tree>" diff --name-only <base>...backlog/<id>` against that tree's own unstaged and staged
  paths. A dirty base tree is still fine as long as the dirt does not overlap.

And the merge itself becomes `git -C "<base tree>" merge --no-ff --no-edit backlog/<id>`, where today's command has no `-C` and relies on the main tree being
the cwd.

### 2.2 The rest of the loop

- §4 cuts the item worktree from the base: `git -C "$PWD" worktree add .worktrees/<id> -b backlog/<id> <base>`. The paragraph explaining that this is legal
  while `main` is checked out elsewhere still holds for any base — the branches differ, so nothing is locked.
- §9's conflict recovery inside the item worktree pulls the base: `git -C "$PWD/.worktrees/<id>" merge --no-edit <base>`.
- §9's "each item starts from the updated `main`" becomes "the updated `<base>`", which is the property that makes a phased feature work at all.
- §1's gate reads each candidate at `<base>`, which is what `--base` already does. Its parked detail ("not committed on main — the worktree this run creates
  from main would not contain…") names `<base>` instead.
- `branch` mode is untouched. It writes to no tree, so it has no base tree, and its "the next item still branches from an unchanged base" caveat is the same
  sentence with one word changed.

## 3. How the base travels

Exactly `mergeMode`'s route, because that seam is built, pinned and understood: chosen per launch, sent on every launch, carried spawn → prompt → `init` → run
file, and read from the run file by everything downstream rather than re-derived.

- **`shared/types.ts`** — `OrchestratorRun.base: string`, required, `'main'` for a run that did not ask for anything else. Not optional: an absent field would
  make every reader re-implement the default, which is the mistake `mergeModeEffective` exists to avoid on the neighbouring field.
- **`orchestrate.mjs init`** — `--base <ref>` is already parsed for the gate; it now also records `base` in `run.json`. Every later command reads it from there.
  `init` refuses a base that is not an existing local branch (exit `1`, naming it) before it writes anything.
- **The server** — `POST /api/agents/orchestrate` accepts `base`, validates it, and appends ` --base <ref>` off its own guard, in the composition's existing
  order. Absent means `main` and appends nothing, so a request that predates this feature composes the identical prompt it composes today.
- **The client** — the Orchestrate sheet's step 3 gains a base picker beside the two mode pickers, listing the project's local branches, defaulted to `main`.
- **`orchestrate.mjs resume`** — re-reads the recorded base and re-resolves the base tree, since the tree that held it may have moved in between. It never
  re-derives a default.

### 3.1 Validation

An existing local branch and nothing else. A tag, a SHA, a remote-tracking ref (`origin/x`) and a branch that does not exist are all refused, because a run
merges **into** the base and only a local branch can move. The server answers `400`, never a clamp — the same rule `mergeMode` and `questionMode` follow for a
present-but-invalid value — and the tool re-checks at `init` rather than trusting the caller, because the tool is also driven by hand.

Two checks, in this order: the string is a legal ref name (`git check-ref-format --branch`), and `refs/heads/<base>` exists in that project
(`git show-ref --verify --quiet`). The first is what keeps a caller-supplied string away from anything that could be read as a flag or an option.

## 4. The client

- **The Orchestrate sheet** — a base picker, per launch, no stored default, seeded to `main`. The branch list comes from a new read:
  `GET /api/agents/branches?project=` (local branches only), fetched once per sheet open, the same cadence and the same silent-failure rule the `uncommitted`
  and `merge-check` reads already follow. A failed fetch leaves the picker with `main` alone rather than blocking a launch.
- **The Runs detail sheet** — renders the run's base. Which branch a run wrote to is not recoverable from anything else after the fact, so a runs history that
  omits it is a history that lies by omission. A `main` run renders it too; a field that appears only sometimes reads as an anomaly.
- **The Orchestrate sheet's merge-check hint** (§6 of the sheet's own brief) already asks whether this project's Claude Code settings grant `git merge`; that
  question is about the command, not the branch, so it is unchanged.

## 5. Invariants that move

- CLAUDE.md's **"`backlog-orchestrate` is the only skill that commits or merges"** entry states "merged into `main` in the main tree, `--no-ff` only, only once
  the main tree is verified to have `main` actually checked out". It becomes the base-tree rule, with the merge site named as a derived thing rather than a
  fixed one.
- A new `invariants.md` section, **"The merge happens in whichever tree holds the base, and the run removes only the tree it made"**, carrying §2's reasoning:
  why a uniform base worktree is impossible, why `--force` is not the way round it, and why a human's worktree is never removed.
- CLAUDE.md's **"The orchestrate spawn prompt is composed server-side"** entry enumerates what a caller can influence; `base` becomes its third member, with the
  same "each appended only off its guard, each default appending nothing" phrasing.
- `.claude/rules/orchestrator.md` gains a pointer to the new anchor.

## 6. Testing

- **`orchestrate.test.mjs`** — `init --base` records the base; `init` refuses a tag, a SHA, `origin/main`, a nonexistent branch and a malformed ref name; a run
  file with no `base` reads as `main` for an older run; `resume` reads the recorded base rather than a default.
- **`test/agents-prompt.test.ts`** — the composed prompt gains ` --base <ref>` only when asked, in the existing order, and a default-base request composes the
  byte-identical prompt it composes today. This suite already pins the composition, so the assertion goes where the rule lives.
- **`test/agents-orchestrate.test.ts`** (or wherever the endpoint's 400s live) — a malformed or nonexistent base is a 400 before anything spawns.
- **The base-tree resolution** is the one piece that is prose in SKILL.md rather than code in the tool, so it is pinned the way this repo already pins skill
  prose: cases in `skills/backlog/tools/backlog.test.mjs`'s style, reading `SKILL.md` and asserting it states the three outcomes and the "removes only what it
  created" rule. A rule that exists only in prose is exactly the kind that drifts.
- **The client** — the picker sends the base on every launch, including when untouched; the Runs detail sheet renders it.

## 7. Risks

- **A base that moves under a run.** Someone pushes to or commits on `feature/x` mid-run. `main` has the same exposure today and the answer is the same — the
  next item starts from the updated ref — but a feature branch is far likelier to be touched by a human mid-run. No mitigation beyond the existing dirty-path
  probe, which is per item and runs immediately before each merge.
- **A base worktree left behind by a crashed run.** The run removes what it created at the end; a crash between creating and removing leaves
  `.worktrees/_base-<ref>` on disk. The prefix is what makes it recognisable, and the next run's outcome (1) simply reuses it — which is correct, not a leak.
- **Two runs, two bases, one repo.** Out of scope: one run per project is already enforced twice (`init` refuses a running run file; the endpoint re-checks).
