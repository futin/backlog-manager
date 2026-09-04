# Orchestrator merge mode — design

**Date:** 2026-09-04
**Status:** approved, ready for an implementation plan
**Scope:** one setting — whether a run merges to `main` or stops at a reviewed
branch — carried from the board into the headless run, enforced by the tool,
and visible in the run history. Parallel worktree execution is explicitly out
of scope and gets its own design.

## Why this exists

On 2026-09-03 a `claude-agents-dashboard` run finished four items — reviewed,
`test` + `typecheck` + `build` green on all four — and merged none of them.
Each merge attempt answered:

> Permission for this action was denied by the Claude Code auto mode
> classifier. Reason: Blocked by classifier.

The run's own notes diagnosed a missing `Bash(git merge:*)` permission. That
diagnosis is a valid *remedy* and a wrong *explanation*. The evidence:

| Run | Project | `permissions.allow` present | Merge |
|---|---|---|---|
| 2026-09-01 18:57 | claude-agents-dashboard | none | allowed ×3 |
| 2026-09-03 11:26 | backlog-manager | none | allowed ×4 |
| 2026-09-03 18:49 | claude-agents-dashboard | none | **denied ×4** |

All three were board-spawned (`custom-title: "orchestrate <project>"`),
headless, `claude -p --permission-mode auto`, issuing the same
`git -C "$PWD" merge --no-ff --no-edit backlog/<id>`. The dashboard's
`.claude/settings.json` carrying `Bash(git merge:*)` is dated 2026-09-03
22:34 — written *after* the failure, staged, never committed. Nothing about
permissions differed between the runs that merged and the run that did not.

The conclusion the design rests on: **auto mode is a per-call model
classifier, and its verdict on an identical command varies between runs.** An
`allow` rule takes the classifier out of the path for matching commands, so it
is worth having and worth telling the user about — but a run cannot assume it
is there, cannot assume the user wants it there, and must not turn a blocked
last step into four hours of wasted work.

Two things follow, and they are the whole feature:

1. Merging is a **choice**, not the only outcome. A run that stops at four
   reviewed branches is a successful run.
2. A run that *wanted* to merge and was refused **degrades to that outcome**
   rather than parking as if the work were bad.

## Non-goals

- Parallel execution across worktrees. Its own design.
- Writing anyone's `.claude/settings*.json`. The app reads it and tells the
  user what to paste; it never edits it.
- Pushing branches, opening PRs, or any remote interaction.
- Changing `backlog-execute`'s "never commits, never pushes" limit, or the
  rule that `backlog-orchestrate` is the only skill touching git history.

## 1. Vocabulary

`MergeMode = 'merge' | 'branch'`, declared in `shared/types.ts` beside
`RunStage`, with a `MERGE_MODES` readonly const and an `isMergeMode` type
guard exported alongside it.

- `merge` — today's behaviour, byte for byte. The run merges each verified
  item into `main` and cleans up its worktree and branch.
- `branch` — the run commits on `backlog/<id>`, reviews and verifies exactly
  as today, then **removes the worktree and keeps the branch**. `main` is
  never touched.

A guard rather than inline string comparison, for the reason `isAgentAction`
already exists: a hand-written comparison chain is a second copy of the
vocabulary, and it is the copy that goes stale.

**What `branch` mode deliberately does not change:** review and verification
still run, and an item that fails either still fails or parks as it does
today. The mode decides where a *successful* item stops, nothing else. A mode
that skipped review would be a different feature (a bulk executor) and was
considered and rejected: unproven branches are not the deliverable.

## 2. The path the value travels

The setting is chosen in a browser and consumed by a headless process on the
machine. `localStorage` cannot reach that process, and the run file has one
writer. So the value rides the one channel that already exists — the spawn
prompt — and lands in the run file, which is where every other fact about a
run lives.

```
Settings.orchestrateDefaultMergeMode        (client, per-device, default 'merge')
  → OrchestrateSheet picker                 (seeded from Settings, per-run override)
  → POST /api/agents/orchestrate {mergeMode}
  → AgentsController                        (rebuilt field by field, passed through unvalidated)
  → AgentsService.orchestrate               (validated here — see 2.3)
  → spawn prompt: ORCHESTRATE_PROMPT [+ ids] [+ ' --merge-mode branch']
  → SKILL.md §2 → orchestrate.mjs init --merge-mode branch
  → run.json: { mergeMode, mergeModeEffective, mergeModeNote }
  → GET /api/orchestrator/runs + /archive → RunStrip, RunDrawer, RunsView
```

### 2.1 Settings

