# Backlog orchestrate — design

**Status: approved 2026-08-31.**

A fifth skill, `backlog-orchestrate`, drains a project's executable queue
unattended: every groomed bug and task, one at a time, each in a fresh headless
Claude Code session inside its own git worktree, reviewed by a dedicated
reviewer agent, verified by real commands, then merged to `main` — before the
next item starts. A run writes its state to a machine-local run file after
every transition, so a crash, a dropped connection, or a usage cap never loses
more than the step in flight, and the board can watch the whole thing live
through a run strip and a run drawer.

The skill exists because `backlog-execute` deliberately stops at one item and
never touches git. Ten groomed tasks today means ten manual dispatches and ten
manual merges. Orchestrate is the loop around execute — and only the loop:
execute keeps doing the work, groom keeps doing the planning, and the item
files keep being written by skills alone.

## Goals

- One invocation works the whole queue: groomed bugs first, then tasks, oldest
  first — the same "next thing" order execute already uses.
- Each item runs in an isolated fresh context (headless session per item), so
  cost does not compound across items and one item's context never bleeds into
  the next.
- Between items: commit, independent review, verification commands, merge to
  `main`. The next item starts from the updated `main`.
- Interruptions are cheap: the run file is a checkpoint after every state
  transition; `--resume` reconciles and continues; `--abort` cleans up.
- The user can observe everything from the board while away: live strip,
  drawer with per-item stages, and phone pings only when something needs them.
- Off by default in the UI, exactly like dispatch: without `BM_AGENTS` the
  board renders no orchestrate control at all.

## Non-goals (v1)

- No parallel items. The queue is strictly sequential — merge-to-main between
  items is the isolation mechanism, and parallelism would forfeit it.
- No multiple runs per project. The run file doubles as a lock; a second start
  on the same project refuses while the first heartbeat is fresh.
- No answering questions from the Runs UI. A skipped item says *why* in the
  drawer; answering happens by grooming the item and re-running. (The
  dashboard's remote-answer hook may carry questions to the phone when its
  machinery is installed — see "Questions" — but the UI itself gains no answer
  path.)
- No dashboard changes. Starting from the UI reuses `POST /api/spawn` exactly
  as card dispatch does today, with its existing gates and clamps.
- No new writers of item files beyond the skills that already write them.
  Orchestrate amends item bodies only during pre-flight Q&A, under the same
  round-trip rules groom follows.

## Decisions already made (brainstorm 2026-08-31)

| Question | Decision |
|---|---|
| Execution vehicle | Fresh headless `claude -p "/backlog-execute <id>"` per item |
| Merge autonomy | Auto-merge green items; phone ping only on friction (fix loops, retries, conflicts) |
| Success rules | Repo baseline commands always; optional `## Done when` extras per item |
| Review | Orchestrator-level custom reviewer agent shipped in the plugin's `agents/` dir |
| Git isolation | Worktree + branch per item |
| Progress tracking | Run-state file under `~/.backlog-manager/orchestrator/`, atomic writes, heartbeat |
| UI | Design C: run strip above the board + run drawer; start button in the board toolbar |
| Open questions in UI-started runs | Skip the item, surface it in the drawer; AskUserQuestion used when a phone channel exists |

## The skill: `skills/backlog-orchestrate/SKILL.md`

Trigger: `/backlog-orchestrate [ids…] [--max N] [--resume] [--abort]`.

### Queue

Build the queue from `backlog.mjs board --section bugs` then `--section tasks`,
oldest first within each. Apply execute's refusal gate *up front*, per item:
a task needs real content under `## Plan`, a bug needs `## Fix` that is not
`unknown`. Items that fail the gate are listed in the run file as
`ungroomed` — visible in the drawer, never dispatched, never a failure. Naming
explicit ids restricts the queue to those ids in the given order; `--max N`
caps how many items the run will merge before stopping cleanly.

The gate is re-checked here even though execute checks it again inside the
session, for the same reason execute checks Cause live: the orchestrator's
copy avoids burning a whole session spawn on an item that will be refused in
its first minute, and execute's copy stays authoritative.

### Pre-flight, per item

Before dispatch, read the item body and hunt for open questions: `TBD`,
unresolved either/or phrasing, empty sections the plan references, a `## Done
when` naming commands that do not exist in the repo. Then:

- **A question channel exists** (interactive terminal run, or spawned with the
  dashboard's remote-answer hooks — the same machinery that lets groom run
  headlessly today): ask via `AskUserQuestion`, write the answer into the item
  body under the section it clarifies, and proceed. Orchestrate is a plugin
  skill and therefore a legitimate item writer; it follows groom's write
  rules — round-trip unknown frontmatter keys and the rest of the body
  byte-for-byte, write before any move.
