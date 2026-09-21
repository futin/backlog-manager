# Phase 4 orchestrator on a tracker project — live verification

**2026-09-21.** First real orchestrator run on a tracker project, end to end, against `futin/test-claude-issues`, from `main` at `cb02cc2` with the
installed plugin in sync at the same commit. Companion to [2026-09-17-tracker-backed-backlog-design.md](2026-09-17-tracker-backed-backlog-design.md) §7,
[task-47](../../../backlog/tasks/done/task-47-tracker-backed-phase-4a-orchestrate-a-tracker-project-from-one-machine-gate-via-the-api-the-driver-s-claim-as-machine-state-push-and-pull-close-on-merged.md)
and
[task-48](../../../backlog/tasks/done/task-48-tracker-backed-phase-4b-runs-visible-from-every-machine-runs-derived-from-claim-comments-read-only-remote-runs-attention-comments-reconcile-from-claims.md),
and the successor of [the phase-3 verification](2026-09-19-tracker-phase3-write-back-verification.md). As there, every line below is a claim checked
against a live artifact — a GitHub issue or comment, `origin/main`, the board's payload, a run file or a session transcript — never asserted from code.

## Why this run was needed

The 2026-09-20 "two-machine check" recorded in task-48's outcome and in bug-40/bug-41 exercised the **claim protocol by hand**: `orchestrate.mjs` stages
driven from a terminal under fake session ids (`bbbbbbbb-0000-4000-8000-machineb00001`), worktrees under `/tmp/ma` and `/tmp/mb`, and issue #2's Outcome
comment saying "No code was executed". No headless execute session, no reviewer, no verify, no merge and no push had ever run on a tracker project — the
test repo's `origin/main` was still the `connect` commit `ff4da67`. Phase 5 moves real projects onto this path, so the path had to be walked once for real.

## Setup

- **Repo:** `futin/test-claude-issues` (throwaway, public), registered and connected on 2026-09-19; marker `{"kind":"github","repo":"futin/test-claude-issues"}`.
- **Stack:** the docker-compose stack, up 38 h, `BM_GITHUB_TOKEN` in the container env (`GET /api/trackers` → `hasToken: true`, login `futin`,
  4,972 of 5,000 remaining). Dashboard reachable, `spawnMaxPermission: auto`, the test repo in its `projectPaths`.
- **Plugin:** `pnpm run plugin:sync` status "in sync — installed v0.1.1 is cb02cc2", so bug-40's and bug-41's fixes were the installed code.
- **Trigger:** `POST /api/agents/orchestrate` on the API, the same route the board's sheet calls, with `ids`, `mergeMode: merge`, `questionMode: park`,
  `base: main`, `permissionMode: auto`. Never the trigger typed into a terminal — that is the path with no `starting` entry and no watchdog.

## Test 1 — the whole loop, merge mode (issue #5)

Issue #5 filed with `gh issue create`, label `type:task`, body `## Plan` (append one line to `README.md`) and a fenced `## Done when` command
(`grep -q "Phase 4 live check" README.md`). Run `run-20260921-090703`, driver session `9b416b31`, board request at 09:06:17, `finished` stamped 09:13:32.

Observed in order, each from a different artifact:

| Step | Evidence |
|---|---|
| `starting` entry before any run file | `GET /api/orchestrator/runs` → `starting: [{ requestedAt: 09:06:17 }]`, `runs` empty for the project |
| `init` | run file appears, queue `[5: pending]`, `driver.sessionId` = the spawned session's id |
| `stage 5 preflight` claims the issue | comment `5758026501` `<!-- bm:claim -->`, `session: 9b416b31…`, `run.runId: run-20260921-090703`, `stage: preflight`; issue gains `in-progress` and assignee `futin` |
| Pull, worktree, dispatch | driver ran `git pull --ff-only origin main` then `worktree add .worktrees/5 -b backlog/5 main`; `claude -p "/backlog-execute 5 [orchestrator-run … outcome <dir>/outcomes/5.md …]"` under `nohup`, pid written to `logs/5.pid`, then `stage 5 dispatched --pid`; run file carried `pid: 28223` and the child's session id |
| Execute writes the outcome to the marker path | `<dir>/outcomes/5.md` filled with `## Outcome`, the diff and the Done-when check; worktree had `M README.md`, uncommitted, no local commit by the session |
| Inspect → review → verify | stages `inspecting`, `reviewing` (reviewer `verdict: approve`, report `reviews/5-1.md`, `fixLoops: 0`), `verifying` (`grep -q …` → `ok: true`) |
| Merge with `Fixes #5`, push, close | `origin/main` moved `ff4da67` → `fd62ac8`, a `--no-ff` merge whose body is `Fixes #5`; issue **closed, `state_reason: completed`**, a separate `## Outcome` comment `5758096411`; `in-progress` removed, `type:task` kept, assignee kept |
| Claim released and finished | claim comment edited: `released: { reason: 'merged', by: 9b416b31… }`, `finished: { status: 'done' }`, counters `executeElapsed: 57`, `executeTokens: 36644` |
| Cleanup | `.worktrees/5` gone, `backlog/5` gone locally and never pushed (merge mode), main tree on `fd62ac8` |
| Board | `/api/items` → `#5 done`, `started: ''`, `executeElapsed 57`, `executeTokens 36644`; `/api/orchestrator/runs` lists the run under `runs` and **not** under `remote` — the own-run drop rule held |
| Usage | `queue[0].usage`: one `execute` entry, `claude-opus-5`, 7 turns, `costUsd 0.544`, 57 s |

**The gate said `needs-answers`, and the driver dispatched anyway — correctly.** `plan --ids 5 --json` returned `gate: needs-answers` with one question,
`## Done when references \`grep -q …\` — is that command actually runnable (not found in verify.json or package.json)?`. The repo has no `package.json`
and no `backlog/verify.json`, so `findUnresolvedCommands` flags every fenced command. SKILL.md's pre-flight says the gate's questions are "a starting point,
not the whole hunt — you are reading the item", and the driver's transcript records the judgement: "`grep` is a standard binary and §8 unions fenced
`## Done when` commands, so it is runnable and verifiable. No real unknowns in the item → proceed." No `AskUserQuestion` call, no `stage needs-answers`.
Within the skill's latitude. Worth knowing for phase 5: **a project without `package.json` or `verify.json` will read `needs-answers` for every item with a
fenced Done-when command**, and whether a run proceeds is then the driver's judgement per item.

## Test 2 — bug-41, a fresh issue inside the poll window (issue #6)

Issue #6 created with `gh issue create` at 09:14:31; `orchestrate.mjs plan --project <root> --ids 6` from the project root at 09:14:3x, and the
whole-queue `plan` immediately after, both well inside `TRACKER_POLL_MS`:

- `--ids 6` resolved the id on the first try (bug-41's one re-read timed off `polledAt`, or a tick that landed in between — the two are indistinguishable
  from outside, and either is the fixed behaviour; the pre-fix output was `unknown item id`).
- The whole-queue `plan` printed the bug-41 line: `queue built from the tracker cache (polled 2 s ago) — an issue filed since that poll is not in it yet`.

## Test 3 — bug-39's force stop and bug-40's release (issue #6)

#6's body was edited to a prose-only `## Done when` (the poller picked the edit up on its next tick; `plan` then read `ready`). Run `run-20260921-091645`,
driver `7e91416e`, started 09:16:09. At `dispatched` (09:18:30), `POST /api/agents/stop { project }` → `200 { stopRequested: true, abortSession: 5d01897e…,
abortRefused: null }`; control file written with `kind: 'stop'`; `stopRequested: true` on the runs payload one tick later.

What then happened, from the two transcripts:

1. **Driver `7e91416e`**, 09:18:44: its second `stage 6 dispatched --pid …` call was **refused, exit `10`**: `a stop was requested for this run — 6 is not
   being staged 'dispatched'. Nothing was written. End the run with --abort`. It read `references/recovery.md`, killed the child **by the pid file**
   (`kill -TERM $(cat logs/6.pid)`, 09:19:15), ran `abort` (09:19:26) → `abort: signalled 0 live session(s); removed 1 item(s) (6)`, and the claim was
   released `{ reason: 'aborted', by: 7e91416e… }` with `finished: { status: 'aborted' }`.
2. **Abort session `5d01897e`**, spawned by the stop, ran `abort` FIRST (09:19:10) and its release was **refused**:
   `release of 6 was refused: #6 is held by session 7e91416e-…`. It still removed the worktree and wrote `status: aborted` (09:19:14). Its later
   `backlog.mjs stop 6 --abandon` answered `#6 is not in progress`, because by then the driver's own abort had released the claim.

End state: issue #6 open, `in-progress` removed, assignee `futin` (left alone by design — the release code says so), claim released `aborted`; board
`#6 open, started: '', phase: ''`; `.worktrees/6` and `backlog/6` gone; child pid `35548` gone; control file still present but keyed by `runId`, so it
cannot touch the next run (`controlRequestTimely` compares `control.runId` to `run.runId`).

**bug-40's fix is proved only for the driver's own `abort`.** Two defects fall out of step 2, and the first is a real one:

- **A release from any session but the holder is refused while the claim is live.** `GithubSource.release` allows "the holder always; ANYONE once the
  claim is dead", and the spawned abort session is neither: it takes the run's driver lease through `takeOverRun`, but the claim's `session` is the
  original driver's and its heartbeat is fresh. So the board's force stop — built for a driver that is dead or hung — **cannot release that driver's
  claims**, and neither can a hand `/backlog-orchestrate --abort` from a new session. The claim goes stale after `CLAIM_STALE_MS` but stays unreleased,
  and the mapper reads `started` off any unreleased claim, fresh or stale: bug-40's symptom, on every machine, for exactly the case bug-39 was built
  for. It did not bite here only because the live driver ran `abort` itself 10 s later. The fix direction is the one `claim` already has: a session
  holding the run's lease with a matching `run.runId` is a takeover, and release should accept it.
- **The stop landed between the two `stage dispatched` calls, so `pid` never reached the run file** — `abort` "signalled 0 live session(s)" in both
  sessions. The live driver killed the child from `logs/<id>.pid`; a dead driver would have left an orphaned `claude -p` running. A few-second window,
  narrower than the first defect, but the same dead-driver case.

## What this proves

The phase-4 loop works unmodified from `main`: **board request → `starting` → `init` → claim at preflight → pull → worktree → headless execute writing
to the marker path → inspect → review → verify → `--no-ff` merge with `Fixes #n` → `push origin main` → close with the Outcome comment → release
`merged` → `finished` → cleanup**, with the board, the issue, the claim comment, the run file and `origin/main` all agreeing at the end. bug-41's
re-read and the cache-age line are live. bug-39's stop reaches the tool (`exit 10`), kills the child and ends the run.

Not proved here: branch mode's `push -u origin backlog/<n>`; a push rejection parking the item; a resume or takeover after a crash; a second real
machine (remote runs have only ever been derived from this machine's own simulated claims).

## Cost

| Run | Execute session | Wall clock |
|---|---|---|
| `run-20260921-090703` (#5, merged) | 1 session, opus, 7 turns, $0.54, 57 s | 7 min 15 s from request to `finished` |
| `run-20260921-091645` (#6, stopped) | killed mid-turn, no `result` event, no usage entry | 3 min 27 s |

## Next

Phase 5 (`backlog.mjs import`, spec §8) is not built; `connect` names it as such. Before the first real project moves: fix the non-holder release
above, decide the three import questions the spec leaves open (public repos publish every body; imported items carry no claim so every counter reads `0`
because nothing reads the `bm:imported` footer; issue numbers will not equal file ids because PRs consumed numbers), and turn `pnpm test` green — three
fixture date-bombs from task-48's outcome are still red.
