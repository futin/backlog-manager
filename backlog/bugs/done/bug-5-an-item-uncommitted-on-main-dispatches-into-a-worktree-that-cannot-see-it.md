---
id: bug-5
title: An item uncommitted on main dispatches into a worktree that cannot see it
created: 2026-09-01
tags: orchestrator, skills
updated: 2026-09-01T10:15:45Z
groom-elapsed: 282
started: 2026-09-01T10:03:44Z
execute-elapsed: 721
---

## Symptom

An item that has been groomed but whose file is not yet committed on `main` passes
`plan` and `init` as `ready`, gets a worktree, and is dispatched — into a worktree
whose `backlog/` does not contain it. `git worktree add … main` checks out `main`'s
*commit*, and the item exists only in the main tree's working copy.

The headless session does not fail. It finds the item by absolute path in the main
tree and works there: on run-20260901-073202 (task-7) it appended `## Outcome` to
`/…/backlog-manager/backlog/tasks/open/task-7-….md` with `cat >>` and moved that file
to `tasks/done/`, then filed a new capture (bug-4) into the main tree's `backlog/`
too. Meanwhile the code changes landed correctly in the worktree.

The result is one item split across two trees: its code on `backlog/<id>`, its
lifecycle uncommitted in the main tree. The branch carries no archive move, so the
merge commit for that item does not close it out; the item's own archive arrives
later as a loose working-tree change with no commit of its own, and anyone reading
`main`'s history sees a merge that changed only source files.

Nothing warns. Every stage — plan, init, execute, review, verify, merge — reports
success, and the run summary reads 1/1 merged.

## Repro

1. Groom an item so it reads `ready`, but do not commit its file.
2. `orchestrate.mjs plan --project "$PWD" --ids <id>` → `ready`. `init` accepts it.
3. `git worktree add .worktrees/<id> -b backlog/<id> main`.
4. `ls .worktrees/<id>/backlog/tasks/open/` — the item is absent.
5. Dispatch `claude -p "/backlog-execute <id>"` in that worktree. The session
   completes; `git -C .worktrees/<id> status` shows code changes and no item file,
   while `git -C "$PWD" status` shows the item archived in the main tree.

## Affects

- skills/backlog-orchestrate/tools/orchestrate.mjs — `buildGatedQueue` and the
  `plan`/`init` commands read the item store from the working tree, which is the
  right store for a board and the wrong one for deciding what a worktree will
  contain.
- skills/backlog-orchestrate/SKILL.md:§4 — `git worktree add … main` is the step
  where the two views diverge; nothing between it and dispatch re-checks that the
  item survived the checkout.
- skills/backlog/tools/backlog.mjs:94 — `resolveRoot` is *not* at fault and should
  not be changed: its `existsSync` walk handles a worktree's `.git` file correctly
  and would have resolved to the worktree. The session bypassed it entirely by
  operating on an absolute path it found by searching.

## Cause

`plan`/`init` gate on the working copy; the worktree is built from `HEAD`. The two
disagree for exactly as long as an item is uncommitted, which is the normal state of
an item the moment grooming finishes — so the window is not an edge case, it is the
default one for "groom, then immediately run".

Why it degrades into a cross-tree write rather than a clean refusal: the item is
genuinely missing inside the worktree, so `backlog.mjs show <id>` there exits 1, and
a capable session treats that as a lookup problem rather than a stop condition. It
searches, finds the only copy that exists — the main tree's — and proceeds. Every
guarantee the worktree exists to provide (isolation, one item's diff, a reviewable
branch) is silently out of scope for those writes, and
`--dangerously-skip-permissions` means nothing prompts.

What a fix has to choose between, for whoever grooms this:

- refuse at the gate — `plan`/`init` compare each candidate's path against
  `git ls-files`/`HEAD` and mark an uncommitted item `ungroomed` (or a new verdict)
  with "not committed on main" as the reason;
- verify after the checkout — the loop re-checks that the item file exists inside the
  freshly created worktree and parks it if not, which also catches an item committed
  on a different branch;
- commit it first — the orchestrator stages and commits pending `backlog/` changes on
  `main` before starting, which contradicts "the only thing this skill commits is a
  worktree branch" and would need that invariant amended deliberately, not quietly.

The second is the cheapest and catches strictly more cases than the first; the third
is the only one that lets a just-groomed run proceed without a manual step.

## Fix

