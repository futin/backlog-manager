---
id: task-44
title: Run-scoped base branch: merge in whichever tree holds the base, carried spawn to prompt to init to run file, picked on the sheet
created: 2026-09-17
from: idea-13
runner-fix: true
updated: 2026-09-17T17:36:24Z
started: 2026-09-17T15:30:52Z
execute-elapsed: 7532
execute-tokens: 563002
---

## Goal

An orchestrator run can drain a queue onto a branch that is not `main`, so an experimental feature (the tracker-backed backlog, the FE redesign) can be built
item by item, each one starting from the previous one's result, without `main` being written to until a human decides it should be. Spec:
[docs/superpowers/specs/2026-09-17-orchestrator-base-branch-design.md](../../../docs/superpowers/specs/2026-09-17-orchestrator-base-branch-design.md).

`--base` already exists as a queue gate and stops there. This task makes the base run-scoped and carries it through the loop: the item worktree is cut from it,
the merge goes into it, the preconditions follow it, `POST /api/agents/orchestrate` can ask for it, and the sheet picks it.

**`runner-fix: true`** — this changes `skills/backlog-orchestrate/SKILL.md` and `orchestrate.mjs`, so it is hoisted to the front of its queue and is inert for
the next run until it is committed, pushed and `pnpm run plugin:sync` has run.

## Plan

This plan states behaviour and exact test **cases** — signatures, names, expected values, edge cases — and deliberately contains no literal implementation code,
overriding `superpowers:writing-plans`' "code blocks required" rule. Handed code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch
with nobody positioned to catch it. The implementer writes the code and is expected to disagree with this plan where it is wrong. Any size figure below is a
target, never a budget.

### Step 0 — read the spec, then re-verify the four premises

Read the spec's §2 (where the merge happens) and §3 (how the base travels) before touching anything. Then confirm these, and say so in `## Outcome` if any has
moved:

- `git worktree add <dir> <branch>` refuses a branch already checked out elsewhere (`fatal: '<branch>' is already used by worktree at …`). The whole design
  turns on this; re-run it rather than trusting the spec's transcript.
- `agents.service.ts`'s `orchestrate()` composes the prompt from `ORCHESTRATE_PROMPT`, then `ids`, then ` --merge-mode branch`, then ` --question-mode decide`,
  in that order, and its comment claims "no caller-supplied character reaches the prompt through this channel either" for the two flags. A base breaks that
  claim, which is why Step 4 follows `resolveIds`' proof pattern rather than `resolveMergeMode`'s literal-selection one.
- `orchestrate.mjs` parses `--base` in two argv loops (around lines 1472–1491 and 1760–1766) and `BASE_REF_DEFAULT` is `'main'` (~line 1140). `init` writes the
  run file around line 1713.
- `.worktrees/` holds one directory per item id today, and no item id begins with `_` (`SECTIONS` in `backlog.mjs` mints `bug-`, `idea-`, `task-`, `ref-`,
  `oos-`), so a `_base-` prefix cannot collide.

### Step 1 — `base` in the run file and the shared shape

`OrchestratorRun.base: string`, **required**, in `shared/types.ts`, beside `mergeMode`. Doc: the branch this run gates at, cuts item worktrees from, and merges
into; `'main'` for a run that asked for nothing else. Required rather than optional so no reader re-implements the default — the mistake `mergeModeEffective`
exists to prevent one field over.

A run file written before this task has no `base`. Decide this explicitly rather than leaving it to a reader: the server's run reader treats an absent `base` as
`'main'` at the point it parses the file, so the required field is total for every consumer above that. State that in the type's doc comment.

`init` records the base it was given. There is no `baseEffective` and no note field: unlike merge mode, nothing degrades a base mid-run — a base that cannot be
merged into parks the item, and parking is already a recorded state.

Run `pnpm run typecheck` and let the compiler name every `OrchestratorRun` fixture literal that needs the field — the same compiler-as-checklist step task-43
used. Do not hunt by grep.

### Step 2 — `init` validates the base and refuses a bad one

