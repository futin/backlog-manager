# `backlog-orchestrate` PR mode — one pull request per run

Status: design approved in brainstorming 2026-10-15; this file awaits review. Release-pipeline **Phase B** for this repo: the "separate plan there" that
`claude-agents-dashboard`'s `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase B names for `backlog-orchestrate` (branch `ci/phase-a-gate`
there), under its decision **D8 — one PR per orchestrator run, not per item**.

## Why this exists

release-kit's `main-pr-only` ruleset refuses every direct push to `main`: PR required, three CI contexts, linear history, no bypass actor (D9). Six of the seven
backlogs registered on this machine are tracker-backed — this repo, `claude-agents-dashboard`, `lookout`, `guide-manager`, `ixray`, `brickwright`; only
`finance-manager` is a files project (2026-10-15) — and a tracker run pushes `<base>` after
every merge (task-47, `.claude/rules/orchestrator.md`). Under the ruleset that push is refused, and a refused push **parks** (it never degrades, because the
merge has already landed). So once a repo's ruleset is on, every orchestrator run there spends one whole item — execute, review, verify, merge — and parks at
the push, with the merge stranded on one laptop. The dashboard's ruleset is already applied (2026-10-15); this repo's waits for this feature, by the decision
recorded in [docs/workflows/ci.md](../../workflows/ci.md) §The ruleset.

PR mode moves the run's writes off `main`: the run drains onto a branch of its own, pushes that branch, and ends by opening one pull request into the base it
was started against. The run never merges that PR. CI gates it, and a person squash-merges it, which is the point of the ruleset.

## Decisions

| #   | Decision                                                                                                                                                                         | Rejected                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| P1  | **`pr` is a third `MergeMode`**, `merge \| branch \| pr`. It rides the route merge mode already travels: Settings default → sheet picker → `POST /api/agents/orchestrate` → spawn prompt → `init` → run file → claim. | A separate `--pr` flag — its own plumbing at every one of those hops, plus a refusal for the meaningless `--pr --merge-mode branch`. |
| P2  | **A tracker item's issue still closes at its merge into the run branch** (`stage <n> merged --outcome`, after the push succeeded), exactly as today. So the run branch is pushed after every merge, not once at the end as D8's text reads — a deliberate deviation.                             | Closing at PR merge — the item would stay open after its claim is released, and the next run would queue it again.            |
| P3  | **Tracker projects only.** `pr` on a files project is refused at the server (400) and in `init` (exit `1`).                                                                    | Files projects too — an opt-in exception to "never pushes a files project", and the one files project here (`finance-manager`) has no remote ruleset to route around. |
| P4  | **The run branch is the run's `base`; the PR's target is a new field, `prTarget`.**                                                                                              | Keeping `base` as the target and adding a `runBranch` that every merge-side reader would have to prefer over `base`.         |
| P5  | **The run file records the PR's URL, and the Runs detail sheet links to it.**                                                                                                    | The URL in the final summary text only.                                                                                       |
| P6  | **The PR is opened by the driver with `gh pr create`; the tool composes its title and body and records its URL.** The tool makes no call to GitHub; its only network call stays the local API (`apiCall`).                    | The server's GitHub client opening it through a tenth item-write route; `orchestrate.mjs` spawning `gh` itself.               |

P1 makes the degrade path free: a classifier-denied merge moves `mergeModeEffective` one way, today `merge → branch`, and under P1 also `pr → branch`.

P2 means a PR that is closed without merging leaves closed issues whose work is not on `main`. That case is a person's decision, and it gets a person's fix:
reopen the issues by hand. It is the price of not inventing a "merged but not landed" state that every board reader would then have to learn.

P4 is what makes most of this feature free. Everything downstream already reads `base`. That covers §1's gate, §4's worktree cut, `merge-check`'s base-tree
resolution, `cleanup`'s HEAD-relative commands, `--resume`, the claim's `ClaimRun.base` and remote runs. Each of them does the right thing once `base` names
the run branch.

## 1. Vocabulary