Three changes, in this order. The first two are the two options the Cause weighed
(refuse at the gate, verify after the checkout) and they are both taken rather than
one: the gate is where a run can still refuse cheaply and where the *board's* preview
reads from, the post-checkout probe is what covers every case the gate cannot see. The
third is what turns any future recurrence from a silent cross-tree write into a loud
refusal, and it is the only one that also protects a hand-run `backlog-execute`. The
third option the Cause lists — commit `backlog/` on `main` from inside the orchestrator
— is **not** taken: it contradicts "`backlog-orchestrate` commits inside a per-item
worktree, on `backlog/<id>` alone" and buys only the removal of one manual `git commit`
that the operator is better placed to make than an unattended run is.

This is behaviour, not code. Signatures and exact expected values are binding; how the
git read is spelled is the implementer's call, and disagreeing with a step here is
expected if the code says otherwise.

### 1. Gate the bytes the worktree will actually get — `skills/backlog-orchestrate/tools/orchestrate.mjs`

Today `buildGatedQueue` calls `readItemForGate(entry.path)` — the working copy. It must
instead gate the item's content **at the ref the worktree is created from**, because
that is the only content the dispatched session will ever see.

- Add a `--base <ref>` flag to `plan` and `init`, defaulting to `main` — the same
  literal `main` that `SKILL.md` §4's `worktree add .worktrees/<id> -b backlog/<id> main`
  already hardcodes. The flag exists so the coupling between the two is explicit and so
  a trunk named something else is workable; `SKILL.md` keeps using the default
  everywhere and does not grow a new argument to thread through the loop. Deliberately
  **not** recorded in `run.json` — that is a `shared/types.ts` schema change for a value
  the loop can pass on each `plan` call.
