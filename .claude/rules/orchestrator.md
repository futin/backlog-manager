---
paths: ["skills/backlog-orchestrate/**", "server/src/orchestrator/**", "shared/agent.ts"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **The orchestrator's run file has exactly one writer, one reader — the same relationship the registry has.**
  `skills/backlog-orchestrate/tools/orchestrate.mjs` is the writer, `server/src/orchestrator/` is the reader, and `run.json` lives outside the repo entirely,
  under `$BM_ORCH_HOME` or `~/.backlog-manager/orchestrator/`. The server re-derives that path with its own copy of the same function, reads it fresh on every
  request, never writes or caches it — `GET /api/orchestrator/archive` and `GET /api/orchestrator/archive/run` included. Why:
  [invariants.md](docs/subsystems/invariants.md#the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has)
- **Remote runs ride beside `runs`, never in it** (task-48). `OrchestratorRunsPayload.remote` is other machines' runs on a tracker project, derived by
  `RemoteRunsService` from the poller's cached claim comments — never from a file, no cache or request of its own. `OrchestratorService.runs()` fills `[]` and
  the controller overwrites it, so the `RUN_IN_PROGRESS_CODE` lock, `runClaimBlock` and the watchdog stay local-only and two machines never block each other.
  A derived run whose `runId` any local run file carries (current or archived, by name through `archivedRunFiles`) is DROPPED, never merged; `project` is this
  machine's registry path; status is the newest `finished` stamp unless ANOTHER claim heartbeated after it, else `running` — a crashed remote run stays
  crashed. A remote row is read-only: no `RunControls`, no `archive/run` fetch. Why:
  [invariants.md](docs/subsystems/invariants.md#remote-runs-ride-beside-runs-never-in-it)
- **A run's sidecars are archived beside its run file, under a name derived from the archive path and stored nowhere.** One `archiveStem` names both
  `runs/<stem>.json` and `runs/<stem>/`; there is no `sidecarDir` field. The mover is a denylist of two (`run.json`, `runs/`), never an allowlist; sidecars move
  first, `run.json` renames last; nothing already present is overwritten; the move never fails an `init`; orphaned sidecars are a non-goal. `archivedRunFiles`
  (`orchestrator.service.ts`) is the ONE implementation of "which entries are run files", read by both `countPastRuns` and `archive()`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-runs-sidecars-are-archived-beside-its-run-file-task-31)
- **`backlog-orchestrate` is the only skill that commits or merges — and, for a TRACKER project only, the only one that pushes.** Inside a per-item worktree,
  on `backlog/<id>` alone; merged into the run's **base branch** (`main` unless `--base` said otherwise), `--no-ff` only, only once the tree holding that base
  is verified to have it actually checked out. No other skill touches git history at all. The push half is task-47's and is exactly three commands, none of
  them ever run for a files project: `pull --ff-only origin <base>` in the base tree before each item's worktree, `push origin <base>` after each merge and
  before `stage <n> merged`, and `push -u origin backlog/<n>` from the item worktree under branch mode. **A rejected or classifier-denied push PARKS, never
  degrades** — the merge has already landed, so `branched` would be false — which is the one exception to the classifier-denial rule. Why:
  [invariants.md](docs/subsystems/invariants.md#backlog-orchestrate-is-the-only-skill-that-commits-or-merges)
- **On a tracker project the DRIVER owns each item's claim, and the execute session never touches the issue** (task-47). The run claims at
  `stage <n> preflight` — before the worktree exists — with `phase: 'execute'` and a `ClaimRun` naming the run; it publishes the queue item as `ClaimState`
  through `heartbeat` from every command that changes one (`stage`, `usage`, `verify`, `assume`, `watch`'s tick); and it releases at a terminal stage
  (`merged`, `branched`, `failed`, `skipped`, `parked`, `ungroomed` — never `needs-answers`), billing `executeElapsed`/`executeTokens` on top of the counters
  it reads first. **`abort` releases too, with the reason `aborted`** (bug-40): a torn-down run passes through no terminal stage, and an unreleased claim is
  not repaired by going stale — the mapper reads `started`/`phase` off any unreleased claim, fresh or stale, so the item's dispatch control stays disabled on
  every machine until a person intervenes. The released set is the one `heartbeat` already uses ("still holds": `claim` set and the stage not one that
  released it), the reason is deliberately NOT a `RunStage`, and the release runs before `finish` stamps `finished` on one of the same claims. **A failed heartbeat or release is one stderr line and never fails the command** — `run.json` is the journal of record and the claim is a
  published copy — while a failed CLOSE is exit `9` with nothing written, because it is the only record anywhere that the item is done. A 409 naming ANOTHER
  run skips the item (exit `0`, `claimed elsewhere`); a resumed driver re-claims its own run's items and the SERVER makes that a takeover, by `run.runId`.
  The dispatched `backlog-execute` session runs none of `start`/`stop`/`heartbeat`/`move`/`comment`: it writes its `## Outcome` to the path the
  `[orchestrator-run … outcome <path>]` marker names, and `orchestrate.mjs snapshot <n>` turns that plus the issue body into the one file the reviewer and
  `verify` read. Inside a run a tracker item's id is its **bare issue number**. Task-48 added three publishes, all best-effort: `finish` stamps
  `finished` on the last-touched claimed item, `attention` posts a `<!-- bm:attention kind=… run=… -->` comment with an `@mention` (its marker and the
  server's `ATTENTION_LINE` agree through a source-reading guard, never an import), and `heartbeat` heartbeats every claim the run still holds. `reconcile`
  reads each item's claim and suggests `skip` for another run's live one; a files run's output is byte-identical. Why:
  [invariants.md](docs/subsystems/invariants.md#the-driver-owns-a-tracker-items-claim-for-the-whole-item)
- **The merge happens in whichever tree holds the base, and the run removes only the tree it made.** git refuses one branch in two trees and `--force` is not
  the way round it, so the merge site is resolved per merge (`git worktree list --porcelain`) into three exhaustive outcomes: a tree holds it → merge there; none
  does → create `.worktrees/_base-<sanitised ref>`, merge, remove at the end of the run; none does and `worktree add` refuses → park. Outcome 3 is detected by
  the create failing, never by the scan, because a worktree **mid-rebase reports `detached`** and so is invisible to it. A base worktree the run did not create
  is never removed — the same sentence as "authority stops at worktrees it created itself". **"The main tree" and "the tree holding `main`" are not synonyms**:
  the `symbolic-ref` precondition and the dirty-path probe both follow the merge into the BASE tree, and so does **every cleanup command that follows a merge**
  (bug-38) — `branch -d` and the runner-fix pickup's `diff HEAD^1 HEAD` are both HEAD-relative and were both reading `main` on a `--base` run. A `branch -d`
  refusal is evidence of a missing merge ONLY from the base tree; from anywhere else it is evidence of a misaimed command, and `git branch --merged <base>`
  settles which. The line is whether a command **depends on** the HEAD of the tree it runs in, NEVER whether it names it — `branch -d` names no HEAD and is
  wholly HEAD-relative, as are `branch --merged`, `branch --contains`, a bare `diff` and a `status`, so a "names HEAD" criterion would reinstate this bug. The
  three shapes that may stay at the project root are HEAD-independent by construction: `show-ref --verify refs/heads/…`, the `worktree` verbs, and a
  `diff`/`log` given an explicit `<base>...backlog/<id>` range. `orchestrate.test.mjs` pins exactly that list as a closed allowlist — a text guard cannot
  decide HEAD-dependence, so it fails closed and a new `git -C "$PWD"` line goes red until someone adds it with its reason. `base` is required on
  `OrchestratorRun`, carried spawn → prompt → `init` → run file, and an older run file's absent `base` is resolved to `'main'` **once**, in
  `sanitizeMergeFields`. Validity is checked twice, same
  order both times (`resolveBase`, `assertUsableBase`): legal ref name first, then `refs/heads/<base>` exists. The ordering is for what the value does NEXT, not
  for the existence check — `refs/heads/<base>` can never start with a `-`, and membership alone refuses every value the name check does; the base is
  substituted for `<base>` in SKILL.md's shell commands, which is where a leading `-` or whitespace would bite. Neither check alone is the rule:
  `check-ref-format --branch` accepts `origin/main`, a SHA and any unknown name. A missing branch is a refusal, never a create. Why:
  [invariants.md](docs/subsystems/invariants.md#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made)
- **Merge mode is run-scoped: chosen per launch, defaulted from Settings, and carried spawn → prompt → `init` → run file.** `MergeMode` (`shared/types.ts`) is
  `merge | branch`, `isMergeMode` its one guard. The sheet sends `mergeMode` on **every** launch; `init` writes `mergeMode`, `mergeModeEffective` (moves `merge`
  → `branch` once, never back) and `mergeModeNote`. **Absent means `merge`; present-but-invalid is a 400, never a clamp.** Why:
  [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **`merged` is no longer the only success exit.** `branched` is its branch-mode sibling and a true exit: out of `RUN_CLAIMED_STAGES`, `ATTENTION_RUN_STAGES`
  and `MACHINE_STAGES`, in `RECONCILE_TERMINAL_STAGES`, counted as completed by `aggregateRuns`; `test/agents-shared.test.ts`'s `Record<RunStage, true>` literal
  forces the classification. A `branched` stamp does not prove the run that wrote it executed the item. Why:
  [invariants.md](docs/subsystems/invariants.md#merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling)
- **The tool refuses `stage <id> merged` under branch mode** — exit `1`, nothing written. The converse is deliberately _not_ enforced: `stage <id> branched` is
  legal under `merge` mode too. Why: [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **Question mode is run-scoped, and it only ever takes effect in a headless run.** `QuestionMode` (`shared/types.ts`) is `decide | park`, `isQuestionMode` its
  one guard; the default `park` appends nothing to the prompt. Absent means `park`; present-but-invalid is a 400, never a clamp; one field, not three.
  `orchestrate.mjs assume <id> --json <file>` is the one writer of `RunQueueItem.assumptions` and is refused under `park` (exit `1`);
  `attention --kind needs-answers` stays legal under `decide`. No fourth `ATTENTION_KIND`. Why:
  [invariants.md](docs/subsystems/invariants.md#question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run)
- **A classifier denial degrades a run to branch mode; every other merge failure still parks.** Denied means the item is staged `branched`, the downgrade is
  recorded once (`merge-mode branch --note`), the queue continues, and there is no attention entry. A conflict, overlapping dirty paths and a main tree not on
  `main` still park. SKILL.md §2's preflight probe is early warning, never a guarantee — the verdict is per call; in a tracker project it takes the tracker
  merge's `-m` shape, and a resumed or unpaused session probes before its first merge. **The merge is its own Bash call, never chained** — a push chained onto
  it turned a would-be park into a degrade (#222). Why:
  [invariants.md](docs/subsystems/invariants.md#a-classifier-denial-degrades-the-run-every-other-merge-failure-parks)
- **Undoing an already-completed orchestrator merge is `git revert -m 1`, never `git reset --hard`** — proved empirically: the reset silently destroyed
  unrelated uncommitted work with no reflog entry to recover it. `git merge --abort` still handles an in-progress conflicted merge. Why:
  [invariants.md](docs/subsystems/invariants.md#undoing-an-already-completed-orchestrator-merge-is-git-revert--m-1-never-git-reset---hard)
- **`orchestrate.mjs` is always invoked from the project root, never from inside a per-item worktree.** Every command but `init` walks up from its cwd and
  **refuses** a linked worktree (exit `1`, naming the worktree and the project root); `init` runs the same refusal over `--project`. The discriminator is a
  `commondir` entry in the `gitdir:` target, not "`.git` is a file". Worktree-scoped flags (`stage --worktree`/`--branch`, `verify --cwd`) are exempt. Why:
  [invariants.md](docs/subsystems/invariants.md#orchestratemjs-is-always-invoked-from-the-project-root-never-from-inside-a-per-item-worktree)
- **A `runner-fix:` item is hoisted to the front of the queue, and the marker is read at `<base>`.** A human's judgement written during grooming, never a path
  heuristic; presence hoists, only `false` opts out; `parseItemForGate` reads it; the partition is stable, outranks bugs-then-tasks and runs before `--max`;
  `--ids` is hoisted too, a hand order included. SKILL.md §9: after a merged runner fix, follow the repo's SKILL.md **and** `orchestrate.mjs` — both or neither.
  Inert for the _next_ run until push + `pnpm run plugin:sync`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-runner-fix-item-is-hoisted-to-the-front-of-the-queue-and-the-marker-is-read-at-base)
- **A pause request lives in a server-owned file the tool reads at its two dispatch gates; `paused` is a fifth run status and `unpause` its only exit.**
  `POST /api/agents/pause` — origin-guarded, independent of `BM_AGENTS` — writes
  `~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json`, the one file travelling server → tool; `run.json` keeps its single
  writer. Effectiveness is derived on both sides, never stored. `orchestrate.mjs` refuses `stage <id> preflight`/`dispatched` with exit `6`, only on a
  transition; `heartbeat` never touches a status; the watchdog needs no change; `init` archives a paused run like a done one. Resume for `paused` is on both
  surfaces (`RunControls`, `resumeGate`); Resume for a crashed run is behind `watchdogStoodDown` wherever it is drawn — its surface, the board's crashed strip,
  left with task-37 and landed in task-38 on `RunControls`, drawn in the Runs detail sheet's head and in the Watchdog page's Watching rows. Why:
  [invariants.md](docs/subsystems/invariants.md#a-pause-request-is-a-file-the-server-writes-and-the-tool-reads)
- **A stop is the control file's SECOND `kind`, and nothing resumes a stopped run** (bug-39). `PauseRequest.kind` is `'pause' | 'stop'` and **absent means
  `'pause'`**; one control fact per project stays one file (a stop overwrites a pause and back, pause's `cancel` deletes either); the two predicates are DISJOINT on
  both sides, `stopRequestEffective` being the pause predicate's two clauses plus `kind === 'stop'`. `POST /api/agents/stop` is `pause`'s sibling — guarded,
  `cancel: true` refused 409 before the run lookup (bug-53: a stop cannot be withdrawn), independent of `BM_AGENTS`, `running` fresh **or stale** — and then attempts ONE `/backlog-orchestrate --abort` spawn: recording the
  fact and ending the run are two outcomes and only the first is guaranteed, so a gate refusal is a 200 carrying `abortRefused`, never an error. The spawn is
  unconditional, because a live driver is evicted by the abort session's own `takeOverRun` write — and the second `--abort` that a live driver's own `watch`
  exit `10` produces is refused by the TOOL, not the route (bug-54): `abort` writes `driver.aborting` (equal to `at`) on the lease it takes, and another
  identified session's abort exits `7` on a mark fresher than `RUN_STALE_MS`, before any write, signal or git; on an already-`aborted` run it is a one-line
  no-op `0`. The stop's `force` never overrides an abort's lease; the same session, `me === null` and a stale mark are exempt. `stopRequested` rides the runs payload beside
  `pauseRequested`, derived from the SAME control-file read, and **both the sweeper and `RunControls` read that one field** — it is deliberately NOT a third
  input to `watchdogStoodDown`, whose being TRUE is what makes the board OFFER a Resume, so the coupling's biconditional narrows to an implication in the safe
  direction. In the tool: `stage` refuses EVERY transition with exit `10` (wider than the pause gate in both dimensions — a stop may abandon a worktree, which
  `abort`'s marker-preservation rule keeps safe), `watch` kills the child **by the pid it was given**, persists a session id that same tick just read out of
  the jsonl — its own write, `updatedAt` deliberately untouched, because the early return exists to protect freshness and a session id is not one (bug-50) —
  and returns `10`, and `takeOverRun(dir, run, force, aborting)` has REQUIRED third and fourth parameters — `cmdAbort` passes the stop's verdict and `true`,
  `cmdClaim` passes `false` twice, so a resume can still never steal a live run and never writes an abort mark.
  `RunQueueItem.pid` is written by `stage <id> dispatched --pid <p>` and signalled by `cmdAbort` only behind three guards (non-terminal, `pidAlive`, and
  `ps -o args=` naming a `claude` process) — and since bug-43 that field is the SECOND pid source, because the stop gate refuses the very call that writes
  it: `resolveItemPid` reads `<dir>/logs/<id>.pid` first (written by SKILL.md's launcher before the refusal, garbage in it falling through rather than
  throwing), falls back to the field, and writes back only a pid it actually signalled. The session id gets the same second source the other way round
  (bug-52): `resolveItemSessionId` keeps any recorded `sessionId` and only fills an empty one from `<dir>/logs/<id>.jsonl`, over the whole queue, a bad file
  reading as no answer. The gate was not narrowed instead. No sixth `RunStatus`, no `--force`
  flag, no server-side kill. Why:
  [invariants.md](docs/subsystems/invariants.md#a-stop-is-the-control-files-second-kind-and-nothing-resumes-a-stopped-run)
- **A session's cost is recorded per transcript, and a transcript's identity is its file name, not its session id** (task-27).
  `orchestrate.mjs usage <id> --jsonl <file>` is the one writer of `RunQueueItem.usage`: one entry per transcript, never one summed figure; identity is `kind` +
  `loop`, both from the file name, never `sessionId`. Absence is a value: no result event writes no entry, a renamed numeric field reads `null` never `0`, and
  `usage` stays optional so an older run renders nothing rather than `$0.00`. Why:
  [invariants.md](docs/subsystems/invariants.md#a-sessions-cost-is-recorded-per-transcript-and-a-transcripts-identity-is-its-file-name)
- **`orchestrator:queued` is a plan, never a claim: the driver adds it, the claim and the Stop remove it, and no reader treats it as exclusion.** Adds:
  `orchestrate.mjs init` on a tracker project, to every queue item as built (already cut to `--max`), through `POST /api/items/queue` — the driver's only way to
  the label. Removes: `GithubSource.claim` on a WON claim, in the same step that adds `in-progress` (a lost claim removes nothing); the driver on a skip (an item
  reaching a release stage it never claimed); `finish` and `cmdAbort`, over `unclaimedQueueItems`; and `AgentsService.stop`, which sweeps the run file's
  never-claimed items through the item writer BEFORE the abort spawns, reports what it could not clear in `StopResult.unqueueFailed`, and never fails the stop.
  A pause removes nothing. Every driver write goes through `trackerQueueLabel`, which never throws and never moves an exit code: one stderr line per refused
  item, ONE line for the whole batch when the API is down. No gate, queue builder, preflight or claim reads the label; the mapper sets `BacklogItem.queued` and
  only the card reads it, as `queuedReading`'s `'live' | 'stale' | null`. A `files` project makes no label call on any path. Why:
  [invariants.md](docs/subsystems/invariants.md#orchestratorqueued-is-a-plan-never-a-claim)
