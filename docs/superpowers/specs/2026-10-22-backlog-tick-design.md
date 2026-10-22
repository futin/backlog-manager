# backlog-tick: one unattended unit of backlog work per scheduled tick

Date: 2026-10-22. Status: draft, awaiting approval.

## Why

The dashboard (`claude-agents-dashboard`, #250/#251) now runs scheduled jobs: a job file with a cron line, `run: claude`, `foreach: pinned`, and a one-line
body like `/git-sync`, launched headless (`claude -p`) once per pinned repo. `backlog-execute --finish pr` (#326/#327) can now take one groomed item all the
way to a reviewed PR without merging anything. Together they make unattended backlog cleanup possible, but nothing yet decides *what* a scheduled session
should do in a given repo at a given moment.

The ask: a skill a schedule can fire as often as it likes. Each tick looks at the repo, does nothing if the backlog pipeline is busy, and otherwise does exactly
one useful unit of work — execute one ready item into a PR, or groom one item into a plan. The morning after a night of ticks, the board has both more plans
waiting for the user's review and some items drained into PRs.

`backlog-orchestrate` is not the answer here: it is built to drain a whole queue in one long run and merges. The user's words: orchestrate is too big for task to
task execution.

## Goals

- A skill `backlog-tick` (trigger `/backlog-tick`) that a dashboard job runs per repo. One tick does **at most one unit of work**: one execute, or one groom.
- **Idle-gated.** If anything is already happening to this project's backlog, the tick exits at once, says why, and costs almost nothing.
- **Execute first.** When a ready item exists and the open-PR cap allows, the tick executes it through `backlog-execute <id> --finish pr`. Otherwise, when the
  waiting-plan cap allows, it grooms one item. Otherwise it reports "nothing to do".
- **The user's review gate survives automation.** No plan a tick wrote is executed until the user has approved it, by removing a `plan-review` mark — a
  frontmatter line on a files project, a label on a tracker project.
- **Bounded pile-up.** Two caps, set per schedule on the trigger line: at most M open execute PRs, at most N plans awaiting review.
- **No retry loops.** An item a tick failed on is skipped by later ticks until its content changes.
- Works on both project sources: files (`backlog/` directories) and tracker (GitHub issues).

## Non-goals

- No merging, ever. Execute's `pr` finish opens a PR and stops; a human (or GitHub) merges. `backlog-orchestrate` stays the only skill that merges.
- No committing of grooms. A tick's groom lands on disk only, exactly as a hand groom does today. Whoever commits it (the user, `/git-sync`) does not approve
  it — the `plan-review` mark does.
- No promoting ideas, no reject / out-of-scope verdicts. Those stay the user's.
- No new scheduler. The dashboard's job file is the only trigger; this repo ships no cron, launchd or watcher of its own.
- No board control for approving a plan in this version — the user deletes the frontmatter line or removes the label (GitHub or `backlog.mjs`). A one-click
  "approve plan" is a follow-up.
- No change to `backlog-orchestrate`, other than its queue honouring `plan-review` the way it honours `in-review` — and since its `in-review` gate is tracker-only, the files walk gains a
  frontmatter read of `plan-review:` too.
- No GitLab. Same scope as execute's `pr` finish.

## Anti-goals (failure even if it technically works)

- A tick executing a plan the user never approved — on either project source.
- Two ticks (or a tick and a human session, or a tick and an orchestrator run) working the same item, or the same project, at once.
- A tick that keeps retrying the same impossible item every night, burning tokens for nothing.
- A tick that asks a question. A scheduled step has `AskUserQuestion` disallowed and nobody watching; a tick that ends its turn on a prose question has done
  nothing and reported success.
- A tick that touches work in the repo's checkout that is not a backlog item file — the scheduled step's cwd is the user's main checkout.
- The morning stack: a dozen PRs that conflict with each other, or twenty plans to read.

## Decided by the user

1. **Each tick does a bit of either** — groom or execute, one unit, not a full drain.
2. **Execute route:** `backlog-execute <id> --finish pr` (the user reworked execute for exactly this; reviewed on main 2026-10-22).
3. **The approval is an explicit `plan-review` mark on both sources** — a `plan-review: true` frontmatter line on a files project, a `plan-review` label on a
   tracker project. A tick's groom writes it; every execute gate skips a marked item; the user removes it to approve. (First answer was "the uncommitted groom
   is the gate"; changed after the builder check, because `/git-sync` commits any uncommitted work and would silently approve every tick plan.)
4. **Execute wins over groom**, and **waiting plans cap grooming**: groom only while fewer than N plans carry `plan-review`.
5. **Open execute PRs cap executing**: execute only while fewer than M `execute/*` PRs are open. Groom may still run while execute is capped.
6. **Tracker label mirrors `in-review`**: an eleventh tracker label and a write route.
7. **Groom verdicts a tick may make:** plan a bug's fix (Cause + Fix), and **promote a refactor** into a planned task. Never promote an idea, never reject.
8. **Design questions are decided alone.** Where groom would brainstorm with the user (promote; plan-the-fix that needs design), a tick groom settles the open
   questions itself and writes them into the plan under an `Assumptions (unattended)` heading. The user's `plan-review` is the check.
9. **On failure, skip until the item changes**: the tick records the failure keyed by item and content hash, in its own state outside the repo; later ticks
   skip it until someone edits the item.
10. **Name:** `backlog-tick`; tool `tick.mjs`; state under `~/.backlog-manager/tick/`.

## How it is triggered

A dashboard job file, for example:

```markdown
---
cron: "*/30 0-6,22-23 * * *"
machines: [mac]
run: claude
foreach: pinned
permission-mode: auto
timeout: 90m
---
/backlog-tick --max-prs 2 --max-plans 3
```

`--max-prs` (M) and `--max-plans` (N) are optional; my call on defaults: M = 2, N = 3. A pinned repo that has no backlog store (not registered, no
`backlog/`) is a no-op tick that exits 0 with one line, so `foreach: pinned` is safe across every pin. My call: a pin that is a **linked worktree** is also a
no-op (`idle: not a main checkout`) — execute's `pr` finish reuses a clean linked worktree on its own branch, which would commit and push tick work onto the
user's feature branch.

The scheduled step's environment carries `CLAUDE_DASHBOARD_SCHEDULE=<job>` and `--disallowed-tools AskUserQuestion` (dashboard spec, "The wrapper"). The tick
runs unattended whether or not that variable is set — it is never meant for interactive use — but a typed `/backlog-tick` in a normal session works the same
way and is the way to try it by hand. My call: `--dry-run` prints the decision without acting, for exactly that.

## One tick, end to end

The decision (steps 1-4) is made by a deterministic tool, `skills/backlog-tick/tools/tick.mjs decide`, which prints one JSON verdict. The skill only acts on
that verdict (steps 5-6). This keeps an idle tick to one tool call and one line of output, and makes the rules testable with `node --test` beside the tool.

0. **Stack check, tracker projects only.** Every `backlog.mjs` verb in a tracker project exits `5` with the stack down, and the claim and label reads need
   the API. So a tracker project with the stack down is verdict `idle: stack down`, exit 0, taken before the lock and before any other check. A files project
   never needs the stack.
1. **Lock.** `decide` takes a per-project lock under `~/.backlog-manager/tick/<project-key>/lock`, holding host, the verdict it handed out and a timestamp —
   not a pid, since `decide` exits at once. `record` (step 6) releases it. A lock older than a fixed ceiling (my call: 3 h, comfortably above any sane job
   `timeout:`, overridable with `--lock-ttl`) is a dead tick's and is replaced — see "A tick the dashboard killed" below. Held and fresh → verdict
   `busy: another tick`. This closes the window between a tick choosing an item and execute/groom writing its `started:` marker or claim. The lock is per machine (`~/.backlog-manager` is local); for a tracker project ticked from two
   machines the only cross-machine guard is the claim race at `start`, which the losing tick reports as `failed`.
2. **Busy check.** Any of these → verdict `busy: <reason>`, exit 0:
   - an orchestrator run for this project whose `run.json` says `running` or `paused` (read under `$BM_ORCH_HOME` or `~/.backlog-manager/orchestrator/`);
   - a board-started run that has no run file yet (server memory only — read through the API when the stack is up; when it is down there is no board to
     have started one, so the check is skipped, my call);
   - any open item carrying a `started:` marker (files) or a live claim (tracker) — a human or another session is grooming or executing. A files marker has
     no heartbeat, so on a files project **any** marker blocks the project, except one a dead tick left (below). My call: the files scan reads the main
     checkout **and every linked worktree** in `git worktree list`, because an in-place groom or execute in a linked worktree writes its `started:` there.
     Two kinds of tree are skipped: the orchestrator's own `.worktrees/<id>` trees (the run file already speaks for them) and `.worktrees/execute-<id>`
     trees (the candidate exclusion in step 3 and the lock speak for them — and a killed execute there would otherwise block the project for good);
   - a Jira live session is **not** a busy signal (my call): Jira work happens in its own worktree on a ticket, not on a backlog item.
3. **Execute candidate**, only if open execute PRs < M. Open execute PRs = every open PR in the repo whose head branch starts with `execute/`, read once with
   `gh pr list --state open --json headRefName`. That deliberately counts hand-run `--finish pr` PRs too: they cut from the same base and conflict the same
   way, and the cap is about the review pile, not who made it. Without a working
   `gh`, execute is treated as capped (step 3 contributes the reason `cannot count open PRs`; step 4 may still groom) — the repo squash-merges, so a branch's merged state cannot be read from git alone. The
   candidate is the first item, in the order orchestrate's queue already uses (a `runner-fix` item hoisted first), that is:
   - a bug or task, groomed (derived, as the board derives it);
   - **committed on the base** (files) — the same check orchestrate makes, `not committed on <base>`;
   - without `plan-review` and without `in-review`;
   - without an `execute/<id>` branch or `.worktrees/execute-<id>` worktree (a failed or still-open execute leaves both; execute itself would refuse, but the
     tick must not even pick it, or a files item that sits in `open/` until its PR merges would be picked every tick);
   - not skipped by the failure record.
   Drift is not checked here (my call): execute already re-checks a plan's drift before working it (#323), and a refusal there is recorded as `failed`.
   Found → verdict `execute <id>`.
4. **Groom candidate**, only if items carrying `plan-review` < N (counted the same way on both sources). The candidate is the first open item, in board order,
   that is an ungroomed bug or a refactor, and is not in the failure record. Found → verdict `groom <id>`. Otherwise → `idle: nothing to do`, with the reason
   each cap or empty queue gave.
5. **Act.** Before acting, `decide` has written the verdict into the lock (step 1).
   - `execute <id>` → run `backlog-execute <id> --finish pr` in this session via the Skill tool, with the tick marker (below). The PR it opens is the tick's
     output.
   - `groom <id>` → run `backlog-groom <id>` in this session via the Skill tool, with the tick marker. The groom writes `plan-review` **in the same write that
     lands the plan**, never as a second step: on a files project as a frontmatter line in the file it writes; on a tracker project as a `--plan-review` flag
     on `backlog.mjs body` / `new`, the way `--runner-fix` already rides on those two verbs. A promote puts it on the **new** task, not the refactor's id. So
     there is no moment where an approved-looking plan exists without the mark.
6. **Record and release.** `tick.mjs record <id> ok|failed --kind groom|execute [--reason …]` writes the outcome and releases the lock; a `failed` stores the
   item's content hash, which steps 3 and 4 compare against on the next tick. The final message is one short paragraph: what the tick did, the PR URL or the
   item groomed, or why it did nothing — that is what the dashboard's run log shows.

### A tick the dashboard killed

A job's `timeout:` kills the step mid-work: the lock stays, and the item may keep a `started:` marker (files) or a claim (tracker, which goes stale after 15
minutes and is retired by the claim protocol when the next claimant's `start` runs). A step that runs out of `max-turns:` ends mid-work the same way and
takes the same recovery path. The next tick that finds a lock older than the ceiling reads the verdict recorded in it. The proof
that a marker is the dead tick's is exactly: the lock is stale, its verdict is `groom <id>`, and `<id>` in the main checkout carries `started:` with
`phase: groom`. Liveness of a session cannot be read on a files project (`started:` records when, never who), so the proof rests on the lock alone. When it
holds, the tick clears **that one marker** with `backlog.mjs stop <id> --abandon` (the interval was no one's work), records the item `failed`
(`killed at timeout`), and releases the lock. An `execute <id>` verdict needs no clearing: its marker lives in `.worktrees/execute-<id>`, which the main
checkout's busy check does not read. That is the only marker a tick ever clears: it is provably its own. Any
other marker is a human's or another session's and blocks the project until they clear it. A `--finish pr` execute writes its marker inside
`.worktrees/execute-<id>`, which the main checkout does not see; the `execute/<id>` worktree it leaves keeps that item off the candidate list anyway.

### The tick marker

Execute today knows one unattended mode, the `[orchestrator-run` marker, and it means "the orchestrator owns git and the worktree" — wrong here, since
execute's `pr` finish must own its own git. Groom has no unattended mode at all: it states a verdict and waits for the user to confirm it
(`skills/backlog-groom/SKILL.md` §"Three verdicts"), unless the prompt already named the item **and** the verdict, which groom reads as that confirmation
(§"Mark it in progress"). So the tick's groom trigger always names both — `groom bug-<n>, plan the fix [backlog-tick]` or `groom ref-<n>, promote it to a task
[backlog-tick]` — which meets groom's consent gate by the prompt. A new marker, my name `[backlog-tick]`, appended after the id, is read by both skills:

- **Never ask.** Every place the skill would ask the user — groom's verdict choice, the Reject confirmation, taking over a marker, brainstorming's questions,
  execute's escalations — is either decided alone (design questions, decision 8) or becomes "stop, leave nothing half-done, report it in the final message".
  The failure record then keeps later ticks off the item.
- **Groom under the marker** may only plan a bug's fix or promote a refactor. A groom that concludes the item should be rejected, or that cannot find a bug's
  cause with confidence, writes no verdict (its own `start`/`stop` bookkeeping still lands) and reports `failed` with its reason — the user sees that in the run log. Brainstorming and writing-plans still run
  where groom calls for them, but every question they would put to the user is answered by the session and listed under `Assumptions (unattended)` in the
  plan. On a files promote, groom keeps the printed frontmatter block exactly as printed; the marker text carves out the `plan-review: true` line the same
  way `runner-fix: true` is already carved out there.
- **Markers:** on a files project, never take over another session's `started:` marker. On a tracker project the claim protocol already retires a claim stale
  past 15 minutes when `start` runs; that is the protocol's rule, not a takeover the tick decides, and stays as it is — the busy check has already treated a
  live claim as busy.
- **Execute under the marker** is the `pr` finish as it is today. Its one difference from a typed run: nothing to ask, nothing to override.
- **Never run anything in the background** — the same rule the orchestrator marker carries, for the same reason (`claude -p` exits when the turn ends).

### The `plan-review` mark

**Files project:** a frontmatter line `plan-review: true`, written by groom under the tick marker. The tick reads it **at `<base>`**, the same tree the
committed-on-base check reads and the one execute's worktree is cut from, so approval on a files project is *delete the line and commit* (by hand or by
`/git-sync`) — a line deleted only in the working tree is not yet an approval, and a plan committed with the line still in it is not one either. It is a gate key in the
same family as `runner-fix:` — not a lifecycle key and not a status — so the "`started:` and `phase:` are the lifecycle keys" invariant is unchanged, but
its text should name `plan-review:` as a non-lifecycle key so nobody reads it as a third one. `groomed` stays derived exactly as today; `plan-review` is a
separate gate beside it.

**Tracker project:** mirrors `in-review` (#326, decision 9 there) step for step:

- An eleventh label in `TRACKER_LABELS` (`server/src/tracker/labels.ts`), its name exported as a constant beside `IN_REVIEW_LABEL`; description along the
  lines of "A plan written unattended — remove this label to approve it for execution". The poller's `ensureLabels` creates it.
- One new guarded `/api/items/*` write route that adds or removes it, under the same guards as the others (content-type, origin, refused for a `files`
  project, serialised per item), and a `backlog.mjs` verb that calls it (the user's way to approve from a terminal), plus the `--plan-review` flag on `body` /
  `new` that groom uses. Every site that states the route count or the label count moves with it — including `CLAUDE.md`'s Layout line that still says
  "nine guarded write routes" (nine `items-write.controller.ts` routes, `abort` the tenth write), the "ten" counts in CLAUDE.md and the rules file,
  `docs/subsystems/invariants.md`'s already-stale "The nine `/api/items/*` writes", "a closed ten" in `skills/backlog/SKILL.md`, and
  `test/tracker-labels.test.ts`'s `toHaveLength(10)` with its `describe('the ten labels')`.

**Readers, both sources:** the item mapping exposes a `planReview` flag (files: parsed from frontmatter; tracker: beside `queued` / `inReview` in
`map-issue.ts`); the orchestrator's queue excludes such items; execute's refusal gate refuses one ("this plan awaits review"); the board's per-item dispatch
ladders gain a rung that disables Run with that reason — client `DispatchButton.tsx`, and server-side a new `planReviewBlock` beside `inReviewBlock`
(`shared/agent.ts`), chained where `inReviewBlock` is in `agents.service.ts`. `dispatchBlock` is project-level and stays untouched.

### The failure record

`~/.backlog-manager/tick/<project-key>/state.json`, written only by `tick.mjs` (one writer, like the registry and the run file). Per item: last outcome, kind,
reason, timestamp, and — for `failed` — a content hash at the time. The hash is computed by `record`, **after** the skill's own `stop` has run, and only
over the item's body plus the frontmatter keys a person edits — never `updated:`, `started:`, `phase:`, `groomed-at:` or the `*-elapsed:` / `*-tokens:`
counters, which `start`/`stop` rewrite on every attempt and would make every failed item look edited. Files, a hash of the item file (at the base for
execute, the working tree for groom);
tracker, a hash of the issue **body** — not `updated_at`, which the tick's own label and comment writes bump and which would re-enable the item at once. An
item whose current hash differs from the recorded one is eligible again. My call: the record also keeps the last few verdicts per project (bounded, e.g. 50)
so `tick.mjs status` can print what recent ticks did. Nothing under this directory is read by the server in this version.

## Invariants this touches

- **New:** `~/.backlog-manager/tick/` has exactly one writer, `tick.mjs`, and `backlog-tick` never writes the orchestrator's run-state directory.
- **New:** a tick does at most one unit of work, only when the project is idle, and never executes a plan that still carries `plan-review`.
- **New:** the only `started:` marker a tick clears is the one a killed tick left, identified by the verdict in its own stale lock.
- **Amended:** the item write route count and the tracker label count, each up by one; the frontmatter-keys invariant names `plan-review:` as a non-lifecycle
  gate key.
- **Unchanged and leaned on:** groom never commits; execute commits and pushes only in `pr` finish, in its own worktree; orchestrate is the only skill that
  merges; `skills/` changes reach a machine only after commit → push → `pnpm run plugin:sync`.
- The new skill directory is `skills/backlog-tick/`, never under `.claude/skills/`. CLAUDE.md's skill count ("seven skills, six of them backlog skills") and
  the Layout list move with it.

## Settled as my calls (check these while reading)

- Caps default to M = 2 open execute PRs, N = 3 plans awaiting review; both per schedule via trigger flags.
- A pin with no backlog store, or one that is a linked worktree, is a no-op that exits 0.
- The decision is a deterministic tool (`tick.mjs decide`); the skill only acts on it. Groom and execute run inside the same headless session via the Skill
  tool, not as a second spawn.
- The lock holds host, verdict and timestamp, is released by `record`, and is stale after 3 h (`--lock-ttl`).
- Without `gh`, execute is treated as capped.
- A board-started run without a run file is only detectable while the stack is up; with the stack down the check is skipped.
- A Jira live session is not a busy signal.
- New marker `[backlog-tick]`, separate from `[orchestrator-run`, because execute must own its git here.
- Drift is left to execute's own pre-check; the tick does not read `stale-plans.json` (only `orchestrate.mjs` may) or `backlog.mjs drift`.
- `plan-review` lands in the same write as the plan, never after.
- Ungroomed tasks are not tick-groom candidates: groom has no "plan an existing task" verdict, and tasks are normally born planned by a promote.
- `--dry-run` prints the verdict without acting.

## Left to the builder

- Exact `tick.mjs` subcommands, flags and JSON shape; the project key used under `~/.backlog-manager/tick/` (the registry's key is the obvious choice).
- How much of orchestrate's queue/readiness logic is reused. Note the repo's pattern: `orchestrate.mjs` imports nothing from another skill, and shared code
  is kept as byte-identical copies with a test asserting they match (`drift-lib.mjs` lives in both `skills/backlog/tools` and
  `skills/backlog-orchestrate/tools`). Follow that pattern, or have `tick.mjs` shell out to `orchestrate.mjs plan --json` — say which in the plan.
- The `backlog.mjs` verb name for setting/clearing `plan-review` and its node tests.
- Where `[backlog-tick]` marker text goes in groom's and execute's SKILL.md versus `references/`, following the "one statement in SKILL.md, story in
  references/" habit.
- A tick that records `failed` still ends as an `ok` step in the dashboard (the claude result is not an error), so no failure push is sent. Whether the tick
  should end with an error result on `failed` so the dashboard pushes is a judgment call — the builder should weigh noise against visibility and say which.
- How the tick reads a headless permission refusal inside execute's `pr` finish — execute already stops and reports; recording `failed` keeps the item off
  until edited, which is wrong if the refusal was the environment's fault, not the item's. A distinct `blocked` outcome that does not key on the hash is one
  answer.