`orchestrate.mjs init` refuses anything that is not an existing local branch, before it writes a run file, exit `1`, message naming the value and what was wrong
with it. Two checks in order: the string is a legal branch name (`git check-ref-format --branch <ref>`), then `refs/heads/<ref>` exists in the project
(`git show-ref --verify --quiet refs/heads/<ref>`). Order matters — the format check is what keeps a caller-supplied string away from anything git could read as
an option, so it runs first.

Refused: a tag, a bare SHA, `origin/main`, a branch that does not exist, an empty string, a string starting with `-`. Accepted: `main` and any existing local
branch, including one with `/` in its name.

`--base` keeps its existing gate meaning, unchanged. Every command after `init` reads the base from the run file, never from a re-derived default —
`buildGatedQueue`'s `base` parameter keeps its `BASE_REF_DEFAULT` for a direct hand call, but the run's own commands pass the recorded value.

### Step 3 — SKILL.md: the base tree rule

This is the substance of the task, and it is prose rather than code, so it must be written as carefully as code and pinned by tests (Step 7).

§9 stops naming `main` as the merge site. It resolves the base tree with `git worktree list --porcelain` — which lists the main tree and every linked worktree
with the branch each holds — and takes one of three paths:

1. **A tree holds `<base>`.** Merge there. For a `main`-based run on an ordinary machine that is the main tree, so the resulting commands are byte-identical to
   today's except for the explicit `-C`.
2. **No tree holds it.** Create `.worktrees/_base-<sanitised ref>` at `<base>`, merge there, and remove it in §10 when the run finishes. Sanitised because a
   branch name may contain `/`; state the exact sanitisation in SKILL.md rather than leaving it to the implementer of the day.
3. **The tree holding it is unusable** — detached HEAD, mid-rebase, mid-bisect. Park, exactly as today's `symbolic-ref` failure path does, with the detail
   naming the tree and what its HEAD said.

**The run removes a base worktree only if it created it.** A worktree the human made is theirs. This is the same boundary as the existing "this run's authority
stops at worktrees it created itself" rule, and SKILL.md must say it in those terms so the two read as one rule.

Both preconditions move to the base tree and keep their readings: `git -C "<base tree>" symbolic-ref HEAD` must print `refs/heads/<base>` and must succeed (the
non-zero-exit case is still its own reading, and still must be checked by exit status rather than by string comparison); the dirty-path probe diffs
`<base>...backlog/<id>` against that tree's own unstaged and staged paths. The merge becomes `git -C "<base tree>" merge --no-ff --no-edit backlog/<id>`.

Elsewhere in the file: §4's `worktree add .worktrees/<id> -b backlog/<id> main` cuts from `<base>`; §9's conflict recovery inside the item worktree merges
`<base>`; §9's "each item starts from the updated `main`" and branch mode's "the next item still branches from an unchanged `main`" both name `<base>`; §1's
gate and its parked detail name `<base>`.

**Read every remaining `main` in the file individually — do not sed.** Several of them mean *the main tree* (the checkout, which is still the main tree
whatever branch it holds) and must not change. The distinction is §1 of the spec's vocabulary; getting it wrong in either direction is a defect this task
exists to avoid.

§10's finish path removes a run-created base worktree. A removal that fails is recorded and does not fail the run, matching how the item worktree's own removal
failure is handled.

### Step 4 — the server accepts a base

`AgentOrchestrateRequest` gains `base?: string`. A private `resolveBase(base, projectPath)` mirrors `resolveMergeMode` row for row in shape — absent
(`undefined` or `''`) → `'main'`; valid → that value; anything else → 400, uncoded, echoing the offending value truncated and `JSON.stringify`d, the convention
`resolveIds`/`resolveMergeMode`/`resolveQuestionMode` all share.

**Validity here is `resolveIds`' kind of proof, not `resolveMergeMode`'s kind of clamp**, and the plan is explicit about why: `mergeMode` appends a compile-time
literal chosen by a guard, so no caller character reaches the prompt; a base appends caller text. It therefore has to be *proved* against the project the way an
id is — legal branch name, and `refs/heads/<base>` exists in that registered project — before it is composed into anything. A base that fails either check is a
400 before any spawn.