New key `orchestrateDefaultMergeMode: MergeMode`, default `'merge'`, clamped
in `clampSettings` with the existing `pickOne` against `MERGE_MODES`. It sits
with `dispatchDefaultModel` / `dispatchDefaultEffort` and inherits their
documented rationale verbatim: a default you set once and can see, never the
sheet remembering your last pick.

`'merge'` is the default because it is what every existing run does; a new
key must not silently change the behaviour of a board that has been working
for a fortnight.

### 2.2 The sheet

One more control in `OrchestrateSheet`, beside model and effort, seeded from
Settings and overridable for this launch only. The wording on the control is
about the *outcome*, not the flag: "Merge to main" / "Leave branches for me".

`mergeMode` is sent on every launch, including when it equals the default.
The request field is the sheet's answer to "what should this run do", and
inferring it server-side from an absent field would put the same decision in
two places.

### 2.3 Server validation

The controller rebuilds the body field by field and passes `mergeMode`
through **unvalidated**, exactly as it does for `model`, `effort`,
`permissionMode` and `ids` — the service is the one place a value is judged,
and a shape check in the controller would be a second, weaker copy of it.

The service's rule, and it differs deliberately from every neighbouring field:

- **absent** (`undefined` or `''`) → `'merge'`. Today's behaviour for every
  existing caller, unchanged.
- **present and a member of `MERGE_MODES`** → that value.
- **present and anything else** → **HTTP 400, uncoded.** Not clamped, not
  dropped.

The asymmetry is the point. `model` and `effort` drop an unknown value
because dropping one costs a default model. Dropping an unrecognised
`mergeMode` would resolve to `'merge'`, and *merging to `main` is the
irreversible direction*. A caller bug must not be able to pick it. Absent
still means `'merge'` because absent is not a bug — it is every request
written before this field existed.

Uncoded, because `RUN_IN_PROGRESS_CODE` remains the only machine-readable
answer this endpoint gives; nothing about a malformed enum needs telling
apart from another 4xx.

### 2.4 The prompt

`ORCHESTRATE_PROMPT` stays the literal `/backlog-orchestrate` and the request
body still has no `prompt` field. The composed string gains, for `branch`
only, the trailing literal ` --merge-mode branch`. `merge` appends nothing, so
a default run's prompt is byte-identical to what ships today.

This is a **tighter** injection than `ids`: the appended substring is one of
exactly two compile-time constants selected by a guard, with no caller text
in it at all. The invariant that the prompt is composed server-side is
unchanged; what a caller influences grows from "a validated id list" to "a
validated id list and a two-valued enum".

### 2.5 The run file

`init` gains `--merge-mode <mode>`, validated against the same closed list
(an unrecognised value is a code-1 usage error, like every other bad flag),
defaulting to `merge` when absent. It writes three run-level fields beside
`maxItems`:

- `mergeMode: MergeMode` — what was **asked for**. Never rewritten.
- `mergeModeEffective: MergeMode` — what the run is **actually doing**.
  Starts equal to `mergeMode`; only ever moves `merge` → `branch`, never back.
- `mergeModeNote: string | null` — why they differ, when they do. Null
  otherwise.

Two fields rather than one because the archive has to answer "did this run
merge, and was that the plan?" months later. Collapsing them loses the
distinction between a run that chose branches and a run that was denied them,
which is exactly the distinction last night's post-mortem needed.

Only `orchestrate.mjs` writes these; the server reads them and never caches,
as with everything else in the run file.

## 3. Enforcement lives in the tool, not the prose

`orchestrate.mjs stage <id> merged` **exits non-zero** when the run's
`mergeModeEffective` is `'branch'`, naming the mode and the stage it should
have used.

A `SKILL.md` instruction has to survive several hundred turns of a session
re-reading its own body; a tool refusal does not drift. This mirrors the
existing arrangement where the gate is mechanical (`buildGatedQueue`) and the
prose is the rationale.

The converse is **not** enforced: `stage <id> branched` is legal under
`merge` mode too, because that is precisely what a denied merge degrades to
(§5).

## 4. The `branched` stage

A new `RunStage` member, occupying the same terminal position `merged` does —
the `StageTrack` stays seven nodes, the last one just carries a different
word. A true exit: the run is finished with the item and holds nothing.

Every site that must classify it, all of them compiler-forced or test-pinned
today:

| Site | Classification |
|---|---|
| `RunStage` union (`shared/types.ts`) | new member |
| `RUN_STAGES` (`orchestrate.mjs`, deliberate duplicate) | new member; pinned against the union by `test/agents-shared.test.ts` |
| `RUN_CLAIMED_STAGES` | **not** in it — the run has let go |
| `ATTENTION_RUN_STAGES` | **not** in it — a clean branch needs nobody |
| `runHoldsItem` / `RUN_HELD_STAGES` (`shared/agent.ts`) | a fifth true exit alongside `merged`, `failed`, `skipped`, `ungroomed` |
| `MACHINE_STAGES` (`run-stats.ts`) | **not** in it — terminal arrivals open no span |
| `RECONCILE_TERMINAL_STAGES` (`orchestrate.mjs`) | in it |
| `ACTIVE_RUN_STAGES` (`ItemCard.tsx`) | **not** in it |
| `StageTrack` terminal node | label from the run's `mergeModeEffective` |
| `status` summary line (`N/M merged`) | mode-aware wording |
| `aggregateRuns` (`run-stats.ts`) | counted as completed, alongside `merged` |

`test/agents-shared.test.ts`'s `Record<RunStage, true>` literal makes the
compiler demand a decision for both partitions, which is the mechanism that
keeps this table from being a checklist someone forgets.

**Why a new stage rather than reusing `merged` with the run mode as the
qualifier:** the cheaper option makes the stored history state that an item
merged when it did not. This repo has repeatedly paid for honesty in derived
state over cheapness (`itemDurationMs`, `lastTouched`, `isStale`), and a run
archive that lies about what reached `main` is worse than a mechanical sweep.

## 5. The preflight probe, and degrading mid-run

### 5.1 The probe

Once per run, run-level, in `SKILL.md` §2 — before item 1, and only when the
effective mode is `merge`:

```bash
git -C "$PWD" merge --no-ff --no-edit HEAD
```

Merging `HEAD` into itself prints `Already up to date.` and changes nothing —
no commit, no index write, no reflog entry. What matters is that the **command
shape is byte-identical** to the real merge at §9, so the classifier is shown
exactly what it will be shown later.

- Allowed → continue in `merge` mode.
- Denied → set `mergeModeEffective: 'branch'` with a note naming the
  classifier, and run the whole queue in branch mode. The run does not stop.

Recording the probe's answer in the run file matters as much as acting on it:
the next post-mortem should not need transcript forensics to learn this.

**The probe is early warning, not a guarantee.** The verdict is per-call, as
the evidence at the top of this document shows. It buys "find out in ten
seconds instead of four hours"; it buys nothing else, and §5.2 exists because
of that.

### 5.2 Denied at §9, after the probe passed

The item is verified green and the merge is refused by the classifier:

- stage it `branched`, not `parked`;
- set `mergeModeEffective: 'branch'` and the note, so the *rest of the queue*
  skips a merge attempt that has just been shown to fail;
- continue to the next item.

**No attention entry, and no fourth attention kind.** `ATTENTION_KINDS` stays
the closed set of three it is today (`needs-answers`, `parked`,
`fix-exhausted`) — the attention list means "a human must look at this item",
and a green branch does not qualify. The cause is recorded once, run-level, in
`mergeModeNote`; the actionable part — the literal
`git merge --no-ff backlog/<id>` per branch, in merge order — belongs in the
finish summary (§7), where it is one list rather than N copies of one
sentence.

`parked` is wrong here and that is the correction this whole feature exists to
make. Parked means a human must look at the work. Nothing is wrong with the
work — the last step of the pipeline was refused. Four green branches reported
as four parks is what made last night read as a failed run.

**Every other §9 failure keeps today's behaviour exactly.** A conflict, a
pre-merge refusal from overlapping dirty paths, a main tree not on `main` —
all still park, still keep the worktree, still say why. Those are genuine
"a human must decide" states and none of them is a permission problem. The
new path is narrow on purpose: it triggers on the classifier denial and
nothing else.

### 5.3 Branch mode's own §9

With `mergeModeEffective: 'branch'` the item skips §9's merge entirely:

- no `symbolic-ref` precondition (nothing is written to the main tree);
- no dirty-path overlap probe (same reason);
- stage `branched`;
- `git worktree remove` exactly as today, plain `remove` and never `--force`,
  with the same "a refusal is information, leave it and record it" handling;
- **no `git branch -d`.** The branch is the deliverable.

The next item still branches from an unchanged `main`, so two items touching
the same files produce two branches that will conflict with each other at
hand-merge time. That is inherent to not merging and is not something the run
can fix; the run summary should name it when two branches in the same run
touch overlapping paths, so the user learns the merge order before they start.

## 6. Telling the user how to make merging reliable

New read-only endpoint, in the agents module because merge capability is a
property of the spawned session's permissions and that is what this module
already owns (`dispatchGate`, `spawnMaxPermission`, the mode ladder):

`GET /api/agents/merge-check?project=<path>`

- The project is gated against the registry exactly as item bodies are — an
  unregistered path 404s before the filesystem is touched.
- Reads, in precedence order, `<project>/.claude/settings.local.json`,
  `<project>/.claude/settings.json`, `~/.claude/settings.json`.