- **No channel, or the ask times out**: mark the item `needs-answers` in the
  run file with the questions verbatim, skip it, continue the queue. The
  drawer surfaces it; answering is a groom edit, and the next run picks the
  item up.

### Per-item loop

Every transition below is written to the run file before the next step starts.

1. **Worktree**: `git worktree add .worktrees/<id> -b backlog/<id> main`.
   The main working tree is never touched; a dirty main tree does not block a
   run because the worktree checks out `main`'s HEAD, not the working tree.
2. **Mark + dispatch**: run `claude -p "/backlog-execute <id>"` with the
   worktree as cwd, `--output-format stream-json`, capturing the session id
   into the run file the moment it is known. Execute does everything it does
   today *inside the worktree*: `start --as execute`, the work itself (TDD,
   systematic-debugging, executing-plans), verification, `## Outcome`, `stop
   --keep-started`, `move … done`. The item's archive move rides the branch
   and reaches `main` in the merge.
3. **Inspect**: when the session exits, read the item's state in the worktree.
   Moved to `done/` with a verification-bearing `## Outcome` → continue.
   Still open with a failure `## Outcome` (execute's failure path) → ping:
   retry with guidance (`claude -p --resume <session-id>` keeps that item's
   context), skip, or stop the run. Session died without either (crash, cap,
   network) → same ping, with the session id available for resume.
4. **Commit**: the orchestrator commits everything in the worktree on
   `backlog/<id>`. Execute keeps its own hard limit — it still never commits;
   the orchestrator is the committer, and says so in the commit body. Subject
   from the item title, conventional-commit shaped.
5. **Review**: dispatch the `backlog-reviewer` agent (below) on the branch
   diff. Verdict `approve` → continue. Findings at Critical/Important → fix
   loop: resume the item's session with the findings pasted in, re-commit,
   re-review. At most **2** fix loops, then ping the user with the verdict
   file's path and the options: merge anyway, keep fixing, skip, stop.
6. **Verify**: run the project's baseline commands in the worktree, plus any
   commands under the item's `## Done when`. The baseline comes from
   `backlog/verify.json` — an optional, user- or skill-written list of shell
   commands (in this repo it would say `pnpm test`, `pnpm run typecheck`,
   `pnpm run build`); the skill is a legitimate writer of `backlog/`, the
   server never reads the file. Absent, the skill falls back to the obvious
   scripts in `package.json` (`test`, `typecheck`, `build` when present).
   With no baseline *and* no `## Done when`, the item cannot prove itself:
   it parks with a ping rather than merging unverified — annoying on an
   unconfigured repo, but "merged, verified by nothing" is the false-done
   this whole system exists to prevent. This step re-runs checks execute
   already ran because the fix loop may have changed code after execute's
   verification; green here is the merge gate, and the outputs land in the
   run file.
7. **Merge**: `git -C <repo> merge --no-ff backlog/<id>` into `main`, then
   remove the worktree and delete the branch. A conflict (possible when the
   user pushed to `main` mid-run) → ping and park the item; its branch and
   worktree stay for manual resolution.
8. **Next item** — from the updated `main`, so later items build on earlier
   ones.

A clean item — no fix loops, no retries, first-try green — produces no ping at
all; the run summary at the end names every merge. Items that needed
intervention are pinged as they happen via `AskUserQuestion`.

### Run file

`~/.backlog-manager/orchestrator/<project-key>/run.json`, where
`<project-key>` is a directory-safe encoding of the project's registered
absolute path (exact encoding pinned in the plan; it must be readable back to
the path so the server can key runs by project without a lookup table) — *not*
stored inside the repo, because run state is transient and machine-local, and
living in-repo it would ride every branch merge as noise.

Shape (fields, not literal schema — the plan pins exact names):

- run: id, project path, status (`running | done | aborted | failed`),
  started/updated timestamps. `updated` is the heartbeat, stamped on **every**
  write.
- queue: ordered item records — id, title, stage (`pending → preflight →
  dispatched → inspecting → reviewing → fixing → verifying → merging →
  merged`, or terminal `failed | skipped | needs-answers | ungroomed |
  parked`), session id, worktree path, branch, per-stage timestamps, fix-loop
  count, verification tails, ping log.
- attention: the surfaced list the drawer renders — skipped items with their
  questions, parked merges, exhausted fix loops.

Writes are atomic (write tmp, rename). The file is also the **lock**: on
start, a run file with `status: running` and a heartbeat fresher than a stale
threshold (minutes, pinned in the plan) refuses a second run on the project;
a stale heartbeat is a crashed run and `--resume` may take it over.

`--resume` reconciles the file against reality before continuing: does the
worktree exist, does the branch, where is the item file actually, does it
carry a `phase:`/`started:` marker. A marker with no live session behind it is
cleared with a plain `stop <id>` (billing the time spent — the tool already
does this correctly) before re-dispatch. `--abort` walks the same
reconciliation but tears down: stop markers cleared, worktrees removed,
branches deleted, run marked `aborted` with everything it had merged so far
intact.

### Hard limits

- **Sequential, always.** No flag enables parallel items in v1.
- **Never merges red.** Verification failure parks the item exactly like a
  conflict; nothing green-lights a merge except the commands passing.
- **Never force-pushes, never rewrites `main` history.** Merge commits only.
- **Never writes the registry.** `backlog.mjs` keeps its single-writer
  invariant untouched.
- **Item bodies**: only pre-flight Q&A amendments, groom's rules. Everything
  else in the item lifecycle is execute's, inside the session.

## The reviewer: `agents/backlog-reviewer.md`

The plugin grows an `agents/` directory (its first). The reviewer is a custom
agent definition, not a prompt pasted per dispatch, because the contract that
matters most — *the report goes to a file; the return message is the verdict
plus Critical/Important findings only* — has repeatedly lost to the superpowers
reviewer template when it lived only in the dispatch prompt. Baked into the
agent's own system prompt, it survives template drift and keeps the
orchestrator's context small enough to run a long queue.

The definition (system prompt, tools restricted to read/grep/bash) reviews the
item's branch diff against the item's `## Plan`/`## Fix`: correctness first,
invariant adherence second (CLAUDE.md's Invariants section is quoted to it),
test adequacy third. Output contract: write the full report to a path the
orchestrator hands it (inside the run's state dir, never the repo), return
`verdict: approve|fix` plus at most the Critical/Important list, one line
each.

## Server

Two additions to the Nest app, both under `/api`:

- `GET /api/orchestrator/runs` — reads every fresh run file under
  `~/.backlog-manager/orchestrator/`, returns them keyed by project. Read
  per request, never cached, never written — the registry pattern verbatim.
  Powers the strip and the drawer with one endpoint.
- `POST /api/agents/orchestrate` — the start path, living in the agents
  module because it is outbound: it spawns via the dashboard's
  `POST /api/spawn` with prompt `/backlog-orchestrate`, exactly as card
  dispatch spawns today, behind the same gates — `BM_AGENTS` on, origin
  guard, content-type guard, `dispatchGate` project membership (raw string
  compare, deliberately not realpath), dashboard lookback. Plus one gate of
  its own: **409 when the project's run file is fresh** — the lock enforced
  at the API as well as in the skill, defense in depth like the registry's
  single writer. The controller rebuilds the body field by field; the only
  client-controlled fields are `project`, `model`, `effort`,
  `permissionMode` (clamped, as dispatch clamps them). There is no prompt
  field at all — the prompt is a server-side constant, which is dispatch's
  "derive, never accept" rule applied to orchestration.

The run file is *read* by the server and *written* by the skill — one writer,
one reader, the registry relationship again.

## Client — design C

- **Run strip**: renders above the board columns whenever `GET
  /api/orchestrator/runs` returns a fresh run; one slim strip per running
  project, stacked when the board is unfiltered. Contents: live dot (heartbeat
  age), `merged/total`, current item id + stage, progress bar, attention
  count. Poll while at least one run is fresh (the `useAgents` cadence: mount,
  focus, and an interval that backs off when nothing is running).
- **Run drawer**: clicking the strip slides the existing drawer pattern over
  the board: pipeline chips (merged / active / queued / attention), per-item
  rows with stage, elapsed, fix-loop count, verification tail, and the
  attention list with each skipped item's questions verbatim. Read-only in v1.
- **Cards**: stage badges on cards come from the *run file*, not the item
  file. Execute's `start` writes its amber marker inside the worktree, and
  the board reads the main tree — so during a run the item file the board
  sees never changes until the merge lands. The run payload the strip
  already polls carries stage per item id; cards whose id appears in a fresh
  run render a small stage badge (`executing`, `reviewing`, `merging`,
  `needs answer`) from that payload. Same data, same poll, no new endpoint —
  and no lying: the badge disappears the moment the run file goes stale.
- **Start control**: when the board is narrowed to one project, `BM_AGENTS`
  is on, the dashboard sees the project, and no fresh run exists → the board
  toolbar shows **Orchestrate**, opening a launch-sheet variant: queue
  preview (gate results per item: ready / ungroomed / needs-answers), model
  and effort pickers seeded from Settings (`dispatchDefaultModel` /
  `dispatchDefaultEffort`, clamped — the existing invariant), permission mode
  from `plan.defaultMode` clamped to the host ceiling. Environment-level
  blocks hide the control; only project-visibility disables it — the existing
  dispatch rule, unchanged.

## Questions, headless, and the phone

This session's own machinery is the proof of concept: the dashboard's
remote-answer hooks catch `AskUserQuestion` from spawned sessions and surface
them to the phone. When the orchestrator runs under that machinery, pre-flight
questions and friction pings reach the user wherever they are. When it does
not — hooks missing, or a bare `claude -p` on a box without the dashboard —
every ask degrades to skip-and-surface: the run file records the question, the
drawer shows it, the run continues. The skill treats the ask as best-effort
with a timeout; the run never stalls on an unanswered question, because a
stalled unattended run is the failure mode this design exists to avoid. The
one exception is the merge-anyway ping after exhausted fix loops: with no
channel, the item parks (`parked`, branch kept) rather than merging, because
"merge unreviewed changes silently" is not a default anyone chose.

### Inner-session permissions

The per-item `claude -p` sessions must edit files and run tests headlessly.
v1 runs them with `--dangerously-skip-permissions`, and the spec says so out
loud rather than hiding it in a flag table, because it is the design's most
load-bearing trade: the blast radius is contained by the worktree (a fresh
checkout, disposable), by the review pass, by the verification gate, and by
the merge being the only door back to `main`. A future knob can tighten this
to an allowlist; v1 does not, because a permission prompt inside a headless
session with no channel is a hang.

## Invariants this adds (CLAUDE.md, after implementation)

- The run file has exactly one writer (the orchestrate skill) and one reader
  (the server); it lives outside the repo.
- Orchestrate is the only skill that commits or merges, and only on
  `backlog/<id>` branches and `main`, only via merge commit, never a
  force-push. Execute's "never commits, never pushes" stands unchanged.
- One run per project: the fresh-heartbeat lock is enforced in both the skill
  and the API.
- The orchestrate spawn prompt is a server-side constant; the endpoint accepts
  no prompt text.

## Risks and early verifications (plan must front-load these)

1. **`backlog.mjs` inside a worktree.** The tool resolves the store from the
   git root of its cwd; a worktree is a git repo with `backlog/` checked in,
   so `show`/`start`/`stop`/`move` should behave. Verify first, before
   anything else is built — if wrong, the whole worktree strategy needs a
   `--repo` flag on the tool, which is a different plan.
2. **`git worktree add` from a repo whose `main` is checked out in the main
   tree.** Creating a worktree on a *new branch* off `main` while `main` is
   checked out elsewhere is legal; merging back happens in the main tree.
   Verify the merge step's behavior when the main working tree is dirty in
   unrelated files (expected: fine unless paths overlap).
3. **Registry vs worktree paths.** The board reads the *registered* path's
   `backlog/`; worktree changes are invisible until merge. That is the
   designed behavior (the strip is the live view), but the drawer copy must
   say it, or a user will read "executing" on the strip and an unchanged
   board as a bug.
4. **Dashboard lookback** applies to orchestrate spawns exactly as to
   dispatch: a project with no session in `LOOKBACK_HOURS` cannot be started
   from the UI. Settings already documents the fixes.
5. **Stream-json parsing** of `claude -p` output: the session id arrives in
   the init event; capture must not depend on the run finishing.

## Testing (cases, not code — the plan states expected behavior; the
implementer writes the tests)

- **Run-file module** (pure): atomic write then read round-trips; heartbeat
  freshness math at the threshold boundary; lock refused when fresh, granted
  when stale; stage transitions append, never rewrite history fields.
- **Queue/gate** (pure, against fixture items): ungroomed task (empty Plan)
  → `ungroomed`, never dispatched; bug with `Fix: unknown` → same; explicit
  ids preserve given order; `--max 2` stops after two merges with the third
  still `pending`.
- **Server**: `GET /api/orchestrator/runs` returns `{}` with no state dir;
  reflects a fixture run file without caching (edit file, second request
  differs); `POST /api/agents/orchestrate` 409s on a fresh lock, 404s when
  `BM_AGENTS` is off, passes origin guard tests as the existing agents POSTs
  do, and forwards no client prompt field even when one is sent.
- **Client**: strip renders only for fresh runs; attention count matches the
  run file; drawer lists a `needs-answers` item with its question text; a
  card whose id is staged in a fresh run shows that stage's badge and loses
  it when the run goes stale; toolbar shows Orchestrate only when narrowed +
  capable + unlocked.
- **Skill (manual E2E on this repo's own backlog)**: run against tasks 2–6;
  verify a clean item merges silently, a killed session resumes via
  `--resume` with billing intact (`execute-elapsed` accumulated once, not
  twice), and `--abort` leaves no worktrees, no branches, no markers.

## Out of scope, recorded for later

- Answering `needs-answers` items from the drawer (the "Answer inside Runs
  UI" option deliberately deferred).
- Parallel items with cross-merge scheduling.
- Multi-repo runs (one invocation, several projects).
- A `--dry-run` that prints the queue and gate results without spawning.