The composition appends ` --base <ref>` off its own guard, `'main'` appending nothing so a request written before this feature composes the byte-identical
prompt it composes today. Position: after the ids and beside the two mode flags — ids must stay first, because `orchestrate.mjs` reads bare tokens as ids and a
flag ahead of them would swallow the first id as its value.

`ORCHESTRATE_PROMPT`'s own doc comment currently claims the only caller-influenced part is ids plus two literals. Rewrite that claim rather than appending to
it — a comment that lists two of three influences is worse than one that lists none.

New route `GET /api/agents/branches?project=` returning that project's local branch names (`git for-each-ref --format=%(refname:short) refs/heads/`), 400 for a
blank param and 404 for an unregistered project, registry-gated by the same raw string compare `uncommitted` and `merge-check` use. Read per request, cached
nowhere. No guard, for the reason `merge-check` and `uncommitted` both state: it starts nothing and reads no caller-supplied path.

### Step 5 — the client picks a base and shows it

`OrchestrateSheet` step 3 gains a base picker beside the merge-mode and question-mode pickers, seeded to `'main'` and **not** from Settings — state in the
component comment that this is a deliberate departure from its two neighbours, with the spec's reason (a stored base outlives the experiment it was set for).
The branch list comes from the new route, fetched once per sheet open, keyed on `[project]`, with the same `alive` guard and silent `.catch` the `uncommitted`
effect uses; a failed fetch leaves the picker holding `'main'` alone and never blocks a launch. The request carries `base` on every launch, the same rule
`mergeMode` follows.

`RunDetail` renders the run's base, for every run including a `main` one — a field that appears only sometimes reads as an anomaly. Which branch a run wrote to
is unrecoverable afterwards from anything else, which is the whole reason it is drawn.

### Step 6 — the rules that move

- `CLAUDE.md`'s **"`backlog-orchestrate` is the only skill that commits or merges"** entry: the merge site becomes derived rather than fixed, stated as the base
  tree rule, with `Why:` pointing at the new anchor.
- `CLAUDE.md`'s **"The orchestrate spawn prompt is composed server-side"** entry: `base` becomes the third member of the enumerated influence list, and the
  entry must no longer say or imply that every appended flag is a compile-time literal.
- `docs/subsystems/invariants.md`: a new `##` section titled exactly
  `The merge happens in whichever tree holds the base, and the run removes only the tree it made`, carrying the spec's §2 reasoning — why a uniform base
  worktree is impossible, why `--force` is not the way round it, why a human's worktree is never removed, and why the main tree and "the tree holding `main`"
  are not the same thing. Place it immediately before the existing `## Undoing an already-completed orchestrator merge…` section, which is the nearest
  neighbour by subject.
- `docs/subsystems/api.md`: the `agents/` route list gains `GET /api/agents/branches`.
- `.claude/rules/orchestrator.md`: one pointer line to the new anchor.

### Step 7 — tests

Cases are in `## Test cases`. Two placement rules that are easy to get wrong here:

- The base-tree resolution lives in SKILL.md prose, not in the tool, so it is pinned the way this repo already pins skill prose — cases in
  `skills/backlog/tools/backlog.test.mjs` that READ `skills/backlog-orchestrate/SKILL.md` and assert it still states the three outcomes and the removes-only-
  what-it-created rule. They read the file; they never import it.
- The tool's own cases go in `skills/backlog-orchestrate/tools/orchestrate.test.mjs` and run under node's test runner; the server and client cases go in
  `test/` under jest. `pnpm test` runs both runners and must be green.

### What this task deliberately does not touch

- **Pushing.** Unchanged on any branch.
- **Creating a branch.** Neither the endpoint nor the tool ever creates the base; a missing one is a refusal.
- **A Settings default for the base.** Deliberate, per the spec's non-goals.
- **`merge-check`.** It answers whether this project's Claude Code settings grant `git merge` — a question about the command, not the branch.
- **`mergeModeEffective`.** Nothing about a base degrades a run; a base that cannot be merged into parks the item.