- For each candidate, derive the item's repo-relative path from `projectRoot` and read
  its blob at `<base>:<relpath>` (a read-only plumbing read — `cat-file`/`show`, never
  anything that touches the index or the working tree). Then:
  - **blob missing at that ref** → gate `ungroomed`, with exactly one reason naming both
    the condition and the path, in this shape:

    ```
    not committed on main — the worktree this run creates from main would not
    contain backlog/tasks/open/task-7-<slug>.md
    ```
  - **blob present** → gate *those* bytes through the unchanged `gateItem`/`gateTask`/
    `gateBug`. This is what also closes the sibling defect the Cause implies but the
    Symptom never reached: an item committed while ungroomed and groomed only in the
    working copy currently reads `ready` and dispatches into a worktree holding the
    ungroomed version, where `backlog-execute` refuses it and the whole item is spent for
    nothing. After this change it reads `ungroomed` with the ordinary
    empty-`## Plan`/placeholder-`## Fix` reason, which is the truth about what the
    worktree holds.
  - **`projectRoot` is not a git work tree, or `<base>` does not resolve there** → fall
    back to the working copy, exactly as today, and add no reason. Keeps `plan` usable
    against a bare store (this tool's own `fixtures/store/` is precisely that) and keeps
    every existing gate test meaningful. The fallback is not a hole: layer 2 below is
    what covers it, and layer 2 runs unconditionally.

Verdict stays **`ungroomed`**; no new stage value. A new one would mean a new member in
`RUN_STAGES` here, in `shared/types.ts`'s `RunStage`, in the server's view of it, in the
run drawer's rendering, and in `docs/`, for a state whose handling is byte-identical to
the one that already exists — §3's `ungroomed` branch records it with
`stage <id> ungroomed --note "<the gate's own reason>"` and moves to the next item,
which is exactly the right outcome. The distinction lives in the reason string, which is
the thing the drawer actually shows. Noted here rather than left implicit because
"groomed but uncommitted" genuinely is not ungroomed, and a future reader deserves to
know the mismatch was chosen and why.

Two things must **not** change: `plan` still writes nothing at all (no index write, no
stash, no checkout — the existing "writes nothing" guarantee now covers git state too),
and `findUnresolvedCommands`' reads of `backlog/verify.json` and `package.json` stay on
the working tree. Those are project config a human is looking at right now, not item
content that has to match the worktree, and that check can only ever add a warning.

Side effect worth stating: because `readyCount` only counts `ready` items, an
uncommitted item no longer consumes a `--max` slot, so a capped run now reaches further
down the queue. That is correct — the cap bounds how many items a run will dispatch.

### 2. Prove the item survived the checkout — `skills/backlog-orchestrate/SKILL.md` §4

After `worktree add` succeeds and **before** the pre-flight answer is written or the
session is dispatched, ask `backlog.mjs` from inside the new worktree whether the item is
there — run `show <id>` with the worktree as cwd, so its own `.git`-ancestor walk
resolves to the worktree (`resolveRoot` handles a worktree's `.git` file correctly; per
the Affects section it is not at fault and is not changed).

- **exit 0** → carry on to dispatch as today.
- **exit 1** → park, keeping the worktree and the branch, like every other park path in
  the file: `attention <id> --kind parked --detail "<id> is not present in the worktree
  checked out from main — commit backlog/ on main, then re-run"` followed by
  `stage <id> parked`. Delete nothing, `prune` nothing.

This layer catches strictly more than layer 1, which is why it is worth having both: the
non-git fallback above, a main tree not actually on `main`, an item committed on some
other branch, a race between the gate and the checkout, and any later drift between §4's
base ref and the gate's default.

### 3. Refuse instead of hunting — `skills/backlog-execute/SKILL.md`

The reason this degraded into a cross-tree write is in the Cause: `show <id>` exited 1
inside the worktree and the session treated that as a lookup problem. Close that
explicitly.

- In "Pick an item": the **only** way to locate an item file is
  `backlog.mjs show <id>` from the session's own cwd. Exit 1 means stop and say the item
  is not in this tree — never find it by `grep`/`find`/glob, and never work an absolute
  path belonging to another tree even when one plainly exists.
- In "Hard limits": this skill writes only under the repo root that `show` resolved.

Layers 1 and 2 stop this run's split; layer 3 is what makes the next occurrence park or
refuse rather than quietly archive an item in somebody else's tree, and it applies to
sessions no orchestrator started.

### Test cases

Skill tests, node's own runner, in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`
alongside the existing `plan` cases. They need a new git-backed fixture helper beside
`planFixture`: copy `fixtures/store/`, `git init` it with trunk named `main` and a local
identity, commit everything as the first commit, then let each test diverge the working
copy from that commit. The existing non-git `planFixture` cases stay exactly as they are
and must all still pass — that is the fallback's regression test.

1. **Committed and groomed reads ready.** `plan --ids task-1 --json` on the git fixture →
   exit 0, `gate: 'ready'`, `reasons: []`.
2. **Uncommitted item is refused, and the reason names it.** After the commit, add
   `backlog/tasks/open/task-9-<slug>.md` with a real `## Plan`. `plan --ids task-9 --json`
   → exit 0, `gate: 'ungroomed'`, exactly one reason, matching `/not committed/i` and
   containing the literal `backlog/tasks/open/task-9-<slug>.md`.
3. **Committed ungroomed, groomed only in the working copy, still refused.** `bug-2`'s
   committed `## Fix` is exactly `unknown`; rewrite the working copy so its `## Fix` is
   real prose. `plan --ids bug-2 --json` → `gate: 'ungroomed'` with the ordinary
   placeholder reason (matching `/fix/i`), **not** `ready`. This is the case that proves
   the gate reads the committed blob and not the file on disk.
4. **`--base` is honoured.** Commit the new `task-9` on a branch `trunk` only, leaving
   `main` without it: default → case 2's verdict; `--base trunk` → `gate: 'ready'`.
5. **`init` still queues by membership, and `--max` now counts only committed-ready
   items.** With `task-9` uncommitted and `task-3`/`task-5` as the fixture has them,
   `init --project <git fixture> --ids task-9,task-1 --max 1` exits 0 and its `run.json`
   queue contains both ids in that order — `task-9` no longer consumes the single ready
   slot, so `task-1` is inside the cap rather than pushed past it.
6. **`plan` writes nothing, git state included.** On the git fixture: the existing
   `snapshotTree` comparison, plus `git status --porcelain` byte-identical before and
   after, plus `git rev-parse HEAD` unchanged.
7. **A dirty main tree is not an error.** Modify an unrelated tracked file (not an item),
   then repeat case 1 → same verdicts, exit 0.
8. **Fallback is silent.** `plan --ids task-1 --json` against the non-git `planFixture`
   → exit 0, `gate: 'ready'`, and no reason mentioning commits anywhere in the output.

Layers 2 and 3 are prose in two `SKILL.md` files and have no automated test. Verify them
by hand against this item's own Repro: at step 5 the loop must park with the detail from
layer 2 naming the missing item, and `git -C "$PWD" status` afterwards must show no
archive move and no new capture in the main tree.

Then: `pnpm run test:skills`, `pnpm test`, `pnpm run typecheck`. The `SKILL.md` edits
reach an install only after commit, push and `pnpm run plugin:sync`.

## Outcome

2026-09-01 — fixed, all three layers as the Fix specifies.

**Layer 1 (`orchestrate.mjs`).** `buildGatedQueue` now gates each candidate's blob at
`<base>` (`--base <ref>` on both `plan` and `init`, default `main`) instead of the working
copy. `readItemForGate` was split into a reader and a `parseItemForGate(text)` so the same
parser serves a file on disk and a blob out of `git show`; `blobReaderAt(projectRoot, base)`
is the read-only probe (`rev-parse --show-toplevel`, `rev-parse --verify <base>^{commit}`,
`git show <base>:<relpath>`) and returns `null` — falling back to the working copy exactly
as before, with no added reason — when the project root is not itself the top of a git work
tree or `<base>` does not resolve. `--show-toplevel` is compared against the project root
rather than trusting `--is-inside-work-tree`, so a `--project` that merely sits inside some
other repository takes the fallback instead of gating every item against blobs from the
wrong root. Verdict stays `ungroomed`; no new `RUN_STAGES` member.

**Layer 2 (`backlog-orchestrate/SKILL.md` §4).** A post-checkout probe —
`( cd .worktrees/<id> && backlog.mjs show <id> )` — between `worktree add` and both the
pre-flight answer write and dispatch; exit `1` parks with the detail the Fix names, keeping
the worktree and the branch. The "exactly one exception" rule at the top of the file (about
running `backlog.mjs` inside a worktree) now reads "exactly two" and names this one.

**Layer 3 (`backlog-execute/SKILL.md`).** "Pick an item" now states that `show` is the only
way to locate an item file and that exit `1` is a stop condition — never `grep`/`find`/glob,
never an absolute path belonging to another tree — with the run-20260901-073202 incident
written out as the reason. A new hard limit: this skill writes only under the repo root
`show` resolved.

Not taken, as the Fix directs: the orchestrator does not commit `backlog/` on `main`.

### Verification

Red first. The four new cases that pin changed behaviour failed against the old gate, for
the right reason (`ready` where `ungroomed` was expected — the defect itself), while the
four that pin unchanged behaviour passed:

```
ok 46 - plan on a git store: a task committed on main with a real \#\# Plan is ready, with empty reasons
not ok 47 - plan on a git store: an item groomed only in the working copy is ungroomed, and the reason names the path the worktree would lack
not ok 48 - plan on a git store: a bug groomed only in the working copy still gates on the committed placeholder
not ok 49 - plan --base gates against the named ref: an item committed on trunk alone is ready there and uncommitted on main
not ok 50 - init on a git store: an uncommitted item stays in the queue and no longer consumes a --max slot
ok 51 - plan on a git store writes nothing: the store, the state dir, git status and HEAD are all unchanged
ok 52 - plan on a git store: an unrelated dirty tracked file changes no verdict
ok 53 - plan against a store that is not a git work tree falls back to the working copy and mentions no commit
```

```
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 'ready'
    - 'ungroomed'
```

Green after. `pnpm run test:skills`:

```
1..241
# tests 241
# suites 0
# pass 241
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 38631.63925
```

`pnpm test`:

```
Test Suites: 33 passed, 33 total
Tests:       444 passed, 444 total
Snapshots:   0 total
Time:        19.636 s, estimated 25 s
```

(One run in between failed `test/agents-dispatch.test.ts` with `Parse Error: Expected
HTTP/, RTSP/ or ICE/` — a supertest flake in a suite this change does not touch. It passed
16/16 in isolation and the full suite is green above.)

`pnpm run typecheck`:

```
$ tsc --noEmit
```

Layers 2 and 3 are prose and have no automated test, so both were verified by hand against
this item's own Repro, on a git-backed copy of `fixtures/store` with a groomed-but-
uncommitted `task-9`. Step 2 now refuses instead of reading `ready`:

```
ungroomed     task-9  Uncommitted but groomed
    - not committed on main — the worktree this run creates from main would not contain backlog/tasks/open/task-9-uncommitted.md
```

and step 4's probe discriminates correctly inside a worktree created from `main` — exit `1`
(`unknown id: task-9`) for the uncommitted item, exit `0` for a committed one:

```
REPRO STEP 4-5 (layer 2) — probe inside a worktree built from main:
unknown id: task-9
present=1

control — probe for an item that IS committed:
present=0
```

The `SKILL.md` edits reach an install only after commit, push and `pnpm run plugin:sync`;
this skill commits nothing.