`MergeMode` (`shared/types.ts`) gains `'pr'`, `MERGE_MODES` lists it, and `isMergeMode` stays the one guard. Every surface that validates a merge mode
against that list accepts `pr` without further change: the Settings clamp, the sheet picker's options, `resolveMergeMode`, the claim route's
`run.mergeMode` check, and `sanitizeMergeFields`. The existing rules hold unchanged: absent means `merge`; present-but-invalid is a 400 and
never a clamp.

Two server sites do need an edit, because each restates the vocabulary by hand. The spawn prompt (`agents.service.ts`, the `prompt:` array) appends
`--merge-mode` only for `'branch'`, so without a second guarded literal a `pr` request would spawn a plain `merge` run; it gains `mergeMode === 'pr' ?
['--merge-mode', 'pr'] : []`, a compile-time literal like its sibling. `resolveMergeMode`'s 400 text hard-codes "merge or branch"; it is built from
`MERGE_MODES` instead, as the claim route's already is. The tool keeps its own deliberate copy, `const MERGE_MODES = ['merge', 'branch']` in
`orchestrate.mjs` (it imports nothing from `shared/`), which `init`'s `--merge-mode` and `merge-mode` validate against, and `INIT_USAGE` restates the list;
both gain `pr`, and a node test pins the tool's copy equal to `shared/types.ts`'s.

`mergeModeEffective` still moves one way, once. `orchestrate.mjs merge-mode branch --note …` is accepted from `merge` **or** `pr`, and from nothing else.
`mergeMode` keeps the requested value, so a degraded PR run stays recognisably a PR run (§4, §5).

`stage <id> merged` is legal under `pr`, exactly as under `merge`. The refusal stays tied to `mergeModeEffective === 'branch'`.

**Tracker only (P3).** `resolveMergeMode` gains the project. It answers `pr` on a project whose resolved source is not `github` with a 400 naming the
reason. `init --merge-mode pr` on such a project exits `1` with nothing written, in the same pre-write validation block as the other three flags.

## 2. The run branch

In `pr` mode `init` does the following, in this order and all inside its existing "validate first, write last" sequence:

1. Validates `--base` as today (`assertUsableBase`). Here it names the **PR target**, default `main`.
2. Pulls the target (`pullBaseAtInit`, unchanged — the run branch is cut from a fresh target).
3. Mints the run branch name `backlog/run-<YYYY-MM-DD>-<n>`. The date is the machine's local date. `<n>` is one more than the highest `n` already used for
   that date, parsed only from refs matching `backlog/run-<date>-\d+$` (a stray `backlog/run-<date>-wip` is ignored), read from this repo's local refs **and** from `git ls-remote --heads origin 'backlog/run-<date>-*'`. The remote read matters because a tracker
   project is multi-machine by definition, and two machines starting a run on the same day must not mint the same name. A failed `ls-remote` (offline, no
   `origin`) falls back to local refs and prints one stderr line saying so. `<n>` starts at `1`.
4. Creates the branch at the target's tip (`git branch <run branch> <target>`), after the queue gate (which reads `<target>`, the same commit) and after the
   exit-`4` existing-run check, so a refused `init` leaves no branch. This is the last git write before the run file is written. If the run file
   write then fails, the empty branch is left behind; it is harmless, and the next mint skips its number.

The run file records `base: <run branch>` and `prTarget: <target>` (P4). Under `merge` and `branch` modes `prTarget` is `null`. In an older run file it is
absent, and the server's `sanitizeMergeFields` resolves it to `null` **once**, the same way it resolves an absent `base` to `'main'`.

No tree has the run branch checked out, so §9's `merge-check` takes its existing outcome 2: it creates `.worktrees/_base-<sanitised ref>`, merges there, and
§10 removes that tree at the end because `baseTree.created` is true. That outcome is already built and tested, so this feature adds no code for it.

The run branch name is under `backlog/`, beside the item branches `backlog/<id>`. The two cannot collide: an item id is a bare number or `<section>-<n>` (`ITEM_ID_SHAPE`,
`shared/agent.ts`), and no backlog section is named `run`.

## 3. The loop