### Assumptions this plan made without asking

- The base worktree is `.worktrees/_base-<sanitised ref>` and is removed by the run that created it, in §10 rather than after each item — one create and one
  remove per run, not per item.
- An older run file with no `base` reads as `'main'` in the server's reader rather than being migrated on disk; nothing rewrites an archived run.
- `GET /api/agents/branches` returns local branches only, unsorted beyond git's own order, with no annotation of which one is checked out where — the sheet
  needs names, and the base-tree question is the run's to answer at merge time.

## Test cases

**A. `orchestrate.test.mjs` — `init` and the run file:**

1. `init --base <existing branch>` writes `base: "<that branch>"` into `run.json`.
2. `init` with no `--base` writes `base: "main"`.
3. `init --base` refuses each of: a tag name, a 40-character SHA, `origin/main`, a branch that does not exist, `''`, and `-x` — exit `1`, nothing written (no
   `run.json` created), and the message contains the offending value.
4. `init --base feature/a/b` (an existing branch with slashes) is accepted and recorded verbatim.
5. A run file written without `base` still parses for every command that reads it — `stage`, `heartbeat`, `attention` — and none of them writes a `base` into it.
6. `init --resume` on a run recorded with `base: "feature/x"` continues with that base and does not fall back to `main`, proved by the value the resumed run
   still carries and not by the resume's own output alone.

**B. `test/agents-prompt.test.ts` — the composed prompt:**

1. A request with no `base` composes exactly the prompt it composes today, byte for byte, for each of the four existing combinations of `ids` and the two modes.
2. `base: 'feature/x'` appends ` --base feature/x` after the ids and beside the mode flags, and the ids still come first.
3. `base: 'main'` explicitly appends nothing — the default is silent whether it is stated or omitted.

**C. The endpoint, through supertest:**

1. `base: 'no-such-branch'` → 400, nothing spawned, the message names the value.
2. `base: '--upload-pack=evil'` → 400 (fails the ref-name check), nothing spawned.
3. `base: 42` (a non-string the `Partial` type cannot rule out) → 400, the value rendered as `42` rather than `"42"`.
4. `base: ''` → treated as absent: 201, prompt with no `--base`.
5. `GET /api/agents/branches?project=<registered>` lists that project's local branches and nothing else; `?project=` blank → 400; an unregistered path → 404.

**D. SKILL.md prose, in `skills/backlog/tools/backlog.test.mjs`:**

1. §9 states all three base-tree outcomes (a tree holds it, no tree holds it, the holding tree is unusable).
2. §9 or §10 states that the run removes a base worktree only if it created it.
3. §4's worktree-creation command cuts from the base rather than the literal `main`.
4. No step of §9's merge path still asserts `refs/heads/main` as the precondition.

**E. The client, under jest/jsdom:**

1. The Orchestrate sheet sends `base` on every launch, including when the picker was never touched (value `'main'`).
2. A failed branches fetch leaves the picker with `'main'` and Start still works.
3. `RunDetail` renders the base for a `main` run and for a feature-branch run.

**F. Whole-repo gates:** `pnpm run typecheck`, `pnpm test` (both runners), `pnpm run build`, and `test/claude-rules.test.ts` green.

## Done when

- A run started from the board against a base of `feature/tracker-backed` cuts its item worktree from that branch, merges into whichever tree holds it, and
  never writes `main` — proved by running one real item end to end and showing `git log --oneline main..feature/tracker-backed` carrying the merge commit and
  `git log --oneline -1 main` unchanged.
- A run started with no base behaves exactly as today, proved by the byte-identical prompt cases in group B.
- Groups A–F pass; `pnpm test`, `pnpm run typecheck` and `pnpm run build` are green.
- `CLAUDE.md`, `docs/subsystems/invariants.md`, `docs/subsystems/api.md` and `.claude/rules/orchestrator.md` carry the Step 6 text.
- `## Outcome` quotes the green `pnpm test` summary line and names which of the three base-tree outcomes the end-to-end check actually exercised.