- Answers whether any `permissions.allow` entry would cover
  `Bash(git merge:*)`, and which file it came from.
- Every failure — no file, unreadable, malformed JSON — degrades to "not
  found", never throws. A missing settings file must not 500 the sheet.

The sheet calls it when merge mode is selected and shows, when nothing covers
it: which file to create, the exact JSON to paste, and one plain sentence
saying the run may still merge without it but will not reliably. It never
offers to write the file.

## 7. Surfacing the mode

- **RunStrip / RunDrawer** — a branch-mode run says so, and its per-item
  terminal reads `branched`.
- **RunsView list and detail pane** — same, plus the run's
  `mergeModeEffective` and, when it differs from `mergeMode`, the note. A
  downgraded run must be legible at a glance in history.
- **Run summary at `finish`** — branch mode lists the branches waiting, in the
  order they should be merged, and flags overlapping pairs.

## 8. Testing

Behaviour and expected values; the implementer writes the code.

**Skill tests** (`skills/backlog-orchestrate/tools/*.test.mjs`, node's runner):

1. `init --merge-mode branch` writes `mergeMode: 'branch'` and
   `mergeModeEffective: 'branch'`, `mergeModeNote: null`.
2. `init` with no flag writes `'merge'` for both — the key set of the written
   run is otherwise unchanged from today's contract fixture.
3. `init --merge-mode nonsense` exits 1 and writes nothing at all (the
   "validate first, mutate last" guarantee).
4. `stage <id> merged` under `mergeModeEffective: 'branch'` exits non-zero and
   leaves the item's stage untouched.
5. `stage <id> branched` is accepted under both modes.
6. The command that records a downgrade moves `mergeModeEffective` `merge` →
   `branch` and stores the note; a second call cannot move it back.

**Server** (jest):

7. `POST /api/agents/orchestrate` with `mergeMode: 'branch'` composes the
   prompt `/backlog-orchestrate --merge-mode branch`; with ids as well, ids
   precede the flag and the whole string is exactly as specified in §2.4.
8. Absent, `''`, and `'merge'` all compose the bare constant — no flag text.
9. `mergeMode: 'nope'` (and a non-string) answers 400 and spawns nothing.
10. A new field on the request body does not reach the service without a
    controller change — the existing field-by-field rebuild test, extended.
11. `merge-check` for a project with the allow rule in each of the three
    files; for a project with none; for an unregistered path (404); for a
    malformed JSON settings file (answers "not found", does not throw).

**Shared** (jest):

12. `test/agents-shared.test.ts`'s `Record<RunStage, true>` literal gains
    `branched` and classifies it in both partitions; `runHoldsItem` returns
    false for it.
13. The `RUN_STAGES` duplication pin still matches the union.

**Client** (jest + jsdom):

14. `clampSettings` maps an unknown stored `orchestrateDefaultMergeMode` to
    `'merge'`, and a valid one through.
15. The sheet seeds from Settings, sends the overridden value, and shows the
    setup warning only when merge mode is selected and `merge-check` reports
    nothing covering it.
16. `StageTrack` renders the terminal node as "branched" for a branch-mode
    run and "merged" for a merge-mode one, at the same seventh position.
17. `aggregateRuns` counts a `branched` item as completed and excludes it from
    machine time.

## 9. Decisions taken, and what they cost

| Decision | Alternative rejected | Why |
|---|---|---|
| Value rides the spawn prompt | env var on the spawn; a config file the server writes | The dashboard's `/api/spawn` body is a closed shape (cross-repo change), and a server-written config would add a second writer to a machine-local file. The prompt channel already exists and is already validated. |
| Branch mode removes the worktree | keep it so you can run the item's code | A checkout plus `node_modules` per item; four items is four installs. The branch is the artifact and `git worktree add` is cheap when actually wanted. |
| Settings default + per-run override | Settings only; per-project default | Mirrors `dispatchDefaultModel`/`Effort` exactly, and covers both "this repo is precious" and "tonight I'm away". A per-project map is a plausible follow-up, not this change. |
| New `branched` stage | reuse `merged`, relabel in the UI | Roughly half the work, and a run archive that states items merged when they did not. |
| Denial degrades, run continues | refuse to start on a failed probe | Four reviewed branches beat zero. The probe cannot promise the merge anyway. |
| Present-but-invalid `mergeMode` is a 400 | clamp to the default | The default is the irreversible direction. A caller bug must not select it. |
| A denied merge is recorded run-level | a per-item attention entry, needing a fourth `ATTENTION_KINDS` member | One cause, one record. N items denied by one classifier verdict would write N identical rows into a list that means "a human must look at this item" — which a verified branch does not. |