One SKILL.md line changes, plus the probe sentence.

- **§4's per-item `pull --ff-only origin <base>` is skipped when `mergeMode` is `pr`.** It reads the requested mode, so a degraded PR run still skips it.
  Nobody else writes the run branch, so there is nothing to pull. Before the first merge's push the remote ref does not exist yet, so the pull would fail and
  park the run.
- **§9's tracker push is byte-identical**: `git -C "<base tree>" push origin <base>`, now pushing the run branch. The first one creates the remote branch.
  Its three outcomes (success → `stage <n> merged --outcome`, which closes the issue (P2); rejected → park; classifier-denied → park) are unchanged.
- **§2's merge probe runs in `pr` mode as in `merge` mode**, with the tracker shape. In `branch` mode it is still skipped.

The tracker hard limit, "exactly three commands" (`pull --ff-only`, `push origin <base>`, `push -u origin backlog/<n>`), still holds for git. PR mode adds
no git command to that list; it adds one remote-writing `gh pr create` at the end (§4), which every place that restates the limit names beside the three
(`SKILL.md`'s hard-limit bullet, `references/tracker.md`'s *Hard limits — the three pushes*, `.claude/rules/orchestrator.md`'s push bullet).

The run branch carries `--no-ff` merge commits, and the squash merge flattens them. The ruleset's linear-history rule applies to `main`, not to the PR's head
branch.

## 4. Finishing — the pull request

The PR is opened when **`mergeMode` is `pr`, at least one queue item is `merged`, and the finish is `done` or `failed`**. A `paused` run is resumed onto the
same branch later, so a PR then would be premature. An `aborted` run is torn down: by a Stop, which a person chose, or by a `--abort` whose session follows
`references/recovery.md`'s order-of-operations, which should not grow a publish step. For an aborted run the summary names the pushed branch and gives the
exact `gh pr create` line to run by hand; the driver runs `pr-draft` (step 1 below) for that line, which writes only under `<dir>` and so is not a publish.

In SKILL.md §10, after the existing base-worktree removal and before `finish`. A `failed` finish today is reached from §5's "Stopping the run is
`finish --status failed`" without passing §10; that sentence changes to send the run through §10's finishing steps (base-worktree removal, then these three)
before `finish --status failed`, so `failed` and `done` share one path:

1. `orchestrate.mjs pr-draft` reads the run file and git, writes `<dir>/pr/body.md`, and prints one JSON line `{ title, bodyFile, head, target }`. `head` is
   the run branch and `target` is `prTarget` — not `base`, which in every SKILL.md command means the run branch. It refuses (exit `1`) unless `mergeMode` is `pr` and some item is `merged`, and also when `prUrl` is already set:
   the PR exists, and a resumed session must not draft a second one.
2. Before creating, the driver asks whether a PR already exists for the head, which covers a session that died between `gh pr create` and step 3 and was
   resumed: `gh pr view <head> --json url --jq .url`, from the project root. A URL printed there goes straight to step 3. Otherwise the driver runs `gh pr create --base <target> --head <head> --title "<title>" --body-file "<bodyFile>"` from the project root, as its own Bash call. The
   title can go in argv because the tool composed it from a fixed vocabulary, a count and nothing else.
3. `orchestrate.mjs pr --url <url>` records `prUrl` on the run. It accepts only `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$` and exits `1` on anything
   else, writing nothing.

**A failed or classifier-denied `gh pr create` is not a park and does not change the finish status.** The items are merged, pushed and closed, and only the
PR is outstanding. The summary names the branch and gives the exact command. `gh`'s failure output and the classifier's `Reason:` are read and never passed to
a tool argument, the same rule §2's `--note` follows. The one piece of `gh` output that does travel is a PR URL, and only through `pr --url`'s pattern.

### Title

`<type>(backlog): <N> item(s)` — `1 item`, `2 items`. `<N>` counts the queue items staged `merged`.

`<type>` comes from each merged item's own work commit, not from its item type. The §6 commit subject is already a Conventional Commit chosen per item, e.g.
`fix(orchestrate): re-claim a tracker item's issue when it leaves parked`. The tool finds the item's merge commit as the first-parent commit in
`<prTarget>..<base>` whose subject begins `Merge backlog/<id>: `. It then reads the subject of the first commit `git rev-list --reverse --topo-order M^1..M^2` prints (parent before child, so
a skewed author clock cannot reorder it): that is the §6 commit, and
fix-loop commits come after it. Each item's type is ranked `feat > fix > perf > chore`. Any other type (`refactor`, `docs`, `test`, …) and an unparseable
subject rank as `chore`. The highest rank across the merged items wins. An item staged `merged` whose `Merge backlog/<id>: ` commit is not found (merged by
hand, then staged — `references/tracker.md`'s carry-forward) also ranks `chore` and still gets its `## What's new` line; `pr-draft` never refuses over it.

A run whose only breaking item is `refactor!` or `chore!` gets a plain `chore(backlog)` title: `pr-title` allows `!` only on a releasing type, so that is
the intended consequence, not an omission.

`perf` extends D8's "any feat → feat, else any fix → fix, else chore". Without it, a run of performance work would ship as `chore` and cut no release under
Phase C.

**Breaking.** If any merged item's subject carries `!` and the winning type is `feat`, `fix` or `perf`, the title carries `!` after the scope. The `pr-title`
rule allows `!` only on those three types, and a breaking change hidden under a plain type would mis-version the release.

### Body

```markdown
## What's new

- <item title> (#<n>)
- …

## Run

`<runId>` drained onto `<head>` from `<target>`: <N> merged, <b> branched, <k> parked, <f> failed, <s> skipped, <u> ungroomed, <q> needs-answers.
```

`## What's new` lists the merged items in queue order, by their run-file `title`. Phase C's tag message takes that section verbatim, so it is what becomes
the release notes. Issue titles are written as problem statements, not release notes; the person merging the PR edits the lines before merging if they want
to, and the template leaves that to them. The `## Run` line covers every terminal `RunStage` in that fixed order and omits each zero count; when `branched` is nonzero (a degraded run, §6) it adds
one line naming those branches and saying they merge only after this PR lands. Its own heading ends the `## What's new` section for Phase C's extraction
(`^## `).

### Nothing merged

If no item reached `merged`, no PR is opened. On every finish but `paused`, `finish` then deletes the local run branch, but **only when
`git rev-list --count <prTarget>..<base>` is `0` and no worktree has the branch checked out** (`treeHoldingBranch`). The delete is
`git update-ref -d refs/heads/<base> <sha it just read>`: a compare-and-delete that depends on no tree's HEAD, where `git branch -d` from the project root
would judge "merged" against whatever the root has checked out — the HEAD-relative shape bug-38 removed from `cleanup`. A run whose merge landed locally and whose push was refused has commits on the branch with no item
`merged`, and that branch is kept and named in the summary. Nothing was pushed, so there is no remote branch to delete. `finish` runs the delete in the tool,
the same way `cleanup` already runs its git. On the ordinary path the base worktree has been removed by then. When either condition fails (an aborted run can
leave the `_base-` tree in place) or git refuses, `finish` writes one stderr line, keeps the branch and never fails.

A degraded run that branched every item and merged none deletes the run branch this way too. Its branched items were cut from the run branch while it still
equalled `<prTarget>`, so §10's merge list names `<prTarget>` as the branch to merge them on — never the run branch, which no longer exists.

## 5. The board

- **Sheet.** `mergeModeOptionLabels(base)` gains `pr`, labelled `Open a PR into <base>` (`Open a PR into the base branch` when `base` is `null`). The option
  is offered only when the selected project's source is `github`. The sheet holds only `project: string` today, so it gains a `source: SourceKind` prop,
  passed by `BoardView` from the registered project's `ProjectSummary.source` — never read off `items[0]`, which is absent on an empty queue. If the Settings default is `pr` and the project is a files one, the sheet
  falls back to `merge`, the same posture as an out-of-range stored value. The merge-coverage hint (no `git merge` allow rule in
  `.claude/settings.local.json`) is shown for `merge` **and** `pr`: a PR run asks the classifier for the same merge at every item, so the hint applies to it
  just as much. Its condition widens from `mergeMode === 'merge'` to `mergeMode !== 'branch'`, both in the render and in the effect that fetches it.
- **Settings.** The default-merge-mode picker lists `pr` with the base-less label. Settings is pre-project, so it cannot hide the option per source; the sheet's
  fallback above covers a files project.
- **RunDetail.** `mergeModeLabel` (`client/src/lib/run-stage.ts`, not `merge-mode.ts`) returns `PR mode` for an effective `pr`. A degraded PR run reads `branch mode (downgraded)` as today. When `prUrl` is set,
  the detail sheet's head shows a link-out labelled `PR #<n>`, opened with `rel="noopener noreferrer"`. The server's `sanitizeMergeFields` re-applies the
  §4 URL pattern and drops anything else to `null`, so the href's safety does not rest on the tool alone. The same reasoning is why `linkBase` is clamped.
- **Remote runs** need no logic: a claim publishes `mergeMode: 'pr'` and `base: <run branch>`, and the remote derivation copies both. They need two fields,
  though: `OrchestratorRun` gains `prTarget: string | null` and `prUrl: string | null` as **required** fields (resolved once by `sanitizeMergeFields`, as
  `base` is), so every literal that builds a run — `remote-runs.util.ts`'s field-by-field run, `cmdInit`'s skeleton and the test fixtures — fails typecheck
  until it says `null`. That is the forcing function; optional fields would let a reader forget the fallback.

## 6. Error handling, in one place

| Event                                             | Outcome                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pr` requested for a files project                | Server 400 before spawning; `init` exit `1`, nothing written                                         |
| `ls-remote` fails at mint                         | One stderr line; mint from local refs only                                                           |
| Two machines mint the same name anyway            | The second machine's first push is rejected → that item parks. `references/tracker.md`'s "`--resume` pulls and pushes again" does **not** hold in PR mode (§3 skips the pull): the recovery is `--abort` and a fresh `init`, which mints the next number. The parked item's merge stays on the abandoned local branch, named in the summary |
| Merge denied by the classifier                    | `merge-mode branch --note …`, `pr → branch`; earlier merged items still get the PR at finish. Later items are cut from the run branch and pushed as `backlog/<n>`; they carry the run branch's pre-squash merges, so the summary names the PR first and says each branched item is merged only after the PR lands, rebased onto `<prTarget>` |
| Push of the run branch rejected or denied         | The item parks (unchanged §9 rule)                                                                   |
| `gh pr create` fails or is denied                 | Not a park; summary names the branch and the command; `prUrl` stays `null`                           |
| `pr --url` given anything but a GitHub PR URL     | Exit `1`, nothing written                                                                            |
| Run finishes with nothing merged                  | No PR; local branch deleted when empty, kept and named when not                                      |

## 7. Testing

The plan names exact cases; the shape is:

- **`orchestrate.test.mjs`** (node, beside the tool):
  - `init --merge-mode pr` on a tracker fixture creates `backlog/run-<today>-1` at the target's tip and records `base`, `prTarget` and `mergeMode`.
  - A second `init` the same day mints `-2`. An existing `-1` that exists only on a bare "origin" fixture also mints `-2`.
  - On a files fixture, `init --merge-mode pr` exits `1` and leaves no branch and no run file behind.
  - `merge-mode branch` is accepted from `pr`, and refused from `branch`.
  - `stage merged` is legal under `pr`.
  - `pr-draft` ranks the types: feat beats fix beats perf beats chore, and `refactor` counts as chore. Breaking `!` is carried. The count is singular for
    one item. The body lists items in queue order and omits zero counts. `pr-draft` refuses with nothing merged.
  - `pr-draft` refuses once `prUrl` is set; an item staged `merged` with no `Merge backlog/<id>: ` commit ranks `chore` and is still listed.
  - `pr --url` accepts a GitHub PR URL and refuses `javascript:`, a non-GitHub host and a non-`/pull/` path.
  - `finish` deletes an empty run branch and keeps a non-empty one.
- **jest:** `resolveMergeMode` gives a 400 for `pr` on a files project and appends `--merge-mode pr` for a tracker one. `sanitizeMergeFields` resolves an
  absent `prTarget`/`prUrl` to `null` and drops a non-GitHub `prUrl`. The sheet offers `pr` only for a tracker project and falls back from a `pr` default on
  a files one. `mergeModeLabel('pr','pr')` is `PR mode`. RunDetail renders the link only for a valid `prUrl`.
- **`test/agents-shared.test.ts`**'s `expect(MERGE_MODES).toEqual(['merge', 'branch'])`, `test/settings-view.test.tsx`'s option list and
  `mergeModeOptionLabels`' `Record<MergeMode, string>` (`client/src/lib/merge-mode.ts`) go red until `pr` is classified. That is the forcing function, and no test is
  weakened to get past it.

## 8. Docs

- `orchestrate.mjs`'s `cmdFinish` comment, which calls it a pure status write, and `references/recovery.md`'s abort order: `finish` now runs one `git branch
  -d` in PR mode (§4, *Nothing merged*).
- After a PR opens, the local run branch is kept and nothing deletes it (the repo setting deletes only the remote head on merge); the mint's local-refs read
  is why its numbers keep rising across runs on one machine. SKILL.md §10 says so in one line.

- `.claude/rules/orchestrator.md`: the merge-mode bullet gains `pr`, with the run branch, `prTarget` and the PR at finish. The push bullet notes that PR mode
  pushes the run branch through the same §9 command and adds no fourth push.
- `docs/subsystems/invariants.md`: a new anchor, *PR mode drains onto a run branch and opens one PR per run*, with P2's and P4's reasoning. It gets a
  **new bullet of its own** in `.claude/rules/orchestrator.md` (one anchor per bullet) and a CLAUDE.md headline byte-equal with that bullet's
  (`test/claude-rules.test.ts`); the existing merge-mode bullet only gains `pr` in its vocabulary.
- `skills/backlog-orchestrate/SKILL.md`: the trigger line, §2's mode list, the §4 pull skip, and §10's three PR steps, each entering as one statement.
  `references/tracker.md` carries the rare branches: the `ls-remote` fallback, a denied `gh`, and the nothing-merged branch delete. This follows the
  "a new orchestrate rule enters SKILL.md as one statement" invariant.
- `docs/workflows/ci.md` §The ruleset: once this lands and the Settings default is `pr`, the ruleset can be applied. The first bullet then says that a run
  opens a PR instead of pushing `main`.
- `docs/subsystems/board.md`: the sheet's third option and the RunDetail link.

## Rollout

1. Land this feature through a PR (CI is green on it; the ruleset is still off here).
2. Rebuild the stack **before** `pnpm run plugin:sync`. An older server answers a claim carrying `mergeMode: 'pr'` with a 400 (`run.mergeMode must be one
   of merge, branch`), so every item's claim would fail at preflight.
3. Set this machine's Settings default merge mode to `pr`, then run one small PR-mode run on this repo and read the PR it opens.
4. Apply the ruleset (`apply-repo-settings.sh futin/backlog-manager`, dry run first) — the user's step, out of this plan.

## Out of scope

- Applying the ruleset; `docs/workflows/publishing.md`'s "commit on main, push" becoming a PR. Both are separate steps the user takes.
- Detecting a PR-only base and choosing `pr` automatically. The Settings default is the lever.
- Merging the PR, enabling auto-merge, or waiting for its CI. The run ends at an open PR.
- Updating the run branch from a target that moved during the run. GitHub's "Update branch" is the person's tool, and the PR shows the conflict.
- Files projects (P3).

## Unproven

- That `gh pr create` from a headless, auto-mode session is allowed by the classifier. If it is denied, §4's fallback still ends the run cleanly, but the
  ruleset would then cost a manual `gh` line per run. The first real PR-mode run (Rollout step 3) answers it.
- That `gh` is authenticated on every machine that drains a tracker project. A machine without it falls into the same fallback.