## Outcome

2026-09-17 — implemented across all seven steps and verified. The base is run-scoped end to end: picked on the sheet, proved by the endpoint, composed into the
prompt, validated and recorded by `init`, read back from the run file downstream, and — the substance of the task — merged in whichever tree holds it.

### Step 0: the four premises, two of which had moved

- **`git worktree add` refuses a branch checked out elsewhere** — re-run rather than trusted: `fatal: 'main' is already used by worktree at
  '/Users/<me>/Documents/custom-projects/backlog-manager'`, with a free-branch control succeeding, proving the refusal is about the branch not the path.
- **`agents.service.ts`'s composition order and its comment** — confirmed as described.
- **MOVED: `BASE_REF_DEFAULT`'s own comment stated the opposite of this task.** It read "Deliberately NOT recorded in run.json: that would be a shared/types.ts
  schema change for a value the loop can just pass on each `plan` call" — right while the base was a queue gate, false the moment it became the merge target.
  Rewritten to say what changed and why. The `--base ''` comment beside it ("resolves to nothing and takes the fallback") was likewise falsified by Step 2's
  refusal and rewritten.
- **MOVED: `.worktrees/` is no longer one directory per item id.** `.worktrees/tracker` holds `feature/tracker-backed`. The `_base-` collision claim still holds
  (no id `SECTIONS` mints begins with `_`), and that directory is a live instance of outcome 1 — a `feature/tracker-backed` run merges in the worktree already
  there rather than creating one.

### Decisions the plan did not anticipate

1. **`init` accepts an unborn base that HEAD already points at.** The plan's strict two checks would refuse `--base main` in a repository with no commits — every
   `orchestrate.test.mjs` fixture — changing `init`'s tested behaviour there from "write a run with an empty queue" to exit 1, for a base nobody chose. Adding a
   commit to the fixture was not available either: `blobReaderAt` returns `null` for a commitless repo, which is exactly what lets those fixtures gate on
   working-copy content. The allowance is narrow (the base must be the branch HEAD is on), has its own test, and does not claim such a base can be merged into.
2. **An explicit `base: 'main'` short-circuits with absent at the endpoint.** The sheet sends `base` on every launch, so validating `'main'` would `show-ref` on
   every ordinary run and 400 all of them in a repository whose trunk is named something else — a regression caused purely by the client becoming explicit.
   `'main'` appends nothing, so there is no caller text for the checks to protect. The tool still checks it at `init`.
3. **The base-tree prose is pinned in `orchestrate.test.mjs`, not `backlog.test.mjs`.** The plan named the latter, but that suite holds prose for the two skills
   with no `tools/` of their own plus genuine cross-skill seams, and §9's existing prose pins all live in `orchestrate.test.mjs`. The one seam that IS
   cross-skill — the orchestrator handing the reviewer its base — did go in `backlog.test.mjs`, beside the reviewer/execute pair it matches in shape.
4. **The server suite is `test/base-branch.test.ts`, not rows in `agents-prompt.test.ts`.** That file covers `composePrompt`, the DISPATCH prompt. task-19 hit
   the identical plan instruction, made the identical departure, and recorded it in `question-mode.test.ts`'s header; this follows that precedent.

### What the checks caught that the implementation had wrong

- **The controller never passed `base` to the service.** It rebuilds the orchestrate body field by field, so the field was silently dropped: every base composed
  nothing and every invalid base returned 201. Caught by seven failing cases, not by reading.
- **The reviewer diffed the wrong ref.** `agents/backlog-reviewer.md` hardcoded `main...<branch>` in all four of its git commands. On a `--base` run that folds
  in the base's whole divergence from `main` and reviews a change set the item's author never wrote — silently, as a larger diff that still looks legitimate.
  Found by the contract sweep. The agent now takes `base` as a fifth field, SKILL.md §7 hands it, and both halves are pinned together.
- **Two claims in my own comments were false.** The ref-name check is not what stops `show-ref` reading the value as an option — `refs/heads/<base>` can never
  begin with `-`, and measurement showed membership alone refuses every value the name check does. The ordering earns its place downstream, where the base is
  substituted for `<base>` in SKILL.md's shell commands. Corrected in `resolveBase`, `assertUsableBase`, CLAUDE.md and `invariants.md` rather than left standing.

### End-to-end check — which base-tree outcomes it exercised

**All three**, against real repositories, by running the exact commands §9 prescribes. Not through a board-started run: this is a `runner-fix:` item, so its
SKILL.md and `orchestrate.mjs` changes are inert until committed, pushed and `pnpm run plugin:sync` has run — and this skill never commits or pushes. A run
started now would execute the *installed* copy and prove nothing about this branch. What was verified directly instead:

- **Outcome 2 (no tree holds the base):** the scan returned empty, `.worktrees/_base-feature-tracker-backed` was created (sanitisation applied to the `/`),
  `symbolic-ref HEAD` printed `refs/heads/feature/tracker-backed`, the overlap probe was empty, and `git -C "<base tree>" merge --no-ff --no-edit backlog/task-x`
  landed the merge on the base. Then §10 removed the worktree the run created (`remove=0`).
- **Outcome 1 (a tree already holds it):** with a hand-made worktree on the base, the scan resolved to it, no `_base-` directory was created, and a second item
  merged there — building on the first, which is the property the whole feature exists for.
- **Outcome 3 (the holding tree is unusable):** with that tree mid-rebase it reported `detached`, so the scan returned empty, and `worktree add` refused with
  `fatal: 'feature/tracker-backed' is already used by worktree at '<path>'` — confirming the detection is the *create* failing, never the scan.

`main` was untouched throughout all three:

```
main..feature/tracker-backed  ->
ea681f3 Merge branch 'backlog/task-y' into feature/tracker-backed
b2ddb46 task-y: more work
1b2d53a Merge branch 'backlog/task-x' into feature/tracker-backed
dde7321 task-x: the item's work
main -1 -> 1ad29ff initial on main     (unchanged from before the run)
```

### Deliberately left standing

`UNCOMMITTED_BASE_REF = 'main'` (`server/src/items/uncommitted.util.ts`). The sheet's uncommitted flag still asks "differs from `main`", so on a `--base` run it
warns against the wrong ref. Not oversight: that read is keyed on `[project]` and fires once on sheet open, *before* the base is picked in step 3, and CLAUDE.md
pins both that cadence and that it is memoised nowhere. Making it base-aware means re-fetching per base pick — a design change neither the spec nor the plan
asked for. Worth a follow-up item.

### Verification

```
$ pnpm test
Test Suites: 108 passed, 108 total
Tests:       1772 passed, 1772 total
# tests 556
# pass 556
# fail 0
pnpm test: both runners passed.

$ pnpm run typecheck
$ tsc --noEmit

$ pnpm run build
✓ built in 1.28s
```

Contract sweep: 14 sites updated (skills/backlog-groom/SKILL.md, skills/backlog-orchestrate/references/rationale.md, skills/backlog-orchestrate/references/recovery.md, agents/backlog-reviewer.md, skills/backlog-orchestrate/tools/orchestrate.mjs, server/src/orchestrator/orchestrator.service.ts, client/src/components/board/OrchestrateSheet.tsx, CLAUDE.md, .claude/rules/orchestrator.md, docs/subsystems/invariants.md, docs/subsystems/api.md, docs/subsystems/board.md, docs/subsystems/skills.md, README.md); `docs/superpowers/specs/` and `docs/superpowers/plans/` left unchanged on purpose, as dated records of decisions rather than statements of current behaviour.
Red proof: 10 tests went red with the change reverted (2 of the 10 stayed green on the first attempt — the absent-`base` resolution in `sanitizeMergeFields`, and `check-ref-format`'s unique coverage — and each gained a case that fails without it).
